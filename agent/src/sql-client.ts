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
 * Não importa nada do SaaS.
 *
 * rev98 — retentativas PRUDENTES só para falhas TRANSITÓRIAS do SQL Server (ETIMEOUT, ESOCKET, ECONNCLOSED,
 * reset/rede temporária, pool indisponível — ver `sql-erros.ts`): até 2 retentativas (5 s e 20 s), com um pool NOVO
 * em cada uma. Credenciais inválidas, base/tabela/coluna inexistente, sintaxe e configuração NUNCA se repetem
 * (continuam a precisar de intervenção operacional). Esgotadas as retentativas, o erro sai marcado como transitório
 * (`transitoria = true`) para o daily-pipeline retomar o dia mais tarde — e, de qualquer modo, o dia fica pendente
 * para o catch-up da corrida seguinte.
 */

import sql from "mssql";
import type { AgentConfig } from "./config.js";
import { classificarErroSql, esperasSqlDoAmbiente } from "./sql-erros.js";
import { marcarFalhaTransitoriaDefinitiva, redigir } from "./politica-retry.js";

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

export type OpcoesWithPool = {
  /** Esperas (ms) antes de cada retentativa; `[]` desliga. Omissão: `SPHARMMT_SQL_RETRY_ESPERAS_MS` ou 5 s, 20 s. */
  esperasMs?: number[];
  dormir?: (ms: number) => Promise<void>;
  /** Injetável (testes). */
  abrirPool?: (cfg: AgentConfig) => SqlPool;
  log?: (linha: string) => void;
};

async function fecharSemFalhar(pool: SqlPool | null): Promise<void> {
  if (!pool) return;
  try {
    await pool.close();
  } catch {
    /* um erro a fechar nunca esconde o erro original */
  }
}

/**
 * Abre o pool, corre `fn`, fecha sempre. Para comandos one-shot.
 * Falhas transitórias do SQL Server repetem-se (pool novo, backoff 5 s/20 s); as restantes sobem de imediato.
 * `fn` é repetida por inteiro — quem a passa é idempotente (leituras + uploads idempotentes ao SaaS).
 */
export async function withPool<T>(cfg: AgentConfig, fn: (pool: SqlPool) => Promise<T>, opts: OpcoesWithPool = {}): Promise<T> {
  const esperas = opts.esperasMs ?? esperasSqlDoAmbiente();
  const dormir = opts.dormir ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const abrir = opts.abrirPool ?? openPool;
  const log = opts.log ?? ((l: string) => console.warn(l));
  const total = esperas.length + 1;

  for (let tentativa = 1; tentativa <= total; tentativa++) {
    let pool: SqlPool | null = null;
    try {
      pool = abrir(cfg);
      await pool.connect();
      const r = await fn(pool);
      await fecharSemFalhar(pool);
      return r;
    } catch (err) {
      await fecharSemFalhar(pool);
      const classe = classificarErroSql(err);
      if (!classe.transitoria) throw err; // permanente (ou do SaaS/desconhecido): sobe sem repetir
      if (tentativa === total) {
        log(`✗ SQL Server: falha transitória persistente após ${tentativa}/${total} tentativas (${classe.tipo}${classe.codigo ? ` ${classe.codigo}` : ""}) — o dia fica pendente para retoma/catch-up.`);
        marcarFalhaTransitoriaDefinitiva();
        try {
          Object.assign(err as object, { transitoria: true, sqlTransitoria: true });
        } catch {
          /* erro congelado: o chamador ainda classifica por sql-erros */
        }
        throw err;
      }
      const espera = esperas[tentativa - 1] ?? 0;
      log(
        `⚠ SQL Server: falha transitória (${classe.tipo}${classe.codigo ? ` ${classe.codigo}` : ""}) na tentativa ${tentativa}/${total}: ` +
          `${redigir(err instanceof Error ? err.message : String(err), [cfg.sqlPassword]).slice(0, 200)} — nova ligação em ${(espera / 1000).toFixed(1)}s`,
      );
      await dormir(espera);
    }
  }
  throw new Error("withPool: inalcançável");
}
