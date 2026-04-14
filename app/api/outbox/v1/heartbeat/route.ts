import { NextResponse, type NextRequest } from "next/server";
import { withIntegrationAuth } from "@/lib/integracao/auth";
import { recordAgentHeartbeat } from "@/lib/control-plane";

/**
 * POST /api/outbox/v1/heartbeat
 *
 * Body (opcional): { version?: string }
 *
 * Regista que o agent está vivo para este tenant. Usado pela UI
 * admin para mostrar "agent visto há X min". Não escreve na BD do
 * tenant — escreve no control plane `Tenant.lastAgentHeartbeatAt`.
 *
 * IP vem do X-Forwarded-For (Vercel) ou remote addr. Versão vem do
 * body — opcional, é apenas informativo.
 */

function extractIp(req: NextRequest): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return null;
}

export const POST = withIntegrationAuth(async (ctx, req) => {
  const body = (await req.json().catch(() => ({}))) as { version?: string };
  await recordAgentHeartbeat({
    tenantId: ctx.tenant.id,
    ip: extractIp(req),
    version: body.version ?? null,
  });
  return NextResponse.json({
    ok: true,
    serverTime: new Date().toISOString(),
    tenantSlug: ctx.tenant.slug,
  });
});
