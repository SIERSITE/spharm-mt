/**
 * lib/operational/rotura.ts
 *
 * Classificação de rotura em três níveis. Pura: sem Prisma, sem I/O,
 * sem `server-only` — é consumida pelo servidor, pelo cliente e por
 * scripts do perfil `tools`.
 *
 * ── PORQUÊ TRÊS NÍVEIS ──────────────────────────────────────────────
 *
 * A regra anterior era uma só:
 *
 *     stock <= 0  E  vendas nos últimos 3 meses > 0
 *
 * e produzia 2 144 linhas na Silveirense. Dentro dessas 2 144:
 *
 *   · 48,4 % venderam UMA unidade em três meses;
 *   · 29,3 % não vendem há mais de 60 dias;
 *   · 629 têm venda num único mês dos últimos doze.
 *
 * Um alerta que inclui o artigo que vendeu 1 unidade há 80 dias ao lado
 * do que vende todas as semanas não é um alerta — é um inventário do que
 * está a zero. A separação existe para o cartão principal voltar a
 * significar "isto precisa de atenção hoje".
 *
 * ── OS DOIS RAMOS DA CRÍTICA ────────────────────────────────────────
 *
 * CRÍTICA = sem stock E vendeu há pouco E (recorrência OU volume)
 *
 * Os três limiares — quantos dias, quantos meses, quantas unidades — são
 * da POLICY DA FARMÁCIA. Os valores que motivaram esta classificação
 * (30 / 2 / 4) saíram do funil da Silveirense e são o default global,
 * mas não são uma lei da natureza.
 *
 * O primeiro ramo é a recorrência: vendeu em mais do que um mês, logo
 * não foi um acaso.
 *
 * O segundo ramo existe para o artigo NOVO. Um lançamento que vendeu 6
 * unidades em três semanas tem um único mês com venda e ficaria fora do
 * primeiro ramo — classificado como "ocasional" no preciso momento em
 * que a procura está a arrancar. É o erro que dói mais, porque é o
 * artigo que ainda se pode ganhar ou perder.
 *
 * Os dois ramos são OU, não E: são duas formas independentes de provar
 * que a procura é real.
 */
import type { PoliticaRotura } from "./policy";

// ─────────────────────────────────────────────────────────────────────
// Os limiares NÃO vivem aqui.
//
// Foram calibrados com o funil da Silveirense e não há razão para que
// sirvam uma farmácia com outra rotação. Vêm de
// `lib/operational/policy.ts:PoliticaRotura`, e o default global é o
// mesmo que sempre foi. Este ficheiro sabe COMO se classifica, não
// COM QUE NÚMEROS.
// ─────────────────────────────────────────────────────────────────────

export type NivelRotura = "CRITICA" | "OCASIONAL" | "SEM_PROCURA";

export const ROTURA_LABELS: Record<NivelRotura, string> = {
  CRITICA: "Roturas críticas",
  OCASIONAL: "Sem stock · procura ocasional",
  SEM_PROCURA: "Sem stock · sem procura recente",
};

/** O que é preciso saber de uma linha para a classificar. */
export type LinhaRotura = {
  stockAtual: number;
  dataUltimaVenda: Date | string | null;
  /** Unidades vendidas na janela de 3 meses. */
  salesQty90d: number;
  /** Meses distintos com venda na janela de 12 meses. */
  mesesComVenda12M: number;
};

/**
 * Dias desde a última venda. `null` quando não há data — que é
 * diferente de "há muito tempo" e não deve ser confundido com zero.
 */
export function diasDesdeUltimaVenda(
  d: Date | string | null,
  agora: number = Date.now(),
): number | null {
  if (!d) return null;
  const t = d instanceof Date ? d.getTime() : new Date(d).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((agora - t) / 86_400_000);
}

/** O ramo da recorrência: vendeu em meses diferentes. */
export function temRecorrencia(linha: LinhaRotura, pol: PoliticaRotura): boolean {
  return linha.mesesComVenda12M >= pol.mesesMinimos;
}

/** O ramo do volume: vendeu o suficiente para não ser acaso. */
export function temVolume(linha: LinhaRotura, pol: PoliticaRotura): boolean {
  return linha.salesQty90d >= pol.unidadesMinimas;
}

/** Vendeu há pouco tempo. Sem data ⇒ não. */
export function temRecencia(
  linha: LinhaRotura,
  pol: PoliticaRotura,
  agora: number = Date.now(),
): boolean {
  const d = diasDesdeUltimaVenda(linha.dataUltimaVenda, agora);
  return d !== null && d <= pol.recenciaDias;
}

/**
 * Classifica uma linha SEM STOCK.
 *
 * Devolve `null` para linhas com stock — não é um nível "nenhum", é a
 * ausência da pergunta. Quem chama filtra antes ou trata o `null`.
 *
 * `SEM_PROCURA` cobre dois casos que valem o mesmo operacionalmente:
 * nunca vendeu na janela de 3 meses, ou vendeu mas há muito tempo. Em
 * ambos, repor stock hoje é uma decisão de catálogo e não de ruptura.
 */
export function classificarRotura(
  linha: LinhaRotura,
  pol: PoliticaRotura,
  agora: number = Date.now(),
): NivelRotura | null {
  if (linha.stockAtual > 0) return null;

  // Sem procura na janela curta não há rotura de espécie nenhuma — é a
  // mesma fronteira que a regra antiga já usava.
  if (linha.salesQty90d <= 0) return "SEM_PROCURA";

  const dias = diasDesdeUltimaVenda(linha.dataUltimaVenda, agora);
  // Sem data, ou venda antiga: procura que já não é actual.
  if (dias === null || dias > 90) return "SEM_PROCURA";

  if (dias <= pol.recenciaDias && (temRecorrencia(linha, pol) || temVolume(linha, pol))) {
    return "CRITICA";
  }
  return "OCASIONAL";
}

/**
 * A regra ANTIGA, preservada com nome próprio.
 *
 * Continua a alimentar o filtro "Sem stock (todos)": tirar o número do
 * ecrã sem explicação gera mais desconfiança do que um número mau.
 */
export function semStockComProcura(linha: Pick<LinhaRotura, "stockAtual" | "salesQty90d">): boolean {
  return linha.stockAtual <= 0 && linha.salesQty90d > 0;
}
