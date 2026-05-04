import Link from "next/link";
import {
  AlertTriangle,
  Activity,
  ArrowRight,
  ArrowRightLeft,
  ChevronDown,
  Layers,
  PackageMinus,
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

const PREMIUM_CARD =
  "rounded-[20px] border border-white/70 bg-white/82 shadow-[0_10px_28px_rgba(15,23,42,0.05)] backdrop-blur-md";

function CardShell({
  icon,
  title,
  hint,
  className = "",
  children,
}: {
  icon?: React.ReactNode;
  title: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`${PREMIUM_CARD} px-4 py-3.5 ${className}`}>
      <header className="flex items-center justify-between gap-2 pb-2.5">
        <div className="flex items-center gap-2">
          {icon && (
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700">
              {icon}
            </div>
          )}
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
              {title}
            </div>
            {hint && <div className="text-[11px] text-slate-500">{hint}</div>}
          </div>
        </div>
      </header>
      <div className="border-t border-slate-100 pt-2.5">{children}</div>
    </section>
  );
}

function KpiTile({
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
  tone?: "neutral" | "warn" | "alert" | "ok";
}) {
  const tones: Record<string, string> = {
    neutral: "text-slate-900",
    warn: "text-amber-700",
    alert: "text-rose-700",
    ok: "text-emerald-700",
  };
  const inner = (
    <>
      <div className="text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-400">
        {label}
      </div>
      <div className={`mt-1 text-[18px] font-semibold leading-none tabular-nums ${tones[tone]}`}>
        {value}
      </div>
      {sublabel && (
        <div className="mt-0.5 text-[10px] text-slate-500">{sublabel}</div>
      )}
    </>
  );
  const className =
    "rounded-[14px] border border-white/70 bg-white/78 px-3 py-2.5 shadow-[0_8px_18px_rgba(15,23,42,0.035)]";
  if (href) {
    return (
      <Link
        href={href}
        className={`block ${className} transition hover:border-emerald-200 hover:shadow-[0_8px_20px_rgba(15,23,42,0.06)]`}
      >
        {inner}
      </Link>
    );
  }
  return <div className={className}>{inner}</div>;
}

function KpiRow({
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
  tone?: "neutral" | "warn" | "alert" | "ok";
}) {
  const tones: Record<string, string> = {
    neutral: "text-slate-900",
    warn: "text-amber-700",
    alert: "text-rose-700",
    ok: "text-emerald-700",
  };
  const inner = (
    <>
      <div className="min-w-0">
        <div className="truncate text-[12px] font-medium text-slate-700">{label}</div>
        {sublabel && (
          <div className="truncate text-[10px] text-slate-400">{sublabel}</div>
        )}
      </div>
      <span className={`text-[16px] font-semibold tabular-nums ${tones[tone]}`}>
        {value}
      </span>
    </>
  );
  const className = "flex items-baseline justify-between gap-3 rounded-md px-2 py-1.5";
  if (href) {
    return (
      <Link
        href={href}
        className={`${className} transition hover:bg-emerald-50/60`}
      >
        {inner}
      </Link>
    );
  }
  return <div className={className}>{inner}</div>;
}

