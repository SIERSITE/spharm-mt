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
import {
  classifyRaw,
  type RawStocksMovLine,
  type TipoMovimentoArtigo,
} from "../movimento-classifier.js";

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
  // rev36 — ERP parity enrichment
  bonusEnt: number | null;
  bonusSai: number | null;
  existenciaBonus: number | null;
  precoVenda: number | string | null;
  valorVenda: number | string | null;
  /// Atendimento.[Numero Documento Externo] — fallback formatado.
  atNDocExterno: string | null;
  /// dbo.Entidades.Nome via Atendimento.EntidadeID — nome do cliente.
  clienteNome: string | null;
  /// Recepcao_Cab.NumeroDocumento — "60566".
  recNDoc: string | null;
  /// Recepcao_Cab.NDocExternoFornecedor — "FE26X1/1012857" ou "1/655".
  recRefExterna: string | null;
  /// Fornecedor da Recepcao_Cab.
  recFornecedorNome: string | null;
  /// Devolucao_Cab.NumeroDocumento.
  devNDoc: string | null;
  /// Devolucao_Cab.NDocExternoFornecedor.
  devRefExterna: string | null;
  /// Fornecedor da Devolucao_Cab.
  devFornecedorNome: string | null;
  /// dbo.Armazens.Designacao.
  armazemNome: string | null;
  /// dbo.Operadores.Nome via cab.[User ID]. Só mov-interno.
  operadorNome: string | null;
  // ── rev38 — Serie + Numero compostos + ref talão NC ─────────
  /// Atendimento Serie + Numero — alimentam "G/783019".
  atSerie: string | null;
  atNumero: number | string | null;
  /// Atendimento Origem Serie + Numero — alimentam "Talão (VS) 52440"
  /// na NC (anula um Atendimento anterior).
  atOrigemSerie: string | null;
  atOrigemNumero: number | string | null;
  atOrigemTipo: string | null;
  /// Recepcao_Cab Serie + Numero — alimentam "G/60660" ou "60660".
  recSerie: string | null;
  recNumero: number | string | null;
  /// Devolucao_Cab Serie + Numero.
  devSerie: string | null;
  devNumero: number | string | null;
  /// tblMovStocksCab Serie + Numero — transferências ("VCG_1/2169")
  /// e mov-interno em geral (perdas, ajustes, inventário).
  cabSerie: string | null;
  cabNumero: number | string | null;
};

type ContraparteTipo =
  | "CLIENTE"
  | "FORNECEDOR"
  | "FARMACIA_ORIGEM"
  | "FARMACIA_DESTINO";

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
  // rev36 — ERP parity (composto no agent a partir do FK pattern)
  documentoTipo: string | null;
  documentoNumero: string | null;
  referenciaExterna: string | null;
  contraparteNome: string | null;
  contraparteTipo: ContraparteTipo | null;
  armazemNome: string | null;
  utilizadorNome: string | null;
  quantidadeBonusEnt: number;
  quantidadeBonusSai: number;
  existenciaBonusApos: number;
  precoUnitario: number | null;
  valorLinha: number | null;
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

// ── Dynamic schema discovery (rev37) ───────────────────────────────
//
// rev34 confirmou que nomes Softreis variam por instalação. rev36 caiu
// neste mesmo padrão: `Atendimento.EntidadeID` é `[Entidade ID]` (com
// espaço) numa instalação real. Em vez de tentar adivinhar nome por
// nome (e pagar uma rev por falha), descobrimos TODOS os nomes em
// runtime via sys.columns no arranque do upload/dry-run e construímos
// o SQL com o que existe.
//
// Mesmo padrão do `movimentos-audit` (rev32) e `discover` — uma única
// query a sys.columns para todas as 9 tabelas candidatas, devolvendo
// o que está presente. Para cada coluna lógica que precisamos,
// pickCol() escolhe a primeira variante que existe; se nenhuma existir,
// emite NULL no SELECT (o JOIN também é skipped).
//
// Nomes confirmados rev34 (não-dinâmicos, hardcoded com segurança):
//   · dbo.tblMovStocksCab.[Tipo Documento ID]
//   · dbo.Atendimento.[Tipo Documento]
//   · dbo.[Atendimento Detalhe].[Detalhe ID] / [Atendimento ID]
//   · dbo.StocksMov.[Detalhe ID] / [Detalhe  Recp ID] (2 espaços)
//   · dbo.tblMovStocksDet, tblMovStocksCab, tblMovStocksCab_Motivo
//
// Tudo o que rev36 adicionou passa por descoberta.

type RawCol = {
  table: string;
  column: string;
  isPk: boolean;
  isNullable: boolean;
};

const DISCOVER_TABLES = [
  "StocksMov",
  "Atendimento",
  "Entidades",
  "Recepcao_Detalhe",
  "Recepcao_Cab",
  "Devolucao_Detalhe",
  "Devolucao_Cab",
  "Fornecedores",
  "Armazens",
  "Operadores",
  // rev38 — para descobrir Serie/Numero do mov-interno
  // (transferências, perdas, inventário, ajustes).
  "tblMovStocksCab",
] as const;

