/**
 * lib/reporting/adapters/margens.ts
 *
 * Converte os dados de Margens (Por Produto / Por Categoria / Por
 * Farmácia) para o `Report` comum. Os agregados (Categoria e Farmácia)
 * usam o mesmo shape `MargensAgg` e partilham o builder genérico
 * `buildMargensAggReport` — só muda o título e o cabeçalho da primeira
 * coluna.
 *
 * Regra dura preservada: a coluna "Margem %" só recebe valor quando o
 * estado da linha é FIAVEL. Para PARCIAL e SEM_CUSTO emitimos null,
 * que o renderer pinta como "—" (vs "0%", que seria mentira).
 */

import type {
  Report,
  ReportColumn,
  ReportFilter,
  ReportRow,
  ReportSummaryItem,
} from "../report-types";
import { GROUP_KEY, ROW_KIND_KEY } from "../report-types";
import type {
  MargemRow,
  MargensAgg,
  EstadoMargem,
} from "@/lib/margens-data";
import { filtroListaImportada, type SharedReportFilters } from "@/lib/reporting/filters-shared";
import { nomeFarmaciaCurto } from "../farmacia-nome";
import { ordenarPorFarmacia } from "../ordenacao-farmacias";
import { normalizarLargura } from "../column-widths";
import { agruparLinhasPorArtigo, grupoArtigoPrecisaDeTotal } from "../agrupamento-artigo";

/**
 * As dimensoes em que Margens agrega — o modo "so' totalizadores".
 *
 * NAO inclui `distribuidor`: `ProdutoFarmacia.fornecedorOrigem` e' o
 * grossista HABITUAL da ficha, nao o da compra que gerou o custo do
 * periodo. Agregar margem por ele responderia a uma pergunta diferente
 * da que o rotulo prometia. Ver a nota no relatorio da tarefa.
 */
export type DimensaoAgregada = "categoria" | "farmacia" | "grupo" | "fabricante";

const HEADER_POR_DIMENSAO: Record<DimensaoAgregada, string> = {
  categoria: "Categoria",
  farmacia: "Farmácia",
  grupo: "Grupo",
  fabricante: "Fabricante",
};

const MARGEM_LABEL: Record<EstadoMargem, string> = {
  FIAVEL: "Fiável",
  PARCIAL: "Parcial",
  SEM_CUSTO: "Sem custo",
  IVA_POR_APURAR: "IVA por apurar",
};

// Por produto, na ordem de leitura pedida:
//   preço unitário → custo unitário → margem resultante
//
// Larguras (correcção visual 2026-09: o bloco por artigo tinha ficado
// demasiado comprimido — Categoria estreita quebrava palavras
// ["MEDICAMENTO"/"S"] e a Descrição não tinha espaço). `Categoria`
// deixou de ser coluna autónoma no PDF/HTML — passou a sublinha da
// Descrição (`noteKey`, ver abaixo), o mesmo mecanismo que Vendas já
// usa para outra informação secundária. O espaço libertado foi todo
// para Descrição (~16%→~24%) e Farmácia (~8%→~9,5%); as colunas
// numéricas encolheram ligeiramente — nenhuma delas precisa de mais do
// que o número que mostra. `normalizarLargura` corrige a soma para 100
// preservando estas proporções (ver column-widths.ts).
const MARGENS_PRODUTO_BASE_WIDTHS = {
  cnp: 5, designacao: 24, farmacia: 9.5, qtdVendida: 3.5,
  pvpUnitario: 5.7, valorVendido: 6.7, taxaIva: 3.3, valorVendidoSemIva: 6.7,
  custoUnitario: 5.7, custoEstimado: 6.7, margemEur: 6.7, margemPct: 4.8,
  coberturaPct: 4.8, estado: 6.2,
};
const MPW = normalizarLargura(MARGENS_PRODUTO_BASE_WIDTHS);

