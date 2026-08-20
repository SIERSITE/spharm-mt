/**
 * agent/src/commands/bootstrap-dry-run.ts
 *
 * Preview da PRIMEIRA INGESTÃO controlada. Transforma dados ERP em
 * payloads canónicos SPharm.MT, imprime contagens, métricas, amostras
 * e alertas de qualidade. **Não escreve em Neon, não chama a SaaS,
 * não persiste em disco.** Stdout-only.
 *
 * Operacionaliza §5.7 do mapping canónico em
 * `docs/spharm-erp-canonical-mapping.md`.
 *
 * Três pipelines:
 *   1. PRODUTOS — dbo.Stocks (+ OUTER APPLY dbo.ArmazensStocks p/
 *      fornecedor habitual + LEFT JOIN dbo.Fornecedores p/ nome).
 *      Filtro: [Retirado]=0 AND [Processa_Stocks]<>0.
 *   2. STOCK — dbo.ArmazensStocks JOIN dbo.Stocks (mesmo filtro).
 *   3. VENDAS — dbo.Atendimento JOIN dbo.Atendimento Detalhe.
 *      Filtros: [Fim Venda] IN ('S','U') AND [Data Venda] BETWEEN @from AND @to.
 *      Classificação JS-side de [Tipo Documento], delegada à regra
 *      canónica em `vendas-fontes.ts`:
 *        7, 2    → VENDA
 *        27, 104 → DEVOLUCAO_ANULACAO
 *        ?       → UNKNOWN, listado em quality alert
 *
 * Garantias:
 *   · Read-only, sem ORM, SQL 2008 R2 (incl. OUTER APPLY).
 *   · TOP 10 produtos, TOP 10 stocks, TOP 20 vendas amostradas.
 *   · Métricas via SUM SQL-side (não in-memory).
 *   · "Batching defensivo" para futuro: TOP/sample agora; quando o
 *     bootstrap real for entregue, vai chunkar 5k linhas/lote contra
 *     /api/ingest/v1/*.
 */

import { parseArgs } from "node:util";
import sql from "mssql";
import { loadConfig, type AgentConfig } from "../config.js";
import { withPool, type SqlPool } from "../sql-client.js";
import {
  listColumns,
  assertColumnsExist,
  renderSampleHorizontal,
  parseDateArg,
} from "./probe-helpers.js";
import { NAMESPACES, classificarDocumento } from "../vendas-fontes.js";
import { OPCOES_INCLUIR_HOJE, aplicarGuardaTemporal, leuIncluirHoje } from "../janela.js";

const RULE = "─".repeat(70);
const DOUBLE_RULE = "═".repeat(70);

// ─────────────────────────────────────────────────────────────────────
// Payload types canónicos SPharm.MT
// ─────────────────────────────────────────────────────────────────────

type ProductPayload = {
  externalProductId: number | null;
  cnp: number | null;
  designacao: string | null;
  pvp: number | null;
  pmc: number | null;
  puc: number | null;
  dataUltimaVenda: string | null;
  dataUltimaCompra: string | null;
  retirado: boolean | null;
  generico: boolean | null;
  mnsrmNCompart: boolean | null;
  fornecedorHabitualId: number | null;
  fornecedorHabitualNome: string | null;
};

type StockPayload = {
  externalProductId: number | null;
  externalWarehouseId: number | null;
  stockAtual: number | null;
  stockMinimo: number | null;
  stockMaximo: number | null;
  stockEncomenda: number | null;
  stockReserva: number | null;
};

type TipoDocClass = "VENDA" | "DEVOLUCAO_ANULACAO" | "UNKNOWN";

type SaleLinePayload = {
  externalSaleId: number | null;
  externalSaleLineId: number | null;
  dataVenda: string | null;
  tipoDocumento: number | null;
  tipoDocumentoClass: TipoDocClass;
  externalProductId: number | null;
  quantidade: number | null;
  pvpUnitario: number | null;
  valorLinha: number | null;
  ivaValor: number | null;
  descontoValor: number | null;
  comparticipacao1: number | null;
  comparticipacao2: number | null;
  entidadeId: number | null;
};

