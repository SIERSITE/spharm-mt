/**
 * scripts/coverage-report-infomed-details.ts
 *
 * Relatório de cobertura cross-match entre os details INFOMED Fase 2 e o
 * estado actual da BD Produto. READ-ONLY — não escreve nada.
 *
 * Output: secções 2, 3, 4 do report INFOMED:
 *   - CNPs encontrados no ERP
 *   - Produtos vivos cobertos
 *   - MEDICAMENTO cobertos
 *   - MEDICAMENTO em Outros Medicamentos cobertos
 *   - Quantos teriam ATC/DCI novo
 *   - Top ATC prefixes
 *   - Possíveis rule gaps
 *   - 30 exemplos
 */

import "dotenv/config";
import * as fs from "fs";
import { legacyPrisma as prisma } from "../lib/prisma";

const DETAILS_FILE = "scripts/data/infomed-listagem-details.json";
const KNOWN_GAPS = new Set([
  "J04", "J06", "J07", "A11", "A12", "A16", "B02", "B03", "L01",
  "P01", "P03", "V03", "V04", "V06", "V07", "V08", "V09", "V10",
  "M05", "N01", "P02",
]);
// Os mapeados após a expansão de taxonomia (J01/J02/J05/H02/H03/P02/N01BB)
// continuam mappable — não consideramos gaps.

