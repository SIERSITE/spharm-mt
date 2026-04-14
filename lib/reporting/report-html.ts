/**
 * lib/reporting/report-html.ts
 *
 * Renderiza um Report para HTML auto-contido (doctype + inline CSS).
 * Usado por report-print.ts (iframe oculto) e poderia ser reutilizado
 * por uma futura integração server-side (ex: puppeteer).
 *
 * IMPORTANTE: estilo INLINE e sem dependências — o HTML gerado tem de
 * renderizar sozinho num iframe novo sem tailwind ou outras libs.
 */

import type { Report, ReportAlign, ReportColumn, ReportRow } from "./report-types";
import { formatCell, formatDateTime } from "./report-formatters";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function alignStyle(a: ReportAlign | undefined): string {
  return `text-align:${a ?? "left"};`;
}

function defaultAlignFor(col: ReportColumn): ReportAlign {
  if (col.align) return col.align;
  switch (col.format) {
    case "currency":
    case "number":
    case "integer":
    case "percent":
      return "right";
    case "date":
    case "datetime":
      return "center";
    default:
      return "left";
  }
}

function renderHeader(report: Report): string {
  const org = report.meta?.organization ?? "";
  const generated = formatDateTime(report.generatedAt);
  return `
    <header class="report-header">
      <div class="head-main">
        ${org ? `<div class="org">${escapeHtml(org)}</div>` : ""}
        <h1>${escapeHtml(report.title)}</h1>
        ${report.subtitle ? `<div class="subtitle">${escapeHtml(report.subtitle)}</div>` : ""}
      </div>
      <div class="head-meta">
        <div>Gerado em <strong>${escapeHtml(generated)}</strong></div>
        <div>Moeda: EUR</div>
      </div>
    </header>
  `;
}

function renderFilters(report: Report): string {
  if (!report.filtersApplied || report.filtersApplied.length === 0) return "";
  const chips = report.filtersApplied
    .map(
      (f) => `
        <div class="chip">
          <span class="chip-label">${escapeHtml(f.label)}:</span>
          <span class="chip-value">${escapeHtml(f.value)}</span>
        </div>`
    )
    .join("");
  return `
    <section class="filters">
      <div class="section-title">Filtros aplicados</div>
      <div class="chips">${chips}</div>
    </section>
  `;
}

function renderSummary(report: Report): string {
  if (!report.summary || report.summary.length === 0) return "";
  const cards = report.summary
    .map(
      (s) => `
        <div class="summary-card">
          <div class="summary-label">${escapeHtml(s.label)}</div>
          <div class="summary-value">${escapeHtml(formatCell(s.value, s.format))}</div>
        </div>`
    )
    .join("");
  return `
    <section class="summary">
      <div class="section-title">Resumo</div>
      <div class="summary-grid">${cards}</div>
    </section>
  `;
}

function computeTotals(columns: ReportColumn[], rows: ReportRow[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const col of columns) {
    if (!col.showTotal) continue;
    let sum = 0;
    for (const row of rows) {
      const v = row[col.key];
      if (typeof v === "number" && Number.isFinite(v)) sum += v;
      else if (typeof v === "string" && v !== "") {
        const n = Number(v);
        if (Number.isFinite(n)) sum += n;
      }
    }
    totals[col.key] = sum;
  }
  return totals;
}

/**
 * Converte `column.width` para CSS width do `<col>`.
 *
 * Convenção retrocompatível:
 *   - valores <= 100  → tratados como percentagem (ex: 28 → "28%")
 *   - valores >  100  → tratados como pixels (ex: 160 → "160px")
 *
 * Esta heurística permite aos adapters escolher o modo mais adequado
 * sem uma nova key, e o renderer sabe sempre produzir CSS válido.
 */
function widthToCss(width: number | undefined): string {
  if (!width) return "";
  if (width <= 100) return `${width}%`;
  return `${width}px`;
}

