/**
 * lib/transfers/internal-substitution.ts
 *
 * Detecção de "substituição operacional interna": para cada produto que
 * está em ruptura iminente numa farmácia, procura se EXISTE STOCK do
 * MESMO CNP noutra farmácia do grupo onde haja excesso, e calcula quanta
 * quantidade pode ser transferida em segurança (preservando uma reserva
 * mínima na origem).
 *
 * Pure function — sem I/O, sem Prisma. Toma rows já hidratados pelo
 * caller (tipicamente `loadPfAndSales`) e produz candidates. Reutiliza
 * `avgDaily` / `coverageDays` de `lib/operational/metrics-shared`.
 *
 * Quando há vários candidatos na origem, escolhe **o que mais excesso
 * tem (maior cobertura)** — política simples e auditável.
 *
 * NÃO altera o comportamento de `getTransferenciasData` legacy (que usa
 * a heurística ratio 2.5:1 com cobertura > 20d). Este módulo é um path
 * adicional, focado no caso de "ruptura iminente + excesso noutra
 * farmácia" — mais agressivo na origem, mais conservador no destino.
 */

import {
  avgDaily,
  coverageDays,
  WINDOW_90D,
} from "@/lib/operational/metrics-shared";

/** Row genérica que o detector consume — campos mínimos. */
export type SubstitutionInput = {
  produtoId: string;
  farmaciaId: string;
  farmaciaNome: string;
  cnp: string;
  designacao: string;
  stockAtual: number;
  /** Custo unitário, usado em `avoidedPurchaseEstimate`. Null = 0 €. */
  puc: number | null;
  /** Soma de vendas na janela (default 90d). */
  salesQty: number;
};

export type SubstitutionOptions = {
  /**
   * Cobertura abaixo da qual o destino é considerado "em ruptura
   * iminente". Default 7 dias.
   */
  ruptureThresholdDays?: number;
  /**
   * Cobertura acima da qual a origem é considerada "com excesso". Default
   * 30 dias (alinhado com Excessos default).
   */
  excessThresholdDays?: number;
  /**
   * Cobertura-alvo para o destino após a transferência. Default 15 dias.
   */
  targetCoverageDays?: number;
  /**
   * Dias de cobertura a preservar na origem (reserva). Default 14 dias.
   * Garante que a transferência não cria nova ruptura na origem.
   */
  reserveDaysSource?: number;
  /**
   * Quantidade mínima a transferir para o candidato ser produzido.
   * Abaixo desta quantidade não vale a pena uma transferência física.
   * Default 1.
   */
  minTransferableQty?: number;
  /**
   * Janela usada para calcular avgDaily — pode ser sobrescrita para
   * testes. Default WINDOW_90D (90).
   */
  windowDays?: number;
};

export type InternalSubstitution = {
  produtoId: string;
  cnp: string;
  designacao: string;

  /** Farmácia que precisa do stock. */
  destinoFarmaciaId: string;
  destinoFarmaciaNome: string;
  destinoStock: number;
  /** Cobertura actual na farmácia destino, em dias. null = sem demanda. */
  stockCoverageDestination: number | null;

  /** Farmácia sugerida como origem da transferência (mesmo CNP). */
  suggestedSourceFarmaciaId: string;
  suggestedSourceFarmaciaNome: string;
  sourceStock: number;
  /** Cobertura na farmácia origem, em dias. Sempre finita (excesso). */
  stockCoverageOrigin: number;

  /**
   * Quantidade que pode ser transferida em segurança. Calculada como
   * min(sourceExcess, destinoNeed), arredondada para baixo.
   */
  transferableQty: number;

  /**
   * Valor estimado da encomenda evitada: `transferableQty × destinoPuc`
   * (ou sourcePuc se destinoPuc indisponível). 0 € quando não há custo
   * conhecido. Informativo — não bloqueia decisão.
   */
  avoidedPurchaseEstimate: number;
};

/**
 * Encontra candidatos de substituição interna no input.
 *
 * Algoritmo:
 *   1. Calcula `avgDaily` e `coverage` para cada row.
 *   2. Agrupa por `produtoId` (mesmo CNP).
 *   3. Para cada produto, separa rows em rupturas iminentes
 *      (`coverage < ruptureThresholdDays`) e em excesso
 *      (`coverage > excessThresholdDays`).
 *   4. Para cada par (ruptura × excesso), escolhe a origem com maior
 *      cobertura e produz 1 candidato por destino-em-ruptura. Se a
 *      transferência viável for inferior a `minTransferableQty`,
 *      descarta.
 */
