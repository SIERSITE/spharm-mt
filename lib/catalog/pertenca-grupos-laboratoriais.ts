/**
 * lib/catalog/pertenca-grupos-laboratoriais.ts
 *
 * Pertença «grupo laboratorial -> CNP dos produtos», num só SELECT, para as listas operacionais do Garantia (Excessos,
 * Transferências, Devoluções) filtrarem por grupo no CLIENTE, sem ir ao servidor a cada alteração da selecção.
 *
 * O critério é o MESMO de Vendas/Margens/Inventário (`resolverProdutoIdsPorLaboratoriosSelecionados`): um produto
 * pertence ao grupo quando tem a linha `ProdutoGrupoLaboratorial` desse grupo (fabricante membro, regra CNP validada,
 * alias inequívoco ou prova manual). O CNP é só a chave com que a linha da lista identifica o produto — nunca o
 * critério de pertença. Só leitura; sem `server-only` para ser testável com `tsx`.
 *
 * Tamanho: uma entrada por produto classificado (não por produto do catálogo); os CNP vão ordenados e sem repetidos,
 * por isso o resultado é determinístico e estável entre chamadas.
 */
import { Prisma } from "@/generated/prisma/client";
import type { PrismaClient } from "@/generated/prisma/client";

export type PertencaGruposPorCnp = Record<string, string[]>;

type PrismaPertenca = Pick<PrismaClient, "$queryRaw">;

export async function carregarPertencaGruposPorCnp(prisma: PrismaPertenca): Promise<PertencaGruposPorCnp> {
  const rows = await prisma.$queryRaw<Array<{ grupoId: string; cnp: number }>>(Prisma.sql`
    SELECT DISTINCT pgl."grupoLaboratorialId" AS "grupoId", p.cnp AS cnp
      FROM "ProdutoGrupoLaboratorial" pgl
      JOIN "GrupoLaboratorial" g ON g.id = pgl."grupoLaboratorialId" AND g.estado = 'ATIVO'
      JOIN "Produto" p ON p.id = pgl."produtoId"
     ORDER BY 1, 2
  `);
  const porGrupo: PertencaGruposPorCnp = {};
  for (const r of rows) (porGrupo[r.grupoId] ??= []).push(String(r.cnp));
  return porGrupo;
}
