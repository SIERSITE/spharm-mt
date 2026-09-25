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
  deriveFarmaciaIdempotencyKey,
  IdempotencyConflictError,
  type OrderLineInput,
} from "@/lib/ingest/orders";

export const CHAVE_IDEMPOTENCIA_RE = /^[A-Za-z0-9_-]{16,80}$/;
/** Tecto do contexto serializado — igual ao das restantes actions de encomendas. */
export const CONTEXTO_MAX_CHARS = 20_000;

export type SessaoConsolidacao = Pick<SessionUser, "sub" | "perfil" | "farmaciaId">;

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
export function autorizarConsolidacao(sessao: SessaoConsolidacao, farmaciaIds: readonly string[]): string | null {
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
  const recusa = autorizarConsolidacao(deps.sessao, input.lotes.map((l) => l.farmaciaId));
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
  deps: Pick<ConsolidacaoDeps, "prisma" | "sessao">,
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
  const recusa = autorizarConsolidacao(deps.sessao, input.farmaciaIds);
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
