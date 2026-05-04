import Link from "next/link";
import {
  AlertTriangle,
  Activity,
  ArrowRight,
  ArrowRightLeft,
  Boxes,
  Layers,
  PackagePlus,
  Sparkles,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import type { DashboardData } from "@/lib/dashboard";

// ─── Formatadores ────────────────────────────────────────────────────────────

function fmtNumber(n: number, digits = 0): string {
  return n.toLocaleString("pt-PT", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtEur(n: number, digits = 0): string {
  return `${fmtNumber(n, digits)} €`;
}

function fmtPct(v: number | null, digits = 1): string {
  if (v == null) return "—";
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toLocaleString("pt-PT", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}%`;
}

function fmtDays(v: number | null, digits = 1): string {
  if (v == null) return "Sem dados suficientes";
  return `${v.toLocaleString("pt-PT", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })} dias`;
}

// ─── Building blocks ─────────────────────────────────────────────────────────

function SectionHeader({
  icon,
  title,
  hint,
}: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-slate-100 pb-3">
      <div className="flex items-center gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-slate-100 text-slate-700">
          {icon}
        </div>
        <div>
          <h2 className="text-[14px] font-semibold text-slate-900">{title}</h2>
          {hint && <p className="mt-0.5 text-[11px] text-slate-500">{hint}</p>}
        </div>
      </div>
    </div>
  );
}

function KpiCard({
  label,
  value,
  sublabel,
  href,
  tone = "neutral",
}: {
  label: string;
  value: string;
  sublabel?: string;
  href?: string;
  tone?: "neutral" | "warn" | "alert" | "ok" | "muted";
}) {
  const tones: Record<string, string> = {
    neutral: "border-slate-200 bg-white text-slate-900",
    warn: "border-amber-200 bg-amber-50 text-amber-900",
    alert: "border-rose-200 bg-rose-50 text-rose-900",
    ok: "border-emerald-200 bg-emerald-50 text-emerald-900",
    muted: "border-slate-200 bg-slate-50 text-slate-700",
  };
  const inner = (
    <>
      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] opacity-70">
        {label}
      </div>
      <div className="mt-1 text-[22px] font-semibold leading-tight">{value}</div>
      {sublabel && <div className="mt-0.5 text-[11px] opacity-70">{sublabel}</div>}
    </>
  );
  const className = `rounded-2xl border px-4 py-3 ${tones[tone]} ${
    href ? "transition hover:border-slate-300 hover:shadow-sm" : ""
  }`;
  if (href) {
    return (
      <Link href={href} className={`block ${className}`}>
        {inner}
      </Link>
    );
  }
  return <div className={className}>{inner}</div>;
}

function ProductPreviewList({
  items,
  emptyMessage,
}: {
  items: DashboardData["criticalAlerts"]["outOfStockSample"];
  emptyMessage: string;
}) {
  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-200 bg-white px-3 py-3 text-center text-[12px] text-slate-500">
        {emptyMessage}
      </div>
    );
  }
  return (
    <ul className="space-y-1.5">
      {items.map((p) => (
        <li
          key={`${p.cnp}-${p.farmaciaNome}`}
          className="flex items-start justify-between gap-3 rounded-xl border border-slate-100 bg-white px-3 py-2"
        >
          <div className="min-w-0">
            <Link
              href={`/catalogo/artigo/${p.cnp}`}
              className="block truncate text-[13px] font-medium text-slate-800 transition hover:text-emerald-700"
            >
              {p.designacao}
            </Link>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
              <span className="font-medium text-slate-700">{p.farmaciaNome}</span>
              <span className="text-slate-300">·</span>
              <span>{p.detail}</span>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function SeeAllLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="mt-3 inline-flex items-center gap-1 text-[12px] font-medium text-cyan-700 transition hover:text-cyan-800"
    >
      {label}
      <ArrowRight className="h-3 w-3" />
    </Link>
  );
}

// ─── Section 1: Critical operational alerts ──────────────────────────────────

export function CriticalAlertsSection({
  data,
}: {
  data: DashboardData["criticalAlerts"];
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white px-5 py-4">
      <SectionHeader
        icon={<AlertTriangle className="h-4 w-4 text-rose-600" />}
        title="Alertas operacionais críticos"
        hint="Produtos que precisam de atenção imediata."
      />
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <KpiCard
          label="Em rotura (com vendas)"
          value={fmtNumber(data.outOfStockCount)}
          sublabel="Produtos sem stock que vendiam nos últimos 90 dias"
          href="/stock?filter=out-of-stock"
          tone={data.outOfStockCount > 0 ? "alert" : "ok"}
        />
        <KpiCard
          label="Em risco (cobertura < 7d)"
          value={fmtNumber(data.atRiskCount)}
          sublabel="Cobertura inferior a 7 dias"
          href="/stock?filter=at-risk"
          tone={data.atRiskCount > 0 ? "warn" : "ok"}
        />
        <KpiCard
          label="Stock parado (60d)"
          value={fmtEur(data.deadStockValueEur)}
          sublabel={`${fmtNumber(data.deadStockCount)} produto${data.deadStockCount === 1 ? "" : "s"} sem vendas há 60+ dias`}
          href="/stock?filter=no-movement-3m"
          tone={data.deadStockCount > 0 ? "warn" : "ok"}
        />
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <div>
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
            Top em rotura
          </h3>
          <div className="mt-2">
            <ProductPreviewList
              items={data.outOfStockSample}
              emptyMessage="Sem produtos em rotura."
            />
          </div>
          {data.outOfStockCount > data.outOfStockSample.length && (
            <SeeAllLink
              href="/stock?filter=out-of-stock"
              label={`Ver os ${fmtNumber(data.outOfStockCount)} produtos em rotura`}
            />
          )}
        </div>
        <div>
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
            Top em risco
          </h3>
          <div className="mt-2">
            <ProductPreviewList
              items={data.atRiskSample}
              emptyMessage="Sem produtos em risco."
            />
          </div>
          {data.atRiskCount > data.atRiskSample.length && (
            <SeeAllLink
              href="/stock?filter=at-risk"
              label={`Ver os ${fmtNumber(data.atRiskCount)} produtos em risco`}
            />
          )}
        </div>
      </div>
    </section>
  );
}

// ─── Section 2: Stock efficiency ─────────────────────────────────────────────

export function StockEfficiencySection({
  data,
}: {
  data: DashboardData["stockEfficiency"];
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white px-5 py-4">
      <SectionHeader
        icon={<Boxes className="h-4 w-4 text-cyan-700" />}
        title="Eficiência de stock"
        hint="Sinais de saúde do inventário."
      />
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <KpiCard
          label="Cobertura média"
          value={fmtDays(data.coverageAvgDays)}
          sublabel={
            data.coverageAvgDays == null
              ? "Sem produtos com demanda mensurável"
              : "Média sobre produtos com vendas"
          }
          tone="neutral"
        />
        <KpiCard
          label="Excesso de stock (60d+)"
          value={fmtNumber(data.excessStockCount)}
          sublabel="Cobertura superior a 60 dias"
          href="/excessos?days=60"
          tone={data.excessStockCount > 0 ? "warn" : "ok"}
        />
        <KpiCard
          label="Catálogo sem movimento"
          value={
            data.catalogWithoutMovementPct == null
              ? "Sem dados suficientes"
              : `${data.catalogWithoutMovementPct.toFixed(1)}%`
          }
          sublabel={
            data.catalogWithoutMovementPct == null
              ? ""
              : `${fmtNumber(data.catalogWithoutMovementCount)} de ${fmtNumber(data.catalogWithStockCount)} sem vendas em 90d`
          }
          href="/stock?filter=no-movement-3m"
          tone={
            data.catalogWithoutMovementPct != null && data.catalogWithoutMovementPct > 30
              ? "warn"
              : "neutral"
          }
        />
      </div>

      {data.excessStockSample.length > 0 && (
        <div className="mt-5">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
            Top produtos com excesso
          </h3>
          <div className="mt-2">
            <ProductPreviewList
              items={data.excessStockSample}
              emptyMessage="Sem produtos com excesso."
            />
          </div>
          {data.excessStockCount > data.excessStockSample.length && (
            <SeeAllLink
              href="/excessos?days=60"
              label={`Ver os ${fmtNumber(data.excessStockCount)} produtos com excesso`}
            />
          )}
        </div>
      )}
    </section>
  );
}

// ─── Section 3: Optimization opportunities ───────────────────────────────────

const PRIORITY_TONE: Record<string, string> = {
  alta: "border-rose-200 bg-rose-50 text-rose-700",
  media: "border-amber-200 bg-amber-50 text-amber-700",
  baixa: "border-slate-200 bg-slate-50 text-slate-600",
};
const PRIORITY_LABEL: Record<string, string> = {
  alta: "Alta",
  media: "Média",
  baixa: "Baixa",
};

export function OptimizationSection({
  data,
}: {
  data: DashboardData["optimization"];
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white px-5 py-4">
      <SectionHeader
        icon={<Sparkles className="h-4 w-4 text-emerald-700" />}
        title="Oportunidades de optimização"
        hint="Transferências entre farmácias do grupo."
      />
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <KpiCard
          label="Transferências sugeridas"
          value={fmtNumber(data.transferSuggestionsTotal)}
          sublabel={
            data.transferSuggestionsTotal === 0
              ? "Sem desequilíbrios actuais"
              : "Calculadas pelo motor de transferências"
          }
          href="/transferencias"
          tone={data.transferSuggestionsTotal > 0 ? "ok" : "neutral"}
        />
        <KpiCard
          label="Valor estimado a libertar"
          value={fmtEur(data.estimatedValueUnlockedEur)}
          sublabel="Soma de quantidade × pvp das transferências sugeridas"
          tone="neutral"
        />
      </div>

      <div className="mt-5">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
          Top 3 sugestões
        </h3>
        <div className="mt-2">
          {data.topTransferSuggestions.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 bg-white px-3 py-3 text-center text-[12px] text-slate-500">
              Sem transferências sugeridas no momento.
            </div>
          ) : (
            <ul className="space-y-1.5">
              {data.topTransferSuggestions.map((t) => (
                <li
                  key={`${t.cnp}-${t.farmaciaOrigem}-${t.farmaciaDestino}`}
                  className="flex items-start justify-between gap-3 rounded-xl border border-slate-100 bg-white px-3 py-2"
                >
                  <div className="min-w-0">
                    <Link
                      href={`/catalogo/artigo/${t.cnp}`}
                      className="block truncate text-[13px] font-medium text-slate-800 transition hover:text-emerald-700"
                    >
                      {t.produto}
                    </Link>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
                      <span className="font-medium text-slate-700">{t.farmaciaOrigem}</span>
                      <ArrowRightLeft className="h-3 w-3 text-slate-400" />
                      <span className="font-medium text-slate-700">{t.farmaciaDestino}</span>
                      <span className="text-slate-300">·</span>
                      <span>{fmtNumber(t.quantidadeSugerida)} un.</span>
                      {t.valorUnlocked > 0 && (
                        <>
                          <span className="text-slate-300">·</span>
                          <span>{fmtEur(t.valorUnlocked)}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <span
                    className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                      PRIORITY_TONE[t.prioridade] ?? PRIORITY_TONE.baixa
                    }`}
                  >
                    {PRIORITY_LABEL[t.prioridade] ?? t.prioridade}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {data.transferSuggestionsTotal > data.topTransferSuggestions.length && (
          <SeeAllLink
            href="/transferencias"
            label={`Ver as ${fmtNumber(data.transferSuggestionsTotal)} sugestões`}
          />
        )}
      </div>
    </section>
  );
}

