"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import {
  aplicarDesignacaoFichaAction,
  permitirAtualizacaoDesignacaoAction,
  validarDesignacaoAction,
} from "@/app/stock/artigo/designacao-actions";
import { useAlteracoesPendentes, useEstadoSeparador } from "@/lib/workspace/estado-separador";

/**
 * components/stock/editor-designacao.tsx
 *
 * Designação do produto na ficha do artigo (Stock e Catálogo): leitura para todos; «Editar designação» só para quem pode alterar
 * o catálogo (`podeEditar`). Fluxo: mostrar o valor atual → editar → validar → confirmar (a designação vale para o produto COMUM,
 * em todas as farmácias do grupo) → aplicar → a ficha atualiza de imediato. A correção fica protegida contra a sincronização do
 * ERP; «Voltar a permitir atualização automática» retira SÓ a proteção da designação (com confirmação), sem alterar o nome nem a
 * proteção do fabricante.
 *
 * O formulário em curso vive no estado DO SEPARADOR (workspace): sobrevive a mudar de separador e voltar, conta como «alterações
 * pendentes» (pede confirmação ao fechar o separador) e desaparece ao fechar o separador/ficha. Sem segundo sistema de persistência.
 */
type Formulario = {
  aberto: boolean;
  texto: string;
  passo: "editar" | "confirmar" | "permitir";
};
const VAZIO: Formulario = { aberto: false, texto: "", passo: "editar" };

