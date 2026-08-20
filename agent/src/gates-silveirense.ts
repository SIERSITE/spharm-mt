/**
 * agent/src/gates-silveirense.ts
 *
 * Os números do relatório oficial do SPharm, escritos uma vez.
 *
 * ── PORQUE É QUE ISTO É CÓDIGO E NÃO UM EMAIL ────────────────────────
 *
 * Porque "aproximar" não é um critério. Enquanto os alvos viverem numa
 * conversa, cada corrida termina com alguém a olhar para duas colunas de
 * números e a decidir se está bom. Aqui, o dry-run compara sozinho e diz
 * PASSA ou FALHA por mês.
 *
 * Farmácia Silveirense, 2026. Relatório oficial em dois modos:
 *
 *   A) Incluir Vendas a Crédito = Sim, Guias de Transferência = Não
 *   B) Incluir Vendas a Crédito = Sim, Guias de Transferência = Sim
 *
 * O utilizador confirmou que esta farmácia NÃO emite vendas a crédito.
 * Portanto B − A é, na prática, a população de transferências — e é isso
 * que o reader de transferências tem de explicar quando existir.
 */

export type GateMes = {
  mes: number;
  /** Modo A: crédito ON, transferências OFF. */
  normalMaisCredito: number;
  /** Modo B: crédito ON, transferências ON. */
  comTransferencias: number;
  /** B − A. O que a população de transferências tem de explicar. */
  transferencias: number;
  /**
   * Unidades de TipoDoc 7 / `Fim Venda = U` — o que o gate antigo do
   * reader deixava de fora, medido directamente no ERP.
   */
  tipoDoc7EstadoU: number;
};

/**
 * Agosto está de fora dos gates de propósito: o primeiro relatório foi
 * tirado a 19/08 e o segundo não, portanto os dois lados não cobrem o
 * mesmo período. Comparar meses com janelas diferentes produz um desvio
 * que não é um defeito — e um gate que falha por construção deixa de ser
 * lido ao fim de duas corridas.
 */
export const GATES_SILVEIRENSE_2026: GateMes[] = [
  { mes: 1, normalMaisCredito: 13270, comTransferencias: 16498, transferencias: 3228, tipoDoc7EstadoU: 407 },
  { mes: 2, normalMaisCredito: 11547, comTransferencias: 13715, transferencias: 2168, tipoDoc7EstadoU: 358 },
  { mes: 3, normalMaisCredito: 13397, comTransferencias: 15157, transferencias: 1760, tipoDoc7EstadoU: 326 },
  { mes: 4, normalMaisCredito: 12652, comTransferencias: 14918, transferencias: 2266, tipoDoc7EstadoU: 302 },
  { mes: 5, normalMaisCredito: 13204, comTransferencias: 16057, transferencias: 2853, tipoDoc7EstadoU: 323 },
  { mes: 6, normalMaisCredito: 12380, comTransferencias: 15169, transferencias: 2789, tipoDoc7EstadoU: 384 },
  { mes: 7, normalMaisCredito: 14120, comTransferencias: 18737, transferencias: 4617, tipoDoc7EstadoU: 346 },
];

/**
 * O que o SPharm.MT mostrava ANTES desta correcção, para se ver o buraco
 * a fechar-se em vez de se acreditar que fechou.
 */
export const ANTES_SPHARM_MT_2026: Record<number, number> = {
  1: 12862, 2: 11189, 3: 13071, 4: 12349, 5: 12881, 6: 11996, 7: 13775,
};

/** Tolerância de um gate, em unidades. */
export const TOLERANCIA_UNIDADES = 0;

export type ResultadoGate = {
  mes: number;
  esperado: number;
  obtido: number;
  desvio: number;
  passa: boolean;
};

export function avaliarGate(mes: number, esperado: number, obtido: number): ResultadoGate {
  const desvio = obtido - esperado;
  return { mes, esperado, obtido, desvio, passa: Math.abs(desvio) <= TOLERANCIA_UNIDADES };
}

const MESES = ["", "Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];

export function nomeMes(m: number): string {
  return MESES[m] ?? String(m);
}

/** A tabela de comparação, pronta a imprimir. */
export function renderGates(titulo: string, res: ResultadoGate[]): string[] {
  const out: string[] = [];
  out.push(`  ${titulo}`);
  out.push(
    `    ${"mes".padEnd(6)}${"esperado".padStart(11)}${"obtido".padStart(11)}${"desvio".padStart(10)}   `,
  );
  for (const r of res) {
    out.push(
      `    ${nomeMes(r.mes).padEnd(6)}${String(r.esperado).padStart(11)}` +
        `${String(r.obtido).padStart(11)}${(r.desvio >= 0 ? "+" : "") + r.desvio}`.padEnd(10) +
        `   ${r.passa ? "PASSA" : "FALHA"}`,
    );
  }
  const falhas = res.filter((r) => !r.passa).length;
  out.push(`    ${res.length - falhas}/${res.length} meses batem`);
  return out;
}
