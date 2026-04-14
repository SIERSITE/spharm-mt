/**
 * scripts/workers/enrichment-worker.ts
 *
 * Worker contínuo de enriquecimento do catálogo SPharm.MT.
 *
 * Não há pipeline paralelo: este worker é só o runner de loop que puxa
 * jobs da EnriquecimentoFila e chama enrichProduct() da orquestração
 * que já existe em lib/catalog-enrichment.ts. Toda a classificação,
 * resolução, persistência e registo de histórico é feita por baixo pela
 * infraestrutura existente.
 *
 * Responsabilidades exclusivas deste worker:
 *   - Loop contínuo (dorme quando a fila está vazia)
 *   - Claim de N jobs PENDENTE por iteração
 *   - Recovery inicial de jobs EM_PROCESSAMENTO pendurados
 *   - Re-promoção periódica de FALHOU → PENDENTE com backoff exponencial
 *   - Retoma automática após crash
 *   - Graceful shutdown via SIGINT / SIGTERM
 *   - Logs claros de progresso
 *
 * Correr:
 *   npx tsx scripts/workers/enrichment-worker.ts
 *   npx tsx scripts/workers/enrichment-worker.ts --batch=5 --limit=50
 *   npx tsx scripts/workers/enrichment-worker.ts --once   # drena a fila e sai
 */

import "dotenv/config";
import { legacyPrisma as prisma } from "../../lib/prisma";
import { enrichProduct } from "../../lib/catalog-enrichment";

// ─── Configuração ─────────────────────────────────────────────────────────────

const DEFAULT_BATCH = 10;
const IDLE_SLEEP_MS = 30_000;            // sem trabalho → dormir
const INTER_BATCH_SLEEP_MS = 500;        // entre batches com trabalho
const MAX_RETRIES = 5;
const STUCK_TIMEOUT_MIN = 30;            // EM_PROCESSAMENTO > 30 min → requeue
const BACKOFF_BASE_MS = 60_000;          // 1m, 2m, 4m, 8m, 16m

// ─── Args ─────────────────────────────────────────────────────────────────────

type Args = { batch: number; limit: number | null; once: boolean };

function parseArgs(): Args {
  const out: Args = { batch: DEFAULT_BATCH, limit: null, once: false };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--batch=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (!isNaN(n) && n > 0) out.batch = n;
    } else if (a.startsWith("--limit=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (!isNaN(n) && n > 0) out.limit = n;
    } else if (a === "--once") {
      out.once = true;
    }
  }
  return out;
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

