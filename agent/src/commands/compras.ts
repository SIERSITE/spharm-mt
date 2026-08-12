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

/**
 * Agrupa as divergências pelos eixos que podem explicá-las.
 *
 * Só leitura e só impressão: nada aqui altera payloads nem cálculos. A
 * pergunta a que responde é "de onde vêm", e as três hipóteses óbvias
 * — desconto, bónus e tipo de documento — ou aparecem concentradas num
 * grupo, ou ficam excluídas.
 *
 * A separação por sinal é o que distingue as hipóteses: desconto e bónus
 * só podem inflacionar a soma das linhas face ao total do documento
 * (computed > expected). Um `computed < expected` NÃO se explica por
 * nenhum dos dois — aponta para linhas em falta no detalhe, valores
 * fora da linha (portes, taxas) ou outra semântica do documento.
 */
function printarDivergencias(
  rows: CompraRow[],
  divergent: Array<{ recId: number; expected: number; computed: number; diff: number }>,
): void {
  if (divergent.length === 0) return;

  const porRec = new Map<number, CompraRow[]>();
  for (const r of rows) {
    const id = numOrNull(r.externalReceptionId);
    if (id === null) continue;
    const l = porRec.get(id);
    if (l) l.push(r); else porRec.set(id, [r]);
  }

  const acima: typeof divergent = [];
  const abaixo: typeof divergent = [];
  const porTipo = new Map<string, number>();
  const porDesconto = new Map<string, number>();
  const porBonus = new Map<string, number>();

  const inc = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

  for (const d of divergent) {
    (d.computed > d.expected ? acima : abaixo).push(d);
    const linhas = porRec.get(d.recId) ?? [];
    const tipo = linhas[0]?.externalTipoDocumentoId;
    inc(porTipo, tipo === null || tipo === undefined ? "(sem tipo)" : String(tipo));
    const temDesconto = linhas.some((l) => (numOrNull(l.desconto) ?? 0) !== 0);
    const temBonus = linhas.some((l) => (numOrNull(l.bonus) ?? 0) !== 0);
    inc(porDesconto, temDesconto ? "com desconto" : "sem desconto");
    inc(porBonus, temBonus ? "com bónus" : "sem bónus");
  }

  const tabela = (titulo: string, m: Map<string, number>) => {
    console.log(`  ${titulo}`);
    for (const [k, n] of [...m.entries()].sort((a, b) => b[1] - a[1])) {
      const pct = ((n / divergent.length) * 100).toFixed(1);
      console.log(`    ${k.padEnd(16)} ${String(n).padStart(6)}  (${pct}%)`);
    }
  };

  console.log("  ── De onde vêm as divergências ──");
  console.log(`    computed > expected  ${String(acima.length).padStart(6)}  (soma das linhas MAIOR que o documento)`);
  console.log(`    computed < expected  ${String(abaixo.length).padStart(6)}  (soma das linhas MENOR — desconto/bónus não explicam)`);
  console.log("");
  tabela("Por FornecedorTipoDocumentoID:", porTipo);
  tabela("Por presença de desconto:", porDesconto);
  tabela("Por presença de bónus:", porBonus);

  // As maiores de cada lado: os dois sinais podem ter causas diferentes,
  // e mostrar só as maiores em valor absoluto esconde um dos lados.
  const amostra = (titulo: string, lista: typeof divergent) => {
    if (lista.length === 0) return;
    console.log(`  ${titulo} (top 5):`);
    for (const d of [...lista].sort((a, b) => b.diff - a.diff).slice(0, 5)) {
      const linhas = porRec.get(d.recId) ?? [];
      const desc = linhas.filter((l) => (numOrNull(l.desconto) ?? 0) !== 0).length;
      const bon = linhas.filter((l) => (numOrNull(l.bonus) ?? 0) !== 0).length;
      console.log(
        `    rec=${d.recId} doc=${d.expected.toFixed(2)} linhas=${d.computed.toFixed(2)} ` +
          `diff=${(d.computed - d.expected).toFixed(2)}€ nLinhas=${linhas.length} ` +
          `c/desconto=${desc} c/bónus=${bon} tipo=${linhas[0]?.externalTipoDocumentoId ?? "?"}`,
      );
    }
  };
  console.log("");
  amostra("Soma das linhas ACIMA do documento", acima);
  amostra("Soma das linhas ABAIXO do documento", abaixo);
}

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
  /** Recepcao IDs a inspeccionar em detalhe (diagnóstico, sem --from/--to). */
  rec?: number[];
  /** Idem, com varrimento relacional: tabelas ligadas e sequências em falta. */
  recDeep?: number[];
  help: boolean;
};

