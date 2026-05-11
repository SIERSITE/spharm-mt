/**
 * scripts/indicadores-produto-farmacia-dry-run.ts
 *
 * Dry-run de cálculo de `IndicadoresProdutoFarmacia`. Lê fontes
 * (`ProdutoFarmacia`, `Venda`, `VendaMensal`, `Compra`) e calcula os
 * 11 indicadores do schema, SEM ESCREVER em BD.
 *
 * Mostra:
 *   · contagens populáveis vs total
 *   · distribuição de `classificacaoABC` e `classificacaoRotacao`
 *   · histogramas de `mediaVendasDiarias90d`, `diasStockRestante`,
 *     `diasSemVenda`, `valorStockParado`
 *   · comparação numérica com `lib/stock-data.ts` (avgDaily90d) e
 *     `lib/encomendas-data.ts` (recent3 / 90) para validar drift
 *   · amostra detalhada de 10 PFs (CSV pronto a colar)
 *
 * Não escreve em `IndicadoresProdutoFarmacia`. Não escreve em sítio
 * nenhum. Read-only.
 *
 * Uso:
 *   npx tsx scripts/indicadores-produto-farmacia-dry-run.ts
 *   npx tsx scripts/indicadores-produto-farmacia-dry-run.ts --farmacia=<id>
 *   npx tsx scripts/indicadores-produto-farmacia-dry-run.ts --sample=20
 *   npx tsx scripts/indicadores-produto-farmacia-dry-run.ts --compare-sample=30
 */

import "dotenv/config";
import { legacyPrisma as prisma } from "../lib/prisma";
import {
  avgDaily,
  coverageDays,
  WINDOW_30D,
  WINDOW_90D,
} from "../lib/operational/metrics-shared";

type Args = {
  farmaciaId: string | null;
  sample: number;
  compareSample: number;
};

