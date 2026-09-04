/**
 * lib/operational/metrics-shared.ts
 *
 * Fórmulas operacionais canónicas (avgDaily / coverage / monthly velocity
 * / rotation / rupture risk / suggested order). Pura — sem I/O, sem
 * Prisma, sem dependências de runtime. Importável a partir do server E
 * do client.
 *
 * Substitui as 5 implementações divergentes que existiam em:
 *   - lib/encomendas-data.ts:157
 *   - lib/stock-data.ts:63
 *   - lib/transferencias-data.ts:163,283
 *   - lib/encomendas/proposal.ts:210
 * + o factor mágico ×1.08/×1.04/×1/×0.96/×0.93 que estava em
 *   components/encomendas/encomendas-client.tsx:184-189 e que deformava
 *   o número server-side antes de o mostrar ao utilizador. Esse factor
 *   foi removido nesta passagem (Fase 1, WS-A).
 *
 * Convenções:
 *   - Todas as funções são puras (input → output, sem efeitos).
 *   - Inputs não-finitos / negativos são saneados para 0 antes da
 *     divisão. Nada de NaN nem Infinity a sair daqui.
 *   - `coverageDays` devolve `null` quando não há demanda mensurável
 *     (avgDaily=0 e stock>0). NUNCA 999, NUNCA Infinity. As callers que
 *     precisam de pintar "∞" ou "999d" decidem isso na UI.
 */

/** Janela canónica para vendas agregadas de `VendaMensal`. */
export const WINDOW_90D = 90 as const;

/** Janela canónica curta (usada por callers que pedem snapshot mensal). */
export const WINDOW_30D = 30 as const;

/**
 * Threshold canónico de EXCESSO de cobertura (em dias).
 *
 * Um produto é classificado como excesso quando `coverageDays > EXCESSO_COVERAGE_DAYS`.
 *
 * 2026-06: 180 dias (semestre conservador).
 * 2026-09: **120 dias**, com o alvo a subir de 30 para 45 e o mínimo a
 * descer de 5 para 3 — ver EXCESSO_TARGET_DAYS abaixo. A medição que
 * motivou a mudança está em scripts/diagnostics/matriz-transferencias.ts.
 *
 * Substitui os 3 thresholds divergentes que existiam:
 *   - Dashboard / `stock-shared.ts` filtro "excess-stock-60d" → 60 dias
 *   - `transferencias-data.ts:getExcessosData` default → 90 dias
 *   - `inventario-data.ts:EXCESSO_DAYS` → 180 dias
 *
 * A unificação garante que o mesmo produto não pode aparecer como "EXCESSO"
 * num relatório e como "NORMAL" noutro. Qualquer caller que precise de um
 * threshold diferente passa-o explicitamente como argumento — mas o default
 * em todos os relatórios oficiais é esta constante.
 */
export const EXCESSO_COVERAGE_DAYS = 120 as const;

/**
 * Cobertura-ALVO, em dias. Faz duas coisas ao mesmo tempo, e é preciso
 * ter as duas em mente ao mexer-lhe:
 *
 *   · define quanto da origem é excedente — `(cobertura − alvo) × média`;
 *   · define até onde se enche o destino — `(alvo − cobertura) × média`.
 *
 * Subir o alvo aumenta a necessidade do destino E reduz o excesso da
 * origem. Não são separáveis sem mudar a assinatura do motor.
 */
export const EXCESSO_TARGET_DAYS = 45 as const;

/**
 * Excessos abaixo disto contam como zero.
 *
 * Nasceu como `if (excessQty < 5) continue` dentro dos Excessos. Desceu
 * para 3 em 2026-09.
 *
 * ATENÇÃO: este corte estava a mascarar um defeito — ver
 * RESERVA_ORIGEM_DIAS. Descê-lo sem a reserva alargaria o problema.
 */
export const EXCESSO_MINIMO_UNIDADES = 3 as const;

