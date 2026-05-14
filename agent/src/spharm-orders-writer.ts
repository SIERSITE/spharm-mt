/**
 * agent/src/spharm-orders-writer.ts
 *
 * Camada responsável por escrever uma encomenda finalizada (vinda do
 * outbox SaaS) no SPharm ERP local.
 *
 * Modos de operação (controlado por `cfg.ordersWriteMode`):
 *
 *   · stub  — modo default. NÃO escreve no SPharm. Persiste o payload
 *     + enriquecimento (CNP por linha) num ficheiro JSON dentro de
 *     `outputDir/orders-export/YYYY-MM-DD/<outboxId>.json` e devolve
 *     um `spharmDocumentId` sintético prefixado com `STUB-`.
 *
 *   · insert — modo real. INSERT directo em dbo.Encomendas +
 *     dbo.Encomendas Detalhe, transaccional, idempotente via outboxId
 *     guardado em coluna configurável (default VVM_ID). Schema-alvo
 *     mapeado a partir de notes/inspection.md gerado por
 *     `inspect-orders-schema`.
 *
 * Idempotência (modo insert):
 *   - Antes do INSERT: SELECT [Encomenda ID] WHERE [VVM_ID]=@outboxId.
 *     Se já existir, devolve esse ID sem novo INSERT.
 *   - Re-run da mesma outboxId é seguro — não duplica.
 *
 * dryRun (modo insert):
 *   - Tudo é executado dentro de uma transacção
 *   - No fim, em vez de COMMIT faz ROLLBACK
 *   - O `spharmDocumentId` devolvido NÃO está visível em SPharm
 *   - Usado por `test-order-write` para smoke testing seguro
 *
 * Mapping de produto: SaaS conhece `produtoId` (cuid) e
 * `enrichment.linhas[].cnp`. A escrita resolve CNP → CodigoID via
 * `SELECT TOP 1 [CodigoID] FROM [dbo].[Stocks] WHERE [CodCNPEM]=@cnp`.
 * Preços (`Preco Venda Publico_EUR`, `PMC_EUR`) são lidos no mesmo
 * SELECT — usamos o que o ERP conhece, não o que veio do SaaS.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import sql from "mssql";
import type {
  PendingOrder,
  PendingOrderLine,
  PendingOrderEnrichmentLine,
} from "./http-client.js";
import type { AgentConfig, OrdersInsertConfig } from "./config.js";
import type { SqlPool } from "./sql-client.js";

export type OrdersWriteMode = "stub" | "insert";

export type WriteOptions = { dryRun?: boolean };

export type WriteOrderResult = {
  spharmDocumentId: string;
  durationMs: number;
  details: Record<string, unknown>;
  /** "created" = novo INSERT, "idempotent" = já existia, "stub" = JSON-only */
  source: "created" | "idempotent" | "stub";
};

export class WriteOrderError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly sqlError?: { code?: string; number?: number; message?: string }
  ) {
    super(message);
    this.name = "WriteOrderError";
  }
}

// ─── Helpers comuns ──────────────────────────────────────────────────

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function mergeLines(
  payloadLines: PendingOrderLine[],
  enrichmentLines: PendingOrderEnrichmentLine[]
): Array<PendingOrderLine & { cnp: string | null; designacao: string | null }> {
  const byId = new Map(enrichmentLines.map((e) => [e.produtoId, e]));
  return payloadLines.map((l) => {
    const e = byId.get(l.produtoId);
    return {
      ...l,
      cnp: e?.cnp ?? null,
      designacao: e?.designacao ?? null,
    };
  });
}

function pickQuantity(line: PendingOrderLine, designacao: string | null): number {
  const raw = line.quantidadeAjustada ?? line.quantidadeSugerida;
  if (raw === null || raw === undefined || raw === "") {
    throw new WriteOrderError(
      `Linha sem quantidade (produto ${designacao ?? line.produtoId}).`,
      false
    );
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new WriteOrderError(
      `Quantidade inválida ${raw} (produto ${designacao ?? line.produtoId}).`,
      false
    );
  }
  if (!Number.isInteger(n)) {
    throw new WriteOrderError(
      `Quantidade ${raw} não é inteira — dbo.[Encomendas Detalhe].[Quantidade] é INT (produto ${designacao ?? line.produtoId}).`,
      false
    );
  }
  return n;
}

// ─── Stub ────────────────────────────────────────────────────────────

