/**
 * scripts/admin/enrich-audit-per-tenant.ts
 * Auditoria de enriquecimento POR TENANT (control-plane-aware).
 * Uso: npx tsx --env-file=.env.local scripts/admin/enrich-audit-per-tenant.ts
 */
import { getControlPrismaCli } from "@/lib/sync/control-client-cli";
import { getTenantPrismaOrLegacy } from "@/lib/tenant-registry";

async function auditOne(slug: string, prisma: Awaited<ReturnType<typeof getTenantPrismaOrLegacy>>) {
  const med = { productType: "MEDICAMENTO" as const, estado: { not: "INATIVO" as const } };
  const now = new Date();
  const d7  = new Date(now.getTime() -  7 * 86_400_000);
  const d30 = new Date(now.getTime() - 30 * 86_400_000);

  const [total, semATC, semDCI, semForma, semDosagem, semEmbalagem, semImagem, completos,
         jobCounts, lastLog, logs7d, logs30d, historyUpdated, historyLast, filaTotal] =
    await Promise.all([
      prisma.produto.count({ where: med }),
      prisma.produto.count({ where: { ...med, codigoATC: null } }),
      prisma.produto.count({ where: { ...med, dci: null } }),
      prisma.produto.count({ where: { ...med, formaFarmaceutica: null } }),
      prisma.produto.count({ where: { ...med, dosagem: null } }),
      prisma.produto.count({ where: { ...med, embalagem: null } }),
      prisma.produto.count({ where: { ...med, imagemUrl: null } }),
      prisma.produto.count({
        where: {
          ...med,
          codigoATC: { not: null }, dci: { not: null },
          formaFarmaceutica: { not: null }, dosagem: { not: null }, embalagem: { not: null },
        },
      }),
      prisma.regulatoryAcquisitionJob.groupBy({ by: ["status"], _count: true }),
      prisma.enrichmentSourceLog.findFirst({
        orderBy: { createdAt: "desc" },
        select: { createdAt: true, source: true, status: true },
      }),
      prisma.enrichmentSourceLog.count({ where: { createdAt: { gte: d7 } } }),
      prisma.enrichmentSourceLog.count({ where: { createdAt: { gte: d30 } } }),
      prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count FROM "ProdutoVerificacaoHistorico"
        WHERE array_length("fieldsUpdated", 1) IS NOT NULL
      `,
      prisma.$queryRaw<{ verificadoEm: Date | null }[]>`
        SELECT "verificadoEm" FROM "ProdutoVerificacaoHistorico"
        WHERE array_length("fieldsUpdated", 1) IS NOT NULL
        ORDER BY "verificadoEm" DESC LIMIT 1
      `,
      prisma.filaRevisao.count(),
    ]);

  console.log(`\n${"═".repeat(76)}\n  TENANT: ${slug}\n${"═".repeat(76)}`);
  console.log(`  Medicamentos vivos:       ${total}`);
  console.log(`    Com ATC=${total-semATC}  DCI=${total-semDCI}  Forma=${total-semForma}  Dose=${total-semDosagem}  Emb=${total-semEmbalagem}  Img=${total-semImagem}`);
  console.log(`    Sem ATC=${semATC}  DCI=${semDCI}  Forma=${semForma}  Dose=${semDosagem}  Emb=${semEmbalagem}  Img=${semImagem}`);
  console.log(`    Completos (5 campos): ${completos} (${total ? ((completos/total)*100).toFixed(1) : "0.0"}%)`);

  console.log(`\n  RegulatoryAcquisitionJob:`);
  if (jobCounts.length === 0) console.log(`    (nenhum job na BD)`);
  for (const j of jobCounts) console.log(`    ${j.status.padEnd(14)} ${j._count as number}`);

  console.log(`\n  EnrichmentSourceLog:`);
  console.log(`    Total 7d=${logs7d}  30d=${logs30d}`);
  console.log(`    Último: ${lastLog?.createdAt?.toISOString() ?? "NUNCA"}` +
              (lastLog ? ` (${lastLog.source}/${lastLog.status})` : ""));

  console.log(`\n  ProdutoVerificacaoHistorico c/ fieldsUpdated:`);
  console.log(`    Total: ${historyUpdated[0].count}`);
  console.log(`    Último: ${historyLast[0]?.verificadoEm?.toISOString() ?? "NUNCA"}`);

  console.log(`\n  FilaRevisao: ${filaTotal}\n`);
  return { slug, total, semATC, completos, jobCounts: jobCounts.length };
}

async function main() {
  const cp = getControlPrismaCli();
  const tenants = await cp.tenant.findMany({
    where: { estado: "ACTIVE" },
    select: { slug: true, nome: true },
    orderBy: { slug: "asc" },
  });

  console.log(`\nAuditoria de ${tenants.length} tenant(s) ACTIVE em ${new Date().toISOString()}`);

  for (const t of tenants) {
    try {
      const prisma = await getTenantPrismaOrLegacy(t.slug);
      await auditOne(t.slug, prisma);
    } catch (err) {
      console.log(`\n  ${t.slug}: ERRO — ${err instanceof Error ? err.message : err}`);
    }
  }
  await cp.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
