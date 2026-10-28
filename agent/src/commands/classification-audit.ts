/**
 * agent/src/commands/classification-audit.ts
 *
 * Auditoria READ-ONLY para o operador descobrir ONDE o ERP guarda a
 * classificação do produto (Ético, NETT, Serviço, Genérico) — e com que
 * valores — antes de preencher `classificacaoErp` em agent.config.json.
 *
 * ── O QUE FAZ ───────────────────────────────────────────────────────
 *   1. Lista as colunas de dbo.Stocks cujo NOME sugere classificação
 *      (Etico/Ético, Nett, Servico/Serviço, Generico, Tipo, Natureza,
 *      Categoria, Familia, Classe, Processa_Stocks…).
 *   2. Para cada uma: nº de linhas preenchidas, nº de valores distintos,
 *      os valores mais frequentes com contagem, e o cruzamento com
 *      Processa_Stocks / Retirado (só contagens).
 *   3. Lista tabelas relacionadas por padrão de nome (com linhas, colunas,
 *      amostra de tabelas pequenas) e as FKs declaradas de Stocks para elas.
 *
 * ── O QUE NÃO FAZ ───────────────────────────────────────────────────
 * NÃO conclui o significado de nenhum valor ("1 = Ético" é uma hipótese
 * do operador, a validar com quem conhece o ERP, e fica escrita no
 * mapeamento — não aqui). O universo é dbo.Stocks INTEIRO (incluindo
 * Retirado=1 e Processa_Stocks=0): os serviços vivem precisamente nas
 * linhas que a ingestão de produtos filtra fora.
 *
 * NÃO comunica com o SaaS. NÃO escreve no ERP. Só `sys.*` e SELECT
 * agregados. Compatível com SQL Server 2008 R2.
 *
 * Uso:
 *   agent classification-audit
 *   agent classification-audit --out-dir .\run --top 30
 */

import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { withPool, type SqlPool } from "../sql-client.js";
import { tableExists, listColumns } from "./probe-helpers.js";

const RULE = "═".repeat(72);
const DEFAULT_TOP = 30;
/** Tabelas até este nº de linhas mostram amostra completa (lookups). */
const LIMITE_AMOSTRA_TABELA = 500;
/** Cruza com Processa_Stocks/Retirado só se a coluna tiver poucos valores. */
const LIMITE_DISTINTOS_CRUZAMENTO = 50;

/** Padrões LIKE (case-insensitive na collation habitual) — largos de propósito. */
export const PADROES_COLUNA = [
  "%etico%", "%ético%", "%nett%", "%servic%", "%serviç%", "%generic%", "%genér%",
  "%tipo%", "%natureza%", "%categ%", "%famil%", "%classe%", "%class%",
  "%processa%", "%receita%", "%msrm%", "%mnsrm%", "%medicamento%",
] as const;

export const PADROES_TABELA = [
  "%etico%", "%ético%", "%nett%", "%servic%", "%serviç%", "%generic%",
  "%tipo%artigo%", "%tipo%stock%", "%tipo%produto%", "%natureza%", "%categ%", "%famil%", "%classe%",
] as const;

/** Tipos sobre os quais não se pode fazer DISTINCT/GROUP BY. */
const TIPOS_NAO_AGREGAVEIS = new Set(["text", "ntext", "image", "xml", "varbinary", "binary", "timestamp"]);

/** Identificador entre [ ] com `]` escapado — nomes vêm de sys.columns, mas nunca se confia. */
export function q(nome: string): string {
  return `[${nome.replace(/]/g, "]]")}]`;
}

export function sqlResumoColuna(coluna: string): string {
  return `SELECT COUNT(*) AS total, COUNT(${q(coluna)}) AS preenchidas, COUNT(DISTINCT ${q(coluna)}) AS distintos FROM [dbo].[Stocks]`;
}

export function sqlTopValores(coluna: string, top: number): string {
  const n = Math.max(1, Math.min(200, Math.trunc(top)));
  return `SELECT TOP ${n} ${q(coluna)} AS valor, COUNT(*) AS n FROM [dbo].[Stocks] GROUP BY ${q(coluna)} ORDER BY COUNT(*) DESC`;
}

