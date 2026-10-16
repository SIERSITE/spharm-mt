/**
 * scripts/tests/test-fabricante-ficha-db.ts
 *
 * Alterar/criar o FABRICANTE na ficha do artigo, contra um PostgreSQL REAL e DESCARTÁVEL:
 *
 *   docker run -d --name spharm-fab-pg -e POSTGRES_PASSWORD=test -p 15433:5432 postgres:16-alpine
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/tests/test-fabricante-ficha-db.ts
 *
 * Cobre: selecionar existente · criar novo · duplicado canónico e por alias bloqueados · semelhantes sugeridos · rollback
 * transacional (sem fabricante órfão) · concorrência otimista · auditoria · proteção manual contra a sincronização diária
 * (`applyErpCatalogFields`, regra por baseline E regra do tenant silveira) com o snapshot do ERP a continuar a atualizar-se ·
 * nova alteração manual · remoção explícita da proteção (com e sem aplicar o valor do ERP) · isolamento entre bases (tenants) ·
 * Produto.designacao e restantes campos intactos.
 */
import { execSync } from "node:child_process";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import Module from "node:module";

const M = Module as unknown as { _resolveFilename: (r: string, ...a: unknown[]) => string };
const resolverOriginal = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "server-only" ? __filename : resolverOriginal.call(this, request, ...rest);
};

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string, detalhe?: string) {
  if (cond) { passed++; console.log(`  [OK]    ${msg}`); }
  else { failed++; console.log(`  [FALHA] ${msg}${detalhe ? ` — ${detalhe}` : ""}`); }
}
const secao = (t: string) => console.log(`\n── ${t}`);

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgresql://postgres:test@localhost:15433/postgres";
const host = new URL(ADMIN_URL).hostname;
if (host !== "localhost" && host !== "127.0.0.1") {
  console.error(`RECUSADO: ${host} não é uma base local descartável.`);
  process.exit(2);
}
const urlDe = (db: string) => { const u = new URL(ADMIN_URL); u.pathname = `/${db}`; return u.toString(); };

