/**
 * scripts/tenancy/provision-tenant.ts
 *
 * Cria um novo tenant (grupo de farmácias):
 *   1. Valida argumentos
 *   2. Confirma que o slug está livre no control plane
 *   3. Gera credenciais DB (user + random password + dbName)
 *   4. CREATE ROLE + CREATE DATABASE + GRANT CONNECT
 *   5. Insere Tenant (estado=PROVISIONING) no control plane
 *   6. `prisma migrate deploy` contra a nova DB
 *   7. Seed: cria 1 Utilizador ADMINISTRADOR
 *   8. Marca Tenant como ACTIVE
 *   9. Regista TenantEvent "created"
 *
 * Rollback:
 *   · Erro nos passos 4-5 → cleanup completo (DROP DB + DROP ROLE)
 *   · Erro nos passos 6-8 → tenant fica em FAILED para inspecção
 *     manual. Razão: já há dados que podem ser úteis para debug.
 *
 * Uso:
 *   npm run tenancy:provision -- \
 *     --slug farmacias-braga \
 *     --nome "Grupo Farmácias de Braga" \
 *     --admin-email admin@braga.pt \
 *     [--admin-password <plain>] \
 *     [--admin-nome "Admin Braga"]
 *
 * Se --admin-password não for passada, é gerada e impressa UMA VEZ.
 */

