"use client";

/**
 * components/reporting/report-filters-bar.tsx
 *
 * Barra completa de filtros canónicos para relatórios operacionais.
 * Controlled — o cliente do relatório passa `value` e `onChange` e
 * recebe alterações imediatas. NÃO contém botão "Gerar" porque cada
 * relatório decide quando disparar o loader (alguns são lazy, outros
 * podem ser auto-refresh).
 *
 * Reaproveita:
 *   · `<FilterSelect>` para os multi-selects (chevron + checkboxes)
 *   · `SharedReportFilters` como tipo do estado
 *   · `ReportFilterOptions` como universo de opções
 *
 * Conteúdo idêntico ao bloco hard-coded dos clients existentes —
 * search (icon lupa), Desde, Até, depois 4 multi-selects (farmácia,
 * categoria, fabricante, distribuidor). A flag `apenasSemClassif`
 * aparece como toggle inline quando `options.semClassificacao=true`.
 *
 * Props ocultas opcionais:
 *   · hideDates    — Inventário "stock actual" não tem período
 *   · hidePeriodLabel — quem queira sobrepor o título acima das datas
 */
import { Search } from "lucide-react";
import { FilterSelect } from "./filter-select";
import type {
  ReportFilterOptions,
  SharedReportFilters,
} from "@/lib/reporting/filters-shared";
import {
  DEFAULT_INCLUIR_CREDITO,
  DEFAULT_INCLUIR_TRANSFERENCIAS,
  rotuloNaturezas,
} from "@/lib/reporting/natureza-venda";

type Props = {
  options: ReportFilterOptions;
  value: SharedReportFilters;
  onChange: (next: SharedReportFilters) => void;
  /** Esconde Desde/Até quando o relatório é "snapshot actual" (ex: Inventário). */
  hideDates?: boolean;
  /** Placeholder customizável para o input de pesquisa. */
  searchPlaceholder?: string;
  /**
   * Mostra os interruptores de crédito / guias de transferência.
   *
   * Só faz sentido onde há vendas: o Inventário é um snapshot de stock e
   * não tem naturezas para ligar ou desligar.
   */
  mostrarNaturezas?: boolean;
};

