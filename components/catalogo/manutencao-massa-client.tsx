"use client";

/**
 * components/catalogo/manutencao-massa-client.tsx
 *
 * UI da manutenção em massa do catálogo (Área A, tenant silveira) — duas abas,
 * Fabricantes e Fornecedores habituais, com o mesmo fluxo:
 *   filtros → selecção → destino → pré-visualização obrigatória → aplicar.
 *
 * ── Filtros = os de Vendas ──────────────────────────────────────────────
 * A barra e o painel de filtros são os MESMOS componentes de Vendas
 * (`components/reporting/vendas-filtros.tsx` + `filter-panel.tsx`): mesma
 * pesquisa, mesmas multi-selecções, mesmos chips, mesmo «limpar», mesmas
 * opções (`getReportingFilterOptions`, carregadas no servidor pela página).
 * Esta UI só acrescenta o que Vendas não tem: valor ATUAL (fabricante /
 * fornecedor habitual, por ID) e o valor de DESTINO (controlo separado).
 *
 * Todas as chamadas ao servidor passam pelas server actions de
 * `app/catalogo/manutencao/actions.ts` — este componente NUNCA decide sozinho
 * o que é permitido (tenant/permissão/farmácia), só mostra o que as actions
 * devolvem e reage aos erros delas.
 */
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  aplicarManutencaoFabricanteAction,
  aplicarManutencaoFornecedorAction,
  listarOperacoesRecentesAction,
  listarProdutosManutencaoMassaAction,
  pesquisarFabricantesAction,
  pesquisarFornecedoresAction,
  previewManutencaoFabricanteAction,
  previewManutencaoFornecedorAction,
  reverterOperacaoAction,
} from "@/app/catalogo/manutencao/actions";
import type { PreviewOperacaoResultado, ItemManutencaoMassa } from "@/lib/catalogo/manutencao-massa";
import {
  DEFAULTS_MOVIMENTO,
  type DestinoInput,
  type ManutencaoMassaFiltro,
  type SelecaoManutencao,
  type TipoManutencaoMassa,
} from "@/lib/catalogo/manutencao-massa-filtro";
import type { ReportingFilterOptions } from "@/lib/reporting-filter-options";
import type { ListaCodigosResolvida } from "@/lib/produtos/lista-codigos-tipos";
import { contarFiltrosAtivos } from "@/lib/reporting/filters-shared";
import {
  FilterPill,
  FiltrosToggleButton,
  LimparFiltrosButton,
  SearchableMultiSelect,
  ToggleRow,
  alternarValor,
} from "@/components/reporting/filter-panel";
import { CompactDate, CompactInput, VendasFiltrosPainel } from "@/components/reporting/vendas-filtros";

type Opcao = { id: string; nome: string };

export type OpcoesManutencaoMassa = {
  /** As MESMAS opções do relatório de Vendas. */
  filterOptions: ReportingFilterOptions;
  farmacias: Opcao[];
  /** Fabricantes (os mesmos nomes de `filterOptions.fabricantes`, com o ID). */
  fabricantes: Opcao[];
  /** Fornecedores que são habituais de pelo menos um produto/farmácia. */
  fornecedoresHabituais: Opcao[];
  tiposArtigo: string[];
};

const PAGE_SIZE = 50;

/** Estado dos filtros — o de Vendas (nomes, slugs) + o que é específico da manutenção. */
type FiltroFormState = {
  pesquisa: string;
  listaCodigos: ListaCodigosResolvida | null;
  farmacias: string[]; // nomes (como em Vendas)
  distribuidores: string[];
  fabricantes: string[]; // «Fabricante atual» — nomes, convertidos em IDs ao enviar
  categorias: string[];
  subcategorias: string[];
  utilizacoes: string[]; // slugs
  incluirCredito: boolean;
  incluirTransferencias: boolean;
  apenasComStock: boolean;
  incluirManutencao: boolean;
  dataInicio: string;
  dataFim: string;
  tiposArtigo: string[];
  semFabricante: boolean;
  fornecedoresHabituais: string[]; // «Fornecedor habitual atual» — nomes
  semFornecedor: boolean;
  fabricanteDivergente: boolean;
};

