import type { PipelineRow, PipelineState } from "@/lib/pipeline-freshness";

/**
 * Cartão compacto "Cobertura por pipeline" — uma linha por pipeline,
 * estado visual + hint operacional. Server component (sem hooks).
 *
 * Aparece ACIMA do extrato. Resolve o gap "agregação parou em Out/2024
 * mas staging foi até Mai/2026 e ninguém viu" — agora aparece como
 * âmbar "X dias por agregar".
 */

const STATE_STYLES: Record<
  PipelineState,
  { dot: string; label: string; row: string; badge?: string }
> = {
  ok: {
    dot: "bg-emerald-500",
    label: "text-emerald-700",
    row: "",
  },
  stale: {
    dot: "bg-amber-500",
    label: "text-amber-700",
    row: "bg-amber-50/60",
    badge: "Por agregar",
  },
  empty: {
    dot: "bg-slate-300",
    label: "text-slate-500",
    row: "",
    badge: "Sem dados",
  },
  "not-implemented": {
    dot: "bg-slate-200",
    label: "text-slate-400",
    row: "",
    badge: "N/A",
  },
};

export function CoberturaPipelines({ rows }: { rows: PipelineRow[] }) {
  // Resumo curto no header: contar quantas em cada estado.
  const counts = rows.reduce(
    (acc, r) => ({ ...acc, [r.state]: (acc[r.state] ?? 0) + 1 }),
    {} as Record<PipelineState, number>,
  );
  const anyStale = (counts.stale ?? 0) > 0;
  const summary = anyStale
    ? `${counts.stale} pipeline(s) com agregação por correr`
    : `${counts.ok ?? 0} pipeline(s) operacionais` +
      (counts.empty || counts["not-implemented"]
        ? ` · ${(counts.empty ?? 0) + (counts["not-implemented"] ?? 0)} sem dados`
        : "");

  return (
    <section className="rounded-[16px] border border-slate-200/60 bg-white/72 px-4 py-3 shadow-[0_14px_30px_rgba(15,23,42,0.045)]">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-[14px] font-semibold text-slate-900">Cobertura por pipeline</h2>
        <span className={`text-[11px] ${anyStale ? "text-amber-700" : "text-slate-500"}`}>{summary}</span>
      </div>
      <ul className="divide-y divide-slate-100">
        {rows.map((r) => {
          const s = STATE_STYLES[r.state];
          return (
            <li
              key={r.key}
              className={`flex items-center justify-between gap-3 px-2 py-1.5 text-[12px] ${s.row}`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className={`inline-block h-2 w-2 rounded-full ${s.dot}`} aria-hidden="true" />
                <span className={`font-medium ${s.label} shrink-0`}>{r.label}</span>
                <span className="text-slate-500 truncate">{r.hint}</span>
              </div>
              {s.badge && (
                <span
                  className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                    r.state === "stale"
                      ? "border-amber-300 bg-amber-100 text-amber-800"
                      : "border-slate-200 bg-slate-50 text-slate-500"
                  }`}
                >
                  {s.badge}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
