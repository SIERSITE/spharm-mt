/**
 * agent/src/commands/daily-sync.ts
 *
 * Sync incremental diário: lê do ERP apenas as alterações do dia
 * indicado e POSTa para os **mesmos** endpoints
 * `/api/ingest/v1/bootstrap/*` que o bootstrap-upload usa.
 *
 * Reutilização: payload canónico igual, idempotência via mesmas
 * unique constraints (`Produto.cnp`, `(produtoId, farmaciaId)`,
 * `(farmaciaId, externalSaleLineId)`). Reupload de daily-sync para o
 * mesmo dia é seguro.
 *
 * Granularidade incremental por pipeline:
 *   · PRODUTOS — `Stocks.[Data Ultima Venda]` OR `[Data Ultima Compra]`
 *                = @date. Se `[Data_Actualiz]` existir, também incluí-lo
 *                (Softreis usa esta coluna em algumas versões; detect
 *                em runtime).
 *   · STOCK    — produtos com movimento em `dbo.StocksMov.[DataMov]` =
 *                @date. Para cada, re-fetch ArmazensStocks corrente
 *                (snapshot) — captura estado actual, não o delta.
 *   · VENDAS   — `Atendimento.[Data Venda]` no dia, `[Fim Venda]='S'`.
 *
 * Exports:
 *   · `dailySync()`        — runs SQL + POSTs (scope=both)
 *   · `dailySyncDryRun()`  — runs SQL + prints (scope=sql, sem POST)
 *
 * Garantias:
 *   · NÃO escreve em `Venda`, `VendaMensal`, `HistoricoStock`, etc.
 *   · NÃO altera loaders ou dashboard.
 *   · Idempotente: cron pode disparar 2× no mesmo dia sem corrupção.
 *   · Feature flag SaaS continua a ser `ENABLE_AGENT_BOOTSTRAP`
 *     (reusa endpoints, justificação em mapping doc §9).
 */

import { parseArgs } from "node:util";
import sql from "mssql";
import { loadConfig, type AgentConfig } from "../config.js";
import { withPool, type SqlPool } from "../sql-client.js";
import { SaasClient, SaasApiError, type BootstrapBatchResponse } from "../http-client.js";
import { parseDateArg, tableExists, listColumns } from "./probe-helpers.js";
import { janelaDoDia } from "../janela.js";

const RULE = "─".repeat(70);
const DOUBLE_RULE = "═".repeat(70);

// Mesmos batch sizes do bootstrap-upload rev8 — dimensionados para
// terminar < 30s por request no Vercel maxDuration=60s.
const PRODUCTS_BATCH = 50;
const STOCK_BATCH = 100;
const SALES_BATCH = 200;
const BATCH_TIMEOUT_MS = 120_000;

// ─────────────────────────────────────────────────────────────────────
// Coerções (idênticas a bootstrap-upload — duplicação intencional para
// keep this command self-contained)
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
function classifyTipoDoc(t: number | null): "VENDA" | "DEVOLUCAO_ANULACAO" | "UNKNOWN" {
  if (t === 77) return "VENDA";
  if (t === 104) return "DEVOLUCAO_ANULACAO";
  return "UNKNOWN";
}

// ─────────────────────────────────────────────────────────────────────
// Schema detection (StocksMov + Stocks.[Data_Actualiz])
// ─────────────────────────────────────────────────────────────────────

type SchemaCapabilities = {
  hasStocksMov: boolean;
  stocksMovDateCol: "DataMov" | null;
  hasDataActualiz: boolean;
};

