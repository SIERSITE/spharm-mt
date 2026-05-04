import Link from "next/link";
import {
  AlertTriangle,
  Activity,
  ArrowRight,
  ArrowRightLeft,
  ChevronDown,
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

function fmtPct(v: number, digits = 1): string {
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toLocaleString("pt-PT", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}%`;
}

// ─── Building blocks ─────────────────────────────────────────────────────────

function SectionShell({
  icon,
  title,
  hint,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <header className="flex items-center justify-between gap-3 pb-2.5 border-b border-slate-100">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-slate-100 text-slate-700">
            {icon}
          </div>
          <h2 className="text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-700">
            {title}
          </h2>
        </div>
        {hint && (
          <span className="hidden text-[11px] text-slate-400 sm:block">{hint}</span>
        )}
      </header>
      <div className="pt-2.5">{children}</div>
    </section>
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
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] opacity-70">
        {label}
      </div>
      <div className="mt-0.5 text-[18px] font-semibold leading-tight tabular-nums">
        {value}
      </div>
      {sublabel && <div className="mt-0.5 text-[10px] opacity-70">{sublabel}</div>}
    </>
  );
  const className = `rounded-lg border px-3 py-2 ${tones[tone]} ${
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

function CollapsibleDetail({ children }: { children: React.ReactNode }) {
  return (
    <details className="group mt-3">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-[11px] font-medium text-slate-700 transition hover:border-slate-300 hover:bg-white">
        <span className="group-open:hidden">Ver detalhe</span>
        <span className="hidden group-open:inline">Ocultar detalhe</span>
        <ChevronDown className="h-3 w-3 text-slate-400 transition group-open:rotate-180" />
      </summary>
      <div className="mt-2.5">{children}</div>
    </details>
  );
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
      <div className="rounded-lg border border-dashed border-slate-200 bg-white px-3 py-2 text-center text-[11px] text-slate-500">
        {emptyMessage}
      </div>
    );
  }
  return (
    <ul className="space-y-1">
      {items.map((p) => (
        <li
          key={`${p.cnp}-${p.farmaciaNome}`}
          className="flex items-start justify-between gap-3 rounded-lg border border-slate-100 bg-white px-2.5 py-1.5"
        >
          <div className="min-w-0">
            <Link
              href={`/catalogo/artigo/${p.cnp}`}
              className="block truncate text-[12px] font-medium text-slate-800 transition hover:text-emerald-700"
            >
              {p.designacao}
            </Link>
            <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-slate-500">
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
      className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-cyan-700 transition hover:text-cyan-800"
    >
      {label}
      <ArrowRight className="h-3 w-3" />
    </Link>
  );
}

// ─── Tendência (top da página) — bar chart compacto ─────────────────────────

export function TrendSection({
  data,
}: {
  data: DashboardData["trend"];
}) {
  const { monthlyTrend, currentMonthTotalEur, salesTrendPct } = data;

  if (monthlyTrend == null || monthlyTrend.length === 0) {
    return (
      <SectionShell
        icon={<Activity className="h-3.5 w-3.5" />}
        title="Tendência — 12 meses"
      >
        <div className="rounded-lg border border-dashed border-slate-200 bg-white px-3 py-4 text-center text-[12px] text-slate-500">
          Sem dados suficientes
        </div>
      </SectionShell>
    );
  }

  const currentBucket = monthlyTrend[monthlyTrend.length - 1];
  const prevBucket =
    monthlyTrend.length >= 2 ? monthlyTrend[monthlyTrend.length - 2] : null;

  return (
    <SectionShell
      icon={<Activity className="h-3.5 w-3.5" />}
      title="Tendência — 12 meses"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Mês actual ({currentBucket.label})
        </span>
        <span className="text-[22px] font-semibold leading-none text-slate-900 tabular-nums">
          {currentMonthTotalEur === null ? "Sem dados" : fmtEur(currentMonthTotalEur)}
        </span>
        {salesTrendPct === null ? (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
            {prevBucket ? `Sem baseline (${prevBucket.label} = 0 €)` : "Sem mês anterior"}
          </span>
        ) : (
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
              salesTrendPct >= 0
                ? "bg-emerald-50 text-emerald-700"
                : "bg-rose-50 text-rose-700"
            }`}
          >
            {salesTrendPct >= 0 ? (
              <TrendingUp className="h-2.5 w-2.5" />
            ) : (
              <TrendingDown className="h-2.5 w-2.5" />
            )}
            {fmtPct(salesTrendPct)}
            {prevBucket && (
              <span className="font-medium opacity-80">vs {prevBucket.label}</span>
            )}
          </span>
        )}
      </div>

      <MonthlyBarChart buckets={monthlyTrend} />
    </SectionShell>
  );
}

function MonthlyBarChart({
  buckets,
}: {
  buckets: NonNullable<DashboardData["trend"]["monthlyTrend"]>;
}) {
  const W = 1000;
  const H = 96;
  const PAD_X = 8;
  const PAD_TOP = 6;
  const PAD_BOTTOM = 18;

  const max = Math.max(1, ...buckets.map((b) => b.valorTotal));
  const lastIdx = buckets.length - 1;
  const slot = (W - 2 * PAD_X) / buckets.length;
  const barWidth = slot * 0.62;

  return (
    <div className="mt-2">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-20 w-full"
        role="img"
        aria-label="Vendas mensais — últimos 12 meses"
      >
        {buckets.map((b, i) => {
          const cx = PAD_X + (i + 0.5) * slot;
          const h = (b.valorTotal / max) * (H - PAD_TOP - PAD_BOTTOM);
          const y = H - PAD_BOTTOM - h;
          const isLast = i === lastIdx;
          return (
            <g key={i}>
              {/* Bar background (thin track) */}
              <rect
                x={cx - barWidth / 2}
                y={PAD_TOP}
                width={barWidth}
                height={H - PAD_TOP - PAD_BOTTOM}
                rx={2}
                fill="rgb(241 245 249)"
              />
              {b.valorTotal > 0 && (
                <rect
                  x={cx - barWidth / 2}
                  y={y}
                  width={barWidth}
                  height={h}
                  rx={2}
                  fill={isLast ? "rgb(5 150 105)" : "rgb(16 185 129 / 0.55)"}
                >
                  <title>{`${b.label} ${b.ano}: ${fmtEur(b.valorTotal)}`}</title>
                </rect>
              )}
              <text
                x={cx}
                y={H - 4}
                textAnchor="middle"
                fontSize={10}
                fill={isLast ? "rgb(15 23 42)" : "rgb(100 116 139)"}
                fontWeight={isLast ? 600 : 400}
              >
                {b.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ─── Alertas críticos ────────────────────────────────────────────────────────

export function CriticalAlertsSection({
  data,
}: {
  data: DashboardData["criticalAlerts"];
}) {
  return (
    <SectionShell
      icon={<AlertTriangle className="h-3.5 w-3.5 text-rose-600" />}
      title="Alertas críticos"
      hint="Stock que precisa de atenção imediata"
    >
      <div className="grid gap-2 md:grid-cols-3">
        <KpiCard
          label="Em rotura (com vendas)"
          value={fmtNumber(data.outOfStockCount)}
          sublabel="Sem stock, vendia nos últimos 90d"
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
          sublabel={`${fmtNumber(data.deadStockCount)} produto${data.deadStockCount === 1 ? "" : "s"}`}
          href="/stock?filter=no-movement-3m"
          tone={data.deadStockCount > 0 ? "warn" : "ok"}
        />
      </div>

      <CollapsibleDetail>
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              Top em rotura
            </h3>
            <ProductPreviewList
              items={data.outOfStockSample}
              emptyMessage="Sem produtos em rotura."
            />
            {data.outOfStockCount > data.outOfStockSample.length && (
              <SeeAllLink
                href="/stock?filter=out-of-stock"
                label={`Ver os ${fmtNumber(data.outOfStockCount)} produtos em rotura`}
              />
            )}
          </div>
          <div>
            <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              Top em risco
            </h3>
            <ProductPreviewList
              items={data.atRiskSample}
              emptyMessage="Sem produtos em risco."
            />
            {data.atRiskCount > data.atRiskSample.length && (
              <SeeAllLink
                href="/stock?filter=at-risk"
                label={`Ver os ${fmtNumber(data.atRiskCount)} produtos em risco`}
              />
            )}
          </div>
        </div>
      </CollapsibleDetail>
    </SectionShell>
  );
}

// ─── Transferências sugeridas ────────────────────────────────────────────────

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
    <SectionShell
      icon={<Sparkles className="h-3.5 w-3.5 text-emerald-700" />}
      title="Transferências sugeridas"
      hint="Equilíbrio de stock entre farmácias"
    >
      <div className="grid gap-2 md:grid-cols-2">
        <KpiCard
          label="Sugestões activas"
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
          sublabel="Σ quantidade × pvp das sugestões"
          tone="neutral"
        />
      </div>

      <CollapsibleDetail>
        <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Top 3 sugestões
        </h3>
        {data.topTransferSuggestions.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-200 bg-white px-3 py-2 text-center text-[11px] text-slate-500">
            Sem transferências sugeridas no momento.
          </div>
        ) : (
          <ul className="space-y-1">
            {data.topTransferSuggestions.map((t) => (
              <li
                key={`${t.cnp}-${t.farmaciaOrigem}-${t.farmaciaDestino}`}
                className="flex items-start justify-between gap-3 rounded-lg border border-slate-100 bg-white px-2.5 py-1.5"
              >
                <div className="min-w-0">
                  <Link
                    href={`/catalogo/artigo/${t.cnp}`}
                    className="block truncate text-[12px] font-medium text-slate-800 transition hover:text-emerald-700"
                  >
                    {t.produto}
                  </Link>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-slate-500">
                    <span className="font-medium text-slate-700">{t.farmaciaOrigem}</span>
                    <ArrowRightLeft className="h-2.5 w-2.5 text-slate-400" />
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
                  className={`inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-[9px] font-semibold ${
                    PRIORITY_TONE[t.prioridade] ?? PRIORITY_TONE.baixa
                  }`}
                >
                  {PRIORITY_LABEL[t.prioridade] ?? t.prioridade}
                </span>
              </li>
            ))}
          </ul>
        )}
        {data.transferSuggestionsTotal > data.topTransferSuggestions.length && (
          <SeeAllLink
            href="/transferencias"
            label={`Ver as ${fmtNumber(data.transferSuggestionsTotal)} sugestões`}
          />
        )}
      </CollapsibleDetail>
    </SectionShell>
  );
}

// ─── Stock mínimo & reposição ────────────────────────────────────────────────

export function ReposicaoSection({
  data,
}: {
  data: DashboardData["reposicao"];
}) {
  return (
    <SectionShell
      icon={<PackagePlus className="h-3.5 w-3.5 text-sky-700" />}
      title="Stock mínimo & reposição"
      hint="Indicadores de reposição (proposta real em /encomendas/nova)"
    >
      <div className="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
        <KpiCard
          label="Abaixo do mínimo"
          value={fmtNumber(data.belowMinCount)}
          sublabel="stockAtual ≤ stockMinimo"
          href="/stock?filter=below-min"
          tone={data.belowMinCount > 0 ? "warn" : "ok"}
        />
        <KpiCard
          label="Valor a repor"
          value={fmtEur(data.estimatedValueToRestoreEur)}
          sublabel="Σ (mínimo − actual) × custo"
          tone="neutral"
        />
        <Link
          href="/encomendas/nova"
          className="flex items-center justify-center gap-1.5 rounded-lg border border-sky-300 bg-sky-50 px-3 text-[12px] font-semibold text-sky-700 transition hover:border-sky-400 hover:bg-sky-100"
        >
          Gerar encomenda
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>

      <CollapsibleDetail>
        <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Maiores défices
        </h3>
        <ProductPreviewList
          items={data.belowMinSample}
          emptyMessage="Sem produtos abaixo do mínimo."
        />
        {data.belowMinCount > data.belowMinSample.length && (
          <SeeAllLink
            href="/stock?filter=below-min"
            label={`Ver os ${fmtNumber(data.belowMinCount)} produtos abaixo do mínimo`}
          />
        )}
      </CollapsibleDetail>
    </SectionShell>
  );
}

// ─── Per-pharmacy detail (collapsed by default) ──────────────────────────────

export function PerPharmacyDetail({
  pharmacies,
}: {
  pharmacies: DashboardData["perPharmacy"];
}) {
  return (
    <details className="group rounded-xl border border-slate-200 bg-white px-4 py-3">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-slate-100 text-slate-700">
            <Layers className="h-3.5 w-3.5" />
          </div>
          <h2 className="text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-700">
            Detalhe por farmácia
          </h2>
          <span className="text-[10px] text-slate-400">
            ({pharmacies.length})
          </span>
        </div>
        <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-[11px] font-medium text-slate-700 transition group-hover:border-slate-300">
          <span className="group-open:hidden">Ver detalhe</span>
          <span className="hidden group-open:inline">Ocultar detalhe</span>
          <ChevronDown className="h-3 w-3 text-slate-400 transition group-open:rotate-180" />
        </span>
      </summary>

      <div className="mt-3 overflow-x-auto">
        <table className="min-w-full text-left">
          <thead className="border-b border-slate-100 text-[10px] uppercase tracking-[0.12em] text-slate-400">
            <tr>
              <th className="px-2 py-1.5 font-semibold">Farmácia</th>
              <th className="px-2 py-1.5 text-right font-semibold">Vendas (mês)</th>
              <th className="px-2 py-1.5 text-right font-semibold">Margem</th>
              <th className="px-2 py-1.5 text-right font-semibold">Stock parado</th>
              <th className="px-2 py-1.5 text-right font-semibold">Alertas mín.</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-[12px] text-slate-700">
            {pharmacies.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-2 py-4 text-center text-slate-400">
                  Sem farmácias activas.
                </td>
              </tr>
            ) : (
              pharmacies.map((p) => (
                <tr key={p.id} className="hover:bg-slate-50/70">
                  <td className="px-2 py-1.5 font-medium text-slate-800">{p.name}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {fmtEur(p.sales)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {p.margin.toFixed(1)}%
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {fmtEur(p.stoppedStockValue)}
                    <span className="ml-1 text-[10px] text-slate-400">
                      ({fmtNumber(p.stoppedStockCount)})
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
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
