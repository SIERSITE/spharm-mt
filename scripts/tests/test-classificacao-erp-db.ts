/**
 * scripts/tests/test-classificacao-erp-db.ts
 *
 * PostgreSQL REAL e DESCARTÁVEL (recusa correr fora de localhost):
 *
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres \
 *     npx tsx scripts/tests/test-classificacao-erp-db.ts
 *
 * Classificação ERP do produto (Ético / NETT / Serviço / Genérico tri-estado)
 * — lib/ingest/classificacao-erp.ts + migration 20261028120000.
 *
 * Reproduz a sequência do endpoint /api/ingest/v1/bootstrap/products com as
 * MESMAS funções (resolverModoDesignacao → upsertProdutosComDesignacao →
 * lerClassificacaoErpDoPayload/aplicarClassificacaoErp). Dois tenants
 * simulados em duas bases (silveira: designação autoritativa / SO_CRIACAO;
 * garantia: LEGACY) criadas por CREATE DATABASE … TEMPLATE da base migrada.
 * Só dados sintéticos.
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
    console.log("\n=== P. Leitura do payload (ausente ≠ false ≠ null) ===");
    {
      const l = C.lerClassificacaoErpDoPayload;
      check(Object.keys(l({ cnp: 1, generico: true }).campos).length === 0, "agent antigo (sem chaves novas): nenhum campo — `generico` não conta");
      check(JSON.stringify(l({ etico: true, nett: false, servico: null }).campos) === JSON.stringify({ erpEtico: true, erpNett: false, erpServico: null }), "true / false / null explícito");
      check(l({ etico: undefined }).campos.erpEtico === undefined && !("erpEtico" in l({ etico: undefined }).campos), "undefined = ausente");
      const e = l({ etico: "", nett: "  ", servico: "x" });
      check(e.campos.erpEtico === null && e.campos.erpNett === null && e.campos.erpServico === null && e.desconhecidos === 1, "vazio → null; texto desconhecido → null + contado");
      check(l({ etico: 2 }).desconhecidos === 1 && l({ etico: 1 }).campos.erpEtico === true && l({ etico: 0 }).campos.erpEtico === false, "números: só 0/1 reconhecidos");
      check(l({ etico: "TRUE" }).campos.erpEtico === true && l({ etico: "0" }).campos.erpEtico === false, "'true'/'0' tolerados");
      check(l({ genericoErp: false }).campos.genericoErp === false && l({ genericoErp: null }).campos.genericoErp === null, "genericoErp tri-estado");
      check(l({ classificacaoErpOrigem: "spharm_erp:etico=Stocks.[A]" }).origem === "spharm_erp:etico=Stocks.[A]" && l({}).origem === null, "origem");
      check(C.conflitoClassificacao({ erpEtico: true, erpNett: null, erpServico: true }) && !C.conflitoClassificacao({ erpEtico: true, erpNett: true, erpServico: false }) && !C.conflitoClassificacao({ erpEtico: null, erpNett: null, erpServico: true }), "conflito = Serviço + (Ético|NETT)");
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
          select: { designacao: true, fabricanteId: true, flagGenerico: true, erpEtico: true, erpNett: true, erpServico: true, genericoErp: true, classificacaoErpConflito: true, classificacaoErpEm: true, classificacaoErpOrigem: true, camposManuais: true },
        });
      const xmin = async (cnp: number) => (await prisma.$queryRaw<Array<{ x: string }>>`SELECT xmin::text AS x FROM "Produto" WHERE cnp = ${cnp}`)[0]!.x;
      return { prisma, farmA, farmB, novoCnp, ingerir, ler, xmin };
    }

    async function suite(nome: string, slug: "silveira" | "garantia", db: string) {
      console.log(`\n##### Tenant ${nome} (${slug}) #####`);
      const { prisma, farmA, farmB, novoCnp, ingerir, ler, xmin } = await ambiente(db, slug);

      // 1 · produto novo ------------------------------------------------
      console.log("\n--- 1. Produto novo com os 4 campos ---");
      const c1 = novoCnp();
      {
        const r = await ingerir(farmA, [{ cnp: c1, designacao: "PRODUTO UM", generico: false, genericoErp: false, etico: true, nett: false, servico: false, classificacaoErpOrigem: "spharm_erp:etico=Stocks.[X]" }]);
        const p = await ler(c1);
        check(p.erpEtico === true && p.erpNett === false && p.erpServico === false && p.genericoErp === false, "criado com Ético=Sim, NETT=Não, Serviço=Não, Genérico=Não");
        check(p.classificacaoErpOrigem === "spharm_erp:etico=Stocks.[X]" && p.classificacaoErpEm !== null, "origem e data gravadas");
        check(r.resumo.candidatos === 1 && r.resumo.alterados === 1 && r.resumo.conflitos === 0, "resumo: 1 candidato, 1 alterado");
        check(p.designacao === "PRODUTO UM" && p.flagGenerico === false, "designação e flagGenerico como sempre");
      }

      // 2 · existente sem classificação ---------------------------------
      console.log("\n--- 2. Produto existente (criado por agent antigo) ---");
      const c2 = novoCnp();
      {
        await ingerir(farmA, [{ cnp: c2, designacao: "PRODUTO DOIS", generico: true }]);
        const antes = await ler(c2);
        check(antes.erpEtico === null && antes.erpNett === null && antes.erpServico === null && antes.genericoErp === null && antes.flagGenerico === true, "agent antigo: classificação fica NULL (desconhecido), flagGenerico=true como sempre");
        check(antes.classificacaoErpEm === null && antes.classificacaoErpOrigem === null, "sem data nem origem");
        const r = await ingerir(farmA, [{ cnp: c2, designacao: "PRODUTO DOIS", generico: true, genericoErp: true, etico: false, nett: true, servico: false }]);
        const p = await ler(c2);
        check(p.erpNett === true && p.erpEtico === false && p.genericoErp === true && r.resumo.alterados === 1, "agent novo preenche o existente");
      }

      // 3 · mudança ------------------------------------------------------
      console.log("\n--- 3. Mudança: deixa de ser NETT / Ético passa a Sim ---");
      {
        const r = await ingerir(farmA, [{ cnp: c2, designacao: "PRODUTO DOIS", generico: true, genericoErp: true, etico: true, nett: false, servico: false }]);
        const p = await ler(c2);
        check(p.erpNett === false && p.erpEtico === true && r.resumo.alterados === 1, "NETT → false e Ético → true (false explícito atualiza)");
      }

      // 4 · valor vazio / null ------------------------------------------
      console.log("\n--- 4. Valor vazio / null explícito → desconhecido ---");
      {
        const r = await ingerir(farmA, [{ cnp: c2, designacao: "PRODUTO DOIS", generico: true, genericoErp: null, etico: null, nett: "", servico: false }]);
        const p = await ler(c2);
        check(p.erpEtico === null && p.erpNett === null && p.genericoErp === null && p.erpServico === false, "null e '' → NULL; servico=false mantém-se");
        check(r.resumo.valoresDesconhecidos === 0, "vazio não conta como código desconhecido");
        check(p.flagGenerico === true, "genericoErp=null não mexe em flagGenerico");
      }

      // 5 · código desconhecido -----------------------------------------
      console.log("\n--- 5. Código desconhecido → null + contador, lote não falha ---");
      const c5 = novoCnp();
      const c5b = novoCnp();
      {
        const r = await ingerir(farmA, [
          { cnp: c5, designacao: "PRODUTO CINCO", etico: "Z9", nett: 7, servico: true },
          { cnp: c5b, designacao: "PRODUTO CINCO B", etico: true },
        ]);
        const p = await ler(c5);
        const pb = await ler(c5b);
        check(p.erpEtico === null && p.erpNett === null && p.erpServico === true, "texto/número não booleanos → NULL; servico mantém-se");
        check(r.resumo.valoresDesconhecidos === 2, "contador valoresDesconhecidos=2");
        check(pb.erpEtico === true, "o outro produto do lote é gravado");
      }

      // 6 · agent antigo não apaga --------------------------------------
      console.log("\n--- 6. Agent antigo (sem campos) não apaga nada ---");
      {
        const antes = await ler(c1);
        const x0 = await xmin(c1);
        const r = await ingerir(farmA, [{ cnp: c1, designacao: "PRODUTO UM", generico: false }]);
        const depois = await ler(c1);
        check(r.resumo.candidatos === 0 && r.resumo.alterados === 0, "0 candidatos, 0 alterados");
        check(depois.erpEtico === antes.erpEtico && depois.erpNett === antes.erpNett && depois.erpServico === antes.erpServico && depois.genericoErp === antes.genericoErp, "valores mantidos (undefined ≠ false)");
        check(depois.classificacaoErpOrigem === antes.classificacaoErpOrigem && depois.classificacaoErpEm?.getTime() === antes.classificacaoErpEm?.getTime(), "origem e data mantidas");
        // xmin muda no ON CONFLICT do Produto (comportamento anterior, dataAtualizacao=now()) — a prova é só dos campos novos.
        void x0;
      }
      {
        // chaves parcialmente enviadas: só `etico` — nett/servico/genericoErp intactos
        const antes = await ler(c1);
        await ingerir(farmA, [{ cnp: c1, designacao: "PRODUTO UM", etico: false }]);
        const depois = await ler(c1);
        check(depois.erpEtico === false && depois.erpNett === antes.erpNett && depois.erpServico === antes.erpServico && depois.genericoErp === antes.genericoErp, "campo parcial: só o enviado muda");
      }

      // 7 · idempotência (sem escritas) ---------------------------------
      console.log("\n--- 7. Idempotência: reenviar o mesmo lote não escreve nada ---");
      const c7 = novoCnp();
      {
        const lote = [{ cnp: c7, designacao: "PRODUTO SETE", generico: false, genericoErp: false, etico: false, nett: true, servico: false, classificacaoErpOrigem: "spharm_erp:nett=Stocks.[N]" }];
        const r1 = await ingerir(farmA, lote);
        // medir só a classificação: aplicar directamente o mesmo lote duas vezes
        const idc = r1.cnpToId.get(c7)!;
        const linhas = [{ produtoId: idc, item: C.lerClassificacaoErpDoPayload(lote[0]!) }];
        const x1 = await xmin(c7);
        const p1 = await ler(c7);
        const r2 = await C.aplicarClassificacaoErp(prisma, linhas);
        const x2 = await xmin(c7);
        const p2 = await ler(c7);
        check(r1.resumo.alterados === 1 && r2.alterados === 0, "1.º envio altera, 2.º envio: alterados=0");
        check(x1 === x2, "linha não reescrita (xmin igual)");
        check(p1.classificacaoErpEm?.getTime() === p2.classificacaoErpEm?.getTime(), "classificacaoErpEm não mexe num reenvio");
        const r3 = await C.aplicarClassificacaoErp(prisma, linhas);
        check(r3.alterados === 0 && (await xmin(c7)) === x1, "3.º envio também sem escritas");
        // origem diferente é uma alteração real
        const r4 = await C.aplicarClassificacaoErp(prisma, [{ produtoId: idc, item: C.lerClassificacaoErpDoPayload({ ...lote[0]!, classificacaoErpOrigem: "spharm_erp:nett=Outra.[Col]" }) }]);
        check(r4.alterados === 1, "só a origem mudou → regista (proveniência)");
      }

      // 8 · retry / lote parcial ----------------------------------------
      console.log("\n--- 8. Retry e lote parcial ---");
      const c8 = novoCnp();
      const c8b = novoCnp();
      {
        const r0 = await ingerir(farmA, [{ cnp: c8, designacao: "OITO", etico: null }, { cnp: c8b, designacao: "OITO B" }]);
        const id8 = r0.cnpToId.get(c8)!;
        const id8b = r0.cnpToId.get(c8b)!;
        const linhas = [
          { produtoId: id8, item: C.lerClassificacaoErpDoPayload({ etico: true, nett: false }) },
          { produtoId: id8b, item: C.lerClassificacaoErpDoPayload({ servico: true, etico: true }) },
        ];
        // a transação falha a meio → nada fica gravado (atómico)
        let falhou = false;
        try {
          await prisma.$transaction(async (tx) => {
            await C.aplicarClassificacaoErp(tx, linhas);
            throw new Error("falha simulada depois da escrita");
          });
        } catch { falhou = true; }
        const apos = await ler(c8);
        check(falhou && apos.erpEtico === null && apos.erpNett === null, "lote falhado (rollback) não deixa estado parcial");
        // retry: reenvio do lote completo
        const rr = await C.aplicarClassificacaoErp(prisma, linhas);
        check(rr.alterados === 2 && (await ler(c8)).erpEtico === true && (await ler(c8b)).classificacaoErpConflito === true, "retry aplica o lote inteiro");
        const rr2 = await C.aplicarClassificacaoErp(prisma, linhas);
        check(rr2.alterados === 0, "retry repetido é inofensivo");
        // lote parcial: produtoId inexistente no meio
        const rp = await C.aplicarClassificacaoErp(prisma, [
          { produtoId: "id-que-nao-existe", item: C.lerClassificacaoErpDoPayload({ etico: true }) },
          { produtoId: id8, item: C.lerClassificacaoErpDoPayload({ etico: false }) },
        ]);
        check(rp.alterados === 1 && (await ler(c8)).erpEtico === false, "linha inexistente é ignorada, as restantes entram");
        // mesmo produto duas vezes no lote: a última ganha, sem erro
        const rd = await C.aplicarClassificacaoErp(prisma, [
          { produtoId: id8, item: C.lerClassificacaoErpDoPayload({ etico: true }) },
          { produtoId: id8, item: C.lerClassificacaoErpDoPayload({ etico: false }) },
        ]);
        check(rd.candidatos === 1 && (await ler(c8)).erpEtico === false, "duplicado no lote: última ocorrência ganha");
        const re = await C.aplicarClassificacaoErp(prisma, []);
        check(re.candidatos === 0 && re.alterados === 0, "lote vazio é inofensivo");
      }

      // 9 · camposManuais ------------------------------------------------
      console.log("\n--- 9. camposManuais protege cada campo ---");
      const c9 = novoCnp();
      {
        const r0 = await ingerir(farmA, [{ cnp: c9, designacao: "NOVE", etico: true, nett: true, servico: false, genericoErp: true }]);
        await prisma.produto.update({ where: { cnp: c9 }, data: { camposManuais: ["erpEtico", "genericoErp"] } });
        const r = await C.aplicarClassificacaoErp(prisma, [{ produtoId: r0.cnpToId.get(c9)!, item: C.lerClassificacaoErpDoPayload({ etico: false, nett: false, genericoErp: false }) }]);
        const p = await ler(c9);
        check(p.erpEtico === true && p.genericoErp === true, "Ético e Genérico protegidos (manuais) não são sobrepostos");
        check(p.erpNett === false && r.alterados === 1, "NETT (não manual) é atualizado no mesmo lote");
        const r2 = await C.aplicarClassificacaoErp(prisma, [{ produtoId: r0.cnpToId.get(c9)!, item: C.lerClassificacaoErpDoPayload({ etico: false, genericoErp: false }) }]);
        check(r2.alterados === 0, "só campos protegidos → nenhuma escrita");
      }

      // 10 · conflito ----------------------------------------------------
      console.log("\n--- 10. Conflito Serviço + Ético/NETT ---");
      const c10 = novoCnp();
      {
        const r = await ingerir(farmA, [{ cnp: c10, designacao: "DEZ", servico: true, etico: true, nett: false }]);
        const p = await ler(c10);
        check(p.erpServico === true && p.erpEtico === true, "guardado tal como veio (não corrige)");
        check(p.classificacaoErpConflito === true && r.resumo.conflitos === 1, "marcado como conflito e contado");
        await ingerir(farmA, [{ cnp: c10, designacao: "DEZ", servico: false }]);
        check((await ler(c10)).classificacaoErpConflito === false, "deixa de ser serviço → conflito limpo");
        await ingerir(farmA, [{ cnp: c10, designacao: "DEZ", servico: true, etico: false, nett: false }]);
        check((await ler(c10)).classificacaoErpConflito === false, "Serviço isolado não é conflito");
      }

      // 11 · política de designação e fabricante -------------------------
      console.log("\n--- 11. Designação e fabricante nunca são tocados pela classificação ---");
      const c11 = novoCnp();
      {
        const fab = await prisma.fabricante.create({ data: { nomeNormalizado: `LAB ${slug} ${sufixo}` } });
        await ingerir(farmA, [{ cnp: c11, designacao: "Designação Original" }]);
        await prisma.produto.update({ where: { cnp: c11 }, data: { fabricanteId: fab.id } });
        const antes = await ler(c11);
        // aplicação DIRECTA da classificação (isola o módulo novo)
        const id = (await prisma.produto.findUniqueOrThrow({ where: { cnp: c11 }, select: { id: true } })).id;
        await C.aplicarClassificacaoErp(prisma, [{ produtoId: id, item: C.lerClassificacaoErpDoPayload({ etico: true, nett: true, servico: false, genericoErp: true }) }]);
        const depois = await ler(c11);
        check(depois.designacao === antes.designacao && depois.fabricanteId === antes.fabricanteId && depois.fabricanteId === fab.id, "designação e fabricante idênticos antes/depois");
        check(depois.flagGenerico === antes.flagGenerico, "flagGenerico intocado por genericoErp");
        if (slug === "silveira") {
          // fluxo completo: Segurado (SO_CRIACAO) envia outra designação + classificação
          const rs = await ingerir(farmB, [{ cnp: c11, designacao: "OUTRA DESIGNACAO DA SEGURADO", etico: false }]);
          const p = await ler(c11);
          check(rs.modo === "SO_CRIACAO" && p.designacao === "Designação Original", "silveira/não autoritativa: designação continua a não ser alterada (SO_CRIACAO)");
          check(p.erpEtico === false && p.fabricanteId === fab.id, "…mas a classificação é aplicada e o fabricante fica");
          const ra = await ingerir(farmA, [{ cnp: c11, designacao: "  Designação   do ERP Silveirense ", etico: true }]);
          const pa = await ler(c11);
          check(ra.modo === "AUTORITATIVA" && pa.designacao === "Designação do ERP Silveirense" && pa.fabricanteId === fab.id, "silveira/Silveirense: designação autoritativa segue a regra própria; fabricante intacto");
        } else {
          const rg = await ingerir(farmB, [{ cnp: c11, designacao: "Designação ERP garantia", etico: false }]);
          const p = await ler(c11);
          check(rg.modo === "LEGACY" && p.designacao === "Designação ERP garantia" && p.fabricanteId === fab.id, "garantia: regra LEGACY da designação como antes; fabricante intacto");
        }
      }

      // 12 · filtros -----------------------------------------------------
      console.log("\n--- 12. Filtros do Catálogo (where) ---");
      {
        const n = async (f: string | undefined) => {
          const w = F.whereClassificacaoErp(F.parseFiltroClassificacaoErp(f));
          return prisma.produto.count({ where: { cnp: { in: [c1, c2, c5, c5b, c7, c8, c8b, c9, c10, c11] }, ...(w ? { AND: [w] } : {}) } });
        };
        const todos = await n(undefined);
        check(todos === 10, "sem filtro: 10 produtos de teste");
        check((await n("etico")) === (await prisma.produto.count({ where: { cnp: { in: [c1, c2, c5, c5b, c7, c8, c8b, c9, c10, c11] }, erpEtico: true } })), "etico = erpEtico true");
        const gen = await n("generico");
        const nao = await n("nao_generico");
        check(gen + nao === todos, `genérico (${gen}) + não genérico (${nao}) cobrem todos (efetivo = genericoErp ?? flagGenerico)`);
        const sem = await n("sem_classificacao");
        check(sem >= 0 && (await n("conflito")) === (await prisma.produto.count({ where: { cnp: { in: [c1, c2, c5, c5b, c7, c8, c8b, c9, c10, c11] }, classificacaoErpConflito: true } })), "sem_classificacao e conflito consistentes");
        check(F.parseFiltroClassificacaoErp("'; DROP TABLE x") === undefined && F.parseFiltroClassificacaoErp("ETICO") === undefined && F.parseFiltroClassificacaoErp("etico") === "etico", "whitelist de filtros");
        // produto sem nenhuma classificação (agent antigo) entra em sem_classificacao
        const cOld = novoCnp();
        await prisma.produto.create({ data: { cnp: cOld, designacao: "VELHO" } });
        const w = F.whereClassificacaoErp("sem_classificacao")!;
        check((await prisma.produto.count({ where: { cnp: cOld, AND: [w] } })) === 1, "produto nunca classificado → 'Sem classificação'");
        const wn = F.whereClassificacaoErp("nao_generico")!;
        check((await prisma.produto.count({ where: { cnp: cOld, AND: [wn] } })) === 1, "produto legado (flagGenerico=false, genericoErp null) → 'Não genérico' como antes");
      }

      await prisma.$disconnect();
    }

    await suite("Silveira", "silveira", dbSilv);
    await suite("Garantia", "garantia", dbGar);

    // ═══ M · migration aditiva sobre dados existentes ═════════════════════
    console.log("\n=== M. Migration aditiva: preserva dados existentes e é só ADD COLUMN ===");
    {
      const sql = readFileSync(MIGRATION, "utf8");
      const semComentarios = sql.replace(/--.*$/gm, "");
      check(/ALTER TABLE "Produto"/.test(semComentarios) && !/\b(DROP|DELETE|UPDATE|TRUNCATE|RENAME|INSERT)\b/i.test(semComentarios), "só ALTER TABLE … ADD COLUMN (sem DROP/UPDATE/DELETE)");
      check((semComentarios.match(/ADD COLUMN/g) ?? []).length === 7, "7 colunas novas");
      const cli = new Client({ connectionString: urlDe(dbPre) });
      await cli.connect();
      // simula a base ANTES da migration: remove as colunas, insere dados, reaplica o SQL
      await cli.query(`ALTER TABLE "Produto" DROP COLUMN "erpEtico", DROP COLUMN "erpNett", DROP COLUMN "erpServico", DROP COLUMN "genericoErp", DROP COLUMN "classificacaoErpConflito", DROP COLUMN "classificacaoErpEm", DROP COLUMN "classificacaoErpOrigem"`);
      await cli.query(`INSERT INTO "Produto" ("id","cnp","designacao","flagGenerico","dataAtualizacao") VALUES ('pre-1', 9500001, 'ANTIGO UM', true, now()), ('pre-2', 9500002, 'ANTIGO DOIS', false, now())`);
      await cli.query(sql);
      const r = await cli.query(`SELECT cnp, designacao, "flagGenerico", "erpEtico", "erpNett", "erpServico", "genericoErp", "classificacaoErpConflito", "classificacaoErpEm", "classificacaoErpOrigem" FROM "Produto" ORDER BY cnp`);
      check(r.rowCount === 2 && r.rows[0].designacao === "ANTIGO UM" && r.rows[0].flagGenerico === true && r.rows[1].flagGenerico === false, "linhas e valores existentes intactos");
      check(r.rows.every((x) => x.erpEtico === null && x.erpNett === null && x.erpServico === null && x.genericoErp === null && x.classificacaoErpConflito === false && x.classificacaoErpEm === null && x.classificacaoErpOrigem === null), "colunas novas: NULL (desconhecido) / conflito=false");
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
      check(!/erpEtico|erpNett|erpServico|genericoErp/.test(bulk), "bulk.ts (upsert de Produto/designação) não conhece as colunas novas");
      check(/catch \(err\)[\s\S]{0,400}ingestão continua/.test(rota) && rota.includes("erro: msg.slice(0, 300)"), "falha da classificação não derruba o lote e fica na resposta");
      check(rota.includes("...(classificacaoErp && (classificacaoErp.candidatos > 0 || classificacaoErp.erro)"), "resposta só traz classificacaoErp quando relevante (agents antigos não vêem diferença)");
      const outros = ["app/api/ingest/v1/bootstrap/stock/route.ts"].map((f) => { try { return readFileSync(f, "utf8"); } catch { return ""; } });
      check(outros.every((s) => !/classificacao-erp/.test(s)), "o endpoint de stock não é afectado");
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
