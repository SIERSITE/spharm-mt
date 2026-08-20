/**
 * agent/src/commands/vendas-credito-series-audit.ts
 *
 * O que são, exactamente, as séries que vivem em `[Atendimento Credito]`.
 * Read-only: sem persistência, sem POST, sem escrita no ERP.
 *
 * ── PORQUE EXISTE ────────────────────────────────────────────────────
 *
 * `SERIE_CIRCUITO_CREDITO` declara hoje uma série só — `VCG_1`, guias de
 * transferência, confirmado funcionalmente. Tudo o resto é recusado, com
 * a série e as unidades no log, e o bootstrap real mostrou quanto é:
 *
 *   SEGURADO    VCC_1  tipo 38   2 937 linhas recusadas
 *   SILVEIRENSE VOG              2 linhas recusadas
 *
 * A tentação é a analogia: `VCC_1` parece-se com `VCG_1` — mesma tabela,
 * mesmo tipo 38, mesmos estados C/A — logo será transferência. Foi
 * exactamente assim que se declarou o `77`, o `Fim Venda = 'S'` e o `107`
 * sem sinal. Cada um deles produziu um total plausível e errado, e cada
 * um custou uma revisão a desfazer.
 *
 * Por isso este comando MEDE e não decide. Não escreve classificação
 * nenhuma, não altera `SERIE_CIRCUITO_CREDITO`, não toca no circuito G
 * nem no suspenso. Produz o material para a decisão: o inventário por
 * série, os documentos reais, e a assinatura documental de cada série ao
 * lado da assinatura do `VCG_1`, que é a única já confirmada.
 *
 * ── O QUE É UMA ASSINATURA DOCUMENTAL ────────────────────────────────
 *
 * Duas séries com a mesma natureza comportam-se da mesma maneira: linhas
 * por documento na mesma ordem de grandeza, mesma composição de estados,
 * mesma fracção de quantidade zero, mesma presença (ou ausência) de
 * negativos, mesmo tipo de contraparte. A §5 põe esses números lado a
 * lado. "Parecido" deixa de ser uma impressão e passa a ser uma coluna.
 *
 * O que a assinatura NÃO faz é decidir. Duas séries podem ter a mesma
 * forma e destinos diferentes — um documento de transferência e uma
 * factura a crédito têm ambos linhas, quantidades e um estado. A forma
 * estreita o campo; quem fecha é o operador.
 *
 * ── [Fim Venda] ──────────────────────────────────────────────────────
 *
 * Entra em todos os cortes como DADO e em nenhum `WHERE`. Já foi
 * refutado duas vezes como classificador.
 *
 * ── OS DOIS ERP ──────────────────────────────────────────────────────
 *
 *   agent -- vendas-credito-series-audit --db SPharm_Silveirense
 *   agent -- vendas-credito-series-audit --db SPharm_Segurado
 *
 * Uso:
 *   agent -- vendas-credito-series-audit [--from 2024-01-01] [--to 2026-08-20]
 *                                        [--db <base>] [--docs 10]
 */

import { parseArgs } from "node:util";
import sql from "mssql";
import { loadConfig } from "../config.js";
import { withPool, type SqlPool } from "../sql-client.js";
import { janela } from "../janela.js";
import {
  descobrirSchemaCredito,
  namespaceDaSerieCredito,
  resolverColuna,
  SERIE_CIRCUITO_CREDITO,
  CLASSIFICACAO,
  NAMESPACES,
  type SchemaFonteCredito,
} from "../vendas-fontes.js";
import { listColumns, quoteIdent, typeFamily } from "./probe-helpers.js";

const RULE = "─".repeat(74);
const DOUBLE = "═".repeat(74);

/** As três séries que motivaram a revisão. Foco do relatório, não filtro. */
const FOCO = ["VCC_1", "VOG", "VCG_1"] as const;

type Args = { from: string; to: string; db?: string; docs: number; help: boolean };

