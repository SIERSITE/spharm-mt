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

// rev45 — limites de retry/shrink quando `runProductsPipeline` é
// invocado com `retry: true` (caminho usado por `products-upload`).
// Reusamos a mesma curva do `stocksmov-upload` rev35: 4 tentativas com
// backoff exponencial 1s/2s/4s/8s, shrink até floor de 10. Floor mais
// baixo que stocksmov (25) porque cada item products é mais pesado
// SaaS-side (2 upserts) e o cold-start do Neon costuma castigar mais.
const MAX_RETRIES = 4;
const BACKOFF_BASE_MS = 1_000;
const MIN_PRODUCTS_BATCH = 10;

// HTTP timeout per batch — 120s dá folga para 60s de processamento
// server-side + latência + retry buffer. Fetch aborta antes só se
// Vercel ficar verdadeiramente preso.
const BATCH_TIMEOUT_MS = 120_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Mesma heurística do `stocksmov.ts:isTransientError` rev35 — qualquer
 * erro de rede embrulhado por `http-client.ts` ("falha de rede: ...")
 * cai dentro do regex, incluindo o `Failed to cancel request in 5000ms`
 * que o undici emite quando o socket não fecha após `abort()`. Para
 * SaaS responses, só re-tenta 4xx/5xx transientes — 401/403/404/422
 * são falhas terminais.
 */
function isTransientError(err: unknown): boolean {
  if (err instanceof SaasApiError) {
    return [408, 425, 429, 500, 502, 503, 504].includes(err.statusCode);
  }
  if (err instanceof Error) {
    return /falha de rede|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|aborted|socket hang up|fetch failed|timeout|cancel/i.test(
      err.message,
    );
  }
  return false;
}

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
  /**
   * rev39 — taxa IVA da tabela mestre `dbo.Stocks`. Valor cru: pode vir
   * como fracção (0.06/0.13/0.23) ou percentagem (6/13/23). O server
   * normaliza via `normalizeIva()`. null quando a coluna não foi
   * detectada (rev39 fallback) ou quando o produto não tem taxa no ERP.
   */
  taxaIva: number | null;
  /**
   * rev46 — catálogo regulamentar vindo do próprio ERP. O SPharm local já
   * conhece estes quatro campos; reconstruí-los pela Internet é trabalho a
   * dobrar e de pior qualidade. Cada campo é `null` quando a coluna não
   * existe nesta instalação — nunca inventado.
   *
   * A localização das colunas é descoberta em runtime (`discoverCatalogPlan`),
   * porque os nomes variam entre instalações Softreis. Para ver o que existe
   * numa instalação concreta: `agent catalog-audit`.
   */
  dci: string | null;
  codigoATC: string | null;
  grupoHomogeneo: string | null;
  fabricante: string | null;
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
  /** rev46 — produtos novos e actualizados no catálogo central. */
  novos: number;
  atualizados: number;
  /** rev46 — campos do catálogo central escritos a partir do ERP. */
  catalogo: {
    fabricante: number;
    dci: number;
    codigoATC: number;
    grupoHomogeneo: number;
    productType: number;
  };
  /** Campos não tocados por já terem fonte de confiança igual ou superior. */
  catalogoPreservados: number;
};

function emptyTotals(): PipelineTotals {
  return {
    batches: 0, read: 0, accepted: 0, upserted: 0, skipped: 0, errors: 0, durationMs: 0,
    novos: 0,
    atualizados: 0,
    catalogo: { fabricante: 0, dci: 0, codigoATC: 0, grupoHomogeneo: 0, productType: 0 },
    catalogoPreservados: 0,
  };
}

function accumulate(t: PipelineTotals, r: BootstrapBatchResponse): void {
  t.batches++;
  t.accepted += r.accepted;
  t.upserted += r.upserted;
  t.skipped += r.skipped.length;
  t.errors += r.errors.length;
  t.durationMs += r.durationMs;
  t.novos += r.produtosNovos ?? 0;
  t.atualizados += r.produtosAtualizados ?? 0;
  const c = r.catalogoErp;
  if (c) {
    for (const campo of ["fabricante", "dci", "codigoATC", "grupoHomogeneo", "productType"] as const) {
      t.catalogo[campo] += (c.preenchidos?.[campo] ?? 0) + (c.substituidos?.[campo] ?? 0);
    }
    t.catalogoPreservados += Object.values(c.preservados ?? {}).reduce((a, b) => a + b, 0);
  }
}

