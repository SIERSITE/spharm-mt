/**
 * agent/src/commands/daily-sync-runner.ts
 *
 * Core dos 3 pipelines de daily-sync (PRODUTOS / STOCK / SALES),
 * extraído para ser invocado tanto pela CLI `daily-sync` como pelo
 * orquestrador `daily-pipeline`.
 *
 * `runPipelineForDay()` recebe um pool SQL Server, um SaasClient
 * autenticado, a farmaciaId resolvida e a data alvo. Faz schema
 * detection, corre os 3 pipelines sequenciais (halt-on-error) e
 * devolve counts agregados sem console.log directo — o logger
 * passa como parâmetro recebe linhas formatadas.
 *
 * Nenhuma dependência de CLI args / dotenv / process.exit.
 */

import sql from "mssql";
import type { SqlPool } from "../sql-client.js";
import type { SaasClient } from "../http-client.js";
import type { BootstrapBatchResponse } from "../http-client.js";
import {
  NAMESPACES,
  descobrirSchemaAtendimento,
  descobrirCabecalhoSusp,
  descobrirSchemaSusp,
  normalizar,
  paraPayload,
  resumoSchema,
  sqlAtendimentoDetalhe,
  sqlAtendimentoSuspDetalhe,
  type FonteRow,
  type ResultadoFonte,
  type SourceNamespace,
} from "../vendas-fontes.js";

type SchemaProbeAPI = {
  tableExists: (
    pool: SqlPool,
    args: { schema: string; table: string }
  ) => Promise<boolean>;
  listColumns: (
    pool: SqlPool,
    args: { schema: string; table: string }
  ) => Promise<Array<{ name: string }>>;
};

export type DailySyncLogger = {
  log(line: string): void;
  raw(line: string): void;
};

export type PipelineRunCounts = {
  productsRead: number;
  productsUpserted: number;
  productsSkipped: number;
  productsErrors: number;
  stockRead: number;
  stockUpserted: number;
  stockErrors: number;
  salesRead: number;
  salesUpserted: number;
  salesSkipped: number;
  salesErrors: number;
  salesNonStockServices: number;
  salesOperationalOrphans: number;
};

const PRODUCTS_BATCH = 50;
const STOCK_BATCH = 100;
const SALES_BATCH = 200;
const BATCH_TIMEOUT_MS = 120_000;
const DOUBLE_RULE = "═".repeat(70);

// ─────────────────────────────────────────────────────────────────────
// Coerções
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
  return null;
}
function isoDateOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  return null;
}
// `classifyTipoDoc` saiu daqui. Eram dois numeros fixos — 77 e 104 — e
// tudo o resto virava "UNKNOWN", gravado e depois filtrado. A regra
// documental vive agora em `vendas-fontes.ts:classificarDocumento`, e o
// servidor pode ainda sobrepo-la por `TipoDocumentoClassificacao`.

// ─────────────────────────────────────────────────────────────────────
// Schema detection
// ─────────────────────────────────────────────────────────────────────

type SchemaCapabilities = {
  hasStocksMov: boolean;
  stocksMovDateCol: "DataMov" | null;
  hasDataActualiz: boolean;
};

async function detectCapabilities(pool: SqlPool, probes: SchemaProbeAPI): Promise<SchemaCapabilities> {
  const hasStocksMov = await probes.tableExists(pool, { schema: "dbo", table: "StocksMov" });
  let stocksMovDateCol: SchemaCapabilities["stocksMovDateCol"] = null;
  if (hasStocksMov) {
    const cols = await probes.listColumns(pool, { schema: "dbo", table: "StocksMov" });
    if (cols.some((c) => c.name === "DataMov")) {
      stocksMovDateCol = "DataMov";
    }
  }
  const stocksCols = await probes.listColumns(pool, { schema: "dbo", table: "Stocks" });
  const hasDataActualiz = stocksCols.some((c) => c.name === "Data_Actualiz");
  return { hasStocksMov, stocksMovDateCol, hasDataActualiz };
}

// ─────────────────────────────────────────────────────────────────────
// SQL builders
// ─────────────────────────────────────────────────────────────────────

function buildProductsSql(caps: SchemaCapabilities): string {
  const extraDateOr = caps.hasDataActualiz
    ? "\n    OR CAST(s.[Data_Actualiz] AS DATE) = @date"
    : "";
  return `
    SELECT TOP (@n)
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
      AND s.CodigoID > @lastId
      AND (
        CAST(s.[Data Ultima Venda] AS DATE) = @date
        OR CAST(s.[Data Ultima Compra] AS DATE) = @date${extraDateOr}
      )
    ORDER BY s.CodigoID
  `;
}

