import { Activity, ShieldCheck, Focus, Sparkles, ArrowRight } from "lucide-react";
import type {
  DashboardHeroData,
  DashboardHeroDayBucket,
  DashboardHeroTopSuggestion,
} from "@/lib/dashboard-hero-data";

const PRIORITY_COLOR: Record<string, string> = {
  alta: "border-rose-200 bg-rose-50 text-rose-700",
  media: "border-amber-200 bg-amber-50 text-amber-700",
  baixa: "border-slate-200 bg-slate-50 text-slate-600",
};

const PRIORITY_LABEL: Record<string, string> = {
  alta: "Alta",
  media: "Média",
  baixa: "Baixa",
};

function fmtPct(v: number): string {
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toLocaleString("pt-PT", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}%`;
}

function fmtCoverage(v: number | null): string {
  if (v == null) return "Sem dados suficientes";
  return `${v.toLocaleString("pt-PT", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} dias`;
}

export function DashboardHero({ data }: { data: DashboardHeroData }) {
  const {
    pharmaciesCount,
    transferSuggestionsTotal,
    topTransferSuggestions,
    salesTrendPct,
    coverageAvgDays,
    lowCoverageCount,
    highVarianceCount,
    weeklyChart,
  } = data;

  return (
    <section className="relative overflow-hidden rounded-[28px] border border-slate-200/60 bg-white/72 p-6 shadow-[0_20px_50px_rgba(15,23,42,0.05)] backdrop-blur-xl">
      <div className="relative z-10 grid gap-6 lg:grid-cols-[1.35fr_0.95fr]">
        {/* ── Painel esquerdo ───────────────────────────────────────────── */}
        <div>
          <div className="mb-5 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[11px] font-semibold text-emerald-600">
              Estado operacional
            </span>
            <span className="inline-flex items-center rounded-full border border-emerald-100 bg-emerald-50/70 px-3 py-1 text-[11px] font-semibold text-emerald-600/80">
              Monitorização entre farmácias
            </span>
          </div>

          <h2 className="max-w-[680px] text-[22px] font-semibold leading-[30px] tracking-[-0.02em] text-slate-900">
            Cobertura, rotação e diferenças operacionais
          </h2>

          <p className="mt-3 max-w-[680px] text-[13px] leading-6 text-slate-500">
            Leitura consolidada de stock entre farmácias, com sugestões de
            transferências, diferenças de cobertura e referências com rotação
            desigual.
          </p>

          <div className="mt-7 grid gap-3 sm:grid-cols-3">
            <KpiCard
              icon={<Activity className="h-[18px] w-[18px]" />}
              label="Farmácias"
              value={`${pharmaciesCount.toLocaleString("pt-PT")} em análise`}
            />
            <KpiCard
              icon={<ShieldCheck className="h-[18px] w-[18px]" />}
              label="Transferências"
              value={`${transferSuggestionsTotal.toLocaleString("pt-PT")} sugerida${
                transferSuggestionsTotal === 1 ? "" : "s"
              }`}
            />
            <KpiCard
              icon={<Focus className="h-[18px] w-[18px]" />}
              label="Foco"
              value="Cobertura e rotação"
            />
          </div>

          <div className="mt-6 rounded-[20px] border border-slate-100 bg-slate-50/72 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                Transferências sugeridas
              </div>
              <span className="text-[11px] font-medium text-slate-500">
                {topTransferSuggestions.length === 0
                  ? "—"
                  : `Top ${topTransferSuggestions.length}`}
              </span>
            </div>

            {topTransferSuggestions.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-200 bg-white/60 px-4 py-6 text-center text-[12px] text-slate-500">
                Nenhuma transferência sugerida no momento.
              </div>
            ) : (
              <div className="space-y-3">
                {topTransferSuggestions.map((t) => (
                  <TransferRow
                    key={`${t.cnp}-${t.farmaciaOrigem}-${t.farmaciaDestino}`}
                    t={t}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── Painel direito ────────────────────────────────────────────── */}
        <div className="rounded-[24px] border border-white/70 bg-white/78 p-5 shadow-[0_16px_40px_rgba(15,23,42,0.05)] backdrop-blur-md">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                Leitura executiva
              </div>
              <h3 className="mt-2 text-[18px] font-semibold leading-7 tracking-[-0.02em] text-slate-900">
                Sinais operacionais entre farmácias
              </h3>
            </div>

            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600">
              <Sparkles className="h-[18px] w-[18px]" />
            </div>
          </div>

          <div className="space-y-5">
            <div>
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                  Tendência mensal
                </div>
                {salesTrendPct == null ? (
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-500">
                    Sem baseline
                  </span>
                ) : (
                  <span
                    className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                      salesTrendPct >= 0
                        ? "bg-emerald-50 text-emerald-600"
                        : "bg-rose-50 text-rose-600"
                    }`}
                  >
                    {fmtPct(salesTrendPct)}
                  </span>
                )}
              </div>

              <div className="text-sm font-semibold text-slate-800">
                Vendas vs. mês anterior
              </div>
            </div>

            <div className="rounded-[20px] border border-slate-100 bg-slate-50/72 p-4">
              <div className="mb-4 flex items-end justify-between">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                    Procura — últimos 7 dias
                  </div>
                  <div className="mt-1 text-sm font-semibold text-slate-800">
                    {weeklyChart == null
                      ? "—"
                      : `${weeklyChart
                          .reduce((s, b) => s + b.value, 0)
                          .toLocaleString("pt-PT")} unidades`}
                  </div>
                </div>

                <div className="text-right">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                    Cobertura média
                  </div>
                  <div className="mt-1 text-sm font-semibold text-slate-800">
                    {fmtCoverage(coverageAvgDays)}
                  </div>
                </div>
              </div>

              {weeklyChart == null ? (
                <div className="mb-3 flex h-24 items-center justify-center rounded-xl border border-dashed border-slate-200 bg-white/60 text-[12px] text-slate-500">
                  Sem dados de vendas no período.
                </div>
              ) : (
                <>
                  <WeeklyChart buckets={weeklyChart} />
                  <div className="grid grid-cols-7 text-center text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                    {weeklyChart.map((b, i) => (
                      <span key={i}>{b.dayLabel}</span>
                    ))}
                  </div>
                </>
              )}

              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                <SubCard
                  label="Cobertura baixa"
                  value={`${lowCoverageCount.toLocaleString("pt-PT")} ${
                    lowCoverageCount === 1 ? "referência" : "referências"
                  } abaixo de 7 dias`}
                />
                <SubCard
                  label="Rotação desigual"
                  value={`${highVarianceCount.toLocaleString("pt-PT")} ${
                    highVarianceCount === 1 ? "referência" : "referências"
                  } com diferença > 2,5×`}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function KpiCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-[20px] border border-white/70 bg-white/78 p-4 shadow-[0_10px_30px_rgba(15,23,42,0.04)] backdrop-blur-md">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600">
        {icon}
      </div>
      <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-400">
        {label}
      </div>
      <div className="mt-1 text-sm font-semibold text-slate-800">{value}</div>
    </div>
  );
}

