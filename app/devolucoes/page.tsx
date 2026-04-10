"use client";

import { useMemo, useState } from "react";
import { AppShell } from "@/components/layout/app-shell";
import {
  Search,
  Filter,
  Building2,
  Package,
  Boxes,
  ReceiptText,
  X,
  CalendarClock,
  AlertTriangle,
  Eye,
  Printer,
  FileText,
  Sheet,
  Mail,
} from "lucide-react";

type ReturnReason =
  | "Validade curta"
  | "Sem rotação"
  | "Excesso de stock"
  | "Troca de embalagem"
  | "Dano de embalagem";

type ReturnRow = {
  supplier: string;
  product: string;
  cnp: string;
  pharmacy: string;
  manufacturer: string;
  category: string;
  stock: number;
  suggestedQty: number;
  value: number;
  expiry: string;
  reason: ReturnReason;
  note?: string;
  date: string; // YYYY-MM-DD
};

type SupplierGroup = {
  supplier: string;
  rows: ReturnRow[];
  totalReferences: number;
  totalQty: number;
  totalValue: number;
  pharmaciesCount: number;
};

const pharmacyOptions = ["Farmácia A", "Farmácia B", "Farmácia C"];
const supplierOptions = ["Plural", "OCP", "Cooprofar"];
const manufacturerOptions = [
  "Viatris",
  "Bene",
  "Sandoz",
  "UCB",
  "Servier",
  "Pfizer",
  "Janssen",
];
const categoryOptions = [
  "Analgésicos",
  "Cardiovascular",
  "Alergias",
  "Circulação",
  "Antibióticos",
  "Dermocosmética",
];
const reasonOptions: ReturnReason[] = [
  "Validade curta",
  "Sem rotação",
  "Excesso de stock",
  "Troca de embalagem",
  "Dano de embalagem",
];

