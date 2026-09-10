/**
 * agent/src/saude-vendas.ts
 *
 * A pergunta que faltava fazer no fim do dia: "o que eu li chegou lá?"
 *
 * ── O DIA QUE ISTO IMPEDE DE VOLTAR ──────────────────────────────────
 *
 * Farmácia Principal, 2026-09-09:
 *
 *     salesRead     1200
 *     salesUpserted   83
 *     salesSkipped  1117      <- 93% do dia
 *     salesErrors      0
 *     estado          OK      <- e o pipeline deu-se por concluído
 *
 * Nada mentiu. O agente leu as 1 200 linhas, recusou 1 117 por o tipo
 * documental 77 não estar declarado, escreveu-o no log local, contou-as
 * em `salesSkipped` — e depois ninguém olhou para o número. `salesErrors`
 * era zero porque não houve erro nenhum: uma linha recusada não é um
 * erro, é uma decisão. O `dateRef` fechou como OK, o catch-up deu o dia
 * por feito e nunca mais o propôs. Repetiu-se todos os dias durante dois
 * anos e meio.
 *
 * O defeito não estava na recusa — estava em ela não ter consequência.
 *
 * ── PORQUÊ UM LIMIAR E NÃO "QUALQUER RECUSA FALHA" ───────────────────
 *
 * Porque um PARTIAL que ninguém consegue fechar é pior do que um OK
 * errado. Um dia PARTIAL volta a ser proposto pelo catch-up até fechar;
 * se bastasse UMA linha recusada para o marcar, uma linha estranha num
 * dia de 1 400 punha a farmácia a reprocessar o mesmo dia para sempre,
 * sem que reprocessar mudasse coisa alguma — o tipo continuaria por
 * declarar. Ganhava-se um alarme e perdia-se o pipeline.
 *
 * O limiar separa "há aqui um pormenor" de "este dia não é o dia". Os
 * números reais dos dois lados não deixam margem para dúvida:
 *
 *     Castelo, 6 dias      0, 0, 0, 1, 2, 0 recusas em 1 100–1 500 linhas
 *     Principal, 6 dias    756/780, 854/885, 662/701, 891/922,
 *                          1002/1051, 1117/1200   (94% a 97%)
 *
 * Entre 0,13% e 93% cabe qualquer limiar. 1% é folgado para o ruído
 * observado e apanha qualquer perda que valha a pena olhar.
 *
 * O piso absoluto existe para os dias pequenos: num sábado de 30 linhas,
 * uma recusa é 3,3% e não é notícia. Sem o piso, o limiar relativo
 * transformava cada dia curto num falso alarme — e um alarme que toca
 * por tudo deixa de ser lido, que é exactamente como se chega a um
 * `salesSkipped=1117` ao lado de um OK.
 *
 * ── PORQUÊ PARTIAL E NÃO ABORTED ─────────────────────────────────────
 *
 * Pela semântica que o `daily-pipeline` já tem:
 *
 *   · ABORTED  — a corrida não devia ter avançado (lock preso, 409 do
 *                aggregate). Não é o nosso caso: esta corrida avançou e
 *                fez trabalho bom — produtos, stock, compras e as vendas
 *                que estavam declaradas ficaram todos gravados.
 *   · ERROR    — o núcleo falhou. Também não: o núcleo leu o dia inteiro
 *                sem um único erro.
 *   · PARTIAL  — o dia NÃO está fechado e o catch-up volta a propô-lo.
 *
 * PARTIAL é o único que descreve o que aconteceu — dia incompleto, nada
 * corrompido — e é o único que se auto-corrige: no dia em que o tipo for
 * declarado, o catch-up reprocessa o dia e ele fecha sozinho, sem
 * ninguém ter de se lembrar de que ficou por fechar.
 *
 * Nada aqui escreve nem lê: recebe contagens e devolve um veredicto.
 */

/**
 * Fracção de `salesRead` acima da qual o dia deixa de poder fechar.
 *
 * 1%: uma ordem de grandeza acima do ruído medido (0,13% no pior dia
 * saudável) e duas ordens abaixo de uma perda real (93%).
 */
export const LIMIAR_SKIPPED_FRACCAO = 0.01;

/**
 * Recusas abaixo deste número nunca degradam o dia, seja qual for a
 * fracção. Protege os dias pequenos — ver a nota do topo.
 */
export const MINIMO_SKIPPED_ABSOLUTO = 10;

/** Um tipo documental que o agente não soube classificar, e onde. */
export type TipoPorClassificar = {
  sourceNamespace: string;
  /** `null` quando o próprio campo veio nulo do ERP. */
  tipoDocumento: number | null;
  linhas: number;
};

export type ContagemVendas = {
  salesRead: number;
  salesSkipped: number;
  tiposPorClassificar?: TipoPorClassificar[];
};

export type VeredictoVendas = {
  /** `false` obriga o dia a PARTIAL. */
  saudavel: boolean;
  /** Fracção recusada, 0–1. Sempre calculada, mesmo quando saudável. */
  fraccaoSkipped: number;
  /** Frase única para log e para o campo `message` do passo. */
  motivo: string;
};

/**
 * O dia pode fechar?
 *
 * Pura de propósito: a decisão que marca um dia como incompleto tem de
 * ser testável sem ERP, sem rede e sem relógio.
 */
export function avaliarSaudeVendas(c: ContagemVendas): VeredictoVendas {
  const lidas = Number.isFinite(c.salesRead) ? c.salesRead : 0;
  const recusadas = Number.isFinite(c.salesSkipped) ? c.salesSkipped : 0;
  const tipos = c.tiposPorClassificar ?? [];
  const fraccaoSkipped = lidas > 0 ? recusadas / lidas : 0;

  const resumoTipos = tipos.length
    ? ` Tipos por declarar: ${tipos
        .map((t) => `${t.sourceNamespace}:${t.tipoDocumento ?? "(nulo)"}×${t.linhas}`)
        .join(", ")}.`
    : "";

  if (recusadas === 0) {
    return { saudavel: true, fraccaoSkipped: 0, motivo: "nenhuma linha recusada" };
  }

  const pct = (fraccaoSkipped * 100).toFixed(1);

  // Abaixo do piso absoluto não se degrada o dia — mas também não se
  // finge que não aconteceu: o motivo viaja para o relatório.
  if (recusadas < MINIMO_SKIPPED_ABSOLUTO) {
    return {
      saudavel: true,
      fraccaoSkipped,
      motivo:
        `${recusadas} linha(s) recusada(s) de ${lidas} (${pct}%) — abaixo do piso de ` +
        `${MINIMO_SKIPPED_ABSOLUTO}, o dia fecha.${resumoTipos}`,
    };
  }

  if (fraccaoSkipped <= LIMIAR_SKIPPED_FRACCAO) {
    return {
      saudavel: true,
      fraccaoSkipped,
      motivo:
        `${recusadas} linha(s) recusada(s) de ${lidas} (${pct}%) — dentro do limiar de ` +
        `${(LIMIAR_SKIPPED_FRACCAO * 100).toFixed(0)}%, o dia fecha.${resumoTipos}`,
    };
  }

  return {
    saudavel: false,
    fraccaoSkipped,
    motivo:
      `vendas incompletas: ${recusadas} de ${lidas} linhas recusadas (${pct}%, limiar ` +
      `${(LIMIAR_SKIPPED_FRACCAO * 100).toFixed(0)}%).${resumoTipos}`,
  };
}
