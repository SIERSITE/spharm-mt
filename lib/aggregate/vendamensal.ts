/**
 * lib/aggregate/vendamensal.ts
 *
 * Core agregação `IngestVendaLinhaRaw` → `VendaMensal` por mês.
 * Extraído de `scripts/aggregate-vendamensal.ts` para que possa ser
 * invocado tanto pela CLI como pelo endpoint
 * `/api/admin/pipeline/aggregate-month` (chamado pelo agent on-prem).
 *
 * Responsabilidades:
 *   · preflight: counts raw, distribuição por classe, orphans split
 *     (non-stock services vs. operational), unknowns
 *   · runAggregation: SQL group-by com sinal VENDA/DEVOLUCAO_ANULACAO
 *   · writeAggregation: DELETE scoped + INSERT MANY em transaction, sob
 *     advisory lock por mês (ver a nota dentro da função)
 *
 * Função NUNCA chama process.exit nem console.log; devolve estado
 * estruturado. Caller (CLI ou endpoint) decide como reportar.
 */

import { PrismaClient, Prisma } from "@/generated/prisma/client";
import { withRetry } from "./chunk-util";

export const ORIGEM_AGREGACAO = "agent-bootstrap-staging";

/* ---------- Semântica de venda — fonte única ----------
 *
 * Estes três fragmentos definem o que É uma venda no SPharm.MT. Vivem
 * aqui, e não em cada consumidor, porque a agregação mensal e o
 * relatório de Vendas TÊM de responder o mesmo para a mesma janela — e
 * durante meses não responderam: o relatório somava `VendaMensal`
 * (mês inteiro, sinal perdido) e a agregação somava o raw com sinal.
 *
 * Regras, tal como o ERP as reporta:
 *   · VENDA soma, DEVOLUCAO_ANULACAO subtrai
 *   · UNKNOWN não entra em soma nenhuma (fica para caracterizar)
 *   · linhas sem produto operacional (taxas, serviços) ficam de fora
 *
 * Os nomes das colunas vêm SEM prefixo de tabela de propósito: obriga
 * quem os usa a não pôr alias no FROM, e assim os dois caminhos são
 * literalmente o mesmo SQL.
 */

/** Unidades com sinal. VENDA positivo, devolução/anulação negativo. */
export const SQL_QUANTIDADE_ASSINADA = Prisma.sql`
  CASE "tipoDocumentoClass"
    WHEN 'VENDA'              THEN  ABS(COALESCE("quantidade", 0))
    WHEN 'DEVOLUCAO_ANULACAO' THEN -ABS(COALESCE("quantidade", 0))
    ELSE 0
  END`;

/** Valor bruto com sinal: PVP unitário × quantidade, ao preço da venda. */
export const SQL_VALOR_BRUTO_ASSINADO = Prisma.sql`
  CASE "tipoDocumentoClass"
    WHEN 'VENDA'              THEN  ABS(COALESCE("pvpUnitario", 0) * COALESCE("quantidade", 0))
    WHEN 'DEVOLUCAO_ANULACAO' THEN -ABS(COALESCE("pvpUnitario", 0) * COALESCE("quantidade", 0))
    ELSE 0
  END`;

/** As linhas que contam. Idêntico ao WHERE da agregação mensal. */
export const SQL_LINHAS_ELEGIVEIS = Prisma.sql`
  "tipoDocumentoClass" IN ('VENDA', 'DEVOLUCAO_ANULACAO')
  AND "produtoId" IS NOT NULL
  AND "isNonStockService" = false`;

export type MonthRange = {
  ano: number;
  mes: number;
  fromInclusive: Date;
  toExclusive: Date;
};

export type PreflightStats = {
  rawLines: number;
  produtosDistinct: number;
  atendimentosDistinct: number;
  farmaciasDistinct: number;
  byClass: Record<string, number>;
  orphans: number;
  nonStockServices: number;
  operationalOrphans: number;
  unknowns: number;
  /**
   * QUAIS os tipos de documento por trás das linhas UNKNOWN, com a
   * contagem de cada um.
   *
   * Sem isto, `unknowns: 12` é um número sem acção associada: o gate
   * aborta o mês, diz que há 12 linhas por caracterizar e não diz de
   * quê — e a única forma de descobrir era abrir a base à mão. Uma
   * linha fica UNKNOWN quando o seu `externalTipoDocumentoId` não está
   * em `TipoDocumentoClassificacao` para este tenant, portanto esta
   * lista é exactamente o que falta classificar.
   */
  unknownTipoDocs: Array<{ externalTipoDocumentoId: number | null; count: number }>;
};

