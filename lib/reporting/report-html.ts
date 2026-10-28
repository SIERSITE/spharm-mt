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
import { formatCell, formatDate, formatDateTime } from "./report-formatters";
import { aplicarPrivacidade } from "./privacidade";

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

/**
 * Morada/NIF/contacto da farmácia, para a carta-cabeçalho dos documentos
 * profissionais (Nota de Encomenda, Guia de Transferência) — ver
 * `ReportMeta.organizationAddress` em report-types.ts. Nunca mostra uma
 * linha vazia: cada campo só entra se vier preenchido.
 */
function renderOrgDetails(report: Report): string {
  const partes: string[] = [];
  if (report.meta?.organizationAddress) partes.push(escapeHtml(report.meta.organizationAddress));
  if (report.meta?.organizationNif) partes.push(`NIF ${escapeHtml(report.meta.organizationNif)}`);
  if (report.meta?.organizationContact) partes.push(escapeHtml(report.meta.organizationContact));
  if (partes.length === 0) return "";
  return `<div class="org-details">${partes.join(" · ")}</div>`;
}

function renderHeader(report: Report): string {
  const org = report.meta?.organization ?? "";
  const generated = formatDateTime(report.generatedAt);
  const orgDetails = renderOrgDetails(report);

  if (!isCompact(report)) {
    return `
    <header class="report-header">
      <div class="head-main">
        ${org ? `<div class="org">${escapeHtml(org)}</div>` : ""}
        ${orgDetails}
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
          ${orgDetails}
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

/**
 * Marca "ANULADO" — ver `ReportMeta.cancelledStamp`. Só desenha algo
 * quando o adapter define o campo; um relatório que nunca o usa fica
 * com o HTML idêntico ao de antes disto existir. Nunca aparece no
 * Excel (report-excel.ts não lê `cancelledStamp`).
 */
function renderCancelledStamp(report: Report): string {
  const stamp = report.meta?.cancelledStamp;
  if (!stamp) return "";

  const detalhes: string[] = [];
  if (stamp.motivo) detalhes.push(`Motivo: ${escapeHtml(stamp.motivo)}`);
  if (stamp.por) detalhes.push(`Por: ${escapeHtml(stamp.por)}`);
  if (stamp.em) detalhes.push(`Em: ${escapeHtml(formatDate(stamp.em))}`);

  return `
    <div class="cancelled-stamp">
      <div class="cancelled-stamp-mark">ANULADO</div>
      ${detalhes.length > 0 ? `<div class="cancelled-stamp-details">${detalhes.join(" · ")}</div>` : ""}
    </div>
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
      <div class="filter-line">${items}</div>${renderResumoFaixa(report)}
    </section>
  `;
}

/** Faixa de uma linha com os itens do resumo pedidos em `meta.resumoFaixa` (ex.: Unidades vendidas · Stock total). */
function renderResumoFaixa(report: Report): string {
  const rotulos = report.meta?.resumoFaixa;
  if (!rotulos || rotulos.length === 0 || !report.summary) return "";
  const itens = rotulos
    .map((r) => report.summary!.find((s) => s.label === r))
    .filter((s): s is NonNullable<typeof s> => !!s)
    .map((s) => `<span class="resumo-item"><span>${escapeHtml(s.label)}:</span> <strong>${escapeHtml(formatCell(s.value, s.format))}</strong></span>`);
  return itens.length > 0 ? `<div class="resumo-faixa" data-testid="resumo-faixa">${itens.join("")}</div>` : "";
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
    if (n === 0) return col.zeroText ?? "–";
  }
  return formatCell(raw, col.format);
}

/**
 * Um grupo (artigo) com mais linhas do que isto NÃO usa `rowspan`: o bloco pode atravessar páginas e a célula
 * agrupada só existiria na primeira. Nesse caso CNP/Descrição repetem-se em cada linha (identificação suficiente).
 */
const MAX_LINHAS_COM_ROWSPAN = 14;

/** Classe de estado de stock (ver `ReportColumn.stockIndicator`), ou "". */
function stockClass(value: ReportCell): string {
  const n = numericValue(value);
  if (n === null) return "";
  if (n < 0) return "stk-neg";
  if (n === 0) return "stk-zero";
  return "stk-pos";
}

function renderTable(report: Report): string {
  const compact = isCompact(report);
  const cols = report.columns.filter((c) => !c.hidden && !c.excelOnly);
  if (cols.length === 0 || report.rows.length === 0) {
    return `<section class="table-wrap"><div class="empty">Sem dados a apresentar.</div></section>`;
  }

  // Blocos temporais (ver ReportMeta.columnBlocks): sem blocos = um só, com todas as colunas — HTML idêntico ao de sempre.
  const blocos = report.meta?.columnBlocks && report.meta.columnBlocks.length > 1 ? report.meta.columnBlocks : null;

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
  const semGrupos = grupos.every((g) => g.groupKey === undefined);
  const limpo = report.meta?.hierarchy === "clean";

  const renderBloco = (colsB: ReportColumn[], ultimo: boolean, fator: number): string => {
    // <colgroup> com larguras explícitas — combinado com table-layout:fixed
    // garante que as colunas respeitam os tamanhos definidos pelo adapter.
    const colgroup = colsB
      .map((c) => {
        const w = widthToCss(c.width && fator !== 1 && c.width <= 100 ? c.width * fator : c.width);
        return `<col${w ? ` style="width:${w}"` : ""} />`;
      })
      .join("");

    // Paridade dos meses DENTRO do bloco (fundo alternado discreto).
    const mesAlt = new Set<string>();
    colsB.filter((c) => c.monthAlt).forEach((c, i) => { if (i % 2 === 1) mesAlt.add(c.key); });

    // SEPARADORES VERTICAIS DOS MESES (só no relatório limpo): cada mês leva uma borda esquerda muito fina; o 1.º mês do bloco e o
    // último levam o limite do bloco. São BORDAS (imprimem-se mesmo com «gráficos de fundo» desligado) e vêm das mesmas classes no
    // cabeçalho, no corpo, no «TOTAL ARTIGO» e no «TOTAL GERAL» — por isso coincidem e são contínuas de cima a baixo. Se a coluna a
    // seguir ao último mês é de totais (`tint`), o limite desenha-o essa coluna (um só filete, nunca dois lado a lado).
    const colunasMes = colsB.filter((c) => c.monthAlt);
    const primeiraMes = colunasMes[0]?.key;
    const ultimaMes = colunasMes[colunasMes.length - 1]?.key;
    const classesMes = (c: ReportColumn, i: number): string[] => {
      if (!limpo) return [];
      const out: string[] = [];
      if (c.monthAlt) {
        out.push("mes");
        if (c.key === primeiraMes) out.push("mes-ini");
        if (c.key === ultimaMes) {
          out.push("mes-fim");
          if (colsB[i + 1]?.tint === "total") out.push("mes-fim-tint");
        }
      } else if (c.tint === "total" && i > 0 && colsB[i - 1].key === ultimaMes) {
        out.push("apos-mes");
      }
      return out;
    };

    const headerCells = colsB
      .map((c, ci) => {
        const style = alignStyle(defaultAlignFor(c));
        // Um rótulo pode trazer "\n" para pedir cabeçalho em duas linhas
        // (ex.: meses "JAN\n26", ou "Custo unit.\nest.") — a forma mais
        // curta de dar mais largura de leitura a cada linha sem estreitar
        // a coluna nem cortar texto.
        const label = escapeHtml(c.label).replace(/\n/g, "<br/>");
        const cls = [c.noClip ? "nc" : "", mesAlt.has(c.key) ? "mes-alt" : "", c.tint === "total" ? "tint-total" : "", ...classesMes(c, ci)].filter(Boolean).join(" ");
        return `<th style="${style}"${cls ? ` class="${cls}"` : ""}>${label}</th>`;
      })
      .join("");

    const renderRow = (row: ReportRow, idx: number): string => {
      const subtotal = ehLinhaSubtotal(row);
      const grupo = grupoDoIndice.get(idx) ?? { length: 1, isFirst: true };
      const usaSpan = grupo.length > 1 && grupo.length <= MAX_LINHAS_COM_ROWSPAN;
      const tds = colsB
        .map((c, ci) => {
          if (c.spanGroup && usaSpan && !grupo.isFirst) {
            // Coberta pelo rowspan emitido na 1ª linha do grupo — uma
            // tabela HTML válida não pode repetir esta célula.
            return "";
          }
          const style = alignStyle(defaultAlignFor(c));
          const valor = effectiveCellValue(row, c);
          const classes: string[] = [];
          const tone = cellToneClass(valor, c);
          if (tone) classes.push(tone);
          if (c.noClip) classes.push("nc");
          if (c.spanGroup) classes.push("sg");
          // Colunas numéricas (valores, quantidades, stock, totais): +1 px no relatório limpo (ver `.num`).
          if (limpo && (c.format === "currency" || c.format === "integer" || c.format === "number" || c.format === "decimal1" || c.format === "percent")) classes.push("num");
          if (mesAlt.has(c.key)) classes.push("mes-alt");
          if (c.tint === "total") classes.push("tint-total");
          classes.push(...classesMes(c, ci));
          if (c.monthAlt) {
            // zero → «·» apagado; > 0 → semibold; < 0 (devoluções) → bold a vermelho-escuro (o sinal «-» mantém-se)
            const nv = numericValue(valor);
            if (nv === 0) classes.push("mes-v");
            else if (nv !== null && nv < 0) classes.push("mq", "mneg");
            else if (nv !== null) classes.push("mq");
          }
          let conteudoBase = escapeHtml(cellText(row, c));
          if (c.stockIndicator && !subtotal) {
            const st = stockClass(valor);
            if (st) {
              classes.push(st);
              // Zero (caixa) e negativo (inversão) levam a pastilha; o positivo fica número simples.
              if (st !== "stk-pos") conteudoBase = `<span class="stk-box">${conteudoBase}</span>`;
            }
          }
          const classAttr = classes.length > 0 ? ` class="${classes.join(" ")}"` : "";
          const rowspanAttr = c.spanGroup && usaSpan && grupo.isFirst ? ` rowspan="${grupo.length}"` : "";
          const notaRaw = c.noteKey ? row[c.noteKey] : undefined;
          const conteudo =
            typeof notaRaw === "string" && notaRaw !== ""
              ? `<div class="cell-main">${conteudoBase}</div><div class="cell-note">${escapeHtml(notaRaw)}</div>`
              : conteudoBase;
          return subtotal
            ? `<td style="${style}"${rowspanAttr}${classAttr}><strong>${conteudo}</strong></td>`
            : `<td style="${style}"${rowspanAttr}${classAttr}>${conteudo}</td>`;
        })
        .join("");
      return subtotal ? `<tr class="subtotal-row">${tds}</tr>` : `<tr>${tds}</tr>`;
    };

    const linhasHtml = report.rows.map(renderRow);
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
            // O último artigo fica com o TOTAL GERAL (nunca uma página só com os totais).
            const ult = report.meta?.hierarchy === "clean" && gi === grupos.length - 1 ? " row-group-ultimo" : "";
            return `<tbody class="row-group${alt}${ult}">${linhasDoGrupo.join("")}</tbody>`;
          })
          .join("");

    // TOTAIS SOBRE O DETALHE, e não sobre `report.rows`: com os subtotais
    // dentro, cada artigo contava duas vezes.
    const totals = computeTotals(colsB, linhasDeDetalhe(report.rows));
    const hasTotals = Object.keys(totals).length > 0 && ultimo;
    // Ponto 6 (quebra de página): NUNCA `<tfoot>` — `display:table-footer-
    // group` repete o conteúdo no fim de TODAS as páginas do PDF/impressão
    // de uma tabela multi-página (comportamento standard do motor de
    // paginação, confirmado com PDFs reais via Puppeteer: "TOTAL GERAL"
    // aparecia — com o valor final, já somado — logo na 1ª página, antes
    // de a tabela sequer acabar). Um `<tbody>` final comum aparece só UMA
    // vez, no fim natural do conteúdo, exactamente onde deve estar.
    //
    // Compacto: o rótulo ocupa TODAS as colunas até à primeira com total
    // (colspan) — "TOTAL GERAL" numa coluna de CNP estreita aparecia
    // cortado como «TOTA». Nos restantes relatórios fica na 1ª célula.
    let totalsRow = "";
    if (hasTotals) {
      const primeiroComTotal = colsB.findIndex((c) => c.showTotal);
      const spanRotulo = compact && primeiroComTotal > 1 ? primeiroComTotal : 1;
      const celulas: string[] = [];
      for (let i = 0; i < colsB.length; i++) {
        const c = colsB[i];
        const style = alignStyle(defaultAlignFor(c));
        const ncClasses = [c.noClip ? "nc" : "", limpo && (c.format === "currency" || c.format === "integer" || c.format === "number") ? "num" : "", c.tint === "total" ? "tint-total" : "", ...classesMes(c, i)].filter(Boolean).join(" ");
        const nc = ncClasses ? ` class="${ncClasses}"` : "";
        if (i === 0) {
          // "TOTAL GERAL", não "Total" — para nunca se confundir, à
          // primeira vista, com "TOTAL ARTIGO" (o subtotal por linha,
          // ver .subtotal-row acima) numa tabela com muitas linhas.
          celulas.push(`<td style="text-align:left;"${spanRotulo > 1 ? ` colspan="${spanRotulo}"` : ""}><strong>TOTAL GERAL</strong></td>`);
          i += spanRotulo - 1;
          continue;
        }
        if (c.showTotal) {
          celulas.push(`<td style="${style}"${nc}><strong>${escapeHtml(formatCell(totals[c.key], c.format))}</strong></td>`);
        } else {
          const cl = [c.tint === "total" ? "tint-total" : "", ...classesMes(c, i)].filter(Boolean).join(" ");
          celulas.push(cl ? `<td class="${cl}"></td>` : `<td></td>`);
        }
      }
      totalsRow = `<tbody class="totals-tbody"><tr>${celulas.join("")}</tr>__NOTA__</tbody>`;
    }

    const tableDensity = report.meta?.tableDensity;
    const tableClass = tableDensity && tableDensity !== "cozy" ? ` class="table-density-${tableDensity}"` : "";

    // Hierarquia «clean»: a contagem e as notas do relatório vão numa linha FINAL DA PRÓPRIA TABELA. Fora dela (como
    // `.report-footer`) podiam cair sozinhas numa página nova, sem o cabeçalho da tabela; dentro, se não couberem, a
    // página seguinte repete o cabeçalho.
    const notaFinal =
      ultimo && report.meta?.hierarchy === "clean"
        ? `<tr class="nota-tr"><td colspan="${colsB.length}"><div class="nota-count">${escapeHtml(
            report.meta?.tableNote ?? `${report.rows.length} linha${report.rows.length === 1 ? "" : "s"}`,
          )}</div><div class="nota-final"><span class="footer-note">${escapeHtml(report.meta?.footer ?? "SPharm.MT")}</span><span class="footer-brand">SPharm.MT · www.spharm.pt</span></div></td></tr>`
        : "";

    return `
      <table${tableClass}>
        <colgroup>${colgroup}</colgroup>
        <thead><tr>${headerCells}</tr></thead>
        ${tbodyHtml}
        ${totalsRow.replace("__NOTA__", () => notaFinal) || (notaFinal ? `<tbody class="totals-tbody">${notaFinal}</tbody>` : "")}
      </table>`;
  };

  const nota = report.meta?.tableNote ?? `${report.rows.length} linha${report.rows.length === 1 ? "" : "s"}`;
  const rodapeTabela = report.meta?.hierarchy === "clean" ? "" : `<div class="row-count">${escapeHtml(nota)}</div>`;

  if (!blocos) {
    return `
    <section class="table-wrap">${renderBloco(cols, true, 1)}
      ${rodapeTabela}
    </section>
  `;
  }

  // Blocos temporais: cada um é uma tabela completa (cabeçalho próprio, repetido em cada página pelo motor).
  const partes = blocos.map((b, i) => {
    const colsB = cols.filter((c) => !b.omitir.includes(c.key));
    const soma = colsB.reduce((s, c) => s + (c.width && c.width <= 100 ? c.width : 0), 0);
    const fator = soma > 0 && soma < 100 ? 100 / soma : 1;
    const ultimo = i === blocos.length - 1;
    return `
    <section class="table-wrap bloco-temporal${i > 0 ? " bloco-novo" : ""}">
      <div class="bloco-titulo"><strong>Parte ${i + 1} de ${blocos.length}</strong> · ${escapeHtml(b.titulo)}</div>${renderBloco(colsB, ultimo, fator)}
      ${ultimo ? rodapeTabela : ""}
    </section>`;
  });
  return partes.join("\n");
}

