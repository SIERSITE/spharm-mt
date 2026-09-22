/**
 * lib/catalog/carregar-laboratorios-garantia.ts
 *
 * `carregarLaboratoriosGarantia` — carrega TODAS as opções de
 * laboratório (fabricantes + grupos) do tenant garantia, com contagens
 * agregadas. Reaproveitado por `lib/catalogo-data.ts`
 * (`loadCatalogoFilterOptions`), `lib/reporting-filter-options.ts`
 * (`getReportingFilterOptions`) E scripts `tsx` de ensaio/simulação —
 * por isso vive AQUI, sem importar `"server-only"`: esse marker resolve
 * para no-op no bundler Next.js mas falha com MODULE_NOT_FOUND sob
 * `tsx` (Node puro), exactamente a razão documentada em
 * `lib/tenant-context.ts` e `lib/catalog/laboratorio-filtro.ts`. Este
 * módulo continua a precisar de acesso a Prisma (não é puro como
 * `laboratorio-filtro.ts`) — só não pode ser importado a partir de um
 * ficheiro que traga `"server-only"` consigo se algum script `tsx`
 * também precisar de o importar directamente (ver
 * scripts/ensaio-filtros-catalogo-e-relatorios.ts).
 *
 * ── Correcção de UX de 2026-09-24 ─────────────────────────────────────
 * Um fabricante integralmente associado a um grupo (ex.: "Mylan") deixou
 * de ser EXCLUÍDO da lista — aparece sempre como a sua própria opção
 * `{tipo:"fabricante"}`, o grupo aparece ADICIONALMENTE. O cliente já
 * não precisa de saber de antemão que "Mylan pertence à Viatris" para
 * conseguir filtrar só pela Mylan.
 *
 * `termosBusca` de cada grupo inclui aliases do PRÓPRIO grupo + nomes
 * normalizados de TODOS os fabricantes integralmente associados + os
 * aliases desses fabricantes (`FabricanteAlias`) — para que pesquisar
 * por QUALQUER grafia de um fabricante integral também encontre o
 * grupo, sem esconder a opção do fabricante em si.
 *
 * Contagens: DUAS queries agregadas (`groupBy`), nunca uma por opção —
 * `Produto.count por fabricanteId` e `ProdutoGrupoLaboratorial.count por
 * grupoLaboratorialId` (esta já exclui propostas pendentes, que nunca
 * têm linha em `ProdutoGrupoLaboratorial`).
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { CatalogoFilterOptionLaboratorio } from "./laboratorio-filtro";

type PrismaParaLaboratorios = Pick<PrismaClient, "fabricante" | "grupoLaboratorial" | "grupoLaboratorialFabricante" | "grupoLaboratorialAlias" | "produto" | "produtoGrupoLaboratorial">;

export async function carregarLaboratoriosGarantia(prisma: PrismaParaLaboratorios): Promise<CatalogoFilterOptionLaboratorio[]> {
  const [fabricantesRaw, grupos, associacoesIntegrais, aliasesGrupoRaw, contagemPorFabricante, contagemPorGrupo] = await Promise.all([
    prisma.fabricante.findMany({ where: { estado: "ATIVO" }, select: { id: true, nomeNormalizado: true } }),
    prisma.grupoLaboratorial.findMany({ where: { estado: "ATIVO" }, select: { id: true, nome: true } }),
    prisma.grupoLaboratorialFabricante.findMany({
      select: { grupoLaboratorialId: true, fabricante: { select: { id: true, nomeNormalizado: true, aliases: { select: { aliasNome: true } } } } },
    }),
    prisma.grupoLaboratorialAlias.findMany({ where: { estado: "ATIVO" }, select: { grupoLaboratorialId: true, alias: true } }),
    prisma.produto.groupBy({ by: ["fabricanteId"], _count: { _all: true }, where: { fabricanteId: { not: null } } }),
    prisma.produtoGrupoLaboratorial.groupBy({ by: ["grupoLaboratorialId"], _count: { _all: true } }),
  ]);

  const produtosPorFabricanteId = new Map(contagemPorFabricante.map((r) => [r.fabricanteId as string, r._count._all]));
  const produtosPorGrupoId = new Map(contagemPorGrupo.map((r) => [r.grupoLaboratorialId, r._count._all]));

  const aliasesCuradosPorGrupo = new Map<string, string[]>();
  for (const a of aliasesGrupoRaw) {
    const lista = aliasesCuradosPorGrupo.get(a.grupoLaboratorialId) ?? [];
    lista.push(a.alias);
    aliasesCuradosPorGrupo.set(a.grupoLaboratorialId, lista);
  }

  // termosBusca = aliases curados do grupo + nome/aliases de CADA fabricante integral.
  const termosBuscaPorGrupo = new Map<string, string[]>();
  for (const a of associacoesIntegrais) {
    const lista = termosBuscaPorGrupo.get(a.grupoLaboratorialId) ?? [];
    lista.push(a.fabricante.nomeNormalizado, ...a.fabricante.aliases.map((al) => al.aliasNome));
    termosBuscaPorGrupo.set(a.grupoLaboratorialId, lista);
  }

  return [
    ...grupos.map((g): CatalogoFilterOptionLaboratorio => ({
      tipo: "grupo",
      id: g.id,
      nome: g.nome,
      termosBusca: [...(aliasesCuradosPorGrupo.get(g.id) ?? []), ...(termosBuscaPorGrupo.get(g.id) ?? [])],
      resumoAlcance: [g.nome, ...(aliasesCuradosPorGrupo.get(g.id) ?? [])],
      produtos: produtosPorGrupoId.get(g.id) ?? 0,
    })),
    ...fabricantesRaw.map((f): CatalogoFilterOptionLaboratorio => ({
      tipo: "fabricante",
      id: f.id,
      nomeNormalizado: f.nomeNormalizado,
      produtos: produtosPorFabricanteId.get(f.id) ?? 0,
    })),
  ];
}