export function sqlCruzamento(coluna: string, outras: string[]): string {
  const cols = outras.map(q);
  return (
    `SELECT TOP 200 ${q(coluna)} AS valor, ${cols.map((c, i) => `${c} AS x${i}`).join(", ")}, COUNT(*) AS n ` +
    `FROM [dbo].[Stocks] GROUP BY ${q(coluna)}, ${cols.join(", ")} ORDER BY ${q(coluna)}, COUNT(*) DESC`
  );
}

type ColunaCandidata = { nome: string; tipo: string; padroes: string[] };

type ValorFrequente = { valor: string | number | boolean | null; n: number };

export type ColunaAuditada = ColunaCandidata & {
  total: number;
  preenchidas: number;
  distintos: number;
  valores: ValorFrequente[];
  cruzamento: Array<{ valor: unknown; processaStocks?: unknown; retirado?: unknown; n: number }>;
  nota?: string;
};

type TabelaRelacionada = {
  nome: string;
  linhas: number;
  colunas: string[];
  amostra: Array<Record<string, unknown>>;
};

async function colunasCandidatas(pool: SqlPool): Promise<ColunaCandidata[]> {
  const cols = await listColumns(pool, { schema: "dbo", table: "Stocks" });
  const out: ColunaCandidata[] = [];
  for (const c of cols) {
    const nome = c.name.toLowerCase();
    const padroes = PADROES_COLUNA.filter((p) => likeMatch(nome, p));
    if (padroes.length > 0) out.push({ nome: c.name, tipo: c.dataType, padroes: [...padroes] });
  }
  return out;
}

/** LIKE com % apenas nas pontas/meio, em JS (os nomes já vêm de sys.columns). */
export function likeMatch(texto: string, padrao: string): boolean {
  const re = new RegExp(
    "^" + padrao.toLowerCase().split("%").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$",
    "u",
  );
  return re.test(texto.toLowerCase());
}

async function tabelasRelacionadas(pool: SqlPool): Promise<string[]> {
  const r = await pool.request().query<{ name: string }>(
    `SELECT t.name FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
     WHERE s.name = 'dbo' AND t.is_ms_shipped = 0 ORDER BY t.name`,
  );
  return r.recordset.map((x) => x.name).filter((n) => PADROES_TABELA.some((p) => likeMatch(n, p)));
}

async function fksDeStocks(pool: SqlPool): Promise<Array<{ coluna: string; tabela: string; destino: string }>> {
  const r = await pool.request().query<{ c: string; t: string; d: string }>(`
    SELECT pc.name AS c, OBJECT_NAME(fk.referenced_object_id) AS t, rc.name AS d
    FROM sys.foreign_keys fk
    JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
    JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
    JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
    WHERE OBJECT_NAME(fk.parent_object_id) = 'Stocks'`);
  return r.recordset.map((x) => ({ coluna: x.c, tabela: x.t, destino: x.d }));
}

