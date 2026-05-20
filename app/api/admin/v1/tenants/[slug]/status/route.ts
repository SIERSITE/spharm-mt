/**
 * app/api/admin/v1/tenants/[slug]/status/route.ts
 *
 * GET /api/admin/v1/tenants/{slug}/status
 *
 * Estado estruturado do tenant (control plane + tenant DB). Read-only.
 * Auth: bearer admin token.
 */

import { type NextRequest } from "next/server";
import { withAdminApiAuthParams } from "@/lib/admin/api-token";
import { getTenantStatus } from "@/lib/admin/ops/tenant-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type RouteCtx = { params: Promise<{ slug: string }> };

export const GET = withAdminApiAuthParams<RouteCtx>(async (_req: NextRequest, ctx) => {
  const { slug } = await ctx.params;
  const result = await getTenantStatus(slug);
  return Response.json({ ok: true, ...result });
});