function renderFooter(report: Report): string {
  const footer = report.meta?.footer ?? "SPharm.MT";
  if (report.meta?.hierarchy === "clean") return ""; // a nota vai na última linha da tabela (ver `notaFinal`)
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
  .report-header .org-details { font-size: 9px; color: #666; margin-bottom: 5px; }
  .report-header h1 { font-size: 17px; margin: 0 0 3px 0; font-weight: 700; color: #111; letter-spacing: -0.2px; }
  .report-header .subtitle { font-size: 11px; color: #555; }
  .report-header .head-meta {
    text-align: right; font-size: 9px; color: #666;
    white-space: nowrap; padding-left: 16px;
  }
  .report-header .head-meta strong { color: #222; font-weight: 700; }

  /* ── Marca "ANULADO" (ver ReportMeta.cancelledStamp) — HTML/PDF/print
     apenas, nunca no Excel. Vive fora de .report-header porque tem de
     aparecer independentemente de density comfortable/compact. ── */
  .cancelled-stamp {
    border: 3px solid #b91c1c;
    border-radius: 6px;
    padding: 6px 16px;
    margin: 0 0 12px 0;
    display: inline-block;
    background: #fef2f2;
  }
  .cancelled-stamp-mark {
    display: inline-block;
    font-size: 22px;
    font-weight: 800;
    letter-spacing: 4px;
    color: #b91c1c;
    transform: rotate(-4deg);
  }
  .cancelled-stamp-details {
    margin-top: 3px;
    font-size: 9px;
    font-weight: 600;
    color: #7f1d1d;
  }

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
  /* .totals-tbody, não tfoot — ver o comentário em renderTable
     (totalsRow) sobre porque um <tfoot> repete por página. */
  .totals-tbody td {
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
  .page.density-compact .org-details { font-size: 7.5px; color: #7f99a1; margin-top: 1px; }
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
  .page.density-compact .totals-tbody td {
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

  /* ═══════════════════════════════════════════════════════════════════
     HIERARQUIA FORTE — meta.hierarchy:"strong" (Vendas, 2026-10)
     Escopado a .page.density-compact.hierarchy-strong: zero efeito em
     qualquer relatório que não a peça. A separação entre artigos NÃO
     depende só da cor — bordas, peso tipográfico e espaçamento
     preservam a hierarquia em papel e em impressão monocromática:

       cabeçalho .......... fundo escuro, texto branco, bold
       início do artigo ... borda superior de 2px (preta)
       artigos alternados . branco ↔ cinzento nítido (#e5e7eb)
       linhas da farmácia . peso normal, separador ponteado (subordinadas)
       TOTAL ARTIGO ....... bold, fundo azul-acinzentado ~25% mais escuro
                            que o bloco, bordas superior/inferior de 2px

     Fundos moderados (nenhum acima de ~25% de tinta, excepto a linha de
     cabeçalho, uma só) para não gastar tinta em excesso.
     ═══════════════════════════════════════════════════════════════════ */
  .page.density-compact.hierarchy-strong thead th {
    background: #1f2937 !important;
    color: #ffffff !important;
    font-weight: 700;
    border: 1px solid #111827;
    border-bottom: 2px solid #000000;
  }
  .page.density-compact.hierarchy-strong tbody td {
    border-left: 1px solid #d1d5db;
    border-right: 1px solid #d1d5db;
    border-bottom: 1px dotted #9ca3af;
    color: #374151;
  }
  .page.density-compact.hierarchy-strong tbody.row-group td { background: #ffffff !important; }
  .page.density-compact.hierarchy-strong tbody.row-group-alt td { background: #e5e7eb !important; }
  /* Início de cada artigo: borda forte — inclui as células que cobrem várias linhas (CNP/Descrição). */
  .page.density-compact.hierarchy-strong tbody.row-group > tr:first-child > td {
    border-top: 2px solid #111827;
  }
  /* Tons condicionais (zero/positivo) continuam a ler-se por cima do fundo do bloco. */
  .page.density-compact.hierarchy-strong tbody td.cell-tone-danger  { background: #fbd5d5 !important; color: #7f1d1d; }
  .page.density-compact.hierarchy-strong tbody td.cell-tone-success { background: #c9ecd6 !important; color: #14532d; }
  .page.density-compact.hierarchy-strong tbody td.cell-tone-info    { background: #dce8f9 !important; }
  /* TOTAL ARTIGO: por último, para ganhar aos tons e ao fundo do bloco. */
  .page.density-compact.hierarchy-strong tbody.row-group tr.subtotal-row td {
    background: #b9c4d0 !important;
    color: #000000;
    font-weight: 700;
    padding-top: 3.5px;
    padding-bottom: 3.5px;
    border-top: 2px solid #111827;
    border-bottom: 2px solid #111827;
    border-left: 1px solid #6b7280;
    border-right: 1px solid #6b7280;
  }
  .page.density-compact.hierarchy-strong tbody.row-group tr.subtotal-row td:first-child {
    border-left: 4px solid #111827;
  }
  .page.density-compact.hierarchy-strong .totals-tbody td {
    background: #9ca3af !important;
    color: #000000;
    font-weight: 800;
    border-top: 3px double #111827;
    border-bottom: 2px solid #111827;
  }

  /* ═══════════════════════════════════════════════════════════════════
     MAPA DE VENDAS (2026-10) — valores completos, stock legível a P&B,
     meses alternados discretos, blocos temporais.
     ═══════════════════════════════════════════════════════════════════ */

  /* Valores monetários: NUNCA cortados (a largura da coluna é calculada pelo adapter para o texto caber). */
  .page.density-compact thead th.nc,
  .page.density-compact tbody td.nc {
    overflow: visible;
    text-overflow: clip;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  /* Fundo alternado dos meses: película de 4% de tinta, por cima do fundo do bloco — quase imperceptível, nunca decisiva. */
  .page.density-compact tbody td.mes-alt { background-image: linear-gradient(rgba(15, 23, 42, 0.045), rgba(15, 23, 42, 0.045)) !important; }
  .page.density-compact thead th.mes-alt { background-image: linear-gradient(rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0.12)) !important; }

  /* Stock: positivo = número simples (verde suave); zero = número em CAIXA; negativo = branco sobre preto. */
  .page.density-compact tbody td.stk-pos { font-weight: 600; }
  .page.density-compact tbody td.stk-zero .stk-box {
    display: inline-block; min-width: 1.6em; text-align: center;
    border: 1px solid #111827; border-radius: 2px; padding: 0 2px; font-weight: 700; color: #7f1d1d;
  }
  .page.density-compact tbody td.stk-neg .stk-box {
    display: inline-block; min-width: 1.6em; text-align: center;
    background: #111827 !important; color: #ffffff !important; border-radius: 2px; padding: 0 3px; font-weight: 800;
  }
  /* A célula de stock já não leva o tom de fundo do bloco "cheio": o indicador é o próprio número. */
  .page.density-compact.hierarchy-strong tbody td.stk-zero { background: #fbe4e4 !important; }
  .page.density-compact.hierarchy-strong tbody td.stk-neg { background: #f3c9c9 !important; }

  /* Blocos temporais (períodos longos): cada parte numa página nova, com legenda própria. */
  .bloco-titulo {
    font-size: 9px; color: #1f2937; margin: 4px 0 4px 0; padding: 2px 6px;
    border-left: 4px solid #111827; background: #f3f4f6;
  }

  /* ═══════════════════════════════════════════════════════════════════
     HIERARQUIA LIMPA — meta.hierarchy:"clean" (Mapa de Vendas, 2026-10)
     Relatório leve e profissional, na direção do PDF de referência do cliente:
       cabeçalho da tabela .... fundo quase branco, texto escuro, UMA linha inferior (1.5px)
       corpo .................. SEM grelha: sem linhas verticais, sem caixas por célula; só filetes horizontais
                                finos (#eceff3) entre farmácias
       artigo ................. espaço no topo + UMA linha fina (1px) a separá-lo do anterior; sem zebra
       linhas da farmácia ..... subordinadas (texto normal, cinzento escuro)
       TOTAL ARTIGO ........... fundo cinzento muito claro + semibold, sem molduras
       TOTAL GERAL ............ cinzento claro, bold, linha superior de 1.5px (nível acima do subtotal)
       meses .................. brancos, com película de 2.5 % em meses alternados; valores > 0 a semibold, «·» a cinzento
       stock .................. positivo: número; zero: contorno fino; negativo: pastilha escura pequena
     A hierarquia não depende só da cor (peso, espaço, filetes) — lê-se em escala de cinzentos.
     Escopado a .hierarchy-clean: Margens (hierarchy-strong) fica exactamente como estava.
     ═══════════════════════════════════════════════════════════════════ */
  .page.density-compact.hierarchy-clean { color: #1f2937; }
  .page.density-compact.hierarchy-clean .report-header.compact { border-bottom: 1px solid #e5e7eb; padding-bottom: 5px; margin-bottom: 5px; }
  .page.density-compact.hierarchy-clean .head-title h1 { font-size: 17px; color: #111827; }
  .page.density-compact.hierarchy-clean .filter-line { font-size: 9.5px; color: #4b5563; row-gap: 3px; }
  .page.density-compact.hierarchy-clean .filter-item:not(:last-child) { border-right: 1px solid #e5e7eb; }
  .page.density-compact.hierarchy-clean .table-wrap { margin-top: 8px; }

  /* tabela: sem grelha */
  /* Bordas SEPARADAS (não colapsadas): cada filete pertence à sua célula. Com bordas colapsadas, o filete partilhado entre dois
     artigos é pintado no TOPO da página seguinte quando a tabela quebra — um filete isolado por cima do 1.º artigo, colado ao
     sublinhado do cabeçalho repetido. Assim o filete que fecha um artigo fica sempre com ele. */
  .page.density-compact.hierarchy-clean table { border-collapse: separate; border-spacing: 0; }
  .page.density-compact.hierarchy-clean thead th {
    background: #f8fafc !important; color: #1f2937 !important; font-weight: 600;
    border: 0; border-bottom: 1.5px solid #334155; padding-top: 5px; padding-bottom: 5px;
    text-transform: none; letter-spacing: 0; line-height: 1.25; vertical-align: bottom;
  }
  .page.density-compact.hierarchy-clean tbody td {
    border: 0; border-bottom: 1px solid #eef0f3;
    color: #374151; line-height: 1.3; vertical-align: middle;
  }
  .page.density-compact.hierarchy-clean tbody.row-group td,
  .page.density-compact.hierarchy-clean tbody.row-group-alt td,
  .page.density-compact.hierarchy-clean tbody tr:hover td { background: #ffffff !important; }

  /* SEPARADOR ENTRE ARTIGOS (2026-10): um filete contínuo (2px, cinzento azulado médio — o Chromium arredonda as bordas a píxeis inteiros: 1.75px sairia a 1px no PDF) em toda a largura entre um artigo e o
     seguinte — inclusive os artigos de uma só farmácia, que não têm «TOTAL ARTIGO». É a borda INFERIOR da última linha do artigo
     (não a superior da primeira do seguinte), por três razões de paginação: um artigo que começa numa página nova não é precedido
     de nenhum filete (não se confunde com o sublinhado do cabeçalho repetido, que é uma borda colapsada com a 1.ª linha); a 1.ª linha
     de cada página fica limpa; e o último artigo não leva filete (o TOTAL GERAL tem o seu). As células agrupadas na vertical (CNP/Descrição)
     fecham a sua própria borda inferior. Entre farmácias do mesmo artigo e antes do «TOTAL ARTIGO» ficam só os filetes leves. */
  .page.density-compact.hierarchy-clean tbody.row-group > tr:first-child > td { border-top: 0; padding-top: 8px; }
  .page.density-compact.hierarchy-clean tbody.row-group > tr:last-child > td { border-bottom: 0; }
  .page.density-compact.hierarchy-clean tbody.row-group:not(.row-group-ultimo) > tr:last-child > td,
  .page.density-compact.hierarchy-clean tbody.row-group:not(.row-group-ultimo) > tr > td[rowSpan] { border-bottom: 2px solid #8493a6; }
  .page.density-compact.hierarchy-clean tbody td.sg { color: #111827; vertical-align: middle; }
  .page.density-compact.hierarchy-clean tbody td.sg + td.sg { font-weight: 600; }
  .page.density-compact.hierarchy-clean tbody td.sg:first-child { color: #374151; font-weight: 500; }
  .page.density-compact.hierarchy-clean tbody tr.subtotal-row td strong { font-weight: 600; }

  /* TOTAL ARTIGO: cinzento muito claro, semibold, sem molduras */
  .page.density-compact.hierarchy-clean tbody.row-group tr.subtotal-row td,
  .page.density-compact.hierarchy-clean tbody.row-group tr.subtotal-row:hover td {
    background: #f1f3f6 !important; color: #111827; font-weight: 600;
    border: 0; border-top: 1px solid #e2e5ea; padding-top: 3.5px; padding-bottom: 3.5px;
  }
  .page.density-compact.hierarchy-clean tbody.row-group tr.subtotal-row td:first-child { border-left: 0; }
  .page.density-compact.hierarchy-clean tbody.row-group tr.subtotal-row td.cell-tone-danger,
  .page.density-compact.hierarchy-clean tbody.row-group tr.subtotal-row td.cell-tone-success { background: #f1f3f6 !important; }

  /* TOTAL GERAL: um nível acima do subtotal, ainda leve */
  .page.density-compact.hierarchy-clean .totals-tbody td {
    background: #e5e8ed !important; color: #111827; font-weight: 700;
    border: 0; border-top: 1.5px solid #334155; border-bottom: 1px solid #334155;
    padding-top: 5px; padding-bottom: 5px;
  }

  /* meses: brancos; película mínima nos alternados; valores com peso, «·» apagado */
  .page.density-compact.hierarchy-clean tbody td.mes-alt { background-image: linear-gradient(rgba(15, 23, 42, 0.028), rgba(15, 23, 42, 0.028)) !important; }
  .page.density-compact.hierarchy-clean thead th.mes-alt { background-image: none !important; }
  .page.density-compact.hierarchy-clean tbody td.mes-v { color: #9ca3af; }
  .page.density-compact.hierarchy-clean tbody td.mq { color: #111827; font-weight: 600; }
  .page.density-compact.hierarchy-clean tbody tr.subtotal-row td.mes-v { color: #9ca3af; }
  .page.density-compact.hierarchy-clean tbody td.mneg { color: #111827; font-weight: 700; color: #7f1d1d; }

  /* stock: positivo = número (tom verde muito leve); zero = contorno fino; negativo = pastilha escura pequena */
  .page.density-compact.hierarchy-clean tbody td.cell-tone-success { background: #f0f8f3 !important; color: #14532d; }
  .page.density-compact.hierarchy-clean tbody td.cell-tone-danger { background: #fcf0f0 !important; color: #7f1d1d; }
  .page.density-compact.hierarchy-clean tbody td.stk-neg { background: #fcf0f0 !important; }
  .page.density-compact.hierarchy-clean tbody td.stk-pos { font-weight: 500; }
  .page.density-compact.hierarchy-clean tbody td.stk-zero .stk-box {
    min-width: 1.4em; padding: 0 2px; border: 1px solid #6b7280; border-radius: 2px; color: #7f1d1d; font-weight: 600;
  }
  .page.density-compact.hierarchy-clean tbody td.stk-neg .stk-box {
    min-width: 1.4em; padding: 0 2px; background: #374151 !important; color: #ffffff !important; border-radius: 2px; font-weight: 700;
  }

  /* blocos temporais: legenda discreta */
  .page.density-compact.hierarchy-clean .bloco-titulo { background: #f8fafc; border-left: 3px solid #94a3b8; color: #374151; margin-top: 6px; }
  .page.density-compact.hierarchy-clean .row-count { color: #6b7280; }
  .page.density-compact.hierarchy-clean .totals-tbody tr.nota-tr td { border: 0 !important; background: #ffffff !important; padding: 8px 0 0 0; font-size: 8px; line-height: 1.35; color: #6b7280; font-weight: 400; white-space: normal; overflow: visible; text-overflow: clip; overflow-wrap: normal; }
  .page.density-compact.hierarchy-clean .totals-tbody { break-inside: avoid; page-break-inside: avoid; }
  .page.density-compact.hierarchy-clean tbody.row-group-ultimo { break-after: avoid; page-break-after: avoid; }
  .page.density-compact.hierarchy-clean .nota-count { text-align: right; font-style: italic; margin-bottom: 4px; }
  .page.density-compact.hierarchy-clean .nota-final { display: flex; justify-content: space-between; gap: 16px; align-items: baseline; }
  .page.density-compact.hierarchy-clean .nota-final .footer-note { max-width: 82%; }
  .page.density-compact.hierarchy-clean .nota-final .footer-brand { white-space: nowrap; }
  .page.density-compact.hierarchy-clean .report-footer.compact { color: #6b7280; font-size: 8px; margin-top: 8px; }

  /* COLUNA «TOTAL UNID.» (meses → total do período → stock atual): fundo azul-acinzentado próprio e dois filetes laterais, que
     a distinguem dos meses (brancos), do stock (verde/vermelho muito leves), dos subtotais (cinzento) e do TOTAL GERAL — e que
     se lêem em cinzentos mesmo sem cor. Cabeçalho, células, subtotais e total geral seguem a mesma lógica. */
  .page.density-compact.hierarchy-clean thead th.tint-total { background: #d9e6f5 !important; border-left: 1px solid #8396ad; border-right: 1px solid #8396ad; }
  .page.density-compact.hierarchy-clean tbody td.tint-total { background: #e1ecf8 !important; border-left: 1px solid #b4c3d6; border-right: 1px solid #b4c3d6; }
  .page.density-compact.hierarchy-clean tbody.row-group tr.subtotal-row td.tint-total { background: #d4e3f4 !important; }
  .page.density-compact.hierarchy-clean .totals-tbody td.tint-total { background: #c8daf0 !important; border-left: 1px solid #8396ad; border-right: 1px solid #8396ad; }

  /* SEPARADORES VERTICAIS DOS MESES — para ler em papel (a preto e branco, com «gráficos de fundo» desligado) a que mês pertence cada
     valor. Só nas colunas mensais: 1px (0,75pt) cinzento claro entre meses; 1px um pouco mais escuro nos limites do bloco (antes do
     1.º mês e depois do último). Mais leves do que o separador entre artigos (2px). São bordas das células: contínuas do cabeçalho ao
     TOTAL GERAL, sem fundos, sem grelha nas outras colunas. Os seletores têm especificidade acima das regras de «TOTAL ARTIGO»
     (border:0) e do TOTAL GERAL para não serem anulados. */
  .page.density-compact.hierarchy-clean thead th.mes,
  .page.density-compact.hierarchy-clean tbody td.mes,
  .page.density-compact.hierarchy-clean tbody.row-group tr.subtotal-row td.mes,
  .page.density-compact.hierarchy-clean .totals-tbody td.mes { border-left: 1px solid #b4bac4; }
  .page.density-compact.hierarchy-clean thead th.mes-ini,
  .page.density-compact.hierarchy-clean tbody td.mes-ini,
  .page.density-compact.hierarchy-clean tbody.row-group tr.subtotal-row td.mes-ini,
  .page.density-compact.hierarchy-clean .totals-tbody td.mes-ini { border-left: 1px solid #9aa4b2; }
  .page.density-compact.hierarchy-clean thead th.mes-fim:not(.mes-fim-tint),
  .page.density-compact.hierarchy-clean tbody td.mes-fim:not(.mes-fim-tint),
  .page.density-compact.hierarchy-clean tbody.row-group tr.subtotal-row td.mes-fim:not(.mes-fim-tint),
  .page.density-compact.hierarchy-clean .totals-tbody td.mes-fim:not(.mes-fim-tint) { border-right: 1px solid #9aa4b2; }
  /* limite depois do último mês, quando a coluna seguinte é de totais: é o filete dessa coluna (um só, mesmo tom do limite) */
  .page.density-compact.hierarchy-clean thead th.apos-mes,
  .page.density-compact.hierarchy-clean tbody td.apos-mes,
  .page.density-compact.hierarchy-clean tbody.row-group tr.subtotal-row td.apos-mes,
  .page.density-compact.hierarchy-clean .totals-tbody td.apos-mes { border-left: 1px solid #9aa4b2; }
  /* duas colunas de totais seguidas («Total unid. do bloco» + «Período: Total unid.»): um só filete entre elas */
  .page.density-compact.hierarchy-clean .tint-total + .tint-total { border-left-width: 0; }

  /* faixa de resumo (unidades vendidas · stock total): uma linha, sob os filtros */
  .page.density-compact.hierarchy-clean .resumo-faixa { font-size: 9.5px; color: #374151; margin: 3px 0 0 0; display: flex; flex-wrap: wrap; gap: 4px 16px; }
  .page.density-compact.hierarchy-clean .resumo-faixa strong { color: #111827; font-weight: 700; }

  /* NÚMEROS +1 px (valores, quantidades, stock, preços, custos, totais) — a descrição, o cabeçalho e o resto do texto não mudam.
     A largura das colunas é medida pelo adapter com este mesmo aumento (AUMENTO_NUMEROS_PX). */
  .page.density-compact.hierarchy-clean tbody td.num { font-size: calc(1em + 1px); }
  .page.density-compact.hierarchy-clean .totals-tbody td.num { font-size: calc(1em + 1px); }

  /* tipografia: maior e com mais respiração (o adapter mede as larguras com as mesmas métricas) */
  .page.density-compact.hierarchy-clean table { font-size: 10px; }
  .page.density-compact.hierarchy-clean thead th { font-size: 9px; padding-left: 5px; padding-right: 5px; }
  .page.density-compact.hierarchy-clean tbody td { padding: 3.5px 5px; }
  .page.density-compact.hierarchy-clean table.table-density-tight { font-size: 9px; }
  .page.density-compact.hierarchy-clean table.table-density-tight thead th { font-size: 8px; padding-left: 4px; padding-right: 4px; }
  .page.density-compact.hierarchy-clean table.table-density-tight tbody td { padding: 3px 4px; }
  .page.density-compact.hierarchy-clean table.table-density-ultratight { font-size: 8.5px; }
  .page.density-compact.hierarchy-clean table.table-density-ultratight thead th { font-size: 7.5px; padding-left: 3px; padding-right: 3px; }
  .page.density-compact.hierarchy-clean table.table-density-ultratight tbody td { padding: 2.5px 3px; }
  .page.density-compact.hierarchy-clean tbody.row-group > tr:first-child > td { padding-top: 8px; }

  @media print {
    html, body { width: 100%; }
    .bloco-novo { break-before: page; page-break-before: always; }
    /* Um artigo nunca se separa do seu TOTAL ARTIGO (quando o motor o permite). */
    tr.subtotal-row { break-before: avoid; page-break-before: avoid; }
    .page { padding: 0; }
    thead { display: table-header-group; }
    /* SEM "tfoot { display: table-footer-group }" — a tabela já não usa
       <tfoot> para o total geral (ver .totals-tbody, acima), de
       propósito: essa regra repetia o total no fim de CADA página. */
    tr { page-break-inside: avoid; }
    .summary-card, .chip { break-inside: avoid; }
    .report-header { break-after: avoid; }
    /* A última linha (TOTAL GERAL) nunca pode ficar sozinha, separada
       do resto da tabela, numa página nova. */
    .totals-tbody { break-before: avoid; page-break-before: avoid; }
  }
`;

/**
 * Gera o HTML completo do relatório (doctype + head + body).
 * Pronto para ser escrito num iframe e impresso.
 */
export function renderReportHtml(entrada: Report): string {
  // Informação comercial que o utilizador não quis partilhar: retirada AQUI (e não só no browser/CSS) — ver privacidade.ts.
  const report = aplicarPrivacidade(entrada);
  const orientation = report.meta?.orientation === "landscape" ? "A4 landscape" : "A4 portrait";
  const styles = STYLES.replace("__ORIENTATION__", orientation);
  const pageClass = isCompact(report)
    ? `page density-compact${report.meta?.hierarchy === "strong" ? " hierarchy-strong" : report.meta?.hierarchy === "clean" ? " hierarchy-clean" : ""}`
    : "page";

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
  ${renderCancelledStamp(report)}
  ${renderFilters(report)}
  ${renderSummary(report)}
  ${renderTable(report)}
  ${renderFooter(report)}
</div>
</body>
</html>`;
}
