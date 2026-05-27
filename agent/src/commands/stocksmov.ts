/**
 * agent/src/commands/stocksmov.ts
 *
 * Blocks B1 + B2 — ingestão canónica StocksMov → MovimentoArtigo.
 *
 * Dois comandos exportados:
 *   · stocksmovDryRun — SELECT + classifier local; sumário por tipo,
 *                       distribuição por motivo, listagem DESCONHECIDO,
 *                       sample. SEM POST.
 *   · stocksmovUpload — SELECT paginado por StocksMovID + POST batched
 *                       a /api/ingest/v1/movimentos. Idempotente por
 *                       (farmaciaId, externalMovId). Suporta --from/--to/
 *                       --since-id (catch-up automático).
 *
 * Source SQL (rev32 audit fechado):
 *   SELECT sm.* + JOINs Cab/Det/Motivo + Atendimento.[Tipo Documento]
 *   FROM dbo.StocksMov sm
 *   LEFT JOIN dbo.tblMovStocksDet det ON det.MovStocksDetID = sm.MovStocksDetID
 *   LEFT JOIN dbo.tblMovStocksCab cab ON cab.MovStocksCabID = det.MovStocksCabID
 *   LEFT JOIN dbo.tblMovStocksCab_Motivo mot ON mot.MovStocksCabMotivoID = cab.MovStocksCabMotivoID
 *   LEFT JOIN dbo.[Atendimento Detalhe] ad ON ad.[Detalhe ID] = sm.[Detalhe ID]
 *   LEFT JOIN dbo.Atendimento at ON at.[Atendimento ID] = ad.[Atendimento ID]
 *   WHERE sm.DataMov >= @from AND sm.DataMov < @to AND sm.StocksMovID > @sinceId
 *   ORDER BY sm.StocksMovID
 *
 * Paginação: StocksMovID > lastId, chunk 50k. Sem OFFSET/FETCH (não
 * escala em 2 M linhas). Sequência dentro do upload = StocksMovID ASC
 * → seguro para re-corrida.
 *
 * Batch HTTP: 500 (alinhado com endpoint hard limit). Timeout 120s/batch.
 *
 * Idempotência: re-run da mesma janela é UPDATE no canónico + INSERT
 * adicional no IngestStocksMovRaw quando ingestRunId muda (snapshot
 * histórico). Mesmo ingestRunId = UPDATE em ambas.
 */

import { parseArgs } from "node:util";
import sql from "mssql";
import { loadConfig, type AgentConfig } from "../config.js";
import { withPool, type SqlPool } from "../sql-client.js";
import { SaasClient, SaasApiError } from "../http-client.js";
import { parseDateArg } from "./probe-helpers.js";
import { classifyRaw, type RawStocksMovLine } from "../movimento-classifier.js";

const RULE = "─".repeat(70);
const DOUBLE_RULE = "═".repeat(70);
// rev35: default agressivamente baixo (100) — set-based UPSERT no endpoint
// processa 100 linhas em ~1 s; mantemos margem para tcp/cold-function start.
// Pode ser overridado via --batch-size para benchmarking, mas o auto-shrink
// reduz dinamicamente se algum batch dispara 504/503/502/timeout.
const DEFAULT_HTTP_BATCH = 100;
const MIN_HTTP_BATCH = 25;
const SQL_CHUNK_SIZE = 50_000;
// Server tem maxDuration=120s; agent espera até 180s para apanhar
// cold-starts + delay de rede.
const BATCH_TIMEOUT_MS = 180_000;
const MAX_RETRIES = 4;
const BACKOFF_BASE_MS = 1_000;

// ── Row + payload types ────────────────────────────────────────────

type StocksMovRow = {
  StocksMovID: number;
  CodigoID: number;
  DataMov: Date;
  Qtd: number;
  QtdBonus: number;
  Existencia: number;
  ValorCustoUnit: number | string;
  OldPMC: number | string;
  NovoPMC: number | string;
  StocksMovArmazemID: number;
  detalheId: number | null;
  suspDetalheId: number | null;
  creditoDetalheId: number | null;
  recpDetalheId: number | null;
  devolucaoDetalheId: number | null;
  MovStocksDetID: number | null;
  cabMovStocksCabID: number | null;
  cabTipoDocId: number | null;
  cabMotivoId: number | null;
  cabMotivoTexto: string | null;
  cabSituacao: string | null;
  cabUserId: number | null;
  cabPosto: number | null;
  cabNDocExterno: string | null;
  atendimentoId: number | null;
  atTipoDocId: number | null;
};

