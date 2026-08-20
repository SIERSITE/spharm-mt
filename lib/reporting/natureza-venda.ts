/**
 * lib/reporting/natureza-venda.ts
 *
 * Que naturezas de venda entram no mapa, dados os dois interruptores.
 *
 * ── PORQUE EXISTE UM MÓDULO PARA ISTO ────────────────────────────────
 *
 * Porque a lista tem de ser *a mesma* nos dois caminhos do loader — a
 * parte mês-inteiro que lê `VendaMensal` e a parte parcial que lê
 * `IngestVendaLinhaRaw`. Se divergirem, um relatório que atravessa o
 * início de um mês soma populações diferentes de cada lado da fronteira
 * e o total fica errado exactamente nos períodos que ninguém verifica à
 * mão.
 *
 * ── OS DEFAULTS NÃO SÃO ARBITRÁRIOS ──────────────────────────────────
 *
 * São a configuração do relatório oficial do SPharm contra o qual estamos
 * a reconciliar: crédito = Sim, transferências = Não. Silveirense 2026:
 *
 *     mes    credito ON / transf OFF    credito ON / transf ON
 *     Jan            13 270                     16 498
 *     Jul            14 120                     18 737
 *
 * Um default errado aqui não dá erro nenhum — dá um mapa que não bate com
 * o do balcão, e a conversa seguinte é sobre confiança no produto.
 */

export const NATUREZAS = ["NORMAL", "CREDITO", "TRANSFERENCIA"] as const;
export type NaturezaVenda = (typeof NATUREZAS)[number];

export type OpcoesNatureza = {
  incluirCredito?: boolean;
  incluirTransferencias?: boolean;
};

/** Os defaults do relatório oficial. */
export const DEFAULT_INCLUIR_CREDITO = true;
export const DEFAULT_INCLUIR_TRANSFERENCIAS = false;

/**
 * A lista de naturezas a incluir.
 *
 * `NORMAL` está sempre lá: é a venda de balcão, e um mapa de vendas sem
 * ela não é um mapa de vendas. Só os dois extras é que se alternam.
 */
export function naturezasIncluidas(o: OpcoesNatureza): NaturezaVenda[] {
  const lista: NaturezaVenda[] = ["NORMAL"];
  if (o.incluirCredito ?? DEFAULT_INCLUIR_CREDITO) lista.push("CREDITO");
  if (o.incluirTransferencias ?? DEFAULT_INCLUIR_TRANSFERENCIAS) lista.push("TRANSFERENCIA");
  return lista;
}

/** Rótulo curto do modo, para o cabeçalho do relatório. */
export function rotuloNaturezas(o: OpcoesNatureza): string {
  const credito = (o.incluirCredito ?? DEFAULT_INCLUIR_CREDITO) ? "com" : "sem";
  const transf = (o.incluirTransferencias ?? DEFAULT_INCLUIR_TRANSFERENCIAS) ? "com" : "sem";
  return `${credito} crédito, ${transf} transferências`;
}
