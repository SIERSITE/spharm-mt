/**
 * scripts/tests/test-reconciliar-fabricantes-por-cnp-garantia.ts
 *
 * Testa lib/catalog/reconciliar-fabricantes-por-cnp-garantia.ts — a
 * orquestração create/update sobre o resolver puro (já coberto em
 * scripts/tests/test-resolver-fabricante-por-cnp.ts, incluindo o caso
 * Pharmakern), contra um Prisma falso mutável: trava de tenant, dry-run,
 * idempotência, criação de fabricante/alias, e verificação estática das
 * integrações (ingest, enrich-catalog, ordem relativa a grupos
 * laboratoriais).
 *
 * Corre com: npx tsx scripts/tests/test-reconciliar-fabricantes-por-cnp-garantia.ts
 */
import { readFileSync } from "node:fs";
import {
  reconciliarFabricantesPorCnpGarantia,
  reconciliarFabricantesPorCnpGarantiaTransacional,
  TENANT_TRAVADO,
  type PrismaParaReconciliacaoFabricantes,
  type PrismaParaReconciliacaoFabricantesTransacional,
} from "../../lib/catalog/reconciliar-fabricantes-por-cnp-garantia";
import { normalizarTitularAimGarantia } from "../../lib/catalog/fabricante-normalizacao-garantia";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const eq = <T,>(a: T, b: T, label: string) =>
  check(JSON.stringify(a) === JSON.stringify(b), label, `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);

// ── Fake Prisma mutável ─────────────────────────────────────────────────

type FakeProduto = { id: string; cnp: number; fabricanteId: string | null; camposManuais?: string[] };
type FakeFabricante = { id: string; nomeNormalizado: string };
type FakeAlias = { fabricanteId: string; aliasNome: string };
type FakeRegisto = { cnp: number; titularAim: string | null; estadoAim: string | null };
type FakePf = { produtoId: string; fabricanteErpAtual: string | null };

/**
 * Constrói os delegates (produto/fabricante/fabricanteAlias/
 * produtoFarmacia/regulatoryRecord) sobre arrays mutáveis DADAS — nunca
 * as suas próprias. Usado quer para o Prisma falso "real" (as arrays
 * top-level da fixture) quer para o `tx` dentro de `$transaction`
 * (clones das mesmas arrays) — a MESMA lógica de escrita, só a
 * identidade das arrays muda.
 */
function construirDelegates(
  produtos: FakeProduto[],
  fabricantes: FakeFabricante[],
  aliases: FakeAlias[],
  registos: FakeRegisto[],
  produtosFarmacia: FakePf[],
  seq: { n: number },
  falharNaEscritaDeIndice?: number,
) {
  let chamadasDeEscrita = 0;
  const talvezFalhar = () => {
    if (falharNaEscritaDeIndice !== undefined && chamadasDeEscrita === falharNaEscritaDeIndice) {
      chamadasDeEscrita++;
      throw new Error(`FALHA_FORCADA_PARA_TESTE (escrita #${falharNaEscritaDeIndice})`);
    }
    chamadasDeEscrita++;
  };

  return {
    produto: {
      findMany: async (args?: {
        where?: { id?: { in?: string[] }; cnp?: { in?: number[] }; fabricanteId?: null | { not: null } };
      }) => {
        let resultado = produtos;
        if (args?.where?.id?.in) {
          const ids = args.where.id.in;
          resultado = resultado.filter((p) => ids.includes(p.id));
        }
        if (args?.where?.cnp?.in) {
          const cnpsIn = args.where.cnp.in;
          resultado = resultado.filter((p) => cnpsIn.includes(p.cnp));
        }
        if (args?.where?.fabricanteId === null) {
          resultado = resultado.filter((p) => p.fabricanteId === null);
        } else if (args?.where?.fabricanteId && "not" in args.where.fabricanteId) {
          resultado = resultado.filter((p) => p.fabricanteId !== null);
        }
        return resultado;
      },
      update: async (args: { where: { id: string; fabricanteId?: null }; data: { fabricanteId: string } }) => {
        talvezFalhar();
        const idx = produtos.findIndex((p) => p.id === args.where.id);
        if (idx < 0) throw Object.assign(new Error("not found"), { code: "P2025" });
        if ("fabricanteId" in args.where && produtos[idx]!.fabricanteId !== args.where.fabricanteId) {
          throw Object.assign(new Error("condition mismatch"), { code: "P2025" });
        }
        produtos[idx] = { ...produtos[idx]!, fabricanteId: args.data.fabricanteId };
        return produtos[idx]!;
      },
    },
    produtoFarmacia: {
      findMany: async (args?: { where?: { produtoId?: { in?: string[] } } }) => {
        const ids = args?.where?.produtoId?.in ?? [];
        return produtosFarmacia.filter((pf) => ids.includes(pf.produtoId) && pf.fabricanteErpAtual !== null);
      },
    },
    fabricante: {
      findMany: async () => fabricantes,
      create: async (args: { data: { nomeNormalizado: string } }) => {
        talvezFalhar();
        const novo = { id: `fNovo${seq.n++}`, nomeNormalizado: args.data.nomeNormalizado };
        fabricantes.push(novo);
        return novo;
      },
    },
    fabricanteAlias: {
      findMany: async (args?: { where?: { fabricanteId?: string; aliasNome?: string } }) => {
        if (args?.where) {
          return aliases.filter((a) => a.fabricanteId === args.where!.fabricanteId && a.aliasNome === args.where!.aliasNome);
        }
        return aliases;
      },
      create: async (args: { data: FakeAlias }) => {
        talvezFalhar();
        aliases.push({ ...args.data });
        return args.data;
      },
    },
    regulatoryRecord: {
      findMany: async (args?: { where?: { cnp?: { in?: number[] }; titularAim?: { in?: string[] } } }) => {
        let resultado = registos;
        if (args?.where?.cnp?.in) {
          const cnpsIn = args.where.cnp.in;
          resultado = resultado.filter((r) => cnpsIn.includes(r.cnp));
        }
        if (args?.where?.titularAim?.in) {
          const titularesIn = args.where.titularAim.in;
          resultado = resultado.filter((r) => r.titularAim !== null && titularesIn.includes(r.titularAim));
        }
        return resultado;
      },
    },
  };
}

