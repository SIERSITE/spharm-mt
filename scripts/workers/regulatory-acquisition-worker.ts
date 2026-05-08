/**
 * scripts/workers/regulatory-acquisition-worker.ts
 *
 * Worker stateless do regulatory acquisition pipeline (Phase 0 — Maio 2026).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RESPONSABILIDADE
 *
 * Para cada job em `RegulatoryAcquisitionJob` que esteja `PENDING` (ou
 * `PARTIAL` agendado para retry) e cujo `nextAttemptAt <= NOW()`:
 *   1. Reclama o job atomicamente (FOR UPDATE SKIP LOCKED)
 *      → status passa a IN_PROGRESS, attempts++, lastAttemptAt=NOW()
 *   2. Tenta as fontes em ordem de prioridade
 *      → Phase 0: nenhum fetcher real, apenas simulação determinística
 *   3. Aplica outcome:
 *      DONE     → completedAt=NOW(), status=DONE
 *      PARTIAL  → schedule retry com backoff (preserva fieldsObtained)
 *      retry    → status=PENDING, nextAttemptAt = NOW() + backoff[attempts]
 *      max     → status=FAILED, lastError preserva razão
 *      ambig   → status=BLOCKED (terminal, requer revisão manual)
 *
 * GC: no início de cada run, jobs IN_PROGRESS há > 30min são reset a
 * PENDING (cobre worker que crashou a meio).
 *
 * Stateless: cada invocação processa N jobs OU termina ao fim de M segundos
 * (o que vier primeiro). Reiniciável sem perda de estado — o lifecycle
 * vive todo na BD. Compatível com cron substrate (Vercel Cron, GitHub
 * Actions, cron local), mas para já corre manual.
 *
 * Phase 0: zero fetchers reais. O `simulateOutcome` decide o destino do
 * job a partir do último dígito do CNP. Permite validar lifecycle, GC,
 * backoff e métricas com jobs dummy. Phase 1+ substitui simulateOutcome
 * por chamadas reais a fontes (INFARMED Infomed, WHO ATC, etc.).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Uso:
 *   # Dry-run — claim + simulate, sem persistir mudanças
 *   npx tsx scripts/workers/regulatory-acquisition-worker.ts --dry-run
 *
 *   # Live — processa até 50 jobs ou 4 minutos (compatible cron)
 *   npx tsx scripts/workers/regulatory-acquisition-worker.ts
 *
 *   # Run mais agressivo manual
 *   npx tsx scripts/workers/regulatory-acquisition-worker.ts \
 *     --max-jobs=200 --max-duration=900
 *
 *   # Apenas GC dos pendurados
 *   npx tsx scripts/workers/regulatory-acquisition-worker.ts --gc-only
 */

import "dotenv/config";
import { legacyPrisma as prisma } from "../../lib/prisma";
import type { Prisma } from "../../generated/prisma/client";

// ─── Constantes ───────────────────────────────────────────────────────────────

const DEFAULT_MAX_JOBS = 50;
const DEFAULT_MAX_DURATION_S = 240;

/** Backoff schedule por tentativa. Após attempts >= MAX_ATTEMPTS, status=FAILED. */
const BACKOFF_HOURS = [1, 4, 24, 72, 168];
const MAX_ATTEMPTS = BACKOFF_HOURS.length + 1; // = 6

/** Jobs IN_PROGRESS há mais que isto são consideradas órfãos (worker crashed). */
const STUCK_RESET_MINUTES = 30;

// ─── Tipos ────────────────────────────────────────────────────────────────────

type Args = {
  maxJobs: number;
  maxDurationS: number;
  dryRun: boolean;
  gcOnly: boolean;
};

type ClaimedJob = {
  id: string;
  cnp: number;
  designacao: string | null;
  status: string;
  attempts: number;
  fieldsObtained: string[];
  sourceResults: Prisma.JsonValue | null;
};

type SimulatedOutcome =
  | { kind: "done"; fieldsObtained: string[]; sourceResults: Prisma.InputJsonValue }
  | { kind: "partial"; fieldsObtained: string[]; sourceResults: Prisma.InputJsonValue; reason: string }
  | { kind: "transient"; reason: string }
  | { kind: "permanent"; reason: string }
  | { kind: "blocked"; reason: string };

