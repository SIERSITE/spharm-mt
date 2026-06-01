/**
 * lib/iva-recovery.ts
 *
 * Pipeline de recuperação da taxa IVA por ProdutoFarmacia.
 *
 * O `StagingCompraRawLine.iva` sozinho dá apenas ~35% de cobertura, o
 * que não é aceitável. Esta biblioteca combina TODAS as fontes
 * documentais disponíveis no SaaS, em cascata, e persiste o resultado
 * em `ProdutoFarmacia.taxaIvaPercent` + `taxaIvaSource`.
 *
 * Hierarquia (mais autoritativa primeiro):
 *
 *   1. STOCKS_MESTRE       — `dbo.Stocks.[IVA]` enviado pelo agent rev39+
 *                            via /api/ingest/v1/products. Fonte primária
 *                            do ERP — o IVA fiscal mestre de cada artigo.
 *
 *   2. STAGING_COMPRA      — última `StagingCompraRawLine.iva` por
 *                            (farmaciaId, externalCodigoId). Reflecte o
 *                            IVA cobrado pelo fornecedor na recepção.
 *
 *   3. STAGING_DEVOLUCAO   — última `StagingDevolucaoFornecedorRawLine.iva`.
 *                            Mais raro, mas idêntico ao plano fiscal das
 *                            compras.
 *
 *   4. VENDA_DERIVADA      — taxa derivada `ivaValor/(valorLinha-ivaValor)`
 *                            por linha de venda. Tomamos a MODA por
 *                            produto×farmácia (estabiliza contra ruído
 *                            de arredondamento). Requer pelo menos 3
 *                            linhas concordantes — abaixo disso o ruído
 *                            ganha.
 *
 * Regras duras:
 *   · Normalização sempre via `normalizeIva()` → {6, 13, 23, null}
 *   · Conflito entre fontes → ganha a de prioridade mais alta
 *   · Valor que não normaliza → linha permanece sem taxa nesta passagem
 *     (não inventa nem reverte para uma fonte inferior — log apenas)
 *   · Idempotente: `recoverIvaForTenant({ apply: false })` é dry-run e
 *     `{ apply: true }` faz UPDATE em batches; correr 2× dá o mesmo
 *     resultado.
 */

import { type PrismaClient } from "@/generated/prisma/client";
import { normalizeIva, type TaxaIvaCanonica } from "@/lib/iva";

export type TaxaIvaSource =
  | "STOCKS_MESTRE"
  | "STAGING_COMPRA"
  | "STAGING_DEVOLUCAO"
  | "VENDA_DERIVADA";

export const TAXA_IVA_SOURCE_LABELS: Record<TaxaIvaSource, string> = {
  STOCKS_MESTRE: "Stocks mestre (ERP)",
  STAGING_COMPRA: "Última compra",
  STAGING_DEVOLUCAO: "Última devolução",
  VENDA_DERIVADA: "Moda das vendas",
};

/** Prioridade descrescente — STOCKS_MESTRE ganha sobre todas. */
const SOURCE_PRIORITY: TaxaIvaSource[] = [
  "STOCKS_MESTRE",
  "STAGING_COMPRA",
  "STAGING_DEVOLUCAO",
  "VENDA_DERIVADA",
];

/** Mínimo de linhas concordantes na MODA de vendas. Abaixo disso = ruído. */
const MODE_MIN_CONFIDENCE = 3;

export type RecoveryResult = {
  /** Total de linhas ProdutoFarmacia (universo activo, flagRetirado=false). */
  universo: number;
  /** Linhas que ficaram com taxa após o pipeline. */
  resolvidas: number;
  /** Linhas que ficaram NULL (IVA por apurar). */
  porApurar: number;
  /** Distribuição final por taxa canónica. */
  distribuicao: { taxa: TaxaIvaCanonica | null; n: number }[];
  /** Cobertura por farmácia. */
  porFarmacia: {
    farmaciaId: string;
    farmacia: string;
    total: number;
    resolvidas: number;
    porApurar: number;
    pct: number;
  }[];
  /** Cobertura por fonte (quantas linhas cada fonte resolveu). */
  porFonte: { source: TaxaIvaSource; n: number }[];
  /** Updates aplicados (0 em dry-run). */
  rowsUpdated: number;
};

type Candidate = {
  pfId: string;
  farmaciaId: string;
  taxa: TaxaIvaCanonica;
  source: TaxaIvaSource;
};

/**
 * Recuperador idempotente. `apply=false` (default) corre o pipeline e
 * devolve estatísticas SEM tocar na BD. `apply=true` faz UPDATE em
 * batches de 500 linhas — só quando a taxa muda ou está NULL.
 */
