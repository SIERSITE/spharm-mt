/**
 * scripts/tenancy/reactivate-tenant.ts
 *
 * Reverte SUSPENDED/DEACTIVATED → ACTIVE. Se o tenant foi suspendido
 * com --revoke-connect, volta a conceder CONNECT automaticamente
 * (seguro: GRANT é idempotente).
 *
 * Uso:
 *   npm run tenancy:reactivate -- --slug farmacias-braga
 */

import "dotenv/config";
import { parseArgs } from "node:util";
import { controlPrisma, logTenantEvent, getTenantBySlug } from "@/lib/control-plane";
import { requireControlEnv, openAdminClient, quoteIdent, requireAdminEnv } from "./_shared";

async function main() {
  requireControlEnv();

  const { values } = parseArgs({
    options: {
      slug: { type: "string" },
      "skip-grant": { type: "boolean", default: false },
    },
    strict: true,
  });

  if (!values.slug) {
    console.error("Uso: --slug X [--skip-grant]");
    process.exit(1);
  }
  const slug = values.slug;

  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    console.error(`Tenant "${slug}" não encontrado.`);
    process.exit(1);
  }

  if (tenant.estado === "ACTIVE") {
    console.log(`Tenant "${slug}" já está ACTIVE. Nada a fazer.`);
    await controlPrisma.$disconnect();
    return;
  }
  if (tenant.estado === "FAILED" || tenant.estado === "PROVISIONING") {
    console.error(
      `Tenant "${slug}" em estado ${tenant.estado} — não é candidato a reactivação automática.\n` +
      "  FAILED precisa de reprovisionamento manual, PROVISIONING precisa de aguardar ou corrigir."
    );
    process.exit(1);
  }

  // Restaurar GRANT CONNECT (idempotente)
  if (!values["skip-grant"]) {
    try {
      requireAdminEnv();
      const admin = await openAdminClient();
      try {
        await admin.query(`GRANT CONNECT ON DATABASE ${quoteIdent(tenant.dbName)} TO ${quoteIdent(tenant.dbUser)}`);
      } finally {
        await admin.end();
      }
    } catch (err) {
      console.warn("  ⚠ GRANT CONNECT falhou (provavelmente já concedido):", err instanceof Error ? err.message : err);
    }
  }

  await controlPrisma.tenant.update({
    where: { id: tenant.id },
    data: { estado: "ACTIVE" },
  });
  await logTenantEvent({
    tenantId: tenant.id,
    action: "reactivated",
    meta: { previousEstado: tenant.estado },
  });

  console.log(`✓ Tenant "${slug}" → ACTIVE`);
  await controlPrisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
