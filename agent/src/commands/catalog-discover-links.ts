/**
 * agent/src/commands/catalog-discover-links.ts
 *
 * Descoberta de relações por METADADOS. Read-only.
 *
 * O catalog-audit procurava tabelas por nome e foi até onde o nome dava:
 * provou o Fabricante e falhou o Grupo Homogéneo e a DCI. O ERP é mais
 * normalizado do que parecia, por isso a descoberta tem de passar das
 * tabelas para as RELAÇÕES: sys.columns, sys.foreign_keys, sys.indexes.
 *
 * Procura as colunas-chave em TODAS as tabelas, sem presumir onde vivem:
 *   GrupoHomID · SPRActID · Codigo · CNP · CodigoProduto · ProdutoID · StockID
 *
 * Para cada tabela encontrada devolve PK, FKs (de saída e de entrada),
 * contagem, tipos e as primeiras 10 linhas.
 *
 * Para as que tenham GrupoHomID ou SPRActID vai mais longe e testa a
 * ligação a dbo.Stocks por CONTEÚDO: quantos valores da coluna existem
 * mesmo em Stocks.[Codigo] e em Stocks.[CodigoID]. É a diferença entre
 * "esta coluna chama-se Codigo" e "esta coluna contém CNPs que existem
 * no catálogo" — e é a única evidência que justifica escrever um JOIN.
 *
 * Uso: agent catalog-discover-links
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import sql from "mssql";
import { loadConfig } from "../config.js";
import { withPool, type SqlPool } from "../sql-client.js";

const RULE = "=".repeat(72);

/** Colunas-chave a caçar em todo o esquema. Sem procurar nomes de tabela. */
const COLUNAS_CHAVE = [
  "GrupoHomID",
  "SPRActID",
  "Codigo",
  "CNP",
  "CodigoProduto",
  "ProdutoID",
  "StockID",
];

/** As que merecem análise de ligação a Stocks. */
const APROFUNDAR = new Set(["GrupoHomID", "SPRActID"]);

type Col = { coluna: string; tipo: string; tam: number; nullable: boolean };
type Fk = { nome: string; deColuna: string; paraTabela: string; paraColuna: string };
type Tabela = {
  tabela: string;
  encontradaPor: string[];
  linhas: number;
  pk: string[];
  colunas: Col[];
  fksSaida: Fk[];
  fksEntrada: Fk[];
  amostra: Array<Record<string, unknown>>;
  ligacoesAStocks?: Array<{ coluna: string; contra: string; testados: number; casam: number; pct: string }>;
};

async function q<T>(pool: SqlPool, text: string, p?: { n: string; v: string }): Promise<T[]> {
  try {
    const req = pool.request();
    if (p) req.input(p.n, sql.NVarChar, p.v);
    const r = await req.query(text);
    return r.recordset as T[];
  } catch (err) {
    console.log(`   (query falhou: ${err instanceof Error ? err.message : err})`);
    return [];
  }
}