export type AggRow = {
  farmaciaId: string;
  produtoId: string;
  /**
   * "NORMAL" | "CREDITO" | "TRANSFERENCIA".
   *
   * Faz parte do GROUP BY, e é isso que permite ao mapa ligar e desligar
   * as vendas a crédito sem reprocessar o histórico. Somar as três aqui
   * seria irreversível: a partir daí não há filtro que as separe.
   */
  naturezaVenda: string;
  quantidadeLiquida: Prisma.Decimal;
  valorBruto: Prisma.Decimal;
  valorPagoUtente: Prisma.Decimal;
  valorComparticipado: Prisma.Decimal;
  linhasVenda: number;
  atendimentos: number;
};

export type AggregateOutcome = {
  preflight: PreflightStats;
  aggRows: AggRow[];
  totals: {
    quantidadeLiquida: number;
    valorBruto: number;
    valorPagoUtente: number;
    valorComparticipado: number;
    linhasVenda: number;
    atendimentos: number;
  };
  /// Quando `mode === 'write'`: rows escritas (0 em dry-run).
  inserted: number;
  deleted: number;
};

export class AggregateAbortError extends Error {
  constructor(
    public readonly code:
      | "unknowns_present"
      | "operational_orphans_present"
      | "totals_negative",
    public readonly details: Record<string, unknown>,
    message: string
  ) {
    super(message);
    this.name = "AggregateAbortError";
  }
}

export function parseMonth(monthArg: string): MonthRange {
  const m = /^(\d{4})-(\d{2})$/.exec(monthArg);
  if (!m) {
    throw new Error(`month deve ser YYYY-MM (ex: 2024-01). Recebido: ${monthArg}`);
  }
  const ano = parseInt(m[1], 10);
  const mes = parseInt(m[2], 10);
  if (mes < 1 || mes > 12) {
    throw new Error(`mes ${mes} fora do intervalo 1..12`);
  }
  const fromInclusive = new Date(Date.UTC(ano, mes - 1, 1));
  const toExclusive = new Date(Date.UTC(ano, mes, 1));
  return { ano, mes, fromInclusive, toExclusive };
}

/* ---------- Preflight ---------- */

export async function runPreflight(
  prisma: PrismaClient,
  range: MonthRange
): Promise<PreflightStats> {
  const where: Prisma.IngestVendaLinhaRawWhereInput = {
    dataVenda: { gte: range.fromInclusive, lt: range.toExclusive },
  };

  const [
    rawLines,
    classDist,
    orphans,
    nonStockServices,
    operationalOrphans,
    unknowns,
    unknownTipoDocDist,
  ] = await Promise.all([
    prisma.ingestVendaLinhaRaw.count({ where }),
    prisma.ingestVendaLinhaRaw.groupBy({
      by: ["tipoDocumentoClass"],
      where,
      _count: { _all: true },
    }),
    prisma.ingestVendaLinhaRaw.count({ where: { ...where, produtoId: null } }),
    prisma.ingestVendaLinhaRaw.count({
      where: { ...where, produtoId: null, isNonStockService: true },
    }),
    prisma.ingestVendaLinhaRaw.count({
      where: { ...where, produtoId: null, isNonStockService: false },
    }),
    prisma.ingestVendaLinhaRaw.count({
      where: { ...where, tipoDocumentoClass: "UNKNOWN" },
    }),
    // Quais os TipoDoc por classificar. Barato (índice em
    // `tipoDocumento`) e é o que transforma "12 linhas UNKNOWN" numa
    // acção concreta.
    prisma.ingestVendaLinhaRaw.groupBy({
      by: ["tipoDocumento"],
      where: { ...where, tipoDocumentoClass: "UNKNOWN" },
      _count: { _all: true },
    }),
  ]);

  const [produtosG, atendG, farmaciasG] = await Promise.all([
    prisma.ingestVendaLinhaRaw.findMany({
      where: { ...where, produtoId: { not: null } },
      select: { produtoId: true },
      distinct: ["produtoId"],
    }),
    prisma.ingestVendaLinhaRaw.findMany({
      where,
      select: { externalSaleId: true },
      distinct: ["externalSaleId"],
    }),
    prisma.ingestVendaLinhaRaw.findMany({
      where,
      select: { farmaciaId: true },
      distinct: ["farmaciaId"],
    }),
  ]);

  const byClass: Record<string, number> = {};
  for (const r of classDist) byClass[r.tipoDocumentoClass] = r._count._all;

  const unknownTipoDocs = unknownTipoDocDist
    .map((r) => ({ externalTipoDocumentoId: r.tipoDocumento, count: r._count._all }))
    .sort((a, b) => b.count - a.count);

  return {
    unknownTipoDocs,
    rawLines,
    produtosDistinct: produtosG.length,
    atendimentosDistinct: atendG.length,
    farmaciasDistinct: farmaciasG.length,
    byClass,
    orphans,
    nonStockServices,
    operationalOrphans,
    unknowns,
  };
}

