"use server";

import { revalidatePath } from "next/cache";
import { getPrisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/permissions";
import { canAccessFarmaciaSync } from "@/lib/permissions-core";
import { resolveCurrentTenantSlug } from "@/lib/tenant-context";
import { LEGACY_TENANT } from "@/lib/auth";
import {
  criarConsolidacaoServico,
  obterEstadoConsolidacaoServico,
  ensureRascunhoConsolidacaoFarmaciaServico,
  obterRascunhosConsolidacaoServico,
  finalizarConsolidacaoServico,
  type CriarConsolidacaoInput,
  type CriarConsolidacaoResultado,
  type EstadoConsolidacaoServidor,
  type EnsureRascunhoConsolidacaoFarmaciaResultado,
  type ObterRascunhosConsolidacaoResultado,
} from "@/lib/encomendas/consolidacao-servico";
import {
  createEncomendaWithOutbox,
  IdempotencyConflictError,
  type OrderLineInput,
} from "@/lib/ingest/orders";
import {
  type DocumentoConsolidacaoGerado,
} from "@/lib/encomendas/consolidacao-multi-fornecedor";
import { loadOrderDetail } from "@/lib/encomendas/order-detail";
import { loadTransferenciasDetail } from "@/lib/transferencias/transferencia-detail";
import { buildEncomendaDocumentoReport } from "@/lib/reporting/adapters/encomenda-documento";
import { buildEncomendaConsolidadaDocumentoReport } from "@/lib/reporting/adapters/encomenda-consolidada-documento";
import { buildTransferenciaDocumentoReport } from "@/lib/reporting/adapters/transferencia-documento";
import type { Report } from "@/lib/reporting/report-types";
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
import {
  criarTransferenciaComLinhas,
  deriveDirectionIdempotencyKey,
  IdempotencyConflictError as TransferIdempotencyConflictError,
} from "@/lib/transferencias/criar-transferencia";
import {
  finalizarEncomendaMultiFornecedor,
  deveUsarFinalizacaoMultiFornecedor,
} from "@/lib/encomendas/finalizar-multi-fornecedor";
import {
  validarLinhasParaFinalizacaoMultiFornecedor,
  deriveGrupoDraftIdempotencyKey,
  deriveGrupoFinalizacaoBatchKey,
} from "@/lib/encomendas/finalizar-multi-fornecedor-regras";
import { randomUUID } from "node:crypto";

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
  /** Chave de idempotência gerada pelo cliente — ver ListaEncomenda.clientIdempotencyKey. */
  clientIdempotencyKey?: string | null;
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
  | { ok: false; error: string; code?: "IDEMPOTENCY_CONFLICT" };

const CHAVE_IDEMPOTENCIA_RE = /^[A-Za-z0-9_-]{16,80}$/;

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

  if (input.clientIdempotencyKey != null && !CHAVE_IDEMPOTENCIA_RE.test(input.clientIdempotencyKey)) {
    return { ok: false, error: "Chave de idempotência inválida." };
  }
  if (!canAccessFarmaciaSync(session, input.farmaciaId)) {
    return { ok: false, error: "Sem acesso a esta farmácia." };
  }

  try {
    const result = await createEncomendaWithOutbox(prisma, tenantSlug, {
      farmaciaId: input.farmaciaId,
      criadoPorId: session.sub,
      nome: input.nome,
      finalize: input.finalize,
      linhas: input.linhas,
      contexto: input.contexto,
      clientIdempotencyKey: input.clientIdempotencyKey ?? null,
    });

    await logAudit({
      actorId: session.sub,
      action: input.finalize ? "order.created_and_finalized" : "order.created_draft",
      entity: "ListaEncomenda",
      entityId: result.listaEncomendaId,
      meta: {
        finalize: input.finalize,
        linhasCount: input.linhas.length,
        outboxId: result.outboxId,
        comContexto: input.contexto != null,
        idempotente: input.clientIdempotencyKey != null,
      },
    });

    // Rascunho: sem `revalidatePath` (páginas `force-dynamic`; ver o comentário em
    // autosaveEncomendaAction) — revalidar aqui revertia `?rascunho=<id>` na URL
    // logo depois de o rascunho eager ser criado. Só a finalização (outbox) muda
    // o que as outras páginas mostram.
    if (input.finalize) {
      revalidatePath("/encomendas");
      revalidatePath("/configuracoes/integracao");
    }
    return { ok: true, ...result };
  } catch (err) {
    if (err instanceof IdempotencyConflictError) {
      return { ok: false, error: err.message, code: err.code };
    }
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido" };
  }
}

