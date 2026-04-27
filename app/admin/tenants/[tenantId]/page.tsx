import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getTenantOverviewById,
  listFarmaciasOfTenant,
  getOutboxCountersForTenant,
  listFailedOrdersOfTenant,
} from "@/lib/admin/tenant-data";
import { TenantDetailClient } from "@/components/admin/tenant-detail-client";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ tenantId: string }> };

export default async function TenantDetailPage({ params }: Props) {
  const { tenantId } = await params;
  const found = await getTenantOverviewById(tenantId);
  if (!found) notFound();

  const { tenant, overview } = found;

  // Estas três queries são todas cross-tenant — falham silenciosamente
  // se o tenant DB estiver indisponível. A UI mostra o estado.
  const [farmacias, outboxCounters, failedOrders] = await Promise.all([
    listFarmaciasOfTenant(tenant).catch(() => []),
    getOutboxCountersForTenant(tenant),
    listFailedOrdersOfTenant(tenant, 25),
  ]);

  return (
    <div className="space-y-6">
      <header>
        <Link
          href="/admin/tenants"
          className="text-[12px] font-medium text-slate-500 hover:text-slate-700"
        >
          ← Tenants
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">
          {overview.nome}
        </h1>
        <p className="mt-1 font-mono text-[11px] text-slate-500">{overview.slug}</p>
      </header>

      <TenantDetailClient
        tenantId={tenant.id}
        overview={overview}
        farmacias={farmacias}
        outboxCounters={outboxCounters}
        failedOrders={failedOrders}
      />
    </div>
  );
}
