/**
 * agent/src/commands/compras.ts
 *
 * Fase 1b.5/1b.6: ingestão de COMPRAS (recepções de mercadoria) do
 * SPharm ERP para a SaaS staging table `StagingCompraRawLine`.
 *
 * Dois comandos exportados:
 *   · comprasDryRun — lê dbo.Recepcao + dbo.[Recepcao Detalhe]
 *                      read-only e imprime sumário + reconciliação +
 *                      orphans locais + TOP 10 amostra. SEM POST.
 *   · comprasUpload — lê + POST batched a /api/ingest/v1/bootstrap/compras.
 *                      Idempotente por (farmaciaId, externalLineId).
 *
 * Source query (idêntica nos dois comandos):
 *   SELECT r.[Recepcao ID], r.[Fornecedor ID], r.[Data Recepcao], ...,
 *          rd.[Detalhe  Recp ID], rd.[CodigoID], rd.[Quantidade], ...
 *   FROM [dbo].[Recepcao] r
 *   INNER JOIN [dbo].[Recepcao Detalhe] rd
 *     ON rd.[Recepcao ID] = r.[Recepcao ID]
 *   WHERE r.[RecepcaoSituacaoID] = 'N'
 *     AND r.[Data Recepcao] >= @from
 *     AND r.[Data Recepcao] <  @to
 *
 * Mapping validado em rev24:
 *   · Valor_EUR é UNITÁRIO (PVF c/desconto, sem IVA)
 *   · Total linha = Quantidade × Valor_EUR
 *   · PK linha = [Detalhe  Recp ID] (dois espaços, quirk Softreis)
 *   · Filtro RecepcaoSituacaoID='N' exclui anuladas + resumos
 *
 * Batch size default: 200 (override via --batch-size). HTTP timeout: 120s
 * (alinhado com bootstrap-upload pattern, evita 'AbortError' do rev25).
 */

import { parseArgs } from "node:util";
import sql from "mssql";
import { loadConfig, type AgentConfig } from "../config.js";
import { withPool, type SqlPool } from "../sql-client.js";
import { SaasClient, SaasApiError } from "../http-client.js";
import { parseDateArg } from "./probe-helpers.js";
import { janela } from "../janela.js";

const RULE = "─".repeat(70);
const DOUBLE_RULE = "═".repeat(70);
const DEFAULT_BATCH_SIZE = 200;
const BATCH_TIMEOUT_MS = 120_000;
const RECONCILIATION_TOLERANCE_EUR = 0.02;

// ── Row + payload types ─────────────────────────────────────────────

type CompraRow = {
  externalReceptionId: number;
  externalFornecedorId: number;
  dataRecepcao: Date | null;
  fornecedorData: Date | null;
  externalNRecepcao: number;
  externalFornecedorNDoc: string | null;
  externalTipoDocumentoId: number | null;
  recepcaoSituacaoId: string;
  armazemId: number;
  headerTotalBrutoEur: number | string;
  headerTotalIvaEur: number | string;
  headerTotalIncidenciaEur: number | string;
  externalLineId: number;
  sequencia: number | null;
  externalCodigoId: number;
  quantidade: number;
  bonus: number;
  iva: number | string;
  desconto: number | string | null;
  precoVendaPublicoEur: number | string;
  valorEurUnit: number | string;
  validade: Date | null;
};

type CompraPayload = {
  externalReceptionId: number;
  externalLineId: number;
  sequencia: number | null;
  externalNRecepcao: number;
  externalFornecedorId: number;
  externalTipoDocumentoId: number | null;
  externalFornecedorNDoc: string | null;
  dataRecepcao: string;
  fornecedorData: string | null;
  armazemId: number;
  recepcaoSituacaoId: string;
  headerTotalBrutoEur: number;
  headerTotalIvaEur: number;
  headerTotalIncidenciaEur: number;
  externalCodigoId: number;
  quantidade: number;
  bonus: number;
  iva: number;
  desconto: number | null;
  precoVendaPublicoEur: number;
  valorEurUnit: number;
  validade: string | null;
  ingestBatchId: string;
};

// ── Coerções ────────────────────────────────────────────────────────

