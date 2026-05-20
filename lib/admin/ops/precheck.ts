import "server-only";
import { getTenantBySlug } from "@/lib/control-plane";
import { getTenantPrismaForAdmin } from "@/lib/admin/tenant-client";
import { AdminApiError } from "@/lib/admin/ops/_shared";
import { ENV_CATALOG } from "@/lib/env";
import { PIPELINE_KIND, PIPELINE_STATUS } from "@/lib/pipeline/types";

/**
 * lib/admin/ops/precheck.ts
 *
 * Equivalente HTTP de `scripts/pilot-precheck.ts` (DEV CLI). Read-only.
 * Devolve a lista estruturada de checks (✓/⚠/✗) + sumário. Os checks de
 * ENV validam o ambiente do SERVIDOR (Vercel) — é lá que correm.
 */

const STALE_DAILY_PIPELINE_HOURS = 36;
const REQUIRED_ENVS = [
  "DATABASE_URL",
  "CONTROL_DATABASE_URL",
  "TENANT_ENCRYPTION_SECRET",
];
const RECOMMENDED_ENVS_PROD = ["ENABLE_AGENT_BOOTSTRAP"];

export type CheckResult = {
  id: string;
  label: string;
  status: "ok" | "warn" | "fail";
  detail?: string;
};

export type PrecheckResult = {
  slug: string;
  checks: CheckResult[];
  summary: { oks: number; warns: number; fails: number };
  status: "ready" | "ready_with_warnings" | "not_ready";
};

