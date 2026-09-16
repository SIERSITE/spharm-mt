/**
 * lib/reporting/report-types.ts
 *
 * Modelo comum de relatório. Toda a app transforma os seus dados para
 * este formato único. A infra (print, pdf, excel, email) consome
 * SEMPRE este tipo — nunca lê dados brutos por página.
 */

export type ReportFormat =
  | "text"
  | "number"
  | "currency"
  | "date"
  | "datetime"
  | "percent"
  | "integer"
  /**
   * Uma casa decimal, SEMPRE — inclusive `.0`.
   *
   * `number` da' 0 a 2 casas, e mostraria "4" onde a coluna precisa de
   * "4,0": numa coluna de medias, um valor sem casa decimal le-se como
   * um inteiro e perde-se a escala.
   */
  | "decimal1";

export type ReportAlign = "left" | "right" | "center";

/**
 * Vocabulário fixo de "tons" para realce condicional de célula — nunca
 * uma função: o `Report` viaja por vezes em JSON (ex.: `/api/reports/pdf`
 * recebe-o serializado), e uma função não sobrevive a esse round-trip.
 * `success`/`danger` são para stock (com/sem); `info` é o realce suave de
 * "houve movimento aqui" (ex.: um mês com venda). Ver `renderTable` em
 * report-html.ts.
 */
export type ReportCellTone = "success" | "danger" | "info";

export type ReportColumn = {
  /** Chave na linha (row[key]) */
  key: string;
  /** Label visível em todos os outputs */
  label: string;
  /** Formatação — determina render no HTML e cell type no Excel */
  format?: ReportFormat;
  align?: ReportAlign;
  /** Largura preferida em caracteres (Excel) / px (HTML) */
  width?: number;
  /** Não inclui no output (útil para colunas só de detalhe) */
  hidden?: boolean;
  /** Total agregado desta coluna no footer da tabela */
  showTotal?: boolean;
  /**
   * Só existe no Excel — nunca desenhada em HTML/PDF/print. Para dados
   * que continuam úteis numa folha de cálculo (filtrar, ordenar) mas que
   * o layout compacto já mostra de outra forma (ex.: PVP/Custo dobrados
   * para uma sublinha da Descrição — ver `noteKey`). Nunca `hidden`
   * também: `hidden` esconde de TUDO, incluindo Excel.
   */
  excelOnly?: boolean;
  /**
   * Sublinha discreta sob esta célula, só em HTML/PDF/print — nunca no
   * Excel, que fica com o valor plano da coluna. Aponta para OUTRA
   * chave da MESMA linha cujo valor (já formatado como texto pelo
   * adapter) vira a sublinha — ex.: Descrição + "PVP: 27,90 € | Custo:
   * —" por baixo, em vez de duas colunas próprias.
   */
  noteKey?: string;
  /**
   * Mostra, em HTML/PDF/print, o valor de OUTRA chave da mesma linha em
   * vez de `key` — o dado real (Excel, totais, ordenação) continua a
   * vir de `key`, intocado. Para apresentação pura, quando o texto
   * completo é o dado certo mas o texto CURTO é o que se quer ver (ex.:
   * "Farmácia Segurado" → "Segurado" na coluna Farmácia — o nome
   * completo continua em `key` para quem precisar dele).
   */
  displayKey?: string;
  /**
   * Um valor numérico exactamente 0 mostra "–" em vez de "0" — HTML/PDF
   * apenas (Excel mantém o zero real, é uma folha de cálculo). Útil para
   * colunas onde "não houve nada aqui" lê melhor que uma parede de
   * zeros (ex.: meses sem venda).
   */
  zeroAsDash?: boolean;
  /** Tom da célula quando o valor numérico é exactamente 0. */
  toneWhenZero?: ReportCellTone;
  /** Tom da célula quando o valor numérico é > 0. */
  toneWhenPositive?: ReportCellTone;
  /**
   * Agrupa visualmente esta coluna por `GROUP_KEY` (ver abaixo): a
   * célula só é desenhada na primeira linha de cada grupo, com
   * `rowspan` a cobrir as restantes — nunca repete o valor. Fora do
   * HTML/PDF (Excel, ecrã) o valor continua presente em TODAS as
   * linhas, sem agrupamento — cada saída decide por si como usar
   * `GROUP_KEY`.
   */
  spanGroup?: boolean;
};

export type ReportCell = string | number | null | undefined | Date | boolean;
export type ReportRow = Record<string, ReportCell>;

/**
 * Chave RESERVADA numa linha: distingue detalhe de APRESENTAÇÃO.
 *
 * Existe por causa dos subtotais por artigo do relatório de Vendas. Uma
 * linha "TOTAL ARTIGO" tem de aparecer na tabela, no PDF e no Excel —
 * mas não pode entrar no total geral, ou cada artigo passaria a contar
 * duas vezes e o relatório dobrava as unidades vendidas.
 *
 * Não é uma coluna: nenhum renderer a desenha como célula, porque os
 * renderers percorrem `columns` e esta chave não está lá.
 */
export const ROW_KIND_KEY = "__rowKind" as const;

