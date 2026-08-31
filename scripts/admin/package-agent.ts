/**
 * scripts/admin/package-agent.ts
 *
 * Gera um pacote agent pronto para entrega ao operador on-prem:
 *   1. Lê tenant do control plane (--tenant=slug)
 *   2. Gera nova ingest key (default) OU usa --key=<plain>
 *   3. Copia o dist-agent/SPharmMT-Agent/ (build base) para
 *      dist-agent/clients/<slug>-<date>-<rand>/
 *   4. Escreve agent.config.json preenchido (saas + farmacia + opcional
 *      healthcheckUrl + placeholders SQL Server que o operador completa)
 *   5. Zipa a pasta
 *   6. Imprime caminho do ZIP + chave em claro UMA VEZ (não recuperável)
 *
 * Uso:
 *   # Variante recomendada (fresh provisioning): roda key + zip
 *   npm run admin:package-agent -- \
 *     --tenant farm-pilot-1 \
 *     --farmacia "Farmácia Internacional" \
 *     --endpoint https://app.spharmmt.com
 *
 *   # Variante: usar key existente (e.g. já entregue ao operador)
 *   npm run admin:package-agent -- \
 *     --tenant farm-pilot-1 \
 *     --farmacia "Farmácia Internacional" \
 *     --key <64-hex-chars>
 *
 *   # Opcional: pré-preencher SQL + healthcheck
 *   npm run admin:package-agent -- \
 *     --tenant farm-pilot-1 \
 *     --farmacia "Farmácia Internacional" \
 *     --sql-host SQLBOX --sql-database SPHARM \
 *     --healthcheck-url https://hc-ping.com/<uuid>
 *
 * Pré-requisitos:
 *   · build base actualizado: `npm run agent:package` produz
 *     dist-agent/SPharmMT-Agent/ — este script COPIA dessa pasta.
 *     Reexecutar se houve mudanças no agent desde o último build.
 *   · tenant existe e está ACTIVE (cria primeiro via `tenant:create`).
 *
 * Sem refactor da provision pipeline; apenas embrulhar o que já existe.
 */

import "dotenv/config";
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { controlPrisma, getTenantBySlug, logTenantEvent } from "@/lib/control-plane";

const BCRYPT_COST = 10;
const KEY_BYTES = 32;
const HEX_KEY_RE = /^[0-9a-f]{64}$/i;

const REPO_ROOT = process.cwd();
const BASE_AGENT_DIR = path.join(REPO_ROOT, "dist-agent", "SPharmMT-Agent");
const CLIENTS_ROOT = path.join(REPO_ROOT, "dist-agent", "clients");

type Args = {
  tenant?: string;
  farmacia?: string;
  endpoint?: string;
  key?: string;
  rotate?: boolean;
  healthcheckUrl?: string;
  sqlHost?: string;
  sqlPort?: string;
  sqlDatabase?: string;
  sqlUser?: string;
  sqlPassword?: string;
  output?: string;
};

function parseCmdArgs(): Args {
  const { values } = parseArgs({
    options: {
      tenant: { type: "string" },
      farmacia: { type: "string" },
      endpoint: { type: "string" },
      key: { type: "string" },
      rotate: { type: "boolean", default: false },
      "healthcheck-url": { type: "string" },
      "sql-host": { type: "string" },
      "sql-port": { type: "string" },
      "sql-database": { type: "string" },
      "sql-user": { type: "string" },
      "sql-password": { type: "string" },
      output: { type: "string" },
    },
    strict: true,
  });
  return {
    tenant: values.tenant,
    farmacia: values.farmacia,
    endpoint: values.endpoint,
    key: values.key,
    rotate: values.rotate === true,
    healthcheckUrl: values["healthcheck-url"],
    sqlHost: values["sql-host"],
    sqlPort: values["sql-port"],
    sqlDatabase: values["sql-database"],
    sqlUser: values["sql-user"],
    sqlPassword: values["sql-password"],
    output: values.output,
  };
}

async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyDirRecursive(s, d);
    else if (entry.isFile()) await fs.copyFile(s, d);
    // symlinks e outros: ignorados intencionalmente
  }
}

