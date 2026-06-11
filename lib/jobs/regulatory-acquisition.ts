/**
 * lib/jobs/regulatory-acquisition.ts
 *
 * Worker do regulatory acquisition pipeline, invocável tanto de cron
 * serverless (`/api/jobs/acquire-regulatory`) como de script CLI.
 *
 * Diferenças vs `scripts/workers/regulatory-acquisition-worker.ts` (Phase 0):
 *
 *   · Phase 1 — chama fetchers reais (INFARMED snapshot + INFOMED HTTP)
 *     em vez de `simulateOutcome`.
 *   · DB-only multi-tenant via PrismaClient parametrizado (não tem
 *     `import "server-only"` para correr também em script).
 *   · `runAcquisitionTick({ prisma, maxJobs, maxDurationMs })` é a entry
 *     point — processa até `maxJobs` ou para quando `maxDurationMs`
 *     expira. Devolve métricas estruturadas.
 *   · UPSERT idempotente em `RegulatoryRecord` (preserve-non-null contra
 *     o existente). Cria/actualiza `EnrichmentSourceLog` por tentativa.
 *
 * Lifecycle preservado:
 *   PENDING → IN_PROGRESS (claim) → { DONE, PARTIAL, retry, FAILED, BLOCKED }
 *
 * Backoff: [1h, 4h, 1d, 3d, 7d] = `BACKOFF_HOURS`. MAX_ATTEMPTS=6.
 *
 * GC: jobs IN_PROGRESS há > 30min são reset a PENDING (worker crash).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Anti-rate-limit:
 *   · Default `rateLimitMs=1500` por request INFOMED.
 *   · Default `infomedSessionMaxJobs=30` — abre nova sessão a cada N
 *     CNPs para reduzir pressão anti-bot (estratégia validada no spike
 *     de 2026-05-11 com 39.5min de sessão única sem 503).
 *   · `maxDurationMs` (300s no cron Vercel Hobby; 240s default no script)
 *     funciona como kill-switch — a função sai limpamente sem deixar jobs
 *     pendurados.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Auditoria:
 *   · Cada tentativa grava 1 row em `EnrichmentSourceLog` com
 *     source/status/confidence/fieldsReturned/durationMs.
 *   · `RegulatoryAcquisitionJob.sourceResults` guarda snapshot do último
 *     payload por fonte.
 *   · Imagens INFOMED → `Produto.imagemUrl` é sincronizado apenas quando
 *     o produto **não tem** imagem (preserve-non-null). A fonte fica
 *     auditada em `EnrichmentSourceLog.url`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * FilaRevisao (Phase E hook):
 *   · Outcome `ambiguous` → cria entrada `tipoRevisao=CONFLITO` em
 *     `FilaRevisao` (idempotente por produtoId+tipoRevisao+estado).
 */

import type { PrismaClient } from "@/generated/prisma/client";
import { Prisma } from "@/generated/prisma/client";
import {
  infarmedSnapshotFetcher,
  infomedHttpFetcher,
  mergeRegulatoryFields,
  openInfomedSession,
  type FetcherResult,
  type RegulatoryFields,
} from "./regulatory-acquisition-fetchers";
import type { SearchSession } from "@/lib/regulatory-sources/infomed-search-resolver";

// ─── Constantes ─────────────────────────────────────────────────────────

const BACKOFF_HOURS = [1, 4, 24, 72, 168];
const MAX_ATTEMPTS = BACKOFF_HOURS.length + 1; // 6
const STUCK_RESET_MINUTES = 30;

const DEFAULT_RATE_LIMIT_MS = 1500;
const DEFAULT_INFOMED_SESSION_MAX_JOBS = 30;
const DEFAULT_MAX_JOBS = 100;
const DEFAULT_MAX_DURATION_MS = 240_000;

// ─── Tipos públicos ─────────────────────────────────────────────────────

