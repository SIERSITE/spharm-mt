import "server-only";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { getTenantPrismaForAdmin } from "@/lib/admin/tenant-client";
import { AdminApiError, resolveActiveTenant } from "@/lib/admin/ops/_shared";
import type { UtilizadorPerfil } from "@/generated/prisma/client";

/**
 * lib/admin/ops/add-user.ts
 *
 * Equivalente HTTP de `scripts/tenancy/add-user.ts` (DEV CLI).
 * Resolve tenant ACTIVE → valida email único → resolve farmácia
 * (opcional) → INSERT Utilizador (mustChangePassword=true) + link N:M.
 * Se a password for gerada, devolve-a UMA vez (o caller mostra modal).
 */

const VALID_ROLES: UtilizadorPerfil[] = [
  "ADMINISTRADOR",
  "GESTOR_GRUPO",
  "GESTOR_FARMACIA",
  "OPERADOR",
];

export type AddUserInput = {
  slug: string;
  email: string;
  nome: string;
  role: string;
  farmacia?: string | null;
  password?: string | null;
};

export type AddUserResult = {
  tenantSlug: string;
  created: {
    id: string;
    email: string;
    nome: string;
    perfil: string;
    dataCriacao: string;
  };
  passwordGenerated: boolean;
  /** Só presente quando passwordGenerated=true. Não recuperável depois. */
  password: string | null;
};

function generatePassword(bytes = 9): string {
  return randomBytes(bytes).toString("base64url");
}

export async function addUser(input: AddUserInput): Promise<AddUserResult> {
  const email = (input.email ?? "").trim().toLowerCase();
  const nome = (input.nome ?? "").trim();
  if (email === "") throw new AdminApiError(400, "email é obrigatório", "bad_request");
  if (!email.includes("@")) throw new AdminApiError(400, "email inválido", "bad_request");
  if (nome === "") throw new AdminApiError(400, "nome é obrigatório", "bad_request");
  if (nome.length > 200) {
    throw new AdminApiError(400, "nome deve ter ≤ 200 caracteres", "bad_request");
  }
  const role = (input.role ?? "").toUpperCase();
  if (!(VALID_ROLES as string[]).includes(role)) {
    throw new AdminApiError(
      400,
      `role inválido. Valores: ${VALID_ROLES.join(", ")}`,
      "bad_request"
    );
  }

  const tenant = await resolveActiveTenant(input.slug);
  const prisma = getTenantPrismaForAdmin(tenant);

  const existing = await prisma.utilizador.findUnique({
    where: { email },
    select: { id: true, perfil: true, estado: true },
  });
  if (existing) {
    throw new AdminApiError(
      409,
      `email "${email}" já existe (id=${existing.id}, perfil=${existing.perfil})`,
      "duplicate"
    );
  }

  let farmaciaId: string | null = null;
  const farmaciaRef = input.farmacia?.trim();
  if (farmaciaRef) {
    const farmacia = await prisma.farmacia.findFirst({
      where: { OR: [{ id: farmaciaRef }, { nome: farmaciaRef }] },
      select: { id: true },
    });
    if (!farmacia) {
      throw new AdminApiError(
        404,
        `farmácia "${farmaciaRef}" não encontrada (por id e por nome)`,
        "farmacia_not_found"
      );
    }
    farmaciaId = farmacia.id;
  }

  const password = input.password?.trim() || generatePassword();
  const passwordGenerated = !input.password?.trim();
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
      select: {
        id: true,
        email: true,
        nome: true,
        perfil: true,
        dataCriacao: true,
      },
    });
    if (farmaciaId && role !== "ADMINISTRADOR") {
      await tx.utilizadorFarmacia.create({
        data: { utilizadorId: u.id, farmaciaId },
      });
    }
    return u;
  });

  return {
    tenantSlug: tenant.slug,
    created: {
      id: created.id,
      email: created.email,
      nome: created.nome,
      perfil: created.perfil,
      dataCriacao: created.dataCriacao.toISOString(),
    },
    passwordGenerated,
    password: passwordGenerated ? password : null,
  };
}
