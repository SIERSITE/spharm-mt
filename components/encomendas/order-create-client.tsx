"use client";

import { Fragment, useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MutableRefObject } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useTaskBar } from "@/lib/workspace/task-bar-context";
import { ChevronDown, Plus, Trash2, ArrowLeftRight } from "lucide-react";
import { ArtigoLink } from "@/components/stock/artigo-link";
import {
  createConsolidatedOrdersAction,
  createOrderAction,
  generateProposalAction,
  gerarPlanoGrupoAction,
  carregarRascunhoNovaEncomendaAction,
  type ProposalMode,
  type DecisaoLinhaGrupoInput,
  type RascunhoNovaEncomenda,
} from "@/app/encomendas/nova/actions";
import {
  autosaveEncomendaAction,
  finalizeFromDetailAction,
  duplicarRascunhoComoNovoAction,
  cancelDraftAction,
} from "@/app/encomendas/[id]/actions";
import { useAutosaveEncomenda } from "@/lib/encomendas/use-autosave-encomenda";
import { AutosaveStatusBadge } from "@/components/encomendas/autosave-status-badge";
import { useUtilizador } from "@/components/layout/session-provider";
import {
  serializarPropostaContexto,
  type PropostaContexto,
} from "@/lib/encomendas/proposal-context";
import { getHistoricoProdutosLoteAction } from "@/app/encomendas/actions";
import { type ProductSearchResult } from "@/app/encomendas/nova/search";
import { ProductPicker } from "@/components/encomendas/product-picker";
import { HistoricoProdutoButton } from "@/components/encomendas/historico-produto-modal";
import type { HistoricoProduto12MesesResult } from "@/lib/encomendas/historico-produto";
import { enriquecerLinhasRascunho } from "@/lib/encomendas/reconstruir-rascunho";
import { agruparPorProduto, type GrupoProduto } from "@/lib/encomendas/agrupar-produto";
import { ImportListaCodigos } from "@/components/reporting/import-lista-codigos";
import {
  CabecalhoOrdenavel,
  useOrdenacao,
} from "@/components/ui/cabecalho-ordenavel";
import { ordenarLinhas, type ValorOrdenavel } from "@/lib/tabela/ordenacao";
import {
  fundirComProposta,
  rotuloOrigem,
  sobreviveARecalculo,
  type OrigemLinha,
} from "@/lib/encomendas/origem-linha";
import {
  sugerirDecisao,
  fundirDecisoesGrupo,
  mapaDecisoes,
  calcularResumoGrupo,
  type AcaoLinhaGrupo,
  type DecisaoLinha,
} from "@/lib/encomendas/decisao-grupo";
import type { ListaCodigosResolvida } from "@/lib/produtos/lista-codigos-tipos";
// Do modulo PURO, nao de `proposal.ts`: aquele tem `server-only` e um
// import de VALOR daqui arrastava-o para o bundle do browser. O `tsc`
// nao apanha isto — so' o bundler, no `next build`.
import { MAX_LINHAS_PROPOSTA } from "@/lib/encomendas/limites";
import type { ResumoListaImportada } from "@/lib/encomendas/proposal";
import type {
  ProposalRow,
  ProposalBaseRule,
  ProposalEstado,
  ProposalStats,
  ExcessoInfo,
} from "@/lib/encomendas/proposal";
import type { ReportingFilterOptions } from "@/lib/reporting-filter-options";
import {
  ENCOMENDA_PREFILL_STORAGE_KEY,
  parseEncomendaPrefillPayload,
} from "@/lib/encomendas/prefill-from-vendas";

// ─── Tipos locais ─────────────────────────────────────────────────────────────

type Line = {
  key: number;
  produtoId: string;
  cnp: number;
  designacao: string;
  fabricante: string | null;
  fornecedor: string | null;
  farmaciaNome: string | null;
  farmaciaId: string | null;
  salesQty: number | null;
  avgDailySales: number | null;
  currentStock: number | null;
  coberturaAtualDias: number | null;
  pendingQty: number | null;
  suggestedQty: number | null;
  transferirQty: number;
  finalQty: string;
  notas: string;
  /**
   * Proveniência da linha — os MESMOS valores do enum da base de dados
   * (`OrigemLinhaEncomenda`).
   *
   * Eram `"proposal" | "manual" | "prefill"`, só no cliente e sem
   * persistência. Passam a ser `PROPOSTA | MANUAL | SUGESTAO` para não
   * haver tradução entre o que o ecrã sabe e o que a coluna guarda: a
   * tradução é o sítio onde os dois lados divergem no dia em que alguém
   * acrescenta um quarto valor a um só deles.
   */
  origem: OrigemLinha;
  estado: ProposalEstado | null;
  motivo: string | null;
  excessoFonte: ExcessoInfo[];
  /**
   * O artigo está aqui porque o utilizador o nomeou numa lista
   * importada e NÃO vendeu no período. Ver `ProposalRow`.
   */
  semVendasNoPeriodo: boolean;
  /**
   * `true` numa linha restaurada de rascunho cujos campos informativos
   * (vendas/stock/cobertura) ainda não foram recalculados — ver
   * `lib/encomendas/reconstruir-rascunho.ts`. Nunca remove a linha.
   */
  dadosDesactualizados: boolean;

  // ── Bloco D — decisão por linha em modo grupo ────────────────────
  //
  // Só têm sentido em `mode === "grupo"`, mas vivem em `Line` (e não
  // num tipo à parte) porque `linhas` é UM único array partilhado por
  // todos os modos — um segundo array em paralelo indexado pela mesma
  // `key` seria dessincronizável. Nos outros modos ficam com os
  // valores por omissão de `sugerirDecisao` e nunca são lidos.
  //
  // Ver `lib/encomendas/decisao-grupo.ts`.
  acao: AcaoLinhaGrupo;
  acaoTocada: boolean;
  farmaciaEncomendaId: string | null;
  farmaciaOrigemId: string | null;
  farmaciaDestinoId: string | null;
};

/** `Line[]` consolidado por produto — só usado em `mode === "grupo"`. Ver `lib/encomendas/agrupar-produto.ts`. */
type GrupoProdutoLine = GrupoProduto<Line>;

/**
 * Os campos "operacionais" de uma linha, pela ordem em que Enter/Shift+Enter
 * os percorre (ver Ponto 3 — navegação por teclado). `finalQty` existe em
 * TODOS os modos; os três primeiros só em `mode === "grupo"` (célula de
 * Decisão) — ver `ordemCamposLinha`.
 */
type CampoSlot = "acao" | "encomendaFarmacia" | "origemFarmacia" | "destinoFarmacia" | "finalQty";

type Props = {
  farmacias: { id: string; nome: string }[];
  filterOptions: ReportingFilterOptions;
  productTypes: string[];
  latestDataMonth?: { ano: number; mes: number } | null;
  userPerfil: string;
  userFarmaciaId: string | null;
};

let lineKeyCounter = 0;
function nextKey(): number {
  return ++lineKeyCounter;
}

const CAN_GROUP_PERFIS = new Set(["ADMINISTRADOR", "GESTOR_GRUPO"]);

// ─── Utils ────────────────────────────────────────────────────────────────────

function fmtNum(v: number | null | undefined, digits = 0): string {
  if (v == null) return "—";
  if (digits === 0) return String(Math.round(v));
  return v.toFixed(digits);
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function defaultPeriod(latest?: { ano: number; mes: number } | null) {
  if (latest) {
    const end = new Date(latest.ano, latest.mes, 0);
    const start = new Date(latest.ano, latest.mes - 1 - 2, 1);
    return { start: isoDate(start), end: isoDate(end) };
  }
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 89);
  return { start: isoDate(start), end: isoDate(end) };
}

function estadoLabel(e: ProposalEstado): string {
  switch (e) {
    case "TRANSFERÊNCIA": return "Transferência";
    case "COMPRAR": return "Comprar";
    case "AGUARDAR": return "Aguardar";
    case "ADEQUADO": return "Adequado";
  }
}

function estadoColors(e: ProposalEstado): string {
  switch (e) {
    case "TRANSFERÊNCIA": return "bg-blue-50 text-blue-700 border-blue-200";
    case "COMPRAR": return "bg-rose-50 text-rose-700 border-rose-200";
    case "AGUARDAR": return "bg-amber-50 text-amber-700 border-amber-200";
    case "ADEQUADO": return "bg-emerald-50 text-emerald-700 border-emerald-200";
  }
}

function rowBg(e: ProposalEstado | null): string {
  if (!e) return "";
  switch (e) {
    case "TRANSFERÊNCIA": return "bg-blue-50/30";
    case "COMPRAR": return "";
    case "AGUARDAR": return "bg-amber-50/20";
    case "ADEQUADO": return "bg-emerald-50/20";
  }
}

// ─── Componente principal ─────────────────────────────────────────────────────

