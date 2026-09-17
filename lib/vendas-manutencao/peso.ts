/**
 * lib/vendas-manutencao/peso.ts
 *
 * Peso histórico de cada farmácia nas vendas de um artigo — a base da
 * distribuição automática por farmácia (secção 1.2 do pedido).
 *
 * ── Janela: 12 meses completos, fixa na criação ──────────────────────
 *
 * "12 meses completos anteriores ao mês de referência da manutenção,
 * nunca uma janela que possa variar posteriormente" — a janela é
 * calculada a partir do PRÓPRIO mês inicial da manutenção
 * (`VendaManutencao.mesInicialAno/mesInicialMes`), nunca da data
 * corrente do servidor. Duas manutenções criadas em dias diferentes
 * para o MESMO mês inicial têm SEMPRE a mesma janela — e uma
 * manutenção já criada nunca vê a sua janela recalculada só porque o
 * tempo passou (é exactamente o que a secção 1.4 pede: "os pesos
 * históricos podem mudar no futuro e uma manutenção antiga não pode
 * alterar-se retroactivamente").
 *
 * "12 meses completos ANTERIORES" — o próprio mês de referência fica
 * de fora: o histórico do mês em que a manutenção está a começar ainda
 * pode estar incompleto no ERP.
 *
 * ── `naturezaVenda` ───────────────────────────────────────────────────
 *
 * Só "NORMAL" — vendas reais ao cliente. Exclui "CREDITO" (devoluções)
 * e "TRANSFERENCIA" (movimento interno entre farmácias, não é venda a
 * ninguém) — os dois distorceriam "onde este artigo se vende de facto"
 * exactamente pela razão oposta de cada um: uma devolução reduz um
 * total que nem devia ter contado a favor da farmácia onde a venda deu
 * problema; uma transferência interna não é comércio nenhum.
 *
 * A `VendaManutencaoCelula` nunca entra aqui — a query de peso lê
 * exclusivamente `VendaMensal` (ver lib/vendas-manutencao-data.ts),
 * nunca a tabela de manutenção. Garantia estrutural, não uma regra a
 * lembrar em cada chamada.
 *
 * Puro — sem Prisma. A leitura de `VendaMensal` vive em
 * lib/vendas-manutencao-data.ts; este módulo só sabe transformar
 * `{farmaciaId, qty}[]` já lido em pesos.
 */

import type { MesCivil } from "./distribuicao";

/** Índice linear ano×12+mês-1 — comparável e ordenável sem casos especiais de virada de ano. */
function indiceMes(ano: number, mes: number): number {
  return ano * 12 + (mes - 1);
}

function deIndiceMes(idx: number): { ano: number; mes: number } {
  return { ano: Math.floor(idx / 12), mes: (idx % 12) + 1 };
}

export type JanelaHistorica = {
  /** Ano/mês do primeiro mês da janela (inclusive). */
  inicio: { ano: number; mes: number };
  /** Ano/mês do último mês da janela (inclusive) — sempre o mês anterior ao de referência. */
  fim: { ano: number; mes: number };
};

/**
 * Os `numMeses` meses civis completos imediatamente ANTERIORES a
 * `(anoRef, mesRef)` — nunca inclui o próprio mês de referência.
 * Generaliza `janelaHistoricaDozeMeses` (que a chama com 12) para a
 * janela mais larga que a sazonalidade mensal precisa (ver
 * `calcularPesosMensais` abaixo) — o mesmo princípio determinístico,
 * só com outro comprimento.
 */
export function janelaHistoricaMeses(anoRef: number, mesRef: number, numMeses: number): JanelaHistorica {
  const idxFim = indiceMes(anoRef, mesRef) - 1;
  const idxInicio = idxFim - (numMeses - 1);
  return { inicio: deIndiceMes(idxInicio), fim: deIndiceMes(idxFim) };
}

/**
 * Os 12 meses civis completos imediatamente ANTERIORES a
 * `(anoRef, mesRef)` — nunca inclui o próprio mês de referência.
 */
