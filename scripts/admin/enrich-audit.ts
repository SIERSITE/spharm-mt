/**
 * scripts/admin/enrich-audit.ts
 * Auditoria do estado real do pipeline de enriquecimento em produção.
 * Uso: npx tsx --env-file=.env.local scripts/admin/enrich-audit.ts
 */
import { getPrisma } from "@/lib/prisma";

async function main() {
  const prisma = await getPrisma();
  const now = new Date();
  const d7  = new Date(now.getTime() -  7 * 24 * 60 * 60 * 1000);
  const d30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // ── 1. RegulatoryAcquisitionJob counts ──────────────────────────────
  const jobCounts = await prisma.regulatoryAcquisitionJob.groupBy({ by: ["status"], _count: true });

  const lastByStatus = await Promise.all(
    ["DONE","PARTIAL","BLOCKED","FAILED","PENDING"].map(async (s) => {
      const row = await prisma.regulatoryAcquisitionJob.findFirst({
        where: { status: s as never },
        orderBy: { updatedAt: "desc" },
        select: { updatedAt: true },
      });
      return { status: s, updatedAt: row?.updatedAt ?? null };
    })
  );

  // ── 2. EnrichmentSourceLog ───────────────────────────────────────────
  const logsAll  = await prisma.enrichmentSourceLog.count();
  const logs7d   = await prisma.enrichmentSourceLog.count({ where: { createdAt: { gte: d7  } } });
  const logs30d  = await prisma.enrichmentSourceLog.count({ where: { createdAt: { gte: d30 } } });
  const lastLog  = await prisma.enrichmentSourceLog.findFirst({
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, source: true, status: true },
  });
  // Por fonte nos últimos 30d
  const logsBySource30d = await prisma.enrichmentSourceLog.groupBy({
    by: ["source","status"],
    where: { createdAt: { gte: d30 } },
    _count: true,
  });

  // ── 3. Produto.lastVerifiedAt ────────────────────────────────────────
  const lastVerified = await prisma.produto.findFirst({
    where:  { lastVerifiedAt: { not: null } },
    orderBy: { lastVerifiedAt: "desc" },
    select: { lastVerifiedAt: true },
  });
  const verified7d  = await prisma.produto.count({ where: { lastVerifiedAt: { gte: d7  } } });
  const verified30d = await prisma.produto.count({ where: { lastVerifiedAt: { gte: d30 } } });

  // ── 4. FilaRevisao ───────────────────────────────────────────────────
  const filaGroups = await prisma.filaRevisao.groupBy({ by: ["estado","tipoRevisao"], _count: true });
  const filaAll    = await prisma.filaRevisao.count();
  const lastFila   = await prisma.filaRevisao.findFirst({
    orderBy: { dataCriacao: "desc" },
    select: { dataCriacao: true, tipoRevisao: true, estado: true },
  });

  // ── 5. Medicamentos sem campos ───────────────────────────────────────
  const med = { productType: "MEDICAMENTO" as const, estado: { not: "INATIVO" as const } };
  const [total, semATC, semDCI, semForma, semDosagem, semEmbalagem, semImagem, comTudo] = await Promise.all([
    prisma.produto.count({ where: med }),
    prisma.produto.count({ where: { ...med, codigoATC: null } }),
    prisma.produto.count({ where: { ...med, dci: null } }),
    prisma.produto.count({ where: { ...med, formaFarmaceutica: null } }),
    prisma.produto.count({ where: { ...med, dosagem: null } }),
    prisma.produto.count({ where: { ...med, embalagem: null } }),
    prisma.produto.count({ where: { ...med, imagemUrl: null } }),
    prisma.produto.count({ where: { ...med, codigoATC: { not: null }, dci: { not: null }, formaFarmaceutica: { not: null }, dosagem: { not: null }, embalagem: { not: null } } }),
  ]);

  // ── Imprimir ─────────────────────────────────────────────────────────
  const line = "─".repeat(60);
  console.log(`\n${"═".repeat(60)}`);
  console.log("  ENRIQUECIMENTO — AUDITORIA PRODUÇÃO");
  console.log(`  ${now.toISOString()}`);
  console.log("═".repeat(60));

  console.log(`\n${line}`);
  console.log("1. REGULATORY ACQUISITION JOBS");
  console.log(line);
  const statusOrder = ["DONE","PARTIAL","PENDING","FAILED","BLOCKED","IN_PROGRESS"];
  const countMap = Object.fromEntries(jobCounts.map(j => [j.status, (j._count as number)]));
  for (const s of statusOrder) {
    console.log(`  ${s.padEnd(14)} ${String(countMap[s] ?? 0).padStart(6)}`);
  }
  console.log(`  ${"TOTAL".padEnd(14)} ${String(Object.values(countMap).reduce((a,b)=>a+b,0)).padStart(6)}`);

  console.log(`\n${line}`);
  console.log("2. ÚLTIMA ACTIVIDADE DO WORKER (acquire-regulatory)");
  console.log(line);
  for (const { status, updatedAt } of lastByStatus) {
    const ts = updatedAt ? updatedAt.toISOString() : "NUNCA";
    console.log(`  ${status.padEnd(14)} ${ts}`);
  }

  console.log(`\n${line}`);
  console.log("3. ENRICHMENT SOURCE LOG");
  console.log(line);
  console.log(`  Total (all time):  ${logsAll}`);
  console.log(`  Últimos 30d:       ${logs30d}`);
  console.log(`  Últimos 7d:        ${logs7d}`);
  console.log(`  Último registo:    ${lastLog?.createdAt?.toISOString() ?? "NUNCA"} (${lastLog?.source} / ${lastLog?.status})`);
  console.log("\n  Por fonte (últimos 30d):");
  for (const g of logsBySource30d.sort((a,b)=>String(a.source).localeCompare(String(b.source)))) {
    console.log(`    ${String(g.source).padEnd(24)} ${String(g.status).padEnd(12)} ${(g._count as number)}`);
  }

  console.log(`\n${line}`);
  console.log("4. PRODUTO lastVerifiedAt (enrich-catalog)");
  console.log(line);
  console.log(`  Mais recente:      ${lastVerified?.lastVerifiedAt?.toISOString() ?? "NUNCA"}`);
  console.log(`  Actualizados 7d:   ${verified7d}`);
  console.log(`  Actualizados 30d:  ${verified30d}`);

  console.log(`\n${line}`);
  console.log("5. FILA REVISÃO (Needs Review)");
  console.log(line);
  console.log(`  Total:             ${filaAll}`);
  console.log(`  Último item:       ${lastFila?.dataCriacao?.toISOString() ?? "NUNCA"} (${lastFila?.tipoRevisao} / ${lastFila?.estado})`);
  for (const g of filaGroups) {
    console.log(`  ${String(g.estado).padEnd(12)} ${String(g.tipoRevisao).padEnd(30)} ${(g._count as number)}`);
  }

  console.log(`\n${line}`);
  console.log("6. MEDICAMENTOS VIVOS — CAMPOS EM FALTA");
  console.log(line);
  const pct = (n: number) => `${(n/total*100).toFixed(1)}%`.padStart(6);
  console.log(`  Total MEDICAMENTOs vivos:  ${total}`);
  console.log(`  Com todos os 5 campos:     ${comTudo} (${(comTudo/total*100).toFixed(1)}%)`);
  console.log(`  Sem ATC:          ${String(semATC).padStart(5)} ${pct(semATC)}`);
  console.log(`  Sem DCI:          ${String(semDCI).padStart(5)} ${pct(semDCI)}`);
  console.log(`  Sem forma farm.:  ${String(semForma).padStart(5)} ${pct(semForma)}`);
  console.log(`  Sem dosagem:      ${String(semDosagem).padStart(5)} ${pct(semDosagem)}`);
  console.log(`  Sem embalagem:    ${String(semEmbalagem).padStart(5)} ${pct(semEmbalagem)}`);
  console.log(`  Sem imagem:       ${String(semImagem).padStart(5)} ${pct(semImagem)}`);

  console.log(`\n${"═".repeat(60)}\n`);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
