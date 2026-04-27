"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import type { OrderListData } from "@/lib/encomendas/orders-data";
import { OrderExportBadge } from "@/components/integracao/order-export-badge";
import {
  finalizeOrderAction,
  simulateAckAction,
  simulateNackAction,
} from "@/app/encomendas/lista/actions";

type Props = {
  data: OrderListData;
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

const ESTADO_LABEL: Record<string, string> = {
  RASCUNHO: "Rascunho",
  FINALIZADA: "Finalizada",
  EXPORTADA: "Exportada",
};

export function OrderListClient({ data }: Props) {
  const [busy, startTransition] = useTransition();
  const [flash, setFlash] = useState<{ type: "ok" | "err"; msg: string } | null>(null);

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

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[13px] text-slate-500">
            {data.orders.length} encomenda{data.orders.length !== 1 ? "s" : ""}
          </p>
        </div>
        <Link
          href="/encomendas/nova"
          className="rounded-xl border border-cyan-500 bg-cyan-600 px-4 py-2 text-[13px] font-medium text-white shadow-sm hover:bg-cyan-700"
        >
          + Nova encomenda
        </Link>
      </div>

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

      {data.orders.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white px-6 py-12 text-center">
          <p className="text-[14px] text-slate-500">Nenhuma encomenda criada.</p>
          <Link
            href="/encomendas/nova"
            className="mt-3 inline-block text-[13px] font-medium text-cyan-600 hover:text-cyan-700"
          >
            Criar a primeira encomenda
          </Link>
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
                        {/* Finalizar rascunho */}
                        {o.estado === "RASCUNHO" && (
                          <button
                            disabled={busy}
                            onClick={() => handleFinalize(o.id)}
                            className="rounded-lg border border-cyan-300 bg-cyan-50 px-2.5 py-1 text-[11px] font-medium text-cyan-700 hover:bg-cyan-100 disabled:opacity-50"
                          >
                            Finalizar
                          </button>
                        )}

                        {/* Simulate ACK/NACK — only when outbox exists and state allows */}
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