async function discoverColumns(pool: SqlPool): Promise<Map<string, RawCol[]>> {
  const inClause = DISCOVER_TABLES.map((t) => `'${t}'`).join(",");
  const r = await pool.request().query<{
    table_: string;
    column_: string;
    is_in_pk: boolean;
    is_nullable: boolean;
  }>(`
    SELECT
      t.name AS table_,
      c.name AS column_,
      ISNULL(pkInfo.is_in_pk, 0) AS is_in_pk,
      c.is_nullable
    FROM sys.columns c
    JOIN sys.tables t  ON c.object_id = t.object_id
    JOIN sys.schemas s ON t.schema_id = s.schema_id
    OUTER APPLY (
      SELECT MAX(1) AS is_in_pk
      FROM sys.index_columns ic
      JOIN sys.indexes i ON i.object_id=ic.object_id AND i.index_id=ic.index_id
      WHERE ic.object_id = c.object_id AND ic.column_id = c.column_id
        AND i.is_primary_key = 1
    ) pkInfo
    WHERE s.name = 'dbo' AND t.name IN (${inClause})
  `);
  const m = new Map<string, RawCol[]>();
  for (const row of r.recordset) {
    if (!m.has(row.table_)) m.set(row.table_, []);
    m.get(row.table_)!.push({
      table: row.table_,
      column: row.column_,
      isPk: Number(row.is_in_pk) === 1,
      isNullable: !!row.is_nullable,
    });
  }
  return m;
}

/// Primeira variante que existe (case-insensitive). Cada regex deve ser
/// uma âncora ^...$ para não match parcial. Devolve o nome EXACTO da
/// coluna (preservando case + espaços) para wrap em [...].
function pickCol(cols: RawCol[] | undefined, patterns: RegExp[]): string | null {
  if (!cols) return null;
  for (const re of patterns) {
    const m = cols.find((c) => re.test(c.column));
    if (m) return m.column;
  }
  return null;
}

/// Wrap nome de coluna em [name] para handle de espaços / palavras
/// reservadas. Devolve null inalterado para o builder decidir emitir
/// NULL no SELECT.
function bk(col: string | null): string | null {
  return col ? `[${col}]` : null;
}

/// Schema resolvido para as JOINs rev36 + ERP-parity documental rev38.
/// Cada bloco pode ser null (tabela inexistente) ou ter campos null
/// (coluna não encontrada).
type JoinSchema = {
  stocksMov: {
    bonusEnt: string | null;
    bonusSai: string | null;
    existenciaBonus: string | null;
    precoVenda: string | null;
    valorVenda: string | null;
  };
  atendimento: {
    entidadeFk: string | null;
    // rev38 — Serie + Numero são os campos que o ERP imprime na coluna
    // "Documento" do relatório ("G/783019" = Serie "G" + Numero 783019).
    // `nDocExterno` continua a ser fallback (algumas séries têm AT-style
    // já formatado lá).
    serie: string | null;
    numero: string | null;
    nDocExterno: string | null;
    // rev38 — para a coluna "Externo" das Notas Crédito o ERP imprime
    // "Talão (VS) 52440" — Serie + Numero do atendimento original
    // (a venda que esta NC está a anular).
    origemSerie: string | null;
    origemNumero: string | null;
    /// Tipo do documento original ("Talão", "Factura"…) quando capturado
    /// no Atendimento (ex: AtendimentoOrigem_TipoDoc). Opcional — quando
    /// presente, formata a ref como "{tipo} ({serie}) {num}"; senão usa
    /// "({serie}) {num}".
    origemTipo: string | null;
  };
  entidades:
    | { pk: string; nome: string | null }
    | null;
  recepcao:
    | {
        detPk: string;
        detCabFk: string;
        cabPk: string;
        // rev38 — Serie + Numero ⇒ "60660" ou "G/60660" consoante a
        // instalação. cabNDoc fica como fallback (algumas instalações
        // têm um único campo já formatado).
        cabSerie: string | null;
        cabNumero: string | null;
        cabNDoc: string | null;
        cabRefExterna: string | null;
        cabFornecedorFk: string | null;
      }
    | null;
  devolucao:
    | {
        detPk: string;
        detCabFk: string;
        cabPk: string;
        cabSerie: string | null;
        cabNumero: string | null;
        cabNDoc: string | null;
        cabRefExterna: string | null;
        cabFornecedorFk: string | null;
      }
    | null;
  fornecedores:
    | { pk: string; nome: string | null }
    | null;
  armazens:
    | { pk: string; designacao: string | null }
    | null;
  operadores:
    | { pk: string; nome: string | null }
    | null;
  // rev38 — mov-interno (transferências, perdas, ajustes, inventário).
  // Aliases para Serie/Numero de tblMovStocksCab. NDocExterno já é
  // capturado na cadeia de JOIN base (cabNDocExterno).
  movStocksCab: {
    serie: string | null;
    numero: string | null;
  };
};