function TransferRow({ t }: { t: DashboardHeroTopSuggestion }) {
  return (
    <div className="rounded-xl border border-white/80 bg-white/82 px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-slate-800">
            {t.produto}
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-[12px] text-slate-500">
            <span className="font-medium text-slate-700">{t.farmaciaOrigem}</span>
            <ArrowRight className="h-3 w-3 text-slate-400" />
            <span className="font-medium text-slate-700">{t.farmaciaDestino}</span>
            <span className="text-slate-300">·</span>
            <span>{t.quantidadeSugerida.toLocaleString("pt-PT")} un.</span>
          </div>
        </div>
        <span
          className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
            PRIORITY_COLOR[t.prioridade] ?? PRIORITY_COLOR.baixa
          }`}
        >
          {PRIORITY_LABEL[t.prioridade] ?? t.prioridade}
        </span>
      </div>
    </div>
  );
}

function WeeklyChart({ buckets }: { buckets: DashboardHeroDayBucket[] }) {
  const max = Math.max(1, ...buckets.map((b) => b.value));
  const MAX_PX = 84;
  return (
    <div className="mb-3 flex h-24 items-end gap-2">
      {buckets.map((b, i) => {
        const heightPx = Math.max(2, Math.round((b.value / max) * MAX_PX));
        return (
          <div key={i} className="flex flex-1 flex-col items-center gap-2">
            <div
              title={`${b.date}: ${b.value.toLocaleString("pt-PT")} un.`}
              className="w-full rounded-t-full bg-gradient-to-t from-emerald-500/75 to-emerald-300/35"
              style={{ height: `${heightPx}px` }}
            />
          </div>
        );
      })}
    </div>
  );
}

function SubCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/80 bg-white/82 px-3 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
        {label}
      </div>
      <div className="mt-1 text-sm font-semibold text-slate-800">{value}</div>
    </div>
  );
}
