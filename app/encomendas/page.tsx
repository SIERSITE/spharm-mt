import { getFarmaciasInfo } from "@/lib/farmacias-info";
import { getReportingFilterOptions } from "@/lib/reporting-filter-options";
import { EncomendasClient } from "@/components/encomendas/encomendas-client";

export const dynamic = "force-dynamic";

export default async function EncomendasPage() {
  const [farmaciasInfo, filterOptions] = await Promise.all([
    getFarmaciasInfo(),
    getReportingFilterOptions(),
  ]);
  return (
    <EncomendasClient farmaciasInfo={farmaciasInfo} filterOptions={filterOptions} />
  );
}
