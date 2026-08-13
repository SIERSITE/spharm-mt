/**
 * agent/src/catch-up.ts
 *
 * Que dias é que o pipeline diário ainda deve a esta farmácia.
 *
 * ── O defeito que isto corrige ─────────────────────────────────────
 *
 * O `daily-pipeline` processava `ontemNaFarmacia()` e mais nada. Se o
 * PC da farmácia estivesse desligado às 03:00 — corte de energia,
 * Windows Update, alguém que o desliga à sexta —, essa corrida não
 * acontecia e o dia que ela teria processado não voltava a ser
 * processado por ninguém. A corrida seguinte calculava "ontem" outra
 * vez, que já era outro dia.
 *
 * Não havia alarme. O Task Scheduler mostrava a corrida seguinte com
 * "Last Run Result: 0", o SaaS mostrava dados, e faltava um dia no meio
 * que ninguém procurava.
 *
 * ── Porque é que a fonte de verdade é remota ───────────────────────
 *
 * A tentação é guardar "último dia OK" num ficheiro local. Não serve:
 * o ficheiro vive no mesmo disco que falha, é apagado quando se
 * reinstala o agent (o procedimento de upgrade manda apagar a pasta),
 * e não sabe nada sobre o que chegou de facto ao SaaS. Um agent
 * reinstalado leria "nunca corri" e um agent que gravou o ficheiro
 * antes de o POST falhar leria "está feito" — os dois erros na
 * direcção errada.
 *
 * A verdade é o que está gravado em `PipelineRun` no SaaS: uma corrida
 * só conta como feita se o registo dela lá chegou.
 *
 * ── Porquê um CONJUNTO de dias e não um cursor ─────────────────────
 *
 * "Último dia OK" não chega. Se o dia 10 falhar e os dias 11 e 12
 * correrem bem, um cursor em 12 dá o 10 por feito e o buraco fica lá
 * para sempre. Por isso pede-se ao SaaS os dias concluídos numa janela
 * e calcula-se a diferença — buracos no meio incluídos.
 */

/** Um dia ISO `YYYY-MM-DD`. */
export type Dia = string;

export type PlanoCatchUp = {
  /** Dias a processar, do mais antigo para o mais recente. */
  dias: Dia[];
  /**
   * Dias em falta que NÃO entram nesta execução por causa do limite.
   * Nunca são esquecidos: ficam aqui para serem registados no log e
   * apanhados na corrida seguinte.
   */
  adiados: Dia[];
  /** Explicação para o operador, já formatada. */
  resumo: string;
};

/**
 * Todos os dias de `de` até `ate`, inclusive nas duas pontas.
 *
 * Aritmética em UTC de propósito: as datas aqui são civis (`YYYY-MM-DD`)
 * e não instantes. Somar 24 h em hora local partiria nos dois dias do
 * ano em que a hora muda — o dia com 23 h saltava um dia e o de 25 h
 * repetia-o.
 */
export function diasEntre(de: Dia, ate: Dia): Dia[] {
  const out: Dia[] = [];
  const fim = Date.parse(`${ate}T00:00:00Z`);
  let cur = Date.parse(`${de}T00:00:00Z`);
  if (!Number.isFinite(cur) || !Number.isFinite(fim)) return out;
  // Guarda contra um `de` absurdo (config corrompida, relógio a zero):
  // sem isto, `de = "1970-01-01"` gerava vinte mil entradas.
  let guarda = 0;
  while (cur <= fim && guarda++ < 10_000) {
    out.push(new Date(cur).toISOString().slice(0, 10));
    cur += 86_400_000;
  }
  return out;
}

/** `dia` deslocado de `n` dias (n negativo anda para trás). */
export function deslocarDia(dia: Dia, n: number): Dia {
  const t = Date.parse(`${dia}T00:00:00Z`);
  if (!Number.isFinite(t)) return dia;
  return new Date(t + n * 86_400_000).toISOString().slice(0, 10);
}

export type EntradaPlano = {
  /** Último dia fechado — normalmente `ontemNaFarmacia()`. */
  ontem: Dia;
  /** Dias que o SaaS confirma como concluídos com sucesso. */
  diasOk: readonly Dia[];
  /** Máximo de dias a processar nesta execução. */
  maxDias: number;
  /**
   * Dia mais antigo a considerar, quando se quer limitar ainda mais do
   * que o histórico. Um `chao` MAIS RECENTE do que o início do
   * histórico ganha; um mais antigo é ignorado, porque recuperar dias
   * anteriores ao primeiro registo conhecido seria inventar trabalho.
   */
  chao?: Dia;
};