export function renderTotals(label: string, t: PipelineTotals): void {
  console.log(`  Batches enviados   : ${t.batches}`);
  console.log(`  Linhas ERP lidas   : ${t.read}`);
  console.log(`  Aceites pelo SaaS  : ${t.accepted}`);
  console.log(`  Upserted           : ${t.upserted}`);
  console.log(`  Skipped            : ${t.skipped}`);
  console.log(`  Errors             : ${t.errors}`);
  console.log(`  Tempo agregado SaaS: ${t.durationMs} ms`);
  const cat = t.catalogo;
  const totalCat =
    cat.fabricante + cat.dci + cat.codigoATC + cat.grupoHomogeneo + cat.productType;
  if (totalCat > 0 || t.catalogoPreservados > 0 || t.novos > 0) {
    console.log("");
    console.log("  ══ Fase 1 — catálogo central enriquecido pelo ERP ══");
    console.log(`  Produtos processados : ${t.read}`);
    console.log(`  Produtos novos       : ${t.novos}`);
    console.log(`  Produtos actualizados: ${t.atualizados}`);
    console.log(`  ── Campos preenchidos pelo ERP ──`);
    console.log(`  Fabricante           : ${cat.fabricante}`);
    console.log(`  DCI                  : ${cat.dci}`);
    console.log(`  ATC                  : ${cat.codigoATC}`);
    console.log(`  Grupo Homogeneo      : ${cat.grupoHomogeneo}`);
    console.log(`  ProductType          : ${cat.productType}`);
    console.log(`  TOTAL campos         : ${totalCat}`);
    console.log(`  Preservados          : ${t.catalogoPreservados} (fonte igual ou superior)`);
  }
  if (t.errors > 0) console.log(`  ⚠ ${label}: ${t.errors} erros — ver detalhes acima`);
}

// ─────────────────────────────────────────────────────────────────────
// Pipeline 1: PRODUTOS — keyset por CodigoID
// ─────────────────────────────────────────────────────────────────────

/**
 * rev42 — IVA resolvido via JOIN explícito a `dbo.IVA` (master confirmada
 * pelo iva-audit rev41). Substitui a discovery genérica das rev39/40.
 *
 * Plano construído em runtime:
 *   1. Stocks.[Taxa IVA]    — coluna FK em Stocks (auto-discover; pode ter
 *                             outro nome em outras instalações)
 *   2. dbo.IVA              — master (existência confirmada)
 *   3. PK de dbo.IVA        — coluna 1 da PK simples (provável [IVA id])
 *   4. Coluna percentual    — coluna numérica não-PK cujo domínio cobre
 *                             taxas fiscais PT {0, 5, 6, 7, 13, 16, 23, ...}
 *
 * Se qualquer um dos passos falhar, devolve plano nulo e a query principal
 * emite `taxaIva: NULL` no payload — não inventamos taxa. Operador corre
 * `iva-audit` para investigar.
 */
type IvaJoinPlan = {
  stocksColumn: string | null;     // ex.: "Taxa IVA"
  masterTable: string | null;       // "IVA"
  masterPk: string | null;          // ex.: "IVA id"
  masterRateColumn: string | null;  // ex.: "Taxa"
};

/**
 * rev46 — plano de leitura do catálogo regulamentar (DCI, ATC, Grupo
 * Homogéneo, Fabricante) a partir do ERP.
 *
 * Mesmo princípio da descoberta do IVA e do movimentos-audit rev32: os
 * nomes das colunas variam entre instalações Softreis, por isso são
 * descobertos em `sys.columns` e não escritos à mão. Coluna que não
 * existe cai a NULL no SELECT em vez de partir a query.
 *
 * Para cada conceito escolhe-se a coluna TEXTUAL com nome mais
 * específico. Colunas numéricas são ignoradas de propósito: um código
 * interno do ERP (17) não é uma DCI nem um ATC, e enviá-lo poluiria o
 * catálogo central com valores sem significado fora daquela instalação.
 * Quando o valor real vive numa tabela de lookup, `catalog-audit` mostra
 * a chave e o JOIN pode ser acrescentado aqui com evidência.
 */
