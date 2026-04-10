import { getVendasData } from "@/lib/vendas-data";
import { VendasClient } from "@/components/vendas/vendas-client";

export default async function VendasPage() {
  const rows = await getVendasData();
  return <VendasClient initialRows={rows} />;
}
