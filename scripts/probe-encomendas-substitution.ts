/**
 * scripts/probe-encomendas-substitution.ts
 *
 * Mede o impacto operacional da substituição interna same-CNP em
 * encomendas. Reproduz exactamente o cálculo de `getEncomendasData`
 * (ProdutoFarmacia + VendaMensal 3m → recent3 → findInternalSubstitutions
 * com thresholds encomenda) e simula a sugestão de encomenda para
 * uma cobertura-alvo escolhida.
 *
 * Read-only. Sem writes.
 *
 * Output:
 *   1. universo (PF + farmácias)
 *   2. candidatos: total · com sugestão · qty total · € evitável total
 *   3. distribuição por farmácia destino
 *   4. top N por € evitável
 *   5. top N por unidades transferíveis
 *
 * Uso:
 *   npx tsx scripts/probe-encomendas-substitution.ts
 *   npx tsx scripts/probe-encomendas-substitution.ts --target=15 --top=20
 */

import "dotenv/config";
import { legacyPrisma as prisma } from "../lib/prisma";
import { findInternalSubstitutions } from "../lib/transfers/internal-substitution";
import { avgDaily, WINDOW_90D } from "../lib/operational/metrics-shared";

type Args = { targetDays: number; topN: number };
function parseArgs(): Args {
  const out: Args = { targetDays: 15, topN: 20 };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--target=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (Number.isFinite(n) && n > 0 && n <= 365) out.targetDays = n;
    } else if (a.startsWith("--top=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (Number.isFinite(n) && n > 0 && n <= 200) out.topN = n;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const t0 = Date.now();

  console.log("─".repeat(78));
  console.log(`probe-encomendas-substitution (read-only) · target=${args.targetDays}d`);
  console.log("─".repeat(78));

  const farmacias = await prisma.farmacia.findMany({
    where: { estado: "ATIVO", nome: { not: "Farmácia Teste" } },
    select: { id: true, nome: true },
    orderBy: { nome: "asc" },
  });
  const farmaciaIds = farmacias.map((f) => f.id);
  console.log(`\n[1] Farmácias activas: ${farmaciaIds.length}`);

  // ProdutoFarmacia + puc (igual ao query de encomendas-data)
  type PfRow = {
    produtoId: string;
    farmaciaId: string;
    farmaciaNome: string;
    cnp: string;
    designacao: string;
    stockAtual: number;
    puc: number | null;
  };
  const pfRows = await prisma.$queryRawUnsafe<PfRow[]>(
    `
    SELECT pf."produtoId", pf."farmaciaId", f.nome AS "farmaciaNome",
           p.cnp::text AS cnp, p.designacao,
           pf."stockAtual"::float AS "stockAtual",
           pf.puc::float          AS puc
    FROM "ProdutoFarmacia" pf
    JOIN "Produto" p ON p.id = pf."produtoId"
    JOIN "Farmacia" f ON f.id = pf."farmaciaId"
    WHERE pf."flagRetirado" = false
      AND f.id = ANY($1)
      AND pf."stockAtual" IS NOT NULL
    `,
    farmaciaIds,
  );
  console.log(`[2] ProdutoFarmacia vivos: ${pfRows.length}`);

  // VendaMensal 3m (recent3 base)
  const now = new Date();
  const periodEnd = now.getFullYear() * 12 + now.getMonth() + 1;
  const period3m = periodEnd - 3;
  type SalesM = { produtoId: string; farmaciaId: string; qty: number };
  const sales3m = await prisma.$queryRawUnsafe<SalesM[]>(
    `
    SELECT vm."produtoId", vm."farmaciaId",
           SUM(vm.quantidade)::float AS qty
    FROM "VendaMensal" vm
    WHERE (vm.ano * 12 + vm.mes) >= $1
      AND (vm.ano * 12 + vm.mes) < $2
      AND vm."farmaciaId" = ANY($3)
    GROUP BY vm."produtoId", vm."farmaciaId"
    `,
    period3m,
    periodEnd,
    farmaciaIds,
  );
  const salesMap = new Map<string, number>();
  for (const s of sales3m) {
    salesMap.set(`${s.produtoId}:${s.farmaciaId}`, Number(s.qty));
  }
  console.log(`[3] VendaMensal 3m pares: ${sales3m.length}`);

  // Construir input para findInternalSubstitutions (igual ao encomendas-data)
  const subInput = pfRows.map((p) => ({
    produtoId: p.produtoId,
    farmaciaId: p.farmaciaId,
    farmaciaNome: p.farmaciaNome,
    cnp: p.cnp,
    designacao: p.designacao,
    stockAtual: Number(p.stockAtual),
    puc: p.puc,
    salesQty: salesMap.get(`${p.produtoId}:${p.farmaciaId}`) ?? 0,
  }));

  console.log(`\n[4] A correr findInternalSubstitutions (thresholds encomenda)...`);
  const subs = findInternalSubstitutions(subInput, {
    ruptureThresholdDays: 15,
    excessThresholdDays: 30,
    targetCoverageDays: 15,
    reserveDaysSource: 14,
    minTransferableQty: 1,
  });
  console.log(`    candidatos: ${subs.length}`);

  // Simula encomenda: para cada PF, calcula sugestao = max(0, ceil((avgDaily90d × targetDays) − stock))
  // Match com substitution por (produtoId, destinoFarmaciaId).
  type Linha = {
    cnp: string;
    designacao: string;
    farmaciaDestino: string;
    farmaciaOrigem: string;
    stockAtual: number;
    sugestaoEncomenda: number;
    transferableQty: number;
    avoidedPurchaseValue: number;
    coverageDestino: number;
    coverageOrigem: number;
    avgDaily: number;
  };

  const subsByKey = new Map(subs.map((s) => [`${s.produtoId}:${s.destinoFarmaciaId}`, s]));
  const linhas: Linha[] = [];

  for (const p of pfRows) {
    const k = `${p.produtoId}:${p.farmaciaId}`;
    const ad = avgDaily(salesMap.get(k) ?? 0, WINDOW_90D);
    const sugestao = Math.max(0, Math.ceil(ad * args.targetDays - Number(p.stockAtual)));
    if (sugestao <= 0) continue;
    const sub = subsByKey.get(k);
    if (!sub) continue;
    linhas.push({
      cnp: p.cnp,
      designacao: p.designacao,
      farmaciaDestino: p.farmaciaNome,
      farmaciaOrigem: sub.suggestedSourceFarmaciaNome,
      stockAtual: Math.round(Number(p.stockAtual)),
      sugestaoEncomenda: sugestao,
      transferableQty: sub.transferableQty,
      avoidedPurchaseValue: sub.avoidedPurchaseEstimate,
      coverageDestino: sub.stockCoverageDestination ?? 0,
      coverageOrigem: sub.stockCoverageOrigin,
      avgDaily: ad,
    });
  }

  console.log(`\n[5] Linhas de encomenda com substituição interna detectada: ${linhas.length}`);
  const qtyTotal = linhas.reduce((s, l) => s + l.transferableQty, 0);
  const valorEvitavel = linhas.reduce((s, l) => s + l.avoidedPurchaseValue, 0);
  console.log(`    unidades transferíveis (sum):          ${qtyTotal}`);
  console.log(`    valor de compra evitável (sum):         ${valorEvitavel.toFixed(2)} €`);

  // Distribuição por destino
  const porDestino = new Map<string, { count: number; valor: number; qty: number }>();
  for (const l of linhas) {
    const cur = porDestino.get(l.farmaciaDestino) ?? { count: 0, valor: 0, qty: 0 };
    cur.count++;
    cur.valor += l.avoidedPurchaseValue;
    cur.qty += l.transferableQty;
    porDestino.set(l.farmaciaDestino, cur);
  }
  console.log(`\n  Distribuição por farmácia destino:`);
  for (const [nome, v] of porDestino) {
    console.log(`    ${nome.padEnd(28)} ${String(v.count).padStart(4)} linhas · ${String(v.qty).padStart(5)} un. · ${v.valor.toFixed(2)} €`);
  }

  // Top N por € evitável
  console.log(`\n[6] Top ${args.topN} por € evitável:`);
  const topValor = [...linhas].sort((a, b) => b.avoidedPurchaseValue - a.avoidedPurchaseValue).slice(0, args.topN);
  for (const l of topValor) {
    console.log(
      `    ${l.avoidedPurchaseValue.toFixed(2).padStart(8)} €  CNP=${l.cnp}  ` +
        `qty=${String(l.transferableQty).padStart(3)}  ` +
        `enc=${String(l.sugestaoEncomenda).padStart(3)}  ` +
        `cov ${l.coverageOrigem.toFixed(0).padStart(3)}d→${l.coverageDestino.toFixed(0).padStart(3)}d  ` +
        `"${l.designacao.slice(0, 38)}"  (${l.farmaciaOrigem} → ${l.farmaciaDestino})`,
    );
  }

  console.log(`\n[7] Top ${args.topN} por unidades transferíveis:`);
  const topQty = [...linhas].sort((a, b) => b.transferableQty - a.transferableQty).slice(0, args.topN);
  for (const l of topQty) {
    console.log(
      `    ${String(l.transferableQty).padStart(4)} un.  CNP=${l.cnp}  ` +
        `${l.avoidedPurchaseValue.toFixed(2).padStart(8)} €  ` +
        `vel=${l.avgDaily.toFixed(2)}/d  ` +
        `"${l.designacao.slice(0, 38)}"  (${l.farmaciaOrigem} → ${l.farmaciaDestino})`,
    );
  }

  console.log("\n" + "─".repeat(78));
  console.log(`probe concluído em ${((Date.now() - t0) / 1000).toFixed(1)}s. Read-only.`);
  console.log("─".repeat(78));
}

main()
  .catch((e) => {
    console.error("[fatal]", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
