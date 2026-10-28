/**
 * lib/tenant-constants.ts
 *
 * Constantes de tenant — módulo SIMPLES e seguro para componentes client:
 * sem `next/headers`, sem Prisma, sem `server-only`, sem dependências Node.
 * `lib/tenant-context.ts` re-exporta-as (os imports existentes continuam a
 * funcionar) e o `AppShell` importa-as daqui para decidir o que MOSTRAR.
 * Esconder um botão nunca é autorização: os gates server-side (páginas e
 * server actions) continuam a ser a única barreira real.
 */

/**
 * Tenant onde "Sincronizar agora" está desligado (2026-09) — garantia está
 * a meio de uma classificação cuidada de fabricantes/grupos laboratoriais.
 */
export const TENANT_SYNC_BLOQUEADO = "garantia";

/**
 * Tenant onde o filtro de fabricante do catálogo passa a trabalhar sobre o
 * grupo laboratorial pesquisável. Decisão DISTINTA de `TENANT_SYNC_BLOQUEADO`
 * (mesmo valor hoje, podem divergir).
 */
export const TENANT_GRUPOS_LABORATORIAIS = "garantia";

/**
 * Tenant onde a manutenção em massa do catálogo (fabricante/fornecedor
 * habitual por produto, com auditoria e reversão) e as regras de ingestão
 * associadas estão disponíveis. Não é uma "farmácia principal/autoritativa":
 * só decide QUEM pode ver/usar o ecrã.
 */
export const TENANT_CATALOGO_MASSA = "silveira";

/**
 * Tenant onde a designação (`Produto.designacao`) de um produto passa a ser
 * decidida pela farmácia Silveirense (ver `lib/ingest/designacao-silveira.ts`).
 * Decisão DISTINTA de `TENANT_CATALOGO_MASSA` (mesmo valor hoje, podem divergir)
 * e NÃO é uma "farmácia principal" genérica: vale só para este campo e só
 * neste tenant — os outros ficam com o comportamento de sempre.
 */
export const TENANT_DESIGNACAO_AUTORITATIVA = "silveira";

/**
 * Tenants onde o ecrã de manutenção em massa do catálogo (/catalogo/manutencao)
 * e as suas server actions estão disponíveis.
 *
 * PORQUÊ dois tenants: a Silveira já usava o ecrã; a Garantia precisa de
 * corrigir fabricante/designação em massa durante a classificação de grupos
 * laboratoriais. É uma decisão SÓ sobre quem pode ver/usar o ecrã — NÃO altera
 * as regras de ingestão da Silveira (`TENANT_CATALOGO_MASSA`,
 * `TENANT_DESIGNACAO_AUTORITATIVA`), que continuam exclusivas dela. A
 * manutenção em si só altera o fabricante / fornecedor habitual por pedido
 * explícito (preview + auditoria + reversão): nada nela é Silveira-only.
 */
export const TENANTS_CATALOGO_MANUTENCAO: readonly string[] = ["silveira", "garantia"];

/** Gate central da manutenção do catálogo. null/undefined/"" e outros tenants → false. */
export function catalogoManutencaoAtiva(slug: string | null | undefined): boolean {
  return typeof slug === "string" && TENANTS_CATALOGO_MANUTENCAO.includes(slug);
}

/**
 * Gate central dos grupos laboratoriais nos filtros de fabricante (só garantia).
 * Substitui as comparações dispersas com `TENANT_GRUPOS_LABORATORIAIS`.
 */
export function gruposLaboratoriaisAtivos(slug: string | null | undefined): boolean {
  return typeof slug === "string" && slug === TENANT_GRUPOS_LABORATORIAIS;
}
