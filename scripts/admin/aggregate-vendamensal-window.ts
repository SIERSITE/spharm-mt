/**
 * scripts/admin/aggregate-vendamensal-window.ts
 *
 * Wrapper que corre `aggregateMonth` para cada mês inclusivo numa janela
 * `[from-month, to-month]` num único processo. Idempotente (cada mês faz
 * deleteMany+createMany em transação). Usar depois de reclassify/seed.
 *
 *   # dry-run
 *   npx tsx scripts/admin/aggregate-vendamensal-window.ts \
 *     --tenant grupo-silveira --from-month 2024-01 --to-month 2026-05 --dry-run
 *
 *   # aplica
 *   npx tsx scripts/admin/aggregate-vendamensal-window.ts \
 *     --tenant grupo-silveira --from-month 2024-01 --to-month 2026-05 --write
 *
 * Não toca em dashboard / export-orders / ingest. Só re-emite `VendaMensal`
 * a partir de `IngestVendaLinhaRaw` (com a classificação corrente).
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
import { aggregateMonth, parseMonth, type MonthRange } from "@/lib/aggregate/vendamensal";

async function main() {
  const { values } = parseArgs({
    options: {
      tenant: { type: "string" },
      "from-month": { type: "string" },
      "to-month": { type: "string" },
      "dry-run": { type: "boolean" },
      write: { type: "boolean" },
      "allow-unknowns": { type: "boolean" },
      "allow-orphans": { type: "boolean" },
    },
    strict: true,
  });
  if (!values.tenant || !values["from-month"] || !values["to-month"]) {
    console.error("✗ --tenant --from-month YYYY-MM --to-month YYYY-MM obrigatórios.");
    process.exit(1);
  }
  const write = values.write === true;
  const dryRun = values["dry-run"] === true || !write;
  const allowUnknowns = values["allow-unknowns"] === true;
  const allowOrphans = values["allow-orphans"] === true;

  const tenant = await getTenantBySlug(values.tenant);
  if (!tenant) {
    console.error(`✗ tenant ${values.tenant} não existe.`);
    process.exit(1);
  }
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: buildTenantConnectionString(tenant) }),
  });

  // Enumerar meses inclusivos
  const fromR = parseMonth(values["from-month"]);
  const toR = parseMonth(values["to-month"]);
  if (fromR.fromInclusive > toR.fromInclusive) {
    console.error("✗ --from-month posterior a --to-month.");
    process.exit(1);
  }
  const months: MonthRange[] = [];
  for (let y = fromR.ano, m = fromR.mes; y < toR.ano || (y === toR.ano && m <= toR.mes); ) {
    months.push(parseMonth(`${y}-${String(m).padStart(2, "0")}`));
    m++; if (m > 12) { m = 1; y++; }
  }

  console.log(`─ tenant=${values.tenant}  janela=${values["from-month"]} → ${values["to-month"]}  (${months.length} meses)`);
  console.log(`  modo=${dryRun ? "DRY-RUN" : "WRITE"}  allowUnknowns=${allowUnknowns}  allowOrphans=${allowOrphans}\n`);

  let totDeleted = 0;
  let totCreated = 0;
  let totRaw = 0;
  let failed = 0;

  try {
    for (const r of months) {
      const tag = `${r.ano}-${String(r.mes).padStart(2, "0")}`;
      const t0 = Date.now();
      try {
        const res = await aggregateMonth(prisma, {
          range: r,
          write: !dryRun,
          allowOrphans,
          allowUnknowns,
        });
        const ms = Date.now() - t0;
        const raw = res.preflight.rawLines;
        const unk = res.preflight.unknowns;
        totRaw += raw;
        totDeleted += res.deleted;
        totCreated += res.inserted;
        console.log(`  ${tag}  raw=${String(raw).padEnd(6)} unk=${String(unk).padEnd(4)} deleted=${String(res.deleted).padEnd(5)} inserted=${String(res.inserted).padEnd(5)} (${ms}ms)`);
      } catch (e) {
        failed++;
        console.log(`  ${tag}  ✗ ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    console.log(`\n─ TOTAL  meses=${months.length}  raw=${totRaw}  deleted=${totDeleted}  inserted=${totCreated}  failed=${failed}`);
    if (dryRun) console.log(`\nDRY-RUN — nada escrito. Adiciona --write para aplicar.`);
  } finally {
    await prisma.$disconnect();
    await controlPrisma.$disconnect();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