/**
 * Dias de cobertura que a ORIGEM tem de conservar depois de uma
 * transferência.
 *
 * Parece redundante com o alvo, e na aritmética exacta é:
 *
 *     stock − excesso = cobertura×média − (cobertura−alvo)×média
 *                     = alvo × média
 *
 * Na implementação NÃO é. `excesso = Math.round(...)` e, quando
 * `alvo × média <= 0,5`, o arredondamento engole a reserva inteira: o
 * excesso passa a ser o stock todo e a origem fica a ZERO. Acontece em
 * artigos de baixa rotação — stock 5 que venda 6 unidades por ano cede
 * as 5 — e o antigo corte de 5 unidades não o impedia.
 *
 * A reserva é aplicada com `Math.floor`, nunca com `round`: arredondar
 * para cima aqui seria voltar a consumir a reserva que ela existe para
 * proteger.
 *
 * Reproduzido em scripts/tests/test-seguranca-origem.ts, secção C.
 */
export const RESERVA_ORIGEM_DIAS = 30 as const;

/**
 * Sanitiza um valor numérico: NaN/Infinity/negativos → 0.
 *
 * Usado nos boundaries do módulo. Cálculos internos assumem números
 * finitos não-negativos.
 */
function toNonNegativeFinite(n: unknown): number {
  const x = Number(n);
  if (!Number.isFinite(x) || x < 0) return 0;
  return x;
}

/**
 * Média diária de vendas: salesQty / windowDays.
 *
 * Retorna 0 quando windowDays<=0 OU salesQty<=0 OU inputs não finitos.
 * Nunca devolve Infinity nem NaN.
 */
export function avgDaily(salesQty: number, windowDays: number): number {
  const qty = toNonNegativeFinite(salesQty);
  if (qty === 0) return 0;
  if (!Number.isFinite(windowDays) || windowDays <= 0) return 0;
  return qty / windowDays;
}

/**
 * Cobertura em dias: stockAtual / avgDaily.
 *
 * Semântica canónica:
 *   - stock <= 0  → 0 (já em rotura)
 *   - avgDaily<=0 → null (sem demanda mensurável; UI decide como pintar)
 *   - caso comum  → stock / avgDaily
 *
 * Resultado é sempre finito quando não-null.
 */
export function coverageDays(stockAtual: number, avgDailyValue: number): number | null {
  const stock = toNonNegativeFinite(stockAtual);
  if (stock === 0) return 0;
  const ad = toNonNegativeFinite(avgDailyValue);
  if (ad === 0) return null;
  const cov = stock / ad;
  return Number.isFinite(cov) ? cov : null;
}

/**
 * Velocidade mensal aproximada (un./mês): avgDaily × 30, arredondado a 1
 * casa decimal. Mantido em sincronia com o display antigo em
 * `lib/encomendas-data.ts`.
 */
export function monthlyVelocity(avgDailyValue: number): number {
  const ad = toNonNegativeFinite(avgDailyValue);
  return Math.round(ad * 30 * 10) / 10;
}

export type RotationClass = "alta" | "media" | "baixa" | "estagnada";

/**
 * Classificação de rotação a partir de avgDaily (mesmos thresholds que o
 * `/stock` antigo: >0.5 alta, >0.1 média, >0 baixa). "estagnada" só
 * quando NÃO houve vendas no período E o último movimento é antigo
 * (>90d).
 */
export function rotationClass(
  avgDailyValue: number,
  daysSinceLastSale: number | null,
): RotationClass {
  const ad = toNonNegativeFinite(avgDailyValue);
  if (ad > 0.5) return "alta";
  if (ad > 0.1) return "media";
  if (ad > 0) return "baixa";
  if (daysSinceLastSale !== null && daysSinceLastSale > 90) return "estagnada";
  return "baixa";
}

export type RuptureRisk = "rotura" | "baixa" | "estavel" | "excesso" | "indeterminado";

