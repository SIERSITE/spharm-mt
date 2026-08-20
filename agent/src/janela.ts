/**
 * agent/src/janela.ts
 *
 * A janela temporal da ingestão. Um sítio só, para todos os pipelines
 * históricos: vendas, compras, devoluções e movimentos.
 *
 * O DEFEITO QUE ISTO FECHA
 *
 * O mesmo `--to` significava coisas diferentes conforme o pipeline:
 *
 *   vendas      BETWEEN '<to> 00:00:00' AND '<to> 23:59:59'   → incluía o dia
 *   compras     >= from AND < to                              → excluía o dia
 *   devoluções  idem                                          → excluía o dia
 *   movimentos  idem                                          → excluía o dia
 *
 * Cada um estava internamente coerente, e por isso ninguém reparava. Uma
 * corrida com `--from 2026-08-01 --to 2026-08-11` gravava vendas de 11
 * dias e compras de 10.
 *
 * CONTRATO ÚNICO
 *
 *   >= início do primeiro dia
 *   <  início do dia SEGUINTE ao último dia pedido
 *
 * Logo `--to` é sempre inclusivo, em todos os pipelines. Meio-aberto e
 * não `BETWEEN … 23:59:59` porque o segundo perde o último segundo do
 * dia: uma venda às 23:59:59.500 fica de fora, e ninguém a procura.
 *
 * LITERAIS, NÃO OBJECTOS Date
 *
 * As fronteiras viajam como texto `YYYY-MM-DD HH:MM:SS`. Ligar um `Date`
 * do JavaScript a um `sql.DateTime` fazia a conversão depender do fuso
 * do processo e do driver — as compras usavam `new Date('<to>T00:00:00Z')`,
 * meia-noite UTC, que em Portugal no Verão é 01:00 local. A hora entre a
 * meia-noite e a uma da manhã caía do lado errado da fronteira. Um
 * literal ISO não tem essa ambiguidade: o SQL Server lê-o como a hora
 * local da base, que é onde os dados vivem.
 */

/** Fuso das farmácias. Nenhuma decisão de data usa UTC nem o fuso do PC. */
export const FUSO_FARMACIA = "Europe/Lisbon";

const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;

export type Janela = {
  /** `YYYY-MM-DD 00:00:00` do primeiro dia. Inclusivo. */
  inicio: string;
  /** `YYYY-MM-DD 00:00:00` do dia SEGUINTE ao último. Exclusivo. */
  fimExclusivo: string;
  /** Os argumentos como o operador os escreveu, para relatórios. */
  primeiroDia: string;
  ultimoDia: string;
};

function assertData(nome: string, valor: string): void {
  if (!DATA_RE.test(valor)) {
    throw new Error(`${nome} deve ser YYYY-MM-DD (recebido: ${valor}).`);
  }
  // O regex aceita 2026-13-01 e 2026-02-30, e a aritmética de datas
  // transformaria os dois em silêncio noutro dia — uma janela que não é
  // a que o operador pediu. Reconstruir e comparar é o que apanha isso.
  const [y, m, d] = valor.split("-").map((n) => parseInt(n, 10));
  const t = new Date(Date.UTC(y!, m! - 1, d!));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() + 1 !== m || t.getUTCDate() !== d) {
    throw new Error(`${nome}: ${valor} não é uma data do calendário.`);
  }
}

/** Dia seguinte, em calendário. Sem fusos: é aritmética de datas civis. */
export function diaSeguinte(dia: string): string {
  assertData("dia", dia);
  const [y, m, d] = dia.split("-").map((n) => parseInt(n, 10));
  // UTC de propósito: só serve para somar 24h a uma data civil, e usar o
  // fuso local aqui traria a mudança de hora para dentro da aritmética.
  const t = new Date(Date.UTC(y!, m! - 1, d! + 1));
  return t.toISOString().slice(0, 10);
}

/**
 * Janela meio-aberta a partir de dois dias civis, ambos inclusivos.
 *
 * `janela("2026-08-01", "2026-08-11")` cobre de 1 a 11 de Agosto, o 11
 * inteiro incluído.
 */
export function janela(primeiroDia: string, ultimoDia: string): Janela {
  assertData("--from", primeiroDia);
  assertData("--to", ultimoDia);
  if (primeiroDia > ultimoDia) {
    throw new Error(`--from (${primeiroDia}) é posterior a --to (${ultimoDia}).`);
  }
  return {
    inicio: `${primeiroDia} 00:00:00`,
    fimExclusivo: `${diaSeguinte(ultimoDia)} 00:00:00`,
    primeiroDia,
    ultimoDia,
  };
}

/** Janela de um único dia civil, para o sync diário. */
export function janelaDoDia(dia: string): Janela {
  return janela(dia, dia);
}

/**
 * O `--to` inclusivo do agent traduzido para o `to` EXCLUSIVO que os
 * endpoints de agregação esperam.
 *
 * Os dois lados usam janelas meio-abertas — `lib/aggregate/compras.ts` e
 * `lib/aggregate/devolucoes.ts` filtram `data >= from AND data < to` —
 * mas exprimem-nas de forma diferente: o agent diz o último dia
 * incluído, o endpoint quer o primeiro dia excluído. Sem esta tradução,
 * a mesma janela significa coisas diferentes conforme o lado, e falha
 * das duas maneiras:
 *
 *   · `--from D --to D` (ciclo diário) → `from == to`, janela vazia. O
 *     endpoint recusa com 400 invalid_window, e as compras do dia ficam
 *     em staging sem nunca chegarem a `Compra`. Foi o que aconteceu na
 *     Silveirense a 2026-08-12: 200 linhas paradas.
 *   · `--from A --to B` (histórico) → o dia B fica de FORA, e ninguém
 *     repara. O onboarding termina "sem erros" com o último dia da
 *     janela por agregar.
 *
 * O segundo é o pior dos dois: o primeiro grita, este não.
 *
 * Vive aqui e não no `http-client` porque é o mesmo contrato temporal
 * que `janela()` implementa — mesma regra, formato diferente. Duas
 * cópias desta aritmética acabariam por divergir.
 */
