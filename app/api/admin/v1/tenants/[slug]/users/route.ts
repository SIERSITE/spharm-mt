/**
 * app/api/admin/v1/tenants/[slug]/users/route.ts
 *
 * POST /api/admin/v1/tenants/{slug}/users
 *   body: { email, nome, role, farmacia?, password? }
 *
 * Cria um utilizador no tenant (mustChangePassword=true). Se a password
 * for gerada, vem na resposta UMA vez. Auth: bearer admin token.
 */

import { type NextRequest } from "next/server";
import { withAdminApiAuthParams, AdminApiError } from "@/lib/admin/api-token";
import { addUser } from "@/lib/admin/ops/add-user";

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
  const result = await addUser({
    slug,
    email: String(body.email ?? ""),
    nome: String(body.nome ?? ""),
    role: String(body.role ?? ""),
    farmacia: body.farmacia == null ? null : String(body.farmacia),
    password: body.password == null ? null : String(body.password),
  });
  return Response.json({ ok: true, ...result });
});
