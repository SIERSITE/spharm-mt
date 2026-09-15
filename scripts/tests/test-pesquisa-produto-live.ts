/**
 * scripts/tests/test-pesquisa-produto-live.ts
 *
 * A pesquisa de `construirCondicaoPesquisa` (lib/reporting/pesquisa-produto.ts)
 * contra uma base de dados REAL — migrada pelo histórico verdadeiro de
 * `prisma/migrations/`, com o `@prisma/client` real gerado do schema
 * actual. Não é um teste unitário da função que constrói o SQL (esse é
 * `test-pesquisa-produto.ts`) — é a prova de que a QUERY, executada
 * contra Postgres a sério, devolve os produtos certos.
 *
 * Motivação (2026-09): "avene" tinha de encontrar "Avène" e não
 * encontrava — `ILIKE` sozinho não ignora acentos ("è" e "e" são
 * codepoints diferentes). A correcção usa a extensão `unaccent`
 * (migration 20260915140000_pesquisa_unaccent) com um wrapper IMMUTABLE
 * e um índice GIN trigram funcional — mas um teste puro em JS não prova
 * que a extensão existe, que o índice se aplica, ou que o SQL gerado é
 * sintacticamente válido contra Postgres real. Só uma base a sério prova
 * isso.
 *
 * ── Como correr ──────────────────────────────────────────────────────
 *
 *   docker run -d --rm --name pg-pesquisa-live \
 *     -e POSTGRES_PASSWORD=teste -e POSTGRES_DB=pesquisatest \
 *     -p 55434:5432 postgres:17-alpine
 *
 *   PESQUISA_LIVE_TEST_URL=postgresql://postgres:teste@127.0.0.1:55434/pesquisatest \
 *     npx tsx scripts/tests/test-pesquisa-produto-live.ts
 *
 * Sem `PESQUISA_LIVE_TEST_URL` o teste é SALTADO — não inventa uma base
 * nem toca na que estiver no .env. Mesmo padrão de
 * `test-control-schema.ts`.
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";

let pass = 0;
let fail = 0;
const ok = (l: string) => { pass++; console.log(`  [OK]    ${l}`); };
const bad = (l: string, d?: string) => { fail++; console.log(`  [FALHA] ${l}${d ? `\n            ${d}` : ""}`); };
const check = (c: boolean, l: string, d?: string) => (c ? ok(l) : bad(l, d));

const URL_TESTE = process.env.PESQUISA_LIVE_TEST_URL;

/**
 * Mesma guarda de `test-control-schema.ts`: este teste ESCREVE na base
 * (seed de Produto) e corre `prisma migrate deploy` — só aceita um nome
 * que se identifique como descartável.
 */
function recusarSeNaoForDescartavel(url: string): void {
  const nome = url.split("/").pop()?.split("?")[0] ?? "";
  if (!/(test|teste|scratch|drift|tmp)/i.test(nome)) {
    console.error(
      `\nPESQUISA_LIVE_TEST_URL aponta para a base "${nome}".\n` +
        "Este teste corre migrate deploy e escreve dados de teste — só aceita\n" +
        "nomes que se identifiquem como descartáveis (test/teste/scratch/drift/tmp).\n",
    );
    process.exit(2);
  }
  if (url === process.env.DATABASE_URL) {
    console.error("\nPESQUISA_LIVE_TEST_URL é igual a DATABASE_URL. Recusado.\n");
    process.exit(2);
  }
}

