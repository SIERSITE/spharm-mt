"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";
import type {
  CatalogoFilterOptions,
  CatalogoListData,
  CatalogoListFilters,
  CatalogoRow,
} from "@/lib/catalogo-data";

type Props = {
  data: CatalogoListData;
  filters: CatalogoListFilters;
  filterOptions: CatalogoFilterOptions;
};

const PRODUCT_TYPE_OPTIONS = [
  { value: "", label: "Tipo (todos)" },
  { value: "MEDICAMENTO", label: "Medicamento" },
  { value: "SUPLEMENTO", label: "Suplemento" },
  { value: "DERMOCOSMETICA", label: "Dermocosmética" },
  { value: "DISPOSITIVO_MEDICO", label: "Dispositivo médico" },
  { value: "HIGIENE_CUIDADO", label: "Higiene & cuidado" },
  { value: "ORTOPEDIA", label: "Ortopedia" },
  { value: "PUERICULTURA", label: "Puericultura" },
  { value: "VETERINARIA", label: "Veterinária" },
  { value: "OUTRO", label: "Outro" },
];

const VERIFICATION_OPTIONS = [
  { value: "", label: "Verificação (todos)" },
  { value: "VERIFIED", label: "Verificado" },
  { value: "PARTIALLY_VERIFIED", label: "Parcialmente verificado" },
  { value: "NEEDS_REVIEW", label: "Precisa revisão" },
  { value: "PENDING", label: "Pendente" },
  { value: "IN_PROGRESS", label: "Em curso" },
  { value: "FAILED", label: "Sem dados" },
];

const ESTADO_OPTIONS = [
  { value: "", label: "Estado (todos)" },
  { value: "NOVO", label: "Novo" },
  { value: "PENDENTE", label: "Pendente" },
  { value: "PARCIALMENTE_ENRIQUECIDO", label: "Parc. enriquecido" },
  { value: "ENRIQUECIDO_AUTOMATICAMENTE", label: "Enriquecido auto" },
  { value: "VALIDADO", label: "Validado" },
  { value: "INATIVO", label: "Inativo" },
];

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];

const PRODUCT_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  PRODUCT_TYPE_OPTIONS.map((o) => [o.value, o.label]),
);

const VERIFICATION_LABELS: Record<string, string> = Object.fromEntries(
  VERIFICATION_OPTIONS.map((o) => [o.value, o.label]),
);

const VERIFICATION_TONES: Record<string, string> = {
  VERIFIED: "border-emerald-200 bg-emerald-50 text-emerald-700",
  PARTIALLY_VERIFIED: "border-cyan-200 bg-cyan-50 text-cyan-700",
  NEEDS_REVIEW: "border-amber-200 bg-amber-50 text-amber-700",
  PENDING: "border-slate-200 bg-slate-50 text-slate-600",
  IN_PROGRESS: "border-sky-200 bg-sky-50 text-sky-700",
  FAILED: "border-rose-200 bg-rose-50 text-rose-700",
};

