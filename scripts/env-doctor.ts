/**
 * scripts/env-doctor.ts
 *
 * Health check de envs. Imprime estado por scope com legenda
 * accionável. Exit code != 0 se algum scope `required` está incompleto.
 *
 * Uso:
 *   npm run env:doctor
 *   npm run env:doctor -- --scope=web
 *   npm run env:doctor -- --quiet  (só linha final + exit code)
 */

import "dotenv/config";
import { auditEnv, isScopeReady, type EnvScope } from "../lib/env";

type Args = { scope: EnvScope | null; quiet: boolean };

function parseArgs(): Args {
  const out: Args = { scope: null, quiet: false };
  for (const a of process.argv.slice(2)) {
    if (a === "--quiet") out.quiet = true;
    else if (a.startsWith("--scope=")) {
      const s = a.split("=")[1] as EnvScope;
      if (["web", "cron", "cli", "ingest"].includes(s)) out.scope = s;
    }
  }
  return out;
}

const SCOPES: EnvScope[] = ["web", "cron", "cli", "ingest"];

function main(): number {
  const args = parseArgs();
  const audit = auditEnv();

  if (!args.quiet) {
    console.log("─".repeat(78));
    console.log("SPharm.MT — env doctor");
    console.log("─".repeat(78));
  }

  const scopes = args.scope ? [args.scope] : SCOPES;
  let unhealthy = 0;

  for (const scope of scopes) {
    const status = isScopeReady(scope);
    if (!args.quiet) {
      console.log(`\n[${scope}] ${status.ready ? "✅ ready" : "❌ NOT ready"}`);
      if (!status.ready) {
        for (const m of status.missing) console.log(`     · missing: ${m}`);
      }
    }
    if (!status.ready) unhealthy++;
  }

  if (!args.quiet) {
    console.log("\n" + "─".repeat(78));
    console.log("Detalhe por env:");
    console.log("─".repeat(78));
    for (const e of audit) {
      const mark = e.present ? "✓" : e.level === "required" ? "✗" : "·";
      const lvl = e.level.padEnd(11);
      const sc = e.scopes.join(",").padEnd(20);
      console.log(`  ${mark} ${lvl} ${sc} ${e.name}`);
    }
  }

  console.log("\n" + "─".repeat(78));
  if (unhealthy === 0) {
    console.log(`✅ ${scopes.length} scope(s) prontos`);
    return 0;
  }
  console.log(`❌ ${unhealthy}/${scopes.length} scope(s) NOT ready — fix antes de operar.`);
  return 1;
}

const code = main();
process.exit(code);