async function detectCapabilities(pool: SqlPool): Promise<SchemaCapabilities> {
  const hasStocksMov = await tableExists(pool, { schema: "dbo", table: "StocksMov" });
  let stocksMovDateCol: SchemaCapabilities["stocksMovDateCol"] = null;
  if (hasStocksMov) {
    const cols = await listColumns(pool, { schema: "dbo", table: "StocksMov" });
    if (cols.some((c) => c.name === "DataMov")) {
      stocksMovDateCol = "DataMov";
    }
  }
  const stocksCols = await listColumns(pool, { schema: "dbo", table: "Stocks" });
  const hasDataActualiz = stocksCols.some((c) => c.name === "Data_Actualiz");
  return { hasStocksMov, stocksMovDateCol, hasDataActualiz };
}

// ─────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────

type Args = { date?: string; help?: boolean };

function parseCmdArgs(): Args {
  const raw = parseArgs({
    args: process.argv.slice(3),
    options: {
      date: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  return {
    date: typeof raw.values.date === "string" ? raw.values.date : undefined,
    help: raw.values.help === true,
  };
}

function printHelp(isDryRun: boolean): void {
  const name = isDryRun ? "daily-sync-dry-run" : "daily-sync";
  console.log(`Uso: ${name} --date YYYY-MM-DD`);
  console.log("");
  if (isDryRun) {
    console.log("DRY-RUN: lê o ERP e imprime contagens + amostras, SEM POST.");
  } else {
    console.log("Sync incremental: lê o ERP no dia e POSTa para /bootstrap/*.");
  }
  console.log("");
  console.log("Granularidade:");
  console.log("  · produtos — Stocks.[Data Ultima Venda] OU [Data Ultima Compra]");
  console.log("               (OU [Data_Actualiz] se existir)");
  console.log("  · stock    — produtos com StocksMov.[DataMov] no dia, snapshot ArmazensStocks");
  console.log("  · vendas   — Atendimento.[Data Venda] no dia, [Fim Venda]='S'");
  console.log("");
  console.log("Pré-requisitos:");
  if (!isDryRun) console.log("  · ENABLE_AGENT_BOOTSTRAP=1 no SaaS");
  if (!isDryRun) console.log("  · SPHARMMT_FARMACIA no agent.config.json");
  console.log("  · agent.config.json com credenciais SQL Server");
  console.log("");
  console.log("Idempotente: reupload do mesmo --date é seguro.");
  console.log("");
  console.log("Mapping canónico: docs/spharm-erp-canonical-mapping.md §9");
}

// ─────────────────────────────────────────────────────────────────────
// Pipeline result type
// ─────────────────────────────────────────────────────────────────────

type PipelineTotals = {
  batches: number;
  read: number;
  accepted: number;
  upserted: number;
  skipped: number;
  errors: number;
  durationMs: number;
};

function emptyTotals(): PipelineTotals {
  return { batches: 0, read: 0, accepted: 0, upserted: 0, skipped: 0, errors: 0, durationMs: 0 };
}

function accumulate(t: PipelineTotals, r: BootstrapBatchResponse): void {
  t.batches++;
  t.accepted += r.accepted;
  t.upserted += r.upserted;
  t.skipped += r.skipped.length;
  t.errors += r.errors.length;
  t.durationMs += r.durationMs;
}

function renderTotals(t: PipelineTotals): void {
  console.log(`  Batches enviados   : ${t.batches}`);
  console.log(`  Linhas ERP lidas   : ${t.read}`);
  console.log(`  Aceites pelo SaaS  : ${t.accepted}`);
  console.log(`  Upserted           : ${t.upserted}`);
  console.log(`  Skipped            : ${t.skipped}`);
  console.log(`  Errors             : ${t.errors}`);
  console.log(`  Tempo agregado SaaS: ${t.durationMs} ms`);
}

// ─────────────────────────────────────────────────────────────────────
// SQL builders
//
// SQL Server 2008 R2 compat: TOP N (não TOP @n via param), keyset
// pagination via @lastId, sem OFFSET/FETCH.
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
      "dbo.StocksMov não disponível — sem fonte de incremental para stock. " +
        "Fallback (snapshot completo) não implementado nesta versão. " +
        "Confirma dbo.StocksMov + coluna DataMov via probe-table."
    );
  }
  // Per-armazém: preserva externalWarehouseId (ars.ArmazemID) na linha
  // do payload. CRÍTICO: todos os armazéns do mesmo CodigoID têm de
  // ficar no MESMO batch HTTP — senão o SUM server-side por
  // externalProductId é parcial e o último batch sobrescreve com SUM
  // incompleto. Solução: subquery TOP N DISTINCT CodigoID + JOIN para
  // expandir.
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

const SALES_SQL = `
  SELECT TOP (@n)
    a.[Atendimento ID]            AS externalSaleId,
    d.[Detalhe ID]                AS externalSaleLineId,
    d.[Sequencia]                 AS sequencia,
    a.[Data Venda]                AS dataVenda,
    a.[Tipo Documento]            AS tipoDocumento,
    d.[CodigoID]                  AS externalProductId,
    s.[Processa_Stocks]           AS processaStocks,
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
  LEFT JOIN [dbo].[Stocks] s ON s.CodigoID = d.[CodigoID]
  WHERE a.[Fim Venda] = 'S'
    AND a.[Data Venda] >= @from
    AND a.[Data Venda] <  @to
    AND d.[Detalhe ID] > @lastId
  ORDER BY d.[Detalhe ID]
`;

// ─────────────────────────────────────────────────────────────────────
// Pipeline 1: PRODUTOS
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
  client: SaasClient | null,
  farmaciaId: string | null,
  date: string,
  samples: unknown[]
): Promise<PipelineTotals> {
  const totals = emptyTotals();
  const sqlText = buildProductsSql(caps);
  let lastId = -1;

  console.log(DOUBLE_RULE);
  console.log(`▶ Pipeline 1: PRODUTOS (batch=${PRODUCTS_BATCH}, ${client ? "POST" : "dry-run"})`);
  if (caps.hasDataActualiz) console.log("   filtro inclui [Data_Actualiz]");
  console.log(DOUBLE_RULE);

  while (true) {
    const rs = await pool
      .request()
      .input("lastId", sql.Int, lastId)
      .input("n", sql.Int, PRODUCTS_BATCH)
      .input("date", sql.NVarChar, date)
      .query<ProductRow>(sqlText);

    if (rs.recordset.length === 0) break;
    totals.read += rs.recordset.length;

    const items = rs.recordset.map(rowToProductPayload);

    if (client && farmaciaId) {
      const response = await client.bootstrapProducts({ farmaciaId, items }, BATCH_TIMEOUT_MS);
      accumulate(totals, response);
      console.log(
        `  batch ${totals.batches}: read=${rs.recordset.length} upserted=${response.upserted} skipped=${response.skipped.length} errors=${response.errors.length} (${response.durationMs}ms)`
      );
      for (const e of response.errors.slice(0, 3)) {
        console.log(`    ✗ idx=${e.index} ext=${e.externalId ?? "?"} ${e.reason}: ${e.message}`);
      }
    } else {
      // Dry-run: guarda primeiros 5 para imprimir no fim
      totals.batches++;
      if (samples.length < 5) {
        samples.push(...items.slice(0, 5 - samples.length));
      }
      console.log(`  batch ${totals.batches}: read=${rs.recordset.length} (sem POST)`);
    }

    const last = rs.recordset[rs.recordset.length - 1];
    if (last && typeof last.externalProductId === "number") lastId = last.externalProductId;
    if (rs.recordset.length < PRODUCTS_BATCH) break;
  }
  return totals;
}