export function janelaHistoricaDozeMeses(anoRef: number, mesRef: number): JanelaHistorica {
  return janelaHistoricaMeses(anoRef, mesRef, 12);
}

export type QtyPorFarmacia = { farmaciaId: string; qty: number };

export type PesoFarmacia = {
  farmaciaId: string;
  /** Fracção 0..1 do total histórico. 0 quando esta farmácia não tem histórico algum. */
  peso: number;
  /** `false` quando esta farmácia, especificamente, não vendeu nada na janela. */
  temHistorico: boolean;
};

export type ResultadoPesos = {
  pesos: PesoFarmacia[];
  /**
   * `true` quando NENHUMA farmácia do âmbito tem histórico — a regra
   * "não inventar peso" (secção 1.7) aplica-se ao conjunto inteiro, e
   * quem chama tem de oferecer distribuição manual, nunca uma proposta
   * automática às cegas.
   */
  semHistoricoNenhum: boolean;
};

/**
 * Calcula o peso de cada farmácia do âmbito a partir do histórico já
 * lido (uma linha por farmácia COM vendas na janela — uma farmácia sem
 * nenhuma linha em `historico` é, por definição, sem histórico).
 *
 * Farmácias SEM histórico ficam com peso 0 — nunca uma divisão igual
 * forçada entre elas (isso inventaria um peso que o histórico não deu).
 * O utilizador ajusta manualmente se quiser incluir uma destas.
 */
export function calcularPesosFarmacia(
  historico: readonly QtyPorFarmacia[],
  farmaciasNoAmbito: readonly string[],
): ResultadoPesos {
  const qtyPorFarmacia = new Map(historico.map((h) => [h.farmaciaId, h.qty]));
  const comHistorico = farmaciasNoAmbito.filter((f) => (qtyPorFarmacia.get(f) ?? 0) > 0);

  if (comHistorico.length === 0) {
    return {
      pesos: farmaciasNoAmbito.map((f) => ({ farmaciaId: f, peso: 0, temHistorico: false })),
      semHistoricoNenhum: true,
    };
  }

  const totalHistorico = comHistorico.reduce((s, f) => s + (qtyPorFarmacia.get(f) ?? 0), 0);
  const pesos = farmaciasNoAmbito.map((f) => {
    const qty = qtyPorFarmacia.get(f) ?? 0;
    return {
      farmaciaId: f,
      peso: qty > 0 ? qty / totalHistorico : 0,
      temHistorico: qty > 0,
    };
  });

  return { pesos, semHistoricoNenhum: false };
}

// ─── Peso mensal (sazonalidade) — a peça que faltava (secção 3 do pedido) ──
//
// O bug corrigido aqui: `distribuirPorMeses` distribuía sempre em partes
// IGUAIS entre os meses de uma farmácia — nunca respeitava a evolução
// mensal histórica do artigo. As funções abaixo calculam o peso REAL de
// cada mês-alvo a partir de `VendaMensal`, com uma hierarquia de
// fallback explícita (farmácia → global → partes iguais), em vez de
// inventar um peso quando não há amostra nenhuma.

/** Uma linha "quantidade vendida neste MÊS CIVIL (1..12)", agregada por vários anos — nunca cruzada com o ano. */
export type QtyPorMesCivil = { mes: number; qty: number };

export type PesoMes = { ano: number; mes: number; peso: number };

/** De onde veio o peso mensal efectivamente aplicado — nunca uma caixa preta (secção 4/5 do pedido). */
export type OrigemPesoMensal = "FARMACIA" | "GLOBAL" | "NEUTRO";

export type ResultadoPesosMensais = {
  pesos: PesoMes[];
  origem: OrigemPesoMensal;
};

