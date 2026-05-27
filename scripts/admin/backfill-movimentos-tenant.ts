/**
 * scripts/admin/backfill-movimentos-tenant.ts
 *
 * Block C1 — coordenador server-side do backfill `MovimentoArtigo`.
 *
 * O backfill propriamente dito (SELECT dbo.StocksMov → POST /api/ingest/v1/movimentos)
 * É CORRIDO PELO AGENT no Windows da farmácia. Este script complementa:
 *
 *   --status            : conta MovimentoArtigo por farmácia + min/max DataMov + DESCONHECIDO%
 *                         (validação rápida antes/depois do upload)
 *   --enable <farmacia> : SET useMovimentosCanonical=true (atómico, rollback = flag false)
 *   --disable <farmacia>: SET useMovimentosCanonical=false (rollback)
 *   --enable-all        : flag=true em TODAS as farmácias activas (apenas se reconcile passou)
 *
 * Não toca dados existentes. Não corre uploads (esses ficam no operador
 * com `run-stocksmov-upload.bat`). Não toca dashboard.
 *
 * Uso:
 *   npx tsx scripts/admin/backfill-movimentos-tenant.ts --tenant grupo-silveira --status
 *   npx tsx scripts/admin/backfill-movimentos-tenant.ts --tenant grupo-silveira --enable "Farmácia Silveirense"
 *   npx tsx scripts/admin/backfill-movimentos-tenant.ts --tenant grupo-silveira --enable-all
 */
import "dotenv/config";
import { parseArgs } from "node:util";
import {
  controlPrisma,
  getTenantBySlug,
  buildTenantConnectionString,
} from "@/lib/control-plane";
import { PrismaClient, Prisma } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

type StatusRow = {
  farmaciaId: string;
  nome: string;
  rows: number;
  dataMin: Date | null;
  dataMax: Date | null;
  desconhecidos: number;
  orphanProducts: number;
  desconhecidoPct: number;
  flagAtiva: boolean;
};

async function getStatus(prisma: PrismaClient): Promise<StatusRow[]> {
  const farmacias = await prisma.farmacia.findMany({
    where: { estado: "ATIVO", nome: { not: "Farmácia Teste" } },
    select: { id: true, nome: true, useMovimentosCanonical: true },
    orderBy: { nome: "asc" },
  });
  const out: StatusRow[] = [];
  for (const f of farmacias) {
    const stats = await prisma.$queryRaw<
      Array<{ n: bigint; min: Date | null; max: Date | null; desc: bigint; orph: bigint }>
    >(Prisma.sql`
      SELECT
        COUNT(*)::bigint                                                                    AS n,
        MIN("dataMovimento")                                                                AS min,
        MAX("dataMovimento")                                                                AS max,
        COUNT(*) FILTER (WHERE "tipo" = 'DESCONHECIDO')::bigint                             AS desc,
        COUNT(*) FILTER (WHERE "produtoId" IS NULL)::bigint                                 AS orph
      FROM "MovimentoArtigo"
      WHERE "farmaciaId" = ${f.id}
    `);
    const rows = Number(stats[0].n);
    const desc = Number(stats[0].desc);
    out.push({
      farmaciaId: f.id,
      nome: f.nome,
      rows,
      dataMin: stats[0].min,
      dataMax: stats[0].max,
      desconhecidos: desc,
      orphanProducts: Number(stats[0].orph),
      desconhecidoPct: rows > 0 ? (desc / rows) * 100 : 0,
      flagAtiva: f.useMovimentosCanonical,
    });
  }
  return out;
}

function fmtDay(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : "—";
}

async function setFlag(
  prisma: PrismaClient,
  farmaciaName: string | null,
  enabled: boolean,
): Promise<number> {
  const where = farmaciaName
    ? { nome: farmaciaName, estado: "ATIVO" as const }
    : { estado: "ATIVO" as const, nome: { not: "Farmácia Teste" } };
  const r = await prisma.farmacia.updateMany({
    where,
    data: { useMovimentosCanonical: enabled },
  });
  return r.count;
}

async function main() {
  const { values } = parseArgs({
    options: {
      tenant: { type: "string" },
      status: { type: "boolean" },
      enable: { type: "string" },
      disable: { type: "string" },
      "enable-all": { type: "boolean" },
      "disable-all": { type: "boolean" },
    },
    strict: true,
  });
  if (!values.tenant) {
    console.error("✗ --tenant <slug> obrigatório.");
    process.exit(1);
  }
  const actions = [
    values.status,
    !!values.enable,
    !!values.disable,
    values["enable-all"],
    values["disable-all"],
  ].filter(Boolean).length;
  if (actions !== 1) {
    console.error(
      "✗ Escolher exactamente uma acção: --status | --enable <farmacia> | --disable <farmacia> | --enable-all | --disable-all",
    );
    process.exit(1);
  }

  const tenant = await getTenantBySlug(values.tenant);
  if (!tenant) {
    console.error(`✗ Tenant "${values.tenant}" não existe.`);
    process.exit(1);
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: buildTenantConnectionString(tenant) }),
  });

  try {
    if (values.status) {
      const rows = await getStatus(prisma);
      console.log(`# MovimentoArtigo — status tenant \`${values.tenant}\``);
      console.log();
      console.log(`| Farmácia | Flag | Rows | DataMin | DataMax | DESC | DESC% | Orphan prod |`);
      console.log(`|---|---|---:|---|---|---:|---:|---:|`);
      for (const r of rows) {
        const flag = r.flagAtiva ? "✅" : "—";
        const descFlag = r.desconhecidoPct >= 1 ? " ⚠" : "";
        console.log(
          `| ${r.nome} | ${flag} | ${r.rows.toLocaleString()} | ${fmtDay(r.dataMin)} | ${fmtDay(r.dataMax)} | ${r.desconhecidos} | ${r.desconhecidoPct.toFixed(2)}%${descFlag} | ${r.orphanProducts} |`,
        );
      }
      console.log();
      const totalRows = rows.reduce((s, r) => s + r.rows, 0);
      const totalDesc = rows.reduce((s, r) => s + r.desconhecidos, 0);
      const overallPct = totalRows > 0 ? (totalDesc / totalRows) * 100 : 0;
      console.log(`**Tenant**: ${totalRows.toLocaleString()} rows | ${totalDesc} DESC | ${overallPct.toFixed(2)}% global`);
      process.exit(0);
    }

    if (values.enable || values.disable) {
      const name = values.enable ?? values.disable!;
      const enabled = !!values.enable;
      const count = await setFlag(prisma, name, enabled);
      if (count === 0) {
        console.error(`✗ Nenhuma farmácia "${name}" activa encontrada.`);
        process.exit(1);
      }
      console.log(`✓ ${enabled ? "ENABLED" : "DISABLED"} useMovimentosCanonical em ${count} farmácia(s) "${name}".`);
      process.exit(0);
    }

    if (values["enable-all"] || values["disable-all"]) {
      const enabled = !!values["enable-all"];
      const count = await setFlag(prisma, null, enabled);
      console.log(
        `✓ ${enabled ? "ENABLED" : "DISABLED"} useMovimentosCanonical em ${count} farmácia(s) activas do tenant ${values.tenant}.`,
      );
      process.exit(0);
    }
  } finally {
    await prisma.$disconnect();
    await controlPrisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
