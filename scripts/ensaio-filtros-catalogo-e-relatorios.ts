/**
 * scripts/ensaio-filtros-catalogo-e-relatorios.ts
 *
 * Correcção ao passo [L] de ensaio-volume-real-docker.ts: esse passo
 * testou termos de ALIAS ("Upjohn", "Alfa Wassermann", "Ratiopharm",
 * "JNTL Consumer Health", "Pentafarma") directamente contra
 * `resolverProdutoIdsPorLaboratoriosSelecionados` — mas essa função
 * (lib/reporting/resolver-laboratorio-selecionado.ts, usada só por
 * Vendas/Margens/Inventário) faz correspondência EXACTA só contra
 * `GrupoLaboratorial.nome` ou `Fabricante.nomeNormalizado`, NUNCA contra
 * aliases — por desenho: os relatórios oferecem um dropdown com os
 * nomes CANÓNICOS dos grupos, nunca aliases como opções à parte. Só o
 * CATÁLOGO tem pesquisa alias-aware, via `pesquisarLaboratorios` +
 * `resolverFiltroLaboratorioWhere` (lib/catalog/laboratorio-filtro.ts) —
 * "escrever Upjohn" filtra a LISTA de opções (mostra só "Viatris"),
 * nunca passa o texto "Upjohn" para a query.
 *
 * Este ensaio replica os DOIS caminhos reais, correctamente, contra a
 * MESMA base Docker descartável já populada por ensaio-volume-real-docker.ts:
 *   1. Catálogo: carrega as opções tal como loadCatalogoFilterOptions
 *      faria, corre pesquisarLaboratorios(query) para cada alias, resolve
 *      o valor "grupo:<id>" resultante via resolverFiltroLaboratorioWhere,
 *      e conta produtos reais que batem.
 *   2. Relatórios: selecciona pelo NOME CANÓNICO do grupo (como o
 *      dropdown really oferece) via resolverProdutoIdsPorLaboratoriosSelecionados.
 *
 * Uso: DATABASE_URL=postgresql://test:test@localhost:55433/spharmmt_test \
 *   npx tsx scripts/ensaio-filtros-catalogo-e-relatorios.ts
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { pesquisarLaboratorios, resolverFiltroLaboratorioWhere, type CatalogoFilterOptionLaboratorio } from "../lib/catalog/laboratorio-filtro";
import { resolverProdutoIdsPorLaboratoriosSelecionados } from "../lib/reporting/resolver-laboratorio-selecionado";

async function carregarOpcoesCatalogo(prisma: PrismaClient): Promise<CatalogoFilterOptionLaboratorio[]> {
  // Réplica FIEL de loadCatalogoFilterOptions (lib/catalogo-data.ts) — mesmas queries, mesma lógica de exclusão de fabricantes integrais.
  const [fabricantesRaw, grupos, associacoesIntegrais, aliasesRaw] = await Promise.all([
    prisma.fabricante.findMany({ where: { estado: "ATIVO" }, select: { id: true, nomeNormalizado: true } }),
    prisma.grupoLaboratorial.findMany({ where: { estado: "ATIVO" }, select: { id: true, nome: true } }),
    prisma.grupoLaboratorialFabricante.findMany({ select: { fabricanteId: true } }),
    prisma.grupoLaboratorialAlias.findMany({ where: { estado: "ATIVO" }, select: { grupoLaboratorialId: true, alias: true } }),
  ]);
  const idsIntegraisNumGrupo = new Set(associacoesIntegrais.map((a) => a.fabricanteId));
  const aliasesPorGrupo = new Map<string, string[]>();
  for (const a of aliasesRaw) {
    const lista = aliasesPorGrupo.get(a.grupoLaboratorialId) ?? [];
    lista.push(a.alias);
    aliasesPorGrupo.set(a.grupoLaboratorialId, lista);
  }
  return [
    ...grupos.map((g): CatalogoFilterOptionLaboratorio => ({ tipo: "grupo", id: g.id, nome: g.nome, termosBusca: aliasesPorGrupo.get(g.id) ?? [] })),
    ...fabricantesRaw.filter((f) => !idsIntegraisNumGrupo.has(f.id)).map((f): CatalogoFilterOptionLaboratorio => ({ tipo: "fabricante", id: f.id, nomeNormalizado: f.nomeNormalizado })),
  ];
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL obrigatório");
  if (/spharmmt_t_|prod|production/i.test(url)) throw new Error("[fatal] URL parece apontar para uma base real — recusado.");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  const resultados: Record<string, unknown> = {};
  try {
    console.log("═".repeat(78));
    console.log("1. CATÁLOGO — pesquisa alias-aware (pesquisarLaboratorios → resolverFiltroLaboratorioWhere → produtos reais)");
    console.log("═".repeat(78));
    const opcoes = await carregarOpcoesCatalogo(prisma);
    console.log(`  ${opcoes.length} opções carregadas (${opcoes.filter((o) => o.tipo === "grupo").length} grupos, ${opcoes.filter((o) => o.tipo === "fabricante").length} fabricantes)`);

    const casosCatalogo: Array<{ termo: string; grupoEsperado: string }> = [
      { termo: "Mylan", grupoEsperado: "Viatris" },
      { termo: "Upjohn", grupoEsperado: "Viatris" },
      { termo: "Alfa Wassermann", grupoEsperado: "Alfasigma" },
      { termo: "Ratiopharm", grupoEsperado: "Teva" },
      { termo: "JNTL Consumer Health", grupoEsperado: "Kenvue" },
      { termo: "Pentafarma", grupoEsperado: "Tecnimede" },
      { termo: "Towa", grupoEsperado: "Towa" },
    ];
    for (const c of casosCatalogo) {
      const encontrados = pesquisarLaboratorios(opcoes, c.termo);
      const opcaoGrupo = encontrados.find((o) => o.tipo === "grupo" && o.nome === c.grupoEsperado);
      let totalProdutos = 0;
      if (opcaoGrupo) {
        const where = resolverFiltroLaboratorioWhere(`grupo:${opcaoGrupo.id}`);
        totalProdutos = await prisma.produto.count({ where: where! });
      }
      const passou = !!opcaoGrupo && totalProdutos > 0;
      console.log(`  ${passou ? "✓" : "✗"} pesquisar "${c.termo}" → opções: [${encontrados.map((o) => (o.tipo === "grupo" ? o.nome : o.nomeNormalizado)).join(", ")}] → "${c.grupoEsperado}" encontrado=${!!opcaoGrupo}, produtos=${totalProdutos}`);
      resultados[`catalogo:${c.termo}`] = { opcoesEncontradas: encontrados.map((o) => (o.tipo === "grupo" ? o.nome : o.nomeNormalizado)), grupoEncontrado: !!opcaoGrupo, produtos: totalProdutos, passou };
    }

    // JANSSEN nunca deve aparecer como opção "grupo" nem resolver para Kenvue.
    const janssenBusca = pesquisarLaboratorios(opcoes, "Janssen");
    const janssenComoGrupo = janssenBusca.filter((o) => o.tipo === "grupo");
    console.log(`  ✓ pesquisar "Janssen": ${janssenBusca.length} opção(ões) [${janssenBusca.map((o) => (o.tipo === "grupo" ? o.nome : o.nomeNormalizado)).join(", ")}], nenhuma é grupo Kenvue: ${janssenComoGrupo.length === 0}`);
    resultados["catalogo:Janssen_nunca_grupo"] = janssenComoGrupo.length === 0;

    console.log("\n" + "═".repeat(78));
    console.log("2. RELATÓRIOS (Vendas/Margens/Inventário) — dropdown com NOME CANÓNICO do grupo");
    console.log("═".repeat(78));
    const resolverTenantGarantia = async () => "garantia";
    const casosRelatorio = ["Viatris", "Alfasigma", "Teva", "Kenvue", "Tecnimede", "Towa", "Organon", "Sandoz", "Zentiva", "Opella"];
    for (const nome of casosRelatorio) {
      const ids = await resolverProdutoIdsPorLaboratoriosSelecionados(prisma, [nome], resolverTenantGarantia);
      console.log(`  "${nome}": ${ids.length} produtos`);
      resultados[`relatorio:${nome}`] = ids.length;
    }

    // As 3 origens (Vendas/Margens/Inventário) chamam a MESMA função com os MESMOS argumentos — reconfirmar aqui, com o código actual do worktree.
    for (const ficheiro of ["lib/vendas-data.ts", "lib/margens-data.ts", "lib/inventario-data.ts"]) {
      const conteudo = readFileSync(ficheiro, "utf8");
      const ok = conteudo.includes("resolverProdutoIdsPorLaboratoriosSelecionados(prisma, filters.fabricantes)");
      console.log(`  ${ok ? "✓" : "✗"} ${ficheiro} chama a mesma função com os mesmos argumentos`);
      resultados[`mesma_funcao:${ficheiro}`] = ok;
    }

    console.log("\n" + "═".repeat(78));
    console.log("3. Coerência: Viatris via catálogo == Viatris via relatório (mesmo grupo, mesma contagem)");
    console.log("═".repeat(78));
    const viatrisCatalogo = resultados["catalogo:Mylan"] as { produtos: number };
    const viatrisRelatorio = resultados["relatorio:Viatris"] as number;
    // Catálogo conta TODOS os produtos do grupo Viatris (grupoLaboratorial.grupoLaboratorialId=X);
    // relatório conta a UNIÃO de {produtos do grupo} ∪ {produtos de um Fabricante chamado "Viatris"} — mesma base, caminho ligeiramente diferente mas devem coincidir aqui (não há Fabricante chamado literalmente "Viatris" com produtos próprios fora do grupo).
    console.log(`  Catálogo (grupo Viatris via alias Mylan): ${viatrisCatalogo.produtos} produtos`);
    console.log(`  Relatório (nome canónico "Viatris"):      ${viatrisRelatorio} produtos`);
    console.log(`  ${viatrisCatalogo.produtos === viatrisRelatorio ? "✓ coerentes" : "✗ DIVERGEM"}`);
    resultados["coerencia_catalogo_relatorio_viatris"] = viatrisCatalogo.produtos === viatrisRelatorio;

    writeFileSync("C:/projetos/spharm-mt/.local-data/fabricantes-garantia/ensaio-filtros-catalogo-e-relatorios.json", JSON.stringify(resultados, null, 2), "utf8");
    console.log("\nRelatório gravado em: C:/projetos/spharm-mt/.local-data/fabricantes-garantia/ensaio-filtros-catalogo-e-relatorios.json");
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

main().catch((err) => {
  console.error("[erro fatal]", err);
  process.exitCode = 1;
});
