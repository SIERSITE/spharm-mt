/**
 * lib/reporting/report-html.ts
 *
 * Renderiza um Report para HTML auto-contido (doctype + inline CSS).
 * Usado por report-print.ts (iframe oculto) e report-pdf-server.ts
 * (puppeteer, server-only).
 *
 * IMPORTANTE: estilo INLINE e sem dependências — o HTML gerado tem de
 * renderizar sozinho num iframe novo sem tailwind ou outras libs.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * REDESENHO 2026-09 — `meta.density`
 *
 * Duas linguagens visuais convivem no MESMO ficheiro, escolhidas por
 * `report.meta?.density`:
 *
 *   · omisso/"comfortable" — o visual de sempre (cabeçalho com barra
 *     inferior de 2px, filtros em "chips", resumo em cartões, cabeçalho
 *     de tabela escuro). ZERO alteração de HTML/CSS para qualquer
 *     relatório que não opte por "compact" — é a garantia de que este
 *     redesenho não mexe em Margens/Excessos/Transferências/etc. até
 *     serem migrados um a um, deliberadamente.
 *   · "compact" — a linguagem nova (Vendas, 2026-09): marca discreta +
 *     título + Pág./Gerado em num cabeçalho fino; filtros e resumo numa
 *     faixa de uma linha, sem cartões; tabela mais densa, cores suaves
 *     em vez de um cabeçalho preto pesado.
 *
 * Três mecanismos GENÉRICOS (não específicos de "compact", nem de
 * Vendas) vivem em `renderTable()` e activam-se por dados, não por
 * `density` — um relatório que nunca os usa fica com o HTML
 * byte-a-byte igual ao de antes destes existirem:
 *
 *   · `GROUP_KEY` + `ReportColumn.spanGroup` — junta linhas contíguas
 *     num grupo visual (hoje: um artigo = as suas farmácias + o TOTAL
 *     ARTIGO) e desenha as colunas marcadas só na 1ª linha, com
 *     `rowspan` a cobrir o resto. Ver report-types.ts.
 *   · `ReportColumn.zeroAsDash` / `toneWhenZero` / `toneWhenPositive` —
 *     formatação e realce condicional PURAMENTE DECLARATIVOS (nunca uma
 *     função — um `Report` pode viajar em JSON, ex.: /api/reports/pdf).
 *   · `ReportColumn.noteKey` — sublinha discreta sob uma célula, lida
 *     doutra chave da mesma linha (nunca no Excel).
 */

import type { Report, ReportAlign, ReportCell, ReportColumn, ReportRow } from "./report-types";
import { agruparPorGroupKey, ehLinhaSubtotal, linhasDeDetalhe } from "./report-types";
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

function isCompact(report: Report): boolean {
  return report.meta?.density === "compact";
}

