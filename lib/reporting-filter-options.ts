/**
 * lib/reporting-filter-options.ts
 *
 * Universo LEVE e PARTILHADO das opções dos filtros de relatórios.
 * Usado por Vendas, Devoluções, Transferências, Excessos e Encomendas.
 *
 * Mudanças pós-auditoria (abril 2026):
 *  · `categorias` passa a ser ESTRITAMENTE canónico — deriva de `Classificacao`
 *    (NIVEL_1) e nunca mais faz UNION com `ProdutoFarmacia.categoriaOrigem`
 *    (texto bruto do ERP, não-fiável).
 *  · `distribuidores` é o nome correcto para o universo de grossistas
 *    (OCP, Alliance, Empifarma, Plural, …) — vem de `ProdutoFarmacia.fornecedorOrigem`.
 *    `fornecedores` é mantido como alias deprecated para não quebrar consumidores
 *    pré-existentes; novos consumidores usam `distribuidores`.
 *  · `fabricantes` continua como fabricantes/laboratórios canónicos
 *    (Bayer, Bial, Pfizer, …) via `Fabricante.nomeNormalizado`.
 *  · `semClassificacao` indica se há produtos sem classificação — a UI deve
 *    expor isto como FILTRO BOOLEANO ("apenas sem classificação") e nunca
 *    como uma categoria entre as outras. "Por Classificar" / "Em Revisão" /
 *    "Sem Match" são estados de workflow, não categorias.
 *
 * Separação explícita vs getXxxData:
 *   · getXxxData                  → linhas do relatório (pesado, lazy)
 *   · getReportingFilterOptions   → opções dos dropdowns (leve, eager)
 */

import { getPrisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";

export type ReportingFilterOptions = {
  /**
   * Distribuidores / grossistas habituais da farmácia (OCP, Alliance,
   * Empifarma, Plural). Vem de `ProdutoFarmacia.fornecedorOrigem` (texto
   * livre do importer ERP). NÃO é fabricante.
   */
  distribuidores: string[];
  /** @deprecated Use `distribuidores`. Mantido por compatibilidade. */
  fornecedores: string[];
  /**
   * Fabricantes / laboratórios canónicos (Bayer, Bial, Pfizer, …).
   * Vem de `Fabricante.nomeNormalizado` (canon, com aliases).
   */
  fabricantes: string[];
  /**
   * Categorias canónicas (`Classificacao` NIVEL_1 estado=ATIVO). NUNCA
   * inclui texto bruto vindo de `ProdutoFarmacia.categoriaOrigem`.
   * NUNCA inclui rótulos técnicos/transitórios — esses são estados de
   * workflow expostos por `semClassificacao` (boolean).
   */
  categorias: string[];
  /**
   * Subcategorias canónicas (`Classificacao` NIVEL_2 estado=ATIVO), com o
   * nome do pai para desambiguar homónimos entre categorias diferentes.
   *
   * Nível 2 é um nível DIFERENTE, não uma versão fina do nível 1: até
   * 2026-08 três módulos punham o nível 2 num campo chamado `categoria` e
   * comparavam-no com esta lista de nível 1 — o filtro só acertava em
   * produtos sem nível 2.
   */
  subcategorias: Array<{ nome: string; categoria: string }>;
  /**
   * Utilizações clínicas com produto associado. `slug` é a chave (estável
   * entre bases); `nome` é o que se mostra. Ex.: `dor-e-febre` / "Dor e
   * febre".
   */
  utilizacoes: Array<{ slug: string; nome: string }>;
  /**
   * Sinalização de que existem produtos sem classificação canónica.
   * A UI deve oferecer um filtro booleano dedicado ("apenas sem
   * classificação") em vez de injectar uma categoria fictícia.
   */
  semClassificacao: boolean;
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
    return {
      distribuidores: [],
      fornecedores: [],
      fabricantes: [],
      categorias: [],
      subcategorias: [],
      utilizacoes: [],
      semClassificacao: false,
    };
  }

  // Distribuidores (grossistas): DISTINCT em ProdutoFarmacia.fornecedorOrigem.
  // Mantém o nome do campo na BD; o conceito UI é "distribuidor".
  const distribuidorRows = await prisma.$queryRaw<Array<{ nome: string | null }>>(
    Prisma.sql`
      SELECT DISTINCT "fornecedorOrigem" AS nome
      FROM "ProdutoFarmacia"
      WHERE "flagRetirado" = false
        AND "farmaciaId" = ANY(${farmaciaIds})
        AND "fornecedorOrigem" IS NOT NULL
    `
  );

  // Fabricantes/laboratórios canónicos: só os associados a pelo menos um Produto.
  const fabricanteRows = await prisma.$queryRaw<Array<{ nome: string | null }>>(
    Prisma.sql`
      SELECT DISTINCT fab."nomeNormalizado" AS nome
      FROM "Fabricante" fab
      JOIN "Produto" p ON p."fabricanteId" = fab.id
      WHERE fab.estado = 'ATIVO'
    `
  );

  // Categorias: SÓ canónicas (Classificacao NIVEL_1 estado=ATIVO). Sem UNION
  // com categoriaOrigem — esse texto não é fiável e contradiz a regra de
  // "SPharmMT é a fonte de verdade para classificação".
  const categoriaRows = await prisma.classificacao.findMany({
    where: { tipo: "NIVEL_1", estado: "ATIVO" },
    select: { nome: true },
    orderBy: { nome: "asc" },
  });

  // Subcategorias: NIVEL_2, com o nome do pai — dois níveis diferentes
  // podem ter filhos homónimos, e a UI precisa de os distinguir.
  const subcategoriaRows = await prisma.classificacao.findMany({
    where: { tipo: "NIVEL_2", estado: "ATIVO" },
    select: { nome: true, classificacaoPai: { select: { nome: true } } },
    orderBy: { nome: "asc" },
  });

  // Utilizações: vocabulário fechado, chave = slug, apresentação = nome.
  // Só as que estão MESMO associadas a um produto — uma opção que não
  // devolve linha nenhuma é ruído no dropdown.
  const utilizacaoRows = await prisma.$queryRaw<Array<{ slug: string; nome: string }>>(
    Prisma.sql`
      SELECT DISTINCT u.slug, u.nome
        FROM "Utilizacao" u
        JOIN "ProdutoUtilizacao" pu ON pu."utilizacaoId" = u.id
       WHERE u.estado = 'ATIVO'
       ORDER BY u.nome
    `
  );

  // Sinaliza, de forma BOOLEANA, se há produtos sem classificação canónica.
  // A UI passa a oferecer um filtro dedicado em vez de uma "categoria"
  // fictícia. Query barata: existência via take=1.
  const naoClassificado = await prisma.produto.findFirst({
    where: { classificacaoNivel1Id: null, estado: { not: "INATIVO" } },
    select: { id: true },
  });

  const distribuidores = cleanSortUnique(distribuidorRows.map((r) => r.nome));
  const categorias = cleanSortUnique(categoriaRows.map((r) => r.nome));

  return {
    distribuidores,
    fornecedores: distribuidores, // alias deprecated — mesma lista
    fabricantes: cleanSortUnique(fabricanteRows.map((r) => r.nome)),
    categorias,
    subcategorias: subcategoriaRows
      .map((r) => ({ nome: (r.nome ?? "").trim(), categoria: (r.classificacaoPai?.nome ?? "").trim() }))
      .filter((r) => r.nome)
      .sort((a, b) => a.nome.localeCompare(b.nome, "pt-PT")),
    utilizacoes: utilizacaoRows
      .map((r) => ({ slug: r.slug, nome: r.nome }))
      .sort((a, b) => a.nome.localeCompare(b.nome, "pt-PT")),
    semClassificacao: !!naoClassificado,
  };
}
