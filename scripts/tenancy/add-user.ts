/**
 * scripts/tenancy/add-user.ts
 *
 * Adiciona um utilizador a um tenant existente. Equivalente operacional
 * ao admin criado no `tenancy:create`, mas para adicionar mais
 * utilizadores depois.
 *
 * Resolve tenant via control plane, conecta à BD do tenant, valida que
 * email não existe, e insere `Utilizador` com `mustChangePassword=true`.
 * Para perfis não-ADMINISTRADOR, opcionalmente associa a uma farmácia
 * primária (e cria entry UtilizadorFarmacia para o N:M).
 *
 * Uso:
 *   npm run tenancy:add-user -- \
 *     --tenant demo-neon \
 *     --email user@example.pt \
 *     --nome "Maria Operadora" \
 *     --role OPERADOR \
 *     --farmacia "Farmácia Central"
 *
 *   # password é gerada e impressa UMA VEZ. Para forçar:
 *   npm run tenancy:add-user -- --tenant ... --password 'temp-pwd-123'
 *
 * Roles aceites (correspondem ao enum UtilizadorPerfil):
 *   ADMINISTRADOR | GESTOR_GRUPO | GESTOR_FARMACIA | OPERADOR
 *
 * Exit codes:
 *   0  OK
 *   1  Argumentos inválidos ou tenant inexistente
 *   2  Email já existe no tenant
 *   3  Farmácia indicada não encontrada
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
import { PrismaClient, type UtilizadorPerfil } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { requireControlEnv } from "./_shared";

const VALID_ROLES: UtilizadorPerfil[] = [
  "ADMINISTRADOR",
  "GESTOR_GRUPO",
  "GESTOR_FARMACIA",
  "OPERADOR",
];

type Args = {
  tenant?: string;
  email?: string;
  nome?: string;
  role?: string;
  farmacia?: string;
  password?: string;
};

function parseCmdArgs(): Args {
  const { values } = parseArgs({
    options: {
      tenant: { type: "string" },
      email: { type: "string" },
      nome: { type: "string" },
      role: { type: "string" },
      farmacia: { type: "string" },
      password: { type: "string" },
    },
    strict: true,
  });
  return {
    tenant: values.tenant,
    email: values.email,
    nome: values.nome,
    role: values.role,
    farmacia: values.farmacia,
    password: values.password,
  };
}

function generatePassword(bytes = 9): string {
  return randomBytes(bytes).toString("base64url");
}

async function main() {
  requireControlEnv();
  const args = parseCmdArgs();

  if (!args.tenant) {
    console.error("✗ --tenant <slug> é obrigatório.");
    process.exit(1);
  }
  if (!args.email || args.email.trim() === "") {
    console.error("✗ --email <email> é obrigatório.");
    process.exit(1);
  }
  if (!args.nome || args.nome.trim() === "") {
    console.error('✗ --nome "<Nome>" é obrigatório.');
    process.exit(1);
  }
  if (!args.role) {
    console.error(`✗ --role é obrigatório. Valores: ${VALID_ROLES.join(", ")}`);
    process.exit(1);
  }
  const role = args.role.toUpperCase();
  if (!(VALID_ROLES as string[]).includes(role)) {
    console.error(`✗ --role "${args.role}" inválido. Valores: ${VALID_ROLES.join(", ")}`);
    process.exit(1);
  }
  const email = args.email.trim().toLowerCase();
  const nome = args.nome.trim();
  if (nome.length > 200) {
    console.error("✗ --nome deve ter ≤ 200 caracteres.");
    process.exit(1);
  }

  const tenant = await getTenantBySlug(args.tenant);
  if (!tenant) {
    console.error(`✗ Tenant "${args.tenant}" não existe no control plane.`);
    console.error("  Lista tenants com 'npm run tenancy:list'.");
    process.exit(1);
  }
  if (tenant.estado !== "ACTIVE") {
    console.error(`✗ Tenant "${args.tenant}" está em ${tenant.estado}. Só ACTIVE aceita utilizadores.`);
    process.exit(1);
  }

  const url = buildTenantConnectionString(tenant);
  const adapter = new PrismaPg({ connectionString: url });
  const prisma = new PrismaClient({ adapter });

  try {
    console.log("─".repeat(72));
    console.log(`add-user — ${tenant.slug}`);
    console.log("─".repeat(72));
    console.log(`Tenant       : ${tenant.nome} (id=${tenant.id})`);
    console.log(`DB           : ${tenant.dbName}@${tenant.dbHost}:${tenant.dbPort}`);
    console.log(`Email        : ${email}`);
    console.log(`Nome         : ${nome}`);
    console.log(`Role         : ${role}`);
    console.log(`Farmácia     : ${args.farmacia ?? "(nenhuma)"}`);
    console.log("");

    const existing = await prisma.utilizador.findUnique({
      where: { email },
      select: { id: true, perfil: true, estado: true },
    });
    if (existing) {
      console.error(`✗ Email "${email}" já existe (id=${existing.id}, perfil=${existing.perfil}, estado=${existing.estado}).`);
      console.error("  Para alterar usa SQL directo ou um futuro 'tenancy:update-user'.");
      process.exit(2);
    }

    let farmaciaId: string | null = null;
    if (args.farmacia) {
      const farmacia = await prisma.farmacia.findFirst({
        where: { OR: [{ id: args.farmacia }, { nome: args.farmacia }] },
        select: { id: true, nome: true },
      });
      if (!farmacia) {
        console.error(`✗ Farmácia "${args.farmacia}" não encontrada (procurei por id e por nome).`);
        process.exit(3);
      }
      farmaciaId = farmacia.id;
      console.log(`  → farmácia resolvida: ${farmacia.nome} (id=${farmacia.id})`);
    } else if (role !== "ADMINISTRADOR" && role !== "GESTOR_GRUPO") {
      console.warn(`  ⚠  ${role} sem --farmacia: utilizador sem contexto primário; tem de ser associado via SQL antes de usar.`);
    }

    // Sem `.trim()` — ver lib/password-policy.ts. O trim aparava o valor
    // que ia ser cifrado, e o login compara sem aparar.
    const fornecida = typeof args.password === "string" && args.password.length > 0;
    const password = fornecida ? (args.password as string) : generatePassword();
    const passwordGenerated = !args.password;
    const passwordHash = await bcrypt.hash(password, 10);

    const created = await prisma.$transaction(async (tx) => {
      const u = await tx.utilizador.create({
        data: {
          email,
          nome,
          perfil: role as UtilizadorPerfil,
          farmaciaId,
          estado: "ATIVO",
          passwordHash,
          mustChangePassword: true,
        },
        select: { id: true, email: true, nome: true, perfil: true, dataCriacao: true },
      });
      if (farmaciaId && role !== "ADMINISTRADOR") {
        await tx.utilizadorFarmacia.create({
          data: { utilizadorId: u.id, farmaciaId },
        });
      }
      return u;
    });

    console.log("");
    console.log("✓ Utilizador criado");
    console.log(`  id              : ${created.id}`);
    console.log(`  email           : ${created.email}`);
    console.log(`  nome            : ${created.nome}`);
    console.log(`  perfil          : ${created.perfil}`);
    console.log(`  dataCriacao     : ${created.dataCriacao.toISOString()}`);
    console.log(`  mustChange      : true (login força reset)`);
    console.log("");
    if (passwordGenerated) {
      console.log("Password (anotar AGORA — não é recuperável):");
      console.log(`  ${password}`);
      console.log("");
    } else {
      console.log("Password: usada a fornecida via --password (não impressa).");
      console.log("");
    }

    console.log("Próximos passos:");
    console.log(`  · Login em /login (com o slug "${tenant.slug}" no contexto)`);
    console.log(`  · Reset da password no primeiro login (mustChangePassword=true)`);
    console.log(`  · Ver estado: npm run tenancy:status -- --tenant ${tenant.slug}`);
  } finally {
    await prisma.$disconnect();
    await controlPrisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("[fatal]", err instanceof Error ? err.message : err);
  process.exit(1);
});
