/**
 * scripts/tests/test-reconciliar-grupos-laboratoriais-garantia.ts
 *
 * Testa lib/catalog/reconciliar-grupos-laboratoriais-garantia.ts — a
 * manutenção automática de ProdutoGrupoLaboratorial (ingest imediato +
 * reconciliação diária). Nunca testa a precedência do resolver em si
 * (já coberta em scripts/tests/test-resolver-grupo-laboratorial.ts,
 * blocos B-K, incluindo o caso Pfizer) — testa a orquestração
 * create/update/delete/skip em cima dele, contra um Prisma falso
 * mutável, mais a trava de tenant e verificação estática das duas
 * integrações (ingest, enrich-catalog).
 *
 * Corre com: npx tsx scripts/tests/test-reconciliar-grupos-laboratoriais-garantia.ts
 */
import { readFileSync } from "node:fs";
import {
  reconciliarGruposLaboratoriaisGarantia,
  TENANT_TRAVADO,
  type PrismaParaReconciliacaoGrupos,
} from "../../lib/catalog/reconciliar-grupos-laboratoriais-garantia";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const eq = <T,>(a: T, b: T, label: string) =>
  check(JSON.stringify(a) === JSON.stringify(b), label, `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);

// ── Fake Prisma mutável — um por fixture, reutilizável entre blocos ────

type FakeProduto = { id: string; cnp: number; fabricanteId: string | null };
type FakeFabricante = { id: string; nomeNormalizado: string };
type FakeRegraCnp = { id: string; cnp: number; grupoLaboratorialId: string; estado: "ATIVO" | "INATIVO"; validadoManualmente: boolean };
type FakeGrupoFabricante = { fabricanteId: string; grupoLaboratorialId: string };
type FakeAlias = { grupoLaboratorialId: string; aliasNormalizado: string; estado: "ATIVO" | "INATIVO" };
type FakeSnapshot = { cnp: number; titularAim: string | null; estadoAim: string | null };
type FakePgl = { produtoId: string; grupoLaboratorialId: string; origem: string; regraCnpId: string | null; validadoManualmente: boolean };

function criarPrismaFalso(fixture: {
  produtos: FakeProduto[];
  fabricantes: FakeFabricante[];
  regrasCnp?: FakeRegraCnp[];
  gruposFabricante?: FakeGrupoFabricante[];
  aliases?: FakeAlias[];
  snapshots?: FakeSnapshot[];
  existentes?: FakePgl[];
}) {
  const pgl: FakePgl[] = fixture.existentes ? fixture.existentes.map((e) => ({ ...e })) : [];
  const chamadas = { produtoFindMany: 0, fabricanteFindMany: 0 };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prismaSolto: any = {
    produto: {
      findMany: async (args?: { where?: { id?: { in?: string[] } } }) => {
        chamadas.produtoFindMany++;
        const ids = args?.where?.id?.in;
        return ids ? fixture.produtos.filter((p) => ids.includes(p.id)) : fixture.produtos;
      },
    },
    fabricante: {
      findMany: async () => {
        chamadas.fabricanteFindMany++;
        return fixture.fabricantes;
      },
    },
    regraGrupoLaboratorialPorCnp: { findMany: async () => fixture.regrasCnp ?? [] },
    grupoLaboratorialFabricante: { findMany: async () => fixture.gruposFabricante ?? [] },
    grupoLaboratorialAlias: { findMany: async () => fixture.aliases ?? [] },
    regulatoryRecord: {
      findMany: async (args?: { where?: { cnp?: { in?: number[] } } }) => {
        const cnps = args?.where?.cnp?.in ?? [];
        return (fixture.snapshots ?? []).filter((s) => cnps.includes(s.cnp));
      },
    },
    produtoGrupoLaboratorial: {
      findMany: async (args?: { where?: { produtoId?: { in?: string[] } } }) => {
        const ids = args?.where?.produtoId?.in ?? [];
        return pgl.filter((p) => ids.includes(p.produtoId));
      },
      create: async (args: { data: { produtoId: string; grupoLaboratorialId: string; origem: string; regraCnpId: string | null } }) => {
        const nova: FakePgl = { validadoManualmente: false, ...args.data };
        pgl.push(nova);
        return nova;
      },
      update: async (args: { where: { produtoId: string }; data: { grupoLaboratorialId: string; origem: string; regraCnpId: string | null } }) => {
        const idx = pgl.findIndex((p) => p.produtoId === args.where.produtoId);
        if (idx < 0) throw new Error(`update: produtoId "${args.where.produtoId}" não existe`);
        pgl[idx] = { ...pgl[idx]!, ...args.data };
        return pgl[idx]!;
      },
      delete: async (args: { where: { produtoId: string } }) => {
        const idx = pgl.findIndex((p) => p.produtoId === args.where.produtoId);
        if (idx < 0) throw new Error(`delete: produtoId "${args.where.produtoId}" não existe`);
        const [removido] = pgl.splice(idx, 1);
        return removido!;
      },
    },
  };

  const prisma = prismaSolto as PrismaParaReconciliacaoGrupos;
  return { prisma, pgl, chamadas };
}

// ── Fixture partilhada: 2 grupos, fabricantes reais representativos ────

function fixtureBase() {
  return {
    fabricantes: [
      { id: "fMylan", nomeNormalizado: "MYLAN" },
      { id: "fMylanGenericos", nomeNormalizado: "MYLAN GENERICOS" },
      { id: "fAlfaW", nomeNormalizado: "ALFA WASSERMANN- PROD FARM LDA" },
      { id: "fPfizer", nomeNormalizado: "LABORATORIOS PFIZER" },
      { id: "fJanssen", nomeNormalizado: "JANSSEN CILAG FARMACEUT LDA" },
      { id: "fJntl", nomeNormalizado: "JNTL CONSUMER HEALTH PORTUGAL LIMITADA" },
      { id: "fIndep", nomeNormalizado: "FARMACEUTICA INDEPENDENTE LDA" },
    ] satisfies FakeFabricante[],
    gruposFabricante: [
      { fabricanteId: "fMylan", grupoLaboratorialId: "gViatris" },
      { fabricanteId: "fMylanGenericos", grupoLaboratorialId: "gViatris" },
      { fabricanteId: "fAlfaW", grupoLaboratorialId: "gAlfasigma" },
      { fabricanteId: "fJntl", grupoLaboratorialId: "gKenvue" },
      // fPfizer, fJanssen, fIndep: deliberadamente AUSENTES — nunca integrais.
    ] satisfies FakeGrupoFabricante[],
  };
}

async function principal() {
  console.log("A · trava de tenant — recusa ANTES de qualquer query");
  {
    const stub = ({
      produto: { findMany: async () => { throw new Error("SHOULD_NEVER_CALL produto.findMany"); } },
      fabricante: { findMany: async () => { throw new Error("SHOULD_NEVER_CALL fabricante.findMany"); } },
      regraGrupoLaboratorialPorCnp: { findMany: async () => { throw new Error("SHOULD_NEVER_CALL regraGrupoLaboratorialPorCnp.findMany"); } },
      grupoLaboratorialFabricante: { findMany: async () => { throw new Error("SHOULD_NEVER_CALL grupoLaboratorialFabricante.findMany"); } },
      grupoLaboratorialAlias: { findMany: async () => { throw new Error("SHOULD_NEVER_CALL grupoLaboratorialAlias.findMany"); } },
      regulatoryRecord: { findMany: async () => { throw new Error("SHOULD_NEVER_CALL regulatoryRecord.findMany"); } },
      produtoGrupoLaboratorial: {
        findMany: async () => { throw new Error("SHOULD_NEVER_CALL produtoGrupoLaboratorial.findMany"); },
        create: async () => { throw new Error("SHOULD_NEVER_CALL produtoGrupoLaboratorial.create"); },
        update: async () => { throw new Error("SHOULD_NEVER_CALL produtoGrupoLaboratorial.update"); },
        delete: async () => { throw new Error("SHOULD_NEVER_CALL produtoGrupoLaboratorial.delete"); },
      },
    } as unknown) as PrismaParaReconciliacaoGrupos;
    eq(TENANT_TRAVADO, "garantia", "A0: tenant travado é garantia");

    for (const slug of ["sier", "silveira", "", "GARANTIA"]) {
      let mensagem = "";
      try {
        await reconciliarGruposLaboratoriaisGarantia(stub, slug, { tipo: "lote" });
      } catch (err) {
        mensagem = err instanceof Error ? err.message : String(err);
      }
      check(mensagem.includes(TENANT_TRAVADO), `A1 (tenantSlug="${slug}"): recusado com uma mensagem do PRÓPRIO serviço, mencionando "garantia"`, mensagem);
      check(!mensagem.includes("SHOULD_NEVER_CALL"), `A2 (tenantSlug="${slug}"): nunca chegou a tocar em nenhum delegate — recusado antes de qualquer query`, mensagem);
    }
  }

  console.log("\nB · classificação manual sobrevive a sinais fortemente contraditórios (#9)");
  {
    const base = fixtureBase();
    const { prisma, pgl } = criarPrismaFalso({
      produtos: [{ id: "p1", cnp: 1001, fabricanteId: "fMylan" }], // sinal FORTE para Viatris
      fabricantes: base.fabricantes,
      gruposFabricante: base.gruposFabricante,
      existentes: [{ produtoId: "p1", grupoLaboratorialId: "gOutroManual", origem: "MANUAL", regraCnpId: null, validadoManualmente: true }],
    });
    const r = await reconciliarGruposLaboratoriaisGarantia(prisma, "garantia", { tipo: "produtos", produtoIds: ["p1"] });
    eq(r.manuaisPreservados, 1, "B1: contado como manual preservado");
    eq(r.criados, 0, "B2: zero criados");
    eq(r.atualizados, 0, "B3: zero atualizados");
    eq(r.removidos, 0, "B4: zero removidos");
    eq(pgl[0]?.grupoLaboratorialId, "gOutroManual", "B5: a linha manual continua EXACTAMENTE como estava, apesar do fabricante apontar fortemente para outro grupo");
  }

  console.log("\nC · fabricante_inequivoco cria correctamente (#1, #2)");
  {
    const base = fixtureBase();
    const { prisma, pgl } = criarPrismaFalso({
      produtos: [
        { id: "p1", cnp: 2001, fabricanteId: "fMylan" },
        { id: "p2", cnp: 2002, fabricanteId: "fAlfaW" },
      ],
      fabricantes: base.fabricantes,
      gruposFabricante: base.gruposFabricante,
    });
    const r = await reconciliarGruposLaboratoriaisGarantia(prisma, "garantia", { tipo: "produtos", produtoIds: ["p1", "p2"] });
    eq(r.criados, 2, "C1: os 2 produtos são criados");
    const viatris = pgl.find((p) => p.produtoId === "p1");
    eq(viatris?.grupoLaboratorialId, "gViatris", "C2: produto Mylan → Viatris");
    eq(viatris?.origem, "FABRICANTE_INEQUIVOCO", "C3: origem correcta");
    const alfasigma = pgl.find((p) => p.produtoId === "p2");
    eq(alfasigma?.grupoLaboratorialId, "gAlfasigma", "C4: produto Alfa Wassermann → Alfasigma");
  }

  console.log("\nD · Pfizer só por CNP, nunca integral; Janssen nunca em Kenvue; fabricante independente fica sem grupo (#3, #4, #5, #6)");
  {
    const base = fixtureBase();
    const { prisma, pgl } = criarPrismaFalso({
      produtos: [
        { id: "pPfizerComRegra", cnp: 3001, fabricanteId: "fPfizer" },
        { id: "pPfizerSemRegra", cnp: 3002, fabricanteId: "fPfizer" },
        { id: "pJanssen", cnp: 3003, fabricanteId: "fJanssen" },
        { id: "pIndependente", cnp: 3004, fabricanteId: "fIndep" },
      ],
      fabricantes: base.fabricantes,
      gruposFabricante: base.gruposFabricante,
      regrasCnp: [{ id: "r1", cnp: 3001, grupoLaboratorialId: "gViatris", estado: "ATIVO", validadoManualmente: true }],
      // Janssen: mesmo com uma PROPOSTA de catálogo apontando para Kenvue
      // (via titular JNTL, que É integral em Kenvue), nunca é aplicada.
      snapshots: [{ cnp: 3003, titularAim: "JNTL Consumer Health (Portugal) Limitada", estadoAim: "Ativo" }],
    });
    const r = await reconciliarGruposLaboratoriaisGarantia(prisma, "garantia", {
      tipo: "produtos",
      produtoIds: ["pPfizerComRegra", "pPfizerSemRegra", "pJanssen", "pIndependente"],
    });

    const pfizerComRegra = pgl.find((p) => p.produtoId === "pPfizerComRegra");
    eq(pfizerComRegra?.grupoLaboratorialId, "gViatris", "D1: Pfizer COM regra CNP validada entra em Viatris");
    eq(pfizerComRegra?.origem, "REGRA_CNP", "D2: origem é REGRA_CNP, nunca FABRICANTE_INEQUIVOCO");
    check(!pgl.some((p) => p.produtoId === "pPfizerSemRegra"), "D3: Pfizer SEM regra CNP nunca entra integralmente em Viatris — nenhuma linha criada");
    check(!pgl.some((p) => p.produtoId === "pJanssen"), "D4: Janssen nunca entra em Kenvue — nenhuma linha criada, mesmo com proposta de catálogo apontando lá");
    check(!pgl.some((p) => p.produtoId === "pIndependente"), "D5: fabricante independente fica sem grupo — nenhuma linha criada");
    eq(r.semGrupo, 2, "D6: pPfizerSemRegra + pIndependente contam como semGrupo");
    eq(r.propostasNaoAplicadas, 1, "D7: pJanssen conta como proposta não aplicada (tinha snapshot, mas nunca escreve)");
  }

  console.log("\nE · troca entre fabricantes integrais do MESMO grupo não escreve (#8)");
  {
    const base = fixtureBase();
    const { prisma, pgl, chamadas } = criarPrismaFalso({
      produtos: [{ id: "p1", cnp: 4001, fabricanteId: "fMylanGenericos" }], // mudou de fMylan para fMylanGenericos — mesmo grupo
      fabricantes: base.fabricantes,
      gruposFabricante: base.gruposFabricante,
      existentes: [{ produtoId: "p1", grupoLaboratorialId: "gViatris", origem: "FABRICANTE_INEQUIVOCO", regraCnpId: null, validadoManualmente: false }],
    });
    const r = await reconciliarGruposLaboratoriaisGarantia(prisma, "garantia", { tipo: "produtos", produtoIds: ["p1"] });
    eq(r.semAlteracao, 1, "E1: contado como sem alteração");
    eq(r.criados, 0, "E2: zero criados");
    eq(r.atualizados, 0, "E3: zero atualizados (o grupo já era o correcto — Viatris continua Viatris)");
    eq(pgl.length, 1, "E4: continua a existir exactamente 1 linha, intacta");
    eq(chamadas.produtoFindMany, 1, "E5: produto.findMany chamado uma única vez (leitura em lote, não N+1)");
  }

  console.log("\nF · perde classificação automática ao mudar para fabricante não relacionado; proposta/sem_grupo remove automática antiga (#7, #11)");
  {
    const base = fixtureBase();
    const { prisma, pgl } = criarPrismaFalso({
      produtos: [
        { id: "pParaIndep", cnp: 5001, fabricanteId: "fIndep" }, // era Mylan, mudou para independente
        { id: "pParaProposta", cnp: 5002, fabricanteId: "fIndep" }, // era Mylan, mudou para independente, mas o CNP tem proposta de catálogo
        { id: "pParaSemGrupo", cnp: 5003, fabricanteId: "fIndep" },
      ],
      fabricantes: base.fabricantes,
      gruposFabricante: base.gruposFabricante,
      snapshots: [{ cnp: 5002, titularAim: "JNTL Consumer Health (Portugal) Limitada", estadoAim: "Ativo" }],
      existentes: [
        { produtoId: "pParaIndep", grupoLaboratorialId: "gViatris", origem: "FABRICANTE_INEQUIVOCO", regraCnpId: null, validadoManualmente: false },
        { produtoId: "pParaProposta", grupoLaboratorialId: "gViatris", origem: "FABRICANTE_INEQUIVOCO", regraCnpId: null, validadoManualmente: false },
        { produtoId: "pParaSemGrupo", grupoLaboratorialId: "gViatris", origem: "FABRICANTE_INEQUIVOCO", regraCnpId: null, validadoManualmente: false },
      ],
    });
    const r = await reconciliarGruposLaboratoriaisGarantia(prisma, "garantia", {
      tipo: "produtos",
      produtoIds: ["pParaIndep", "pParaProposta", "pParaSemGrupo"],
    });
    eq(r.removidos, 3, "F1: as 3 classificações automáticas antigas são removidas");
    check(!pgl.some((p) => p.produtoId === "pParaIndep"), "F2: produto que passou a fabricante independente perde a classificação Viatris");
    check(!pgl.some((p) => p.produtoId === "pParaProposta"), "F3: mesmo quando o novo estado é uma PROPOSTA (não sem_grupo), a automática antiga é removida — proposta nunca é escrita no lugar");
    check(!pgl.some((p) => p.produtoId === "pParaSemGrupo"), "F4: e quando o novo estado é sem_grupo puro");
  }

  console.log("\nG · proposta_snapshot_cnp nunca é persistida automaticamente (#10)");
  {
    const base = fixtureBase();
    const { prisma, pgl } = criarPrismaFalso({
      produtos: [{ id: "p1", cnp: 6001, fabricanteId: "fIndep" }],
      fabricantes: base.fabricantes,
      gruposFabricante: base.gruposFabricante,
      snapshots: [{ cnp: 6001, titularAim: "JNTL Consumer Health (Portugal) Limitada", estadoAim: "Ativo" }],
    });
    const r = await reconciliarGruposLaboratoriaisGarantia(prisma, "garantia", { tipo: "produtos", produtoIds: ["p1"] });
    eq(r.propostasNaoAplicadas, 1, "G1: contado como proposta não aplicada");
    eq(r.criados, 0, "G2: zero criados");
    eq(pgl.length, 0, "G3: nenhuma linha ProdutoGrupoLaboratorial — a proposta nunca vira escrita real");
  }

  console.log("\nH · segunda reconciliação consecutiva produz zero escritas (#12)");
  {
    const base = fixtureBase();
    const { prisma, pgl } = criarPrismaFalso({
      produtos: [
        { id: "p1", cnp: 7001, fabricanteId: "fMylan" }, // vai criar
        { id: "p2", cnp: 7002, fabricanteId: "fIndep" }, // fica sem grupo
      ],
      fabricantes: base.fabricantes,
      gruposFabricante: base.gruposFabricante,
    });
    const r1 = await reconciliarGruposLaboratoriaisGarantia(prisma, "garantia", { tipo: "produtos", produtoIds: ["p1", "p2"] });
    eq(r1.criados, 1, "H1: primeira corrida cria 1 (p1 → Viatris)");
    eq(r1.semGrupo, 1, "H2: primeira corrida — p2 sem grupo");
    eq(pgl.length, 1, "H3: 1 linha real na base falsa após a primeira corrida");

    const r2 = await reconciliarGruposLaboratoriaisGarantia(prisma, "garantia", { tipo: "produtos", produtoIds: ["p1", "p2"] });
    eq(r2.criados, 0, "H4: segunda corrida — zero criados");
    eq(r2.atualizados, 0, "H5: segunda corrida — zero atualizados");
    eq(r2.removidos, 0, "H6: segunda corrida — zero removidos");
    eq(r2.semAlteracao, 1, "H7: p1 fica semAlteracao (já estava correcto)");
    eq(r2.semGrupo, 1, "H8: p2 continua semGrupo, sem escrita nenhuma");
    eq(pgl.length, 1, "H9: continua a existir exactamente 1 linha — zero duplicados");
  }

  console.log(`\n${ok} ok, ${ko} falhas`);
  process.exit(ko === 0 ? 0 : 1);
}

console.log("\nI · verificação estática — nunca escreve Produto/Fabricante, escrita restrita a 4 métodos em ProdutoGrupoLaboratorial");
{
  const src = readFileSync(new URL("../../lib/catalog/reconciliar-grupos-laboratoriais-garantia.ts", import.meta.url), "utf8");
  const codigo = src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");

  check(!/\.produto\.(update|upsert|create|updateMany|createMany|deleteMany|delete)\(/.test(codigo), "I1: nenhuma escrita em Produto");
  check(!/\.fabricante\.(update|upsert|create|updateMany|createMany|deleteMany|delete)\(/.test(codigo), "I2: nenhuma escrita em Fabricante");
  check(/produto:\s*Pick<PrismaClient\["produto"\],\s*"findMany">/.test(codigo), "I3: 'produto' tipado como só-leitura (findMany)");
  check(/fabricante:\s*Pick<PrismaClient\["fabricante"\],\s*"findMany">/.test(codigo), "I4: 'fabricante' tipado como só-leitura (findMany)");
  check(/produtoGrupoLaboratorial:\s*Pick<PrismaClient\["produtoGrupoLaboratorial"\],\s*"findMany"\s*\|\s*"create"\s*\|\s*"update"\s*\|\s*"delete">/.test(codigo), "I5: 'produtoGrupoLaboratorial' restrito a exactamente findMany/create/update/delete — nunca upsert nem *Many");
  check(!/\$transaction/.test(codigo), "I6: nenhum $transaction — cada escrita é single-row já atómica");
  check(/if\s*\(\s*tenantSlug\s*!==\s*TENANT_TRAVADO\s*\)/.test(codigo), "I7: a trava de tenant é a primeira verificação do corpo da função");
}

console.log("\nK · verificação estática — app/api/ingest/v1/bootstrap/products/route.ts nunca chama fora do gate garantia, catch nunca aborta o ingest (#13, #15)");
{
  const src = readFileSync(
    new URL("../../app/api/ingest/v1/bootstrap/products/route.ts", import.meta.url),
    "utf8",
  );
  const chamadas = [...src.matchAll(/reconciliarGruposLaboratoriaisGarantia/g)];
  check(chamadas.length === 4, "K1: exactamente 4 referências ao identificador — 2 destructuring + 2 chamadas (bulk e fallback); o import de tipo usa o caminho kebab-case, não este identificador", `encontradas: ${chamadas.length}`);

  // Cada chamada real (não o import de tipo) tem de estar precedida, nas
  // ~10 linhas anteriores, por um `if (ctx.tenant.slug === "garantia")`
  // sem nenhum `if` ou `}` a fechar esse guard antes da chamada.
  const linhas = src.split("\n");
  const linhasComChamada = linhas
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l.includes("await reconciliarGruposLaboratoriaisGarantia") || l.includes("reconciliarGruposLaboratoriaisGarantia(ctx.prisma"));
  check(linhasComChamada.length === 2, "K2: exactamente 2 chamadas reais (import dinâmico) — bulk e fallback", `encontradas: ${linhasComChamada.length}`);
  for (const { i } of linhasComChamada) {
    const janela = linhas.slice(Math.max(0, i - 6), i).join("\n");
    check(/if\s*\(\s*ctx\.tenant\.slug\s*===\s*"garantia"\s*\)/.test(janela), `K3 (linha ${i + 1}): a chamada está dentro de um if (ctx.tenant.slug === "garantia") nas linhas imediatamente anteriores`, janela);
  }

  check(/const \{ reconciliarGruposLaboratoriaisGarantia \} = await import\(/.test(src), "K4: a chamada usa import() dinâmico, não um import estático de topo (custo zero para outros tenants)");

  // O catch da nova chamada nunca pode tocar `upserted`/`errors` nem
  // abortar o pedido — só console.error, exactamente como os outros
  // blocos de enriquecimento (applyErpCatalogFields, reconciliarImportacaoComGlobal).
  const ocorrenciasMensagem = [...src.matchAll(/classificação de grupos laboratoriais falhou/g)];
  check(ocorrenciasMensagem.length === 2, "K5a: exactamente 2 mensagens de erro (bulk + fallback)", `encontradas: ${ocorrenciasMensagem.length}`);
  for (const m of ocorrenciasMensagem) {
    const inicio = m.index ?? 0;
    const fimBloco = src.indexOf("\n      }", inicio); // fecha o `catch { ... }`
    const trecho = src.slice(inicio, fimBloco > inicio ? fimBloco : inicio + 300);
    check(!/upserted|\breturn\b|\bthrow\b/.test(trecho), `K5b (offset ${inicio}): o catch não referencia upserted, não tem return nem throw`, trecho);
  }
}

console.log("\nL · verificação estática — lib/jobs/enrich-catalog.ts gate estrito === garantia, catch nunca lança (#13, #15)");
{
  const src = readFileSync(new URL("../../lib/jobs/enrich-catalog.ts", import.meta.url), "utf8");
  check(/if\s*\(\s*opts\.tenantSlug\s*===\s*"garantia"\s*\)\s*\{\s*\n\s*try\s*\{\s*\n\s*const \{ reconciliarGruposLaboratoriaisGarantia \} = await import\(/.test(src), "L1: a fase 6 está gated por opts.tenantSlug === \"garantia\" (estrito, nunca truthy) e usa import() dinâmico");
  check(/const \{ reconciliarGruposLaboratoriaisGarantia \} = await import\(/.test(src), "L2: import dinâmico confirmado");

  const idxFase6 = src.indexOf("Fase 6: reconciliar ProdutoGrupoLaboratorial");
  check(idxFase6 >= 0, "L3: a fase 6 existe no ficheiro");
  const trechoFase6 = src.slice(idxFase6, src.indexOf("return {", idxFase6));
  check(!/\bthrow\b/.test(trechoFase6.replace(/\/\/.*$/gm, "")), "L4: o bloco da fase 6 nunca faz throw — o catch só atribui a gruposLaboratoriais, mesma política das fases 3/5");
  check(/gruposLaboratoriais = \{ \.\.\.resultado, erro: null \};/.test(trechoFase6), "L5: sucesso atribui erro:null explicitamente");
  check(/erro: e instanceof Error \? e\.message\.slice\(0, 300\) : String\(e\)\.slice\(0, 300\),/.test(trechoFase6), "L6: falha regista a mensagem truncada, mesma convenção das fases 3/5");
  check(/gruposLaboratoriais,\s*\n\s*totalDurationMs:/.test(src), "L7: gruposLaboratoriais entra no objecto devolvido");
}

principal();
