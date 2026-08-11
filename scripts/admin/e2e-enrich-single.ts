/**
 * scripts/admin/e2e-enrich-single.ts
 * Teste ponta-a-ponta controlado: escolhe 1 medicamento sem ATC/DCI na BD
 * dum tenant, enfileira, corre 1 tick de acquire, e sync — mostra tudo.
 * Uso: npx tsx --env-file=.env --env-file=.env.local scripts/admin/e2e-enrich-single.ts grupo-silveira
 */
import { getTenantPrismaOrLegacy } from "@/lib/tenant-registry";
import { runAcquisitionTick } from "@/lib/jobs/regulatory-acquisition";
import crypto from "node:crypto";

async function main() {
  const slug = process.argv[2] ?? "grupo-silveira";
  const runId = crypto.randomBytes(6).toString("hex");
  console.log(`\n═══ E2E enrichment test — tenant=${slug} runId=${runId} ═══\n`);

  const prisma = await getTenantPrismaOrLegacy(slug);

  // 1. Escolher UM medicamento elegível: MEDICAMENTO, vivo, não validado,
  //    CNP > 2M, sem campos clínicos, sem job DONE/BLOCKED.
  const candidates = await prisma.produto.findMany({
    where: {
      productType: "MEDICAMENTO",
      estado: { not: "INATIVO" },
      validadoManualmente: false,
      cnp: { gt: 2_000_000 },
      codigoATC: null,
      dci: null,
    },
    select: {
      id: true, cnp: true, designacao: true, codigoATC: true, dci: true,
      formaFarmaceutica: true, dosagem: true, embalagem: true, imagemUrl: true,
    },
    take: 5,
    orderBy: { cnp: "asc" },
  });
  if (candidates.length === 0) {
    console.log("Nenhum candidato — abortar.");
    return;
  }

  // Prefere um cujo job ainda não existe
  const cnps = candidates.map((c) => c.cnp);
  const jobs = await prisma.regulatoryAcquisitionJob.findMany({
    where: { cnp: { in: cnps } },
    select: { cnp: true, status: true },
  });
  const jobsBy = new Map(jobs.map((j) => [j.cnp, j.status]));
  const target = candidates.find((c) => !jobsBy.has(c.cnp)) ?? candidates[0];

  console.log("── Escolha ──────────────────────────────────────────────");
  console.log(`  produtoId:   ${target.id}`);
  console.log(`  cnp:         ${target.cnp}`);
  console.log(`  designação:  ${target.designacao}`);
  console.log(`  estado inicial:`);
  console.log(`    codigoATC:         ${target.codigoATC ?? "NULL"}`);
  console.log(`    dci:               ${target.dci ?? "NULL"}`);
  console.log(`    formaFarmaceutica: ${target.formaFarmaceutica ?? "NULL"}`);
  console.log(`    dosagem:           ${target.dosagem ?? "NULL"}`);
  console.log(`    embalagem:         ${target.embalagem ?? "NULL"}`);
  console.log(`    imagemUrl:         ${target.imagemUrl ?? "NULL"}`);
  console.log(`  job existente:       ${jobsBy.get(target.cnp) ?? "NENHUM"}`);

  // 2. ENQUEUE: cria job PENDING se ainda não existir. Não uses o batch
  //    global — este teste é 1 CNP só.
  if (!jobsBy.has(target.cnp)) {
    await prisma.regulatoryAcquisitionJob.create({
      data: {
        cnp: target.cnp,
        designacao: target.designacao,
        priority: 10,
        status: "PENDING",
      },
    });
    console.log(`\n  → Job PENDING criado.`);
  } else {
    // Se estava DONE/BLOCKED, reset para forçar reprocesso.
    await prisma.regulatoryAcquisitionJob.update({
      where: { cnp: target.cnp },
      data: {
        status: "PENDING",
        nextAttemptAt: new Date(),
        attempts: 0,
        lastError: null,
      },
    });
    console.log(`\n  → Job existente reset para PENDING.`);
  }

  // 3. ACQUIRE: 1 tick, 1 job max. Sem skipHttp — quero ver INFOMED real.
  console.log(`\n── Acquire tick ──────────────────────────────────────────`);
  const t0 = Date.now();
  const summary = await runAcquisitionTick({
    prisma,
    maxJobs: 1,
    maxDurationMs: 90_000,
  });
  console.log(`  duração:       ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  processed:     ${summary.processed}`);
  console.log(`  outcomes:      ${JSON.stringify(summary.outcomes)}`);
  console.log(`  bySource:      ${JSON.stringify(summary.bySource)}`);
  console.log(`  produtoUpdates: ${JSON.stringify(summary.produtoUpdates)}`);
  console.log(`  rrUpserts:     ${summary.regulatoryRecordUpserts}`);
  console.log(`  stoppedReason: ${summary.stoppedReason}`);

  // 4. Estado final
  console.log(`\n── Estado final ──────────────────────────────────────────`);
  const finalP = await prisma.produto.findUnique({
    where: { id: target.id },
    select: {
      codigoATC: true, dci: true, formaFarmaceutica: true, dosagem: true,
      embalagem: true, imagemUrl: true,
    },
  });
  console.log(`  Produto:`);
  console.log(`    codigoATC:         ${finalP?.codigoATC ?? "NULL"}`);
  console.log(`    dci:               ${finalP?.dci ?? "NULL"}`);
  console.log(`    formaFarmaceutica: ${finalP?.formaFarmaceutica ?? "NULL"}`);
  console.log(`    dosagem:           ${finalP?.dosagem ?? "NULL"}`);
  console.log(`    embalagem:         ${finalP?.embalagem ?? "NULL"}`);
  console.log(`    imagemUrl:         ${finalP?.imagemUrl ?? "NULL"}`);

  const jobFinal = await prisma.regulatoryAcquisitionJob.findUnique({
    where: { cnp: target.cnp },
    select: { status: true, attempts: true, fieldsObtained: true, lastError: true, completedAt: true },
  });
  console.log(`  Job:  status=${jobFinal?.status}  attempts=${jobFinal?.attempts}  completedAt=${jobFinal?.completedAt?.toISOString() ?? "—"}`);
  console.log(`        fieldsObtained=[${(jobFinal?.fieldsObtained ?? []).join(", ")}]`);
  if (jobFinal?.lastError) console.log(`        lastError=${jobFinal.lastError.slice(0, 200)}`);

  const logs = await prisma.enrichmentSourceLog.findMany({
    where: { produtoId: target.id },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { createdAt: true, source: true, status: true, confidence: true, fieldsReturned: true, errorMessage: true },
  });
  console.log(`\n  EnrichmentSourceLog rows: ${logs.length}`);
  for (const l of logs) {
    console.log(`    ${l.createdAt.toISOString()}  ${l.source.padEnd(20)} ${l.status.padEnd(12)} conf=${l.confidence ?? "-"} fields=[${l.fieldsReturned.join(",")}]`);
    if (l.errorMessage) console.log(`      err=${l.errorMessage.slice(0, 150)}`);
  }

  const history = await prisma.produtoVerificacaoHistorico.findMany({
    where: { produtoId: target.id },
    orderBy: { verificadoEm: "desc" },
    take: 3,
    select: { verificadoEm: true, verificationStatus: true, fieldsUpdated: true },
  });
  console.log(`\n  ProdutoVerificacaoHistorico rows: ${history.length}`);
  for (const h of history) {
    console.log(`    ${h.verificadoEm.toISOString()}  ${h.verificationStatus}  fieldsUpdated=[${h.fieldsUpdated.join(",")}]`);
  }

  const rr = await prisma.regulatoryRecord.findUnique({ where: { cnp: target.cnp } });
  console.log(`\n  RegulatoryRecord:`);
  if (rr) {
    console.log(`    source=${rr.source}  atc=${rr.codigoATC ?? "NULL"}  dci=${rr.dci ?? "NULL"}  forma=${rr.formaFarmaceutica ?? "NULL"}  dose=${rr.dosagem ?? "NULL"}  emb=${rr.embalagem ?? "NULL"}`);
  } else {
    console.log(`    (não criado)`);
  }

  console.log(`\n═══ Fim runId=${runId} ═══\n`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