function resolveJoinSchema(cols: Map<string, RawCol[]>): JoinSchema {
  const sm = cols.get("StocksMov");
  const at = cols.get("Atendimento");
  const ent = cols.get("Entidades");
  const rd = cols.get("Recepcao_Detalhe");
  const rc = cols.get("Recepcao_Cab");
  const dd = cols.get("Devolucao_Detalhe");
  const dc = cols.get("Devolucao_Cab");
  const fo = cols.get("Fornecedores");
  const ar = cols.get("Armazens");
  const op = cols.get("Operadores");
  const mc = cols.get("tblMovStocksCab");

  // StocksMov columns rev36 — opcionais (NULL se não existirem).
  const stocksMov = {
    bonusEnt: pickCol(sm, [/^bonus\s*ent$/i, /^bonus\s*entrada$/i, /^qtd\s*bonus\s*ent$/i]),
    bonusSai: pickCol(sm, [/^bonus\s*sai$/i, /^bonus\s*saida$/i, /^qtd\s*bonus\s*sai$/i]),
    existenciaBonus: pickCol(sm, [/^existencia\s*bonus$/i, /^exist\s*bonus$/i]),
    precoVenda: pickCol(sm, [/^preco\s*venda$/i, /^pvp\s*venda$/i, /^pvp$/i]),
    valorVenda: pickCol(sm, [/^valor\s*venda$/i, /^valor$/i]),
  };

  // Atendimento — entidade FK + Serie + Numero + NDocExterno + Origem
  // (NCs). Serie+Numero é a fonte canónica do "G/783019" / "VSG/25113"
  // que o ERP imprime; NDocExterno fica como fallback para instalações
  // que já tenham o formato pronto.
  const atSchema = {
    entidadeFk: pickCol(at, [/^entidade\s*id$/i, /^cliente\s*id$/i]),
    serie: pickCol(at, [
      /^serie\s*documento$/i,
      /^serie\s*doc$/i,
      /^serie$/i,
    ]),
    numero: pickCol(at, [
      /^numero\s*documento$/i,
      /^numero\s*doc$/i,
      /^numero$/i,
    ]),
    nDocExterno: pickCol(at, [
      /^numero\s*documento\s*externo$/i,
      /^n\s*doc\s*externo$/i,
      /^ndoc\s*externo$/i,
    ]),
    origemSerie: pickCol(at, [
      /^atendimento\s*origem\s*serie$/i,
      /^serie\s*origem$/i,
      /^talao\s*origem\s*serie$/i,
      /^atendimento\s*origem\s*serie\s*doc$/i,
    ]),
    origemNumero: pickCol(at, [
      /^atendimento\s*origem\s*numero$/i,
      /^numero\s*origem$/i,
      /^talao\s*origem\s*numero$/i,
      /^atendimento\s*origem\s*numero\s*doc$/i,
    ]),
    origemTipo: pickCol(at, [
      /^atendimento\s*origem\s*tipo\s*documento$/i,
      /^tipo\s*documento\s*origem$/i,
      /^atendimento\s*origem\s*tipo\s*doc$/i,
    ]),
  };

  // Entidades — só existe se a tabela e a PK resolverem.
  const entPk = pickCol(ent, [/^entidade\s*id$/i]);
  const entSchema = ent && entPk
    ? { pk: entPk, nome: pickCol(ent, [/^nome$/i, /^designacao$/i, /^razao\s*social$/i]) }
    : null;

  // Recepcao chain — det.PK + det.cabFK + cab.PK obrigatórios. rev38
  // adiciona Serie + Numero para alinhar com o display do ERP.
  const rdPk = pickCol(rd, [/^detalhe\s*recp\s*id$/i, /^recp\s*detalhe\s*id$/i, /^detalhe\s*id$/i]);
  const rdCabFk = pickCol(rd, [/^recepcao\s*id$/i, /^recep\s*id$/i]);
  const rcPk = pickCol(rc, [/^recepcao\s*id$/i, /^recep\s*id$/i]);
  const recepcao = rd && rc && rdPk && rdCabFk && rcPk
    ? {
        detPk: rdPk,
        detCabFk: rdCabFk,
        cabPk: rcPk,
        cabSerie: pickCol(rc, [
          /^serie\s*documento$/i,
          /^serie\s*recepcao$/i,
          /^serie\s*recep$/i,
          /^serie$/i,
        ]),
        cabNumero: pickCol(rc, [
          /^numero\s*documento$/i,
          /^numero\s*recepcao$/i,
          /^numero\s*recep$/i,
          /^numero$/i,
        ]),
        cabNDoc: pickCol(rc, [
          /^numero\s*documento$/i,
          /^n\s*doc$/i,
          /^ndoc$/i,
          /^numero\s*doc$/i,
        ]),
        cabRefExterna: pickCol(rc, [
          /^ndoc\s*externo\s*fornecedor$/i,
          /^n\s*doc\s*externo\s*fornecedor$/i,
          /^numero\s*documento\s*externo$/i,
          /^ndoc\s*externo$/i,
        ]),
        cabFornecedorFk: pickCol(rc, [/^fornecedor\s*id$/i]),
      }
    : null;

  // Devolução chain — idem.
  const ddPk = pickCol(dd, [/^devolucao\s*detalhe\s*id$/i, /^detalhe\s*id$/i]);
  const ddCabFk = pickCol(dd, [/^devolucao\s*id$/i]);
  const dcPk = pickCol(dc, [/^devolucao\s*id$/i]);
  const devolucao = dd && dc && ddPk && ddCabFk && dcPk
    ? {
        detPk: ddPk,
        detCabFk: ddCabFk,
        cabPk: dcPk,
        cabSerie: pickCol(dc, [
          /^serie\s*documento$/i,
          /^serie\s*devolucao$/i,
          /^serie$/i,
        ]),
        cabNumero: pickCol(dc, [
          /^numero\s*documento$/i,
          /^numero\s*devolucao$/i,
          /^numero$/i,
        ]),
        cabNDoc: pickCol(dc, [
          /^numero\s*documento$/i,
          /^n\s*doc$/i,
          /^ndoc$/i,
          /^numero\s*doc$/i,
        ]),
        cabRefExterna: pickCol(dc, [
          /^ndoc\s*externo\s*fornecedor$/i,
          /^n\s*doc\s*externo\s*fornecedor$/i,
          /^numero\s*documento\s*externo$/i,
        ]),
        cabFornecedorFk: pickCol(dc, [/^fornecedor\s*id$/i]),
      }
    : null;

  // Fornecedores / Armazens / Operadores — lookups simples.
  const foPk = pickCol(fo, [/^fornecedor\s*id$/i]);
  const fornecedores = fo && foPk
    ? { pk: foPk, nome: pickCol(fo, [/^nome$/i, /^designacao$/i, /^razao\s*social$/i]) }
    : null;
  const arPk = pickCol(ar, [/^armazem\s*id$/i]);
  const armazens = ar && arPk
    ? { pk: arPk, designacao: pickCol(ar, [/^designacao$/i, /^nome$/i, /^descricao$/i]) }
    : null;
  const opPk = pickCol(op, [/^user\s*id$/i, /^operador\s*id$/i, /^op\s*id$/i]);
  const operadores = op && opPk
    ? { pk: opPk, nome: pickCol(op, [/^nome$/i, /^designacao$/i]) }
    : null;

  // rev38 — mov-interno (transferências, perdas, ajustes, inventário).
  // Serie+Numero quando a instalação os tem; `cabNDocExterno` (já no
  // SELECT base) continua como fallback.
  const movStocksCab = {
    serie: pickCol(mc, [
      /^serie\s*documento$/i,
      /^serie\s*mov\s*stocks$/i,
      /^serie$/i,
    ]),
    numero: pickCol(mc, [
      /^numero\s*documento$/i,
      /^numero\s*mov\s*stocks$/i,
      /^numero$/i,
    ]),
  };

  return {
    stocksMov,
    atendimento: atSchema,
    entidades: entSchema,
    recepcao,
    devolucao,
    fornecedores,
    armazens,
    operadores,
    movStocksCab,
  };
}

