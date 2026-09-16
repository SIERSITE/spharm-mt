/**
 * scripts/tests/test-vendas-apenas-com-stock.ts
 *
 * Correcção (2026-09): "Apenas com stock", no Relatório de Vendas, tinha
 * a lógica ao contrário.
 *
 * ── Causa ─────────────────────────────────────────────────────────────
 *
 * `getVendasData` (lib/vendas-data.ts) constrói o universo do relatório
 * EXCLUSIVAMENTE a partir do ledger de vendas (`VendaMensal`/
 * `IngestVendaLinhaRaw`, com `HAVING <> 0`) — um produto sem qualquer
 * venda líquida no período nunca chegava a existir no resultado, стock
 * ou não. "Apenas com stock" era depois um filtro 100% client-side
 * (`existencia <= 0` a excluir) aplicado POR CIMA desse universo já
 * restrito — o que só consegue ESTREITAR, nunca alargar. Na prática, o
 * toggle comportava-se sempre como `vendas > 0 AND stock > 0`, quando o
 * pedido sempre foi `vendas > 0 OR stock > 0`.
 *
 * ── Correcção ─────────────────────────────────────────────────────────
 *
 * `getVendasData` passou a aceitar `filters.apenasComStock`: quando
 * activo, faz uma segunda consulta a `ProdutoFarmacia` (stockAtual > 0),
 * com os MESMOS pré-filtros de produto/farmácia/distribuidor, e
 * sintetiza uma linha para cada par (produto, farmácia) que tem stock
 * mas NÃO tem venda no período — meses e total a zero, nunca inventados,
 * com PVP/custo/fabricante/farmácia reais.
 *
 * Esta suite prova o cenário pedido, ponta-a-ponta contra
 * `getVendasData` com um Prisma falso (sem BD viva — mesmo padrão de
 * `test-fabricante-correcao-tier-aware.ts`):
 *   A: vendas=10, stock=5  → aparece
 *   B: vendas=10, stock=0  → aparece
 *   C: vendas=0,  stock=5  → aparece, com meses/total a ZERO
 *   D: vendas=0,  stock=0  → não aparece
 * e que os restantes filtros (fabricante, farmácia) continuam a
 * aplicar-se às linhas que só existem por causa do stock.
 *
 * Corre com: npx tsx scripts/tests/test-vendas-apenas-com-stock.ts
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

// ─────────────────────────────────────────────────────────────────────────
// Fixture — sem BD: 2 farmácias, 5 produtos (A-D do enunciado + E, só
// para o teste de farmácia), ledger de vendas só com A e B.
// ─────────────────────────────────────────────────────────────────────────

const FARMACIAS = [
  { id: "f1", nome: "Farmácia Silveirense", estado: "ATIVO" },
  { id: "f2", nome: "Farmácia Segurado", estado: "ATIVO" },
];

const FABRICANTES = [
  { id: "fabX", nomeNormalizado: "FABRICANTE X" },
  { id: "fabY", nomeNormalizado: "FABRICANTE Y" },
];

type ProdutoFake = {
  id: string;
  cnp: number;
  designacao: string;
  fabricanteId: string | null;
  fabricante: { nomeNormalizado: string } | null;
  classificacaoNivel1: { nome: string } | null;
  classificacaoNivel2: { nome: string } | null;
  utilizacoes: { utilizacao: { slug: string } }[];
};

const PRODUTOS: ProdutoFake[] = [
  { id: "pA", cnp: 1000001, designacao: "Produto A", fabricanteId: "fabX", fabricante: { nomeNormalizado: "FABRICANTE X" }, classificacaoNivel1: null, classificacaoNivel2: null, utilizacoes: [] },
  { id: "pB", cnp: 1000002, designacao: "Produto B", fabricanteId: "fabX", fabricante: { nomeNormalizado: "FABRICANTE X" }, classificacaoNivel1: null, classificacaoNivel2: null, utilizacoes: [] },
  { id: "pC", cnp: 1000003, designacao: "Produto C", fabricanteId: "fabY", fabricante: { nomeNormalizado: "FABRICANTE Y" }, classificacaoNivel1: null, classificacaoNivel2: null, utilizacoes: [] },
  { id: "pD", cnp: 1000004, designacao: "Produto D", fabricanteId: "fabX", fabricante: { nomeNormalizado: "FABRICANTE X" }, classificacaoNivel1: null, classificacaoNivel2: null, utilizacoes: [] },
  { id: "pE", cnp: 1000005, designacao: "Produto E (só em f2)", fabricanteId: "fabX", fabricante: { nomeNormalizado: "FABRICANTE X" }, classificacaoNivel1: null, classificacaoNivel2: null, utilizacoes: [] },
];

type PfFake = {
  produtoId: string;
  farmaciaId: string;
  stockAtual: number;
  pvp: number | null;
  pmc: number | null;
  puc: number | null;
  fornecedorOrigem: string | null;
};

const PF: PfFake[] = [
  // A: vendas=10 (ver AGG_ROWS), stock=5 → aparece sempre
  { produtoId: "pA", farmaciaId: "f1", stockAtual: 5, pvp: 6.66, pmc: 3.5, puc: null, fornecedorOrigem: "Distribuidor 1" },
  // B: vendas=10, stock=0 → aparece sempre (tem venda)
  { produtoId: "pB", farmaciaId: "f1", stockAtual: 0, pvp: 6.66, pmc: 3.5, puc: null, fornecedorOrigem: "Distribuidor 1" },
  // C: vendas=0, stock=5 → só aparece com apenasComStock=true
  { produtoId: "pC", farmaciaId: "f1", stockAtual: 5, pvp: 7.77, pmc: 4.0, puc: null, fornecedorOrigem: "Distribuidor 1" },
  // D: vendas=0, stock=0 → nunca aparece
  { produtoId: "pD", farmaciaId: "f1", stockAtual: 0, pvp: 8.88, pmc: null, puc: null, fornecedorOrigem: "Distribuidor 1" },
  // E: só tem ProdutoFarmacia em f2, nunca em f1 — para o teste de farmácia.
  { produtoId: "pE", farmaciaId: "f2", stockAtual: 5, pvp: 9.99, pmc: 5.0, puc: null, fornecedorOrigem: "Distribuidor 1" },
];

// Ledger de vendas: só A e B venderam, em Janeiro/2026, na f1.
const AGG_ROWS = [
  { produtoId: "pA", farmaciaId: "f1", ano: 2026, mes: 1, quantidade: 10, valorBruto: 66.6 },
  { produtoId: "pB", farmaciaId: "f1", ano: 2026, mes: 1, quantidade: 10, valorBruto: 66.6 },
];

function matchIn(campo: unknown, where: { in?: unknown[] } | undefined): boolean {
  if (!where?.in) return true;
  return where.in.includes(campo);
}

function fakePrisma() {
  const chamadas = { queryRaw: 0, produtoFarmaciaFindMany: 0, produtoFindMany: 0 };
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
    classificacao: {
      findMany: async () => {
        throw new Error("não esperado neste teste — nenhum filtro de categoria está activo");
      },
    },
    fabricante: {
      findMany: async (args: { where?: { nomeNormalizado?: { in?: string[] }; estado?: string } }) => {
        return FABRICANTES.filter((f) => matchIn(f.nomeNormalizado, args?.where?.nomeNormalizado));
      },
    },
    produto: {
      findMany: async (args: { where?: { id?: { in?: string[] }; fabricanteId?: { in?: string[] } } }) => {
        chamadas.produtoFindMany++;
        const where = args?.where;
        return PRODUTOS.filter((p) => {
          if (!matchIn(p.id, where?.id)) return false;
          if (!matchIn(p.fabricanteId, where?.fabricanteId)) return false;
          return true;
        });
      },
    },
    produtoFarmacia: {
      findMany: async (args: {
        where?: {
          produtoId?: { in?: string[] };
          farmaciaId?: { in?: string[] };
          stockAtual?: { gt?: number };
          fornecedorOrigem?: { in?: string[] };
        };
      }) => {
        chamadas.produtoFarmaciaFindMany++;
        const where = args?.where;
        return PF.filter((r) => {
          if (!matchIn(r.produtoId, where?.produtoId)) return false;
          if (!matchIn(r.farmaciaId, where?.farmaciaId)) return false;
          if (where?.stockAtual?.gt !== undefined && !(r.stockAtual > where.stockAtual.gt)) return false;
          if (!matchIn(r.fornecedorOrigem, where?.fornecedorOrigem)) return false;
          return true;
        });
      },
    },
    // Único caminho SQL usado nestes testes: a janela é sempre um mês
    // civil inteiro (ver `from`/`to` abaixo), por isso só `mensal()` é
    // chamada — nunca `porLinhas()` nem a pesquisa (`pesquisa` não é
    // usado por nenhum destes filtros).
    //
    // `mensal()` embute `produtoIdFilter` no SQL via
    // `Prisma.sql\`...AND vm."produtoId" = ANY(${produtoIdFilter})\`` — um
    // fake fiel tem de respeitar esse filtro, senão um teste que filtra
    // por fabricante recebe vendas de OUTRO fabricante e mascara um erro
    // real. `Prisma.Sql.values` traz os valores interpolados na ordem em
    // que aparecem no template; o `produtoIdFilter` é o único array de
    // strings de entre eles que corresponde a IDs de produto conhecidos.
    $queryRaw: async (sql: { values?: unknown[] }) => {
      chamadas.queryRaw++;
      const idsConhecidos = new Set(PRODUTOS.map((p) => p.id));
      const produtoIdArray = (sql?.values ?? []).find(
        (v): v is string[] =>
          Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && idsConhecidos.has(x)),
      );
      if (produtoIdArray) {
        return AGG_ROWS.filter((r) => produtoIdArray.includes(r.produtoId));
      }
      return AGG_ROWS;
    },
  };
  return { prisma: prisma as unknown as PrismaClient, chamadas };
}

// Janela = Janeiro/2026 inteiro → mês-alinhada → só `mensal()` corre.
// `farmaciaNomes` fixo a f1: sem isto, "todas as activas" incluiria f2
// (onde só o produto E tem stock) e os cenários A-D deixariam de ser
// sobre uma farmácia só — E tem o seu próprio teste dedicado, abaixo.
const FILTROS_BASE = { from: "2026-01-01", to: "2026-01-31", farmaciaNomes: ["Farmácia Silveirense"] };

function linhaPor(rows: Awaited<ReturnType<typeof getVendasData>>["rows"], codigo: string) {
  return rows.find((r) => r.codigo === codigo);
}

async function main() {
  // ═══════════════════════════════════════════════════════════════════
  // A. apenasComStock DESLIGADO — comportamento normal, inalterado
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n=== A. apenasComStock desligado: só A e B (o comportamento de sempre) ===");
  {
    const { prisma } = fakePrisma();
    const result = await getVendasData({ ...FILTROS_BASE }, prisma);
    eq("2 linhas (A e B) — C e D continuam de fora", result.rows.length, 2);
    ok("A está presente", !!linhaPor(result.rows, "1000001"));
    ok("B está presente", !!linhaPor(result.rows, "1000002"));
    ok("C está AUSENTE (sem o toggle, sem vendas não aparece)", !linhaPor(result.rows, "1000003"));
    ok("D está AUSENTE", !linhaPor(result.rows, "1000004"));
  }

  // ═══════════════════════════════════════════════════════════════════
  // B. apenasComStock LIGADO — os 4 casos exactos do enunciado
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n=== B. apenasComStock ligado: A, B, C aparecem; D não (vendas>0 OR stock>0) ===");
  {
    const { prisma } = fakePrisma();
    const result = await getVendasData({ ...FILTROS_BASE, apenasComStock: true }, prisma);

    eq("3 linhas visíveis (A, B, C) — D continua de fora", result.rows.length, 3);

    const a = linhaPor(result.rows, "1000001");
    ok("A (vendas=10, stock=5) aparece", !!a);
    eq("A: totalVendas = 10", a?.totalVendas, 10);
    eq("A: existencia = 5", a?.existencia, 5);

    const b = linhaPor(result.rows, "1000002");
    ok("B (vendas=10, stock=0) aparece", !!b);
    eq("B: totalVendas = 10", b?.totalVendas, 10);
    eq("B: existencia = 0", b?.existencia, 0);

    const c = linhaPor(result.rows, "1000003");
    ok("C (vendas=0, stock=5) aparece — é o caso que estava a falhar", !!c);
    eq("C: totalVendas = 0 (nunca 'ganha' vendas por causa do stock)", c?.totalVendas, 0);
    eq("C: existencia = 5 (stock real)", c?.existencia, 5);
    ok(
      "C: TODOS os meses do período estão a zero — nenhuma venda fictícia",
      (c?.meses ?? []).length > 0 && (c?.meses ?? []).every((m) => m.quantidade === 0),
      JSON.stringify(c?.meses),
    );
    eq("C: descrição normal ('Produto C')", c?.descricao, "Produto C");
    eq("C: PVP real (7.77)", c?.pvp, 7.77);
    eq("C: custo unitário estimado real (PMC=4.0)", c?.custoUnitarioEstimado, 4.0);
    eq("C: custo estimado = 0 (0 unidades × custo conhecido)", c?.custoEstimado, 0);
    eq("C: fabricante real ('FABRICANTE Y')", c?.fabricante, "FABRICANTE Y");
    eq("C: farmácia real ('Farmácia Silveirense')", c?.farmacia, "Farmácia Silveirense");

    ok("D (vendas=0, stock=0) NÃO aparece", !linhaPor(result.rows, "1000004"));
  }

  // ═══════════════════════════════════════════════════════════════════
  // C. As linhas só-de-stock respeitam os RESTANTES filtros
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n=== C. Linhas só-de-stock respeitam fabricante e farmácia ===");
  {
    // Fabricante: filtrar por "FABRICANTE X" (A, B, D) exclui C
    // (FABRICANTE Y) mesmo com apenasComStock ligado — C não pode
    // "escapar" ao filtro de fabricante só por vir do caminho do stock.
    const { prisma } = fakePrisma();
    const result = await getVendasData(
      { ...FILTROS_BASE, apenasComStock: true, fabricantes: ["FABRICANTE X"] },
      prisma,
    );
    eq("com fabricante=FABRICANTE X: só A e B (C é de outro fabricante)", result.rows.length, 2);
    ok("C continua ausente — o filtro de fabricante aplicou-se à linha só-de-stock", !linhaPor(result.rows, "1000003"));
  }
  {
    // O inverso: filtrar só por "FABRICANTE Y" (só C) tem de TRAZER C
    // mesmo sem vendas — prova que a inclusão respeita o filtro, não só
    // a exclusão.
    const { prisma } = fakePrisma();
    const result = await getVendasData(
      { ...FILTROS_BASE, apenasComStock: true, fabricantes: ["FABRICANTE Y"] },
      prisma,
    );
    eq("com fabricante=FABRICANTE Y: só C (só-de-stock, mas do fabricante certo)", result.rows.length, 1);
    ok("C está presente", !!linhaPor(result.rows, "1000003"));
  }
  {
    // Farmácia: E só tem stock em f2. Pedir só f1 não pode trazer E.
    const { prisma } = fakePrisma();
    const resultF1 = await getVendasData(
      { ...FILTROS_BASE, apenasComStock: true, farmaciaNomes: ["Farmácia Silveirense"] },
      prisma,
    );
    ok("E (só stock em f2) não aparece quando o filtro pede só f1", !linhaPor(resultF1.rows, "1000005"));

    const resultF2 = await getVendasData(
      { ...FILTROS_BASE, apenasComStock: true, farmaciaNomes: ["Farmácia Segurado"] },
      prisma,
    );
    const e = linhaPor(resultF2.rows, "1000005");
    ok("E aparece quando o filtro pede f2 (onde realmente tem stock)", !!e);
    eq("E: totalVendas = 0 (nunca vendeu em lado nenhum)", e?.totalVendas, 0);
    eq("E: existencia = 5", e?.existencia, 5);
    eq("E: farmácia = 'Farmácia Segurado'", e?.farmacia, "Farmácia Segurado");
  }

  // ═══════════════════════════════════════════════════════════════════
  // D. Universo de vendas vazio + apenasComStock — não corta cedo demais
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n=== D. Sem NENHUMA venda no período, apenasComStock ainda traz quem tem stock ===");
  {
    // Fabricante "FABRICANTE Y" tem zero vendas no ledger (só pC, que
    // nunca vende) — o corte antigo (`aggRows.length === 0 → []`)
    // devolvia vazio aqui. Com a correcção, C continua a aparecer.
    const { prisma } = fakePrisma();
    const result = await getVendasData(
      { ...FILTROS_BASE, apenasComStock: true, fabricantes: ["FABRICANTE Y"] },
      prisma,
    );
    eq("mesmo com zero linhas no ledger para este fabricante, C aparece", result.rows.length, 1);
  }
  console.log("\n=== D2. Sem apenasComStock, universo de vendas vazio continua vazio (sem regressão) ===");
  {
    const { prisma } = fakePrisma();
    const result = await getVendasData({ ...FILTROS_BASE, fabricantes: ["FABRICANTE Y"] }, prisma);
    eq("sem o toggle, fabricante sem vendas dá relatório vazio — comportamento de sempre", result.rows.length, 0);
  }

  console.log(`\n${fail === 0 ? "PASSOU" : "FALHOU"} — ${pass} OK, ${fail} falhas\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
