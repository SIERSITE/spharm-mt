/**
 * lib/encomendas/historico-produto-tipos.ts
 *
 * Parte PURA do histórico de 12 meses por produto — tipos + a
 * agregação em si, sem Prisma e sem `server-only`.
 *
 * Vive separado de `lib/encomendas/historico-produto.ts` pela mesma
 * razão de `lib/movimentos-tipos.ts` vs `lib/movimentos-data.ts` (ver
 * cabeçalho desse ficheiro): `server-only` e o Prisma importado pelo
 * loader não resolvem fora do bundler do Next.js — nem no browser, nem
 * num script `tsx` standalone (é o que os testes deste bloco usam).
 * Este ficheiro pode ser importado de qualquer sítio; o loader com I/O
 * não pode.
 */

// ─── Tipos ──────────────────────────────────────────────────────────────────

/** Uma linha de movimento mensal já agregada — vem do SQL ou de uma fixture de teste. */
export type HistoricoMovRow = {
  farmaciaId: string;
  ano: number;
  /** 1-12. */
  mes: number;
  compras: number;
  /** Já líquida: VENDA − DEVOLUCAO_CLIENTE. Pode ser negativa (mês de mais devoluções que vendas). */
  vendas: number;
};

export type HistoricoMesBucket = {
  ano: number;
  mes: number;
  /** "Jan 26" — mesmo formato de `EncomendaMonthlyMovement.mes`. */
  label: string;
  compras: number;
  vendas: number;
};

export type HistoricoFarmaciaSerie = {
  farmaciaId: string;
  farmaciaNome: string;
  /**
   * false quando esta farmácia não tem NENHUM `MovimentoArtigo`
   * ingerido (ver `getCoberturaMovimentos`). Os buckets abaixo existem
   * na mesma (zero-preenchidos) — este flag é o que distingue "sem
   * movimento" de "sem ledger".
   */
  temLedger: boolean;
  /** `ProdutoFarmacia.stockAtual` desta farmácia. Null se não houver ficha. */
  stockAtual: number | null;
  /** `avgDaily` canónico (lib/operational/metrics-shared) sobre os últimos 3 dos 12 meses. */
  avgDaily: number;
  /** `monthlyVelocity` canónico. */
  monthlyVelocity: number;
  /** `coverageDays` canónico — null quando sem demanda mensurável. */
  coverageDays: number | null;
  /** 12 meses, ordem cronológica ascendente, zero-preenchidos. */
  meses: HistoricoMesBucket[];
};

export type HistoricoProduto12MesesResult = {
  produtoId: string;
  cnp: number;
  designacao: string;
  farmacias: HistoricoFarmaciaSerie[];
};

// ─── Helpers puros ──────────────────────────────────────────────────────────

import { avgDaily, coverageDays, monthlyVelocity, WINDOW_90D } from "@/lib/operational/metrics-shared";

/**
 * Mesmos rótulos de `lib/encomendas-data.ts` (MES_ABBR), duplicados
 * aqui de propósito: aquele ficheiro importa `getPrisma`, e puxá-lo
 * traria Prisma/`server-only` para um módulo que precisa de correr num
 * `tsx` standalone sem BD (ver cabeçalho). Mesma regra de
 * `lib/movimentos-tipos.ts`.
 */
const MES_ABBR = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];

/** `ano*12+mes` (mes 1-based) — mesma convenção de `lib/encomendas-data.ts`. */
export function periodKey(ano: number, mes1based: number): number {
  return ano * 12 + mes1based;
}

export function keyToAnoMes(key: number): { ano: number; mes: number } {
  const mes = ((key - 1) % 12) + 1;
  const ano = Math.floor((key - 1) / 12);
  return { ano, mes };
}

