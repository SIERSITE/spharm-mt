import { getFarmaciasInfo } from "@/lib/farmacias-info";
import { getReportingFilterOptions } from "@/lib/reporting-filter-options";
import { ExcessosClient } from "@/components/excessos/excessos-client";

export const dynamic = "force-dynamic";

export default async function ExcessosPage() {
  const [farmaciasInfo, filterOptions] = await Promise.all([
    getFarmaciasInfo(),
    getReportingFilterOptions(),
  ]);
  return (
    <ExcessosClient farmaciasInfo={farmaciasInfo} filterOptions={filterOptions} />
  );
}
