import "server-only";
import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { OrigemLinha } from "@/lib/encomendas/origem-linha";

/**
 * lib/ingest/orders.ts
 *
 * ÚNICO caminho suportado para criar uma ListaEncomenda que deva ser
 * exportada para SPharm. Cria a lista + linhas + OrderOutbox na MESMA
 * transacção Prisma, garantindo que nunca existe uma ordem órfã do
 * seu envelope de exportação.
 *
 * Regra de revisão: `prisma.listaEncomenda.create(...)` directo está
 * PROIBIDO em qualquer server action ou server component. Grep por
 * esse padrão deve vir vazio fora deste ficheiro.
 *
 * Imutabilidade do payload:
 *   - o `payloadJson` é congelado no momento da criação
 *   - a edição de uma lista depois deste ponto é conceptualmente
 *     "cancelar + recriar", não "mutate". Um helper futuro para
 *     `updateOrderBeforeExport` pode mexer na ListaEncomenda mas
 *     não deve mexer no OrderOutbox — se o payload precisa de
 *     mudar, o outbox é cancelado e recriado.
 *
 * Idempotency key:
 *   determinística — `{tenantSlug}:{listaEncomendaId}`. O tenant slug
 *   é passado como argumento (quem chama sabe o tenant corrente via
 *   resolveCurrentTenantSlug + LEGACY_TENANT fallback).
 *
 * Payload hash:
 *   sha256 do payloadJson. Servida como defesa contra mutação acidental
 *   — se o mesmo idempotencyKey chegar a SPharm com hash diferente, o
 *   agent deve abortar e marcar FALHADO para triagem humana. Não deve
 *   acontecer por construção; fica como canário.
 */

export type OrderLineInput = {
  produtoId: string;
  quantidadeSugerida?: number | null;
  quantidadeAjustada?: number | null;
  fornecedorSugeridoId?: string | null;
  notas?: string | null;
  /**
   * De onde veio a linha. Omitida = `PROPOSTA`.
   *
   * O default é o mesmo da coluna, e pela mesma razão: até esta
   * revisão, o cálculo automático era o único caminho para criar uma
   * linha. Um chamador que não diga nada está a criar uma linha de
   * proposta — que é o que sempre esteve a fazer.
   */
  origem?: OrigemLinha;
};

export type CreateOrderInput = {
  farmaciaId: string;
  criadoPorId: string;
  nome: string;
  /** Se true, a lista é criada já em FINALIZADA e o outbox fica PENDENTE. */
  finalize: boolean;
  linhas: OrderLineInput[];
  /**
   * Contexto funcional da proposta que originou este rascunho (modo,
   * período, cobertura, filtros) — JSON já serializado pelo chamador.
   * Grava directo em `ListaEncomenda.contextoJson` na MESMA transacção
   * de criação; nenhum segundo write. Omitir = sem contexto registado.
   */
  contexto?: string | null;
  /**
   * Chave de idempotência do CLIENTE (ver `ListaEncomenda.clientIdempotencyKey`).
   * Se já existir uma lista com esta chave (retry após resposta perdida),
   * devolve-a em vez de criar outra.
   */
  clientIdempotencyKey?: string | null;
};

/**
 * Shape do payload congelado que o agent vai receber em /orders/pending.
 * Aumentar este tipo quando soubermos o schema real do SPharm — o que
 * aqui está é o mínimo útil para qualquer destino SPharm imaginável.
 */
export type FrozenOrderPayload = {
  version: 1;
  tenantSlug: string;
  listaEncomendaId: string;
  farmaciaId: string;
  nome: string;
  criadoPorId: string;
  criadoEm: string; // ISO
  linhas: Array<{
    produtoId: string;
    quantidadeSugerida: string | null; // stringified Decimal
    quantidadeAjustada: string | null;
    fornecedorSugeridoId: string | null;
    notas: string | null;
  }>;
};

