/**
 * app/relatorios/margens/page.tsx
 *
 * Server Component LEVE. Não pré-carrega Margens. Carrega só os
 * filterOptions canónicos + farmácias activas. O cliente dispara
 * `runMargensReport` ao clicar em "Gerar".
 */
import { getFarmaciasInfo } from "@/lib/farmacias-info";
import { getReportingFilterOptions } from "@/lib/reporting-filter-options";
import { MargensClient } from "@/components/margens/margens-client";

export const dynamic = "force-dynamic";

export default async function MargensPage() {
  const [farmaciasInfo, filterOptions] = await Promise.all([
    getFarmaciasInfo(),
    getReportingFilterOptions(),
  ]);
  return (
    <MargensClient
      farmaciasInfo={farmaciasInfo}
      filterOptions={filterOptions}
    />
  );
}
