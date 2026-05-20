/**
 * app/api/admin/v1/tenants/[slug]/farmacias/route.ts
 *
 * POST /api/admin/v1/tenants/{slug}/farmacias
 *   body: { nome, codigo?, morada?, contacto? }
 *
 * Adiciona uma farmácia ao tenant. Auth: bearer admin token.
 */

import { type NextRequest } from "next/server";
import { withAdminApiAuthParams, AdminApiError } from "@/lib/admin/api-token";
import { addFarmacia } from "@/lib/admin/ops/add-farmacia";

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
  const result = await addFarmacia({
    slug,
    nome: String(body.nome ?? ""),
    codigo: body.codigo == null ? null : String(body.codigo),
    morada: body.morada == null ? null : String(body.morada),
    contacto: body.contacto == null ? null : String(body.contacto),
  });
  return Response.json({ ok: true, ...result });
});
