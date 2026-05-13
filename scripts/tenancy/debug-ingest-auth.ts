/**
 * scripts/tenancy/debug-ingest-auth.ts
 *
 * Debug cirúrgico de 401 invalid credentials no
 * `withIntegrationAuth`. Lê o control plane apontado por
 * `CONTROL_DATABASE_URL` (no .env local), mostra o estado exacto do
 * tenant + ingest key + farmácias da BD do tenant + hint do control
 * plane usado.
 *
 * NUNCA mostra a key em claro nem a hash bcrypt completa. Mostra:
 *  · `hashPrefix` (primeiros 10 chars, $2a$10$ + 4 chars de salt —
 *    metadata bcrypt, não permite recuperação)
 *  · `bcrypt fingerprint` (10 chars do meio para cross-ref com
 *    `[integracao/auth]` logs do runtime sem expor)
 *
 * Compara o output deste CLI (control plane local apontado pelo dev)
 * com os logs `[integracao/auth] {...}` do Vercel runtime. Se os
 * dois mostram dbName/host diferentes, o problema é divergência
 * entre `CONTROL_DATABASE_URL` local vs Vercel.
 *
 * Uso:
 *   npm run tenancy:debug-ingest-auth -- --slug=demo-neon
 *
 *   # Para comparar com a key que o agent tem (sem revelar a key
 *   # completa). Útil quando suspeitas que o agent.config.json
 *   # ficou desactualizado após --rotate:
 *   npm run tenancy:debug-ingest-auth -- --slug=demo-neon \
 *     --probe-key="abcdef..."   # primeiros 6+ chars chegam
 */

import "dotenv/config";
import { parseArgs } from "node:util";
import bcrypt from "bcryptjs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient as TenantPrismaClient } from "@/generated/prisma/client";
import {
  controlPrisma,
  getTenantBySlug,
  listTenants,
  buildTenantConnectionString,
} from "@/lib/control-plane";
import { requireControlEnv } from "./_shared";

