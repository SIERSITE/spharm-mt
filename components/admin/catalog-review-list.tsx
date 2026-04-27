"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";
import type { ReviewListData, ReviewListFilters } from "@/lib/admin/catalog-review-data";
import type {
  EstadoFilaRevisao,
  PrioridadeRevisao,
  TipoRevisao,
} from "@/generated/prisma/client";

type Props = {
  data: ReviewListData;
  filters: ReviewListFilters;
};

const TIPO_LABEL: Record<TipoRevisao, string> = {
  NOVO_PRODUTO: "Novo produto",
  ENRIQUECIMENTO_FALHOU: "Enriquecimento falhou",
  CONFLITO: "Conflito entre fontes",
  CLASSIFICACAO_PENDENTE: "Classificação pendente",
  FABRICANTE_PENDENTE: "Fabricante pendente",
  OUTRO: "Outro",
};

const PRIO_LABEL: Record<PrioridadeRevisao, string> = {
  ALTA: "Alta",
  MEDIA: "Média",
  BAIXA: "Baixa",
};

const ESTADO_LABEL: Record<EstadoFilaRevisao, string> = {
  PENDENTE: "Pendente",
  RESOLVIDO: "Resolvido",
  IGNORADO: "Ignorado",
};

const PRIO_BADGE: Record<PrioridadeRevisao, string> = {
  ALTA: "border-rose-200 bg-rose-50 text-rose-700",
  MEDIA: "border-amber-200 bg-amber-50 text-amber-700",
  BAIXA: "border-slate-200 bg-slate-50 text-slate-600",
};

