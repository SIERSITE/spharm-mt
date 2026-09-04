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
