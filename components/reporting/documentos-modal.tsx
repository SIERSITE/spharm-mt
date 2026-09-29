"use client";

/**
 * components/reporting/documentos-modal.tsx
 *
 * "Reimprimir / gerar PDF / reenviar email" de encomendas e/ou
 * transferências JÁ FINALIZADAS — a partir do detalhe ou da listagem,
 * a qualquer momento depois da finalização original.
 *
 * Reutiliza 100% o que já existe para o momento da finalização (nunca
 * um pipeline novo):
 *   - `buildDocumentosFinalizacaoAction` (app/encomendas/nova/actions.ts)
 *     — a MESMA acção que o painel de resultado usa ao finalizar. É
 *     puramente de LEITURA: monta os `Report` a partir do que já está
 *     persistido, nunca cria/altera nada.
 *   - `ReportActions` — os mesmos botões Imprimir/PDF/Email (o diálogo
 *     de email já pede o destinatário a cada envio — nunca reutiliza um
 *     endereço de uma vez anterior).
 *
 * A escolha "Separada por farmácia" / "Encomenda única do Grupo" é
 * pedida de NOVO em cada utilização (nunca persistida): mostrada só
 * quando há mais de uma encomenda seleccionada — com uma só, ou só
 * transferências, não há nada para consolidar por produto e a pergunta
 * seria vazia. As transferências, quando há mais de uma, mostram sempre
 * o documento individual E o resumo consolidado lado a lado (não é uma
 * escolha exclusiva — ver `transferencia-documento.ts`).
 */
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { ReportActions } from "./report-actions";
import {
  buildDocumentosFinalizacaoAction,
  type DocumentosFinalizacaoResultado,
} from "@/app/encomendas/nova/actions";

type ResultadoOk = Extract<DocumentosFinalizacaoResultado, { ok: true }>;
type Fase =
  | { tipo: "modalidade" }
  | { tipo: "carregando" }
  | { tipo: "resultado"; dados: ResultadoOk }
  | { tipo: "erro"; mensagem: string };

