import type { PrismaClient } from "@/generated/prisma/client";
import {
  Prisma,
  type OrderExportState,
  type EstadoListaEncomenda,
} from "@/generated/prisma/client";

/**
 * Data loader para a página de listagem de encomendas (/encomendas).
 * Read-only — mutações vão por server actions.
 *
 * Filtros suportados (todos opcionais):
 *   farmaciaId, estado, estadoExport, search (nome ILIKE), dataCriacao
 *   range. Paginado — page é 1-based e pageSize tem cap de 200.
 */

export type OrderRow = {
  id: string;
  nome: string;
  estado: EstadoListaEncomenda;
  estadoExport: OrderExportState;
  farmaciaId: string;
  farmaciaNome: string;
  criadoPorNome: string;
  linhasCount: number;
  dataCriacao: Date;
  dataAtualizacao: Date;
  outboxId: string | null;
  spharmDocumentId: string | null;
  exportedAt: Date | null;
  /**
   * Estimativa de custo — SUM(quantidadeAjustada × ProdutoFarmacia.puc)
   * das linhas com ambos os valores disponíveis. `null` quando NENHUMA
   * linha tinha PUC conhecido (nunca finge um valor a partir de zero
   * dados); `parcial=true` quando algumas linhas entraram no total mas
   * outras ficaram de fora por falta de PUC — o valor mostrado é uma
   * estimativa por defeito, nunca o total real da encomenda.
   */
  valorEstimado: { total: number; parcial: boolean } | null;
};

export type OrderListFilters = {
  farmaciaId?: string;
  estado?: EstadoListaEncomenda;
  estadoExport?: OrderExportState;
  search?: string;
  dateFrom?: Date;
  dateTo?: Date;
  page: number;
  pageSize: number;
};

export type OrderListData = {
  orders: OrderRow[];
  farmacias: { id: string; nome: string }[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;

export function clampPageSize(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(1, Math.floor(n)), MAX_PAGE_SIZE);
}

export function clampPage(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.max(1, Math.floor(n));
}

export async function loadOrderListData(
  prisma: PrismaClient,
  filters: OrderListFilters
): Promise<OrderListData> {
  const page = clampPage(filters.page);
  const pageSize = clampPageSize(filters.pageSize);

  const where: Prisma.ListaEncomendaWhereInput = {};
  if (filters.farmaciaId) where.farmaciaId = filters.farmaciaId;
  if (filters.estado) {
    where.estado = filters.estado;
  } else {
    // Soft-delete (ver enum `EstadoListaEncomenda`): sem filtro explícito,
    // uma encomenda ELIMINADA nunca aparece na listagem normal. A row e
    // as suas linhas continuam na BD — só saem daqui.
    where.estado = { not: "ELIMINADA" };
  }
  if (filters.estadoExport) where.estadoExport = filters.estadoExport;
  if (filters.search && filters.search.trim().length > 0) {
    where.nome = { contains: filters.search.trim(), mode: "insensitive" };
  }
  if (filters.dateFrom || filters.dateTo) {
    const range: Prisma.DateTimeFilter = {};
    if (filters.dateFrom) range.gte = filters.dateFrom;
    if (filters.dateTo) range.lte = filters.dateTo;
    where.dataCriacao = range;
  }

  const skip = (page - 1) * pageSize;

  const [listas, total, farmacias] = await Promise.all([
    prisma.listaEncomenda.findMany({
      where,
      orderBy: { dataCriacao: "desc" },
      skip,
      take: pageSize,
      include: {
        farmacia: { select: { nome: true } },
        criadoPor: { select: { nome: true } },
        _count: { select: { linhas: true } },
        outbox: {
          select: { id: true, spharmDocumentId: true, exportedAt: true },
        },
        linhas: { select: { produtoId: true, quantidadeAjustada: true } },
      },
    }),
    prisma.listaEncomenda.count({ where }),
    prisma.farmacia.findMany({
      where: { estado: "ATIVO" },
      select: { id: true, nome: true },
      orderBy: { nome: "asc" },
    }),
  ]);

  // ── Valor estimado ──────────────────────────────────────────────
  //
  // Uma query extra, não um join no `findMany` acima: PUC é por
  // (produtoId, farmaciaId) — cada encomenda desta página pode ter uma
  // farmácia diferente, e um único `findMany` com `OR` por par é mais
  // simples e mais barato do que N sub-queries (N = página, tipicamente
  // ≤25). `pageSize` tem tecto de 200 — o `OR` nunca cresce sem limite.
  const paresProdutoFarmacia = new Set<string>();
  for (const l of listas) {
    for (const linha of l.linhas) paresProdutoFarmacia.add(`${linha.produtoId}::${l.farmaciaId}`);
  }
  const pucPorPar = new Map<string, number>();
  if (paresProdutoFarmacia.size > 0) {
    const farmaciaIdsPagina = [...new Set(listas.map((l) => l.farmaciaId))];
    const produtoIdsPagina = [...new Set(listas.flatMap((l) => l.linhas.map((x) => x.produtoId)))];
    const rows = await prisma.produtoFarmacia.findMany({
      where: { farmaciaId: { in: farmaciaIdsPagina }, produtoId: { in: produtoIdsPagina }, puc: { not: null } },
      select: { produtoId: true, farmaciaId: true, puc: true },
    });
    for (const r of rows) {
      if (r.puc == null) continue;
      pucPorPar.set(`${r.produtoId}::${r.farmaciaId}`, Number(r.puc));
    }
  }

  const orders: OrderRow[] = listas.map((l) => {
    let total = 0;
    let comValor = 0;
    for (const linha of l.linhas) {
      const puc = pucPorPar.get(`${linha.produtoId}::${l.farmaciaId}`);
      const qtd = linha.quantidadeAjustada != null ? Number(linha.quantidadeAjustada) : null;
      if (puc == null || qtd == null) continue;
      total += puc * qtd;
      comValor++;
    }
    const valorEstimado =
      comValor === 0 ? null : { total, parcial: comValor < l.linhas.length };

    return {
      id: l.id,
      nome: l.nome,
      estado: l.estado,
      estadoExport: l.estadoExport,
      farmaciaId: l.farmaciaId,
      farmaciaNome: l.farmacia.nome,
      criadoPorNome: l.criadoPor.nome,
      linhasCount: l._count.linhas,
      dataCriacao: l.dataCriacao,
      dataAtualizacao: l.dataAtualizacao,
      outboxId: l.outbox?.id ?? null,
      spharmDocumentId: l.outbox?.spharmDocumentId ?? null,
      exportedAt: l.outbox?.exportedAt ?? null,
      valorEstimado,
    };
  });

  return {
    orders,
    farmacias,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}
