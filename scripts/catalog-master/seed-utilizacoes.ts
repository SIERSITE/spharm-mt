/**
 * scripts/catalog-master/seed-utilizacoes.ts
 *
 * Põe o vocabulário controlado de utilizações na base de um tenant.
 *
 * Idempotente por `slug`: correr as vezes que forem precisas. É assim que
 * o vocabulário se mantém igual em todos os tenants — o ficheiro
 * lib/catalog/utilizacoes.ts é a origem única, e cada base é alinhada com
 * ele em vez de ter a sua própria lista.
 *
 * Nunca apaga. Uma utilização retirada da lista passa a INATIVO — sai da
 * pesquisa e mantém as associações que já existem. Apagar arrastaria por
 * CASCADE trabalho de classificação que ninguém pediu para desfazer.
 *
 * Uso:
 *   npx tsx scripts/catalog-master/seed-utilizacoes.ts [--db=<base>] [--dry-run]
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { UTILIZACOES } from "../../lib/catalog/utilizacoes";
import { AlvoRecusado, descreverAlvo, resolverAlvoDb } from "../../lib/catalog/target-db";

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");

  let alvo;
  try {
    alvo = resolverAlvoDb(argv);
  } catch (err) {
    if (err instanceof AlvoRecusado) {
      console.error(`\n${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  const db = new pg.Client({ connectionString: alvo.url });
  await db.connect();

  console.log(`${descreverAlvo(alvo)}${dryRun ? "   (dry-run — nada é escrito)" : ""}`);
  console.log(`Vocabulário: ${UTILIZACOES.length} utilizações\n`);

  const { rows: antes } = await db.query<{ slug: string; estado: string }>(
    `select slug, estado from "Utilizacao"`,
  );
  const existentes = new Map(antes.map((r) => [r.slug, r.estado]));

  const activos = UTILIZACOES.filter((u) => !u.descontinuada);
  let novas = 0;
  let actualizadas = 0;

  for (const [i, u] of activos.entries()) {
    if (!existentes.has(u.slug)) novas++;
    else actualizadas++;
    if (dryRun) continue;

    // O slug é a chave natural; o id só existe porque o Prisma o exige.
    await db.query(
      `insert into "Utilizacao"
         (id, slug, nome, descricao, sinonimos, grupo, estado, ordem, "dataCriacao", "dataAtualizacao")
       values ($1, $2, $3, $4, $5, $6, 'ATIVO', $7, now(), now())
       on conflict (slug) do update set
         nome              = excluded.nome,
         descricao         = excluded.descricao,
         sinonimos         = excluded.sinonimos,
         grupo             = excluded.grupo,
         estado            = 'ATIVO',
         ordem             = excluded.ordem,
         "dataAtualizacao" = now()`,
      [randomUUID(), u.slug, u.nome, u.descricao, u.sinonimos, u.grupo, i],
    );
  }

  // Retiradas da lista: desactivar, nunca apagar.
  const slugsActivos = activos.map((u) => u.slug);
  const orfas = antes.filter((r) => !slugsActivos.includes(r.slug) && r.estado === "ATIVO");
  if (orfas.length && !dryRun) {
    await db.query(
      `update "Utilizacao" set estado = 'INATIVO', "dataAtualizacao" = now()
        where slug <> all($1::text[])`,
      [slugsActivos],
    );
  }

  const { rows: assoc } = await db.query<{ n: string }>(
    `select count(*)::text as n from "ProdutoUtilizacao"`,
  );

  console.log(`  novas            ${novas}`);
  console.log(`  actualizadas     ${actualizadas}`);
  console.log(`  desactivadas     ${orfas.length}${orfas.length ? `  (${orfas.map((o) => o.slug).join(", ")})` : ""}`);
  console.log(`  associações      ${assoc[0]?.n ?? 0} produto<->utilização já existentes (intactas)`);

  await db.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