/* ---------- Aggregation SQL ---------- */

export async function runAggregation(
  prisma: PrismaClient,
  range: MonthRange
): Promise<AggRow[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      farmaciaId: string;
      produtoId: string;
      naturezaVenda: string;
      quantidadeLiquida: string | number | null;
      valorBruto: string | number | null;
      valorPagoUtente: string | number | null;
      valorComparticipado: string | number | null;
      linhasVenda: bigint | number;
      atendimentos: bigint | number;
    }>
  >`
    SELECT
      "farmaciaId",
      "produtoId"::text AS "produtoId",
      "naturezaVenda",
      SUM(${SQL_QUANTIDADE_ASSINADA}) AS "quantidadeLiquida",
      SUM(${SQL_VALOR_BRUTO_ASSINADO}) AS "valorBruto",
      SUM(
        CASE "tipoDocumentoClass"
          WHEN 'VENDA'              THEN ABS(COALESCE("valorLinha", 0))
          WHEN 'DEVOLUCAO_ANULACAO' THEN -ABS(COALESCE("valorLinha", 0))
          ELSE 0
        END
      ) AS "valorPagoUtente",
      SUM(
        CASE "tipoDocumentoClass"
          WHEN 'VENDA'              THEN ABS(COALESCE("comparticipacao1", 0) + COALESCE("comparticipacao2", 0))
          WHEN 'DEVOLUCAO_ANULACAO' THEN -ABS(COALESCE("comparticipacao1", 0) + COALESCE("comparticipacao2", 0))
          ELSE 0
        END
      ) AS "valorComparticipado",
      COUNT(*)                        AS "linhasVenda",
      COUNT(DISTINCT "externalSaleId") AS "atendimentos"
    FROM "IngestVendaLinhaRaw"
    WHERE ${SQL_LINHAS_ELEGIVEIS}
      AND "dataVenda" >= ${range.fromInclusive}
      AND "dataVenda" <  ${range.toExclusive}
    GROUP BY "farmaciaId", "produtoId", "naturezaVenda"
    ORDER BY "valorBruto" DESC
  `;
  return rows.map((r) => ({
    farmaciaId: r.farmaciaId,
    produtoId: r.produtoId,
    naturezaVenda: r.naturezaVenda,
    quantidadeLiquida: new Prisma.Decimal(r.quantidadeLiquida ?? 0),
    valorBruto: new Prisma.Decimal(r.valorBruto ?? 0),
    valorPagoUtente: new Prisma.Decimal(r.valorPagoUtente ?? 0),
    valorComparticipado: new Prisma.Decimal(r.valorComparticipado ?? 0),
    linhasVenda: Number(r.linhasVenda),
    atendimentos: Number(r.atendimentos),
  }));
}

export function sumTotals(rows: AggRow[]) {
  const acc = {
    quantidadeLiquida: 0,
    valorBruto: 0,
    valorPagoUtente: 0,
    valorComparticipado: 0,
    linhasVenda: 0,
    atendimentos: 0,
  };
  for (const r of rows) {
    acc.quantidadeLiquida += r.quantidadeLiquida.toNumber();
    acc.valorBruto += r.valorBruto.toNumber();
    acc.valorPagoUtente += r.valorPagoUtente.toNumber();
    acc.valorComparticipado += r.valorComparticipado.toNumber();
    acc.linhasVenda += r.linhasVenda;
    acc.atendimentos += r.atendimentos;
  }
  return acc;
}

/* ---------- Write ---------- */