export type AcquisitionTickOptions = {
  prisma: PrismaClient;
  /** Default 100. */
  maxJobs?: number;
  /** Default 240_000 (4 min) — fica abaixo do Vercel Hobby maxDuration. */
  maxDurationMs?: number;
  /** Default 1500. */
  rateLimitMs?: number;
  /** Default 30 — quantos CNPs por sessão INFOMED antes de rotar. */
  infomedSessionMaxJobs?: number;
  /** Se true, salta INFOMED HTTP (útil para diagnóstico DB-only). */
  skipInfomedHttp?: boolean;
};

export type AcquisitionTickSummary = {
  startedAt: string;
  durationMs: number;
  processed: number;
  outcomes: {
    done: number;
    partial: number;
    retry: number;
    failed: number;
    blocked: number;
    /** Jobs em que o snapshot bateu mas nada novo a guardar. */
    noOpUpdates: number;
  };
  /** Counts por fonte usada — para diagnóstico de health pipeline. */
  bySource: {
    snapshotHits: number;
    httpHits: number;
    snapshotMisses: number;
    httpMisses: number;
    httpErrors: number;
  };
  /** Updates idempotentes downstream. */
  produtoUpdates: {
    fieldsFilled: number;
    imagemUrlFilled: number;
  };
  regulatoryRecordUpserts: number;
  gcReset: number;
  /** Quando == maxJobs, o tick pode ter mais trabalho — caller pode tickar de novo. */
  stoppedReason: "no_jobs" | "max_jobs" | "deadline";
};

// ─── Tipos internos ─────────────────────────────────────────────────────

type ClaimedJob = {
  id: string;
  cnp: number;
  designacao: string | null;
  status: string;
  attempts: number;
  fieldsObtained: string[];
  sourceResults: Prisma.JsonValue | null;
};

// ─── GC ─────────────────────────────────────────────────────────────────

async function gcStuckJobs(prisma: PrismaClient): Promise<number> {
  const cutoff = new Date(Date.now() - STUCK_RESET_MINUTES * 60 * 1000);
  const res = await prisma.regulatoryAcquisitionJob.updateMany({
    where: { status: "IN_PROGRESS", lastAttemptAt: { lt: cutoff } },
    data: { status: "PENDING" },
  });
  return res.count;
}

// ─── Claim atómico ──────────────────────────────────────────────────────

