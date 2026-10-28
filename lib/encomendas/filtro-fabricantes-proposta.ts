/**
 * lib/encomendas/filtro-fabricantes-proposta.ts
 *
 * Como o filtro "Fabricantes" da proposta de Encomenda nova se traduz em SQL.
 *
 *   · Fora de garantia: lista de NOMES de fabricante (`Fabricante.nomeNormalizado`) — comportamento de sempre.
 *   · Garantia: os valores são `grupo:<id>` / `fabricante:<id>` (ou nomes soltos antigos, incl. o nome de um grupo) e
 *     resolvem-se para `Produto.id` com o MESMO resolvedor de Vendas/Margens/Inventário — comparar com o nome legal
 *     do fabricante da linha nunca devolvia nada para um grupo.
 *
 * Sem `server-only`: testável com `tsx`. O tenant é injectável só para testes.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { gruposLaboratoriaisAtivos } from "@/lib/tenant-constants";
import { resolveCurrentTenantSlug } from "@/lib/tenant-context";
import { resolverProdutoIdsPorLaboratoriosSelecionados } from "@/lib/reporting/resolver-laboratorio-selecionado";

export type FiltroFabricantesProposta =
  | { modo: "nomes"; nomes: string[] }
  | { modo: "produtos"; produtoIds: string[] };

type PrismaFiltro = Parameters<typeof resolverProdutoIdsPorLaboratoriosSelecionados>[0] & Pick<PrismaClient, "produto">;

export async function resolverFiltroFabricantesProposta(
  prisma: PrismaFiltro,
  fabricantes: readonly string[] | undefined,
  resolverTenant: () => Promise<string | null> = resolveCurrentTenantSlug,
): Promise<FiltroFabricantesProposta | null> {
  if (!fabricantes || fabricantes.length === 0) return null;
  const tenantSlug = await resolverTenant();
  if (!gruposLaboratoriaisAtivos(tenantSlug)) return { modo: "nomes", nomes: [...fabricantes] };
  const produtoIds = await resolverProdutoIdsPorLaboratoriosSelecionados(prisma, fabricantes, async () => tenantSlug);
  return { modo: "produtos", produtoIds };
}
