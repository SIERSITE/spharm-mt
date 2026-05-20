/**
 * app/api/admin/v1/tenants/[slug]/precheck/route.ts
 *
 * GET /api/admin/v1/tenants/{slug}/precheck
 *
 * Pré-check de go-live (checks ✓/⚠/✗). Read-only.
 * Auth: bearer admin token.
 */

import { type NextRequest } from "next/server";
import { withAdminApiAuthParams } from "@/lib/admin/api-token";
import { runPrecheck } from "@/lib/admin/ops/precheck";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type RouteCtx = { params: Promise<{ slug: string }> };

export const GET = withAdminApiAuthParams<RouteCtx>(async (_req: NextRequest, ctx) => {
  const { slug } = await ctx.params;
  const result = await runPrecheck(slug);
  return Response.json({ ok: true, ...result });
});