/// Linha SELECT: `<expr> AS <alias>`. Quando `expr` é null, emite
/// `NULL AS <alias>` — preserva o tipo de retorno do recordset.
function selectLine(alias: string, expr: string | null): string {
  return `    ${expr ?? "NULL"} AS ${alias}`;
}

/// Constrói o SOURCE_SQL final usando o schema descoberto. Aliases
/// das colunas continuam estáveis (alimentam o `StocksMovRow`).
function buildSourceSql(schema: JoinSchema): string {
  const select: string[] = [
    "    sm.StocksMovID",
    "    sm.CodigoID",
    "    sm.DataMov",
    "    sm.Qtd",
    "    sm.QtdBonus",
    "    sm.Existencia",
    "    sm.ValorCustoUnit",
    "    sm.OldPMC",
    "    sm.NovoPMC",
    "    sm.StocksMovArmazemID",
    selectLine("bonusEnt", schema.stocksMov.bonusEnt ? `sm.${bk(schema.stocksMov.bonusEnt)}` : null),
    selectLine("bonusSai", schema.stocksMov.bonusSai ? `sm.${bk(schema.stocksMov.bonusSai)}` : null),
    selectLine("existenciaBonus", schema.stocksMov.existenciaBonus ? `sm.${bk(schema.stocksMov.existenciaBonus)}` : null),
    selectLine("precoVenda", schema.stocksMov.precoVenda ? `sm.${bk(schema.stocksMov.precoVenda)}` : null),
    selectLine("valorVenda", schema.stocksMov.valorVenda ? `sm.${bk(schema.stocksMov.valorVenda)}` : null),
    "    sm.[Detalhe ID]                       AS detalheId",
    "    sm.[Atendimento Susp Detalhe ID]      AS suspDetalheId",
    "    sm.[Atendimento Credito Detalhe ID]   AS creditoDetalheId",
    "    sm.[Detalhe  Recp ID]                 AS recpDetalheId",
    "    sm.[Devolucao Detalhe ID]             AS devolucaoDetalheId",
    "    sm.MovStocksDetID",
    "    cab.MovStocksCabID                    AS cabMovStocksCabID",
    "    cab.[Tipo Documento ID]               AS cabTipoDocId",
    "    cab.MovStocksCabMotivoID              AS cabMotivoId",
    "    mot.Motivo                            AS cabMotivoTexto",
    "    cab.MovStocksCabSituacaoID            AS cabSituacao",
    "    cab.[User ID]                         AS cabUserId",
    "    cab.Posto                             AS cabPosto",
    "    cab.NDocExterno                       AS cabNDocExterno",
    "    ad.[Atendimento ID]                   AS atendimentoId",
    "    at_.[Tipo Documento]                  AS atTipoDocId",
    selectLine(
      "atNDocExterno",
      schema.atendimento.nDocExterno ? `at_.${bk(schema.atendimento.nDocExterno)}` : null,
    ),
    // rev38 — Serie + Numero do Atendimento (compõem "G/783019").
    selectLine("atSerie", schema.atendimento.serie ? `at_.${bk(schema.atendimento.serie)}` : null),
    selectLine("atNumero", schema.atendimento.numero ? `at_.${bk(schema.atendimento.numero)}` : null),
    // rev38 — Atendimento de origem para NCs ("Talão (VS) 52440").
    selectLine(
      "atOrigemSerie",
      schema.atendimento.origemSerie ? `at_.${bk(schema.atendimento.origemSerie)}` : null,
    ),
    selectLine(
      "atOrigemNumero",
      schema.atendimento.origemNumero ? `at_.${bk(schema.atendimento.origemNumero)}` : null,
    ),
    selectLine(
      "atOrigemTipo",
      schema.atendimento.origemTipo ? `at_.${bk(schema.atendimento.origemTipo)}` : null,
    ),
    selectLine(
      "clienteNome",
      schema.entidades && schema.atendimento.entidadeFk && schema.entidades.nome
        ? `ent.${bk(schema.entidades.nome)}`
        : null,
    ),
    selectLine("recNDoc", schema.recepcao && schema.recepcao.cabNDoc ? `rc.${bk(schema.recepcao.cabNDoc)}` : null),
    // rev38 — Serie + Numero da Recepcao_Cab.
    selectLine(
      "recSerie",
      schema.recepcao && schema.recepcao.cabSerie ? `rc.${bk(schema.recepcao.cabSerie)}` : null,
    ),
    selectLine(
      "recNumero",
      schema.recepcao && schema.recepcao.cabNumero ? `rc.${bk(schema.recepcao.cabNumero)}` : null,
    ),
    selectLine(
      "recRefExterna",
      schema.recepcao && schema.recepcao.cabRefExterna ? `rc.${bk(schema.recepcao.cabRefExterna)}` : null,
    ),
    selectLine(
      "recFornecedorNome",
      schema.recepcao && schema.recepcao.cabFornecedorFk && schema.fornecedores && schema.fornecedores.nome
        ? `rf.${bk(schema.fornecedores.nome)}`
        : null,
    ),
    selectLine("devNDoc", schema.devolucao && schema.devolucao.cabNDoc ? `dc.${bk(schema.devolucao.cabNDoc)}` : null),
    // rev38 — Serie + Numero da Devolucao_Cab.
    selectLine(
      "devSerie",
      schema.devolucao && schema.devolucao.cabSerie ? `dc.${bk(schema.devolucao.cabSerie)}` : null,
    ),
    selectLine(
      "devNumero",
      schema.devolucao && schema.devolucao.cabNumero ? `dc.${bk(schema.devolucao.cabNumero)}` : null,
    ),
    selectLine(
      "devRefExterna",
      schema.devolucao && schema.devolucao.cabRefExterna ? `dc.${bk(schema.devolucao.cabRefExterna)}` : null,
    ),
    selectLine(
      "devFornecedorNome",
      schema.devolucao && schema.devolucao.cabFornecedorFk && schema.fornecedores && schema.fornecedores.nome
        ? `df.${bk(schema.fornecedores.nome)}`
        : null,
    ),
    selectLine(
      "armazemNome",
      schema.armazens && schema.armazens.designacao ? `arm.${bk(schema.armazens.designacao)}` : null,
    ),
    selectLine(
      "operadorNome",
      schema.operadores && schema.operadores.nome ? `op.${bk(schema.operadores.nome)}` : null,
    ),
    // rev38 — Serie + Numero do mov-interno (cab existing JOIN, novos campos).
    selectLine("cabSerie", schema.movStocksCab.serie ? `cab.${bk(schema.movStocksCab.serie)}` : null),
    selectLine("cabNumero", schema.movStocksCab.numero ? `cab.${bk(schema.movStocksCab.numero)}` : null),
  ];

  const joins: string[] = [
    "  LEFT JOIN dbo.tblMovStocksDet det",
    "    ON det.MovStocksDetID = sm.MovStocksDetID",
    "  LEFT JOIN dbo.tblMovStocksCab cab",
    "    ON cab.MovStocksCabID = det.MovStocksCabID",
    "  LEFT JOIN dbo.tblMovStocksCab_Motivo mot",
    "    ON mot.MovStocksCabMotivoID = cab.MovStocksCabMotivoID",
    "  LEFT JOIN dbo.[Atendimento Detalhe] ad",
    "    ON ad.[Detalhe ID] = sm.[Detalhe ID]",
    "  LEFT JOIN dbo.Atendimento at_",
    "    ON at_.[Atendimento ID] = ad.[Atendimento ID]",
  ];
  if (schema.entidades && schema.atendimento.entidadeFk) {
    joins.push(
      `  LEFT JOIN dbo.Entidades ent`,
      `    ON ent.${bk(schema.entidades.pk)} = at_.${bk(schema.atendimento.entidadeFk)}`,
    );
  }
  if (schema.recepcao) {
    joins.push(
      `  LEFT JOIN dbo.Recepcao_Detalhe rd`,
      `    ON rd.${bk(schema.recepcao.detPk)} = sm.[Detalhe  Recp ID]`,
      `  LEFT JOIN dbo.Recepcao_Cab rc`,
      `    ON rc.${bk(schema.recepcao.cabPk)} = rd.${bk(schema.recepcao.detCabFk)}`,
    );
    if (schema.recepcao.cabFornecedorFk && schema.fornecedores) {
      joins.push(
        `  LEFT JOIN dbo.Fornecedores rf`,
        `    ON rf.${bk(schema.fornecedores.pk)} = rc.${bk(schema.recepcao.cabFornecedorFk)}`,
      );
    }
  }
  if (schema.devolucao) {
    joins.push(
      `  LEFT JOIN dbo.Devolucao_Detalhe dd`,
      `    ON dd.${bk(schema.devolucao.detPk)} = sm.[Devolucao Detalhe ID]`,
      `  LEFT JOIN dbo.Devolucao_Cab dc`,
      `    ON dc.${bk(schema.devolucao.cabPk)} = dd.${bk(schema.devolucao.detCabFk)}`,
    );
    if (schema.devolucao.cabFornecedorFk && schema.fornecedores) {
      joins.push(
        `  LEFT JOIN dbo.Fornecedores df`,
        `    ON df.${bk(schema.fornecedores.pk)} = dc.${bk(schema.devolucao.cabFornecedorFk)}`,
      );
    }
  }
  if (schema.armazens) {
    joins.push(
      `  LEFT JOIN dbo.Armazens arm`,
      `    ON arm.${bk(schema.armazens.pk)} = sm.StocksMovArmazemID`,
    );
  }
  if (schema.operadores) {
    joins.push(
      `  LEFT JOIN dbo.Operadores op`,
      `    ON op.${bk(schema.operadores.pk)} = cab.[User ID]`,
    );
  }

  return [
    "  SELECT TOP (@limit)",
    select.join(",\n"),
    "  FROM dbo.StocksMov sm",
    joins.join("\n"),
    "  WHERE sm.DataMov >= @from",
    "    AND sm.DataMov <  @to",
    "    AND sm.StocksMovID > @sinceId",
    "  ORDER BY sm.StocksMovID",
  ].join("\n");
}

