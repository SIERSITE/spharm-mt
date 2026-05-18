/**
 * agent/src/commands/inspect-compras-lookups.ts
 *
 * Probe READ-ONLY focado nos lookups + amostras reais que ficaram em
 * aberto após o inspect-compras-schema (rev22/rev23). Cobre:
 *
 *   1. dbo.Fornecedores         — schema completo + TOP 20 activos
 *   2. dbo.Tipo Documento       — schema + cross-reference contra
 *                                 Recepcao.FornecedorTipoDocumentoID e
 *                                 Devolucao.FornecedorTipoDocumentoID
 *   3. Amostras pós-data-corte  — Recepcao + Recepcao Detalhe e
 *                                 Devolucao + Devolucao Detalhe filtrados
 *                                 por Data Recepcao/Data Devolucao >= corte
 *                                 (default 2024-01-01) e situação <> 'A'
 *   4. Fórmulas                 — Recepcao Detalhe: Quantidade × Valor_EUR
 *                                 vs Valor_EUR; Devolucao Detalhe: Qt
 *                                 Enviada × PVF_EUR vs Valor
 *   5. Estados                  — COUNT por RecepcaoSituacaoID e
 *                                 DevolucaoSituacaoID (total e pós-corte)
 *   6. Orphans                  — JOIN/NOT EXISTS para verificar FKs
 *                                 declaradas E implícitas (Stocks)
 *
 * Não escreve nada. Não envia para a SaaS.
 *
 * Output:
 *   · stdout — sumário compacto por secção
 *   · ficheiro markdown `<outputDir>/compras-lookups-<YYYY-MM-DD>/inspection.md`
 *
 * Pré-requisito: SQL login com db_datareader (mesmo nível que os outros
 * inspect-*). Nenhum CREATE/INSERT/UPDATE/DELETE em qualquer ponto.
 *
 * Args:
 *   --data-corte YYYY-MM-DD   (default: 2024-01-01)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import sql from "mssql";
import { loadConfig, type AgentConfig } from "../config.js";
import { withPool, type SqlPool } from "../sql-client.js";
import {
  tableExists,
  listColumns,
  estimateRowCount,
  listPrimaryKey,
  listIndexes,
  parseTableArg,
  parseDateArg,
  renderColumnType,
  formatCell,
  type ColumnMeta,
  type IndexEdge,
} from "./probe-helpers.js";

const RULE = "─".repeat(72);
const DEFAULT_DATA_CORTE = "2024-01-01";

// Tabelas que entram neste probe (já confirmadas reais em rev22/rev23).
const TBL_FORNECEDORES = "dbo.Fornecedores";
const TBL_TIPO_DOC = "dbo.Tipo Documento";
const TBL_RECEPCAO = "dbo.Recepcao";
const TBL_RECEPCAO_DET = "dbo.Recepcao Detalhe";
const TBL_DEVOLUCAO = "dbo.Devolucao";
const TBL_DEVOLUCAO_DET = "dbo.Devolucao Detalhe";
const TBL_STOCKS = "dbo.Stocks";

// ── Args ──────────────────────────────────────────────────────────────

type Args = {
  dataCorte: string;
  help: boolean;
};

function parseCmdArgs(): Args {
  const raw = parseArgs({
    args: process.argv.slice(3),
    options: {
      "data-corte": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  const dataCorte =
    typeof raw.values["data-corte"] === "string"
      ? parseDateArg("--data-corte", raw.values["data-corte"]) ?? DEFAULT_DATA_CORTE
      : DEFAULT_DATA_CORTE;
  return { dataCorte, help: raw.values.help === true };
}

function printHelp(): void {
  console.log("Uso: inspect-compras-lookups [--data-corte YYYY-MM-DD]");
  console.log("");
  console.log("Probe READ-ONLY focado em:");
  console.log(`  · ${TBL_FORNECEDORES}      schema + TOP 20 activos`);
  console.log(`  · ${TBL_TIPO_DOC}      schema + cross-ref Recepcao/Devolucao`);
  console.log(`  · Amostras reais pós data-corte (default ${DEFAULT_DATA_CORTE})`);
  console.log(`  · Validação fórmulas Quantidade × preço`);
  console.log(`  · Contagens por estado (RecepcaoSituacaoID, DevolucaoSituacaoID)`);
  console.log(`  · Orphans: linhas sem header, sem Stocks, sem Fornecedor`);
  console.log("");
  console.log("Garantias: read-only, db_datareader, sem escrita.");
}

// ── Heurística de identificação de colunas em Fornecedores ────────────

type FornecedoresColumnRoles = {
  pk: string | null;
  nomeAbreviado: ColumnMeta | null;
  nomeFornecedor: ColumnMeta | null;
  nif: ColumnMeta | null;
  inactivo: ColumnMeta | null;
  tipoFornecedor: ColumnMeta | null;
};

function classifyFornecedoresColumns(cols: ColumnMeta[], pk: string[]): FornecedoresColumnRoles {
  function find(predicates: ((c: ColumnMeta) => boolean)[]): ColumnMeta | null {
    for (const pred of predicates) {
      const m = cols.find(pred);
      if (m) return m;
    }
    return null;
  }
  const lower = (c: ColumnMeta) => c.name.toLowerCase();

  return {
    pk: pk[0] ?? null,
    nomeAbreviado: find([
      (c) => lower(c).includes("nome") && lower(c).includes("abrev"),
      (c) => lower(c).includes("abrev"),
      (c) => lower(c) === "nome curto" || lower(c) === "alias",
    ]),
    nomeFornecedor: find([
      (c) => lower(c) === "nome fornecedor" || lower(c) === "nome completo",
      (c) => lower(c).includes("nome") && !lower(c).includes("abrev") && !lower(c).includes("contac"),
      (c) => lower(c).includes("designac"),
    ]),
    nif: find([
      (c) => lower(c) === "nif" || lower(c) === "n.contribuinte" || lower(c) === "contribuinte",
      (c) => lower(c).includes("nif"),
      (c) => lower(c).includes("contribu"),
      (c) => lower(c).includes("fiscal"),
    ]),
    inactivo: find([
      (c) => lower(c) === "inactivo" || lower(c) === "inativo",
      (c) => lower(c).includes("inactiv") || lower(c).includes("inativ"),
      (c) => lower(c).includes("desactiv") || lower(c).includes("desativ"),
      (c) => lower(c).includes("eliminad") || lower(c).includes("anulad"),
    ]),
    tipoFornecedor: find([
      (c) => lower(c) === "tipo de fornecedor" || lower(c) === "tfornecedores id",
      (c) => lower(c).includes("tipo") && lower(c).includes("fornec"),
      (c) => lower(c) === "tfornecedoresid" || lower(c) === "tfornecedoreid",
    ]),
  };
}

// ── Probe data shapes ─────────────────────────────────────────────────

type ColumnDump = {
  exists: boolean;
  rowCount?: number;
  columns?: ColumnMeta[];
  primaryKey?: string[];
  indexes?: IndexEdge[];
};

type FornecedoresProbe = ColumnDump & {
  roles?: FornecedoresColumnRoles;
  top20Active?: Array<Record<string, unknown>>;
  top20Error?: string;
  countActive?: number;
  countInactive?: number;
};

type TipoDocumentoProbe = ColumnDump & {
  allRows?: Array<Record<string, unknown>>;
  recepcaoUsage?: Array<{ id: number; descricao: string | null; cnt: number }>;
  devolucaoUsage?: Array<{ id: number; descricao: string | null; cnt: number }>;
  /** Nome real de coluna de descrição em Tipo Documento (varia por instalação). */
  descricaoColumn?: string;
};