/**
 * `$transaction` sobre CLONES das arrays reais: o callback opera sobre
 * cópias, e só quando resolve com sucesso é que o conteúdo das cópias é
 * copiado de volta para as arrays reais ("commit"). Se o callback
 * lançar, as cópias são simplesmente descartadas — as arrays reais
 * ficam EXACTAMENTE como estavam antes de `$transaction` ter sido
 * chamado, e a excepção propaga para quem chamou `$transaction`. É a
 * simulação mais simples e correcta de atomicidade "tudo-ou-nada" para
 * um Prisma falso em memória — o mesmo efeito observável de um ROLLBACK
 * real do Postgres (coberto à parte, com Postgres real, em
 * test-reconciliar-fabricantes-por-cnp-garantia-db.ts).
 */
function criarPrismaFalso(fixture: {
  produtos: FakeProduto[];
  fabricantes?: FakeFabricante[];
  aliases?: FakeAlias[];
  registos?: FakeRegisto[];
  produtosFarmacia?: FakePf[];
  /** Índice (0-based) da N-ésima escrita (create/update, contadas globalmente) a fazer falhar — só dentro de `$transaction`. */
  falharNaEscritaDeIndice?: number;
}) {
  const produtos: FakeProduto[] = fixture.produtos.map((p) => ({ camposManuais: [], ...p }));
  const fabricantes: FakeFabricante[] = fixture.fabricantes ? fixture.fabricantes.map((f) => ({ ...f })) : [];
  const aliases: FakeAlias[] = fixture.aliases ? fixture.aliases.map((a) => ({ ...a })) : [];
  const registos = fixture.registos ?? [];
  const produtosFarmacia = fixture.produtosFarmacia ?? [];
  const seq = { n: 0 };
  let chamadasTransaction = 0;

  const delegates = construirDelegates(produtos, fabricantes, aliases, registos, produtosFarmacia, seq);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prismaSolto: any = {
    ...delegates,
    $transaction: async (fn: (tx: unknown) => Promise<void>) => {
      chamadasTransaction++;
      const produtosClone = produtos.map((p) => ({ ...p }));
      const fabricantesClone = fabricantes.map((f) => ({ ...f }));
      const aliasesClone = aliases.map((a) => ({ ...a }));
      const seqClone = { n: seq.n };
      const txDelegates = construirDelegates(produtosClone, fabricantesClone, aliasesClone, registos, produtosFarmacia, seqClone, fixture.falharNaEscritaDeIndice);
      await fn(txDelegates);
      // Commit — só chega aqui se `fn` não lançou.
      produtos.length = 0;
      produtos.push(...produtosClone);
      fabricantes.length = 0;
      fabricantes.push(...fabricantesClone);
      aliases.length = 0;
      aliases.push(...aliasesClone);
      seq.n = seqClone.n;
    },
  };

  const prisma = prismaSolto as PrismaParaReconciliacaoFabricantes;
  const prismaTransacional = prismaSolto as PrismaParaReconciliacaoFabricantesTransacional;
  return { prisma, prismaTransacional, produtos, fabricantes, aliases, chamadasTransaction: () => chamadasTransaction };
}

