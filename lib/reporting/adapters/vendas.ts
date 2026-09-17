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
import { nomeFarmaciaCurto } from "../farmacia-nome";
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
  /** Buckets na mesma ordem que `buckets` passado a `buildVendasReport`. */
  meses: VendasAdapterMonthBucket[];
  totalVendas: number;
  /** Valor bruto assinado da janela — ver SalesReportRow.valorBruto. */
  valorBruto?: number;
  existencia: number;
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
};

/**
 * Larguras-base (sem buckets), em % da largura útil da página — de
 * TODAS as colunas visíveis no HTML/PDF, incluindo PVP/Custo unit. est.
 * (correcção 2026-09: já não são `excelOnly` — ver a nota grande no
 * topo do ficheiro, e `buildColumns`).
 *
 * Correcção (2026-09, redesenho): Farmácia moved para logo a seguir à
 * Descrição (era a última coluna) — é onde a referência visual a põe, e
 * faz mais sentido ler "este artigo, nesta farmácia" antes dos números
 * mês-a-mês. `codigo`/`descricao` só desenham na 1ª linha de cada artigo
 * (rowspan — ver `spanGroup` em report-types.ts), por isso a largura de
 * Descrição não compete com o número de farmácias do grupo.
 */
const BASE_WIDTH_FIXED_COLS = {
  codigo: 6,
  // Reduzida de 20 para 17 (correcção 2026-09, PVP/Custo por farmácia):
  // já não precisa de caber a sublinha "PVP: X | Custo: Y" — só o texto
  // da descrição — o espaço libertado ajuda PVP/Custo (abaixo) e os
  // meses.
  descricao: 17,
  // Correcção (2026-09): a coluna Farmácia é o que a linha TOTAL ARTIGO
  // usa para o próprio rótulo (bold, 12 caracteres — mais largo que
  // qualquer nome de farmácia sem o prefixo "Farmácia "). A 8% ficava
  // demasiado estreita a 15 meses (fixedScale reduzia-a mais ainda) e
  // "TOTAL ARTIGO" cortava para "TOTAL AR…" — legível a menos, não a
  // mais, exactamente o que não se queria ao encolher a linha.
  farmacia: 11,
  // PVP/Custo (correcção 2026-09): voltam a ser colunas VISÍVEIS no
  // HTML/PDF, não só no Excel — ver a nota grande no topo do ficheiro.
  // Estreitas de propósito: são só um valor em euros por linha.
  pvp: 6,
  custoUnitarioEstimado: 7,
  totalVendas: 6,
  existencia: 5,
  valorVendas: 8,
};

/** Largura mínima de uma coluna de mês, para "JUL"/"25" nunca truncar. */
const MIN_WIDTH_MES = 4.2;

/**
 * Densidade fina da tabela (report.meta.tableDensity) — só relevante
 * para relatórios com nº de colunas dinâmico (hoje, só Vendas). Mais
 * meses no mesmo relatório = fonte/padding ligeiramente menores, nunca
 * a ponto de cortar texto (ver report-html.ts, secção `.table-density-*`).
 */
function tableDensityFor(numMeses: number): "cozy" | "tight" | "ultratight" {
  if (numMeses <= 6) return "cozy";
  if (numMeses <= 10) return "tight";
  return "ultratight";
}

