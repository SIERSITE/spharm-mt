/**
 * lib/encomendas/eliminacao.ts
 *
 * Lógica pura (sem `server-only`, sem BD) para decidir COMO uma
 * `ListaEncomenda` pode ser eliminada — ver os comentários em
 * `prisma/schema.prisma` nos enums `EstadoListaEncomenda`/
 * `EstadoTransferencia` para o desenho geral (soft-delete via
 * transição de estado, nunca apagar a row).
 *
 * Regra de negócio (constrangimento obrigatório do bloco 2026-09):
 *   · nunca reescrever automaticamente uma exportação já efectiva —
 *     só avisar claramente e exigir confirmação explícita extra.
 *
 * `Transferencia` NUNCA teve circuito de exportação (ver o comentário
 * no modelo, em `prisma/schema.prisma`) — por isso não precisa desta
 * distinção: elimina-se sempre livremente, com a confirmação normal.
 * Só `ListaEncomenda` precisa deste módulo.
 */

/** O suficiente do `OrderOutbox` para decidir se uma exportação é real. */
export type OutboxExportInfo = {
  state: string | null;
  spharmDocumentId: string | null;
} | null;

/**
 * Distingue uma exportação REAL de uma SIMULADA.
 *
 * "Ferramentas de teste" (`simulateAckAction`, `app/encomendas/lista/actions.ts`)
 * grava `spharmDocumentId` com o padrão `SIM-{timestamp}` e a auditoria
 * com o prefixo `[SIMULADO]` — nunca passou pelo agent real. Uma
 * encomenda que só foi "exportada" por um clique de teste não deve
 * activar o aviso de "já foi exportada ao SPharm de verdade".
 */
export function foiExportadaDeFacto(outbox: OutboxExportInfo): boolean {
  if (!outbox) return false;
  if (outbox.state !== "EXPORTADO") return false;
  if (outbox.spharmDocumentId != null && outbox.spharmDocumentId.startsWith("SIM-")) {
    return false;
  }
  return true;
}

export const AVISO_ELIMINACAO_JA_EXPORTADA =
  "Esta encomenda já foi exportada para o SPharm. Eliminar aqui NÃO desfaz essa exportação — só deixa de aparecer na lista do SaaS.";

export type DecisaoEliminacaoListaEncomenda =
  | { podeEliminarDirectamente: true }
  | { podeEliminarDirectamente: false; aviso: string };

/**
 * Decide se uma `ListaEncomenda` pode ser eliminada sem aviso especial
 * (ainda não foi exportada de facto) ou se exige que o cliente confirme
 * explicitamente um segundo passo (`confirmarExportadaMesmoAssim`)
 * porque já foi exportada de facto ao SPharm.
 *
 * Não decide "pode eliminar, sim/não" — eliminar é sempre permitido
 * (é só um soft-delete interno); decide apenas se precisa do aviso
 * extra antes de o fazer.
 */
export function podeEliminarListaEncomenda(
  outbox: OutboxExportInfo
): DecisaoEliminacaoListaEncomenda {
  if (foiExportadaDeFacto(outbox)) {
    return { podeEliminarDirectamente: false, aviso: AVISO_ELIMINACAO_JA_EXPORTADA };
  }
  return { podeEliminarDirectamente: true };
}
