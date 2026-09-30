/**
 * scripts/tests/test-consolidacao-fornecedor-linha-db.ts
 *
 * PostgreSQL REAL e DESCARTÁVEL (recusa correr fora de localhost):
 *
 *   docker run -d --name spharm-cfl-test-pg -e POSTGRES_PASSWORD=test -p 55493:5432 postgres:16-alpine
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:55493/postgres npx tsx scripts/tests/test-consolidacao-fornecedor-linha-db.ts
 *
 * Cobre o NOVO fluxo de consolidação com fornecedor por linha — rascunho
 * REAL e persistente por farmácia (`ensureRascunhoConsolidacaoFarmaciaServico`),
 * recuperação por batchKey (`obterRascunhosConsolidacaoServico`), autosave
 * REAL reutilizado sem alterações (`salvarAutosaveEncomenda`), e
 * finalização agrupando primeiro por farmácia, depois por fornecedor
 * (`finalizarConsolidacaoMultiFornecedor` — motor já validado em
 * `test-consolidacao-multi-fornecedor-db.ts`; aqui testado através da
 * camada de serviço nova, nunca uma segunda implementação).
 *
 * Testa ao nível do SERVIÇO (dependências injectadas), não das Server
 * Actions em `app/encomendas/nova/actions.ts` — mesma convenção de
 * `test-consolidacao-resposta-perdida-db.ts`: as actions só resolvem
 * sessão/tenant/prisma reais (via `requirePermission`/cookies, que não
 * existem fora de um pedido Next real) e delegam integralmente nestas
 * funções.
 *
 * 20 itens pedidos, por secção:
 *   A  1-7   duas farmácias, dois fornecedores em cada, o MESMO produto
 *            com fornecedor DIFERENTE por farmácia → 4 encomendas finais,
 *            4 números reais, 4 outboxes, 4 PDFs isolados.
 *   B  8     linha sem fornecedor bloqueia a finalização (do lote inteiro
 *            — ver a nota de desenho no cabeçalho da secção).
 *   C  9-10  edição individual persiste; edição em massa restrita a uma
 *            farmácia só altera essa farmácia.
 *   D  11-12 refresh recupera tudo; nunca recalcula um fornecedor já
 *            decidido.
 *   E  13    duas consolidações independentes (batchKeys diferentes) never
 *            colidem mesmo com farmácias sobrepostas.
 *   F  14    falha forçada no 4.º grupo farmácia/fornecedor reverte o
 *            LOTE INTEIRO (zero documentos, zero outboxes).
 *   G  15    8 pedidos concorrentes com a mesma batchKey criam exactamente
 *            um lote de documentos.
 *   H  16    resposta perdida simulada reconcilia correctamente.
 *   I  17    payload alterado sob a mesma batchKey é rejeitado como
 *            conflito (nunca um duplicado silencioso).
 *   J  18    utilizador sem acesso a uma das farmácias é recusado
 *            limpamente, com ZERO escritas.
 *   K  19    outro tenant não tem NENHUM vestígio do lote.
 *   L  20    cancelar uma das quatro encomendas finais nunca toca nas
 *            outras três.
 *
 * ── Decisão de desenho: uma farmácia sem fornecedor bloqueia o LOTE
 *    INTEIRO, não só essa farmácia ────────────────────────────────────
 *
 * `finalizarConsolidacaoMultiFornecedor` processa as farmácias num loop
 * DENTRO de uma única `prisma.$transaction` (ver o comentário desse
 * ficheiro) — a mesma garantia "tudo ou nada" que a consolidação já tinha
 * ANTES desta funcionalidade (`createConsolidatedOrdersWithOutbox`).
 * Mudar isso para "só a farmácia com o problema falha, as outras
 * continuam" exigiria restruturar o ÂMBITO DA TRANSACÇÃO do motor — e o
 * mandato desta tarefa é explícito: não tocar na lógica interna de
 * `finalizarConsolidacaoMultiFornecedor`/`finalizarNaTransaccao`, só
 * chamá-las. A pré-validação amigável em `finalizarConsolidacaoFornecedorAction`
 * (app/encomendas/nova/actions.ts) mitiga o caso comum — identifica a
 * farmácia e os produtos exactos ANTES de abrir a transacção, para o
 * utilizador corrigir sem sequer chegar a tentar escrever — mas a
 * garantia REAL, se uma corrida deixar passar uma linha inválida até à
 * transacção, continua "tudo ou nada" para o lote inteiro. Secções B (8)
 * e F (14) testam precisamente isto.
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

async function extrairTexto(buffer: Buffer): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  await parser.destroy?.();
  return result.text;
}

const chaveNova = () =>
  Array.from({ length: 24 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("");

async function main() {
  const sufixo = Date.now().toString(36);
  const dbT1 = `spharm_cfl_${sufixo}`;
  const dbT2 = `spharm_cfl2_${sufixo}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbT1}`);

  try {
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(dbT1) }, encoding: "utf8" });

    const { PrismaClient } = await import("../../generated/prisma/client");
    const prisma1 = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(dbT1) }) });

    const { deriveFarmaciaIdempotencyKey } = await import("../../lib/ingest/orders");
    const { salvarAutosaveEncomenda } = await import("../../lib/encomendas/autosave");
    const {
      ensureRascunhoConsolidacaoFarmaciaServico,
      obterRascunhosConsolidacaoServico,
      autorizarConsolidacao,
    } = await import("../../lib/encomendas/consolidacao-servico");
    const { finalizarConsolidacaoMultiFornecedor, LinhasSemFornecedorError } = await import(
      "../../lib/encomendas/consolidacao-multi-fornecedor"
    );
    const { loadOrderDetailComPrisma } = await import("../../lib/encomendas/order-detail");
    const { buildEncomendaDocumentoReport } = await import("../../lib/reporting/adapters/encomenda-documento");
    const { buildReportPdfBuffer } = await import("../../lib/reporting/report-pdf-server");

    // ── Dados base (tenant 1) ─────────────────────────────────────────
    const fA = await prisma1.farmacia.create({ data: { nome: "Farmácia A" } });
    const fB = await prisma1.farmacia.create({ data: { nome: "Farmácia B" } });
    const fC = await prisma1.farmacia.create({ data: { nome: "Farmácia C" } });
    const fD = await prisma1.farmacia.create({ data: { nome: "Farmácia D" } });
    const fE = await prisma1.farmacia.create({ data: { nome: "Farmácia E" } });
    const fornX = await prisma1.fornecedor.create({ data: { nomeNormalizado: "FORNECEDOR X", nome: "Fornecedor X" } });
    const fornY = await prisma1.fornecedor.create({ data: { nomeNormalizado: "FORNECEDOR Y", nome: "Fornecedor Y" } });
    const fornZ = await prisma1.fornecedor.create({ data: { nomeNormalizado: "FORNECEDOR Z", nome: "Fornecedor Z" } });
    const p0 = await prisma1.produto.create({ data: { cnp: 9000000, designacao: "Produto Zero Partilhado" } });
    const pA1 = await prisma1.produto.create({ data: { cnp: 9000001, designacao: "Produto A-Unico" } });
    const pB2 = await prisma1.produto.create({ data: { cnp: 9000002, designacao: "Produto B-Unico" } });
    const outros: Array<{ id: string }> = [];
    for (let i = 3; i < 13; i++) outros.push(await prisma1.produto.create({ data: { cnp: 9000000 + i, designacao: `Produto ${i}` } }));

    const uAdmin = await prisma1.utilizador.create({ data: { email: "admin@t.pt", nome: "Admin", perfil: "ADMINISTRADOR" } });
    const uOper = await prisma1.utilizador.create({ data: { email: "oper@t.pt", nome: "Oper", perfil: "OPERADOR", farmaciaId: fA.id } });

    const deps = (u: { id: string; perfil: string; farmaciaId: string | null } = uAdmin, p = prisma1) => ({
      prisma: p,
      tenantSlug: "t",
      sessao: { sub: u.id, perfil: u.perfil, farmaciaId: u.farmaciaId },
      auditar: undefined as undefined | ((e: { action: string; entityId: string; meta: Record<string, unknown> }) => Promise<void>),
    });

    // ═══ A · duas farmácias, dois fornecedores em cada, mesmo produto
    //         com fornecedor diferente por farmácia → 4 encomendas ═════
    console.log("\nA · rascunhos reais por farmácia + finalização por fornecedor (itens 1-7)");
    const batchA = chaveNova();
    const draftA = await ensureRascunhoConsolidacaoFarmaciaServico(deps(uAdmin), {
      batchKey: batchA,
      farmaciaId: fA.id,
      nome: "Consolidação · Farmácia A",
      linhas: [
        { produtoId: p0.id, quantidadeAjustada: 10, fornecedorSugeridoId: fornX.id },
        { produtoId: pA1.id, quantidadeAjustada: 4, fornecedorSugeridoId: fornY.id },
      ],
    });
    const draftB = await ensureRascunhoConsolidacaoFarmaciaServico(deps(uAdmin), {
      batchKey: batchA,
      farmaciaId: fB.id,
      nome: "Consolidação · Farmácia B",
      linhas: [
        { produtoId: p0.id, quantidadeAjustada: 6, fornecedorSugeridoId: fornZ.id },
        { produtoId: pB2.id, quantidadeAjustada: 3, fornecedorSugeridoId: fornX.id },
      ],
    });
    check(draftA.ok && draftB.ok, "1: duas farmácias com rascunho real persistido");
    check(
      draftA.ok && draftB.ok && draftA.listaEncomendaId !== draftB.listaEncomendaId,
      "1b: são duas ListaEncomenda distintas"
    );

    const resA = await finalizarConsolidacaoMultiFornecedor(prisma1, "t", { batchKey: batchA, farmaciaIds: [fA.id, fB.id] });
    check(resA.documentos.length === 4, "2+3+4: 4 documentos finais (A usa fornX+fornY; B usa fornZ+fornX; P0 com fornecedor diferente por farmácia)", `obtido=${resA.documentos.length}`);
    const numerosA = resA.documentos.map((d) => d.numero);
    check(numerosA.every((n) => n !== null && /^EN-\d{6}$/.test(n!)), "5: os 4 números são reais EN-######");
    check(new Set(numerosA).size === 4, "5b: os 4 números são distintos");

    const filhosA = await prisma1.listaEncomenda.findMany({
      where: { id: { in: resA.documentos.map((d) => d.listaEncomendaId) } },
      select: { id: true, farmaciaId: true, estado: true, outbox: { select: { id: true } } },
    });
    check(filhosA.length === 4 && filhosA.every((f) => f.estado === "FINALIZADA"), "4b: os 4 nasceram FINALIZADA");
    check(filhosA.every((f) => f.outbox !== null), "6: os 4 têm o seu próprio OrderOutbox");

    const docAfornX = resA.documentos.find((d) => d.farmaciaId === fA.id && d.fornecedorId === fornX.id)!;
    const docAfornY = resA.documentos.find((d) => d.farmaciaId === fA.id && d.fornecedorId === fornY.id)!;
    const docBfornZ = resA.documentos.find((d) => d.farmaciaId === fB.id && d.fornecedorId === fornZ.id)!;
    const docBfornX = resA.documentos.find((d) => d.farmaciaId === fB.id && d.fornecedorId === fornX.id)!;
    check(!!docAfornX && !!docAfornY && !!docBfornZ && !!docBfornX, "3b: os 4 pares farmácia×fornecedor esperados existem");

    console.log("  (7 · PDF real de cada documento — isolamento farmácia+fornecedor+linhas)");
    const detAfX = await loadOrderDetailComPrisma(prisma1, docAfornX.listaEncomendaId);
    const detAfY = await loadOrderDetailComPrisma(prisma1, docAfornY.listaEncomendaId);
    const detBfZ = await loadOrderDetailComPrisma(prisma1, docBfornZ.listaEncomendaId);
    const detBfX = await loadOrderDetailComPrisma(prisma1, docBfornX.listaEncomendaId);
    check(!!detAfX && !!detAfY && !!detBfZ && !!detBfX, "7a: os 4 documentos são legíveis via loadOrderDetailComPrisma");
    const [repAfX] = buildEncomendaDocumentoReport([detAfX!]);
    const [repAfY] = buildEncomendaDocumentoReport([detAfY!]);
    const [repBfZ] = buildEncomendaDocumentoReport([detBfZ!]);
    const [repBfX] = buildEncomendaDocumentoReport([detBfX!]);
    const txtAfX = await extrairTexto((await buildReportPdfBuffer(repAfX)).buffer);
    const txtAfY = await extrairTexto((await buildReportPdfBuffer(repAfY)).buffer);
    const txtBfZ = await extrairTexto((await buildReportPdfBuffer(repBfZ)).buffer);
    const txtBfX = await extrairTexto((await buildReportPdfBuffer(repBfX)).buffer);
    check(txtAfX.includes("Fornecedor X") && txtAfX.includes("Produto Zero Partilhado") && !txtAfX.includes("Fornecedor Y") && !txtAfX.includes("Fornecedor Z") && !txtAfX.includes("Produto A-Unico") && !txtAfX.includes("Produto B-Unico"), "7b: PDF (A, fornX) só mostra Fornecedor X e Produto Zero");
    check(txtAfY.includes("Fornecedor Y") && txtAfY.includes("Produto A-Unico") && !txtAfY.includes("Fornecedor X") && !txtAfY.includes("Fornecedor Z") && !txtAfY.includes("Produto Zero Partilhado"), "7c: PDF (A, fornY) só mostra Fornecedor Y e Produto A-Unico");
    check(txtBfZ.includes("Fornecedor Z") && txtBfZ.includes("Produto Zero Partilhado") && !txtBfZ.includes("Fornecedor X") && !txtBfZ.includes("Fornecedor Y") && !txtBfZ.includes("Produto B-Unico"), "7d: PDF (B, fornZ) só mostra Fornecedor Z e Produto Zero");
    check(txtBfX.includes("Fornecedor X") && txtBfX.includes("Produto B-Unico") && !txtBfX.includes("Fornecedor Y") && !txtBfX.includes("Fornecedor Z") && !txtBfX.includes("Produto A-Unico"), "7e: PDF (B, fornX) só mostra Fornecedor X e Produto B-Unico");

    // ═══ B · linha sem fornecedor bloqueia o LOTE INTEIRO (item 8) ═════
    console.log("\nB · linha sem fornecedor bloqueia a finalização do lote inteiro (item 8)");
    const batchB = chaveNova();
    const draftB1 = await ensureRascunhoConsolidacaoFarmaciaServico(deps(uAdmin), {
      batchKey: batchB, farmaciaId: fA.id, nome: "B · A válida",
      linhas: [{ produtoId: outros[0].id, quantidadeAjustada: 2, fornecedorSugeridoId: fornX.id }],
    });
    const draftB2 = await ensureRascunhoConsolidacaoFarmaciaServico(deps(uAdmin), {
      batchKey: batchB, farmaciaId: fB.id, nome: "B · B com linha sem fornecedor",
      linhas: [{ produtoId: outros[1].id, quantidadeAjustada: 1, fornecedorSugeridoId: null }],
    });
    check(draftB1.ok && draftB2.ok, "8-setup: dois rascunhos criados (um válido, um com linha sem fornecedor)");
    let erro8: unknown = null;
    try {
      await finalizarConsolidacaoMultiFornecedor(prisma1, "t", { batchKey: batchB, farmaciaIds: [fA.id, fB.id] });
    } catch (e) { erro8 = e; }
    check(erro8 instanceof LinhasSemFornecedorError, "8: rejeitado com LinhasSemFornecedorError");
    const draftB1Depois = draftB1.ok
      ? await prisma1.listaEncomenda.findUnique({ where: { id: draftB1.listaEncomendaId }, select: { loteDivididoEm: true } })
      : null;
    check(draftB1Depois?.loteDivididoEm === null, "8b: a farmácia A (válida) NÃO ficou dividida — bloqueia o LOTE INTEIRO, não só a farmácia com o problema");
    const filhosB = await prisma1.listaEncomenda.count({
      where: { loteOrigemId: { in: [draftB1.ok ? draftB1.listaEncomendaId : "", draftB2.ok ? draftB2.listaEncomendaId : ""] } },
    });
    check(filhosB === 0, "8c: zero documentos gerados para qualquer farmácia do lote");

    // ═══ C · edição individual e em massa (itens 9-10) ═════════════════
    console.log("\nC · edição individual persiste; edição em massa fica restrita a uma farmácia (itens 9-10)");
    const batchC = chaveNova();
    const draftC_A = await ensureRascunhoConsolidacaoFarmaciaServico(deps(uAdmin), {
      batchKey: batchC, farmaciaId: fA.id, nome: "C · Farmácia A",
      linhas: [
        { produtoId: outros[2].id, quantidadeAjustada: 5, fornecedorSugeridoId: fornX.id },
        { produtoId: outros[3].id, quantidadeAjustada: 7, fornecedorSugeridoId: fornX.id },
      ],
    });
    const draftC_B = await ensureRascunhoConsolidacaoFarmaciaServico(deps(uAdmin), {
      batchKey: batchC, farmaciaId: fB.id, nome: "C · Farmácia B",
      linhas: [{ produtoId: outros[2].id, quantidadeAjustada: 5, fornecedorSugeridoId: fornX.id }],
    });
    if (!draftC_A.ok || !draftC_B.ok) throw new Error("setup C falhou");

    // 9: edição individual de UMA linha (autosave real, reutilizado sem alterações).
    const autosave9 = await salvarAutosaveEncomenda(prisma1, {
      listaEncomendaId: draftC_A.listaEncomendaId,
      versaoEsperada: draftC_A.versao,
      linhas: [{ produtoId: outros[2].id, fornecedorSugeridoId: fornY.id }],
    });
    const linhaEditada = await prisma1.linhaEncomenda.findFirst({
      where: { listaEncomendaId: draftC_A.listaEncomendaId, produtoId: outros[2].id },
      select: { fornecedorSugeridoId: true },
    });
    check(linhaEditada?.fornecedorSugeridoId === fornY.id, "9: edição individual de uma linha persiste no fornecedor certo");

    // 10: edição em massa restrita à farmácia A — farmácia B (mesmo produto!) fica intocada.
    await salvarAutosaveEncomenda(prisma1, {
      listaEncomendaId: draftC_A.listaEncomendaId,
      versaoEsperada: autosave9.versao,
      linhas: [
        { produtoId: outros[2].id, fornecedorSugeridoId: fornZ.id },
        { produtoId: outros[3].id, fornecedorSugeridoId: fornZ.id },
      ],
    });
    const linhasADepois = await prisma1.linhaEncomenda.findMany({
      where: { listaEncomendaId: draftC_A.listaEncomendaId },
      select: { produtoId: true, fornecedorSugeridoId: true },
    });
    check(linhasADepois.every((l) => l.fornecedorSugeridoId === fornZ.id), "10: a edição em massa aplicou-se às duas linhas da farmácia A");
    const linhaBIntacta = await prisma1.linhaEncomenda.findFirst({
      where: { listaEncomendaId: draftC_B.listaEncomendaId, produtoId: outros[2].id },
      select: { fornecedorSugeridoId: true },
    });
    check(linhaBIntacta?.fornecedorSugeridoId === fornX.id, "10b: a MESMA referência de produto na farmácia B ficou intocada (fornX, nunca propagado de A)");

    // ═══ D · refresh recupera tudo; nunca recalcula (itens 11-12) ══════
    console.log("\nD · refresh recupera o estado exacto persistido, sem recalcular nada (itens 11-12)");
    const recuperado = await obterRascunhosConsolidacaoServico(deps(uAdmin), { batchKey: batchC, farmaciaIds: [fA.id, fB.id] });
    check(recuperado.ok, "11: a recuperação por batchKey teve sucesso");
    if (recuperado.ok) {
      const dA = recuperado.porFarmacia.find((p) => p.farmaciaId === fA.id)?.draft;
      const dB = recuperado.porFarmacia.find((p) => p.farmaciaId === fB.id)?.draft;
      check(!!dA && dA.linhas.length === 2 && !!dB && dB.linhas.length === 1, "11b: as duas farmácias vêm com as suas linhas completas");
      const lA2 = dA?.linhas.find((l) => l.produtoId === outros[2].id);
      const lA3 = dA?.linhas.find((l) => l.produtoId === outros[3].id);
      check(lA2?.fornecedorSugeridoId === fornZ.id && lA3?.fornecedorSugeridoId === fornZ.id, "12: a recuperação devolve o fornecedor EXACTO editado (fornZ) — nunca a sugestão original (fornX), nunca recalculado");
      check(lA2?.quantidadeAjustada === 5 && lA3?.quantidadeAjustada === 7, "12b: quantidades persistidas intactas");
      const lB2 = dB?.linhas.find((l) => l.produtoId === outros[2].id);
      check(lB2?.fornecedorSugeridoId === fornX.id, "12c: a farmácia B recupera o SEU fornecedor (fornX), independente de A");
    }

    // ═══ E · duas consolidações independentes nunca colidem (item 13) ══
    console.log("\nE · duas batchKeys diferentes na MESMA farmácia nunca colidem (item 13)");
    const batchE1 = chaveNova();
    const batchE2 = chaveNova();
    const draftE1 = await ensureRascunhoConsolidacaoFarmaciaServico(deps(uAdmin), {
      batchKey: batchE1, farmaciaId: fC.id, nome: "E · lote 1",
      linhas: [{ produtoId: outros[4].id, quantidadeAjustada: 1, fornecedorSugeridoId: fornX.id }],
    });
    const draftE2 = await ensureRascunhoConsolidacaoFarmaciaServico(deps(uAdmin), {
      batchKey: batchE2, farmaciaId: fC.id, nome: "E · lote 2",
      linhas: [{ produtoId: outros[4].id, quantidadeAjustada: 99, fornecedorSugeridoId: fornY.id }],
    });
    check(
      draftE1.ok && draftE2.ok && draftE1.listaEncomendaId !== draftE2.listaEncomendaId,
      "13: duas batchKeys diferentes na mesma farmácia produzem dois rascunhos independentes"
    );
    const linhaE1 = draftE1.ok
      ? await prisma1.linhaEncomenda.findFirst({ where: { listaEncomendaId: draftE1.listaEncomendaId }, select: { quantidadeAjustada: true, fornecedorSugeridoId: true } })
      : null;
    check(Number(linhaE1?.quantidadeAjustada) === 1 && linhaE1?.fornecedorSugeridoId === fornX.id, "13b: o lote 1 continua com os SEUS valores — o lote 2 não lhe tocou");

    // ═══ F · falha forçada no 4.º grupo reverte o LOTE INTEIRO (item 14) ═
    console.log("\nF · falha no 4.º grupo farmácia/fornecedor reverte o lote inteiro de 4 farmácias (item 14)");
    const batchF = chaveNova();
    const draftF_A = await ensureRascunhoConsolidacaoFarmaciaServico(deps(uAdmin), {
      batchKey: batchF, farmaciaId: fA.id, nome: "F · A", linhas: [{ produtoId: outros[5].id, quantidadeAjustada: 1, fornecedorSugeridoId: fornX.id }],
    });
    const draftF_B = await ensureRascunhoConsolidacaoFarmaciaServico(deps(uAdmin), {
      batchKey: batchF, farmaciaId: fB.id, nome: "F · B", linhas: [{ produtoId: outros[5].id, quantidadeAjustada: 1, fornecedorSugeridoId: fornY.id }],
    });
    const draftF_C = await ensureRascunhoConsolidacaoFarmaciaServico(deps(uAdmin), {
      batchKey: batchF, farmaciaId: fC.id, nome: "F · C", linhas: [{ produtoId: outros[5].id, quantidadeAjustada: 1, fornecedorSugeridoId: fornZ.id }],
    });
    // 4.º grupo (Farmácia D): linha SEM fornecedor — força a falha exactamente no 4.º elemento do lote.
    const draftF_D = await ensureRascunhoConsolidacaoFarmaciaServico(deps(uAdmin), {
      batchKey: batchF, farmaciaId: fD.id, nome: "F · D (inválida)", linhas: [{ produtoId: outros[6].id, quantidadeAjustada: 1, fornecedorSugeridoId: null }],
    });
    check(draftF_A.ok && draftF_B.ok && draftF_C.ok && draftF_D.ok, "14-setup: as 4 farmácias têm rascunho real (a 4.ª com uma linha sem fornecedor)");
    let erro14: unknown = null;
    try {
      await finalizarConsolidacaoMultiFornecedor(prisma1, "t", { batchKey: batchF, farmaciaIds: [fA.id, fB.id, fC.id, fD.id] });
    } catch (e) { erro14 = e; }
    check(erro14 instanceof LinhasSemFornecedorError, "14: a chamada falha ao chegar à 4.ª farmácia");
    const idsDraftsF = [draftF_A, draftF_B, draftF_C, draftF_D].map((d) => (d.ok ? d.listaEncomendaId : ""));
    const draftsFDepois = await prisma1.listaEncomenda.findMany({ where: { id: { in: idsDraftsF } }, select: { loteDivididoEm: true } });
    check(draftsFDepois.every((d) => d.loteDivididoEm === null), "14b: NENHUMA das 4 farmácias ficou dividida — nem sequer as 3 válidas processadas antes da 4.ª");
    const filhosF = await prisma1.listaEncomenda.count({ where: { loteOrigemId: { in: idsDraftsF } } });
    check(filhosF === 0, "14c: ZERO documentos criados");
    const outboxesF = await prisma1.orderOutbox.count({ where: { listaEncomendaId: { in: idsDraftsF } } });
    check(outboxesF === 0, "14d: ZERO outboxes criadas");

    // ═══ G · 8 pedidos concorrentes, mesma batchKey (item 15) ══════════
    console.log("\nG · 8 finalizações concorrentes com a mesma batchKey → um único lote (item 15)");
    const batchG = chaveNova();
    const draftG = await ensureRascunhoConsolidacaoFarmaciaServico(deps(uAdmin), {
      batchKey: batchG, farmaciaId: fE.id, nome: "G · concorrência",
      linhas: [
        { produtoId: outros[0].id, quantidadeAjustada: 1, fornecedorSugeridoId: fornX.id },
        { produtoId: outros[1].id, quantidadeAjustada: 1, fornecedorSugeridoId: fornY.id },
      ],
    });
    if (!draftG.ok) throw new Error("setup G falhou");
    const concorrentesG = await Promise.allSettled(
      Array.from({ length: 8 }, () => finalizarConsolidacaoMultiFornecedor(prisma1, "t", { batchKey: batchG, farmaciaIds: [fE.id] }))
    );
    const sucessosG = concorrentesG.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof finalizarConsolidacaoMultiFornecedor>>> => r.status === "fulfilled");
    check(sucessosG.length === 8, "15: as 8 chamadas concorrentes tiveram sucesso (idempotência, nunca erro)", `sucessos=${sucessosG.length}`);
    const idsUnicosG = new Set(sucessosG.flatMap((s) => s.value.documentos.map((d) => d.listaEncomendaId)));
    check(idsUnicosG.size === 2, "15b: só 2 documentos reais existem (nunca 16)", `obtido=${idsUnicosG.size}`);
    const filhosGReal = await prisma1.listaEncomenda.count({ where: { loteOrigemId: draftG.listaEncomendaId } });
    check(filhosGReal === 2, "15c: confirmado directamente em Postgres");

    // ═══ H · resposta perdida simulada (item 16) ═══════════════════════
    console.log("\nH · resposta perdida simulada reconcilia correctamente (item 16)");
    const batchH = chaveNova();
    const inputH = {
      batchKey: batchH, farmaciaId: fA.id, nome: "H · resposta perdida",
      linhas: [{ produtoId: outros[7].id, quantidadeAjustada: 2, fornecedorSugeridoId: fornX.id }],
    };
    const primeiraH = await ensureRascunhoConsolidacaoFarmaciaServico(deps(uAdmin), inputH);
    check(primeiraH.ok, "16-setup: o pedido original foi aceite (commit real)");
    // Simula: o cliente NUNCA viu a resposta (timeout/rede) e repete
    // exactamente o mesmo pedido, com a MESMA batchKey.
    const retryH = await ensureRascunhoConsolidacaoFarmaciaServico(deps(uAdmin), inputH);
    check(retryH.ok && primeiraH.ok && retryH.listaEncomendaId === primeiraH.listaEncomendaId, "16: o retry após resposta perdida recupera o MESMO rascunho, nunca cria um segundo");
    const contagemH = await prisma1.listaEncomenda.count({ where: { clientIdempotencyKey: deriveFarmaciaIdempotencyKey(batchH, fA.id) } });
    check(contagemH === 1, "16b: existe exactamente UMA ListaEncomenda para esta chave, apesar de duas chamadas");

    // ═══ I · payload alterado sob a mesma batchKey é conflito (item 17) ═
    console.log("\nI · payload alterado sob a mesma batchKey é rejeitado como conflito (item 17)");
    const batchI = chaveNova();
    const origI = await ensureRascunhoConsolidacaoFarmaciaServico(deps(uAdmin), {
      batchKey: batchI, farmaciaId: fB.id, nome: "I · original",
      linhas: [{ produtoId: outros[8].id, quantidadeAjustada: 3, fornecedorSugeridoId: fornX.id }],
    });
    check(origI.ok, "17-setup: pedido original aceite");
    const alteradoI = await ensureRascunhoConsolidacaoFarmaciaServico(deps(uAdmin), {
      batchKey: batchI, farmaciaId: fB.id, nome: "I · original",
      linhas: [{ produtoId: outros[8].id, quantidadeAjustada: 999, fornecedorSugeridoId: fornY.id }], // payload DIFERENTE, mesma chave
    });
    check(!alteradoI.ok && alteradoI.code === "IDEMPOTENCY_CONFLICT", "17: payload diferente sob a mesma batchKey é recusado como conflito explícito, nunca um duplicado silencioso");
    const contagemI = await prisma1.listaEncomenda.count({ where: { clientIdempotencyKey: deriveFarmaciaIdempotencyKey(batchI, fB.id) } });
    check(contagemI === 1, "17b: continua a existir exactamente UMA ListaEncomenda (o pedido original, intocado)");
    const linhaIintacta = origI.ok
      ? await prisma1.linhaEncomenda.findFirst({ where: { listaEncomendaId: origI.listaEncomendaId }, select: { quantidadeAjustada: true } })
      : null;
    check(Number(linhaIintacta?.quantidadeAjustada) === 3, "17c: o conteúdo original não foi alterado pelo pedido conflituoso");

    // ═══ J · utilizador sem acesso é recusado, ZERO escritas (item 18) ═
    console.log("\nJ · utilizador sem acesso a uma farmácia é recusado, com ZERO escritas (item 18)");
    const antesJ = await prisma1.listaEncomenda.count();
    const batchJ = chaveNova();
    const negadoJ1 = await ensureRascunhoConsolidacaoFarmaciaServico(deps(uOper), {
      batchKey: batchJ, farmaciaId: fB.id, nome: "J · negado", // uOper só tem acesso a fA
      linhas: [{ produtoId: outros[0].id, quantidadeAjustada: 1, fornecedorSugeridoId: fornX.id }],
    });
    check(!negadoJ1.ok && negadoJ1.code === "REJEITADO", "18a: ensureRascunho... recusa um OPERADOR de outra farmácia");
    const negadoJ2 = await obterRascunhosConsolidacaoServico(deps(uOper), { batchKey: batchA, farmaciaIds: [fA.id, fB.id] });
    check(!negadoJ2.ok && negadoJ2.code === "REJEITADO", "18b: obterRascunhos... também recusa (fB fora do seu acesso)");
    const recusaAuto = autorizarConsolidacao({ sub: uOper.id, perfil: uOper.perfil, farmaciaId: uOper.farmaciaId }, [fA.id, fB.id]);
    check(typeof recusaAuto === "string", "18c: autorizarConsolidacao recusa mesmo incluindo a SUA própria farmácia (perfil sem vista de grupo)");
    const depoisJ = await prisma1.listaEncomenda.count();
    check(depoisJ === antesJ, "18d: ZERO linhas novas em ListaEncomenda — as recusas não escreveram nada");

    // ═══ K · outro tenant não tem NENHUM vestígio (item 19) ════════════
    console.log("\nK · outro tenant nunca vê o lote (item 19)");
    await prisma1.$disconnect();
    await admin.query(`CREATE DATABASE ${dbT2} TEMPLATE ${dbT1}`);
    const prisma1b = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(dbT1) }) });
    const prisma2 = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(dbT2) }) });
    const batchK = chaveNova();
    const criadoT1 = await ensureRascunhoConsolidacaoFarmaciaServico(deps(uAdmin, prisma1b), {
      batchKey: batchK, farmaciaId: fA.id, nome: "K · só no tenant 1",
      linhas: [{ produtoId: outros[0].id, quantidadeAjustada: 1, fornecedorSugeridoId: fornX.id }],
    });
    check(criadoT1.ok, "19-setup: criado no tenant 1");
    const buscaT2 = await obterRascunhosConsolidacaoServico(deps(uAdmin, prisma2), { batchKey: batchK, farmaciaIds: [fA.id] });
    check(buscaT2.ok && buscaT2.porFarmacia[0]?.draft === null, "19: o tenant 2 (base de dados FÍSICA separada) não encontra NENHUM rascunho desta batchKey — isolamento estrutural, não um filtro");
    const contagemT2 = await prisma2.listaEncomenda.count({ where: { clientIdempotencyKey: deriveFarmaciaIdempotencyKey(batchK, fA.id) } });
    check(contagemT2 === 0, "19b: confirmado directamente em Postgres — zero rows no tenant 2 com esta chave");

    // ═══ L · cancelar uma das 4 encomendas finais não afecta as outras 3
    //         (item 20, reaproveita os 4 documentos da secção A) ═══════
    console.log("\nL · cancelar uma das 4 encomendas finais nunca toca nas outras três (item 20)");
    await prisma1b.listaEncomenda.update({
      where: { id: docAfornX.listaEncomendaId },
      data: { estado: "ANULADA", motivoAnulacao: "Teste de isolamento", anuladoPorId: uAdmin.id, anuladoEm: new Date() },
    });
    const canceladoL = await prisma1b.listaEncomenda.findUniqueOrThrow({ where: { id: docAfornX.listaEncomendaId }, include: { linhas: true } });
    check(canceladoL.estado === "ANULADA" && canceladoL.linhas.length === 1, "20a: o documento cancelado fica ANULADA, mantém a sua linha (nunca apagada)");
    const irmaosL = await prisma1b.listaEncomenda.findMany({
      where: { id: { in: [docAfornY.listaEncomendaId, docBfornZ.listaEncomendaId, docBfornX.listaEncomendaId] } },
      select: { estado: true },
    });
    check(irmaosL.length === 3 && irmaosL.every((i) => i.estado === "FINALIZADA"), "20b: as outras 3 encomendas continuam FINALIZADA — cancelar uma não afecta as outras");

    await prisma1b.$disconnect();
    await prisma2.$disconnect();
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${dbT2} WITH (FORCE)`);
    await admin.query(`DROP DATABASE IF EXISTS ${dbT1} WITH (FORCE)`);
    await admin.end();
  }

  console.log(`\n${passed} ok, ${failed} falhas`);
  // `buildReportPdfBuffer` mantém um browser Puppeteer singleton nunca
  // fechado — sem process.exit explícito o processo fica vivo para
  // sempre mesmo depois do resumo impresso.
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
