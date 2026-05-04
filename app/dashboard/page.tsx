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
      <div className="space-y-5">
        <section>
          <h1 className="text-[20px] font-semibold text-slate-900">Dashboard</h1>
          <p className="mt-1 text-[12px] text-slate-500">
            {data.pharmaciesCount} farmácia{data.pharmaciesCount === 1 ? "" : "s"} em análise · destaques operacionais
          </p>
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
