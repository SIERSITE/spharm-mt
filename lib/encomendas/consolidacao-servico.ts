import "server-only";
/**
 * lib/encomendas/consolidacao-servico.ts
 *
 * Lógica de servidor da consolidação, com as dependências INJECTADAS
 * (prisma, tenant, sessão, auditoria) para ser testável sem sessão real:
 *
 *   · `criarConsolidacaoServico`          — valida e autoriza ANTES de qualquer
 *     escrita, depois cria o lote numa única transacção.
 *   · `obterEstadoConsolidacaoServico`    — leitura para reconciliar uma chave
 *     de idempotência cujo resultado o cliente não chegou a ver.
 *
 * Códigos de erro (`code`) — o cliente decide o que fazer com cada um:
 *   REJEITADO             falhou ANTES de escrever (validação/permissão):
 *                         definitivamente nada foi gravado.
 *   IDEMPOTENCY_CONFLICT  a chave já existe com outro pedido/utilizador.
 *   ERRO_SERVIDOR         qualquer outra falha — o resultado é DESCONHECIDO
 *                         para o cliente (pode ter havido commit).
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { canAccessFarmaciaSync } from "@/lib/permissions-core";
import type { SessionUser } from "@/lib/session-claims";
import {
  createConsolidatedOrdersWithOutbox,
  createEncomendaWithOutbox,
  deriveFarmaciaIdempotencyKey,
  IdempotencyConflictError,
  type OrderLineInput,
} from "@/lib/ingest/orders";
import { loadOrderDetailComPrisma, type OrderDetailLine } from "@/lib/encomendas/order-detail";
import {
  finalizarConsolidacaoMultiFornecedor,
  LinhasSemFornecedorError,
  type DocumentoConsolidacaoGerado,
} from "@/lib/encomendas/consolidacao-multi-fornecedor";
import { ConflitoVersaoError } from "@/lib/encomendas/autosave";
import { validarLinhasParaFinalizacaoMultiFornecedor } from "@/lib/encomendas/finalizar-multi-fornecedor-regras";

export const CHAVE_IDEMPOTENCIA_RE = /^[A-Za-z0-9_-]{16,80}$/;
/** Tecto do contexto serializado — igual ao das restantes actions de encomendas. */
export const CONTEXTO_MAX_CHARS = 20_000;

export type SessaoConsolidacao = Pick<SessionUser, "sub" | "perfil" | "farmaciaId"> & {
  /** Claim `tenant` da sessão — quando presente, TEM de bater com o tenant do pedido (`deps.tenantSlug`). */
  tenant?: string;
};

export type ConsolidacaoDeps = {
  prisma: PrismaClient;
  tenantSlug: string;
  sessao: SessaoConsolidacao;
  /** Auditoria pós-commit. Uma falha aqui NUNCA transforma um commit em erro. */
  auditar?: (evento: {
    action: string;
    entityId: string;
    meta: Record<string, unknown>;
  }) => Promise<void>;
};

export type CriarConsolidacaoInput = {
  batchKey: string;
  nome: string;
  finalize: boolean;
  contexto?: string | null;
  lotes: Array<{ farmaciaId: string; linhas: OrderLineInput[] }>;
};

export type ListaCriada = { farmaciaId: string; listaEncomendaId: string; outboxId: string | null };

export type CriarConsolidacaoResultado =
  | { ok: true; reutilizado: boolean; listas: ListaCriada[] }
  | { ok: false; error: string; code: "REJEITADO" | "IDEMPOTENCY_CONFLICT" | "ERRO_SERVIDOR" };

/**
 * Autorização por farmácia + perfil de grupo. Corre no servidor, antes de
 * qualquer escrita. Devolve a mensagem de recusa, ou `null` se autorizado.
 * A verificação por farmácia vem PRIMEIRO: um utilizador de farmácia que
 * inclua uma farmácia alheia é recusado pelo que fez, não só pelo perfil.
 */
