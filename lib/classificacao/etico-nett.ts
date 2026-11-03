/**
 * lib/classificacao/etico-nett.ts
 *
 * Classificação ERP «Ético / NETT» — módulo PURO (sem Prisma, importável no browser e copiável para o agent).
 *
 * ── Regras ────────────────────────────────────────────────────────────
 * · A origem é `dbo.Stocks.Etico_NETT` (FK para `dbo.Etico_NETT.Codigo`). Os CÓDIGOS podem diferir entre
 *   instalações: a decisão é SEMPRE pela descrição normalizada do lookup da própria farmácia.
 * · Só duas categorias existem: ETICO e NETT. Serviço, Sacos, Outros e qualquer descrição desconhecida
 *   ou ambígua NÃO são classificação (contam-se como aviso, nunca se inventa nem se apaga nada).
 * · Normalização: sem acentos, minúsculas, pontuação irrelevante removida, espaços colapsados.
 * · Reconhecimento por igualdade com um conjunto FECHADO de formas (singular/plural) — nada de «começa por».
 */

export const CATEGORIAS_ETICO_NETT = ["ETICO", "NETT"] as const;
export type CategoriaEticoNett = (typeof CATEGORIAS_ETICO_NETT)[number];

/** Valores do filtro (estado/URL): as duas categorias, «sem classificação» e (consolidado) «divergente». */
export const FILTRO_SEM_CLASSIFICACAO = "SEM" as const;
export const FILTRO_DIVERGENTE = "DIVERGENTE" as const;
export const VALORES_FILTRO_ETICO_NETT = ["ETICO", "NETT", FILTRO_SEM_CLASSIFICACAO, FILTRO_DIVERGENTE] as const;
export type ValorFiltroEticoNett = (typeof VALORES_FILTRO_ETICO_NETT)[number];

export const ROTULO_ETICO_NETT: Record<ValorFiltroEticoNett, string> = {
  ETICO: "Ético",
  NETT: "NETT",
  SEM: "Sem classificação",
  DIVERGENTE: "Divergente",
};

const ETICO_FORMAS = new Set(["etico", "eticos"]);
const NETT_FORMAS = new Set(["nett", "netts"]);

