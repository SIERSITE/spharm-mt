/**
 * scripts/tests/test-integracao-filtros-relatorios-grupos-laboratoriais.ts
 *
 * Teste de INTEGRAÇÃO (ponto 9 da revisão de 2026-09-22) — liga o motor
 * puro (`resolverGruposEmLote`) a `resolverProdutoIdsPorLaboratoriosSelecionados`
 * (o resolvedor partilhado por Vendas/Margens/Inventário) contra um
 * conjunto sintético mas realista: fabricantes Mylan/Upjohn/Viatris
 * (integrais), Alfa Wassermann (integral em Alfasigma), Pfizer (SEM
 * associação integral, com UMA regra por CNP validada), e um fabricante
 * independente (Bial) sem grupo nenhum.
 *
 * Prova, com dados construídos ponta-a-ponta (classificação → tabelas →
 * resolução do filtro), exactamente os 6 cenários pedidos:
 *   A. pesquisar "Viatris" devolve produtos Mylan + Upjohn + o CNP Pfizer
 *      com regra validada — nunca os restantes produtos Pfizer.
 *   B. pesquisar "Alfasigma" devolve os produtos Alfa Wassermann validados.
 *   C. os TRÊS relatórios (Vendas/Margens/Inventário) chamam a MESMA
 *      função com os MESMOS argumentos — dado que só existe UMA
 *      implementação, provar a assinatura idêntica nos 3 ficheiros já
 *      prova que nunca podem divergir (verificação estática).
 *   D. um fabricante SEM grupo (Bial) continua disponível pelo nome legal.
 *   E. fora de garantia (resolverTenant devolve null), a mesma selecção
 *      "Viatris" é tratada como um nome de FABRICANTE comum — nunca
 *      consulta grupoLaboratorial (o caminho antigo, inalterado).
 *   F. Pfizer SEM a regra específica nunca aparece em "Viatris".
 *
 * Corre com: npx tsx scripts/tests/test-integracao-filtros-relatorios-grupos-laboratoriais.ts
 */
import { readFileSync } from "node:fs";
import {
  resolverGruposEmLote,
  type ProdutoParaResolver,
  type MapasResolverGrupo,
  type FabricanteParaResolver,
  type GrupoFabricanteParaResolver,
  type RegraCnpParaResolver,
} from "../../lib/catalog/resolver-grupo-laboratorial";
import { resolverProdutoIdsPorLaboratoriosSelecionados } from "../../lib/reporting/resolver-laboratorio-selecionado";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const eqSet = (a: readonly string[], b: readonly string[], label: string) => {
  const as = [...a].sort(), bs = [...b].sort();
  check(JSON.stringify(as) === JSON.stringify(bs), label, `esperado ${JSON.stringify(bs)}, veio ${JSON.stringify(as)}`);
};

// ── Dataset sintético ────────────────────────────────────────────────
const FAB = {
  mylan: "fMylan",
  upjohn: "fUpjohn",
  alfaWassermann: "fAlfaWassermann",
  pfizer: "fPfizer",
  bial: "fBial", // sem grupo nenhum
};

const produtos: ProdutoParaResolver[] = [
  { id: "p1", cnp: 1000001, fabricanteId: FAB.mylan, grupoExistente: null },
  { id: "p2", cnp: 1000002, fabricanteId: FAB.upjohn, grupoExistente: null },
  { id: "p3", cnp: 1000003, fabricanteId: FAB.alfaWassermann, grupoExistente: null },
  { id: "p4", cnp: 1000004, fabricanteId: FAB.pfizer, grupoExistente: null }, // TEM regra_cnp validada → Viatris
  { id: "p5", cnp: 1000005, fabricanteId: FAB.pfizer, grupoExistente: null }, // SEM regra → sem_grupo
  { id: "p6", cnp: 1000006, fabricanteId: FAB.bial, grupoExistente: null }, // sem grupo nenhum
];

