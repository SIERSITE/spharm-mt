/**
 * app/api/admin/v1/tenants/route.ts
 *
 * GET /api/admin/v1/tenants
 *
 * Lista tenants (sem segredos) para o Admin Wizard. Read-only.
 * Auth: bearer admin token.
 */

import { type NextRequest } from "next/server";
import { withAdminApiAuth } from "@/lib/admin/api-token";
import { listTenantsForAdmin } from "@/lib/admin/ops/list-tenants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const GET = withAdminApiAuth(async (_req: NextRequest) => {
  const tenants = await listTenantsForAdmin();
  return Response.json({ ok: true, tenants });
});
