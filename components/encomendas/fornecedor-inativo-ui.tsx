/**
 * components/encomendas/fornecedor-inativo-ui.tsx
 *
 * Apresentação ÚNICA dos fornecedores INATIVOS nas encomendas — usada pela criação
 * (`order-create-client`) e pelo detalhe (`order-detail-client`) para nunca haver dois
 * comportamentos. A regra (servidor) está em `lib/encomendas/fornecedor-inativo.ts`:
 * um inativo mantém o nome histórico, não é escolhível e a finalização exige substituição.
 */

export const AVISO_FORNECEDOR_INATIVO = "Fornecedor inativo — selecione outro antes de finalizar";

/** Nome do fornecedor da linha; o histórico fica visível mas assinalado quando está inativo. */
export function rotuloFornecedorLinha(l: {
  fornecedorSugeridoNome: string | null;
  fornecedorSugeridoInativo?: boolean;
}): string | null {
  if (!l.fornecedorSugeridoNome) return null;
  return l.fornecedorSugeridoInativo ? `${l.fornecedorSugeridoNome} (inativo)` : l.fornecedorSugeridoNome;
}

/** Aviso sob o picker: fornecedor inativo a substituir, ou habitual inativo que a proposta não usou. */
export function AvisoFornecedorLinha({
  fornecedorSugeridoId,
  fornecedorSugeridoInativo,
  habitualInativoNome,
}: {
  fornecedorSugeridoId: string | null;
  fornecedorSugeridoInativo?: boolean;
  habitualInativoNome?: string | null;
}) {
  if (fornecedorSugeridoId && fornecedorSugeridoInativo) {
    return (
      <div data-testid="fornecedor-inativo-aviso" className="mt-0.5 text-[10px] font-medium text-rose-600">
        {AVISO_FORNECEDOR_INATIVO}
      </div>
    );
  }
  if (!fornecedorSugeridoId && habitualInativoNome) {
    return (
      <div data-testid="habitual-inativo-aviso" className="mt-0.5 text-[10px] font-medium text-amber-700">
        Habitual inativo: {habitualInativoNome} — escolha outro
      </div>
    );
  }
  return null;
}

/** Classe de realce da linha cujo fornecedor está inativo (ou que a finalização apontou). */
export const CLASSE_LINHA_FORNECEDOR_INATIVO = "bg-rose-50/60";
