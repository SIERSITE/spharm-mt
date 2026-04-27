import "server-only";
import { getPrisma } from "@/lib/prisma";
import type { OrderExportState, EstadoListaEncomenda } from "@/generated/prisma/client";

export type OrderDetailLine = {
  id: string;
  produtoId: string;
  cnp: number;
  designacao: string;
  fabricante: string | null;
  fornecedor: string | null;
  currentStock: number | null;
  quantidadeSugerida: number | null;
  quantidadeAjustada: number | null;
  notas: string | null;
};

export type OrderTimelineEvent = {
  id: string;
  attempt: number;
  at: Date;
  status: string;
  message: string | null;
  httpStatus: number | null;
  spharmSqlError: string | null;
  actorId: string | null;
};

export type OrderDetail = {
  id: string;
  nome: string;
  estado: EstadoListaEncomenda;
  estadoExport: OrderExportState;
  farmaciaId: string;
  farmaciaNome: string;
  criadoPorNome: string;
  dataCriacao: Date;
  dataAtualizacao: Date;
  linhas: OrderDetailLine[];
  outbox: {
    id: string;
    state: OrderExportState;
    spharmDocumentId: string | null;
    exportedAt: Date | null;
    attemptCount: number;
    lastError: string | null;
  } | null;
  timeline: OrderTimelineEvent[];
  /** Indica se a lista é editável — true só quando estado === RASCUNHO. */
  editable: boolean;
};

function toF(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Carrega tudo o que a página de detalhe precisa numa só passagem
 * (server component → client). Devolve null se a lista não existir
 * — caller deve responder com 404. Os dados de stock por linha vêm
 * do ProdutoFarmacia da farmácia da lista.
 */
export async function loadOrderDetail(id: string): Promise<OrderDetail | null> {
  const prisma = await getPrisma();

  const lista = await prisma.listaEncomenda.findUnique({
    where: { id },
    include: {
      farmacia: { select: { id: true, nome: true } },
      criadoPor: { select: { nome: true } },
      linhas: {
        orderBy: { id: "asc" },
        include: {
          produto: {
            select: {
              id: true,
              cnp: true,
              designacao: true,
              fabricante: { select: { nomeNormalizado: true } },
            },
          },
        },
      },
      outbox: {
        select: {
          id: true,
          state: true,
          spharmDocumentId: true,
          exportedAt: true,
          attemptCount: true,
          lastError: true,
        },
      },
    },
  });

  if (!lista) return null;

  // Stock por linha — uma query por todos os produtoIds desta farmácia.
  const produtoIds = lista.linhas.map((l) => l.produtoId);
  const pfRows =
    produtoIds.length > 0
      ? await prisma.produtoFarmacia.findMany({
          where: {
            farmaciaId: lista.farmaciaId,
            produtoId: { in: produtoIds },
          },
          select: {
            produtoId: true,
            stockAtual: true,
            fornecedorOrigem: true,
          },
        })
      : [];
  const stockByProduto = new Map(
    pfRows.map((r) => [r.produtoId, { stock: toF(r.stockAtual), fornecedor: r.fornecedorOrigem }])
  );

  const timeline: OrderTimelineEvent[] = lista.outbox
    ? (
        await prisma.orderExportAudit.findMany({
          where: { outboxId: lista.outbox.id },
          orderBy: { at: "desc" },
          take: 50,
        })
      ).map((a) => ({
        id: a.id,
        attempt: a.attempt,
        at: a.at,
        status: a.status,
        message: a.message,
        httpStatus: a.httpStatus,
        spharmSqlError: a.spharmSqlError,
        actorId: a.actorId,
      }))
    : [];

  return {
    id: lista.id,
    nome: lista.nome,
    estado: lista.estado,
    estadoExport: lista.estadoExport,
    farmaciaId: lista.farmaciaId,
    farmaciaNome: lista.farmacia.nome,
    criadoPorNome: lista.criadoPor.nome,
    dataCriacao: lista.dataCriacao,
    dataAtualizacao: lista.dataAtualizacao,
    linhas: lista.linhas.map((l) => ({
      id: l.id,
      produtoId: l.produtoId,
      cnp: l.produto.cnp,
      designacao: l.produto.designacao,
      fabricante: l.produto.fabricante?.nomeNormalizado ?? null,
      fornecedor: stockByProduto.get(l.produtoId)?.fornecedor ?? null,
      currentStock: stockByProduto.get(l.produtoId)?.stock ?? null,
      quantidadeSugerida: toF(l.quantidadeSugerida),
      quantidadeAjustada: toF(l.quantidadeAjustada),
      notas: l.notas,
    })),
    outbox: lista.outbox
      ? {
          id: lista.outbox.id,
          state: lista.outbox.state,
          spharmDocumentId: lista.outbox.spharmDocumentId,
          exportedAt: lista.outbox.exportedAt,
          attemptCount: lista.outbox.attemptCount,
          lastError: lista.outbox.lastError,
        }
      : null,
    timeline,
    editable: lista.estado === "RASCUNHO",
  };
}
