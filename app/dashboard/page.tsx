import { MainShell } from "@/components/layout/main-shell";
import { getDashboardData } from "@/lib/dashboard";
import {
  ExecutiveSummary,
  CriticalAlertsCard,
  TransferenciasCard,
  ExcessosCard,
  PerPharmacyDetail,
} from "@/components/dashboard/dashboard-sections";
import { TendenciaCard } from "@/components/dashboard/trend-card";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const data = await getDashboardData();

  return (
    <MainShell>
      {/*
        AppShell ambient decoration (cross + ECG) lives in the top-right
        of the content area extending ~220px from the inner-container top.
        Push the dashboard wrapper down so the executive summary / chart
        cards never collide with that decoration; `relative z-10` is
        explicit so the wrapper carries its own stacking context above
        any future bg layer.
      */}
      <div className="relative z-10 space-y-6 pt-10">
        {/* Cabeçalho da página — alinhado com o padrão de /stock */}
        <section>
          <h1 className="text-[22px] font-semibold tracking-tight text-slate-900">
            Dashboard
          </h1>
          <p className="mt-1 text-[12px] text-slate-400">
            {data.pharmaciesCount} farmácia{data.pharmaciesCount === 1 ? "" : "s"} em análise · destaques operacionais
          </p>
        </section>

        {/* Top: split layout — executive summary (left) + chart card (right) */}
        <section className="grid gap-4 lg:grid-cols-[1.35fr_0.95fr]">
          <ExecutiveSummary
            pharmaciesCount={data.pharmaciesCount}
            transferSuggestionsTotal={data.optimization.transferSuggestionsTotal}
            atRiskCount={data.criticalAlerts.atRiskCount}
            excessStockValueEur={data.excess.excessStockValueEur}
          />
          <TendenciaCard data={data.trend} />
        </section>

        {/* Row de cartões compactos */}
        <section className="grid gap-4 md:grid-cols-3">
          <CriticalAlertsCard data={data.criticalAlerts} />
          <TransferenciasCard data={data.optimization} />
          <ExcessosCard data={data.excess} />
        </section>

        <PerPharmacyDetail pharmacies={data.perPharmacy} />
      </div>
    </MainShell>
  );
}
