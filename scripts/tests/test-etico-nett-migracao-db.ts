/**
 * scripts/tests/test-etico-nett-migracao-db.ts
 *
 * A migration `produto_farmacia_etico_nett` sobre o schema ANTERIOR, numa base PostgreSQL DESCARTÁVEL:
 *
 *   1 · aplica todas as migrations menos a nova (estado «antes do deploy») e semeia dados antigos;
 *   2 · aplica o deploy normal: só a nova migration corre; os dados antigos ficam IGUAIS (coluna a coluna);
 *   3 · reexecuta o deploy: sem migrations pendentes, nada muda (idempotente);
 *   4 · é aditiva (só CREATE TYPE / ADD COLUMN / CREATE INDEX — nenhum DROP/UPDATE/DELETE/ALTER de coluna existente);
 *   5 · o servidor NOVO com dados antigos: rev98 não perde nada; rev99 grava; um rev98 posterior não apaga o que a rev99 gravou.
 *
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/tests/test-etico-nett-migracao-db.ts
 */
import Module from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

const estado: { prisma: unknown } = { prisma: null };
const M = Module as unknown as { _resolveFilename: (r: string, ...a: unknown[]) => string; _load: (r: string, ...a: unknown[]) => unknown };
const resolverOriginal = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "server-only" ? __filename : resolverOriginal.call(this, request, ...rest);
};
const loadOriginal = M._load;
M._load = function (request: string, ...rest: unknown[]) {
  if (request === "@/lib/integracao/auth") {
    return {
      withIntegrationAuth: (handler: (ctx: unknown, req: unknown) => Promise<Response>) => async (req: unknown) =>
        handler({ prisma: estado.prisma, tenant: { slug: "garantia" } }, req),
    };
  }
  return loadOriginal.call(this, request, ...rest);
};

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const secao = (t: string) => console.log(`\n── ${t}`);

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgresql://postgres:test@localhost:15433/postgres";
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
const raiz = path.resolve(__dirname, "../..");
const MIGRACAO = "20261103100000_produto_farmacia_etico_nett";
const NOVAS = ["eticoNett", "eticoNettCodigoErp", "eticoNettDescricaoErp", "eticoNettObservadoEm", "eticoNettManual"];

function deploy(url: string, config?: string): { status: number; out: string } {
  const args = ["prisma", "migrate", "deploy", ...(config ? ["--config", config] : [])];
  const r = spawnSync("npx", args, { cwd: raiz, encoding: "utf8", shell: process.platform === "win32", env: { ...process.env, DATABASE_URL: url } });
  return { status: r.status ?? 1, out: `${r.stdout}\n${r.stderr}` };
}