function buildStockSql(caps: SchemaCapabilities): string {
  if (!caps.hasStocksMov || !caps.stocksMovDateCol) {
    throw new Error(
      "dbo.StocksMov não disponível — sem fonte de incremental para stock."
    );
  }
  return `
    SELECT
      ars.CodigoID                AS externalProductId,
      ars.ArmazemID               AS externalWarehouseId,
      ars.[Existencia Actual]     AS stockAtual,
      ars.[Stock Minimo]          AS stockMinimo,
      ars.[Stock Maximo/Reposicao] AS stockMaximo,
      ars.[Existencia Encomenda]  AS stockEncomenda,
      ars.[Existencia Reserva]    AS stockReserva
    FROM [dbo].[ArmazensStocks] ars
    INNER JOIN (
      SELECT DISTINCT TOP (@n) sub_ars.CodigoID
      FROM [dbo].[ArmazensStocks] sub_ars
      JOIN [dbo].[Stocks] s ON s.CodigoID = sub_ars.CodigoID
      WHERE s.[Retirado] = 0
        AND s.[Processa_Stocks] <> 0
        AND sub_ars.CodigoID > @lastId
        AND EXISTS (
          SELECT 1
          FROM [dbo].[StocksMov] sm
          WHERE sm.CodigoID = sub_ars.CodigoID
            AND CAST(sm.[DataMov] AS DATE) = @date
        )
      ORDER BY sub_ars.CodigoID
    ) batch_codigos ON batch_codigos.CodigoID = ars.CodigoID
    JOIN [dbo].[Stocks] s ON s.CodigoID = ars.CodigoID
    WHERE s.[Retirado] = 0
      AND s.[Processa_Stocks] <> 0
    ORDER BY ars.CodigoID, ars.ArmazemID
  `;
}

// SALES_SQL saiu daqui. As duas fontes fisicas de uma venda — a venda
// de balcao e a venda suspensa — vivem em `agent/src/vendas-fontes.ts`,
// que as normaliza para o mesmo shape antes de qualquer POST. Ver o
// cabecalho desse ficheiro para o defeito que isto fecha.

// ─────────────────────────────────────────────────────────────────────
// Pipelines
// ─────────────────────────────────────────────────────────────────────

type ProductRow = {
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
};

function rowToProductPayload(r: ProductRow): Record<string, unknown> {
  return {
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
  };
}

async function pipelineProducts(
  pool: SqlPool,
  caps: SchemaCapabilities,
  client: SaasClient,
  farmaciaId: string,
  date: string,
  counts: PipelineRunCounts,
  logger: DailySyncLogger
): Promise<void> {
  const sqlText = buildProductsSql(caps);
  let lastId = -1;
  let batches = 0;
  logger.raw(DOUBLE_RULE);
  logger.log(`▶ Pipeline 1: PRODUTOS (batch=${PRODUCTS_BATCH})`);
  logger.raw(DOUBLE_RULE);

  while (true) {
    const rs = await pool
      .request()
      .input("lastId", sql.Int, lastId)
      .input("n", sql.Int, PRODUCTS_BATCH)
      .input("date", sql.NVarChar, date)
      .query<ProductRow>(sqlText);

    if (rs.recordset.length === 0) break;
    counts.productsRead += rs.recordset.length;
    const items = rs.recordset.map(rowToProductPayload);
    const response: BootstrapBatchResponse = await client.bootstrapProducts(
      { farmaciaId, items },
      BATCH_TIMEOUT_MS
    );
    counts.productsUpserted += response.upserted;
    counts.productsSkipped += response.skipped.length;
    counts.productsErrors += response.errors.length;
    batches++;
    logger.log(
      `  batch ${batches}: read=${rs.recordset.length} upserted=${response.upserted} skipped=${response.skipped.length} errors=${response.errors.length} (${response.durationMs}ms)`
    );
    const last = rs.recordset[rs.recordset.length - 1];
    if (last && typeof last.externalProductId === "number") lastId = last.externalProductId;
    if (rs.recordset.length < PRODUCTS_BATCH) break;
  }
}

type StockRow = {
  externalProductId: number;
  externalWarehouseId: number;
  stockAtual: unknown;
  stockMinimo: unknown;
  stockMaximo: unknown;
  stockEncomenda: unknown;
  stockReserva: unknown;
};

function rowToStockPayload(r: StockRow): Record<string, unknown> {
  return {
    externalProductId: numOrNull(r.externalProductId),
    externalWarehouseId: numOrNull(r.externalWarehouseId),
    stockAtual: numOrNull(r.stockAtual),
    stockMinimo: numOrNull(r.stockMinimo),
    stockMaximo: numOrNull(r.stockMaximo),
    stockEncomenda: numOrNull(r.stockEncomenda),
    stockReserva: numOrNull(r.stockReserva),
  };
}

