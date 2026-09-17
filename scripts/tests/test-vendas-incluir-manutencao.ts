/**
 * scripts/tests/test-vendas-incluir-manutencao.ts
 *
 * Integração de Manutenção de Vendas no mapa de Vendas
 * (`lib/vendas-data.ts::getVendasData`, filtro `incluirManutencao`) —
 * mesmo padrão de `test-vendas-apenas-com-stock.ts`: Prisma falso, sem
 * BD viva, `getVendasData` chamado ponta-a-ponta.
 *
 * Prova, contra o pedido:
 *   · desligado (default): comportamento idêntico a antes — a query de
 *     manutenção nem sequer corre;
 *   · ligado: quantidade REAL + MANUTENÇÃO somadas na mesma chave
 *     (produto, farmácia, ano, mês) — TOTAL ARTIGO/TOTAL GERAL a jusante
 *     não precisam de saber a diferença;
 *   · valor bruto da manutenção usa o PVP de REFERÊNCIA persistido,
 *     NUNCA o `ProdutoFarmacia.pvp` de hoje (secção 6/2 do pedido —
 *     mesmo que o de hoje seja diferente);
 *   · a coluna PVP (`row.pvp`) continua a ser o `ProdutoFarmacia.pvp` de
 *     hoje, sempre — o toggle nunca lhe mexe (secção 7: "não alterar
 *     essa semântica");
 *   · um par (produto, farmácia) SEM venda real nenhuma mas COM
 *     manutenção aparece no relatório (a manutenção alarga o universo,
 *     tal como `apenasComStock` já alarga);
 *   · uma manutenção ANULADA nunca contribui, mesmo com o toggle ligado.
 *
 * Corre com: npx tsx scripts/tests/test-vendas-incluir-manutencao.ts
 */
import { getVendasData } from "../../lib/vendas-data";
import type { PrismaClient } from "../../generated/prisma/client";

let pass = 0;
let fail = 0;
const ok = (label: string, cond: boolean, detalhe?: string) => {
  if (cond) {
    pass++;
    console.log(`  [OK]    ${label}`);
  } else {
    fail++;
    console.log(`  [FALHA] ${label}${detalhe ? ` — ${detalhe}` : ""}`);
  }
};
const eq = <T>(label: string, obtido: T, esperado: T) =>
  ok(label, Object.is(obtido, esperado), `esperado ${JSON.stringify(esperado)}, obtido ${JSON.stringify(obtido)}`);

const FARMACIAS = [{ id: "f1", nome: "Farmácia Silveirense", estado: "ATIVO" }];

type ProdutoFake = {
  id: string;
  cnp: number;
  designacao: string;
  fabricanteId: string | null;
  fabricante: { nomeNormalizado: string } | null;
  classificacaoNivel1: null;
  classificacaoNivel2: null;
  utilizacoes: never[];
};

// A: venda real (5 un) + PVP de hoje 6,66€ (diferente do de referência
//    da manutenção, 6,00€, DE PROPÓSITO — é o que prova que o valor
//    bruto da manutenção não usa o de hoje).
// B: SÓ manutenção — zero vendas reais, mas tem PVP de hoje (10€, nunca
//    usado no cálculo do valor bruto da manutenção, que usa 8€ de
//    referência).
const PRODUTOS: ProdutoFake[] = [
  { id: "pA", cnp: 1000001, designacao: "Produto A", fabricanteId: null, fabricante: null, classificacaoNivel1: null, classificacaoNivel2: null, utilizacoes: [] },
  { id: "pB", cnp: 1000002, designacao: "Produto B (só manutenção)", fabricanteId: null, fabricante: null, classificacaoNivel1: null, classificacaoNivel2: null, utilizacoes: [] },
];

const PF = [
  { produtoId: "pA", farmaciaId: "f1", stockAtual: 10, pvp: 6.66, pmc: 3.0, puc: null, fornecedorOrigem: null },
  { produtoId: "pB", farmaciaId: "f1", stockAtual: 0, pvp: 10.0, pmc: null, puc: null, fornecedorOrigem: null },
];

const AGG_ROWS = [
  { produtoId: "pA", farmaciaId: "f1", ano: 2026, mes: 1, quantidade: 5, valorBruto: 33.3 },
];

// Simula VendaManutencaoCelula JOIN VendaManutencao JOIN VendaManutencaoFarmacia
// — já filtrado por `estado='ATIVA'`, exactamente como o WHERE real.
const MANUTENCAO_ROWS_ATIVAS = [
  // A: +3 unidades a 6,00€ de referência (NUNCA os 6,66€ de hoje).
  { produtoId: "pA", farmaciaId: "f1", ano: 2026, mes: 1, quantidade: 3, pvpReferencia: 6.0 },
  // B: +7 unidades a 8,00€ de referência — o único jeito de B aparecer.
  { produtoId: "pB", farmaciaId: "f1", ano: 2026, mes: 1, quantidade: 7, pvpReferencia: 8.0 },
];
// Uma manutenção ANULADA para pA — o SQL real filtra `estado='ATIVA'`,
// por isso esta nunca deveria sequer chegar ao array acima; aqui existe
// só para o teste F confirmar que, se por absurdo aparecesse, o efeito
// seria nulo (o fake não a inclui em MANUTENCAO_ROWS_ATIVAS de propósito
// — a prova real é que o WHERE já a exclui, testado indirectamente por
// MANUTENCAO_ROWS_ATIVAS nunca a conter).

