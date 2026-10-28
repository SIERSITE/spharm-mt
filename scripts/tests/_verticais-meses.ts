/**
 * Medição dos separadores verticais dos meses num PDF do mapa de Vendas (pixéis reais, via PyMuPDF). Partilhado entre
 * test-vendas-separadores-meses.ts (PDF gerado localmente) e o E2E vendas-separadores-meses-browser.ts (PDF do endpoint real).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

export type Palavra = [number, number, number, number, string, ...unknown[]];
export type Vert = { x0: number; x1: number; largura: number; y0: number; y1: number; cinzento: number; integral: number };
export type PagV = { largura: number; altura: number; verticais: Vert[]; cabecalho: { texto: string; x0: number; x1: number; y0: number; y1: number }[]; cnps: { y0: number; y1: number; texto: string }[]; cabCnp: { y0: number; y1: number }[]; totais: { y0: number; y1: number; texto: string }[] };
const py = (script: string, f: string) => {
  const r = spawnSync("python", [path.resolve(`scripts/e2e/${script}`), f], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`python ${script}: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split("\n").pop() ?? "[]");
};
export const verticaisDe = (f: string): PagV[] => py("_verticais_pdf.py", f);
export const palavrasDe = (f: string): { paginas: { w: number; h: number; palavras: Palavra[] }[] } => py("_palavras_pdf.py", f);
export const separadoresDe = (f: string): { separadores: { espessura: number; cinzento: number }[] }[] => py("_separadores_pdf.py", f);

/** Funde os troços do mesmo filete (x a ±1.5pt) numa só linha com os intervalos verticais que cobre. */
type Linha = { x: number; largura: number; cinzento: number; integral: number; intervalos: [number, number][] };
function linhasVerticais(p: PagV): Linha[] {
  const ord = [...p.verticais].sort((a, b) => a.x0 - b.x0);
  const out: Linha[] = [];
  for (const v of ord) {
    const c = (v.x0 + v.x1) / 2;
    const l = out[out.length - 1];
    if (l && Math.abs(c - l.x) <= 1.5) {
      l.largura = Math.max(l.largura, v.largura); l.cinzento = Math.min(l.cinzento, v.cinzento); l.integral = Math.max(l.integral, v.integral); l.intervalos.push([v.y0, v.y1]);
    } else out.push({ x: c, largura: v.largura, cinzento: v.cinzento, integral: v.integral, intervalos: [[v.y0, v.y1]] });
  }
  for (const l of out) {
    l.intervalos.sort((a, b) => a[0] - b[0]);
    const m: [number, number][] = [];
    for (const i of l.intervalos) { const u = m[m.length - 1]; if (u && i[0] <= u[1] + 2) u[1] = Math.max(u[1], i[1]); else m.push([i[0], i[1]]); }
    l.intervalos = m;
  }
  return out;
}

export type MedicaoMeses = { falhas: string[]; nLimites: number[]; nPaginas: number; minLargura: number; maxLargura: number; minHorizontal: number; cinzMes: number[]; cinzLimite: number[] };

