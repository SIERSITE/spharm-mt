/**
 * lib/stock-shared.ts
 *
 * Surface partilhada cliente/servidor para os filtros de stock.
 *
 * Este ficheiro NÃO importa Prisma, `server-only`, nem outros módulos
 * exclusivamente do servidor. Pode portanto ser importado por
 * Client Components — em particular por `components/stock/stock-client.tsx`,
 * que precisa de tipos e dos labels para mostrar o filtro activo.
 *
 * Os loaders que tocam a BD ficam em `lib/stock-data.ts` (server-only).
 * Esse ficheiro re-exporta tudo o que está aqui, para que callers do
 * servidor possam continuar a importar de um único sítio se preferirem.
 */

import {
  ROTURA_LABELS,
  classificarRotura,
  semStockComProcura,
} from "@/lib/operational/rotura";
import { EXCESSO_COVERAGE_DAYS } from "@/lib/operational/metrics-shared";

// ─── Filtros canónicos (partilhados com /stock?filter=… e dashboard) ─────────

export type StockFilter =
  | "out-of-stock"
  | "rotura-critica"
  | "sem-stock-ocasional"
  | "sem-stock-sem-procura"
  | "at-risk"
  | "excess-stock-canonical"
  | "no-movement-3m"
  | "below-min";

export const STOCK_FILTER_LABELS: Record<StockFilter, string> = {
  // O nome antigo dizia "Em rotura" e o parêntesis já admitia que a
  // regra era mais larga do que o nome. Passa a chamar-se o que é.
  "out-of-stock": "Sem stock (todos)",
  "rotura-critica": ROTURA_LABELS.CRITICA,
  "sem-stock-ocasional": ROTURA_LABELS.OCASIONAL,
  "sem-stock-sem-procura": ROTURA_LABELS.SEM_PROCURA,
  "at-risk": "Em risco (cobertura < 7 dias)",
  "excess-stock-canonical": `Excesso de stock (cobertura > ${EXCESSO_COVERAGE_DAYS} dias)`,
  "no-movement-3m": "Sem movimento (90 dias)",
  "below-min": "Abaixo do stock mínimo",
};

export function isStockFilter(v: unknown): v is StockFilter {
  return (
    v === "out-of-stock" ||
    v === "rotura-critica" ||
    v === "sem-stock-ocasional" ||
    v === "sem-stock-sem-procura" ||
    v === "at-risk" ||
    v === "excess-stock-canonical" ||
    v === "no-movement-3m" ||
    v === "below-min"
  );
}

// ─── Linha enriquecida (consumida por loaders e por testes) ──────────────────

export type StockRowEnriched = {
  produtoId: string;
  farmaciaId: string;
  farmaciaNome: string;
  cnp: string;
  designacao: string;
  stockAtual: number;
  stockMinimo: number | null;
  pvp: number | null;
  puc: number | null;
  pmc: number | null;
  dataUltimaVenda: Date | null;
  /** Quantidade vendida nos últimos 3 meses (VendaMensal). */
  salesQty90d: number;
  /**
   * Meses distintos com venda na janela de 12 meses.
   *
   * Alimenta o ramo da recorrência da classificação de rotura. É uma
   * janela LONGA de propósito: a recorrência precisa de horizonte, a
   * procura activa precisa de recência, e são medidas diferentes.
   */
  mesesComVenda12M: number;
  /** salesQty90d / 90. */
  avgDaily90d: number;
  /** stockAtual / avgDaily90d. null quando avgDaily=0 (sem demanda mensurável). */
  coverage: number | null;
  // Enriquecimento clínico — surfaced em tooltip na UI.
  dci: string | null;
  codigoATC: string | null;
  // Catálogo. Nível 1 e nível 2 são níveis DIFERENTES — ver
  // `lib/categoria-resolver.ts`.
  categoria: string;
  subcategoria: string;
  productType: string | null;
  /** Slugs das utilizações do produto. */
  utilizacoes: string[];
};

// ─── Predicado pura — sem I/O, sem Prisma. Re-utilizável em qualquer lado. ───

export function matchStockFilter(
  row: StockRowEnriched,
  filter: StockFilter,
  /**
   * "Agora", para os filtros que dependem da recência da última venda.
   * Injectável para que um teste possa fixar o relógio — um predicado
   * cujo resultado muda ao meio-dia não é testável.
   */
  agora: number = Date.now(),
): boolean {
  switch (filter) {
    case "out-of-stock":
      // A regra ANTIGA, preservada. Continua a ser o universo total de
      // "sem stock com alguma procura" — os três níveis abaixo são a
      // sua partição.
      return semStockComProcura(row);
    case "rotura-critica":
      return classificarRotura(row, agora) === "CRITICA";
    case "sem-stock-ocasional":
      return classificarRotura(row, agora) === "OCASIONAL";
    case "sem-stock-sem-procura":
      // Só as que TÊM alguma procura histórica entram aqui; um artigo
      // que nunca vendeu não é "sem procura recente", é catálogo morto,
      // e tem o seu próprio filtro (`no-movement-3m`).
      return semStockComProcura(row) && classificarRotura(row, agora) === "SEM_PROCURA";
    case "at-risk":
      return row.stockAtual > 0 && row.coverage != null && row.coverage < 7;
    case "excess-stock-canonical":
      return row.coverage != null && row.coverage > EXCESSO_COVERAGE_DAYS;
    case "no-movement-3m":
      return row.stockAtual > 0 && row.salesQty90d <= 0;
    case "below-min":
      return (
        row.stockMinimo != null &&
        row.stockMinimo > 0 &&
        row.stockAtual <= row.stockMinimo
      );
  }
}

// ─── Shape legado consumida pelo client de /stock ────────────────────────────

export type StockRow = {
  product: string;
  cnp: string;
  pharmacy: string;
  stock: number;
  coverage: string;
  rotation: string;
  lastMovement: string;
  status: "Estável" | "Baixa cobertura" | "Parado" | "Transferência sugerida";
  suggestion?: string;
  // Enriquecimento clínico — surfaced em tooltip na UI.
  dci?: string | null;
  codigoATC?: string | null;
  // Catálogo — mostrado na linha e usado pelos filtros.
  categoria?: string;
  subcategoria?: string;
  productType?: string | null;
  utilizacoes?: string[];
};

export type StockMetrics = {
  referencias: number;
  baixaCobertura: number;
  stockParado: number;
  transferencias: number;
};