type CatalogPlan = {
  dci: string | null;
  atc: string | null;
  /** Coluna textual directa em Stocks (raro). */
  fabricante: string | null;
  /**
   * rev48 — fabricante por lookup, confirmado pelo catalog-audit da
   * Silveirense: Stocks.[GamaFabricanteID] (smallint, 98,8% preenchido,
   * 1084 distintos) contra dbo.tblGamaFabricante, PK GamaFabricanteID do
   * mesmo tipo, texto em [Descricao] varchar(74).
   *
   * Não há FK declarada — o Softreis quase não as declara — por isso a
   * ligação é confirmada por três evidências e não pela nomenclatura:
   * nome igual, tipo igual, e a coluna do lado do lookup é a PK.
   */
  fabricanteFk: { stocksColumn: string; table: string; pk: string; textColumn: string } | null;
  /**
   * rev52 — Grupo Homogéneo. Relação OBSERVADA na Silveirense em
   * 2026-08-11, não inferida por nomenclatura:
   *
   *   Stocks.[GrupoHomID] -> dbo.Stocks_GrupoHom.[GrupoHomID] -> [Descr]
   *
   * Porque está correcta: os dois lados contêm o mesmo código de domínio
   * (GH0052, GH0379) e não um inteiro que possa coincidir por acaso; o
   * lookup tem 1 002 linhas, zero GrupoHomID repetidos, logo o LEFT JOIN
   * não multiplica produtos. Medido: 18 743 produtos, 6 916 com
   * GrupoHomID, 3 944 resolvidos pelo lookup.
   *
   * Não é procurado por padrão de nome — foi exactamente isso que fez o
   * catalog-audit falhar esta coluna (nenhum de %homog%, %grupo hom%, %gh%
   * casa com "GrupoHomID"). Aqui só se confirma que existe.
   */
  grupoHomogeneoLookup: boolean;
};

/** Nomes fixos porque foram observados, não adivinhados. */
const GH = { coluna: "GrupoHomID", tabela: "Stocks_GrupoHom", texto: "Descr" } as const;

/** Sentinela do ERP para "sem grupo homogéneo". */
const GH_SEM_GRUPO = "GH0000";

async function discoverCatalogPlan(pool: SqlPool): Promise<CatalogPlan> {
  const r = await pool.request().query<{ nome: string; tipo: string }>(`
    SELECT c.name AS nome, ty.name AS tipo
    FROM sys.columns c
    JOIN sys.tables t  ON c.object_id = t.object_id
    JOIN sys.schemas s ON t.schema_id = s.schema_id
    JOIN sys.types ty  ON c.user_type_id = ty.user_type_id
    WHERE s.name = 'dbo' AND t.name = 'Stocks'
    ORDER BY c.column_id
  `);
  const textuais = r.recordset.filter((c) => /char|text/i.test(c.tipo));

  /** Primeira coluna textual que case com um dos padrões, por ordem de preferência. */
  const escolher = (padroes: RegExp[]): string | null => {
    for (const p of padroes) {
      const hit = textuais.find((c) => p.test(c.nome));
      if (hit) return hit.nome;
    }
    return null;
  };

  return {
    dci: escolher([/^dci$/i, /dci/i, /subst.nc/i, /princ.pio/i]),
    atc: escolher([/^atc$/i, /atc/i]),
    fabricante: escolher([/fabricante/i, /laborat/i, /titular/i, /marca/i]),
    fabricanteFk: await discoverFabricanteFk(pool, r.recordset),
    grupoHomogeneoLookup: await confirmarLookupGrupoHomogeneo(pool),
  };
}

/**
 * Confirma que a relação do Grupo Homogéneo existe nesta instalação. Não
 * procura nada: verifica os três nomes observados. Faltando um, o campo
 * vai NULL em vez de o upload rebentar numa instalação diferente.
 */
