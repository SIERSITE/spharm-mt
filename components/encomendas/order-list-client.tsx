"use client";

import { Fragment, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Ban, Copy, FileText, Search, X } from "lucide-react";
import type { OrderListData, OrderListFilters, OrderRow } from "@/lib/encomendas/orders-data";
import { OrderExportBadge } from "@/components/integracao/order-export-badge";
import { DocumentosModal } from "@/components/reporting/documentos-modal";
import {
  anularListaEncomendaAction,
  deleteListaEncomendaAction,
  duplicarListaEncomendaAction,
  finalizeOrderAction,
} from "@/app/encomendas/lista/actions";

type Props = {
  data: OrderListData;
  filters: OrderListFilters;
  /** Mesma gate de `deleteListaEncomendaAction` — controla o botão "Eliminar". */
  podeEliminar: boolean;
  /** Mesma gate de `anularListaEncomendaAction` — controla o botão "Anular". */
  podeAnular: boolean;
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
  ANULADA: "Anulada",
};

const ESTADO_OPTIONS = [
  { value: "", label: "Todos os estados" },
  { value: "RASCUNHO", label: "Rascunho" },
  { value: "FINALIZADA", label: "Finalizada" },
  { value: "EXPORTADA", label: "Exportada" },
  { value: "ANULADA", label: "Anulada" },
];

const EXPORT_OPTIONS = [
  { value: "", label: "Todas as exportações" },
  { value: "PENDENTE", label: "Pendente" },
  { value: "EM_EXPORTACAO", label: "Em exportação" },
  { value: "EXPORTADO", label: "Exportado" },
  { value: "FALHADO", label: "Falhado" },
  { value: "CANCELADO", label: "Cancelado" },
];

