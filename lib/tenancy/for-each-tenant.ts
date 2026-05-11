/**
 * lib/tenancy/for-each-tenant.ts
 *
 * Iterador safe sobre tenants ACTIVE do control plane. Sem paralelismo
 * — corre 1 tenant de cada vez. Cada handler recebe um PrismaClient
 * ligado à BD do tenant (vindo do `tenant-registry`).
 *
 * Não atira nunca: erros por-tenant são apanhados, logados e
 * incluídos no resumo final. O caller decide se quer falhar globalmente
 * (verificar `summary.failed > 0`).
 *
 * Uso típico em scripts CLI:
 *
 *   import { forEachActiveTenant } from "@/lib/tenancy/for-each-tenant";
 *   import { startSyncRun, completeSyncRun, failSyncRun } from "@/lib/sync/sync-run";
 *
 *   await forEachActiveTenant(async ({ tenant, prisma }) => {
 *     const run = await startSyncRun({ tenantSlug: tenant.slug, source: "daily-enrich" });
 *     try {
 *       const counts = await enrichForTenant(prisma);
 *       await completeSyncRun(run.id, counts);
 *     } catch (err) {
 *       await failSyncRun(run.id, err);
 *       throw err; // re-throw para o iterador contar como falha do tenant
 *     }
 *   });
 *
 * Paralelismo: deliberadamente NÃO implementado nesta passagem. Quando
 * for adicionado terá de respeitar o budget de conexões Neon do plano
 * (ver `notes/infra-hardening-plan.md`).
 */

import { listTenants, type TenantRecord } from "@/lib/control-plane";
import { getTenantPrismaOrLegacy } from "@/lib/tenant-registry";
import type { PrismaClient } from "@/generated/prisma/client";

export type TenantIterContext = {
  tenant: TenantRecord;
  prisma: PrismaClient;
};

export type TenantIterHandler = (ctx: TenantIterContext) => Promise<void>;

export type TenantIterSummary = {
  total: number;
  succeeded: number;
  failed: number;
  durationMs: number;
  failures: Array<{ slug: string; error: string }>;
};

export type ForEachOptions = {
  /**
   * Filtro opcional sobre slugs. Se omitido, processa todos os tenants
   * ACTIVE. Útil para CLIs com `--tenant=foo --tenant=bar`.
   */
  onlySlugs?: string[];
  /**
   * Função para log de progresso. Recebe mensagem livre. Default:
   * `console.log` prefixado com `[for-each-tenant]`.
   */
  onProgress?: (msg: string) => void;
  /**
   * Se `true`, re-lança o primeiro erro ao terminar (depois de iterar
   * todos). Default `false` — handler de erro é silencioso após log.
   */
  rethrowFirstError?: boolean;
};

/**
 * Itera handler sobre todos os tenants ACTIVE. Sequencial.
 *
 * @returns Resumo da iteração (succeeded/failed/durationMs/failures).
 *          NÃO atira por defeito mesmo se houver falhas — o caller
 *          decide via `summary.failed`.
 */
export async function forEachActiveTenant(
  handler: TenantIterHandler,
  options: ForEachOptions = {},
): Promise<TenantIterSummary> {
  const t0 = Date.now();
  const log = options.onProgress ?? ((msg: string) => console.log(`[for-each-tenant] ${msg}`));

  const allActive = await listTenants({ estado: "ACTIVE" });
  const tenants = options.onlySlugs
    ? allActive.filter((t) => options.onlySlugs!.includes(t.slug))
    : allActive;

  log(`Iniciando: ${tenants.length} tenant(s) ACTIVE${options.onlySlugs ? " (filtrado)" : ""}`);

  const summary: TenantIterSummary = {
    total: tenants.length,
    succeeded: 0,
    failed: 0,
    durationMs: 0,
    failures: [],
  };
  let firstError: unknown = null;

  for (let i = 0; i < tenants.length; i++) {
    const tenant = tenants[i]!;
    const t0Tenant = Date.now();
    log(`[${i + 1}/${tenants.length}] tenant=${tenant.slug} (estado=${tenant.estado})`);

    try {
      const prisma = await getTenantPrismaOrLegacy(tenant.slug);
      await handler({ tenant, prisma });
      summary.succeeded++;
      log(`  ✓ ${tenant.slug} ok em ${((Date.now() - t0Tenant) / 1000).toFixed(1)}s`);
    } catch (err) {
      summary.failed++;
      const msg = err instanceof Error ? err.message : String(err);
      summary.failures.push({ slug: tenant.slug, error: msg.slice(0, 500) });
      log(`  ✗ ${tenant.slug} falhou: ${msg.slice(0, 200)}`);
      if (firstError === null) firstError = err;
    }
  }

  summary.durationMs = Date.now() - t0;
  log(
    `Concluído em ${(summary.durationMs / 1000).toFixed(1)}s · ` +
      `succeeded=${summary.succeeded} failed=${summary.failed}`,
  );

  if (options.rethrowFirstError && firstError !== null) {
    throw firstError;
  }

  return summary;
}

/**
 * Adapter para um único tenant (por slug). Útil em scripts que aceitam
 * `--tenant=slug` e querem reaproveitar a mesma assinatura de handler.
 *
 * @returns true se sucesso, false se falhou. Erros são logados mas
 *          não relançados (paridade com `forEachActiveTenant`).
 */
export async function forSingleTenant(
  slug: string,
  handler: TenantIterHandler,
  options: { onProgress?: (msg: string) => void } = {},
): Promise<boolean> {
  const log = options.onProgress ?? ((msg: string) => console.log(`[for-tenant] ${msg}`));
  const allActive = await listTenants({ estado: "ACTIVE" });
  const tenant = allActive.find((t) => t.slug === slug);
  if (!tenant) {
    log(`tenant slug="${slug}" não encontrado em estado ACTIVE.`);
    return false;
  }
  try {
    const prisma = await getTenantPrismaOrLegacy(tenant.slug);
    await handler({ tenant, prisma });
    log(`✓ ${slug} ok`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`✗ ${slug} falhou: ${msg.slice(0, 200)}`);
    return false;
  }
}