async function writeStub(
  order: PendingOrder,
  cfg: AgentConfig,
  options: WriteOptions
): Promise<WriteOrderResult> {
  const startedAt = Date.now();
  const now = new Date();
  const merged = mergeLines(order.payload.linhas, order.enrichment.linhas);
  const missingCnp = merged.filter((l) => !l.cnp).map((l) => l.produtoId);

  let outputFile: string | null = null;
  if (!options.dryRun) {
    const dir = path.resolve(cfg.outputDir, "orders-export", ymd(now));
    fs.mkdirSync(dir, { recursive: true });

    const out = {
      capturedAt: now.toISOString(),
      mode: "stub" as const,
      outboxId: order.outboxId,
      listaEncomendaId: order.listaEncomendaId,
      farmaciaId: order.farmaciaId,
      idempotencyKey: order.idempotencyKey,
      payloadHash: order.payloadHash,
      attempt: order.attempt,
      payload: order.payload,
      enrichment: order.enrichment,
      resolvedLines: merged,
      warnings:
        missingCnp.length > 0
          ? [
              `${missingCnp.length} produto(s) sem CNP resolvido — CodigoArtigo seria impossível de mapear em modo insert.`,
            ]
          : [],
    };
    outputFile = path.resolve(dir, `${order.outboxId}.json`);
    fs.writeFileSync(outputFile, JSON.stringify(out, null, 2), "utf8");
  }

  return {
    spharmDocumentId: `STUB-${order.outboxId.slice(0, 8)}-${now.getTime()}`,
    durationMs: Date.now() - startedAt,
    details: {
      mode: "stub",
      dryRun: options.dryRun ?? false,
      capturedAt: now.toISOString(),
      outputFile,
      lineCount: merged.length,
      missingCnpCount: missingCnp.length,
    },
    source: "stub",
  };
}

// ─── Insert: schema introspection (cache por execução) ───────────────

type InsertSchema = {
  encomendaIdIsIdentity: boolean;
  detalheIdIsIdentity: boolean;
};

let cachedInsertSchema: InsertSchema | null = null;

async function getInsertSchema(pool: SqlPool): Promise<InsertSchema> {
  if (cachedInsertSchema) return cachedInsertSchema;
  const r = await pool.request().query<{
    tableName: string;
    columnName: string;
    isIdentity: boolean;
  }>(`
    SELECT t.name AS tableName, c.name AS columnName, c.is_identity AS isIdentity
    FROM sys.columns c
    JOIN sys.tables t ON c.object_id = t.object_id
    JOIN sys.schemas s ON t.schema_id = s.schema_id
    WHERE s.name = 'dbo'
      AND (
        (t.name = 'Encomendas' AND c.name = 'Encomenda ID')
        OR (t.name = 'Encomendas Detalhe' AND c.name = 'Detalhe  Enc ID')
      )
  `);
  const map = new Map<string, boolean>();
  for (const row of r.recordset) {
    map.set(`${row.tableName}.${row.columnName}`, !!row.isIdentity);
  }
  const encomendaIdIsIdentity = map.get("Encomendas.Encomenda ID");
  const detalheIdIsIdentity = map.get("Encomendas Detalhe.Detalhe  Enc ID");
  if (encomendaIdIsIdentity === undefined || detalheIdIsIdentity === undefined) {
    throw new WriteOrderError(
      "Não consegui inspeccionar IDENTITY em dbo.Encomendas / dbo.[Encomendas Detalhe]. Tabelas existem? Permissões sys.columns OK?",
      false
    );
  }
  if (!encomendaIdIsIdentity) {
    throw new WriteOrderError(
      "dbo.Encomendas.[Encomenda ID] NÃO é IDENTITY neste SPharm. O caminho de INSERT actual depende de SCOPE_IDENTITY(); precisa de adaptação (atribuição manual de ID com MAX+1 sob lock pessimista). Pára em vez de adivinhar.",
      false
    );
  }
  if (!detalheIdIsIdentity) {
    throw new WriteOrderError(
      "dbo.[Encomendas Detalhe].[Detalhe  Enc ID] NÃO é IDENTITY. Mesma observação aplica-se às linhas.",
      false
    );
  }
  cachedInsertSchema = { encomendaIdIsIdentity, detalheIdIsIdentity };
  return cachedInsertSchema;
}

// ─── Insert: lookup CNP → CodigoID + preços ──────────────────────────

