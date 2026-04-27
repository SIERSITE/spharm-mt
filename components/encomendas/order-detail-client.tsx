"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import type { OrderDetail, OrderTimelineEvent } from "@/lib/encomendas/order-detail";
import { OrderExportBadge } from "@/components/integracao/order-export-badge";
import { ProductPicker } from "@/components/encomendas/product-picker";
import {
  addManualLineAction,
  finalizeFromDetailAction,
  removeLineAction,
  updateLineAction,
} from "@/app/encomendas/[id]/actions";
import type { ProductSearchResult } from "@/app/encomendas/nova/search";

type Props = { detail: OrderDetail };

const ESTADO_LABEL: Record<string, string> = {
  RASCUNHO: "Rascunho",
  FINALIZADA: "Finalizada",
  EXPORTADA: "Exportada",
};

function fmtNum(v: number | null, digits = 0): string {
  if (v == null) return "—";
  if (digits === 0) return String(Math.round(v));
  return v.toFixed(digits);
}

function fmtDateTime(d: Date | string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("pt-PT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const TIMELINE_STATUS_STYLE: Record<string, string> = {
  ATTEMPT: "border-slate-200 bg-slate-50 text-slate-700",
  LEASE_CLAIMED: "border-cyan-200 bg-cyan-50 text-cyan-700",
  LEASE_RELEASED: "border-slate-200 bg-slate-50 text-slate-600",
  LEASE_EXPIRED: "border-amber-200 bg-amber-50 text-amber-700",
  SUCCESS: "border-emerald-200 bg-emerald-50 text-emerald-700",
  FAILURE: "border-rose-200 bg-rose-50 text-rose-700",
  RETRY_SCHEDULED: "border-amber-200 bg-amber-50 text-amber-700",
  GAVE_UP: "border-rose-300 bg-rose-100 text-rose-800",
  MANUAL_RETRY: "border-cyan-200 bg-cyan-50 text-cyan-700",
  MANUAL_CANCEL: "border-slate-200 bg-slate-50 text-slate-600",
};

export function OrderDetailClient({ detail }: Props) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [flash, setFlash] = useState<{ type: "ok" | "err" | "info"; msg: string } | null>(
    null
  );
  const [manualOpen, setManualOpen] = useState(false);

  // Estado optimista das linhas — actualizamos localmente e a server
  // action revalida o path (refresh do server component empurra a fonte
  // de verdade). Em caso de erro, o flash mostra e o router refresh
  // restaura.
  const [linhas, setLinhas] = useState(detail.linhas);

  const editable = detail.editable && !busy;
  const totalQty = linhas.reduce(
    (s, l) => s + (l.quantidadeAjustada ?? 0),
    0
  );

  function handleQtyChange(linhaId: string, value: string) {
    const n = value === "" ? null : Number(value);
    setLinhas((prev) =>
      prev.map((l) =>
        l.id === linhaId
          ? { ...l, quantidadeAjustada: n != null && Number.isFinite(n) ? Math.max(0, n) : null }
          : l
      )
    );
  }

  function handleNotasChange(linhaId: string, value: string) {
    setLinhas((prev) =>
      prev.map((l) => (l.id === linhaId ? { ...l, notas: value } : l))
    );
  }

  function persistLine(
    linhaId: string,
    patch: { quantidadeAjustada?: number | null; notas?: string | null }
  ) {
    setFlash(null);
    startTransition(async () => {
      const r = await updateLineAction({
        listaEncomendaId: detail.id,
        linhaId,
        ...patch,
      });
      if (!r.ok) {
        setFlash({ type: "err", msg: r.error });
        router.refresh();
      }
    });
  }

  function handleQtyBlur(linhaId: string) {
    const line = linhas.find((l) => l.id === linhaId);
    if (!line) return;
    persistLine(linhaId, { quantidadeAjustada: line.quantidadeAjustada });
  }

  function handleNotasBlur(linhaId: string) {
    const line = linhas.find((l) => l.id === linhaId);
    if (!line) return;
    persistLine(linhaId, { notas: line.notas });
  }

  function handleRemove(linhaId: string) {
    if (!confirm("Remover esta linha da encomenda?")) return;
    setFlash(null);
    startTransition(async () => {
      const r = await removeLineAction({
        listaEncomendaId: detail.id,
        linhaId,
      });
      if (r.ok) {
        setLinhas((prev) => prev.filter((l) => l.id !== linhaId));
        setFlash({ type: "info", msg: "Linha removida." });
      } else {
        setFlash({ type: "err", msg: r.error });
      }
    });
  }

  function handlePickManual(p: ProductSearchResult) {
    setFlash(null);
    startTransition(async () => {
      const r = await addManualLineAction({
        listaEncomendaId: detail.id,
        produtoId: p.id,
        quantidadeAjustada: 1,
      });
      if (r.ok) {
        setFlash({ type: "ok", msg: `${p.designacao} adicionado.` });
        router.refresh();
      } else {
        setFlash({ type: "err", msg: r.error });
      }
    });
  }

  function handleFinalize() {
    if (!confirm("Finalizar esta encomenda e enviar para a fila de exportação?")) return;
    setFlash(null);
    startTransition(async () => {
      const r = await finalizeFromDetailAction(detail.id);
      if (r.ok) {
        setFlash({ type: "ok", msg: `Finalizada. Outbox: ${r.outboxId}` });
        router.refresh();
      } else {
        setFlash({ type: "err", msg: r.error });
      }
    });
  }

  return (
    <div className="space-y-6">
      {/* Voltar + título */}
      <div className="flex items-center justify-between">
        <Link
          href="/encomendas/lista"
          className="inline-flex items-center gap-1.5 text-[13px] text-slate-600 hover:text-slate-900"
        >
          <ArrowLeft className="h-4 w-4" />
          Lista de encomendas
        </Link>
      </div>

      {/* Header */}
      <section className="rounded-xl border border-slate-200 bg-white px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold text-slate-900">{detail.nome}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-slate-600">
              <span>
                <span className="text-slate-400">Farmácia:</span> {detail.farmaciaNome}
              </span>
              <span className="text-slate-300">·</span>
              <span>
                <span className="text-slate-400">Criado por:</span> {detail.criadoPorNome}
              </span>
              <span className="text-slate-300">·</span>
              <span>
                <span className="text-slate-400">Criado:</span> {fmtDateTime(detail.dataCriacao)}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                detail.estado === "RASCUNHO"
                  ? "border-slate-200 bg-slate-50 text-slate-600"
                  : detail.estado === "FINALIZADA"
                    ? "border-cyan-200 bg-cyan-50 text-cyan-700"
                    : "border-emerald-200 bg-emerald-50 text-emerald-700"
              }`}
            >
              {ESTADO_LABEL[detail.estado] ?? detail.estado}
            </span>
            <OrderExportBadge
              state={detail.estadoExport}
              spharmDocumentId={detail.outbox?.spharmDocumentId ?? null}
              exportedAt={detail.outbox?.exportedAt ?? null}
            />
          </div>
        </div>

        {detail.outbox && (
          <div className="mt-3 grid gap-x-6 gap-y-1 border-t border-slate-100 pt-3 text-[12px] text-slate-600 md:grid-cols-3">
            <div>
              <span className="text-slate-400">Outbox:</span>{" "}
              <span className="font-mono">{detail.outbox.id}</span>
            </div>
            <div>
              <span className="text-slate-400">Tentativas:</span> {detail.outbox.attemptCount}
            </div>
            {detail.outbox.spharmDocumentId && (
              <div>
                <span className="text-slate-400">SPharm doc:</span>{" "}
                <span className="font-mono">{detail.outbox.spharmDocumentId}</span>
              </div>
            )}
            {detail.outbox.lastError && (
              <div className="md:col-span-3">
                <span className="text-rose-500">Último erro:</span>{" "}
                <span className="text-rose-700">{detail.outbox.lastError}</span>
              </div>
            )}
          </div>
        )}
      </section>

      {flash && (
        <div
          className={`rounded-xl border px-4 py-3 text-[13px] ${
            flash.type === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : flash.type === "info"
                ? "border-cyan-200 bg-cyan-50 text-cyan-800"
                : "border-rose-200 bg-rose-50 text-rose-800"
          }`}
        >
          {flash.msg}
        </div>
      )}

      {!detail.editable && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-[12px] text-slate-600">
          Esta encomenda já não é editável (estado: {ESTADO_LABEL[detail.estado] ?? detail.estado}).
          O payload do outbox é congelado na finalização — qualquer mudança implicaria cancelar e
          recriar.
        </div>
      )}

      {/* Linhas */}
      <section className="rounded-xl border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <div>
            <h2 className="text-[14px] font-semibold text-slate-900">Linhas</h2>
            <p className="mt-0.5 text-[12px] text-slate-500">
              {linhas.length === 0
                ? "Sem linhas."
                : `${linhas.length} linha${linhas.length === 1 ? "" : "s"} · total: ${totalQty}`}
            </p>
          </div>
        </div>

        {linhas.length === 0 ? (
          <div className="px-4 py-10 text-center text-[12px] text-slate-400">
            Nenhuma linha — adicione produtos abaixo.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-slate-100 text-left text-[10px] uppercase tracking-wider text-slate-400">
                  <th className="px-3 py-2">Produto</th>
                  <th className="px-3 py-2 text-right">Stock</th>
                  <th className="px-3 py-2 text-right">Sugerida</th>
                  <th className="px-3 py-2 text-right">Final</th>
                  <th className="px-3 py-2">Notas</th>
                  {editable && <th className="px-3 py-2"></th>}
                </tr>
              </thead>
              <tbody>
                {linhas.map((l) => (
                  <tr key={l.id} className="border-b border-slate-50">
                    <td className="px-3 py-2">
                      <div className="font-medium text-slate-900">{l.designacao}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-slate-500">
                        <span className="font-mono">CNP {l.cnp}</span>
                        {l.fabricante && (
                          <>
                            <span className="text-slate-300">·</span>
                            <span>{l.fabricante}</span>
                          </>
                        )}
                        {l.fornecedor && (
                          <>
                            <span className="text-slate-300">·</span>
                            <span className="text-slate-400">{l.fornecedor}</span>
                          </>
                        )}
                      </div>
                    </td>
                    <td
                      className={`px-3 py-2 text-right tabular-nums ${
                        l.currentStock != null && l.currentStock <= 0
                          ? "text-rose-600"
                          : "text-slate-700"
                      }`}
                    >
                      {fmtNum(l.currentStock)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                      {fmtNum(l.quantidadeSugerida)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {editable ? (
                        <input
                          type="number"
                          min="0"
                          value={l.quantidadeAjustada ?? ""}
                          onChange={(e) => handleQtyChange(l.id, e.target.value)}
                          onBlur={() => handleQtyBlur(l.id)}
                          disabled={busy}
                          className="w-20 rounded-lg border border-slate-200 px-2 py-1 text-right text-[13px] focus:border-cyan-400 focus:outline-none disabled:opacity-50"
                        />
                      ) : (
                        <span className="font-medium text-slate-800">
                          {fmtNum(l.quantidadeAjustada)}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {editable ? (
                        <input
                          type="text"
                          value={l.notas ?? ""}
                          onChange={(e) => handleNotasChange(l.id, e.target.value)}
                          onBlur={() => handleNotasBlur(l.id)}
                          placeholder="opcional"
                          disabled={busy}
                          className="w-full rounded-lg border border-slate-200 px-2 py-1 text-[12px] placeholder:text-slate-300 focus:border-cyan-400 focus:outline-none disabled:opacity-50"
                        />
                      ) : (
                        <span className="text-slate-600">{l.notas ?? "—"}</span>
                      )}
                    </td>
                    {editable && (
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => handleRemove(l.id)}
                          disabled={busy}
                          title="Remover linha"
                          className="rounded-md border border-slate-200 p-1.5 text-slate-500 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Adicionar produto manual */}
      {detail.editable && (
        <section className="rounded-xl border border-slate-200 bg-white">
          <button
            type="button"
            onClick={() => setManualOpen((v) => !v)}
            className="flex w-full items-center justify-between border-b border-slate-100 px-4 py-3 text-left"
          >
            <div>
              <h2 className="text-[14px] font-semibold text-slate-900">
                Adicionar produto manual
              </h2>
              <p className="mt-0.5 text-[12px] text-slate-500">
                Excepção — adiciona uma linha extra fora da proposta original.
              </p>
            </div>
            <Plus
              className={`h-4 w-4 text-slate-400 transition ${manualOpen ? "rotate-45" : ""}`}
            />
          </button>
          {manualOpen && (
            <div className="p-4">
              <ProductPicker
                farmaciaId={detail.farmaciaId}
                disabled={busy}
                onPick={handlePickManual}
              />
            </div>
          )}
        </section>
      )}

      {/* Acções */}
      {detail.editable && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleFinalize}
            disabled={busy || linhas.length === 0}
            className="rounded-xl border border-cyan-500 bg-cyan-600 px-5 py-2.5 text-[13px] font-medium text-white shadow-sm hover:bg-cyan-700 disabled:opacity-50"
          >
            {busy ? "A finalizar..." : "Finalizar e enviar para fila"}
          </button>
        </div>
      )}

      {/* Timeline de exportação */}
      {detail.outbox && (
        <section className="rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-4 py-3">
            <h2 className="text-[14px] font-semibold text-slate-900">
              Timeline de exportação
            </h2>
            <p className="mt-0.5 text-[12px] text-slate-500">
              Eventos do agent SPharm — tentativas, ACK/NACK, retries, cancelamentos.
            </p>
          </div>

          {detail.timeline.length === 0 ? (
            <div className="px-4 py-8 text-center text-[12px] text-slate-400">
              Sem eventos — outbox criado mas o agent ainda não tentou exportar.
            </div>
          ) : (
            <ul className="divide-y divide-slate-50">
              {detail.timeline.map((ev) => (
                <TimelineItem key={ev.id} event={ev} />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

function TimelineItem({ event }: { event: OrderTimelineEvent }) {
  const cls = TIMELINE_STATUS_STYLE[event.status] ?? "border-slate-200 bg-slate-50 text-slate-700";
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${cls}`}>
          {event.status.toLowerCase().replace(/_/g, " ")}
        </span>
        <span className="text-[11px] text-slate-500">tentativa {event.attempt}</span>
        <span className="text-[11px] text-slate-400">·</span>
        <span className="text-[11px] text-slate-500">{fmtDateTime(event.at)}</span>
        {event.httpStatus != null && (
          <>
            <span className="text-[11px] text-slate-400">·</span>
            <span className="text-[11px] text-slate-500">HTTP {event.httpStatus}</span>
          </>
        )}
      </div>
      {event.message && (
        <div className="mt-1 text-[12px] text-slate-700">{event.message}</div>
      )}
      {event.spharmSqlError && (
        <div className="mt-1 rounded-md border border-rose-100 bg-rose-50 px-2 py-1 font-mono text-[11px] text-rose-700">
          {event.spharmSqlError}
        </div>
      )}
    </li>
  );
}
