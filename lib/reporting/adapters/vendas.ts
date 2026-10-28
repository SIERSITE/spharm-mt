/**
 * lib/reporting/adapters/vendas.ts
 *
 * Converte os dados da página Vendas para o formato Report comum.
 * Esta é a ÚNICA peça específica de Vendas na camada de reporting.
 * Toda a lógica de HTML/PDF/Excel/Email vive em lib/reporting/*.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FECHO 2026-06: colunas mensais dinâmicas
 *
 *  As colunas Jan/Fev/Mar/Abr fixas foram removidas. O caller passa
 *  `buckets: { ano, mes }[]` — exactamente o mesmo array devolvido pelo
 *  loader em `SalesPeriodHeader.buckets` — e o adapter gera dinamicamente
 *  N colunas com chaves estáveis `m_YYYYMM` e labels "Mmm/YY". Os rows
 *  recebem o mesmo número de campos `m_YYYYMM`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * REDESENHO 2026-09: densidade + artigo como unidade visual
 *
 *  Vendas passa a ser o primeiro relatório a usar `meta.density:"compact"`
 *  (report-html.ts) — cabeçalho compacto, filtros/resumo em faixa de uma
 *  linha, tabela mais densa. Referência visual: layout tipo "extracto",
 *  meses em duas linhas ("JUL"/"25"), farmácia como sublinha dentro do
 *  artigo (não uma coluna por farmácia).
 *
 *  Duas correcções de dados que este redesenho também resolveu (eram bugs
 *  antigos, não decisões novas):
 *   · `custoUnitarioEstimado` estava DECLARADO como coluna mas nunca era
 *     lido do input — `paraReportRow` não tinha o campo no seu tipo, por
 *     isso a coluna aparecia sempre vazia ("—"), silenciosamente.
 *   · Não existia NENHUMA coluna de valor de vendas (`valorBruto`, já
 *     calculado por `lib/vendas-data.ts` e já somado correctamente por
 *     `agruparPorArtigo` no TOTAL ARTIGO) — o relatório omitia o valor em
 *     euros por completo.
 *  Ambos os campos já existiam nos dados do loader; só não chegavam ao
 *  Report. Corrigido lendo-os em `paraReportRow`, sem tocar em
 *  lib/vendas-data.ts nem em lib/reporting/vendas-agrupamento.ts.
 *
 *  PVP e Custo unit. est. deixaram de ser colunas visíveis no HTML/PDF
 *  nesta primeira versão do redesenho — ver a correcção abaixo, que os
 *  trouxe de volta como colunas (não como sublinha).
 *
 *  Colunas HTML/PDF nesta primeira versão: Código, Descrição (+
 *  sublinha PVP|Custo), Farmácia, N × mês, Total Unid., Stock, Valor
 *  Vendas. Colunas Excel: as mesmas, mais PVP e Custo unit. est.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CORRECÇÃO 2026-09: PVP/Custo têm de ser por FARMÁCIA, nunca por artigo
 *
 *  A versão inicial mostrava PVP/Custo como uma sublinha ("PVP: X |
 *  Custo: Y") presa à Descrição — mas Código/Descrição usam
 *  `spanGroup:true` (rowspan cobrindo todas as sublinhas de farmácia de
 *  um artigo, quando `agruparPor==="artigo"`): só a PRIMEIRA linha do
 *  grupo desenhava essa célula, as restantes ficavam cobertas pelo
 *  rowspan e nunca chegavam a mostrar a sua própria nota. Como cada
 *  farmácia pode ter PVP/custo diferentes para o mesmo CNP (preço de
 *  prateleira e custo médio de compra são por farmácia, não por
 *  produto — ex.: Segurado PVP 6,66€/Custo 4,46€ vs. Silveirense PVP
 *  6,50€/Custo 3,75€), isso mostrava sempre o PVP/custo da PRIMEIRA
 *  farmácia do grupo em TODAS as sublinhas — um valor errado para
 *  qualquer farmácia que não fosse essa.
 *
 *  Corrigido devolvendo PVP e Custo unit. est. a colunas VISÍVEIS no
 *  HTML/PDF (já não `excelOnly`), estreitas, logo a seguir à Farmácia —
 *  nenhuma das duas usa `spanGroup`: desenham em TODAS as sublinhas,
 *  cada uma com o valor da SUA PRÓPRIA farmácia (`ProdutoFarmacia`
 *  desse par produto×farmácia — nunca uma média, nunca o valor de
 *  outra farmácia). O bloco comum do artigo (coberto pelo rowspan) fica
 *  só com CNP e Descrição, que são mesmo do artigo. Na linha TOTAL
 *  ARTIGO — que soma várias farmácias — PVP/Custo não têm resposta
 *  única, por isso ficam "—" (nunca uma média nem um valor escolhido
 *  arbitrariamente). Descrição encolheu de 20% para 17% de largura — já
 *  não precisa de caber a sublinha que saiu de lá.
 *
 *  Colunas HTML/PDF (nesta ordem, versão actual): Código, Descrição,
 *  Farmácia, PVP, Custo unit. est., N × mês, Total Unid., Stock, Valor
 *  Vendas. Colunas Excel: as mesmas (mesma ordem — já não há uma ordem
 *  "só Excel" para PVP/Custo).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type {
  Report,
  ReportColumn,
  ReportFilter,
  ReportRow,
  ReportSummaryItem,
} from "../report-types";
import { GROUP_KEY, ROW_KIND_KEY } from "../report-types";
import { filtroListaImportada } from "../filters-shared";
import { filtroFormaFarmaceuticaLinha, type OpcaoFormaFarmaceutica } from "@/lib/catalog/forma-farmaceutica-filtro";
import { traduzirLaboratoriosParaExport, type CatalogoFilterOptionLaboratorio } from "@/lib/catalog/laboratorio-filtro";
import { nomeFarmaciaCurto } from "../farmacia-nome";
import { formatCell } from "../report-formatters";
import { aplicarPrivacidade } from "../privacidade";
import { rotuloNaturezas } from "../natureza-venda";
import {
  agruparPorArtigo,
  contarReferenciasUnicas,
  grupoPrecisaDeTotal,
} from "../vendas-agrupamento";

const MONTH_LABELS_PT = [
  "Jan", "Fev", "Mar", "Abr", "Mai", "Jun",
  "Jul", "Ago", "Set", "Out", "Nov", "Dez",
];

function bucketColumnKey(b: { ano: number; mes: number }): string {
  // Chave estável "m_YYYYMM" — segura como property name e ordenável.
  return `m_${b.ano}${String(b.mes).padStart(2, "0")}`;
}

/** Chave da coluna «Total unid. do bloco» do bloco `i` (períodos repartidos em blocos). */
export function chaveTotalBloco(i: number): string {
  return `tb_${i}`;
}

