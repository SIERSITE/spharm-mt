/**
 * lib/encomendas/anulacao.ts
 *
 * Lógica pura (sem `server-only`, sem BD) para decidir se uma
 * `ListaEncomenda` pode ser ANULADA — ver o comentário no enum
 * `EstadoListaEncomenda` em `prisma/schema.prisma` para a distinção
 * face a `ELIMINADA` (essa é exclusiva de RASCUNHO desde 2026-09-29;
 * ANULADA é o equivalente para uma encomenda que já saiu do rascunho).
 *
 * Regra de negócio: nunca se anula silenciosamente uma edição — anular
 * é sempre "cancelar este documento", nunca "corrigir este documento".
 * Para corrigir, o utilizador anula e duplica como um novo documento
 * (ver `duplicarRascunhoComoNovoAction`/uma futura duplicação genérica
 * por id).
 */

export type EstadoAnulavelListaEncomenda = "FINALIZADA" | "EXPORTADA";

const ESTADOS_ANULAVEIS: ReadonlySet<string> = new Set<EstadoAnulavelListaEncomenda>(["FINALIZADA", "EXPORTADA"]);

export type DecisaoAnulacaoListaEncomenda =
  | { podeAnular: true }
  | { podeAnular: false; motivo: string };

/**
 * Uma encomenda só pode ser anulada depois de sair de RASCUNHO (nesse
 * caso usa-se Eliminar) e antes de já estar ANULADA/ELIMINADA. Exige
 * sempre um motivo não vazio — validado aqui, não só no formulário, para
 * que a acção do servidor nunca dependa só da UI ter posto a validação.
 */
export function podeAnularListaEncomenda(
  estado: string,
  motivo: string | null | undefined
): DecisaoAnulacaoListaEncomenda {
  if (estado === "RASCUNHO") {
    return { podeAnular: false, motivo: "Um rascunho elimina-se — não tem exportação nenhuma para anular." };
  }
  if (estado === "ELIMINADA") {
    return { podeAnular: false, motivo: "Esta encomenda já foi eliminada." };
  }
  if (estado === "ANULADA") {
    return { podeAnular: false, motivo: "Esta encomenda já foi anulada." };
  }
  if (!ESTADOS_ANULAVEIS.has(estado)) {
    return { podeAnular: false, motivo: `Estado "${estado}" não é anulável.` };
  }
  if (!motivo || motivo.trim().length === 0) {
    return { podeAnular: false, motivo: "É obrigatório indicar um motivo para anular." };
  }
  return { podeAnular: true };
}
