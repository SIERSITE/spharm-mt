/**
 * scripts/tests/test-utilizacoes-constraints.ts
 *
 * Prova, contra a base real, que o seed e os backfills podem correr
 * quantas vezes forem precisos sem duplicar nada.
 *
 * Não basta ler o schema: o que interessa é o que a base aceita. Estas
 * asserções tentam mesmo inserir duplicados dentro de uma transação que
 * é sempre revertida — se a base os aceitar, o teste falha aqui em vez
 * de o problema aparecer como associações a dobrar daqui a três meses.
 *
 * Uso: npx tsx scripts/tests/test-utilizacoes-constraints.ts [--db=<base>]
 */
import "dotenv/config";
import pg from "pg";

async function main() {
  const argv = process.argv.slice(2);
  const dbName =
    argv.find((a) => a.startsWith("--db="))?.split("=")[1] ?? "spharmmt_t_grupo_silveira";
  const url = process.env.DATABASE_URL!.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
  const db = new pg.Client({ connectionString: url });
  await db.connect();

  let pass = 0;
  let fail = 0;
  const check = (cond: boolean, l: string, d?: string) => {
    if (cond) { pass++; console.log(`  [OK]    ${l}`); }
    else { fail++; console.log(`  [FALHA] ${l}${d ? `\n            ${d}` : ""}`); }
  };

  console.log(`Base: ${dbName}\n`);
  console.log("=== as restrições existem ===");

  const { rows: idx } = await db.query<{ indexname: string; indexdef: string }>(
    `select indexname, indexdef from pg_indexes
      where tablename in ('Utilizacao','ProdutoUtilizacao')`,
  );
  check(
    idx.some((i) => /UNIQUE/i.test(i.indexdef) && /\(slug\)/.test(i.indexdef)),
    "Utilizacao: índice único por slug",
    idx.map((i) => i.indexname).join(", "),
  );
  check(
    idx.some((i) => /UNIQUE/i.test(i.indexdef) && /produtoId/.test(i.indexdef) && /utilizacaoId/.test(i.indexdef)),
    "ProdutoUtilizacao: unicidade (produtoId, utilizacaoId)",
  );

  const { rows: fks } = await db.query<{ conname: string }>(
    `select conname from pg_constraint
      where conrelid = '"ProdutoUtilizacao"'::regclass and contype = 'f'`,
  );
  check(fks.length === 2, "ProdutoUtilizacao: FKs para Produto e Utilizacao", `${fks.length} encontradas`);

  console.log("\n=== a base recusa mesmo os duplicados ===");
  // Tudo dentro de uma transação revertida no fim: não fica nada escrito.
  await db.query("begin");
  try {
    await db.query(
      `insert into "Utilizacao" (id, slug, nome, "dataAtualizacao")
       values ('t_probe_1', '__probe__', 'Probe', now())`,
    );
    let recusou = false;
    try {
      await db.query(
        `insert into "Utilizacao" (id, slug, nome, "dataAtualizacao")
         values ('t_probe_2', '__probe__', 'Probe repetida', now())`,
      );
    } catch {
      recusou = true;
    }
    check(recusou, "segundo slug igual é recusado");

    // Rollback ao savepoint: o erro anterior aborta a transação.
    await db.query("rollback");
    await db.query("begin");

    const { rows: p } = await db.query<{ id: string }>(`select id from "Produto" limit 1`);
    if (!p[0]) {
      console.log("  [aviso] sem produtos nesta base — duplicação de associação não testada");
    } else {
      await db.query(
        `insert into "Utilizacao" (id, slug, nome, "dataAtualizacao")
         values ('t_probe_3', '__probe2__', 'Probe', now())`,
      );
      await db.query(
        `insert into "ProdutoUtilizacao" ("produtoId", "utilizacaoId", fonte)
         values ($1, 't_probe_3', 'TESTE')`,
        [p[0].id],
      );
      let recusou2 = false;
      try {
        await db.query(
          `insert into "ProdutoUtilizacao" ("produtoId", "utilizacaoId", fonte)
           values ($1, 't_probe_3', 'TESTE OUTRA VEZ')`,
          [p[0].id],
        );
      } catch {
        recusou2 = true;
      }
      check(recusou2, "associação repetida do mesmo par é recusada");
    }
  } finally {
    await db.query("rollback");
  }

  console.log("\n=== o backfill não pisa trabalho humano ===");
  // O UPSERT do backfill, palavra por palavra. Se a cláusula WHERE for
  // relaxada num refactor, é aqui que se percebe — e não quando um
  // farmacêutico vir a sua correcção desfeita por uma passagem nocturna.
  const UPSERT = `insert into "ProdutoUtilizacao" ("produtoId", "utilizacaoId", fonte, confianca)
     values ($1, $2, $3, $4)
     on conflict ("produtoId", "utilizacaoId") do update
        set fonte = excluded.fonte, confianca = excluded.confianca
      where "ProdutoUtilizacao".fonte <> 'MANUAL'
        and excluded.confianca > coalesce("ProdutoUtilizacao".confianca, 0)
     returning 1`;

  await db.query("begin");
  try {
    const { rows: p } = await db.query<{ id: string }>(`select id from "Produto" limit 1`);
    if (!p[0]) {
      console.log("  [aviso] sem produtos nesta base — não testado");
    } else {
      await db.query(
        `insert into "Utilizacao" (id, slug, nome, "dataAtualizacao")
         values ('t_probe_4', '__probe3__', 'Probe', now())`,
      );

      // Associação humana, sem confiança — é uma decisão, não uma estimativa.
      await db.query(
        `insert into "ProdutoUtilizacao" ("produtoId", "utilizacaoId", fonte, confianca)
         values ($1, 't_probe_4', 'MANUAL', null)`,
        [p[0].id],
      );
      await db.query(UPSERT, [p[0].id, "t_probe_4", "REGRA", 0.99]);
      const { rows: depois } = await db.query<{ fonte: string }>(
        `select fonte from "ProdutoUtilizacao" where "produtoId" = $1 and "utilizacaoId" = 't_probe_4'`,
        [p[0].id],
      );
      check(depois[0]?.fonte === "MANUAL", "MANUAL resiste a REGRA com confiança 0.99");

      // Entre automáticas, a mais forte ganha e a mais fraca não desfaz.
      await db.query(
        `update "ProdutoUtilizacao" set fonte = 'REGRA', confianca = 0.85
          where "produtoId" = $1 and "utilizacaoId" = 't_probe_4'`,
        [p[0].id],
      );
      await db.query(UPSERT, [p[0].id, "t_probe_4", "REGRA", 0.95]);
      const { rows: subiu } = await db.query<{ confianca: number }>(
        `select confianca from "ProdutoUtilizacao" where "produtoId" = $1 and "utilizacaoId" = 't_probe_4'`,
        [p[0].id],
      );
      check(Number(subiu[0]?.confianca) === 0.95, "automática cede a confiança superior");

      await db.query(UPSERT, [p[0].id, "t_probe_4", "REGRA", 0.5]);
      const { rows: manteve } = await db.query<{ confianca: number }>(
        `select confianca from "ProdutoUtilizacao" where "produtoId" = $1 and "utilizacaoId" = 't_probe_4'`,
        [p[0].id],
      );
      check(Number(manteve[0]?.confianca) === 0.95, "automática NÃO cede a confiança inferior");
    }
  } finally {
    await db.query("rollback");
  }

  const { rows: sujidade } = await db.query<{ n: string }>(
    `select count(*)::text as n from "Utilizacao" where slug like '\\_\\_probe%'`,
  );
  check(sujidade[0]?.n === "0", "nada ficou escrito pelo teste");

  await db.end();
  console.log(`\n${pass} ok, ${fail} falhas`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
