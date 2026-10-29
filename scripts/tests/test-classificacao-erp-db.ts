/**
 * scripts/tests/test-classificacao-erp-db.ts
 *
 * PostgreSQL REAL e DESCARTÁVEL (recusa correr fora de localhost):
 *
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres \
 *     npx tsx scripts/tests/test-classificacao-erp-db.ts
 *
 * Genérico TRI-ESTADO do ERP (PROVISÓRIO, pendente de auditoria real) —
 * lib/ingest/classificacao-erp.ts + migration 20261028120000 (UMA coluna).
 * Ético / NETT / Serviço NÃO existem no modelo (não provados).
 *
 * Reproduz a sequência do endpoint /api/ingest/v1/bootstrap/products com as
 * MESMAS funções (resolverModoDesignacao → upsertProdutosComDesignacao →
 * lerClassificacaoErpDoPayload/aplicarClassificacaoErp, chave `generico`).
 * Dois tenants simulados em duas bases (silveira: designação autoritativa /
 * SO_CRIACAO; garantia: LEGACY) criadas por CREATE DATABASE … TEMPLATE da
 * base migrada. Só dados sintéticos.
 */
import Module from "node:module";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgresql://postgres:test@localhost:15433/postgres";
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

const MIGRATION = "prisma/migrations/20261028120000_produto_classificacao_erp/migration.sql";

