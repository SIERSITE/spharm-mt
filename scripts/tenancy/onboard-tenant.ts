/**
 * scripts/tenancy/onboard-tenant.ts
 *
 * Comando único para onboard de novo grupo de farmácias. Encadeia:
 *
 *   1. provision-tenant.ts        → cria role+db, migra schema, seed admin, marca ACTIVE
 *   2. smoke-test-resolver.ts     → valida resolução tenant + queries básicas
 *   3. checklist accionável       → o que falta o operador fazer (manual)
 *
 * Falha-rápido: se qualquer passo falhar, pára e imprime o que ficou
 * pendente para o operador resolver. Não tenta cleanup automático
 * porque provision-tenant.ts já tem rollback parcial; etapas posteriores
 * são idempotentes (re-correr é seguro).
 *
 * Uso:
 *   npm run tenant:onboard -- \
 *     --slug farmacias-braga \
 *     --nome "Grupo Farmácias de Braga" \
 *     --admin-email admin@braga.pt \
 *     [--admin-password <plain>] \
 *     [--admin-nome "Admin Braga"] \
 *     [--skip-smoke]
 */

import "dotenv/config";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { parseArgs } from "node:util";

type Outcome = { name: string; ok: boolean; durationMs: number; detail?: string };

function runStep(name: string, script: string, extraArgs: string[]): Outcome {
  const t0 = Date.now();
  console.log("\n" + "═".repeat(78));
  console.log(`▶ ${name}`);
  console.log("═".repeat(78));
  const cmd = process.platform === "win32" ? "npx.cmd" : "npx";
  const fullScript = path.resolve(script);
  const result = spawnSync(cmd, ["tsx", fullScript, ...extraArgs], {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
  const ok = result.status === 0;
  return {
    name,
    ok,
    durationMs: Date.now() - t0,
    detail: ok ? undefined : `exit code ${result.status}`,
  };
}

function printChecklist(slug: string): void {
  console.log("\n" + "═".repeat(78));
  console.log("Checklist operacional pós-onboarding");
  console.log("═".repeat(78));
  console.log(`Tenant: ${slug}`);
  console.log("");
  console.log("[ ] 1. Emitir ingest API key:");
  console.log(`        npm run tenancy:issue-ingest-key -- --slug=${slug}`);
  console.log("        (mostra a key em claro UMA VEZ — anota-a)");
  console.log("");
  console.log("[ ] 2. Ingest agent — configurar uma de duas vias:");
  console.log("");
  console.log("        2a) CLI agent (folder mode):");
  console.log(`            npm run agent:ingest-folder -- \\`);
  console.log(`              --tenant=${slug} --farmacia=<nome ou cuid> \\`);
  console.log(`              --input=<pasta> --endpoint=<baseUrl> \\`);
  console.log(`              --key=<key emitida no passo 1> --once`);
  console.log("");
  console.log("        2b) HTTP directo (curl etc):");
  console.log(`            POST <baseUrl>/api/ingest/v1/snapshot/stock`);
  console.log(`            Authorization: Bearer <key>`);
  console.log(`            X-Tenant-Slug: ${slug}`);
  console.log("");
  console.log("[ ] 3. Confirmar primeiro heartbeat / first sync:");
  console.log(`        Abrir /admin — coluna 'Last sync' e 'Heartbeat'`);
  console.log("");
  console.log("[ ] 4. Validar primeiros dados ingeridos:");
  console.log(`        npm run tenancy:health -- --slug=${slug}`);
  console.log("");
  console.log("[ ] 5. Refresh IPF + verificar dashboard:");
  console.log(`        npx tsx scripts/jobs/refresh-ipf.ts --tenant=${slug}`);
  console.log(`        Abrir /dashboard no tenant`);
  console.log("");
  console.log("[ ] 6. Registar primeiro backup:");
  console.log(`        (manual no provider Neon; depois actualizar Tenant.lastBackupAt)`);
  console.log("");
  console.log("[ ] 7. Comunicar ao grupo:");
  console.log(`        - URL: https://${slug}.<domain> (ou domínio equivalente)`);
  console.log(`        - Credencial admin entregue pelo CLI no passo provision`);
  console.log("");
  console.log("Documentos de referência:");
  console.log("  · notes/tenant-onboarding.md");
  console.log("  · notes/ingestion-agent-folder-mode.md");
  console.log("  · notes/pilot-bootstrap-report.md");
}

function main(): void {
  const t0 = Date.now();
  const { values } = parseArgs({
    options: {
      slug: { type: "string" },
      nome: { type: "string" },
      "admin-email": { type: "string" },
      "admin-password": { type: "string" },
      "admin-nome": { type: "string" },
      "farmacia-inicial": { type: "string" },
      "skip-smoke": { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const slug = values.slug;
  const nome = values.nome;
  const adminEmail = values["admin-email"];
  if (!slug || !nome || !adminEmail) {
    console.error(
      "Uso: --slug X --nome \"Y\" --admin-email E [--admin-password P] [--admin-nome N] [--farmacia-inicial \"<Nome>\"] [--skip-smoke]",
    );
    process.exit(1);
  }

  const provisionArgs = [
    `--slug=${slug}`,
    `--nome=${nome}`,
    `--admin-email=${adminEmail}`,
  ];
  if (values["admin-password"]) provisionArgs.push(`--admin-password=${values["admin-password"]}`);
  if (values["admin-nome"]) provisionArgs.push(`--admin-nome=${values["admin-nome"]}`);
  if (values["farmacia-inicial"]) provisionArgs.push(`--farmacia-inicial=${values["farmacia-inicial"]}`);

  const outcomes: Outcome[] = [];

  // ── 1. Provision ─────────────────────────────────────────────────
  const provision = runStep(
    "1/2 Provisioning (create role+db, migrate, seed admin, activate)",
    "scripts/tenancy/provision-tenant.ts",
    provisionArgs,
  );
  outcomes.push(provision);
  if (!provision.ok) {
    console.error(`\n✗ Provision falhou: ${provision.detail}`);
    console.error(`  Investigar Tenant no control plane — pode estar em FAILED ou PROVISIONING.`);
    console.error(`  Usar: npm run tenancy:list para ver estado.`);
    process.exit(1);
  }

  // ── 2. Smoke test (opcional, default ON) ─────────────────────────
  if (!values["skip-smoke"]) {
    const smoke = runStep(
      "2/2 Smoke test do resolver tenant",
      "scripts/tenancy/smoke-test-resolver.ts",
      [],
    );
    outcomes.push(smoke);
    if (!smoke.ok) {
      console.error(`\n⚠ Smoke test falhou: ${smoke.detail}`);
      console.error(`  Provision concluiu mas resolver tem problema.`);
      console.error(`  Tenant ${slug} está em ACTIVE — fix manual no resolver/registry.`);
      process.exit(1);
    }
  }

  // ── Resumo + checklist ──────────────────────────────────────────
  console.log("\n" + "═".repeat(78));
  console.log("Onboard concluído");
  console.log("═".repeat(78));
  for (const o of outcomes) {
    console.log(`  ${o.ok ? "✓" : "✗"} ${o.name} (${(o.durationMs / 1000).toFixed(1)}s)`);
  }
  console.log(`Total: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  printChecklist(slug);
}

main();
