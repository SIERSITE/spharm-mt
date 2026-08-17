/**
 * scripts/tests/test-control-schema.ts
 *
 * Prova que uma base construída EXCLUSIVAMENTE pelo histórico de
 * migrations satisfaz o `prisma-control/schema.prisma` actual.
 *
 * ── O que motivou isto ───────────────────────────────────────────────
 *
 *   Prisma P2022: The column CatalogoGlobal.fonteOriginal does not exist
 *
 * O modelo Prisma e a base tinham deixado de coincidir. Neste caso a
 * causa foi benigna — a migration existia e é que não estava aplicada —
 * mas o sintoma é indistinguível do caso mau: alguém acrescenta um campo
 * ao `schema.prisma`, corre `prisma generate`, tudo compila, os testes
 * passam, e o defeito só aparece na VPS quando o comando toca na coluna.
 *
 * Nada no repositório apanhava isso. `tsc` valida contra o cliente
 * gerado, que vem do `schema.prisma` — não da base. Compilar prova que o
 * código concorda com o modelo, nunca que o modelo é alcançável.
 *
 * ── Como se prova ────────────────────────────────────────────────────
 *
 *   1. base limpa → `prisma migrate deploy` → o histórico todo;
 *   2. `prisma migrate diff` contra o `schema.prisma`: tem de dar vazio;
 *   3. escrever mesmo, pelas duas vias do `promoverAoGlobal`, e ler de
 *      volta. O passo 2 compara estrutura; o 3 é o que apanha um P2022.
 *
 * Usa o `migrate deploy` real e não a reconstrução por shadow database:
 * é o caminho que corre em produção, incluindo o `ALTER TYPE ADD VALUE`
 * dentro da transacção da migration.
 *
 * ── Correr ───────────────────────────────────────────────────────────
 *
 *   docker run -d --rm --name pg-schema-test \
 *     -e POSTGRES_PASSWORD=teste -e POSTGRES_DB=controltest \
 *     -p 55433:5432 postgres:16-alpine
 *
 *   CONTROL_SCHEMA_TEST_URL=postgresql://postgres:teste@127.0.0.1:55433/controltest \
 *     npm run test:control-schema
 *
 * Sem `CONTROL_SCHEMA_TEST_URL` o teste é SALTADO — não inventa uma base
 * nem toca na que estiver no .env.
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";

let pass = 0;
let fail = 0;
const ok = (l: string) => { pass++; console.log(`  [OK]    ${l}`); };
const bad = (l: string, d?: string) => { fail++; console.log(`  [FALHA] ${l}${d ? `\n            ${d}` : ""}`); };
const check = (c: boolean, l: string, d?: string) => (c ? ok(l) : bad(l, d));

const URL_TESTE = process.env.CONTROL_SCHEMA_TEST_URL;

/**
 * Esta prova APAGA a base antes de a reconstruir. A guarda não é
 * cerimónia: o nome da variável é parecido com CONTROL_DATABASE_URL, e
 * um engano aqui apaga o control plane.
 */
function recusarSeNaoForDescartavel(url: string): void {
  const nome = url.split("/").pop()?.split("?")[0] ?? "";
  if (!/(test|teste|scratch|drift|tmp)/i.test(nome)) {
    console.error(
      `\nCONTROL_SCHEMA_TEST_URL aponta para a base "${nome}".\n` +
        "Este teste APAGA a base antes de a reconstruir e só aceita nomes\n" +
        "que se identifiquem como descartáveis (test/teste/scratch/drift/tmp).\n",
    );
    process.exit(2);
  }
  if (url === process.env.CONTROL_DATABASE_URL) {
    console.error("\nCONTROL_SCHEMA_TEST_URL é igual a CONTROL_DATABASE_URL. Recusado.\n");
    process.exit(2);
  }
}

