/**
 * agent/src/commands/fornecedores.ts
 *
 * Fase 1a do pipeline compras/devoluções: ingestão de Fornecedores do
 * SPharm ERP local para a SaaS.
 *
 * Dois comandos exportados:
 *   · fornecedoresDryRun  — lê dbo.Fornecedores read-only, imprime
 *                            sumário + TOP 10 amostra. Sem POST.
 *   · fornecedoresUpload  — lê + POST a /api/ingest/v1/bootstrap/fornecedores.
 *                            Idempotente. Halt-on-error por batch.
 *
 * Source query (idêntica nos dois comandos):
 *   SELECT
 *     f.[Fornecedor ID]        AS externalFornecedorId,
 *     f.[Nome Abreviado]       AS nomeAbreviado,
 *     f.[Nome Fornecedor]      AS nomeFornecedor,
 *     f.[Numero Contribuinte]  AS nif,
 *     f.[Tipo de Fornecedor]   AS tipoId,
 *     tf.[Descricao]           AS tipoDescricao,
 *     f.[Inactivo]             AS inactivo
 *   FROM [dbo].[Fornecedores] f
 *   LEFT JOIN [dbo].[Tbl_Tipo_Fornecedores] tf
 *     ON tf.[TFornecedores ID] = f.[Tipo de Fornecedor]
 *   ORDER BY f.[Fornecedor ID] ASC
 *
 * Inactivos NÃO são excluídos no SQL — o user explicitamente pediu
 * "não excluir inactivos no staging; mas marcar estado no SaaS". O
 * endpoint server-side mapeia [Inactivo]!=0 → Fornecedor.estado=INATIVO.
 *
 * Batch size: 200 (Fornecedores são ~423 numa farmácia típica — cabem em
 * 3 batches com folga sob `maxDuration=60s` do Vercel).
 *
 * Idempotência: re-runs sem efeito destrutivo. Server upserta por
 * (farmaciaId, externalFornecedorId) em FornecedorErpRef e por
 * nomeNormalizado em Fornecedor canónico.
 */

import { parseArgs } from "node:util";
import { loadConfig, type AgentConfig } from "../config.js";
import { withPool, type SqlPool } from "../sql-client.js";
import { SaasClient, SaasApiError } from "../http-client.js";

const RULE = "─".repeat(70);
const DOUBLE_RULE = "═".repeat(70);
const BATCH_SIZE = 200;
const BATCH_TIMEOUT_MS = 60_000;

// ── SQL row + payload types ──────────────────────────────────────────

type FornecedorRow = {
  externalFornecedorId: number;
  nomeAbreviado: string | null;
  nomeFornecedor: string | null;
  nif: string | null;
  tipoId: number | null;
  tipoDescricao: string | null;
  inactivo: number | boolean | null;
};

type FornecedorPayload = {
  externalFornecedorId: number;
  nomeAbreviado: string;
  nomeFornecedor: string | null;
  nif: string | null;
  tipoId: number | null;
  tipoDescricao: string | null;
  inactivo: boolean;
  ingestBatchId: string;
};

// ── Coerções defensivas (mesmas que outros bootstrap commands) ──────

function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
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
function boolOrFalse(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  return false;
}

// ── Single source query ──────────────────────────────────────────────

const SOURCE_SQL = `
  SELECT
    f.[Fornecedor ID]        AS externalFornecedorId,
    f.[Nome Abreviado]       AS nomeAbreviado,
    f.[Nome Fornecedor]      AS nomeFornecedor,
    f.[Numero Contribuinte]  AS nif,
    f.[Tipo de Fornecedor]   AS tipoId,
    tf.[Descricao]           AS tipoDescricao,
    f.[Inactivo]             AS inactivo
  FROM [dbo].[Fornecedores] f
  LEFT JOIN [dbo].[Tbl_Tipo_Fornecedores] tf
    ON tf.[TFornecedores ID] = f.[Tipo de Fornecedor]
  ORDER BY f.[Fornecedor ID] ASC
`;

