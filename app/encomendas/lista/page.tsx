import { MainShell } from "@/components/layout/main-shell";
import { requirePermission } from "@/lib/permissions";
import { loadOrderListData } from "@/lib/encomendas/orders-data";
import { OrderListClient } from "@/components/encomendas/order-list-client";

export const dynamic = "force-dynamic";

export default async function ListaEncomendasPage() {
  await requirePermission("reports.write");
  const data = await loadOrderListData();

  return (
    <MainShell>
      <div className="mx-auto max-w-6xl px-6 py-8">
        <h1 className="text-2xl font-semibold text-gray-900">Encomendas</h1>
        <p className="mt-1 text-sm text-gray-600">
          Lista de encomendas criadas. Finalize rascunhos, acompanhe o estado de exportação e
          simule respostas do agent.
        </p>
        <div className="mt-6">
          <OrderListClient data={data} />
        </div>
      </div>
    </MainShell>
  );
}