import "dotenv/config";
import { parseArgs } from "node:util";
import bcrypt from "bcryptjs";
import { PrismaClient as TenantPrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { controlPrisma, logTenantEvent } from "@/lib/control-plane";
import { encryptTenantSecret } from "@/lib/tenant-crypto";
import {
  SLUG_REGEX,
  requireControlEnv,
  requireAdminEnv,
  slugToDbNames,
  generatePassword,
  openAdminClient,
  quoteIdent,
  quoteLiteral,
  buildPgUrl,
  runPrismaForTenant,
  getLatestMigrationName,
} from "./_shared";

async function main() {
  requireControlEnv();
  requireAdminEnv();

  const { values } = parseArgs({
    options: {
      slug: { type: "string" },
      nome: { type: "string" },
      "admin-email": { type: "string" },
      "admin-password": { type: "string" },
      "admin-nome": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  const slug = values.slug;
  const nome = values.nome;
  const adminEmail = values["admin-email"];
  const adminNome = values["admin-nome"] ?? "Administrador";
  let adminPassword = values["admin-password"];

  if (!slug || !nome || !adminEmail) {
    console.error(
      "Uso: --slug X --nome \"Y\" --admin-email E [--admin-password P] [--admin-nome N]"
    );
    process.exit(1);
  }
  if (!SLUG_REGEX.test(slug)) {
    console.error(`slug inválido: "${slug}" — tem de bater /^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$/`);
    process.exit(1);
  }

  // Passo 2 — slug livre?
  const existing = await controlPrisma.tenant.findUnique({ where: { slug } });
  if (existing) {
    console.error(`Slug já usado pelo tenant id=${existing.id} (estado=${existing.estado}).`);
    process.exit(1);
  }

  // Passo 3 — credenciais
  const { dbUser, dbName } = slugToDbNames(slug);
  const dbPassword = generatePassword();
  if (!adminPassword) {
    adminPassword = generatePassword(12);
  }

  const dbHost = process.env.TENANT_DB_HOST!;
  const dbPort = Number(process.env.TENANT_DB_PORT ?? 5432);

  console.log(`▶ Provisionamento do tenant "${slug}"`);
  console.log(`  dbHost : ${dbHost}:${dbPort}`);
  console.log(`  dbName : ${dbName}`);
  console.log(`  dbUser : ${dbUser}`);

  // Passo 4 — CREATE ROLE + DATABASE
  console.log("▶ A criar role + database no Postgres…");
  const admin = await openAdminClient();
  let dbRoleCreated = false;
  let dbCreated = false;
  try {
    await admin.query(
      `CREATE ROLE ${quoteIdent(dbUser)} LOGIN PASSWORD ${quoteLiteral(dbPassword)}`
    );
    dbRoleCreated = true;
    await admin.query(`CREATE DATABASE ${quoteIdent(dbName)} OWNER ${quoteIdent(dbUser)}`);
    dbCreated = true;
    await admin.query(`REVOKE CONNECT ON DATABASE ${quoteIdent(dbName)} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${quoteIdent(dbName)} TO ${quoteIdent(dbUser)}`);
  } catch (err) {
    // Cleanup total — ainda não tocámos no control plane.
    console.error("✗ Falha a criar role/database. Cleanup parcial…");
    if (dbCreated) {
      try {
        await admin.query(`DROP DATABASE ${quoteIdent(dbName)}`);
      } catch {}
    }
    if (dbRoleCreated) {
      try {
        await admin.query(`DROP ROLE ${quoteIdent(dbUser)}`);
      } catch {}
    }
    await admin.end();
    throw err;
  }
  await admin.end();

  // Passo 5 — registar no control plane
  console.log("▶ A registar no control plane…");
  const tenant = await controlPrisma.tenant.create({
    data: {
      slug,
      nome,
      estado: "PROVISIONING",
      dbHost,
      dbPort,
      dbName,
      dbUser,
      dbPassEncrypted: encryptTenantSecret(dbPassword),
    },
  });

  // A partir daqui, qualquer erro marca FAILED (não apaga dados).
  try {
    // Passo 6 — migrations
    console.log("▶ A aplicar migrations (prisma migrate deploy)…");
    const tenantUrl = buildPgUrl({ host: dbHost, port: dbPort, dbName, user: dbUser, password: dbPassword });
    const migrateResult = runPrismaForTenant(
      ["migrate", "deploy", "--schema", "prisma/schema.prisma"],
      tenantUrl
    );
    if (migrateResult.status !== 0) {
      throw new Error(
        `prisma migrate deploy falhou (exit ${migrateResult.status}):\n${migrateResult.stderr ?? ""}`
      );
    }
    process.stdout.write(migrateResult.stdout ?? "");

    // Passo 7 — seed admin via PrismaClient do tenant
    console.log("▶ A criar utilizador administrador inicial…");
    const passwordHash = await bcrypt.hash(adminPassword, 10);
    const adapter = new PrismaPg({ connectionString: tenantUrl });
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
    } finally {
      await tenantDb.$disconnect();
    }

    // Passo 8 — marcar ACTIVE
    await controlPrisma.tenant.update({
      where: { id: tenant.id },
      data: {
        estado: "ACTIVE",
        provisionedAt: new Date(),
        schemaVersion: getLatestMigrationName(),
      },
    });

    // Passo 9 — audit
    await logTenantEvent({
      tenantId: tenant.id,
      action: "created",
      meta: { slug, nome, adminEmail },
    });

    console.log(`\n✓ Tenant "${slug}" provisionado com sucesso.`);
    console.log("─".repeat(60));
    console.log(`  Admin email    : ${adminEmail}`);
    console.log(`  Admin password : ${adminPassword}   ← MOSTRADO UMA VEZ`);
    console.log(`  Subdomain      : ${slug}.spharmmt.app (ou o teu host)`);
    console.log("─".repeat(60));
    console.log("Comunica a password ao administrador. Será forçado a mudar no primeiro login.");
  } catch (err) {
    console.error("\n✗ Provisionamento falhou no meio. Tenant marcado como FAILED.");
    console.error("  DB e role ficam preservados para inspecção manual.");
    console.error("  Para limpar: npm run tenancy:destroy -- --slug " + slug);
    await controlPrisma.tenant.update({
      where: { id: tenant.id },
      data: { estado: "FAILED" },
    });
    await logTenantEvent({
      tenantId: tenant.id,
      action: "provision_failed",
      meta: { error: err instanceof Error ? err.message : String(err) },
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