// ─────────────────────────────────────────────────────────────────────
// Coerções para JSON canónico (tedious devolve Date, strings, números)
// ─────────────────────────────────────────────────────────────────────

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === "bigint") return Number(v);
  return null;
}

function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s === "" ? null : s;
}

function boolOrNull(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (t === "" ) return null;
    if (t === "1" || t === "s" || t === "true" || t === "y") return true;
    if (t === "0" || t === "n" || t === "false") return false;
  }
  return null;
}

function isoDateOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  return null;
}

/**
 * A classificação canónica, não uma terceira cópia dela.
 *
 * Era `77 -> VENDA, 104 -> DEVOLUCAO_ANULACAO, resto UNKNOWN`. O 77 nunca
 * foi observado em ERP nenhum e o tipo real da venda de balcão é o 7 —
 * portanto este preview mostrava a venda toda como UNKNOWN.
 *
 * Isto não escreve nada, e é precisamente por isso que importa: é o
 * comando com que se vai VER se está bem antes de carregar. Um preview
 * que discorda do reader confirma o erro em vez de o mostrar.
 */
function classifyTipoDoc(t: number | null, quantidade: number | null): TipoDocClass {
  return (
    classificarDocumento(t, NAMESPACES.ATENDIMENTO_DETALHE, quantidade) ?? "UNKNOWN"
  );
}

// ─────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────

type Args = { from?: string; to?: string; incluirHoje: boolean; help?: boolean };

