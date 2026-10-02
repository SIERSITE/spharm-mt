"use client";

/**
 * components/reporting/vendas-filtros.tsx
 *
 * Os controlos de filtro do relatório de Vendas, extraídos de
 * `components/vendas/vendas-client.tsx` SEM alterar comportamento nem aspecto,
 * para serem a MESMA implementação em Vendas e na Manutenção em massa do
 * catálogo: campo de pesquisa de produto, datas, painel de filtros avançados
 * (lista de CNP importada, farmácia, distribuidor, fabricante, categoria,
 * subcategoria, utilização, interruptores de natureza) e os chips dos valores
 * activos (remover um a um).
 *
 * Não tem estado próprio: recebe valores e setters (`Dispatch<SetStateAction>`),
 * como o Vendas já os tinha. `rotulos` só muda o TEXTO de um rótulo (a Manutenção
 * chama «Fabricante atual» ao fabricante, para o distinguir do de destino).
 */
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { Search } from "lucide-react";
import {
  FilterPill,
  SearchableMultiSelect,
  alternarValor,
} from "@/components/reporting/filter-panel";
import { LaboratorioMultiSelect, rotuloLaboratorioSelecionado } from "@/components/reporting/laboratorio-multi-select";
import { ImportListaCodigos } from "@/components/reporting/import-lista-codigos";
import type { ListaCodigosResolvida } from "@/lib/produtos/lista-codigos-tipos";
import type { CatalogoFilterOptionLaboratorio } from "@/lib/catalog/laboratorio-filtro";
import { rotuloNaturezas } from "@/lib/reporting/natureza-venda";

export function CompactInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-[11px] font-medium text-slate-500">{label}</div>
      {/* Ícone de lupa — o mesmo padrão visual de SearchableMultiSelect,
          aqui para deixar claro que este é o campo de PESQUISA do
          relatório (CNP ou descrição), não um filtro qualquer.
          O utilizador não estava a perceber que era aqui que se
          escrevia o nome do produto para filtrar. */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
        <input
          type="text"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-full rounded-xl border border-slate-200 bg-white pl-9 pr-3 text-[13px] font-medium text-slate-800 outline-none transition focus:border-emerald-300 focus:ring-4 focus:ring-emerald-100"
        />
      </div>
    </label>
  );
}

export function CompactDate({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-[11px] font-medium text-slate-500">{label}</div>
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full rounded-xl border border-slate-200 bg-white px-3 text-[13px] font-medium text-slate-800 outline-none transition focus:border-emerald-300 focus:ring-4 focus:ring-emerald-100"
      />
    </label>
  );
}

export type VendasFiltrosValores = {
  listaCodigos: ListaCodigosResolvida | null;
  farmacias: string[];
  distribuidores: string[];
  fabricantes: string[];
  categorias: string[];
  subcategorias: string[];
  /** Slugs. */
  utilizacoes: string[];
  incluirCredito: boolean;
  incluirTransferencias: boolean;
};

export type VendasFiltrosSetters = {
  listaCodigos: (v: ListaCodigosResolvida | null) => void;
  farmacias: Dispatch<SetStateAction<string[]>>;
  distribuidores: Dispatch<SetStateAction<string[]>>;
  fabricantes: Dispatch<SetStateAction<string[]>>;
  categorias: Dispatch<SetStateAction<string[]>>;
  subcategorias: Dispatch<SetStateAction<string[]>>;
  utilizacoes: Dispatch<SetStateAction<string[]>>;
  incluirCredito: (v: boolean) => void;
  incluirTransferencias: (v: boolean) => void;
};

export type VendasFiltrosOpcoes = {
  farmacias: string[];
  distribuidores: string[];
  fabricantes: string[];
  laboratorios?: CatalogoFilterOptionLaboratorio[];
  categorias: string[];
  /** Já com a cascata aplicada (só as subcategorias das categorias escolhidas, se houver). */
  subcategorias: string[];
  utilizacoes: Array<{ slug: string; nome: string }>;
};

