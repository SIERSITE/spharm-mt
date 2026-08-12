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
