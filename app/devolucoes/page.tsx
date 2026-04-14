import { getFarmaciasInfo } from "@/lib/farmacias-info";
import { getReportingFilterOptions } from "@/lib/reporting-filter-options";
import { DevolucoesClient } from "@/components/devolucoes/devolucoes-client";

export const dynamic = "force-dynamic";

export default async function DevolucoesPage() {
  const [farmaciasInfo, filterOptions] = await Promise.all([
    getFarmaciasInfo(),
    getReportingFilterOptions(),
  ]);
  return (
    <DevolucoesClient farmaciasInfo={farmaciasInfo} filterOptions={filterOptions} />
  );
}