function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === "" || s === "NULL" || s === "null") return null;
  return s;
}
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
function numOrZero(v: unknown): number {
  return numOrNull(v) ?? 0;
}
function isoDateOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  return null;
}

// ── Source query ────────────────────────────────────────────────────

const SOURCE_SQL = `
  SELECT
    r.[Recepcao ID]              AS externalReceptionId,
    r.[Fornecedor ID]            AS externalFornecedorId,
    r.[Data Recepcao]            AS dataRecepcao,
    r.[Fornecedor_Data]          AS fornecedorData,
    r.[NRecepcao]                AS externalNRecepcao,
    r.[Fornecedor_NDoc]          AS externalFornecedorNDoc,
    r.[FornecedorTipoDocumentoID] AS externalTipoDocumentoId,
    r.[RecepcaoSituacaoID]       AS recepcaoSituacaoId,
    r.[ArmazemID]                AS armazemId,
    r.[Total Bruto_EUR]          AS headerTotalBrutoEur,
    r.[Total IVA_EUR]            AS headerTotalIvaEur,
    r.[Total Incidencia_EUR]     AS headerTotalIncidenciaEur,
    rd.[Detalhe  Recp ID]        AS externalLineId,
    rd.[Sequencia]               AS sequencia,
    rd.[CodigoID]                AS externalCodigoId,
    rd.[Quantidade]              AS quantidade,
    rd.[Bonus]                   AS bonus,
    rd.[IVA]                     AS iva,
    rd.[Desconto]                AS desconto,
    rd.[Preco Venda Publico_EUR] AS precoVendaPublicoEur,
    rd.[Valor_EUR]               AS valorEurUnit,
    rd.[Validade]                AS validade
  FROM [dbo].[Recepcao] r
  INNER JOIN [dbo].[Recepcao Detalhe] rd ON rd.[Recepcao ID] = r.[Recepcao ID]
  WHERE r.[RecepcaoSituacaoID] = 'N'
    AND r.[Data Recepcao] >= @from
    AND r.[Data Recepcao] <  @to
  ORDER BY r.[Data Recepcao] ASC, rd.[Detalhe  Recp ID] ASC
`;

async function fetchCompras(pool: SqlPool, from: string, to: string): Promise<CompraRow[]> {
  const rs = await pool
    .request()
    .input("from", sql.NVarChar, janela(from, to).inicio)
    .input("to", sql.NVarChar, janela(from, to).fimExclusivo)
    .query<CompraRow>(SOURCE_SQL);
  return rs.recordset;
}

// ── Orphan checks locais (read-only, dbo.Stocks + dbo.Fornecedores) ──

async function countOrphansLocal(
  pool: SqlPool,
  from: string,
  to: string
): Promise<{ linesWithoutStocks: number; headersWithoutFornecedor: number }> {
  const rsLines = await pool
    .request()
    .input("from", sql.NVarChar, janela(from, to).inicio)
    .input("to", sql.NVarChar, janela(from, to).fimExclusivo)
    .query<{ cnt: number }>(`
      SELECT COUNT_BIG(*) AS cnt
      FROM [dbo].[Recepcao] r
      INNER JOIN [dbo].[Recepcao Detalhe] rd ON rd.[Recepcao ID] = r.[Recepcao ID]
      WHERE r.[RecepcaoSituacaoID] = 'N'
        AND r.[Data Recepcao] >= @from
        AND r.[Data Recepcao] <  @to
        AND NOT EXISTS (
          SELECT 1 FROM [dbo].[Stocks] s WHERE s.[CodigoID] = rd.[CodigoID]
        )
    `);
  const rsHeaders = await pool
    .request()
    .input("from", sql.NVarChar, janela(from, to).inicio)
    .input("to", sql.NVarChar, janela(from, to).fimExclusivo)
    .query<{ cnt: number }>(`
      SELECT COUNT_BIG(*) AS cnt
      FROM [dbo].[Recepcao] r
      WHERE r.[RecepcaoSituacaoID] = 'N'
        AND r.[Data Recepcao] >= @from
        AND r.[Data Recepcao] <  @to
        AND NOT EXISTS (
          SELECT 1 FROM [dbo].[Fornecedores] f WHERE f.[Fornecedor ID] = r.[Fornecedor ID]
        )
    `);
  return {
    linesWithoutStocks: Number(rsLines.recordset[0]?.cnt ?? 0),
    headersWithoutFornecedor: Number(rsHeaders.recordset[0]?.cnt ?? 0),
  };
}

