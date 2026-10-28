/**
 * lib/reporting/resolver-cnps-laboratorios.ts
 *
 * Selecção do filtro "Laboratório ou grupo" -> CNP dos produtos, para as listas operacionais que filtram linhas já
 * carregadas no cliente (Excessos, Transferências, Devoluções, Encomendas). Reutiliza
 * `resolverProdutoIdsPorLaboratoriosSelecionados` (o resolvedor de Vendas/Margens/Inventário) — uma só regra de
 * "o que é um grupo" — e só acrescenta a passagem produtoId -> cnp. Aceita os valores tipados (`grupo:`/`fabricante:`)
 * e os nomes soltos antigos (caminho legado do resolvedor).
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { resolverProdutoIdsPorLaboratoriosSelecionados } from "@/lib/reporting/resolver-laboratorio-selecionado";

type PrismaCnps = Parameters<typeof resolverProdutoIdsPorLaboratoriosSelecionados>[0] & Pick<PrismaClient, "produto">;

const LOTE = 5_000;

export async function resolverCnpsPorLaboratoriosSelecionados(
  prisma: PrismaCnps,
  valoresSelecionados: readonly string[],
  resolverTenant?: () => Promise<string | null>,
): Promise<string[]> {
  const ids = await resolverProdutoIdsPorLaboratoriosSelecionados(prisma, valoresSelecionados, resolverTenant);
  const cnps = new Set<string>();
  for (let i = 0; i < ids.length; i += LOTE) {
    const produtos = await prisma.produto.findMany({ where: { id: { in: ids.slice(i, i + LOTE) } }, select: { cnp: true } });
    for (const p of produtos) cnps.add(String(p.cnp));
  }
  return [...cnps];
}
