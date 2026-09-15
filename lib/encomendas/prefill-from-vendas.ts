/**
 * lib/encomendas/prefill-from-vendas.ts
 *
 * "Criar encomenda com estes produtos" — a ponte entre o Relatório de
 * Vendas e o motor de propostas de Encomendas.
 *
 * ── O que isto é, e o que NÃO é ───────────────────────────────────────
 *
 * Vendas entrega dois ingredientes ao motor de Encomendas: o UNIVERSO
 * de produtos (os CNP das linhas que o relatório mostrou) e os
 * PARÂMETROS da chamada (farmácia/grupo, período histórico, cobertura
 * futura). Quem calcula quantidades sugeridas continua a ser sempre
 * `generateOrderProposal`/`generateGroupProposal`, chamados pela mesma
 * `generateProposalAction` que a página `/encomendas/nova` já usa.
 *
 * Este módulo não faz IO, não conhece React nem Prisma — só constrói e
 * valida o payload que viaja em `sessionStorage`. É por isso que é
 * testável com dois arrays, sem BD e sem DOM.
 *
 * ── Formato do prefill (v2) ────────────────────────────────────────────
 *
 * Substitui por completo o formato anterior, que guardava
 * `{ farmaciaNome, lines: [{cnp, quantidade}] }` com QUANTIDADES JÁ
 * CALCULADAS — Vendas não tem, e não deve ter, lógica própria para
 * calcular sugestões. O único consumidor desse formato antigo era
 * `components/encomendas/encomendas-client.tsx`, código morto sem rota
 * (confirmado antes desta alteração); não há compatibilidade a manter.
 *
 * O novo formato é, campo a campo, o que `GenerateProposalInput`
 * (`app/encomendas/nova/actions.ts`) já aceita — para
 * `OrderCreateClient` não ter de transformar nada no meio, só chamar
 * `generateProposalAction(payload)` assim que a página carrega.
 */

import type { ProposalMode } from "@/app/encomendas/nova/actions";
import type { ProposalBaseRule } from "@/lib/encomendas/proposal";

/** Chave partilhada do `sessionStorage`. Um só sítio a escrever, um só a ler. */
export const ENCOMENDA_PREFILL_STORAGE_KEY = "encomenda-prefill";

/**
 * Versão do formato. Existe para o `OrderCreateClient` poder recusar,
 * de forma explícita, um valor antigo ou corrompido em vez de tentar
 * adivinhar-lhe a forma.
 */
export const ENCOMENDA_PREFILL_VERSION = 2 as const;

export type EncomendaPrefillPayload = {
  version: typeof ENCOMENDA_PREFILL_VERSION;
  /**
   * Vendas só produz "farmacia" ou "grupo" — nunca "consolidacao", que
   * é uma vista de negociação de volume sem equivalente em Vendas.
   */
  mode: Extract<ProposalMode, "farmacia" | "grupo">;
  /** Obrigatório quando `mode === "farmacia"`; ignorado em "grupo". */
  farmaciaId?: string;
  /** Universo FECHADO de produtos — exactamente os CNP do relatório. */
  cnps: number[];
  /** Período HISTÓRICO (o do relatório de Vendas), não o de cobertura. */
  startDate: string;
  endDate: string;
  /** Cobertura FUTURA pedida ao gerar a encomenda — independente do período acima. */
  targetCoverageDays: number;
  baseRule: ProposalBaseRule;
  considerStock: boolean;
};

/** O mínimo que este módulo precisa de saber sobre uma farmácia. */
export type FarmaciaRef = { id: string; nome: string };

export type VendasParaEncomendaInput = {
  ambito: "farmacia" | "grupo" | "comparativo";
  /** Nomes seleccionados em Vendas. Vazio ou tudo = "todas". */
  farmaciasSelecionadas: string[];
  /** Universo de farmácias activas, para mapear nome → id e saber o total. */
  farmaciasDisponiveis: FarmaciaRef[];
  /** `SalesReportRow.codigo` das linhas do relatório — string ou já numérico. */
  codigos: Array<string | number>;
  /** Período histórico — vem do relatório de Vendas, não se pede de novo. */
  dataInicio: string;
  dataFim: string;
  /** Dias de cobertura futura pedidos no modal. */
  targetCoverageDays: number;
  /** Vendas não expõe estes dois — o motor usa os defaults de sempre. */
  baseRule?: ProposalBaseRule;
  considerStock?: boolean;
};

export type VendasParaEncomendaResult =
  | { ok: true; payload: EncomendaPrefillPayload }
  | { ok: false; error: string };

/**
 * Decide "farmacia" vs "grupo" a partir da selecção de Vendas.
 *
 *   · `ambito === "grupo"` → sempre grupo.
 *   · mais de uma farmácia envolvida (seleccionadas, ou nenhuma
 *     seleccionada — que em Vendas significa "todas") → grupo.
 *   · caso contrário → farmácia.
 *
 * "comparativo" não tem ramo próprio: por construção compara várias
 * farmácias, portanto cai em "grupo" pela contagem — a menos que o
 * utilizador tenha estreitado a selecção a uma só, caso em que uma
 * proposta de farmácia única é exactamente a resposta certa.
 *
 * Pura e exportada à parte para a UI poder decidir se desactiva o
 * botão SEM montar o payload inteiro.
 */
