"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, FileText, Trash2 } from "lucide-react";
import { deleteTransferenciaAction } from "@/app/transferencias/actions";
import type { TransferenciaRegistadaRow } from "@/lib/transferencias/registadas-data";
import { DocumentosModal } from "@/components/reporting/documentos-modal";

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

  // Reimprimir/PDF/Email de transferências já FINALIZADAS — leitura pura
  // (ver DocumentosModal); RASCUNHO fica de fora (nunca foi "finalizada").
  const [selecionadas, setSelecionadas] = useState<Set<string>>(new Set());
  const [documentosParaIds, setDocumentosParaIds] = useState<string[] | null>(null);
  const reimprimivel = (t: TransferenciaRegistadaRow) => t.estado === "FINALIZADA";
  const idsReimprimiveis = rows.filter(reimprimivel).map((t) => t.id);
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
            <>
              {selecionadas.size > 0 && (
                <div className="mb-2 flex items-center justify-between rounded-lg border border-cyan-200 bg-cyan-50 px-3 py-2 text-[12px] text-cyan-900">
                  <span>
                    {selecionadas.size} transferência{selecionadas.size === 1 ? "" : "s"} seleccionada
                    {selecionadas.size === 1 ? "" : "s"}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setDocumentosParaIds([...selecionadas])}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500 bg-cyan-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-cyan-700"
                    >
                      <FileText className="h-3.5 w-3.5" />
                      Imprimir · PDF · Email
                    </button>
                    <button type="button" onClick={() => setSelecionadas(new Set())} className="text-[11px] text-cyan-700 hover:text-cyan-900">
                      Limpar
                    </button>
                  </div>
                </div>
              )}
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-[12px]">
                <thead className="text-[10px] uppercase tracking-wider text-slate-400">
                  <tr>
                    <th className="px-3 py-2">
                      {idsReimprimiveis.length > 0 && (
                        <input
                          type="checkbox"
                          checked={idsReimprimiveis.every((id) => selecionadas.has(id))}
                          onChange={toggleTodas}
                          title="Seleccionar todas as transferências finalizadas"
                        />
                      )}
                    </th>
                    <th className="px-3 py-2">Origem</th>
                    <th className="px-3 py-2">Destino</th>
                    <th className="px-3 py-2 text-center">Linhas</th>
                    <th className="px-3 py-2">Estado</th>
                    <th className="px-3 py-2">Criado por</th>
                    <th className="px-3 py-2">Data</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((t) => (
                    <tr key={t.id}>
                      <td className="px-3 py-2">
                        {reimprimivel(t) && (
                          <input type="checkbox" checked={selecionadas.has(t.id)} onChange={() => toggleSelecionada(t.id)} />
                        )}
                      </td>
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
                      <td className="px-3 py-2 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {reimprimivel(t) && (
                            <button
                              type="button"
                              onClick={() => setDocumentosParaIds([t.id])}
                              title="Imprimir / PDF / Email"
                              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-600 hover:border-cyan-300 hover:bg-cyan-50 hover:text-cyan-700"
                            >
                              <FileText className="h-3 w-3" />
                              Documentos
                            </button>
                          )}
                          {podeEliminar && (
                            <button
                              type="button"
                              onClick={() => handleDelete(t)}
                              disabled={busyId === t.id}
                              title="Eliminar transferência"
                              className="rounded-md border border-slate-200 p-1.5 text-slate-500 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
          )}
        </div>
      )}

      {documentosParaIds && (
        <DocumentosModal
          titulo={documentosParaIds.length === 1 ? "Documentos da transferência" : "Documentos das transferências seleccionadas"}
          transferenciaIds={documentosParaIds}
          onClose={() => setDocumentosParaIds(null)}
        />
      )}
    </section>
  );
}
