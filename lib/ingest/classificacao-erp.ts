// Sem `import "server-only"` — mesma razão de lib/ingest/bulk.ts (consumido por
// route handlers e por scripts tsx de teste).
import { Prisma } from "@/generated/prisma/client";
import type { PrismaClient } from "@/generated/prisma/client";

/**
 * lib/ingest/classificacao-erp.ts
 *
 * Classificação do produto vinda do ERP: Ético, NETT, Serviço e Genérico.
 *
 * ── O QUE ESTÁ PROVADO E O QUE NÃO ESTÁ ─────────────────────────────
 * Só `dbo.Stocks.[Generico]` tem coluna conhecida. Para Ético, NETT e
 * Serviço o repositório NÃO contém nenhum nome de coluna do ERP; o agent
 * lê-os por MAPEAMENTO EXPLÍCITO por instalação (`classificacaoErp` em
 * agent.config.json, ver agent/src/classificacao-erp.ts) e envia flags
 * booleanas já interpretadas. O servidor não conhece códigos do ERP.
 *
 * ── SEMÂNTICA DO PAYLOAD (por campo: etico, nett, servico, genericoErp) ─
 *   · chave AUSENTE / undefined → agent antigo ou campo não mapeado:
 *     NÃO toca na coluna (nunca apaga, nunca assume false);
 *   · true / false → grava;
 *   · null / "" → "desconhecido": a chave só vem quando o mapeamento está
 *     ativo, por isso grava NULL;
 *   · qualquer outra coisa (texto não booleano, número ≠ 0/1) → NULL e
 *     conta em `valoresDesconhecidos`; o lote nunca falha por isto.
 *
 * ── ESCRITA ─────────────────────────────────────────────────────────
 * Um único `UPDATE … FROM (VALUES …)` por lote, só nas linhas em que algo
 * mudou (`IS DISTINCT FROM`): reenviar o mesmo lote não escreve nada.
 * Atómico por natureza (uma instrução). Respeita `camposManuais`
 * (erpEtico / erpNett / erpServico / genericoErp). Não toca designação,
 * fabricante nem qualquer outro campo do produto.
 */

export const CAMPOS_CLASSIFICACAO_ERP = ["erpEtico", "erpNett", "erpServico", "genericoErp"] as const;
export type CampoClassificacaoErp = (typeof CAMPOS_CLASSIFICACAO_ERP)[number];

/** Chaves do payload → coluna de Produto. */
const CHAVE_PAYLOAD: Record<CampoClassificacaoErp, string> = {
  erpEtico: "etico",
  erpNett: "nett",
  erpServico: "servico",
  genericoErp: "genericoErp",
};

export type ClassificacaoErpItem = {
  /** Só as colunas cujo valor veio no payload (true/false/null). */
  campos: Partial<Record<CampoClassificacaoErp, boolean | null>>;
  /** "spharm_erp:…" quando o agent o enviou. */
  origem: string | null;
  /** Quantos valores não reconhecidos foram convertidos em NULL. */
  desconhecidos: number;
};

export function conflitoClassificacao(v: {
  erpEtico: boolean | null;
  erpNett: boolean | null;
  erpServico: boolean | null;
}): boolean {
  return v.erpServico === true && (v.erpEtico === true || v.erpNett === true);
}

type Coercao = { enviado: false } | { enviado: true; valor: boolean | null; desconhecido: boolean };

function coagir(raw: unknown): Coercao {
  if (raw === undefined) return { enviado: false };
  if (raw === null) return { enviado: true, valor: null, desconhecido: false };
  if (typeof raw === "boolean") return { enviado: true, valor: raw, desconhecido: false };
  if (typeof raw === "number") {
    if (raw === 1) return { enviado: true, valor: true, desconhecido: false };
    if (raw === 0) return { enviado: true, valor: false, desconhecido: false };
    return { enviado: true, valor: null, desconhecido: true };
  }
  if (typeof raw === "string") {
    const s = raw.trim().toLowerCase();
    if (s === "") return { enviado: true, valor: null, desconhecido: false };
    if (s === "true" || s === "1") return { enviado: true, valor: true, desconhecido: false };
    if (s === "false" || s === "0") return { enviado: true, valor: false, desconhecido: false };
  }
  return { enviado: true, valor: null, desconhecido: true };
}

/** Lê os campos de classificação de UM item do payload. Função pura. */
export function lerClassificacaoErpDoPayload(raw: Record<string, unknown>): ClassificacaoErpItem {
  const campos: ClassificacaoErpItem["campos"] = {};
  let desconhecidos = 0;
  for (const campo of CAMPOS_CLASSIFICACAO_ERP) {
    const c = coagir(raw[CHAVE_PAYLOAD[campo]]);
    if (!c.enviado) continue;
    campos[campo] = c.valor;
    if (c.desconhecido) desconhecidos++;
  }
  const o = raw.classificacaoErpOrigem;
  const origem = typeof o === "string" && o.trim() !== "" ? o.trim().slice(0, 500) : null;
  return { campos, origem, desconhecidos };
}