// ── Payload + reconciliation ────────────────────────────────────────

function rowToPayload(row: CompraRow, ingestBatchId: string): CompraPayload | null {
  const externalLineId = numOrNull(row.externalLineId);
  const externalReceptionId = numOrNull(row.externalReceptionId);
  const dataRecepcao = isoDateOrNull(row.dataRecepcao);
  const externalCodigoId = numOrNull(row.externalCodigoId);
  const externalFornecedorId = numOrNull(row.externalFornecedorId);
  const externalNRecepcao = numOrNull(row.externalNRecepcao);
  const armazemId = numOrNull(row.armazemId);
  const quantidade = numOrNull(row.quantidade);
  const valorEurUnit = numOrNull(row.valorEurUnit);
  const headerTotalBrutoEur = numOrNull(row.headerTotalBrutoEur);
  const headerTotalIvaEur = numOrNull(row.headerTotalIvaEur);
  const headerTotalIncidenciaEur = numOrNull(row.headerTotalIncidenciaEur);
  if (
    externalLineId === null ||
    externalReceptionId === null ||
    dataRecepcao === null ||
    externalCodigoId === null ||
    externalFornecedorId === null ||
    externalNRecepcao === null ||
    armazemId === null ||
    quantidade === null ||
    valorEurUnit === null ||
    headerTotalBrutoEur === null ||
    headerTotalIvaEur === null ||
    headerTotalIncidenciaEur === null
  ) {
    return null;
  }
  return {
    externalReceptionId,
    externalLineId,
    sequencia: numOrNull(row.sequencia),
    externalNRecepcao,
    externalFornecedorId,
    externalTipoDocumentoId: numOrNull(row.externalTipoDocumentoId),
    externalFornecedorNDoc: strOrNull(row.externalFornecedorNDoc),
    dataRecepcao,
    fornecedorData: isoDateOrNull(row.fornecedorData),
    armazemId,
    recepcaoSituacaoId: strOrNull(row.recepcaoSituacaoId) ?? "N",
    headerTotalBrutoEur,
    headerTotalIvaEur,
    headerTotalIncidenciaEur,
    externalCodigoId,
    quantidade,
    bonus: numOrZero(row.bonus),
    iva: numOrZero(row.iva),
    desconto: numOrNull(row.desconto),
    precoVendaPublicoEur: numOrZero(row.precoVendaPublicoEur),
    valorEurUnit,
    validade: isoDateOrNull(row.validade),
    ingestBatchId,
  };
}

type HeaderRecon = {
  expected: number;
  computed: number;
  linesSeen: number;
};

function computeReconciliation(rows: CompraRow[]): Map<number, HeaderRecon> {
  const map = new Map<number, HeaderRecon>();
  for (const r of rows) {
    const recId = numOrNull(r.externalReceptionId);
    if (recId === null) continue;
    const qt = numOrNull(r.quantidade);
    const v = numOrNull(r.valorEurUnit);
    const exp = numOrNull(r.headerTotalIncidenciaEur);
    if (qt === null || v === null || exp === null) continue;
    const lineValue = qt * v;
    const prior = map.get(recId);
    if (prior) {
      prior.computed += lineValue;
      prior.linesSeen++;
    } else {
      map.set(recId, { expected: exp, computed: lineValue, linesSeen: 1 });
    }
  }
  return map;
}

// ── Resolver farmaciaId (DRY com bootstrap-upload + fornecedores) ──