async function fetchAllFornecedores(pool: SqlPool): Promise<FornecedorRow[]> {
  const rs = await pool.request().query<FornecedorRow>(SOURCE_SQL);
  return rs.recordset;
}

function rowToPayload(row: FornecedorRow, ingestBatchId: string): FornecedorPayload | null {
  const externalFornecedorId = numOrNull(row.externalFornecedorId);
  const nomeAbreviado = strOrNull(row.nomeAbreviado);
  if (externalFornecedorId === null || nomeAbreviado === null) return null;
  return {
    externalFornecedorId,
    nomeAbreviado,
    nomeFornecedor: strOrNull(row.nomeFornecedor),
    nif: strOrNull(row.nif),
    tipoId: numOrNull(row.tipoId),
    tipoDescricao: strOrNull(row.tipoDescricao),
    inactivo: boolOrFalse(row.inactivo),
    ingestBatchId,
  };
}

// ── Resolver farmacia (DRY com bootstrap-upload) ────────────────────

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

// ── ULID-ish batch id (no extra dep) ─────────────────────────────────

function genBatchId(): string {
  const ts = Date.now().toString(36).padStart(8, "0");
  const r = Math.random().toString(36).slice(2, 10).padStart(8, "0");
  return `frn-${ts}-${r}`;
}

// ── CLI parsing (partilhado) ────────────────────────────────────────

type Args = { help: boolean; batchSize?: number };

