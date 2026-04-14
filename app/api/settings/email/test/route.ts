/**
 * POST /api/settings/email/test?scope=farmacia|global
 * Body: { to: string }
 *
 * Resolve a config (mesma ordem que os relatórios) e envia um email de
 * teste. Persiste lastTestAt/lastTestStatus/lastTestError no registo.
 */

import { getSession } from "@/lib/auth";
import { sendTestEmail } from "@/lib/email-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return Response.json({ ok: false, error: "Não autenticado" }, { status: 401 });

  const url = new URL(request.url);
  const scope = url.searchParams.get("scope");
  const farmaciaId = scope === "global" ? null : session.farmaciaId;

  if (!farmaciaId && session.perfil !== "ADMINISTRADOR" && session.perfil !== "GESTOR_GRUPO") {
    return Response.json({ ok: false, error: "Sem permissão" }, { status: 403 });
  }

  let body: { to?: string };
  try {
    body = (await request.json()) as { to?: string };
  } catch {
    return Response.json({ ok: false, error: "Body inválido" }, { status: 400 });
  }
  const to = (body.to ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return Response.json({ ok: false, error: "Email destino inválido" }, { status: 400 });
  }

  const result = await sendTestEmail(farmaciaId, to);
  return Response.json(result, { status: result.ok ? 200 : 500 });
}
