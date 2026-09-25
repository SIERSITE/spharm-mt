/**
 * scripts/tests/test-encomenda-idempotencia.ts
 * createEncomendaWithOutbox com clientIdempotencyKey — Prisma falso em memória.
 */
import Module from "node:module";

// `server-only` só existe no build do Next — stub antes de carregar lib/ingest/orders.
const M = Module as unknown as { _resolveFilename: (r: string, ...a: unknown[]) => string };
const resolverOriginal = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "server-only" ? __filename : resolverOriginal.call(this, request, ...rest);
};

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  [OK]    ${msg}`); }
  else { failed++; console.log(`  [FALHA] ${msg}`); }
}

function fakePrisma(opts: { racePeloVencedor?: boolean } = {}) {
  const listas: Array<{ id: string; farmaciaId: string; criadoPorId: string; clientIdempotencyKey: string | null }> = [];
  let seq = 0;
  const modelo = {
    findUnique: async ({ where }: { where: { clientIdempotencyKey: string } }) => {
      const l = listas.find((x) => x.clientIdempotencyKey === where.clientIdempotencyKey);
      return l ? { ...l, outbox: null } : null;
    },
    create: async ({ data }: { data: { farmaciaId: string; criadoPorId: string; clientIdempotencyKey?: string } }) => {
      const k = data.clientIdempotencyKey ?? null;
      if (k && listas.some((x) => x.clientIdempotencyKey === k)) {
        throw Object.assign(new Error("Unique constraint"), { code: "P2002" });
      }
      const l = { id: `L${++seq}`, farmaciaId: data.farmaciaId, criadoPorId: data.criadoPorId, clientIdempotencyKey: k };
      listas.push(l);
      return { ...l, nome: "n", dataCriacao: new Date(), linhas: [] };
    },
  };
  const prisma = {
    listaEncomenda: modelo,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ listaEncomenda: modelo }),
  };
  return { prisma: prisma as never, listas, modelo, opts };
}

const base = {
  farmaciaId: "F1", criadoPorId: "U1", nome: "x", finalize: false,
  linhas: [{ produtoId: "p1", quantidadeAjustada: 1 }],
};

(async () => {
  const { createEncomendaWithOutbox } = await import("../../lib/ingest/orders");
  console.log("\nA · mesma chave → um só rascunho");
  {
    const { prisma, listas } = fakePrisma();
    const a = await createEncomendaWithOutbox(prisma, "t", { ...base, clientIdempotencyKey: "k".repeat(20) });
    const b = await createEncomendaWithOutbox(prisma, "t", { ...base, clientIdempotencyKey: "k".repeat(20) });
    check(a.listaEncomendaId === b.listaEncomendaId, "A1: retry devolve o mesmo id");
    check(listas.length === 1, "A2: só uma lista criada");
  }

  console.log("\nB · corrida: findUnique falha mas o INSERT choca em P2002");
  {
    const { prisma, listas, modelo } = fakePrisma();
    const k = "r".repeat(20);
    await createEncomendaWithOutbox(prisma, "t", { ...base, clientIdempotencyKey: k });
    const orig = modelo.findUnique;
    let primeira = true;
    modelo.findUnique = async (a) => { if (primeira) { primeira = false; return null; } return orig(a); };
    const r = await createEncomendaWithOutbox(prisma, "t", { ...base, clientIdempotencyKey: k });
    check(r.listaEncomendaId === "L1" && listas.length === 1, "B1: P2002 resolve para o vencedor, sem duplicar");
  }

  console.log("\nC · chave de outra farmácia/utilizador é recusada");
  {
    const { prisma } = fakePrisma();
    const k = "c".repeat(20);
    await createEncomendaWithOutbox(prisma, "t", { ...base, clientIdempotencyKey: k });
    let erro = false;
    try { await createEncomendaWithOutbox(prisma, "t", { ...base, farmaciaId: "F2", clientIdempotencyKey: k }); }
    catch { erro = true; }
    check(erro, "C1: reutilização cross-farmácia lança");
  }

  console.log("\nD · sem chave, cada chamada cria a sua lista");
  {
    const { prisma, listas } = fakePrisma();
    await createEncomendaWithOutbox(prisma, "t", base);
    await createEncomendaWithOutbox(prisma, "t", base);
    check(listas.length === 2, "D1: comportamento antigo intacto");
  }

  console.log(`\n${passed} ok, ${failed} falhas`);
  if (failed > 0) process.exit(1);
})();
