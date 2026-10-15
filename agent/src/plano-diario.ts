/**
 * agent/src/plano-diario.ts
 *
 * Que dias o daily-pipeline deve processar NESTA execução, combinando:
 *   · a fonte de verdade remota (dias `OK` no SaaS — ver `catch-up.ts`);
 *   · a pista local (`pipeline-pendentes.json`), que só ACRESCENTA dias — nunca dá nenhum por feito.
 *
 * «Dia a processar»: o job das 03:00 processa o dia ANTERIOR (`ontemNaFarmacia()`, Europe/Lisbon).
 * O plano é sempre cronológico (mais antigo primeiro) e termina no «ontem» normal.
 *
 * Puro (sem rede nem relógio): recebe o que o SaaS respondeu.
 */

import { planearCatchUp, type Dia, type PlanoCatchUp } from "./catch-up.js";
import type { Pendente } from "./estado-local.js";

export type EntradaPlanoDiario = {
  ontem: Dia;
  /** `null` = o SaaS não conseguiu informar os dias concluídos. */
  diasOkNoSaas: readonly Dia[] | null;
  pendentesLocais: readonly Pendente[];
  maxDias: number;
};

export type PlanoDiario = PlanoCatchUp & {
  /** Último dia concluído (OK) que o SaaS indicou na janela consultada; `null` se nenhum / SaaS indisponível. */
  ultimoDiaConcluido: Dia | null;
  /** `true` se o plano foi calculado SEM a confirmação do SaaS. */
  semConfirmacaoDoSaas: boolean;
  /** Dias com pista local que o SaaS confirma como concluídos (a pista pode ser apagada). */
  pendentesJaConcluidos: Dia[];
  /** Dias do plano que não são o «ontem» normal (recuperação de dias em falta). */
  diasEmFalta: Dia[];
  /** Mensagem de diagnóstico para o log, já formatada (linhas). */
  diagnostico: string[];
};

export function planearDiasDoPipeline(e: EntradaPlanoDiario): PlanoDiario {
  const maxDias = Math.max(1, Math.floor(e.maxDias));
  const locais = [...new Set(e.pendentesLocais.map((p) => p.dia))].filter((d) => d <= e.ontem).sort();

  // 1) O SaaS não informou: plano conservador com a pista local + o «ontem».
  if (e.diasOkNoSaas === null) {
    const todos = [...new Set([...locais, e.ontem])].sort();
    // Excesso: processa-se do mais antigo (ordem cronológica) e adia-se o resto — nunca se descarta.
    const diasCron = todos.slice(0, maxDias);
    const adiados = todos.slice(maxDias);
    return {
      dias: diasCron,
      adiados,
      resumo:
        `O SaaS não confirmou os dias concluídos. A usar a pista local: ${diasCron.join(", ")}.` +
        (adiados.length > 0 ? ` MAIS ${adiados.length} dia(s) acima do limite de ${maxDias}: ${adiados.join(", ")}.` : ""),
      ultimoDiaConcluido: null,
      semConfirmacaoDoSaas: true,
      pendentesJaConcluidos: [],
      diasEmFalta: diasCron.filter((d) => d !== e.ontem),
      diagnostico: [
        "⚠ DIAGNÓSTICO: o SaaS não conseguiu informar o último dia concluído (rede, endpoint ou autenticação).",
        locais.length > 0
          ? `  Dias com falha registada localmente (run/pipeline-pendentes.json): ${locais.join(", ")} — serão repetidos (idempotente).`
          : "  Sem dias com falha registada localmente: processa-se apenas o dia normal.",
        "  Um dia concluído antes continuará a ser reconciliado na próxima corrida em que o SaaS responda.",
      ],
    };
  }

  // 2) SaaS informou: catch-up (conjunto de dias, não cursor) + pista local que o SaaS não dá como concluída.
  const feitos = new Set(e.diasOkNoSaas);
  const base = planearCatchUp({ ontem: e.ontem, diasOk: e.diasOkNoSaas, maxDias });
  const extra = locais.filter((d) => !feitos.has(d) && !base.dias.includes(d) && !base.adiados.includes(d));
  const juntos = [...new Set([...base.dias, ...base.adiados, ...extra])].sort();
  const dias = juntos.slice(0, maxDias);
  const adiados = juntos.slice(maxDias);
  const ultimo = [...e.diasOkNoSaas].sort().slice(-1)[0] ?? null;
  const emFalta = dias.filter((d) => d !== e.ontem);

  let resumo = base.resumo;
  if (extra.length > 0) resumo += ` (+ ${extra.length} dia(s) com falha registada localmente: ${extra.join(", ")}.)`;
  if (adiados.length > 0 && !resumo.includes("acima do limite")) {
    resumo += ` MAIS ${adiados.length} dia(s) acima do limite de ${maxDias} (${adiados[0]} → ${adiados[adiados.length - 1]}) — ficam para a próxima corrida.`;
  }

  return {
    dias,
    adiados,
    resumo,
    ultimoDiaConcluido: ultimo,
    semConfirmacaoDoSaas: false,
    pendentesJaConcluidos: locais.filter((d) => feitos.has(d)),
    diasEmFalta: emFalta,
    diagnostico: [
      `Último dia concluído confirmado pelo SaaS: ${ultimo ?? "(nenhum na janela consultada)"}.`,
      emFalta.length > 0
        ? `Dias em falta a recuperar, por ordem cronológica: ${emFalta.join(", ")} — e só depois o dia normal ${e.ontem}.`
        : `Sem dias em falta.`,
    ],
  };
}
