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
  TENANT_TRAVADO,
  type PrismaParaReconciliacaoFabricantes,
} from "../../lib/catalog/reconciliar-fabricantes-por-cnp-garantia";

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

function criarPrismaFalso(fixture: {
  produtos: FakeProduto[];
  fabricantes?: FakeFabricante[];
  aliases?: FakeAlias[];
  registos?: FakeRegisto[];
  produtosFarmacia?: FakePf[];
}) {
  const produtos: FakeProduto[] = fixture.produtos.map((p) => ({ camposManuais: [], ...p }));
  const fabricantes: FakeFabricante[] = fixture.fabricantes ? fixture.fabricantes.map((f) => ({ ...f })) : [];
  const aliases: FakeAlias[] = fixture.aliases ? fixture.aliases.map((a) => ({ ...a })) : [];
  let seqFabricante = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prismaSolto: any = {
    produto: {
      findMany: async (args?: { where?: { id?: { in?: string[] }; fabricanteId?: null } }) => {
        if (args?.where?.id?.in) {
          const ids = args.where.id.in;
          return produtos.filter((p) => ids.includes(p.id));
        }
        if (args?.where && "fabricanteId" in args.where) {
          return produtos.filter((p) => p.fabricanteId === null);
        }
        return produtos;
      },
      update: async (args: { where: { id: string; fabricanteId?: null }; data: { fabricanteId: string } }) => {
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
        return (fixture.produtosFarmacia ?? []).filter((pf) => ids.includes(pf.produtoId) && pf.fabricanteErpAtual !== null);
      },
    },
    fabricante: {
      findMany: async () => fabricantes,
      create: async (args: { data: { nomeNormalizado: string } }) => {
        const novo = { id: `fNovo${seqFabricante++}`, nomeNormalizado: args.data.nomeNormalizado };
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
        aliases.push({ ...args.data });
        return args.data;
      },
    },
    regulatoryRecord: {
      findMany: async (args?: { where?: { cnp?: { in?: number[] } } }) => {
        const cnps = args?.where?.cnp?.in ?? [];
        return (fixture.registos ?? []).filter((r) => cnps.includes(r.cnp));
      },
    },
  };

  const prisma = prismaSolto as PrismaParaReconciliacaoFabricantes;
  return { prisma, produtos, fabricantes, aliases };
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

  console.log(`\n${ok} ok, ${ko} falhas`);
  process.exit(ko === 0 ? 0 : 1);
}

console.log("\nL · verificação estática — nunca escreve Fabricante (update/delete), nunca $transaction, tipos restritos");
{
  const src = readFileSync(new URL("../../lib/catalog/reconciliar-fabricantes-por-cnp-garantia.ts", import.meta.url), "utf8");
  const codigo = src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");

  check(!/\.fabricante\.(update|upsert|updateMany|createMany|deleteMany|delete)\(/.test(codigo), "L1: nenhuma escrita em Fabricante além de create");
  check(!/\.fabricanteAlias\.(update|upsert|updateMany|createMany|deleteMany|delete)\(/.test(codigo), "L2: nenhuma escrita em FabricanteAlias além de create");
  check(!/\.produto\.(upsert|updateMany|createMany|deleteMany|delete|create)\(/.test(codigo), "L3: nunca cria/apaga Produto — só update de fabricanteId");
  check(/produto:\s*Pick<PrismaClient\["produto"\],\s*"findMany"\s*\|\s*"update">/.test(codigo), "L4: 'produto' tipado como findMany|update apenas");
  check(/fabricante:\s*Pick<PrismaClient\["fabricante"\],\s*"findMany"\s*\|\s*"create">/.test(codigo), "L5: 'fabricante' tipado como findMany|create apenas");
  check(!/\$transaction/.test(codigo), "L6: nenhum $transaction — cada escrita é single-row já atómica");
  check(/if\s*\(\s*tenantSlug\s*!==\s*TENANT_TRAVADO\s*\)/.test(codigo), "L7: a trava de tenant é a primeira verificação do corpo da função");
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