function buildIdempotencyKey(tenantSlug: string, listaId: string): string {
  return `${tenantSlug}:${listaId}`;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Chave de idempotência já usada com outro pedido/utilizador/farmácia. Nunca finge sucesso. */
export class IdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_CONFLICT" as const;
  constructor(message: string) {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

export type OrderRequestFingerprintInput = {
  criadoPorId: string;
  farmaciaId: string;
  modo: string;
  finalize: boolean;
  nome: string;
  contexto: string | null | undefined;
  linhas: OrderLineInput[];
  /** Consolidação: as farmácias do lote, para o lote não poder mudar de composição sob a mesma chave. */
  loteFarmaciaIds?: string[];
};

/**
 * Impressão digital determinística (SHA-256 de uma serialização
 * canónica) do pedido relevante: utilizador, farmácia, modo, contexto
 * e linhas (ordenadas por produto) com quantidades, notas e origem.
 * Persistida em `ListaEncomenda.clientRequestHash` junto da chave.
 */
export function computeOrderRequestHash(p: OrderRequestFingerprintInput): string {
  const linhas = p.linhas
    .map((l) => ({
      produtoId: l.produtoId,
      sug: l.quantidadeSugerida ?? null,
      aj: l.quantidadeAjustada ?? null,
      forn: l.fornecedorSugeridoId ?? null,
      notas: (l.notas ?? "").trim() || null,
      origem: l.origem ?? "PROPOSTA",
    }))
    .sort((x, y) =>
      x.produtoId !== y.produtoId ? (x.produtoId < y.produtoId ? -1 : 1) : x.origem < y.origem ? -1 : x.origem > y.origem ? 1 : 0
    );
  const canon = JSON.stringify({
    v: 1,
    u: p.criadoPorId,
    f: p.farmaciaId,
    m: p.modo,
    fin: p.finalize,
    n: p.nome,
    c: p.contexto ?? null,
    l: linhas,
    lote: p.loteFarmaciaIds ? [...p.loteFarmaciaIds].sort() : null,
  });
  return sha256Hex(canon);
}

/** Chave por farmácia derivada, de forma estável, da chave do lote. */
export function deriveFarmaciaIdempotencyKey(batchKey: string, farmaciaId: string): string {
  return sha256Hex(`${batchKey}:${farmaciaId}`);
}

type Tx = Prisma.TransactionClient;

type ResultadoCriacao = { listaEncomendaId: string; outboxId: string | null; reutilizado: boolean };

/**
 * Cria lista + linhas (+ outbox se finalize) DENTRO de uma transacção
 * já aberta. Se a chave de cliente já existir: mesmo pedido (hash igual,
 * mesmo utilizador/farmácia) devolve o existente; qualquer outra coisa
 * lança `IdempotencyConflictError`.
 */
async function criarListaNaTransaccao(
  tx: Tx,
  tenantSlug: string,
  input: CreateOrderInput,
  modo: string,
  loteFarmaciaIds?: string[]
): Promise<ResultadoCriacao> {
  const chaveCliente = input.clientIdempotencyKey ?? null;
  const hash = chaveCliente
    ? computeOrderRequestHash({
        criadoPorId: input.criadoPorId,
        farmaciaId: input.farmaciaId,
        modo,
        finalize: input.finalize,
        nome: input.nome,
        contexto: input.contexto,
        linhas: input.linhas,
        loteFarmaciaIds,
      })
    : null;

  if (chaveCliente) {
    const existente = await tx.listaEncomenda.findUnique({
      where: { clientIdempotencyKey: chaveCliente },
      select: {
        id: true,
        farmaciaId: true,
        criadoPorId: true,
        clientRequestHash: true,
        outbox: { select: { id: true } },
      },
    });
    if (existente) {
      if (existente.farmaciaId !== input.farmaciaId || existente.criadoPorId !== input.criadoPorId) {
        throw new IdempotencyConflictError("Chave de idempotência já usada por outro utilizador ou farmácia.");
      }
      if (existente.clientRequestHash !== hash) {
        throw new IdempotencyConflictError(
          "Esta chave de idempotência já foi usada com um pedido diferente — o pedido actual não foi aplicado."
        );
      }
      return { listaEncomendaId: existente.id, outboxId: existente.outbox?.id ?? null, reutilizado: true };
    }
  }

  const lista = await tx.listaEncomenda.create({
    data: {
      farmaciaId: input.farmaciaId,
      criadoPorId: input.criadoPorId,
      nome: input.nome,
      estado: input.finalize ? "FINALIZADA" : "RASCUNHO",
      estadoExport: "PENDENTE",
      ...(input.contexto !== undefined ? { contextoJson: input.contexto } : {}),
      ...(chaveCliente ? { clientIdempotencyKey: chaveCliente, clientRequestHash: hash } : {}),
      linhas: {
        create: input.linhas.map((l) => ({
          produtoId: l.produtoId,
          quantidadeSugerida: l.quantidadeSugerida ?? null,
          quantidadeAjustada: l.quantidadeAjustada ?? null,
          fornecedorSugeridoId: l.fornecedorSugeridoId ?? null,
          notas: l.notas ?? null,
          origem: l.origem ?? "PROPOSTA",
        })),
      },
    },
    include: { linhas: true },
  });

  if (!input.finalize) {
    return { listaEncomendaId: lista.id, outboxId: null, reutilizado: false };
  }

  const payload: FrozenOrderPayload = {
    version: 1,
    tenantSlug,
    listaEncomendaId: lista.id,
    farmaciaId: lista.farmaciaId,
    nome: lista.nome,
    criadoPorId: lista.criadoPorId,
    criadoEm: lista.dataCriacao.toISOString(),
    linhas: lista.linhas.map((l) => ({
      produtoId: l.produtoId,
      quantidadeSugerida: l.quantidadeSugerida !== null ? l.quantidadeSugerida.toString() : null,
      quantidadeAjustada: l.quantidadeAjustada !== null ? l.quantidadeAjustada.toString() : null,
      fornecedorSugeridoId: l.fornecedorSugeridoId,
      notas: l.notas,
    })),
  };
  const payloadJson = JSON.stringify(payload);
  const payloadHash = sha256Hex(payloadJson);

  const outbox = await tx.orderOutbox.create({
    data: {
      listaEncomendaId: lista.id,
      farmaciaId: lista.farmaciaId,
      payloadJson,
      idempotencyKey: buildIdempotencyKey(tenantSlug, lista.id),
      payloadHash,
      state: "PENDENTE",
      attemptCount: 0,
      // nextAttemptAt default now() — elegível para o próximo poll.
    },
  });

  return { listaEncomendaId: lista.id, outboxId: outbox.id, reutilizado: false };
}

function exigirTenantELinhas(tenantSlug: string, nLinhas: number) {
  if (!tenantSlug || tenantSlug.length === 0) {
    throw new Error(
      "[ingest/orders] tenantSlug em falta — o outbox precisa do slug do tenant corrente para compor a idempotency key."
    );
  }
  if (nLinhas === 0) {
    throw new Error("[ingest/orders] lista sem linhas não é exportável.");
  }
}

/**
 * Executa `fn` numa transacção; se a corrida entre dois pedidos com a
 * MESMA chave rebentar no índice único (P2002 — que aborta a transacção
 * em Postgres), repete UMA vez: na 2.ª tentativa o vencedor já é visível
 * e é reutilizado (mesmo pedido) ou dá conflito (pedido diferente).
 */
async function transaccaoIdempotente<T>(prisma: PrismaClient, fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (let tentativa = 0; ; tentativa++) {
    try {
      return await prisma.$transaction(fn);
    } catch (err) {
      if (tentativa === 0 && (err as { code?: string })?.code === "P2002") continue;
      throw err;
    }
  }
}

/**
 * Cria uma ListaEncomenda com as suas linhas e, se `finalize=true`,
 * cria também a row OrderOutbox na mesma transacção.
 *
 * Retorna a lista criada e (se finalize) o outboxId correspondente.
 * Lança se a transacção falhar — caller decide o que fazer.
 * Com `clientIdempotencyKey`: retry do MESMO pedido devolve o resultado
 * existente; pedido diferente sob a mesma chave lança `IdempotencyConflictError`.
 */
export async function createEncomendaWithOutbox(
  prisma: PrismaClient,
  tenantSlug: string,
  input: CreateOrderInput,
  modo: string = "farmacia"
): Promise<{ listaEncomendaId: string; outboxId: string | null }> {
  exigirTenantELinhas(tenantSlug, input.linhas.length);
  const r = await transaccaoIdempotente(prisma, (tx) => criarListaNaTransaccao(tx, tenantSlug, input, modo));
  return { listaEncomendaId: r.listaEncomendaId, outboxId: r.outboxId };
}

export type ConsolidatedOrdersInput = {
  /** Chave do LOTE (gerada pelo cliente); a de cada farmácia deriva dela. */
  batchKey: string;
  criadoPorId: string;
  nome: string;
  finalize: boolean;
  contexto?: string | null;
  lotes: Array<{ farmaciaId: string; linhas: OrderLineInput[] }>;
};

/**
 * Consolidação: TODAS as encomendas (uma por farmácia) e os seus outbox
 * numa ÚNICA transacção. Uma falha em qualquer farmácia faz rollback do
 * lote inteiro — nunca fica um conjunto parcial criado por uma operação
 * nova. Retry do mesmo lote devolve o mesmo resultado; lote diferente
 * sob a mesma chave lança `IdempotencyConflictError` (e faz rollback).
 */
export async function createConsolidatedOrdersWithOutbox(
  prisma: PrismaClient,
  tenantSlug: string,
  input: ConsolidatedOrdersInput
): Promise<{
  reutilizado: boolean;
  listas: Array<{ farmaciaId: string; listaEncomendaId: string; outboxId: string | null }>;
}> {
  exigirTenantELinhas(tenantSlug, input.lotes.length);
  const ids = input.lotes.map((l) => l.farmaciaId);
  if (new Set(ids).size !== ids.length) throw new Error("[ingest/orders] farmácia repetida no lote.");
  for (const l of input.lotes) exigirTenantELinhas(tenantSlug, l.linhas.length);

  return transaccaoIdempotente(prisma, async (tx) => {
    const listas: Array<{ farmaciaId: string; listaEncomendaId: string; outboxId: string | null }> = [];
    let reutilizados = 0;
    for (const lote of input.lotes) {
      const r = await criarListaNaTransaccao(
        tx,
        tenantSlug,
        {
          farmaciaId: lote.farmaciaId,
          criadoPorId: input.criadoPorId,
          nome: input.nome,
          finalize: input.finalize,
          linhas: lote.linhas,
          contexto: input.contexto,
          clientIdempotencyKey: deriveFarmaciaIdempotencyKey(input.batchKey, lote.farmaciaId),
        },
        "consolidacao",
        ids
      );
      if (r.reutilizado) reutilizados++;
      listas.push({ farmaciaId: lote.farmaciaId, listaEncomendaId: r.listaEncomendaId, outboxId: r.outboxId });
    }
    // Lote misto (parte já existia, parte nova) nunca é aceite como sucesso:
    // seria um conjunto parcial de uma operação anterior.
    if (reutilizados !== 0 && reutilizados !== input.lotes.length) {
      throw new IdempotencyConflictError("Lote de consolidação parcialmente existente sob a mesma chave.");
    }
    return { reutilizado: reutilizados === input.lotes.length, listas };
  });
}

/**
 * Finaliza uma lista que já existe em RASCUNHO, criando o OrderOutbox
 * nesse momento. Usar quando o utilizador submete um rascunho
 * previamente guardado.
 *
 * Se a lista já estiver FINALIZADA (e portanto já ter outbox), esta
 * função é um no-op seguro — retorna o outboxId existente.
 */
export async function finalizeAndQueueOrder(
  prisma: PrismaClient,
  tenantSlug: string,
  listaEncomendaId: string,
  /**
   * Quando fornecida, a finalização só prossegue se a versão actual do
   * rascunho bater com esta — mesmo bloqueio optimista do autosave (ver
   * lib/encomendas/autosave.ts). Evita finalizar por cima de uma edição
   * concorrente que o cliente ainda não viu. Omitido = sem verificação
   * (compatibilidade com chamadores que não gerem versão).
   */
  versaoEsperada?: number
): Promise<{ outboxId: string }> {
  if (!tenantSlug) {
    throw new Error("[ingest/orders] tenantSlug em falta.");
  }

  return prisma.$transaction(async (tx) => {
    const lista = await tx.listaEncomenda.findUniqueOrThrow({
      where: { id: listaEncomendaId },
      include: { linhas: true, outbox: true },
    });

    if (lista.outbox) {
      // Já tem outbox. Se a lista já tinha sido finalizada antes, isto
      // é um replay idempotente; devolvemos o outbox existente.
      return { outboxId: lista.outbox.id };
    }

    if (versaoEsperada !== undefined && lista.versao !== versaoEsperada) {
      const { ConflitoVersaoError } = await import("@/lib/encomendas/autosave");
      throw new ConflitoVersaoError(lista.versao);
    }

    if (lista.linhas.length === 0) {
      throw new Error("[ingest/orders] lista sem linhas não é exportável.");
    }

    await tx.listaEncomenda.update({
      where: { id: lista.id },
      data: { estado: "FINALIZADA", estadoExport: "PENDENTE", versao: { increment: 1 } },
    });

    const payload: FrozenOrderPayload = {
      version: 1,
      tenantSlug,
      listaEncomendaId: lista.id,
      farmaciaId: lista.farmaciaId,
      nome: lista.nome,
      criadoPorId: lista.criadoPorId,
      criadoEm: lista.dataCriacao.toISOString(),
      linhas: lista.linhas.map((l) => ({
        produtoId: l.produtoId,
        quantidadeSugerida:
          l.quantidadeSugerida !== null ? l.quantidadeSugerida.toString() : null,
        quantidadeAjustada:
          l.quantidadeAjustada !== null ? l.quantidadeAjustada.toString() : null,
        fornecedorSugeridoId: l.fornecedorSugeridoId,
        notas: l.notas,
      })),
    };
    const payloadJson = JSON.stringify(payload);

    const outbox = await tx.orderOutbox.create({
      data: {
        listaEncomendaId: lista.id,
        farmaciaId: lista.farmaciaId,
        payloadJson,
        idempotencyKey: buildIdempotencyKey(tenantSlug, lista.id),
        payloadHash: sha256Hex(payloadJson),
        state: "PENDENTE",
        attemptCount: 0,
      },
    });

    return { outboxId: outbox.id };
  });
}
