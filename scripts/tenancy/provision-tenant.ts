/**
 * scripts/tenancy/provision-tenant.ts
 *
 * Provisionamento de um novo tenant (grupo de farmácias). Wrapper CLI
 * thin que selecciona um `DatabaseProvider` a partir das flags e
 * delega a criação da DB. A lógica de provisão (CREATE ROLE/DB ou
 * parse de URL externa) vive em `lib/db-providers/*`.
 *
 * Modos (mutuamente exclusivos):
 *
 *  A) --database-url=<url>   (Neon/Supabase/RDS/on-prem onde já criaste)
 *     · Operador trouxe a URL completa
 *     · Provider: ManualUrlProvider
 *     · Não toca em CREATE ROLE / SET ROLE
 *
 *  B) --create-db            (Postgres self-hosted com super-user access)
 *     · Provider: LocalPostgresProvider
 *     · Requer POSTGRES_ADMIN_URL + TENANT_DB_HOST
 *     · Em Neon partilhado normalmente FALHA com 42501 SET ROLE
 *
 * Encadeia (qualquer modo):
 *   1. Valida argumentos + slug livre no control plane
 *   2. Provider.createDatabase → ConnectionTargets
 *   3. Insere Tenant (estado=PROVISIONING) no control plane
 *   4. `prisma migrate deploy` contra a URL do tenant
 *   5. Seed: 1 Utilizador ADMINISTRADOR + (opcional) farmácia inicial
 *   6. Marca Tenant=ACTIVE
 *   7. Regista TenantEvent "created" com provider.name em meta
 *
 * Rollback:
 *   · Erro em provider.createDatabase → provider trata internamente
 *     (LocalPostgres faz DROP em cascata se DROP necessário)
 *   · Erro nos passos 4-7 → Tenant marcado FAILED; infra preservada
 *     para inspecção. Limpeza posterior:
 *       npm run tenancy:cleanup-failed -- --slug <slug>
 *
 * Uso (modo A — operador trouxe a URL):
 *   npm run tenancy:provision -- \
 *     --database-url "postgresql://USER:PASS@HOST/DBNAME?sslmode=require" \
 *     --slug farmacias-braga --nome "Grupo Braga" --admin-email a@b.pt \
 *     [--farmacia-inicial "Farmácia Central"]
 *
 * Uso (modo B — self-hosted):
 *   npm run tenancy:provision -- --create-db \
 *     --slug farmacias-braga --nome "Grupo Braga" --admin-email a@b.pt
 */

