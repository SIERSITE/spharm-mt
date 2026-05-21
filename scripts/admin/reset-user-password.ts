/**
 * scripts/admin/reset-user-password.ts
 *
 * Reset administrativo da password de um utilizador EXISTENTE no tenant.
 * NÃO cria utilizador — falha se o email não existir. Actualiza o
 * `passwordHash` (bcrypt cost 10) e marca `mustChangePassword=true` para
 * forçar troca no primeiro login.
 *
 * O utilizador vive na BD do TENANT (model `Utilizador`, email @unique).
 * O login (app/login/actions.ts) valida: estado=ATIVO + passwordHash +
 * bcrypt.compare. Por isso este reset corrige "Credenciais inválidas"
 * causadas por password errada/desconhecida.
 *
 * Uso (dev/trusted):
 *   npm run admin:reset-user-password -- \
 *     --tenant grupo-silveira \
 *     --email grp.cc.spharm@sier.pt
 *
 *   # password manual (em vez de gerada):
 *   ... -- --tenant <slug> --email <e> --password 'TempPwd123'
 *
 *   # reactivar se estado != ATIVO (login exige ATIVO):
 *   ... -- --tenant <slug> --email <e> --activate
 *
 * Exit codes: 0 OK · 1 args/tenant inválido · 3 utilizador não existe.
 */

import "dotenv/config";
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import {
  controlPrisma,
  getTenantBySlug,
  buildTenantConnectionString,
} from "@/lib/control-plane";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

function genPassword(bytes = 12): string {
  // base64url: URL-safe, ~16 chars para 12 bytes. Sem ambiguidade de aspas.
  return randomBytes(bytes).toString("base64url");
}

async function main() {
  const { values } = parseArgs({
    options: {
      tenant: { type: "string" },
      email: { type: "string" },
      password: { type: "string" },
      activate: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (!values.tenant) {
    console.error("✗ --tenant <slug> é obrigatório.");
    process.exit(1);
  }
  if (!values.email || values.email.trim() === "") {
    console.error("✗ --email <email> é obrigatório.");
    process.exit(1);
  }
  const email = values.email.trim().toLowerCase();

  const tenant = await getTenantBySlug(values.tenant);
  if (!tenant) {
    console.error(`✗ Tenant "${values.tenant}" não existe no control plane.`);
    process.exit(1);
  }
  if (tenant.estado !== "ACTIVE") {
    console.error(`✗ Tenant "${values.tenant}" está em ${tenant.estado} (esperado ACTIVE).`);
    process.exit(1);
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: buildTenantConnectionString(tenant) }),
  });

  try {
    const existing = await prisma.utilizador.findUnique({
      where: { email },
      select: { id: true, email: true, nome: true, perfil: true, estado: true, mustChangePassword: true },
    });
    if (!existing) {
      console.error(`✗ Utilizador "${email}" não existe no tenant "${tenant.slug}".`);
      console.error(`  (Reset não cria utilizadores — usa 'tenancy:add-user' para criar.)`);
      process.exit(3);
    }

    console.log("─".repeat(72));
    console.log(`reset-user-password — ${tenant.slug}`);
    console.log("─".repeat(72));
    console.log(`Utilizador  : ${existing.email} (id=${existing.id})`);
    console.log(`Nome        : ${existing.nome}`);
    console.log(`Perfil      : ${existing.perfil}`);
    console.log(`Estado      : ${existing.estado}${existing.estado !== "ATIVO" ? "  ⚠ login exige ATIVO" : ""}`);
    console.log("");

    const password = values.password?.trim() || genPassword();
    const passwordGenerated = !values.password?.trim();
    const passwordHash = await bcrypt.hash(password, 10);

    const willActivate = values.activate && existing.estado !== "ATIVO";

    const updated = await prisma.utilizador.update({
      where: { id: existing.id },
      data: {
        passwordHash,
        mustChangePassword: true,
        ...(willActivate ? { estado: "ATIVO" } : {}),
      },
      select: { id: true, email: true, estado: true, mustChangePassword: true },
    });

    console.log("✓ Password reposta (utilizador existente — NÃO foi criado novo)");
    console.log(`  estado            : ${updated.estado}${willActivate ? " (reactivado via --activate)" : ""}`);
    console.log(`  mustChangePassword: ${updated.mustChangePassword}`);
    console.log("");
    if (passwordGenerated) {
      console.log("Password temporária (anotar AGORA — não é recuperável):");
      console.log(`  ${password}`);
    } else {
      console.log("Password: usada a fornecida via --password.");
    }
    console.log("");

    if (updated.estado !== "ATIVO") {
      console.log("⚠ ATENÇÃO: estado != ATIVO — o login vai continuar a falhar.");
      console.log("  Re-correr com --activate para reactivar o utilizador.");
      console.log("");
    }

    console.log("Login:");
    console.log(`  1. Abrir o SaaS NO SUBDOMÍNIO do tenant:`);
    console.log(`       https://${tenant.slug}.<dominio-base>/login`);
    console.log(`     O tenant é resolvido pelo SUBDOMÍNIO do Host (middleware.ts).`);
    console.log(`     NÃO usar o URL base/app — resolve para a BD legacy e dá`);
    console.log(`     "Credenciais inválidas" mesmo com a password correcta.`);
    console.log(`     (?__tenant=${tenant.slug} só funciona em DEV, NODE_ENV!=production.)`);
    console.log(`  2. Email: ${updated.email}`);
    console.log(`  3. Password: a temporária acima.`);
    console.log(`  4. Será forçado a definir nova password (mustChangePassword=true).`);
  } finally {
    await prisma.$disconnect();
    await controlPrisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("[fatal]", err instanceof Error ? err.message : err);
  process.exit(1);
});
