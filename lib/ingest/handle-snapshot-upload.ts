/**
 * lib/ingest/handle-snapshot-upload.ts
 *
 * Pipeline partilhado pelos endpoints `/api/ingest/v1/snapshot/*`.
 *
 * Recebe um multipart form-data com `file` (Excel) + `farmaciaId` (id
 * dentro da BD do tenant), executa:
 *
 *   1. Parse do form-data + validação básica
 *   2. Hash sha256 do conteúdo (idempotência)
 *   3. `startLote` — dedup por (farmaciaId, tipo, hash). Se duplicado
 *      PROCESSADO, devolve `skipped_duplicate` sem tocar nos dados.
 *   4. `markLoteProcessing` → escreve o buffer num ficheiro temporário
 *      → invoca o importer da lib (ex: importStockFromExcel) com o
 *      prisma do tenant.
 *   5. `completeLote` com counts em sucesso, ou `failLote` em erro.
 *   6. SyncRun start/complete/fail (opcional, controlado pelo caller)
 *      para o ledger cross-tenant.
 *   7. Limpa o ficheiro temporário sempre, mesmo em falha.
 *
 * Não duplica lógica do importer — apenas faz adaptação multipart →
 * file path. Quando o importer aceitar buffers nativos, este wrapper
 * shrinka mais.
 */

import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import type { PrismaClient, TipoLoteIngestao } from "@/generated/prisma/client";
import {
  hashFileContent,
  startLote,
  markLoteProcessing,
  completeLote,
  failLote,
} from "@/lib/ingest/lote-ingestao";
import {
  startSyncRun,
  completeSyncRun,
  failSyncRun,
} from "@/lib/sync/sync-run";

export type ImporterResult = {
  /** Linhas lidas do ficheiro (input). */
  recordsRead: number;
  /** Linhas escritas/upsertadas em sucesso. */
  recordsInserted: number;
  /** Linhas ignoradas (parse error / dados inválidos). */
  recordsFailed: number;
};

export type ImporterFn = (
  prisma: PrismaClient,
  filePath: string,
  farmaciaId: string,
) => Promise<ImporterResult>;

export type SnapshotUploadInput = {
  prisma: PrismaClient;
  tenantSlug: string;
  tipo: TipoLoteIngestao;
  /** Source name para SyncRun. Ex: "ingest-stock", "ingest-sales-monthly". */
  source: string;
  /** Função do `lib/importer.ts` adaptada à shape `ImporterResult`. */
  importer: ImporterFn;
  /** Form-data já parseado. */
  formData: FormData;
};

export async function handleSnapshotUpload(input: SnapshotUploadInput): Promise<Response> {
  const t0 = Date.now();

  const file = input.formData.get("file");
  const farmaciaId = input.formData.get("farmaciaId");

  if (!(file instanceof File)) {
    return NextResponse.json(
      { ok: false, error: "missing_file", message: "Campo 'file' em falta no form-data." },
      { status: 400 },
    );
  }
  if (typeof farmaciaId !== "string" || farmaciaId.trim().length === 0) {
    return NextResponse.json(
      { ok: false, error: "missing_farmacia_id", message: "Campo 'farmaciaId' em falta no form-data." },
      { status: 400 },
    );
  }

  // Validar que a farmácia existe no tenant — defende contra IDs
  // forjados ou de outro tenant.
  const farmacia = await input.prisma.farmacia.findUnique({
    where: { id: farmaciaId },
    select: { id: true, nome: true },
  });
  if (!farmacia) {
    return NextResponse.json(
      {
        ok: false,
        error: "farmacia_not_found",
        message: `Farmácia ${farmaciaId} não existe no tenant ${input.tenantSlug}.`,
      },
      { status: 404 },
    );
  }

  // ── Hash + dedup ────────────────────────────────────────────────────
  const buffer = Buffer.from(await file.arrayBuffer());
  const hashConteudo = hashFileContent(buffer);
  const nomeFicheiro = file.name || null;

  const startOutcome = await startLote(input.prisma, {
    farmaciaId,
    tipo: input.tipo,
    dataReferencia: new Date(),
    nomeFicheiro,
    hashConteudo,
  });

  if (startOutcome.kind === "skipped_duplicate") {
    return NextResponse.json(
      {
        ok: true,
        status: "skipped_duplicate",
        loteIngestaoId: startOutcome.existing.id,
        hashConteudo,
        nomeFicheiro,
        durationMs: Date.now() - t0,
        message: `Ficheiro já processado em ${startOutcome.existing.dataProcessamento?.toISOString() ?? "—"}.`,
      },
      { status: 200 },
    );
  }

  const loteId = startOutcome.lote.id;

  // ── SyncRun ledger ──────────────────────────────────────────────────
  // SyncRunTrigger enum não tem API — usar CLI (semântica:
  // disparado programaticamente, sem UI nem cron).
  const syncHandle = await startSyncRun({
    tenantSlug: input.tenantSlug,
    source: input.source,
    triggerType: "CLI",
    workerId: `ingest-api/${input.tenantSlug}`,
    meta: { loteId, hashConteudo, farmaciaId, nomeFicheiro, via: "api" },
  }).catch(() => null);

  // ── Escrever buffer para tmp file (importer pede file path) ────────
  const tmpPath = join(tmpdir(), `spharm-ingest-${randomUUID()}-${nomeFicheiro ?? "upload"}`);
  await writeFile(tmpPath, buffer);

  try {
    await markLoteProcessing(input.prisma, loteId);

    const result = await input.importer(input.prisma, tmpPath, farmaciaId);

    await completeLote(input.prisma, loteId, {
      totalRegistos: result.recordsRead,
      totalAceites: result.recordsInserted,
      totalRejeitados: result.recordsFailed,
    });

    if (syncHandle) {
      await completeSyncRun(syncHandle.id, {
        recordsRead: result.recordsRead,
        recordsInserted: result.recordsInserted,
        recordsFailed: result.recordsFailed,
      }).catch(() => {});
    }

    return NextResponse.json(
      {
        ok: true,
        status: "processed",
        loteIngestaoId: loteId,
        hashConteudo,
        nomeFicheiro,
        farmaciaId,
        farmaciaNome: farmacia.nome,
        records: {
          read: result.recordsRead,
          inserted: result.recordsInserted,
          failed: result.recordsFailed,
        },
        durationMs: Date.now() - t0,
      },
      { status: 200 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failLote(input.prisma, loteId, err).catch(() => {});
    if (syncHandle) await failSyncRun(syncHandle.id, err).catch(() => {});
    return NextResponse.json(
      {
        ok: false,
        status: "failed",
        loteIngestaoId: loteId,
        hashConteudo,
        nomeFicheiro,
        error: "import_failed",
        message,
        durationMs: Date.now() - t0,
      },
      { status: 500 },
    );
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}
