/**
 * lib/catalogo/manutencao-massa-filtro.ts
 *
 * Tipos e regras PURAS (sem BD, sem Node, importável por componentes client) do
 * filtro da Manutenção em massa do catálogo (tenant silveira).
 *
 * ── Os filtros são os de Vendas ─────────────────────────────────────────
 * O vocabulário do filtro é o de `SharedReportFilters` (Vendas): pesquisa,
 * lista de CNP, categorias, subcategorias, utilizações, distribuidor, sem
 * classificação e — opcionalmente — o MOVIMENTO de vendas (período, crédito,
 * transferências, stock sem vendas, manutenção de vendas). O servidor aplica-os
 * com as MESMAS funções que Vendas (`resolverPrefiltroProdutos`, `getVendasData`).
 * A manutenção só ACRESCENTA conceitos que Vendas não tem: valor ATUAL
 * (fabricante / fornecedor habitual, por ID) e tipo de artigo.
 *
 * ── Âmbito por farmácia ─────────────────────────────────────────────────
 * O fabricante pertence ao PRODUTO (catálogo); o fornecedor habitual pertence
 * ao produto NAQUELA farmácia. Uma operação de FORNECEDOR só toca nas farmácias
 * explicitamente listadas em `farmaciaIds` — nunca noutra.
 */
import { DEFAULT_INCLUIR_CREDITO } from "@/lib/reporting/natureza-venda";

export type TipoManutencaoMassa = "FABRICANTE" | "FORNECEDOR";

export type ManutencaoMassaFiltro = {
  /** FORNECEDOR: obrigatório (≥1). FABRICANTE: opcional — restringe aos produtos presentes nessas farmácias. */
  farmaciaIds?: string[];

  // ── Vendas (mesmos nomes e semântica de SharedReportFilters) ──
  /** Produto: CNP exacto/parcial ou designação — `construirCondicaoPesquisa`. */
  pesquisa?: string | null;
  /** Lista de CNP importada (presença conta: `[]` = nenhum produto). */
  cnps?: number[];
  /** Nível 1 canónico, por NOME (como em Vendas). */
  categorias?: string[];
  /** Nível 2 canónico, por NOME. */
  subcategorias?: string[];
  /** Utilizações, por SLUG. */
  utilizacoes?: string[];
  /** Distribuidor (`ProdutoFarmacia.fornecedorOrigem`, texto do ERP) — por farmácia, como em Vendas. */
  distribuidores?: string[];
  apenasSemClassif?: boolean;

  /** Movimento de vendas — só activo com `from` E `to`. Defaults de Vendas. */
  from?: string | null;
  to?: string | null;
  incluirCredito?: boolean;
  incluirTransferencias?: boolean;
  apenasComStock?: boolean;
  incluirManutencao?: boolean;

  // ── Conceitos específicos da manutenção ──
  tipoArtigo?: string | null;
  /** Fabricante ATUAL, por ID. Com `semFabricante` = «um destes OU sem fabricante». */
  fabricanteAtualIds?: string[];
  semFabricante?: boolean;
  /** Fornecedor habitual ATUAL, por ID (só FORNECEDOR). Com `semFornecedor` = «um destes OU sem fornecedor». */
  fornecedorAtualIds?: string[];
  semFornecedor?: boolean;
  /** Só FABRICANTE — sinal informativo (fabricante divergente entre farmácias). */
  fabricanteDivergente?: boolean;
};

/** Defaults de Vendas para os interruptores de movimento (para o mesmo universo com os mesmos valores). */
export const DEFAULTS_MOVIMENTO = {
  incluirCredito: DEFAULT_INCLUIR_CREDITO,
  incluirTransferencias: false,
  apenasComStock: true,
  incluirManutencao: false,
} as const;

export type DestinoInput =
  | { modo: "existente"; id: string }
  | { modo: "novo"; nome: string };

/** Selecção do utilizador sobre o conjunto que corresponde ao filtro. */
export type SelecaoManutencao =
  | { modo: "todos"; excluidas?: string[] }
  | { modo: "manual"; chaves: string[] };

/** Chave estável de um alvo: o produto (FABRICANTE) ou o par produto|farmácia (FORNECEDOR). */
export function chaveAlvo(produtoId: string, farmaciaId: string | null): string {
  return farmaciaId ? `${produtoId}|${farmaciaId}` : produtoId;
}