// ─── Consolidação: N encomendas (uma por farmácia), UMA transacção ───────────
//
// A lógica vive em `lib/encomendas/consolidacao-servico.ts` (dependências
// injectadas → testável sem sessão real). Estas duas actions só resolvem a
// sessão, o tenant e o prisma reais e delegam.

export type CreateConsolidatedOrdersInput = CriarConsolidacaoInput;
export type CreateConsolidatedOrdersResult = CriarConsolidacaoResultado;

export async function createConsolidatedOrdersAction(
  input: CreateConsolidatedOrdersInput
): Promise<CreateConsolidatedOrdersResult> {
  const session = await requirePermission("reports.write");
  const prisma = await getPrisma();
  const tenantSlug = (await resolveCurrentTenantSlug()) ?? LEGACY_TENANT;

  const r = await criarConsolidacaoServico(
    {
      prisma,
      tenantSlug,
      sessao: session,
      auditar: (e) =>
        logAudit({ actorId: session.sub, action: e.action, entity: "ListaEncomenda", entityId: e.entityId, meta: e.meta }),
    },
    input
  );
  if (r.ok && !r.reutilizado) {
    revalidatePath("/encomendas");
    revalidatePath("/configuracoes/integracao");
  }
  return r;
}

/**
 * Reconciliação: o que existe no servidor para uma chave de lote cujo
 * resultado o cliente não viu (timeout, ligação perdida, refresh).
 * Só lê. Ver `obterEstadoConsolidacaoServico`.
 */
export async function obterEstadoConsolidacaoPorChaveAction(input: {
  batchKey: string;
  farmaciaIds: string[];
}): Promise<EstadoConsolidacaoServidor> {
  const session = await requirePermission("reports.write");
  const prisma = await getPrisma();
  return obterEstadoConsolidacaoServico({ prisma, sessao: session, tenantSlug: (await resolveCurrentTenantSlug()) ?? LEGACY_TENANT }, input);
}

// ─── Consolidação · fornecedor por linha (rascunho real por farmácia) ───
//
// (2026-09-30) Ao contrário do lote atómico acima (`createConsolidatedOrdersAction`
// — continua a existir, inalterada, para quem precisar do caminho simples
// sem fornecedor por linha), estas três acções servem o novo fluxo com
// fornecedor por linha: um rascunho REAL e persistente por farmácia
// (autosave próprio, uma instância por farmácia no cliente — ver
// `useAutosaveEncomenda`), recuperável por `batchKey`, finalizado
// agrupando PRIMEIRO por farmácia, DEPOIS por fornecedor.

export type EnsureRascunhoConsolidacaoInput = {
  batchKey: string;
  farmaciaId: string;
  nome: string;
  linhas: OrderLineInput[];
  contexto?: string | null;
};

/**
 * Cria (ou obtém, idempotente) o rascunho REAL de UMA farmácia da
 * consolidação — chamada independentemente por farmácia, no primeiro
 * toque significativo dessa farmácia (mesmo desenho de `ensureDraft` em
 * `order-create-client.tsx`, um nível acima: uma farmácia de cada vez,
 * nunca uma criação atómica das N farmácias).
 */
export async function ensureRascunhoConsolidacaoAction(
  input: EnsureRascunhoConsolidacaoInput
): Promise<EnsureRascunhoConsolidacaoFarmaciaResultado> {
  const session = await requirePermission("reports.write");
  const prisma = await getPrisma();
  const tenantSlug = (await resolveCurrentTenantSlug()) ?? LEGACY_TENANT;
  return ensureRascunhoConsolidacaoFarmaciaServico(
    {
      prisma,
      tenantSlug,
      sessao: session,
      auditar: (e) => logAudit({ actorId: session.sub, action: e.action, entity: "ListaEncomenda", entityId: e.entityId, meta: e.meta }),
    },
    input
  );
}

/**
 * Recuperação de uma consolidação por `batchKey` — devolve o conteúdo
 * COMPLETO (produto, quantidade, fornecedor DECIDIDO, notas, origem) do
 * rascunho de cada farmácia pedida, ou `null` por farmácia ainda sem
 * rascunho. Chamada ao montar `/encomendas/nova?consolidacao=<batchKey>`
 * (refresh, navegação de volta, ou o mesmo link noutro computador) para
 * repopular o ecrã sem recalcular nem voltar a sugerir nada.
 */
