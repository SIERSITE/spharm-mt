/**
 * scripts/enqueue-regulatory-acquisition.ts
 *
 * CLI para enfileirar jobs em `RegulatoryAcquisitionJob`.
 *
 * Aceita:
 *   --cnp=N                Enfileira um único CNP
 *   --cnps=A,B,C           Enfileira lista (vírgula-separada)
 *   --from-file=path.txt   Enfileira CNPs de um ficheiro (um por linha)
 *   --cohort=<id>          Enfileira um cohort predefinido (ver COHORTS abaixo)
 *   --priority=N           Prioridade (default 50). 1=urgente, 100=fundo.
 *   --reset-existing       Re-set jobs que existam para PENDING
 *                           (default: skip CNPs que já têm job)
 *   --dry-run              Mostra o que seria enfileirado, sem escrever
 *   --limit=N              Limita o número de jobs a enfileirar (debug)
 *
 * Cohorts predefinidos:
 *   outros-medicamentos    MEDICAMENTO + classificacaoNivel2="Outros Medicamentos"
 *                           validadoManualmente=false, cnp > 2.000.000
 *                           (≈ 6191 produtos no momento da última medição)
 *   med-no-clinical        MEDICAMENTO sem ATC nem DCI no Produto
 *   smoke-test             10 CNPs hard-coded para validar pipeline
 *
 * Uso:
 *   npx tsx scripts/enqueue-regulatory-acquisition.ts --cohort=smoke-test --dry-run
 *   npx tsx scripts/enqueue-regulatory-acquisition.ts --cnp=2433084 --priority=10
 *   npx tsx scripts/enqueue-regulatory-acquisition.ts --cnps=2433084,3221496,3368289
 *   npx tsx scripts/enqueue-regulatory-acquisition.ts --cohort=outros-medicamentos --limit=100
 */

import "dotenv/config";
import * as fs from "fs";
import { legacyPrisma as prisma } from "../lib/prisma";

// ─── CLI ──────────────────────────────────────────────────────────────────────

type Args = {
  cnps: number[];
  cohort: string | null;
  priority: number;
  resetExisting: boolean;
  dryRun: boolean;
  limit: number | null;
};

