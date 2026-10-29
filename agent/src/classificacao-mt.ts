/**
 * agent/src/classificacao-mt.ts
 *
 * Ficheiro LOCAL de CNPs exportado do MT (`--cnps-mt-ficheiro`). O diagnóstico NÃO chama o MT: só lê este ficheiro.
 *
 * Formato (uma linha por produto que EXISTE no MT, para a farmácia deste ERP):
 *     cnp                       (só existência)
 *     cnp;flagGenerico          (0/1)
 *     cnp;flagGenerico;manual   (manual 0/1 = flagGenerico protegido por camposManuais)
 * Só dígitos e 0/1. Linhas vazias e as que começam por «#» são ignoradas. Nada mais do ficheiro entra no SQL nem no
 * relatório (o relatório nem sequer guarda o nome do ficheiro: podia identificar o tenant).
 */

export type EntradaMt = { cnp: string; flag: 0 | 1 | null; manual: 0 | 1 | null };

export type ParseMt = {
  entradas: EntradaMt[];
  linhasLidas: number;
  linhasVazias: number;
  validas: number;
  invalidas: number;
  /** Nº (1-based) das primeiras linhas inválidas (nunca o conteúdo). */
  linhasInvalidasExemplo: number[];
  /** Mesmo CNP repetido com os mesmos valores. */
  duplicadas: number;
  /** Mesmo CNP repetido com valores diferentes (fica o primeiro). */
  conflitos: number;
  /** Linhas ignoradas por excederem o limite. */
  ignoradasPorLimite: number;
  comFlag: number;
  comManual: number;
  /** Nº de CNPs únicos aceites. */
  unicos: number;
};

export const LIMITE_LINHAS_MT = 2_000_000;
const RE_CNP = /^\d{1,12}$/;

function normCnp(t: string): string {
  const s = t.replace(/^0+(?=\d)/, "");
  return s === "" ? "0" : s;
}

/** Lê o texto do ficheiro MT. Pura. */
export function parseFicheiroMt(texto: string, limite = LIMITE_LINHAS_MT): ParseMt {
  const linhas = texto.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (linhas.length > 0 && linhas[linhas.length - 1] === "") linhas.pop();
  const r: ParseMt = {
    entradas: [],
    linhasLidas: linhas.length,
    linhasVazias: 0,
    validas: 0,
    invalidas: 0,
    linhasInvalidasExemplo: [],
    duplicadas: 0,
    conflitos: 0,
    ignoradasPorLimite: 0,
    comFlag: 0,
    comManual: 0,
    unicos: 0,
  };
  const vistos = new Map<string, EntradaMt>();
  linhas.forEach((bruta, idx) => {
    const linha = bruta.trim();
    if (linha === "" || linha.startsWith("#")) {
      r.linhasVazias++;
      return;
    }
    if (idx >= limite) {
      r.ignoradasPorLimite++;
      return;
    }
    const campos = linha.split(";").map((c) => c.trim());
    const invalida = () => {
      r.invalidas++;
      if (r.linhasInvalidasExemplo.length < 20) r.linhasInvalidasExemplo.push(idx + 1);
    };
    if (campos.length > 3 || !RE_CNP.test(campos[0]!)) return invalida();
    const bit = (c: string | undefined): 0 | 1 | null | "x" => (c === undefined ? null : c === "0" ? 0 : c === "1" ? 1 : "x");
    const flag = bit(campos[1]);
    const manual = bit(campos[2]);
    if (flag === "x" || manual === "x") return invalida();
    const e: EntradaMt = { cnp: normCnp(campos[0]!), flag, manual };
    r.validas++;
    const antes = vistos.get(e.cnp);
    if (antes) {
      if (antes.flag === e.flag && antes.manual === e.manual) r.duplicadas++;
      else r.conflitos++;
      return;
    }
    vistos.set(e.cnp, e);
    r.entradas.push(e);
    if (e.flag !== null) r.comFlag++;
    if (e.manual !== null) r.comManual++;
  });
  r.unicos = r.entradas.length;
  return r;
}

export type GrupoMt = { flag: 0 | 1 | null; manual: 0 | 1 | null };
export type BlocoMt = { grupo: GrupoMt; cnps: string[] };

export const TAMANHO_BLOCO_MT = 1000;

/** Divide os CNPs em blocos de ≤ `tamanho`, SEM misturar grupos (flag, manual): cada bloco é agregado no SQL com o seu grupo conhecido. */
export function dividirEmBlocos(entradas: EntradaMt[], tamanho = TAMANHO_BLOCO_MT): BlocoMt[] {
  const t = Math.max(1, Math.min(TAMANHO_BLOCO_MT, Math.trunc(tamanho)));
  const grupos = new Map<string, { grupo: GrupoMt; cnps: string[] }>();
  for (const e of entradas) {
    const k = `${e.flag ?? "-"}|${e.manual ?? "-"}`;
    const g = grupos.get(k) ?? { grupo: { flag: e.flag, manual: e.manual }, cnps: [] };
    g.cnps.push(e.cnp);
    grupos.set(k, g);
  }
  const blocos: BlocoMt[] = [];
  for (const k of [...grupos.keys()].sort()) {
    const g = grupos.get(k)!;
    for (let i = 0; i < g.cnps.length; i += t) blocos.push({ grupo: g.grupo, cnps: g.cnps.slice(i, i + t) });
  }
  return blocos;
}

/** Resumo do ficheiro para o relatório (sem nome do ficheiro, sem CNPs). */
export type ResumoFicheiroMt = Omit<ParseMt, "entradas">;
export function resumirParse(p: ParseMt): ResumoFicheiroMt {
  const { entradas: _e, ...resto } = p;
  void _e;
  return resto;
}