function buildColumns(
  buckets: { ano: number; mes: number }[],
): ReportColumn[] {
  const numMeses = buckets.length;
  const fixedTotal =
    BASE_WIDTH_FIXED_COLS.codigo +
    BASE_WIDTH_FIXED_COLS.descricao +
    BASE_WIDTH_FIXED_COLS.farmacia +
    BASE_WIDTH_FIXED_COLS.pvp +
    BASE_WIDTH_FIXED_COLS.custoUnitarioEstimado +
    BASE_WIDTH_FIXED_COLS.totalVendas +
    BASE_WIDTH_FIXED_COLS.existencia +
    BASE_WIDTH_FIXED_COLS.valorVendas;
  const remaining = Math.max(0, 100 - fixedTotal);
  const perMonthIdeal = numMeses > 0 ? remaining / numMeses : 0;

  // Tecto duro: os meses, juntos, NUNCA ultrapassam 92% — mesmo num
  // relatório com dezenas de meses, sobra sempre pelo menos 8% para os
  // fixos escalarem. Sem este tecto, `Math.max(MIN_WIDTH_MES, ...)`
  // sozinho podia, em relatórios muito longos, empurrar a soma para além
  // de 100% de qualquer forma.
  const MAX_TOTAL_MESES = 92;
  const perMonth =
    numMeses > 0
      ? Math.min(Math.max(MIN_WIDTH_MES, perMonthIdeal), MAX_TOTAL_MESES / numMeses)
      : 0;
  const totalMeses = perMonth * numMeses;

  // Nunca menos que o mínimo de legibilidade dos meses — se isso não
  // couber no orçamento (relatório com muitos meses), são os FIXOS que
  // cedem, proporcionalmente entre si. Com o tecto acima, `100 -
  // totalMeses` nunca é negativo, por isso `fixedScale` nunca precisa
  // de ir abaixo de 0 — a soma final é SEMPRE exactamente 100 (dentro
  // do arredondamento), nunca mais, para nenhum número de meses.
  const excedente = fixedTotal + totalMeses - 100;
  const fixedScale = excedente > 0 ? Math.max(0, (fixedTotal - excedente) / fixedTotal) : 1;

  // SEM arredondamento — ver nota histórica no teste (test-vendas-pdf-layout.ts):
  // arredondar cada largura individualmente acumula erro entre colunas.
  const w = (base: number) => base * fixedScale;

  const monthColumns: ReportColumn[] = buckets.map((b) => ({
    key: bucketColumnKey(b),
    label: bucketColumnLabel(b),
    format: "integer" as const,
    width: perMonth,
    showTotal: true,
    // Meses sem venda leem melhor como "–" do que como uma parede de
    // zeros — e um mês COM venda ganha um realce muito suave (ver
    // .cell-tone-info em report-html.ts), para o olho encontrar
    // rapidamente onde é que o artigo se moveu.
    zeroAsDash: true,
    toneWhenPositive: "info",
  }));

  return [
    {
      key: "codigo", label: "CNP", format: "text",
      width: w(BASE_WIDTH_FIXED_COLS.codigo),
      // Só desenha na 1ª linha de cada artigo — as sublinhas por
      // farmácia (e a linha TOTAL ARTIGO) ficam cobertas pelo rowspan.
      // Ver GROUP_KEY, atribuído por artigo em `buildVendasReport`.
      spanGroup: true,
    },
    {
      key: "descricao", label: "Descrição", format: "text",
      width: w(BASE_WIDTH_FIXED_COLS.descricao),
      spanGroup: true,
    },
    {
      key: "farmacia", label: "Farmácia", format: "text",
      width: w(BASE_WIDTH_FIXED_COLS.farmacia),
      // Mostra "Segurado", não "Farmácia Segurado" — só na apresentação
      // (HTML/PDF/print). Excel continua a ler `farmacia` (nome
      // completo) directamente, porque não passa por `displayKey`.
      displayKey: "farmaciaCurta",
    },
    // PVP e Custo unit. est. (correcção 2026-09) — colunas VISÍVEIS no
    // HTML/PDF, não só no Excel: cada farmácia pode ter um PVP/custo
    // diferente para o MESMO artigo, e nenhuma delas usa `spanGroup` —
    // desenham em TODAS as sublinhas, cada uma com o valor da SUA
    // própria farmácia (nunca uma média, nunca o valor de outra). Na
    // linha TOTAL ARTIGO (soma de farmácias) ficam "—": não há um
    // PVP/custo único para o artigo inteiro. Ver a nota grande no topo
    // do ficheiro.
    { key: "pvp", label: "PVP", format: "currency", width: w(BASE_WIDTH_FIXED_COLS.pvp) },
    {
      key: "custoUnitarioEstimado", label: "Custo\nunit. est.", format: "currency",
      width: w(BASE_WIDTH_FIXED_COLS.custoUnitarioEstimado),
    },
    ...monthColumns,
    {
      key: "totalVendas", label: "Total\nUnid.", format: "integer",
      width: w(BASE_WIDTH_FIXED_COLS.totalVendas), showTotal: true,
    },
    {
      key: "existencia", label: "Stock", format: "integer",
      width: w(BASE_WIDTH_FIXED_COLS.existencia),
      // Stock a zero é um sinal operacional (ruptura); stock positivo é
      // o estado normal — ambos com um destaque discreto, nunca um
      // bloco grande. Ver .cell-tone-danger/.cell-tone-success.
      toneWhenZero: "danger",
      toneWhenPositive: "success",
    },
    {
      key: "valorBruto", label: "Valor Vendas\n(s/IVA)", format: "currency",
      width: w(BASE_WIDTH_FIXED_COLS.valorVendas), showTotal: true,
    },
  ];
}

function joinList(list: string[] | undefined, total: number, labelTodas: string): string {
  if (!list || list.length === 0) return labelTodas;
  if (list.length === total) return labelTodas;
  if (list.length <= 3) return list.join(", ");
  return `${list.slice(0, 3).join(", ")} (+${list.length - 3})`;
}