export async function writeAggregation(
  prisma: PrismaClient,
  range: MonthRange,
  rows: AggRow[]
): Promise<{ deleted: number; inserted: number }> {
  if (rows.length === 0) return { deleted: 0, inserted: 0 };
  const farmaciaIds = Array.from(new Set(rows.map((r) => r.farmaciaId)));

  /**
   * ── O DEFEITO QUE ISTO FECHA, MEDIDO EM PRODUÇÃO ──────────────────
   *
   * Em 2026-08-31 02:01 a agregação devolveu HTTP 500 ao agent da
   * Farmácia Segurado:
   *
   *   Unique constraint failed on the fields:
   *     (farmaciaId, produtoId, ano, mes, naturezaVenda)
   *
   * Este endpoint agrega o TENANT INTEIRO, e cada agent on-prem
   * chama-o no fim do seu pipeline. Com duas farmácias há dois PCs,
   * ambos agendados para as 03:00, e as duas chamadas sobrepuseram-se:
   *
   *   02:01:24.125 → 02:01:28.199   OK
   *   02:01:24.675 → 02:01:31.175   ERROR   (começou 550 ms depois)
   *
   * Sob READ COMMITTED as duas transacções apagam as mesmas linhas e a
   * seguir tentam inserir as mesmas chaves; a segunda bate no índice
   * único. O agent que recebeu o 500 abortou a execução inteira, e os
   * dias seguintes — que ainda não tinham sido enviados — ficaram por
   * carregar. Dois dias de vendas em falta por causa de 550 ms.
   *
   * ── PORQUÊ ESTA FORMA, E NÃO OUTRA ────────────────────────────────
   *
   * É o mesmo padrão que `aggregate-compras` e `aggregate-devolucoes`
   * já usavam: `withRetry` por fora, `pg_try_advisory_xact_lock` como
   * primeira instrução da transacção. Esta era a única das três
   * agregações sem lock, e era a única que falhava — a correcção é pôr
   * as três iguais, não inventar uma quarta maneira.
   *
   * O lock é `xact`: solta-se sozinho no COMMIT ou no ROLLBACK, sem
   * `finally` que possa ser saltado. `try_` e não a versão bloqueante:
   * quem não o consegue atira `acquire_lock`, que o `isRetryable` do
   * `withRetry` reconhece — espera com backoff e repete, em vez de
   * ficar pendurado a segurar uma ligação do pool.
   *
   * ── O ÂMBITO DA CHAVE ─────────────────────────────────────────────
   *
   * Ano e mês, e mais nada. NÃO leva farmácia, ao contrário dos
   * irmãos: aqui o DELETE abrange todas as farmácias que aparecem em
   * `rows`, e duas corridas do mesmo mês colidem mesmo quando foram
   * disparadas por PCs de farmácias diferentes — foi exactamente o que
   * aconteceu. Uma chave por farmácia não teria evitado nada.
   *
   * Não leva tenant porque não precisa: cada tenant tem a sua base de
   * dados e os advisory locks do Postgres são por base. Meses
   * diferentes continuam a poder correr em paralelo.
   */
  const chaveLock = `aggregate-vendamensal:${range.ano}-${range.mes}`;

  return withRetry(() =>
    prisma.$transaction(async (tx) => {
      const lock = await tx.$queryRaw<Array<{ ok: boolean }>>(
        Prisma.sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${chaveLock}, 0)) AS ok`,
      );
      if (!lock[0]?.ok) throw new Error("acquire_lock failed (retry)");

      const del = await tx.vendaMensal.deleteMany({
        where: {
          ano: range.ano,
          mes: range.mes,
          farmaciaId: { in: farmaciaIds },
          origemAgregacao: ORIGEM_AGREGACAO,
        },
      });
      const data = rows.map((r) => ({
        farmaciaId: r.farmaciaId,
        produtoId: r.produtoId,
        ano: range.ano,
        mes: range.mes,
        naturezaVenda: r.naturezaVenda,
        quantidade: r.quantidadeLiquida,
        valorTotal: r.valorBruto,
        mesCompleto: true,
        origemBootstrap: false,
        quantidadeLiquida: r.quantidadeLiquida,
        valorBruto: r.valorBruto,
        valorPagoUtente: r.valorPagoUtente,
        valorComparticipado: r.valorComparticipado,
        linhasVenda: r.linhasVenda,
        atendimentos: r.atendimentos,
        origemAgregacao: ORIGEM_AGREGACAO,
      }));
      // SEM `skipDuplicates`: uma chave repetida aqui é um defeito de
      // cálculo, não ruído a engolir. O que o lock elimina é a colisão
      // ENTRE corridas; uma colisão DENTRO de uma corrida significa que
      // o GROUP BY da `runAggregation` devolveu a mesma chave duas
      // vezes, e isso tem de rebentar para ser visto.
      const ins = await tx.vendaMensal.createMany({ data });
      return { deleted: del.count, inserted: ins.count };
    }, {
      // DELETE scoped + createMany de milhares de rows numa transação
      // interactiva excede o default de 5s sobre Neon (ex: ~4.4k rows/mês
      // do grupo-silveira → ~9.5s). Elevar o timeout (e o maxWait de
      // aquisição) evita P2028 sem partir a atomicidade DELETE+INSERT.
      maxWait: 15_000,
      timeout: 120_000,
    }),
  );
}

/* ---------- Top-level API ---------- */

export type AggregateOptions = {
  range: MonthRange;
  /** Quando true, ignora `operationalOrphans` em vez de abortar. */
  allowOrphans?: boolean;
  /** Quando true, ignora a safety check de valorBruto negativo. */
  allowNegativeTotals?: boolean;
  /**
   * Quando true, ignora o gate de `unknowns` em vez de abortar. As linhas
   * UNKNOWN NUNCA entram na agregação (a query soma só VENDA/DEVOLUCAO e
   * filtra `tipoDocumentoClass IN (...)`), por isso o gate é apenas uma
   * salvaguarda que força caracterização. Bypass explícito + auditado:
   * usar quando há um TipoDoc residual por caracterizar (ex: 27) que se
   * quer deixar de fora sem bloquear os meses inteiros. Re-agregar após
   * classificar é idempotente.
   */
  allowUnknowns?: boolean;
  /** Quando true, escreve em VendaMensal. False = preview-only. */
  write: boolean;
};

/**
 * Pipeline completo. Em modo `write=true` é atómico: faz preflight,
 * agrega, valida abort criteria, e escreve em transaction. Em
 * `write=false` (dry-run), faz tudo excepto a escrita.
 */
export async function aggregateMonth(
  prisma: PrismaClient,
  opts: AggregateOptions
): Promise<AggregateOutcome> {
  const {
    range,
    write,
    allowOrphans = false,
    allowNegativeTotals = false,
    allowUnknowns = false,
  } = opts;

  const preflight = await runPreflight(prisma, range);

  if (preflight.unknowns > 0 && !allowUnknowns) {
    // A mensagem inclui QUAIS os TipoDoc por classificar. Sem isso, o
    // operador sabe que há linhas por caracterizar e não sabe de quê —
    // e a única saída era abrir a base à mão ou usar allowUnknowns, que
    // mascara o problema em vez de o resolver.
    const quais = preflight.unknownTipoDocs
      .map((t) => `tipoDocumento=${t.externalTipoDocumentoId ?? "NULL"} (${t.count})`)
      .join(", ");
    throw new AggregateAbortError(
      "unknowns_present",
      { unknowns: preflight.unknowns, unknownTipoDocs: preflight.unknownTipoDocs },
      `${preflight.unknowns} linhas com tipoDocumentoClass='UNKNOWN' em ` +
        `${range.ano}-${String(range.mes).padStart(2, "0")}. ` +
        `Por classificar: ${quais || "(sem tipoDocumento)"}. ` +
        `Classifica em TipoDocumentoClassificacao e re-agrega (idempotente), ` +
        `ou usa allowUnknowns para as deixar de fora conscientemente.`
    );
  }
  if (preflight.operationalOrphans > 0 && !allowOrphans) {
    throw new AggregateAbortError(
      "operational_orphans_present",
      { operationalOrphans: preflight.operationalOrphans },
      `${preflight.operationalOrphans} operational orphans (produtoId IS NULL E isNonStockService=false). Investiga ou usa allowOrphans=true.`
    );
  }

  const aggRows = await runAggregation(prisma, range);
  const totals = sumTotals(aggRows);

  // Safety: aggregate totais NEGATIVOS são quase sempre data quality.
  // Numa farmácia real é virtualmente impossível um mês inteiro ter
  // mais devoluções que vendas. Aborta a não ser que o caller force.
  if (totals.valorBruto < 0 && !allowNegativeTotals) {
    throw new AggregateAbortError(
      "totals_negative",
      { valorBruto: totals.valorBruto, linhas: totals.linhasVenda },
      `Total valorBruto agregado é negativo (${totals.valorBruto.toFixed(2)} EUR) — provavelmente data quality issue. Usa allowNegativeTotals=true para forçar.`
    );
  }

  if (!write) {
    return { preflight, aggRows, totals, inserted: 0, deleted: 0 };
  }

  const r = await writeAggregation(prisma, range, aggRows);
  return { preflight, aggRows, totals, inserted: r.inserted, deleted: r.deleted };
}
