/**
 * scripts/probe-dci-substitutions.ts
 *
 * Probe read-only — exercita `findDciEquivalentSubstitutions` contra
 * a BD legacy para responder à pergunta operacional:
 *
 *   "Quantas oportunidades de substituição interna existem se
 *    permitirmos pares DCI-equivalente (mesmo princípio activo +
 *    forma + dose + ATC5 + MSRM), além de same-CNP?"
 *
 * Sem writes. Sem alterar `/encomendas`. Sem UI nova.
 *
 * Output (todos via stdout):
 *   1. Universo: rows considerados, pré-filtragens, nº DCIs distintos
 *   2. Candidatos aceites: nº, unidades, € evitáveis
 *   3. Breakdown de rejeições por razão clínica
 *   4. Top 50 candidatos (destino → source, qty, € evitável)
 *
 * Encomenda-style thresholds por default (mesma fórmula que Fase B
 * same-CNP): rupture<15, excess>30, target=15, reserve=14.
 *
 * Uso:
 *   npx tsx scripts/probe-dci-substitutions.ts
 *   npx tsx scripts/probe-dci-substitutions.ts --top=30
 *   npx tsx scripts/probe-dci-substitutions.ts --rupture=7 --excess=20
 *   npx tsx scripts/probe-dci-substitutions.ts --no-require-medicamento
 */

import "dotenv/config";
import { legacyPrisma as prisma } from "../lib/prisma";
import {
  findDciEquivalentSubstitutions,
  type DciSubstitutionInput,
} from "../lib/transfers/dci-equivalent-substitution";

type Args = {
  topN: number;
  ruptureThresholdDays: number;
  excessThresholdDays: number;
  targetCoverageDays: number;
  reserveDaysSource: number;
  minTransferableQty: number;
  requireMedicamento: boolean;
};

