/**
 * scripts/tests/test-designacao-ficha-db.ts
 *
 * Corrigir a DESIGNAÇÃO do produto na ficha do artigo, contra um PostgreSQL REAL e DESCARTÁVEL:
 *
 *   docker run -d --name vendas-e2e-pg -e POSTGRES_PASSWORD=test -p 15433:5432 postgres:16-alpine
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/tests/test-designacao-ficha-db.ts
 *
 * Cobre: editar · cancelar/sem confirmação · vazio/espaços/curto/acima do limite · igual (nada escrito nem auditado) · acentos e
 * maiúsculas preservados · permissões (`catalog.write`) · isolamento entre bases (tenants) · auditoria completa · proteção manual
 * contra a sincronização (LEGACY, Silveirense AUTORITATIVA, passo leve) · Silveirense · «Voltar a permitir» só da designação ·
 * independência face ao fabricante (proteções, auditorias) · CNP/fabricante/DCI/dosagem/embalagem/forma e snapshots intactos ·
 * documentos históricos com `designacaoSnapshot` inalterados, rascunhos/futuros com o nome ao vivo.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
  const dbA = `spharm_desig_a_${suf}`;
  const dbB = `spharm_desig_b_${suf}`;
  await admin.query(`CREATE DATABASE ${dbA}`);
  await admin.query(`CREATE DATABASE ${dbB}`);
  try {
    for (const db of [dbA, dbB]) execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(db) }, encoding: "utf8" });
    process.env.DATABASE_URL = urlDe(dbA);
    process.env.ALLOW_LEGACY_DATABASE_FALLBACK = "1";

    const { PrismaClient } = await import("../../generated/prisma/client");
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(dbA) }) });
    const prismaB = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(dbB) }) });
    const { aplicarDesignacaoFicha, permitirAtualizacaoDesignacao, validarDesignacao, DESIGNACAO_MAX, DESIGNACAO_MIN } = await import("../../lib/catalogo/designacao-ficha");
    const { aplicarFabricanteFicha, permitirAtualizacaoErp } = await import("../../lib/catalogo/fabricante-ficha");
    const { applyErpCatalogFields } = await import("../../lib/ingest/catalog-from-erp");
    const { bulkUpsertProdutosByCnp } = await import("../../lib/ingest/bulk");
    const { upsertProdutosComDesignacao, aplicarDesignacoesAutoritativas } = await import("../../lib/ingest/designacao-silveira");
    const { can } = await import("../../lib/permissions-core");

    const farm = await prisma.farmacia.create({ data: { nome: "Farmácia Teste A" } });
    const farm2 = await prisma.farmacia.create({ data: { nome: "Farmácia Teste B" } });
    const ator = await prisma.utilizador.create({ data: { email: "admin@desig.test", nome: "Admin", perfil: "ADMINISTRADOR" } });
    const fabA = await prisma.fabricante.create({ data: { nomeNormalizado: "FAB A" } });
    const fabB = await prisma.fabricante.create({ data: { nomeNormalizado: "FAB B" } });
    const mk = (cnp: number, extra: Record<string, unknown> = {}) =>
      prisma.produto.create({ data: { cnp, designacao: `Paracetamol Generis 500 mg 20 comp (gralha) ${cnp}`, dci: "paracetamol", codigoATC: "N02BE01", dosagem: "500 mg", embalagem: "20", formaFarmaceutica: "comprimido", fabricanteId: fabA.id, ...extra } });
    const aplicar = (cnp: number, anterior: string, nova: string, opc: { confirmado?: boolean } = {}) =>
      aplicarDesignacaoFicha(prisma, { cnp, designacaoAnterior: anterior, nova, confirmado: opc.confirmado ?? true, ator: { id: ator.id }, tenant: "teste-a" });
    const ler = (cnp: number) => prisma.produto.findUniqueOrThrow({ where: { cnp } });
    const nAud = (id: string, action?: string) => prisma.auditLog.count({ where: { entityId: id, ...(action ? { action } : {}) } });
    const linha = (cnp: number, designacao: string) => ({ cnp, externalProductId: null, designacao, flagGenerico: false, flagMnsrmNCompart: false });

    // ═══ 1. editar ══════════════════════════════════════════════════════════════
    secao("1 · Editar a designação");
    const p1 = await mk(9200001);
    const antes = await ler(9200001);
    const pf1 = await prisma.produtoFarmacia.create({ data: { produtoId: p1.id, farmaciaId: farm.id, pvp: 5, stockAtual: 3, designacaoLocal: "PARACETAMOL GENERIS 500MG 20C" } });
    const pf2 = await prisma.produtoFarmacia.create({ data: { produtoId: p1.id, farmaciaId: farm2.id, pvp: 6, stockAtual: 4, designacaoLocal: "PARACETAMOL GENERIS 500MG 20C" } });
    const r1 = await aplicar(9200001, antes.designacao, "  Paracetamol   Generis 500 mg 20 comp  ");
    check(r1.ok && r1.alterado && r1.protegido && r1.designacao === "Paracetamol Generis 500 mg 20 comp" && r1.anterior === antes.designacao, "designação corrigida (espaços normalizados) e proteção ativada");
    const d1 = await ler(9200001);
    check(d1.designacao === "Paracetamol Generis 500 mg 20 comp" && d1.camposManuais.includes("designacao"), "Produto.designacao atualizada e «designacao» em camposManuais");
    check(d1.cnp === antes.cnp && d1.fabricanteId === antes.fabricanteId && d1.dci === antes.dci && d1.codigoATC === antes.codigoATC && d1.dosagem === antes.dosagem && d1.embalagem === antes.embalagem && d1.formaFarmaceutica === antes.formaFarmaceutica, "CNP, fabricante, DCI, ATC, dosagem, embalagem e forma intactos");
    check(d1.validadoManualmente === antes.validadoManualmente && !d1.camposManuais.includes("fabricante"), "a proteção do FABRICANTE (validadoManualmente / marcador) não é tocada");
    const pfs = await prisma.produtoFarmacia.findMany({ where: { produtoId: p1.id }, orderBy: { pvp: "asc" } });
    check(pfs.length === 2 && pfs.every((x) => x.designacaoLocal === "PARACETAMOL GENERIS 500MG 20C") && Number(pfs[0].pvp) === 5 && Number(pfs[0].stockAtual) === 3, "snapshots das farmácias (designacaoLocal, preços, stock) inalterados");
    check((await prisma.produto.count({ where: { cnp: 9200001 } })) === 1, "não cria nem funde produtos");
    void pf1; void pf2;

    // auditoria
    const au = await prisma.auditLog.findMany({ where: { entityId: p1.id } });
    const meta = au[0] ? JSON.parse(au[0].metaJson ?? "{}") : {};
    check(au.length === 1 && au[0].actorId === ator.id && au[0].action === "produto.designacao.alterada" && au[0].entity === "Produto", "auditoria: ação produto.designacao.alterada, utilizador e entidade");
    check(meta.origem === "FICHA_ARTIGO" && meta.tenant === "teste-a" && meta.produtoId === p1.id && meta.cnp === 9200001 && meta.designacaoAnterior === antes.designacao && meta.designacaoNova === "Paracetamol Generis 500 mg 20 comp" && meta.protecaoDesignacao.antes === false && meta.protecaoDesignacao.depois === true && !!au[0].createdAt, "auditoria completa: tenant, produto, CNP, anterior, nova, proteção antes/depois, origem, data/hora", JSON.stringify(meta));

    // ═══ 2. cancelar / validação ════════════════════════════════════════════════
    secao("2 · Cancelar e validação");
    const atual = (await ler(9200001)).designacao;
    const naoConf = await aplicar(9200001, atual, "Outro nome qualquer", { confirmado: false });
    check(!naoConf.ok && naoConf.codigo === "nao_confirmado" && (await ler(9200001)).designacao === atual && (await nAud(p1.id)) === 1, "sem confirmação nada é escrito nem auditado (cancelar não altera)");
    for (const [txt, desc] of [["", "vazia"], ["   \t \n ", "só espaços"], ["  ", "só espaços NBSP"], ["ab", `abaixo de ${DESIGNACAO_MIN} caracteres`], ["x".repeat(DESIGNACAO_MAX + 1), `acima de ${DESIGNACAO_MAX} caracteres`]] as const) {
      const r = await aplicar(9200001, atual, txt);
      check(!r.ok && r.codigo === "invalida" && (await ler(9200001)).designacao === atual, `designação ${desc}: recusada, nada escrito`);
    }
    check((await nAud(p1.id)) === 1, "recusas não geram auditoria");
    check(validarDesignacao(null as unknown as string).ok === false && validarDesignacao(42 as unknown as string).ok === false, "tipos inválidos recusados");
    const limite = await aplicar(9200001, atual, "y".repeat(DESIGNACAO_MAX));
    check(limite.ok && (await ler(9200001)).designacao.length === DESIGNACAO_MAX, `exatamente ${DESIGNACAO_MAX} caracteres é aceite`);
    const anteriorLimite = (await ler(9200001)).designacao;
    check(!(await aplicar(9200001, atual, "Nome com designação anterior errada")).ok, "concorrência otimista: partir de uma designação já mudada é recusado (conflito)");
    check((await ler(9200001)).designacao === anteriorLimite, "…e não escreve nada");
    check(!(await aplicar(9209999, "x", "Artigo que não existe")).ok, "artigo inexistente recusado");

    // ═══ 3. igual ═══════════════════════════════════════════════════════════════
    secao("3 · Igual à atual (depois de normalizar espaços): não escreve nem audita");
    const p3 = await mk(9200003, { designacao: "Brufen 400 mg 60 comp" });
    const x0 = (await prisma.$queryRaw<{ x: string }[]>`SELECT xmin::text AS x FROM "Produto" WHERE cnp = 9200003`)[0].x;
    const r3 = await aplicar(9200003, "Brufen 400 mg 60 comp", "  Brufen   400 mg 60 comp ");
    const x1 = (await prisma.$queryRaw<{ x: string }[]>`SELECT xmin::text AS x FROM "Produto" WHERE cnp = 9200003`)[0].x;
    check(r3.ok && !r3.alterado && x0 === x1 && (await nAud(p3.id)) === 0 && !(await ler(9200003)).camposManuais.includes("designacao"), "ok sem alteração: linha não escrita (xmin igual), sem auditoria, sem proteção nova");

    // ═══ 4. acentos e maiúsculas ════════════════════════════════════════════════
    secao("4 · Acentos, maiúsculas/minúsculas e pontuação preservados");
    const p4 = await mk(9200004);
    const nome4 = "Água Oxigenada 10 vol. — Frasco 250 ml (ÚLTIMA unidade) Ç ã é Ü";
    const r4 = await aplicar(9200004, (await ler(9200004)).designacao, nome4);
    check(r4.ok && (await ler(9200004)).designacao === nome4, "o texto fica exatamente como escrito (só espaços normalizados)");
    void p4;

    // ═══ 5. permissões ══════════════════════════════════════════════════════════
    secao("5 · Permissões (catalog.write)");
    const sess = (perfil: string) => ({ sub: "u", email: "u@x", nome: "U", perfil, farmaciaId: null, farmaciasIds: [] }) as never;
    check(can(sess("ADMINISTRADOR"), "catalog.write") && can(sess("GESTOR_GRUPO"), "catalog.write"), "ADMINISTRADOR e GESTOR_GRUPO podem");
    check(!can(sess("GESTOR_FARMACIA"), "catalog.write") && !can(sess("OPERADOR"), "catalog.write") && !can(null, "catalog.write"), "GESTOR_FARMACIA, OPERADOR e sem sessão NÃO podem");
    const acoes = readFileSync("app/stock/artigo/designacao-actions.ts", "utf8");
    check((acoes.match(/await guarda\(\)/g) ?? []).length === 3 && /can\(session, "catalog\.write"\)/.test(acoes), "as 3 ações do servidor passam todas pela guarda (sessão + catalog.write)");
    check(/podeEditarDesignacao: can\(sessao, "catalog\.write"\)/.test(readFileSync("lib/stock/artigo-ficha-data.ts", "utf8")) && /can\(await getSession\(\), "catalog\.write"\)/.test(readFileSync("app/catalogo/artigo/[cnp]/page.tsx", "utf8")), "as duas fichas (Stock e Catálogo) só mostram «Editar designação» a quem tem catalog.write");

    // ═══ 6. tenant ═══════════════════════════════════════════════════════════════
    secao("6 · Isolamento entre bases (tenants)");
    await prismaB.produto.create({ data: { cnp: 9200001, designacao: "Nome do outro tenant" } });
    check((await prismaB.produto.findUniqueOrThrow({ where: { cnp: 9200001 } })).designacao === "Nome do outro tenant" && (await prismaB.auditLog.count()) === 0, "a alteração no tenant A não toca no produto com o mesmo CNP do tenant B (nem na sua auditoria)");
    const rB = await aplicarDesignacaoFicha(prismaB, { cnp: 9200001, designacaoAnterior: "Nome do outro tenant", nova: "Nome B corrigido", confirmado: true, ator: { id: (await prismaB.utilizador.create({ data: { email: "b@x.test", nome: "B", perfil: "ADMINISTRADOR" } })).id }, tenant: "teste-b" });
    check(rB.ok && (await ler(9200001)).designacao.length === DESIGNACAO_MAX, "…e a alteração em B não toca em A");

    // ═══ 7. proteção contra a sincronização ═════════════════════════════════════
    secao("7 · A correção manual prevalece sobre a sincronização diária");
    const p7 = await mk(9200007, { designacao: "NOME ERP COM GRALHA 9200007" });
    await aplicar(9200007, "NOME ERP COM GRALHA 9200007", "Nome Correto do Artigo 9200007");
    // LEGACY (outros tenants): upsert em lote
    await bulkUpsertProdutosByCnp(prisma, [linha(9200007, "NOME ERP VOLTA A MANDAR")]);
    check((await ler(9200007)).designacao === "Nome Correto do Artigo 9200007", "sincronização LEGACY (lote): não substitui a designação corrigida");
    // Silveirense (AUTORITATIVA) — antes substituía; agora não
    const rs = await upsertProdutosComDesignacao(prisma, "AUTORITATIVA", [linha(9200007, "NOME ERP DA SILVEIRENSE")]);
    check((await ler(9200007)).designacao === "Nome Correto do Artigo 9200007" && rs.estatisticas?.ignoradasManual === 1 && rs.estatisticas?.alteradas === 0, "Silveirense (AUTORITATIVA): NÃO substitui a designação corrigida (ignoradasManual=1)");
    // outras farmácias do tenant silveira (SO_CRIACAO)
    await upsertProdutosComDesignacao(prisma, "SO_CRIACAO", [linha(9200007, "NOME DA SEGURADO")]);
    check((await ler(9200007)).designacao === "Nome Correto do Artigo 9200007", "outra farmácia do tenant (SO_CRIACAO): nunca altera");
    // passo leve da Silveirense
    const leve = await aplicarDesignacoesAutoritativas(prisma, [{ cnp: 9200007, designacao: "NOME DO PASSO LEVE" }]);
    check((await ler(9200007)).designacao === "Nome Correto do Artigo 9200007" && leve.alteradas === 0 && leve.ignoradasManual === 1, "passo leve da Silveirense: não substitui (ignoradasManual=1)");
    // vazio nunca apaga
    await upsertProdutosComDesignacao(prisma, "AUTORITATIVA", [linha(9200007, "   ")]);
    check((await ler(9200007)).designacao === "Nome Correto do Artigo 9200007", "designação vazia do ERP nunca apaga");
    // controlo: sem correção manual a Silveirense continua a atualizar (a regra da Silveirense não foi desligada)
    const pc = await mk(9200008, { designacao: "ERP ANTIGO" });
    await upsertProdutosComDesignacao(prisma, "AUTORITATIVA", [linha(9200008, "ERP NOVO DA SILVEIRENSE")]);
    check((await ler(9200008)).designacao === "ERP NOVO DA SILVEIRENSE", "CONTROLO: sem correção manual, a Silveirense atualiza a designação como sempre");
    await bulkUpsertProdutosByCnp(prisma, [linha(9200008, "ERP LEGACY NOVO")]);
    check((await ler(9200008)).designacao === "ERP LEGACY NOVO", "CONTROLO: sem correção manual, o lote LEGACY atualiza a designação como sempre");
    void p7; void pc;
    // o snapshot informativo do ERP por farmácia continua a poder atualizar-se
    await prisma.produtoFarmacia.update({ where: { id: pf1.id }, data: { designacaoLocal: "NOVO SNAPSHOT ERP" } });
    check((await prisma.produtoFarmacia.findUniqueOrThrow({ where: { id: pf1.id } })).designacaoLocal === "NOVO SNAPSHOT ERP" && (await ler(9200001)).designacao.length === DESIGNACAO_MAX, "o snapshot ERP por farmácia (designacaoLocal) continua a poder atualizar-se sem tocar na designação do produto");

    // ═══ 8. «Voltar a permitir» só da designação ════════════════════════════════
    secao("8 · «Voltar a permitir atualização automática» retira SÓ a proteção da designação");
    const p8 = await mk(9200009, { designacao: "ERP ORIGINAL 9200009", flagGenerico: true, camposManuais: ["flagGenerico"] });
    await aplicar(9200009, "ERP ORIGINAL 9200009", "Designação Manual 9200009");
    await aplicarFabricanteFicha(prisma, { cnp: 9200009, fabricanteAnteriorId: fabA.id, destino: { tipo: "existente", fabricanteId: fabB.id }, confirmado: true, ator: { id: ator.id }, tenant: "teste-a" });
    const m0 = await ler(9200009);
    check(m0.camposManuais.includes("designacao") && m0.camposManuais.includes("fabricante") && m0.camposManuais.includes("flagGenerico") && m0.validadoManualmente, "estado inicial: proteções de designação, fabricante e flagGenerico ativas");
    check(!(await permitirAtualizacaoDesignacao(prisma, { cnp: 9200009, confirmado: false, ator: { id: ator.id }, tenant: "teste-a" })).ok && (await ler(9200009)).camposManuais.includes("designacao"), "sem confirmação nada muda");
    const rp = await permitirAtualizacaoDesignacao(prisma, { cnp: 9200009, confirmado: true, ator: { id: ator.id }, tenant: "teste-a" });
    const m1 = await ler(9200009);
    check(rp.ok && m1.designacao === "Designação Manual 9200009", "o nome NÃO muda ao retirar a proteção");
    check(!m1.camposManuais.includes("designacao") && m1.camposManuais.includes("fabricante") && m1.camposManuais.includes("flagGenerico") && m1.validadoManualmente === true && m1.fabricanteId === fabB.id, "só «designacao» sai de camposManuais: fabricante, flagGenerico e validadoManualmente ficam");
    const aud8 = await prisma.auditLog.findMany({ where: { entityId: p8.id, action: "produto.designacao.protecao_removida" } });
    const meta8 = aud8[0] ? JSON.parse(aud8[0].metaJson ?? "{}") : {};
    check(aud8.length === 1 && meta8.origem === "FICHA_ARTIGO" && meta8.alterado === false && meta8.protecaoDesignacao.antes === true && meta8.protecaoDesignacao.depois === false && (await nAud(p8.id, "produto.designacao.alterada")) === 1 && (await nAud(p8.id, "produto.fabricante.alterado")) === 1, "auditoria da remoção separada, com metadados inequívocos; as outras auditorias intactas", JSON.stringify(meta8));
    check(!(await permitirAtualizacaoDesignacao(prisma, { cnp: 9200009, confirmado: true, ator: { id: ator.id }, tenant: "teste-a" })).ok, "sem proteção a retirar: recusado");
    await bulkUpsertProdutosByCnp(prisma, [linha(9200009, "ERP VOLTA A SUBSTITUIR 9200009")]);
    check((await ler(9200009)).designacao === "ERP VOLTA A SUBSTITUIR 9200009", "depois de retirada a proteção, a sincronização volta a poder substituir a designação");

    // ═══ 9. independência designação ↔ fabricante ═══════════════════════════════
    secao("9 · Independência entre designação e fabricante");
    const p9 = await mk(9200010, { designacao: "ERP 9200010" });
    await aplicar(9200010, "ERP 9200010", "Designação manual 9200010");
    const antesFab = (await ler(9200010)).fabricanteId;
    check(antesFab === fabA.id, "editar a designação não altera o fabricante");
    await aplicarFabricanteFicha(prisma, { cnp: 9200010, fabricanteAnteriorId: fabA.id, destino: { tipo: "existente", fabricanteId: fabB.id }, confirmado: true, ator: { id: ator.id }, tenant: "teste-a" });
    const m9 = await ler(9200010);
    check(m9.designacao === "Designação manual 9200010" && m9.camposManuais.includes("designacao") && m9.camposManuais.includes("fabricante") && m9.fabricanteId === fabB.id, "editar o fabricante não altera a designação nem a sua proteção");
    await permitirAtualizacaoErp(prisma, { cnp: 9200010, aplicarValorErp: false, confirmado: true, ator: { id: ator.id }, tenant: "teste-a" });
    const m9b = await ler(9200010);
    check(!m9b.camposManuais.includes("fabricante") && !m9b.validadoManualmente && m9b.camposManuais.includes("designacao") && m9b.designacao === "Designação manual 9200010", "retirar a proteção do fabricante não retira a da designação");
    await prisma.produtoFarmacia.create({ data: { produtoId: p9.id, farmaciaId: farm.id, fabricanteErpAtual: "FAB ERP", fabricanteErpBaseline: "FAB ERP" } });
    await applyErpCatalogFields(prisma, [{ cnp: 9200010, dci: "DCI DO ERP", codigoATC: null, grupoHomogeneo: null, fabricante: "OUTRO FAB ERP" }], farm.id);
    check((await ler(9200010)).designacao === "Designação manual 9200010", "a sincronização do catálogo (campos ERP) nunca toca na designação protegida");
    check((await nAud(p9.id, "produto.designacao.alterada")) === 1 && (await nAud(p9.id, "produto.fabricante.alterado")) === 1 && (await nAud(p9.id, "produto.fabricante.protecao_removida")) === 1, "auditorias independentes (uma por ação)");

    // ═══ 10. documentos históricos vs. futuros ══════════════════════════════════
    secao("10 · Documentos históricos mantêm o nome; documentos futuros usam o novo");
    const p10 = await mk(9200011, { designacao: "Nome histórico 9200011" });
    const lista = await prisma.listaEncomenda.create({ data: { nome: "Hist", farmaciaId: farm.id, estado: "FINALIZADA", criadoPorId: ator.id } });
    await prisma.linhaEncomenda.create({ data: { listaEncomendaId: lista.id, produtoId: p10.id, quantidadeSugerida: 1, quantidadeAjustada: 1, designacaoSnapshot: "Nome histórico 9200011" } });
    await aplicar(9200011, "Nome histórico 9200011", "Nome novo corrigido 9200011");
    const snap = await prisma.linhaEncomenda.findFirst({ where: { listaEncomendaId: lista.id } });
    check(snap?.designacaoSnapshot === "Nome histórico 9200011", "a linha de uma encomenda finalizada guarda o nome de então (snapshot inalterado)");
    check((await ler(9200011)).designacao === "Nome novo corrigido 9200011", "o produto (usado em rascunhos, encomendas futuras, mapas, relatórios, PDF, Excel, emails) tem o nome novo");
    const od = readFileSync("lib/encomendas/order-detail.ts", "utf8");
    const td = readFileSync("lib/transferencias/transferencia-detail.ts", "utf8");
    check(/designacaoSnapshot \?\? l\.produto\.designacao/.test(od) && /designacaoSnapshot \?\? l\.produto\.designacao/.test(td), "encomendas e transferências: `designacaoSnapshot ?? produto.designacao` (histórico fixo; sem snapshot, nome ao vivo)");
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${dbA} WITH (FORCE)`);
    await admin.query(`DROP DATABASE IF EXISTS ${dbB} WITH (FORCE)`);
    await admin.end();
  }
  console.log(`\n${failed === 0 ? "PASSOU" : "FALHOU"} — ${passed} OK, ${failed} falhas\n`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