function bucketColumnLabel(b: { ano: number; mes: number }): string {
  // Duas linhas ("JAN" + "26") em vez de "JAN/26" numa linha só: com o
  // "/" o rótulo tem 6 caracteres em maiúsculas + letter-spacing, e não
  // cabia na largura mínima da coluna (MIN_WIDTH_MES) — transbordava e
  // ficava cortado em "JAN/…" mesmo com a coluna dentro do orçamento de
  // largura. Partido em duas linhas, cada uma tem no máximo 3
  // caracteres e sobra largura de sobra para qualquer contagem de
  // meses. Ver renderReportHtml() em report-html.ts, que traduz "\n"
  // no rótulo em <br/> no cabeçalho da tabela.
  const yy = String(b.ano).slice(-2);
  return `${MONTH_LABELS_PT[b.mes - 1]}\n${yy}`;
}

/** Bucket mensal — mesma shape que `SalesMonthBucket` no loader. */
export type VendasAdapterMonthBucket = {
  ano: number;
  mes: number;
  quantidade: number;
};

export type VendasAdapterRow = {
  codigo: string;
  descricao: string;
  pvp: number;
  /** `null` = desconhecido (nunca 0 — ver custoDaFarmacia). */
  custoUnitarioEstimado?: number | null;
  /**
   * Custo TOTAL estimado da linha = custo unitário estimado × quantidade
   * líquida (a mesma regra do loader — `valorizar`). `null` = sem custo
   * conhecido (aparece «—» e fica fora do total, que o relatório assinala).
   */
  custoEstimado?: number | null;
  /** Buckets na mesma ordem que `buckets` passado a `buildVendasReport`. */
  meses: VendasAdapterMonthBucket[];
  totalVendas: number;
  /** Valor bruto assinado da janela — ver SalesReportRow.valorBruto. */
  valorBruto?: number;
  existencia: number;
  /**
   * `false` = o stock desta linha é DESCONHECIDO (sem ficha de stock da farmácia ou `stockAtual` nulo) e `existencia` (0) é só um
   * valor de ordenação: nunca se apresenta como zero nem entra no «Stock total», que o assinala como parcial.
   * Ausente/`true` = conhecido.
   */
  existenciaConhecida?: boolean;
  /** Alias legado — pode estar ausente, recomputamos a partir de `totalVendas`. */
  unidadesVendidas?: number;
  fornecedor: string;
  fabricante: string;
  categoria: string;
  farmacia: string;
  grupo: string;
};

export type VendasAdapterFilters = {
  ambito?: string;
  farmaciasSelecionadas?: string[];
  fornecedoresSelecionados?: string[];
  fabricantesSelecionados?: string[];
  /** CHAVES de forma farmacêutica (aplicadas). Vazio/omitido = sem filtro. */
  formasSelecionadas?: string[];
  categoriasSelecionadas?: string[];
  artigo?: string;
  /** ISO yyyy-mm-dd — refletido no subtitle e na lista de filtros. */
  dataInicio?: string;
  dataFim?: string;
  agruparPor?: string;
  ordenarPor?: string;
  apenasComVendas?: boolean;
  apenasComStock?: boolean;
  /** Ver `SharedReportFilters.incluirManutencao`. */
  incluirManutencao?: boolean;
  /** CNP da lista importada por ficheiro. Ver `SharedReportFilters.cnps`. */
  cnps?: number[];
  subcategoriasSelecionadas?: string[];
  utilizacoesSelecionadas?: string[];
  /** Naturezas de venda (ver natureza-venda.ts) — os defaults do relatório oficial se omitidos. */
  incluirCredito?: boolean;
  incluirTransferencias?: boolean;
  /**
   * Descrição da ordenação EFECTIVA quando o utilizador clicou num cabeçalho da tabela (sobrepõe-se ao selector
   * «Ordenar por»). Omitido ⇒ vale `ordenarPor`.
   */
  ordenacaoTabelaDescricao?: string;
  /** «Apenas artigos com PVP diferente entre farmácias» ativo (e aplicável: ≥ 2 farmácias). */
  pvpDiferente?: boolean;
  /** Artigos selecionados para impressão / artigos do resultado. Só se mostra quando é uma seleção PARCIAL. */
  selecaoArtigos?: { selecionados: number; total: number };
};

/** Campos das linhas que são informação de venda / de compra (retirados do `Report` quando a respetiva classe está desligada). */
const CHAVES_VENDA = ["pvp", "valorBruto"];
const CHAVES_COMPRA = ["custoUnitarioEstimado", "custoEstimado"];

/** Texto do filtro «PVP diferente entre farmácias» — um sítio só (ecrã, relatório, filtros das saídas). */
export const ROTULO_FILTRO_PVP_DIFERENTE = "Apenas artigos com PVP diferente entre farmácias";

const ROTULO_AMBITO: Record<string, string> = { farmacia: "Farmácia", grupo: "Grupo", comparativo: "Comparativo" };
const ROTULO_AGRUPAR: Record<string, string> = {
  artigo: "Artigo", grupo: "Grupo", fornecedor: "Distribuidor", fabricante: "Fabricante", categoria: "Categoria", farmacia: "Farmácia",
};
const ROTULO_ORDENAR: Record<string, string> = {
  descricao: "Descrição do artigo (A-Z)", totalVendas: "Total vendas", codigo: "Código", existencia: "Existência",
};

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * LARGURAS CALCULADAS PELO CONTEÚDO (2026-10)
 *
 * Causa do defeito «Custo total est. cortado acima de 9 999,99 €»: as colunas tinham percentagens FIXAS (7 % …) e as
 * células têm `overflow:hidden`. «10 000,00 €» (11 caracteres) já não cabia em 7 % de uma página com 13 meses, e o PDF
 * mostrava «10 000,0»; o «TOTAL GERAL» (1.ª coluna, CNP) aparecia como «TOTA». Agora cada coluna monetária/numérica
 * recebe a largura do SEU texto mais largo (linhas, subtotais e total geral incluídos), medida com uma métrica
 * conservadora (a de uma fonte larga, DejaVu — a que o Chromium do contentor usa se não houver Arial). A Descrição fica
 * com o resto; é a única coluna que pode quebrar linha.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Largura útil de uma página A4 horizontal com margens de 8 mm: 281 mm ≈ 1062 px. */