async function principal() {
  console.log("A · trava de tenant — recusa ANTES de qualquer query");
  {
    const stub = ({
      produto: {
        findMany: async () => { throw new Error("SHOULD_NEVER_CALL produto.findMany"); },
        update: async () => { throw new Error("SHOULD_NEVER_CALL produto.update"); },
      },
      produtoFarmacia: { findMany: async () => { throw new Error("SHOULD_NEVER_CALL produtoFarmacia.findMany"); } },
      fabricante: {
        findMany: async () => { throw new Error("SHOULD_NEVER_CALL fabricante.findMany"); },
        create: async () => { throw new Error("SHOULD_NEVER_CALL fabricante.create"); },
      },
      fabricanteAlias: {
        findMany: async () => { throw new Error("SHOULD_NEVER_CALL fabricanteAlias.findMany"); },
        create: async () => { throw new Error("SHOULD_NEVER_CALL fabricanteAlias.create"); },
      },
      regulatoryRecord: { findMany: async () => { throw new Error("SHOULD_NEVER_CALL regulatoryRecord.findMany"); } },
    } as unknown) as PrismaParaReconciliacaoFabricantes;
    eq(TENANT_TRAVADO, "garantia", "A0: tenant travado é garantia");

    for (const slug of ["sier", "silveira", "", "GARANTIA"]) {
      let mensagem = "";
      try {
        await reconciliarFabricantesPorCnpGarantia(stub, slug, { tipo: "lote" });
      } catch (err) {
        mensagem = err instanceof Error ? err.message : String(err);
      }
      check(mensagem.includes(TENANT_TRAVADO), `A1 (tenantSlug="${slug}"): recusado com uma mensagem do PRÓPRIO serviço, mencionando "garantia"`, mensagem);
      check(!mensagem.includes("SHOULD_NEVER_CALL"), `A2 (tenantSlug="${slug}"): nunca chegou a tocar em nenhum delegate — recusado antes de qualquer query`, mensagem);
    }
  }

  console.log("\nB · resolve por nome normalizado existente — cria a associação, zero fabricantes novos");
  {
    const { prisma, produtos } = criarPrismaFalso({
      produtos: [{ id: "p1", cnp: 5701651, fabricanteId: null }],
      fabricantes: [{ id: "fPharmakern", nomeNormalizado: "PHARMAKERN PORTUGAL PRODUTOS FARMACEUTICOS SOCIEDADE UNIPESSOAL LDA" }],
      registos: [{ cnp: 5701651, titularAim: "Pharmakern Portugal, Produtos Farmacêuticos, Sociedade Unipessoal Lda.", estadoAim: "Autorizado" }],
    });
    const r = await reconciliarFabricantesPorCnpGarantia(prisma, "garantia", { tipo: "produtos", produtoIds: ["p1"] });
    eq(r.resolvidosPorNomeNormalizado, 1, "B1: 1 resolvido por nome normalizado (CNP 5701651 → Pharmakern canónico)");
    eq(r.fabricantesCriados, 0, "B2: zero fabricantes criados — já existia");
    eq(produtos[0]?.fabricanteId, "fPharmakern", "B3: Produto.fabricanteId gravado com o id correcto");
    eq(r.estadosAim, { Autorizado: 1 }, "B4: estadosAim regista Autorizado");
  }

  console.log("\nC · sem correspondência — cria Fabricante novo com o nome canónico do titular");
  {
    const { prisma, produtos, fabricantes } = criarPrismaFalso({
      produtos: [{ id: "p1", cnp: 5701651, fabricanteId: null }],
      registos: [{ cnp: 5701651, titularAim: "Pharmakern Portugal, Produtos Farmacêuticos, Sociedade Unipessoal Lda.", estadoAim: "Autorizado" }],
    });
    const r = await reconciliarFabricantesPorCnpGarantia(prisma, "garantia", { tipo: "produtos", produtoIds: ["p1"] });
    eq(r.fabricantesCriados, 1, "C1: 1 fabricante novo criado");
    eq(fabricantes.length, 1, "C2: exactamente 1 linha Fabricante na base falsa");
    eq(produtos[0]?.fabricanteId, fabricantes[0]?.id, "C3: Produto.fabricanteId aponta para o fabricante recém-criado");
    check((fabricantes[0]?.nomeNormalizado.length ?? 0) > 60, "C4: o nome canónico criado excede os 60 chars — prova que usa o normalizador próprio (garantia), não o partilhado", fabricantes[0]?.nomeNormalizado);
  }

  console.log("\nD · dois CNP Pharmakern no MESMO lote — ambos resolvem para o MESMO canónico recém-criado, nunca um terceiro");
  {
    const { prisma, produtos, fabricantes } = criarPrismaFalso({
      produtos: [
        { id: "p1", cnp: 5701651, fabricanteId: null },
        { id: "p2", cnp: 5701999, fabricanteId: null },
      ],
      registos: [
        { cnp: 5701651, titularAim: "Pharmakern Portugal, Produtos Farmacêuticos, Sociedade Unipessoal Lda.", estadoAim: "Autorizado" },
        { cnp: 5701999, titularAim: "Pharmakern Portugal, Produtos Farmacêuticos, Sociedade Unipessoal Lda.", estadoAim: "Ativo" },
      ],
    });
    const r = await reconciliarFabricantesPorCnpGarantia(prisma, "garantia", { tipo: "produtos", produtoIds: ["p1", "p2"] });
    eq(r.fabricantesCriados, 1, "D1: exactamente 1 fabricante criado, apesar de 2 produtos Pharmakern no lote");
    eq(fabricantes.length, 1, "D2: 1 única linha Fabricante na base falsa");
    eq(produtos[0]?.fabricanteId, produtos[1]?.fabricanteId, "D3: os DOIS produtos apontam para o MESMO fabricanteId");
    eq(r.estadosAim, { Autorizado: 1, Ativo: 1 }, "D4: estadosAim distingue os 2 estados");
  }

  console.log("\nE · fabricanteId já preenchido nunca é tocado; divergência só reportada");
  {
    const { prisma, produtos } = criarPrismaFalso({
      produtos: [{ id: "p1", cnp: 5701651, fabricanteId: "fOutro" }],
      fabricantes: [{ id: "fOutro", nomeNormalizado: "OUTRO FABRICANTE LDA" }],
      registos: [{ cnp: 5701651, titularAim: "Pharmakern Portugal, Lda.", estadoAim: "Autorizado" }],
    });
    const r = await reconciliarFabricantesPorCnpGarantia(prisma, "garantia", { tipo: "produtos", produtoIds: ["p1"] });
    eq(r.jaTinhaFabricante, 1, "E1: contado como já-tinha-fabricante");
    eq(r.divergencias, 1, "E2: divergência reportada (titular != fabricante associado)");
    eq(produtos[0]?.fabricanteId, "fOutro", "E3: fabricanteId NUNCA alterado, mesmo com titularAim divergente");
  }

  console.log("\nF · camposManuais protege — nunca resolve");
  {
    const { prisma, produtos } = criarPrismaFalso({
      produtos: [{ id: "p1", cnp: 5701651, fabricanteId: null, camposManuais: ["fabricanteId"] }],
      registos: [{ cnp: 5701651, titularAim: "Pharmakern Portugal, Lda.", estadoAim: "Autorizado" }],
    });
    const r = await reconciliarFabricantesPorCnpGarantia(prisma, "garantia", { tipo: "produtos", produtoIds: ["p1"] });
    eq(r.protegidosManualmente, 1, "F1: contado como protegido manualmente");
    eq(produtos[0]?.fabricanteId, null, "F2: fabricanteId continua null — nunca resolvido apesar do titular perfeitamente resolúvel");
  }

  console.log("\nG · CNP sem RegulatoryRecord mas com fabricante de origem/ERP (ProdutoFarmacia.fabricanteErpAtual)");
  {
    const { prisma, produtos } = criarPrismaFalso({
      produtos: [{ id: "p1", cnp: 8000000, fabricanteId: null }],
      fabricantes: [{ id: "fErp", nomeNormalizado: "GENERICOS PORTUGUESES LDA" }],
      produtosFarmacia: [{ produtoId: "p1", fabricanteErpAtual: "Genéricos Portugueses, Lda." }],
    });
    const r = await reconciliarFabricantesPorCnpGarantia(prisma, "garantia", { tipo: "produtos", produtoIds: ["p1"] });
    eq(r.resolvidosPorNomeNormalizado, 1, "G1: resolvido pela origem/ERP mesmo sem RegulatoryRecord");
    eq(produtos[0]?.fabricanteId, "fErp", "G2: fabricanteId gravado a partir da origem");
    eq(r.semFonte, { FORA_UNIVERSO_INFARMED: 0, SEM_REGISTO_CATALOGO: 0, FABRICANTE_NAO_INFORMADO_PELA_ORIGEM: 0, TITULAR_INVALIDO: 0 }, "G3: zero sem-fonte");
  }

  console.log("\nH · sem RegulatoryRecord e sem origem — SEM_REGISTO_CATALOGO explícito, nunca inventa");
  {
    const { prisma, produtos } = criarPrismaFalso({ produtos: [{ id: "p1", cnp: 8000001, fabricanteId: null }] });
    const r = await reconciliarFabricantesPorCnpGarantia(prisma, "garantia", { tipo: "produtos", produtoIds: ["p1"] });
    eq(r.semFonte.SEM_REGISTO_CATALOGO, 1, "H1: motivo explícito SEM_REGISTO_CATALOGO");
    eq(produtos[0]?.fabricanteId, null, "H2: fabricanteId continua null");
  }

  console.log("\nI · regra 10 — Autorizado/Ativo sem fonte incrementa aindaSemFabricanteAtual; histórico não conta");
  {
    const { prisma } = criarPrismaFalso({
      produtos: [
        { id: "p1", cnp: 8000002, fabricanteId: null },
        { id: "p2", cnp: 8000003, fabricanteId: null },
      ],
      registos: [
        { cnp: 8000002, titularAim: null, estadoAim: "Autorizado" },
        { cnp: 8000003, titularAim: null, estadoAim: "Revogado" },
      ],
    });
    const r = await reconciliarFabricantesPorCnpGarantia(prisma, "garantia", { tipo: "produtos", produtoIds: ["p1", "p2"] });
    eq(r.aindaSemFabricanteAtual, 1, "I1: só o produto Autorizado conta — o Revogado nunca conta, mesmo sem fabricante");
  }

  console.log("\nJ · dry-run — zero escritas, mas classifica e conta exactamente como uma corrida real");
  {
    const { prisma, produtos, fabricantes, aliases } = criarPrismaFalso({
      produtos: [{ id: "p1", cnp: 5701651, fabricanteId: null }],
      registos: [{ cnp: 5701651, titularAim: "Pharmakern Portugal, Produtos Farmacêuticos, Sociedade Unipessoal Lda.", estadoAim: "Autorizado" }],
    });
    const r = await reconciliarFabricantesPorCnpGarantia(prisma, "garantia", { tipo: "produtos", produtoIds: ["p1"], dryRun: true });
    eq(r.fabricantesCriados, 1, "J1: relatório mostra 1 fabricante que SERIA criado");
    eq(fabricantes.length, 0, "J2: zero Fabricante REAL criado na base falsa");
    eq(produtos[0]?.fabricanteId, null, "J3: Produto.fabricanteId continua null — zero escrita");
    eq(aliases.length, 0, "J4: zero FabricanteAlias real criado");
  }

  console.log("\nK · segunda corrida (real) consecutiva produz zero escritas — idempotência");
  {
    const { prisma, produtos, fabricantes } = criarPrismaFalso({
      produtos: [{ id: "p1", cnp: 5701651, fabricanteId: null }],
      registos: [{ cnp: 5701651, titularAim: "Pharmakern Portugal, Produtos Farmacêuticos, Sociedade Unipessoal Lda.", estadoAim: "Autorizado" }],
    });
    const r1 = await reconciliarFabricantesPorCnpGarantia(prisma, "garantia", { tipo: "produtos", produtoIds: ["p1"] });
    eq(r1.fabricantesCriados, 1, "K1: primeira corrida cria 1 fabricante");
    eq(produtos[0]?.fabricanteId, fabricantes[0]?.id, "K2: fabricanteId gravado");

    const r2 = await reconciliarFabricantesPorCnpGarantia(prisma, "garantia", { tipo: "produtos", produtoIds: ["p1"] });
    eq(r2.fabricantesCriados, 0, "K3: segunda corrida — zero fabricantes criados");
    eq(r2.jaTinhaFabricante, 1, "K4: segunda corrida — intercetado no nível 1 (já tem fabricante)");
    eq(fabricantes.length, 1, "K5: continua a existir exactamente 1 Fabricante — zero duplicados");
  }

  // ── Modo TRANSACIONAL (scripts/reconciliar-fabricantes-por-cnp-garantia.ts) ──

  console.log("\nO · trava de tenant também no modo transacional — recusa ANTES de qualquer query, nunca abre $transaction");
  {
    const stub = ({
      produto: {
        findMany: async () => { throw new Error("SHOULD_NEVER_CALL produto.findMany"); },
        update: async () => { throw new Error("SHOULD_NEVER_CALL produto.update"); },
      },
      produtoFarmacia: { findMany: async () => { throw new Error("SHOULD_NEVER_CALL produtoFarmacia.findMany"); } },
      fabricante: {
        findMany: async () => { throw new Error("SHOULD_NEVER_CALL fabricante.findMany"); },
        create: async () => { throw new Error("SHOULD_NEVER_CALL fabricante.create"); },
      },
      fabricanteAlias: {
        findMany: async () => { throw new Error("SHOULD_NEVER_CALL fabricanteAlias.findMany"); },
        create: async () => { throw new Error("SHOULD_NEVER_CALL fabricanteAlias.create"); },
      },
      regulatoryRecord: { findMany: async () => { throw new Error("SHOULD_NEVER_CALL regulatoryRecord.findMany"); } },
      $transaction: async () => { throw new Error("SHOULD_NEVER_CALL $transaction"); },
    } as unknown) as PrismaParaReconciliacaoFabricantesTransacional;

    for (const slug of ["sier", "silveira", "", "GARANTIA"]) {
      let mensagem = "";
      try {
        await reconciliarFabricantesPorCnpGarantiaTransacional(stub, slug, { tipo: "lote" });
      } catch (err) {
        mensagem = err instanceof Error ? err.message : String(err);
      }
      check(mensagem.includes(TENANT_TRAVADO), `O1 (tenantSlug="${slug}"): recusado com uma mensagem mencionando "garantia"`, mensagem);
      check(!mensagem.includes("SHOULD_NEVER_CALL"), `O2 (tenantSlug="${slug}"): nunca chegou a tocar em nenhum delegate, incluindo $transaction`, mensagem);
    }
  }

  console.log("\nP · apply transacional — resolve, aplica, e usa EXACTAMENTE 1 $transaction para o lote inteiro");
  {
    const { prismaTransacional, produtos, fabricantes, chamadasTransaction } = criarPrismaFalso({
      produtos: [
        { id: "p1", cnp: 5701651, fabricanteId: null },
        { id: "p2", cnp: 5701999, fabricanteId: null },
      ],
      registos: [
        { cnp: 5701651, titularAim: "Pharmakern Portugal, Produtos Farmacêuticos, Sociedade Unipessoal Lda.", estadoAim: "Autorizado" },
        { cnp: 5701999, titularAim: "Pharmakern Portugal, Produtos Farmacêuticos, Sociedade Unipessoal Lda.", estadoAim: "Ativo" },
      ],
    });
    const r = await reconciliarFabricantesPorCnpGarantiaTransacional(prismaTransacional, "garantia", { tipo: "produtos", produtoIds: ["p1", "p2"] });
    eq(r.fabricantesCriados, 1, "P1: 1 fabricante criado para os 2 produtos Pharmakern do lote");
    eq(produtos[0]?.fabricanteId, produtos[1]?.fabricanteId, "P2: os dois produtos apontam para o MESMO fabricanteId");
    eq(fabricantes.length, 1, "P3: exactamente 1 Fabricante real");
    eq(chamadasTransaction(), 1, "P4: exactamente 1 chamada a $transaction para o lote inteiro (nunca uma por produto)");
  }

  console.log("\nQ · FALHA A MEIO da transacção — ROLLBACK INTEGRAL: zero fabricantes, zero aliases, zero Produto.fabricanteId alterados");
  {
    // 3 produtos: p1 resolve por nome normalizado existente (uma escrita:
    // produto.update), p2 e p3 resolvem para um fabricante NOVO (cada um
    // é potencialmente 1-2 escritas: fabricante.create só na primeira vez
    // — a segunda reutiliza o id em memória — mais produto.update). A
    // falha é forçada na 2ª escrita (índice 1, 0-based) — a meio do lote
    // — para provar que o QUE JÁ TINHA SIDO ESCRITO DENTRO da transacção
        // (a 1ª escrita) também reverte, não só o que viria a seguir.
    const fabricanteExistente = { id: "fExistente", nomeNormalizado: "OUTRO FABRICANTE JA CONHECIDO LDA" };
    const { prismaTransacional, produtos, fabricantes, aliases, chamadasTransaction } = criarPrismaFalso({
      produtos: [
        { id: "p1", cnp: 1000001, fabricanteId: null },
        { id: "p2", cnp: 5701651, fabricanteId: null },
        { id: "p3", cnp: 5701999, fabricanteId: null },
      ],
      fabricantes: [fabricanteExistente],
      registos: [
        { cnp: 1000001, titularAim: "Outro Fabricante Já Conhecido, Lda.", estadoAim: "Autorizado" },
        { cnp: 5701651, titularAim: "Pharmakern Portugal, Produtos Farmacêuticos, Sociedade Unipessoal Lda.", estadoAim: "Autorizado" },
        { cnp: 5701999, titularAim: "Pharmakern Portugal, Produtos Farmacêuticos, Sociedade Unipessoal Lda.", estadoAim: "Ativo" },
      ],
      falharNaEscritaDeIndice: 1,
    });

    let mensagem = "";
    try {
      await reconciliarFabricantesPorCnpGarantiaTransacional(prismaTransacional, "garantia", { tipo: "produtos", produtoIds: ["p1", "p2", "p3"] });
    } catch (err) {
      mensagem = err instanceof Error ? err.message : String(err);
    }
    check(mensagem.includes("FALHA_FORCADA_PARA_TESTE"), "Q1: a excepção da escrita forçada propaga para fora de reconciliarFabricantesPorCnpGarantiaTransacional (nunca é engolida)", mensagem);
    eq(produtos[0]?.fabricanteId, null, "Q2: p1 — cuja escrita ACONTECEU primeiro, dentro da transacção — reverteu: fabricanteId continua null");
    eq(produtos[1]?.fabricanteId, null, "Q3: p2 continua null");
    eq(produtos[2]?.fabricanteId, null, "Q4: p3 continua null");
    eq(fabricantes.length, 1, "Q5: continua a existir só o Fabricante que já existia ANTES da transacção — zero fabricantes novos persistidos");
    eq(fabricantes[0]?.id, "fExistente", "Q6: e é exactamente o mesmo (mesmo id) — nada foi substituído");
    eq(aliases.length, 0, "Q7: zero FabricanteAlias persistido");
    eq(chamadasTransaction(), 1, "Q8: $transaction foi chamada (e falhou) exactamente 1 vez");
  }

  console.log("\nR · dry-run transacional nunca abre $transaction; plano vazio (idempotência) também nunca abre $transaction");
  {
    const { prismaTransacional, produtos, fabricantes, chamadasTransaction } = criarPrismaFalso({
      produtos: [{ id: "p1", cnp: 5701651, fabricanteId: null }],
      registos: [{ cnp: 5701651, titularAim: "Pharmakern Portugal, Produtos Farmacêuticos, Sociedade Unipessoal Lda.", estadoAim: "Autorizado" }],
    });
    const rDry = await reconciliarFabricantesPorCnpGarantiaTransacional(prismaTransacional, "garantia", { tipo: "produtos", produtoIds: ["p1"], dryRun: true });
    eq(rDry.fabricantesCriados, 1, "R1: relatório do dry-run mostra 1 fabricante que SERIA criado");
    eq(fabricantes.length, 0, "R2: zero Fabricante real");
    eq(produtos[0]?.fabricanteId, null, "R3: zero escrita em Produto");
    eq(chamadasTransaction(), 0, "R4: dry-run NUNCA abre $transaction");

    const { prismaTransacional: prisma2, chamadasTransaction: chamadas2 } = criarPrismaFalso({
      produtos: [{ id: "p1", cnp: 5701651, fabricanteId: "fJaResolvido" }],
      fabricantes: [{ id: "fJaResolvido", nomeNormalizado: "QUALQUER FABRICANTE LDA" }],
    });
    const rVazio = await reconciliarFabricantesPorCnpGarantiaTransacional(prisma2, "garantia", { tipo: "produtos", produtoIds: ["p1"] });
    eq(rVazio.jaTinhaFabricante, 1, "R5: produto já resolvido — nada pendente");
    eq(chamadas2(), 0, "R6: plano vazio — $transaction NUNCA chega a abrir-se");
  }

  console.log("\nS · plano curado, canónico AINDA não existe — dois produtos do MESMO lote (antigo + canónico), em AMBAS as ordens: 1 fabricante, 1 alias, nunca perdido");
  {
    const origem = normalizarTitularAimGarantia("Fabricante Nome Antigo Testado Lda")!;
    const canonico = normalizarTitularAimGarantia("Fabricante Canonico Testado Lda")!;
    const mapeamentoCurado = new Map([[origem, canonico]]);

    for (const ordem of ["canonico_primeiro", "antigo_primeiro"] as const) {
      const produtosFixture =
        ordem === "canonico_primeiro"
          ? [{ id: "pCanonico", cnp: 7000001, fabricanteId: null }, { id: "pAntigo", cnp: 7000002, fabricanteId: null }]
          : [{ id: "pAntigo", cnp: 7000002, fabricanteId: null }, { id: "pCanonico", cnp: 7000001, fabricanteId: null }];
      const { prismaTransacional, produtos, fabricantes, aliases } = criarPrismaFalso({
        produtos: produtosFixture,
        registos: [
          { cnp: 7000001, titularAim: canonico, estadoAim: "Autorizado" },
          { cnp: 7000002, titularAim: origem, estadoAim: "Ativo" },
        ],
      });
      const r = await reconciliarFabricantesPorCnpGarantiaTransacional(prismaTransacional, "garantia", {
        tipo: "produtos",
        produtoIds: ["pCanonico", "pAntigo"],
        mapeamentoCurado,
      });
      eq(r.fabricantesCriados, 1, `S1 (${ordem}): exactamente 1 fabricante criado`);
      eq(r.aliasesCriados, 1, `S2 (${ordem}): exactamente 1 alias criado — nunca perdido, seja qual for a ordem`);
      eq(fabricantes.length, 1, `S3 (${ordem}): 1 única linha Fabricante real`);
      eq(aliases.length, 1, `S4 (${ordem}): 1 única linha FabricanteAlias real`);
      eq(aliases[0]?.aliasNome, origem, `S5 (${ordem}): o alias persistido é o nome ANTIGO`);
      const pCanonicoDb = produtos.find((p) => p.id === "pCanonico");
      const pAntigoDb = produtos.find((p) => p.id === "pAntigo");
      eq(pCanonicoDb?.fabricanteId, pAntigoDb?.fabricanteId, `S6 (${ordem}): os dois produtos apontam para o MESMO fabricanteId`);
      check(!!pCanonicoDb?.fabricanteId && !pCanonicoDb.fabricanteId.startsWith("pendente:"), `S7 (${ordem}): o fabricanteId gravado é REAL, nunca o placeholder sintético interno`, pCanonicoDb?.fabricanteId ?? "(null)");
    }
  }

  console.log("\nT · regra geral 4 (prefixo) através do serviço completo — caso REAL Pharmakern, contra Prisma falso");
  {
    const titularReal = "Pharmakern Portugal, Produtos Farmacêuticos, Sociedade Unipessoal Lda.";
    // Valores REAIS observados em produção (ver .local-data/fabricantes-garantia/…) —
    // nenhuma decisão curada para estes dois IDs existe no repositório;
    // a resolução vem exclusivamente da regra geral de prefixo.
    const curto: FakeFabricante = { id: "cmtjw4ibi1sjn01th3tkd19wk", nomeNormalizado: "PHARMAKERN PORTUGAL LDA" };
    const truncado: FakeFabricante = { id: "cmtjw5pwg1wo701theb361fbl", nomeNormalizado: "PHARMAKERN PORTUGAL PRODUTOS FARMACEUTICOS SOCIE" };
    const { prisma, produtos, fabricantes } = criarPrismaFalso({
      produtos: [{ id: "p5701651", cnp: 5701651, fabricanteId: null }],
      fabricantes: [curto, truncado],
      registos: [{ cnp: 5701651, titularAim: titularReal, estadoAim: "Autorizado" }],
    });
    const r = await reconciliarFabricantesPorCnpGarantia(prisma, "garantia", { tipo: "produtos", produtoIds: ["p5701651"] });
    eq(r.resolvidosPorPrefixo, 1, "T1: resolvido pela regra de prefixo — nunca cria um terceiro Fabricante, nunca escolhe por heurística de nome curto");
    eq(r.fabricantesCriados, 0, "T2: zero fabricantes criados");
    eq(r.ambiguidades, 0, "T3: zero ambiguidades — o prefixo é inequívoco");
    eq(produtos[0]?.fabricanteId, "cmtjw5pwg1wo701theb361fbl", "T4: CNP 5701651 associado ao Fabricante truncado REAL");
    eq(fabricantes.length, 2, "T5: continuam a existir só os 2 Fabricante que já existiam — nenhum a mais");
  }

  console.log("\nU · regra geral 5 (evidência de portefólio) através do serviço completo — a query real de evidência resolve correctamente");
  {
    const titularPartilhado = "Titular Sem Correspondencia Direta Nem Prefixo Lda";
    const fVencedor: FakeFabricante = { id: "fVencedor", nomeNormalizado: "NOME COMPLETAMENTE DISTINTO A LDA" };
    const fPerdedor: FakeFabricante = { id: "fPerdedor", nomeNormalizado: "NOME COMPLETAMENTE DISTINTO B LDA" };
    const { prisma, produtos } = criarPrismaFalso({
      produtos: [
        // 2 produtos JÁ resolvidos para fVencedor, 1 para fPerdedor — todos com o MESMO titularAim.
        { id: "pJa1", cnp: 9100001, fabricanteId: "fVencedor" },
        { id: "pJa2", cnp: 9100002, fabricanteId: "fVencedor" },
        { id: "pJa3", cnp: 9100003, fabricanteId: "fPerdedor" },
        // o produto a resolver AGORA — mesmo titularAim, sem match directo/prefixo.
        { id: "pNovo", cnp: 9100004, fabricanteId: null },
      ],
      fabricantes: [fVencedor, fPerdedor],
      registos: [
        { cnp: 9100001, titularAim: titularPartilhado, estadoAim: "Autorizado" },
        { cnp: 9100002, titularAim: titularPartilhado, estadoAim: "Autorizado" },
        { cnp: 9100003, titularAim: titularPartilhado, estadoAim: "Autorizado" },
        { cnp: 9100004, titularAim: titularPartilhado, estadoAim: "Autorizado" },
      ],
    });
    const r = await reconciliarFabricantesPorCnpGarantia(prisma, "garantia", { tipo: "produtos", produtoIds: ["pNovo"] });
    eq(r.resolvidosPorEvidenciaPortfolio, 1, "U1: resolvido por evidência de portefólio — a query real (RegulatoryRecord + Produto) chega ao resolver correctamente");
    eq(produtos.find((p) => p.id === "pNovo")?.fabricanteId, "fVencedor", "U2: associado ao Fabricante com MAIS produtos na mesma evidência (2 vs 1), nunca ao minoritário");
  }

  console.log(`\n${ok} ok, ${ko} falhas`);
  process.exit(ko === 0 ? 0 : 1);
}

