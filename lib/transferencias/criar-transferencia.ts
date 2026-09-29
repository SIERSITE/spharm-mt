import "server-only";
import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { proximoNumeroDocumento } from "@/lib/documentos/numeracao";

/**
 * lib/transferencias/criar-transferencia.ts
 *
 * ÚNICO caminho suportado para criar uma `Transferencia` com as suas
 * `LinhaTransferencia` — mesma disciplina que `lib/ingest/orders.ts` já
 * aplica a `ListaEncomenda`: idempotência opcional por
 * `clientIdempotencyKey` (um clique repetido ou um retry após resposta
 * perdida com a MESMA chave devolve a transferência já criada em vez de
 * duplicar; a mesma chave com um pedido DIFERENTE lança
 * `IdempotencyConflictError` em vez de fingir sucesso), e captura de
 * `designacaoSnapshot` por linha no momento da criação (ver comentário
 * no modelo `LinhaTransferencia`).
 */

export type CreateTransferLineInput = {
  produtoId: string;
  quantidade: number;
  notas?: string | null;
};

export type CreateTransferInput = {
  farmaciaOrigemId: string;
  farmaciaDestinoId: string;
  criadoPorId: string;
  /** true = nasce já FINALIZADA (com número e data de finalização); false = RASCUNHO. */
  finalize: boolean;
  linhas: CreateTransferLineInput[];
  /**
   * Chave de idempotência gerada pelo CLIENTE (ver
   * `Transferencia.clientIdempotencyKey`). Se já existir uma
   * transferência com esta chave, devolve-a em vez de criar outra —
   * desde que seja o MESMO pedido (mesmo hash); caso contrário lança
   * `IdempotencyConflictError`.
   */
  clientIdempotencyKey?: string | null;
};

