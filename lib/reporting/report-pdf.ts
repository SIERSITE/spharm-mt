/**
 * lib/reporting/report-pdf.ts
 *
 * CLIENT: envia o Report para /api/reports/pdf, recebe o binário
 * gerado pelo Puppeteer e dispara o download no browser.
 *
 * Deixou de ser um alias do print — o PDF é agora gerado server-side
 * a partir de `renderReportHtml(report)` via Chromium headless e
 * devolvido como ficheiro .pdf real. O diálogo de impressão nativo
 * continua disponível via `printReport()` (lib/reporting/report-print.ts).
 */

import type { Report } from "./report-types";
import { makeReportFilename } from "./report-filename";

function downloadBlob(blob: Blob, filename: string): void {
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

/**
 * Pede ao servidor que gere o PDF real. Assíncrono — nem todos os
 * callers precisam do resultado, mas fica disponível para quem quiser
 * sinalizar loading/feedback.
 */
export async function exportPdf(report: Report): Promise<void> {
  if (typeof document === "undefined") {
    console.warn("[report-pdf] document indisponível — chamada ignorada");
    return;
  }
  try {
    const res = await fetch("/api/reports/pdf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const j = (await res.json()) as { error?: string };
        if (j?.error) message = j.error;
      } catch {
        /* not JSON, keep message */
      }
      console.error("[report-pdf] falha a gerar PDF", message);
      alert(`Falha a gerar PDF: ${message}`);
      return;
    }
    const blob = await res.blob();
    downloadBlob(blob, makeReportFilename(report, "pdf"));
  } catch (err) {
    console.error("[report-pdf] erro de rede", err);
    alert("Erro de rede a gerar o PDF.");
  }
}