let shuttingDown = false;
function requestShutdown(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[${ts()}] [worker] shutdown requested (${reason}) — a terminar após o batch actual…`);
}
process.on("SIGINT", () => requestShutdown("SIGINT"));
process.on("SIGTERM", () => requestShutdown("SIGTERM"));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ts(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    // Permite aborto imediato em shutdown
    const check = setInterval(() => {
      if (shuttingDown) {
        clearTimeout(t);
        clearInterval(check);
        resolve();
      }
    }, 200);
  });
}

function backoffCutoff(attempt: number): Date {
  const clampedAttempt = Math.min(Math.max(attempt, 1), 6);
  const ms = BACKOFF_BASE_MS * Math.pow(2, clampedAttempt - 1);
  return new Date(Date.now() - ms);
}

// ─── Manutenção da fila ───────────────────────────────────────────────────────

/** Recupera jobs pendurados em EM_PROCESSAMENTO há mais de STUCK_TIMEOUT_MIN. */
async function recoverStuck(): Promise<number> {
  const cutoff = new Date(Date.now() - STUCK_TIMEOUT_MIN * 60_000);
  const res = await prisma.enriquecimentoFila.updateMany({
    where: { estado: "EM_PROCESSAMENTO", ultimaTentativa: { lt: cutoff } },
    data: { estado: "PENDENTE", mensagemErro: "recovered: stuck in EM_PROCESSAMENTO" },
  });
  return res.count;
}

/**
 * Promove FALHOU → PENDENTE para jobs com retries disponíveis e cujo
 * backoff já expirou. Limita a 500 jobs por iteração para não entupir.
 */
async function requeueFailures(): Promise<number> {
  const candidates = await prisma.enriquecimentoFila.findMany({
    where: { estado: "FALHOU", numeroTentativas: { lt: MAX_RETRIES } },
    select: { id: true, numeroTentativas: true, ultimaTentativa: true },
    orderBy: { ultimaTentativa: "asc" },
    take: 500,
  });

  let promoted = 0;
  for (const c of candidates) {
    const cutoff = backoffCutoff(c.numeroTentativas);
    if (!c.ultimaTentativa || c.ultimaTentativa < cutoff) {
      await prisma.enriquecimentoFila.update({
        where: { id: c.id },
        data: { estado: "PENDENTE" },
      });
      promoted++;
    }
  }
  return promoted;
}

/** Claim de N jobs PENDENTE ordenados por prioridade e antiguidade. */
async function claimJobs(take: number): Promise<Array<{ id: string; produtoId: string }>> {
  return prisma.enriquecimentoFila.findMany({
    where: { estado: "PENDENTE" },
    orderBy: [{ prioridade: "asc" }, { dataCriacao: "asc" }],
    take,
    select: { id: true, produtoId: true },
  });
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();
  console.log(`[${ts()}] [worker] arranque  batch=${args.batch}  once=${args.once}  limit=${args.limit ?? "∞"}`);

  // Recovery inicial — vital para retoma após crash
  const recovered = await recoverStuck();
  if (recovered > 0) {
    console.log(`[${ts()}] [worker] recovery: ${recovered} jobs EM_PROCESSAMENTO → PENDENTE`);
  }

  let processedTotal = 0;
  let okTotal = 0;
  let partialTotal = 0;
  let failedTotal = 0;
  let idleCycles = 0;
  const t0 = Date.now();

  while (!shuttingDown) {
    if (args.limit !== null && processedTotal >= args.limit) {
      console.log(`[${ts()}] [worker] limit=${args.limit} atingido`);
      break;
    }

    // Manutenção antes de cada round de claim
    const promoted = await requeueFailures();
    if (promoted > 0) {
      console.log(`[${ts()}] [worker] backoff: ${promoted} jobs FALHOU → PENDENTE`);
    }

    const jobs = await claimJobs(args.batch);

    if (jobs.length === 0) {
      if (args.once) {
        console.log(`[${ts()}] [worker] fila vazia (--once) — a sair`);
        break;
      }
      idleCycles++;
      console.log(`[${ts()}] [worker] fila vazia, a dormir ${IDLE_SLEEP_MS / 1000}s…`);
      await sleep(IDLE_SLEEP_MS);
      continue;
    }
    idleCycles = 0;

    console.log(`[${ts()}] [worker] a processar ${jobs.length} job(s)`);

    for (const job of jobs) {
      if (shuttingDown) break;
      if (args.limit !== null && processedTotal >= args.limit) break;

      const tJob = Date.now();
      try {
        const result = await enrichProduct(job.produtoId);
        processedTotal++;
        if (result.status === "success") okTotal++;
        else if (result.status === "partial") partialTotal++;
        else failedTotal++;

        const durMs = Date.now() - tJob;
        const fields = result.fieldsUpdated.length > 0 ? result.fieldsUpdated.join(",") : "—";
        console.log(
          `  cnp=${result.cnp ?? "?"}  ${result.status.toUpperCase().padEnd(7)}  ` +
          `${result.productType}  conf=${(result.productTypeConfidence * 100).toFixed(0)}%  ` +
          `campos=[${fields}]  (${durMs}ms)`
        );
      } catch (err) {
        processedTotal++;
        failedTotal++;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  [erro] produtoId=${job.produtoId}: ${msg}`);
        // Garantir que a fila sai de EM_PROCESSAMENTO mesmo se enrichProduct falhou antes de escrever
        try {
          await prisma.enriquecimentoFila.update({
            where: { id: job.id },
            data: {
              estado: "FALHOU",
              mensagemErro: msg.slice(0, 500),
              numeroTentativas: { increment: 1 },
              ultimaTentativa: new Date(),
            },
          });
        } catch {
          /* best-effort */
        }
      }
    }

    const elapsedS = Math.round((Date.now() - t0) / 1000);
    const rate = processedTotal > 0 ? (processedTotal / (elapsedS || 1)).toFixed(2) : "0.00";
    console.log(
      `[${ts()}] [worker] totais proc=${processedTotal}  ok=${okTotal}  parcial=${partialTotal}  falhou=${failedTotal}  rate=${rate}/s`
    );

    if (!shuttingDown && !args.once) {
      await sleep(INTER_BATCH_SLEEP_MS);
    }
  }

  const elapsedS = Math.round((Date.now() - t0) / 1000);
  console.log(
    `[${ts()}] [worker] terminado  proc=${processedTotal}  ok=${okTotal}  parcial=${partialTotal}  falhou=${failedTotal}  tempo=${elapsedS}s`
  );
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(`[${ts()}] [worker] erro fatal:`, err);
  await prisma.$disconnect();
  process.exit(1);
});
