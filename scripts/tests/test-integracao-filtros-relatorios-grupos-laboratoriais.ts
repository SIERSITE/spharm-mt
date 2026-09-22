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
  type SnapshotParaResolver,
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
const eq = <T,>(a: T, b: T, label: string) =>
  check(JSON.stringify(a) === JSON.stringify(b), label, `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);

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
  { id: "p7", cnp: 1000007, fabricanteId: "fOutraEmpresa", grupoExistente: null }, // proposta_snapshot_cnp para Viatris — NUNCA deve entrar na relação de grupo
];

const mapas: MapasResolverGrupo = {
  fabricantesPorId: new Map<string, FabricanteParaResolver>([
    [FAB.mylan, { id: FAB.mylan, nomeNormalizado: "MYLAN" }],
    [FAB.upjohn, { id: FAB.upjohn, nomeNormalizado: "UPJOHN EESV" }],
    [FAB.alfaWassermann, { id: FAB.alfaWassermann, nomeNormalizado: "ALFA WASSERMANN" }],
    [FAB.pfizer, { id: FAB.pfizer, nomeNormalizado: "LABORATORIOS PFIZER" }],
    [FAB.bial, { id: FAB.bial, nomeNormalizado: "BIAL" }],
  ]),
  fabricantesPorNomeNormalizado: new Map<string, FabricanteParaResolver>([
    ["VIATRIS", { id: "fViatrisNoCatalogo", nomeNormalizado: "VIATRIS" }],
  ]),
  regrasCnpPorCnp: new Map<number, RegraCnpParaResolver>([
    [1000004, { id: "regraPfizer1", grupoLaboratorialId: "gViatris", estado: "ATIVO", validadoManualmente: true }],
  ]),
  // p7: titular ACTUAL do catálogo para este CNP é "Viatris", mas fOutraEmpresa
  // não está integral nem tem regra por CNP validada — classifica só como
  // proposta_snapshot_cnp (nível 4), NUNCA escreve ProdutoGrupoLaboratorial.
  snapshotsPorCnp: new Map<number, SnapshotParaResolver>([
    [1000007, { cnp: 1000007, titularAim: "Viatris", estadoAim: "Ativo" }],
  ]),
  gruposFabricantePorFabricanteId: new Map<string, GrupoFabricanteParaResolver>([
    [FAB.mylan, { grupoLaboratorialId: "gViatris" }],
    [FAB.upjohn, { grupoLaboratorialId: "gViatris" }],
    [FAB.alfaWassermann, { grupoLaboratorialId: "gAlfasigma" }],
    ["fViatrisNoCatalogo", { grupoLaboratorialId: "gViatris" }],
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
  check(resultadoPorId.get("p7")?.tipo === "proposta_snapshot_cnp", "Setup: p7 (fOutraEmpresa, titular actual do catálogo = Viatris) fica só proposta_snapshot_cnp — NUNCA escreve ProdutoGrupoLaboratorial");

  console.log("\n[2/3] Materializa a classificação nas tabelas que um Prisma real teria (GrupoLaboratorial/ProdutoGrupoLaboratorial)...");
  const gruposReais = [
    { id: "gViatris", nome: "Viatris" },
    { id: "gAlfasigma", nome: "Alfasigma" },
  ];
  // Só os 3 níveis SEGUROS de aplicar automaticamente escrevem
  // ProdutoGrupoLaboratorial (ver TIPOS_APLICAVEIS_AUTOMATICAMENTE em
  // scripts/classificar-grupos-laboratoriais-garantia.ts) — replicado
  // aqui explicitamente para que p7 (proposta_snapshot_cnp) NUNCA
  // apareça materializado, tal como um `--apply` real nunca o escreveria.
  const TIPOS_APLICAVEIS: ReadonlySet<string> = new Set(["regra_cnp", "fabricante_inequivoco", "alias_inequivoco"]);
  const produtoGrupoRows = [...resultadoPorId.entries()]
    .filter(([, r]) => TIPOS_APLICAVEIS.has(r.tipo))
    .map(([produtoId, r]) => ({ produtoId, grupoLaboratorialId: (r as { grupoLaboratorialId: string }).grupoLaboratorialId }));

  const fabricantesReais = [
    { id: FAB.pfizer, nomeNormalizado: "LABORATORIOS PFIZER", estado: "ATIVO" as const },
    { id: FAB.bial, nomeNormalizado: "BIAL", estado: "ATIVO" as const },
  ];
  const produtosPorFabricante = new Map<string, string[]>([
    [FAB.pfizer, ["p4", "p5"]],
    [FAB.bial, ["p6"]],
    // Necessários para as secções G/I (selecção por valor TIPADO
    // "fabricante:<id>", que consulta produto.findMany DIRECTAMENTE
    // pelo fabricanteId, sem passar por fabricante.findMany por nome).
    [FAB.mylan, ["p1"]],
    [FAB.upjohn, ["p2"]],
    [FAB.alfaWassermann, ["p3"]],
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

  // ── G-K: a MESMA cena, mas com os valores TIPADOS que a UI real produz
  // desde 2026-09-24 ("grupo:<id>"/"fabricante:<id>", nunca nomes soltos,
  // em garantia) — as secções A-F acima continuam válidas (caminho
  // legado/outros tenants), mas já não reflectem o que o catálogo/
  // relatórios realmente enviam para garantia.
  console.log("\nG · [valor tipado] seleccionar FABRICANTE Mylan — só produtos desse fabricanteId, NUNCA Upjohn nem produtos só-Viatris (requisito de teste #2)");
  {
    const resultado = await resolverProdutoIdsPorLaboratoriosSelecionados(fakePrisma, [`fabricante:${FAB.mylan}`], async () => "garantia");
    eqSet(resultado, ["p1"], "G1: só p1 (Mylan) — nunca p2 (Upjohn) nem qualquer produto exclusivamente Viatris");
  }

  console.log("\nH · [valor tipado] seleccionar GRUPO Viatris — inclui Mylan, Upjohn, o CNP Pfizer com regra validada; NUNCA a proposta pendente p7 (requisito de teste #3)");
  {
    const resultado = await resolverProdutoIdsPorLaboratoriosSelecionados(fakePrisma, ["grupo:gViatris"], async () => "garantia");
    eqSet(resultado, ["p1", "p2", "p4"], "H1: Mylan (p1) + Upjohn (p2) + regra CNP validada (p4)");
    check(!resultado.includes("p7"), "H2: a proposta pendente (p7, snapshot do catálogo, nunca validada) NÃO está incluída");
    check(!resultado.includes("p5"), "H3: o Pfizer sem regra específica (p5) também não está incluído");
  }

  console.log("\nI · [valor tipado] seleccionar FABRICANTE Alfa Wassermann devolve APENAS esse fabricante (requisito de teste #6)");
  {
    const resultado = await resolverProdutoIdsPorLaboratoriosSelecionados(fakePrisma, [`fabricante:${FAB.alfaWassermann}`], async () => "garantia");
    eqSet(resultado, ["p3"], "I1: só p3");
  }

  console.log("\nJ · [valores tipados MISTOS] grupo Viatris + fabricante Bial em simultâneo — união sem duplicados (requisito de teste #9)");
  {
    const resultado = await resolverProdutoIdsPorLaboratoriosSelecionados(fakePrisma, ["grupo:gViatris", `fabricante:${FAB.bial}`], async () => "garantia");
    eqSet(resultado, ["p1", "p2", "p4", "p6"], "J1: união de Viatris (p1,p2,p4) com Bial (p6), sem duplicados nem produtos a mais");
  }

  console.log("\nK · catálogo, vendas, margens e inventário resolvem para o MESMO conjunto de produtos com o MESMO valor tipado — coerência entre as 4 superfícies (requisito de teste #10)");
  {
    // O catálogo usa resolverFiltroLaboratorioWhere (Prisma where directo);
    // os 3 relatórios usam resolverProdutoIdsPorLaboratoriosSelecionados
    // (lista de ids) — DUAS implementações distintas por necessidade (uma
    // filtra no SELECT, a outra pré-resolve ids), mas ambas partilham a
    // MESMA fonte de verdade: a relação ProdutoGrupoLaboratorial para o
    // grupo. Aqui provamos que os ids devolvidos pelos relatórios são
    // EXACTAMENTE os produtos que o catálogo materializou nessa relação.
    const { resolverFiltroLaboratorioWhere } = await import("../../lib/catalog/laboratorio-filtro");
    const whereCatalogo = resolverFiltroLaboratorioWhere("grupo:gViatris");
    eq(whereCatalogo, { grupoLaboratorial: { grupoLaboratorialId: "gViatris" } }, "K1: catálogo filtra pela mesma relação ProdutoGrupoLaboratorial");

    const idsRelatorios = await resolverProdutoIdsPorLaboratoriosSelecionados(fakePrisma, ["grupo:gViatris"], async () => "garantia");
    const idsMaterializadosParaOGrupo = produtoGrupoRows.filter((r) => r.grupoLaboratorialId === "gViatris").map((r) => r.produtoId);
    eqSet(idsRelatorios, idsMaterializadosParaOGrupo, "K2: Vendas/Margens/Inventário devolvem EXACTAMENTE os produtos que a relação ProdutoGrupoLaboratorial materializou para este grupo — a mesma fonte que o catálogo consulta");
  }

  console.log(`\n${ok} ok, ${ko} falhas`);
  process.exit(ko === 0 ? 0 : 1);
}

main().catch((err) => { console.error("[erro fatal]", err); process.exitCode = 1; });
