/**
 * app/api/admin/enrichment-health/route.ts
 *
 * Endpoint de saúde do pipeline de enriquecimento. Lê `SyncRun` do
 * control plane e devolve, por (tenantSlug, source):
 *   · última execução (startedAt/finishedAt/status/durationMs/errorSummary)
 *   · idade em horas desde a última execução COMPLETED
 *   · se há run RUNNING sem heartbeat há mais de 5min
 *
 * Alertas emitidos:
 *   · `no_recent_success` — nenhuma execução COMPLETED nas últimas
 *     `staleAfterHours` horas (default 26h — cobre o gap do cron diário
 *     + 2h de folga)
 *   · `stuck_running`     — run RUNNING com heartbeat > 5min de atraso
 *
 * Auth: mesmo CRON_SECRET dos endpoints /api/jobs/*, aceite via header
 * Bearer ou `?secret=`. Não expõe dados sensíveis (nada de payloads
 * bruto), apenas metadados.
 *
 * Manual test:
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *        "https://spharm-mt.vercel.app/api/admin/enrichment-health"
 */

import { NextResponse, type NextRequest } from "next/server";
import { authorizeCronRequest } from "@/lib/jobs/cron-auth";
import { getControlPrismaCli } from "@/lib/sync/control-client-cli";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Sources que o pipeline de enriquecimento produz. Se um deles não
// aparecer na resposta é porque nunca correu — o próprio facto é o alerta.
const TRACKED_SOURCES = ["enqueue-regulatory", "acquire-regulatory", "enrich-catalog"] as const;

const STUCK_HEARTBEAT_MS = 5 * 60 * 1000;
const DEFAULT_STALE_AFTER_HOURS = 26;

type SourceHealth = {
  tenantSlug: string;
  source: string;
  lastCompleted: {
    startedAt: string;
    finishedAt: string | null;
    durationMs: number | null;
    recordsRead: number;
    recordsInserted: number;
    recordsUpdated: number;
    recordsFailed: number;
    ageHours: number;
  } | null;
  lastFailed: {
    startedAt: string;
    finishedAt: string | null;
    errorSummary: string | null;
    ageHours: number;
  } | null;
  currentlyRunning: {
    id: string;
    startedAt: string;
    lastHeartbeatAt: string | null;
    heartbeatAgeSeconds: number | null;
  } | null;
  alerts: Array<"no_recent_success" | "stuck_running">;
};

async function handle(req: NextRequest): Promise<Response> {
  const auth = authorizeCronRequest(req);
  if (!auth.ok) {
    return NextResponse.json(
      auth.reason === "missing_env"
        ? { ok: false, error: "server_misconfigured", message: "CRON_SECRET not configured" }
        : { ok: false, error: "unauthorized" },
      { status: auth.reason === "missing_env" ? 503 : 401 },
    );
  }

  const url = req.nextUrl;
  const staleParam = url.searchParams.get("staleAfterHours");
  const staleAfterHours = (() => {
    const n = staleParam ? parseInt(staleParam, 10) : NaN;
    return Number.isFinite(n) && n >= 1 && n <= 168 ? n : DEFAULT_STALE_AFTER_HOURS;
  })();
  const stuckCutoff = new Date(Date.now() - STUCK_HEARTBEAT_MS);

  const cp = getControlPrismaCli();

  // 1. Tenants ACTIVE
  const tenants = await cp.tenant.findMany({
    where: { estado: "ACTIVE" },
    select: { slug: true, nome: true },
    orderBy: { slug: "asc" },
  });

  // 2. Para cada (tenant × source) — 3 queries paralelas
  const rowsPerCell: SourceHealth[] = [];
  await Promise.all(
    tenants.flatMap((t) =>
      TRACKED_SOURCES.map(async (source) => {
        const [lastCompleted, lastFailed, running] = await Promise.all([
          cp.syncRun.findFirst({
            where: { tenantSlug: t.slug, source, status: "COMPLETED" },
            orderBy: { startedAt: "desc" },
            select: {
              startedAt: true, finishedAt: true, durationMs: true,
              recordsRead: true, recordsInserted: true, recordsUpdated: true, recordsFailed: true,
            },
          }),
          cp.syncRun.findFirst({
            where: { tenantSlug: t.slug, source, status: "FAILED" },
            orderBy: { startedAt: "desc" },
            select: { startedAt: true, finishedAt: true, errorSummary: true },
          }),
          cp.syncRun.findFirst({
            where: { tenantSlug: t.slug, source, status: "RUNNING" },
            orderBy: { startedAt: "desc" },
            select: { id: true, startedAt: true, lastHeartbeatAt: true },
          }),
        ]);

        const alerts: SourceHealth["alerts"] = [];
        const now = Date.now();

        const lc = lastCompleted
          ? {
              startedAt: lastCompleted.startedAt.toISOString(),
              finishedAt: lastCompleted.finishedAt?.toISOString() ?? null,
              durationMs: lastCompleted.durationMs,
              recordsRead: lastCompleted.recordsRead,
              recordsInserted: lastCompleted.recordsInserted,
              recordsUpdated: lastCompleted.recordsUpdated,
              recordsFailed: lastCompleted.recordsFailed,
              ageHours: (now - lastCompleted.startedAt.getTime()) / (3600_000),
            }
          : null;
        if (!lc || lc.ageHours > staleAfterHours) alerts.push("no_recent_success");

        const lf = lastFailed
          ? {
              startedAt: lastFailed.startedAt.toISOString(),
              finishedAt: lastFailed.finishedAt?.toISOString() ?? null,
              errorSummary: lastFailed.errorSummary,
              ageHours: (now - lastFailed.startedAt.getTime()) / (3600_000),
            }
          : null;

        let cr: SourceHealth["currentlyRunning"] = null;
        if (running) {
          const hbAge = running.lastHeartbeatAt
            ? (now - running.lastHeartbeatAt.getTime()) / 1000
            : null;
          cr = {
            id: running.id,
            startedAt: running.startedAt.toISOString(),
            lastHeartbeatAt: running.lastHeartbeatAt?.toISOString() ?? null,
            heartbeatAgeSeconds: hbAge,
          };
          // Stuck se sem heartbeat e iniciado há mais de 30s, OU heartbeat > 5min
          const startedTooLongAgo =
            !running.lastHeartbeatAt && running.startedAt < stuckCutoff;
          const heartbeatTooOld =
            running.lastHeartbeatAt !== null && running.lastHeartbeatAt < stuckCutoff;
          if (startedTooLongAgo || heartbeatTooOld) alerts.push("stuck_running");
        }

        rowsPerCell.push({
          tenantSlug: t.slug,
          source,
          lastCompleted: lc,
          lastFailed: lf,
          currentlyRunning: cr,
          alerts,
        });
      }),
    ),
  );

  const totalAlerts = rowsPerCell.reduce((a, r) => a + r.alerts.length, 0);
  const overall = totalAlerts === 0 ? "healthy" : "degraded";

  return NextResponse.json(
    {
      ok: true,
      generatedAt: new Date().toISOString(),
      overall,
      staleAfterHours,
      totalTenants: tenants.length,
      totalAlerts,
      cells: rowsPerCell.sort((a, b) =>
        a.tenantSlug.localeCompare(b.tenantSlug) || a.source.localeCompare(b.source),
      ),
    },
    { status: overall === "healthy" ? 200 : 207 },
  );
}

export const GET = handle;
export const POST = handle;