function parseCmdArgs(): Args {
  const raw = parseArgs({
    args: process.argv.slice(3),
    options: {
      help: { type: "boolean", short: "h" },
      "batch-size": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  const bs = typeof raw.values["batch-size"] === "string" ? Number(raw.values["batch-size"]) : undefined;
  return {
    help: raw.values.help === true,
    batchSize: bs && Number.isFinite(bs) && bs > 0 ? bs : undefined,
  };
}

function printDryRunHelp(): void {
  console.log("Uso: fornecedores-dry-run");
  console.log("");
  console.log("Lê dbo.Fornecedores (com LEFT JOIN a Tbl_Tipo_Fornecedores)");
  console.log("read-only e imprime sumário + TOP 10 amostra. SEM POST.");
  console.log("");
  console.log("Pré-requisito: test-connection OK.");
}

function printUploadHelp(): void {
  console.log("Uso: fornecedores-upload [--batch-size 200]");
  console.log("");
  console.log("Lê dbo.Fornecedores e faz POST batched a");
  console.log("/api/ingest/v1/bootstrap/fornecedores. Idempotente.");
  console.log("");
  console.log("Pré-requisitos:");
  console.log("  · fornecedores-dry-run OK contra esta instalação");
  console.log("  · ENABLE_AGENT_BOOTSTRAP=1 no SaaS (senão endpoint 503)");
  console.log("  · SPHARMMT_FARMACIA configurado (cuid ou nome)");
  console.log("  · test-connection passa (SQL + SaaS)");
}

// ── DRY-RUN ──────────────────────────────────────────────────────────

export async function fornecedoresDryRun(): Promise<number> {
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

  let cfg: AgentConfig;
  try {
    cfg = loadConfig("sql");
  } catch (err) {
    console.error("✗ Config inválida:");
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  console.log(RULE);
  console.log("fornecedores-dry-run — read-only, sem POST");
  console.log(RULE);
  console.log(`ERP database: ${cfg.sqlDatabase}@${cfg.sqlHost}:${cfg.sqlPort}`);
  console.log("");

  try {
    return await withPool(cfg, async (pool) => {
      console.log("▶ A ler dbo.Fornecedores ...");
      const rows = await fetchAllFornecedores(pool);
      console.log(`  ✓ ${rows.length} fornecedores lidos`);
      console.log("");

      // Resumo
      let activos = 0;
      let inactivos = 0;
      let semNif = 0;
      let semNomeFornecedor = 0;
      const tipoCounts = new Map<string, number>();
      for (const r of rows) {
        if (boolOrFalse(r.inactivo)) inactivos++;
        else activos++;
        if (!strOrNull(r.nif)) semNif++;
        if (!strOrNull(r.nomeFornecedor)) semNomeFornecedor++;
        const tipoKey = `${r.tipoId ?? "?"}:${strOrNull(r.tipoDescricao) ?? "(sem desc)"}`;
        tipoCounts.set(tipoKey, (tipoCounts.get(tipoKey) ?? 0) + 1);
      }
      console.log("Sumário:");
      console.log(`  Total              : ${rows.length}`);
      console.log(`  Activos            : ${activos}`);
      console.log(`  Inactivos          : ${inactivos}`);
      console.log(`  Sem NIF            : ${semNif}`);
      console.log(`  Sem Nome Fornecedor: ${semNomeFornecedor}`);
      console.log("");
      console.log("Distribuição por Tipo de Fornecedor:");
      const sortedTipos = Array.from(tipoCounts.entries()).sort((a, b) => b[1] - a[1]);
      for (const [k, c] of sortedTipos) {
        console.log(`  ${k.padEnd(40)} ${String(c).padStart(5)}`);
      }
      console.log("");

      // TOP 10 amostra
      console.log("TOP 10 amostra (primeiros por externalFornecedorId):");
      console.log("");
      const sample = rows.slice(0, 10);
      const widthId = 6;
      const widthNome = 32;
      console.log(
        `  ${"ID".padEnd(widthId)}  ${"Nome Abreviado".padEnd(widthNome)}  ${"NIF".padEnd(11)}  Inact  Tipo`
      );
      console.log(
        `  ${"-".repeat(widthId)}  ${"-".repeat(widthNome)}  ${"-".repeat(11)}  -----  -------------`
      );
      for (const r of sample) {
        const id = String(r.externalFornecedorId).padEnd(widthId);
        const nome = (strOrNull(r.nomeAbreviado) ?? "(vazio)").slice(0, widthNome).padEnd(widthNome);
        const nif = (strOrNull(r.nif) ?? "—").padEnd(11);
        const inact = boolOrFalse(r.inactivo) ? "  Y  " : "  N  ";
        const tipo = strOrNull(r.tipoDescricao) ?? `(${r.tipoId ?? "?"})`;
        console.log(`  ${id}  ${nome}  ${nif}  ${inact}  ${tipo}`);
      }
      console.log("");

      // Skipped (sem ID ou sem Nome Abreviado)
      const skipped = rows.filter((r) => numOrNull(r.externalFornecedorId) === null || strOrNull(r.nomeAbreviado) === null);
      if (skipped.length > 0) {
        console.log(`⚠ ${skipped.length} rows seriam SKIPPED pelo endpoint (missing ID ou Nome Abreviado):`);
        for (const r of skipped.slice(0, 5)) {
          console.log(`  · ID=${r.externalFornecedorId ?? "?"} nomeAbreviado=${r.nomeAbreviado ?? "?"}`);
        }
        console.log("");
      }

      console.log(RULE);
      console.log(`Pronto para upload via: run-fornecedores-upload.bat`);
      console.log(`(estimado: ${Math.ceil(rows.length / BATCH_SIZE)} batch(es) de ${BATCH_SIZE})`);
      console.log(RULE);
      return 0;
    });
  } catch (err) {
    console.error("\n✗ Falha:");
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

// ── UPLOAD ───────────────────────────────────────────────────────────

type UploadTotals = {
  batches: number;
  read: number;
  accepted: number;
  upserted: number;
  fornecedoresCreated: number;
  fornecedoresUpdated: number;
  refsCreated: number;
  refsUpdated: number;
  aliasesAdded: number;
  skipped: number;
  errors: number;
  durationMs: number;
};

function emptyUploadTotals(): UploadTotals {
  return {
    batches: 0,
    read: 0,
    accepted: 0,
    upserted: 0,
    fornecedoresCreated: 0,
    fornecedoresUpdated: 0,
    refsCreated: 0,
    refsUpdated: 0,
    aliasesAdded: 0,
    skipped: 0,
    errors: 0,
    durationMs: 0,
  };
}

export async function fornecedoresUpload(): Promise<number> {
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
  const batchSize = args.batchSize ?? BATCH_SIZE;

  let cfg: AgentConfig;
  try {
    cfg = loadConfig("both"); // SQL + SaaS
  } catch (err) {
    console.error("✗ Config inválida:");
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  if (!cfg.farmacia) {
    console.error("✗ SPHARMMT_FARMACIA não está definido.");
    console.error("  Configura no .env (ou agent.config.json em SaaS.farmacia) o cuid ou nome");
    console.error("  da farmácia que recebe o bootstrap de fornecedores.");
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

  console.log(RULE);
  console.log("fornecedores-upload — Fase 1a (idempotente)");
  console.log(RULE);
  console.log(`SaaS endpoint     : ${cfg.saasEndpoint}`);
  console.log(`Tenant slug       : ${cfg.tenantSlug}`);
  console.log(`Farmácia (resolved): ${farmaciaId}`);
  console.log(`ERP database      : ${cfg.sqlDatabase}@${cfg.sqlHost}:${cfg.sqlPort}`);
  console.log(`Batch size        : ${batchSize}`);
  console.log("");

  const ingestBatchId = genBatchId();
  console.log(`Batch ID          : ${ingestBatchId}`);
  console.log("");

  try {
    return await withPool(cfg, async (pool) => {
      const rows = await fetchAllFornecedores(pool);
      console.log(`▶ ${rows.length} fornecedores lidos do ERP`);
      console.log("");

      const totals = emptyUploadTotals();
      totals.read = rows.length;

      console.log(DOUBLE_RULE);
      console.log("▶ POST /api/ingest/v1/bootstrap/fornecedores");
      console.log(DOUBLE_RULE);

      for (let offset = 0; offset < rows.length; offset += batchSize) {
        const chunkRows = rows.slice(offset, offset + batchSize);
        const items: FornecedorPayload[] = [];
        let localSkipped = 0;
        for (const r of chunkRows) {
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

        try {
          const response = await client.bootstrapFornecedores(
            { farmaciaId, items },
            BATCH_TIMEOUT_MS
          );
          totals.batches++;
          totals.accepted += response.accepted;
          totals.upserted += response.upserted;
          totals.fornecedoresCreated += response.fornecedoresCreated;
          totals.fornecedoresUpdated += response.fornecedoresUpdated;
          totals.refsCreated += response.refsCreated;
          totals.refsUpdated += response.refsUpdated;
          totals.aliasesAdded += response.aliasesAdded;
          totals.skipped += response.skipped.length + localSkipped;
          totals.errors += response.errors.length;
          totals.durationMs += response.durationMs;

          console.log(
            `  batch ${totals.batches}: read=${chunkRows.length} accepted=${response.accepted} ` +
              `forn(c=${response.fornecedoresCreated} u=${response.fornecedoresUpdated}) ` +
              `refs(c=${response.refsCreated} u=${response.refsUpdated}) ` +
              `aliases+${response.aliasesAdded} skipped=${response.skipped.length + localSkipped} errors=${response.errors.length}`
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
      console.log(`  Batches enviados        : ${totals.batches}`);
      console.log(`  Linhas ERP lidas        : ${totals.read}`);
      console.log(`  Aceites pelo SaaS       : ${totals.accepted}`);
      console.log(`  Upserted (refs)         : ${totals.upserted}`);
      console.log(`    novos Fornecedor      : ${totals.fornecedoresCreated}`);
      console.log(`    Fornecedor tocados    : ${totals.fornecedoresUpdated}`);
      console.log(`    novos ErpRef          : ${totals.refsCreated}`);
      console.log(`    ErpRef tocados        : ${totals.refsUpdated}`);
      console.log(`    aliases adicionados   : ${totals.aliasesAdded}`);
      console.log(`  Skipped                 : ${totals.skipped}`);
      console.log(`  Errors                  : ${totals.errors}`);
      console.log(`  Tempo agregado SaaS     : ${totals.durationMs} ms`);
      if (totals.errors > 0) {
        console.log(`  ⚠ ${totals.errors} erros — ver detalhes acima.`);
        return 1;
      }
      return 0;
    });
  } catch (err) {
    console.error("\n✗ Falha:");
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
