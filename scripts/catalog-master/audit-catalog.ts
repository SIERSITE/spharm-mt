/**
 * scripts/catalog-master/audit-catalog.ts
 *
 * Auditoria READ-ONLY do catálogo de uma base. Serve três momentos:
 *   1. ANTES do export — escolher qual base tem o melhor catálogo.
 *   2. DEPOIS do import — provar que o bootstrap correu bem.
 *   3. Em rotina — vigiar cobertura e integridade referencial.
 *
 * Nunca escreve. Base SEMPRE explícita:
 *   --tenant <slug>      resolve pelo control plane
 *   --url-env <ENV>      lê a connection string dessa env
 *
 * Uso:
 *   npm run catalog:audit -- --tenant grupo-silveira
 *   npm run catalog:audit -- --url-env DATABASE_URL --json
 *   npm run catalog:audit -- --tenant silveira --expect exports/catalogo-mestre
 *
 * Com `--expect <dir>` compara as contagens do destino com o manifest do
 * bundle e devolve exit code 1 se faltar alguma coisa — é o gate de
 * validação pós-import para usar em runbooks e CI.
 */

import { parseArgs } from "node:util";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  CatalogToolError,
  WEAK_NIVEL1,
  closeControl,
  fmt,
  openClient,
  readManifest,
  resolveDatabase,
} from "./_shared";

type Coverage = {
  produtos: number;
  comATC: number;
  comDCI: number;
  comForma: number;
  comDosagem: number;
  comEmbalagem: number;
  comFormaDoseEmbalagemCompleto: number;
  comImagem: number;
  comFabricante: number;
  comNivel1: number;
  comNivel2: number;
  nivel1Fraco: number;
  validadosManualmente: number;
  needsManualReview: number;
  verificados: number;
};

type Orphans = {
  produtoFabricanteOrfao: number;
  produtoNivel1Orfao: number;
  produtoNivel2Orfao: number;
  classificacaoPaiOrfao: number;
  nivel2SemNivel1: number;
  aliasSemFabricante: number;
  regulatoryRecordSemProduto: number;
  produtoMedicamentoSemRegulatory: number;
};

type Report = {
  base: string;
  geradoEm: string;
  totais: {
    produtos: number;
    fabricantes: number;
    fabricanteAliases: number;
    classificacoes: number;
    classificacoesNivel1: number;
    classificacoesNivel2: number;
    regulatoryRecords: number;
    infarmedSnapshots: number;
    verificacaoHistorico: number;
  };
  cobertura: Coverage;
  orfaos: Orphans;
};

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      tenant: { type: "string" },
      "url-env": { type: "string" },
      "allow-test-tenant": { type: "boolean", default: false },
      expect: { type: "string" },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });

  const db = await resolveDatabase({
    tenant: values.tenant,
    urlEnv: values["url-env"],
    role: "origem",
    allowBlockedTenant: values["allow-test-tenant"] ?? false,
  });
  const prisma = openClient(db.url);

  try {
    const report = await buildReport(prisma, db.label);

    if (values.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printReport(report);
    }

    let failed = false;

    if (values.expect) {
      const manifest = readManifest(values.expect);
      console.log("\n  Comparação com o manifest do bundle:");
      const checks: Array<[string, number, number]> = [
        ["produtos", report.cobertura.produtos, manifest.coverage.produtos],
        ["com ATC", report.cobertura.comATC, manifest.coverage.comATC],
        ["com DCI", report.cobertura.comDCI, manifest.coverage.comDCI],
        ["com imagem", report.cobertura.comImagem, manifest.coverage.comImagem],
        ["com fabricante", report.cobertura.comFabricante, manifest.coverage.comFabricante],
        ["com N2", report.cobertura.comNivel2, manifest.coverage.comNivel2],
        ["validados à mão", report.cobertura.validadosManualmente, manifest.coverage.validadosManualmente],
      ];
      for (const [label, actual, expected] of checks) {
        const ok = actual >= expected;
        if (!ok) failed = true;
        console.log(
          `    ${ok ? "✓" : "✗"} ${label.padEnd(20)} destino ${fmt(actual).padStart(8)}  bundle ${fmt(expected).padStart(8)}`,
        );
      }
      if (failed) {
        console.log("\n  ✗ O destino tem menos cobertura do que o bundle — o import não ficou completo.");
      }
    }

    const totalOrfaos = Object.values(report.orfaos).reduce((a, b) => a + b, 0);
    // `produtoMedicamentoSemRegulatory` é informativo, não é defeito.
    const defeitos = totalOrfaos - report.orfaos.produtoMedicamentoSemRegulatory;
    if (defeitos > 0) failed = true;

    if (failed) process.exit(1);
  } finally {
    await prisma.$disconnect().catch(() => {});
    await closeControl();
  }
}

