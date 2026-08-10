/**
 * agent/src/commands/catalog-audit.ts
 *
 * Auditoria read-only ao universo de CATÁLOGO REGULAMENTAR do ERP
 * SPharm/Softreis. Mesmo padrão do `iva-audit` e do `movimentos-audit`:
 * localiza onde vivem DCI, ATC, Grupo Homogéneo e Fabricante sem que o
 * operador escreva uma linha de SQL, e sem que ninguém adivinhe nomes de
 * colunas.
 *
 * Porque é preciso: os nomes variam entre instalações Softreis. Assumir
 * `Stocks.[DCI]` e estar errado produz silenciosamente um catálogo vazio.
 * Esta auditoria devolve os nomes REAIS, com evidência.
 *
 * Cada conceito é procurado em três sítios:
 *   1. Coluna directa em `dbo.Stocks` (valor ou código)
 *   2. FK declarada de Stocks para uma tabela de lookup (sinal mais forte)
 *   3. Tabelas candidatas por padrão de nome, com PK, contagem e amostra
 *
 * Para cada coluna encontrada em Stocks reporta taxa de preenchimento,
 * cardinalidade e amostra de valores — é o que distingue uma coluna de
 * texto ("Paracetamol") de uma coluna de código (17), e uma coluna viva
 * de uma coluna que existe mas está toda a NULL.
 *
 * Output:
 *   ./run/catalog-audit-<timestamp>.md
 *   ./run/catalog-audit-<timestamp>.json
 *
 * NÃO comunica com o SaaS. NÃO escreve no ERP. Só `sys.*` e `SELECT TOP`.
 *
 * Uso:
 *   agent catalog-audit
 *   agent catalog-audit --out-dir .\run --samples 15
 */

import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import sql from "mssql";
import { loadConfig } from "../config.js";
import { withPool, type SqlPool } from "../sql-client.js";
import { tableExists, listColumns, type ColumnMeta } from "./probe-helpers.js";

const RULE = "═".repeat(72);
const DEFAULT_SAMPLES = 10;

/**
 * Os quatro conceitos a localizar. `colunaPatterns` procura em
 * `dbo.Stocks`; `tabelaPatterns` procura tabelas de lookup.
 *
 * Os padrões são deliberadamente largos: é melhor listar candidatos a
 * mais e deixar a evidência ordenar, do que falhar a coluna certa por
 * ela se chamar algo inesperado. LIKE em SQL Server é case-insensitive
 * na collation habitual do Softreis, mas mantemos variantes por
 * segurança em instalações com collation binária.
 */
const CONCEITOS = [
  {
    id: "DCI",
    titulo: "DCI / substância activa",
    colunaPatterns: ["%dci%", "%substanc%", "%substânc%", "%principio%", "%princípio%", "%activ%", "%ativ%"],
    tabelaPatterns: ["%DCI%", "%Substanc%", "%Principio%", "%Generico%", "%Generic%"],
  },
  {
    id: "ATC",
    titulo: "Código ATC",
    colunaPatterns: ["%atc%", "%classificacao terap%", "%class terap%"],
    tabelaPatterns: ["%ATC%", "%Terapeut%", "%Farmacoterap%"],
  },
  {
    id: "GRUPO_HOMOGENEO",
    titulo: "Grupo Homogéneo",
    colunaPatterns: ["%homog%", "%grupo hom%", "%gh%", "%grp hom%", "%referenc%", "%referênc%"],
    tabelaPatterns: ["%Homog%", "%GrupoHom%", "%Grupo_Hom%", "%Referencia%", "%PrecoRef%"],
  },
  {
    id: "FABRICANTE",
    titulo: "Fabricante / laboratório / titular",
    colunaPatterns: ["%fabric%", "%laborat%", "%titular%", "%marca%", "%lab %", "%_lab%", "%lab_%"],
    tabelaPatterns: ["%Fabric%", "%Laborat%", "%Titular%", "%Marca%"],
  },
] as const;

type ConceitoId = (typeof CONCEITOS)[number]["id"];

type ColunaStocks = {
  nome: string;
  tipo: string;
  /** Linhas com valor não-NULL, sobre o universo de produtos activos. */
  preenchidas: number;
  /** Valores distintos — separa código (poucos) de texto livre (muitos). */
  distintos: number;
  amostra: Array<string | number | null>;
};

type TabelaLookup = {
  schema: string;
  nome: string;
  padrao: string;
  linhas: number;
  colunas: ColumnMeta[];
  pk: string[];
  amostra: Array<Record<string, unknown>>;
};

type FkInfo = { nome: string; colunaOrigem: string; tabelaDestino: string; colunaDestino: string };

