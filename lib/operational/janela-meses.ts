/**
 * lib/operational/janela-meses.ts
 *
 * A janela por omissão dos relatórios operacionais: os ÚLTIMOS 12 MESES
 * CIVIS COMPLETOS.
 *
 * ── Porque existe ────────────────────────────────────────────────────
 *
 * O ecrã de Excessos abria com `useState("2026-04-01")` e
 * `useState("2026-04-13")` — duas datas escritas à mão no dia em que o
 * componente foi feito. Meses depois mostravam uma janela arbitrária de
 * cinco meses que ninguém escolheu, e que envelhecia sozinha.
 *
 * ── O contrato ───────────────────────────────────────────────────────
 *
 *   início = dia 1 do mês, 12 meses antes do mês corrente
 *   fim    = último dia do mês ANTERIOR ao corrente
 *
 * O mês corrente fica de fora de propósito: está incompleto, e um mês a
 * meio puxa a média diária para baixo sem que nada tenha mudado no
 * negócio. Quem quiser incluí-lo edita as datas — continuam editáveis.
 *
 *   hoje 2026-09-03  →  2025-09-01 … 2026-08-31
 *   hoje 2027-01-15  →  2026-01-01 … 2026-12-31
 *   hoje 2027-03-01  →  2026-03-01 … 2027-02-28
 *
 * ── Fuso ─────────────────────────────────────────────────────────────
 *
 * `Europe/Lisbon`, e não o do processo nem UTC. Um servidor a correr em
 * UTC no dia 1 às 00:30 de Lisboa ainda está no dia anterior em UTC — e
 * a janela saltava um mês inteiro, uma vez por mês, de madrugada.
 *
 * As datas viajam como texto `YYYY-MM-DD` e não como `Date`: é o que a
 * UI mostra, o que a query recebe e o que o PDF imprime, sem nenhuma
 * reconversão pelo meio que possa deslocar o dia.
 */

/** Fuso funcional da aplicação. As farmácias são todas em Portugal. */
export const FUSO_APP = "Europe/Lisbon" as const;

export type JanelaMeses = {
  /** `YYYY-MM-DD` do primeiro dia. Inclusivo. */
  inicio: string;
  /** `YYYY-MM-DD` do último dia. INCLUSIVO. */
  fim: string;
};

const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;