export function modoEncomendaParaVendas(
  ambito: VendasParaEncomendaInput["ambito"],
  numFarmaciasSelecionadas: number,
  totalFarmaciasAtivas: number,
): Extract<ProposalMode, "farmacia" | "grupo"> {
  const efetivas =
    numFarmaciasSelecionadas === 0 || numFarmaciasSelecionadas >= totalFarmaciasAtivas
      ? totalFarmaciasAtivas
      : numFarmaciasSelecionadas;
  return ambito === "grupo" || efetivas > 1 ? "grupo" : "farmacia";
}

/**
 * Constrói o payload de prefill a partir do estado (simulado ou real)
 * do Relatório de Vendas.
 *
 * Não decide permissões — devolve o `mode` que a selecção implica, e
 * quem chama (a UI, que sabe o perfil da sessão) decide se bloqueia
 * antes de sequer abrir o modal, ou trata o `ok:false` do lado do
 * `OrderCreateClient` como rede de segurança.
 */
export function buildEncomendaPrefillFromVendas(
  input: VendasParaEncomendaInput,
): VendasParaEncomendaResult {
  const cnps = [
    ...new Set(
      input.codigos
        .map((c) => Number(c))
        .filter((n) => Number.isFinite(n) && n > 0),
    ),
  ];
  if (cnps.length === 0) {
    return { ok: false, error: "Sem produtos no relatório actual." };
  }

  if (!Number.isFinite(input.targetCoverageDays) || input.targetCoverageDays < 1) {
    return { ok: false, error: "A cobertura pedida tem de ser pelo menos 1 dia." };
  }

  if (!input.dataInicio || !input.dataFim) {
    return { ok: false, error: "Período do relatório em falta." };
  }

  const totalFarmacias = input.farmaciasDisponiveis.length;
  const mode = modoEncomendaParaVendas(
    input.ambito,
    input.farmaciasSelecionadas.length,
    totalFarmacias,
  );

  let farmaciaId: string | undefined;
  if (mode === "farmacia") {
    const nome =
      input.farmaciasSelecionadas[0] ??
      (totalFarmacias === 1 ? input.farmaciasDisponiveis[0]?.nome : undefined);
    const encontrada = nome
      ? input.farmaciasDisponiveis.find((f) => f.nome === nome)
      : undefined;
    if (!encontrada) {
      return { ok: false, error: "Não foi possível identificar a farmácia seleccionada." };
    }
    farmaciaId = encontrada.id;
  }

  return {
    ok: true,
    payload: {
      version: ENCOMENDA_PREFILL_VERSION,
      mode,
      farmaciaId,
      cnps,
      startDate: input.dataInicio,
      endDate: input.dataFim,
      targetCoverageDays: Math.max(1, Math.floor(input.targetCoverageDays)),
      baseRule: input.baseRule ?? "coverage",
      considerStock: input.considerStock ?? true,
    },
  };
}

/**
 * Valida e normaliza o que veio do `sessionStorage`, do lado de
 * `OrderCreateClient`. `unknown` de propósito — é JSON.parse de texto
 * escrito por outra página, noutro momento; nada garante a forma.
 *
 * `null` para qualquer coisa que não seja EXACTAMENTE este contrato —
 * sem tentativa de adivinhar ou de migrar um formato antigo. É o
 * mesmo espírito de `temListaCodigos`: presença e forma explícitas,
 * nunca inferidas.
 */
export function parseEncomendaPrefillPayload(value: unknown): EncomendaPrefillPayload | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;

  if (v.version !== ENCOMENDA_PREFILL_VERSION) return null;
  if (v.mode !== "farmacia" && v.mode !== "grupo") return null;

  if (!Array.isArray(v.cnps)) return null;
  const cnps = v.cnps.filter(
    (n): n is number => typeof n === "number" && Number.isFinite(n) && n > 0,
  );
  if (cnps.length === 0) return null;

  if (typeof v.startDate !== "string" || !v.startDate) return null;
  if (typeof v.endDate !== "string" || !v.endDate) return null;

  if (
    typeof v.targetCoverageDays !== "number" ||
    !Number.isFinite(v.targetCoverageDays) ||
    v.targetCoverageDays < 1
  ) {
    return null;
  }

  if (v.baseRule !== "coverage" && v.baseRule !== "total") return null;
  if (typeof v.considerStock !== "boolean") return null;

  if (v.mode === "farmacia" && (typeof v.farmaciaId !== "string" || !v.farmaciaId)) {
    return null;
  }

  return {
    version: ENCOMENDA_PREFILL_VERSION,
    mode: v.mode,
    farmaciaId: typeof v.farmaciaId === "string" ? v.farmaciaId : undefined,
    cnps,
    startDate: v.startDate,
    endDate: v.endDate,
    targetCoverageDays: Math.floor(v.targetCoverageDays),
    baseRule: v.baseRule,
    considerStock: v.considerStock,
  };
}
