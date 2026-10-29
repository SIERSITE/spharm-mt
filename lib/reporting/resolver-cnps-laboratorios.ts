/**
 * lib/reporting/resolver-cnps-laboratorios.ts
 *
 * Selecção do filtro "Laboratório ou grupo" -> CNP dos produtos. Já NÃO é o caminho normal das listas operacionais
 * (Excessos, Transferências, Devoluções resolvem o grupo localmente — ver `construirEstadoFiltroLaboratorio`); fica
 * como CAMINHO DE RESERVA do hook `useFiltroLaboratorio` (quando a página não trouxe a pertença) e como contrato de
 * teste. Reutiliza `resolverProdutoIdsPorLaboratoriosSelecionados` (o resolvedor de Vendas/Margens/Inventário) — uma só
 * regra de "o que é um grupo" — e só acrescenta a passagem produtoId -> cnp. Aceita os valores tipados
 * (`grupo:`/`fabricante:`) e os nomes soltos antigos (caminho legado do resolvedor).
 *
 * Nº de queries: o do resolvedor (1 por tipo de valor presente) + UMA para os CNP (`id = ANY($1)`, sem lotes: o
 * número de queries não cresce com o número de produtos).
 */
import { Prisma } from "@/generated/prisma/client";
import type { PrismaClient } from "@/generated/prisma/client";
import { resolverProdutoIdsPorLaboratoriosSelecionados } from "@/lib/reporting/resolver-laboratorio-selecionado";

type PrismaCnps = Parameters<typeof resolverProdutoIdsPorLaboratoriosSelecionados>[0] & Pick<PrismaClient, "$queryRaw">;

export async function resolverCnpsPorLaboratoriosSelecionados(
  prisma: PrismaCnps,
  valoresSelecionados: readonly string[],
  resolverTenant?: () => Promise<string | null>,
): Promise<string[]> {
  const ids = await resolverProdutoIdsPorLaboratoriosSelecionados(prisma, valoresSelecionados, resolverTenant);
  if (ids.length === 0) return [];
  const rows = await prisma.$queryRaw<Array<{ cnp: number }>>(
    Prisma.sql`SELECT DISTINCT cnp FROM "Produto" WHERE id = ANY(${ids}) ORDER BY cnp`,
  );
  return rows.map((r) => String(r.cnp));
}
