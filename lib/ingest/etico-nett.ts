/**
 * lib/ingest/etico-nett.ts
 *
 * Aplica a classificação ERP Ético/NETT a `ProdutoFarmacia` — UMA farmácia, produtos que JÁ existem.
 *
 * · Só faz UPDATE de linhas existentes (nunca INSERT): esta classificação não cria produtos nem associações.
 * · Respeita `eticoNettManual` (classificação feita à mão nunca é substituída).
 * · Idempotente: reenviar o mesmo lote deixa o mesmo estado.
 * · Itens sem categoria (ausente / não classificado / inválido) nunca apagam nem alteram o que existe.
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { lerEticoNettDoPayload, type CategoriaEticoNett } from "@/lib/classificacao/etico-nett";

type DbClient = PrismaClient | Prisma.TransactionClient;

export type EticoNettAAplicar = {
  produtoId: string;
  categoria: CategoriaEticoNett;
  codigoErp: number | null;
  descricaoErp: string | null;
};

export type ResumoEticoNett = {
  /** Itens do lote cujo payload trazia o campo (agent novo). */
  candidatos: number;
  aplicados: number;
  /** Observados mas sem categoria Ético/NETT (Serviço, desconhecida, ambígua, lookup em falta) — aviso. */
  naoClassificados: number;
  invalidos: number;
  /** Não substituídos por estarem marcados como manuais. */
  ignoradosManual: number;
};

export function resumoEticoNettVazio(): ResumoEticoNett {
  return { candidatos: 0, aplicados: 0, naoClassificados: 0, invalidos: 0, ignoradosManual: 0 };
}

type RawEticoNett = { eticoNett?: unknown; eticoNettCodigo?: unknown; eticoNettDescricao?: unknown };

/** Classifica os itens do payload (puro): devolve o que aplicar + contagens parciais. */
export function prepararEticoNett(
  itens: ReadonlyArray<{ produtoId: string | undefined; raw: RawEticoNett }>,
): { aplicar: EticoNettAAplicar[]; resumo: ResumoEticoNett } {
  const resumo = resumoEticoNettVazio();
  const aplicar: EticoNettAAplicar[] = [];
  for (const it of itens) {
    const p = lerEticoNettDoPayload(it.raw);
    if (p.tipo === "AUSENTE") continue;
    resumo.candidatos++;
    if (p.tipo === "NAO_CLASSIFICADO") resumo.naoClassificados++;
    else if (p.tipo === "INVALIDO") resumo.invalidos++;
    else if (it.produtoId) {
      aplicar.push({ produtoId: it.produtoId, categoria: p.categoria, codigoErp: p.codigoErp, descricaoErp: p.descricaoErp });
    }
  }
  return { aplicar, resumo };
}

export async function aplicarEticoNett(
  db: DbClient,
  farmaciaId: string,
  itens: EticoNettAAplicar[],
  resumo: ResumoEticoNett,
): Promise<ResumoEticoNett> {
  if (itens.length === 0) return resumo;
  const ids = itens.map((i) => i.produtoId);
  const cats = itens.map((i) => i.categoria as string);
  const cods = itens.map((i) => i.codigoErp);
  const descs = itens.map((i) => i.descricaoErp);
  const rows = await db.$queryRaw<Array<{ aplicado: boolean }>>`
    WITH v AS (
      SELECT * FROM unnest(${ids}::text[], ${cats}::text[], ${cods}::int[], ${descs}::text[])
        AS t("produtoId", "categoria", "codigo", "descricao")
    ), alvo AS (
      SELECT pf.id, v."categoria", v."codigo", v."descricao"
        FROM "ProdutoFarmacia" pf JOIN v ON v."produtoId" = pf."produtoId"
       WHERE pf."farmaciaId" = ${farmaciaId} AND NOT pf."eticoNettManual"
    ), upd AS (
      UPDATE "ProdutoFarmacia" pf
         SET "eticoNett" = alvo."categoria"::"ClassificacaoEticoNett",
             "eticoNettCodigoErp" = alvo."codigo",
             "eticoNettDescricaoErp" = alvo."descricao",
             "eticoNettObservadoEm" = now()
        FROM alvo
       WHERE pf.id = alvo.id
      RETURNING true AS aplicado
    )
    SELECT aplicado FROM upd
  `;
  const manuais = await db.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM "ProdutoFarmacia"
     WHERE "farmaciaId" = ${farmaciaId} AND "eticoNettManual" AND "produtoId" = ANY(${ids}::text[])
  `;
  return {
    ...resumo,
    aplicados: resumo.aplicados + rows.length,
    ignoradosManual: resumo.ignoradosManual + Number(manuais[0]?.n ?? 0),
  };
}
