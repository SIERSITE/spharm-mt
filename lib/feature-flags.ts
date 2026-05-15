/**
 * lib/feature-flags.ts
 *
 * Registo centralizado das funcionalidades activas no piloto.
 * Não é um sistema de feature-flagging distribuído (não há LaunchDarkly,
 * GrowthBook, etc.) — é apenas um ponto único onde o estado funcional
 * do piloto é declarado e pode ser lido por outras partes do código
 * ou pelo endpoint /api/admin/pilot/summary.
 *
 * Defaults: todas as flags arrancam **enabled** porque durante a fase
 * piloto cada uma corresponde a funcionalidade já validada em produção.
 * São overridable via env (`FEATURE_<NAME>=0` desliga).
 *
 * **Uso operacional**: kill switch rápido. Se durante o piloto algo
 * correr mal, basta exportar a variável e reiniciar o deployment —
 * nenhuma migration, nenhum redeploy de código.
 *
 * Não usar para A/B testing, roll-outs progressivos ou variação por
 * tenant. Para isso, viria um sistema dedicado depois do piloto.
 */

export const FEATURE_NAMES = [
  "ENABLE_ORDER_INSERT",
  "ENABLE_PIPELINE_AUTOMATION",
  "ENABLE_MULTI_FARMACIA",
  "ENABLE_OPERATIONAL_INTELLIGENCE",
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];

const DESCRIPTIONS: Record<FeatureName, string> = {
  ENABLE_ORDER_INSERT:
    "Permite que o agent on-prem escreva encomendas no SPharm via ordersWriteMode=insert. Kill switch desliga writes reais — agent continua a operar em stub.",
  ENABLE_PIPELINE_AUTOMATION:
    "Permite que o daily-pipeline corra automaticamente via Task Scheduler. Desligar pausa toda a ingestão diária até reactivar.",
  ENABLE_MULTI_FARMACIA:
    "Permite vistas/queries cross-farmácia (transferências, excessos, dashboards consolidados). Desligar isola cada farmácia à sua vista própria.",
  ENABLE_OPERATIONAL_INTELLIGENCE:
    "Permite cálculo de métricas operacionais avançadas (rotação, cobertura, sugestões de transferência). Desligar reduz dashboard a métricas básicas.",
};

function readBoolEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const norm = raw.toLowerCase().trim();
  if (norm === "0" || norm === "false" || norm === "no" || norm === "off") return false;
  if (norm === "1" || norm === "true" || norm === "yes" || norm === "on") return true;
  return defaultValue;
}

/** Lê o estado actual da flag (envs prefixadas com FEATURE_). */
export function isFeatureEnabled(name: FeatureName): boolean {
  return readBoolEnv(`FEATURE_${name}`, true);
}

/** Descrição operacional da flag — usado por /api/admin/pilot/summary. */
export function describeFeature(name: FeatureName): string {
  return DESCRIPTIONS[name];
}

/** Snapshot do estado de todas as flags + descrições. Read-only. */
export function snapshotFeatureFlags(): Array<{
  name: FeatureName;
  enabled: boolean;
  description: string;
  source: "default" | "env";
}> {
  return FEATURE_NAMES.map((name) => {
    const envVal = process.env[`FEATURE_${name}`];
    return {
      name,
      enabled: isFeatureEnabled(name),
      description: DESCRIPTIONS[name],
      source: envVal === undefined || envVal === "" ? "default" : "env",
    };
  });
}
