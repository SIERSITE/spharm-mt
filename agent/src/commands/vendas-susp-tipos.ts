/**
 * agent/src/commands/vendas-susp-tipos.ts
 *
 * Que tipos documentais existem no circuito suspenso, e quais deles são
 * reversões. Read-only, sem persistência, sem POST.
 *
 * ── PORQUE EXISTE ────────────────────────────────────────────────────
 *
 * A regra actual do circuito suspenso é `venda {107}, reversao {}`. O
 * conjunto vazio foi uma DECISÃO tomada com prova: as 107 relações de
 * `Atendimento_SuspFT_NC_Susp` resolviam 107/107 para `[Atendimento]`,
 * portanto as notas de crédito das VSG entravam pelo circuito G e um
 * segundo reader subtraí-las-ia duas vezes.
 *
 * Essa prova é de UMA farmácia e de UM período. Se noutra instalação —
 * ou noutro período da mesma — a anulação for feita dentro do próprio
 * circuito suspenso, a regra actual recusa essas linhas e o histórico
 * fica com as vendas e sem as anulações. O total sobe e continua
 * plausível, que é a forma de erro mais cara deste projecto.
 *
 * ── O QUE ESTE COMANDO NÃO FAZ ───────────────────────────────────────
 *
 * Não classifica. Não decide. Não usa `Fim Venda` como critério — o
 * campo aparece nos cortes como DADO, para se ver o que vale, e nunca
 * num `WHERE`: já foi refutado uma vez como classificador e a lição
 * custou uma ronda inteira.
 *
 * Também não assume que "tipo diferente de 107" significa reversão. O
 * que separa venda de anulação é o SINAL, e é o sinal que se conta.
 *
 * ── OS DOIS ERP ──────────────────────────────────────────────────────
 *
 * `--db` aponta o comando a outra base do MESMO servidor, para auditar
 * as duas farmácias sem reconfigurar o agent:
 *
 *   agent -- vendas-susp-tipos --db SPharm_Silveirense
 *   agent -- vendas-susp-tipos --db SPharm_Segurado
 *
 * Uso:
 *   agent -- vendas-susp-tipos [--from 2024-01-01] [--to 2026-07-31] [--db <base>]
 */

import { parseArgs } from "node:util";
import sql from "mssql";
import { loadConfig } from "../config.js";
import { withPool, type SqlPool } from "../sql-client.js";
import { janela } from "../janela.js";
import {
  descobrirCabecalhoSusp,
  descobrirSchemaSusp,
  CLASSIFICACAO,
  NAMESPACES,
  type SchemaCabecalhoSusp,
  type SchemaFonteSusp,
} from "../vendas-fontes.js";
import { formatCell, quoteIdent, tableExists } from "./probe-helpers.js";

const RULE = "─".repeat(74);
const DOUBLE = "═".repeat(74);

const T_FT_NC = "Atendimento_SuspFT_NC_Susp";
const T_ATEND = "Atendimento";
const T_ATEND_DET = "Atendimento Detalhe";

type Args = { from: string; to: string; db?: string; help: boolean };