const FORM_VAZIO: FiltroFormState = {
  pesquisa: "",
  listaCodigos: null,
  farmacias: [],
  distribuidores: [],
  fabricantes: [],
  categorias: [],
  subcategorias: [],
  utilizacoes: [],
  incluirCredito: DEFAULTS_MOVIMENTO.incluirCredito,
  incluirTransferencias: DEFAULTS_MOVIMENTO.incluirTransferencias,
  apenasComStock: DEFAULTS_MOVIMENTO.apenasComStock,
  incluirManutencao: DEFAULTS_MOVIMENTO.incluirManutencao,
  dataInicio: "",
  dataFim: "",
  tiposArtigo: [],
  semFabricante: false,
  fornecedoresHabituais: [],
  semFornecedor: false,
  fabricanteDivergente: false,
};

function paraFiltro(tipo: TipoManutencaoMassa, f: FiltroFormState, o: OpcoesManutencaoMassa): ManutencaoMassaFiltro {
  const idDe = (lista: Opcao[], nomes: string[]) => nomes.map((n) => lista.find((x) => x.nome === n)?.id).filter((x): x is string => !!x);
  const periodo = !!(f.dataInicio && f.dataFim);
  return {
    farmaciaIds: idDe(o.farmacias, f.farmacias),
    pesquisa: f.pesquisa.trim() || null,
    cnps: f.listaCodigos ? f.listaCodigos.cnps : undefined,
    categorias: f.categorias,
    subcategorias: f.subcategorias,
    utilizacoes: f.utilizacoes,
    distribuidores: f.distribuidores,
    from: periodo ? f.dataInicio : null,
    to: periodo ? f.dataFim : null,
    incluirCredito: f.incluirCredito,
    incluirTransferencias: f.incluirTransferencias,
    apenasComStock: f.apenasComStock,
    incluirManutencao: f.incluirManutencao,
    tiposArtigo: f.tiposArtigo,
    fabricanteAtualIds: idDe(o.fabricantes, f.fabricantes),
    semFabricante: f.semFabricante,
    fornecedorAtualIds: tipo === "FORNECEDOR" ? idDe(o.fornecedoresHabituais, f.fornecedoresHabituais) : undefined,
    semFornecedor: tipo === "FORNECEDOR" ? f.semFornecedor : false,
    fabricanteDivergente: tipo === "FABRICANTE" ? f.fabricanteDivergente : false,
  };
}

/** Resumo legível do que está a filtrar — mostrado antes de aplicar e no preview. */
function resumoFiltroLegivel(tipo: TipoManutencaoMassa, f: FiltroFormState, o: OpcoesManutencaoMassa): string[] {
  const partes: string[] = [];
  const nomes = (v: string[]) => v.join(", ");
  if (f.farmacias.length) partes.push(`Farmácia: ${nomes(f.farmacias)}`);
  if (f.pesquisa.trim()) partes.push(`Produto: "${f.pesquisa.trim()}"`);
  if (f.listaCodigos) partes.push(`Lista de CNP (${f.listaCodigos.cnps.length})`);
  if (f.distribuidores.length) partes.push(`Distribuidor: ${nomes(f.distribuidores)}`);
  if (f.fabricantes.length || f.semFabricante) {
    partes.push(`Fabricante actual: ${[...f.fabricantes, ...(f.semFabricante ? ["sem fabricante"] : [])].join(", ")}`);
  }
  if (f.categorias.length) partes.push(`Categoria: ${nomes(f.categorias)}`);
  if (f.subcategorias.length) partes.push(`Subcategoria: ${nomes(f.subcategorias)}`);
  if (f.utilizacoes.length) {
    const nomePorSlug = new Map(o.filterOptions.utilizacoes.map((u) => [u.slug, u.nome]));
    partes.push(`Utilização: ${f.utilizacoes.map((s) => nomePorSlug.get(s) ?? s).join(", ")}`);
  }
  if (f.tiposArtigo.length) partes.push(`Tipo de artigo: ${f.tiposArtigo.join(", ")}`);
  if (tipo === "FORNECEDOR" && (f.fornecedoresHabituais.length || f.semFornecedor)) {
    partes.push(`Fornecedor habitual actual: ${[...f.fornecedoresHabituais, ...(f.semFornecedor ? ["sem fornecedor habitual"] : [])].join(", ")}`);
  }
  if (tipo === "FABRICANTE" && f.fabricanteDivergente) partes.push("Fabricante divergente entre farmácias");
  if (f.dataInicio && f.dataFim) partes.push(`Movimento de vendas: ${f.dataInicio} → ${f.dataFim}`);
  if (partes.length === 0) partes.push("Sem filtros — todo o catálogo");
  return partes;
}

