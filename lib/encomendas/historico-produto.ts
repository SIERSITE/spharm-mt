import "server-only";

/**
 * lib/encomendas/historico-produto.ts
 *
 * Histórico de 12 meses (compras/vendas líquidas + stock + média) de
 * UM produto, por farmácia — lazy/on-demand: chamado só quando o
 * utilizador pede o histórico de UMA linha da encomenda, nunca
 * pré-carregado para a proposta inteira. Ver `getHistoricoProdutoAction`
 * em `app/encomendas/actions.ts`.
 *
 * A parte PURA (tipos + agregação em si) vive em
 * `lib/encomendas/historico-produto-tipos.ts` — sem Prisma, sem
 * `server-only`, testável num `tsx` standalone sem BD. Este ficheiro é
 * só o loader (I/O) e re-exporta os tipos para os chamadores não terem
 * de saber que a divisão existe (mesmo padrão de
 * `lib/movimentos-data.ts` / `lib/movimentos-tipos.ts`).
 *
 * ── Fonte e índice ──────────────────────────────────────────────────
 *
 * Agrega `MovimentoArtigo` (ledger canónico rev36, ver
 * `lib/movimentos-data.ts`) por (farmácia, ano, mês). Filtra por
 * `produtoId` + janela de datas, tirando partido do índice já existente
 * `@@index([produtoId, dataMovimento])` — sem nova migration.
 *
 * ── Classificação: o que conta como "compra" e "venda líquida" ───────
 *
 *   · compras  = SUM(|quantidade|) WHERE tipo = 'COMPRA'. Só o pedido —
 *     não desconta DEVOLUCAO_FORNECEDOR (fora do âmbito deste bloco).
 *   · vendas   = SUM(|quantidade| WHERE tipo='VENDA') −
 *                SUM(|quantidade| WHERE tipo='DEVOLUCAO_CLIENTE')
 *     Mesma semântica de `SQL_QUANTIDADE_ASSINADA` em
 *     `lib/aggregate/vendamensal.ts` (VENDA soma, devolução subtrai) e
 *     de `direcaoForTipo` em `lib/movimentos-tipos.ts` (VENDA=SAIDA,
 *     DEVOLUCAO_CLIENTE=ENTRADA — sinais opostos, a venda líquida é a
 *     diferença). VENDA_CREDITO e RESERVA_SUSPENSA ficam de fora: a
 *     primeira é uma nota de crédito (não é saída física de stock ao
 *     cliente final), a segunda ainda não se efectivou.
 *
 * ── Janela ────────────────────────────────────────────────────────────
 *
 * Mesma convenção de `getEncomendasData` (lib/encomendas-data.ts):
 * `periodEndKey = ano*12+mes` do mês CORRENTE, exclusivo — os últimos
 * 12 meses são os 12 meses COMPLETOS anteriores, sem incluir o mês
 * corrente parcial. `avgDaily`/`monthlyVelocity` usam os últimos 3
 * desses 12 meses como proxy de 90 dias — o mesmo proxy que
 * `getEncomendasData` já usa (`recent3` + `WINDOW_90D`), não uma fórmula
 * nova.
 *
 * ── Cobertura do ledger ──────────────────────────────────────────────
 *
 * Nem todas as farmácias têm `MovimentoArtigo` ingerido (ver
 * `Farmacia.useMovimentosCanonical` / notas em `lib/movimentos-data.ts`).
 * Reutiliza `getCoberturaMovimentos` para marcar `temLedger: false`
 * quando não há nenhum movimento ingerido — meses a 0 por AUSÊNCIA de
 * ledger não são o mesmo que meses a 0 por ausência de movimento real,
 * e a UI avisa a diferença.
 */
import { getPrisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { getCoberturaMovimentos } from "@/lib/movimentos-data";
import {
  buildHistoricoLote,
  buildHistoricoSeries,
  keyToAnoMes,
  periodKey,
  type HistoricoMovRowLote,
  type HistoricoStockRowLote,
  type HistoricoProduto12MesesResult,
} from "@/lib/encomendas/historico-produto-tipos";

export type {
  HistoricoFarmaciaSerie,
  HistoricoMesBucket,
  HistoricoMovRow,
  HistoricoMovRowLote,
  HistoricoStockRowLote,
  HistoricoProduto12MesesResult,
} from "@/lib/encomendas/historico-produto-tipos";
export {
  buildHistoricoLote,
  buildHistoricoSeries,
  keyToAnoMes,
  periodKey,
} from "@/lib/encomendas/historico-produto-tipos";

function toF(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export type GetHistoricoProdutoInput = {
  produtoId: string;
  farmaciaIds: string[];
};

/**
 * Carrega o histórico de 12 meses de um produto, por farmácia. Devolve
 * `null` quando o produto não existe ou a lista de farmácias fica vazia
 * (depois de deduplicada) — o caller (server action) já valida acesso
 * por farmácia antes de chegar aqui.
 */
export async function getHistoricoProduto12Meses(
  input: GetHistoricoProdutoInput
): Promise<HistoricoProduto12MesesResult | null> {
  const farmaciaIds = [...new Set(input.farmaciaIds)].filter((id) => id.trim().length > 0);
  if (!input.produtoId || farmaciaIds.length === 0) return null;

  const prisma = await getPrisma();

  const produto = await prisma.produto.findUnique({
    where: { id: input.produtoId },
    select: { id: true, cnp: true, designacao: true },
  });
  if (!produto) return null;

  const now = new Date();
  const periodEndKey = periodKey(now.getFullYear(), now.getMonth() + 1);
  const { ano: startAno, mes: startMes } = keyToAnoMes(periodEndKey - 12);
  // Datas concretas para o filtro SQL — aproveitam o índice
  // (produtoId, dataMovimento) em vez de comparar ano/mes calculado.
  const periodStartDate = new Date(Date.UTC(startAno, startMes - 1, 1));
  const periodEndDate = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));

  const [movRows, farmacias, pfRows, cobertura] = await Promise.all([
    prisma.$queryRaw<Array<{ farmaciaId: string; ano: number; mes: number; compras: number; vendas: number }>>(
      Prisma.sql`
        SELECT
          "farmaciaId",
          EXTRACT(YEAR FROM "dataMovimento")::int  AS ano,
          EXTRACT(MONTH FROM "dataMovimento")::int AS mes,
          SUM(CASE WHEN tipo = 'COMPRA' THEN ABS(quantidade) ELSE 0 END)::float AS compras,
          SUM(
            CASE
              WHEN tipo = 'VENDA'              THEN  ABS(quantidade)
              WHEN tipo = 'DEVOLUCAO_CLIENTE'  THEN -ABS(quantidade)
              ELSE 0
            END
          )::float AS vendas
        FROM "MovimentoArtigo"
        WHERE "produtoId" = ${produto.id}
          AND "farmaciaId" = ANY(${farmaciaIds})
          AND "dataMovimento" >= ${periodStartDate}
          AND "dataMovimento" <  ${periodEndDate}
        GROUP BY "farmaciaId", ano, mes
      `
    ),
    prisma.farmacia.findMany({
      where: { id: { in: farmaciaIds } },
      select: { id: true, nome: true },
    }),
    prisma.produtoFarmacia.findMany({
      where: { produtoId: produto.id, farmaciaId: { in: farmaciaIds } },
      select: { farmaciaId: true, stockAtual: true },
    }),
    getCoberturaMovimentos(farmaciaIds),
  ]);

  const nomeById = new Map(farmacias.map((f) => [f.id, f.nome]));
  const stockById = new Map(
    pfRows.map((r) => [r.farmaciaId, r.stockAtual == null ? null : toF(r.stockAtual)])
  );
  const ledgerById = new Map(cobertura.map((c) => [c.farmaciaId, c.temLedger]));

  const series = buildHistoricoSeries({
    farmaciaIds,
    movRows,
    nomeById,
    stockById,
    ledgerById,
    periodEndKey,
  });

  return {
    produtoId: produto.id,
    cnp: produto.cnp,
    designacao: produto.designacao,
    farmacias: series,
  };
}

// ─── Lote (N produtos de uma vez) ───────────────────────────────────────────

export type GetHistoricoProdutosEmLoteInput = {
  produtoIds: string[];
  farmaciaIds: string[];
};

/**
 * A MESMA coisa que `getHistoricoProduto12Meses`, mas para N produtos de
 * uma vez — um único round-trip (mesmas 4 consultas em paralelo, cada uma
 * já preparada para múltiplos produtos) em vez de um pedido por linha.
 *
 * Existe para a tabela da encomenda mostrar o histórico inline, sempre
 * visível, por baixo de cada produto (`order-create-client.tsx`) — sem
 * isto seria 1 pedido por linha renderizada, o que nunca deve acontecer
 * (ver `getHistoricoProdutosLoteAction` em `app/encomendas/actions.ts`).
 *
 * Reaproveita a MESMA lógica pura (`buildHistoricoSeries`) e a MESMA
 * cobertura de ledger (`getCoberturaMovimentos`) que a versão de um único
 * produto — a única diferença é a query SQL trocar `"produtoId" = $1` por
 * `"produtoId" = ANY($1)` e agrupar também por `"produtoId"`, e as
 * consultas de apoio (farmácias, `ProdutoFarmacia`) passarem a devolver
 * linhas para todos os produtos pedidos, particionadas em memória por
 * produto antes de chamar `buildHistoricoSeries` uma vez por produto.
 *
 * Devolve um `Map` vazio (nunca lança) quando não há produtos/farmácias
 * válidos, ou quando nenhum dos `produtoIds` existe — o caller decide o
 * que mostrar para os produtos ausentes do mapa (a UI mostra "sem
 * histórico" nesse caso, não um erro).
 */
