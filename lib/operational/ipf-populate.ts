/**
 * lib/operational/ipf-populate.ts
 *
 * Orquestração callable do populate de `IndicadoresProdutoFarmacia`,
 * extraída de `scripts/populate-indicadores-produto-farmacia.ts` para
 * permitir invocação a partir de:
 *   · CLI (script wrapper continua a parsear argv e escrever stdout)
 *   · Vercel Cron / route handler (`/api/jobs/refresh-ipf`)
 *   · Wrapper scheduler-ready (`scripts/jobs/refresh-ipf.ts`)
 *
 * Política idêntica ao script original — apenas extraída a lógica:
 *   · Lê `Farmacia` ACTIVO, `ProdutoFarmacia` viva, Venda/VendaMensal/Compra.
 *   · Calcula via `computeIpfRow` + `assignAbcInPlace`.
 *   · Upsert idempotente via raw SQL `INSERT ... ON CONFLICT DO UPDATE`
 *     em batches de 500.
 *   · `dataCalculo = NOW()` em cada upsert.
 *   · `dryRun=true` salta o write e devolve plano + summary.
 *
 * Sem `import "server-only"` — usado por scripts CLI e por route
 * handlers do runtime web.
 *
 * NÃO desconecta o prisma; é responsabilidade do caller (scripts
 * fazem `.$disconnect()` no fim; route handlers usam cliente cacheado
 * e não desconectam).
 */

import { nanoid } from "nanoid";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import {
  assignAbcInPlace,
  computeIpfRow,
  type IpfOutput,
} from "@/lib/operational/ipf-calculator";

export const UPSERT_BATCH_SIZE = 500;

export type IpfPopulateOptions = {
  /** Quando `true`, calcula tudo mas não escreve. Default `false`. */
  dryRun?: boolean;
  /** Filtrar a uma farmácia específica (id). Default `null` (todas). */
  farmaciaId?: string | null;
  /** Threshold (dias) para classificar stock parado. Default 90. */
  paradoThresholdDays?: number;
};

export type IpfPopulateResult = {
  dryRun: boolean;
  farmaciasCount: number;
  pfRowsCount: number;
  vendaDiariaDisponivel: boolean;
  rowsCalculated: number;
  rowsUpserted: number;
  rowsFailed: number;
  batches: number;
  durationMs: number;
  summary: IpfPopulateSummary;
};

export type IpfPopulateSummary = {
  populaveis: Record<string, number>;
  classificacaoABC: { A: number; B: number; C: number; NAO_CLASSIFICADO: number };
  classificacaoRotacao: { NORMAL: number; ATENCAO: number; SEM_ROTACAO: number };
  valorStockParadoTotalEur: number;
  valorStockParadoCount: number;
};

export type IpfLogger = (msg: string) => void;
const NOOP: IpfLogger = () => {};