// ─── Section 4: Stock mínimo & reposição ─────────────────────────────────────

export function ReposicaoSection({
  data,
}: {
  data: DashboardData["reposicao"];
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white px-5 py-4">
      <SectionHeader
        icon={<PackagePlus className="h-4 w-4 text-sky-700" />}
        title="Stock mínimo & reposição"
        hint="Indicadores baseados em stockMinimo. A proposta real é gerada em /encomendas/nova."
      />
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <KpiCard
          label="Abaixo do stock mínimo"
          value={fmtNumber(data.belowMinCount)}
          sublabel="Produtos com stockAtual ≤ stockMinimo"
          href="/stock?filter=below-min"
          tone={data.belowMinCount > 0 ? "warn" : "ok"}
        />
        <KpiCard
          label="Valor estimado a repor"
          value={fmtEur(data.estimatedValueToRestoreEur)}
          sublabel="Soma de (mínimo − actual) × custo"
          tone="neutral"
        />
      </div>

      {data.belowMinSample.length > 0 && (
        <div className="mt-5">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
            Maiores défices
          </h3>
          <div className="mt-2">
            <ProductPreviewList
              items={data.belowMinSample}
              emptyMessage="Sem produtos abaixo do mínimo."
            />
          </div>
          {data.belowMinCount > data.belowMinSample.length && (
            <SeeAllLink
              href="/stock?filter=below-min"
              label={`Ver os ${fmtNumber(data.belowMinCount)} produtos abaixo do mínimo`}
            />
          )}
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-[12px] text-sky-900">
        <span>
          A proposta de encomenda usa lógica própria com janela de vendas e cobertura-alvo configuráveis.
        </span>
        <Link
          href="/encomendas/nova"
          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-sky-300 bg-white px-3 py-1 text-[11px] font-semibold text-sky-700 transition hover:border-sky-400"
        >
          Gerar nova encomenda
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
    </section>
  );
}

// ─── Section 5: Trend (secondary) ────────────────────────────────────────────

export function TrendSection({
  data,
}: {
  data: DashboardData["trend"];
}) {
  const { salesTrendPct, weeklyChart } = data;
  const max = weeklyChart ? Math.max(1, ...weeklyChart.map((b) => b.value)) : 1;
  const totalUnits = weeklyChart
    ? weeklyChart.reduce((s, b) => s + b.value, 0)
    : 0;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white px-5 py-4">
      <SectionHeader
        icon={<Activity className="h-4 w-4 text-slate-600" />}
        title="Tendência"
        hint="Vendas mês-a-mês e procura dos últimos 7 dias."
      />
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div className="rounded-2xl border border-slate-100 bg-slate-50/72 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
              Vendas vs. mês anterior
            </div>
            {salesTrendPct == null ? (
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-500">
                Sem baseline
              </span>
            ) : (
              <span
                className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                  salesTrendPct >= 0
                    ? "bg-emerald-50 text-emerald-700"
                    : "bg-rose-50 text-rose-700"
                }`}
              >
                {salesTrendPct >= 0 ? (
                  <TrendingUp className="h-3 w-3" />
                ) : (
                  <TrendingDown className="h-3 w-3" />
                )}
                {fmtPct(salesTrendPct)}
              </span>
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-100 bg-slate-50/72 p-4">
          <div className="mb-3 flex items-end justify-between">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                Procura — últimos 7 dias
              </div>
              <div className="mt-1 text-sm font-semibold text-slate-800">
                {weeklyChart == null
                  ? "Sem dados de vendas no período"
                  : `${fmtNumber(totalUnits)} unidades`}
              </div>
            </div>
          </div>

          {weeklyChart == null ? (
            <div className="flex h-20 items-center justify-center rounded-xl border border-dashed border-slate-200 bg-white text-[11px] text-slate-500">
              Sem dados.
            </div>
          ) : (
            <>
              <div className="mb-2 flex h-20 items-end gap-2">
                {weeklyChart.map((b, i) => {
                  const heightPx = Math.max(2, Math.round((b.value / max) * 72));
                  return (
                    <div key={i} className="flex flex-1 flex-col items-center">
                      <div
                        title={`${b.date}: ${fmtNumber(b.value)} un.`}
                        className="w-full rounded-t-md bg-gradient-to-t from-emerald-500/75 to-emerald-300/35"
                        style={{ height: `${heightPx}px` }}
                      />
                    </div>
                  );
                })}
              </div>
              <div className="grid grid-cols-7 text-center text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                {weeklyChart.map((b, i) => (
                  <span key={i}>{b.dayLabel}</span>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

// ─── Per-pharmacy table (collapsible) ────────────────────────────────────────

export function PerPharmacyDetail({
  pharmacies,
}: {
  pharmacies: DashboardData["perPharmacy"];
}) {
  return (
    <details className="rounded-2xl border border-slate-200 bg-white px-5 py-3 open:py-4">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-slate-100 text-slate-700">
            <Layers className="h-4 w-4" />
          </div>
          <div>
            <h2 className="text-[14px] font-semibold text-slate-900">
              Detalhe por farmácia
            </h2>
            <p className="mt-0.5 text-[11px] text-slate-500">
              {pharmacies.length} farmácia{pharmacies.length === 1 ? "" : "s"} ·
              {" "}vendas, margem, stock parado, alertas
            </p>
          </div>
        </div>
        <ArrowRight className="h-4 w-4 text-slate-400 transition group-open:rotate-90" />
      </summary>

      <div className="mt-4 overflow-x-auto">
        <table className="min-w-full text-left">
          <thead className="border-b border-slate-100 text-[10px] uppercase tracking-[0.14em] text-slate-400">
            <tr>
              <th className="px-3 py-2 font-semibold">Farmácia</th>
              <th className="px-3 py-2 text-right font-semibold">Vendas (mês)</th>
              <th className="px-3 py-2 text-right font-semibold">Margem</th>
              <th className="px-3 py-2 text-right font-semibold">Stock parado</th>
              <th className="px-3 py-2 text-right font-semibold">Alertas mín.</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-[12px] text-slate-700">
            {pharmacies.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-slate-400">
                  Sem farmácias activas.
                </td>
              </tr>
            ) : (
              pharmacies.map((p) => (
                <tr key={p.id} className="hover:bg-slate-50/70">
                  <td className="px-3 py-2 font-medium text-slate-800">{p.name}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {fmtEur(p.sales)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {p.margin.toFixed(1)}%
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {fmtEur(p.stoppedStockValue)}
                    <span className="ml-1 text-[10px] text-slate-400">
                      ({fmtNumber(p.stoppedStockCount)})
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {fmtNumber(p.alerts)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </details>
  );
}