async function pipelineStock(
  pool: SqlPool,
  caps: SchemaCapabilities,
  client: SaasClient,
  farmaciaId: string,
  date: string,
  counts: PipelineRunCounts,
  logger: DailySyncLogger
): Promise<void> {
  const sqlText = buildStockSql(caps);
  let lastId = -1;
  let batches = 0;
  logger.raw(DOUBLE_RULE);
  logger.log(`▶ Pipeline 2: STOCK (batch=${STOCK_BATCH}, filtro: StocksMov.DataMov=${date})`);
  logger.raw(DOUBLE_RULE);

  while (true) {
    const rs = await pool
      .request()
      .input("lastId", sql.Int, lastId)
      .input("n", sql.Int, STOCK_BATCH)
      .input("date", sql.NVarChar, date)
      .query<StockRow>(sqlText);

    if (rs.recordset.length === 0) break;
    counts.stockRead += rs.recordset.length;
    const items = rs.recordset.map(rowToStockPayload);
    const distinctProducts = new Set<number>();
    for (const r of rs.recordset) distinctProducts.add(r.externalProductId);
    const response = await client.bootstrapStock({ farmaciaId, items }, BATCH_TIMEOUT_MS);
    counts.stockUpserted += response.upserted;
    counts.stockErrors += response.errors.length;
    batches++;
    const aggregated = (response as { aggregated?: number }).aggregated ?? distinctProducts.size;
    logger.log(
      `  batch ${batches}: read=${rs.recordset.length} produtos=${distinctProducts.size} aggregated=${aggregated} upserted=${response.upserted} errors=${response.errors.length} (${response.durationMs}ms)`
    );
    const last = rs.recordset[rs.recordset.length - 1];
    if (last && typeof last.externalProductId === "number") lastId = last.externalProductId;
    if (distinctProducts.size < STOCK_BATCH) break;
  }
}

/**
 * As fontes de venda, por ordem. Cada uma tem o seu namespace e o seu
 * SQL; o resto do caminho e identico — mesma normalizacao, mesmo
 * payload, mesma idempotencia.
 *
 * A venda suspensa fica em ultimo por uma razao operacional: se a
 * descoberta de schema falhar nessa instalacao, o dia ja gravou as
 * vendas de balcao antes de o problema aparecer.
 */
type FonteVenda = {
  namespace: SourceNamespace;
  rotulo: string;
  sql: string | null;
};

async function pipelineSales(
  pool: SqlPool,
  client: SaasClient,
  farmaciaId: string,
  date: string,
  counts: PipelineRunCounts,
  logger: DailySyncLogger
): Promise<void> {
  logger.raw(DOUBLE_RULE);
  logger.log(`▶ Pipeline 3: SALES-LINES (batch=${SALES_BATCH}, [Data Venda]=${date})`);
  logger.raw(DOUBLE_RULE);

  // Descoberta dinamica: os nomes das colunas variam entre instalacoes
  // Softreis. Uma coluna que falte cai para NULL no SELECT em vez de
  // partir a query — mesmo padrao do stocksmov desde a rev32.
  const [at, susp, cab] = await Promise.all([
    descobrirSchemaAtendimento(pool),
    descobrirSchemaSusp(pool),
    descobrirCabecalhoSusp(pool),
  ]);
  for (const linha of resumoSchema(susp, at, cab)) logger.log(linha);

  const fontes: Array<{
    namespace: SourceNamespace;
    rotulo: string;
    fonte: ResultadoFonte;
  }> = [
    {
      namespace: NAMESPACES.ATENDIMENTO_DETALHE,
      rotulo: "Atendimento Detalhe",
      fonte: { estado: "PRONTA", sql: sqlAtendimentoDetalhe(at) },
    },
    {
      namespace: NAMESPACES.ATENDIMENTO_SUSP_DETALHE,
      rotulo: "Atendimento Susp Detalhe",
      fonte: sqlAtendimentoSuspDetalhe(susp, cab),
    },
  ];

  for (const f of fontes) {
    if (f.fonte.estado === "AUSENTE") {
      logger.log(`  ${f.rotulo}: tabela nao existe nesta instalacao — saltada`);
      continue;
    }
    if (f.fonte.estado === "POR_LIGAR") {
      // NAO se salta. A tabela existe, portanto ha vendas la dentro, e
      // ignora-las e o defeito que esta ronda veio corrigir.
      throw new Error(
        `${f.rotulo}: a tabela existe mas nao foi possivel liga-la. ` +
          `Faltam: ${f.fonte.faltam.join(", ")}. ` +
          `Corre 'agent -- vendas-suspensas-audit' para ver o schema real.`,
      );
    }
    await lerFonte(
      pool, client, farmaciaId, date,
      { namespace: f.namespace, rotulo: f.rotulo, sql: f.fonte.sql },
      counts, logger,
    );
  }
}

