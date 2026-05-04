"use client";

import { useState } from "react";
import { Activity, TrendingDown, TrendingUp } from "lucide-react";
import type {
  DashboardData,
  DashboardMonthlyTrend,
  DashboardPharmacyTrend,
} from "@/lib/dashboard";

/**
 * Client-only TendenciaCard.
 *
 * Renderiza o gráfico de tendência com:
 *   · Filtro Grupo / por-farmácia (pílulas) — afecta SÓ este card.
 *   · Barras arredondadas (estilo executivo, restaurado), com a barra
 *     do mês seleccionado em destaque.
 *   · KPI grande do mês seleccionado + % MoM vs mês anterior.
 *   · Linha secundária com o "Mês actual" quando o utilizador
 *     selecciona um mês diferente.
 *
 * Server/client boundary: este ficheiro NÃO importa `@/lib/dashboard`
 * em runtime — só `import type`, que TypeScript apaga em compilação.
 * Os dados (incluindo a série por-farmácia) chegam todos via prop
 * `data` do server component pai.
 */

const ALL = "__all__" as const;
type FilterId = typeof ALL | string;

const CARD_CLASS = "rounded-2xl border border-slate-100 bg-white";

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

function seriesHasData(s: DashboardMonthlyTrend[] | null | undefined): boolean {
  return s != null && s.some((b) => b.valorTotal > 0);
}

export function TendenciaCard({ data }: { data: DashboardData["trend"] }) {
  const { monthlyTrend, byPharmacy } = data;

  const [filterId, setFilterId] = useState<FilterId>(ALL);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);

  // Série activa consoante o filtro escolhido.
  const activeSeries: DashboardMonthlyTrend[] | null =
    filterId === ALL
      ? monthlyTrend
      : byPharmacy.find((p) => p.farmaciaId === filterId)?.monthlyTrend ?? null;

  const showFilter = byPharmacy.length >= 2;

  return (
    <section className={`${CARD_CLASS} p-5`}>
      <header className="flex items-start justify-between gap-3 pb-4">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700">
            <Activity className="h-4 w-4" />
          </div>
          <div>
            <h2 className="text-[16px] font-semibold leading-tight text-slate-900">
              Tendência operacional
            </h2>
            <p className="mt-0.5 text-[12px] text-slate-400">
              Vendas nos últimos 12 meses
            </p>
          </div>
        </div>
      </header>

      {showFilter && (
        <FarmaciaFilter
          farmacias={byPharmacy}
          activeId={filterId}
          onChange={(id) => {
            setFilterId(id);
            // Mantém o índice de mês seleccionado entre filtros (mesma posição
            // temporal); reset apenas se o utilizador ainda não escolheu mês.
          }}
        />
      )}

      <div className={showFilter ? "mt-4" : ""}>
        {seriesHasData(activeSeries) ? (
          <TrendBody
            series={activeSeries as DashboardMonthlyTrend[]}
            selectedIdx={selectedIdx}
            onSelectMonth={(i) => setSelectedIdx(i)}
            farmaciaLabel={
              filterId === ALL
                ? null
                : byPharmacy.find((p) => p.farmaciaId === filterId)?.farmaciaNome ??
                  null
            }
          />
        ) : (
          <div className="rounded-lg bg-slate-50 px-3 py-6 text-center text-[12px] text-slate-400">
            Sem dados suficientes
          </div>
        )}
      </div>
    </section>
  );
}

// ─── Filtro de farmácia ─────────────────────────────────────────────────────

function FarmaciaFilter({
  farmacias,
  activeId,
  onChange,
}: {
  farmacias: DashboardPharmacyTrend[];
  activeId: FilterId;
  onChange: (id: FilterId) => void;
}) {
  return (
    <div className="-mx-1 flex flex-wrap items-center gap-1 px-1">
      <FilterPill active={activeId === ALL} onClick={() => onChange(ALL)}>
        Grupo
      </FilterPill>
      {farmacias.map((f) => (
        <FilterPill
          key={f.farmaciaId}
          active={activeId === f.farmaciaId}
          onClick={() => onChange(f.farmaciaId)}
        >
          {f.farmaciaNome}
        </FilterPill>
      ))}
    </div>
  );
}

function FilterPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-2.5 py-1 text-[12px] font-medium transition ${
        active
          ? "bg-emerald-50 text-emerald-700"
          : "bg-slate-50 text-slate-600 hover:bg-slate-100"
      }`}
    >
      {children}
    </button>
  );
}

// ─── Corpo do gráfico ───────────────────────────────────────────────────────

function TrendBody({
  series,
  selectedIdx,
  onSelectMonth,
  farmaciaLabel,
}: {
  series: DashboardMonthlyTrend[];
  selectedIdx: number | null;
  onSelectMonth: (i: number) => void;
  farmaciaLabel: string | null;
}) {
  const lastIdx = series.length - 1;
  const effectiveSelected =
    selectedIdx != null && selectedIdx >= 0 && selectedIdx <= lastIdx
      ? selectedIdx
      : lastIdx;
  const selected = series[effectiveSelected];
  const prev = effectiveSelected > 0 ? series[effectiveSelected - 1] : null;
  const current = series[lastIdx];

  // % MoM do mês seleccionado vs o anterior.
  const mom =
    prev != null && prev.valorTotal > 0
      ? ((selected.valorTotal - prev.valorTotal) / prev.valorTotal) * 100
      : null;

  const max = Math.max(1, ...series.map((b) => b.valorTotal));
  const isCurrentSelected = effectiveSelected === lastIdx;

  return (
    <div className="space-y-4">
      <div>
        <div className="text-[12px] font-medium text-slate-500">
          {isCurrentSelected
            ? `Mês actual (${selected.label})`
            : `${selected.label} ${selected.ano}`}
          {farmaciaLabel && (
            <span className="ml-1 text-slate-400">· {farmaciaLabel}</span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
          <span className="text-[28px] font-semibold leading-none tracking-tight text-slate-900 tabular-nums">
            {fmtEur(selected.valorTotal)}
          </span>
          {mom == null ? (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[12px] font-medium text-slate-500">
              Sem baseline
            </span>
          ) : (
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-medium ${
                mom >= 0
                  ? "bg-emerald-50 text-emerald-700"
                  : "bg-rose-50 text-rose-700"
              }`}
            >
              {mom >= 0 ? (
                <TrendingUp className="h-3 w-3" />
              ) : (
                <TrendingDown className="h-3 w-3" />
              )}
              {fmtPct(mom)}
              {prev && (
                <span className="font-normal opacity-80">vs {prev.label}</span>
              )}
            </span>
          )}
        </div>
        {!isCurrentSelected && (
          <div className="mt-1 text-[12px] text-slate-400">
            Mês actual ({current.label}): {fmtEur(current.valorTotal)}
          </div>
        )}
      </div>

      {/* Bar chart — wider rounded pill bars, click to select */}
      <div>
        <div className="flex h-24 items-end gap-1.5 border-b border-slate-100">
          {series.map((b, i) => {
            const isSelected = i === effectiveSelected;
            const heightPct =
              b.valorTotal > 0
                ? Math.max(4, Math.round((b.valorTotal / max) * 100))
                : 0;
            const ariaCurrent = isSelected ? "true" : undefined;
            return (
              <button
                key={i}
                type="button"
                onClick={() => onSelectMonth(i)}
                aria-current={ariaCurrent}
                title={`${b.label} ${b.ano}: ${fmtEur(b.valorTotal)}`}
                className="group flex h-full flex-1 items-end p-0"
              >
                {heightPct > 0 ? (
                  <div
                    className={`w-full rounded-t-full transition ${
                      isSelected
                        ? "bg-gradient-to-t from-emerald-600 to-emerald-400"
                        : "bg-gradient-to-t from-emerald-500/40 to-emerald-300/20 group-hover:from-emerald-500/60 group-hover:to-emerald-300/30"
                    }`}
                    style={{ height: `${heightPct}%` }}
                  />
                ) : (
                  <div className="h-1 w-full rounded-full bg-slate-100 group-hover:bg-slate-200" />
                )}
              </button>
            );
          })}
        </div>
        <div className="mt-2 flex gap-1.5">
          {series.map((b, i) => (
            <span
              key={i}
              className={`flex-1 text-center text-[12px] ${
                i === effectiveSelected
                  ? "font-medium text-slate-900"
                  : "text-slate-400"
              }`}
            >
              {b.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