async function resolveFarmaciaId(client: SaasClient, hint: string): Promise<string> {
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

function genBatchId(): string {
  const ts = Date.now().toString(36).padStart(8, "0");
  const r = Math.random().toString(36).slice(2, 10).padStart(8, "0");
  return `cmp-${ts}-${r}`;
}

// ── CLI parsing ─────────────────────────────────────────────────────

type Args = {
  from?: string;
  to?: string;
  batchSize?: number;
  help: boolean;
};

function parseCmdArgs(): Args {
  const raw = parseArgs({
    args: process.argv.slice(3),
    options: {
      from: { type: "string" },
      to: { type: "string" },
      "batch-size": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  const bs = typeof raw.values["batch-size"] === "string" ? Number(raw.values["batch-size"]) : undefined;
  return {
    from: typeof raw.values.from === "string" ? raw.values.from : undefined,
    to: typeof raw.values.to === "string" ? raw.values.to : undefined,
    batchSize: bs && Number.isFinite(bs) && bs > 0 ? bs : undefined,
    help: raw.values.help === true,
  };
}

function printDryRunHelp(): void {
  console.log("Uso: compras-dry-run --from YYYY-MM-DD --to YYYY-MM-DD");
  console.log("");
  console.log("Lê dbo.Recepcao + dbo.[Recepcao Detalhe] read-only.");
  console.log("Imprime sumário + reconciliação + orphans locais + TOP 10 amostra.");
  console.log("SEM POST. Validar antes de correr compras-upload.");
}

function printUploadHelp(): void {
  console.log("Uso: compras-upload --from YYYY-MM-DD --to YYYY-MM-DD [--batch-size 200]");
  console.log("");
  console.log("Lê dbo.Recepcao + dbo.[Recepcao Detalhe] e POSTa a");
  console.log("/api/ingest/v1/bootstrap/compras (StagingCompraRawLine).");
  console.log("Idempotente por (farmaciaId, externalLineId).");
  console.log("");
  console.log("Pré-requisitos:");
  console.log("  · compras-dry-run OK contra o mesmo intervalo");
  console.log("  · fornecedores-upload concluído (FornecedorErpRef populado)");
  console.log("  · ENABLE_AGENT_BOOTSTRAP=1 no SaaS");
  console.log("  · SPHARMMT_FARMACIA configurado");
}

// ── DRY-RUN ─────────────────────────────────────────────────────────

export async function comprasDryRun(): Promise<number> {
  let args: Args;
  try {
    args = parseCmdArgs();
  } catch (err) {
    console.error("✗ Argumentos inválidos:", err instanceof Error ? err.message : err);
    return 1;
  }
  if (args.help) {
    printDryRunHelp();
    return 0;
  }
  if (!args.from || !args.to) {
    console.error("✗ --from e --to são obrigatórios (YYYY-MM-DD).");
    printDryRunHelp();
    return 1;
  }
  let from: string;
  let to: string;
  try {
    from = parseDateArg("--from", args.from) as string;
    to = parseDateArg("--to", args.to) as string;
  } catch (err) {
    console.error("✗", err instanceof Error ? err.message : String(err));
    return 1;
  }
  if (from > to) {
    console.error(`✗ --from (${from}) é posterior a --to (${to}).`);
    return 1;
  }

  let cfg: AgentConfig;
  try {
    cfg = loadConfig("sql");
  } catch (err) {
    console.error("✗ Config inválida:", err instanceof Error ? err.message : String(err));
    return 1;
  }

  console.log(DOUBLE_RULE);
  console.log("compras-dry-run — read-only, sem POST");
  console.log(DOUBLE_RULE);
  console.log(`ERP database: ${cfg.sqlDatabase}@${cfg.sqlHost}:${cfg.sqlPort}`);
  console.log(`From        : ${from}`);
  console.log(`To          : ${to}`);
  console.log("");

  try {
    return await withPool(cfg, async (pool) => {
      console.log("▶ A ler dbo.Recepcao + dbo.[Recepcao Detalhe] ...");
      const rows = await fetchCompras(pool, from, to);
      console.log(`  ✓ ${rows.length} linhas lidas`);
      console.log("");

      // Aggregates
      const headers = new Set<number>();
      const fornecedores = new Set<number>();
      const produtos = new Set<number>();
      const tipoCounts = new Map<string, number>();
      const stateCounts = new Map<string, number>();
      let bonusLines = 0;
      for (const r of rows) {
        const recId = numOrNull(r.externalReceptionId);
        if (recId !== null) headers.add(recId);
        const fId = numOrNull(r.externalFornecedorId);
        if (fId !== null) fornecedores.add(fId);
        const cId = numOrNull(r.externalCodigoId);
        if (cId !== null) produtos.add(cId);
        const tipo = String(r.externalTipoDocumentoId ?? "(NULL)");
        tipoCounts.set(tipo, (tipoCounts.get(tipo) ?? 0) + 1);
        const state = String(r.recepcaoSituacaoId);
        stateCounts.set(state, (stateCounts.get(state) ?? 0) + 1);
        if (numOrZero(r.bonus) > 0) bonusLines++;
      }

      console.log("Sumário:");
      console.log(`  Headers (Recepcao)          : ${headers.size}`);
      console.log(`  Linhas total                 : ${rows.length}`);
      console.log(`  Fornecedores distintos       : ${fornecedores.size}`);
      console.log(`  Produtos distintos           : ${produtos.size}`);
      console.log(`  Linhas com Bonus > 0         : ${bonusLines}`);
      console.log("");

      console.log("Distribuição por estado (deveria ser 100% 'N'):");
      for (const [s, c] of Array.from(stateCounts.entries()).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${s.padEnd(4)} : ${c}`);
      }
      console.log("");

      console.log("Distribuição por Tipo Documento (FornecedorTipoDocumentoID):");
      for (const [t, c] of Array.from(tipoCounts.entries()).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${t.padEnd(8)} : ${c}`);
      }
      console.log("");

      // Reconciliação
      const recon = computeReconciliation(rows);
      let okHeaders = 0;
      const divergent: Array<{ recId: number; expected: number; computed: number; diff: number }> = [];
      for (const [recId, h] of recon) {
        const diff = Math.abs(h.expected - h.computed);
        if (diff > RECONCILIATION_TOLERANCE_EUR) {
          divergent.push({ recId, expected: h.expected, computed: h.computed, diff });
        } else {
          okHeaders++;
        }
      }
      divergent.sort((a, b) => b.diff - a.diff);
      console.log("Reconciliação per-header (SUM(qt × valorEurUnit) vs Total Incidencia_EUR):");
      console.log(`  Headers conferem         : ${okHeaders}`);
      console.log(`  Headers divergentes      : ${divergent.length}`);
      if (divergent.length > 0) {
        console.log(`  Top divergências (cap 10):`);
        for (const d of divergent.slice(0, 10)) {
          console.log(
            `    rec=${d.recId} expected=${d.expected.toFixed(2)} computed=${d.computed.toFixed(2)} diff=${d.diff.toFixed(2)}€`
          );
        }
      }
      console.log("");

      // Orphans locais (dbo.Stocks + dbo.Fornecedores)
      console.log("▶ Orphan checks locais (dbo.Stocks + dbo.Fornecedores) ...");
      const orphans = await countOrphansLocal(pool, from, to);
      console.log(`  Linhas sem dbo.Stocks       : ${orphans.linesWithoutStocks}`);
      console.log(`  Headers sem dbo.Fornecedores: ${orphans.headersWithoutFornecedor}`);
      console.log("");

      // TOP 10 amostras
      console.log("TOP 10 amostras (vertical):");
      console.log("");
      for (const r of rows.slice(0, 10)) {
        console.log(
          `  rec=${r.externalReceptionId} line=${r.externalLineId} cnp=${r.externalCodigoId} ` +
            `forn=${r.externalFornecedorId} qt=${r.quantidade} val=${r.valorEurUnit}€/u ` +
            `data=${r.dataRecepcao instanceof Date ? r.dataRecepcao.toISOString().slice(0, 10) : "?"}`
        );
      }
      console.log("");

      // Skipped previsão (rows que rowToPayload retornaria null)
      const skippedPreview = rows.filter((r) => rowToPayload(r, "preview") === null).length;
      if (skippedPreview > 0) {
        console.log(`⚠ ${skippedPreview} linhas seriam SKIPPED (campos obrigatórios em falta).`);
        console.log("");
      }

      const batchSize = args.batchSize ?? DEFAULT_BATCH_SIZE;
      const batches = Math.ceil(rows.length / batchSize);
      console.log(`Estimativa upload (batch-size ${batchSize}): ${batches} batch(es)`);
      console.log("");

      console.log(DOUBLE_RULE);
      console.log("Pronto para correr run-compras-upload.bat (mesmo intervalo).");
      console.log(DOUBLE_RULE);
      return 0;
    });
  } catch (err) {
    console.error("\n✗ Falha:", err instanceof Error ? err.message : String(err));
    return 1;
  }
}

// ── UPLOAD ──────────────────────────────────────────────────────────

type UploadTotals = {
  batches: number;
  read: number;
  accepted: number;
  upserted: number;
  created: number;
  updated: number;
  reconciliationWarnings: number;
  skipped: number;
  errors: number;
  durationMs: number;
};

export async function comprasUpload(): Promise<number> {
  let args: Args;
  try {
    args = parseCmdArgs();
  } catch (err) {
    console.error("✗ Argumentos inválidos:", err instanceof Error ? err.message : err);
    return 1;
  }
  if (args.help) {
    printUploadHelp();
    return 0;
  }
  if (!args.from || !args.to) {
    console.error("✗ --from e --to são obrigatórios (YYYY-MM-DD).");
    printUploadHelp();
    return 1;
  }
  let from: string;
  let to: string;
  try {
    from = parseDateArg("--from", args.from) as string;
    to = parseDateArg("--to", args.to) as string;
  } catch (err) {
    console.error("✗", err instanceof Error ? err.message : String(err));
    return 1;
  }
  if (from > to) {
    console.error(`✗ --from (${from}) é posterior a --to (${to}).`);
    return 1;
  }

  let cfg: AgentConfig;
  try {
    cfg = loadConfig("both");
  } catch (err) {
    console.error("✗ Config inválida:", err instanceof Error ? err.message : String(err));
    return 1;
  }
  if (!cfg.farmacia) {
    console.error("✗ SPHARMMT_FARMACIA não definido. Set no .env / agent.config.json.");
    return 1;
  }

  const batchSize = args.batchSize ?? DEFAULT_BATCH_SIZE;
  const client = new SaasClient(cfg);
  let farmaciaId: string;
  try {
    farmaciaId = await resolveFarmaciaId(client, cfg.farmacia);
  } catch (err) {
    console.error("✗ Resolução de farmácia falhou:", err instanceof Error ? err.message : String(err));
    return 1;
  }

  const ingestBatchId = genBatchId();
  console.log(RULE);
  console.log("compras-upload — Fase 1b.5 (idempotente)");
  console.log(RULE);
  console.log(`SaaS endpoint     : ${cfg.saasEndpoint}`);
  console.log(`Tenant slug       : ${cfg.tenantSlug}`);
  console.log(`Farmácia (resolved): ${farmaciaId}`);
  console.log(`ERP database      : ${cfg.sqlDatabase}@${cfg.sqlHost}:${cfg.sqlPort}`);
  console.log(`Intervalo         : ${from} → ${to}`);
  console.log(`Batch size        : ${batchSize}`);
  console.log(`Batch ID          : ${ingestBatchId}`);
  console.log("");

  try {
    return await withPool(cfg, async (pool) => {
      const rows = await fetchCompras(pool, from, to);
      console.log(`▶ ${rows.length} linhas lidas do ERP`);
      console.log("");

      const totals: UploadTotals = {
        batches: 0,
        read: rows.length,
        accepted: 0,
        upserted: 0,
        created: 0,
        updated: 0,
        reconciliationWarnings: 0,
        skipped: 0,
        errors: 0,
        durationMs: 0,
      };

      console.log(DOUBLE_RULE);
      console.log("▶ POST /api/ingest/v1/bootstrap/compras");
      console.log(DOUBLE_RULE);

      for (let offset = 0; offset < rows.length; offset += batchSize) {
        const chunk = rows.slice(offset, offset + batchSize);
        const items: CompraPayload[] = [];
        let localSkipped = 0;
        for (const r of chunk) {
          const p = rowToPayload(r, ingestBatchId);
          if (p === null) {
            localSkipped++;
            continue;
          }
          items.push(p);
        }
        if (items.length === 0) {
          totals.skipped += localSkipped;
          continue;
        }

        const batchT0 = Date.now();
        try {
          const response = await client.bootstrapCompras(
            { farmaciaId, items },
            BATCH_TIMEOUT_MS
          );
          const batchElapsedMs = Date.now() - batchT0;
          totals.batches++;
          totals.accepted += response.accepted;
          totals.upserted += response.upserted;
          totals.created += response.created;
          totals.updated += response.updated;
          totals.reconciliationWarnings += response.reconciliationWarnings;
          totals.skipped += response.skipped.length + localSkipped;
          totals.errors += response.errors.length;
          totals.durationMs += response.durationMs;

          console.log(
            `  batch ${totals.batches} (${batchElapsedMs}ms/${BATCH_TIMEOUT_MS}ms): ` +
              `read=${chunk.length} accepted=${response.accepted} ` +
              `c=${response.created} u=${response.updated} ` +
              `warn=${response.reconciliationWarnings} ` +
              `skipped=${response.skipped.length + localSkipped} errors=${response.errors.length}`
          );
          if (response.errors.length > 0) {
            for (const e of response.errors.slice(0, 3)) {
              console.log(`    ✗ idx=${e.index} ext=${e.externalId ?? "?"} ${e.reason}: ${e.message}`);
            }
          }
        } catch (err) {
          if (err instanceof SaasApiError) {
            console.error(`✗ HTTP ${err.statusCode} no batch offset=${offset}: ${err.bodySnippet ?? err.message}`);
          } else {
            console.error(`✗ Falha no batch offset=${offset}:`, err instanceof Error ? err.message : err);
          }
          return 1;
        }
      }

      console.log("");
      console.log(DOUBLE_RULE);
      console.log("RESUMO");
      console.log(DOUBLE_RULE);
      console.log(`  Batches enviados              : ${totals.batches}`);
      console.log(`  Linhas ERP lidas              : ${totals.read}`);
      console.log(`  Aceites pelo SaaS             : ${totals.accepted}`);
      console.log(`  Upserted (created+updated)    : ${totals.upserted}`);
      console.log(`    novos                       : ${totals.created}`);
      console.log(`    actualizados                : ${totals.updated}`);
      console.log(`  Reconciliation warnings       : ${totals.reconciliationWarnings}`);
      console.log(`  Skipped                       : ${totals.skipped}`);
      console.log(`  Errors                        : ${totals.errors}`);
      console.log(`  Tempo agregado SaaS           : ${totals.durationMs} ms`);
      console.log(`  Batch ID                      : ${ingestBatchId}`);
      if (totals.errors > 0) {
        console.log(`  ⚠ ${totals.errors} erros — ver detalhes acima. Staging pode estar inconsistente; aggregate-compras NÃO foi disparado.`);
        return 1;
      }

      // ── Catch-up automático: staging → Compra final ──────────────────
      // Mesma janela do upload, write=true, idempotente via ON CONFLICT.
      // Garante que após qualquer compras-upload bem sucedido o final está
      // alinhado com o staging — elimina o gap silencioso "operador correu
      // upload mas esqueceu de agregar". Falha visível: se aggregate falhar,
      // o comando termina com exit code 1.
      console.log("");
      console.log(DOUBLE_RULE);
      console.log("▶ A propagar staging → Compra (aggregate-compras automático)");
      console.log(DOUBLE_RULE);
      try {
        const agg = await client.pipelineAggregateCompras(
          { farmaciaId, from, to, write: true },
          180_000,
        );
        console.log(
          `  ✓ aggregate-compras OK: read=${agg.rawLinesRead} ` +
            `groups=${agg.candidateGroups} ` +
            `created=${agg.created ?? "?"} updated=${agg.updated ?? "?"} ` +
            `orphProd=${agg.orphanProducts.count} ` +
            `orphForn=${agg.orphanFornecedores.count} (${agg.durationMs}ms)`,
        );
      } catch (err) {
        if (err instanceof SaasApiError) {
          console.error(
            `✗ aggregate-compras HTTP ${err.statusCode}: ${err.bodySnippet ?? err.message}`,
          );
        } else {
          console.error(
            `✗ aggregate-compras falhou:`,
            err instanceof Error ? err.message : err,
          );
        }
        console.error(
          `  ⚠ Staging populada mas Compra final NÃO actualizada. Re-correr 'compras-upload' ` +
            `depois de corrigir, OU 'npx tsx scripts/admin/aggregate-compras-tenant.ts --tenant <slug> --from ${from} --to ${to}' do lado SaaS.`,
        );
        return 1;
      }
      return 0;
    });
  } catch (err) {
    console.error("\n✗ Falha:", err instanceof Error ? err.message : String(err));
    return 1;
  }
}
