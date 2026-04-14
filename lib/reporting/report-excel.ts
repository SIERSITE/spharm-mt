/**
 * lib/reporting/report-excel.ts
 *
 * CLIENT: gera o workbook a partir de um Report e dispara o download
 * no browser via Blob + <a download>.
 *
 * A lógica de construção do workbook vive em `report-excel-buffer.ts`
 * (pura, sem APIs de browser) para poder ser reutilizada pelo endpoint
 * server-side que envia anexos por email. Este ficheiro é apenas a
 * camada de download para Client Components.
 */

import * as XLSX from "xlsx";
import type { Report } from "./report-types";
import { buildReportWorkbook } from "./report-excel-buffer";
import { makeReportFilename } from "./report-filename";

function downloadBuffer(buf: ArrayBuffer, filename: string): void {
  const blob = new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    if (a.parentNode) a.parentNode.removeChild(a);
    URL.revokeObjectURL(url);
  }, 1_000);
}

export function exportExcel(report: Report): void {
  if (typeof document === "undefined") {
    console.warn("[report-excel] document indisponível — chamada ignorada");
    return;
  }
  try {
    const wb = buildReportWorkbook(report);
    const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
    downloadBuffer(buf, makeReportFilename(report, "xlsx"));
  } catch (err) {
    console.error("[report-excel] falha a gerar/descarregar Excel", err);
  }
}
