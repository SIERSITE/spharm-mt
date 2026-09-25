"use server";

import { revalidatePath } from "next/cache";
import { getPrisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/permissions";
import { canAccessFarmaciaSync } from "@/lib/permissions-core";
import { resolveCurrentTenantSlug } from "@/lib/tenant-context";
import { LEGACY_TENANT } from "@/lib/auth";
import { createEncomendaWithOutbox, type OrderLineInput } from "@/lib/ingest/orders";
import { loadOrderDetail } from "@/lib/encomendas/order-detail";
import { parsearPropostaContexto, type PropostaContexto } from "@/lib/encomendas/proposal-context";
import { logAudit } from "@/lib/audit";
import { MAX_CODIGOS } from "@/lib/produtos/lista-codigos-tipos";
import {
  generateOrderProposal,
  generateGroupProposal,
  type ProposalInput,
  type ProposalResult,
} from "@/lib/encomendas/proposal";
import {
  agruparParaGeracao,
  ehAcaoLinhaGrupo,
  type DecisaoLinha,
} from "@/lib/encomendas/decisao-grupo";
import { ehOrigemLinha, type OrigemLinha } from "@/lib/encomendas/origem-linha";
import { resolverTransferenciaInterna } from "@/lib/transferencias/resolver-transferencia-interna";

// ─── Tipos públicos ──────────────────────────────────────────────────────────

export type ProposalMode = "farmacia" | "grupo" | "consolidacao";

/** Tecto do contexto serializado — mesmo valor de app/encomendas/[id]/actions.ts (CONTEXTO_MAX_CHARS). */
const CONTEXT_JSON_MAX_CHARS = 20_000;

export type CreateOrderFormInput = {
  farmaciaId: string;
  nome: string;
  finalize: boolean;
  linhas: OrderLineInput[];
  /** Contexto funcional da proposta (modo/período/cobertura/filtros) — ver CreateOrderInput.contexto. */
  contexto?: string | null;
};

export type GenerateProposalInput = {
  mode: ProposalMode;
  farmaciaId?: string;   // obrigatório para mode=farmacia
  startDate: string;
  endDate: string;
  considerStock: boolean;
  baseRule: ProposalInput["baseRule"];
  targetCoverageDays: number;
  filters?: ProposalInput["filters"];
};

export type GenerateProposalResult =
  | { ok: true; data: ProposalResult }
  | { ok: false; error: string };

type ActionResult =
  | { ok: true; listaEncomendaId: string; outboxId: string | null }
  | { ok: false; error: string };

// ─── Criar encomenda ─────────────────────────────────────────────────────────

export async function createOrderAction(input: CreateOrderFormInput): Promise<ActionResult> {
  const session = await requirePermission("reports.write");
  const prisma = await getPrisma();
  const tenantSlug = (await resolveCurrentTenantSlug()) ?? LEGACY_TENANT;

  if (!input.farmaciaId) return { ok: false, error: "Seleccione uma farmácia." };
  if (!input.nome.trim()) return { ok: false, error: "Nome da encomenda em falta." };
  if (input.linhas.length === 0) return { ok: false, error: "Adicione pelo menos um produto." };
  if (input.contexto != null && input.contexto.length > CONTEXT_JSON_MAX_CHARS) {
    return { ok: false, error: "Contexto da proposta excede o tamanho máximo." };
  }

  try {
    const result = await createEncomendaWithOutbox(prisma, tenantSlug, {
      farmaciaId: input.farmaciaId,
      criadoPorId: session.sub,
      nome: input.nome,
      finalize: input.finalize,
      linhas: input.linhas,
      contexto: input.contexto,
    });

    await logAudit({
      actorId: session.sub,
      action: input.finalize ? "order.created_and_finalized" : "order.created_draft",
      entity: "ListaEncomenda",
      entityId: result.listaEncomendaId,
      meta: { finalize: input.finalize, linhasCount: input.linhas.length, outboxId: result.outboxId },
    });

    revalidatePath("/encomendas");
    revalidatePath("/configuracoes/integracao");
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido" };
  }
}

// ─── Carregar rascunho (retomar em /encomendas/nova?rascunho=<id>) ──────────

export type RascunhoNovaEncomendaLinha = {
  produtoId: string;
  cnp: number;
  designacao: string;
  fabricante: string | null;
  fornecedor: string | null;
  currentStock: number | null;
  quantidadeSugerida: number | null;
  quantidadeAjustada: number | null;
  notas: string | null;
  origem: "PROPOSTA" | "MANUAL" | "SUGESTAO";
};

export type RascunhoNovaEncomenda = {
  listaEncomendaId: string;
  versao: number;
  nome: string;
  farmaciaId: string;
  contexto: PropostaContexto | null;
  linhas: RascunhoNovaEncomendaLinha[];
};

/**
 * Reconstrói um rascunho criado eagerly em `/encomendas/nova` (ver
 * `lib/encomendas/proposal-context.ts`) — chamado ao montar o ecrã com
 * `?rascunho=<id>` na URL, seja por recarregar a página, seja por abrir
 * o mesmo link noutro computador.
 *
 * Reutiliza `loadOrderDetail` (o MESMO carregador de
 * `app/encomendas/[id]/page.tsx`) para produtoId/cnp/designacao/
 * fabricante/fornecedor/stock ACTUAL/quantidades/notas/origem — nunca
 * uma segunda query a fazer a mesma coisa de forma ligeiramente
 * diferente. As colunas só-de-análise da proposta (vendas médias,
 * cobertura, pendente, motivo) NÃO são recalculadas aqui — ficam
 * neutras até o utilizador voltar a clicar "Gerar proposta"; recalculá-
 * -las eagerly implicaria correr o motor de propostas e fundir com
 * `fundirComProposta`, cuja regra ("PROPOSTA é sempre substituída")
 * descartaria silenciosamente uma quantidade editada numa linha ainda
 * com origem PROPOSTA — exactamente o tipo de perda de dados silenciosa
 * que esta funcionalidade existe para evitar.
 */
export async function carregarRascunhoNovaEncomendaAction(
  listaEncomendaId: string
): Promise<{ ok: true; data: RascunhoNovaEncomenda } | { ok: false; error: string }> {
  const session = await requirePermission("reports.write");

  const detail = await loadOrderDetail(listaEncomendaId);
  if (!detail) return { ok: false, error: "Rascunho não encontrado." };
  if (!canAccessFarmaciaSync(session, detail.farmaciaId)) {
    return { ok: false, error: "Sem acesso a esta farmácia." };
  }
  if (detail.estado !== "RASCUNHO") {
    return { ok: false, error: "Esta encomenda já não é um rascunho editável." };
  }

  const prisma = await getPrisma();
  const raw = await prisma.listaEncomenda.findUnique({
    where: { id: listaEncomendaId },
    select: { contextoJson: true },
  });

  return {
    ok: true,
    data: {
      listaEncomendaId: detail.id,
      versao: detail.versao,
      nome: detail.nome,
      farmaciaId: detail.farmaciaId,
      contexto: parsearPropostaContexto(raw?.contextoJson ?? null),
      linhas: detail.linhas.map((l) => ({
        produtoId: l.produtoId,
        cnp: l.cnp,
        designacao: l.designacao,
        fabricante: l.fabricante,
        fornecedor: l.fornecedor,
        currentStock: l.currentStock,
        quantidadeSugerida: l.quantidadeSugerida,
        quantidadeAjustada: l.quantidadeAjustada,
        notas: l.notas,
        origem: l.origem,
      })),
    },
  };
}

// ─── Gerar proposta ──────────────────────────────────────────────────────────

export async function generateProposalAction(
  input: GenerateProposalInput
): Promise<GenerateProposalResult> {
  const session = await requirePermission("reports.write");

  // Grupo e consolidação requerem perfil de gestor de grupo ou administrador.
  if (input.mode === "grupo" || input.mode === "consolidacao") {
    if (session.perfil !== "ADMINISTRADOR" && session.perfil !== "GESTOR_GRUPO") {
      return { ok: false, error: "Sem permissão para vista de grupo." };
    }
  }

  try {
    const start = new Date(input.startDate);
    const end = new Date(input.endDate);

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return { ok: false, error: "Datas inválidas." };
    }
    if (end < start) {
      return { ok: false, error: "A data fim é anterior à data início." };
    }
    if (input.targetCoverageDays < 1) {
      return { ok: false, error: "Cobertura alvo deve ser pelo menos 1 dia." };
    }

    // ── Lista importada ────────────────────────────────────────────
    //
    // Sanea o array antes de o deixar chegar ao SQL. A lista vem do
    // cliente e não do endpoint de upload — nada impede um pedido
    // forjado de mandar 10 milhões de entradas ou strings.
    //
    // A PRESENÇA é preservada com cuidado: um array vazio que chegue
    // vazio tem de sair vazio, porque `[]` significa "nenhum produto" e
    // não "sem filtro". Convertê-lo a `undefined` aqui devolvia ao
    // utilizador o catálogo inteiro. Ver `ProposalFilters.cnps`.
    const cnpsRecebidos = input.filters?.cnps;
    if (Array.isArray(cnpsRecebidos)) {
      if (cnpsRecebidos.length > MAX_CODIGOS) {
        return {
          ok: false,
          error: `A lista importada tem ${cnpsRecebidos.length.toLocaleString("pt-PT")} códigos; o máximo é ${MAX_CODIGOS.toLocaleString("pt-PT")}.`,
        };
      }
      const limpos = [
        ...new Set(cnpsRecebidos.filter((n) => typeof n === "number" && Number.isSafeInteger(n))),
      ];
      input = { ...input, filters: { ...input.filters, cnps: limpos } };
    }

    end.setHours(23, 59, 59, 999);

    const prisma = await getPrisma();

    if (input.mode === "farmacia") {
      if (!input.farmaciaId) return { ok: false, error: "Seleccione uma farmácia." };

      const farmacia = await prisma.farmacia.findUnique({
        where: { id: input.farmaciaId },
        select: { nome: true },
      });

      const data = await generateOrderProposal({
        farmaciaId: input.farmaciaId,
        farmaciaNome: farmacia?.nome ?? input.farmaciaId,
        startDate: start,
        endDate: end,
        considerStock: input.considerStock,
        baseRule: input.baseRule,
        targetCoverageDays: input.targetCoverageDays,
        filters: input.filters,
      });

      return { ok: true, data };
    } else {
      // modo grupo ou consolidacao — o servidor determina as farmácias activas
      const farmacias = await prisma.farmacia.findMany({
        where: { estado: "ATIVO" },
        select: { id: true, nome: true },
        orderBy: { nome: "asc" },
      });

      if (farmacias.length === 0) {
        return { ok: false, error: "Sem farmácias activas configuradas." };
      }

      const farmaciaNames = Object.fromEntries(farmacias.map((f) => [f.id, f.nome]));

      const data = await generateGroupProposal({
        farmaciaIds: farmacias.map((f) => f.id),
        farmaciaNames,
        startDate: start,
        endDate: end,
        considerStock: input.considerStock,
        baseRule: input.baseRule,
        targetCoverageDays: input.targetCoverageDays,
        filters: input.filters,
      });

      return { ok: true, data };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido" };
  }
}

// ─── Transferência interna ────────────────────────────────────────────────────

export type InternalTransferKind = "same-cnp" | "dci-equivalent";

export type CreateInternalTransferInput = {
  destinoFarmaciaId: string;
  /**
   * Identidade REAL da farmácia de origem. Nunca resolvida por nome —
   * `Farmacia.nome` não é único na BD, e um `findFirst({where:{nome}})`
   * já causou o risco de escolher a farmácia errada quando duas
   * partilham o mesmo nome. Todos os chamadores já tinham este ID
   * disponível (`suggestedSourceFarmaciaId`/`sourceFarmaciaId`/
   * `farmaciaOrigemId` nos módulos de origem) — só não estava a ser
   * passado até aqui.
   */
  sourceFarmaciaId: string;
  /** Só para apresentação (diálogo de confirmação, notas, auditoria) — nunca usado para resolver a farmácia. */
  sourceFarmaciaNome: string;
  produtoId: string;
  cnp: string;
  designacao: string;
  quantidade: number;
  kind: InternalTransferKind;
  motivo: string;
  dciSourceProductName?: string;
  dciSourceCnp?: string;
};

export type CreateInternalTransferResult =
  | { ok: true; transferenciaId: string }
  | { ok: false; error: string };

/**
 * `nomeOrigemAutoritativo` vem de `Farmacia.nome` lido da BD pelo id
 * (ver chamador) — nunca de `input.sourceFarmaciaNome`, que é só o que
 * o browser mostrou no diálogo de confirmação antes de submeter.
 */
function buildTransferNote(input: CreateInternalTransferInput, nomeOrigemAutoritativo: string): string {
  const lines: string[] = [];
  lines.push(`Transferência interna sugerida (${input.kind}).`);
  lines.push(`Origem: ${nomeOrigemAutoritativo}`);
  if (input.kind === "dci-equivalent" && input.dciSourceProductName) {
    lines.push(`Source product: ${input.dciSourceProductName} (CNP ${input.dciSourceCnp ?? "—"})`);
    lines.push(`Atenção: DCI-equivalente. Validar antes de transferir.`);
  }
  lines.push(`Motivo: ${input.motivo}`);
  return lines.join(" · ");
}

/**
 * Cria uma transferência interna real (`Transferencia`+`LinhaTransferencia`),
 * o MESMO desenho já usado por `gerarPlanoGrupoAction` para o ramo
 * TRANSFERIR — ver o comentário no modelo `Transferencia` em
 * `prisma/schema.prisma`.
 *
 * Antes desta revisão (2026-09), esta acção criava uma `ListaEncomenda`
 * a fingir de transferência (nome "Transferência interna · …",
 * `LinhaEncomenda` com `notas` em texto livre) via
 * `createEncomendaWithOutbox` — o que arrastava a transferência para o
 * circuito de exportação ao ERP (`OrderOutbox`/`OrderExportAudit`),
 * fazia-a aparecer em `/encomendas` como uma encomenda normal e mostrar
 * "exportação pendente" para sempre, porque nunca havia agent nenhum a
 * exportá-la. Uma transferência interna nunca foi, nem deve ser, uma
 * encomenda ao fornecedor.
 *
 * Não cria nenhum `OrderOutbox`/`OrderExportAudit` — sem exportação ao
 * ERP, tal como `gerarPlanoGrupoAction`.
 */
export async function createInternalTransferAction(
  input: CreateInternalTransferInput
): Promise<CreateInternalTransferResult> {
  const session = await requirePermission("reports.write");
  const prisma = await getPrisma();

  if (!input.produtoId) return { ok: false, error: "Produto em falta." };
  if (!Number.isFinite(input.quantidade) || input.quantidade <= 0) {
    return { ok: false, error: "Quantidade tem de ser > 0." };
  }

  try {
    // `prisma` (getPrisma()) já é o cliente do TENANT corrente — uma
    // farmácia de outro tenant simplesmente não existe nesta ligação,
    // vive noutra base de dados. `findUnique` por id é a única
    // resolução: nunca por nome (Farmacia.nome não é único).
    const [farmaciaOrigemRow, farmaciaDestinoRow] = await Promise.all([
      prisma.farmacia.findUnique({ where: { id: input.sourceFarmaciaId }, select: { id: true, nome: true } }),
      prisma.farmacia.findUnique({ where: { id: input.destinoFarmaciaId }, select: { id: true, nome: true } }),
    ]);
    const resolucao = resolverTransferenciaInterna(input, farmaciaOrigemRow, farmaciaDestinoRow);
    if (!resolucao.ok) return resolucao;
    const { farmaciaOrigem, farmaciaDestino } = resolucao;

    const transferencia = await prisma.$transaction(async (tx) => {
      return tx.transferencia.create({
        data: {
          farmaciaOrigemId: farmaciaOrigem.id,
          farmaciaDestinoId: farmaciaDestino.id,
          criadoPorId: session.sub,
          linhas: {
            create: [
              {
                produtoId: input.produtoId,
                quantidade: input.quantidade,
                // Nome AUTORITATIVO (acabado de ler da BD pelo id), nunca
                // o que o cliente mandou em sourceFarmaciaNome — esse é
                // só para o diálogo de confirmação no browser.
                notas: buildTransferNote(input, farmaciaOrigem.nome),
              },
            ],
          },
        },
      });
    });

    await logAudit({
      actorId: session.sub,
      action: "internal_transfer.created",
      entity: "Transferencia",
      entityId: transferencia.id,
      meta: {
        kind: input.kind,
        farmaciaOrigemId: farmaciaOrigem.id,
        destinoFarmaciaId: farmaciaDestino.id,
        sourceFarmaciaNome: farmaciaOrigem.nome,
        cnp: input.cnp,
        quantidade: input.quantidade,
        motivo: input.motivo,
      },
    });

    revalidatePath("/transferencias");
    revalidatePath("/dashboard");
    return { ok: true, transferenciaId: transferencia.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido" };
  }
}

// ─── Bloco D — encomenda de grupo com decisão por linha ────────────────────────
//
// O utilizador percorre a proposta de grupo e decide, linha a linha,
// ENCOMENDAR / TRANSFERIR / NÃO FAZER (ver `lib/encomendas/decisao-grupo.ts`).
// Esta acção recebe o conjunto final de decisões e gera, no máximo, uma
// `ListaEncomenda` por farmácia com linhas ENCOMENDAR e uma `Transferencia`
// por direcção com linhas TRANSFERIR — nunca um documento vazio, porque
// `agruparParaGeracao` só cria uma entrada no Map quando há pelo menos uma
// linha para lá.
//
// Nota de desenho: cada `ListaEncomenda` nasce pelo ÚNICO caminho suportado
// (`createEncomendaWithOutbox`, que já embrulha lista+linhas+outbox na sua
// própria transacção) e cada `Transferencia` nasce na sua própria transacção
// (lista+linhas). Não há UMA transacção a embrulhar TODOS os documentos —
// o cliente de transacção interactiva do Prisma não suporta transacções
// aninhadas, e `createEncomendaWithOutbox` já é, por regra do módulo, o
// único sítio donde uma ListaEncomenda pode nascer. Cada documento gerado
// é atómico (lista+linhas+outbox, ou transferência+linhas, nunca a meio);
// o que não existe é atomicidade ENTRE documentos — a mesma garantia que o
// modo "consolidação" já tem hoje (`Promise.all` de `createOrderAction`
// independentes).

export type DecisaoLinhaGrupoInput = DecisaoLinha & {
  /** Preservado para a ListaEncomenda — o valor que o motor sugeriu. */
  quantidadeSugerida?: number | null;
  notas?: string | null;
  /** Proveniência da linha (MANUAL/SUGESTAO sobrevivem a recálculo). */
  origem?: OrigemLinha;
};

export type GerarPlanoGrupoInput = {
  /** Prefixo do nome de cada ListaEncomenda gerada. */
  nome: string;
  decisoes: DecisaoLinhaGrupoInput[];
};

export type GerarPlanoGrupoResult =
  | {
      ok: true;
      listasEncomenda: { farmaciaId: string; listaEncomendaId: string; nLinhas: number }[];
      transferencias: {
        farmaciaOrigemId: string;
        farmaciaDestinoId: string;
        transferenciaId: string;
        nLinhas: number;
      }[];
    }
  | { ok: false; error: string };

function validarDecisoes(decisoes: unknown): decisoes is DecisaoLinhaGrupoInput[] {
  if (!Array.isArray(decisoes)) return false;
  return decisoes.every((d) => {
    if (typeof d !== "object" || d === null) return false;
    const r = d as Record<string, unknown>;
    if (typeof r.produtoId !== "string" || r.produtoId.length === 0) return false;
    if (!ehAcaoLinhaGrupo(r.acao)) return false;
    if (typeof r.acaoTocada !== "boolean") return false;
    if (r.origem !== undefined && !ehOrigemLinha(r.origem)) return false;
    return true;
  });
}

export async function gerarPlanoGrupoAction(
  input: GerarPlanoGrupoInput
): Promise<GerarPlanoGrupoResult> {
  const session = await requirePermission("reports.write");

  // Mesma gate que `generateProposalAction` usa para modo "grupo" — não
  // se inventa uma segunda porta para a mesma sala.
  if (session.perfil !== "ADMINISTRADOR" && session.perfil !== "GESTOR_GRUPO") {
    return { ok: false, error: "Sem permissão para vista de grupo." };
  }

  if (!validarDecisoes(input.decisoes)) {
    return { ok: false, error: "Decisões inválidas." };
  }
  if (input.decisoes.length === 0) {
    return { ok: false, error: "Sem linhas na proposta." };
  }

  const prisma = await getPrisma();
  const tenantSlug = (await resolveCurrentTenantSlug()) ?? LEGACY_TENANT;

  const { porFarmacia, porDirecao } = agruparParaGeracao(input.decisoes);

  if (porFarmacia.size === 0 && porDirecao.size === 0) {
    return {
      ok: false,
      error: "Sem linhas accionáveis — todas as decisões são \"Não fazer\" ou têm quantidade 0.",
    };
  }

  const nomePrefixo = (input.nome.trim() || `Grupo ${new Date().toLocaleDateString("pt-PT")}`).slice(
    0,
    140
  );

  try {
    const resultadoListas: { farmaciaId: string; listaEncomendaId: string; nLinhas: number }[] = [];
    for (const [farmaciaId, linhas] of porFarmacia) {
      const resultado = await createEncomendaWithOutbox(prisma, tenantSlug, {
        farmaciaId,
        criadoPorId: session.sub,
        nome: `${nomePrefixo} · encomendar`.slice(0, 180),
        finalize: false,
        linhas: linhas.map((l) => ({
          produtoId: l.produtoId,
          quantidadeSugerida: l.quantidadeSugerida ?? null,
          quantidadeAjustada: l.quantidadeFinal,
          notas: l.notas ?? null,
          origem: l.origem ?? "PROPOSTA",
        })),
      });
      resultadoListas.push({
        farmaciaId,
        listaEncomendaId: resultado.listaEncomendaId,
        nLinhas: linhas.length,
      });
      await logAudit({
        actorId: session.sub,
        action: "group_plan.encomenda_created",
        entity: "ListaEncomenda",
        entityId: resultado.listaEncomendaId,
        meta: { farmaciaId, linhasCount: linhas.length, outboxId: resultado.outboxId },
      });
    }

    const resultadoTransferencias: {
      farmaciaOrigemId: string;
      farmaciaDestinoId: string;
      transferenciaId: string;
      nLinhas: number;
    }[] = [];
    for (const [, linhas] of porDirecao) {
      const farmaciaOrigemId = linhas[0].farmaciaOrigemId!;
      const farmaciaDestinoId = linhas[0].farmaciaDestinoId!;
      const transferencia = await prisma.$transaction(async (tx) => {
        return tx.transferencia.create({
          data: {
            farmaciaOrigemId,
            farmaciaDestinoId,
            criadoPorId: session.sub,
            linhas: {
              create: linhas.map((l) => ({
                produtoId: l.produtoId,
                quantidade: l.quantidadeTransferir,
                notas: l.notas ?? null,
              })),
            },
          },
        });
      });
      resultadoTransferencias.push({
        farmaciaOrigemId,
        farmaciaDestinoId,
        transferenciaId: transferencia.id,
        nLinhas: linhas.length,
      });
      await logAudit({
        actorId: session.sub,
        action: "group_plan.transferencia_created",
        entity: "Transferencia",
        entityId: transferencia.id,
        meta: { farmaciaOrigemId, farmaciaDestinoId, linhasCount: linhas.length },
      });
    }

    revalidatePath("/encomendas");
    revalidatePath("/configuracoes/integracao");

    return { ok: true, listasEncomenda: resultadoListas, transferencias: resultadoTransferencias };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido" };
  }
}
