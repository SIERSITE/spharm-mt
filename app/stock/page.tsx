import { getStockData, isStockFilter, type StockFilter } from "@/lib/stock-data";
import { StockClient } from "@/components/stock/stock-client";

export const dynamic = "force-dynamic";

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function asString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

export default async function StockPage({ searchParams }: Props) {
  const sp = await searchParams;
  const raw = asString(sp.filter);
  const filter: StockFilter | undefined = isStockFilter(raw) ? raw : undefined;

  const { rows, pharmacyNames, metrics, filter: appliedFilter } =
    await getStockData(filter);

  return (
    <StockClient
      initialRows={rows}
      pharmacyNames={pharmacyNames}
      metrics={metrics}
      activeFilter={appliedFilter}
    />
  );
}