export function ReportFiltersBar({
  options,
  value,
  onChange,
  hideDates = false,
  searchPlaceholder = "Pesquisar produto, CNP, fornecedor ou fabricante",
  mostrarNaturezas = false,
}: Props) {
  const patch = (delta: Partial<SharedReportFilters>) => onChange({ ...value, ...delta });

  // As subcategorias visíveis acompanham a categoria escolhida: com
  // "MEDICAMENTOS" seleccionado, oferecer "Solares" seria oferecer uma
  // combinação que devolve zero linhas. Sem categoria escolhida, todas.
  const subcategoriasVisiveis = (
    value.categorias && value.categorias.length > 0
      ? options.subcategorias.filter((s) => value.categorias!.includes(s.categoria))
      : options.subcategorias
  ).map((s) => s.nome);

  // O filtro viaja em SLUG (estável entre bases) mas mostra-se pelo nome.
  const utilizacaoNomes = options.utilizacoes.map((u) => u.nome);
  const slugPorNome = new Map(options.utilizacoes.map((u) => [u.nome, u.slug]));
  const nomePorSlug = new Map(options.utilizacoes.map((u) => [u.slug, u.nome]));

  return (
    <section className="rounded-[16px] border border-slate-200/60 bg-white/72 p-3.5 shadow-[0_14px_30px_rgba(15,23,42,0.045)]">
      {/* Linha 1: search + datas (datas escondidas em snapshot mode) */}
      <div
        className={
          hideDates
            ? "grid gap-3 md:grid-cols-1"
            : "grid gap-3 md:grid-cols-[1.5fr_160px_160px]"
        }
      >
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={value.pesquisa ?? ""}
            onChange={(e) => patch({ pesquisa: e.target.value })}
            placeholder={searchPlaceholder}
            className="h-10 w-full rounded-[12px] border border-slate-200 bg-white pl-9 pr-3 text-[13px] text-slate-700 outline-none focus:border-emerald-200"
          />
        </div>
        {!hideDates && (
          <>
            <input
              type="date"
              value={value.from ?? ""}
              onChange={(e) => patch({ from: e.target.value || undefined })}
              className="h-10 rounded-[12px] border border-slate-200 bg-white px-3 text-[12px] text-slate-700 outline-none focus:border-emerald-200"
              aria-label="Desde"
            />
            <input
              type="date"
              value={value.to ?? ""}
              onChange={(e) => patch({ to: e.target.value || undefined })}
              className="h-10 rounded-[12px] border border-slate-200 bg-white px-3 text-[12px] text-slate-700 outline-none focus:border-emerald-200"
              aria-label="Até"
            />
          </>
        )}
      </div>

      {/* Linha 2: catálogo — farmácia, os DOIS níveis, e utilização.
          Categoria e subcategoria são selects separados de propósito: são
          níveis diferentes, e tratá-los como um só foi o defeito que isto
          corrige. */}
      <div className="mt-3 grid gap-3 md:grid-cols-4">
        <FilterSelect
          label="Farmácia"
          options={options.farmacias}
          selected={value.farmaciaNomes ?? []}
          onChange={(v) => patch({ farmaciaNomes: v })}
        />
        <FilterSelect
          label="Categoria"
          options={options.categorias}
          selected={value.categorias ?? []}
          onChange={(v) => patch({ categorias: v })}
        />
        <FilterSelect
          label="Subcategoria"
          options={subcategoriasVisiveis}
          selected={value.subcategorias ?? []}
          onChange={(v) => patch({ subcategorias: v })}
        />
        <FilterSelect
          label="Utilização"
          options={utilizacaoNomes}
          selected={(value.utilizacoes ?? []).map((s) => nomePorSlug.get(s) ?? s)}
          onChange={(nomes) =>
            patch({ utilizacoes: nomes.map((n) => slugPorNome.get(n) ?? n) })
          }
        />
      </div>

      {/* Linha 3: proveniência comercial. */}
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <FilterSelect
          label="Fabricante"
          options={options.fabricantes}
          selected={value.fabricantes ?? []}
          onChange={(v) => patch({ fabricantes: v })}
        />
        <FilterSelect
          label="Distribuidor"
          options={options.distribuidores}
          selected={value.distribuidores ?? []}
          onChange={(v) => patch({ distribuidores: v })}
        />
      </div>

      {/* Toggle "apenas sem classificação" — só aparece se houver
          produtos sem classif. canónica no tenant. Evita poluir UI
          quando não é relevante. */}
      {options.semClassificacao && (
        <label className="mt-3 inline-flex cursor-pointer items-center gap-2 text-[12px] text-slate-600">
          <input
            type="checkbox"
            checked={!!value.apenasSemClassif}
            onChange={(e) => patch({ apenasSemClassif: e.target.checked || undefined })}
            className="h-3.5 w-3.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
          />
          <span>Apenas produtos sem classificação canónica</span>
        </label>
      )}

      {/* Os dois interruptores do relatório oficial do SPharm.
          Os defaults são os do relatório contra o qual reconciliamos —
          crédito Sim, transferências Não — e são explícitos aqui para
          que ninguém tenha de adivinhar o que está a ver. Um total já
          somado não se desligava: a natureza vive até à query. */}
      {mostrarNaturezas && (
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
          <label className="inline-flex cursor-pointer items-center gap-2 text-[12px] text-slate-600">
            <input
              type="checkbox"
              checked={value.incluirCredito ?? DEFAULT_INCLUIR_CREDITO}
              onChange={(e) => patch({ incluirCredito: e.target.checked })}
              className="h-3.5 w-3.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
            />
            <span>Incluir vendas a crédito</span>
          </label>
          <label className="inline-flex cursor-pointer items-center gap-2 text-[12px] text-slate-600">
            <input
              type="checkbox"
              checked={value.incluirTransferencias ?? DEFAULT_INCLUIR_TRANSFERENCIAS}
              onChange={(e) => patch({ incluirTransferencias: e.target.checked })}
              className="h-3.5 w-3.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
            />
            <span>Incluir guias de transferência</span>
          </label>
          <span className="text-[11px] text-slate-400">{rotuloNaturezas(value)}</span>
        </div>
      )}
    </section>
  );
}