function fmtMoney(n: number | null): string {
  if (n == null) return "—";
  return n.toLocaleString("pt-PT", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function CatalogoListClient({ data, filters, filterOptions }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startNavigate] = useTransition();

  // Search local — só aplica no Enter / blur. Sincronizar com a URL externa
  // (back/forward, "Limpar filtros") via reset on prop change (sem useEffect).
  const urlSearch = filters.search ?? "";
  const [searchInput, setSearchInput] = useState(urlSearch);
  const [searchBaseline, setSearchBaseline] = useState(urlSearch);
  if (searchBaseline !== urlSearch) {
    setSearchBaseline(urlSearch);
    setSearchInput(urlSearch);
  }

  function buildHref(updates: Record<string, string | undefined>): string {
    const next = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(updates)) {
      if (v === undefined || v === "") next.delete(k);
      else next.set(k, v);
    }
    // Qualquer alteração de filtro reposiciona para página 1, exceto
    // quando o próprio update é a página.
    if (!("page" in updates)) next.delete("page");
    const qs = next.toString();
    return qs.length > 0 ? `${pathname}?${qs}` : pathname;
  }

  function navigate(updates: Record<string, string | undefined>): void {
    startNavigate(() => router.push(buildHref(updates)));
  }

  function commitSearch(): void {
    const trimmed = searchInput.trim();
    if (trimmed === urlSearch) return;
    navigate({ q: trimmed === "" ? undefined : trimmed });
  }

  function clearAll(): void {
    setSearchInput("");
    startNavigate(() => router.push(pathname));
  }

  const hasActiveFilters =
    !!filters.search ||
    !!filters.fabricanteId ||
    !!filters.productType ||
    !!filters.classificacaoN1Id ||
    !!filters.verificationStatus ||
    !!filters.estado;

  const startIdx = (data.page - 1) * data.pageSize + 1;
  const endIdx = Math.min(data.page * data.pageSize, data.total);

  return (
    <div className="space-y-3">
      <header className="space-y-0.5">
        <div className="text-xs font-medium text-slate-500">Catálogo / Master data</div>
        <h1 className="text-[28px] font-semibold tracking-tight text-slate-900">Catálogo</h1>
        <p className="text-[13px] text-slate-600">
          Visão mestre do produto, sem lógica operacional por farmácia.
        </p>
      </header>

      {/* Filtros */}
      <section className="rounded-[20px] border border-white/70 bg-white/90 px-4 py-3 shadow-[0_8px_18px_rgba(15,23,42,0.04)] backdrop-blur-xl">
        <div className="grid gap-2.5 lg:grid-cols-[2fr_1fr_1fr_1fr]">
          <label className="block">
            <div className="mb-1 text-[11px] font-medium text-slate-500">
              Pesquisa
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={searchInput}
                placeholder="CNP, designação, princípio ativo ou ATC"
                onChange={(e) => setSearchInput(e.target.value)}
                onBlur={commitSearch}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitSearch();
                  }
                }}
                className="h-9 w-full rounded-xl border border-slate-200 bg-white pl-9 pr-3 text-[13px] font-medium text-slate-800 outline-none transition focus:border-emerald-300 focus:ring-4 focus:ring-emerald-100"
              />
            </div>
          </label>

          <SelectFilter
            label="Fabricante"
            value={filters.fabricanteId ?? ""}
            onChange={(v) => navigate({ fabricante: v || undefined })}
            options={[
              { value: "", label: "Fabricante (todos)" },
              ...filterOptions.fabricantes.map((f) => ({
                value: f.id,
                label: f.nomeNormalizado,
              })),
            ]}
          />

          <SelectFilter
            label="Classificação N1"
            value={filters.classificacaoN1Id ?? ""}
            onChange={(v) => navigate({ n1: v || undefined })}
            options={[
              { value: "", label: "N1 (todos)" },
              ...filterOptions.classificacoesN1.map((c) => ({
                value: c.id,
                label: c.nome,
              })),
            ]}
          />

          <SelectFilter
            label="Tipo"
            value={filters.productType ?? ""}
            onChange={(v) => navigate({ tipo: v || undefined })}
            options={PRODUCT_TYPE_OPTIONS}
          />
        </div>

        <div className="mt-2.5 grid gap-2.5 lg:grid-cols-[1fr_1fr_auto]">
          <SelectFilter
            label="Verificação"
            value={filters.verificationStatus ?? ""}
            onChange={(v) => navigate({ verif: v || undefined })}
            options={VERIFICATION_OPTIONS}
          />
          <SelectFilter
            label="Estado"
            value={filters.estado ?? ""}
            onChange={(v) => navigate({ estado: v || undefined })}
            options={ESTADO_OPTIONS}
          />
          {hasActiveFilters && (
            <div className="flex items-end">
              <button
                type="button"
                onClick={clearAll}
                className="inline-flex h-9 items-center gap-1 rounded-xl border border-slate-200 bg-white px-3 text-[13px] font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
              >
                <X className="h-3.5 w-3.5" />
                Limpar
              </button>
            </div>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-2.5 text-[12px] text-slate-600">
          <span>
            <span className="font-semibold text-slate-900">
              {data.total.toLocaleString("pt-PT")}
            </span>{" "}
            produtos
            {data.total > 0 && (
              <span className="ml-2 text-slate-500">
                · a mostrar {startIdx.toLocaleString("pt-PT")}–
                {endIdx.toLocaleString("pt-PT")}
              </span>
            )}
          </span>

          <label className="flex items-center gap-2">
            <span className="text-[11px] uppercase tracking-[0.14em] text-slate-400">
              por página
            </span>
            <select
              value={data.pageSize}
              onChange={(e) => navigate({ pageSize: e.target.value })}
              className="h-7 rounded-lg border border-slate-200 bg-white px-2 text-[12px] font-medium text-slate-700 outline-none focus:border-emerald-300"
            >
              {PAGE_SIZE_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      {/* Tabela */}
      <section className="overflow-hidden rounded-[20px] border border-white/70 bg-white/90 shadow-[0_8px_18px_rgba(15,23,42,0.04)] backdrop-blur-xl">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left">
            <thead className="border-b border-slate-100 bg-slate-50/95 text-[10px] uppercase tracking-[0.14em] text-slate-500">
              <tr>
                <th className="w-[80px] px-3 py-2.5 font-semibold">CNP</th>
                <th className="px-3 py-2.5 font-semibold">Produto</th>
                <th className="px-3 py-2.5 font-semibold">Fabricante</th>
                <th className="px-3 py-2.5 font-semibold">Classificação</th>
                <th className="px-3 py-2.5 font-semibold">Tipo</th>
                <th className="px-3 py-2.5 font-semibold">ATC</th>
                <th className="px-2 py-2.5 text-right font-semibold">PVP min.</th>
                <th className="px-3 py-2.5 font-semibold">Verificação</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-[13px] text-slate-700">
              {data.rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-slate-400">
                    Sem produtos com os filtros actuais.
                  </td>
                </tr>
              ) : (
                data.rows.map((row) => <CatalogoRowCells key={row.id} row={row} />)
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Paginação */}
      {data.totalPages > 1 && (
        <Pagination
          page={data.page}
          totalPages={data.totalPages}
          buildHref={(p) => buildHref({ page: String(p) })}
        />
      )}
    </div>
  );
}

function CatalogoRowCells({ row }: { row: CatalogoRow }) {
  const tipoLabel = row.productType
    ? PRODUCT_TYPE_LABELS[row.productType] ?? row.productType
    : "—";
  const verifLabel = VERIFICATION_LABELS[row.verificationStatus] ?? row.verificationStatus;
  const verifTone = VERIFICATION_TONES[row.verificationStatus] ?? VERIFICATION_TONES.PENDING;

  const classifico = [row.classificacaoN1Nome, row.classificacaoN2Nome].filter(Boolean);

  return (
    <tr className="transition hover:bg-slate-50/70">
      <td className="px-3 py-2 align-top font-medium text-slate-800">{row.cnp}</td>
      <td className="px-3 py-2">
        <div className="flex items-start gap-2.5">
          {row.imagemUrl ? (
            <Image
              src={row.imagemUrl}
              alt=""
              width={36}
              height={36}
              unoptimized
              className="h-9 w-9 shrink-0 rounded-md border border-slate-200 bg-white object-contain"
            />
          ) : (
            <div className="h-9 w-9 shrink-0 rounded-md border border-dashed border-slate-200 bg-slate-50" />
          )}
          <div className="min-w-0">
            <Link
              href={`/catalogo/artigo/${row.cnp}`}
              className="block font-semibold leading-5 text-slate-900 transition hover:text-emerald-600"
            >
              {row.designacao}
            </Link>
            <div className="text-[11px] text-slate-500">
              {[row.formaFarmaceutica, row.dosagem, row.embalagem]
                .filter(Boolean)
                .join(" · ") || row.dci || "—"}
            </div>
          </div>
        </div>
      </td>
      <td className="px-3 py-2 text-[12px] text-slate-700">{row.fabricanteNome ?? "—"}</td>
      <td className="px-3 py-2 text-[12px] text-slate-700">
        {classifico.length === 0 ? (
          <span className="text-slate-400">—</span>
        ) : (
          <span>
            {classifico[0]}
            {classifico[1] && (
              <>
                <span className="px-1 text-slate-300">/</span>
                <span className="text-slate-500">{classifico[1]}</span>
              </>
            )}
          </span>
        )}
      </td>
      <td className="px-3 py-2 text-[12px] text-slate-600">{tipoLabel}</td>
      <td className="px-3 py-2 font-mono text-[12px] text-slate-600">
        {row.codigoATC ?? "—"}
      </td>
      <td className="px-2 py-2 text-right font-mono tabular-nums text-[12px] text-slate-700">
        {row.pvpMin == null ? "—" : `${fmtMoney(row.pvpMin)} €`}
      </td>
      <td className="px-3 py-2">
        <span
          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${verifTone}`}
        >
          {verifLabel}
        </span>
      </td>
    </tr>
  );
}

function SelectFilter({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-[11px] font-medium text-slate-500">{label}</div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full rounded-xl border border-slate-200 bg-white px-3 text-[13px] font-medium text-slate-800 outline-none transition focus:border-emerald-300 focus:ring-4 focus:ring-emerald-100"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Pagination({
  page,
  totalPages,
  buildHref,
}: {
  page: number;
  totalPages: number;
  buildHref: (p: number) => string;
}) {
  const prev = Math.max(1, page - 1);
  const next = Math.min(totalPages, page + 1);
  const isFirst = page <= 1;
  const isLast = page >= totalPages;

  return (
    <nav className="flex items-center justify-center gap-2 text-[12px]">
      <Link
        aria-disabled={isFirst}
        href={isFirst ? "#" : buildHref(prev)}
        className={`rounded-lg border px-3 py-1.5 font-medium transition ${
          isFirst
            ? "pointer-events-none border-slate-100 bg-slate-50 text-slate-300"
            : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
        }`}
      >
        ← Anterior
      </Link>
      <span className="text-slate-600">
        Página <span className="font-semibold text-slate-900">{page}</span> de{" "}
        <span className="font-semibold text-slate-900">{totalPages}</span>
      </span>
      <Link
        aria-disabled={isLast}
        href={isLast ? "#" : buildHref(next)}
        className={`rounded-lg border px-3 py-1.5 font-medium transition ${
          isLast
            ? "pointer-events-none border-slate-100 bg-slate-50 text-slate-300"
            : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
        }`}
      >
        Seguinte →
      </Link>
    </nav>
  );
}
