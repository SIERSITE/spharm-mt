/**
 * agent/src/commands/vendas-susp-nc.ts
 *
 * Onde está a nota de crédito de uma venda suspensa, e onde estão as
 * suas linhas. Read-only. É a única pergunta desta sonda.
 *
 * ── O QUE JÁ ESTÁ FECHADO (não se repete aqui) ───────────────────────
 *
 * A origem da VSG positiva está provada e esta sonda não lhe volta:
 *
 *     [Atendimento Susp Detalhe].[Atendimento Susp ID]
 *         --FK declarada--> [Atendimento Susp]
 *
 *     147214 -> 83708 -> VSG/54684 -> tipoDoc 107 -> 9599258 -> 2 un -> 10,72 €
 *     147219 -> 83712 -> VSG/54688 -> tipoDoc 107 -> 3626884 -> 1 un ->  9,97 €
 *
 * E `[Fim Venda]` NÃO é gate: as duas vendas confirmadas têm `N`, e no
 * mesmo dia há VSG tipo 107 com `N` e com `S`. Nenhuma query aqui o usa
 * para filtrar seja o que for.
 *
 * ── A PERGUNTA ───────────────────────────────────────────────────────
 *
 * `[Atendimento_SuspFT_NC_Susp]` tem 107 relações e duas colunas:
 *
 *     [Atendimento Susp ID_FT]  --FK declarada--> [Atendimento Susp]
 *     [Atendimento ID_NC]       --sem FK declarada-->  ?
 *
 * O nome sugere `[Atendimento]`. Sugerir não é provar — foi assim que o
 * reader ligou a coluna errada duas rondas atrás. Por isso a §3 pega em
 * valores REAIS de `[Atendimento ID_NC]` e procura-os por CONTEÚDO em
 * todas as chaves primárias do ERP: a tabela onde eles existem é a
 * resposta, seja qual for o nome dela.
 *
 * ── O RISCO QUE A §6 EXISTE PARA APANHAR ─────────────────────────────
 *
 * Se a NC viver em `[Atendimento]` + `[Atendimento Detalhe]`, então o
 * reader do circuito G JÁ A LÊ — e acrescentar um reader de reversões
 * VSG subtrairia a mesma nota de crédito duas vezes. O erro simétrico do
 * que andamos a corrigir, e igualmente plausível à vista. A §6 verifica
 * isso antes de alguém escrever o reader.
 *
 * Uso:
 *   agent -- vendas-susp-nc
 *   agent -- vendas-susp-nc --limite 20
 *   agent -- vendas-susp-nc --ids 51234,51240
 */

import { parseArgs } from "node:util";
import sql from "mssql";
import { loadConfig } from "../config.js";
import { withPool, type SqlPool } from "../sql-client.js";
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
} from "./probe-helpers.js";
import { full, separar } from "./vendas-susp-cadeia.js";

const RULE = "─".repeat(70);
const DOUBLE = "═".repeat(70);

const T_REL = "Atendimento_SuspFT_NC_Susp";
const T_SUSP = "Atendimento Susp";
const T_STOCKS = "Stocks";

/**
 * Acima disto, uma coluna sem índice custa um scan por cada sonda. A §3
 * salta-as e DIZ quantas saltou — um limite silencioso lê-se como
 * "procurei em todo o lado" quando não foi isso que aconteceu.
 */
const MAX_LINHAS_SCAN = 300_000;

type Args = { limite: number; ids: number[] | null; help: boolean };