async function buildReport(prisma: PrismaClient, label: string): Promise<Report> {
  const [
    produtos,
    fabricantes,
    aliases,
    classificacoes,
    n1,
    n2,
    regulatory,
    snapshots,
    historico,
  ] = await Promise.all([
    prisma.produto.count(),
    prisma.fabricante.count(),
    prisma.fabricanteAlias.count(),
    prisma.classificacao.count(),
    prisma.classificacao.count({ where: { tipo: "NIVEL_1" } }),
    prisma.classificacao.count({ where: { tipo: "NIVEL_2" } }),
    prisma.regulatoryRecord.count(),
    prisma.infarmedSnapshot.count(),
    prisma.produtoVerificacaoHistorico.count(),
  ]);

  const cobertura = await buildCoverage(prisma, produtos);
  const orfaos = await buildOrphans(prisma);

  return {
    base: label,
    geradoEm: new Date().toISOString(),
    totais: {
      produtos,
      fabricantes,
      fabricanteAliases: aliases,
      classificacoes,
      classificacoesNivel1: n1,
      classificacoesNivel2: n2,
      regulatoryRecords: regulatory,
      infarmedSnapshots: snapshots,
      verificacaoHistorico: historico,
    },
    cobertura,
    orfaos,
  };
}

async function buildCoverage(prisma: PrismaClient, produtos: number): Promise<Coverage> {
  const notNull = (field: string) => prisma.produto.count({ where: { [field]: { not: null } } as never });

  const [
    comATC,
    comDCI,
    comForma,
    comDosagem,
    comEmbalagem,
    comImagem,
    comFabricante,
    comNivel1,
    comNivel2,
    validados,
    revisao,
    verificados,
    completo,
  ] = await Promise.all([
    notNull("codigoATC"),
    notNull("dci"),
    notNull("formaFarmaceutica"),
    notNull("dosagem"),
    notNull("embalagem"),
    notNull("imagemUrl"),
    notNull("fabricanteId"),
    notNull("classificacaoNivel1Id"),
    notNull("classificacaoNivel2Id"),
    prisma.produto.count({ where: { validadoManualmente: true } }),
    prisma.produto.count({ where: { needsManualReview: true } }),
    prisma.produto.count({ where: { verificationStatus: { in: ["VERIFIED", "PARTIALLY_VERIFIED"] } as never } }),
    prisma.produto.count({
      where: {
        formaFarmaceutica: { not: null },
        dosagem: { not: null },
        embalagem: { not: null },
      },
    }),
  ]);

  const fracoRows = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT COUNT(*)::bigint AS n
    FROM "Produto" p
    JOIN "Classificacao" c ON c.id = p."classificacaoNivel1Id"
    WHERE lower(btrim(c.nome)) = ${WEAK_NIVEL1}
  `;

  return {
    produtos,
    comATC,
    comDCI,
    comForma,
    comDosagem,
    comEmbalagem,
    comFormaDoseEmbalagemCompleto: completo,
    comImagem,
    comFabricante,
    comNivel1,
    comNivel2,
    nivel1Fraco: Number(fracoRows[0]?.n ?? 0),
    validadosManualmente: validados,
    needsManualReview: revisao,
    verificados,
  };
}

async function buildOrphans(prisma: PrismaClient): Promise<Orphans> {
  const one = async (sql: Promise<Array<{ n: bigint }>>): Promise<number> => Number((await sql)[0]?.n ?? 0);

  return {
    produtoFabricanteOrfao: await one(prisma.$queryRaw`
      SELECT COUNT(*)::bigint AS n FROM "Produto" p
      LEFT JOIN "Fabricante" f ON f.id = p."fabricanteId"
      WHERE p."fabricanteId" IS NOT NULL AND f.id IS NULL`),
    produtoNivel1Orfao: await one(prisma.$queryRaw`
      SELECT COUNT(*)::bigint AS n FROM "Produto" p
      LEFT JOIN "Classificacao" c ON c.id = p."classificacaoNivel1Id"
      WHERE p."classificacaoNivel1Id" IS NOT NULL AND c.id IS NULL`),
    produtoNivel2Orfao: await one(prisma.$queryRaw`
      SELECT COUNT(*)::bigint AS n FROM "Produto" p
      LEFT JOIN "Classificacao" c ON c.id = p."classificacaoNivel2Id"
      WHERE p."classificacaoNivel2Id" IS NOT NULL AND c.id IS NULL`),
    classificacaoPaiOrfao: await one(prisma.$queryRaw`
      SELECT COUNT(*)::bigint AS n FROM "Classificacao" c
      LEFT JOIN "Classificacao" p ON p.id = c."classificacaoPaiId"
      WHERE c."classificacaoPaiId" IS NOT NULL AND p.id IS NULL`),
    nivel2SemNivel1: await one(prisma.$queryRaw`
      SELECT COUNT(*)::bigint AS n FROM "Produto"
      WHERE "classificacaoNivel2Id" IS NOT NULL AND "classificacaoNivel1Id" IS NULL`),
    aliasSemFabricante: await one(prisma.$queryRaw`
      SELECT COUNT(*)::bigint AS n FROM "FabricanteAlias" a
      LEFT JOIN "Fabricante" f ON f.id = a."fabricanteId"
      WHERE f.id IS NULL`),
    regulatoryRecordSemProduto: await one(prisma.$queryRaw`
      SELECT COUNT(*)::bigint AS n FROM "RegulatoryRecord" r
      LEFT JOIN "Produto" p ON p.cnp = r.cnp
      WHERE p.cnp IS NULL`),
    produtoMedicamentoSemRegulatory: await one(prisma.$queryRaw`
      SELECT COUNT(*)::bigint AS n FROM "Produto" p
      LEFT JOIN "RegulatoryRecord" r ON r.cnp = p.cnp
      WHERE p."productType" = 'MEDICAMENTO' AND r.cnp IS NULL`),
  };
}

function printReport(r: Report): void {
  const pct = (n: number) =>
    r.cobertura.produtos === 0 ? "   —  " : `${((n / r.cobertura.produtos) * 100).toFixed(1).padStart(5)}%`;
  const line = (label: string, n: number) =>
    console.log(`    ${label.padEnd(34)} ${fmt(n).padStart(9)}  ${pct(n)}`);

  console.log("─".repeat(72));
  console.log("catalog:audit — estado do catálogo");
  console.log("─".repeat(72));
  console.log(`  base: ${r.base}`);
  console.log("");
  console.log("  Totais:");
  for (const [k, v] of Object.entries(r.totais)) {
    console.log(`    ${k.padEnd(34)} ${fmt(v).padStart(9)}`);
  }

  console.log("\n  Cobertura (% sobre total de produtos):");
  line("com ATC", r.cobertura.comATC);
  line("com DCI", r.cobertura.comDCI);
  line("com forma farmacêutica", r.cobertura.comForma);
  line("com dosagem", r.cobertura.comDosagem);
  line("com embalagem", r.cobertura.comEmbalagem);
  line("forma+dose+embalagem completos", r.cobertura.comFormaDoseEmbalagemCompleto);
  line("com imagem", r.cobertura.comImagem);
  line("com fabricante", r.cobertura.comFabricante);
  line("com classificação N1", r.cobertura.comNivel1);
  line("  dos quais N1 fraco (Outros)", r.cobertura.nivel1Fraco);
  line("com classificação N2", r.cobertura.comNivel2);
  line("verificados automaticamente", r.cobertura.verificados);
  line("validados manualmente", r.cobertura.validadosManualmente);
  line("marcados p/ revisão manual", r.cobertura.needsManualReview);

  console.log("\n  Integridade referencial:");
  const orfaoLabels: Record<keyof Orphans, string> = {
    produtoFabricanteOrfao: "Produto → Fabricante inexistente",
    produtoNivel1Orfao: "Produto → Classificacao N1 inexistente",
    produtoNivel2Orfao: "Produto → Classificacao N2 inexistente",
    classificacaoPaiOrfao: "Classificacao → pai inexistente",
    nivel2SemNivel1: "Produto com N2 mas sem N1",
    aliasSemFabricante: "FabricanteAlias → Fabricante inexistente",
    regulatoryRecordSemProduto: "RegulatoryRecord sem Produto (informativo)",
    produtoMedicamentoSemRegulatory: "MEDICAMENTO sem RegulatoryRecord (informativo)",
  };
  for (const [key, label] of Object.entries(orfaoLabels) as Array<[keyof Orphans, string]>) {
    const n = r.orfaos[key];
    const informativo = key === "regulatoryRecordSemProduto" || key === "produtoMedicamentoSemRegulatory";
    const mark = n === 0 ? "✓" : informativo ? "·" : "✗";
    console.log(`    ${mark} ${label.padEnd(46)} ${fmt(n).padStart(9)}`);
  }
}

main().catch(async (err) => {
  await closeControl();
  if (err instanceof CatalogToolError) {
    console.error(`\n✗ ${err.message}`);
    process.exit(1);
  }
  console.error("\n✗ Falha inesperada na auditoria:", err);
  process.exit(1);
});