export function VendasFiltrosPainel({
  opcoes,
  valores,
  set,
  rotulos,
  disabled,
  mostrarNaturezas = true,
  extra,
}: {
  opcoes: VendasFiltrosOpcoes;
  valores: VendasFiltrosValores;
  set: VendasFiltrosSetters;
  rotulos?: { fabricante?: string; distribuidor?: string };
  disabled?: boolean;
  /** A Manutenção só mostra os interruptores de natureza quando o período está activo. */
  mostrarNaturezas?: boolean;
  /** Controlos acrescentados na MESMA grelha (ex.: fornecedor habitual actual, tipo de artigo). */
  extra?: ReactNode;
}) {
  const toggle = (setter: Dispatch<SetStateAction<string[]>>) => (value: string) =>
    setter((prev) => alternarValor(value, prev));
  const nomePorSlug = new Map(opcoes.utilizacoes.map((u) => [u.slug, u.nome]));
  const slugPorNome = new Map(opcoes.utilizacoes.map((u) => [u.nome, u.slug]));
  const rotuloFabricante = rotulos?.fabricante ?? "Fabricante";
  const remover = (setter: Dispatch<SetStateAction<string[]>>, item: string) =>
    setter((prev) => prev.filter((v) => v !== item));

  return (
    <div className="mt-3 rounded-2xl border border-slate-200 bg-white p-3">
      <div className="mb-3">
        <ImportListaCodigos lista={valores.listaCodigos} onChange={set.listaCodigos} disabled={disabled} />
      </div>
      <div className="grid gap-3 xl:grid-cols-4">
        <SearchableMultiSelect
          label="Farmácia"
          options={opcoes.farmacias}
          selected={valores.farmacias}
          onToggle={toggle(set.farmacias)}
        />
        <SearchableMultiSelect
          label={rotulos?.distribuidor ?? "Distribuidor"}
          options={opcoes.distribuidores}
          selected={valores.distribuidores}
          onToggle={toggle(set.distribuidores)}
        />
        {opcoes.laboratorios && opcoes.laboratorios.length > 0 ? (
          <LaboratorioMultiSelect
            laboratorios={opcoes.laboratorios}
            selected={valores.fabricantes}
            onToggle={toggle(set.fabricantes)}
          />
        ) : (
          <SearchableMultiSelect
            label={rotuloFabricante}
            options={opcoes.fabricantes}
            selected={valores.fabricantes}
            onToggle={toggle(set.fabricantes)}
          />
        )}
        <SearchableMultiSelect
          label="Categoria"
          options={opcoes.categorias}
          selected={valores.categorias}
          onToggle={toggle(set.categorias)}
        />
        <SearchableMultiSelect
          label="Subcategoria"
          options={opcoes.subcategorias}
          selected={valores.subcategorias}
          onToggle={toggle(set.subcategorias)}
        />
        {/* Viaja em slug, mostra-se pelo nome. */}
        <SearchableMultiSelect
          label="Utilização"
          options={opcoes.utilizacoes.map((u) => u.nome)}
          selected={valores.utilizacoes.map((s) => nomePorSlug.get(s) ?? s)}
          onToggle={(nome) => {
            const slug = slugPorNome.get(nome) ?? nome;
            set.utilizacoes((prev) => (prev.includes(slug) ? prev.filter((v) => v !== slug) : [...prev, slug]));
          }}
        />
        {extra}
      </div>

      {/* Os dois interruptores do relatório oficial do SPharm. Os defaults —
          crédito ON, transferências OFF — são os do relatório contra o qual
          reconciliamos, e estão à vista para ninguém ter de adivinhar o que
          está a ver. */}
      {mostrarNaturezas && (
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-slate-100 pt-3">
          <label className="inline-flex cursor-pointer items-center gap-2 text-[12px] text-slate-600">
            <input
              type="checkbox"
              checked={valores.incluirCredito}
              onChange={(e) => set.incluirCredito(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
            />
            <span>Incluir vendas a crédito</span>
          </label>
          <label className="inline-flex cursor-pointer items-center gap-2 text-[12px] text-slate-600">
            <input
              type="checkbox"
              checked={valores.incluirTransferencias}
              onChange={(e) => set.incluirTransferencias(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
            />
            <span>Incluir guias de transferência</span>
          </label>
          <span className="text-[11px] text-slate-400">
            {rotuloNaturezas({
              incluirCredito: valores.incluirCredito,
              incluirTransferencias: valores.incluirTransferencias,
            })}
          </span>
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {valores.farmacias.map((item) => (
          <FilterPill key={`farmacia-${item}`} label={item} onRemove={() => remover(set.farmacias, item)} />
        ))}
        {valores.distribuidores.map((item) => (
          <FilterPill key={`fornecedor-${item}`} label={item} onRemove={() => remover(set.distribuidores, item)} />
        ))}
        {valores.fabricantes.map((item) => (
          <FilterPill
            key={`fabricante-${item}`}
            label={opcoes.laboratorios ? rotuloLaboratorioSelecionado(item, opcoes.laboratorios) : item}
            onRemove={() => remover(set.fabricantes, item)}
          />
        ))}
        {valores.categorias.map((item) => (
          <FilterPill key={`categoria-${item}`} label={item} onRemove={() => remover(set.categorias, item)} />
        ))}
        {valores.subcategorias.map((item) => (
          <FilterPill key={`subcategoria-${item}`} label={item} onRemove={() => remover(set.subcategorias, item)} />
        ))}
        {valores.utilizacoes.map((slug) => (
          <FilterPill
            key={`utilizacao-${slug}`}
            label={nomePorSlug.get(slug) ?? slug}
            onRemove={() => remover(set.utilizacoes, slug)}
          />
        ))}
      </div>
    </div>
  );
}
