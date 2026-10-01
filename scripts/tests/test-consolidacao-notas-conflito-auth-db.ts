/**
 * scripts/tests/test-consolidacao-notas-conflito-auth-db.ts
 *
 * PostgreSQL REAL e DESCARTÁVEL (recusa correr fora de localhost):
 *
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:55494/postgres npx tsx scripts/tests/test-consolidacao-notas-conflito-auth-db.ts
 *
 * Complemento de `test-consolidacao-fornecedor-linha-db.ts` para os três
 * bloqueadores da auditoria de 2026-10-01 (nível do SERVIÇO, dependências
 * injectadas — mesma convenção):
 *
 *   N  notas DIFERENTES para o MESMO produto em duas farmácias: persistem
 *      pelo autosave REAL (`salvarAutosaveEncomenda`), recuperam-se por
 *      batchKey, e chegam aos documentos finais isoladas por
 *      farmácia × fornecedor.
 *   V  bloqueio optimista: duas sessões a editar a mesma farmácia — a
 *      segunda gravação (versão antiga) é um conflito explícito, nunca
 *      sobrescreve; a finalização com uma versão antiga identifica a
 *      farmácia e escreve ZERO; com as versões actuais, finaliza.
 *   A  autorização centralizada em `finalizarConsolidacaoServico`:
 *        a) outro utilizador do mesmo tenant com a chave;
 *        b) utilizador sem acesso a uma das farmácias;
 *        c) chave/sessão de outro tenant;
 *        d) todos: ZERO escritas e nenhum id/detalhe na resposta.
 */
import Module from "node:module";
import { execSync } from "node:child_process";
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

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgresql://postgres:test@localhost:55493/postgres";
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