function parseArgs(): Args {
  const out: Args = {
    cnps: [],
    cohort: null,
    priority: 50,
    resetExisting: false,
    dryRun: false,
    limit: null,
  };
  for (const a of process.argv.slice(2)) {
    if (a === "--reset-existing") out.resetExisting = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a.startsWith("--cnp=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (!isNaN(n) && n > 0) out.cnps.push(n);
    } else if (a.startsWith("--cnps=")) {
      for (const part of a.slice("--cnps=".length).split(",")) {
        const n = parseInt(part.trim(), 10);
        if (!isNaN(n) && n > 0) out.cnps.push(n);
      }
    } else if (a.startsWith("--from-file=")) {
      const p = a.slice("--from-file=".length);
      if (!fs.existsSync(p)) throw new Error(`Ficheiro não encontrado: ${p}`);
      const content = fs.readFileSync(p, "utf-8");
      for (const line of content.split(/\r?\n/)) {
        const n = parseInt(line.trim(), 10);
        if (!isNaN(n) && n > 0) out.cnps.push(n);
      }
    } else if (a.startsWith("--cohort=")) {
      out.cohort = a.split("=")[1];
    } else if (a.startsWith("--priority=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (!isNaN(n) && n >= 1 && n <= 100) out.priority = n;
    } else if (a.startsWith("--limit=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (!isNaN(n) && n > 0) out.limit = n;
    } else {
      console.warn(`[aviso] argumento desconhecido: ${a}`);
    }
  }
  if (out.cnps.length === 0 && !out.cohort) {
    throw new Error("Especificar --cnp=, --cnps=, --from-file=, ou --cohort=");
  }
  return out;
}

// ─── Cohorts predefinidos ─────────────────────────────────────────────────────

/**
 * Resolve um cohort para uma lista de (cnp, designacao). Cada cohort é um
 * helper com semântica clara — adicionar mais à medida que aparecerem
 * casos de uso.
 */
async function resolveCohort(
  id: string,
  limit: number | null,
): Promise<Array<{ cnp: number; designacao: string }>> {
  switch (id) {
    case "smoke-test": {
      // 10 CNPs hard-coded para validação rápida de pipeline.
      // Usa um mix de últimos-dígitos para activar todos os ramos do simulador
      // do worker (DONE / PARTIAL / TRANSIENT / PERMANENT / BLOCKED).
      const SMOKE_CNPS = [
        2047280, // ...0 → DONE
        2115889, // ...9 → BLOCKED
        2300796, // ...6 → TRANSIENT
        2433084, // ...4 → PARTIAL
        2441889, // ...9 → BLOCKED
        2455483, // ...3 → PARTIAL
        2632685, // ...5 → TRANSIENT
        3221496, // ...6 → TRANSIENT
        3368289, // ...9 → BLOCKED
        3685096, // ...6 → TRANSIENT
      ];
      const rows = await prisma.produto.findMany({
        where: { cnp: { in: SMOKE_CNPS } },
        select: { cnp: true, designacao: true },
      });
      return rows;
    }

    case "outros-medicamentos": {
      const nivel2 = await prisma.classificacao.findFirst({
        where: {
          tipo: "NIVEL_2",
          nome: { equals: "Outros Medicamentos", mode: "insensitive" },
          classificacaoPai: { nome: { equals: "MEDICAMENTOS", mode: "insensitive" } },
        },
        select: { id: true },
      });
      if (!nivel2) {
        throw new Error(`Classificacao 'Outros Medicamentos' não encontrada`);
      }
      const rows = await prisma.produto.findMany({
        where: {
          productType: "MEDICAMENTO",
          classificacaoNivel2Id: nivel2.id,
          validadoManualmente: false,
          estado: { not: "INATIVO" },
          cnp: { gt: 2_000_000 },
        },
        select: { cnp: true, designacao: true },
        orderBy: { cnp: "asc" },
        take: limit ?? undefined,
      });
      return rows;
    }

    case "med-no-clinical": {
      const rows = await prisma.produto.findMany({
        where: {
          productType: "MEDICAMENTO",
          codigoATC: null,
          dci: null,
          validadoManualmente: false,
          estado: { not: "INATIVO" },
          cnp: { gt: 2_000_000 },
        },
        select: { cnp: true, designacao: true },
        orderBy: { cnp: "asc" },
        take: limit ?? undefined,
      });
      return rows;
    }

    default:
      throw new Error(
        `Cohort desconhecido: ${id}. Conhecidos: smoke-test, outros-medicamentos, med-no-clinical`,
      );
  }
}

// ─── Enqueue ──────────────────────────────────────────────────────────────────

type EnqueueStats = {
  inserted: number;
  resetExisting: number;
  skippedExisting: number;
  skippedNoProduto: number;
};

async function enqueue(
  candidates: Array<{ cnp: number; designacao: string }>,
  priority: number,
  resetExisting: boolean,
  dryRun: boolean,
): Promise<EnqueueStats> {
  const stats: EnqueueStats = {
    inserted: 0,
    resetExisting: 0,
    skippedExisting: 0,
    skippedNoProduto: 0,
  };
  if (candidates.length === 0) return stats;

  // Pre-flight: quais já têm job
  const cnps = candidates.map((c) => c.cnp);
  const existing = await prisma.regulatoryAcquisitionJob.findMany({
    where: { cnp: { in: cnps } },
    select: { cnp: true, status: true },
  });
  const existingByCnp = new Map(existing.map((e) => [e.cnp, e.status]));

  const toInsert: Array<{ cnp: number; designacao: string; priority: number }> = [];
  const toReset: number[] = [];

  for (const c of candidates) {
    const cur = existingByCnp.get(c.cnp);
    if (!cur) {
      toInsert.push({ cnp: c.cnp, designacao: c.designacao, priority });
      continue;
    }
    if (resetExisting) {
      toReset.push(c.cnp);
    } else {
      stats.skippedExisting++;
    }
  }

  if (dryRun) {
    stats.inserted = toInsert.length;
    stats.resetExisting = toReset.length;
    return stats;
  }

  // Bulk insert via createMany
  if (toInsert.length > 0) {
    const res = await prisma.regulatoryAcquisitionJob.createMany({
      data: toInsert.map((r) => ({
        cnp: r.cnp,
        designacao: r.designacao,
        priority: r.priority,
        status: "PENDING",
        nextAttemptAt: new Date(), // claimable já
      })),
      skipDuplicates: true,
    });
    stats.inserted = res.count;
    // Diff = duplicados absorvidos (race com outro enqueue) — não fail
    stats.skippedExisting += toInsert.length - res.count;
  }

  // Reset existing
  if (toReset.length > 0) {
    const res = await prisma.regulatoryAcquisitionJob.updateMany({
      where: { cnp: { in: toReset } },
      data: {
        status: "PENDING",
        priority,
        attempts: 0,
        nextAttemptAt: new Date(),
        lastError: null,
        lastSourceTried: null,
        completedAt: null,
      },
    });
    stats.resetExisting = res.count;
  }

  return stats;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();

  console.log("─".repeat(74));
  console.log("Enqueue RegulatoryAcquisitionJob");
  console.log("─".repeat(74));
  console.log(`  priority:       ${args.priority}`);
  console.log(`  dryRun:         ${args.dryRun}`);
  console.log(`  resetExisting:  ${args.resetExisting}`);
  if (args.limit) console.log(`  limit:          ${args.limit}`);

  // Resolve candidatos
  let candidates: Array<{ cnp: number; designacao: string }> = [];
  if (args.cohort) {
    console.log(`  cohort:         ${args.cohort}`);
    candidates = await resolveCohort(args.cohort, args.limit);
    console.log(`  resolvido:      ${candidates.length} CNPs`);
  } else {
    // De args.cnps — vai à BD para apanhar designacao quando exista
    const rows = await prisma.produto.findMany({
      where: { cnp: { in: args.cnps } },
      select: { cnp: true, designacao: true },
    });
    candidates = rows;
    const missing = args.cnps.filter((c) => !rows.find((r) => r.cnp === c));
    if (missing.length > 0) {
      console.warn(
        `  [aviso] ${missing.length} CNP(s) não encontrados em Produto: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""}`,
      );
    }
  }

  if (args.limit && candidates.length > args.limit) {
    candidates = candidates.slice(0, args.limit);
    console.log(`  truncado a:     ${candidates.length} (--limit)`);
  }

  if (candidates.length === 0) {
    console.warn("\nNada para enfileirar.");
    return;
  }

  console.log("\n  Amostra (5):");
  for (const c of candidates.slice(0, 5)) {
    console.log(`    cnp=${c.cnp} · ${c.designacao.slice(0, 60)}`);
  }

  // Enqueue
  const stats = await enqueue(candidates, args.priority, args.resetExisting, args.dryRun);

  console.log(`\n  Resultado ${args.dryRun ? "(DRY-RUN)" : "(LIVE)"}:`);
  console.log(`    inseridos:       ${stats.inserted}`);
  console.log(`    reset existentes:${stats.resetExisting}`);
  console.log(`    skipped existentes:${stats.skippedExisting}`);
  console.log(`    skipped sem Produto:${stats.skippedNoProduto}`);

  // Total queue state
  if (!args.dryRun) {
    const groups = await prisma.regulatoryAcquisitionJob.groupBy({
      by: ["status"],
      _count: { _all: true },
    });
    const byStatus: Record<string, number> = {};
    for (const g of groups) byStatus[g.status] = g._count._all;
    console.log(`\n  Estado actual da queue:`);
    for (const s of ["PENDING", "IN_PROGRESS", "PARTIAL", "DONE", "FAILED", "BLOCKED"]) {
      console.log(`    ${s.padEnd(13)} ${byStatus[s] ?? 0}`);
    }
  }

  console.log("─".repeat(74));
}

main()
  .catch((err) => {
    console.error("[erro fatal]", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