export function autorizarConsolidacao(
  sessao: SessaoConsolidacao,
  farmaciaIds: readonly string[],
  tenantSlug?: string
): string | null {
  if (tenantSlug !== undefined && sessao.tenant !== undefined && sessao.tenant !== tenantSlug) {
    return "Consolidação não encontrada ou sem acesso.";
  }
  for (const id of farmaciaIds) {
    if (!canAccessFarmaciaSync(sessao as SessionUser, id)) {
      return "Sem acesso a uma das farmácias da consolidação.";
    }
  }
  if (sessao.perfil !== "ADMINISTRADOR" && sessao.perfil !== "GESTOR_GRUPO") {
    return "Sem permissão para vista de grupo.";
  }
  return null;
}

function validarEntrada(input: CriarConsolidacaoInput): string | null {
  if (!CHAVE_IDEMPOTENCIA_RE.test(input.batchKey ?? "")) return "Chave de idempotência inválida.";
  if (!input.nome?.trim()) return "Nome da encomenda em falta.";
  if (!Array.isArray(input.lotes) || input.lotes.length === 0) return "Sem farmácias na consolidação.";
  if (input.lotes.some((l) => !l.farmaciaId || !Array.isArray(l.linhas) || l.linhas.length === 0)) {
    return "Todas as farmácias da consolidação precisam de linhas.";
  }
  const ids = input.lotes.map((l) => l.farmaciaId);
  if (new Set(ids).size !== ids.length) return "Farmácia repetida na consolidação.";
  if (input.contexto != null && input.contexto.length > CONTEXTO_MAX_CHARS) {
    return "Contexto da proposta excede o tamanho máximo.";
  }
  return null;
}

export async function criarConsolidacaoServico(
  deps: ConsolidacaoDeps,
  input: CriarConsolidacaoInput
): Promise<CriarConsolidacaoResultado> {
  // 1. Validação e autorização — TUDO antes da transacção de escrita.
  const invalido = validarEntrada(input);
  if (invalido) return { ok: false, error: invalido, code: "REJEITADO" };
  const recusa = autorizarConsolidacao(deps.sessao, input.lotes.map((l) => l.farmaciaId), deps.tenantSlug);
  if (recusa) return { ok: false, error: recusa, code: "REJEITADO" };

  // 2. Escrita atómica.
  let r;
  try {
    r = await createConsolidatedOrdersWithOutbox(deps.prisma, deps.tenantSlug, {
      batchKey: input.batchKey,
      criadoPorId: deps.sessao.sub,
      nome: input.nome.slice(0, 180),
      finalize: input.finalize,
      contexto: input.contexto,
      lotes: input.lotes,
    });
  } catch (err) {
    if (err instanceof IdempotencyConflictError) {
      return { ok: false, error: err.message, code: "IDEMPOTENCY_CONFLICT" };
    }
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido", code: "ERRO_SERVIDOR" };
  }

  // 3. Auditoria pós-commit: uma falha aqui não pode devolver erro a quem
  //    já tem as listas criadas (o cliente tentaria de novo às cegas).
  if (!r.reutilizado && deps.auditar) {
    for (const l of r.listas) {
      try {
        await deps.auditar({
          action: input.finalize ? "order.created_and_finalized" : "order.created_draft",
          entityId: l.listaEncomendaId,
          meta: {
            mode: "consolidacao",
            finalize: input.finalize,
            farmaciaId: l.farmaciaId,
            lote: r.listas.length,
            outboxId: l.outboxId,
            comContexto: input.contexto != null,
          },
        });
      } catch {
        // deliberadamente ignorado — ver acima
      }
    }
  }
  return { ok: true, reutilizado: r.reutilizado, listas: r.listas };
}

// ─── Reconciliação por chave ─────────────────────────────────────────────

