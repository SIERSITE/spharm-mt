/**
 * lib/compras/qualidade.ts
 *
 * Classificação de qualidade de um documento de compra.
 *
 * PORQUE EXISTE
 *
 * Em 804 de 13 642 recepções da Silveirense, a soma das linhas não bate
 * com o total do documento. A investigação no ERP (agent rev56,
 * `compras-dry-run --rec-deep`) provou que em documentos como o 58865 e
 * o 64250 as linhas em falta **não existem em lado nenhum**: nem em
 * tabelas de anuladas, nem noutro detalhe. O `Recepcao_IVAS_Forn`
 * preserva o valor financeiro, mas não recupera produto nem quantidade.
 *
 * Ou seja: o ERP conserva quanto se pagou, e já não conserva por quê.
 *
 * A REGRA QUE GOVERNA TUDO ISTO
 *
 * Nunca ratear o total do documento pelas linhas sobreviventes. No
 * 58865, dividir 46,13 € pela quantidade que restou atribuiria a
 * produtos conhecidos o custo de produtos que desapareceram — e esse
 * número entraria depois no `ultimoPrecoCompra`, que é o que a
 * plataforma mostra como custo de compra.
 *
 * A classificação vive ao nível do DOCUMENTO, `(farmaciaId,
 * externalReceptionId)`. Não pode viver em `Compra`, que é agregado por
 * produto-dia e pode juntar vários documentos: um total documental
 * atribuído a uma linha de produto seria rateio com outro nome.
 */

/** Classes de qualidade. String e não enum: o domínio ainda está a ser aprendido. */
export const QUALIDADE = {
  /** As linhas explicam o valor financeiro. Pode alimentar custo por produto. */
  RECONCILIADA: "RECONCILIADA",
  /** Há valor financeiro credível, mas as linhas já não o explicam. */
  DETALHE_INCOMPLETO: "DETALHE_INCOMPLETO",
  /** Movimento sem valor financeiro (ex.: transferência). Não é uma compra. */
  NAO_FINANCEIRO: "NAO_FINANCEIRO",
  /** Documento sem linhas. Não há nada a explicar nem a usar. */
  SEM_LINHAS: "SEM_LINHAS",
} as const;

export type Qualidade = (typeof QUALIDADE)[keyof typeof QUALIDADE];

/**
 * Tolerância absoluta, em euros. Cobre arredondamento ao cêntimo.
 */
export const TOLERANCIA_ABS_EUR = 0.02;

/**
 * Tolerância relativa. Num documento de 20 000 €, um cêntimo por milhar
 * é arredondamento e não defeito; só a tolerância absoluta marcaria
 * documentos grandes como incompletos sem razão.
 */
export const TOLERANCIA_REL = 0.001;

export type EntradaClassificacao = {
  /** `Recepcao.[Total Incidencia_EUR]` — o valor financeiro do documento. */
  totalDocumentoEur: number;
  /** Σ(quantidade × valorEurUnit) das linhas que existem. */
  valorExplicadoEur: number;
  nLinhas: number;
};

/** Limiar aplicável a um documento deste tamanho. */
export function tolerancia(totalDocumentoEur: number): number {
  return Math.max(TOLERANCIA_ABS_EUR, Math.abs(totalDocumentoEur) * TOLERANCIA_REL);
}

/**
 * Classifica um documento.
 *
 * A decisão é sobre VALORES, não sobre o tipo documental. O tipo 38
 * ("G/Transferência") tem total zero nos casos observados, mas
 * classificar por tipo seria assumir que todos os 38 são assim — e a
 * evidência que temos é sobre alguns, não sobre a classe. O tipo entra
 * nos relatórios para se ver a correlação; nunca na decisão.
 */
export function classificarDocumento(e: EntradaClassificacao): Qualidade {
  if (e.nLinhas === 0) return QUALIDADE.SEM_LINHAS;

  // Sem valor financeiro mas com linhas: movimento de mercadoria, não
  // compra. Alimentar custo com isto daria custo zero a produtos reais.
  if (e.totalDocumentoEur === 0) return QUALIDADE.NAO_FINANCEIRO;

  const delta = Math.abs(e.valorExplicadoEur - e.totalDocumentoEur);
  return delta <= tolerancia(e.totalDocumentoEur)
    ? QUALIDADE.RECONCILIADA
    : QUALIDADE.DETALHE_INCOMPLETO;
}

/** Só esta classe pode derivar custo unitário por produto. */
export function podeAlimentarCusto(q: Qualidade | string | null): boolean {
  return q === QUALIDADE.RECONCILIADA;
}
