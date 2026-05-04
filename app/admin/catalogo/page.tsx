import Link from "next/link";
import { AlertTriangle, AlertCircle, Info, Activity, ListChecks } from "lucide-react";
import {
  loadConnectorSummary,
  loadConnectorRouting,
  loadFieldsByConnector,
  loadPipelineSummary,
  loadFieldCoverage,
  loadConflictsSummary,
  computeWarnings,
} from "@/lib/admin/enrichment-metrics";
import { CatalogProductJump } from "@/components/admin/catalog-product-jump";

export const dynamic = "force-dynamic";

const SP_RANGE_DEFAULT = 7;

function fmtPct(v: number, digits = 0): string {
  return `${(v * 100).toFixed(digits)}%`;
}

function fmtAge(d: Date | null): string {
  if (!d) return "nunca";
  const ms = Date.now() - new Date(d).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s atrás`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m atrás`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h atrás`;
  const days = Math.floor(hrs / 24);
  return `${days}d atrás`;
}

function fmtMs(v: number | null): string {
  if (v == null) return "—";
  if (v < 1000) return `${Math.round(v)}ms`;
  return `${(v / 1000).toFixed(1)}s`;
}

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function CatalogOverviewPage({ searchParams }: Props) {
  const sp = await searchParams;
  const rangeParam = Array.isArray(sp.range) ? sp.range[0] : sp.range;
  const daysBack = (() => {
    const n = Number(rangeParam);
    if (!Number.isFinite(n) || n <= 0) return SP_RANGE_DEFAULT;
    return Math.min(Math.max(1, Math.floor(n)), 90);
  })();

  const [
    connectors,
    routed,
    fieldsByConn,
    pipeline,
    coverage,
    conflicts,
  ] = await Promise.all([
    loadConnectorSummary(daysBack),
    Promise.resolve(loadConnectorRouting()),
    loadFieldsByConnector(daysBack),
    loadPipelineSummary(),
    loadFieldCoverage(),
    loadConflictsSummary(),
  ]);

  const warnings = computeWarnings(connectors, routed);

  // Pivot fields-by-connector → matriz {source → {field → count}}
  const matrix = new Map<string, Map<string, number>>();
  const allFields = new Set<string>();
  for (const r of fieldsByConn) {
    let row = matrix.get(r.source);
    if (!row) {
      row = new Map();
      matrix.set(r.source, row);
    }
    row.set(r.field, r.count);
    allFields.add(r.field);
  }
  const fieldsList = Array.from(allFields).sort();

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Saúde do catálogo</h1>
          <p className="mt-1 text-sm text-slate-600">
            Telemetria do pipeline de enriquecimento. Tudo read-only — só medição.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[12px] text-slate-600">
          <CatalogProductJump />
          <div className="flex items-center gap-2">
            <span>Janela:</span>
            {[1, 7, 30, 90].map((n) => (
              <Link
                key={n}
                href={`/admin/catalogo?range=${n}`}
                className={`rounded-lg border px-2.5 py-1 font-medium ${
                  daysBack === n
                    ? "border-cyan-500 bg-cyan-50 text-cyan-700"
                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                {n === 1 ? "24h" : `${n}d`}
              </Link>
            ))}
          </div>
        </div>
      </header>

      {/* Avisos */}
      {warnings.length > 0 && (
        <section className="space-y-2">
          {warnings.map((w, i) => (
            <div
              key={i}
              className={`flex items-start gap-3 rounded-xl border px-4 py-3 ${
                w.level === "error"
                  ? "border-rose-200 bg-rose-50"
                  : w.level === "warn"
                    ? "border-amber-200 bg-amber-50"
                    : "border-slate-200 bg-slate-50"
              }`}
            >
              {w.level === "error" ? (
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
              ) : w.level === "warn" ? (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              ) : (
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
              )}
              <div className="min-w-0 flex-1 text-[13px] text-slate-800">
                {w.source && (
                  <span className="mr-2 rounded bg-white/70 px-1.5 py-0.5 font-mono text-[11px] text-slate-700">
                    {w.source}
                  </span>
                )}
                {w.message}
              </div>
            </div>
          ))}
        </section>
      )}

      {/* Stats macro */}
      <section className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat
          label="Produtos catalogáveis"
          value={pipeline.productsCataloguable}
          hint={
            pipeline.productsInternalNonCataloguable > 0
              ? `+${pipeline.productsInternalNonCataloguable.toLocaleString("pt-PT")} códigos internos excluídos (cnp ≤ 2.000.000)`
              : `Total ${pipeline.productsTotal.toLocaleString("pt-PT")}`
          }
        />
        <Stat
          label="Verificados hoje"
          value={pipeline.productsEnrichedToday}
          tone={pipeline.productsEnrichedToday > 0 ? "ok" : "neutral"}
        />
        <Stat label="Verificados / 7d" value={pipeline.productsEnrichedLast7Days} />
        <Stat label="Verificados / 30d" value={pipeline.productsEnrichedLast30Days} />
        <Stat
          label="Validados manualmente"
          value={pipeline.productsValidatedManually}
          tone="ok"
          hint="Bloqueados contra overrides automáticos"
        />
        <Stat
          label="Precisam revisão"
          value={pipeline.productsNeedsManualReview}
          tone={pipeline.productsNeedsManualReview > 0 ? "warn" : "ok"}
          link={
            pipeline.productsNeedsManualReview > 0
              ? "/admin/catalogo/revisao"
              : undefined
          }
        />
      </section>

      {/* Conflitos */}
      <section className="rounded-2xl border border-slate-200 bg-white px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-[14px] font-semibold text-slate-900">Conflitos & revisão</h2>
            <p className="mt-0.5 text-[12px] text-slate-500">
              Produtos que precisam de decisão manual.
            </p>
          </div>
          <Link
            href="/admin/catalogo/revisao"
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50"
          >
            <ListChecks className="h-3.5 w-3.5" />
            Abrir fila de revisão
          </Link>
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <Stat
            label="FilaRevisao pendente"
            value={conflicts.pendingTotal}
            tone={conflicts.pendingTotal > 0 ? "warn" : "ok"}
          />
          <Stat
            label="Conflitos entre fontes"
            value={conflicts.pendingConflictTipo}
            tone={conflicts.pendingConflictTipo > 0 ? "warn" : "neutral"}
          />
          <Stat
            label="NEEDS_REVIEW recente"
            value={conflicts.recentNeedsReview}
            hint="Produtos verificados nos últimos 7d que ficaram em revisão"
          />
        </div>
      </section>

      {/* Conectores */}
      <section className="rounded-2xl border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <div>
            <h2 className="text-[14px] font-semibold text-slate-900">
              Performance dos conectores · últimos {daysBack}d
            </h2>
            <p className="mt-0.5 text-[12px] text-slate-500">
              Uma row por conector. Conectores routed sem chamadas aparecem com 0s.
            </p>
          </div>
          <Activity className="h-4 w-4 text-slate-400" />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-slate-100 text-left text-[10px] uppercase tracking-wider text-slate-400">
                <th className="px-4 py-2">Conector</th>
                <th className="px-4 py-2 text-right">Chamadas</th>
                <th className="px-4 py-2 text-right">Sucesso</th>
                <th className="px-4 py-2 text-right">No-match</th>
                <th className="px-4 py-2 text-right">Erro</th>
                <th className="px-4 py-2 text-right">Conf. média</th>
                <th className="px-4 py-2 text-right">Latência</th>
                <th className="px-4 py-2">Último sucesso</th>
                <th className="px-4 py-2">Último erro</th>
              </tr>
            </thead>
            <tbody>
              {connectors.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-slate-400">
                    Sem dados.
                  </td>
                </tr>
              ) : (
                connectors.map((c) => (
                  <tr key={c.source} className="border-b border-slate-50 last:border-b-0">
                    <td className="px-4 py-2">
                      <div className="font-mono text-[12px] font-medium text-slate-800">
                        {c.source}
                      </div>
                      {!c.routedAtAll && (
                        <div className="text-[10px] text-amber-600">
                          fora do routing actual
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{c.attempts}</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      <span className="text-emerald-700">{c.successes}</span>
                      <span className="ml-1 text-[10px] text-slate-400">
                        ({fmtPct(c.successRate)})
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-600">
                      {c.noMatches}
                      <span className="ml-1 text-[10px] text-slate-400">
                        ({fmtPct(c.noMatchRate)})
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      <span
                        className={
                          c.errorRate >= 0.2 ? "text-rose-700 font-medium" : "text-slate-600"
                        }
                      >
                        {c.errors}
                      </span>
                      <span className="ml-1 text-[10px] text-slate-400">
                        ({fmtPct(c.errorRate)})
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-700">
                      {c.avgConfidence == null ? "—" : fmtPct(c.avgConfidence, 1)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-500">
                      {fmtMs(c.avgDurationMs)}
                    </td>
                    <td className="px-4 py-2 text-slate-500">{fmtAge(c.lastSuccessAt)}</td>
                    <td className="px-4 py-2 text-slate-500">
                      {c.lastFailureAt ? (
                        <>
                          <div>{fmtAge(c.lastFailureAt)}</div>
                          {c.lastErrorMessage && (
                            <div
                              className="truncate text-[10px] text-rose-600"
                              title={c.lastErrorMessage}
                            >
                              {c.lastErrorMessage}
                            </div>
                          )}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Field coverage */}
      <section className="rounded-2xl border border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-5 py-3">
          <h2 className="text-[14px] font-semibold text-slate-900">
            Cobertura de campos canónicos
          </h2>
          <p className="mt-0.5 text-[12px] text-slate-500">
            Percentagem de produtos não-INATIVOs com cada campo preenchido.
          </p>
        </div>
        <ul className="divide-y divide-slate-50">
          {coverage.map((f) => (
            <li key={f.field} className="grid grid-cols-[1fr_auto] items-center gap-4 px-5 py-2">
              <div>
                <div className="text-[13px] font-medium text-slate-800">{f.field}</div>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                  <div
                    className={`h-full ${
                      f.ratio >= 0.7
                        ? "bg-emerald-500"
                        : f.ratio >= 0.3
                          ? "bg-amber-500"
                          : "bg-rose-400"
                    }`}
                    style={{ width: `${f.ratio * 100}%` }}
                  />
                </div>
              </div>
              <div className="shrink-0 text-right tabular-nums">
                <div className="text-[13px] font-medium text-slate-900">
                  {fmtPct(f.ratio, 1)}
                </div>
                <div className="text-[10px] text-slate-500">
                  {f.filled} / {f.total}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* Field × Source matrix */}
      <section className="rounded-2xl border border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-5 py-3">
          <h2 className="text-[14px] font-semibold text-slate-900">
            Campos devolvidos por fonte · últimos {daysBack}d
          </h2>
          <p className="mt-0.5 text-[12px] text-slate-500">
            Quantas vezes cada fonte devolveu cada campo (apenas SUCCESS). Identifica
            que fonte está a alimentar fabricante / categoria / ATC.
          </p>
        </div>
        {fieldsList.length === 0 ? (
          <div className="px-5 py-6 text-center text-[12px] text-slate-400">
            Sem dados nesta janela.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-slate-100 text-left text-[10px] uppercase tracking-wider text-slate-400">
                  <th className="px-5 py-2">Fonte</th>
                  {fieldsList.map((f) => (
                    <th key={f} className="px-3 py-2 text-right">
                      {f}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from(matrix.entries()).map(([source, row]) => (
                  <tr key={source} className="border-b border-slate-50 last:border-b-0">
                    <td className="px-5 py-2 font-mono text-[12px] text-slate-700">
                      {source}
                    </td>
                    {fieldsList.map((f) => (
                      <td key={f} className="px-3 py-2 text-right tabular-nums">
                        {row.get(f) ?? <span className="text-slate-300">—</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Routing actual */}
      <section className="rounded-2xl border border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-5 py-3">
          <h2 className="text-[14px] font-semibold text-slate-900">
            Routing actual por tipo
          </h2>
          <p className="mt-0.5 text-[12px] text-slate-500">
            Conectores activos em <code className="rounded bg-slate-100 px-1 text-[11px]">CONNECTORS_BY_TYPE</code>.
          </p>
        </div>
        <ul className="divide-y divide-slate-50">
          {routed.map((c) => (
            <li
              key={c.source}
              className="flex flex-wrap items-center justify-between gap-3 px-5 py-2"
            >
              <span className="font-mono text-[12px] font-medium text-slate-800">
                {c.source}
              </span>
              <div className="flex flex-wrap gap-1">
                {c.routedTypes.map((t) => (
                  <span
                    key={t}
                    className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] text-slate-700"
                  >
                    {t}
                  </span>
                ))}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "neutral",
  hint,
  link,
}: {
  label: string;
  value: number | string;
  tone?: "neutral" | "ok" | "warn" | "error";
  hint?: string;
  link?: string;
}) {
  const toneCls = {
    neutral: "border-slate-200 bg-white text-slate-900",
    ok: "border-emerald-200 bg-emerald-50 text-emerald-900",
    warn: "border-amber-200 bg-amber-50 text-amber-900",
    error: "border-rose-200 bg-rose-50 text-rose-900",
  }[tone];
  const inner = (
    <>
      <div className="text-[10px] uppercase tracking-[0.14em] opacity-70">{label}</div>
      <div className="mt-1 text-[22px] font-semibold leading-tight">{value}</div>
      {hint && <div className="mt-0.5 text-[10px] opacity-70">{hint}</div>}
    </>
  );
  if (link) {
    return (
      <Link href={link} className={`block rounded-2xl border px-4 py-3 transition hover:border-cyan-400 ${toneCls}`}>
        {inner}
      </Link>
    );
  }
  return <div className={`rounded-2xl border px-4 py-3 ${toneCls}`}>{inner}</div>;
}