export type EstadoConsolidacaoServidor =
  | { ok: true; estado: "NAO_ENCONTRADA" }
  | {
      ok: true;
      estado: "CONCLUIDA";
      listas: Array<{ farmaciaId: string; listaEncomendaId: string; versao: number; estadoLista: string }>;
    }
  | { ok: true; estado: "INCONSISTENTE"; encontradas: number; esperadas: number }
  /** A chave existe mas pertence a outro utilizador/farmácia — nunca revela mais do que isto. */
  | { ok: true; estado: "CONFLITO" }
  | { ok: false; error: string; code: "REJEITADO" | "ERRO_SERVIDOR" };

/**
 * Lê o que existe no servidor para uma chave de lote. Só lê: nunca cria nem
 * altera nada. Mesma autorização da criação, e só devolve listas criadas
 * pelo PRÓPRIO utilizador nas farmácias pedidas (o `prisma` recebido já é o
 * do tenant corrente — outro tenant vive noutra base e nunca as encontra).
 */
export async function obterEstadoConsolidacaoServico(
  deps: Pick<ConsolidacaoDeps, "prisma" | "sessao" | "tenantSlug">,
  input: { batchKey: string; farmaciaIds: string[] }
): Promise<EstadoConsolidacaoServidor> {
  if (!CHAVE_IDEMPOTENCIA_RE.test(input.batchKey ?? "")) {
    return { ok: false, error: "Chave de idempotência inválida.", code: "REJEITADO" };
  }
  if (!Array.isArray(input.farmaciaIds) || input.farmaciaIds.length === 0) {
    return { ok: false, error: "Sem farmácias na consolidação.", code: "REJEITADO" };
  }
  if (new Set(input.farmaciaIds).size !== input.farmaciaIds.length) {
    return { ok: false, error: "Farmácia repetida na consolidação.", code: "REJEITADO" };
  }
  const recusa = autorizarConsolidacao(deps.sessao, input.farmaciaIds, deps.tenantSlug);
  if (recusa) return { ok: false, error: recusa, code: "REJEITADO" };

  try {
    const chaves = input.farmaciaIds.map((f) => deriveFarmaciaIdempotencyKey(input.batchKey, f));
    const listas = await deps.prisma.listaEncomenda.findMany({
      where: { clientIdempotencyKey: { in: chaves } },
      select: { id: true, farmaciaId: true, criadoPorId: true, versao: true, estado: true, clientIdempotencyKey: true },
    });
    if (listas.length === 0) return { ok: true, estado: "NAO_ENCONTRADA" };
    const alheias = listas.some(
      (l) => l.criadoPorId !== deps.sessao.sub || !input.farmaciaIds.includes(l.farmaciaId)
    );
    if (alheias) return { ok: true, estado: "CONFLITO" };
    if (listas.length !== input.farmaciaIds.length) {
      return { ok: true, estado: "INCONSISTENTE", encontradas: listas.length, esperadas: input.farmaciaIds.length };
    }
    return {
      ok: true,
      estado: "CONCLUIDA",
      listas: listas.map((l) => ({
        farmaciaId: l.farmaciaId,
        listaEncomendaId: l.id,
        versao: l.versao,
        estadoLista: l.estado,
      })),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido", code: "ERRO_SERVIDOR" };
  }
}

// ─── Fornecedor por linha: rascunho REAL por farmácia ───────────────────
//
// (2026-09-30) Ao contrário do lote atómico acima (uma única transacção
// com N `ListaEncomenda`, decidida de uma vez no fim), a consolidação com
// fornecedor por linha precisa de um rascunho REAL e persistente por
// farmácia — criado eagerly no primeiro toque significativo dessa
// farmácia, com autosave próprio (`useAutosaveEncomenda`, UMA instância
// por farmácia no cliente) — mesma disciplina do modo "farmacia"
// (`ensureDraft` em order-create-client.tsx). `deriveFarmaciaIdempotencyKey`
// é a MESMA função já usada pelo lote atómico: duas farmácias da mesma
// `batchKey` nunca colidem, e duas `batchKey` diferentes para a MESMA
// farmácia produzem sempre dois rascunhos independentes.
//
// A finalização por fornecedor (agrupa PRIMEIRO por farmácia, DEPOIS por
// fornecedor) vive em `lib/encomendas/consolidacao-multi-fornecedor.ts`
// (`finalizarConsolidacaoMultiFornecedor`) — chamada directamente pela
// action do servidor (`app/encomendas/nova/actions.ts`), não daqui: esta
// função só cria/obtém o rascunho de UMA farmácia, nunca decide sobre a
// consolidação inteira.

export type EnsureRascunhoConsolidacaoFarmaciaInput = {
  batchKey: string;
  farmaciaId: string;
  nome: string;
  linhas: OrderLineInput[];
  contexto?: string | null;
};

export type EnsureRascunhoConsolidacaoFarmaciaResultado =
  | { ok: true; listaEncomendaId: string; versao: number }
  | { ok: false; error: string; code: "REJEITADO" | "IDEMPOTENCY_CONFLICT" | "ERRO_SERVIDOR" };

/**
 * Cria (ou obtém, se já existir sob a mesma `batchKey`+farmácia) o
 * rascunho REAL dessa farmácia. Autorização e validação ANTES de
 * qualquer escrita — mesmo padrão de `criarConsolidacaoServico` acima,
 * só que para UMA farmácia de cada vez (o cliente chama isto
 * independentemente por farmácia, no primeiro toque significativo).
 */
export async function ensureRascunhoConsolidacaoFarmaciaServico(
  deps: ConsolidacaoDeps,
  input: EnsureRascunhoConsolidacaoFarmaciaInput
): Promise<EnsureRascunhoConsolidacaoFarmaciaResultado> {
  if (!CHAVE_IDEMPOTENCIA_RE.test(input.batchKey ?? "")) {
    return { ok: false, error: "Chave de idempotência inválida.", code: "REJEITADO" };
  }
  if (!input.farmaciaId) return { ok: false, error: "Farmácia em falta.", code: "REJEITADO" };
  if (!input.nome?.trim()) return { ok: false, error: "Nome da encomenda em falta.", code: "REJEITADO" };
  if (!Array.isArray(input.linhas) || input.linhas.length === 0) {
    return { ok: false, error: "Sem linhas para gravar.", code: "REJEITADO" };
  }
  if (input.contexto != null && input.contexto.length > CONTEXTO_MAX_CHARS) {
    return { ok: false, error: "Contexto da proposta excede o tamanho máximo.", code: "REJEITADO" };
  }
  const recusa = autorizarConsolidacao(deps.sessao, [input.farmaciaId], deps.tenantSlug);
  if (recusa) return { ok: false, error: recusa, code: "REJEITADO" };

  try {
    const r = await createEncomendaWithOutbox(
      deps.prisma,
      deps.tenantSlug,
      {
        farmaciaId: input.farmaciaId,
        criadoPorId: deps.sessao.sub,
        nome: input.nome.slice(0, 180),
        finalize: false,
        linhas: input.linhas,
        contexto: input.contexto,
        clientIdempotencyKey: deriveFarmaciaIdempotencyKey(input.batchKey, input.farmaciaId),
      },
      "consolidacao"
    );
    const actual = await deps.prisma.listaEncomenda.findUniqueOrThrow({
      where: { id: r.listaEncomendaId },
      select: { versao: true },
    });
    if (deps.auditar) {
      try {
        await deps.auditar({
          action: "order.created_draft",
          entityId: r.listaEncomendaId,
          meta: { mode: "consolidacao", farmaciaId: input.farmaciaId, linhasCount: input.linhas.length },
        });
      } catch {
        // deliberadamente ignorado — auditoria pós-commit nunca transforma sucesso em erro
      }
    }
    return { ok: true, listaEncomendaId: r.listaEncomendaId, versao: actual.versao };
  } catch (err) {
    if (err instanceof IdempotencyConflictError) {
      return { ok: false, error: err.message, code: "IDEMPOTENCY_CONFLICT" };
    }
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido", code: "ERRO_SERVIDOR" };
  }
}

// ─── Recuperação: conteúdo COMPLETO dos rascunhos de uma consolidação ──

export type RascunhoConsolidacaoFarmaciaConteudo = {
  farmaciaId: string;
  listaEncomendaId: string;
  versao: number;
  nome: string;
  linhas: OrderDetailLine[];
};

export type ObterRascunhosConsolidacaoResultado =
  | { ok: true; porFarmacia: Array<{ farmaciaId: string; draft: RascunhoConsolidacaoFarmaciaConteudo | null }> }
  | { ok: false; error: string; code: "REJEITADO" | "ERRO_SERVIDOR" };

/**
 * Recuperação de um `batchKey` de consolidação: para CADA farmácia
 * pedida, devolve o conteúdo COMPLETO do seu rascunho (produto,
 * quantidade, fornecedor DECIDIDO — nunca recalculado — notas, origem),
 * ou `null` se essa farmácia ainda não tem rascunho (nunca foi tocada
 * nesta sessão de consolidação). Usa o MESMO carregador do ecrã de
 * detalhe (`loadOrderDetailComPrisma`) — nunca uma segunda query a
 * reconstruir a mesma coisa.
 *
 * Um rascunho encontrado que pertença a OUTRO utilizador (a mesma
 * `batchKey`+farmácia coincidir, por azar ou má-fé, com um pedido
 * alheio) é tratado como "sem rascunho" para este utilizador — nunca
 * expõe conteúdo alheio; uma tentativa subsequente de criar um rascunho
 * aí resolve-se, em segurança, como `IDEMPOTENCY_CONFLICT` em
 * `ensureRascunhoConsolidacaoFarmaciaServico` (mesma protecção de
 * `criarListaNaTransaccao`).
 */
export async function obterRascunhosConsolidacaoServico(
  deps: Pick<ConsolidacaoDeps, "prisma" | "sessao" | "tenantSlug">,
  input: { batchKey: string; farmaciaIds: string[] }
): Promise<ObterRascunhosConsolidacaoResultado> {
  if (!CHAVE_IDEMPOTENCIA_RE.test(input.batchKey ?? "")) {
    return { ok: false, error: "Chave de idempotência inválida.", code: "REJEITADO" };
  }
  if (!Array.isArray(input.farmaciaIds) || input.farmaciaIds.length === 0) {
    return { ok: false, error: "Sem farmácias na consolidação.", code: "REJEITADO" };
  }
  if (new Set(input.farmaciaIds).size !== input.farmaciaIds.length) {
    return { ok: false, error: "Farmácia repetida na consolidação.", code: "REJEITADO" };
  }
  const recusa = autorizarConsolidacao(deps.sessao, input.farmaciaIds, deps.tenantSlug);
  if (recusa) return { ok: false, error: recusa, code: "REJEITADO" };

  try {
    const chavePorFarmacia = new Map(input.farmaciaIds.map((f) => [deriveFarmaciaIdempotencyKey(input.batchKey, f), f]));
    const listas = await deps.prisma.listaEncomenda.findMany({
      where: { clientIdempotencyKey: { in: [...chavePorFarmacia.keys()] } },
      select: { id: true, farmaciaId: true, criadoPorId: true, clientIdempotencyKey: true },
    });

    const porFarmaciaMap = new Map<string, RascunhoConsolidacaoFarmaciaConteudo | null>(
      input.farmaciaIds.map((f) => [f, null])
    );
    for (const lista of listas) {
      const farmaciaEsperada = chavePorFarmacia.get(lista.clientIdempotencyKey ?? "");
      // Nunca deveria divergir (a chave já é derivada da farmácia), mas
      // uma corrupção/colisão nunca deve expor o rascunho na farmácia
      // errada — pula-o em vez de confiar cegamente na chave.
      if (!farmaciaEsperada || farmaciaEsperada !== lista.farmaciaId) continue;
      // Rascunho de outro utilizador sob a mesma chave derivada: nunca
      // expõe o conteúdo — ver comentário da função.
      if (lista.criadoPorId !== deps.sessao.sub) continue;
      const detalhe = await loadOrderDetailComPrisma(deps.prisma, lista.id);
      if (!detalhe) continue;
      porFarmaciaMap.set(lista.farmaciaId, {
        farmaciaId: lista.farmaciaId,
        listaEncomendaId: detalhe.id,
        versao: detalhe.versao,
        nome: detalhe.nome,
        linhas: detalhe.linhas,
      });
    }

    return {
      ok: true,
      porFarmacia: input.farmaciaIds.map((farmaciaId) => ({ farmaciaId, draft: porFarmaciaMap.get(farmaciaId) ?? null })),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido", code: "ERRO_SERVIDOR" };
  }
}

// ─── Finalização: autorização + bloqueio optimista centralizados ───────
//
// (2026-10-01) Toda a decisão "este utilizador pode finalizar ESTA
// consolidação?" vive aqui — a Server Action é só um invólucro fino
// (sessão/prisma/tenant reais → este serviço). Uma `batchKey` NUNCA é, por
// si, autorização: o rascunho de cada farmácia só é localizado/lido se
// pertencer ao utilizador da sessão E a farmácia estiver ao seu alcance,
// e a recusa é sempre uma mensagem genérica — sem ids, sem detalhes, sem
// distinguir "não existe" de "é de outro".

export type FinalizarConsolidacaoServicoInput = {
  batchKey: string;
  farmaciaIds: string[];
  /** Versão que o cliente tem de CADA rascunho — omitida para uma farmácia = sem verificação para ela. */
  versaoEsperadaPorFarmacia?: Record<string, number>;
};

export type FinalizarConsolidacaoServicoResultado =
  | {
      ok: true;
      reutilizado: boolean;
      porFarmacia: Array<{ farmaciaId: string; loteOrigemId: string; documentos: DocumentoConsolidacaoGerado[] }>;
      documentos: DocumentoConsolidacaoGerado[];
      resumoTexto: string;
    }
  | {
      ok: false;
      error: string;
      code: "REJEITADO" | "IDEMPOTENCY_CONFLICT" | "CONFLITO_VERSAO" | "SEM_FORNECEDOR" | "ERRO_SERVIDOR";
      /** Farmácia em conflito de versão / com linhas sem fornecedor, quando conhecida. */
      farmaciaId?: string;
      versaoAtual?: number;
      produtoIdsSemFornecedor?: string[];
    };

const MSG_CONSOLIDACAO_INDISPONIVEL = "Consolidação não encontrada ou sem acesso.";

export async function finalizarConsolidacaoServico(
  deps: ConsolidacaoDeps,
  input: FinalizarConsolidacaoServicoInput
): Promise<FinalizarConsolidacaoServicoResultado> {
  // 1. Forma do pedido e autorização — antes de QUALQUER leitura de rascunhos.
  if (!CHAVE_IDEMPOTENCIA_RE.test(input.batchKey ?? "")) {
    return { ok: false, error: "Chave de idempotência inválida.", code: "REJEITADO" };
  }
  if (!Array.isArray(input.farmaciaIds) || input.farmaciaIds.length === 0) {
    return { ok: false, error: "Sem farmácias na consolidação.", code: "REJEITADO" };
  }
  if (new Set(input.farmaciaIds).size !== input.farmaciaIds.length) {
    return { ok: false, error: "Farmácia repetida na consolidação.", code: "REJEITADO" };
  }
  const recusa = autorizarConsolidacao(deps.sessao, input.farmaciaIds, deps.tenantSlug);
  if (recusa) return { ok: false, error: recusa, code: "REJEITADO" };

  try {
    // 2. Só rascunhos PRÓPRIOS (criador = sessão) das farmácias pedidas — o
    //    filtro está na própria query: um rascunho alheio nunca é lido.
    const chavePorFarmacia = new Map(input.farmaciaIds.map((f) => [deriveFarmaciaIdempotencyKey(input.batchKey, f), f]));
    const listas = await deps.prisma.listaEncomenda.findMany({
      where: {
        clientIdempotencyKey: { in: [...chavePorFarmacia.keys()] },
        criadoPorId: deps.sessao.sub,
        farmaciaId: { in: input.farmaciaIds },
      },
      select: {
        farmaciaId: true,
        clientIdempotencyKey: true,
        versao: true,
        loteDivididoEm: true,
        linhas: { select: { produtoId: true, fornecedorSugeridoId: true } },
      },
    });
    const porFarmacia = new Map<string, (typeof listas)[number]>();
    for (const l of listas) {
      if (chavePorFarmacia.get(l.clientIdempotencyKey ?? "") === l.farmaciaId) porFarmacia.set(l.farmaciaId, l);
    }
    if (input.farmaciaIds.some((f) => !porFarmacia.has(f))) {
      return { ok: false, error: MSG_CONSOLIDACAO_INDISPONIVEL, code: "REJEITADO" };
    }

    // 3. Pré-validação amigável (identifica a farmácia). Um rascunho já
    //    dividido é um replay idempotente — o motor devolve os documentos
    //    existentes, por isso nem versão nem fornecedores se reavaliam.
    for (const farmaciaId of input.farmaciaIds) {
      const lista = porFarmacia.get(farmaciaId)!;
      if (lista.loteDivididoEm !== null) continue;
      const esperada = input.versaoEsperadaPorFarmacia?.[farmaciaId];
      if (esperada !== undefined && esperada !== lista.versao) {
        return {
          ok: false,
          error: "Esta farmácia foi alterada noutra sessão — recarrega-a antes de finalizar.",
          code: "CONFLITO_VERSAO",
          farmaciaId,
          versaoAtual: lista.versao,
        };
      }
    }
    for (const farmaciaId of input.farmaciaIds) {
      const lista = porFarmacia.get(farmaciaId)!;
      if (lista.loteDivididoEm !== null) continue;
      const validacao = validarLinhasParaFinalizacaoMultiFornecedor(lista.linhas);
      if (!validacao.ok) {
        return {
          ok: false,
          error: validacao.error,
          code: "SEM_FORNECEDOR",
          farmaciaId,
          produtoIdsSemFornecedor: validacao.produtoIdsSemFornecedor,
        };
      }
    }

    // 4. A validação REAL e a escrita: dentro da transacção do motor.
    const resultado = await finalizarConsolidacaoMultiFornecedor(deps.prisma, deps.tenantSlug, {
      batchKey: input.batchKey,
      farmaciaIds: input.farmaciaIds,
      versaoEsperadaPorFarmacia: input.versaoEsperadaPorFarmacia
        ? new Map(Object.entries(input.versaoEsperadaPorFarmacia))
        : undefined,
    });

    if (!resultado.reutilizado && deps.auditar) {
      for (const doc of resultado.documentos) {
        try {
          await deps.auditar({
            action: "order.finalized_multi_fornecedor",
            entityId: doc.listaEncomendaId,
            meta: { mode: "consolidacao", farmaciaId: doc.farmaciaId, fornecedorId: doc.fornecedorId, nLinhas: doc.nLinhas },
          });
        } catch {
          // deliberadamente ignorado — auditoria pós-commit nunca transforma sucesso em erro
        }
      }
    }
    return {
      ok: true,
      reutilizado: resultado.reutilizado,
      porFarmacia: resultado.porFarmacia,
      documentos: resultado.documentos,
      resumoTexto: resultado.resumoTexto,
    };
  } catch (err) {
    if (err instanceof LinhasSemFornecedorError) {
      return { ok: false, error: err.message, code: "SEM_FORNECEDOR", produtoIdsSemFornecedor: err.produtoIdsSemFornecedor };
    }
    if (err instanceof ConflitoVersaoError) {
      return { ok: false, error: err.message, code: "CONFLITO_VERSAO", versaoAtual: err.versaoAtual };
    }
    if (err instanceof IdempotencyConflictError) {
      return { ok: false, error: err.message, code: "IDEMPOTENCY_CONFLICT" };
    }
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido", code: "ERRO_SERVIDOR" };
  }
}