type MovimentoPayload = {
  externalMovId: number;
  externalProductId: string;
  dataMovimento: string;
  quantidade: number;
  quantidadeBonus: number;
  existenciaApos: number;
  custoUnitario: number;
  pmcAnterior: number;
  pmcNovo: number;
  armazemId: number;
  externalDetalheId: number | null;
  externalSuspDetalheId: number | null;
  externalCreditoDetalheId: number | null;
  externalRecpDetalheId: number | null;
  externalDevolucaoDetalheId: number | null;
  externalMovStocksDetId: number | null;
  movStocksCabId: number | null;
  movStocksCabTipoDocId: number | null;
  movStocksCabMotivoId: number | null;
  movStocksCabMotivoTexto: string | null;
  movStocksCabSituacao: string | null;
  movStocksCabUserId: number | null;
  movStocksCabPosto: number | null;
  movStocksCabNDocExterno: string | null;
  externalSaleId: number | null;
  tipoDocumentoId: number | null;
};

// ── Coerções ────────────────────────────────────────────────────────

function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === "" || s === "NULL" || s === "null") return null;
  return s;
}
// ── rev35 retry helpers ────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Devolve `true` para condições em que faz sentido re-tentar o mesmo
 * batch: gateway timeouts (504), bad gateway (502), service unavailable
 * (503), request timeout (408), too many requests (429), server error
 * (500), e erros de rede transientes (TCP reset, DNS, fetch aborted).
 * Devolve `false` para 4xx específicos (400/401/403/404/413/422) — o
 * batch tem que ser corrigido antes de re-tentar.
 */
