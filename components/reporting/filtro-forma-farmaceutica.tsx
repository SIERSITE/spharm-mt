"use client";

/**
 * components/reporting/filtro-forma-farmaceutica.tsx
 *
 * O filtro «Forma farmacêutica» — UM componente para todos os mapas e listagens de produtos (Vendas, Margens,
 * Inventário, Excessos, Transferências, Stock, Catálogo, proposta de Encomenda). Multi-selecção com pesquisa, ordem
 * alfabética, contagem de produtos por opção e a opção «Sem forma farmacêutica», construído sobre o
 * `SearchableMultiSelect` de sempre (o mesmo de farmácia/categoria/fabricante).
 *
 * O valor que viaja é a CHAVE normalizada (`lib/catalog/forma-farmaceutica-filtro.ts`), nunca o rótulo.
 */
import { useCallback, useMemo } from "react";
import { SearchableMultiSelect, FilterPill } from "@/components/reporting/filter-panel";
import { rotuloDaChaveForma, type OpcaoFormaFarmaceutica } from "@/lib/catalog/forma-farmaceutica-filtro";

export function FiltroFormaFarmaceutica({
  formas,
  selected,
  onToggle,
  label = "Forma farmacêutica",
}: {
  formas: readonly OpcaoFormaFarmaceutica[];
  /** Chaves seleccionadas. */
  selected: string[];
  /** Acrescenta/remove uma CHAVE. */
  onToggle: (chave: string) => void;
  label?: string;
}) {
  const chaves = useMemo(() => formas.map((f) => f.chave), [formas]);
  const porChave = useMemo(() => new Map(formas.map((f) => [f.chave, f])), [formas]);
  const labelOf = useCallback((c: string) => porChave.get(c)?.label ?? rotuloDaChaveForma(c, formas), [porChave, formas]);
  const countOf = useCallback((c: string) => porChave.get(c)?.count, [porChave]);
  return (
    <SearchableMultiSelect
      label={label}
      options={chaves}
      selected={selected}
      onToggle={onToggle}
      labelOf={labelOf}
      countOf={countOf}
      testId="filtro-forma-farmaceutica"
    />
  );
}

/** Texto do chip de uma selecção («Forma: Comprimido revestido»). */
export function rotuloChipForma(chave: string, formas: readonly OpcaoFormaFarmaceutica[]): string {
  return `Forma: ${rotuloDaChaveForma(chave, formas)}`;
}

/** Os chips removíveis das formas seleccionadas — o mesmo `FilterPill` dos outros eixos. */
export function ChipsFormaFarmaceutica({
  formas,
  selected,
  onRemove,
}: {
  formas: readonly OpcaoFormaFarmaceutica[];
  selected: readonly string[];
  onRemove: (chave: string) => void;
}) {
  return (
    <>
      {selected.map((c) => (
        <FilterPill key={`forma-${c}`} label={rotuloChipForma(c, formas)} onRemove={() => onRemove(c)} />
      ))}
    </>
  );
}