function CollapsibleDetail({ children }: { children: React.ReactNode }) {
  return (
    <details className="group mt-2.5">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-full border border-slate-200 bg-white/60 px-2.5 py-0.5 text-[10px] font-medium text-slate-700 transition hover:border-slate-300 hover:bg-white">
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
      <div className="rounded-md border border-dashed border-slate-200 bg-white px-2.5 py-1.5 text-center text-[11px] text-slate-500">
        {emptyMessage}
      </div>
    );
  }
  return (
    <ul className="space-y-1">
      {items.map((p) => (
        <li
          key={`${p.cnp}-${p.farmaciaNome}`}
          className="rounded-md border border-slate-100 bg-white px-2 py-1.5"
        >
          <Link
            href={`/catalogo/artigo/${p.cnp}`}
            className="block truncate text-[11px] font-medium text-slate-800 transition hover:text-emerald-700"
          >
            {p.designacao}
          </Link>
          <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-slate-500">
            <span className="font-medium text-slate-700">{p.farmaciaNome}</span>
            <span className="text-slate-300">·</span>
            <span>{p.detail}</span>
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
      className="mt-1.5 inline-flex items-center gap-1 text-[10px] font-medium text-cyan-700 transition hover:text-cyan-800"
    >
      {label}
      <ArrowRight className="h-2.5 w-2.5" />
    </Link>
  );
}

// ─── Top: Executive summary (left) ───────────────────────────────────────────

export function ExecutiveSummary({
  pharmaciesCount,
  transferSuggestionsTotal,
  atRiskCount,
  excessStockValueEur,
}: {
  pharmaciesCount: number;
  transferSuggestionsTotal: number;
  atRiskCount: number;
  excessStockValueEur: number;
}) {
  return (
    <section className={`${PREMIUM_CARD} relative overflow-hidden p-5`}>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-[10px] font-semibold text-emerald-700">
          Estado operacional
        </span>
        <span className="inline-flex items-center rounded-full border border-emerald-100 bg-emerald-50/70 px-2.5 py-0.5 text-[10px] font-semibold text-emerald-600/80">
          Monitorização entre farmácias
        </span>
      </div>

      <h2 className="max-w-[42ch] text-[18px] font-semibold leading-tight tracking-[-0.01em] text-slate-900">
        Cobertura, rotação e diferenças operacionais
      </h2>
      <p className="mt-1.5 max-w-[60ch] text-[12px] leading-snug text-slate-500">
        Leitura consolidada de stock entre farmácias, com sugestões de
        transferências, diferenças de cobertura e referências com rotação
        desigual.
      </p>

      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile
          label="Farmácias"
          value={fmtNumber(pharmaciesCount)}
          sublabel="em análise"
        />
        <KpiTile
          label="Transferências"
          value={fmtNumber(transferSuggestionsTotal)}
          sublabel="sugeridas"
          href={transferSuggestionsTotal > 0 ? "/transferencias" : undefined}
          tone={transferSuggestionsTotal > 0 ? "ok" : "neutral"}
        />
        <KpiTile
          label="Produtos em risco"
          value={fmtNumber(atRiskCount)}
          sublabel="cobertura < 7d"
          href={atRiskCount > 0 ? "/stock?filter=at-risk" : undefined}
          tone={atRiskCount > 0 ? "warn" : "ok"}
        />
        <KpiTile
          label="Valor em excesso"
          value={fmtEur(excessStockValueEur)}
          sublabel="cobertura > 60d"
          href={excessStockValueEur > 0 ? "/excessos?days=60" : undefined}
          tone={excessStockValueEur > 0 ? "warn" : "ok"}
        />
      </div>
    </section>
  );
}

// ─── Top: Tendência (right) — visual chart card ──────────────────────────────

export function TendenciaCard({
  data,
}: {
  data: DashboardData["trend"];
}) {
  const { monthlyTrend, currentMonthTotalEur, salesTrendPct } = data;

  return (
    <section className={`${PREMIUM_CARD} p-5`}>
      <header className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
            Leitura executiva
          </div>
          <h3 className="mt-1 text-[16px] font-semibold leading-tight text-slate-900">
            Tendência operacional
          </h3>
        </div>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600">
          <Activity className="h-4 w-4" />
        </div>
      </header>

      {monthlyTrend == null || monthlyTrend.length === 0 ? (
        <div className="mt-5 rounded-lg border border-dashed border-slate-200 bg-white px-3 py-6 text-center text-[12px] text-slate-500">
          Sem dados suficientes
        </div>
      ) : (
        <TendenciaBody
          monthlyTrend={monthlyTrend}
          currentMonthTotalEur={currentMonthTotalEur}
          salesTrendPct={salesTrendPct}
        />
      )}
    </section>
  );
}

function TendenciaBody({
  monthlyTrend,
  currentMonthTotalEur,
  salesTrendPct,
}: {
  monthlyTrend: NonNullable<DashboardData["trend"]["monthlyTrend"]>;
  currentMonthTotalEur: number | null;
  salesTrendPct: number | null;
}) {
  const currentBucket = monthlyTrend[monthlyTrend.length - 1];
  const prevBucket =
    monthlyTrend.length >= 2 ? monthlyTrend[monthlyTrend.length - 2] : null;
  const max = Math.max(1, ...monthlyTrend.map((b) => b.valorTotal));
  const lastIdx = monthlyTrend.length - 1;

  return (
    <>
      <div className="mt-4">
        <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
          Mês actual ({currentBucket.label})
        </div>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-[24px] font-semibold leading-none text-slate-900 tabular-nums">
            {currentMonthTotalEur === null
              ? "Sem dados"
              : fmtEur(currentMonthTotalEur)}
          </span>
          {salesTrendPct === null ? (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
              Sem baseline
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
      </div>

      {/* Bar chart — rounded pill bars at the top, gradient fill, current month highlighted */}
      <div className="mt-4">
        <div className="flex h-24 items-end gap-1.5">
          {monthlyTrend.map((b, i) => {
            const isLast = i === lastIdx;
            const heightPx =
              b.valorTotal > 0
                ? Math.max(4, Math.round((b.valorTotal / max) * 88))
                : 0;
            return (
              <div key={i} className="flex flex-1 flex-col items-center gap-1.5">
                {heightPx > 0 ? (
                  <div
                    title={`${b.label} ${b.ano}: ${fmtEur(b.valorTotal)}`}
                    className={`w-full rounded-t-full ${
                      isLast
                        ? "bg-gradient-to-t from-emerald-600 to-emerald-400"
                        : "bg-gradient-to-t from-emerald-500/65 to-emerald-300/30"
                    }`}
                    style={{ height: `${heightPx}px` }}
                  />
                ) : (
                  <div className="h-1 w-full rounded-full bg-slate-100" />
                )}
                <span
                  className={`text-[9px] font-medium ${
                    isLast ? "text-slate-900" : "text-slate-400"
                  }`}
                >
                  {b.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

// ─── Card: Alertas críticos ──────────────────────────────────────────────────

export function CriticalAlertsCard({
  data,
}: {
  data: DashboardData["criticalAlerts"];
}) {
  return (
    <CardShell
      icon={<AlertTriangle className="h-3.5 w-3.5 text-rose-600" />}
      title="Alertas críticos"
      hint="Stock que precisa de atenção"
    >
      <div className="space-y-0.5">
        <KpiRow
          label="Em rotura"
          sublabel="sem stock, com vendas em 90d"
          value={fmtNumber(data.outOfStockCount)}
          href="/stock?filter=out-of-stock"
          tone={data.outOfStockCount > 0 ? "alert" : "ok"}
        />
        <KpiRow
          label="Em risco"
          sublabel="cobertura < 7 dias"
          value={fmtNumber(data.atRiskCount)}
          href="/stock?filter=at-risk"
          tone={data.atRiskCount > 0 ? "warn" : "ok"}
        />
      </div>

      <CollapsibleDetail>
        <div className="space-y-3">
          <div>
            <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              Top em rotura
            </h4>
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
            <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              Top em risco
            </h4>
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
    </CardShell>
  );
}

// ─── Card: Transferências sugeridas ──────────────────────────────────────────

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

export function TransferenciasCard({
  data,
}: {
  data: DashboardData["optimization"];
}) {
  return (
    <CardShell
      icon={<Sparkles className="h-3.5 w-3.5 text-emerald-700" />}
      title="Transferências"
      hint="Equilíbrio de stock entre farmácias"
    >
      <div className="space-y-0.5">
        <KpiRow
          label="Sugestões activas"
          sublabel={
            data.transferSuggestionsTotal === 0
              ? "Sem desequilíbrios"
              : "Calculadas pelo motor"
          }
          value={fmtNumber(data.transferSuggestionsTotal)}
          href={data.transferSuggestionsTotal > 0 ? "/transferencias" : undefined}
          tone={data.transferSuggestionsTotal > 0 ? "ok" : "neutral"}
        />
        <KpiRow
          label="Valor a libertar"
          sublabel="Σ qty × pvp das sugestões"
          value={fmtEur(data.estimatedValueUnlockedEur)}
          tone="neutral"
        />
      </div>

      <CollapsibleDetail>
        <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Top 3 sugestões
        </h4>
        {data.topTransferSuggestions.length === 0 ? (
          <div className="rounded-md border border-dashed border-slate-200 bg-white px-2.5 py-1.5 text-center text-[11px] text-slate-500">
            Sem transferências sugeridas no momento.
          </div>
        ) : (
          <ul className="space-y-1">
            {data.topTransferSuggestions.map((t) => (
              <li
                key={`${t.cnp}-${t.farmaciaOrigem}-${t.farmaciaDestino}`}
                className="rounded-md border border-slate-100 bg-white px-2 py-1.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <Link
                    href={`/catalogo/artigo/${t.cnp}`}
                    className="block min-w-0 flex-1 truncate text-[11px] font-medium text-slate-800 transition hover:text-emerald-700"
                  >
                    {t.produto}
                  </Link>
                  <span
                    className={`inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-[9px] font-semibold ${
                      PRIORITY_TONE[t.prioridade] ?? PRIORITY_TONE.baixa
                    }`}
                  >
                    {PRIORITY_LABEL[t.prioridade] ?? t.prioridade}
                  </span>
                </div>
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
    </CardShell>
  );
}

// ─── Card: Excessos / stock parado ───────────────────────────────────────────

export function ExcessosCard({
  data,
}: {
  data: DashboardData["excess"];
}) {
  return (
    <CardShell
      icon={<PackageMinus className="h-3.5 w-3.5 text-amber-700" />}
      title="Excessos / stock parado"
      hint="Inventário sub-utilizado"
    >
      <div className="space-y-0.5">
        <KpiRow
          label="Valor em excesso"
          sublabel="cobertura > 60 dias"
          value={fmtEur(data.excessStockValueEur)}
          href={data.excessStockCount > 0 ? "/excessos?days=60" : undefined}
          tone={data.excessStockValueEur > 0 ? "warn" : "ok"}
        />
        <KpiRow
          label="Coberturas > 60d"
          sublabel="produtos em excesso"
          value={fmtNumber(data.excessStockCount)}
          href={data.excessStockCount > 0 ? "/excessos?days=60" : undefined}
          tone={data.excessStockCount > 0 ? "warn" : "ok"}
        />
        <KpiRow
          label="Sem vendas em 90d"
          sublabel="produtos parados"
          value={fmtNumber(data.noMovementCount)}
          href={data.noMovementCount > 0 ? "/stock?filter=no-movement-3m" : undefined}
          tone={data.noMovementCount > 0 ? "warn" : "ok"}
        />
      </div>

      <CollapsibleDetail>
        <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Top excessos por valor
        </h4>
        <ProductPreviewList
          items={data.excessSample}
          emptyMessage="Sem produtos em excesso."
        />
        {data.excessStockCount > data.excessSample.length && (
          <SeeAllLink
            href="/excessos?days=60"
            label={`Ver os ${fmtNumber(data.excessStockCount)} produtos em excesso`}
          />
        )}
      </CollapsibleDetail>
    </CardShell>
  );
}

// ─── Per-pharmacy detail (collapsed by default) ──────────────────────────────

export function PerPharmacyDetail({
  pharmacies,
}: {
  pharmacies: DashboardData["perPharmacy"];
}) {
  return (
    <details className={`group ${PREMIUM_CARD} px-4 py-3`}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-slate-100 text-slate-700">
            <Layers className="h-3.5 w-3.5" />
          </div>
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
              Detalhe por farmácia
            </div>
            <div className="text-[10px] text-slate-400">
              {pharmacies.length} farmácia{pharmacies.length === 1 ? "" : "s"} ·
              {" "}vendas, margem, stock parado, alertas
            </div>
          </div>
        </div>
        <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white/60 px-2.5 py-0.5 text-[10px] font-medium text-slate-700 transition hover:border-slate-300 hover:bg-white">
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