function isTransientError(err: unknown): boolean {
  if (err instanceof SaasApiError) {
    return [408, 425, 429, 500, 502, 503, 504].includes(err.statusCode);
  }
  if (err instanceof Error) {
    return /falha de rede|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|aborted|socket hang up|fetch failed|timeout/i.test(
      err.message,
    );
  }
  return false;
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

// ── Source query (rev32 audit fechado, rev34 column names corrigidos) ─
//
// Naming quirks Softreis (validados rev32 audit + bootstrap-dry-run em prod):
//   · dbo.tblMovStocksCab.[Tipo Documento ID]   — COM "ID"
//   · dbo.Atendimento.[Tipo Documento]          — SEM "ID"
//   · dbo.[Atendimento Detalhe].[Detalhe ID]    — PK da tabela (não [Atendimento Detalhe ID])
//   · dbo.[Atendimento Detalhe].[Atendimento ID] — FK para Atendimento
//   · dbo.StocksMov.[Detalhe ID]                — FK para [Atendimento Detalhe].[Detalhe ID]
//   · dbo.StocksMov.[Detalhe  Recp ID]          — 2 espaços (preservar exactamente)

const SOURCE_SQL = `
  SELECT TOP (@limit)
    sm.StocksMovID,
    sm.CodigoID,
    sm.DataMov,
    sm.Qtd,
    sm.QtdBonus,
    sm.Existencia,
    sm.ValorCustoUnit,
    sm.OldPMC,
    sm.NovoPMC,
    sm.StocksMovArmazemID,
    sm.[Detalhe ID]                       AS detalheId,
    sm.[Atendimento Susp Detalhe ID]      AS suspDetalheId,
    sm.[Atendimento Credito Detalhe ID]   AS creditoDetalheId,
    sm.[Detalhe  Recp ID]                 AS recpDetalheId,
    sm.[Devolucao Detalhe ID]             AS devolucaoDetalheId,
    sm.MovStocksDetID,
    cab.MovStocksCabID                    AS cabMovStocksCabID,
    cab.[Tipo Documento ID]               AS cabTipoDocId,
    cab.MovStocksCabMotivoID              AS cabMotivoId,
    mot.Motivo                            AS cabMotivoTexto,
    cab.MovStocksCabSituacaoID            AS cabSituacao,
    cab.[User ID]                         AS cabUserId,
    cab.Posto                             AS cabPosto,
    cab.NDocExterno                       AS cabNDocExterno,
    ad.[Atendimento ID]                   AS atendimentoId,
    at_.[Tipo Documento]                  AS atTipoDocId
  FROM dbo.StocksMov sm
  LEFT JOIN dbo.tblMovStocksDet det
    ON det.MovStocksDetID = sm.MovStocksDetID
  LEFT JOIN dbo.tblMovStocksCab cab
    ON cab.MovStocksCabID = det.MovStocksCabID
  LEFT JOIN dbo.tblMovStocksCab_Motivo mot
    ON mot.MovStocksCabMotivoID = cab.MovStocksCabMotivoID
  LEFT JOIN dbo.[Atendimento Detalhe] ad
    ON ad.[Detalhe ID] = sm.[Detalhe ID]
  LEFT JOIN dbo.Atendimento at_
    ON at_.[Atendimento ID] = ad.[Atendimento ID]
  WHERE sm.DataMov >= @from
    AND sm.DataMov <  @to
    AND sm.StocksMovID > @sinceId
  ORDER BY sm.StocksMovID
`;

async function fetchPage(
  pool: SqlPool,
  from: string,
  to: string,
  sinceId: number,
  limit: number,
): Promise<StocksMovRow[]> {
  const rs = await pool
    .request()
    .input("from", sql.DateTime, new Date(`${from}T00:00:00Z`))
    .input("to", sql.DateTime, new Date(`${to}T00:00:00Z`))
    .input("sinceId", sql.Int, sinceId)
    .input("limit", sql.Int, limit)
    .query<StocksMovRow>(SOURCE_SQL);
  return rs.recordset;
}

// ── Row → classifier input + payload ────────────────────────────────

function rowToRaw(r: StocksMovRow): RawStocksMovLine {
  return {
    detalheId: numOrNull(r.detalheId),
    suspDetalheId: numOrNull(r.suspDetalheId),
    creditoDetalheId: numOrNull(r.creditoDetalheId),
    recpDetalheId: numOrNull(r.recpDetalheId),
    devolucaoDetalheId: numOrNull(r.devolucaoDetalheId),
    movStocksDetId: numOrNull(r.MovStocksDetID),
    atendimentoTipoDocId: numOrNull(r.atTipoDocId),
    motivoTexto: strOrNull(r.cabMotivoTexto),
    cabTipoDocId: numOrNull(r.cabTipoDocId),
    qtd: numOrNull(r.Qtd) ?? 0,
  };
}

function rowToPayload(r: StocksMovRow): MovimentoPayload | null {
  const externalMovId = numOrNull(r.StocksMovID);
  const externalProductId = numOrNull(r.CodigoID);
  if (externalMovId === null || externalProductId === null) return null;
  if (!(r.DataMov instanceof Date) || Number.isNaN(r.DataMov.getTime())) return null;
  return {
    externalMovId,
    externalProductId: String(externalProductId),
    dataMovimento: r.DataMov.toISOString(),
    quantidade: numOrNull(r.Qtd) ?? 0,
    quantidadeBonus: numOrNull(r.QtdBonus) ?? 0,
    existenciaApos: numOrNull(r.Existencia) ?? 0,
    custoUnitario: numOrNull(r.ValorCustoUnit) ?? 0,
    pmcAnterior: numOrNull(r.OldPMC) ?? 0,
    pmcNovo: numOrNull(r.NovoPMC) ?? 0,
    armazemId: numOrNull(r.StocksMovArmazemID) ?? 1,
    externalDetalheId: numOrNull(r.detalheId),
    externalSuspDetalheId: numOrNull(r.suspDetalheId),
    externalCreditoDetalheId: numOrNull(r.creditoDetalheId),
    externalRecpDetalheId: numOrNull(r.recpDetalheId),
    externalDevolucaoDetalheId: numOrNull(r.devolucaoDetalheId),
    externalMovStocksDetId: numOrNull(r.MovStocksDetID),
    movStocksCabId: numOrNull(r.cabMovStocksCabID),
    movStocksCabTipoDocId: numOrNull(r.cabTipoDocId),
    movStocksCabMotivoId: numOrNull(r.cabMotivoId),
    movStocksCabMotivoTexto: strOrNull(r.cabMotivoTexto),
    movStocksCabSituacao: strOrNull(r.cabSituacao),
    movStocksCabUserId: numOrNull(r.cabUserId),
    movStocksCabPosto: numOrNull(r.cabPosto),
    movStocksCabNDocExterno: strOrNull(r.cabNDocExterno),
    externalSaleId: numOrNull(r.atendimentoId),
    tipoDocumentoId: numOrNull(r.atTipoDocId),
  };
}

// ── Farmacia resolution (DRY) ──────────────────────────────────────

async function resolveFarmaciaId(client: SaasClient, hint: string): Promise<string> {
  const r = await client.listFarmacias(15_000);
  const isCuid = /^c[a-z0-9]{20,}$/i.test(hint);
  const match = isCuid
    ? r.farmacias.find((f) => f.id === hint)
    : r.farmacias.find((f) => f.nome.toLowerCase() === hint.toLowerCase());
  if (!match) {
    throw new Error(
      `Farmácia "${hint}" não encontrada no tenant. ${r.farmacias.length} disponíveis: ` +
        r.farmacias.map((f) => f.nome).slice(0, 5).join(", "),
    );
  }
  if (match.estado !== "ATIVO") {
    throw new Error(`Farmácia "${match.nome}" está em estado ${match.estado}.`);
  }
  return match.id;
}

function genRunId(): string {
  const ts = Date.now().toString(36).padStart(8, "0");
  const r = Math.random().toString(36).slice(2, 10).padStart(8, "0");
  return `mov-${ts}-${r}`;
}

// ── CLI parsing ─────────────────────────────────────────────────────

type Args = {
  from?: string;
  to?: string;
  sinceId?: number;
  batchSize?: number;
  help: boolean;
};

function parseCmdArgs(): Args {
  const raw = parseArgs({
    args: process.argv.slice(3),
    options: {
      from: { type: "string" },
      to: { type: "string" },
      "since-id": { type: "string" },
      "batch-size": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  const bs = typeof raw.values["batch-size"] === "string" ? Number(raw.values["batch-size"]) : undefined;
  const si = typeof raw.values["since-id"] === "string" ? Number(raw.values["since-id"]) : undefined;
  return {
    from: typeof raw.values.from === "string" ? raw.values.from : undefined,
    to: typeof raw.values.to === "string" ? raw.values.to : undefined,
    sinceId: si !== undefined && Number.isFinite(si) && si >= 0 ? si : undefined,
    batchSize: bs && Number.isFinite(bs) && bs > 0 ? bs : undefined,
    help: raw.values.help === true,
  };
}

function printDryRunHelp(): void {
  console.log("Uso: stocksmov-dry-run --from YYYY-MM-DD --to YYYY-MM-DD [--since-id N]");
  console.log("");
  console.log("Lê dbo.StocksMov + JOINs (Cab/Det/Motivo/Atendimento) read-only.");
  console.log("Classifica localmente via lib/movimento-classifier.");
  console.log("Imprime sumário por tipo, top motivos, lista DESCONHECIDO, sample. SEM POST.");
}

function printUploadHelp(): void {
  console.log(
    "Uso: stocksmov-upload --from YYYY-MM-DD --to YYYY-MM-DD [--since-id N] [--batch-size 100]",
  );
  console.log("");
  console.log("Lê dbo.StocksMov + JOINs e POSTa a /api/ingest/v1/movimentos.");
  console.log("Paginação por StocksMovID > since-id (chunks 50k SQL).");
  console.log("Idempotente por (farmaciaId, externalMovId).");
  console.log("Retry + backoff em 502/503/504/timeout; auto-shrink batch até floor 25.");
  console.log("");
  console.log("Pré-requisitos:");
  console.log("  · stocksmov-dry-run OK contra o mesmo intervalo");
  console.log("  · ENABLE_AGENT_BOOTSTRAP=1 no SaaS");
  console.log("  · SPHARMMT_FARMACIA configurado");
}

// ── DRY-RUN ────────────────────────────────────────────────────────

export async function stocksmovDryRun(): Promise<number> {
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
  console.log("stocksmov-dry-run — read-only, sem POST");
  console.log(DOUBLE_RULE);
  console.log(`ERP database: ${cfg.sqlDatabase}@${cfg.sqlHost}:${cfg.sqlPort}`);
  console.log(`From        : ${from}`);
  console.log(`To          : ${to}`);
  console.log(`Since ID    : ${args.sinceId ?? 0}`);
  console.log("");

  try {
    return await withPool(cfg, async (pool) => {
      // Para dry-run, lemos UM SÓ chunk de 50k linhas — barato e suficiente
      // para o operador validar a distribuição antes de chamar upload.
      console.log(`▶ A ler dbo.StocksMov (até ${SQL_CHUNK_SIZE} linhas) ...`);
      const rows = await fetchPage(pool, from, to, args.sinceId ?? 0, SQL_CHUNK_SIZE);
      console.log(`  ✓ ${rows.length} linhas lidas (limit=${SQL_CHUNK_SIZE})`);
      if (rows.length === SQL_CHUNK_SIZE) {
        console.log(`  ⚠ Janela maior que ${SQL_CHUNK_SIZE} — re-correr com --since-id ${rows[rows.length - 1]?.StocksMovID} para ver o resto.`);
      }
      console.log("");

      // Classifica + agrega
      const byTipo = new Map<string, number>();
      const byMotivo = new Map<string, { tipo: string; count: number }>();
      const desconhecidoSamples: Array<{ id: number; reason: string }> = [];
      let withProduto = 0;
      const distinctProdutos = new Set<number>();
      for (const r of rows) {
        const cls = classifyRaw(rowToRaw(r));
        byTipo.set(cls.tipo, (byTipo.get(cls.tipo) ?? 0) + 1);
        const key = `${r.cabMotivoId ?? "null"}:${r.cabMotivoTexto ?? "(null)"}`;
        const m = byMotivo.get(key);
        if (m) m.count++;
        else byMotivo.set(key, { tipo: cls.tipo, count: 1 });
        if (cls.tipo === "DESCONHECIDO" && desconhecidoSamples.length < 20) {
          desconhecidoSamples.push({ id: r.StocksMovID, reason: cls.reason });
        }
        if (r.CodigoID) {
          distinctProdutos.add(r.CodigoID);
          withProduto++;
        }
      }

      console.log("Distribuição por tipo:");
      const tipoEntries = Array.from(byTipo.entries()).sort((a, b) => b[1] - a[1]);
      for (const [tipo, count] of tipoEntries) {
        const pct = ((count / rows.length) * 100).toFixed(1);
        console.log(`  ${tipo.padEnd(24)} ${String(count).padStart(7)}  (${pct}%)`);
      }
      console.log("");

      const desconhecidos = byTipo.get("DESCONHECIDO") ?? 0;
      const desconhecidoPct = rows.length > 0 ? (desconhecidos / rows.length) * 100 : 0;
      console.log(
        `Cobertura DESCONHECIDO: ${desconhecidos}/${rows.length} (${desconhecidoPct.toFixed(2)}%) — alvo <1%`,
      );
      if (desconhecidoPct >= 1) {
        console.log(`  ⚠ ACIMA do alvo — rever lib/movimento-classifier antes de upload.`);
      } else {
        console.log(`  ✓ Dentro do alvo.`);
      }
      console.log("");

      console.log(`Produtos distintos (CodigoID): ${distinctProdutos.size} (em ${withProduto} linhas)`);
      console.log("");

      console.log("Top 25 motivos (por volume):");
      const motivoEntries = Array.from(byMotivo.entries())
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 25);
      for (const [key, { tipo, count }] of motivoEntries) {
        console.log(`  ${tipo.padEnd(22)} ${String(count).padStart(6)} × ${key}`);
      }
      console.log("");

      if (desconhecidoSamples.length > 0) {
        console.log(`DESCONHECIDO (top ${desconhecidoSamples.length}):`);
        for (const s of desconhecidoSamples) {
          console.log(`  StocksMovID=${s.id} reason=${s.reason}`);
        }
        console.log("");
      }

      // Sample 5
      console.log("Sample 5 linhas:");
      for (const r of rows.slice(0, 5)) {
        const cls = classifyRaw(rowToRaw(r));
        console.log(
          `  id=${r.StocksMovID} dt=${r.DataMov.toISOString().slice(0, 10)} ` +
            `cnp=${r.CodigoID} qt=${r.Qtd} ex=${r.Existencia} tipo=${cls.tipo} ` +
            `(${cls.reason})`,
        );
      }
      console.log("");

      const httpBatch = args.batchSize ?? DEFAULT_HTTP_BATCH;
      const batches = Math.ceil(rows.length / httpBatch);
      console.log(`Estimativa upload (batch-size ${httpBatch}): ${batches} batch(es) HTTP / chunk SQL`);
      console.log("");

      console.log(DOUBLE_RULE);
      console.log("Pronto para correr run-stocksmov-upload.bat (mesmo intervalo).");
      console.log(DOUBLE_RULE);
      return 0;
    });
  } catch (err) {
    console.error("\n✗ Falha:", err instanceof Error ? err.message : String(err));
    return 1;
  }
}

// ── UPLOAD ─────────────────────────────────────────────────────────

type UploadTotals = {
  sqlChunks: number;
  httpBatches: number;
  read: number;
  accepted: number;
  upserted: number;
  created: number;
  updated: number;
  desconhecidos: number;
  orphanProducts: number;
  skipped: number;
  errors: number;
  durationMs: number;
  byTipo: Record<string, number>;
};

export async function stocksmovUpload(): Promise<number> {
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

  const httpBatch = args.batchSize ?? DEFAULT_HTTP_BATCH;
  const client = new SaasClient(cfg);
  let farmaciaId: string;
  try {
    farmaciaId = await resolveFarmaciaId(client, cfg.farmacia);
  } catch (err) {
    console.error("✗ Resolução de farmácia falhou:", err instanceof Error ? err.message : String(err));
    return 1;
  }

  const ingestRunId = genRunId();
  console.log(RULE);
  console.log("stocksmov-upload — canónico MovimentoArtigo (idempotente)");
  console.log(RULE);
  console.log(`SaaS endpoint     : ${cfg.saasEndpoint}`);
  console.log(`Tenant slug       : ${cfg.tenantSlug}`);
  console.log(`Farmácia (resolved): ${farmaciaId}`);
  console.log(`ERP database      : ${cfg.sqlDatabase}@${cfg.sqlHost}:${cfg.sqlPort}`);
  console.log(`Intervalo         : ${from} → ${to}`);
  console.log(`Since ID          : ${args.sinceId ?? 0}`);
  console.log(`HTTP batch size   : ${httpBatch}`);
  console.log(`SQL chunk size    : ${SQL_CHUNK_SIZE}`);
  console.log(`Ingest run ID     : ${ingestRunId}`);
  console.log("");

  try {
    return await withPool(cfg, async (pool) => {
      const totals: UploadTotals = {
        sqlChunks: 0,
        httpBatches: 0,
        read: 0,
        accepted: 0,
        upserted: 0,
        created: 0,
        updated: 0,
        desconhecidos: 0,
        orphanProducts: 0,
        skipped: 0,
        errors: 0,
        durationMs: 0,
        byTipo: {},
      };

      let sinceId = args.sinceId ?? 0;
      let lastReportTime = Date.now();
      // rev35: o tamanho efectivo arranca em `httpBatch` (default 100) e
      // só pode descer (auto-shrink em 504/503/502). Mantemos em scope
      // do upload todo — se um batch grande falhar e baixar para 50,
      // os batches seguintes continuam a 50 (não voltam a tentar 100).
      let currentBatchSize = Math.max(MIN_HTTP_BATCH, httpBatch);

      while (true) {
        const chunkT0 = Date.now();
        const rows = await fetchPage(pool, from, to, sinceId, SQL_CHUNK_SIZE);
        if (rows.length === 0) break;

        totals.sqlChunks++;
        totals.read += rows.length;
        const chunkElapsed = Date.now() - chunkT0;
        console.log(
          `▶ SQL chunk ${totals.sqlChunks}: ${rows.length} linhas (sinceId=${sinceId}, ${chunkElapsed}ms)`,
        );

        // ── rev35: batch HTTP com retry + backoff + auto-shrink ──
        //
        // Estratégia (idempotente via ingestRunId + UPSERT por
        // (farmaciaId, externalMovId)):
        //   1. Tenta enviar `currentBatchSize` rows.
        //   2. Em 502/503/504/408/429/500 ou erro de rede: backoff
        //      exponencial 1s,2s,4s,8s — até MAX_RETRIES tentativas.
        //   3. Se MAX_RETRIES esgotar: encolhe `currentBatchSize` para
        //      metade (floor MIN_HTTP_BATCH=25) e retoma o MESMO offset.
        //   4. Se MIN_HTTP_BATCH falhar persistentemente: aborta, mas
        //      o re-run com mesmo intervalo + mesmo ingestRunId não
        //      duplica (UPSERT).
        //
        // currentBatchSize só cresce em retry-shrink; nunca volta a subir
        // dentro do mesmo run (conservador — evita ping-pong).
        let offset = 0;
        while (offset < rows.length) {
          const slice = rows.slice(offset, offset + currentBatchSize);
          const items: MovimentoPayload[] = [];
          let localSkipped = 0;
          for (const r of slice) {
            const p = rowToPayload(r);
            if (p === null) {
              localSkipped++;
              continue;
            }
            items.push(p);
          }
          if (items.length === 0) {
            totals.skipped += localSkipped;
            offset += slice.length;
            continue;
          }

          let attemptResponse: Awaited<ReturnType<typeof client.ingestMovimentos>> | null = null;
          let attemptError: unknown = null;
          for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
              attemptResponse = await client.ingestMovimentos(
                { farmaciaId, ingestRunId, items },
                BATCH_TIMEOUT_MS,
              );
              attemptError = null;
              break;
            } catch (err) {
              attemptError = err;
              if (!isTransientError(err) || attempt === MAX_RETRIES) break;
              const backoff = BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
              const reason =
                err instanceof SaasApiError
                  ? `HTTP ${err.statusCode}`
                  : err instanceof Error
                    ? err.message.slice(0, 80)
                    : "unknown";
              console.log(
                `  ↳ batch (size=${currentBatchSize}, offset=${offset}) tentativa ${attempt}/${MAX_RETRIES} falhou (${reason}); backoff ${backoff}ms`,
              );
              await sleep(backoff);
            }
          }

          if (attemptResponse === null) {
            // Esgotou retries. Se ainda há margem para encolher, encolhe
            // e re-tenta o MESMO offset com o novo size.
            if (isTransientError(attemptError) && currentBatchSize > MIN_HTTP_BATCH) {
              const newSize = Math.max(MIN_HTTP_BATCH, Math.floor(currentBatchSize / 2));
              console.log(
                `  ↳ shrink: ${currentBatchSize} → ${newSize} (offset ${offset} preservado, idempotente via ingestRunId)`,
              );
              currentBatchSize = newSize;
              continue;
            }
            // Não-transiente OU já em MIN_HTTP_BATCH — reporta e aborta.
            // Re-run com mesmo --from/--to/--since-id retoma sem duplicar.
            const lastOk = offset > 0 ? rows[offset - 1].StocksMovID : sinceId;
            if (attemptError instanceof SaasApiError) {
              console.error(
                `\n✗ HTTP ${attemptError.statusCode} persistente (batchSize=${currentBatchSize}, offset=${offset}): ${attemptError.bodySnippet ?? attemptError.message}`,
              );
            } else {
              console.error(
                `\n✗ Falha persistente (batchSize=${currentBatchSize}, offset=${offset}):`,
                attemptError instanceof Error ? attemptError.message : attemptError,
              );
            }
            console.error(
              `  Re-correr para retomar (idempotente, UPSERT preserva):` +
                `\n    --from ${from} --to ${to} --since-id ${lastOk}`,
            );
            return 1;
          }

          // Sucesso para esta slice.
          const response = attemptResponse;
          totals.httpBatches++;
          totals.accepted += response.accepted;
          totals.upserted += response.upserted;
          totals.created += response.created;
          totals.updated += response.updated;
          totals.desconhecidos += response.desconhecidos;
          totals.orphanProducts += response.orphanProducts;
          totals.skipped += response.skipped.length + localSkipped;
          totals.errors += response.errors.length;
          totals.durationMs += response.durationMs;
          for (const [k, v] of Object.entries(response.byTipo)) {
            totals.byTipo[k] = (totals.byTipo[k] ?? 0) + v;
          }

          if (Date.now() - lastReportTime > 30_000) {
            console.log(
              `  · totals: chunks=${totals.sqlChunks} batches=${totals.httpBatches} ` +
                `upserted=${totals.upserted} desc=${totals.desconhecidos} orph=${totals.orphanProducts} batchSize=${currentBatchSize}`,
            );
            lastReportTime = Date.now();
          }

          if (response.errors.length > 0) {
            for (const e of response.errors.slice(0, 3)) {
              console.log(`    ✗ idx=${e.index} ext=${e.externalId ?? "?"} ${e.reason}: ${e.message}`);
            }
          }

          offset += slice.length;
        }

        sinceId = rows[rows.length - 1].StocksMovID;
        if (rows.length < SQL_CHUNK_SIZE) break;
      }

      console.log("");
      console.log(DOUBLE_RULE);
      console.log("RESUMO");
      console.log(DOUBLE_RULE);
      console.log(`  SQL chunks                   : ${totals.sqlChunks}`);
      console.log(`  HTTP batches                 : ${totals.httpBatches}`);
      console.log(`  Linhas ERP lidas             : ${totals.read}`);
      console.log(`  Aceites pelo SaaS            : ${totals.accepted}`);
      console.log(`  Upserted (created+updated)   : ${totals.upserted}`);
      console.log(`    novos                      : ${totals.created}`);
      console.log(`    actualizados               : ${totals.updated}`);
      console.log(`  DESCONHECIDO                 : ${totals.desconhecidos}`);
      const desconhecidoPct = totals.upserted > 0 ? (totals.desconhecidos / totals.upserted) * 100 : 0;
      console.log(`    cobertura                  : ${desconhecidoPct.toFixed(2)}% (alvo <1%)`);
      console.log(`  Orphan products              : ${totals.orphanProducts}`);
      console.log(`  Skipped                      : ${totals.skipped}`);
      console.log(`  Errors                       : ${totals.errors}`);
      console.log(`  Tempo agregado SaaS          : ${totals.durationMs} ms`);
      console.log(`  Last StocksMovID processado  : ${sinceId}`);
      console.log(`  Ingest run ID                : ${ingestRunId}`);
      console.log("");
      console.log("Distribuição por tipo:");
      const entries = Object.entries(totals.byTipo).sort((a, b) => b[1] - a[1]);
      for (const [tipo, count] of entries) {
        const pct = totals.upserted > 0 ? ((count / totals.upserted) * 100).toFixed(1) : "0.0";
        console.log(`  ${tipo.padEnd(24)} ${String(count).padStart(8)}  (${pct}%)`);
      }

      if (totals.errors > 0) {
        console.log(`\n  ⚠ ${totals.errors} erros — re-correr com mesmo --from/--to (idempotente).`);
        return 1;
      }
      if (desconhecidoPct >= 1 && totals.upserted > 0) {
        console.log(
          `\n  ⚠ DESCONHECIDO ${desconhecidoPct.toFixed(2)}% — acima do alvo (<1%). Não bloqueia upload (linhas escritas com tipo=DESCONHECIDO), mas rever motivos antes de activar flag useMovimentosCanonical.`,
        );
      }
      return 0;
    });
  } catch (err) {
    console.error("\n✗ Falha:", err instanceof Error ? err.message : String(err));
    return 1;
  }
}
