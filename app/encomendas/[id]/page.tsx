import { notFound } from "next/navigation";
import { MainShell } from "@/components/layout/main-shell";
import { requirePermission } from "@/lib/permissions";
import { getPrisma } from "@/lib/prisma";
import { loadOrderDetail } from "@/lib/encomendas/order-detail";
import { OrderDetailClient } from "@/components/encomendas/order-detail-client";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ id: string }>;
};

export default async function OrderDetailPage({ params }: Props) {
  await requirePermission("reports.write");
  const { id } = await params;

  const detail = await loadOrderDetail(id);
  if (!detail) notFound();

  const prisma = await getPrisma();
  // Lista de fornecedores REAIS (id+nome) para o picker por linha — ver
  // LinhaEncomenda.fornecedorSugeridoId. Mesma fonte que /encomendas/nova.
  const fornecedoresRows = await prisma.fornecedor.findMany({
    where: { estado: "ATIVO" },
    select: { id: true, nome: true, nomeNormalizado: true },
    orderBy: { nomeNormalizado: "asc" },
  });

  return (
    <MainShell>
      <div className="py-8">
        <OrderDetailClient
          detail={detail}
          fornecedores={fornecedoresRows.map((f) => ({ id: f.id, nome: f.nome ?? f.nomeNormalizado }))}
        />
      </div>
    </MainShell>
  );
}
