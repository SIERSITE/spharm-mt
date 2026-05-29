/**
 * app/relatorios/inventario/page.tsx
 *
 * Server Component LEVE. Não pré-carrega Inventário — esse dataset é
 * pesado e só faz sentido após o utilizador parametrizar os filtros e
 * clicar em "Gerar". Carrega apenas:
 *   · farmácias activas (filtro + cabeçalho)
 *   · opções dos filtros canónicos (categorias, fabricantes, distribuidores)
 *
 * O fetch real corre via server action `runInventarioReport`.
 */
import { getFarmaciasInfo } from "@/lib/farmacias-info";
import { getReportingFilterOptions } from "@/lib/reporting-filter-options";
import { InventarioClient } from "@/components/inventario/inventario-client";

export const dynamic = "force-dynamic";

export default async function InventarioPage() {
  const [farmaciasInfo, filterOptions] = await Promise.all([
    getFarmaciasInfo(),
    getReportingFilterOptions(),
  ]);
  return (
    <InventarioClient
      farmaciasInfo={farmaciasInfo}
      filterOptions={filterOptions}
    />
  );
}
