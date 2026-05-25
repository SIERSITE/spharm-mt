/**
 * lib/aggregate/resolve-produto.ts
 *
 * REGRA CANÓNICA de resolução `(farmaciaId, externalProductId) → produtoId`.
 *
 * Problema (FASE B): `externalProductId` (CodigoID do ERP) NÃO é único por
 * farmácia — o ERP recicla o código entre CNPs ao longo do tempo. Em
 * grupo-silveira, 5.145 códigos mapeiam ≥2 produtos canónicos (Silveirense
 * 21,6% dos códigos). A resolução antiga (`Map` last-wins em JS) era
 * NÃO-determinística (dependia da ordem de carregamento) → atribuição
 * silenciosamente errada e irreproduzível.
 *
 * Esta CTE escolhe UM produtoId por código, de forma DETERMINÍSTICA e
 * reproduzível, preferindo o produto que é "o significado actual" do código:
 *
 *   1. flagRetirado ASC          — activo antes de retirado
 *   2. dataUltimaVenda DESC      — vendido mais recentemente (sinal mais forte:
 *                                  desambigua ~43% dos grupos no piloto)
 *   3. stockAtual DESC           — mais stock = mais provável ser o actual
 *   4. produtoId ASC             — desempate estável (≈19% dos grupos caem aqui;
 *                                  arbitrário mas REPRODUZÍVEL)
 *
 * NÃO altera dados armazenados — é resolução em tempo de agregação. Para
 * tornar stock/vendas consistentes com este critério é preciso o rollout
 * descrito em notes/ (aplicar a bootstrap/stock + sales-lines + reprocess).
 */
import { Prisma } from "@/generated/prisma/client";

export const CANONICAL_RESOLUTION_RULE =
  "flagRetirado ASC, dataUltimaVenda DESC NULLS LAST, stockAtual DESC NULLS LAST, produtoId ASC";

/**
 * Devolve o corpo da CTE `resolved_pf` (1 produtoId por código) para a
 * farmácia dada. Usar como: `Prisma.sql\`WITH ${resolvedPfCte(id)}, ... \``.
 */
export function resolvedPfCte(farmaciaId: string): Prisma.Sql {
  return Prisma.sql`
    resolved_pf AS (
      SELECT DISTINCT ON (pf."farmaciaId", pf."externalProductId")
        pf."farmaciaId", pf."externalProductId", pf."produtoId"
      FROM "ProdutoFarmacia" pf
      WHERE pf."farmaciaId" = ${farmaciaId} AND pf."externalProductId" IS NOT NULL
      ORDER BY pf."farmaciaId", pf."externalProductId",
        pf."flagRetirado" ASC,
        pf."dataUltimaVenda" DESC NULLS LAST,
        pf."stockAtual" DESC NULLS LAST,
        pf."produtoId" ASC
    )`;
}
