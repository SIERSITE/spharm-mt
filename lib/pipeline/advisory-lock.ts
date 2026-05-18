/**
 * lib/pipeline/advisory-lock.ts
 *
 * Wrapper sobre `pg_try_advisory_xact_lock` para serializar pipelines
 * de aggregation por (pipelineName × farmaciaId).
 *
 * Decisão arquitectural — transaction-scoped vs session-scoped:
 *
 *   · pg_advisory_lock          — session-scoped, exige UNLOCK explícito
 *                                 e quebra com pool de conexões Neon
 *                                 serverless (conexões podem ser
 *                                 substituídas entre queries).
 *   · pg_advisory_xact_lock     — transaction-scoped, libertado
 *                                 automaticamente em COMMIT/ROLLBACK.
 *                                 Compatível com Neon pooling.
 *
 * Usamos a variante xact + try_* (non-blocking). Caller decide se
 * devolve 409 ou faz retry.
 *
 * Keys: `pg_try_advisory_xact_lock(int4, int4)`. Derivamos os dois int4
 * via `hashtext()` — hash interno do Postgres que devolve int4. Colisões
 * são possíveis mas o impacto é apenas serializar pipelines não
 * relacionados (não há corrupção de dados). Aceitável para v1.
 *
 * Uso típico:
 *
 *   await prisma.$transaction(async (tx) => {
 *     const ok = await tryAcquireAggregationXactLock(tx, "aggregate-compras", farmaciaId);
 *     if (!ok) throw new AggregateLockError("acquire_lock_failed");
 *     // ... work ...
 *   });
 */

import "server-only";

/**
 * Tipo mínimo aceite — qualquer cliente Prisma com `$queryRaw` serve
 * (tx interactivo, client root, etc.). Evita exigir o tipo completo
 * `PrismaClient` para facilitar testes.
 */
type SqlExecutor = {
  $queryRaw: <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T>;
};

export async function tryAcquireAggregationXactLock(
  exec: SqlExecutor,
  pipelineName: string,
  farmaciaId: string
): Promise<boolean> {
  const rows = await exec.$queryRaw<Array<{ acquired: boolean }>>`
    SELECT pg_try_advisory_xact_lock(hashtext(${pipelineName}), hashtext(${farmaciaId})) AS acquired
  `;
  return rows[0]?.acquired === true;
}

/**
 * Erro lançado quando o lock não é adquirido. Quem chama trata como 409.
 */
export class AggregateLockError extends Error {
  readonly code: string;
  constructor(code: string = "acquire_lock_failed", message?: string) {
    super(message ?? "Pipeline ocupado para esta farmácia — tentar novamente.");
    this.code = code;
  }
}
