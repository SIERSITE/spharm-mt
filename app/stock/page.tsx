"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AppShell } from "@/components/layout/app-shell";
import {
  Search,
  Filter,
  ArrowRightLeft,
  AlertTriangle,
  X,
} from "lucide-react";

type StockRow = {
  product: string;
  cnp: string;
  pharmacy: string;
  stock: number;
  coverage: string;
  rotation: string;
  lastMovement: string;
  status: "Estável" | "Baixa cobertura" | "Parado" | "Transferência sugerida";
  suggestion?: string;
};

const stockRows: StockRow[] = [
  {
    product: "Brufen 600 mg comp.",
    cnp: "1234567",
    pharmacy: "Farmácia A",
    stock: 42,
    coverage: "12 dias",
    rotation: "Alta",
    lastMovement: "Hoje",
    status: "Estável",
    suggestion: "-",
  },
  {
    product: "Ben-u-ron 1 g comp.",
    cnp: "2345678",
    pharmacy: "Farmácia B",
    stock: 8,
    coverage: "3 dias",
    rotation: "Alta",
    lastMovement: "Hoje",
    status: "Baixa cobertura",
    suggestion: "Reforçar stock",
  },
  {
    product: "Rosucor 20 mg comp.",
    cnp: "3456789",
    pharmacy: "Farmácia A",
    stock: 18,
    coverage: "20 dias",
    rotation: "Média",
    lastMovement: "Ontem",
    status: "Transferência sugerida",
    suggestion: "4 un. → Farmácia B",
  },
  {
    product: "Xyzal 5 mg comp.",
    cnp: "4567890",
    pharmacy: "Farmácia B",
    stock: 27,
    coverage: "30 dias",
    rotation: "Baixa",
    lastMovement: "Há 6 dias",
    status: "Parado",
    suggestion: "Avaliar rotação",
  },
  {
    product: "Daflon 500 mg comp.",
    cnp: "5678901",
    pharmacy: "Farmácia A",
    stock: 14,
    coverage: "6 dias",
    rotation: "Média",
    lastMovement: "Hoje",
    status: "Baixa cobertura",
    suggestion: "Acompanhar procura",
  },
];

const pharmacyOptions = ["Farmácia A", "Farmácia B"];
const coverageOptions = ["0-5 dias", "6-15 dias", "16+ dias"];
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
}: {
  label: string;
  value: string;
  helper: string;
}) {
  return (
    <div className="rounded-[14px] border border-white/70 bg-white/78 px-3 py-2.5 shadow-[0_8px_20px_rgba(15,23,42,0.035)]">
      <div className="text-[9px] uppercase tracking-[0.14em] text-slate-400">
        {label}
      </div>
      <div className="mt-1 text-[15px] font-semibold leading-tight text-slate-900">
        {value}
      </div>
      <div className="mt-1 text-[10px] text-slate-500">{helper}</div>
    </div>
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
    <span
      className={`inline-flex rounded-full border px-2 py-1 text-[10px] font-medium ${styles[status]}`}
    >
      {status}
    </span>
  );
}

