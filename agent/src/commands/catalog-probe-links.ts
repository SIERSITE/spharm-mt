/**
 * agent/src/commands/catalog-probe-links.ts
 *
 * Probe read-only para as DUAS ligações que o catalog-audit NÃO provou.
 *
 *  1. Stocks -> Grupo Homogéneo. `dbo.Stocks_GrupoHom` (1002 linhas,
 *     GrupoHomID char(6) + Descr) é o MESTRE dos grupos, não uma tabela
 *     de associação: não tem coluna de produto. E não há coluna em Stocks
 *     a apontar-lhe, nem FK declarada. A ligação existe noutro sítio.
 *
 *  2. tblSPRActGenerico -> DCI. Liga a Stocks por [Codigo] (é o CNP:
 *     5641923), mas não tem texto de DCI — só [SPRActID]. O texto estará
 *     numa tabela SPR* que o audit não apanhou porque o nome não casa com
 *     nenhum padrão de DCI.
 *
 * Procura por ESTRUTURA e por CONTEÚDO, nunca por nomenclatura: colunas
 * chamadas GrupoHom em qualquer tabela, colunas curtas cujos VALORES
 * casem com 'GH____', e a família SPR* inteira com amostras. É isto que
 * evita adivinhar chaves.
 *
 * Read-only puro. Uso: agent catalog-probe-links
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { withPool, type SqlPool } from "../sql-client.js";

const RULE = "=".repeat(72);

async function q<T>(pool: SqlPool, text: string): Promise<T[]> {
  try {
    const r = await pool.request().query(text);
    return r.recordset as T[];
  } catch (err) {
    console.log(`   (query falhou: ${err instanceof Error ? err.message : err})`);
    return [];
  }
}

export async function catalogProbeLinks(): Promise<number> {
  let cfg;
  try {
    cfg = loadConfig("sql");
  } catch (err) {
    console.error("Config invalida:");
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  console.log(RULE);
  console.log("  Probe de ligacoes: Grupo Homogeneo e DCI");
  console.log("  Read-only. Nada e escrito no ERP.");
  console.log(RULE);

  return withPool(cfg, async (pool) => {
    const out: Record<string, unknown> = {};

    console.log("\n[1] Colunas com 'GrupoHom' no nome, em QUALQUER tabela");
    const ghCols = await q<{ tabela: string; coluna: string; tipo: string; linhas: number }>(
      pool,
      `SELECT s.name + '.' + t.name AS tabela, c.name AS coluna, ty.name AS tipo,
              ISNULL(p.rows, 0) AS linhas
       FROM sys.columns c
       JOIN sys.tables t ON t.object_id = c.object_id
       JOIN sys.schemas s ON s.schema_id = t.schema_id
       JOIN sys.types ty ON ty.user_type_id = c.user_type_id
       OUTER APPLY (SELECT TOP 1 rows FROM sys.partitions
                    WHERE object_id = t.object_id AND index_id IN (0,1)) p
       WHERE s.name = 'dbo' AND c.name LIKE '%GrupoHom%'
       ORDER BY p.rows DESC`,
    );
    out.colunasGrupoHom = ghCols;
    for (const c of ghCols) {
      console.log(`   ${c.tabela}.[${c.coluna}] ${c.tipo} - ${c.linhas} linhas`);
    }
    if (!ghCols.length) console.log("   (nenhuma)");

    console.log("\n[2] Colunas curtas cujos VALORES casam com 'GH____'");
    const curtas = await q<{ tabela: string; coluna: string; n: number }>(
      pool,
      `SELECT s.name + '.' + t.name AS tabela, c.name AS coluna, ISNULL(p.rows,0) AS n
       FROM sys.columns c
       JOIN sys.tables t ON t.object_id = c.object_id
       JOIN sys.schemas s ON s.schema_id = t.schema_id
       JOIN sys.types ty ON ty.user_type_id = c.user_type_id
       OUTER APPLY (SELECT TOP 1 rows FROM sys.partitions
                    WHERE object_id = t.object_id AND index_id IN (0,1)) p
       WHERE s.name = 'dbo' AND ty.name IN ('char','varchar','nchar','nvarchar')
         AND c.max_length BETWEEN 6 AND 16 AND ISNULL(p.rows,0) > 0
         AND t.name <> 'Stocks_GrupoHom'
       ORDER BY p.rows DESC`,
    );
    const comGH: unknown[] = [];
    for (const c of curtas.slice(0, 400)) {
      const [sch, tab] = c.tabela.split(".");
      const hit = await q<{ n: number; ex: string }>(
        pool,
        `SELECT COUNT(*) AS n, MIN([${c.coluna}]) AS ex
         FROM [${sch}].[${tab}] WITH (NOLOCK)
         WHERE [${c.coluna}] LIKE 'GH[0-9][0-9][0-9][0-9]'`,
      );
      if (hit[0] && Number(hit[0].n) > 0) {
        console.log(`   ${c.tabela}.[${c.coluna}] - ${hit[0].n} valores GH____ (ex.: ${hit[0].ex})`);
        comGH.push({ tabela: c.tabela, coluna: c.coluna, matches: hit[0].n, exemplo: hit[0].ex });
      }
    }
    out.colunasComValoresGH = comGH;
    if (!comGH.length) console.log("   (nenhuma)");

    console.log("\n[3] Familia SPR* - tabelas e colunas");
    const spr = await q<{ tabela: string; coluna: string; tipo: string; tam: number; linhas: number }>(
      pool,
      `SELECT t.name AS tabela, c.name AS coluna, ty.name AS tipo, c.max_length AS tam,
              ISNULL(p.rows,0) AS linhas
       FROM sys.tables t
       JOIN sys.schemas s ON s.schema_id = t.schema_id
       JOIN sys.columns c ON c.object_id = t.object_id
       JOIN sys.types ty ON ty.user_type_id = c.user_type_id
       OUTER APPLY (SELECT TOP 1 rows FROM sys.partitions
                    WHERE object_id = t.object_id AND index_id IN (0,1)) p
       WHERE s.name = 'dbo' AND t.name LIKE '%SPR%'
       ORDER BY t.name, c.column_id`,
    );
    out.familiaSPR = spr;
    let atual = "";
    for (const c of spr) {
      if (c.tabela !== atual) {
        atual = c.tabela;
        console.log(`   ${atual} (${c.linhas} linhas)`);
      }
      const tam = /char/i.test(c.tipo) ? `(${c.tam})` : "";
      console.log(`      [${c.coluna}] ${c.tipo}${tam}`);
    }
    if (!spr.length) console.log("   (nenhuma)");

    console.log("\n[4] Amostras das tabelas SPR* com colunas de texto");
    const comTexto = [
      ...new Set(
        spr.filter((c) => /char/i.test(c.tipo) && c.tam >= 20 && c.linhas > 0).map((c) => c.tabela),
      ),
    ];
    const amostras: Record<string, unknown> = {};
    for (const t of comTexto.slice(0, 8)) {
      const rows = await q<Record<string, unknown>>(pool, `SELECT TOP 5 * FROM [dbo].[${t}] WITH (NOLOCK)`);
      console.log(`   ${t}:`);
      for (const r of rows) console.log(`      ${JSON.stringify(r).slice(0, 190)}`);
      amostras[t] = rows;
    }
    out.amostrasSPR = amostras;

    console.log("\n[5] tblSPRActGenerico.[Codigo] casa com Stocks.[Codigo]?");
    const casa = await q<{ total: number; casam: number }>(
      pool,
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN EXISTS (SELECT 1 FROM [dbo].[Stocks] st WITH (NOLOCK)
                                     WHERE st.[Codigo] = g.[Codigo]) THEN 1 ELSE 0 END) AS casam
       FROM [dbo].[tblSPRActGenerico] g WITH (NOLOCK)`,
    );
    out.spractGenericoVsStocks = casa[0] ?? null;
    if (casa[0]) console.log(`   ${casa[0].casam}/${casa[0].total} codigos existem em Stocks.[Codigo]`);

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    if (!existsSync("./run")) mkdirSync("./run", { recursive: true });
    const jsonPath = path.join("./run", `catalog-probe-links-${ts}.json`);
    writeFileSync(jsonPath, JSON.stringify(out, null, 2), "utf8");
    console.log(`\n${RULE}`);
    console.log(`  JSON: ${jsonPath}`);
    console.log(RULE);
    return 0;
  });
}