export async function getHistoricoProdutosEmLote(
  input: GetHistoricoProdutosEmLoteInput
): Promise<Map<string, HistoricoProduto12MesesResult>> {
  const resultado = new Map<string, HistoricoProduto12MesesResult>();

  const produtoIds = [...new Set(input.produtoIds)].filter((id) => id.trim().length > 0);
  const farmaciaIds = [...new Set(input.farmaciaIds)].filter((id) => id.trim().length > 0);
  if (produtoIds.length === 0 || farmaciaIds.length === 0) return resultado;

  const prisma = await getPrisma();

  const produtos = await prisma.produto.findMany({
    where: { id: { in: produtoIds } },
    select: { id: true, cnp: true, designacao: true },
  });
  if (produtos.length === 0) return resultado;
  const idsExistentes = produtos.map((p) => p.id);

  const now = new Date();
  const periodEndKey = periodKey(now.getFullYear(), now.getMonth() + 1);
  const { ano: startAno, mes: startMes } = keyToAnoMes(periodEndKey - 12);
  const periodStartDate = new Date(Date.UTC(startAno, startMes - 1, 1));
  const periodEndDate = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));

  const [movRows, farmacias, pfRows, cobertura] = await Promise.all([
    prisma.$queryRaw<
      Array<{ produtoId: string; farmaciaId: string; ano: number; mes: number; compras: number; vendas: number }>
    >(
      Prisma.sql`
        SELECT
          "produtoId",
          "farmaciaId",
          EXTRACT(YEAR FROM "dataMovimento")::int  AS ano,
          EXTRACT(MONTH FROM "dataMovimento")::int AS mes,
          SUM(CASE WHEN tipo = 'COMPRA' THEN ABS(quantidade) ELSE 0 END)::float AS compras,
          SUM(
            CASE
              WHEN tipo = 'VENDA'              THEN  ABS(quantidade)
              WHEN tipo = 'DEVOLUCAO_CLIENTE'  THEN -ABS(quantidade)
              ELSE 0
            END
          )::float AS vendas
        FROM "MovimentoArtigo"
        WHERE "produtoId" = ANY(${idsExistentes})
          AND "farmaciaId" = ANY(${farmaciaIds})
          AND "dataMovimento" >= ${periodStartDate}
          AND "dataMovimento" <  ${periodEndDate}
        GROUP BY "produtoId", "farmaciaId", ano, mes
      `
    ),
    prisma.farmacia.findMany({
      where: { id: { in: farmaciaIds } },
      select: { id: true, nome: true },
    }),
    prisma.produtoFarmacia.findMany({
      where: { produtoId: { in: idsExistentes }, farmaciaId: { in: farmaciaIds } },
      select: { produtoId: true, farmaciaId: true, stockAtual: true },
    }),
    getCoberturaMovimentos(farmaciaIds),
  ]);

  const nomeById = new Map(farmacias.map((f) => [f.id, f.nome]));
  const ledgerById = new Map(cobertura.map((c) => [c.farmaciaId, c.temLedger]));

  const movRowsLote: HistoricoMovRowLote[] = movRows.map((r) => ({
    produtoId: r.produtoId,
    farmaciaId: r.farmaciaId,
    ano: r.ano,
    mes: r.mes,
    compras: toF(r.compras),
    vendas: toF(r.vendas),
  }));
  const stockRowsLote: HistoricoStockRowLote[] = pfRows.map((r) => ({
    produtoId: r.produtoId,
    farmaciaId: r.farmaciaId,
    stockAtual: r.stockAtual == null ? null : toF(r.stockAtual),
  }));

  // A partição por produto + a chamada a `buildHistoricoSeries` uma vez
  // por produto vivem em `buildHistoricoLote` — pura, testável com
  // fixtures sintéticas (ver scripts/tests/test-historico-lote.ts).
  return buildHistoricoLote({
    produtos,
    farmaciaIds,
    movRows: movRowsLote,
    stockRows: stockRowsLote,
    nomeById,
    ledgerById,
    periodEndKey,
  });
}