function parseCmdArgs(): Args {
  const raw = parseArgs({
    args: process.argv.slice(3),
    options: {
      from: { type: "string" },
      to: { type: "string" },
      ...OPCOES_INCLUIR_HOJE,
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  return {
    from: typeof raw.values.from === "string" ? raw.values.from : undefined,
    to: typeof raw.values.to === "string" ? raw.values.to : undefined,
    incluirHoje: leuIncluirHoje(raw.values),
    help: raw.values.help === true,
  };
}

function printHelp(): void {
  console.log("Uso: bootstrap-dry-run --from YYYY-MM-DD --to YYYY-MM-DD");
  console.log("  --include-today  permite --to = hoje (dia AINDA ABERTO — parcial). Default: até ontem.");
  console.log("");
  console.log("Preview da primeira ingestão. Transforma ERP em payloads canónicos");
  console.log("SPharm.MT e imprime contagens + amostras + alertas. **Sem escrita.**");
  console.log("");
  console.log("Três pipelines:");
  console.log("  1. PRODUTOS  — Stocks + ArmazensStocks (fornecedor) + Fornecedores");
  console.log("  2. STOCK     — ArmazensStocks (filtro operacional via Stocks)");
  console.log("  3. VENDAS    — Atendimento + Detalhe (--from/--to + Fim Venda IN ('S','U'))");
  console.log("");
  console.log("Classificação inicial TipoDoc:");
  console.log("  7, 2 → VENDA             27, 104 → DEVOLUCAO_ANULACAO");
  console.log("  suspenso 107/102 pelo SINAL      ?   → recusado (listado em alerts)");
  console.log("");
  console.log("NÃO executa: chamadas SaaS, escrita em Neon, bootstrap real, sync.");
  console.log("");
  console.log("Mapping canónico: docs/spharm-erp-canonical-mapping.md §5.7");
}

// ─────────────────────────────────────────────────────────────────────
// Pipeline 1: PRODUTOS
// ─────────────────────────────────────────────────────────────────────

const STOCKS_REQUIRED_PRODUCTS = [
  "CodigoID",
  "Codigo",
  "Nome Comercial",
  "Preco Venda Publico_EUR",
  "Preco Medio Compra_EUR",
  "Preco Ultima Compra_EUR",
  "Data Ultima Venda",
  "Data Ultima Compra",
  "Retirado",
  "Generico",
  "MNSRM_NCompart",
  "Processa_Stocks",
];

async function runProductsPipeline(pool: SqlPool): Promise<{
  total: number;
  semStock: number;
  comStockNegativo: number;
  payloads: ProductPayload[];
}> {
  // Count
  const rTotal = await pool.request().query<{ n: number }>(`
    SELECT COUNT(*) AS n
    FROM [dbo].[Stocks] s
    WHERE s.[Retirado] = 0 AND s.[Processa_Stocks] <> 0
  `);
  const total = Number(rTotal.recordset[0]?.n ?? 0);

  // Quality: produtos sem stock row em ArmazensStocks
  const rSemStock = await pool.request().query<{ n: number }>(`
    SELECT COUNT(*) AS n
    FROM [dbo].[Stocks] s
    LEFT JOIN [dbo].[ArmazensStocks] ars ON ars.CodigoID = s.CodigoID
    WHERE s.[Retirado] = 0
      AND s.[Processa_Stocks] <> 0
      AND ars.CodigoID IS NULL
  `);
  const semStock = Number(rSemStock.recordset[0]?.n ?? 0);

  // Quality: produtos com algum stock negativo
  const rNeg = await pool.request().query<{ n: number }>(`
    SELECT COUNT(DISTINCT s.CodigoID) AS n
    FROM [dbo].[Stocks] s
    JOIN [dbo].[ArmazensStocks] ars ON ars.CodigoID = s.CodigoID
    WHERE s.[Retirado] = 0
      AND s.[Processa_Stocks] <> 0
      AND ars.[Existencia Actual] < 0
  `);
  const comStockNegativo = Number(rNeg.recordset[0]?.n ?? 0);

  // Sample TOP 10. OUTER APPLY pega no primeiro armazem (mais baixo
  // ArmazemID) para resolver "fornecedor habitual" como atributo de
  // produto, sem cartesian explosion.
  const rSample = await pool.request().query<{
    externalProductId: number;
    cnp: number | null;
    designacao: string | null;
    pvp: unknown;
    pmc: unknown;
    puc: unknown;
    dataUltimaVenda: Date | null;
    dataUltimaCompra: Date | null;
    retirado: unknown;
    generico: unknown;
    mnsrmNCompart: unknown;
    fornecedorHabitualId: number | null;
    fornecedorHabitualNome: string | null;
  }>(`
    SELECT TOP 10
      s.CodigoID                   AS externalProductId,
      s.[Codigo]                   AS cnp,
      s.[Nome Comercial]           AS designacao,
      s.[Preco Venda Publico_EUR]  AS pvp,
      s.[Preco Medio Compra_EUR]   AS pmc,
      s.[Preco Ultima Compra_EUR]  AS puc,
      s.[Data Ultima Venda]        AS dataUltimaVenda,
      s.[Data Ultima Compra]       AS dataUltimaCompra,
      s.[Retirado]                 AS retirado,
      s.[Generico]                 AS generico,
      s.[MNSRM_NCompart]           AS mnsrmNCompart,
      ars.[Fornecedor Habitual]    AS fornecedorHabitualId,
      f.[Nome Abreviado]           AS fornecedorHabitualNome
    FROM [dbo].[Stocks] s
    OUTER APPLY (
      SELECT TOP 1 [Fornecedor Habitual]
      FROM [dbo].[ArmazensStocks]
      WHERE CodigoID = s.CodigoID
      ORDER BY ArmazemID
    ) ars
    LEFT JOIN [dbo].[Fornecedores] f ON f.[Fornecedor ID] = ars.[Fornecedor Habitual]
    WHERE s.[Retirado] = 0
      AND s.[Processa_Stocks] <> 0
    ORDER BY s.[Data Ultima Venda] DESC, s.CodigoID
  `);

  const payloads: ProductPayload[] = rSample.recordset.map((r) => ({
    externalProductId: numOrNull(r.externalProductId),
    cnp: numOrNull(r.cnp),
    designacao: strOrNull(r.designacao),
    pvp: numOrNull(r.pvp),
    pmc: numOrNull(r.pmc),
    puc: numOrNull(r.puc),
    dataUltimaVenda: isoDateOrNull(r.dataUltimaVenda),
    dataUltimaCompra: isoDateOrNull(r.dataUltimaCompra),
    retirado: boolOrNull(r.retirado),
    generico: boolOrNull(r.generico),
    mnsrmNCompart: boolOrNull(r.mnsrmNCompart),
    fornecedorHabitualId: numOrNull(r.fornecedorHabitualId),
    fornecedorHabitualNome: strOrNull(r.fornecedorHabitualNome),
  }));

  return { total, semStock, comStockNegativo, payloads };
}

// ─────────────────────────────────────────────────────────────────────
// Pipeline 2: STOCK
// ─────────────────────────────────────────────────────────────────────

const ARS_REQUIRED = [
  "CodigoID",
  "ArmazemID",
  "Existencia Actual",
  "Stock Minimo",
  "Stock Maximo/Reposicao",
  "Existencia Encomenda",
  "Existencia Reserva",
];

async function runStockPipeline(pool: SqlPool): Promise<{
  total: number;
  negativos: number;
  payloads: StockPayload[];
}> {
  const rTotal = await pool.request().query<{ n: number }>(`
    SELECT COUNT(*) AS n
    FROM [dbo].[ArmazensStocks] ars
    JOIN [dbo].[Stocks] s ON s.CodigoID = ars.CodigoID
    WHERE s.[Retirado] = 0 AND s.[Processa_Stocks] <> 0
  `);
  const total = Number(rTotal.recordset[0]?.n ?? 0);

  const rNeg = await pool.request().query<{ n: number }>(`
    SELECT COUNT(*) AS n
    FROM [dbo].[ArmazensStocks] ars
    JOIN [dbo].[Stocks] s ON s.CodigoID = ars.CodigoID
    WHERE s.[Retirado] = 0
      AND s.[Processa_Stocks] <> 0
      AND ars.[Existencia Actual] < 0
  `);
  const negativos = Number(rNeg.recordset[0]?.n ?? 0);

  const rSample = await pool.request().query<{
    externalProductId: number;
    externalWarehouseId: number;
    stockAtual: unknown;
    stockMinimo: unknown;
    stockMaximo: unknown;
    stockEncomenda: unknown;
    stockReserva: unknown;
  }>(`
    SELECT TOP 10
      ars.CodigoID                   AS externalProductId,
      ars.ArmazemID                  AS externalWarehouseId,
      ars.[Existencia Actual]        AS stockAtual,
      ars.[Stock Minimo]             AS stockMinimo,
      ars.[Stock Maximo/Reposicao]   AS stockMaximo,
      ars.[Existencia Encomenda]     AS stockEncomenda,
      ars.[Existencia Reserva]       AS stockReserva
    FROM [dbo].[ArmazensStocks] ars
    JOIN [dbo].[Stocks] s ON s.CodigoID = ars.CodigoID
    WHERE s.[Retirado] = 0
      AND s.[Processa_Stocks] <> 0
    ORDER BY ars.[Existencia Actual] DESC, ars.CodigoID, ars.ArmazemID
  `);

  const payloads: StockPayload[] = rSample.recordset.map((r) => ({
    externalProductId: numOrNull(r.externalProductId),
    externalWarehouseId: numOrNull(r.externalWarehouseId),
    stockAtual: numOrNull(r.stockAtual),
    stockMinimo: numOrNull(r.stockMinimo),
    stockMaximo: numOrNull(r.stockMaximo),
    stockEncomenda: numOrNull(r.stockEncomenda),
    stockReserva: numOrNull(r.stockReserva),
  }));

  return { total, negativos, payloads };
}

// ─────────────────────────────────────────────────────────────────────
// Pipeline 3: VENDAS
// ─────────────────────────────────────────────────────────────────────

type TipoDocCombo = {
  TipoDoc: number | null;
  EntidadeID: number | null;
  Linhas: number;
  Atendimentos: number;
  SumValorLinha: unknown;
  SumPVPCalculado: unknown;
  SumComp: unknown;
};

type SalesAggregate = {
  totalLinhas: number;
  totalAtendimentos: number;
  sumValorLinha: number | null;
  sumPVPCalculado: number | null;
  sumComp: number | null;
};

async function runSalesPipeline(
  pool: SqlPool,
  fromDate: string,
  toDate: string
): Promise<{
  byCombo: TipoDocCombo[];
  agg: SalesAggregate;
  payloads: SaleLinePayload[];
  orphanProducts: number;
  unknownTipoDocs: Array<{ tipoDoc: number | null; linhas: number }>;
}> {
  const params = (req: sql.Request) =>
    req
      .input("from", sql.NVarChar, `${fromDate} 00:00:00`)
      .input("to", sql.NVarChar, `${toDate} 23:59:59`);

  // GROUP BY TipoDoc, EntidadeID — sem JOIN com Stocks (para contar TUDO,
  // incluindo orphans)
  const rCombo = await params(pool.request()).query<TipoDocCombo>(`
    SELECT
      a.[Tipo Documento]                                    AS TipoDoc,
      d.[Entidade ID]                                       AS EntidadeID,
      COUNT(*)                                              AS Linhas,
      COUNT(DISTINCT a.[Atendimento ID])                    AS Atendimentos,
      CAST(SUM(d.[Valor_EUR]) AS DECIMAL(18,2))             AS SumValorLinha,
      CAST(SUM(d.[Preco Venda Publico_EUR] * d.[Quantidade]) AS DECIMAL(18,2)) AS SumPVPCalculado,
      CAST(SUM(ISNULL(d.[PrComp_EUR],0) + ISNULL(d.[PrComp_EUR2],0)) AS DECIMAL(18,2)) AS SumComp
    FROM [dbo].[Atendimento] a
    JOIN [dbo].[Atendimento Detalhe] d ON d.[Atendimento ID] = a.[Atendimento ID]
    WHERE a.[Fim Venda] IN ('S', 'U')
      AND a.[Data Venda] BETWEEN @from AND @to
    GROUP BY a.[Tipo Documento], d.[Entidade ID]
    ORDER BY a.[Tipo Documento], d.[Entidade ID]
  `);

  // Aggregate global
  const rAgg = await params(pool.request()).query<{
    totalLinhas: number;
    totalAtendimentos: number;
    sumValorLinha: unknown;
    sumPVPCalculado: unknown;
    sumComp: unknown;
  }>(`
    SELECT
      COUNT(*)                                              AS totalLinhas,
      COUNT(DISTINCT a.[Atendimento ID])                    AS totalAtendimentos,
      CAST(SUM(d.[Valor_EUR]) AS DECIMAL(18,2))             AS sumValorLinha,
      CAST(SUM(d.[Preco Venda Publico_EUR] * d.[Quantidade]) AS DECIMAL(18,2)) AS sumPVPCalculado,
      CAST(SUM(ISNULL(d.[PrComp_EUR],0) + ISNULL(d.[PrComp_EUR2],0)) AS DECIMAL(18,2)) AS sumComp
    FROM [dbo].[Atendimento] a
    JOIN [dbo].[Atendimento Detalhe] d ON d.[Atendimento ID] = a.[Atendimento ID]
    WHERE a.[Fim Venda] IN ('S', 'U')
      AND a.[Data Venda] BETWEEN @from AND @to
  `);
  const aggRow = rAgg.recordset[0];
  const agg: SalesAggregate = {
    totalLinhas: Number(aggRow?.totalLinhas ?? 0),
    totalAtendimentos: Number(aggRow?.totalAtendimentos ?? 0),
    sumValorLinha: numOrNull(aggRow?.sumValorLinha),
    sumPVPCalculado: numOrNull(aggRow?.sumPVPCalculado),
    sumComp: numOrNull(aggRow?.sumComp),
  };

  // Sample TOP 20 linhas
  const rSample = await params(pool.request()).query<{
    externalSaleId: number;
    externalSaleLineId: number;
    dataVenda: Date | null;
    tipoDocumento: number | null;
    externalProductId: number;
    quantidade: unknown;
    pvpUnitario: unknown;
    valorLinha: unknown;
    ivaValor: unknown;
    descontoValor: unknown;
    comparticipacao1: unknown;
    comparticipacao2: unknown;
    entidadeId: number | null;
  }>(`
    SELECT TOP 20
      a.[Atendimento ID]            AS externalSaleId,
      d.[Detalhe ID]                AS externalSaleLineId,
      a.[Data Venda]                AS dataVenda,
      a.[Tipo Documento]            AS tipoDocumento,
      d.[CodigoID]                  AS externalProductId,
      d.[Quantidade]                AS quantidade,
      d.[Preco Venda Publico_EUR]   AS pvpUnitario,
      d.[Valor_EUR]                 AS valorLinha,
      d.[Val_IVA_EUR]               AS ivaValor,
      d.[Val_Desc_EUR]              AS descontoValor,
      d.[PrComp_EUR]                AS comparticipacao1,
      d.[PrComp_EUR2]               AS comparticipacao2,
      d.[Entidade ID]               AS entidadeId
    FROM [dbo].[Atendimento] a
    JOIN [dbo].[Atendimento Detalhe] d ON d.[Atendimento ID] = a.[Atendimento ID]
    WHERE a.[Fim Venda] IN ('S', 'U')
      AND a.[Data Venda] BETWEEN @from AND @to
    ORDER BY a.[Data Venda] DESC, a.[Atendimento ID], d.[Sequencia]
  `);

  const payloads: SaleLinePayload[] = rSample.recordset.map((r) => {
    const tipo = numOrNull(r.tipoDocumento);
    return {
      externalSaleId: numOrNull(r.externalSaleId),
      externalSaleLineId: numOrNull(r.externalSaleLineId),
      dataVenda: isoDateOrNull(r.dataVenda),
      tipoDocumento: tipo,
      tipoDocumentoClass: classifyTipoDoc(tipo, numOrNull(r.quantidade)),
      externalProductId: numOrNull(r.externalProductId),
      quantidade: numOrNull(r.quantidade),
      pvpUnitario: numOrNull(r.pvpUnitario),
      valorLinha: numOrNull(r.valorLinha),
      ivaValor: numOrNull(r.ivaValor),
      descontoValor: numOrNull(r.descontoValor),
      comparticipacao1: numOrNull(r.comparticipacao1),
      comparticipacao2: numOrNull(r.comparticipacao2),
      entidadeId: numOrNull(r.entidadeId),
    };
  });

  // Quality: orphan products (vendas com CodigoID que não existe em Stocks)
  const rOrphan = await params(pool.request()).query<{ n: number }>(`
    SELECT COUNT(*) AS n
    FROM [dbo].[Atendimento] a
    JOIN [dbo].[Atendimento Detalhe] d ON d.[Atendimento ID] = a.[Atendimento ID]
    LEFT JOIN [dbo].[Stocks] s ON s.CodigoID = d.[CodigoID]
    WHERE a.[Fim Venda] IN ('S', 'U')
      AND a.[Data Venda] BETWEEN @from AND @to
      AND s.CodigoID IS NULL
  `);
  const orphanProducts = Number(rOrphan.recordset[0]?.n ?? 0);

  // Quality: TipoDocs não classificados — fora dos tipos declarados em CLASSIFICACAO
  const rUnknown = await params(pool.request()).query<{ tipoDoc: number | null; linhas: number }>(`
    SELECT a.[Tipo Documento] AS tipoDoc, COUNT(*) AS linhas
    FROM [dbo].[Atendimento] a
    JOIN [dbo].[Atendimento Detalhe] d ON d.[Atendimento ID] = a.[Atendimento ID]
    WHERE a.[Fim Venda] IN ('S', 'U')
      AND a.[Data Venda] BETWEEN @from AND @to
      AND (a.[Tipo Documento] IS NULL OR a.[Tipo Documento] NOT IN (7, 2, 27, 104))
    GROUP BY a.[Tipo Documento]
    ORDER BY COUNT(*) DESC
  `);
  const unknownTipoDocs = rUnknown.recordset.map((r) => ({
    tipoDoc: numOrNull(r.tipoDoc),
    linhas: Number(r.linhas),
  }));

  return { byCombo: rCombo.recordset, agg, payloads, orphanProducts, unknownTipoDocs };
}

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────

export async function bootstrapDryRun(): Promise<number> {
  let args: Args;
  try {
    args = parseCmdArgs();
  } catch (err) {
    console.error("✗ Argumentos inválidos:", err instanceof Error ? err.message : err);
    console.error("");
    printHelp();
    return 1;
  }
  if (args.help) {
    printHelp();
    return 0;
  }

  if (!args.from || !args.to) {
    console.error("✗ --from e --to são obrigatórios (intervalo das vendas).");
    console.error("");
    printHelp();
    return 1;
  }

  let fromDate: string;
  let toDate: string;
  try {
    fromDate = parseDateArg("--from", args.from) as string;
    toDate = parseDateArg("--to", args.to) as string;
  } catch (err) {
    console.error("✗", err instanceof Error ? err.message : String(err));
    return 1;
  }
  if (fromDate > toDate) {
    console.error(`✗ --from (${fromDate}) é posterior a --to (${toDate}).`);
    return 1;
  }
  // Hoje ainda está aberto. Ver `guardaTemporal`.
  if (!aplicarGuardaTemporal(toDate, args.incluirHoje)) return 1;

  let cfg: AgentConfig;
  try {
    cfg = loadConfig("sql"); // SCOPE SQL — não pede credenciais SaaS
  } catch (err) {
    console.error("✗ Config inválida:");
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const t0 = Date.now();
  try {
    return await withPool(cfg, async (pool) => {
      // Schema check — falha-rápido com lista completa se alguma coluna desapareceu
      const [aCols, dCols, sCols, arsCols, fCols] = await Promise.all([
        listColumns(pool, { schema: "dbo", table: "Atendimento" }),
        listColumns(pool, { schema: "dbo", table: "Atendimento Detalhe" }),
        listColumns(pool, { schema: "dbo", table: "Stocks" }),
        listColumns(pool, { schema: "dbo", table: "ArmazensStocks" }),
        listColumns(pool, { schema: "dbo", table: "Fornecedores" }),
      ]);
      assertColumnsExist(
        aCols,
        ["Atendimento ID", "Data Venda", "Fim Venda", "Tipo Documento"],
        "dbo.Atendimento"
      );
      assertColumnsExist(
        dCols,
        [
          "Detalhe ID",
          "Sequencia",
          "Atendimento ID",
          "CodigoID",
          "Quantidade",
          "Preco Venda Publico_EUR",
          "Valor_EUR",
          "Val_IVA_EUR",
          "Val_Desc_EUR",
          "PrComp_EUR",
          "PrComp_EUR2",
          "Entidade ID",
        ],
        "dbo.Atendimento Detalhe"
      );
      assertColumnsExist(sCols, STOCKS_REQUIRED_PRODUCTS, "dbo.Stocks");
      assertColumnsExist(arsCols, ARS_REQUIRED, "dbo.ArmazensStocks");
      assertColumnsExist(fCols, ["Fornecedor ID", "Nome Abreviado"], "dbo.Fornecedores");

      // Header
      console.log(RULE);
      console.log(`bootstrap-dry-run — preview de payloads canónicos (SEM ingest)`);
      console.log(RULE);
      console.log(`Database         : ${cfg.sqlDatabase}@${cfg.sqlHost}:${cfg.sqlPort}`);
      console.log(`Intervalo vendas : ${fromDate} → ${toDate}`);
      console.log(`Filtro produtos  : [Retirado]=0 AND [Processa_Stocks]<>0`);
      console.log(`Filtro vendas    : [Fim Venda] IN ('S','U') AND [Data Venda] BETWEEN @from AND @to`);
      console.log("");

      // ── Pipeline 1: PRODUTOS
      console.log(DOUBLE_RULE);
      console.log(`▶ Pipeline 1: PRODUTOS`);
      console.log(DOUBLE_RULE);
      const products = await runProductsPipeline(pool);
      console.log(`Contagem total      : ${products.total} produtos elegíveis`);
      console.log("");
      console.log(`Quality alerts (produtos):`);
      console.log(`  · sem stock row em ArmazensStocks   : ${products.semStock}`);
      console.log(`  · com stock < 0 em algum armazém    : ${products.comStockNegativo}`);
      console.log("");
      console.log(`TOP 10 payloads (ordenados por [Data Ultima Venda] DESC):`);
      products.payloads.forEach((p, i) => {
        console.log(`  [${String(i + 1).padStart(2)}] ${JSON.stringify(p)}`);
      });
      console.log("");

      // ── Pipeline 2: STOCK
      console.log(DOUBLE_RULE);
      console.log(`▶ Pipeline 2: STOCK`);
      console.log(DOUBLE_RULE);
      const stocks = await runStockPipeline(pool);
      console.log(`Contagem total      : ${stocks.total} stock rows (após filtro Stocks)`);
      console.log("");
      console.log(`Quality alerts (stock):`);
      console.log(`  · rows com Existencia Actual < 0    : ${stocks.negativos}`);
      console.log("");
      console.log(`TOP 10 payloads (ordenados por [Existencia Actual] DESC):`);
      stocks.payloads.forEach((p, i) => {
        console.log(`  [${String(i + 1).padStart(2)}] ${JSON.stringify(p)}`);
      });
      console.log("");

      // ── Pipeline 3: VENDAS
      console.log(DOUBLE_RULE);
      console.log(`▶ Pipeline 3: VENDAS LINHA-A-LINHA`);
      console.log(DOUBLE_RULE);
      const sales = await runSalesPipeline(pool, fromDate, toDate);
      console.log(`Métricas agregadas (todas as linhas no intervalo):`);
      console.log(`  Total linhas        : ${sales.agg.totalLinhas}`);
      console.log(`  Total atendimentos  : ${sales.agg.totalAtendimentos}`);
      console.log(`  SUM(valorLinha)     : ${sales.agg.sumValorLinha ?? "—"} EUR`);
      console.log(`  SUM(pvp * qtd)      : ${sales.agg.sumPVPCalculado ?? "—"} EUR`);
      console.log(`  SUM(comp1 + comp2)  : ${sales.agg.sumComp ?? "—"} EUR`);
      console.log("");
      console.log(`Contagem por [Tipo Documento] × [Entidade ID]:`);
      if (sales.byCombo.length === 0) {
        console.log(`  (sem combos — verifica intervalo de datas)`);
      } else {
        console.log(
          renderSampleHorizontal(
            sales.byCombo as unknown[],
            [
              "TipoDoc",
              "EntidadeID",
              "Linhas",
              "Atendimentos",
              "SumValorLinha",
              "SumPVPCalculado",
              "SumComp",
            ]
          )
        );
      }
      console.log("");
      console.log(`Quality alerts (vendas):`);
      console.log(`  · linhas com produto não-encontrado em Stocks : ${sales.orphanProducts}`);
      if (sales.unknownTipoDocs.length === 0) {
        console.log(`  · TipoDocs desconhecidos (fora de 7/2/27/104)   : 0`);
      } else {
        console.log(`  · TipoDocs desconhecidos (fora de 7/2/27/104)   :`);
        for (const u of sales.unknownTipoDocs) {
          console.log(`      · TipoDoc ${u.tipoDoc ?? "(NULL)"} → ${u.linhas} linhas`);
        }
      }
      console.log("");
      console.log(`TOP 20 payloads (ordenados por [Data Venda] DESC, [Atendimento ID], [Sequencia]):`);
      sales.payloads.forEach((p, i) => {
        console.log(`  [${String(i + 1).padStart(2)}] ${JSON.stringify(p)}`);
      });
      console.log("");

      // Footer
      console.log(RULE);
      console.log(`✓ Dry-run concluído em ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
      console.log(`DRY-RUN — sem chamadas SaaS, sem escrita em Neon, sem bootstrap real.`);
      console.log(`Output stdout only. Copia os 3 blocos acima para reporting.`);
      return 0;
    });
  } catch (err) {
    console.error("\n✗ Falha no dry-run:");
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
