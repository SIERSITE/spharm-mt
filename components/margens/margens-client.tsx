"use client";

/**
 * components/margens/margens-client.tsx
 *
 * Cliente do relatório de Margens. Três níveis commutáveis:
 *   1. Por produto    — 1 linha por (CNP × farmácia × período)
 *   2. Por categoria  — agregado por categoria canónica
 *   3. Por farmácia   — agregado por farmácia
 *
 * KPIs globais sempre visíveis no topo:
 *   Vendas € · Custo € · Margem € · Margem % · Cobertura
 *
 * Regra dura (per spec):
 *   · Margem % suprimida em vendas sem custo conhecido
 *   · Aviso permanente sobre snapshot de custo
 */

import { useMemo, useState, useTransition } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { ReportFiltersBar } from "@/components/reporting/report-filters-bar";
import { ReportActions } from "@/components/reporting/report-actions";
import { runMargensReport } from "@/app/relatorios/margens/actions";
import type {
  ReportFilterOptions,
  SharedReportFilters,
} from "@/lib/reporting/filters-shared";
import {
  buildMargensProdutoReport,
  buildMargensAggReport,
} from "@/lib/reporting/adapters/margens";
import type {
  MargensResult,
  MargemRow,
  MargensAgg,
  EstadoMargem,
} from "@/lib/margens-data";
import { formatFarmaciaHeader, type FarmaciaInfo } from "@/lib/farmacias-header";
import { AlertTriangle } from "lucide-react";

type Nivel = "produto" | "categoria" | "farmacia";

const MARGEM_LABEL: Record<EstadoMargem, string> = {
  FIAVEL: "Fiável",
  PARCIAL: "Parcial",
  SEM_CUSTO: "Sem custo",
};
const MARGEM_BADGE: Record<EstadoMargem, string> = {
  FIAVEL: "border-emerald-200 bg-emerald-50 text-emerald-700",
  PARCIAL: "border-amber-200 bg-amber-50 text-amber-700",
  SEM_CUSTO: "border-rose-200 bg-rose-50 text-rose-700",
};
const ALL_ESTADOS: EstadoMargem[] = ["FIAVEL", "PARCIAL", "SEM_CUSTO"];