export function periodoActivo(f: ManutencaoMassaFiltro): boolean {
  return !!(f.from && f.to);
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function lista(v: readonly string[] | undefined): string[] | undefined {
  if (!v || v.length === 0) return undefined;
  const out = [...new Set(v.map((x) => x.trim()).filter(Boolean))].sort();
  return out.length > 0 ? out : undefined;
}

/**
 * Forma CANÓNICA do filtro: arrays únicos e ordenados, strings aparadas,
 * valores por omissão omitidos. É o que entra no snapshot/hash do preview —
 * dois pedidos equivalentes têm exactamente o mesmo JSON.
 */
export function normalizarFiltro(f: ManutencaoMassaFiltro): ManutencaoMassaFiltro {
  const out: ManutencaoMassaFiltro = {};
  const set = <K extends keyof ManutencaoMassaFiltro>(k: K, v: ManutencaoMassaFiltro[K] | undefined) => {
    if (v !== undefined) out[k] = v;
  };
  set("farmaciaIds", lista(f.farmaciaIds));
  set("pesquisa", f.pesquisa && f.pesquisa.trim() ? f.pesquisa.trim() : undefined);
  // lista de CNP: a PRESENÇA conta (um [] filtra para zero) — nunca se omite
  if (f.cnps !== undefined) out.cnps = [...new Set(f.cnps)].sort((a, b) => a - b);
  set("categorias", lista(f.categorias));
  set("subcategorias", lista(f.subcategorias));
  set("utilizacoes", lista(f.utilizacoes));
  set("distribuidores", lista(f.distribuidores));
  if (f.apenasSemClassif) out.apenasSemClassif = true;
  if (periodoActivo(f)) {
    out.from = f.from!;
    out.to = f.to!;
    out.incluirCredito = f.incluirCredito ?? DEFAULTS_MOVIMENTO.incluirCredito;
    out.incluirTransferencias = f.incluirTransferencias ?? DEFAULTS_MOVIMENTO.incluirTransferencias;
    out.apenasComStock = f.apenasComStock ?? DEFAULTS_MOVIMENTO.apenasComStock;
    out.incluirManutencao = f.incluirManutencao ?? DEFAULTS_MOVIMENTO.incluirManutencao;
  }
  set("tipoArtigo", f.tipoArtigo && f.tipoArtigo.trim() ? f.tipoArtigo.trim() : undefined);
  set("fabricanteAtualIds", lista(f.fabricanteAtualIds));
  if (f.semFabricante) out.semFabricante = true;
  set("fornecedorAtualIds", lista(f.fornecedorAtualIds));
  if (f.semFornecedor) out.semFornecedor = true;
  if (f.fabricanteDivergente) out.fabricanteDivergente = true;
  return out;
}

/**
 * Validação pura do filtro — sem BD. Devolve uma mensagem de erro, ou `null`
 * quando válido.
 */
export function validarFiltro(tipo: TipoManutencaoMassa, filtro: ManutencaoMassaFiltro): string | null {
  const f = normalizarFiltro(filtro);
  if (tipo === "FORNECEDOR") {
    if (!f.farmaciaIds || f.farmaciaIds.length === 0) {
      return "Seleccione pelo menos uma farmácia para a manutenção do fornecedor habitual.";
    }
    if (f.fabricanteDivergente) return "\"Fabricante divergente\" só é aplicável ao tipo Fabricante.";
  } else if (f.fornecedorAtualIds || f.semFornecedor) {
    return "Filtros de fornecedor habitual só são aplicáveis ao tipo Fornecedor.";
  }
  if ((filtro.from && !filtro.to) || (!filtro.from && filtro.to)) {
    return "O período exige data de início e data de fim.";
  }
  if (periodoActivo(filtro)) {
    if (!ISO.test(filtro.from!) || !ISO.test(filtro.to!)) return "Datas inválidas (esperado AAAA-MM-DD).";
  }
  return null;
}

/** Aplica a selecção ao conjunto completo que corresponde ao filtro. NUNCA alarga: só intersecta/exclui. */
export function aplicarSelecao<T extends { chave: string }>(alvos: readonly T[], selecao: SelecaoManutencao | undefined): T[] {
  if (!selecao || selecao.modo === "todos") {
    const excl = new Set(selecao?.excluidas ?? []);
    return excl.size === 0 ? [...alvos] : alvos.filter((a) => !excl.has(a.chave));
  }
  const sel = new Set(selecao.chaves);
  return alvos.filter((a) => sel.has(a.chave));
}
