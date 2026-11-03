/**
 * Análise de um PDF (ou impressão) do Mapa de Vendas numa SÓ tabela, em A4 horizontal: verifica, sobre os TOKENS reais desenhados
 * (PyMuPDF: posição + tamanho real da letra em pt) e sobre a geometria das colunas medida no DOM (mídia print), tudo o que o
 * requisito exige. Devolve a lista de falhas (vazia = tudo certo) e métricas para o relatório de testes. Não confia no HTML:
 * lê o que o Chromium pôs na página.
 */
import type { Report, ReportColumn, ReportRow } from "../../lib/reporting/report-types";
import { ehLinhaSubtotal } from "../../lib/reporting/report-types";
import { formatCell } from "../../lib/reporting/report-formatters";
import { MARGEM_LATERAL_VENDAS_MM } from "../../lib/reporting/layout-largura";
import type { MedicaoDom, PaginaPdf, Tok } from "./_tabela-unica";

export const A4_H_PT = { w: 841.9, h: 595.3 };
const MM = 72 / 25.4;
const TOL_FONTE = 0.05;

export type OpcoesAnalise = { nMeses: number; venda: boolean; compra: boolean; esperaVarias?: boolean };

export type Metricas = {
  paginas: number;
  artigos: number;
  linhasDados: number;
  fonteMinTabelaPt: number;
  fonteMinMesPt: number;
  fonteMedianaCnpPt: number;
  fonteMedianaDescPt: number;
  fonteMedianaMesPt: number;
  fonteMinCabecalhoPt: number;
  larguraPaginaPt: number;
  alturaPaginaPt: number;
};

const norm = (s: string) => s.replace(/[\s  ]+/g, " ").trim();
export const txt = (t: Tok) => norm(t[5]);
const cy = (t: Tok) => (t[1] + t[3]) / 2;
const cx = (t: Tok) => (t[0] + t[2]) / 2;
const mediana = (v: number[]) => { const o = [...v].sort((a, b) => a - b); return o.length ? o[Math.floor(o.length / 2)] : 0; };

/** Texto esperado de uma célula numérica do relatório (como a tabela a desenha). */
function esperado(row: ReportRow, c: ReportColumn): string {
  const bruto = c.displayKey ? row[c.displayKey] : row[c.key];
  if (c.zeroAsDash && typeof bruto === "number" && bruto === 0) return norm(c.zeroText ?? "–");
  return norm(formatCell(bruto as never, c.format, c.semSimbolo));
}

export type Resultado = { falhas: string[]; metricas: Metricas };