// ─── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(): Args {
  const out: Args = {
    maxJobs: DEFAULT_MAX_JOBS,
    maxDurationS: DEFAULT_MAX_DURATION_S,
    dryRun: false,
    gcOnly: false,
  };
  for (const a of process.argv.slice(2)) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--gc-only") out.gcOnly = true;
    else if (a.startsWith("--max-jobs=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (!isNaN(n) && n > 0 && n <= 5000) out.maxJobs = n;
    } else if (a.startsWith("--max-duration=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (!isNaN(n) && n > 0 && n <= 3600) out.maxDurationS = n;
    } else {
      console.warn(`[aviso] argumento desconhecido: ${a}`);
    }
  }
  return out;
}

// ─── GC dos jobs pendurados ───────────────────────────────────────────────────

/**
 * Reset jobs IN_PROGRESS há > STUCK_RESET_MINUTES de volta a PENDING.
 * Cobre worker crashed/SIGKILL'd. Idempotente — pode correr quantas
 * vezes quiser.
 */
async function gcStuckJobs(dryRun: boolean): Promise<number> {
  const cutoff = new Date(Date.now() - STUCK_RESET_MINUTES * 60 * 1000);
  if (dryRun) {
    const count = await prisma.regulatoryAcquisitionJob.count({
      where: { status: "IN_PROGRESS", lastAttemptAt: { lt: cutoff } },
    });
    if (count > 0) console.log(`  [gc] (dry-run) reset ${count} jobs pendurados`);
    return count;
  }
  const res = await prisma.regulatoryAcquisitionJob.updateMany({
    where: { status: "IN_PROGRESS", lastAttemptAt: { lt: cutoff } },
    data: { status: "PENDING" },
  });
  if (res.count > 0) console.log(`  [gc] reset ${res.count} job(s) pendurado(s) (>${STUCK_RESET_MINUTES}min em IN_PROGRESS)`);
  return res.count;
}

// ─── Claim atómico do próximo job ─────────────────────────────────────────────

/**
 * Claim atómico via `FOR UPDATE SKIP LOCKED`. Safe para múltiplos workers
 * concorrentes — cada um obtém um job distinto sem bloquear os outros.
 *
 * Em dry-run faz só SELECT (sem UPDATE), portanto re-corre devolveria o
 * mesmo job. Aceitável para validação.
 */
async function claimNextJob(dryRun: boolean): Promise<ClaimedJob | null> {
  if (dryRun) {
    const peek = await prisma.regulatoryAcquisitionJob.findFirst({
      where: {
        status: { in: ["PENDING", "PARTIAL"] },
        nextAttemptAt: { lte: new Date() },
      },
      orderBy: [{ priority: "asc" }, { nextAttemptAt: "asc" }],
      select: {
        id: true,
        cnp: true,
        designacao: true,
        status: true,
        attempts: true,
        fieldsObtained: true,
        sourceResults: true,
      },
    });
    return peek;
  }

  // Live: WITH ... FOR UPDATE SKIP LOCKED + UPDATE returning, atómico.
  const rows = await prisma.$queryRaw<ClaimedJob[]>`
    WITH next_job AS (
      SELECT "id" FROM "RegulatoryAcquisitionJob"
      WHERE "status" IN ('PENDING','PARTIAL')
        AND "nextAttemptAt" <= NOW()
      ORDER BY "priority" ASC, "nextAttemptAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "RegulatoryAcquisitionJob" j
    SET "status" = 'IN_PROGRESS',
        "attempts" = j."attempts" + 1,
        "lastAttemptAt" = NOW(),
        "updatedAt" = NOW()
    FROM next_job
    WHERE j."id" = next_job."id"
    RETURNING j."id", j."cnp", j."designacao", j."status"::text AS "status",
             j."attempts", j."fieldsObtained", j."sourceResults"
  `;
  return rows[0] ?? null;
}

// ─── Simulated outcome (Phase 0) ──────────────────────────────────────────────