export type ClassificacaoErpLinha = { produtoId: string; item: ClassificacaoErpItem };

export type ResumoClassificacaoErp = {
  /** Itens do lote que traziam pelo menos um campo de classificação. */
  candidatos: number;
  /** Produtos efetivamente alterados (0 num reenvio idêntico). */
  alterados: number;
  /** Valores não reconhecidos convertidos em NULL. */
  valoresDesconhecidos: number;
  /** Produtos que ficaram em conflito (Serviço + Ético/NETT). */
  conflitos: number;
  /** Presente se a escrita falhou (o lote de produtos NÃO falha por isto). */
  erro?: string;
};

type DbClient = PrismaClient | Prisma.TransactionClient;

/** Aplica a classificação a um lote. Dedupe por produtoId (última ocorrência ganha). */
export async function aplicarClassificacaoErp(
  db: DbClient,
  linhas: ClassificacaoErpLinha[],
): Promise<ResumoClassificacaoErp> {
  const porProduto = new Map<string, ClassificacaoErpItem>();
  let valoresDesconhecidos = 0;
  for (const l of linhas) {
    if (Object.keys(l.item.campos).length === 0) continue;
    valoresDesconhecidos += l.item.desconhecidos;
    porProduto.set(l.produtoId, l.item);
  }
  const resumo: ResumoClassificacaoErp = {
    candidatos: porProduto.size,
    alterados: 0,
    valoresDesconhecidos,
    conflitos: 0,
  };
  if (porProduto.size === 0) return resumo;

  const bool = (v: boolean | null | undefined) => (v === undefined ? null : v);
  const values = [...porProduto.entries()].map(([id, it]) => {
    const c = it.campos;
    return Prisma.sql`(
      ${id}::text,
      ${"erpEtico" in c}::boolean, ${bool(c.erpEtico)}::boolean,
      ${"erpNett" in c}::boolean, ${bool(c.erpNett)}::boolean,
      ${"erpServico" in c}::boolean, ${bool(c.erpServico)}::boolean,
      ${"genericoErp" in c}::boolean, ${bool(c.genericoErp)}::boolean,
      ${it.origem}::text
    )`;
  });

  const rows = await db.$queryRaw<Array<{ id: string; conflito: boolean }>>`
    WITH v(id, set_e, val_e, set_n, val_n, set_s, val_s, set_g, val_g, origem) AS (
      VALUES ${Prisma.join(values)}
    ),
    calc AS (
      SELECT p."id",
        CASE WHEN v.set_e AND NOT ('erpEtico' = ANY(p."camposManuais")) THEN v.val_e ELSE p."erpEtico" END AS e,
        CASE WHEN v.set_n AND NOT ('erpNett' = ANY(p."camposManuais")) THEN v.val_n ELSE p."erpNett" END AS n,
        CASE WHEN v.set_s AND NOT ('erpServico' = ANY(p."camposManuais")) THEN v.val_s ELSE p."erpServico" END AS s,
        CASE WHEN v.set_g AND NOT ('genericoErp' = ANY(p."camposManuais")) THEN v.val_g ELSE p."genericoErp" END AS g,
        v.origem
      FROM "Produto" p
      JOIN v ON v.id = p."id"
    ),
    calc2 AS (
      SELECT calc.*, (COALESCE(calc.s, false) AND (COALESCE(calc.e, false) OR COALESCE(calc.n, false))) AS conflito
      FROM calc
    )
    UPDATE "Produto" p SET
      "erpEtico" = c.e,
      "erpNett" = c.n,
      "erpServico" = c.s,
      "genericoErp" = c.g,
      "classificacaoErpConflito" = c.conflito,
      "classificacaoErpEm" = now(),
      "classificacaoErpOrigem" = COALESCE(c.origem, p."classificacaoErpOrigem"),
      "dataAtualizacao" = now()
    FROM calc2 c
    WHERE p."id" = c."id"
      AND (
        p."erpEtico" IS DISTINCT FROM c.e
        OR p."erpNett" IS DISTINCT FROM c.n
        OR p."erpServico" IS DISTINCT FROM c.s
        OR p."genericoErp" IS DISTINCT FROM c.g
        OR p."classificacaoErpConflito" IS DISTINCT FROM c.conflito
        OR (c.origem IS NOT NULL AND p."classificacaoErpOrigem" IS DISTINCT FROM c.origem)
      )
    RETURNING p."id", c.conflito
  `;
  resumo.alterados = rows.length;

  // Conflitos TOTAIS do lote (não só dos alterados): lê o estado final.
  const ids = [...porProduto.keys()];
  const [{ n }] = await db.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*)::bigint AS n FROM "Produto"
    WHERE "id" = ANY(${ids}::text[]) AND "classificacaoErpConflito" = true
  `;
  resumo.conflitos = Number(n);
  return resumo;
}
