/**
 * lib/transferencias/anulacao.ts
 *
 * Lógica pura (sem `server-only`, sem BD) para decidir se uma
 * `Transferencia` pode ser ANULADA — mesma semântica de
 * `lib/encomendas/anulacao.ts`, ver o comentário no enum
 * `EstadoTransferencia` em `prisma/schema.prisma`.
 *
 * Distinção face a ELIMINADA: essa é exclusiva de RASCUNHO desde
 * 2026-09-29 (`deleteTransferenciaAction`); ANULADA é o equivalente para
 * uma transferência já FINALIZADA — nunca apaga a row nem as linhas,
 * exige motivo, regista quem/quando, e a reimpressão do documento
 * mostra "ANULADO" com destaque.
 */

export type DecisaoAnulacaoTransferencia =
  | { podeAnular: true }
  | { podeAnular: false; motivo: string };

export function podeAnularTransferencia(
  estado: string,
  motivo: string | null | undefined
): DecisaoAnulacaoTransferencia {
  if (estado === "RASCUNHO") {
    return { podeAnular: false, motivo: "Um rascunho elimina-se — não há nada finalizado para anular." };
  }
  if (estado === "ELIMINADA") {
    return { podeAnular: false, motivo: "Esta transferência já foi eliminada." };
  }
  if (estado === "ANULADA") {
    return { podeAnular: false, motivo: "Esta transferência já foi anulada." };
  }
  if (estado !== "FINALIZADA") {
    return { podeAnular: false, motivo: `Estado "${estado}" não é anulável.` };
  }
  if (!motivo || motivo.trim().length === 0) {
    return { podeAnular: false, motivo: "É obrigatório indicar um motivo para anular." };
  }
  return { podeAnular: true };
}
