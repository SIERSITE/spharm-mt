/**
 * lib/reporting/pdf-opcoes.ts
 *
 * Opções do `page.pdf()` do puppeteer para um relatório — PURO (sem puppeteer, sem `server-only`) para que o endpoint real
 * (report-pdf-server.ts) e os testes gerem o PDF com EXACTAMENTE as mesmas opções. O papel (A4/A3) vem de `meta.paperSize`
 * (regra de largura em layout-largura.ts); o `@page` do HTML diz o mesmo e, com `preferCSSPageSize`, é ele que manda.
 */
import type { Report } from "./report-types";
import { MARGEM_LATERAL_MM, MARGEM_VERTICAL_MM } from "./layout-largura";

export function opcoesPdfDoRelatorio(report: Report) {
  const landscape = report.meta?.orientation === "landscape";
  const formato = report.meta?.paperSize === "A3" ? ("A3" as const) : ("A4" as const);
  const margemLateral = `${report.meta?.pageMarginMm ?? MARGEM_LATERAL_MM}mm`;
  return {
    format: formato,
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