function parseCmdArgs(): Args {
  const raw = parseArgs({
    args: process.argv.slice(3),
    options: {
      from: { type: "string" },
      to: { type: "string" },
      "batch-size": { type: "string" },
      rec: { type: "string" },
      "rec-deep": { type: "string" },
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
    rec:
      typeof raw.values.rec === "string"
        ? raw.values.rec.split(",").map((x) => Number(x.trim())).filter((n) => Number.isFinite(n))
        : undefined,
    recDeep:
      typeof raw.values["rec-deep"] === "string"
        ? raw.values["rec-deep"].split(",").map((x) => Number(x.trim())).filter((n) => Number.isFinite(n))
        : undefined,
    help: raw.values.help === true,
  };
}

function printDryRunHelp(): void {
  console.log("Uso: compras-dry-run --from YYYY-MM-DD --to YYYY-MM-DD");
  console.log("     compras-dry-run --rec 68918,70102,64250        (inspecciona documentos)");
  console.log("     compras-dry-run --rec-deep 58865,64250         (varrimento relacional)");
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

// -------------------------------------------------------------------
// Inspeccao de documentos (diagnostico, read-only)
// -------------------------------------------------------------------

/**
 * Despeja tudo o que existe sobre um punhado de recepcoes e testa
 * hipoteses de formula contra os totais do documento.
 *
 * Existe porque a reconciliacao divergia nos DOIS sentidos: 289 com a
 * soma das linhas acima do documento e 515 abaixo. Desconto e bonus so
 * podem explicar o primeiro caso, portanto ha uma hipotese por
 * descobrir — e adivinha-la a partir dos nomes das colunas seria repetir
 * o erro que ja custou caro no catalogo.
 *
 * Nao escreve nada, nao faz POST e nao altera o calculo de ingestao.
 * As colunas sao descobertas em runtime: os nomes variam entre
 * instalacoes Softreis, e o que interessa e ver o que ESTA tem.
 */
async function inspeccionarRecepcoes(pool: SqlPool, ids: number[]): Promise<void> {
  const lista = ids.join(",");

  const colunas = async (tabela: string) => {
    const r = await pool.request().query<{ nome: string; tipo: string }>(`
      SELECT c.name AS nome, ty.name AS tipo
      FROM sys.columns c
      JOIN sys.tables t   ON t.object_id = c.object_id
      JOIN sys.schemas sc ON sc.schema_id = t.schema_id
      JOIN sys.types ty   ON ty.user_type_id = c.user_type_id
      WHERE sc.name = 'dbo' AND t.name = '${tabela.replace(/'/g, "''")}'
      ORDER BY c.column_id`);
    return r.recordset;
  };

  const numericas = (cols: Array<{ nome: string; tipo: string }>) =>
    cols.filter((c) => /money|decimal|numeric|float|real|int/i.test(c.tipo));

  const colsHeader = await colunas("Recepcao");
  const colsLinha = await colunas("Recepcao Detalhe");

  console.log(DOUBLE_RULE);
  console.log("  INSPECCAO DE DOCUMENTOS - read-only, sem POST, sem escrita");
  console.log(DOUBLE_RULE);
  console.log("");
  console.log("Colunas numericas de dbo.Recepcao:");
  for (const c of numericas(colsHeader)) console.log(`  ${c.nome.padEnd(34)} ${c.tipo}`);
  console.log("");
  console.log("Colunas numericas de dbo.[Recepcao Detalhe]:");
  for (const c of numericas(colsLinha)) console.log(`  ${c.nome.padEnd(34)} ${c.tipo}`);
  console.log("");

  const lk = await pool.request().query<{ tabela: string }>(`
    SELECT t.name AS tabela
    FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
    WHERE s.name = 'dbo' AND t.name LIKE '%TipoDocumento%'`);
  console.log("Tabelas de lookup com 'TipoDocumento' no nome:");
  if (lk.recordset.length === 0) {
    console.log("  (nenhuma - o significado dos IDs nao esta na base)");
  }
  for (const t of lk.recordset) {
    console.log(`  -- dbo.[${t.tabela}] --`);
    try {
      const rows = await pool.request().query(`SELECT TOP 60 * FROM [dbo].[${t.tabela}]`);
      for (const r of rows.recordset) console.log(`    ${JSON.stringify(r)}`);
    } catch (err) {
      console.log(`    (nao legivel: ${err instanceof Error ? err.message : err})`);
    }
  }
  console.log("");

  const headers = await pool.request().query(
    `SELECT * FROM [dbo].[Recepcao] WHERE [Recepcao ID] IN (${lista})`);
  const linhas = await pool.request().query(
    `SELECT * FROM [dbo].[Recepcao Detalhe] WHERE [Recepcao ID] IN (${lista})
      ORDER BY [Recepcao ID], [Detalhe  Recp ID]`);

  const n = (v: unknown) => numOrNull(v) ?? 0;

  for (const id of ids) {
    const h = headers.recordset.find((x) => Number(x["Recepcao ID"]) === id);
    const ls = linhas.recordset.filter((x) => Number(x["Recepcao ID"]) === id);
    console.log(RULE);
    console.log(`  Recepcao ID ${id}`);
    console.log(RULE);
    if (!h) {
      console.log("  (nao encontrada)");
      continue;
    }

    console.log("  HEADER - todos os campos numericos:");
    for (const c of numericas(colsHeader)) {
      const v = h[c.nome];
      if (v !== null && v !== undefined) console.log(`    ${c.nome.padEnd(34)} ${String(v)}`);
    }
    console.log(`  Linhas: ${ls.length}`);
    console.log("");

    console.log("  LINHAS - todos os campos numericos:");
    for (const l of ls) {
      const partes = numericas(colsLinha)
        .filter((c) => l[c.nome] !== null && l[c.nome] !== undefined)
        .map((c) => `${c.nome}=${String(l[c.nome])}`);
      console.log(`    ${partes.join("  ")}`);
    }
    console.log("");

    // Hipoteses. Cada uma e uma leitura possivel dos mesmos campos; a
    // que bater nos dois sentidos da divergencia e a certa.
    const somas: Record<string, number> = {
      "qt x valor": 0,
      "(qt - bonus) x valor": 0,
      "qt x valor x (1 - desc/100)": 0,
      "(qt - bonus) x valor x (1 - desc/100)": 0,
      "qt x valor - desconto": 0,
    };
    for (const l of ls) {
      const qt = n(l["Quantidade"]);
      const bo = n(l["Bonus"]);
      const va = n(l["Valor_EUR"]);
      const de = n(l["Desconto"]);
      somas["qt x valor"] += qt * va;
      somas["(qt - bonus) x valor"] += (qt - bo) * va;
      somas["qt x valor x (1 - desc/100)"] += qt * va * (1 - de / 100);
      somas["(qt - bonus) x valor x (1 - desc/100)"] += (qt - bo) * va * (1 - de / 100);
      somas["qt x valor - desconto"] += qt * va - de;
    }

    // Um total por linha, se existir, e a hipotese mais forte: nao
    // depende de interpretarmos desconto nem bonus.
    for (const c of numericas(colsLinha)) {
      if (!/total|liquido|incidencia/i.test(c.nome)) continue;
      somas[`SUM(${c.nome})`] = ls.reduce((acc, l) => acc + n(l[c.nome]), 0);
    }

    console.log("  HIPOTESES vs cada total do header:");
    const totaisHeader = numericas(colsHeader).filter((c) =>
      /total|incidencia|liquido|bruto|iva/i.test(c.nome));
    for (const [nome, valor] of Object.entries(somas)) {
      console.log(`    ${nome.padEnd(42)} = ${valor.toFixed(2)}`);
      const comparacoes = totaisHeader
        .map((c) => {
          const alvo = n(h[c.nome]);
          const d = valor - alvo;
          return `${c.nome}=${alvo.toFixed(2)} (D${d >= 0 ? "+" : ""}${d.toFixed(2)})`;
        })
        .join("  ");
      console.log(`      ${comparacoes}`);
    }
    console.log("");
  }

  console.log(DOUBLE_RULE);
  console.log("  Nenhuma formula foi aplicada. Envia esta saida inteira.");
  console.log(DOUBLE_RULE);
}

/**
 * Varrimento relacional de um documento de recepcao.
 *
 * A pergunta: porque e que o total do header nao se reconstroi a partir
 * das linhas que lemos. O 58865 nao tem Sequencia=1 e o 64250 nao tem
 * Sequencia=4 — ou essas linhas foram anuladas, ou vivem noutra tabela
 * que a nossa query nao le. Nos dois casos estamos a importar um
 * documento incompleto, e nenhuma formula sobre as linhas que temos
 * corrige isso.
 *
 * Descobre as tabelas por METADADOS, nao por palpite: qualquer tabela com
 * uma coluna que referencie a recepcao entra no varrimento, tenha o nome
 * que tiver. Read-only, sem POST.
 */
async function inspeccionarProfundo(pool: SqlPool, ids: number[]): Promise<void> {
  const lista = ids.join(",");
  const q = <T = Record<string, unknown>>(sqlText: string) =>
    pool.request().query<T>(sqlText).then((r) => r.recordset);

  console.log(DOUBLE_RULE);
  console.log("  VARRIMENTO RELACIONAL - read-only, sem POST");
  console.log(DOUBLE_RULE);
  console.log("");

  // 1. Quem referencia a recepcao, por metadados.
  const candidatas = await q<{ tabela: string; coluna: string; tipo: string }>(`
    SELECT t.name AS tabela, c.name AS coluna, ty.name AS tipo
    FROM sys.columns c
    JOIN sys.tables t   ON t.object_id = c.object_id
    JOIN sys.schemas s  ON s.schema_id = t.schema_id
    JOIN sys.types ty   ON ty.user_type_id = c.user_type_id
    WHERE s.name = 'dbo'
      AND ty.name IN ('int','bigint','smallint','numeric','decimal','varchar','nvarchar')
      AND (c.name LIKE '%Recepcao%' OR c.name LIKE '%Recp%')
    ORDER BY t.name, c.column_id`);

  console.log(`Colunas que referenciam recepcao: ${candidatas.length}`);
  for (const c of candidatas) console.log(`  dbo.[${c.tabela}].[${c.coluna}]  ${c.tipo}`);
  console.log("");

  // FKs declaradas a apontar para Recepcao — sinal mais forte que o nome.
  const fks = await q<{ origem: string; colOrigem: string; destino: string; colDestino: string }>(`
    SELECT pt.name AS origem, pc.name AS "colOrigem",
           rt.name AS destino, rc.name AS "colDestino"
    FROM sys.foreign_keys fk
    JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
    JOIN sys.tables pt  ON pt.object_id = fk.parent_object_id
    JOIN sys.tables rt  ON rt.object_id = fk.referenced_object_id
    JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
    JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
    WHERE rt.name LIKE 'Recepcao%'`);
  console.log(`FKs declaradas para Recepcao*: ${fks.length}`);
  for (const f of fks) console.log(`  dbo.[${f.origem}].[${f.colOrigem}] -> dbo.[${f.destino}].[${f.colDestino}]`);
  console.log("");

  // 2. Quais delas tem mesmo linhas destes documentos.
  type Achado = { tabela: string; coluna: string; n: number };
  const achados: Achado[] = [];
  for (const c of candidatas) {
    if (c.tabela === "Recepcao") continue; // e o proprio header
    try {
      const r = await q<{ n: number }>(
        `SELECT COUNT(*) AS n FROM [dbo].[${c.tabela}] WHERE [${c.coluna}] IN (${lista})`);
      const n = Number(r[0]?.n ?? 0);
      if (n > 0) achados.push({ tabela: c.tabela, coluna: c.coluna, n });
    } catch {
      // Tipo incompativel com a comparacao: nao e uma referencia util.
    }
  }
  console.log("Tabelas COM linhas destes documentos:");
  if (achados.length === 0) console.log("  (nenhuma alem do detalhe principal)");
  for (const a of achados) console.log(`  dbo.[${a.tabela}].[${a.coluna}]  ${a.n} linha(s)`);
  console.log("");

  // 3. Lookups de tipo de documento — o significado dos IDs.
  const lookups = await q<{ tabela: string }>(`
    SELECT t.name AS tabela
    FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
    WHERE s.name = 'dbo'
      AND (t.name LIKE '%TipoDoc%' OR t.name LIKE '%Tipo_Doc%'
        OR t.name LIKE '%DocumentoTipo%' OR t.name LIKE '%FornecedorTipo%')`);
  console.log("Lookups de tipo de documento:");
  if (lookups.length === 0) console.log("  (nenhuma tabela candidata na base)");
  for (const t of lookups) {
    console.log(`  -- dbo.[${t.tabela}] --`);
    try {
      for (const r of await q(`SELECT TOP 80 * FROM [dbo].[${t.tabela}]`)) {
        console.log(`    ${JSON.stringify(r)}`);
      }
    } catch (err) {
      console.log(`    (nao legivel: ${err instanceof Error ? err.message : err})`);
    }
  }
  console.log("");

  // 4. Documento a documento.
  for (const id of ids) {
    console.log(RULE);
    console.log(`  Recepcao ID ${id}`);
    console.log(RULE);

    const header = await q(`SELECT * FROM [dbo].[Recepcao] WHERE [Recepcao ID] = ${id}`);
    if (header.length === 0) { console.log("  (header nao encontrado)"); continue; }
    console.log("  HEADER completo:");
    console.log(`    ${JSON.stringify(header[0])}`);
    console.log("");

    const detalhe = await q(
      `SELECT * FROM [dbo].[Recepcao Detalhe] WHERE [Recepcao ID] = ${id}
        ORDER BY [Sequencia]`);
    console.log(`  LINHAS em [Recepcao Detalhe]: ${detalhe.length}`);
    for (const l of detalhe) console.log(`    ${JSON.stringify(l)}`);
    console.log("");

    // Sequencias em falta: e a pista concreta. Se a 1 nao existe, ou foi
    // apagada, ou esta noutro sitio — e o valor dela falta no total.
    const seqs = detalhe
      .map((l) => Number(l["Sequencia"]))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
    if (seqs.length > 0) {
      const max = seqs[seqs.length - 1] as number;
      const presentes = new Set(seqs);
      const faltam: number[] = [];
      for (let i = 1; i <= max; i++) if (!presentes.has(i)) faltam.push(i);
      console.log(`  Sequencias presentes : ${seqs.join(", ")}`);
      console.log(`  Sequencias EM FALTA  : ${faltam.length ? faltam.join(", ") : "(nenhuma)"}`);

      // Procurar as que faltam em cada tabela relacionada que tenha
      // uma coluna de sequencia.
      if (faltam.length > 0) {
        console.log("  A procurar as sequencias em falta nas tabelas relacionadas:");
        for (const a of achados) {
          try {
            const temSeq = await q<{ n: number }>(`
              SELECT COUNT(*) AS n FROM sys.columns
              WHERE object_id = OBJECT_ID('dbo.[${a.tabela}]') AND name = 'Sequencia'`);
            if (Number(temSeq[0]?.n ?? 0) === 0) continue;
            const rows = await q(
              `SELECT TOP 40 * FROM [dbo].[${a.tabela}]
                WHERE [${a.coluna}] = ${id} AND [Sequencia] IN (${faltam.join(",")})`);
            if (rows.length > 0) {
              console.log(`    dbo.[${a.tabela}] -> ${rows.length} linha(s):`);
              for (const r of rows) console.log(`      ${JSON.stringify(r)}`);
            }
          } catch {
            // tabela sem Sequencia comparavel — segue
          }
        }
      }
    }
    console.log("");

    // Todas as linhas relacionadas, venham de onde vierem.
    console.log("  LINHAS RELACIONADAS noutras tabelas:");
    let algumaRelacionada = false;
    for (const a of achados) {
      if (a.tabela === "Recepcao Detalhe") continue;
      try {
        const rows = await q(
          `SELECT TOP 40 * FROM [dbo].[${a.tabela}] WHERE [${a.coluna}] = ${id}`);
        if (rows.length === 0) continue;
        algumaRelacionada = true;
        console.log(`    -- dbo.[${a.tabela}] via [${a.coluna}]: ${rows.length} --`);
        for (const r of rows) console.log(`      ${JSON.stringify(r)}`);
      } catch {
        // segue
      }
    }
    if (!algumaRelacionada) console.log("    (nenhuma)");
    console.log("");

    // 5. Somas e comparacao final.
    const n = (v: unknown) => numOrNull(v) ?? 0;
    const somaLinhas = detalhe.reduce(
      (acc, l) => acc + n(l["Quantidade"]) * n(l["Valor_EUR"]), 0);
    const h = header[0] as Record<string, unknown>;
    console.log("  COMPARACAO FINAL:");
    console.log(`    SUM(qt x Valor_EUR) das linhas lidas = ${somaLinhas.toFixed(2)}`);
    for (const k of Object.keys(h)) {
      if (!/total|incidencia|liquido|bruto|iva|desconto|porte/i.test(k)) continue;
      const alvo = n(h[k]);
      console.log(`    ${k.padEnd(30)} = ${alvo.toFixed(2)}   (D${(somaLinhas - alvo) >= 0 ? "+" : ""}${(somaLinhas - alvo).toFixed(2)})`);
    }
    console.log("");
  }

  console.log(DOUBLE_RULE);
  console.log("  Nada foi escrito. Envia esta saida inteira.");
  console.log(DOUBLE_RULE);
}

// -------------------------------------------------------------------
// Relatorio por classe de qualidade
// -------------------------------------------------------------------

/**
 * Espelho da classificacao do SaaS (lib/compras/qualidade.ts).
 *
 * Duplicada de proposito: o agent nao importa codigo do SaaS, e ter o
 * mesmo veredicto ANTES de enviar e o que permite decidir se vale a pena
 * enviar. Os limiares tem de ser mudados nos dois sitios — o teste
 * test-compras-qualidade.ts fixa os valores do lado do SaaS, e este
 * comentario e o ponteiro para aqui.
 */
const TOL_ABS_EUR = 0.02;
const TOL_REL = 0.001;

type Classe = "RECONCILIADA" | "DETALHE_INCOMPLETO" | "NAO_FINANCEIRO" | "SEM_LINHAS";

function classificar(totalDoc: number, explicado: number, nLinhas: number): Classe {
  if (nLinhas === 0) return "SEM_LINHAS";
  if (totalDoc === 0) return "NAO_FINANCEIRO";
  const tol = Math.max(TOL_ABS_EUR, Math.abs(totalDoc) * TOL_REL);
  return Math.abs(explicado - totalDoc) <= tol ? "RECONCILIADA" : "DETALHE_INCOMPLETO";
}

/**
 * Relatorio por classe da janela inteira.
 *
 * Responde a pergunta operacional que a reconciliacao antiga nao
 * respondia: quantos documentos vao poder alimentar custo por produto, e
 * quanto valor financeiro fica de fora desse calculo.
 */
function printarClasses(rows: CompraRow[]): void {
  type Doc = {
    totalDoc: number;
    explicado: number;
    nLinhas: number;
    tipo: string;
  };
  const docs = new Map<number, Doc>();
  for (const r of rows) {
    const id = numOrNull(r.externalReceptionId);
    if (id === null) continue;
    const qt = numOrNull(r.quantidade) ?? 0;
    const va = numOrNull(r.valorEurUnit) ?? 0;
    const d = docs.get(id);
    if (d) {
      d.explicado += qt * va;
      d.nLinhas++;
    } else {
      docs.set(id, {
        totalDoc: numOrNull(r.headerTotalIncidenciaEur) ?? 0,
        explicado: qt * va,
        nLinhas: 1,
        tipo:
          r.externalTipoDocumentoId === null || r.externalTipoDocumentoId === undefined
            ? "(sem tipo)"
            : String(r.externalTipoDocumentoId),
      });
    }
  }

  type Agg = { n: number; valorDoc: number; valorExpl: number; deltaAbs: number };
  const vazio = (): Agg => ({ n: 0, valorDoc: 0, valorExpl: 0, deltaAbs: 0 });
  const porClasse = new Map<Classe, Agg>();
  const porTipo = new Map<string, Map<Classe, number>>();
  const piores: Array<{ id: number; classe: Classe; doc: number; expl: number; delta: number; tipo: string }> = [];

  for (const [id, d] of docs) {
    const classe = classificar(d.totalDoc, d.explicado, d.nLinhas);
    const a = porClasse.get(classe) ?? vazio();
    a.n++;
    a.valorDoc += d.totalDoc;
    a.valorExpl += d.explicado;
    a.deltaAbs += Math.abs(d.explicado - d.totalDoc);
    porClasse.set(classe, a);

    const t = porTipo.get(d.tipo) ?? new Map<Classe, number>();
    t.set(classe, (t.get(classe) ?? 0) + 1);
    porTipo.set(d.tipo, t);

    if (classe === "DETALHE_INCOMPLETO") {
      piores.push({ id, classe, doc: d.totalDoc, expl: d.explicado, delta: d.explicado - d.totalDoc, tipo: d.tipo });
    }
  }

  const total = docs.size;
  const pct = (n: number) => (total ? ((n / total) * 100).toFixed(1) : "0.0");
  const eur = (v: number) => v.toFixed(2).padStart(14);

  console.log("Qualidade dos documentos:");
  console.log(`  Documentos na janela          : ${total}`);
  console.log("");
  console.log("  classe                  docs      %        valor doc       valor linhas       |delta|");
  const ordem: Classe[] = ["RECONCILIADA", "DETALHE_INCOMPLETO", "NAO_FINANCEIRO", "SEM_LINHAS"];
  for (const c of ordem) {
    const a = porClasse.get(c);
    if (!a) continue;
    console.log(
      `  ${c.padEnd(20)} ${String(a.n).padStart(6)}  ${pct(a.n).padStart(5)}%  ${eur(a.valorDoc)}  ${eur(a.valorExpl)}  ${eur(a.deltaAbs)}`,
    );
  }
  console.log("");

  console.log("  Por FornecedorTipoDocumentoID:");
  const tipos = [...porTipo.entries()].sort(
    (a, b) => [...b[1].values()].reduce((x, y) => x + y, 0) - [...a[1].values()].reduce((x, y) => x + y, 0),
  );
  for (const [tipo, m] of tipos) {
    const partes = ordem.filter((c) => m.get(c)).map((c) => `${c}=${m.get(c)}`);
    const n = [...m.values()].reduce((x, y) => x + y, 0);
    console.log(`    tipo ${tipo.padEnd(10)} ${String(n).padStart(6)} doc(s)   ${partes.join("  ")}`);
  }
  console.log("");

  if (piores.length > 0) {
    console.log("  TOP divergencias (DETALHE_INCOMPLETO, por |delta|):");
    for (const d of piores.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 10)) {
      console.log(
        `    rec=${String(d.id).padStart(7)} tipo=${d.tipo.padEnd(6)} doc=${d.doc.toFixed(2).padStart(12)} linhas=${d.expl.toFixed(2).padStart(12)} delta=${(d.delta >= 0 ? "+" : "") + d.delta.toFixed(2)}`,
      );
    }
    console.log("");
  }

  const excluidos =
    (porClasse.get("DETALHE_INCOMPLETO")?.n ?? 0) +
    (porClasse.get("NAO_FINANCEIRO")?.n ?? 0) +
    (porClasse.get("SEM_LINHAS")?.n ?? 0);
  const valorExcluido =
    (porClasse.get("DETALHE_INCOMPLETO")?.valorDoc ?? 0) +
    (porClasse.get("NAO_FINANCEIRO")?.valorDoc ?? 0) +
    (porClasse.get("SEM_LINHAS")?.valorDoc ?? 0);

  console.log("  Efeito no calculo de custo por produto:");
  console.log(`    Documentos que PODEM alimentar custo : ${porClasse.get("RECONCILIADA")?.n ?? 0}  (${pct(porClasse.get("RECONCILIADA")?.n ?? 0)}%)`);
  console.log(`    Documentos EXCLUIDOS desse calculo   : ${excluidos}  (${pct(excluidos)}%)`);
  console.log(`    Valor financeiro dos excluidos       : ${valorExcluido.toFixed(2)} EUR`);
  console.log("");
  console.log("  Os excluidos continuam a ser importados e ficam visiveis; o que");
  console.log("  nao fazem e produzir custo unitario por produto. O total do");
  console.log("  documento NUNCA e distribuido pelas linhas que sobreviveram.");
  console.log("");
}

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
  // Modo diagnostico profundo: varrimento relacional.
  if (args.recDeep && args.recDeep.length > 0) {
    let cfgDeep: AgentConfig;
    try {
      cfgDeep = loadConfig("sql");
    } catch (err) {
      console.error("✗ Config inválida:", err instanceof Error ? err.message : err);
      return 1;
    }
    return withPool(cfgDeep, async (pool) => {
      await inspeccionarProfundo(pool, args.recDeep!);
      return 0;
    });
  }

  // Modo diagnostico: --rec dispensa --from/--to e nao corre o resto.
  if (args.rec && args.rec.length > 0) {
    let cfgInspect: AgentConfig;
    try {
      cfgInspect = loadConfig("sql");
    } catch (err) {
      console.error("✗ Config inválida:", err instanceof Error ? err.message : err);
      return 1;
    }
    return withPool(cfgInspect, async (pool) => {
      await inspeccionarRecepcoes(pool, args.rec!);
      return 0;
    });
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
      console.log("");
      // ATENÇÃO: SUM(qt × valorEurUnit) NÃO é só auditoria. É exactamente
      // a fórmula que `lib/aggregate/compras.ts` usa para gravar
      // Compra.valorTotal e Compra.precoUnitario. Uma divergência aqui é
      // uma diferença entre o total do documento no ERP e o custo que o
      // SaaS vai guardar — logo, margem calculada sobre outro número.
      printarDivergencias(rows, divergent);
      console.log("");
      printarClasses(rows);
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