const mapas: MapasResolverGrupo = {
  fabricantesPorId: new Map<string, FabricanteParaResolver>([
    [FAB.mylan, { id: FAB.mylan, nomeNormalizado: "MYLAN" }],
    [FAB.upjohn, { id: FAB.upjohn, nomeNormalizado: "UPJOHN EESV" }],
    [FAB.alfaWassermann, { id: FAB.alfaWassermann, nomeNormalizado: "ALFA WASSERMANN" }],
    [FAB.pfizer, { id: FAB.pfizer, nomeNormalizado: "LABORATORIOS PFIZER" }],
    [FAB.bial, { id: FAB.bial, nomeNormalizado: "BIAL" }],
  ]),
  fabricantesPorNomeNormalizado: new Map(),
  regrasCnpPorCnp: new Map<number, RegraCnpParaResolver>([
    [1000004, { id: "regraPfizer1", grupoLaboratorialId: "gViatris", estado: "ATIVO", validadoManualmente: true }],
  ]),
  snapshotsPorCnp: new Map(),
  gruposFabricantePorFabricanteId: new Map<string, GrupoFabricanteParaResolver>([
    [FAB.mylan, { grupoLaboratorialId: "gViatris" }],
    [FAB.upjohn, { grupoLaboratorialId: "gViatris" }],
    [FAB.alfaWassermann, { grupoLaboratorialId: "gAlfasigma" }],
  ]),
  aliasesPorNomeNormalizado: new Map(),
};