function buildFilters(
  f: VendasAdapterFilters,
  universe: {
    farmacias: string[];
    fornecedores: string[];
    fabricantes: string[];
    categorias: string[];
  }
): ReportFilter[] {
  const out: ReportFilter[] = [];

  if (f.dataInicio && f.dataFim) {
    out.push({ label: "Período", value: `${f.dataInicio} a ${f.dataFim}` });
  }
  if (f.ambito) {
    out.push({ label: "Âmbito", value: f.ambito });
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
    out.push({
      label: "Fabricantes",
      value: joinList(f.fabricantesSelecionados, universe.fabricantes.length, "Todos"),
    });
  }
  if (f.categoriasSelecionadas && f.categoriasSelecionadas.length > 0) {
    out.push({
      label: "Categorias",
      value: joinList(f.categoriasSelecionadas, universe.categorias.length, "Todas"),
    });
  }
  const lista = filtroListaImportada(f.cnps);
  if (lista) out.push(lista);
  if (f.artigo && f.artigo.trim()) {
    out.push({ label: "Pesquisa", value: f.artigo.trim() });
  }
  if (f.agruparPor) out.push({ label: "Agrupar por", value: f.agruparPor });
  if (f.ordenarPor) out.push({ label: "Ordenar por", value: f.ordenarPor });
  if (f.apenasComVendas) out.push({ label: "Apenas com vendas", value: "Sim" });
  if (f.apenasComStock)  out.push({ label: "Incluir stock sem vendas", value: "Sim" });
  if (f.incluirManutencao) out.push({ label: "Incluir manutenção de vendas", value: "Sim" });

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
function buildSummary(rows: VendasAdapterRow[]): ReportSummaryItem[] {
  let totalUnidades = 0;
  let valorEstimadoPvp = 0;
  for (const r of rows) {
    totalUnidades += r.totalVendas ?? 0;
    valorEstimadoPvp += (r.totalVendas ?? 0) * (r.pvp ?? 0);
  }
  const referencias = contarReferenciasUnicas(rows);
  return [
    { label: "Linhas",             value: rows.length,       format: "integer" },
    { label: "Referências únicas", value: referencias,       format: "integer" },
    { label: "Unidades vendidas",  value: totalUnidades,     format: "integer" },
    { label: "Valor PVP estimado", value: valorEstimadoPvp,  format: "currency" },
  ];
}

export function buildVendasReport(input: {
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
      totalVendas: number;
      /** Correcção 2026-09: não existia coluna nenhuma para isto. */
      valorBruto?: number;
      existencia: number;
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
      totalVendas: r.totalVendas,
      valorBruto: r.valorBruto ?? 0,
      existencia: r.existencia,
      // `farmacia` é o nome REAL, intocado — usado por Excel, ordenação,
      // agrupamento. `farmaciaCurta` é só a apresentação HTML/PDF (ver
      // `displayKey` em buildColumns). "TOTAL ARTIGO" não tem o prefixo
      // "Farmácia " — nomeFarmaciaCurto() não lhe mexe.
      farmacia: r.farmacia,
      farmaciaCurta: nomeFarmaciaCurto(r.farmacia),
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
        return [...detalhes, paraReportRow(g.total, "subtotal", g.codigo)];
      })
    : input.rows.map((r) => paraReportRow(r, "detalhe", undefined));

  const subtitle =
    input.filters.dataInicio && input.filters.dataFim
      ? `Período ${input.filters.dataInicio} a ${input.filters.dataFim}`
      : undefined;

  const numMeses = input.buckets.length;

  return {
    title: "Relatório de Vendas",
    subtitle,
    generatedAt: new Date(),
    filtersApplied: buildFilters(input.filters, input.universe),
    summary: buildSummary(input.rows),
    columns: buildColumns(input.buckets),
    rows: rowsForReport,
    meta: {
      slug: "vendas",
      orientation: "landscape",
      organization: input.organization,
      // Primeiro relatório a adoptar a linguagem visual compacta — ver
      // report-html.ts. Os restantes ficam no default ("comfortable")
      // até serem validados e migrados um a um.
      density: "compact",
      tableDensity: tableDensityFor(numMeses),
      // O aviso do custo viaja COM o relatório — quem abre o PDF daqui a
      // um mês não tem como saber que a coluna de custo é um snapshot
      // de hoje. O rodapé é texto livre que quebra normalmente.
      footer:
        "Stock actual à data de geração do relatório. Custo unit. est. pelo PMC/PUC actual da ficha — não é o custo à data da venda. Valor de vendas sem IVA.",
    },
  };
}