function fmtDate(d: Date | string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("pt-PT", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtPct(v: number | null): string {
  if (v == null) return "—";
  return `${Math.round(v * 100)}%`;
}

export function CatalogReviewList({ data, filters }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const urlSearch = filters.search ?? "";
  const [searchInput, setSearchInput] = useState(urlSearch);
  const [searchBaseline, setSearchBaseline] = useState(urlSearch);
  if (searchBaseline !== urlSearch) {
    setSearchBaseline(urlSearch);
    setSearchInput(urlSearch);
  }

  function buildHref(updates: Record<string, string | undefined>): string {
    const params = new URLSearchParams(searchParams.toString());
    let touchedFilter = false;
    for (const [k, v] of Object.entries(updates)) {
      if (k !== "page" && k !== "pageSize") touchedFilter = true;
      if (v == null || v === "") params.delete(k);
      else params.set(k, v);
    }
    if (touchedFilter && !("page" in updates)) params.delete("page");
    const qs = params.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  }

  function pushUpdates(updates: Record<string, string | undefined>) {
    router.push(buildHref(updates));
  }

  function commitSearch() {
    const v = searchInput.trim();
    if (v === (filters.search ?? "")) return;
    pushUpdates({ q: v || undefined });
  }

  function clearAll() {
    router.push(pathname);
  }

  const hasActiveFilters =
    !!filters.tipoRevisao || !!filters.prioridade || !!filters.search ||
    (!!filters.estado && filters.estado !== "PENDENTE");

  const startIdx = data.total === 0 ? 0 : (data.page - 1) * data.pageSize + 1;
  const endIdx = Math.min(data.total, data.page * data.pageSize);

  return (
    <div className="space-y-5">
      {/* Resumo por tipo */}
      <section className="grid gap-3 md:grid-cols-3 lg:grid-cols-6">
        {(Object.entries(data.counts.pendentePorTipo) as Array<[TipoRevisao, number]>).map(
          ([tipo, count]) => (
            <Link
              key={tipo}
              href={buildHref({ tipo, estado: undefined })}
              className={`rounded-2xl border px-4 py-3 transition hover:border-cyan-400 ${
                filters.tipoRevisao === tipo
                  ? "border-cyan-400 bg-cyan-50"
                  : "border-slate-200 bg-white"
              }`}
            >
              <div className="text-[10px] uppercase tracking-wider text-slate-500">
                {TIPO_LABEL[tipo]}
              </div>
              <div className="mt-1 text-[22px] font-semibold text-slate-900">{count}</div>
            </Link>
          )
        )}
      </section>

      {/* Filtros */}
      <section className="rounded-xl border border-slate-200 bg-white px-4 py-3">
        <div className="grid gap-3 md:grid-cols-[1.5fr_1fr_1fr_1fr_auto]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onBlur={commitSearch}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitSearch();
                } else if (e.key === "Escape") {
                  setSearchInput("");
                  pushUpdates({ q: undefined });
                }
              }}
              placeholder="Procurar por CNP ou designação…"
              className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-[13px] focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-400"
            />
          </div>

          <select
            value={filters.tipoRevisao ?? ""}
            onChange={(e) => pushUpdates({ tipo: e.target.value || undefined })}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] focus:border-cyan-400 focus:outline-none"
          >
            <option value="">Todos os tipos</option>
            {(Object.keys(TIPO_LABEL) as TipoRevisao[]).map((t) => (
              <option key={t} value={t}>
                {TIPO_LABEL[t]}
              </option>
            ))}
          </select>

          <select
            value={filters.prioridade ?? ""}
            onChange={(e) => pushUpdates({ prioridade: e.target.value || undefined })}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] focus:border-cyan-400 focus:outline-none"
          >
            <option value="">Todas as prioridades</option>
            {(Object.keys(PRIO_LABEL) as PrioridadeRevisao[]).map((p) => (
              <option key={p} value={p}>
                {PRIO_LABEL[p]}
              </option>
            ))}
          </select>

          <select
            value={filters.estado ?? "PENDENTE"}
            onChange={(e) => pushUpdates({ estado: e.target.value || undefined })}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] focus:border-cyan-400 focus:outline-none"
          >
            {(Object.keys(ESTADO_LABEL) as EstadoFilaRevisao[]).map((s) => (
              <option key={s} value={s}>
                {ESTADO_LABEL[s]}
              </option>
            ))}
          </select>

          {hasActiveFilters && (
            <button
              type="button"
              onClick={clearAll}
              className="inline-flex items-center justify-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[12px] text-slate-600 hover:bg-slate-50"
            >
              <X className="h-3 w-3" />
              Limpar
            </button>
          )}
        </div>
      </section>

      {/* Total */}
      <div className="text-[12px] text-slate-500">
        {data.total === 0
          ? "0 itens"
          : `${startIdx}–${endIdx} de ${data.total} item${data.total !== 1 ? "ns" : ""}`}
      </div>

      {/* Tabela */}
      {data.rows.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white px-6 py-12 text-center">
          <p className="text-[14px] text-slate-500">
            {hasActiveFilters
              ? "Nenhum item com estes filtros."
              : "Sem revisões pendentes — catálogo limpo."}
          </p>
          {hasActiveFilters && (
            <button
              type="button"
              onClick={clearAll}
              className="mt-3 inline-block text-[13px] font-medium text-cyan-600 hover:text-cyan-700"
            >
              Limpar filtros
            </button>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white">
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-slate-100 text-left text-[10px] uppercase tracking-wider text-slate-400">
                  <th className="px-4 py-3">CNP</th>
                  <th className="px-4 py-3">Designação</th>
                  <th className="px-4 py-3">Tipo proposto</th>
                  <th className="px-4 py-3 text-right">Confiança</th>
                  <th className="px-4 py-3">Motivo</th>
                  <th className="px-4 py-3">Prioridade</th>
                  <th className="px-4 py-3">Criado</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id} className="border-b border-slate-50 last:border-b-0">
                    <td className="px-4 py-3 font-mono text-[12px] text-slate-700">{r.cnp}</td>
                    <td className="px-4 py-3 font-medium text-slate-900">
                      <Link
                        href={`/admin/catalogo/revisao/${r.id}`}
                        className="hover:text-cyan-700 hover:underline"
                      >
                        {r.designacao}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {r.productType ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700">
                      {fmtPct(r.productTypeConfidence)}
                    </td>
                    <td className="px-4 py-3 text-[12px] text-slate-600">
                      <div className="font-medium">{TIPO_LABEL[r.tipoRevisao]}</div>
                      {r.manualReviewReason && (
                        <div className="text-[11px] text-slate-500">
                          {r.manualReviewReason}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${PRIO_BADGE[r.prioridade]}`}
                      >
                        {PRIO_LABEL[r.prioridade]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-500">{fmtDate(r.dataCriacao)}</td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/admin/catalogo/revisao/${r.id}`}
                        className="rounded-lg border border-cyan-300 bg-cyan-50 px-3 py-1 text-[12px] font-medium text-cyan-700 hover:bg-cyan-100"
                      >
                        Rever →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Paginação */}
      {data.totalPages > 1 && (
        <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3 text-[12px]">
          <div className="text-slate-500">
            Página <span className="font-medium text-slate-700">{data.page}</span> de{" "}
            <span className="font-medium text-slate-700">{data.totalPages}</span>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href={data.page > 1 ? buildHref({ page: String(data.page - 1) }) : "#"}
              aria-disabled={data.page <= 1}
              className={`rounded-lg border px-3 py-1.5 text-[12px] font-medium ${
                data.page > 1
                  ? "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                  : "pointer-events-none border-slate-100 bg-slate-50 text-slate-300"
              }`}
            >
              ← Anterior
            </Link>
            <Link
              href={
                data.page < data.totalPages ? buildHref({ page: String(data.page + 1) }) : "#"
              }
              aria-disabled={data.page >= data.totalPages}
              className={`rounded-lg border px-3 py-1.5 text-[12px] font-medium ${
                data.page < data.totalPages
                  ? "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                  : "pointer-events-none border-slate-100 bg-slate-50 text-slate-300"
              }`}
            >
              Próxima →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