export function renderMarkdown(
  ts: string,
  totalStocks: number,
  colunas: ColunaAuditada[],
  tabelas: TabelaRelacionada[],
  fks: Array<{ coluna: string; tabela: string; destino: string }>,
): string {
  const L: string[] = [];
  L.push(`# classification-audit — ${ts}`, "");
  L.push(
    "Auditoria read-only. **Não conclui significados**: lista colunas candidatas e os valores que contêm, " +
      "para o operador preencher `classificacaoErp` em agent.config.json depois de validar com quem conhece o ERP.",
    "",
    `Universo: dbo.Stocks inteiro (**${totalStocks}** linhas, incluindo Retirado=1 e Processa_Stocks=0).`,
    "",
  );
  for (const c of colunas) {
    L.push(`## Stocks.[${c.nome}] (${c.tipo})`, "");
    L.push(`Casou com: ${c.padroes.join(", ")}`);
    if (c.nota) {
      L.push("", `> ${c.nota}`, "");
      continue;
    }
    L.push(`Preenchidas: ${c.preenchidas}/${c.total} · distintos: ${c.distintos}`, "");
    if (c.valores.length > 0) {
      L.push("| valor | linhas |", "|---|---|");
      for (const v of c.valores) L.push(`| ${v.valor === null ? "NULL" : JSON.stringify(v.valor)} | ${v.n} |`);
      L.push("");
    }
    if (c.cruzamento.length > 0) {
      L.push("Cruzamento (contagens, sem interpretação):", "", "| valor | Processa_Stocks | Retirado | linhas |", "|---|---|---|---|");
      for (const x of c.cruzamento) {
        L.push(`| ${JSON.stringify(x.valor ?? null)} | ${JSON.stringify(x.processaStocks ?? null)} | ${JSON.stringify(x.retirado ?? null)} | ${x.n} |`);
      }
      L.push("");
    }
  }
  if (fks.length > 0) {
    L.push("## FKs declaradas de Stocks para tabelas relacionadas", "");
    for (const f of fks) L.push(`- Stocks.[${f.coluna}] -> ${f.tabela}.[${f.destino}]`);
    L.push("");
  }
  for (const t of tabelas) {
    L.push(`## Tabela dbo.[${t.nome}] — ${t.linhas} linhas`, "", `Colunas: ${t.colunas.join(", ")}`, "");
    if (t.amostra.length > 0) {
      L.push("```json", JSON.stringify(t.amostra, null, 1), "```", "");
    }
  }
  L.push(
    "## Como usar",
    "",
    "1. Identifica, com quem conhece o ERP, que coluna/valores significam Ético, NETT e Serviço.",
    "2. Preenche `classificacaoErp` em agent.config.json (ver docs/spharm-erp-canonical-mapping.md).",
    "3. Corre `bootstrap-dry-run`/`daily-sync-dry-run` e confere as contagens sim/não/desconhecido antes de enviar.",
    "",
  );
  return L.join("\n");
}

