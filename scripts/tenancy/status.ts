/**
 * scripts/tenancy/status.ts
 *
 * Read-only diagnose de um tenant. Output formatado em texto +
 * exit code 0 quando tudo OK (ou warnings esperáveis), 1 quando há
 * faltas operacionais. Útil para admin confirmar onboarding antes
 * de entregar ZIP ao operador.
 *
 * Mostra:
 *   · Control plane: estado, provisionedAt, schemaVersion, ingest key
 *     presente, DB host/name
 *   · Tenant DB: conectividade, migrations finished, total counts
 *   · Farmácias activas
 *   · Pipeline: último run por kind (daily-pipeline, aggregate, daily-sync)
 *   · VendaMensal: mês mais recente + total rows
 *   · Staging: UNKNOWN + operational orphans
 *
 * Não modifica nada. Não toca em farmácias nem dados.
 *
 * Uso:
 *   npm run tenancy:status -- --tenant demo-neon
 */

import "dotenv/config";
import { parseArgs } from "node:util";
import {
  controlPrisma,
  getTenantBySlug,
  buildTenantConnectionString,
} from "@/lib/control-plane";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { PIPELINE_KIND, PIPELINE_STATUS } from "@/lib/pipeline/types";
import { requireControlEnv } from "./_shared";

type Args = { tenant?: string };

function parseCmdArgs(): Args {
  const { values } = parseArgs({
    options: { tenant: { type: "string" } },
    strict: true,
  });
  return { tenant: values.tenant };
}