/// Log do schema resolvido — útil para o operador perceber o que foi
/// descoberto. rev38 reforça o output documental: Serie/Numero
/// descobertos para cada tabela + dump completo das colunas das 4
/// tabelas documentais (Atendimento, Recepcao_Cab, Devolucao_Cab,
/// tblMovStocksCab) para que qualquer mismatch entre o display do ERP
/// e o composer seja imediatamente diagnosticável sem correr scripts.
function logSchemaSummary(schema: JoinSchema, cols: Map<string, RawCol[]>): void {
  console.log("Schema descoberto (sys.columns):");
  console.log(
    `  StocksMov.bonus*/preco/valor : ent=${schema.stocksMov.bonusEnt ?? "—"} ` +
      `sai=${schema.stocksMov.bonusSai ?? "—"} exBon=${schema.stocksMov.existenciaBonus ?? "—"} ` +
      `pv=${schema.stocksMov.precoVenda ?? "—"} vv=${schema.stocksMov.valorVenda ?? "—"}`,
  );
  // rev38 — documento + origem (NC)
  console.log(
    `  Atendimento.{entidadeFk, serie, numero, nDocExt, origemSerie, origemNumero, origemTipo}`,
  );
  console.log(
    `    : ${schema.atendimento.entidadeFk ?? "—"} / ${schema.atendimento.serie ?? "—"} / ${schema.atendimento.numero ?? "—"} / ${schema.atendimento.nDocExterno ?? "—"} / ${schema.atendimento.origemSerie ?? "—"} / ${schema.atendimento.origemNumero ?? "—"} / ${schema.atendimento.origemTipo ?? "—"}`,
  );
  console.log(`  Entidades : ${schema.entidades ? `pk=${schema.entidades.pk}, nome=${schema.entidades.nome}` : "ausente"}`);
  console.log(
    `  Recepcao  : ${schema.recepcao ? `det.PK=${schema.recepcao.detPk}, det.cabFK=${schema.recepcao.detCabFk}, cab.PK=${schema.recepcao.cabPk}, Serie=${schema.recepcao.cabSerie ?? "—"}, Numero=${schema.recepcao.cabNumero ?? "—"}, NDoc=${schema.recepcao.cabNDoc ?? "—"}, RefExt=${schema.recepcao.cabRefExterna ?? "—"}, FornFK=${schema.recepcao.cabFornecedorFk ?? "—"}` : "ausente"}`,
  );
  console.log(
    `  Devolucao : ${schema.devolucao ? `det.PK=${schema.devolucao.detPk}, det.cabFK=${schema.devolucao.detCabFk}, cab.PK=${schema.devolucao.cabPk}, Serie=${schema.devolucao.cabSerie ?? "—"}, Numero=${schema.devolucao.cabNumero ?? "—"}, NDoc=${schema.devolucao.cabNDoc ?? "—"}, RefExt=${schema.devolucao.cabRefExterna ?? "—"}, FornFK=${schema.devolucao.cabFornecedorFk ?? "—"}` : "ausente"}`,
  );
  console.log(`  Fornecedores : ${schema.fornecedores ? `pk=${schema.fornecedores.pk}, nome=${schema.fornecedores.nome}` : "ausente"}`);
  console.log(`  Armazens : ${schema.armazens ? `pk=${schema.armazens.pk}, desig=${schema.armazens.designacao}` : "ausente"}`);
  console.log(`  Operadores : ${schema.operadores ? `pk=${schema.operadores.pk}, nome=${schema.operadores.nome}` : "ausente"}`);
  console.log(
    `  tblMovStocksCab.{serie, numero} : ${schema.movStocksCab.serie ?? "—"} / ${schema.movStocksCab.numero ?? "—"}`,
  );

  // rev38 — dump completo das colunas documentais para diagnóstico.
  // Útil quando o display do ERP não bate certo com o que foi composto:
  // o operador vê de imediato que campos estão disponíveis na sua
  // instalação Softreis e pode reportar o nome real para uma rev futura.
  console.log("");
  console.log("Colunas documentais (todas as candidatas — para diagnóstico):");
  for (const t of ["Atendimento", "Recepcao_Cab", "Devolucao_Cab", "tblMovStocksCab"]) {
    const c = cols.get(t);
    if (!c) {
      console.log(`  ${t}: (tabela ausente)`);
      continue;
    }
    const list = c.map((x) => x.column).sort().join(", ");
    console.log(`  ${t} (${c.length}): ${list}`);
  }
}