const MARGENS_PRODUTO_COLUMNS: ReportColumn[] = [
  {
    key: "cnp",                label: "CNP",          format: "text",     width: MPW.cnp,
    // Bloco por artigo (uniformização 2026-09, referência: Vendas) — só
    // desenha na 1ª linha do artigo, rowspan cobre as sublinhas de
    // farmácia + o TOTAL ARTIGO. Ver GROUP_KEY em buildMargensProdutoReport.
    spanGroup: true,
  },
  {
    key: "designacao",         label: "Descrição",    format: "text",     width: MPW.designacao, spanGroup: true,
    // Categoria como sublinha discreta — nunca uma coluna estreita a
    // partir palavras ("MEDICAMENTOS" não cabia em ~8%). Uma vez por
    // bloco (a categoria é do PRODUTO, não da farmácia), coberta pelo
    // mesmo rowspan de CNP/Descrição.
    noteKey: "categoriaNota",
  },
  // Categoria continua uma coluna verdadeira no Excel — só sai do
  // HTML/PDF (ver noteKey acima). Largura nominal, o Excel deriva a
  // sua própria a partir do rótulo (ver report-excel-buffer.ts).
  { key: "categoria",          label: "Categoria",    format: "text",     width: 10, excelOnly: true },
  {
    key: "farmacia",           label: "Farmácia",     format: "text",     width: MPW.farmacia,
    // Mostra "Segurado", não "Farmácia Segurado" — só na apresentação
    // (HTML/PDF/print). Excel continua a ler `farmacia` (nome completo)
    // directamente, porque não passa por `displayKey`.
    displayKey: "farmaciaCurta",
  },
  { key: "qtdVendida",         label: "Qtd",          format: "integer",  width: MPW.qtdVendida,  showTotal: true },
  { key: "pvpUnitario",        label: "PVP unit.",    format: "currency", width: MPW.pvpUnitario },
  { key: "valorVendido",       label: "Vendas c/IVA", format: "currency", width: MPW.valorVendido,  showTotal: true },
  { key: "taxaIva",            label: "IVA %",        format: "text",     width: MPW.taxaIva },
  { key: "valorVendidoSemIva", label: "Vendas s/IVA", format: "currency", width: MPW.valorVendidoSemIva,  showTotal: true },
  { key: "custoUnitario",      label: "Custo unit. est.",  format: "currency", width: MPW.custoUnitario },
  { key: "custoEstimado",      label: "Custo est.",   format: "currency", width: MPW.custoEstimado,  showTotal: true },
  { key: "margemEur",          label: "Margem €",     format: "currency", width: MPW.margemEur,  showTotal: true },
  { key: "margemPct",          label: "Margem %",     format: "text",     width: MPW.margemPct },
  { key: "coberturaPct",       label: "Cobert.",      format: "text",     width: MPW.coberturaPct },
  { key: "estado",             label: "Estado",       format: "text",     width: MPW.estado },
];

function joinList(list: string[] | undefined, total: number, labelTodas: string): string {
  if (!list || list.length === 0) return labelTodas;
  if (list.length === total) return labelTodas;
  if (list.length <= 3) return list.join(", ");
  return `${list.slice(0, 3).join(", ")} (+${list.length - 3})`;
}

function buildFiltersLabel(
  f: SharedReportFilters,
  universe: {
    farmacias: string[];
    categorias: string[];
    fabricantes: string[];
    distribuidores: string[];
  },
): ReportFilter[] {
  const out: ReportFilter[] = [];
  if (f.from && f.to) out.push({ label: "Período", value: `${f.from} a ${f.to}` });
  out.push({
    label: "Farmácias",
    value: joinList(f.farmaciaNomes, universe.farmacias.length, "Todas"),
  });
  if (f.categorias && f.categorias.length > 0) {
    out.push({
      label: "Categorias",
      value: joinList(f.categorias, universe.categorias.length, "Todas"),
    });
  }
  if (f.fabricantes && f.fabricantes.length > 0) {
    out.push({
      label: "Fabricantes",
      value: joinList(f.fabricantes, universe.fabricantes.length, "Todos"),
    });
  }
  if (f.distribuidores && f.distribuidores.length > 0) {
    out.push({
      label: "Distribuidores",
      value: joinList(f.distribuidores, universe.distribuidores.length, "Todos"),
    });
  }
  if (f.pesquisa && f.pesquisa.trim()) out.push({ label: "Pesquisa", value: f.pesquisa.trim() });
  const lista = filtroListaImportada(f.cnps);
  if (lista) out.push(lista);
  return out;
}

function pct(n: number | null, suffix = "%"): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `${n.toLocaleString("pt-PT", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}${suffix}`;
}

// Aviso permanente: margem é (PVP/(1+taxa) − PMC). PVP do ERP vem c/
// IVA, custo SEM IVA. Taxa IVA real vem da última compra do produto em
// StagingCompraRawLine. Sem taxa → estado SEM_IVA, margem €/% nulas.
// Cobertura < 50% suprime margem; 50-95% é PARCIAL.
function commonSubtitle(): string {
  return "Margem calculada SEM IVA: (PVP/(1+taxa)) − PMC. Taxas canónicas de farmácia: 6%/13%/23% (última compra do produto, normalizada). Taxa fora deste conjunto ou ausente → IVA por apurar, margem suprimida.";
}