function FilterChip({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
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

export default function StockPage() {
  const router = useRouter();

  const [search, setSearch] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedPharmacies, setSelectedPharmacies] = useState<string[]>([]);
  const [selectedCoverage, setSelectedCoverage] = useState<string[]>([]);
  const [selectedStatus, setSelectedStatus] = useState<StockRow["status"][]>([]);

  const toggleSelection = <T extends string,>(
    value: T,
    list: T[],
    setter: React.Dispatch<React.SetStateAction<T[]>>
  ) => {
    setter(list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);
  };

  const clearAllFilters = () => {
    setSelectedPharmacies([]);
    setSelectedCoverage([]);
    setSelectedStatus([]);
  };

  const getCoverageBucket = (coverage: string) => {
    const days = parseInt(coverage, 10);

    if (Number.isNaN(days)) return "";
    if (days <= 5) return "0-5 dias";
    if (days <= 15) return "6-15 dias";
    return "16+ dias";
  };

  const filteredRows = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();

    return stockRows.filter((row) => {
      const matchesSearch =
        normalizedSearch.length === 0 ||
        row.product.toLowerCase().includes(normalizedSearch) ||
        row.cnp.toLowerCase().includes(normalizedSearch) ||
        row.pharmacy.toLowerCase().includes(normalizedSearch);

      const matchesPharmacy =
        selectedPharmacies.length === 0 || selectedPharmacies.includes(row.pharmacy);

      const matchesCoverage =
        selectedCoverage.length === 0 ||
        selectedCoverage.includes(getCoverageBucket(row.coverage));

      const matchesStatus =
        selectedStatus.length === 0 || selectedStatus.includes(row.status);

      return matchesSearch && matchesPharmacy && matchesCoverage && matchesStatus;
    });
  }, [search, selectedPharmacies, selectedCoverage, selectedStatus]);

  return (
    <AppShell>
      <div className="space-y-5">
        <section>
          <h1 className="text-[20px] font-semibold text-slate-900">Stock</h1>
          <p className="mt-1 text-[12px] text-slate-500">
            Cobertura, rotação e diferenças de stock por farmácia
          </p>
        </section>

        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Metric
            label="Referências analisadas"
            value="1.247"
            helper="Universo atual em análise"
          />
          <Metric
            label="Baixa cobertura"
            value="38"
            helper="Produtos abaixo do limiar"
          />
          <Metric
            label="Stock parado"
            value="124"
            helper="Sem rotação relevante"
          />
          <Metric
            label="Transferências sugeridas"
            value="14"
            helper="Entre farmácias do grupo"
          />
        </section>

        <section className="rounded-[16px] border border-slate-200/60 bg-white/72 p-3.5 shadow-[0_14px_30px_rgba(15,23,42,0.045)]">
          <div className="grid gap-3 xl:grid-cols-[1.4fr_180px_180px_180px]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Pesquisar produto, CNP ou referência"
                className="h-10 w-full rounded-[12px] border border-slate-200 bg-white pl-9 pr-3 text-[13px] text-slate-700 outline-none placeholder:text-slate-400 focus:border-emerald-200"
              />
            </div>

            <button
              type="button"
              onClick={() => setFiltersOpen((prev) => !prev)}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-[12px] border border-slate-200 bg-white px-3 text-[12px] font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-800"
            >
              <Filter className="h-4 w-4" />
              Grupo
            </button>

            <button
              type="button"
              onClick={() => setFiltersOpen((prev) => !prev)}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-[12px] border border-slate-200 bg-white px-3 text-[12px] font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-800"
            >
              Cobertura
            </button>

            <button
              type="button"
              onClick={() => setFiltersOpen((prev) => !prev)}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-[12px] border border-slate-200 bg-white px-3 text-[12px] font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-800"
            >
              Estado
            </button>
          </div>

          {(selectedPharmacies.length > 0 ||
            selectedCoverage.length > 0 ||
            selectedStatus.length > 0) && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {selectedPharmacies.map((value) => (
                <FilterChip
                  key={`pharmacy-${value}`}
                  label={value}
                  onRemove={() =>
                    setSelectedPharmacies((prev) => prev.filter((item) => item !== value))
                  }
                />
              ))}

              {selectedCoverage.map((value) => (
                <FilterChip
                  key={`coverage-${value}`}
                  label={value}
                  onRemove={() =>
                    setSelectedCoverage((prev) => prev.filter((item) => item !== value))
                  }
                />
              ))}

              {selectedStatus.map((value) => (
                <FilterChip
                  key={`status-${value}`}
                  label={value}
                  onRemove={() =>
                    setSelectedStatus((prev) => prev.filter((item) => item !== value))
                  }
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
                  Grupo
                </div>

                <div className="space-y-2">
                  {pharmacyOptions.map((option) => (
                    <label
                      key={option}
                      className="flex cursor-pointer items-center gap-2 text-[12px] text-slate-600"
                    >
                      <input
                        type="checkbox"
                        checked={selectedPharmacies.includes(option)}
                        onChange={() =>
                          toggleSelection(option, selectedPharmacies, setSelectedPharmacies)
                        }
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
                    <label
                      key={option}
                      className="flex cursor-pointer items-center gap-2 text-[12px] text-slate-600"
                    >
                      <input
                        type="checkbox"
                        checked={selectedCoverage.includes(option)}
                        onChange={() =>
                          toggleSelection(option, selectedCoverage, setSelectedCoverage)
                        }
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
                    <label
                      key={option}
                      className="flex cursor-pointer items-center gap-2 text-[12px] text-slate-600"
                    >
                      <input
                        type="checkbox"
                        checked={selectedStatus.includes(option)}
                        onChange={() =>
                          toggleSelection(option, selectedStatus, setSelectedStatus)
                        }
                        className="h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                      />
                      <span>{option}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}
        </section>

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
            {filteredRows.map((row) => (
              <div
                key={`${row.product}-${row.pharmacy}`}
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
                    title={`Abrir ficha de ${row.product}`}
                  >
                    <span className="block truncate font-semibold text-slate-900 transition duration-150 group-hover:text-emerald-700 group-hover:underline group-hover:underline-offset-2">
                      {row.product}
                    </span>
                    <div className="mt-0.5 text-[11px] text-slate-500 transition group-hover:text-slate-600">
                      CNP {row.cnp}
                    </div>
                  </Link>
                </div>

                <div className="flex items-center text-slate-700">{row.pharmacy}</div>

                <div className="flex items-center font-semibold text-slate-900">
                  {row.stock} un.
                </div>

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

            {filteredRows.length === 0 && (
              <div className="py-8 text-center text-[12px] text-slate-500">
                Sem artigos para os critérios selecionados.
              </div>
            )}
          </div>
        </section>
      </div>
    </AppShell>
  );
}