function deriveControlDbHint(): { url: string; host: string; dbName: string } {
  const url = process.env.CONTROL_DATABASE_URL ?? "";
  try {
    const u = new URL(url);
    return {
      url: url.replace(/(:[^@/]+)(@)/, ":***$2"),
      host: u.hostname,
      dbName: u.pathname.replace(/^\//, "") || "(none)",
    };
  } catch {
    return { url: "(unparseable)", host: "(?)", dbName: "(?)" };
  }
}

async function main(): Promise<void> {
  requireControlEnv();

  const { values } = parseArgs({
    options: {
      slug: { type: "string" },
      "probe-key": { type: "string" },
    },
    strict: true,
  });

  if (!values.slug) {
    console.error(
      "Uso: --slug X [--probe-key=<key>]\n" +
        "  --probe-key (opcional): testa bcrypt.compare local — confirma se a key\n" +
        "                          que tens bate o hash actual."
    );
    process.exit(1);
  }
  const slug = values.slug;
  const probeKey = values["probe-key"]?.trim() || undefined;

  const db = deriveControlDbHint();
  console.log("─".repeat(72));
  console.log("Debug Ingest Auth — CLI local apontado a:");
  console.log("─".repeat(72));
  console.log(`  CONTROL_DATABASE_URL : ${db.url}`);
  console.log(`  host                 : ${db.host}`);
  console.log(`  dbName               : ${db.dbName}`);
  console.log("");
  console.log("  ⚠ COMPARA estes valores com CONTROL_DATABASE_URL em Vercel.");
  console.log("    Se host/dbName diferem, a chave foi rodada num control plane");
  console.log("    diferente daquele que o runtime está a ler — Vercel devolverá");
  console.log('    401 com outcome "tenant_not_found" ou "bcrypt_mismatch" nos logs.');
  console.log("");

  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    console.log(`Tenant "${slug}":`);
    console.log("  ✗ NÃO encontrado neste control plane.");
    console.log("");
    const all = await listTenants();
    console.log(`Tenants neste control plane (${all.length}):`);
    if (all.length === 0) {
      console.log("  (vazio — control plane sem nenhum tenant registado)");
    } else {
      for (const t of all) {
        console.log(`  · ${t.slug.padEnd(30)} ${t.estado.padEnd(15)} id=${t.id}`);
      }
    }
    console.log("");
    console.log("Hipóteses:");
    console.log("  · Slug errado no agent.config.json (case-sensitive: 'demo-neon' ≠ 'Demo-Neon')");
    console.log("  · Tenant foi provisionado contra outro control plane");
    console.log("  · Tenant foi apagado por cleanup-failed-tenant");
    await controlPrisma.$disconnect();
    process.exit(1);
  }

  console.log(`Tenant "${slug}":`);
  console.log(`  id              : ${tenant.id}`);
  console.log(
    `  estado          : ${tenant.estado}${
      tenant.estado === "ACTIVE" ? "  ✓" : "  ✗ (auth recusa qualquer key)"
    }`
  );
  console.log(`  nome            : ${tenant.nome}`);
  console.log(`  dbHost          : ${tenant.dbHost}:${tenant.dbPort}`);
  console.log(`  dbName (tenant) : ${tenant.dbName}`);
  console.log(`  createdAt       : ${tenant.createdAt.toISOString()}`);
  console.log(`  provisionedAt   : ${tenant.provisionedAt?.toISOString() ?? "(null)"}`);
  console.log("");

  console.log("Ingest Key:");
  if (!tenant.ingestApiKeyHash) {
    console.log(`  ✗ NÃO emitida (ingestApiKeyHash=null)`);
    console.log(`    Fix: npm run tenancy:issue-ingest-key -- --slug=${slug}`);
  } else {
    const h = tenant.ingestApiKeyHash;
    console.log(`  ✓ emitida`);
    console.log(`  hashPrefix      : ${h.slice(0, 10)}...     (bcrypt metadata)`);
    console.log(`  hashLength      : ${h.length}`);
    console.log(`  hashFingerprint : ...${h.slice(20, 30)}... (10 chars do meio — cross-ref com Vercel logs)`);
    console.log(`  issuedAt        : ${tenant.ingestApiKeyIssuedAt?.toISOString() ?? "(null)"}`);
    if (tenant.ingestApiKeyIssuedAt) {
      const ageMs = Date.now() - tenant.ingestApiKeyIssuedAt.getTime();
      const ageMin = Math.floor(ageMs / 60_000);
      const ageH = (ageMin / 60).toFixed(1);
      console.log(`  age             : ${ageMin} min (${ageH}h)`);
    }
  }
  console.log("");

  // ── Probe key — verifica se uma key candidata bate o hash actual ─
  if (probeKey && tenant.ingestApiKeyHash) {
    console.log("Probe key:");
    console.log(`  probePrefix     : ${probeKey.slice(0, 6)}...`);
    console.log(`  probeLength     : ${probeKey.length}`);
    const ok = await bcrypt.compare(probeKey, tenant.ingestApiKeyHash);
    console.log(`  bcrypt.compare  : ${ok ? "✓ MATCH" : "✗ MISMATCH"}`);
    if (ok) {
      console.log(`  → a key que estás a usar é VÁLIDA contra este control plane.`);
      console.log(`    Se Vercel devolve 401, o runtime está a ler outro control plane.`);
    } else {
      console.log(`  → a key não bate o hash actual deste control plane.`);
      console.log(`    Re-emite: npm run tenancy:issue-ingest-key -- --slug=${slug} --rotate`);
    }
    console.log("");
  }

  // ── Farmácias na BD do tenant ────────────────────────────────────
  console.log("Farmácias do tenant (lidas da BD do tenant, não do control plane):");
  if (tenant.estado !== "ACTIVE") {
    console.log("  (skipped — tenant não está ACTIVE)");
  } else {
    let tenantDb: TenantPrismaClient | null = null;
    try {
      const url = buildTenantConnectionString(tenant);
      const adapter = new PrismaPg({ connectionString: url });
      tenantDb = new TenantPrismaClient({ adapter });
      const farmacias = await tenantDb.farmacia.findMany({
        select: { id: true, nome: true, estado: true },
        orderBy: { nome: "asc" },
      });
      if (farmacias.length === 0) {
        console.log("  (nenhuma — agent fica sem alvo para upload; cria via UI ou SQL)");
      } else {
        for (const f of farmacias) {
          console.log(`  · ${f.nome.padEnd(40)} ${f.estado.padEnd(8)} ${f.id}`);
        }
      }
    } catch (err) {
      console.log(`  ✗ falha a ler farmácias: ${err instanceof Error ? err.message : err}`);
      console.log(`    Pode indicar que a BD do tenant não está acessível com a URL`);
      console.log(`    reconstruída pelo control plane. Verifica dbHost/dbPass.`);
    } finally {
      if (tenantDb) await tenantDb.$disconnect();
    }
  }
  console.log("");

  // ── Análise final ────────────────────────────────────────────────
  console.log("─".repeat(72));
  console.log("Diagnóstico");
  console.log("─".repeat(72));

  if (tenant.estado !== "ACTIVE") {
    console.log(`  ✗ Tenant estado=${tenant.estado} — withIntegrationAuth recusa.`);
    console.log(`    Outcome em Vercel logs: "tenant_not_active"`);
    console.log(`    Fix:  npm run tenancy:reactivate -- --slug=${slug}`);
  } else if (!tenant.ingestApiKeyHash) {
    console.log(`  ✗ Sem ingest key — withIntegrationAuth recusa com outcome="no_key".`);
    console.log(`    Fix:  npm run tenancy:issue-ingest-key -- --slug=${slug}`);
  } else {
    console.log(`  ✓ Server-side OK aqui: tenant ACTIVE + ingestApiKeyHash presente.`);
    console.log("");
    console.log("  Se Vercel runtime continua a 401:");
    console.log("");
    console.log(`  Cenário A — runtime vê outro control plane`);
    console.log(`    Sintoma: Vercel logs mostram outcome="tenant_not_found" para slug=${slug}`);
    console.log(`             OU hashFingerprint diferente do mostrado acima.`);
    console.log(`    Diagnose:`);
    console.log(`      vercel env ls | findstr CONTROL_DATABASE_URL`);
    console.log(`      Comparar hostname/dbName com:`);
    console.log(`      host=${db.host} dbName=${db.dbName}`);
    console.log(`    Fix: actualizar CONTROL_DATABASE_URL no Vercel + redeploy`);
    console.log(`         OU re-emitir key contra o control plane do Vercel.`);
    console.log("");
    console.log(`  Cenário B — agent envia key desactualizada`);
    console.log(`    Sintoma: Vercel logs mostram outcome="bcrypt_mismatch"`);
    console.log(`             hashFingerprint bate o mostrado acima.`);
    console.log(`             bearerPrefix nos logs ≠ prefix da nova key.`);
    console.log(`    Fix: re-emitir + actualizar agent.config.json:`);
    console.log(`      npm run tenancy:issue-ingest-key -- --slug=${slug} --rotate`);
    console.log(`      copiar key em claro → agent.config.json saas.ingestKey`);
    console.log("");
    console.log(`  Cenário C — agent não envia bearer / slug correctamente`);
    console.log(`    Sintoma: Vercel logs mostram outcome="missing_credentials"`);
    console.log(`             OU outcome="tenant_not_found" com slug=null`);
    console.log(`             OU bearerPresent=false`);
    console.log(`    Fix: confirma agent.config.json saas.ingestKey + saas.tenantSlug.`);
    console.log(`         Verifica que o test-connection do agent passa pelos`);
    console.log(`         headers Authorization + X-Tenant-Slug.`);
    console.log("");
    console.log(`  Caminho rápido: usa --probe-key="<primeiros chars da key>" para`);
    console.log(`  confirmar bcrypt.compare local. Se MATCH local mas 401 no Vercel,`);
    console.log(`  é cenário A (divergência de control planes).`);
  }
}

main()
  .catch((err) => {
    console.error("[fatal]", err);
    process.exit(1);
  })
  .finally(() => controlPrisma.$disconnect());
