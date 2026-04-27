import { MainShell } from "@/components/layout/main-shell";
import { requirePermission } from "@/lib/permissions";
import { getPrisma } from "@/lib/prisma";
import { OrderCreateClient } from "@/components/encomendas/order-create-client";

export const dynamic = "force-dynamic";

export default async function NovaEncomendaPage() {
  await requirePermission("reports.write");

  const prisma = await getPrisma();
  const farmacias = await prisma.farmacia.findMany({
    where: { estado: "ATIVO" },
    select: { id: true, nome: true },
    orderBy: { nome: "asc" },
  });

  return (
    <MainShell>
      <div className="mx-auto max-w-5xl px-6 py-8">
        <h1 className="text-2xl font-semibold text-gray-900">Nova Encomenda</h1>
        <p className="mt-1 text-sm text-gray-600">
          Criar uma lista de encomenda. Pode guardar como rascunho ou finalizar directamente.
        </p>
        <div className="mt-6">
          <OrderCreateClient farmacias={farmacias} />
        </div>
      </div>
    </MainShell>
  );
}