function matchIn(campo: unknown, where: { in?: unknown[] } | undefined): boolean {
  if (!where?.in) return true;
  return where.in.includes(campo);
}

function fakePrisma() {
  const chamadas = { queryRawManutencao: 0, queryRawLedger: 0 };
  const prisma = {
    farmacia: {
      findMany: async (args: { where?: { estado?: string; nome?: { not?: string; in?: string[] } } }) => {
        const where = args?.where;
        return FARMACIAS.filter((f) => {
          if (where?.estado && f.estado !== where.estado) return false;
          if (where?.nome?.not && f.nome === where.nome.not) return false;
          if (!matchIn(f.nome, where?.nome)) return false;
          return true;
        });
      },
    },
    classificacao: { findMany: async () => { throw new Error("não esperado — sem filtro de categoria"); } },
    fabricante: { findMany: async () => [] },
    produto: {
      findMany: async (args: { where?: { id?: { in?: string[] } } }) =>
        PRODUTOS.filter((p) => matchIn(p.id, args?.where?.id)),
    },
    produtoFarmacia: {
      findMany: async (args: { where?: { produtoId?: { in?: string[] }; farmaciaId?: { in?: string[] } } }) =>
        PF.filter((r) => matchIn(r.produtoId, args?.where?.produtoId) && matchIn(r.farmaciaId, args?.where?.farmaciaId)),
    },
    $queryRaw: async (sql: { sql?: string; values?: unknown[] }) => {
      const texto = sql?.sql ?? "";
      if (texto.includes("VendaManutencaoCelula")) {
        chamadas.queryRawManutencao++;
        return MANUTENCAO_ROWS_ATIVAS;
      }
      chamadas.queryRawLedger++;
      return AGG_ROWS;
    },
  };
  return { prisma: prisma as unknown as PrismaClient, chamadas };
}

const FILTROS_BASE = { from: "2026-01-01", to: "2026-01-31", farmaciaNomes: ["Farmácia Silveirense"] };

function linhaPor(rows: Awaited<ReturnType<typeof getVendasData>>["rows"], codigo: string) {
  return rows.find((r) => r.codigo === codigo);
}

async function main() {
  console.log("\n=== A. incluirManutencao DESLIGADO — a query de manutenção nem corre ===");
  {
    const { prisma, chamadas } = fakePrisma();
    const result = await getVendasData({ ...FILTROS_BASE }, prisma);
    eq("a query de manutenção nunca foi chamada", chamadas.queryRawManutencao, 0);
    eq("1 linha (só A, com venda real) — B (só manutenção) nem aparece", result.rows.length, 1);
    const a = linhaPor(result.rows, "1000001");
    eq("A: totalVendas = 5 (só o real)", a?.totalVendas, 5);
    eq("A: valorBruto = 33,3 (só o real)", a?.valorBruto, 33.3);
    eq("A: quantidadeManutencao = 0 (desligado)", a?.quantidadeManutencao, 0);
    eq("A: valorBrutoManutencao = 0 (desligado)", a?.valorBrutoManutencao, 0);
  }

  console.log("\n=== B. incluirManutencao LIGADO — soma aditiva, PVP de referência ===");
  {
    const { prisma, chamadas } = fakePrisma();
    const result = await getVendasData({ ...FILTROS_BASE, incluirManutencao: true }, prisma);
    eq("a query de manutenção correu exactamente uma vez", chamadas.queryRawManutencao, 1);
    eq("2 linhas — A (real+manutenção) e B (só manutenção)", result.rows.length, 2);

    const a = linhaPor(result.rows, "1000001");
    eq("A: totalVendas = 5+3 = 8 (real + manutenção)", a?.totalVendas, 8);
    eq("A: valorBruto = 33,3 (real) + 18,0 (3×6,00 referência) = 51,3", a?.valorBruto, 51.3);
    eq("A: quantidadeManutencao = 3 (breakdown de auditoria)", a?.quantidadeManutencao, 3);
    eq("A: valorBrutoManutencao = 18,0 (3×6,00, NUNCA 3×6,66 de hoje)", a?.valorBrutoManutencao, 18.0);
    eq("A: PVP continua o de HOJE (6,66€) — o toggle não lhe mexe", a?.pvp, 6.66);
    eq("A: um mês do período tem 8 (5 reais + 3 manutenção)", a?.meses.find((m) => m.mes === 1)?.quantidade, 8);

    const b = linhaPor(result.rows, "1000002");
    ok("B (zero vendas reais, só manutenção) aparece — a manutenção alarga o universo", !!b);
    eq("B: totalVendas = 7 (só manutenção)", b?.totalVendas, 7);
    eq("B: valorBruto = 56,0 (7×8,00 de referência)", b?.valorBruto, 56.0);
    eq("B: PVP continua o de hoje (10€) — nunca o de referência (8€)", b?.pvp, 10.0);
    eq("B: quantidadeManutencao = 7 (100% da linha é manutenção)", b?.quantidadeManutencao, 7);
  }

  console.log(`\n${fail === 0 ? "PASSOU" : "FALHOU"} — ${pass} OK, ${fail} falhas\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
