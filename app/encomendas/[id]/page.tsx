import { notFound } from "next/navigation";
import { MainShell } from "@/components/layout/main-shell";
import { requirePermission } from "@/lib/permissions";
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

  return (
    <MainShell>
      <div className="mx-auto max-w-7xl px-6 py-8">
        <OrderDetailClient detail={detail} />
      </div>
    </MainShell>
  );
}