async function confirmarLookupGrupoHomogeneo(pool: SqlPool): Promise<boolean> {
  const r = await pool.request().query<{ emStocks: number; noLookup: number }>(`
    SELECT
      (SELECT COUNT(*) FROM sys.columns
        WHERE object_id = OBJECT_ID('dbo.Stocks') AND name = '${GH.coluna}')      AS emStocks,
      (SELECT COUNT(*) FROM sys.columns
        WHERE object_id = OBJECT_ID('dbo.${GH.tabela}')
          AND name IN ('${GH.coluna}', '${GH.texto}'))                            AS noLookup
  `);
  const x = r.recordset[0];
  return Number(x?.emStocks ?? 0) === 1 && Number(x?.noLookup ?? 0) === 2;
}

/**
 * Procura o par (coluna de código em Stocks, tabela de lookup) para o
 * fabricante. Exige as três evidências, e devolve null se faltar uma —
 * sem lookup confirmado o payload leva fabricante=null em vez de um
 * código interno que não significa nada fora desta instalação.
 */
async function discoverFabricanteFk(
  pool: SqlPool,
  stocksCols: Array<{ nome: string; tipo: string }>,
): Promise<CatalogPlan["fabricanteFk"]> {
  const candidatas = stocksCols.filter(
    (c) => /fabricante|laborat|titular/i.test(c.nome) && /int/i.test(c.tipo),
  );
  for (const col of candidatas) {
    // A tabela de lookup tem o nome da coluna sem o sufixo ID.
    const base = col.nome.replace(/id$/i, "");
    const r = await pool.request().input("b", sql.NVarChar, `%${base}%`).query<{
      tabela: string; pk: string; texto: string;
    }>(`
      SELECT TOP 1
        t.name AS tabela,
        pkc.name AS pk,
        txt.name AS texto
      FROM sys.tables t
      JOIN sys.schemas s ON s.schema_id = t.schema_id
      JOIN sys.indexes i ON i.object_id = t.object_id AND i.is_primary_key = 1
      JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
      JOIN sys.columns pkc ON pkc.object_id = ic.object_id AND pkc.column_id = ic.column_id
      JOIN sys.columns txt ON txt.object_id = t.object_id
      JOIN sys.types ty ON ty.user_type_id = txt.user_type_id
      WHERE s.name = 'dbo' AND t.name LIKE @b
        AND pkc.name = '${col.nome.replace(/'/g, "''")}'
        AND ty.name IN ('varchar','nvarchar','char','nchar')
      ORDER BY txt.max_length DESC
    `);
    const hit = r.recordset[0];
    if (hit) {
      return { stocksColumn: col.nome, table: hit.tabela, pk: hit.pk, textColumn: hit.texto };
    }
  }
  return null;
}

function logCatalogPlan(plan: CatalogPlan): void {
  const f = (label: string, col: string | null) =>
    console.log(`     ${label.padEnd(16)} ${col ? `Stocks.[${col}]` : "✗ não detectada — enviado NULL"}`);
  console.log("  Plano de catálogo regulamentar (rev46):");
  f("DCI:", plan.dci);
  f("ATC:", plan.atc);
  f("Fabricante:", plan.fabricante);
  console.log(
    `     ${"Grupo Homog. :".padEnd(16)} ${
      plan.grupoHomogeneoLookup
        ? `Stocks.[${GH.coluna}] -> ${GH.tabela}.[${GH.coluna}] -> [${GH.texto}]  (${GH_SEM_GRUPO} = sem grupo)`
        : "✗ lookup ausente — enviado NULL"
    }`,
  );
  if (plan.fabricanteFk) {
    const k = plan.fabricanteFk;
    console.log(`     ${"Fabricante (FK):".padEnd(16)} Stocks.[${k.stocksColumn}] -> ${k.table}.[${k.pk}] -> [${k.textColumn}]`);
  }
  if (!plan.dci && !plan.atc && !plan.grupoHomogeneoLookup && !plan.fabricante && !plan.fabricanteFk) {
    console.log("     Nenhum campo detectado nesta instalação — o catálogo vai sem enriquecimento do ERP.");
  }
}

