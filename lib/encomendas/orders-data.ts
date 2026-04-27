import "server-only";
import { getPrisma } from "@/lib/prisma";
import {
  Prisma,
  type OrderExportState,
  type EstadoListaEncomenda,
} from "@/generated/prisma/client";

/**
 * Data loader para a página de listagem de encomendas (/encomendas/lista).
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
  filters: OrderListFilters
): Promise<OrderListData> {
  const prisma = await getPrisma();

  const page = clampPage(filters.page);
  const pageSize = clampPageSize(filters.pageSize);

  const where: Prisma.ListaEncomendaWhereInput = {};
  if (filters.farmaciaId) where.farmaciaId = filters.farmaciaId;
  if (filters.estado) where.estado = filters.estado;
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
      },
    }),
    prisma.listaEncomenda.count({ where }),
    prisma.farmacia.findMany({
      where: { estado: "ATIVO" },
      select: { id: true, nome: true },
      orderBy: { nome: "asc" },
    }),
  ]);

  const orders: OrderRow[] = listas.map((l) => ({
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
  }));

  return {
    orders,
    farmacias,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}