/** Sem acentos (NFD), minúsculas, pontuação → espaço, espaços colapsados e aparados. */
export function normalizarDescricaoEticoNett(valor: string | null | undefined): string {
  if (valor === null || valor === undefined) return "";
  return String(valor)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** ETICO | NETT se a descrição for INEQUIVOCAMENTE uma delas; `null` para tudo o resto (Serviço, vazio, ambíguo…). */
export function categoriaDaDescricao(descricao: string | null | undefined): CategoriaEticoNett | null {
  const n = normalizarDescricaoEticoNett(descricao);
  if (!n) return null;
  if (ETICO_FORMAS.has(n)) return "ETICO";
  if (NETT_FORMAS.has(n)) return "NETT";
  return null;
}

export type LinhaLookupEticoNett = { codigo: number | null | undefined; descricao: string | null | undefined };

export type ResolucaoLookupEticoNett = {
  /** codigo ERP -> categoria, só para códigos INEQUÍVOCOS. */
  porCodigo: Map<number, CategoriaEticoNett>;
  /** Linhas do lookup ignoradas (Serviço, Sacos, Outros, desconhecidas, código inválido). */
  ignoradas: number;
  /** Códigos retirados por ambiguidade: o mesmo código com categorias distintas, ou 2 códigos para a mesma categoria. */
  ambiguos: number[];
};

/**
 * Resolve o lookup `dbo.Etico_NETT` de UMA farmácia. Ambiguidade (nunca adivinhar):
 *  · o mesmo código repetido com categorias diferentes -> descartado;
 *  · duas descrições reconhecidas da MESMA categoria em códigos DIFERENTES -> ambos descartados
 *    (não se sabe qual é o «verdadeiro»; é preferível não classificar a classificar mal).
 */
export function resolverLookupEticoNett(linhas: readonly LinhaLookupEticoNett[]): ResolucaoLookupEticoNett {
  const candidatos = new Map<number, Set<CategoriaEticoNett>>();
  let ignoradas = 0;
  for (const l of linhas) {
    const cod = typeof l.codigo === "number" && Number.isInteger(l.codigo) ? l.codigo : null;
    const cat = categoriaDaDescricao(l.descricao);
    if (cod === null || cat === null) {
      ignoradas++;
      continue;
    }
    const s = candidatos.get(cod) ?? new Set<CategoriaEticoNett>();
    s.add(cat);
    candidatos.set(cod, s);
  }
  const ambiguos = new Set<number>();
  for (const [cod, cats] of candidatos) if (cats.size > 1) ambiguos.add(cod);
  const codigosPorCategoria = new Map<CategoriaEticoNett, number[]>();
  for (const [cod, cats] of candidatos) {
    if (cats.size !== 1) continue;
    const c = [...cats][0];
    codigosPorCategoria.set(c, [...(codigosPorCategoria.get(c) ?? []), cod]);
  }
  for (const cods of codigosPorCategoria.values()) if (cods.length > 1) for (const c of cods) ambiguos.add(c);
  const porCodigo = new Map<number, CategoriaEticoNett>();
  for (const [cod, cats] of candidatos) {
    if (ambiguos.has(cod) || cats.size !== 1) continue;
    porCodigo.set(cod, [...cats][0]);
  }
  return { porCodigo, ignoradas, ambiguos: [...ambiguos].sort((a, b) => a - b) };
}

export type EstadoConsolidado = "ETICO" | "NETT" | "SEM" | "DIVERGENTE";

/**
 * Valor consolidado de um produto a partir das farmácias COM informação:
 *  · nenhuma -> SEM; todas iguais -> essa; categorias diferentes -> DIVERGENTE.
 * Nunca «a última farmácia a sincronizar ganha».
 */
export function consolidarEticoNett(valores: ReadonlyArray<CategoriaEticoNett | null | undefined>): EstadoConsolidado {
  const distintos = new Set<CategoriaEticoNett>();
  for (const v of valores) if (v === "ETICO" || v === "NETT") distintos.add(v);
  if (distintos.size === 0) return "SEM";
  if (distintos.size > 1) return "DIVERGENTE";
  return [...distintos][0];
}

/** Lê uma lista de valores de filtro (estado/URL) descartando lixo e duplicados. */
export function lerValoresFiltroEticoNett(entrada: unknown): ValorFiltroEticoNett[] {
  if (!Array.isArray(entrada)) return [];
  const out: ValorFiltroEticoNett[] = [];
  for (const v of entrada) {
    if (typeof v === "string" && (VALORES_FILTRO_ETICO_NETT as readonly string[]).includes(v) && !out.includes(v as ValorFiltroEticoNett)) {
      out.push(v as ValorFiltroEticoNett);
    }
  }
  return out;
}

export type EticoNettDoPayload =
  | { tipo: "AUSENTE" } // agent ≤ rev98: não toca em nada
  | { tipo: "NAO_CLASSIFICADO" } // observado mas sem categoria Ético/NETT (Serviço, desconhecido, lookup em falta…)
  | { tipo: "INVALIDO" } // valor incoerente (categoria que a descrição não confirma, ou texto estranho)
  | { tipo: "VALOR"; categoria: CategoriaEticoNett; codigoErp: number | null; descricaoErp: string | null };

/**
 * Interpreta os campos opcionais do item do payload:
 *   eticoNett: "ETICO" | "NETT" | null | (ausente)
 *   eticoNettCodigo: inteiro | null     eticoNettDescricao: string | null
 * Ausente ≠ null: ausente = agent antigo (preserva), null = agent novo que não reconheceu categoria.
 * Se a descrição vier, TEM de confirmar a categoria — senão o item é INVALIDO e nada se escreve.
 */
export function lerEticoNettDoPayload(raw: { eticoNett?: unknown; eticoNettCodigo?: unknown; eticoNettDescricao?: unknown }): EticoNettDoPayload {
  if (raw.eticoNett === undefined) return { tipo: "AUSENTE" };
  if (raw.eticoNett === null) return { tipo: "NAO_CLASSIFICADO" };
  if (raw.eticoNett !== "ETICO" && raw.eticoNett !== "NETT") return { tipo: "INVALIDO" };
  const categoria = raw.eticoNett;
  const descricao = typeof raw.eticoNettDescricao === "string" ? raw.eticoNettDescricao.trim().slice(0, 120) : null;
  if (descricao && categoriaDaDescricao(descricao) !== categoria) return { tipo: "INVALIDO" };
  const c = raw.eticoNettCodigo;
  const codigoErp = typeof c === "number" && Number.isInteger(c) && c >= 0 && c <= 32767 ? c : null;
  return { tipo: "VALOR", categoria, codigoErp, descricaoErp: descricao || null };
}
