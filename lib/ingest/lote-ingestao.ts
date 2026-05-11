/**
 * lib/ingest/lote-ingestao.ts
 *
 * Helpers para o ledger `LoteIngestao` — uma row por ficheiro ingerido.
 *
 * Responsabilidades:
 *   · Idempotência: cada combinação (farmaciaId, tipo, hashConteudo)
 *     identifica um ficheiro único. Re-upload do mesmo ficheiro é
 *     detectado e skipped antes de tocar nas tabelas de dados.
 *   · Audit trail: estado RECEBIDO → EM_PROCESSAMENTO → PROCESSADO/FALHOU
 *     com contagens e mensagens de erro.
 *   · Retry-friendly: lotes FALHOU não bloqueiam reupload (caller decide
 *     se quer permitir; por defeito, sim).
 *
 * Não cria modelos novos — usa o `LoteIngestao` já existente no schema.
 *
 * Pure server-side (depende de PrismaClient injectado). Não puxa o
 * legacy singleton — funciona em /api/ingest/v1/* com cliente tenant.
 */

import { createHash } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import type { LoteIngestao, TipoLoteIngestao } from "@/generated/prisma/client";

/** Calcula hash sha256 hex de um Buffer/Uint8Array. */
export function hashFileContent(content: Uint8Array | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export type StartLoteInput = {
  farmaciaId: string;
  tipo: TipoLoteIngestao;
  dataReferencia: Date;
  nomeFicheiro: string | null;
  hashConteudo: string;
  /** Quando true, lotes anteriores FALHOU com mesmo hash são ignorados
   *  na dedup (default true). Lotes PROCESSADO bloqueiam sempre. */
  allowRetryOnFailed?: boolean;
};

export type StartLoteOutcome =
  | { kind: "started"; lote: LoteIngestao }
  | { kind: "skipped_duplicate"; existing: LoteIngestao };

/**
 * Inicia (ou reaproveita) um Lote para o ficheiro indicado.
 *
 * Algoritmo:
 *   1. Procurar lote PROCESSADO com mesmo (farmaciaId, tipo, hash).
 *      Se existe → devolver `skipped_duplicate`.
 *   2. Procurar lote EM_PROCESSAMENTO com mesmo hash mas > 1h velho —
 *      considerar abandonado e marcar FALHOU para libertar a chave.
 *      (Fora do scope MVP; assumimos sem races concorrentes.)
 *   3. Caso contrário → criar novo lote em RECEBIDO.
 *
 * Idempotência: a unicidade efectiva é (farmaciaId, tipo, hash) +
 * estado PROCESSADO. Sem index único na BD — o detector aqui faz o
 * trabalho. Decisão consciente: permitir múltiplos lotes FALHOU para
 * o mesmo ficheiro (audit de tentativas) sem custo adicional.
 */
export async function startLote(
  prisma: PrismaClient,
  input: StartLoteInput,
): Promise<StartLoteOutcome> {
  const existing = await prisma.loteIngestao.findFirst({
    where: {
      farmaciaId: input.farmaciaId,
      tipo: input.tipo,
      hashConteudo: input.hashConteudo,
      estado: "PROCESSADO",
    },
    orderBy: { dataProcessamento: "desc" },
  });
  if (existing) return { kind: "skipped_duplicate", existing };

  const lote = await prisma.loteIngestao.create({
    data: {
      farmaciaId: input.farmaciaId,
      tipo: input.tipo,
      dataReferencia: input.dataReferencia,
      nomeFicheiro: input.nomeFicheiro,
      hashConteudo: input.hashConteudo,
      estado: "RECEBIDO",
    },
  });
  return { kind: "started", lote };
}

/** Marca lote como EM_PROCESSAMENTO. Chamado antes de tocar nos dados. */
export async function markLoteProcessing(prisma: PrismaClient, loteId: string): Promise<void> {
  await prisma.loteIngestao.update({
    where: { id: loteId },
    data: { estado: "EM_PROCESSAMENTO" },
  });
}

export type CompleteLoteCounts = {
  totalRegistos: number;
  totalAceites: number;
  totalRejeitados: number;
};

/** Marca lote como PROCESSADO + contagens + dataProcessamento. */
export async function completeLote(
  prisma: PrismaClient,
  loteId: string,
  counts: CompleteLoteCounts,
): Promise<void> {
  await prisma.loteIngestao.update({
    where: { id: loteId },
    data: {
      estado: "PROCESSADO",
      dataProcessamento: new Date(),
      totalRegistos: counts.totalRegistos,
      totalAceites: counts.totalAceites,
      totalRejeitados: counts.totalRejeitados,
    },
  });
}

/** Marca lote como FALHOU com mensagem de erro truncada (500 chars). */
export async function failLote(
  prisma: PrismaClient,
  loteId: string,
  error: unknown,
): Promise<void> {
  const msg = error instanceof Error ? error.message : String(error);
  await prisma.loteIngestao.update({
    where: { id: loteId },
    data: {
      estado: "FALHOU",
      mensagemErro: msg.slice(0, 500),
      dataProcessamento: new Date(),
    },
  });
}

/**
 * Procura lote PROCESSADO por hash. Útil para detectar duplicados
 * antes de qualquer call ao importer (poupa parse Excel).
 */
export async function findProcessedLoteByHash(
  prisma: PrismaClient,
  farmaciaId: string,
  tipo: TipoLoteIngestao,
  hashConteudo: string,
): Promise<LoteIngestao | null> {
  return prisma.loteIngestao.findFirst({
    where: {
      farmaciaId,
      tipo,
      hashConteudo,
      estado: "PROCESSADO",
    },
    orderBy: { dataProcessamento: "desc" },
  });
}
