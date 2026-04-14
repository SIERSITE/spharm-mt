/**
 * GET  /api/settings/email?scope=farmacia|global
 *   → devolve a config (sem password em claro), ou null se não existir.
 *
 * POST /api/settings/email?scope=farmacia|global
 *   Body: EmailConfigInput (smtpPass vazio mantém a actual)
 *   → grava e devolve a config persistida (sem password).
 */

import { getSession } from "@/lib/auth";
import { readEmailConfig, saveEmailConfig, type EmailConfigInput } from "@/lib/email-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function pickFarmaciaId(url: URL, sessionFarmaciaId: string | null): string | null {
  const scope = url.searchParams.get("scope");
  if (scope === "global") return null;
  return sessionFarmaciaId;
}

export async function GET(request: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return Response.json({ ok: false, error: "Não autenticado" }, { status: 401 });

  const url = new URL(request.url);
  const farmaciaId = pickFarmaciaId(url, session.farmaciaId);

  if (!farmaciaId && session.perfil !== "ADMINISTRADOR" && session.perfil !== "GESTOR_GRUPO") {
    return Response.json({ ok: false, error: "Sem permissão para a config global" }, { status: 403 });
  }

  const cfg = await readEmailConfig(farmaciaId);
  return Response.json({ ok: true, config: cfg });
}

export async function POST(request: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return Response.json({ ok: false, error: "Não autenticado" }, { status: 401 });

  const url = new URL(request.url);
  const farmaciaId = pickFarmaciaId(url, session.farmaciaId);

  if (!farmaciaId && session.perfil !== "ADMINISTRADOR" && session.perfil !== "GESTOR_GRUPO") {
    return Response.json({ ok: false, error: "Sem permissão para a config global" }, { status: 403 });
  }

  let body: Partial<EmailConfigInput>;
  try {
    body = (await request.json()) as Partial<EmailConfigInput>;
  } catch {
    return Response.json({ ok: false, error: "Body inválido" }, { status: 400 });
  }

  const port = Number(body.smtpPort);
  if (!body.smtpHost || !Number.isFinite(port) || port <= 0 || !body.fromEmail) {
    return Response.json(
      { ok: false, error: "smtpHost, smtpPort e fromEmail são obrigatórios" },
      { status: 400 }
    );
  }

  try {
    await saveEmailConfig(farmaciaId, {
      smtpHost: body.smtpHost,
      smtpPort: port,
      smtpUser: body.smtpUser ?? null,
      smtpPass: body.smtpPass ?? null,
      smtpSecure: !!body.smtpSecure,
      fromEmail: body.fromEmail,
      fromName: body.fromName ?? null,
      replyTo: body.replyTo ?? null,
      isActive: body.isActive ?? true,
    });
    const saved = await readEmailConfig(farmaciaId);
    return Response.json({ ok: true, config: saved });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}
