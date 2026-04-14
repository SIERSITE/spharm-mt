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
 * Entry point. Chamado por cada route handler em /api/ingest/v1/* e
 * /api/outbox/v1/*. Em falha, lança IntegrationAuthError que o caller
 * converte em Response (helper withIntegrationAuth mais abaixo).
 */
export async function authenticateAgent(
  req: NextRequest
): Promise<AuthenticatedContext> {
  const slug = req.headers.get("x-tenant-slug");
  const key = parseBearer(req.headers.get("authorization"));

  if (!slug || !key) {
    throw new IntegrationAuthError(401, "missing credentials", "missing_credentials");
  }

  const tenant = await getTenantBySlug(slug);
  if (!tenant || tenant.estado !== "ACTIVE") {
    // Resposta genérica — não distinguimos entre "slug não existe",
    // "slug suspenso" e "key errada".
    throw new IntegrationAuthError(401, "invalid credentials");
  }

  if (!tenant.ingestApiKeyHash) {
    throw new IntegrationAuthError(
      401,
      "tenant has no ingest key configured",
      "no_key"
    );
  }

  const ok = await bcrypt.compare(key, tenant.ingestApiKeyHash);
  if (!ok) {
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
export function withIntegrationAuth<TRouteCtx = undefined>(
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
  };
}

/** Só para scripts que precisam de emitir uma nova key. bcrypt cost 10. */
export async function hashIngestKey(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

/** Usado pelo controlPrisma para evitar re-importar em scripts. */
export { controlPrisma };
