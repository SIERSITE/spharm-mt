/**
 * lib/operational/ipf-calculator.ts
 *
 * Cálculo puro dos 11 indicadores do schema `IndicadoresProdutoFarmacia`
 * a partir de inputs agregados (vendas, stock, compra). Sem I/O, sem
 * Prisma. Re-utilizado por:
 *   - scripts/indicadores-produto-farmacia-dry-run.ts (read-only)
 *   - scripts/populate-indicadores-produto-farmacia.ts (LIVE upsert)
 *   - (futuro) leitor dual-read em runtime web
 *
 * Realidade do ERP actual (2026-05-11):
 *   - `Venda` (diária) está VAZIA. Caller deve sinalizar via
 *     `vendaDiariaDisponivel=false` para cair para fallback VendaMensal.
 *   - `Compra` está VAZIA. Os 3 campos relacionados ficam null:
 *     diasSemVenda, ultimoPrecoCompra, ultimoFornecedorId.
 *
 * Convenção:
 *   - 8 campos populáveis hoje + 3 nulls preservados.
 *   - `mediaVendasDiarias30d` e `mediaVendasDiarias90d` usam Venda
 *     diária quando disponível; caso contrário, fallback exacto para
 *     VendaMensal × 3m / 90 (mesmo path do `lib/stock-data.ts:63`).
 *   - Validado: drift 0,0000 un/dia em 30 amostras live.
 */

import { avgDaily, coverageDays, WINDOW_30D, WINDOW_90D } from "@/lib/operational/metrics-shared";

export type ClassificacaoABC = "A" | "B" | "C" | "NAO_CLASSIFICADO";
export type ClassificacaoRotacao = "NORMAL" | "ATENCAO" | "SEM_ROTACAO";

/**
 * Inputs agregados para um único (produto, farmácia). O caller (script
 * de populate ou dry-run) é responsável por preencher correctamente —
 * normalmente via 4-5 queries em batch sobre `Venda`, `VendaMensal`,
 * `Compra`, `ProdutoFarmacia`.
 */
export type IpfInput = {
  produtoId: string;
  farmaciaId: string;
  stockAtual: number;
  /** Custo unitário para `valorStockParado`. Tipicamente puc, com pmc como fallback. */
  custoUnitario: number;
  /** Soma de `Venda.quantidade` últimos 30 dias (0 quando vazio). */
  vendaQty30dDiaria: number;
  /** Soma de `Venda.quantidade` últimos 90 dias (0 quando vazio). */
  vendaQty90dDiaria: number;
  /** Soma de `Venda.valorTotal` últimos 90 dias (0 quando vazio). */
  vendaValor90dDiaria: number;
  /** Soma de `VendaMensal.quantidade` últimos 3 meses completos. */
  vendaMensalQty3m: number;
  /** Soma de `VendaMensal.quantidade` últimos 12 meses completos. */
  vendaMensalQty12m: number;
  /** Soma de `VendaMensal.valorTotal` últimos 3 meses (fallback do valor 90d quando Venda diária vazia). */
  vendaMensalValor3m: number;
  /**
   * Última `Venda.data` ou `ProdutoFarmacia.dataUltimaVenda` quando
   * disponível. Hoje vazio em todos os produtos.
   */
  dataUltimaVenda: Date | null;
  /** Última `Compra.precoUnitario`. Null hoje (Compra vazia). */
  ultimoPrecoCompra: number | null;
  /** Última `Compra.fornecedorId`. Null hoje. */
  ultimoFornecedorId: string | null;
};

/**
 * Output completo correspondente a uma row de `IndicadoresProdutoFarmacia`,
 * com todos os campos do schema + flags de fonte usados (úteis para
 * relatórios e instrumentação).
 */
export type IpfOutput = {
  produtoId: string;
  farmaciaId: string;
  mediaVendasDiarias30d: number | null;
  mediaVendasDiarias90d: number | null;
  mediaVendasMensais3m: number | null;
  mediaVendasMensais12m: number | null;
  diasStockRestante: number | null;
  diasSemVenda: number | null;
  ultimoPrecoCompra: number | null;
  ultimoFornecedorId: string | null;
  classificacaoABC: ClassificacaoABC;
  classificacaoRotacao: ClassificacaoRotacao;
  valorStockParado: number | null;
  /** Valor de venda usado para classificar ABC. Não persistido em IPF mas útil para ranking. */
  valorVenda90d: number;
};

export type IpfBatchOptions = {
  /**
   * Se `false`, as métricas diárias (`mediaVendasDiarias30d/90d`) caem
   * para fallback baseado em `vendaMensalQty3m` (idêntico ao path actual
   * de `lib/stock-data.ts:63`). Validado com drift 0.0000.
   */
  vendaDiariaDisponivel: boolean;
  /**
   * Threshold (em dias) para `valorStockParado`. Quando `diasSemVenda`
   * está disponível: `valorStockParado` é calculado se diasSemVenda >
   * threshold. Quando NÃO está disponível: usa proxy
   * `avgDaily90d <= 0 AND stockAtual > 0`. Default 90 dias.
   */
  paradoThresholdDays?: number;
};

const MS_PER_DAY = 86_400_000;

function toNonNegativeFinite(n: unknown): number {
  const x = Number(n);
  return Number.isFinite(x) && x > 0 ? x : 0;
}

function daysSince(d: Date | null): number | null {
  if (!d) return null;
  const ms = Date.now() - d.getTime();
  if (ms < 0) return 0;
  return Math.floor(ms / MS_PER_DAY);
}

