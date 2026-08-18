/**
 * agent/src/commands/vendas-suspensas-audit.ts
 *
 * A PROVA do circuito da venda suspensa. Read-only, sem persistência.
 *
 * ── PORQUE EXISTE ────────────────────────────────────────────────────
 *
 * O reader da venda suspensa (`agent/src/vendas-fontes.ts`) descobre as
 * colunas por padrão de nome e liga `[Atendimento Susp Detalhe]` ao
 * cabeçalho `Atendimento`. Isso é uma HIPÓTESE até alguém a confrontar
 * com o schema real: uma coluna chamada `Atendimento ID` pode existir e
 * significar outra coisa, e a lista de tipos de documento
 * (`TIPOS_DOC_VENDA` / `TIPOS_DOC_REVERSAO`) foi observada no circuito G
 * — nada garante que o circuito VSG use os mesmos.
 *
 * Este comando responde às três perguntas que faltam, com dados:
 *
 *   1. Que coluna liga a linha suspensa ao cabeçalho, e o cabeçalho
 *      existe mesmo? (contagem de linhas com e sem correspondência)
 *   2. Que `[Tipo Documento]` aparecem no circuito VSG, e quais deles
 *      estão declarados? Um tipo por declarar é uma linha que o
 *      normalizador vai RECUSAR — e é melhor sabê-lo antes do backfill.
 *   3. `Atendimento_FT_NC_Susp` existe? Que colunas tem, e liga-se a
 *      quê? É a candidata a fonte/relação das notas de crédito de VSG.
 *
 * Só SELECT sobre `sys.*` e as tabelas em causa. Nenhum POST ao SaaS,
 * nenhuma escrita em lado nenhum.
 *
 * Uso:
 *   agent -- vendas-suspensas-audit --from 2026-08-01 --to 2026-08-01
 */

import { parseArgs } from "node:util";
import sql from "mssql";
import { loadConfig } from "../config.js";
import { withPool, type SqlPool } from "../sql-client.js";
import { janela } from "../janela.js";
import {
  TIPOS_DOC_REVERSAO,
  TIPOS_DOC_VENDA,
  descobrirSchemaAtendimento,
  descobrirSchemaSusp,
  resumoSchema,
  sqlAtendimentoSuspDetalhe,
} from "../vendas-fontes.js";

const RULE = "─".repeat(70);
const DOUBLE_RULE = "═".repeat(70);

type Args = { from?: string; to?: string; help?: boolean };

