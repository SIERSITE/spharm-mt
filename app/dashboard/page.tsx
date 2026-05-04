import { MainShell } from "@/components/layout/main-shell";
import { getDashboardData } from "@/lib/dashboard";

export const dynamic = "force-dynamic";

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtEur(n: number): string {
  return Math.round(n).toLocaleString("pt-PT") + " €";
}

function fmtPct(n: number): string {
  return (
    n.toLocaleString("pt-PT", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }) + " %"
  );
}

/** "+6,1%" — variação percentual entre dois valores */
function fmtDelta(current: number, prev: number): string {
  if (prev === 0) return "—";
  const delta = ((current - prev) / prev) * 100;
  const sign = delta >= 0 ? "+" : "";
  return (
    sign +
    delta.toLocaleString("pt-PT", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }) +
    "%"
  );
}

/** "+0,4 p.p." — variação em pontos percentuais */
function fmtPP(current: number, prev: number): { text: string; color: string } {
  const pp = current - prev;
  const sign = pp >= 0 ? "+" : "";
  return {
    text:
      sign +
      pp.toLocaleString("pt-PT", {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }) +
      " p.p.",
    color: pp >= 0 ? "text-emerald-600" : "text-rose-500",
  };
}

// ─── Components ───────────────────────────────────────────────────────────────

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

function ConsolidatedRow({
  sales,
  margin,
  stoppedStock,
  alerts,
}: {
  sales: string;
  margin: string;
  stoppedStock: string;
  alerts: string;
}) {
  return (
    <div className="flex items-center justify-between border-t border-slate-200 pt-3 mt-3">
      <div className="text-[12px] font-semibold text-slate-700">
        Total grupo
      </div>

      <div className="grid grid-cols-4 gap-4 flex-1 ml-[180px]">
        <div className="text-[14px] font-semibold text-slate-900">{sales}</div>
        <div className="text-[14px] font-semibold text-slate-900">{margin}</div>
        <div className="text-[14px] font-semibold text-slate-900">
          {stoppedStock}
        </div>
        <div className="text-[14px] font-semibold text-slate-900">{alerts}</div>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function DashboardPage() {
  const { summary, pharmacies } = await getDashboardData();

  return (
    <MainShell>
      <div className="space-y-5">
        {/* HEADER */}
        <section>
          <h1 className="text-[20px] font-semibold text-slate-900">
            Dashboard
          </h1>
          <p className="mt-1 text-[12px] text-slate-500">
            Administrador · {pharmacies.length} farmácia
            {pharmacies.length !== 1 ? "s" : ""} em análise
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

          {/* Linhas — uma por farmácia activa */}
          {pharmacies.map((p) => {
            const pp = fmtPP(p.margin, p.marginPrev);
            return (
              <PharmacyRow
                key={p.id}
                name={p.name}
                sales={fmtEur(p.sales)}
                salesHelper={fmtDelta(p.sales, p.salesPrev)}
                margin={fmtPct(p.margin)}
                marginHelper={pp.text}
                marginHelperColor={pp.color}
                stoppedStock={fmtEur(p.stoppedStockValue)}
                stoppedStockHelper={`${p.stoppedStockCount.toLocaleString("pt-PT")} itens`}
                alerts={String(p.alerts)}
                alertsHelper="ativos"
              />
            );
          })}

          {/* Total */}
          <ConsolidatedRow
            sales={fmtEur(summary.totalSales)}
            margin={fmtPct(summary.totalMargin)}
            stoppedStock={fmtEur(summary.totalStoppedStockValue)}
            alerts={String(summary.totalAlerts)}
          />
        </section>
      </div>
    </MainShell>
  );
}