function parseCmdArgs(): Args {
  const raw = parseArgs({
    args: process.argv.slice(3),
    options: {
      from: { type: "string" },
      to: { type: "string" },
      db: { type: "string" },
      docs: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  const docs = Number(raw.values.docs ?? 10);
  return {
    from: typeof raw.values.from === "string" ? raw.values.from : "2024-01-01",
    to: typeof raw.values.to === "string" ? raw.values.to : "2026-08-20",
    db: typeof raw.values.db === "string" ? raw.values.db : undefined,
    docs: Number.isFinite(docs) && docs > 0 ? Math.min(Math.trunc(docs), 50) : 10,
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
    console.log(`✗ SECCAO FALHOU: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Corre uma query e, se falhar, IMPRIME O SQL.
 *
 * A rev71 morreu com `Invalid column name 'Serie'` e mais nada — nem a
 * query, nem o passo — e levou três secções atrás. Um passo que falha
 * diz o que tentou e deixa os outros correr.
 */
async function consultar<T>(
  pedido: sql.Request,
  texto: string,
  rotulo: string,
): Promise<{ recordset: T[] } | null> {
  try {
    return await pedido.query<T>(texto);
  } catch (err) {
    console.log(`   ✗ ${rotulo}: ${err instanceof Error ? err.message : String(err)}`);
    console.log("     ── SQL que falhou ──");
    for (const l of texto.split("\n")) console.log(`     | ${l}`);
    return null;
  }
}

/** O circuito de crédito, com as expressões já qualificadas. */
export type Circuito = {
  fonte: string;
  cab: string;
  pkCab: string;
  pkDet: string;
  data: string;
  serie: string;
  tipo: string;
  estado: string;
  numero: string;
  qtd: string;
  codigo: string;
  valor: string;
  /** Colunas do cabeçalho que parecem identificar a contraparte. */
  contrapartes: string[];
};

export function montar(c: SchemaFonteCredito, contrapartes: string[]): Circuito {
  const q = (x: string | null) => (x ? quoteIdent(x) : null);
  const falta: string[] = [];
  const exigir = (nome: string, v: string | null) => {
    if (!v) falta.push(nome);
    return v;
  };
  const pkCab = exigir("pk do cabecalho", q(c.cabecalhoPk));
  const pkDet = exigir("pk do detalhe", q(c.detalhePk));
  const lig = exigir("chave de ligacao", q(c.chaveLigacao));
  const data = exigir("data", q(c.data));
  const qtd = exigir("quantidade", q(c.quantidade));
  const codigo = exigir("CodigoID", q(c.codigoId));
  // A série é o EIXO deste relatório, não um campo opcional. Sem ela
  // todas as linhas cairiam num único balde e o relatório diria "há uma
  // série" — que é o oposto do que existe para responder.
  const serie = exigir("serie", q(c.serie));
  if (falta.length > 0) {
    throw new Error(
      `nao foi possivel montar o circuito de credito — falta: ${falta.join(", ")}` +
        ` (cabecalho: ${c.cabecalhoTabela ?? "-"}, detalhe: ${c.detalheTabela ?? "-"},` +
        ` candidatas: ${c.candidatas.join(" | ") || "nenhuma"})`,
    );
  }
  return {
    fonte:
      `[dbo].${quoteIdent(c.detalheTabela!)} d\n` +
      `  JOIN [dbo].${quoteIdent(c.cabecalhoTabela!)} h ON h.${lig} = d.${lig}`,
    cab: `[dbo].${quoteIdent(c.cabecalhoTabela!)}`,
    pkCab: `h.${pkCab}`,
    pkDet: `d.${pkDet}`,
    data: `h.${data}`,
    serie: `h.${serie}`,
    tipo: c.tipoDocumento ? `h.${q(c.tipoDocumento)}` : "NULL",
    estado: c.estado ? `h.${q(c.estado)}` : "NULL",
    numero: c.numero ? `h.${q(c.numero)}` : "NULL",
    qtd: `d.${qtd}`,
    codigo: `d.${codigo}`,
    valor: c.valorLinha ? `d.${q(c.valorLinha)}` : "NULL",
    contrapartes,
  };
}

/**
 * O `GROUP BY` só pode conter colunas reais.
 *
 * `[Tipo Documento ID]` e `[Fim Venda]` são resolvidos por descoberta e
 * podem faltar noutra instalação — nesse caso a expressão é o literal
 * `NULL`, e agrupar por uma constante é erro no SQL Server. Sem este
 * filtro, uma coluna informativa em falta matava a secção inteira.
 */
export function agrupavel(...exprs: string[]): string[] {
  return exprs.filter((e) => e !== "NULL");
}

// ── OS SEIS SQL, COMO FUNÇÕES PURAS ──────────────────────────────────
//
// Exportados para serem testáveis sem ERP. Um `Invalid column name` que
// só aparece na farmácia custa uma revisão inteira — foi assim que a
// rev71 morreu, e a §4 dela nunca chegou a correr. Uma sonda que existe
// para poupar rondas não pode ser ela própria a gastá-las.

const janelaDe = (C: Circuito): string => `${C.data} >= @from AND ${C.data} < @to`;

/** O sinal da quantidade como termo de agrupamento. */
export const sinalDe = (C: Circuito): string =>
  `CASE WHEN ${C.qtd} > 0 THEN 'POS' WHEN ${C.qtd} < 0 THEN 'NEG' ELSE 'ZERO' END`;

/** §1 — uma linha por série. */
export function sqlInventarioSeries(C: Circuito): string {
  return `
        SELECT ${C.serie} AS serie,
               COUNT(DISTINCT ${C.pkCab}) AS docs,
               COUNT(*) AS linhas,
               SUM(CAST(${C.qtd} AS FLOAT)) AS soma,
               SUM(CASE WHEN ${C.qtd} > 0 THEN 1 ELSE 0 END) AS pos,
               SUM(CASE WHEN ${C.qtd} < 0 THEN 1 ELSE 0 END) AS neg,
               SUM(CASE WHEN ${C.qtd} = 0 THEN 1 ELSE 0 END) AS zero,
               SUM(CASE WHEN ${C.qtd} > 0 THEN CAST(${C.qtd} AS FLOAT) ELSE 0 END) AS somaPos,
               SUM(CASE WHEN ${C.qtd} < 0 THEN CAST(${C.qtd} AS FLOAT) ELSE 0 END) AS somaNeg,
               MIN(${C.data}) AS primeiro,
               MAX(${C.data}) AS ultimo
          FROM ${C.fonte}
         WHERE ${janelaDe(C)}
         GROUP BY ${C.serie}
         ORDER BY COUNT(*) DESC`;
}

/** §2 — série × tipoDoc × estado × sinal. */
export function sqlMatriz(C: Circuito): string {
  const sinal = sinalDe(C);
  return `
        SELECT ${C.serie} AS serie,
               ${C.tipo} AS tipoDoc,
               ${C.estado} AS estado,
               ${sinal} AS sinal,
               COUNT(DISTINCT ${C.pkCab}) AS docs,
               COUNT(*) AS linhas,
               SUM(CAST(${C.qtd} AS FLOAT)) AS soma,
               MIN(${C.data}) AS primeiro,
               MAX(${C.data}) AS ultimo
          FROM ${C.fonte}
         WHERE ${janelaDe(C)}
         GROUP BY ${[...agrupavel(C.serie, C.tipo, C.estado), sinal].join(", ")}
         ORDER BY 1, 2, 3, 4`;
}

/**
 * §3 — as linhas dos N documentos mais recentes de uma série.
 *
 * A subquery repete o alias `h`: dentro dela `h` é o cabeçalho sozinho,
 * e é isso que a torna auto-suficiente em vez de correlacionada.
 */
export function sqlDocumentos(C: Circuito, nomeProduto: string | null): string {
  const j = janelaDe(C);
  return `
          SELECT ${C.numero} AS numero,
                 ${C.data} AS data,
                 ${C.tipo} AS tipoDoc,
                 ${C.estado} AS estado,
                 ${C.codigo} AS codigo,
                 ${nomeProduto ? `p.${quoteIdent(nomeProduto)}` : "NULL"} AS nome,
                 ${C.qtd} AS qtd,
                 ${C.valor} AS valor
            FROM ${C.fonte}
            LEFT JOIN [dbo].[Stocks] p ON p.CodigoID = ${C.codigo}
           WHERE ${j}
             AND LTRIM(RTRIM(${C.serie})) = @serie
             AND ${C.pkCab} IN (
                   SELECT TOP (@n) ${C.pkCab}
                     FROM ${C.cab} h
                    WHERE ${j}
                      AND LTRIM(RTRIM(${C.serie})) = @serie
                    ORDER BY ${C.data} DESC, ${C.pkCab} DESC
                 )
           ORDER BY ${C.data} DESC, ${C.pkCab} DESC, ${C.pkDet}`;
}

/** §4a — as métricas de forma, por série. */
export function sqlAssinatura(C: Circuito): string {
  return `
        SELECT ${C.serie} AS serie,
               COUNT(DISTINCT ${C.pkCab}) AS docs,
               COUNT(*) AS linhas,
               COUNT(DISTINCT ${C.codigo}) AS produtos,
               SUM(CAST(${C.qtd} AS FLOAT)) AS soma,
               SUM(CASE WHEN ${C.qtd} = 0 THEN 1 ELSE 0 END) AS zero,
               SUM(CASE WHEN ${C.qtd} < 0 THEN 1 ELSE 0 END) AS neg
          FROM ${C.fonte}
         WHERE ${janelaDe(C)}
         GROUP BY ${C.serie}`;
}

/** §4b — que tipos e que estados cada série usa. Agregado em JS. */
export function sqlPerfis(C: Circuito): string {
  return `
        SELECT DISTINCT ${C.serie} AS serie, ${C.tipo} AS tipoDoc, ${C.estado} AS estado
          FROM ${C.fonte}
         WHERE ${janelaDe(C)}`;
}

/** §5 — quem está do outro lado, por série. */
export function sqlContraparte(C: Circuito, coluna: string): string {
  return `
          SELECT ${C.serie} AS serie,
                 h.${quoteIdent(coluna)} AS valor,
                 COUNT(DISTINCT ${C.pkCab}) AS docs,
                 COUNT(*) AS linhas
            FROM ${C.fonte}
           WHERE ${janelaDe(C)}
           GROUP BY ${C.serie}, h.${quoteIdent(coluna)}
           ORDER BY 1, COUNT(*) DESC`;
}

/**
 * As colunas do cabeçalho que podem identificar a contraparte.
 *
 * É a diferença material entre os dois universos possíveis: uma guia de
 * transferência tem do outro lado uma farmácia ou um armazém; uma venda
 * a crédito tem um cliente ou uma entidade comparticipadora. Descobertas
 * por nome porque não há garantia de que existam — se faltarem, a §6 diz
 * que faltaram em vez de inventar um destino.
 */
function colunasContraparte(cols: { name: string }[]): string[] {
  return cols
    .map((c) => c.name)
    .filter((n) => /entidade|cliente|destino|origem|farmacia|armazem|posto/i.test(n))
    .slice(0, 6);
}

/** A designação de um produto, se o ERP a tiver onde é costume. */
async function colunaNomeProduto(pool: SqlPool): Promise<string | null> {
  try {
    const cols = await listColumns(pool, { schema: "dbo", table: "Stocks" });
    return resolverColuna(
      cols.map((c) => ({ column: c.name })),
      ["Nome Comercial", "Designacao", "Descricao"],
      [/nome\s*comercial/i, /designacao/i, /descricao/i],
    );
  } catch {
    return null;
  }
}

/** Uma tabela de lookup pequena onde um ID tem nome. */
async function lookupDesignacoes(
  pool: SqlPool,
  coluna: string,
): Promise<Map<string, string> | null> {
  try {
    const r = await pool
      .request()
      .input("c", sql.NVarChar, coluna)
      .query<{ tabela: string }>(`
        SELECT t.name AS tabela
          FROM sys.tables t
          JOIN sys.columns c ON c.object_id = t.object_id
         WHERE t.is_ms_shipped = 0 AND c.name = @c
         ORDER BY (SELECT COUNT(*) FROM sys.columns x WHERE x.object_id = t.object_id), t.name
      `);
    for (const { tabela } of r.recordset) {
      const cols = await listColumns(pool, { schema: "dbo", table: tabela });
      if (cols.length > 14) continue;
      const texto = cols.find(
        (c) => typeFamily(c.dataType) === "string" && !/guid|key|codigo/i.test(c.name),
      );
      if (!texto) continue;
      const v = await pool.request().query<{ id: unknown; nome: unknown }>(
        `SELECT ${quoteIdent(coluna)} AS id, ${quoteIdent(texto.name)} AS nome
           FROM [dbo].${quoteIdent(tabela)}`,
      );
      if (v.recordset.length === 0 || v.recordset.length > 800) continue;
      const m = new Map<string, string>();
      for (const x of v.recordset) m.set(String(x.id), String(x.nome ?? ""));
      return m;
    }
  } catch {
    return null;
  }
  return null;
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const dia = (v: unknown): string => (v ? String(v).slice(0, 10) : "-");

/** O que o reader faz hoje com uma série. Lido do código, não escrito. */
function veredictoDeclarado(serie: string): string {
  const ns = namespaceDaSerieCredito(serie);
  if (ns) return `DECLARADA -> ${ns}`;
  return "RECUSADA (nao declarada)";
}

type LinhaSerie = {
  serie: string | null;
  docs: number;
  linhas: number;
  soma: number;
  pos: number;
  neg: number;
  zero: number;
  somaPos: number;
  somaNeg: number;
  primeiro: unknown;
  ultimo: unknown;
};

type Assinatura = {
  serie: string;
  docs: number;
  linhas: number;
  linhasPorDoc: number;
  produtos: number;
  soma: number;
  fraccaoZero: number;
  fraccaoNeg: number;
  tipos: string;
  estados: string;
};

export async function vendasCreditoSeriesAudit(): Promise<number> {
  let args: Args;
  try {
    args = parseCmdArgs();
  } catch (err) {
    console.error("✗", err instanceof Error ? err.message : err);
    return 1;
  }
  if (args.help) {
    console.log(
      "Uso: vendas-credito-series-audit [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--db <base>] [--docs N]",
    );
    console.log("");
    console.log("Read-only. Inventaria TODAS as series de [Atendimento Credito]:");
    console.log("serie x tipoDoc x estado x sinal, documentos reais, e a assinatura");
    console.log("documental de cada serie ao lado da do VCG_1 (a unica confirmada).");
    console.log("NAO classifica, NAO altera SERIE_CIRCUITO_CREDITO, NAO escreve nada.");
    return 0;
  }

  const j = janela(args.from, args.to);
  const base = loadConfig("sql");
  const cfg = args.db ? { ...base, sqlDatabase: args.db } : base;

  return withPool(cfg, async (pool) => {
    console.log(DOUBLE);
    console.log("vendas-credito-series-audit — READ-ONLY");
    console.log(DOUBLE);
    console.log(`ERP    : ${cfg.sqlDatabase}@${cfg.sqlHost}`);
    console.log(`Janela : ${j.inicio} .. ${j.fimExclusivo} (exclusivo)`);
    console.log("");
    console.log("Este comando MEDE. Nao decide, nao classifica, nao escreve.");
    console.log("[Fim Venda] aparece como DADO e nunca em WHERE.");

    const c = await descobrirSchemaCredito(pool);
    if (!c.existe || !c.cabecalhoTabela || !c.detalheTabela) {
      console.log("");
      console.log("✗ Esta instalacao nao tem o circuito [Atendimento Credito].");
      console.log(`  candidatas vistas: ${c.candidatas.join(" | ") || "nenhuma"}`);
      return 1;
    }

    const colsCab = await listColumns(pool, { schema: "dbo", table: c.cabecalhoTabela });
    let C: Circuito;
    try {
      C = montar(c, colunasContraparte(colsCab));
    } catch (err) {
      console.log(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    const nomeProduto = await colunaNomeProduto(pool);

    console.log("");
    console.log(RULE);
    console.log("SCHEMA RESOLVIDO (rev78 — por estrutura, nao por ordem de catalogo)");
    console.log(RULE);
    console.log(`  cabecalho : ${c.cabecalhoTabela}   pk=${c.cabecalhoPk ?? "-"}`);
    console.log(`  detalhe   : ${c.detalheTabela}   pk=${c.detalhePk ?? "-"}`);
    console.log(`  ligacao   : ${c.chaveLigacao ?? "-"}`);
    console.log(
      `  colunas   : data=${c.data ?? "-"} serie=${c.serie ?? "-"} numero=${c.numero ?? "-"}` +
        ` tipoDoc=${c.tipoDocumento ?? "-"} estado=${c.estado ?? "-"}`,
    );
    console.log(
      `              produto=${c.codigoId ?? "-"} qtd=${c.quantidade ?? "-"} valor=${c.valorLinha ?? "-"}`,
    );
    console.log(`  candidatas: ${c.candidatas.join(" | ")}`);
    console.log(
      `  contraparte: ${C.contrapartes.length > 0 ? C.contrapartes.join(", ") : "(nenhuma coluna candidata no cabecalho)"}`,
    );
    console.log("");
    console.log("  Declarado hoje em SERIE_CIRCUITO_CREDITO:");
    for (const [s, ns] of Object.entries(SERIE_CIRCUITO_CREDITO)) {
      console.log(`    ${s.padEnd(10)} -> ${ns}`);
    }
    const regraTransf = CLASSIFICACAO[NAMESPACES.GUIAS_TRANSFERENCIA];
    console.log(
      `  Classificacao das guias: tipos {${[...regraTransf.peloSinal].join(",")}} PELO SINAL` +
        ` (qtd>0 venda, qtd<0 anulacao, qtd=0 recusada)`,
    );
    console.log("  Toda a serie nao declarada e RECUSADA — nao entra como venda nem");
    console.log("  como anulacao. E isso que este relatorio existe para quantificar.");

    const req = () =>
      pool
        .request()
        .input("from", sql.VarChar, j.inicio)
        .input("to", sql.VarChar, j.fimExclusivo);

    // ── 1. Todas as séries ───────────────────────────────────────────
    let series: LinhaSerie[] = [];
    await seccao("1. TODAS as series de [Atendimento Credito] na janela", async () => {
      const r = await consultar<LinhaSerie>(req(), sqlInventarioSeries(C), "inventario por serie");
      if (!r) return;
      series = r.recordset;
      console.log(
        `  ${"serie".padEnd(12)}${"docs".padStart(8)}${"linhas".padStart(9)}${"soma qtd".padStart(11)}` +
          `${"pos".padStart(8)}${"neg".padStart(7)}${"zero".padStart(7)}  ${"primeiro".padEnd(11)}${"ultimo".padEnd(11)} estado no reader`,
      );
      for (const s of series) {
        const nome = s.serie === null ? "(NULL)" : String(s.serie).trim();
        console.log(
          `  ${nome.padEnd(12)}${String(num(s.docs)).padStart(8)}${String(num(s.linhas)).padStart(9)}` +
            `${num(s.soma).toFixed(0).padStart(11)}${String(num(s.pos)).padStart(8)}` +
            `${String(num(s.neg)).padStart(7)}${String(num(s.zero)).padStart(7)}  ` +
            `${dia(s.primeiro).padEnd(11)}${dia(s.ultimo).padEnd(11)} ${veredictoDeclarado(nome)}`,
        );
      }
      const recusadas = series.filter((s) => !namespaceDaSerieCredito(String(s.serie ?? "")));
      const linhasRec = recusadas.reduce((a, s) => a + num(s.linhas), 0);
      const uniRec = recusadas.reduce((a, s) => a + num(s.soma), 0);
      console.log("");
      console.log(
        `  RECUSADO HOJE: ${recusadas.length} serie(s), ${linhasRec} linhas, ${uniRec.toFixed(0)} unidades.`,
      );
      console.log("  Este numero e a diferenca entre 'lidas' e 'aceites' do bootstrap.");
    });

    // ── 2. Série × tipoDoc × estado × sinal ──────────────────────────
    await seccao("2. MATRIZ serie x tipoDoc x estado x sinal", async () => {
      const r = await consultar<{
        serie: string | null;
        tipoDoc: number | null;
        estado: string | null;
        sinal: string;
        docs: number;
        linhas: number;
        soma: number;
        primeiro: unknown;
        ultimo: unknown;
      }>(req(), sqlMatriz(C), "matriz serie x tipo x estado x sinal");
      if (!r) return;
      console.log(
        `  ${"serie".padEnd(12)}${"tipoDoc".padStart(8)}${"estado".padStart(8)}${"sinal".padStart(7)}` +
          `${"docs".padStart(8)}${"linhas".padStart(9)}${"soma qtd".padStart(11)}  ${"primeiro".padEnd(11)}ultimo`,
      );
      for (const d of r.recordset) {
        console.log(
          `  ${String(d.serie ?? "(NULL)").trim().padEnd(12)}${String(d.tipoDoc ?? "-").padStart(8)}` +
            `${String(d.estado ?? "-").trim().padStart(8)}${d.sinal.padStart(7)}` +
            `${String(num(d.docs)).padStart(8)}${String(num(d.linhas)).padStart(9)}` +
            `${num(d.soma).toFixed(0).padStart(11)}  ${dia(d.primeiro).padEnd(11)}${dia(d.ultimo)}`,
        );
      }
      console.log("");
      console.log("  Um tipo que aparece com os DOIS sinais e candidato a regra PELO");
      console.log("  SINAL — que e o que o 38 ja tem. Um tipo so com ZERO nao e");
      console.log("  contabilizavel em circunstancia nenhuma.");
    });

    // ── 3. Documentos reais ──────────────────────────────────────────
    // Foco primeiro, resto a seguir. Se a §1 falhou, `series` vem vazio
    // e o foco entra na mesma: uma secção que falha não pode apagar as
    // três séries que motivaram a revisão.
    const alvos =
      series.length === 0
        ? [...FOCO]
        : [
            ...FOCO.filter((f) => series.some((s) => String(s.serie ?? "").trim() === f)),
            ...series
              .map((s) => String(s.serie ?? "").trim())
              .filter((s) => s && !FOCO.includes(s as (typeof FOCO)[number])),
          ];
    for (const serie of alvos) {
      await seccao(`3. DOCUMENTOS REAIS — serie ${serie}   [${veredictoDeclarado(serie)}]`, async () => {
        const r = await consultar<{
          numero: unknown;
          data: unknown;
          tipoDoc: number | null;
          estado: string | null;
          codigo: unknown;
          nome: string | null;
          qtd: number;
          valor: number | null;
        }>(
          req().input("serie", sql.VarChar, serie).input("n", sql.Int, args.docs),
          sqlDocumentos(C, nomeProduto),
          `documentos da serie ${serie}`,
        );
        if (!r) return;
        if (r.recordset.length === 0) {
          console.log("  (sem linhas na janela)");
          return;
        }
        console.log(
          `  ${"numero".padEnd(16)}${"data".padEnd(12)}${"tipo".padStart(6)}${"est".padStart(5)}` +
            `${"produto".padStart(10)}${"qtd".padStart(9)}${"valor".padStart(11)}  designacao`,
        );
        let anterior = "";
        for (const l of r.recordset) {
          const chave = `${String(l.numero ?? "")}|${dia(l.data)}`;
          const mostraDoc = chave !== anterior;
          anterior = chave;
          console.log(
            `  ${(mostraDoc ? String(l.numero ?? "-") : "").padEnd(16)}` +
              `${(mostraDoc ? dia(l.data) : "").padEnd(12)}` +
              `${(mostraDoc ? String(l.tipoDoc ?? "-") : "").padStart(6)}` +
              `${(mostraDoc ? String(l.estado ?? "-").trim() : "").padStart(5)}` +
              `${String(l.codigo ?? "-").padStart(10)}${num(l.qtd).toFixed(0).padStart(9)}` +
              `${(l.valor === null ? "-" : num(l.valor).toFixed(2)).padStart(11)}  ` +
              `${(l.nome ?? "").slice(0, 28)}`,
          );
        }
      });
    }

    // ── 4. Assinatura documental ─────────────────────────────────────
    const assinaturas: Assinatura[] = [];
    await seccao("4. ASSINATURA DOCUMENTAL — cada serie ao lado do VCG_1", async () => {
      const r = await consultar<{
        serie: string | null;
        docs: number;
        linhas: number;
        produtos: number;
        soma: number;
        zero: number;
        neg: number;
      }>(req(), sqlAssinatura(C), "assinatura por serie");
      if (!r) return;
      // A composição documental de cada série sai de um DISTINCT simples
      // e é agregada aqui. `FOR XML PATH` fá-lo-ia numa query só — e
      // seria o único SQL do ficheiro que depende de uma extensão do
      // fornecedor, num relatório cuja razão de ser é não depender de
      // suposições sobre o ERP.
      const perfis = await consultar<{
        serie: string | null;
        tipoDoc: number | null;
        estado: string | null;
      }>(req(), sqlPerfis(C), "tipos e estados por serie");
      const tipos = new Map<string, Set<string>>();
      const estados = new Map<string, Set<string>>();
      for (const p of perfis?.recordset ?? []) {
        const k = String(p.serie ?? "(NULL)").trim();
        if (!tipos.has(k)) tipos.set(k, new Set());
        if (!estados.has(k)) estados.set(k, new Set());
        if (p.tipoDoc !== null) tipos.get(k)!.add(String(p.tipoDoc));
        if (p.estado !== null) estados.get(k)!.add(String(p.estado).trim());
      }
      const junta = (s: Set<string> | undefined): string =>
        s && s.size > 0 ? [...s].sort().join(",") : "-";
      const perfil = new Map<string, { tipos: string; estados: string }>();
      for (const k of tipos.keys()) {
        perfil.set(k, { tipos: junta(tipos.get(k)), estados: junta(estados.get(k)) });
      }
      for (const s of r.recordset) {
        const nome = String(s.serie ?? "(NULL)").trim();
        assinaturas.push({
          serie: nome,
          docs: num(s.docs),
          linhas: num(s.linhas),
          linhasPorDoc: num(s.docs) === 0 ? 0 : num(s.linhas) / num(s.docs),
          produtos: num(s.produtos),
          soma: num(s.soma),
          fraccaoZero: num(s.linhas) === 0 ? 0 : num(s.zero) / num(s.linhas),
          fraccaoNeg: num(s.linhas) === 0 ? 0 : num(s.neg) / num(s.linhas),
          tipos: perfil.get(nome)?.tipos ?? "-",
          estados: perfil.get(nome)?.estados ?? "-",
        });
      }
      assinaturas.sort((a, b) => b.linhas - a.linhas);
      console.log(
        `  ${"serie".padEnd(12)}${"linhas/doc".padStart(11)}${"produtos".padStart(10)}` +
          `${"% qtd=0".padStart(9)}${"% neg".padStart(8)}  ${"tipos".padEnd(14)}estados`,
      );
      for (const a of assinaturas) {
        console.log(
          `  ${a.serie.padEnd(12)}${a.linhasPorDoc.toFixed(2).padStart(11)}` +
            `${String(a.produtos).padStart(10)}${(a.fraccaoZero * 100).toFixed(1).padStart(8)}%` +
            `${(a.fraccaoNeg * 100).toFixed(1).padStart(7)}%  ` +
            `${a.tipos.slice(0, 13).padEnd(14)}${a.estados.slice(0, 20)}`,
        );
      }

      const ref = assinaturas.find((a) => a.serie === "VCG_1");
      console.log("");
      if (!ref) {
        console.log("  Nao ha VCG_1 nesta base: sem referencia confirmada para comparar.");
        console.log("  A comparacao estrutural so vale contra uma serie ja confirmada");
        console.log("  funcionalmente. Correr tambem na Silveirense antes de decidir.");
        return;
      }
      console.log("  Comparacao com o VCG_1 (a unica serie confirmada funcionalmente):");
      for (const a of assinaturas) {
        if (a.serie === "VCG_1") continue;
        const difs: string[] = [];
        const rel = (x: number, y: number) => (y === 0 ? (x === 0 ? 0 : 1) : Math.abs(x - y) / y);
        if (rel(a.linhasPorDoc, ref.linhasPorDoc) > 0.5) difs.push("linhas/doc");
        if (Math.abs(a.fraccaoZero - ref.fraccaoZero) > 0.1) difs.push("fraccao qtd=0");
        if (Math.abs(a.fraccaoNeg - ref.fraccaoNeg) > 0.1) difs.push("fraccao negativa");
        if (a.tipos !== ref.tipos) difs.push("tipos documentais");
        if (a.estados !== ref.estados) difs.push("estados");
        console.log(
          `    ${a.serie.padEnd(12)} ${difs.length === 0 ? "MESMA FORMA que VCG_1 em todas as metricas medidas" : `DIFERE em: ${difs.join(", ")}`}`,
        );
      }
      console.log("");
      console.log("  ATENCAO: forma igual NAO e natureza igual. Duas series podem ter");
      console.log("  a mesma estrutura e destinos diferentes — uma guia e uma factura");
      console.log("  a credito tem ambas linhas, quantidades e estado. Isto estreita o");
      console.log("  campo; quem fecha e a confirmacao funcional do operador.");
    });

    // ── 5. Contraparte ───────────────────────────────────────────────
    await seccao("5. CONTRAPARTE por serie — quem esta do outro lado", async () => {
      if (C.contrapartes.length === 0) {
        console.log("  O cabecalho nao tem nenhuma coluna candidata a contraparte.");
        console.log("  Sem ela nao e possivel distinguir destino-farmacia de cliente");
        console.log("  por esta via. Nao se inventa um destino que a base nao tem.");
        return;
      }
      for (const col of C.contrapartes) {
        console.log("");
        console.log(`  ── ${col} ──`);
        const lookup = await lookupDesignacoes(pool, col);
        const r = await consultar<{
          serie: string | null;
          valor: unknown;
          docs: number;
          linhas: number;
        }>(req(), sqlContraparte(C, col), `contraparte ${col}`);
        if (!r) continue;
        const porSerie = new Map<string, typeof r.recordset>();
        for (const d of r.recordset) {
          const k = String(d.serie ?? "(NULL)").trim();
          if (!porSerie.has(k)) porSerie.set(k, []);
          porSerie.get(k)!.push(d);
        }
        for (const [serie, linhas] of porSerie) {
          console.log(`    ${serie}  (${linhas.length} valores distintos)`);
          for (const d of linhas.slice(0, 5)) {
            const nome = lookup?.get(String(d.valor)) ?? "";
            console.log(
              `      ${String(d.valor ?? "(NULL)").padEnd(12)}${String(num(d.docs)).padStart(8)} docs` +
                `${String(num(d.linhas)).padStart(9)} linhas  ${nome.slice(0, 34)}`,
            );
          }
        }
        console.log(
          lookup
            ? "    (designacoes resolvidas por lookup no proprio ERP)"
            : "    (sem tabela de lookup para esta coluna — so IDs)",
        );
      }
      console.log("");
      console.log("  UMA contraparte que e farmacia/armazem aponta para transferencia.");
      console.log("  UMA contraparte que e cliente ou entidade aponta para credito.");
      console.log("  Poucos valores distintos e concentrados = destino fixo.");
      console.log("  Muitos valores dispersos = clientes. Nenhum destes e prova");
      console.log("  sozinho: e material para a confirmacao funcional.");
    });

    // ── 6. O que fazer com isto ──────────────────────────────────────
    console.log("");
    console.log(DOUBLE);
    console.log("O QUE ESTE RELATORIO NAO FAZ");
    console.log(DOUBLE);
    console.log("Nao declarou nada. `SERIE_CIRCUITO_CREDITO` esta como estava:");
    for (const [s, ns] of Object.entries(SERIE_CIRCUITO_CREDITO)) {
      console.log(`  ${s} -> ${ns}`);
    }
    console.log("");
    console.log("Para declarar uma serie e preciso confirmacao funcional do operador,");
    console.log("como houve para o VCG_1 — nao a semelhanca com ele. O 77, o");
    console.log("Fim Venda='S' e o 107 sem sinal foram todos declarados por analogia.");
    console.log("");
    console.log("Enquanto uma serie nao for declarada, as suas linhas sao recusadas");
    console.log("com a serie e as unidades no log do bootstrap. Um numero em falta");
    console.log("que se ve vale mais do que um total plausivel.");
    console.log("");
    console.log(DOUBLE);
    console.log("FIM — nada foi escrito. Nenhum POST ao SaaS. Nenhuma alteracao no ERP.");
    console.log(DOUBLE);
    return 0;
  });
}
