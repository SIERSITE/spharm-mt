/**
 * lib/reporting/estado-inicial-movimento.ts
 *
 * Fonte ÚNICA do estado inicial dos interruptores de movimento do painel de
 * filtros partilhado por Vendas e pela Manutenção em massa.
 *
 * O estado inicial (ao abrir o ecrã) e o estado a que «Limpar filtros» repõe são
 * o MESMO objecto — antes, Vendas abria com `apenasComStock: true` mas «Limpar»
 * repunha `false`, e a Manutenção tinha uma cópia própria. Qualquer ecrã que use o
 * painel deve ler estes valores e nunca escrever literais.
 */
import { DEFAULT_INCLUIR_CREDITO, DEFAULT_INCLUIR_TRANSFERENCIAS } from "./natureza-venda";

export const ESTADO_INICIAL_MOVIMENTO = {
  incluirCredito: DEFAULT_INCLUIR_CREDITO,
  incluirTransferencias: DEFAULT_INCLUIR_TRANSFERENCIAS,
  /**
   * Ligado por defeito (2026-09): produtos sem vendas mas com stock não devem
   * depender de o utilizador se lembrar de os incluir. Alarga o universo (união
   * com o stock actual), não é um filtro restritivo.
   */
  apenasComStock: true,
  incluirManutencao: false,
} as const;

export type EstadoMovimento = {
  incluirCredito: boolean;
  incluirTransferencias: boolean;
  apenasComStock: boolean;
  incluirManutencao: boolean;
};