const chaveNova = () =>
  Array.from({ length: 24 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("");

async function main() {
  const sufixo = Date.now().toString(36);
  const dbT1 = `spharm_cnca_${sufixo}`;
  const dbT2 = `spharm_cnca2_${sufixo}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbT1}`);

  try {
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(dbT1) }, encoding: "utf8" });
    const { PrismaClient } = await import("../../generated/prisma/client");
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(dbT1) }) });

    const { salvarAutosaveEncomenda, ConflitoVersaoError } = await import("../../lib/encomendas/autosave");
    const { ensureRascunhoConsolidacaoFarmaciaServico, obterRascunhosConsolidacaoServico, finalizarConsolidacaoServico } =
      await import("../../lib/encomendas/consolidacao-servico");

    const fA = await prisma.farmacia.create({ data: { nome: "Farmácia A" } });
    const fB = await prisma.farmacia.create({ data: { nome: "Farmácia B" } });
    const fornX = await prisma.fornecedor.create({ data: { nomeNormalizado: "FORNECEDOR X", nome: "Fornecedor X" } });
    const fornY = await prisma.fornecedor.create({ data: { nomeNormalizado: "FORNECEDOR Y", nome: "Fornecedor Y" } });
    const fornZ = await prisma.fornecedor.create({ data: { nomeNormalizado: "FORNECEDOR Z", nome: "Fornecedor Z" } });
    const p0 = await prisma.produto.create({ data: { cnp: 9100000, designacao: "Produto Zero Partilhado" } });
    const pA1 = await prisma.produto.create({ data: { cnp: 9100001, designacao: "Produto A-Unico" } });
    const pB2 = await prisma.produto.create({ data: { cnp: 9100002, designacao: "Produto B-Unico" } });

    const uAdmin = await prisma.utilizador.create({ data: { email: "admin@t.pt", nome: "Admin", perfil: "ADMINISTRADOR" } });
    const uAdmin2 = await prisma.utilizador.create({ data: { email: "admin2@t.pt", nome: "Admin 2", perfil: "ADMINISTRADOR" } });
    const uOperA = await prisma.utilizador.create({ data: { email: "opera@t.pt", nome: "Oper A", perfil: "OPERADOR", farmaciaId: fA.id } });

    type U = { id: string; perfil: string; farmaciaId: string | null };
    const deps = (u: U, p = prisma, tenant = "t", tenantSessao?: string) => ({
      prisma: p,
      tenantSlug: tenant,
      sessao: { sub: u.id, perfil: u.perfil, farmaciaId: u.farmaciaId, ...(tenantSessao !== undefined ? { tenant: tenantSessao } : {}) },
      auditar: undefined as undefined | ((e: { action: string; entityId: string; meta: Record<string, unknown> }) => Promise<void>),
    });

    async function contagens(p = prisma) {
      return {
        listas: await p.listaEncomenda.count(),
        linhas: await p.linhaEncomenda.count(),
        outbox: await p.orderOutbox.count(),
      };
    }
    async function criarConsolidacao(batchKey: string, u: U = uAdmin) {
      const a = await ensureRascunhoConsolidacaoFarmaciaServico(deps(u), {
        batchKey, farmaciaId: fA.id, nome: "N · Farmácia A",
        linhas: [
          { produtoId: p0.id, quantidadeAjustada: 10, fornecedorSugeridoId: fornX.id, notas: "nota A p0" },
          { produtoId: pA1.id, quantidadeAjustada: 4, fornecedorSugeridoId: fornY.id },
        ],
      });
      const b = await ensureRascunhoConsolidacaoFarmaciaServico(deps(u), {
        batchKey, farmaciaId: fB.id, nome: "N · Farmácia B",
        linhas: [
          { produtoId: p0.id, quantidadeAjustada: 6, fornecedorSugeridoId: fornZ.id, notas: "nota B p0" },
          { produtoId: pB2.id, quantidadeAjustada: 3, fornecedorSugeridoId: fornX.id },
        ],
      });
      if (!a.ok || !b.ok) throw new Error("setup: rascunhos não criados");
      return { a, b };
    }

    // ═══ N · notas diferentes para o MESMO produto em duas farmácias ═══
    console.log("\nN · notas por linha/farmácia: autosave real, recuperação, documento final isolado");
    const batchN = chaveNova();
    const { a: dA, b: dB } = await criarConsolidacao(batchN);

    // Edição posterior das notas pelo MESMO motor de autosave (gravação em lote com versão).
    const rA = await salvarAutosaveEncomenda(prisma, {
      listaEncomendaId: dA.listaEncomendaId, versaoEsperada: dA.versao,
      linhas: [{ produtoId: p0.id, notas: "nota A p0 (editada)" }, { produtoId: pA1.id, notas: "nota A p1" }],
    });
    const rB = await salvarAutosaveEncomenda(prisma, {
      listaEncomendaId: dB.listaEncomendaId, versaoEsperada: dB.versao,
      linhas: [{ produtoId: p0.id, notas: "nota B p0 (editada)" }, { produtoId: pB2.id, notas: "nota B p2" }],
    });
    check(rA.gravadas === 2 && rB.gravadas === 2, "N1: o autosave real gravou as notas nas duas farmácias");
    check(rA.versao === dA.versao + 1 && rB.versao === dB.versao + 1, "N1b: a versão de cada rascunho avançou 1 por gravação (independente por farmácia)");

    const rec = await obterRascunhosConsolidacaoServico(deps(uAdmin), { batchKey: batchN, farmaciaIds: [fA.id, fB.id] });
    const notaDe = (farmaciaId: string, produtoId: string) => {
      if (!rec.ok) return undefined;
      return rec.porFarmacia.find((x) => x.farmaciaId === farmaciaId)?.draft?.linhas.find((l) => l.produtoId === produtoId)?.notas;
    };
    check(rec.ok && notaDe(fA.id, p0.id) === "nota A p0 (editada)", "N2: a recuperação por batchKey devolve a nota de A para o produto partilhado");
    check(rec.ok && notaDe(fB.id, p0.id) === "nota B p0 (editada)", "N2b: …e a nota DIFERENTE de B para o MESMO produto (nunca propagada de A)");
    check(rec.ok && notaDe(fA.id, pA1.id) === "nota A p1" && notaDe(fB.id, pB2.id) === "nota B p2", "N2c: as restantes notas recuperam-se");
    check(
      rec.ok && rec.porFarmacia.find((x) => x.farmaciaId === fA.id)?.draft?.versao === rA.versao,
      "N2d: a versão recuperada é a versão ACTUAL (não a inicial) — não fica congelada após o autosave"
    );

    const resN = await finalizarConsolidacaoServico(deps(uAdmin), {
      batchKey: batchN, farmaciaIds: [fA.id, fB.id],
      versaoEsperadaPorFarmacia: { [fA.id]: rA.versao, [fB.id]: rB.versao },
    });
    check(resN.ok && resN.documentos.length === 4, "N3: a finalização com as versões actuais gera 4 documentos", resN.ok ? "" : resN.error);
    if (resN.ok) {
      const filhos = await prisma.listaEncomenda.findMany({
        where: { id: { in: resN.documentos.map((d) => d.listaEncomendaId) } },
        include: { linhas: true },
      });
      const doc = (farmaciaId: string, fornecedorId: string) =>
        filhos.find((f) => f.farmaciaId === farmaciaId && f.linhas.some((l) => l.fornecedorSugeridoId === fornecedorId));
      const dAX = doc(fA.id, fornX.id), dAY = doc(fA.id, fornY.id), dBZ = doc(fB.id, fornZ.id), dBX = doc(fB.id, fornX.id);
      check(!!dAX && !!dAY && !!dBZ && !!dBX, "N4-setup: os 4 pares farmácia×fornecedor existem");
      check(dAX?.linhas.length === 1 && dAX.linhas[0].notas === "nota A p0 (editada)", "N4: documento (A, X) leva SÓ a nota de A para o produto partilhado");
      check(dBZ?.linhas.length === 1 && dBZ.linhas[0].notas === "nota B p0 (editada)", "N4b: documento (B, Z) leva SÓ a nota de B para o MESMO produto");
      check(dAY?.linhas[0].notas === "nota A p1" && dBX?.linhas[0].notas === "nota B p2", "N4c: as notas das restantes linhas acompanham-nas");
      const todasNotas = filhos.flatMap((f) => f.linhas.map((l) => `${f.farmaciaId}|${l.fornecedorSugeridoId}|${l.notas}`));
      check(!todasNotas.some((t) => t.startsWith(`${fA.id}|`) && t.includes("nota B")) && !todasNotas.some((t) => t.startsWith(`${fB.id}|`) && t.includes("nota A")),
        "N4d: nenhuma nota de uma farmácia aparece num documento da outra");
    }

    // ═══ V · bloqueio optimista com duas sessões ════════════════════════
    console.log("\nV · bloqueio optimista: duas sessões, conflito explícito, finalização bloqueada");
    const batchV = chaveNova();
    const { a: vA, b: vB } = await criarConsolidacao(batchV);
    const s1 = await salvarAutosaveEncomenda(prisma, {
      listaEncomendaId: vA.listaEncomendaId, versaoEsperada: vA.versao,
      linhas: [{ produtoId: p0.id, notas: "sessão 1" }],
    });
    let erroV: unknown = null;
    try {
      await salvarAutosaveEncomenda(prisma, {
        listaEncomendaId: vA.listaEncomendaId, versaoEsperada: vA.versao, // versão antiga: a sessão 2 nunca viu a gravação da 1
        linhas: [{ produtoId: p0.id, notas: "sessão 2 (deve falhar)" }],
      });
    } catch (e) { erroV = e; }
    check(erroV instanceof ConflitoVersaoError && (erroV as InstanceType<typeof ConflitoVersaoError>).versaoAtual === s1.versao,
      "V1: a gravação com versão antiga é um ConflitoVersaoError explícito (com a versão actual)");
    const linhaV = await prisma.linhaEncomenda.findFirstOrThrow({ where: { listaEncomendaId: vA.listaEncomendaId, produtoId: p0.id } });
    check(linhaV.notas === "sessão 1", "V2: nada foi sobrescrito — a nota da sessão 1 mantém-se");

    const antesV = await contagens();
    const velha = await finalizarConsolidacaoServico(deps(uAdmin), {
      batchKey: batchV, farmaciaIds: [fA.id, fB.id],
      versaoEsperadaPorFarmacia: { [fA.id]: vA.versao, [fB.id]: vB.versao }, // A está desactualizada
    });
    check(!velha.ok && velha.code === "CONFLITO_VERSAO" && velha.farmaciaId === fA.id && velha.versaoAtual === s1.versao,
      "V3: a finalização com a versão antiga de A é recusada e IDENTIFICA a farmácia em conflito (A)");
    const depoisV = await contagens();
    check(JSON.stringify(antesV) === JSON.stringify(depoisV), "V4: o conflito não escreveu nada (zero listas/linhas/outboxes novas)");
    const divididoV = await prisma.listaEncomenda.count({ where: { id: { in: [vA.listaEncomendaId, vB.listaEncomendaId] }, loteDivididoEm: { not: null } } });
    check(divididoV === 0, "V4b: nenhum dos rascunhos ficou dividido");

    const soB = await finalizarConsolidacaoServico(deps(uAdmin), {
      batchKey: batchV, farmaciaIds: [fA.id, fB.id],
      versaoEsperadaPorFarmacia: { [fA.id]: s1.versao, [fB.id]: vB.versao - 1 }, // agora só B está desactualizada
    });
    check(!soB.ok && soB.code === "CONFLITO_VERSAO" && soB.farmaciaId === fB.id, "V5: se só B está desactualizada, o conflito identifica B");

    const nova = await finalizarConsolidacaoServico(deps(uAdmin), {
      batchKey: batchV, farmaciaIds: [fA.id, fB.id],
      versaoEsperadaPorFarmacia: { [fA.id]: s1.versao, [fB.id]: vB.versao },
    });
    check(nova.ok && !nova.reutilizado && nova.documentos.length === 4, "V6: depois de reconciliar (versões actuais) a finalização prossegue");
    const replay = await finalizarConsolidacaoServico(deps(uAdmin), {
      batchKey: batchV, farmaciaIds: [fA.id, fB.id],
      versaoEsperadaPorFarmacia: { [fA.id]: vA.versao, [fB.id]: vB.versao }, // versões antigas: resposta perdida + retry
    });
    check(replay.ok && replay.reutilizado && replay.documentos.length === 4,
      "V7: um retry após resposta perdida (mesmo com versões antigas) é replay idempotente, não conflito");

    // ═══ A · autorização centralizada ══════════════════════════════════
    console.log("\nA · autorização: a chave sozinha não autoriza nada");
    const batchA = chaveNova();
    const { a: aA, b: aB } = await criarConsolidacao(batchA, uAdmin);
    const idsSensiveis = [aA.listaEncomendaId, aB.listaEncomendaId, uAdmin.id, uAdmin2.id, batchA];
    const semVazamento = (r: unknown) => {
      const txt = JSON.stringify(r);
      return !idsSensiveis.some((id) => txt.includes(id));
    };

    // a) outro utilizador do MESMO tenant com a chave
    const antesA = await contagens();
    const outroUser = await finalizarConsolidacaoServico(deps(uAdmin2), { batchKey: batchA, farmaciaIds: [fA.id, fB.id] });
    check(!outroUser.ok && outroUser.code === "REJEITADO", "A1a: outro utilizador (mesmo tenant) com a chave é recusado");
    check(semVazamento(outroUser), "A1a-ii: a recusa não devolve ids nem detalhes");
    const lerOutro = await obterRascunhosConsolidacaoServico(deps(uAdmin2), { batchKey: batchA, farmaciaIds: [fA.id, fB.id] });
    check(lerOutro.ok && lerOutro.porFarmacia.every((p) => p.draft === null) && semVazamento(lerOutro),
      "A1a-iii: a leitura por batchKey também não devolve nada do rascunho alheio");

    // b) utilizador sem acesso a uma das farmácias
    const semAcesso = await finalizarConsolidacaoServico(deps(uOperA), { batchKey: batchA, farmaciaIds: [fA.id, fB.id] });
    check(!semAcesso.ok && semAcesso.code === "REJEITADO", "A1b: utilizador sem acesso a uma das farmácias é recusado");
    check(semVazamento(semAcesso), "A1b-ii: a recusa não devolve ids nem detalhes");

    // c) chave/sessão de outro tenant
    const tenantErrado = await finalizarConsolidacaoServico(deps(uAdmin, prisma, "t", "outro-tenant"), { batchKey: batchA, farmaciaIds: [fA.id, fB.id] });
    check(!tenantErrado.ok && tenantErrado.code === "REJEITADO", "A1c: sessão de OUTRO tenant (claim ≠ tenant do pedido) é recusada");
    check(semVazamento(tenantErrado), "A1c-ii: a recusa não devolve ids nem detalhes");
    await admin.query(`CREATE DATABASE ${dbT2}`);
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(dbT2) }, encoding: "utf8" });
    const prisma2 = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(dbT2) }) });
    const outraBd = await finalizarConsolidacaoServico(deps(uAdmin, prisma2, "t2", "t2"), { batchKey: batchA, farmaciaIds: [fA.id, fB.id] });
    check(!outraBd.ok && outraBd.code === "REJEITADO" && semVazamento(outraBd), "A1c-iii: a mesma chave na BD de OUTRO tenant não encontra nada");

    // d) zero escritas em todos os casos
    const depoisA = await contagens();
    check(JSON.stringify(antesA) === JSON.stringify(depoisA), "A1d: ZERO escritas (listas/linhas/outboxes) em todos os casos recusados");
    const t2 = await contagens(prisma2);
    check(t2.listas === 0 && t2.linhas === 0 && t2.outbox === 0, "A1d-ii: e zero escritas na BD do outro tenant");
    const aindaRascunhos = await prisma.listaEncomenda.count({ where: { id: { in: [aA.listaEncomendaId, aB.listaEncomendaId] }, loteDivididoEm: null, estado: "RASCUNHO" } });
    check(aindaRascunhos === 2, "A1d-iii: os rascunhos continuam intactos e por finalizar");

    // o dono, pelo contrário, finaliza
    const dono = await finalizarConsolidacaoServico(deps(uAdmin), { batchKey: batchA, farmaciaIds: [fA.id, fB.id] });
    check(dono.ok && dono.documentos.length === 4, "A2: o criador (com acesso a ambas as farmácias) finaliza normalmente");

    await prisma2.$disconnect();
    await prisma.$disconnect();
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${dbT2} WITH (FORCE)`);
    await admin.query(`DROP DATABASE IF EXISTS ${dbT1} WITH (FORCE)`);
    await admin.end();
  }

  console.log(`\n${passed} ok, ${failed} falhas`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