export function buildMargensProdutoReport(input: {
  rows: MargemRow[];
  filters: SharedReportFilters;
  universe: {
    farmacias: string[];
    categorias: string[];
    fabricantes: string[];
    distribuidores: string[];
  };
  organization: string;
}): Report {
  // ── BLOCO POR ARTIGO (uniformização 2026-09, referência: Vendas) ────
  //
  // Uma linha por (produto, farmácia) — o mesmo CNP pode aparecer uma
  // vez por farmácia seleccionada. Agrupar por CNP e ordenar as
  // farmácias de forma ESTÁVEL dentro de cada grupo garante que "o
  // mesmo artigo nas duas farmácias fica com as duas linhas juntas",
  // sempre na mesma ordem entre artigos — nunca a ordem incidental da
  // query. A ordem dos ARTIGOS (que grupo aparece primeiro) é a de 1ª
  // aparição em `input.rows` — quem chama já ordenou como quis (por
  // designação, CNP, ...) e não se mexe nisso aqui.
  const paraLinhaDetalhe = (r: MargemRow): ReportRow => ({
    cnp: String(r.cnp),
    designacao: r.designacao,
    categoria: r.categoria ?? "—",
    // Sublinha da Descrição — vazia quando não há categoria, para o
    // renderer nunca desenhar um "cell-note" vazio.
    categoriaNota: r.categoria ?? "",
    farmacia: r.farmacia,
    farmaciaCurta: nomeFarmaciaCurto(r.farmacia),
    qtdVendida: r.qtdVendida,
    // `null` e não 0: com quantidade 0 não há preço unitário nenhum, e
    // "0,00 €" leria-se como grátis. O renderer pinta null como "—".
    // PVP/custo são SEMPRE por esta farmácia — nunca uma média entre
    // farmácias (ver o TOTAL ARTIGO, abaixo, que os deixa em branco).
    pvpUnitario: r.pvpUnitario,
    valorVendido: r.valorVendido,
    taxaIva: r.taxaIva === null ? "—" : `${r.taxaIva}%`,
    valorVendidoSemIva: r.valorVendidoSemIva ?? 0,
    custoUnitario: r.custoUnitario,
    custoEstimado: r.custoEstimado ?? 0,
    margemEur: r.margemEur ?? 0,
    margemPct: pct(r.margemPct),
    coberturaPct: pct(r.coberturaCusto * 100),
    estado: MARGEM_LABEL[r.estado],
    [ROW_KIND_KEY]: "detalhe",
  });

  const grupos = agruparLinhasPorArtigo(input.rows, {
    getCodigo: (r) => String(r.cnp),
    getFarmacia: (r) => r.farmacia,
    ordemFarmacias: input.universe.farmacias,
  });

  const rowsForReport: ReportRow[] = grupos.flatMap((g) => {
    const detalhes = g.detalhes.map(paraLinhaDetalhe);
    for (const linha of detalhes) linha[GROUP_KEY] = g.codigo;
    // Um artigo numa única farmácia não ganha TOTAL ARTIGO — seria uma
    // cópia exacta da linha de detalhe.
    if (!grupoArtigoPrecisaDeTotal(g)) return detalhes;

    // TOTAL ARTIGO — soma o que é somável (quantidades, valores em
    // euros), recalcula a margem % a partir das somas (é a mesma conta
    // do resumo global do relatório, não uma média simples), e deixa
    // "—" tudo o resto: PVP/Custo unitário são por FARMÁCIA (nunca um
    // valor único para o artigo — regra dura desta uniformização), e
    // Taxa IVA/Cobertura/Estado também podem divergir entre farmácias.
    const primeiro = detalhes[0];
    const somaNum = (chave: string) => detalhes.reduce((s, l) => s + (typeof l[chave] === "number" ? (l[chave] as number) : 0), 0);
    const qtdTotal = somaNum("qtdVendida");
    const valorVendidoTotal = somaNum("valorVendido");
    const valorSemIvaTotal = somaNum("valorVendidoSemIva");
    const custoTotal = somaNum("custoEstimado");
    const margemTotal = somaNum("margemEur");
    const margemPctTotal = valorSemIvaTotal > 0 ? Math.round((margemTotal / valorSemIvaTotal) * 1000) / 10 : null;

    const total: ReportRow = {
      cnp: primeiro.cnp,
      designacao: primeiro.designacao,
      categoria: primeiro.categoria,
      categoriaNota: "",
      farmacia: "TOTAL ARTIGO",
      farmaciaCurta: nomeFarmaciaCurto("TOTAL ARTIGO"),
      qtdVendida: qtdTotal,
      pvpUnitario: null,
      valorVendido: valorVendidoTotal,
      taxaIva: null,
      valorVendidoSemIva: valorSemIvaTotal,
      custoUnitario: null,
      custoEstimado: custoTotal,
      margemEur: margemTotal,
      margemPct: pct(margemPctTotal),
      coberturaPct: null,
      estado: null,
      [GROUP_KEY]: g.codigo,
      [ROW_KIND_KEY]: "subtotal",
    };
    return [...detalhes, total];
  });

  // KPIs globais — separar plano fiscal: total vendido c/IVA inclui
  // tudo; total s/IVA, custo, margem só sobre linhas com IVA + custo.
  let qty = 0;
  let valorComIva = 0;
  let valorSemIva = 0;
  let custo = 0;
  let margem = 0;
  let qtyFiavel = 0;
  for (const r of input.rows) {
    qty += r.qtdVendida;
    valorComIva += r.valorVendido;
    if (
      r.custoEstimado !== null &&
      r.margemEur !== null &&
      r.valorVendidoSemIva !== null
    ) {
      qtyFiavel += r.qtdVendida;
      valorSemIva += r.valorVendidoSemIva;
      custo += r.custoEstimado;
      margem += r.margemEur;
    }
  }
  const cobertura = qty > 0 ? qtyFiavel / qty : 0;
  const margemPctGlobal =
    cobertura >= 0.95 && valorSemIva > 0
      ? Math.round((margem / valorSemIva) * 10000) / 100
      : null;

  const summary: ReportSummaryItem[] = [
    { label: "Linhas", value: input.rows.length, format: "integer" },
    { label: "Unidades vendidas", value: Math.round(qty), format: "integer" },
    { label: "Vendas € (c/ IVA)", value: Math.round(valorComIva * 100) / 100, format: "currency" },
    { label: "Vendas € (s/ IVA)", value: Math.round(valorSemIva * 100) / 100, format: "currency" },
    { label: "Custo estimado (s/ IVA)", value: Math.round(custo * 100) / 100, format: "currency" },
    { label: "Margem € (s/ IVA)", value: Math.round(margem * 100) / 100, format: "currency" },
    { label: "Margem %", value: margemPctGlobal !== null ? `${margemPctGlobal}%` : "—", format: "text" },
    { label: "Cobertura", value: `${Math.round(cobertura * 1000) / 10}%`, format: "text" },
  ];

  return {
    title: "Relatório de Margens — Por Produto",
    subtitle: commonSubtitle(),
    generatedAt: new Date(),
    filtersApplied: buildFiltersLabel(input.filters, input.universe),
    summary,
    columns: MARGENS_PRODUTO_COLUMNS,
    rows: rowsForReport,
    meta: {
      slug: "margens-produto",
      orientation: "landscape",
      organization: input.organization,
      density: "compact",
      footer: "SPharm.MT · Margens operacional",
    },
  };
}

