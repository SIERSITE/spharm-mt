/**
 * lib/aggregate/resolve-produto.ts
 *
 * REGRA CANÓNICA de resolução `(farmaciaId, externalProductId) → produtoId`.
 *
 * Problema (FASE B): `externalProductId` (CodigoID do ERP) NÃO é único por
 * farmácia — o ERP recicla o código entre CNPs ao longo do tempo. Em
 * grupo-silveira, 5.145 códigos mapeiam ≥2 produtos canónicos (Silveirense
 * 21,6% dos códigos). A resolução antiga (`Map` last-wins em JS, ou
 * `UPDATE ... FROM ProdutoFarmacia` com múltiplos matches) era
 * NÃO-determinística → atribuição silenciosamente errada e irreproduzível.
 *
 * Esta regra escolhe UM produtoId por código, DETERMINÍSTICA e reproduzível,
 * preferindo o "significado actual" do código:
 *
 *   1. flagRetirado ASC          — activo antes de retirado
 *   2. dataUltimaVenda DESC      — vendido mais recentemente (sinal mais forte)
 *   3. stockAtual DESC           — mais stock = mais provável ser o actual
 *   4. produtoId ASC             — desempate estável (arbitrário mas REPRODUZÍVEL)
 *
 * NÃO altera dados armazenados — é resolução em tempo de query. Usada por:
 *   · agregação compras/devoluções (CTEs)
 *   · bootstrap/stock + sales-lines (resolveProdutoIdMap)
 *   · reprocess-ingest-produto-mapping (resolvedPfCteAll)
 */
import { Prisma, type PrismaClient } from "@/generated/prisma/client";

export const CANONICAL_RESOLUTION_RULE =
  "flagRetirado ASC, dataUltimaVenda DESC NULLS LAST, stockAtual DESC NULLS LAST, produtoId ASC";

/** Cauda ORDER BY canónica (tabela aliased `pf`). Reutilizada em todas as queries. */
const CANONICAL_ORDER_TAIL = Prisma.sql`pf."flagRetirado" ASC, pf."dataUltimaVenda" DESC NULLS LAST, pf."stockAtual" DESC NULLS LAST, pf."produtoId" ASC`;

/**
 * CTE `resolved_pf` (1 produtoId por código) para UMA farmácia. Usar como:
 * `Prisma.sql\`WITH ${resolvedPfCte(id)}, ... \``.
 */
export function resolvedPfCte(farmaciaId: string): Prisma.Sql {
  return Prisma.sql`
    resolved_pf AS (
      SELECT DISTINCT ON (pf."farmaciaId", pf."externalProductId")
        pf."farmaciaId", pf."externalProductId", pf."produtoId"
      FROM "ProdutoFarmacia" pf
      WHERE pf."farmaciaId" = ${farmaciaId} AND pf."externalProductId" IS NOT NULL
      ORDER BY pf."farmaciaId", pf."externalProductId", ${CANONICAL_ORDER_TAIL}
    )`;
}

/**
 * CTE `resolved_pf` para TODAS as farmácias do tenant (sem filtro). Usado
 * pelo reprocess (corre per-tenant). Nome da CTE: `resolved_pf`.
 */
export function resolvedPfCteAll(): Prisma.Sql {
  return Prisma.sql`
    resolved_pf AS (
      SELECT DISTINCT ON (pf."farmaciaId", pf."externalProductId")
        pf."farmaciaId", pf."externalProductId", pf."produtoId"
      FROM "ProdutoFarmacia" pf
      WHERE pf."externalProductId" IS NOT NULL
      ORDER BY pf."farmaciaId", pf."externalProductId", ${CANONICAL_ORDER_TAIL}
    )`;
}

/**
 * Map `externalProductId → produtoId` canónico para um conjunto de códigos
 * de UMA farmácia. Substitui o `findMany` + Map last-wins dos endpoints
 * bootstrap/stock e sales-lines (determinístico).
 */
export async function resolveProdutoIdMap(
  prisma: Pick<PrismaClient, "$queryRaw">,
  farmaciaId: string,
  externalIds: number[],
): Promise<Map<number, string>> {
  if (externalIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<Array<{ externalProductId: number; produtoId: string }>>(Prisma.sql`
    SELECT DISTINCT ON (pf."externalProductId")
      pf."externalProductId", pf."produtoId"
    FROM "ProdutoFarmacia" pf
    WHERE pf."farmaciaId" = ${farmaciaId} AND pf."externalProductId" = ANY(${externalIds})
    ORDER BY pf."externalProductId", ${CANONICAL_ORDER_TAIL}
  `);
  const m = new Map<number, string>();
  for (const r of rows) m.set(Number(r.externalProductId), r.produtoId);
  return m;
}
