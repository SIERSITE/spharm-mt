/**
 * lib/catalogo/classificacao-erp.ts
 *
 * Classificação do produto vinda do ERP (Ético / NETT / Serviço /
 * Genérico) — partilhado entre o Catálogo (lista, filtro, ficha) e a ficha
 * do artigo em Stock. Puro: sem acesso a base de dados nem `server-only`
 * (usado também por Client Components).
 *
 * Tri-estado em todo o lado: true = Sim, false = Não, null = o ERP nunca
 * informou ("—"). Nunca se mostra "Não" para um desconhecido.
 *
 * Genérico: `genericoErp` (tri-estado, preenchido por agents com o campo)
 * tem prioridade; enquanto for null cai para o `flagGenerico` anterior
 * (mesma leitura que existia antes desta funcionalidade).
 */
import type { Prisma } from "@/generated/prisma/client";

export type TriEstado = boolean | null;

export type ClassificacaoErpValores = {
  etico: TriEstado;
  nett: TriEstado;
  servico: TriEstado;
  /** Genérico efetivo: genericoErp ?? flagGenerico. */
  generico: TriEstado;
  /** Serviço combinado com Ético/NETT — guardado como veio, só sinalizado. */
  conflito: boolean;
};

export function genericoEfetivo(genericoErp: TriEstado, flagGenerico: boolean | null | undefined): TriEstado {
  if (genericoErp !== null && genericoErp !== undefined) return genericoErp;
  return flagGenerico === undefined || flagGenerico === null ? null : flagGenerico;
}

export function valoresClassificacaoErp(p: {
  erpEtico: TriEstado;
  erpNett: TriEstado;
  erpServico: TriEstado;
  genericoErp: TriEstado;
  flagGenerico?: boolean | null;
  classificacaoErpConflito: boolean;
}): ClassificacaoErpValores {
  return {
    etico: p.erpEtico,
    nett: p.erpNett,
    servico: p.erpServico,
    generico: genericoEfetivo(p.genericoErp, p.flagGenerico),
    conflito: p.classificacaoErpConflito,
  };
}

export function rotuloTri(v: TriEstado, placeholder = "—"): string {
  return v === true ? "Sim" : v === false ? "Não" : placeholder;
}

/** Rótulo de ficha: com sinal explícito de conflito (Serviço + Ético/NETT). */
export function rotuloClassificacaoFicha(
  campo: "etico" | "nett" | "servico",
  v: ClassificacaoErpValores,
  placeholder = "—",
): string {
  const base = rotuloTri(v[campo], placeholder);
  return v.conflito && v[campo] === true ? `${base} (conflito)` : base;
}

/** Badges da lista (só o que é verdadeiro; discreto). */
export function badgesClassificacaoErp(v: ClassificacaoErpValores): Array<{ chave: string; label: string; tom: "slate" | "amber" }> {
  const out: Array<{ chave: string; label: string; tom: "slate" | "amber" }> = [];
  if (v.etico === true) out.push({ chave: "etico", label: "Ético", tom: "slate" });
  if (v.nett === true) out.push({ chave: "nett", label: "NETT", tom: "slate" });
  if (v.servico === true) out.push({ chave: "servico", label: "Serviço", tom: "slate" });
  if (v.generico === true) out.push({ chave: "generico", label: "Genérico", tom: "slate" });
  if (v.conflito) out.push({ chave: "conflito", label: "Conflito", tom: "amber" });
  return out;
}

// ── Filtro (parâmetro de URL `cls`, whitelist no servidor) ───────────

export const FILTROS_CLASSIFICACAO_ERP = [
  { value: "etico", label: "Ético" },
  { value: "nett", label: "NETT" },
  { value: "servico", label: "Serviço" },
  { value: "generico", label: "Genérico" },
  { value: "nao_generico", label: "Não genérico" },
  { value: "sem_classificacao", label: "Sem classificação ERP" },
  { value: "conflito", label: "Conflito (Serviço + Ético/NETT)" },
] as const;

export type FiltroClassificacaoErp = (typeof FILTROS_CLASSIFICACAO_ERP)[number]["value"];

const VALIDOS = new Set<string>(FILTROS_CLASSIFICACAO_ERP.map((f) => f.value));

/** Whitelist: qualquer valor fora da lista é ignorado (nunca chega ao `where`). */
export function parseFiltroClassificacaoErp(v: string | undefined | null): FiltroClassificacaoErp | undefined {
  return v && VALIDOS.has(v) ? (v as FiltroClassificacaoErp) : undefined;
}

export function whereClassificacaoErp(f: FiltroClassificacaoErp | undefined): Prisma.ProdutoWhereInput | undefined {
  switch (f) {
    case "etico":
      return { erpEtico: true };
    case "nett":
      return { erpNett: true };
    case "servico":
      return { erpServico: true };
    case "generico":
      return { OR: [{ genericoErp: true }, { genericoErp: null, flagGenerico: true }] };
    case "nao_generico":
      return { OR: [{ genericoErp: false }, { genericoErp: null, flagGenerico: false }] };
    case "sem_classificacao":
      return { erpEtico: null, erpNett: null, erpServico: null };
    case "conflito":
      return { classificacaoErpConflito: true };
    default:
      return undefined;
  }
}
