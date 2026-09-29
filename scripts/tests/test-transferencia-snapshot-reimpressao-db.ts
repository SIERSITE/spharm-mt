/**
 * scripts/tests/test-transferencia-snapshot-reimpressao-db.ts
 *
 * PostgreSQL REAL e DESCARTÁVEL. Prova o ponto 18 do pedido — "reimpressão
 * preserva o snapshot original": cria uma Transferencia FINALIZADA,
 * RENOMEIA o produto ao vivo (`Produto.designacao`) depois, e confirma
 * que uma reimpressão do documento (via `loadTransferenciaDetail` →
 * `buildTransferenciaDocumentoReport` → PDF real, extraído por texto)
 * continua a mostrar o nome ORIGINAL (`LinhaTransferencia.designacaoSnapshot`),
 * nunca o nome novo.
 *
 *   docker run -d --name spharm-snapshot-test-pg -e POSTGRES_PASSWORD=test -p 55441:5432 postgres:16-alpine
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:55441/postgres npx tsx scripts/tests/test-transferencia-snapshot-reimpressao-db.ts
 *
 * Guarda de segurança: recusa correr se o host não for localhost/127.0.0.1.
 * Cria uma base temporária e apaga-a no fim.
 */
import Module from "node:module";
import { execSync } from "node:child_process";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PDFParse } from "pdf-parse";

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

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgresql://postgres:test@localhost:55441/postgres";
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
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  await parser.destroy?.();
  return result.text;
}

async function main() {
  const sufixo = Date.now().toString(36);
  const dbNome = `spharm_snapshot_${sufixo}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbNome}`);

  try {
    const out = execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(dbNome) }, encoding: "utf8" });
    check(/successfully applied|No pending migrations/i.test(out), "A1: migrations aplicadas sem erro numa base vazia");

    process.env.DATABASE_URL = urlDe(dbNome);

    const { PrismaClient } = await import("../../generated/prisma/client");
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(dbNome) }) });
    const { criarTransferenciaComLinhas } = await import("../../lib/transferencias/criar-transferencia");
    const { loadTransferenciaDetail } = await import("../../lib/transferencias/transferencia-detail");
    const { buildTransferenciaDocumentoReport } = await import("../../lib/reporting/adapters/transferencia-documento");
    const { buildReportPdfBuffer } = await import("../../lib/reporting/report-pdf-server");

    const origem = await prisma.farmacia.create({ data: { nome: "Farmácia Origem" } });
    const destino = await prisma.farmacia.create({ data: { nome: "Farmácia Destino" } });
    const utilizador = await prisma.utilizador.create({ data: { email: "u@snap.pt", nome: "U", perfil: "ADMINISTRADOR" } });
    const produto = await prisma.produto.create({
      data: { cnp: 7778888, designacao: "Nome Original Ao Momento Da Transferência" },
    });

    console.log("\nB · cria transferência FINALIZADA (snapshot capturado)");
    const { transferenciaId } = await criarTransferenciaComLinhas(prisma, {
      farmaciaOrigemId: origem.id,
      farmaciaDestinoId: destino.id,
      criadoPorId: utilizador.id,
      finalize: true,
      linhas: [{ produtoId: produto.id, quantidade: 6 }],
    });
    const linhaDb1 = await prisma.linhaTransferencia.findFirstOrThrow({ where: { transferenciaId } });
    check(linhaDb1.designacaoSnapshot === "Nome Original Ao Momento Da Transferência", "B1: designacaoSnapshot real capturado na criação");

    console.log("\nC · produto é renomeado DEPOIS da transferência já finalizada");
    await prisma.produto.update({ where: { id: produto.id }, data: { designacao: "Nome Totalmente Diferente Depois" } });
    const produtoDb = await prisma.produto.findUniqueOrThrow({ where: { id: produto.id } });
    check(produtoDb.designacao === "Nome Totalmente Diferente Depois", "C1: Produto.designacao real já mudou");

    console.log("\nD · reimpressão usa o SNAPSHOT, nunca a designação ao vivo — em texto E no PDF real");
    const detalhe = await loadTransferenciaDetail(transferenciaId);
    check(detalhe?.linhas[0]?.designacao === "Nome Original Ao Momento Da Transferência", "D1: loadTransferenciaDetail devolve o nome ORIGINAL (snapshot), não o novo");
    check(detalhe?.linhas[0]?.designacao !== "Nome Totalmente Diferente Depois", "D2: nunca devolve o nome novo");

    const report = buildTransferenciaDocumentoReport([detalhe!]);
    const texto = await extrairTexto((await buildReportPdfBuffer(report)).buffer);
    check(texto.includes("Nome Original Ao Momento Da Transferência"), "D3: PDF real reimpresso mostra o nome ORIGINAL");
    check(!texto.includes("Nome Totalmente Diferente Depois"), "D4: PDF real reimpresso NUNCA mostra o nome novo — reimpressão é idêntica ao documento original");

    await prisma.$disconnect();
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${dbNome} WITH (FORCE)`);
    await admin.end();
  }

  console.log(`\n${passed} ok, ${failed} falhas`);
  // `loadTransferenciaDetail` usa getPrisma() internamente (lib/prisma.ts),
  // que cacheia um segundo cliente Prisma ligado a DATABASE_URL — nunca
  // desligado por este teste. Sem um `process.exit` explícito no caminho
  // de sucesso, essa ligação aberta impede o processo de terminar
  // sozinho mesmo depois de "X ok, Y falhas" já ter sido impresso.
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