export async function classificationAudit(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      "out-dir": { type: "string", default: "./run" },
      top: { type: "string", default: String(DEFAULT_TOP) },
    },
    allowPositionals: true,
  });
  const outDir = String(values["out-dir"]);
  const top = Math.max(5, Math.min(200, parseInt(String(values.top), 10) || DEFAULT_TOP));

  let cfg;
  try {
    cfg = loadConfig("sql");
  } catch (err) {
    console.error("✗ Config inválida:");
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  console.log(RULE);
  console.log("  Auditoria da classificação do produto (Ético · NETT · Serviço · Genérico)");
  console.log("  Read-only. Não conclui significados — lista colunas e valores.");
  console.log(RULE);

  return withPool(cfg, async (pool) => {
    if (!(await tableExists(pool, { schema: "dbo", table: "Stocks" }))) {
      console.error("✗ dbo.Stocks não existe. Corre `agent discover` primeiro.");
      return 1;
    }
    const stocksCols = new Set((await listColumns(pool, { schema: "dbo", table: "Stocks" })).map((c) => c.name));
    const cruzar = ["Processa_Stocks", "Retirado"].filter((c) => stocksCols.has(c));

    const candidatas = await colunasCandidatas(pool);
    console.log(`\nColunas candidatas em dbo.Stocks: ${candidatas.length}`);
    const auditadas: ColunaAuditada[] = [];
    let totalStocks = 0;
    for (const c of candidatas) {
      if (TIPOS_NAO_AGREGAVEIS.has(c.tipo.toLowerCase())) {
        auditadas.push({ ...c, total: 0, preenchidas: 0, distintos: 0, valores: [], cruzamento: [], nota: `tipo ${c.tipo} não agregável — não inspeccionada` });
        console.log(`  Stocks.[${c.nome}] (${c.tipo}): não inspeccionável`);
        continue;
      }
      try {
        const r = await pool.request().query<{ total: number; preenchidas: number; distintos: number }>(sqlResumoColuna(c.nome));
        const resumo = r.recordset[0]!;
        totalStocks = Number(resumo.total);
        const v = await pool.request().query<{ valor: string | number | boolean | null; n: number }>(sqlTopValores(c.nome, top));
        const valores = v.recordset.map((x) => ({ valor: x.valor, n: Number(x.n) }));
        let cruzamento: ColunaAuditada["cruzamento"] = [];
        if (Number(resumo.distintos) <= LIMITE_DISTINTOS_CRUZAMENTO && cruzar.length > 0 && !cruzar.includes(c.nome)) {
          const x = await pool.request().query<Record<string, unknown>>(sqlCruzamento(c.nome, cruzar));
          cruzamento = x.recordset.map((row) => ({
            valor: row.valor,
            ...(cruzar[0] === "Processa_Stocks" ? { processaStocks: row.x0 } : { retirado: row.x0 }),
            ...(cruzar.length > 1 ? { retirado: row.x1 } : {}),
            n: Number(row.n),
          }));
        }
        auditadas.push({
          ...c,
          total: Number(resumo.total),
          preenchidas: Number(resumo.preenchidas),
          distintos: Number(resumo.distintos),
          valores,
          cruzamento,
        });
        console.log(
          `  Stocks.[${c.nome}] (${c.tipo}): ${resumo.preenchidas} preenchidas, ${resumo.distintos} distintos` +
            (valores.length ? ` · top: ${valores.slice(0, 4).map((x) => `${String(x.valor)}×${x.n}`).join(" | ").slice(0, 70)}` : ""),
        );
      } catch (err) {
        auditadas.push({ ...c, total: 0, preenchidas: 0, distintos: 0, valores: [], cruzamento: [], nota: `não inspeccionável: ${err instanceof Error ? err.message : err}` });
        console.log(`  Stocks.[${c.nome}]: não inspeccionável (${err instanceof Error ? err.message : err})`);
      }
    }

    const nomesTabelas = await tabelasRelacionadas(pool);
    console.log(`\nTabelas relacionadas por nome: ${nomesTabelas.length}`);
    const tabelas: TabelaRelacionada[] = [];
    for (const nome of nomesTabelas) {
      try {
        const cols = await listColumns(pool, { schema: "dbo", table: nome });
        const n = await pool.request().query<{ n: number }>(`SELECT COUNT(*) AS n FROM [dbo].${q(nome)}`);
        const linhas = Number(n.recordset[0]?.n ?? 0);
        let amostra: Array<Record<string, unknown>> = [];
        if (linhas <= LIMITE_AMOSTRA_TABELA) {
          const s = await pool.request().query(`SELECT TOP 50 * FROM [dbo].${q(nome)}`);
          amostra = s.recordset as Array<Record<string, unknown>>;
        }
        tabelas.push({ nome, linhas, colunas: cols.map((c) => c.name), amostra });
        console.log(`  dbo.${nome}: ${linhas} linhas`);
      } catch (err) {
        console.log(`  dbo.${nome}: não inspeccionável (${err instanceof Error ? err.message : err})`);
      }
    }
    const nomesSet = new Set(nomesTabelas.map((t) => t.toLowerCase()));
    const colSet = new Set(auditadas.map((c) => c.nome));
    const fks = (await fksDeStocks(pool)).filter((f) => nomesSet.has(f.tabela.toLowerCase()) || colSet.has(f.coluna));

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    const mdPath = path.join(outDir, `classification-audit-${ts}.md`);
    const jsonPath = path.join(outDir, `classification-audit-${ts}.json`);
    writeFileSync(mdPath, renderMarkdown(ts, totalStocks, auditadas, tabelas, fks), "utf8");
    writeFileSync(jsonPath, JSON.stringify({ geradoEm: ts, totalStocks, colunas: auditadas, tabelas, fks }, null, 2), "utf8");

    console.log(`\n${RULE}`);
    console.log(`  Relatório: ${mdPath}`);
    console.log(`  JSON:      ${jsonPath}`);
    console.log(RULE);
    console.log("\nNenhum significado foi concluído. Valida os valores com quem conhece o ERP antes de configurar `classificacaoErp`.");
    return 0;
  });
}
