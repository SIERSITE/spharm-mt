import {
  getStockData,
  isStockFilter,
  isStockCoverageBucket,
  isStockStatus,
  clampStockPage,
  clampStockPageSize,
  STOCK_DEFAULT_PAGE_SIZE,
  type StockFilter,
  type StockSearchParams,
  type StockCoverageBucket,
  type StockRow,
} from "@/lib/stock-data";
import { StockClient } from "@/components/stock/stock-client";

export const dynamic = "force-dynamic";

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function asString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function asArray(v: string | string[] | undefined): string[] {
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string" && x.length > 0);
  if (typeof v === "string" && v.length > 0) {
    return v.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  }
  return [];
}

function parseParams(sp: Record<string, string | string[] | undefined>): StockSearchParams {
  const rawFilter = asString(sp.filter);
  const filter: StockFilter | undefined = isStockFilter(rawFilter) ? rawFilter : undefined;

  const coverageRaw = asArray(sp.coverage);
  const coverageBuckets: StockCoverageBucket[] = coverageRaw.filter(isStockCoverageBucket);

  const statusRaw = asArray(sp.status);
  const statusBuckets: StockRow["status"][] = statusRaw.filter(isStockStatus);

  return {
    q: asString(sp.q)?.trim() || undefined,
    pharmacies: asArray(sp.pharmacy),
    coverageBuckets,
    statusBuckets,
    filter,
    // Nomes novos e distintos: `categoria` é o nível 1, `subcategoria` o
    // nível 2, `utilizacao` viaja em slug. Os parâmetros já existentes
    // não mudam de nome nem de significado.
    categorias: asArray(sp.categoria),
    subcategorias: asArray(sp.subcategoria),
    utilizacoes: asArray(sp.utilizacao),
    page: clampStockPage(Number(asString(sp.page) ?? 1)),
    pageSize: clampStockPageSize(Number(asString(sp.pageSize) ?? STOCK_DEFAULT_PAGE_SIZE)),
  };
}

export default async function StockPage({ searchParams }: Props) {
  const sp = await searchParams;
  const params = parseParams(sp);
  const data = await getStockData(params);

  return <StockClient data={data} />;
}
