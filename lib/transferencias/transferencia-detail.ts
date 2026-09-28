import "server-only";
import { getPrisma } from "@/lib/prisma";
import type { EstadoTransferencia } from "@/generated/prisma/client";

/**
 * lib/transferencias/transferencia-detail.ts
 *
 * Detalhe de UMA (ou várias) `Transferencia` — produto a produto, com
 * CNP/designação/fabricante — para gerar o documento «Guia de
 * Transferência» (imprimir/PDF/email, ver
 * `lib/reporting/adapters/transferencia-documento.ts`).
 *
 * Distinto de `lib/transferencias/registadas-data.ts`
 * (`loadTransferenciasRegistadas`), que só traz a CONTAGEM de linhas
 * para a listagem — nunca o produto a produto.
 */

export type TransferenciaDetailLinha = {
  produtoId: string;
  cnp: number;
  designacao: string;
  fabricante: string | null;
  quantidade: number;
  notas: string | null;
};

export type TransferenciaDetail = {
  id: string;
  farmaciaOrigemId: string;
  farmaciaOrigemNome: string;
  farmaciaDestinoId: string;
  farmaciaDestinoNome: string;
  estado: EstadoTransferencia;
  criadoPorNome: string;
  dataCriacao: Date;
  linhas: TransferenciaDetailLinha[];
};

function toF(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Devolve só as que existem — ids inválidos/inexistentes são omitidos, nunca lançam. */
export async function loadTransferenciasDetail(ids: readonly string[]): Promise<TransferenciaDetail[]> {
  if (ids.length === 0) return [];
  const prisma = await getPrisma();
  const rows = await prisma.transferencia.findMany({
    where: { id: { in: [...ids] } },
    include: {
      farmaciaOrigem: { select: { id: true, nome: true } },
      farmaciaDestino: { select: { id: true, nome: true } },
      criadoPor: { select: { nome: true } },
      linhas: {
        orderBy: { id: "asc" },
        include: {
          produto: {
            select: { cnp: true, designacao: true, fabricante: { select: { nomeNormalizado: true } } },
          },
        },
      },
    },
  });
  // Preserva a ordem pedida (ids), nunca a ordem que a BD devolveu.
  const porId = new Map(rows.map((t) => [t.id, t]));
  return ids
    .map((id) => porId.get(id))
    .filter((t): t is NonNullable<typeof t> => !!t)
    .map((t) => ({
      id: t.id,
      farmaciaOrigemId: t.farmaciaOrigem.id,
      farmaciaOrigemNome: t.farmaciaOrigem.nome,
      farmaciaDestinoId: t.farmaciaDestino.id,
      farmaciaDestinoNome: t.farmaciaDestino.nome,
      estado: t.estado,
      criadoPorNome: t.criadoPor.nome,
      dataCriacao: t.dataCriacao,
      linhas: t.linhas.map((l) => ({
        produtoId: l.produtoId,
        cnp: l.produto.cnp,
        designacao: l.produto.designacao,
        fabricante: l.produto.fabricante?.nomeNormalizado ?? null,
        quantidade: toF(l.quantidade),
        notas: l.notas,
      })),
    }));
}

export async function loadTransferenciaDetail(id: string): Promise<TransferenciaDetail | null> {
  const [detail] = await loadTransferenciasDetail([id]);
  return detail ?? null;
}