export async function recoverIvaForTenant(
  prisma: PrismaClient,
  options: { apply?: boolean } = {},
): Promise<RecoveryResult> {
  const apply = options.apply ?? false;

  // ── Universo: ProdutoFarmacia activos por farmácia ──────────────
  const universoRows = await prisma.$queryRawUnsafe<
    Array<{ id: string; farmaciaId: string; farmacia: string }>
  >(`
    SELECT pf.id, pf."farmaciaId", f.nome AS farmacia
    FROM "ProdutoFarmacia" pf
    JOIN "Farmacia" f ON f.id = pf."farmaciaId"
    WHERE pf."flagRetirado" = false
  `);
  const universoMap = new Map(universoRows.map((r) => [r.id, r]));
  const universo = universoRows.length;

  // ── Fonte 1: STOCKS_MESTRE (taxa já persistida com source=...) ──
  // Já está em ProdutoFarmacia.taxaIvaPercent + source. Não tocamos
  // nessas linhas a não ser que outra fonte de prioridade superior
  // apareça — mas STOCKS_MESTRE é a #1, logo nunca é sobrescrito.
  const mestreRows = await prisma.$queryRawUnsafe<
    Array<{ id: string; farmaciaId: string; taxaIvaPercent: number }>
  >(`
    SELECT id, "farmaciaId", "taxaIvaPercent"
    FROM "ProdutoFarmacia"
    WHERE "flagRetirado" = false
      AND "taxaIvaSource" = 'STOCKS_MESTRE'
      AND "taxaIvaPercent" IN (6, 13, 23)
  `);
  const candidates = new Map<string, Candidate>();
  for (const r of mestreRows) {
    candidates.set(r.id, {
      pfId: r.id,
      farmaciaId: r.farmaciaId,
      taxa: r.taxaIvaPercent as TaxaIvaCanonica,
      source: "STOCKS_MESTRE",
    });
  }

  // ── Fonte 2: STAGING_COMPRA (última compra por produto×farm) ────
  const comprasRows = await prisma.$queryRawUnsafe<
    Array<{ pfId: string; farmaciaId: string; taxa: string }>
  >(`
    SELECT DISTINCT ON (pf.id)
      pf.id AS "pfId",
      pf."farmaciaId",
      scrl.iva::text AS taxa
    FROM "ProdutoFarmacia" pf
    JOIN "StagingCompraRawLine" scrl
      ON scrl."farmaciaId" = pf."farmaciaId"
     AND scrl."externalCodigoId" = pf."externalProductId"
    WHERE pf."flagRetirado" = false
    ORDER BY pf.id, scrl."externalLineId" DESC
  `);
  for (const r of comprasRows) {
    const taxa = normalizeIva(Number(r.taxa));
    if (taxa === null) continue;
    if (!candidates.has(r.pfId)) {
      candidates.set(r.pfId, {
        pfId: r.pfId,
        farmaciaId: r.farmaciaId,
        taxa,
        source: "STAGING_COMPRA",
      });
    }
  }

  // ── Fonte 3: STAGING_DEVOLUCAO ──────────────────────────────────
  const devsRows = await prisma.$queryRawUnsafe<
    Array<{ pfId: string; farmaciaId: string; taxa: string }>
  >(`
    SELECT DISTINCT ON (pf.id)
      pf.id AS "pfId",
      pf."farmaciaId",
      sd.iva::text AS taxa
    FROM "ProdutoFarmacia" pf
    JOIN "StagingDevolucaoFornecedorRawLine" sd
      ON sd."farmaciaId" = pf."farmaciaId"
     AND sd."externalCodigoId" = pf."externalProductId"
    WHERE pf."flagRetirado" = false
    ORDER BY pf.id, sd."externalLineId" DESC
  `);
  for (const r of devsRows) {
    const taxa = normalizeIva(Number(r.taxa));
    if (taxa === null) continue;
    if (!candidates.has(r.pfId)) {
      candidates.set(r.pfId, {
        pfId: r.pfId,
        farmaciaId: r.farmaciaId,
        taxa,
        source: "STAGING_DEVOLUCAO",
      });
    }
  }

  // ── Fonte 4: VENDA_DERIVADA (MODA por produto×farm) ─────────────
  // Não usamos "última linha" porque o ivaValor está em 2 casas dec.
  // e a base pode ser pequena → taxa derivada com ruído (ex.: 5.83%).
  // A moda das taxas normalizadas estabiliza isto.
  const vendasRows = await prisma.$queryRawUnsafe<
    Array<{ pfId: string; farmaciaId: string; taxa: string; n: bigint }>
  >(`
    WITH derived AS (
      SELECT
        pf.id AS "pfId",
        pf."farmaciaId",
        ROUND(
          (ivlr."ivaValor" / NULLIF(ivlr."valorLinha" - ivlr."ivaValor", 0) * 100)::numeric,
          2
        ) AS taxa_raw
      FROM "ProdutoFarmacia" pf
      JOIN "IngestVendaLinhaRaw" ivlr
        ON ivlr."produtoId" = pf."produtoId"
       AND ivlr."farmaciaId" = pf."farmaciaId"
      WHERE pf."flagRetirado" = false
        AND ivlr."ivaValor" > 0
        AND ivlr."valorLinha" > ivlr."ivaValor"
        AND ivlr."isNonStockService" = false
    ),
    grouped AS (
      SELECT
        "pfId",
        "farmaciaId",
        taxa_raw::text AS taxa,
        COUNT(*)::bigint AS n,
        ROW_NUMBER() OVER (PARTITION BY "pfId" ORDER BY COUNT(*) DESC) AS rn
      FROM derived
      WHERE taxa_raw IS NOT NULL
      GROUP BY 1, 2, 3
    )
    SELECT "pfId", "farmaciaId", taxa, n
    FROM grouped
    WHERE rn = 1 AND n >= ${MODE_MIN_CONFIDENCE}
  `);
  for (const r of vendasRows) {
    const taxa = normalizeIva(Number(r.taxa));
    if (taxa === null) continue;
    if (!candidates.has(r.pfId)) {
      candidates.set(r.pfId, {
        pfId: r.pfId,
        farmaciaId: r.farmaciaId,
        taxa,
        source: "VENDA_DERIVADA",
      });
    }
  }

  // ── Estatísticas ────────────────────────────────────────────────
  const distMap = new Map<TaxaIvaCanonica | "APURAR", number>();
  const porFarmaciaMap = new Map<
    string,
    { farmaciaId: string; farmacia: string; total: number; resolvidas: number }
  >();
  const porFonteMap = new Map<TaxaIvaSource, number>();

  for (const pf of universoRows) {
    const cand = candidates.get(pf.id);
    const key: TaxaIvaCanonica | "APURAR" = cand?.taxa ?? "APURAR";
    distMap.set(key, (distMap.get(key) ?? 0) + 1);
    if (cand) {
      porFonteMap.set(cand.source, (porFonteMap.get(cand.source) ?? 0) + 1);
    }
    const fkey = pf.farmaciaId;
    if (!porFarmaciaMap.has(fkey)) {
      porFarmaciaMap.set(fkey, {
        farmaciaId: fkey,
        farmacia: pf.farmacia,
        total: 0,
        resolvidas: 0,
      });
    }
    const fagg = porFarmaciaMap.get(fkey)!;
    fagg.total++;
    if (cand) fagg.resolvidas++;
  }

  const resolvidas = candidates.size;
  const porApurar = universo - resolvidas;

  const distribuicao: { taxa: TaxaIvaCanonica | null; n: number }[] = [
    { taxa: 6, n: distMap.get(6) ?? 0 },
    { taxa: 13, n: distMap.get(13) ?? 0 },
    { taxa: 23, n: distMap.get(23) ?? 0 },
    { taxa: null, n: distMap.get("APURAR") ?? 0 },
  ];

  const porFarmacia = Array.from(porFarmaciaMap.values())
    .map((f) => ({
      ...f,
      porApurar: f.total - f.resolvidas,
      pct: f.total > 0 ? Math.round((f.resolvidas / f.total) * 1000) / 10 : 0,
    }))
    .sort((a, b) => a.farmacia.localeCompare(b.farmacia, "pt-PT"));

  const porFonte = SOURCE_PRIORITY.map((source) => ({
    source,
    n: porFonteMap.get(source) ?? 0,
  }));

  // ── APPLY: UPDATE em batches por (taxa, source) ─────────────────
  let rowsUpdated = 0;
  if (apply) {
    rowsUpdated = await applyCandidates(prisma, candidates, universoMap);
  }

  return {
    universo,
    resolvidas,
    porApurar,
    distribuicao,
    porFarmacia,
    porFonte,
    rowsUpdated,
  };
}

