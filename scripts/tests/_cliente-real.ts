/**
 * Dados SINTÉTICOS calibrados para reproduzir o PDF real do cliente que motivou a «tabela única» (nenhum dado real):
 *   · período 2025-10-01 a 2026-11-02 → 14 meses (Out/25 … Nov/26);
 *   · 326 artigos, duas farmácias (Segurado, Silveirense) — uns artigos numa só farmácia, outros nas duas;
 *   · descrições de 2 e 3 linhas, valores mensais com 0-3 dígitos, totais por artigo até 3 dígitos, stock até 133;
 *   · TOTAL GERAL por mês entre 15 (Nov/26, mês incompleto) e 1 077, ≈ 14 000 unidades no período, stock total 1 492;
 *   · PVP até 91,80 €, custo unitário até 48,18 €.
 * Determinístico (PRNG com semente): os mesmos números em qualquer máquina.
 */
import type { VendasAdapterRow } from "../../lib/reporting/adapters/vendas";

export const FARMACIAS_CLIENTE = ["Farmácia Segurado", "Farmácia Silveirense"];
export const MESES_CLIENTE = 14;
export const bucketsCliente = (n = MESES_CLIENTE) =>
  Array.from({ length: n }, (_, i) => ({ ano: 2025 + Math.floor((9 + i) / 12), mes: ((9 + i) % 12) + 1 }));

/** mulberry32 */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MARCAS = ["ASPIRINA", "VOLTAREN", "BEN-U-RON", "SENSODYNE", "NUROFEN", "FENISTIL", "LACTACYD", "BEPANTHOL", "DAFLON", "ZYMAFLUOR", "CETRAXAL", "OLFEN", "UVESTEROL", "AEROSOLTERAPIA", "BISOLTUSSIN", "MAGNESIOK", "PANTENE", "BIODERMA", "AVENE", "LA ROCHE-POSAY"];
const FORMAS = ["20 COMP", "60 COMP REVESTIDOS", "GEL 100G", "XAROPE 200ML", "SOLUCAO ORAL 30ML", "CREME 50G", "PASTA DENTIFRICA 75ML", "CAPSULAS 30", "SUSPENSAO ORAL FRASCO 150ML", "SPRAY NASAL 20ML", "POMADA OFTALMICA 5G", "SACHETS 14X5G"];
const DOSES = ["", "500MG", "1G", "10MG/ML", "250MG/5ML", "50MG", "1% ", "5MG + 12,5MG", "120MG"];

export type ParametrosCliente = { artigos?: number; meses?: number };

/**
 * Linhas de venda (uma por artigo×farmácia), ordenadas por descrição e farmácia (a ordem do relatório «Descrição A-Z»).
 * `meses` < 14 usa só os primeiros meses (os totais mensais mantêm-se).
 */
