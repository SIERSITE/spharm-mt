"use client";

/**
 * components/reporting/filtro-fabricante.tsx
 *
 * Filtro "Fabricante" das listas operacionais (Excessos, Transferências, Devoluções, Encomendas, proposta de nova
 * Encomenda). Em garantia (`laboratorios` povoado) é o MESMO "Laboratório ou grupo" agrupado de Vendas/Margens/
 * Inventário (valores `grupo:<id>`/`fabricante:<id>`); nos restantes tenants é o `SearchableMultiSelect` de sempre com
 * `fabricantes` — comportamento EXACTAMENTE igual ao anterior.
 */
import { SearchableMultiSelect } from "@/components/reporting/filter-panel";
import { LaboratorioMultiSelect, rotuloLaboratorioSelecionado } from "@/components/reporting/laboratorio-multi-select";
import type { CatalogoFilterOptionLaboratorio } from "@/lib/catalog/laboratorio-filtro";

export function FiltroFabricante({
  label = "Fabricante",
  fabricantes,
  laboratorios,
  selected,
  onToggle,
}: {
  label?: string;
  fabricantes: string[];
  laboratorios?: CatalogoFilterOptionLaboratorio[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  if (laboratorios && laboratorios.length > 0) {
    return <LaboratorioMultiSelect laboratorios={laboratorios} selected={selected} onToggle={onToggle} />;
  }
  return <SearchableMultiSelect label={label} options={fabricantes} selected={selected} onToggle={onToggle} />;
}

/** Texto do chip de uma selecção: "Grupo: X"/"Fabricante: Y" em garantia; "Fabricante: <nome>" nos restantes (inalterado). */
export function rotuloChipFabricante(item: string, laboratorios?: CatalogoFilterOptionLaboratorio[]): string {
  if (laboratorios && laboratorios.length > 0) {
    const r = rotuloLaboratorioSelecionado(item, laboratorios);
    return r === item ? `Fabricante: ${item}` : r;
  }
  return `Fabricante: ${item}`;
}
