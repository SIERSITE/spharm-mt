// Sem `import "server-only"` — mesma razão de lib/ingest/bulk.ts (consumido por
// route handlers e por scripts tsx de teste).
import { Prisma } from "@/generated/prisma/client";
import type { PrismaClient } from "@/generated/prisma/client";

/**
 * lib/ingest/classificacao-erp.ts   —   PROVISÓRIO (pendente de auditoria real)
 *
 * Genérico TRI-ESTADO vindo do ERP (`dbo.Stocks.[Generico]`).
 *
 * ── O QUE ESTÁ PROVADO E O QUE NÃO ESTÁ ─────────────────────────────
 * Só `dbo.Stocks.[Generico]` tem coluna conhecida no repositório. Ético,
 * NETT e Serviço NÃO têm coluna provada nem modelo fixado (booleanos
 * independentes? categoria única? outra tabela?): por isso NÃO existe aqui
 * (nem no schema, nem na migration, nem na UI) nenhum campo para eles.
 * Fecham-se depois do `classification-audit` numa farmácia real —
 * ver notes/classificacao-erp-produtos.md.
 *
 * ── SEMÂNTICA DO PAYLOAD (chave `generico`, a que o agent já envia) ─
 *   · chave AUSENTE / undefined → agent que não a envia: NÃO toca na
 *     coluna (nunca apaga, nunca assume false);
 *   · true / 1 / "1" / "true"  → genérico;
 *   · false / 0 / "0" / "false" → NÃO genérico;
 *   · null / "" → desconhecido → NULL (NUNCA false);
 *   · qualquer outra coisa (texto não booleano, número ≠ 0/1) → NULL e
 *     conta em `valoresDesconhecidos`; o lote nunca falha por isto.
 *
 * ── ESCRITA ─────────────────────────────────────────────────────────
 * Um único `UPDATE … FROM (VALUES …)` por lote, só nas linhas em que o
 * valor mudou (`IS DISTINCT FROM`): reenviar o mesmo lote não escreve
 * nada (nem sequer `dataAtualizacao`). Respeita `camposManuais`
 * ("genericoErp"). Não toca designação, fabricante, `flagGenerico` nem
 * qualquer outro campo do produto.
 */

/** Chave do payload que o agent já envia (tri-estado desde sempre). */
export const CHAVE_PAYLOAD_GENERICO = "generico";

export type ClassificacaoErpItem = {
  /** Só presente quando a chave veio no payload (true/false/null). */
  genericoErp?: boolean | null;
  /** Valores não reconhecidos convertidos em NULL (0 ou 1 por item). */
  desconhecidos: number;
};

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

/** Lê o Genérico tri-estado de UM item do payload. Função pura. */
export function lerClassificacaoErpDoPayload(raw: Record<string, unknown>): ClassificacaoErpItem {
  const c = coagir(raw[CHAVE_PAYLOAD_GENERICO]);
  if (!c.enviado) return { desconhecidos: 0 };
  return { genericoErp: c.valor, desconhecidos: c.desconhecido ? 1 : 0 };
}

export type ClassificacaoErpLinha = { produtoId: string; item: ClassificacaoErpItem };

export type ResumoClassificacaoErp = {
  /** Itens do lote que traziam a chave (true/false/null). */
  candidatos: number;
  /** Produtos efetivamente alterados (0 num reenvio idêntico). */
  alterados: number;
  /** Valores não reconhecidos convertidos em NULL. */
  valoresDesconhecidos: number;
  /** Presente se a escrita falhou (o lote de produtos NÃO falha por isto). */
  erro?: string;
};

type DbClient = PrismaClient | Prisma.TransactionClient;

/** Aplica o Genérico tri-estado a um lote. Dedupe por produtoId (última ocorrência ganha). */
export async function aplicarClassificacaoErp(
  db: DbClient,
  linhas: ClassificacaoErpLinha[],
): Promise<ResumoClassificacaoErp> {
  const porProduto = new Map<string, ClassificacaoErpItem>();
  let valoresDesconhecidos = 0;
  for (const l of linhas) {
    if (!("genericoErp" in l.item)) continue;
    valoresDesconhecidos += l.item.desconhecidos;
    porProduto.set(l.produtoId, l.item);
  }
  const resumo: ResumoClassificacaoErp = { candidatos: porProduto.size, alterados: 0, valoresDesconhecidos };
  if (porProduto.size === 0) return resumo;

  const values = [...porProduto.entries()].map(
    ([id, it]) => Prisma.sql`(${id}::text, ${it.genericoErp ?? null}::boolean)`,
  );

  const rows = await db.$queryRaw<Array<{ id: string }>>`
    WITH v(id, val) AS (VALUES ${Prisma.join(values)})
    UPDATE "Produto" p SET "genericoErp" = v.val
    FROM v
    WHERE p."id" = v.id
      AND NOT ('genericoErp' = ANY(p."camposManuais"))
      AND p."genericoErp" IS DISTINCT FROM v.val
    RETURNING p."id"
  `;
  resumo.alterados = rows.length;
  return resumo;
}
