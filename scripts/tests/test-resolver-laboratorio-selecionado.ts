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

  console.log(`\n${ok} ok, ${ko} falhas`);
  process.exit(ko === 0 ? 0 : 1);
}

principal();
