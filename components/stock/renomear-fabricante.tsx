"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Pencil } from "lucide-react";
import {
  aplicarRenomearFabricanteAction,
  previsualizarRenomearFabricanteAction,
} from "@/app/stock/artigo/renomear-fabricante-actions";
import type { PreviewEdicaoFabricante } from "@/lib/catalogo/fabricante-renomear";

type Fase =
  | { fase: "fechado" }
  | { fase: "editar" }
  | { fase: "confirmar"; preview: Extract<PreviewEdicaoFabricante, { ok: true }> };

/**
 * «Editar nome do fabricante» — só é renderizado pela página quando o
 * utilizador tem `catalog.write` e o tenant está na lista (a server action
 * volta a verificar ambos). O botão só abre o diálogo; nada é gravado antes
 * da confirmação explícita, e «Cancelar» fecha sem tocar em nada.
 */
export function RenomearFabricante({ cnp, nomeAtual }: { cnp: number; nomeAtual: string }) {
  const router = useRouter();
  const [estado, setEstado] = useState<Fase>({ fase: "fechado" });
  const [novoNome, setNovoNome] = useState(nomeAtual);
  const [erro, setErro] = useState<string | null>(null);
  const [sucesso, setSucesso] = useState<string | null>(null);
  const [aGravar, startTransition] = useTransition();

  function abrir() {
    setNovoNome(nomeAtual);
    setErro(null);
    setSucesso(null);
    setEstado({ fase: "editar" });
  }

  function fechar() {
    setEstado({ fase: "fechado" });
    setErro(null);
  }

  function continuar() {
    setErro(null);
    startTransition(async () => {
      const preview = await previsualizarRenomearFabricanteAction(cnp, novoNome);
      if (!preview.ok) return setErro(preview.erro);
      const av = preview.avaliacao;
      if (av.estado === "invalido") return setErro(av.motivo);
      if (av.estado === "igual") {
        return setErro("O novo nome é igual ao atual (ignorando espaços e maiúsculas/minúsculas).");
      }
      setEstado({ fase: "confirmar", preview });
    });
  }

  function confirmar(preview: Extract<PreviewEdicaoFabricante, { ok: true }>) {
    setErro(null);
    const consolidar = preview.avaliacao.estado === "conflito";
    startTransition(async () => {
      const r = await aplicarRenomearFabricanteAction({
        cnp,
        novoNome,
        modo: consolidar ? "CONSOLIDACAO" : "RENOMEACAO",
        artigosConfirmados: preview.artigosAfetados,
      });
      if (!r.ok) {
        setErro(r.erro);
        // Pedido desatualizado → volta ao passo de edição para reconfirmar.
        if (r.codigo === "DESATUALIZADO") setEstado({ fase: "editar" });
        return;
      }
      setSucesso(
        r.modo === "CONSOLIDACAO"
          ? `Consolidado: ${r.artigosAfetados} artigos passaram para «${r.nomeNovo}».`
          : `Nome do fabricante alterado para «${r.nomeNovo}» em ${r.artigosAfetados} artigos.`,
      );
      setEstado({ fase: "fechado" });
      router.refresh();
    });
  }

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={abrir}
        data-testid="editar-fabricante-abrir"
        className="inline-flex items-center gap-1 text-[11px] font-medium text-cyan-700 hover:underline"
      >
        <Pencil className="h-3 w-3" />
        Editar nome do fabricante
      </button>

      {sucesso && (
        <p role="status" data-testid="editar-fabricante-sucesso" className="mt-1 text-[11px] text-emerald-700">
          {sucesso}
        </p>
      )}

      {estado.fase !== "fechado" && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Editar nome do fabricante"
          data-testid="editar-fabricante-dialogo"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
        >
          <div className="w-full max-w-md rounded-[16px] border border-white/70 bg-white p-5 shadow-xl">
            <h2 className="text-[15px] font-semibold text-slate-900">Editar nome do fabricante</h2>

            {estado.fase === "editar" && (
              <div className="mt-3 space-y-3">
                <div className="text-[12px] text-slate-500">
                  Nome atual: <span className="font-medium text-slate-800">{nomeAtual}</span>
                </div>
                <label className="block text-[12px] font-medium text-slate-700">
                  Novo nome
                  <input
                    type="text"
                    value={novoNome}
                    onChange={(e) => setNovoNome(e.target.value)}
                    data-testid="editar-fabricante-input"
                    maxLength={300}
                    autoFocus
                    className="mt-1 w-full rounded-[10px] border border-slate-200 px-3 py-2 text-[13px] text-slate-900"
                  />
                </label>
              </div>
            )}

            {estado.fase === "confirmar" && <Confirmacao preview={estado.preview} />}

            {erro && (
              <p role="alert" data-testid="editar-fabricante-erro" className="mt-3 text-[12px] text-rose-700">
                {erro}
              </p>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={fechar}
                disabled={aGravar}
                data-testid="editar-fabricante-cancelar"
                className="rounded-[10px] border border-slate-200 px-3 py-1.5 text-[12px] text-slate-700"
              >
                Cancelar
              </button>
              {estado.fase === "editar" && (
                <button
                  type="button"
                  onClick={continuar}
                  disabled={aGravar}
                  data-testid="editar-fabricante-continuar"
                  className="rounded-[10px] bg-cyan-700 px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-60"
                >
                  {aGravar ? "A verificar…" : "Continuar"}
                </button>
              )}
              {estado.fase === "confirmar" && (
                <button
                  type="button"
                  onClick={() => confirmar(estado.preview)}
                  disabled={aGravar}
                  data-testid="editar-fabricante-confirmar"
                  className="rounded-[10px] bg-cyan-700 px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-60"
                >
                  {aGravar
                    ? "A guardar…"
                    : estado.preview.avaliacao.estado === "conflito"
                      ? "Consolidar artigos"
                      : "Confirmar e guardar"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Confirmacao({ preview }: { preview: Extract<PreviewEdicaoFabricante, { ok: true }> }) {
  const av = preview.avaliacao;
  return (
    <div className="mt-3 space-y-2 text-[12px] text-slate-700" data-testid="editar-fabricante-confirmacao">
      <div>
        Nome atual: <span className="font-medium text-slate-900">{preview.nomeAtual}</span>
      </div>
      <div>
        Novo nome: <span className="font-medium text-slate-900">{preview.novoNome}</span>
      </div>
      <div>
        Artigos afetados: <span className="font-medium text-slate-900">{preview.artigosAfetados}</span>
      </div>
      {av.estado === "conflito" ? (
        <p className="rounded-[10px] bg-amber-50 px-3 py-2 text-amber-900" data-testid="editar-fabricante-aviso-consolidacao">
          Já existe neste tenant o fabricante «{av.destino.nome}» ({av.destino.artigos} artigos). Não será
          criado nenhum duplicado. Quer consolidar? Os {preview.artigosAfetados} artigos passam para esse
          fabricante e o atual fica inativo (nada é apagado).
        </p>
      ) : (
        <p className="rounded-[10px] bg-slate-50 px-3 py-2" data-testid="editar-fabricante-aviso">
          Esta alteração irá mudar o nome do fabricante em {preview.artigosAfetados} artigos deste tenant.
        </p>
      )}
    </div>
  );
}