export async function carregarRascunhosConsolidacaoAction(input: {
  batchKey: string;
  farmaciaIds: string[];
}): Promise<ObterRascunhosConsolidacaoResultado> {
  const session = await requirePermission("reports.write");
  const prisma = await getPrisma();
  return obterRascunhosConsolidacaoServico({ prisma, sessao: session, tenantSlug: (await resolveCurrentTenantSlug()) ?? LEGACY_TENANT }, input);
}

export type FinalizarConsolidacaoFornecedorInput = {
  batchKey: string;
  farmaciaIds: string[];
  /** Bloqueio optimista por farmácia — omitida = sem verificação amigável para essa farmácia. */
  versaoEsperadaPorFarmacia?: Record<string, number>;
};

export type FinalizarConsolidacaoFornecedorResultado =
  | {
      ok: true;
      reutilizado: boolean;
      porFarmacia: Array<{ farmaciaId: string; loteOrigemId: string; documentos: DocumentoConsolidacaoGerado[] }>;
      documentos: DocumentoConsolidacaoGerado[];
      resumoTexto: string;
    }
  | { ok: false; error: string; code?: "IDEMPOTENCY_CONFLICT" }
  | { ok: false; error: string; conflito: true; farmaciaId?: string; versaoAtual?: number }
  | { ok: false; error: string; semFornecedor: true; produtoIdsSemFornecedor: string[]; farmaciaId?: string };

/**
 * Finaliza a consolidação inteira, agrupando PRIMEIRO por farmácia,
 * DEPOIS por fornecedor. Invólucro fino: resolve sessão/prisma/tenant
 * reais e delega TUDO — autorização (tenant, criador, acesso a cada
 * farmácia), bloqueio optimista por farmácia, pré-validação e a
 * transacção do motor — em `finalizarConsolidacaoServico`
 * (lib/encomendas/consolidacao-servico.ts). Nenhuma verificação própria
 * aqui: uma versão mais fraca duplicada na action é exactamente o que se
 * evita.
 */
export async function finalizarConsolidacaoFornecedorAction(
  input: FinalizarConsolidacaoFornecedorInput
): Promise<FinalizarConsolidacaoFornecedorResultado> {
  const session = await requirePermission("reports.write");
  const prisma = await getPrisma();
  const tenantSlug = (await resolveCurrentTenantSlug()) ?? LEGACY_TENANT;

  const r = await finalizarConsolidacaoServico(
    {
      prisma,
      tenantSlug,
      sessao: session,
      auditar: (e) =>
        logAudit({ actorId: session.sub, action: e.action, entity: "ListaEncomenda", entityId: e.entityId, meta: e.meta }),
    },
    input
  );

  if (r.ok) {
    revalidatePath("/encomendas");
    revalidatePath("/configuracoes/integracao");
    return { ok: true, reutilizado: r.reutilizado, porFarmacia: r.porFarmacia, documentos: r.documentos, resumoTexto: r.resumoTexto };
  }
  switch (r.code) {
    case "CONFLITO_VERSAO":
      return { ok: false, error: r.error, conflito: true, farmaciaId: r.farmaciaId, versaoAtual: r.versaoAtual };
    case "SEM_FORNECEDOR":
      return { ok: false, error: r.error, semFornecedor: true, produtoIdsSemFornecedor: r.produtoIdsSemFornecedor ?? [], farmaciaId: r.farmaciaId };
    case "IDEMPOTENCY_CONFLICT":
      return { ok: false, error: r.error, code: "IDEMPOTENCY_CONFLICT" };
    default:
      return { ok: false, error: r.error };
  }
}

// ─── Carregar rascunho (retomar em /encomendas/nova?rascunho=<id>) ──────────

