/**
 * scripts/pilot-precheck.ts
 *
 * Pré-check único de go-live para um tenant piloto. Encapsula numa
 * só execução todas as verificações que o admin tem de fazer antes
 * de declarar produção.
 *
 * Verifica:
 *   1. ENV vars críticas (DATABASE_URL, CONTROL_DATABASE_URL,
 *      TENANT_ENCRYPTION_SECRET, ENABLE_AGENT_BOOTSTRAP)
 *   2. Control plane connectivity + tenant existe + ACTIVE
 *   3. Tenant DB connectivity
 *   4. Migrations todas aplicadas (sem pendentes)
 *   5. Pelo menos 1 farmácia activa
 *   6. Ingest key configurada (hash existe)
 *   7. Pipeline state: último daily-pipeline OK em < 36h (se algum existir)
 *   8. Staging healthy: 0 UNKNOWN, 0 operational orphans
 *   9. Pelo menos 1 mês agregado em VendaMensal
 *  10. Classifier mínimo (tipoDocumento 77 + 104 mapeados)
 *
 * Output: tabela ✓/✗ + exit code = nº de checks falhados.
 *
 * Uso:
 *   npm run pilot:precheck -- --tenant demo-neon
 *
 * Read-only. Idempotente. Não modifica nada.
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
import { ENV_CATALOG } from "@/lib/env";
import { PIPELINE_KIND, PIPELINE_STATUS } from "@/lib/pipeline/types";

const STALE_DAILY_PIPELINE_HOURS = 36;
const REQUIRED_ENVS = [
  "DATABASE_URL",
  "CONTROL_DATABASE_URL",
  "TENANT_ENCRYPTION_SECRET",
];
const RECOMMENDED_ENVS_PROD = ["ENABLE_AGENT_BOOTSTRAP"];

type CheckResult = {
  id: string;
  label: string;
  status: "ok" | "warn" | "fail";
  detail?: string;
};

function parseCmdArgs(): { tenant?: string } {
  const { values } = parseArgs({
    options: { tenant: { type: "string" } },
    strict: true,
  });
  return { tenant: values.tenant };
}

function glyph(s: CheckResult["status"]): string {
  return s === "ok" ? "✓" : s === "warn" ? "⚠" : "✗";
}

function renderRow(r: CheckResult): void {
  const g = glyph(r.status).padEnd(2);
  const label = r.label.padEnd(52);
  const detail = r.detail ? ` — ${r.detail}` : "";
  console.log(`  ${g} ${label}${detail}`);
}

async function main(): Promise<void> {
  const args = parseCmdArgs();
  if (!args.tenant) {
    console.error("✗ --tenant <slug> obrigatório.");
    process.exit(1);
  }

  console.log("─".repeat(78));
  console.log(`pilot-precheck — ${args.tenant}`);
  console.log("─".repeat(78));
  console.log("");

  const checks: CheckResult[] = [];

  /* ── 1. ENV vars críticas ───────────────────────────────────────── */
  for (const name of REQUIRED_ENVS) {
    const value = process.env[name];
    const spec = ENV_CATALOG.find((e) => e.name === name);
    checks.push({
      id: `env:${name}`,
      label: `ENV ${name} ${spec ? `[${spec.level}]` : ""}`,
      status: value && value.length > 0 ? "ok" : "fail",
      detail: !value || value.length === 0 ? "vazio — definir no Vercel + .env local" : undefined,
    });
  }
  for (const name of RECOMMENDED_ENVS_PROD) {
    const value = process.env[name];
    checks.push({
      id: `env:${name}`,
      label: `ENV ${name} [recommended]`,
      status: value === "1" || value === "true" ? "ok" : "warn",
      detail:
        value === "1" || value === "true"
          ? undefined
          : `valor=${value ?? "(vazio)"} — sem isto agent/pipeline endpoints respondem 503`,
    });
  }

  /* ── 2. Control plane + tenant ─────────────────────────────────── */
  let tenant: Awaited<ReturnType<typeof getTenantBySlug>> | null = null;
  try {
    tenant = await getTenantBySlug(args.tenant);
    if (!tenant) {
      checks.push({
        id: "tenant:exists",
        label: "Tenant existe no control plane",
        status: "fail",
        detail: `slug "${args.tenant}" não encontrado`,
      });
    } else {
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
        detail: tenant.ingestApiKeyHash
          ? undefined
          : "executar `npm run tenancy:issue-ingest-key --tenant <slug>`",
      });
    }
  } catch (err) {
    checks.push({
      id: "tenant:exists",
      label: "Tenant existe no control plane",
      status: "fail",
      detail: err instanceof Error ? err.message.slice(0, 80) : String(err),
    });
  }

  /* ── 3. Tenant DB connectivity + migrations + dados ────────────── */
  let prisma: PrismaClient | null = null;
  if (tenant && tenant.estado === "ACTIVE") {
    try {
      const url = buildTenantConnectionString(tenant);
      const adapter = new PrismaPg({ connectionString: url });
      prisma = new PrismaClient({ adapter });
      // Smoke query
      await prisma.$queryRaw`SELECT 1 AS ok`;
      checks.push({
        id: "tenant:db_connect",
        label: "Tenant DB acessível",
        status: "ok",
      });
    } catch (err) {
      checks.push({
        id: "tenant:db_connect",
        label: "Tenant DB acessível",
        status: "fail",
        detail: err instanceof Error ? err.message.slice(0, 80) : String(err),
      });
    }

    /* ── 4. Migrations todas aplicadas (via prisma migrate status) ── */
    // O wrapper `tenancy:migrate-all --dry-run --only <slug>` reporta
    // pendências. Aqui fazemos check directo via Prisma client: a tabela
    // _prisma_migrations existe + ausência de checksum vazios.
    if (prisma) {
      try {
        const migRows = await prisma.$queryRaw<
          Array<{ name: string; finished: Date | null }>
        >`
          SELECT migration_name AS "name", finished_at AS "finished"
          FROM _prisma_migrations
          ORDER BY finished_at DESC NULLS FIRST
        `;
        const unfinished = migRows.filter((r) => r.finished === null);
        if (unfinished.length > 0) {
          checks.push({
            id: "tenant:migrations",
            label: "Migrations completas",
            status: "fail",
            detail: `${unfinished.length} migration(s) sem finished_at: ${unfinished.map((u) => u.name).slice(0, 2).join(", ")}`,
          });
        } else {
          checks.push({
            id: "tenant:migrations",
            label: "Migrations completas",
            status: "ok",
            detail: `${migRows.length} aplicadas, última: ${migRows[0]?.name ?? "—"}`,
          });
        }
      } catch (err) {
        checks.push({
          id: "tenant:migrations",
          label: "Migrations completas",
          status: "fail",
          detail: err instanceof Error ? err.message.slice(0, 80) : String(err),
        });
      }
    }

    /* ── 5. Farmácia activa ─────────────────────────────────────── */
    if (prisma) {
      const farmaciasAtivas = await prisma.farmacia.count({ where: { estado: "ATIVO" } });
      checks.push({
        id: "tenant:farmacia_ativa",
        label: "Pelo menos 1 farmácia activa",
        status: farmaciasAtivas > 0 ? "ok" : "fail",
        detail: `${farmaciasAtivas} farmácia(s)`,
      });
    }

    /* ── 6. Classifier mínimo ───────────────────────────────────── */
    if (prisma) {
      const requiredTipos = [77, 104];
      const classifications = await prisma.tipoDocumentoClassificacao.findMany({
        where: { tipoDocumento: { in: requiredTipos } },
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
    }

    /* ── 7. Staging healthy ──────────────────────────────────────── */
    if (prisma) {
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
    }

    /* ── 8. Pelo menos 1 mês agregado ────────────────────────────── */
    if (prisma) {
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
          : "executar `npm run aggregate:vendamensal -- --tenant <slug> --month YYYY-MM --write`",
      });
    }

    /* ── 9. Último daily-pipeline ──────────────────────────────── */
    if (prisma) {
      const lastDaily = await prisma.pipelineRun.findFirst({
        where: { kind: PIPELINE_KIND.DAILY },
        orderBy: { startedAt: "desc" },
      });
      if (!lastDaily) {
        checks.push({
          id: "pipeline:daily_exists",
          label: `daily-pipeline já correu pelo menos 1 vez`,
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
  }

  /* ── Render ────────────────────────────────────────────────────── */
  console.log("Checks:");
  for (const r of checks) renderRow(r);
  console.log("");
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  const oks = checks.filter((c) => c.status === "ok").length;
  console.log("─".repeat(78));
  console.log(`Resumo: ${oks} ✓ · ${warns} ⚠ · ${fails} ✗`);
  if (fails === 0 && warns === 0) {
    console.log("Status: ✓ GO-LIVE READY");
  } else if (fails === 0) {
    console.log("Status: ⚠ GO-LIVE com WARNINGS (avaliar item-a-item antes de ir)");
  } else {
    console.log("Status: ✗ NÃO PRONTO — corrigir falhas e re-correr.");
  }

  if (prisma) await prisma.$disconnect();
  await controlPrisma.$disconnect();
  process.exit(fails);
}

main().catch((err) => {
  console.error(err);
  process.exit(99);
});
