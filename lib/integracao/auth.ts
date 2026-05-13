import "server-only";
import bcrypt from "bcryptjs";
import type { NextRequest } from "next/server";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  controlPrisma,
  getTenantBySlug,
  buildTenantConnectionString,
  type TenantRecord,
} from "@/lib/control-plane";
import { PrismaClient as TenantPrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

/**
 * lib/integracao/auth.ts
 *
 * Autenticação partilhada entre /api/ingest/v1/* e /api/outbox/v1/*.
 *
 * O agent Windows envia em cada request:
 *   · Authorization: Bearer <key>
 *   · X-Tenant-Slug: <slug>
 *
 * Fluxo:
 *   1. Parse dos headers. 401 se faltar algum.
 *   2. Lookup do tenant em control plane pelo slug. 401 se não existir
 *      ou estado != ACTIVE. Resposta genérica — não confirma nem nega
 *      a existência do slug (defesa contra enumeração).
 *   3. bcrypt.compare da key contra ingestApiKeyHash. 401 se falhar.
 *   4. Em sucesso, devolve um objecto com o tenant record + um cliente
 *      Prisma já apontado à BD do tenant. O caller usa esse cliente
 *      directamente — NÃO chama getPrisma(). A razão: o header
 *      X-Tenant-Slug é o vector de auth, e não queremos que um request
 *      autorizado para o tenant A consiga escrever no tenant B por má
 *      configuração do middleware ou cabeçalho x-tenant-slug forjado.
 *      O cliente é construído directamente do registo, bypassando o
 *      middleware path.
 *
 * Cache de clientes: em processo longo (Node runtime), reusamos um
 * PrismaClient por tenant — o runtime da API está naturalmente
 * escalado pelo Vercel, mas dentro de um mesmo processo evitamos
 * criar sockets repetidos.
 *
 * Rate limiting futuro: ganchos para bump de contadores ficam TODO
 * explícito — nesta passagem não implementamos throttling.
 */

export type AuthenticatedContext = {
  tenant: TenantRecord;
  prisma: PrismaClient;
};

export class IntegrationAuthError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string = "unauthorized"
  ) {
    super(message);
  }
}

const clientCache = new Map<string, PrismaClient>();

function getTenantClientFromRecord(tenant: TenantRecord): PrismaClient {
  const cached = clientCache.get(tenant.id);
  if (cached) return cached;
  const url = buildTenantConnectionString(tenant);
  const adapter = new PrismaPg({ connectionString: url });
  const client = new TenantPrismaClient({ adapter });
  clientCache.set(tenant.id, client);
  return client;
}

function parseBearer(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return match ? match[1].trim() : null;
}

/**
 * Helper safe-to-log: deriva hint do control plane sem expor password.
 * Usado em logs de falha de auth para diagnose de "Vercel está a ler
 * o CONTROL_DATABASE_URL certo?".
 */
function deriveControlDbHint(): string {
  const url = process.env.CONTROL_DATABASE_URL;
  if (!url) return "(unset)";
  try {
    const u = new URL(url);
    return `${u.hostname}/${u.pathname.replace(/^\//, "") || "(no-db)"}`;
  } catch {
    return "(unparseable)";
  }
}

/**
 * Estruturado, mascarado, single-line JSON para Vercel logs. Só dispara
 * em falhas (sucessos não geram ruído). Campos:
 *  · outcome           — discriminador (missing/not-found/not-active/no-key/bcrypt-mismatch)
 *  · slug              — raw header value (pode revelar enumeração mas é necessário)
 *  · bearerPresent     — boolean
 *  · bearerLength      — int (não logamos a key)
 *  · bearerPrefix      — primeiros 6 chars da key (suficiente para
 *                        cross-ref com agent.config.json sem expor)
 *  · tenantEstado      — só se tenant foi encontrado
 *  · hashPresent       — boolean
 *  · hashPrefix        — primeiros 10 chars da hash bcrypt (metadata
 *                        $2a$10$ + 4 chars de salt — não recuperável)
 *  · hashLength        — int
 *  · controlDbHint     — host/dbName do CONTROL_DATABASE_URL do
 *                        processo (sem credenciais)
 */
type AuthDecision = {
  outcome:
    | "missing_credentials"
    | "tenant_not_found"
    | "tenant_not_active"
    | "no_key"
    | "bcrypt_mismatch";
  slug: string | null;
  bearerPresent: boolean;
  bearerLength?: number;
  bearerPrefix?: string;
  tenantEstado?: string;
  hashPresent?: boolean;
  hashPrefix?: string;
  hashLength?: number;
  controlDbHint: string;
};

function logAuthFailure(decision: AuthDecision): void {
  // single-line para grep fácil em Vercel logs
  console.warn(`[integracao/auth] ${JSON.stringify(decision)}`);
}

/**
 * Entry point. Chamado por cada route handler em /api/ingest/v1/* e
 * /api/outbox/v1/*. Em falha, lança IntegrationAuthError que o caller
 * converte em Response (helper withIntegrationAuth mais abaixo).
 */