async function main() {
  // ── migration aditiva (estático) ──
  secao("A · a migration é aditiva");
  const sql = fs.readFileSync(path.join(raiz, "prisma/migrations", MIGRACAO, "migration.sql"), "utf8");
  const instrucoes = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(";").map((s) => s.trim()).filter(Boolean);
  check(instrucoes.length === 3, `3 instruções (CREATE TYPE, ALTER TABLE ADD COLUMN, CREATE INDEX) — ${instrucoes.length}`);
  const corpo = instrucoes.join(";\n"); // sem os comentários (que mencionam DROP no rollback)
  check(!/\b(DROP|UPDATE|DELETE|TRUNCATE|RENAME)\b/i.test(corpo) && !/ALTER COLUMN|SET NOT NULL|SET DATA TYPE/i.test(corpo), "nenhum DROP/UPDATE/DELETE/RENAME nem ALTER COLUMN");
  check(/ADD COLUMN "eticoNettManual" BOOLEAN NOT NULL DEFAULT false/.test(sql), "a única coluna NOT NULL tem DEFAULT (linhas antigas ficam válidas)");

  const suf = Date.now().toString(36);
  const db = `spharm_en_mig_${suf}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${db}`);
  const tmpMig = fs.mkdtempSync(path.join(os.tmpdir(), "mig-antes-"));
  const cfgAntes = path.join(raiz, `prisma-antes-${suf}.config.ts`);
  try {
    // ── estado ANTES: todas as migrations menos a nova ──
    for (const d of fs.readdirSync(path.join(raiz, "prisma/migrations"))) {
      if (d === MIGRACAO) continue;
      fs.cpSync(path.join(raiz, "prisma/migrations", d), path.join(tmpMig, d), { recursive: true });
    }
    fs.writeFileSync(
      cfgAntes,
      `import { defineConfig } from "prisma/config";\nexport default defineConfig({ schema: "prisma/schema.prisma", migrations: { path: ${JSON.stringify(tmpMig)} }, datasource: { url: process.env.DATABASE_URL! } });\n`,
    );
    const antes = deploy(urlDe(db), path.basename(cfgAntes));
    check(antes.status === 0, "schema ANTERIOR aplicado (todas as migrations menos a nova)", antes.out.slice(-300));

    const c = new Client({ connectionString: urlDe(db) });
    await c.connect();
    const cols = (await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name='ProdutoFarmacia'`)).rows.map((r) => r.column_name as string);
    check(NOVAS.every((n) => !cols.includes(n)), "pré-condição: as colunas novas ainda não existem");

    secao("B · dados antigos sobrevivem ao deploy");
    await c.query(`INSERT INTO "Farmacia"(id, nome, "dataAtualizacao") VALUES ('f-old-1','Farmácia Antiga', now())`).catch(async () => {
      await c.query(`INSERT INTO "Farmacia"(id, nome) VALUES ('f-old-1','Farmácia Antiga')`);
    });
    for (let i = 1; i <= 25; i++) {
      await c.query(`INSERT INTO "Produto"(id, cnp, designacao, "dataAtualizacao") VALUES ($1,$2,$3, now())`, [`p-old-${i}`, 6_000_000 + i, `ANTIGO ${i}`]);
      await c.query(
        `INSERT INTO "ProdutoFarmacia"(id, "produtoId", "farmaciaId", pvp, pmc, puc, "stockAtual", "flagRetirado", "taxaIvaPercent", "dataAtualizacao") VALUES ($1,$2,'f-old-1',$3,2,1,$4,$5,23, now())`,
        [`pf-old-${i}`, `p-old-${i}`, 10 + i, i * 3, i % 5 === 0],
      );
    }
    const instantaneo = async () => (await c.query(`SELECT to_jsonb(pf) AS j FROM "ProdutoFarmacia" pf ORDER BY id`)).rows.map((r) => r.j as Record<string, unknown>);
    const antesLinhas = await instantaneo();
    const nProdutos = Number((await c.query(`SELECT count(*) AS n FROM "Produto"`)).rows[0].n);
    check(antesLinhas.length === 25, "25 linhas antigas de ProdutoFarmacia semeadas");
    await c.end();

    const novo = deploy(urlDe(db));
    check(novo.status === 0 && new RegExp(MIGRACAO).test(novo.out), "deploy normal aplica a nova migration", novo.out.slice(-400));

    const c2 = new Client({ connectionString: urlDe(db) });
    await c2.connect();
    const depois = (await c2.query(`SELECT to_jsonb(pf) AS j FROM "ProdutoFarmacia" pf ORDER BY id`)).rows.map((r) => r.j as Record<string, unknown>);
    const semNovas = depois.map((j) => Object.fromEntries(Object.entries(j).filter(([k]) => !NOVAS.includes(k))));
    check(JSON.stringify(semNovas) === JSON.stringify(antesLinhas), "as 25 linhas antigas ficam IDÊNTICAS em todas as colunas pré-existentes");
    check(depois.every((j) => j.eticoNett === null && j.eticoNettManual === false && j.eticoNettCodigoErp === null && j.eticoNettObservadoEm === null), "…e as colunas novas ficam NULL / false");
    check(Number((await c2.query(`SELECT count(*) AS n FROM "Produto"`)).rows[0].n) === nProdutos, "nenhum Produto criado ou removido");
    const aplicadas = Number((await c2.query(`SELECT count(*) AS n FROM _prisma_migrations WHERE migration_name = $1 AND finished_at IS NOT NULL`, [MIGRACAO])).rows[0].n);
    check(aplicadas === 1, "a migration regista-se uma vez");

    secao("C · reexecutar o deploy");
    const outra = deploy(urlDe(db));
    check(outra.status === 0 && /No pending migrations/i.test(outra.out), "segundo deploy: «No pending migrations»", outra.out.slice(-300));
    const depois2 = (await c2.query(`SELECT to_jsonb(pf) AS j FROM "ProdutoFarmacia" pf ORDER BY id`)).rows.map((r) => r.j);
    check(JSON.stringify(depois2) === JSON.stringify(depois), "…e os dados ficam iguais");
    await c2.end();

    secao("D · servidor NOVO com dados antigos: rev98 → rev99 → rev98");
    process.env.DATABASE_URL = urlDe(db);
    process.env.ALLOW_LEGACY_DATABASE_FALLBACK = "1";
    process.env.ENABLE_AGENT_BOOTSTRAP = "1";
    const { PrismaClient } = await import("../../generated/prisma/client");
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(db) }) });
    estado.prisma = prisma;
    const { POST } = await import("../../app/api/ingest/v1/bootstrap/products/route");
    const item = (i: number, extra: Record<string, unknown> = {}) => ({
      externalProductId: i, cnp: 6_000_000 + i, designacao: `ANTIGO ${i}`, pvp: 10 + i, pmc: 2, puc: 1, dataUltimaVenda: null, dataUltimaCompra: null,
      retirado: i % 5 === 0, generico: false, mnsrmNCompart: false, fornecedorHabitualId: null, fornecedorHabitualNome: null, taxaIva: null,
      dci: null, codigoATC: null, grupoHomogeneo: null, fabricante: null, ...extra,
    });
    const post = async (items: unknown[]) => {
      const req = new Request("http://localhost/api/ingest/v1/bootstrap/products", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ farmaciaId: "f-old-1", items }) });
      const res = await (POST as unknown as (r: Request) => Promise<Response>)(req);
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const snap = async () => JSON.stringify(await prisma.$queryRawUnsafe(`SELECT "produtoId","eticoNett","eticoNettCodigoErp","eticoNettManual" FROM "ProdutoFarmacia" ORDER BY id`));
    const antesRev98 = await snap();
    const r98 = await post([item(1), item(2), item(3)]);
    check(r98.status === 200 && !("eticoNett" in r98.body) && (await snap()) === antesRev98, "rev98 (sem campos) no servidor novo: 200, resposta de sempre, dados iguais");
    const r99 = await post([item(1, { eticoNett: "ETICO", eticoNettCodigo: 1, eticoNettDescricao: "Éticos" }), item(2, { eticoNett: "NETT", eticoNettCodigo: 2, eticoNettDescricao: "NETT" })]);
    check(r99.status === 200 && (r99.body.eticoNett as Record<string, number>).aplicados === 2, "rev99 aceite: 2 classificações gravadas");
    const depois99 = await snap();
    const r98b = await post([item(1, { pvp: 99 }), item(2, { pvp: 98 }), item(3)]);
    const rows = await prisma.produtoFarmacia.findMany({ where: { produtoId: { in: ["p-old-1", "p-old-2"] } }, orderBy: { id: "asc" } });
    check(r98b.status === 200 && rows[0].eticoNett === "ETICO" && rows[1].eticoNett === "NETT" && Number(rows[0].pvp) === 99, "um rev98 posterior atualiza o preço e NÃO apaga o que a rev99 gravou");
    check(JSON.stringify(await prisma.$queryRawUnsafe(`SELECT "produtoId","eticoNett","eticoNettCodigoErp","eticoNettManual" FROM "ProdutoFarmacia" ORDER BY id`)) === depois99, "…o resto da classificação fica igual");
    await prisma.$disconnect();
  } finally {
    fs.rmSync(cfgAntes, { force: true });
    fs.rmSync(tmpMig, { recursive: true, force: true });
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.end();
  }
  console.log(`\n${ok} OK, ${ko} FALHA(S)`);
  process.exit(ko === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
