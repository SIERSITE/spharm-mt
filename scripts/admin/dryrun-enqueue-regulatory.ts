/**
 * scripts/admin/dryrun-enqueue-regulatory.ts
 * Dry-run da query de candidatos do enqueue-regulatory contra a BD dum
 * tenant específico. Reporta os filtros um a um.
 * Uso: npx tsx --env-file=.env --env-file=.env.local scripts/admin/dryrun-enqueue-regulatory.ts grupo-silveira
 */
import { getTenantPrismaOrLegacy } from "@/lib/tenant-registry";

async function main() {
  const slug = process.argv[2] ?? "grupo-silveira";
  const prisma = await getTenantPrismaOrLegacy(slug);

  const med = { productType: "MEDICAMENTO" as const, estado: { not: "INATIVO" as const } };

  const [totalMed, semValMan, comValMan, cnpAcima, cnpAbaixo, semCampo, comTudo,
         jobsDone, jobsBlocked, jobsAbertos] = await Promise.all([
    prisma.produto.count({ where: med }),
    prisma.produto.count({ where: { ...med, validadoManualmente: false } }),
    prisma.produto.count({ where: { ...med, validadoManualmente: true } }),
    prisma.produto.count({ where: { ...med, cnp: { gt: 2_000_000 } } }),
    prisma.produto.count({ where: { ...med, cnp: { lte: 2_000_000 } } }),
    prisma.produto.count({
      where: {
        ...med, validadoManualmente: false, cnp: { gt: 2_000_000 },
        OR: [
          { codigoATC: null }, { dci: null }, { formaFarmaceutica: null },
          { dosagem: null }, { embalagem: null }, { imagemUrl: null },
        ],
      },
    }),
    prisma.produto.count({
      where: {
        ...med, validadoManualmente: false, cnp: { gt: 2_000_000 },
        codigoATC: { not: null }, dci: { not: null }, formaFarmaceutica: { not: null },
        dosagem: { not: null }, embalagem: { not: null },
      },
    }),
    prisma.regulatoryAcquisitionJob.count({ where: { status: "DONE" } }),
    prisma.regulatoryAcquisitionJob.count({ where: { status: "BLOCKED" } }),
    prisma.regulatoryAcquisitionJob.count({
      where: { status: { in: ["PENDING", "IN_PROGRESS", "PARTIAL", "FAILED"] } },
    }),
  ]);

  // Simulação exacta: candidatos ANTES do filtro DONE/BLOCKED
  const raw = await prisma.produto.findMany({
    where: {
      estado: { not: "INATIVO" }, validadoManualmente: false,
      productType: "MEDICAMENTO", cnp: { gt: 2_000_000 },
      OR: [
        { codigoATC: null }, { dci: null }, { formaFarmaceutica: null },
        { dosagem: null }, { embalagem: null }, { imagemUrl: null },
      ],
    },
    select: { cnp: true },
    take: 20_000,
    orderBy: { cnp: "asc" },
  });
  const cnps = raw.map((c) => c.cnp);
  const terminal = await prisma.regulatoryAcquisitionJob.findMany({
    where: { cnp: { in: cnps }, status: { in: ["DONE", "BLOCKED"] } },
    select: { cnp: true },
  });
  const terminalSet = new Set(terminal.map((j) => j.cnp));
  const stillEligible = cnps.filter((c) => !terminalSet.has(c));

  const open = await prisma.regulatoryAcquisitionJob.findMany({
    where: { cnp: { in: stillEligible } },
    select: { cnp: true },
  });
  const openSet = new Set(open.map((j) => j.cnp));
  const wouldCreate = stillEligible.filter((c) => !openSet.has(c));

  console.log(`\n═════ Dry-run enqueue-regulatory para tenant=${slug} ═════`);
  console.log(`Universo base:`);
  console.log(`  MEDICAMENTO + estado!=INATIVO :          ${totalMed}`);
  console.log(`  · com validadoManualmente=true :         ${comValMan}   (EXCLUÍDOS)`);
  console.log(`  · com validadoManualmente=false :        ${semValMan}`);
  console.log(`  · com CNP > 2 000 000 :                  ${cnpAcima}`);
  console.log(`  · com CNP <= 2 000 000 :                 ${cnpAbaixo}  (EXCLUÍDOS)`);
  console.log(`\nCandidatos após filtros base + campo faltante: ${semCampo}`);
  console.log(`Medicamentos já com todos os campos clínicos:   ${comTudo}`);

  console.log(`\nEstado RegulatoryAcquisitionJob:`);
  console.log(`  DONE:    ${jobsDone}`);
  console.log(`  BLOCKED: ${jobsBlocked}`);
  console.log(`  Abertos (PENDING/IN_PROGRESS/PARTIAL/FAILED): ${jobsAbertos}`);

  console.log(`\nSimulação exacta (com filtro DONE/BLOCKED + abertos):`);
  console.log(`  Candidatos raw:                              ${cnps.length}`);
  console.log(`  Excluídos por já ter job DONE/BLOCKED:       ${cnps.length - stillEligible.length}`);
  console.log(`  Elegíveis:                                    ${stillEligible.length}`);
  console.log(`  Já com job aberto (não recria):              ${openSet.size}`);
  console.log(`  >>> SERIAM CRIADOS ${wouldCreate.length} novos jobs (limitados a maxNewJobs=1000)\n`);

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