async function main() {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const suf = Date.now().toString(36);
  const dbA = `spharm_fab_a_${suf}`;
  const dbB = `spharm_fab_b_${suf}`;
  await admin.query(`CREATE DATABASE ${dbA}`);
  await admin.query(`CREATE DATABASE ${dbB}`);
  try {
    for (const db of [dbA, dbB]) execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(db) }, encoding: "utf8" });
    process.env.DATABASE_URL = urlDe(dbA);
    process.env.ALLOW_LEGACY_DATABASE_FALLBACK = "1";

    const { PrismaClient } = await import("../../generated/prisma/client");
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(dbA) }) });
    const prismaB = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(dbB) }) });
    const { aplicarFabricanteFicha, permitirAtualizacaoErp, prepararCriacaoFabricante, pesquisarFabricantes, sugerirSemelhantes } = await import("../../lib/catalogo/fabricante-ficha");
    const { applyErpCatalogFields } = await import("../../lib/ingest/catalog-from-erp");

    const farm = await prisma.farmacia.create({ data: { nome: "Farmácia Teste A" } });
    const farm2 = await prisma.farmacia.create({ data: { nome: "Farmácia Teste B" } });
    const ator = await prisma.utilizador.create({ data: { email: "admin@fab.test", nome: "Admin", perfil: "ADMINISTRADOR" } });
    const fabBayer = await prisma.fabricante.create({ data: { nomeNormalizado: "BAYER PORTUGAL", aliases: { create: { aliasNome: "Bayer Pt Lda." } } } });
    const fabPfizer = await prisma.fabricante.create({ data: { nomeNormalizado: "PFIZER" } });
    const fabOutro = await prisma.fabricante.create({ data: { nomeNormalizado: "LABORATORIOS GRIFOLS" } });
    const mk = async (cnp: number, fabricanteId: string | null, extra: Record<string, unknown> = {}) =>
      prisma.produto.create({ data: { cnp, designacao: `ARTIGO ${cnp} 500 MG`, dci: "paracetamol", codigoATC: "N02BE01", fabricanteId, ...extra } });
    const pf = (produtoId: string, farmaciaId: string, erp: string | null, baseline: string | null) =>
      prisma.produtoFarmacia.create({ data: { produtoId, farmaciaId, pvp: 5, pmc: 3, fabricanteErpAtual: erp, fabricanteErpBaseline: baseline } });
    const aplicar = (cnp: number, anterior: string | null, destino: Parameters<typeof aplicarFabricanteFicha>[1]["destino"], opc: { confirmado?: boolean; ator?: string } = {}) =>
      aplicarFabricanteFicha(prisma, { cnp, fabricanteAnteriorId: anterior, destino, confirmado: opc.confirmado ?? true, ator: { id: opc.ator ?? ator.id }, tenant: "teste-a" });

    // ═══ 1. selecionar um fabricante existente ═══════════════════════════════════
    secao("1 · Selecionar fabricante existente");
    const p1 = await mk(9100001, fabBayer.id);
    const antes = await prisma.produto.findUniqueOrThrow({ where: { id: p1.id } });
    const r1 = await aplicar(9100001, fabBayer.id, { tipo: "existente", fabricanteId: fabPfizer.id });
    check(r1.ok && r1.fabricante.id === fabPfizer.id && !r1.criado && r1.alterado, "fabricante alterado para o existente");
    const depois = await prisma.produto.findUniqueOrThrow({ where: { id: p1.id } });
    check(depois.fabricanteId === fabPfizer.id && depois.validadoManualmente === true && depois.camposManuais.includes("fabricante"), "proteção manual ativa (validadoManualmente) e marca «fabricante» em camposManuais");
    check(depois.designacao === antes.designacao && depois.dci === antes.dci && depois.codigoATC === antes.codigoATC, "Produto.designacao e restantes campos intactos");
    const au = await prisma.auditLog.findMany({ where: { entityId: p1.id } });
    const meta = au[0] ? JSON.parse(au[0].metaJson ?? "{}") : {};
    check(au.length === 1 && au[0].actorId === ator.id && au[0].action === "produto.fabricante.alterado", "auditoria gravada (utilizador, ação, entidade)");
    check(meta.origem === "FICHA_ARTIGO" && meta.tenant === "teste-a" && meta.cnp === 9100001 && meta.fabricanteAnterior.id === fabBayer.id && meta.fabricanteNovo.id === fabPfizer.id && meta.fabricanteCriadoNoFluxo === false && meta.protecaoManual.depois === true && meta.protecaoManual.antes === false, "auditoria completa: origem, tenant, CNP, anterior, novo, criado, estado da proteção", JSON.stringify(meta));
    check(!(await aplicar(9100001, fabBayer.id, { tipo: "existente", fabricanteId: fabBayer.id })).ok, "concorrência otimista: alterar a partir de um fabricante já mudado é recusado (conflito)");
    const sem = await aplicar(9100001, fabPfizer.id, { tipo: "existente", fabricanteId: fabBayer.id }, { confirmado: false });
    check(!sem.ok && sem.codigo === "nao_confirmado" && (await prisma.produto.findUniqueOrThrow({ where: { id: p1.id } })).fabricanteId === fabPfizer.id, "sem confirmação nada é escrito (cancelar não altera)");
    check(!(await aplicar(9100001, fabPfizer.id, { tipo: "existente", fabricanteId: "inexistente" })).ok, "fabricante inexistente recusado");
    check(!(await aplicar(9109999, null, { tipo: "existente", fabricanteId: fabPfizer.id })).ok, "artigo inexistente recusado");

    // ═══ 2. criar novo + 3. duplicados ═══════════════════════════════════════════
    secao("2 · Criar novo fabricante (transacional) e prevenção de duplicados");
    const p2 = await mk(9100002, null);
    const prep = await prepararCriacaoFabricante(prisma, "  nova  farmacêutica, s.a. ");
    check(prep.ok && prep.canonico === "NOVA FARMACEUTICA S A" && !prep.duplicado && !prep.viaAlias, `nome normalizado pelas regras do catálogo: «${prep.ok ? prep.canonico : ""}»`);
    const nFab0 = await prisma.fabricante.count();
    const r2 = await aplicar(9100002, null, { tipo: "novo", nome: "  nova  farmacêutica, s.a. " });
    check(r2.ok && r2.criado && r2.fabricante.nome === "NOVA FARMACEUTICA S A", "fabricante criado e aplicado ao artigo no mesmo fluxo");
    check((await prisma.fabricante.count()) === nFab0 + 1, "exatamente 1 fabricante criado");
    const p2d = await prisma.produto.findUniqueOrThrow({ where: { id: p2.id }, include: { fabricante: true } });
    check(p2d.fabricante?.nomeNormalizado === "NOVA FARMACEUTICA S A" && p2d.validadoManualmente, "artigo associado ao novo fabricante, protegido");
    const m2 = JSON.parse((await prisma.auditLog.findFirstOrThrow({ where: { entityId: p2.id } })).metaJson ?? "{}");
    check(m2.fabricanteCriadoNoFluxo === true && m2.fabricanteAnterior.id === null, "auditoria regista que o fabricante foi criado no fluxo");

    const p3 = await mk(9100003, null);
    for (const [nome, desc] of [["nova   FARMACEUTICA s a", "mesmo canónico (maiúsculas/espaços)"], ["NOVA FARMACÊUTICA, S.A.", "mesmo canónico com pontuação"], ["Bayer Pt Lda.", "alias inequívoco de BAYER PORTUGAL"]] as const) {
      const n0 = await prisma.fabricante.count();
      const r = await aplicar(9100003, null, { tipo: "novo", nome });
      check(!r.ok && r.codigo === "duplicado" && !!r.existente && (await prisma.fabricante.count()) === n0, `duplicado bloqueado (${desc}) → sugere o existente «${!r.ok ? r.existente?.nome : ""}»`);
    }
    check((await prisma.produto.findUniqueOrThrow({ where: { id: p3.id } })).fabricanteId === null, "o artigo não foi alterado pelo duplicado recusado");
    check(!(await aplicar(9100003, null, { tipo: "novo", nome: "!" })).ok, "nome inválido recusado");

    // semelhantes (pura + com BD)
    const semelhantes = sugerirSemelhantes("Grifols", [{ id: fabOutro.id, nome: "LABORATORIOS GRIFOLS" }, { id: fabPfizer.id, nome: "PFIZER" }]);
    check(semelhantes.length === 1 && semelhantes[0].id === fabOutro.id, "semelhante sugerido (um nome contém o outro), sem falsos positivos");
    check(sugerirSemelhantes("Bayer Portugal Lda", [{ id: fabBayer.id, nome: "BAYER PORTUGAL" }]).length === 1, "mesmo nome sem forma jurídica é sugerido");
    check(sugerirSemelhantes("Pfizerr", [{ id: fabPfizer.id, nome: "PFIZER" }]).length === 1, "grafia muito parecida sugerida");
    check(sugerirSemelhantes("Pfizer", [{ id: fabPfizer.id, nome: "PFIZER" }]).length === 0, "idêntico não é «semelhante» (é duplicado)");
    const prepSim = await prepararCriacaoFabricante(prisma, "Grifols");
    check(prepSim.ok && prepSim.semelhantes.some((s) => s.id === fabOutro.id) && !prepSim.duplicado, "preparação com BD devolve os semelhantes e permite criar");
    const pesq = await pesquisarFabricantes(prisma, "bayer");
    check(pesq.some((o) => o.id === fabBayer.id), "autocomplete encontra por nome (e por alias)");
    check((await pesquisarFabricantes(prisma, "Pt Lda")).some((o) => o.id === fabBayer.id), "autocomplete encontra por alias");

    // ═══ 4. rollback transacional ═══════════════════════════════════════════════
    secao("3 · Rollback: se a associação/auditoria falha, não fica fabricante órfão");
    const p4 = await mk(9100004, fabBayer.id);
    const nFab1 = await prisma.fabricante.count();
    const nAud1 = await prisma.auditLog.count();
    let falhou = false;
    try {
      await aplicar(9100004, fabBayer.id, { tipo: "novo", nome: "Fabricante Que Vai Falhar" }, { ator: "utilizador-inexistente" }); // FK da auditoria quebra DEPOIS de criar o fabricante e atualizar o produto
    } catch {
      falhou = true;
    }
    check(falhou, "o pedido falha (violação da auditoria)");
    check((await prisma.fabricante.count()) === nFab1 && !(await prisma.fabricante.findUnique({ where: { nomeNormalizado: "FABRICANTE QUE VAI FALHAR" } })), "NENHUM fabricante órfão ficou criado (rollback)");
    const p4d = await prisma.produto.findUniqueOrThrow({ where: { id: p4.id } });
    check(p4d.fabricanteId === fabBayer.id && p4d.validadoManualmente === false && !p4d.camposManuais.includes("fabricante") && (await prisma.auditLog.count()) === nAud1, "o artigo e a auditoria ficaram intactos (mesma transação)");

    // ═══ 5. proteção contra a sincronização diária ══════════════════════════════
    secao("4 · Proteção manual: a sincronização diária (ERP) não substitui o fabricante");
    // baseline antigo ≠ valor novo do ERP ⇒ sem proteção, é «mudança real» e SOBRESCREVE (controlo)
    const pCtl = await mk(9100010, fabBayer.id);
    await pf(pCtl.id, farm.id, "BAYER PORTUGAL", "BAYER PORTUGAL");
    const pMan = await mk(9100011, fabBayer.id);
    await pf(pMan.id, farm.id, "BAYER PORTUGAL", "BAYER PORTUGAL");
    await pf(pMan.id, farm2.id, "BAYER PORTUGAL", "BAYER PORTUGAL");
    const rAp = await aplicar(9100011, fabBayer.id, { tipo: "existente", fabricanteId: fabPfizer.id });
    check(rAp.ok, "alteração manual aplicada (Bayer → Pfizer)");
    const linhasErp = [
      { cnp: 9100010, dci: null, codigoATC: null, grupoHomogeneo: null, fabricante: "Laboratorios Grifols" },
      { cnp: 9100011, dci: null, codigoATC: null, grupoHomogeneo: null, fabricante: "Laboratorios Grifols" },
    ];
    await applyErpCatalogFields(prisma, linhasErp, farm.id);
    const ctl = await prisma.produto.findUniqueOrThrow({ where: { id: pCtl.id }, include: { fabricante: true } });
    const man = await prisma.produto.findUniqueOrThrow({ where: { id: pMan.id }, include: { fabricante: true } });
    check(ctl.fabricante?.nomeNormalizado === "LABORATORIOS GRIFOLS", "CONTROLO: sem proteção, a sincronização substitui o fabricante (o teste é válido)");
    check(man.fabricanteId === fabPfizer.id && man.fabricante?.nomeNormalizado === "PFIZER", "COM proteção manual a sincronização NÃO substitui o fabricante");
    const pfMan = await prisma.produtoFarmacia.findUniqueOrThrow({ where: { produtoId_farmaciaId: { produtoId: pMan.id, farmaciaId: farm.id } } });
    check(pfMan.fabricanteErpAtual === "LABORATORIOS GRIFOLS" && pfMan.fabricanteErpLastSeenAt !== null, "o snapshot do ERP continua atualizado (divergência consultável)");
    check(pfMan.fabricanteErpBaseline === "BAYER PORTUGAL", "o baseline não avança enquanto a proteção existir (a mudança continua reportada)");
    // repetir a sincronização: continua protegido
    await applyErpCatalogFields(prisma, linhasErp, farm.id);
    check((await prisma.produto.findUniqueOrThrow({ where: { id: pMan.id } })).fabricanteId === fabPfizer.id, "sincronizações seguintes também respeitam a proteção");
    // regra do tenant silveira (nunca reescreve depois de definido)
    await applyErpCatalogFields(prisma, [{ cnp: 9100011, dci: null, codigoATC: null, grupoHomogeneo: null, fabricante: "Outra Marca Qualquer" }], farm.id, { modoNuncaReescreverFabricante: true });
    check((await prisma.produto.findUniqueOrThrow({ where: { id: pMan.id } })).fabricanteId === fabPfizer.id, "modo do tenant silveira: também respeita a alteração manual");
    // nova alteração manual mantém a proteção
    const rNova = await aplicar(9100011, fabPfizer.id, { tipo: "existente", fabricanteId: fabOutro.id });
    const pNova = await prisma.produto.findUniqueOrThrow({ where: { id: pMan.id } });
    check(rNova.ok && pNova.fabricanteId === fabOutro.id && pNova.validadoManualmente && pNova.camposManuais.filter((c) => c === "fabricante").length === 1, "nova alteração manual mantém a proteção (sem marcadores duplicados)");

    // ═══ 6. remover a proteção ═══════════════════════════════════════════════════
    secao("5 · «Voltar a permitir atualização automática pelo ERP»");
    const semConf = await permitirAtualizacaoErp(prisma, { cnp: 9100011, aplicarValorErp: false, confirmado: false, ator: { id: ator.id }, tenant: "teste-a" });
    check(!semConf.ok && (await prisma.produto.findUniqueOrThrow({ where: { id: pMan.id } })).validadoManualmente, "sem confirmação a proteção não é retirada (abrir/cancelar nunca a remove)");
    const rLib = await permitirAtualizacaoErp(prisma, { cnp: 9100011, aplicarValorErp: false, confirmado: true, ator: { id: ator.id }, tenant: "teste-a" });
    const pLib = await prisma.produto.findUniqueOrThrow({ where: { id: pMan.id } });
    check(rLib.ok && !rLib.alterado && pLib.fabricanteId === fabOutro.id && !pLib.validadoManualmente && !pLib.camposManuais.includes("fabricante"), "proteção retirada; o fabricante NÃO mudou");
    check(!(await permitirAtualizacaoErp(prisma, { cnp: 9100011, aplicarValorErp: false, confirmado: true, ator: { id: ator.id }, tenant: "teste-a" })).ok, "sem marca manual não há nada a retirar");
    const aud = await prisma.auditLog.findFirstOrThrow({ where: { entityId: pMan.id, action: "produto.fabricante.protecao_removida" } });
    check(JSON.parse(aud.metaJson ?? "{}").protecaoManual.depois === false && aud.actorId === ator.id, "retirada da proteção auditada");
    await prisma.produtoFarmacia.updateMany({ where: { produtoId: pMan.id }, data: { fabricanteErpBaseline: "BAYER PORTUGAL" } });
    await applyErpCatalogFields(prisma, linhasErp, farm.id);
    check((await prisma.produto.findUniqueOrThrow({ where: { id: pMan.id }, include: { fabricante: true } })).fabricante?.nomeNormalizado === "LABORATORIOS GRIFOLS", "sem proteção, a sincronização volta a poder atualizar");
    // aplicar já o valor do ERP
    const pErp = await mk(9100012, fabBayer.id);
    await pf(pErp.id, farm.id, "PFIZER", "PFIZER");
    await aplicar(9100012, fabBayer.id, { tipo: "existente", fabricanteId: fabOutro.id });
    const rErp = await permitirAtualizacaoErp(prisma, { cnp: 9100012, aplicarValorErp: true, confirmado: true, ator: { id: ator.id }, tenant: "teste-a" });
    check(rErp.ok && rErp.alterado && (await prisma.produto.findUniqueOrThrow({ where: { id: pErp.id } })).fabricanteId === fabPfizer.id, "com «aplicar valor do ERP» o fabricante passa ao do ERP (e a proteção sai)");

    // ═══ 7. isolamento por tenant ═══════════════════════════════════════════════
    secao("6 · Isolamento por tenant (bases físicas separadas)");
    const nB = await prismaB.fabricante.count();
    check(nB === 0, "a base B (outro tenant) não recebeu nenhum fabricante criado em A");
    const pB = await prismaB.produto.create({ data: { cnp: 9100001, designacao: "ARTIGO B" } });
    const atorB = await prismaB.utilizador.create({ data: { email: "b@fab.test", nome: "B", perfil: "ADMINISTRADOR" } });
    const rB = await aplicarFabricanteFicha(prismaB, { cnp: 9100001, fabricanteAnteriorId: null, destino: { tipo: "existente", fabricanteId: fabPfizer.id }, confirmado: true, ator: { id: atorB.id }, tenant: "teste-b" });
    check(!rB.ok && rB.codigo === "fabricante_inexistente", "um id de fabricante de OUTRA base nunca é reutilizado");
    check((await prismaB.produto.findUniqueOrThrow({ where: { id: pB.id } })).fabricanteId === null && (await prismaB.auditLog.count()) === 0, "nada foi alterado/auditado na base B");
    const rB2 = await aplicarFabricanteFicha(prismaB, { cnp: 9100001, fabricanteAnteriorId: null, destino: { tipo: "novo", nome: "Pfizer" }, confirmado: true, ator: { id: atorB.id }, tenant: "teste-b" });
    check(rB2.ok && rB2.criado, "o mesmo nome pode existir noutro tenant (criado só na base B)");
    check((await prisma.produto.findUniqueOrThrow({ where: { id: p1.id } })).fabricanteId === fabPfizer.id && (await prisma.fabricante.count({ where: { nomeNormalizado: "PFIZER" } })) === 1, "a base A mantém-se com o seu fabricante");

    await prisma.$disconnect();
    await prismaB.$disconnect();
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${dbA} WITH (FORCE)`).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${dbB} WITH (FORCE)`).catch(() => undefined);
    await admin.end();
  }
  console.log(`\n${failed === 0 ? "PASSOU" : "FALHOU"} — ${passed} OK, ${failed} falhas\n`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
