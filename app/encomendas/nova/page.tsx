import { MainShell } from "@/components/layout/main-shell";
import { requirePermission } from "@/lib/permissions";
import { getPrisma } from "@/lib/prisma";
import { getReportingFilterOptions } from "@/lib/reporting-filter-options";
import { OrderCreateClient } from "@/components/encomendas/order-create-client";

export const dynamic = "force-dynamic";

async function getProductTypes(): Promise<string[]> {
  const prisma = await getPrisma();
  const rows = await prisma.produto.findMany({
    where: { productType: { not: null } },
    select: { productType: true },
    distinct: ["productType"],
    orderBy: { productType: "asc" },
    take: 200,
  });
  return rows
    .map((r) => (r.productType ?? "").trim())
    .filter((s) => s.length > 0);
}

export default async function NovaEncomendaPage() {
  await requirePermission("reports.write");

  const prisma = await getPrisma();
  const [farmacias, filterOptions, productTypes] = await Promise.all([
    prisma.farmacia.findMany({
      where: { estado: "ATIVO" },
      select: { id: true, nome: true },
      orderBy: { nome: "asc" },
    }),
    getReportingFilterOptions(),
    getProductTypes(),
  ]);

  return (
    <MainShell>
      <div className="mx-auto max-w-7xl px-6 py-8">
        <h1 className="text-2xl font-semibold text-gray-900">Nova Encomenda</h1>
        <p className="mt-1 text-sm text-gray-600">
          Defina o período de vendas e os filtros para gerar uma proposta. Pode rever,
          ajustar quantidades, adicionar produtos manuais e finalizar.
        </p>
        <div className="mt-6">
          <OrderCreateClient
            farmacias={farmacias}
            filterOptions={filterOptions}
            productTypes={productTypes}
          />
        </div>
      </div>
    </MainShell>
  );
}