console.log("\nL · verificação estática — nunca escreve Fabricante (update/delete), $transaction só no modo transacional, tipos restritos");
{
  const src = readFileSync(new URL("../../lib/catalog/reconciliar-fabricantes-por-cnp-garantia.ts", import.meta.url), "utf8");
  const codigo = src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");

  check(!/\.fabricante\.(update|upsert|updateMany|createMany|deleteMany|delete)\(/.test(codigo), "L1: nenhuma escrita em Fabricante além de create");
  check(!/\.fabricanteAlias\.(update|upsert|updateMany|createMany|deleteMany|delete)\(/.test(codigo), "L2: nenhuma escrita em FabricanteAlias além de create");
  check(!/\.produto\.(upsert|updateMany|createMany|deleteMany|delete|create)\(/.test(codigo), "L3: nunca cria/apaga Produto — só update de fabricanteId");
  check(/produto:\s*Pick<PrismaClient\["produto"\],\s*"findMany"\s*\|\s*"update">/.test(codigo), "L4: 'produto' tipado como findMany|update apenas");
  check(/fabricante:\s*Pick<PrismaClient\["fabricante"\],\s*"findMany"\s*\|\s*"create">/.test(codigo), "L5: 'fabricante' tipado como findMany|create apenas");
  check(/if\s*\(\s*tenantSlug\s*!==\s*TENANT_TRAVADO\s*\)/.test(codigo), "L6: a trava de tenant é a primeira verificação de classificar()");

  // O modo IMEDIATO (usado pelo ingest/enrich-catalog, ver M/N abaixo)
  // nunca pode usar $transaction — isolar o corpo da função pelo nome.
  const idxImediato = codigo.indexOf("export async function reconciliarFabricantesPorCnpGarantia(");
  const idxTransacional = codigo.indexOf("export async function reconciliarFabricantesPorCnpGarantiaTransacional(");
  check(idxImediato >= 0 && idxTransacional > idxImediato, "L7: as duas funções exportadas existem, nesta ordem (imediata primeiro)");
  const corpoImediato = codigo.slice(idxImediato, idxTransacional);
  check(!/\$transaction/.test(corpoImediato), "L8: reconciliarFabricantesPorCnpGarantia (modo imediato) nunca usa $transaction");

  const corpoTransacional = codigo.slice(idxTransacional);
  check(/prisma\.\$transaction\(/.test(corpoTransacional), "L9: reconciliarFabricantesPorCnpGarantiaTransacional usa $transaction");
  check(/prisma:\s*PrismaParaReconciliacaoFabricantesTransacional/.test(codigo.slice(idxTransacional, idxTransacional + 400)), "L10: a assinatura do modo transacional exige PrismaParaReconciliacaoFabricantesTransacional (tipo com $transaction)", codigo.slice(idxTransacional, idxTransacional + 300));
  check((codigo.match(/\$transaction\(/g) ?? []).length === 1, "L11: exactamente UMA chamada a $transaction em todo o ficheiro — nunca uma por produto");
}

console.log("\nM · verificação estática — app/api/ingest/v1/bootstrap/products/route.ts chama fabricantes ANTES de grupos laboratoriais, ambos gated por garantia");
{
  const src = readFileSync(new URL("../../app/api/ingest/v1/bootstrap/products/route.ts", import.meta.url), "utf8");
  const idxFabricantes = [...src.matchAll(/reconciliarFabricantesPorCnpGarantia/g)].map((m) => m.index ?? -1);
  const idxGrupos = [...src.matchAll(/reconciliarGruposLaboratoriaisGarantia/g)].map((m) => m.index ?? -1);
  check(idxFabricantes.length >= 2, "M1: pelo menos 2 referências a reconciliarFabricantesPorCnpGarantia (bulk + fallback)", `encontradas: ${idxFabricantes.length}`);
  check(idxGrupos.length >= 2, "M2: pelo menos 2 referências a reconciliarGruposLaboratoriaisGarantia", `encontradas: ${idxGrupos.length}`);

  // Bulk: a 1ª ocorrência de fabricantes tem de vir ANTES da 1ª de grupos.
  check((idxFabricantes[0] ?? Infinity) < (idxGrupos[0] ?? -1), "M3: no caminho bulk, a chamada de fabricantes está ANTES da de grupos laboratoriais");
  // Fallback: a 2ª ocorrência de cada também mantém a ordem.
  check((idxFabricantes[1] ?? Infinity) < (idxGrupos[1] ?? -1), "M4: no caminho de recurso, a chamada de fabricantes está ANTES da de grupos laboratoriais");

  const linhas = src.split("\n");
  const linhasComChamada = linhas
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l.includes("await reconciliarFabricantesPorCnpGarantia"));
  check(linhasComChamada.length === 2, "M5: exactamente 2 chamadas reais (import dinâmico) — bulk e fallback", `encontradas: ${linhasComChamada.length}`);
  for (const { i } of linhasComChamada) {
    const janela = linhas.slice(Math.max(0, i - 6), i).join("\n");
    check(/if\s*\(\s*ctx\.tenant\.slug\s*===\s*"garantia"\s*\)/.test(janela), `M6 (linha ${i + 1}): a chamada está dentro de um if (ctx.tenant.slug === "garantia") nas linhas imediatamente anteriores`, janela);
  }
  check(/const \{ reconciliarFabricantesPorCnpGarantia \} = await import\(/.test(src), "M7: import() dinâmico, não import estático de topo");

  const ocorrenciasMensagem = [...src.matchAll(/reconciliação de fabricantes por CNP falhou/g)];
  check(ocorrenciasMensagem.length === 2, "M8a: exactamente 2 mensagens de erro (bulk + fallback)", `encontradas: ${ocorrenciasMensagem.length}`);
  for (const m of ocorrenciasMensagem) {
    const inicio = m.index ?? 0;
    const fimBloco = src.indexOf("\n      }", inicio);
    const trecho = src.slice(inicio, fimBloco > inicio ? fimBloco : inicio + 300);
    check(!/upserted|\breturn\b|\bthrow\b/.test(trecho), `M8b (offset ${inicio}): o catch não referencia upserted, não tem return nem throw`, trecho);
  }
}

console.log("\nN · verificação estática — lib/jobs/enrich-catalog.ts: fase 5b gated === garantia, catch nunca lança, corre ANTES da fase 6");
{
  const src = readFileSync(new URL("../../lib/jobs/enrich-catalog.ts", import.meta.url), "utf8");
  check(/if\s*\(\s*opts\.tenantSlug\s*===\s*"garantia"\s*&&\s*opts\.apenasFila\s*!==\s*true\s*\)\s*\{\s*\n\s*try\s*\{\s*\n\s*const \{ reconciliarFabricantesPorCnpGarantia \} = await import\(/.test(src), "N1: a fase 5b está gated por opts.tenantSlug === \"garantia\" (estrito) E opts.apenasFila !== true, usa import() dinâmico");

  const idxFase5b = src.indexOf("Fase 5b: reconciliar Produto.fabricanteId");
  const idxFase6 = src.indexOf("Fase 6: reconciliar ProdutoGrupoLaboratorial");
  check(idxFase5b >= 0, "N2: a fase 5b existe no ficheiro");
  check(idxFase6 >= 0, "N3: a fase 6 existe no ficheiro");
  check(idxFase5b < idxFase6, "N4: a fase 5b está ANTES da fase 6 no código-fonte (grupos depende do fabricante já resolvido)");

  const trechoFase5b = src.slice(idxFase5b, idxFase6);
  check(!/\bthrow\b/.test(trechoFase5b.replace(/\/\/.*$/gm, "")), "N5: o bloco da fase 5b nunca faz throw — o catch só atribui a fabricantesPorCnp");
  check(/fabricantesPorCnp = \{ \.\.\.resultado, erro: null \};/.test(trechoFase5b), "N6: sucesso atribui erro:null explicitamente");
  check(/console\.warn\(/.test(trechoFase5b), "N7: regra 10 — aviso explícito nos logs quando aindaSemFabricanteAtual > 0");
  check(/fabricantesPorCnp,\s*\n\s*gruposLaboratoriais,/.test(src), "N8: fabricantesPorCnp entra no objecto devolvido, antes de gruposLaboratoriais");
}

principal();