/** O dia de hoje no fuso da aplicação, como `{ ano, mes }` (mes 1-12). */
export function mesCorrente(agora: Date = new Date()): { ano: number; mes: number; dia: number } {
  // `en-CA` dá `YYYY-MM-DD`, que é exactamente o formato que queremos —
  // e o `timeZone` faz a conversão de fuso sem aritmética nossa.
  const iso = new Intl.DateTimeFormat("en-CA", {
    timeZone: FUSO_APP,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(agora);
  const [ano, mes, dia] = iso.split("-").map((n) => Number(n));
  return { ano, mes, dia };
}

/** Último dia de um mês civil. Trata bissextos sem tabela. */
export function ultimoDiaDoMes(ano: number, mes: number): number {
  // Dia 0 do mês seguinte = último dia deste. `Date.UTC` porque só se
  // usa a aritmética de calendário, nunca a hora.
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Os últimos `meses` meses civis COMPLETOS, no fuso da aplicação.
 *
 * `agora` existe para os testes poderem fixar o dia — em produção
 * ninguém o passa.
 */
export function ultimosMesesCompletos(meses = 12, agora: Date = new Date()): JanelaMeses {
  const { ano, mes } = mesCorrente(agora);

  // Fim: último dia do mês anterior ao corrente.
  const anoFim = mes === 1 ? ano - 1 : ano;
  const mesFim = mes === 1 ? 12 : mes - 1;
  const fim = `${anoFim}-${pad(mesFim)}-${pad(ultimoDiaDoMes(anoFim, mesFim))}`;

  // Início: dia 1, `meses` meses antes do mês corrente. Em índice
  // absoluto de meses para não haver aritmética de rollover à mão.
  const absCorrente = ano * 12 + (mes - 1);
  const absInicio = absCorrente - meses;
  const anoInicio = Math.floor(absInicio / 12);
  const mesInicio = (absInicio % 12) + 1;
  const inicio = `${anoInicio}-${pad(mesInicio)}-01`;

  return { inicio, fim };
}

/**
 * A janela por omissão dos relatórios operacionais. Um sítio só.
 *
 * Excessos E Transferências. Os dois respondem a perguntas diferentes
 * sobre o MESMO stock, e uma janela diferente em cada um tornava os
 * números incomparáveis — que era o estado anterior: 12 meses num,
 * `useState("2026-04-01")` no outro.
 */
export function janelaOperacionalPorOmissao(agora: Date = new Date()): JanelaMeses {
  return ultimosMesesCompletos(12, agora);
}

/** Nome antigo, mantido para não partir chamadores. */
export function janelaExcessosPorOmissao(agora: Date = new Date()): JanelaMeses {
  return janelaOperacionalPorOmissao(agora);
}

/**
 * O último mês CIVIL COMPLETO até uma data-fim.
 *
 * "Completo" significa que a data-fim cobre o mês inteiro:
 *
 *   fim = 2026-08-31  →  Agosto conta (é o último dia do mês)
 *   fim = 2026-08-15  →  Agosto NÃO conta; o último completo é Julho
 *
 * É esta a diferença entre uma janela de meses civis e um "fim − 180
 * dias", que corta meses ao meio e faz a média mensal mentir.
 */
export function ultimoMesCompletoAte(fim: string): { ano: number; mes: number } {
  const [ano, mes, dia] = fim.split("-").map(Number);
  if (dia >= ultimoDiaDoMes(ano, mes)) return { ano, mes };
  return mes === 1 ? { ano: ano - 1, mes: 12 } : { ano, mes: mes - 1 };
}

/**
 * Os últimos `meses` meses civis completos que terminam em `fim`.
 *
 *   janelaMesesAte("2026-08-31", 6)  →  2026-03-01 … 2026-08-31
 *   janelaMesesAte("2026-08-15", 6)  →  2026-02-01 … 2026-07-31
 *
 * Existe para a coluna "Vendas 6M" dos Excessos acompanhar a data-fim
 * escolhida pelo utilizador em vez de estar presa ao dia de hoje.
 */
export function janelaMesesAte(fim: string, meses = 6): JanelaMeses {
  const alvo = ehDataValida(fim) ? fim : janelaOperacionalPorOmissao().fim;
  const { ano, mes } = ultimoMesCompletoAte(alvo);

  const fimIso = `${ano}-${pad(mes)}-${pad(ultimoDiaDoMes(ano, mes))}`;

  // Índice absoluto para não haver aritmética de rollover à mão.
  const abs = ano * 12 + (mes - 1) - (meses - 1);
  const anoInicio = Math.floor(abs / 12);
  const mesInicio = (abs % 12) + 1;

  return { inicio: `${anoInicio}-${pad(mesInicio)}-01`, fim: fimIso };
}

/** Nº de meses civis de uma janela. Denominador da média mensal. */
export function mesesDaJanela(j: JanelaMeses): number {
  const [aI, mI] = j.inicio.split("-").map(Number);
  const [aF, mF] = j.fim.split("-").map(Number);
  const n = aF * 12 + mF - (aI * 12 + mI) + 1;
  return n > 0 ? n : 1;
}

/**
 * Converte a janela em índices absolutos de mês (`ano*12 + mes`), que é
 * como `VendaMensal` é consultada.
 *
 * `fimExclusivo` é o índice do mês SEGUINTE ao último, para a query
 * poder usar `< fimExclusivo` — meio-aberto, como todo o resto do
 * projecto.
 */
export function janelaParaIndicesMensais(j: JanelaMeses): {
  inicioIndice: number;
  fimExclusivo: number;
} {
  const [aI, mI] = j.inicio.split("-").map(Number);
  const [aF, mF] = j.fim.split("-").map(Number);
  return {
    inicioIndice: aI * 12 + mI,
    fimExclusivo: aF * 12 + mF + 1,
  };
}

/**
 * Dias da janela, inclusivos nas duas pontas.
 *
 * É o denominador da média diária. Usar 90 fixo quando a janela tem 365
 * dias multiplicava o consumo por quatro — e a cobertura, que é
 * `stock / consumo`, ficava quatro vezes menor.
 */
export function diasDaJanela(j: JanelaMeses): number {
  const emUtc = (iso: string) =>
    Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
  const dias = Math.round((emUtc(j.fim) - emUtc(j.inicio)) / 86_400_000) + 1;
  return dias > 0 ? dias : 1;
}

/** `true` se a string é uma data `YYYY-MM-DD` plausível. */
export function ehDataValida(v: string | undefined | null): v is string {
  if (typeof v !== "string" || !DATA_RE.test(v)) return false;
  const [a, m, d] = v.split("-").map(Number);
  if (m < 1 || m > 12) return false;
  return d >= 1 && d <= ultimoDiaDoMes(a, m);
}

/**
 * Normaliza uma janela vinda da UI. Datas inválidas ou invertidas caem
 * para o default — a alternativa era o relatório calcular sobre uma
 * janela vazia e devolver zeros sem dizer porquê.
 */
export function normalizarJanela(
  inicio: string | undefined | null,
  fim: string | undefined | null,
  agora: Date = new Date(),
): JanelaMeses {
  if (!ehDataValida(inicio) || !ehDataValida(fim)) return janelaOperacionalPorOmissao(agora);
  if (inicio > fim) return janelaOperacionalPorOmissao(agora);
  return { inicio, fim };
}
