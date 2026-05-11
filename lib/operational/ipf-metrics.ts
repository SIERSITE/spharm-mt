/**
 * lib/operational/ipf-metrics.ts
 *
 * Contadores in-process das chamadas dual-read IPF. Cobre todos os
 * loaders que passam por `resolveAvgDaily90d` em
 * `lib/operational/ipf-reader.ts`.
 *
 * Disclaimer: estes counters são process-local e in-memory. Em
 * deployment serverless (Vercel functions), cada invocação tem o seu
 * próprio process — os contadores resetam entre cold starts. Para
 * observabilidade durável passa as métricas a `SyncRun` ou um agente
 * externo (next iteration).
 *
 * Para snapshots locais: `getIpfMetrics()` + `resetIpfMetrics()`.
 */

let ipfHits = 0;
let liveFallbacks = 0;
let lastResetAt = new Date();

export type IpfMetricsSnapshot = {
  ipfHits: number;
  liveFallbacks: number;
  totalResolutions: number;
  hitRate: number; // 0..1
  fallbackRate: number; // 0..1
  lastResetAt: Date;
};

export function recordIpfHit(): void {
  ipfHits++;
}

export function recordLiveFallback(): void {
  liveFallbacks++;
}

export function getIpfMetrics(): IpfMetricsSnapshot {
  const total = ipfHits + liveFallbacks;
  return {
    ipfHits,
    liveFallbacks,
    totalResolutions: total,
    hitRate: total === 0 ? 0 : ipfHits / total,
    fallbackRate: total === 0 ? 0 : liveFallbacks / total,
    lastResetAt: new Date(lastResetAt),
  };
}

export function resetIpfMetrics(): void {
  ipfHits = 0;
  liveFallbacks = 0;
  lastResetAt = new Date();
}
