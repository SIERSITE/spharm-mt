import "server-only";
import {
  getTenantBySlug,
  type TenantRecord,
} from "@/lib/control-plane";
import { AdminApiError } from "@/lib/admin/api-token";

/**
 * lib/admin/ops/_shared.ts
 *
 * Helpers partilhados pelas operações de admin expostas em
 * `/api/admin/v1/*`. Cada operação é uma função pura que:
 *   · resolve o tenant pelo slug (control plane)
 *   · valida estado
 *   · faz o trabalho reutilizando os MESMOS libs privilegiados que os
 *     scripts CLI usam (lib/control-plane, lib/admin/tenant-client,
 *     lib/tenant-crypto) — sem duplicar provisioning/segurança
 *   · devolve dados estruturados ou lança AdminApiError (mapeado para
 *     HTTP pelo wrapper de auth)
 *
 * Estas funções NÃO criam tenants — provisioning pesado (migrations,
 * DB-admin, Neon) fica em dev/trusted. Ver docs/admin-wizard.md.
 */

export { AdminApiError };

/** Resolve um tenant por slug, exigindo estado ACTIVE. */
export async function resolveActiveTenant(slug: string): Promise<TenantRecord> {
  if (!slug || slug.trim() === "") {
    throw new AdminApiError(400, "slug em falta", "bad_request");
  }
  const tenant = await getTenantBySlug(slug.trim());
  if (!tenant) {
    throw new AdminApiError(404, `tenant "${slug}" não existe`, "tenant_not_found");
  }
  if (tenant.estado !== "ACTIVE") {
    throw new AdminApiError(
      409,
      `tenant "${slug}" está em ${tenant.estado}; só ACTIVE aceita esta operação`,
      "tenant_not_active"
    );
  }
  return tenant;
}
