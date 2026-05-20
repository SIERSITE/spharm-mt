/**
 * app/api/admin/v1/ping/route.ts
 *
 * GET /api/admin/v1/ping
 *
 * Teste de conectividade + autenticação usado pelo Admin Wizard
 * (STANDALONE_MODE) para validar o endpoint SaaS + o admin token antes
 * de mostrar a UI. Não toca em DBs.
 *
 * Auth: bearer admin token (ADMIN_API_TOKENS). 200 quando OK.
 */

import { type NextRequest } from "next/server";
import { withAdminApiAuth } from "@/lib/admin/api-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function buildInfo() {
  return {
    commit:
      process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ??
      process.env.SAAS_GIT_COMMIT?.slice(0, 7) ??
      "dev",
    env: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "dev",
  };
}

export const GET = withAdminApiAuth(async (_req: NextRequest) => {
  return Response.json({
    ok: true,
    service: "spharmmt-admin-api",
    apiVersion: "v1",
    capabilities: [
      "tenants:list",
      "farmacias:add",
      "users:add",
      "tenant:status",
      "tenant:precheck",
      "agent:package",
    ],
    agentBaseConfigured: !!process.env.AGENT_BASE_ZIP_URL,
    build: buildInfo(),
    at: new Date().toISOString(),
  });
});
