/**
 * agent/src/commands/vendas-susp-cadeia.ts
 *
 * A cadeia documental da venda suspensa. Read-only, sem persistência.
 *
 * ── O QUE JÁ ESTÁ PROVADO (rev64, ERP real da Silveirense) ───────────
 *
 * A venda suspensa NÃO passa pelo `Atendimento`. Tem cabeçalho próprio:
 *
 *     [Atendimento Susp Detalhe].[Atendimento Susp ID]
 *         --FK declarada-->
 *     [Atendimento Susp].[Atendimento Susp ID]
 *
 * e é o `[Atendimento Susp]` que carrega o documento — `SerieFacturacao`,
 * `Numero Documento`, `Tipo Documento ID`, `Fim Venda`, `Data Venda`,
 * `Total Bruto_EUR`. Linha 147214 → Susp 83708, CNP 9599258, 2 un,
 * 10,72 €.
 *
 * Isto arruma duas hipóteses minhas que os dados mataram:
 *
 *   · `[Fim Venda]='S'` no `Atendimento` devolvia ZERO — era o gate
 *     errado sobre a tabela errada;
 *   · `[Atendimento Susp Detalhe].[Atendimento ID]` existe mas não é FK
 *     declarada. Eu escolhi-a por padrão de nome. Um nome parecido não é
 *     uma relação.
 *
 * ── O QUE FALTA, E É O QUE ESTE COMANDO FECHA ────────────────────────
 *
 * As reversões. A descoberta expôs `[Atendimento_SuspFT_NC_Susp]` com
 * FK `[Atendimento Susp ID_FT] -> [Atendimento Susp]`, e é a candidata a
 * ligar a factura VSG à sua nota de crédito. Sem isso, um backfill grava
 * as vendas e não grava as anulações — o total sobe e continua plausível,
 * que é a forma de erro mais cara que este projecto já teve.
 *
 * Objectivo, nos dois sentidos:
 *
 *     Susp Detalhe -> Atendimento Susp -> VSG/numero
 *     Atendimento Susp -> Atendimento_SuspFT_NC_Susp -> NC/anulacao
 *
 * Uso:
 *   agent -- vendas-susp-cadeia --dia 2026-08-01
 *   agent -- vendas-susp-cadeia --susp-det-ids 147214,147219 --numeros 54684,54688
 */

import { parseArgs } from "node:util";
import sql from "mssql";
import { loadConfig } from "../config.js";
import { withPool, type SqlPool } from "../sql-client.js";
import { janela } from "../janela.js";
import {
  formatCell,
  listColumns,
  listForeignKeysIn,
  listForeignKeysOut,
  listPrimaryKey,
  quoteIdent,
  renderColumnType,
  tableExists,
  type ColumnMeta,
  type ForeignKeyEdge,
} from "./probe-helpers.js";

const RULE = "─".repeat(70);
const DOUBLE = "═".repeat(70);

const T_SUSP_DET = "Atendimento Susp Detalhe";
const T_SUSP = "Atendimento Susp";
/** A prioritária: liga a factura VSG à sua reversão. */
const T_SUSP_FT_NC = "Atendimento_SuspFT_NC_Susp";
/** A outra, do circuito `Atendimento`. Fica como controlo. */
const T_FT_NC = "Atendimento_FT_NC_Susp";
const T_STOCKS = "Stocks";

/** Os campos documentais do cabeçalho suspenso, pela ordem de leitura. */
const CABECALHO_SUSP = [
  "Atendimento Susp ID",
  "SerieFacturacao",
  "Numero Documento",
  "Tipo Documento ID",
  "Fim Venda",
  "Data Venda",
  "Total Bruto_EUR",
] as const;

const DEFAULT_SUSP_DET_IDS = [147214, 147219];
const DEFAULT_NUMEROS = [54684, 54688];
const DEFAULT_SERIE = "VSG";
const DEFAULT_DIA = "2026-08-01";

type Args = {
  dia: string;
  suspDetIds: number[];
  serie: string;
  numeros: number[];
  help: boolean;
};

function listaDeInteiros(v: string | undefined, fallback: number[]): number[] {
  if (!v) return fallback;
  const out = v
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && Number.isInteger(n));
  return out.length > 0 ? out : fallback;
}

