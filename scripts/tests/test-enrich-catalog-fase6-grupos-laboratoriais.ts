/**
 * scripts/tests/test-enrich-catalog-fase6-grupos-laboratoriais.ts
 *
 * Regressão operacional confirmada 2026-09-23, ANTES de qualquer deploy
 * do commit 3e34d86: `scripts/workers/scheduler.mjs` chama
 * `/api/jobs/enrich-catalog?apenasFila=1` a cada 15 minutos (rede de
 * segurança da fila de conhecimento — fase 3). A Fase 6
 * (reconciliação de `ProdutoGrupoLaboratorial`, exclusiva garantia) não
 * excluía esse modo — sem o termo `opts.apenasFila !== true` no gate,
 * `seleccionarProdutos({tipo:"lote"})` releria TODOS os produtos da
 * garantia e reconciliaria o shard do dia ~96x/dia, em vez de 1x (só na
 * corrida diária completa das 04:00, sem `apenasFila`).
 *
 * Testa `runEnrichCycle` directamente (não HTTP), com um Prisma falso
 * mínimo: fases 1/2 recebem sempre candidatos vazios (retorno cedo,
 * nunca tocam nenhuma tabela de grupo laboratorial); fase 5
 * (promocaoGlobal) é deixada falhar internamente — o próprio try/catch
 * da fase 5 protege o ciclo, exactamente como em produção, e o que essa
 * fase faz é irrelevante para esta regressão.
 *
 * Corre com: npx tsx scripts/tests/test-enrich-catalog-fase6-grupos-laboratoriais.ts
 */
