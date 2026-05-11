/**
 * app/api/ingest/v1/snapshot/stock/route.ts
 *
 * POST /api/ingest/v1/snapshot/stock
 *
 * Recebe um snapshot de stock (Excel) e ingere para a BD do tenant
 * autenticado. Idempotente via `LoteIngestao` (hash sha256 + tipo
 * STOCK + farmaciaId). Reupload do mesmo ficheiro devolve
 * `skipped_duplicate` sem tocar nos dados.
 *
 * Auth: Authorization: Bearer <ingest-key> + X-Tenant-Slug: <slug>
 *       (mesmo padrão dos endpoints /api/outbox/v1/*)
 *
 * Form-data:
 *   · file        Excel (.xlsx) com colunas CNP, designacao, ..., stockAtual, puc
 *   · farmaciaId  id da farmácia dentro da BD do tenant
 *
 * Response 200 — JSON:
 *   { ok: true, status: 'processed', loteIngestaoId, hashConteudo,
 *     records: { read, inserted, failed }, durationMs }
 *
 *   ou
 *
 *   { ok: true, status: 'skipped_duplicate', loteIngestaoId, message }
 *
 * Response 4xx/5xx — JSON com `error` e `message`.
 */

import { type NextRequest } from "next/server";
import { withIntegrationAuth } from "@/lib/integracao/auth";
import { importStockFromExcel } from "@/lib/importer";
import { handleSnapshotUpload } from "@/lib/ingest/handle-snapshot-upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // ficheiros grandes podem demorar; cron-like budget

export const POST = withIntegrationAuth(async (ctx, req: NextRequest) => {
  const formData = await req.formData();
  return handleSnapshotUpload({
    prisma: ctx.prisma,
    tenantSlug: ctx.tenant.slug,
    tipo: "STOCK",
    source: "ingest-stock",
    importer: async (prisma, filePath, farmaciaId) => {
      const r = await importStockFromExcel(prisma, filePath, farmaciaId);
      // imported = upsertados; skipped = linhas parse-failed.
      return {
        recordsRead: r.imported + r.skipped,
        recordsInserted: r.imported,
        recordsFailed: r.skipped,
      };
    },
    formData,
  });
});
