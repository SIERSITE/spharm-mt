/**
 * lib/catalogo/classificacao-erp.ts   —   PROVISÓRIO (pendente de auditoria real)
 *
 * Genérico tri-estado do ERP para o Catálogo (lista, filtro `cls`, ficha).
 * Puro: sem acesso a base de dados nem `server-only` (usado também por
 * Client Components). Ético / NETT / Serviço NÃO existem aqui: o modelo não
 * está provado (ver notes/classificacao-erp-produtos.md).
 *
 * Tri-estado: true = Sim, false = Não, null = o ERP não informou ("—").
 * Quando `genericoErp` é null cai para o `flagGenerico` anterior (NOT NULL),
 * ou seja, a leitura que existia antes desta funcionalidade não muda.
 */
import type { Prisma } from "@/generated/prisma/client";

export type TriEstado = boolean | null;

/** Genérico efetivo: genericoErp tem prioridade; null cai para flagGenerico (leitura anterior). */
export function genericoEfetivo(
  genericoErp: TriEstado | undefined,
  flagGenerico: boolean | null | undefined,
): TriEstado {
  if (genericoErp !== null && genericoErp !== undefined) return genericoErp;
  return flagGenerico === undefined || flagGenerico === null ? null : flagGenerico;
}

export function rotuloTri(v: TriEstado, placeholder = "—"): string {
  return v === true ? "Sim" : v === false ? "Não" : placeholder;
}

// ── Filtro (parâmetro de URL `cls`, whitelist no servidor) ───────────

export const FILTROS_CLASSIFICACAO_ERP = [
  { value: "generico", label: "Genérico" },
  { value: "nao_generico", label: "Não genérico" },
  { value: "generico_desconhecido", label: "Genérico: ERP não informou" },
] as const;

export type FiltroClassificacaoErp = (typeof FILTROS_CLASSIFICACAO_ERP)[number]["value"];

const VALIDOS = new Set<string>(FILTROS_CLASSIFICACAO_ERP.map((f) => f.value));

/** Whitelist: qualquer valor fora da lista é ignorado (nunca chega ao `where`). */
export function parseFiltroClassificacaoErp(v: string | undefined | null): FiltroClassificacaoErp | undefined {
  return v && VALIDOS.has(v) ? (v as FiltroClassificacaoErp) : undefined;
}

export function whereClassificacaoErp(f: FiltroClassificacaoErp | undefined): Prisma.ProdutoWhereInput | undefined {
  switch (f) {
    case "generico":
      return { OR: [{ genericoErp: true }, { genericoErp: null, flagGenerico: true }] };
    case "nao_generico":
      return { OR: [{ genericoErp: false }, { genericoErp: null, flagGenerico: false }] };
    case "generico_desconhecido":
      // Só o que o ERP nunca informou: genericoErp null (inclui fichas antigas).
      return { genericoErp: null };
    default:
      return undefined;
  }
}
