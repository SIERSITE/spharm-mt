/**
 * scripts/tests/test-orders-list-drafts.ts
 *
 * Cobre o requisito "a lista de rascunhos em /encomendas": um rascunho
 * criado em /encomendas/nova tem de aparecer aqui ANTES de ser
 * confirmado, com farmácia/utilizador/nLinhas/valor estimado/estado, e
 * ELIMINADA (soft-delete) continua fora da listagem normal por omissão.
 * Prisma FALSO — mesmo padrão dos outros testes deste módulo.
 */
import { readFileSync } from "node:fs";
import { loadOrderListData } from "../../lib/encomendas/orders-data";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  [OK]    ${msg}`); }
  else { failed++; console.log(`  [FALHA] ${msg}`); }
}
function eq(a: unknown, b: unknown, msg: string) {
  check(JSON.stringify(a) === JSON.stringify(b), `${msg} (esperado ${JSON.stringify(b)}, obtido ${JSON.stringify(a)})`);
}

type FakeLista = {
  id: string;
  nome: string;
  estado: string;
  estadoExport: string;
  farmaciaId: string;
  dataCriacao: Date;
  dataAtualizacao: Date;
  farmacia: { nome: string };
  criadoPor: { nome: string };
  linhas: { produtoId: string; quantidadeAjustada: number | null }[];
  outbox: null;
};

function passaFiltroEstado(l: FakeLista, estado: unknown): boolean {
  if (estado && typeof estado === "object" && "not" in (estado as object)) {
    return l.estado !== (estado as { not: string }).not;
  }
  if (typeof estado === "string") return l.estado === estado;
  return true;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeFakePrisma(listas: FakeLista[], pucPorPar: Map<string, number>): any {
  return {
    listaEncomenda: {
      findMany: async (args: { where: { estado?: unknown } }) =>
        listas.filter((l) => passaFiltroEstado(l, args.where.estado)).map((l) => ({
          ...l,
          _count: { linhas: l.linhas.length },
        })),
      count: async (args: { where: { estado?: unknown } }) =>
        listas.filter((l) => passaFiltroEstado(l, args.where.estado)).length,
    },
    farmacia: {
      findMany: async () => [{ id: "farm-1", nome: "Farmácia Central" }],
    },
    produtoFarmacia: {
      findMany: async () =>
        [...pucPorPar.entries()].map(([chave, puc]) => {
          const [produtoId, farmaciaId] = chave.split("::");
          return { produtoId, farmaciaId, puc };
        }),
    },
  };
}

async function principal() {
  console.log("A · rascunho aparece na listagem ANTES de ser confirmado (sem filtro de estado)");
  {
    const listas: FakeLista[] = [
      {
        id: "l-rascunho", nome: "Rascunho novo", estado: "RASCUNHO", estadoExport: "PENDENTE",
        farmaciaId: "farm-1", dataCriacao: new Date("2026-09-01"), dataAtualizacao: new Date("2026-09-20"),
        farmacia: { nome: "Farmácia Central" }, criadoPor: { nome: "Ana" },
        linhas: [{ produtoId: "p1", quantidadeAjustada: 10 }],
        outbox: null,
      },
    ];
    const prisma = makeFakePrisma(listas, new Map([["p1::farm-1", 2.5]]));
    const data = await loadOrderListData(prisma, {
      page: 1, pageSize: 25,
    });
    eq(data.orders.length, 1, "A1: 1 encomenda na listagem sem filtro de estado");
    eq(data.orders[0]?.estado, "RASCUNHO", "A2: é mesmo o rascunho");
  }

  console.log("\nB · ELIMINADA (soft-delete) fica fora da listagem por omissão");
  {
    const listas: FakeLista[] = [
      {
        id: "l-eliminada", nome: "Cancelada", estado: "ELIMINADA", estadoExport: "PENDENTE",
        farmaciaId: "farm-1", dataCriacao: new Date(), dataAtualizacao: new Date(),
        farmacia: { nome: "Farmácia Central" }, criadoPor: { nome: "Ana" },
        linhas: [], outbox: null,
      },
    ];
    const prisma = makeFakePrisma(listas, new Map());
    const data = await loadOrderListData(prisma, { page: 1, pageSize: 25 });
    eq(data.orders.length, 0, "B1: ELIMINADA não aparece sem filtro explícito");
  }

  console.log("\nC · valor estimado — completo, parcial e ausente");
  {
    const listas: FakeLista[] = [
      {
        id: "l-completo", nome: "Completo", estado: "RASCUNHO", estadoExport: "PENDENTE",
        farmaciaId: "farm-1", dataCriacao: new Date(), dataAtualizacao: new Date(),
        farmacia: { nome: "F" }, criadoPor: { nome: "U" },
        linhas: [{ produtoId: "p1", quantidadeAjustada: 4 }, { produtoId: "p2", quantidadeAjustada: 2 }],
        outbox: null,
      },
      {
        id: "l-parcial", nome: "Parcial", estado: "RASCUNHO", estadoExport: "PENDENTE",
        farmaciaId: "farm-1", dataCriacao: new Date(), dataAtualizacao: new Date(),
        farmacia: { nome: "F" }, criadoPor: { nome: "U" },
        linhas: [{ produtoId: "p1", quantidadeAjustada: 4 }, { produtoId: "p3-sem-puc", quantidadeAjustada: 9 }],
        outbox: null,
      },
      {
        id: "l-sem-valor", nome: "Sem valor", estado: "RASCUNHO", estadoExport: "PENDENTE",
        farmaciaId: "farm-1", dataCriacao: new Date(), dataAtualizacao: new Date(),
        farmacia: { nome: "F" }, criadoPor: { nome: "U" },
        linhas: [{ produtoId: "p3-sem-puc", quantidadeAjustada: 9 }],
        outbox: null,
      },
    ];
    const prisma = makeFakePrisma(listas, new Map([["p1::farm-1", 2], ["p2::farm-1", 5]]));
    const data = await loadOrderListData(prisma, { page: 1, pageSize: 25 });
    const completo = data.orders.find((o) => o.id === "l-completo");
    const parcial = data.orders.find((o) => o.id === "l-parcial");
    const semValor = data.orders.find((o) => o.id === "l-sem-valor");
    eq(completo?.valorEstimado, { total: 4 * 2 + 2 * 5, parcial: false }, "C1: valor completo = SUM(qtd × puc), parcial=false");
    eq(parcial?.valorEstimado, { total: 4 * 2, parcial: true }, "C2: valor parcial soma só as linhas com PUC, marca parcial=true");
    eq(semValor?.valorEstimado, null, "C3: nenhuma linha com PUC → null, nunca finge um valor de 0");
  }

  console.log("\nD · verificação estática — /encomendas mostra o que o pedido exige");
  const listClientSrc = readFileSync(new URL("../../components/encomendas/order-list-client.tsx", import.meta.url), "utf8");
  check(/Continuar/.test(listClientSrc), "D1: acção \"Continuar\" existe para rascunhos");
  check(/href=\{`\/encomendas\/\$\{o\.id\}`\}/.test(listClientSrc), "D2: \"Continuar\" aponta para o rascunho certo");
  check(/Valor estim/.test(listClientSrc), "D3: coluna de valor estimado existe");
  check(
    /fmtDate\(o\.estado === "RASCUNHO" \? o\.dataAtualizacao : o\.dataCriacao\)/.test(listClientSrc),
    "D4: rascunho mostra a data da ÚLTIMA GRAVAÇÃO (dataAtualizacao), não a de criação"
  );

  console.log(`\n${passed} ok, ${failed} falhas`);
  if (failed > 0) process.exit(1);
}

principal();
