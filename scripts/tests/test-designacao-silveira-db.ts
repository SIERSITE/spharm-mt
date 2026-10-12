/**
 * scripts/tests/test-designacao-silveira-db.ts
 *
 * PostgreSQL REAL e DESCARTÁVEL (recusa correr fora de localhost):
 *
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:55490/postgres \
 *     npx tsx scripts/tests/test-designacao-silveira-db.ts
 *
 * Autoridade da designação da farmácia Silveirense no tenant `silveira`
 * (lib/ingest/designacao-silveira.ts). Cria uma base nova, aplica TODAS as
 * migrations e exercita o MESMO caminho que o endpoint de produtos usa
 * (`resolverModoDesignacao` + `upsertProdutosComDesignacao`) e o passo leve
 * (`aplicarDesignacoesAutoritativas`).
 *
 * Numeração = a do pedido (1–15), mais as provas de configuração, ficha
 * manual, normalização de espaços e isolamento dos outros campos.
 */
import Module from "node:module";
import { execSync, spawnSync } from "node:child_process";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

const M = Module as unknown as { _resolveFilename: (r: string, ...a: unknown[]) => string };
const resolverOriginal = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "server-only" ? __filename : resolverOriginal.call(this, request, ...rest);
};

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string, detalhe?: string) {
  if (cond) { passed++; console.log(`  [OK]    ${msg}`); }
  else { failed++; console.log(`  [FALHA] ${msg}${detalhe ? `\n            ${detalhe}` : ""}`); }
}

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgresql://postgres:test@localhost:55490/postgres";
const host = new URL(ADMIN_URL).hostname;
if (host !== "localhost" && host !== "127.0.0.1") {
  console.error(`RECUSADO: ${host} não é uma base local descartável.`);
  process.exit(2);
}
function urlDe(db: string) {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${db}`;
  return u.toString();
}

const NBSP = String.fromCharCode(160);

async function main() {
  const db = `spharm_test_desig_${Date.now().toString(36)}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${db}`);
  try {
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(db) }, encoding: "utf8" });
    process.env.DATABASE_URL = urlDe(db);
    const { PrismaClient } = await import("../../generated/prisma/client");
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(db) }) });
    const D = await import("../../lib/ingest/designacao-silveira");

    // As farmácias NÃO têm codigoANF (como em produção): só o Farmacia.id conta.
    const silv = await prisma.farmacia.create({ data: { nome: "Farmácia Silveirense" } });
    const seg = await prisma.farmacia.create({ data: { nome: "Farmácia Segurado" } });
    const ENV = { [D.ENV_FARMACIA_ID_DESIGNACAO]: silv.id };

    let proximo = 9_200_000;
    const novoCnp = () => ++proximo;
    type Linha = { cnp: number; designacao: string; externalProductId?: number | null };

    /** O que o endpoint de produtos faz com os lotes de uma farmácia (mesmas funções). */
    async function sync(tenant: string, farmacia: { id: string }, linhas: Linha[], env: Record<string, string | undefined> = ENV) {
      const { autoridade, modo } = await D.resolverModoDesignacao(prisma, tenant, farmacia.id, env);
      const r = await D.upsertProdutosComDesignacao(
        prisma,
        modo,
        linhas.map((l) => ({
          cnp: l.cnp, externalProductId: l.externalProductId ?? null, designacao: l.designacao,
          flagGenerico: false, flagMnsrmNCompart: false,
        })),
      );
      return { modo, autoridade, ...r };
    }
    const desig = async (cnp: number) => (await prisma.produto.findUnique({ where: { cnp }, select: { designacao: true } }))?.designacao ?? null;

    // ═══ Resolução da farmácia ════════════════════════════════════════════
    console.log("\n=== R. Identificação da farmácia (Farmacia.id da variável de ambiente, nunca o nome nem 'a primeira') ===");
    {
      const ok1 = await D.resolverAutoridadeDesignacao(prisma, "silveira", ENV);
      check(ok1.aplica && ok1.valida && ok1.farmaciaId === silv.id, "silveira + Farmacia.id configurado → a Silveirense");
      const comEspacos = await D.resolverAutoridadeDesignacao(prisma, "silveira", { [D.ENV_FARMACIA_ID_DESIGNACAO]: `  ${silv.id} ` });
      check(comEspacos.aplica && comEspacos.valida && comEspacos.farmaciaId === silv.id, "espaços exteriores no valor são ignorados");
      const nome = await D.resolverAutoridadeDesignacao(prisma, "silveira", { [D.ENV_FARMACIA_ID_DESIGNACAO]: "Farmácia Silveirense" });
      check(nome.aplica && !nome.valida && nome.codigo === "NAO_ENCONTRADA", "o texto do nome NÃO identifica a farmácia (só o id exacto)");
      const maiusc = await D.resolverAutoridadeDesignacao(prisma, "silveira", { [D.ENV_FARMACIA_ID_DESIGNACAO]: silv.id.toUpperCase() });
      check(maiusc.aplica && !maiusc.valida && maiusc.codigo === "NAO_ENCONTRADA", "o id é comparado exactamente (sem maiúsculas/minúsculas trocadas)");
      const sem = await D.resolverAutoridadeDesignacao(prisma, "silveira", {});
      check(sem.aplica && !sem.valida && sem.codigo === "NAO_CONFIGURADO", "sem configuração → falha explícita NAO_CONFIGURADO (nunca escolhe uma)");
      const vazia = await D.resolverAutoridadeDesignacao(prisma, "silveira", { [D.ENV_FARMACIA_ID_DESIGNACAO]: "   " });
      check(vazia.aplica && !vazia.valida && vazia.codigo === "NAO_CONFIGURADO", "valor só com espaços → NAO_CONFIGURADO");
      const outro = await D.resolverAutoridadeDesignacao(prisma, "silveira", { [D.ENV_FARMACIA_ID_DESIGNACAO]: "cmsmx87dk000201obow8qp7et" });
      check(outro.aplica && !outro.valida && outro.codigo === "NAO_ENCONTRADA", "id sem farmácia neste tenant → NAO_ENCONTRADA");
      await prisma.farmacia.update({ where: { id: silv.id }, data: { estado: "INATIVO" } });
      const ina = await D.resolverAutoridadeDesignacao(prisma, "silveira", ENV);
      check(ina.aplica && !ina.valida && ina.codigo === "INATIVA", "farmácia inactiva → INATIVA");
      await prisma.farmacia.update({ where: { id: silv.id }, data: { estado: "ATIVO" } });
      for (const t of ["garantia", "sier", "outro"]) {
        const e = await D.resolverAutoridadeDesignacao(prisma, t, ENV);
        check(!e.aplica, `tenant ${t}: a regra não se aplica (nem lê a configuração)`);
      }
      const modoS = D.modoParaFarmacia(ok1, silv.id);
      const modoG = D.modoParaFarmacia(ok1, seg.id);
      check(modoS === "AUTORITATIVA" && modoG === "SO_CRIACAO", "modos: Silveirense AUTORITATIVA, Segurado SO_CRIACAO");
      check(D.modoParaFarmacia({ aplica: false }, seg.id) === "LEGACY", "fora do silveira: LEGACY");
    }

    // ═══ 1–2 · Produtos novos ═════════════════════════════════════════════
    console.log("\n=== 1/2. Produto novo (Silveirense; só Segurado) ===");
    {
      const c1 = novoCnp();
      const r1 = await sync("silveira", silv, [{ cnp: c1, designacao: "PARACETAMOL CICLUM 650 MG 20 COMP." }]);
      check((await desig(c1)) === "PARACETAMOL CICLUM 650 MG 20 COMP." && r1.estatisticas?.criadas === 1, "1. novo da Silveirense: criado com a sua designação (criadas=1)");
      const c2 = novoCnp();
      const r2 = await sync("silveira", seg, [{ cnp: c2, designacao: "Produto só da Segurado" }]);
      check((await desig(c2)) === "Produto só da Segurado" && r2.estatisticas?.criadas === 1 && r2.modo === "SO_CRIACAO", "2. novo só da Segurado: criado com a designação da Segurado");
    }

    // ═══ 3–5 · Silveirense sobre produto existente ════════════════════════
    console.log("\n=== 3/4/5. Silveirense sobre produto existente ===");
    {
      const c = novoCnp();
      await sync("silveira", seg, [{ cnp: c, designacao: "NOME ANTIGO DA SEGURADO" }]);
      const r3 = await sync("silveira", silv, [{ cnp: c, designacao: "Nome Correcto da Silveirense" }]);
      check((await desig(c)) === "Nome Correcto da Silveirense" && r3.estatisticas?.alteradas === 1 && r3.estatisticas?.verificadas === 1,
        "3. designação diferente na Silveirense → substitui (alteradas=1, verificadas=1)");
      const r4 = await sync("silveira", silv, [{ cnp: c, designacao: "Nome Correcto da Silveirense" }]);
      check((await desig(c)) === "Nome Correcto da Silveirense" && r4.estatisticas?.alteradas === 0 && r4.estatisticas?.jaIguais === 1 && r4.estatisticas?.verificadas === 1,
        "4. designação igual → nada alterado (jaIguais=1)");
      const r5 = await sync("silveira", silv, [{ cnp: c, designacao: `  ${NBSP}  ` }]);
      check((await desig(c)) === "Nome Correcto da Silveirense" && r5.estatisticas?.ignoradasVazias === 1 && r5.estatisticas?.alteradas === 0,
        "5. designação vazia/só espaços da Silveirense → nunca substitui (ignoradasVazias=1)");
      const r5b = await sync("silveira", silv, [{ cnp: c, designacao: "" }]);
      check((await desig(c)) === "Nome Correcto da Silveirense" && r5b.estatisticas?.ignoradasVazias === 1, "5b. string vazia idem");
    }

    // ═══ 6–8 · Segurado vs Silveirense ════════════════════════════════════
    console.log("\n=== 6/7/8. Segurado nunca substitui; ordem irrelevante ===");
    {
      const c = novoCnp();
      await sync("silveira", silv, [{ cnp: c, designacao: "DESIGNACAO SILVEIRENSE" }]);
      const r6 = await sync("silveira", seg, [{ cnp: c, designacao: "designacao da segurado" }]);
      check((await desig(c)) === "DESIGNACAO SILVEIRENSE" && r6.estatisticas?.ignoradasOrigemNaoAutoritativa === 1 && r6.estatisticas?.alteradas === 0,
        "6. Segurado tenta substituir designação existente → ignorada (ignoradasOrigem=1)");
      await sync("silveira", seg, [{ cnp: c, designacao: "outra vez a segurado" }]);
      check((await desig(c)) === "DESIGNACAO SILVEIRENSE", "7. Segurado sincroniza depois da Silveirense → não reverte (também no dia seguinte)");

      const c8 = novoCnp();
      await sync("silveira", seg, [{ cnp: c8, designacao: "SEGURADO PRIMEIRO" }]);
      check((await desig(c8)) === "SEGURADO PRIMEIRO", "8a. Segurado primeiro: cria com a sua designação");
      await sync("silveira", silv, [{ cnp: c8, designacao: "Silveirense corrige depois" }]);
      check((await desig(c8)) === "Silveirense corrige depois", "8b. Silveirense corrige depois");
    }

    // ═══ 9–10 · Ciclo de vida ═════════════════════════════════════════════
    console.log("\n=== 9/10. Criado pela Segurado → observado pela Silveirense; exclusivo da Segurado ===");
    {
      const c9 = novoCnp();
      await sync("silveira", seg, [{ cnp: c9, designacao: "CRIADO PELA SEGURADO" }]);
      await sync("silveira", seg, [{ cnp: c9, designacao: "CRIADO PELA SEGURADO" }]);
      await sync("silveira", silv, [{ cnp: c9, designacao: "Agora visto pela Silveirense" }]);
      check((await desig(c9)) === "Agora visto pela Silveirense", "9. produto criado pela Segurado e depois visto pela Silveirense → a global passa a ser a da Silveirense");
      const c10 = novoCnp();
      await sync("silveira", seg, [{ cnp: c10, designacao: "EXCLUSIVO DA SEGURADO" }]);
      for (let i = 0; i < 3; i++) await sync("silveira", seg, [{ cnp: c10, designacao: "EXCLUSIVO DA SEGURADO" }]);
      const p10 = await prisma.produto.findUnique({ where: { cnp: c10 } });
      check(p10?.designacao === "EXCLUSIVO DA SEGURADO" && p10.estado !== undefined, "10. produto exclusivo da Segurado permanece válido, com a designação da criação");
    }

    // ═══ 11 · Idempotência ════════════════════════════════════════════════
    console.log("\n=== 11. Idempotência ===");
    {
      const lote: Linha[] = [1, 2, 3].map((i) => ({ cnp: novoCnp(), designacao: `IDEMPOTENTE ${i}` }));
      const a = await sync("silveira", silv, lote);
      const b = await sync("silveira", silv, lote);
      const c = await sync("silveira", seg, lote);
      check(a.estatisticas?.criadas === 3 && b.estatisticas?.criadas === 0 && b.estatisticas?.alteradas === 0 && b.estatisticas?.jaIguais === 3,
        "11. duas sincronizações idênticas: a segunda não altera nada (jaIguais=3)");
      check(c.estatisticas?.alteradas === 0 && c.estatisticas?.ignoradasOrigemNaoAutoritativa === 0, "…e a Segurado a seguir também não");
      const dsg = await Promise.all(lote.map((l) => desig(l.cnp)));
      check(JSON.stringify(dsg) === JSON.stringify(lote.map((l) => l.designacao)), "…as designações ficaram exactamente como enviadas");
    }

    // ═══ 12 · Concorrência ════════════════════════════════════════════════
    console.log("\n=== 12. Concorrência entre as duas farmácias ===");
    {
      let erradas = 0;
      const RONDAS = 25;
      for (let r = 0; r < RONDAS; r++) {
        // misto: produtos novos para ambas e produtos já existentes
        const novos = [novoCnp(), novoCnp(), novoCnp()];
        const existente = novoCnp();
        await sync("silveira", seg, [{ cnp: existente, designacao: "EXISTENTE ORIGINAL" }]);
        const cnps = [existente, ...novos];
        await Promise.all([
          sync("silveira", seg, cnps.map((cnp) => ({ cnp, designacao: `SEGURADO ${cnp}` }))),
          sync("silveira", silv, cnps.map((cnp) => ({ cnp, designacao: `SILVEIRENSE ${cnp}` }))),
        ]);
        for (const cnp of cnps) if ((await desig(cnp)) !== `SILVEIRENSE ${cnp}`) erradas++;
      }
      check(erradas === 0, `12. ${RONDAS} rondas concorrentes (produtos novos e existentes): o resultado final é SEMPRE a designação da Silveirense`, `erradas=${erradas}`);
      // E a ordem inversa de arranque
      let erradas2 = 0;
      for (let r = 0; r < 10; r++) {
        const cnps = [novoCnp(), novoCnp()];
        await Promise.all([
          sync("silveira", silv, cnps.map((cnp) => ({ cnp, designacao: `SILV ${cnp}` }))),
          sync("silveira", seg, cnps.map((cnp) => ({ cnp, designacao: `SEG ${cnp}` }))),
          sync("silveira", seg, cnps.map((cnp) => ({ cnp, designacao: `SEG2 ${cnp}` }))),
        ]);
        for (const cnp of cnps) if ((await desig(cnp)) !== `SILV ${cnp}`) erradas2++;
      }
      check(erradas2 === 0, "12b. Silveirense lançada primeiro, com duas Segurado em paralelo: continua a ganhar", `erradas=${erradas2}`);
    }

    // ═══ 13–14 · Outros tenants ═══════════════════════════════════════════
    console.log("\n=== 13/14. garantia e sier ficam com o comportamento actual ===");
    for (const [n, tenant] of [[13, "garantia"], [14, "sier"]] as const) {
      const c = novoCnp();
      const a = await sync(tenant, silv, [{ cnp: c, designacao: `${tenant} PRIMEIRA` }]);
      const b = await sync(tenant, seg, [{ cnp: c, designacao: `${tenant} SEGUNDA (outra farmácia)` }]);
      check(a.modo === "LEGACY" && b.modo === "LEGACY" && a.estatisticas === null && b.estatisticas === null, `${n}. ${tenant}: modo LEGACY, sem estatísticas de designação`);
      check((await desig(c)) === `${tenant} SEGUNDA (outra farmácia)`, `${n}. ${tenant}: a última farmácia a sincronizar continua a substituir (como hoje)`);
      const vazia = await sync(tenant, seg, [{ cnp: c, designacao: "   " }]);
      check((await desig(c)) === `${tenant} SEGUNDA (outra farmácia)` && vazia.estatisticas === null, `${n}. ${tenant}: vazio continua a não apagar (protecção que já existia)`);
      const comEspacos = novoCnp();
      await sync(tenant, seg, [{ cnp: comEspacos, designacao: "A   B" }]);
      check((await desig(comEspacos)) === "A   B", `${n}. ${tenant}: SEM normalização de espaços internos (não se mexe no que já existia)`);
    }

    // ═══ Configuração inválida ════════════════════════════════════════════
    console.log("\n=== C. Configuração inválida: modo seguro ===");
    {
      const c = novoCnp();
      await sync("silveira", seg, [{ cnp: c, designacao: "ORIGINAL" }]);
      const r = await sync("silveira", silv, [{ cnp: c, designacao: "A Silveirense tenta" }], {});
      check((await desig(c)) === "ORIGINAL" && r.modo === "SO_CRIACAO" && r.autoridade.aplica && !r.autoridade.valida,
        "sem configuração: NINGUÉM altera designações existentes (nem a Silveirense) e o erro é explícito");
      const novo = novoCnp();
      const r2 = await sync("silveira", silv, [{ cnp: novo, designacao: "NOVO COM CONFIG INVALIDA" }], {});
      check((await desig(novo)) === "NOVO COM CONFIG INVALIDA" && r2.estatisticas?.criadas === 1, "…mas a criação de produtos novos continua a funcionar");
    }

    // ═══ Ficha manual e normalização ══════════════════════════════════════
    console.log("\n=== M. Ficha manual protegida; normalização de espaços ===");
    {
      const c = novoCnp();
      await prisma.produto.create({ data: { cnp: c, designacao: "Escrita à mão", camposManuais: ["designacao"], origemDados: "MANUAL" } });
      const r = await sync("silveira", silv, [{ cnp: c, designacao: "ERP tenta substituir" }]);
      check((await desig(c)) === "ERP tenta substituir" && r.estatisticas?.ignoradasManual === 0 && r.estatisticas?.alteradas === 1,
        "designação em camposManuais: a Silveirense SUBSTITUI-A (alteradas=1, ignoradasManual=0) — a designação é a única excepção");
      const seg2 = await sync("silveira", seg, [{ cnp: c, designacao: "A Segurado tenta" }]);
      check((await desig(c)) === "ERP tenta substituir" && seg2.estatisticas?.ignoradasOrigemNaoAutoritativa === 1, "…a Segurado nunca substitui, nem a designação manual nem a da Silveirense");
      const vazio = await sync("silveira", silv, [{ cnp: c, designacao: "   " }]);
      check((await desig(c)) === "ERP tenta substituir" && vazio.estatisticas?.ignoradasVazias === 1, "…e uma designação vazia nunca substitui");
      const cf = novoCnp();
      await prisma.produto.create({ data: { cnp: cf, designacao: "Antes", flagGenerico: true, camposManuais: ["designacao", "flagGenerico"] } });
      await sync("silveira", silv, [{ cnp: cf, designacao: "Depois" }]);
      const pf = await prisma.produto.findUnique({ where: { cnp: cf } });
      check(pf?.designacao === "Depois" && pf.flagGenerico === true && pf.camposManuais.includes("flagGenerico"), "os OUTROS campos em camposManuais (flagGenerico) continuam protegidos: a designação muda, o flag não");
      const cg = novoCnp();
      await prisma.produto.create({ data: { cnp: cg, designacao: "Manual garantia", camposManuais: ["designacao"] } });
      await sync("garantia", seg, [{ cnp: cg, designacao: "ERP garantia" }]);
      check((await desig(cg)) === "Manual garantia", "outros tenants (LEGACY): a designação manual continua protegida");
      const c2 = novoCnp();
      await sync("silveira", silv, [{ cnp: c2, designacao: `  Dolo${NBSP}Neurobion   500\t mg \n 20 comp.  ` }]);
      check((await desig(c2)) === "Dolo Neurobion 500 mg 20 comp.", "espaços exteriores e técnicos normalizados; capitalização e pontuação preservadas");
      check(D.normalizarDesignacao("ÁGUA Oxigenada, 10 vol.") === "ÁGUA Oxigenada, 10 vol.", "capitalização/acentos/pontuação intactos");
    }

    // ═══ Outros campos intocados ══════════════════════════════════════════
    console.log("\n=== O. Só a designação muda ===");
    {
      const fab = await prisma.fabricante.create({ data: { nomeNormalizado: "DESIG-FAB", estado: "ATIVO" } });
      const forn = await prisma.fornecedor.create({ data: { nomeNormalizado: "DESIG-FORN", estado: "ATIVO" } });
      const c = novoCnp();
      const p = await prisma.produto.create({ data: { cnp: c, designacao: "ANTES", fabricanteId: fab.id, dci: "DCI X", codigoATC: "N02BE01", estado: "VALIDADO" } });
      const pf = await prisma.produtoFarmacia.create({ data: { produtoId: p.id, farmaciaId: silv.id, pvp: 9.9, stockAtual: 7, fornecedorHabitualId: forn.id } });
      await sync("silveira", silv, [{ cnp: c, designacao: "DEPOIS" }]);
      const p2 = await prisma.produto.findUnique({ where: { cnp: c } });
      const pf2 = await prisma.produtoFarmacia.findUnique({ where: { id: pf.id } });
      check(p2?.designacao === "DEPOIS" && p2.fabricanteId === fab.id && p2.dci === "DCI X" && p2.codigoATC === "N02BE01" && p2.estado === "VALIDADO",
        "fabricante, DCI, ATC e estado do produto intactos");
      check(pf2?.fornecedorHabitualId === forn.id && Number(pf2?.pvp) === 9.9 && Number(pf2?.stockAtual) === 7, "fornecedor habitual, preço e stock intactos");
    }

    // ═══ Passo leve ═══════════════════════════════════════════════════════
    console.log("\n=== L. Passo leve (aplicarDesignacoesAutoritativas) ===");
    {
      const a = novoCnp(), b = novoCnp(), m = novoCnp(), ausente = novoCnp();
      await prisma.produto.create({ data: { cnp: a, designacao: "A ANTIGA" } });
      await prisma.produto.create({ data: { cnp: b, designacao: "B IGUAL" } });
      await prisma.produto.create({ data: { cnp: m, designacao: "M MANUAL", camposManuais: ["designacao"] } });
      const antesB = (await prisma.$queryRaw<{ x: string }[]>`SELECT xmin::text AS x FROM "Produto" WHERE cnp = ${b}`)[0].x;
      const r = await D.aplicarDesignacoesAutoritativas(prisma, [
        { cnp: a, designacao: " A  NOVA " },
        { cnp: b, designacao: "B IGUAL" },
        { cnp: m, designacao: "M do ERP" },
        { cnp: ausente, designacao: "NÃO EXISTE" },
        { cnp: novoCnp(), designacao: "   " },
      ]);
      check((await desig(a)) === "A NOVA" && r.alteradas === 2, "altera só o que difere (a e m), normalizando espaços");
      const depoisB = (await prisma.$queryRaw<{ x: string }[]>`SELECT xmin::text AS x FROM "Produto" WHERE cnp = ${b}`)[0].x;
      check(antesB === depoisB && r.jaIguais === 1, "o produto já igual NÃO é escrito (xmin inalterado)");
      check((await desig(m)) === "M do ERP" && r.ignoradasManual === 0, "passo leve: a designação em camposManuais também é substituída pela Silveirense");
      check((await prisma.produto.findUnique({ where: { cnp: ausente } })) === null && r.semProduto === 1, "nunca cria produtos (semProduto=1)");
      check(r.ignoradasVazias === 1 && r.verificadas === 3 && r.alteradas === 2, "vazias ignoradas; verificadas = alteradas (2) + iguais (1)");
      const r2 = await D.aplicarDesignacoesAutoritativas(prisma, [{ cnp: a, designacao: "A NOVA" }, { cnp: b, designacao: "B IGUAL" }]);
      check(r2.alteradas === 0 && r2.jaIguais === 2, "segunda passagem: idempotente");
    }

    // ═══ Utilitários operacionais ═════════════════════════════════════════
    console.log("\n=== A. Diagnóstico read-only (sem escrita de configuração) ===");
    {
      const A = await import("../../lib/ingest/designacao-silveira-admin");
      const d1 = await A.diagnosticarDesignacao(prisma, "silveira", {});
      check(d1.resolucao.aplica && !d1.resolucao.valida && d1.accoes.some((a) => a.includes(D.ENV_FARMACIA_ID_DESIGNACAO)) && d1.farmacias.some((f) => f.id === silv.id), "diagnóstico sem configuração: lista as farmácias (com id) e diz que variável definir");
      const d2 = await A.diagnosticarDesignacao(prisma, "silveira", ENV);
      check(d2.resolucao.aplica && d2.resolucao.valida && d2.accoes.length === 0 && d2.farmacias.length >= 2, "diagnóstico com configuração válida: sem acções");
      const d3 = await A.diagnosticarDesignacao(prisma, "garantia", ENV);
      check(!d3.resolucao.aplica, "diagnóstico noutro tenant: a regra não se aplica");
      const d4 = await A.diagnosticarDesignacao(prisma, "silveira", { [D.ENV_FARMACIA_ID_DESIGNACAO]: "idErrado123" });
      check(!d4.resolucao.aplica || (!d4.resolucao.valida && d4.resolucao.codigo === "NAO_ENCONTRADA" && d4.accoes.length === 1), "diagnóstico com id errado: NAO_ENCONTRADA e uma acção");

      // O CLI real, contra esta base local (read-only)
      const cli = (args: string[], env: Record<string, string> = {}) =>
        spawnSync("npx", ["tsx", ...args], { encoding: "utf8", shell: process.platform === "win32", env: { ...process.env, ...env } });
      const u = urlDe(db);
      const xminAntes = (await prisma.$queryRaw<{ x: string }[]>`SELECT xmin::text AS x FROM "Farmacia" WHERE id = ${silv.id}`)[0].x;
      const c1 = cli(["scripts/diagnostics/designacao-silveira-diagnostico.ts", `--database-url=${u}`, "--tenant=silveira"], { [D.ENV_FARMACIA_ID_DESIGNACAO]: silv.id });
      check(c1.status === 0 && /ESTADO=VALIDA/.test(c1.stdout) && /AUTORITATIVA/.test(c1.stdout), "CLI diagnóstico: exit 0, ESTADO=VALIDA e identifica a farmácia autoritativa", c1.stdout + c1.stderr);
      check(!/codigoANF/.test(c1.stdout), "o diagnóstico já não fala de codigoANF");
      const c2 = cli(["scripts/diagnostics/designacao-silveira-diagnostico.ts", `--database-url=${u}`, "--tenant=silveira"], { [D.ENV_FARMACIA_ID_DESIGNACAO]: "" });
      check(c2.status === 1 && /ESTADO=INVALIDA:NAO_CONFIGURADO/.test(c2.stdout), "CLI diagnóstico sem configuração: exit 1, ESTADO=INVALIDA:NAO_CONFIGURADO", c2.stdout + c2.stderr);
      const c3 = cli(["scripts/diagnostics/designacao-silveira-diagnostico.ts", `--database-url=${u}`, "--tenant=silveira"], { [D.ENV_FARMACIA_ID_DESIGNACAO]: "idErrado123" });
      check(c3.status === 1 && /ESTADO=INVALIDA:NAO_ENCONTRADA/.test(c3.stdout), "CLI diagnóstico com id inexistente: ESTADO=INVALIDA:NAO_ENCONTRADA");
      const xminDepois = (await prisma.$queryRaw<{ x: string }[]>`SELECT xmin::text AS x FROM "Farmacia" WHERE id = ${silv.id}`)[0].x;
      check(xminAntes === xminDepois, "o diagnóstico não escreveu em Farmacia (xmin inalterado)");
      check(!(await import("node:fs")).existsSync("scripts/admin/definir-codigo-farmacia-designacao.ts"), "o comando que escrevia Farmacia.codigoANF deixou de existir");
    }

    await prisma.$disconnect();
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.end();
  }

  console.log(`\n${failed === 0 ? "PASSOU" : "FALHOU"} — ${passed} OK, ${failed} falhas\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
