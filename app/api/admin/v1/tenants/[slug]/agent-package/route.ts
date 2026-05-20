/**
 * app/api/admin/v1/tenants/[slug]/agent-package/route.ts
 *
 * POST /api/admin/v1/tenants/{slug}/agent-package
 *   body: { farmacia, endpoint?, key?, rotate?, healthcheckUrl?,
 *           sqlHost?, sqlPort?, sqlDatabase?, sqlUser?, sqlPassword? }
 *
 * Parte servidor do "gerar Agent ZIP": emite/rotaciona a ingest key no
 * control plane e devolve o agent.config.json + a URL do template base
 * (object storage). O wizard descarrega o base, injecta o config e zipa
 * localmente. Auth: bearer admin token.
 */

import { type NextRequest } from "next/server";
import { withAdminApiAuthParams, AdminApiError } from "@/lib/admin/api-token";
import { prepareAgentPackage } from "@/lib/admin/ops/agent-package";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type RouteCtx = { params: Promise<{ slug: string }> };

export const POST = withAdminApiAuthParams<RouteCtx>(async (req: NextRequest, ctx) => {
  const { slug } = await ctx.params;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    throw new AdminApiError(400, "body JSON inválido", "bad_request");
  }
  const result = await prepareAgentPackage({
    slug,
    farmaciaId: body.farmaciaId == null ? null : String(body.farmaciaId),
    farmacia: body.farmacia == null ? null : String(body.farmacia),
    endpoint: body.endpoint == null ? null : String(body.endpoint),
    key: body.key == null ? null : String(body.key),
    rotate: body.rotate === true || body.rotate === "true",
    healthcheckUrl: body.healthcheckUrl == null ? null : String(body.healthcheckUrl),
    sqlHost: body.sqlHost == null ? null : String(body.sqlHost),
    sqlPort: body.sqlPort == null ? null : String(body.sqlPort),
    sqlDatabase: body.sqlDatabase == null ? null : String(body.sqlDatabase),
    sqlUser: body.sqlUser == null ? null : String(body.sqlUser),
    sqlPassword: body.sqlPassword == null ? null : String(body.sqlPassword),
  });
  return Response.json({ ok: true, ...result });
});
