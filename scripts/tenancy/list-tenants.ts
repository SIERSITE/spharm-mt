/**
 * scripts/tenancy/list-tenants.ts
 *
 * Lista todos os tenants registados no control plane em formato tabela.
 *
 * Uso:
 *   npm run tenancy:list
 *   npm run tenancy:list -- --estado ACTIVE
 *   npm run tenancy:list -- --json
 */

import "dotenv/config";
import { parseArgs } from "node:util";
import { controlPrisma, listTenants } from "@/lib/control-plane";
import { requireControlEnv } from "./_shared";

async function main() {
  requireControlEnv();

  const { values } = parseArgs({
    options: {
      estado: { type: "string" },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });

  const estadoFilter = values.estado as
    | "PROVISIONING"
    | "ACTIVE"
    | "SUSPENDED"
    | "DEACTIVATED"
    | "FAILED"
    | undefined;

  const tenants = await listTenants(estadoFilter ? { estado: estadoFilter } : undefined);

  if (values.json) {
    // Remove dbPassEncrypted antes de emitir (não queremos dados
    // sensíveis no stdout nem em pipes que possam acabar em logs).
    const safe = tenants.map(({ dbPassEncrypted: _, ...rest }) => rest);
    console.log(JSON.stringify(safe, null, 2));
  } else {
    if (tenants.length === 0) {
      console.log("Sem tenants registados.");
      return;
    }
    console.table(
      tenants.map((t) => ({
        slug: t.slug,
        nome: t.nome.slice(0, 30),
        estado: t.estado,
        dbName: t.dbName,
        schemaVersion: t.schemaVersion?.slice(-30) ?? "—",
        lastMigrated: t.lastMigratedAt?.toISOString().slice(0, 10) ?? "—",
        lastHealth: t.lastHealthStatus ?? "—",
        createdAt: t.createdAt.toISOString().slice(0, 10),
      }))
    );
    console.log(`${tenants.length} tenant(s).`);
  }

  await controlPrisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