export async function catalogDiscoverLinks(): Promise<number> {
  let cfg;
  try {
    cfg = loadConfig("sql");
  } catch (err) {
    console.error("Config invalida:");
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  console.log(RULE);
  console.log("  Descoberta de relacoes por metadados");
  console.log("  Read-only. Nada e escrito no ERP.");
  console.log(RULE);

  return withPool(cfg, async (pool) => {
    // 1. Que tabelas têm cada coluna-chave. Uma tabela pode aparecer por
    //    mais do que uma — é isso que a torna candidata a junção.
    const porTabela = new Map<string, Set<string>>();
    for (const nome of COLUNAS_CHAVE) {
      const rs = await q<{ tabela: string }>(
        pool,
        `SELECT s.name + '.' + t.name AS tabela
         FROM sys.columns c
         JOIN sys.tables t ON t.object_id = c.object_id
         JOIN sys.schemas s ON s.schema_id = t.schema_id
         WHERE s.name = 'dbo' AND c.name = @n`,
        { n: "n", v: nome },
      );
      console.log(`  ${nome.padEnd(15)} ${rs.length} tabela(s)`);
      for (const r of rs) {
        if (!porTabela.has(r.tabela)) porTabela.set(r.tabela, new Set());
        porTabela.get(r.tabela)!.add(nome);
      }
    }
    console.log(`\n  tabelas distintas: ${porTabela.size}\n`);

    const out: Tabela[] = [];
    for (const [full, achadas] of porTabela) {
      const [sch, tab] = full.split(".");

      const colunas = await q<Col>(
        pool,
        `SELECT c.name AS coluna, ty.name AS tipo, c.max_length AS tam, c.is_nullable AS nullable
         FROM sys.columns c
         JOIN sys.tables t ON t.object_id = c.object_id
         JOIN sys.schemas s ON s.schema_id = t.schema_id
         JOIN sys.types ty ON ty.user_type_id = c.user_type_id
         WHERE s.name = '${sch}' AND t.name = '${tab}'
         ORDER BY c.column_id`,
      );
      const pk = (
        await q<{ col: string }>(
          pool,
          `SELECT c.name AS col
           FROM sys.indexes i
           JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id
           JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id
           JOIN sys.tables t ON t.object_id=i.object_id
           JOIN sys.schemas s ON s.schema_id=t.schema_id
           WHERE i.is_primary_key=1 AND s.name='${sch}' AND t.name='${tab}'
           ORDER BY ic.key_ordinal`,
        )
      ).map((x) => x.col);

      const fkSql = (dir: "saida" | "entrada") => `
        SELECT fk.name AS nome, pc.name AS deColuna,
               OBJECT_NAME(fk.referenced_object_id) AS paraTabela, rc.name AS paraColuna
        FROM sys.foreign_keys fk
        JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
        JOIN sys.columns pc ON pc.object_id=fkc.parent_object_id AND pc.column_id=fkc.parent_column_id
        JOIN sys.columns rc ON rc.object_id=fkc.referenced_object_id AND rc.column_id=fkc.referenced_column_id
        JOIN sys.tables xt ON xt.object_id = ${dir === "saida" ? "fk.parent_object_id" : "fk.referenced_object_id"}
        JOIN sys.schemas xs ON xs.schema_id = xt.schema_id
        WHERE xs.name='${sch}' AND xt.name='${tab}'`;
      const fksSaida = await q<Fk>(pool, fkSql("saida"));
      const fksEntrada = await q<Fk>(pool, fkSql("entrada"));

      const cnt = await q<{ n: number }>(pool, `SELECT COUNT(*) AS n FROM [${sch}].[${tab}] WITH (NOLOCK)`);
      const linhas = Number(cnt[0]?.n ?? 0);
      const amostra =
        linhas > 0
          ? await q<Record<string, unknown>>(pool, `SELECT TOP 10 * FROM [${sch}].[${tab}] WITH (NOLOCK)`)
          : [];

      const t: Tabela = {
        tabela: full,
        encontradaPor: [...achadas],
        linhas,
        pk,
        colunas,
        fksSaida,
        fksEntrada,
        amostra,
      };

      // 2. Ligação a Stocks por CONTEÚDO, só para as que interessam.
      //    Um nome igual não prova nada; valores que existem em Stocks sim.
      if ([...achadas].some((a) => APROFUNDAR.has(a)) && linhas > 0) {
        t.ligacoesAStocks = [];
        const numericas = colunas.filter((c) => /int/i.test(c.tipo));
        for (const c of numericas.slice(0, 12)) {
          for (const alvo of ["Codigo", "CodigoID"]) {
            const r = await q<{ testados: number; casam: number }>(
              pool,
              `SELECT COUNT(*) AS testados,
                      SUM(CASE WHEN EXISTS (SELECT 1 FROM [dbo].[Stocks] st WITH (NOLOCK)
                                             WHERE st.[${alvo}] = x.[${c.coluna}]) THEN 1 ELSE 0 END) AS casam
               FROM (SELECT TOP 500 [${c.coluna}] FROM [${sch}].[${tab}] WITH (NOLOCK)
                     WHERE [${c.coluna}] IS NOT NULL) x`,
            );
            const testados = Number(r[0]?.testados ?? 0);
            const casam = Number(r[0]?.casam ?? 0);
            if (testados > 0 && casam > 0) {
              t.ligacoesAStocks.push({
                coluna: c.coluna,
                contra: `Stocks.[${alvo}]`,
                testados,
                casam,
                pct: `${((casam / testados) * 100).toFixed(1)}%`,
              });
            }
          }
        }
      }

      out.push(t);
    }

    // 3. Ecrã: o essencial para decidir; o detalhe fica no JSON.
    for (const t of out.sort((a, b) => b.linhas - a.linhas)) {
      console.log(`\n${t.tabela}  (${t.linhas} linhas)  [${t.encontradaPor.join(", ")}]`);
      console.log(`   PK: ${t.pk.join(" + ") || "(nenhuma)"}`);
      console.log(`   colunas: ${t.colunas.map((c) => `${c.coluna}:${c.tipo}`).join(", ").slice(0, 220)}`);
      for (const f of t.fksSaida) console.log(`   FK-> [${f.deColuna}] -> ${f.paraTabela}.[${f.paraColuna}]`);
      for (const f of t.fksEntrada) console.log(`   FK<- ${f.paraTabela}.[${f.paraColuna}] <- [${f.deColuna}]`);
      for (const l of t.ligacoesAStocks ?? []) {
        console.log(`   LIGA? [${l.coluna}] vs ${l.contra}: ${l.casam}/${l.testados} (${l.pct})`);
      }
      for (const r of t.amostra.slice(0, 3)) console.log(`   ex: ${JSON.stringify(r).slice(0, 180)}`);
    }

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    if (!existsSync("./run")) mkdirSync("./run", { recursive: true });
    const p = path.join("./run", `catalog-discover-links-${ts}.json`);
    writeFileSync(p, JSON.stringify({ geradoEm: ts, colunasProcuradas: COLUNAS_CHAVE, tabelas: out }, null, 2), "utf8");
    console.log(`\n${RULE}`);
    console.log(`  JSON: ${p}`);
    console.log(RULE);
    return 0;
  });
}
