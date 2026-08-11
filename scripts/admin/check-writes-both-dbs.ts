/**
 * scripts/admin/check-writes-both-dbs.ts
 * Snapshot pós-teste: grupo-silveira vs legacy.
 */
import { getTenantPrismaOrLegacy } from "@/lib/tenant-registry";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

async function snap(label: string, p: any) {
  const [med, jobs, jobsRecent, logs, logsRecent, rr, hist, filaRec] = await Promise.all([
    p.produto.count({ where: { productType: "MEDICAMENTO", estado: { not: "INATIVO" } } }),
    p.regulatoryAcquisitionJob.count(),
    p.regulatoryAcquisitionJob.count({ where: { updatedAt: { gte: new Date(Date.now() - 3600_000) } } }),
    p.enrichmentSourceLog.count(),
    p.enrichmentSourceLog.count({ where: { createdAt: { gte: new Date(Date.now() - 3600_000) } } }),
    p.regulatoryRecord.count(),
    p.produtoVerificacaoHistorico.count({ where: { verificadoEm: { gte: new Date(Date.now() - 3600_000) } } }),
    p.filaRevisao.count({ where: { dataCriacao: { gte: new Date(Date.now() - 3600_000) } } }),
  ]);
  console.log(`\n${label}`);
  console.log(`  Medicamentos vivos:          ${med}`);
  console.log(`  RegulatoryAcquisitionJob:    ${jobs}  (última 1h: ${jobsRecent})`);
  console.log(`  EnrichmentSourceLog:         ${logs} (última 1h: ${logsRecent})`);
  console.log(`  RegulatoryRecord:            ${rr}`);
  console.log(`  ProdutoVerificacaoHist 1h:   ${hist}`);
  console.log(`  FilaRevisao criada 1h:       ${filaRec}`);
}

async function main() {
  const gs = await getTenantPrismaOrLegacy("grupo-silveira");
  await snap("[grupo-silveira]", gs);
  await gs.$disconnect();

  const legacy = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
  await snap("[LEGACY neondb — deve estar inalterado]", legacy);
  await legacy.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