function fmtCurrency(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("pt-PT", { style: "currency", currency: "EUR" });
}
function fmtInt(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("pt-PT");
}
function fmtPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `${n.toLocaleString("pt-PT", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}
function fmtCobertura(f: number): string {
  return `${Math.round(f * 1000) / 10}%`;
}

function startOfYearISO(): string {
  return `${new Date().getUTCFullYear()}-01-01`;
}

export function MargensClient({
  farmaciasInfo,
  filterOptions,
}: {
  farmaciasInfo: FarmaciaInfo[];
  filterOptions: {
    distribuidores: string[];
    fornecedores: string[];
    fabricantes: string[];
    categorias: string[];
    semClassificacao: boolean;
  };
}) {
  const universe: ReportFilterOptions = useMemo(
    () => ({
      farmacias: farmaciasInfo.map((f) => f.nome),
      categorias: filterOptions.categorias,
      fabricantes: filterOptions.fabricantes,
      distribuidores: filterOptions.distribuidores,
      semClassificacao: filterOptions.semClassificacao,
    }),
    [farmaciasInfo, filterOptions],
  );

  const [filters, setFilters] = useState<SharedReportFilters>({
    farmaciaNomes: universe.farmacias,
    from: startOfYearISO(),
    to: new Date().toISOString().slice(0, 10),
  });

  const [nivel, setNivel] = useState<Nivel>("produto");
  const [estadoChip, setEstadoChip] = useState<"todos" | EstadoMargem>("todos");

  const [result, setResult] = useState<MargensResult | null>(null);
  const [hasGenerated, setHasGenerated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleGerar = () => {
    setError(null);
    startTransition(async () => {
      try {
        const r = await runMargensReport(filters);
        setResult(r);
        setHasGenerated(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  const rowsByEstadoProduto = useMemo(() => {
    if (!result) return [];
    if (estadoChip === "todos") return result.porProduto;
    return result.porProduto.filter((r) => r.estado === estadoChip);
  }, [result, estadoChip]);

  const counts = useMemo(() => {
    const c: Record<"todos" | EstadoMargem, number> = {
      todos: result?.porProduto.length ?? 0,
      FIAVEL: 0,
      PARCIAL: 0,
      SEM_CUSTO: 0,
    };
    for (const r of result?.porProduto ?? []) c[r.estado]++;
    return c;
  }, [result]);

  const organization = formatFarmaciaHeader(filters.farmaciaNomes ?? [], farmaciasInfo);

  const buildReport = () => {
    if (nivel === "produto") {
      return buildMargensProdutoReport({
        rows: rowsByEstadoProduto,
        filters,
        universe: {
          farmacias: universe.farmacias,
          categorias: universe.categorias,
          fabricantes: universe.fabricantes,
          distribuidores: universe.distribuidores,
        },
        organization,
      });
    }
    return buildMargensAggReport({
      rows: nivel === "categoria" ? result?.porCategoria ?? [] : result?.porFarmacia ?? [],
      filters,
      universe: {
        farmacias: universe.farmacias,
        categorias: universe.categorias,
        fabricantes: universe.fabricantes,
        distribuidores: universe.distribuidores,
      },
      organization,
      groupBy: nivel === "categoria" ? "categoria" : "farmacia",
    });
  };

  return (
    <AppShell>
      <div className="space-y-5">
        {/* Header + Acções */}
        <section className="flex items-end justify-between gap-3">
          <div>
            <h1 className="text-[20px] font-semibold text-slate-900">Margens</h1>
            <p className="mt-1 text-[12px] text-slate-500">
              Margens operacionais por produto, categoria e farmácia.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleGerar}
              disabled={isPending}
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-emerald-300 bg-emerald-500 px-4 text-[13px] font-semibold text-white shadow-sm transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isPending ? "A gerar…" : "Gerar"}
            </button>
            {result && <ReportActions report={buildReport} />}
          </div>
        </section>

        {/* Aviso permanente sobre snapshot de custo */}
        <section className="flex items-start gap-2 rounded-[12px] border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            Custo estimado a partir do <b>PMC/PUC actual</b> de <code>ProdutoFarmacia</code>.{" "}
            Margem % suprimida em vendas sem custo conhecido (estado{" "}
            <span className="font-semibold">Sem custo</span> ou{" "}
            <span className="font-semibold">Parcial</span>).
          </span>
        </section>

        {/* Filtros canónicos */}
        <ReportFiltersBar
          options={universe}
          value={filters}
          onChange={setFilters}
          searchPlaceholder="Pesquisar CNP ou descrição"
        />

        {error && (
          <section className="rounded-[16px] border border-rose-200 bg-rose-50 px-4 py-3 text-[12px] text-rose-700">
            Falha a gerar Margens: {error}
          </section>
        )}

        {!hasGenerated ? (
          <section className="rounded-[16px] border border-slate-200/60 bg-white/72 px-6 py-16 text-center shadow-[0_14px_30px_rgba(15,23,42,0.045)]">
            <h2 className="text-[15px] font-semibold text-slate-900">
              Nenhum relatório gerado ainda
            </h2>
            <p className="mx-auto mt-2 max-w-[480px] text-[12px] leading-5 text-slate-500">
              Define o período e clica em{" "}
              <span className="font-semibold text-emerald-700">Gerar</span>. A página não
              pré-carrega Margens — só lê da BD após o trigger explícito.
            </p>
          </section>
        ) : (
          <>
            <KPIBar result={result!} />

            {/* Tabs de nível */}
            <div className="flex gap-1.5">
              {(["produto", "categoria", "farmacia"] as Nivel[]).map((n) => {
                const on = nivel === n;
                const label =
                  n === "produto" ? "Por produto" : n === "categoria" ? "Por categoria" : "Por farmácia";
                return (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setNivel(n)}
                    className={`rounded-full border px-4 py-1.5 text-[12px] font-medium transition ${
                      on
                        ? "border-slate-800 bg-slate-800 text-white"
                        : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>

            {/* Chips de estado (apenas Por Produto) */}
            {nivel === "produto" && (
              <div className="flex flex-wrap items-center gap-1.5">
                {(["todos", ...ALL_ESTADOS] as const).map((k) => {
                  const on = estadoChip === k;
                  const label = k === "todos" ? "Todos" : MARGEM_LABEL[k];
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setEstadoChip(k)}
                      className={`rounded-full border px-3 py-1 text-[11px] font-medium transition ${
                        on
                          ? "border-slate-800 bg-slate-800 text-white"
                          : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                      }`}
                    >
                      {label}{" "}
                      <span className={on ? "text-white/70" : "text-slate-400"}>
                        ({counts[k]})
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {nivel === "produto" && <TabelaProduto rows={rowsByEstadoProduto} />}
            {nivel === "categoria" && <TabelaAgg rows={result?.porCategoria ?? []} header="Categoria" />}
            {nivel === "farmacia" && <TabelaAgg rows={result?.porFarmacia ?? []} header="Farmácia" />}
          </>
        )}
      </div>
    </AppShell>
  );
}

// ── KPIs globais ──────────────────────────────────────────────────

function KPIBar({ result }: { result: MargensResult }) {
  const t = result.totals;
  return (
    <section className="grid gap-3 md:grid-cols-5">
      <KPI label="Vendas €" value={fmtCurrency(t.valorVendido)} />
      <KPI label="Custo €" value={fmtCurrency(t.custoEstimado)} />
      <KPI label="Margem €" value={fmtCurrency(t.margemEur)} />
      <KPI
        label="Margem %"
        value={t.margemPct !== null ? fmtPct(t.margemPct) : "—"}
        helper={t.margemPct === null ? "Suprimida — cobertura insuficiente" : undefined}
      />
      <KPI
        label="Cobertura de custo"
        value={fmtCobertura(t.coberturaCusto)}
        helper={MARGEM_LABEL[t.estado]}
        helperTone={t.estado === "FIAVEL" ? "ok" : t.estado === "PARCIAL" ? "warn" : "bad"}
      />
    </section>
  );
}

function KPI({
  label,
  value,
  helper,
  helperTone,
}: {
  label: string;
  value: string;
  helper?: string;
  helperTone?: "ok" | "warn" | "bad";
}) {
  const toneClass =
    helperTone === "ok"
      ? "text-emerald-700"
      : helperTone === "warn"
        ? "text-amber-700"
        : helperTone === "bad"
          ? "text-rose-700"
          : "text-slate-500";
  return (
    <div className="rounded-[14px] border border-slate-200/60 bg-white/80 px-3 py-3 shadow-[0_8px_20px_rgba(15,23,42,0.035)]">
      <div className="text-[10px] uppercase tracking-[0.14em] text-slate-400">{label}</div>
      <div className="mt-1 text-[16px] font-semibold tabular-nums text-slate-900">{value}</div>
      {helper && <div className={`mt-1 text-[10px] ${toneClass}`}>{helper}</div>}
    </div>
  );
}

// ── Tabela Por Produto ────────────────────────────────────────────

function TabelaProduto({ rows }: { rows: MargemRow[] }) {
  if (rows.length === 0) {
    return (
      <section className="rounded-[16px] border border-slate-200/60 bg-white/72 px-6 py-12 text-center text-[12px] text-slate-500">
        Sem produtos para os filtros actuais.
      </section>
    );
  }
  return (
    <section className="rounded-[16px] border border-slate-200/60 bg-white/72 p-3 shadow-[0_14px_30px_rgba(15,23,42,0.045)]">
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-[12px]">
          <thead className="border-b border-slate-200 text-[10px] uppercase tracking-[0.14em] text-slate-500">
            <tr>
              <th className="py-2 pr-3">CNP</th>
              <th className="py-2 pr-3">Descrição</th>
              <th className="py-2 pr-3">Categoria</th>
              <th className="py-2 pr-3">Farmácia</th>
              <th className="py-2 pr-3 text-right">Qtd</th>
              <th className="py-2 pr-3 text-right">Valor vend.</th>
              <th className="py-2 pr-3 text-right">Custo est.</th>
              <th className="py-2 pr-3 text-right">Margem €</th>
              <th className="py-2 pr-3 text-right">Margem %</th>
              <th className="py-2 pr-3 text-right">Cobert.</th>
              <th className="py-2 pr-3">Estado</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={`${r.cnp}:${r.farmaciaId}`}>
                <td className="py-2 pr-3 font-mono text-[11px] text-slate-600">{r.cnp}</td>
                <td className="py-2 pr-3 text-slate-800">{r.designacao}</td>
                <td className="py-2 pr-3 text-slate-600">{r.categoria ?? "—"}</td>
                <td className="py-2 pr-3 text-slate-600">{r.farmacia}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{fmtInt(r.qtdVendida)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{fmtCurrency(r.valorVendido)}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-slate-600">
                  {fmtCurrency(r.custoEstimado)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums font-medium text-slate-800">
                  {fmtCurrency(r.margemEur)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">{fmtPct(r.margemPct)}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-slate-500">
                  {fmtCobertura(r.coberturaCusto)}
                </td>
                <td className="py-2 pr-3">
                  <span
                    className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${MARGEM_BADGE[r.estado]}`}
                  >
                    {MARGEM_LABEL[r.estado]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ── Tabela Agregada (Por Categoria / Por Farmácia) ────────────────

function TabelaAgg({ rows, header }: { rows: MargensAgg[]; header: string }) {
  if (rows.length === 0) {
    return (
      <section className="rounded-[16px] border border-slate-200/60 bg-white/72 px-6 py-12 text-center text-[12px] text-slate-500">
        Sem agregação para os filtros actuais.
      </section>
    );
  }
  return (
    <section className="rounded-[16px] border border-slate-200/60 bg-white/72 p-3 shadow-[0_14px_30px_rgba(15,23,42,0.045)]">
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-[12px]">
          <thead className="border-b border-slate-200 text-[10px] uppercase tracking-[0.14em] text-slate-500">
            <tr>
              <th className="py-2 pr-3">{header}</th>
              <th className="py-2 pr-3 text-right">Qtd</th>
              <th className="py-2 pr-3 text-right">Valor vend.</th>
              <th className="py-2 pr-3 text-right">Custo est.</th>
              <th className="py-2 pr-3 text-right">Margem €</th>
              <th className="py-2 pr-3 text-right">Margem %</th>
              <th className="py-2 pr-3 text-right">Cobert.</th>
              <th className="py-2 pr-3">Estado</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.key}>
                <td className="py-2 pr-3 font-medium text-slate-800">{r.label}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{fmtInt(r.qtdVendida)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{fmtCurrency(r.valorVendido)}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-slate-600">
                  {fmtCurrency(r.custoEstimado)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums font-medium text-slate-800">
                  {fmtCurrency(r.margemEur)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">{fmtPct(r.margemPct)}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-slate-500">
                  {fmtCobertura(r.coberturaCusto)}
                </td>
                <td className="py-2 pr-3">
                  <span
                    className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${MARGEM_BADGE[r.estado]}`}
                  >
                    {MARGEM_LABEL[r.estado]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