async function main(): Promise<void> {
  console.log("[1/3] Classificação (motor puro) sobre os 6 produtos sintéticos...");
  const relatorio = resolverGruposEmLote(produtos, mapas);
  const resultadoPorId = new Map(relatorio.resultados.map((r) => [r.produtoId, r.resultado]));

  check(resultadoPorId.get("p1")?.tipo === "fabricante_inequivoco", "Setup: Mylan (p1) classifica fabricante_inequivoco/Viatris");
  check(resultadoPorId.get("p4")?.tipo === "regra_cnp", "Setup: Pfizer CNP validado (p4) classifica regra_cnp/Viatris");
  check(resultadoPorId.get("p5")?.tipo === "sem_grupo", "Setup: Pfizer sem regra (p5) fica sem_grupo");
  check(resultadoPorId.get("p6")?.tipo === "sem_grupo", "Setup: Bial (p6), sem grupo nenhum na config, fica sem_grupo");

  console.log("\n[2/3] Materializa a classificação nas tabelas que um Prisma real teria (GrupoLaboratorial/ProdutoGrupoLaboratorial)...");
  const gruposReais = [
    { id: "gViatris", nome: "Viatris" },
    { id: "gAlfasigma", nome: "Alfasigma" },
  ];
  const produtoGrupoRows = [...resultadoPorId.entries()]
    .filter(([, r]) => r.tipo !== "sem_grupo" && r.tipo !== "mantido_manual")
    .map(([produtoId, r]) => ({ produtoId, grupoLaboratorialId: (r as { grupoLaboratorialId: string }).grupoLaboratorialId }));

  const fabricantesReais = [
    { id: FAB.pfizer, nomeNormalizado: "LABORATORIOS PFIZER", estado: "ATIVO" as const },
    { id: FAB.bial, nomeNormalizado: "BIAL", estado: "ATIVO" as const },
  ];
  const produtosPorFabricante = new Map<string, string[]>([
    [FAB.pfizer, ["p4", "p5"]],
    [FAB.bial, ["p6"]],
  ]);

  const fakePrisma = {
    grupoLaboratorial: {
      findMany: async (args: { where: { nome: { in: string[] } } }) =>
        gruposReais.filter((g) => args.where.nome.in.includes(g.nome)),
    },
    produtoGrupoLaboratorial: {
      findMany: async (args: { where: { grupoLaboratorialId: { in: string[] } } }) =>
        produtoGrupoRows.filter((r) => args.where.grupoLaboratorialId.in.includes(r.grupoLaboratorialId)).map((r) => ({ produtoId: r.produtoId })),
    },
    fabricante: {
      findMany: async (args: { where: { nomeNormalizado: { in: string[] }; estado: string } }) =>
        fabricantesReais.filter((f) => args.where.nomeNormalizado.in.includes(f.nomeNormalizado) && f.estado === args.where.estado),
    },
    produto: {
      findMany: async (args: { where: { fabricanteId: { in: string[] } } }) => {
        const ids: string[] = [];
        for (const fabId of args.where.fabricanteId.in) ids.push(...(produtosPorFabricante.get(fabId) ?? []));
        return ids.map((id) => ({ id }));
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  console.log("\n[3/3] resolverProdutoIdsPorLaboratoriosSelecionados — os 6 cenários pedidos...");

  console.log("\nA · pesquisar 'Viatris' devolve Mylan + Upjohn + o CNP Pfizer com regra validada, nunca o Pfizer sem regra");
  {
    const resultado = await resolverProdutoIdsPorLaboratoriosSelecionados(fakePrisma, ["Viatris"], async () => "garantia");
    eqSet(resultado, ["p1", "p2", "p4"], "A1: união correcta — p1(Mylan)+p2(Upjohn)+p4(Pfizer com regra), p5(Pfizer sem regra) EXCLUÍDO");
  }

  console.log("\nB · pesquisar 'Alfasigma' devolve os produtos Alfa Wassermann validados");
  {
    const resultado = await resolverProdutoIdsPorLaboratoriosSelecionados(fakePrisma, ["Alfasigma"], async () => "garantia");
    eqSet(resultado, ["p3"], "B1: só p3 (Alfa Wassermann, integral em Alfasigma)");
  }

  console.log("\nC · Vendas/Margens/Inventário chamam a MESMA função com os MESMOS argumentos (verificação estática — garante que nunca podem divergir)");
  {
    for (const ficheiro of ["lib/vendas-data.ts", "lib/margens-data.ts", "lib/inventario-data.ts"]) {
      const conteudo = readFileSync(ficheiro, "utf8");
      check(
        conteudo.includes("resolverProdutoIdsPorLaboratoriosSelecionados(prisma, filters.fabricantes)"),
        `C.${ficheiro}: chama resolverProdutoIdsPorLaboratoriosSelecionados(prisma, filters.fabricantes) — assinatura idêntica`,
      );
    }
  }

  console.log("\nD · Bial (sem grupo) continua disponível pelo nome legal");
  {
    const resultado = await resolverProdutoIdsPorLaboratoriosSelecionados(fakePrisma, ["BIAL"], async () => "garantia");
    eqSet(resultado, ["p6"], "D1: Bial resolvido como fabricante comum, devolve p6");
  }

  console.log("\nE · fora de garantia (resolverTenant devolve null): 'Viatris' NUNCA consulta grupoLaboratorial, é tratado como nome de fabricante comum (não encontrado, devolve vazio)");
  {
    const chamadasGrupo: string[] = [];
    const fakePrismaComRastreio = {
      ...fakePrisma,
      grupoLaboratorial: { findMany: async (...a: unknown[]) => { chamadasGrupo.push("chamado"); return fakePrisma.grupoLaboratorial.findMany(...(a as [never])); } },
    };
    const resultado = await resolverProdutoIdsPorLaboratoriosSelecionados(fakePrismaComRastreio, ["Viatris"], async () => null);
    check(chamadasGrupo.length === 0, "E1: grupoLaboratorial.findMany NUNCA chamado fora de garantia");
    eqSet(resultado, [], "E2: 'Viatris' não bate nenhum Fabricante real neste dataset — devolve vazio, nunca inventa");
  }

  console.log("\nF · Pfizer SEM a regra específica (p5) nunca aparece em nenhuma selecção de 'Viatris', mesmo pesquisando por Pfizer directamente");
  {
    const resultado = await resolverProdutoIdsPorLaboratoriosSelecionados(fakePrisma, ["LABORATORIOS PFIZER"], async () => "garantia");
    eqSet(resultado, ["p4", "p5"], "F1: pesquisar Pfizer DIRECTAMENTE (nome de fabricante) devolve AMBOS os produtos Pfizer — p4 tem também regra Viatris, mas continua um produto real da Pfizer");
  }

  console.log(`\n${ok} ok, ${ko} falhas`);
  process.exit(ko === 0 ? 0 : 1);
}

main().catch((err) => { console.error("[erro fatal]", err); process.exitCode = 1; });
