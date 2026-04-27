import "server-only";
import { getPrisma } from "@/lib/prisma";
import type { OrderExportState, EstadoListaEncomenda } from "@/generated/prisma/client";

/**
 * Data loader para a página de listagem de encomendas (/encomendas/lista).
 * Read-only — mutações vão por server actions.
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

export type OrderListData = {
  orders: OrderRow[];
  farmacias: { id: string; nome: string }[];
};

export async function loadOrderListData(): Promise<OrderListData> {
  const prisma = await getPrisma();

  const [listas, farmacias] = await Promise.all([
    prisma.listaEncomenda.findMany({
      orderBy: { dataCriacao: "desc" },
      take: 100,
      include: {
        farmacia: { select: { nome: true } },
        criadoPor: { select: { nome: true } },
        _count: { select: { linhas: true } },
        outbox: {
          select: { id: true, spharmDocumentId: true, exportedAt: true },
        },
      },
    }),
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

  return { orders, farmacias };
}