export async function authenticateAgent(
  req: NextRequest
): Promise<AuthenticatedContext> {
  const authHeader = req.headers.get("authorization");
  const slug = req.headers.get("x-tenant-slug");
  const key = parseBearer(authHeader);

  const bearerPresent = !!authHeader;
  const bearerLength = key?.length;
  const bearerPrefix = key ? key.slice(0, 6) : undefined;
  const controlDbHint = deriveControlDbHint();

  if (!slug || !key) {
    logAuthFailure({
      outcome: "missing_credentials",
      slug,
      bearerPresent,
      bearerLength,
      bearerPrefix,
      controlDbHint,
    });
    throw new IntegrationAuthError(401, "missing credentials", "missing_credentials");
  }

  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    logAuthFailure({
      outcome: "tenant_not_found",
      slug,
      bearerPresent,
      bearerLength,
      bearerPrefix,
      controlDbHint,
    });
    // Resposta genérica — não distinguimos entre "slug não existe",
    // "slug suspenso" e "key errada".
    throw new IntegrationAuthError(401, "invalid credentials");
  }
  if (tenant.estado !== "ACTIVE") {
    logAuthFailure({
      outcome: "tenant_not_active",
      slug,
      bearerPresent,
      bearerLength,
      bearerPrefix,
      tenantEstado: tenant.estado,
      controlDbHint,
    });
    throw new IntegrationAuthError(401, "invalid credentials");
  }

  if (!tenant.ingestApiKeyHash) {
    logAuthFailure({
      outcome: "no_key",
      slug,
      bearerPresent,
      bearerLength,
      bearerPrefix,
      tenantEstado: tenant.estado,
      hashPresent: false,
      controlDbHint,
    });
    throw new IntegrationAuthError(
      401,
      "tenant has no ingest key configured",
      "no_key"
    );
  }

  const ok = await bcrypt.compare(key, tenant.ingestApiKeyHash);
  if (!ok) {
    logAuthFailure({
      outcome: "bcrypt_mismatch",
      slug,
      bearerPresent,
      bearerLength,
      bearerPrefix,
      tenantEstado: tenant.estado,
      hashPresent: true,
      hashPrefix: tenant.ingestApiKeyHash.slice(0, 10),
      hashLength: tenant.ingestApiKeyHash.length,
      controlDbHint,
    });
    throw new IntegrationAuthError(401, "invalid credentials");
  }

  return {
    tenant,
    prisma: getTenantClientFromRecord(tenant),
  };
}

/**
 * Wrapper helper: converte uma função handler `(ctx, req) => Response`
 * numa route handler Next.js que aplica a autenticação + try/catch de
 * IntegrationAuthError. Uso típico:
 *
 *   export const POST = withIntegrationAuth(async (ctx, req) => {
 *     // ctx.prisma é já o cliente do tenant
 *     // ctx.tenant é o TenantRecord
 *     return NextResponse.json({ ok: true });
 *   });
 */
function toErrorResponse(err: unknown): Response {
  if (err instanceof IntegrationAuthError) {
    return new Response(
      JSON.stringify({ error: err.code, message: err.message }),
      { status: err.status, headers: { "content-type": "application/json" } }
    );
  }
  console.error("[integracao/auth] unexpected error", err);
  return new Response(
    JSON.stringify({
      error: "internal_error",
      message: err instanceof Error ? err.message : String(err),
    }),
    { status: 500, headers: { "content-type": "application/json" } }
  );
}

/**
 * Wrapper para route handlers SEM params dinâmicos.
 * Produz a assinatura `(req) => Promise<Response>` que o Next 16 exige
 * para rotas estáticas. Handler recebe `(ctx, req)`.
 *
 *   export const POST = withIntegrationAuth(async (ctx, req) => { ... });
 */
export function withIntegrationAuth(
  handler: (ctx: AuthenticatedContext, req: NextRequest) => Promise<Response>
): (req: NextRequest) => Promise<Response> {
  return async (req: NextRequest): Promise<Response> => {
    try {
      const ctx = await authenticateAgent(req);
      return await handler(ctx, req);
    } catch (err) {
      return toErrorResponse(err);
    }
  };
}

/**
 * Wrapper para route handlers COM params dinâmicos (ex: `[outboxId]`).
 * Produz a assinatura `(req, { params }) => Promise<Response>` — a
 * segunda posição é obrigatória e o Next 16 passa sempre `{ params }`.
 * Handler recebe `(ctx, req, routeCtx)`.
 *
 *   type RouteCtx = { params: Promise<{ outboxId: string }> };
 *   export const POST = withIntegrationAuthParams<RouteCtx>(
 *     async (ctx, req, routeCtx) => { ... }
 *   );
 */
export function withIntegrationAuthParams<
  TRouteCtx extends { params: Promise<Record<string, string>> },
>(
  handler: (
    ctx: AuthenticatedContext,
    req: NextRequest,
    routeCtx: TRouteCtx
  ) => Promise<Response>
): (req: NextRequest, routeCtx: TRouteCtx) => Promise<Response> {
  return async (req: NextRequest, routeCtx: TRouteCtx): Promise<Response> => {
    try {
      const ctx = await authenticateAgent(req);
      return await handler(ctx, req, routeCtx);
    } catch (err) {
      return toErrorResponse(err);
    }
  };
}

/** Só para scripts que precisam de emitir uma nova key. bcrypt cost 10. */
export async function hashIngestKey(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

/** Usado pelo controlPrisma para evitar re-importar em scripts. */
export { controlPrisma };