// ── Agregação genérica (Por Categoria / Por Farmácia) ─────────────

// Larguras editoriais somavam 90 (sobrava página — não transbordava,
// mas ficava por preencher); normalizado para 100 pela mesma via que
// Margens Por Produto/Transferências/Excessos/Encomendas, ver
// column-widths.ts.
const MARGENS_AGG_BASE_WIDTHS = {
  label: 19, qtdVendida: 7, valorVendido: 11, valorVendidoSemIva: 11,
  custoEstimado: 11, margemEur: 10, margemPct: 7, coberturaPct: 7, estado: 7,
};
const MAW = normalizarLargura(MARGENS_AGG_BASE_WIDTHS);

export function buildMargensAggReport(input: {
  rows: MargensAgg[];
  filters: SharedReportFilters;
  universe: {
    farmacias: string[];
    categorias: string[];
    fabricantes: string[];
    distribuidores: string[];
  };
  organization: string;
  groupBy: DimensaoAgregada;
}): Report {
  const headerLabel = HEADER_POR_DIMENSAO[input.groupBy];
  // Só "Por Farmácia" tem uma ordem estável definida pelo universo do
  // relatório — categoria/grupo/fabricante não têm essa noção (o pedido
  // do utilizador é especificamente sobre a ordem das FARMÁCIAS, ver
  // ordenacao-farmacias.ts). Sem isto, esta vista mostrava as farmácias
  // na ordem incidental em que `porFarmacia` saiu da agregação SQL — não
  // dependente da query, apenas por coincidência a mesma ordem entre
  // gerações.
  const rowsOrdenadas =
    input.groupBy === "farmacia"
      ? ordenarPorFarmacia(input.rows, (r) => r.label, input.universe.farmacias)
      : input.rows;

  const isFarmacia = input.groupBy === "farmacia";
  const columns: ReportColumn[] = [
    {
      key: "label",              label: headerLabel,    format: "text",     width: MAW.label,
      // Mostra "Segurado", não "Farmácia Segurado" — só quando esta
      // agregação É por farmácia. Nas restantes dimensões `label` já é
      // o nome curto certo (categoria/grupo/fabricante).
      ...(isFarmacia ? { displayKey: "labelCurta" } : {}),
    },
    { key: "qtdVendida",         label: "Qtd",          format: "integer",  width: MAW.qtdVendida,  showTotal: true },
    { key: "valorVendido",       label: "Vendas c/IVA", format: "currency", width: MAW.valorVendido, showTotal: true },
    { key: "valorVendidoSemIva", label: "Vendas s/IVA", format: "currency", width: MAW.valorVendidoSemIva, showTotal: true },
    { key: "custoEstimado",      label: "Custo est.",   format: "currency", width: MAW.custoEstimado, showTotal: true },
    { key: "margemEur",          label: "Margem €",     format: "currency", width: MAW.margemEur,  showTotal: true },
    { key: "margemPct",          label: "Margem %",     format: "text",     width: MAW.margemPct },
    { key: "coberturaPct",       label: "Cobert.",      format: "text",     width: MAW.coberturaPct },
    { key: "estado",             label: "Estado",       format: "text",     width: MAW.estado },
  ];

  const rowsForReport: ReportRow[] = rowsOrdenadas.map((r) => ({
    label: r.label,
    labelCurta: isFarmacia ? nomeFarmaciaCurto(r.label) : r.label,
    qtdVendida: r.qtdVendida,
    valorVendido: r.valorVendido,
    valorVendidoSemIva: r.valorVendidoSemIva,
    custoEstimado: r.custoEstimado,
    margemEur: r.margemEur,
    margemPct: pct(r.margemPct),
    coberturaPct: pct(r.coberturaCusto * 100),
    estado: MARGEM_LABEL[r.estado],
  }));

  const totalQty = input.rows.reduce((s, r) => s + r.qtdVendida, 0);
  const totalComIva = input.rows.reduce((s, r) => s + r.valorVendido, 0);
  const totalSemIva = input.rows.reduce((s, r) => s + r.valorVendidoSemIva, 0);
  const totalCusto = input.rows.reduce((s, r) => s + r.custoEstimado, 0);
  const totalMargem = input.rows.reduce((s, r) => s + r.margemEur, 0);

  const summary: ReportSummaryItem[] = [
    { label: headerLabel + "s", value: input.rows.length, format: "integer" },
    { label: "Unidades vendidas", value: Math.round(totalQty), format: "integer" },
    { label: "Vendas € (c/ IVA)", value: Math.round(totalComIva * 100) / 100, format: "currency" },
    { label: "Vendas € (s/ IVA)", value: Math.round(totalSemIva * 100) / 100, format: "currency" },
    { label: "Custo (s/ IVA)", value: Math.round(totalCusto * 100) / 100, format: "currency" },
    { label: "Margem € (s/ IVA)", value: Math.round(totalMargem * 100) / 100, format: "currency" },
  ];

  const titleByGroup: Record<DimensaoAgregada, string> = {
    categoria: "Relatório de Margens — Por Categoria",
    farmacia: "Relatório de Margens — Por Farmácia",
    grupo: "Relatório de Margens — Por Grupo",
    fabricante: "Relatório de Margens — Por Fabricante",
  };
  const slugByGroup: Record<DimensaoAgregada, string> = {
    categoria: "margens-categoria",
    farmacia: "margens-farmacia",
    grupo: "margens-grupo",
    fabricante: "margens-fabricante",
  };

  return {
    title: titleByGroup[input.groupBy],
    subtitle: commonSubtitle(),
    generatedAt: new Date(),
    filtersApplied: buildFiltersLabel(input.filters, input.universe),
    summary,
    columns,
    rows: rowsForReport,
    meta: {
      slug: slugByGroup[input.groupBy],
      orientation: "landscape",
      organization: input.organization,
      density: "compact",
      footer: "SPharm.MT · Margens executivo",
    },
  };
}
