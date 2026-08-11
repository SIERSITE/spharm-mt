/**
 * scripts/admin/backfill-enrich-sample.ts
 * Backfill controlado: enqueue N medicamentos aleatórios e mede taxas.
 * Uso: npx tsx --env-file=.env --env-file=.env.local scripts/admin/backfill-enrich-sample.ts grupo-silveira 100
 */
import { getTenantPrismaOrLegacy } from "@/lib/tenant-registry";
import { runAcquisitionTick } from "@/lib/jobs/regulatory-acquisition";

async function main() {
  const slug = process.argv[2] ?? "grupo-silveira";
  const batch = parseInt(process.argv[3] ?? "100", 10);
  const prisma = await getTenantPrismaOrLegacy(slug);

  console.log(`\n═══ Backfill controlado — tenant=${slug} batch=${batch} ═══\n`);

  // 1. Selecciona N medicamentos aleatórios elegíveis SEM job.
  //    Ordena por RANDOM() para amostra representativa.
  const targets = await prisma.$queryRaw<{ id: string; cnp: number; designacao: string }[]>`
    SELECT p."id", p."cnp", p."designacao"
    FROM "Produto" p
    LEFT JOIN "RegulatoryAcquisitionJob" j ON j."cnp" = p."cnp"
    WHERE p."productType" = 'MEDICAMENTO'
      AND p."estado" != 'INATIVO'
      AND p."validadoManualmente" = false
      AND p."cnp" > 2000000
      AND (p."codigoATC" IS NULL OR p."dci" IS NULL OR p."formaFarmaceutica" IS NULL
           OR p."dosagem" IS NULL OR p."embalagem" IS NULL OR p."imagemUrl" IS NULL)
      AND j."id" IS NULL
    ORDER BY RANDOM()
    LIMIT ${batch}
  `;
  console.log(`Candidatos escolhidos: ${targets.length}`);
  if (targets.length === 0) return;

  // 2. Enqueue todos (batch insert)
  const enqStart = Date.now();
  let created = 0;
  for (const t of targets) {
    try {
      await prisma.regulatoryAcquisitionJob.create({
        data: { cnp: t.cnp, designacao: t.designacao, priority: 30, status: "PENDING" },
      });
      created++;
    } catch {
      // race
    }
  }
  console.log(`Jobs criados: ${created} em ${((Date.now() - enqStart) / 1000).toFixed(1)}s`);

  // 3. Corre acquire ticks até esvaziar (com deadline)
  console.log(`\nA correr acquire… (rate limit INFOMED = 1.5s/CNP, esperado ~${(batch * 2)}s)\n`);
  const t0 = Date.now();
  const summary = await runAcquisitionTick({
    prisma,
    maxJobs: batch,
    maxDurationMs: batch * 5 * 1000, // 5s por job de folga
  });
  const durTotal = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n── Resultado ─────────────────────────────────────────────`);
  console.log(`  Duração:        ${durTotal}s`);
  console.log(`  Processed:      ${summary.processed}`);
  console.log(`  Done:           ${summary.outcomes.done}`);
  console.log(`  Partial:        ${summary.outcomes.partial}`);
  console.log(`  Retry:          ${summary.outcomes.retry}`);
  console.log(`  Failed:         ${summary.outcomes.failed}`);
  console.log(`  Blocked:        ${summary.outcomes.blocked}`);
  console.log(`  No-op updates:  ${summary.outcomes.noOpUpdates}`);
  console.log(`  Snapshot hits:  ${summary.bySource.snapshotHits}`);
  console.log(`  HTTP hits:      ${summary.bySource.httpHits}`);
  console.log(`  HTTP misses:    ${summary.bySource.httpMisses}`);
  console.log(`  HTTP errors:    ${summary.bySource.httpErrors}`);
  console.log(`  Produto fields filled: ${summary.produtoUpdates.fieldsFilled}`);
  console.log(`  Imagens filled: ${summary.produtoUpdates.imagemUrlFilled}`);
  console.log(`  RR upserts:     ${summary.regulatoryRecordUpserts}`);
  console.log(`  Stopped:        ${summary.stoppedReason}`);

  const done = summary.outcomes.done;
  const partial = summary.outcomes.partial;
  const failed = summary.outcomes.failed;
  const processed = summary.processed;
  console.log(`\n  Taxa match total:  ${processed ? (((done + partial) / processed) * 100).toFixed(1) : "0.0"}%`);
  console.log(`  Taxa DONE:         ${processed ? ((done / processed) * 100).toFixed(1) : "0.0"}%`);
  console.log(`  Taxa FAILED:       ${processed ? ((failed / processed) * 100).toFixed(1) : "0.0"}%`);
  console.log(`  Média por job:     ${processed ? (parseFloat(durTotal) / processed).toFixed(2) : "0.00"}s\n`);

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
