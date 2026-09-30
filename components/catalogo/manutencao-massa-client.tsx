"use client";

/**
 * components/catalogo/manutencao-massa-client.tsx
 *
 * UI da manutenção em massa do catálogo (Área A) — duas abas,
 * Fabricantes e Fornecedores, cada uma com o mesmo fluxo:
 *   filtros → selecção → destino → pré-visualização obrigatória → aplicar.
 *
 * Todas as chamadas ao servidor passam pelas server actions de
 * `app/catalogo/manutencao/actions.ts` — este componente NUNCA decide
 * sozinho o que é permitido (tenant/permissão/farmácia), só mostra o que
 * as actions devolvem e reage aos erros delas.
 */
import { useEffect, useMemo, useState, useTransition } from "react";
import {
  aplicarManutencaoFabricanteAction,
  aplicarManutencaoFornecedorAction,
  listarClassificacoesAction,
  listarFarmaciasAction,
  listarIdsCorrespondentesAction,
  listarOperacoesRecentesAction,
  listarProdutosManutencaoMassaAction,
  listarTiposArtigoAction,
  pesquisarFabricantesAction,
  pesquisarFornecedoresAction,
  previewManutencaoFabricanteAction,
  previewManutencaoFornecedorAction,
  reverterOperacaoAction,
} from "@/app/catalogo/manutencao/actions";
import type {
  DestinoInput,
  ManutencaoMassaFiltro,
  PreviewOperacaoResultado,
  TipoManutencaoMassa,
} from "@/lib/catalogo/manutencao-massa";

type Opcao = { id: string; nome: string };

const PAGE_SIZE = 50;

