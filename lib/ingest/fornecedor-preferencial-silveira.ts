/**
 * lib/ingest/fornecedor-preferencial-silveira.ts
 *
 * Preenchimento de `ProdutoFarmacia.fornecedorHabitualId` (FK real a
 * `Fornecedor`) a partir do fornecedor habitual reportado pelo ERP —
 * EXCLUSIVO do tenant silveira (gate no caller, ver
 * `TENANT_CATALOGO_MASSA` em `lib/tenant-context.ts`).
 *
 * Distinto de `ProdutoFarmacia.fornecedorOrigem` (texto livre, já escrito
 * por `lib/ingest/bulk.ts` para TODOS os tenants, com COALESCE — nunca
 * reescrito depois de preenchido) — este campo é só um histórico
 * informativo sem FK. `fornecedorHabitualId` é a escolha PREFERENCIAL real,
 * usada como sugestão inicial de fornecedor por linha nas encomendas
 * (ver `lib/encomendas/proposal.ts`).
 *
 * Regra de escrita: resolve/cria o Fornecedor por
 * `resolverOuCriarFornecedor` (id/nome exacto/alias inequívoco, senão
 * cria); escreve `fornecedorHabitualId` SÓ quando está `null` — uma vez
 * definido (por este caminho ou por manutenção em massa/decisão manual),
 * o ERP nunca mais o sobrescreve automaticamente. Nomes ambíguos (mais do
 * que um Fornecedor por alias) não escrevem nada e ficam reportados.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { resolverOuCriarFornecedor } from "@/lib/catalogo/resolver-fornecedor";

export type FornecedorPreferencialRow = {
  cnp: number;
  fornecedorNome: string | null;
};

export type FornecedorPreferencialResult = {
  candidatos: number;
  preenchidos: number;
  /** Já tinha fornecedorHabitualId definido — preservado sem tocar. */
  preservados: number;
  ambiguos: number;
  cnpNaoEncontrado: number;
};

/**
 * `cnpToProdutoId` é passado pelo caller (já resolvido no mesmo ciclo de
 * bootstrap, ver bulkUpsertProdutosByCnp) para evitar uma segunda consulta
 * de produtos por CNP.
 */
export async function applyFornecedorPreferencialSilveira(
  prisma: PrismaClient,
  rows: FornecedorPreferencialRow[],
  farmaciaId: string,
  cnpToProdutoId: Map<number, string>,
): Promise<FornecedorPreferencialResult> {
  const res: FornecedorPreferencialResult = {
    candidatos: 0,
    preenchidos: 0,
    preservados: 0,
    ambiguos: 0,
    cnpNaoEncontrado: 0,
  };

  const uteis = rows.filter((r) => r.fornecedorNome && r.fornecedorNome.trim().length > 0);
  if (uteis.length === 0) return res;
  res.candidatos = uteis.length;

  const produtoIds = uteis
    .map((r) => cnpToProdutoId.get(r.cnp))
    .filter((id): id is string => !!id);
  if (produtoIds.length === 0) {
    res.cnpNaoEncontrado = uteis.length;
    return res;
  }

  const existentes = await prisma.produtoFarmacia.findMany({
    where: { produtoId: { in: produtoIds }, farmaciaId },
    select: { id: true, produtoId: true, fornecedorHabitualId: true },
  });
  const pfPorProduto = new Map(existentes.map((pf) => [pf.produtoId, pf]));

  for (const row of uteis) {
    const produtoId = cnpToProdutoId.get(row.cnp);
    if (!produtoId) {
      res.cnpNaoEncontrado++;
      continue;
    }
    const pf = pfPorProduto.get(produtoId);
    if (pf?.fornecedorHabitualId) {
      res.preservados++;
      continue;
    }

    const resolvido = await resolverOuCriarFornecedor(prisma, row.fornecedorNome, {
      criarSeInexistente: true,
    });
    if (resolvido.status === "ambiguo") {
      res.ambiguos++;
      continue;
    }
    if (resolvido.status === "invalido") {
      continue;
    }

    await prisma.produtoFarmacia.upsert({
      where: { produtoId_farmaciaId: { produtoId, farmaciaId } },
      create: { produtoId, farmaciaId, fornecedorHabitualId: resolvido.fornecedorId },
      update: { fornecedorHabitualId: resolvido.fornecedorId },
    });
    res.preenchidos++;
  }

  return res;
}
