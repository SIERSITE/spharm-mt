/**
 * agent/src/commands/test-connection.ts
 *
 * Valida fail-fast que o agent tem tudo o que precisa para sync:
 *  1. envs presentes e formato válido
 *  2. SQL Server local respond a SELECT 1
 *  3. SaaS endpoint respond a POST /api/outbox/v1/heartbeat
 *  4. tenant + ingest key são válidos (verificado pelo heartbeat)
 *  5. /api/ingest/v1/farmacias devolve lista — confirma autorização
 *     de leitura cruzada com o tenant.
 *
 * Saída resumida no stdout. Exit 0 quando tudo OK, 1 se qualquer
 * verificação falhar. Adequado para correr como pré-flight antes de
 * `discover` ou `bootstrap`.
 */

import { loadConfig, describeConfig, type AgentConfig } from "../config.js";
import { withPool } from "../sql-client.js";
import { SaasClient, SaasApiError } from "../http-client.js";

type CheckResult = { name: string; ok: boolean; durationMs: number; detail?: string };

async function runCheck(name: string, fn: () => Promise<string | void>): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    const detail = await fn();
    return { name, ok: true, durationMs: Date.now() - t0, detail: detail ?? undefined };
  } catch (err) {
    return {
      name,
      ok: false,
      durationMs: Date.now() - t0,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function testConnection(): Promise<number> {
  let cfg: AgentConfig;
  try {
    cfg = loadConfig("both");
  } catch (err) {
    console.error("✗ Config inválida:");
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  console.log("─".repeat(70));
  console.log("SPharm.MT agent — test-connection");
  console.log("─".repeat(70));
  for (const [k, v] of Object.entries(describeConfig(cfg))) {
    console.log(`  ${k.padEnd(20)} ${v}`);
  }
  console.log("─".repeat(70));
  console.log("");

  const results: CheckResult[] = [];

  // 1. SQL Server: SELECT 1
  results.push(
    await runCheck("SQL Server SELECT 1", async () => {
      return await withPool(cfg, async (pool) => {
        const r = await pool.request().query<{ ok: number }>("SELECT 1 AS ok");
        if (r.recordset[0]?.ok !== 1) {
          throw new Error(`shape inesperado: ${JSON.stringify(r.recordset)}`);
        }
        return "OK";
      });
    })
  );

  // 2. SaaS heartbeat
  const client = new SaasClient(cfg);
  results.push(
    await runCheck("SaaS heartbeat", async () => {
      const r = await client.heartbeat(10_000);
      if (!r.ok) throw new Error(`heartbeat devolveu ok=false`);
      if (r.tenantSlug !== cfg.tenantSlug) {
        throw new Error(`tenant mismatch: server=${r.tenantSlug} local=${cfg.tenantSlug}`);
      }
      return `tenant=${r.tenantSlug} serverTime=${r.serverTime}`;
    })
  );

  // 3. SaaS list farmacias (autorização de leitura)
  results.push(
    await runCheck("SaaS list farmácias", async () => {
      const r = await client.listFarmacias(10_000);
      if (!r.ok) throw new Error("list devolveu ok=false");
      const count = r.farmacias.length;
      if (cfg.farmacia) {
        const isCuid = /^c[a-z0-9]{20,}$/i.test(cfg.farmacia);
        const match = isCuid
          ? r.farmacias.find((f) => f.id === cfg.farmacia)
          : r.farmacias.find((f) => f.nome.toLowerCase() === cfg.farmacia?.toLowerCase());
        if (!match) {
          throw new Error(
            `farmácia "${cfg.farmacia}" não encontrada no tenant (${count} disponíveis: ${r.farmacias
              .map((f) => f.nome)
              .slice(0, 5)
              .join(", ")}${count > 5 ? "…" : ""})`
          );
        }
        return `farmácia ${match.nome} resolvida → ${match.id} (estado=${match.estado})`;
      }
      return `${count} farmácia(s) no tenant`;
    })
  );

  console.log("Resultados:");
  for (const r of results) {
    const mark = r.ok ? "✓" : "✗";
    const time = `(${r.durationMs}ms)`;
    console.log(`  ${mark} ${r.name.padEnd(28)} ${time}${r.detail ? `  ${r.detail}` : ""}`);
  }
  console.log("");

  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) {
    console.log("✓ Tudo OK — pronto para `discover`.");
    return 0;
  }

  console.error(`✗ ${failed.length}/${results.length} check(s) falharam. Detalhes acima.`);
  // Dicas accionáveis por tipo de erro
  for (const r of failed) {
    if (r.name.includes("SQL Server") && r.detail) {
      const m = r.detail;
      if (/login failed/i.test(m)) console.error("    → Verifica ERP_SQLSERVER_USER/PASSWORD e SQL Authentication (Mixed Mode).");
      else if (/connect|ETIMEDOUT|ECONNREFUSED/i.test(m)) console.error("    → Verifica ERP_SQLSERVER_HOST/PORT e firewall do servidor SQL.");
      else if (/database.*does not exist/i.test(m)) console.error("    → ERP_SQLSERVER_DATABASE não existe nessa instância.");
    }
    if (r.name.includes("SaaS") && r.detail) {
      if (r.detail.includes("HTTP 401")) console.error("    → Ingest key inválida ou revogada. Pede nova via `tenancy:issue-ingest-key --rotate`.");
      else if (r.detail.includes("HTTP 404")) console.error("    → tenantSlug não encontrado no control plane. Verifica SPHARMMT_TENANT_SLUG.");
      else if (r.detail.includes("HTTP 500")) console.error("    → Erro server-side. Verifica que o control plane (CONTROL_DATABASE_URL) está configurado no SaaS.");
      else if (r.detail.includes("falha de rede")) console.error("    → DNS/firewall do servidor da farmácia. Testa: curl -I " + cfg.saasEndpoint);
    }
  }
  return 1;
}
