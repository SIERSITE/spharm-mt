import { getStockData } from "@/lib/stock-data";
import { StockClient } from "@/components/stock/stock-client";

export default async function StockPage() {
  const { rows, pharmacyNames, metrics } = await getStockData();
  return (
    <StockClient initialRows={rows} pharmacyNames={pharmacyNames} metrics={metrics} />
  );
}
