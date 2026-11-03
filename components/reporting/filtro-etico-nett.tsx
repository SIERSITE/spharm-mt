"use client";

/**
 * components/reporting/filtro-etico-nett.tsx
 *
 * O filtro «Ético / NETT» — UM componente para todos os mapas e listagens de produtos (Catálogo, Stock, Vendas,
 * Margens, Inventário, Excessos, Transferências, Encomendas). Multi-selecção sobre o `SearchableMultiSelect` de sempre,
 * com as opções Ético · NETT · Sem classificação · Divergente (+ contagem de produtos).
 *
 * O valor que viaja é o código (`ETICO` | `NETT` | `SEM` | `DIVERGENTE`), nunca o rótulo. O filtro corre no servidor
 * (`restringirPorCatalogo` / `idsProdutosPorEticoNett`), antes de paginação, cortes e totais.
 */
import { useCallback, useMemo } from "react";
import { SearchableMultiSelect, FilterPill } from "@/components/reporting/filter-panel";
import { ROTULO_ETICO_NETT, type ValorFiltroEticoNett } from "@/lib/classificacao/etico-nett";

export type OpcaoFiltroEticoNett = { valor: ValorFiltroEticoNett; count: number };

export function FiltroEticoNett({
  opcoes,
  selected,
  onToggle,
  label = "Ético / NETT",
}: {
  opcoes: readonly OpcaoFiltroEticoNett[];
  selected: string[];
  onToggle: (valor: string) => void;
  label?: string;
}) {
  const valores = useMemo(() => opcoes.map((o) => o.valor as string), [opcoes]);
  const porValor = useMemo(() => new Map(opcoes.map((o) => [o.valor as string, o])), [opcoes]);
  const labelOf = useCallback((v: string) => ROTULO_ETICO_NETT[v as ValorFiltroEticoNett] ?? v, []);
  const countOf = useCallback((v: string) => porValor.get(v)?.count, [porValor]);
  return (
    <SearchableMultiSelect
      label={label}
      options={valores}
      selected={selected}
      onToggle={onToggle}
      labelOf={labelOf}
      countOf={countOf}
      testId="filtro-etico-nett"
    />
  );
}

/** Texto do chip de uma selecção («Ético/NETT: Ético»). */
export function rotuloChipEticoNett(valor: string): string {
  return `Ético/NETT: ${ROTULO_ETICO_NETT[valor as ValorFiltroEticoNett] ?? valor}`;
}

/** Os chips removíveis das selecções — o mesmo `FilterPill` dos outros eixos. */
export function ChipsEticoNett({ selected, onRemove }: { selected: readonly string[]; onRemove: (valor: string) => void }) {
  return (
    <>
      {selected.map((v) => (
        <FilterPill key={`etico-nett-${v}`} label={rotuloChipEticoNett(v)} onRemove={() => onRemove(v)} />
      ))}
    </>
  );
}
