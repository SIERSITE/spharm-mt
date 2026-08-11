/**
 * scripts/admin/check-syncrun-recent.ts — SyncRun mais recentes do control plane.
 */
import { getControlPrismaCli } from "@/lib/sync/control-client-cli";
async function main() {
  const cp = getControlPrismaCli();
  const rows = await cp.syncRun.findMany({
    where: {
      source: { in: ["enqueue-regulatory", "acquire-regulatory", "enrich-catalog", "enrich-retail"] },
      startedAt: { gte: new Date(Date.now() - 2 * 3600_000) },
    },
    orderBy: { startedAt: "desc" },
    take: 20,
    select: {
      id: true, tenantSlug: true, source: true, status: true,
      startedAt: true, finishedAt: true, durationMs: true, lastHeartbeatAt: true,
      recordsRead: true, recordsInserted: true, recordsUpdated: true, recordsFailed: true,
      triggerType: true, workerId: true, errorSummary: true,
    },
  });
  console.log(`\nSyncRun últimas 2h: ${rows.length}\n`);
  for (const r of rows) {
    console.log(`  ${r.startedAt.toISOString()}  ${r.tenantSlug.padEnd(15)} ${r.source.padEnd(20)} ${r.status.padEnd(10)} dur=${r.durationMs ?? "-"}ms trigger=${r.triggerType} worker=${r.workerId ?? "-"}`);
    console.log(`     read=${r.recordsRead} ins=${r.recordsInserted} upd=${r.recordsUpdated} fail=${r.recordsFailed}  heartbeat=${r.lastHeartbeatAt?.toISOString() ?? "-"}`);
    if (r.errorSummary) console.log(`     ERR: ${r.errorSummary.slice(0, 200)}`);
  }
  await cp.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
