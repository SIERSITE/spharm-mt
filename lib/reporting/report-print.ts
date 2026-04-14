/**
 * lib/reporting/report-print.ts
 *
 * Dispara a impressão do relatório num iframe oculto (fora do
 * viewport), sem navegar para fora da página actual. O browser abre o
 * diálogo nativo de impressão — o utilizador pode imprimir ou escolher
 * "Save as PDF".
 *
 * Detalhes críticos:
 *   - Usa `srcdoc` em vez de `document.write()` — load dispara
 *     fiavelmente em Chromium/Firefox modernos.
 *   - Iframe tem tamanho REAL (A4 landscape, 297mm × 210mm). Iframes
 *     com width/height 0 fazem Chrome imprimir páginas em branco em
 *     alguns casos, e impedem o layout do CSS de ser calculado.
 *   - Esconde via posição off-screen (`left:-10000px`), não via
 *     `display:none` ou `visibility:hidden` — `display:none` corta o
 *     layout completo, `visibility:hidden` por vezes bloqueia o
 *     focus/print.
 *   - Espera 2 × `requestAnimationFrame` + 50ms depois de `load` para
 *     dar tempo ao browser de processar o CSS, aplicar @page, e fazer
 *     o primeiro paint completo antes de abrir o print.
 *
 * Requer ambiente browser: usar apenas dentro de client components.
 */

import type { Report } from "./report-types";
import { renderReportHtml } from "./report-html";

export function printReport(report: Report): void {
  if (typeof document === "undefined") {
    console.warn("[report-print] document indisponível — chamada ignorada");
    return;
  }

  let html: string;
  try {
    html = renderReportHtml(report);
  } catch (err) {
    console.error("[report-print] falha a renderizar HTML do relatório", err);
    return;
  }

  // Validação útil de diagnóstico
  console.log(
    `[report-print] a preparar impressão: "${report.title}" — ${report.rows.length} linha(s), ${report.columns.length} coluna(s)`
  );

  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.setAttribute("title", "Print preview");
  // Tamanho REAL (landscape) + off-screen. Não usar width:0/height:0.
  iframe.style.cssText = [
    "position:fixed",
    "left:-10000px",
    "top:0",
    "width:297mm",
    "height:210mm",
    "border:0",
    "opacity:0",
    "pointer-events:none",
  ].join(";");

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
  };

  iframe.addEventListener(
    "load",
    () => {
      const win = iframe.contentWindow;
      if (!win) {
        console.error("[report-print] contentWindow indisponível");
        cleanup();
        return;
      }
      win.addEventListener("afterprint", () => setTimeout(cleanup, 300), { once: true });
      // Esperar o layout+paint completo antes de abrir o diálogo
      win.requestAnimationFrame(() => {
        win.requestAnimationFrame(() => {
          setTimeout(() => {
            try {
              win.focus();
              win.print();
            } catch (err) {
              console.error("[report-print] falha no print()", err);
              cleanup();
            }
          }, 50);
        });
      });
    },
    { once: true }
  );

  // Fallback absoluto: nunca deixar iframes pendurados
  setTimeout(cleanup, 120_000);

  document.body.appendChild(iframe);
  iframe.srcdoc = html;
}
