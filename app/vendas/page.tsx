import { getFarmaciasInfo } from "@/lib/farmacias-info";
import { getReportingFilterOptions } from "@/lib/reporting-filter-options";
import { VendasClient } from "@/components/vendas/vendas-client";

// Nunca prerender no build — os dados do relatório são tenant-scoped
// e o build do Vercel não tem acesso útil à BD de produção durante
// o trial render estático. Força dynamic rendering em cada request.
export const dynamic = "force-dynamic";

/**
 * Página Vendas — server component LEVE.
 *
 * Não pré-carrega rows de VendaMensal. Carrega apenas:
 *  · farmácias activas  → filtro de farmácia e cabeçalho do relatório
 *  · opções dos filtros → fornecedor / fabricante / categoria (DISTINCTs
 *                         sobre ProdutoFarmacia / Fabricante / Classificacao)
 *
 * O fetch real das linhas corre via server action `runVendasReport`
 * quando o utilizador clica em "Gerar" no client component.
 */
export default async function VendasPage() {
  const [farmaciasInfo, filterOptions] = await Promise.all([
    getFarmaciasInfo(),
    getReportingFilterOptions(),
  ]);
  return (
    <VendasClient farmaciasInfo={farmaciasInfo} filterOptions={filterOptions} />
  );
}
