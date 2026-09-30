"use server";

import { revalidatePath } from "next/cache";
import { getPrisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/permissions";
import { canAccessFarmaciaSync } from "@/lib/permissions-core";
import { resolveCurrentTenantSlug } from "@/lib/tenant-context";
import { LEGACY_TENANT } from "@/lib/auth";
import { finalizeAndQueueOrder, createEncomendaWithOutbox, IdempotencyConflictError } from "@/lib/ingest/orders";
import {
  salvarAutosaveEncomenda,
  ConflitoVersaoError,
  RascunhoNaoEditavelError,
  type LinhaAutosavePatch,
} from "@/lib/encomendas/autosave";
import {
  finalizarEncomendaMultiFornecedor,
  deveUsarFinalizacaoMultiFornecedor,
  LinhasSemFornecedorError,
  type DocumentoGerado,
} from "@/lib/encomendas/finalizar-multi-fornecedor";
import { logAudit } from "@/lib/audit";
import { retryOutboxRow, cancelOutboxRow } from "@/lib/integracao/outbox-admin";

/**
 * Valida que TODOS os `fornecedorSugeridoId` não-nulos pedidos numa
 * gravação (linha única ou lote) correspondem a um `Fornecedor` REAL —
 * nunca confia num id vindo do cliente sem o confirmar na base de dados.
 * Devolve `null` quando tudo é válido, ou a mensagem de erro a devolver.
 */
async function validarFornecedoresExistem(
  prisma: Awaited<ReturnType<typeof getPrisma>>,
  fornecedorIds: ReadonlyArray<string | null | undefined>
): Promise<string | null> {
  const ids = [...new Set(fornecedorIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return null;
  const existentes = await prisma.fornecedor.findMany({
    where: { id: { in: ids } },
    select: { id: true },
  });
  if (existentes.length === ids.length) return null;
  const encontrados = new Set(existentes.map((f) => f.id));
  const emFalta = ids.filter((id) => !encontrados.has(id));
  return `Fornecedor inválido: ${emFalta.join(", ")}.`;
}

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
  /** `null` = limpar/sem fornecedor; `undefined` = não alterar. Validado contra `Fornecedor` real. */
  fornecedorSugeridoId?: string | null;
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

    if (input.fornecedorSugeridoId !== undefined) {
      const erroFornecedor = await validarFornecedoresExistem(prisma, [input.fornecedorSugeridoId]);
      if (erroFornecedor) return { ok: false, error: erroFornecedor };
    }

    const data: {
      quantidadeAjustada?: number | null;
      notas?: string | null;
      fornecedorSugeridoId?: string | null;
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
    if (input.fornecedorSugeridoId !== undefined) {
      data.fornecedorSugeridoId = input.fornecedorSugeridoId;
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

export type FinalizeFromDetailResult =
  | { ok: true; tipo: "unico"; outboxId: string; numero: string | null }
  | {
      ok: true;
      tipo: "multi_fornecedor";
      loteOrigemId: string;
      listaEncomendaIds: string[];
      documentos: DocumentoGerado[];
      resumoTexto: string;
    }
  | { ok: false; error: string; conflito?: true; versaoAtual?: number }
  | { ok: false; error: string; semFornecedor: true; produtoIdsSemFornecedor: string[] };

/**
 * Finaliza um rascunho a partir do detalhe.
 *
 * Decide o caminho pela COMPOSIÇÃO REAL das linhas no momento da
 * chamada (nunca um parâmetro vindo do cliente): um único fornecedor
 * distinto entre as linhas (ou nenhum — o fluxo legado) segue sempre
 * `finalizeAndQueueOrder`, o caminho de sempre, sem qualquer mudança de
 * comportamento; mais de um fornecedor distinto usa
 * `finalizarEncomendaMultiFornecedor` (ver esse ficheiro para o desenho
 * completo — divide em N documentos, um por fornecedor, mantém o
 * rascunho original como "lote" em `PREPARADA`).
 *
 * A `batchKey` da operação multi-fornecedor é derivada do PRÓPRIO
 * `listaEncomendaId` — não precisa de vir do cliente: o rascunho é único
 * por natureza (cuid), e uma vez `PREPARADA` é terminal, por isso
 * qualquer chamada repetida encontra sempre o mesmo resultado já
 * persistido. Ver o comentário sobre idempotência em
 * `lib/encomendas/finalizar-multi-fornecedor.ts`.
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
): Promise<FinalizeFromDetailResult> {
  const session = await requirePermission("reports.write");
  const prisma = await getPrisma();
  const tenantSlug = (await resolveCurrentTenantSlug()) ?? LEGACY_TENANT;

  try {
    const linhas = await prisma.linhaEncomenda.findMany({
      where: { listaEncomendaId },
      select: { fornecedorSugeridoId: true },
    });

    if (deveUsarFinalizacaoMultiFornecedor(linhas)) {
      const resultado = await finalizarEncomendaMultiFornecedor(prisma, tenantSlug, {
        listaEncomendaId,
        batchKey: listaEncomendaId,
        versaoEsperada,
      });
      await logAudit({
        actorId: session.sub,
        action: "order.finalized_multi_fornecedor",
        entity: "ListaEncomenda",
        entityId: listaEncomendaId,
        meta: { reutilizado: resultado.reutilizado, documentos: resultado.documentos.map((d) => d.listaEncomendaId) },
      });
      revalidateDetail(listaEncomendaId);
      revalidatePath("/configuracoes/integracao");
      return {
        ok: true,
        tipo: "multi_fornecedor",
        loteOrigemId: resultado.loteOrigemId,
        listaEncomendaIds: resultado.documentos.map((d) => d.listaEncomendaId),
        documentos: resultado.documentos,
        resumoTexto: resultado.resumoTexto,
      };
    }

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
    return { ok: true, tipo: "unico", outboxId: result.outboxId, numero: result.numero };
  } catch (err) {
    if (err instanceof ConflitoVersaoError) {
      return { ok: false, error: err.message, conflito: true, versaoAtual: err.versaoAtual };
    }
    if (err instanceof LinhasSemFornecedorError) {
      return {
        ok: false,
        error: err.message,
        semFornecedor: true,
        produtoIdsSemFornecedor: err.produtoIdsSemFornecedor,
      };
    }
    if (err instanceof IdempotencyConflictError) {
      return { ok: false, error: err.message };
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

  const erroFornecedor = await validarFornecedoresExistem(
    prisma,
    linhas.map((l) => l.fornecedorSugeridoId)
  );
  if (erroFornecedor) return { ok: false, error: erroFornecedor };

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
