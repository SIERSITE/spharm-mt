/**
 * scripts/diagnostics/perf-manutencao-massa.ts
 *
 * Ensaio de DESEMPENHO da manutenção em massa com ~36 000 produtos, numa base
 * PostgreSQL DESCARTÁVEL (cria e apaga a sua própria base; recusa correr fora de localhost):
 *
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:55494/postgres npx tsx scripts/diagnostics/perf-manutencao-massa.ts
 *
 * Mede, por fase: filtro de divergência de fabricante, resolução dos alvos, preview, apply
 * (total e dentro da transacção), reversão; memória (pico de RSS/heap amostrado) e os planos
 * `EXPLAIN (ANALYZE, BUFFERS)` das consultas relevantes.
 * Não é um teste de pass/fail — imprime números (e falha só se o resultado estiver errado).
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

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgresql://postgres:test@localhost:55494/postgres";
const host = new URL(ADMIN_URL).hostname;
if (host !== "localhost" && host !== "127.0.0.1") {
  console.error(`RECUSADO: ${host} não é uma base local descartável.`);
  process.exit(2);
}
const urlDe = (db: string) => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${db}`;
  return u.toString();
};
const N = Number(process.env.PERF_N ?? 36_000);

let picoRss = 0;
let picoHeap = 0;
const amostrar = setInterval(() => {
  const m = process.memoryUsage();
  picoRss = Math.max(picoRss, m.rss);
  picoHeap = Math.max(picoHeap, m.heapUsed);
}, 50);
const mb = (n: number) => `${(n / 1048576).toFixed(0)} MB`;

async function tempo<T>(rotulo: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  const r = await fn();
  console.log(`  ${rotulo.padEnd(58)} ${String(Date.now() - t0).padStart(7)} ms`);
  return r;
}

async function main() {
  const db = `spharm_perf_${Date.now().toString(36)}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${db}`);
  const pgc = new Client({ connectionString: urlDe(db) });
  try {
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(db) }, encoding: "utf8" });
    await pgc.connect();
    const { PrismaClient } = await import("../../generated/prisma/client");
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(db) }) });
    const M2 = await import("../../lib/catalogo/manutencao-massa");

    const user = await prisma.utilizador.create({ data: { email: "perf@t.pt", nome: "Perf", perfil: "ADMINISTRADOR" } });
    const fA = await prisma.farmacia.create({ data: { nome: "Perf Silveirense" } });
    const fB = await prisma.farmacia.create({ data: { nome: "Perf Segurado" } });
    const fabs = await Promise.all(["Perf Fab A", "Perf Fab B", "Perf Fab Destino"].map((n) => prisma.fabricante.create({ data: { nomeNormalizado: n.toUpperCase(), estado: "ATIVO" } })));
    const forn = await Promise.all(["Perf Forn A", "Perf Forn Destino"].map((n) => prisma.fornecedor.create({ data: { nomeNormalizado: n.toUpperCase(), nome: n, estado: "ATIVO" } })));
    const cat = await prisma.classificacao.create({ data: { nome: "Perf Cat", tipo: "NIVEL_1" } });

    console.log(`\nSementeira: ${N} produtos × 2 farmácias (${2 * N} ProdutoFarmacia), metade com fabricante ERP divergente`);
    const tSeed = Date.now();
    for (let i = 0; i < N; i += 4000) {
      await prisma.produto.createMany({
        data: Array.from({ length: Math.min(4000, N - i) }, (_, k) => ({
          cnp: 8_000_000 + i + k, designacao: `Perf ${i + k}`, estado: "VALIDADO" as const,
          classificacaoNivel1Id: cat.id, tipoArtigo: (i + k) % 2 === 0 ? "MEDICAMENTO" : "PARAFARMACIA", fabricanteId: fabs[(i + k) % 2].id,
        })),
      });
    }
    const ids = (await prisma.produto.findMany({ where: { classificacaoNivel1Id: cat.id }, select: { id: true }, orderBy: { cnp: "asc" } })).map((p) => p.id);
    for (let i = 0; i < ids.length; i += 6000) {
      const parte = ids.slice(i, i + 6000);
      await prisma.produtoFarmacia.createMany({
        data: parte.flatMap((id, k) => {
          const divergente = (i + k) % 2 === 0;
          return [
            { produtoId: id, farmaciaId: fA.id, fabricanteErpAtual: "ERP-A", fornecedorHabitualId: forn[0].id },
            { produtoId: id, farmaciaId: fB.id, fabricanteErpAtual: divergente ? "ERP-B" : "ERP-A", fornecedorHabitualId: forn[0].id },
          ];
        }),
      });
    }
    await pgc.query('ANALYZE "Produto"');
    await pgc.query('ANALYZE "ProdutoFarmacia"');
    console.log(`  semente em ${Date.now() - tSeed} ms`);

    const filtroDiv = { categorias: [cat.nome], fabricanteDivergente: true };
    const filtroTodos = { categorias: [cat.nome] };
    const destinoF = { modo: "existente" as const, id: fabs[2].id };
    const destinoP = { modo: "existente" as const, id: forn[1].id };
    const base = process.memoryUsage();
    console.log(`  memória antes: rss ${mb(base.rss)}, heap ${mb(base.heapUsed)}`);

    console.log("\nA · FABRICANTE com filtro «fabricante divergente» (metade do catálogo)");
    const div = await tempo("consulta de divergência (resolverProdutosComFabricanteDivergente)", () => M2.resolverProdutosComFabricanteDivergente(prisma));
    console.log(`  → ${div.size} produtos divergentes`);
    await tempo("listar página (contagem exacta + 50 itens)", () => M2.listarProdutosPagina(prisma, "FABRICANTE", filtroDiv, { page: 1, pageSize: 50 }));
    const alvosA = await tempo("resolverAlvos (todos os que o filtro devolve)", () => M2.resolverAlvos(prisma, "FABRICANTE", filtroDiv));
    const pvA = await tempo("preview completo (alvos + hash + agrupamentos + amostra)", () => M2.previewOperacao(prisma, "FABRICANTE", filtroDiv, destinoF, { modo: "todos" }));
    if (!pvA.ok || pvA.totalCount !== alvosA.length) throw new Error("preview A inválido");
    const rA = await tempo("APPLY completo", () => M2.aplicarManutencaoMassa(prisma, { tipo: "FABRICANTE", filtro: filtroDiv, destino: destinoF, selecao: { modo: "todos" }, snapshotHash: pvA.snapshotHash, utilizadorId: user.id }));
    if (!rA.ok) throw new Error(`apply A: ${JSON.stringify(rA)}`);
    const temposA = (rA as { tempos?: Record<string, number> }).tempos;
    if (temposA) console.log(`  tempos internos: ${JSON.stringify(temposA)}`);
    await tempo("REVERSÃO", async () => { const r = await M2.reverterOperacao(prisma, rA.operacaoId, user.id); if (!r.ok) throw new Error("rev A"); });

    console.log("\nB · FABRICANTE, 36 000 produtos (sem filtro de divergência)");
    const pvB = await tempo("preview completo", () => M2.previewOperacao(prisma, "FABRICANTE", filtroTodos, destinoF, { modo: "todos" }));
    if (!pvB.ok) throw new Error("preview B");
    const rB = await tempo("APPLY completo", () => M2.aplicarManutencaoMassa(prisma, { tipo: "FABRICANTE", filtro: filtroTodos, destino: destinoF, selecao: { modo: "todos" }, snapshotHash: pvB.snapshotHash, utilizadorId: user.id }));
    if (!rB.ok || rB.quantidadeAlterada !== N) throw new Error(`apply B: ${JSON.stringify(rB).slice(0, 200)}`);
    const temposB = (rB as { tempos?: Record<string, number> }).tempos;
    if (temposB) console.log(`  tempos internos: ${JSON.stringify(temposB)}`);
    await tempo("REVERSÃO", async () => { const r = await M2.reverterOperacao(prisma, rB.operacaoId, user.id); if (!r.ok) throw new Error("rev B"); });

    console.log("\nC · FORNECEDOR, 2 farmácias × 36 000 = 72 000 pares");
    const filtroC = { categorias: [cat.nome], farmaciaIds: [fA.id, fB.id] };
    const pvC = await tempo("preview completo", () => M2.previewOperacao(prisma, "FORNECEDOR", filtroC, destinoP, { modo: "todos" }));
    if (!pvC.ok) throw new Error("preview C");
    const rC = await tempo("APPLY completo", () => M2.aplicarManutencaoMassa(prisma, { tipo: "FORNECEDOR", filtro: filtroC, destino: destinoP, selecao: { modo: "todos" }, snapshotHash: pvC.snapshotHash, utilizadorId: user.id }));
    if (!rC.ok || rC.quantidadeAlterada !== 2 * N) throw new Error(`apply C: ${JSON.stringify(rC).slice(0, 200)}`);
    const temposC = (rC as { tempos?: Record<string, number> }).tempos;
    if (temposC) console.log(`  tempos internos: ${JSON.stringify(temposC)}`);
    await tempo("REVERSÃO (duas operações, uma por farmácia)", async () => {
      for (const o of rC.operacoes) { const r = await M2.reverterOperacao(prisma, o.operacaoId, user.id); if (!r.ok) throw new Error("rev C"); }
    });

    console.log(`\nMemória: pico rss ${mb(picoRss)} (antes ${mb(base.rss)}), pico heap ${mb(picoHeap)} (antes ${mb(base.heapUsed)})`);

    if (process.env.PERF_EXPLAIN !== "0") {
      console.log("\n── EXPLAIN (ANALYZE, BUFFERS) — as MESMAS instruções que o código usa; cada escrita dentro de BEGIN/ROLLBACK ──");
      const explain = async (rotulo: string, sql: string, params: unknown[] = [], escreve = false) => {
        console.log(`\n-- ${rotulo}`);
        if (escreve) await pgc.query("BEGIN");
        const r = await pgc.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params);
        if (escreve) await pgc.query("ROLLBACK");
        console.log(r.rows.map((x: Record<string, string>) => x["QUERY PLAN"]).join("\n"));
      };
      await explain("divergência de fabricante (agregação no PostgreSQL, sem candidatos)", `SELECT "produtoId" FROM "ProdutoFarmacia" WHERE "fabricanteErpAtual" IS NOT NULL AND "fabricanteErpAtual" <> '' GROUP BY "produtoId" HAVING COUNT(DISTINCT "fabricanteErpAtual") > 1`);
      await explain("divergência de fabricante (só para os candidatos)", `SELECT "produtoId" FROM "ProdutoFarmacia" WHERE "produtoId" = ANY($1::text[]) AND "fabricanteErpAtual" IS NOT NULL AND "fabricanteErpAtual" <> '' GROUP BY "produtoId" HAVING COUNT(DISTINCT "fabricanteErpAtual") > 1`, [ids]);
      await explain("UPDATE set-based de Produto (compare-and-set no WHERE)", `UPDATE "Produto" SET "fabricanteId" = $2, "dataAtualizacao" = (now() AT TIME ZONE 'UTC') WHERE id = ANY($1::text[]) AND "fabricanteId" IS NOT DISTINCT FROM $3::text`, [ids, fabs[2].id, fabs[0].id], true);
      await explain("UPDATE set-based de ProdutoFarmacia (compare-and-set no WHERE)", `UPDATE "ProdutoFarmacia" SET "fornecedorHabitualId" = $3 WHERE "farmaciaId" = $1::text AND "produtoId" = ANY($2::text[]) AND "fornecedorHabitualId" IS NOT DISTINCT FROM $4::text`, [fA.id, ids, forn[1].id, forn[0].id], true);
      const op = await prisma.catalogoManutencaoOperacao.create({ data: { tipo: "FABRICANTE", utilizadorId: user.id, filtrosJson: "{}", valorNovoId: fabs[2].id, quantidadeSolicitada: 0, quantidadeAlterada: 0, quantidadeIgnorada: 0 } });
      await explain("INSERT … SELECT FROM unnest (itens de auditoria)", `INSERT INTO "CatalogoManutencaoOperacaoItem" (id, "operacaoId", "produtoId", "valorAnteriorId", "valorNovoId") SELECT gen_random_uuid()::text, $1::text, t.pid, t.ant, t.novo FROM unnest($2::text[], $3::text[], $4::text[]) AS t(pid, ant, novo)`, [op.id, ids, ids.map(() => fabs[0].id), ids.map(() => fabs[2].id)], true);
    }

    await prisma.$disconnect();
  } finally {
    clearInterval(amostrar);
    await pgc.end().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
