/**
 * agent/src/commands/devolucoes-fornecedor.ts
 *
 * Fase 1b: ingestão de DEVOLUÇÕES AO FORNECEDOR do SPharm ERP para a
 * SaaS staging table `StagingDevolucaoFornecedorRawLine`.
 *
 * Dois comandos exportados (espelho do compras.ts):
 *   · devolucoesFornecedorDryRun  — read-only, sem POST
 *   · devolucoesFornecedorUpload  — read + POST batched
 *
 * Source query (rev24 mapping validado):
 *   SELECT d.*, dd.*
 *   FROM [dbo].[Devolucao] d
 *   INNER JOIN [dbo].[Devolucao Detalhe] dd
 *     ON dd.[Devolucao ID] = d.[Devolucao ID]
 *   WHERE d.[DevolucaoSituacaoID] <> 'A'
 *     AND d.[Data Devolucao] >= @from
 *     AND d.[Data Devolucao] <  @to
 *
 * Diferenças críticas vs compras (rev24):
 *   · dbo.Devolucao SEMPRE AO fornecedor (FK declarada)
 *   · estados aceites: P / E / R / X (anuladas 'A' excluídas no SQL)
 *   · Valor (em Devolucao Detalhe) é TOTAL DA LINHA — soma directa
 *   · transição P → R muda quantidadeRecebida + devolucaoSituacaoId
 *
 * Idempotência: (farmaciaId, externalLineId). UPSERT captura P→R.
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

// ── Types ───────────────────────────────────────────────────────────

type DevolucaoRow = {
  externalDevolucaoId: number;
  externalFornecedorId: number;
  dataDevolucao: Date | null;
  externalNDevolucao: number;
  devolucaoSituacaoId: string;
  armazemId: number;
  observacoes: string | null;
  serieFacturacao: string | null;
  atcud: string | null;
  ncertAt: number | null;
  systemEntryDate: Date | null;
  headerTotalDocumento: number | string;
  headerTotalIvaEur: number | string;
  headerTotalIncidenciaEur: number | string;
  externalLineId: number;
  sequencia: number | null;
  externalCodigoId: number;
  quantidadeEnviada: number;
  quantidadeRecebida: number;
  bonus: number | null;
  motivoId: number | null;
  iva: number | string;
  precoVendaPublicoEur: number | string | null;
  pvfEurUnit: number | string | null;
  valorEurTotal: number | string | null;
  validade: Date | null;
  lote: string | null;
  recepcaoOrigemText: string | null;
  recepcaoOrigemData: Date | null;
};

type DevolucaoPayload = {
  externalDevolucaoId: number;
  externalLineId: number;
  sequencia: number | null;
  externalNDevolucao: number;
  externalFornecedorId: number;
  dataDevolucao: string;
  devolucaoSituacaoId: string;
  armazemId: number;
  observacoes: string | null;
  serieFacturacao: string | null;
  atcud: string | null;
  ncertAt: number | null;
  systemEntryDate: string | null;
  headerTotalDocumento: number;
  headerTotalIvaEur: number;
  headerTotalIncidenciaEur: number;
  externalCodigoId: number;
  quantidadeEnviada: number;
  quantidadeRecebida: number;
  bonus: number | null;
  motivoId: number | null;
  iva: number;
  precoVendaPublicoEur: number | null;
  pvfEurUnit: number | null;
  valorEurTotal: number | null;
  validade: string | null;
  lote: string | null;
  recepcaoOrigemText: string | null;
  recepcaoOrigemData: string | null;
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
    d.[Devolucao ID]             AS externalDevolucaoId,
    d.[Fornecedor ID]            AS externalFornecedorId,
    d.[Data Devolucao]           AS dataDevolucao,
    d.[N_Devolucao]              AS externalNDevolucao,
    d.[DevolucaoSituacaoID]      AS devolucaoSituacaoId,
    d.[ArmazemID]                AS armazemId,
    d.[Observacoes]              AS observacoes,
    d.[SerieFacturacao]          AS serieFacturacao,
    d.[ATCUD]                    AS atcud,
    d.[NCertAT]                  AS ncertAt,
    d.[SystemEntryDate]          AS systemEntryDate,
    d.[TotalDocumento]           AS headerTotalDocumento,
    d.[Total_IVA_EUR]            AS headerTotalIvaEur,
    d.[Total_Incidencia_EUR]     AS headerTotalIncidenciaEur,
    dd.[Devolucao Detalhe ID]    AS externalLineId,
    dd.[Sequencia]               AS sequencia,
    dd.[CodigoID]                AS externalCodigoId,
    dd.[Quantidade Enviada]      AS quantidadeEnviada,
    dd.[Quantidade Recebida]     AS quantidadeRecebida,
    dd.[Bonus]                   AS bonus,
    dd.[Motivo]                  AS motivoId,
    dd.[IVA]                     AS iva,
    dd.[PVP_EUR]                 AS precoVendaPublicoEur,
    dd.[PVF_EUR]                 AS pvfEurUnit,
    dd.[Valor]                   AS valorEurTotal,
    dd.[Validade]                AS validade,
    dd.[Lote]                    AS lote,
    dd.[Recepcao_Origem]         AS recepcaoOrigemText,
    dd.[Recepcao_Origem_Data]    AS recepcaoOrigemData
  FROM [dbo].[Devolucao] d
  INNER JOIN [dbo].[Devolucao Detalhe] dd ON dd.[Devolucao ID] = d.[Devolucao ID]
  WHERE d.[DevolucaoSituacaoID] <> 'A'
    AND d.[Data Devolucao] >= @from
    AND d.[Data Devolucao] <  @to
  ORDER BY d.[Data Devolucao] ASC, dd.[Devolucao Detalhe ID] ASC
`;

async function fetchDevolucoes(pool: SqlPool, from: string, to: string): Promise<DevolucaoRow[]> {
  const rs = await pool
    .request()
    .input("from", sql.NVarChar, janela(from, to).inicio)
    .input("to", sql.NVarChar, janela(from, to).fimExclusivo)
    .query<DevolucaoRow>(SOURCE_SQL);
  return rs.recordset;
}

// ── Orphan checks locais ────────────────────────────────────────────

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
      FROM [dbo].[Devolucao] d
      INNER JOIN [dbo].[Devolucao Detalhe] dd ON dd.[Devolucao ID] = d.[Devolucao ID]
      WHERE d.[DevolucaoSituacaoID] <> 'A'
        AND d.[Data Devolucao] >= @from
        AND d.[Data Devolucao] <  @to
        AND NOT EXISTS (
          SELECT 1 FROM [dbo].[Stocks] s WHERE s.[CodigoID] = dd.[CodigoID]
        )
    `);
  const rsHeaders = await pool
    .request()
    .input("from", sql.NVarChar, janela(from, to).inicio)
    .input("to", sql.NVarChar, janela(from, to).fimExclusivo)
    .query<{ cnt: number }>(`
      SELECT COUNT_BIG(*) AS cnt
      FROM [dbo].[Devolucao] d
      WHERE d.[DevolucaoSituacaoID] <> 'A'
        AND d.[Data Devolucao] >= @from
        AND d.[Data Devolucao] <  @to
        AND NOT EXISTS (
          SELECT 1 FROM [dbo].[Fornecedores] f WHERE f.[Fornecedor ID] = d.[Fornecedor ID]
        )
    `);
  return {
    linesWithoutStocks: Number(rsLines.recordset[0]?.cnt ?? 0),
    headersWithoutFornecedor: Number(rsHeaders.recordset[0]?.cnt ?? 0),
  };
}

// ── Payload + reconciliation ────────────────────────────────────────

function rowToPayload(row: DevolucaoRow, ingestBatchId: string): DevolucaoPayload | null {
  const externalLineId = numOrNull(row.externalLineId);
  const externalDevolucaoId = numOrNull(row.externalDevolucaoId);
  const dataDevolucao = isoDateOrNull(row.dataDevolucao);
  const externalCodigoId = numOrNull(row.externalCodigoId);
  const externalFornecedorId = numOrNull(row.externalFornecedorId);
  const externalNDevolucao = numOrNull(row.externalNDevolucao);
  const armazemId = numOrNull(row.armazemId);
  const quantidadeEnviada = numOrNull(row.quantidadeEnviada);
  const devolucaoSituacaoId = strOrNull(row.devolucaoSituacaoId);
  const headerTotalDocumento = numOrNull(row.headerTotalDocumento);
  const headerTotalIvaEur = numOrNull(row.headerTotalIvaEur);
  const headerTotalIncidenciaEur = numOrNull(row.headerTotalIncidenciaEur);
  if (
    externalLineId === null ||
    externalDevolucaoId === null ||
    dataDevolucao === null ||
    externalCodigoId === null ||
    externalFornecedorId === null ||
    externalNDevolucao === null ||
    armazemId === null ||
    quantidadeEnviada === null ||
    devolucaoSituacaoId === null ||
    headerTotalDocumento === null ||
    headerTotalIvaEur === null ||
    headerTotalIncidenciaEur === null
  ) {
    return null;
  }
  return {
    externalDevolucaoId,
    externalLineId,
    sequencia: numOrNull(row.sequencia),
    externalNDevolucao,
    externalFornecedorId,
    dataDevolucao,
    devolucaoSituacaoId,
    armazemId,
    observacoes: strOrNull(row.observacoes),
    serieFacturacao: strOrNull(row.serieFacturacao),
    atcud: strOrNull(row.atcud),
    ncertAt: numOrNull(row.ncertAt),
    systemEntryDate: isoDateOrNull(row.systemEntryDate),
    headerTotalDocumento,
    headerTotalIvaEur,
    headerTotalIncidenciaEur,
    externalCodigoId,
    quantidadeEnviada,
    quantidadeRecebida: numOrZero(row.quantidadeRecebida),
    bonus: numOrNull(row.bonus),
    motivoId: numOrNull(row.motivoId),
    iva: numOrZero(row.iva),
    precoVendaPublicoEur: numOrNull(row.precoVendaPublicoEur),
    pvfEurUnit: numOrNull(row.pvfEurUnit),
    valorEurTotal: numOrNull(row.valorEurTotal),
    validade: isoDateOrNull(row.validade),
    lote: strOrNull(row.lote),
    recepcaoOrigemText: strOrNull(row.recepcaoOrigemText),
    recepcaoOrigemData: isoDateOrNull(row.recepcaoOrigemData),
    ingestBatchId,
  };
}

type HeaderRecon = {
  expected: number;
  computed: number;
  linesSeen: number;
};

function computeReconciliation(rows: DevolucaoRow[]): Map<number, HeaderRecon> {
  const map = new Map<number, HeaderRecon>();
  for (const r of rows) {
    const devId = numOrNull(r.externalDevolucaoId);
    if (devId === null) continue;
    // Para devoluções, valorEurTotal é JÁ o total da linha — soma directa.
    const v = numOrNull(r.valorEurTotal) ?? 0;
    const exp = numOrNull(r.headerTotalIncidenciaEur);
    if (exp === null) continue;
    const prior = map.get(devId);
    if (prior) {
      prior.computed += v;
      prior.linesSeen++;
    } else {
      map.set(devId, { expected: exp, computed: v, linesSeen: 1 });
    }
  }
  return map;
}

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
  return `dev-${ts}-${r}`;
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
  console.log("Uso: devolucoes-fornecedor-dry-run --from YYYY-MM-DD --to YYYY-MM-DD");
  console.log("");
  console.log("Lê dbo.Devolucao + dbo.[Devolucao Detalhe] read-only.");
  console.log("Imprime: contagens, distribuição estados (P/E/R/X),");
  console.log("reconciliação, orphans locais, TOP 10 amostra. SEM POST.");
}

function printUploadHelp(): void {
  console.log("Uso: devolucoes-fornecedor-upload --from --to [--batch-size 200]");
  console.log("");
  console.log("POST batched a /api/ingest/v1/bootstrap/devolucoes-fornecedor");
  console.log("(StagingDevolucaoFornecedorRawLine). Idempotente.");
  console.log("");
  console.log("Pré-requisitos:");
  console.log("  · devolucoes-fornecedor-dry-run OK");
  console.log("  · fornecedores-upload concluído");
  console.log("  · ENABLE_AGENT_BOOTSTRAP=1");
}

// ── DRY-RUN ─────────────────────────────────────────────────────────

export async function devolucoesFornecedorDryRun(): Promise<number> {
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
  console.log("devolucoes-fornecedor-dry-run — read-only, sem POST");
  console.log(DOUBLE_RULE);
  console.log(`ERP database: ${cfg.sqlDatabase}@${cfg.sqlHost}:${cfg.sqlPort}`);
  console.log(`From        : ${from}`);
  console.log(`To          : ${to}`);
  console.log("");

  try {
    return await withPool(cfg, async (pool) => {
      console.log("▶ A ler dbo.Devolucao + dbo.[Devolucao Detalhe] ...");
      const rows = await fetchDevolucoes(pool, from, to);
      console.log(`  ✓ ${rows.length} linhas lidas`);
      console.log("");

      const headers = new Set<number>();
      const fornecedores = new Set<number>();
      const produtos = new Set<number>();
      const stateCounts = new Map<string, number>();
      let pendentesQtRecZero = 0;
      for (const r of rows) {
        const devId = numOrNull(r.externalDevolucaoId);
        if (devId !== null) headers.add(devId);
        const fId = numOrNull(r.externalFornecedorId);
        if (fId !== null) fornecedores.add(fId);
        const cId = numOrNull(r.externalCodigoId);
        if (cId !== null) produtos.add(cId);
        const state = String(r.devolucaoSituacaoId);
        stateCounts.set(state, (stateCounts.get(state) ?? 0) + 1);
        if (state === "P" && numOrZero(r.quantidadeRecebida) === 0) pendentesQtRecZero++;
      }

      console.log("Sumário:");
      console.log(`  Headers (Devolucao)         : ${headers.size}`);
      console.log(`  Linhas total                 : ${rows.length}`);
      console.log(`  Fornecedores distintos       : ${fornecedores.size}`);
      console.log(`  Produtos distintos           : ${produtos.size}`);
      console.log(`  Linhas P com QtRec=0         : ${pendentesQtRecZero}`);
      console.log("");

      console.log("Distribuição por estado (P/E/R/X — 'A' excluído no SQL):");
      for (const [s, c] of Array.from(stateCounts.entries()).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${s.padEnd(4)} : ${c}`);
      }
      console.log("");

      // Reconciliação
      const recon = computeReconciliation(rows);
      let okHeaders = 0;
      const divergent: Array<{ devId: number; expected: number; computed: number; diff: number }> = [];
      for (const [devId, h] of recon) {
        const diff = Math.abs(h.expected - h.computed);
        if (diff > RECONCILIATION_TOLERANCE_EUR) {
          divergent.push({ devId, expected: h.expected, computed: h.computed, diff });
        } else {
          okHeaders++;
        }
      }
      divergent.sort((a, b) => b.diff - a.diff);
      console.log("Reconciliação per-header (SUM(valorEurTotal) vs Total_Incidencia_EUR):");
      console.log(`  Headers conferem         : ${okHeaders}`);
      console.log(`  Headers divergentes      : ${divergent.length}`);
      if (divergent.length > 0) {
        console.log(`  Top divergências (cap 10):`);
        for (const d of divergent.slice(0, 10)) {
          console.log(
            `    dev=${d.devId} expected=${d.expected.toFixed(2)} computed=${d.computed.toFixed(2)} diff=${d.diff.toFixed(2)}€`
          );
        }
      }
      console.log("");

      // Orphans locais
      console.log("▶ Orphan checks locais (dbo.Stocks + dbo.Fornecedores) ...");
      const orphans = await countOrphansLocal(pool, from, to);
      console.log(`  Linhas sem dbo.Stocks       : ${orphans.linesWithoutStocks}`);
      console.log(`  Headers sem dbo.Fornecedores: ${orphans.headersWithoutFornecedor}`);
      console.log("");

      // TOP 10
      console.log("TOP 10 amostras (vertical):");
      console.log("");
      for (const r of rows.slice(0, 10)) {
        console.log(
          `  dev=${r.externalDevolucaoId} line=${r.externalLineId} cnp=${r.externalCodigoId} ` +
            `forn=${r.externalFornecedorId} qtEnv=${r.quantidadeEnviada} qtRec=${r.quantidadeRecebida} ` +
            `val=${r.valorEurTotal}€ state=${r.devolucaoSituacaoId} ` +
            `data=${r.dataDevolucao instanceof Date ? r.dataDevolucao.toISOString().slice(0, 10) : "?"}`
        );
      }
      console.log("");

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
      console.log("Pronto para correr run-devolucoes-fornecedor-upload.bat (mesmo intervalo).");
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
  byEstado: { P: number; E: number; R: number; X: number };
  skipped: number;
  errors: number;
  durationMs: number;
};

export async function devolucoesFornecedorUpload(): Promise<number> {
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
    console.error("✗ SPHARMMT_FARMACIA não definido.");
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
  console.log("devolucoes-fornecedor-upload — Fase 1b.6 (idempotente)");
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
      const rows = await fetchDevolucoes(pool, from, to);
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
        byEstado: { P: 0, E: 0, R: 0, X: 0 },
        skipped: 0,
        errors: 0,
        durationMs: 0,
      };

      console.log(DOUBLE_RULE);
      console.log("▶ POST /api/ingest/v1/bootstrap/devolucoes-fornecedor");
      console.log(DOUBLE_RULE);

      for (let offset = 0; offset < rows.length; offset += batchSize) {
        const chunk = rows.slice(offset, offset + batchSize);
        const items: DevolucaoPayload[] = [];
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
          const response = await client.bootstrapDevolucoesFornecedor(
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
          totals.byEstado.P += response.byEstado.P;
          totals.byEstado.E += response.byEstado.E;
          totals.byEstado.R += response.byEstado.R;
          totals.byEstado.X += response.byEstado.X;
          totals.skipped += response.skipped.length + localSkipped;
          totals.errors += response.errors.length;
          totals.durationMs += response.durationMs;

          console.log(
            `  batch ${totals.batches} (${batchElapsedMs}ms/${BATCH_TIMEOUT_MS}ms): ` +
              `read=${chunk.length} accepted=${response.accepted} ` +
              `c=${response.created} u=${response.updated} ` +
              `P=${response.byEstado.P} E=${response.byEstado.E} R=${response.byEstado.R} X=${response.byEstado.X} ` +
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
      console.log(`  Estados: P=${totals.byEstado.P} E=${totals.byEstado.E} R=${totals.byEstado.R} X=${totals.byEstado.X}`);
      console.log(`  Reconciliation warnings       : ${totals.reconciliationWarnings}`);
      console.log(`  Skipped                       : ${totals.skipped}`);
      console.log(`  Errors                        : ${totals.errors}`);
      console.log(`  Tempo agregado SaaS           : ${totals.durationMs} ms`);
      console.log(`  Batch ID                      : ${ingestBatchId}`);
      if (totals.errors > 0) {
        console.log(`  ⚠ ${totals.errors} erros — ver detalhes acima. Staging pode estar inconsistente; aggregate-devolucoes NÃO foi disparado.`);
        return 1;
      }

      // ── Catch-up automático: staging → Devolucao final ───────────────
      // Mesma janela do upload, write=true, idempotente via UPSERT em
      // (farmaciaId, externalLineId). Garante alinhamento após upload.
      // Pode devolver 404 not_implemented se o endpoint não existir no
      // SaaS (deploy mais antigo) — nesse caso reportamos como warning,
      // não como falha (o full-sync trata simetricamente).
      console.log("");
      console.log(DOUBLE_RULE);
      console.log("▶ A propagar staging → Devolucao (aggregate-devolucoes automático)");
      console.log(DOUBLE_RULE);
      try {
        const agg = await client.pipelineAggregateDevolucoes(
          { farmaciaId, from, to, write: true },
          180_000,
        );
        console.log(
          `  ✓ aggregate-devolucoes OK: read=${agg.rawLinesRead} ` +
            `excluded=${agg.excludedLineCount.total} cands=${agg.candidateLines} ` +
            `created=${agg.created ?? "?"} updated=${agg.updated ?? "?"} ` +
            `orphProd=${agg.orphanProducts.count} ` +
            `orphForn=${agg.orphanFornecedores.count} (${agg.durationMs}ms)`,
        );
      } catch (err) {
        if (err instanceof SaasApiError && err.statusCode === 404) {
          console.warn(
            `  ⚠ aggregate-devolucoes endpoint ausente no SaaS (deploy mais antigo). ` +
              `Staging populada, Devolucao final aguarda redeploy do SaaS. ` +
              `Re-correr 'devolucoes-fornecedor-upload' depois OU correr ` +
              `'npx tsx scripts/admin/aggregate-devolucoes-tenant.ts --tenant <slug> --from ${from} --to ${to}' do lado SaaS.`,
          );
          return 0; // upload OK; agg pendente é tratado como warning (full-sync compatibilidade)
        }
        if (err instanceof SaasApiError) {
          console.error(
            `✗ aggregate-devolucoes HTTP ${err.statusCode}: ${err.bodySnippet ?? err.message}`,
          );
        } else {
          console.error(
            `✗ aggregate-devolucoes falhou:`,
            err instanceof Error ? err.message : err,
          );
        }
        console.error(
          `  ⚠ Staging populada mas Devolucao final NÃO actualizada. Re-correr 'devolucoes-fornecedor-upload' ` +
            `depois de corrigir, OU 'npx tsx scripts/admin/aggregate-devolucoes-tenant.ts --tenant <slug> --from ${from} --to ${to}' do lado SaaS.`,
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