function zipDir(srcDir: string, zipPath: string): void {
  // Usa Compress-Archive (Windows) ou `zip` (Unix). Sem dependências
  // npm — não vale para uma tarefa pontual.
  if (process.platform === "win32") {
    const r = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Compress-Archive -Path '${srcDir}\\*' -DestinationPath '${zipPath}' -Force`,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    if (r.status !== 0) {
      throw new Error(`zip falhou: ${r.stderr || r.stdout || "exit " + r.status}`);
    }
    return;
  }
  // Unix
  const r = spawnSync("zip", ["-r", zipPath, "."], {
    cwd: srcDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) {
    throw new Error(`zip falhou: ${r.stderr || r.stdout || "exit " + r.status}`);
  }
}

async function main(): Promise<void> {
  const args = parseCmdArgs();
  const errs: string[] = [];
  if (!args.tenant) errs.push("--tenant <slug> é obrigatório.");
  if (!args.farmacia) errs.push("--farmacia <nome> é obrigatório.");
  if (args.key && args.rotate) errs.push("--key e --rotate são mutuamente exclusivos.");
  if (args.key && !HEX_KEY_RE.test(args.key)) {
    errs.push("--key deve ser 64 chars hex (256-bit).");
  }
  if (!existsSync(BASE_AGENT_DIR)) {
    errs.push(`Build base em falta: ${BASE_AGENT_DIR}. Correr 'npm run agent:package' primeiro.`);
  }
  if (errs.length > 0) {
    console.error("✗ Argumentos inválidos:");
    for (const e of errs) console.error("  ·", e);
    process.exit(1);
  }

  const tenant = await getTenantBySlug(args.tenant!);
  if (!tenant) {
    console.error(`✗ Tenant "${args.tenant}" não encontrado no control plane.`);
    console.error(`  Cria via 'npm run tenant:create' antes.`);
    process.exit(1);
  }
  if (tenant.estado !== "ACTIVE") {
    console.error(`✗ Tenant "${args.tenant}" está em estado ${tenant.estado}. Só ACTIVE pode receber agents.`);
    process.exit(1);
  }

  // Sem default de domínio. O literal que aqui estava sobreviveu à
  // mudança de domínio de produção e produzia agents apontados ao sítio
  // errado sem um único aviso — o erro só aparecia na farmácia, no
  // primeiro heartbeat.
  // A ordem é a mesma de lib/admin/ops/agent-package.ts, que já falha
  // em vez de adivinhar.
  const endpoint = (
    args.endpoint ??
    process.env.SPHARMMT_PUBLIC_ENDPOINT ??
    process.env.PUBLIC_APP_URL ??
    ""
  ).trim();
  if (!endpoint) {
    console.error("✗ endpoint não configurado.");
    console.error("  Indica --endpoint=https://… ou define SPHARMMT_PUBLIC_ENDPOINT / PUBLIC_APP_URL.");
    process.exit(1);
  }
  if (!/^https?:\/\//.test(endpoint)) {
    console.error(`✗ --endpoint inválido: ${endpoint}`);
    process.exit(1);
  }

  /* ─── 1. Resolver ingest key ─────────────────────────────────────── */
  let plainKey: string | null = null;
  let keyAction: "rotated" | "issued" | "provided" = "provided";

  if (args.key) {
    plainKey = args.key.toLowerCase();
    // Nota: NÃO validamos contra o hash em DB (bcrypt seria o caminho,
    // mas é caro e o admin é responsável). Confiamos no que o admin passa.
  } else {
    // Default: gerar fresh (com --rotate explícito OU se tenant nunca teve key).
    if (tenant.ingestApiKeyHash && !args.rotate) {
      console.error(`✗ Tenant "${tenant.slug}" já tem ingest key emitida.`);
      console.error(`  Opções:`);
      console.error(`    --key <plain>   → usa a key existente (admin precisa de a ter)`);
      console.error(`    --rotate        → INVALIDA a anterior e gera nova`);
      process.exit(1);
    }
    plainKey = randomBytes(KEY_BYTES).toString("hex");
    const hash = await bcrypt.hash(plainKey, BCRYPT_COST);
    const issuedAt = new Date();
    await controlPrisma.tenant.update({
      where: { id: tenant.id },
      data: { ingestApiKeyHash: hash, ingestApiKeyIssuedAt: issuedAt },
    });
    await logTenantEvent({
      tenantId: tenant.id,
      action: args.rotate ? "ingest_key_rotated" : "ingest_key_issued",
      meta: { issuedAt: issuedAt.toISOString(), via: "package-agent" },
    });
    keyAction = args.rotate ? "rotated" : "issued";
  }

  /* ─── 2. Construir agent.config.json ─────────────────────────────── */
  const cfg = {
    _doc:
      `Configuração SPharm.MT agent para tenant=${tenant.slug}. ` +
      `Gerado por scripts/admin/package-agent.ts em ${new Date().toISOString()}. ` +
      `NUNCA commitar este ficheiro nem partilhar fora do contexto seguro.`,
    saas: {
      endpoint,
      tenantSlug: tenant.slug,
      ingestKey: plainKey,
      farmacia: args.farmacia,
      ...(args.healthcheckUrl ? { healthcheckUrl: args.healthcheckUrl } : {}),
    },
    sqlServer: {
      host: args.sqlHost ?? "localhost",
      port: args.sqlPort ? parseInt(args.sqlPort, 10) : 1433,
      database: args.sqlDatabase ?? "SPHARM",
      user: args.sqlUser ?? "spharm_readonly",
      password: args.sqlPassword ?? "COMPLETAR_PASSWORD_NO_PC_DA_FARMACIA",
      encrypt: false,
      trustServerCertificate: true,
    },
    options: {
      outputDir: "output",
      agentVersion: "0.1.0",
    },
  };

  /* ─── 3. Copiar + escrever config + zipar ────────────────────────── */
  const date = new Date().toISOString().slice(0, 10);
  const stamp = randomBytes(3).toString("hex");
  const clientDirName = `${tenant.slug}-${date}-${stamp}`;
  const clientDir = args.output
    ? path.resolve(args.output)
    : path.join(CLIENTS_ROOT, clientDirName);

  mkdirSync(path.dirname(clientDir), { recursive: true });
  if (existsSync(clientDir)) {
    console.error(`✗ Output directory já existe: ${clientDir}. Apaga ou usa outro --output.`);
    process.exit(1);
  }

  console.log("─".repeat(78));
  console.log(`package-agent — ${tenant.slug} → ${path.relative(REPO_ROOT, clientDir)}`);
  console.log("─".repeat(78));
  console.log("");
  console.log(`▶ Copy base agent → ${clientDir}`);
  await copyDirRecursive(BASE_AGENT_DIR, clientDir);

  // Substitui (sobrescreve) o agent.config.example.json pelo agent.config.json real.
  // Operador no PC só precisa de editar password SQL se ficou placeholder.
  const cfgPath = path.join(clientDir, "agent.config.json");
  await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");

  const zipPath = `${clientDir}.zip`;
  console.log(`▶ Zip → ${path.relative(REPO_ROOT, zipPath)}`);
  zipDir(clientDir, zipPath);

  const zipStat = await fs.stat(zipPath);
  console.log(`  ${(zipStat.size / 1024 / 1024).toFixed(1)} MB`);
  console.log("");

  /* ─── 4. Summary + chave em claro ────────────────────────────────── */
  console.log("─".repeat(78));
  console.log(`✓ PACOTE CRIADO`);
  console.log("─".repeat(78));
  console.log(`Tenant       : ${tenant.nome} (slug=${tenant.slug})`);
  console.log(`Farmácia     : ${args.farmacia}`);
  console.log(`Endpoint     : ${endpoint}`);
  console.log(`Healthcheck  : ${args.healthcheckUrl ?? "(não configurado)"}`);
  console.log(`SQL Server   : host=${cfg.sqlServer.host} db=${cfg.sqlServer.database}`);
  if (cfg.sqlServer.password === "COMPLETAR_PASSWORD_NO_PC_DA_FARMACIA") {
    console.log(`  ⚠ password placeholder — operador completa no PC da farmácia`);
  }
  console.log(`Output dir   : ${clientDir}`);
  console.log(`ZIP          : ${zipPath}`);
  console.log("");

  if (keyAction !== "provided") {
    console.log("─".repeat(78));
    console.log(`INGEST KEY ${keyAction.toUpperCase()} — anotar agora (não é recuperável):`);
    console.log("─".repeat(78));
    console.log(`  ${plainKey}`);
    if (keyAction === "rotated") {
      console.log(`  ⚠ A key anterior foi INVALIDADA. Agents que usem a antiga vão receber 401.`);
    }
    console.log("");
  } else {
    console.log(`Ingest key   : (usaste --key explicitamente; sem mudança no control plane)`);
    console.log("");
  }

  console.log("Próximos passos no PC da farmácia:");
  console.log(`  1. Copiar ${path.basename(zipPath)} para C:\\spharmmt\\agent\\`);
  console.log(`  2. Extrair`);
  if (cfg.sqlServer.password === "COMPLETAR_PASSWORD_NO_PC_DA_FARMACIA") {
    console.log(`  3. Editar agent.config.json e completar sqlServer.password`);
  }
  console.log(`  4. Correr run-test-connection.bat para validar`);
  console.log(`  5. Configurar Task Scheduler com run-daily-pipeline-auto.bat`);
  console.log(`     (ver docs/daily-pipeline-task-scheduler.md)`);
}

main()
  .catch((err) => {
    console.error("[fatal]", err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => controlPrisma.$disconnect());
