"use server";

import { revalidatePath } from "next/cache";
import { getPrisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/permissions";
import { canAccessFarmaciaSync } from "@/lib/permissions-core";
import { resolveCurrentTenantSlug } from "@/lib/tenant-context";
import { LEGACY_TENANT } from "@/lib/auth";
import { finalizeAndQueueOrder, createEncomendaWithOutbox } from "@/lib/ingest/orders";
import {
  salvarAutosaveEncomenda,
  ConflitoVersaoError,
  RascunhoNaoEditavelError,
  type LinhaAutosavePatch,
} from "@/lib/encomendas/autosave";
import { logAudit } from "@/lib/audit";
import { retryOutboxRow, cancelOutboxRow } from "@/lib/integracao/outbox-admin";

const AUTOSAVE_MAX_LINHAS = 1000;

type ActionResult = { ok: true } | { ok: false; error: string };

async function assertDraft(prisma: Awaited<ReturnType<typeof getPrisma>>, listaId: string) {
  const lista = await prisma.listaEncomenda.findUnique({
    where: { id: listaId },
    select: { id: true, estado: true },
  });
  if (!lista) throw new Error("Encomenda não encontrada.");
  if (lista.estado !== "RASCUNHO") {
    throw new Error("Esta encomenda já não é editável (não é rascunho).");
  }
  return lista;
}

function revalidateDetail(listaId: string) {
  revalidatePath(`/encomendas/${listaId}`);
  revalidatePath("/encomendas");
}

/**
 * Edita uma linha de uma lista em RASCUNHO. Aceita patch parcial —
 * só os campos passados são alterados. Bloqueia se a lista já estiver
 * finalizada (o payload do outbox é imutável).
 */
export async function updateLineAction(input: {
  listaEncomendaId: string;
  linhaId: string;
  quantidadeAjustada?: number | null;
  notas?: string | null;
}): Promise<ActionResult> {
  const session = await requirePermission("reports.write");
  const prisma = await getPrisma();

  try {
    await assertDraft(prisma, input.listaEncomendaId);

    const linha = await prisma.linhaEncomenda.findUnique({
      where: { id: input.linhaId },
      select: { id: true, listaEncomendaId: true },
    });
    if (!linha || linha.listaEncomendaId !== input.listaEncomendaId) {
      return { ok: false, error: "Linha não pertence a esta encomenda." };
    }

    const data: {
      quantidadeAjustada?: number | null;
      notas?: string | null;
    } = {};
    if (input.quantidadeAjustada !== undefined) {
      if (input.quantidadeAjustada !== null && !Number.isFinite(input.quantidadeAjustada)) {
        return { ok: false, error: "Quantidade inválida." };
      }
      data.quantidadeAjustada =
        input.quantidadeAjustada === null
          ? null
          : Math.max(0, input.quantidadeAjustada);
    }
    if (input.notas !== undefined) {
      data.notas = input.notas?.trim() ? input.notas.trim() : null;
    }

    if (Object.keys(data).length === 0) return { ok: true };

    await prisma.linhaEncomenda.update({
      where: { id: input.linhaId },
      data,
    });
    await prisma.listaEncomenda.update({
      where: { id: input.listaEncomendaId },
      data: { dataAtualizacao: new Date() },
    });

    await logAudit({
      actorId: session.sub,
      action: "order.line_updated",
      entity: "LinhaEncomenda",
      entityId: input.linhaId,
      meta: data,
    });
    revalidateDetail(input.listaEncomendaId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido" };
  }
}

export async function removeLineAction(input: {
  listaEncomendaId: string;
  linhaId: string;
}): Promise<ActionResult> {
  const session = await requirePermission("reports.write");
  const prisma = await getPrisma();

  try {
    await assertDraft(prisma, input.listaEncomendaId);

    const linha = await prisma.linhaEncomenda.findUnique({
      where: { id: input.linhaId },
      select: { id: true, listaEncomendaId: true, produtoId: true },
    });
    if (!linha || linha.listaEncomendaId !== input.listaEncomendaId) {
      return { ok: false, error: "Linha não pertence a esta encomenda." };
    }

    await prisma.linhaEncomenda.delete({ where: { id: input.linhaId } });
    await prisma.listaEncomenda.update({
      where: { id: input.listaEncomendaId },
      data: { dataAtualizacao: new Date() },
    });

    await logAudit({
      actorId: session.sub,
      action: "order.line_removed",
      entity: "LinhaEncomenda",
      entityId: input.linhaId,
      meta: { produtoId: linha.produtoId },
    });
    revalidateDetail(input.listaEncomendaId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido" };
  }
}

/**
 * Adiciona um produto manual à lista (excepção, fora da proposta).
 * Falha se já existir uma linha para o mesmo produto (regra de unique
 * (listaEncomendaId, produtoId) na BD).
 */
export async function addManualLineAction(input: {
  listaEncomendaId: string;
  produtoId: string;
  quantidadeAjustada: number;
  notas?: string | null;
}): Promise<ActionResult> {
  const session = await requirePermission("reports.write");
  const prisma = await getPrisma();

  try {
    await assertDraft(prisma, input.listaEncomendaId);

    if (!Number.isFinite(input.quantidadeAjustada) || input.quantidadeAjustada <= 0) {
      return { ok: false, error: "Quantidade tem de ser > 0." };
    }

    const exists = await prisma.linhaEncomenda.findUnique({
      where: {
        listaEncomendaId_produtoId: {
          listaEncomendaId: input.listaEncomendaId,
          produtoId: input.produtoId,
        },
      },
      select: { id: true },
    });
    if (exists) {
      return {
        ok: false,
        error: "Este produto já está na encomenda — edite a quantidade da linha existente.",
      };
    }

    await prisma.linhaEncomenda.create({
      data: {
        listaEncomendaId: input.listaEncomendaId,
        produtoId: input.produtoId,
        // Sem quantidade sugerida: nao houve calculo nenhum. Deixa-la a
        // null e' o que torna a linha legivel — `quantidadeAjustada`
        // sozinha diz "alguem escolheu este numero".
        quantidadeSugerida: null,
        quantidadeAjustada: input.quantidadeAjustada,
        notas: input.notas?.trim() ? input.notas.trim() : null,
        // A marca que faz esta linha sobreviver a um recalculo futuro.
        origem: "MANUAL",
      },
    });
    await prisma.listaEncomenda.update({
      where: { id: input.listaEncomendaId },
      data: { dataAtualizacao: new Date() },
    });

    await logAudit({
      actorId: session.sub,
      action: "order.manual_line_added",
      entity: "ListaEncomenda",
      entityId: input.listaEncomendaId,
      meta: { produtoId: input.produtoId, quantidade: input.quantidadeAjustada },
    });
    revalidateDetail(input.listaEncomendaId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido" };
  }
}

/**
 * Retry manual de uma encomenda em FALHADO — reset de tentativas,
 * volta a PENDENTE para o agent recolher no próximo ciclo.
 * Requer settings.global (ADMINISTRADOR ou GESTOR_GRUPO).
 */
export async function retryOutboxAction(outboxId: string): Promise<ActionResult> {
  const session = await requirePermission("settings.global");
  const prisma = await getPrisma();

  try {
    const result = await retryOutboxRow(prisma, outboxId, session.sub);
    if (!result.ok) return { ok: false, error: result.error };

    await logAudit({
      actorId: session.sub,
      action: "outbox.manual_retry",
      entity: "OrderOutbox",
      entityId: outboxId,
    });
    revalidatePath("/encomendas");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido" };
  }
}

/**
 * Cancelamento manual do outbox a partir de PENDENTE ou FALHADO.
 * A encomenda fica CANCELADA — o agent não a tentará exportar novamente.
 * Requer settings.global (ADMINISTRADOR ou GESTOR_GRUPO).
 */
export async function cancelOutboxAction(outboxId: string): Promise<ActionResult> {
  const session = await requirePermission("settings.global");
  const prisma = await getPrisma();

  try {
    const result = await cancelOutboxRow(prisma, outboxId, session.sub, null);
    if (!result.ok) return { ok: false, error: result.error };

    await logAudit({
      actorId: session.sub,
      action: "outbox.manual_cancel",
      entity: "OrderOutbox",
      entityId: outboxId,
    });
    revalidatePath("/encomendas");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido" };
  }
}

/**
 * Finaliza um rascunho a partir do detalhe — mesmo invariante que
 * o caminho da lista: passa por `finalizeAndQueueOrder`, que cria o
 * outbox em transação na primeira chamada e é idempotente em replays.
 *
 * `versaoEsperada`, quando fornecida (o ecrã de detalhe fornece sempre),
 * força a validação de versão ANTES de finalizar — "força a gravação
 * das alterações pendentes; valida a versão" (o cliente chama o
 * autosave para gravar o que estiver pendente e só DEPOIS chama esta
 * acção com a versão que recebeu de volta).
 */
export async function finalizeFromDetailAction(
  listaEncomendaId: string,
  versaoEsperada?: number
): Promise<{ ok: true; outboxId: string } | { ok: false; error: string; conflito?: true; versaoAtual?: number }> {
  const session = await requirePermission("reports.write");
  const prisma = await getPrisma();
  const tenantSlug = (await resolveCurrentTenantSlug()) ?? LEGACY_TENANT;

  try {
    const result = await finalizeAndQueueOrder(prisma, tenantSlug, listaEncomendaId, versaoEsperada);
    await logAudit({
      actorId: session.sub,
      action: "order.finalized_from_detail",
      entity: "ListaEncomenda",
      entityId: listaEncomendaId,
      meta: { outboxId: result.outboxId },
    });
    revalidateDetail(listaEncomendaId);
    revalidatePath("/configuracoes/integracao");
    return { ok: true, outboxId: result.outboxId };
  } catch (err) {
    if (err instanceof ConflitoVersaoError) {
      return { ok: false, error: err.message, conflito: true, versaoAtual: err.versaoAtual };
    }
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido" };
  }
}

/**
 * Cancela um rascunho — muda o estado para ELIMINADA (soft-delete, nunca
 * apaga o registo nem a auditoria). Pede confirmação explícita no
 * cliente antes de chamar; aqui só valida e regista.
 */
export async function cancelDraftAction(
  listaEncomendaId: string
): Promise<ActionResult> {
  const session = await requirePermission("reports.write");
  const prisma = await getPrisma();

  try {
    const lista = await assertDraft(prisma, listaEncomendaId);
    await prisma.listaEncomenda.update({
      where: { id: lista.id },
      data: { estado: "ELIMINADA" },
    });
    await logAudit({
      actorId: session.sub,
      action: "order.draft_cancelled",
      entity: "ListaEncomenda",
      entityId: listaEncomendaId,
    });
    revalidateDetail(listaEncomendaId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido" };
  }
}

export type AutosaveLinhaInput = {
  produtoId: string;
  quantidadeSugerida?: number | null;
  quantidadeAjustada?: number | null;
  fornecedorSugeridoId?: string | null;
  notas?: string | null;
  origem?: "PROPOSTA" | "MANUAL" | "SUGESTAO";
};

export type AutosaveResult =
  | { ok: true; versao: number; gravadas: number; removidas: number }
  | { ok: false; error: string; conflito?: true; versaoAtual?: number };

/** Tecto do JSON de contexto (filtros/critérios da proposta) — generoso, mas nunca ilimitado. */
const CONTEXTO_MAX_CHARS = 20_000;

/**
 * Autosave em lote — chamado pelo hook de cliente (debounce 800-1500ms,
 * serializado: nunca duas chamadas em voo ao mesmo tempo). Grava só as
 * linhas SUJAS que o cliente enviar, nunca o documento inteiro.
 *
 * Validação manual (mesma convenção do resto deste ficheiro — sem Zod
 * no projecto): tipo/forma de cada campo, tecto de linhas por chamada,
 * farmácia autorizada.
 *
 * `linhasRemovidasProdutoIds` (produtoIds a apagar) e `contexto` (JSON
 * já serializado da proposta — modo/período/filtros; `undefined` não
 * toca no que já está gravado) são ambos opcionais e piggybackam no
 * mesmo autosave, nunca um segundo motor.
 */
export async function autosaveEncomendaAction(input: {
  listaEncomendaId: string;
  farmaciaId: string;
  versaoEsperada: number;
  linhas: AutosaveLinhaInput[];
  linhasRemovidasProdutoIds?: string[];
  contexto?: string | null;
}): Promise<AutosaveResult> {
  const session = await requirePermission("reports.write");

  if (!canAccessFarmaciaSync(session, input.farmaciaId)) {
    return { ok: false, error: "Sem acesso a esta farmácia." };
  }
  if (!Number.isInteger(input.versaoEsperada) || input.versaoEsperada < 0) {
    return { ok: false, error: "Versão inválida." };
  }
  if (!Array.isArray(input.linhas)) {
    return { ok: false, error: "Formato de linhas inválido." };
  }
  const remocoes = Array.isArray(input.linhasRemovidasProdutoIds) ? input.linhasRemovidasProdutoIds : [];
  if (input.linhas.length === 0 && remocoes.length === 0 && input.contexto === undefined) {
    return { ok: false, error: "Nada para gravar." };
  }
  if (input.linhas.length > AUTOSAVE_MAX_LINHAS || remocoes.length > AUTOSAVE_MAX_LINHAS) {
    return { ok: false, error: `Demasiadas linhas num único autosave (máx. ${AUTOSAVE_MAX_LINHAS}).` };
  }
  if (input.contexto !== undefined && input.contexto !== null && input.contexto.length > CONTEXTO_MAX_CHARS) {
    return { ok: false, error: "Contexto da proposta excede o tamanho máximo." };
  }
  for (const produtoId of remocoes) {
    if (typeof produtoId !== "string" || produtoId.length === 0) {
      return { ok: false, error: "produtoId inválido numa remoção." };
    }
  }

  const linhas: LinhaAutosavePatch[] = [];
  for (const l of input.linhas) {
    if (typeof l.produtoId !== "string" || l.produtoId.length === 0) {
      return { ok: false, error: "produtoId em falta numa linha." };
    }
    if (l.quantidadeAjustada != null && !Number.isFinite(l.quantidadeAjustada)) {
      return { ok: false, error: "Quantidade inválida." };
    }
    if (l.quantidadeSugerida != null && !Number.isFinite(l.quantidadeSugerida)) {
      return { ok: false, error: "Quantidade sugerida inválida." };
    }
    if (l.origem !== undefined && l.origem !== "PROPOSTA" && l.origem !== "MANUAL" && l.origem !== "SUGESTAO") {
      return { ok: false, error: "Origem de linha inválida." };
    }
    linhas.push({
      produtoId: l.produtoId,
      quantidadeSugerida: l.quantidadeSugerida !== undefined ? (l.quantidadeSugerida === null ? null : Math.max(0, l.quantidadeSugerida)) : undefined,
      quantidadeAjustada: l.quantidadeAjustada !== undefined ? (l.quantidadeAjustada === null ? null : Math.max(0, l.quantidadeAjustada)) : undefined,
      fornecedorSugeridoId: l.fornecedorSugeridoId,
      notas: l.notas !== undefined ? (l.notas?.trim() ? l.notas.trim() : null) : undefined,
      origem: l.origem,
    });
  }

  const prisma = await getPrisma();
  try {
    const resultado = await salvarAutosaveEncomenda(prisma, {
      listaEncomendaId: input.listaEncomendaId,
      versaoEsperada: input.versaoEsperada,
      linhas,
      linhasRemovidasProdutoIds: remocoes,
      contexto: input.contexto,
    });
    // Um único registo de auditoria por chamada de autosave (não por
    // linha) — dezenas de PATCHes por minuto não devem inundar AuditLog;
    // a lista de produtoIds alterados fica no `meta` para quem investigar.
    await logAudit({
      actorId: session.sub,
      action: "order.autosave",
      entity: "ListaEncomenda",
      entityId: input.listaEncomendaId,
      meta: {
        produtoIds: linhas.map((l) => l.produtoId),
        produtoIdsRemovidos: remocoes,
        contextoAlterado: input.contexto !== undefined,
        versaoNova: resultado.versao,
      },
    });
    // SEM `revalidatePath`: as páginas de encomendas são `force-dynamic` (nada em
    // cache a invalidar) e uma revalidação dentro de uma Server Action faz o
    // Next re-renderizar a rota actual e REPOR a URL de antes da acção — medido
    // no browser: `?rascunho=<id>` desaparecia depois do primeiro autosave.
    return { ok: true, versao: resultado.versao, gravadas: resultado.gravadas, removidas: resultado.removidas };
  } catch (err) {
    if (err instanceof ConflitoVersaoError) {
      return { ok: false, error: err.message, conflito: true, versaoAtual: err.versaoAtual };
    }
    if (err instanceof RascunhoNaoEditavelError) {
      return { ok: false, error: err.message };
    }
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido" };
  }
}

/**
 * "Criar cópia" — a saída de um conflito de versão que não descarta o
 * trabalho local do utilizador. Cria um NOVO rascunho independente com
 * o estado local (o que estava no ecrã, não o que está no servidor),
 * para o utilizador decidir depois o que fazer com os dois. Nunca
 * sobrescreve o rascunho original.
 */
export async function duplicarRascunhoComoNovoAction(input: {
  farmaciaId: string;
  nomeOriginal: string;
  linhas: Array<{
    produtoId: string;
    quantidadeSugerida?: number | null;
    quantidadeAjustada?: number | null;
    fornecedorSugeridoId?: string | null;
    notas?: string | null;
    origem?: "PROPOSTA" | "MANUAL" | "SUGESTAO";
  }>;
}): Promise<{ ok: true; novoId: string } | { ok: false; error: string }> {
  const session = await requirePermission("reports.write");
  if (!canAccessFarmaciaSync(session, input.farmaciaId)) {
    return { ok: false, error: "Sem acesso a esta farmácia." };
  }
  if (input.linhas.length === 0) {
    return { ok: false, error: "Nada para copiar." };
  }

  const prisma = await getPrisma();
  const tenantSlug = (await resolveCurrentTenantSlug()) ?? LEGACY_TENANT;
  try {
    const criada = await createEncomendaWithOutbox(prisma, tenantSlug, {
      farmaciaId: input.farmaciaId,
      criadoPorId: session.sub,
      nome: `${input.nomeOriginal} (cópia)`,
      finalize: false,
      linhas: input.linhas,
    });
    await logAudit({
      actorId: session.sub,
      action: "order.draft_copied_after_conflict",
      entity: "ListaEncomenda",
      entityId: criada.listaEncomendaId,
    });
    revalidatePath("/encomendas");
    return { ok: true, novoId: criada.listaEncomendaId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido" };
  }
}
