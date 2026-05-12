/**
 * agent/src/commands/health.ts
 *
 * Resumo de configuração + connectivity + diagnóstico. Mais verboso
 * que `test-connection` — pensado para diagnose remoto (operador da
 * SaaS pede ao operador da farmácia para correr e enviar screenshot).
 *
 * Não atira mesmo que algumas verificações falhem: mostra TUDO o que
 * conseguiu descobrir + indicadores claros do que está partido.
 */

import * as os from "node:os";
import { loadConfig, describeConfig, type AgentConfig } from "../config.js";
import { openPool, withPool } from "../sql-client.js";
import { SaasClient } from "../http-client.js";

type Check = { label: string; status: "ok" | "fail" | "skip"; detail: string; durationMs?: number };

async function checkSql(cfg: AgentConfig): Promise<Check[]> {
  const checks: Check[] = [];
  const t0 = Date.now();
  try {
    const detail = await withPool(cfg, async (pool) => {
      const ver = await pool
        .request()
        .query<{ ver: string; edition: string | null; collation: string | null }>(
          `SELECT
             @@VERSION AS ver,
             CONVERT(NVARCHAR(128), SERVERPROPERTY('Edition')) AS edition,
             CONVERT(NVARCHAR(128), DATABASEPROPERTYEX(DB_NAME(), 'Collation')) AS collation`
        );
      const row = ver.recordset[0];
      const verLine = (row?.ver ?? "").split("\n")[0]?.trim() ?? "";
      return `${verLine} · edition=${row?.edition ?? "?"} · collation=${row?.collation ?? "?"}`;
    });
    checks.push({ label: "SQL Server connect+version", status: "ok", detail, durationMs: Date.now() - t0 });
  } catch (err) {
    checks.push({
      label: "SQL Server connect+version",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - t0,
    });
  }
  return checks;
}

async function checkSaas(cfg: AgentConfig): Promise<Check[]> {
  const checks: Check[] = [];
  const client = new SaasClient(cfg);

  const t1 = Date.now();
  try {
    const r = await client.heartbeat(10_000);
    checks.push({
      label: "SaaS heartbeat",
      status: "ok",
      detail: `tenant=${r.tenantSlug} serverTime=${r.serverTime}`,
      durationMs: Date.now() - t1,
    });
  } catch (err) {
    checks.push({
      label: "SaaS heartbeat",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - t1,
    });
    return checks; // sem heartbeat, não vale a pena tentar mais
  }

  const t2 = Date.now();
  try {
    const r = await client.listFarmacias(10_000);
    let detail = `${r.farmacias.length} farmácia(s)`;
    if (cfg.farmacia) {
      const isCuid = /^c[a-z0-9]{20,}$/i.test(cfg.farmacia);
      const match = isCuid
        ? r.farmacias.find((f) => f.id === cfg.farmacia)
        : r.farmacias.find((f) => f.nome.toLowerCase() === cfg.farmacia?.toLowerCase());
      if (match) detail += ` · bind ${match.nome} (${match.id}) estado=${match.estado}`;
      else detail += ` · ⚠ bind "${cfg.farmacia}" NÃO encontrado`;
    }
    checks.push({ label: "SaaS list farmácias", status: "ok", detail, durationMs: Date.now() - t2 });
  } catch (err) {
    checks.push({
      label: "SaaS list farmácias",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - t2,
    });
  }
  return checks;
}

export async function health(): Promise<number> {
  console.log("─".repeat(70));
  console.log("SPharm.MT agent — health");
  console.log("─".repeat(70));

  // Hostinfo (útil para diagnose remoto)
  console.log("Host:");
  console.log(`  hostname     ${os.hostname()}`);
  console.log(`  platform     ${process.platform} ${os.release()} (${os.arch()})`);
  console.log(`  node         ${process.version}`);
  console.log(`  pid          ${process.pid}`);
  console.log(`  cwd          ${process.cwd()}`);
  console.log(`  utc time     ${new Date().toISOString()}`);
  console.log("");

  let cfg: AgentConfig | null = null;
  try {
    cfg = loadConfig("both");
    console.log("Config:");
    for (const [k, v] of Object.entries(describeConfig(cfg))) {
      console.log(`  ${k.padEnd(20)} ${v}`);
    }
    console.log("");
  } catch (err) {
    console.error("Config: ✗ INVÁLIDA");
    console.error(err instanceof Error ? err.message : String(err));
    console.log("");
    console.log("Health terminado — corrige envs e re-tenta.");
    return 1;
  }

  console.log("Connectivity:");
  const sql = await checkSql(cfg);
  const saas = await checkSaas(cfg);
  const all = [...sql, ...saas];
  for (const c of all) {
    const mark = c.status === "ok" ? "✓" : c.status === "skip" ? "·" : "✗";
    const time = c.durationMs !== undefined ? ` (${c.durationMs}ms)` : "";
    console.log(`  ${mark} ${c.label.padEnd(30)}${time}`);
    console.log(`      ${c.detail}`);
  }
  console.log("");

  const failed = all.filter((c) => c.status === "fail");
  if (failed.length === 0) {
    console.log("✓ Health OK — agent pronto para sync.");
    return 0;
  }
  console.error(`✗ ${failed.length}/${all.length} verificação(ões) falharam.`);
  return 1;
}
