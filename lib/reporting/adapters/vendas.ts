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
  ResumoFinalItem,
  ReportFilter,
  ReportRow,
  ReportSummaryItem,
} from "../report-types";
import { GROUP_KEY, ROW_KIND_KEY } from "../report-types";
import { filtroListaImportada } from "../filters-shared";
import { filtroFormaFarmaceuticaLinha, type OpcaoFormaFarmaceutica } from "@/lib/catalog/forma-farmaceutica-filtro";
import { traduzirLaboratoriosParaExport, type CatalogoFilterOptionLaboratorio } from "@/lib/catalog/laboratorio-filtro";
import { nomeFarmaciaCurto } from "../farmacia-nome";
import { aplicarPrivacidade } from "../privacidade";
import { capacidadeDoRelatorio, comLarguras } from "../layout-vendas";
import { MARGEM_LATERAL_VENDAS_MM } from "../layout-largura";
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

function bucketColumnLabel(b: { ano: number; mes: number }): string {
  // Excel: duas linhas ("Out" + "25"), como sempre foi (o Excel não muda).
  const yy = String(b.ano).slice(-2);
  return `${MONTH_LABELS_PT[b.mes - 1]}
${yy}`;
}

/** HTML/PDF/impressão: «Out/25» numa linha só (abreviado) — poupa largura sem reduzir a letra. */
function bucketColumnHtmlLabel(b: { ano: number; mes: number }): string {
  return `${MONTH_LABELS_PT[b.mes - 1]}/${String(b.ano).slice(-2)}`;
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
 * TABELA ÚNICA EM A4 HORIZONTAL (2026-11, segundo desenho)
 *
 * O Mapa de Vendas é UMA só tabela, A4 horizontal, a 8 pt (corpo e cabeçalhos), com todos os meses lado a lado. Colunas do
 * HTML/PDF/impressão: CNP · Descrição · Farmácia · PVP* · Custo unit. est.* · N meses «Out/25» · Total unid. · Stock
 * (*conforme «Incluir preços de venda/compra»). «Custo total est.» e «Valor Vendas (s/IVA)» deixaram de ser colunas da tabela:
 * são `excelOnly` (o Excel fica EXACTAMENTE como estava) e os seus totais vão para o RESUMO FINANCEIRO do fim do relatório
 * (`meta.resumoFinal`, uma só vez). As larguras vêm dos DADOS (layout-largura.ts / layout-vendas.ts) e o período que não cabe em
 * A4 legível não gera PDF/impressão (mensagem + HTTP 422): nunca A3, nunca blocos, nunca letra pequena.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Até este nº de meses o Excel mantém a ordem «clássica» das colunas; acima, a ordem que a012428 tinha com períodos longos. */
const MAX_MESES_EXCEL_ORDEM_CLASSICA = 13;

/** Largura mínima da Descrição (mm) — a regra vive em `layout-largura.ts`; reexportado para os testes. */
export { DESCRICAO_MIN_MM } from "../layout-largura";

function buildColumns(
  buckets: { ano: number; mes: number }[],
  /** Preços de venda (PVP, valor de vendas) e de compra (custos): colunas que não existem quando a classe está desligada. */
  incluirVenda: boolean,
  incluirCompra: boolean,
): ReportColumn[] {
  const monthColumns: ReportColumn[] = buckets.map((b) => ({
    key: bucketColumnKey(b),
    label: bucketColumnLabel(b),
    htmlLabel: bucketColumnHtmlLabel(b),
    format: "integer" as const,
    showTotal: true,
    // Mês sem venda = «·» (um ponto médio discreto); negativos (devoluções) aparecem com o sinal.
    zeroAsDash: true,
    zeroText: "·",
    // Os números dos meses nunca são cortados (a largura vem dos dados).
    noClip: true,
    // Fundo alternado muito discreto por mês (sem tom «info» nas células com venda).
    monthAlt: true,
  }));

  const cCodigo: ReportColumn = {
    key: "codigo", label: "CNP", format: "text", noClip: true,
    // Só desenha na 1ª linha de cada artigo — as sublinhas por farmácia (e a linha TOTAL ARTIGO) ficam cobertas pelo rowspan.
    spanGroup: true,
  };
  const cDescricao: ReportColumn = { key: "descricao", label: "Descrição", format: "text", spanGroup: true };
  const cFarmacia: ReportColumn = {
    key: "farmacia", label: "Farmácia", format: "text", quebra: true,
    // Mostra "Segurado", não "Farmácia Segurado" — só na apresentação; o Excel lê `farmacia` (nome completo).
    displayKey: "farmaciaCurta",
  };
  // PVP e Custo unit. est.: por FARMÁCIA (cada uma tem o seu), nunca uma média; no TOTAL ARTIGO a célula fica VAZIA no HTML/PDF
  // (o Excel mantém o valor da linha, como estava).
  const cPvp: ReportColumn = { key: "pvp", label: "PVP", htmlLabel: "PVP €", semSimbolo: true, format: "currency", noClip: true, sensivel: "venda", vazioNoSubtotal: true };
  const cCustoUnit: ReportColumn = { key: "custoUnitarioEstimado", label: "Custo\nunit. est.", htmlLabel: "Custo\nunit. €", semSimbolo: true, format: "currency", noClip: true, sensivel: "compra", vazioNoSubtotal: true };
  // Custo TOTAL estimado = custo unit. est. × quantidade líquida. SÓ EXCEL: o total vai para o resumo financeiro do fim do relatório.
  const cCustoTotal: ReportColumn = { key: "custoEstimado", label: "Custo total\nest.", format: "currency", showTotal: true, noClip: true, sensivel: "compra", excelOnly: true };
  // «Total unid.» = unidades VENDIDAS no período COMPLETO: fundo próprio (`tint`), entre os meses e o stock atual.
  const cTotalUnid: ReportColumn = { key: "totalVendas", label: "Total\nUnid.", htmlLabel: "Total\nunid.", format: "integer", showTotal: true, noClip: true, tint: "total" };
  const cStock: ReportColumn = {
    key: "existencia", label: "Stock", format: "integer", noClip: true,
    // «Stock total» no TOTAL GERAL: soma do stock ATUAL das combinações produto/farmácia (nunca somado por mês).
    showTotal: true,
    // Com stock / sem stock (0) / negativo — legível a preto e branco (ver `stockIndicator`).
    stockIndicator: true,
    // Stock a zero é um sinal operacional (ruptura); positivo é o estado normal — tons suaves, só reforço da caixa/inversão.
    toneWhenZero: "danger",
    toneWhenPositive: "success",
  };
  // Valor de vendas (s/IVA): SÓ EXCEL (o total vai para o resumo financeiro do fim do relatório).
  const cValor: ReportColumn = { key: "valorBruto", label: "Valor Vendas\n(s/IVA)", format: "currency", showTotal: true, noClip: true, sensivel: "venda", excelOnly: true };
  // Só no Excel: distingue linhas de detalhe de «Total artigo» para filtrar/somar sem contar duas vezes.
  const cTipo: ReportColumn = { key: "tipoLinha", label: "Tipo de linha", format: "text", excelOnly: true };

  // Classe de preços desligada: SEM nenhuma coluna dessa classe (nem vazia, nem reservada) — a Descrição ganha o espaço.
  const precosEsq = [...(incluirVenda ? [cPvp] : []), ...(incluirCompra ? [cCustoUnit] : [])];
  // A ORDEM é a de sempre (o Excel não muda). Até 13 meses: custo total antes dos meses, valor depois do stock. Acima de 13 meses
  // o Excel de a012428 (que repartia o HTML/PDF em blocos) trazia os totais do período depois do stock e com o prefixo «Período:»;
  // mantém-se EXATAMENTE essa folha (posições e rótulos), para quem tem macros/folhas ligadas a ela — só o Excel (`excelOnly`/`label`).
  if (buckets.length > MAX_MESES_EXCEL_ORDEM_CLASSICA) {
    cTotalUnid.label = "Período:\nTotal unid.";
    cCustoTotal.label = "Período: custo\ntotal est.";
    cValor.label = "Período: valor\nvendas (s/IVA)";
    return [
      cCodigo, cDescricao, cFarmacia, ...precosEsq,
      ...monthColumns, cTotalUnid, cStock, ...(incluirCompra ? [cCustoTotal] : []), ...(incluirVenda ? [cValor] : []), cTipo,
    ];
  }
  return [
    cCodigo, cDescricao, cFarmacia, ...precosEsq, ...(incluirCompra ? [cCustoTotal] : []),
    ...monthColumns, cTotalUnid, cStock, ...(incluirVenda ? [cValor] : []), cTipo,
  ];
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

  const incluirVenda = input.incluirPrecosVenda !== false;
  const incluirCompra = input.incluirPrecosCompra !== false;
  const colunas = buildColumns(input.buckets, incluirVenda, incluirCompra);

  const artigos = new Set(input.rows.map((r) => r.codigo)).size;
  const custoGeral = custoTotalDoRelatorio(input.rows);
  const semCusto = custoGeral.semCusto;
  const stockGeral = stockTotalDoRelatorio(input.rows);
  const nota = [
    "Stock atual à data de geração do relatório (não histórico); o Stock total soma o stock atual de cada artigo/farmácia (não se soma por mês). Stock: número simples = com stock; número em caixa = 0; fundo escuro = negativo.",
    stockGeral.desconhecidas > 0
      ? `Stock total PARCIAL: ${stockGeral.desconhecidas} linha(s) sem stock conhecido ficam fora do total (aparecem «—»).`
      : "",
    incluirCompra
      ? "Custo unit. est. pelo PMC/PUC atual da ficha — não é o custo à data da venda; o custo total estimado (resumo no fim) = custo unit. est. × quantidade líquida."
      : "",
    incluirVenda ? "Valor de vendas sem IVA." : "",
    "«·» = sem vendas no mês; valores negativos = devoluções/anulações acima das vendas.",
    incluirCompra && semCusto > 0
      ? `Custo total PARCIAL: ${semCusto} linha(s) sem custo conhecido ficam fora do total (aparecem «—»).`
      : "",
  ].filter(Boolean).join(" ");

  // RESUMO FINANCEIRO (fim do relatório, uma só vez; nunca repete artigos). Itens sensíveis saem com a respetiva classe de preços
  // desligada (aplicarPrivacidade). Os totais são os MESMOS do Excel (soma do detalhe).
  const unidadesTotal = input.rows.reduce((a, r) => a + (r.totalVendas ?? 0), 0);
  const valorVendasTotal = input.rows.reduce((a, r) => a + (r.valorBruto ?? 0), 0);
  const resumoFinal: ResumoFinalItem[] = [
    { label: "Unidades vendidas", value: unidadesTotal, format: "integer" },
    {
      label: "Stock total", value: stockGeral.total, format: "integer",
      nota: stockGeral.desconhecidas > 0 ? `PARCIAL: ${stockGeral.desconhecidas} linha(s) sem stock conhecido ficam fora do total` : undefined,
    },
    {
      label: "Custo total estimado", value: custoGeral.total, format: "currency", sensivel: "compra",
      nota: semCusto > 0 ? `PARCIAL: ${semCusto} linha(s) sem custo conhecido ficam fora do total` : undefined,
    },
    { label: "Valor total de vendas (s/IVA)", value: valorVendasTotal, format: "currency", sensivel: "venda" },
  ];

  const relatorio: Report = {
    title: "Relatório de Vendas",
    subtitle,
    generatedAt: new Date(),
    filtersApplied: buildFilters(input.filters, input.universe),
    summary: buildSummary(input.rows),
    columns: colunas,
    rows: rowsForReport,
    meta: {
      slug: "vendas",
      orientation: "landscape",
      // A4 horizontal SEMPRE (nunca A3): margens laterais pequenas mas seguras e padding das células pela regra de largura.
      pageMarginMm: MARGEM_LATERAL_VENDAS_MM,
      legibilidadeA4: true,
      organization: input.organization,
      // Primeiro relatório a adoptar a linguagem visual compacta — ver
      // report-html.ts. Os restantes ficam no default ("comfortable")
      // até serem validados e migrados um a um.
      density: "compact",
      // Impressão/PDF: hierarquia que sobrevive a papel e a preto e branco
      // (borda forte por artigo, blocos alternados, TOTAL ARTIGO escuro).
      hierarchy: "clean",
      tableNote: `${artigos} artigo${artigos === 1 ? "" : "s"} · ${input.rows.length} linha${input.rows.length === 1 ? "" : "s"} de detalhe`,
      totalLabel: "TOTAL GERAL",
      excelFilterable: true,
      // Que informação comercial o relatório pode levar. Os geradores de saída (HTML/PDF/Excel/email) reaplicam
      // `aplicarPrivacidade` com isto, por isso nada sensível sai mesmo que o `Report` seja reencaminhado ou adulterado.
      privacidade: { precosVenda: incluirVenda, precosCompra: incluirCompra, chavesVenda: CHAVES_VENDA, chavesCompra: CHAVES_COMPRA },
      // Faixa de uma linha sob os filtros (HTML/PDF/impressão): unidades vendidas e stock atual, lado a lado — não se confundem.
      resumoFaixa: ["Unidades vendidas", "Stock total", "Linhas sem stock conhecido (fora do stock total)"],
      resumoFinal,
      // O aviso do custo viaja COM o relatório — quem abre o PDF daqui a
      // um mês não tem como saber que a coluna de custo é um snapshot
      // de hoje. O rodapé é texto livre que quebra normalmente.
      footer: nota,
    },
  };
  // Larguras e padding vêm dos DADOS (os textos que a tabela vai desenhar), já com a privacidade aplicada.
  const privado = aplicarPrivacidade(relatorio);
  const cap = capacidadeDoRelatorio(privado);
  privado.columns = comLarguras(privado.columns, cap);
  privado.meta = { ...privado.meta, paddingCelulaPx: cap.padPx };
  return privado;
}
