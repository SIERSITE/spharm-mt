/**
 * lib/reporting/report-excel-buffer.ts
 *
 * Construtor puro de workbook XLSX a partir de um Report. Zero APIs de
 * browser — seguro para usar em Route Handlers / Server Actions.
 *
 * Os dois consumers:
 *   - client: lib/reporting/report-excel.ts (download via Blob + <a>)
 *   - server: app/api/reports/email/route.ts (anexo do email)
 *
 * A decisão de manter o builder separado do downloader é para o mesmo
 * ficheiro poder ser importado a partir de qualquer runtime sem puxar
 * `document`/`Blob` para o bundle do servidor.
 */

import * as XLSX from "xlsx";
import type { Report, ReportCell, ReportColumn } from "./report-types";
import { excelNumberFormat, formatCell, formatDateTime } from "./report-formatters";
import { makeReportFilename } from "./report-filename";

type AnyCell = XLSX.CellObject;

function toCellObject(col: ReportColumn, value: ReportCell): AnyCell {
  if (value === null || value === undefined || value === "") {
    return { t: "s", v: "" };
  }
  const z = excelNumberFormat(col.format);
  switch (col.format) {
    case "currency":
    case "number":
    case "integer":
    case "percent": {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n)) return { t: "s", v: String(value) };
      if (col.format === "percent" && Math.abs(n) > 1) {
        // Valores já em pontos percentuais (25 = 25%) → converter para 0.25
        return { t: "n", v: n / 100, z };
      }
      return { t: "n", v: n, z };
    }
    case "date":
    case "datetime": {
      const d = value instanceof Date ? value : new Date(value as string);
      if (isNaN(d.getTime())) return { t: "s", v: String(value) };
      return { t: "d", v: d, z };
    }
    default:
      return { t: "s", v: String(value) };
  }
}

function computeTotal(col: ReportColumn, rows: Report["rows"]): number {
  let sum = 0;
  for (const row of rows) {
    const v = row[col.key];
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) sum += n;
  }
  return sum;
}

/**
 * Constrói um XLSX.WorkBook a partir de um Report, pronto a ser
 * serializado via `XLSX.write(wb, {type: "buffer" | "array"})`.
 * Esta função é pura e segura em qualquer runtime (Node ou browser).
 */
export function buildReportWorkbook(report: Report): XLSX.WorkBook {
  const cols = report.columns.filter((c) => !c.hidden);
  const wb = XLSX.utils.book_new();
  const ws: XLSX.WorkSheet = {};
  const merges: XLSX.Range[] = [];

  let r = 0;
  const setCell = (row: number, col: number, cell: AnyCell) => {
    ws[XLSX.utils.encode_cell({ r: row, c: col })] = cell;
  };

  // ─ Título
  setCell(r, 0, { t: "s", v: report.title });
  if (cols.length > 1) merges.push({ s: { r, c: 0 }, e: { r, c: cols.length - 1 } });
  r++;

  // ─ Subtítulo
  if (report.subtitle) {
    setCell(r, 0, { t: "s", v: report.subtitle });
    if (cols.length > 1) merges.push({ s: { r, c: 0 }, e: { r, c: cols.length - 1 } });
    r++;
  }

  // ─ Gerado em
  setCell(r, 0, { t: "s", v: `Gerado em: ${formatDateTime(report.generatedAt)}` });
  if (cols.length > 1) merges.push({ s: { r, c: 0 }, e: { r, c: cols.length - 1 } });
  r++;
  r++; // linha em branco

  // ─ Filtros
  if (report.filtersApplied && report.filtersApplied.length > 0) {
    setCell(r, 0, { t: "s", v: "Filtros aplicados" });
    r++;
    for (const f of report.filtersApplied) {
      setCell(r, 0, { t: "s", v: f.label });
      setCell(r, 1, { t: "s", v: f.value });
      r++;
    }
    r++;
  }

  // ─ Resumo
  if (report.summary && report.summary.length > 0) {
    setCell(r, 0, { t: "s", v: "Resumo" });
    r++;
    for (const s of report.summary) {
      setCell(r, 0, { t: "s", v: s.label });
      setCell(r, 1, { t: "s", v: formatCell(s.value, s.format) });
      r++;
    }
    r++;
  }

  // ─ Cabeçalhos da tabela
  const headerRow = r;
  for (let c = 0; c < cols.length; c++) {
    setCell(r, c, { t: "s", v: cols[c].label });
  }
  r++;

  // ─ Linhas de dados
  for (const row of report.rows) {
    for (let c = 0; c < cols.length; c++) {
      setCell(r, c, toCellObject(cols[c], row[cols[c].key]));
    }
    r++;
  }

  // ─ Linha de totais
  const totalsCols = cols.filter((c) => c.showTotal);
  if (totalsCols.length > 0) {
    setCell(r, 0, { t: "s", v: "Total" });
    for (let c = 0; c < cols.length; c++) {
      const col = cols[c];
      if (!col.showTotal) continue;
      const total = computeTotal(col, report.rows);
      setCell(r, c, toCellObject(col, total));
    }
    r++;
  }

  // ─ Range do worksheet
  ws["!ref"] = XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: Math.max(r - 1, headerRow), c: Math.max(cols.length - 1, 0) },
  });

  // ─ Larguras de coluna
  ws["!cols"] = cols.map((c) => ({ wch: c.width && c.width > 100 ? c.width / 7 : Math.max(c.label.length + 2, 14) }));

  // ─ Merges de cabeçalho
  if (merges.length > 0) ws["!merges"] = merges;

  XLSX.utils.book_append_sheet(wb, ws, "Relatório");
  return wb;
}

/**
 * Serializa o workbook como Node Buffer. Só usar em server runtime.
 */
export function buildReportExcelBuffer(report: Report): {
  buffer: Buffer;
  filename: string;
  mime: string;
} {
  const wb = buildReportWorkbook(report);
  const buffer = XLSX.write(wb, { bookType: "xlsx", type: "buffer" }) as Buffer;
  return {
    buffer,
    filename: makeReportFilename(report, "xlsx"),
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
}