export type RascunhoNovaEncomendaLinha = {
  produtoId: string;
  cnp: number;
  designacao: string;
  fabricante: string | null;
  fornecedor: string | null;
  /** Fornecedor DECIDIDO nesta linha — ver comentário em OrderDetailLine.fornecedorSugeridoId. */
  fornecedorSugeridoId: string | null;
  fornecedorSugeridoNome: string | null;
  fornecedorSugeridoInativo?: boolean;
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
        fornecedorSugeridoId: l.fornecedorSugeridoId,
        fornecedorSugeridoNome: l.fornecedorSugeridoNome,
        fornecedorSugeridoInativo: l.fornecedorSugeridoInativo,
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
  /**
   * Chave de idempotência gerada pelo CLIENTE (ver
   * `lib/transferencias/criar-transferencia.ts`) — um clique repetido ou
   * um retry após resposta perdida com a MESMA chave devolve a
   * transferência já criada em vez de duplicar.
   */
  clientIdempotencyKey?: string | null;
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
 *
 * Nasce já FINALIZADA (não em RASCUNHO): tal como o ramo TRANSFERIR de
 * `gerarPlanoGrupoAction`, esta acção só corre depois do utilizador já
 * ter decidido quantidade e motivo — não há nenhum estado de rascunho
 * intermédio útil. Antes de 2026-09 ficava silenciosamente em RASCUNHO
 * para sempre (sem número, sem data de finalização, sem aparecer em
 * nenhuma manutenção) — uma das causas de "a transferência desaparece
 * depois de concluída".
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

    const { transferenciaId } = await criarTransferenciaComLinhas(prisma, {
      farmaciaOrigemId: farmaciaOrigem.id,
      farmaciaDestinoId: farmaciaDestino.id,
      criadoPorId: session.sub,
      finalize: true,
      linhas: [
        {
          produtoId: input.produtoId,
          quantidade: input.quantidade,
          // Nome AUTORITATIVO (acabado de ler da BD pelo id), nunca
          // o que o cliente mandou em sourceFarmaciaNome — esse é
          // só para o diálogo de confirmação no browser.
          notas: buildTransferNote(input, farmaciaOrigem.nome),
        },
      ],
      clientIdempotencyKey: input.clientIdempotencyKey ?? null,
    });

    await logAudit({
      actorId: session.sub,
      action: "internal_transfer.created",
      entity: "Transferencia",
      entityId: transferenciaId,
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
    return { ok: true, transferenciaId };
  } catch (err) {
    if (err instanceof TransferIdempotencyConflictError) return { ok: false, error: err.message };
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
  /**
   * Fornecedor DECIDIDO para esta linha — ver
   * `LinhaEncomenda.fornecedorSugeridoId`. Omitido/`undefined` é tratado
   * como `null` (sem fornecedor) — compatibilidade com um cliente mais
   * antigo que ainda não enviasse este campo.
   */
  fornecedorSugeridoId?: string | null;
};

export type GerarPlanoGrupoInput = {
  /** Prefixo do nome de cada ListaEncomenda gerada. */
  nome: string;
  decisoes: DecisaoLinhaGrupoInput[];
  /** Contexto da proposta de grupo serializado — gravado em cada ListaEncomenda gerada. */
  contexto?: string | null;
  /**
   * Chave de idempotência do LOTE de transferências (gerada pelo
   * cliente) — a chave real de cada `Transferencia` deriva dela por
   * direcção (ver `deriveDirectionIdempotencyKey`), tal como o modo
   * "consolidação" já faz para `ListaEncomenda`. Omitida = sem protecção
   * contra duplo-clique/retry neste ramo (comportamento anterior).
   */
  transferenciaBatchKey?: string | null;
  /**
   * Chave de idempotência do LOTE de ENCOMENDAS deste plano de grupo.
   * Só tem efeito real numa farmácia cujas linhas ENCOMENDAR acabem
   * divididas por mais de um fornecedor (ver `deveUsarFinalizacaoMulti-
   * Fornecedor` abaixo): dá a essa divisão a MESMA garantia de
   * idempotência que `finalizarEncomendaMultiFornecedor` já dá ao fluxo
   * manual (ver `deriveGrupoDraftIdempotencyKey`/
   * `deriveGrupoFinalizacaoBatchKey`). Omitida = uma chave é gerada aqui
   * (sem protecção contra duplo-clique/retry para essa farmácia
   * específica) — mesma degradação graciosa que já existia para
   * `transferenciaBatchKey`.
   */
  encomendaBatchKey?: string | null;
};

export type DocumentoEncomendaGrupoGerado = {
  farmaciaId: string;
  listaEncomendaId: string;
  nLinhas: number;
  numero: string | null;
  /**
   * Preenchidos apenas quando esta farmácia dividiu por mais de um
   * fornecedor (ver `deveUsarFinalizacaoMultiFornecedor`) — `null`/
   * omitido no caminho de sempre (0 ou 1 fornecedor entre as linhas).
   */
  fornecedorId?: string | null;
  fornecedorNome?: string | null;
};

export type GerarPlanoGrupoResult =
  | {
      ok: true;
      listasEncomenda: DocumentoEncomendaGrupoGerado[];
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
    if (
      r.fornecedorSugeridoId !== undefined &&
      r.fornecedorSugeridoId !== null &&
      typeof r.fornecedorSugeridoId !== "string"
    )
      return false;
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
  if (input.contexto != null && input.contexto.length > CONTEXT_JSON_MAX_CHARS) {
    return { ok: false, error: "Contexto da proposta excede o tamanho máximo." };
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

  // `fornecedorSugeridoId` é opcional em `DecisaoLinhaGrupoInput`
  // (compatibilidade com um cliente mais antigo) — as regras puras de
  // `finalizar-multi-fornecedor-regras.ts` pedem sempre `string | null`
  // (nunca `undefined`), por isso normaliza-se aqui uma única vez.
  const semFornecedorUndefined = (
    linhas: readonly DecisaoLinhaGrupoInput[]
  ): { produtoId: string; fornecedorSugeridoId: string | null }[] =>
    linhas.map((l) => ({ produtoId: l.produtoId, fornecedorSugeridoId: l.fornecedorSugeridoId ?? null }));

  // Pré-validação de fornecedor — TODAS as farmácias são verificadas
  // ANTES de qualquer escrita. Uma farmácia cujas linhas ENCOMENDAR
  // apontam para mais de um fornecedor só pode prosseguir se TODAS
  // tiverem fornecedor decidido (mesma regra de
  // `validarLinhasParaFinalizacaoMultiFornecedor`, reutilizada e nunca
  // reimplementada) — e isto corre para TODAS as farmácias primeiro,
  // para uma farmácia inválida nunca deixar OUTRA já criada para trás
  // (o cliente já faz a mesma verificação antes de chamar esta acção,
  // ver `handleGerarPlano`; isto é defesa em profundidade do lado do
  // servidor, nunca confia só na verificação do cliente).
  for (const [farmaciaId, linhasFarmacia] of porFarmacia) {
    const normalizadas = semFornecedorUndefined(linhasFarmacia);
    if (!deveUsarFinalizacaoMultiFornecedor(normalizadas)) continue;
    const validacao = validarLinhasParaFinalizacaoMultiFornecedor(normalizadas);
    if (!validacao.ok) {
      return { ok: false, error: `Farmácia ${farmaciaId}: ${validacao.error}` };
    }
  }

  const encomendaBatchKeyEfetivo = input.encomendaBatchKey ?? randomUUID();

  try {
    const resultadoListas: DocumentoEncomendaGrupoGerado[] = [];
    for (const [farmaciaId, linhas] of porFarmacia) {
      if (!deveUsarFinalizacaoMultiFornecedor(semFornecedorUndefined(linhas))) {
        // `finalize: true` directo — nunca um RASCUNHO intermédio que
        // obrigaria a reabrir a encomenda noutro ecrã para a finalizar
        // (o mesmo problema que a consolidação já tinha resolvido). O
        // "conceito de rascunho" continua a existir para o modo
        // "farmacia" (`ensureDraft` — autosave incremental linha a linha,
        // que aqui não se aplica: todas as linhas já vêm decididas de
        // uma vez), mas deixa de ser um passo obrigatório desta operação.
        const resultado = await createEncomendaWithOutbox(prisma, tenantSlug, {
          farmaciaId,
          criadoPorId: session.sub,
          nome: `${nomePrefixo} · encomendar`.slice(0, 180),
          finalize: true,
          linhas: linhas.map((l) => ({
            produtoId: l.produtoId,
            quantidadeSugerida: l.quantidadeSugerida ?? null,
            quantidadeAjustada: l.quantidadeFinal,
            fornecedorSugeridoId: l.fornecedorSugeridoId ?? null,
            notas: l.notas ?? null,
            origem: l.origem ?? "PROPOSTA",
          })),
          contexto: input.contexto ?? undefined,
        });
        resultadoListas.push({
          farmaciaId,
          listaEncomendaId: resultado.listaEncomendaId,
          nLinhas: linhas.length,
          numero: resultado.numero,
          fornecedorId: linhas[0]?.fornecedorSugeridoId ?? null,
        });
        await logAudit({
          actorId: session.sub,
          action: "group_plan.encomenda_created",
          entity: "ListaEncomenda",
          entityId: resultado.listaEncomendaId,
          meta: {
            mode: "grupo",
            farmaciaId,
            linhasCount: linhas.length,
            outboxId: resultado.outboxId,
            comContexto: input.contexto != null,
            multiFornecedor: false,
          },
        });
      } else {
        // Farmácia com linhas de mais de um fornecedor — reutiliza
        // `finalizarEncomendaMultiFornecedor` (o MESMO motor do fluxo
        // manual de `finalizar-multi-fornecedor.ts`), nunca uma segunda
        // implementação da divisão por fornecedor. Como o modo grupo não
        // tem noção de "rascunho editável", cria-se aqui um RASCUNHO
        // TRANSITÓRIO — nasce e é dividido na MESMA chamada síncrona ao
        // servidor, nunca devolvido ao cliente como algo editável — e
        // fica como registo do "lote" desta farmácia, exactamente como o
        // rascunho manual fica depois de dividido (loteDivididoEm
        // preenchido, nunca apagado). Ver o comentário sobre esta
        // decisão em `finalizar-multi-fornecedor-regras.ts`.
        const draftKey = deriveGrupoDraftIdempotencyKey(encomendaBatchKeyEfetivo, farmaciaId);
        const draft = await createEncomendaWithOutbox(
          prisma,
          tenantSlug,
          {
            farmaciaId,
            criadoPorId: session.sub,
            nome: `${nomePrefixo} · encomendar`.slice(0, 180),
            finalize: false,
            linhas: linhas.map((l) => ({
              produtoId: l.produtoId,
              quantidadeSugerida: l.quantidadeSugerida ?? null,
              quantidadeAjustada: l.quantidadeFinal,
              fornecedorSugeridoId: l.fornecedorSugeridoId ?? null,
              notas: l.notas ?? null,
              origem: l.origem ?? "PROPOSTA",
            })),
            contexto: input.contexto ?? undefined,
            clientIdempotencyKey: draftKey,
          },
          "grupo-multi-fornecedor"
        );
        const finBatchKey = deriveGrupoFinalizacaoBatchKey(encomendaBatchKeyEfetivo, farmaciaId);
        const divisao = await finalizarEncomendaMultiFornecedor(prisma, tenantSlug, {
          listaEncomendaId: draft.listaEncomendaId,
          batchKey: finBatchKey,
        });
        for (const doc of divisao.documentos) {
          resultadoListas.push({
            farmaciaId,
            listaEncomendaId: doc.listaEncomendaId,
            nLinhas: doc.nLinhas,
            numero: doc.numero,
            fornecedorId: doc.fornecedorId,
            fornecedorNome: doc.fornecedorNome,
          });
          await logAudit({
            actorId: session.sub,
            action: "group_plan.encomenda_created",
            entity: "ListaEncomenda",
            entityId: doc.listaEncomendaId,
            meta: {
              mode: "grupo",
              farmaciaId,
              linhasCount: doc.nLinhas,
              comContexto: input.contexto != null,
              multiFornecedor: true,
              fornecedorId: doc.fornecedorId,
              loteOrigemId: divisao.loteOrigemId,
            },
          });
        }
      }
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
      // `finalize: true` directo — antes desta revisão nascia em
      // RASCUNHO e NADA no código alguma vez a levava a FINALIZADA (uma
      // Transferencia gerada aqui ficava presa para sempre). Como esta
      // Transferencia nasce já com a decisão final do utilizador (Bloco
      // D), não há nenhum estado intermédio útil a preservar.
      const { transferenciaId } = await criarTransferenciaComLinhas(prisma, {
        farmaciaOrigemId,
        farmaciaDestinoId,
        criadoPorId: session.sub,
        finalize: true,
        linhas: linhas.map((l) => ({
          produtoId: l.produtoId,
          quantidade: l.quantidadeTransferir,
          notas: l.notas ?? null,
        })),
        clientIdempotencyKey: input.transferenciaBatchKey
          ? deriveDirectionIdempotencyKey(input.transferenciaBatchKey, farmaciaOrigemId, farmaciaDestinoId)
          : null,
      });
      resultadoTransferencias.push({
        farmaciaOrigemId,
        farmaciaDestinoId,
        transferenciaId,
        nLinhas: linhas.length,
      });
      await logAudit({
        actorId: session.sub,
        action: "group_plan.transferencia_created",
        entity: "Transferencia",
        entityId: transferenciaId,
        meta: { mode: "grupo", farmaciaOrigemId, farmaciaDestinoId, linhasCount: linhas.length },
      });
    }

    revalidatePath("/encomendas");
    revalidatePath("/configuracoes/integracao");

    return { ok: true, listasEncomenda: resultadoListas, transferencias: resultadoTransferencias };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido" };
  }
}

// ─── Documentos pós-finalização (Imprimir/PDF/Email) ───────────────────────
//
// Chamada UMA vez, logo a seguir a qualquer finalização bem sucedida
// (farmácia, grupo ou consolidação) para construir os `Report` que o
// ecrã de resultado mostra — reutiliza 100% a infra genérica de
// reporting (`components/reporting/report-actions.tsx` já sabe
// Imprimir/PDF/Email um `Report` qualquer). Nunca cria nem altera nada:
// só lê o que já foi persistido.

export type DocumentosFinalizacaoInput = {
  listaEncomendaIds: string[];
  transferenciaIds: string[];
  /**
   * Só tem efeito com >1 encomenda — constrói também o documento
   * "Encomenda Consolidada do Grupo" (ver decisão de arquitectura em
   * `lib/reporting/adapters/encomenda-consolidada-documento.ts`: é só
   * apresentação, nenhuma ListaEncomenda multi-farmácia é criada).
   */
  incluirConsolidado?: boolean;
};

export type DocumentosFinalizacaoResultado =
  | {
      ok: true;
      /**
       * `reports` tem sempre ≥1 entrada — uma por fornecedor da encomenda
       * (ver `buildEncomendaDocumentoReport`). O caso comum (um único
       * fornecedor) tem sempre exactamente 1.
       */
      encomendaIndividual: Array<{ listaEncomendaId: string; farmaciaNome: string; reports: Report[] }>;
      /** "Encomenda única do Grupo" — só quando pedido e há >1 encomenda. Uso interno (nunca vai ao fornecedor), por isso continua um único Report. */
      encomendaConsolidada?: Report;
      transferenciaIndividual: Array<{ transferenciaId: string; rota: string; report: Report }>;
      transferenciaTodas?: Report;
    }
  | { ok: false; error: string };

export async function buildDocumentosFinalizacaoAction(
  input: DocumentosFinalizacaoInput
): Promise<DocumentosFinalizacaoResultado> {
  const session = await requirePermission("reports.write");

  try {
    const detalhesEncomendas = (
      await Promise.all(input.listaEncomendaIds.map((id) => loadOrderDetail(id)))
    ).filter((d): d is NonNullable<typeof d> => !!d);
    for (const d of detalhesEncomendas) {
      if (!canAccessFarmaciaSync(session, d.farmaciaId)) {
        return { ok: false, error: "Sem acesso a uma das farmácias das encomendas." };
      }
    }

    const detalhesTransferencias = await loadTransferenciasDetail(input.transferenciaIds);
    for (const t of detalhesTransferencias) {
      if (
        !canAccessFarmaciaSync(session, t.farmaciaOrigemId) ||
        !canAccessFarmaciaSync(session, t.farmaciaDestinoId)
      ) {
        return { ok: false, error: "Sem acesso a uma das farmácias das transferências." };
      }
    }

    const encomendaIndividual = detalhesEncomendas.map((d) => ({
      listaEncomendaId: d.id,
      farmaciaNome: d.farmaciaNome,
      reports: buildEncomendaDocumentoReport([d]),
    }));
    const encomendaConsolidada =
      input.incluirConsolidado && detalhesEncomendas.length > 1
        ? buildEncomendaConsolidadaDocumentoReport(detalhesEncomendas)
        : undefined;

    const transferenciaIndividual = detalhesTransferencias.map((t) => ({
      transferenciaId: t.id,
      rota: `${t.farmaciaOrigemNome} → ${t.farmaciaDestinoNome}`,
      report: buildTransferenciaDocumentoReport([t]),
    }));
    const transferenciaTodas =
      detalhesTransferencias.length > 1 ? buildTransferenciaDocumentoReport(detalhesTransferencias) : undefined;

    return {
      ok: true,
      encomendaIndividual,
      encomendaConsolidada,
      transferenciaIndividual,
      transferenciaTodas,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido" };
  }
}