// ─────────────────────────────────────────────────────────────────────
// Pipeline 2: STOCK
// ─────────────────────────────────────────────────────────────────────

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
  client: SaasClient | null,
  farmaciaId: string | null,
  date: string,
  samples: unknown[]
): Promise<PipelineTotals> {
  const totals = emptyTotals();
  const sqlText = buildStockSql(caps);
  let lastId = -1;

  console.log(DOUBLE_RULE);
  console.log(`▶ Pipeline 2: STOCK (batch=${STOCK_BATCH}, filtro: StocksMov.DataMov=${date})`);
  console.log(DOUBLE_RULE);

  while (true) {
    const rs = await pool
      .request()
      .input("lastId", sql.Int, lastId)
      .input("n", sql.Int, STOCK_BATCH)
      .input("date", sql.NVarChar, date)
      .query<StockRow>(sqlText);

    if (rs.recordset.length === 0) break;
    totals.read += rs.recordset.length;

    // Contar produtos distintos no batch — para detectar fim do keyset.
    // Linhas no batch >= produtos (N produtos × M armazéns).
    const distinctProducts = new Set<number>();
    for (const r of rs.recordset) distinctProducts.add(r.externalProductId);

    const items = rs.recordset.map(rowToStockPayload);

    if (client && farmaciaId) {
      const response = await client.bootstrapStock({ farmaciaId, items }, BATCH_TIMEOUT_MS);
      accumulate(totals, response);
      const aggregated = (response as { aggregated?: number }).aggregated ?? distinctProducts.size;
      console.log(
        `  batch ${totals.batches}: read=${rs.recordset.length} produtos=${distinctProducts.size} aggregated_server=${aggregated} upserted=${response.upserted} skipped=${response.skipped.length} errors=${response.errors.length} (${response.durationMs}ms)`
      );
    } else {
      totals.batches++;
      if (samples.length < 5) {
        samples.push(...items.slice(0, 5 - samples.length));
      }
      console.log(
        `  batch ${totals.batches}: read=${rs.recordset.length} (${distinctProducts.size} produtos × armazéns) (sem POST)`
      );
    }

    // Avançar keyset pelo último CodigoID. Como o batch contém TODAS as
    // linhas dos produtos seleccionados (subquery DISTINCT TOP N), o
    // último CodigoID na ordem é o limite seguro para o próximo batch.
    const last = rs.recordset[rs.recordset.length - 1];
    if (last && typeof last.externalProductId === "number") lastId = last.externalProductId;

    // Fim quando o batch trouxe MENOS produtos distintos que o limite.
    // (Não count rows — pode haver muitas linhas se produtos têm muitos
    // armazéns.)
    if (distinctProducts.size < STOCK_BATCH) break;
  }
  return totals;
}