type ResultadoConceito = {
  id: ConceitoId;
  titulo: string;
  colunasStocks: ColunaStocks[];
  tabelas: TabelaLookup[];
  fksRelacionadas: FkInfo[];
  veredito: string;
  sqlProposto: string | null;
};

// ── Helpers de schema ────────────────────────────────────────────────

async function getRowCount(pool: SqlPool, schema: string, table: string): Promise<number> {
  const r = await pool.request().query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM [${schema}].[${table}]`,
  );
  return Number(r.recordset[0]?.n ?? 0);
}

async function getPrimaryKey(pool: SqlPool, schema: string, table: string): Promise<string[]> {
  const r = await pool.request()
    .input("s", sql.NVarChar, schema)
    .input("t", sql.NVarChar, table)
    .query<{ col: string }>(`
      SELECT c.name AS col
      FROM sys.indexes i
      JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
      JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
      JOIN sys.tables t ON t.object_id = i.object_id
      JOIN sys.schemas s ON s.schema_id = t.schema_id
      WHERE i.is_primary_key = 1 AND s.name = @s AND t.name = @t
      ORDER BY ic.key_ordinal
    `);
  return r.recordset.map((x) => x.col);
}

async function getSample(
  pool: SqlPool, schema: string, table: string, n: number,
): Promise<Array<Record<string, unknown>>> {
  const r = await pool.request().query(`SELECT TOP ${n} * FROM [${schema}].[${table}]`);
  return r.recordset as Array<Record<string, unknown>>;
}

/** FKs declaradas a sair de dbo.Stocks. É o sinal mais forte que existe. */
async function getStocksFks(pool: SqlPool): Promise<FkInfo[]> {
  const r = await pool.request().query<{
    name: string; from_col: string; to_table: string; to_col: string;
  }>(`
    SELECT
      fk.name                              AS name,
      pc.name                              AS from_col,
      OBJECT_NAME(fk.referenced_object_id) AS to_table,
      rc.name                              AS to_col
    FROM sys.foreign_keys fk
    JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
    JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
    JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
    JOIN sys.tables pt ON pt.object_id = fk.parent_object_id
    JOIN sys.schemas ps ON ps.schema_id = pt.schema_id
    WHERE ps.name = 'dbo' AND pt.name = 'Stocks'
    ORDER BY fk.name
  `);
  return r.recordset.map((x) => ({
    nome: x.name, colunaOrigem: x.from_col, tabelaDestino: x.to_table, colunaDestino: x.to_col,
  }));
}

/**
 * Filtro de produtos activos idêntico ao da pipeline de produtos, para
 * que a taxa de preenchimento reportada seja a que a ingestão vai ver —
 * e não a de um universo maior que inclui artigos retirados.
 */
const FILTRO_ACTIVOS = `[Retirado] = 0 AND [Processa_Stocks] <> 0`;

async function inspeccionarColunaStocks(
  pool: SqlPool, coluna: string, tipo: string, samples: number,
): Promise<ColunaStocks> {
  const r = await pool.request().query<{ preenchidas: number; distintos: number }>(`
    SELECT
      COUNT([${coluna}])          AS preenchidas,
      COUNT(DISTINCT [${coluna}]) AS distintos
    FROM [dbo].[Stocks]
    WHERE ${FILTRO_ACTIVOS}
  `);
  const amostraR = await pool.request().query<{ v: string | number | null }>(`
    SELECT DISTINCT TOP ${samples} [${coluna}] AS v
    FROM [dbo].[Stocks]
    WHERE ${FILTRO_ACTIVOS} AND [${coluna}] IS NOT NULL
  `);
  return {
    nome: coluna,
    tipo,
    preenchidas: Number(r.recordset[0]?.preenchidas ?? 0),
    distintos: Number(r.recordset[0]?.distintos ?? 0),
    amostra: amostraR.recordset.map((x) => x.v),
  };
}

async function colunasStocksPorPadrao(
  pool: SqlPool, padroes: readonly string[],
): Promise<Array<{ nome: string; tipo: string }>> {
  const vistas = new Set<string>();
  const out: Array<{ nome: string; tipo: string }> = [];
  for (const p of padroes) {
    const r = await pool.request().input("p", sql.NVarChar, p).query<{ c: string; t: string }>(`
      SELECT c.name AS c, ty.name AS t
      FROM sys.columns c
      JOIN sys.tables t2 ON c.object_id = t2.object_id
      JOIN sys.schemas s ON t2.schema_id = s.schema_id
      JOIN sys.types ty ON c.user_type_id = ty.user_type_id
      WHERE s.name = 'dbo' AND t2.name = 'Stocks' AND c.name LIKE @p
      ORDER BY c.column_id
    `);
    for (const row of r.recordset) {
      if (vistas.has(row.c)) continue;
      vistas.add(row.c);
      out.push({ nome: row.c, tipo: row.t });
    }
  }
  return out;
}

async function tabelasPorPadrao(
  pool: SqlPool, padroes: readonly string[],
): Promise<Array<{ schema: string; nome: string; padrao: string }>> {
  const vistas = new Set<string>();
  const out: Array<{ schema: string; nome: string; padrao: string }> = [];
  for (const p of padroes) {
    const r = await pool.request().input("p", sql.NVarChar, p).query<{ s: string; t: string }>(`
      SELECT s.name AS s, t.name AS t
      FROM sys.tables t
      JOIN sys.schemas s ON t.schema_id = s.schema_id
      WHERE s.name = 'dbo' AND t.name LIKE @p AND t.is_ms_shipped = 0
      ORDER BY t.name
    `);
    for (const row of r.recordset) {
      const k = `${row.s}.${row.t}`;
      if (vistas.has(k)) continue;
      vistas.add(k);
      out.push({ schema: row.s, nome: row.t, padrao: p });
    }
  }
  return out;
}

// ── Veredito ─────────────────────────────────────────────────────────

/**
 * Decide o que dizer ao operador. Uma coluna existir não chega: se
 * estiver toda a NULL não serve, e é melhor dizê-lo do que deixar a
 * ingestão descobrir isso em silêncio mais tarde.
 */
function decidirVeredito(
  conceito: { id: ConceitoId; titulo: string },
  colunas: ColunaStocks[],
  tabelas: TabelaLookup[],
  fks: FkInfo[],
  totalActivos: number,
): { veredito: string; sqlProposto: string | null } {
  const uteis = colunas.filter((c) => c.preenchidas > 0);
  const pct = (n: number) => (totalActivos ? ((n / totalActivos) * 100).toFixed(1) : "0.0");

  if (uteis.length === 0 && tabelas.length === 0) {
    return {
      veredito: `NÃO ENCONTRADO. Nenhuma coluna em Stocks nem tabela de lookup para ${conceito.titulo}.`,
      sqlProposto: null,
    };
  }

  if (uteis.length === 0) {
    const nomes = tabelas.map((t) => `${t.schema}.${t.nome}`).join(", ");
    return {
      veredito:
        `SEM COLUNA ÚTIL EM STOCKS. ` +
        (colunas.length
          ? `As colunas candidatas existem mas estão todas a NULL nos produtos activos. `
          : `Nenhuma coluna candidata em Stocks. `) +
        `Há tabelas candidatas (${nomes}) — ver secção de tabelas para a chave de ligação.`,
      sqlProposto: null,
    };
  }

  // A melhor coluna é a mais preenchida; empate desfeito pela mais específica.
  const melhor = [...uteis].sort((a, b) => b.preenchidas - a.preenchidas)[0];
  const fk = fks.find((f) => f.colunaOrigem === melhor.nome);

  // Muitos distintos e tipo textual → o valor está em Stocks, sem lookup.
  const textual = /char|text|varchar|nvarchar/i.test(melhor.tipo);
  const pareceCodigo = !textual || melhor.distintos < 200;

  if (fk) {
    return {
      veredito:
        `ENCONTRADO via FK. Stocks.[${melhor.nome}] → ${fk.tabelaDestino}.[${fk.colunaDestino}], ` +
        `${melhor.preenchidas}/${totalActivos} preenchidos (${pct(melhor.preenchidas)}%), ` +
        `${melhor.distintos} valores distintos.`,
      sqlProposto:
        `LEFT JOIN [dbo].[${fk.tabelaDestino}] ${conceito.id.toLowerCase()}_lk\n` +
        `       ON ${conceito.id.toLowerCase()}_lk.[${fk.colunaDestino}] = s.[${melhor.nome}]`,
    };
  }

  if (textual && !pareceCodigo) {
    return {
      veredito:
        `ENCONTRADO em Stocks, valor directo. Stocks.[${melhor.nome}] (${melhor.tipo}), ` +
        `${melhor.preenchidas}/${totalActivos} preenchidos (${pct(melhor.preenchidas)}%), ` +
        `${melhor.distintos} valores distintos. Não precisa de lookup.`,
      sqlProposto: `s.[${melhor.nome}]`,
    };
  }

  return {
    veredito:
      `ENCONTRADO em Stocks, provável CÓDIGO. Stocks.[${melhor.nome}] (${melhor.tipo}), ` +
      `${melhor.preenchidas}/${totalActivos} preenchidos (${pct(melhor.preenchidas)}%), ` +
      `apenas ${melhor.distintos} valores distintos e sem FK declarada. ` +
      `Confirmar contra as tabelas candidatas abaixo antes de ingerir.`,
    sqlProposto: null,
  };
}

// ── Relatório ────────────────────────────────────────────────────────

function renderMarkdown(
  res: ResultadoConceito[], totalActivos: number, stocksFks: FkInfo[], ts: string,
): string {
  const L: string[] = [];
  L.push(`# Auditoria de catálogo regulamentar — ERP SPharm`);
  L.push(``);
  L.push(`Gerado em ${ts}. Read-only: nada foi escrito no ERP.`);
  L.push(``);
  L.push(`Produtos activos considerados (\`${FILTRO_ACTIVOS}\`): **${totalActivos}**`);
  L.push(``);
  L.push(`## Resumo`);
  L.push(``);
  L.push(`| Conceito | Veredito |`);
  L.push(`|---|---|`);
  for (const r of res) L.push(`| ${r.titulo} | ${r.veredito.split(".")[0]} |`);
  L.push(``);

  for (const r of res) {
    L.push(`## ${r.titulo}`);
    L.push(``);
    L.push(`**${r.veredito}**`);
    L.push(``);
    if (r.colunasStocks.length) {
      L.push(`### Colunas candidatas em \`dbo.Stocks\``);
      L.push(``);
      L.push(`| Coluna | Tipo | Preenchidas | Distintos | Amostra |`);
      L.push(`|---|---|---|---|---|`);
      for (const c of r.colunasStocks) {
        const am = c.amostra.slice(0, 5).map((v) => String(v ?? "")).join(" · ").slice(0, 80);
        L.push(`| \`${c.nome}\` | ${c.tipo} | ${c.preenchidas} | ${c.distintos} | ${am} |`);
      }
      L.push(``);
    }
    if (r.fksRelacionadas.length) {
      L.push(`### FKs declaradas a partir de Stocks`);
      L.push(``);
      for (const f of r.fksRelacionadas) {
        L.push(`- \`Stocks.[${f.colunaOrigem}]\` → \`${f.tabelaDestino}.[${f.colunaDestino}]\` (${f.nome})`);
      }
      L.push(``);
    }
    if (r.tabelas.length) {
      L.push(`### Tabelas de lookup candidatas`);
      L.push(``);
      for (const t of r.tabelas) {
        L.push(`#### \`${t.schema}.${t.nome}\` — ${t.linhas} linhas (padrão \`${t.padrao}\`)`);
        L.push(``);
        L.push(`PK: ${t.pk.length ? t.pk.map((c) => `\`${c}\``).join(", ") : "(nenhuma)"}`);
        L.push(``);
        L.push(`Colunas: ${t.colunas.map((c) => `\`${c.name}\` ${c.dataType}`).join(", ")}`);
        L.push(``);
        if (t.amostra.length) {
          const cols = Object.keys(t.amostra[0]).slice(0, 6);
          L.push(`| ${cols.join(" | ")} |`);
          L.push(`|${cols.map(() => "---").join("|")}|`);
          for (const row of t.amostra.slice(0, 5)) {
            L.push(`| ${cols.map((c) => String(row[c] ?? "").slice(0, 40)).join(" | ")} |`);
          }
          L.push(``);
        }
      }
    }
    if (r.sqlProposto) {
      L.push(`### SQL proposto`);
      L.push(``);
      L.push("```sql");
      L.push(r.sqlProposto);
      L.push("```");
      L.push(``);
    }
  }

  L.push(`## Todas as FKs a sair de \`dbo.Stocks\``);
  L.push(``);
  if (stocksFks.length) {
    for (const f of stocksFks) {
      L.push(`- \`Stocks.[${f.colunaOrigem}]\` → \`${f.tabelaDestino}.[${f.colunaDestino}]\``);
    }
  } else {
    L.push(`_Nenhuma FK declarada. As ligações a tabelas de lookup são por convenção, não por constraint._`);
  }
  L.push(``);
  return L.join("\n");
}

