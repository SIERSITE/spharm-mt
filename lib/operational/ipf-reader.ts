/**
 * lib/operational/ipf-reader.ts
 *
 * Loader em batch de `IndicadoresProdutoFarmacia` para o runtime web.
 * Server-only. Usado pelos loaders dual-read em
 * `lib/stock-data.ts`, `lib/transferencias-data.ts`,
 * `lib/encomendas-data.ts`.
 *
 * Contrato:
 *   - Read-through cache implícita: a IPF é repopulada por
 *     `scripts/populate-indicadores-produto-farmacia.ts`. Em runtime
 *     só lemos; nunca escrevemos.
 *   - Sem freshness check nesta passagem: se a row existe, é usada.
 *     A coluna `dataCalculo` é exposta no output para futuros
 *     consumidores que queiram decidir staleness.
 *   - Map keyed por `${produtoId}:${farmaciaId}`. Caller usa o mesmo
 *     formato que já usa para `salesMap`.
 *   - Decimal → number convertido aqui (Prisma Decimal não interopera
 *     bem com aritmética JS). null preservado.
 */

import "server-only";
import { getPrisma } from "@/lib/prisma";
import { recordIpfHit, recordLiveFallback } from "@/lib/operational/ipf-metrics";

export type IpfReadRow = {
  produtoId: string;
  farmaciaId: string;
  /** un./dia, derivado de Venda diária ou VendaMensal × 3m / 90 (fallback). */
  mediaVendasDiarias30d: number | null;
  mediaVendasDiarias90d: number | null;
  /** un./mês */
  mediaVendasMensais3m: number | null;
  mediaVendasMensais12m: number | null;
  /** stockAtual / avgDaily30d. null quando avgDaily=0 ou stock=0. */
  diasStockRestante: number | null;
  diasSemVenda: number | null;
  ultimoPrecoCompra: number | null;
  ultimoFornecedorId: string | null;
  classificacaoABC: "A" | "B" | "C" | "NAO_CLASSIFICADO";
  classificacaoRotacao: "NORMAL" | "ATENCAO" | "SEM_ROTACAO";
  valorStockParado: number | null;
  dataCalculo: Date;
};

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Carrega IPF rows para as farmácias dadas. Devolve Map keyed por
 * `${produtoId}:${farmaciaId}` para join O(1) no caller.
 *
 * Se IPF estiver vazia (nunca populada), o Map devolve-se vazio e o
 * caller deve cair para cálculo live transparentemente.
 */
export async function loadIpfBatch(
  farmaciaIds: string[],
): Promise<Map<string, IpfReadRow>> {
  if (farmaciaIds.length === 0) return new Map();
  const prisma = await getPrisma();
  const rows = await prisma.indicadoresProdutoFarmacia.findMany({
    where: { farmaciaId: { in: farmaciaIds } },
    select: {
      produtoId: true,
      farmaciaId: true,
      mediaVendasDiarias30d: true,
      mediaVendasDiarias90d: true,
      mediaVendasMensais3m: true,
      mediaVendasMensais12m: true,
      diasStockRestante: true,
      diasSemVenda: true,
      ultimoPrecoCompra: true,
      ultimoFornecedorId: true,
      classificacaoABC: true,
      classificacaoRotacao: true,
      valorStockParado: true,
      dataCalculo: true,
    },
  });
  const map = new Map<string, IpfReadRow>();
  for (const r of rows) {
    map.set(`${r.produtoId}:${r.farmaciaId}`, {
      produtoId: r.produtoId,
      farmaciaId: r.farmaciaId,
      mediaVendasDiarias30d: toNum(r.mediaVendasDiarias30d),
      mediaVendasDiarias90d: toNum(r.mediaVendasDiarias90d),
      mediaVendasMensais3m: toNum(r.mediaVendasMensais3m),
      mediaVendasMensais12m: toNum(r.mediaVendasMensais12m),
      diasStockRestante: toNum(r.diasStockRestante),
      diasSemVenda: r.diasSemVenda,
      ultimoPrecoCompra: toNum(r.ultimoPrecoCompra),
      ultimoFornecedorId: r.ultimoFornecedorId,
      classificacaoABC: r.classificacaoABC,
      classificacaoRotacao: r.classificacaoRotacao,
      valorStockParado: toNum(r.valorStockParado),
      dataCalculo: r.dataCalculo,
    });
  }
  return map;
}

/**
 * Resolve o avgDaily90d para um (produto, farmácia) preferindo IPF
 * quando disponível. Caller fornece o fallback `liveAvgDaily90d`
 * computado a partir do salesMap quando IPF não tem a linha (ou tem
 * mediaVendasDiarias90d=null).
 *
 * Política:
 *   - Row IPF existe e `mediaVendasDiarias90d` != null → usa IPF.
 *   - Row IPF existe mas `mediaVendasDiarias90d` é null → usa IPF (0)
 *     porque significa "produto sem vendas mensuráveis", não
 *     "indicador em falta". Idêntico ao que o fallback produziria.
 *   - Row IPF não existe → cai para fallback.
 */
export function resolveAvgDaily90d(
  ipfRow: IpfReadRow | undefined,
  liveAvgDaily90d: number,
): { value: number; source: "ipf" | "live" } {
  if (ipfRow) {
    recordIpfHit();
    return { value: ipfRow.mediaVendasDiarias90d ?? 0, source: "ipf" };
  }
  recordLiveFallback();
  return { value: liveAvgDaily90d, source: "live" };
}