function parseArgs(): Args {
  const out: Args = {
    topN: 50,
    ruptureThresholdDays: 15,
    excessThresholdDays: 30,
    targetCoverageDays: 15,
    reserveDaysSource: 14,
    minTransferableQty: 1,
    requireMedicamento: true,
  };
  for (const a of process.argv.slice(2)) {
    if (a === "--no-require-medicamento") out.requireMedicamento = false;
    else if (a.startsWith("--top=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (Number.isFinite(n) && n > 0 && n <= 500) out.topN = n;
    } else if (a.startsWith("--rupture=")) {
      const n = parseFloat(a.split("=")[1] ?? "");
      if (Number.isFinite(n) && n > 0) out.ruptureThresholdDays = n;
    } else if (a.startsWith("--excess=")) {
      const n = parseFloat(a.split("=")[1] ?? "");
      if (Number.isFinite(n) && n > 0) out.excessThresholdDays = n;
    } else if (a.startsWith("--target=")) {
      const n = parseFloat(a.split("=")[1] ?? "");
      if (Number.isFinite(n) && n > 0) out.targetCoverageDays = n;
    } else if (a.startsWith("--reserve=")) {
      const n = parseFloat(a.split("=")[1] ?? "");
      if (Number.isFinite(n) && n >= 0) out.reserveDaysSource = n;
    } else if (a.startsWith("--min-qty=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (Number.isFinite(n) && n > 0) out.minTransferableQty = n;
    }
  }
  return out;
}

type ProbeRow = {
  produtoId: string;
  farmaciaId: string;
  farmaciaNome: string;
  cnp: number;
  designacao: string;
  stockAtual: number;
  puc: number | null;
  salesQty: number;
  dci: string | null;
  formaFarmaceutica: string | null;
  dosagem: string | null;
  flagMSRM: boolean;
  flagMNSRM: boolean;
  codigoATC: string | null;
  productType: string | null;
};

async function loadRows(): Promise<DciSubstitutionInput[]> {
  // ProdutoFarmacia (vivos) + Produto metadata + vendas 90d.
  // Apenas farmácias ATIVO e excluindo "Farmácia Teste" — mesma política
  // do populate IPF.
  const rows = await prisma.$queryRawUnsafe<ProbeRow[]>(`
    WITH sales90 AS (
      SELECT vm."produtoId", vm."farmaciaId",
             SUM(vm.quantidade)::float AS qty
      FROM "VendaMensal" vm
      WHERE (vm.ano * 12 + vm.mes) >=
            ((EXTRACT(YEAR FROM NOW())::int * 12) + EXTRACT(MONTH FROM NOW())::int - 3)
        AND (vm.ano * 12 + vm.mes) <
            ((EXTRACT(YEAR FROM NOW())::int * 12) + EXTRACT(MONTH FROM NOW())::int)
      GROUP BY vm."produtoId", vm."farmaciaId"
    )
    SELECT
      pf."produtoId",
      pf."farmaciaId",
      f.nome              AS "farmaciaNome",
      p.cnp,
      p.designacao,
      pf."stockAtual"::float AS "stockAtual",
      pf.puc::float       AS puc,
      COALESCE(s.qty, 0)  AS "salesQty",
      p.dci,
      p."formaFarmaceutica",
      p.dosagem,
      p."flagMSRM",
      p."flagMNSRM",
      p."codigoATC",
      p."productType"
    FROM "ProdutoFarmacia" pf
    JOIN "Produto" p   ON p.id = pf."produtoId"
    JOIN "Farmacia" f  ON f.id = pf."farmaciaId"
    LEFT JOIN sales90 s
      ON s."produtoId" = pf."produtoId" AND s."farmaciaId" = pf."farmaciaId"
    WHERE pf."flagRetirado" = false
      AND f.estado = 'ATIVO'
      AND f.nome <> 'Farmácia Teste'
  `);

  return rows.map((r) => ({
    produtoId: r.produtoId,
    farmaciaId: r.farmaciaId,
    farmaciaNome: r.farmaciaNome,
    cnp: String(r.cnp),
    designacao: r.designacao,
    stockAtual: Number(r.stockAtual ?? 0),
    puc: r.puc === null ? null : Number(r.puc),
    salesQty: Number(r.salesQty ?? 0),
    dci: r.dci,
    formaFarmaceutica: r.formaFarmaceutica,
    dosagem: r.dosagem,
    flagMSRM: !!r.flagMSRM,
    flagMNSRM: !!r.flagMNSRM,
    codigoATC: r.codigoATC,
    productType: r.productType,
  }));
}

function eur(n: number): string {
  return n.toLocaleString("pt-PT", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

async function main(): Promise<void> {
  const args = parseArgs();
  const t0 = Date.now();

  console.log("─".repeat(78));
  console.log("Probe DCI-equivalent substitutions (READ-ONLY)");
  console.log("─".repeat(78));
  console.log(`  ruptureThresholdDays:    ${args.ruptureThresholdDays}`);
  console.log(`  excessThresholdDays:     ${args.excessThresholdDays}`);
  console.log(`  targetCoverageDays:      ${args.targetCoverageDays}`);
  console.log(`  reserveDaysSource:       ${args.reserveDaysSource}`);
  console.log(`  minTransferableQty:      ${args.minTransferableQty}`);
  console.log(`  requireMedicamento:      ${args.requireMedicamento}`);

  console.log(`\nA carregar rows do legacy DB...`);
  const input = await loadRows();
  console.log(`  ${input.length.toLocaleString("pt-PT")} ProdutoFarmacia rows (vivos, farmácias activas)`);

  console.log(`\nA correr detector...`);
  const result = findDciEquivalentSubstitutions(input, {
    ruptureThresholdDays: args.ruptureThresholdDays,
    excessThresholdDays: args.excessThresholdDays,
    targetCoverageDays: args.targetCoverageDays,
    reserveDaysSource: args.reserveDaysSource,
    minTransferableQty: args.minTransferableQty,
    requireMedicamento: args.requireMedicamento,
  });

  // ── 1. Universo ────────────────────────────────────────────────────
  console.log(`\n[1] Universo:`);
  console.log(`    rows totais (input):           ${input.length.toLocaleString("pt-PT")}`);
  console.log(`    rows pré-filtrados:            ${result.rowsPrefiltered.toLocaleString("pt-PT")}`);
  console.log(`    rows considerados:             ${result.rowsConsidered.toLocaleString("pt-PT")}`);
  console.log(`    DCIs distintos no universo:    ${result.dciDistinctCount.toLocaleString("pt-PT")}`);

  // ── 2. Candidatos aceites ──────────────────────────────────────────
  const totalUnits = result.candidates.reduce((s, c) => s + c.transferableQty, 0);
  const totalAvoided = result.candidates.reduce((s, c) => s + c.avoidedPurchaseEstimate, 0);
  console.log(`\n[2] Candidatos aceites:`);
  console.log(`    nº candidatos:                 ${result.candidates.length.toLocaleString("pt-PT")}`);
  console.log(`    unidades transferíveis:        ${totalUnits.toLocaleString("pt-PT")}`);
  console.log(`    valor evitável total:          ${eur(totalAvoided)}`);

  // ── 3. Rejeições por razão ─────────────────────────────────────────
  console.log(`\n[3] Rejeições por razão (priority order; first failed gate wins):`);
  const labels: Record<keyof typeof result.rejectionCounts, string> = {
    productType_nao_medicamento: "pré-filtro: productType ≠ MEDICAMENTO  ",
    dci_ausente:                 "pré-filtro: DCI ausente              ",
    forma_diferente:             "pair: forma farmacêutica diferente   ",
    dosagem_diferente:           "pair: dosagem diferente              ",
    atc_diferente:               "pair: ATC5 diferente                 ",
    msrm_divergente:             "pair: MSRM/MNSRM divergente          ",
    mesma_farmacia:              "pair: mesma farmácia (skip)          ",
    qty_insuficiente:            "post-gate: qty < minQty              ",
    destino_sem_demanda:         "destino: sem demanda mensurável      ",
  };
  for (const [k, label] of Object.entries(labels)) {
    const n = result.rejectionCounts[k as keyof typeof result.rejectionCounts];
    console.log(`    ${label} ${String(n).padStart(8)}`);
  }

  // ── 4. Top N ───────────────────────────────────────────────────────
  console.log(`\n[4] Top ${args.topN} candidatos (por € evitável desc):`);
  console.log(`    ${"€ evit".padStart(9)}  ${"qty".padStart(4)}  ${"destino → source"}`);
  console.log(`    ${"─".repeat(72)}`);
  for (const c of result.candidates.slice(0, args.topN)) {
    const destCnp = c.destinoCnp.padEnd(8);
    const srcCnp = c.sourceCnp.padEnd(8);
    const dest = `[${destCnp}] ${c.destinoDesignacao.slice(0, 28).padEnd(28)} (${c.destinoFarmaciaNome.slice(0, 12)})`;
    const src  = `[${srcCnp}] ${c.sourceDesignacao.slice(0, 28).padEnd(28)} (${c.sourceFarmaciaNome.slice(0, 12)})`;
    const cov = `${c.destinoCoverage?.toFixed(0) ?? "—"}d→${c.sourceCoverage.toFixed(0)}d`;
    console.log(
      `    ${String(c.avoidedPurchaseEstimate.toFixed(2)).padStart(9)} €` +
        `  ${String(c.transferableQty).padStart(4)}` +
        `  ${dest}`,
    );
    console.log(
      `              ↳ ${src}  ${cov}  ${c.dci.slice(0, 24)}|${c.dosagem.slice(0, 10)}|${c.formaFarmaceutica.slice(0, 14)}`,
    );
  }

  console.log("\n" + "─".repeat(78));
  console.log(`Probe concluído em ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
}

main()
  .catch((err) => {
    console.error("[fatal]", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
