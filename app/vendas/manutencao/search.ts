"use server";

/**
 * app/vendas/manutencao/search.ts
 *
 * Pesquisa de produto para a Manutenção de Vendas — todo o catálogo do
 * tenant, NUNCA scoped a uma farmácia (ao contrário de
 * `app/encomendas/nova/search.ts`): uma manutenção reparte por TODAS as
 * farmácias, não é operação de uma farmácia só.
 */
import { getPrisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/permissions";
import { construirCondicaoPesquisa } from "@/lib/reporting/pesquisa-produto";
import { Prisma } from "@/generated/prisma/client";

export type ManutencaoProdutoHit = {
  id: string;
  cnp: number;
  designacao: string;
  fabricante: string | null;
};

const MAX_LIMIT = 20;

export async function pesquisarProdutosManutencaoAction(
  query: string,
): Promise<ManutencaoProdutoHit[]> {
  await requirePermission("reports.write");

  const q = query.trim();
  if (q.length < 2) return [];

  const prisma = await getPrisma();
  const condicao = construirCondicaoPesquisa(q);
  if (condicao === Prisma.empty) return [];

  const rows = await prisma.$queryRaw<
    { id: string; cnp: number; designacao: string; fabricante: string | null }[]
  >`
    SELECT p."id", p."cnp", p."designacao", f."nomeNormalizado" AS fabricante
    FROM "Produto" p
    LEFT JOIN "Fabricante" f ON f."id" = p."fabricanteId"
    WHERE 1 = 1 ${condicao}
    ORDER BY p."designacao" ASC
    LIMIT ${MAX_LIMIT}
  `;
  return rows;
}