function renderTable(report: Report): string {
  const cols = report.columns.filter((c) => !c.hidden);
  if (cols.length === 0 || report.rows.length === 0) {
    return `<section class="table-wrap"><div class="empty">Sem dados a apresentar.</div></section>`;
  }

  // <colgroup> com larguras explícitas — combinado com table-layout:fixed
  // garante que as colunas respeitam os tamanhos definidos pelo adapter.
  const colgroup = cols
    .map((c) => {
      const w = widthToCss(c.width);
      return `<col${w ? ` style="width:${w}"` : ""} />`;
    })
    .join("");

  const headerCells = cols
    .map((c) => {
      const style = alignStyle(defaultAlignFor(c));
      return `<th style="${style}">${escapeHtml(c.label)}</th>`;
    })
    .join("");

  const bodyRows = report.rows
    .map((row) => {
      const tds = cols
        .map((c) => {
          const style = alignStyle(defaultAlignFor(c));
          return `<td style="${style}">${escapeHtml(formatCell(row[c.key], c.format))}</td>`;
        })
        .join("");
      return `<tr>${tds}</tr>`;
    })
    .join("");

  const totals = computeTotals(cols, report.rows);
  const hasTotals = Object.keys(totals).length > 0;
  const totalsRow = hasTotals
    ? `<tfoot><tr>${cols
        .map((c, i) => {
          const style = alignStyle(defaultAlignFor(c));
          if (i === 0) return `<td style="${style}"><strong>Total</strong></td>`;
          if (c.showTotal) {
            return `<td style="${style}"><strong>${escapeHtml(formatCell(totals[c.key], c.format))}</strong></td>`;
          }
          return `<td></td>`;
        })
        .join("")}</tr></tfoot>`
    : "";

  return `
    <section class="table-wrap">
      <table>
        <colgroup>${colgroup}</colgroup>
        <thead><tr>${headerCells}</tr></thead>
        <tbody>${bodyRows}</tbody>
        ${totalsRow}
      </table>
      <div class="row-count">${report.rows.length} linha${report.rows.length === 1 ? "" : "s"}</div>
    </section>
  `;
}

function renderFooter(report: Report): string {
  const footer = report.meta?.footer ?? "SPharm.MT";
  return `<footer class="report-footer">${escapeHtml(footer)}</footer>`;
}

