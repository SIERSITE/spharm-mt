/**
 * scripts/admin/inspect-demo-neon-context.ts
 *
 * Recolhe o contexto operacional necessário para correr um dry-run real
 * contra demo-neon: farmácia(s), staging compras existentes (intervalos
 * com data, contagens), e samples para escolher uma janela mínima.
 */
import "dotenv/config";
import {
  controlPrisma,
  getTenantBySlug,
  buildTenantConnectionString,
} from "@/lib/control-plane";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

async function main() {
  const tenant = await getTenantBySlug("demo-neon");
  if (!tenant) throw new Error("tenant demo-neon not found");

  const tp = new PrismaClient({
    adapter: new PrismaPg({ connectionString: buildTenantConnectionString(tenant) }),
  });

  const farmacias = await tp.farmacia.findMany({
    where: { estado: "ATIVO" },
    select: { id: true, nome: true },
    orderBy: { nome: "asc" },
  });
  console.log("ATIVO farmácias:");
  for (const f of farmacias) console.log(`  ${f.id}  ${f.nome}`);

  const stagingTotal = await tp.stagingCompraRawLine.count();
  console.log(`staging compras total rows: ${stagingTotal}`);

  if (stagingTotal === 0) {
    console.log("(sem staging — não há nada para agregar)");
    await tp.$disconnect();
    await controlPrisma.$disconnect();
    return;
  }

  for (const f of farmacias) {
    const byFarmacia = await tp.stagingCompraRawLine.count({ where: { farmaciaId: f.id } });
    if (byFarmacia === 0) continue;
    const minMax = await tp.$queryRaw<Array<{ minD: Date; maxD: Date; distinctDays: bigint }>>`
      SELECT MIN("dataRecepcao") AS "minD",
             MAX("dataRecepcao") AS "maxD",
             COUNT(DISTINCT DATE("dataRecepcao"))::bigint AS "distinctDays"
      FROM "StagingCompraRawLine"
      WHERE "farmaciaId" = ${f.id}
    `;
    const m = minMax[0];
    console.log(`farmacia=${f.nome} rows=${byFarmacia} window=[${m.minD?.toISOString()} → ${m.maxD?.toISOString()}] dias=${m.distinctDays}`);

    // top 5 dias com mais linhas — para escolher janela
    const topDays = await tp.$queryRaw<Array<{ d: Date; n: bigint }>>`
      SELECT DATE("dataRecepcao") AS d, COUNT(*)::bigint AS n
      FROM "StagingCompraRawLine"
      WHERE "farmaciaId" = ${f.id}
      GROUP BY DATE("dataRecepcao")
      ORDER BY n DESC
      LIMIT 5
    `;
    console.log("  top 5 dias por linhas:");
    for (const d of topDays) console.log(`    ${d.d.toISOString().slice(0, 10)}  rows=${d.n}`);
  }

  await tp.$disconnect();
  await controlPrisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
