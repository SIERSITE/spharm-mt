/**
 * scripts/tests/test-resolver-laboratorio-selecionado.ts
 *
 * Testa lib/reporting/resolver-laboratorio-selecionado.ts — o resolvedor
 * partilhado por Vendas/Margens/Inventário (garante que os filtros de
 * relatórios resolvem os MESMOS grupos que o catálogo, nunca dois
 * comportamentos divergentes na Garantia).
 *
 * Corre FORA de um pedido Next.js real (é um script `tsx` simples), o
 * que `resolveCurrentTenantSlug()` já documenta devolver `null` nesse
 * caso (lib/tenant-context.ts) — ou seja, este teste corre sempre pelo
 * caminho "outro tenant" na prática, e é exactamente isso que prova a
 * secção B: mesmo com um Prisma falso que NÃO implementa
 * grupoLaboratorial/produtoGrupoLaboratorial, e mesmo com nomes que
 * bateriam com um grupo SE fosse garantia, a consulta a essas tabelas
 * nunca é feita — nenhum tenant fora de garantia arrisca uma query a
 * tabelas que podem nem existir ainda.
 *
 * Corre com: npx tsx scripts/tests/test-resolver-laboratorio-selecionado.ts
 */
import { resolverProdutoIdsPorLaboratoriosSelecionados } from "../../lib/reporting/resolver-laboratorio-selecionado";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const eq = <T,>(a: T, b: T, label: string) =>
  check(JSON.stringify(a) === JSON.stringify(b), label, `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);
const eqSet = (a: readonly string[], b: readonly string[], label: string) => {
  const as = [...a].sort(), bs = [...b].sort();
  check(JSON.stringify(as) === JSON.stringify(bs), label, `esperado ${JSON.stringify(bs)}, veio ${JSON.stringify(as)}`);
};

async function principal() {
  console.log("A · lista vazia — devolve vazio sem tocar em nada");
  {
    const chamadas: string[] = [];
    const fake = {
      grupoLaboratorial: { findMany: async () => { chamadas.push("grupoLaboratorial.findMany"); return []; } },
      produtoGrupoLaboratorial: { findMany: async () => { chamadas.push("produtoGrupoLaboratorial.findMany"); return []; } },
      fabricante: { findMany: async () => { chamadas.push("fabricante.findMany"); return []; } },
      produto: { findMany: async () => { chamadas.push("produto.findMany"); return []; } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const resultado = await resolverProdutoIdsPorLaboratoriosSelecionados(fake, []);
    eq(resultado, [], "A1: lista vazia devolve vazio");
    eq(chamadas, [], "A2: nada foi chamado no Prisma");
  }

  console.log("\nB · fora de garantia (contexto sem pedido Next.js — resolveCurrentTenantSlug() devolve null): NUNCA consulta grupoLaboratorial, mesmo com nomes que bateriam com um grupo");
  {
    const chamadas: string[] = [];
    const fake = {
      grupoLaboratorial: {
        findMany: async () => { chamadas.push("grupoLaboratorial.findMany"); return [{ id: "gViatris", nome: "Viatris" }]; },
      },
      produtoGrupoLaboratorial: { findMany: async () => { chamadas.push("produtoGrupoLaboratorial.findMany"); return []; } },
      fabricante: {
        findMany: async (args: { where: { nomeNormalizado: { in: string[] } } }) => {
          chamadas.push("fabricante.findMany");
          // "Viatris" tratado como um NOME DE FABRICANTE comum, não como grupo — comportamento antigo, inalterado.
          return args.where.nomeNormalizado.in.includes("Viatris") ? [{ id: "fViatrisComoFabricante" }] : [];
        },
      },
      produto: {
        findMany: async (args: { where: { fabricanteId: { in: string[] } } }) => {
          chamadas.push("produto.findMany");
          return args.where.fabricanteId.in.map((id: string) => ({ id: `produto-de-${id}` }));
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const resultado = await resolverProdutoIdsPorLaboratoriosSelecionados(fake, ["Viatris"]);

    check(!chamadas.includes("grupoLaboratorial.findMany"), "B1: grupoLaboratorial.findMany NUNCA chamado fora de garantia — mesmo com um nome que bateria com um grupo real");
    check(!chamadas.includes("produtoGrupoLaboratorial.findMany"), "B2: produtoGrupoLaboratorial.findMany também nunca chamado");
    check(chamadas.includes("fabricante.findMany"), "B3: 'Viatris' resolvido como FABRICANTE comum — comportamento antigo preservado");
    eq(resultado, ["produto-de-fViatrisComoFabricante"], "B4: resultado vem do caminho antigo (fabricante), nunca do caminho de grupo");
  }

  console.log("\nC · múltiplos nomes de fabricante — união (OR), como sempre foi na multi-selecção");
  {
    const fake = {
      grupoLaboratorial: { findMany: async () => [] },
      produtoGrupoLaboratorial: { findMany: async () => [] },
      fabricante: {
        findMany: async () => [{ id: "f1" }, { id: "f2" }],
      },
      produto: {
        findMany: async () => [{ id: "p1" }, { id: "p2" }, { id: "p3" }],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const resultado = await resolverProdutoIdsPorLaboratoriosSelecionados(fake, ["Bayer Portugal", "Bial"]);
    eq(resultado.sort(), ["p1", "p2", "p3"], "C1: união dos produtos de ambos os fabricantes seleccionados");
  }

  console.log("\nD · valores TIPADOS 'fabricante:<id>' — filtra exclusivamente por esse fabricanteId, em QUALQUER tenant (não toca grupoLaboratorial)");
  {
    const chamadas: string[] = [];
    const fake = {
      grupoLaboratorial: { findMany: async () => { chamadas.push("grupoLaboratorial.findMany"); return []; } },
      produtoGrupoLaboratorial: { findMany: async () => { chamadas.push("produtoGrupoLaboratorial.findMany"); return []; } },
      fabricante: { findMany: async () => { chamadas.push("fabricante.findMany"); return []; } },
      produto: {
        findMany: async (args: { where: { fabricanteId: { in: string[] } } }) => {
          chamadas.push("produto.findMany");
          return args.where.fabricanteId.in.map((id: string) => ({ id: `produto-de-${id}` }));
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const resultado = await resolverProdutoIdsPorLaboratoriosSelecionados(fake, ["fabricante:fMylanLda"], async () => "garantia");
    eq(resultado, ["produto-de-fMylanLda"], "D1: resolve directamente pelo id, sem nenhuma query de nome");
    check(!chamadas.includes("grupoLaboratorial.findMany") && !chamadas.includes("fabricante.findMany"), "D2: nem grupoLaboratorial nem fabricante.findMany são chamados — o id já é conhecido, sem ambiguidade");

    // Fora de garantia, um valor "fabricante:<id>" continua seguro (Fabricante existe em qualquer tenant) — nunca gated pelo tenant.
    const resultadoOutroTenant = await resolverProdutoIdsPorLaboratoriosSelecionados(fake, ["fabricante:fBayer"], async () => "outro-tenant");
    eq(resultadoOutroTenant, ["produto-de-fBayer"], "D3: 'fabricante:<id>' funciona em QUALQUER tenant — não depende de grupoLaboratorial existir");
  }

  console.log("\nE · valores TIPADOS 'grupo:<id>' — só em garantia; consulta produtoGrupoLaboratorial DIRECTAMENTE pelo id, sem findMany de nome");
  {
    const chamadas: string[] = [];
    const fake = {
      grupoLaboratorial: { findMany: async () => { chamadas.push("grupoLaboratorial.findMany"); return []; } },
      produtoGrupoLaboratorial: {
        findMany: async (args: { where: { grupoLaboratorialId: { in: string[] } } }) => {
          chamadas.push("produtoGrupoLaboratorial.findMany");
          return args.where.grupoLaboratorialId.in.includes("gViatris")
            ? [{ produtoId: "p-mylan-1" }, { produtoId: "p-upjohn-1" }, { produtoId: "p-viatris-1" }, { produtoId: "p-regra-cnp-pfizer-1" }]
            : [];
        },
      },
      fabricante: { findMany: async () => { chamadas.push("fabricante.findMany"); return []; } },
      produto: { findMany: async () => { chamadas.push("produto.findMany"); return []; } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const resultado = await resolverProdutoIdsPorLaboratoriosSelecionados(fake, ["grupo:gViatris"], async () => "garantia");
    eqSet(resultado, ["p-mylan-1", "p-upjohn-1", "p-viatris-1", "p-regra-cnp-pfizer-1"], "E1: devolve TODOS os produtos com linha ProdutoGrupoLaboratorial para este grupo — Mylan, Upjohn, Viatris E o CNP com regra validada");
    check(!chamadas.includes("grupoLaboratorial.findMany"), "E2: grupoLaboratorial.findMany NUNCA chamado — o id já é conhecido");

    // Fora de garantia, um valor "grupo:<id>" tem de ser ignorado (nunca consulta produtoGrupoLaboratorial) — pode acontecer com um link antigo/adulterado.
    const chamadas2: string[] = [];
    const fake2 = {
      ...fake,
      produtoGrupoLaboratorial: { findMany: async () => { chamadas2.push("produtoGrupoLaboratorial.findMany"); return [{ produtoId: "nunca-deveria-aparecer" }]; } },
    };
    const resultadoOutroTenant = await resolverProdutoIdsPorLaboratoriosSelecionados(fake2, ["grupo:gViatris"], async () => "outro-tenant");
    eq(resultadoOutroTenant, [], "E3: fora de garantia, 'grupo:<id>' é ignorado — devolve vazio, NUNCA consulta produtoGrupoLaboratorial");
    check(!chamadas2.includes("produtoGrupoLaboratorial.findMany"), "E4: confirmação — produtoGrupoLaboratorial.findMany nunca chamado fora de garantia, mesmo com um valor 'grupo:' explícito");
  }

  console.log("\nF · selecção MISTA grupo + fabricante — união (OR) sem duplicados");
  {
    const fake = {
      grupoLaboratorial: { findMany: async () => [] },
      produtoGrupoLaboratorial: {
        findMany: async () => [{ produtoId: "p-grupo-1" }, { produtoId: "p-partilhado" }],
      },
      fabricante: { findMany: async () => [] },
      produto: {
        findMany: async () => [{ id: "p-fabricante-1" }, { id: "p-partilhado" }],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const resultado = await resolverProdutoIdsPorLaboratoriosSelecionados(fake, ["grupo:gX", "fabricante:fY"], async () => "garantia");
    eqSet(resultado, ["p-grupo-1", "p-partilhado", "p-fabricante-1"], "F1: união sem duplicados — 'p-partilhado' aparece só UMA vez mesmo devolvido pelas duas origens");
  }

  console.log("\nG · valores SEM prefixo continuam a funcionar exactamente como antes (nomes soltos — comportamento legado/outros tenants)");
  {
    const fake = {
      grupoLaboratorial: { findMany: async (args: { where: { nome: { in: string[] } } }) => (args.where.nome.in.includes("Viatris") ? [{ id: "gViatris", nome: "Viatris" }] : []) },
      produtoGrupoLaboratorial: { findMany: async () => [{ produtoId: "p1" }] },
      fabricante: { findMany: async () => [{ id: "fBial" }] },
      produto: { findMany: async () => [{ id: "p-bial-1" }] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const resultado = await resolverProdutoIdsPorLaboratoriosSelecionados(fake, ["Viatris", "Bial"], async () => "garantia");
    eqSet(resultado, ["p1", "p-bial-1"], "G1: nomes soltos ('Viatris' como grupo, 'Bial' como fabricante) continuam a resolver pelo caminho antigo");
  }

  console.log("\nH · mistura de valores tipados E soltos no mesmo pedido — ambos resolvidos, unidos sem duplicados");
  {
    const fake = {
      grupoLaboratorial: { findMany: async () => [] }, // nenhum nome solto de grupo neste caso
      produtoGrupoLaboratorial: { findMany: async (args: { where: { grupoLaboratorialId: { in: string[] } } }) => (args.where.grupoLaboratorialId.in.includes("gTeva") ? [{ produtoId: "p-teva-1" }] : []) },
      fabricante: { findMany: async (args: { where: { nomeNormalizado: { in: string[] } } }) => (args.where.nomeNormalizado.in.includes("BIAL") ? [{ id: "fBial" }] : []) },
      produto: { findMany: async (args: { where: { fabricanteId: { in: string[] } } }) => args.where.fabricanteId.in.map((id: string) => ({ id: `produto-de-${id}` })) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const resultado = await resolverProdutoIdsPorLaboratoriosSelecionados(fake, ["grupo:gTeva", "BIAL"], async () => "garantia");
    eqSet(resultado, ["p-teva-1", "produto-de-fBial"], "H1: valor tipado (grupo:gTeva) e nome solto (BIAL) resolvidos e unidos correctamente");
  }

  console.log(`\n${ok} ok, ${ko} falhas`);
  process.exit(ko === 0 ? 0 : 1);
}

principal();