const STYLES = `
  /**
   * @page TEM de estar ao nível de topo — aninhar dentro de @media print
   * é CSS inválido e os browsers ignoram silenciosamente a directiva,
   * voltando a portrait. Por isso a orientação vive fora do @media.
   */
  @page { size: __ORIENTATION__; margin: 10mm 8mm; }

  /**
   * Forçar impressão de backgrounds. Sem isto, os browsers por
   * default não imprimem background colors (opção "Background
   * graphics" do diálogo) — o que deixa o header da tabela em
   * "texto branco sobre fundo branco" = tabela sem cabeçalho visível.
   */
  * {
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
    color-adjust: exact !important;
  }

  *, *::before, *::after { box-sizing: border-box; }

  html, body {
    margin: 0;
    padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    color: #111;
    background: #fff;
    font-size: 11px;
    line-height: 1.4;
    -webkit-font-smoothing: antialiased;
  }

  .page { padding: 8mm 6mm 10mm 6mm; width: 100%; }

  /* ── Cabeçalho ── */
  .report-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    border-bottom: 2px solid #1a1a1a;
    padding-bottom: 8px;
    margin-bottom: 12px;
  }
  .report-header .head-main { min-width: 0; }
  .report-header .org {
    font-size: 10px; color: #444; letter-spacing: 0.5px;
    text-transform: uppercase; margin-bottom: 3px; font-weight: 700;
  }
  .report-header h1 { font-size: 17px; margin: 0 0 3px 0; font-weight: 700; color: #111; letter-spacing: -0.2px; }
  .report-header .subtitle { font-size: 11px; color: #555; }
  .report-header .head-meta {
    text-align: right; font-size: 9px; color: #666;
    white-space: nowrap; padding-left: 16px;
  }
  .report-header .head-meta strong { color: #222; font-weight: 700; }

  /* ── Section titles ── */
  .section-title {
    font-size: 8px; text-transform: uppercase; letter-spacing: 0.8px;
    color: #888; margin-bottom: 5px; font-weight: 700;
  }

  /* ── Filtros ── */
  .filters { margin-bottom: 11px; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip {
    border: 1px solid #d5d5d5; background: #f5f5f5;
    border-radius: 3px; padding: 2px 7px; font-size: 9px; white-space: nowrap;
  }
  .chip-label { color: #666; margin-right: 4px; }
  .chip-value { color: #111; font-weight: 600; }

  /* ── Resumo ── */
  .summary { margin-bottom: 11px; }
  .summary-grid { display: flex; flex-wrap: wrap; gap: 6px; }
  .summary-card {
    border: 1px solid #d5d5d5; background: #fafafa;
    border-radius: 3px; padding: 5px 10px; min-width: 110px;
  }
  .summary-label {
    font-size: 8px; color: #777; text-transform: uppercase;
    letter-spacing: 0.5px; font-weight: 700;
  }
  .summary-value { font-size: 13px; font-weight: 700; color: #111; margin-top: 1px; }

  /* ── Tabela ── */
  .table-wrap { margin-top: 4px; width: 100%; }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 9.5px;
    table-layout: fixed;
  }
  thead th {
    background: #1a1a1a !important;
    color: #ffffff !important;
    text-align: left;
    font-weight: 700;
    padding: 5px 6px;
    border: 1px solid #1a1a1a;
    font-size: 8.5px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    white-space: nowrap;
  }
  tbody td {
    padding: 4px 6px;
    border-bottom: 1px solid #e5e5e5;
    border-left: 1px solid #eee;
    border-right: 1px solid #eee;
    vertical-align: middle;
    word-wrap: break-word;
    overflow-wrap: anywhere;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* Descrição (e outras colunas longas text-align:left) podem quebrar linha */
  tbody td[style*="text-align:left"] {
    white-space: normal;
  }
  tbody tr:nth-child(even) td { background: #f9f9f9 !important; }
  tbody tr:hover td { background: #f0f0f0 !important; }
  tfoot td {
    padding: 6px 6px;
    border-top: 2px solid #1a1a1a;
    border-bottom: 1px solid #1a1a1a;
    background: #ececec !important;
    font-weight: 700;
    font-size: 9.5px;
  }

  .empty {
    padding: 40px; text-align: center; color: #888;
    border: 1px dashed #ccc; border-radius: 4px;
  }
  .row-count {
    margin-top: 5px; font-size: 8.5px; color: #888; text-align: right;
    font-style: italic;
  }

  .report-footer {
    margin-top: 12px; padding-top: 6px; border-top: 1px solid #ccc;
    font-size: 8px; color: #888; text-align: center;
    letter-spacing: 0.3px;
  }

  @media print {
    html, body { width: 100%; }
    .page { padding: 0; }
    thead { display: table-header-group; }
    tfoot { display: table-footer-group; }
    tr { page-break-inside: avoid; }
    .summary-card, .chip { break-inside: avoid; }
    .report-header { break-after: avoid; }
  }
`;

/**
 * Gera o HTML completo do relatório (doctype + head + body).
 * Pronto para ser escrito num iframe e impresso.
 */
export function renderReportHtml(report: Report): string {
  const orientation = report.meta?.orientation === "landscape" ? "A4 landscape" : "A4 portrait";
  const styles = STYLES.replace("__ORIENTATION__", orientation);

  return `<!doctype html>
<html lang="pt-PT">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(report.title)}</title>
<style>${styles}</style>
</head>
<body>
<div class="page">
  ${renderHeader(report)}
  ${renderFilters(report)}
  ${renderSummary(report)}
  ${renderTable(report)}
  ${renderFooter(report)}
</div>
</body>
</html>`;
}