function fmtAge(d: Date | null | undefined): string {
  if (!d) return "—";
  const ms = Date.now() - d.getTime();
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s atrás`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m atrás`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h atrás`;
  const days = Math.round(h / 24);
  return `${days}d atrás`;
}

function fmtIso(d: Date | null | undefined): string {
  if (!d) return "—";
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function glyph(s: "ok" | "warn" | "fail"): string {
  return s === "ok" ? "✓" : s === "warn" ? "⚠" : "✗";
}

async function main() {
  requireControlEnv();
  const args = parseCmdArgs();
  if (!args.tenant) {
    console.error("✗ --tenant <slug> é obrigatório.");
    process.exit(1);
  }

  // ── Control plane ──────────────────────────────────────────────────
  const tenant = await getTenantBySlug(args.tenant);
  if (!tenant) {
    console.error(`✗ Tenant "${args.tenant}" não existe no control plane.`);
    process.exit(1);
  }

  console.log("─".repeat(78));
  console.log(`tenancy:status — ${tenant.slug}`);
  console.log("─".repeat(78));
  console.log("");
  console.log("Control plane");
  console.log("─".repeat(40));
  const tenantOk = tenant.estado === "ACTIVE";
  const keyOk = !!tenant.ingestApiKeyHash;
  console.log(`  ${glyph(tenantOk ? "ok" : "fail")} estado          : ${tenant.estado}`);
  console.log(`     nome            : ${tenant.nome}`);
  console.log(`     id              : ${tenant.id}`);
  console.log(`     DB              : ${tenant.dbName}@${tenant.dbHost}:${tenant.dbPort}`);
  console.log(`     provisionedAt   : ${fmtIso(tenant.provisionedAt)}`);
  console.log(`     schemaVersion   : ${tenant.schemaVersion ?? "—"}`);
  console.log(`     region          : ${tenant.dbRegion ?? "—"}`);
  console.log(`  ${glyph(keyOk ? "ok" : "fail")} ingest key      : ${keyOk ? `gerada em ${fmtIso(tenant.ingestApiKeyIssuedAt)}` : "(não emitida)"}`);
  console.log("");

  if (!tenantOk) {
    console.error("Status global: ✗ tenant não está ACTIVE.");
    await controlPrisma.$disconnect();
    process.exit(1);
  }

  // ── Tenant DB ─────────────────────────────────────────────────────
  const url = buildTenantConnectionString(tenant);
  const adapter = new PrismaPg({ connectionString: url });
  const prisma = new PrismaClient({ adapter });

  let dbReachable = false;
  try {
    await prisma.$queryRaw`SELECT 1 AS ok`;
    dbReachable = true;
  } catch (err) {
    console.log("Tenant DB");
    console.log("─".repeat(40));
    console.log(`  ✗ não foi possível conectar: ${err instanceof Error ? err.message : err}`);
    console.log("");
    await prisma.$disconnect();
    await controlPrisma.$disconnect();
    process.exit(1);
  }

  console.log("Tenant DB");
  console.log("─".repeat(40));
  console.log(`  ${glyph("ok")} conectividade  : OK`);

  // Migrations: count + name da última
  let lastMigration: string | null = null;
  let unfinishedCount = 0;
  let migrationsTotal = 0;
  try {
    const rows = await prisma.$queryRaw<
      Array<{ name: string; finished: Date | null }>
    >`
      SELECT migration_name AS "name", finished_at AS "finished"
      FROM _prisma_migrations
      ORDER BY finished_at DESC NULLS FIRST
    `;
    migrationsTotal = rows.length;
    unfinishedCount = rows.filter((r) => r.finished === null).length;
    lastMigration = rows[0]?.name ?? null;
  } catch (err) {
    console.log(`  ✗ migrations    : erro a ler _prisma_migrations: ${err instanceof Error ? err.message : err}`);
  }
  console.log(
    `  ${glyph(unfinishedCount === 0 ? "ok" : "fail")} migrations     : ${migrationsTotal} aplicadas` +
      (unfinishedCount > 0 ? ` (${unfinishedCount} sem finished_at)` : "") +
      (lastMigration ? `, última: ${lastMigration}` : "")
  );

  // Farmácias
  const farmacias = await prisma.farmacia.findMany({
    select: { id: true, nome: true, codigoANF: true, estado: true },
    orderBy: { nome: "asc" },
  });
  const farmaciasAtivas = farmacias.filter((f) => f.estado === "ATIVO").length;
  console.log(
    `  ${glyph(farmaciasAtivas > 0 ? "ok" : "fail")} farmácias      : ${farmaciasAtivas} ATIVO` +
      (farmacias.length > farmaciasAtivas ? `, ${farmacias.length - farmaciasAtivas} outras` : "")
  );
  for (const f of farmacias) {
    const tone = f.estado === "ATIVO" ? "·" : "⚠";
    console.log(
      `      ${tone} ${f.nome.padEnd(38)} ${(f.codigoANF ?? "—").padEnd(10)} ${f.estado}`
    );
  }
  console.log("");

  // ── Pipeline ─────────────────────────────────────────────────────
  console.log("Pipeline");
  console.log("─".repeat(40));
  const [lastDaily, lastAgg, lastSync] = await Promise.all([
    prisma.pipelineRun.findFirst({
      where: { kind: PIPELINE_KIND.DAILY },
      orderBy: { startedAt: "desc" },
    }),
    prisma.pipelineRun.findFirst({
      where: { kind: PIPELINE_KIND.AGGREGATE },
      orderBy: { startedAt: "desc" },
    }),
    prisma.pipelineRun.findFirst({
      where: { kind: PIPELINE_KIND.DAILY_SYNC },
      orderBy: { startedAt: "desc" },
    }),
  ]);
  function renderRun(label: string, run: typeof lastDaily): void {
    if (!run) {
      console.log(`  · ${label.padEnd(28)} (sem execuções)`);
      return;
    }
    const isOk = run.status === PIPELINE_STATUS.OK;
    console.log(
      `  ${glyph(isOk ? "ok" : "warn")} ${label.padEnd(28)} ${run.status.padEnd(8)} ${fmtAge(run.startedAt).padEnd(10)} ${run.dateRef ? `ref=${run.dateRef}` : ""}`
    );
    if (run.errorMessage) {
      console.log(`      ↳ ${run.errorMessage.slice(0, 100)}`);
    }
  }
  renderRun("daily-pipeline (auto)", lastDaily);
  renderRun("aggregate-month", lastAgg);
  renderRun("daily-sync (standalone)", lastSync);
  console.log("");

  // ── VendaMensal + staging ─────────────────────────────────────────
  console.log("Dados");
  console.log("─".repeat(40));
  const [vmRows, vmLastMonth, stagingUnknowns, stagingOrphans, stagingServices] =
    await Promise.all([
      prisma.vendaMensal.count(),
      prisma.vendaMensal.findFirst({
        where: { origemAgregacao: "agent-bootstrap-staging" },
        orderBy: [{ ano: "desc" }, { mes: "desc" }],
        select: { ano: true, mes: true },
      }),
      prisma.ingestVendaLinhaRaw.count({ where: { tipoDocumentoClass: "UNKNOWN" } }),
      prisma.ingestVendaLinhaRaw.count({
        where: { produtoId: null, isNonStockService: false },
      }),
      prisma.ingestVendaLinhaRaw.count({
        where: { produtoId: null, isNonStockService: true },
      }),
    ]);
  console.log(`  · VendaMensal rows total       : ${vmRows.toLocaleString("pt-PT")}`);
  console.log(
    `  · mês mais recente agregado     : ${vmLastMonth ? `${vmLastMonth.ano}-${String(vmLastMonth.mes).padStart(2, "0")}` : "—"}`
  );
  console.log(`  ${glyph(stagingUnknowns === 0 ? "ok" : "fail")} staging UNKNOWN              : ${stagingUnknowns}`);
  console.log(`  ${glyph(stagingOrphans === 0 ? "ok" : "warn")} staging operational orphans  : ${stagingOrphans}`);
  console.log(`  · staging non-stock services    : ${stagingServices}`);
  console.log("");

  // ── Próximos passos sugeridos ────────────────────────────────────
  console.log("Próximos passos");
  console.log("─".repeat(40));
  if (farmaciasAtivas === 0) {
    console.log(`  → criar 1ª farmácia: npm run tenancy:add-farmacia -- --tenant ${tenant.slug} --nome "..."`);
  } else if (!keyOk) {
    console.log(`  → emitir ingest key: npm run tenancy:issue-ingest-key -- --slug ${tenant.slug}`);
  } else if (!lastDaily) {
    console.log(`  → gerar pacote agent e instalar no PC:`);
    console.log(`     npm run admin:package-agent -- --tenant ${tenant.slug} --farmacia "<nome>" --rotate`);
  } else if (lastDaily.status !== PIPELINE_STATUS.OK) {
    console.log(`  → daily-pipeline último ≠ OK. Ver logs locais no PC + 'npm run pipeline:health -- --tenant ${tenant.slug}'`);
  } else {
    console.log(`  ✓ tenant onboardado e a receber dados. Ver /admin/pipeline e /analise-operacional.`);
  }
  console.log("");

  // ── Exit code semântico ──────────────────────────────────────────
  let exitCode = 0;
  if (!dbReachable) exitCode = 1;
  else if (unfinishedCount > 0) exitCode = 2;
  else if (stagingUnknowns > 0) exitCode = 3;
  else if (farmaciasAtivas === 0) exitCode = 4;
  else if (lastDaily && lastDaily.status !== PIPELINE_STATUS.OK) exitCode = 5;
  console.log(`Status global: ${exitCode === 0 ? "✓ OK" : `⚠ exit=${exitCode}`}`);

  await prisma.$disconnect();
  await controlPrisma.$disconnect();
  process.exit(exitCode);
}

main().catch(async (err) => {
  console.error("[fatal]", err instanceof Error ? err.message : err);
  try {
    await controlPrisma.$disconnect();
  } catch {}
  process.exit(1);
});