function prismaCli(args: string[], url: string): { status: number; out: string } {
  const r = spawnSync("npx", ["prisma", ...args], {
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: url },
    shell: process.platform === "win32",
  });
  return { status: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

async function main(): Promise<void> {
  if (!URL_TESTE) {
    console.log("=== pesquisa por artigo — query real ===");
    console.log("  SALTADO — PESQUISA_LIVE_TEST_URL não está definida.");
    console.log("  Ver o cabeçalho deste ficheiro para o comando do postgres descartável.");
    process.exit(0);
  }
  recusarSeNaoForDescartavel(URL_TESTE);

  console.log("=== pesquisa por artigo — query real (Postgres + migrations + Prisma Client) ===\n");

  console.log("A aplicar o histórico de migrations...");
  const deploy = prismaCli(["migrate", "deploy"], URL_TESTE);
  check(deploy.status === 0, "prisma migrate deploy aplicou o histórico completo", deploy.out.slice(-2000));
  if (deploy.status !== 0) {
    console.log(`\n${fail === 0 ? "PASSOU" : "FALHOU"} — ${pass} OK, ${fail} falhas\n`);
    process.exit(1);
  }

  // Import tardio: só depois do migrate deploy, e com DATABASE_URL já
  // apontado para a base de teste — o adapter do Prisma lê a variável
  // na construção do cliente.
  process.env.DATABASE_URL = URL_TESTE;
  const { PrismaClient } = await import("../../generated/prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const { construirCondicaoPesquisa } = await import("../../lib/reporting/pesquisa-produto");
  const { Prisma } = await import("../../generated/prisma/client");

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: URL_TESTE }) });

  try {
    console.log("\nA confirmar a extensão/índice da migration...");
    const ext = await prisma.$queryRaw<{ extname: string }[]>`
      SELECT extname FROM pg_extension WHERE extname = 'unaccent'
    `;
    check(ext.length === 1, "extensão unaccent instalada pela migration");
    const idx = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE indexname = 'Produto_designacao_unaccent_trgm_idx'
    `;
    check(idx.length === 1, "índice GIN trigram funcional (unaccent_immutable) existe");

    console.log("\nA semear produtos reais de teste...");
    await prisma.produto.deleteMany({ where: { cnp: { in: [8322628, 90001, 90002, 90003, 90004] } } });
    await prisma.produto.createMany({
      data: [
        { cnp: 8322628, designacao: "VENTILAN INALADOR R AER 100 MCG/D 200 D" },
        { cnp: 90001, designacao: "Avène Eau Thermale" },
        { cnp: 90002, designacao: "AVENE Creme Solar" },
        { cnp: 90003, designacao: "Avene Xeracalm" },
        { cnp: 90004, designacao: "Outro produto qualquer, sem relação" },
      ],
    });

    /** Corre a MESMA condição que os loaders reais usam. */
    async function pesquisar(termo: string): Promise<string[]> {
      const cond = construirCondicaoPesquisa(termo);
      const rows = await prisma.$queryRaw<{ designacao: string }[]>(Prisma.sql`
        SELECT p.designacao FROM "Produto" p
        WHERE 1 = 1
          ${cond}
          AND p.cnp = ANY(${[8322628, 90001, 90002, 90003, 90004]})
        ORDER BY p.designacao
      `);
      return rows.map((r) => r.designacao);
    }

    console.log("\n=== Os seis exemplos obrigatórios do pedido ===");

    const avene = await pesquisar("avene");
    check(avene.includes("Avène Eau Thermale"), '"avene" encontra "Avène Eau Thermale"', JSON.stringify(avene));
    check(avene.includes("AVENE Creme Solar"), '"avene" encontra "AVENE Creme Solar"', JSON.stringify(avene));
    check(avene.includes("Avene Xeracalm"), '"avene" encontra "Avene Xeracalm"', JSON.stringify(avene));
    check(!avene.includes("Outro produto qualquer, sem relação"), '"avene" NÃO traz produtos sem relação');

    const aveneAcento = await pesquisar("avéne");
    check(
      aveneAcento.includes("Avene Xeracalm"),
      '"avéne" (com acento) encontra "Avene Xeracalm" (sem acento)',
      JSON.stringify(aveneAcento),
    );
    check(aveneAcento.includes("Avène Eau Thermale"), '"avéne" encontra "Avène Eau Thermale"');

    const avene_maiusculas = await pesquisar("AVENE");
    check(
      avene_maiusculas.includes("Avène Eau Thermale"),
      '"AVENE" (maiúsculas) encontra "Avène Eau Thermale"',
      JSON.stringify(avene_maiusculas),
    );

    const ventilanMaiusculas = await pesquisar("VENTILAN");
    eq_arr(ventilanMaiusculas, ["VENTILAN INALADOR R AER 100 MCG/D 200 D"], '"VENTILAN" encontra o inalador — e só ele');

    const ventilanMinusculas = await pesquisar("ventilan");
    eq_arr(
      ventilanMinusculas,
      ["VENTILAN INALADOR R AER 100 MCG/D 200 D"],
      '"ventilan" (minúsculas) encontra o mesmo produto',
    );

    const porCnpParcial = await pesquisar("8322");
    eq_arr(porCnpParcial, ["VENTILAN INALADOR R AER 100 MCG/D 200 D"], '"8322" (CNP parcial) encontra o CNP 8322628');

    console.log("\n=== Eficiência: usa o índice, não sequential scan ===");
    const cond = construirCondicaoPesquisa("avene");
    const plano = await prisma.$queryRaw<{ "QUERY PLAN": string }[]>(Prisma.sql`
      EXPLAIN SELECT p.id FROM "Produto" p WHERE 1=1 ${cond}
    `);
    const planoTexto = plano.map((l) => l["QUERY PLAN"]).join("\n");
    check(
      /Bitmap Index Scan on "Produto_designacao_unaccent_trgm_idx"|Index.*unaccent_trgm/i.test(planoTexto),
      "o plano de execução usa o índice funcional — não filtra tudo em memória",
      planoTexto,
    );

    function eq_arr(obtido: string[], esperado: string[], label: string) {
      check(
        JSON.stringify([...obtido].sort()) === JSON.stringify([...esperado].sort()),
        label,
        `esperado ${JSON.stringify(esperado)}, obtido ${JSON.stringify(obtido)}`,
      );
    }
  } finally {
    await prisma.produto.deleteMany({ where: { cnp: { in: [8322628, 90001, 90002, 90003, 90004] } } });
    await prisma.$disconnect();
  }

  console.log(`\n${fail === 0 ? "PASSOU" : "FALHOU"} — ${pass} OK, ${fail} falhas\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