// ─────────────────────────────────────────────────────────────────────
// Pipeline 3: SALES
// ─────────────────────────────────────────────────────────────────────

type SaleRow = {
  externalSaleId: number;
  externalSaleLineId: number;
  sequencia: number | null;
  dataVenda: Date | null;
  tipoDocumento: number | null;
  externalProductId: number;
  processaStocks: unknown;
  quantidade: unknown;
  pvpUnitario: unknown;
  valorLinha: unknown;
  ivaValor: unknown;
  descontoValor: unknown;
  comparticipacao1: unknown;
  comparticipacao2: unknown;
  entidadeId: number | null;
};

function rowToSalePayload(r: SaleRow): Record<string, unknown> {
  const tipo = numOrNull(r.tipoDocumento);
  return {
    externalSaleId: numOrNull(r.externalSaleId),
    externalSaleLineId: numOrNull(r.externalSaleLineId),
    sequencia: numOrNull(r.sequencia),
    dataVenda: isoDateOrNull(r.dataVenda),
    tipoDocumento: tipo,
    tipoDocumentoClass: classifyTipoDoc(tipo),
    externalProductId: numOrNull(r.externalProductId),
    processaStocks: boolOrNull(r.processaStocks),
    quantidade: numOrNull(r.quantidade),
    pvpUnitario: numOrNull(r.pvpUnitario),
    valorLinha: numOrNull(r.valorLinha),
    ivaValor: numOrNull(r.ivaValor),
    descontoValor: numOrNull(r.descontoValor),
    comparticipacao1: numOrNull(r.comparticipacao1),
    comparticipacao2: numOrNull(r.comparticipacao2),
    entidadeId: numOrNull(r.entidadeId),
  };
}