async function main() {
  console.log("─".repeat(74));
  console.log("Coverage report — INFOMED listagem-details vs Produto");
  console.log("─".repeat(74));

  const details = JSON.parse(fs.readFileSync(DETAILS_FILE, "utf-8")) as {
    stats: Record<string, number>;
    details: Record<string, {
      medId: number;
      designacaoOficial: string | null;
      dci: string | null;
      codigoATC: string | null;
      formaFarmaceutica: string | null;
      dosagem: string | null;
      titularAim: string | null;
      embalagens: Array<{ cnp: number; descricao: string | null }>;
    }>;
  };

  const records = Object.values(details.details);
  console.log(`\n[1] Details file: ${records.length} MED_IDs com detalhe`);

  // Construir lookup CNP → detail
  type CnpDetail = {
    medId: number;
    designacao: string;
    dci: string | null;
    codigoATC: string | null;
    forma: string | null;
    dosagem: string | null;
    titular: string | null;
    embalagemDescricao: string | null;
  };
  const cnpToDetail = new Map<number, CnpDetail>();
  for (const r of records) {
    for (const e of r.embalagens) {
      if (!Number.isFinite(e.cnp) || e.cnp <= 0) continue;
      // 1st-wins se duplicado (raro)
      if (!cnpToDetail.has(e.cnp)) {
        cnpToDetail.set(e.cnp, {
          medId: r.medId,
          designacao: r.designacaoOficial ?? "",
          dci: r.dci,
          codigoATC: r.codigoATC,
          forma: r.formaFarmaceutica,
          dosagem: r.dosagem,
          titular: r.titularAim,
          embalagemDescricao: e.descricao,
        });
      }
    }
  }
  console.log(`    CNPs únicos no detail set: ${cnpToDetail.size}`);

  // Cross-match com Produto
  const allCnps = [...cnpToDetail.keys()];
  console.log(`\n[2] Cross-match com Produto...`);

  // Chunk de 10000
  const chunkSize = 10_000;
  const matchedProduto: Array<{
    cnp: number;
    designacao: string;
    productType: string | null;
    classN2: string | null;
    estado: string;
    validadoManualmente: boolean;
    codigoATC: string | null;
    dci: string | null;
  }> = [];
  for (let i = 0; i < allCnps.length; i += chunkSize) {
    const slice = allCnps.slice(i, i + chunkSize);
    const found = await prisma.produto.findMany({
      where: { cnp: { in: slice } },
      select: {
        cnp: true,
        designacao: true,
        productType: true,
        estado: true,
        validadoManualmente: true,
        codigoATC: true,
        dci: true,
        classificacaoNivel2: { select: { nome: true } },
      },
    });
    for (const p of found) {
      matchedProduto.push({
        cnp: p.cnp,
        designacao: p.designacao,
        productType: p.productType,
        classN2: p.classificacaoNivel2?.nome ?? null,
        estado: p.estado,
        validadoManualmente: p.validadoManualmente,
        codigoATC: p.codigoATC,
        dci: p.dci,
      });
    }
  }

  const totalCNPs = cnpToDetail.size;
  const cnpsInErp = matchedProduto.length;
  const cnpsAlive = matchedProduto.filter((p) => p.estado !== "INATIVO").length;
  const cnpsMed = matchedProduto.filter((p) => p.productType === "MEDICAMENTO" && p.estado !== "INATIVO").length;
  const cnpsMedOutros = matchedProduto.filter(
    (p) => p.productType === "MEDICAMENTO" && p.estado !== "INATIVO" && p.classN2 === "Outros Medicamentos",
  ).length;
  const cnpsManual = matchedProduto.filter((p) => p.validadoManualmente).length;

  // Quantos têm ATC null em Produto mas têm ATC no detail
  const wouldGainAtc = matchedProduto.filter(
    (p) => !p.codigoATC && cnpToDetail.get(p.cnp)?.codigoATC,
  ).length;
  const wouldGainDci = matchedProduto.filter(
    (p) => !p.dci && cnpToDetail.get(p.cnp)?.dci,
  ).length;

  console.log(`    Total CNPs no detail:                ${totalCNPs}`);
  console.log(`    CNPs encontrados em Produto (total): ${cnpsInErp}`);
  console.log(`    Produtos vivos cobertos:             ${cnpsAlive}`);
  console.log(`    MEDICAMENTO vivos cobertos:          ${cnpsMed}`);
  console.log(`    MEDICAMENTO em Outros Medicamentos:  ${cnpsMedOutros}`);
  console.log(`    Produtos validadoManualmente=true:   ${cnpsManual}`);
  console.log(`    Sem ATC em Produto (would gain):     ${wouldGainAtc}`);
  console.log(`    Sem DCI em Produto (would gain):     ${wouldGainDci}`);

  // ATC prefixes presentes nos detalhes cross-matched
  console.log(`\n[3] Top ATC prefixes (entre os matched MEDICAMENTO):`);
  const matchedMedCnps = matchedProduto
    .filter((p) => p.productType === "MEDICAMENTO" && p.estado !== "INATIVO")
    .map((p) => p.cnp);
  const atcPref: Record<string, number> = {};
  const gapCount: Record<string, number> = {};
  for (const cnp of matchedMedCnps) {
    const det = cnpToDetail.get(cnp);
    if (!det?.codigoATC) continue;
    const p3 = det.codigoATC.slice(0, 3);
    atcPref[p3] = (atcPref[p3] ?? 0) + 1;
    if (KNOWN_GAPS.has(p3)) gapCount[p3] = (gapCount[p3] ?? 0) + 1;
  }
  const sortedPref = Object.entries(atcPref).sort((a, b) => b[1] - a[1]);
  console.log(`    Top 15:`);
  for (const [p, n] of sortedPref.slice(0, 15)) {
    console.log(`      ${p} ${String(n).padStart(4)}`);
  }
  console.log(`\n    Possíveis rule gaps (prefixos em KNOWN_GAPS):`);
  for (const [p, n] of Object.entries(gapCount).sort((a, b) => b[1] - a[1])) {
    console.log(`      ${p} ${String(n).padStart(4)}`);
  }
  const totalGapCnps = Object.values(gapCount).reduce((s, n) => s + n, 0);
  console.log(`    TOTAL gap candidates: ${totalGapCnps}`);

  // Impact estimate: produtos em Outros Medicamentos que ganhariam reclass
  // não-gap (terem ATC fora dos gaps conhecidos)
  const reclassableInOutros = matchedProduto.filter((p) => {
    if (p.productType !== "MEDICAMENTO") return false;
    if (p.estado === "INATIVO") return false;
    if (p.classN2 !== "Outros Medicamentos") return false;
    if (p.validadoManualmente) return false;
    const det = cnpToDetail.get(p.cnp);
    if (!det?.codigoATC) return false;
    const p3 = det.codigoATC.slice(0, 3);
    return !KNOWN_GAPS.has(p3);
  });
  console.log(`\n[4] Impact estimate:`);
  console.log(`    Em "Outros Medicamentos" + têm ATC mappable: ${reclassableInOutros.length}`);
  console.log(`    Estes podem sair de "Outros Medicamentos" após sync+reprocess`);

  // 30 exemplos diversificados
  console.log(`\n[5] 30 exemplos (mix de cohort + ATC group):`);
  const buckets: Record<string, typeof matchedProduto> = {};
  for (const p of matchedProduto.filter((x) => x.productType === "MEDICAMENTO" && x.estado !== "INATIVO")) {
    const det = cnpToDetail.get(p.cnp);
    const k = det?.codigoATC?.slice(0, 1) ?? "?";
    (buckets[k] = buckets[k] ?? []).push(p);
  }
  const picks: typeof matchedProduto = [];
  const seen = new Set<number>();
  let r = 0;
  while (picks.length < 30 && r < 10) {
    for (const k of Object.keys(buckets).sort()) {
      if (picks.length >= 30) break;
      const item = buckets[k][r];
      if (item && !seen.has(item.cnp)) {
        seen.add(item.cnp);
        picks.push(item);
      }
    }
    r++;
  }
  console.log(
    `${"CNP".padEnd(9)} | ${"Designação ERP".padEnd(36)} | ${"DCI".padEnd(24)} | ${"ATC".padEnd(8)} | ${"Forma".padEnd(20)} | ${"Dosagem".padEnd(12)} | em Outros?`,
  );
  console.log("─".repeat(140));
  for (const p of picks) {
    const det = cnpToDetail.get(p.cnp)!;
    const inOutros = p.classN2 === "Outros Medicamentos" ? "✓" : " ";
    const desigErp = (p.designacao ?? "").replace(/\s+/g, " ").slice(0, 35);
    const dci = (det.dci ?? "").slice(0, 22);
    const atc = det.codigoATC ?? "—";
    const forma = (det.forma ?? "").slice(0, 18);
    const dosagem = (det.dosagem ?? "").slice(0, 10);
    console.log(
      `${String(p.cnp).padEnd(9)} | ${desigErp.padEnd(36)} | ${dci.padEnd(24)} | ${atc.padEnd(8)} | ${forma.padEnd(20)} | ${dosagem.padEnd(12)} | ${inOutros}`,
    );
  }

  // Duplicações: mesmo CNP detalhado por mais de 1 MED_ID
  console.log(`\n[6] Detecção de duplicados (mesmo CNP via múltiplos MED_IDs):`);
  const cnpFreq: Record<number, number[]> = {};
  for (const r of records) {
    for (const e of r.embalagens) {
      (cnpFreq[e.cnp] = cnpFreq[e.cnp] ?? []).push(r.medId);
    }
  }
  const dupes = Object.entries(cnpFreq).filter(([_c, m]) => m.length > 1);
  console.log(`    CNPs com >1 MED_ID source: ${dupes.length}`);
  for (const [cnp, medIds] of dupes.slice(0, 5)) {
    console.log(`      CNP ${cnp}: MED_IDs ${medIds.join(", ")}`);
  }

  // Suspicious: designacao ERP vs INFOMED divergence
  console.log(`\n[7] Designações divergentes (sample 10):`);
  const divergentes = matchedProduto
    .filter((p) => p.productType === "MEDICAMENTO" && p.estado !== "INATIVO")
    .map((p) => {
      const det = cnpToDetail.get(p.cnp);
      if (!det) return null;
      const erpTok = (p.designacao ?? "").trim().split(/[\s,]/)[0]?.toLowerCase() ?? "";
      const infTok = det.designacao.trim().split(/[\s,]/)[0]?.toLowerCase() ?? "";
      const match = erpTok && infTok && erpTok.startsWith(infTok.slice(0, 4));
      if (match) return null;
      return { cnp: p.cnp, erp: p.designacao, infomed: det.designacao };
    })
    .filter((x): x is { cnp: number; erp: string; infomed: string } => !!x);
  console.log(`    Total casos divergentes: ${divergentes.length}`);
  for (const d of divergentes.slice(0, 10)) {
    console.log(`      CNP ${d.cnp}`);
    console.log(`        ERP:     "${d.erp.slice(0, 70)}"`);
    console.log(`        INFOMED: "${d.infomed.slice(0, 70)}"`);
  }
}

main()
  .catch((e) => {
    console.error("[fatal]", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
