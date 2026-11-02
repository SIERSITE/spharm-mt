/**
 * Análise de um PDF (ou impressão) do Mapa de Vendas numa SÓ tabela: verifica, sobre os TOKENS reais desenhados (PyMuPDF), tudo
 * o que o requisito da tabela única exige. Devolve a lista de falhas (vazia = tudo certo) e métricas para o relatório de testes.
 * Não confia no HTML: lê o que o Chromium pôs na página (posições, tamanhos reais de letra).
 */
import type { Report } from "../../lib/reporting/report-types";
import { ROW_KIND_KEY } from "../../lib/reporting/report-types";
import type { VendasAdapterRow } from "../../lib/reporting/adapters/vendas";
import { buckets, type PaginaPdf, type Tok } from "./_tabela-unica";

const MESES_PT = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
const LETRAS = new Set(["J", "F", "M", "A", "S", "O", "N", "D"]);
const FARM_CURTAS = ["Norte", "Segurado", "Silveirense"];

export type OpcoesAnalise = {
  nMeses: number;
  venda: boolean;
  compra: boolean;
  /** Papel esperado, calculado de forma independente pelo teste (A4/A3). */
  papel: "A4" | "A3";
  /** Largura da margem lateral em mm (8, ou 6 na degradação). */
  margemMm: number;
  /** `true` = meses abreviados + células compactas (degradação); `zoom` = limite absoluto (fontes abaixo do piso). */
  compacto: boolean;
  zoom: boolean;
};

export type Metricas = {
  paginas: number;
  artigos: number;
  linhas: number;
  tamanhoMinNumeroPt: number;
  tamanhoMinTextoPt: number;
  tamanhoMinCabecalhoPt: number;
};

const txt = (t: Tok) => t[5].replace(/ /g, " ");
const cy = (t: Tok) => (t[1] + t[3]) / 2;

