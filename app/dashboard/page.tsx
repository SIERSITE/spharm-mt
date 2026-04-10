import { AppShell } from "@/components/layout/app-shell";
import { DashboardHero } from "@/components/dashboard/dashboard-hero";

function KpiInline({
  label,
  value,
  helper,
  helperColor = "text-slate-500",
}: {
  label: string;
  value: string;
  helper: string;
  helperColor?: string;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-[9px] uppercase tracking-[0.14em] text-slate-400">
        {label}
      </span>

      <span className="text-[15px] font-semibold text-slate-900 leading-tight">
        {value}
      </span>

      <span className={`text-[10px] ${helperColor}`}>{helper}</span>
    </div>
  );
}

function PharmacyRow({
  name,
  sales,
  salesHelper,
  margin,
  marginHelper,
  marginHelperColor,
  stoppedStock,
  stoppedStockHelper,
  alerts,
  alertsHelper,
}: {
  name: string;
  sales: string;
  salesHelper: string;
  margin: string;
  marginHelper: string;
  marginHelperColor?: string;
  stoppedStock: string;
  stoppedStockHelper: string;
  alerts: string;
  alertsHelper: string;
}) {
  return (
    <div className="flex items-center justify-between border-b border-slate-100 py-2.5">
      {/* Nome */}
      <div className="w-[180px] flex-shrink-0">
        <div className="text-[13px] font-medium text-slate-800">{name}</div>
      </div>

      {/* KPIs */}
      <div className="grid flex-1 grid-cols-4 gap-4">
        <KpiInline
          label="Vendas"
          value={sales}
          helper={salesHelper}
          helperColor="text-emerald-600"
        />

        <KpiInline
          label="Margem"
          value={margin}
          helper={marginHelper}
          helperColor={marginHelperColor ?? "text-slate-500"}
        />

        <KpiInline
          label="Stock parado"
          value={stoppedStock}
          helper={stoppedStockHelper}
        />

        <KpiInline
          label="Alertas"
          value={alerts}
          helper={alertsHelper}
        />
      </div>
    </div>
  );
}

function ConsolidatedRow() {
  return (
    <div className="flex items-center justify-between border-t border-slate-200 pt-3 mt-3">
      <div className="text-[12px] font-semibold text-slate-700">
        Total grupo
      </div>

      <div className="grid grid-cols-4 gap-4 flex-1 ml-[180px]">
        <div className="text-[14px] font-semibold text-slate-900">
          47.892 €
        </div>
        <div className="text-[14px] font-semibold text-slate-900">
          23,4 %
        </div>
        <div className="text-[14px] font-semibold text-slate-900">
          38.420 €
        </div>
        <div className="text-[14px] font-semibold text-slate-900">5</div>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <AppShell>
      <div className="space-y-5">
        {/* HEADER */}
        <section>
          <h1 className="text-[20px] font-semibold text-slate-900">
            Dashboard
          </h1>
          <p className="mt-1 text-[12px] text-slate-500">
            Administrador · 2 farmácias em análise
          </p>
        </section>

        {/* TABELA DE FARMÁCIAS */}
        <section className="rounded-[16px] border border-slate-200/60 bg-white/70 px-4 py-3">
          {/* Header da tabela */}
          <div className="flex items-center justify-between border-b border-slate-100 pb-2 text-[10px] uppercase tracking-[0.14em] text-slate-400">
            <div className="w-[180px]">Farmácia</div>

            <div className="grid flex-1 grid-cols-4 gap-4">
              <span>Vendas</span>
              <span>Margem</span>
              <span>Stock</span>
              <span>Alertas</span>
            </div>
          </div>

          {/* Linhas */}
          <PharmacyRow
            name="Farmácia A"
            sales="26.340 €"
            salesHelper="+6,1%"
            margin="24,1 %"
            marginHelper="+0,4 p.p."
            marginHelperColor="text-emerald-600"
            stoppedStock="17.820 €"
            stoppedStockHelper="562 itens"
            alerts="2"
            alertsHelper="ativos"
          />

          <PharmacyRow
            name="Farmácia B"
            sales="21.552 €"
            salesHelper="+4,0%"
            margin="22,7 %"
            marginHelper="-0,3 p.p."
            marginHelperColor="text-rose-500"
            stoppedStock="20.600 €"
            stoppedStockHelper="685 itens"
            alerts="3"
            alertsHelper="ativos"
          />

          {/* Total */}
          <ConsolidatedRow />
        </section>

        {/* RESTO */}
        <DashboardHero />
      </div>
    </AppShell>
  );
}