async function claimNextJob(prisma: PrismaClient): Promise<ClaimedJob | null> {
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

// ─── Backoff ────────────────────────────────────────────────────────────

function backoffMsForAttempt(attempts: number): number {
  const idx = Math.max(0, Math.min(attempts - 1, BACKOFF_HOURS.length - 1));
  return BACKOFF_HOURS[idx] * 60 * 60 * 1000;
}

// ─── EnrichmentSourceLog helper ─────────────────────────────────────────

async function logEnrichment(
  prisma: PrismaClient,
  produtoId: string | null,
  source: "infarmed_snapshot" | "infomed_http",
  result: FetcherResult,
  durationMs: number,
  cnp: number,
): Promise<void> {
  if (!produtoId) return; // sem produto correspondente — skip auditoria por produto
  const status =
    result.kind === "ok"
      ? "SUCCESS"
      : result.kind === "ambiguous"
      ? "PARTIAL_HIT"
      : result.kind === "not_found"
      ? "NO_MATCH"
      : "ERROR";
  await prisma.enrichmentSourceLog.create({
    data: {
      produtoId,
      source,
      status,
      confidence: result.kind === "ok" ? 0.95 : null,
      matchedBy: "cnp",
      durationMs: Math.round(durationMs),
      fieldsReturned: result.kind === "ok" ? result.fieldsObtained : [],
      errorMessage:
        result.kind === "error"
          ? result.error.slice(0, 500)
          : result.kind === "not_found"
          ? result.reason.slice(0, 500)
          : result.kind === "ambiguous"
          ? result.reason.slice(0, 500)
          : null,
      url:
        result.kind === "ok" && result.fields.imagemUrl
          ? result.fields.imagemUrl
          : null,
      query: `cnp=${cnp}`,
      rawBrand: result.kind === "ok" ? result.fields.titularAim : null,
      rawCategory: result.kind === "ok" ? result.fields.grupoTerapeutico : null,
      rawProductName:
        result.kind === "ok" ? result.fields.designacaoOficial : null,
    },
  });
}

// ─── RegulatoryRecord upsert (preserve-non-null) ────────────────────────

async function upsertRegulatoryRecord(
  prisma: PrismaClient,
  cnp: number,
  fields: RegulatoryFields,
  source: string,
): Promise<boolean> {
  // Política preserve-non-null contra o estado actual em RR:
  //   · Campos NULL no input não sobrescrevem nada.
  //   · Campos não-NULL no input ganham.
  const existing = await prisma.regulatoryRecord.findUnique({ where: { cnp } });
  const next = {
    designacaoOficial: fields.designacaoOficial ?? existing?.designacaoOficial ?? null,
    dci: fields.dci ?? existing?.dci ?? null,
    codigoATC: fields.codigoATC ?? existing?.codigoATC ?? null,
    formaFarmaceutica: fields.formaFarmaceutica ?? existing?.formaFarmaceutica ?? null,
    dosagem: fields.dosagem ?? existing?.dosagem ?? null,
    embalagem: fields.embalagem ?? existing?.embalagem ?? null,
    grupoTerapeutico: fields.grupoTerapeutico ?? existing?.grupoTerapeutico ?? null,
    titularAim: fields.titularAim ?? existing?.titularAim ?? null,
    estadoAim: fields.estadoAim ?? existing?.estadoAim ?? null,
  };
  // Skip se nada vai mudar
  if (
    existing &&
    existing.designacaoOficial === next.designacaoOficial &&
    existing.dci === next.dci &&
    existing.codigoATC === next.codigoATC &&
    existing.formaFarmaceutica === next.formaFarmaceutica &&
    existing.dosagem === next.dosagem &&
    existing.embalagem === next.embalagem &&
    existing.grupoTerapeutico === next.grupoTerapeutico &&
    existing.titularAim === next.titularAim &&
    existing.estadoAim === next.estadoAim
  ) {
    return false;
  }
  await prisma.regulatoryRecord.upsert({
    where: { cnp },
    create: { cnp, source, ...next },
    update: { source, ...next },
  });
  return true;
}

// ─── Produto sync (preserve-non-null, including imagemUrl) ──────────────

type ProdutoSyncResult = { fieldsFilled: number; imagemFilled: boolean };

async function syncToProduto(
  prisma: PrismaClient,
  cnp: number,
  fields: RegulatoryFields,
): Promise<{ produtoId: string | null; result: ProdutoSyncResult }> {
  const produto = await prisma.produto.findUnique({
    where: { cnp },
    select: {
      id: true,
      codigoATC: true,
      dci: true,
      formaFarmaceutica: true,
      dosagem: true,
      embalagem: true,
      imagemUrl: true,
      validadoManualmente: true,
      estado: true,
    },
  });
  if (!produto) return { produtoId: null, result: { fieldsFilled: 0, imagemFilled: false } };
  if (produto.estado === "INATIVO") {
    return { produtoId: produto.id, result: { fieldsFilled: 0, imagemFilled: false } };
  }
  if (produto.validadoManualmente) {
    // Nunca tocamos em produtos com validação humana.
    return { produtoId: produto.id, result: { fieldsFilled: 0, imagemFilled: false } };
  }

  const data: Record<string, string> = {};
  if (produto.codigoATC == null && fields.codigoATC) data.codigoATC = fields.codigoATC;
  if (produto.dci == null && fields.dci) data.dci = fields.dci;
  if (produto.formaFarmaceutica == null && fields.formaFarmaceutica)
    data.formaFarmaceutica = fields.formaFarmaceutica;
  if (produto.dosagem == null && fields.dosagem) data.dosagem = fields.dosagem;
  if (produto.embalagem == null && fields.embalagem) data.embalagem = fields.embalagem;

  // Imagem regulatória: nunca substitui imagem existente.
  let imagemFilled = false;
  if (produto.imagemUrl == null && fields.imagemUrl) {
    data.imagemUrl = fields.imagemUrl;
    imagemFilled = true;
  }

  if (Object.keys(data).length === 0) {
    return { produtoId: produto.id, result: { fieldsFilled: 0, imagemFilled: false } };
  }
  await prisma.produto.update({ where: { id: produto.id }, data });
  return {
    produtoId: produto.id,
    result: { fieldsFilled: Object.keys(data).length - (imagemFilled ? 1 : 0), imagemFilled },
  };
}

// ─── FilaRevisao hook (Phase E) ─────────────────────────────────────────

/**
 * Enqueue produto em FilaRevisao quando o resultado é ambíguo (ou pode
 * ser usado por outros pontos do pipeline). Idempotente — só cria entry
 * se não existir já uma PENDENTE para o produto.
 */
async function enqueueReview(
  prisma: PrismaClient,
  produtoId: string | null,
  tipoRevisao: "CONFLITO" | "ENRIQUECIMENTO_FALHOU" | "CLASSIFICACAO_PENDENTE",
  dadosOrigem: Prisma.InputJsonValue,
): Promise<void> {
  if (!produtoId) return;
  const existing = await prisma.filaRevisao.findFirst({
    where: { produtoId, tipoRevisao, estado: "PENDENTE" },
    select: { id: true },
  });
  if (existing) return;
  await prisma.filaRevisao.create({
    data: {
      produtoId,
      tipoRevisao,
      prioridade: "MEDIA",
      estado: "PENDENTE",
      dadosOrigem,
    },
  });
}

// ─── Process one job ────────────────────────────────────────────────────

async function processJob(
  prisma: PrismaClient,
  job: ClaimedJob,
  session: SearchSession | null,
  opts: {
    rateLimitMs: number;
    skipInfomedHttp: boolean;
  },
): Promise<{
  outcome: "done" | "partial" | "retry" | "failed" | "blocked" | "noop";
  bySource: { snapshot: FetcherResult; http: FetcherResult | null };
  produtoSync: ProdutoSyncResult;
  rrUpserted: boolean;
}> {
  const cnp = job.cnp;

  // ── 1. Snapshot (DB-only, fast) ──
  const tSnap = Date.now();
  const snap = await infarmedSnapshotFetcher(prisma, cnp);
  const snapDur = Date.now() - tSnap;

  // ── 2. INFOMED HTTP (slow). Skip se snapshot cobre TUDO. ──
  let http: FetcherResult | null = null;
  let httpDur = 0;
  const snapHasAllClinical =
    snap.kind === "ok" &&
    snap.fields.codigoATC != null &&
    snap.fields.dci != null &&
    snap.fields.formaFarmaceutica != null &&
    snap.fields.dosagem != null &&
    snap.fields.embalagem != null;
  // Imagem só vem por HTTP — vale sempre a pena tentar se não tiver
  // imagem ainda. Snapshot cobre clínica, mas perde imagem.
  const needsImage = true; // sempre tentamos se http enabled

  if (!opts.skipInfomedHttp && (!snapHasAllClinical || needsImage)) {
    const tHttp = Date.now();
    http = await infomedHttpFetcher(cnp, job.designacao, {
      session: session ?? undefined,
      rateLimitMs: opts.rateLimitMs,
    });
    httpDur = Date.now() - tHttp;
  }

  // ── 3. Decidir merge + sync ──
  const snapFields = snap.kind === "ok" ? snap.fields : null;
  const httpFields = http && http.kind === "ok" ? http.fields : null;
  const merged = mergeRegulatoryFields(httpFields, snapFields);

  // ── 4. Persistir ──
  // Identifica produto antes de gravar logs para auditoria correcta.
  const { produtoId, result: produtoSync } = await syncToProduto(prisma, cnp, merged);

  // Logs por fonte
  await logEnrichment(prisma, produtoId, "infarmed_snapshot", snap, snapDur, cnp);
  if (http) await logEnrichment(prisma, produtoId, "infomed_http", http, httpDur, cnp);

  // RegulatoryRecord upsert
  let rrUpserted = false;
  if (snapFields || httpFields) {
    const sourceTag =
      httpFields && snapFields
        ? "infomed_http+infarmed_snapshot"
        : httpFields
        ? "infomed_http"
        : "infarmed_snapshot";
    rrUpserted = await upsertRegulatoryRecord(prisma, cnp, merged, sourceTag);
  }

  // ── 5. Decidir outcome do JOB ──
  // ambiguous wins prioritário porque exige revisão humana
  if (http?.kind === "ambiguous") {
    await enqueueReview(prisma, produtoId, "CONFLITO", {
      reason: "infomed_http_ambiguous",
      candidates: http.candidates,
    });
    return { outcome: "blocked", bySource: { snapshot: snap, http }, produtoSync, rrUpserted };
  }
  if (snap.kind === "ok" || http?.kind === "ok") {
    // Considera-se done se todos os campos clínicos chave estão presentes
    const has = (k: keyof RegulatoryFields) => merged[k] != null;
    const done =
      has("codigoATC") &&
      has("dci") &&
      has("formaFarmaceutica") &&
      has("dosagem") &&
      has("embalagem");
    return { outcome: done ? "done" : "partial", bySource: { snapshot: snap, http }, produtoSync, rrUpserted };
  }
  // Ambas fontes falharam — distingue transient vs permanent
  const httpTransient = http?.kind === "error" ? http.transient : false;
  const snapTransient = snap.kind === "error" ? snap.transient : false;
  const transient = httpTransient || snapTransient;
  if (transient && job.attempts < MAX_ATTEMPTS) {
    return { outcome: "retry", bySource: { snapshot: snap, http }, produtoSync, rrUpserted };
  }
  // Sem rastro em nenhuma fonte autoritária — failure permanente
  return { outcome: "failed", bySource: { snapshot: snap, http }, produtoSync, rrUpserted };
}

// ─── Apply outcome ──────────────────────────────────────────────────────

async function applyOutcome(
  prisma: PrismaClient,
  job: ClaimedJob,
  outcome: Awaited<ReturnType<typeof processJob>>,
): Promise<void> {
  const snap = outcome.bySource.snapshot;
  const http = outcome.bySource.http;
  const fieldsObtained =
    outcome.outcome === "done" || outcome.outcome === "partial"
      ? Array.from(
          new Set([
            ...(snap.kind === "ok" ? snap.fieldsObtained : []),
            ...(http && http.kind === "ok" ? http.fieldsObtained : []),
          ]),
        )
      : job.fieldsObtained;

  const sourceResults: Prisma.InputJsonValue = {
    infarmed_snapshot: serializeFetcherResult(snap),
    infomed_http: http ? serializeFetcherResult(http) : null,
    appliedAt: new Date().toISOString(),
  };

  const lastSourceTried =
    http && http.kind === "ok"
      ? "infomed_http"
      : snap.kind === "ok"
      ? "infarmed_snapshot"
      : http?.kind === "error"
      ? "infomed_http"
      : "infarmed_snapshot";

  switch (outcome.outcome) {
    case "done":
      await prisma.regulatoryAcquisitionJob.update({
        where: { id: job.id },
        data: {
          status: "DONE",
          lastSourceTried,
          lastError: null,
          completedAt: new Date(),
          fieldsObtained,
          sourceResults,
        },
      });
      return;
    case "partial":
      await prisma.regulatoryAcquisitionJob.update({
        where: { id: job.id },
        data: {
          status: "PARTIAL",
          lastSourceTried,
          fieldsObtained,
          sourceResults,
          nextAttemptAt: new Date(Date.now() + backoffMsForAttempt(job.attempts)),
        },
      });
      return;
    case "retry":
      await prisma.regulatoryAcquisitionJob.update({
        where: { id: job.id },
        data: {
          status: "PENDING",
          lastSourceTried,
          lastError: describeError(snap, http),
          sourceResults,
          nextAttemptAt: new Date(Date.now() + backoffMsForAttempt(job.attempts)),
        },
      });
      return;
    case "failed":
      await prisma.regulatoryAcquisitionJob.update({
        where: { id: job.id },
        data: {
          status: "FAILED",
          lastSourceTried,
          lastError: describeError(snap, http),
          sourceResults,
        },
      });
      return;
    case "blocked":
      await prisma.regulatoryAcquisitionJob.update({
        where: { id: job.id },
        data: {
          status: "BLOCKED",
          lastSourceTried,
          lastError:
            http && http.kind === "ambiguous"
              ? http.reason
              : "ambiguous (manual review required)",
          sourceResults,
        },
      });
      return;
    case "noop":
      // claim já incrementou attempts; reverter para PENDING sem mexer em métricas
      await prisma.regulatoryAcquisitionJob.update({
        where: { id: job.id },
        data: {
          status: "PENDING",
          lastSourceTried,
          sourceResults,
          nextAttemptAt: new Date(Date.now() + backoffMsForAttempt(job.attempts)),
        },
      });
      return;
  }
}

function serializeFetcherResult(r: FetcherResult): Prisma.InputJsonValue {
  if (r.kind === "ok") {
    return {
      kind: "ok",
      source: r.source,
      fieldsObtained: r.fieldsObtained,
      raw: r.raw as Prisma.InputJsonValue,
    };
  }
  if (r.kind === "not_found") {
    return { kind: "not_found", source: r.source, reason: r.reason };
  }
  if (r.kind === "ambiguous") {
    return {
      kind: "ambiguous",
      source: r.source,
      candidates: r.candidates,
      reason: r.reason,
    };
  }
  return {
    kind: "error",
    source: r.source,
    error: r.error.slice(0, 1000),
    transient: r.transient,
  };
}

function describeError(snap: FetcherResult, http: FetcherResult | null): string {
  const parts: string[] = [];
  if (snap.kind === "not_found") parts.push(`snapshot: ${snap.reason}`);
  if (snap.kind === "error") parts.push(`snapshot error: ${snap.error.slice(0, 200)}`);
  if (http) {
    if (http.kind === "not_found") parts.push(`http: ${http.reason}`);
    if (http.kind === "error") parts.push(`http error: ${http.error.slice(0, 200)}`);
    if (http.kind === "ambiguous") parts.push(`http: ambiguous`);
  }
  return parts.join(" | ").slice(0, 500) || "no data from any source";
}

// ─── Entry point ────────────────────────────────────────────────────────

export async function runAcquisitionTick(
  options: AcquisitionTickOptions,
): Promise<AcquisitionTickSummary> {
  const startedAt = new Date();
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_JOBS;
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  const rateLimitMs = options.rateLimitMs ?? DEFAULT_RATE_LIMIT_MS;
  const sessionMax = options.infomedSessionMaxJobs ?? DEFAULT_INFOMED_SESSION_MAX_JOBS;
  const skipInfomedHttp = options.skipInfomedHttp ?? false;
  const { prisma } = options;
  const deadline = startedAt.getTime() + maxDurationMs;

  const summary: AcquisitionTickSummary = {
    startedAt: startedAt.toISOString(),
    durationMs: 0,
    processed: 0,
    outcomes: { done: 0, partial: 0, retry: 0, failed: 0, blocked: 0, noOpUpdates: 0 },
    bySource: { snapshotHits: 0, httpHits: 0, snapshotMisses: 0, httpMisses: 0, httpErrors: 0 },
    produtoUpdates: { fieldsFilled: 0, imagemUrlFilled: 0 },
    regulatoryRecordUpserts: 0,
    gcReset: 0,
    stoppedReason: "no_jobs",
  };

  // GC primeiro
  summary.gcReset = await gcStuckJobs(prisma);

  // INFOMED session reuse — abrir lazy, só se realmente houver job a precisar
  let session: SearchSession | null = null;
  let sessionJobsUsed = 0;
  const ensureSession = async (): Promise<SearchSession | null> => {
    if (skipInfomedHttp) return null;
    if (session && sessionJobsUsed < sessionMax) return session;
    try {
      session = await openInfomedSession();
      sessionJobsUsed = 0;
      return session;
    } catch (err) {
      // Session falhou — http vai falhar com transient; deixamos snapshot continuar
      console.warn(
        "[acquire-regulatory] failed to open INFOMED session:",
        err instanceof Error ? err.message : String(err),
      );
      session = null;
      return null;
    }
  };

  while (summary.processed < maxJobs) {
    if (Date.now() > deadline) {
      summary.stoppedReason = "deadline";
      break;
    }
    const job = await claimNextJob(prisma);
    if (!job) {
      summary.stoppedReason = "no_jobs";
      break;
    }
    summary.processed++;

    const currentSession = await ensureSession();
    sessionJobsUsed++;

    let outcome;
    try {
      outcome = await processJob(prisma, job, currentSession, { rateLimitMs, skipInfomedHttp });
    } catch (err) {
      // Catch-all: marca o job como retry transient e segue
      console.error("[acquire-regulatory] processJob threw:", err);
      await prisma.regulatoryAcquisitionJob.update({
        where: { id: job.id },
        data: {
          status: job.attempts >= MAX_ATTEMPTS ? "FAILED" : "PENDING",
          lastError: err instanceof Error ? err.message.slice(0, 500) : String(err),
          nextAttemptAt: new Date(Date.now() + backoffMsForAttempt(job.attempts)),
        },
      });
      summary.outcomes.failed++;
      continue;
    }

    await applyOutcome(prisma, job, outcome);

    // Update métricas
    switch (outcome.outcome) {
      case "done":
        summary.outcomes.done++;
        break;
      case "partial":
        summary.outcomes.partial++;
        break;
      case "retry":
        summary.outcomes.retry++;
        break;
      case "failed":
        summary.outcomes.failed++;
        break;
      case "blocked":
        summary.outcomes.blocked++;
        break;
      case "noop":
        summary.outcomes.noOpUpdates++;
        break;
    }
    if (outcome.bySource.snapshot.kind === "ok") summary.bySource.snapshotHits++;
    else if (outcome.bySource.snapshot.kind === "not_found") summary.bySource.snapshotMisses++;
    if (outcome.bySource.http) {
      if (outcome.bySource.http.kind === "ok") summary.bySource.httpHits++;
      else if (outcome.bySource.http.kind === "not_found") summary.bySource.httpMisses++;
      else if (outcome.bySource.http.kind === "error") summary.bySource.httpErrors++;
    }
    summary.produtoUpdates.fieldsFilled += outcome.produtoSync.fieldsFilled;
    if (outcome.produtoSync.imagemFilled) summary.produtoUpdates.imagemUrlFilled++;
    if (outcome.rrUpserted) summary.regulatoryRecordUpserts++;
  }

  if (summary.processed === maxJobs) summary.stoppedReason = "max_jobs";
  summary.durationMs = Date.now() - startedAt.getTime();
  return summary;
}