function toF(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Orquestração completa do populate. Mesmas queries que
 * `scripts/populate-indicadores-produto-farmacia.ts` — esta função é a
 * fonte canónica; o script reduzido a thin-wrap.
 */
export async function runIpfPopulate(
  prisma: PrismaClient,
  options: IpfPopulateOptions = {},
  log: IpfLogger = NOOP,
): Promise<IpfPopulateResult> {
  const dryRun = options.dryRun ?? false;
  const farmaciaId = options.farmaciaId ?? null;
  const paradoThresholdDays = options.paradoThresholdDays ?? 90;
  const t0 = Date.now();

  // ── 1. Farmácias activas ─────────────────────────────────────────────
  const farmacias = await prisma.farmacia.findMany({
    where: {
      estado: "ATIVO",
      nome: { not: "Farmácia Teste" },
      ...(farmaciaId ? { id: farmaciaId } : {}),
    },
    select: { id: true, nome: true },
    orderBy: { nome: "asc" },
  });
  const farmaciaIds = farmacias.map((f) => f.id);
  log(`[1/7] Farmácias activas: ${farmaciaIds.length} (${farmacias.map((f) => f.nome).join(", ")})`);
  if (farmaciaIds.length === 0) {
    return {
      dryRun,
      farmaciasCount: 0,
      pfRowsCount: 0,
      vendaDiariaDisponivel: false,
      rowsCalculated: 0,
      rowsUpserted: 0,
      rowsFailed: 0,
      batches: 0,
      durationMs: Date.now() - t0,
      summary: emptySummary(),
    };
  }

  // ── 2. ProdutoFarmacia ──────────────────────────────────────────────
  type PfRow = {
    produtoId: string;
    farmaciaId: string;
    stockAtual: number;
    puc: number | null;
    pmc: number | null;
    dataUltimaVenda: Date | null;
  };
  const pfRows = await prisma.$queryRaw<PfRow[]>(Prisma.sql`
    SELECT
      pf."produtoId",
      pf."farmaciaId",
      pf."stockAtual"::float AS "stockAtual",
      pf.puc::float          AS puc,
      pf.pmc::float          AS pmc,
      pf."dataUltimaVenda"
    FROM "ProdutoFarmacia" pf
    WHERE pf."flagRetirado" = false
      AND pf."farmaciaId" = ANY(${farmaciaIds})
  `);
  log(`[2/7] ProdutoFarmacia (vivos): ${pfRows.length}`);

  // ── 3. Venda diária 30d / 90d ───────────────────────────────────────
  type SalesD = { produtoId: string; farmaciaId: string; qty: number; valor: number };
  const sales30dVenda = await prisma.$queryRaw<SalesD[]>(Prisma.sql`
    SELECT v."produtoId", v."farmaciaId",
           SUM(v.quantidade)::float AS qty,
           SUM(v."valorTotal")::float AS valor
    FROM "Venda" v
    WHERE v.data >= NOW() - INTERVAL '30 days'
      AND v."farmaciaId" = ANY(${farmaciaIds})
    GROUP BY v."produtoId", v."farmaciaId"
  `);
  const sales90dVenda = await prisma.$queryRaw<SalesD[]>(Prisma.sql`
    SELECT v."produtoId", v."farmaciaId",
           SUM(v.quantidade)::float AS qty,
           SUM(v."valorTotal")::float AS valor
    FROM "Venda" v
    WHERE v.data >= NOW() - INTERVAL '90 days'
      AND v."farmaciaId" = ANY(${farmaciaIds})
    GROUP BY v."produtoId", v."farmaciaId"
  `);
  const vendaDiariaDisponivel = sales90dVenda.length > 0;
  log(`[3/7] Venda diária: 30d=${sales30dVenda.length}  90d=${sales90dVenda.length}  disponível=${vendaDiariaDisponivel}`);

  // ── 4. VendaMensal 3m / 12m ─────────────────────────────────────────
  const now = new Date();
  const periodEnd = now.getFullYear() * 12 + now.getMonth() + 1;
  const period3m = periodEnd - 3;
  const period12m = periodEnd - 12;

  type SalesM = { produtoId: string; farmaciaId: string; qty: number; valor: number };
  const sales3m = await prisma.$queryRaw<SalesM[]>(Prisma.sql`
    SELECT vm."produtoId", vm."farmaciaId",
           SUM(vm.quantidade)::float AS qty,
           SUM(vm."valorTotal")::float AS valor
    FROM "VendaMensal" vm
    WHERE (vm.ano * 12 + vm.mes) >= ${period3m}
      AND (vm.ano * 12 + vm.mes) < ${periodEnd}
      AND vm."farmaciaId" = ANY(${farmaciaIds})
    GROUP BY vm."produtoId", vm."farmaciaId"
  `);
  const sales12m = await prisma.$queryRaw<SalesM[]>(Prisma.sql`
    SELECT vm."produtoId", vm."farmaciaId",
           SUM(vm.quantidade)::float AS qty,
           SUM(vm."valorTotal")::float AS valor
    FROM "VendaMensal" vm
    WHERE (vm.ano * 12 + vm.mes) >= ${period12m}
      AND (vm.ano * 12 + vm.mes) < ${periodEnd}
      AND vm."farmaciaId" = ANY(${farmaciaIds})
    GROUP BY vm."produtoId", vm."farmaciaId"
  `);
  log(`[4/7] VendaMensal: 3m=${sales3m.length}  12m=${sales12m.length}`);

  // ── 5. Compra (última por par) ──────────────────────────────────────
  type LastCompra = { produtoId: string; farmaciaId: string; precoUnitario: number | null; fornecedorId: string | null };
  const lastCompra = await prisma.$queryRaw<LastCompra[]>(Prisma.sql`
    WITH ranked AS (
      SELECT c."produtoId", c."farmaciaId",
             c."precoUnitario"::float AS "precoUnitario",
             c."fornecedorId",
             ROW_NUMBER() OVER (PARTITION BY c."produtoId", c."farmaciaId" ORDER BY c.data DESC) AS rn
      FROM "Compra" c
      WHERE c."farmaciaId" = ANY(${farmaciaIds})
        -- Só compras cujo documento no ERP reconcilia. Em 804 de 13 642
        -- recepções da Silveirense faltam linhas que já não existem em
        -- lado nenhum: o preço unitário dessas é a soma do que restou a
        -- dividir pela quantidade do que restou, e não o custo real.
        --
        -- NULL fica de fora de propósito: são linhas agregadas antes
        -- desta classificação, cujo estado é desconhecido. "Desconhecido"
        -- nao e "fiavel", e o ultimoPrecoCompra ja e nullable: nao ter
        -- valor é melhor do que ter um errado.
        AND c."custoFiavel" IS TRUE
    )
    SELECT "produtoId", "farmaciaId", "precoUnitario", "fornecedorId"
    FROM ranked WHERE rn = 1
  `);
  log(`[5/7] Compra (última por par, só custoFiavel): ${lastCompra.length}`);

  // ── 6. Construir indicators via calculator ──────────────────────────
  const k = (p: string, f: string) => `${p}:${f}`;
  const idx30 = new Map(sales30dVenda.map((r) => [k(r.produtoId, r.farmaciaId), r]));
  const idx90 = new Map(sales90dVenda.map((r) => [k(r.produtoId, r.farmaciaId), r]));
  const idx3m = new Map(sales3m.map((r) => [k(r.produtoId, r.farmaciaId), r]));
  const idx12m = new Map(sales12m.map((r) => [k(r.produtoId, r.farmaciaId), r]));
  const idxCompra = new Map(lastCompra.map((r) => [k(r.produtoId, r.farmaciaId), r]));

  log(`[6/7] A calcular ${pfRows.length} indicadores...`);
  const rows: IpfOutput[] = [];
  for (const pf of pfRows) {
    const key = k(pf.produtoId, pf.farmaciaId);
    const s30 = idx30.get(key);
    const s90 = idx90.get(key);
    const s3 = idx3m.get(key);
    const s12 = idx12m.get(key);
    const compra = idxCompra.get(key);
    const custo = pf.puc ?? pf.pmc ?? 0;

    rows.push(
      computeIpfRow(
        {
          produtoId: pf.produtoId,
          farmaciaId: pf.farmaciaId,
          stockAtual: toF(pf.stockAtual),
          custoUnitario: custo,
          vendaQty30dDiaria: s30 ? toF(s30.qty) : 0,
          vendaQty90dDiaria: s90 ? toF(s90.qty) : 0,
          vendaValor90dDiaria: s90 ? toF(s90.valor) : 0,
          vendaMensalQty3m: s3 ? toF(s3.qty) : 0,
          vendaMensalQty12m: s12 ? toF(s12.qty) : 0,
          vendaMensalValor3m: s3 ? toF(s3.valor) : 0,
          dataUltimaVenda: pf.dataUltimaVenda,
          ultimoPrecoCompra: compra?.precoUnitario ?? null,
          ultimoFornecedorId: compra?.fornecedorId ?? null,
        },
        {
          vendaDiariaDisponivel,
          paradoThresholdDays,
        },
      ),
    );
  }
  assignAbcInPlace(rows);

  const summary = summarize(rows);

  // ── 7. Upsert em batches via raw SQL ────────────────────────────────
  if (dryRun) {
    log(`[7/7] DRY-RUN — sem writes. ${rows.length} linhas a upsertar em ${Math.ceil(rows.length / UPSERT_BATCH_SIZE)} batches.`);
    return {
      dryRun: true,
      farmaciasCount: farmacias.length,
      pfRowsCount: pfRows.length,
      vendaDiariaDisponivel,
      rowsCalculated: rows.length,
      rowsUpserted: 0,
      rowsFailed: 0,
      batches: Math.ceil(rows.length / UPSERT_BATCH_SIZE),
      durationMs: Date.now() - t0,
      summary,
    };
  }

  log(`[7/7] A upsertar ${rows.length} linhas em batches de ${UPSERT_BATCH_SIZE}...`);
  let upserted = 0;
  let failed = 0;
  let batches = 0;
  const tWrite = Date.now();

  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const chunk = rows.slice(i, i + UPSERT_BATCH_SIZE);
    batches++;
    try {
      await upsertBatch(prisma, chunk);
      upserted += chunk.length;
    } catch (err) {
      failed += chunk.length;
      log(
        `    [erro batch i=${i}] ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
      );
    }
  }
  log(`[summary] upserted=${upserted} failed=${failed} elapsed=${((Date.now() - tWrite) / 1000).toFixed(1)}s`);

  return {
    dryRun: false,
    farmaciasCount: farmacias.length,
    pfRowsCount: pfRows.length,
    vendaDiariaDisponivel,
    rowsCalculated: rows.length,
    rowsUpserted: upserted,
    rowsFailed: failed,
    batches,
    durationMs: Date.now() - t0,
    summary,
  };
}

/**
 * Upsert idempotente via raw SQL: bulk INSERT ... ON CONFLICT
 * (produtoId, farmaciaId) DO UPDATE. cuids gerados client-side via
 * nanoid; só usados quando a row é nova.
 */
async function upsertBatch(prisma: PrismaClient, rows: IpfOutput[]): Promise<void> {
  if (rows.length === 0) return;
  const valuesSql = rows.map((r) => {
    const id = "ipf_" + nanoid(14);
    return Prisma.sql`(
      ${id},
      ${r.produtoId},
      ${r.farmaciaId},
      ${r.mediaVendasDiarias30d},
      ${r.mediaVendasDiarias90d},
      ${r.mediaVendasMensais3m},
      ${r.mediaVendasMensais12m},
      ${r.diasStockRestante},
      ${r.diasSemVenda},
      ${r.ultimoPrecoCompra},
      ${r.ultimoFornecedorId},
      ${r.classificacaoABC}::"ClassificacaoABC",
      ${r.classificacaoRotacao}::"ClassificacaoRotacao",
      ${r.valorStockParado},
      NOW()
    )`;
  });

  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "IndicadoresProdutoFarmacia" (
      "id", "produtoId", "farmaciaId",
      "mediaVendasDiarias30d", "mediaVendasDiarias90d",
      "mediaVendasMensais3m",  "mediaVendasMensais12m",
      "diasStockRestante",     "diasSemVenda",
      "ultimoPrecoCompra",     "ultimoFornecedorId",
      "classificacaoABC",      "classificacaoRotacao",
      "valorStockParado",      "dataCalculo"
    )
    VALUES ${Prisma.join(valuesSql)}
    ON CONFLICT ("produtoId", "farmaciaId") DO UPDATE SET
      "mediaVendasDiarias30d" = EXCLUDED."mediaVendasDiarias30d",
      "mediaVendasDiarias90d" = EXCLUDED."mediaVendasDiarias90d",
      "mediaVendasMensais3m"  = EXCLUDED."mediaVendasMensais3m",
      "mediaVendasMensais12m" = EXCLUDED."mediaVendasMensais12m",
      "diasStockRestante"     = EXCLUDED."diasStockRestante",
      "diasSemVenda"          = EXCLUDED."diasSemVenda",
      "ultimoPrecoCompra"     = EXCLUDED."ultimoPrecoCompra",
      "ultimoFornecedorId"    = EXCLUDED."ultimoFornecedorId",
      "classificacaoABC"      = EXCLUDED."classificacaoABC",
      "classificacaoRotacao"  = EXCLUDED."classificacaoRotacao",
      "valorStockParado"      = EXCLUDED."valorStockParado",
      "dataCalculo"           = NOW()
  `);
}

export function summarize(rows: IpfOutput[]): IpfPopulateSummary {
  const populaveis = {
    mediaVendasDiarias30d: rows.filter((r) => r.mediaVendasDiarias30d !== null).length,
    mediaVendasDiarias90d: rows.filter((r) => r.mediaVendasDiarias90d !== null).length,
    mediaVendasMensais3m: rows.filter((r) => r.mediaVendasMensais3m !== null).length,
    mediaVendasMensais12m: rows.filter((r) => r.mediaVendasMensais12m !== null).length,
    diasStockRestante: rows.filter((r) => r.diasStockRestante !== null).length,
    diasSemVenda: rows.filter((r) => r.diasSemVenda !== null).length,
    ultimoPrecoCompra: rows.filter((r) => r.ultimoPrecoCompra !== null).length,
    ultimoFornecedorId: rows.filter((r) => r.ultimoFornecedorId !== null).length,
    valorStockParado: rows.filter((r) => (r.valorStockParado ?? 0) > 0).length,
  };
  const abc = { A: 0, B: 0, C: 0, NAO_CLASSIFICADO: 0 };
  for (const r of rows) abc[r.classificacaoABC]++;
  const rot = { NORMAL: 0, ATENCAO: 0, SEM_ROTACAO: 0 };
  for (const r of rows) rot[r.classificacaoRotacao]++;
  const totalParado = rows.reduce((s, r) => s + (r.valorStockParado ?? 0), 0);

  return {
    populaveis,
    classificacaoABC: abc,
    classificacaoRotacao: rot,
    valorStockParadoTotalEur: Number(totalParado.toFixed(2)),
    valorStockParadoCount: populaveis.valorStockParado,
  };
}

function emptySummary(): IpfPopulateSummary {
  return {
    populaveis: {
      mediaVendasDiarias30d: 0,
      mediaVendasDiarias90d: 0,
      mediaVendasMensais3m: 0,
      mediaVendasMensais12m: 0,
      diasStockRestante: 0,
      diasSemVenda: 0,
      ultimoPrecoCompra: 0,
      ultimoFornecedorId: 0,
      valorStockParado: 0,
    },
    classificacaoABC: { A: 0, B: 0, C: 0, NAO_CLASSIFICADO: 0 },
    classificacaoRotacao: { NORMAL: 0, ATENCAO: 0, SEM_ROTACAO: 0 },
    valorStockParadoTotalEur: 0,
    valorStockParadoCount: 0,
  };
}
