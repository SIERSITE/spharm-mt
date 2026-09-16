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
 *  PVP é o único valor monetário verdadeiramente fiável: vem de
 *  ProdutoFarmacia.pvp. Mantido como currency.
 *
 *  Colunas mantidas:
 *    Código, Descrição, PVP, N × mês (dinâmico), Total Unidades, Stock,
 *    Farmácia — suficiente para leitura operacional.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type {
  Report,
  ReportColumn,
  ReportFilter,
  ReportRow,
  ReportSummaryItem,
} from "../report-types";
import { ROW_KIND_KEY } from "../report-types";
import { filtroListaImportada } from "../filters-shared";
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
  /** Buckets na mesma ordem que `buckets` passado a `buildVendasReport`. */
  meses: VendasAdapterMonthBucket[];
  totalVendas: number;
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
  /** CNP da lista importada por ficheiro. Ver `SharedReportFilters.cnps`. */
  cnps?: number[];
};

/**
 * Larguras-base (sem buckets), em % da largura útil da página.
 *
 * Correcção (2026-09): a versão anterior reservava 85% às colunas fixas
 * e só 15% a TODOS os meses juntos — e ainda impunha um mínimo de 3%
 * por mês (`Math.max(3, ...)`) que, a partir de 6 meses no mesmo
 * relatório, empurrava a SOMA das larguras para além de 100%. Com
 * `table-layout:fixed`, isso não trunca — reescala a tabela inteira
 * (fixos incluídos) de forma imprevisível, e é exactamente o que dava
 * meses ilegíveis, descrição espremida e cabeçalhos a transbordar uns
 * para cima dos outros.
 *
 * Os fixos ficam agora a ~58%, deixando ~42% para os meses — o
 * suficiente para "JAN/26" (o rótulo mais longo, maiúsculas via CSS)
 * ficar legível até cerca de 10 meses no mesmo relatório sem precisar
 * de encolher mais nada. Ver `buildColumns` para o que acontece além
 * disso (o orçamento dos fixos cede, nunca o total ultrapassa 100%).
 */
const BASE_WIDTH_FIXED_COLS = {
  codigo: 6,
  descricao: 17,
  pvp: 6,
  custoUnitarioEstimado: 7,
  totalVendas: 7,
  existencia: 6,
  farmacia: 9,
};

/** Largura mínima de uma coluna de mês, para "JAN/26" nunca truncar. */
const MIN_WIDTH_MES = 4.2;

