#!/usr/bin/env node
/**
 * agent/src/cli.ts
 *
 * Entrypoint do `spharmmt-agent`. Encaminha o primeiro positional
 * argument para o comando correspondente. Sem deps de CLI parsing —
 * cada comando trata os seus flags via `node:util.parseArgs`.
 *
 * Comandos disponíveis (v0.1):
 *   · test-connection
 *   · discover
 *   · health
 *
 * Planeados (próxima iteração, após mapping ERP→SPharm.MT):
 *   · bootstrap
 *   · daily-sync
 */

import { testConnection } from "./commands/test-connection.js";
import { discover } from "./commands/discover.js";
import { health } from "./commands/health.js";

type CommandFn = () => Promise<number>;

const COMMANDS: Record<string, { run: CommandFn; desc: string }> = {
  "test-connection": {
    run: testConnection,
    desc: "Valida config + SQL Server + SaaS connectivity. Fail-fast.",
  },
  discover: {
    run: discover,
    desc: "Lê metadata do ERP SQL Server (read-only). Output em output/.",
  },
  health: {
    run: health,
    desc: "Resumo de config + connectivity + diagnóstico verboso.",
  },
};

function printHelp(): void {
  console.log("spharmmt-agent — SPharm.MT local agent (SQL Server)");
  console.log("");
  console.log("Uso:");
  console.log("  spharmmt-agent <comando>");
  console.log("  npm run agent <comando>");
  console.log("");
  console.log("Comandos:");
  const w = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
  for (const [name, info] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(w + 2)} ${info.desc}`);
  }
  console.log("");
  console.log("Config: copia .env.example para .env e preenche.");
  console.log("Docs:   ver agent/README.md");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    printHelp();
    process.exit(cmd ? 0 : 1);
    return;
  }

  const entry = COMMANDS[cmd];
  if (!entry) {
    console.error(`✗ Comando desconhecido: ${cmd}`);
    console.error("");
    printHelp();
    process.exit(1);
    return;
  }

  try {
    const exitCode = await entry.run();
    process.exit(exitCode);
  } catch (err) {
    console.error("[fatal]", err instanceof Error ? err.message : err);
    if (err instanceof Error && err.stack) {
      console.error(err.stack.split("\n").slice(1, 4).join("\n"));
    }
    process.exit(1);
  }
}

main();
