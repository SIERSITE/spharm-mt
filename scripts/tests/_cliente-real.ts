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
