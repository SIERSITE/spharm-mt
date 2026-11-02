/**
 * lib/reporting/pdf-opcoes.ts
 *
 * Opções do `page.pdf()` do puppeteer para um relatório — PURO (sem puppeteer, sem `server-only`) para que o endpoint real
 * (report-pdf-server.ts) e os testes gerem o PDF com EXACTAMENTE as mesmas opções. Formato A4 SEMPRE (horizontal ou vertical
 * conforme o relatório); a margem lateral vem de `meta.pageMarginMm` (o Mapa de Vendas usa 6,5 mm, ver layout-largura.ts).
 */
import type { Report } from "./report-types";
import { MARGEM_LATERAL_MM, MARGEM_VERTICAL_MM } from "./layout-largura";

export function opcoesPdfDoRelatorio(report: Report) {
  const landscape = report.meta?.orientation === "landscape";
  const margemLateral = `${report.meta?.pageMarginMm ?? MARGEM_LATERAL_MM}mm`;
  return {
    format: "A4" as const,
    landscape,
    printBackground: true,
    preferCSSPageSize: true,
    margin: { top: `${MARGEM_VERTICAL_MM}mm`, right: margemLateral, bottom: `${MARGEM_VERTICAL_MM}mm`, left: margemLateral },
    // "Pág. X / Y" discreto, no canto superior direito — só o Chromium sabe o nº TOTAL de páginas. Vive na margem superior.
    displayHeaderFooter: true,
    headerTemplate: `
        <div style="width:100%; font-size:7px; color:#94a3b8; padding:2mm ${margemLateral} 0 ${margemLateral};
                    display:flex; justify-content:flex-end;
                    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
          Pág. <span class="pageNumber"></span> / <span class="totalPages"></span>
        </div>
      `,
    footerTemplate: `<div></div>`,
  };
}
