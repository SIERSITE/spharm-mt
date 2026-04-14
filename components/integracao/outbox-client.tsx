"use client";

import { useState, useTransition } from "react";
import type { OutboxTabData } from "@/lib/integracao/outbox-data";
import { retryExportAction, cancelExportAction } from "@/app/configuracoes/integracao/actions";

type Props = {
  data: OutboxTabData;
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

function Counter({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className={`rounded-[14px] border px-4 py-3 ${tone}`}>
      <div className="text-[10px] uppercase tracking-[0.14em] opacity-70">{label}</div>
      <div className="mt-1 text-[22px] font-semibold">{value}</div>
    </div>
  );
}

export function OutboxClient({ data }: Props) {
  const [tab, setTab] = useState<"outbox" | "upstream">("outbox");
  const [busy, startTransition] = useTransition();
  const [flash, setFlash] = useState<string | null>(null);

  function handleRetry(id: string) {
    startTransition(async () => {
      const r = await retryExportAction(id);
      setFlash(r.ok ? "Re-enviado para a fila." : `Erro: ${r.error}`);
    });
  }
  function handleCancel(id: string) {
    const reason = window.prompt("Motivo do cancelamento (opcional):") ?? null;
    startTransition(async () => {
      const r = await cancelExportAction(id, reason);
      setFlash(r.ok ? "Cancelado." : `Erro: ${r.error}`);
    });
  }

  const hb = data.heartbeat;

  return (
    <div className="space-y-5">
      <div className="flex gap-2 border-b border-slate-200">
        <button
          onClick={() => setTab("outbox")}
          className={`px-4 py-2 text-[13px] font-medium ${
            tab === "outbox"
              ? "border-b-2 border-cyan-600 text-cyan-700"
              : "text-slate-500 hover:text-slate-700"
          }`}
        >
          Outbox · encomendas
        </button>
        <button
          onClick={() => setTab("upstream")}
          className={`px-4 py-2 text-[13px] font-medium ${
            tab === "upstream"
              ? "border-b-2 border-cyan-600 text-cyan-700"
              : "text-slate-500 hover:text-slate-700"
          }`}
        >
          Upstream · sincronizações
        </button>
      </div>

      {flash && (
        <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[12px] text-slate-700">
          {flash}
        </div>
      )}

      {tab === "outbox" ? (
        <>
          {/* Heartbeat */}
          <section
            className={`rounded-[14px] border px-4 py-3 ${
              hb.healthy
                ? "border-emerald-200 bg-emerald-50"
                : hb.lastAt
                  ? "border-amber-200 bg-amber-50"
                  : "border-slate-200 bg-slate-50"
            }`}
          >
            <div className="text-[11px] uppercase tracking-[0.14em] text-slate-500">
              Agent de sincronização
            </div>
            <div className="mt-1 text-[14px] font-medium text-slate-900">
              {hb.lastAt === null
                ? "Sem contacto registado"
                : hb.healthy
                  ? `Visto há ${hb.minutesAgo} min`
                  : `Sem contacto há ${hb.minutesAgo} min — verificar`}
            </div>
            <div className="mt-1 text-[11px] text-slate-500">
              {hb.lastAt
                ? `${fmtDate(hb.lastAt)}${hb.ip ? ` · ${hb.ip}` : ""}${hb.version ? ` · v${hb.version}` : ""}`
                : "Aguarda o primeiro heartbeat do agent Windows."}
            </div>
          </section>

          {/* Contadores */}
          <section className="grid gap-3 md:grid-cols-5">
            <Counter label="Pendente" value={data.counters.pendente} tone="border-amber-200 bg-amber-50 text-amber-800" />
            <Counter label="Em exportação" value={data.counters.emExportacao} tone="border-cyan-200 bg-cyan-50 text-cyan-800" />
            <Counter label="Exportado" value={data.counters.exportado} tone="border-emerald-200 bg-emerald-50 text-emerald-800" />
            <Counter label="Falhado" value={data.counters.falhado} tone="border-rose-200 bg-rose-50 text-rose-800" />
            <Counter label="Cancelado" value={data.counters.cancelado} tone="border-slate-200 bg-slate-50 text-slate-700" />
          </section>

          {/* Falhados */}
          <section className="rounded-[14px] border border-slate-200 bg-white px-4 py-3">
            <h2 className="text-[14px] font-semibold text-slate-900">
              Encomendas falhadas ({data.failedRows.length})
            </h2>
            {data.failedRows.length === 0 ? (
              <p className="mt-2 text-[12px] text-slate-500">
                Sem encomendas em falha. Tudo alinhado.
              </p>
            ) : (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="border-b border-slate-100 text-left text-[10px] uppercase tracking-wider text-slate-400">
                      <th className="py-2">Lista</th>
                      <th className="py-2">Farmácia</th>
                      <th className="py-2">Tentativas</th>
                      <th className="py-2">Último erro</th>
                      <th className="py-2">Última tentativa</th>
                      <th className="py-2 text-right">Acções</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.failedRows.map((r) => (
                      <tr key={r.id} className="border-b border-slate-50">
                        <td className="py-2 font-medium text-slate-800">{r.listaNome}</td>
                        <td className="py-2 text-slate-600">{r.farmaciaNome}</td>
                        <td className="py-2 text-slate-600">{r.attemptCount}</td>
                        <td className="py-2 text-rose-600 max-w-xs truncate" title={r.lastError ?? ""}>
                          {r.lastError ?? "—"}
                        </td>
                        <td className="py-2 text-slate-500">{fmtDate(r.lastAttemptAt)}</td>
                        <td className="py-2 text-right">
                          <button
                            disabled={busy}
                            onClick={() => handleRetry(r.id)}
                            className="mr-2 rounded-md border border-cyan-300 bg-cyan-50 px-2 py-1 text-[11px] font-medium text-cyan-700 hover:bg-cyan-100 disabled:opacity-50"
                          >
                            Re-enviar
                          </button>
                          <button
                            disabled={busy}
                            onClick={() => handleCancel(r.id)}
                            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                          >
                            Cancelar
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Pendentes (visão do que está em fila) */}
          <section className="rounded-[14px] border border-slate-200 bg-white px-4 py-3">
            <h2 className="text-[14px] font-semibold text-slate-900">
              Em fila para o agent ({data.pendingRows.length})
            </h2>
            {data.pendingRows.length === 0 ? (
              <p className="mt-2 text-[12px] text-slate-500">
                Nada pendente no momento.
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-slate-50">
                {data.pendingRows.map((r) => (
                  <li key={r.id} className="flex items-center justify-between py-2 text-[12px]">
                    <span className="text-slate-700">
                      {r.listaNome}{" "}
                      <span className="text-slate-400">· {r.farmaciaNome}</span>
                    </span>
                    <span className="text-slate-500">
                      tentativas: {r.attemptCount}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : (
        <section className="rounded-[14px] border border-slate-200 bg-slate-50 px-6 py-10 text-center">
          <div className="text-[13px] font-medium text-slate-700">
            Histórico de sincronizações upstream
          </div>
          <p className="mt-2 text-[12px] text-slate-500">
            Este separador ficará activo quando o fluxo upstream
            (SPharm → SPharmMT) for ligado. O agent Windows regista
            aqui cada execução de <code>--push-upstream</code>.
          </p>
        </section>
      )}
    </div>
  );
}