const returnRows: ReturnRow[] = [
  {
    supplier: "Plural",
    product: "Brufen 600 mg comp.",
    cnp: "1234567",
    pharmacy: "Farmácia A",
    manufacturer: "Viatris",
    category: "Analgésicos",
    stock: 24,
    suggestedQty: 8,
    value: 54.8,
    expiry: "08/2026",
    reason: "Excesso de stock",
    note: "Rotação inferior ao esperado",
    date: "2026-04-02",
  },
  {
    supplier: "Plural",
    product: "Ben-u-ron 1 g comp.",
    cnp: "2345678",
    pharmacy: "Farmácia B",
    manufacturer: "Bene",
    category: "Analgésicos",
    stock: 16,
    suggestedQty: 6,
    value: 31.2,
    expiry: "06/2026",
    reason: "Sem rotação",
    note: "Sem saída relevante nas últimas semanas",
    date: "2026-04-03",
  },
  {
    supplier: "OCP",
    product: "Rosucor 20 mg comp.",
    cnp: "3456789",
    pharmacy: "Farmácia A",
    manufacturer: "Sandoz",
    category: "Cardiovascular",
    stock: 12,
    suggestedQty: 4,
    value: 27.6,
    expiry: "03/2026",
    reason: "Validade curta",
    note: "Avaliar prioridade de devolução",
    date: "2026-04-04",
  },
  {
    supplier: "OCP",
    product: "Xyzal 5 mg comp.",
    cnp: "4567890",
    pharmacy: "Farmácia C",
    manufacturer: "UCB",
    category: "Alergias",
    stock: 18,
    suggestedQty: 5,
    value: 22.4,
    expiry: "04/2026",
    reason: "Troca de embalagem",
    note: "Nova referência já ativa",
    date: "2026-04-06",
  },
  {
    supplier: "Plural",
    product: "Daflon 500 mg comp.",
    cnp: "5678901",
    pharmacy: "Farmácia C",
    manufacturer: "Servier",
    category: "Circulação",
    stock: 10,
    suggestedQty: 3,
    value: 19.35,
    expiry: "11/2026",
    reason: "Sem rotação",
    note: "Cobertura acima do desejável",
    date: "2026-04-07",
  },
  {
    supplier: "Cooprofar",
    product: "Zitromax 500 mg comp.",
    cnp: "6789012",
    pharmacy: "Farmácia B",
    manufacturer: "Pfizer",
    category: "Antibióticos",
    stock: 9,
    suggestedQty: 2,
    value: 17.8,
    expiry: "02/2026",
    reason: "Validade curta",
    note: "Quantidade limitada elegível",
    date: "2026-04-08",
  },
  {
    supplier: "Cooprofar",
    product: "Nizoral champô",
    cnp: "7890123",
    pharmacy: "Farmácia A",
    manufacturer: "Janssen",
    category: "Dermocosmética",
    stock: 14,
    suggestedQty: 4,
    value: 28.6,
    expiry: "09/2026",
    reason: "Excesso de stock",
    note: "Procura abaixo do previsto",
    date: "2026-04-09",
  },
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

function ReasonBadge({ reason }: { reason: ReturnReason }) {
  const styles: Record<ReturnReason, string> = {
    "Validade curta": "bg-amber-50 text-amber-700 border-amber-100",
    "Sem rotação": "bg-slate-100 text-slate-700 border-slate-200",
    "Excesso de stock": "bg-cyan-50 text-cyan-700 border-cyan-100",
    "Troca de embalagem": "bg-violet-50 text-violet-700 border-violet-100",
    "Dano de embalagem": "bg-rose-50 text-rose-700 border-rose-100",
  };

  return (
    <span
      className={`inline-flex rounded-full border px-2 py-1 text-[10px] font-medium ${styles[reason]}`}
    >
      {reason}
    </span>
  );
}

function ActionButton({
  icon,
  label,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className="inline-flex h-10 items-center justify-center gap-2 rounded-[12px] border border-slate-200 bg-white px-3 text-[12px] font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-45"
    >
      {icon}
      {label}
    </button>
  );
}

export default function DevolucoesPage() {
  const [search, setSearch] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);

  const [selectedPharmacies, setSelectedPharmacies] = useState<string[]>([
    ...pharmacyOptions,
  ]);
  const [selectedSuppliers, setSelectedSuppliers] = useState<string[]>([]);
  const [selectedManufacturers, setSelectedManufacturers] = useState<string[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [selectedReasons, setSelectedReasons] = useState<ReturnReason[]>([]);

  const [dateFrom, setDateFrom] = useState("2026-04-01");
  const [dateTo, setDateTo] = useState("2026-04-10");

  const [reportRequested, setReportRequested] = useState(false);
  const [reportVersion, setReportVersion] = useState(0);

  const toggleSelection = <T extends string,>(
    value: T,
    list: T[],
    setter: React.Dispatch<React.SetStateAction<T[]>>
  ) => {
    setter(list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);
  };

  const clearAllFilters = () => {
    setSelectedPharmacies([...pharmacyOptions]);
    setSelectedSuppliers([]);
    setSelectedManufacturers([]);
    setSelectedCategories([]);
    setSelectedReasons([]);
    setSearch("");
    setDateFrom("2026-04-01");
    setDateTo("2026-04-10");
    setReportRequested(false);
  };

  const handleGenerateReport = () => {
    setReportRequested(true);
    setReportVersion((prev) => prev + 1);
  };

  const filteredRows = useMemo(() => {
    if (!reportRequested) return [];

    const normalizedSearch = search.trim().toLowerCase();

    return returnRows.filter((row) => {
      const matchesSearch =
        normalizedSearch.length === 0 ||
        row.product.toLowerCase().includes(normalizedSearch) ||
        row.cnp.toLowerCase().includes(normalizedSearch) ||
        row.pharmacy.toLowerCase().includes(normalizedSearch) ||
        row.supplier.toLowerCase().includes(normalizedSearch) ||
        row.manufacturer.toLowerCase().includes(normalizedSearch);

      const matchesPharmacy =
        selectedPharmacies.length === 0 || selectedPharmacies.includes(row.pharmacy);

      const matchesSupplier =
        selectedSuppliers.length === 0 || selectedSuppliers.includes(row.supplier);

      const matchesManufacturer =
        selectedManufacturers.length === 0 ||
        selectedManufacturers.includes(row.manufacturer);

      const matchesCategory =
        selectedCategories.length === 0 || selectedCategories.includes(row.category);

      const matchesReason =
        selectedReasons.length === 0 || selectedReasons.includes(row.reason);

      const matchesDateFrom = !dateFrom || row.date >= dateFrom;
      const matchesDateTo = !dateTo || row.date <= dateTo;

      return (
        matchesSearch &&
        matchesPharmacy &&
        matchesSupplier &&
        matchesManufacturer &&
        matchesCategory &&
        matchesReason &&
        matchesDateFrom &&
        matchesDateTo
      );
    });
  }, [
    reportRequested,
    reportVersion,
    search,
    selectedPharmacies,
    selectedSuppliers,
    selectedManufacturers,
    selectedCategories,
    selectedReasons,
    dateFrom,
    dateTo,
  ]);

  const groupedBySupplier = useMemo<SupplierGroup[]>(() => {
    if (!reportRequested) return [];

    const groups = new Map<string, ReturnRow[]>();

    for (const row of filteredRows) {
      if (!groups.has(row.supplier)) {
        groups.set(row.supplier, []);
      }
      groups.get(row.supplier)!.push(row);
    }

    return Array.from(groups.entries())
      .map(([supplier, rows]) => ({
        supplier,
        rows,
        totalReferences: rows.length,
        totalQty: rows.reduce((sum, row) => sum + row.suggestedQty, 0),
        totalValue: rows.reduce((sum, row) => sum + row.value, 0),
        pharmaciesCount: new Set(rows.map((row) => row.pharmacy)).size,
      }))
      .sort((a, b) => a.supplier.localeCompare(b.supplier));
  }, [filteredRows, reportRequested]);

  const totals = useMemo(() => {
    if (!reportRequested) {
      return { suppliers: 0, references: 0, qty: 0, value: 0 };
    }

    return {
      suppliers: groupedBySupplier.length,
      references: filteredRows.length,
      qty: filteredRows.reduce((sum, row) => sum + row.suggestedQty, 0),
      value: filteredRows.reduce((sum, row) => sum + row.value, 0),
    };
  }, [filteredRows, groupedBySupplier, reportRequested]);

  const hasReport = reportRequested && groupedBySupplier.length > 0;
  const hasAnyRequestedReport = reportRequested;

  return (
    <AppShell>
      <div className="space-y-5">
        <section className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-[20px] font-semibold text-slate-900">Devoluções</h1>
            <p className="mt-1 text-[12px] text-slate-500">
              Relatório centralizado por fornecedor das devoluções sinalizadas pelas farmácias
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <ActionButton
              icon={<Eye className="h-4 w-4" />}
              label="Ver em ecrã"
              disabled={!hasAnyRequestedReport}
            />
            <ActionButton
              icon={<Printer className="h-4 w-4" />}
              label="Imprimir"
              disabled={!hasAnyRequestedReport}
            />
            <ActionButton
              icon={<FileText className="h-4 w-4" />}
              label="PDF"
              disabled={!hasAnyRequestedReport}
            />
            <ActionButton
              icon={<Sheet className="h-4 w-4" />}
              label="Excel"
              disabled={!hasAnyRequestedReport}
            />
            <ActionButton
              icon={<Mail className="h-4 w-4" />}
              label="Email"
              disabled={!hasAnyRequestedReport}
            />
          </div>
        </section>

        <section className="rounded-[16px] border border-slate-200/60 bg-white/72 p-3.5 shadow-[0_14px_30px_rgba(15,23,42,0.045)]">
          <div className="grid gap-3 xl:grid-cols-[1.45fr_160px_160px_180px_180px_180px_auto]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Pesquisar produto, CNP, fornecedor, farmácia ou fabricante"
                className="h-10 w-full rounded-[12px] border border-slate-200 bg-white pl-9 pr-3 text-[13px] text-slate-700 outline-none placeholder:text-slate-400 focus:border-emerald-200"
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

            <button
              type="button"
              onClick={() => setFiltersOpen((prev) => !prev)}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-[12px] border border-slate-200 bg-white px-3 text-[12px] font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-800"
            >
              <Filter className="h-4 w-4" />
              Farmácia
            </button>

            <button
              type="button"
              onClick={() => setFiltersOpen((prev) => !prev)}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-[12px] border border-slate-200 bg-white px-3 text-[12px] font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-800"
            >
              Fornecedor
            </button>

            <button
              type="button"
              onClick={() => setFiltersOpen((prev) => !prev)}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-[12px] border border-slate-200 bg-white px-3 text-[12px] font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-800"
            >
              Mais filtros
            </button>

            <button
              type="button"
              onClick={handleGenerateReport}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-[12px] border border-emerald-200 bg-emerald-50 px-4 text-[12px] font-semibold text-emerald-700 transition hover:border-emerald-300 hover:bg-emerald-100"
            >
              Gerar relatório
            </button>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <FilterChip
              label={`Período ${dateFrom || "—"} a ${dateTo || "—"}`}
              onRemove={() => {
                setDateFrom("");
                setDateTo("");
              }}
            />

            {selectedPharmacies.map((value) => (
              <FilterChip
                key={`pharmacy-${value}`}
                label={value}
                onRemove={() =>
                  setSelectedPharmacies((prev) => prev.filter((item) => item !== value))
                }
              />
            ))}

            {selectedSuppliers.map((value) => (
              <FilterChip
                key={`supplier-${value}`}
                label={value}
                onRemove={() =>
                  setSelectedSuppliers((prev) => prev.filter((item) => item !== value))
                }
              />
            ))}

            {selectedManufacturers.map((value) => (
              <FilterChip
                key={`manufacturer-${value}`}
                label={value}
                onRemove={() =>
                  setSelectedManufacturers((prev) => prev.filter((item) => item !== value))
                }
              />
            ))}

            {selectedCategories.map((value) => (
              <FilterChip
                key={`category-${value}`}
                label={value}
                onRemove={() =>
                  setSelectedCategories((prev) => prev.filter((item) => item !== value))
                }
              />
            ))}

            {selectedReasons.map((value) => (
              <FilterChip
                key={`reason-${value}`}
                label={value}
                onRemove={() =>
                  setSelectedReasons((prev) => prev.filter((item) => item !== value))
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

          {filtersOpen && (
            <div className="mt-3 grid gap-3 border-t border-slate-100 pt-3 xl:grid-cols-5">
              <div className="rounded-[12px] border border-slate-100 bg-white/70 p-3">
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                  Farmácia
                </div>
                <div className="mb-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setSelectedPharmacies([...pharmacyOptions])}
                    className="text-[10px] font-medium text-emerald-700"
                  >
                    Todas
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedPharmacies([])}
                    className="text-[10px] font-medium text-slate-500"
                  >
                    Limpar
                  </button>
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
                  Fornecedor
                </div>
                <div className="space-y-2">
                  {supplierOptions.map((option) => (
                    <label
                      key={option}
                      className="flex cursor-pointer items-center gap-2 text-[12px] text-slate-600"
                    >
                      <input
                        type="checkbox"
                        checked={selectedSuppliers.includes(option)}
                        onChange={() =>
                          toggleSelection(option, selectedSuppliers, setSelectedSuppliers)
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
                  Fabricante
                </div>
                <div className="space-y-2">
                  {manufacturerOptions.map((option) => (
                    <label
                      key={option}
                      className="flex cursor-pointer items-center gap-2 text-[12px] text-slate-600"
                    >
                      <input
                        type="checkbox"
                        checked={selectedManufacturers.includes(option)}
                        onChange={() =>
                          toggleSelection(
                            option,
                            selectedManufacturers,
                            setSelectedManufacturers
                          )
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
                  Categoria
                </div>
                <div className="space-y-2">
                  {categoryOptions.map((option) => (
                    <label
                      key={option}
                      className="flex cursor-pointer items-center gap-2 text-[12px] text-slate-600"
                    >
                      <input
                        type="checkbox"
                        checked={selectedCategories.includes(option)}
                        onChange={() =>
                          toggleSelection(option, selectedCategories, setSelectedCategories)
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
                  Motivo
                </div>
                <div className="space-y-2">
                  {reasonOptions.map((option) => (
                    <label
                      key={option}
                      className="flex cursor-pointer items-center gap-2 text-[12px] text-slate-600"
                    >
                      <input
                        type="checkbox"
                        checked={selectedReasons.includes(option)}
                        onChange={() =>
                          toggleSelection(option, selectedReasons, setSelectedReasons)
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

        {!reportRequested && (
          <section className="rounded-[16px] border border-slate-200/60 bg-white/72 px-4 py-10 text-center shadow-[0_14px_30px_rgba(15,23,42,0.045)]">
            <div className="mx-auto max-w-[520px]">
              <h2 className="text-[15px] font-semibold text-slate-900">
                Nenhum relatório gerado
              </h2>
              <p className="mt-2 text-[12px] leading-5 text-slate-500">
                Defina o período e os critérios pretendidos e carregue em “Gerar relatório”
                para consolidar as devoluções por fornecedor.
              </p>
            </div>
          </section>
        )}

        {reportRequested && (
          <>
            <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <Metric
                label="Fornecedores"
                value={String(totals.suppliers)}
                helper="Com devoluções no relatório"
              />
              <Metric
                label="Referências"
                value={String(totals.references)}
                helper="Artigos consolidados"
              />
              <Metric
                label="Unidades"
                value={String(totals.qty)}
                helper="Quantidade total sugerida"
              />
              <Metric
                label="Valor estimado"
                value={`${totals.value.toFixed(2)} €`}
                helper="Base consolidada do relatório"
              />
            </section>

            {hasReport ? (
              <section className="space-y-4">
                {groupedBySupplier.map((group) => (
                  <div
                    key={group.supplier}
                    className="rounded-[16px] border border-slate-200/60 bg-white/72 px-4 py-4 shadow-[0_14px_30px_rgba(15,23,42,0.045)]"
                  >
                    <div className="mb-4 flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 pb-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <Building2 className="h-4 w-4 text-emerald-600" />
                          <h2 className="text-[15px] font-semibold text-slate-900">
                            {group.supplier}
                          </h2>
                        </div>
                        <p className="mt-1 text-[12px] text-slate-500">
                          Consolidação centralizada das devoluções do fornecedor
                        </p>
                      </div>

                      <div className="grid gap-2 sm:grid-cols-4">
                        <div className="rounded-[12px] border border-slate-100 bg-white/80 px-3 py-2">
                          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-slate-400">
                            <Package className="h-3.5 w-3.5" />
                            Referências
                          </div>
                          <div className="mt-1 text-[13px] font-semibold text-slate-900">
                            {group.totalReferences}
                          </div>
                        </div>

                        <div className="rounded-[12px] border border-slate-100 bg-white/80 px-3 py-2">
                          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-slate-400">
                            <Boxes className="h-3.5 w-3.5" />
                            Unidades
                          </div>
                          <div className="mt-1 text-[13px] font-semibold text-slate-900">
                            {group.totalQty}
                          </div>
                        </div>

                        <div className="rounded-[12px] border border-slate-100 bg-white/80 px-3 py-2">
                          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-slate-400">
                            <ReceiptText className="h-3.5 w-3.5" />
                            Valor
                          </div>
                          <div className="mt-1 text-[13px] font-semibold text-slate-900">
                            {group.totalValue.toFixed(2)} €
                          </div>
                        </div>

                        <div className="rounded-[12px] border border-slate-100 bg-white/80 px-3 py-2">
                          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-slate-400">
                            <Building2 className="h-3.5 w-3.5" />
                            Farmácias
                          </div>
                          <div className="mt-1 text-[13px] font-semibold text-slate-900">
                            {group.pharmaciesCount}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-[2.2fr_0.8fr_0.9fr_0.8fr_0.9fr_1fr_0.8fr_1.1fr_1.4fr] gap-4 border-b border-slate-200 pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                      <div>Produto</div>
                      <div>Farmácia</div>
                      <div>Fabricante</div>
                      <div>Stock</div>
                      <div>Qtd. dev.</div>
                      <div>Validade</div>
                      <div>Valor</div>
                      <div>Motivo</div>
                      <div>Observação</div>
                    </div>

                    <div className="divide-y divide-slate-100">
                      {group.rows.map((row) => (
                        <div
                          key={`${group.supplier}-${row.cnp}-${row.pharmacy}`}
                          className="grid grid-cols-[2.2fr_0.8fr_0.9fr_0.8fr_0.9fr_1fr_0.8fr_1.1fr_1.4fr] gap-4 py-3 text-[12px] text-slate-700 transition hover:bg-slate-50/70"
                        >
                          <div className="min-w-0">
                            <div className="truncate font-semibold text-slate-900">
                              {row.product}
                            </div>
                            <div className="mt-0.5 text-[11px] text-slate-500">
                              CNP {row.cnp} · {row.category} · {row.date}
                            </div>
                          </div>

                          <div className="flex items-center">{row.pharmacy}</div>
                          <div className="flex items-center">{row.manufacturer}</div>

                          <div className="flex items-center font-medium text-slate-900">
                            {row.stock} un.
                          </div>

                          <div className="flex items-center font-medium text-slate-900">
                            {row.suggestedQty} un.
                          </div>

                          <div className="flex items-center gap-1.5 text-slate-700">
                            <CalendarClock className="h-3.5 w-3.5 text-slate-400" />
                            <span>{row.expiry}</span>
                          </div>

                          <div className="flex items-center">{row.value.toFixed(2)} €</div>

                          <div className="flex items-center">
                            <ReasonBadge reason={row.reason} />
                          </div>

                          <div className="flex items-center gap-2 text-[11px] text-slate-700">
                            {row.reason === "Validade curta" && (
                              <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                            )}
                            <span>{row.note ?? "-"}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </section>
            ) : (
              <section className="rounded-[16px] border border-slate-200/60 bg-white/72 px-4 py-8 text-center text-[12px] text-slate-500 shadow-[0_14px_30px_rgba(15,23,42,0.045)]">
                Sem devoluções para os critérios selecionados neste período.
              </section>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}