function parseCmdArgs(): Args {
  const raw = parseArgs({
    args: process.argv.slice(3),
    options: {
      from: { type: "string" },
      to: { type: "string" },
      db: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  return {
    from: typeof raw.values.from === "string" ? raw.values.from : "2024-01-01",
    to: typeof raw.values.to === "string" ? raw.values.to : "2026-07-31",
    db: typeof raw.values.db === "string" ? raw.values.db : undefined,
    help: raw.values.help === true,
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
    // Uma secção que falha não leva as outras atrás: um inventário
    // parcial vale mais do que um stack trace.
    console.log(`✗ SECCAO FALHOU: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** As peças do circuito suspenso, já resolvidas. */
type Circuito = {
  susp: SchemaFonteSusp;
  cab: SchemaCabecalhoSusp;
  /** `[dbo].[Atendimento Susp Detalhe] d JOIN [dbo].[Atendimento Susp] h ON …` */
  fonte: string;
  /** Expressões qualificadas, prontas a interpolar. */
  tipo: string;
  serie: string;
  numero: string;
  data: string;
  fimVenda: string;
  qtd: string;
  codigo: string;
  pkDet: string;
  pkCab: string;
};

/**
 * A coluna de estado do cabeçalho, se existir.
 *
 * Descoberta em vez de assumida: o `[Fim Venda]` existe na Silveirense e
 * não há garantia de que exista na Segurado com o mesmo nome. Entra no
 * relatório como coluna informativa; se faltar, sai `NULL` e o resto do
 * inventário corre na mesma.
 */
async function colunaFimVenda(pool: SqlPool, tabela: string): Promise<string | null> {
  const r = await pool
    .request()
    .input("t", tabela)
    .query<{ nome: string }>(
      `SELECT c.name AS nome
         FROM sys.columns c
         JOIN sys.objects o ON o.object_id = c.object_id
        WHERE o.name = @t AND o.type = 'U' AND c.name LIKE '%Fim%Venda%'`,
    );
  return r.recordset[0]?.nome ?? null;
}

function montar(susp: SchemaFonteSusp, cab: SchemaCabecalhoSusp, fimVenda: string | null): Circuito {
  const q = (c: string | null) => (c ? quoteIdent(c) : null);
  const falta: string[] = [];
  const exigir = (nome: string, v: string | null) => {
    if (!v) falta.push(nome);
    return v;
  };
  const pkDet = exigir("pk do detalhe", q(susp.pk));
  const fk = exigir("FK declarada para o cabecalho", q(susp.cabecalhoFk));
  const pkCab = exigir("pk do cabecalho", q(cab.pk));
  const tipo = exigir("Tipo Documento ID", q(cab.tipoDocumento));
  const data = exigir("Data Venda", q(cab.dataVenda));
  const qtd = exigir("Quantidade", q(susp.quantidade));
  const codigo = exigir("CodigoID", q(susp.codigoId));
  if (falta.length > 0) {
    throw new Error(
      `nao foi possivel montar o circuito suspenso — falta: ${falta.join(", ")}`,
    );
  }
  return {
    susp,
    cab,
    fonte:
      `[dbo].${quoteIdent(susp.tabela)} d\n` +
      `  JOIN [dbo].${quoteIdent(cab.tabela)} h ON h.${pkCab} = d.${fk}`,
    tipo: `h.${tipo}`,
    serie: cab.serie ? `h.${q(cab.serie)}` : "NULL",
    numero: cab.numero ? `h.${q(cab.numero)}` : "NULL",
    data: `h.${data}`,
    // `Fim Venda` entra como DADO, nunca como filtro.
    fimVenda: fimVenda ? `h.${quoteIdent(fimVenda)}` : "NULL",
    qtd: `d.${qtd}`,
    codigo: `d.${codigo}`,
    pkDet: `d.${pkDet}`,
    pkCab: `h.${pkCab}`,
  };
}

export async function vendasSuspTipos(): Promise<number> {
  let args: Args;
  try {
    args = parseCmdArgs();
  } catch (err) {
    console.error("✗", err instanceof Error ? err.message : err);
    return 1;
  }
  if (args.help) {
    console.log("Uso: vendas-susp-tipos [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--db <base>]");
    console.log("");
    console.log("Read-only. Inventaria os tipos documentais do circuito suspenso,");
    console.log("procura reversoes pelo SINAL e cruza-as com o circuito G.");
    console.log("Nao classifica e nao usa [Fim Venda] como criterio.");
    return 0;
  }

  const j = janela(args.from, args.to);
  const base = loadConfig("sql");
  const cfg = args.db ? { ...base, sqlDatabase: args.db } : base;

  return withPool(cfg, async (pool) => {
    console.log(DOUBLE);
    console.log("vendas-susp-tipos — READ-ONLY");
    console.log(DOUBLE);
    console.log(`ERP    : ${cfg.sqlDatabase}@${cfg.sqlHost}`);
    console.log(`Janela : ${j.inicio} .. ${j.fimExclusivo} (exclusivo)`);
    console.log("");
    console.log("[Fim Venda] aparece nos cortes como DADO. Nao entra em WHERE");
    console.log("nenhum: ja foi refutado como classificador.");
    console.log("Nao se assume que tipo != 107 e reversao — conta-se o SINAL.");

    const [susp, cab] = await Promise.all([
      descobrirSchemaSusp(pool),
      descobrirCabecalhoSusp(pool),
    ]);
    if (!susp.existe || !cab.existe) {
      console.log("");
      console.log("✗ Esta instalacao nao tem o circuito suspenso:");
      console.log(`   [${susp.tabela}] existe: ${susp.existe}`);
      console.log(`   [${cab.tabela}] existe: ${cab.existe}`);
      return 1;
    }
    const colFimVenda = await colunaFimVenda(pool, cab.tabela);
    let C: Circuito;
    try {
      C = montar(susp, cab, colFimVenda);
    } catch (err) {
      console.log(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    console.log("");
    console.log(
      `Circuito: ${susp.tabela}.${susp.cabecalhoFk} -> ${cab.tabela}.${cab.pk} (FK declarada)`,
    );
    console.log(
      `Colunas : tipo=${cab.tipoDocumento} serie=${cab.serie ?? "-"} ` +
        `numero=${cab.numero ?? "-"} data=${cab.dataVenda ?? "-"} qtd=${susp.quantidade}`,
    );

    const janelaSql = `${C.data} >= @from AND ${C.data} < @to`;
    const req = () =>
      pool.request().input("from", sql.NVarChar, j.inicio).input("to", sql.NVarChar, j.fimExclusivo);

    // ── 1. Inventário ────────────────────────────────────────────
    await seccao("1. INVENTARIO — tipo x serie x [Fim Venda] x sinal", async () => {
      const r = await req().query<{
        tipoDoc: number | null;
        serie: string | null;
        fimVenda: string | null;
        sinal: string;
        linhas: number;
        docs: number;
        soma: number;
        primeiro: Date | null;
        ultimo: Date | null;
      }>(`
        SELECT ${C.tipo} AS tipoDoc,
               ${C.serie} AS serie,
               ${C.fimVenda} AS fimVenda,
               CASE WHEN ${C.qtd} < 0 THEN 'NEGATIVA'
                    WHEN ${C.qtd} > 0 THEN 'POSITIVA'
                    ELSE 'ZERO' END AS sinal,
               COUNT(*) AS linhas,
               COUNT(DISTINCT ${C.pkCab}) AS docs,
               SUM(CAST(${C.qtd} AS FLOAT)) AS soma,
               MIN(${C.data}) AS primeiro,
               MAX(${C.data}) AS ultimo
          FROM ${C.fonte}
         WHERE ${janelaSql}
         GROUP BY ${C.tipo}, ${C.serie}, ${C.fimVenda},
                  CASE WHEN ${C.qtd} < 0 THEN 'NEGATIVA'
                       WHEN ${C.qtd} > 0 THEN 'POSITIVA'
                       ELSE 'ZERO' END
         ORDER BY ${C.tipo}, 4
      `);
      if (r.recordset.length === 0) {
        console.log("  (nenhuma linha suspensa nesta janela)");
        return;
      }
      console.log(
        `  ${"tipoDoc".padEnd(9)}${"serie".padEnd(9)}${"fimVenda".padEnd(10)}${"sinal".padEnd(10)}` +
          `${"linhas".padStart(8)}${"docs".padStart(7)}${"soma qtd".padStart(11)}   periodo`,
      );
      const declarados = CLASSIFICACAO[NAMESPACES.ATENDIMENTO_SUSP_DETALHE];
      for (const d of r.recordset) {
        const td = d.tipoDoc;
        const estado =
          td === null
            ? ""
            : declarados.venda.has(td)
              ? ""
              : declarados.reversao.has(td)
                ? ""
                : "   <- POR DECLARAR";
        console.log(
          `  ${String(d.tipoDoc ?? "-").padEnd(9)}${formatCell(d.serie, 8).padEnd(9)}` +
            `${formatCell(d.fimVenda, 9).padEnd(10)}${d.sinal.padEnd(10)}` +
            `${String(d.linhas).padStart(8)}${String(d.docs).padStart(7)}` +
            `${String(d.soma).padStart(11)}   ` +
            `${formatCell(d.primeiro, 10)} .. ${formatCell(d.ultimo, 10)}${estado}`,
        );
      }
      console.log("");
      console.log("  Leitura: um tipo com linhas NEGATIVAS e candidato a reversao.");
      console.log("  Um tipo por declarar e recusado pelo reader — as suas linhas");
      console.log("  nao entram no historico, nem como venda nem como anulacao.");
    });

    // ── 2. Caça às reversões, pelo sinal ─────────────────────────
    await seccao("2. REVERSOES — procuradas pelo SINAL, nao pelo nome", async () => {
      const neg = await req().query<{ n: number; docs: number }>(`
        SELECT COUNT(*) AS n, COUNT(DISTINCT ${C.pkCab}) AS docs
          FROM ${C.fonte} WHERE ${janelaSql} AND ${C.qtd} < 0
      `);
      console.log(
        `  linhas com quantidade negativa : ${neg.recordset[0]?.n ?? 0} ` +
          `em ${neg.recordset[0]?.docs ?? 0} documento(s)`,
      );

      if (cab.numero) {
        const numNeg = await req().query<{ n: number }>(`
          SELECT COUNT(*) AS n FROM ${C.fonte}
           WHERE ${janelaSql} AND ${C.numero} < 0
        `);
        console.log(`  [${cab.numero}] negativo          : ${numNeg.recordset[0]?.n ?? 0}`);
      }

      // Pares +/- com a mesma série e o mesmo número absoluto. Se
      // existirem, a anulação vive DENTRO do circuito suspenso.
      if (cab.numero && cab.serie) {
        const pares = await req().query<{
          serie: string | null;
          num: number;
          tipos: string;
          docs: number;
          soma: number;
        }>(`
          SELECT ${C.serie} AS serie, ABS(${C.numero}) AS num,
                 COUNT(DISTINCT ${C.tipo}) AS tipos,
                 COUNT(DISTINCT ${C.pkCab}) AS docs,
                 SUM(CAST(${C.qtd} AS FLOAT)) AS soma
            FROM ${C.fonte}
           WHERE ${janelaSql}
           GROUP BY ${C.serie}, ABS(${C.numero})
          HAVING COUNT(DISTINCT ${C.pkCab}) > 1
           ORDER BY 2 DESC
        `);
        console.log("");
        console.log(
          `  mesma serie + mesmo |numero| em mais de um documento: ${pares.recordset.length}`,
        );
        for (const p of pares.recordset.slice(0, 15)) {
          console.log(
            `    ${formatCell(p.serie, 8).padEnd(9)}${String(p.num).padStart(9)}  ` +
              `docs=${p.docs} tipos=${p.tipos} soma=${p.soma}`,
          );
        }
      }

      // Simetria por produto: mesmo CodigoID, quantidades opostas, no
      // mesmo instante. É a assinatura de uma anulação imediata.
      const simetria = await req().query<{
        data: Date | null;
        codigo: number;
        pos: number;
        neg: number;
      }>(`
        SELECT ${C.data} AS data, ${C.codigo} AS codigo,
               SUM(CASE WHEN ${C.qtd} > 0 THEN CAST(${C.qtd} AS FLOAT) ELSE 0 END) AS pos,
               SUM(CASE WHEN ${C.qtd} < 0 THEN CAST(${C.qtd} AS FLOAT) ELSE 0 END) AS neg
          FROM ${C.fonte}
         WHERE ${janelaSql}
         GROUP BY ${C.data}, ${C.codigo}
        HAVING SUM(CASE WHEN ${C.qtd} < 0 THEN 1 ELSE 0 END) > 0
         ORDER BY 1 DESC
      `);
      console.log("");
      console.log(`  mesmo produto+instante com linha negativa: ${simetria.recordset.length}`);
      for (const s of simetria.recordset.slice(0, 15)) {
        const anula = s.pos + s.neg === 0 ? "  (anula exactamente)" : "";
        console.log(
          `    ${formatCell(s.data, 19).padEnd(21)}CodigoID=${String(s.codigo).padEnd(9)}` +
            `+${s.pos} ${s.neg}${anula}`,
        );
      }
      if (
        (neg.recordset[0]?.n ?? 0) === 0 &&
        simetria.recordset.length === 0
      ) {
        console.log("");
        console.log("  NENHUMA reversao dentro do circuito suspenso nesta janela.");
        console.log("  Se houver anulacoes de VSG, entram por outro circuito — §4.");
      }
    });

    // ── 3. Exemplos reais, por tipo ──────────────────────────────
    await seccao("3. EXEMPLOS REAIS por tipo documental", async () => {
      const tipos = await req().query<{ tipoDoc: number | null }>(`
        SELECT DISTINCT ${C.tipo} AS tipoDoc FROM ${C.fonte} WHERE ${janelaSql}
      `);
      for (const t of tipos.recordset) {
        console.log("");
        console.log(RULE);
        console.log(`### tipoDoc = ${t.tipoDoc ?? "(nulo)"}`);
        const cond = t.tipoDoc === null ? `${C.tipo} IS NULL` : `${C.tipo} = ${t.tipoDoc}`;
        // Amostra deliberadamente enviesada para o negativo: se houver
        // reversões, é isso que interessa ver, não mais uma venda.
        const ex = await req().query<Record<string, unknown>>(`
          SELECT TOP 8 ${C.data} AS data, ${C.serie} AS serie, ${C.numero} AS numero,
                 ${C.tipo} AS tipo, ${C.fimVenda} AS fimVenda,
                 ${C.codigo} AS codigoId, ${C.qtd} AS quantidade, ${C.pkDet} AS linhaId
            FROM ${C.fonte}
           WHERE ${janelaSql} AND ${cond}
           ORDER BY CASE WHEN ${C.qtd} < 0 THEN 0 ELSE 1 END, ${C.data} DESC
        `);
        console.log(
          `  ${"data".padEnd(21)}${"serie".padEnd(8)}${"numero".padStart(9)}` +
            `${"tipo".padStart(6)}${"fimVenda".padStart(10)}${"CodigoID".padStart(10)}${"qtd".padStart(8)}`,
        );
        for (const e of ex.recordset) {
          console.log(
            `  ${formatCell(e.data, 19).padEnd(21)}${formatCell(e.serie, 7).padEnd(8)}` +
              `${String(e.numero ?? "-").padStart(9)}${String(e.tipo ?? "-").padStart(6)}` +
              `${formatCell(e.fimVenda, 9).padStart(10)}${String(e.codigoId).padStart(10)}` +
              `${String(e.quantidade).padStart(8)}`,
          );
        }
      }
    });

    // ── 4. Cruzamento com o circuito G ───────────────────────────
    await seccao("4. CRUZAMENTO com o circuito G — a mesma operacao nos dois?", async () => {
      const temRel = await tableExists(pool, { schema: "dbo", table: T_FT_NC });
      if (!temRel) {
        console.log(`  [${T_FT_NC}] nao existe nesta instalacao.`);
      } else {
        const r = await pool.request().query<{
          n: number;
          ft: number;
          nc: number;
          ftNulo: number;
          ncNulo: number;
        }>(`
          SELECT COUNT(*) AS n,
                 COUNT(DISTINCT [Atendimento Susp ID_FT]) AS ft,
                 COUNT(DISTINCT [Atendimento ID_NC]) AS nc,
                 SUM(CASE WHEN [Atendimento Susp ID_FT] IS NULL THEN 1 ELSE 0 END) AS ftNulo,
                 SUM(CASE WHEN [Atendimento ID_NC] IS NULL THEN 1 ELSE 0 END) AS ncNulo
            FROM [dbo].${quoteIdent(T_FT_NC)}
        `);
        const d = r.recordset[0];
        console.log(`  [${T_FT_NC}]: ${d?.n ?? 0} relacoes`);
        console.log(`    lado FT (suspenso) : ${d?.ft ?? 0} distintos, ${d?.ftNulo ?? 0} nulos`);
        console.log(`    lado NC ([Atendimento]) : ${d?.nc ?? 0} distintos, ${d?.ncNulo ?? 0} nulos`);

        // Os tipos documentais de cada lado. É isto que diz se a
        // anulação de uma VSG vive no circuito G.
        const ladoNc = await pool.request().query<{
          serie: string | null;
          tipo: number | null;
          n: number;
        }>(`
          SELECT a.[Serie] AS serie, a.[Tipo Documento] AS tipo, COUNT(*) AS n
            FROM [dbo].${quoteIdent(T_FT_NC)} x
            JOIN [dbo].${quoteIdent(T_ATEND)} a ON a.[Atendimento ID] = x.[Atendimento ID_NC]
           GROUP BY a.[Serie], a.[Tipo Documento]
           ORDER BY COUNT(*) DESC
        `);
        console.log("");
        console.log("    lado NC resolvido contra [Atendimento] — serie x tipo:");
        if (ladoNc.recordset.length === 0) {
          console.log("      (nenhuma relacao resolve — as NC nao vivem no circuito G)");
        }
        for (const x of ladoNc.recordset) {
          console.log(
            `      serie=${formatCell(x.serie, 8).padEnd(9)} tipo=${String(x.tipo ?? "-").padEnd(6)} n=${x.n}`,
          );
        }
        const temLinhas = await pool.request().query<{ comLinhas: number; semLinhas: number }>(`
          SELECT
            SUM(CASE WHEN e.n > 0 THEN 1 ELSE 0 END) AS comLinhas,
            SUM(CASE WHEN e.n = 0 THEN 1 ELSE 0 END) AS semLinhas
          FROM (
            SELECT x.[Atendimento ID_NC] AS id,
                   (SELECT COUNT(*) FROM [dbo].${quoteIdent(T_ATEND_DET)} dd
                     WHERE dd.[Atendimento ID] = x.[Atendimento ID_NC]) AS n
              FROM [dbo].${quoteIdent(T_FT_NC)} x
             WHERE x.[Atendimento ID_NC] IS NOT NULL
          ) e
        `);
        const e = temLinhas.recordset[0];
        console.log("");
        console.log(`    NC com linhas em [${T_ATEND_DET}] : ${e?.comLinhas ?? 0}`);
        console.log(`    NC sem linhas la               : ${e?.semLinhas ?? 0}`);
        console.log("");
        console.log("    DECISAO:");
        console.log("     . NC COM linhas no circuito G  -> o reader G ja as le.");
        console.log("       Declarar uma reversao no circuito suspenso subtraia a");
        console.log("       MESMA nota de credito duas vezes.");
        console.log("     . NC SEM linhas no circuito G  -> a anulacao so existe no");
        console.log("       circuito suspenso e o reader suspenso TEM de a ler.");
      }

      // Independentemente da tabela de relações: as linhas negativas do
      // circuito suspenso têm equivalente no G, no mesmo dia e produto?
      const cruz = await req().query<{ codigo: number; dia: string; qtdSusp: number; nG: number }>(`
        SELECT s.codigo, s.dia, s.qtdSusp,
               (SELECT COUNT(*)
                  FROM [dbo].${quoteIdent(T_ATEND_DET)} gd
                  JOIN [dbo].${quoteIdent(T_ATEND)} ga ON ga.[Atendimento ID] = gd.[Atendimento ID]
                 WHERE gd.[CodigoID] = s.codigo
                   AND CAST(ga.[Data Venda] AS DATE) = s.dia
                   AND gd.[Quantidade] < 0) AS nG
          FROM (
            SELECT ${C.codigo} AS codigo, CAST(${C.data} AS DATE) AS dia,
                   SUM(CAST(${C.qtd} AS FLOAT)) AS qtdSusp
              FROM ${C.fonte}
             WHERE ${janelaSql} AND ${C.qtd} < 0
             GROUP BY ${C.codigo}, CAST(${C.data} AS DATE)
          ) s
      `);
      console.log("");
      console.log(
        `  linhas suspensas NEGATIVAS com NC do circuito G no mesmo dia/produto:`,
      );
      if (cruz.recordset.length === 0) {
        console.log("    (nao ha linhas suspensas negativas nesta janela)");
      }
      for (const x of cruz.recordset.slice(0, 20)) {
        console.log(
          `    CodigoID=${String(x.codigo).padEnd(9)} ${x.dia} susp=${x.qtdSusp} ` +
            `${x.nG > 0 ? `TAMBEM no G (${x.nG} linha(s)) <- risco de dupla contagem` : "so no circuito suspenso"}`,
        );
      }
    });

    // ── 5. A matriz para a regra ─────────────────────────────────
    await seccao("5. MATRIZ tipo x sinal — a base da regra", async () => {
      const r = await req().query<{
        tipoDoc: number | null;
        pos: number;
        neg: number;
        somaPos: number;
        somaNeg: number;
      }>(`
        SELECT ${C.tipo} AS tipoDoc,
               SUM(CASE WHEN ${C.qtd} > 0 THEN 1 ELSE 0 END) AS pos,
               SUM(CASE WHEN ${C.qtd} < 0 THEN 1 ELSE 0 END) AS neg,
               SUM(CASE WHEN ${C.qtd} > 0 THEN CAST(${C.qtd} AS FLOAT) ELSE 0 END) AS somaPos,
               SUM(CASE WHEN ${C.qtd} < 0 THEN CAST(${C.qtd} AS FLOAT) ELSE 0 END) AS somaNeg
          FROM ${C.fonte}
         WHERE ${janelaSql}
         GROUP BY ${C.tipo}
         ORDER BY 1
      `);
      console.log(
        `  ${"tipoDoc".padEnd(9)}${"linhas +".padStart(10)}${"linhas -".padStart(10)}` +
          `${"soma +".padStart(12)}${"soma -".padStart(12)}   leitura`,
      );
      const decl = CLASSIFICACAO[NAMESPACES.ATENDIMENTO_SUSP_DETALHE];
      for (const d of r.recordset) {
        const td = d.tipoDoc;
        const conhecido =
          td !== null && (decl.venda.has(td) || decl.reversao.has(td));
        const leitura =
          d.neg > 0 && d.pos > 0
            ? "os DOIS sinais — regra por tipo+sinal"
            : d.neg > 0
              ? "so negativo — candidato a reversao"
              : "so positivo — candidato a venda";
        console.log(
          `  ${String(td ?? "-").padEnd(9)}${String(d.pos).padStart(10)}${String(d.neg).padStart(10)}` +
            `${String(d.somaPos).padStart(12)}${String(d.somaNeg).padStart(12)}   ${leitura}` +
            (conhecido ? "" : "  [POR DECLARAR]"),
        );
      }
      console.log("");
      console.log(`  Declarado hoje para este circuito:`);
      console.log(`    venda    = {${[...decl.venda].join(", ")}}`);
      console.log(`    reversao = {${[...decl.reversao].join(", ")}}`);
      console.log("");
      console.log("  Um tipo [POR DECLARAR] tem as linhas RECUSADAS pelo reader:");
      console.log("  nao entram como venda nem como anulacao. Se aparecer aqui");
      console.log("  com volume, o historico fica incompleto ate ser declarado.");
    });

    console.log("");
    console.log(DOUBLE);
    console.log("FIM — nada foi escrito. Nenhum POST ao SaaS.");
    console.log(DOUBLE);
    return 0;
  });
}
