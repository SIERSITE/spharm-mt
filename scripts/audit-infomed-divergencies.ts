/**
 * scripts/audit-infomed-divergencies.ts
 *
 * Auditoria rápida das 12 designações divergentes entre ERP Produto e
 * detalhes INFOMED (P9 Fase 2). Verifica:
 *   - Os campos clínicos (DCI, ATC, forma, dosagem) estão consistentes?
 *   - O nome diverge mas o medicamento é o mesmo?
 *   - Há padrão sistémico de false positive?
 *
 * Read-only. Não escreve em BD.
 */

import "dotenv/config";
import * as fs from "fs";
import { legacyPrisma as prisma } from "../lib/prisma";

const DETAILS_FILE = "scripts/data/infomed-listagem-details.json";

async function main() {
  const details = JSON.parse(fs.readFileSync(DETAILS_FILE, "utf-8")) as {
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

  // Reconstruir cnp → detail (mesma lógica do coverage report)
  const cnpToDetail = new Map<number, {
    medId: number;
    designacao: string;
    dci: string | null;
    codigoATC: string | null;
    forma: string | null;
    dosagem: string | null;
    titular: string | null;
  }>();
  for (const r of Object.values(details.details)) {
    for (const e of r.embalagens) {
      if (!cnpToDetail.has(e.cnp)) {
        cnpToDetail.set(e.cnp, {
          medId: r.medId,
          designacao: r.designacaoOficial ?? "",
          dci: r.dci,
          codigoATC: r.codigoATC,
          forma: r.formaFarmaceutica,
          dosagem: r.dosagem,
          titular: r.titularAim,
        });
      }
    }
  }

  // Para todos os MEDICAMENTO vivos cobertos, encontrar divergentes
  // (mesmo first-token mismatch logic do coverage report)
  const allCnps = [...cnpToDetail.keys()];
  const chunkSize = 10_000;
  const matched: Array<{ cnp: number; designacao: string; dci: string | null; codigoATC: string | null }> = [];
  for (let i = 0; i < allCnps.length; i += chunkSize) {
    const slice = allCnps.slice(i, i + chunkSize);
    const found = await prisma.produto.findMany({
      where: { cnp: { in: slice }, productType: "MEDICAMENTO", estado: { not: "INATIVO" } },
      select: { cnp: true, designacao: true, dci: true, codigoATC: true },
    });
    matched.push(...found);
  }

  // Filtrar divergentes (designação first-token mismatch)
  const divergent: Array<{
    cnp: number;
    erpDesig: string;
    erpDci: string | null;
    erpAtc: string | null;
    infDesig: string;
    infDci: string | null;
    infAtc: string | null;
    infForma: string | null;
    infDosagem: string | null;
    infTitular: string | null;
    infMedId: number;
  }> = [];
  for (const p of matched) {
    const det = cnpToDetail.get(p.cnp);
    if (!det) continue;
    const erpTok = (p.designacao ?? "").trim().split(/[\s,]/)[0]?.toLowerCase() ?? "";
    const infTok = det.designacao.trim().split(/[\s,]/)[0]?.toLowerCase() ?? "";
    const match = erpTok && infTok && erpTok.startsWith(infTok.slice(0, 4));
    if (!match) {
      divergent.push({
        cnp: p.cnp,
        erpDesig: p.designacao ?? "",
        erpDci: p.dci,
        erpAtc: p.codigoATC,
        infDesig: det.designacao,
        infDci: det.dci,
        infAtc: det.codigoATC,
        infForma: det.forma,
        infDosagem: det.dosagem,
        infTitular: det.titular,
        infMedId: det.medId,
      });
    }
  }

  console.log(`Divergencias detectadas: ${divergent.length}\n`);
  console.log("─".repeat(120));

  // Categorizar cada uma
  type Verdict = "ok_formatting" | "ok_dci_omitted" | "ok_brand_short" | "suspicious_brand_diff" | "other";
  const results: Array<{ verdict: Verdict; reason: string; row: typeof divergent[0] }> = [];

  for (const d of divergent) {
    const erpNorm = (d.erpDesig ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    const infNorm = (d.infDesig ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    const erpTokens = erpNorm.split(/[\s,'-]+/).filter(Boolean);
    const infTokens = infNorm.split(/[\s,'-]+/).filter(Boolean);

    // 1. Acento/case/formatação: tokens normalizados batem
    const sameNormSet = erpTokens.some((t) => infTokens.includes(t)) && infTokens.every((t) => erpTokens.includes(t));
    if (sameNormSet) {
      results.push({ verdict: "ok_formatting", reason: "case/acento/pontuação diferente", row: d });
      continue;
    }

    // 2. INFOMED prefixa DCI à designação (ex.: ERP "Monuril" → INFOMED "Fosfomicina Monuril")
    // INFOMED contém DCI + brand; ERP só tem brand
    if (d.infDci) {
      const dciTokens = d.infDci.toLowerCase().split(/[\s+]+/).filter(Boolean);
      const infTokensExcludingDci = infTokens.filter((t) => !dciTokens.some((dt) => dt.startsWith(t.slice(0, 4)) || t.startsWith(dt.slice(0, 4))));
      const infMatchesErpAfterRemovingDci = infTokensExcludingDci.length > 0 && erpTokens.some((t) => infTokensExcludingDci.includes(t));
      if (infMatchesErpAfterRemovingDci) {
        results.push({ verdict: "ok_dci_omitted", reason: "INFOMED prefixa DCI à designação", row: d });
        continue;
      }
    }

    // 3. INFOMED só tem brand (mais curto), ERP tem brand + DCI/info adicional
    if (infTokens.length <= 2 && erpTokens.some((t) => infTokens.includes(t))) {
      results.push({ verdict: "ok_brand_short", reason: "INFOMED só brand, ERP brand+detalhe", row: d });
      continue;
    }

    // 4. Suspeito: nomes completamente diferentes
    results.push({ verdict: "suspicious_brand_diff", reason: "brand names diferentes — investigar", row: d });
  }

  // Tabela ASCII
  for (let i = 0; i < results.length; i++) {
    const { verdict, reason, row } = results[i];
    const symbol = verdict === "suspicious_brand_diff" ? "⚠" : "✓";
    console.log(`\n${symbol} #${i + 1} CNP=${row.cnp}  [${verdict}]`);
    console.log(`    ERP:      "${row.erpDesig.slice(0, 70)}"`);
    console.log(`              dci=${row.erpDci ?? "—"}  atc=${row.erpAtc ?? "—"}`);
    console.log(`    INFOMED:  "${row.infDesig.slice(0, 70)}"`);
    console.log(`              dci=${row.infDci ?? "—"}  atc=${row.infAtc ?? "—"}  forma=${row.infForma ?? "—"}  dosagem=${row.infDosagem ?? "—"}`);
    console.log(`    titular:  ${row.infTitular ?? "—"}`);
    console.log(`    causa:    ${reason}`);
  }

  // Sumário
  console.log("\n" + "─".repeat(120));
  console.log("SUMÁRIO DA AUDITORIA");
  console.log("─".repeat(120));
  const tally: Record<Verdict, number> = {
    ok_formatting: 0,
    ok_dci_omitted: 0,
    ok_brand_short: 0,
    suspicious_brand_diff: 0,
    other: 0,
  };
  for (const r of results) tally[r.verdict]++;
  console.log(`  ok (formatting/case/acento):      ${tally.ok_formatting}`);
  console.log(`  ok (INFOMED prefixa DCI):         ${tally.ok_dci_omitted}`);
  console.log(`  ok (INFOMED só brand):            ${tally.ok_brand_short}`);
  console.log(`  ⚠ suspeito (brands diferentes):   ${tally.suspicious_brand_diff}`);
  console.log(`  outro:                            ${tally.other}`);
  console.log();
  console.log(`  TOTAL:                            ${results.length}`);
}

main()
  .catch((e) => {
    console.error("[fatal]", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
