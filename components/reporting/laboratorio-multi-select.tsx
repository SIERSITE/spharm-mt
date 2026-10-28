"use client";

/**
 * components/reporting/laboratorio-multi-select.tsx
 *
 * Multi-selecção de "Laboratório ou grupo" para Vendas/Margens/Inventário e
 * (via `FiltroFabricante`) Excessos/Transferências/Devoluções/Encomendas — só
 * usado no tenant garantia (quando `ReportingFilterOptions.laboratorios` vem
 * populado; ver lib/reporting-filter-options.ts). Nos restantes tenants
 * continua a usar-se `SearchableMultiSelect` (components/reporting/filter-panel.tsx)
 * com `options.fabricantes` tal e qual sempre foi — este componente NUNCA é
 * importado nesse caminho.
 *
 * UMA opção por grupo lógico, "Nome (N variantes)": as variantes (fabricantes
 * integralmente associados ao grupo, com prova gravada) ficam por baixo do
 * grupo — expansíveis, com tooltip, pesquisáveis e seleccionáveis uma a uma.
 * Um fabricante SEM prova de grupo é uma opção própria. Ordem alfabética. Nada
 * de semelhança de nomes: ver `agruparOpcoesLaboratorio`
 * (lib/catalog/laboratorio-filtro.ts, lógica pura e testada).
 *
 * Selecção múltipla: cada valor seleccionado guarda o prefixo
 * `fabricante:<id>` / `grupo:<id>` — nunca infere o tipo pelo texto.
 */
import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import {
  agruparOpcoesLaboratorio,
  descricaoAlcanceLaboratorio,
  nomeDeLaboratorio,
  rotuloTipoLaboratorio,
  valorDeLaboratorio,
  type CatalogoFilterOptionLaboratorio,
  type ItemLaboratorioAgrupado,
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
  const [expandidos, setExpandidos] = useState<Record<string, boolean>>({});

  const itens = useMemo(() => agruparOpcoesLaboratorio(laboratorios, query), [laboratorios, query]);

  function linha(item: ItemLaboratorioAgrupado) {
    const o = item.opcao;
    const valor = valorDeLaboratorio(o);
    const active = selected.includes(valor);
    const temVariantes = item.variantes.length > 0;
    // Pesquisa que bateu numa variante: mostra-a logo, sem obrigar a expandir.
    const aberto = temVariantes && (expandidos[valor] ?? item.variantesCorrespondentes.length > 0);
    const variantesVisiveis = aberto ? (item.variantesCorrespondentes.length > 0 ? item.variantesCorrespondentes : item.variantes) : [];
    return (
      <div key={valor}>
        <div className="flex items-stretch gap-1">
          <button
            type="button"
            onClick={() => onToggle(valor)}
            title={temVariantes ? `Inclui: ${item.variantes.map((v) => v.nome).join("; ")}` : undefined}
            className={[
              "flex min-w-0 flex-1 items-center justify-between gap-2 rounded-lg px-2 py-2 text-left text-[12px] font-medium transition",
              active ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200",
            ].join(" ")}
          >
            <span className="min-w-0">
              <span className="block truncate">{item.rotulo}</span>
              <span className={["block truncate text-[10.5px] font-normal", active ? "text-emerald-50" : "text-slate-500"].join(" ")}>
                {descricaoAlcanceLaboratorio(o)}
              </span>
            </span>
            {active && <span className="shrink-0 text-[11px] font-semibold">✓</span>}
          </button>
          {temVariantes && (
            <button
              type="button"
              aria-expanded={aberto}
              aria-label={aberto ? "Ocultar variantes" : "Ver variantes"}
              onClick={() => setExpandidos((prev) => ({ ...prev, [valor]: !aberto }))}
              className="shrink-0 rounded-lg bg-slate-100 px-2 text-[11px] text-slate-600 hover:bg-slate-200"
            >
              {aberto ? "▾" : "▸"}
            </button>
          )}
        </div>
        {variantesVisiveis.length > 0 && (
          <div className="ml-3 mt-1 space-y-1 border-l border-slate-200 pl-2">
            {variantesVisiveis.map((v) => {
              const valorVariante = `fabricante:${v.id}`;
              const ativa = selected.includes(valorVariante);
              return (
                <button
                  key={valorVariante}
                  type="button"
                  onClick={() => onToggle(valorVariante)}
                  className={[
                    "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[11.5px] transition",
                    ativa ? "bg-emerald-600 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50",
                  ].join(" ")}
                >
                  <span className="min-w-0 truncate">{v.nome}</span>
                  <span className="shrink-0 text-[10.5px] opacity-80">
                    {v.produtos.toLocaleString("pt-PT")} {v.produtos === 1 ? "produto" : "produtos"}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
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
            placeholder="Pesquisar laboratório, grupo ou variante..."
            className="h-9 w-full rounded-lg border border-slate-200 bg-slate-50 pl-9 pr-3 text-[13px] text-slate-700 outline-none transition focus:border-emerald-300 focus:bg-white"
          />
        </div>

        <div className="mt-2 max-h-56 space-y-1 overflow-y-auto">
          {itens.map(linha)}

          {itens.length === 0 && (
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
