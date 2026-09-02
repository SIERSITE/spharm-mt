/**
 * agent/src/sql-client.ts
 *
 * Wrapper sobre `mssql` para abrir conexões read-only ao SPharm ERP.
 * Centraliza:
 *  · Construção do ConnectionPool com timeout curto (15s connect;
 *    request configurável em `sqlServer.requestTimeoutMs`, 30s por
 *    omissão — não queremos pendurar o ERP da farmácia)
 *  · Tipo `SqlPool` exportado para os comandos
 *  · Helper `withPool` que abre/fecha em torno de uma função
 *
 * Não importa nada do SaaS. Não há retry interno — se a conexão SQL
 * falha, é tipicamente um problema de config (firewall, password,
 * instância nomeada) que precisa intervenção operacional.
 */

import sql from "mssql";
import type { AgentConfig } from "./config.js";

export type SqlPool = sql.ConnectionPool;

export function openPool(cfg: AgentConfig): SqlPool {
  return new sql.ConnectionPool({
    server: cfg.sqlHost,
    port: cfg.sqlPort,
    database: cfg.sqlDatabase,
    user: cfg.sqlUser,
    password: cfg.sqlPassword,
    options: {
      encrypt: cfg.sqlEncrypt,
      trustServerCertificate: cfg.sqlTrustCert,
      enableArithAbort: true,
      requestTimeout: cfg.sqlRequestTimeoutMs,
    },
    connectionTimeout: 15_000,
    pool: { max: 2, min: 0, idleTimeoutMillis: 30_000 },
  });
}

/**
 * Abre o pool, corre `fn`, fecha sempre. Para comandos one-shot.
 */
export async function withPool<T>(cfg: AgentConfig, fn: (pool: SqlPool) => Promise<T>): Promise<T> {
  const pool = openPool(cfg);
  await pool.connect();
  try {
    return await fn(pool);
  } finally {
    await pool.close();
  }
}
