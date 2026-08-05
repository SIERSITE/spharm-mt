// Sem `import "server-only"` — `lib/prisma.ts` puxa este módulo e é
// consumido por scripts CLI (worker, jobs, seeds) corridos via `tsx`,
// fora do bundler Next que resolveria o marker. Ver nota equivalente em
// `lib/tenant-context.ts`.
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { legacyDatabaseFallbackAllowed } from "@/lib/runtime-config";

/**
 * Registry em memória dos PrismaClients por tenant, com lazy warm-up.
 *
 * Responsabilidade única: dado um slug (ou null para legacy), devolve
 * um PrismaClient pronto a usar. Não sabe nada de requests, headers
 * nem de middleware — isso vive em lib/tenant-context.ts.
 *
 * Ciclo de vida:
 *   1. Primeira chamada a `getTenantPrismaOrLegacy(slug)` dispara
 *      `ensureWarm()` (idempotente, com lock para evitar race).
 *   2. `ensureWarm()` lê todos os tenants ACTIVE do control plane
 *      e constrói um PrismaClient para cada, caching-os por slug.
 *   3. Se o control plane não estiver acessível (ex: CONTROL_DATABASE_URL
 *      em falta ou BD down), o warm-up falha silenciosamente — o
 *      getter devolve sempre o legacy client. A app dev continua
 *      a funcionar sem control plane.
 *   4. Novos tenants provisionados após o warm-up NÃO aparecem até
 *      ao próximo restart do processo. Nesta fase é aceitável.
 *
 * Legacy fallback — CONDICIONAL, e por defeito DESLIGADO em produção:
 *   · slug === null                    → legacy, se permitido
 *   · slug não encontrado no cache     → legacy, se permitido
 *   · warm-up falhou                   → legacy, se permitido
 *
 * O "legacy" é construído a partir de `process.env.DATABASE_URL`.
 *
 * Porque é que deixou de ser incondicional: num alojamento multi-tenant,
 * `DATABASE_URL` aponta para uma base concreta. Cair nela porque o slug
 * não resolveu serve dados de OUTRO cliente a quem pediu um tenant — e
 * fá-lo em silêncio, porque a página abre na mesma. Um erro explícito é
 * sempre preferível a uma resposta errada.
 *
 * `ALLOW_LEGACY_DATABASE_FALLBACK=1` repõe o comportamento antigo (é o
 * default fora de produção, onde é o modo de trabalho normal). Ver
 * `lib/runtime-config.ts`.
 */

/**
 * Erro atirado quando não há tenant resolvido e o fallback não é
 * permitido. Distinto de qualquer erro de Prisma para que os callers
 * possam responder 404/400 em vez de 500.
 */
export class TenantResolutionError extends Error {
  readonly slug: string | null;
  constructor(slug: string | null, detail: string) {
    super(detail);
    this.name = "TenantResolutionError";
    this.slug = slug;
  }
}

type CacheEntry = { client: PrismaClient; slug: string };

const cache = new Map<string, CacheEntry>();
let legacyClient: PrismaClient | null = null;
let warmPromise: Promise<void> | null = null;
let warmComplete = false;
let warmFailed = false;

function buildClientFromUrl(connectionString: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

function getLegacyClient(): PrismaClient {
  if (legacyClient) return legacyClient;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL em falta. Não é possível construir o cliente legacy.\n" +
        "  Define DATABASE_URL no .env (BD de dev actual) ou provisiona tenants via control plane."
    );
  }
  legacyClient = buildClientFromUrl(url);
  return legacyClient;
}

/**
 * Lazy warm-up: carrega todos os tenants ACTIVE do control plane e
 * constrói um PrismaClient para cada. Idempotente via lock.
 *
 * Se o control plane estiver inacessível, regista warmFailed=true
 * e deixa o cache vazio — `getTenantPrismaOrLegacy` passa a cair
 * sempre no legacy.
 */
async function ensureWarm(): Promise<void> {
  if (warmComplete || warmFailed) return;
  if (warmPromise) return warmPromise;

  warmPromise = (async () => {
    try {
      // Importação tardia para não arrastar dependência rígida do
      // control plane durante o boot da app (se CONTROL_DATABASE_URL
      // não estiver definido, a falha deve ser silenciosa).
      const { listTenants, buildTenantConnectionString } = await import(
        "@/lib/control-plane"
      );
      const tenants = await listTenants({ estado: "ACTIVE" });
      for (const t of tenants) {
        try {
          const url = buildTenantConnectionString(t);
          cache.set(t.slug, { client: buildClientFromUrl(url), slug: t.slug });
        } catch (err) {
          console.warn(
            `[tenant-registry] falha a construir cliente para ${t.slug}:`,
            err instanceof Error ? err.message : err
          );
        }
      }
      warmComplete = true;
    } catch (err) {
      warmFailed = true;
      console.warn(
        "[tenant-registry] warm-up do control plane falhou — apenas legacy client disponível.",
        err instanceof Error ? err.message : err
      );
    } finally {
      warmPromise = null;
    }
  })();
  return warmPromise;
}

/**
 * Cai no cliente legacy, ou atira se isso não for permitido.
 *
 * `reason` entra na mensagem para que o log diga qual dos dois casos
 * ocorreu — "sem tenant no request" e "slug desconhecido" pedem acções
 * diferentes ao operador.
 */
function fallbackOrThrow(slug: string | null, reason: string): PrismaClient {
  if (legacyDatabaseFallbackAllowed()) {
    if (slug && process.env.NODE_ENV !== "production") {
      console.warn(
        `[tenant-registry] slug "${slug}" não está no cache — a cair no legacy.\n` +
          "  Se o tenant foi provisionado após o arranque, reinicia o dev server."
      );
    }
    return getLegacyClient();
  }
  throw new TenantResolutionError(
    slug,
    `${reason}. O fallback para DATABASE_URL está desligado ` +
      "(ALLOW_LEGACY_DATABASE_FALLBACK), portanto não há base a servir. " +
      "Acede pelo subdomínio do tenant ou, sem DNS wildcard, com " +
      "?__tenant=<slug> e TENANT_FALLBACK_ENABLED=1."
  );
}

/**
 * Ponto de entrada principal. Recebe o slug corrente (null = sem tenant
 * no request) e devolve um PrismaClient pronto.
 *
 * Atira `TenantResolutionError` quando não há tenant e o fallback legacy
 * não é permitido — ver a nota no topo do ficheiro.
 */
export async function getTenantPrismaOrLegacy(slug: string | null): Promise<PrismaClient> {
  if (!slug) {
    return fallbackOrThrow(null, "Nenhum tenant resolvido para este pedido");
  }

  await ensureWarm();
  const entry = cache.get(slug);
  if (entry) return entry.client;

  return fallbackOrThrow(
    slug,
    `O tenant "${slug}" não existe, não está ACTIVE, ou foi provisionado ` +
      "depois do arranque deste processo"
  );
}

/**
 * Testabilidade: limpa o cache in-memory. Usado por smoke tests e
 * scripts que precisam de forçar re-warm. NÃO exposta em produção.
 */
export function __resetRegistryForTests(): void {
  for (const entry of cache.values()) {
    entry.client.$disconnect().catch(() => {});
  }
  cache.clear();
  if (legacyClient) {
    legacyClient.$disconnect().catch(() => {});
    legacyClient = null;
  }
  warmPromise = null;
  warmComplete = false;
  warmFailed = false;
}