/**
 * Risco de rotura face a uma cobertura-alvo configurável.
 *
 *   - stock<=0          → "rotura"
 *   - avgDaily<=0       → "indeterminado" (não dá para projectar)
 *   - cov < target/2    → "baixa"
 *   - cov > target × 3  → "excesso"
 *   - caso comum        → "estavel"
 */
export function stockRuptureRisk(
  stockAtual: number,
  avgDailyValue: number,
  targetCoverageDays: number,
): RuptureRisk {
  const stock = toNonNegativeFinite(stockAtual);
  if (stock === 0) return "rotura";
  const ad = toNonNegativeFinite(avgDailyValue);
  if (ad === 0) return "indeterminado";
  const target = Math.max(1, toNonNegativeFinite(targetCoverageDays));
  const cov = stock / ad;
  if (cov < target / 2) return "baixa";
  if (cov > target * 3) return "excesso";
  return "estavel";
}

/**
 * Quantidade sugerida para encomenda: max(0, ceil(stockAlvo − stockAtual)).
 *
 * stockAlvo = monthlyVelocityValue × (targetCoverageDays / 30).
 *
 * Esta é a única fórmula da sugestão. Substitui o `calcularSugestao` que
 * estava em `components/encomendas/encomendas-client.tsx:91-94` e o
 * cálculo equivalente em `lib/encomendas/proposal.ts:210-222` (que
 * partilha agora a mesma matemática via este helper, embora as suas
 * inputs venham de `Venda` diária em vez de `VendaMensal`).
 */
export function suggestedOrderQty(
  stockAtual: number,
  monthlyVelocityValue: number,
  targetCoverageDays: number,
): number {
  const stock = toNonNegativeFinite(stockAtual);
  const vel = toNonNegativeFinite(monthlyVelocityValue);
  const target = Math.max(1, toNonNegativeFinite(targetCoverageDays));
  const stockAlvo = (vel / 30) * target;
  return Math.max(0, Math.ceil(stockAlvo - stock));
}

/**
 * Bundle imutável de métricas para um (produto, farmácia) num
 * windowDays. Não é a estrutura wire/DB — é o output canónico do cálculo
 * que os loaders especializados (encomendas/stock/transferências/
 * proposal) consomem ou re-derivam para o seu shape específico.
 */
export type ProductMetrics = {
  produtoId: string;
  farmaciaId: string;
  windowDays: number;
  salesQty: number;
  stockAtual: number;
  avgDaily: number;
  /** null quando avgDaily=0 (sem demanda mensurável). */
  coverageDays: number | null;
  monthlyVelocity: number;
  rotationClass: RotationClass;
  daysSinceLastSale: number | null;
};

export type ComputeMetricsInput = {
  produtoId: string;
  farmaciaId: string;
  windowDays: number;
  salesQty: number;
  stockAtual: number;
  dataUltimaVenda?: Date | string | null;
};

/**
 * Constrói `ProductMetrics` a partir dos inputs brutos. Pure function
 * — sem I/O. O caller é responsável por agregar `salesQty` da fonte
 * apropriada (VendaMensal × 90d, Venda × user-window, etc.).
 */
export function computeProductMetrics(input: ComputeMetricsInput): ProductMetrics {
  const ad = avgDaily(input.salesQty, input.windowDays);
  const ds = daysSince(input.dataUltimaVenda);
  return {
    produtoId: input.produtoId,
    farmaciaId: input.farmaciaId,
    windowDays: input.windowDays,
    salesQty: toNonNegativeFinite(input.salesQty),
    stockAtual: toNonNegativeFinite(input.stockAtual),
    avgDaily: ad,
    coverageDays: coverageDays(input.stockAtual, ad),
    monthlyVelocity: monthlyVelocity(ad),
    rotationClass: rotationClass(ad, ds),
    daysSinceLastSale: ds,
  };
}

function daysSince(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(t)) return null;
  const diff = Date.now() - t;
  if (diff < 0) return 0;
  return Math.floor(diff / 86_400_000);
}
