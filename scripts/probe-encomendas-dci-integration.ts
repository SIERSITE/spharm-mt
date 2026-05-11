/**
 * scripts/probe-encomendas-dci-integration.ts
 *
 * Probe read-only do pipeline integrado de encomendas (same-CNP +
 * DCI-equivalente). Replica a regra do server-side:
 *   1. Carrega ProdutoFarmacia + Produto metadata + VendaMensal 3m
 *      (mesma SQL que `getEncomendasData`).
 *   2. Corre `findInternalSubstitutions` (same-CNP).
 *   3. Corre `findDciEquivalentSubstitutions` (DCI-equivalente).
 *   4. Prioridade: para cada destino com same-CNP, suprime o DCI.
 *   5. Reporta:
 *      · # destinos com same-CNP (e € evitável)
 *      · # destinos com DCI-equivalente only (e € evitável incremental)
 *      · combined totals
 *      · top 30 exemplos por € evitável (mistura ambos os tipos)
 *      · rejeições principais do detector DCI
 *
 * Sem writes. Sem UI. Sem alteração ao detector.
 *
 * Uso:
 *   npx tsx scripts/probe-encomendas-dci-integration.ts
 *   npx tsx scripts/probe-encomendas-dci-integration.ts --top=50
 */

import "dotenv/config";
import { legacyPrisma as prisma } from "../lib/prisma";
import {
  findInternalSubstitutions,
  type SubstitutionInput,
} from "../lib/transfers/internal-substitution";
import {
  findDciEquivalentSubstitutions,
  type DciSubstitutionInput,
} from "../lib/transfers/dci-equivalent-substitution";

type Args = { topN: number };
function parseArgs(): Args {
  const out: Args = { topN: 30 };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--top=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (Number.isFinite(n) && n > 0 && n <= 500) out.topN = n;
    }
  }
  return out;
}

const ENCOMENDA_OPTS = {
  ruptureThresholdDays: 15,
  excessThresholdDays: 30,
  targetCoverageDays: 15,
  reserveDaysSource: 14,
  minTransferableQty: 1,
};

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

