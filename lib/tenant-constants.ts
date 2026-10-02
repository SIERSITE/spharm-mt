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
