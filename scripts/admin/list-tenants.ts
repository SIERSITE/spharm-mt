/**
 * scripts/admin/list-tenants.ts — lista tenants do control plane.
 * Uso: npx tsx --env-file=.env.local scripts/admin/list-tenants.ts
 */
import { getControlPrismaCli } from "@/lib/sync/control-client-cli";

async function main() {
  const cp = getControlPrismaCli();
  const tenants = await cp.tenant.findMany({
    select: {
      id: true,
      slug: true,
      nome: true,
      estado: true,
      dbHost: true,
      dbName: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: [{ estado: "asc" }, { slug: "asc" }],
  });

  console.log(`\nTOTAL TENANTS: ${tenants.length}\n`);
  for (const t of tenants) {
    console.log(`  ${t.slug.padEnd(25)} estado=${t.estado.padEnd(14)} dbName=${t.dbName}`);
    console.log(`    id=${t.id}  host=${t.dbHost}`);
    console.log(`    created=${t.createdAt.toISOString()}  updated=${t.updatedAt.toISOString()}`);
  }
  console.log();
  await cp.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
