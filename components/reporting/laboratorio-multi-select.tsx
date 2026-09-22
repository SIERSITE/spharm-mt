"use client";

/**
 * components/reporting/laboratorio-multi-select.tsx
 *
 * Multi-selecção de "Laboratório ou grupo" para Vendas/Margens/Inventário
 * — só usado no tenant garantia (quando `ReportingFilterOptions.laboratorios`
 * vem populado; ver lib/reporting-filter-options.ts). Nos restantes
 * tenants, `ReportFiltersBar`/`VendasClient` continuam a usar
 * `SearchableMultiSelect` (components/reporting/filter-panel.tsx) com
 * `options.fabricantes` tal e qual sempre foi — este componente NUNCA é
 * importado nesse caminho.
 *
 * Reaproveita a lógica pura de lib/catalog/laboratorio-filtro.ts
 * (`pesquisarLaboratorios`, `valorDeLaboratorio`, `rotuloTipoLaboratorio`,
 * `descricaoAlcanceLaboratorio`) — a MESMA usada pelo catálogo, para as
 * duas superfícies nunca poderem divergir sobre o que "Fabricante: X" ou
 * "Grupo: Y" significam.
 *
 * Selecção múltipla: cada valor seleccionado guarda o prefixo
 * `fabricante:<id>` / `grupo:<id>` — nunca infere o tipo pelo texto.
 */
import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import {
  descricaoAlcanceLaboratorio,
  nomeDeLaboratorio,
  pesquisarLaboratorios,
  rotuloTipoLaboratorio,
  valorDeLaboratorio,
  type CatalogoFilterOptionLaboratorio,
} from "@/lib/catalog/laboratorio-filtro";

export function LaboratorioMultiSelect({
  laboratorios,
  selected,
  onToggle,
}: {
  laboratorios: CatalogoFilterOptionLaboratorio[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  const [query, setQuery] = useState("");

  const resultados = useMemo(() => pesquisarLaboratorios(laboratorios, query), [laboratorios, query]);
  const grupos = resultados.filter((o) => o.tipo === "grupo");
  const fabricantes = resultados.filter((o) => o.tipo === "fabricante");
  const duasSeccoes = grupos.length > 0 && fabricantes.length > 0;

  function linha(o: CatalogoFilterOptionLaboratorio) {
    const valor = valorDeLaboratorio(o);
    const active = selected.includes(valor);
    return (
      <button
        key={valor}
        type="button"
        onClick={() => onToggle(valor)}
        className={[
          "flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-left text-[12px] font-medium transition",
          active ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200",
        ].join(" ")}
      >
        <span className="min-w-0">
          <span className="block truncate">{nomeDeLaboratorio(o)}</span>
          <span className={["block truncate text-[10.5px] font-normal", active ? "text-emerald-50" : "text-slate-500"].join(" ")}>
            {descricaoAlcanceLaboratorio(o)}
          </span>
        </span>
        {active && <span className="shrink-0 text-[11px] font-semibold">✓</span>}
      </button>
    );
  }

  return (
    <div>
      <div className="mb-1 text-[11px] font-medium text-slate-500">Laboratório ou grupo</div>

      <div className="rounded-xl border border-slate-200 bg-white p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Pesquisar laboratório ou grupo..."
            className="h-9 w-full rounded-lg border border-slate-200 bg-slate-50 pl-9 pr-3 text-[13px] text-slate-700 outline-none transition focus:border-emerald-300 focus:bg-white"
          />
        </div>

        <div className="mt-2 max-h-56 space-y-2 overflow-y-auto">
          {duasSeccoes ? (
            <>
              <div>
                <div className="mb-1 px-1 text-[10.5px] font-semibold uppercase tracking-wide text-slate-400">Grupos relacionados</div>
                <div className="space-y-1">{grupos.map(linha)}</div>
              </div>
              <div>
                <div className="mb-1 px-1 text-[10.5px] font-semibold uppercase tracking-wide text-slate-400">Fabricantes</div>
                <div className="space-y-1">{fabricantes.map(linha)}</div>
              </div>
            </>
          ) : (
            <div className="space-y-1">{resultados.map(linha)}</div>
          )}

          {resultados.length === 0 && (
            <div className="rounded-lg border border-dashed border-slate-200 px-3 py-3 text-[12px] text-slate-500">Sem resultados.</div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Etiqueta "Fabricante: X" / "Grupo: Y" para um valor seleccionado — usada nos chips (FilterPill). */
export function rotuloLaboratorioSelecionado(valor: string, laboratorios: readonly CatalogoFilterOptionLaboratorio[]): string {
  const opcao = laboratorios.find((o) => valorDeLaboratorio(o) === valor);
  if (!opcao) return valor;
  return `${rotuloTipoLaboratorio(opcao)}: ${nomeDeLaboratorio(opcao)}`;
}