const LARGURA_UTIL_PX = 1062;

/** Máximo de colunas de mês por página/bloco. Acima disto o período reparte-se em blocos (ver `repartirMeses`). */
export const MAX_MESES_POR_BLOCO = 13;

/** Largura mínima da Descrição (em %) abaixo da qual a página deixava de ser legível — os testes garantem que nunca se atinge. */
export const DESCRICAO_MIN_PCT = 11;
const DESCRICAO_PREFERIDA_PCT = 14;
/** Largura confortável de uma coluna de mês e o mínimo absoluto (3 dígitos + sinal). */
const MES_CONFORTO_PCT = 4.2;
const MES_MINIMO_PCT = 2.6;

type Densidade = "cozy" | "tight" | "ultratight";

/** Fontes/paddings reais do CSS (report-html.ts, `.table-density-*`). */
const METRICAS: Record<Densidade, { td: number; th: number; pad: number }> = {
  cozy: { td: 10, th: 9, pad: 5 },
  tight: { td: 9, th: 8, pad: 4 },
  ultratight: { td: 8.5, th: 7.5, pad: 3 },
};

/** Largura estimada, em px, de um texto — por excesso (dígito de uma fonte larga ≈ 0.64 em). */
function larguraTextoPx(texto: string, fontPx: number, negrito: boolean): number {
  let em = 0;
  for (const ch of texto) {
    if (/[0-9€]/.test(ch)) em += 0.64;
    else if (/[\s.,  ·–—'-]/.test(ch)) em += 0.34;
    else if (/[A-Z]/.test(ch)) em += 0.72;
    else em += 0.62;
  }
  return em * fontPx * (negrito ? 1.1 : 1);
}

/** Largura, em % da página, de uma coluna que tem de mostrar TODOS estes textos e este cabeçalho sem cortar. */
/** Aumento dos NÚMEROS (valores, quantidades, stock, totais) face ao texto da tabela, em px — ver `.num` em report-html.ts. */
export const AUMENTO_NUMEROS_PX = 1;

function colunaPct(textos: string[], cabecalho: string, d: Densidade, extraPx = 0, numerico = true): number {
  const m = METRICAS[d];
  let max = 0;
  const tdPx = m.td + (numerico ? AUMENTO_NUMEROS_PX : 0);
  // negrito por excesso: as linhas de subtotal/total partilham a coluna.
  for (const t of textos) max = Math.max(max, larguraTextoPx(t, tdPx, true));
  max += extraPx;
  for (const linha of cabecalho.split("\n")) max = Math.max(max, larguraTextoPx(linha, m.th, true));
  const px = max + 2 * m.pad + 3; // padding + bordas
  return (px / LARGURA_UTIL_PX) * 100 * 1.04;
}

/**
 * Regra para períodos longos: até MAX_MESES_POR_BLOCO (13) meses, uma coluna por mês numa só tabela; acima, o período
 * reparte-se em ceil(n / 13) blocos de tamanho o mais igual possível (14 → 7+7; 24 → 12+12; 27 → 9+9+9; 28 → 10+9+9), cada um numa
 * página nova com a identificação do artigo e os totais do PERÍODO COMPLETO repetidos. Nunca se corta nem se esconde um mês.
 */
export function repartirMeses(n: number): number[] {
  if (n <= 0) return [];
  const blocos = Math.ceil(n / MAX_MESES_POR_BLOCO);
  const base = Math.floor(n / blocos);
  const resto = n % blocos;
  return Array.from({ length: blocos }, (_, i) => base + (i < resto ? 1 : 0));
}

function tableDensityFor(mesesPorBloco: number): Densidade {
  if (mesesPorBloco <= 6) return "cozy";
  if (mesesPorBloco <= 10) return "tight";
  return "ultratight";
}

/** Textos já formatados (como o HTML/PDF os vai desenhar) de cada coluna, para medir a largura. */
export type TextosDasColunas = {
  codigo: string[];
  farmacia: string[];
  pvp: string[];
  custoUnitario: string[];
  custoTotal: string[];
  valor: string[];
  totalUnid: string[];
  stock: string[];
  mes: string[];
  /** «Total unid. do bloco» (só com períodos repartidos em blocos). */
  totalBloco: string[];
};

/** Mais 2 px (as duas bordas finas) na coluna «Total unid.», que tem fundo e filetes próprios. */
const EXTRA_COLUNA_DESTACADA_PX = 2;

function buildColumns(
  buckets: { ano: number; mes: number }[],
  textos: TextosDasColunas,
  /** Preços de venda (PVP, valor de vendas) e de compra (custos): colunas que não existem quando a classe está desligada. */
  incluirVenda: boolean,
  incluirCompra: boolean,
): { columns: ReportColumn[]; density: Densidade; descricaoPct: number } {
  const plano = repartirMeses(buckets.length);
  const emBlocos = plano.length > 1;
  const mesesPorBloco = Math.max(0, ...plano);
  const density = tableDensityFor(mesesPorBloco);

  const w = {
    codigo: colunaPct(textos.codigo, "CNP", density, 0, false),
    farmacia: colunaPct([...textos.farmacia, "TOTAL ARTIGO"], "Farmácia", density, 0, false),
    // Colunas monetárias: só medidas (e só existem) quando a respetiva classe de preços está incluída.
    pvp: incluirVenda ? colunaPct(textos.pvp, "PVP", density) : 0,
    custoUnitario: incluirCompra ? colunaPct(textos.custoUnitario, "Custo\nunit. est.", density) : 0,
    custoTotal: incluirCompra ? colunaPct(textos.custoTotal, emBlocos ? "Período: custo\ntotal est." : "Custo total\nest.", density) : 0,
    totalUnid: colunaPct(textos.totalUnid, emBlocos ? "Período:\nTotal unid." : "Total\nUnid.", density, EXTRA_COLUNA_DESTACADA_PX),
    totalBloco: emBlocos ? colunaPct(textos.totalBloco, "Total unid.\ndo bloco", density, EXTRA_COLUNA_DESTACADA_PX) : 0,
    // +8 px: a caixa/inversão do indicador de stock (padding + moldura).
    stock: colunaPct(textos.stock, "Stock", density, 8),
    valor: incluirVenda ? colunaPct(textos.valor, emBlocos ? "Período: valor\nvendas (s/IVA)" : "Valor Vendas\n(s/IVA)", density) : 0,
  };
  const fixos = w.codigo + w.farmacia + w.pvp + w.custoUnitario + w.custoTotal + w.totalUnid + w.stock + w.valor + w.totalBloco;
  const mesMin = Math.max(MES_MINIMO_PCT, colunaPct(textos.mes, "Mmm\n00", density));

  // Meses: confortáveis se sobra espaço; senão encolhem até ao mínimo do CONTEÚDO — nunca abaixo (cortava o número).
  const disponivel = 100 - fixos;
  // Poucos meses: colunas de mês mais largas (relatório arejado, como no de referência); muitos: o conforto de sempre.
  const conforto = mesesPorBloco <= 6 ? 6.2 : MES_CONFORTO_PCT;
  let perMonth = mesesPorBloco > 0 ? Math.max(mesMin, conforto) : 0;
  if (mesesPorBloco > 0 && disponivel - perMonth * mesesPorBloco < (mesesPorBloco <= 6 ? 22 : DESCRICAO_PREFERIDA_PCT)) {
    perMonth = Math.max(mesMin, (disponivel - (mesesPorBloco <= 6 ? 22 : DESCRICAO_PREFERIDA_PCT)) / mesesPorBloco);
  }
  const descricaoPct = Math.max(0, disponivel - perMonth * mesesPorBloco);

  const monthColumns: ReportColumn[] = buckets.map((b) => ({
    key: bucketColumnKey(b),
    label: bucketColumnLabel(b),
    format: "integer" as const,
    width: perMonth,
    showTotal: true,
    // Mês sem venda = «·» (um ponto médio discreto); negativos (devoluções) aparecem com o sinal.
    zeroAsDash: true,
    zeroText: "·",
    // Fundo alternado muito discreto por mês (sem tom «info» nas células com venda).
    monthAlt: true,
  }));

  const cCodigo: ReportColumn = {
    key: "codigo", label: "CNP", format: "text", width: w.codigo,
    // Só desenha na 1ª linha de cada artigo — as sublinhas por farmácia (e a linha TOTAL ARTIGO) ficam cobertas pelo rowspan.
    spanGroup: true,
  };
  const cDescricao: ReportColumn = { key: "descricao", label: "Descrição", format: "text", width: descricaoPct, spanGroup: true };
  const cFarmacia: ReportColumn = {
    key: "farmacia", label: "Farmácia", format: "text", width: w.farmacia, noClip: true,
    // Mostra "Segurado", não "Farmácia Segurado" — só na apresentação; o Excel lê `farmacia` (nome completo).
    displayKey: "farmaciaCurta",
  };
  // PVP e Custo unit. est.: por FARMÁCIA (cada uma tem o seu), nunca uma média; na linha TOTAL ARTIGO ficam «—».
  const cPvp: ReportColumn = { key: "pvp", label: "PVP", format: "currency", width: w.pvp, noClip: true, sensivel: "venda" };
  const cCustoUnit: ReportColumn = { key: "custoUnitarioEstimado", label: "Custo\nunit. est.", format: "currency", width: w.custoUnitario, noClip: true, sensivel: "compra" };
  // Custo TOTAL estimado = custo unit. est. × quantidade líquida. Soma-se; linhas sem custo ficam «—» e fora da soma.
  const cCustoTotal: ReportColumn = { key: "custoEstimado", label: emBlocos ? "Período: custo\ntotal est." : "Custo total\nest.", format: "currency", width: w.custoTotal, showTotal: true, noClip: true, sensivel: "compra" };
  // «Total unid.» = unidades VENDIDAS no período: fundo próprio (`tint`), entre os meses e o stock atual.
  const cTotalUnid: ReportColumn = { key: "totalVendas", label: emBlocos ? "Período:\nTotal unid." : "Total\nUnid.", format: "integer", width: w.totalUnid, showTotal: true, noClip: true, tint: "total" };
  const cStock: ReportColumn = {
    key: "existencia", label: "Stock", format: "integer", width: w.stock, noClip: true,
    // «Stock total» no TOTAL GERAL: soma do stock ATUAL das combinações produto/farmácia (nunca somado por mês).
    showTotal: true,
    // Com stock / sem stock (0) / negativo — legível a preto e branco (ver `stockIndicator`).
    stockIndicator: true,
    // Stock a zero é um sinal operacional (ruptura); positivo é o estado normal — tons suaves, só reforço da caixa/inversão.
    toneWhenZero: "danger",
    toneWhenPositive: "success",
  };
  const cValor: ReportColumn = { key: "valorBruto", label: emBlocos ? "Período: valor\nvendas (s/IVA)" : "Valor Vendas\n(s/IVA)", format: "currency", width: w.valor, showTotal: true, noClip: true, sensivel: "venda" };
  // Só no Excel: distingue linhas de detalhe de «Total artigo» para filtrar/somar sem contar duas vezes.
  const cTipo: ReportColumn = { key: "tipoLinha", label: "Tipo de linha", format: "text", excelOnly: true };

  // Classe de preços desligada: SEM nenhuma coluna dessa classe (nem vazia, nem reservada) — a Descrição ganha o espaço.
  const precosEsq = [...(incluirVenda ? [cPvp] : []), ...(incluirCompra ? [cCustoUnit] : [])];
  let columns: ReportColumn[];
  if (!emBlocos) {
    columns = [
      cCodigo, cDescricao, cFarmacia, ...precosEsq, ...(incluirCompra ? [cCustoTotal] : []),
      ...monthColumns, cTotalUnid, cStock, ...(incluirVenda ? [cValor] : []), cTipo,
    ];
  } else {
    // Períodos longos: cada bloco mostra os SEUS meses e «Total unid. do bloco» (soma só desses meses). Os totais do
    // período completo (unidades, custo, valor) vivem em colunas «Período: …» que só existem no ÚLTIMO bloco.
    const totaisBloco: ReportColumn[] = plano.map((_, i) => ({
      key: chaveTotalBloco(i), label: "Total unid.\ndo bloco", format: "integer" as const, width: w.totalBloco, showTotal: true, noClip: true, htmlOnly: true, tint: "total" as const,
    }));
    // meses → total do bloco → total do período → stock atual (a mesma sequência do mapa sem blocos).
    columns = [cCodigo, cDescricao, cFarmacia, ...precosEsq, ...monthColumns, ...totaisBloco, cTotalUnid, cStock, ...(incluirCompra ? [cCustoTotal] : []), ...(incluirVenda ? [cValor] : []), cTipo];
  }
  return { columns, density, descricaoPct };
}

function joinList(list: string[] | undefined, total: number, labelTodas: string, separador = ", "): string {
  if (!list || list.length === 0) return labelTodas;
  if (list.length === total) return labelTodas;
  if (list.length <= 3) return list.join(separador);
  return `${list.slice(0, 3).join(separador)} (+${list.length - 3})`;
}

function buildFilters(
  f: VendasAdapterFilters,
  universe: {
    farmacias: string[];
    fornecedores: string[];
    fabricantes: string[];
    /** SÓ garantia — ver o mesmo campo em ReportFilterOptions (lib/reporting/filters-shared.ts). */
    laboratorios?: CatalogoFilterOptionLaboratorio[];
    /** Opções de forma farmacêutica (para os RÓTULOS das chaves seleccionadas). */
    formas?: OpcaoFormaFarmaceutica[];
    categorias: string[];
  }
): ReportFilter[] {
  const out: ReportFilter[] = [];

  if (f.dataInicio && f.dataFim) {
    out.push({ label: "Período", value: `${f.dataInicio} a ${f.dataFim}` });
  }
  if (f.ambito) {
    out.push({ label: "Âmbito", value: ROTULO_AMBITO[f.ambito] ?? f.ambito });
  }
  out.push({
    label: "Farmácias",
    value: joinList(f.farmaciasSelecionadas, universe.farmacias.length, "Todas"),
  });
  if (f.fornecedoresSelecionados && f.fornecedoresSelecionados.length > 0) {
    out.push({
      label: "Distribuidores",
      value: joinList(f.fornecedoresSelecionados, universe.fornecedores.length, "Todos"),
    });
  }
  if (f.fabricantesSelecionados && f.fabricantesSelecionados.length > 0) {
    // Rótulo: "Laboratório/grupo" em garantia (universe.laboratorios
    // presente), "Fabricantes" nos restantes tenants — inalterado. Os
    // valores tipados "grupo:<id>"/"fabricante:<id>" são traduzidos para
    // "Grupo: X"/"Fabricante: Y" ANTES de entrarem no PDF/Excel — nunca
    // um id interno chega ao cliente.
    out.push({
      label: universe.laboratorios ? (f.fabricantesSelecionados.length === 1 ? "Laboratório/grupo" : "Laboratórios/grupos") : "Fabricantes",
      value: joinList(
        traduzirLaboratoriosParaExport(f.fabricantesSelecionados, universe.laboratorios),
        (universe.laboratorios ?? universe.fabricantes).length,
        "Todos",
        universe.laboratorios ? "; " : ", ",
      ),
    });
  }
  if (f.categoriasSelecionadas && f.categoriasSelecionadas.length > 0) {
    out.push({
      label: "Categorias",
      value: joinList(f.categoriasSelecionadas, universe.categorias.length, "Todas"),
    });
  }
  if (f.subcategoriasSelecionadas && f.subcategoriasSelecionadas.length > 0) {
    out.push({ label: "Subcategorias", value: joinList(f.subcategoriasSelecionadas, 0, "Todas") });
  }
  if (f.utilizacoesSelecionadas && f.utilizacoesSelecionadas.length > 0) {
    out.push({ label: "Utilizações", value: joinList(f.utilizacoesSelecionadas, 0, "Todas") });
  }
  const forma = filtroFormaFarmaceuticaLinha(f.formasSelecionadas, universe.formas);
  if (forma) out.push(forma);
  const lista = filtroListaImportada(f.cnps);
  if (lista) out.push(lista);
  if (f.artigo && f.artigo.trim()) {
    out.push({ label: "Pesquisa", value: f.artigo.trim() });
  }
  if (f.agruparPor) out.push({ label: "Agrupar por", value: ROTULO_AGRUPAR[f.agruparPor] ?? f.agruparPor });
  const ordem = f.ordenacaoTabelaDescricao ?? (f.ordenarPor ? ROTULO_ORDENAR[f.ordenarPor] ?? f.ordenarPor : undefined);
  if (ordem) out.push({ label: "Ordenar por", value: ordem });
  // Naturezas de venda: SEMPRE aplicadas (têm defaults), por isso sempre listadas.
  out.push({ label: "Naturezas", value: `Normal; ${rotuloNaturezas(f)}` });
  // Universo de artigos. Com «Incluir stock sem vendas» a regra é «vendas > 0 OU stock > 0» (passaTogglesRapidosVendas):
  // ligar os dois interruptores NÃO é uma contradição nem um «E» — entram os artigos com vendas no período e, a mais,
  // os sem vendas que têm stock. Diz-se numa frase só, sem listar dois filtros que parecem opostos.
  if (f.apenasComStock) {
    out.push({
      label: "Artigos incluídos",
      value: "com vendas no período + sem vendas mas com stock atual",
    });
  } else if (f.apenasComVendas) {
    out.push({ label: "Artigos incluídos", value: "apenas com vendas no período" });
  }
  if (f.incluirManutencao) out.push({ label: "Incluir manutenção de vendas", value: "Sim" });
  // Diz-se SEMPRE que o filtro está ativo, mesmo sem preços de venda no documento (os PVP não aparecem; a frase sim).
  if (f.pvpDiferente) out.push({ label: ROTULO_FILTRO_PVP_DIFERENTE, value: "Sim" });
  if (f.selecaoArtigos && f.selecaoArtigos.selecionados < f.selecaoArtigos.total) {
    out.push({
      label: "Artigos",
      value: `${f.selecaoArtigos.selecionados} de ${f.selecaoArtigos.total} selecionados`,
    });
  }

  return out;
}

/**
 * O resumo conta SEMPRE sobre o detalhe.
 *
 * `rows` aqui são as linhas de dados — as de subtotal são construídas
 * depois, em `buildVendasReport`, e nunca chegam a esta função. É o que
 * garante que uma linha "TOTAL ARTIGO" não soma unidades duas vezes.
 *
 * "Linhas" e "Referências únicas" respondem a perguntas diferentes, e é
 * por isso que são dois itens: o mesmo CNP em duas farmácias são duas
 * linhas de detalhe e UMA referência.
 *
 * Continua a existir e a ser calculado — só deixa de aparecer como
 * cartões no HTML/PDF compacto (renderSummary devolve "" quando
 * `meta.density==="compact"`, ver report-html.ts); o TOTAL GERAL da
 * tabela já mostra as unidades e o valor. Excel/email continuam a
 * receber estes 4 itens tal como sempre.
 */
/**
 * Custo total estimado do conjunto de linhas e quantas linhas ficaram de fora
 * por não terem custo conhecido (nunca se inventa custo; um total que
 * ignora linhas sem custo não pode apresentar-se como completo).
 */
export function custoTotalDoRelatorio(rows: ReadonlyArray<Pick<VendasAdapterRow, "custoEstimado" | "totalVendas">>): { total: number; semCusto: number } {
  let total = 0;
  let semCusto = 0;
  for (const r of rows) {
    if (r.custoEstimado === null || r.custoEstimado === undefined || !Number.isFinite(r.custoEstimado)) {
      if ((r.totalVendas ?? 0) !== 0) semCusto += 1;
      continue;
    }
    total += r.custoEstimado;
  }
  return { total: Math.round(total * 100) / 100, semCusto };
}

/**
 * «Stock total» = soma do stock ATUAL das combinações produto/farmácia incluídas, cada uma contada UMA vez (nunca por mês).
 * O stock desconhecido (`existenciaConhecida === false`) não é convertido em zero: fica fora da soma e conta-se à parte.
 * Negativo entra com sinal; zero entra como zero.
 */
export function stockTotalDoRelatorio(rows: ReadonlyArray<Pick<VendasAdapterRow, "existencia" | "existenciaConhecida">>): { total: number; desconhecidas: number } {
  let total = 0;
  let desconhecidas = 0;
  for (const r of rows) {
    if (r.existenciaConhecida === false) {
      desconhecidas += 1;
      continue;
    }
    total += r.existencia ?? 0;
  }
  return { total, desconhecidas };
}

function buildSummary(rows: VendasAdapterRow[]): ReportSummaryItem[] {
  let totalUnidades = 0;
  let valorEstimadoPvp = 0;
  for (const r of rows) {
    totalUnidades += r.totalVendas ?? 0;
    valorEstimadoPvp += (r.totalVendas ?? 0) * (r.pvp ?? 0);
  }
  const referencias = contarReferenciasUnicas(rows);
  const custo = custoTotalDoRelatorio(rows);
  const stock = stockTotalDoRelatorio(rows);
  // Os itens monetários levam `sensivel`: `aplicarPrivacidade` retira-os quando a respetiva classe de preços está desligada.
  return [
    { label: "Linhas",             value: rows.length,       format: "integer" },
    { label: "Referências únicas", value: referencias,       format: "integer" },
    { label: "Unidades vendidas",  value: totalUnidades,     format: "integer" },
    { label: "Stock total",        value: stock.total,       format: "integer" },
    ...(stock.desconhecidas > 0
      ? [{ label: "Linhas sem stock conhecido (fora do stock total)", value: stock.desconhecidas, format: "integer" as const }]
      : []),
    { label: "Valor PVP estimado", value: valorEstimadoPvp,  format: "currency", sensivel: "venda" },
    { label: "Custo total estimado", value: custo.total,     format: "currency", sensivel: "compra" },
    ...(custo.semCusto > 0
      ? [{ label: "Linhas sem custo (fora do custo total)", value: custo.semCusto, format: "integer" as const, sensivel: "compra" as const }]
      : []),
  ];
}

export function buildVendasReport(input: {
  /**
   * «Incluir preços de venda»: `false` ⇒ o relatório não leva PVP, valor de vendas (s/IVA) nem totais/avisos de venda.
   * Por omissão `true`. Os cálculos continuam a existir; só não se apresentam (nem viajam no `Report`).
   */
  incluirPrecosVenda?: boolean;
  /**
   * «Incluir preços de compra»: `false` ⇒ o relatório não leva custo unitário/total estimado, subtotais/totais de custo,
   * «PARCIAL» nem avisos de custo em falta. Por omissão `true`.
   */
  incluirPrecosCompra?: boolean;
  rows: VendasAdapterRow[];
  /**
   * Mesma lista de buckets devolvida pelo loader em
   * `SalesPeriodHeader.buckets`. Determina (a) as colunas mensais
   * geradas e (b) a ordem dos valores em cada `row.meses`.
   */
  buckets: { ano: number; mes: number }[];
  filters: VendasAdapterFilters;
  universe: {
    farmacias: string[];
    fornecedores: string[];
    fabricantes: string[];
    /** SÓ garantia — ver o mesmo campo em ReportFilterOptions (lib/reporting/filters-shared.ts). */
    laboratorios?: CatalogoFilterOptionLaboratorio[];
    formas?: OpcaoFormaFarmaceutica[];
    categorias: string[];
  };
  /**
   * Texto do cabeçalho (nome da farmácia + ANF quando há só uma,
   * ou descrição do grupo quando há várias). Vindo de
   * lib/farmacias-header.ts → formatFarmaciaHeader(), nunca hardcoded.
   */
  organization: string;
}): Report {
  // Mapeia uma linha (detalhe ou subtotal) para o formato dinâmico de
  // ReportRow (chaves m_YYYYMM alinhadas com `buildColumns`).
  const paraReportRow = (
    r: {
      codigo: string;
      descricao: string;
      pvp?: number | null;
      /** Correcção 2026-09: existia na coluna, nunca era lido aqui. */
      custoUnitarioEstimado?: number | null;
      /** Custo total estimado (custo unit. × quantidade líquida); `null` = sem custo. */
      custoEstimado?: number | null;
      totalVendas: number;
      /** Correcção 2026-09: não existia coluna nenhuma para isto. */
      valorBruto?: number;
      existencia: number;
      /** `false` = stock desconhecido: a célula fica «—» (nunca 0). */
      existenciaConhecida?: boolean;
      farmacia: string;
      meses: { ano: number; mes: number; quantidade: number }[];
    },
    kind: "detalhe" | "subtotal",
    grupoId: string | undefined,
  ): ReportRow => {
    // PVP é da prateleira de UMA farmácia — nunca uma média entre
    // farmácias. Na linha TOTAL ARTIGO (soma de farmácias) fica `null`,
    // que o renderer pinta como "—" (ver formatCell em report-formatters).
    const pvp = kind === "subtotal" ? null : (r.pvp ?? 0);
    // Custo unitário: idem PVP — um "custo médio entre farmácias" não é
    // uma pergunta com resposta única.
    const custo = kind === "subtotal" ? null : (r.custoUnitarioEstimado ?? null);
    const base: ReportRow = {
      codigo: r.codigo,
      descricao: r.descricao,
      pvp,
      custoUnitarioEstimado: custo,
      // O total de custo SOMA-se (ao contrário do unitário): no TOTAL ARTIGO é a
      // soma dos custos das farmácias com custo conhecido (`agregarCusto`).
      custoEstimado: r.custoEstimado ?? null,
      totalVendas: r.totalVendas,
      valorBruto: r.valorBruto ?? 0,
      existencia: r.existenciaConhecida === false ? null : r.existencia,
      // `farmacia` é o nome REAL, intocado — usado por Excel, ordenação,
      // agrupamento. `farmaciaCurta` é só a apresentação HTML/PDF (ver
      // `displayKey` em buildColumns). "TOTAL ARTIGO" não tem o prefixo
      // "Farmácia " — nomeFarmaciaCurto() não lhe mexe.
      farmacia: r.farmacia,
      farmaciaCurta: nomeFarmaciaCurto(r.farmacia),
      tipoLinha: kind === "subtotal" ? "Total artigo" : "Detalhe",
      [ROW_KIND_KEY]: kind,
    };
    if (grupoId !== undefined) base[GROUP_KEY] = grupoId;
    // Indexação por posição (segura porque o loader devolve `meses` na
    // mesma ordem de `buckets`); fallback por (ano,mes) match se faltar.
    input.buckets.forEach((b, i) => {
      const fromPos = r.meses[i];
      const matched =
        fromPos && fromPos.ano === b.ano && fromPos.mes === b.mes
          ? fromPos
          : r.meses.find((m) => m.ano === b.ano && m.mes === b.mes);
      base[bucketColumnKey(b)] = matched?.quantidade ?? 0;
    });
    return base;
  };

  // ── AGRUPAR POR ARTIGO: detalhe por farmácia + TOTAL ARTIGO ────────
  //
  // Só quando o utilizador pediu "Artigo". Nos outros agrupamentos o
  // relatório fica exactamente como estava — incluindo "Farmácia", onde
  // não se introduzem subtotais por artigo NEM `GROUP_KEY` (uma linha
  // "solta" nunca ganha rowspan — ver `agruparPorGroupKey`).
  const hierarquico = input.filters.agruparPor === "artigo";
  const rowsForReport: ReportRow[] = hierarquico
    // `input.universe.farmacias` é a ordem "já definida/recebida pelo
    // relatório" (alfabética, deduplicada — ver vendas-client.tsx) —
    // é o que garante que a mesma farmácia aparece sempre na mesma
    // posição em TODOS os artigos, nunca pela ordem incidental das
    // linhas de venda/stock. Ver compararPorOrdemFarmacia.
    ? agruparPorArtigo(input.rows, input.buckets, input.universe.farmacias).flatMap((g) => {
        // O GRUPO VISUAL inclui a linha TOTAL ARTIGO (quando existe): é
        // assim que a referência mostra o bloco do artigo — CNP/Descrição
        // vertical-centrados cobrindo as farmácias E o total, com o total
        // a distinguir-se só pelo próprio estilo de `.subtotal-row`.
        const detalhes = g.detalhes.map((d) => paraReportRow(d, "detalhe", g.codigo));
        // Um artigo numa farmácia só não leva linha de total: seria uma
        // cópia da linha acima.
        if (!grupoPrecisaDeTotal(g)) return detalhes;
        // TOTAL ARTIGO: soma do stock CONHECIDO das farmácias do artigo; «—» só se nenhuma o conhece.
        const todasDesconhecidas = g.detalhes.every((d) => d.existenciaConhecida === false);
        return [...detalhes, paraReportRow({ ...g.total, existenciaConhecida: todasDesconhecidas ? false : true }, "subtotal", g.codigo)];
      })
    : input.rows.map((r) => paraReportRow(r, "detalhe", undefined));

  const subtitle =
    input.filters.dataInicio && input.filters.dataFim
      ? `Período ${input.filters.dataInicio} a ${input.filters.dataFim}`
      : undefined;

  // ── Larguras pelo conteúdo + blocos temporais ───────────────────────
  const detalhe = rowsForReport.filter((r) => r[ROW_KIND_KEY] !== "subtotal");
  const somaDe = (k: string) => detalhe.reduce((acc, r) => acc + (typeof r[k] === "number" ? (r[k] as number) : 0), 0);
  const fmt = (v: unknown, f: "currency" | "integer") => formatCell(v as number | null, f);
  const strs = (k: string, f: "currency" | "integer") => rowsForReport.map((r) => fmt(r[k], f));
  const custoGeral = custoTotalDoRelatorio(input.rows);
  const textos: TextosDasColunas = {
    codigo: rowsForReport.map((r) => String(r.codigo ?? "")),
    farmacia: rowsForReport.map((r) => String(r.farmaciaCurta ?? "")),
    pvp: strs("pvp", "currency"),
    custoUnitario: strs("custoUnitarioEstimado", "currency"),
    custoTotal: [...strs("custoEstimado", "currency"), fmt(custoGeral.total, "currency")],
    valor: [...strs("valorBruto", "currency"), fmt(somaDe("valorBruto"), "currency")],
    totalUnid: [...strs("totalVendas", "integer"), fmt(somaDe("totalVendas"), "integer")],
    stock: [...strs("existencia", "integer"), fmt(stockTotalDoRelatorio(input.rows).total, "integer")],
    mes: input.buckets.flatMap((b) => {
      const k = bucketColumnKey(b);
      return [...rowsForReport.map((r) => fmt(r[k], "integer")), fmt(somaDe(k), "integer")];
    }),
    totalBloco: [],
  };
  // «Total unid. do bloco»: soma, por linha, dos meses de cada bloco (só quando o período se reparte em blocos).
  const planoMeses = repartirMeses(input.buckets.length);
  if (planoMeses.length > 1) {
    let ini = 0;
    planoMeses.forEach((n, i) => {
      const chaves = input.buckets.slice(ini, ini + n).map(bucketColumnKey);
      ini += n;
      for (const r of rowsForReport) r[chaveTotalBloco(i)] = chaves.reduce((acc, k) => acc + Number(r[k] ?? 0), 0);
      textos.totalBloco.push(...rowsForReport.map((r) => fmt(r[chaveTotalBloco(i)], "integer")), fmt(detalhe.reduce((acc, r) => acc + Number(r[chaveTotalBloco(i)] ?? 0), 0), "integer"));
    });
  }
  const incluirVenda = input.incluirPrecosVenda !== false;
  const incluirCompra = input.incluirPrecosCompra !== false;
  const { columns, density } = buildColumns(input.buckets, textos, incluirVenda, incluirCompra);

  // Períodos longos: blocos temporais (ver `repartirMeses`). Até 13 meses não há blocos.
  const partes = repartirMeses(input.buckets.length);
  let columnBlocks: { titulo: string; omitir: string[] }[] | undefined;
  if (partes.length > 1) {
    let inicio = 0;
    const todasMeses = input.buckets.map(bucketColumnKey);
    const colunasPeriodo = ["totalVendas", "custoEstimado", "valorBruto"];
    columnBlocks = partes.map((n, i) => {
      const doBloco = input.buckets.slice(inicio, inicio + n);
      inicio += n;
      const chaves = new Set(doBloco.map(bucketColumnKey));
      const ultimo = i === partes.length - 1;
      const rotulo = (b: { ano: number; mes: number }) => `${MONTH_LABELS_PT[b.mes - 1]}/${String(b.ano).slice(-2)}`;
      return {
        titulo: `Meses ${rotulo(doBloco[0])} a ${rotulo(doBloco[doBloco.length - 1])} · «Total unid. do bloco» soma apenas estes meses` + (ultimo ? " · colunas «Período:» e TOTAL GERAL = período completo" : ""),
        omitir: [
          ...todasMeses.filter((k) => !chaves.has(k)),
          ...partes.map((_, j) => chaveTotalBloco(j)).filter((_, j) => j !== i),
          ...(ultimo ? [] : colunasPeriodo),
        ],
      };
    });
  }

  const artigos = new Set(input.rows.map((r) => r.codigo)).size;
  const semCusto = custoGeral.semCusto;
  const stockGeral = stockTotalDoRelatorio(input.rows);
  const nota = [
    "Stock atual à data de geração do relatório (não histórico); o Stock total soma o stock atual de cada artigo/farmácia (não se soma por mês). Stock: número simples = com stock; número em caixa = 0; fundo escuro = negativo.",
    stockGeral.desconhecidas > 0
      ? `Stock total PARCIAL: ${stockGeral.desconhecidas} linha(s) sem stock conhecido ficam fora do total (aparecem «—»).`
      : "",
    incluirCompra
      ? "Custo unit. est. pelo PMC/PUC atual da ficha — não é o custo à data da venda; Custo total est. = custo unit. est. × quantidade líquida."
      : "",
    incluirVenda ? "Valor de vendas sem IVA." : "",
    "«·» = sem vendas no mês; valores negativos = devoluções/anulações acima das vendas.",
    incluirCompra && semCusto > 0
      ? `Custo total PARCIAL: ${semCusto} linha(s) sem custo conhecido ficam fora do total (aparecem «—»).`
      : "",
    columnBlocks
      ? `Período de ${input.buckets.length} meses em ${columnBlocks.length} blocos de, no máximo, ${MAX_MESES_POR_BLOCO} meses (cabeçalho repetido em cada página): «Total unid. do bloco» soma só os meses do bloco; as colunas «Período:» e o TOTAL GERAL só aparecem no fim do último bloco.`
      : "",
  ].filter(Boolean).join(" ");

  const relatorio: Report = {
    title: "Relatório de Vendas",
    subtitle,
    generatedAt: new Date(),
    filtersApplied: buildFilters(input.filters, input.universe),
    summary: buildSummary(input.rows),
    columns,
    rows: rowsForReport,
    meta: {
      slug: "vendas",
      orientation: "landscape",
      organization: input.organization,
      // Primeiro relatório a adoptar a linguagem visual compacta — ver
      // report-html.ts. Os restantes ficam no default ("comfortable")
      // até serem validados e migrados um a um.
      density: "compact",
      // Impressão/PDF: hierarquia que sobrevive a papel e a preto e branco
      // (borda forte por artigo, blocos alternados, TOTAL ARTIGO escuro).
      hierarchy: "clean",
      tableDensity: density,
      columnBlocks,
      tableNote: `${artigos} artigo${artigos === 1 ? "" : "s"} · ${input.rows.length} linha${input.rows.length === 1 ? "" : "s"} de detalhe`,
      totalLabel: "TOTAL GERAL",
      excelFilterable: true,
      // Que informação comercial o relatório pode levar. Os geradores de saída (HTML/PDF/Excel/email) reaplicam
      // `aplicarPrivacidade` com isto, por isso nada sensível sai mesmo que o `Report` seja reencaminhado ou adulterado.
      privacidade: { precosVenda: incluirVenda, precosCompra: incluirCompra, chavesVenda: CHAVES_VENDA, chavesCompra: CHAVES_COMPRA },
      // Faixa de uma linha sob os filtros (HTML/PDF/impressão): unidades vendidas e stock atual, lado a lado — não se confundem.
      resumoFaixa: ["Unidades vendidas", "Stock total", "Linhas sem stock conhecido (fora do stock total)"],
      // O aviso do custo viaja COM o relatório — quem abre o PDF daqui a
      // um mês não tem como saber que a coluna de custo é um snapshot
      // de hoje. O rodapé é texto livre que quebra normalmente.
      footer: nota,
    },
  };
  // Sem preços de venda/compra o `Report` que viaja (JSON do PDF/email) já não contém os valores retirados.
  return aplicarPrivacidade(relatorio);
}