/**
 * Nº mínimo de meses civis DISTINTOS com venda > 0, dentro da janela de
 * sazonalidade, para uma série ser considerada "amostra suficiente" e
 * revelar uma FORMA mensal — um único mês com histórico não distingue
 * sazonalidade real de coincidência; dois já mostram alguma variação.
 *
 * Não há dados de produção neste ambiente para calibrar este limiar
 * empiricamente (sandbox sem BD viva — ver a nota grande em
 * vendas-manutencao-data.ts). Fica isolado aqui, precisamente para
 * poder ser ajustado só neste sítio quando houver histórico real para
 * o validar.
 */
const MIN_MESES_DISTINTOS_PARA_PERFIL = 2;

function temAmostraSuficiente(porMes: ReadonlyMap<number, number>): boolean {
  let distintos = 0;
  for (const qty of porMes.values()) if (qty > 0) distintos++;
  return distintos >= MIN_MESES_DISTINTOS_PARA_PERFIL;
}

/** Pesos normalizados para os meses-alvo a partir de UM mapa de perfil — `null` se os meses-alvo, especificamente, não tiverem amostra nenhuma nesse mapa (mesmo que o mapa tenha amostra para OUTROS meses civis). */
function pesosApartirDoMapa(
  porMes: ReadonlyMap<number, number>,
  mesesAlvo: readonly MesCivil[],
): PesoMes[] | null {
  const brutos = mesesAlvo.map((m) => porMes.get(m.mes) ?? 0);
  const soma = brutos.reduce((s, v) => s + v, 0);
  if (soma <= 0) return null;
  return mesesAlvo.map((m, i) => ({ ano: m.ano, mes: m.mes, peso: brutos[i] / soma }));
}

/**
 * Peso de cada mês-alvo (o período da manutenção) a partir do PERFIL
 * MENSAL histórico do artigo — nunca partes iguais, salvo quando NADA
 * (nem a farmácia, nem o artigo em lado nenhum) tem um padrão mensal
 * que distinga um mês de outro.
 *
 * Hierarquia de fallback (secção 3 do pedido), aplicada nesta ordem:
 *
 *   1. Perfil da PRÓPRIA farmácia para este artigo — se tiver amostra
 *      suficiente (≥2 meses civis distintos com venda, ver
 *      `MIN_MESES_DISTINTOS_PARA_PERFIL`) E os meses-alvo,
 *      especificamente, tiverem alguma venda registada nesse perfil;
 *   2. Perfil GLOBAL do artigo (todas as farmácias do tenant) — mesmas
 *      duas condições;
 *   3. Partes iguais entre os meses-alvo — só quando nem 1 nem 2
 *      resultaram nalguma coisa (artigo genuinamente sem histórico
 *      mensal utilizável).
 *
 * `historicoFarmacia`/`historicoGlobal`: uma linha por MÊS CIVIL
 * (1..12) com venda > 0, já agregada por vários anos — nunca cruzada
 * com o ano, de propósito: é o que permite comparar "Setembro
 * histórico" com "Setembro futuro" mesmo que sejam anos diferentes
 * ("usar histórico dos MESMOS meses do ano", não só os mais recentes).
 */
export function calcularPesosMensais(
  historicoFarmacia: readonly QtyPorMesCivil[],
  historicoGlobal: readonly QtyPorMesCivil[],
  mesesAlvo: readonly MesCivil[],
): ResultadoPesosMensais {
  const mapaFarmacia = new Map(historicoFarmacia.map((h) => [h.mes, h.qty]));
  const mapaGlobal = new Map(historicoGlobal.map((h) => [h.mes, h.qty]));

  if (temAmostraSuficiente(mapaFarmacia)) {
    const pesos = pesosApartirDoMapa(mapaFarmacia, mesesAlvo);
    if (pesos) return { pesos, origem: "FARMACIA" };
  }
  if (temAmostraSuficiente(mapaGlobal)) {
    const pesos = pesosApartirDoMapa(mapaGlobal, mesesAlvo);
    if (pesos) return { pesos, origem: "GLOBAL" };
  }
  const peso = 1 / mesesAlvo.length;
  return { pesos: mesesAlvo.map((m) => ({ ano: m.ano, mes: m.mes, peso })), origem: "NEUTRO" };
}