export function DocumentosModal({
  titulo,
  listaEncomendaIds = [],
  transferenciaIds = [],
  onClose,
}: {
  titulo: string;
  listaEncomendaIds?: string[];
  transferenciaIds?: string[];
  onClose: () => void;
}) {
  // Só faz sentido perguntar "separada/consolidada" quando há mais de
  // uma ENCOMENDA — nunca para transferências (ver comentário do
  // ficheiro) nem para uma única encomenda (nada para agregar).
  const precisaEscolha = listaEncomendaIds.length > 1;
  const [modalidade, setModalidade] = useState<"separada" | "consolidada">("separada");
  const [fase, setFase] = useState<Fase>(precisaEscolha ? { tipo: "modalidade" } : { tipo: "carregando" });

  useEffect(() => {
    if (fase.tipo !== "carregando") return;
    let cancelado = false;
    buildDocumentosFinalizacaoAction({
      listaEncomendaIds,
      transferenciaIds,
      incluirConsolidado: modalidade === "consolidada",
    }).then((r) => {
      if (cancelado) return;
      setFase(r.ok ? { tipo: "resultado", dados: r } : { tipo: "erro", mensagem: r.error });
    });
    return () => {
      cancelado = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fase.tipo]);

  const multiplasEncomendas = listaEncomendaIds.length > 1;
  const multiplasTransferencias = transferenciaIds.length > 1;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <h3 className="text-[15px] font-semibold text-slate-900">{titulo}</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600" aria-label="Fechar">
            <X className="h-4 w-4" />
          </button>
        </div>

        {fase.tipo === "modalidade" && (
          <>
            <div className="px-5 py-4">
              <p className="mb-2 text-[12px] font-medium text-slate-700">Como pretende gerar o(s) documento(s)?</p>
              <label className="mb-1.5 flex items-start gap-2 text-[13px] text-slate-700">
                <input type="radio" className="mt-0.5" checked={modalidade === "separada"} onChange={() => setModalidade("separada")} />
                <span>
                  <span className="font-medium">Separado por farmácia</span>
                  <span className="block text-[11px] text-slate-500">Um documento por encomenda, mais uma acção para todas de uma vez.</span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-[13px] text-slate-700">
                <input type="radio" className="mt-0.5" checked={modalidade === "consolidada"} onChange={() => setModalidade("consolidada")} />
                <span>
                  <span className="font-medium">Consolidado do Grupo</span>
                  <span className="block text-[11px] text-slate-500">
                    Um único documento com as quantidades somadas por produto entre farmácias — nunca altera as
                    encomendas internas já existentes.
                  </span>
                </span>
              </label>
            </div>
            <div className="flex justify-end gap-2 rounded-b-2xl border-t border-slate-100 bg-slate-50 px-5 py-3">
              <button type="button" onClick={onClose} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-[13px] font-medium text-slate-600 hover:bg-slate-50">
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => setFase({ tipo: "carregando" })}
                className="rounded-lg border border-cyan-500 bg-cyan-600 px-4 py-2 text-[13px] font-medium text-white hover:bg-cyan-700"
              >
                Gerar documentos
              </button>
            </div>
          </>
        )}

        {fase.tipo === "carregando" && (
          <div className="px-5 py-8 text-center text-[13px] text-slate-500">A preparar os documentos…</div>
        )}

        {fase.tipo === "erro" && (
          <>
            <div className="px-5 py-4 text-[13px] text-rose-700">{fase.mensagem}</div>
            <div className="flex justify-end rounded-b-2xl border-t border-slate-100 bg-slate-50 px-5 py-3">
              <button type="button" onClick={onClose} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-[13px] font-medium text-slate-600 hover:bg-slate-50">
                Fechar
              </button>
            </div>
          </>
        )}

        {fase.tipo === "resultado" && (
          <div className="max-h-[70vh] space-y-5 overflow-y-auto px-5 py-4">
            {fase.dados.encomendaIndividual.length > 0 && (
              <div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-[13px] font-semibold text-slate-900">Encomendas</h4>
                  {/* "Encomenda única do Grupo" é só apresentação interna
                      (nunca vai ao fornecedor) — os documentos
                      profissionais por fornecedor aparecem sempre na
                      lista abaixo, um botão por fornecedor. */}
                  {fase.dados.encomendaConsolidada && (
                    <ReportActions report={fase.dados.encomendaConsolidada} hide={{ excel: true }} />
                  )}
                </div>
                <ul className="mt-2 divide-y divide-slate-100 text-[12px]">
                  {fase.dados.encomendaIndividual.map((e) => (
                    <li key={e.listaEncomendaId} className="py-1.5">
                      {multiplasEncomendas && <span className="text-slate-700">{e.farmaciaNome}</span>}
                      <div className="mt-1 space-y-1">
                        {e.reports.map((r, i) => (
                          <div key={i} className="flex items-center justify-between gap-2">
                            <span className="text-slate-500">{r.title.replace(/^Nota de Encomenda — /, "")}</span>
                            <ReportActions report={r} hide={{ excel: true }} />
                          </div>
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {fase.dados.transferenciaIndividual.length > 0 && (
              <div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-[13px] font-semibold text-slate-900">Transferências</h4>
                  {multiplasTransferencias && fase.dados.transferenciaTodas ? (
                    <ReportActions report={fase.dados.transferenciaTodas} hide={{ excel: true }} />
                  ) : (
                    <ReportActions report={fase.dados.transferenciaIndividual[0].report} hide={{ excel: true }} />
                  )}
                </div>
                {multiplasTransferencias && (
                  <ul className="mt-2 divide-y divide-slate-100 text-[12px]">
                    {fase.dados.transferenciaIndividual.map((t) => (
                      <li key={t.transferenciaId} className="flex items-center justify-between gap-2 py-1.5">
                        <span className="text-slate-700">{t.rota}</span>
                        <ReportActions report={t.report} hide={{ excel: true }} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