export function findInternalSubstitutions(
  input: SubstitutionInput[],
  options: SubstitutionOptions = {},
): InternalSubstitution[] {
  const ruptureThreshold = options.ruptureThresholdDays ?? 7;
  const excessThreshold = options.excessThresholdDays ?? 30;
  const targetCoverage = options.targetCoverageDays ?? 15;
  const reserveDays = options.reserveDaysSource ?? 14;
  const minQty = Math.max(1, options.minTransferableQty ?? 1);
  const windowDays = options.windowDays ?? WINDOW_90D;

  // Index por produtoId
  type Enriched = SubstitutionInput & {
    avgDaily: number;
    coverage: number | null;
  };
  const byProduto = new Map<string, Enriched[]>();
  for (const r of input) {
    const ad = avgDaily(r.salesQty, windowDays);
    const cov = coverageDays(r.stockAtual, ad);
    if (!byProduto.has(r.produtoId)) byProduto.set(r.produtoId, []);
    byProduto.get(r.produtoId)!.push({ ...r, avgDaily: ad, coverage: cov });
  }

  const results: InternalSubstitution[] = [];

  for (const entries of byProduto.values()) {
    if (entries.length < 2) continue; // precisa ≥ 2 farmácias para haver transferência

    const ruptures = entries.filter(
      (e) => e.coverage !== null && e.coverage < ruptureThreshold && e.avgDaily > 0,
    );
    if (ruptures.length === 0) continue;

    const excesses = entries.filter(
      (e) => e.coverage !== null && e.coverage > excessThreshold,
    );
    if (excesses.length === 0) continue;

    for (const destino of ruptures) {
      // Candidates a origem: excessos noutra farmácia
      const sources = excesses.filter((e) => e.farmaciaId !== destino.farmaciaId);
      if (sources.length === 0) continue;

      // Escolhe a origem com maior cobertura (mais excesso = mais
      // resiliente a ceder unidades).
      const source = sources.reduce((best, cur) =>
        (cur.coverage ?? 0) > (best.coverage ?? 0) ? cur : best,
      );

      // Quantidades a transferir:
      //   · sourceExcess: stock da origem além da reserva mínima
      //   · destinoNeed:  qtd necessária para subir destino até target
      const sourceReserveStock = Math.max(0, reserveDays * source.avgDaily);
      const sourceExcess = Math.max(0, source.stockAtual - sourceReserveStock);
      const destinoNeed = Math.max(
        0,
        (targetCoverage - (destino.coverage ?? 0)) * destino.avgDaily,
      );
      const transferableQty = Math.floor(Math.min(sourceExcess, destinoNeed));

      if (transferableQty < minQty) continue;

      // avoidedPurchaseEstimate em € — usa puc do destino se disponível,
      // caso contrário cai no puc da origem (cost-of-goods proxy).
      const unitCost = destino.puc ?? source.puc ?? 0;
      const avoidedPurchaseEstimate = Math.round(transferableQty * unitCost * 100) / 100;

      results.push({
        produtoId: destino.produtoId,
        cnp: destino.cnp,
        designacao: destino.designacao,

        destinoFarmaciaId: destino.farmaciaId,
        destinoFarmaciaNome: destino.farmaciaNome,
        destinoStock: Math.round(destino.stockAtual),
        stockCoverageDestination: destino.coverage,

        suggestedSourceFarmaciaId: source.farmaciaId,
        suggestedSourceFarmaciaNome: source.farmaciaNome,
        sourceStock: Math.round(source.stockAtual),
        stockCoverageOrigin: source.coverage ?? 0,

        transferableQty,
        avoidedPurchaseEstimate,
      });
    }
  }

  // Ordenar: maior poupança primeiro, depois cobertura destino mais baixa
  results.sort((a, b) => {
    if (b.avoidedPurchaseEstimate !== a.avoidedPurchaseEstimate) {
      return b.avoidedPurchaseEstimate - a.avoidedPurchaseEstimate;
    }
    const ca = a.stockCoverageDestination ?? 0;
    const cb = b.stockCoverageDestination ?? 0;
    return ca - cb;
  });

  return results;
}