async function discoverIvaJoinPlan(pool: SqlPool): Promise<IvaJoinPlan> {
  // 1. Coluna IVA em Stocks (qualquer coluna com 'iva' no nome — preferimos
  // "Taxa IVA" mas aceitamos outras variantes)
  const stocksColsR = await pool.request().query<{ column_: string }>(`
    SELECT c.name AS column_
    FROM sys.columns c
    JOIN sys.tables t  ON c.object_id = t.object_id
    JOIN sys.schemas s ON t.schema_id = s.schema_id
    WHERE s.name = 'dbo' AND t.name = 'Stocks' AND c.name LIKE '%iva%'
    ORDER BY c.column_id
  `);
  const ivaInStocks = stocksColsR.recordset.map((r) => r.column_);
  // Preferência: nome com 'taxa' primeiro (Taxa IVA), depois qualquer com 'iva'
  const stocksColumn =
    ivaInStocks.find((c) => /taxa/i.test(c)) ?? ivaInStocks[0] ?? null;

  // 2. dbo.IVA existe?
  const ivaExistsR = await pool.request().query<{ n: number }>(`
    SELECT COUNT(*) AS n
    FROM sys.tables t
    JOIN sys.schemas s ON t.schema_id = s.schema_id
    WHERE s.name = 'dbo' AND t.name = 'IVA'
  `);
  if (Number(ivaExistsR.recordset[0]?.n ?? 0) === 0) {
    return { stocksColumn, masterTable: null, masterPk: null, masterRateColumn: null };
  }

  // 3. PK de dbo.IVA (esperado: [IVA id] simples)
  const pkR = await pool.request().query<{ col: string }>(`
    SELECT c.name AS col
    FROM sys.indexes i
    JOIN sys.index_columns ic ON i.object_id=ic.object_id AND i.index_id=ic.index_id
    JOIN sys.columns c ON ic.object_id=c.object_id AND ic.column_id=c.column_id
    JOIN sys.tables t ON i.object_id=t.object_id
    JOIN sys.schemas s ON t.schema_id=s.schema_id
    WHERE s.name='dbo' AND t.name='IVA' AND i.is_primary_key=1
    ORDER BY ic.key_ordinal
  `);
  const pkCols = pkR.recordset.map((r) => r.col);
  const masterPk = pkCols.length === 1 ? pkCols[0] : null;
  if (!masterPk) {
    // PK composta ou inexistente — fallback: primeira coluna integer
    const colsR = await pool.request().query<{ name_: string; type_: string }>(`
      SELECT c.name AS name_, ty.name AS type_
      FROM sys.columns c
      JOIN sys.tables t ON c.object_id=t.object_id
      JOIN sys.schemas s ON t.schema_id=s.schema_id
      JOIN sys.types ty ON c.user_type_id=ty.user_type_id
      WHERE s.name='dbo' AND t.name='IVA'
      ORDER BY c.column_id
    `);
    const firstInt = colsR.recordset.find((c) => /int|tinyint|smallint|bigint/i.test(c.type_));
    if (firstInt) {
      return { stocksColumn, masterTable: "IVA", masterPk: firstInt.name_, masterRateColumn: null };
    }
    return { stocksColumn, masterTable: "IVA", masterPk: null, masterRateColumn: null };
  }

  // 4. Coluna percentual em dbo.IVA (numeric não-PK com domínio plausível)
  const masterRateColumn = await detectIvaRateColumn(pool, pkCols);

  return { stocksColumn, masterTable: "IVA", masterPk, masterRateColumn };
}

/**
 * Identifica a coluna percentual em `dbo.IVA`. Tenta na ordem:
 *   1. Match de nome forte: Taxa / Percentagem / Percent (case-insensitive)
 *   2. Match de domínio: numeric não-PK com 100% dos valores em
 *      taxas fiscais PT (escala % ou fracção)
 *   3. Variância: rejeita colunas constantes
 *
 * null se nenhuma coluna oferecer confiança suficiente — payload fica
 * com taxaIva=NULL e o operador corre `iva-audit` para validar.
 */
