"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, ShieldCheck } from "lucide-react";
import {
  aplicarFabricanteFichaAction,
  permitirAtualizacaoErpAction,
  pesquisarFabricantesAction,
  prepararCriacaoFabricanteAction,
} from "@/app/stock/artigo/fabricante-actions";
import { useAlteracoesPendentes, useEstadoSeparador } from "@/lib/workspace/estado-separador";

/**
 * components/stock/editor-fabricante.tsx
 *
 * Fabricante na ficha do artigo: leitura para todos; «Editar» só para quem pode alterar o catálogo (`podeEditar`).
 * Fluxo: pesquisar fabricante existente (autocomplete) OU «Criar novo fabricante» (nome normalizado visível, duplicado bloqueado,
 * semelhantes sugeridos) → confirmar → aplicar. A alteração fica protegida contra a sincronização do ERP; «Voltar a permitir
 * atualização automática pelo ERP» retira a proteção (com confirmação).
 *
 * O formulário em curso vive no estado DO SEPARADOR (workspace): sobrevive a mudar de separador e voltar, conta como «alterações
 * pendentes» (pede confirmação ao fechar o separador) e desaparece ao fechar o separador/ficha.
 */
type Opcao = { id: string; nome: string };
type Preparacao = { canonico: string; duplicado: Opcao | null; viaAlias: Opcao | null; semelhantes: Array<Opcao & { motivo: string }> };

type Formulario = {
  aberto: boolean;
  termo: string;
  escolhido: Opcao | null;
  criar: boolean;
  novoNome: string;
  passo: "editar" | "confirmar" | "permitir-erp";
  aplicarValorErp: boolean;
};
const VAZIO: Formulario = { aberto: false, termo: "", escolhido: null, criar: false, novoNome: "", passo: "editar", aplicarValorErp: false };