export function fimExclusivoDoDia(ultimoDiaInclusivo: string): string {
  return diaSeguinte(ultimoDiaInclusivo);
}

/**
 * Hoje na farmácia, `YYYY-MM-DD`.
 *
 * `Intl` com fuso explícito, e não `toISOString()`: em Lisboa no Verão o
 * UTC está uma hora atrás, portanto entre a meia-noite e a uma da manhã
 * o "hoje em UTC" é ainda ontem — e o "ontem" calculado a partir dele é
 * anteontem. O dia certo acabava por entrar na corrida seguinte, mas 24
 * horas atrasado.
 */
export function hojeNaFarmacia(agora: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: FUSO_FARMACIA,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(agora);
}

/** Ontem na farmácia — o último dia civil completo. */
export function ontemNaFarmacia(agora: Date = new Date()): string {
  const hoje = hojeNaFarmacia(agora);
  const [y, m, d] = hoje.split("-").map((n) => parseInt(n, 10));
  const t = new Date(Date.UTC(y!, m! - 1, d! - 1));
  return t.toISOString().slice(0, 10);
}

/**
 * O dia pedido já fechou na farmácia?
 *
 * Um histórico que inclua hoje grava um dia parcial: as vendas da tarde
 * ainda não aconteceram, e a única forma de corrigir é reenviar o dia
 * depois de fechado. Vale a pena recusar por omissão.
 */
export function diaAindaAberto(dia: string, agora: Date = new Date()): boolean {
  assertData("dia", dia);
  return dia >= hojeNaFarmacia(agora);
}

/** As opções que o guard temporal aceita da linha de comandos. */
export const OPCOES_INCLUIR_HOJE = {
  "include-today": { type: "boolean" },
  /** Nome antigo. Continua a valer — há operadores com scripts feitos. */
  "incluir-hoje": { type: "boolean" },
} as const;

/** Os dois nomes da mesma decisão, reduzidos a um booleano. */
export function leuIncluirHoje(v: Record<string, unknown>): boolean {
  return v["include-today"] === true || v["incluir-hoje"] === true;
}

export type GuardaTemporal =
  | { ok: true; aviso: string | null }
  | { ok: false; erro: string[] };

/**
 * O GUARD TEMPORAL dos comandos históricos.
 *
 * ── O QUE ELE IMPEDE ─────────────────────────────────────────────────
 *
 * Hoje ainda está aberto: a farmácia continua a vender enquanto a
 * corrida decorre. Um `--to` que inclua hoje grava um dia PARCIAL — as
 * vendas da tarde não existem ainda — e a corrida termina com sucesso,
 * com contagens plausíveis, sem nada que aponte para o buraco.
 *
 * A única forma de corrigir é reenviar o dia depois de fechar, e isso
 * depende de alguém se lembrar. É a mesma família de defeito do
 * `Fim Venda = 'S'` e do `77`: o número sai plausível e ninguém o
 * verifica. Recusar por omissão é mais barato do que descobrir.
 *
 * ── PORQUE VIVE AQUI E NÃO EM CADA COMANDO ───────────────────────────
 *
 * Porque estava em `full-sync` e em mais nenhum. `bootstrap-upload`,
 * `stocksmov-upload`, `compras`, `devolucoes-fornecedor` e
 * `acertos-stock` aceitavam `--to` hoje sem dizer nada. Um guard que
 * protege um caminho e não os outros não é um guard — é uma opinião
 * sobre qual dos caminhos é que costuma ser usado.
 *
 * `--include-today` continua a existir: quem sabe o que faz não fica
 * bloqueado, mas fica avisado.
 */
export function guardaTemporal(
  to: string,
  incluirHoje: boolean,
  agora: Date = new Date(),
): GuardaTemporal {
  if (!diaAindaAberto(to, agora)) return { ok: true, aviso: null };
  if (incluirHoje) {
    return {
      ok: true,
      aviso:
        `--include-today: ${to} ainda está aberto. As vendas de hoje ficam INCOMPLETAS ` +
        `e só ficam certas reenviando este dia depois de fechar.`,
    };
  }
  return {
    ok: false,
    erro: [
      `--to (${to}) inclui o dia de HOJE (${hojeNaFarmacia(agora)} em ${FUSO_FARMACIA}), que ainda não fechou.`,
      `  O histórico ficaria com um dia parcial, e a corrida terminaria com sucesso na mesma.`,
      `  Usa --to ${ontemNaFarmacia(agora)} (último dia completo),`,
      `  ou --include-today se sabes o que estás a fazer.`,
    ],
  };
}

/**
 * O guard, já ligado ao `console`. Devolve `true` se se pode continuar.
 *
 * Existe para que ligar o guard a um comando seja uma linha: um guard
 * que custa dez linhas por comando acaba por não estar em algum deles.
 */
export function aplicarGuardaTemporal(
  to: string,
  incluirHoje: boolean,
  agora: Date = new Date(),
): boolean {
  const g = guardaTemporal(to, incluirHoje, agora);
  if (!g.ok) {
    console.error(`✗ ${g.erro[0]}`);
    for (const l of g.erro.slice(1)) console.error(l);
    return false;
  }
  if (g.aviso) console.warn(`⚠ ${g.aviso}`);
  return true;
}
