import { getControlPrismaCli } from "@/lib/sync/control-client-cli";
async function main() {
  const cp = getControlPrismaCli();
  const rows = await cp.$queryRaw<
    Array<{ migration_name: string; started_at: Date; finished_at: Date | null; logs: string | null }>
  >`
    SELECT migration_name, started_at, finished_at, logs
    FROM _prisma_migrations
    WHERE migration_name LIKE '%heartbeat%' OR migration_name LIKE '%sync_run%'
    ORDER BY started_at DESC
  `;
  for (const r of rows) {
    console.log(`  ${r.migration_name}`);
    console.log(`    started=${r.started_at.toISOString()}  finished=${r.finished_at?.toISOString() ?? "PENDING"}`);
  }
  await cp.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
