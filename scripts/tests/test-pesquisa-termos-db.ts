/**
 * scripts/tests/test-pesquisa-termos-db.ts
 *
 * PostgreSQL REAL e DESCARTÁVEL (recusa correr fora de localhost):
 *
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:55490/postgres \
 *     npx tsx scripts/tests/test-pesquisa-termos-db.ts
 *
 * Cria uma base nova, aplica TODAS as migrations do histórico e prova, com o
 * loader REAL do Relatório de Vendas (`getVendasData`) e com os pickers
 * reais, a regra de pesquisa por termos (AND, sem caixa/acentos/pontuação):
 *
 *   P  parcial · dois termos não contíguos · ordem invertida · caixa,
 *      acentos, pontuação, espaços · termo inexistente · todos obrigatórios
 *   C  combinação com CNP
 *   F  combinação com fabricante, categoria, farmácia e período
 *   R  os restantes pontos de pesquisa (Manutenção de vendas, Stock,
 *      Inventário, Encomendas, Catálogo) usam a mesma regra
 *   X  eficiência: o plano usa o índice GIN trigram (unaccent)
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

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgresql://postgres:test@localhost:55490/postgres";
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
const ordenado = (a: Iterable<string>) => [...a].sort();

async function main() {
  const db = `spharm_test_pesq_${Date.now().toString(36)}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${db}`);
  try {
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(db) }, encoding: "utf8" });
    process.env.DATABASE_URL = urlDe(db);
    const { PrismaClient, Prisma } = await import("../../generated/prisma/client");
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(db) }) });
    const { getVendasData } = await import("../../lib/vendas-data");
    const { construirCondicaoPesquisa } = await import("../../lib/reporting/pesquisa-produto");

    // ═══ Dados ═══════════════════════════════════════════════════════════
    const fSilv = await prisma.farmacia.create({ data: { nome: "PT Silveirense" } });
    const fSeg = await prisma.farmacia.create({ data: { nome: "PT Segurado" } });
    const fabCiclum = await prisma.fabricante.create({ data: { nomeNormalizado: "PT-CICLUM", estado: "ATIVO" } });
    const fabGeneris = await prisma.fabricante.create({ data: { nomeNormalizado: "PT-GENERIS", estado: "ATIVO" } });
    const catAnalg = await prisma.classificacao.create({ data: { nome: "PT Analgésicos", tipo: "NIVEL_1" } });
    const catDerm = await prisma.classificacao.create({ data: { nome: "PT Dermo", tipo: "NIVEL_1" } });

    const defs = [
      { n: 1, nome: "PARACETAMOL CICLUM 650 MG 20 COMP.", fab: fabCiclum.id, cat: catAnalg.id },
      { n: 2, nome: "PARACETAMOL GENERIS 500 MG 20 COMP.", fab: fabGeneris.id, cat: catAnalg.id },
      { n: 3, nome: "IBUPROFENO CICLUM 400 MG 20 COMP.", fab: fabCiclum.id, cat: catAnalg.id },
      { n: 4, nome: "Avène Eau Thermale Spray", fab: fabGeneris.id, cat: catDerm.id },
      { n: 5, nome: "VENTILAN INALADOR R AER 100 MCG/D 200 D", fab: null, cat: null },
    ];
    const prod: Record<number, { id: string; cnp: number }> = {};
    for (const d of defs) {
      const p = await prisma.produto.create({
        data: {
          cnp: 8_100_000 + d.n, designacao: d.nome, tipoArtigo: "MEDICAMENTO", estado: "VALIDADO",
          fabricanteId: d.fab, classificacaoNivel1Id: d.cat,
        },
      });
      prod[d.n] = { id: p.id, cnp: p.cnp };
      for (const f of [fSilv, fSeg]) {
        await prisma.produtoFarmacia.create({ data: { produtoId: p.id, farmaciaId: f.id, stockAtual: 3, pvp: 5 } });
      }
    }
    // Vendas: dois meses completos anteriores. O produto 1 só vendeu na Silveirense.
    const hoje = new Date();
    const mesesAtras = (k: number) => new Date(hoje.getFullYear(), hoje.getMonth() - k, 1);
    const m1 = mesesAtras(2);
    const m2 = mesesAtras(1);
    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const from = iso(m1);
    const to = iso(new Date(m2.getFullYear(), m2.getMonth() + 1, 0));
    const vendas: Array<[number, string, Date]> = [
      [1, fSilv.id, m1], [1, fSilv.id, m2],
      [2, fSilv.id, m1], [2, fSeg.id, m1],
      [3, fSeg.id, m2],
      [4, fSilv.id, m2],
      [5, fSeg.id, m1],
    ];
    for (const [n, fid, m] of vendas) {
      await prisma.vendaMensal.create({
        data: { farmaciaId: fid, produtoId: prod[n].id, ano: m.getFullYear(), mes: m.getMonth() + 1, quantidade: 10, valorTotal: 100, naturezaVenda: "NORMAL" },
      });
    }

    /** Descrições devolvidas pelo loader REAL de Vendas para estes filtros. */
    async function vendas_(filtros: Record<string, unknown>): Promise<string[]> {
      const r = await getVendasData({ from, to, ...filtros } as never, prisma);
      return ordenado(new Set(r.rows.map((x) => x.descricao)));
    }
    const PARA_CICLUM = "PARACETAMOL CICLUM 650 MG 20 COMP.";

    // ═══ P · Termos ═══════════════════════════════════════════════════════
    console.log("\n=== P. Termos (loader real de Vendas) ===");
    check((await vendas_({ pesquisa: "parace" })).includes(PARA_CICLUM), '"parace" encontra o artigo');
    check(
      JSON.stringify(await vendas_({ pesquisa: "parace" })) ===
        JSON.stringify(ordenado(["PARACETAMOL CICLUM 650 MG 20 COMP.", "PARACETAMOL GENERIS 500 MG 20 COMP."])),
      '"parace" encontra os dois paracetamóis (e só esses)',
    );
    check(
      JSON.stringify(await vendas_({ pesquisa: "parace ciclum" })) === JSON.stringify([PARA_CICLUM]),
      '"parace ciclum" (dois termos não contíguos) encontra exactamente o artigo — o defeito',
      JSON.stringify(await vendas_({ pesquisa: "parace ciclum" })),
    );
    check(
      JSON.stringify(await vendas_({ pesquisa: "ciclum parace" })) === JSON.stringify([PARA_CICLUM]),
      '"ciclum parace" (ordem invertida) encontra o mesmo artigo',
    );
    check(
      JSON.stringify(await vendas_({ pesquisa: "PARÁCE   cíclum" })) === JSON.stringify([PARA_CICLUM]),
      '"PARÁCE   cíclum" (caixa, acentos, espaços) encontra o mesmo artigo',
    );
    check(
      JSON.stringify(await vendas_({ pesquisa: "parace, ciclum." })) === JSON.stringify([PARA_CICLUM]),
      '"parace, ciclum." (pontuação) encontra o mesmo artigo',
    );
    check(
      JSON.stringify(await vendas_({ pesquisa: "avene thermale" })) === JSON.stringify(["Avène Eau Thermale Spray"]),
      '"avene thermale" encontra "Avène Eau Thermale Spray" (acentos na BD)',
    );
    check((await vendas_({ pesquisa: "parace ciclum inexistente" })).length === 0, "todos os termos são obrigatórios: um termo a mais ⇒ zero");
    check((await vendas_({ pesquisa: "zzzzzz" })).length === 0, "termo inexistente ⇒ zero resultados");
    check(
      (await vendas_({ pesquisa: "ciclum" })).length === 2 && !(await vendas_({ pesquisa: "ciclum 650" })).includes("IBUPROFENO CICLUM 400 MG 20 COMP."),
      "acrescentar um termo só estreita (ciclum → 2; ciclum 650 → exclui o ibuprofeno)",
    );

    // ═══ C · CNP ══════════════════════════════════════════════════════════
    console.log("\n=== C. CNP ===");
    check(
      JSON.stringify(await vendas_({ pesquisa: String(prod[1].cnp) })) === JSON.stringify([PARA_CICLUM]),
      "CNP completo encontra o artigo",
    );
    check(
      (await vendas_({ pesquisa: String(prod[1].cnp).slice(0, 5) })).length === 5,
      "CNP parcial (prefixo) continua a funcionar",
    );
    check(
      JSON.stringify(await vendas_({ pesquisa: `${prod[1].cnp} ciclum` })) === JSON.stringify([PARA_CICLUM]),
      "CNP + termo de designação combinam por AND",
    );
    check(
      (await vendas_({ pesquisa: `${prod[1].cnp} generis` })).length === 0,
      "CNP de um artigo + designação de outro ⇒ zero",
    );

    // ═══ F · Filtros combinados ═══════════════════════════════════════════
    console.log("\n=== F. Combinação com os restantes filtros ===");
    check(
      JSON.stringify(await vendas_({ pesquisa: "parace", fabricantes: ["PT-CICLUM"] })) === JSON.stringify([PARA_CICLUM]),
      "pesquisa + fabricante",
    );
    check(
      (await vendas_({ pesquisa: "parace ciclum", fabricantes: ["PT-GENERIS"] })).length === 0,
      "pesquisa + fabricante errado ⇒ zero",
    );
    check(
      JSON.stringify(await vendas_({ pesquisa: "ciclum", categorias: ["PT Analgésicos"] })) ===
        JSON.stringify(ordenado([PARA_CICLUM, "IBUPROFENO CICLUM 400 MG 20 COMP."])),
      "pesquisa + categoria",
    );
    check(
      (await vendas_({ pesquisa: "parace ciclum", categorias: ["PT Dermo"] })).length === 0,
      "pesquisa + categoria errada ⇒ zero",
    );
    check(
      JSON.stringify(await vendas_({ pesquisa: "ciclum", farmaciaNomes: ["PT Segurado"] })) === JSON.stringify(["IBUPROFENO CICLUM 400 MG 20 COMP."]),
      "pesquisa + farmácia (o paracetamol Ciclum só vendeu na Silveirense)",
    );
    check(
      JSON.stringify(await vendas_({ pesquisa: "parace ciclum", farmaciaNomes: ["PT Silveirense"] })) === JSON.stringify([PARA_CICLUM]),
      "pesquisa + farmácia correcta",
    );
    const soM1 = iso(m1);
    const fimM1 = iso(new Date(m1.getFullYear(), m1.getMonth() + 1, 0));
    check(
      JSON.stringify(await vendas_({ pesquisa: "parace ciclum", from: soM1, to: fimM1 })) === JSON.stringify([PARA_CICLUM]),
      "pesquisa + período (mês em que vendeu)",
    );
    check(
      (await vendas_({ pesquisa: "ibuprofeno ciclum", from: soM1, to: fimM1 })).length === 0,
      "pesquisa + período (o ibuprofeno só vendeu no mês seguinte) ⇒ zero",
    );

    // ═══ R · Outros pontos de pesquisa ════════════════════════════════════
    console.log("\n=== R. Os restantes pontos de pesquisa ===");
    // Pickers que dependem de sessão/permissões: exercita-se a MESMA query
    // partilhada que eles executam (construirCondicaoPesquisa com o JOIN real).
    const picker = await prisma.$queryRaw<{ designacao: string }[]>(Prisma.sql`
      SELECT p."designacao" FROM "Produto" p
      LEFT JOIN "Fabricante" f ON f."id" = p."fabricanteId"
      WHERE 1 = 1 ${construirCondicaoPesquisa("parace ciclum")}
      ORDER BY p."designacao"
    `);
    check(picker.length === 1 && picker[0].designacao === PARA_CICLUM, "picker (Manutenção de vendas): 'parace ciclum' ⇒ o artigo");

    // Um número curto junto de palavras é designação, não CNP: o CNP do «OMEGA 6»
    // (8100036) contém um «3» e não pode aparecer em «omega 3».
    await prisma.produto.create({ data: { cnp: 8_100_036, designacao: "OMEGA 6 PLUS 60 CAPS.", tipoArtigo: "PARAFARMACIA", estado: "VALIDADO" } });
    await prisma.produto.create({ data: { cnp: 8_100_037, designacao: "OMEGA 3 FORTE 60 CAPS.", tipoArtigo: "PARAFARMACIA", estado: "VALIDADO" } });
    const omega = await prisma.$queryRaw<{ designacao: string }[]>(Prisma.sql`
      SELECT p."designacao" FROM "Produto" p WHERE 1 = 1 ${construirCondicaoPesquisa("omega 3")} ORDER BY p."designacao"
    `);
    check(omega.length === 1 && omega[0].designacao === "OMEGA 3 FORTE 60 CAPS.", "«omega 3» encontra só o OMEGA 3 (o «3» do CNP do OMEGA 6 não conta)", JSON.stringify(omega));
    const dose = await prisma.$queryRaw<{ designacao: string }[]>(Prisma.sql`
      SELECT p."designacao" FROM "Produto" p WHERE 1 = 1 ${construirCondicaoPesquisa("omega 8100036")} ORDER BY p."designacao"
    `);
    check(dose.length === 1 && dose[0].designacao === "OMEGA 6 PLUS 60 CAPS.", "«omega» + CNP completo (4+ dígitos) combinam por AND");
    const curto = await prisma.$queryRaw<{ designacao: string }[]>(Prisma.sql`
      SELECT p."designacao" FROM "Produto" p WHERE 1 = 1 ${construirCondicaoPesquisa("81000")} ORDER BY p."cnp"
    `);
    check(curto.length >= 6, "um único termo numérico curto continua a procurar no CNP");

    const { construirPredicadoPesquisa } = await import("../../lib/reporting/pesquisa-produto");
    const predEnc = construirPredicadoPesquisa("generis parace", { colunasExtra: [Prisma.sql`f."nomeNormalizado"`] });
    const enc = await prisma.$queryRaw<{ designacao: string }[]>(Prisma.sql`
      SELECT p."designacao" FROM "Produto" p LEFT JOIN "Fabricante" f ON f."id" = p."fabricanteId"
      WHERE ${predEnc!} ORDER BY p."designacao"
    `);
    check(
      enc.length === 1 && enc[0].designacao === "PARACETAMOL GENERIS 500 MG 20 COMP.",
      "picker (Encomendas): um termo da designação + um termo do NOME DO FABRICANTE",
    );

    const { condicoesPrismaPesquisa } = await import("../../lib/reporting/pesquisa-termos");
    const cat = await prisma.produto.findMany({ where: { AND: condicoesPrismaPesquisa("ciclum parace", ["designacao", "dci", "codigoATC"]) }, select: { designacao: true } });
    check(
      cat.length === 1 && cat[0].designacao === PARA_CICLUM,
      "Catálogo / fila de revisão (where do Prisma): 'ciclum parace' ⇒ o artigo",
      JSON.stringify(cat),
    );
    const catAcento = await prisma.produto.findMany({ where: { AND: condicoesPrismaPesquisa("avène THERMALE", ["designacao"]) }, select: { designacao: true } });
    check(catAcento.length === 1, "Catálogo (where do Prisma): mantém os acentos — 'avène thermale' ⇒ Avène");
    const catCnp = await prisma.produto.findMany({ where: { AND: condicoesPrismaPesquisa(String(prod[1].cnp), ["designacao"]) }, select: { designacao: true } });
    check(catCnp.length === 1 && catCnp[0].designacao === PARA_CICLUM, "Catálogo (where do Prisma): CNP exacto continua a funcionar");

    const inv = await prisma.$queryRaw<{ designacao: string }[]>(Prisma.sql`
      SELECT p."designacao" FROM "Produto" p WHERE 1 = 1 ${construirCondicaoPesquisa("PARÁCE   cíclum")}
    `);
    check(inv.length === 1, "Inventário/Stock (mesma condição): 'PARÁCE   cíclum' ⇒ o artigo");

    // ═══ X · Índice ═══════════════════════════════════════════════════════
    console.log("\n=== X. Eficiência ===");
    await prisma.$executeRawUnsafe(`SET enable_seqscan = off`);
    const plano = await prisma.$queryRaw<{ "QUERY PLAN": string }[]>(Prisma.sql`
      EXPLAIN SELECT p.id FROM "Produto" p WHERE 1=1 ${construirCondicaoPesquisa("parace ciclum")}
    `);
    const txt = plano.map((l) => l["QUERY PLAN"]).join("\n");
    check(/Produto_designacao_unaccent_trgm_idx/.test(txt), "o plano de 2 termos usa o índice GIN trigram (unaccent)", txt);

    await prisma.$disconnect();
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.end();
  }

  console.log(`\n${failed === 0 ? "PASSOU" : "FALHOU"} — ${passed} OK, ${failed} falhas\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
