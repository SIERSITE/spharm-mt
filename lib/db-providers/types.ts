/**
 * lib/db-providers/types.ts
 *
 * Interface DatabaseProvider — abstrai a criação/destruição de DBs por
 * tenant. Implementações vivem em `manual-url.ts`, `local-postgres.ts`,
 * `neon.ts` (futuro), etc.
 *
 * Sem `import "server-only"` — usado por scripts CLI (provision-tenant,
 * create-client) corridos via tsx fora do bundler Next.
 */

/** Conexão completa a uma DB de tenant após provisionamento. */
export type ConnectionTargets = {
  host: string;
  port: number;
  dbName: string;
  dbUser: string;
  /** Plain — caller cifra antes de persistir no control plane. */
  dbPassword: string;
  /**
   * URL Postgres completa pronta a usar em `prisma migrate deploy` e
   * em `PrismaPg`. Inclui credenciais (URL-encoded) + parâmetros de
   * conexão (sslmode, channel_binding, etc.) preservados verbatim do
   * input quando aplicável.
   */
  connectionUrl: string;
};

/**
 * Provider de provisionamento de DBs tenant. Implementações:
 *
 *  · ManualUrlProvider   — operador trouxe a URL completa (ex: criou
 *                          DB+role manualmente na UI Neon). Provider
 *                          só parse e valida conectividade.
 *  · LocalPostgresProvider — corre CREATE ROLE+DATABASE via SQL admin.
 *                          Pré-requisito: super-user. Em Neon
 *                          partilhado tipicamente NÃO funciona.
 *  · NeonProvider (PR2)  — usa Neon API para criar projecto/DB.
 */
export interface DatabaseProvider {
  /** Identificador estável — usado em logs e em TenantEvent meta. */
  readonly name: string;

  /**
   * Provisiona a DB para o tenant identificado pelo slug. Garante que
   * a DB existe, é acessível, e devolve credenciais prontas. Falha-
   * rápido em caso de erro com mensagem accionável.
   *
   * Em providers idempotentes (futuro NeonProvider), pode reutilizar
   * uma DB existente com o mesmo nome se a verificação de propriedade
   * passar. ManualUrlProvider e LocalPostgresProvider são one-shot.
   */
  createDatabase(opts: { slug: string; region?: string }): Promise<ConnectionTargets>;

  /**
   * Cleanup. Best-effort — implementações que não controlam a infra
   * (ManualUrlProvider) podem ser no-op. Caller documenta esta
   * possibilidade aos operadores.
   */
  destroyDatabase(opts: { dbName: string; dbUser: string }): Promise<void>;
}
