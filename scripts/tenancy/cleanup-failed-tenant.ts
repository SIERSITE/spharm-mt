/**
 * scripts/tenancy/cleanup-failed-tenant.ts
 *
 * Remove um tenant em estado PROVISIONING ou FAILED do control plane.
 * Útil para limpar tentativas parciais de provision (ex: erro de
 * permissão Neon a meio, network blip, schema corrompido).
 *
 * NÃO toca na DB do tenant nem em roles/databases — só apaga a linha
 * no control plane e os TenantEvent associados (via cascade FK). Se
 * a DB do tenant foi criada e ficou ghost, o operador remove-a
 * manualmente no provider (Neon/Supabase/etc).
 *
 * Recusa-se a apagar tenants em ACTIVE/SUSPENDED/DEACTIVATED — usa
 * `tenancy:deactivate` para esses casos.
 *
 * Uso:
 *   npm run tenancy:cleanup-failed -- --slug piloto-demo
 *   npm run tenancy:cleanup-failed -- --slug piloto-demo --confirm
 *
 * Sem --confirm, faz dry-run e mostra o que seria apagado.
 */

import "dotenv/config";
import { parseArgs } from "node:util";
import { controlPrisma, getTenantBySlug } from "@/lib/control-plane";
import { requireControlEnv } from "./_shared";

async function main() {
  requireControlEnv();

  const { values } = parseArgs({
    options: {
      slug: { type: "string" },
      confirm: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (!values.slug) {
    console.error("Uso: --slug X [--confirm]");
    process.exit(1);
  }
  const slug = values.slug;

  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    console.log(`Tenant "${slug}" não encontrado no control plane — nada a limpar.`);
    await controlPrisma.$disconnect();
    return;
  }

  if (tenant.estado !== "PROVISIONING" && tenant.estado !== "FAILED") {
    console.error(
      `Recusa: tenant "${slug}" está em ${tenant.estado}, não em PROVISIONING/FAILED.`
    );
    console.error(
      `  Para tenants activos/suspensos usa: npm run tenancy:deactivate -- --slug ${slug}`
    );
    await controlPrisma.$disconnect();
    process.exit(1);
  }

  const eventCount = await controlPrisma.tenantEvent.count({
    where: { tenantId: tenant.id },
  });

  console.log("─".repeat(70));
  console.log(`Tenant a limpar:`);
  console.log(`  slug    : ${tenant.slug}`);
  console.log(`  id      : ${tenant.id}`);
  console.log(`  estado  : ${tenant.estado}`);
  console.log(`  dbHost  : ${tenant.dbHost}:${tenant.dbPort}`);
  console.log(`  dbName  : ${tenant.dbName}`);
  console.log(`  dbUser  : ${tenant.dbUser}`);
  console.log(`  events  : ${eventCount} entrada(s) em TenantEvent (cascade)`);
  console.log("─".repeat(70));

  if (!values.confirm) {
    console.log("\n(dry-run — re-corre com --confirm para apagar)");
    console.log(
      "\nNOTA: este script NÃO apaga a DB/role no Postgres. Se foram criados\n" +
        "e ficaram ghost, remove-os manualmente no provider:"
    );
    console.log(`  DROP DATABASE ${JSON.stringify(tenant.dbName)};`);
    console.log(`  DROP ROLE     ${JSON.stringify(tenant.dbUser)};`);
    await controlPrisma.$disconnect();
    return;
  }

  // TenantEvent tem onDelete: Cascade para Tenant — apaga só o tenant.
  await controlPrisma.tenant.delete({ where: { id: tenant.id } });
  console.log(`\n✓ Tenant "${slug}" removido do control plane.`);
  console.log(
    `  Se a DB/role ${tenant.dbName}/${tenant.dbUser} foram criadas em Postgres,\n` +
      `  remove-as manualmente no provider.`
  );
  await controlPrisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
