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

import { EXCESSO_COVERAGE_DAYS } from "@/lib/operational/metrics-shared";

// ─── Filtros canónicos (partilhados com /stock?filter=… e dashboard) ─────────

export type StockFilter =
  | "out-of-stock"
  | "at-risk"
  | "excess-stock-canonical"
  | "no-movement-3m"
  | "below-min";

export const STOCK_FILTER_LABELS: Record<StockFilter, string> = {
  "out-of-stock": "Em rotura (com vendas recentes)",
  "at-risk": "Em risco (cobertura < 7 dias)",
  "excess-stock-canonical": `Excesso de stock (cobertura > ${EXCESSO_COVERAGE_DAYS} dias)`,
  "no-movement-3m": "Sem movimento (90 dias)",
  "below-min": "Abaixo do stock mínimo",
};

export function isStockFilter(v: unknown): v is StockFilter {
  return (
    v === "out-of-stock" ||
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

export function matchStockFilter(row: StockRowEnriched, filter: StockFilter): boolean {
  switch (filter) {
    case "out-of-stock":
      return row.stockAtual <= 0 && row.salesQty90d > 0;
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