export function OrderCreateClient({
  farmacias,
  filterOptions,
  productTypes,
  latestDataMonth,
  userPerfil,
  userFarmaciaId,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [busy, startTransition] = useTransition();
  const [generating, startGenerate] = useTransition();
  const [gerandoPlano, startGerarPlano] = useTransition();
  const [flash, setFlash] = useState<{ type: "ok" | "err" | "info"; msg: string } | null>(null);

  const canGroupMode = CAN_GROUP_PERFIS.has(userPerfil);

  // Farmácias visíveis para o utilizador
  const farmaciasVisiveis = useMemo(() => {
    if (canGroupMode) return farmacias;
    if (!userFarmaciaId) return farmacias;
    return farmacias.filter((f) => f.id === userFarmaciaId);
  }, [farmacias, canGroupMode, userFarmaciaId]);

  // ─── Modo ────────────────────────────────────────────────────────────────
  const [mode, setMode] = useState<ProposalMode>("farmacia");

  // ─── Critérios ───────────────────────────────────────────────────────────
  const period = useMemo(() => defaultPeriod(latestDataMonth), []);
  const [farmaciaId, setFarmaciaId] = useState(farmaciasVisiveis[0]?.id ?? "");
  const [startDate, setStartDate] = useState(period.start);
  const [endDate, setEndDate] = useState(period.end);
  const [considerStock, setConsiderStock] = useState(true);
  const [baseRule, setBaseRule] = useState<ProposalBaseRule>("coverage");
  const [coverageDays, setCoverageDays] = useState(15);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selFabricantes, setSelFabricantes] = useState<string[]>([]);
  const [selFornecedores, setSelFornecedores] = useState<string[]>([]);
  const [selCategorias, setSelCategorias] = useState<string[]>([]);
  const [selSubcategorias, setSelSubcategorias] = useState<string[]>([]);
  const [selUtilizacoes, setSelUtilizacoes] = useState<string[]>([]);
  const [selProductTypes, setSelProductTypes] = useState<string[]>([]);
  /**
   * Lista de CNP importada por ficheiro.
   *
   * Define o UNIVERSO de artigos da proposta e mais nada: a cobertura, o
   * stock, os pendentes e o excedente continuam a ser calculados pela
   * lógica de sempre. É o mesmo componente, o mesmo endpoint e o mesmo
   * campo (`cnps`) dos Relatórios.
   */
  const [listaCodigos, setListaCodigos] = useState<ListaCodigosResolvida | null>(null);

  // Subcategorias acompanham a categoria escolhida — oferecer uma
  // subcategoria de outra categoria é oferecer zero linhas.
  const subcategoriasVisiveis = (
    selCategorias.length > 0
      ? filterOptions.subcategorias.filter((s) => selCategorias.includes(s.categoria))
      : filterOptions.subcategorias
  ).map((s) => s.nome);
  // O filtro viaja em slug; mostra-se pelo nome.
  const nomePorSlug = new Map(filterOptions.utilizacoes.map((u) => [u.slug, u.nome]));
  const slugPorNome = new Map(filterOptions.utilizacoes.map((u) => [u.nome, u.slug]));

  // ─── Linhas ──────────────────────────────────────────────────────────────
  const [linhas, setLinhas] = useState<Line[]>([]);

  const taskBar = useTaskBar();
  const pathname = usePathname();

  const [hasProposal, setHasProposal] = useState(false);
  const [proposalMeta, setProposalMeta] = useState<{
    numDays: number;
    stats: ProposalStats;
    /** A proposta bateu no tecto de 500 linhas. Ver `ProposalResult.meta`. */
    truncated: boolean;
    /** Quantos CNP vinham da lista importada. */
    cnpsNaLista?: number;
    /** Produtos DISTINTOS que a proposta encontrou com vendas no período. */
    comVendas: number;
    /** A contabilidade da lista importada. Ver `ResumoListaImportada`. */
    listaImportada?: ResumoListaImportada;
  } | null>(null);

  // ─── Bloco D — plano de grupo gerado ────────────────────────────────────
  const [planoResultado, setPlanoResultado] = useState<{
    listasEncomenda: { farmaciaId: string; listaEncomendaId: string; nLinhas: number }[];
    transferencias: { farmaciaOrigemId: string; farmaciaDestinoId: string; transferenciaId: string; nLinhas: number }[];
  } | null>(null);

  // ─── Filtros da tabela ────────────────────────────────────────────────────
  const [tableSearch, setTableSearch] = useState("");
  const [filterEstado, setFilterEstado] = useState<ProposalEstado | null>(null);
  const [filterFarmaciaTabela, setFilterFarmaciaTabela] = useState("");
  const [filterRuturas, setFilterRuturas] = useState(false);
  const [filterStockBaixo, setFilterStockBaixo] = useState(false);
  // ── Ordenação ────────────────────────────────────────────────────
  //
  // Esta tabela era a ÚNICA da aplicação com ordenação por cabeçalho, e
  // tinha a sua própria cópia do ciclo asc/desc, do comparador e do
  // indicador. É literalmente o caso que `lib/tabela/ordenacao.ts`
  // existe para eliminar — passa a usar o motor comum.
  //
  // O estado inicial preserva EXACTAMENTE o comportamento anterior:
  // vendas decrescentes. Arrancar sem ordenação mudaria a primeira
  // coisa que o utilizador vê ao gerar uma proposta.
  const { ordenacao, alternar } = useOrdenacao<ColunaEncomenda>({
    coluna: "salesQty",
    direcao: "desc",
  });

  // ─── Picker manual ────────────────────────────────────────────────────────
  const [manualOpen, setManualOpen] = useState(false);

  // ─── Cabeçalho ────────────────────────────────────────────────────────────
  const [nome, setNome] = useState("");

  // ─── Rascunho eager (Bloqueador 1) ──────────────────────────────────────
  //
  // Âmbito desta fase: SÓ `mode === "farmacia"`. `grupo` termina sempre
  // num único gesto atómico (handleGerarPlano/gerarPlanoGrupoAction — não
  // há noção de "rascunho retomável" nesse fluxo, por desenho, desde
  // antes desta revisão). `consolidacao` cria N `ListaEncomenda`, uma por
  // farmácia — um único hook de autosave (1 listaEncomendaId) não serve
  // uma sessão com N rascunhos em simultâneo; isso é uma funcionalidade
  // maior e distinta (N hooks ou um hook redesenhado), não uma variação
  // pequena desta. Documentado aqui e no relatório final — não é uma
  // omissão silenciosa: `persistLineChange`/`ensureDraft` abaixo
  // recusam-se explicitamente a agir fora de "farmacia", e os fluxos de
  // grupo/consolidação continuam exactamente como estavam (submit() só
  // no clique, sem regressão).
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draftVersaoInicial, setDraftVersaoInicial] = useState(0);
  const [carregandoRascunho, setCarregandoRascunho] = useState(false);
  // Single-flight: enquanto a criação está em curso TODOS os chamadores
  // esperam a MESMA promise (nunca `null`, que perdia a edição que
  // disparou a chamada concorrente). `chaveIdempotenciaRef` é gerada uma
  // vez por tentativa e reutilizada em retries após erro — o servidor
  // devolve o rascunho já criado se a resposta original se perdeu.
  const draftPromiseRef = useRef<Promise<string | null> | null>(null);
  const pedidoCongeladoRef = useRef<{ chave: string; input: Parameters<typeof createOrderAction>[0] } | null>(null);
  const pendentesPosCriacaoRef = useRef<
    Array<{ produtoId: string; patch?: { quantidadeAjustada?: number | null; notas?: string | null; origem?: OrigemLinha }; remover?: boolean }>
  >([]);
  // Consolidação: chave do lote + impressão do payload com que foi gerada.
  const loteConsolidacaoRef = useRef<{ chave: string; impressao: string } | null>(null);
  const rascunhoCarregadoRef = useRef(false); // evita recarregar 2x em StrictMode/re-render

  const utilizador = useUtilizador();
  const autosave = useAutosaveEncomenda({
    listaEncomendaId: draftId,
    farmaciaId,
    versaoInicial: draftVersaoInicial,
    tenantSlug: utilizador?.tenant ?? "desconhecido",
    userId: utilizador?.userId ?? "desconhecido",
    autosaveAction: autosaveEncomendaAction,
  });

  // Depois de um rascunho recuperado por retry, aplica as edições que o
  // utilizador fez enquanto a criação falhava/estava pendente.
  useEffect(() => {
    if (!draftId || pendentesPosCriacaoRef.current.length === 0) return;
    const pendentes = pendentesPosCriacaoRef.current;
    pendentesPosCriacaoRef.current = [];
    for (const p of pendentes) {
      if (p.remover) autosave.marcarRemovido(p.produtoId);
      else if (p.patch) autosave.marcarSujo(p.produtoId, p.patch);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId]);

  function buildContextoActual(): PropostaContexto {
    return {
      version: 1,
      mode,
      farmaciaId: mode === "farmacia" ? farmaciaId : null,
      startDate,
      endDate,
      considerStock,
      baseRule,
      coverageDays,
      filters: {
        fabricantes: selFabricantes,
        fornecedores: selFornecedores,
        categorias: selCategorias,
        subcategorias: selSubcategorias,
        utilizacoes: selUtilizacoes,
        productTypes: selProductTypes,
      },
      listaImportadaResumo: listaCodigos
        ? {
            nomeFicheiro: listaCodigos.nomeFicheiro,
            encontrados: listaCodigos.encontrados,
            naoEncontrados: listaCodigos.naoEncontrados.length,
          }
        : null,
      nome,
    };
  }

  /**
   * Garante que existe um rascunho persistido, criando-o (num ÚNICO
   * `createOrderAction`, com TODAS as linhas válidas actuais — 300
   * linhas em lote, nunca 300 pedidos) na primeira chamada. Chamadas
   * seguintes são no-op (devolvem o id já conhecido). Nunca cria um
   * segundo rascunho para a mesma sessão — `draftPromiseRef` (single-flight) serializa
   * chamadas concorrentes (vários campos a disparar isto quase ao mesmo
   * tempo).
   */
  function ensureDraft(linhasActuais: Line[]): Promise<string | null> {
    if (draftId) return Promise.resolve(draftId);
    if (mode !== "farmacia") return Promise.resolve(null);
    if (!farmaciaId) return Promise.resolve(null);
    if (draftPromiseRef.current) return draftPromiseRef.current;

    const validas = linhasActuais.filter((l) => {
      const q = Number(l.finalQty || "0");
      return Number.isFinite(q) && q > 0;
    });
    if (validas.length === 0) return Promise.resolve(null);

    // Pedido CONGELADO junto da chave: um retry após timeout/perda de
    // resposta reenvia exactamente o mesmo payload (o servidor compara o
    // hash — payload diferente sob a mesma chave seria conflito). As
    // edições feitas entretanto seguem depois pelo autosave (abaixo).
    if (!pedidoCongeladoRef.current) {
      pedidoCongeladoRef.current = {
        chave: crypto.randomUUID().replace(/-/g, ""),
        input: {
          farmaciaId,
          nome: nome.trim() || `Encomenda ${new Date().toLocaleDateString("pt-PT")}`,
          finalize: false,
          linhas: validas.map((l) => ({
            produtoId: l.produtoId,
            quantidadeSugerida: l.suggestedQty ?? null,
            quantidadeAjustada: Number(l.finalQty),
            notas: l.notas.trim() || null,
            origem: l.origem,
          })),
          contexto: serializarPropostaContexto(buildContextoActual()) ?? null,
        },
      };
    }
    const congelado = pedidoCongeladoRef.current;

    const promessa = (async (): Promise<string | null> => {
      try {
        const result = await createOrderAction({ ...congelado.input, clientIdempotencyKey: congelado.chave });
        if (!result.ok) {
          setFlash({ type: "err", msg: result.error });
          // Conflito explícito: a chave não pode ser reutilizada com outro
          // pedido — a próxima tentativa nasce com chave nova.
          if (result.code === "IDEMPOTENCY_CONFLICT") pedidoCongeladoRef.current = null;
          return null; // caso contrário a chave e o pedido mantêm-se: o retry é idempotente
        }
        pedidoCongeladoRef.current = null;
        setDraftId(result.listaEncomendaId);
        setDraftVersaoInicial(0);
        // Edições posteriores ao pedido congelado (retry após falha):
        // vão para o servidor pelo autosave com optimistic locking.
        const noServidor = new Map(congelado.input.linhas.map((l) => [l.produtoId, l]));
        const actuais = new Map(validas.map((l) => [l.produtoId, l]));
        for (const l of validas) {
          const antes = noServidor.get(l.produtoId);
          const notasAgora = l.notas.trim() || null;
          if (!antes || antes.quantidadeAjustada !== Number(l.finalQty) || (antes.notas ?? null) !== notasAgora) {
            pendentesPosCriacaoRef.current.push({
              produtoId: l.produtoId,
              patch: { quantidadeAjustada: Number(l.finalQty), notas: notasAgora, origem: l.origem },
            });
          }
        }
        for (const id of noServidor.keys()) {
          if (!actuais.has(id)) pendentesPosCriacaoRef.current.push({ produtoId: id, remover: true });
        }
        const params = new URLSearchParams(searchParams.toString());
        params.set("rascunho", result.listaEncomendaId);
        // `history.replaceState` (integrado com useSearchParams — ver docs
        // do Next, «single-page-applications») em vez de `router.replace`:
        // depois de uma Server Action que faz `revalidatePath`, o payload
        // devolvido traz a URL de ANTES e reverte o `router.replace` (medido
        // no browser: `?rascunho=` desaparecia logo após criar o rascunho).
        window.history.replaceState(window.history.state, "", `${pathname}?${params.toString()}`);
        return result.listaEncomendaId;
      } catch (err) {
        // Rede/timeout: o servidor pode ter criado o rascunho. O retry
        // reenvia o MESMO pedido com a MESMA chave e recupera-o.
        setFlash({ type: "err", msg: err instanceof Error ? err.message : "Falha ao criar rascunho." });
        return null;
      } finally {
        draftPromiseRef.current = null;
      }
    })();
    draftPromiseRef.current = promessa;
    return promessa;
  }

  /**
   * Ponto único por onde TODAS as edições de uma linha (quantidade,
   * notas, remoção, adição manual) passam depois de um rascunho existir
   * — reusa sempre `ensureDraft` + `autosave.marcarSujo`, nunca um
   * segundo caminho de gravação. Fora de `mode === "farmacia"` é sempre
   * no-op (ver nota acima).
   */
  async function persistLineChange(
    produtoId: string,
    patch: { quantidadeAjustada?: number | null; notas?: string | null; origem?: OrigemLinha },
    linhasActuais: Line[]
  ) {
    if (mode !== "farmacia") return;
    const id = draftId ?? (await ensureDraft(linhasActuais));
    if (!id) return;
    autosave.marcarSujo(produtoId, patch);
  }

  function persistLineRemoval(produtoId: string) {
    if (mode !== "farmacia" || !draftId) return; // sem rascunho ainda: nada para remover no servidor
    autosave.marcarRemovido(produtoId);
  }

  /**
   * Conflito de versão (outra sessão gravou entretanto — ver
   * `ConflitoVersaoError`). Ao contrário do ecrã de detalhe, este
   * componente NUNCA remonta só porque `draftId` muda (fica sempre na
   * mesma rota `/encomendas/nova`), por isso os dois caminhos usam
   * navegação REAL (`window.location`, não `router.push`) — garante que
   * o efeito de hidratação (que só corre uma vez, ao montar) corre de
   * novo com o id certo, em vez de deixar o hook de autosave com
   * `versaoRef`/pendentes de uma sessão antiga presos num componente que
   * nunca desmontou.
   */
  function handleConflitoActualizar() {
    if (!draftId) return;
    window.location.href = `${pathname}?rascunho=${draftId}`;
  }

  /**
   * Cancela o rascunho eager — arquiva (`ELIMINADA`, o MESMO soft-delete
   * de `cancelDraftAction`/`OrderDetailClient`), nunca apaga. Pede
   * confirmação explícita; nunca silencioso.
   */
  function handleCancelDraft() {
    if (!draftId) return;
    if (
      !window.confirm(
        "Cancelar este rascunho? Fica arquivado, nunca eliminado — podes sempre consultá-lo depois em /encomendas."
      )
    )
      return;
    setFlash(null);
    startTransition(async () => {
      const r = await cancelDraftAction(draftId);
      if (r.ok) {
        setFlash({ type: "info", msg: "Rascunho cancelado." });
        setTimeout(() => router.push("/encomendas"), 800);
      } else {
        setFlash({ type: "err", msg: r.error });
      }
    });
  }

  function handleConflitoCriarCopia() {
    if (!farmaciaId) return;
    setFlash(null);
    startTransition(async () => {
      const r = await duplicarRascunhoComoNovoAction({
        farmaciaId,
        nomeOriginal: nome || `Encomenda ${new Date().toLocaleDateString("pt-PT")}`,
        linhas: linhas.map((l) => ({
          produtoId: l.produtoId,
          quantidadeSugerida: l.suggestedQty ?? null,
          quantidadeAjustada: Number(l.finalQty),
          notas: l.notas.trim() || null,
          origem: l.origem,
        })),
      });
      if (r.ok) {
        window.location.href = `${pathname}?rascunho=${r.novoId}`;
      } else {
        setFlash({ type: "err", msg: r.error });
      }
    });
  }

  // Aviso ao fechar/recarregar o browser — SÓ enquanto houver trabalho
  // que o servidor ainda não confirmou. Duas fontes, nunca sobrepostas:
  // com rascunho activo (`draftId`), `autosave.temAlteracoesPendentes` é
  // a verdade (o MESMO sinal que já governa o beforeunload do ecrã de
  // detalhe — ver `use-autosave-encomenda.ts`); sem rascunho ainda
  // (proposta só em memória, ou modo grupo/consolidação, que não gravam
  // eagerly — ver nota acima), `linhas.length > 0` continua a ser a rede
  // de segurança de sempre.
  const haAlteracoesPorConfirmar = draftId ? autosave.temAlteracoesPendentes : linhas.length > 0;
  useEffect(() => {
    function handler(e: BeforeUnloadEvent) {
      if (!haAlteracoesPorConfirmar) return;
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [haAlteracoesPorConfirmar]);

  // Mesmo sinal espelhado na barra de tarefas.
  useEffect(() => {
    if (pathname) taskBar?.marcarSujo(pathname, haAlteracoesPorConfirmar);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, haAlteracoesPorConfirmar]);

  const isGroupMode = mode === "grupo" || mode === "consolidacao";

  // Farmácias com linhas (para filtro em modo grupo)
  const farmaciaOptions = useMemo(() => {
    if (!isGroupMode) return [];
    const seen = new Set<string>();
    const opts: { id: string; nome: string }[] = [];
    for (const l of linhas) {
      if (l.farmaciaNome && !seen.has(l.farmaciaNome)) {
        seen.add(l.farmaciaNome);
        const f = farmacias.find((fv) => fv.nome === l.farmaciaNome);
        opts.push({ id: f?.id ?? l.farmaciaNome, nome: l.farmaciaNome });
      }
    }
    return opts;
  }, [linhas, isGroupMode, farmacias]);

  // Linhas visíveis após filtros + ordenação
  const visibleLinhas = useMemo(() => {
    let list = linhas;

    const q = tableSearch.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (l) =>
          l.designacao.toLowerCase().includes(q) ||
          String(l.cnp).includes(q) ||
          (l.fabricante?.toLowerCase().includes(q) ?? false)
      );
    }
    if (filterFarmaciaTabela) list = list.filter((l) => l.farmaciaNome === filterFarmaciaTabela);
    if (filterEstado) list = list.filter((l) => l.estado === filterEstado);
    if (filterRuturas) list = list.filter((l) => l.currentStock != null && l.currentStock <= 0);
    if (filterStockBaixo)
      list = list.filter(
        (l) => l.currentStock != null && l.currentStock > 0 && l.suggestedQty != null && l.suggestedQty > 0
      );

    // A ordenação vem DEPOIS dos filtros, sobre a lista já filtrada:
    // o utilizador ordena o que está a ver.
    return ordenarLinhas(list, ordenacao, acessorEncomenda);
  }, [linhas, tableSearch, filterFarmaciaTabela, filterEstado, filterRuturas, filterStockBaixo, ordenacao]);

  // ─── Ponto 2 — consolidação por produto (SÓ modo grupo) ────────────────────
  //
  // `visibleLinhas` já filtrou as `Line` individuais (Ponto 2.4: filtra
  // primeiro, agrupa depois) — agrupar o resultado já filtrado é o que
  // faz um filtro por farmácia esconder só as sub-linhas dessa farmácia
  // dentro de cada grupo (ou o grupo inteiro, se nenhuma sub-linha
  // sobreviver: `agruparPorProduto` simplesmente não cria entrada para
  // um produto sem nenhuma linha de entrada).
  const gruposProduto = useMemo<GrupoProdutoLine[]>(() => {
    if (mode !== "grupo") return [];
    return agruparPorProduto(visibleLinhas);
  }, [mode, visibleLinhas]);

  // ─── Ponto 3 — navegação por teclado: a ordem "visual" das linhas ──────────
  //
  // Em modo grupo a unidade de navegação é a SUB-linha (uma por
  // farmácia dentro de cada bloco de produto), não a `Line` "solta" — daí
  // achatar `gruposProduto` em vez de usar `visibleLinhas` directamente
  // (a ordem resultante é a mesma, só reagrupada produto a produto, que é
  // também a ordem em que a tabela as desenha).
  const linhasNavegaveis = useMemo<Line[]>(() => {
    if (mode === "grupo") return gruposProduto.flatMap((g) => g.subLinhas);
    return visibleLinhas;
  }, [mode, gruposProduto, visibleLinhas]);

  /** `Line.key` → posição na lista navegável — o índice ESTÁVEL que as refs usam (Ponto 3.6). */
  const rowIndexByKey = useMemo(() => {
    const m = new Map<number, number>();
    linhasNavegaveis.forEach((l, i) => m.set(l.key, i));
    return m;
  }, [linhasNavegaveis]);

  // Refs por "campo" (coluna), indexadas pelo índice estável acima — o
  // MESMO padrão de `encomendas-client.tsx` (`inputRefs` + `handleRowKeyNavigation`),
  // estendido para vários campos por linha (célula de Decisão) em vez de um só.
  const acaoRefs = useRef<Array<HTMLSelectElement | null>>([]);
  const encomendaFarmaciaRefs = useRef<Array<HTMLSelectElement | null>>([]);
  const origemFarmaciaRefs = useRef<Array<HTMLSelectElement | null>>([]);
  const destinoFarmaciaRefs = useRef<Array<HTMLSelectElement | null>>([]);
  const finalQtyRefs = useRef<Array<HTMLInputElement | null>>([]);
  const notasRefs = useRef<Array<HTMLInputElement | null>>([]);

  /**
   * A ordem dos campos "operacionais" de UMA linha, para Enter/Shift+Enter
   * (Ponto 3.1/3.2). Fora do modo grupo não há célula de Decisão — só
   * "Final". Em modo grupo: Decisão → (farmácia de encomenda OU
   * origem+destino, conforme a acção) → Final. "Notas" fica de fora
   * deliberadamente — não é um campo operacional/quantidade, é texto
   * livre opcional.
   */
  function ordemCamposLinha(l: Line): CampoSlot[] {
    if (mode !== "grupo") return ["finalQty"];
    const campos: CampoSlot[] = ["acao"];
    if (l.acao === "ENCOMENDAR") campos.push("encomendaFarmacia");
    else if (l.acao === "TRANSFERIR") campos.push("origemFarmacia", "destinoFarmacia");
    campos.push("finalQty");
    return campos;
  }

  function focarCampoSlot(rowIndex: number, slot: CampoSlot): boolean {
    let el: HTMLInputElement | HTMLSelectElement | null = null;
    switch (slot) {
      case "acao": el = acaoRefs.current[rowIndex]; break;
      case "encomendaFarmacia": el = encomendaFarmaciaRefs.current[rowIndex]; break;
      case "origemFarmacia": el = origemFarmaciaRefs.current[rowIndex]; break;
      case "destinoFarmacia": el = destinoFarmaciaRefs.current[rowIndex]; break;
      case "finalQty": el = finalQtyRefs.current[rowIndex]; break;
    }
    if (!el) return false;
    el.focus();
    if (el instanceof HTMLInputElement) el.select();
    return true;
  }

  function registrarCampoRef(
    slot: "acao" | "encomendaFarmacia" | "origemFarmacia" | "destinoFarmacia",
    rowIndex: number,
    el: HTMLSelectElement | null,
  ) {
    if (slot === "acao") acaoRefs.current[rowIndex] = el;
    else if (slot === "encomendaFarmacia") encomendaFarmaciaRefs.current[rowIndex] = el;
    else if (slot === "origemFarmacia") origemFarmaciaRefs.current[rowIndex] = el;
    else destinoFarmaciaRefs.current[rowIndex] = el;
  }

  /**
   * Setas ↑/↓ num `<input>` (Final/Notas): move para o MESMO campo na
   * linha adjacente (Ponto 3.3) — nunca em `<select>` (Ponto 3.7: não
   * capturar setas nos selects, para não quebrar a forma nativa de mudar
   * de opção com o teclado).
   */
  function handleInputVerticalNav(
    e: ReactKeyboardEvent<HTMLInputElement>,
    rowIndex: number,
    refsArr: MutableRefObject<Array<HTMLInputElement | null>>,
  ) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const targetIndex =
      e.key === "ArrowDown"
        ? Math.min(rowIndex + 1, linhasNavegaveis.length - 1)
        : Math.max(rowIndex - 1, 0);
    const el = refsArr.current[targetIndex];
    if (el) { el.focus(); el.select(); }
  }

  /**
   * Enter avança para o próximo campo da cadeia (`ordemCamposLinha`); ao
   * fim da linha, avança para o PRIMEIRO campo da linha seguinte.
   * Shift+Enter faz o inverso (Ponto 3.1/3.2). Usada tanto pelos
   * `<select>` da célula de Decisão como pelo `<input>` Final — nunca
   * chama `preventDefault` fora da tecla Enter, e nunca intercepta Tab.
   */
  function handleCampoEnter(e: ReactKeyboardEvent, rowIndex: number, slot: CampoSlot) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const linha = linhasNavegaveis[rowIndex];
    if (!linha) return;
    const chain = ordemCamposLinha(linha);
    const pos = chain.indexOf(slot);

    if (e.shiftKey) {
      if (pos > 0) { focarCampoSlot(rowIndex, chain[pos - 1]); return; }
      const prevLinha = linhasNavegaveis[rowIndex - 1];
      if (prevLinha) {
        const prevChain = ordemCamposLinha(prevLinha);
        focarCampoSlot(rowIndex - 1, prevChain[prevChain.length - 1]);
      }
      return;
    }

    if (pos < chain.length - 1) { focarCampoSlot(rowIndex, chain[pos + 1]); return; }
    const nextLinha = linhasNavegaveis[rowIndex + 1];
    if (nextLinha) {
      const nextChain = ordemCamposLinha(nextLinha);
      focarCampoSlot(rowIndex + 1, nextChain[0]);
    }
  }

  // ─── Ponto 1 — histórico de 12 meses em lote, sempre visível ───────────────
  //
  // Carregado UMA vez (paginado por chunk se a proposta for grande) quando
  // o CONJUNTO de produtos muda — nunca a cada keystroke de filtro/pesquisa
  // (por isso a dependência é `linhas`, não `visibleLinhas`), e nunca um
  // pedido por linha (ver `getHistoricoProdutosLoteAction`).
  const produtoIdsParaHistorico = useMemo(
    () => [...new Set(linhas.map((l) => l.produtoId))].sort(),
    [linhas],
  );
  const farmaciaIdsParaHistorico = useMemo(() => {
    const set = new Set<string>();
    for (const l of linhas) if (l.farmaciaId) set.add(l.farmaciaId);
    // Fallback: modo "farmacia" antes de gerar proposta (linhas manuais
    // ainda sem `farmaciaId` preenchido não deveria acontecer, mas não
    // custa nada ser defensivo aqui).
    if (set.size === 0 && farmaciaId) set.add(farmaciaId);
    return [...set].sort();
  }, [linhas, farmaciaId]);
  /**
   * Chave de CONTEÚDO, não de referência.
   *
   * `produtoIdsParaHistorico`/`farmaciaIdsParaHistorico` são arrays NOVOS
   * a cada render em que `linhas` muda de referência — e `linhas` muda de
   * referência em QUALQUER edição de campo (`updateLine` faz
   * `setLinhas((prev) => prev.map(...))`), incluindo escrever num único
   * dígito da quantidade final. Antes desta correcção (2026-09), o efeito
   * abaixo dependia directamente do array `produtoIdsParaHistorico` — como
   * um array novo nunca é `Object.is`-igual ao anterior mesmo com o MESMO
   * conteúdo, o efeito recarregava o lote inteiro de histórico (todos os
   * produtos × farmácias, em chunks de 150, sequenciais) a cada tecla
   * premida em qualquer input da tabela. A chave de string abaixo só muda
   * de VALOR quando o conjunto de produtos ou de farmácias realmente
   * muda — nunca por causa de uma edição de quantidade/notas/decisão.
   */
  const chaveHistorico = `${produtoIdsParaHistorico.join(",")}::${farmaciaIdsParaHistorico.join(",")}`;
  const [historicoPorProduto, setHistoricoPorProduto] = useState<Map<string, HistoricoProduto12MesesResult>>(
    new Map(),
  );
  const [historicoCarregando, setHistoricoCarregando] = useState(false);

  useEffect(() => {
    if (produtoIdsParaHistorico.length === 0 || farmaciaIdsParaHistorico.length === 0) {
      setHistoricoPorProduto(new Map());
      return;
    }

    let cancelled = false;
    setHistoricoCarregando(true);

    const CHUNK = 150;
    const chunks: string[][] = [];
    for (let i = 0; i < produtoIdsParaHistorico.length; i += CHUNK) {
      chunks.push(produtoIdsParaHistorico.slice(i, i + CHUNK));
    }

    (async () => {
      const acumulado = new Map<string, HistoricoProduto12MesesResult>();
      // Chunks em paralelo — já não há razão para serializar: cada chunk
      // é uma chamada independente à mesma server action, e o único
      // motivo para existirem chunks é o limite prático de parâmetros
      // de uma única query `ANY(...)`, não concorrência de escrita.
      const resultados = await Promise.all(
        chunks.map((chunk) =>
          getHistoricoProdutosLoteAction({ produtoIds: chunk, farmaciaIds: farmaciaIdsParaHistorico }),
        ),
      );
      if (cancelled) return;
      for (const r of resultados) {
        if (r.ok) {
          for (const [pid, data] of Object.entries(r.data)) acumulado.set(pid, data);
        }
      }
      if (!cancelled) {
        setHistoricoPorProduto(acumulado);
        setHistoricoCarregando(false);
      }
    })();

    return () => { cancelled = true; };
    // Depende só da CHAVE de conteúdo (ver comentário acima) — os arrays
    // em si são recriados a cada render, mas isso já não dispara o
    // efeito. `chaveHistorico` já incorpora tudo o que os arrays trariam.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chaveHistorico]);

  // Vista consolidada (agrupada por produto)
  const consolidadoRows = useMemo(() => {
    if (mode !== "consolidacao") return [];
    const byProduct = new Map<
      string,
      {
        produtoId: string; cnp: number; designacao: string; fabricante: string | null;
        totalFinalQty: number;
        estadoPriority: ProposalEstado;
        farmaciaLinhas: Line[];
      }
    >();
    const priority: Record<ProposalEstado, number> = {
      COMPRAR: 4, TRANSFERÊNCIA: 3, AGUARDAR: 2, ADEQUADO: 1,
    };
    for (const l of linhas) {
      const k = l.produtoId;
      if (!byProduct.has(k)) {
        byProduct.set(k, {
          produtoId: l.produtoId, cnp: l.cnp, designacao: l.designacao,
          fabricante: l.fabricante, totalFinalQty: 0,
          estadoPriority: l.estado ?? "ADEQUADO", farmaciaLinhas: [],
        });
      }
      const g = byProduct.get(k)!;
      g.totalFinalQty += Number(l.finalQty || "0") || 0;
      g.farmaciaLinhas.push(l);
      const ep = l.estado ? priority[l.estado] : 0;
      const gp = priority[g.estadoPriority];
      if (ep > gp) g.estadoPriority = l.estado ?? g.estadoPriority;
    }
    return [...byProduct.values()].sort(
      (a, b) =>
        (priority[b.estadoPriority] ?? 0) - (priority[a.estadoPriority] ?? 0) ||
        b.totalFinalQty - a.totalFinalQty
    );
  }, [linhas, mode]);

  // ─── Bloco D — resumo por balde (modo grupo) ───────────────────────────────
  //
  // `finalQty` é o ÚNICO campo de quantidade da linha (ver `Line`): para
  // ENCOMENDAR é a quantidade a comprar, para TRANSFERIR a quantidade a
  // transferir. `linhaParaDecisao` traduz a `Line` do ecrã para o
  // `DecisaoLinha` puro que `calcularResumoGrupo`/`agruparParaGeracao`
  // conhecem — a mesma fronteira que já existe para `origem-linha.ts`.
  function linhaParaDecisao(l: Line): DecisaoLinha {
    const qty = Number(l.finalQty) || 0;
    return {
      produtoId: l.produtoId,
      acao: l.acao,
      acaoTocada: l.acaoTocada,
      farmaciaEncomendaId: l.farmaciaEncomendaId,
      quantidadeFinal: qty,
      farmaciaOrigemId: l.farmaciaOrigemId,
      farmaciaDestinoId: l.farmaciaDestinoId,
      quantidadeTransferir: qty,
    };
  }

  function nomeFarmacia(id: string): string {
    return farmacias.find((f) => f.id === id)?.nome ?? id;
  }

  const resumoGrupoAtual = useMemo(() => {
    if (mode !== "grupo") return null;
    return calcularResumoGrupo(linhas.map(linhaParaDecisao));
  }, [linhas, mode]);

  function handleGerarPlano() {
    setFlash(null);
    setPlanoResultado(null);

    const decisoes: DecisaoLinhaGrupoInput[] = linhas.map((l) => ({
      ...linhaParaDecisao(l),
      quantidadeSugerida: l.suggestedQty,
      notas: l.notas.trim() || null,
      origem: l.origem,
    }));

    const resumo = calcularResumoGrupo(decisoes);
    if (resumo.encomendas.length === 0 && resumo.transferencias.length === 0) {
      setFlash({
        type: "err",
        msg: 'Sem linhas accionáveis — todas as decisões são "Não fazer" ou têm quantidade 0.',
      });
      return;
    }

    startGerarPlano(async () => {
      const result = await gerarPlanoGrupoAction({
        nome: nome.trim() || `Grupo ${new Date().toLocaleDateString("pt-PT")}`,
        decisoes,
        contexto: serializarPropostaContexto(buildContextoActual()) ?? null,
      });
      if (!result.ok) {
        setFlash({ type: "err", msg: result.error });
        return;
      }
      setPlanoResultado(result);
      const partes: string[] = [];
      if (result.listasEncomenda.length > 0) partes.push(`${result.listasEncomenda.length} encomenda(s)`);
      if (result.transferencias.length > 0) partes.push(`${result.transferencias.length} transferência(s)`);
      setFlash({ type: "ok", msg: `Gerado: ${partes.join(" · ")}.` });
      setLinhas([]);
      setHasProposal(false);
      setProposalMeta(null);
    });
  }

  // ─── Prefill (vindo do Relatório de Vendas) ────────────────────────────────
  //
  // Vendas não calcula sugestões — só entrega o universo de CNP e os
  // parâmetros da chamada. Este efeito faz exactamente o que o botão
  // "Gerar proposta" faria manualmente: chama `generateProposalAction`
  // com `filters.cnps` fechado, e o cálculo é sempre o mesmo motor.
  //
  // Ver `lib/encomendas/prefill-from-vendas.ts` para o contrato do
  // payload e o porquê de já não haver formato antigo a suportar.
  useEffect(() => {
    if (searchParams.get("prefill") !== "1") return;
    if (typeof window === "undefined") return;
    const raw = window.sessionStorage.getItem(ENCOMENDA_PREFILL_STORAGE_KEY);
    if (!raw) return;
    window.sessionStorage.removeItem(ENCOMENDA_PREFILL_STORAGE_KEY);

    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return; }
    const payload = parseEncomendaPrefillPayload(parsed);
    if (!payload) {
      setFlash({ type: "err", msg: "Pré-preenchimento de Vendas inválido ou incompleto." });
      return;
    }

    // Rede de segurança: Vendas já desactiva o botão para quem não tem
    // perfil de grupo, mas a acção do lado do servidor também recusa
    // — aqui só se evita a chamada e a mensagem confusa que ela daria.
    if (payload.mode === "grupo" && !canGroupMode) {
      setFlash({ type: "err", msg: "Sem permissão para vista de grupo." });
      return;
    }

    if (payload.mode === "farmacia") {
      if (!payload.farmaciaId || !farmaciasVisiveis.some((f) => f.id === payload.farmaciaId)) {
        setFlash({ type: "err", msg: "Farmácia do relatório de Vendas não encontrada." });
        return;
      }
      setFarmaciaId(payload.farmaciaId);
    }
    setMode(payload.mode);
    setStartDate(payload.startDate.slice(0, 10));
    setEndDate(payload.endDate.slice(0, 10));
    setConsiderStock(payload.considerStock);
    setBaseRule(payload.baseRule);
    setCoverageDays(payload.targetCoverageDays);

    startGenerate(async () => {
      const result = await generateProposalAction({
        mode: payload.mode,
        farmaciaId: payload.mode === "farmacia" ? payload.farmaciaId : undefined,
        startDate: payload.startDate,
        endDate: payload.endDate,
        considerStock: payload.considerStock,
        baseRule: payload.baseRule,
        targetCoverageDays: payload.targetCoverageDays,
        filters: { cnps: payload.cnps },
      });
      if (!result.ok) {
        setFlash({ type: "err", msg: result.error });
        return;
      }

      // Universo FECHADO vindo de Vendas: todos os produtos entram,
      // mesmo os que a proposta calcula a 0 — a mesma regra de "com
      // lista importada" em `handleGenerate` (ver comentário lá).
      //
      // `payload.mode` e não o `mode` do estado: este efeito só corre
      // UMA vez (dependências `[]`), e `setMode(payload.mode)` acima
      // ainda não repintou quando este `map` corre — o `mode` capturado
      // no fecho seria sempre o valor inicial ("farmacia").
      const novas = result.data.rows.map((r) => buildProposalLine(r, payload.mode));
      setLinhas(novas);
      setHasProposal(true);
      setProposalMeta({
        numDays: result.data.meta.numDays,
        stats: result.data.meta.stats,
        truncated: result.data.meta.truncated,
        cnpsNaLista: result.data.meta.cnpsNaLista,
        comVendas: new Set(result.data.rows.map((r) => r.cnp)).size,
        listaImportada: result.data.meta.listaImportada,
      });
      setFlash({
        type: "info",
        msg: `${novas.length} produto(s) do Relatório de Vendas · ${result.data.meta.numDays} dias de histórico · cobertura pedida: ${payload.targetCoverageDays} dias.`,
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Builders de linha ────────────────────────────────────────────────────

  function buildProposalLine(r: ProposalRow, modoAtual: ProposalMode): Line {
    const decisao = sugerirDecisao({
      farmaciaId: r.farmaciaId,
      estado: r.estado,
      suggestedQty: r.suggestedQty,
      transferirQty: r.transferirQty,
      excessoFonte: r.excessoFonte,
    });
    // A quantidade final do "Final" só acompanha a decisão em modo
    // GRUPO — é lá que existe a coluna "Decisão" e é lá que TRANSFERIR
    // precisa de uma quantidade não-zero nesse campo partilhado (ver
    // `Line`). Em "farmacia"/"consolidação" mantém-se EXACTAMENTE o
    // comportamento de sempre: TRANSFERÊNCIA (só possível vinda de
    // `generateGroupProposal`, usada em "consolidação") continua a
    // nascer com Final=0, porque esses modos não têm nenhum sítio que
    // leia `acao`/`farmaciaOrigemId` — mudar o default ali reintroduzia
    // silenciosamente uma linha de compra onde antes não entrava.
    const finalQtyPadrao =
      modoAtual === "grupo"
        ? decisao.acao === "TRANSFERIR"
          ? decisao.quantidadeTransferir
          : decisao.acao === "ENCOMENDAR"
            ? decisao.quantidadeFinal
            : 0
        : r.estado === "TRANSFERÊNCIA"
          ? 0
          : r.suggestedQty;
    return {
      key: nextKey(), produtoId: r.produtoId, cnp: r.cnp, designacao: r.designacao,
      fabricante: r.fabricante, fornecedor: r.fornecedor,
      farmaciaNome: r.farmaciaNome, farmaciaId: r.farmaciaId,
      salesQty: r.salesQty, avgDailySales: r.avgDailySales,
      currentStock: r.currentStock, coberturaAtualDias: r.coberturaAtualDias,
      pendingQty: r.pendingQty, suggestedQty: r.suggestedQty,
      transferirQty: r.transferirQty,
      finalQty: String(finalQtyPadrao),
      notas: "", origem: "PROPOSTA",
      estado: r.estado, motivo: r.motivo, excessoFonte: r.excessoFonte,
      semVendasNoPeriodo: r.semVendasNoPeriodo,
      dadosDesactualizados: false,
      acao: decisao.acao,
      acaoTocada: false,
      farmaciaEncomendaId: decisao.farmaciaEncomendaId,
      farmaciaOrigemId: decisao.farmaciaOrigemId,
      farmaciaDestinoId: decisao.farmaciaDestinoId,
    };
  }

  function buildManualLine(p: ProductSearchResult): Line {
    return {
      key: nextKey(), produtoId: p.id, cnp: p.cnp, designacao: p.designacao,
      fabricante: p.fabricante, fornecedor: null,
      farmaciaNome: isGroupMode ? null : (farmaciasVisiveis.find((f) => f.id === farmaciaId)?.nome ?? null),
      farmaciaId: isGroupMode ? null : farmaciaId,
      salesQty: null, avgDailySales: null, currentStock: p.stockAtual,
      coberturaAtualDias: null, pendingQty: null, suggestedQty: null,
      transferirQty: 0, finalQty: "1", notas: "",
      origem: "MANUAL", estado: null, motivo: null, excessoFonte: [],
      // Linha posta a mao: a nocao de "vendeu no periodo" nao se
      // aplica — nao veio de nenhum calculo sobre vendas.
      semVendasNoPeriodo: false,
      dadosDesactualizados: false,
      // O picker manual só existe em modo "farmacia" — estes campos
      // nunca são lidos aí, mas o tipo `Line` é partilhado por todos
      // os modos.
      acao: "NAO_FAZER", acaoTocada: false,
      farmaciaEncomendaId: isGroupMode ? null : farmaciaId,
      farmaciaOrigemId: null, farmaciaDestinoId: null,
    };
  }

  /**
   * Reconstrói uma `Line` a partir de uma linha PERSISTIDA (rascunho
   * retomado). As colunas "decididas" (quantidade final, notas, origem,
   * sugerida — snapshot gravado quando a linha nasceu) vêm tal e qual do
   * servidor; stock vem ACTUAL (mesmo campo que `order-detail-client.tsx`
   * mostra). As colunas só-de-análise da proposta (vendas médias,
   * cobertura, pendente, estado, motivo) ficam neutras — ver o
   * comentário em `carregarRascunhoNovaEncomendaAction`.
   */
  function buildLineFromRascunho(l: RascunhoNovaEncomenda["linhas"][number], farmId: string): Line {
    return {
      key: nextKey(), produtoId: l.produtoId, cnp: l.cnp, designacao: l.designacao,
      fabricante: l.fabricante, fornecedor: l.fornecedor,
      farmaciaNome: farmaciasVisiveis.find((f) => f.id === farmId)?.nome ?? null,
      farmaciaId: farmId,
      salesQty: null, avgDailySales: null, currentStock: l.currentStock,
      coberturaAtualDias: null, pendingQty: null, suggestedQty: l.quantidadeSugerida,
      transferirQty: 0, finalQty: String(l.quantidadeAjustada ?? 0), notas: l.notas ?? "",
      origem: l.origem, estado: null, motivo: null, excessoFonte: [],
      semVendasNoPeriodo: false,
      dadosDesactualizados: true,
      acao: "NAO_FAZER", acaoTocada: false,
      farmaciaEncomendaId: farmId, farmaciaOrigemId: null, farmaciaDestinoId: null,
    };
  }

  // ─── Retomar rascunho (?rascunho=<id>) ──────────────────────────────────
  //
  // Reload da página, ou o MESMO link aberto noutro computador — ambos
  // passam por aqui. Corre uma única vez ao montar (StrictMode chamaria
  // o efeito 2x em dev; `rascunhoCarregadoRef` evita um 2º pedido/uma 2ª
  // reconstrução a competir com a 1ª).
  useEffect(() => {
    const rascunhoId = searchParams.get("rascunho");
    if (!rascunhoId || rascunhoCarregadoRef.current) return;
    rascunhoCarregadoRef.current = true;
    setCarregandoRascunho(true);
    (async () => {
      const r = await carregarRascunhoNovaEncomendaAction(rascunhoId);
      if (!r.ok) {
        setFlash({ type: "err", msg: r.error });
        setCarregandoRascunho(false);
        return;
      }
      const d = r.data;
      setDraftId(d.listaEncomendaId);
      setDraftVersaoInicial(d.versao);
      setNome(d.nome);
      setFarmaciaId(d.farmaciaId);
      if (d.contexto) {
        setMode(d.contexto.mode);
        setStartDate(d.contexto.startDate);
        setEndDate(d.contexto.endDate);
        setConsiderStock(d.contexto.considerStock);
        setBaseRule(d.contexto.baseRule as ProposalBaseRule);
        setCoverageDays(d.contexto.coverageDays);
        setSelFabricantes(d.contexto.filters.fabricantes);
        setSelFornecedores(d.contexto.filters.fornecedores);
        setSelCategorias(d.contexto.filters.categorias);
        setSelSubcategorias(d.contexto.filters.subcategorias);
        setSelUtilizacoes(d.contexto.filters.utilizacoes);
        setSelProductTypes(d.contexto.filters.productTypes);
      }
      const persistidas = d.linhas.map((l) => buildLineFromRascunho(l, d.farmaciaId));
      setLinhas(persistidas);
      setHasProposal(d.linhas.length > 0);

      // Recalcula SÓ as colunas informativas a partir do contexto guardado
      // (modo farmácia) — quantidades/notas/origem persistidas nunca são
      // tocadas (enriquecerLinhasRascunho). Se falhar, as linhas ficam
      // marcadas como desactualizadas e o rascunho continua utilizável.
      let enriquecido = false;
      const c = d.contexto;
      if (c && c.mode === "farmacia" && persistidas.length > 0) {
        try {
          const fresca = await generateProposalAction({
            mode: "farmacia",
            farmaciaId: d.farmaciaId,
            startDate: c.startDate,
            endDate: c.endDate,
            considerStock: c.considerStock,
            baseRule: c.baseRule as ProposalBaseRule,
            targetCoverageDays: c.coverageDays,
            filters: {
              fabricantes: c.filters.fabricantes,
              fornecedores: c.filters.fornecedores,
              categorias: c.filters.categorias,
              subcategorias: c.filters.subcategorias,
              utilizacoes: c.filters.utilizacoes,
              productTypes: c.filters.productTypes,
              // Universo = as linhas persistidas: garante que cada uma tem
              // a sua linha fresca independentemente dos filtros.
              cnps: persistidas.map((l) => l.cnp),
            },
          });
          if (fresca.ok) {
            setLinhas(enriquecerLinhasRascunho(persistidas, fresca.data.rows));
            enriquecido = true;
          }
        } catch {
          // mantém as linhas persistidas, marcadas como desactualizadas
        }
      }
      setFlash({
        type: "info",
        msg: enriquecido
          ? `Rascunho retomado — ${d.linhas.length} linha(s); vendas/stock/cobertura recalculados, quantidades e notas preservadas.`
          : `Rascunho retomado — ${d.linhas.length} linha(s). Não foi possível recalcular vendas/cobertura/stock; as quantidades estão intactas.`,
      });
      setCarregandoRascunho(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Acções ───────────────────────────────────────────────────────────────

  /**
   * Abandona a REFERÊNCIA local a um rascunho (mudar de modo/farmácia
   * nunca deve continuar a escrever no rascunho da farmácia/modo
   * ANTERIOR). O rascunho em si não é tocado — continua na base de
   * dados, e aparece na lista de rascunhos de `/encomendas` para quem o
   * quiser retomar; só deixa de estar associado a ESTA sessão do ecrã.
   * `resolverConflitoActualizar` já faz exactamente o "descarta
   * pendentes locais, volta a limpo" que isto precisa — reutilizado em
   * vez de duplicado.
   */
  function abandonarRascunhoLocal() {
    if (!draftId) return;
    autosave.resolverConflitoActualizar();
    setDraftId(null);
    setDraftVersaoInicial(0);
    pedidoCongeladoRef.current = null; // nova sessão de rascunho → nova chave
    pendentesPosCriacaoRef.current = [];
    const params = new URLSearchParams(searchParams.toString());
    if (params.has("rascunho")) {
      params.delete("rascunho");
      const query = params.toString();
      window.history.replaceState(window.history.state, "", query ? `${pathname}?${query}` : pathname);
    }
  }

  function handleModeChange(next: ProposalMode) {
    if (next === mode) return;
    if (linhas.length > 0 && !window.confirm("Mudar de modo limpa as linhas actuais. Continuar?"))
      return;
    abandonarRascunhoLocal();
    setLinhas([]);
    setHasProposal(false);
    setProposalMeta(null);
    setFilterEstado(null);
    setMode(next);
  }

  function handleFarmaciaChange(nextId: string) {
    if (nextId === farmaciaId) return;
    if (linhas.length > 0 && !window.confirm("Mudar de farmácia limpa as linhas actuais. Continuar?")) return;
    abandonarRascunhoLocal();
    setLinhas([]);
    setHasProposal(false);
    setProposalMeta(null);
    setFarmaciaId(nextId);
  }


  function handleGenerate() {
    setFlash(null);
    if (mode === "farmacia" && !farmaciaId) {
      setFlash({ type: "err", msg: "Seleccione uma farmácia." });
      return;
    }
    // O aviso só faz sentido quando há mesmo algo a perder: as linhas
    // de PROPOSTA. As manuais e as de sugestão sobrevivem, e avisar que
    // vão ser substituídas quando não vão ensina a ignorar o aviso.
    const descartaveis = linhas.filter((l) => !sobreviveARecalculo(l.origem)).length;
    if (
      descartaveis > 0 &&
      !window.confirm(
        `Gerar nova proposta substitui ${descartaveis} linha(s) calculada(s). ` +
          `As linhas manuais são preservadas. Continuar?`,
      )
    )
      return;

    const commonInput = {
      mode,
      farmaciaId: mode === "farmacia" ? farmaciaId : undefined,
      startDate, endDate, considerStock, baseRule,
      targetCoverageDays: coverageDays,
      filters: {
        fabricantes: selFabricantes, fornecedores: selFornecedores,
        categorias: selCategorias, subcategorias: selSubcategorias,
        utilizacoes: selUtilizacoes, productTypes: selProductTypes,
        // `undefined` sem lista; o array (mesmo vazio) com lista.
        cnps: listaCodigos ? listaCodigos.cnps : undefined,
      },
    };

    startGenerate(async () => {
      const result = await generateProposalAction(commonInput);
      if (!result.ok) { setFlash({ type: "err", msg: result.error }); return; }

      // ── Quem entra na encomenda ──────────────────────────────────
      //
      // Sem lista, mantém-se o de sempre: as linhas ADEQUADAS não
      // aparecem, porque a proposta automática só propõe o que há a
      // fazer e uma lista de 3 000 artigos «já está bem» não é uma
      // encomenda.
      //
      // COM lista, todas entram. O utilizador nomeou os artigos um a
      // um; escondê-los porque o cálculo deu zero é exactamente o
      // «desaparecer em silêncio» — ele contou 1 210 e viu 940, sem
      // nada no ecrã a explicar os 270. Entram com quantidade 0,
      // prontos a ser ajustados à mão.
      const temLista = listaCodigos !== null;
      const novas = result.data.rows
        .filter((r) => temLista || r.estado !== "ADEQUADO" || !considerStock)
        .map((r) => buildProposalLine(r, mode));

      // ── O recálculo NÃO destrói o que foi decidido à mão ──────────
      //
      // Isto era `setLinhas(novas)`. Tudo o que o utilizador tinha
      // acrescentado desaparecia — e a linha manual é, por construção,
      // a que ele mais pensou: foi escolhida uma a uma, contra a
      // recomendação do cálculo. Havia um `confirm()` a avisar, mas
      // avisar de uma perda não é o mesmo que não a causar.
      //
      // A regra vive em `lib/encomendas/origem-linha.ts`, onde é
      // testável sem montar um DOM.
      const fusao = fundirComProposta(linhas, novas);

      // ── E também não apaga a decisão ENCOMENDAR/TRANSFERIR/NÃO FAZER ──
      //
      // `fundirComProposta` preserva a linha INTEIRA quando a origem é
      // MANUAL/SUGESTAO — a decisão já vem intacta com ela. O que falta
      // é o caso da linha PROPOSTA: essa é sempre substituída pela nova
      // (para reflectir stock/excesso actualizados), e sem isto a
      // decisão que o utilizador tinha tomado à mão para ela
      // desapareceria a cada "Gerar nova proposta". Mesmo espírito de
      // `sobreviveARecalculo`, um nível abaixo — ver
      // `lib/encomendas/decisao-grupo.ts`.
      const linhasComDecisao = fundirDecisoesGrupo(fusao.linhas, mapaDecisoes(linhas));
      setLinhas(linhasComDecisao);
      setHasProposal(true);

      // ── Rascunho eager (Bloqueador 1, só mode === "farmacia") ─────
      //
      // Uma proposta gerada É o "primeiro evento significativo" — se
      // ainda não há rascunho, cria-se AGORA, com TODAS as linhas de uma
      // vez (300 produtos = 1 `createOrderAction`, nunca 300 pedidos).
      // Se já existe, sincroniza as linhas PROPOSTA novas/actualizadas e
      // as que saíram do recálculo — reusa sempre o MESMO autosave.
      if (mode === "farmacia") {
        if (!draftId) {
          void ensureDraft(linhasComDecisao);
        } else {
          const idsAntes = new Set(linhas.filter((l) => l.origem === "PROPOSTA").map((l) => l.produtoId));
          const idsDepois = new Set(linhasComDecisao.map((l) => l.produtoId));
          for (const id of idsAntes) {
            if (!idsDepois.has(id)) autosave.marcarRemovido(id);
          }
          for (const l of linhasComDecisao) {
            if (l.origem !== "PROPOSTA") continue; // manuais/sugestão preservadas: valores já gravados, não mudaram
            autosave.marcarSujo(l.produtoId, {
              quantidadeSugerida: l.suggestedQty ?? null,
              quantidadeAjustada: Number(l.finalQty),
              origem: "PROPOSTA",
            });
          }
          const contextoSerializado = serializarPropostaContexto(buildContextoActual());
          if (contextoSerializado !== undefined) autosave.marcarContexto(contextoSerializado);
        }
      }
      setProposalMeta({
        numDays: result.data.meta.numDays,
        stats: result.data.meta.stats,
        truncated: result.data.meta.truncated,
        cnpsNaLista: result.data.meta.cnpsNaLista,
        // Produtos distintos: em modo grupo a mesma referência aparece
        // uma vez por farmácia, e contar linhas dizia "360 de 437" para
        // 120 artigos em três farmácias.
        comVendas: new Set(result.data.rows.map((r) => r.cnp)).size,
        listaImportada: result.data.meta.listaImportada,
      });
      setFilterEstado(null);
      setFilterFarmaciaTabela("");

      const { stats } = result.data.meta;
      const parts: string[] = [];
      if (fusao.preservadas > 0) {
        parts.push(`${fusao.preservadas} linha(s) manuais preservadas`);
      }
      if (fusao.propostasIgnoradas > 0) {
        // O utilizador tem de saber que o cálculo propôs algo para um
        // artigo que ele já tinha decidido — e que a decisão dele ficou.
        parts.push(`${fusao.propostasIgnoradas} proposta(s) ignorada(s) por já haver linha manual`);
      }
      if (stats.comprar > 0) parts.push(`${stats.comprar} a comprar`);
      if (stats.transferencia > 0) parts.push(`${stats.transferencia} transferências`);
      if (stats.aguardar > 0) parts.push(`${stats.aguardar} aguardar`);
      setFlash({
        type: "info",
        msg: `${fusao.linhas.length} linhas · ${result.data.meta.numDays} dias${parts.length ? " · " + parts.join(" · ") : ""}`,
      });
    });
  }

  function handlePickManual(p: ProductSearchResult) {
    const existing = linhas.findIndex((l) => l.produtoId === p.id);
    let novaLista: Line[];
    let linhaAfectada: Line;
    if (existing >= 0) {
      // ── Já lá está: soma, não duplica ────────────────────────────
      //
      // `@@unique([listaEncomendaId, produtoId])` recusaria a gravação
      // de duas linhas do mesmo produto, e o utilizador veria um erro
      // de base de dados em vez de uma tabela coerente. Aqui a regra é
      // a mesma, uma camada acima.
      //
      // E a linha passa a MANUAL. Escolher um produto no picker que já
      // está na proposta é dizer «este quero eu» — a partir daí a
      // decisão é dele e tem de sobreviver a um recálculo.
      //
      // Editar a quantidade no input NÃO promove: isso é ajustar a
      // proposta, e se cada ajuste tornasse a linha manual, uma
      // passagem de revisão deixava «recalcular» sem nada para fazer.
      novaLista = linhas.map((l, i) =>
        i !== existing
          ? l
          : {
              ...l,
              finalQty: String((Number(l.finalQty || "0") || 0) + 1),
              origem: "MANUAL" as OrigemLinha,
            }
      );
      linhaAfectada = novaLista[existing];
    } else {
      const nova = buildManualLine(p);
      novaLista = [...linhas, nova];
      linhaAfectada = nova;
    }
    setLinhas(novaLista);
    if (mode === "farmacia") {
      void persistLineChange(
        linhaAfectada.produtoId,
        { quantidadeAjustada: Number(linhaAfectada.finalQty), origem: "MANUAL" },
        novaLista
      );
    }
  }

  function updateLine(key: number, patch: Partial<Line>) {
    setLinhas((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function removeLine(key: number) {
    setLinhas((prev) => prev.filter((l) => l.key !== key));
  }

  /**
   * Wrappers de `updateLine`/`removeLine` para os campos operacionais da
   * linha (quantidade final, notas, remover) — chamam `persistLineChange`/
   * `persistLineRemoval` a seguir, que só agem em `mode === "farmacia"`
   * (no-op nos outros modos, sem qualquer novo caminho de gravação).
   */
  function handleFinalQtyChange(l: Line, value: string) {
    updateLine(l.key, { finalQty: value });
    if (mode !== "farmacia") return;
    const n = Number(value || "0");
    const linhasActuais = linhas.map((x) => (x.key === l.key ? { ...x, finalQty: value } : x));
    void persistLineChange(l.produtoId, { quantidadeAjustada: Number.isFinite(n) ? n : 0 }, linhasActuais);
  }

  function handleNotasFieldChange(l: Line, value: string) {
    updateLine(l.key, { notas: value });
    if (mode !== "farmacia") return;
    const linhasActuais = linhas.map((x) => (x.key === l.key ? { ...x, notas: value } : x));
    void persistLineChange(l.produtoId, { notas: value.trim() || null }, linhasActuais);
  }

  function handleRemoveLine(l: Line) {
    removeLine(l.key);
    if (mode === "farmacia") persistLineRemoval(l.produtoId);
  }

  function submit(finalize: boolean) {
    setFlash(null);
    const validLines = linhas.filter((l) => {
      const q = Number(l.finalQty || "0");
      return Number.isFinite(q) && q > 0;
    });
    if (validLines.length === 0) {
      setFlash({ type: "err", msg: "Sem linhas com quantidade > 0." });
      return;
    }

    if (mode === "consolidacao") {
      // Cria uma ListaEncomenda por farmácia
      const byFarmacia = new Map<string, Line[]>();
      for (const l of validLines) {
        const fId = l.farmaciaId ?? "";
        if (!fId) continue;
        if (!byFarmacia.has(fId)) byFarmacia.set(fId, []);
        byFarmacia.get(fId)!.push(l);
      }
      if (byFarmacia.size === 0) {
        setFlash({ type: "err", msg: "Sem farmácias identificadas nas linhas." });
        return;
      }

      // Lote ÚNICO, uma só transacção no servidor (tudo ou nada). A chave
      // do lote é estável entre retries do MESMO payload (retry idempotente,
      // sem duplicar); se o utilizador editou linhas desde a tentativa
      // anterior a impressão muda e nasce uma chave NOVA — a operação nova
      // reflecte sempre as edições (nunca se devolve o lote antigo).
      // Como a criação é atómica, uma tentativa falhada nunca deixa
      // encomendas parciais que a chave nova pudesse duplicar.
      const nomeLote = (nome.trim() || `Grupo ${new Date().toLocaleDateString("pt-PT")}`).slice(0, 180);
      const lotes = [...byFarmacia.entries()]
        .sort(([x], [y]) => (x < y ? -1 : 1))
        .map(([fId, fLinhas]) => ({
          farmaciaId: fId,
          linhas: [...fLinhas]
            .sort((x, y) => (x.produtoId < y.produtoId ? -1 : 1))
            .map((l) => ({
              produtoId: l.produtoId,
              quantidadeSugerida: l.suggestedQty ?? null,
              quantidadeAjustada: Number(l.finalQty),
              notas: l.notas.trim() || null,
              origem: l.origem,
            })),
        }));
      const contextoConsolidacao = serializarPropostaContexto(buildContextoActual()) ?? null;
      const impressao = JSON.stringify([nomeLote, finalize, contextoConsolidacao, lotes]);
      if (!loteConsolidacaoRef.current || loteConsolidacaoRef.current.impressao !== impressao) {
        loteConsolidacaoRef.current = { chave: crypto.randomUUID().replace(/-/g, ""), impressao };
      }
      const chaveLote = loteConsolidacaoRef.current.chave;
      startTransition(async () => {
        const r = await createConsolidatedOrdersAction({
          batchKey: chaveLote,
          nome: nomeLote,
          finalize,
          contexto: contextoConsolidacao,
          lotes,
        });
        if (!r.ok) {
          if (r.code === "IDEMPOTENCY_CONFLICT") loteConsolidacaoRef.current = null;
          setFlash({ type: "err", msg: `Consolidação não criada (nada foi gravado): ${r.error}` });
          return;
        }
        loteConsolidacaoRef.current = null;
        setFlash({ type: "ok", msg: `${r.listas.length} encomenda(s) criadas.` });
        setLinhas([]);
        setHasProposal(false);
        setProposalMeta(null);
        setTimeout(() => router.push("/encomendas"), 800);
      });
    } else {
      // Só "farmacia" chega aqui (o botão não existe em modo "grupo" —
      // ver a secção "GUARDAR / FINALIZAR" mais abaixo). Desde que o
      // rascunho passou a nascer eagerly (1º evento significativo, ver
      // `ensureDraft`), este botão raramente cria — normalmente o
      // rascunho já existe e isto é só "força a gravação + confirma",
      // exactamente como o "Guardar agora" do ecrã de detalhe. Fica no
      // MESMO ecrã (`/encomendas/nova?rascunho=<id>`) em vez de navegar
      // para `/encomendas/nova` de novo — nunca dois rascunhos para a
      // mesma sessão.
      startTransition(async () => {
        const id = draftId ?? (await ensureDraft(validLines));
        if (!id) {
          setFlash({ type: "err", msg: "Não foi possível criar o rascunho — verifica a farmácia seleccionada." });
          return;
        }
        const gravado = await autosave.flushSincrono();
        if (!gravado) {
          setFlash({
            type: "err",
            msg: "Não foi possível gravar as últimas alterações — tenta novamente antes de continuar.",
          });
          return;
        }
        if (!finalize) {
          setFlash({ type: "ok", msg: "Rascunho guardado." });
          return;
        }
        const result = await finalizeFromDetailAction(id, autosave.versaoAtual);
        if (result.ok) {
          setFlash({ type: "ok", msg: "Encomenda finalizada." });
          setTimeout(() => router.push(`/encomendas/${id}`), 800);
        } else if (result.conflito) {
          setFlash({
            type: "err",
            msg: "Esta encomenda foi alterada por outra sessão entretanto — recarrega a página antes de finalizar.",
          });
        } else {
          setFlash({ type: "err", msg: result.error });
        }
      });
    }
  }

  // ─── Cálculos derivados ───────────────────────────────────────────────────

  const totalFinalVisible = visibleLinhas.reduce((s, l) => s + (Number(l.finalQty || "0") || 0), 0);
  const totalFinalAll = linhas.reduce((s, l) => s + (Number(l.finalQty || "0") || 0), 0);
  const hasTableFilters = !!tableSearch || !!filterEstado || filterRuturas || filterStockBaixo || !!filterFarmaciaTabela;

  // Total de colunas da tabela — usado pelo `colSpan` da linha de
  // histórico inline (Ponto 1) e do cabeçalho de grupo (Ponto 2).
  // Estado, Produto, Vendas, Média/d, Stock, Cobert., Pendente, Sugerida,
  // Final, Notas/Motivo, Ações = 11 colunas fixas; + Farmácia (isGroupMode)
  // + Decisão (mode === "grupo").
  const colSpanTotal = 11 + (isGroupMode ? 1 : 0) + (mode === "grupo" ? 1 : 0);

  const filtersCount =
    selFabricantes.length + selFornecedores.length + selCategorias.length +
    selSubcategorias.length + selUtilizacoes.length + selProductTypes.length +
    // A lista conta como UM filtro, não como 437: o contador diz quantos
    // eixos estão activos, e um ficheiro é um eixo.
    (listaCodigos ? 1 : 0);

  // ─── Renderização de UMA linha (Ponto 1 + Ponto 2 + Ponto 3) ───────────────
  //
  // Reaproveitada tanto pelo modo "farmacia" (uma `<tr>` por `Line`, como
  // sempre foi) como pelas sub-linhas de cada bloco de produto em modo
  // "grupo" (`isSubLinha: true`) — a ÚNICA diferença visual é a célula
  // "Produto": a sub-linha não repete designação/CNP/fabricante (já estão
  // no cabeçalho do grupo, ver `ProdutoGrupoHeader`), só um indicador de
  // proveniência (Ponto 2.2/2.3).
  function renderLinhaRow(l: Line, opts?: { isSubLinha?: boolean }) {
    const isSubLinha = opts?.isSubLinha ?? false;
    const rowIndex = rowIndexByKey.get(l.key) ?? -1;
    const isRutura = l.currentStock != null && l.currentStock <= 0;
    const cobBaixo = l.coberturaAtualDias != null && l.coberturaAtualDias > 0 && l.coberturaAtualDias < 7;
    return (
      <tr
        key={l.key}
        className={`border-b border-slate-50 ${rowBg(l.estado)} ${isRutura ? "!bg-rose-50/50" : ""} ${isSubLinha ? "bg-slate-50/20" : ""}`}
      >
        <td className="px-3 py-2">
          {l.estado && (
            <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${estadoColors(l.estado)}`}>
              {estadoLabel(l.estado)}
            </span>
          )}
        </td>
        <td className="px-3 py-2 min-w-[200px]">
          {isSubLinha ? (
            <div className="flex items-center gap-1.5 pl-3 text-slate-300">
              <span aria-hidden>↳</span>
              {rotuloOrigem(l.origem) && (
                <span className={`rounded-full border px-1.5 text-[10px] ${
                  l.origem === "MANUAL"
                    ? "border-amber-200 bg-amber-50 text-amber-700"
                    : "border-cyan-200 bg-cyan-50 text-cyan-700"
                }`}>
                  {rotuloOrigem(l.origem)}
                </span>
              )}
            </div>
          ) : (
            <>
              <div className="flex items-baseline gap-1.5">
                <ArtigoLink cnp={l.cnp} className="font-medium text-slate-900 hover:text-emerald-600 hover:underline">
                  {l.designacao}
                </ArtigoLink>
                {rotuloOrigem(l.origem) && (
                  <span className={`rounded-full border px-1.5 text-[10px] ${
                    l.origem === "MANUAL"
                      ? "border-amber-200 bg-amber-50 text-amber-700"
                      : "border-cyan-200 bg-cyan-50 text-cyan-700"
                  }`}>
                    {rotuloOrigem(l.origem)}
                  </span>
                )}
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500">
                <span className="font-mono">CNP {l.cnp}</span>
                {l.fabricante && <><span className="mx-1 text-slate-300">·</span>{l.fabricante}</>}
              </div>
            </>
          )}
        </td>
        {isGroupMode && <td className="px-3 py-2 text-[11px] text-slate-600">{l.farmaciaNome ?? "—"}</td>}
        <td className="px-3 py-2 text-right tabular-nums text-slate-700">{fmtNum(l.salesQty)}</td>
        <td className="px-3 py-2 text-right tabular-nums text-slate-700">{fmtNum(l.avgDailySales, 1)}</td>
        <td className={`px-3 py-2 text-right tabular-nums font-medium ${isRutura ? "text-rose-600" : "text-slate-700"}`}>
          {fmtNum(l.currentStock)}
        </td>
        <td className={`px-3 py-2 text-right tabular-nums ${cobBaixo ? "font-medium text-amber-600" : "text-slate-500"}`}>
          {l.coberturaAtualDias != null ? `${l.coberturaAtualDias.toFixed(1)}d` : "—"}
        </td>
        <td className="px-3 py-2 text-right tabular-nums text-slate-500">{fmtNum(l.pendingQty)}</td>
        <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-800">{fmtNum(l.suggestedQty)}</td>
        <td className="px-3 py-2">
          <input type="number" min="0" value={l.finalQty}
            ref={(el) => { finalQtyRefs.current[rowIndex] = el; }}
            onChange={(e) => handleFinalQtyChange(l, e.target.value)}
            onFocus={(e) => e.target.select()}
            onKeyDown={(e) => { handleInputVerticalNav(e, rowIndex, finalQtyRefs); handleCampoEnter(e, rowIndex, "finalQty"); }}
            disabled={busy}
            className="w-20 rounded-lg border border-slate-200 px-2 py-1 text-right text-[13px] focus:border-cyan-400 focus:outline-none disabled:opacity-50" />
        </td>
        <td className="px-3 py-2 min-w-[220px]">
          {l.motivo ? (
            <p className={`text-[11px] ${l.estado === "TRANSFERÊNCIA" ? "text-blue-700" : "text-slate-500"}`}>
              {l.motivo}
            </p>
          ) : (
            <input type="text" value={l.notas}
              ref={(el) => { notasRefs.current[rowIndex] = el; }}
              onChange={(e) => handleNotasFieldChange(l, e.target.value)}
              onKeyDown={(e) => handleInputVerticalNav(e, rowIndex, notasRefs)}
              placeholder="notas"
              disabled={busy}
              className="w-full rounded-lg border border-slate-200 px-2 py-1 text-[12px] placeholder:text-slate-300 focus:border-cyan-400 focus:outline-none disabled:opacity-50" />
          )}
        </td>
        {mode === "grupo" && (
          <td className="px-3 py-2 min-w-[240px]">
            <DecisaoLinhaCell
              linha={l} farmacias={farmacias} disabled={busy}
              onChange={(patch) => updateLine(l.key, patch)}
              rowIndex={rowIndex}
              registrarRef={registrarCampoRef}
              onEnterNav={handleCampoEnter}
            />
          </td>
        )}
        <td className="px-3 py-2">
          <div className="flex items-center justify-end gap-1.5">
            {/* Em modo grupo o histórico já está no cabeçalho do produto
                (uma vez, agregando todas as farmácias) — o botão por
                sub-linha seria redundante. Ver `ProdutoGrupoHeader`. */}
            {!isSubLinha && (
              <HistoricoProdutoButton
                produtoId={l.produtoId}
                produtoDesignacao={l.designacao}
                farmaciaIds={
                  l.farmaciaId
                    ? [l.farmaciaId]
                    : isGroupMode
                      ? farmaciasVisiveis.map((f) => f.id)
                      : farmaciaId
                        ? [farmaciaId]
                        : []
                }
              />
            )}
            <button type="button" onClick={() => handleRemoveLine(l)} disabled={busy}
              className="rounded-md border border-slate-200 p-1.5 text-slate-500 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </td>
      </tr>
    );
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Aviso posicionamento */}
      <div
        role="note"
        className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] leading-snug text-amber-900"
      >
        <span className="font-semibold">Assistente operacional.</span>{" "}
        As sugestões baseiam-se em vendas reais. Não contemplam descontos, MOQ, campanhas
        nem prazos — valide condições comerciais antes de finalizar.
      </div>

      {carregandoRascunho && (
        <div
          role="status"
          className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-[13px] text-slate-600"
        >
          A retomar rascunho…
        </div>
      )}

      {flash && (
        <div
          className={`rounded-xl border px-4 py-3 text-[13px] ${
            flash.type === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-800"
            : flash.type === "info" ? "border-cyan-200 bg-cyan-50 text-cyan-800"
            : "border-rose-200 bg-rose-50 text-rose-800"
          }`}
        >
          {flash.msg}
        </div>
      )}

      {/* MODO */}
      {canGroupMode && (
        <div className="flex gap-1 rounded-xl border border-slate-200 bg-white p-1">
          {(["farmacia", "grupo", "consolidacao"] as ProposalMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => handleModeChange(m)}
              disabled={generating || busy}
              className={`flex-1 rounded-lg px-3 py-2 text-[13px] font-medium transition-all ${
                mode === m
                  ? "bg-slate-900 text-white shadow-sm"
                  : "text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              }`}
            >
              {m === "farmacia" ? "Farmácia" : m === "grupo" ? "Grupo" : "Consolidação"}
            </button>
          ))}
        </div>
      )}

      {/* CRITÉRIOS */}
      <section className="rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-4 py-3">
          <h2 className="text-[14px] font-semibold text-slate-900">Critérios</h2>
          <p className="mt-0.5 text-[12px] text-slate-500">
            {mode === "farmacia"
              ? "Proposta para uma farmácia. Produtos retirados são excluídos automaticamente."
              : mode === "grupo"
                ? "Necessidades de todas as farmácias do grupo. Sugere transferências antes de compra."
                : "Vista consolidada por produto para negociação de volume. Cria uma encomenda por farmácia."}
          </p>
        </div>

        <div className="grid gap-4 px-4 py-4 md:grid-cols-3">
          {mode === "farmacia" && (
            <div>
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-slate-500">
                Farmácia
              </label>
              <select
                value={farmaciaId}
                onChange={(e) => handleFarmaciaChange(e.target.value)}
                disabled={busy || generating}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[14px] text-slate-800 shadow-sm focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-400 disabled:opacity-50"
              >
                {farmaciasVisiveis.map((f) => (
                  <option key={f.id} value={f.id}>{f.nome}</option>
                ))}
              </select>
            </div>
          )}
          {isGroupMode && (
            <div>
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-slate-500">
                Farmácias
              </label>
              <div className="flex h-[42px] items-center rounded-lg border border-slate-200 bg-slate-50 px-3 text-[13px] text-slate-600">
                Todas as farmácias activas ({farmacias.length})
              </div>
            </div>
          )}
          <div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-slate-500">
              Data início
            </label>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
              disabled={busy || generating}
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[14px] text-slate-800 shadow-sm focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-400 disabled:opacity-50" />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-slate-500">
              Data fim
            </label>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
              disabled={busy || generating}
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[14px] text-slate-800 shadow-sm focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-400 disabled:opacity-50" />
          </div>

          <div className="md:col-span-2">
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-slate-500">
              Regra de cálculo
            </label>
            <div className="flex flex-wrap gap-3">
              {(["coverage", "total"] as ProposalBaseRule[]).map((r) => (
                <label key={r} className="inline-flex items-center gap-2 text-[13px] text-slate-700">
                  <input type="radio" name="baseRule" checked={baseRule === r}
                    onChange={() => setBaseRule(r)}
                    disabled={busy || generating || (r === "total" && considerStock)} />
                  {r === "coverage" ? "Média diária × cobertura" : "Total de vendas no período"}
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-slate-500">
              Cobertura alvo (dias)
            </label>
            <input type="number" min="1" value={coverageDays}
              onChange={(e) => setCoverageDays(Math.max(1, Number(e.target.value) || 1))}
              disabled={busy || generating || (baseRule === "total" && !considerStock)}
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[14px] text-slate-800 shadow-sm focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-400 disabled:opacity-50" />
          </div>
        </div>

        <div className="grid gap-3 border-t border-slate-100 px-4 py-3 md:grid-cols-[auto_1fr_auto] md:items-center">
          <label className="inline-flex items-center gap-2 text-[13px] text-slate-700">
            <input type="checkbox" checked={considerStock}
              onChange={(e) => { setConsiderStock(e.target.checked); if (e.target.checked) setBaseRule("coverage"); }}
              disabled={busy || generating} />
            Considerar stock e pendentes
          </label>
          <button type="button" onClick={() => setFiltersOpen((v) => !v)} disabled={busy || generating}
            className="inline-flex items-center justify-self-start gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            <ChevronDown className={`h-3.5 w-3.5 transition ${filtersOpen ? "rotate-180" : ""}`} />
            Filtros
            {filtersCount > 0 && (
              <span className="ml-1 rounded-full bg-cyan-50 px-2 text-[11px] font-semibold text-cyan-700">
                {filtersCount}
              </span>
            )}
          </button>
          <button type="button" onClick={handleGenerate}
            disabled={busy || generating || (mode === "farmacia" && !farmaciaId)}
            className="inline-flex items-center gap-2 rounded-xl border border-emerald-500 bg-emerald-600 px-5 py-2 text-[13px] font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50">
            {generating ? "A gerar…" : hasProposal ? "Gerar nova proposta" : "Gerar proposta"}
          </button>
        </div>

        {filtersOpen && (
          <>
          <div className="border-t border-slate-100 px-4 pt-4">
            <ImportListaCodigos
              lista={listaCodigos}
              onChange={setListaCodigos}
              disabled={busy || generating}
            />
            {/* A contabilidade da lista FACE À PROPOSTA. Só existe
                depois de gerar — antes disso não há como saber quantos
                venderam. É aqui que os números do ficheiro e os da
                encomenda se encontram; sem isto, quem importa 1 210 e
                vê 940 conclui que 270 se perderam. */}
            {listaCodigos && proposalMeta?.listaImportada && (
              <ResumoDaLista
                lista={listaCodigos}
                resumo={proposalMeta.listaImportada}
              />
            )}
          </div>
          <div className="grid gap-4 px-4 py-4 md:grid-cols-2 lg:grid-cols-4">
            <FilterMulti label="Fabricantes" options={filterOptions.fabricantes} selected={selFabricantes} onChange={setSelFabricantes} disabled={busy || generating} />
            <FilterMulti label="Distribuidores" options={filterOptions.distribuidores} selected={selFornecedores} onChange={setSelFornecedores} disabled={busy || generating} />
            <FilterMulti label="Categorias" options={filterOptions.categorias} selected={selCategorias} onChange={setSelCategorias} disabled={busy || generating} />
            <FilterMulti label="Subcategorias" options={subcategoriasVisiveis} selected={selSubcategorias} onChange={setSelSubcategorias} disabled={busy || generating} />
            <FilterMulti
              label="Utilizações"
              options={filterOptions.utilizacoes.map((u) => u.nome)}
              selected={selUtilizacoes.map((s) => nomePorSlug.get(s) ?? s)}
              onChange={(nomes) => setSelUtilizacoes(nomes.map((n) => slugPorNome.get(n) ?? n))}
              disabled={busy || generating}
            />
            <FilterMulti label="Tipos" options={productTypes} selected={selProductTypes} onChange={setSelProductTypes} disabled={busy || generating} />
          </div>
          </>
        )}
      </section>

      {/* Truncagem.
          O `LIMIT 500` da proposta sempre existiu e com os filtros
          interactivos raramente se atingia. Com um ficheiro de milhares
          de CNP atinge-se quase sempre — e as linhas que faltam
          desapareciam sem uma palavra. O corte é por vendas
          decrescentes: perde-se a cauda, que é a parte menos importante,
          mas é uma decisão que tem de ser vista e não adivinhada. */}
      {proposalMeta?.truncated && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-[12px] text-amber-900">
          A proposta foi cortada às {MAX_LINHAS_PROPOSTA.toLocaleString("pt-PT")} linhas com mais vendas
          {proposalMeta.cnpsNaLista !== undefined
            ? ` — a lista importada tem ${proposalMeta.cnpsNaLista.toLocaleString("pt-PT")} produtos`
            : ""}
          . Reduza o período ou parta a lista em ficheiros mais pequenos para ver o resto.
        </div>
      )}

      {/* PAINEL DE RESUMO */}
      {proposalMeta && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {(
            [
              { estado: "COMPRAR" as ProposalEstado, count: proposalMeta.stats.comprar, label: "A comprar", bg: "bg-rose-50 border-rose-200", text: "text-rose-700", dot: "bg-rose-500" },
              { estado: "TRANSFERÊNCIA" as ProposalEstado, count: proposalMeta.stats.transferencia, label: "Transferência", bg: "bg-blue-50 border-blue-200", text: "text-blue-700", dot: "bg-blue-500" },
              { estado: "AGUARDAR" as ProposalEstado, count: proposalMeta.stats.aguardar, label: "Aguardar", bg: "bg-amber-50 border-amber-200", text: "text-amber-700", dot: "bg-amber-500" },
              { estado: "ADEQUADO" as ProposalEstado, count: proposalMeta.stats.adequado, label: "Adequado", bg: "bg-emerald-50 border-emerald-200", text: "text-emerald-700", dot: "bg-emerald-500" },
            ] as const
          ).map(({ estado, count, label, bg, text, dot }) => (
            <button
              key={estado}
              type="button"
              onClick={() => setFilterEstado(filterEstado === estado ? null : estado)}
              className={`rounded-xl border px-4 py-3 text-left transition-all ${bg} ${
                filterEstado === estado ? "ring-2 ring-offset-1 ring-slate-400" : "hover:opacity-80"
              }`}
            >
              <div className="flex items-center gap-2">
                <div className={`h-2 w-2 rounded-full ${dot}`} />
                <span className={`text-[11px] font-medium uppercase tracking-wider ${text}`}>{label}</span>
              </div>
              <div className={`mt-1 text-2xl font-bold ${text}`}>{count}</div>
            </button>
          ))}
        </div>
      )}

      {/* PROPOSTA */}
      {mode !== "consolidacao" && (
        <section className="rounded-xl border border-slate-200 bg-white">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <div>
              <h2 className="text-[14px] font-semibold text-slate-900">Proposta</h2>
              <p className="mt-0.5 text-[12px] text-slate-500">
                {linhas.length === 0
                  ? hasProposal ? "Sem linhas accionáveis."
                    : "Defina os critérios e clique em Gerar proposta."
                  : hasTableFilters
                    ? `${visibleLinhas.length} de ${linhas.length} linhas · total visível: ${totalFinalVisible} · total geral: ${totalFinalAll}${proposalMeta ? ` · ${proposalMeta.numDays}d` : ""}`
                    : `${linhas.length} linha${linhas.length === 1 ? "" : "s"} · total: ${totalFinalAll}${proposalMeta ? ` · ${proposalMeta.numDays}d` : ""}`}
              </p>
            </div>
          </div>

          {linhas.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 bg-slate-50/50 px-4 py-2.5">
              <input type="text" value={tableSearch} onChange={(e) => setTableSearch(e.target.value)}
                placeholder="Pesquisar produto, CNP, fabricante…"
                className="w-56 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12px] placeholder:text-slate-400 focus:border-cyan-400 focus:outline-none" />
              {isGroupMode && farmaciaOptions.length > 0 && (
                <select value={filterFarmaciaTabela} onChange={(e) => setFilterFarmaciaTabela(e.target.value)}
                  className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12px] text-slate-700 focus:border-cyan-400 focus:outline-none">
                  <option value="">Todas as farmácias</option>
                  {farmaciaOptions.map((f) => <option key={f.id} value={f.nome}>{f.nome}</option>)}
                </select>
              )}
              <label className="inline-flex cursor-pointer items-center gap-1.5 text-[12px] text-slate-700">
                <input type="checkbox" checked={filterRuturas} onChange={(e) => { setFilterRuturas(e.target.checked); if (e.target.checked) setFilterStockBaixo(false); }} className="rounded" />
                Ruturas
              </label>
              <label className="inline-flex cursor-pointer items-center gap-1.5 text-[12px] text-slate-700">
                <input type="checkbox" checked={filterStockBaixo} onChange={(e) => { setFilterStockBaixo(e.target.checked); if (e.target.checked) setFilterRuturas(false); }} className="rounded" />
                Stock baixo
              </label>
              {filterEstado && (
                <span className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${estadoColors(filterEstado)}`}>
                  {estadoLabel(filterEstado)} ×
                </span>
              )}
              {hasTableFilters && (
                <button type="button"
                  onClick={() => { setTableSearch(""); setFilterEstado(null); setFilterRuturas(false); setFilterStockBaixo(false); setFilterFarmaciaTabela(""); }}
                  className="ml-auto text-[11px] text-slate-500 hover:text-slate-700">
                  Limpar filtros
                </button>
              )}
            </div>
          )}

          {linhas.length === 0 ? (
            <div className="px-4 py-10 text-center text-[12px] text-slate-400">
              {generating ? "A calcular proposta…" : "Sem linhas."}
            </div>
          ) : visibleLinhas.length === 0 ? (
            <div className="px-4 py-10 text-center text-[12px] text-slate-400">
              Nenhuma linha corresponde aos filtros activos.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="border-b border-slate-100 text-left">
                    <th className="px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-slate-400">Estado</th>
                    <CabecalhoOrdenavel as="th" ordenacao={ordenacao} onOrdenar={alternar} coluna="designacao" className="px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-slate-400">Produto</CabecalhoOrdenavel>
                    {isGroupMode && <CabecalhoOrdenavel as="th" ordenacao={ordenacao} onOrdenar={alternar} coluna="farmaciaNome" className="px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-slate-400">Farmácia</CabecalhoOrdenavel>}
                    <CabecalhoOrdenavel as="th" ordenacao={ordenacao} onOrdenar={alternar} coluna="salesQty" align="right" className="px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-slate-400">Vendas</CabecalhoOrdenavel>
                    <CabecalhoOrdenavel as="th" ordenacao={ordenacao} onOrdenar={alternar} coluna="avgDailySales" align="right" className="px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-slate-400">Média/d</CabecalhoOrdenavel>
                    <CabecalhoOrdenavel as="th" ordenacao={ordenacao} onOrdenar={alternar} coluna="currentStock" align="right" className="px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-slate-400">Stock</CabecalhoOrdenavel>
                    <CabecalhoOrdenavel as="th" ordenacao={ordenacao} onOrdenar={alternar} coluna="coberturaAtualDias" align="right" className="px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-slate-400">Cobert.</CabecalhoOrdenavel>
                    <CabecalhoOrdenavel as="th" ordenacao={ordenacao} onOrdenar={alternar} coluna="pendingQty" align="right" className="px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-slate-400">Pendente</CabecalhoOrdenavel>
                    <CabecalhoOrdenavel as="th" ordenacao={ordenacao} onOrdenar={alternar} coluna="suggestedQty" align="right" className="px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-slate-400">Sugerida</CabecalhoOrdenavel>
                    <th className="px-3 py-2 text-right text-[10px] font-medium uppercase tracking-wider text-slate-400">Final</th>
                    <th className="px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-slate-400">Notas / Motivo</th>
                    {mode === "grupo" && (
                      <th className="px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-slate-400">Decisão</th>
                    )}
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {mode === "grupo"
                    ? gruposProduto.map((g) => (
                        <Fragment key={g.produtoId}>
                          <ProdutoGrupoHeader
                            grupo={g}
                            colSpan={colSpanTotal}
                            historico={historicoPorProduto.get(g.produtoId)}
                            historicoCarregando={historicoCarregando}
                          />
                          {g.subLinhas.map((l) => renderLinhaRow(l, { isSubLinha: true }))}
                        </Fragment>
                      ))
                    : visibleLinhas.map((l) => (
                        <Fragment key={l.key}>
                          {renderLinhaRow(l)}
                          <tr className="border-b border-slate-100">
                            <td colSpan={colSpanTotal} className="px-3 pb-2.5 pt-0">
                              <HistoricoInlineMiniGrid
                                historico={historicoPorProduto.get(l.produtoId)}
                                farmaciaIds={l.farmaciaId ? [l.farmaciaId] : []}
                                carregando={historicoCarregando}
                              />
                            </td>
                          </tr>
                        </Fragment>
                      ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* VISTA CONSOLIDAÇÃO */}
      {mode === "consolidacao" && (
        <section className="rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-4 py-3">
            <h2 className="text-[14px] font-semibold text-slate-900">Vista consolidada</h2>
            <p className="mt-0.5 text-[12px] text-slate-500">
              Agrupado por produto. Ajuste as quantidades finais por farmácia antes de criar as encomendas.
              {consolidadoRows.length > 0 && ` ${consolidadoRows.length} produtos · total: ${totalFinalAll} und`}
            </p>
          </div>

          {consolidadoRows.length === 0 ? (
            <div className="px-4 py-10 text-center text-[12px] text-slate-400">
              {generating ? "A calcular…" : "Gere uma proposta para ver a vista consolidada."}
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {consolidadoRows.map((g) => (
                <div key={g.produtoId} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${estadoColors(g.estadoPriority)}`}>
                          {estadoLabel(g.estadoPriority)}
                        </span>
                        <span className="font-medium text-slate-900">{g.designacao}</span>
                        <span className="font-mono text-[11px] text-slate-500">CNP {g.cnp}</span>
                        {g.fabricante && <span className="text-[11px] text-slate-500">{g.fabricante}</span>}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {g.farmaciaLinhas.map((l) => (
                          <div key={l.key} className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5">
                            <span className="text-[11px] font-medium text-slate-700">{l.farmaciaNome ?? "—"}</span>
                            <span className="text-[11px] text-slate-400">suger. {fmtNum(l.suggestedQty)}</span>
                            <input type="number" min="0" value={l.finalQty}
                              onChange={(e) => updateLine(l.key, { finalQty: e.target.value })}
                              onFocus={(e) => e.target.select()}
                              disabled={busy}
                              className="w-16 rounded border border-slate-300 bg-white px-1.5 py-0.5 text-right text-[12px] focus:border-cyan-400 focus:outline-none disabled:opacity-50" />
                          </div>
                        ))}
                      </div>
                      {/* Ponto 1 — histórico inline, uma vez por produto (a
                          vista consolidada já é agrupada por produto). */}
                      <div className="mt-2">
                        <HistoricoInlineMiniGrid
                          historico={historicoPorProduto.get(g.produtoId)}
                          farmaciaIds={[...new Set(g.farmaciaLinhas.map((l) => l.farmaciaId).filter((id): id is string => !!id))]}
                          carregando={historicoCarregando}
                        />
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-[11px] text-slate-500">Total</div>
                      <div className="text-lg font-bold text-slate-900">{g.totalFinalQty}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* PICKER MANUAL */}
      {mode === "farmacia" && (
        <section className="rounded-xl border border-slate-200 bg-white">
          <button type="button" onClick={() => setManualOpen((v) => !v)}
            className="flex w-full items-center justify-between border-b border-slate-100 px-4 py-3 text-left">
            <div>
              <h2 className="text-[14px] font-semibold text-slate-900">Adicionar produto manual</h2>
              <p className="mt-0.5 text-[12px] text-slate-500">Para produtos sem vendas no período ou fora dos filtros.</p>
            </div>
            <Plus className={`h-4 w-4 text-slate-400 transition ${manualOpen ? "rotate-45" : ""}`} />
          </button>
          {manualOpen && (
            <div className="p-4">
              {/* `permitirCriar`: quando a pesquisa nao devolve nada, o
                  picker oferece criar a ficha ali mesmo. O produto
                  criado volta por `onPick` e entra como linha MANUAL,
                  sem o utilizador sair da encomenda. */}
              <ProductPicker
                farmaciaId={farmaciaId}
                disabled={busy || generating}
                onPick={handlePickManual}
                permitirCriar
              />
            </div>
          )}
        </section>
      )}

      {/* Conflito de versão do rascunho eager (mode === "farmacia") —
          mesma UX do ecrã de detalhe: nunca sobrescreve silenciosamente,
          o utilizador escolhe actualizar (descarta local) ou criar cópia
          (preserva o que está no ecrã como um rascunho novo). */}
      {mode === "farmacia" && draftId && autosave.estado.tipo === "conflito" && (
        <section className="rounded-xl border border-rose-300 bg-rose-50 px-4 py-3">
          <p className="text-[13px] font-medium text-rose-800">
            Este rascunho foi alterado por outra sessão (separador, dispositivo ou utilizador)
            enquanto o editavas aqui. As tuas alterações locais não foram gravadas por cima —
            escolhe como continuar:
          </p>
          <div className="mt-2.5 flex gap-2">
            <button type="button" onClick={handleConflitoActualizar}
              className="rounded-lg border border-rose-300 bg-white px-3.5 py-1.5 text-[12px] font-medium text-rose-800 hover:bg-rose-100">
              Actualizar (descarta as alterações locais)
            </button>
            <button type="button" onClick={handleConflitoCriarCopia} disabled={busy}
              className="rounded-lg border border-rose-500 bg-rose-600 px-3.5 py-1.5 text-[12px] font-medium text-white hover:bg-rose-700 disabled:opacity-50">
              Criar cópia com as minhas alterações
            </button>
          </div>
        </section>
      )}

      {/* GUARDAR / FINALIZAR — não em modo grupo: aí a etapa final é o
          resumo por balde + "Gerar" (ver secção seguinte). Continua a
          servir "farmacia" e "consolidação", exactamente como antes. */}
      {mode !== "grupo" && (
        <section className="rounded-xl border border-slate-200 bg-white px-4 py-4">
          <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-end">
            <div>
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-slate-500">
                {mode === "consolidacao" ? "Prefixo do nome (aplicado a cada encomenda)" : "Nome da encomenda"}
              </label>
              <input type="text" value={nome} onChange={(e) => setNome(e.target.value)}
                placeholder={mode === "consolidacao"
                  ? `Grupo ${new Date().toLocaleDateString("pt-PT")}`
                  : `Encomenda ${new Date().toLocaleDateString("pt-PT")}`}
                disabled={busy}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[14px] text-slate-800 shadow-sm placeholder:text-slate-400 focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-400 disabled:opacity-50" />
              {mode === "consolidacao" && linhas.length > 0 && (
                <p className="mt-1 text-[11px] text-slate-500">
                  Vai criar {new Set(linhas.map((l) => l.farmaciaId).filter(Boolean)).size} encomenda(s) — uma por farmácia.
                </p>
              )}
              {mode === "farmacia" && draftId && (
                <div className="mt-1.5 flex items-center gap-2">
                  <AutosaveStatusBadge estado={autosave.estado} />
                  <span className="text-[11px] text-slate-400">rascunho {draftId.slice(0, 8)}…</span>
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {mode === "farmacia" && draftId && (
                <button type="button" onClick={handleCancelDraft} disabled={busy}
                  className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-[13px] font-medium text-slate-500 shadow-sm hover:bg-slate-50 disabled:opacity-50">
                  Cancelar rascunho
                </button>
              )}
              <button type="button" onClick={() => submit(false)}
                disabled={busy || linhas.length === 0 || (mode === "farmacia" && autosave.estado.tipo === "conflito")}
                className="rounded-xl border border-slate-300 bg-white px-5 py-2.5 text-[13px] font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50">
                {busy ? "A guardar..." : "Guardar rascunho"}
              </button>
              <button type="button" onClick={() => submit(true)}
                disabled={busy || linhas.length === 0 || (mode === "farmacia" && autosave.estado.tipo === "conflito")}
                className="rounded-xl border border-cyan-500 bg-cyan-600 px-5 py-2.5 text-[13px] font-medium text-white shadow-sm hover:bg-cyan-700 disabled:opacity-50">
                {busy ? "A finalizar..." : mode === "consolidacao" ? "Criar encomendas" : "Finalizar e enviar para fila"}
              </button>
            </div>
          </div>
        </section>
      )}

      {/* RESUMO + GERAR — modo grupo (Bloco D) ────────────────────────
          A etapa final: contagem por balde (uma ListaEncomenda por
          farmácia com ENCOMENDAR, uma Transferencia por direcção com
          TRANSFERIR), e só depois o botão que gera. Nunca cria
          documento vazio — `calcularResumoGrupo`/`agruparParaGeracao`
          garantem-no (`lib/encomendas/decisao-grupo.ts`), testado em
          `test-encomenda-grupo-decisao-linha.ts`. */}
      {mode === "grupo" && (
        <section className="rounded-xl border border-slate-200 bg-white px-4 py-4">
          <h2 className="text-[14px] font-semibold text-slate-900">Resumo</h2>
          {linhas.length === 0 ? (
            <p className="mt-2 text-[12px] text-slate-400">
              Gere a proposta e decida ENCOMENDAR / TRANSFERIR / NÃO FAZER linha a linha antes de gerar.
            </p>
          ) : (
            <>
              <div className="mt-2 flex flex-wrap gap-2">
                {resumoGrupoAtual?.encomendas.map((b) => (
                  <span key={b.farmaciaId} className="rounded-full border border-rose-200 bg-rose-50 px-3 py-1 text-[12px] font-medium text-rose-700">
                    Encomenda {nomeFarmacia(b.farmaciaId)}: {b.nLinhas} linha{b.nLinhas === 1 ? "" : "s"}
                  </span>
                ))}
                {resumoGrupoAtual?.transferencias.map((b) => (
                  <span key={`${b.origemId}>${b.destinoId}`} className="rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-[12px] font-medium text-blue-700">
                    {nomeFarmacia(b.origemId)} → {nomeFarmacia(b.destinoId)}: {b.nLinhas} linha{b.nLinhas === 1 ? "" : "s"}
                  </span>
                ))}
                {!!resumoGrupoAtual?.naoFazer && (
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[12px] font-medium text-slate-500">
                    Não fazer: {resumoGrupoAtual.naoFazer} linha{resumoGrupoAtual.naoFazer === 1 ? "" : "s"}
                  </span>
                )}
                {resumoGrupoAtual &&
                  resumoGrupoAtual.encomendas.length === 0 &&
                  resumoGrupoAtual.transferencias.length === 0 && (
                    <span className="text-[12px] text-amber-700">
                      Nenhuma linha accionável ainda — não há nada para gerar.
                    </span>
                  )}
              </div>

              <div className="mt-4 grid gap-4 md:grid-cols-[1fr_auto] md:items-end">
                <div>
                  <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-slate-500">
                    Prefixo do nome (aplicado a cada encomenda gerada)
                  </label>
                  <input type="text" value={nome} onChange={(e) => setNome(e.target.value)}
                    placeholder={`Grupo ${new Date().toLocaleDateString("pt-PT")}`}
                    disabled={gerandoPlano}
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[14px] text-slate-800 shadow-sm placeholder:text-slate-400 focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-400 disabled:opacity-50" />
                </div>
                <button type="button" onClick={handleGerarPlano}
                  disabled={
                    gerandoPlano ||
                    !resumoGrupoAtual ||
                    (resumoGrupoAtual.encomendas.length === 0 && resumoGrupoAtual.transferencias.length === 0)
                  }
                  className="rounded-xl border border-cyan-500 bg-cyan-600 px-5 py-2.5 text-[13px] font-medium text-white shadow-sm hover:bg-cyan-700 disabled:cursor-not-allowed disabled:opacity-50">
                  {gerandoPlano ? "A gerar…" : "Gerar"}
                </button>
              </div>
            </>
          )}

          {/* O que foi criado — resumo + link para cada ListaEncomenda.
              Para Transferencia não há página de detalhe dedicada nesta
              fase: é um registo interno simples, e a confirmação inline
              (farmácias + nº de linhas) é o mínimo razoável para o
              utilizador confirmar o que aconteceu sem sobre-construir
              um ecrã que o Bloco D não pediu. */}
          {planoResultado && (
            <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-[12px] text-emerald-900">
              <p className="font-semibold">Gerado</p>
              <ul className="mt-1.5 space-y-1">
                {planoResultado.listasEncomenda.map((le) => (
                  <li key={le.listaEncomendaId}>
                    Encomenda · {nomeFarmacia(le.farmaciaId)} · {le.nLinhas} linha{le.nLinhas === 1 ? "" : "s"}
                    {" — "}
                    <a href={`/encomendas/${le.listaEncomendaId}`} className="underline hover:text-emerald-700">
                      abrir
                    </a>
                  </li>
                ))}
                {planoResultado.transferencias.map((t) => (
                  <li key={t.transferenciaId}>
                    Transferência · {nomeFarmacia(t.farmaciaOrigemId)} → {nomeFarmacia(t.farmaciaDestinoId)} ·{" "}
                    {t.nLinhas} linha{t.nLinhas === 1 ? "" : "s"}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

// ─── SortableHeader ───────────────────────────────────────────────────────────


// ─── FilterMulti ─────────────────────────────────────────────────────────────

/**
 * O que a lista importada produziu nesta proposta.
 *
 * Seis números e duas listas consultáveis. Os seis somam de forma
 * verificável — é isso que os torna auditáveis em vez de decorativos:
 *
 *     lidos = encontrados + não encontrados          (do ficheiro)
 *     encontrados = com vendas + sem vendas + sem registo   (da proposta)
 *
 * Os duplicados contam-se à parte porque não são uma quarta categoria
 * de produto: são leituras repetidas do mesmo código no ficheiro.
 */
function ResumoDaLista({
  lista,
  resumo,
}: {
  lista: ListaCodigosResolvida;
  resumo: ResumoListaImportada;
}) {
  const [aberto, setAberto] = useState<"semVendas" | "naoEncontrados" | null>(null);

  const n = (v: number) => v.toLocaleString("pt-PT");

  return (
    <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50/70 p-3">
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[12px]">
        <Numero valor={n(lista.totalLidos)} rotulo="códigos lidos" />
        <Numero valor={n(lista.encontrados)} rotulo="produtos encontrados" />
        <Numero
          valor={n(resumo.comVendas)}
          rotulo="considerados na proposta"
          destaque
        />
        {resumo.semVendas > 0 && (
          <button
            type="button"
            onClick={() => setAberto((a) => (a === "semVendas" ? null : "semVendas"))}
            className="text-left underline-offset-2 hover:underline"
          >
            <Numero
              valor={n(resumo.semVendas)}
              rotulo="sem vendas no período ▾"
              cor="text-amber-700"
            />
          </button>
        )}
        {resumo.semRegistoNaFarmacia > 0 && (
          <Numero
            valor={n(resumo.semRegistoNaFarmacia)}
            rotulo="sem registo na farmácia"
            cor="text-slate-500"
          />
        )}
        {lista.duplicados > 0 && (
          <Numero valor={n(lista.duplicados)} rotulo="duplicados" cor="text-slate-500" />
        )}
        {lista.naoEncontrados.length > 0 && (
          <button
            type="button"
            onClick={() =>
              setAberto((a) => (a === "naoEncontrados" ? null : "naoEncontrados"))
            }
            className="text-left underline-offset-2 hover:underline"
          >
            <Numero
              valor={n(lista.naoEncontrados.length)}
              rotulo="não encontrados ▾"
              cor="text-rose-700"
            />
          </button>
        )}
      </div>

      {/* Os artigos sem vendas CONTINUAM na encomenda, com quantidade 0.
          Dizê-lo aqui evita a leitura de que foram excluídos. */}
      {resumo.semVendas > 0 && (
        <p className="mt-2 text-[11px] text-slate-500">
          Os artigos sem vendas no período entram na encomenda com quantidade 0 e
          podem ser ajustados à mão.
        </p>
      )}

      {aberto && (
        <div className="mt-2 max-h-32 overflow-y-auto rounded-lg border border-slate-200 bg-white p-2 font-mono text-[11px] leading-5 text-slate-700">
          {aberto === "semVendas"
            ? resumo.listaSemVendas.join(", ")
            : lista.naoEncontrados.join(", ")}
        </div>
      )}
    </div>
  );
}

function Numero({
  valor,
  rotulo,
  cor = "text-slate-700",
  destaque = false,
}: {
  valor: string;
  rotulo: string;
  cor?: string;
  destaque?: boolean;
}) {
  return (
    <span className={cor}>
      <span className={destaque ? "font-semibold text-emerald-700" : "font-semibold"}>
        {valor}
      </span>{" "}
      <span className="text-slate-500">{rotulo}</span>
    </span>
  );
}

/**
 * A decisão de uma linha, em modo grupo: ENCOMENDAR / TRANSFERIR / NÃO
 * FAZER, mais os sub-campos de cada acção. A quantidade não vive aqui —
 * é a coluna "Final" que a tabela já tem, partilhada pelos dois casos
 * accionáveis (ver `Line`).
 *
 * Componente pequeno e sem estado próprio de propósito: recebe a linha
 * e devolve o patch a aplicar via `updateLine`, exactamente como os
 * outros campos editáveis da tabela.
 */
function DecisaoLinhaCell({
  linha,
  farmacias,
  disabled,
  onChange,
  rowIndex,
  registrarRef,
  onEnterNav,
}: {
  linha: Line;
  farmacias: { id: string; nome: string }[];
  disabled?: boolean;
  onChange: (patch: Partial<Line>) => void;
  /** Índice estável na lista navegável (Ponto 3.6) — para as refs/Enter abaixo. */
  rowIndex: number;
  /** Regista a ref do `<select>` deste campo, para navegação por teclado (Ponto 3). */
  registrarRef: (
    slot: "acao" | "encomendaFarmacia" | "origemFarmacia" | "destinoFarmacia",
    rowIndex: number,
    el: HTMLSelectElement | null,
  ) => void;
  /**
   * Enter/Shift+Enter avança/recua na cadeia de campos operacionais
   * (Ponto 3.1/3.2). Nunca intercepta ArrowUp/ArrowDown — um `<select>`
   * mantém o comportamento nativo das setas (Ponto 3.7).
   */
  onEnterNav: (e: ReactKeyboardEvent, rowIndex: number, slot: CampoSlot) => void;
}) {
  const selectCls =
    "w-full rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700 focus:border-cyan-400 focus:outline-none disabled:opacity-50";

  return (
    <div className="flex flex-col gap-1">
      <select
        ref={(el) => registrarRef("acao", rowIndex, el)}
        value={linha.acao}
        disabled={disabled}
        onChange={(e) => onChange({ acao: e.target.value as AcaoLinhaGrupo, acaoTocada: true })}
        onKeyDown={(e) => onEnterNav(e, rowIndex, "acao")}
        className={`${selectCls} font-medium`}
      >
        <option value="ENCOMENDAR">Encomendar</option>
        <option value="TRANSFERIR">Transferir</option>
        <option value="NAO_FAZER">Não fazer</option>
      </select>

      {linha.acao === "ENCOMENDAR" && (
        <select
          ref={(el) => registrarRef("encomendaFarmacia", rowIndex, el)}
          value={linha.farmaciaEncomendaId ?? ""}
          disabled={disabled}
          onChange={(e) => onChange({ farmaciaEncomendaId: e.target.value, acaoTocada: true })}
          onKeyDown={(e) => onEnterNav(e, rowIndex, "encomendaFarmacia")}
          className={selectCls}
        >
          <option value="">Farmácia…</option>
          {farmacias.map((f) => (
            <option key={f.id} value={f.id}>{f.nome}</option>
          ))}
        </select>
      )}

      {linha.acao === "TRANSFERIR" && (
        <div className="flex items-center gap-1">
          <select
            ref={(el) => registrarRef("origemFarmacia", rowIndex, el)}
            value={linha.farmaciaOrigemId ?? ""}
            disabled={disabled}
            onChange={(e) => onChange({ farmaciaOrigemId: e.target.value, acaoTocada: true })}
            onKeyDown={(e) => onEnterNav(e, rowIndex, "origemFarmacia")}
            className={`${selectCls} min-w-0`}
          >
            <option value="">Origem…</option>
            {farmacias.map((f) => (
              <option key={f.id} value={f.id}>{f.nome}</option>
            ))}
          </select>
          <ArrowLeftRight className="h-3 w-3 shrink-0 text-slate-400" />
          <select
            ref={(el) => registrarRef("destinoFarmacia", rowIndex, el)}
            value={linha.farmaciaDestinoId ?? ""}
            disabled={disabled}
            onChange={(e) => onChange({ farmaciaDestinoId: e.target.value, acaoTocada: true })}
            onKeyDown={(e) => onEnterNav(e, rowIndex, "destinoFarmacia")}
            className={`${selectCls} min-w-0`}
          >
            <option value="">Destino…</option>
            {farmacias.map((f) => (
              <option key={f.id} value={f.id}>{f.nome}</option>
            ))}
          </select>
        </div>
      )}
      {linha.acao === "TRANSFERIR" && linha.farmaciaOrigemId && linha.farmaciaOrigemId === linha.farmaciaDestinoId && (
        <p className="text-[10px] text-rose-600">Origem e destino não podem ser a mesma farmácia.</p>
      )}
    </div>
  );
}

// ─── Ponto 1 — histórico inline (mini-grelha compacta) ─────────────────────

/**
 * 12 colunas (meses) × 2 linhas (Compras/Vendas), sempre visível por
 * omissão — substitui o modal on-demand para o caso comum. Quando
 * `historico.farmacias` tem mais do que uma farmácia RELEVANTE (Ponto
 * 1.4/2.3 — grupo consolidado com N farmácias), agrega por soma em vez
 * de repetir a grelha inteira por farmácia: mais legível no espaço
 * compacto de uma linha de tabela.
 *
 * `farmaciaIds` filtra `historico.farmacias` para as farmácias
 * RELEVANTES a este produto/linha — o `historico` vem de um lote
 * carregado para TODAS as farmácias da proposta (`historicoPorProduto`),
 * e mostrar farmácias fora do âmbito desta linha/grupo seria confuso.
 */
function HistoricoInlineMiniGrid({
  historico,
  farmaciaIds,
  carregando,
}: {
  historico: HistoricoProduto12MesesResult | undefined;
  farmaciaIds: string[];
  carregando: boolean;
}) {
  if (farmaciaIds.length === 0) return null;

  const relevantes = historico?.farmacias.filter((f) => farmaciaIds.includes(f.farmaciaId)) ?? [];
  if (relevantes.length === 0) {
    return (
      <div
        className={`rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2 text-[11px] text-slate-400 ${
          carregando ? "animate-pulse" : ""
        }`}
      >
        {carregando ? "A carregar histórico…" : "Sem histórico disponível."}
      </div>
    );
  }

  const nMeses = relevantes[0].meses.length;
  const meses = Array.from({ length: nMeses }, (_, i) => {
    let compras = 0;
    let vendas = 0;
    let label = "";
    for (const f of relevantes) {
      const m = f.meses[i];
      if (m) {
        compras += m.compras;
        vendas += m.vendas;
        label = m.label;
      }
    }
    return { label, compras, vendas };
  });
  const semLedger = relevantes.filter((f) => !f.temLedger);

  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/60 p-2.5">
      <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-slate-400">
        <span className="font-medium uppercase tracking-wider text-slate-400">Histórico 12 meses</span>
        {relevantes.length > 1 && <span>· agregado de {relevantes.length} farmácias</span>}
        {semLedger.length > 0 && (
          <span className="text-amber-700">
            · sem ledger: {semLedger.map((f) => f.farmaciaNome).join(", ")}
          </span>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[10px] leading-tight">
          <thead>
            <tr>
              <th className="w-16 pb-0.5 pr-2 text-left font-medium text-slate-400" />
              {meses.map((m, i) => (
                <th key={i} className="px-1 pb-0.5 text-right font-medium text-slate-400">{m.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="pr-2 text-slate-500">Compras</td>
              {meses.map((m, i) => (
                <td key={i} className="px-1 text-right tabular-nums text-slate-700">{Math.round(m.compras)}</td>
              ))}
            </tr>
            <tr>
              <td className="pr-2 text-slate-500">Vendas</td>
              {meses.map((m, i) => (
                <td key={i} className={`px-1 text-right tabular-nums ${m.vendas < 0 ? "text-rose-600" : "text-slate-700"}`}>
                  {Math.round(m.vendas)}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Cabeçalho de UM bloco de produto em modo grupo (Ponto 2.2) — CNP,
 * designação e fabricante aparecem AQUI, uma única vez, nunca repetidos
 * por sub-linha de farmácia (ver `renderLinhaRow`, `isSubLinha: true`).
 * O histórico inline (Ponto 2.3) vive logo a seguir, também uma vez,
 * agregando `farmaciaIds` de TODAS as sub-linhas do produto (Ponto 1.5).
 */
function ProdutoGrupoHeader({
  grupo,
  colSpan,
  historico,
  historicoCarregando,
}: {
  grupo: GrupoProdutoLine;
  colSpan: number;
  historico: HistoricoProduto12MesesResult | undefined;
  historicoCarregando: boolean;
}) {
  const farmaciaIds = [
    ...new Set(grupo.subLinhas.map((l) => l.farmaciaId).filter((id): id is string => !!id)),
  ];
  return (
    <>
      <tr className="border-b border-slate-100 bg-slate-50">
        <td colSpan={colSpan} className="px-3 py-2">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="font-semibold text-slate-900">{grupo.designacao}</span>
            <span className="font-mono text-[11px] text-slate-500">CNP {grupo.cnp}</span>
            {grupo.fabricante && <span className="text-[11px] text-slate-500">{grupo.fabricante}</span>}
            <span className="text-[11px] text-slate-400">
              · {grupo.subLinhas.length} farmácia{grupo.subLinhas.length === 1 ? "" : "s"}
            </span>
            <HistoricoProdutoButton
              produtoId={grupo.produtoId}
              produtoDesignacao={grupo.designacao}
              farmaciaIds={farmaciaIds}
            />
          </div>
        </td>
      </tr>
      <tr className="border-b border-slate-100">
        <td colSpan={colSpan} className="px-3 pb-2.5 pt-0">
          <HistoricoInlineMiniGrid historico={historico} farmaciaIds={farmaciaIds} carregando={historicoCarregando} />
        </td>
      </tr>
    </>
  );
}

function FilterMulti({ label, options, selected, onChange, disabled }: {
  label: string; options: string[]; selected: string[];
  onChange: (next: string[]) => void; disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.toLowerCase().includes(q)) : options;
  }, [options, query]);

  function toggle(value: string) {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  }

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <label className="text-[11px] font-medium uppercase tracking-wider text-slate-500">{label}</label>
        {selected.length > 0 && (
          <button type="button" onClick={() => onChange([])} disabled={disabled}
            className="text-[11px] text-slate-500 hover:text-slate-700">Limpar</button>
        )}
      </div>
      <input type="text" value={query} onChange={(e) => setQuery(e.target.value)}
        placeholder={`Procurar… (${options.length})`} disabled={disabled}
        className="mb-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[12px] placeholder:text-slate-400 focus:border-cyan-400 focus:outline-none disabled:opacity-50" />
      <div className="max-h-44 overflow-y-auto rounded-lg border border-slate-200 bg-white">
        {filtered.length === 0 ? (
          <div className="px-2 py-2 text-[11px] text-slate-400">Sem resultados.</div>
        ) : (
          <ul>
            {filtered.map((o) => (
              <li key={o}>
                <label className="flex cursor-pointer items-center gap-2 px-2 py-1 text-[12px] hover:bg-slate-50">
                  <input type="checkbox" checked={selected.includes(o)} onChange={() => toggle(o)} disabled={disabled} />
                  <span className="truncate">{o}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}


/**
 * As colunas ordenáveis da proposta de encomenda.
 *
 * `finalQty` NÃO está aqui, e é deliberado: é um `<input>` que o
 * utilizador está a preencher. Ordenar por ele reordenaria as linhas
 * debaixo do cursor a cada dígito escrito.
 */
type ColunaEncomenda =
  | "designacao"
  | "farmaciaNome"
  | "salesQty"
  | "avgDailySales"
  | "currentStock"
  | "coberturaAtualDias"
  | "pendingQty"
  | "suggestedQty";

function acessorEncomenda(linha: Line, coluna: ColunaEncomenda): ValorOrdenavel {
  return linha[coluna] as ValorOrdenavel;
}
