/**
 * lib/reporting/index.ts — barrel público da infraestrutura de reporting.
 */

export type {
  Report,
  ReportColumn,
  ReportRow,
  ReportCell,
  ReportFilter,
  ReportSummaryItem,
  ReportFormat,
  ReportAlign,
  ReportMeta,
} from "./report-types";

export {
  formatCell,
  formatCurrency,
  formatNumber,
  formatInteger,
  formatPercent,
  formatDate,
  formatDateTime,
  excelNumberFormat,
} from "./report-formatters";

export { renderReportHtml } from "./report-html";
export { printReport } from "./report-print";
export { exportPdf } from "./report-pdf";
export { exportExcel } from "./report-excel";
export { sendReportByEmail } from "./report-email";
export type {
  SendReportByEmailOptions,
  SendReportByEmailResult,
  ReportAttachmentFormat,
} from "./report-email";
export { makeReportFilename, slugify } from "./report-filename";