type StocksLookup = {
  codigoId: number;
  pvp: number;
  pmc: number;
  precoCusto: number | null;
};

async function lookupCodigoIdAndPrices(
  tx: sql.Transaction,
  cnp: string
): Promise<StocksLookup | null> {
  const cnpNum = Number(cnp);
  if (!Number.isFinite(cnpNum) || !Number.isInteger(cnpNum) || cnpNum <= 0) {
    return null;
  }
  const r = await new sql.Request(tx)
    .input("cnp", sql.Numeric(8, 0), cnpNum)
    .query<{
      CodigoID: number;
      PVP: number | string;
      PMC: number | string;
      PrecoUltCompra: number | string | null;
    }>(`
      SELECT TOP 1
        [CodigoID]                       AS CodigoID,
        [Preco Venda Publico_EUR]        AS PVP,
        [Preco Medio Compra_EUR]         AS PMC,
        [Preco Ultima Compra_EUR]        AS PrecoUltCompra
      FROM   [dbo].[Stocks]
      WHERE  [CodCNPEM] = @cnp
    `);
  const row = r.recordset[0];
  if (!row) return null;
  return {
    codigoId: Number(row.CodigoID),
    pvp: Number(row.PVP),
    pmc: Number(row.PMC),
    precoCusto: row.PrecoUltCompra != null ? Number(row.PrecoUltCompra) : null,
  };
}

// ─── Insert: SQL error classification ────────────────────────────────

function isRetryableSqlError(err: { code?: string; number?: number }): boolean {
  // SQL Server engine — transientes
  if (err.number === 1205) return true; // deadlock victim
  if (err.number === -2) return true; // mssql timeout
  // Network / connection
  if (err.code === "ETIMEOUT") return true;
  if (err.code === "ETIMEDOUT") return true;
  if (err.code === "ECONNREFUSED") return true;
  if (err.code === "ECONNRESET") return true;
  if (err.code === "ESOCKET") return true;
  // Tudo o resto: data / permission / schema — não retryable
  return false;
}

// ─── Insert: corpo principal ─────────────────────────────────────────