// ── Comando ──────────────────────────────────────────────────────────

export async function catalogAudit(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      "out-dir": { type: "string", default: "./run" },
      samples: { type: "string", default: String(DEFAULT_SAMPLES) },
    },
    allowPositionals: true,
  });
  const outDir = String(values["out-dir"]);
  const samples = Math.max(1, Math.min(50, parseInt(String(values.samples), 10) || DEFAULT_SAMPLES));

  let cfg;
  try {
    cfg = loadConfig("sql");
  } catch (err) {
    console.error("✗ Config inválida:");
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  console.log(RULE);
  console.log("  Auditoria de catálogo regulamentar (DCI · ATC · Grupo Homogéneo · Fabricante)");
  console.log("  Read-only. Nada é escrito no ERP.");
  console.log(RULE);

  return withPool(cfg, async (pool) => {
    if (!(await tableExists(pool, { schema: "dbo", table: "Stocks" }))) {
      console.error("✗ dbo.Stocks não existe. Corre `agent discover` primeiro.");
      return 1;
    }

    const totalR = await pool.request().query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM [dbo].[Stocks] WHERE ${FILTRO_ACTIVOS}`,
    );
    const totalActivos = Number(totalR.recordset[0]?.n ?? 0);
    console.log(`\nProdutos activos em Stocks: ${totalActivos}\n`);

    const stocksFks = await getStocksFks(pool);
    console.log(`FKs declaradas a partir de Stocks: ${stocksFks.length}`);

    const resultados: ResultadoConceito[] = [];

    for (const conceito of CONCEITOS) {
      console.log(`\n── ${conceito.titulo} ${"─".repeat(Math.max(0, 50 - conceito.titulo.length))}`);

      const candidatas = await colunasStocksPorPadrao(pool, conceito.colunaPatterns);
      const colunas: ColunaStocks[] = [];
      for (const c of candidatas) {
        try {
          const info = await inspeccionarColunaStocks(pool, c.nome, c.tipo, samples);
          colunas.push(info);
          console.log(
            `  Stocks.[${c.nome}] (${c.tipo}): ${info.preenchidas} preenchidas, ` +
              `${info.distintos} distintos` +
              (info.amostra.length ? ` · ex.: ${info.amostra.slice(0, 3).map(String).join(" | ").slice(0, 60)}` : ""),
          );
        } catch (err) {
          console.log(`  Stocks.[${c.nome}]: não inspeccionável (${err instanceof Error ? err.message : err})`);
        }
      }
      if (!candidatas.length) console.log(`  (nenhuma coluna candidata em Stocks)`);

      const tabelasCand = await tabelasPorPadrao(pool, conceito.tabelaPatterns);
      const tabelas: TabelaLookup[] = [];
      for (const t of tabelasCand) {
        try {
          const [colunasT, linhas, pk, amostra] = await Promise.all([
            listColumns(pool, { schema: t.schema, table: t.nome }),
            getRowCount(pool, t.schema, t.nome),
            getPrimaryKey(pool, t.schema, t.nome),
            getSample(pool, t.schema, t.nome, Math.min(samples, 10)),
          ]);
          tabelas.push({ schema: t.schema, nome: t.nome, padrao: t.padrao, linhas, colunas: colunasT, pk, amostra });
          console.log(`  tabela ${t.schema}.${t.nome}: ${linhas} linhas, PK=${pk.join("+") || "—"}`);
        } catch (err) {
          console.log(`  tabela ${t.schema}.${t.nome}: não inspeccionável (${err instanceof Error ? err.message : err})`);
        }
      }
      if (!tabelasCand.length) console.log(`  (nenhuma tabela candidata)`);

      const nomesColunas = new Set(colunas.map((c) => c.nome));
      const fksRelacionadas = stocksFks.filter(
        (f) =>
          nomesColunas.has(f.colunaOrigem) ||
          tabelas.some((t) => t.nome.toLowerCase() === f.tabelaDestino.toLowerCase()),
      );

      const { veredito, sqlProposto } = decidirVeredito(conceito, colunas, tabelas, fksRelacionadas, totalActivos);
      console.log(`  → ${veredito}`);
      resultados.push({
        id: conceito.id, titulo: conceito.titulo,
        colunasStocks: colunas, tabelas, fksRelacionadas, veredito, sqlProposto,
      });
    }

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    const mdPath = path.join(outDir, `catalog-audit-${ts}.md`);
    const jsonPath = path.join(outDir, `catalog-audit-${ts}.json`);
    writeFileSync(mdPath, renderMarkdown(resultados, totalActivos, stocksFks, ts), "utf8");
    writeFileSync(
      jsonPath,
      JSON.stringify({ geradoEm: ts, totalActivos, stocksFks, conceitos: resultados }, null, 2),
      "utf8",
    );

    console.log(`\n${RULE}`);
    console.log(`  Relatório: ${mdPath}`);
    console.log(`  JSON:      ${jsonPath}`);
    console.log(RULE);
    console.log(`\nEnvia o .md para configurar a ingestão dos campos encontrados.`);
    return 0;
  });
}
