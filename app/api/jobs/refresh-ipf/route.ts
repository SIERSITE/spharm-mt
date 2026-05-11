/**
 * app/api/jobs/refresh-ipf/route.ts
 *
 * Entry-point HTTP do scheduler para refresh do read-model
 * `IndicadoresProdutoFarmacia`. Invocado por Vercel Cron diariamente
 * (ver `vercel.json`); também pode ser disparado manualmente.
 *
 * Autenticação:
 *   · `Authorization: Bearer <CRON_SECRET>` (Vercel injecta este header
 *     automaticamente quando dispara um cron).
 *   · Em alternativa, query `?secret=<CRON_SECRET>` para testes
 *     manuais via browser / curl.
 *   · Se `CRON_SECRET` não estiver definido em env, o endpoint recusa
 *     **sempre** — defesa contra deploys mal-configurados.
 *
 * Política:
 *   · Apenas modo legacy (single-DB) nesta passagem. Multi-tenant fica
 *     preparado mas não activado — quando `CONTROL_DATABASE_URL`
 *     existir, evoluímos para um body opcional `{ tenant: "<slug>" }`
 *     ou um cron por tenant.
 *   · Chama `runIpfPopulate` da lib directamente (mesma orquestração
 *     que `scripts/populate-indicadores-produto-farmacia.ts`).
 *   · Após o populate, corre `getIpfFreshness` para validar saúde do
 *     read-model.
 *   · Retorna JSON estruturado com counts, durations e veredicto. O
 *     status HTTP é 200 quando healthy; 503 quando populate corre mas
 *     o health check falha (caller alerta operacional pode reagir).
 *
 * Não escreve UI nova. Não toca em encomendas. Sem writes em outras
 * tabelas — só upsert idempotente sobre `IndicadoresProdutoFarmacia`.
 *
 * Manual test:
 *   curl -i "http://localhost:3000/api/jobs/refresh-ipf?secret=$CRON_SECRET&dry=1"
 *   curl -i -X POST "http://localhost:3000/api/jobs/refresh-ipf?secret=$CRON_SECRET"
 */

import { NextResponse, type NextRequest } from "next/server";
import { legacyPrisma } from "@/lib/prisma";
import { runIpfPopulate } from "@/lib/operational/ipf-populate";
import { getIpfFreshness } from "@/lib/operational/ipf-freshness";
import { authorizeCronRequest } from "@/lib/jobs/cron-auth";

// Cron jobs precisam de runtime Node + execução não cacheada.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Permite até 5 minutos — o populate live demora <15s em legacy mas
// abre folga para arranque a frio do Neon + connection pool.
export const maxDuration = 300;

type SuccessPayload = {
  ok: true;
  status: "healthy" | "unhealthy";
  invokedAt: string;
  durationMs: number;
  populate: {
    dryRun: boolean;
    farmacias: number;
    produtoFarmacia: number;
    rowsCalculated: number;
    rowsUpserted: number;
    rowsFailed: number;
    batches: number;
  };
  health: {
    coverage: number;
    ageHours: number | null;
    totalIpfRows: number;
    isStale: boolean;
    isLowCoverage: boolean;
    reasons: string[];
  };
};

type ErrorPayload = {
  ok: false;
  error: string;
  message?: string;
};

async function handle(req: NextRequest): Promise<Response> {
  const t0 = Date.now();
  const auth = authorizeCronRequest(req);
  if (!auth.ok) {
    const payload: ErrorPayload =
      auth.reason === "missing_env"
        ? { ok: false, error: "server_misconfigured", message: "CRON_SECRET not configured" }
        : { ok: false, error: "unauthorized" };
    const status = auth.reason === "missing_env" ? 503 : 401;
    return NextResponse.json(payload, { status });
  }

  // Optional ?dry=1 para verificar pipeline sem escrever.
  const dryRun = req.nextUrl.searchParams.get("dry") === "1";

  try {
    const result = await runIpfPopulate(legacyPrisma, { dryRun });
    const fresh = await getIpfFreshness(legacyPrisma);

    const payload: SuccessPayload = {
      ok: true,
      status: fresh.healthy ? "healthy" : "unhealthy",
      invokedAt: new Date(t0).toISOString(),
      durationMs: Date.now() - t0,
      populate: {
        dryRun: result.dryRun,
        farmacias: result.farmaciasCount,
        produtoFarmacia: result.pfRowsCount,
        rowsCalculated: result.rowsCalculated,
        rowsUpserted: result.rowsUpserted,
        rowsFailed: result.rowsFailed,
        batches: result.batches,
      },
      health: {
        coverage: Number(fresh.coverage.toFixed(4)),
        ageHours: fresh.ageHours === null ? null : Number(fresh.ageHours.toFixed(2)),
        totalIpfRows: fresh.totalIpfRows,
        isStale: fresh.isStale,
        isLowCoverage: fresh.isLowCoverage,
        reasons: fresh.reasons,
      },
    };
    // 200 quando healthy, 503 quando populate correu mas o read-model
    // continua unhealthy (dry-run nunca actualiza o dataCalculo →
    // ageHours fica alto; trata-se 503 também, accionável manual).
    const status = fresh.healthy && result.rowsFailed === 0 ? 200 : 503;
    return NextResponse.json(payload, { status });
  } catch (err) {
    console.error("[api/jobs/refresh-ipf] fatal", err);
    const payload: ErrorPayload = {
      ok: false,
      error: "internal_error",
      message: err instanceof Error ? err.message : String(err),
    };
    return NextResponse.json(payload, { status: 500 });
  }
}

// Vercel Cron dispara GET; manual pode usar POST. Aceitamos ambos.
export const GET = handle;
export const POST = handle;
