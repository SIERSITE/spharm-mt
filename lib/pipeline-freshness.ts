/**
 * lib/pipeline-freshness.ts
 *
 * Read-only: para cada pipeline de movimentos (vendas, compras, devoluções,
 * ajustes, inventário) devolve uma linha de cobertura — quando foi a última
 * data persistida em cada etapa (staging vs final) e quantas rows existem.
 *
 * Usado por:
 *   · ficha do artigo (cartão "Cobertura por pipeline")
 *   · futuro /admin/pipeline-health (per-tenant × per-farmácia)
 *
 * NÃO toca em dashboard / ingest / export-orders. Só SELECTs.
 */
import { Prisma, type PrismaClient } from "@/generated/prisma/client";

/**
 * Estado operacional de uma pipeline:
 *   - `ok`              : final acompanha staging (ou pipeline sem staging mas com dados recentes)
 *   - `stale`           : staging tem dados posteriores ao final — agregação por correr
 *   - `empty`           : pipeline existe (código + endpoint) mas sem dados ainda
 *   - `not-implemented` : sem agent command, sem staging, sem dados
 */
export type PipelineState = "ok" | "stale" | "empty" | "not-implemented";

export type PipelineRow = {
  key: "vendas" | "compras" | "devolucoes" | "ajustes" | "inventario" | "movimentos";
  label: string;
  state: PipelineState;
  /** Linhas em tabelas final (Compra, Devolucao, AjusteStock, LinhaInventario) ou agregada (VendaMensal). */
  finalRows: number;
  /** Linhas em staging (IngestVendaLinhaRaw, StagingCompra/Devolucao). 0 se sem staging. */
  stagingRows: number;
  /** Última `data` em tabela final (ou agregada). */
  finalMaxData: Date | null;
  /** Última `data` em staging (operação no ERP). */
  stagingMaxData: Date | null;
  /** Dias entre max(staging) e max(final). >0 = stale. */
  staleDays: number | null;
  /** Texto operacional curto para a UI ("até 16/05/2026", "sem dados", etc.). */
  hint: string;
};

/** dia(a) - dia(b), arredondado a baixo. null se faltar um dos lados. */
function diffDays(a: Date | null, b: Date | null): number | null {
  if (!a || !b) return null;
  return Math.floor((a.getTime() - b.getTime()) / 86_400_000);
}

function fmtDay(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : "—";
}

