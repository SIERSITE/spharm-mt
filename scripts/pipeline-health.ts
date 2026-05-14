/**
 * scripts/pipeline-health.ts
 *
 * Health check operacional do pipeline daily-sync → aggregate → reports.
 * Output stdout — pode ser pipe'd para watcher externo ou usado por
 * operador para diagnosticar.
 *
 * Uso:
 *   npm run pipeline:health -- --tenant demo-neon
 *
 * Mostra:
 *   · último daily-pipeline run (status, duração, dataRef)
 *   · último aggregate-month run
 *   · mês mais recente agregado em VendaMensal
 *   · UNKNOWN count no staging
 *   · operational orphans count
 *   · número total de rows VendaMensal
 *   · últimas 10 falhas (status != OK) — kind, startedAt, errorMessage
 *
 * Read-only — nunca modifica nada.
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

type Args = { tenant?: string };

function parseCmdArgs(): Args {
  const { values } = parseArgs({
    options: { tenant: { type: "string" } },
    strict: true,
  });
  return { tenant: values.tenant };
}

function fmtAge(d: Date): string {
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

function fmtDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return "—";
  const total = Math.floor(ms / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function statusGlyph(status: string): string {
  if (status === PIPELINE_STATUS.OK) return "✓";
  if (status === PIPELINE_STATUS.RUNNING) return "▷";
  if (status === PIPELINE_STATUS.ABORTED) return "⚠";
  return "✗";
}

async function main() {
  const args = parseCmdArgs();
  if (!args.tenant) {
    console.error("✗ --tenant <slug> obrigatório.");
    process.exit(1);
  }

  const tenant = await getTenantBySlug(args.tenant);
  if (!tenant) {
    console.error(`✗ Tenant "${args.tenant}" não existe.`);
    process.exit(1);
  }
  if (tenant.estado !== "ACTIVE") {
    console.error(`✗ Tenant em estado ${tenant.estado}.`);
    process.exit(1);
  }

  const url = buildTenantConnectionString(tenant);
  const adapter = new PrismaPg({ connectionString: url });
  const prisma = new PrismaClient({ adapter });

  try {
    console.log("─".repeat(70));
    console.log(`pipeline-health — ${args.tenant}`);
    console.log("─".repeat(70));
    console.log("");

    // 1) Última corrida de cada kind
    const [lastDaily, lastAgg, lastDailySync] = await Promise.all([
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

    function renderLast(label: string, run: typeof lastDaily): void {
      if (!run) {
        console.log(`  ${label.padEnd(24)} (sem execuções registadas)`);
        return;
      }
      const g = statusGlyph(run.status);
      const age = fmtAge(run.startedAt);
      const dur = fmtDuration(run.durationMs);
      const dateRef = run.dateRef ? ` · ${run.dateRef}` : "";
      console.log(
        `  ${label.padEnd(24)} ${g} ${run.status.padEnd(8)} ${age.padEnd(10)} dur=${dur}${dateRef}`
      );
      if (run.errorMessage) {
        console.log(`    error: ${run.errorMessage.slice(0, 120)}`);
      }
    }

    console.log("Últimas execuções:");
    renderLast("daily-pipeline (auto)", lastDaily);
    renderLast("aggregate-month", lastAgg);
    renderLast("daily-sync (standalone)", lastDailySync);
    console.log("");

    // 2) Mês mais recente agregado
    const lastMonth = await prisma.vendaMensal.findFirst({
      where: { origemAgregacao: "agent-bootstrap-staging" },
      orderBy: [{ ano: "desc" }, { mes: "desc" }],
      select: { ano: true, mes: true },
    });
    if (lastMonth) {
      const monthCount = await prisma.vendaMensal.count({
        where: {
          ano: lastMonth.ano,
          mes: lastMonth.mes,
          origemAgregacao: "agent-bootstrap-staging",
        },
      });
      console.log(`Mês mais recente agregado: ${lastMonth.ano}-${String(lastMonth.mes).padStart(2, "0")} (${monthCount} rows VendaMensal)`);
    } else {
      console.log(`Mês mais recente agregado: (nada agregado por agent ainda)`);
    }

    // 3) Counts gerais
    const [vmTotalAgent, vmTotalAll, unknowns, opOrphans, nonStockServices] = await Promise.all([
      prisma.vendaMensal.count({ where: { origemAgregacao: "agent-bootstrap-staging" } }),
      prisma.vendaMensal.count(),
      prisma.ingestVendaLinhaRaw.count({ where: { tipoDocumentoClass: "UNKNOWN" } }),
      prisma.ingestVendaLinhaRaw.count({
        where: { produtoId: null, isNonStockService: false },
      }),
      prisma.ingestVendaLinhaRaw.count({
        where: { produtoId: null, isNonStockService: true },
      }),
    ]);
    console.log(`Rows VendaMensal (agent-bootstrap-staging): ${vmTotalAgent}`);
    console.log(`Rows VendaMensal (todas as origens)       : ${vmTotalAll}`);
    console.log(`UNKNOWN no staging                         : ${unknowns}`);
    console.log(`Operational orphans no staging             : ${opOrphans}`);
    console.log(`Non-stock services no staging              : ${nonStockServices}`);
    console.log("");

    // 4) Últimas 10 falhas
    const failures = await prisma.pipelineRun.findMany({
      where: { status: { in: [PIPELINE_STATUS.ERROR, PIPELINE_STATUS.ABORTED] } },
      orderBy: { startedAt: "desc" },
      take: 10,
      select: {
        startedAt: true,
        kind: true,
        status: true,
        dateRef: true,
        errorMessage: true,
      },
    });
    if (failures.length === 0) {
      console.log("Falhas recentes: (nenhuma)");
    } else {
      console.log(`Últimas ${failures.length} falhas:`);
      for (const f of failures) {
        const ts = f.startedAt.toISOString().slice(0, 19).replace("T", " ");
        console.log(`  ${statusGlyph(f.status)} ${ts}  ${f.kind.padEnd(18)} ${(f.dateRef ?? "—").padEnd(10)}  ${(f.errorMessage ?? "").slice(0, 80)}`);
      }
    }

    console.log("");
    console.log("─".repeat(70));

    // Exit code semântico para CI / watchdog
    if (!lastDaily || lastDaily.status !== PIPELINE_STATUS.OK) {
      console.log("Status global: ⚠ ATENÇÃO (último daily-pipeline não foi OK)");
      process.exit(2);
    }
    if (unknowns > 0) {
      console.log("Status global: ⚠ ATENÇÃO (UNKNOWN no staging — classifier incompleto)");
      process.exit(3);
    }
    if (opOrphans > 0) {
      console.log("Status global: ⚠ ATENÇÃO (operational orphans no staging)");
      process.exit(4);
    }
    console.log("Status global: ✓ OK");
  } finally {
    await prisma.$disconnect();
    await controlPrisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