export async function runPrecheck(slug: string): Promise<PrecheckResult> {
  if (!slug || slug.trim() === "") {
    throw new AdminApiError(400, "slug em falta", "bad_request");
  }
  const tenantSlug = slug.trim();
  const checks: CheckResult[] = [];

  // 1. ENV vars críticas (do servidor)
  for (const name of REQUIRED_ENVS) {
    const value = process.env[name];
    const spec = ENV_CATALOG.find((e) => e.name === name);
    checks.push({
      id: `env:${name}`,
      label: `ENV ${name} ${spec ? `[${spec.level}]` : ""}`.trim(),
      status: value && value.length > 0 ? "ok" : "fail",
      detail:
        !value || value.length === 0
          ? "vazio — definir no Vercel + .env"
          : undefined,
    });
  }
  for (const name of RECOMMENDED_ENVS_PROD) {
    const value = process.env[name];
    const on = value === "1" || value === "true";
    checks.push({
      id: `env:${name}`,
      label: `ENV ${name} [recommended]`,
      status: on ? "ok" : "warn",
      detail: on
        ? undefined
        : `valor=${value ?? "(vazio)"} — sem isto agent/pipeline endpoints respondem 503`,
    });
  }

  // 2. Control plane + tenant
  const tenant = await getTenantBySlug(tenantSlug);
  if (!tenant) {
    checks.push({
      id: "tenant:exists",
      label: "Tenant existe no control plane",
      status: "fail",
      detail: `slug "${tenantSlug}" não encontrado`,
    });
    return finalize(tenantSlug, checks);
  }
  checks.push({
    id: "tenant:exists",
    label: "Tenant existe no control plane",
    status: "ok",
    detail: `id=${tenant.id.slice(0, 12)}…`,
  });
  checks.push({
    id: "tenant:active",
    label: "Tenant em estado ACTIVE",
    status: tenant.estado === "ACTIVE" ? "ok" : "fail",
    detail: tenant.estado !== "ACTIVE" ? `estado=${tenant.estado}` : undefined,
  });
  checks.push({
    id: "tenant:ingest_key",
    label: "Ingest key gerada",
    status: tenant.ingestApiKeyHash ? "ok" : "fail",
    detail: tenant.ingestApiKeyHash ? undefined : "gerar via Agent ZIP (rotate)",
  });

  if (tenant.estado !== "ACTIVE") {
    return finalize(tenantSlug, checks);
  }

  const prisma = getTenantPrismaForAdmin(tenant);

  // 3. Tenant DB connectivity
  let dbOk = false;
  try {
    await prisma.$queryRaw`SELECT 1 AS ok`;
    dbOk = true;
    checks.push({ id: "tenant:db_connect", label: "Tenant DB acessível", status: "ok" });
  } catch (err) {
    checks.push({
      id: "tenant:db_connect",
      label: "Tenant DB acessível",
      status: "fail",
      detail: err instanceof Error ? err.message.slice(0, 80) : String(err),
    });
  }

  if (dbOk) {
    // 4. Migrations
    try {
      const migRows = await prisma.$queryRaw<
        Array<{ name: string; finished: Date | null }>
      >`
        SELECT migration_name AS "name", finished_at AS "finished"
        FROM _prisma_migrations
        ORDER BY finished_at DESC NULLS FIRST
      `;
      const unfinished = migRows.filter((r) => r.finished === null);
      checks.push({
        id: "tenant:migrations",
        label: "Migrations completas",
        status: unfinished.length > 0 ? "fail" : "ok",
        detail:
          unfinished.length > 0
            ? `${unfinished.length} sem finished_at: ${unfinished.map((u) => u.name).slice(0, 2).join(", ")}`
            : `${migRows.length} aplicadas, última: ${migRows[0]?.name ?? "—"}`,
      });
    } catch (err) {
      checks.push({
        id: "tenant:migrations",
        label: "Migrations completas",
        status: "fail",
        detail: err instanceof Error ? err.message.slice(0, 80) : String(err),
      });
    }

    // 5. Farmácia activa
    const farmaciasAtivas = await prisma.farmacia.count({ where: { estado: "ATIVO" } });
    checks.push({
      id: "tenant:farmacia_ativa",
      label: "Pelo menos 1 farmácia activa",
      status: farmaciasAtivas > 0 ? "ok" : "fail",
      detail: `${farmaciasAtivas} farmácia(s)`,
    });

    // 6. Classifier mínimo
    const classifications = await prisma.tipoDocumentoClassificacao.findMany({
      where: { tipoDocumento: { in: [77, 104] } },
      select: { tipoDocumento: true, classe: true },
    });
    const map = new Map(classifications.map((c) => [c.tipoDocumento, c.classe]));
    const ok77 = map.get(77) === "VENDA";
    const ok104 = map.get(104) === "DEVOLUCAO_ANULACAO";
    checks.push({
      id: "tenant:classifier_77",
      label: "TipoDocumento 77 classificado como VENDA",
      status: ok77 ? "ok" : "fail",
      detail: ok77 ? undefined : `mapping="${map.get(77) ?? "(falta)"}"`,
    });
    checks.push({
      id: "tenant:classifier_104",
      label: "TipoDocumento 104 classificado como DEVOLUCAO_ANULACAO",
      status: ok104 ? "ok" : "fail",
      detail: ok104 ? undefined : `mapping="${map.get(104) ?? "(falta)"}"`,
    });

    // 7. Staging healthy
    const [unknowns, opOrphans] = await Promise.all([
      prisma.ingestVendaLinhaRaw.count({ where: { tipoDocumentoClass: "UNKNOWN" } }),
      prisma.ingestVendaLinhaRaw.count({
        where: { produtoId: null, isNonStockService: false },
      }),
    ]);
    checks.push({
      id: "staging:unknowns",
      label: "Staging IngestVendaLinhaRaw sem UNKNOWN",
      status: unknowns === 0 ? "ok" : "fail",
      detail: unknowns > 0 ? `${unknowns} linhas — classifier incompleto` : undefined,
    });
    checks.push({
      id: "staging:op_orphans",
      label: "Staging sem operational orphans",
      status: opOrphans === 0 ? "ok" : "warn",
      detail: opOrphans > 0 ? `${opOrphans} linhas — investigar` : undefined,
    });

    // 8. Pelo menos 1 mês agregado
    const lastVM = await prisma.vendaMensal.findFirst({
      where: { origemAgregacao: "agent-bootstrap-staging" },
      orderBy: [{ ano: "desc" }, { mes: "desc" }],
      select: { ano: true, mes: true },
    });
    checks.push({
      id: "vendamensal:any",
      label: "Pelo menos 1 mês agregado em VendaMensal",
      status: lastVM ? "ok" : "fail",
      detail: lastVM
        ? `último: ${lastVM.ano}-${String(lastVM.mes).padStart(2, "0")}`
        : "ainda sem agregação",
    });

    // 9. Último daily-pipeline
    const lastDaily = await prisma.pipelineRun.findFirst({
      where: { kind: PIPELINE_KIND.DAILY },
      orderBy: { startedAt: "desc" },
      select: { status: true, startedAt: true },
    });
    if (!lastDaily) {
      checks.push({
        id: "pipeline:daily_exists",
        label: "daily-pipeline já correu pelo menos 1 vez",
        status: "warn",
        detail: "Task Scheduler ainda não disparou — testar manualmente",
      });
    } else {
      const ageH = (Date.now() - lastDaily.startedAt.getTime()) / 3_600_000;
      checks.push({
        id: "pipeline:daily_recent",
        label: `Último daily-pipeline < ${STALE_DAILY_PIPELINE_HOURS}h`,
        status:
          ageH <= STALE_DAILY_PIPELINE_HOURS
            ? lastDaily.status === PIPELINE_STATUS.OK
              ? "ok"
              : "fail"
            : "warn",
        detail: `${ageH.toFixed(1)}h atrás, status=${lastDaily.status}`,
      });
    }
  }

  return finalize(tenantSlug, checks);
}

function finalize(slug: string, checks: CheckResult[]): PrecheckResult {
  const oks = checks.filter((c) => c.status === "ok").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  const fails = checks.filter((c) => c.status === "fail").length;
  const status: PrecheckResult["status"] =
    fails > 0 ? "not_ready" : warns > 0 ? "ready_with_warnings" : "ready";
  return { slug, checks, summary: { oks, warns, fails }, status };
}
