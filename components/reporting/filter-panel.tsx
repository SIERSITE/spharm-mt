"use client";

/**
 * components/reporting/filter-panel.tsx
 *
 * As peças do padrão de filtros do Vendas — a UX de referência escolhida
 * para uniformizar Vendas/Margens/Inventário: um "Filtros" que expande/
 * colapsa um painel avançado, um contador de eixos activos no próprio
 * botão, cada dimensão como pesquisa+multi-selecção, selecções activas
 * como chips removíveis, e um botão "Limpar filtros" com alcance
 * explícito (repõe critérios de filtragem, mantém o período).
 *
 * Extraído verbatim de `components/vendas/vendas-client.tsx` (onde
 * viviam como funções locais não exportadas) para que Margens e
 * Inventário deixem de precisar de "três implementações quase iguais"
 * do mesmo mecanismo — Vendas passou a IMPORTAR estas peças em vez de
 * as definir localmente; nenhum comportamento do Vendas mudou.
 *
 * O que fica FORA daqui de propósito, para não sobre-abstrair um
 * mecanismo que cada relatório usa de forma ligeiramente diferente:
 *   · o LAYOUT da barra (que campos ficam na linha 1, que grelha usam
 *     os filtros avançados) — cada relatório continua dono do seu
 *     próprio JSX de disposição, só reaproveita as peças;
 *   · a REGRA de quais eixos contam / o que "Limpar filtros" repõe —
 *     essa vive em `lib/reporting/filters-shared.ts`
 *     (`contarFiltrosAtivos`/`limparFiltrosPreservandoData`), pura e
 *     sem React, precisamente para poder ser partilhada também pelo
 *     Vendas, cujo estado de filtros NÃO é um único objecto
 *     `SharedReportFilters` (é uma dezena de `useState` separados).
 */
import { useMemo, useState } from "react";
import { ChevronDown, Eraser, Filter, Search, X } from "lucide-react";

/** Acrescenta/remove `valor` de `selecionados` — a única regra de toggle de uma multi-selecção, para nunca haver uma cópia divergente por relatório. */
export function alternarValor(valor: string, selecionados: readonly string[]): string[] {
  return selecionados.includes(valor)
    ? selecionados.filter((v) => v !== valor)
    : [...selecionados, valor];
}

/** Uma dimensão (farmácia, fabricante, categoria, ...) como pesquisa + lista de botões toggle. */
export function SearchableMultiSelect({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: string[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  const [query, setQuery] = useState("");

  const filteredOptions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((option) => option.toLowerCase().includes(q));
  }, [options, query]);

  return (
    <div>
      <div className="mb-1 text-[11px] font-medium text-slate-500">{label}</div>

      <div className="rounded-xl border border-slate-200 bg-white p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Pesquisar ${label.toLowerCase()}...`}
            className="h-9 w-full rounded-lg border border-slate-200 bg-slate-50 pl-9 pr-3 text-[13px] text-slate-700 outline-none transition focus:border-emerald-300 focus:bg-white"
          />
        </div>

        <div className="mt-2 max-h-44 space-y-1 overflow-y-auto">
          {filteredOptions.map((option) => {
            const active = selected.includes(option);
            return (
              <button
                key={option}
                type="button"
                onClick={() => onToggle(option)}
                className={[
                  "flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-[12px] font-medium transition",
                  active
                    ? "bg-emerald-600 text-white"
                    : "bg-slate-100 text-slate-700 hover:bg-slate-200",
                ].join(" ")}
              >
                <span className="truncate">{option}</span>
                {active && <span className="ml-2 text-[11px] font-semibold">✓</span>}
              </button>
            );
          })}

          {filteredOptions.length === 0 && (
            <div className="rounded-lg border border-dashed border-slate-200 px-3 py-3 text-[12px] text-slate-500">
              Sem resultados.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Um valor seleccionado, com botão para remover — usado dentro do painel "Filtros". */
export function FilterPill({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[12px] text-slate-700">
      {label}
      <button
        type="button"
        onClick={onRemove}
        className="text-slate-400 transition hover:text-slate-700"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

/** Um interruptor de "filtro rápido" — vive FORA do painel "Filtros", sempre visível. */
export function ToggleRow({
  label,
  checked,
  onChange,
  compact = false,
  title,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  compact?: boolean;
  /** Tooltip nativo — usado quando o toggle só faz efeito ao clicar "Gerar". */
  title?: string;
}) {
  return (
    <label
      title={title}
      className={compact ? "flex items-center gap-2.5" : "flex items-center justify-between gap-2.5"}
    >
      <span className="text-[13px] text-slate-700">{label}</span>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={[
          "relative h-5 w-10 rounded-full transition",
          checked ? "bg-emerald-500" : "bg-slate-200",
        ].join(" ")}
      >
        <span
          className={[
            "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition",
            checked ? "left-[20px]" : "left-0.5",
          ].join(" ")}
        />
      </button>
    </label>
  );
}

/**
 * O botão "Filtros N ⌄" que abre/fecha o painel avançado — mesma
 * aparência em Vendas, Margens e Inventário. `contagem` vem sempre de
 * `contarFiltrosAtivos` (lib/reporting/filters-shared.ts) — a mesma
 * regra em qualquer sítio onde este botão apareça.
 */
export function FiltrosToggleButton({
  aberto,
  onToggle,
  contagem,
}: {
  aberto: boolean;
  onToggle: () => void;
  contagem: number;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={[
        "inline-flex h-9 items-center gap-2 rounded-xl border px-3 text-[13px] font-medium transition",
        aberto
          ? "border-emerald-300 bg-emerald-50 text-emerald-700"
          : "border-slate-200 bg-white text-slate-700 hover:border-slate-300",
      ].join(" ")}
    >
      <Filter className="h-3.5 w-3.5" />
      Filtros
      <span className="inline-flex min-w-[18px] items-center justify-center rounded-full bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold text-slate-600">
        {contagem}
      </span>
      <ChevronDown className={["h-3.5 w-3.5 transition", aberto ? "rotate-180" : ""].join(" ")} />
    </button>
  );
}

/**
 * "Limpar filtros" — sempre uma acção SECUNDÁRIA (nunca ao lado de
 * "Gerar" com o mesmo peso visual): repõe os critérios de filtragem,
 * mantém o período. Ver `limparFiltrosPreservandoData` para o alcance
 * exacto do que é reposto.
 */
export function LimparFiltrosButton({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title="Repõe pesquisa, seleções e filtros rápidos. Mantém Data início/Data fim."
      className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-[13px] font-medium text-slate-500 transition hover:border-slate-300 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Eraser className="h-3.5 w-3.5" />
      Limpar filtros
    </button>
  );
}