function renderHeader(report: Report): string {
  const org = report.meta?.organization ?? "";
  const generated = formatDateTime(report.generatedAt);

  if (!isCompact(report)) {
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

  // Compacto: marca discreta (produto) + nome do tenant/grupo à esquerda,
  // título ao centro, meta à direita. "Pág. X / Y" não vive aqui — é o
  // Chromium (via puppeteer headerTemplate, ver report-pdf-server.ts) que
  // sabe o total de páginas; uma página HTML viva não tem "páginas".
  return `
    <header class="report-header compact">
      <div class="brand">
        <div class="brand-mark">SP</div>
        <div class="brand-text">
          <div class="brand-name">SPharm.MT</div>
          ${org ? `<div class="brand-org">${escapeHtml(org)}</div>` : ""}
        </div>
      </div>
      <div class="head-title">
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

  if (!isCompact(report)) {
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

  // Compacto: uma faixa só, texto corrido com separadores finos — não
  // "chips" com moldura/fundo. É aqui que a referência mostra "Período:
  // ... | Farmácias: ... | Fabricante: ...".
  const items = report.filtersApplied
    .map(
      (f) => `<span class="filter-item"><strong>${escapeHtml(f.label)}:</strong> ${escapeHtml(f.value)}</span>`
    )
    .join("");
  return `
    <section class="filters compact">
      <div class="filter-line">${items}</div>
    </section>
  `;
}

function renderSummary(report: Report): string {
  if (!report.summary || report.summary.length === 0) return "";

  // Compacto: o TOTAL GERAL da própria tabela já mostra unidades/valor —
  // repeti-los em cartões era exactamente o "bloco grande no topo" que a
  // referência não tem. Os dados continuam disponíveis em
  // `report.summary` para quem consumir o Report directamente (Excel
  // continua a listá-los, email idem) — só o HTML/PDF/print deixa de os
  // desenhar aqui.
  if (isCompact(report)) return "";

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

/** Valor numérico de uma célula, ou `null` se não for numérico. */
function numericValue(v: ReportCell): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** O valor efectivamente desenhado — `displayKey` substitui `key` só para apresentação. */
function effectiveCellValue(row: ReportRow, col: ReportColumn): ReportCell {
  return col.displayKey ? row[col.displayKey] : row[col.key];
}

/** Classe de tom (ver `ReportColumn.toneWhenZero`/`toneWhenPositive`), ou "". */
function cellToneClass(value: ReportCell, col: ReportColumn): string {
  const n = numericValue(value);
  if (n === null) return "";
  if (n === 0 && col.toneWhenZero) return `cell-tone-${col.toneWhenZero}`;
  if (n > 0 && col.toneWhenPositive) return `cell-tone-${col.toneWhenPositive}`;
  return "";
}

/** Texto da célula — lê `displayKey` quando existe, aplica `zeroAsDash` antes do formatador normal. */
function cellText(row: ReportRow, col: ReportColumn): string {
  const raw = effectiveCellValue(row, col);
  if (col.zeroAsDash) {
    const n = numericValue(raw);
    if (n === 0) return "–";
  }
  return formatCell(raw, col.format);
}

function renderTable(report: Report): string {
  const compact = isCompact(report);
  const cols = report.columns.filter((c) => !c.hidden && !c.excelOnly);
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
      // Um rótulo pode trazer "\n" para pedir cabeçalho em duas linhas
      // (ex.: meses "JAN\n26", ou "Custo unit.\nest.") — a forma mais
      // curta de dar mais largura de leitura a cada linha sem estreitar
      // a coluna nem cortar texto.
      const label = escapeHtml(c.label).replace(/\n/g, "<br/>");
      return `<th style="${style}">${label}</th>`;
    })
    .join("");

  // Grupos por GROUP_KEY (runs contíguos) — ver report-types.ts. Uma
  // linha sem grupo (a maioria dos relatórios, hoje) forma sempre um
  // grupo de tamanho 1: `spanGroup` nunca emite `rowspan` nesse caso, e
  // o HTML de uma linha assim fica idêntico ao de antes deste mecanismo
  // existir.
  const grupos = agruparPorGroupKey(report.rows);
  type InfoGrupo = { length: number; isFirst: boolean };
  const grupoDoIndice = new Map<number, InfoGrupo>();
  for (const g of grupos) {
    for (let offset = 0; offset < g.length; offset++) {
      grupoDoIndice.set(g.startIndex + offset, { length: g.length, isFirst: offset === 0 });
    }
  }

  const renderRow = (row: ReportRow, idx: number): string => {
    const subtotal = ehLinhaSubtotal(row);
    const grupo = grupoDoIndice.get(idx) ?? { length: 1, isFirst: true };
    const tds = cols
      .map((c) => {
        if (c.spanGroup && grupo.length > 1 && !grupo.isFirst) {
          // Coberta pelo rowspan emitido na 1ª linha do grupo — uma
          // tabela HTML válida não pode repetir esta célula.
          return "";
        }
        const style = alignStyle(defaultAlignFor(c));
        const tone = cellToneClass(effectiveCellValue(row, c), c);
        const classAttr = tone ? ` class="${tone}"` : "";
        const rowspanAttr = c.spanGroup && grupo.length > 1 && grupo.isFirst ? ` rowspan="${grupo.length}"` : "";
        const principal = escapeHtml(cellText(row, c));
        const notaRaw = c.noteKey ? row[c.noteKey] : undefined;
        const conteudo =
          typeof notaRaw === "string" && notaRaw !== ""
            ? `<div class="cell-main">${principal}</div><div class="cell-note">${escapeHtml(notaRaw)}</div>`
            : principal;
        return subtotal
          ? `<td style="${style}"${rowspanAttr}${classAttr}><strong>${conteudo}</strong></td>`
          : `<td style="${style}"${rowspanAttr}${classAttr}>${conteudo}</td>`;
      })
      .join("");
    return subtotal ? `<tr class="subtotal-row">${tds}</tr>` : `<tr>${tds}</tr>`;
  };

  const linhasHtml = report.rows.map(renderRow);
  const semGrupos = grupos.every((g) => g.groupKey === undefined);
  const tbodyHtml = semGrupos
    ? `<tbody>${linhasHtml.join("")}</tbody>`
    : grupos
        .map((g, gi) => {
          const linhasDoGrupo: string[] = [];
          for (let offset = 0; offset < g.length; offset++) {
            linhasDoGrupo.push(linhasHtml[g.startIndex + offset]);
          }
          // Zebra POR GRUPO (não por linha) em modo compacto — um artigo
          // com 5 farmácias é um bloco só, não cinco riscas alternadas.
          // Também é a fronteira de "não cortar entre páginas" (ver CSS
          // .row-group { break-inside: avoid }).
          const alt = compact && gi % 2 === 1 ? " row-group-alt" : "";
          return `<tbody class="row-group${alt}">${linhasDoGrupo.join("")}</tbody>`;
        })
        .join("");

  // TOTAIS SOBRE O DETALHE, e não sobre `report.rows`: com os subtotais
  // dentro, cada artigo contava duas vezes.
  const totals = computeTotals(cols, linhasDeDetalhe(report.rows));
  const hasTotals = Object.keys(totals).length > 0;
  const totalsRow = hasTotals
    ? `<tfoot><tr>${cols
        .map((c, i) => {
          const style = alignStyle(defaultAlignFor(c));
          // "TOTAL GERAL", não "Total" — para nunca se confundir, à
          // primeira vista, com "TOTAL ARTIGO" (o subtotal por linha,
          // ver .subtotal-row acima) numa tabela com muitas linhas.
          if (i === 0) return `<td style="${style}"><strong>TOTAL GERAL</strong></td>`;
          if (c.showTotal) {
            return `<td style="${style}"><strong>${escapeHtml(formatCell(totals[c.key], c.format))}</strong></td>`;
          }
          return `<td></td>`;
        })
        .join("")}</tr></tfoot>`
    : "";

  const tableDensity = report.meta?.tableDensity;
  const tableClass = tableDensity && tableDensity !== "cozy" ? ` class="table-density-${tableDensity}"` : "";

  return `
    <section class="table-wrap">
      <table${tableClass}>
        <colgroup>${colgroup}</colgroup>
        <thead><tr>${headerCells}</tr></thead>
        ${tbodyHtml}
        ${totalsRow}
      </table>
      <div class="row-count">${report.rows.length} linha${report.rows.length === 1 ? "" : "s"}</div>
    </section>
  `;
}

function renderFooter(report: Report): string {
  const footer = report.meta?.footer ?? "SPharm.MT";
  if (!isCompact(report)) {
    return `<footer class="report-footer">${escapeHtml(footer)}</footer>`;
  }
  // Compacto: nota do relatório à esquerda, marca fixa à direita — a
  // marca não é dado do relatório, é a mesma em qualquer um.
  return `
    <footer class="report-footer compact">
      <span class="footer-note">${escapeHtml(footer)}</span>
      <span class="footer-brand">SPharm.MT · www.spharm.pt</span>
    </footer>
  `;
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

  /* ── Cabeçalho (comfortable — visual de sempre) ── */
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

  /* ── Section titles (comfortable) ── */
  .section-title {
    font-size: 8px; text-transform: uppercase; letter-spacing: 0.8px;
    color: #888; margin-bottom: 5px; font-weight: 700;
  }

  /* ── Filtros (comfortable — chips) ── */
  .filters { margin-bottom: 11px; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip {
    border: 1px solid #d5d5d5; background: #f5f5f5;
    border-radius: 3px; padding: 2px 7px; font-size: 9px; white-space: nowrap;
  }
  .chip-label { color: #666; margin-right: 4px; }
  .chip-value { color: #111; font-weight: 600; }

  /* ── Resumo (comfortable — cartões) ── */
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

  /* ── Tabela (base — comfortable) ── */
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
    line-height: 1.35;
    /* Sem isto, um rótulo mais largo que a coluna (ex.: "Custo unit.
       est." ou um mês "JAN/26" numa coluna estreita) TRANSBORDA
       visualmente para cima da coluna seguinte em vez de cortar —
       table-layout:fixed limita a largura da célula, mas não corta
       texto sozinho. tbody td já tinha isto; thead th não tinha, e era
       aqui que os cabeçalhos apareciam "encavalados". */
    overflow: hidden;
    text-overflow: ellipsis;
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
  /* Subtotal por artigo ("TOTAL ARTIGO") — tem de se distinguir das
     linhas de farmácia à primeira vista, mas continuar claramente mais
     discreto do que o TOTAL GERAL (tfoot, abaixo). Barra à esquerda +
     fundo + moldura, em vez de só um filete no topo. */
  tbody tr.subtotal-row td {
    background: #eef2f7 !important;
    border-top: 1px solid #94a3b8;
    border-bottom: 1px solid #94a3b8;
  }
  tbody tr.subtotal-row td:first-child {
    border-left: 3px solid #475569;
  }
  tfoot td {
    padding: 7px 6px;
    border-top: 3px double #1a1a1a;
    border-bottom: 1px solid #1a1a1a;
    background: #dcdfe3 !important;
    font-weight: 700;
    font-size: 10px;
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

  /* ═══════════════════════════════════════════════════════════════════
     LINGUAGEM COMPACTA — 2026-09, meta.density:"compact"
     Tudo aqui escopado a .page.density-compact: zero efeito em
     qualquer relatório que não opte por esta densidade.
     ═══════════════════════════════════════════════════════════════════ */

  .page.density-compact { font-size: 10.5px; }

  /* ── Cabeçalho compacto ── */
  .page.density-compact .report-header.compact {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    border-bottom: 1px solid #e2e8f0;
    padding-bottom: 6px;
    margin-bottom: 6px;
  }
  .page.density-compact .report-header.compact .brand {
    display: flex; align-items: center; gap: 7px; flex: 1; min-width: 0;
  }
  .page.density-compact .brand-mark {
    flex: 0 0 auto;
    width: 22px; height: 22px; border-radius: 5px;
    background: #56a889; color: #fff;
    display: flex; align-items: center; justify-content: center;
    font-size: 9px; font-weight: 700; letter-spacing: 0.2px;
  }
  .page.density-compact .brand-name { font-size: 9.5px; font-weight: 700; color: #18323a; letter-spacing: 0.2px; }
  .page.density-compact .brand-org { font-size: 8px; color: #7f99a1; margin-top: 1px; }
  .page.density-compact .head-title { flex: 1.4; min-width: 0; text-align: center; }
  .page.density-compact .head-title h1 {
    margin: 0; font-size: 16px; font-weight: 700; color: #1e293b; letter-spacing: -0.2px;
  }
  .page.density-compact .head-title .subtitle { font-size: 9.5px; color: #64748b; margin-top: 1px; }
  .page.density-compact .head-meta {
    flex: 1; text-align: right; font-size: 8px; color: #94a3b8; white-space: nowrap;
  }
  .page.density-compact .head-meta strong { color: #475569; font-weight: 700; }

  /* ── Filtros compactos — uma faixa, sem cartões ── */
  .page.density-compact .filters.compact { margin-bottom: 6px; }
  .page.density-compact .filter-line {
    display: flex; flex-wrap: wrap; column-gap: 14px; row-gap: 2px;
    font-size: 9.5px; color: #475569;
  }
  .page.density-compact .filter-item { white-space: nowrap; }
  .page.density-compact .filter-item strong { color: #1e293b; font-weight: 600; }
  .page.density-compact .filter-item:not(:last-child) {
    padding-right: 14px; border-right: 1px solid #cbd5e1;
  }

  /* ── Tabela compacta ── */
  .page.density-compact table {
    font-size: 9px;
  }
  .page.density-compact thead th {
    background: #eef2f7 !important;
    color: #1e293b !important;
    border: 1px solid #dbe3ea;
    text-transform: none;
    letter-spacing: 0;
    padding: 4px 5px;
  }
  .page.density-compact tbody td {
    padding: 2.5px 5px;
    border-left: 1px solid #eef1f4;
    border-right: 1px solid #eef1f4;
    border-bottom: 1px solid #eef1f4;
  }
  /* O zebra passa a ser por GRUPO (tbody.row-group-alt), não por linha —
     um artigo com 5 farmácias é um bloco visual só. */
  .page.density-compact tbody tr:nth-child(even) td { background: transparent !important; }
  .page.density-compact tbody tr:hover td { background: #f1f5f9 !important; }
  .page.density-compact tbody.row-group-alt td { background: #f8fafc !important; }
  .page.density-compact tbody.row-group {
    break-inside: avoid;
    page-break-inside: avoid;
  }
  .page.density-compact tbody tr.subtotal-row td {
    background: #e9eef4 !important;
    border-top: 1px solid #b7c4d4;
    border-bottom: 1px solid #b7c4d4;
    font-weight: 700;
    /* Correcção (2026-09): "TOTAL ARTIGO" vive na coluna Farmácia, que é
       alinhada à esquerda — e uma célula alinhada à esquerda quebra
       linha por defeito (ver a regra tbody td[style*="text-align:left"]
       acima), engordando a linha inteira para caber "TOTAL" numa linha e
       "ARTIGO" noutra. Nunca quebra aqui — a largura já chega para o
       texto numa linha só, e overflow:hidden/text-overflow:ellipsis
       (herdados de tbody td) continuam a proteger o caso extremo. */
    white-space: nowrap;
  }
  .page.density-compact tbody tr.subtotal-row td:first-child { border-left: 3px solid #475569; }
  .page.density-compact tfoot td {
    background: #e2e8f0 !important;
    color: #1e293b !important;
    border-top: 2px solid #94a3b8;
    border-bottom: none;
    /* Quase a altura de uma linha normal (tbody td tem 2.5px de
       padding vertical) — era uma faixa alta (5px + "TOTAL GERAL" a
       quebrar em duas linhas pela mesma razão do subtotal, acima).
       font-size herdado da tabela (cozy/tight/ultratight) em vez de um
       valor fixo, que ficava desproporcionalmente grande nas
       densidades mais apertadas. */
    padding: 3px 5px;
    font-size: inherit;
    white-space: nowrap;
  }

  /* Sublinha discreta sob uma célula (ReportColumn.noteKey) — ex.:
     descrição do artigo + "PVP: 27,90 € | Custo: —". */
  .page.density-compact .cell-main { line-height: 1.25; }
  .page.density-compact .cell-note {
    font-size: 0.82em; color: #94a3b8; margin-top: 1px; font-weight: 400;
  }

  /* Tons condicionais — ver ReportColumn.toneWhenZero/toneWhenPositive.
     Sempre suaves: nunca um bloco cheio, cor com significado, não
     decoração. */
  .page.density-compact .cell-tone-danger  { background: #fdecec !important; color: #9f2b2b; }
  .page.density-compact .cell-tone-success { background: #e8f7ee !important; color: #1f7a45; }
  .page.density-compact .cell-tone-info    { background: #eaf2fd !important; }

  /* Densidade fina por nº de colunas dinâmicas (ex.: meses de Vendas) —
     ver report.meta.tableDensity. */
  .page.density-compact table.table-density-tight { font-size: 8.5px; }
  .page.density-compact table.table-density-tight thead th { font-size: 7.5px; padding: 3.5px 4px; }
  .page.density-compact table.table-density-tight tbody td { padding: 2px 4px; }
  .page.density-compact table.table-density-ultratight { font-size: 8px; }
  .page.density-compact table.table-density-ultratight thead th { font-size: 7px; padding: 3px 3px; }
  .page.density-compact table.table-density-ultratight tbody td { padding: 1.5px 3px; }

  /* ── Rodapé compacto — nota à esquerda, marca fixa à direita ── */
  .page.density-compact .report-footer.compact {
    display: flex; justify-content: space-between; align-items: baseline;
    margin-top: 6px; padding-top: 4px; border-top: 1px solid #e2e8f0;
    font-size: 7.5px; color: #94a3b8; letter-spacing: 0.2px; text-align: left;
  }
  .page.density-compact .footer-note { max-width: 80%; }
  .page.density-compact .footer-brand { white-space: nowrap; }

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
  const pageClass = isCompact(report) ? "page density-compact" : "page";

  return `<!doctype html>
<html lang="pt-PT">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(report.title)}</title>
<style>${styles}</style>
</head>
<body>
<div class="${pageClass}">
  ${renderHeader(report)}
  ${renderFilters(report)}
  ${renderSummary(report)}
  ${renderTable(report)}
  ${renderFooter(report)}
</div>
</body>
</html>`;
}
