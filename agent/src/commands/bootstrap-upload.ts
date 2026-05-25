/**
 * agent/src/commands/bootstrap-upload.ts
 *
 * **PRIMEIRA INGESTÃO REAL** controlada para a SaaS. Lê o ERP local
 * read-only (mesmas tabelas que bootstrap-dry-run) e POSTa para
 * `/api/ingest/v1/bootstrap/*`. Idempotente — reupload do mesmo
 * intervalo produz o mesmo estado.
 *
 * **Pré-requisitos:**
 *   · `bootstrap-dry-run` validado contra o intervalo desejado
 *   · `ENABLE_AGENT_BOOTSTRAP=1` no SaaS (senão endpoints 503)
 *   · `SPHARMMT_FARMACIA` no .env / agent.config.json (cuid ou nome)
 *   · `test-connection` passa
 *
 * **Três pipelines sequenciais (halt-on-error):**
 *   1. products  — keyset por CodigoID, batch 200
 *   2. stock     — keyset por CodigoID c/ SUM agregado SQL-side, batch 200
 *   3. sales     — keyset por [Detalhe ID], batch 500
 *
 * Ordem importa: stock e sales precisam de produtos resolvíveis no
 * SaaS para evitar orphans. Halt-on-error garante que se products
 * falhar, não desperdiçamos chamadas dos pipelines seguintes.
 *
 * Output stdout: totais por pipeline + summary final.
 */

import { parseArgs } from "node:util";
import sql from "mssql";
import { loadConfig, type AgentConfig } from "../config.js";
import { withPool, type SqlPool } from "../sql-client.js";
import { SaasClient, SaasApiError, type BootstrapBatchResponse } from "../http-client.js";
import { parseDateArg } from "./probe-helpers.js";

const RULE = "─".repeat(70);
const DOUBLE_RULE = "═".repeat(70);

// Batch sizes dimensionados para terminar 1 request bem abaixo do
// `maxDuration=60s` do Vercel.
//
// Heurística observada na 1ª tentativa (rev7, batch=200): timeout no
// products. Cada item products faz 2 upserts (Produto + ProdutoFarmacia)
// — com 200 items × Neon cold-start, ultrapassou o tempo de resposta.
//
// rev8 reduz e diferencia por carga relativa de cada endpoint:
//   · products    — 2 upserts/item, mais pesado    → 50
//   · stock       — 1 upsert/item (+ lookup batch) → 100
//   · sales-lines — 1 upsert/item (+ lookup batch) → 200
const PRODUCTS_BATCH = 50;
const STOCK_BATCH = 100;
const SALES_BATCH = 200;

// HTTP timeout per batch — 120s dá folga para 60s de processamento
// server-side + latência + retry buffer. Fetch aborta antes só se
// Vercel ficar verdadeiramente preso.
const BATCH_TIMEOUT_MS = 120_000;

// ─────────────────────────────────────────────────────────────────────
// Tipos de payload (espelho dos canónicos SPharm.MT)
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