async function writeInsert(
  order: PendingOrder,
  cfg: AgentConfig,
  pool: SqlPool,
  options: WriteOptions
): Promise<WriteOrderResult> {
  const startedAt = Date.now();
  const oc = cfg.ordersInsert;
  if (!oc) {
    throw new WriteOrderError(
      "ordersInsert config em falta — não posso correr em modo insert. Edita agent.config.json (secção ordersInsert).",
      false
    );
  }

  // 1) Schema introspection (uma vez por execução do agent)
  await getInsertSchema(pool);

  // 2) Pre-flight: merge + validate sem tocar na BD
  const merged = mergeLines(order.payload.linhas, order.enrichment.linhas);
  if (merged.length === 0) {
    throw new WriteOrderError("Encomenda sem linhas — nada a escrever.", false);
  }
  const lineSpecs = merged.map((l) => {
    if (!l.cnp) {
      throw new WriteOrderError(
        `Produto ${l.designacao ?? l.produtoId} sem CNP no enriquecimento — impossível mapear CodigoID em SPharm.`,
        false
      );
    }
    return {
      produtoId: l.produtoId,
      cnp: l.cnp,
      designacao: l.designacao,
      quantidade: pickQuantity(l, l.designacao),
    };
  });

  // 3) Abrir transacção. READ COMMITTED + TABLOCKX no SELECT MAX para
  //    serializar concorrência num NEncomenda. Agent é single-instance
  //    por farmácia mas SPharm UI corre em paralelo — TABLOCKX evita
  //    colisão se um operador estiver a criar encomenda no mesmo momento.
  const tx = new sql.Transaction(pool);
  await tx.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);

  try {
    // 4) Idempotency check — outboxId já gravado?
    const idemReq = new sql.Request(tx);
    idemReq.input("outboxId", sql.VarChar(25), order.outboxId);
    const existing = await idemReq.query<{ id: number }>(
      `SELECT TOP 1 [Encomenda ID] AS id FROM [dbo].[Encomendas] WHERE [${oc.idempotencyColumn}] = @outboxId`
    );
    if (existing.recordset.length > 0) {
      const existingId = Number(existing.recordset[0].id);
      // Em dryRun ou commit normal: nada para escrever — rollback é equivalente
      await tx.rollback();
      return {
        spharmDocumentId: String(existingId),
        durationMs: Date.now() - startedAt,
        details: {
          mode: "insert",
          source: "idempotent",
          outboxId: order.outboxId,
          encomendaId: existingId,
          lineCount: lineSpecs.length,
          dryRun: options.dryRun ?? false,
          note: "outboxId já existia em SPharm — retorno do mesmo Encomenda ID.",
        },
        source: "idempotent",
      };
    }

    // 5) Resolver CodigoID + preços para cada linha (lookups serializados;
    //    podiam ser paralelos mas o número de linhas é tipicamente <50)
    const resolved: Array<typeof lineSpecs[number] & StocksLookup> = [];
    for (const l of lineSpecs) {
      const r = await lookupCodigoIdAndPrices(tx, l.cnp);
      if (!r) {
        throw new WriteOrderError(
          `CNP ${l.cnp} (produto "${l.designacao ?? l.produtoId}") não encontrado em dbo.Stocks. Produto não existe no ERP local — sincronizar catálogo ou remover linha da encomenda.`,
          false
        );
      }
      resolved.push({ ...l, ...r });
    }

    // 6) Próximo NEncomenda — sob TABLOCKX HOLDLOCK
    const nReq = new sql.Request(tx);
    const nRes = await nReq.query<{ next: number }>(
      `SELECT ISNULL(MAX([NEncomenda]), 0) + 1 AS next FROM [dbo].[Encomendas] WITH (TABLOCKX, HOLDLOCK)`
    );
    const nEncomenda = Number(nRes.recordset[0]?.next ?? 1);

    // 7) INSERT header. Encomenda ID é IDENTITY (validado em getInsertSchema).
    //    Defaults hardcoded — EncNegociada=0, EncAprovacaoSitID=1,
    //    EncCentralCompras=0 — consistente com TOP 5 amostras observadas.
    const hReq = new sql.Request(tx);
    hReq.input("fornecedorId", sql.Int, oc.fornecedorIdForOrders);
    hReq.input("nEncomenda", sql.Int, nEncomenda);
    hReq.input("userId", sql.SmallInt, oc.userIdForInsert);
    hReq.input("situacao", sql.Char(1), oc.encomendaSituacaoInitial);
    hReq.input("armazemId", sql.TinyInt, oc.armazemId);
    hReq.input("tipoEncomendaId", sql.TinyInt, oc.tipoEncomendaId);
    hReq.input("outboxId", sql.VarChar(25), order.outboxId);

    // Nota: column name `[${oc.idempotencyColumn}]` é interpolado após
    // validação regex no loadConfig — apenas A-Z, a-z, 0-9, _, espaço.
    const hRes = await hReq.query<{ id: number }>(`
      INSERT INTO [dbo].[Encomendas] (
        [Fornecedor ID],
        [Data Encomenda],
        [NEncomenda],
        [User ID],
        [EncomendaSituacaoID],
        [ArmazemID],
        [EncNegociada],
        [EncAprovacaoSitID],
        [${oc.idempotencyColumn}],
        [EncCentralCompras],
        [TipoEncomendaID]
      ) VALUES (
        @fornecedorId,
        GETDATE(),
        @nEncomenda,
        @userId,
        @situacao,
        @armazemId,
        0,
        1,
        @outboxId,
        0,
        @tipoEncomendaId
      );
      SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;
    `);
    const encomendaId = Number(hRes.recordset[0]?.id);
    if (!Number.isFinite(encomendaId) || encomendaId <= 0) {
      throw new WriteOrderError(
        "SCOPE_IDENTITY() devolveu valor inválido após INSERT em dbo.Encomendas. Inesperado — investigar logs SQL Server.",
        false
      );
    }

    // 8) INSERT linhas — uma a uma, prepared statements parametrizados.
    //    Não usamos batch para manter logs por linha em caso de falha.
    const insertedLineIds: number[] = [];
    for (const l of resolved) {
      const lReq = new sql.Request(tx);
      lReq.input("encId", sql.Int, encomendaId);
      lReq.input("codigoId", sql.Int, l.codigoId);
      lReq.input("qty", sql.Int, l.quantidade);
      lReq.input("encForn", sql.Int, oc.fornecedorIdForOrders);
      lReq.input("pvp", sql.Decimal(8, 2), l.pvp);
      lReq.input("pmc", sql.Decimal(8, 2), l.pmc);
      lReq.input("precoCusto", sql.Decimal(8, 2), l.precoCusto);

      const lRes = await lReq.query<{ id: number }>(`
        INSERT INTO [dbo].[Encomendas Detalhe] (
          [Encomenda ID],
          [CodigoID],
          [Quantidade],
          [Bonus],
          [Enc Fornecedor ID],
          [Confirmada],
          [Preco Venda Publico_EUR],
          [PMC_EUR],
          [PrecoCusto],
          [LinhaInactiva]
        ) VALUES (
          @encId, @codigoId, @qty, 0, @encForn, 0, @pvp, @pmc, @precoCusto, 0
        );
        SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;
      `);
      const detalheId = Number(lRes.recordset[0]?.id);
      if (!Number.isFinite(detalheId) || detalheId <= 0) {
        throw new WriteOrderError(
          `SCOPE_IDENTITY() devolveu valor inválido após INSERT linha (produto ${l.designacao ?? l.produtoId}).`,
          false
        );
      }
      insertedLineIds.push(detalheId);
    }

    // 9) Commit OU rollback (dry-run)
    if (options.dryRun) {
      await tx.rollback();
    } else {
      await tx.commit();
    }

    return {
      spharmDocumentId: String(encomendaId),
      durationMs: Date.now() - startedAt,
      details: {
        mode: "insert",
        source: options.dryRun ? "created-rollback" : "created",
        outboxId: order.outboxId,
        encomendaId,
        nEncomenda,
        lineCount: resolved.length,
        insertedLineIds,
        fornecedorId: oc.fornecedorIdForOrders,
        userId: oc.userIdForInsert,
        armazemId: oc.armazemId,
        situacaoInitial: oc.encomendaSituacaoInitial,
        tipoEncomendaId: oc.tipoEncomendaId,
        idempotencyColumn: oc.idempotencyColumn,
        dryRun: options.dryRun ?? false,
        resolvedLines: resolved.map((r) => ({
          produtoId: r.produtoId,
          cnp: r.cnp,
          designacao: r.designacao,
          codigoId: r.codigoId,
          quantidade: r.quantidade,
          pvp: r.pvp,
          pmc: r.pmc,
        })),
      },
      source: "created",
    };
  } catch (err) {
    // Rollback defensivo — qualquer caminho de erro reverte
    try {
      await tx.rollback();
    } catch {
      // Pode falhar se a tx já estiver fechada (caso commit/rollback
      // bem-sucedido seguido de outro erro inesperado). Ignorar.
    }
    if (err instanceof WriteOrderError) throw err;
    const errObj = err as { code?: string; number?: number; message?: string };
    const retryable = isRetryableSqlError(errObj);
    throw new WriteOrderError(
      `Falha ao escrever encomenda em SPharm: ${err instanceof Error ? err.message : String(err)}`,
      retryable,
      { code: errObj.code, number: errObj.number, message: errObj.message }
    );
  }
}

