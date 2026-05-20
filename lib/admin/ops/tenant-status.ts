import "server-only";
import { getTenantBySlug } from "@/lib/control-plane";
import { getTenantPrismaForAdmin } from "@/lib/admin/tenant-client";
import { AdminApiError } from "@/lib/admin/ops/_shared";
import { PIPELINE_KIND, PIPELINE_STATUS } from "@/lib/pipeline/types";

/**
 * lib/admin/ops/tenant-status.ts
 *
 * Equivalente HTTP de `scripts/tenancy/status.ts` (DEV CLI). Read-only.
 * Devolve dados ESTRUTURADOS (o wizard formata) em vez de texto ASCII —
 * evita duplicar a formatação do CLI. Funciona mesmo com tenant não
 * ACTIVE (mostra o que o control plane sabe; só liga à BD se ACTIVE).
 */

export type PipelineRunSummary = {
  status: string;
  ok: boolean;
  startedAt: string;
  dateRef: string | null;
  errorMessage: string | null;
} | null;

export type TenantStatusResult = {
  slug: string;
  controlPlane: {
    nome: string;
    id: string;
    estado: string;
    dbHost: string;
    dbName: string;
    dbPort: number;
    provisionedAt: string | null;
    schemaVersion: string | null;
    region: string | null;
    ingestKeyIssued: boolean;
    ingestKeyIssuedAt: string | null;
  };
  tenantDb: {
    reachable: boolean;
    error: string | null;
    migrationsTotal: number;
    migrationsUnfinished: number;
    lastMigration: string | null;
    farmaciasAtivas: number;
    farmaciasTotal: number;
    farmacias: Array<{
      nome: string;
      codigoANF: string | null;
      estado: string;
    }>;
    pipeline: {
      daily: PipelineRunSummary;
      aggregate: PipelineRunSummary;
      dailySync: PipelineRunSummary;
    };
    vendaMensalRows: number;
    vendaMensalLastMonth: string | null;
    stagingUnknowns: number;
    stagingOperationalOrphans: number;
    stagingNonStockServices: number;
  } | null;
  exitCode: number;
};

type RawRun = {
  status: string;
  startedAt: Date;
  dateRef: string | null;
  errorMessage: string | null;
} | null;

function toRunSummary(run: RawRun): PipelineRunSummary {
  if (!run) return null;
  return {
    status: run.status,
    ok: run.status === PIPELINE_STATUS.OK,
    startedAt: run.startedAt.toISOString(),
    dateRef: run.dateRef ?? null,
    errorMessage: run.errorMessage ? run.errorMessage.slice(0, 200) : null,
  };
}

export async function getTenantStatus(slug: string): Promise<TenantStatusResult> {
  if (!slug || slug.trim() === "") {
    throw new AdminApiError(400, "slug em falta", "bad_request");
  }
  const tenant = await getTenantBySlug(slug.trim());
  if (!tenant) {
    throw new AdminApiError(404, `tenant "${slug}" não existe`, "tenant_not_found");
  }

  const controlPlane = {
    nome: tenant.nome,
    id: tenant.id,
    estado: tenant.estado,
    dbHost: tenant.dbHost,
    dbName: tenant.dbName,
    dbPort: tenant.dbPort,
    provisionedAt: tenant.provisionedAt ? tenant.provisionedAt.toISOString() : null,
    schemaVersion: tenant.schemaVersion,
    region: tenant.dbRegion,
    ingestKeyIssued: !!tenant.ingestApiKeyHash,
    ingestKeyIssuedAt: tenant.ingestApiKeyIssuedAt
      ? tenant.ingestApiKeyIssuedAt.toISOString()
      : null,
  };

  if (tenant.estado !== "ACTIVE") {
    return { slug: tenant.slug, controlPlane, tenantDb: null, exitCode: 1 };
  }

  const prisma = getTenantPrismaForAdmin(tenant);

  // Conectividade
  try {
    await prisma.$queryRaw`SELECT 1 AS ok`;
  } catch (err) {
    return {
      slug: tenant.slug,
      controlPlane,
      tenantDb: {
        reachable: false,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
        migrationsTotal: 0,
        migrationsUnfinished: 0,
        lastMigration: null,
        farmaciasAtivas: 0,
        farmaciasTotal: 0,
        farmacias: [],
        pipeline: { daily: null, aggregate: null, dailySync: null },
        vendaMensalRows: 0,
        vendaMensalLastMonth: null,
        stagingUnknowns: 0,
        stagingOperationalOrphans: 0,
        stagingNonStockServices: 0,
      },
      exitCode: 1,
    };
  }

  // Migrations
  let migrationsTotal = 0;
  let migrationsUnfinished = 0;
  let lastMigration: string | null = null;
  try {
    const rows = await prisma.$queryRaw<
      Array<{ name: string; finished: Date | null }>
    >`
      SELECT migration_name AS "name", finished_at AS "finished"
      FROM _prisma_migrations
      ORDER BY finished_at DESC NULLS FIRST
    `;
    migrationsTotal = rows.length;
    migrationsUnfinished = rows.filter((r) => r.finished === null).length;
    lastMigration = rows[0]?.name ?? null;
  } catch {
    // tabela inexistente / sem permissões — deixa contadores a 0
  }

  const farmacias = await prisma.farmacia.findMany({
    select: { nome: true, codigoANF: true, estado: true },
    orderBy: { nome: "asc" },
  });
  const farmaciasAtivas = farmacias.filter((f) => f.estado === "ATIVO").length;

  const [lastDaily, lastAgg, lastSync] = await Promise.all([
    prisma.pipelineRun.findFirst({
      where: { kind: PIPELINE_KIND.DAILY },
      orderBy: { startedAt: "desc" },
      select: { status: true, startedAt: true, dateRef: true, errorMessage: true },
    }),
    prisma.pipelineRun.findFirst({
      where: { kind: PIPELINE_KIND.AGGREGATE },
      orderBy: { startedAt: "desc" },
      select: { status: true, startedAt: true, dateRef: true, errorMessage: true },
    }),
    prisma.pipelineRun.findFirst({
      where: { kind: PIPELINE_KIND.DAILY_SYNC },
      orderBy: { startedAt: "desc" },
      select: { status: true, startedAt: true, dateRef: true, errorMessage: true },
    }),
  ]);

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

  let exitCode = 0;
  if (migrationsUnfinished > 0) exitCode = 2;
  else if (stagingUnknowns > 0) exitCode = 3;
  else if (farmaciasAtivas === 0) exitCode = 4;
  else if (lastDaily && lastDaily.status !== PIPELINE_STATUS.OK) exitCode = 5;

  return {
    slug: tenant.slug,
    controlPlane,
    tenantDb: {
      reachable: true,
      error: null,
      migrationsTotal,
      migrationsUnfinished,
      lastMigration,
      farmaciasAtivas,
      farmaciasTotal: farmacias.length,
      farmacias,
      pipeline: {
        daily: toRunSummary(lastDaily),
        aggregate: toRunSummary(lastAgg),
        dailySync: toRunSummary(lastSync),
      },
      vendaMensalRows: vmRows,
      vendaMensalLastMonth: vmLastMonth
        ? `${vmLastMonth.ano}-${String(vmLastMonth.mes).padStart(2, "0")}`
        : null,
      stagingUnknowns,
      stagingOperationalOrphans: stagingOrphans,
      stagingNonStockServices: stagingServices,
    },
    exitCode,
  };
}