type SamplesProbe = {
  recepcaoSamples?: Array<Record<string, unknown>>;
  recepcaoDetSamples?: Array<Record<string, unknown>>;
  devolucaoSamples?: Array<Record<string, unknown>>;
  devolucaoDetSamples?: Array<Record<string, unknown>>;
  errors: string[];
};

type FormulaProbe = {
  recepcaoLines?: Array<{
    recepcaoId: number;
    detRecpId: number;
    quantidade: number;
    bonus: number;
    valor_EUR: number;
    qt_x_valor: number;
  }>;
  devolucaoLines?: Array<{
    devolucaoDetId: number;
    devolucaoId: number;
    qtEnviada: number;
    qtRecebida: number;
    pvf_EUR: number;
    valor: number;
    qtEnv_x_pvf: number;
  }>;
  errors: string[];
};

type StatesProbe = {
  recepcaoStates?: Array<{ id: string; total: number; postCorte: number }>;
  devolucaoStates?: Array<{ id: string; total: number; postCorte: number }>;
  errors: string[];
};

type OrphanProbe = {
  /** Lista de checks executados — cada um com label, count e amostra. */
  checks: Array<{
    label: string;
    sqlSketch: string;
    count: number | null;
    sample?: Array<Record<string, unknown>>;
    error?: string;
  }>;
};

// ── Probe implementations ─────────────────────────────────────────────

async function probeFornecedores(pool: SqlPool, _cfg: AgentConfig): Promise<FornecedoresProbe> {
  const t = parseTableArg(TBL_FORNECEDORES);
  const exists = await tableExists(pool, t);
  if (!exists) return { exists: false };

  const [cols, rowCount, pk, idx] = await Promise.all([
    listColumns(pool, t),
    estimateRowCount(pool, t),
    listPrimaryKey(pool, t),
    listIndexes(pool, t),
  ]);
  const roles = classifyFornecedoresColumns(cols, pk);

  const probe: FornecedoresProbe = {
    exists: true,
    rowCount,
    columns: cols,
    primaryKey: pk,
    indexes: idx,
    roles,
  };

  // Contagens activos/inactivos (se coluna Inactivo existir)
  if (roles.inactivo) {
    try {
      const r = await pool.request().query<{ inactivo: boolean | number; cnt: number }>(
        `SELECT [${roles.inactivo.name}] AS inactivo, COUNT(*) AS cnt
         FROM [${t.schema}].[${t.table}]
         GROUP BY [${roles.inactivo.name}]`
      );
      let act = 0;
      let inact = 0;
      for (const row of r.recordset) {
        const v = Number(row.inactivo);
        if (v === 1) inact += row.cnt;
        else act += row.cnt;
      }
      probe.countActive = act;
      probe.countInactive = inact;
    } catch (err) {
      // Não-fatal — só não mostramos contagem.
      probe.top20Error = err instanceof Error ? err.message : String(err);
    }
  }

  // TOP 20 — usando colunas inferidas + PK
  try {
    const selectCols: string[] = [];
    const want: Array<ColumnMeta | { name: string } | null> = [
      roles.pk ? { name: roles.pk } : null,
      roles.nomeAbreviado,
      roles.nomeFornecedor,
      roles.nif,
      roles.inactivo,
      roles.tipoFornecedor,
    ];
    for (const c of want) {
      if (c) selectCols.push(`[${c.name}]`);
    }
    if (selectCols.length === 0) {
      // Sem colunas inferidas — fallback a SELECT *
      selectCols.push("*");
    }
    const where = roles.inactivo
      ? `WHERE [${roles.inactivo.name}] = 0`
      : "";
    const orderBy = roles.pk ? `ORDER BY [${roles.pk}] ASC` : "";
    const query =
      `SELECT TOP 20 ${selectCols.join(", ")} FROM [${t.schema}].[${t.table}] ${where} ${orderBy}`.trim();
    const r = await pool.request().query<Record<string, unknown>>(query);
    probe.top20Active = r.recordset;
  } catch (err) {
    probe.top20Error = err instanceof Error ? err.message : String(err);
  }

  return probe;
}

async function probeTipoDocumento(pool: SqlPool, _cfg: AgentConfig): Promise<TipoDocumentoProbe> {
  const t = parseTableArg(TBL_TIPO_DOC);
  const exists = await tableExists(pool, t);
  if (!exists) return { exists: false };

  const [cols, rowCount, pk, idx] = await Promise.all([
    listColumns(pool, t),
    estimateRowCount(pool, t),
    listPrimaryKey(pool, t),
    listIndexes(pool, t),
  ]);

  // Descrição: procura coluna com "descric"/"nome"/"tipo doc" no nome.
  const descriptionCol =
    cols.find((c) => c.name.toLowerCase().includes("descric")) ??
    cols.find((c) => c.name.toLowerCase() === "tipo documento") ??
    cols.find((c) => c.name.toLowerCase().includes("nome")) ??
    null;

  const probe: TipoDocumentoProbe = {
    exists: true,
    rowCount,
    columns: cols,
    primaryKey: pk,
    indexes: idx,
    descricaoColumn: descriptionCol?.name,
  };

  try {
    const r = await pool.request().query<Record<string, unknown>>(
      `SELECT * FROM [${t.schema}].[${t.table}] ORDER BY ${pk[0] ? `[${pk[0]}]` : "1"}`
    );
    probe.allRows = r.recordset;
  } catch (err) {
    return { ...probe };
  }

  // Cross-reference Recepcao
  try {
    const pkCol = pk[0] ?? "Tipo Documento ID";
    const descSql = descriptionCol ? `td.[${descriptionCol.name}]` : "NULL";
    const r = await pool.request().query<{ id: number; descricao: string | null; cnt: number }>(
      `SELECT r.[FornecedorTipoDocumentoID] AS id,
              ${descSql} AS descricao,
              COUNT(*) AS cnt
       FROM [dbo].[Recepcao] r
       LEFT JOIN [${t.schema}].[${t.table}] td ON td.[${pkCol}] = r.[FornecedorTipoDocumentoID]
       GROUP BY r.[FornecedorTipoDocumentoID], ${descSql}
       ORDER BY COUNT(*) DESC`
    );
    probe.recepcaoUsage = r.recordset;
  } catch {
    // Não-fatal
  }

  // Cross-reference Devolucao
  try {
    const pkCol = pk[0] ?? "Tipo Documento ID";
    const descSql = descriptionCol ? `td.[${descriptionCol.name}]` : "NULL";
    const r = await pool.request().query<{ id: number; descricao: string | null; cnt: number }>(
      `SELECT d.[FornecedorTipoDocumentoID] AS id,
              ${descSql} AS descricao,
              COUNT(*) AS cnt
       FROM [dbo].[Devolucao] d
       LEFT JOIN [${t.schema}].[${t.table}] td ON td.[${pkCol}] = d.[FornecedorTipoDocumentoID]
       GROUP BY d.[FornecedorTipoDocumentoID], ${descSql}
       ORDER BY COUNT(*) DESC`
    );
    probe.devolucaoUsage = r.recordset;
  } catch {
    // Não-fatal
  }

  return probe;
}