/** «12 345,67 €» → 12345.67; «·» → 0; «—» → null; «-1 234» → -1234. */
export function numeroDe(s: string): number | null {
  const t = s.replace(/ /g, " ").replace(/€/g, "").trim();
  if (t === "·") return 0;
  if (t === "—" || t === "–" || t === "") return null;
  const n = Number(t.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
}

const PAPEL_PT = { A4: [841.9, 595.3], A3: [1190.6, 841.9] } as const;

type Linha = { tipo: "detalhe" | "artigo" | "geral"; farm?: string; pagina: number; y: number; nums: (number | null)[]; brutos: string[] };

export function analisar(paginas: PaginaPdf[], rel: Report, raw: VendasAdapterRow[], o: OpcoesAnalise): { falhas: string[]; m: Metricas; assinatura: string } {
  const falhas: string[] = [];
  const falha = (s: string) => { if (falhas.length < 40) falhas.push(s); };
  const n = o.nMeses;

  // ── papel ────────────────────────────────────────────────────────────────
  const [pw, ph] = PAPEL_PT[o.papel];
  paginas.forEach((p, i) => { if (Math.abs(p.w - pw) > 2 || Math.abs(p.h - ph) > 2) falha(`pág ${i + 1}: ${p.w}×${p.h} pt, esperado ${o.papel} horizontal ${pw}×${ph}`); });

  // ── cabeçalho por página: exatamente um, completo, com N meses ───────────
  type Cab = { y: number; meses: Tok[]; cnp: Tok; desc?: Tok; farm?: Tok };
  const cabs: (Cab | null)[] = [];
  const rotulos = ["CNP", "Descrição", "Farmácia", "Stock"];
  paginas.forEach((p, i) => {
    const cnps = p.tokens.filter((t) => txt(t) === "CNP" && t[0] < p.w * 0.2);
    if (cnps.length !== 1) { falha(`pág ${i + 1}: ${cnps.length} cabeçalhos «CNP» (esperado 1 — uma só linha de cabeçalho por página)`); cabs.push(null); return; }
    const y = cnps[0][1];
    // «CNP» fica na última linha do cabeçalho (vertical-align: bottom): os rótulos de 2 linhas começam ~10 pt acima
    const banda = p.tokens.filter((t) => t[1] >= y - 14 && t[1] <= y + 5);
    const meses = banda.filter((t) => (o.compacto ? LETRAS.has(txt(t)) : MESES_PT.includes(txt(t)))).sort((a, b) => a[0] - b[0]);
    if (meses.length !== n) falha(`pág ${i + 1}: ${meses.length} cabeçalhos de mês, esperados ${n}`);
    const anos = banda.filter((t) => /^\d{2}$/.test(txt(t)));
    if (anos.length !== n) falha(`pág ${i + 1}: ${anos.length} anos nos cabeçalhos de mês, esperados ${n}`);
    const extras = [...rotulos, "Total", "Unid.", ...(o.venda ? ["PVP", "Valor", "Vendas", "(s/IVA)"] : []), ...(o.compra ? ["Custo", "unit.", "est.", "total"] : [])];
    for (const r of extras) if (!banda.some((t) => txt(t) === r)) falha(`pág ${i + 1}: falta «${r}» no cabeçalho (cortado?)`);
    if (!o.venda && banda.some((t) => txt(t) === "PVP" || txt(t) === "Valor")) falha(`pág ${i + 1}: colunas de preços de venda presentes sem «incluir preços de venda»`);
    if (!o.compra && banda.some((t) => txt(t) === "Custo")) falha(`pág ${i + 1}: colunas de custo presentes sem «incluir preços de compra»`);
    // um só «Total Unid.» e um só «Stock» no cabeçalho
    if (banda.filter((t) => txt(t) === "Unid.").length !== 1) falha(`pág ${i + 1}: «Total Unid.» não aparece exatamente uma vez no cabeçalho`);
    if (banda.filter((t) => txt(t) === "Stock").length !== 1) falha(`pág ${i + 1}: «Stock» não aparece exatamente uma vez no cabeçalho`);
    cabs.push({ y, meses, cnp: cnps[0], desc: banda.find((t) => txt(t) === "Descrição"), farm: banda.find((t) => txt(t) === "Farmácia") });
  });

  // ── nada de blocos/partes/explicações de divisão temporal ────────────────
  const todo = paginas.flatMap((p) => p.tokens.map(txt)).join(" ");
  for (const [re, nome] of [[/Parte\s+\d+\s+de\s+\d+/i, "«Parte i de n»"], [/do\s+bloco/i, "«… do bloco»"], [/Total\s+unid\.\s+do\s+bloco/i, "«Total unid. do bloco»"], [/em\s+\d+\s+blocos/i, "nota de blocos"], [/Período:\s*(custo|valor|Total)/i, "colunas «Período: …»"], [/blocos?\s+temporais?/i, "«blocos temporais»"], [/Meses\s+[A-Z][a-z]{2}\/\d{2}\s+a/i, "legenda «Meses X a Y»"]] as const)
    if (re.test(todo)) falha(`texto proibido no documento: ${nome}`);

  // ── linhas do corpo (por ordem de leitura) ───────────────────────────────
  const linhas: Linha[] = [];
  const cnpsEncontrados: { cnp: string; pagina: number; y: number }[] = [];
  paginas.forEach((p, pi) => {
    const cab = cabs[pi];
    if (!cab) return;
    const fx = cab.farm ? cab.farm[0] : p.w * 0.3;
    const dx = cab.desc ? cab.desc[0] : p.w * 0.06;
    const cnpX0 = cab.cnp[0] - 2, cnpX1 = dx - 1;
    // CNPs (7 dígitos) na 1.ª coluna
    for (const t of p.tokens) if (/^\d{7}$/.test(txt(t)) && t[0] >= cnpX0 && t[2] <= cnpX1 + 4 && t[1] > cab.y + 8) cnpsEncontrados.push({ cnp: txt(t), pagina: pi, y: t[1] });
    // âncoras de linha: nome curto da farmácia na coluna, ou TOTAL ARTIGO / TOTAL GERAL
    const ancoras: { tipo: Linha["tipo"]; farm?: string; tok: Tok }[] = [];
    for (const t of p.tokens) {
      if (t[1] <= cab.y + 8) continue;
      const s = txt(t);
      if (FARM_CURTAS.includes(s) && t[0] >= fx - 3 && t[0] <= fx + 6) ancoras.push({ tipo: "detalhe", farm: s, tok: t });
      else if (s === "TOTAL") {
        const seg = p.tokens.find((u) => Math.abs(cy(u) - cy(t)) < 2 && u[0] > t[0] && u[0] - t[2] < 6 && (txt(u) === "ARTIGO" || txt(u) === "GERAL"));
        if (seg && txt(seg) === "ARTIGO" && t[0] >= fx - 3 && t[0] <= fx + 6) ancoras.push({ tipo: "artigo", tok: seg });
        else if (seg && txt(seg) === "GERAL" && t[0] < p.w * 0.2) ancoras.push({ tipo: "geral", tok: seg });
      }
    }
    ancoras.sort((a, b) => a.tok[1] - b.tok[1]);
    for (const a of ancoras) {
      const resto = p.tokens
        .filter((t) => Math.abs(cy(t) - cy(a.tok)) <= 4.5 && t[0] >= a.tok[2] - 0.2 && t !== a.tok)
        .sort((u, v) => u[0] - v[0]);
      linhas.push({ tipo: a.tipo, farm: a.farm, pagina: pi, y: cy(a.tok), nums: resto.map((t) => numeroDe(txt(t))), brutos: resto.map(txt) });
    }
  });

  // ── estrutura esperada (do relatório) ────────────────────────────────────
  const esperadas = rel.rows.map((r) => ({ cnp: String(r.codigo), tipo: r[ROW_KIND_KEY] === "subtotal" ? ("artigo" as const) : ("detalhe" as const), farm: String(r.farmaciaCurta ?? "") }));
  const dadosPdf = linhas.filter((l) => l.tipo !== "geral");
  const gerais = linhas.filter((l) => l.tipo === "geral");
  if (gerais.length !== 1) falha(`${gerais.length} linhas «TOTAL GERAL» (esperada 1, no final do documento)`);
  if (dadosPdf.length !== esperadas.length) falha(`${dadosPdf.length} linhas de dados no PDF, esperadas ${esperadas.length} (artigo repetido ou linha em falta?)`);
  const nComparar = Math.min(dadosPdf.length, esperadas.length);
  for (let i = 0; i < nComparar; i++) {
    const e = esperadas[i], l = dadosPdf[i];
    if (e.tipo !== l.tipo || (e.tipo === "detalhe" && e.farm !== l.farm)) { falha(`linha ${i + 1}: PDF «${l.tipo === "artigo" ? "TOTAL ARTIGO" : l.farm}», esperada «${e.tipo === "artigo" ? "TOTAL ARTIGO" : e.farm}» (CNP ${e.cnp})`); break; }
  }

  // cada CNP aparece UMA vez (na coluna CNP) e na ordem do relatório
  const cnpsOrdemRel: string[] = [];
  for (const e of esperadas) if (cnpsOrdemRel[cnpsOrdemRel.length - 1] !== e.cnp) cnpsOrdemRel.push(e.cnp);
  const contagem = new Map<string, number>();
  for (const c of cnpsEncontrados) contagem.set(c.cnp, (contagem.get(c.cnp) ?? 0) + 1);
  const repetidos = [...contagem.entries()].filter(([, v]) => v !== 1);
  if (repetidos.length) falha(`CNP repetido(s) no documento: ${repetidos.slice(0, 5).map(([k, v]) => `${k}×${v}`).join(", ")}`);
  if (cnpsEncontrados.length !== cnpsOrdemRel.length) falha(`${cnpsEncontrados.length} CNP na coluna CNP, esperados ${cnpsOrdemRel.length}`);
  else if (!cnpsEncontrados.every((c, i) => c.cnp === cnpsOrdemRel[i])) falha("a ordem dos CNP no PDF difere da do relatório");

  // ── valores: linha a linha, TOTAL ARTIGO e TOTAL GERAL contra os dados brutos ─────
  const bks = buckets(n);
  const porChave = new Map<string, VendasAdapterRow>();
  for (const r of raw) porChave.set(`${r.codigo}|${r.farmacia.replace(/^Farmácia /, "")}`, r);
  const somaCols = (rs: VendasAdapterRow[]) => ({
    meses: bks.map((_, k) => rs.reduce((a, r) => a + (r.meses[k]?.quantidade ?? 0), 0)),
    total: rs.reduce((a, r) => a + r.totalVendas, 0),
    stock: rs.reduce((a, r) => a + r.existencia, 0),
    valor: rs.reduce((a, r) => a + (r.valorBruto ?? 0), 0),
    custo: rs.reduce((a, r) => a + (r.custoEstimado ?? 0), 0),
  });
  // colunas: [pvp?][custoUnit?][custoTotal?] meses… totalUnid stock [valor?]
  const esperadoDe = (pvp: number | null, cu: number | null, custo: number | null, meses: number[], total: number, stock: number, valor: number): (number | null)[] => [
    ...(o.venda ? [pvp] : []), ...(o.compra ? [cu, custo] : []), ...meses, total, stock, ...(o.venda ? [valor] : []),
  ];
  const igual = (a: number | null, b: number | null, tol: number) => (a === null || b === null ? a === b : Math.abs(a - b) <= tol);
  const compara = (rotulo: string, obtido: (number | null)[], esperado: (number | null)[]) => {
    if (obtido.length !== esperado.length) { falha(`${rotulo}: ${obtido.length} valores na linha, esperados ${esperado.length}`); return; }
    for (let k = 0; k < esperado.length; k++) if (!igual(obtido[k], esperado[k], 0.006)) { falha(`${rotulo}: valor ${k + 1} = ${obtido[k]}, esperado ${esperado[k]}`); return; }
  };
  const porArtigo = new Map<string, VendasAdapterRow[]>();
  for (const r of raw) porArtigo.set(r.codigo, [...(porArtigo.get(r.codigo) ?? []), r]);
  let linhasVerificadas = 0;
  for (let i = 0; i < nComparar; i++) {
    const e = esperadas[i], l = dadosPdf[i];
    if (e.tipo === "detalhe") {
      const r = porChave.get(`${e.cnp}|${e.farm}`);
      if (!r) { falha(`linha ${i + 1}: sem dados brutos para ${e.cnp}/${e.farm}`); continue; }
      compara(`${e.cnp} ${e.farm}`, l.nums, esperadoDe(r.pvp, r.custoUnitarioEstimado ?? null, r.custoEstimado ?? null, bks.map((_, k) => r.meses[k]?.quantidade ?? 0), r.totalVendas, r.existencia, r.valorBruto ?? 0));
      // por linha: soma dos meses = Total unid.
      const desloc = (o.venda ? 1 : 0) + (o.compra ? 2 : 0);
      const soma = l.nums.slice(desloc, desloc + n).reduce<number>((a, v) => a + (v ?? 0), 0);
      if (l.nums[desloc + n] !== soma) falha(`${e.cnp} ${e.farm}: Total unid. ${l.nums[desloc + n]} ≠ soma dos meses ${soma}`);
    } else {
      const s = somaCols(porArtigo.get(e.cnp) ?? []);
      compara(`TOTAL ARTIGO ${e.cnp}`, l.nums, esperadoDe(null, null, s.custo, s.meses, s.total, s.stock, s.valor));
    }
    linhasVerificadas++;
  }
  if (gerais.length === 1) {
    const s = somaCols(raw);
    const g = gerais[0].nums;
    // TOTAL GERAL: [custoTotal?] meses… totalUnid stock [valor?] (PVP/Custo unit. não têm total)
    const esp: (number | null)[] = [...(o.compra ? [s.custo] : []), ...s.meses, s.total, s.stock, ...(o.venda ? [s.valor] : [])];
    compara("TOTAL GERAL", g, esp);
  }

  // ── nada dividido entre páginas; TOTAL GERAL com o último artigo ─────────
  let i0 = 0;
  const grupos: { cnp: string; ini: number; fim: number }[] = [];
  while (i0 < esperadas.length) {
    let j = i0;
    while (j + 1 < esperadas.length && esperadas[j + 1].cnp === esperadas[i0].cnp) j++;
    grupos.push({ cnp: esperadas[i0].cnp, ini: i0, fim: j });
    i0 = j + 1;
  }
  grupos.forEach((g, gi) => {
    if (g.fim >= dadosPdf.length) return;
    const pags = new Set(dadosPdf.slice(g.ini, g.fim + 1).map((l) => l.pagina));
    const cnp = cnpsEncontrados[gi];
    if (cnp) pags.add(cnp.pagina);
    if (pags.size !== 1) falha(`o artigo ${g.cnp} está dividido entre as páginas ${[...pags].map((p) => p + 1).join("/")}`);
    const nFarmGrupo = g.fim - g.ini + 1 - (esperadas[g.fim].tipo === "artigo" ? 1 : 0);
    const temTotal = esperadas[g.fim].tipo === "artigo";
    if ((nFarmGrupo > 1) !== temTotal) falha(`o artigo ${g.cnp}: ${nFarmGrupo} farmácia(s) e ${temTotal ? "com" : "sem"} TOTAL ARTIGO (só se > 1 farmácia)`);
  });
  if (gerais.length === 1 && dadosPdf.length > 0 && gerais[0].pagina !== dadosPdf[dadosPdf.length - 1].pagina) falha("o TOTAL GERAL não está na mesma página que o último artigo");
  paginas.forEach((p, pi) => { if (!dadosPdf.some((l) => l.pagina === pi) && !gerais.some((l) => l.pagina === pi)) falha(`pág ${pi + 1}: página sem linhas da tabela`); });

  // ── nada cortado nem sobreposto; sem reticências ─────────────────────────
  const margemPt = (o.margemMm * 72) / 25.4;
  paginas.forEach((p, pi) => {
    for (const t of p.tokens) {
      if (/…|\.\.\./.test(txt(t))) falha(`pág ${pi + 1}: «${txt(t)}» tem reticências (texto cortado)`);
      if (t[0] < margemPt - 2 || t[2] > p.w - margemPt + 2) { falha(`pág ${pi + 1}: «${txt(t)}» fora da área útil (x ${t[0].toFixed(1)}–${t[2].toFixed(1)}, página ${p.w})`); break; }
    }
    const ord = [...p.tokens].sort((a, b) => a[0] - b[0]);
    outer: for (let a = 0; a < ord.length; a++) {
      for (let b = a + 1; b < ord.length && ord[b][0] < ord[a][2] - 0.5; b++) {
        const w = Math.min(ord[a][2], ord[b][2]) - Math.max(ord[a][0], ord[b][0]);
        const h = Math.min(ord[a][3], ord[b][3]) - Math.max(ord[a][1], ord[b][1]);
        if (w > 0.6 && h > 1.2) { falha(`pág ${pi + 1}: «${txt(ord[a])}» e «${txt(ord[b])}» sobrepõem-se (${w.toFixed(1)}×${h.toFixed(1)} pt)`); break outer; }
      }
    }
  });

  // ── tipografia mínima (tamanho real de letra, pt) ────────────────────────
  let minNum = Infinity, minTexto = Infinity, minCab = Infinity;
  paginas.forEach((p, pi) => {
    const cab = cabs[pi];
    if (!cab) return;
    const geral = gerais.find((g) => g.pagina === pi);
    const fimTabela = geral ? geral.y + 8 : p.h;
    const xNum = (cab.farm ? cab.farm[0] : 0) + 50; // as colunas numéricas começam depois da Farmácia
    for (const t of p.tokens) {
      if (t[1] < cab.y - 14 || t[1] > fimTabela) continue;
      if (t[1] <= cab.y + 5) minCab = Math.min(minCab, t[4]);
      else if (t[0] >= xNum && /^[-\d\u00a0.,€·]+$/.test(t[5])) minNum = Math.min(minNum, t[4]);
      else minTexto = Math.min(minTexto, t[4]);
    }
  });
  const px = (v: number) => v * 0.75;
  if (!o.zoom) {
    // pisos documentados em layout-largura.ts (px CSS × 0,75 = pt); folga de 0,06 pt de arredondamento
    const pisoNum = o.compacto ? px(8.5) : px(9.5);
    if (minNum < pisoNum - 0.06) falha(`números com ${minNum.toFixed(2)} pt (< ${pisoNum.toFixed(2)} pt)`);
    if (minTexto < px(8.5) - 0.06) falha(`texto com ${minTexto.toFixed(2)} pt (< ${px(8.5).toFixed(2)} pt)`);
    if (minCab < px(7.5) - 0.06) falha(`cabeçalhos com ${minCab.toFixed(2)} pt (< ${px(7.5).toFixed(2)} pt)`);
  }

  // Assinatura do CONTEÚDO (rótulos do cabeçalho da 1.ª página + valores de cada linha por ordem de leitura): igual entre PDF,
  // impressão e e-mail mesmo que a paginação difira.
  const cab0 = cabs[0];
  const rotulosCab = cab0 && paginas[0] ? paginas[0].tokens.filter((t) => t[1] >= cab0.y - 14 && t[1] <= cab0.y + 5).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(txt).join("|") : "";
  const assinatura = [rotulosCab, ...linhas.map((l) => `${l.tipo}|${l.farm ?? ""}|${l.brutos.join(",")}`)].join("\n");
  return {
    falhas,
    assinatura,
    m: { paginas: paginas.length, artigos: cnpsOrdemRel.length, linhas: linhasVerificadas, tamanhoMinNumeroPt: minNum, tamanhoMinTextoPt: minTexto, tamanhoMinCabecalhoPt: minCab },
  };
}

