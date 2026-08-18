"use client";

import { useCallback, useMemo, useState, useTransition } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import Link from "next/link";
import { AppShell } from "@/components/layout/app-shell";
import { Search, Filter, ArrowRightLeft, AlertTriangle, X, ChevronLeft, ChevronRight } from "lucide-react";
import type { StockRow, StockPageData } from "@/lib/stock-data";
import { STOCK_FILTER_LABELS } from "@/lib/stock-shared";

const coverageOptions = ["0-5 dias", "6-15 dias", "16+ dias"] as const;
const statusOptions: StockRow["status"][] = [
  "Estável",
  "Baixa cobertura",
  "Parado",
  "Transferência sugerida",
];

function Metric({
  label,
  value,
  helper,
  onClick,
  active,
}: {
  label: string;
  value: string;
  helper: string;
  onClick?: () => void;
  active?: boolean;
}) {
  const inner = (
    <>
      <div className="text-[9px] uppercase tracking-[0.14em] text-slate-400">{label}</div>
      <div className="mt-1 text-[15px] font-semibold leading-tight text-slate-900">{value}</div>
      <div className="mt-1 text-[10px] text-slate-500">{helper}</div>
    </>
  );
  if (!onClick) {
    return (
      <div className="rounded-[14px] border border-white/70 bg-white/78 px-3 py-2.5 shadow-[0_8px_20px_rgba(15,23,42,0.035)]">
        {inner}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-[14px] border px-3 py-2.5 text-left shadow-[0_8px_20px_rgba(15,23,42,0.035)] transition hover:border-emerald-300 hover:bg-white ${
        active
          ? "border-emerald-300 bg-emerald-50/70 ring-1 ring-emerald-200"
          : "border-white/70 bg-white/78"
      }`}
    >
      {inner}
    </button>
  );
}

function StatusBadge({ status }: { status: StockRow["status"] }) {
  const styles: Record<StockRow["status"], string> = {
    Estável: "bg-emerald-50 text-emerald-700 border-emerald-100",
    "Baixa cobertura": "bg-amber-50 text-amber-700 border-amber-100",
    Parado: "bg-slate-100 text-slate-700 border-slate-200",
    "Transferência sugerida": "bg-cyan-50 text-cyan-700 border-cyan-100",
  };
  return (
    <span className={`inline-flex rounded-full border px-2 py-1 text-[10px] font-medium ${styles[status]}`}>
      {status}
    </span>
  );
}

/** Caixa de um eixo de filtro — mesma moldura das que já existiam. */
function CaixaFiltro({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[12px] border border-slate-100 bg-white/70 p-3">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
        {titulo}
      </div>
      <div className="max-h-48 space-y-2 overflow-y-auto">{children}</div>
    </div>
  );
}

function OpcaoFiltro({
  label,
  checked,
  onToggle,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[12px] text-slate-600">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
      />
      <span>{label}</span>
    </label>
  );
}

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <button
      type="button"
      onClick={onRemove}
      className="inline-flex items-center gap-1 rounded-full border border-emerald-100 bg-emerald-50 px-2.5 py-1 text-[10px] font-medium text-emerald-700 transition hover:bg-emerald-100"
    >
      <span>{label}</span>
      <X className="h-3 w-3" />
    </button>
  );
}

type StockClientProps = {
  data: StockPageData;
};

export function StockClient({ data }: StockClientProps) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const serverQ = data.params.q ?? "";
  // Padrão React "adjust state on prop change": guarda o último valor
  // que veio do URL/server. Se mudar (ex: back/forward), sincroniza o
  // input local de pesquisa sem useEffect (evita cascading renders).
  const [lastServerQ, setLastServerQ] = useState(serverQ);
  const [searchInput, setSearchInput] = useState<string>(serverQ);
  if (lastServerQ !== serverQ) {
    setLastServerQ(serverQ);
    setSearchInput(serverQ);
  }
  const [filtersOpen, setFiltersOpen] = useState(false);

  const selectedPharmacies = data.params.pharmacies ?? [];
  const selectedCoverage = data.params.coverageBuckets ?? [];
  const selectedStatus = data.params.statusBuckets ?? [];
  const selectedCategorias = data.params.categorias ?? [];
  const selectedSubcategorias = data.params.subcategorias ?? [];
  const selectedUtilizacoes = data.params.utilizacoes ?? [];
  // Subcategorias acompanham a categoria escolhida — oferecer uma
  // subcategoria de outra categoria é oferecer zero linhas.
  const subcategoriasVisiveis = (
    selectedCategorias.length > 0
      ? data.filterOptions.subcategorias.filter((s) => selectedCategorias.includes(s.categoria))
      : data.filterOptions.subcategorias
  ).map((s) => s.nome);
  const nomeUtilizacao = new Map(data.filterOptions.utilizacoes.map((u) => [u.slug, u.nome]));

  const buildUrl = useCallback(
    (mut: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(sp.toString());
      mut(params);
      // Quando algo muda, voltar à página 1 (excepto se o caller mexer no `page`).
      const qs = params.toString();
      return qs ? `${pathname}?${qs}` : pathname;
    },
    [pathname, sp]
  );

  const push = useCallback(
    (mut: (params: URLSearchParams) => void) => {
      startTransition(() => {
        router.push(buildUrl(mut), { scroll: false });
      });
    },
    [router, buildUrl, startTransition]
  );

  const commitSearch = useCallback(
    (value: string) => {
      push((p) => {
        if (value.trim() === "") p.delete("q");
        else p.set("q", value.trim());
        p.delete("page");
      });
    },
    [push]
  );

  // A pesquisa só dispara ao SUBMETER (Enter ou botão "Pesquisar") — nunca
  // onChange. O input mantém o texto localmente; só commitSearch toca no URL.
  // commitSearch já apaga `page` (reset à página 1) e preserva os restantes
  // params (farmácia/cobertura/estado). Limpar o input + submeter → apaga `q`.
  const submitSearch = () => commitSearch(searchInput);

  const toggleMulti = (key: string, value: string) => {
    push((p) => {
      const existing = p.getAll(key);
      if (existing.includes(value)) {
        p.delete(key);
        for (const v of existing.filter((x) => x !== value)) p.append(key, v);
      } else {
        p.append(key, value);
      }
      p.delete("page");
    });
  };

  const clearAllFilters = () => {
    push((p) => {
      p.delete("pharmacy");
      p.delete("coverage");
      p.delete("status");
      p.delete("categoria");
      p.delete("subcategoria");
      p.delete("utilizacao");
      p.delete("page");
    });
  };

  // Cartões-KPI operacionais como atalho: aplicam o filtro de estado
  // correspondente (carrega a tabela). Se já é o único filtro activo,
  // voltar a clicar limpa-o (regressa ao estado inicial). Os outros
  // params (q/farmácia/cobertura) são limpos para focar só este estado.
  const isOnlyStatus = (status: StockRow["status"]) =>
    selectedStatus.length === 1 &&
    selectedStatus[0] === status &&
    selectedCoverage.length === 0 &&
    selectedPharmacies.length === 0 &&
    !data.params.q &&
    !data.filter;

  const focusStatus = (status: StockRow["status"]) => {
    const turnOff = isOnlyStatus(status);
    push((p) => {
      p.delete("status");
      p.delete("coverage");
      p.delete("pharmacy");
      p.delete("q");
      p.delete("page");
      if (!turnOff) p.append("status", status);
    });
  };

  const setPage = (newPage: number) => {
    push((p) => {
      if (newPage <= 1) p.delete("page");
      else p.set("page", String(newPage));
    });
  };

  const totalPages = Math.max(1, Math.ceil(data.totalRows / data.pageSize));
  const showingFrom = data.totalRows === 0 ? 0 : (data.page - 1) * data.pageSize + 1;
  const showingTo = Math.min(data.totalRows, data.page * data.pageSize);

  const hasActiveFilter =
    selectedPharmacies.length > 0 ||
    selectedCoverage.length > 0 ||
    selectedStatus.length > 0 ||
    selectedCategorias.length > 0 ||
    selectedSubcategorias.length > 0 ||
    selectedUtilizacoes.length > 0;
  const activeFilterCount =
    selectedPharmacies.length +
    selectedCoverage.length +
    selectedStatus.length +
    selectedCategorias.length +
    selectedSubcategorias.length +
    selectedUtilizacoes.length;

  const rows = useMemo(() => data.rows, [data.rows]);

  return (
    <AppShell>
      <div className="space-y-5">
        <section>
          <h1 className="text-[20px] font-semibold text-slate-900">Stock</h1>
          <p className="mt-1 text-[12px] text-slate-500">
            Cobertura, rotação e diferenças de stock por farmácia
          </p>
        </section>

        {data.filter && (
          <section className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-cyan-200 bg-cyan-50 px-4 py-2.5 text-[12px] text-cyan-800">
            <span>
              <span className="font-semibold">Filtro activo:</span>{" "}
              {STOCK_FILTER_LABELS[data.filter]} · {data.totalRows.toLocaleString("pt-PT")} produto
              {data.totalRows === 1 ? "" : "s"}
            </span>
            <Link
              href="/stock"
              className="inline-flex items-center gap-1 rounded-full border border-cyan-300 bg-white px-2.5 py-1 text-[11px] font-medium text-cyan-700 transition hover:border-cyan-400"
            >
              Limpar filtro
            </Link>
          </section>
        )}

        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Metric
            label="Referências analisadas"
            value={data.metrics.referencias.toLocaleString("pt-PT")}
            helper={data.tableLoaded ? "Universo atual em análise" : "Catálogo total (sem carregar lista)"}
          />
          <Metric
            label="Baixa cobertura"
            value={data.metrics.baixaCobertura.toLocaleString("pt-PT")}
            helper="Produtos abaixo do limiar · ver"
            onClick={() => focusStatus("Baixa cobertura")}
            active={isOnlyStatus("Baixa cobertura")}
          />
          <Metric
            label="Stock parado"
            value={data.metrics.stockParado.toLocaleString("pt-PT")}
            helper="Sem rotação relevante · ver"
            onClick={() => focusStatus("Parado")}
            active={isOnlyStatus("Parado")}
          />
          <Metric
            label="Transferências sugeridas"
            value={data.metrics.transferencias.toLocaleString("pt-PT")}
            helper="Entre farmácias do grupo · ver"
            onClick={() => focusStatus("Transferência sugerida")}
            active={isOnlyStatus("Transferência sugerida")}
          />
        </section>

        <section className="rounded-[16px] border border-slate-200/60 bg-white/72 p-3.5 shadow-[0_14px_30px_rgba(15,23,42,0.045)]">
          <div className="grid gap-3 xl:grid-cols-[1fr_auto_auto]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitSearch();
                  }
                }}
                placeholder="Pesquisar produto, CNP, farmácia, DCI ou ATC — Enter ou Pesquisar"
                disabled={isPending}
                className="h-10 w-full rounded-[12px] border border-slate-200 bg-white pl-9 pr-3 text-[13px] text-slate-700 outline-none placeholder:text-slate-400 focus:border-emerald-200 disabled:opacity-60"
              />
            </div>

            <button
              type="button"
              onClick={submitSearch}
              disabled={isPending}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-[12px] border border-emerald-300 bg-emerald-50 px-4 text-[12px] font-semibold text-emerald-700 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Search className="h-4 w-4" />
              Pesquisar
            </button>

            <button
              type="button"
              onClick={() => setFiltersOpen((prev) => !prev)}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-[12px] border border-slate-200 bg-white px-4 text-[12px] font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-800"
            >
              <Filter className="h-4 w-4" />
              Filtros{hasActiveFilter ? ` (${activeFilterCount})` : ""}
            </button>
          </div>

          {hasActiveFilter && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {selectedPharmacies.map((value) => (
                <FilterChip
                  key={`pharmacy-${value}`}
                  label={value}
                  onRemove={() => toggleMulti("pharmacy", value)}
                />
              ))}
              {selectedCoverage.map((value) => (
                <FilterChip
                  key={`coverage-${value}`}
                  label={value}
                  onRemove={() => toggleMulti("coverage", value)}
                />
              ))}
              {selectedStatus.map((value) => (
                <FilterChip
                  key={`status-${value}`}
                  label={value}
                  onRemove={() => toggleMulti("status", value)}
                />
              ))}
              {selectedCategorias.map((value) => (
                <FilterChip
                  key={`categoria-${value}`}
                  label={value}
                  onRemove={() => toggleMulti("categoria", value)}
                />
              ))}
              {selectedSubcategorias.map((value) => (
                <FilterChip
                  key={`subcategoria-${value}`}
                  label={value}
                  onRemove={() => toggleMulti("subcategoria", value)}
                />
              ))}
              {selectedUtilizacoes.map((slug) => (
                <FilterChip
                  key={`utilizacao-${slug}`}
                  label={nomeUtilizacao.get(slug) ?? slug}
                  onRemove={() => toggleMulti("utilizacao", slug)}
                />
              ))}
              <button
                type="button"
                onClick={clearAllFilters}
                className="ml-1 text-[10px] font-medium text-slate-500 transition hover:text-slate-700"
              >
                Limpar
              </button>
            </div>
          )}

          {filtersOpen && (
            <div className="mt-3 grid gap-3 border-t border-slate-100 pt-3 xl:grid-cols-3">
              <div className="rounded-[12px] border border-slate-100 bg-white/70 p-3">
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                  Farmácia
                </div>
                <div className="space-y-2">
                  {data.pharmacyNames.map((option) => (
                    <label key={option} className="flex cursor-pointer items-center gap-2 text-[12px] text-slate-600">
                      <input
                        type="checkbox"
                        checked={selectedPharmacies.includes(option)}
                        onChange={() => toggleMulti("pharmacy", option)}
                        className="h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                      />
                      <span>{option}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="rounded-[12px] border border-slate-100 bg-white/70 p-3">
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                  Cobertura
                </div>
                <div className="space-y-2">
                  {coverageOptions.map((option) => (
                    <label key={option} className="flex cursor-pointer items-center gap-2 text-[12px] text-slate-600">
                      <input
                        type="checkbox"
                        checked={selectedCoverage.includes(option)}
                        onChange={() => toggleMulti("coverage", option)}
                        className="h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                      />
                      <span>{option}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="rounded-[12px] border border-slate-100 bg-white/70 p-3">
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                  Estado
                </div>
                <div className="space-y-2">
                  {statusOptions.map((option) => (
                    <label key={option} className="flex cursor-pointer items-center gap-2 text-[12px] text-slate-600">
                      <input
                        type="checkbox"
                        checked={selectedStatus.includes(option)}
                        onChange={() => toggleMulti("status", option)}
                        className="h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                      />
                      <span>{option}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Catálogo. Os três eixos correm server-side, via URL, como
                  os filtros que já existiam — a lista pode ter dezenas de
                  milhares de linhas e não se materializa para filtrar. */}
              <CaixaFiltro titulo="Categoria">
                {data.filterOptions.categorias.map((option) => (
                  <OpcaoFiltro
                    key={`categoria-${option}`}
                    label={option}
                    checked={selectedCategorias.includes(option)}
                    onToggle={() => toggleMulti("categoria", option)}
                  />
                ))}
              </CaixaFiltro>

              <CaixaFiltro titulo="Subcategoria">
                {subcategoriasVisiveis.map((option) => (
                  <OpcaoFiltro
                    key={`subcategoria-${option}`}
                    label={option}
                    checked={selectedSubcategorias.includes(option)}
                    onToggle={() => toggleMulti("subcategoria", option)}
                  />
                ))}
              </CaixaFiltro>

              {/* Viaja em slug, mostra-se pelo nome. */}
              <CaixaFiltro titulo="Utilização">
                {data.filterOptions.utilizacoes.map((u) => (
                  <OpcaoFiltro
                    key={`utilizacao-${u.slug}`}
                    label={u.nome}
                    checked={selectedUtilizacoes.includes(u.slug)}
                    onToggle={() => toggleMulti("utilizacao", u.slug)}
                  />
                ))}
              </CaixaFiltro>
            </div>
          )}
        </section>

        {!data.tableLoaded ? (
          <section className="rounded-[16px] border border-slate-200/60 bg-white/72 px-4 py-12 text-center shadow-[0_14px_30px_rgba(15,23,42,0.045)]">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
              <Search className="h-5 w-5" />
            </div>
            <p className="mt-3 text-[14px] font-semibold text-slate-800">
              Pesquise ou filtre para ver os artigos
            </p>
            <p className="mx-auto mt-1.5 max-w-md text-[12px] leading-relaxed text-slate-500">
              O catálogo completo não é carregado por defeito para manter a página
              rápida. Pesquise por produto, CNP, farmácia, DCI ou ATC, ou use um dos
              cartões operacionais (baixa cobertura, stock parado, transferências) ou
              os filtros acima.
            </p>
          </section>
        ) : (
        <section className="rounded-[16px] border border-slate-200/60 bg-white/72 px-4 py-3 shadow-[0_14px_30px_rgba(15,23,42,0.045)]">
          <div className="grid grid-cols-[2.2fr_0.8fr_1fr_0.8fr_0.9fr_0.9fr_1.1fr_1.2fr] gap-4 border-b border-slate-200 pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            <div>Produto</div>
            <div>Farmácia</div>
            <div>Stock</div>
            <div>Cobertura</div>
            <div>Rotação</div>
            <div>Último mov.</div>
            <div>Estado</div>
            <div>Sugestão</div>
          </div>

          <div className="divide-y divide-slate-100">
            {rows.map((row) => (
              <div
                key={`${row.cnp}-${row.pharmacy}`}
                role="button"
                tabIndex={0}
                onClick={() => router.push(`/stock/artigo/${row.cnp}`)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    router.push(`/stock/artigo/${row.cnp}`);
                  }
                }}
                className="grid cursor-pointer grid-cols-[2.2fr_0.8fr_1fr_0.8fr_0.9fr_0.9fr_1.1fr_1.2fr] gap-4 py-3 text-[12px] text-slate-700 transition hover:bg-slate-50/80 focus:bg-slate-50/80 focus:outline-none"
              >
                <div className="min-w-0">
                  <Link
                    href={`/stock/artigo/${row.cnp}`}
                    onClick={(e) => e.stopPropagation()}
                    className="group block"
                    title={[
                      `Abrir ficha de ${row.product}`,
                      row.dci ? `DCI: ${row.dci}` : null,
                      row.codigoATC ? `ATC: ${row.codigoATC}` : null,
                    ].filter(Boolean).join(" · ")}
                  >
                    <span className="block truncate font-semibold text-slate-900 transition duration-150 group-hover:text-emerald-700 group-hover:underline group-hover:underline-offset-2">
                      {row.product}
                    </span>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-slate-500 transition group-hover:text-slate-600">
                      <span>CNP {row.cnp}</span>
                      {row.codigoATC && (
                        <span className="rounded bg-slate-100 px-1 font-mono text-[10px] text-slate-600">
                          {row.codigoATC}
                        </span>
                      )}
                      {row.dci && (
                        <span className="truncate text-slate-500" title={row.dci}>
                          · {row.dci}
                        </span>
                      )}
                      {/* Classificação canónica. Sem isto, os filtros de
                          categoria/subcategoria não tinham correspondência
                          visível na linha que devolviam. */}
                      {(row.categoria || row.subcategoria) && (
                        <span
                          className="truncate text-slate-500"
                          title={[row.categoria, row.subcategoria].filter(Boolean).join(" · ")}
                        >
                          · {[row.categoria, row.subcategoria].filter(Boolean).join(" · ")}
                        </span>
                      )}
                    </div>
                  </Link>
                </div>
                <div className="flex items-center text-slate-700">{row.pharmacy}</div>
                <div className="flex items-center font-semibold text-slate-900">{row.stock} un.</div>
                <div className="flex items-center text-slate-700">{row.coverage}</div>
                <div className="flex items-center text-slate-700">{row.rotation}</div>
                <div className="flex items-center text-slate-700">{row.lastMovement}</div>
                <div className="flex items-center">
                  <StatusBadge status={row.status} />
                </div>
                <div className="flex items-center gap-2 text-[11px] text-slate-700">
                  {row.status === "Transferência sugerida" ? (
                    <>
                      <ArrowRightLeft className="h-3.5 w-3.5 text-cyan-600" />
                      <span>{row.suggestion}</span>
                    </>
                  ) : row.status === "Baixa cobertura" ? (
                    <>
                      <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                      <span>{row.suggestion}</span>
                    </>
                  ) : (
                    <span>{row.suggestion}</span>
                  )}
                </div>
              </div>
            ))}

            {rows.length === 0 && (
              <div className="py-8 text-center text-[12px] text-slate-500">
                Sem artigos para os critérios selecionados.
              </div>
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3 text-[11px] text-slate-500">
            <div>
              {data.totalRows === 0
                ? "0 produtos"
                : `${showingFrom.toLocaleString("pt-PT")}–${showingTo.toLocaleString("pt-PT")} de ${data.totalRows.toLocaleString("pt-PT")} produtos`}
              {isPending ? " · a carregar…" : ""}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPage(data.page - 1)}
                disabled={data.page <= 1 || isPending}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                Anterior
              </button>
              <span>
                Página {data.page} / {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage(data.page + 1)}
                disabled={data.page >= totalPages || isPending}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Próxima
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </section>
        )}
      </div>
    </AppShell>
  );
}
