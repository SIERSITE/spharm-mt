import { getFarmaciasInfo } from "@/lib/farmacias-info";
import { getReportingFilterOptions } from "@/lib/reporting-filter-options";
import { TransferenciasClient } from "@/components/transferencias/transferencias-client";
import { loadTransferenciasRegistadas } from "@/lib/transferencias/registadas-data";
import { getSession } from "@/lib/auth";
import { can } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function TransferenciasPage() {
  const [farmaciasInfo, filterOptions, transferenciasRegistadas, session] = await Promise.all([
    getFarmaciasInfo(),
    getReportingFilterOptions(),
    loadTransferenciasRegistadas(),
    getSession(),
  ]);
  // Mesma gate de `deleteTransferenciaAction` — o botão "Eliminar" na
  // listagem de Transferências reais só aparece a quem a acção aceitaria.
  const podeEliminarTransferencia = can(session, "settings.global");

  return (
    <TransferenciasClient
      farmaciasInfo={farmaciasInfo}
      filterOptions={filterOptions}
      transferenciasRegistadas={transferenciasRegistadas}
      podeEliminarTransferencia={podeEliminarTransferencia}
    />
  );
}
