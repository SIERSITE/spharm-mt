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
  | "integer";

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