export async function getPipelineFreshness(prisma: PrismaClient): Promise<PipelineRow[]> {
  // Uma única round-trip-ish: queries em paralelo, depois compõe.
  const [vendasRaw, vendaMensal, compraFinal, compraStg, devFinal, devStg, ajustes, linhasInv, movs, farmaciasCanonical] = await Promise.all([
    prisma.$queryRaw<Array<{ n: bigint; m: Date | null }>>(
      Prisma.sql`SELECT COUNT(*)::bigint n, MAX("dataVenda") m FROM "IngestVendaLinhaRaw"`,
    ),
    prisma.$queryRaw<Array<{ n: bigint; ano: number | null; mes: number | null }>>(
      Prisma.sql`SELECT COUNT(*)::bigint n, MAX(ano) ano, MAX(mes) FILTER (WHERE ano = (SELECT MAX(ano) FROM "VendaMensal")) mes FROM "VendaMensal"`,
    ),
    prisma.$queryRaw<Array<{ n: bigint; m: Date | null }>>(
      Prisma.sql`SELECT COUNT(*)::bigint n, MAX(data) m FROM "Compra"`,
    ),
    prisma.$queryRaw<Array<{ n: bigint; m: Date | null }>>(
      Prisma.sql`SELECT COUNT(*)::bigint n, MAX("dataRecepcao") m FROM "StagingCompraRawLine"`,
    ),
    prisma.$queryRaw<Array<{ n: bigint; m: Date | null }>>(
      Prisma.sql`SELECT COUNT(*)::bigint n, MAX(data) m FROM "Devolucao"`,
    ),
    prisma.$queryRaw<Array<{ n: bigint; m: Date | null }>>(
      Prisma.sql`SELECT COUNT(*)::bigint n, MAX("dataDevolucao") m FROM "StagingDevolucaoFornecedorRawLine"`,
    ),
    prisma.$queryRaw<Array<{ n: bigint; m: Date | null }>>(
      Prisma.sql`SELECT COUNT(*)::bigint n, MAX(data) m FROM "AjusteStock"`,
    ),
    prisma.$queryRaw<Array<{ n: bigint; m: Date | null }>>(
      Prisma.sql`SELECT COUNT(*)::bigint n, MAX(i."dataInventario") m FROM "LinhaInventario" l JOIN "Inventario" i ON i.id = l."inventarioId"`,
    ),
    // Block D3 — MovimentoArtigo (canónico StocksMov). NULL/0 quando
    // nada foi ingerido ainda (pré-rev33 ou tenant a aguardar bootstrap).
    prisma.$queryRaw<Array<{ n: bigint; m: Date | null; desc: bigint }>>(
      Prisma.sql`SELECT COUNT(*)::bigint n, MAX("dataMovimento") m, COUNT(*) FILTER (WHERE "tipo" = 'DESCONHECIDO')::bigint desc FROM "MovimentoArtigo"`,
    ),
    // Contagem de farmácias com a feature flag activa (drives state).
    prisma.$queryRaw<Array<{ active: bigint; total: bigint }>>(
      Prisma.sql`SELECT
        COUNT(*) FILTER (WHERE "useMovimentosCanonical" = true)::bigint AS active,
        COUNT(*)::bigint AS total
      FROM "Farmacia" WHERE "estado" = 'ATIVO' AND "nome" <> 'Farmácia Teste'`,
    ),
  ]);

  const vendasRawN = Number(vendasRaw[0].n);
  const vendasRawMax = vendasRaw[0].m;
  const vmN = Number(vendaMensal[0].n);
  const vmYM = vendaMensal[0].ano && vendaMensal[0].mes
    ? `${vendaMensal[0].ano}-${String(vendaMensal[0].mes).padStart(2, "0")}`
    : null;

  // Vendas: pipeline composta — staging raw + agregação mensal. Estado é
  // `stale` se o mês corrente do raw é posterior ao último mês agregado.
  const vendasRawYM = vendasRawMax
    ? `${vendasRawMax.getUTCFullYear()}-${String(vendasRawMax.getUTCMonth() + 1).padStart(2, "0")}`
    : null;
  const vendasStale = vendasRawYM && vmYM && vendasRawYM > vmYM;
  const vendasState: PipelineState =
    vendasRawN === 0 ? "empty" : vendasStale ? "stale" : "ok";
  const vendasHint = vendasRawN === 0
    ? "sem dados"
    : vmYM
      ? `raw até ${fmtDay(vendasRawMax)} · mensal até ${vmYM}`
      : `raw até ${fmtDay(vendasRawMax)} · mensal por agregar`;

  // Compras
  const cFN = Number(compraFinal[0].n);
  const cSN = Number(compraStg[0].n);
  const cFMax = compraFinal[0].m;
  const cSMax = compraStg[0].m;
  const cDelta = diffDays(cSMax, cFMax);
  const comprasState: PipelineState =
    cFN === 0 && cSN === 0
      ? "empty"
      : cDelta !== null && cDelta > 0
        ? "stale"
        : "ok";
  const comprasHint =
    cFN === 0 && cSN === 0
      ? "sem dados"
      : cDelta !== null && cDelta > 0
        ? `agregadas até ${fmtDay(cFMax)} · staging até ${fmtDay(cSMax)} (${cDelta} dias por agregar)`
        : `agregadas até ${fmtDay(cFMax)} · staging até ${fmtDay(cSMax)}`;

  // Devoluções
  const dFN = Number(devFinal[0].n);
  const dSN = Number(devStg[0].n);
  const dFMax = devFinal[0].m;
  const dSMax = devStg[0].m;
  const dDelta = diffDays(dSMax, dFMax);
  const devolState: PipelineState =
    dFN === 0 && dSN === 0
      ? "empty"
      : dDelta !== null && dDelta > 0
        ? "stale"
        : "ok";
  const devolHint =
    dFN === 0 && dSN === 0
      ? "pipeline pronta, sem dados ainda (correr devolucoes-fornecedor-upload)"
      : dDelta !== null && dDelta > 0
        ? `agregadas até ${fmtDay(dFMax)} · staging até ${fmtDay(dSMax)} (${dDelta} dias por agregar)`
        : `agregadas até ${fmtDay(dFMax)}`;

  // Ajustes (sem staging implementada)
  const ajN = Number(ajustes[0].n);
  const ajustesState: PipelineState = ajN === 0 ? "not-implemented" : "ok";
  const ajustesHint = ajN === 0 ? "pipeline não implementada (StocksMov pendente)" : `até ${fmtDay(ajustes[0].m)}`;

  // Inventário (idem)
  const invN = Number(linhasInv[0].n);
  const invState: PipelineState = invN === 0 ? "not-implemented" : "ok";
  const invHint = invN === 0 ? "pipeline não implementada (Inventario pendente)" : `até ${fmtDay(linhasInv[0].m)}`;

  // Movimentos (canónico StocksMov — Block D3, rev33)
  const movN = Number(movs[0].n);
  const movMax = movs[0].m;
  const movDesc = Number(movs[0].desc);
  const movDescPct = movN > 0 ? (movDesc / movN) * 100 : 0;
  const flagActive = Number(farmaciasCanonical[0].active);
  const flagTotal = Number(farmaciasCanonical[0].total);
  let movState: PipelineState;
  let movHint: string;
  if (movN === 0) {
    movState = "not-implemented";
    movHint = "pipeline canónica pronta, sem dados (correr stocksmov-upload)";
  } else if (flagActive === 0) {
    movState = "empty"; // dados existem mas nenhuma farmácia tem a flag activa
    movHint = `até ${fmtDay(movMax)} · ${movN.toLocaleString()} rows · flag inactiva (${flagTotal} farmácias)`;
  } else {
    movState = movDescPct >= 1 ? "stale" : "ok";
    movHint =
      `até ${fmtDay(movMax)} · ${movN.toLocaleString()} rows · ` +
      `flag activa em ${flagActive}/${flagTotal} farmácias · ` +
      `DESC ${movDescPct.toFixed(2)}%`;
  }

  return [
    {
      key: "vendas",
      label: "Vendas",
      state: vendasState,
      finalRows: vmN,
      stagingRows: vendasRawN,
      finalMaxData: null, // VendaMensal é por (ano,mes), não DateTime
      stagingMaxData: vendasRawMax,
      staleDays: vendasStale ? 1 : 0,
      hint: vendasHint,
    },
    {
      key: "compras",
      label: "Compras",
      state: comprasState,
      finalRows: cFN,
      stagingRows: cSN,
      finalMaxData: cFMax,
      stagingMaxData: cSMax,
      staleDays: cDelta,
      hint: comprasHint,
    },
    {
      key: "devolucoes",
      label: "Devoluções",
      state: devolState,
      finalRows: dFN,
      stagingRows: dSN,
      finalMaxData: dFMax,
      stagingMaxData: dSMax,
      staleDays: dDelta,
      hint: devolHint,
    },
    {
      key: "ajustes",
      label: "Ajustes / Quebras",
      state: ajustesState,
      finalRows: ajN,
      stagingRows: 0,
      finalMaxData: ajustes[0].m,
      stagingMaxData: null,
      staleDays: null,
      hint: ajustesHint,
    },
    {
      key: "inventario",
      label: "Inventário",
      state: invState,
      finalRows: invN,
      stagingRows: 0,
      finalMaxData: linhasInv[0].m,
      stagingMaxData: null,
      staleDays: null,
      hint: invHint,
    },
    {
      key: "movimentos",
      label: "Movimentos (canónico)",
      state: movState,
      finalRows: movN,
      stagingRows: 0,
      finalMaxData: movMax,
      stagingMaxData: null,
      staleDays: null,
      hint: movHint,
    },
  ];
}