async function pipelineSales(
  pool: SqlPool,
  client: SaasClient | null,
  farmaciaId: string | null,
  date: string,
  samples: unknown[]
): Promise<PipelineTotals> {
  const totals = emptyTotals();
  let lastId = -1;

  console.log(DOUBLE_RULE);
  console.log(`▶ Pipeline 3: SALES-LINES (batch=${SALES_BATCH}, [Data Venda]=${date})`);
  console.log(DOUBLE_RULE);

  while (true) {
    const rs = await pool
      .request()
      .input("lastId", sql.Int, lastId)
      .input("n", sql.Int, SALES_BATCH)
      .input("from", sql.NVarChar, janelaDoDia(date).inicio)
      .input("to", sql.NVarChar, janelaDoDia(date).fimExclusivo)
      .query<SaleRow>(SALES_SQL);

    if (rs.recordset.length === 0) break;
    totals.read += rs.recordset.length;

    const items = rs.recordset.map(rowToSalePayload);

    if (client && farmaciaId) {
      const response = await client.bootstrapSalesLines({ farmaciaId, items }, BATCH_TIMEOUT_MS);
      accumulate(totals, response);
      const orphan = response.orphanProductLines ?? 0;
      console.log(
        `  batch ${totals.batches}: read=${rs.recordset.length} upserted=${response.upserted} orphans=${orphan} skipped=${response.skipped.length} errors=${response.errors.length} (${response.durationMs}ms)`
      );
    } else {
      totals.batches++;
      if (samples.length < 5) {
        samples.push(...items.slice(0, 5 - samples.length));
      }
      console.log(`  batch ${totals.batches}: read=${rs.recordset.length} (sem POST)`);
    }

    const last = rs.recordset[rs.recordset.length - 1];
    if (last && typeof last.externalSaleLineId === "number") lastId = last.externalSaleLineId;
    if (rs.recordset.length < SALES_BATCH) break;
  }
  return totals;
}

// ─────────────────────────────────────────────────────────────────────
// Resolução de farmaciaId via SaaS
// ─────────────────────────────────────────────────────────────────────

async function resolveFarmaciaId(client: SaasClient, hint: string): Promise<string> {
  const r = await client.listFarmacias(15_000);
  const isCuid = /^c[a-z0-9]{20,}$/i.test(hint);
  const match = isCuid
    ? r.farmacias.find((f) => f.id === hint)
    : r.farmacias.find((f) => f.nome.toLowerCase() === hint.toLowerCase());
  if (!match) {
    throw new Error(`Farmácia "${hint}" não encontrada no tenant.`);
  }
  if (match.estado !== "ATIVO") {
    throw new Error(`Farmácia "${match.nome}" inactiva (estado=${match.estado}).`);
  }
  return match.id;
}

// ─────────────────────────────────────────────────────────────────────
// Entrypoints
// ─────────────────────────────────────────────────────────────────────

type RunMode = "dry-run" | "write";

