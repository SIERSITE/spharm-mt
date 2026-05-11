/**
 * lib/operational/ipf-freshness.ts
 *
 * Detecção de staleness / cobertura de `IndicadoresProdutoFarmacia`.
 * Sem `import "server-only"` — usado por scripts CLI
 * (`scripts/ipf-health.ts`) e potencialmente por loaders runtime web
 * (futuro alerta de dashboard).
 *
 * Split em duas camadas:
 *   1. `analyzeFreshness(snapshot, options)` — pure function que
 *      decide se o read-model está stale ou subcoberto, dado
 *      counts + timestamps. Testável sem BD.
 *   2. `getIpfFreshness(prisma, options)` — glue async que recolhe o
 *      snapshot do DB e chama o pure.
 *
 * Defaults: stale se `ageHours > 26`; low-coverage se `coverage <
 * 0.98`. Estes thresholds são intencionalmente folgados — o populate
 * corre em <10s, qualquer atraso > 26h significa job parado, e 98%
 * acomoda novas ProdutoFarmacia ingeridas entre dois populates.
 */

import type { PrismaClient } from "@/generated/prisma/client";

export type FreshnessOptions = {
  /** Acima deste valor, o read-model é considerado stale. Default 26. */
  thresholdHours?: number;
  /** Abaixo deste rácio (0..1), o read-model é considerado subcoberto. Default 0.98. */
  thresholdCoverage?: number;
};

/**
 * Snapshot bruto do DB. Caller (`getIpfFreshness`) preenche; pure
 * `analyzeFreshness` consome.
 */
export type FreshnessSnapshot = {
  totalIpfRows: number;
  totalPfRows: number;
  maxDataCalculo: Date | null;
  minDataCalculo: Date | null;
};

/**
 * Output completo: combina o snapshot, thresholds aplicados, e o
 * veredicto.
 */
export type IpfFreshness = {
  totalIpfRows: number;
  totalPfRows: number;
  missingRows: number;
  coverage: number;
  maxDataCalculo: Date | null;
  minDataCalculo: Date | null;
  ageHours: number | null;
  thresholdHours: number;
  thresholdCoverage: number;
  isStale: boolean;
  isLowCoverage: boolean;
  /** `true` quando o read-model passa todos os thresholds. */
  healthy: boolean;
  /** Razões legíveis para falhas — vazio quando healthy. */
  reasons: string[];
};

const HOUR_MS = 3_600_000;

/**
 * Calcula veredicto a partir de snapshot + thresholds. PURE.
 *
 * Regras:
 *   - `ageHours = (now - maxDataCalculo) / 3600s`. Null quando IPF está
 *     completamente vazia.
 *   - `isStale = ageHours > thresholdHours`. Quando ageHours = null,
 *     também marca stale (sem dados = obrigatoriamente stale).
 *   - `coverage = totalIpfRows / totalPfRows`. Quando totalPfRows = 0,
 *     coverage = 1 (não há produtos para cobrir → trivialmente OK).
 *   - `isLowCoverage = coverage < thresholdCoverage`.
 *   - `healthy = !isStale && !isLowCoverage`.
 */
export function analyzeFreshness(
  snapshot: FreshnessSnapshot,
  options: FreshnessOptions = {},
  now: Date = new Date(),
): IpfFreshness {
  const thresholdHours = options.thresholdHours ?? 26;
  const thresholdCoverage = options.thresholdCoverage ?? 0.98;

  const missingRows = Math.max(0, snapshot.totalPfRows - snapshot.totalIpfRows);
  const coverage = snapshot.totalPfRows === 0
    ? 1
    : snapshot.totalIpfRows / snapshot.totalPfRows;

  const ageHours = snapshot.maxDataCalculo === null
    ? null
    : Math.max(0, (now.getTime() - snapshot.maxDataCalculo.getTime()) / HOUR_MS);

  const isStale = ageHours === null ? true : ageHours > thresholdHours;
  const isLowCoverage = coverage < thresholdCoverage;
  const healthy = !isStale && !isLowCoverage;

  const reasons: string[] = [];
  if (isStale) {
    reasons.push(
      ageHours === null
        ? "IPF vazia (sem dataCalculo)"
        : `stale: idade=${ageHours.toFixed(1)}h > threshold=${thresholdHours}h`,
    );
  }
  if (isLowCoverage) {
    reasons.push(
      `coverage=${(coverage * 100).toFixed(1)}% < threshold=${(thresholdCoverage * 100).toFixed(1)}% ` +
        `(${missingRows} ProdutoFarmacia sem IPF)`,
    );
  }

  return {
    totalIpfRows: snapshot.totalIpfRows,
    totalPfRows: snapshot.totalPfRows,
    missingRows,
    coverage,
    maxDataCalculo: snapshot.maxDataCalculo,
    minDataCalculo: snapshot.minDataCalculo,
    ageHours,
    thresholdHours,
    thresholdCoverage,
    isStale,
    isLowCoverage,
    healthy,
    reasons,
  };
}

/**
 * Recolhe o snapshot do DB e devolve o veredicto. Não escreve. O
 * caller é responsável por escolher o `prisma` correcto
 * (`legacyPrisma` para CLI legacy, ou cliente tenant-específico).
 */
export async function getIpfFreshness(
  prisma: PrismaClient,
  options: FreshnessOptions = {},
): Promise<IpfFreshness> {
  // 2 contagens + 1 agregação. Cada uma é uma query simples indexada.
  const [totalIpfRows, totalPfRows, agg] = await Promise.all([
    prisma.indicadoresProdutoFarmacia.count(),
    prisma.produtoFarmacia.count({ where: { flagRetirado: false } }),
    prisma.indicadoresProdutoFarmacia.aggregate({
      _max: { dataCalculo: true },
      _min: { dataCalculo: true },
    }),
  ]);

  const snapshot: FreshnessSnapshot = {
    totalIpfRows,
    totalPfRows,
    maxDataCalculo: agg._max.dataCalculo ?? null,
    minDataCalculo: agg._min.dataCalculo ?? null,
  };
  return analyzeFreshness(snapshot, options);
}
