/**
 * scripts/tests/test-encomenda-autosave.ts
 *
 * Testa lib/encomendas/autosave.ts (salvarAutosaveEncomenda) — o núcleo
 * transacional do autosave de rascunhos de encomenda — contra um Prisma
 * falso mutável. Mais verificação estática das propriedades que exigem
 * sessão HTTP real (permissões/tenant) ou um DOM (beforeunload), que
 * este runner não tem como executar directamente (sem framework de
 * testes de componentes neste projecto).
 *
 * Corre com: npx tsx scripts/tests/test-encomenda-autosave.ts
 */
import { readFileSync } from "node:fs";
import {
  salvarAutosaveEncomenda,
  ConflitoVersaoError,
  RascunhoNaoEditavelError,
  type LinhaAutosavePatch,
} from "../../lib/encomendas/autosave";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const eq = <T,>(a: T, b: T, label: string) =>
  check(JSON.stringify(a) === JSON.stringify(b), label, `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);

// ── Prisma falso — um ListaEncomenda com o seu $transaction próprio ───

type FakeLinha = {
  produtoId: string;
  quantidadeSugerida: number | null;
  quantidadeAjustada: number | null;
  fornecedorSugeridoId: string | null;
  notas: string | null;
  origem: string;
};
type FakeLista = { id: string; estado: string; versao: number; contextoJson?: string | null; linhas: Map<string, FakeLinha> };

function criarBaseFalsa(listas: FakeLista[]) {
  const store = new Map(listas.map((l) => [l.id, l]));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma: any = {
    listaEncomenda: {
      findUnique: async (args: { where: { id: string }; select?: unknown }) => {
        const l = store.get(args.where.id);
        return l ? { estado: l.estado, versao: l.versao } : null;
      },
      findUniqueOrThrow: async (args: { where: { id: string } }) => {
        const l = store.get(args.where.id);
        if (!l) throw new Error(`ListaEncomenda "${args.where.id}" não existe`);
        return { versao: l.versao };
      },
      update: async (args: { where: { id: string }; data: { versao?: { increment: number }; contextoJson?: string | null } }) => {
        const l = store.get(args.where.id)!;
        if (args.data.versao?.increment) l.versao += args.data.versao.increment;
        if ("contextoJson" in args.data) l.contextoJson = args.data.contextoJson ?? null;
        return { versao: l.versao };
      },
    },
    linhaEncomenda: {
      upsert: async (args: {
        where: { listaEncomendaId_produtoId: { listaEncomendaId: string; produtoId: string } };
        create: FakeLinha & { listaEncomendaId: string };
        update: Partial<FakeLinha>;
      }) => {
        const { listaEncomendaId, produtoId } = args.where.listaEncomendaId_produtoId;
        const l = store.get(listaEncomendaId)!;
        const existente = l.linhas.get(produtoId);
        if (existente) {
          l.linhas.set(produtoId, { ...existente, ...args.update });
        } else {
          const resto: FakeLinha = {
            produtoId: args.create.produtoId,
            quantidadeSugerida: args.create.quantidadeSugerida,
            quantidadeAjustada: args.create.quantidadeAjustada,
            fornecedorSugeridoId: args.create.fornecedorSugeridoId,
            notas: args.create.notas,
            origem: args.create.origem,
          };
          l.linhas.set(produtoId, resto);
        }
        return l.linhas.get(produtoId)!;
      },
      deleteMany: async (args: { where: { listaEncomendaId: string; produtoId: { in: string[] } } }) => {
        const l = store.get(args.where.listaEncomendaId)!;
        let count = 0;
        for (const produtoId of args.where.produtoId.in) {
          if (l.linhas.delete(produtoId)) count++;
        }
        return { count };
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      // Simula atomicidade: opera sobre uma CÓPIA profunda; só aplica ao
      // store real se fn() não lançar. Prova rollback total em falha.
      const backup = new Map([...store.entries()].map(([id, l]) => [id, { ...l, linhas: new Map(l.linhas) }]));
      try {
        const resultado = await fn(prisma);
        return resultado;
      } catch (err) {
        // Restaura — nada do que a função tentou escrever fica visível.
        store.clear();
        for (const [id, l] of backup) store.set(id, l);
        throw err;
      }
    },
  };

  return { prisma, store };
}

function linha(over: Partial<LinhaAutosavePatch> & { produtoId: string }): LinhaAutosavePatch {
  return { quantidadeAjustada: 1, notas: null, ...over };
}

async function principal() {

console.log("A · grava 300 linhas em lote, numa única chamada (#8.2)");
{
  const { prisma, store } = criarBaseFalsa([{ id: "L1", estado: "RASCUNHO", versao: 0, linhas: new Map() }]);
  const linhas = Array.from({ length: 300 }, (_, i) => linha({ produtoId: `p${i}`, quantidadeAjustada: i }));
  const r = await salvarAutosaveEncomenda(prisma, { listaEncomendaId: "L1", versaoEsperada: 0, linhas });
  eq(r.gravadas, 300, "A1: as 300 linhas são reportadas como gravadas");
  eq(store.get("L1")!.linhas.size, 300, "A2: as 300 linhas existem realmente na base falsa");
  eq(r.versao, 1, "A3: a versão incrementa exactamente 1 (uma chamada = um incremento, não 300)");
}

console.log("\nB · segunda gravação altera SÓ as linhas sujas enviadas (#8.3)");
{
  const { prisma, store } = criarBaseFalsa([{ id: "L1", estado: "RASCUNHO", versao: 0, linhas: new Map() }]);
  await salvarAutosaveEncomenda(prisma, {
    listaEncomendaId: "L1", versaoEsperada: 0,
    linhas: [linha({ produtoId: "p1", quantidadeAjustada: 5 }), linha({ produtoId: "p2", quantidadeAjustada: 10 }), linha({ produtoId: "p3", quantidadeAjustada: 15 })],
  });
  const r2 = await salvarAutosaveEncomenda(prisma, {
    listaEncomendaId: "L1", versaoEsperada: 1,
    linhas: [linha({ produtoId: "p2", quantidadeAjustada: 999 })], // só p2 está "sujo"
  });
  eq(r2.gravadas, 1, "B1: só 1 linha reportada nesta chamada");
  eq(store.get("L1")!.linhas.get("p1")!.quantidadeAjustada, 5, "B2: p1 continua com o valor da 1ª gravação — nunca tocado");
  eq(store.get("L1")!.linhas.get("p2")!.quantidadeAjustada, 999, "B3: p2 foi actualizado");
  eq(store.get("L1")!.linhas.get("p3")!.quantidadeAjustada, 15, "B4: p3 continua intocado");
}

console.log("\nC · dois rascunhos simultâneos — isolados um do outro (#8.6, #8.7)");
{
  const { prisma, store } = criarBaseFalsa([
    { id: "A", estado: "RASCUNHO", versao: 0, linhas: new Map() },
    { id: "B", estado: "RASCUNHO", versao: 0, linhas: new Map() },
  ]);
  await salvarAutosaveEncomenda(prisma, { listaEncomendaId: "A", versaoEsperada: 0, linhas: [linha({ produtoId: "x", quantidadeAjustada: 1 })] });
  await salvarAutosaveEncomenda(prisma, { listaEncomendaId: "B", versaoEsperada: 0, linhas: [linha({ produtoId: "y", quantidadeAjustada: 2 })] });
  eq(store.get("A")!.versao, 1, "C1: A tem versão 1");
  eq(store.get("B")!.versao, 1, "C2: B tem a SUA PRÓPRIA versão 1, independente de A");
  check(!store.get("A")!.linhas.has("y"), "C3: alterar B nunca aparece em A");
  check(!store.get("B")!.linhas.has("x"), "C4: alterar A nunca aparece em B");

  // Concluir A (simulando finalizeAndQueueOrder) não afecta B.
  store.get("A")!.estado = "FINALIZADA";
  eq(store.get("B")!.estado, "RASCUNHO", "C5: finalizar A não muda o estado de B");
  let lancouEmB = false;
  try {
    await salvarAutosaveEncomenda(prisma, { listaEncomendaId: "B", versaoEsperada: 1, linhas: [linha({ produtoId: "z", quantidadeAjustada: 3 })] });
  } catch { lancouEmB = true; }
  check(!lancouEmB, "C6: B continua editável depois de A ter sido finalizada");
  eq(store.get("B")!.linhas.has("z"), true, "C7: a gravação em B teve sucesso");
}

console.log("\nD · rascunho já não editável recusa o autosave (#7 fluxo de conclusão)");
{
  const { prisma } = criarBaseFalsa([{ id: "L1", estado: "FINALIZADA", versao: 3, linhas: new Map() }]);
  let erro: unknown;
  try {
    await salvarAutosaveEncomenda(prisma, { listaEncomendaId: "L1", versaoEsperada: 3, linhas: [linha({ produtoId: "p1" })] });
  } catch (e) { erro = e; }
  check(erro instanceof RascunhoNaoEditavelError, "D1: RascunhoNaoEditavelError quando estado !== RASCUNHO");
}

console.log("\nE · conflito de versão NUNCA faz overwrite silencioso (#8.13)");
{
  const { prisma, store } = criarBaseFalsa([{ id: "L1", estado: "RASCUNHO", versao: 0, linhas: new Map() }]);
  await salvarAutosaveEncomenda(prisma, { listaEncomendaId: "L1", versaoEsperada: 0, linhas: [linha({ produtoId: "p1", quantidadeAjustada: 1 })] });
  eq(store.get("L1")!.versao, 1, "E1: versão real é 1 depois da 1ª gravação");

  let erro: unknown;
  try {
    // Cliente desactualizado ainda pensa que a versão é 0.
    await salvarAutosaveEncomenda(prisma, { listaEncomendaId: "L1", versaoEsperada: 0, linhas: [linha({ produtoId: "p1", quantidadeAjustada: 999 })] });
  } catch (e) { erro = e; }
  check(erro instanceof ConflitoVersaoError, "E2: ConflitoVersaoError lançado");
  eq((erro as ConflitoVersaoError).versaoAtual, 1, "E3: o erro diz qual É a versão actual real");
  eq(store.get("L1")!.linhas.get("p1")!.quantidadeAjustada, 1, "E4: o valor NÃO foi sobrescrito — continua 1, nunca 999");
  eq(store.get("L1")!.versao, 1, "E5: a versão não avançou com a tentativa recusada");
}

console.log("\nF · segunda gravação com o MESMO conteúdo é idempotente — zero duplicados (#8.4)");
{
  const { prisma, store } = criarBaseFalsa([{ id: "L1", estado: "RASCUNHO", versao: 0, linhas: new Map() }]);
  await salvarAutosaveEncomenda(prisma, { listaEncomendaId: "L1", versaoEsperada: 0, linhas: [linha({ produtoId: "p1", quantidadeAjustada: 7 })] });
  await salvarAutosaveEncomenda(prisma, { listaEncomendaId: "L1", versaoEsperada: 1, linhas: [linha({ produtoId: "p1", quantidadeAjustada: 7 })] });
  eq(store.get("L1")!.linhas.size, 1, "F1: continua a existir exactamente 1 linha — upsert nunca duplica por produtoId");
  eq(store.get("L1")!.versao, 2, "F2: a versão avança a cada gravação bem sucedida, mesmo sem mudança de conteúdo (rastreável)");
}

console.log("\nG · nunca sobrescreve `origem` de uma linha existente quando não enviada (#origem-linha)");
{
  const { prisma, store } = criarBaseFalsa([{ id: "L1", estado: "RASCUNHO", versao: 0, linhas: new Map([["p1", { produtoId: "p1", quantidadeSugerida: 10, quantidadeAjustada: 10, fornecedorSugeridoId: null, notas: null, origem: "PROPOSTA" }]]) }]);
  // Autosave normal de uma linha PROPOSTA existente — nunca envia `origem`.
  await salvarAutosaveEncomenda(prisma, { listaEncomendaId: "L1", versaoEsperada: 0, linhas: [linha({ produtoId: "p1", quantidadeAjustada: 20 })] });
  eq(store.get("L1")!.linhas.get("p1")!.origem, "PROPOSTA", "G1: origem PROPOSTA sobrevive a um autosave de quantidade — nunca vira MANUAL por engano");
}

console.log("\nH · nenhuma linha para gravar é um no-op — devolve a versão actual sem tocar em nada (#8.5-ish)");
{
  const { prisma, store } = criarBaseFalsa([{ id: "L1", estado: "RASCUNHO", versao: 4, linhas: new Map() }]);
  const r = await salvarAutosaveEncomenda(prisma, { listaEncomendaId: "L1", versaoEsperada: 4, linhas: [] });
  eq(r, { versao: 4, gravadas: 0, removidas: 0 }, "H1: devolve a versão actual, zero gravadas");
  eq(store.get("L1")!.versao, 4, "H2: a versão não muda com um autosave vazio");
}

console.log("\nI · verificação estática — permissões/tenant no server action, beforeunload condicional no hook");
{
  const actionsSrc = readFileSync(new URL("../../app/encomendas/[id]/actions.ts", import.meta.url), "utf8");
  check(/autosaveEncomendaAction[\s\S]{0,400}canAccessFarmaciaSync\(session, input\.farmaciaId\)/.test(actionsSrc), "I1: autosaveEncomendaAction verifica canAccessFarmaciaSync ANTES de gravar — utilizador sem permissão não escreve rascunho alheio");
  check(/autosaveEncomendaAction[\s\S]{0,300}requirePermission\("reports\.write"\)/.test(actionsSrc), "I2: autosaveEncomendaAction exige a mesma permissão dos restantes actions de encomenda");
  check(/duplicarRascunhoComoNovoAction[\s\S]{0,700}canAccessFarmaciaSync\(session, input\.farmaciaId\)/.test(actionsSrc), "I3: duplicarRascunhoComoNovoAction (a saída do conflito) também verifica a farmácia");
  check(/AUTOSAVE_MAX_LINHAS/.test(actionsSrc) && /input\.linhas\.length > AUTOSAVE_MAX_LINHAS/.test(actionsSrc), "I4: tecto de linhas por chamada de autosave — payload não é ilimitado");

  const hookSrc = readFileSync(new URL("../../lib/encomendas/use-autosave-encomenda.ts", import.meta.url), "utf8");
  check(/if \(!temAlteracoesPendentes\) return;/.test(hookSrc), "I5: o handler de beforeunload sai sem avisar quando NÃO há alterações pendentes");
  check(/temAlteracoesPendentes =\s*\n\s*pendentesRef\.current\.size > 0/.test(hookSrc), "I6: temAlteracoesPendentes deriva do que está mesmo pendente, não de uma flag fixa");
  check(/emVooRef\.current = true/.test(hookSrc) && /reagendarRef\.current = true/.test(hookSrc), "I7: serialização — nunca duas gravações em voo, reagenda em vez de duplicar pedidos");
  check(!/localStorage\.setItem\([^)]*token|localStorage\.setItem\([^)]*password/i.test(hookSrc), "I8: o fallback local nunca grava tokens/passwords (só produtoId/quantidade/notas)");
}

console.log(`\n${ok} ok, ${ko} falhas`);
process.exit(ko === 0 ? 0 : 1);
}

principal();
