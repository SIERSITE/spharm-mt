import "server-only";
import { timingSafeEqual, createHash } from "node:crypto";
import type { NextRequest } from "next/server";

/**
 * lib/admin/api-token.ts
 *
 * Autenticação máquina-a-máquina para os endpoints de admin
 * `/api/admin/v1/*`, consumidos pelo SPharm.MT Admin Wizard em
 * STANDALONE_MODE (cliente HTTPS, sem repo/Node).
 *
 * Distinta da auth de sessão `isPlatformAdmin` (PLATFORM_ADMIN_EMAILS +
 * cookie) usada pelo /admin console no browser. Aqui não há sessão: o
 * wizard envia um bearer token partilhado, configurado no servidor via
 *   · ADMIN_API_TOKENS  — lista separada por vírgulas (preferida; permite
 *                         rotação sem downtime: adicionar nova, depois
 *                         remover a antiga)
 *   · ADMIN_API_TOKEN   — fallback de chave única
 *
 * Estes endpoints só fazem operações de provisionamento "leves"
 * (farmácias, utilizadores, status, precheck, agent key/config). NÃO
 * criam tenants (provisioning pesado fica em dev/trusted) — ver
 * docs/admin-wizard.md.
 *
 * Comparação em tempo constante (sha256 + timingSafeEqual) para não
 * vazar o comprimento nem permitir timing attacks sobre o token.
 */

export class AdminApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string = "error"
  ) {
    super(message);
  }
}

export function listAdminApiTokens(): string[] {
  const raw = process.env.ADMIN_API_TOKENS ?? process.env.ADMIN_API_TOKEN ?? "";
  const set = new Set<string>();
  for (const part of raw.split(",")) {
    const t = part.trim();
    if (t) set.add(t);
  }
  return [...set];
}

function parseBearer(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return match ? match[1].trim() : null;
}

/** sha256 ambos os lados → buffers de comprimento fixo → timingSafeEqual. */
function constantTimeEquals(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Valida o bearer token do request. Lança AdminApiError em falha.
 * Não revela qual token combinou nem distingue "token errado" de
 * "token ausente" para além do código mínimo necessário ao cliente.
 */
export function authenticateAdminApi(req: NextRequest): void {
  const tokens = listAdminApiTokens();
  if (tokens.length === 0) {
    // Mau-config do servidor — não é culpa do cliente, mas também não
    // deixamos passar. 503 sinaliza "endpoint existe mas não está pronto".
    throw new AdminApiError(
      503,
      "admin API not configured (set ADMIN_API_TOKENS)",
      "not_configured"
    );
  }
  const presented = parseBearer(req.headers.get("authorization"));
  if (!presented) {
    throw new AdminApiError(401, "missing bearer token", "missing_token");
  }
  const ok = tokens.some((t) => constantTimeEquals(t, presented));
  if (!ok) {
    throw new AdminApiError(401, "invalid token", "invalid_token");
  }
}

export function toAdminErrorResponse(err: unknown): Response {
  if (err instanceof AdminApiError) {
    return Response.json(
      { error: err.code, message: err.message },
      { status: err.status }
    );
  }
  console.error("[admin/api] unexpected error", err);
  return Response.json(
    {
      error: "internal_error",
      message: err instanceof Error ? err.message : String(err),
    },
    { status: 500 }
  );
}

/**
 * Wrapper para route handlers SEM params dinâmicos.
 *   export const GET = withAdminApiAuth(async (req) => { ... });
 */
export function withAdminApiAuth(
  handler: (req: NextRequest) => Promise<Response>
): (req: NextRequest) => Promise<Response> {
  return async (req: NextRequest): Promise<Response> => {
    try {
      authenticateAdminApi(req);
      return await handler(req);
    } catch (err) {
      return toAdminErrorResponse(err);
    }
  };
}

/**
 * Wrapper para route handlers COM params dinâmicos (ex.: `[slug]`).
 * Next 16 entrega `params` como Promise.
 *
 *   type RouteCtx = { params: Promise<{ slug: string }> };
 *   export const POST = withAdminApiAuthParams<RouteCtx>(
 *     async (req, routeCtx) => { ... }
 *   );
 */
export function withAdminApiAuthParams<
  TRouteCtx extends { params: Promise<Record<string, string>> },
>(
  handler: (req: NextRequest, routeCtx: TRouteCtx) => Promise<Response>
): (req: NextRequest, routeCtx: TRouteCtx) => Promise<Response> {
  return async (req: NextRequest, routeCtx: TRouteCtx): Promise<Response> => {
    try {
      authenticateAdminApi(req);
      return await handler(req, routeCtx);
    } catch (err) {
      return toAdminErrorResponse(err);
    }
  };
}