function parseCmdArgs(): Args {
  const raw = parseArgs({
    args: process.argv.slice(3),
    options: {
      limite: { type: "string" },
      ids: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  const lim = Number(raw.values.limite ?? 10);
  const ids =
    typeof raw.values.ids === "string"
      ? raw.values.ids
          .split(",")
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isInteger(n))
      : null;
  return {
    limite: Number.isFinite(lim) && lim > 0 ? Math.min(lim, 100) : 10,
    ids: ids && ids.length > 0 ? ids : null,
    help: raw.values.help === true,
  };
}

// ─────────────────────────────────────────────────────────────────────

function campo(row: Record<string, unknown> | null, nome: string): unknown {
  if (!row) return null;
  if (nome in row) return row[nome];
  const alvo = nome.toLowerCase();
  for (const k of Object.keys(row)) {
    if (k.toLowerCase() === alvo) return row[k];
  }
  return null;
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

type TabelaPk = { tabela: string; pk: string; linhas: number };

/**
 * Todas as user-tables com PK de uma só coluna inteira, e o seu tamanho.
 *
 * Sondar a PK é barato: é um seek por índice, não um scan. É o que torna
 * viável perguntar "em que tabela deste ERP existe este identificador?"
 * sem varrer a base inteira.
 */
async function tabelasComPkInteira(pool: SqlPool): Promise<TabelaPk[]> {
  const r = await pool.request().query<{ tabela: string; pk: string; linhas: number }>(`
    SELECT s.name + '.' + t.name AS tabela, c.name AS pk,
           ISNULL(p.rows, 0) AS linhas
      FROM sys.tables t
      JOIN sys.schemas s ON s.schema_id = t.schema_id
      JOIN sys.indexes i ON i.object_id = t.object_id AND i.is_primary_key = 1
      JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
      JOIN sys.columns c ON c.object_id = i.object_id AND c.column_id = ic.column_id
      JOIN sys.types ty ON ty.user_type_id = c.user_type_id
      LEFT JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
     WHERE t.is_ms_shipped = 0
       AND ty.name IN ('int', 'bigint', 'smallint', 'numeric', 'decimal')
       AND 1 = (SELECT COUNT(*) FROM sys.index_columns ic2
                 WHERE ic2.object_id = i.object_id AND ic2.index_id = i.index_id)
     ORDER BY 1`);
  return r.recordset;
}

/** Colunas inteiras cujo nome sugere um identificador de atendimento. */
async function colunasCandidatas(
  pool: SqlPool,
): Promise<Array<{ tabela: string; coluna: string; linhas: number }>> {
  const r = await pool.request().query<{ tabela: string; coluna: string; linhas: number }>(`
    SELECT s.name + '.' + t.name AS tabela, c.name AS coluna,
           ISNULL(p.rows, 0) AS linhas
      FROM sys.columns c
      JOIN sys.tables t ON t.object_id = c.object_id
      JOIN sys.schemas s ON s.schema_id = t.schema_id
      JOIN sys.types ty ON ty.user_type_id = c.user_type_id
      LEFT JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
     WHERE t.is_ms_shipped = 0
       AND ty.name IN ('int', 'bigint', 'smallint')
       AND c.name LIKE '%Atendimento%'
       AND c.name LIKE '%ID%'
     ORDER BY 1, 2`);
  return r.recordset;
}

/** Quantos dos `ids` existem nesta coluna. */
async function quantosLaEstao(
  pool: SqlPool,
  tabela: string,
  coluna: string,
  ids: number[],
): Promise<number> {
  const inList = ids.map((n) => String(Math.trunc(n))).join(",");
  const r = await pool
    .request()
    .query<{ n: number }>(
      `SELECT COUNT(DISTINCT ${quoteIdent(coluna)}) AS n
         FROM ${full(tabela)} WHERE ${quoteIdent(coluna)} IN (${inList})`,
    );
  return Number(r.recordset[0]?.n ?? 0);
}

/** Os campos documentais de uma tabela desconhecida, por nome. */
function camposDocumentais(cols: ColumnMeta[]): Record<string, string | null> {
  const acha = (re: RegExp) => cols.find((c) => re.test(c.name))?.name ?? null;
  return {
    serie: acha(/^serie/i),
    numero: acha(/^numero/i),
    tipoDocumento: acha(/tipo\s*documento/i),
    data: acha(/^data\s*venda/i) ?? acha(/^data/i),
    total: acha(/total.*bruto/i) ?? acha(/^total/i),
  };
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

export async function vendasSuspNc(): Promise<number> {
  let args: Args;
  try {
    args = parseCmdArgs();
  } catch (err) {
    console.error("✗", err instanceof Error ? err.message : err);
    return 1;
  }
  if (args.help) {
    console.log("Uso: vendas-susp-nc [--limite N] [--ids a,b]");
    console.log("");
    console.log("Read-only. Dada uma linha de Atendimento_SuspFT_NC_Susp,");
    console.log("onde esta a NC e onde estao as suas linhas.");
    return 0;
  }

  const cfg = loadConfig("sql");

  return withPool(cfg, async (pool) => {
    console.log(DOUBLE);
    console.log("vendas-susp-nc — READ-ONLY");
    console.log(DOUBLE);
    console.log(`ERP : ${cfg.sqlDatabase}@${cfg.sqlHost}`);
    console.log("");
    console.log("A origem da VSG positiva esta fechada e nao e reinvestigada.");
    console.log("[Fim Venda] nao e usado como filtro em query nenhuma: as duas");
    console.log("vendas confirmadas tem N, e o dia tem 107 com N e com S.");

    if (!(await tableExists(pool, separar(T_REL)))) {
      console.log(`\n✗ [${T_REL}] nao existe nesta instalacao. Nada a fazer.`);
      return 1;
    }

    let colRelFt = "Atendimento Susp ID_FT";
    let colRelNc = "Atendimento ID_NC";
    let idsNc: number[] = [];
    /** Onde os `Atendimento ID_NC` foram encontrados: tabela + coluna. */
    let ondeNc: Array<{ tabela: string; coluna: string; achados: number }> = [];

    // ── 1. A tabela das relações ─────────────────────────────────
    await seccao("1. Atendimento_SuspFT_NC_Susp", async () => {
      const t = separar(T_REL);
      const [cols, pk, fkOut, fkIn] = await Promise.all([
        listColumns(pool, t),
        listPrimaryKey(pool, t),
        listForeignKeysOut(pool, t),
        listForeignKeysIn(pool, t),
      ]);
      const n = await pool.request().query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${full(T_REL)}`);
      console.log(`${full(T_REL)} — ${cols.length} colunas, ${n.recordset[0]?.n ?? 0} linhas`);
      console.log(`  PK: ${pk.length > 0 ? pk.join(", ") : "(sem PK declarada)"}`);
      console.log("  FKs PARA FORA:");
      if (fkOut.length === 0) console.log("    (nenhuma)");
      for (const f of fkOut) {
        console.log(`    ${f.fromColumns.join(",")}  ->  ${f.toTable}.${f.toColumns.join(",")}`);
      }
      console.log("  FKs PARA DENTRO:");
      if (fkIn.length === 0) console.log("    (nenhuma)");
      for (const f of fkIn) {
        console.log(`    ${f.fromTable}.${f.fromColumns.join(",")}  ->  ${f.toColumns.join(",")}`);
      }
      console.log("  Colunas:");
      for (const c of cols) {
        console.log(`    ${c.name.padEnd(32)} ${renderColumnType(c)}${c.nullable ? "" : "  NOT NULL"}`);
      }

      // Os nomes reais, não os que eu assumo.
      const ft = cols.find((c) => /_FT$/i.test(c.name) || /ft/i.test(c.name));
      const nc = cols.find((c) => /_NC$/i.test(c.name) || /nc/i.test(c.name));
      if (ft) colRelFt = ft.name;
      if (nc) colRelNc = nc.name;
      console.log("");
      console.log(`  lado FT: ${colRelFt}`);
      console.log(`  lado NC: ${colRelNc}`);

      const nulos = await pool.request().query<{ ftNulo: number; ncNulo: number; ncDist: number }>(
        `SELECT SUM(CASE WHEN ${quoteIdent(colRelFt)} IS NULL THEN 1 ELSE 0 END) AS ftNulo,
                SUM(CASE WHEN ${quoteIdent(colRelNc)} IS NULL THEN 1 ELSE 0 END) AS ncNulo,
                COUNT(DISTINCT ${quoteIdent(colRelNc)}) AS ncDist
           FROM ${full(T_REL)}`,
      );
      const u = nulos.recordset[0];
      console.log(
        `  ${colRelFt} nulos=${u?.ftNulo ?? 0}   ` +
          `${colRelNc} nulos=${u?.ncNulo ?? 0} distintos=${u?.ncDist ?? 0}`,
      );
    });

    // ── 2. Linhas reais ──────────────────────────────────────────
    await seccao(`2. AMOSTRA — ${args.limite} relacoes reais, inteiras`, async () => {
      const r = await pool
        .request()
        .query<Record<string, unknown>>(
          `SELECT TOP ${args.limite} * FROM ${full(T_REL)}
            ORDER BY ${quoteIdent(colRelNc)} DESC`,
        );
      for (const [i, row] of r.recordset.entries()) {
        imprimirLinha(`relacao ${i + 1}`, row, "  ");
      }
      idsNc =
        args.ids ??
        r.recordset
          .map((row) => Number(campo(row, colRelNc)))
          .filter((n) => Number.isFinite(n) && n > 0);
      console.log("");
      console.log(`  ${colRelNc} a investigar: ${idsNc.join(", ") || "(nenhum)"}`);
    });

    if (idsNc.length === 0) {
      console.log("\n✗ Sem identificadores de NC para investigar. Fim.");
      return 1;
    }

    // ── 3. Onde vive o identificador ─────────────────────────────
    await seccao(`3. ONDE VIVE — ${colRelNc} procurado por CONTEUDO`, async () => {
      console.log("Sonda 1: chaves primarias inteiras de todas as user-tables.");
      console.log("(seek por indice — barato, e decisivo: se o ID existe como PK");
      console.log(" de uma tabela, essa tabela e o cabecalho da NC.)");
      console.log("");
      const pks = await tabelasComPkInteira(pool);
      console.log(`  ${pks.length} tabelas com PK inteira de uma coluna.`);
      const achadosPk: Array<{ tabela: string; coluna: string; achados: number }> = [];
      for (const t of pks) {
        try {
          const n = await quantosLaEstao(pool, t.tabela, t.pk, idsNc);
          if (n > 0) achadosPk.push({ tabela: t.tabela, coluna: t.pk, achados: n });
        } catch {
          // Tipo incompatível ou permissão — não é um resultado.
        }
      }
      if (achadosPk.length === 0) {
        console.log("  ✗ nenhum destes IDs existe como PK de tabela nenhuma.");
      }
      for (const a of achadosPk.sort((x, y) => y.achados - x.achados)) {
        console.log(
          `  ${a.tabela.padEnd(44)} ${a.coluna.padEnd(26)} ${a.achados}/${idsNc.length} encontrados`,
        );
      }
      ondeNc = achadosPk;

      console.log("");
      console.log("Sonda 2: colunas inteiras com 'Atendimento' e 'ID' no nome.");
      console.log("(apanha tabelas-ponte onde o ID nao e PK)");
      console.log("");
      const cands = await colunasCandidatas(pool);
      const grandes = cands.filter((c) => c.linhas > MAX_LINHAS_SCAN);
      const sondaveis = cands.filter((c) => c.linhas <= MAX_LINHAS_SCAN);
      console.log(
        `  ${cands.length} colunas candidatas; ${sondaveis.length} sondadas, ` +
          `${grandes.length} saltadas por terem mais de ${MAX_LINHAS_SCAN} linhas.`,
      );
      if (grandes.length > 0) {
        console.log(`  saltadas: ${grandes.map((g) => `${g.tabela}.${g.coluna}`).join(", ")}`);
      }
      const achadosCol: Array<{ tabela: string; coluna: string; achados: number }> = [];
      for (const c of sondaveis) {
        try {
          const n = await quantosLaEstao(pool, c.tabela, c.coluna, idsNc);
          if (n > 0) achadosCol.push({ tabela: c.tabela, coluna: c.coluna, achados: n });
        } catch {
          /* idem */
        }
      }
      if (achadosCol.length === 0) console.log("  (nenhuma)");
      for (const a of achadosCol.sort((x, y) => y.achados - x.achados)) {
        console.log(
          `  ${a.tabela.padEnd(44)} ${a.coluna.padEnd(26)} ${a.achados}/${idsNc.length} encontrados`,
        );
      }
    });

    if (ondeNc.length === 0) {
      console.log("");
      console.log("✗ O identificador da NC nao existe como PK de nenhuma tabela.");
      console.log("  Sem cabecalho nao ha NC a seguir. PARAR aqui e reportar.");
      return 1;
    }

    // A tabela onde MAIS IDs foram encontrados é o cabeçalho da NC.
    const alvo = ondeNc[0]!;
    const tabelaNc = alvo.tabela;
    const pkNc = alvo.coluna;

    // ── 4. O cabeçalho da NC ─────────────────────────────────────
    await seccao(`4. O CABECALHO DA NC — ${tabelaNc}`, async () => {
      const cols = await listColumns(pool, separar(tabelaNc));
      const doc = camposDocumentais(cols);
      console.log(
        `campos documentais: serie=${doc.serie ?? "-"} numero=${doc.numero ?? "-"} ` +
          `tipoDoc=${doc.tipoDocumento ?? "-"} data=${doc.data ?? "-"} total=${doc.total ?? "-"}`,
      );
      for (const id of idsNc.slice(0, 3)) {
        const row = await linhaInteira(pool, tabelaNc, pkNc, id);
        console.log("");
        console.log(RULE);
        imprimirLinha(`${pkNc} = ${id} (todas as colunas)`, row, "  ");
      }

      // Que documentos são estas 107 NC, no conjunto.
      const grupo = [doc.serie, doc.tipoDocumento].filter((c): c is string => !!c);
      if (grupo.length > 0) {
        const dist = await pool.request().query<{
          serie: string | null;
          tipoDoc: number | null;
          n: number;
        }>(
          `SELECT ${doc.serie ? `a.${quoteIdent(doc.serie)}` : "NULL"} AS serie,
                  ${doc.tipoDocumento ? `a.${quoteIdent(doc.tipoDocumento)}` : "NULL"} AS tipoDoc,
                  COUNT(*) AS n
             FROM ${full(T_REL)} x
             JOIN ${full(tabelaNc)} a ON a.${quoteIdent(pkNc)} = x.${quoteIdent(colRelNc)}
            GROUP BY ${grupo.map((g) => `a.${quoteIdent(g)}`).join(", ")}
            ORDER BY COUNT(*) DESC`,
        );
        console.log("");
        console.log("  As 107 relacoes, do lado NC — serie x tipoDoc:");
        for (const d of dist.recordset) {
          console.log(
            `    serie=${formatCell(d.serie, 10).padEnd(11)} tipoDoc=${String(d.tipoDoc ?? "-").padEnd(6)} n=${d.n}`,
          );
        }
        console.log("");
        console.log("  Cada tipoDoc aqui tem de ser declarado como reversao antes");
        console.log("  de qualquer backfill. Nao declarado = linha recusada.");
      }
    });

    // ── 5. As linhas da NC ───────────────────────────────────────
    await seccao("5. AS LINHAS DA NC — que tabela as guarda", async () => {
      const filhas = await listForeignKeysIn(pool, separar(tabelaNc));
      console.log(`tabelas que referenciam ${tabelaNc}: ${filhas.length}`);
      if (filhas.length === 0) {
        console.log("(nenhuma FK declarada aponta para ca — as linhas ligam-se de outra forma)");
      }
      for (const f of filhas) {
        const col = f.fromColumns[0];
        if (!col) continue;
        let n = 0;
        try {
          n = await quantosLaEstao(pool, f.fromTable, col, idsNc);
        } catch {
          continue;
        }
        console.log(`  ${f.fromTable.padEnd(44)} ${col.padEnd(26)} ${n}/${idsNc.length} com linhas`);
        if (n === 0) continue;

        // Esta tabela tem linhas destas NC: mostra-as com artigo,
        // quantidade e valor. É a resposta operacional à pergunta.
        const cols = await listColumns(pool, separar(f.fromTable));
        const nomes = new Set(cols.map((c) => c.name));
        const temCodigo = nomes.has("CodigoID");
        const qtdCol = cols.find((c) => /^quantidade$/i.test(c.name))?.name ?? null;
        const valCol = cols.find((c) => /^valor_eur$/i.test(c.name) || /^valor$/i.test(c.name))?.name ?? null;
        for (const id of idsNc.slice(0, 3)) {
          const r = await pool
            .request()
            .input("v", sql.Int, id)
            .query<Record<string, unknown>>(
              `SELECT TOP 20
                      ${temCodigo ? "d.[CodigoID]" : "NULL"} AS codigoId,
                      ${temCodigo ? "s.[Codigo]" : "NULL"} AS cnp,
                      ${temCodigo ? "s.[Nome Comercial]" : "NULL"} AS nome,
                      ${qtdCol ? `d.${quoteIdent(qtdCol)}` : "NULL"} AS qtd,
                      ${valCol ? `d.${quoteIdent(valCol)}` : "NULL"} AS valor
                 FROM ${full(f.fromTable)} d
                 ${temCodigo ? `LEFT JOIN ${full(T_STOCKS)} s ON s.[CodigoID] = d.[CodigoID]` : ""}
                WHERE d.${quoteIdent(col)} = @v`,
            );
          console.log("");
          console.log(`    ${col}=${id} — ${r.recordset.length} linha(s):`);
          for (const l of r.recordset) {
            console.log(
              `      CNP=${formatCell(l.cnp, 10).padEnd(11)} qtd=${String(l.qtd).padStart(6)} ` +
                `valor=${String(l.valor).padStart(10)}  ${formatCell(l.nome, 38)}`,
            );
          }
          if (r.recordset.length > 0) {
            console.log("");
            console.log("      SINAL: reparar se a quantidade vem positiva ou negativa.");
            console.log("      Se vier POSITIVA, o sinal e do tipo documental e o");
            console.log("      reader tem de o aplicar — somar em cru aumenta as vendas.");
          }
        }
      }
    });

    // ── 6. Já está na fonte G? ───────────────────────────────────
    await seccao("6. DUPLA CONTAGEM — o reader do circuito G ja le estas NC?", async () => {
      if (separar(tabelaNc).table.toLowerCase() !== "atendimento") {
        console.log(`A NC vive em [${tabelaNc}], nao em [Atendimento].`);
        console.log("O reader do circuito G nao lhe toca — sem risco de dupla contagem.");
        return;
      }
      console.log("A NC vive em [Atendimento] — a MESMA tabela que o reader do");
      console.log("circuito G ja le. Isto e o aviso mais importante desta sonda.");
      console.log("");
      const r = await pool.request().query<{
        id: number;
        fimVenda: string | null;
        tipoDoc: number | null;
        linhasG: number;
      }>(
        `SELECT a.[Atendimento ID] AS id, a.[Fim Venda] AS fimVenda,
                a.[Tipo Documento] AS tipoDoc,
                (SELECT COUNT(*) FROM ${full("Atendimento Detalhe")} d
                  WHERE d.[Atendimento ID] = a.[Atendimento ID]) AS linhasG
           FROM ${full("Atendimento")} a
          WHERE a.[Atendimento ID] IN (${idsNc.map((n) => String(n)).join(",")})`,
      );
      console.log(`  ${"AtendimentoID".padEnd(15)}${"fimVenda".padEnd(10)}${"tipoDoc".padEnd(9)}linhas em [Atendimento Detalhe]`);
      for (const d of r.recordset) {
        console.log(
          `  ${String(d.id).padEnd(15)}${formatCell(d.fimVenda, 9).padEnd(10)}` +
            `${String(d.tipoDoc ?? "-").padEnd(9)}${d.linhasG}`,
        );
      }
      console.log("");
      console.log("  LEITURA:");
      console.log("   . linhas em [Atendimento Detalhe] > 0  ->  a NC TEM linhas no");
      console.log("     circuito G, e o reader G ja as apanha se passar no filtro.");
      console.log("     Nesse caso o reader VSG NAO deve voltar a le-las: seria");
      console.log("     subtrair a mesma nota de credito duas vezes.");
      console.log("   . linhas = 0  ->  a NC existe como cabecalho mas as suas");
      console.log("     linhas estao noutro lado (ver §5). O reader VSG tem de as ler.");
    });

    // ── 7. A matriz ──────────────────────────────────────────────
    await seccao("7. MATRIZ — FT (VSG) -> NC, uma linha por relacao", async () => {
      const colsNc = await listColumns(pool, separar(tabelaNc));
      const doc = camposDocumentais(colsNc);
      const r = await pool.request().query<Record<string, unknown>>(
        `SELECT TOP ${args.limite}
                x.${quoteIdent(colRelFt)}                    AS ftId,
                f.[SerieFacturacao]                          AS ftSerie,
                f.[Numero Documento]                         AS ftNumero,
                f.[Tipo Documento ID]                        AS ftTipoDoc,
                f.[Data Venda]                               AS ftData,
                f.[Total Bruto_EUR]                          AS ftTotal,
                x.${quoteIdent(colRelNc)}                    AS ncId,
                ${doc.serie ? `n.${quoteIdent(doc.serie)}` : "NULL"}                   AS ncSerie,
                ${doc.numero ? `n.${quoteIdent(doc.numero)}` : "NULL"}                 AS ncNumero,
                ${doc.tipoDocumento ? `n.${quoteIdent(doc.tipoDocumento)}` : "NULL"}   AS ncTipoDoc,
                ${doc.data ? `n.${quoteIdent(doc.data)}` : "NULL"}                     AS ncData
           FROM ${full(T_REL)} x
           LEFT JOIN ${full(T_SUSP)} f ON f.[Atendimento Susp ID] = x.${quoteIdent(colRelFt)}
           LEFT JOIN ${full(tabelaNc)} n ON n.${quoteIdent(pkNc)} = x.${quoteIdent(colRelNc)}
          ORDER BY x.${quoteIdent(colRelNc)} DESC`,
      );
      console.log(
        `  ${"FT doc".padEnd(16)}${"tipo".padEnd(7)}${"total".padEnd(11)}${"data FT".padEnd(21)}` +
          `${"NC doc".padEnd(16)}${"tipo".padEnd(7)}data NC`,
      );
      for (const d of r.recordset) {
        const ftDoc = `${formatCell(d.ftSerie, 6)}/${d.ftNumero ?? "-"}`;
        const ncDoc = `${formatCell(d.ncSerie, 6)}/${d.ncNumero ?? "-"}`;
        console.log(
          `  ${ftDoc.padEnd(16)}${String(d.ftTipoDoc ?? "-").padEnd(7)}` +
            `${String(d.ftTotal ?? "-").padEnd(11)}${formatCell(d.ftData, 19).padEnd(21)}` +
            `${ncDoc.padEnd(16)}${String(d.ncTipoDoc ?? "-").padEnd(7)}${formatCell(d.ncData, 19)}`,
        );
      }
    });

    // ── 8. Cobertura ─────────────────────────────────────────────
    await seccao("8. COBERTURA — quantas das relacoes resolvem", async () => {
      const r = await pool.request().query<{ total: number; comNc: number; comFt: number }>(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN n.${quoteIdent(pkNc)} IS NULL THEN 0 ELSE 1 END) AS comNc,
                SUM(CASE WHEN f.[Atendimento Susp ID] IS NULL THEN 0 ELSE 1 END) AS comFt
           FROM ${full(T_REL)} x
           LEFT JOIN ${full(T_SUSP)} f ON f.[Atendimento Susp ID] = x.${quoteIdent(colRelFt)}
           LEFT JOIN ${full(tabelaNc)} n ON n.${quoteIdent(pkNc)} = x.${quoteIdent(colRelNc)}`,
      );
      const d = r.recordset[0];
      console.log(`  relacoes            : ${d?.total ?? 0}`);
      console.log(`  com FT em [${T_SUSP}] : ${d?.comFt ?? 0}`);
      console.log(`  com NC em [${tabelaNc}] : ${d?.comNc ?? 0}`);
      console.log("");
      console.log("  Se algum lado nao resolver a 100%, o reader tem de decidir o");
      console.log("  que fazer com o resto — e essa decisao precisa de ser vista");
      console.log("  aqui, nao descoberta em producao.");
    });

    console.log("");
    console.log(DOUBLE);
    console.log("FIM — nada foi escrito. Nenhum POST ao SaaS.");
    console.log(DOUBLE);
    return 0;
  });
}