/**
 * Determina outcome a partir do último dígito do CNP. Phase 1+ substitui
 * isto por chamadas reais a fontes em ordem de prioridade.
 *
 *   0,1,2  → DONE      (todos os campos obtidos)
 *   3,4    → PARTIAL   (alguns campos obtidos, retry agendado)
 *   5,6    → TRANSIENT (failure recoverable, retry com backoff)
 *   7,8    → PERMANENT (failure após attempts esgotadas)
 *   9      → BLOCKED   (ambiguidade, requer revisão manual)
 */
function simulateOutcome(job: ClaimedJob): SimulatedOutcome {
  const lastDigit = job.cnp % 10;
  if (lastDigit <= 2) {
    return {
      kind: "done",
      fieldsObtained: ["dci", "codigoATC", "formaFarmaceutica", "dosagem", "embalagem", "titularAim"],
      sourceResults: { simulated: { phase: 0, outcome: "complete", lastDigit } },
    };
  }
  if (lastDigit <= 4) {
    return {
      kind: "partial",
      fieldsObtained: ["dci"],
      sourceResults: { simulated: { phase: 0, outcome: "partial", lastDigit } },
      reason: "simulated: only DCI available",
    };
  }
  if (lastDigit <= 6) {
    return { kind: "transient", reason: `simulated transient (lastDigit=${lastDigit})` };
  }
  if (lastDigit <= 8) {
    return { kind: "permanent", reason: `simulated permanent failure (lastDigit=${lastDigit})` };
  }
  return { kind: "blocked", reason: `simulated ambiguity (lastDigit=${lastDigit})` };
}

// ─── Aplicar outcome ──────────────────────────────────────────────────────────

async function applyOutcome(
  job: ClaimedJob,
  outcome: SimulatedOutcome,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) return;

  const baseUpdate = {
    lastSourceTried: "phase0_simulator",
  };

  switch (outcome.kind) {
    case "done":
      await prisma.regulatoryAcquisitionJob.update({
        where: { id: job.id },
        data: {
          ...baseUpdate,
          status: "DONE",
          completedAt: new Date(),
          fieldsObtained: outcome.fieldsObtained,
          sourceResults: outcome.sourceResults,
          lastError: null,
        },
      });
      return;

    case "partial": {
      // PARTIAL → retry com backoff para tentar completar campos restantes.
      // Mas não conta como ataque agressivo: backoff normal.
      const backoffMs = backoffMsForAttempt(job.attempts);
      await prisma.regulatoryAcquisitionJob.update({
        where: { id: job.id },
        data: {
          ...baseUpdate,
          status: job.attempts >= MAX_ATTEMPTS ? "PARTIAL" : "PARTIAL",
          fieldsObtained: outcome.fieldsObtained,
          sourceResults: outcome.sourceResults,
          nextAttemptAt: new Date(Date.now() + backoffMs),
          lastError: outcome.reason,
        },
      });
      return;
    }

    case "transient": {
      if (job.attempts >= MAX_ATTEMPTS) {
        await prisma.regulatoryAcquisitionJob.update({
          where: { id: job.id },
          data: {
            ...baseUpdate,
            status: "FAILED",
            lastError: `${outcome.reason} (max attempts exceeded)`,
          },
        });
      } else {
        const backoffMs = backoffMsForAttempt(job.attempts);
        await prisma.regulatoryAcquisitionJob.update({
          where: { id: job.id },
          data: {
            ...baseUpdate,
            status: "PENDING", // → re-claimable após nextAttemptAt
            nextAttemptAt: new Date(Date.now() + backoffMs),
            lastError: outcome.reason,
          },
        });
      }
      return;
    }

    case "permanent":
      await prisma.regulatoryAcquisitionJob.update({
        where: { id: job.id },
        data: {
          ...baseUpdate,
          status: "FAILED",
          lastError: outcome.reason,
        },
      });
      return;

    case "blocked":
      await prisma.regulatoryAcquisitionJob.update({
        where: { id: job.id },
        data: {
          ...baseUpdate,
          status: "BLOCKED",
          lastError: outcome.reason,
        },
      });
      return;
  }
}