function toF(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export type BuildHistoricoSeriesInput = {
  farmaciaIds: string[];
  movRows: HistoricoMovRow[];
  nomeById: Map<string, string>;
  stockById: Map<string, number | null>;
  ledgerById: Map<string, boolean>;
  /** ano*12+mes do mês CORRENTE — exclusivo, não entra na janela. */
  periodEndKey: number;
  /** Default 12. Parametrizável só para teste. */
  monthsBack?: number;
};

/**
 * Constrói as séries por farmácia a partir de linhas mensais já
 * agregadas. Pura — sem Prisma, sem I/O — para ser testável com
 * fixtures sintéticas. Zero-preenche os meses sem linha (um mês sem
 * movimento aparece a 0, não desaparece da tabela).
 */
export function buildHistoricoSeries(input: BuildHistoricoSeriesInput): HistoricoFarmaciaSerie[] {
  const monthsBack = input.monthsBack ?? 12;
  const periodStartKey = input.periodEndKey - monthsBack;
  const recentKeyStart = input.periodEndKey - 3;

  const rowsByFarmacia = new Map<string, Map<number, HistoricoMovRow>>();
  for (const r of input.movRows) {
    const key = periodKey(r.ano, r.mes);
    if (key < periodStartKey || key >= input.periodEndKey) continue; // fora da janela pedida — defesa
    let porMes = rowsByFarmacia.get(r.farmaciaId);
    if (!porMes) {
      porMes = new Map();
      rowsByFarmacia.set(r.farmaciaId, porMes);
    }
    porMes.set(key, r);
  }

  return input.farmaciaIds.map((fid) => {
    const porMes = rowsByFarmacia.get(fid);
    const meses: HistoricoMesBucket[] = [];
    let recentVendas = 0;

    for (let key = periodStartKey; key < input.periodEndKey; key++) {
      const { ano, mes } = keyToAnoMes(key);
      const row = porMes?.get(key);
      const compras = row ? Math.round(toF(row.compras)) : 0;
      const vendas = row ? Math.round(toF(row.vendas)) : 0;
      meses.push({ ano, mes, label: `${MES_ABBR[mes - 1]} ${String(ano).slice(2)}`, compras, vendas });
      if (key >= recentKeyStart) recentVendas += vendas;
    }

    const stockAtual = input.stockById.get(fid) ?? null;
    const ad = avgDaily(recentVendas, WINDOW_90D);
    const vel = monthlyVelocity(ad);
    const cov = coverageDays(stockAtual ?? 0, ad);

    return {
      farmaciaId: fid,
      farmaciaNome: input.nomeById.get(fid) ?? "—",
      temLedger: input.ledgerById.get(fid) ?? false,
      stockAtual,
      avgDaily: ad,
      monthlyVelocity: vel,
      coverageDays: cov,
      meses,
    };
  });
}

// ─── Lote (N produtos) — partição pura, sem Prisma ─────────────────────────

/** Uma linha de movimento mensal já agregada, com `produtoId` — a forma que vem do `$queryRaw` em lote. */
export type HistoricoMovRowLote = HistoricoMovRow & { produtoId: string };

/** `ProdutoFarmacia.stockAtual` de um (produto, farmácia). */
export type HistoricoStockRowLote = {
  produtoId: string;
  farmaciaId: string;
  stockAtual: number | null;
};

export type BuildHistoricoLoteInput = {
  produtos: Array<{ id: string; cnp: number; designacao: string }>;
  farmaciaIds: string[];
  movRows: HistoricoMovRowLote[];
  stockRows: HistoricoStockRowLote[];
  nomeById: Map<string, string>;
  ledgerById: Map<string, boolean>;
  periodEndKey: number;
  monthsBack?: number;
};

/**
 * A parte PURA de `getHistoricoProdutosEmLote`
 * (`lib/encomendas/historico-produto.ts`): reparte `movRows`/`stockRows`
 * (já vindas de UMA consulta agregada para N produtos) por `produtoId`, e
 * chama `buildHistoricoSeries` uma vez por produto — a MESMA função pura
 * que a versão de um único produto usa, sem reimplementar nada da
 * agregação em si (janela de 12 meses, zero-preenchimento, métricas
 * canónicas). `nomeById`/`ledgerById`/`farmaciaIds` são partilhados por
 * todos os produtos do lote — o ledger e o universo de farmácias não
 * mudam de produto para produto.
 *
 * Testável com fixtures sintéticas, sem BD — mesma razão de
 * `buildHistoricoSeries`.
 */
export function buildHistoricoLote(
  input: BuildHistoricoLoteInput,
): Map<string, HistoricoProduto12MesesResult> {
  const movRowsByProduto = new Map<string, HistoricoMovRow[]>();
  for (const r of input.movRows) {
    let arr = movRowsByProduto.get(r.produtoId);
    if (!arr) {
      arr = [];
      movRowsByProduto.set(r.produtoId, arr);
    }
    arr.push({ farmaciaId: r.farmaciaId, ano: r.ano, mes: r.mes, compras: r.compras, vendas: r.vendas });
  }

  const stockByProduto = new Map<string, Map<string, number | null>>();
  for (const r of input.stockRows) {
    let m = stockByProduto.get(r.produtoId);
    if (!m) {
      m = new Map();
      stockByProduto.set(r.produtoId, m);
    }
    m.set(r.farmaciaId, r.stockAtual);
  }

  const resultado = new Map<string, HistoricoProduto12MesesResult>();
  for (const produto of input.produtos) {
    const series = buildHistoricoSeries({
      farmaciaIds: input.farmaciaIds,
      movRows: movRowsByProduto.get(produto.id) ?? [],
      nomeById: input.nomeById,
      stockById: stockByProduto.get(produto.id) ?? new Map(),
      ledgerById: input.ledgerById,
      periodEndKey: input.periodEndKey,
      monthsBack: input.monthsBack,
    });
    resultado.set(produto.id, {
      produtoId: produto.id,
      cnp: produto.cnp,
      designacao: produto.designacao,
      farmacias: series,
    });
  }
  return resultado;
}