export function dadosClienteReal(p: ParametrosCliente = {}): VendasAdapterRow[] {
  const nArt = p.artigos ?? 326;
  const nMes = p.meses ?? MESES_CLIENTE;
  const bks = bucketsCliente(nMes);
  const rnd = prng(20261102);

  type Linha = { cnp: string; desc: string; farm: string; q: number[]; stock: number | null; pvp: number; custo: number };
  const linhas: Linha[] = [];
  const usados = new Set<string>();
  for (let i = 0; i < nArt; i++) {
    const marca = MARCAS[Math.floor(rnd() * MARCAS.length)];
    const dose = DOSES[Math.floor(rnd() * DOSES.length)];
    const forma = FORMAS[Math.floor(rnd() * FORMAS.length)];
    let desc = `${marca} ${dose} ${forma}`.replace(/\s+/g, " ").trim();
    if (usados.has(desc)) desc = `${desc} N${i + 1}`;
    usados.add(desc);
    const cnp = String(5000000 + Math.floor(rnd() * 1900000) + i);
    const duas = rnd() < 0.6; // 60 % dos artigos nas duas farmácias
    const farms = duas ? FARMACIAS_CLIENTE : [FARMACIAS_CLIENTE[Math.floor(rnd() * 2)]];
    // PVP/custo por farmácia: o preço de prateleira difere (≤ 91,80 / ≤ 48,18)
    const pvpBase = 1.5 + Math.pow(rnd(), 2.2) * 88;
    for (const farm of farms) {
      const pvp = Math.min(91.8, Math.round((pvpBase * (1 + (rnd() - 0.5) * 0.04)) * 100) / 100);
      const custo = Math.min(48.18, Math.round((pvp * (0.45 + rnd() * 0.2)) * 100) / 100);
      const q = bks.map(() => {
        if (rnd() < 0.5) return 0; // 50 % dos meses sem venda
        const v = Math.round(Math.exp((rnd() - 0.5) * 3.2) * 1.4);
        return Math.min(30, Math.max(1, v));
      });
      const stock = Math.floor(Math.pow(rnd(), 3) * 12);
      linhas.push({ cnp, desc, farm, q, stock, pvp, custo });
    }
  }

  // Totais mensais-alvo (TOTAL GERAL): máximo 1 077 e último mês incompleto (15). Ajusta ±1 em linhas aleatórias até acertar.
  const alvoBase = [980, 1077, 1040, 1066, 1031, 1052, 1010, 1075, 1060, 1044, 1070, 1038, 1055, 15];
  const alvo = bks.map((_, k) => alvoBase[k] ?? 1000);
  for (let k = 0; k < bks.length; k++) {
    let soma = linhas.reduce((a, l) => a + l.q[k], 0);
    let guarda = 0;
    while (soma !== alvo[k] && guarda++ < 200000) {
      const l = linhas[Math.floor(rnd() * linhas.length)];
      if (soma < alvo[k] && l.q[k] < 30) { l.q[k]++; soma++; }
      else if (soma > alvo[k] && l.q[k] > 0) { l.q[k]--; soma--; }
    }
  }
  // Stock: um artigo com 133 (o máximo do PDF real) e o stock total em 1 492
  const alvoStock = 1492;
  let st = linhas.reduce((a, l) => a + (l.stock ?? 0), 0);
  linhas[Math.floor(linhas.length / 3)].stock = 133;
  st = linhas.reduce((a, l) => a + (l.stock ?? 0), 0);
  let g = 0;
  while (st !== alvoStock && g++ < 100000) {
    const l = linhas[Math.floor(rnd() * linhas.length)];
    if (l.stock === 133) continue;
    if (st < alvoStock && (l.stock ?? 0) < 40) { l.stock = (l.stock ?? 0) + 1; st++; }
    else if (st > alvoStock && (l.stock ?? 0) > 0) { l.stock = (l.stock ?? 0) - 1; st--; }
  }

  linhas.sort((a, b) => a.desc.localeCompare(b.desc, "pt") || a.farm.localeCompare(b.farm, "pt"));
  return linhas.map((l): VendasAdapterRow => {
    const total = l.q.reduce((a, b) => a + b, 0);
    return {
      codigo: l.cnp, descricao: l.desc, pvp: l.pvp, custoUnitarioEstimado: l.custo, custoEstimado: Math.round(l.custo * total * 100) / 100,
      meses: l.q.map((x, k) => ({ ...bks[k], quantidade: x })), totalVendas: total, valorBruto: Math.round(l.pvp * total * 100) / 100,
      existencia: l.stock ?? 0, fornecedor: "Forn", fabricante: "Fab", categoria: "Cat", farmacia: l.farm, grupo: "G",
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Cenário «PDF REAL × N»: 326 artigos, 2 farmácias, 14 meses, mesma distribuição de linhas e de valores do PDF real do cliente (só números
// agregados, ver notes/vendas-pdf-real-analise.md), com os valores multiplicados por `mult` (10 = «10× os reais») e descrições até 100 caracteres.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Quantil por interpolação em log entre os pontos (p, valor) — p crescente. */
function quantil(u: number, pts: [number, number][]): number {
  for (let i = 1; i < pts.length; i++) {
    if (u <= pts[i][0]) {
      const [p0, v0] = pts[i - 1], [p1, v1] = pts[i];
      const t = (u - p0) / (p1 - p0);
      return Math.exp(Math.log(v0) + t * (Math.log(v1) - Math.log(v0)));
    }
  }
  return pts[pts.length - 1][1];
}

const PALAVRAS = ["COMPRIMIDOS", "REVESTIDOS", "SOLUCAO", "ORAL", "FRASCO", "CAPSULAS", "GASTRORRESISTENTES", "POR", "PELICULA", "DOSE", "UNICA", "SUSPENSAO", "INJETAVEL", "CREME", "POMADA", "PASTA", "DENTIFRICA", "XAROPE", "SPRAY", "NASAL", "SACHETS", "ADULTO", "PEDIATRICO", "FORTE", "RETARD", "MG", "ML", "G"];

/**
 * Linhas de venda do cenário «real × mult» (ordenadas por descrição e farmácia). Distribuição do PDF real: 116 artigos numa farmácia e 210 em
 * duas; 56 % de células mensais a zero; valores mensais não nulos com mediana 2, p90 8, p99 49, máx. 86; PVP até 91,80 € e custo até 48,18 €;
 * stock até 72 por farmácia; descrições com mediana 49, p90 84 e máximo 99 caracteres. Tudo multiplicado por `mult` (PVP/custo incluídos).
 */
export function dadosRealMult(mult = 10, meses = MESES_CLIENTE): VendasAdapterRow[] {
  const bks = bucketsCliente(meses);
  const rnd = prng(777 + mult);
  type L = { cnp: string; desc: string; farm: string; q: number[]; stock: number; pvp: number; custo: number };
  const linhas: L[] = [];
  const usados = new Set<string>();
  for (let i = 0; i < 326; i++) {
    const alvo = Math.min(99, Math.max(14, Math.round(quantil(rnd(), [[0, 14], [0.5, 49], [0.9, 84], [1, 99]]))));
    let desc = MARCAS[Math.floor(rnd() * MARCAS.length)];
    while (desc.length < alvo) desc += " " + PALAVRAS[Math.floor(rnd() * PALAVRAS.length)];
    desc = desc.slice(0, Math.max(alvo, 14)).trim();
    while (usados.has(desc)) desc = `${desc.slice(0, 96)} ${i}`.slice(0, 100);
    usados.add(desc);
    const cnp = String(5000000 + Math.floor(rnd() * 1900000) + i);
    const farms = i < 116 ? [FARMACIAS_CLIENTE[Math.floor(rnd() * 2)]] : FARMACIAS_CLIENTE;
    const pvpBase = quantil(rnd(), [[0, 1.2], [0.5, 6.7], [0.9, 19], [0.99, 50], [1, 91.8]]);
    for (const farm of farms) {
      const pvp = Math.round(Math.min(91.8, pvpBase * (1 + (rnd() - 0.5) * 0.04)) * mult * 100) / 100;
      const custo = Math.round(Math.min(48.18, pvpBase * (0.45 + rnd() * 0.2)) * mult * 100) / 100;
      const q = bks.map(() => (rnd() < 0.56 ? 0 : Math.round(quantil(rnd(), [[0, 1], [0.5, 2], [0.9, 8], [0.99, 49], [1, 86]]) * mult)));
      const stock = Math.round(quantil(rnd(), [[0, 1], [0.5, 1], [0.9, 6], [0.99, 20], [1, 72]]) * mult);
      linhas.push({ cnp, desc, farm, q, stock: rnd() < 0.3 ? 0 : stock, pvp, custo });
    }
  }
  linhas.sort((a, b) => a.desc.localeCompare(b.desc, "pt") || a.farm.localeCompare(b.farm, "pt"));
  return linhas.map((l): VendasAdapterRow => {
    const total = l.q.reduce((a, b) => a + b, 0);
    return {
      codigo: l.cnp, descricao: l.desc, pvp: l.pvp, custoUnitarioEstimado: l.custo, custoEstimado: Math.round(l.custo * total * 100) / 100,
      meses: l.q.map((x, k) => ({ ...bks[k], quantidade: x })), totalVendas: total, valorBruto: Math.round(l.pvp * total * 100) / 100,
      existencia: l.stock, fornecedor: "Forn", fabricante: "Fab", categoria: "Cat", farmacia: l.farm, grupo: "G",
    };
  });
}

export type OpcoesPiorCaso = { nFarm?: 2 | 3; artigos?: number; meses?: number; pvp?: number; custo?: number; mesGrande?: number; total?: number; stock?: number };
export const FARMACIAS_3 = [...FARMACIAS_CLIENTE, "Farmácia Muito Comprida Do Centro"];

/**
 * PIOR CASO SIMULTÂNEO dentro dos LIMITES (lib/reporting/layout-largura.ts): PVP e custo unitário `pvp`/`custo` (9 999,99 €), um valor mensal
 * de +`mesGrande` (99 000) no 1.º mês e de −`mesGrande` no último — cada um sozinho no seu mês, para o TOTAL ARTIGO e o TOTAL GERAL ficarem ≤ 99 999 —,
 * Total unid. e stock de 90 % de `total`/`stock` na linha grande (o TOTAL ARTIGO e o TOTAL GERAL ficam ≤ `total`/`stock`; negativo noutro artigo), descrições de 100 caracteres, 2 ou 3 farmácias por artigo (a 3.ª com um
 * nome de 32 caracteres), valores mensais de 0, 9, 99, 999 e 9 999 (± alternado) nos meses intermédios.
 */
export function dadosPiorCaso(o: OpcoesPiorCaso = {}): VendasAdapterRow[] {
  const nFarm = o.nFarm ?? 2, nArt = o.artigos ?? 24, meses = o.meses ?? MESES_CLIENTE;
  const bks = bucketsCliente(meses);
  const farms = (nFarm === 3 ? FARMACIAS_3 : FARMACIAS_CLIENTE).slice(0, nFarm);
  const pvp = o.pvp ?? 9999.99, custo = o.custo ?? 9999.99, grande = o.mesGrande ?? 99000, tot = o.total ?? 990000, stk = o.stock ?? 990000;
  const rows: VendasAdapterRow[] = [];
  const mags = [9, 99, 999, 9999];
  for (let a = 0; a < nArt; a++) {
    const desc = `${MARCAS[a % MARCAS.length]} ${PALAVRAS.slice(a % 5, (a % 5) + 9).join(" ")} ${"X".repeat(8)}`.slice(0, 100).trim();
    for (let f = 0; f < nFarm; f++) {
      const q = bks.map((_, k) => {
        if (a === 0 && f === 0 && k === 0) return grande;
        if (a === 0 && f === 0 && k === meses - 1) return -grande;
        if (k === 0 || k === meses - 1) return 0;
        // um só valor por mês e por «posição», sinal alternado: nunca soma acima de 99 999
        return (a * nFarm + f) % (meses - 2) === k - 1 ? (k % 2 ? 1 : -1) * mags[k % 4] : (a + f + k) % 5 === 0 ? 3 : 0;
      });
      const grandeRow = a === 0 && f === 0, negRow = a === 1 && f === 0;
      const total = grandeRow ? Math.round(tot * 0.9) : negRow ? -Math.round(tot / 2) : q.reduce((x, y) => x + y, 0);
      const stock = grandeRow ? Math.round(stk * 0.9) : negRow ? -Math.round(stk / 2) : (a + f) % 9;
      rows.push({
        codigo: String(5100000 + a * 13), descricao: desc, pvp: grandeRow ? pvp : [9.99, 99.99, 999.99][(a + f) % 3], custoUnitarioEstimado: grandeRow ? custo : [9.99, 99.99, 999.99][(a + f + 1) % 3],
        custoEstimado: Math.round(custo * total * 100) / 100, meses: q.map((x, k) => ({ ...bks[k], quantidade: x })), totalVendas: total, valorBruto: Math.round(pvp * total * 100) / 100,
        existencia: stock, fornecedor: "F", fabricante: "Fab", categoria: "C", farmacia: farms[f], grupo: "G",
      });
    }
  }
  return rows;
}