async function main() {
  const sufixo = Date.now().toString(36);
  const dbBase = `spharm_cls_base_${sufixo}`;
  const dbSilv = `spharm_cls_silv_${sufixo}`;
  const dbGar = `spharm_cls_gar_${sufixo}`;
  const dbPre = `spharm_cls_pre_${sufixo}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbBase}`);

  try {
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(dbBase) }, encoding: "utf8" });
    await admin.query(`CREATE DATABASE ${dbSilv} TEMPLATE ${dbBase}`);
    await admin.query(`CREATE DATABASE ${dbGar} TEMPLATE ${dbBase}`);
    await admin.query(`CREATE DATABASE ${dbPre} TEMPLATE ${dbBase}`);

    const { PrismaClient } = await import("../../generated/prisma/client");
    const C = await import("../../lib/ingest/classificacao-erp");
    const D = await import("../../lib/ingest/designacao-silveira");
    const F = await import("../../lib/catalogo/classificacao-erp");

    // ═══ P · lerClassificacaoErpDoPayload (puro) ══════════════════════════
    console.log("\n=== P. Leitura do payload: significado exato dos valores ===");
    {
      const l = C.lerClassificacaoErpDoPayload;
      const g = (v: unknown) => l({ cnp: 1, generico: v });
      check(!("genericoErp" in l({ cnp: 1 })), "chave ausente: não toca (sem campo)");
      check(!("genericoErp" in l({ cnp: 1, generico: undefined })), "undefined = ausente");
      check(g(true).genericoErp === true && g(1).genericoErp === true && g("1").genericoErp === true && g("TRUE").genericoErp === true, "true / 1 / '1' / 'true' = genérico");
      check(g(false).genericoErp === false && g(0).genericoErp === false && g("0").genericoErp === false && g("False").genericoErp === false, "false / 0 / '0' / 'false' = NÃO genérico");
      check(g(null).genericoErp === null && g("").genericoErp === null && g("  ").genericoErp === null, "null / vazio = desconhecido → NULL (nunca false)");
      check(g(null).desconhecidos === 0 && g("").desconhecidos === 0, "null/vazio não contam como código desconhecido");
      check(g(2).genericoErp === null && g(2).desconhecidos === 1 && g("S").genericoErp === null && g("S").desconhecidos === 1 && g({}).genericoErp === null, "código desconhecido (2, 'S', objeto) → NULL + contado");
      check(!("etico" in g(true)) && !("nett" in g(true)) && !("servico" in g(true)), "nenhum campo Ético/NETT/Serviço no modelo");
      const o = l({ cnp: 1, etico: true, nett: false, servico: true });
      check(!("genericoErp" in o), "chaves etico/nett/servico são ignoradas pelo servidor (modelo não fixado)");
    }

    /** Cria o ambiente de um tenant simulado. */
    async function ambiente(db: string, slug: "silveira" | "garantia") {
      process.env.DATABASE_URL = urlDe(db);
      const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(db) }) });
      const farmA = await prisma.farmacia.create({ data: { nome: `Farmácia A ${slug}` } });
      const farmB = await prisma.farmacia.create({ data: { nome: `Farmácia B ${slug}` } });
      const ENV = { [D.ENV_FARMACIA_ID_DESIGNACAO]: farmA.id };
      let proximo = slug === "silveira" ? 9_300_000 : 9_400_000;
      const novoCnp = () => ++proximo;

      type Item = Record<string, unknown> & { cnp: number; designacao: string };
      /** Mesmo passo a passo do endpoint (bulk), devolvendo o resumo da classificação. */
      async function ingerir(farmacia: { id: string }, items: Item[]) {
        const { modo } = await D.resolverModoDesignacao(prisma, slug, farmacia.id, ENV);
        const up = await D.upsertProdutosComDesignacao(
          prisma,
          modo,
          items.map((i) => ({ cnp: i.cnp, externalProductId: null, designacao: i.designacao, flagGenerico: i.generico === true, flagMnsrmNCompart: false })),
        );
        const linhas = items.flatMap((i) => {
          const produtoId = up.cnpToId.get(i.cnp);
          return produtoId ? [{ produtoId, item: C.lerClassificacaoErpDoPayload(i) }] : [];
        });
        const resumo = await C.aplicarClassificacaoErp(prisma, linhas);
        return { modo, resumo, cnpToId: up.cnpToId };
      }
      const ler = (cnp: number) =>
        prisma.produto.findUniqueOrThrow({
          where: { cnp },
          select: { designacao: true, fabricanteId: true, flagGenerico: true, flagMSRM: true, flagMNSRM: true, dci: true, codigoATC: true, genericoErp: true, camposManuais: true },
        });
      const xmin = async (cnp: number) => (await prisma.$queryRaw<Array<{ x: string }>>`SELECT xmin::text AS x FROM "Produto" WHERE cnp = ${cnp}`)[0]!.x;
      const dataAtualizacao = async (cnp: number) =>
        (await prisma.$queryRaw<Array<{ d: Date }>>`SELECT "dataAtualizacao" AS d FROM "Produto" WHERE cnp = ${cnp}`)[0]!.d.getTime();
      return { prisma, farmA, farmB, novoCnp, ingerir, ler, xmin, dataAtualizacao };
    }

    async function suite(nome: string, slug: "silveira" | "garantia", db: string) {
      console.log(`\n##### Tenant ${nome} (${slug}) #####`);
      const { prisma, farmA, farmB, novoCnp, ingerir, ler, xmin, dataAtualizacao } = await ambiente(db, slug);

      // 1 · produto novo ------------------------------------------------
      console.log("\n--- 1. Produto novo: genérico / não genérico / desconhecido ---");
      const c1 = novoCnp(), c1f = novoCnp(), c1n = novoCnp();
      {
        const r = await ingerir(farmA, [
          { cnp: c1, designacao: "GENERICO UM", generico: true },
          { cnp: c1f, designacao: "NAO GENERICO", generico: false },
          { cnp: c1n, designacao: "DESCONHECIDO", generico: null },
        ]);
        const p = await ler(c1), pf = await ler(c1f), pn = await ler(c1n);
        check(p.genericoErp === true && pf.genericoErp === false, "1 → true; 0/false → false");
        check(pn.genericoErp === null, "NULL do ERP → NULL (desconhecido), NUNCA false");
        check(pn.flagGenerico === false && p.flagGenerico === true, "flagGenerico mantém a semântica anterior (null → false)");
        check(r.resumo.candidatos === 3 && r.resumo.alterados === 2, "resumo: 3 candidatos, 2 alterados (null→null não escreve)");
      }

      // 2 · existente sem classificação / mudança -----------------------
      console.log("\n--- 2. Existente (agent sem a chave) e mudança ---");
      const c2 = novoCnp();
      {
        await ingerir(farmA, [{ cnp: c2, designacao: "PRODUTO DOIS" }]);
        const antes = await ler(c2);
        check(antes.genericoErp === null && antes.flagGenerico === false, "agent sem a chave: genericoErp NULL, flagGenerico false (como sempre)");
        const r1 = await ingerir(farmA, [{ cnp: c2, designacao: "PRODUTO DOIS", generico: true }]);
        check((await ler(c2)).genericoErp === true && r1.resumo.alterados === 1, "agent com a chave preenche o existente");
        const r2 = await ingerir(farmA, [{ cnp: c2, designacao: "PRODUTO DOIS", generico: false }]);
        check((await ler(c2)).genericoErp === false && r2.resumo.alterados === 1, "true → false atualiza (false explícito)");
        const r3 = await ingerir(farmA, [{ cnp: c2, designacao: "PRODUTO DOIS", generico: null }]);
        check((await ler(c2)).genericoErp === null && r3.resumo.alterados === 1, "false → null explícito: volta a desconhecido (corrige mapeamento errado)");
      }

      // 3 · código desconhecido -----------------------------------------
      console.log("\n--- 3. Código desconhecido → NULL + contador; lote não falha ---");
      {
        const a = novoCnp(), b = novoCnp();
        const r = await ingerir(farmA, [
          { cnp: a, designacao: "TRES A", generico: "S" },
          { cnp: b, designacao: "TRES B", generico: true },
        ]);
        check((await ler(a)).genericoErp === null && (await ler(b)).genericoErp === true, "'S' → NULL; o outro produto do lote é gravado");
        check(r.resumo.valoresDesconhecidos === 1, "contador valoresDesconhecidos=1");
      }

      // 4 · agent antigo não apaga --------------------------------------
      console.log("\n--- 4. Agent antigo (sem a chave) não toca nem apaga ---");
      {
        const antes = await ler(c1);
        const r = await ingerir(farmA, [{ cnp: c1, designacao: "GENERICO UM" }]);
        const depois = await ler(c1);
        check(r.resumo.candidatos === 0 && r.resumo.alterados === 0, "0 candidatos, 0 alterados");
        check(depois.genericoErp === antes.genericoErp && depois.genericoErp === true, "valor mantido (ausente ≠ false)");
      }

      // 5 · idempotência (sem escritas) ---------------------------------
      console.log("\n--- 5. Idempotência: reenviar o mesmo lote não escreve nada ---");
      {
        const c = novoCnp();
        const r1 = await ingerir(farmA, [{ cnp: c, designacao: "CINCO", generico: false }]);
        const id = r1.cnpToId.get(c)!;
        const linhas = [{ produtoId: id, item: C.lerClassificacaoErpDoPayload({ generico: false }) }];
        const x1 = await xmin(c);
        const r2 = await C.aplicarClassificacaoErp(prisma, linhas);
        const r3 = await C.aplicarClassificacaoErp(prisma, linhas);
        check(r1.resumo.alterados === 1 && r2.alterados === 0 && r3.alterados === 0, "1.º envio altera; 2.º e 3.º: alterados=0");
        check((await xmin(c)) === x1, "linha NÃO reescrita (xmin igual)");
        const un = [{ produtoId: id, item: C.lerClassificacaoErpDoPayload({ generico: null }) }];
        await C.aplicarClassificacaoErp(prisma, un);
        const x2 = await xmin(c);
        const r4 = await C.aplicarClassificacaoErp(prisma, un);
        check(r4.alterados === 0 && (await xmin(c)) === x2, "NULL → NULL também não escreve (IS DISTINCT FROM trata NULL)");
      }

      // 6 · retry / lote parcial ----------------------------------------
      console.log("\n--- 6. Retry, lote parcial, duplicados ---");
      {
        const a = novoCnp(), b = novoCnp();
        const r0 = await ingerir(farmA, [{ cnp: a, designacao: "SEIS A" }, { cnp: b, designacao: "SEIS B" }]);
        const ida = r0.cnpToId.get(a)!, idb = r0.cnpToId.get(b)!;
        const linhas = [
          { produtoId: ida, item: C.lerClassificacaoErpDoPayload({ generico: true }) },
          { produtoId: idb, item: C.lerClassificacaoErpDoPayload({ generico: false }) },
        ];
        let falhou = false;
        try {
          await prisma.$transaction(async (tx) => {
            await C.aplicarClassificacaoErp(tx, linhas);
            throw new Error("falha simulada depois da escrita");
          });
        } catch { falhou = true; }
        check(falhou && (await ler(a)).genericoErp === null, "lote falhado (rollback) não deixa estado parcial");
        const rr = await C.aplicarClassificacaoErp(prisma, linhas);
        check(rr.alterados === 2 && (await ler(a)).genericoErp === true && (await ler(b)).genericoErp === false, "retry aplica o lote inteiro");
        check((await C.aplicarClassificacaoErp(prisma, linhas)).alterados === 0, "retry repetido é inofensivo");
        const rp = await C.aplicarClassificacaoErp(prisma, [
          { produtoId: "id-que-nao-existe", item: C.lerClassificacaoErpDoPayload({ generico: true }) },
          { produtoId: ida, item: C.lerClassificacaoErpDoPayload({ generico: false }) },
        ]);
        check(rp.alterados === 1 && (await ler(a)).genericoErp === false, "linha inexistente é ignorada, as restantes entram");
        const rd = await C.aplicarClassificacaoErp(prisma, [
          { produtoId: ida, item: C.lerClassificacaoErpDoPayload({ generico: true }) },
          { produtoId: ida, item: C.lerClassificacaoErpDoPayload({ generico: false }) },
        ]);
        check(rd.candidatos === 1 && (await ler(a)).genericoErp === false, "duplicado no lote: última ocorrência ganha");
        const re = await C.aplicarClassificacaoErp(prisma, []);
        check(re.candidatos === 0 && re.alterados === 0, "lote vazio é inofensivo");
        const rs = await C.aplicarClassificacaoErp(prisma, [{ produtoId: ida, item: C.lerClassificacaoErpDoPayload({ cnp: 1 }) }]);
        check(rs.candidatos === 0, "item sem a chave não é candidato");
      }

      // 7 · camposManuais ------------------------------------------------
      console.log("\n--- 7. camposManuais protege genericoErp ---");
      {
        const c = novoCnp();
        const r0 = await ingerir(farmA, [{ cnp: c, designacao: "SETE", generico: true }]);
        await prisma.produto.update({ where: { cnp: c }, data: { camposManuais: ["genericoErp"] } });
        const id = r0.cnpToId.get(c)!;
        const x0 = await xmin(c);
        const r = await C.aplicarClassificacaoErp(prisma, [{ produtoId: id, item: C.lerClassificacaoErpDoPayload({ generico: false }) }]);
        check((await ler(c)).genericoErp === true && r.alterados === 0 && (await xmin(c)) === x0, "valor protegido não é sobreposto e a linha não é reescrita");
        const r2 = await C.aplicarClassificacaoErp(prisma, [{ produtoId: id, item: C.lerClassificacaoErpDoPayload({ generico: null }) }]);
        check((await ler(c)).genericoErp === true && r2.alterados === 0, "nem sequer por NULL");
        await prisma.produto.update({ where: { cnp: c }, data: { camposManuais: ["designacao"] } });
        const r3 = await C.aplicarClassificacaoErp(prisma, [{ produtoId: id, item: C.lerClassificacaoErpDoPayload({ generico: false }) }]);
        check((await ler(c)).genericoErp === false && r3.alterados === 1, "camposManuais de outro campo não bloqueia");
      }

      // 8 · política de designação, fabricante e restantes campos --------
      console.log("\n--- 8. Designação, fabricante e restantes campos nunca são tocados ---");
      const c8 = novoCnp();
      {
        const fab = await prisma.fabricante.create({ data: { nomeNormalizado: `LAB ${slug} ${sufixo}` } });
        await ingerir(farmA, [{ cnp: c8, designacao: "Designação Original" }]);
        await prisma.produto.update({ where: { cnp: c8 }, data: { fabricanteId: fab.id, dci: "DCI X", codigoATC: "N02BE01", flagMSRM: true, camposManuais: ["fabricante"] } });
        const antes = await ler(c8);
        const x0 = await xmin(c8);
        const id = (await prisma.produto.findUniqueOrThrow({ where: { cnp: c8 }, select: { id: true } })).id;
        await C.aplicarClassificacaoErp(prisma, [{ produtoId: id, item: C.lerClassificacaoErpDoPayload({ generico: true }) }]);
        const depois = await ler(c8);
        check(depois.designacao === antes.designacao && depois.fabricanteId === antes.fabricanteId && depois.fabricanteId === fab.id, "designação e fabricante idênticos antes/depois");
        check(depois.flagGenerico === antes.flagGenerico && depois.flagMSRM === antes.flagMSRM && depois.flagMNSRM === antes.flagMNSRM && depois.dci === antes.dci && depois.codigoATC === antes.codigoATC && JSON.stringify(depois.camposManuais) === JSON.stringify(antes.camposManuais), "flagGenerico, MSRM/MNSRM, DCI, ATC e camposManuais intocados");
        check(depois.genericoErp === true && (await xmin(c8)) !== x0, "só genericoErp mudou");
        const t1 = await dataAtualizacao(c8);
        await C.aplicarClassificacaoErp(prisma, [{ produtoId: id, item: C.lerClassificacaoErpDoPayload({ generico: false }) }]);
        check(t1 === (await dataAtualizacao(c8)), "dataAtualizacao não é tocada pela classificação");
        if (slug === "silveira") {
          const rs = await ingerir(farmB, [{ cnp: c8, designacao: "OUTRA DESIGNACAO DA SEGURADO", generico: true }]);
          const p = await ler(c8);
          check(rs.modo === "SO_CRIACAO" && p.designacao === "Designação Original", "silveira/não autoritativa: designação continua a não ser alterada (SO_CRIACAO)");
          check(p.genericoErp === true && p.fabricanteId === fab.id, "…mas o genérico é aplicado e o fabricante fica");
          const ra = await ingerir(farmA, [{ cnp: c8, designacao: "  Designação   do ERP Silveirense ", generico: false }]);
          const pa = await ler(c8);
          check(ra.modo === "AUTORITATIVA" && pa.designacao === "Designação do ERP Silveirense" && pa.fabricanteId === fab.id, "silveira/Silveirense: designação autoritativa segue a regra própria; fabricante intacto");
        } else {
          const rg = await ingerir(farmB, [{ cnp: c8, designacao: "Designação ERP garantia", generico: true }]);
          const p = await ler(c8);
          check(rg.modo === "LEGACY" && p.designacao === "Designação ERP garantia" && p.fabricanteId === fab.id, "garantia: regra LEGACY da designação como antes; fabricante intacto");
        }
      }

      // 9 · filtros ------------------------------------------------------
      console.log("\n--- 9. Filtro `cls` do Catálogo (where) ---");
      {
        const cnps = [c1, c1f, c1n, c2, c8];
        const n = async (f: string | undefined) => {
          const w = F.whereClassificacaoErp(F.parseFiltroClassificacaoErp(f));
          return prisma.produto.count({ where: { cnp: { in: cnps }, ...(w ? { AND: [w] } : {}) } });
        };
        check((await n(undefined)) === 5, "sem filtro: 5 produtos de teste");
        const gen = await n("generico");
        const nao = await n("nao_generico");
        check(gen + nao === 5, `genérico (${gen}) + não genérico (${nao}) cobrem todos (efetivo = genericoErp ?? flagGenerico)`);
        const desc = await n("generico_desconhecido");
        check(desc === (await prisma.produto.count({ where: { cnp: { in: cnps }, genericoErp: null } })), "'ERP não informou' = genericoErp NULL");
        check(F.parseFiltroClassificacaoErp("'; DROP TABLE x") === undefined && F.parseFiltroClassificacaoErp("GENERICO") === undefined && F.parseFiltroClassificacaoErp("etico") === undefined && F.parseFiltroClassificacaoErp("generico") === "generico", "whitelist: etico/nett/servico NÃO existem; injeção ignorada");
        const cOld = novoCnp();
        await prisma.produto.create({ data: { cnp: cOld, designacao: "VELHO" } });
        const wn = F.whereClassificacaoErp("nao_generico")!;
        check((await prisma.produto.count({ where: { cnp: cOld, AND: [wn] } })) === 1, "produto legado (flagGenerico=false, genericoErp null) → 'Não genérico' como antes");
        check(F.genericoEfetivo(null, false) === false && F.genericoEfetivo(null, null) === null && F.genericoEfetivo(true, false) === true && F.genericoEfetivo(false, true) === false && F.rotuloTri(null) === "—", "genericoEfetivo/rotuloTri: genericoErp tem prioridade; null cai para flagGenerico");
      }

      await prisma.$disconnect();
    }

    await suite("Silveira", "silveira", dbSilv);
    await suite("Garantia", "garantia", dbGar);

    // ═══ M · migration aditiva sobre dados existentes ═════════════════════
    console.log("\n=== M. Migration aditiva: UMA coluna, preserva dados existentes ===");
    {
      const sql = readFileSync(MIGRATION, "utf8");
      const semComentarios = sql.replace(/--.*$/gm, "");
      check(/ALTER TABLE "Produto"/.test(semComentarios) && !/\b(DROP|DELETE|UPDATE|TRUNCATE|RENAME|INSERT)\b/i.test(semComentarios), "só ALTER TABLE … ADD COLUMN (sem DROP/UPDATE/DELETE)");
      check((semComentarios.match(/ADD COLUMN/g) ?? []).length === 1 && /ADD COLUMN "genericoErp" BOOLEAN;/.test(semComentarios), "UMA coluna (genericoErp BOOLEAN, anulável, sem DEFAULT)");
      check(!/erpEtico|erpNett|erpServico|classificacaoErp(Conflito|Em|Origem)/.test(semComentarios), "nenhuma coluna especulativa (Ético/NETT/Serviço/conflito/origem)");
      check(/PROVISÓRIA/.test(sql), "marcada PROVISÓRIA");
      const cli = new Client({ connectionString: urlDe(dbPre) });
      await cli.connect();
      await cli.query(`ALTER TABLE "Produto" DROP COLUMN "genericoErp"`);
      await cli.query(`INSERT INTO "Produto" ("id","cnp","designacao","flagGenerico","dataAtualizacao") VALUES ('pre-1', 9500001, 'ANTIGO UM', true, now()), ('pre-2', 9500002, 'ANTIGO DOIS', false, now())`);
      await cli.query(sql);
      const r = await cli.query(`SELECT cnp, designacao, "flagGenerico", "genericoErp" FROM "Produto" ORDER BY cnp`);
      check(r.rowCount === 2 && r.rows[0].designacao === "ANTIGO UM" && r.rows[0].flagGenerico === true && r.rows[1].flagGenerico === false, "linhas e valores existentes intactos");
      check(r.rows.every((x) => x.genericoErp === null), "coluna nova: NULL (desconhecido) em todas as linhas existentes");
      await cli.end();
    }

    // ═══ S · estrutura do endpoint ════════════════════════════════════════
    console.log("\n=== S. Estrutura do endpoint (bulk e caminho de recurso) ===");
    {
      const rota = readFileSync("app/api/ingest/v1/bootstrap/products/route.ts", "utf8");
      const bulk = readFileSync("lib/ingest/bulk.ts", "utf8");
      check((rota.match(/aplicarClassificacaoSegura\(/g) ?? []).length === 3, "aplicada no caminho bulk E no caminho de recurso (definição + 2 chamadas)");
      check(/classificacaoFallback\.push\(\{ produtoId: produto\.id/.test(rota), "caminho de recurso recolhe a classificação por produto");
      check(rota.includes("lerClassificacaoErpDoPayload(raw as Record<string, unknown>)"), "payload lido sem coerção a false (não usa asBoolOrFalse)");
      check(rota.includes("flagGenerico: asBoolOrFalse(raw.generico)"), "flagGenerico continua a ser lido como antes");
      check(!/genericoErp/.test(bulk), "bulk.ts (upsert de Produto/designação) não conhece a coluna nova");
      check(/catch \(err\)[\s\S]{0,400}ingestão continua/.test(rota) && rota.includes("erro: msg.slice(0, 300)"), "falha da classificação não derruba o lote e fica na resposta");
      check(rota.includes("...(classificacaoErp && (classificacaoErp.candidatos > 0 || classificacaoErp.erro)"), "resposta só traz classificacaoErp quando relevante");
      const codigo = readFileSync("lib/ingest/classificacao-erp.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      check(!/\betico\b|\bnett\b|\bservico\b/i.test(codigo), "código do servidor sem Ético/NETT/Serviço");
    }
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${dbPre}`).catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${dbSilv}`).catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${dbGar}`).catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${dbBase}`).catch(() => {});
    await admin.end();
  }

  console.log(`\n${passed} ok, ${failed} falhas`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