import type { PrismaClient } from "../../generated/prisma/client";
import { runEnrichCycle } from "../../lib/jobs/enrich-catalog";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const eq = <T,>(a: T, b: T, label: string) =>
  check(JSON.stringify(a) === JSON.stringify(b), label, `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);

// ── CNP determinístico para o shard do dia real (evita teste sensível ──
// ── ao dia em que corre: buckets=20 é fixo, hardcoded na fase 6).     ──
const BUCKETS = 20;
const DIA_EPOCH = Math.floor(Date.now() / 86_400_000);
const SHARD_HOJE = DIA_EPOCH % BUCKETS;
const CNP_NO_SHARD_HOJE = SHARD_HOJE === 0 ? BUCKETS : SHARD_HOJE; // cnp > 0, cnp % BUCKETS === SHARD_HOJE

function criarPrismaMinimo(opts: { permitirGrupoLaboratorial: boolean; produtoGrupoLaboratorial?: { produtos: Array<{ id: string; cnp: number; fabricanteId: string | null }>; fabricantes: Array<{ id: string; nomeNormalizado: string }>; gruposFabricante: Array<{ fabricanteId: string; grupoLaboratorialId: string }>; existentes?: Array<{ produtoId: string; grupoLaboratorialId: string; origem: string; regraCnpId: string | null; validadoManualmente: boolean }> } }) {
  const chamadas = { produtoSemWhere: 0, fabricante: 0, regraCnp: 0, grupoFabricante: 0, alias: 0, pglFindMany: 0, pglCreate: 0, pglUpdate: 0, pglDelete: 0 };
  const recusar = (nome: string): never => { throw new Error(`NUNCA_DEVERIA_CHAMAR:${nome}`); };
  const fixture = opts.produtoGrupoLaboratorial;
  const pgl: Array<{ produtoId: string; grupoLaboratorialId: string; origem: string; regraCnpId: string | null; validadoManualmente: boolean }> = fixture?.existentes ? fixture.existentes.map((e) => ({ ...e })) : [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma: any = {
    produto: {
      findMany: async (args?: { where?: unknown }) => {
        if (!args?.where) {
          // Assinatura característica de seleccionarProdutos({tipo:"lote"})
          // — leitura leve SEM where, de TODOS os produtos garantia.
          chamadas.produtoSemWhere++;
          if (!opts.permitirGrupoLaboratorial) return recusar("produto.findMany sem where (leitura em lote do grupo laboratorial)");
          return fixture?.produtos ?? [];
        }
        return []; // fases 1/2 (sync/reclassify) — candidatos vazios, retorno cedo
      },
    },
    regulatoryRecord: { findMany: async () => [] },
    classificacao: { findFirst: async () => null, findMany: async () => [] },
    fabricante: {
      findMany: async () => {
        chamadas.fabricante++;
        if (!opts.permitirGrupoLaboratorial) return recusar("fabricante.findMany");
        return fixture?.fabricantes ?? [];
      },
    },
    regraGrupoLaboratorialPorCnp: {
      findMany: async () => {
        chamadas.regraCnp++;
        if (!opts.permitirGrupoLaboratorial) return recusar("regraGrupoLaboratorialPorCnp.findMany");
        return [];
      },
    },
    grupoLaboratorialFabricante: {
      findMany: async () => {
        chamadas.grupoFabricante++;
        if (!opts.permitirGrupoLaboratorial) return recusar("grupoLaboratorialFabricante.findMany");
        return fixture?.gruposFabricante ?? [];
      },
    },
    grupoLaboratorialAlias: {
      findMany: async () => {
        chamadas.alias++;
        if (!opts.permitirGrupoLaboratorial) return recusar("grupoLaboratorialAlias.findMany");
        return [];
      },
    },
    produtoGrupoLaboratorial: {
      findMany: async (args?: { where?: { produtoId?: { in?: string[] } } }) => {
        chamadas.pglFindMany++;
        if (!opts.permitirGrupoLaboratorial) return recusar("produtoGrupoLaboratorial.findMany");
        const ids = args?.where?.produtoId?.in ?? [];
        return pgl.filter((p) => ids.includes(p.produtoId));
      },
      create: async (args: { data: { produtoId: string; grupoLaboratorialId: string; origem: string; regraCnpId: string | null } }) => {
        chamadas.pglCreate++;
        if (!opts.permitirGrupoLaboratorial) return recusar("produtoGrupoLaboratorial.create");
        const nova = { validadoManualmente: false, ...args.data };
        pgl.push(nova);
        return nova;
      },
      update: async (args: { where: { produtoId: string }; data: { grupoLaboratorialId: string; origem: string; regraCnpId: string | null } }) => {
        chamadas.pglUpdate++;
        if (!opts.permitirGrupoLaboratorial) return recusar("produtoGrupoLaboratorial.update");
        const idx = pgl.findIndex((p) => p.produtoId === args.where.produtoId);
        pgl[idx] = { ...pgl[idx]!, ...args.data };
        return pgl[idx]!;
      },
      delete: async (args: { where: { produtoId: string } }) => {
        chamadas.pglDelete++;
        if (!opts.permitirGrupoLaboratorial) return recusar("produtoGrupoLaboratorial.delete");
        const idx = pgl.findIndex((p) => p.produtoId === args.where.produtoId);
        const [removido] = pgl.splice(idx, 1);
        return removido!;
      },
    },
  };
  return { prisma: prisma as PrismaClient, chamadas, pgl };
}

async function principal() {
  console.log("A · Garantia + apenasFila=true — ZERO chamadas às tabelas de grupo laboratorial (#6.1)");
  {
    const { prisma, chamadas } = criarPrismaMinimo({ permitirGrupoLaboratorial: false });
    const r = await runEnrichCycle({ prisma, tenantSlug: "garantia", apenasFila: true });
    eq(r.gruposLaboratoriais, null, "A1: gruposLaboratoriais fica null");
    eq(chamadas.produtoSemWhere, 0, "A2: nunca leu a lista completa de produtos para o shard (produto.findMany sem where)");
    eq(chamadas.fabricante, 0, "A3: fabricante.findMany nunca chamado");
    eq(chamadas.regraCnp, 0, "A4: regraGrupoLaboratorialPorCnp.findMany nunca chamado");
    eq(chamadas.grupoFabricante, 0, "A5: grupoLaboratorialFabricante.findMany nunca chamado");
    eq(chamadas.alias, 0, "A6: grupoLaboratorialAlias.findMany nunca chamado");
    eq(chamadas.pglFindMany, 0, "A7: produtoGrupoLaboratorial.findMany nunca chamado");
  }

  console.log("\nB · Garantia + apenasFila=false/undefined — reconciliador chamado UMA vez, corrida completa (#6.2)");
  for (const apenasFila of [false, undefined] as const) {
    // Fixture com 1 produto no shard de hoje — garante que o fluxo chega
    // mesmo a carregarMapas() (senão produtos.length===0 devolve cedo,
    // sem tocar fabricante/regra/alias, e a asserção B4 não provaria nada).
    const fixture = {
      produtos: [{ id: "p1", cnp: CNP_NO_SHARD_HOJE, fabricanteId: "fMylan" }],
      fabricantes: [{ id: "fMylan", nomeNormalizado: "MYLAN" }],
      gruposFabricante: [{ fabricanteId: "fMylan", grupoLaboratorialId: "gViatris" }],
    };
    const { prisma, chamadas } = criarPrismaMinimo({ permitirGrupoLaboratorial: true, produtoGrupoLaboratorial: fixture });
    const r = await runEnrichCycle({ prisma, tenantSlug: "garantia", apenasFila });
    check(r.gruposLaboratoriais !== null, `B1 (apenasFila=${apenasFila}): gruposLaboratoriais não é null`);
    eq(r.gruposLaboratoriais?.erro ?? null, null, `B2 (apenasFila=${apenasFila}): a fase corre sem erro`);
    eq(chamadas.produtoSemWhere, 1, `B3 (apenasFila=${apenasFila}): produto.findMany sem where chamado exactamente 1 vez`);
    eq(chamadas.fabricante, 1, `B4 (apenasFila=${apenasFila}): fabricante.findMany chamado exactamente 1 vez`);
  }

  console.log("\nC · sier/silveira — NUNCA chamado, independentemente de apenasFila (#6.3)");
  for (const tenantSlug of ["sier", "silveira"]) {
    for (const apenasFila of [true, false, undefined] as const) {
      const { prisma, chamadas } = criarPrismaMinimo({ permitirGrupoLaboratorial: false });
      const r = await runEnrichCycle({ prisma, tenantSlug, apenasFila });
      eq(r.gruposLaboratoriais, null, `C1 (${tenantSlug}, apenasFila=${apenasFila}): gruposLaboratoriais fica null`);
      eq(chamadas.produtoSemWhere, 0, `C2 (${tenantSlug}, apenasFila=${apenasFila}): nunca leu produtos em lote`);
      eq(chamadas.fabricante, 0, `C3 (${tenantSlug}, apenasFila=${apenasFila}): fabricante.findMany nunca chamado`);
    }
  }

  console.log("\nD · corrida completa via runEnrichCycle — segunda reconciliação continua idempotente (#6.4)");
  {
    const fixture = {
      produtos: [{ id: "p1", cnp: CNP_NO_SHARD_HOJE, fabricanteId: "fMylan" }],
      fabricantes: [{ id: "fMylan", nomeNormalizado: "MYLAN" }],
      gruposFabricante: [{ fabricanteId: "fMylan", grupoLaboratorialId: "gViatris" }],
    };
    const { prisma, pgl } = criarPrismaMinimo({ permitirGrupoLaboratorial: true, produtoGrupoLaboratorial: fixture });
    const r1 = await runEnrichCycle({ prisma, tenantSlug: "garantia", apenasFila: false });
    eq(r1.gruposLaboratoriais?.criados, 1, "D1: primeira corrida cria 1 (p1 no shard de hoje → Viatris)");
    eq(pgl.length, 1, "D2: 1 linha real após a primeira corrida");

    const r2 = await runEnrichCycle({ prisma, tenantSlug: "garantia", apenasFila: false });
    eq(r2.gruposLaboratoriais?.criados, 0, "D3: segunda corrida — zero criados");
    eq(r2.gruposLaboratoriais?.atualizados, 0, "D4: segunda corrida — zero atualizados");
    eq(r2.gruposLaboratoriais?.removidos, 0, "D5: segunda corrida — zero removidos");
    eq(r2.gruposLaboratoriais?.semAlteracao, 1, "D6: segunda corrida — p1 fica semAlteracao");
    eq(pgl.length, 1, "D7: continua a existir exactamente 1 linha — zero duplicados");
  }

  console.log("\nE · corrida completa via runEnrichCycle — classificação manual preservada (#6.5)");
  {
    const fixture = {
      produtos: [{ id: "p1", cnp: CNP_NO_SHARD_HOJE, fabricanteId: "fMylan" }], // sinal FORTE para Viatris
      fabricantes: [{ id: "fMylan", nomeNormalizado: "MYLAN" }],
      gruposFabricante: [{ fabricanteId: "fMylan", grupoLaboratorialId: "gViatris" }],
      existentes: [{ produtoId: "p1", grupoLaboratorialId: "gOutroManual", origem: "MANUAL", regraCnpId: null, validadoManualmente: true }],
    };
    const { prisma, pgl } = criarPrismaMinimo({ permitirGrupoLaboratorial: true, produtoGrupoLaboratorial: fixture });
    const r = await runEnrichCycle({ prisma, tenantSlug: "garantia", apenasFila: false });
    eq(r.gruposLaboratoriais?.manuaisPreservados, 1, "E1: contado como manual preservado");
    eq(r.gruposLaboratoriais?.criados, 0, "E2: zero criados");
    eq(r.gruposLaboratoriais?.atualizados, 0, "E3: zero atualizados");
    eq(pgl[0]?.grupoLaboratorialId, "gOutroManual", "E4: a linha manual continua EXACTAMENTE como estava");
  }

  console.log(`\n${ok} ok, ${ko} falhas`);
  process.exit(ko === 0 ? 0 : 1);
}

principal();