/** Chave de idempotência já usada com outro pedido/utilizador/par de farmácias. Nunca finge sucesso. */
export class IdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_CONFLICT" as const;
  constructor(message: string) {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

type Tx = Prisma.TransactionClient;

export type TransferRequestFingerprintInput = {
  criadoPorId: string;
  farmaciaOrigemId: string;
  farmaciaDestinoId: string;
  finalize: boolean;
  linhas: CreateTransferLineInput[];
};

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Impressão digital determinística (SHA-256) do pedido relevante:
 * utilizador, origem, destino e linhas (ordenadas por produto) com
 * quantidade e notas. Persistida em `Transferencia.clientRequestHash`
 * junto da chave, para detectar um pedido diferente reutilizando a
 * mesma chave por engano.
 */
export function computeTransferRequestHash(p: TransferRequestFingerprintInput): string {
  const linhas = p.linhas
    .map((l) => ({ produtoId: l.produtoId, q: l.quantidade, notas: (l.notas ?? "").trim() || null }))
    .sort((a, b) => (a.produtoId < b.produtoId ? -1 : a.produtoId > b.produtoId ? 1 : 0));
  const canon = JSON.stringify({
    v: 1,
    u: p.criadoPorId,
    fo: p.farmaciaOrigemId,
    fd: p.farmaciaDestinoId,
    fin: p.finalize,
    l: linhas,
  });
  return sha256Hex(canon);
}

type ResultadoCriacao = { transferenciaId: string; numero: string | null; reutilizado: boolean };

async function criarTransferenciaNaTransaccao(tx: Tx, input: CreateTransferInput): Promise<ResultadoCriacao> {
  const chaveCliente = input.clientIdempotencyKey ?? null;
  const hash = chaveCliente
    ? computeTransferRequestHash({
        criadoPorId: input.criadoPorId,
        farmaciaOrigemId: input.farmaciaOrigemId,
        farmaciaDestinoId: input.farmaciaDestinoId,
        finalize: input.finalize,
        linhas: input.linhas,
      })
    : null;

  if (chaveCliente) {
    const existente = await tx.transferencia.findUnique({
      where: { clientIdempotencyKey: chaveCliente },
      select: {
        id: true,
        numero: true,
        farmaciaOrigemId: true,
        farmaciaDestinoId: true,
        criadoPorId: true,
        clientRequestHash: true,
      },
    });
    if (existente) {
      if (
        existente.farmaciaOrigemId !== input.farmaciaOrigemId ||
        existente.farmaciaDestinoId !== input.farmaciaDestinoId ||
        existente.criadoPorId !== input.criadoPorId
      ) {
        throw new IdempotencyConflictError("Chave de idempotência já usada por outro utilizador ou par de farmácias.");
      }
      if (existente.clientRequestHash !== hash) {
        throw new IdempotencyConflictError(
          "Esta chave de idempotência já foi usada com um pedido diferente — o pedido actual não foi aplicado."
        );
      }
      return { transferenciaId: existente.id, numero: existente.numero, reutilizado: true };
    }
  }

  const produtos = await tx.produto.findMany({
    where: { id: { in: input.linhas.map((l) => l.produtoId) } },
    select: { id: true, designacao: true },
  });
  const designacaoPorProduto = new Map(produtos.map((p) => [p.id, p.designacao]));

  const numero = input.finalize ? await proximoNumeroDocumento(tx, "TRF") : null;

  const transferencia = await tx.transferencia.create({
    data: {
      farmaciaOrigemId: input.farmaciaOrigemId,
      farmaciaDestinoId: input.farmaciaDestinoId,
      criadoPorId: input.criadoPorId,
      estado: input.finalize ? "FINALIZADA" : "RASCUNHO",
      dataFinalizacao: input.finalize ? new Date() : null,
      numero,
      ...(chaveCliente ? { clientIdempotencyKey: chaveCliente, clientRequestHash: hash } : {}),
      linhas: {
        create: input.linhas.map((l) => ({
          produtoId: l.produtoId,
          quantidade: l.quantidade,
          notas: l.notas ?? null,
          designacaoSnapshot: designacaoPorProduto.get(l.produtoId) ?? null,
        })),
      },
    },
  });

  return { transferenciaId: transferencia.id, numero: transferencia.numero, reutilizado: false };
}

/**
 * Repete `fn` UMA vez se a corrida entre dois pedidos com a MESMA chave
 * rebentar no índice único (P2002 — que aborta a transacção em
 * Postgres): na 2.ª tentativa o vencedor já é visível e é reutilizado
 * (mesmo pedido) ou dá conflito (pedido diferente).
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

/** Chave por direcção (origem→destino) derivada, de forma estável, da chave do lote de grupo. */
export function deriveDirectionIdempotencyKey(batchKey: string, farmaciaOrigemId: string, farmaciaDestinoId: string): string {
  return sha256Hex(`${batchKey}:${farmaciaOrigemId}:${farmaciaDestinoId}`);
}

function exigirLinhas(n: number) {
  if (n === 0) throw new Error("[transferencias/criar-transferencia] transferência sem linhas não é válida.");
}

export async function criarTransferenciaComLinhas(
  prisma: PrismaClient,
  input: CreateTransferInput
): Promise<{ transferenciaId: string; numero: string | null }> {
  exigirLinhas(input.linhas.length);
  const r = await transaccaoIdempotente(prisma, (tx) => criarTransferenciaNaTransaccao(tx, input));
  return { transferenciaId: r.transferenciaId, numero: r.numero };
}

/**
 * Finaliza uma Transferencia existente em RASCUNHO: atribui número e
 * data de finalização. No-op seguro (devolve o número já atribuído) se
 * já estiver FINALIZADA — nunca lança nem atribui um 2.º número.
 */
export async function finalizarTransferencia(
  prisma: PrismaClient,
  transferenciaId: string
): Promise<{ numero: string | null }> {
  return prisma.$transaction(async (tx) => {
    const actual = await tx.transferencia.findUniqueOrThrow({
      where: { id: transferenciaId },
      select: { estado: true, numero: true },
    });
    if (actual.estado === "FINALIZADA") return { numero: actual.numero };
    if (actual.estado !== "RASCUNHO") {
      throw new Error(`[transferencias/criar-transferencia] não é possível finalizar uma transferência ${actual.estado}.`);
    }
    const numero = await proximoNumeroDocumento(tx, "TRF");
    await tx.transferencia.update({
      where: { id: transferenciaId },
      data: { estado: "FINALIZADA", dataFinalizacao: new Date(), numero },
    });
    return { numero };
  });
}