/** `esperados(pi)`: nº de meses da página `pi` (0-based); `null` = o do cabeçalho (só valida o resto). */
export function medirMeses(f: string, esperados: (pi: number) => number | null): MedicaoMeses {
  const pags = verticaisDe(f);
  const txt = palavrasDe(f);
  const sep = separadoresDe(f);
  const falhas: string[] = [];
  const nLimitesTotal: number[] = [];
  let maxLargura = 0, minLargura = Infinity, minHorizontal = Infinity;
  const cinzMes: number[] = [], cinzLimite: number[] = [];
  pags.forEach((p, pi) => {
        const ls = linhasVerticais(p);
    const meses = p.cabecalho.slice().sort((a, b) => a.x0 - b.x0);
    const k = esperados(pi) ?? meses.length;
    if (meses.length !== k) { falhas.push(`pág ${pi + 1}: ${meses.length} meses no cabeçalho, esperados ${k}`); return; }
    const centros = meses.map((m) => (m.x0 + m.x1) / 2);
    // limite esquerdo = filete mais próximo À ESQUERDA do 1.º mês; direito = o mais próximo À DIREITA do último
    const esq = ls.filter((l) => l.x < centros[0]).pop();
    const dir_ = ls.find((l) => l.x > centros[k - 1]);
    if (!esq || !dir_) { falhas.push(`pág ${pi + 1}: faltam os limites do 1.º/último mês`); return; }
    const noIntervalo = ls.filter((l) => l.x >= esq.x - 0.1 && l.x <= dir_.x + 0.1);
    nLimitesTotal.push(noIntervalo.length);
    if (noIntervalo.length !== k + 1) falhas.push(`pág ${pi + 1}: ${noIntervalo.length} filetes no intervalo dos meses, esperados ${k + 1}`);
    // cada mês entre dois filetes consecutivos (cabeçalho e corpo coincidem porque o filete é UM só, contínuo)
    meses.forEach((m, i) => {
      const a = noIntervalo[i], b = noIntervalo[i + 1];
      if (!a || !b || !(m.x0 > a.x && m.x1 < b.x)) falhas.push(`pág ${pi + 1}: o mês «${m.texto}» não fica entre dois filetes`);
    });
    // continuidade: cobre do topo do cabeçalho ao fim da tabela (TOTAL GERAL na última página; senão o último artigo)
    const topo = Math.min(...p.cabCnp.map((c) => c.y0), meses[0].y0);
    const tgY1 = p.totais.filter((t) => t.texto === "GERAL" && p.cnps.length > 0 && t.y0 > p.cnps[p.cnps.length - 1].y0).sort((x, y) => x.y0 - y.y0).map((t) => t.y1)[0]; // o 1.º depois do último artigo (a nota final também diz «TOTAL GERAL»)
    const fim = tgY1 ?? (p.cnps.length ? p.cnps[p.cnps.length - 1].y1 : 0);
    const totaisArtigo = p.totais.filter((t) => t.texto === "ARTIGO");
    noIntervalo.forEach((l, i) => {
      const cobre = (y0: number, y1: number) => l.intervalos.some(([a, b]) => a <= y0 && b >= y1);
      if (!cobre(topo, fim)) falhas.push(`pág ${pi + 1}: filete ${i + 1} (x=${l.x.toFixed(1)}) não é contínuo do cabeçalho ao fim (${JSON.stringify(l.intervalos.map((q) => q.map((n) => Math.round(n))))}, preciso ${Math.round(topo)}–${Math.round(fim)})`);
      for (const t of totaisArtigo) if (!cobre(t.y0, t.y1)) falhas.push(`pág ${pi + 1}: filete ${i + 1} interrompido no TOTAL ARTIGO (y=${Math.round(t.y0)})`);
      const limite = i === 0 || i === noIntervalo.length - 1;
      // largura real = escuridão integrada ÷ contraste da cor do filete (interno #b4bac4 ≈ 186/255; limite #9aa4b2 ≈ 164/255)
      const larg = l.integral / (255 - (limite ? 164 : 186));
      maxLargura = Math.max(maxLargura, larg); minLargura = Math.min(minLargura, larg);
      (limite ? cinzLimite : cinzMes).push(l.cinzento);
    });
    // nada à esquerda do 1.º mês (só um filete: o limite) e nada em Stock / Valor Vendas
    const aEsquerda = ls.filter((l) => l.x < esq.x - 1.5);
    if (aEsquerda.length) falhas.push(`pág ${pi + 1}: ${aEsquerda.length} filete(s) à esquerda do 1.º mês (x=${aEsquerda.map((l) => l.x.toFixed(0)).join(",")})`);
    const cabY = p.cabCnp[0]?.y0 ?? 0;
    const stock = txt.paginas[pi].palavras.find((w) => w[4] === "Stock" && Math.abs(w[1] - cabY) < 12);
    if (stock) {
      const alemStock = ls.filter((l) => l.x > stock[0] - 2);
      if (alemStock.length) falhas.push(`pág ${pi + 1}: filete(s) em Stock/Valor Vendas (x=${alemStock.map((l) => l.x.toFixed(0)).join(",")})`);
    }
    const aDireita = ls.filter((l) => l.x > dir_.x + 1.5);
    if (aDireita.length > 2) falhas.push(`pág ${pi + 1}: ${aDireita.length} filetes à direita do limite final (máx. 2: os da coluna «Total unid.»)`);
    // nenhuma palavra cortada: nenhum filete atravessa o texto
    for (const w of txt.paginas[pi].palavras) {
      for (const l of ls) {
        if (l.x > w[0] + 0.3 && l.x < w[2] - 0.3 && l.intervalos.some(([a, b]) => a < w[3] - 0.5 && b > w[1] + 0.5)) { falhas.push(`pág ${pi + 1}: o filete x=${l.x.toFixed(1)} corta «${w[4]}»`); break; }
      }
    }
    if (txt.paginas[pi].palavras.some((w) => w[2] > p.largura - 8)) falhas.push(`pág ${pi + 1}: texto cortado à direita`);
  });
  for (const s of sep) for (const h of s.separadores) if (h.espessura >= 0.9 && h.cinzento >= 110 && h.cinzento <= 180) minHorizontal = Math.min(minHorizontal, h.espessura);
  return { falhas, nLimites: nLimitesTotal, nPaginas: pags.length, minLargura, maxLargura, minHorizontal, cinzMes, cinzLimite };
}

export const mediana = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