async function loadRows(): Promise<ProbeRow[]> {
  return prisma.$queryRawUnsafe<ProbeRow[]>(`
    WITH sales3m AS (
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
    JOIN "Produto" p  ON p.id = pf."produtoId"
    JOIN "Farmacia" f ON f.id = pf."farmaciaId"
    LEFT JOIN sales3m s
      ON s."produtoId" = pf."produtoId" AND s."farmaciaId" = pf."farmaciaId"
    WHERE pf."flagRetirado" = false
      AND f.estado = 'ATIVO'
      AND f.nome <> 'Farmácia Teste'
  `);
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
  console.log("Probe Encomendas — same-CNP + DCI-equivalente integrado (READ-ONLY)");
  console.log("─".repeat(78));

  console.log(`\nA carregar rows...`);
  const rows = await loadRows();
  console.log(`  ${rows.length.toLocaleString("pt-PT")} ProdutoFarmacia rows.`);

  // Build inputs
  const sameInput: SubstitutionInput[] = rows.map((r) => ({
    produtoId: r.produtoId,
    farmaciaId: r.farmaciaId,
    farmaciaNome: r.farmaciaNome,
    cnp: String(r.cnp),
    designacao: r.designacao,
    stockAtual: Number(r.stockAtual ?? 0),
    puc: r.puc === null ? null : Number(r.puc),
    salesQty: Number(r.salesQty ?? 0),
  }));
  const dciInput: DciSubstitutionInput[] = rows.map((r) => ({
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

  console.log(`A correr detectores...`);
  const sameCnp = findInternalSubstitutions(sameInput, ENCOMENDA_OPTS);
  const dci = findDciEquivalentSubstitutions(dciInput, {
    ...ENCOMENDA_OPTS,
    requireMedicamento: true,
  });

  // Apply pipeline rule: same-CNP wins per destino
  const sameDestinos = new Set<string>();
  for (const s of sameCnp) sameDestinos.add(`${s.produtoId}:${s.destinoFarmaciaId}`);

  const dciOnlyCandidates = dci.candidates.filter(
    (c) => !sameDestinos.has(`${c.destinoProdutoId}:${c.destinoFarmaciaId}`),
  );

  const sameEur = sameCnp.reduce((s, c) => s + c.avoidedPurchaseEstimate, 0);
  const sameQty = sameCnp.reduce((s, c) => s + c.transferableQty, 0);
  const dciOnlyEur = dciOnlyCandidates.reduce((s, c) => s + c.avoidedPurchaseEstimate, 0);
  const dciOnlyQty = dciOnlyCandidates.reduce((s, c) => s + c.transferableQty, 0);

  // ── Métricas ────────────────────────────────────────────────────────
  console.log(`\n[1] Same-CNP (prioridade):`);
  console.log(`    candidatos:                ${sameCnp.length}`);
  console.log(`    unidades:                  ${sameQty}`);
  console.log(`    € evitável:                ${eur(sameEur)}`);

  console.log(`\n[2] DCI-equivalent ONLY (fallback — destinos sem same-CNP):`);
  console.log(`    candidatos:                ${dciOnlyCandidates.length}`);
  console.log(`    unidades:                  ${dciOnlyQty}`);
  console.log(`    € evitável incremental:    ${eur(dciOnlyEur)}`);

  console.log(`\n[3] Combined (pipeline final):`);
  console.log(`    candidatos:                ${sameCnp.length + dciOnlyCandidates.length}`);
  console.log(`    unidades:                  ${sameQty + dciOnlyQty}`);
  console.log(`    € evitável total:          ${eur(sameEur + dciOnlyEur)}`);

  console.log(`\n[4] DCI universo (sem prioridade aplicada — para referência):`);
  console.log(`    candidatos brutos:         ${dci.candidates.length}`);
  console.log(`    rows pré-filtrados:        ${dci.rowsPrefiltered}`);
  console.log(`    rows considerados:         ${dci.rowsConsidered}`);
  console.log(`    DCIs distintos:            ${dci.dciDistinctCount}`);

  console.log(`\n[5] Rejeições principais do detector DCI:`);
  const labels: Record<keyof typeof dci.rejectionCounts, string> = {
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
    const n = dci.rejectionCounts[k as keyof typeof dci.rejectionCounts];
    console.log(`    ${label} ${String(n).padStart(8)}`);
  }

  // ── Top N (mistura same-CNP + DCI-only por € evitável) ───────────
  type TopRow =
    | { kind: "same-cnp"; data: (typeof sameCnp)[number] }
    | { kind: "dci-equivalent"; data: (typeof dciOnlyCandidates)[number] };
  const all: TopRow[] = [
    ...sameCnp.map((d) => ({ kind: "same-cnp" as const, data: d })),
    ...dciOnlyCandidates.map((d) => ({ kind: "dci-equivalent" as const, data: d })),
  ];
  all.sort((a, b) => {
    const av = a.kind === "same-cnp" ? a.data.avoidedPurchaseEstimate : a.data.avoidedPurchaseEstimate;
    const bv = b.kind === "same-cnp" ? b.data.avoidedPurchaseEstimate : b.data.avoidedPurchaseEstimate;
    return bv - av;
  });
  console.log(`\n[6] Top ${args.topN} (mix same-CNP + DCI-only, por € evitável desc):`);
  console.log(`    ${"€ evit".padStart(9)}  ${"qty".padStart(4)}  ${"tipo".padEnd(13)}  destino → source`);
  console.log(`    ${"─".repeat(72)}`);
  for (const r of all.slice(0, args.topN)) {
    if (r.kind === "same-cnp") {
      const c = r.data;
      console.log(
        `    ${String(c.avoidedPurchaseEstimate.toFixed(2)).padStart(9)} €` +
          `  ${String(c.transferableQty).padStart(4)}  cyan same-CNP` +
          `  [${c.cnp.padEnd(8)}] ${c.designacao.slice(0, 28).padEnd(28)} (${c.destinoFarmaciaNome.slice(0,12)}) ← (${c.suggestedSourceFarmaciaNome.slice(0,12)})`,
      );
    } else {
      const c = r.data;
      console.log(
        `    ${String(c.avoidedPurchaseEstimate.toFixed(2)).padStart(9)} €` +
          `  ${String(c.transferableQty).padStart(4)}  amber DCI    ` +
          `  [${c.destinoCnp.padEnd(8)}] ${c.destinoDesignacao.slice(0, 28).padEnd(28)} (${c.destinoFarmaciaNome.slice(0,12)})`,
      );
      console.log(
        `                                    ↳ [${c.sourceCnp.padEnd(8)}] ${c.sourceDesignacao.slice(0, 28).padEnd(28)} (${c.sourceFarmaciaNome.slice(0,12)})  ${c.dci.slice(0,18)}|${c.dosagem.slice(0,8)}|ATC ${c.atc5}`,
      );
    }
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
