import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveCurrentTenantSlug } from "@/lib/tenant-context";
import { getTenantPrismaOrLegacy } from "@/lib/tenant-registry";

/**
 * Cliente Prisma — separação explícita runtime-web / scripts CLI.
 *
 * Fase 3 da migração multi-tenant: o runtime web (app/, server actions,
 * server components, data layer usado por páginas) **só** consome
 * `getPrisma()`. O singleton legacy deixou de estar disponível com o
 * nome `prisma` precisamente para remover qualquer ambiguidade.
 *
 * Dois exports, com fronteira clara:
 *
 *   · `getPrisma()` — ASYNC, tenant-aware. DESTINO do runtime web.
 *     Resolve o slug do request via `resolveCurrentTenantSlug()`,
 *     procura no cache do registry e devolve o PrismaClient do tenant
 *     correspondente. Se não houver slug (fora de request context,
 *     localhost sem subdomain/query param), cai no legacy client.
 *     Uso: `const prisma = await getPrisma(); await prisma.venda.findMany(...)`.
 *
 *   · `legacyPrisma` — SÍNCRONO, singleton ligado a `process.env.DATABASE_URL`.
 *     EXCLUSIVO para scripts CLI, jobs e workers que correm fora de
 *     qualquer request e portanto não têm tenant a resolver. NUNCA
 *     deve ser importado por código em `app/` nem por módulos em
 *     `lib/` que sejam consumidos pelo runtime web.
 *
 * Regra enforced via revisão: grep por `legacyPrisma` dentro de `app/`
 * ou dentro dos ficheiros de `lib/` listados na Fase 2 como tenant-aware
 * tem de vir vazio. Qualquer nova feature runtime tem de usar `getPrisma`.
 *
 * A fase seguinte (per-tenant jobs) vai progressivamente retirar
 * `legacyPrisma` dos scripts — passando a receber um `PrismaClient`
 * por parâmetro para que cada invocação escolha explicitamente contra
 * que BD corre. Enquanto essa refactorização não estiver feita,
 * `legacyPrisma` fica aqui como caminho compatível sem ambiguidade.
 */

// ─────────────────────────────────────────────────────────────────
// Singleton legacy — EXCLUSIVO scripts CLI / jobs / workers
// ─────────────────────────────────────────────────────────────────

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL!,
});

const globalForPrisma = global as unknown as {
  legacyPrisma: PrismaClient | undefined;
};

/**
 * Singleton apontando a `DATABASE_URL`. **Não usar no runtime web.**
 * Ver docstring do ficheiro para a razão e para o substituto correcto
 * (`getPrisma()`).
 */
export const legacyPrisma =
  globalForPrisma.legacyPrisma ??
  new PrismaClient({
    adapter,
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.legacyPrisma = legacyPrisma;
}

// ─────────────────────────────────────────────────────────────────
// Tenant-aware async getter (novo — destino da migração)
// ─────────────────────────────────────────────────────────────────

/**
 * Devolve o PrismaClient para o tenant corrente (ou legacy se não
 * houver). Chamar no topo de cada server component / server action /
 * função de data layer:
 *
 *     const prisma = await getPrisma();
 *
 * O resultado é cacheado in-memory pelo registry, logo a única
 * operação async aqui é o `await headers()` do Next 16.
 */
export async function getPrisma(): Promise<PrismaClient> {
  const slug = await resolveCurrentTenantSlug();
  return getTenantPrismaOrLegacy(slug);
}