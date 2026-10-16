/**
 * agent/src/guarda-escrita.ts
 *
 * Ponto ÚNICO de verificação «ainda sou o dono do lock?» antes de qualquer ESCRITA no SaaS.
 *
 * O lock (`lock-pipeline.ts`) instala aqui uma função que confirma, lendo o ficheiro, que o `runId` do lock continua a ser o
 * desta execução. O cliente HTTP chama-a antes de CADA pedido de escrita (e de cada retentativa): uma execução que perdeu o
 * lock — por ter sido reclamada com `--force`, apagada por um operador, ou por qualquer outra razão — **aborta antes da
 * próxima escrita** em vez de continuar em paralelo com a nova dona. Os subprocessos herdam a mesma verificação (comparam
 * com o `runId` herdado).
 */

/** Esta execução já não é a dona do lock: não pode continuar a escrever. Nunca é retentável. */
export class ErroLockPerdido extends Error {
  /** Para os classificadores de falhas: nunca é transitório. */
  public readonly transitoria = false;
  public readonly lockPerdido = true;
  constructor(message: string) {
    super(message);
    this.name = "ErroLockPerdido";
  }
}

let guarda: (() => void) | null = null;

/** Instalada pelo lock quando a execução se torna dona (ou herdeira) do lock; `null` remove-a. */
export function instalarGuardaEscrita(fn: (() => void) | null): void {
  guarda = fn;
}

/** Lança `ErroLockPerdido` se esta execução já não é a dona do lock. Sem lock instalado (dry-runs, `--plan`): não faz nada. */
export function verificarGuardaEscrita(): void {
  guarda?.();
}
