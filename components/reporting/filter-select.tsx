"use client";

/**
 * components/reporting/filter-select.tsx
 *
 * Multi-select compacto para barras de filtros de relatórios. Extracção
 * literal do `FilterSelect` que estava duplicado em devolucoes-client,
 * vendas-client, excessos-client, transferencias-client e
 * encomendas-client — mesma assinatura, mesma aparência, mesmo
 * comportamento. Os módulos novos (Inventário, Margens) consomem este
 * componente directamente; os existentes podem migrar mais tarde.
 *
 * Decisões preservadas:
 *   · `<details>/<summary>` para colapsar sem hooks de estado
 *   · Contagem ao lado do label quando há selecção
 *   · Mensagem "sem dados" quando `options` chega vazio
 *   · Estilo idêntico ao dos relatórios existentes (paleta emerald)
 */
export function FilterSelect({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (v: string[]) => void;
}) {
  if (options.length === 0) {
    return (
      <div className="rounded-[12px] border border-slate-100 bg-white/60 p-3 text-[11px] text-slate-400">
        {label}: sem dados
      </div>
    );
  }
  const toggle = (v: string) =>
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  return (
    <details className="rounded-[12px] border border-slate-100 bg-white/70 p-3">
      <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
        {label} {selected.length > 0 && `(${selected.length})`}
      </summary>
      <div className="mt-2 max-h-40 space-y-1 overflow-y-auto">
        {options.map((opt) => (
          <label
            key={opt}
            className="flex cursor-pointer items-center gap-2 text-[12px] text-slate-600"
          >
            <input
              type="checkbox"
              checked={selected.includes(opt)}
              onChange={() => toggle(opt)}
              className="h-3.5 w-3.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
            />
            <span className="truncate">{opt}</span>
          </label>
        ))}
      </div>
    </details>
  );
}