function useLookup<R extends { ok: boolean }>(loader: () => Promise<R>) {
  const [data, setData] = useState<R | null>(null);
  useEffect(() => {
    let vivo = true;
    loader().then((r) => {
      if (vivo) setData(r);
    });
    return () => {
      vivo = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return data;
}

/** Estado dos filtros, comum às duas abas (campos irrelevantes ao tipo ficam ignorados pela action). */
type FiltroFormState = {
  farmaciaId: string;
  cnp: string;
  designacao: string;
  classificacaoNivel1Id: string;
  classificacaoNivel2Id: string;
  tipoArtigo: string;
  fabricanteAtualId: string;
  semFabricante: boolean;
  fornecedorAtualId: string;
  semFornecedor: boolean;
  fabricanteDivergente: boolean;
  pesquisaTextual: string;
};

const FILTRO_VAZIO: FiltroFormState = {
  farmaciaId: "",
  cnp: "",
  designacao: "",
  classificacaoNivel1Id: "",
  classificacaoNivel2Id: "",
  tipoArtigo: "",
  fabricanteAtualId: "",
  semFabricante: false,
  fornecedorAtualId: "",
  semFornecedor: false,
  fabricanteDivergente: false,
  pesquisaTextual: "",
};

function paraFiltro(tipo: TipoManutencaoMassa, f: FiltroFormState): ManutencaoMassaFiltro {
  return {
    farmaciaId: tipo === "FORNECEDOR" ? (f.farmaciaId || null) : null,
    cnp: f.cnp.trim() ? Number(f.cnp.trim()) : null,
    designacao: f.designacao.trim() || null,
    classificacaoNivel1Id: f.classificacaoNivel1Id || null,
    classificacaoNivel2Id: f.classificacaoNivel2Id || null,
    tipoArtigo: f.tipoArtigo || null,
    fabricanteAtualId: tipo === "FABRICANTE" ? (f.fabricanteAtualId || null) : null,
    semFabricante: tipo === "FABRICANTE" ? f.semFabricante : false,
    fornecedorAtualId: tipo === "FORNECEDOR" ? (f.fornecedorAtualId || null) : null,
    semFornecedor: tipo === "FORNECEDOR" ? f.semFornecedor : false,
    fabricanteDivergente: tipo === "FABRICANTE" ? f.fabricanteDivergente : false,
    pesquisaTextual: f.pesquisaTextual.trim() || null,
  };
}

function resumoFiltroLegivel(tipo: TipoManutencaoMassa, f: FiltroFormState, farmaciaNome?: string | null): string[] {
  const partes: string[] = [];
  if (tipo === "FORNECEDOR") partes.push(`Farmácia: ${farmaciaNome ?? "—"}`);
  if (f.cnp.trim()) partes.push(`CNP: ${f.cnp.trim()}`);
  if (f.designacao.trim()) partes.push(`Designação contém "${f.designacao.trim()}"`);
  if (f.tipoArtigo) partes.push(`Tipo de artigo: ${f.tipoArtigo}`);
  if (f.semFabricante) partes.push("Sem fabricante");
  if (f.fabricanteAtualId) partes.push("Fabricante actual definido");
  if (f.semFornecedor) partes.push("Sem fornecedor");
  if (f.fornecedorAtualId) partes.push("Fornecedor actual definido");
  if (f.fabricanteDivergente) partes.push("Fabricante divergente entre farmácias");
  if (f.pesquisaTextual.trim()) partes.push(`Pesquisa: "${f.pesquisaTextual.trim()}"`);
  if (partes.length === (tipo === "FORNECEDOR" ? 1 : 0)) partes.push("Sem filtros adicionais — todo o catálogo");
  return partes;
}

type LinhaGrid = { produtoId: string; cnp: number; designacao: string; valorAtualId: string | null; valorAtualNome: string | null };

function DestinoPicker({
  tipo,
  onChange,
}: {
  tipo: TipoManutencaoMassa;
  onChange: (destino: DestinoInput | null) => void;
}) {
  const [texto, setTexto] = useState("");
  const [resultados, setResultados] = useState<Opcao[]>([]);
  const [selecionado, setSelecionado] = useState<Opcao | null>(null);
  const [confirmarCriacao, setConfirmarCriacao] = useState(false);

  useEffect(() => {
    if (selecionado) return;
    const texto2 = texto.trim();
    if (texto2.length < 2) {
      setResultados([]);
      return;
    }
    let vivo = true;
    const timer = setTimeout(() => {
      const acao = tipo === "FABRICANTE" ? pesquisarFabricantesAction : pesquisarFornecedoresAction;
      acao(texto2).then((r) => {
        if (vivo && r.ok) setResultados(r.resultados);
      });
    }, 250);
    return () => {
      vivo = false;
      clearTimeout(timer);
    };
  }, [texto, tipo, selecionado]);

  useEffect(() => {
    if (selecionado) {
      onChange({ modo: "existente", id: selecionado.id });
    } else if (confirmarCriacao && texto.trim().length >= 2) {
      onChange({ modo: "novo", nome: texto.trim() });
    } else {
      onChange(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selecionado, confirmarCriacao, texto]);

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-slate-700">
        Novo {tipo === "FABRICANTE" ? "fabricante" : "fornecedor"}
      </label>
      <input
        type="text"
        className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
        placeholder={`Pesquisar ${tipo === "FABRICANTE" ? "fabricante" : "fornecedor"} existente…`}
        value={selecionado ? selecionado.nome : texto}
        onChange={(e) => {
          setSelecionado(null);
          setConfirmarCriacao(false);
          setTexto(e.target.value);
        }}
      />
      {!selecionado && resultados.length > 0 && (
        <ul className="max-h-40 overflow-auto rounded border border-slate-200 text-sm">
          {resultados.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                className="block w-full px-3 py-1.5 text-left hover:bg-slate-50"
                onClick={() => setSelecionado(r)}
              >
                {r.nome}
              </button>
            </li>
          ))}
        </ul>
      )}
      {!selecionado && texto.trim().length >= 2 && resultados.length === 0 && (
        <div className="rounded border border-amber-200 bg-amber-50 p-2 text-sm text-amber-800">
          <p>
            Não existe nenhum {tipo === "FABRICANTE" ? "fabricante" : "fornecedor"} com este nome. Pode ser criado
            um novo — confirme abaixo.
          </p>
          <label className="mt-1 flex items-center gap-2">
            <input type="checkbox" checked={confirmarCriacao} onChange={(e) => setConfirmarCriacao(e.target.checked)} />
            <span>
              Criar novo {tipo === "FABRICANTE" ? "fabricante" : "fornecedor"} &ldquo;{texto.trim()}&rdquo;
            </span>
          </label>
        </div>
      )}
      {selecionado && (
        <button type="button" className="text-xs text-slate-500 underline" onClick={() => setSelecionado(null)}>
          Escolher outro
        </button>
      )}
    </div>
  );
}

function PreviewPanel({
  preview,
  onConfirmar,
  onCancelar,
  aplicando,
}: {
  preview: PreviewOperacaoResultado & { ok: true };
  onConfirmar: () => void;
  onCancelar: () => void;
  aplicando: boolean;
}) {
  const destino = preview.destino;
  const destinoNome =
    destino.status === "existente"
      ? destino.nome
      : destino.status === "novo"
        ? `${destino.nomeCanonico} (novo — será criado)`
        : "—";
  return (
    <div className="space-y-4 rounded border border-slate-300 bg-slate-50 p-4">
      <h3 className="text-base font-semibold text-slate-900">Confirmação obrigatória</h3>
      <dl className="grid grid-cols-2 gap-2 text-sm">
        <dt className="text-slate-500">Total de produtos correspondentes</dt>
        <dd className="font-medium">{preview.totalCount}</dd>
        <dt className="text-slate-500">Já no destino (sem alteração)</dt>
        <dd className="font-medium">{preview.jaNoDestinoCount}</dd>
        <dt className="text-slate-500">Vão ser alterados</dt>
        <dd className="font-semibold text-emerald-700">{preview.iraAlterarCount}</dd>
        <dt className="text-slate-500">Destino</dt>
        <dd className="font-medium">{destinoNome}</dd>
      </dl>
      <div>
        <p className="mb-1 text-sm font-medium text-slate-700">Valores anteriores agrupados</p>
        <ul className="max-h-40 space-y-1 overflow-auto text-sm">
          {preview.agrupadoPorValorAnterior.map((g) => (
            <li key={g.valorAnteriorId ?? "__nulo__"} className="flex justify-between">
              <span>{g.valorAnteriorNome ?? "(sem valor)"}</span>
              <span className="font-medium">{g.count}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex gap-3">
        <button
          type="button"
          disabled={aplicando || preview.iraAlterarCount === 0}
          onClick={onConfirmar}
          className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {aplicando ? "A aplicar…" : `Confirmar e aplicar a ${preview.iraAlterarCount} produto(s)`}
        </button>
        <button type="button" onClick={onCancelar} className="rounded border border-slate-300 px-4 py-2 text-sm">
          Cancelar
        </button>
      </div>
    </div>
  );
}

function AbaManutencao({ tipo }: { tipo: TipoManutencaoMassa }) {
  const [filtro, setFiltro] = useState<FiltroFormState>(FILTRO_VAZIO);
  const [pagina, setPagina] = useState(1);
  const [linhas, setLinhas] = useState<LinhaGrid[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const [modoSelecao, setModoSelecao] = useState<"manual" | "todos">("manual");
  const [selecionados, setSelecionados] = useState<Set<string>>(new Set());
  const [excluidos, setExcluidos] = useState<Set<string>>(new Set());
  const [totalTodos, setTotalTodos] = useState(0);

  const [destino, setDestino] = useState<DestinoInput | null>(null);
  const [preview, setPreview] = useState<(PreviewOperacaoResultado & { ok: true }) | null>(null);
  const [aplicando, startAplicar] = useTransition();
  const [mensagemFinal, setMensagemFinal] = useState<string | null>(null);

  const farmaciasResult = useLookup(listarFarmaciasAction);
  const farmaciaOpcoes = farmaciasResult?.ok ? farmaciasResult.farmacias : [];
  const classificacoesN1Result = useLookup(() => listarClassificacoesAction(null));
  const classificacoesN1 = classificacoesN1Result?.ok ? classificacoesN1Result.classificacoes : [];
  const [classificacoesN2, setClassificacoesN2] = useState<Opcao[]>([]);
  const tiposArtigoResult = useLookup(listarTiposArtigoAction);
  const tiposArtigoOpcoes = tiposArtigoResult?.ok ? tiposArtigoResult.tipos : [];

  useEffect(() => {
    if (!filtro.classificacaoNivel1Id) {
      setClassificacoesN2([]);
      return;
    }
    listarClassificacoesAction(filtro.classificacaoNivel1Id).then((r) => {
      if (r.ok) setClassificacoesN2(r.classificacoes);
    });
  }, [filtro.classificacaoNivel1Id]);

  const filtroResolvido = useMemo(() => paraFiltro(tipo, filtro), [tipo, filtro]);
  const farmaciaObrigatoriaEmFalta = tipo === "FORNECEDOR" && !filtro.farmaciaId;

  const carregarPagina = (p: number) => {
    if (farmaciaObrigatoriaEmFalta) return;
    setCarregando(true);
    setErro(null);
    listarProdutosManutencaoMassaAction({ tipo, filtro: filtroResolvido, page: p, pageSize: PAGE_SIZE }).then((r) => {
      setCarregando(false);
      if (!r.ok) {
        setErro(r.error);
        return;
      }
      setLinhas(r.items);
      setTotalCount(r.totalCount);
      setPagina(p);
    });
  };

  useEffect(() => {
    setModoSelecao("manual");
    setSelecionados(new Set());
    setExcluidos(new Set());
    setPreview(null);
    setMensagemFinal(null);
    carregarPagina(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(filtroResolvido)]);

  const contagemSelecionada = modoSelecao === "todos" ? totalTodos - excluidos.size : selecionados.size;

  function alternarLinha(id: string) {
    if (modoSelecao === "todos") {
      setExcluidos((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      return;
    }
    setSelecionados((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selecionarTodaPagina() {
    setSelecionados((prev) => {
      const next = new Set(prev);
      for (const l of linhas) next.add(l.produtoId);
      return next;
    });
  }

  function selecionarTodosOsQueCorrespondem() {
    listarIdsCorrespondentesAction({ tipo, filtro: filtroResolvido }).then((r) => {
      if (!r.ok) {
        setErro(r.error);
        return;
      }
      setModoSelecao("todos");
      setTotalTodos(r.total);
      setExcluidos(new Set());
    });
  }

  function limparSelecao() {
    setModoSelecao("manual");
    setSelecionados(new Set());
    setExcluidos(new Set());
  }

  async function pedirPreview() {
    if (!destino) return;
    setErro(null);
    const acao = tipo === "FABRICANTE" ? previewManutencaoFabricanteAction : previewManutencaoFornecedorAction;
    const r = await acao({ filtro: filtroResolvido, destino });
    if (!r.ok) {
      setErro(r.error);
      return;
    }
    setPreview(r);
  }

  async function confirmarAplicacao() {
    if (!destino) return;
    startAplicar(async () => {
      let subconjunto: string[] | undefined;
      if (modoSelecao === "manual") {
        subconjunto = Array.from(selecionados);
      } else if (excluidos.size > 0) {
        const idsRes = await listarIdsCorrespondentesAction({ tipo, filtro: filtroResolvido });
        subconjunto = idsRes.ok ? idsRes.ids.filter((id) => !excluidos.has(id)) : undefined;
      }
      const acao = tipo === "FABRICANTE" ? aplicarManutencaoFabricanteAction : aplicarManutencaoFornecedorAction;
      const r = await acao({ filtro: filtroResolvido, destino, produtoIdsSubconjunto: subconjunto });
      if (!r.ok) {
        setErro(r.error);
        return;
      }
      setMensagemFinal(
        `Operação aplicada: ${r.quantidadeAlterada} alterado(s), ${r.quantidadeIgnorada} já estavam no destino.`
      );
      setPreview(null);
      setDestino(null);
      limparSelecao();
      carregarPagina(1);
    });
  }

  const farmaciaNomeSelecionada = farmaciaOpcoes.find((f) => f.id === filtro.farmaciaId)?.nome ?? null;

  return (
    <div className="space-y-6">
      <section className="grid grid-cols-1 gap-3 rounded border border-slate-200 p-4 sm:grid-cols-3">
        {tipo === "FORNECEDOR" && (
          <div>
            <label className="block text-sm font-medium text-slate-700">Farmácia *</label>
            <select
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
              value={filtro.farmaciaId}
              onChange={(e) => setFiltro((f) => ({ ...f, farmaciaId: e.target.value }))}
            >
              <option value="">Seleccione…</option>
              {farmaciaOpcoes.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.nome}
                </option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label className="block text-sm font-medium text-slate-700">CNP</label>
          <input
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            value={filtro.cnp}
            onChange={(e) => setFiltro((f) => ({ ...f, cnp: e.target.value }))}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700">Designação contém</label>
          <input
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            value={filtro.designacao}
            onChange={(e) => setFiltro((f) => ({ ...f, designacao: e.target.value }))}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700">Categoria</label>
          <select
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            value={filtro.classificacaoNivel1Id}
            onChange={(e) => setFiltro((f) => ({ ...f, classificacaoNivel1Id: e.target.value, classificacaoNivel2Id: "" }))}
          >
            <option value="">Todas</option>
            {classificacoesN1.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nome}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700">Subcategoria</label>
          <select
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            value={filtro.classificacaoNivel2Id}
            disabled={!filtro.classificacaoNivel1Id}
            onChange={(e) => setFiltro((f) => ({ ...f, classificacaoNivel2Id: e.target.value }))}
          >
            <option value="">Todas</option>
            {classificacoesN2.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nome}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700">Tipo de artigo</label>
          <select
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            value={filtro.tipoArtigo}
            onChange={(e) => setFiltro((f) => ({ ...f, tipoArtigo: e.target.value }))}
          >
            <option value="">Todos</option>
            {tiposArtigoOpcoes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        {tipo === "FABRICANTE" ? (
          <>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={filtro.semFabricante}
                onChange={(e) => setFiltro((f) => ({ ...f, semFabricante: e.target.checked, fabricanteAtualId: "" }))}
              />
              Sem fabricante
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={filtro.fabricanteDivergente}
                onChange={(e) => setFiltro((f) => ({ ...f, fabricanteDivergente: e.target.checked }))}
              />
              Fabricante divergente entre farmácias
            </label>
          </>
        ) : (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={filtro.semFornecedor}
              onChange={(e) => setFiltro((f) => ({ ...f, semFornecedor: e.target.checked, fornecedorAtualId: "" }))}
            />
            Sem fornecedor
          </label>
        )}
        <div className="sm:col-span-3">
          <label className="block text-sm font-medium text-slate-700">Pesquisa textual (designação/CNP)</label>
          <input
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            value={filtro.pesquisaTextual}
            onChange={(e) => setFiltro((f) => ({ ...f, pesquisaTextual: e.target.value }))}
          />
        </div>
      </section>

      {farmaciaObrigatoriaEmFalta ? (
        <p className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          Seleccione uma farmácia para pesquisar produtos.
        </p>
      ) : (
        <>
          <section className="rounded border border-slate-200">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2 text-sm">
              <span>
                {totalCount} produto(s) correspondem ao filtro. Seleccionados:{" "}
                <strong>{contagemSelecionada}</strong>
              </span>
              <div className="flex gap-2">
                <button type="button" className="underline" onClick={selecionarTodaPagina}>
                  Seleccionar página
                </button>
                <button type="button" className="underline" onClick={selecionarTodosOsQueCorrespondem}>
                  Seleccionar todos os {totalCount} que correspondem ao filtro
                </button>
                <button type="button" className="underline" onClick={limparSelecao}>
                  Limpar selecção
                </button>
              </div>
            </div>
            {carregando ? (
              <p className="p-4 text-sm text-slate-500">A carregar…</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-slate-500">
                    <th className="w-8 p-2"></th>
                    <th className="p-2">CNP</th>
                    <th className="p-2">Designação</th>
                    <th className="p-2">Valor actual</th>
                  </tr>
                </thead>
                <tbody>
                  {linhas.map((l) => {
                    const marcado = modoSelecao === "todos" ? !excluidos.has(l.produtoId) : selecionados.has(l.produtoId);
                    return (
                      <tr key={l.produtoId} className="border-b border-slate-100">
                        <td className="p-2">
                          <input type="checkbox" checked={marcado} onChange={() => alternarLinha(l.produtoId)} />
                        </td>
                        <td className="p-2">{l.cnp}</td>
                        <td className="p-2">{l.designacao}</td>
                        <td className="p-2">{l.valorAtualNome ?? "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <div className="flex items-center justify-between border-t border-slate-200 px-3 py-2 text-sm">
              <button
                type="button"
                disabled={pagina <= 1}
                onClick={() => carregarPagina(pagina - 1)}
                className="disabled:opacity-40"
              >
                ← Anterior
              </button>
              <span>Página {pagina}</span>
              <button
                type="button"
                disabled={pagina * PAGE_SIZE >= totalCount}
                onClick={() => carregarPagina(pagina + 1)}
                className="disabled:opacity-40"
              >
                Seguinte →
              </button>
            </div>
          </section>

          {erro && <p className="rounded border border-rose-300 bg-rose-50 p-3 text-sm text-rose-800">{erro}</p>}
          {mensagemFinal && (
            <p className="rounded border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800">{mensagemFinal}</p>
          )}

          <section className="space-y-3 rounded border border-slate-200 p-4">
            <DestinoPicker tipo={tipo} onChange={setDestino} />
            <div className="text-xs text-slate-500">
              Filtros aplicados: {resumoFiltroLegivel(tipo, filtro, farmaciaNomeSelecionada).join(" · ")}
            </div>
            <button
              type="button"
              disabled={!destino || contagemSelecionada === 0}
              onClick={pedirPreview}
              className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              Pré-visualizar alteração
            </button>
          </section>

          {preview && (
            <PreviewPanel preview={preview} onConfirmar={confirmarAplicacao} onCancelar={() => setPreview(null)} aplicando={aplicando} />
          )}
        </>
      )}
    </div>
  );
}

type ListarOperacoesResultado = Awaited<ReturnType<typeof listarOperacoesRecentesAction>>;
type OperacaoHistorico = Extract<ListarOperacoesResultado, { ok: true }>["operacoes"][number];

function HistoricoOperacoes() {
  const [operacoes, setOperacoes] = useState<OperacaoHistorico[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [aRever, setARever] = useState<string | null>(null);

  function carregar() {
    listarOperacoesRecentesAction({ page: 1, pageSize: 25 }).then((r) => {
      if (r.ok) setOperacoes(r.operacoes);
      else setErro(r.error);
    });
  }

  useEffect(() => {
    carregar();
  }, []);

  async function reverter(id: string) {
    setARever(id);
    const r = await reverterOperacaoAction({ operacaoId: id });
    setARever(null);
    if (!r.ok) {
      setErro(r.error);
      return;
    }
    carregar();
  }

  return (
    <section className="space-y-2 rounded border border-slate-200 p-4">
      <h3 className="text-base font-semibold text-slate-900">Histórico de operações</h3>
      {erro && <p className="rounded border border-rose-300 bg-rose-50 p-2 text-sm text-rose-800">{erro}</p>}
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-slate-500">
            <th className="p-2">Data</th>
            <th className="p-2">Tipo</th>
            <th className="p-2">Utilizador</th>
            <th className="p-2">Farmácia</th>
            <th className="p-2">Alterados / Ignorados</th>
            <th className="p-2">Origem</th>
            <th className="p-2"></th>
          </tr>
        </thead>
        <tbody>
          {operacoes.map((op) => (
            <tr key={op.id} className="border-b border-slate-100">
              <td className="p-2">{new Date(op.dataCriacao).toLocaleString("pt-PT")}</td>
              <td className="p-2">{op.tipo}</td>
              <td className="p-2">{op.utilizadorNome}</td>
              <td className="p-2">{op.farmaciaNome ?? "—"}</td>
              <td className="p-2">
                {op.quantidadeAlterada} / {op.quantidadeIgnorada}
              </td>
              <td className="p-2">{op.origem}</td>
              <td className="p-2">
                {op.origem === "MANUTENCAO_MASSA" && !op.jaTemReversao && (
                  <button
                    type="button"
                    disabled={aRever === op.id}
                    onClick={() => reverter(op.id)}
                    className="text-xs text-rose-700 underline disabled:opacity-40"
                  >
                    {aRever === op.id ? "A reverter…" : "Reverter"}
                  </button>
                )}
                {op.jaTemReversao && <span className="text-xs text-slate-400">Já revertida</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function ManutencaoMassaClient() {
  const [aba, setAba] = useState<TipoManutencaoMassa>("FABRICANTE");

  return (
    <div className="space-y-6">
      <div className="flex gap-2 border-b border-slate-200">
        {(["FABRICANTE", "FORNECEDOR"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setAba(t)}
            className={`px-4 py-2 text-sm font-medium ${
              aba === t ? "border-b-2 border-slate-900 text-slate-900" : "text-slate-500"
            }`}
          >
            {t === "FABRICANTE" ? "Fabricantes" : "Fornecedores"}
          </button>
        ))}
      </div>

      <AbaManutencao key={aba} tipo={aba} />

      <HistoricoOperacoes />
    </div>
  );
}