async function detectIvaRateColumn(pool: SqlPool, pkCols: string[]): Promise<string | null> {
  const colsR = await pool.request().query<{ name_: string; type_: string }>(`
    SELECT c.name AS name_, ty.name AS type_
    FROM sys.columns c
    JOIN sys.tables t ON c.object_id=t.object_id
    JOIN sys.schemas s ON t.schema_id=s.schema_id
    JOIN sys.types ty ON c.user_type_id=ty.user_type_id
    WHERE s.name='dbo' AND t.name='IVA'
    ORDER BY c.column_id
  `);
  const numericCols = colsR.recordset.filter(
    (c) =>
      /^(decimal|numeric|float|real|tinyint|smallint|int|bigint)$/i.test(c.type_) &&
      !pkCols.includes(c.name_),
  );
  if (numericCols.length === 0) return null;

  // 1. Match de nome forte (Taxa/Percent)
  for (const c of numericCols) {
    if (/^(taxa|percent(agem)?|perc)$/i.test(c.name_)) {
      return c.name_;
    }
  }

  // 1b. rev44 — "IVA valor"/"valor" no contexto de dbo.IVA é o canónico
  // SoftReis. Verificamos com domain match a seguir.
  const valorCandidate = numericCols.find((c) => /^(?:iva[_ ]?valor|valor)$/i.test(c.name_));

  // rev44 — detectar coluna inactivo para filtrar linhas históricas.
  // SoftReis tem ids 2/3/4/7 inactivos com taxas {0.05, 0.12, 0.20, 0.21}
  // que deixariam o detector falhar se contasse todas as linhas.
  const inactivoColR = await pool.request().query<{ name_: string }>(`
    SELECT TOP 1 c.name AS name_
    FROM sys.columns c
    JOIN sys.tables t ON c.object_id=t.object_id
    JOIN sys.schemas s ON t.schema_id=s.schema_id
    WHERE s.name='dbo' AND t.name='IVA'
      AND (c.name LIKE '%inactiv%' OR c.name LIKE '%inativ%')
    ORDER BY c.column_id
  `);
  const inactivoCol = inactivoColR.recordset[0]?.name_ ?? null;
  const activeFilter = inactivoCol ? `WHERE [${inactivoCol}] = 0` : "";

  // 2. Match de domínio + variância — apenas taxas válidas PT/farmácia.
  // Regra dura: 0/6/13/23 e equivalentes em fracção. Não aceitamos
  // taxas históricas (5/7/8/12/16/17/19/21) — essas viram "IVA por
  // apurar" no SaaS via normalizeIva(null).
  const PT_RATES = [0, 6, 13, 23];
  const PT_RATES_FRAC = PT_RATES.map((v) => v / 100);

  // Avaliar a candidata "valor" primeiro
  const ordered = valorCandidate
    ? [valorCandidate, ...numericCols.filter((c) => c.name_ !== valorCandidate.name_)]
    : numericCols;

  for (const c of ordered) {
    try {
      const r = await pool.request().query<{ v: number; n: number }>(`
        SELECT [${c.name_}] AS v, COUNT(*) AS n
        FROM [dbo].[IVA]
        ${activeFilter}
        GROUP BY [${c.name_}]
      `);
      const values = r.recordset.map((row) => Number(row.v)).filter(Number.isFinite);
      if (values.length < 2) continue; // sem variação, não é a taxa
      const allInPct = values.every((v) => PT_RATES.includes(v));
      const allInFrac = values.every((v) =>
        PT_RATES_FRAC.includes(Math.round(v * 100) / 100),
      );
      if (allInPct || allInFrac) return c.name_;
    } catch {
      // ignora
    }
  }

  return null;
}

function logIvaPlan(plan: IvaJoinPlan): void {
  console.log(`  ▸ rev44 IVA — plano de JOIN dbo.Stocks → dbo.IVA:`);
  console.log(`     Stocks.[${plan.stocksColumn ?? "✗"}]  ==  IVA.[${plan.masterPk ?? "✗"}]`);
  console.log(`     rateColumn: ${plan.masterRateColumn ? `IVA.[${plan.masterRateColumn}]` : "✗ (não detectada — taxaIva será NULL no payload)"}`);
  if (!plan.stocksColumn) {
    console.log(`     ⚠ Stocks não tem coluna 'iva' — corre run-iva-audit.bat para diagnóstico`);
  }
  if (!plan.masterTable) {
    console.log(`     ⚠ dbo.IVA não existe nesta instalação — corre run-iva-audit.bat para identificar master alternativa`);
  }
  if (plan.masterTable && !plan.masterRateColumn) {
    console.log(`     ⚠ dbo.IVA existe mas a coluna percentual não foi identificada — corre run-iva-audit.bat (dump completo + análise automática)`);
  }
}

