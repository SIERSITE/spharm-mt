/**
 * app/api/ingest/v1/farmacias/route.ts
 *
 * GET /api/ingest/v1/farmacias
 *
 * Lista as farmácias do tenant autenticado. Read-only, usado pelo
 * agent CLI para resolver `--farmacia=<nome>` ↔ cuid. Mesma auth
 * dos endpoints de snapshot (`Bearer <key>` + `X-Tenant-Slug`).
 *
 * Response 200:
 *   { ok: true, tenantSlug, farmacias: [{ id, nome, estado }] }
 *
 * Não inclui dados sensíveis. Estado é "ATIVO" ou "INATIVO" — o agent
 * deve ignorar INATIVO para uploads.
 */

import { NextResponse, type NextRequest } from "next/server";
import { withIntegrationAuth } from "@/lib/integracao/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withIntegrationAuth(async (ctx, _req: NextRequest) => {
  const farmacias = await ctx.prisma.farmacia.findMany({
    select: { id: true, nome: true, estado: true },
    orderBy: { nome: "asc" },
  });
  return NextResponse.json({
    ok: true,
    tenantSlug: ctx.tenant.slug,
    farmacias,
  });
});
