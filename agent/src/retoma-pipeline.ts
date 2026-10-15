/**
 * agent/src/retoma-pipeline.ts
 *
 * Retoma de NÍVEL SUPERIOR do pipeline diário.
 *
 * As retentativas por pedido HTTP (`politica-retry.ts`) cobrem falhas de segundos/minutos. Quando
 * uma falha TRANSITÓRIA as esgota (SaaS ou ligação em baixo durante ~2 minutos), o dia não deve
 * ficar para amanhã: o próprio agent espera ~15 minutos e repete o dia, até 4 tentativas no total
 * (1 + 3 retomas). Não depende do `RestartOnFailure` do Agendador do Windows — o incidente de
 * 15/10/2026 provou que não é fiável (o retorno 1 não gerou nenhuma das reexecuções às 03:15/30/45).
 *
 * Regras:
 *   · só falhas TRANSITÓRIAS retomam; uma falha permanente (validação, gates 409, configuração) pára
 *     logo — repetir daria o mesmo resultado, só mais tarde;
 *   · o dia de referência é o ORIGINAL (nunca recalculado);
 *   · os passos já confirmados na mesma execução ficam em checkpoint e não se repetem; sem
 *     checkpoint repete-se de forma idempotente;
 *   · o processo permanece vivo durante a espera, MAS o estado fica gravado (pendente) antes de
 *     dormir: se o computador ou o processo reiniciar, o catch-up recupera o dia na corrida seguinte.
 */

import type { EstadoPipeline } from "./estado-local.js";

export type ResultadoTentativa = {
  /** Código de saída do dia (0 = OK). */
  rc: number;
  status: EstadoPipeline;
  /** A falha foi transitória (esgotadas as retentativas HTTP, ou subprocesso saiu com EXIT_TRANSITORIO)? */
  transitoria: boolean;
  erro?: string;
  /** Passo que falhou (daily-sync, aggregate-month, …), sem dados de negócio. */
  passoFalhado?: string;
};

export type InfoTentativa = { tentativa: number; total: number; ultima: boolean };

export type ParamsRetoma = {
  dia: string;
  /** Total de tentativas do pipeline (1 + retomas). Default 4. */
  totalTentativas: number;
  /** Espera entre tentativas. Default 15 min. */
  esperaMs: number;
  correr: (info: InfoTentativa) => Promise<ResultadoTentativa>;
  dormir: (ms: number) => Promise<void>;
  log: (linha: string) => void;
  /** Chamado ANTES de dormir (grava o pendente, faz flush dos logs). Se lançar, é ignorado. */
  antesDeEsperar?: (r: ResultadoTentativa, info: InfoTentativa, retomaEm: Date) => void | Promise<void>;
  agora?: () => Date;
};

export type DesfechoDia =
  | "CONCLUIDO_A_PRIMEIRA"
  | "CONCLUIDO_APOS_RETENTATIVA_HTTP"
  | "CONCLUIDO_APOS_RETOMA"
  | "RECUPERADO_DIA_EM_FALTA"
  | "FALHA_DEFINITIVA";

export type ResultadoRetoma = {
  final: ResultadoTentativa;
  tentativas: number;
  /** `true` se houve pelo menos uma retoma de nível superior. */
  retomado: boolean;
};

export async function correrComRetoma(p: ParamsRetoma): Promise<ResultadoRetoma> {
  const total = Math.max(1, Math.floor(p.totalTentativas));
  const agora = p.agora ?? (() => new Date());
  let ultimo: ResultadoTentativa | null = null;
  for (let tentativa = 1; tentativa <= total; tentativa++) {
    const info: InfoTentativa = { tentativa, total, ultima: tentativa === total };
    p.log(`▶ Pipeline ${p.dia} — tentativa ${tentativa}/${total}`);
    let r: ResultadoTentativa;
    try {
      r = await p.correr(info);
    } catch (err) {
      // `correr` não devia lançar (devolve o resultado); se lançar, não é transitório por definição.
      r = { rc: 1, status: "ERROR", transitoria: false, erro: err instanceof Error ? err.message : String(err) };
    }
    ultimo = r;
    if (r.status === "OK" && r.rc === 0) return { final: r, tentativas: tentativa, retomado: tentativa > 1 };
    if (!r.transitoria) {
      p.log(`✗ Pipeline ${p.dia} falhou (${r.status}, causa permanente ou de negócio) — não se repete dentro da execução; o catch-up volta a propô-lo.`);
      return { final: r, tentativas: tentativa, retomado: tentativa > 1 };
    }
    if (info.ultima) {
      p.log(`✗ Pipeline ${p.dia}: falha transitória persistente após ${total}/${total} tentativas — FALHA DEFINITIVA desta execução (o catch-up volta a propô-lo).`);
      return { final: r, tentativas: tentativa, retomado: tentativa > 1 };
    }
    const retomaEm = new Date(agora().getTime() + p.esperaMs);
    p.log(
      `⚠ Pipeline ${p.dia}: falha transitória na tentativa ${tentativa}/${total}` +
        `${r.passoFalhado ? ` (passo ${r.passoFalhado})` : ""}${r.erro ? `: ${r.erro.slice(0, 200)}` : ""}. ` +
        `Próxima tentativa (${tentativa + 1}/${total}) às ${retomaEm.toISOString()} (${Math.round(p.esperaMs / 60_000)} min). ` +
        `Se o computador reiniciar entretanto, o dia é recuperado pelo catch-up.`,
    );
    try {
      await p.antesDeEsperar?.(r, info, retomaEm);
    } catch {
      /* gravar estado nunca impede a retoma */
    }
    await p.dormir(p.esperaMs);
  }
  return { final: ultimo!, tentativas: total, retomado: total > 1 };
}

/** Rótulo do desfecho para o resumo final. */
export function classificarDesfecho(d: {
  status: EstadoPipeline;
  tentativas: number;
  /** Pedidos HTTP que só tiveram sucesso depois de retentativas (deste dia). */
  pedidosRecuperadosHttp: number;
  /** O dia não era o «ontem» normal: foi recuperado pelo catch-up. */
  diaEmFalta: boolean;
}): DesfechoDia {
  if (d.status !== "OK") return "FALHA_DEFINITIVA";
  if (d.diaEmFalta) return "RECUPERADO_DIA_EM_FALTA";
  if (d.tentativas > 1) return "CONCLUIDO_APOS_RETOMA";
  if (d.pedidosRecuperadosHttp > 0) return "CONCLUIDO_APOS_RETENTATIVA_HTTP";
  return "CONCLUIDO_A_PRIMEIRA";
}

export const ROTULO_DESFECHO: Record<DesfechoDia, string> = {
  CONCLUIDO_A_PRIMEIRA: "concluído à primeira",
  CONCLUIDO_APOS_RETENTATIVA_HTTP: "concluído após retentativa HTTP",
  CONCLUIDO_APOS_RETOMA: "concluído após retoma do pipeline",
  RECUPERADO_DIA_EM_FALTA: "recuperado como dia em falta",
  FALHA_DEFINITIVA: "falha definitiva",
};