export function EditorFabricante({
  cnp,
  fabricanteId,
  fabricante,
  podeEditar,
  manual,
  protegido,
  fabricanteErp,
  icone,
}: {
  cnp: number;
  fabricanteId: string | null;
  fabricante: string;
  podeEditar: boolean;
  manual: boolean;
  protegido: boolean;
  fabricanteErp: string[];
  icone: React.ReactNode;
}) {
  const router = useRouter();
  const [form, setForm] = useEstadoSeparador<Formulario>(`fabricante-editor:${cnp}`, VAZIO);
  // O que a ficha mostra depois de aplicar (a ficha em si só atualiza com o refresh do servidor).
  const [aplicado, setAplicado] = useEstadoSeparador<{ id: string | null; nome: string; manual: boolean; protegido: boolean } | null>(`fabricante-aplicado:${cnp}`, null);
  const [opcoes, setOpcoes] = useState<Opcao[]>([]);
  const [prep, setPrep] = useState<Preparacao | null>(null);
  const [mensagem, setMensagem] = useState<{ tipo: "ok" | "erro"; texto: string } | null>(null);
  const [aOcupar, setAOcupar] = useState(false);

  const atual = aplicado ?? { id: fabricanteId, nome: fabricante, manual, protegido };
  const pendente = form.aberto && (form.escolhido !== null || form.novoNome.trim() !== "" || form.passo !== "editar");
  useAlteracoesPendentes(pendente);

  // Autocomplete (debounce)
  useEffect(() => {
    if (!form.aberto || form.criar || form.termo.trim().length < 1) {
      setOpcoes([]);
      return;
    }
    let cancelado = false;
    const t = setTimeout(async () => {
      const r = await pesquisarFabricantesAction(form.termo);
      if (!cancelado && r.ok) setOpcoes(r.opcoes);
    }, 250);
    return () => {
      cancelado = true;
      clearTimeout(t);
    };
  }, [form.aberto, form.criar, form.termo]);

  // Preparar criação (normalização + duplicados + semelhantes)
  useEffect(() => {
    if (!form.aberto || !form.criar || form.novoNome.trim().length < 2) {
      setPrep(null);
      return;
    }
    let cancelado = false;
    const t = setTimeout(async () => {
      const r = await prepararCriacaoFabricanteAction(form.novoNome);
      if (cancelado) return;
      if ("autorizado" in r && r.ok) setPrep({ canonico: r.canonico, duplicado: r.duplicado, viaAlias: r.viaAlias, semelhantes: r.semelhantes });
      else setPrep(null);
    }, 300);
    return () => {
      cancelado = true;
      clearTimeout(t);
    };
  }, [form.aberto, form.criar, form.novoNome]);

  const cancelar = () => {
    setForm(VAZIO);
    setOpcoes([]);
    setPrep(null);
  };

  const existenteParaUsar = prep?.duplicado ?? prep?.viaAlias ?? null;
  const podeContinuar = form.criar ? !!prep && !existenteParaUsar : form.escolhido !== null;
  const destinoNome = form.criar ? prep?.canonico ?? form.novoNome.trim() : form.escolhido?.nome ?? "";

  async function aplicar() {
    setAOcupar(true);
    setMensagem(null);
    try {
      const r = await aplicarFabricanteFichaAction({
        cnp,
        fabricanteAnteriorId: atual.id,
        destino: form.criar ? { tipo: "novo", nome: form.novoNome } : { tipo: "existente", fabricanteId: form.escolhido!.id },
        confirmado: true,
      });
      if (r.ok) {
        setAplicado({ id: r.fabricante.id, nome: r.fabricante.nome, manual: true, protegido: true });
        setMensagem({ tipo: "ok", texto: r.criado ? `Fabricante «${r.fabricante.nome}» criado e aplicado.` : r.alterado ? `Fabricante alterado para «${r.fabricante.nome}».` : `Fabricante «${r.fabricante.nome}» fixado.` });
        setForm(VAZIO);
        router.refresh();
      } else {
        setMensagem({ tipo: "erro", texto: r.mensagem });
        if ("existente" in r && r.existente) setForm((f) => ({ ...f, criar: false, escolhido: r.existente!, passo: "editar" }));
        else setForm((f) => ({ ...f, passo: "editar" }));
      }
    } finally {
      setAOcupar(false);
    }
  }

  async function permitirErp() {
    setAOcupar(true);
    setMensagem(null);
    try {
      const r = await permitirAtualizacaoErpAction({ cnp, aplicarValorErp: form.aplicarValorErp, confirmado: true });
      if (r.ok) {
        setAplicado({ id: r.fabricante?.id ?? atual.id, nome: r.fabricante?.nome || atual.nome, manual: false, protegido: false });
        setMensagem({ tipo: "ok", texto: "O fabricante volta a poder ser atualizado pela sincronização do ERP." });
        setForm(VAZIO);
        router.refresh();
      } else {
        setMensagem({ tipo: "erro", texto: r.mensagem });
        setForm((f) => ({ ...f, passo: "permitir-erp" }));
      }
    } finally {
      setAOcupar(false);
    }
  }

  const erpDiferente = atual.protegido && fabricanteErp.length > 0 && !fabricanteErp.includes(atual.nome);

  return (
    <>
      <div className="rounded-[12px] border border-slate-100 bg-slate-50/70 px-3 py-3" data-testid="fabricante-celula">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-cyan-600">{icone}</span>
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">Fabricante</div>
          {podeEditar && !form.aberto && (
            <button
              type="button"
              data-testid="fabricante-editar"
              onClick={() => setForm({ ...VAZIO, aberto: true })}
              className="ml-auto text-[11px] font-medium text-emerald-700 underline-offset-2 hover:underline"
            >
              Editar
            </button>
          )}
        </div>
        <div className="text-[13px] font-medium text-slate-800" data-testid="fabricante-valor">{atual.nome}</div>
        {atual.manual && (
          <div className="mt-1 inline-flex items-center gap-1 text-[10px] font-medium text-emerald-700" title="Definido na ficha: a sincronização automática não o substitui">
            <ShieldCheck className="h-3 w-3" /> definido manualmente
          </div>
        )}
        {erpDiferente && <div className="mt-0.5 text-[10px] text-slate-500" data-testid="fabricante-erp">ERP: {fabricanteErp.join(" · ")}</div>}
        {mensagem && !form.aberto && (
          <div role={mensagem.tipo === "erro" ? "alert" : "status"} data-testid="fabricante-mensagem" className={`mt-1 text-[11px] ${mensagem.tipo === "erro" ? "text-rose-700" : "text-emerald-700"}`}>
            {mensagem.texto}
          </div>
        )}
      </div>

      {podeEditar && form.aberto && (
        <div className="md:col-span-5 rounded-[12px] border border-emerald-200 bg-emerald-50/40 p-3" data-testid="fabricante-editor">
          {form.passo === "editar" && (
            <div className="space-y-3">
              <div className="text-[12px] text-slate-600">
                Fabricante atual: <strong className="text-slate-900">{atual.nome}</strong>
              </div>

              {!form.criar ? (
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-slate-500">Pesquisar fabricante existente</label>
                  <input
                    data-testid="fabricante-pesquisa"
                    value={form.termo}
                    onChange={(e) => setForm((f) => ({ ...f, termo: e.target.value, escolhido: null }))}
                    placeholder="Escreva parte do nome…"
                    className="h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-[13px] outline-none focus:border-emerald-300"
                  />
                  {opcoes.length > 0 && (
                    <ul className="mt-1 max-h-44 overflow-y-auto rounded-lg border border-slate-200 bg-white text-[13px]" role="listbox">
                      {opcoes.map((o) => (
                        <li key={o.id}>
                          <button
                            type="button"
                            data-testid={`fabricante-opcao-${o.id}`}
                            onClick={() => setForm((f) => ({ ...f, escolhido: o, termo: o.nome }))}
                            className={`block w-full px-3 py-1.5 text-left hover:bg-emerald-50 ${form.escolhido?.id === o.id ? "bg-emerald-50 font-semibold" : ""}`}
                          >
                            {o.nome}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {form.escolhido && (
                    <p className="mt-1 text-[12px] text-emerald-800" data-testid="fabricante-escolhido">
                      Selecionado: <strong>{form.escolhido.nome}</strong>
                    </p>
                  )}
                  <button
                    type="button"
                    data-testid="fabricante-criar"
                    onClick={() => setForm((f) => ({ ...f, criar: true, escolhido: null, novoNome: f.termo }))}
                    className="mt-2 text-[12px] font-medium text-cyan-700 underline-offset-2 hover:underline"
                  >
                    Criar novo fabricante
                  </button>
                </div>
              ) : (
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-slate-500">Nome do novo fabricante</label>
                  <input
                    data-testid="fabricante-novo-nome"
                    value={form.novoNome}
                    onChange={(e) => setForm((f) => ({ ...f, novoNome: e.target.value }))}
                    className="h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-[13px] outline-none focus:border-cyan-300"
                  />
                  {prep && (
                    <div className="mt-2 space-y-2 text-[12px]">
                      <p>
                        Será criado como: <strong data-testid="fabricante-canonico" className="text-slate-900">{prep.canonico}</strong>
                      </p>
                      {existenteParaUsar && (
                        <div role="alert" data-testid="fabricante-duplicado" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900">
                          Já existe «{existenteParaUsar.nome}». Não é possível criar um duplicado.
                          <button
                            type="button"
                            data-testid="fabricante-usar-existente"
                            onClick={() => setForm((f) => ({ ...f, criar: false, escolhido: existenteParaUsar, termo: existenteParaUsar.nome, novoNome: "" }))}
                            className="ml-2 font-semibold underline"
                          >
                            Usar este
                          </button>
                        </div>
                      )}
                      {prep.semelhantes.length > 0 && (
                        <div data-testid="fabricante-semelhantes" className="text-slate-600">
                          Fabricantes semelhantes já existentes:
                          <ul className="mt-1 space-y-1">
                            {prep.semelhantes.map((s) => (
                              <li key={s.id}>
                                <button
                                  type="button"
                                  data-testid={`fabricante-semelhante-${s.id}`}
                                  onClick={() => setForm((f) => ({ ...f, criar: false, escolhido: { id: s.id, nome: s.nome }, termo: s.nome, novoNome: "" }))}
                                  className="rounded border border-slate-200 bg-white px-2 py-0.5 hover:bg-emerald-50"
                                >
                                  {s.nome} <span className="text-[10px] text-slate-400">({s.motivo})</span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                  <button type="button" onClick={() => setForm((f) => ({ ...f, criar: false, novoNome: "" }))} className="mt-2 text-[12px] text-slate-500 underline-offset-2 hover:underline">
                    Voltar à pesquisa
                  </button>
                </div>
              )}

              {mensagem?.tipo === "erro" && (
                <div role="alert" data-testid="fabricante-mensagem" className="text-[12px] text-rose-700">
                  {mensagem.texto}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  data-testid="fabricante-continuar"
                  disabled={!podeContinuar}
                  onClick={() => setForm((f) => ({ ...f, passo: "confirmar" }))}
                  className="rounded-lg border border-emerald-500 bg-emerald-600 px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-40"
                >
                  Continuar
                </button>
                <button type="button" data-testid="fabricante-cancelar" onClick={cancelar} className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-600">
                  Cancelar
                </button>
                {atual.manual && (
                  <button
                    type="button"
                    data-testid="fabricante-permitir-erp"
                    onClick={() => setForm((f) => ({ ...f, passo: "permitir-erp" }))}
                    className="ml-auto text-[11px] text-slate-500 underline-offset-2 hover:underline"
                  >
                    Voltar a permitir atualização automática pelo ERP
                  </button>
                )}
              </div>
            </div>
          )}

          {form.passo === "confirmar" && (
            <div className="space-y-3" data-testid="fabricante-confirmacao">
              <p className="text-[13px] text-slate-800">
                Alterar o fabricante de <strong>{atual.nome}</strong> para <strong>{destinoNome}</strong>
                {form.criar ? " (novo fabricante, será criado)" : ""}?
              </p>
              <p className="text-[12px] text-slate-600">
                A alteração fica protegida: a sincronização automática do ERP deixa de substituir o fabricante deste artigo (o valor do ERP continua a ser registado para consulta).
              </p>
              <div className="flex gap-2">
                <button type="button" data-testid="fabricante-confirmar" disabled={aOcupar} onClick={aplicar} className="rounded-lg border border-emerald-500 bg-emerald-600 px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-50">
                  {aOcupar ? "A aplicar…" : "Confirmar e aplicar"}
                </button>
                <button type="button" disabled={aOcupar} onClick={() => setForm((f) => ({ ...f, passo: "editar" }))} className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-600">
                  Voltar
                </button>
              </div>
            </div>
          )}

          {form.passo === "permitir-erp" && (
            <div className="space-y-3" data-testid="fabricante-permitir-erp-confirmacao">
              <p className="text-[13px] text-slate-800">Voltar a permitir que a sincronização automática do ERP atualize o fabricante deste artigo?</p>
              <p className="text-[12px] text-slate-600">
                O fabricante atual (<strong>{atual.nome}</strong>) NÃO muda agora, mas numa próxima sincronização pode ser substituído pelo valor do ERP. A ficha deixa de estar marcada como validada manualmente.
              </p>
              {fabricanteErp.length === 1 && (
                <label className="flex items-center gap-2 text-[12px] text-slate-700">
                  <input type="checkbox" checked={form.aplicarValorErp} onChange={(e) => setForm((f) => ({ ...f, aplicarValorErp: e.target.checked }))} />
                  Aplicar já o fabricante atual do ERP (<strong>{fabricanteErp[0]}</strong>)
                </label>
              )}
              {mensagem?.tipo === "erro" && (
                <div role="alert" className="text-[12px] text-rose-700">
                  {mensagem.texto}
                </div>
              )}
              <div className="flex gap-2">
                <button type="button" data-testid="fabricante-permitir-erp-confirmar" disabled={aOcupar} onClick={permitirErp} className="rounded-lg border border-amber-500 bg-amber-500 px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-50">
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
    </>
  );
}

export { Building2 as IconeFabricante };