function parseArgs(): Args {
  const out: Args = { farmaciaId: null, sample: 10, compareSample: 20 };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--farmacia=")) out.farmaciaId = a.split("=")[1] ?? null;
    else if (a.startsWith("--sample=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (Number.isFinite(n) && n >= 0 && n <= 200) out.sample = n;
    } else if (a.startsWith("--compare-sample=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (Number.isFinite(n) && n >= 0 && n <= 200) out.compareSample = n;
    }
  }
  return out;
}

// Enums replicados localmente (sem importar de @/generated/prisma)
type ClassificacaoABC = "A" | "B" | "C" | "NAO_CLASSIFICADO";
type ClassificacaoRotacao = "NORMAL" | "ATENCAO" | "SEM_ROTACAO";

type Indicator = {
  produtoId: string;
  farmaciaId: string;
  cnp: string;
  designacao: string;
  // Numericos
  mediaVendasDiarias30d: number | null;
  mediaVendasDiarias90d: number | null;
  mediaVendasMensais3m: number | null;
  mediaVendasMensais12m: number | null;
  diasStockRestante: number | null;
  diasSemVenda: number | null;
  ultimoPrecoCompra: number | null;
  ultimoFornecedorId: string | null;
  valorStockParado: number | null;
  // Classificações
  classificacaoABC: ClassificacaoABC;
  classificacaoRotacao: ClassificacaoRotacao;
  // Contexto interno (não persistido — útil para comparações)
  stockAtual: number;
  puc: number | null;
  pmc: number | null;
  valorVenda90d: number;
};

const MS_PER_DAY = 86_400_000;

function daysSince(d: Date | null): number | null {
  if (!d) return null;
  const ms = Date.now() - d.getTime();
  if (ms < 0) return 0;
  return Math.floor(ms / MS_PER_DAY);
}

function toF(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ──────────────────────────────────────────────────────────────────────────
// Heurísticas de classificação (documentadas no entregável)
// ──────────────────────────────────────────────────────────────────────────

/**
 * ABC por percentil cumulativo do valor de venda 90d, por farmácia.
 *   · A: produtos que acumulam até 80% do valor total
 *   · B: próximos 15% (acumulado 80-95%)
 *   · C: últimos 5%
 *   · NAO_CLASSIFICADO: sem vendas
 */
function classifyABCByCumulative(
  perFarmaciaSorted: Array<{ key: string; valor: number }>,
): Map<string, ClassificacaoABC> {
  const out = new Map<string, ClassificacaoABC>();
  const total = perFarmaciaSorted.reduce((s, r) => s + r.valor, 0);
  if (total === 0) {
    for (const r of perFarmaciaSorted) out.set(r.key, "NAO_CLASSIFICADO");
    return out;
  }
  let acc = 0;
  for (const r of perFarmaciaSorted) {
    if (r.valor === 0) {
      out.set(r.key, "NAO_CLASSIFICADO");
      continue;
    }
    acc += r.valor;
    const pct = acc / total;
    if (pct <= 0.8) out.set(r.key, "A");
    else if (pct <= 0.95) out.set(r.key, "B");
    else out.set(r.key, "C");
  }
  return out;
}

/**
 * Rotação derivada de avgDaily90d + diasSemVenda. Enum do schema é
 * NORMAL/ATENCAO/SEM_ROTACAO (3 níveis).
 *
 *   · SEM_ROTACAO: avgDaily90d ≈ 0 E diasSemVenda > 90 (ou null)
 *   · ATENCAO: avgDaily90d < 0.05/dia (≤ 1.5 un/mês) OU diasSemVenda > 60
 *   · NORMAL: tudo o resto
 */
function classifyRotacao(
  avgDaily90d: number,
  diasSemVendaVal: number | null,
): ClassificacaoRotacao {
  if (avgDaily90d <= 0) {
    if (diasSemVendaVal === null || diasSemVendaVal > 90) return "SEM_ROTACAO";
    return "ATENCAO";
  }
  if (avgDaily90d < 0.05) return "ATENCAO";
  if (diasSemVendaVal !== null && diasSemVendaVal > 60) return "ATENCAO";
  return "NORMAL";
}

// ──────────────────────────────────────────────────────────────────────────
// Histograma simples
// ──────────────────────────────────────────────────────────────────────────

function histogram(values: number[], buckets: number[]): Array<{ range: string; count: number }> {
  const out: Array<{ range: string; count: number }> = [];
  const sorted = [...buckets].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    const lo = sorted[i]!;
    const hi = i + 1 < sorted.length ? sorted[i + 1]! : Number.POSITIVE_INFINITY;
    const count = values.filter((v) => v >= lo && v < hi).length;
    const hiLabel = Number.isFinite(hi) ? String(hi) : "+∞";
    out.push({ range: `[${lo}, ${hiLabel})`, count });
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const t0 = Date.now();

  console.log("─".repeat(78));
  console.log("Dry-run IndicadoresProdutoFarmacia (read-only — sem writes)");
  console.log("─".repeat(78));
  console.log(`  farmacia: ${args.farmaciaId ?? "(todas activas)"}`);
  console.log(`  sample:        ${args.sample}`);
  console.log(`  compareSample: ${args.compareSample}`);

  // ── 1. Farmácias activas ───────────────────────────────────────────────
  const farmacias = await prisma.farmacia.findMany({
    where: {
      estado: "ATIVO",
      nome: { not: "Farmácia Teste" },
      ...(args.farmaciaId ? { id: args.farmaciaId } : {}),
    },
    select: { id: true, nome: true },
    orderBy: { nome: "asc" },
  });
  const farmaciaIds = farmacias.map((f) => f.id);
  const farmaciaNomes = new Map(farmacias.map((f) => [f.id, f.nome]));
  if (farmaciaIds.length === 0) {
    console.log("Nenhuma farmácia activa. Sair.");
    return;
  }
  console.log(`\n[1/6] Farmácias activas: ${farmaciaIds.length} (${farmacias.map((f) => f.nome).join(", ")})`);

  // ── 2. ProdutoFarmacia ─────────────────────────────────────────────────
  type PfRow = {
    produtoId: string;
    farmaciaId: string;
    cnp: string;
    designacao: string;
    stockAtual: number;
    puc: number | null;
    pmc: number | null;
    pvp: number | null;
    dataUltimaVenda: Date | null;
  };

  const pfRows = await prisma.$queryRawUnsafe<PfRow[]>(
    `
    SELECT
      pf."produtoId",
      pf."farmaciaId",
      p.cnp::text AS cnp,
      p.designacao,
      pf."stockAtual"::float AS "stockAtual",
      pf.puc::float AS puc,
      pf.pmc::float AS pmc,
      pf.pvp::float AS pvp,
      pf."dataUltimaVenda"
    FROM "ProdutoFarmacia" pf
    JOIN "Produto" p ON p.id = pf."produtoId"
    WHERE pf."flagRetirado" = false
      AND pf."farmaciaId" = ANY($1)
    `,
    farmaciaIds,
  );
  console.log(`[2/6] ProdutoFarmacia (vivos): ${pfRows.length}`);

  // ── 3. Vendas (Venda diária + VendaMensal) ─────────────────────────────
  //
  // Realidade do ERP actual: `Venda` (diária) está VAZIA. `VendaMensal`
  // é a única fonte de venda hoje. Querymos ambos para detectar a
  // disponibilidade e cair em VendaMensal × 3m / 90 quando Venda diária
  // não tem dados — o mesmo path que `lib/stock-data.ts` já usa.
  const sales30dVenda = await prisma.$queryRawUnsafe<Array<{ produtoId: string; farmaciaId: string; qty: number; valor: number }>>(
    `
    SELECT
      v."produtoId",
      v."farmaciaId",
      SUM(v.quantidade)::float AS qty,
      SUM(v."valorTotal")::float AS valor
    FROM "Venda" v
    WHERE v.data >= NOW() - INTERVAL '30 days'
      AND v."farmaciaId" = ANY($1)
    GROUP BY v."produtoId", v."farmaciaId"
    `,
    farmaciaIds,
  );

  const sales90dVenda = await prisma.$queryRawUnsafe<Array<{ produtoId: string; farmaciaId: string; qty: number; valor: number }>>(
    `
    SELECT
      v."produtoId",
      v."farmaciaId",
      SUM(v.quantidade)::float AS qty,
      SUM(v."valorTotal")::float AS valor
    FROM "Venda" v
    WHERE v.data >= NOW() - INTERVAL '90 days'
      AND v."farmaciaId" = ANY($1)
    GROUP BY v."produtoId", v."farmaciaId"
    `,
    farmaciaIds,
  );

  console.log(`[3/6] Venda diária: 30d=${sales30dVenda.length}  90d=${sales90dVenda.length}  pares com vendas`);
  const vendaDiariaDisponivel = sales90dVenda.length > 0;
  if (!vendaDiariaDisponivel) {
    console.log(`        [aviso] Venda diária VAZIA — médias diárias serão derivadas de VendaMensal (proxy 3m / 90).`);
  }

  // ── 4. Vendas mensais 3m / 12m ─────────────────────────────────────────
  const now = new Date();
  const periodEnd = now.getFullYear() * 12 + now.getMonth() + 1;
  const period3m = periodEnd - 3;
  const period12m = periodEnd - 12;

  const sales3m = await prisma.$queryRawUnsafe<Array<{ produtoId: string; farmaciaId: string; qty: number }>>(
    `
    SELECT
      vm."produtoId",
      vm."farmaciaId",
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

  const sales12m = await prisma.$queryRawUnsafe<Array<{ produtoId: string; farmaciaId: string; qty: number }>>(
    `
    SELECT
      vm."produtoId",
      vm."farmaciaId",
      SUM(vm.quantidade)::float AS qty
    FROM "VendaMensal" vm
    WHERE (vm.ano * 12 + vm.mes) >= $1
      AND (vm.ano * 12 + vm.mes) < $2
      AND vm."farmaciaId" = ANY($3)
    GROUP BY vm."produtoId", vm."farmaciaId"
    `,
    period12m,
    periodEnd,
    farmaciaIds,
  );

  console.log(`[4/6] VendaMensal: 3m=${sales3m.length}  12m=${sales12m.length}`);

  // ── 5. Última compra (preço + fornecedor) ──────────────────────────────
  const lastCompra = await prisma.$queryRawUnsafe<Array<{ produtoId: string; farmaciaId: string; precoUnitario: number | null; fornecedorId: string | null; data: Date }>>(
    `
    WITH ranked AS (
      SELECT
        c."produtoId",
        c."farmaciaId",
        c."precoUnitario"::float AS "precoUnitario",
        c."fornecedorId",
        c.data,
        ROW_NUMBER() OVER (PARTITION BY c."produtoId", c."farmaciaId" ORDER BY c.data DESC) AS rn
      FROM "Compra" c
      WHERE c."farmaciaId" = ANY($1)
    )
    SELECT "produtoId", "farmaciaId", "precoUnitario", "fornecedorId", "data"
    FROM ranked
    WHERE rn = 1
    `,
    farmaciaIds,
  );
  console.log(`[5/6] Compra (última por par): ${lastCompra.length}`);

  // ── 6. Construir indexes ───────────────────────────────────────────────
  const k = (p: string, f: string) => `${p}:${f}`;
  const idx30Venda = new Map(sales30dVenda.map((r) => [k(r.produtoId, r.farmaciaId), r]));
  const idx90Venda = new Map(sales90dVenda.map((r) => [k(r.produtoId, r.farmaciaId), r]));
  const idx3m = new Map(sales3m.map((r) => [k(r.produtoId, r.farmaciaId), r]));
  const idx12m = new Map(sales12m.map((r) => [k(r.produtoId, r.farmaciaId), r]));
  const idxCompra = new Map(lastCompra.map((r) => [k(r.produtoId, r.farmaciaId), r]));

  // Valor de venda 90d para ABC — preferir Venda diária, cair para
  // VendaMensal × valorTotal 3m quando Venda está vazia.
  const sales3mValor = await prisma.$queryRawUnsafe<Array<{ produtoId: string; farmaciaId: string; valor: number }>>(
    `
    SELECT
      vm."produtoId",
      vm."farmaciaId",
      SUM(vm."valorTotal")::float AS valor
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
  const idx3mValor = new Map(sales3mValor.map((r) => [k(r.produtoId, r.farmaciaId), toF(r.valor)]));

  // ── 7. Calcular indicadores por (produto, farmacia) ────────────────────
  console.log(`\n[6/6] A calcular indicadores...`);
  const indicators: Indicator[] = [];
  // Para ABC, precisamos do total de valor 90d POR FARMÁCIA — agrupamos
  // por farmacia e ordenamos descendente para classificação cumulativa.
  const perFarmaciaValuesForABC = new Map<string, Array<{ key: string; valor: number }>>();

  for (const pf of pfRows) {
    const key = k(pf.produtoId, pf.farmaciaId);
    const s30Venda = idx30Venda.get(key);
    const s90Venda = idx90Venda.get(key);
    const s3m = idx3m.get(key);
    const s12m = idx12m.get(key);
    const compra = idxCompra.get(key);

    const sales30dQty = s30Venda ? toF(s30Venda.qty) : 0;
    const sales90dQtyVenda = s90Venda ? toF(s90Venda.qty) : 0;
    const sales3mQty = s3m ? toF(s3m.qty) : 0;
    const sales12mQty = s12m ? toF(s12m.qty) : 0;

    // Cobertura de avgDaily30d e avgDaily90d com fallback VendaMensal.
    // - 30d: se Venda vazia, proxy = VendaMensal × (3m / 90) (mesma
    //   média diária por toda a janela). Não há janela 30d isolada em
    //   VendaMensal.
    // - 90d: se Venda vazia, proxy = VendaMensal × 3m / 90 (idêntico ao
    //   `lib/stock-data.ts` actual).
    const ad30 = vendaDiariaDisponivel
      ? avgDaily(sales30dQty, WINDOW_30D)
      : avgDaily(sales3mQty, WINDOW_90D);
    const ad90 = vendaDiariaDisponivel
      ? avgDaily(sales90dQtyVenda, WINDOW_90D)
      : avgDaily(sales3mQty, WINDOW_90D);
    const mediaMensal3m = sales3mQty / 3;
    const mediaMensal12m = sales12mQty / 12;

    // Valor de venda 90d para ABC — Venda quando disponível, fallback
    // para VendaMensal × valorTotal 3m.
    const valorVenda90d = s90Venda
      ? toF(s90Venda.valor)
      : (idx3mValor.get(key) ?? 0);

    const stockNum = toF(pf.stockAtual);
    const cov = coverageDays(stockNum, ad30); // diasStockRestante usa janela 30d (mais reactivo)
    const dsv = daysSince(pf.dataUltimaVenda);

    // valorStockParado: stock × custo SE diasSemVenda > 90 OU avgDaily90d ≈ 0
    const isParado = (dsv !== null && dsv > 90) || ad90 <= 0;
    const custoUnit = pf.puc ?? pf.pmc ?? 0;
    const valorStockParado = isParado && stockNum > 0 ? Math.round(stockNum * custoUnit * 100) / 100 : 0;

    const rotacao = classifyRotacao(ad90, dsv);

    const indicator: Indicator = {
      produtoId: pf.produtoId,
      farmaciaId: pf.farmaciaId,
      cnp: pf.cnp,
      designacao: pf.designacao,
      mediaVendasDiarias30d: ad30,
      mediaVendasDiarias90d: ad90,
      mediaVendasMensais3m: Math.round(mediaMensal3m * 10000) / 10000,
      mediaVendasMensais12m: Math.round(mediaMensal12m * 10000) / 10000,
      diasStockRestante: cov === null ? null : Math.round(cov * 100) / 100,
      diasSemVenda: dsv,
      ultimoPrecoCompra: compra?.precoUnitario ?? null,
      ultimoFornecedorId: compra?.fornecedorId ?? null,
      valorStockParado: isParado ? valorStockParado : null,
      classificacaoABC: "NAO_CLASSIFICADO", // preenchido na próxima passada
      classificacaoRotacao: rotacao,
      stockAtual: stockNum,
      puc: pf.puc,
      pmc: pf.pmc,
      valorVenda90d,
    };
    indicators.push(indicator);

    // Acumular para ABC
    const list = perFarmaciaValuesForABC.get(pf.farmaciaId) ?? [];
    list.push({ key, valor: valorVenda90d });
    perFarmaciaValuesForABC.set(pf.farmaciaId, list);
  }

  // Atribuir classificacaoABC por farmácia
  const abcByKey = new Map<string, ClassificacaoABC>();
  for (const [, values] of perFarmaciaValuesForABC) {
    values.sort((a, b) => b.valor - a.valor);
    const classification = classifyABCByCumulative(values);
    for (const [k2, v] of classification) abcByKey.set(k2, v);
  }
  for (const ind of indicators) {
    ind.classificacaoABC = abcByKey.get(k(ind.produtoId, ind.farmaciaId)) ?? "NAO_CLASSIFICADO";
  }

  // ── 8. Distribuições / sumário ─────────────────────────────────────────
  console.log("\n" + "═".repeat(78));
  console.log("SUMÁRIO");
  console.log("═".repeat(78));
  console.log(`  total indicadores calculados:  ${indicators.length}`);

  const populaveis = {
    mediaVendasDiarias30d: indicators.filter((i) => (i.mediaVendasDiarias30d ?? 0) > 0).length,
    mediaVendasDiarias90d: indicators.filter((i) => (i.mediaVendasDiarias90d ?? 0) > 0).length,
    mediaVendasMensais3m: indicators.filter((i) => (i.mediaVendasMensais3m ?? 0) > 0).length,
    mediaVendasMensais12m: indicators.filter((i) => (i.mediaVendasMensais12m ?? 0) > 0).length,
    diasStockRestante: indicators.filter((i) => i.diasStockRestante !== null).length,
    diasSemVenda: indicators.filter((i) => i.diasSemVenda !== null).length,
    ultimoPrecoCompra: indicators.filter((i) => i.ultimoPrecoCompra !== null).length,
    ultimoFornecedorId: indicators.filter((i) => i.ultimoFornecedorId !== null).length,
    valorStockParado: indicators.filter((i) => (i.valorStockParado ?? 0) > 0).length,
  };
  console.log(`\n  Campos populáveis (não-zero / não-null):`);
  for (const [campo, n] of Object.entries(populaveis)) {
    const pct = (n / indicators.length) * 100;
    console.log(`    ${campo.padEnd(28)} ${String(n).padStart(6)}  (${pct.toFixed(1)}%)`);
  }

  // ABC
  const abcCounts: Record<ClassificacaoABC, number> = { A: 0, B: 0, C: 0, NAO_CLASSIFICADO: 0 };
  for (const i of indicators) abcCounts[i.classificacaoABC]++;
  console.log(`\n  Distribuição classificacaoABC:`);
  for (const [k2, v] of Object.entries(abcCounts)) {
    const pct = (v / indicators.length) * 100;
    console.log(`    ${k2.padEnd(20)} ${String(v).padStart(6)}  (${pct.toFixed(1)}%)`);
  }

  // Rotação
  const rotacaoCounts: Record<ClassificacaoRotacao, number> = { NORMAL: 0, ATENCAO: 0, SEM_ROTACAO: 0 };
  for (const i of indicators) rotacaoCounts[i.classificacaoRotacao]++;
  console.log(`\n  Distribuição classificacaoRotacao:`);
  for (const [k2, v] of Object.entries(rotacaoCounts)) {
    const pct = (v / indicators.length) * 100;
    console.log(`    ${k2.padEnd(20)} ${String(v).padStart(6)}  (${pct.toFixed(1)}%)`);
  }

  // Histograma mediaVendasDiarias90d (entre os populados)
  const ad90Values = indicators
    .filter((i) => (i.mediaVendasDiarias90d ?? 0) > 0)
    .map((i) => i.mediaVendasDiarias90d!);
  console.log(`\n  Histograma mediaVendasDiarias90d (n=${ad90Values.length}):`);
  for (const b of histogram(ad90Values, [0, 0.05, 0.1, 0.5, 1, 2, 5, 10])) {
    const bar = "█".repeat(Math.min(50, Math.round((b.count / Math.max(1, ad90Values.length)) * 100)));
    console.log(`    ${b.range.padEnd(15)} ${String(b.count).padStart(5)}  ${bar}`);
  }

  // Histograma diasStockRestante
  const dsrValues = indicators
    .filter((i) => i.diasStockRestante !== null && i.diasStockRestante! < 365)
    .map((i) => i.diasStockRestante!);
  console.log(`\n  Histograma diasStockRestante <365 (n=${dsrValues.length}):`);
  for (const b of histogram(dsrValues, [0, 7, 14, 30, 60, 90, 180])) {
    const bar = "█".repeat(Math.min(50, Math.round((b.count / Math.max(1, dsrValues.length)) * 100)));
    console.log(`    ${b.range.padEnd(15)} ${String(b.count).padStart(5)}  ${bar}`);
  }

  // valorStockParado total
  const totalParado = indicators.reduce((s, i) => s + (i.valorStockParado ?? 0), 0);
  const parados = indicators.filter((i) => (i.valorStockParado ?? 0) > 0);
  console.log(`\n  valorStockParado total: ${totalParado.toFixed(2)} €  em ${parados.length} produtos`);

  // ── 9. Comparação com stock-data.ts (sanity check) ─────────────────────
  console.log("\n  Comparação com lib/stock-data.ts (avgDaily90d via VendaMensal vs IPF via Venda diária):");
  const sample = indicators
    .filter((i) => (i.mediaVendasDiarias90d ?? 0) > 0)
    .slice(0, args.compareSample);
  if (sample.length === 0) {
    console.log("    (sem amostra com vendas 90d > 0)");
  } else {
    // Para cada PF da amostra, obter o avgDaily90d como stock-data o calcula:
    // VendaMensal últimos 3m / 90d.
    const sampleKeys = sample.map((i) => `${i.produtoId}::${i.farmaciaId}`);
    const compareVM = await prisma.$queryRawUnsafe<Array<{ produtoId: string; farmaciaId: string; qty: number }>>(
      `
      SELECT vm."produtoId", vm."farmaciaId", SUM(vm.quantidade)::float AS qty
      FROM "VendaMensal" vm
      WHERE (vm.ano * 12 + vm.mes) >= $1
        AND (vm.ano * 12 + vm.mes) < $2
        AND vm."farmaciaId" = ANY($3)
        AND (vm."produtoId" || '::' || vm."farmaciaId") = ANY($4)
      GROUP BY vm."produtoId", vm."farmaciaId"
      `,
      period3m,
      periodEnd,
      farmaciaIds,
      sampleKeys,
    );
    const idxCompareVM = new Map(compareVM.map((r) => [k(r.produtoId, r.farmaciaId), toF(r.qty) / 90]));

    let diffSum = 0;
    let diffMax = 0;
    let agree = 0;
    for (const ind of sample) {
      const vmDaily = idxCompareVM.get(k(ind.produtoId, ind.farmaciaId)) ?? 0;
      const ipfDaily = ind.mediaVendasDiarias90d ?? 0;
      const diff = Math.abs(vmDaily - ipfDaily);
      const rel = vmDaily > 0 ? diff / vmDaily : 0;
      diffSum += diff;
      if (diff > diffMax) diffMax = diff;
      if (rel < 0.05) agree++; // dentro de 5%
    }
    const avgDiff = diffSum / sample.length;
    console.log(`    amostra:                ${sample.length}`);
    console.log(`    agreement (<5% diff):   ${agree} (${((agree / sample.length) * 100).toFixed(0)}%)`);
    console.log(`    diferença média:        ${avgDiff.toFixed(4)} un/dia`);
    console.log(`    diferença máxima:       ${diffMax.toFixed(4)} un/dia`);
    console.log(
      `    (drift esperado: Venda diária é mais preciso que VendaMensal × 90d porque VendaMensal só agrega meses completos)`,
    );
  }

  // ── 10. Amostra detalhada ──────────────────────────────────────────────
  if (args.sample > 0) {
    console.log(`\n  Amostra de ${Math.min(args.sample, indicators.length)} indicadores (CSV):`);
    const fields = [
      "cnp",
      "designacao",
      "farmaciaNome",
      "stockAtual",
      "mediaVendasDiarias30d",
      "mediaVendasDiarias90d",
      "mediaVendasMensais3m",
      "diasStockRestante",
      "diasSemVenda",
      "ultimoPrecoCompra",
      "valorStockParado",
      "classificacaoABC",
      "classificacaoRotacao",
    ];
    console.log("    " + fields.join("|"));
    const samplePicked = indicators
      .filter((i) => (i.mediaVendasDiarias90d ?? 0) > 0)
      .slice(0, args.sample);
    for (const ind of samplePicked) {
      const row: string[] = [
        ind.cnp,
        ind.designacao.slice(0, 32).replace(/\|/g, " "),
        farmaciaNomes.get(ind.farmaciaId) ?? "?",
        String(ind.stockAtual),
        (ind.mediaVendasDiarias30d ?? 0).toFixed(3),
        (ind.mediaVendasDiarias90d ?? 0).toFixed(3),
        (ind.mediaVendasMensais3m ?? 0).toFixed(2),
        ind.diasStockRestante === null ? "∞" : ind.diasStockRestante.toFixed(1),
        String(ind.diasSemVenda ?? "—"),
        ind.ultimoPrecoCompra === null ? "—" : ind.ultimoPrecoCompra.toFixed(2),
        (ind.valorStockParado ?? 0).toFixed(2),
        ind.classificacaoABC,
        ind.classificacaoRotacao,
      ];
      console.log("    " + row.join("|"));
    }
  }

  // ── 11. Top valorStockParado ───────────────────────────────────────────
  if (parados.length > 0) {
    console.log(`\n  Top 10 valorStockParado:`);
    const top = [...parados].sort((a, b) => (b.valorStockParado ?? 0) - (a.valorStockParado ?? 0)).slice(0, 10);
    for (const ind of top) {
      console.log(
        `    ${(ind.valorStockParado ?? 0).toFixed(2)}€  CNP=${ind.cnp}  ` +
          `stock=${ind.stockAtual}  diasSemVenda=${ind.diasSemVenda ?? "—"}  ` +
          `"${ind.designacao.slice(0, 50)}"  (${farmaciaNomes.get(ind.farmaciaId) ?? "?"})`,
      );
    }
  }

  console.log("\n" + "═".repeat(78));
  console.log(`Dry-run concluído em ${((Date.now() - t0) / 1000).toFixed(1)}s. SEM writes.`);
  console.log("═".repeat(78));
}

main()
  .catch((e) => {
    console.error("[fatal]", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