export function analisar(paginas: PaginaPdf[], dom: MedicaoDom, rel: Report, o: OpcoesAnalise): Resultado {
  const falhas: string[] = [];
  const f = (m: string) => { if (falhas.length < 40) falhas.push(m); };
  const margemPt = MARGEM_LATERAL_VENDAS_MM * MM;
  const vis = rel.columns.filter((c) => !c.hidden && !c.excelOnly);
  const meses = vis.filter((c) => c.monthAlt);
  const idxCol = (k: string) => vis.findIndex((c) => c.key === k);

  // ── 1. formato físico A4 horizontal ─────────────────────────────────────────────
  paginas.forEach((p, i) => {
    if (Math.abs(p.w - A4_H_PT.w) > 1.2 || Math.abs(p.h - A4_H_PT.h) > 1.2) f(`pág ${i + 1}: tamanho ${p.w}×${p.h} pt (esperado A4 horizontal ${A4_H_PT.w}×${A4_H_PT.h})`);
  });

  // ── 2. colunas do DOM → pt na página (a escala de impressão é 1: 1 px CSS = 0,75 pt) ───────────────────────────
  if (dom.nTabelas !== 1) f(`${dom.nTabelas} tabelas no HTML (esperada 1)`);
  if (dom.nThead !== 1) f(`${dom.nThead} cabeçalhos <thead> (esperado 1: a repetição por página é do motor de impressão)`);
  if (dom.colunas.length !== vis.length) f(`${dom.colunas.length} colunas no DOM, ${vis.length} no relatório`);
  const cols = dom.colunas.map((c) => ({ ...c, l: margemPt + c.left * 0.75, r: margemPt + c.right * 0.75 }));
  const util = (A4_H_PT.w - 2 * margemPt);
  if (cols.length > 0 && (cols[cols.length - 1].r > A4_H_PT.w - margemPt + 1 || cols[0].l < margemPt - 1)) f(`a tabela sai da área útil (${cols[0].l.toFixed(1)}–${cols[cols.length - 1].r.toFixed(1)} pt, útil ${margemPt.toFixed(1)}–${(margemPt + util).toFixed(1)})`);
  for (const t of dom.transbordos.slice(0, 5)) f(`célula com conteúdo a transbordar (cortado/sobreposto): «${t.texto}» +${t.excesso.toFixed(2)} px`);
  // todos os tokens da tabela (abaixo do cabeçalho da 1.ª coluna) dentro da sua coluna
  const colDe = (t: Tok) => cols.findIndex((c) => cx(t) >= c.l - 0.3 && cx(t) <= c.r + 0.3);

  // ── 3. por página: cabeçalho completo, mesmos nomes, sem cabeçalhos proibidos ─────────────────────────────
  const rotulosEsperados = vis.map((c) => norm((c.htmlLabel ?? c.label).replace(/\n/g, " ")));
  let fonteMinTabela = Infinity, fonteMinMes = Infinity, fonteMinCab = Infinity;
  const fCnp: number[] = [], fDesc: number[] = [], fMes: number[] = [];
  const dataRows: { pagina: number; y: number; tokens: Tok[]; farm: string }[] = [];
  const cnpSeq: { pagina: number; cnp: string; y: number }[] = [];
  let tgGeral = 0, resumoFin = 0, tgPagina = -1, resumoPagina = -1, resumoY = 0, tgY = 0;
  const tudo = paginas.map((p) => p.tokens);
  paginas.forEach((p, pi) => {
    const t = p.tokens;
    // cabeçalho: «CNP» é o 1.º; os tokens do cabeçalho estão na mesma banda
    const cnpH = t.filter((x) => txt(x) === "CNP" && x[4] > 5)[0];
    if (!cnpH) { f(`pág ${pi + 1}: sem cabeçalho da tabela («CNP»)`); return; }
    const yCab = cnpH[1] - 12;
    const cab = t.filter((x) => x[1] >= yCab && x[3] <= cnpH[3] + 14 && x[1] < cnpH[1] + 16);
    const textoCab = norm(cab.map((x) => x[5]).join(" "));
    for (const r of rotulosEsperados) {
      for (const parte of r.split(" ")) if (!norm(cab.map((x) => x[5]).join(" ")).includes(parte)) { f(`pág ${pi + 1}: o cabeçalho não tem «${parte}» (do rótulo «${r}»)`); break; }
    }
    // meses: os 14 rótulos «Out/25»… presentes, cada um uma vez
    for (const m of meses) {
      const lab = norm(m.htmlLabel ?? m.label);
      const n = cab.filter((x) => txt(x) === lab).length;
      if (n !== 1) f(`pág ${pi + 1}: cabeçalho do mês «${lab}» ${n}× (esperado 1)`);
    }
    for (const proibido of ["Custo total", "Valor Vendas", "Parte", "bloco", "Período:", "do bloco"]) if (textoCab.includes(proibido)) f(`pág ${pi + 1}: cabeçalho com «${proibido}»`);
    if (cab.filter((x) => /^Stock$/.test(txt(x))).length !== 1) f(`pág ${pi + 1}: «Stock» no cabeçalho ≠ 1×`);
    if (cab.filter((x) => /^unid\.$/.test(txt(x))).length !== 1) f(`pág ${pi + 1}: «Total unid.» no cabeçalho ≠ 1×`);
    for (const x of cab) fonteMinCab = Math.min(fonteMinCab, x[4]);
    // todas as páginas começam com o MESMO conjunto de colunas (posições idênticas): comparar com a coluna do DOM
    for (const m of meses) {
      const lab = norm(m.htmlLabel ?? m.label);
      const tk = cab.find((x) => txt(x) === lab);
      const ci = vis.findIndex((c) => c.key === m.key);
      if (tk && cols[ci] && (cx(tk) < cols[ci].l - 0.5 || cx(tk) > cols[ci].r + 0.5)) f(`pág ${pi + 1}: «${lab}» fora da sua coluna`);
    }

    // corpo: tudo abaixo do cabeçalho; tamanhos da letra
    const corpo = t.filter((x) => x[1] > cnpH[3] + 2);
    for (const x of corpo) {
      if (/^Pág\./.test(txt(x))) continue;
      fonteMinTabela = Math.min(fonteMinTabela, x[4]);
    }
    // TOTAL GERAL: «TOTAL» «GERAL» na 1.ª coluna ou na coluna de CNP/Descrição (colspan)
    const tg = corpo.filter((x) => txt(x) === "GERAL" && corpo.some((y) => txt(y) === "TOTAL" && Math.abs(cy(y) - cy(x)) < 2 && y[0] < x[0]));
    // a nota final também menciona «TOTAL GERAL»? Só conta o que está na 1.ª coluna da tabela (x < 100 pt)
    const tgReal = tg.filter((x) => x[0] < cols[0].r + 120);
    tgGeral += tgReal.length;
    if (tgReal.length) { tgPagina = pi; tgY = cy(tgReal[0]); }
    // título em maiúsculas (CSS): «RESUMO FINANCEIRO» com preços, «RESUMO» sem nenhum
    const rf = corpo.filter((x) => /^RESUMO$/.test(txt(x)) && (!(o.venda || o.compra) || corpo.some((y) => /^FINANCEIRO$/.test(txt(y)) && Math.abs(cy(y) - cy(x)) < 2)));
    resumoFin += rf.length;
    if (rf.length) { resumoPagina = pi; resumoY = cy(rf[0]); }
    // linhas de dados: ancoradas nos tokens da coluna «Total unid.» (uma só linha em cada linha de dados, mesmo com Farmácia/Descrição a quebrar)
    {
      const iFarm = idxCol("farmacia"), iTotU = idxCol("totalVendas");
      const yLimite = tgReal.length ? cy(tgReal[0]) - 3 : Infinity;
      const toks = corpo.filter((x) => colDe(x) === iTotU && cy(x) < yLimite).sort((a, b) => cy(a) - cy(b));
      const ys: number[] = [];
      for (const x of toks) { if (ys.length === 0 || cy(x) - ys[ys.length - 1] > 2.5) ys.push(cy(x)); }
      ys.forEach((y, k) => {
        const lo = k === 0 ? y - 40 : (ys[k - 1] + y) / 2, hi = k === ys.length - 1 ? Math.min(y + 40, yLimite) : (y + ys[k + 1]) / 2;
        const farm = corpo.filter((x) => colDe(x) === iFarm && cy(x) >= lo && cy(x) < hi).sort((a, b) => Math.round(cy(a) / 3) - Math.round(cy(b) / 3) || a[0] - b[0]).map(txt).join(" ");
        dataRows.push({ pagina: pi, y, tokens: corpo.filter((x) => Math.abs(cy(x) - y) <= 3.2), farm });
      });
    }
    // CNPs (1.ª coluna, 7 dígitos) — um por artigo, no seu início
    const iCnp = idxCol("codigo");
    for (const x of corpo) if (colDe(x) === iCnp && /^\d{6,8}$/.test(txt(x))) cnpSeq.push({ pagina: pi, cnp: txt(x), y: cy(x) });
    // tamanhos por coluna (CNP, Descrição, meses)
    const iDesc = idxCol("descricao");
    for (const x of corpo) {
      const ci = colDe(x);
      if (ci === iCnp && /^\d+$/.test(txt(x))) fCnp.push(x[4]);
      else if (ci === iDesc) fDesc.push(x[4]);
      else if (ci >= 0 && vis[ci]?.monthAlt) { fMes.push(x[4]); fonteMinMes = Math.min(fonteMinMes, x[4]); }
    }
    // nada fora da coluna: cada token do corpo tem de estar inteiro dentro de uma coluna (exceto o rodapé/nota/resumo de largura total)
    const yTg = tgReal.length ? cy(tgReal[0]) : Infinity;
    for (const x of corpo) {
      if (x[1] > yTg + 4) continue; // abaixo do TOTAL GERAL: resumo e notas, de largura total
      if (Math.abs(cy(x) - yTg) < 3 && (txt(x) === "TOTAL" || txt(x) === "GERAL")) continue; // rótulo com colspan
      const ci = colDe(x);
      if (ci < 0) { f(`pág ${pi + 1}: «${txt(x)}» fora de qualquer coluna (x=${x[0].toFixed(1)}–${x[2].toFixed(1)})`); continue; }
      if (x[0] < cols[ci].l - 0.6 || x[2] > cols[ci].r + 0.6) f(`pág ${pi + 1}: «${txt(x)}» ultrapassa a coluna «${cols[ci].texto}» (${x[0].toFixed(1)}–${x[2].toFixed(1)} vs ${cols[ci].l.toFixed(1)}–${cols[ci].r.toFixed(1)})`);
    }
  });

  // ── 4. tamanhos de letra (≥ 8 pt, ±0,05) ────────────────────────────────────────
  if (fonteMinTabela < 8 - TOL_FONTE) f(`letra do corpo da tabela com ${fonteMinTabela.toFixed(2)} pt (< 8 pt)`);
  if (fonteMinCab < 8 - TOL_FONTE) f(`letra do cabeçalho com ${fonteMinCab.toFixed(2)} pt (< 8 pt)`);
  const mCnp = mediana(fCnp), mDesc = mediana(fDesc), mMes = mediana(fMes);
  if (mCnp < mMes - 0.02) f(`CNP (${mCnp.toFixed(2)} pt) menor do que os valores mensais (${mMes.toFixed(2)} pt)`);
  if (mDesc < mMes - 0.02) f(`Descrição (${mDesc.toFixed(2)} pt) menor do que os valores mensais (${mMes.toFixed(2)} pt)`);
  if (dom.fonteMinPx < 8 * 4 / 3 - 0.07) f(`DOM: letra mínima ${dom.fonteMinPx.toFixed(2)} px (< 10,67 px = 8 pt)`);

  // ── 5. as linhas lidas do PDF == as linhas do relatório (nada cortado, nada repetido, ordem) ────────────────
  const linhasRel = rel.rows;
  if (dataRows.length !== linhasRel.length) f(`${dataRows.length} linhas de dados no PDF, ${linhasRel.length} no relatório`);
  const iPvp = idxCol("pvp"), iCusto = idxCol("custoUnitarioEstimado");
  const n = Math.min(dataRows.length, linhasRel.length);
  for (let i = 0; i < n; i++) {
    const dr = dataRows[i], row = linhasRel[i];
    const sub = ehLinhaSubtotal(row);
    const nomeEsp = sub ? "TOTAL ARTIGO" : String(row.farmaciaCurta ?? "");
    if (dr.farm !== nomeEsp) { f(`linha ${i + 1}: farmácia «${dr.farm}» ≠ «${nomeEsp}»`); continue; }
    const porCol = (ci: number) => dr.tokens.filter((x) => colDe(x) === ci).sort((a, b) => a[0] - b[0]).map(txt).join(" ");
    vis.forEach((c, ci) => {
      if (c.key === "codigo" || c.key === "descricao" || c.key === "farmacia") return;
      let esp = esperado(row, c);
      if (sub && c.vazioNoSubtotal) esp = "";
      const lido = porCol(ci);
      // o indicador de stock desenha o valor dentro de uma caixa: o texto lido é o mesmo
      if (lido !== esp) f(`linha ${i + 1} (${row.codigo} ${nomeEsp}) coluna «${c.htmlLabel ?? c.label}»: lido «${lido}», esperado «${esp}»`);
    });
  }
  // PVP/custo vazios no TOTAL ARTIGO (nunca «—»)
  for (const dr of dataRows) if (dr.farm === "TOTAL ARTIGO") {
    for (const ci of [iPvp, iCusto]) if (ci >= 0 && dr.tokens.some((x) => colDe(x) === ci)) f(`pág ${dr.pagina + 1}: TOTAL ARTIGO com PVP/custo unitário preenchido`);
  }

  // ── 6. cada CNP uma só vez, em sequência (nenhum artigo repetido por causa dos meses) ───────────────────────
  const cnpsEsperados: string[] = [];
  for (const r of linhasRel) { const c = String(r.codigo); if (cnpsEsperados[cnpsEsperados.length - 1] !== c) cnpsEsperados.push(c); }
  const cnpsLidos = cnpSeq.map((c) => c.cnp);
  if (cnpsLidos.join(",") !== cnpsEsperados.join(",")) {
    const rep = cnpsLidos.filter((c, i) => cnpsLidos.indexOf(c) !== i);
    f(`sequência de CNP: ${cnpsLidos.length} lidos, ${cnpsEsperados.length} esperados${rep.length ? `; repetidos: ${rep.slice(0, 3).join(",")}` : ""}`);
  }

  // ── 7. um artigo (farmácias + TOTAL ARTIGO) nunca dividido entre páginas ────────────────────────────────────
  {
    let ini = 0;
    while (ini < n) {
      let fim = ini + 1;
      while (fim < n && linhasRel[fim].codigo === linhasRel[ini].codigo) fim++;
      const pags = new Set(dataRows.slice(ini, fim).map((d) => d.pagina));
      if (pags.size > 1) f(`artigo ${linhasRel[ini].codigo} dividido entre as páginas ${[...pags].map((x) => x + 1).join(" e ")}`);
      ini = fim;
    }
  }
  // CNP de cada artigo na mesma página das suas linhas
  // ── 8. TOTAL GERAL e resumo financeiro: uma só vez, no fim, a última página com pelo menos um artigo ────────────
  if (tgGeral !== 1) f(`«TOTAL GERAL» ${tgGeral}× (esperado 1)`);
  if (tgGeral === 1 && tgPagina !== paginas.length - 1) f(`TOTAL GERAL na pág ${tgPagina + 1}, não na última (${paginas.length})`);
  const temResumo = (rel.meta?.resumoFinal ?? []).length > 0;
  if (temResumo) {
    if (resumoFin !== 1) f(`«Resumo financeiro» ${resumoFin}× (esperado 1)`);
    else {
      if (resumoPagina !== paginas.length - 1) f(`resumo financeiro na pág ${resumoPagina + 1}, não na última`);
      if (resumoPagina === tgPagina && resumoY < tgY) f("resumo financeiro ANTES do TOTAL GERAL");
    }
  }
  const ultima = paginas.length - 1;
  if (!dataRows.some((d) => d.pagina === ultima)) f("a última página não tem nenhum artigo (TOTAL GERAL/resumo órfãos)");
  // a página do TOTAL GERAL: o último artigo está nela
  // ── 9. palavras proibidas em qualquer página ────────────────────────────────────────────────────────────
  const todoTexto = norm(tudo.flat().map((x) => x[5]).join(" "));
  for (const proibido of ["Parte 1 de", "Total unid. do bloco", "do bloco", "Período: Total", "Período: custo", "Período: valor", "Custo total est.", "Valor Vendas"]) {
    if (todoTexto.includes(proibido)) f(`texto proibido no PDF: «${proibido}»`);
  }
  // PVP/custos: com a classe desligada não há cabeçalho nem valores de preço
  if (!o.venda && /PVP/.test(todoTexto)) f("PVP no PDF sem «Incluir preços de venda»");
  if (!o.compra && /Custo/.test(todoTexto.replace(/Custo total estimado/g, ""))) f("custo no PDF sem «Incluir preços de compra»");
  // resumo: itens conforme as opções
  if (temResumo) {
    const tem = (s: string) => todoTexto.includes(s);
    if (!tem("Unidades vendidas") || !tem("Stock total")) f("resumo sem unidades/stock");
    if (o.compra !== tem("Custo total estimado")) f(`resumo: «Custo total estimado» ${tem("Custo total estimado") ? "presente" : "ausente"} com preços de compra=${o.compra}`);
    if (o.venda !== tem("Valor total de vendas")) f(`resumo: «Valor total de vendas» ${tem("Valor total de vendas") ? "presente" : "ausente"} com preços de venda=${o.venda}`);
  }
  // paginação só na vertical: o nº de páginas bate com a altura; cada página tem o mesmo conjunto de colunas (já verificado em 3)
  if (o.esperaVarias && paginas.length < 2) f("esperava várias páginas");

  const metricas: Metricas = {
    paginas: paginas.length, artigos: cnpsEsperados.length, linhasDados: dataRows.length,
    fonteMinTabelaPt: fonteMinTabela, fonteMinMesPt: fonteMinMes, fonteMedianaCnpPt: mCnp, fonteMedianaDescPt: mDesc, fonteMedianaMesPt: mMes,
    fonteMinCabecalhoPt: fonteMinCab, larguraPaginaPt: paginas[0]?.w ?? 0, alturaPaginaPt: paginas[0]?.h ?? 0,
  };
  return { falhas, metricas };
}
