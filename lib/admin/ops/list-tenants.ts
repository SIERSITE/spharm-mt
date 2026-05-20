import "server-only";
import { listTenants } from "@/lib/control-plane";

/**
 * lib/admin/ops/list-tenants.ts
 *
 * Lista tenants para o wizard (cabeçalho / dropdown). Reutiliza
 * `listTenants()` do control plane e remove `dbPassEncrypted` antes
 * de devolver — o cliente nunca precisa do segredo cifrado.
 */

export type AdminTenantSummary = {
  id: string;
  slug: string;
  nome: string;
  estado: string;
  dbHost: string;
  dbName: string;
  dbRegion: string | null;
  ingestKeyIssued: boolean;
  provisionedAt: string | null;
};

export async function listTenantsForAdmin(): Promise<AdminTenantSummary[]> {
  const tenants = await listTenants();
  return tenants.map((t) => ({
    id: t.id,
    slug: t.slug,
    nome: t.nome,
    estado: t.estado,
    dbHost: t.dbHost,
    dbName: t.dbName,
    dbRegion: t.dbRegion,
    ingestKeyIssued: !!t.ingestApiKeyHash,
    provisionedAt: t.provisionedAt ? t.provisionedAt.toISOString() : null,
  }));
}