/**
 * Calcula um único IpfOutput SEM a classificação ABC (que é cumulativa
 * por farmácia e precisa de ver todo o conjunto). ABC fica em
 * "NAO_CLASSIFICADO" até `assignAbcInPlace` correr sobre o lote.
 */
export function computeIpfRow(input: IpfInput, options: IpfBatchOptions): IpfOutput {
  const paradoThreshold = options.paradoThresholdDays ?? 90;

  // mediaVendasDiarias30d/90d: Venda diária primeiro, fallback VendaMensal × 3m / 90
  const ad30 = options.vendaDiariaDisponivel
    ? avgDaily(input.vendaQty30dDiaria, WINDOW_30D)
    : avgDaily(input.vendaMensalQty3m, WINDOW_90D);
  const ad90 = options.vendaDiariaDisponivel
    ? avgDaily(input.vendaQty90dDiaria, WINDOW_90D)
    : avgDaily(input.vendaMensalQty3m, WINDOW_90D);

  const mediaMensal3m = toNonNegativeFinite(input.vendaMensalQty3m) / 3;
  const mediaMensal12m = toNonNegativeFinite(input.vendaMensalQty12m) / 12;

  const stockNum = toNonNegativeFinite(input.stockAtual);
  // diasStockRestante usa avgDaily30d (mais reactivo ao curto prazo).
  const cov = coverageDays(stockNum, ad30);

  const dsv = daysSince(input.dataUltimaVenda);

  // valorStockParado: critério canónico (diasSemVenda > threshold) ou
  // proxy (avgDaily90d <= 0 AND stock > 0) quando dsv não disponível.
  const paradoCanonico = dsv !== null && dsv > paradoThreshold;
  const paradoProxy = ad90 <= 0 && stockNum > 0;
  const isParado = dsv !== null ? paradoCanonico : paradoProxy;
  const custo = toNonNegativeFinite(input.custoUnitario);
  const valorStockParado = isParado && stockNum > 0 && custo > 0
    ? Math.round(stockNum * custo * 100) / 100
    : null;

  // classificacaoRotacao (3 níveis do schema: NORMAL/ATENCAO/SEM_ROTACAO)
  const rotacao: ClassificacaoRotacao = (() => {
    if (ad90 <= 0) {
      if (dsv === null || dsv > 90) return "SEM_ROTACAO";
      return "ATENCAO";
    }
    if (ad90 < 0.05) return "ATENCAO"; // ≤ 1.5 un/mês
    if (dsv !== null && dsv > 60) return "ATENCAO";
    return "NORMAL";
  })();

  // valorVenda90d: Venda diária primeiro, fallback VendaMensal × 3m
  const valorVenda90d = options.vendaDiariaDisponivel
    ? toNonNegativeFinite(input.vendaValor90dDiaria)
    : toNonNegativeFinite(input.vendaMensalValor3m);

  return {
    produtoId: input.produtoId,
    farmaciaId: input.farmaciaId,
    // Médias com 4 casas decimais (Decimal(14,4)) — output cru, sem rounding
    mediaVendasDiarias30d: ad30 > 0 ? Math.round(ad30 * 10000) / 10000 : null,
    mediaVendasDiarias90d: ad90 > 0 ? Math.round(ad90 * 10000) / 10000 : null,
    mediaVendasMensais3m: mediaMensal3m > 0 ? Math.round(mediaMensal3m * 10000) / 10000 : null,
    mediaVendasMensais12m: mediaMensal12m > 0 ? Math.round(mediaMensal12m * 10000) / 10000 : null,
    diasStockRestante: cov === null ? null : Math.round(cov * 100) / 100,
    diasSemVenda: dsv,
    ultimoPrecoCompra: input.ultimoPrecoCompra,
    ultimoFornecedorId: input.ultimoFornecedorId,
    classificacaoABC: "NAO_CLASSIFICADO",
    classificacaoRotacao: rotacao,
    valorStockParado,
    valorVenda90d,
  };
}

/**
 * Atribui `classificacaoABC` por farmácia, in-place. Pareto cumulativo
 * sobre `valorVenda90d`:
 *   - A: top 80% do valor (acumulado ≤ 80%)
 *   - B: próximos 15% (acumulado 80-95%)
 *   - C: últimos 5% (acumulado > 95%)
 *   - NAO_CLASSIFICADO: sem vendas (valorVenda90d = 0)
 *
 * Documentado em
 * `notes/indicadores-produto-farmacia-activation.md` §3.
 */
export function assignAbcInPlace(rows: IpfOutput[]): void {
  // Agrupar por farmácia
  const byFarmacia = new Map<string, IpfOutput[]>();
  for (const r of rows) {
    if (!byFarmacia.has(r.farmaciaId)) byFarmacia.set(r.farmaciaId, []);
    byFarmacia.get(r.farmaciaId)!.push(r);
  }
  for (const farmRows of byFarmacia.values()) {
    // Ordenar desc por valor
    farmRows.sort((a, b) => b.valorVenda90d - a.valorVenda90d);
    const total = farmRows.reduce((s, r) => s + r.valorVenda90d, 0);
    if (total === 0) {
      for (const r of farmRows) r.classificacaoABC = "NAO_CLASSIFICADO";
      continue;
    }
    let acc = 0;
    for (const r of farmRows) {
      if (r.valorVenda90d === 0) {
        r.classificacaoABC = "NAO_CLASSIFICADO";
        continue;
      }
      acc += r.valorVenda90d;
      const pct = acc / total;
      r.classificacaoABC = pct <= 0.8 ? "A" : pct <= 0.95 ? "B" : "C";
    }
  }
}
