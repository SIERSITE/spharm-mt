/**
 * app/api/ingest/v1/snapshot/sales-monthly/route.ts
 *
 * POST /api/ingest/v1/snapshot/sales-monthly
 *
 * Recebe um snapshot de vendas mensais (Excel MapaEvolucaoVendas)
 * e ingere para a BD do tenant autenticado. Idempotente via
 * `LoteIngestao` (hash sha256 + tipo VENDAS_MENSAIS + farmaciaId).
 *
 * NOTA: `importSalesFromExcel` apaga e re-insere VendaMensal para os
 * meses presentes no ficheiro (semântica do importer existente).
 * Combinada com dedup por hash, isto significa que reuploads
 * idênticos são skipped antes do delete; reuploads diferentes
 * (ficheiro novo) refazem o mesmo período.
 *
 * Auth: Authorization: Bearer <ingest-key> + X-Tenant-Slug: <slug>
 *
 * Form-data:
 *   · file        Excel MapaEvolucaoVendas (colunas Jan/Fev/...)
 *   · farmaciaId  id da farmácia dentro da BD do tenant
 */

import { type NextRequest } from "next/server";
import { withIntegrationAuth } from "@/lib/integracao/auth";
import { importSalesFromExcel } from "@/lib/importer";
import { handleSnapshotUpload } from "@/lib/ingest/handle-snapshot-upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const POST = withIntegrationAuth(async (ctx, req: NextRequest) => {
  const formData = await req.formData();
  return handleSnapshotUpload({
    prisma: ctx.prisma,
    tenantSlug: ctx.tenant.slug,
    tipo: "VENDAS_MENSAIS",
    source: "ingest-sales-monthly",
    importer: async (prisma, filePath, farmaciaId) => {
      const r = await importSalesFromExcel(prisma, filePath, farmaciaId);
      return {
        recordsRead: r.vendasMensais + r.skipped,
        recordsInserted: r.vendasMensais,
        recordsFailed: r.skipped,
      };
    },
    formData,
  });
});