async function probeSamples(pool: SqlPool, dataCorte: string): Promise<SamplesProbe> {
  const out: SamplesProbe = { errors: [] };

  // Recepcao TOP 10 mais recentes pós-corte, não-anuladas, não-resumo
  try {
    const r = await pool
      .request()
      .input("dt", sql.NVarChar, dataCorte)
      .query<Record<string, unknown>>(
        `SELECT TOP 10 *
         FROM [dbo].[Recepcao]
         WHERE [Data Recepcao] >= @dt
           AND [RecepcaoSituacaoID] = 'N'
         ORDER BY [Data Recepcao] DESC, [Recepcao ID] DESC`
      );
    out.recepcaoSamples = r.recordset;

    // Linhas correspondentes
    if (r.recordset.length > 0) {
      const ids = r.recordset.map((row) => Number((row as Record<string, unknown>)["Recepcao ID"]));
      const placeholders = ids.map((_, i) => `@id${i}`).join(",");
      const req = pool.request();
      ids.forEach((id, i) => req.input(`id${i}`, sql.Int, id));
      const rDet = await req.query<Record<string, unknown>>(
        `SELECT *
         FROM [dbo].[Recepcao Detalhe]
         WHERE [Recepcao ID] IN (${placeholders})
         ORDER BY [Recepcao ID] DESC, [Sequencia] ASC`
      );
      // Cap a 30 linhas no markdown
      out.recepcaoDetSamples = rDet.recordset.slice(0, 30);
    }
  } catch (err) {
    out.errors.push(`Recepcao samples: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Devolucao TOP 10 mais recentes pós-corte, não-anuladas
  try {
    const r = await pool
      .request()
      .input("dt", sql.NVarChar, dataCorte)
      .query<Record<string, unknown>>(
        `SELECT TOP 10 *
         FROM [dbo].[Devolucao]
         WHERE [Data Devolucao] >= @dt
           AND [DevolucaoSituacaoID] <> 'A'
         ORDER BY [Data Devolucao] DESC, [Devolucao ID] DESC`
      );
    out.devolucaoSamples = r.recordset;

    if (r.recordset.length > 0) {
      const ids = r.recordset.map((row) => Number((row as Record<string, unknown>)["Devolucao ID"]));
      const placeholders = ids.map((_, i) => `@id${i}`).join(",");
      const req = pool.request();
      ids.forEach((id, i) => req.input(`id${i}`, sql.Int, id));
      const rDet = await req.query<Record<string, unknown>>(
        `SELECT *
         FROM [dbo].[Devolucao Detalhe]
         WHERE [Devolucao ID] IN (${placeholders})
         ORDER BY [Devolucao ID] DESC, [Sequencia] ASC`
      );
      out.devolucaoDetSamples = rDet.recordset.slice(0, 30);
    }
  } catch (err) {
    out.errors.push(`Devolucao samples: ${err instanceof Error ? err.message : String(err)}`);
  }

  return out;
}

async function probeFormulas(pool: SqlPool, dataCorte: string): Promise<FormulaProbe> {
  const out: FormulaProbe = { errors: [] };

  // Recepcao Detalhe: TOP 20 linhas pós-corte com Quantidade > 1
  // (para diferenciar valor_unit vs valor_total visualmente)
  try {
    const r = await pool
      .request()
      .input("dt", sql.NVarChar, dataCorte)
      .query<{
        RecepcaoID: number;
        DetRecpID: number;
        Quantidade: number;
        Bonus: number;
        Valor_EUR: number;
      }>(
        `SELECT TOP 20
           rd.[Recepcao ID]      AS RecepcaoID,
           rd.[Detalhe  Recp ID] AS DetRecpID,
           rd.[Quantidade]       AS Quantidade,
           rd.[Bonus]            AS Bonus,
           rd.[Valor_EUR]        AS Valor_EUR
         FROM [dbo].[Recepcao Detalhe] rd
         INNER JOIN [dbo].[Recepcao] r ON r.[Recepcao ID] = rd.[Recepcao ID]
         WHERE r.[Data Recepcao] >= @dt
           AND r.[RecepcaoSituacaoID] = 'N'
           AND rd.[Quantidade] > 1
           AND rd.[Valor_EUR] > 0
         ORDER BY r.[Data Recepcao] DESC, rd.[Detalhe  Recp ID] DESC`
      );
    out.recepcaoLines = r.recordset.map((row) => ({
      recepcaoId: Number(row.RecepcaoID),
      detRecpId: Number(row.DetRecpID),
      quantidade: Number(row.Quantidade),
      bonus: Number(row.Bonus),
      valor_EUR: Number(row.Valor_EUR),
      qt_x_valor: round2(Number(row.Quantidade) * Number(row.Valor_EUR)),
    }));
  } catch (err) {
    out.errors.push(`Recepcao Detalhe formula: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Devolucao Detalhe: TOP 20 linhas pós-corte
  try {
    const r = await pool
      .request()
      .input("dt", sql.NVarChar, dataCorte)
      .query<{
        DevDetID: number;
        DevID: number;
        QtEnviada: number;
        QtRecebida: number;
        PVF_EUR: number;
        Valor: number;
      }>(
        `SELECT TOP 20
           dd.[Devolucao Detalhe ID] AS DevDetID,
           dd.[Devolucao ID]         AS DevID,
           dd.[Quantidade Enviada]   AS QtEnviada,
           dd.[Quantidade Recebida]  AS QtRecebida,
           dd.[PVF_EUR]              AS PVF_EUR,
           dd.[Valor]                AS Valor
         FROM [dbo].[Devolucao Detalhe] dd
         INNER JOIN [dbo].[Devolucao] d ON d.[Devolucao ID] = dd.[Devolucao ID]
         WHERE d.[Data Devolucao] >= @dt
           AND d.[DevolucaoSituacaoID] <> 'A'
           AND dd.[Quantidade Enviada] > 1
         ORDER BY d.[Data Devolucao] DESC, dd.[Devolucao Detalhe ID] DESC`
      );
    out.devolucaoLines = r.recordset.map((row) => ({
      devolucaoDetId: Number(row.DevDetID),
      devolucaoId: Number(row.DevID),
      qtEnviada: Number(row.QtEnviada),
      qtRecebida: Number(row.QtRecebida),
      pvf_EUR: Number(row.PVF_EUR),
      valor: Number(row.Valor),
      qtEnv_x_pvf: round2(Number(row.QtEnviada) * Number(row.PVF_EUR)),
    }));
  } catch (err) {
    out.errors.push(`Devolucao Detalhe formula: ${err instanceof Error ? err.message : String(err)}`);
  }

  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function probeStates(pool: SqlPool, dataCorte: string): Promise<StatesProbe> {
  const out: StatesProbe = { errors: [] };

  try {
    const r = await pool
      .request()
      .input("dt", sql.NVarChar, dataCorte)
      .query<{ id: string; total: number; postCorte: number }>(
        `SELECT [RecepcaoSituacaoID] AS id,
                COUNT(*) AS total,
                SUM(CASE WHEN [Data Recepcao] >= @dt THEN 1 ELSE 0 END) AS postCorte
         FROM [dbo].[Recepcao]
         GROUP BY [RecepcaoSituacaoID]
         ORDER BY total DESC`
      );
    out.recepcaoStates = r.recordset.map((row) => ({
      id: row.id,
      total: Number(row.total),
      postCorte: Number(row.postCorte),
    }));
  } catch (err) {
    out.errors.push(`Recepcao states: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const r = await pool
      .request()
      .input("dt", sql.NVarChar, dataCorte)
      .query<{ id: string; total: number; postCorte: number }>(
        `SELECT [DevolucaoSituacaoID] AS id,
                COUNT(*) AS total,
                SUM(CASE WHEN [Data Devolucao] >= @dt THEN 1 ELSE 0 END) AS postCorte
         FROM [dbo].[Devolucao]
         GROUP BY [DevolucaoSituacaoID]
         ORDER BY total DESC`
      );
    out.devolucaoStates = r.recordset.map((row) => ({
      id: row.id,
      total: Number(row.total),
      postCorte: Number(row.postCorte),
    }));
  } catch (err) {
    out.errors.push(`Devolucao states: ${err instanceof Error ? err.message : String(err)}`);
  }

  return out;
}

async function probeOrphans(pool: SqlPool): Promise<OrphanProbe> {
  const out: OrphanProbe = { checks: [] };

  type Check = {
    label: string;
    sqlSketch: string;
    countQuery: string;
    sampleQuery: string;
  };
  const checks: Check[] = [
    {
      label: "Recepcao Detalhe sem Recepcao header",
      sqlSketch:
        "Recepcao Detalhe rd WHERE NOT EXISTS (SELECT 1 FROM Recepcao r WHERE r.[Recepcao ID] = rd.[Recepcao ID])",
      countQuery:
        `SELECT COUNT_BIG(*) AS cnt FROM [dbo].[Recepcao Detalhe] rd
         WHERE NOT EXISTS (SELECT 1 FROM [dbo].[Recepcao] r WHERE r.[Recepcao ID] = rd.[Recepcao ID])`,
      sampleQuery:
        `SELECT TOP 5 rd.[Detalhe  Recp ID], rd.[Recepcao ID], rd.[CodigoID], rd.[Quantidade]
         FROM [dbo].[Recepcao Detalhe] rd
         WHERE NOT EXISTS (SELECT 1 FROM [dbo].[Recepcao] r WHERE r.[Recepcao ID] = rd.[Recepcao ID])`,
    },
    {
      label: "Recepcao Detalhe sem Stocks (CodigoID órfão)",
      sqlSketch:
        "Recepcao Detalhe rd WHERE NOT EXISTS (SELECT 1 FROM Stocks s WHERE s.[CodigoID] = rd.[CodigoID])",
      countQuery:
        `SELECT COUNT_BIG(*) AS cnt FROM [dbo].[Recepcao Detalhe] rd
         WHERE NOT EXISTS (SELECT 1 FROM [dbo].[Stocks] s WHERE s.[CodigoID] = rd.[CodigoID])`,
      sampleQuery:
        `SELECT TOP 5 rd.[Detalhe  Recp ID], rd.[Recepcao ID], rd.[CodigoID], rd.[Quantidade]
         FROM [dbo].[Recepcao Detalhe] rd
         WHERE NOT EXISTS (SELECT 1 FROM [dbo].[Stocks] s WHERE s.[CodigoID] = rd.[CodigoID])`,
    },
    {
      label: "Devolucao Detalhe sem Devolucao header",
      sqlSketch:
        "Devolucao Detalhe dd WHERE NOT EXISTS (SELECT 1 FROM Devolucao d WHERE d.[Devolucao ID] = dd.[Devolucao ID])",
      countQuery:
        `SELECT COUNT_BIG(*) AS cnt FROM [dbo].[Devolucao Detalhe] dd
         WHERE NOT EXISTS (SELECT 1 FROM [dbo].[Devolucao] d WHERE d.[Devolucao ID] = dd.[Devolucao ID])`,
      sampleQuery:
        `SELECT TOP 5 dd.[Devolucao Detalhe ID], dd.[Devolucao ID], dd.[CodigoID], dd.[Quantidade Enviada]
         FROM [dbo].[Devolucao Detalhe] dd
         WHERE NOT EXISTS (SELECT 1 FROM [dbo].[Devolucao] d WHERE d.[Devolucao ID] = dd.[Devolucao ID])`,
    },
    {
      label: "Devolucao Detalhe sem Stocks (CodigoID órfão)",
      sqlSketch:
        "Devolucao Detalhe dd WHERE NOT EXISTS (SELECT 1 FROM Stocks s WHERE s.[CodigoID] = dd.[CodigoID])",
      countQuery:
        `SELECT COUNT_BIG(*) AS cnt FROM [dbo].[Devolucao Detalhe] dd
         WHERE NOT EXISTS (SELECT 1 FROM [dbo].[Stocks] s WHERE s.[CodigoID] = dd.[CodigoID])`,
      sampleQuery:
        `SELECT TOP 5 dd.[Devolucao Detalhe ID], dd.[Devolucao ID], dd.[CodigoID], dd.[Quantidade Enviada]
         FROM [dbo].[Devolucao Detalhe] dd
         WHERE NOT EXISTS (SELECT 1 FROM [dbo].[Stocks] s WHERE s.[CodigoID] = dd.[CodigoID])`,
    },
    {
      label: "Recepcao sem Fornecedor (Fornecedor ID órfão)",
      sqlSketch:
        "Recepcao r WHERE NOT EXISTS (SELECT 1 FROM Fornecedores f WHERE f.[Fornecedor ID] = r.[Fornecedor ID])",
      countQuery:
        `SELECT COUNT_BIG(*) AS cnt FROM [dbo].[Recepcao] r
         WHERE NOT EXISTS (SELECT 1 FROM [dbo].[Fornecedores] f WHERE f.[Fornecedor ID] = r.[Fornecedor ID])`,
      sampleQuery:
        `SELECT TOP 5 r.[Recepcao ID], r.[Fornecedor ID], r.[Data Recepcao]
         FROM [dbo].[Recepcao] r
         WHERE NOT EXISTS (SELECT 1 FROM [dbo].[Fornecedores] f WHERE f.[Fornecedor ID] = r.[Fornecedor ID])`,
    },
    {
      label: "Devolucao sem Fornecedor (Fornecedor ID órfão)",
      sqlSketch:
        "Devolucao d WHERE NOT EXISTS (SELECT 1 FROM Fornecedores f WHERE f.[Fornecedor ID] = d.[Fornecedor ID])",
      countQuery:
        `SELECT COUNT_BIG(*) AS cnt FROM [dbo].[Devolucao] d
         WHERE NOT EXISTS (SELECT 1 FROM [dbo].[Fornecedores] f WHERE f.[Fornecedor ID] = d.[Fornecedor ID])`,
      sampleQuery:
        `SELECT TOP 5 d.[Devolucao ID], d.[Fornecedor ID], d.[Data Devolucao]
         FROM [dbo].[Devolucao] d
         WHERE NOT EXISTS (SELECT 1 FROM [dbo].[Fornecedores] f WHERE f.[Fornecedor ID] = d.[Fornecedor ID])`,
    },
  ];

  for (const c of checks) {
    const result: OrphanProbe["checks"][number] = {
      label: c.label,
      sqlSketch: c.sqlSketch,
      count: null,
    };
    try {
      const r = await pool.request().query<{ cnt: number }>(c.countQuery);
      result.count = Number(r.recordset[0]?.cnt ?? 0);
      if (result.count > 0) {
        try {
          const rs = await pool.request().query<Record<string, unknown>>(c.sampleQuery);
          result.sample = rs.recordset;
        } catch (err) {
          result.error = `sample falhou: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
    }
    out.checks.push(result);
  }

  return out;
}

// ── Markdown render ───────────────────────────────────────────────────

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function renderColumnTable(cols: ColumnMeta[]): string[] {
  const lines: string[] = [];
  lines.push("| # | Nome | Tipo | Nullable |");
  lines.push("|---:|---|---|:-:|");
  cols.forEach((c, i) => {
    lines.push(`| ${i + 1} | \`${c.name}\` | ${renderColumnType(c)} | ${c.nullable ? "Y" : "N"} |`);
  });
  return lines;
}

function renderRowsBlock(
  rows: Array<Record<string, unknown>> | undefined,
  columnNames: string[] | undefined
): string[] {
  const lines: string[] = [];
  if (!rows || rows.length === 0) {
    lines.push("> (sem linhas)");
    return lines;
  }
  lines.push("```");
  const keys = columnNames && columnNames.length > 0 ? columnNames : Object.keys(rows[0]!);
  const colWidth = Math.min(32, Math.max(...keys.map((k) => k.length)));
  for (const [i, row] of rows.entries()) {
    lines.push(`── linha ${i + 1} ──`);
    for (const k of keys) {
      const v = formatCell(row[k]);
      lines.push(`  ${k.padEnd(colWidth)}  ${v}`);
    }
  }
  lines.push("```");
  return lines;
}

function renderMarkdown(
  cfg: AgentConfig,
  dataCorte: string,
  fornecedores: FornecedoresProbe,
  tipoDoc: TipoDocumentoProbe,
  samples: SamplesProbe,
  formulas: FormulaProbe,
  states: StatesProbe,
  orphans: OrphanProbe
): string {
  const lines: string[] = [];
  const now = new Date();
  lines.push("# SPharm ERP — Compras/Devoluções: lookups + amostras reais");
  lines.push("");
  lines.push(`- **Capturado em**: ${now.toISOString()}`);
  lines.push(`- **Database**: \`${cfg.sqlDatabase}@${cfg.sqlHost}:${cfg.sqlPort}\``);
  lines.push(`- **Agent rev**: ${process.env.AGENT_REV ?? "?"}`);
  lines.push(`- **Data-corte**: \`${dataCorte}\` (amostras filtradas a partir desta data)`);
  lines.push("");
  lines.push("Probe **read-only** (db_datareader). Nenhuma escrita no SPharm. Nada enviado para a SaaS.");
  lines.push("");
  lines.push("Complementa o `inspect-compras-schema` (rev22/rev23) com:");
  lines.push("- schema completo de `dbo.Fornecedores` e `dbo.Tipo Documento`");
  lines.push("- amostras reais pós-data-corte (em vez de entries sintéticas pré-2017)");
  lines.push("- validação visual das fórmulas Quantidade × preço");
  lines.push("- contagens por estado");
  lines.push("- detecção de orphans (FKs declaradas e implícitas)");
  lines.push("");

  // ── 1. Fornecedores ─────────────────────────────────────────────
  lines.push("## 1. `dbo.Fornecedores`");
  lines.push("");
  if (!fornecedores.exists) {
    lines.push("> ❌ Tabela não existe nesta base de dados.");
    lines.push("");
  } else {
    lines.push(`- Row count (estimativa): **${fornecedores.rowCount}**`);
    lines.push(
      `- Primary key: ${fornecedores.primaryKey && fornecedores.primaryKey.length > 0 ? "`" + fornecedores.primaryKey.join(", ") + "`" : "(sem PK declarada)"}`
    );
    if (fornecedores.countActive !== undefined || fornecedores.countInactive !== undefined) {
      lines.push(
        `- Activos vs Inactivos: **${fornecedores.countActive ?? "?"}** activos · **${fornecedores.countInactive ?? "?"}** inactivos`
      );
    }
    lines.push("");

    if (fornecedores.roles) {
      lines.push("**Colunas inferidas (heurística):**");
      lines.push("");
      lines.push("| Papel | Coluna detectada |");
      lines.push("|---|---|");
      lines.push(`| PK | ${fornecedores.roles.pk ? "`" + fornecedores.roles.pk + "`" : "**(não inferido)**"} |`);
      lines.push(
        `| Nome abreviado | ${fornecedores.roles.nomeAbreviado ? "`" + fornecedores.roles.nomeAbreviado.name + "` (" + renderColumnType(fornecedores.roles.nomeAbreviado) + ")" : "**(não inferido)**"} |`
      );
      lines.push(
        `| Nome fornecedor | ${fornecedores.roles.nomeFornecedor ? "`" + fornecedores.roles.nomeFornecedor.name + "` (" + renderColumnType(fornecedores.roles.nomeFornecedor) + ")" : "**(não inferido)**"} |`
      );
      lines.push(
        `| NIF | ${fornecedores.roles.nif ? "`" + fornecedores.roles.nif.name + "` (" + renderColumnType(fornecedores.roles.nif) + ")" : "**(não inferido)**"} |`
      );
      lines.push(
        `| Inactivo | ${fornecedores.roles.inactivo ? "`" + fornecedores.roles.inactivo.name + "` (" + renderColumnType(fornecedores.roles.inactivo) + ")" : "**(não inferido)**"} |`
      );
      lines.push(
        `| Tipo de Fornecedor | ${fornecedores.roles.tipoFornecedor ? "`" + fornecedores.roles.tipoFornecedor.name + "` (" + renderColumnType(fornecedores.roles.tipoFornecedor) + ")" : "**(não inferido)**"} |`
      );
      lines.push("");
    }

    if (fornecedores.columns && fornecedores.columns.length > 0) {
      lines.push("**Schema completo:**");
      lines.push("");
      lines.push(...renderColumnTable(fornecedores.columns));
      lines.push("");
    }

    if (fornecedores.indexes && fornecedores.indexes.length > 0) {
      lines.push(`**Índices não-PK (${fornecedores.indexes.length}):**`);
      lines.push("");
      for (const ix of fornecedores.indexes) {
        const uniq = ix.isUnique ? " UNIQUE" : "";
        lines.push(`- \`${ix.name}\` (${ix.type}${uniq}): ${ix.columns.map((c) => "`" + c + "`").join(", ")}`);
      }
      lines.push("");
    }

    lines.push("**TOP 20 fornecedores activos** (ordenados por PK ascending):");
    lines.push("");
    if (fornecedores.top20Error) {
      lines.push(`> ❌ Falhou: ${fornecedores.top20Error}`);
      lines.push("");
    } else {
      const wantedCols = [
        fornecedores.roles?.pk,
        fornecedores.roles?.nomeAbreviado?.name,
        fornecedores.roles?.nomeFornecedor?.name,
        fornecedores.roles?.nif?.name,
        fornecedores.roles?.inactivo?.name,
        fornecedores.roles?.tipoFornecedor?.name,
      ].filter((s): s is string => typeof s === "string" && s.length > 0);
      lines.push(...renderRowsBlock(fornecedores.top20Active, wantedCols));
      lines.push("");
    }
  }

  // ── 2. Tipo Documento ───────────────────────────────────────────
  lines.push("## 2. `dbo.Tipo Documento`");
  lines.push("");
  if (!tipoDoc.exists) {
    lines.push("> ❌ Tabela não existe nesta base de dados.");
    lines.push("");
  } else {
    lines.push(`- Row count: **${tipoDoc.rowCount}**`);
    lines.push(
      `- Primary key: ${tipoDoc.primaryKey && tipoDoc.primaryKey.length > 0 ? "`" + tipoDoc.primaryKey.join(", ") + "`" : "(sem PK declarada)"}`
    );
    if (tipoDoc.descricaoColumn) {
      lines.push(`- Coluna de descrição inferida: \`${tipoDoc.descricaoColumn}\``);
    }
    lines.push("");

    if (tipoDoc.columns && tipoDoc.columns.length > 0) {
      lines.push("**Schema completo:**");
      lines.push("");
      lines.push(...renderColumnTable(tipoDoc.columns));
      lines.push("");
    }

    lines.push("**Todas as linhas:**");
    lines.push("");
    lines.push(...renderRowsBlock(tipoDoc.allRows, tipoDoc.columns?.map((c) => c.name)));
    lines.push("");

    // Usage cross-references
    lines.push("**Usado em `dbo.Recepcao` (`FornecedorTipoDocumentoID`):**");
    lines.push("");
    if (!tipoDoc.recepcaoUsage || tipoDoc.recepcaoUsage.length === 0) {
      lines.push("> (sem cross-reference disponível)");
    } else {
      lines.push("| ID | Descrição | Count |");
      lines.push("|---:|---|---:|");
      for (const u of tipoDoc.recepcaoUsage) {
        const desc = u.descricao === null || u.descricao === undefined ? "*(sem entrada em Tipo Documento)*" : String(u.descricao);
        const id = u.id === null || u.id === undefined ? "*(NULL)*" : String(u.id);
        lines.push(`| ${id} | ${desc} | ${u.cnt} |`);
      }
    }
    lines.push("");

    lines.push("**Usado em `dbo.Devolucao` (`FornecedorTipoDocumentoID`):**");
    lines.push("");
    if (!tipoDoc.devolucaoUsage || tipoDoc.devolucaoUsage.length === 0) {
      lines.push("> (sem cross-reference disponível)");
    } else {
      lines.push("| ID | Descrição | Count |");
      lines.push("|---:|---|---:|");
      for (const u of tipoDoc.devolucaoUsage) {
        const desc = u.descricao === null || u.descricao === undefined ? "*(sem entrada em Tipo Documento)*" : String(u.descricao);
        const id = u.id === null || u.id === undefined ? "*(NULL)*" : String(u.id);
        lines.push(`| ${id} | ${desc} | ${u.cnt} |`);
      }
    }
    lines.push("");
  }

  // ── 3. Amostras pós-data-corte ──────────────────────────────────
  lines.push(`## 3. Amostras reais (pós \`${dataCorte}\`)`);
  lines.push("");
  if (samples.errors.length > 0) {
    for (const e of samples.errors) lines.push(`> ⚠ ${e}`);
    lines.push("");
  }

  lines.push("### 3.1 `dbo.Recepcao` (TOP 10, ordenado por `Data Recepcao DESC`)");
  lines.push("");
  lines.push("Filtro: `[Data Recepcao] >= data-corte AND [RecepcaoSituacaoID] = 'N'`");
  lines.push("");
  lines.push(...renderRowsBlock(samples.recepcaoSamples, undefined));
  lines.push("");

  lines.push("### 3.2 `dbo.Recepcao Detalhe` (linhas para os mesmos `Recepcao ID`, cap 30)");
  lines.push("");
  lines.push(...renderRowsBlock(samples.recepcaoDetSamples, undefined));
  lines.push("");

  lines.push("### 3.3 `dbo.Devolucao` (TOP 10, ordenado por `Data Devolucao DESC`)");
  lines.push("");
  lines.push("Filtro: `[Data Devolucao] >= data-corte AND [DevolucaoSituacaoID] <> 'A'`");
  lines.push("");
  lines.push(...renderRowsBlock(samples.devolucaoSamples, undefined));
  lines.push("");

  lines.push("### 3.4 `dbo.Devolucao Detalhe` (linhas para os mesmos `Devolucao ID`, cap 30)");
  lines.push("");
  lines.push(...renderRowsBlock(samples.devolucaoDetSamples, undefined));
  lines.push("");

  // ── 4. Validação fórmulas ───────────────────────────────────────
  lines.push("## 4. Validação de fórmulas (TOP 20 com `Quantidade > 1`)");
  lines.push("");
  if (formulas.errors.length > 0) {
    for (const e of formulas.errors) lines.push(`> ⚠ ${e}`);
    lines.push("");
  }

  lines.push("### 4.1 `dbo.Recepcao Detalhe` — `Valor_EUR` é unitário ou total?");
  lines.push("");
  lines.push("Se `Valor_EUR ≈ Quantidade × Valor_EUR` ⇒ valor unitário (linha total = Qt × Valor_EUR).");
  lines.push("Se `Valor_EUR ≈ Quantidade × algo_mais_pequeno` ⇒ valor já é total da linha.");
  lines.push("");
  if (formulas.recepcaoLines && formulas.recepcaoLines.length > 0) {
    lines.push("| Recepcao ID | Det Recp ID | Quantidade | Bonus | Valor_EUR | Qt × Valor_EUR |");
    lines.push("|---:|---:|---:|---:|---:|---:|");
    for (const l of formulas.recepcaoLines) {
      lines.push(`| ${l.recepcaoId} | ${l.detRecpId} | ${l.quantidade} | ${l.bonus} | ${l.valor_EUR} | ${l.qt_x_valor} |`);
    }
    lines.push("");
  } else {
    lines.push("> (sem linhas pós-corte com Quantidade > 1 — verificar data-corte)");
    lines.push("");
  }

  lines.push("### 4.2 `dbo.Devolucao Detalhe` — confirmar `Valor = Quantidade Enviada × PVF_EUR`");
  lines.push("");
  if (formulas.devolucaoLines && formulas.devolucaoLines.length > 0) {
    lines.push("| Dev Det ID | Dev ID | Qt Enviada | Qt Recebida | PVF_EUR | Valor | Qt Env × PVF |");
    lines.push("|---:|---:|---:|---:|---:|---:|---:|");
    for (const l of formulas.devolucaoLines) {
      lines.push(`| ${l.devolucaoDetId} | ${l.devolucaoId} | ${l.qtEnviada} | ${l.qtRecebida} | ${l.pvf_EUR} | ${l.valor} | ${l.qtEnv_x_pvf} |`);
    }
    lines.push("");
  } else {
    lines.push("> (sem linhas pós-corte com Quantidade Enviada > 1)");
    lines.push("");
  }

  // ── 5. Estados ──────────────────────────────────────────────────
  lines.push("## 5. Contagens por estado");
  lines.push("");
  if (states.errors.length > 0) {
    for (const e of states.errors) lines.push(`> ⚠ ${e}`);
    lines.push("");
  }

  lines.push("### 5.1 `dbo.Recepcao` por `RecepcaoSituacaoID`");
  lines.push("");
  if (states.recepcaoStates && states.recepcaoStates.length > 0) {
    lines.push("| ID | Total | Pós data-corte |");
    lines.push("|:-:|---:|---:|");
    for (const s of states.recepcaoStates) {
      lines.push(`| \`${s.id}\` | ${s.total} | ${s.postCorte} |`);
    }
    lines.push("");
  } else {
    lines.push("> (sem dados)");
    lines.push("");
  }

  lines.push("### 5.2 `dbo.Devolucao` por `DevolucaoSituacaoID`");
  lines.push("");
  if (states.devolucaoStates && states.devolucaoStates.length > 0) {
    lines.push("| ID | Total | Pós data-corte |");
    lines.push("|:-:|---:|---:|");
    for (const s of states.devolucaoStates) {
      lines.push(`| \`${s.id}\` | ${s.total} | ${s.postCorte} |`);
    }
    lines.push("");
  } else {
    lines.push("> (sem dados)");
    lines.push("");
  }

  // ── 6. Orphans ──────────────────────────────────────────────────
  lines.push("## 6. Orphans (integridade referencial real vs declarada)");
  lines.push("");
  lines.push("Detecta linhas com referências partidas. Valor 0 = integridade preservada.");
  lines.push("");
  lines.push("| Check | Count órfãos |");
  lines.push("|---|---:|");
  for (const c of orphans.checks) {
    const cnt = c.error ? `❌ ${c.error.slice(0, 40)}` : c.count === null ? "?" : String(c.count);
    lines.push(`| ${c.label} | ${cnt} |`);
  }
  lines.push("");

  for (const c of orphans.checks) {
    if ((c.count ?? 0) > 0 || c.error) {
      lines.push(`### ${c.label}`);
      lines.push("");
      lines.push("```sql");
      lines.push(c.sqlSketch);
      lines.push("```");
      lines.push("");
      if (c.error) {
        lines.push(`> ❌ ${c.error}`);
        lines.push("");
      }
      if (c.sample && c.sample.length > 0) {
        lines.push("**Amostra TOP 5:**");
        lines.push("");
        lines.push(...renderRowsBlock(c.sample, undefined));
        lines.push("");
      }
    }
  }

  // ── Próximo passo ───────────────────────────────────────────────
  lines.push("## Próximo passo");
  lines.push("");
  lines.push("1. Operador SPharm revê secções 1-6.");
  lines.push("2. Confirma:");
  lines.push("   - colunas inferidas em `Fornecedores` (PK, nome, NIF, inactivo, tipo)");
  lines.push("   - quais `Tipo Documento` IDs são canónicos para compras (excluir notas crédito/regularizações se aplicável)");
  lines.push("   - semântica de `Valor_EUR` em `Recepcao Detalhe` (unitário vs total) confirmada pelas amostras 4.1");
  lines.push("   - qualquer orphan count > 0 explica-se como dado legítimo (importações, ad-hoc) ou requer atenção");
  lines.push("3. Admin SPharm.MT recebe este `inspection.md` + respostas e propõe schema staging + endpoints (Fase 1).");
  lines.push("");
  lines.push("**Até Fase 1 autorizada, nada é escrito.** `Compra` e `Devolucao` na SaaS continuam vazias.");
  lines.push("");

  return lines.join("\n");
}

function renderStdoutSummary(
  dataCorte: string,
  fornecedores: FornecedoresProbe,
  tipoDoc: TipoDocumentoProbe,
  samples: SamplesProbe,
  formulas: FormulaProbe,
  states: StatesProbe,
  orphans: OrphanProbe
): string {
  const lines: string[] = [];
  lines.push(RULE);
  lines.push("inspect-compras-lookups — sumário");
  lines.push(RULE);
  lines.push("");
  lines.push(`Data-corte: ${dataCorte}`);
  lines.push("");

  lines.push(`Fornecedores       : ${fornecedores.exists ? `${fornecedores.rowCount} rows` : "NÃO EXISTE"}`);
  if (fornecedores.exists && fornecedores.roles) {
    lines.push(`  PK              : ${fornecedores.roles.pk ?? "(nada)"}`);
    lines.push(`  Nome            : ${fornecedores.roles.nomeFornecedor?.name ?? "(nada)"}`);
    lines.push(`  Nome abreviado  : ${fornecedores.roles.nomeAbreviado?.name ?? "(nada)"}`);
    lines.push(`  NIF             : ${fornecedores.roles.nif?.name ?? "(nada)"}`);
    lines.push(`  Inactivo        : ${fornecedores.roles.inactivo?.name ?? "(nada)"}`);
    lines.push(`  Tipo            : ${fornecedores.roles.tipoFornecedor?.name ?? "(nada)"}`);
  }
  lines.push("");

  lines.push(`Tipo Documento     : ${tipoDoc.exists ? `${tipoDoc.rowCount} rows` : "NÃO EXISTE"}`);
  if (tipoDoc.recepcaoUsage) lines.push(`  Usado em Recepcao  : ${tipoDoc.recepcaoUsage.length} tipos distintos`);
  if (tipoDoc.devolucaoUsage) lines.push(`  Usado em Devolucao : ${tipoDoc.devolucaoUsage.length} tipos distintos`);
  lines.push("");

  lines.push(`Amostras Recepcao  : ${samples.recepcaoSamples?.length ?? 0} headers + ${samples.recepcaoDetSamples?.length ?? 0} linhas`);
  lines.push(`Amostras Devolucao : ${samples.devolucaoSamples?.length ?? 0} headers + ${samples.devolucaoDetSamples?.length ?? 0} linhas`);
  lines.push("");

  lines.push(`Fórmulas Recepcao  : ${formulas.recepcaoLines?.length ?? 0} linhas analisadas`);
  lines.push(`Fórmulas Devolucao : ${formulas.devolucaoLines?.length ?? 0} linhas analisadas`);
  lines.push("");

  if (states.recepcaoStates) {
    const s = states.recepcaoStates.map((x) => `${x.id}=${x.total}/${x.postCorte}`).join(" ");
    lines.push(`Estados Recepcao   : ${s}`);
  }
  if (states.devolucaoStates) {
    const s = states.devolucaoStates.map((x) => `${x.id}=${x.total}/${x.postCorte}`).join(" ");
    lines.push(`Estados Devolucao  : ${s}`);
  }
  lines.push("");

  lines.push("Orphans:");
  for (const c of orphans.checks) {
    const cnt = c.error ? "ERR" : c.count === null ? "?" : String(c.count);
    const mark = c.error ? "✗" : (c.count ?? 0) === 0 ? "✓" : "⚠";
    lines.push(`  ${mark} ${c.label.padEnd(50)} ${cnt}`);
  }
  return lines.join("\n");
}

// ── Main ──────────────────────────────────────────────────────────────

export async function inspectComprasLookups(): Promise<number> {
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

  let cfg: AgentConfig;
  try {
    cfg = loadConfig("sql");
  } catch (err) {
    console.error("✗ Config inválida:");
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  console.log(RULE);
  console.log("inspect-compras-lookups");
  console.log(RULE);
  console.log(`Database  : ${cfg.sqlDatabase}@${cfg.sqlHost}:${cfg.sqlPort}`);
  console.log(`Data-corte: ${args.dataCorte}`);
  console.log("");

  try {
    return await withPool(cfg, async (pool) => {
      console.log("▶ probe dbo.Fornecedores ...");
      const fornecedores = await probeFornecedores(pool, cfg);
      console.log(
        fornecedores.exists
          ? `  ✓ ${fornecedores.rowCount} rows, ${fornecedores.columns?.length ?? 0} cols`
          : "  ✗ não existe"
      );

      console.log("▶ probe dbo.Tipo Documento ...");
      const tipoDoc = await probeTipoDocumento(pool, cfg);
      console.log(
        tipoDoc.exists
          ? `  ✓ ${tipoDoc.rowCount} rows, ${tipoDoc.columns?.length ?? 0} cols`
          : "  ✗ não existe"
      );

      console.log("▶ amostras pós-data-corte ...");
      const samples = await probeSamples(pool, args.dataCorte);
      console.log(
        `  ✓ Recepcao ${samples.recepcaoSamples?.length ?? 0} headers / Devolucao ${samples.devolucaoSamples?.length ?? 0} headers`
      );

      console.log("▶ validação fórmulas ...");
      const formulas = await probeFormulas(pool, args.dataCorte);
      console.log(
        `  ✓ ${formulas.recepcaoLines?.length ?? 0} linhas Recepcao, ${formulas.devolucaoLines?.length ?? 0} linhas Devolucao`
      );

      console.log("▶ contagens por estado ...");
      const states = await probeStates(pool, args.dataCorte);
      console.log(
        `  ✓ Recepcao ${states.recepcaoStates?.length ?? 0} estados / Devolucao ${states.devolucaoStates?.length ?? 0} estados`
      );

      console.log("▶ orphan checks ...");
      const orphans = await probeOrphans(pool);
      for (const c of orphans.checks) {
        const mark = c.error ? "✗" : (c.count ?? 0) === 0 ? "✓" : "⚠";
        const cnt = c.error ? c.error.slice(0, 30) : String(c.count);
        console.log(`    ${mark} ${c.label.padEnd(50)} ${cnt}`);
      }
      console.log("");

      console.log(renderStdoutSummary(args.dataCorte, fornecedores, tipoDoc, samples, formulas, states, orphans));
      console.log("");

      const outDir = path.resolve(cfg.outputDir, `compras-lookups-${ymd(new Date())}`);
      fs.mkdirSync(outDir, { recursive: true });
      const mdPath = path.resolve(outDir, "inspection.md");
      const md = renderMarkdown(cfg, args.dataCorte, fornecedores, tipoDoc, samples, formulas, states, orphans);
      fs.writeFileSync(mdPath, md, "utf8");

      console.log(RULE);
      console.log(`Markdown completo: ${mdPath}`);
      console.log(RULE);
      console.log("Próximo passo:");
      console.log("  1. Rever secções 1 (Fornecedores) e 2 (Tipo Documento).");
      console.log("  2. Validar fórmulas em secção 4 (Valor_EUR unitário ou total?).");
      console.log("  3. Verificar orphans > 0 em secção 6.");
      console.log("  4. Enviar inspection.md ao admin SPharm.MT.");
      console.log("");
      console.log("Até Fase 1 autorizada, nada vai ser escrito na SaaS.");
      return 0;
    });
  } catch (err) {
    console.error("\n✗ Falha na inspecção:");
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