/**
 * Calcula o plano. Puro: recebe o que o SaaS respondeu e devolve a
 * lista ordenada, sem tocar em relógio nem em rede.
 *
 * ── Onde começa a recuperação ──────────────────────────────────────
 *
 * No PRIMEIRO dia com registo de sucesso, não em `ontem - maxDias`.
 * A diferença não é de estilo: ancorar no limite faria uma farmácia
 * perfeitamente saudável propor todos os dias da janela que ainda não
 * têm registo — e como o registo só existe desde que o pipeline
 * começou a gravá-lo, isso é uma semana de reprocessamento todas as
 * noites, para sempre. O histórico conhecido é o que delimita o que
 * faz sentido recuperar.
 *
 * ── Quando não há histórico nenhum ─────────────────────────────────
 *
 * `diasOk` vazio significa que não houve uma corrida bem sucedida em
 * toda a janela consultada (que é larga — ver `janelaConsulta`).
 * Instalação nova, ou farmácia parada há muito. Nos dois casos a
 * decisão certa é a conservadora: corre-se só `ontem`. Uma instalação
 * nova não tem nada para recuperar, e uma farmácia parada há meses não
 * deve tentar recuperá-los às cegas numa corrida nocturna — isso é uma
 * decisão de operador, com `--date`, dia a dia.
 */
export function planearCatchUp(e: EntradaPlano): PlanoCatchUp {
  const maxDias = Math.max(1, Math.floor(e.maxDias));
  const feitos = new Set(e.diasOk);

  if (e.diasOk.length === 0) {
    return {
      dias: [e.ontem],
      adiados: [],
      resumo:
        `Sem registo de nenhuma corrida concluída na janela consultada. ` +
        `A correr apenas ${e.ontem}. Se a farmácia esteve parada mais tempo, ` +
        `recupera os dias em falta um a um com --date.`,
    };
  }

  const primeiroConhecido = [...e.diasOk].sort()[0]!;
  const inicio = e.chao && e.chao > primeiroConhecido ? e.chao : primeiroConhecido;

  // Ordem cronológica: o mais antigo primeiro. Um dia só se considera
  // fechado depois de os anteriores estarem, senão a agregação mensal
  // corre com o mês incompleto e é reescrita a seguir.
  const candidatos = diasEntre(inicio, e.ontem)
    .filter((d) => !feitos.has(d))
    .sort();

  const dias = candidatos.slice(0, maxDias);
  const adiados = candidatos.slice(maxDias);

  let resumo: string;
  if (dias.length === 0) {
    resumo = `Nada a recuperar — ${e.ontem} já está concluído.`;
  } else if (dias.length === 1 && dias[0] === e.ontem) {
    resumo = `Corrida normal: ${e.ontem}.`;
  } else {
    resumo = `${dias.length} dia(s) em falta: ${dias[0]} → ${dias[dias.length - 1]}.`;
  }
  if (adiados.length > 0) {
    resumo +=
      ` MAIS ${adiados.length} dia(s) acima do limite de ${maxDias}` +
      ` (${adiados[0]} → ${adiados[adiados.length - 1]}) — ficam para a próxima corrida.`;
  }

  return { dias, adiados, resumo };
}

/**
 * Quantos dias para trás se procura histórico.
 *
 * Não é o mesmo que `maxDias`, e a distinção importa: `maxDias` limita
 * quanto se PROCESSA por corrida, isto limita quanto se OLHA para
 * decidir. Uma janela curta de consulta faria uma farmácia parada há
 * duas semanas parecer uma instalação nova — `diasOk` vazio — e o
 * planeador escolheria o caminho conservador quando havia mesmo dias a
 * recuperar.
 */
export const DIAS_LOOKBACK = 90;

/**
 * A janela a pedir ao SaaS. Larga de propósito (ver `DIAS_LOOKBACK`),
 * e independente do limite de processamento.
 */
export function janelaConsulta(ontem: Dia, _maxDias?: number, chao?: Dia): { from: Dia; to: Dia } {
  const porLookback = deslocarDia(ontem, -(DIAS_LOOKBACK - 1));
  const from = chao && chao > porLookback ? chao : porLookback;
  return { from, to: ontem };
}