/** `detalhe` = dado real. `subtotal` = linha de apresentação. */
export type RowKind = "detalhe" | "subtotal";

/** `true` quando a linha é de apresentação e não deve somar em lado nenhum. */
export function ehLinhaSubtotal(row: ReportRow): boolean {
  return row[ROW_KIND_KEY] === "subtotal";
}

/**
 * Só as linhas de dados reais.
 *
 * É isto que os totais de coluna e os cartões de resumo têm de usar.
 * Um relatório sem subtotais devolve a mesma lista, portanto chamar isto
 * é sempre seguro.
 */
export function linhasDeDetalhe(rows: readonly ReportRow[]): ReportRow[] {
  return rows.filter((r) => !ehLinhaSubtotal(r));
}

/**
 * Chave RESERVADA numa linha: liga linhas CONTÍGUAS num grupo visual —
 * hoje, "um artigo": as suas linhas por farmácia + a linha TOTAL ARTIGO.
 *
 * Vive aqui (report-types, não vendas-agrupamento) porque é um mecanismo
 * genérico do sistema de reporting, não específico de Vendas — qualquer
 * relatório futuro com "registo-pai + N sublinhas" pode reutilizá-lo.
 *
 * Regras:
 *   · Linhas com o MESMO valor de `GROUP_KEY` têm de ser CONTÍGUAS no
 *     array `rows` — o renderer detecta grupos por runs consecutivos,
 *     não por agrupamento global (não reordena nada).
 *   · Ausente (undefined) = a linha não pertence a nenhum grupo — é o
 *     comportamento de sempre, sem qualquer `rowspan`. Um relatório que
 *     nunca define `GROUP_KEY` não muda nada visualmente.
 *   · Só colunas com `spanGroup: true` são afectadas — ver `ReportColumn`.
 */
export const GROUP_KEY = "__group" as const;

/**
 * Divide `rows` em runs contíguos pelo valor de `GROUP_KEY`.
 *
 * Uma linha sem `GROUP_KEY` forma sempre um grupo de tamanho 1 — nunca
 * se junta a nada, mesmo que a linha vizinha também não tenha (evita
 * agrupar acidentalmente duas linhas "sem grupo" só porque calham a
 * seguir uma à outra).
 */
export function agruparPorGroupKey(
  rows: readonly ReportRow[],
): { startIndex: number; length: number; groupKey: ReportCell }[] {
  const grupos: { startIndex: number; length: number; groupKey: ReportCell }[] = [];
  let i = 0;
  while (i < rows.length) {
    const chave = rows[i][GROUP_KEY];
    let fim = i + 1;
    if (chave !== undefined) {
      while (fim < rows.length && rows[fim][GROUP_KEY] === chave) fim++;
    }
    grupos.push({ startIndex: i, length: fim - i, groupKey: chave });
    i = fim;
  }
  return grupos;
}

export type ReportSummaryItem = {
  label: string;
  value: ReportCell;
  format?: ReportFormat;
};

export type ReportFilter = {
  label: string;
  /** Já renderizado em texto pelo produtor do relatório */
  value: string;
};

export type ReportMeta = {
  /** Usado para filename e subject de email. Default = slug(title). */
  slug?: string;
  orientation?: "portrait" | "landscape";
  /** Rodapé livre (ex: "SPharm.MT — Uso interno") */
  footer?: string;
  /** Nome da empresa/farmácia no cabeçalho */
  organization?: string;
  /**
   * Linguagem visual do relatório em HTML/PDF/print — nunca no Excel
   * (que é sempre uma folha plana, sem cabeçalho/cartões nenhuns).
   *
   *   · omisso/"comfortable" — o visual de sempre, ZERO mudança para
   *     qualquer relatório que não opte explicitamente por "compact".
   *   · "compact" — cabeçalho compacto (marca pequena + título + Pág./
   *     Gerado em), filtros e resumo em faixa de uma linha (sem
   *     cartões), tabela mais densa. Introduzido para Vendas (2026-09);
   *     outros relatórios adoptam quando fizer sentido para a estrutura
   *     dos seus dados — nunca por imposição.
   */
  density?: "comfortable" | "compact";
  /**
   * Escala fina de fonte/padding da TABELA — independente de `density`,
   * porque só faz sentido para relatórios com um número de colunas
   * dinâmico (hoje: os meses de Vendas). Um relatório com poucas
   * colunas fixas nunca precisa disto.
   *
   *   · omisso/"cozy"   — fonte/padding actuais.
   *   · "tight"         — ligeiramente mais compacto (ex.: 7-10 meses).
   *   · "ultratight"    — o mais compacto (ex.: 11-15 meses) — ainda
   *     legível, nunca a ponto de cortar texto.
   */
  tableDensity?: "cozy" | "tight" | "ultratight";
};

/**
 * Contrato único consumido por TODOS os módulos de reporting.
 */
export type Report = {
  title: string;
  subtitle?: string;
  generatedAt: Date;
  filtersApplied?: ReportFilter[];
  summary?: ReportSummaryItem[];
  columns: ReportColumn[];
  rows: ReportRow[];
  meta?: ReportMeta;
};
