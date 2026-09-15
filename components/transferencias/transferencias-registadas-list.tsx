"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Trash2 } from "lucide-react";
import { deleteTransferenciaAction } from "@/app/transferencias/actions";
import type { TransferenciaRegistadaRow } from "@/lib/transferencias/registadas-data";

/**
 * components/transferencias/transferencias-registadas-list.tsx
 *
 * Listagem mínima das `Transferencia` REAIS (Bloco D) — origem/destino,
 * nº de linhas, estado, data de criação, criado por, e um botão
 * "Eliminar" (soft-delete, ver `deleteTransferenciaAction`). Secção
 * própria, recolhida por omissão, para não competir visualmente com o
 * relatório de sugestões que já existe no mesmo ecrã.
 */

const ESTADO_LABEL: Record<string, string> = {
  RASCUNHO: "Rascunho",
  FINALIZADA: "Finalizada",
  ELIMINADA: "Eliminada",
};

function fmtDateTime(d: Date | string): string {
  return new Date(d).toLocaleString("pt-PT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function TransferenciasRegistadasList({
  rows,
  podeEliminar,
}: {
  rows: TransferenciaRegistadaRow[];
  podeEliminar: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const [flash, setFlash] = useState<{ type: "ok" | "err"; msg: string } | null>(null);

  function handleDelete(t: TransferenciaRegistadaRow) {
    if (
      !confirm(
        `Eliminar a transferência ${t.farmaciaOrigemNome} → ${t.farmaciaDestinoNome}? A transferência deixa de aparecer nesta lista (o registo e as suas linhas não são apagados da base de dados).`
      )
    ) {
      return;
    }
    setFlash(null);
    setBusyId(t.id);
    startTransition(async () => {
      const r = await deleteTransferenciaAction(t.id);
      setBusyId(null);
      if (r.ok) {
        setFlash({ type: "ok", msg: "Transferência eliminada." });
        router.refresh();
      } else {
        setFlash({ type: "err", msg: r.error });
      }
    });
  }

  return (
    <section className="rounded-[20px] border border-white/70 bg-white/84 px-4 py-3 shadow-[0_8px_18px_rgba(15,23,42,0.04)] backdrop-blur-xl">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-left"
      >
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Transferências registadas</h2>
          <p className="mt-0.5 text-[12px] text-slate-500">
            {rows.length} transferência{rows.length === 1 ? "" : "s"} criada
            {rows.length === 1 ? "" : "s"} — decisão de grupo ou &ldquo;Criar transferência&rdquo;.
          </p>
        </div>
        <ChevronDown className={`h-4 w-4 text-slate-400 transition ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="mt-3 border-t border-slate-100 pt-3">
          {flash && (
            <div
              className={`mb-2 rounded-lg border px-3 py-2 text-[12px] ${
                flash.type === "ok"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                  : "border-rose-200 bg-rose-50 text-rose-800"
              }`}
            >
              {flash.msg}
            </div>
          )}
          {rows.length === 0 ? (
            <p className="text-[12px] text-slate-500">Nenhuma transferência registada.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-[12px]">
                <thead className="text-[10px] uppercase tracking-wider text-slate-400">
                  <tr>
                    <th className="px-3 py-2">Origem</th>
                    <th className="px-3 py-2">Destino</th>
                    <th className="px-3 py-2 text-center">Linhas</th>
                    <th className="px-3 py-2">Estado</th>
                    <th className="px-3 py-2">Criado por</th>
                    <th className="px-3 py-2">Data</th>
                    {podeEliminar && <th className="px-3 py-2" />}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((t) => (
                    <tr key={t.id}>
                      <td className="px-3 py-2 font-medium text-slate-800">
                        {t.farmaciaOrigemNome}
                      </td>
                      <td className="px-3 py-2 font-medium text-slate-800">
                        {t.farmaciaDestinoNome}
                      </td>
                      <td className="px-3 py-2 text-center">{t.nLinhas}</td>
                      <td className="px-3 py-2">
                        <span className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-600">
                          {ESTADO_LABEL[t.estado] ?? t.estado}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-slate-600">{t.criadoPorNome}</td>
                      <td className="px-3 py-2 text-slate-500">{fmtDateTime(t.dataCriacao)}</td>
                      {podeEliminar && (
                        <td className="px-3 py-2 text-right">
                          <button
                            type="button"
                            onClick={() => handleDelete(t)}
                            disabled={busyId === t.id}
                            title="Eliminar transferência"
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
        </div>
      )}
    </section>
  );
}
