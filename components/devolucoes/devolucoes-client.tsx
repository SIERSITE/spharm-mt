"use client";

import { useMemo, useState, useTransition } from "react";
import { Search, Building2 } from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";
import { ReportActions } from "@/components/reporting/report-actions";
import { buildDevolucoesReport } from "@/lib/reporting/adapters/devolucoes";
import {
  formatFarmaciaHeader,
  type FarmaciaInfo,
} from "@/lib/farmacias-header";
import type { DevolucaoRow } from "@/lib/devolucoes-data";
import type { ReportingFilterOptions } from "@/lib/reporting-filter-options";
import { runDevolucoesReport } from "@/app/devolucoes/actions";

type Props = {
  farmaciasInfo: FarmaciaInfo[];
  filterOptions: ReportingFilterOptions;
};

const uniqNonEmpty = (xs: string[]) =>
  Array.from(new Set(xs.map((x) => (x ?? "").trim()).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b, "pt-PT")
  );

export function DevolucoesClient({ farmaciasInfo, filterOptions }: Props) {
  // Estado lazy: nada de Devoluções é carregado até clicar em "Gerar".
  const [rows, setRows] = useState<DevolucaoRow[]>([]);
  const [hasGenerated, setHasGenerated] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [generationError, setGenerationError] = useState<string | null>(null);
  const initialRows = rows;

  // Universo dos filtros — tudo eager, vindo do servidor no page open.
  const farmacias = uniqNonEmpty(farmaciasInfo.map((f) => f.nome));
  const fornecedores = filterOptions.fornecedores;
  const fabricantes = filterOptions.fabricantes;
  const categorias = filterOptions.categorias;
  void initialRows;

  const handleGerar = () => {
    setGenerationError(null);
    startTransition(async () => {
      try {
        const result = await runDevolucoesReport({
          from: dateFrom || undefined,
          to: dateTo || undefined,
        });
        setRows(result);
        setHasGenerated(true);
      } catch (err) {
        setGenerationError(err instanceof Error ? err.message : String(err));
        setRows([]);
      }
    });
  };

  const [search, setSearch] = useState("");
  const [farmaciasSelecionadas, setFarmaciasSelecionadas] = useState<string[]>(farmacias);
  const [fornecedoresSelecionados, setFornecedoresSelecionados] = useState<string[]>([]);
  const [fabricantesSelecionados, setFabricantesSelecionados] = useState<string[]>([]);
  const [categoriasSelecionadas, setCategoriasSelecionadas] = useState<string[]>([]);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return initialRows.filter((row) => {
      if (q) {
        const hay = `${row.cnp} ${row.produto} ${row.fornecedor} ${row.fabricante}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (
        farmaciasSelecionadas.length > 0 &&
        !farmaciasSelecionadas.includes(row.farmacia)
      )
        return false;
      if (
        fornecedoresSelecionados.length > 0 &&
        !fornecedoresSelecionados.includes(row.fornecedor)
      )
        return false;
      if (
        fabricantesSelecionados.length > 0 &&
        !fabricantesSelecionados.includes(row.fabricante)
      )
        return false;
      if (
        categoriasSelecionadas.length > 0 &&
        !categoriasSelecionadas.includes(row.categoria)
      )
        return false;
      if (dateFrom && row.data < dateFrom) return false;
      if (dateTo && row.data > dateTo) return false;
      return true;
    });
  }, [
    initialRows,
    search,
    farmaciasSelecionadas,
    fornecedoresSelecionados,
    fabricantesSelecionados,
    categoriasSelecionadas,
    dateFrom,
    dateTo,
  ]);

  const groupedBySupplier = useMemo(() => {
    const groups = new Map<string, DevolucaoRow[]>();
    for (const r of filteredRows) {
      const key = r.fornecedor || "(sem fornecedor)";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(r);
    }
    return Array.from(groups.entries())
      .map(([fornecedor, groupRows]) => {
        // Linhas dentro de cada fornecedor: ordenadas alfabeticamente por
        // descrição do artigo (A-Z, locale pt-PT, case-insensitive). A ordem
        // dos próprios fornecedores mantém-se por valor desc (default
        // operacional). Totais não são afectados pela reordenação.
        const rows = [...groupRows].sort((a, b) =>
          a.produto.localeCompare(b.produto, "pt-PT", { sensitivity: "base" }),
        );
        return {
          fornecedor,
          rows,
          totalQty: rows.reduce((s, r) => s + r.quantidade, 0),
          totalValue: rows.reduce((s, r) => s + r.valor, 0),
          farmaciasCount: new Set(rows.map((r) => r.farmacia)).size,
        };
      })
      .sort((a, b) => b.totalValue - a.totalValue);
  }, [filteredRows]);

  const totals = useMemo(() => {
    return {
      suppliers: groupedBySupplier.length,
      lines: filteredRows.length,
      qty: filteredRows.reduce((s, r) => s + r.quantidade, 0),
      value: filteredRows.reduce((s, r) => s + r.valor, 0),
    };
  }, [filteredRows, groupedBySupplier]);

  const reportSource = () =>
    buildDevolucoesReport({
      rows: filteredRows.map((r) => ({
        data: r.data,
        cnp: r.cnp,
        produto: r.produto,
        farmacia: r.farmacia,
        fornecedor: r.fornecedor,
        fabricante: r.fabricante,
        categoria: r.categoria,
        quantidade: r.quantidade,
        valor: r.valor,
        motivo: r.motivo,
      })),
      filters: {
        search,
        selectedPharmacies: farmaciasSelecionadas,
        selectedSuppliers: fornecedoresSelecionados,
        selectedManufacturers: fabricantesSelecionados,
        selectedCategories: categoriasSelecionadas,
        dateFrom,
        dateTo,
      },
      universe: {
        pharmacies: farmacias,
        suppliers: fornecedores,
        manufacturers: fabricantes,
        categories: categorias,
      },
      organization: formatFarmaciaHeader(farmaciasSelecionadas, farmaciasInfo),
    });

  return (
    <AppShell>
      <div className="space-y-5">
        <section className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-[20px] font-semibold text-slate-900">Devoluções</h1>
            <p className="mt-1 text-[12px] text-slate-500">
              Devoluções a fornecedor consolidadas a partir do histórico real
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleGerar}
              disabled={isPending}
              className="inline-flex h-9 items-center gap-2 rounded-xl border border-emerald-300 bg-emerald-50 px-4 text-[13px] font-semibold text-emerald-700 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isPending ? "A gerar…" : hasGenerated ? "Atualizar" : "Gerar"}
            </button>
            <ReportActions
              report={reportSource}
              hide={!hasGenerated ? { print: true, pdf: true, excel: true, email: true } : undefined}
            />
          </div>
        </section>

        {generationError && (
          <section className="rounded-[16px] border border-rose-200 bg-rose-50 px-4 py-3 text-[12px] text-rose-700">
            Falha a gerar o relatório: {generationError}
          </section>
        )}

        <section className="rounded-[16px] border border-slate-200/60 bg-white/72 p-3.5 shadow-[0_14px_30px_rgba(15,23,42,0.045)]">
          <div className="grid gap-3 md:grid-cols-[1.5fr_160px_160px]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Pesquisar produto, CNP, fornecedor ou fabricante"
                className="h-10 w-full rounded-[12px] border border-slate-200 bg-white pl-9 pr-3 text-[13px] text-slate-700 outline-none focus:border-emerald-200"
              />
            </div>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="h-10 rounded-[12px] border border-slate-200 bg-white px-3 text-[12px] text-slate-700 outline-none focus:border-emerald-200"
            />
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="h-10 rounded-[12px] border border-slate-200 bg-white px-3 text-[12px] text-slate-700 outline-none focus:border-emerald-200"
            />
          </div>

          <div className="mt-3 grid gap-3 md:grid-cols-4">
            <FilterSelect
              label="Farmácia"
              options={farmacias}
              selected={farmaciasSelecionadas}
              onChange={setFarmaciasSelecionadas}
            />
            <FilterSelect
              label="Fornecedor"
              options={fornecedores}
              selected={fornecedoresSelecionados}
              onChange={setFornecedoresSelecionados}
            />
            <FilterSelect
              label="Fabricante"
              options={fabricantes}
              selected={fabricantesSelecionados}
              onChange={setFabricantesSelecionados}
            />
            <FilterSelect
              label="Categoria"
              options={categorias}
              selected={categoriasSelecionadas}
              onChange={setCategoriasSelecionadas}
            />
          </div>
        </section>

        {!hasGenerated ? (
          <section className="rounded-[16px] border border-slate-200/60 bg-white/72 px-6 py-16 text-center shadow-[0_14px_30px_rgba(15,23,42,0.045)]">
            <h2 className="text-[15px] font-semibold text-slate-900">
              Nenhum relatório gerado ainda
            </h2>
            <p className="mx-auto mt-2 max-w-[460px] text-[12px] leading-5 text-slate-500">
              Defina o período e clique em <span className="font-semibold text-emerald-700">Gerar</span>.
              A página não pré-carrega Devoluções — só lê da BD após o trigger explícito.
            </p>
          </section>
        ) : (
        <>
        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Metric label="Fornecedores" value={String(totals.suppliers)} helper="No relatório" />
          <Metric label="Linhas" value={String(totals.lines)} helper="Devoluções incluídas" />
          <Metric label="Unidades" value={String(totals.qty)} helper="Quantidade total" />
          <Metric
            label="Valor"
            value={`${totals.value.toFixed(2)} €`}
            helper="Soma das devoluções"
          />
        </section>

        {filteredRows.length === 0 ? (
          <section className="rounded-[16px] border border-slate-200/60 bg-white/72 px-4 py-8 text-center text-[12px] text-slate-500 shadow-[0_14px_30px_rgba(15,23,42,0.045)]">
            Sem devoluções para os critérios seleccionados.
          </section>
        ) : (
          <section className="space-y-4">
            {groupedBySupplier.map((group) => (
              <div
                key={group.fornecedor}
                className="rounded-[16px] border border-slate-200/60 bg-white/72 px-4 py-4 shadow-[0_14px_30px_rgba(15,23,42,0.045)]"
              >
                <div className="mb-3 flex items-center justify-between border-b border-slate-100 pb-3">
                  <div className="flex items-center gap-2">
                    <Building2 className="h-4 w-4 text-emerald-600" />
                    <h2 className="text-[15px] font-semibold text-slate-900">
                      {group.fornecedor}
                    </h2>
                  </div>
                  <div className="flex gap-3 text-[11px] text-slate-500">
                    <span>{group.rows.length} linhas</span>
                    <span>{group.totalQty} un.</span>
                    <span className="font-medium text-slate-800">
                      {group.totalValue.toFixed(2)} €
                    </span>
                    <span>{group.farmaciasCount} farmácia(s)</span>
                  </div>
                </div>

                <div className="grid grid-cols-[0.8fr_2.2fr_0.9fr_0.9fr_0.8fr_0.9fr_1.4fr] gap-3 border-b border-slate-200 pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                  <div>Data</div>
                  <div>Produto</div>
                  <div>Farmácia</div>
                  <div>Fabricante</div>
                  <div>Qtd.</div>
                  <div>Valor</div>
                  <div>Motivo</div>
                </div>

                <div className="divide-y divide-slate-100">
                  {group.rows.map((row) => (
                    <div
                      key={row.id}
                      className="grid grid-cols-[0.8fr_2.2fr_0.9fr_0.9fr_0.8fr_0.9fr_1.4fr] gap-3 py-2.5 text-[12px] text-slate-700"
                    >
                      <div>{row.data}</div>
                      <div className="min-w-0">
                        <div className="truncate font-semibold text-slate-900">{row.produto}</div>
                        <div className="mt-0.5 text-[11px] text-slate-500">
                          CNP {row.cnp}
                          {row.categoria ? ` · ${row.categoria}` : ""}
                          {row.subcategoria ? ` · ${row.subcategoria}` : ""}
                        </div>
                      </div>
                      <div>{row.farmacia}</div>
                      <div>{row.fabricante || "—"}</div>
                      <div className="font-medium text-slate-900">{row.quantidade}</div>
                      <div>{row.valor.toFixed(2)} €</div>
                      <div className="text-[11px] text-slate-600">{row.motivo || "—"}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </section>
        )}
        </>
        )}
      </div>
    </AppShell>
  );
}

function Metric({ label, value, helper }: { label: string; value: string; helper: string }) {
  return (
    <div className="rounded-[14px] border border-white/70 bg-white/78 px-3 py-2.5 shadow-[0_8px_20px_rgba(15,23,42,0.035)]">
      <div className="text-[9px] uppercase tracking-[0.14em] text-slate-400">{label}</div>
      <div className="mt-1 text-[15px] font-semibold leading-tight text-slate-900">{value}</div>
      <div className="mt-1 text-[10px] text-slate-500">{helper}</div>
    </div>
  );
}

function FilterSelect({
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