function parseCmdArgs(): Args {
  const raw = parseArgs({
    args: process.argv.slice(3),
    options: {
      dia: { type: "string" },
      "susp-det-ids": { type: "string" },
      serie: { type: "string" },
      numeros: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  return {
    dia: typeof raw.values.dia === "string" ? raw.values.dia : DEFAULT_DIA,
    suspDetIds: listaDeInteiros(
      raw.values["susp-det-ids"] as string | undefined,
      DEFAULT_SUSP_DET_IDS,
    ),
    serie: typeof raw.values.serie === "string" ? raw.values.serie : DEFAULT_SERIE,
    numeros: listaDeInteiros(raw.values.numeros as string | undefined, DEFAULT_NUMEROS),
    help: raw.values.help === true,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Qualificação de nomes
// ─────────────────────────────────────────────────────────────────────

/**
 * `"Atendimento Susp"` e `"dbo.Atendimento Susp"` dão o mesmo resultado.
 *
 * É AQUI que a rev64 partiu: `listForeignKeysOut` devolve `toTable` já
 * qualificado (`dbo.Atendimento Susp`) e eu voltei a prefixar `dbo.`,
 * gerando `[dbo].[dbo.Atendimento Susp]` — o "Invalid object name
 * 'dbo.dbo.Atendimento Susp'". Aceitar as duas formas é mais barato do
 * que lembrar qual delas cada helper devolve.
 */
export function separar(nome: string): { schema: string; table: string } {
  const i = nome.indexOf(".");
  if (i > 0) {
    const schema = nome.slice(0, i);
    // Só é um prefixo de schema se parecer um identificador simples. Um
    // nome de tabela com ponto no meio ficaria intacto.
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
      return { schema, table: nome.slice(i + 1) };
    }
  }
  return { schema: "dbo", table: nome };
}

function tbl(nome: string): { schema: string; table: string } {
  return separar(nome);
}

export function full(nome: string): string {
  const t = separar(nome);
  return `${quoteIdent(t.schema)}.${quoteIdent(t.table)}`;
}

// ─────────────────────────────────────────────────────────────────────
// Helpers genéricos
// ─────────────────────────────────────────────────────────────────────

const NUMERICOS = new Set([
  "int",
  "bigint",
  "smallint",
  "tinyint",
  "numeric",
  "decimal",
  "money",
  "smallmoney",
  "float",
  "real",
]);

/** Procura a chave sem depender de maiúsculas/minúsculas. */
function campo(row: Record<string, unknown> | null, nome: string): unknown {
  if (!row) return null;
  if (nome in row) return row[nome];
  const alvo = nome.toLowerCase();
  for (const k of Object.keys(row)) {
    if (k.toLowerCase() === alvo) return row[k];
  }
  return null;
}

/** "VSG" + 54684 → "VSG/54684". */
function documento(row: Record<string, unknown> | null): string {
  const s = campo(row, "SerieFacturacao");
  const n = campo(row, "Numero Documento");
  if (s === null || s === undefined || n === null || n === undefined) return "(sem documento)";
  return `${String(s).trim()}/${String(n).trim()}`;
}

async function linhaInteira(
  pool: SqlPool,
  tabela: string,
  coluna: string,
  valor: number | string,
): Promise<Record<string, unknown> | null> {
  const r = await pool
    .request()
    .input("v", valor)
    .query<Record<string, unknown>>(
      `SELECT TOP 1 * FROM ${full(tabela)} WHERE ${quoteIdent(coluna)} = @v`,
    );
  return r.recordset[0] ?? null;
}

async function todasAsLinhas(
  pool: SqlPool,
  tabela: string,
  coluna: string,
  valor: number | string,
  limite = 20,
): Promise<Record<string, unknown>[]> {
  const r = await pool
    .request()
    .input("v", valor)
    .query<Record<string, unknown>>(
      `SELECT TOP ${limite} * FROM ${full(tabela)} WHERE ${quoteIdent(coluna)} = @v`,
    );
  return r.recordset;
}

function imprimirLinha(titulo: string, row: Record<string, unknown> | null, indent = "    "): void {
  if (!row) {
    console.log(`${indent}${titulo}: (nenhuma linha)`);
    return;
  }
  const chaves = Object.keys(row);
  const w = Math.min(34, Math.max(...chaves.map((k) => k.length)));
  console.log(`${indent}${titulo}:`);
  for (const k of chaves) {
    console.log(`${indent}  ${k.padEnd(w)}  ${formatCell(row[k], 70)}`);
  }
}

/** O cabeçalho suspenso reduzido aos sete campos que decidem tudo. */
function imprimirCabecalhoSusp(
  titulo: string,
  row: Record<string, unknown> | null,
  indent = "    ",
): void {
  if (!row) {
    console.log(`${indent}${titulo}: (nenhuma linha)`);
    return;
  }
  console.log(`${indent}${titulo}   ->   ${documento(row)}`);
  for (const c of CABECALHO_SUSP) {
    console.log(`${indent}  ${c.padEnd(22)}  ${formatCell(campo(row, c), 60)}`);
  }
}

async function estrutura(pool: SqlPool, nome: string): Promise<ColumnMeta[] | null> {
  const t = tbl(nome);
  console.log(RULE);
  if (!(await tableExists(pool, t))) {
    console.log(`${full(nome)} — NAO EXISTE nesta instalacao`);
    return null;
  }
  const [cols, pk, fkOut, fkIn] = await Promise.all([
    listColumns(pool, t),
    listPrimaryKey(pool, t),
    listForeignKeysOut(pool, t),
    listForeignKeysIn(pool, t),
  ]);
  const n = await pool.request().query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${full(nome)}`);
  console.log(`${full(nome)} — ${cols.length} colunas, ${n.recordset[0]?.n ?? 0} linhas`);
  console.log(`  PK: ${pk.length > 0 ? pk.join(", ") : "(sem PK declarada)"}`);
  console.log("  FKs declaradas PARA FORA (esta -> outras):");
  if (fkOut.length === 0) console.log("    (nenhuma)");
  for (const f of fkOut) {
    console.log(`    ${f.fromColumns.join(",")}  ->  ${f.toTable}.${f.toColumns.join(",")}`);
  }
  console.log("  FKs declaradas PARA DENTRO (outras -> esta):");
  if (fkIn.length === 0) console.log("    (nenhuma)");
  for (const f of fkIn) {
    console.log(`    ${f.fromTable}.${f.fromColumns.join(",")}  ->  ${f.toColumns.join(",")}`);
  }
  console.log("  Colunas:");
  for (const c of cols) {
    console.log(`    ${c.name.padEnd(34)} ${renderColumnType(c)}${c.nullable ? "" : "  NOT NULL"}`);
  }
  return cols;
}

/** Em que colunas numéricas desta tabela é que este valor aparece. */
async function ondeVive(
  pool: SqlPool,
  tabela: string,
  cols: ColumnMeta[],
  valor: number,
): Promise<Array<{ coluna: string; n: number }>> {
  const achados: Array<{ coluna: string; n: number }> = [];
  for (const c of cols) {
    if (!NUMERICOS.has(c.dataType.toLowerCase())) continue;
    try {
      const r = await pool
        .request()
        .input("v", sql.BigInt, valor)
        .query<{ n: number }>(
          `SELECT COUNT(*) AS n FROM ${full(tabela)} WHERE ${quoteIdent(c.name)} = @v`,
        );
      const n = Number(r.recordset[0]?.n ?? 0);
      if (n > 0) achados.push({ coluna: c.name, n });
    } catch {
      // Overflow numa coluna estreita não é um resultado: essa coluna
      // simplesmente não pode conter este valor.
    }
  }
  return achados;
}

/**
 * As colunas desta tabela que podem apontar para `[Atendimento Susp]`:
 * as FKs declaradas, mais as que o nome denuncia.
 *
 * As declaradas não chegam sozinhas — se só o lado FT tiver FK, o lado da
 * NC fica de fora e era precisamente esse que viemos buscar.
 */
function colunasParaSusp(cols: ColumnMeta[], fkOut: ForeignKeyEdge[]): string[] {
  const out = new Set<string>();
  for (const f of fkOut) {
    if (separar(f.toTable).table.toLowerCase() === T_SUSP.toLowerCase()) {
      for (const c of f.fromColumns) out.add(c);
    }
  }
  for (const c of cols) {
    if (/susp/i.test(c.name) && /\bid\b|id$|id_/i.test(c.name)) out.add(c.name);
  }
  return [...out];
}

async function seccao(titulo: string, fn: () => Promise<void>): Promise<void> {
  console.log("");
  console.log(DOUBLE);
  console.log(titulo);
  console.log(DOUBLE);
  try {
    await fn();
  } catch (err) {
    console.log(`✗ SECCAO FALHOU: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────

export async function vendasSuspCadeia(): Promise<number> {
  let args: Args;
  try {
    args = parseCmdArgs();
  } catch (err) {
    console.error("✗", err instanceof Error ? err.message : err);
    return 1;
  }
  if (args.help) {
    console.log("Uso: vendas-susp-cadeia [--dia YYYY-MM-DD] [--susp-det-ids a,b]");
    console.log("                        [--serie VSG] [--numeros n1,n2]");
    console.log("");
    console.log("Read-only. Susp Detalhe -> Atendimento Susp -> VSG/numero, e");
    console.log("Atendimento Susp -> Atendimento_SuspFT_NC_Susp -> NC/anulacao.");
    return 0;
  }

  const j = janela(args.dia, args.dia);
  const cfg = loadConfig("sql");

  return withPool(cfg, async (pool) => {
    console.log(DOUBLE);
    console.log("vendas-susp-cadeia — READ-ONLY");
    console.log(DOUBLE);
    console.log(`ERP      : ${cfg.sqlDatabase}@${cfg.sqlHost}`);
    console.log(`Dia      : ${j.inicio} .. ${j.fimExclusivo} (exclusivo)`);
    console.log(`Ancora A : ${T_SUSP_DET} ID ${args.suspDetIds.join(", ")}`);
    console.log(`Ancora B : ${args.serie}/${args.numeros.join(`, ${args.serie}/`)}`);
    console.log("");
    console.log("O cabecalho documental e [Atendimento Susp], nao [Atendimento].");
    console.log("Nenhuma query aqui toca em [Atendimento].");

    let colsSuspFtNc: ColumnMeta[] | null = null;
    /** Os cabeçalhos suspensos dos casos conhecidos, para a §3. */
    const suspIds: number[] = [];

    // ── 1. Estrutura ─────────────────────────────────────────────
    await seccao("1. ESTRUTURA", async () => {
      await estrutura(pool, T_SUSP_DET);
      await estrutura(pool, T_SUSP);
      colsSuspFtNc = await estrutura(pool, T_SUSP_FT_NC);
      await estrutura(pool, T_FT_NC);
    });

    // ── 2. Susp Detalhe → Atendimento Susp → VSG/numero ──────────
    await seccao("2. CADEIA — linha -> cabecalho suspenso -> documento", async () => {
      const pkSuspDet = (await listPrimaryKey(pool, tbl(T_SUSP_DET)))[0];
      if (!pkSuspDet) {
        console.log(`✗ [${T_SUSP_DET}] sem PK declarada.`);
        return;
      }
      const fkOut = await listForeignKeysOut(pool, tbl(T_SUSP_DET));
      const fkSusp = fkOut.find(
        (f) => separar(f.toTable).table.toLowerCase() === T_SUSP.toLowerCase(),
      );
      const colSuspId = fkSusp?.fromColumns[0] ?? "Atendimento Susp ID";
      console.log(`PK      : ${pkSuspDet}`);
      console.log(`FK usada: ${colSuspId} -> ${T_SUSP} (${fkSusp ? "declarada" : "por nome"})`);

      for (const id of args.suspDetIds) {
        console.log("");
        console.log(RULE);
        console.log(`### ${T_SUSP_DET}.${pkSuspDet} = ${id}`);
        const linha = await linhaInteira(pool, T_SUSP_DET, pkSuspDet, id);
        if (!linha) {
          console.log("  (nao existe)");
          continue;
        }
        imprimirLinha("linha suspensa (todas as colunas)", linha, "  ");

        const codigoId = Number(campo(linha, "CodigoID"));
        if (Number.isFinite(codigoId)) {
          const prod = await linhaInteira(pool, T_STOCKS, "CodigoID", codigoId);
          console.log(
            `    produto : CodigoID=${codigoId}  CNP=${formatCell(campo(prod, "Codigo"))}  ` +
              `${formatCell(campo(prod, "Nome Comercial"), 44)}`,
          );
        }

        const suspId = Number(campo(linha, colSuspId));
        if (!Number.isFinite(suspId)) {
          console.log(`    ✗ ${colSuspId} vazio — sem cabecalho a seguir.`);
          continue;
        }
        suspIds.push(suspId);
        const cab = await linhaInteira(pool, T_SUSP, "Atendimento Susp ID", suspId);
        console.log("");
        imprimirCabecalhoSusp(`[${T_SUSP}] ${suspId}`, cab, "    ");
        console.log("");
        imprimirLinha(`[${T_SUSP}] ${suspId} (todas as colunas)`, cab, "    ");
      }
    });

    // ── 3. A reversão ────────────────────────────────────────────
    await seccao("3. REVERSAO — Atendimento_SuspFT_NC_Susp", async () => {
      if (!(await tableExists(pool, tbl(T_SUSP_FT_NC)))) {
        console.log("NAO EXISTE nesta instalacao.");
        return;
      }
      const cols = colsSuspFtNc ?? (await listColumns(pool, tbl(T_SUSP_FT_NC)));
      const fkOut = await listForeignKeysOut(pool, tbl(T_SUSP_FT_NC));
      const ligacoes = colunasParaSusp(cols, fkOut);
      console.log(`colunas que apontam para [${T_SUSP}]: ${ligacoes.join(", ") || "(nenhuma)"}`);

      // Nulos por lado. Se um lado for quase todo nulo, esta tabela não é
      // "factura -> NC" simétrica, e o reader tem de a ler nesse sentido.
      if (ligacoes.length > 0) {
        const sel = ligacoes
          .map(
            (c, i) =>
              `SUM(CASE WHEN ${quoteIdent(c)} IS NULL THEN 1 ELSE 0 END) AS nulo${i}, ` +
              `COUNT(DISTINCT ${quoteIdent(c)}) AS dist${i}`,
          )
          .join(", ");
        const r = await pool
          .request()
          .query<Record<string, number>>(
            `SELECT COUNT(*) AS n, ${sel} FROM ${full(T_SUSP_FT_NC)}`,
          );
        const row = r.recordset[0];
        console.log(`relacoes: ${row?.n ?? 0}`);
        ligacoes.forEach((c, i) => {
          console.log(
            `  ${c.padEnd(28)} distintos=${String(row?.[`dist${i}`] ?? 0).padStart(7)}  ` +
              `nulos=${String(row?.[`nulo${i}`] ?? 0).padStart(7)}`,
          );
        });
      }

      // Os casos conhecidos. Sonda por CONTEUDO: onde e que este
      // Atendimento Susp ID aparece nesta tabela, seja qual for a coluna.
      for (const suspId of suspIds) {
        console.log("");
        console.log(RULE);
        console.log(`### ${T_SUSP} ID ${suspId} — relacoes encontradas`);
        const achados = await ondeVive(pool, T_SUSP_FT_NC, cols, suspId);
        if (achados.length === 0) {
          console.log("  (nenhuma coluna desta tabela contem este ID)");
          console.log("  Leitura: este documento nao tem reversao registada aqui.");
          continue;
        }
        for (const a of achados) {
          const linhas = await todasAsLinhas(pool, T_SUSP_FT_NC, a.coluna, suspId);
          console.log("");
          console.log(`  via ${a.coluna} — ${linhas.length} relacao(oes):`);
          for (const rel of linhas) {
            imprimirLinha("relacao (todas as colunas)", rel, "    ");
            // O OUTRO lado: todas as colunas de ligação excepto aquela
            // por onde entrámos, resolvidas até ao documento.
            for (const outra of ligacoes) {
              if (outra === a.coluna) continue;
              const v = campo(rel, outra);
              if (v === null || v === undefined) {
                console.log(`      ${outra}: NULL`);
                continue;
              }
              const cab = await linhaInteira(pool, T_SUSP, "Atendimento Susp ID", v as number);
              console.log("");
              imprimirCabecalhoSusp(`outro lado via ${outra}=${formatCell(v)}`, cab, "      ");
            }
          }
        }
      }

      // Que documentos vivem de cada lado. É esta lista que diz o que
      // falta declarar como VENDA e o que falta declarar como reversão.
      for (const c of ligacoes) {
        const dist = await pool.request().query<{
          serie: string | null;
          tipoDoc: number | null;
          fimVenda: string | null;
          n: number;
        }>(
          `SELECT s.[SerieFacturacao] AS serie, s.[Tipo Documento ID] AS tipoDoc,
                  s.[Fim Venda] AS fimVenda, COUNT(*) AS n
             FROM ${full(T_SUSP_FT_NC)} x
             JOIN ${full(T_SUSP)} s ON s.[Atendimento Susp ID] = x.${quoteIdent(c)}
            GROUP BY s.[SerieFacturacao], s.[Tipo Documento ID], s.[Fim Venda]
            ORDER BY COUNT(*) DESC`,
        );
        console.log("");
        console.log(`  lado ${c} — serie x tipoDoc x fimVenda:`);
        if (dist.recordset.length === 0) console.log("    (nada resolve contra Atendimento Susp)");
        for (const d of dist.recordset) {
          console.log(
            `    serie=${formatCell(d.serie, 10).padEnd(11)} tipoDoc=${String(d.tipoDoc ?? "-").padEnd(6)} ` +
              `fimVenda=${formatCell(d.fimVenda, 4).padEnd(5)} n=${d.n}`,
          );
        }
      }
    });

    // ── 4. Do documento para as linhas ───────────────────────────
    await seccao("4. SUBIDA — do documento VSG conhecido ate as linhas", async () => {
      const inList = args.numeros.map((n) => String(Math.trunc(n))).join(",");
      const docs = await pool
        .request()
        .input("serie", sql.NVarChar, args.serie)
        .query<Record<string, unknown>>(
          `SELECT * FROM ${full(T_SUSP)}
            WHERE [Numero Documento] IN (${inList}) AND [SerieFacturacao] = @serie`,
        );
      if (docs.recordset.length === 0) {
        console.log(`(nenhum [${T_SUSP}] com SerieFacturacao=${args.serie} e Numero em ${inList})`);
        return;
      }
      for (const d of docs.recordset) {
        const suspId = Number(campo(d, "Atendimento Susp ID"));
        console.log("");
        console.log(RULE);
        imprimirCabecalhoSusp(`### ${documento(d)}`, d, "  ");
        const linhas = await pool
          .request()
          .input("v", sql.Int, suspId)
          .query<{ cnp: string | null; nome: string | null; qtd: number; valor: number }>(
            `SELECT s.[Codigo] AS cnp, s.[Nome Comercial] AS nome,
                    d.[Quantidade] AS qtd, d.[Valor_EUR] AS valor
               FROM ${full(T_SUSP_DET)} d
               LEFT JOIN ${full(T_STOCKS)} s ON s.[CodigoID] = d.[CodigoID]
              WHERE d.[Atendimento Susp ID] = @v`,
          );
        console.log("");
        console.log(`    ${linhas.recordset.length} linha(s):`);
        for (const l of linhas.recordset) {
          console.log(
            `      CNP=${formatCell(l.cnp, 10).padEnd(11)} qtd=${String(l.qtd).padStart(5)} ` +
              `valor=${String(l.valor).padStart(9)}  ${formatCell(l.nome, 40)}`,
          );
        }
      }
    });

    // ── 5. O dia inteiro, por série e tipo ───────────────────────
    await seccao("5. DOCUMENTOS DO DIA — serie x tipoDoc x [Fim Venda]", async () => {
      const r = await pool
        .request()
        .input("from", sql.NVarChar, j.inicio)
        .input("to", sql.NVarChar, j.fimExclusivo)
        .query<{
          serie: string | null;
          tipoDoc: number | null;
          fimVenda: string | null;
          n: number;
          minNum: number | null;
          maxNum: number | null;
          total: number | null;
        }>(
          `SELECT [SerieFacturacao] AS serie, [Tipo Documento ID] AS tipoDoc,
                  [Fim Venda] AS fimVenda, COUNT(*) AS n,
                  MIN([Numero Documento]) AS minNum, MAX([Numero Documento]) AS maxNum,
                  SUM([Total Bruto_EUR]) AS total
             FROM ${full(T_SUSP)}
            WHERE [Data Venda] >= @from AND [Data Venda] < @to
            GROUP BY [SerieFacturacao], [Tipo Documento ID], [Fim Venda]
            ORDER BY COUNT(*) DESC`,
        );
      if (r.recordset.length === 0) {
        console.log("(sem documentos suspensos no dia pedido)");
        return;
      }
      console.log(
        `  ${"serie".padEnd(12)}${"tipoDoc".padEnd(9)}${"fimVenda".padEnd(10)}${"docs".padEnd(7)}` +
          `${"total_EUR".padEnd(14)}numeros`,
      );
      for (const d of r.recordset) {
        console.log(
          `  ${formatCell(d.serie, 11).padEnd(12)}${String(d.tipoDoc ?? "-").padEnd(9)}` +
            `${formatCell(d.fimVenda, 9).padEnd(10)}${String(d.n).padEnd(7)}` +
            `${String(d.total ?? "-").padEnd(14)}${d.minNum ?? "-"} .. ${d.maxNum ?? "-"}`,
        );
      }
      console.log("");
      console.log("  Cada tipoDoc que aparecer aqui tem de ser declarado como");
      console.log("  VENDA ou como reversao antes de qualquer backfill. Um tipo");
      console.log("  por declarar e uma linha recusada — nunca uma venda por acidente.");
    });

    // ── 6. [Fim Venda] no cabeçalho suspenso ─────────────────────
    await seccao("6. [Fim Venda] em [Atendimento Susp] — o que vale mesmo", async () => {
      const r = await pool.request().query<{ v: string | null; n: number }>(
        `SELECT [Fim Venda] AS v, COUNT(*) AS n
           FROM ${full(T_SUSP)}
          GROUP BY [Fim Venda]
          ORDER BY COUNT(*) DESC`,
      );
      for (const d of r.recordset) {
        console.log(`  ${formatCell(d.v, 12).padEnd(14)} ${d.n}`);
      }
      console.log("");
      console.log("  No [Atendimento] este filtro devolvia ZERO para o circuito");
      console.log("  suspenso. Aqui e outra coluna, noutra tabela: o que ela vale");
      console.log("  le-se destes numeros, nao do nome.");
    });

    // ── 7. Controlo: a outra tabela FT/NC ────────────────────────
    await seccao("7. CONTROLO — Atendimento_FT_NC_Susp contem estes IDs?", async () => {
      if (!(await tableExists(pool, tbl(T_FT_NC)))) {
        console.log("NAO EXISTE nesta instalacao.");
        return;
      }
      const cols = await listColumns(pool, tbl(T_FT_NC));
      for (const suspId of suspIds) {
        const ach = await ondeVive(pool, T_FT_NC, cols, suspId);
        console.log(
          `  Susp ID ${suspId}: ` +
            (ach.length > 0 ? ach.map((a) => `${a.coluna} (${a.n}x)`).join(", ") : "(ausente)"),
        );
      }
      console.log("");
      console.log("  Se estiver ausente, esta tabela e do circuito [Atendimento]");
      console.log("  e nao entra no reader da VSG.");
    });

    // ── 8. O gate ────────────────────────────────────────────────
    await seccao("8. GATE — os casos conhecidos", async () => {
      const pkSuspDet = (await listPrimaryKey(pool, tbl(T_SUSP_DET)))[0];
      if (!pkSuspDet) {
        console.log("(sem PK — nao ha como contar)");
        return;
      }
      const inList = args.suspDetIds.map((n) => String(Math.trunc(n))).join(",");
      const r = await pool.request().query<{
        id: number;
        suspId: number | null;
        cnp: string | null;
        nome: string | null;
        qtd: number | null;
        valor: number | null;
        serie: string | null;
        numero: number | null;
        tipoDoc: number | null;
      }>(
        `SELECT d.${quoteIdent(pkSuspDet)} AS id, d.[Atendimento Susp ID] AS suspId,
                st.[Codigo] AS cnp, st.[Nome Comercial] AS nome,
                d.[Quantidade] AS qtd, d.[Valor_EUR] AS valor,
                h.[SerieFacturacao] AS serie, h.[Numero Documento] AS numero,
                h.[Tipo Documento ID] AS tipoDoc
           FROM ${full(T_SUSP_DET)} d
           LEFT JOIN ${full(T_SUSP)} h ON h.[Atendimento Susp ID] = d.[Atendimento Susp ID]
           LEFT JOIN ${full(T_STOCKS)} st ON st.[CodigoID] = d.[CodigoID]
          WHERE d.${quoteIdent(pkSuspDet)} IN (${inList})`,
      );
      console.log("  Esperado: 9599258 NIMED = 2 un, 3626884 ENALAPRIL = 1 un");
      console.log("");
      for (const d of r.recordset) {
        console.log(
          `    ${pkSuspDet}=${String(d.id).padEnd(8)} CNP=${formatCell(d.cnp, 10).padEnd(11)} ` +
            `qtd=${String(d.qtd ?? "-").padEnd(5)} valor=${String(d.valor ?? "-").padEnd(9)} ` +
            `doc=${formatCell(d.serie, 6)}/${d.numero ?? "-"} tipoDoc=${d.tipoDoc ?? "-"}`,
        );
      }
    });

    console.log("");
    console.log(DOUBLE);
    console.log("FIM — nada foi escrito. Nenhum POST ao SaaS.");
    console.log(DOUBLE);
    return 0;
  });
}