/** Le uma fonte de ponta a ponta, paginando por PK. */
async function lerFonte(
  pool: SqlPool,
  client: SaasClient,
  farmaciaId: string,
  date: string,
  fonte: FonteVenda,
  counts: PipelineRunCounts,
  logger: DailySyncLogger
): Promise<void> {
  let lastId = -1;
  let batches = 0;
  let porClassificar = 0;
  logger.log(`  ── ${fonte.rotulo} ──`);

  while (true) {
    const rs = await pool
      .request()
      .input("lastId", sql.Int, lastId)
      .input("n", sql.Int, SALES_BATCH)
      // Janela meio-aberta: >= inicio do dia, < inicio do dia seguinte.
      // `BETWEEN ... 23:59:59` perdia o ultimo segundo do dia.
      .input("from", sql.NVarChar, `${date} 00:00:00`)
      .input("to", sql.NVarChar, `${diaSeguinteIso(date)} 00:00:00`)
      .query<FonteRow>(fonte.sql!);

    if (rs.recordset.length === 0) break;
    counts.salesRead += rs.recordset.length;

    const items: Record<string, unknown>[] = [];
    for (const row of rs.recordset) {
      const r = normalizar(row, fonte.namespace);
      if ("erro" in r) {
        // Nao entra em silencio: uma linha por classificar e um erro de
        // ingestao, nao uma gaveta chamada UNKNOWN.
        porClassificar++;
        counts.salesSkipped++;
        if (porClassificar <= 5) {
          logger.log(`    ⚠ linha ${row.externalLineId} ignorada: ${r.erro}`);
        }
        continue;
      }
      items.push(paraPayload(r.linha));
    }

    if (items.length > 0) {
      const response = await client.bootstrapSalesLines(
        { farmaciaId, items },
        BATCH_TIMEOUT_MS
      );
      counts.salesUpserted += response.upserted;
      counts.salesSkipped += response.skipped.length;
      counts.salesErrors += response.errors.length;
      counts.salesNonStockServices += response.nonStockServiceLines ?? 0;
      counts.salesOperationalOrphans += response.operationalOrphans ?? 0;
      batches++;
      logger.log(
        `    batch ${batches}: read=${rs.recordset.length} upserted=${response.upserted} orphans=${response.orphanProductLines ?? 0} non_stock=${response.nonStockServiceLines ?? 0} errors=${response.errors.length} (${response.durationMs}ms)`
      );
    }

    const last = rs.recordset[rs.recordset.length - 1];
    if (last && typeof last.externalLineId === "number") lastId = last.externalLineId;
    if (rs.recordset.length < SALES_BATCH) break;
  }

  if (porClassificar > 0) {
    logger.log(
      `    ⚠ ${porClassificar} linha(s) por classificar em ${fonte.rotulo} — tipo de documento desconhecido`
    );
  }
}

/** Dia civil seguinte, para o `<` da janela meio-aberta. */
function diaSeguinteIso(dia: string): string {
  const [y, m, d] = dia.split("-").map((n) => parseInt(n, 10));
  return new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────
// Top-level runner
// ─────────────────────────────────────────────────────────────────────

export async function runPipelineForDay(opts: {
  pool: SqlPool;
  client: SaasClient;
  farmaciaId: string;
  date: string;
  schemaProbes: SchemaProbeAPI;
  logger: DailySyncLogger;
}): Promise<PipelineRunCounts> {
  const { pool, client, farmaciaId, date, schemaProbes, logger } = opts;
  const counts: PipelineRunCounts = {
    productsRead: 0, productsUpserted: 0, productsSkipped: 0, productsErrors: 0,
    stockRead: 0, stockUpserted: 0, stockErrors: 0,
    salesRead: 0, salesUpserted: 0, salesSkipped: 0, salesErrors: 0,
    salesNonStockServices: 0, salesOperationalOrphans: 0,
  };
  const caps = await detectCapabilities(pool, schemaProbes);
  logger.log(`Schema detection: StocksMov=${caps.hasStocksMov ? "✓" : "✗"}  Data_Actualiz=${caps.hasDataActualiz ? "✓" : "✗"}`);
  logger.raw("");
  if (!caps.hasStocksMov) {
    throw new Error("dbo.StocksMov é OBRIGATÓRIO para o pipeline de stock incremental.");
  }
  await pipelineProducts(pool, caps, client, farmaciaId, date, counts, logger);
  logger.raw("");
  await pipelineStock(pool, caps, client, farmaciaId, date, counts, logger);
  logger.raw("");
  await pipelineSales(pool, client, farmaciaId, date, counts, logger);
  return counts;
}
