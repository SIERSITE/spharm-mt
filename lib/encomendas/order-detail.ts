import "server-only";
import { getPrisma } from "@/lib/prisma";
import type { OrderExportState, EstadoListaEncomenda } from "@/generated/prisma/client";
import type { OrigemLinha } from "@/lib/encomendas/origem-linha";

export type OrderDetailLine = {
  id: string;
  produtoId: string;
  cnp: number;
  designacao: string;
  fabricante: string | null;
  /** Fornecedor HABITUAL (ProdutoFarmacia.fornecedorOrigem) — só informativo, uso interno. */
  fornecedor: string | null;
  /**
   * Fornecedor DECIDIDO para esta linha nesta encomenda
   * (`LinhaEncomenda.fornecedorSugeridoId` → `Fornecedor.nome`) — é este
   * que determina para quem vai o documento externo (ver
   * `lib/reporting/adapters/encomenda-documento.ts`: uma encomenda com
   * linhas de fornecedores diferentes gera um documento por fornecedor).
   * Distinto de `fornecedor` acima (esse é só o histórico "onde compramos
   * isto normalmente", nunca a decisão desta encomenda).
   */
  fornecedorSugeridoId: string | null;
  fornecedorSugeridoNome: string | null;
  currentStock: number | null;
  quantidadeSugerida: number | null;
  quantidadeAjustada: number | null;
  notas: string | null;
  /**
   * Proveniência da linha, para a ficha reaberta continuar a distinguir
   * o que foi calculado do que foi decidido.
   *
   * É o que faz «guardar e reabrir» preservar a origem: sem isto, uma
   * encomenda reaberta era uma lista de linhas todas iguais, e o
   * recálculo a partir daí voltava a apagar as manuais.
   */
  origem: OrigemLinha;
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
  /** Morada/NIF/contacto da farmácia — cabeçalho do documento profissional (ver encomenda-documento.ts). Omissos quando não configurados. */
  farmaciaMorada: string | null;
  farmaciaNif: string | null;
  farmaciaContacto: string | null;
  criadoPorNome: string;
  dataCriacao: Date;
  dataAtualizacao: Date;
  /** Número de documento (ex.: "EN-000012") — só atribuído na finalização, ver lib/documentos/numeracao.ts. */
  numero: string | null;
  motivoAnulacao: string | null;
  anuladoPorNome: string | null;
  anuladoEm: Date | null;
  /** Bloqueio optimista do autosave — ver lib/encomendas/autosave.ts. */
  versao: number;
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
      farmacia: { select: { id: true, nome: true, morada: true, nif: true, contacto: true } },
      criadoPor: { select: { nome: true } },
      anuladoPor: { select: { nome: true } },
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
          fornecedorSugerido: { select: { id: true, nome: true, nomeNormalizado: true } },
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
    farmaciaMorada: lista.farmacia.morada,
    farmaciaNif: lista.farmacia.nif,
    farmaciaContacto: lista.farmacia.contacto,
    criadoPorNome: lista.criadoPor.nome,
    dataCriacao: lista.dataCriacao,
    dataAtualizacao: lista.dataAtualizacao,
    numero: lista.numero,
    motivoAnulacao: lista.motivoAnulacao,
    anuladoPorNome: lista.anuladoPor?.nome ?? null,
    anuladoEm: lista.anuladoEm,
    versao: lista.versao,
    linhas: lista.linhas.map((l) => ({
      id: l.id,
      produtoId: l.produtoId,
      origem: l.origem,
      cnp: l.produto.cnp,
      designacao: l.produto.designacao,
      fabricante: l.produto.fabricante?.nomeNormalizado ?? null,
      fornecedor: stockByProduto.get(l.produtoId)?.fornecedor ?? null,
      fornecedorSugeridoId: l.fornecedorSugeridoId,
      fornecedorSugeridoNome: l.fornecedorSugerido?.nome ?? l.fornecedorSugerido?.nomeNormalizado ?? null,
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