export function OrderListClient({ data, filters, podeEliminar, podeAnular }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [busy, startTransition] = useTransition();
  const [navigating, startNavigate] = useTransition();
  const [flash, setFlash] = useState<{ type: "ok" | "err"; msg: string } | null>(null);

  // ── Reimprimir/PDF/Email de encomendas já finalizadas ───────────────────
  //
  // Só RASCUNHO fica de fora — uma encomenda FINALIZADA ou EXPORTADA pode
  // ser reaberta para gerar documentos a qualquer momento, sem tocar em
  // nada (ver `DocumentosModal`). `selecionadas` guarda ids, não linhas
  // inteiras — nunca precisa de reconciliar com `data.orders` a cada
  // render.
  const [selecionadas, setSelecionadas] = useState<Set<string>>(new Set());
  const [documentosParaIds, setDocumentosParaIds] = useState<string[] | null>(null);
  const reimprimivel = (o: OrderRow) => o.estado !== "RASCUNHO";
  const idsReimprimiveis = data.orders.filter(reimprimivel).map((o) => o.id);
  function toggleSelecionada(id: string) {
    setSelecionadas((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleTodas() {
    setSelecionadas((prev) =>
      idsReimprimiveis.every((id) => prev.has(id)) ? new Set() : new Set(idsReimprimiveis)
    );
  }

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

  function handleDelete(order: OrderRow) {
    if (!confirm(`Eliminar a encomenda "${order.nome}"? A linha deixa de aparecer nesta lista (a encomenda e as suas linhas não são apagadas da base de dados).`)) {
      return;
    }
    setFlash(null);
    startTransition(async () => {
      const r = await deleteListaEncomendaAction(order.id);
      if (r.ok) {
        setFlash({ type: "ok", msg: "Encomenda eliminada." });
        router.refresh();
        return;
      }
      if ("requerConfirmacaoExportada" in r) {
        if (!confirm(`${r.aviso}\n\nEliminar mesmo assim?`)) return;
        const r2 = await deleteListaEncomendaAction(order.id, true);
        setFlash(
          r2.ok
            ? { type: "ok", msg: "Encomenda eliminada." }
            : { type: "err", msg: "error" in r2 ? r2.error : "Erro desconhecido" }
        );
        if (r2.ok) router.refresh();
        return;
      }
      setFlash({ type: "err", msg: r.error });
    });
  }

  // ── "Anular" — pequeno formulário inline a pedir o motivo ──────────────
  const [anulandoId, setAnulandoId] = useState<string | null>(null);
  const [motivoAnulacao, setMotivoAnulacao] = useState("");

  function abrirAnular(id: string) {
    setFlash(null);
    setAnulandoId(id);
    setMotivoAnulacao("");
  }

  function confirmarAnular() {
    if (!anulandoId) return;
    const motivo = motivoAnulacao.trim();
    if (!motivo) {
      setFlash({ type: "err", msg: "É obrigatório indicar um motivo para anular." });
      return;
    }
    const id = anulandoId;
    startTransition(async () => {
      const r = await anularListaEncomendaAction(id, motivo);
      if (r.ok) {
        setFlash({ type: "ok", msg: "Encomenda anulada." });
        setAnulandoId(null);
        setMotivoAnulacao("");
        router.refresh();
      } else {
        setFlash({ type: "err", msg: r.error });
      }
    });
  }

  function handleDuplicar(order: OrderRow) {
    setFlash(null);
    startTransition(async () => {
      const r = await duplicarListaEncomendaAction(order.id);
      if (r.ok) {
        setFlash({ type: "ok", msg: "Encomenda duplicada — novo rascunho criado." });
        router.refresh();
      } else {
        setFlash({ type: "err", msg: r.error });
      }
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

      {selecionadas.size > 0 && (
        <div className="flex items-center justify-between rounded-xl border border-cyan-200 bg-cyan-50 px-4 py-2.5 text-[13px] text-cyan-900">
          <span>
            {selecionadas.size} encomenda{selecionadas.size === 1 ? "" : "s"} seleccionada
            {selecionadas.size === 1 ? "" : "s"}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setDocumentosParaIds([...selecionadas])}
              className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500 bg-cyan-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-cyan-700"
            >
              <FileText className="h-3.5 w-3.5" />
              Imprimir · PDF · Email
            </button>
            <button
              type="button"
              onClick={() => setSelecionadas(new Set())}
              className="text-[12px] text-cyan-700 hover:text-cyan-900"
            >
              Limpar selecção
            </button>
          </div>
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
                  <th className="px-4 py-3">
                    {idsReimprimiveis.length > 0 && (
                      <input
                        type="checkbox"
                        checked={idsReimprimiveis.length > 0 && idsReimprimiveis.every((id) => selecionadas.has(id))}
                        onChange={toggleTodas}
                        title="Seleccionar todas as encomendas finalizadas/exportadas desta página"
                      />
                    )}
                  </th>
                  <th className="px-4 py-3">Nome</th>
                  <th className="px-4 py-3">Farmácia</th>
                  <th className="px-4 py-3">Estado</th>
                  <th className="px-4 py-3">Exportação</th>
                  <th className="px-4 py-3">Linhas</th>
                  <th className="px-4 py-3 text-right">Valor estim.</th>
                  <th className="px-4 py-3">Criado por</th>
                  <th className="px-4 py-3">Data</th>
                  <th className="px-4 py-3 text-right">Acções</th>
                </tr>
              </thead>
              <tbody>
                {data.orders.map((o) => {
                  const isAnulando = anulandoId === o.id;
                  return (
                  <Fragment key={o.id}>
                  <tr className="border-b border-slate-50 hover:bg-slate-25">
                    <td className="px-4 py-3">
                      {reimprimivel(o) && (
                        <input type="checkbox" checked={selecionadas.has(o.id)} onChange={() => toggleSelecionada(o.id)} />
                      )}
                    </td>
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
                              : o.estado === "ANULADA"
                                ? "border-rose-200 bg-rose-50 text-rose-700"
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
                    <td className="px-4 py-3 text-right tabular-nums text-slate-600">
                      {o.valorEstimado
                        ? `${o.valorEstimado.total.toLocaleString("pt-PT", { style: "currency", currency: "EUR" })}${o.valorEstimado.parcial ? "*" : ""}`
                        : "—"}
                    </td>
                    <td className="px-4 py-3 text-slate-600">{o.criadoPorNome}</td>
                    <td className="px-4 py-3 text-slate-500">
                      {/* Rascunho: a data que importa é a última gravação
                          (autosave), não a criação — pode ter sido há
                          semanas com dezenas de edições desde então. */}
                      {fmtDate(o.estado === "RASCUNHO" ? o.dataAtualizacao : o.dataCriacao)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        {o.estado === "RASCUNHO" && (
                          <Link
                            href={`/encomendas/${o.id}`}
                            className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
                          >
                            Continuar
                          </Link>
                        )}
                        {o.estado === "RASCUNHO" && (
                          <button
                            disabled={busy}
                            onClick={() => handleFinalize(o.id)}
                            className="rounded-lg border border-cyan-300 bg-cyan-50 px-2.5 py-1 text-[11px] font-medium text-cyan-700 hover:bg-cyan-100 disabled:opacity-50"
                          >
                            Finalizar
                          </button>
                        )}

                        {reimprimivel(o) && (
                          <button
                            onClick={() => setDocumentosParaIds([o.id])}
                            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-600 hover:border-cyan-300 hover:bg-cyan-50 hover:text-cyan-700"
                            title="Imprimir / PDF / Email"
                          >
                            <FileText className="h-3 w-3" />
                            Documentos
                          </button>
                        )}
                        {o.estado !== "RASCUNHO" && (
                          <button
                            disabled={busy}
                            onClick={() => handleDuplicar(o)}
                            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-600 hover:border-cyan-300 hover:bg-cyan-50 hover:text-cyan-700 disabled:opacity-50"
                            title="Duplicar para um novo rascunho"
                          >
                            <Copy className="h-3 w-3" />
                            Duplicar
                          </button>
                        )}
                        {/* "Eliminar" exclusiva de RASCUNHO desde 2026-09-29
                            — uma encomenda já finalizada/exportada anula-se. */}
                        {o.estado === "RASCUNHO" && podeEliminar && (
                          <button
                            disabled={busy}
                            onClick={() => handleDelete(o)}
                            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-500 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50"
                            title="Eliminar encomenda"
                          >
                            Eliminar
                          </button>
                        )}
                        {(o.estado === "FINALIZADA" || o.estado === "EXPORTADA") && podeAnular && (
                          <button
                            disabled={busy}
                            onClick={() => abrirAnular(o.id)}
                            className="inline-flex items-center gap-1 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1 text-[11px] font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-50"
                            title="Anular esta encomenda"
                          >
                            <Ban className="h-3 w-3" />
                            Anular
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {isAnulando && (
                    <tr className="border-b border-slate-50 bg-rose-50/40">
                      <td colSpan={10} className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <label className="text-[12px] font-medium text-rose-800">Motivo da anulação:</label>
                          <input
                            type="text"
                            value={motivoAnulacao}
                            onChange={(e) => setMotivoAnulacao(e.target.value)}
                            placeholder="Obrigatório — descreva o motivo"
                            className="min-w-[280px] flex-1 rounded-lg border border-rose-200 bg-white px-3 py-1.5 text-[12px] focus:border-rose-400 focus:outline-none"
                          />
                          <button
                            type="button"
                            disabled={busy}
                            onClick={confirmarAnular}
                            className="rounded-lg border border-rose-500 bg-rose-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-rose-700 disabled:opacity-50"
                          >
                            Confirmar anulação
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setAnulandoId(null);
                              setMotivoAnulacao("");
                            }}
                            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-600 hover:bg-slate-50"
                          >
                            Cancelar
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          {data.orders.some((o) => o.valorEstimado?.parcial) && (
            <p className="border-t border-slate-100 px-4 py-2 text-[11px] text-slate-400">
              * Valor estimado com base no custo (PUC) — algumas linhas não têm PUC conhecido e ficam
              de fora do total.
            </p>
          )}
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

      {documentosParaIds && (
        <DocumentosModal
          titulo={documentosParaIds.length === 1 ? "Documentos da encomenda" : "Documentos das encomendas seleccionadas"}
          listaEncomendaIds={documentosParaIds}
          onClose={() => setDocumentosParaIds(null)}
        />
      )}
    </div>
  );
}