import "dotenv/config";
import { parseArgs } from "node:util";
import bcrypt from "bcryptjs";
import { PrismaClient as TenantPrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { controlPrisma, logTenantEvent } from "@/lib/control-plane";
import { encryptTenantSecret } from "@/lib/tenant-crypto";
import {
  selectProvider,
  ProviderSelectionError,
  type DatabaseProvider,
  type ConnectionTargets,
} from "@/lib/db-providers";
import {
  SLUG_REGEX,
  requireControlEnv,
  generatePassword,
  runPrismaForTenant,
  getLatestMigrationName,
} from "./_shared";

async function main() {
  requireControlEnv();

  const { values } = parseArgs({
    options: {
      slug: { type: "string" },
      nome: { type: "string" },
      "admin-email": { type: "string" },
      "admin-password": { type: "string" },
      "admin-nome": { type: "string" },
      "farmacia-inicial": { type: "string" },
      "database-url": { type: "string" },
      "create-db": { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  const slug = values.slug;
  const nome = values.nome;
  const adminEmail = values["admin-email"];
  const adminNome = values["admin-nome"] ?? "Administrador";
  let adminPassword = values["admin-password"];
  const farmaciaInicial = values["farmacia-inicial"]?.trim() || null;

  if (!slug || !nome || !adminEmail) {
    console.error(
      'Uso: --slug X --nome "Y" --admin-email E (--database-url "<url>" | --create-db)\n' +
        "        [--admin-password P] [--admin-nome N] [--farmacia-inicial \"<Nome>\"]"
    );
    process.exit(1);
  }
  if (!SLUG_REGEX.test(slug)) {
    console.error(`slug inválido: "${slug}" — tem de bater /^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$/`);
    process.exit(1);
  }

  // Selecciona provider — flags validadas aqui; mensagem accionável se ambos/nenhum.
  let provider: DatabaseProvider;
  try {
    provider = selectProvider({
      databaseUrl: values["database-url"],
      createDb: values["create-db"],
    });
  } catch (err) {
    if (err instanceof ProviderSelectionError) {
      console.error(`\n${err.message}`);
    } else {
      console.error(err instanceof Error ? err.message : String(err));
    }
    process.exit(1);
    return;
  }

  // Slug livre no control plane?
  const existing = await controlPrisma.tenant.findUnique({ where: { slug } });
  if (existing) {
    console.error(`Slug já usado pelo tenant id=${existing.id} (estado=${existing.estado}).`);
    console.error(`  Se ficou parcial, limpa com: npm run tenancy:cleanup-failed -- --slug ${slug}`);
    process.exit(1);
  }

  console.log(`▶ Provisionamento do tenant "${slug}" (provider: ${provider.name})`);

  let targets: ConnectionTargets;
  try {
    targets = await provider.createDatabase({ slug });
  } catch (err) {
    console.error(`\n✗ Provisionamento de BD falhou (provider: ${provider.name}):`);
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    if (provider.name === "manual") {
      console.error("\nDiagnóstico comum:");
      console.error("  · sslmode em falta — Neon e managed Postgres exigem ?sslmode=require");
      console.error("  · password mal escapada — verifica caracteres especiais URL-encoded");
      console.error("  · role/DB inexistente — confirma criação na UI do provider");
    } else if (provider.name === "local-postgres") {
      console.error("\nDiagnóstico comum:");
      console.error("  · POSTGRES_ADMIN_URL sem CREATEDB/CREATEROLE");
      console.error("  · Em Neon partilhado, CREATE DATABASE com OWNER alheio falha (42501)");
      console.error("  · Re-corre com --database-url criando DB+role manualmente na UI");
    }
    process.exit(1);
    return;
  }

  console.log(`  dbHost : ${targets.host}:${targets.port}`);
  console.log(`  dbName : ${targets.dbName}`);
  console.log(`  dbUser : ${targets.dbUser}`);

  if (!adminPassword) {
    adminPassword = generatePassword(12);
  }

  // Registar no control plane
  console.log("▶ A registar no control plane…");
  const tenant = await controlPrisma.tenant.create({
    data: {
      slug,
      nome,
      estado: "PROVISIONING",
      dbHost: targets.host,
      dbPort: targets.port,
      dbName: targets.dbName,
      dbUser: targets.dbUser,
      dbPassEncrypted: encryptTenantSecret(targets.dbPassword),
    },
  });

  let farmaciaInicialId: string | null = null;

  // A partir daqui, qualquer erro marca FAILED (infra preservada).
  try {
    // Migrations
    console.log("▶ A aplicar migrations (prisma migrate deploy)…");
    const migrateResult = runPrismaForTenant(
      ["migrate", "deploy", "--schema", "prisma/schema.prisma"],
      targets.connectionUrl
    );
    if (migrateResult.status !== 0) {
      throw new Error(
        `prisma migrate deploy falhou (exit ${migrateResult.status}):\n${migrateResult.stderr ?? ""}`
      );
    }
    process.stdout.write(migrateResult.stdout ?? "");

    // Seed admin + (opcional) farmácia inicial
    console.log("▶ A criar utilizador administrador inicial…");
    const passwordHash = await bcrypt.hash(adminPassword, 10);
    const adapter = new PrismaPg({ connectionString: targets.connectionUrl });
    const tenantDb = new TenantPrismaClient({ adapter });
    try {
      await tenantDb.utilizador.create({
        data: {
          email: adminEmail.trim().toLowerCase(),
          nome: adminNome,
          perfil: "ADMINISTRADOR",
          estado: "ATIVO",
          passwordHash,
          mustChangePassword: true,
        },
      });
      if (farmaciaInicial) {
        console.log(`▶ A criar farmácia inicial "${farmaciaInicial}"…`);
        const f = await tenantDb.farmacia.create({
          data: { nome: farmaciaInicial, estado: "ATIVO" },
          select: { id: true },
        });
        farmaciaInicialId = f.id;
      }
    } finally {
      await tenantDb.$disconnect();
    }

    // Marcar ACTIVE
    await controlPrisma.tenant.update({
      where: { id: tenant.id },
      data: {
        estado: "ACTIVE",
        provisionedAt: new Date(),
        schemaVersion: getLatestMigrationName(),
      },
    });

    // Audit
    await logTenantEvent({
      tenantId: tenant.id,
      action: "created",
      meta: { slug, nome, adminEmail, provider: provider.name },
    });

    console.log(`\n✓ Tenant "${slug}" provisionado com sucesso.`);
    console.log("─".repeat(60));
    console.log(`  Admin email    : ${adminEmail}`);
    console.log(`  Admin password : ${adminPassword}   ← MOSTRADO UMA VEZ`);
    const baseUrl = (
      process.env.PUBLIC_APP_URL ??
      process.env.NEXT_PUBLIC_APP_URL ??
      ""
    ).trim().replace(/\/+$/, "");
    console.log(
      `  Acesso         : ${baseUrl ? `${baseUrl}/login?__tenant=${slug}` : `(define PUBLIC_APP_URL) /login?__tenant=${slug}`}`
    );
    if (farmaciaInicial && farmaciaInicialId) {
      console.log(`  Farmácia       : ${farmaciaInicial}  (id=${farmaciaInicialId})`);
    }
    console.log("─".repeat(60));
    console.log("Comunica a password ao administrador. Será forçado a mudar no primeiro login.");
  } catch (err) {
    console.error("\n✗ Provisionamento falhou no meio. Tenant marcado como FAILED.");
    console.error("  DB e role ficam preservados para inspecção manual.");
    console.error(`  Para limpar: npm run tenancy:cleanup-failed -- --slug ${slug}`);
    await controlPrisma.tenant.update({
      where: { id: tenant.id },
      data: { estado: "FAILED" },
    });
    await logTenantEvent({
      tenantId: tenant.id,
      action: "provision_failed",
      meta: { error: err instanceof Error ? err.message : String(err), provider: provider.name },
    });
    throw err;
  } finally {
    await controlPrisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
