import { getFarmaciasInfo } from "@/lib/farmacias-info";
import { getReportingFilterOptions } from "@/lib/reporting-filter-options";
import { TransferenciasClient } from "@/components/transferencias/transferencias-client";

export default async function TransferenciasPage() {
  const [farmaciasInfo, filterOptions] = await Promise.all([
    getFarmaciasInfo(),
    getReportingFilterOptions(),
  ]);
  return (
    <TransferenciasClient farmaciasInfo={farmaciasInfo} filterOptions={filterOptions} />
  );
}