type SaleLinePayload = {
  externalSaleId: number | null;
  externalSaleLineId: number | null;
  sequencia: number | null;
  dataVenda: string | null;
  tipoDocumento: number | null;
  tipoDocumentoClass: "VENDA" | "DEVOLUCAO_ANULACAO" | "UNKNOWN";
  externalProductId: number | null;
  /// Softreis: Stocks.[Processa_Stocks] resolvido via LEFT JOIN em
  /// d.CodigoID. Null quando o produto não existe em dbo.Stocks (raro
  /// — poderia indicar produto apagado depois da venda). O server usa
  /// `processaStocks=false` para marcar `isNonStockService` quando o
  /// lookup ao Produto falha. Veja mapping doc §12.
  processaStocks: boolean | null;
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
// Coerções defensivas — mesmo padrão do bootstrap-dry-run
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
function classifyTipoDoc(t: number | null): SaleLinePayload["tipoDocumentoClass"] {
  if (t === 77) return "VENDA";
  if (t === 104) return "DEVOLUCAO_ANULACAO";
  return "UNKNOWN";
}

// ─────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────

type Args = {
  from?: string;
  to?: string;
  help?: boolean;
};

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

function printHelp(): void {
  console.log("Uso: bootstrap-upload --from YYYY-MM-DD --to YYYY-MM-DD");
  console.log("");
  console.log("PRIMEIRA INGESTÃO real para a SaaS. Idempotente.");
  console.log("");
  console.log("Pré-requisitos:");
  console.log("  · bootstrap-dry-run validado contra o intervalo");
  console.log("  · ENABLE_AGENT_BOOTSTRAP=1 no SaaS");
  console.log("  · SPHARMMT_FARMACIA no .env / agent.config.json");
  console.log("  · test-connection passa (SQL + SaaS)");
  console.log("");
  console.log("Pipelines sequenciais (halt-on-error):");
  console.log("  1. products  → /api/ingest/v1/bootstrap/products  (batch 200)");
  console.log("  2. stock     → /api/ingest/v1/bootstrap/stock     (batch 200)");
  console.log("  3. sales     → /api/ingest/v1/bootstrap/sales-lines (batch 500)");
  console.log("");
  console.log("Mapping canónico: docs/spharm-erp-canonical-mapping.md §8");
}

// ─────────────────────────────────────────────────────────────────────
// Pipeline counters
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

export function renderTotals(label: string, t: PipelineTotals): void {
  console.log(`  Batches enviados   : ${t.batches}`);
  console.log(`  Linhas ERP lidas   : ${t.read}`);
  console.log(`  Aceites pelo SaaS  : ${t.accepted}`);
  console.log(`  Upserted           : ${t.upserted}`);
  console.log(`  Skipped            : ${t.skipped}`);
  console.log(`  Errors             : ${t.errors}`);
  console.log(`  Tempo agregado SaaS: ${t.durationMs} ms`);
  if (t.errors > 0) console.log(`  ⚠ ${label}: ${t.errors} erros — ver detalhes acima`);
}

// ─────────────────────────────────────────────────────────────────────
// Pipeline 1: PRODUTOS — keyset por CodigoID
// ─────────────────────────────────────────────────────────────────────

export async function runProductsPipeline(
  pool: SqlPool,
  client: SaasClient,
  farmaciaId: string,
  opts?: { dryRun?: boolean }
): Promise<PipelineTotals> {
  const dryRun = opts?.dryRun === true;
  const totals = emptyTotals();
  let lastCodigoId = -1;
  console.log(DOUBLE_RULE);
  console.log(`▶ Pipeline 1: PRODUTOS (batch=${PRODUCTS_BATCH})${dryRun ? " [DRY-RUN]" : ""}`);
  console.log(DOUBLE_RULE);

  while (true) {
    const rs = await pool
      .request()
      .input("lastId", sql.Int, lastCodigoId)
      .input("n", sql.Int, PRODUCTS_BATCH)
      .query<{
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
        ORDER BY s.CodigoID
      `);

    if (rs.recordset.length === 0) break;
    totals.read += rs.recordset.length;

    const items: ProductPayload[] = rs.recordset.map((r) => ({
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

    if (dryRun) {
      totals.batches++;
      console.log(`  batch ${totals.batches} [dry-run]: read=${rs.recordset.length} payloads=${items.length} (não enviado)`);
    } else {
      const response = await client.bootstrapProducts({ farmaciaId, items }, BATCH_TIMEOUT_MS);
      accumulate(totals, response);
      console.log(
        `  batch ${totals.batches}: read=${rs.recordset.length} accepted=${response.accepted} upserted=${response.upserted} skipped=${response.skipped.length} errors=${response.errors.length}`
      );
      if (response.errors.length > 0) {
        for (const e of response.errors.slice(0, 3)) {
          console.log(`    ✗ idx=${e.index} ext=${e.externalId ?? "?"} ${e.reason}: ${e.message}`);
        }
      }
    }

    // Avançar keyset pelo último CodigoID lido (rows ordenados ASC)
    const last = rs.recordset[rs.recordset.length - 1];
    if (last && typeof last.externalProductId === "number") {
      lastCodigoId = last.externalProductId;
    }
    if (rs.recordset.length < PRODUCTS_BATCH) break;
  }
  return totals;
}

// ─────────────────────────────────────────────────────────────────────
// Pipeline 2: STOCK — SUM SQL-side agregado por CodigoID, keyset
// ─────────────────────────────────────────────────────────────────────

export async function runStockPipeline(
  pool: SqlPool,
  client: SaasClient,
  farmaciaId: string,
  opts?: { dryRun?: boolean }
): Promise<PipelineTotals> {
  const dryRun = opts?.dryRun === true;
  const totals = emptyTotals();
  let lastCodigoId = -1;
  console.log(DOUBLE_RULE);
  console.log(`▶ Pipeline 2: STOCK (batch=${STOCK_BATCH}, SUM por CodigoID)${dryRun ? " [DRY-RUN]" : ""}`);
  console.log(DOUBLE_RULE);

  while (true) {
    const rs = await pool
      .request()
      .input("lastId", sql.Int, lastCodigoId)
      .input("n", sql.Int, STOCK_BATCH)
      .query<{
        externalProductId: number;
        stockAtual: unknown;
        stockMinimo: unknown;
        stockMaximo: unknown;
        stockEncomenda: unknown;
        stockReserva: unknown;
      }>(`
        SELECT TOP (@n)
          ars.CodigoID                                                AS externalProductId,
          CAST(SUM(ars.[Existencia Actual]) AS DECIMAL(14,3))         AS stockAtual,
          CAST(SUM(ars.[Stock Minimo]) AS DECIMAL(14,3))              AS stockMinimo,
          CAST(SUM(ars.[Stock Maximo/Reposicao]) AS DECIMAL(14,3))    AS stockMaximo,
          CAST(SUM(ars.[Existencia Encomenda]) AS DECIMAL(14,3))      AS stockEncomenda,
          CAST(SUM(ars.[Existencia Reserva]) AS DECIMAL(14,3))        AS stockReserva
        FROM [dbo].[ArmazensStocks] ars
        JOIN [dbo].[Stocks] s ON s.CodigoID = ars.CodigoID
        WHERE s.[Retirado] = 0
          AND s.[Processa_Stocks] <> 0
          AND ars.CodigoID > @lastId
        GROUP BY ars.CodigoID
        ORDER BY ars.CodigoID
      `);

    if (rs.recordset.length === 0) break;
    totals.read += rs.recordset.length;

    const items: StockPayload[] = rs.recordset.map((r) => ({
      externalProductId: numOrNull(r.externalProductId),
      externalWarehouseId: null, // já agregado SQL-side
      stockAtual: numOrNull(r.stockAtual),
      stockMinimo: numOrNull(r.stockMinimo),
      stockMaximo: numOrNull(r.stockMaximo),
      stockEncomenda: numOrNull(r.stockEncomenda),
      stockReserva: numOrNull(r.stockReserva),
    }));

    if (dryRun) {
      totals.batches++;
      console.log(`  batch ${totals.batches} [dry-run]: read=${rs.recordset.length} payloads=${items.length} (não enviado)`);
    } else {
      const response = await client.bootstrapStock({ farmaciaId, items }, BATCH_TIMEOUT_MS);
      accumulate(totals, response);
      console.log(
        `  batch ${totals.batches}: read=${rs.recordset.length} accepted=${response.accepted} upserted=${response.upserted} skipped=${response.skipped.length} errors=${response.errors.length}`
      );
      if (response.errors.length > 0) {
        for (const e of response.errors.slice(0, 3)) {
          console.log(`    ✗ idx=${e.index} ext=${e.externalId ?? "?"} ${e.reason}: ${e.message}`);
        }
      }
    }

    const last = rs.recordset[rs.recordset.length - 1];
    if (last && typeof last.externalProductId === "number") {
      lastCodigoId = last.externalProductId;
    }
    if (rs.recordset.length < STOCK_BATCH) break;
  }
  return totals;
}

// ─────────────────────────────────────────────────────────────────────
// Pipeline 3: SALES-LINES — keyset por [Detalhe ID]
// ─────────────────────────────────────────────────────────────────────

export async function runSalesPipeline(
  pool: SqlPool,
  client: SaasClient,
  farmaciaId: string,
  fromDate: string,
  toDate: string,
  opts?: { dryRun?: boolean }
): Promise<PipelineTotals> {
  const dryRun = opts?.dryRun === true;
  const totals = emptyTotals();
  let lastDetalheId = -1;
  console.log(DOUBLE_RULE);
  console.log(`▶ Pipeline 3: SALES-LINES (batch=${SALES_BATCH}, intervalo ${fromDate} → ${toDate})${dryRun ? " [DRY-RUN]" : ""}`);
  console.log(DOUBLE_RULE);

  while (true) {
    const rs = await pool
      .request()
      .input("lastId", sql.Int, lastDetalheId)
      .input("n", sql.Int, SALES_BATCH)
      .input("from", sql.NVarChar, `${fromDate} 00:00:00`)
      .input("to", sql.NVarChar, `${toDate} 23:59:59`)
      .query<{
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
      }>(`
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
          AND a.[Data Venda] BETWEEN @from AND @to
          AND d.[Detalhe ID] > @lastId
        ORDER BY d.[Detalhe ID]
      `);

    if (rs.recordset.length === 0) break;
    totals.read += rs.recordset.length;

    const items: SaleLinePayload[] = rs.recordset.map((r) => {
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
    });

    if (dryRun) {
      totals.batches++;
      console.log(`  batch ${totals.batches} [dry-run]: read=${rs.recordset.length} payloads=${items.length} (não enviado)`);
    } else {
      const response = await client.bootstrapSalesLines({ farmaciaId, items }, BATCH_TIMEOUT_MS);
      accumulate(totals, response);
      const orphan = response.orphanProductLines ?? 0;
      console.log(
        `  batch ${totals.batches}: read=${rs.recordset.length} accepted=${response.accepted} upserted=${response.upserted} orphans=${orphan} skipped=${response.skipped.length} errors=${response.errors.length}`
      );
      if (response.errors.length > 0) {
        for (const e of response.errors.slice(0, 3)) {
          console.log(`    ✗ idx=${e.index} ext=${e.externalId ?? "?"} ${e.reason}: ${e.message}`);
        }
      }
    }

    const last = rs.recordset[rs.recordset.length - 1];
    if (last && typeof last.externalSaleLineId === "number") {
      lastDetalheId = last.externalSaleLineId;
    }
    if (rs.recordset.length < SALES_BATCH) break;
  }
  return totals;
}

// ─────────────────────────────────────────────────────────────────────
// Resolver farmaciaId via SaaS /api/ingest/v1/farmacias
// ─────────────────────────────────────────────────────────────────────

export async function resolveFarmaciaId(client: SaasClient, hint: string): Promise<string> {
  const r = await client.listFarmacias(15_000);
  const isCuid = /^c[a-z0-9]{20,}$/i.test(hint);
  const match = isCuid
    ? r.farmacias.find((f) => f.id === hint)
    : r.farmacias.find((f) => f.nome.toLowerCase() === hint.toLowerCase());
  if (!match) {
    throw new Error(
      `Farmácia "${hint}" não encontrada no tenant. ${r.farmacias.length} disponíveis: ` +
        r.farmacias.map((f) => f.nome).slice(0, 5).join(", ")
    );
  }
  if (match.estado !== "ATIVO") {
    throw new Error(`Farmácia "${match.nome}" está em estado ${match.estado}. Bootstrap recusa farmácias inactivas.`);
  }
  return match.id;
}

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────

export async function bootstrapUpload(): Promise<number> {
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
    console.error("✗ --from e --to são obrigatórios.");
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

  let cfg: AgentConfig;
  try {
    cfg = loadConfig("both"); // precisa SQL E SaaS
  } catch (err) {
    console.error("✗ Config inválida:");
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  if (!cfg.farmacia) {
    console.error("✗ SPHARMMT_FARMACIA não está definido.");
    console.error("  Configura no .env (ou agent.config.json em SaaS.farmacia) o cuid ou nome");
    console.error("  da farmácia que recebe o bootstrap.");
    return 1;
  }

  const client = new SaasClient(cfg);
  let farmaciaId: string;
  try {
    farmaciaId = await resolveFarmaciaId(client, cfg.farmacia);
  } catch (err) {
    console.error("✗ Resolução de farmácia falhou:");
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const t0 = Date.now();
  console.log(RULE);
  console.log("bootstrap-upload — 1ª ingestão real (idempotente)");
  console.log(RULE);
  console.log(`SaaS endpoint     : ${cfg.saasEndpoint}`);
  console.log(`Tenant slug       : ${cfg.tenantSlug}`);
  console.log(`Farmácia (resolved): ${farmaciaId}`);
  console.log(`ERP database      : ${cfg.sqlDatabase}@${cfg.sqlHost}:${cfg.sqlPort}`);
  console.log(`Intervalo vendas  : ${fromDate} → ${toDate}`);
  console.log("");

  try {
    return await withPool(cfg, async (pool) => {
      const productsTotals = await runProductsPipeline(pool, client, farmaciaId);
      console.log("");
      const stockTotals = await runStockPipeline(pool, client, farmaciaId);
      console.log("");
      const salesTotals = await runSalesPipeline(pool, client, farmaciaId, fromDate, toDate);
      console.log("");

      // ── Summary final
      console.log(DOUBLE_RULE);
      console.log("RESUMO FINAL");
      console.log(DOUBLE_RULE);
      console.log("");
      console.log("Pipeline PRODUTOS:");
      renderTotals("products", productsTotals);
      console.log("");
      console.log("Pipeline STOCK:");
      renderTotals("stock", stockTotals);
      console.log("");
      console.log("Pipeline SALES-LINES:");
      renderTotals("sales", salesTotals);
      console.log("");

      const totalErrors = productsTotals.errors + stockTotals.errors + salesTotals.errors;
      const wallMs = Date.now() - t0;
      console.log(RULE);
      console.log(`Wall time         : ${(wallMs / 1000).toFixed(1)}s`);
      if (totalErrors === 0) {
        console.log(`✓ Bootstrap concluído sem erros.`);
        return 0;
      }
      console.error(`✗ Bootstrap concluído com ${totalErrors} erros — ver detalhes acima.`);
      return 1;
    });
  } catch (err) {
    console.error("\n✗ Falha no bootstrap-upload:");
    if (err instanceof SaasApiError) {
      console.error(`  SaaS ${err.method} ${err.path} → HTTP ${err.statusCode}`);
      if (err.bodySnippet) console.error(`  body: ${err.bodySnippet}`);
      if (err.statusCode === 503) {
        console.error(`  Hint: ENABLE_AGENT_BOOTSTRAP precisa estar a "1" no ambiente SaaS.`);
      }
      if (err.statusCode === 401) {
        console.error(`  Hint: ingest key inválida ou tenant slug errado.`);
      }
    } else {
      console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    }
    return 1;
  }
}