function prisma(args: string[], url: string): { status: number; out: string } {
  const r = spawnSync("npx", ["prisma", ...args, "--config", "prisma-control.config.ts"], {
    encoding: "utf8",
    env: { ...process.env, CONTROL_DATABASE_URL: url, DATABASE_URL: url },
    shell: process.platform === "win32",
  });
  return { status: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

async function main(): Promise<void> {
  if (!URL_TESTE) {
    console.log("=== schema do control plane ===");
    console.log("  SALTADO — CONTROL_SCHEMA_TEST_URL não está definida.");
    console.log("  Ver o cabeçalho deste ficheiro para o comando do postgres descartável.");
    process.exit(0);
  }
  recusarSeNaoForDescartavel(URL_TESTE);

  // O cliente do control plane lê a variável no import. Tem de ser
  // definida ANTES, portanto o import é dinâmico.
  process.env.CONTROL_DATABASE_URL = URL_TESTE;
  const { PrismaClient } = await import("../../generated/prisma-control/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: URL_TESTE }) });

  console.log("=== base limpa, histórico completo ===");
  await db.$executeRawUnsafe("drop schema public cascade");
  await db.$executeRawUnsafe("create schema public");
  ok("base apagada — o que se segue vem só das migrations");

  const deploy = prisma(["migrate", "deploy"], URL_TESTE);
  check(deploy.status === 0, "prisma migrate deploy aplica o histórico todo", deploy.out.slice(-800));
  if (deploy.status !== 0) { console.log(`\n${pass} ok, ${fail} falhas`); process.exit(1); }

  console.log("\n=== o histórico reproduz o schema.prisma ===");
  // --exit-code: 0 vazio, 2 não-vazio. Um diff não-vazio É a divergência.
  const diff = prisma(
    ["migrate", "diff", "--from-config-datasource", "--to-schema", "prisma-control/schema.prisma", "--script", "--exit-code"],
    URL_TESTE,
  );
  check(
    diff.status === 0,
    "não há diferença entre a base migrada e o modelo Prisma",
    diff.status === 2 ? `FALTA MIGRATION PARA:\n${diff.out}` : diff.out.slice(-800),
  );

  console.log("\n=== escrever mesmo: é isto que apanha um P2022 ===");
  // Duas vias do promoverAoGlobal, e todas as colunas das migrations
  // pendentes: fonteOriginal, promovido*, e a tabela do rasto.
  const { promoverAoGlobal } = await import("../../lib/catalog/global-catalog-store");

  const base = {
    designacaoReferencia: "Produto de prova",
    productType: "MEDICAMENTO",
    confidence: 0.9,
    evidenceType: "MARCA_CONHECIDA",
    motivoOrigem: "regras determinísticas do catálogo (fill-rules)",
    fonteOriginal: "TEXT_PATTERN",
    versaoRegras: "ke-teste",
    verificado: false,
    tenantOrigem: "tenant-de-prova",
  };
  const util = (slug: string) => ({
    slug, confidence: 0.9, origem: "DETERMINISTICA" as const,
    fonteOriginal: "REGRA", motivo: "regra do catálogo",
  });

  const candidatos = [
    { ...base, cnp: 9000001, categoria: "MEDICAMENTOS", subcategoria: "Diabetes", origem: "DETERMINISTICA" as const, utilizacoes: [util("diabetes")] },
    // A via que não existia: sem classificação específica, só utilizações.
    { ...base, cnp: 9000002, categoria: null, subcategoria: null, origem: "DETERMINISTICA" as const, utilizacoes: [util("gripe")] },
  ];

  let r;
  try {
    r = await promoverAoGlobal(candidatos, { actor: "test:control-schema" });
    ok("promoverAoGlobal escreve sem P2022 — as duas vias");
  } catch (err) {
    bad("promoverAoGlobal falhou", err instanceof Error ? err.message : String(err));
    console.log(`\n${pass} ok, ${fail} falhas`);
    process.exit(1);
  }

  check(r.produtosPromovidos === 2, `os dois produtos sobem (${r.produtosPromovidos})`);
  check(r.classificacoesPromovidas === 1, `uma classificação (${r.classificacoesPromovidas})`);
  check(r.utilizacoesPromovidas === 2, `duas utilizações (${r.utilizacoesPromovidas})`);

  const comClasse = await db.catalogoGlobal.findUnique({ where: { cnp: 9000001 } });
  check(comClasse?.fonteOriginal === "TEXT_PATTERN", "fonteOriginal ficou gravada — a coluna do P2022");
  check(comClasse?.origem === "DETERMINISTICA", "DETERMINISTICA é aceite pelo enum da base");
  check(comClasse?.promovidoPor === "test:control-schema", "promovidoPor ficou gravada");
  check(!!comClasse?.promovidoEm, "promovidoEm ficou gravada");
  check(comClasse?.promovidoDeTenant === "tenant-de-prova", "promovidoDeTenant ficou gravada");

  const soUtil = await db.catalogoGlobal.findUnique({ where: { cnp: 9000002 } });
  check(!!soUtil && soUtil.categoria === null, "a linha só-utilizações existe e sem classificação");
  check((await db.catalogoGlobalUtilizacao.count()) === 2, "as utilizações ficaram na tabela própria");
  check((await db.catalogoGlobalPromocao.count()) === 2, "o rasto de auditoria tem uma linha por promoção");

  console.log("\n=== idempotência contra a base real ===");
  const segunda = await promoverAoGlobal(candidatos, { actor: "test:control-schema" });
  check(segunda.produtosPromovidos === 0, `a segunda corrida não escreve nada (${segunda.produtosPromovidos})`);
  check((await db.catalogoGlobalPromocao.count()) === 2, "…e não acrescenta linhas ao rasto");

  await db.$disconnect();
  console.log(`\n${pass} ok, ${fail} falhas`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\n[erro fatal]", err);
  process.exit(1);
});
