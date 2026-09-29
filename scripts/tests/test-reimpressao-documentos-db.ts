/**
 * scripts/tests/test-reimpressao-documentos-db.ts
 *
 * "Reimprimir / gerar PDF / reenviar email" depois da finalização —
 * Postgres REAL e DESCARTÁVEL (nunca uma base real):
 *
 *   docker run -d --name spharm-ws-test-pg -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:16-alpine
 *   npm run test:reimpressao-documentos-db
 *
 * `buildDocumentosFinalizacaoAction` (app/encomendas/nova/actions.ts) não é
 * directamente testável isolado (depende de `requirePermission`/`getPrisma()`
 * — contexto de pedido do Next.js). Este ficheiro exercita exactamente as
 * MESMAS funções que essa acção compõe — `loadOrderDetail`/
 * `loadTransferenciasDetail` (leitura pura) + os adapters puros — contra
 * dados REAIS já FINALIZADOS, chamando-as VÁRIAS VEZES com modalidades
 * diferentes (como um utilizador que reabre a encomenda dias depois e
 * escolhe "separado", depois "consolidado"), e confirma ao fim que NADA
 * na base de dados mudou: nenhuma ListaEncomenda/Transferencia/OrderOutbox
 * nova, nenhuma quantidade alterada, nenhum estado tocado, nenhuma
 * tentativa de outbox reiniciada.
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
function check(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  [OK]    ${msg}`); }
  else { failed++; console.log(`  [FALHA] ${msg}`); }
}

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgresql://postgres:test@localhost:55432/postgres";
const host = new URL(ADMIN_URL).hostname;
if (host !== "localhost" && host !== "127.0.0.1") {
  console.error(`RECUSADO: ${host} não é uma base local descartável.`);
  process.exit(2);
}
const urlDe = (db: string) => { const u = new URL(ADMIN_URL); u.pathname = `/${db}`; return u.toString(); };

async function main() {
  const db = `spharm_reimpressao_${Date.now().toString(36)}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${db}`);
  try {
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(db) }, encoding: "utf8" });
    // `loadOrderDetail`/`loadTransferenciasDetail` chamam `getPrisma()`,
    // que fora de request context cai no cliente legacy construído a
    // partir de `process.env.DATABASE_URL` (ver lib/tenant-registry.ts,
    // `getLegacyClient`). Sem isto, o legacy client fica ligado à base
    // errada (ou nenhuma) e as duas leituras acima falham/lêem dados de
    // outro lado — tem de apontar para a MESMA base descartável criada
    // acima antes de qualquer chamada a essas funções.
    process.env.DATABASE_URL = urlDe(db);

    const { PrismaClient } = await import("../../generated/prisma/client");
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(db) }) });
    const { createEncomendaWithOutbox } = await import("../../lib/ingest/orders");
    const { loadOrderDetail } = await import("../../lib/encomendas/order-detail");
    const { loadTransferenciasDetail } = await import("../../lib/transferencias/transferencia-detail");
    const { buildEncomendaDocumentoReport } = await import("../../lib/reporting/adapters/encomenda-documento");
    const { buildEncomendaConsolidadaDocumentoReport } = await import("../../lib/reporting/adapters/encomenda-consolidada-documento");
    const { buildTransferenciaDocumentoReport } = await import("../../lib/reporting/adapters/transferencia-documento");
    const { buildReportPdfBuffer } = await import("../../lib/reporting/report-pdf-server");

    // ── Dados: 2 encomendas FINALIZADA + 2 transferências FINALIZADA ──────
    const [f1, f2] = await Promise.all([
      prisma.farmacia.create({ data: { nome: "Segurado", morada: "Rua Teste, 1", nif: "123456789", contacto: "210000000" } }),
      prisma.farmacia.create({ data: { nome: "Silveirense" } }),
    ]);
    const u = await prisma.utilizador.create({ data: { email: "u@t.pt", nome: "U", perfil: "ADMINISTRADOR" } });
    const [p1, p2] = await Promise.all([
      prisma.produto.create({ data: { cnp: 8001, designacao: "Produto A" } }),
      prisma.produto.create({ data: { cnp: 8002, designacao: "Produto B" } }),
    ]);

    const r1 = await createEncomendaWithOutbox(prisma, "t", {
      farmaciaId: f1.id, criadoPorId: u.id, nome: "Encomenda teste", finalize: true,
      linhas: [{ produtoId: p1.id, quantidadeAjustada: 10 }, { produtoId: p2.id, quantidadeAjustada: 4 }],
    });
    const r2 = await createEncomendaWithOutbox(prisma, "t", {
      farmaciaId: f2.id, criadoPorId: u.id, nome: "Encomenda teste", finalize: true,
      linhas: [{ produtoId: p1.id, quantidadeAjustada: 20 }],
    });
    const t1 = await prisma.transferencia.create({
      data: { farmaciaOrigemId: f1.id, farmaciaDestinoId: f2.id, criadoPorId: u.id, estado: "FINALIZADA",
        numero: "TR-000101", dataFinalizacao: new Date(),
        linhas: { create: [{ produtoId: p1.id, quantidade: 5 }] } },
    });
    const t2 = await prisma.transferencia.create({
      data: { farmaciaOrigemId: f2.id, farmaciaDestinoId: f1.id, criadoPorId: u.id, estado: "FINALIZADA",
        numero: "TR-000102", dataFinalizacao: new Date(),
        linhas: { create: [{ produtoId: p2.id, quantidade: 3 }] } },
    });
    // ANULADA — para exercitar o selo "ANULADO" (ver secção C abaixo).
    const t3 = await prisma.transferencia.create({
      data: { farmaciaOrigemId: f1.id, farmaciaDestinoId: f2.id, criadoPorId: u.id, estado: "ANULADA",
        numero: "TR-000103", dataFinalizacao: new Date(),
        motivoAnulacao: "Erro de picking", anuladoPorId: u.id, anuladoEm: new Date(),
        linhas: { create: [{ produtoId: p1.id, quantidade: 2 }] } },
    });

    const snapshot = async () => {
      const [listas, linhasEnc, outbox, transferencias, linhasTransf] = await Promise.all([
        prisma.listaEncomenda.findMany({ orderBy: { id: "asc" } }),
        prisma.linhaEncomenda.findMany({ orderBy: { id: "asc" } }),
        prisma.orderOutbox.findMany({ orderBy: { id: "asc" } }),
        prisma.transferencia.findMany({ orderBy: { id: "asc" } }),
        prisma.linhaTransferencia.findMany({ orderBy: { id: "asc" } }),
      ]);
      return JSON.stringify({ listas, linhasEnc, outbox, transferencias, linhasTransf });
    };
    const antes = await snapshot();

    console.log("\nA · reimpressão de encomenda finalizada — documento profissional por fornecedor");
    const d1 = await loadOrderDetail(r1.listaEncomendaId);
    const d2 = await loadOrderDetail(r2.listaEncomendaId);
    check(!!d1 && d1.estado === "FINALIZADA" && !!d2, "A1: as duas encomendas continuam FINALIZADA na base (leitura, não escrita)");
    const separado1 = buildEncomendaDocumentoReport([d1!, d2!]);
    check(separado1.length === 2, "A2: um documento por (encomenda × fornecedor) — aqui 2 encomendas, sem fornecedor decidido em nenhuma linha, dá 2 documentos");
    check(
      separado1.every((r) => r.title.includes("Fornecedor não definido")),
      "A2b: sem fornecedorSugeridoId nas linhas, o título deixa isso explícito — nunca esconde a ausência de decisão"
    );
    check(
      separado1.every((r) => !r.columns.some((c) => c.key === "fabricante" || c.key === "fornecedor" || c.key === "sugerida")),
      "A2c: nenhum documento real traz Fabricante/Fornecedor-por-linha/Qtd.sugerida"
    );
    const pdfSeparado = await buildReportPdfBuffer(separado1[0]);
    check(pdfSeparado.buffer.length > 1000, "A3: novo PDF gerado com sucesso (buffer real, não vazio) — Ponto: «novo PDF de encomenda finalizada»");

    console.log("\nB · a mesma encomenda, mais tarde, escolhida como «consolidado do Grupo» (uso interno)");
    const consolidado = buildEncomendaConsolidadaDocumentoReport([d1!, d2!]);
    check(consolidado.title === "Encomenda Consolidada do Grupo", "B1: modalidade «consolidado» dá um documento diferente do anterior — uso interno, nunca o documento do fornecedor");
    const totalA = consolidado.rows.find((row) => row.cnp === "8001" && row.farmacia?.toString().startsWith("TOTAL"));
    check(totalA?.quantidade === 30, "B2: consolidado agrega 10+20=30 — mesmos dados, escolha diferente");
    check(separado1.length !== 1 || separado1[0].title !== consolidado.title, "B3: «escolher modalidades diferentes em ações sucessivas» produz resultados de facto diferentes, sem reconfigurar nada na base");

    console.log("\nC · reimpressão/PDF/email de transferências finalizadas");
    const [tt1, tt2, tt3] = await loadTransferenciasDetail([t1.id, t2.id, t3.id]);
    check(tt1.estado === "FINALIZADA" && tt2.estado === "FINALIZADA", "C1: as transferências continuam FINALIZADA (nada foi tocado ao gerar o documento anterior)");
    check(tt3.estado === "ANULADA" && tt3.motivoAnulacao === "Erro de picking" && tt3.anuladoPorNome === "U", "C1b: loadTransferenciasDetail traz estado/motivo/quem anulou de uma transferência ANULADA");
    check(tt1.numero === "TR-000101" && tt1.farmaciaOrigemNif === "123456789", "C1c: loadTransferenciasDetail traz número e NIF da farmácia de origem");
    const transfIndividual = buildTransferenciaDocumentoReport([tt1]);
    check(transfIndividual.title === "Guia de Transferência", "C2: documento individual de uma transferência");
    check(transfIndividual.rows.every((row) => !("fabricante" in row)), "C2b: documento de transferência nunca traz a coluna Fabricante");
    check(transfIndividual.meta?.organization === "Segurado", "C2c: cabeçalho identifica a farmácia de origem, não o SaaS");
    check(transfIndividual.meta?.organizationNif === "123456789", "C2d: cabeçalho traz o NIF da farmácia de origem");
    check(!!transfIndividual.filtersApplied?.some((f) => f.label === "Nº Documento" && f.value === "TR-000101"), "C2e: cabeçalho (filtersApplied) mostra o número real gravado na base");
    check(!!transfIndividual.meta?.footer?.includes("Recebido por: ____________________"), "C2f: rodapé traz a linha de assinatura de quem recebe");
    const transfTodas = buildTransferenciaDocumentoReport([tt1, tt2]);
    check(transfTodas.title === "Guias de Transferência" && transfTodas.rows.length >= 2, "C3: documento consolidado (resumo) quando há várias — sempre disponível ao lado do individual, sem escolha exclusiva");
    const pdfTransf = await buildReportPdfBuffer(transfTodas);
    check(pdfTransf.buffer.length > 1000, "C4: PDF de transferências gerado com sucesso");

    console.log("\nC5 · transferência ANULADA — selo no documento reimpresso");
    const transfAnulada = buildTransferenciaDocumentoReport([tt3]);
    check(transfAnulada.meta?.cancelledStamp?.motivo === "Erro de picking", "C5a: reimpressão de uma ANULADA traz o cancelledStamp com o motivo real gravado na base");
    check(transfAnulada.meta?.cancelledStamp?.por === "U", "C5b: cancelledStamp identifica quem anulou (via relação anuladoPor)");
    const pdfAnulada = await buildReportPdfBuffer(transfAnulada);
    check(pdfAnulada.buffer.length > 1000, "C5c: PDF com selo ANULADO gerado com sucesso");

    console.log("\nD · nenhuma acção documental cria registos de negócio nem repete ERP/outbox");
    const depois = await snapshot();
    check(antes === depois, "D1: ListaEncomenda/LinhaEncomenda/OrderOutbox/Transferencia/LinhaTransferencia byte-a-byte iguais antes e depois de TODAS as reimpressões acima");
    const listasFinal = await prisma.listaEncomenda.count();
    const transfFinal = await prisma.transferencia.count();
    check(listasFinal === 2 && transfFinal === 3, "D2: continuam a existir exactamente 2 encomendas e 3 transferências — nenhuma nova");
    const outboxFinal = await prisma.orderOutbox.findMany();
    check(outboxFinal.every((o) => o.attemptCount === 0 && o.state === "PENDENTE"), "D3: outbox nunca reiniciado/reenviado — attemptCount e state intactos (nenhuma exportação ERP repetida)");

    await prisma.$disconnect();
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.end();
  }

  console.log(`\n${passed} ok, ${failed} falhas`);
  // `loadOrderDetail`/`loadTransferenciasDetail` usam getPrisma() internamente
  // (lib/prisma.ts), que cacheia um segundo cliente Prisma nunca desligado
  // por este teste — sem process.exit explícito no sucesso, essa ligação
  // pode impedir o processo de terminar sozinho.
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