function DestinoPicker({ tipo, onChange }: { tipo: TipoManutencaoMassa; onChange: (destino: DestinoInput | null) => void }) {
  const [texto, setTexto] = useState("");
  const [resultados, setResultados] = useState<Opcao[]>([]);
  const [selecionado, setSelecionado] = useState<Opcao | null>(null);
  const [confirmarCriacao, setConfirmarCriacao] = useState(false);
  const rotulo = tipo === "FABRICANTE" ? "fabricante" : "fornecedor habitual";

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
    if (selecionado) onChange({ modo: "existente", id: selecionado.id });
    else if (confirmarCriacao && texto.trim().length >= 2) onChange({ modo: "novo", nome: texto.trim() });
    else onChange(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selecionado, confirmarCriacao, texto]);

  return (
    <div className="space-y-2" data-testid="destino-picker">
      <label className="block text-sm font-medium text-slate-700">
        {tipo === "FABRICANTE" ? "Fabricante de DESTINO" : "Fornecedor habitual de DESTINO"}
      </label>
      <input
        type="text"
        aria-label={`Destino: ${rotulo}`}
        className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
        placeholder={`Pesquisar ${rotulo} de destino…`}
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
              <button type="button" className="block w-full px-3 py-1.5 text-left hover:bg-slate-50" onClick={() => setSelecionado(r)}>
                {r.nome}
              </button>
            </li>
          ))}
        </ul>
      )}
      {!selecionado && texto.trim().length >= 2 && resultados.length === 0 && (
        <div className="rounded border border-amber-200 bg-amber-50 p-2 text-sm text-amber-800">
          <p>Não existe nenhum {rotulo} com este nome. Pode ser criado um novo — confirme abaixo.</p>
          <label className="mt-1 flex items-center gap-2">
            <input type="checkbox" checked={confirmarCriacao} onChange={(e) => setConfirmarCriacao(e.target.checked)} />
            <span>
              Criar novo {rotulo} &ldquo;{texto.trim()}&rdquo;
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

type PreviewOk = Extract<PreviewOperacaoResultado, { ok: true }>;

function PreviewPanel({
  preview,
  filtroLegivel,
  onConfirmar,
  onCancelar,
  aplicando,
}: {
  preview: PreviewOk;
  filtroLegivel: string[];
  onConfirmar: () => void;
  onCancelar: () => void;
  aplicando: boolean;
}) {
  const destino = preview.destino;
  const destinoNome =
    destino.status === "existente" ? destino.nome : destino.status === "novo" ? `${destino.nomeCanonico} (novo — será criado)` : "—";
  const rotuloValor = preview.tipo === "FABRICANTE" ? "Fabricante" : "Fornecedor habitual";
  return (
    <div className="space-y-4 rounded border border-slate-300 bg-slate-50 p-4" data-testid="preview-panel">
      <h3 className="text-base font-semibold text-slate-900">Confirmação obrigatória</h3>
      <div>
        <p className="text-sm font-medium text-slate-700">Filtros utilizados</p>
        <ul className="mt-1 flex flex-wrap gap-2 text-xs">
          {filtroLegivel.map((t) => (
            <li key={t} className="rounded-full border border-slate-300 bg-white px-2 py-0.5">
              {t}
            </li>
          ))}
        </ul>
      </div>
      <dl className="grid grid-cols-2 gap-2 text-sm">
        <dt className="text-slate-500">Correspondem aos filtros</dt>
        <dd className="font-medium" data-testid="preview-correspondentes">{preview.totalCorrespondentes}</dd>
        <dt className="text-slate-500">Produtos seleccionados (âmbito desta operação)</dt>
        <dd className="font-medium" data-testid="preview-selecionados">{preview.totalCount}</dd>
        <dt className="text-slate-500">Já com o valor de destino (ignorados)</dt>
        <dd className="font-medium" data-testid="preview-ja-no-destino">{preview.jaNoDestinoCount}</dd>
        <dt className="text-slate-500">Vão ser alterados</dt>
        <dd className="font-semibold text-emerald-700" data-testid="preview-alterar">{preview.iraAlterarCount}</dd>
        <dt className="text-slate-500">{rotuloValor} de destino</dt>
        <dd className="font-medium" data-testid="preview-destino">{destinoNome}</dd>
      </dl>
      {preview.ignoradosPorMotivo.length > 0 && (
        <p className="text-xs text-slate-600">
          Ignorados: {preview.ignoradosPorMotivo.map((m) => `${m.count} — ${m.motivo}`).join("; ")}
        </p>
      )}
      <div>
        <p className="mb-1 text-sm font-medium text-slate-700">
          {preview.tipo === "FORNECEDOR" ? "Por farmácia (actual → destino)" : "Valores actuais agrupados"}
        </p>
        <ul className="max-h-60 space-y-2 overflow-auto text-sm">
          {preview.porFarmacia.map((pf) => (
            <li key={pf.farmaciaId ?? "__catalogo__"} className="rounded border border-slate-200 bg-white p-2" data-testid="preview-farmacia">
              {pf.farmaciaNome && <p className="font-medium">{pf.farmaciaNome}</p>}
              <p className="text-xs text-slate-500">
                Abrangidos {pf.abrangidos} · alterados {pf.alterados} · ignorados {pf.ignorados}
              </p>
              <ul className="mt-1 space-y-0.5">
                {pf.agrupadoPorValorAnterior.map((g) => (
                  <li key={g.valorAnteriorId ?? "__nulo__"} className="flex justify-between">
                    <span>
                      {g.valorAnteriorNome ?? "(sem valor)"} → {destinoNome}
                    </span>
                    <span className="font-medium">{g.count}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex gap-3">
        <button
          type="button"
          disabled={aplicando || preview.iraAlterarCount === 0}
          onClick={onConfirmar}
          data-testid="confirmar-aplicar"
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

function AbaManutencao({ tipo, opcoes }: { tipo: TipoManutencaoMassa; opcoes: OpcoesManutencaoMassa }) {
  const [form, setForm] = useState<FiltroFormState>(FORM_VAZIO);
  const [filtrosAbertos, setFiltrosAbertos] = useState(false);
  const campo = <K extends keyof FiltroFormState>(k: K) => (v: FiltroFormState[K] | ((p: FiltroFormState[K]) => FiltroFormState[K])) =>
    setForm((f) => ({ ...f, [k]: typeof v === "function" ? (v as (p: FiltroFormState[K]) => FiltroFormState[K])(f[k]) : v }));

  const [pagina, setPagina] = useState(1);
  const [linhas, setLinhas] = useState<ItemManutencaoMassa[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const [modoSelecao, setModoSelecao] = useState<"manual" | "todos">("manual");
  const [selecionados, setSelecionados] = useState<Set<string>>(new Set());
  const [excluidos, setExcluidos] = useState<Set<string>>(new Set());
  const [avisoSelecao, setAvisoSelecao] = useState<string | null>(null);

  const [destino, setDestino] = useState<DestinoInput | null>(null);
  const [preview, setPreview] = useState<PreviewOk | null>(null);
  const [aplicando, startAplicar] = useTransition();
  const [mensagemFinal, setMensagemFinal] = useState<string | null>(null);
  /** Depois de aplicar, o servidor revalida a página e as opções mudam (ex.: um fornecedor deixa de ser habitual de alguém) — isso não pode apagar a mensagem de sucesso. */
  const mensagemProtegidaAte = useRef(0);

  const filtro = useMemo(() => paraFiltro(tipo, form, opcoes), [tipo, form, opcoes]);
  const filtroKey = JSON.stringify(filtro);
  const farmaciaObrigatoriaEmFalta = tipo === "FORNECEDOR" && form.farmacias.length === 0;

  // Subcategorias em cascata — a mesma regra de Vendas.
  const subcategoriasOpcoes = (
    form.categorias.length > 0
      ? opcoes.filterOptions.subcategorias.filter((s) => form.categorias.includes(s.categoria))
      : opcoes.filterOptions.subcategorias
  ).map((s) => s.nome);

  const periodoActivo = !!(form.dataInicio && form.dataFim);
  const filtrosActivosCount = contarFiltrosAtivos({
    farmaciaNomes: form.farmacias,
    categorias: form.categorias,
    subcategorias: form.subcategorias,
    utilizacoes: form.utilizacoes,
    fabricantes: [...form.fabricantes, ...(tipo === "FORNECEDOR" ? form.fornecedoresHabituais : [])],
    distribuidores: form.distribuidores,
    cnps: form.listaCodigos ? form.listaCodigos.cnps : undefined,
  });

  const carregarPagina = (p: number) => {
    if (farmaciaObrigatoriaEmFalta) return;
    setCarregando(true);
    setErro(null);
    listarProdutosManutencaoMassaAction({ tipo, filtro, page: p, pageSize: PAGE_SIZE }).then((r) => {
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

  const [filtroAnterior, setFiltroAnterior] = useState<string | null>(null);
  useEffect(() => {
    // Mudar o filtro depois de seleccionar NUNCA deixa uma selecção invisível: é limpa, com aviso.
    const tinhaSelecao = (modoSelecao === "manual" && selecionados.size > 0) || modoSelecao === "todos";
    if (filtroAnterior !== null && filtroAnterior !== filtroKey && tinhaSelecao) {
      setAvisoSelecao("Os filtros mudaram — a selecção foi limpa. Volte a seleccionar os produtos que pretende alterar.");
    } else if (filtroAnterior !== filtroKey) {
      setAvisoSelecao(null);
    }
    setFiltroAnterior(filtroKey);
    setModoSelecao("manual");
    setSelecionados(new Set());
    setExcluidos(new Set());
    setPreview(null);
    if (Date.now() > mensagemProtegidaAte.current) setMensagemFinal(null);
    carregarPagina(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtroKey]);

  const contagemSelecionada = modoSelecao === "todos" ? Math.max(0, totalCount - excluidos.size) : selecionados.size;

  function alternarLinha(chave: string) {
    setPreview(null);
    const alternar = (prev: Set<string>) => {
      const next = new Set(prev);
      if (next.has(chave)) next.delete(chave);
      else next.add(chave);
      return next;
    };
    if (modoSelecao === "todos") setExcluidos(alternar);
    else setSelecionados(alternar);
  }

  function selecionarTodaPagina() {
    setPreview(null);
    if (modoSelecao === "todos") {
      setExcluidos((prev) => {
        const next = new Set(prev);
        for (const l of linhas) next.delete(l.chave);
        return next;
      });
      return;
    }
    setSelecionados((prev) => {
      const next = new Set(prev);
      for (const l of linhas) next.add(l.chave);
      return next;
    });
  }

  function selecionarTodosOsQueCorrespondem() {
    setPreview(null);
    setModoSelecao("todos");
    setExcluidos(new Set());
  }

  function limparSelecao() {
    setPreview(null);
    setModoSelecao("manual");
    setSelecionados(new Set());
    setExcluidos(new Set());
  }

  function selecaoActual(): SelecaoManutencao {
    return modoSelecao === "manual"
      ? { modo: "manual", chaves: Array.from(selecionados) }
      : { modo: "todos", excluidas: Array.from(excluidos) };
  }

  async function pedirPreview() {
    if (!destino) return;
    setErro(null);
    const acao = tipo === "FABRICANTE" ? previewManutencaoFabricanteAction : previewManutencaoFornecedorAction;
    const r = await acao({ filtro, destino, selecao: selecaoActual() });
    if (!r.ok) {
      setErro(r.error);
      return;
    }
    setPreview(r);
  }

  async function confirmarAplicacao() {
    if (!destino || !preview) return;
    startAplicar(async () => {
      const acao = tipo === "FABRICANTE" ? aplicarManutencaoFabricanteAction : aplicarManutencaoFornecedorAction;
      const r = await acao({ filtro, destino, selecao: selecaoActual(), snapshotHash: preview.snapshotHash });
      if (!r.ok) {
        setErro(r.error);
        if ("code" in r && (r.code === "PREVIEW_DESACTUALIZADO" || r.code === "CONCORRENCIA")) setPreview(null);
        return;
      }
      setMensagemFinal(
        `Operação aplicada: ${r.quantidadeAlterada} alterado(s), ${r.quantidadeIgnorada} já estavam no destino` +
          (r.operacoes.length > 1 ? ` (${r.operacoes.length} operações, uma por farmácia).` : ".")
      );
      mensagemProtegidaAte.current = Date.now() + 5000;
      setPreview(null);
      setDestino(null);
      limparSelecao();
      carregarPagina(1);
    });
  }

  /** Mesma regra de Vendas: repõe TODOS os filtros ao estado inicial, excepto o período (é vista, não filtragem). */
  function limparFiltros() {
    setForm((prev) => ({ ...FORM_VAZIO, dataInicio: prev.dataInicio, dataFim: prev.dataFim }));
  }

  const extra = (
    <>
      {tipo === "FORNECEDOR" && (
        <SearchableMultiSelect
          label="Fornecedor habitual atual"
          options={opcoes.fornecedoresHabituais.map((f) => f.nome)}
          selected={form.fornecedoresHabituais}
          onToggle={(v) => campo("fornecedoresHabituais")((prev) => alternarValor(v, prev))}
        />
      )}
      <SearchableMultiSelect
        label="Tipo de artigo"
        options={opcoes.tiposArtigo}
        selected={form.tiposArtigo}
        onToggle={(v) => campo("tiposArtigo")((prev) => alternarValor(v, prev))}
      />
    </>
  );

  return (
    <div className="space-y-6">
      <section className="rounded-[20px] border border-white/70 bg-white/84 px-4 py-3 shadow-[0_8px_18px_rgba(15,23,42,0.04)]" data-testid="filtros-manutencao">
        <div className="grid gap-2.5 xl:grid-cols-[1.4fr_0.9fr_0.9fr_auto]">
          <CompactInput label="Produto" value={form.pesquisa} onChange={campo("pesquisa")} placeholder="Pesquisar por CNP ou descrição..." />
          <CompactDate label="Data início" value={form.dataInicio} onChange={campo("dataInicio")} />
          <CompactDate label="Data fim" value={form.dataFim} onChange={campo("dataFim")} />
          <div className="flex items-end gap-2">
            <FiltrosToggleButton aberto={filtrosAbertos} onToggle={() => setFiltrosAbertos((v) => !v)} contagem={filtrosActivosCount} />
            <LimparFiltrosButton onClick={limparFiltros} />
          </div>
        </div>
        <p className="mt-1 text-[11px] text-slate-500">
          Datas (opcionais): limitam aos produtos com movimento de vendas no período — a mesma regra do relatório de Vendas.
        </p>

        {filtrosAbertos && (
          <VendasFiltrosPainel
            rotulos={{ fabricante: "Fabricante atual" }}
            mostrarNaturezas={periodoActivo}
            opcoes={{
              farmacias: opcoes.farmacias.map((f) => f.nome),
              distribuidores: opcoes.filterOptions.fornecedores,
              fabricantes: opcoes.fabricantes.map((f) => f.nome),
              laboratorios: undefined,
              categorias: opcoes.filterOptions.categorias,
              subcategorias: subcategoriasOpcoes,
              utilizacoes: opcoes.filterOptions.utilizacoes,
            }}
            valores={{
              listaCodigos: form.listaCodigos,
              farmacias: form.farmacias,
              distribuidores: form.distribuidores,
              fabricantes: form.fabricantes,
              categorias: form.categorias,
              subcategorias: form.subcategorias,
              utilizacoes: form.utilizacoes,
              incluirCredito: form.incluirCredito,
              incluirTransferencias: form.incluirTransferencias,
            }}
            set={{
              listaCodigos: campo("listaCodigos"),
              farmacias: campo("farmacias"),
              distribuidores: campo("distribuidores"),
              fabricantes: campo("fabricantes"),
              categorias: campo("categorias"),
              subcategorias: campo("subcategorias"),
              utilizacoes: campo("utilizacoes"),
              incluirCredito: campo("incluirCredito"),
              incluirTransferencias: campo("incluirTransferencias"),
            }}
            extra={extra}
          />
        )}

        {tipo === "FORNECEDOR" && form.fornecedoresHabituais.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {form.fornecedoresHabituais.map((item) => (
              <FilterPill key={`fh-${item}`} label={`Fornecedor habitual: ${item}`} onRemove={() => campo("fornecedoresHabituais")((prev) => prev.filter((v) => v !== item))} />
            ))}
          </div>
        )}

        <div className="mt-2.5 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-slate-100 pt-2.5">
          <ToggleRow label="Sem fabricante" checked={form.semFabricante} onChange={campo("semFabricante")} compact />
          {tipo === "FORNECEDOR" ? (
            <ToggleRow label="Sem fornecedor habitual" checked={form.semFornecedor} onChange={campo("semFornecedor")} compact />
          ) : (
            <ToggleRow label="Fabricante divergente entre farmácias" checked={form.fabricanteDivergente} onChange={campo("fabricanteDivergente")} compact />
          )}
          {periodoActivo && (
            <>
              <ToggleRow label="Incluir stock sem vendas" checked={form.apenasComStock} onChange={campo("apenasComStock")} compact title="Alarga o universo a produtos com stock actual, mesmo sem vendas no período (como em Vendas)." />
              <ToggleRow label="Incluir manutenção de vendas" checked={form.incluirManutencao} onChange={campo("incluirManutencao")} compact title="Soma as quantidades de Manutenção de Vendas (como em Vendas)." />
            </>
          )}
        </div>
      </section>

      {farmaciaObrigatoriaEmFalta ? (
        <p className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800" data-testid="farmacia-em-falta">
          Seleccione pelo menos uma farmácia (filtro «Farmácia») para pesquisar fornecedores habituais — o fornecedor habitual pertence ao produto
          em cada farmácia, e só as farmácias seleccionadas são alteradas.
        </p>
      ) : (
        <>
          {avisoSelecao && <p className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800" data-testid="aviso-selecao">{avisoSelecao}</p>}
          <section className="rounded border border-slate-200">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2 text-sm">
              <span data-testid="contagem-resultados">
                {totalCount} {tipo === "FORNECEDOR" ? "linha(s) produto/farmácia" : "produto(s)"} correspondem ao filtro. Seleccionados:{" "}
                <strong data-testid="contagem-selecionados">{contagemSelecionada}</strong>
              </span>
              <div className="flex gap-2">
                <button type="button" className="underline" onClick={selecionarTodaPagina}>
                  Seleccionar página
                </button>
                <button type="button" className="underline" onClick={selecionarTodosOsQueCorrespondem} data-testid="selecionar-todos">
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
                    {tipo === "FORNECEDOR" && <th className="p-2">Farmácia</th>}
                    <th className="p-2">{tipo === "FABRICANTE" ? "Fabricante actual" : "Fornecedor habitual actual"}</th>
                  </tr>
                </thead>
                <tbody>
                  {linhas.map((l) => {
                    const marcado = modoSelecao === "todos" ? !excluidos.has(l.chave) : selecionados.has(l.chave);
                    return (
                      <tr key={l.chave} className="border-b border-slate-100">
                        <td className="p-2">
                          <input type="checkbox" aria-label={`Seleccionar ${l.cnp}`} checked={marcado} onChange={() => alternarLinha(l.chave)} />
                        </td>
                        <td className="p-2">{l.cnp}</td>
                        <td className="p-2">{l.designacao}</td>
                        {tipo === "FORNECEDOR" && <td className="p-2">{l.farmaciaNome ?? "—"}</td>}
                        <td className="p-2">{l.valorAtualNome ?? "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <div className="flex items-center justify-between border-t border-slate-200 px-3 py-2 text-sm">
              <button type="button" disabled={pagina <= 1} onClick={() => carregarPagina(pagina - 1)} className="disabled:opacity-40">
                ← Anterior
              </button>
              <span>Página {pagina}</span>
              <button type="button" disabled={pagina * PAGE_SIZE >= totalCount} onClick={() => carregarPagina(pagina + 1)} className="disabled:opacity-40">
                Seguinte →
              </button>
            </div>
          </section>

          {erro && <p className="rounded border border-rose-300 bg-rose-50 p-3 text-sm text-rose-800" data-testid="erro-manutencao">{erro}</p>}
          {mensagemFinal && <p className="rounded border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800" data-testid="mensagem-final">{mensagemFinal}</p>}

          <section className="space-y-3 rounded border border-slate-200 p-4">
            <DestinoPicker tipo={tipo} onChange={(d) => { setDestino(d); setPreview(null); }} />
            <div className="text-xs text-slate-500">Filtros aplicados: {resumoFiltroLegivel(tipo, form, opcoes).join(" · ")}</div>
            <button
              type="button"
              disabled={!destino || contagemSelecionada === 0}
              onClick={pedirPreview}
              data-testid="pre-visualizar"
              className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              Pré-visualizar alteração
            </button>
          </section>

          {preview && (
            <PreviewPanel
              preview={preview}
              filtroLegivel={resumoFiltroLegivel(tipo, form, opcoes)}
              onConfirmar={confirmarAplicacao}
              onCancelar={() => setPreview(null)}
              aplicando={aplicando}
            />
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
                  <button type="button" disabled={aRever === op.id} onClick={() => reverter(op.id)} className="text-xs text-rose-700 underline disabled:opacity-40">
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

export function ManutencaoMassaClient({ opcoes }: { opcoes: OpcoesManutencaoMassa }) {
  const [aba, setAba] = useState<TipoManutencaoMassa>("FABRICANTE");

  return (
    <div className="space-y-6">
      <div className="flex gap-2 border-b border-slate-200">
        {(["FABRICANTE", "FORNECEDOR"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setAba(t)}
            className={`px-4 py-2 text-sm font-medium ${aba === t ? "border-b-2 border-slate-900 text-slate-900" : "text-slate-500"}`}
          >
            {t === "FABRICANTE" ? "Fabricantes" : "Fornecedores"}
          </button>
        ))}
      </div>

      <AbaManutencao key={aba} tipo={aba} opcoes={opcoes} />

      <HistoricoOperacoes />
    </div>
  );
}