async function fetchPage(
  pool: SqlPool,
  sourceSql: string,
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
    .query<StocksMovRow>(sourceSql);
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

// ── ERP-parity composers (rev36) ───────────────────────────────────
//
// Cada movimento canónico tem 1 "documento" + 0..1 "contraparte" do
// ponto de vista operacional. Os helpers abaixo escolhem a fonte certa
// consoante o tipo classificado, mantendo o agent como única fonte de
// verdade desta composição (o endpoint apenas faz UPSERT do que recebe).

/// Mapeia `tipo` (classifier) para o rótulo de documento que o ERP imprime.
/// Espelha o "Tipo de Documento" da grelha "Movimento de Artigos".
function documentoTipoFor(tipo: TipoMovimentoArtigo): string {
  switch (tipo) {
    case "VENDA":
      return "Factura";
    case "DEVOLUCAO_CLIENTE":
      return "Nota Crédito";
    case "VENDA_CREDITO":
      return "Factura Crédito";
    case "RESERVA_SUSPENSA":
      return "Reserva";
    case "COMPRA":
      return "Recepção";
    case "DEVOLUCAO_FORNECEDOR":
      return "Devolução";
    case "TRANSFERENCIA_SAIDA":
      return "G/Transferência";
    case "TRANSFERENCIA_ENTRADA":
      return "Recepção"; // recepção via transferência inter-farmácia
    case "INVENTARIO":
      return "Inventário";
    case "QUEBRA":
      return "Quebra";
    case "PERDA":
      return "Perda";
    case "AJUSTE":
      return "Ajuste";
    case "DESCONHECIDO":
    default:
      return "?";
  }
}

/// rev38 — compõe "Serie/Numero" quando ambos os campos existem.
/// Trim numbers (podem vir como decimal "60660.0" do SQL Server) → int.
/// Retorna null se Serie ou Numero faltarem.
function composeSerieNumero(
  serie: string | null,
  numero: number | string | null | undefined,
): string | null {
  const s = strOrNull(serie);
  const n = numOrNull(numero);
  if (s && n !== null) return `${s}/${Math.trunc(n)}`;
  return null;
}

/// Escolhe o número de documento de acordo com a origem do movimento.
/// rev38 — preferência: Serie+Numero concatenados ("G/783019"); fallback
/// para o campo único pré-existente quando uma das peças não existir
/// (instalações Softreis que já formatem inline o NDocExterno).
///
///   · Vendas/devCliente/crédito → Atendimento.[Serie] + [Numero]
///                                  (fallback: [Numero Documento Externo])
///   · Compras                    → Recepcao_Cab.[Serie] + [Numero]
///                                  (fallback: NumeroDocumento)
///   · Devolução fornecedor       → Devolucao_Cab.[Serie] + [Numero]
///                                  (fallback: NumeroDocumento)
///   · Mov-interno                → tblMovStocksCab.[Serie] + [Numero]
///                                  (fallback: NDocExterno)
function documentoNumeroFor(r: StocksMovRow, tipo: TipoMovimentoArtigo): string | null {
  const isVendaLike =
    tipo === "VENDA" ||
    tipo === "DEVOLUCAO_CLIENTE" ||
    tipo === "VENDA_CREDITO" ||
    tipo === "RESERVA_SUSPENSA";
  if (isVendaLike) {
    return composeSerieNumero(r.atSerie, r.atNumero) ?? strOrNull(r.atNDocExterno);
  }
  if (tipo === "COMPRA") {
    return composeSerieNumero(r.recSerie, r.recNumero) ?? strOrNull(r.recNDoc);
  }
  if (tipo === "DEVOLUCAO_FORNECEDOR") {
    return composeSerieNumero(r.devSerie, r.devNumero) ?? strOrNull(r.devNDoc);
  }
  // mov-interno (transferências/inventário/quebra/perda/ajuste).
  return composeSerieNumero(r.cabSerie, r.cabNumero) ?? strOrNull(r.cabNDocExterno);
}

/// Referência externa cruzada (coluna "Externo" do ERP):
///   · Compra/devFornecedor → factura externa do fornecedor
///                            ("FE26X1/1012857") ou doc de transferência
///                            de outra farmácia ("G/Transferência 1/655")
///   · NC (devCliente)      → "Talão (Serie) Numero" do atendimento
///                            original que esta NC anula
///   · Outros               → NULL
function referenciaExternaFor(r: StocksMovRow, tipo: TipoMovimentoArtigo): string | null {
  if (tipo === "COMPRA") return strOrNull(r.recRefExterna);
  if (tipo === "DEVOLUCAO_FORNECEDOR") return strOrNull(r.devRefExterna);
  if (tipo === "DEVOLUCAO_CLIENTE") {
    const serie = strOrNull(r.atOrigemSerie);
    const num = numOrNull(r.atOrigemNumero);
    if (serie && num !== null) {
      const tipoOrig = strOrNull(r.atOrigemTipo);
      return tipoOrig
        ? `${tipoOrig} (${serie}) ${Math.trunc(num)}`
        : `Talão (${serie}) ${Math.trunc(num)}`;
    }
    return null;
  }
  return null;
}

/// Resolve nome + tipo da contraparte (coluna "Cliente/Fornecedor" do ERP):
///   · Vendas/devCliente/crédito  → Entidades.Nome (CLIENTE)
///   · Compras                    → Recepcao_Cab → Fornecedores.Nome (FORNECEDOR)
///   · Devolução fornecedor       → Devolucao_Cab → Fornecedores.Nome (FORNECEDOR)
///   · Transferências             → NULL nesta rev (origem/destino farmácia
///     vem em rev futura; o documento "G/Transferência …" já dá contexto)
///   · Mov-interno puro           → NULL
function contraparteFor(
  r: StocksMovRow,
  tipo: TipoMovimentoArtigo,
): { nome: string | null; tipo: ContraparteTipo | null } {
  if (
    tipo === "VENDA" ||
    tipo === "DEVOLUCAO_CLIENTE" ||
    tipo === "VENDA_CREDITO" ||
    tipo === "RESERVA_SUSPENSA"
  ) {
    return { nome: strOrNull(r.clienteNome), tipo: "CLIENTE" };
  }
  if (tipo === "COMPRA") {
    return { nome: strOrNull(r.recFornecedorNome), tipo: "FORNECEDOR" };
  }
  if (tipo === "DEVOLUCAO_FORNECEDOR") {
    return { nome: strOrNull(r.devFornecedorNome), tipo: "FORNECEDOR" };
  }
  return { nome: null, tipo: null };
}

function rowToPayload(r: StocksMovRow): MovimentoPayload | null {
  const externalMovId = numOrNull(r.StocksMovID);
  const externalProductId = numOrNull(r.CodigoID);
  if (externalMovId === null || externalProductId === null) return null;
  if (!(r.DataMov instanceof Date) || Number.isNaN(r.DataMov.getTime())) return null;
  // rev36: classifica primeiro porque os composers dependem do `tipo`
  // (ex: "Recepção" vs "G/Transferência" para FK recpDetalheId).
  const cls = classifyRaw(rowToRaw(r));
  const tipo = cls.tipo;
  const contraparte = contraparteFor(r, tipo);
  const bonusEnt = numOrNull(r.bonusEnt) ?? 0;
  const bonusSai = numOrNull(r.bonusSai) ?? 0;
  // Compatibilidade com o campo combinado deprecated: assina o bónus por
  // sentido (entrada positiva, saída negativa) — mantém o que o leitor
  // legacy esperava.
  const quantidadeBonusCombinado = bonusEnt - bonusSai;
  return {
    externalMovId,
    externalProductId: String(externalProductId),
    dataMovimento: r.DataMov.toISOString(),
    quantidade: numOrNull(r.Qtd) ?? 0,
    quantidadeBonus: quantidadeBonusCombinado,
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
    // rev36 — ERP parity
    documentoTipo: documentoTipoFor(tipo),
    documentoNumero: documentoNumeroFor(r, tipo),
    referenciaExterna: referenciaExternaFor(r, tipo),
    contraparteNome: contraparte.nome,
    contraparteTipo: contraparte.tipo,
    armazemNome: strOrNull(r.armazemNome),
    utilizadorNome: strOrNull(r.operadorNome),
    quantidadeBonusEnt: bonusEnt,
    quantidadeBonusSai: bonusSai,
    existenciaBonusApos: numOrNull(r.existenciaBonus) ?? 0,
    precoUnitario: numOrNull(r.precoVenda),
    valorLinha: numOrNull(r.valorVenda),
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
      // rev37: discovery dinâmica antes do primeiro SELECT.
      console.log(`▶ Discovery de colunas (sys.columns) ...`);
      const cols = await discoverColumns(pool);
      const schema = resolveJoinSchema(cols);
      logSchemaSummary(schema, cols);
      const sourceSql = buildSourceSql(schema);
      console.log("");
      console.log(`▶ A ler dbo.StocksMov (até ${SQL_CHUNK_SIZE} linhas) ...`);
      const rows = await fetchPage(pool, sourceSql, from, to, args.sinceId ?? 0, SQL_CHUNK_SIZE);
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

      // rev37: discovery dinâmica antes do loop de chunks. Tabelas/
      // colunas em falta caem para NULL no SELECT em vez de fazer a
      // query rebentar. Custo: 1 query a sys.columns no arranque.
      console.log("▶ Discovery de colunas (sys.columns) ...");
      const cols = await discoverColumns(pool);
      const schema = resolveJoinSchema(cols);
      logSchemaSummary(schema, cols);
      const sourceSql = buildSourceSql(schema);
      console.log("");

      let sinceId = args.sinceId ?? 0;
      let lastReportTime = Date.now();
      // rev35: o tamanho efectivo arranca em `httpBatch` (default 100) e
      // só pode descer (auto-shrink em 504/503/502). Mantemos em scope
      // do upload todo — se um batch grande falhar e baixar para 50,
      // os batches seguintes continuam a 50 (não voltam a tentar 100).
      let currentBatchSize = Math.max(MIN_HTTP_BATCH, httpBatch);

      while (true) {
        const chunkT0 = Date.now();
        const rows = await fetchPage(pool, sourceSql, from, to, sinceId, SQL_CHUNK_SIZE);
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
