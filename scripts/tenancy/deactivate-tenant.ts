/**
 * scripts/tenancy/deactivate-tenant.ts
 *
 * Muda o estado de um tenant para SUSPENDED (reversível) ou
 * DEACTIVATED (arquivado). Em ambos os casos:
 *   · a DB é PRESERVADA (não apaga nada)
 *   · o control plane passa a rejeitar logins/tráfego
 *   · opcionalmente, REVOKE CONNECT no Postgres bloqueia conexões
 *     directas (flag --revoke-connect)
 *
 * DEACTIVATED é só um rótulo mais definitivo que SUSPENDED para
 * efeitos operacionais — ambos bloqueiam tráfego aplicacional.
 *
 * Uso:
 *   npm run tenancy:deactivate -- --slug farmacias-braga
 *   npm run tenancy:deactivate -- --slug farmacias-braga --mode deactivate
 *   npm run tenancy:deactivate -- --slug farmacias-braga --revoke-connect
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
      mode: { type: "string", default: "suspend" }, // suspend | deactivate
      "revoke-connect": { type: "boolean", default: false },
    },
    strict: true,
  });

  if (!values.slug) {
    console.error("Uso: --slug X [--mode suspend|deactivate] [--revoke-connect]");
    process.exit(1);
  }
  const slug = values.slug;
  const mode = values.mode === "deactivate" ? "deactivate" : "suspend";

  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    console.error(`Tenant "${slug}" não encontrado.`);
    process.exit(1);
  }

  if (tenant.estado === "PROVISIONING") {
    console.error(`Tenant "${slug}" ainda em PROVISIONING. Não pode ser desactivado — espera que termine ou usa destroy.`);
    process.exit(1);
  }

  const newEstado = mode === "deactivate" ? "DEACTIVATED" : "SUSPENDED";
  const action = mode === "deactivate" ? "deactivated" : "suspended";

  if (values["revoke-connect"]) {
    requireAdminEnv();
    console.log("▶ A revogar CONNECT no Postgres…");
    const admin = await openAdminClient();
    try {
      await admin.query(`REVOKE CONNECT ON DATABASE ${quoteIdent(tenant.dbName)} FROM ${quoteIdent(tenant.dbUser)}`);
    } catch (err) {
      console.warn("  ⚠ Falha a revogar CONNECT (pode já estar revogado):", err instanceof Error ? err.message : err);
    } finally {
      await admin.end();
    }
  }

  await controlPrisma.tenant.update({
    where: { id: tenant.id },
    data: { estado: newEstado },
  });
  await logTenantEvent({
    tenantId: tenant.id,
    action,
    meta: { previousEstado: tenant.estado, revokeConnect: !!values["revoke-connect"] },
  });

  console.log(`✓ Tenant "${slug}" → ${newEstado}`);
  console.log(
    "  Sessões activas no browser não são terminadas automaticamente. O resolver\n" +
    "  da app vai rejeitar pedidos novos; sessões existentes expiram com o JWT."
  );
  await controlPrisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
