import { MainShell } from "@/components/layout/main-shell";
import { getDashboardData } from "@/lib/dashboard";
import {
  TrendSection,
  CriticalAlertsSection,
  OptimizationSection,
  ReposicaoSection,
  PerPharmacyDetail,
} from "@/components/dashboard/dashboard-sections";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const data = await getDashboardData();

  return (
    <MainShell>
      <div className="space-y-2.5">
        <section className="flex items-end justify-between gap-3">
          <div>
            <h1 className="text-[18px] font-semibold leading-tight text-slate-900">
              Dashboard
            </h1>
            <p className="mt-0.5 text-[11px] text-slate-500">
              {data.pharmaciesCount} farmácia{data.pharmaciesCount === 1 ? "" : "s"} em análise
            </p>
          </div>
        </section>

        <TrendSection data={data.trend} />
        <CriticalAlertsSection data={data.criticalAlerts} />
        <OptimizationSection data={data.optimization} />
        <ReposicaoSection data={data.reposicao} />

        <PerPharmacyDetail pharmacies={data.perPharmacy} />
      </div>
    </MainShell>
  );
}