export function EditorDesignacao({
  cnp,
  designacao,
  manual,
  podeEditar,
  nivel = "h2",
  className = "",
}: {
  cnp: number;
  designacao: string;
  manual: boolean;
  podeEditar: boolean;
  /** Elemento do título (a ficha do Stock usa h2; a do Catálogo h1). */
  nivel?: "h1" | "h2";
  className?: string;
}) {
  const router = useRouter();
  const [form, setForm] = useEstadoSeparador<Formulario>(`designacao-editor:${cnp}`, VAZIO);
  // O que a ficha mostra depois de aplicar (a ficha em si só atualiza com o refresh do servidor).
  // `deProps` = o que a ficha mostrava ao aplicar: se a ficha já foi atualizada (ou mudou por outra via), os props mandam.
  type Aplicado = { designacao: string; manual: boolean; deProps: { designacao: string; manual: boolean } };
  const [aplicado, setAplicado] = useEstadoSeparador<Aplicado | null>(`designacao-aplicada:${cnp}`, null);
  const [mensagem, setMensagem] = useState<{ tipo: "ok" | "erro"; texto: string } | null>(null);
  const [aOcupar, setAOcupar] = useState(false);

  const atual = aplicado && aplicado.deProps.designacao === designacao && aplicado.deProps.manual === manual ? aplicado : { designacao, manual };
  const Titulo = nivel;
  const tituloClasse = nivel === "h1" ? "text-[26px] font-semibold tracking-tight text-slate-900" : "mt-1 text-[18px] font-semibold text-slate-900";
  // Pendente: formulário aberto com texto diferente do atual, ou já num passo de confirmação.
  const pendente = form.aberto && (form.passo !== "editar" || form.texto !== atual.designacao);
  useAlteracoesPendentes(pendente, "designacao");

  const cancelar = () => {
    setForm(VAZIO);
    setMensagem(null);
  };

  async function continuar() {
    setMensagem(null);
    const v = await validarDesignacaoAction(form.texto);
    if (!v.ok) {
      setMensagem({ tipo: "erro", texto: v.mensagem });
      return;
    }
    if (v.valor === atual.designacao) {
      setMensagem({ tipo: "ok", texto: "A designação é igual à atual — nada a alterar." });
      return;
    }
    setForm((f) => ({ ...f, texto: v.valor, passo: "confirmar" }));
  }

  async function aplicar() {
    setAOcupar(true);
    setMensagem(null);
    try {
      const r = await aplicarDesignacaoFichaAction({ cnp, designacaoAnterior: atual.designacao, nova: form.texto, confirmado: true });
      if (r.ok) {
        setAplicado({ designacao: r.designacao, manual: r.protegido, deProps: { designacao, manual } });
        setMensagem({ tipo: "ok", texto: r.alterado ? "Designação atualizada para todas as farmácias do grupo." : "Nada a alterar: a designação já era esta." });
        setForm(VAZIO);
        router.refresh();
      } else {
        setMensagem({ tipo: "erro", texto: r.mensagem });
        setForm((f) => ({ ...f, passo: "editar" }));
      }
    } finally {
      setAOcupar(false);
    }
  }

  async function permitir() {
    setAOcupar(true);
    setMensagem(null);
    try {
      const r = await permitirAtualizacaoDesignacaoAction({ cnp, confirmado: true });
      if (r.ok) {
        setAplicado({ designacao: r.designacao, manual: false, deProps: { designacao, manual } });
        setMensagem({ tipo: "ok", texto: "A designação volta a poder ser atualizada pela sincronização do ERP." });
        setForm(VAZIO);
        router.refresh();
      } else {
        setMensagem({ tipo: "erro", texto: r.mensagem });
        setForm((f) => ({ ...f, passo: "editar" }));
      }
    } finally {
      setAOcupar(false);
    }
  }

  return (
    <div className={className} data-testid="designacao-bloco">
      <div className="flex flex-wrap items-center gap-2">
        <Titulo className={tituloClasse} data-testid="designacao-valor">
          {atual.designacao}
        </Titulo>
        {podeEditar && !form.aberto && (
          <button
            type="button"
            data-testid="designacao-editar"
            onClick={() => setForm({ aberto: true, texto: atual.designacao, passo: "editar" })}
            className="text-[11px] font-medium text-emerald-700 underline-offset-2 hover:underline"
          >
            Editar designação
          </button>
        )}
        {atual.manual && (
          <span
            className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-700"
            title="Corrigida na ficha: a sincronização automática não a substitui"
            data-testid="designacao-manual"
          >
            <ShieldCheck className="h-3 w-3" /> corrigida manualmente
          </span>
        )}
      </div>
      {mensagem && !form.aberto && (
        <div role={mensagem.tipo === "erro" ? "alert" : "status"} data-testid="designacao-mensagem" className={`mt-1 text-[11px] ${mensagem.tipo === "erro" ? "text-rose-700" : "text-emerald-700"}`}>
          {mensagem.texto}
        </div>
      )}

      {podeEditar && form.aberto && (
        <div className="mt-2 rounded-[12px] border border-emerald-200 bg-emerald-50/40 p-3" data-testid="designacao-editor">
          {form.passo === "editar" && (
            <div className="space-y-3">
              <div className="text-[12px] text-slate-600">
                Designação atual: <strong className="text-slate-900">{atual.designacao}</strong>
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium text-slate-500" htmlFor={`designacao-${cnp}`}>
                  Nova designação
                </label>
                <input
                  id={`designacao-${cnp}`}
                  data-testid="designacao-input"
                  value={form.texto}
                  onChange={(e) => setForm((f) => ({ ...f, texto: e.target.value }))}
                  maxLength={400}
                  className="h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-[13px] outline-none focus:border-emerald-300"
                />
              </div>
              {mensagem && (
                <div role={mensagem.tipo === "erro" ? "alert" : "status"} data-testid="designacao-mensagem" className={`text-[12px] ${mensagem.tipo === "erro" ? "text-rose-700" : "text-emerald-700"}`}>
                  {mensagem.texto}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  data-testid="designacao-continuar"
                  disabled={form.texto.trim() === ""}
                  onClick={continuar}
                  className="rounded-lg border border-emerald-500 bg-emerald-600 px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-40"
                >
                  Continuar
                </button>
                <button type="button" data-testid="designacao-cancelar" onClick={cancelar} className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-600">
                  Cancelar
                </button>
                {atual.manual && (
                  <button
                    type="button"
                    data-testid="designacao-permitir"
                    onClick={() => setForm((f) => ({ ...f, passo: "permitir" }))}
                    className="ml-auto text-[11px] text-slate-500 underline-offset-2 hover:underline"
                  >
                    Voltar a permitir atualização automática
                  </button>
                )}
              </div>
            </div>
          )}

          {form.passo === "confirmar" && (
            <div className="space-y-3" data-testid="designacao-confirmacao">
              <p className="text-[13px] text-slate-800">
                Alterar a designação de <strong>{atual.designacao}</strong> para <strong>{form.texto}</strong>?
              </p>
              <p className="text-[12px] text-slate-600">
                Esta designação será utilizada no SPharm.MT para este artigo em todas as farmácias deste grupo. A correção fica protegida: a
                sincronização automática do ERP deixa de substituir a designação deste artigo.
              </p>
              <div className="flex gap-2">
                <button type="button" data-testid="designacao-confirmar" disabled={aOcupar} onClick={aplicar} className="rounded-lg border border-emerald-500 bg-emerald-600 px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-50">
                  {aOcupar ? "A aplicar…" : "Confirmar e aplicar"}
                </button>
                <button type="button" disabled={aOcupar} onClick={() => setForm((f) => ({ ...f, passo: "editar" }))} className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-600">
                  Voltar
                </button>
              </div>
            </div>
          )}

          {form.passo === "permitir" && (
            <div className="space-y-3" data-testid="designacao-permitir-confirmacao">
              <p className="text-[13px] text-slate-800">Voltar a permitir que a sincronização automática do ERP atualize a designação deste artigo?</p>
              <p className="text-[12px] text-slate-600">
                A designação atual (<strong>{atual.designacao}</strong>) NÃO muda agora, mas numa próxima sincronização pode ser substituída pela
                do ERP. Só a proteção da designação é retirada: a do fabricante e as dos outros campos mantêm-se.
              </p>
              {mensagem?.tipo === "erro" && (
                <div role="alert" className="text-[12px] text-rose-700">
                  {mensagem.texto}
                </div>
              )}
              <div className="flex gap-2">
                <button type="button" data-testid="designacao-permitir-confirmar" disabled={aOcupar} onClick={permitir} className="rounded-lg border border-amber-500 bg-amber-500 px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-50">
                  {aOcupar ? "A aplicar…" : "Confirmar"}
                </button>
                <button type="button" disabled={aOcupar} onClick={() => setForm((f) => ({ ...f, passo: "editar" }))} className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-600">
                  Voltar
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