async function runCommon(mode: RunMode): Promise<number> {
  let args: Args;
  try {
    args = parseCmdArgs();
  } catch (err) {
    console.error("✗ Argumentos inválidos:", err instanceof Error ? err.message : err);
    printHelp(mode === "dry-run");
    return 1;
  }
  if (args.help) {
    printHelp(mode === "dry-run");
    return 0;
  }
  if (!args.date) {
    console.error("✗ --date é obrigatório (YYYY-MM-DD).");
    printHelp(mode === "dry-run");
    return 1;
  }

  let date: string;
  try {
    date = parseDateArg("--date", args.date) as string;
  } catch (err) {
    console.error("✗", err instanceof Error ? err.message : String(err));
    return 1;
  }

  let cfg: AgentConfig;
  try {
    cfg = loadConfig(mode === "write" ? "both" : "sql");
  } catch (err) {
    console.error("✗ Config inválida:");
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  let client: SaasClient | null = null;
  let farmaciaId: string | null = null;
  if (mode === "write") {
    if (!cfg.farmacia) {
      console.error("✗ SPHARMMT_FARMACIA não está definido.");
      return 1;
    }
    client = new SaasClient(cfg);
    try {
      farmaciaId = await resolveFarmaciaId(client, cfg.farmacia);
    } catch (err) {
      console.error("✗ Resolução de farmácia falhou:");
      console.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  const t0 = Date.now();
  console.log(RULE);
  console.log(`${mode === "dry-run" ? "daily-sync-dry-run" : "daily-sync"} — incremental ${date}`);
  console.log(RULE);
  console.log(`SaaS endpoint     : ${mode === "write" ? cfg.saasEndpoint : "(dry-run: sem POST)"}`);
  if (mode === "write") console.log(`Tenant slug       : ${cfg.tenantSlug}`);
  if (farmaciaId) console.log(`Farmácia          : ${farmaciaId}`);
  console.log(`ERP database      : ${cfg.sqlDatabase}@${cfg.sqlHost}:${cfg.sqlPort}`);
  console.log(`Dia               : ${date}`);
  console.log("");

  try {
    return await withPool(cfg, async (pool) => {
      const caps = await detectCapabilities(pool);
      console.log("Schema detection:");
      console.log(`  dbo.StocksMov                 : ${caps.hasStocksMov ? "✓" : "✗ NOT FOUND"}`);
      console.log(`  StocksMov.[DataMov]           : ${caps.stocksMovDateCol ? "✓" : "—"}`);
      console.log(`  Stocks.[Data_Actualiz]        : ${caps.hasDataActualiz ? "✓ (incluído no filtro de produtos)" : "— (omitido — filtra só por [Data Ultima Venda]/[Data Ultima Compra])"}`);
      console.log("");

      if (!caps.hasStocksMov) {
        console.error("✗ dbo.StocksMov é OBRIGATÓRIO para o pipeline de stock incremental.");
        console.error("  Sem esta tabela não temos como saber que produtos foram movimentados.");
        console.error("  Confirma via probe-table que dbo.StocksMov existe.");
        return 1;
      }

      const productSamples: unknown[] = [];
      const stockSamples: unknown[] = [];
      const salesSamples: unknown[] = [];

      const productsTotals = await pipelineProducts(pool, caps, client, farmaciaId, date, productSamples);
      console.log("");
      const stockTotals = await pipelineStock(pool, caps, client, farmaciaId, date, stockSamples);
      console.log("");
      const salesTotals = await pipelineSales(pool, client, farmaciaId, date, salesSamples);
      console.log("");

      console.log(DOUBLE_RULE);
      console.log(`RESUMO FINAL — ${mode === "dry-run" ? "DRY-RUN" : "DAILY-SYNC"} ${date}`);
      console.log(DOUBLE_RULE);
      console.log("");
      console.log("Pipeline PRODUTOS:");
      renderTotals(productsTotals);
      console.log("");
      console.log("Pipeline STOCK:");
      renderTotals(stockTotals);
      console.log("");
      console.log("Pipeline SALES-LINES:");
      renderTotals(salesTotals);
      console.log("");

      if (mode === "dry-run") {
        console.log("Amostras (até 5 por pipeline):");
        if (productSamples.length > 0) {
          console.log("");
          console.log("  PRODUTOS:");
          productSamples.forEach((p, i) =>
            console.log(`    [${i + 1}] ${JSON.stringify(p)}`)
          );
        }
        if (stockSamples.length > 0) {
          console.log("");
          console.log("  STOCK:");
          stockSamples.forEach((p, i) =>
            console.log(`    [${i + 1}] ${JSON.stringify(p)}`)
          );
        }
        if (salesSamples.length > 0) {
          console.log("");
          console.log("  SALES:");
          salesSamples.forEach((p, i) =>
            console.log(`    [${i + 1}] ${JSON.stringify(p)}`)
          );
        }
        console.log("");
      }

      const totalErrors = productsTotals.errors + stockTotals.errors + salesTotals.errors;
      const wallMs = Date.now() - t0;
      console.log(RULE);
      console.log(`Wall time         : ${(wallMs / 1000).toFixed(1)}s`);
      if (mode === "dry-run") {
        console.log(`✓ Dry-run concluído. Sem POSTs. Para escrever, corre 'daily-sync --date ${date}'.`);
        return 0;
      }
      if (totalErrors > 0) {
        console.error(`✗ daily-sync ${date} concluído com ${totalErrors} erros — ver detalhes acima. aggregate-month NÃO disparado.`);
        return 1;
      }

      // ── Catch-up automático: vendas raw → VendaMensal ───────────────
      // Após daily-sync de vendas para um dia, dispara aggregate-month
      // para o mês que contém esse dia. Idempotente (deleteMany+
      // createMany por mês). Garante alinhamento contínuo VendaMensal
      // ↔ IngestVendaLinhaRaw sem intervenção manual. Daily-sync corre
      // em cron — `allowOrphans/allowUnknowns=true` para não bloquear
      // por linhas individuais; gaps ficam visíveis na ficha (C4).
      const month = date.slice(0, 7); // "YYYY-MM-DD" → "YYYY-MM"
      console.log("");
      console.log(DOUBLE_RULE);
      console.log(`▶ A propagar vendas raw → VendaMensal (aggregate-month ${month})`);
      console.log(DOUBLE_RULE);
      // client é guaranteed non-null em mode==="write" (init em runCommon
      // condicionada por mode); chegámos aqui porque já passámos pelo
      // ramo dry-run que faz return 0.
      const writeClient = client!;
      try {
        const agg = await writeClient.pipelineAggregateMonth(
          { month, write: true, allowOrphans: true, allowUnknowns: true },
          120_000,
        );
        console.log(
          `  ✓ aggregate-month OK: month=${month} ` +
            `inserted=${agg.rowsInserted} deleted=${agg.rowsDeleted} ` +
            `(${agg.durationMs}ms)`,
        );
      } catch (err) {
        if (err instanceof SaasApiError) {
          console.error(
            `✗ aggregate-month HTTP ${err.statusCode}: ${err.bodySnippet ?? err.message}`,
          );
        } else {
          console.error(
            `✗ aggregate-month falhou:`,
            err instanceof Error ? err.message : err,
          );
        }
        console.error(
          `  ⚠ Vendas ingeridas mas VendaMensal NÃO actualizada para ${month}. ` +
            `Re-correr 'daily-sync --date ${date}' depois de corrigir, OU correr ` +
            `'npx tsx scripts/admin/aggregate-vendamensal-window.ts --tenant <slug> --from-month ${month} --to-month ${month} --write --allow-orphans --allow-unknowns'.`,
        );
        return 1;
      }
      console.log("");
      console.log(`✓ daily-sync ${date} concluído sem erros (catch-up VendaMensal incluído).`);
      return 0;
    });
  } catch (err) {
    console.error(`\n✗ Falha no ${mode === "dry-run" ? "dry-run" : "daily-sync"}:`);
    if (err instanceof SaasApiError) {
      console.error(`  SaaS ${err.method} ${err.path} → HTTP ${err.statusCode}`);
      if (err.bodySnippet) console.error(`  body: ${err.bodySnippet}`);
      if (err.statusCode === 503) {
        console.error(`  Hint: ENABLE_AGENT_BOOTSTRAP precisa estar a "1" no SaaS.`);
      }
    } else {
      console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    }
    return 1;
  }
}

export async function dailySync(): Promise<number> {
  return runCommon("write");
}

export async function dailySyncDryRun(): Promise<number> {
  return runCommon("dry-run");
}
