import { getFarmaciasInfo } from "@/lib/farmacias-info";
import { getReportingFilterOptions } from "@/lib/reporting-filter-options";
import { TransferenciasClient } from "@/components/transferencias/transferencias-client";
import { loadTransferenciasRegistadas } from "@/lib/transferencias/registadas-data";
import { can, requirePermission } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function TransferenciasPage() {
  // Mesma permissão de /encomendas e de createInternalTransferAction —
  // Transferências é a mesma área de decisão (gerar ordens/encomendas),
  // não uma área à parte com regras próprias. Antes desta correcção a
  // página não tinha NENHUMA gate própria (só lia a sessão com
  // getSession(), sem exigir nada) — qualquer conta autenticada,
  // mesmo sem "reports.write", conseguia ver a página inteira.
  const session = await requirePermission("reports.write");
  const [farmaciasInfo, filterOptions, transferenciasRegistadas] = await Promise.all([
    getFarmaciasInfo(),
    getReportingFilterOptions(),
    loadTransferenciasRegistadas(),
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