export async function runProductsPipeline(
  pool: SqlPool,
  client: SaasClient,
  farmaciaId: string,
  opts?: { dryRun?: boolean; batchSize?: number; retry?: boolean }
): Promise<PipelineTotals> {
  const dryRun = opts?.dryRun === true;
  // rev45 — batch/retry configuráveis. Caller `products-upload` passa
  // batchSize=25 + retry=true para sobreviver a cold-starts longos do
  // Neon. `bootstrap-upload` (caller original) não passa opts e fica
  // com o comportamento legacy (50, sem retry).
  const initialBatchSize = Math.max(MIN_PRODUCTS_BATCH, opts?.batchSize ?? PRODUCTS_BATCH);
  const enableRetry = opts?.retry === true;
  let currentBatchSize = initialBatchSize;
  const totals = emptyTotals();
  let lastCodigoId = -1;
  console.log(DOUBLE_RULE);
  console.log(
    `▶ Pipeline 1: PRODUTOS (batch=${currentBatchSize}${enableRetry ? ", retry+backoff+shrink" : ""})${dryRun ? " [DRY-RUN]" : ""}`,
  );
  console.log(DOUBLE_RULE);

  // rev42 — IVA via JOIN explícito a dbo.IVA (master canónica confirmada
  // pelo iva-audit rev41). O agent envia a percentagem já resolvida —
  // sem mais códigos crus para o SaaS interpretar. Quando o plano não
  // está completo (ex.: instalação sem dbo.IVA), o SELECT emite NULL
  // e o payload preserva o existente no SaaS via COALESCE.
  const ivaPlan = await discoverIvaJoinPlan(pool);
  logIvaPlan(ivaPlan);

  const catalogPlan = await discoverCatalogPlan(pool);
  logCatalogPlan(catalogPlan);
  const col = (c: string | null) => (c ? `s.[${c}]` : `CAST(NULL AS NVARCHAR(200))`);
  const dciSelect = col(catalogPlan.dci);
  const atcSelect = col(catalogPlan.atc);
  // Grupo Homogéneo: descrição do lookup, nunca o código interno — GH0052
  // não significa nada fora desta instalação; "Paracetamol | A101 | Oral |
  // 1000 mg" significa em todas.
  const ghSelect = catalogPlan.grupoHomogeneoLookup
    ? `gh_lk.[${GH.texto}]`
    : `CAST(NULL AS NVARCHAR(200))`;
  // A sentinela fica de fora do JOIN: "sem grupo" tem de chegar ao SaaS
  // como NULL e não como uma descrição de grupo que não existe.
  const ghJoin = catalogPlan.grupoHomogeneoLookup
    ? `LEFT JOIN [dbo].[${GH.tabela}] gh_lk
         ON gh_lk.[${GH.coluna}] = s.[${GH.coluna}]
        AND s.[${GH.coluna}] <> '${GH_SEM_GRUPO}'`
    : ``;
  // Coluna directa se existir; senão o texto do lookup confirmado.
  const fabricanteSelect = catalogPlan.fabricante
    ? `s.[${catalogPlan.fabricante}]`
    : catalogPlan.fabricanteFk
      ? `fab_lk.[${catalogPlan.fabricanteFk.textColumn}]`
      : `CAST(NULL AS NVARCHAR(200))`;
  const fabricanteJoin = !catalogPlan.fabricante && catalogPlan.fabricanteFk
    ? `LEFT JOIN [dbo].[${catalogPlan.fabricanteFk.table}] fab_lk
         ON fab_lk.[${catalogPlan.fabricanteFk.pk}] = s.[${catalogPlan.fabricanteFk.stocksColumn}]`
    : ``;

  const ivaJoinClause =
    ivaPlan.masterTable && ivaPlan.masterPk && ivaPlan.stocksColumn
      ? `LEFT JOIN [dbo].[${ivaPlan.masterTable}] iva_master
           ON iva_master.[${ivaPlan.masterPk}] = s.[${ivaPlan.stocksColumn}]`
      : ``;
  const ivaSelect =
    ivaPlan.masterTable && ivaPlan.masterRateColumn
      ? `iva_master.[${ivaPlan.masterRateColumn}]`
      : `CAST(NULL AS DECIMAL(7,4))`;

  while (true) {
    const rs = await pool
      .request()
      .input("lastId", sql.Int, lastCodigoId)
      .input("n", sql.Int, currentBatchSize)
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
        taxaIva: unknown;
        dci: unknown;
        codigoATC: unknown;
        grupoHomogeneo: unknown;
        fabricante: unknown;
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
          f.[Nome Abreviado]           AS fornecedorHabitualNome,
          ${ivaSelect}                 AS taxaIva,
          ${dciSelect}                 AS dci,
          ${atcSelect}                 AS codigoATC,
          ${ghSelect}                  AS grupoHomogeneo,
          ${fabricanteSelect}          AS fabricante
        FROM [dbo].[Stocks] s
        OUTER APPLY (
          SELECT TOP 1 [Fornecedor Habitual]
          FROM [dbo].[ArmazensStocks]
          WHERE CodigoID = s.CodigoID
          ORDER BY ArmazemID
        ) ars
        LEFT JOIN [dbo].[Fornecedores] f ON f.[Fornecedor ID] = ars.[Fornecedor Habitual]
        ${ivaJoinClause}
        ${fabricanteJoin}
        ${ghJoin}
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
      taxaIva: numOrNull(r.taxaIva),
      dci: strOrNull(r.dci),
      codigoATC: strOrNull(r.codigoATC),
      grupoHomogeneo: strOrNull(r.grupoHomogeneo),
      fabricante: strOrNull(r.fabricante),
    }));

    if (dryRun) {
      totals.batches++;
      console.log(`  batch ${totals.batches} [dry-run]: read=${rs.recordset.length} payloads=${items.length} (não enviado)`);
    } else if (!enableRetry) {
      // Caminho legacy (bootstrap-upload original): 1 tentativa, sem
      // backoff. Erros transientes propagam ao caller que aborta tudo.
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
    } else {
      // rev45 — retry+backoff+shrink. Reusa o padrão validado em
      // stocksmov-upload rev35. Idempotente via UPSERT server-side
      // (Produto + ProdutoFarmacia por (farmaciaId, externalProductId)).
      let attemptResponse: BootstrapBatchResponse | null = null;
      let attemptError: unknown = null;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          attemptResponse = await client.bootstrapProducts(
            { farmaciaId, items },
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
            `  ↳ batch (size=${currentBatchSize}, lastId=${lastCodigoId}) tentativa ${attempt}/${MAX_RETRIES} falhou (${reason}); backoff ${backoff}ms`,
          );
          await sleep(backoff);
        }
      }

      if (attemptResponse === null) {
        if (isTransientError(attemptError) && currentBatchSize > MIN_PRODUCTS_BATCH) {
          const newSize = Math.max(MIN_PRODUCTS_BATCH, Math.floor(currentBatchSize / 2));
          console.log(
            `  ↳ shrink: ${currentBatchSize} → ${newSize} (lastId ${lastCodigoId} preservado, idempotente via UPSERT)`,
          );
          currentBatchSize = newSize;
          continue; // NÃO avançar keyset — re-le com batch menor
        }
        // Não-transiente ou já em MIN_PRODUCTS_BATCH — propaga.
        throw attemptError;
      }

      accumulate(totals, attemptResponse);
      console.log(
        `  batch ${totals.batches}: read=${rs.recordset.length} accepted=${attemptResponse.accepted} upserted=${attemptResponse.upserted} skipped=${attemptResponse.skipped.length} errors=${attemptResponse.errors.length}`
      );
      if (attemptResponse.errors.length > 0) {
        for (const e of attemptResponse.errors.slice(0, 3)) {
          console.log(`    ✗ idx=${e.index} ext=${e.externalId ?? "?"} ${e.reason}: ${e.message}`);
        }
      }
    }

    // Avançar keyset pelo último CodigoID lido (rows ordenados ASC)
    const last = rs.recordset[rs.recordset.length - 1];
    if (last && typeof last.externalProductId === "number") {
      lastCodigoId = last.externalProductId;
    }
    if (rs.recordset.length < currentBatchSize) break;
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
