"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";
import type { OrderListData, OrderListFilters } from "@/lib/encomendas/orders-data";
import { OrderExportBadge } from "@/components/integracao/order-export-badge";
import {
  finalizeOrderAction,
  simulateAckAction,
  simulateNackAction,
} from "@/app/encomendas/lista/actions";

type Props = {
  data: OrderListData;
  filters: OrderListFilters;
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

function isoDate(d: Date | undefined): string {
  if (!d) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const ESTADO_LABEL: Record<string, string> = {
  RASCUNHO: "Rascunho",
  FINALIZADA: "Finalizada",
  EXPORTADA: "Exportada",
};

const ESTADO_OPTIONS = [
  { value: "", label: "Todos os estados" },
  { value: "RASCUNHO", label: "Rascunho" },
  { value: "FINALIZADA", label: "Finalizada" },
  { value: "EXPORTADA", label: "Exportada" },
];

const EXPORT_OPTIONS = [
  { value: "", label: "Todas as exportações" },
  { value: "PENDENTE", label: "Pendente" },
  { value: "EM_EXPORTACAO", label: "Em exportação" },
  { value: "EXPORTADO", label: "Exportado" },
  { value: "FALHADO", label: "Falhado" },
  { value: "CANCELADO", label: "Cancelado" },
];

export function OrderListClient({ data, filters }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [busy, startTransition] = useTransition();
  const [navigating, startNavigate] = useTransition();
  const [flash, setFlash] = useState<{ type: "ok" | "err"; msg: string } | null>(null);

  // Search local — só faz commit no Enter/blur. Para sincronizar com a
  // URL quando esta muda externamente (back/forward, "Limpar filtros"),
  // usamos o padrão de "reset on prop change" em vez de useEffect — é o
  // que o React 19 recomenda para evitar set-state-in-effect.
  const urlSearch = filters.search ?? "";
  const [searchInput, setSearchInput] = useState(urlSearch);
  const [searchInputBaseline, setSearchInputBaseline] = useState(urlSearch);
  if (searchInputBaseline !== urlSearch) {
    setSearchInputBaseline(urlSearch);
    setSearchInput(urlSearch);
  }

  function buildHref(updates: Record<string, string | undefined>): string {
    const params = new URLSearchParams(searchParams.toString());
    let touchedFilter = false;
    for (const [k, v] of Object.entries(updates)) {
      if (k !== "page" && k !== "pageSize") touchedFilter = true;
      if (v == null || v === "") {
        params.delete(k);
      } else {
        params.set(k, v);
      }
    }
    // Mudar um filtro reseta a paginação para a primeira página, a não
    // ser que o caller esteja explicitamente a navegar a paginação.
    if (touchedFilter && !("page" in updates)) {
      params.delete("page");
    }
    const qs = params.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  }

  function pushUpdates(updates: Record<string, string | undefined>) {
    startNavigate(() => {
      router.push(buildHref(updates));
    });
  }

  function commitSearch() {
    const v = searchInput.trim();
    if (v === (filters.search ?? "")) return;
    pushUpdates({ q: v || undefined });
  }

  function clearAll() {
    startNavigate(() => {
      router.push(pathname);
    });
  }

  const hasActiveFilters =
    !!filters.farmaciaId ||
    !!filters.estado ||
    !!filters.estadoExport ||
    !!filters.search ||
    !!filters.dateFrom ||
    !!filters.dateTo;

  // ───── Acções por linha (mantidas tal como estavam) ─────

  function handleFinalize(id: string) {
    if (!confirm("Finalizar esta encomenda e enviar para a fila de exportação?")) return;
    startTransition(async () => {
      const r = await finalizeOrderAction(id);
      setFlash(
        r.ok
          ? { type: "ok", msg: `Finalizada. Outbox: ${r.outboxId}` }
          : { type: "err", msg: r.error }
      );
    });
  }

  function handleSimulateAck(outboxId: string) {
    if (!confirm("Simular ACK (sucesso de exportação)?")) return;
    startTransition(async () => {
      const r = await simulateAckAction(outboxId);
      setFlash(
        r.ok
          ? { type: "ok", msg: "ACK simulado — encomenda marcada como exportada." }
          : { type: "err", msg: r.error }
      );
    });
  }

  function handleSimulateNack(outboxId: string) {
    if (!confirm("Simular NACK (falha de exportação)?")) return;
    startTransition(async () => {
      const r = await simulateNackAction(outboxId);
      setFlash(
        r.ok
          ? { type: "ok", msg: "NACK simulado — encomenda marcada como falhada." }
          : { type: "err", msg: r.error }
      );
    });
  }

  // ───── Render ─────

  const startIdx = data.total === 0 ? 0 : (data.page - 1) * data.pageSize + 1;
  const endIdx = Math.min(data.total, data.page * data.pageSize);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[13px] text-slate-500">
            {data.total === 0
              ? "0 encomendas"
              : `${startIdx}–${endIdx} de ${data.total} encomenda${data.total !== 1 ? "s" : ""}`}
          </p>
        </div>
        <Link
          href="/encomendas/nova"
          className="rounded-xl border border-cyan-500 bg-cyan-600 px-4 py-2 text-[13px] font-medium text-white shadow-sm hover:bg-cyan-700"
        >
          + Nova encomenda
        </Link>
      </div>

      {/* Filtros */}
      <section className="rounded-xl border border-slate-200 bg-white px-4 py-3">
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr_auto_auto]">
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
              placeholder="Procurar por nome…"
              disabled={navigating}
              className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-[13px] focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-400 disabled:opacity-50"
            />
          </div>

          <select
            value={filters.farmaciaId ?? ""}
            onChange={(e) => pushUpdates({ farmacia: e.target.value || undefined })}
            disabled={navigating}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] focus:border-cyan-400 focus:outline-none disabled:opacity-50"
          >
            <option value="">Todas as farmácias</option>
            {data.farmacias.map((f) => (
              <option key={f.id} value={f.id}>
                {f.nome}
              </option>
            ))}
          </select>

          <select
            value={filters.estado ?? ""}
            onChange={(e) => pushUpdates({ estado: e.target.value || undefined })}
            disabled={navigating}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] focus:border-cyan-400 focus:outline-none disabled:opacity-50"
          >
            {ESTADO_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>

          <select
            value={filters.estadoExport ?? ""}
            onChange={(e) => pushUpdates({ export: e.target.value || undefined })}
            disabled={navigating}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] focus:border-cyan-400 focus:outline-none disabled:opacity-50"
          >
            {EXPORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>

          <input
            type="date"
            value={isoDate(filters.dateFrom)}
            onChange={(e) => pushUpdates({ from: e.target.value || undefined })}
            disabled={navigating}
            title="Data início"
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] focus:border-cyan-400 focus:outline-none disabled:opacity-50"
          />
          <input
            type="date"
            value={isoDate(filters.dateTo)}
            onChange={(e) => pushUpdates({ to: e.target.value || undefined })}
            disabled={navigating}
            title="Data fim"
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] focus:border-cyan-400 focus:outline-none disabled:opacity-50"
          />
        </div>

        {hasActiveFilters && (
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={clearAll}
              disabled={navigating}
              className="inline-flex items-center gap-1 text-[12px] text-slate-500 hover:text-slate-800 disabled:opacity-50"
            >
              <X className="h-3 w-3" />
              Limpar filtros
            </button>
          </div>
        )}
      </section>

      {flash && (
        <div
          className={`rounded-xl border px-4 py-3 text-[13px] ${
            flash.type === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-rose-200 bg-rose-50 text-rose-800"
          }`}
        >
          {flash.msg}
        </div>
      )}

      {/* Tabela */}
      {data.orders.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white px-6 py-12 text-center">
          {hasActiveFilters ? (
            <>
              <p className="text-[14px] text-slate-500">
                Nenhuma encomenda encontrada com estes filtros.
              </p>
              <button
                type="button"
                onClick={clearAll}
                className="mt-3 inline-block text-[13px] font-medium text-cyan-600 hover:text-cyan-700"
              >
                Limpar filtros
              </button>
            </>
          ) : (
            <>
              <p className="text-[14px] text-slate-500">Nenhuma encomenda criada.</p>
              <Link
                href="/encomendas/nova"
                className="mt-3 inline-block text-[13px] font-medium text-cyan-600 hover:text-cyan-700"
              >
                Criar a primeira encomenda
              </Link>
            </>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white">
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-slate-100 text-left text-[10px] uppercase tracking-wider text-slate-400">
                  <th className="px-4 py-3">Nome</th>
                  <th className="px-4 py-3">Farmácia</th>
                  <th className="px-4 py-3">Estado</th>
                  <th className="px-4 py-3">Exportação</th>
                  <th className="px-4 py-3">Linhas</th>
                  <th className="px-4 py-3">Criado por</th>
                  <th className="px-4 py-3">Data</th>
                  <th className="px-4 py-3 text-right">Acções</th>
                </tr>
              </thead>
              <tbody>
                {data.orders.map((o) => (
                  <tr key={o.id} className="border-b border-slate-50 hover:bg-slate-25">
                    <td className="px-4 py-3 font-medium">
                      <Link
                        href={`/encomendas/${o.id}`}
                        className="text-cyan-700 hover:text-cyan-900 hover:underline"
                      >
                        {o.nome}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{o.farmaciaNome}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                          o.estado === "RASCUNHO"
                            ? "border-slate-200 bg-slate-50 text-slate-600"
                            : o.estado === "FINALIZADA"
                              ? "border-cyan-200 bg-cyan-50 text-cyan-700"
                              : "border-emerald-200 bg-emerald-50 text-emerald-700"
                        }`}
                      >
                        {ESTADO_LABEL[o.estado] ?? o.estado}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <OrderExportBadge
                        state={o.estadoExport}
                        spharmDocumentId={o.spharmDocumentId}
                        exportedAt={o.exportedAt}
                      />
                    </td>
                    <td className="px-4 py-3 text-slate-600">{o.linhasCount}</td>
                    <td className="px-4 py-3 text-slate-600">{o.criadoPorNome}</td>
                    <td className="px-4 py-3 text-slate-500">{fmtDate(o.dataCriacao)}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        {o.estado === "RASCUNHO" && (
                          <button
                            disabled={busy}
                            onClick={() => handleFinalize(o.id)}
                            className="rounded-lg border border-cyan-300 bg-cyan-50 px-2.5 py-1 text-[11px] font-medium text-cyan-700 hover:bg-cyan-100 disabled:opacity-50"
                          >
                            Finalizar
                          </button>
                        )}

                        {o.outboxId &&
                          (o.estadoExport === "PENDENTE" ||
                            o.estadoExport === "EM_EXPORTACAO") && (
                            <>
                              <button
                                disabled={busy}
                                onClick={() => handleSimulateAck(o.outboxId!)}
                                className="rounded-lg border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                                title="Simular sucesso (ACK)"
                              >
                                ACK
                              </button>
                              <button
                                disabled={busy}
                                onClick={() => handleSimulateNack(o.outboxId!)}
                                className="rounded-lg border border-rose-300 bg-rose-50 px-2.5 py-1 text-[11px] font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-50"
                                title="Simular falha (NACK)"
                              >
                                NACK
                              </button>
                            </>
                          )}
                      </div>
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
                data.page < data.totalPages
                  ? buildHref({ page: String(data.page + 1) })
                  : "#"
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

      {/* Legend */}
      <section className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
        <h3 className="text-[12px] font-semibold uppercase tracking-wider text-slate-500">
          Ferramentas de teste
        </h3>
        <p className="mt-1 text-[12px] text-slate-500">
          Os botões <strong>ACK</strong> e <strong>NACK</strong> simulam respostas do agent de
          exportação. ACK marca a encomenda como exportada com sucesso (gera um SPharm Document ID
          simulado). NACK marca como falhada. Estas acções são apenas para testar o fluxo antes do
          agent real estar ligado.
        </p>
      </section>
    </div>
  );
}
