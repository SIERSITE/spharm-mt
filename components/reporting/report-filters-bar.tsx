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

type Props = {
  options: ReportFilterOptions;
  value: SharedReportFilters;
  onChange: (next: SharedReportFilters) => void;
  /** Esconde Desde/Até quando o relatório é "snapshot actual" (ex: Inventário). */
  hideDates?: boolean;
  /** Placeholder customizável para o input de pesquisa. */
  searchPlaceholder?: string;
};

export function ReportFiltersBar({
  options,
  value,
  onChange,
  hideDates = false,
  searchPlaceholder = "Pesquisar produto, CNP, fornecedor ou fabricante",
}: Props) {
  const patch = (delta: Partial<SharedReportFilters>) => onChange({ ...value, ...delta });

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

      {/* Linha 2: 4 multi-selects */}
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
    </section>
  );
}