function backoffMsForAttempt(attempts: number): number {
  // attempts já incrementado no claim. attempt=1 → BACKOFF_HOURS[0]
  const idx = Math.max(0, Math.min(attempts - 1, BACKOFF_HOURS.length - 1));
  return BACKOFF_HOURS[idx] * 60 * 60 * 1000;
}

// ─── Métricas pre/post ────────────────────────────────────────────────────────

async function statusCounts(): Promise<Record<string, number>> {
  const groups = await prisma.regulatoryAcquisitionJob.groupBy({
    by: ["status"],
    _count: { _all: true },
  });
  const out: Record<string, number> = {
    PENDING: 0,
    IN_PROGRESS: 0,
    DONE: 0,
    PARTIAL: 0,
    FAILED: 0,
    BLOCKED: 0,
  };
  for (const g of groups) out[g.status] = g._count._all;
  return out;
}

function fmtCounts(c: Record<string, number>): string {
  return Object.entries(c)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();

  console.log("─".repeat(74));
  console.log("Regulatory Acquisition Worker (Phase 0 — simulator)");
  console.log("─".repeat(74));
  console.log(`  dryRun:        ${args.dryRun}`);
  console.log(`  gcOnly:        ${args.gcOnly}`);
  console.log(`  maxJobs:       ${args.maxJobs}`);
  console.log(`  maxDuration:   ${args.maxDurationS}s`);
  console.log(`  backoff (h):   [${BACKOFF_HOURS.join(", ")}] · MAX_ATTEMPTS=${MAX_ATTEMPTS}`);

  // Pre-state
  const before = await statusCounts();
  console.log(`\n  estado antes:  ${fmtCounts(before)}`);

  // GC primeiro — pode libertar trabalho para este run
  console.log("");
  await gcStuckJobs(args.dryRun);

  if (args.gcOnly) {
    const after = await statusCounts();
    console.log(`\n  estado depois: ${fmtCounts(after)}`);
    return;
  }

  // Process loop
  const tStart = Date.now();
  const deadlineMs = tStart + args.maxDurationS * 1000;
  let processed = 0;
  const outcomes = { done: 0, partial: 0, retry: 0, failed: 0, blocked: 0 };

  console.log(`\n  [run] processar até ${args.maxJobs} jobs ou ${args.maxDurationS}s`);

  while (processed < args.maxJobs) {
    if (Date.now() > deadlineMs) {
      console.log(`  [stop] deadline ${args.maxDurationS}s atingido`);
      break;
    }
    const job = await claimNextJob(args.dryRun);
    if (!job) {
      console.log(`  [stop] sem jobs prontos`);
      break;
    }

    const outcome = simulateOutcome(job);
    const decisionLabel =
      outcome.kind === "transient"
        ? job.attempts >= MAX_ATTEMPTS
          ? "FAILED"
          : "PENDING (retry)"
        : outcome.kind.toUpperCase();

    console.log(
      `    job=${job.id.slice(0, 8)}… cnp=${job.cnp} attempt=${job.attempts} → ${decisionLabel}` +
        ("reason" in outcome ? ` (${outcome.reason})` : ""),
    );

    await applyOutcome(job, outcome, args.dryRun);

    processed++;
    if (outcome.kind === "done") {
      outcomes.done++;
    } else if (outcome.kind === "partial") {
      outcomes.partial++;
    } else if (outcome.kind === "transient") {
      if (job.attempts >= MAX_ATTEMPTS) outcomes.failed++;
      else outcomes.retry++;
    } else if (outcome.kind === "permanent") {
      outcomes.failed++;
    } else if (outcome.kind === "blocked") {
      outcomes.blocked++;
    }
  }

  const elapsedS = ((Date.now() - tStart) / 1000).toFixed(1);
  console.log(
    `\n  [done] processed=${processed} · ` +
      `done=${outcomes.done} partial=${outcomes.partial} retry=${outcomes.retry} ` +
      `failed=${outcomes.failed} blocked=${outcomes.blocked} · ` +
      `elapsed=${elapsedS}s`,
  );

  // Post-state
  const after = await statusCounts();
  console.log(`\n  estado depois: ${fmtCounts(after)}`);
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
