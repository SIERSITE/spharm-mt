"use client";

import { Fragment, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Ban, ChevronDown, Copy, FileText, Search, X } from "lucide-react";
import type {
  TransferenciaManutencaoData,
  TransferenciaManutencaoFilters,
  TransferenciaManutencaoRow,
} from "@/lib/transferencias/manutencao-data";
import type { EstadoTransferencia } from "@/generated/prisma/client";
import type { TransferenciaDetail } from "@/lib/transferencias/transferencia-detail";
import { DocumentosModal } from "@/components/reporting/documentos-modal";
import {
  deleteTransferenciaAction,
  anularTransferenciaAction,
  duplicarTransferenciaAction,
} from "@/app/transferencias/actions";
import { consultarTransferenciaAction } from "@/app/transferencias/manutencao/actions";

type Props = {
  data: TransferenciaManutencaoData;
  filters: TransferenciaManutencaoFilters;
  /** Mesma gate de `deleteTransferenciaAction` — controla o botão "Eliminar". */
  podeEliminar: boolean;
  /** Mesma gate de `anularTransferenciaAction` — controla o botão "Anular". */
  podeAnular: boolean;
};

function fmtDate(d: Date | string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("pt-PT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
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

const ESTADO_LABEL: Record<EstadoTransferencia, string> = {
  RASCUNHO: "Rascunho",
  FINALIZADA: "Finalizada",
  ANULADA: "Anulada",
  ELIMINADA: "Eliminada",
};

const ESTADO_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Todos os estados" },
  { value: "RASCUNHO", label: "Rascunho" },
  { value: "FINALIZADA", label: "Finalizada" },
  { value: "ANULADA", label: "Anulada" },
  { value: "ELIMINADA", label: "Eliminada" },
];

function EstadoBadge({ row }: { row: TransferenciaManutencaoRow }) {
  const base = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium";
  if (row.estado === "ANULADA") {
    return (
      <span className={`${base} border-rose-200 bg-rose-50 text-rose-700`}>
        <span className="rounded bg-rose-600 px-1 text-[9px] font-semibold uppercase tracking-wide text-white">
          Anulado
        </span>
        {ESTADO_LABEL.ANULADA}
      </span>
    );
  }
  if (row.estado === "ELIMINADA") {
    return <span className={`${base} border-slate-200 bg-slate-100 text-slate-400 line-through`}>{ESTADO_LABEL.ELIMINADA}</span>;
  }
  if (row.estado === "FINALIZADA") {
    return <span className={`${base} border-cyan-200 bg-cyan-50 text-cyan-700`}>{ESTADO_LABEL.FINALIZADA}</span>;
  }
  return <span className={`${base} border-slate-200 bg-slate-50 text-slate-600`}>{ESTADO_LABEL.RASCUNHO}</span>;
}

type DetalheState = { status: "loading" } | { status: "ok"; detalhe: TransferenciaDetail } | { status: "error"; error: string };

export function TransferenciaManutencaoClient({ data, filters, podeEliminar, podeAnular }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [busy, startTransition] = useTransition();
  const [navigating, startNavigate] = useTransition();
  const [flash, setFlash] = useState<{ type: "ok" | "err"; msg: string } | null>(null);

  const [documentosParaIds, setDocumentosParaIds] = useState<string[] | null>(null);

  // ── "Consultar" — expande a linha e mostra produto a produto ───────────
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detalhes, setDetalhes] = useState<Record<string, DetalheState>>({});

  function toggleConsultar(id: string) {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    if (detalhes[id]) return;
    setDetalhes((prev) => ({ ...prev, [id]: { status: "loading" } }));
    startTransition(async () => {
      const r = await consultarTransferenciaAction(id);
      setDetalhes((prev) => ({
        ...prev,
        [id]: r.ok ? { status: "ok", detalhe: r.detalhe } : { status: "error", error: r.error },
      }));
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
      const r = await anularTransferenciaAction(id, motivo);
      if (r.ok) {
        setFlash({ type: "ok", msg: "Transferência anulada." });
        setAnulandoId(null);
        setMotivoAnulacao("");
        router.refresh();
      } else {
        setFlash({ type: "err", msg: r.error });
      }
    });
  }

  function handleDelete(row: TransferenciaManutencaoRow) {
    if (
      !confirm(
        `Eliminar o rascunho ${row.numero ?? ""} (${row.farmaciaOrigemNome} → ${row.farmaciaDestinoNome})? A transferência deixa de aparecer nesta lista.`
      )
    ) {
      return;
    }
    setFlash(null);
    startTransition(async () => {
      const r = await deleteTransferenciaAction(row.id);
      if (r.ok) {
        setFlash({ type: "ok", msg: "Transferência eliminada." });
        router.refresh();
      } else {
        setFlash({ type: "err", msg: r.error });
      }
    });
  }

  function handleDuplicar(row: TransferenciaManutencaoRow) {
    setFlash(null);
    startTransition(async () => {
      const r = await duplicarTransferenciaAction(row.id);
      if (r.ok) {
        setFlash({ type: "ok", msg: "Transferência duplicada — novo rascunho criado." });
        router.refresh();
      } else {
        setFlash({ type: "err", msg: r.error });
      }
    });
  }

  // Search local — só faz commit no Enter/blur, mesmo padrão de order-list-client.
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
    !!filters.farmaciaOrigemId ||
    !!filters.farmaciaDestinoId ||
    !!filters.estado ||
    !!filters.search ||
    !!filters.dateFrom ||
    !!filters.dateTo;

  const startIdx = data.total === 0 ? 0 : (data.page - 1) * data.pageSize + 1;
  const endIdx = Math.min(data.total, data.page * data.pageSize);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-slate-500">
          {data.total === 0
            ? "0 transferências"
            : `${startIdx}–${endIdx} de ${data.total} transferência${data.total !== 1 ? "s" : ""}`}
        </p>
        <Link
          href="/transferencias"
          className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-[13px] font-medium text-slate-700 shadow-sm hover:bg-slate-50"
        >
          ← Voltar a Transferências
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
              placeholder="Procurar por número…"
              disabled={navigating}
              className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-[13px] focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-400 disabled:opacity-50"
            />
          </div>

          <select
            value={filters.farmaciaOrigemId ?? ""}
            onChange={(e) => pushUpdates({ origem: e.target.value || undefined })}
            disabled={navigating}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] focus:border-cyan-400 focus:outline-none disabled:opacity-50"
          >
            <option value="">Todas as origens</option>
            {data.farmacias.map((f) => (
              <option key={f.id} value={f.id}>
                {f.nome}
              </option>
            ))}
          </select>

          <select
            value={filters.farmaciaDestinoId ?? ""}
            onChange={(e) => pushUpdates({ destino: e.target.value || undefined })}
            disabled={navigating}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] focus:border-cyan-400 focus:outline-none disabled:opacity-50"
          >
            <option value="">Todos os destinos</option>
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
      {data.transferencias.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white px-6 py-12 text-center">
          {hasActiveFilters ? (
            <>
              <p className="text-[14px] text-slate-500">Nenhuma transferência encontrada com estes filtros.</p>
              <button
                type="button"
                onClick={clearAll}
                className="mt-3 inline-block text-[13px] font-medium text-cyan-600 hover:text-cyan-700"
              >
                Limpar filtros
              </button>
            </>
          ) : (
            <p className="text-[14px] text-slate-500">Nenhuma transferência criada.</p>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white">
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-slate-100 text-left text-[10px] uppercase tracking-wider text-slate-400">
                  <th className="px-4 py-3">Número</th>
                  <th className="px-4 py-3">Origem → Destino</th>
                  <th className="px-4 py-3">Estado</th>
                  <th className="px-4 py-3">Criado por</th>
                  <th className="px-4 py-3">Criação</th>
                  <th className="px-4 py-3">Finalização</th>
                  <th className="px-4 py-3 text-center">Refs.</th>
                  <th className="px-4 py-3 text-center">Unidades</th>
                  <th className="px-4 py-3 text-right">Acções</th>
                </tr>
              </thead>
              <tbody>
                {data.transferencias.map((row) => {
                  const detalhe = detalhes[row.id];
                  const isExpanded = expandedId === row.id;
                  const isAnulando = anulandoId === row.id;
                  return (
                    <Fragment key={row.id}>
                      <tr className="border-b border-slate-50 hover:bg-slate-25">
                        <td className="px-4 py-3 font-medium text-slate-800">{row.numero ?? "—"}</td>
                        <td className="px-4 py-3 text-slate-600">
                          {row.farmaciaOrigemNome} → {row.farmaciaDestinoNome}
                        </td>
                        <td className="px-4 py-3">
                          <EstadoBadge row={row} />
                          {row.estado === "ANULADA" && (
                            <div
                              className="mt-1 max-w-[220px] truncate text-[11px] text-rose-600"
                              title={[
                                row.motivoAnulacao ? `Motivo: ${row.motivoAnulacao}` : null,
                                row.anuladoPorNome ? `Por: ${row.anuladoPorNome}` : null,
                                row.anuladoEm ? `Em: ${fmtDate(row.anuladoEm)}` : null,
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            >
                              {row.motivoAnulacao ?? "—"}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-slate-600">{row.criadoPorNome}</td>
                        <td className="px-4 py-3 text-slate-500">{fmtDate(row.dataCriacao)}</td>
                        <td className="px-4 py-3 text-slate-500">{fmtDate(row.dataFinalizacao)}</td>
                        <td className="px-4 py-3 text-center text-slate-600">{row.nReferencias}</td>
                        <td className="px-4 py-3 text-center text-slate-600">{row.totalUnidades}</td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex flex-wrap items-center justify-end gap-1.5">
                            {row.estado === "RASCUNHO" && (
                              <Link
                                // Não existe hoje um ecrã dedicado a retomar um
                                // RASCUNHO de Transferencia por id (só
                                // ListaEncomenda tem /encomendas/[id]) — fica
                                // documentado como lacuna, ver relatório final.
                                href="/transferencias"
                                className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
                                title="Ainda não existe um ecrã de edição dedicado a um rascunho — abre a listagem de Transferências."
                              >
                                Continuar
                              </Link>
                            )}
                            {row.estado === "RASCUNHO" && podeEliminar && (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => handleDelete(row)}
                                className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-500 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50"
                              >
                                Eliminar
                              </button>
                            )}

                            {(row.estado === "FINALIZADA" || row.estado === "ANULADA" || row.estado === "ELIMINADA") && (
                              <button
                                type="button"
                                onClick={() => toggleConsultar(row.id)}
                                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-600 hover:border-cyan-300 hover:bg-cyan-50 hover:text-cyan-700"
                              >
                                <ChevronDown className={`h-3 w-3 transition ${isExpanded ? "rotate-180" : ""}`} />
                                Consultar
                              </button>
                            )}
                            {(row.estado === "FINALIZADA" || row.estado === "ANULADA") && (
                              <button
                                type="button"
                                onClick={() => setDocumentosParaIds([row.id])}
                                title="Imprimir / PDF / Email"
                                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-600 hover:border-cyan-300 hover:bg-cyan-50 hover:text-cyan-700"
                              >
                                <FileText className="h-3 w-3" />
                                Documento
                              </button>
                            )}
                            {row.estado === "FINALIZADA" && (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => handleDuplicar(row)}
                                title="Duplicar para um novo rascunho"
                                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-600 hover:border-cyan-300 hover:bg-cyan-50 hover:text-cyan-700 disabled:opacity-50"
                              >
                                <Copy className="h-3 w-3" />
                                Duplicar
                              </button>
                            )}
                            {row.estado === "FINALIZADA" && podeAnular && (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => abrirAnular(row.id)}
                                title="Anular esta transferência"
                                className="inline-flex items-center gap-1 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1 text-[11px] font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-50"
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
                          <td colSpan={9} className="px-4 py-3">
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

                      {isExpanded && (
                        <tr className="border-b border-slate-100 bg-slate-50/60">
                          <td colSpan={9} className="px-4 py-3">
                            {!detalhe || detalhe.status === "loading" ? (
                              <p className="text-[12px] text-slate-500">A carregar linhas…</p>
                            ) : detalhe.status === "error" ? (
                              <p className="text-[12px] text-rose-600">{detalhe.error}</p>
                            ) : detalhe.detalhe.linhas.length === 0 ? (
                              <p className="text-[12px] text-slate-500">Sem linhas.</p>
                            ) : (
                              <table className="w-full text-[12px]">
                                <thead>
                                  <tr className="text-left text-[10px] uppercase tracking-wider text-slate-400">
                                    <th className="py-1 pr-3">CNP</th>
                                    <th className="py-1 pr-3">Produto</th>
                                    <th className="py-1 pr-3">Fabricante</th>
                                    <th className="py-1 pr-3 text-right">Quantidade</th>
                                    <th className="py-1 pr-3">Notas</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {detalhe.detalhe.linhas.map((l) => (
                                    <tr key={l.produtoId} className="border-t border-slate-100">
                                      <td className="py-1.5 pr-3 text-slate-700">{l.cnp}</td>
                                      <td className="py-1.5 pr-3 text-slate-700">{l.designacao}</td>
                                      <td className="py-1.5 pr-3 text-slate-500">{l.fabricante ?? "—"}</td>
                                      <td className="py-1.5 pr-3 text-right text-slate-700">{l.quantidade}</td>
                                      <td className="py-1.5 pr-3 text-slate-500">{l.notas ?? "—"}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
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
              href={data.page < data.totalPages ? buildHref({ page: String(data.page + 1) }) : "#"}
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
          titulo="Documento da transferência"
          transferenciaIds={documentosParaIds}
          onClose={() => setDocumentosParaIds(null)}
        />
      )}
    </div>
  );
}