// ─── Entry point ─────────────────────────────────────────────────────

export async function writeOrderToSpharm(
  order: PendingOrder,
  cfg: AgentConfig,
  pool: SqlPool | null,
  options: WriteOptions = {}
): Promise<WriteOrderResult> {
  const mode: OrdersWriteMode = cfg.ordersWriteMode ?? "stub";
  if (mode === "stub") return writeStub(order, cfg, options);
  if (mode === "insert") {
    if (!pool) {
      throw new WriteOrderError(
        "ordersWriteMode=insert requer pool SQL Server aberto, mas pool=null. Verifica sql-client.",
        false
      );
    }
    return writeInsert(order, cfg, pool, options);
  }
  throw new WriteOrderError(`ordersWriteMode desconhecido: ${String(mode)}`, false);
}

/**
 * Validação manual da config — útil para o caller decidir se pode
 * sequer abrir o pool antes de invocar writeOrderToSpharm. Não atira;
 * devolve lista de problemas. Vazia = OK.
 */
export function describeOrdersWriteMode(cfg: AgentConfig): {
  mode: OrdersWriteMode;
  needsSqlPool: boolean;
  configIssues: string[];
} {
  const mode: OrdersWriteMode = cfg.ordersWriteMode ?? "stub";
  const issues: string[] = [];
  if (mode === "insert" && !cfg.ordersInsert) {
    issues.push("ordersInsert config em falta — modo insert exige todos os campos populados.");
  }
  return {
    mode,
    needsSqlPool: mode === "insert",
    configIssues: issues,
  };
}
