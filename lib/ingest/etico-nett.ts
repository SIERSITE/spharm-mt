/**
 * lib/ingest/etico-nett.ts
 *
 * Aplica a classificação ERP Ético/NETT a `ProdutoFarmacia` — UMA farmácia, produtos que JÁ existem.
 *
 * · Só faz UPDATE de linhas existentes (nunca INSERT): esta classificação não cria produtos nem associações.
 *   (Se o Produto já existe no MT mas ainda não tem `ProdutoFarmacia` desta farmácia, é o upsert normal do item —
 *   o mesmo que sempre correu para os artigos que o agent já enviava — que a cria ANTES deste passo; ver o route.)
 * · Respeita `eticoNettManual` (classificação feita à mão nunca é substituída nem retirada).
 * · Idempotente: reenviar o mesmo lote deixa o mesmo estado.
 * · ETICO/NETT gravam. «Outra categoria conhecida» (Serviço, Sacos, Outros) RETIRA só a classificação automática
 *   (fica SEM). Ausente / desconhecido / ambíguo / lookup em falta / inválido NUNCA apagam: contam aviso.
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

export type EticoNettALimpar = { produtoId: string; codigoErp: number | null; descricaoErp: string };

export type ResumoEticoNett = {
  /** Itens do lote cujo payload trazia o campo (agent novo). */
  candidatos: number;
  aplicados: number;
  /** Classificações Ético/NETT retiradas porque o ERP passou o artigo a outra categoria conhecida. */
  limpos: number;
  /** Itens do lote em outra categoria conhecida (Serviço, Sacos, Outros), tenham ou não classificação a retirar. */
  outraCategoria: number;
  /** Observados mas sem categoria utilizável (desconhecida, ambígua, órfã, lookup em falta) — aviso; nada é alterado. */
  naoClassificados: number;
  invalidos: number;
  /** Não alterados por estarem marcados como manuais. */
  ignoradosManual: number;
};

export function resumoEticoNettVazio(): ResumoEticoNett {
  return { candidatos: 0, aplicados: 0, limpos: 0, outraCategoria: 0, naoClassificados: 0, invalidos: 0, ignoradosManual: 0 };
}

type RawEticoNett = {
  eticoNett?: unknown;
  eticoNettCodigo?: unknown;
  eticoNettDescricao?: unknown;
  eticoNettOutraCategoria?: unknown;
};

/** Classifica os itens do payload (puro): devolve o que aplicar/retirar + contagens parciais. */
export function prepararEticoNett(
  itens: ReadonlyArray<{ produtoId: string | undefined; raw: RawEticoNett }>,
): { aplicar: EticoNettAAplicar[]; limpar: EticoNettALimpar[]; resumo: ResumoEticoNett } {
  const resumo = resumoEticoNettVazio();
  const aplicar: EticoNettAAplicar[] = [];
  const limpar: EticoNettALimpar[] = [];
  for (const it of itens) {
    const p = lerEticoNettDoPayload(it.raw);
    if (p.tipo === "AUSENTE") continue;
    resumo.candidatos++;
    if (p.tipo === "NAO_CLASSIFICADO") resumo.naoClassificados++;
    else if (p.tipo === "INVALIDO") resumo.invalidos++;
    else if (p.tipo === "OUTRA_CATEGORIA") {
      resumo.outraCategoria++;
      if (it.produtoId) limpar.push({ produtoId: it.produtoId, codigoErp: p.codigoErp, descricaoErp: p.descricaoErp });
    } else if (it.produtoId) {
      aplicar.push({ produtoId: it.produtoId, categoria: p.categoria, codigoErp: p.codigoErp, descricaoErp: p.descricaoErp });
    }
  }
  return { aplicar, limpar, resumo };
}

export async function aplicarEticoNett(
  db: DbClient,
  farmaciaId: string,
  itens: EticoNettAAplicar[],
  resumo: ResumoEticoNett,
  limpar: EticoNettALimpar[] = [],
): Promise<ResumoEticoNett> {
  let aplicados = 0;
  let limpos = 0;
  if (itens.length > 0) {
    const rows = await db.$queryRaw<Array<{ aplicado: boolean }>>`
      WITH v AS (
        SELECT * FROM unnest(${itens.map((i) => i.produtoId)}::text[], ${itens.map((i) => i.categoria as string)}::text[],
                             ${itens.map((i) => i.codigoErp)}::int[], ${itens.map((i) => i.descricaoErp)}::text[])
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
    aplicados = rows.length;
  }
  if (limpar.length > 0) {
    const rows = await db.$queryRaw<Array<{ tinha: boolean }>>`
      WITH v AS (
        SELECT * FROM unnest(${limpar.map((i) => i.produtoId)}::text[], ${limpar.map((i) => i.codigoErp)}::int[],
                             ${limpar.map((i) => i.descricaoErp)}::text[])
          AS t("produtoId", "codigo", "descricao")
      ), alvo AS (
        SELECT pf.id, pf."eticoNett" IS NOT NULL AS tinha, v."codigo", v."descricao"
          FROM "ProdutoFarmacia" pf JOIN v ON v."produtoId" = pf."produtoId"
         WHERE pf."farmaciaId" = ${farmaciaId} AND NOT pf."eticoNettManual"
      ), upd AS (
        UPDATE "ProdutoFarmacia" pf
           SET "eticoNett" = NULL,
               "eticoNettCodigoErp" = alvo."codigo",
               "eticoNettDescricaoErp" = alvo."descricao",
               "eticoNettObservadoEm" = now()
          FROM alvo
         WHERE pf.id = alvo.id
        RETURNING alvo.tinha AS tinha
      )
      SELECT tinha FROM upd
    `;
    limpos = rows.filter((r) => r.tinha).length;
  }
  const ids = [...itens.map((i) => i.produtoId), ...limpar.map((i) => i.produtoId)];
  let manuais = 0;
  if (ids.length > 0) {
    const m = await db.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM "ProdutoFarmacia"
       WHERE "farmaciaId" = ${farmaciaId} AND "eticoNettManual" AND "produtoId" = ANY(${ids}::text[])
    `;
    manuais = Number(m[0]?.n ?? 0);
  }
  return { ...resumo, aplicados: resumo.aplicados + aplicados, limpos: resumo.limpos + limpos, ignoradosManual: resumo.ignoradosManual + manuais };
}
