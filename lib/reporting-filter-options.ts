/**
 * lib/reporting-filter-options.ts
 *
 * Universo LEVE e PARTILHADO das opções dos filtros de relatórios.
 * Usado por Vendas, Devoluções, Transferências, Excessos e Encomendas
 * no server component no open da página. NÃO lê linhas pesadas —
 * apenas DISTINCTs sobre tabelas pequenas (ProdutoFarmacia, Fabricante,
 * Classificacao).
 *
 * Separação explícita vs getXxxData:
 *   · getXxxData                  → linhas do relatório (pesado, lazy)
 *   · getReportingFilterOptions   → opções dos dropdowns (leve, eager)
 *
 * Regra de categoria: para o dropdown do filtro, devolvemos o nível
 * PAI (categoria canónica + categoriaOrigem do importer, mergido em
 * DISTINCT). Subcategorias não aparecem no filtro por escolha — o
 * filtro passa pela categoria principal, a apresentação nas linhas
 * mostra ambas.
 */

import { getPrisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";

export type ReportingFilterOptions = {
  fornecedores: string[];
  fabricantes: string[];
  categorias: string[];
};

function cleanSortUnique(values: Array<string | null | undefined>): string[] {
  const set = new Set<string>();
  for (const v of values) {
    const s = (v ?? "").trim();
    if (s) set.add(s);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, "pt-PT"));
}

export async function getReportingFilterOptions(): Promise<ReportingFilterOptions> {
  const prisma = await getPrisma();
  const farmacias = await prisma.farmacia.findMany({
    where: { estado: "ATIVO", nome: { not: "Farmácia Teste" } },
    select: { id: true },
  });
  const farmaciaIds = farmacias.map((f) => f.id);
  if (farmaciaIds.length === 0) {
    return { fornecedores: [], fabricantes: [], categorias: [] };
  }

  // Fornecedores distintos a partir de ProdutoFarmacia.fornecedorOrigem
  // — DISTINCT ao nível da BD, barato.
  const fornecedorRows = await prisma.$queryRaw<Array<{ nome: string | null }>>(
    Prisma.sql`
      SELECT DISTINCT "fornecedorOrigem" AS nome
      FROM "ProdutoFarmacia"
      WHERE "flagRetirado" = false
        AND "farmaciaId" = ANY(${farmaciaIds})
        AND "fornecedorOrigem" IS NOT NULL
    `
  );

  // Fabricantes canónicos: apenas os que estão associados a pelo menos
  // um Produto. Não queremos mostrar fabricantes órfãos no dropdown.
  const fabricanteRows = await prisma.$queryRaw<Array<{ nome: string | null }>>(
    Prisma.sql`
      SELECT DISTINCT fab."nomeNormalizado" AS nome
      FROM "Fabricante" fab
      JOIN "Produto" p ON p."fabricanteId" = fab.id
      WHERE fab.estado = 'ATIVO'
    `
  );

  // Categorias: união entre Classificacao.nome (nível 1 / pai canónico)
  // e ProdutoFarmacia.categoriaOrigem (fallback do importer). Mesma
  // ordem de precedência que lib/categoria-resolver.ts resolve por
  // linha — aqui só unificamos os universos.
  const categoriaRows = await prisma.$queryRaw<Array<{ nome: string | null }>>(
    Prisma.sql`
      SELECT DISTINCT nome FROM (
        SELECT c.nome AS nome
        FROM "Classificacao" c
        JOIN "Produto" p ON p."classificacaoNivel1Id" = c.id
        UNION
        SELECT pf."categoriaOrigem" AS nome
        FROM "ProdutoFarmacia" pf
        WHERE pf."flagRetirado" = false
          AND pf."farmaciaId" = ANY(${farmaciaIds})
          AND pf."categoriaOrigem" IS NOT NULL
      ) t
    `
  );

  return {
    fornecedores: cleanSortUnique(fornecedorRows.map((r) => r.nome)),
    fabricantes: cleanSortUnique(fabricanteRows.map((r) => r.nome)),
    categorias: cleanSortUnique(categoriaRows.map((r) => r.nome)),
  };
}
