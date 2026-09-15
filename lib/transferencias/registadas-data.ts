import "server-only";
import { getPrisma } from "@/lib/prisma";
import type { EstadoTransferencia } from "@/generated/prisma/client";

/**
 * lib/transferencias/registadas-data.ts
 *
 * Data loader mínimo para a listagem das `Transferencia` REAIS (Bloco D)
 * dentro de /transferencias — distinto do relatório de SUGESTÕES em
 * `lib/transferencias-data.ts`, que este módulo não toca.
 *
 * Antes desta revisão (2026-09) não havia nenhuma UI para ver as
 * `Transferencia`/`LinhaTransferencia` depois de criadas — nasciam em
 * `gerarPlanoGrupoAction`/`createInternalTransferAction` e ficavam
 * invisíveis. Ver o comentário no modelo `Transferencia` em
 * `prisma/schema.prisma`.
 *
 * `ELIMINADA` (soft-delete) sai da listagem por omissão — ver
 * `lib/encomendas/eliminacao.ts` para o equivalente em `ListaEncomenda`.
 */

export type TransferenciaRegistadaRow = {
  id: string;
  farmaciaOrigemNome: string;
  farmaciaDestinoNome: string;
  estado: EstadoTransferencia;
  nLinhas: number;
  criadoPorNome: string;
  dataCriacao: Date;
};

const MAX_ROWS = 200;

export async function loadTransferenciasRegistadas(): Promise<TransferenciaRegistadaRow[]> {
  const prisma = await getPrisma();

  const transferencias = await prisma.transferencia.findMany({
    where: { estado: { not: "ELIMINADA" } },
    orderBy: { dataCriacao: "desc" },
    take: MAX_ROWS,
    include: {
      farmaciaOrigem: { select: { nome: true } },
      farmaciaDestino: { select: { nome: true } },
      criadoPor: { select: { nome: true } },
      _count: { select: { linhas: true } },
    },
  });

  return transferencias.map((t) => ({
    id: t.id,
    farmaciaOrigemNome: t.farmaciaOrigem.nome,
    farmaciaDestinoNome: t.farmaciaDestino.nome,
    estado: t.estado,
    nLinhas: t._count.linhas,
    criadoPorNome: t.criadoPor.nome,
    dataCriacao: t.dataCriacao,
  }));
}