function parseCmdArgs(): Args {
  const raw = parseArgs({
    args: process.argv.slice(3),
    options: {
      from: { type: "string" },
      to: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  return {
    from: typeof raw.values.from === "string" ? raw.values.from : undefined,
    to: typeof raw.values.to === "string" ? raw.values.to : undefined,
    help: raw.values.help === true,
  };
}

/** Colunas de uma tabela, ou null se não existir. */
async function colunas(
  pool: SqlPool,
  tabela: string,
): Promise<Array<{ nome: string; tipo: string; nulo: boolean }> | null> {
  const r = await pool
    .request()
    .input("t", tabela)
    .query<{ nome: string; tipo: string; nulo: boolean }>(
      `SELECT c.name AS nome, ty.name AS tipo, c.is_nullable AS nulo
         FROM sys.columns c
         JOIN sys.objects o  ON o.object_id = c.object_id
         JOIN sys.types   ty ON ty.user_type_id = c.user_type_id
        WHERE o.name = @t AND o.type = 'U'
        ORDER BY c.column_id`,
    );
  return r.recordset.length > 0 ? r.recordset : null;
}

/** Chaves estrangeiras que SAEM da tabela. É o que prova a ligação. */
async function fksDe(pool: SqlPool, tabela: string) {
  const r = await pool
    .request()
    .input("t", tabela)
    .query<{ coluna: string; refTabela: string; refColuna: string }>(
      `SELECT pc.name AS coluna, ro.name AS [refTabela], rc.name AS [refColuna]
         FROM sys.foreign_key_columns fkc
         JOIN sys.objects o  ON o.object_id  = fkc.parent_object_id
         JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id
                            AND pc.column_id = fkc.parent_column_id
         JOIN sys.objects ro ON ro.object_id = fkc.referenced_object_id
         JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id
                            AND rc.column_id = fkc.referenced_column_id
        WHERE o.name = @t`,
    );
  return r.recordset;
}

async function pk(pool: SqlPool, tabela: string): Promise<string[]> {
  const r = await pool
    .request()
    .input("t", tabela)
    .query<{ coluna: string }>(
      `SELECT c.name AS coluna
         FROM sys.indexes i
         JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
         JOIN sys.columns c ON c.object_id = i.object_id AND c.column_id = ic.column_id
         JOIN sys.objects o ON o.object_id = i.object_id
        WHERE o.name = @t AND i.is_primary_key = 1
        ORDER BY ic.key_ordinal`,
    );
  return r.recordset.map((x) => x.coluna);
}

function imprimirTabela(
  nome: string,
  cols: Array<{ nome: string; tipo: string; nulo: boolean }> | null,
  chave: string[],
  fks: Array<{ coluna: string; refTabela: string; refColuna: string }>,
): void {
  console.log(RULE);
  if (!cols) {
    console.log(`[dbo].[${nome}] — NAO EXISTE nesta instalacao`);
    return;
  }
  console.log(`[dbo].[${nome}] — ${cols.length} colunas`);
  console.log(`  PK: ${chave.length > 0 ? chave.join(", ") : "(sem PK declarada)"}`);
  if (fks.length > 0) {
    console.log("  FKs declaradas:");
    for (const f of fks) {
      console.log(`    ${f.coluna}  ->  [${f.refTabela}].[${f.refColuna}]`);
    }
  } else {
    console.log("  FKs declaradas: (nenhuma)");
  }
  console.log("  Colunas:");
  for (const c of cols) {
    console.log(`    ${c.nome}${c.nulo ? "" : "  NOT NULL"}  (${c.tipo})`);
  }
}

export async function vendasSuspensasAudit(): Promise<number> {
  let args: Args;
  try {
    args = parseCmdArgs();
  } catch (err) {
    console.error("✗", err instanceof Error ? err.message : err);
    return 1;
  }
  if (args.help || !args.from || !args.to) {
    console.log("Uso: vendas-suspensas-audit --from YYYY-MM-DD --to YYYY-MM-DD");
    console.log("");
    console.log("Read-only. Prova a ligacao da venda suspensa ao cabecalho,");
    console.log("lista os tipos de documento do circuito VSG e inspecciona");
    console.log("Atendimento_FT_NC_Susp. Nenhuma escrita, nenhum POST.");
    return args.help ? 0 : 1;
  }
  const j = janela(args.from, args.to);
  const cfg = loadConfig("sql");

  return withPool(cfg, async (pool) => {
    console.log(DOUBLE_RULE);
    console.log("vendas-suspensas-audit — READ-ONLY");
    console.log(DOUBLE_RULE);
    console.log(`ERP    : ${cfg.sqlDatabase}@${cfg.sqlHost}`);
    console.log(`Janela : ${j.inicio} .. ${j.fimExclusivo} (exclusivo)`);
    console.log("");

    // ── 1. Estrutura das tabelas em causa ────────────────────────
    console.log(DOUBLE_RULE);
    console.log("1. ESTRUTURA");
    console.log(DOUBLE_RULE);
    for (const t of [
      "Atendimento",
      "Atendimento Detalhe",
      "Atendimento Susp Detalhe",
      "Atendimento_FT_NC_Susp",
      "Vendas Dinheiro_Susp",
    ]) {
      const cols = await colunas(pool, t);
      imprimirTabela(t, cols, cols ? await pk(pool, t) : [], cols ? await fksDe(pool, t) : []);
    }

    // ── 2. O que a descoberta resolveu ───────────────────────────
    console.log("");
    console.log(DOUBLE_RULE);
    console.log("2. O QUE O READER RESOLVEU");
    console.log(DOUBLE_RULE);
    const [at, susp] = await Promise.all([
      descobrirSchemaAtendimento(pool),
      descobrirSchemaSusp(pool),
    ]);
    for (const linha of resumoSchema(susp, at)) console.log(linha);
    const fonte = sqlAtendimentoSuspDetalhe(susp, at);
    console.log(`  estado da fonte VSG: ${fonte.estado}`);
    if (fonte.estado === "POR_LIGAR") {
      console.log(`  FALTAM: ${fonte.faltam.join(", ")}`);
      console.log("");
      console.log("  A tabela existe e nao foi possivel liga-la. O pipeline de");
      console.log("  vendas vai PARAR ate isto ficar resolvido — de proposito:");
      console.log("  saltar uma fonte existente grava um historico incompleto.");
      return 1;
    }
    if (fonte.estado === "AUSENTE") {
      console.log("  A tabela nao existe nesta instalacao. Nada a fazer.");
      return 0;
    }
    console.log("");
    console.log("  SQL gerado:");
    for (const l of fonte.sql.split("\n")) console.log(`    ${l}`);

    // ── 3. A ligação ao cabeçalho, medida ────────────────────────
    console.log("");
    console.log(DOUBLE_RULE);
    console.log("3. A LIGACAO AO CABECALHO — medida, nao assumida");
    console.log(DOUBLE_RULE);
    const fk = susp.atendimentoFk!;
    const pkSusp = susp.pk!;
    const lig = await pool
      .request()
      .input("from", sql.NVarChar, j.inicio)
      .input("to", sql.NVarChar, j.fimExclusivo)
      .query<{
        total: number;
        comCabecalho: number;
        semCabecalho: number;
        fechadas: number;
      }>(`
        SELECT
          COUNT(*)                                                      AS total,
          SUM(CASE WHEN a.[Atendimento ID] IS NULL THEN 0 ELSE 1 END)   AS comCabecalho,
          SUM(CASE WHEN a.[Atendimento ID] IS NULL THEN 1 ELSE 0 END)   AS semCabecalho,
          SUM(CASE WHEN a.[Fim Venda] = 'S' THEN 1 ELSE 0 END)          AS fechadas
        FROM [dbo].[${susp.tabela}] d
        LEFT JOIN [dbo].[Atendimento] a ON a.[Atendimento ID] = d.[${fk}]
        WHERE d.[${pkSusp}] IS NOT NULL
      `);
    const L = lig.recordset[0];
    console.log(`  linhas em [${susp.tabela}] : ${L?.total ?? 0}`);
    console.log(`  COM cabecalho Atendimento  : ${L?.comCabecalho ?? 0}`);
    console.log(`  SEM cabecalho              : ${L?.semCabecalho ?? 0}   <- suspensas por fiscalizar`);
    console.log(`  com [Fim Venda]='S'        : ${L?.fechadas ?? 0}`);
    console.log("");
    console.log("  Leitura: uma linha SEM cabecalho e uma suspensa que ainda nao");
    console.log("  foi convertida em factura. O reader usa INNER JOIN, portanto");
    console.log("  essas ficam de fora — e e essa a distincao entre VSG");
    console.log("  fiscalizada e reserva por fiscalizar.");

    // ── 4. Tipos de documento do circuito VSG ────────────────────
    console.log("");
    console.log(DOUBLE_RULE);
    console.log("4. TIPOS DE DOCUMENTO NO CIRCUITO VSG");
    console.log(DOUBLE_RULE);
    const tipos = await pool
      .request()
      .input("from", sql.NVarChar, j.inicio)
      .input("to", sql.NVarChar, j.fimExclusivo)
      .query<{ tipoDocumento: number | null; serie: string | null; linhas: number; qtd: number }>(`
        SELECT
          a.[${at.tipoDocumento}] AS tipoDocumento,
          ${at.serie ? `a.[${at.serie}]` : "NULL"} AS serie,
          COUNT(*) AS linhas,
          SUM(CAST(ISNULL(d.[${susp.quantidade}], 0) AS FLOAT)) AS qtd
        FROM [dbo].[${susp.tabela}] d
        JOIN [dbo].[Atendimento] a ON a.[Atendimento ID] = d.[${fk}]
        WHERE a.[Data Venda] >= @from AND a.[Data Venda] < @to
        GROUP BY a.[${at.tipoDocumento}]${at.serie ? `, a.[${at.serie}]` : ""}
        ORDER BY 1
      `);
    if (tipos.recordset.length === 0) {
      console.log("  (sem linhas na janela pedida)");
    }
    let porDeclarar = 0;
    for (const t of tipos.recordset) {
      const td = t.tipoDocumento;
      const estado =
        td === null
          ? "SEM TIPO — sera RECUSADA"
          : TIPOS_DOC_VENDA.has(td)
            ? "declarado VENDA"
            : TIPOS_DOC_REVERSAO.has(td)
              ? "declarado DEVOLUCAO_ANULACAO"
              : "POR DECLARAR — sera RECUSADA";
      if (td === null || (!TIPOS_DOC_VENDA.has(td) && !TIPOS_DOC_REVERSAO.has(td))) porDeclarar++;
      console.log(
        `  tipoDoc=${String(td ?? "(nulo)").padEnd(6)} serie=${(t.serie ?? "-").padEnd(6)} ` +
          `linhas=${String(t.linhas).padStart(6)} qtd=${String(t.qtd).padStart(8)}  ${estado}`,
      );
    }
    if (porDeclarar > 0) {
      console.log("");
      console.log(`  ATENCAO: ${porDeclarar} tipo(s) por declarar.`);
      console.log("  Acrescenta-os a TIPOS_DOC_VENDA ou TIPOS_DOC_REVERSAO em");
      console.log("  agent/src/vendas-fontes.ts ANTES do backfill. Enquanto");
      console.log("  nao estiverem declarados, essas linhas sao recusadas e");
      console.log("  contadas no log — nao entram como venda por acidente.");
    }

    // ── 5. Atendimento_FT_NC_Susp ────────────────────────────────
    console.log("");
    console.log(DOUBLE_RULE);
    console.log("5. Atendimento_FT_NC_Susp — e necessaria como fonte/relacao?");
    console.log(DOUBLE_RULE);
    const ftnc = await colunas(pool, "Atendimento_FT_NC_Susp");
    if (!ftnc) {
      console.log("  NAO EXISTE nesta instalacao — nada a ligar.");
    } else {
      const fksFt = await fksDe(pool, "Atendimento_FT_NC_Susp");
      console.log(`  ${ftnc.length} colunas, ${fksFt.length} FK(s) declaradas.`);
      for (const f of fksFt) {
        console.log(`    ${f.coluna}  ->  [${f.refTabela}].[${f.refColuna}]`);
      }
      const n = await pool.request().query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM [dbo].[Atendimento_FT_NC_Susp]`,
      );
      console.log(`  linhas: ${n.recordset[0]?.n ?? 0}`);
      console.log("");
      console.log("  DECISAO:");
      console.log("   . se as FKs apontarem para [Atendimento] e as NC ja");
      console.log("     aparecerem no ponto 4 com um tipoDoc de reversao,");
      console.log("     esta tabela e uma VISTA do circuito e NAO e precisa");
      console.log("     como fonte — basta declarar o tipoDoc.");
      console.log("   . se o ponto 4 NAO mostrar nenhum tipoDoc de reversao e");
      console.log("     esta tabela tiver linhas, entao as NC de VSG vivem AQUI");
      console.log("     e falta um reader. Nesse caso NAO fazer backfill ainda.");
    }

    console.log("");
    console.log(DOUBLE_RULE);
    console.log("FIM — nada foi escrito.");
    console.log(DOUBLE_RULE);
    return 0;
  });
}
