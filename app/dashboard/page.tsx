import { MainShell } from "@/components/layout/main-shell";
import { getDashboardData } from "@/lib/dashboard";
import {
  ExecutiveSummary,
  TendenciaCard,
  CriticalAlertsCard,
  TransferenciasCard,
  ExcessosCard,
  PerPharmacyDetail,
} from "@/components/dashboard/dashboard-sections";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const data = await getDashboardData();

  return (
    <MainShell>
      <div className="space-y-3">
        {/* Top: split layout — executive summary (left) + chart card (right) */}
        <section className="grid gap-3 lg:grid-cols-[1.35fr_0.95fr]">
          <ExecutiveSummary
            pharmaciesCount={data.pharmaciesCount}
            transferSuggestionsTotal={data.optimization.transferSuggestionsTotal}
            atRiskCount={data.criticalAlerts.atRiskCount}
            excessStockValueEur={data.excess.excessStockValueEur}
          />
          <TendenciaCard data={data.trend} />
        </section>

        {/* Row de cartões compactos */}
        <section className="grid gap-3 md:grid-cols-3">
          <CriticalAlertsCard data={data.criticalAlerts} />
          <TransferenciasCard data={data.optimization} />
          <ExcessosCard data={data.excess} />
        </section>

        <PerPharmacyDetail pharmacies={data.perPharmacy} />
      </div>
    </MainShell>
  );
}