/**
 * Aplica as candidaturas em batches. Só faz UPDATE quando a taxa muda
 * (idempotente: dois runs consecutivos produzem 0 updates no segundo).
 * STOCKS_MESTRE não é tocado pelo recuperador — esse vem do agent.
 */
async function applyCandidates(
  prisma: PrismaClient,
  candidates: Map<string, Candidate>,
  universoMap: Map<string, { id: string; farmaciaId: string; farmacia: string }>,
): Promise<number> {
  // Agrupar por (taxa, source) para fazer um UPDATE por grupo
  type Group = { taxa: TaxaIvaCanonica; source: TaxaIvaSource; ids: string[] };
  const groups = new Map<string, Group>();
  for (const c of candidates.values()) {
    if (c.source === "STOCKS_MESTRE") continue; // não tocamos no que veio do agent
    if (!universoMap.has(c.pfId)) continue;
    const k = `${c.taxa}:${c.source}`;
    if (!groups.has(k)) {
      groups.set(k, { taxa: c.taxa, source: c.source, ids: [] });
    }
    groups.get(k)!.ids.push(c.pfId);
  }

  let total = 0;
  for (const g of groups.values()) {
    // Em chunks de 500 para não rebentar parameter limits do PG.
    for (let i = 0; i < g.ids.length; i += 500) {
      const chunk = g.ids.slice(i, i + 500);
      const updated = await prisma.$executeRawUnsafe(
        `UPDATE "ProdutoFarmacia"
         SET "taxaIvaPercent" = $1,
             "taxaIvaSource" = $2,
             "taxaIvaUpdatedAt" = now()
         WHERE id = ANY($3)
           AND (
             "taxaIvaPercent" IS DISTINCT FROM $1
             OR "taxaIvaSource" IS DISTINCT FROM $2
           )`,
        g.taxa,
        g.source,
        chunk,
      );
      total += updated;
    }
  }
  return total;
}