function buildColumns(
  buckets: { ano: number; mes: number }[],
): ReportColumn[] {
  const numMeses = buckets.length;
  const fixedTotal =
    BASE_WIDTH_FIXED_COLS.codigo +
    BASE_WIDTH_FIXED_COLS.descricao +
    BASE_WIDTH_FIXED_COLS.pvp +
    BASE_WIDTH_FIXED_COLS.custoUnitarioEstimado +
    BASE_WIDTH_FIXED_COLS.totalVendas +
    BASE_WIDTH_FIXED_COLS.existencia +
    BASE_WIDTH_FIXED_COLS.farmacia;
  const remaining = Math.max(0, 100 - fixedTotal);
  const perMonthIdeal = numMeses > 0 ? remaining / numMeses : 0;

  // Tecto duro: os meses, juntos, NUNCA ultrapassam 92% — mesmo num
  // relatório com dezenas de meses, sobra sempre pelo menos 8% para os
  // fixos escalarem. Sem este tecto, `Math.max(MIN_WIDTH_MES, ...)`
  // sozinho podia, em relatórios muito longos (~24+ meses), empurrar
  // a soma para além de 100% de qualquer forma — exactamente o defeito
  // original, só que a um número de meses maior.
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

  // SEM arredondamento: `fixedTotal*fixedScale + perMonth*numMeses` dá
  // exactamente 100 (a menos de erro de vírgula flutuante, ~1e-10) só
  // por construção da fórmula acima. Arredondar cada largura
  // individualmente a 1 casa (como esta função fazia antes de se
  // escrever este teste) ACUMULA erro entre colunas — com 9+ meses a
  // soma passava a 100,3; com 36, a 101,5. CSS aceita percentagens com
  // casas decimais sem problema nenhum, por isso não há motivo para
  // arredondar aqui.
  const w = (base: number) => base * fixedScale;

  const monthColumns: ReportColumn[] = buckets.map((b) => ({
    key: bucketColumnKey(b),
    label: bucketColumnLabel(b),
    format: "integer" as const,
    width: perMonth,
    showTotal: true,
  }));

  return [
    { key: "codigo",      label: "Código",      format: "text",     width: w(BASE_WIDTH_FIXED_COLS.codigo) },
    { key: "descricao",   label: "Descrição",   format: "text",     width: w(BASE_WIDTH_FIXED_COLS.descricao) },
    { key: "pvp",         label: "PVP",         format: "currency", width: w(BASE_WIDTH_FIXED_COLS.pvp) },
    // «est.» no rotulo, tambem no PDF e no Excel. Uma folha impressa
    // circula sem o ecra ao lado, e e' onde a palavra mais falta.
    //
    // Só o unitário — sem "Custo est." (total). Removido a pedido
    // (2026-09): o custo total estimado somava um valor por natureza
    // aproximado (PMC/PUC actual × unidades, nunca o custo à data da
    // venda) e o pedido explícito foi mantê-lo fora da apresentação.
    // "Custo unit.\nest." (2 linhas) ainda transbordava na 1ª linha —
    // "Custo unit." (11 caracteres) não cabe na largura desta coluna
    // (~6% da página). 3 linhas curtas em vez de 2: cada uma isolada
    // cabe com folga, ao contrário de qualquer combinação de 2 linhas
    // que junte "unit." a outra palavra.
    { key: "custoUnitarioEstimado", label: "Custo\nunit.\nest.", format: "currency", width: w(BASE_WIDTH_FIXED_COLS.custoUnitarioEstimado) },
    ...monthColumns,
    { key: "totalVendas", label: "Total\nUnid.", format: "integer",  width: w(BASE_WIDTH_FIXED_COLS.totalVendas), showTotal: true },
    { key: "existencia",  label: "Stock",       format: "integer",  width: w(BASE_WIDTH_FIXED_COLS.existencia) },
    { key: "farmacia",    label: "Farmácia",    format: "text",     width: w(BASE_WIDTH_FIXED_COLS.farmacia) },
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
  if (f.apenasComStock)  out.push({ label: "Apenas com stock",  value: "Sim" });

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
 * por isso que são dois cartões: o mesmo CNP em duas farmácias são duas
 * linhas de detalhe e UMA referência.
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
      pvp?: number;
      totalVendas: number;
      existencia: number;
      farmacia: string;
      meses: { ano: number; mes: number; quantidade: number }[];
    },
    kind: "detalhe" | "subtotal",
  ): ReportRow => {
    const base: ReportRow = {
      codigo: r.codigo,
      descricao: r.descricao,
      // O PVP é da prateleira de UMA farmácia; somá-lo entre farmácias
      // não significa nada. Na linha de total fica vazio.
      pvp: kind === "subtotal" ? null : (r.pvp ?? 0),
      totalVendas: r.totalVendas,
      existencia: r.existencia,
      farmacia: r.farmacia,
      [ROW_KIND_KEY]: kind,
    };
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
  // não se introduzem subtotais por artigo.
  const hierarquico = input.filters.agruparPor === "artigo";
  const rowsForReport: ReportRow[] = hierarquico
    ? agruparPorArtigo(input.rows, input.buckets).flatMap((g) => {
        const detalhes = g.detalhes.map((d) => paraReportRow(d, "detalhe"));
        // Um artigo numa farmácia só não leva linha de total: seria uma
        // cópia da linha acima.
        if (!grupoPrecisaDeTotal(g)) return detalhes;
        return [...detalhes, paraReportRow(g.total, "subtotal")];
      })
    : input.rows.map((r) => paraReportRow(r, "detalhe"));

  const subtitle =
    input.filters.dataInicio && input.filters.dataFim
      ? `Período ${input.filters.dataInicio} a ${input.filters.dataFim}`
      : undefined;

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
      // O aviso do custo viaja COM o relatório — quem abre o PDF daqui a
      // um mês não tem como saber que a coluna de custo é um snapshot
      // de hoje. Vivia como uma "chip" de filtro (com white-space:nowrap,
      // pensado para valores curtos), o que a forçava para uma frase
      // inteira numa única linha sem quebra — exactamente o "excesso de
      // informação numa só linha" a corrigir. O rodapé já é texto livre
      // que quebra normalmente.
      footer:
        "SPharm.MT · Uso interno · Custo unit. est. pelo PMC/PUC actual da ficha — não é o custo à data da venda",
    },
  };
}
