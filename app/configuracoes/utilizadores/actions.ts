"use server";

import { revalidatePath } from "next/cache";
import bcrypt from "bcryptjs";
import { getPrisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";

type Perfil = "ADMINISTRADOR" | "GESTOR_GRUPO" | "GESTOR_FARMACIA" | "OPERADOR";

export type UpsertUtilizadorInput = {
  id?: string;
  email: string;
  nome: string;
  perfil: Perfil;
  /** Primária (opcional para perfis de grupo). */
  farmaciaId: string | null;
  /** Farmácias adicionais (além da primária). */
  farmaciaIdsExtra: string[];
  /** Só obrigatório na criação; no update fica vazio significa manter. */
  password?: string;
  mustChangePassword?: boolean;
  estado: "ATIVO" | "INATIVO";
};

function randomPassword(len = 12): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

export async function createUtilizador(input: UpsertUtilizadorInput) {
  const session = await requirePermission("users.manage");
  if (!input.email || !input.nome) {
    return { ok: false as const, error: "Email e nome são obrigatórios." };
  }
  if (!input.password || input.password.length < 8) {
    return { ok: false as const, error: "Password deve ter pelo menos 8 caracteres." };
  }

  // GESTOR_GRUPO não pode criar ADMINISTRADOR
  if (session.perfil !== "ADMINISTRADOR" && input.perfil === "ADMINISTRADOR") {
    return { ok: false as const, error: "Só um Administrador pode criar outro Administrador." };
  }

  const passwordHash = await bcrypt.hash(input.password, 10);
  try {
    const prisma = await getPrisma();
    const created = await prisma.utilizador.create({
      data: {
        email: input.email.trim().toLowerCase(),
        nome: input.nome.trim(),
        perfil: input.perfil,
        farmaciaId: input.farmaciaId,
        estado: input.estado,
        passwordHash,
        mustChangePassword: input.mustChangePassword ?? true,
        farmacias: {
          create: input.farmaciaIdsExtra.map((farmaciaId) => ({ farmaciaId })),
        },
      },
      select: { id: true, email: true, perfil: true },
    });
    await logAudit({
      actorId: session.sub,
      action: "user.created",
      entity: "Utilizador",
      entityId: created.id,
      meta: { email: created.email, perfil: created.perfil },
    });
    revalidatePath("/configuracoes/utilizadores");
    return { ok: true as const, id: created.id };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function updateUtilizador(input: UpsertUtilizadorInput) {
  const session = await requirePermission("users.manage");
  if (!input.id) return { ok: false as const, error: "ID em falta." };

  if (session.perfil !== "ADMINISTRADOR" && input.perfil === "ADMINISTRADOR") {
    return { ok: false as const, error: "Só um Administrador pode atribuir o perfil Administrador." };
  }

  try {
    const prisma = await getPrisma();
    await prisma.$transaction(async (tx) => {
      await tx.utilizador.update({
        where: { id: input.id! },
        data: {
          email: input.email.trim().toLowerCase(),
          nome: input.nome.trim(),
          perfil: input.perfil,
          farmaciaId: input.farmaciaId,
          estado: input.estado,
          ...(input.password && input.password.length >= 8
            ? { passwordHash: await bcrypt.hash(input.password, 10) }
            : {}),
          ...(input.mustChangePassword !== undefined
            ? { mustChangePassword: input.mustChangePassword }
            : {}),
        },
      });
      await tx.utilizadorFarmacia.deleteMany({ where: { utilizadorId: input.id! } });
      if (input.farmaciaIdsExtra.length > 0) {
        await tx.utilizadorFarmacia.createMany({
          data: input.farmaciaIdsExtra.map((farmaciaId) => ({
            utilizadorId: input.id!,
            farmaciaId,
          })),
        });
      }
    });
    await logAudit({
      actorId: session.sub,
      action: "user.updated",
      entity: "Utilizador",
      entityId: input.id,
      meta: { email: input.email, perfil: input.perfil, estado: input.estado },
    });
    revalidatePath("/configuracoes/utilizadores");
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function toggleEstadoUtilizador(id: string) {
  const session = await requirePermission("users.manage");
  const prisma = await getPrisma();
  const current = await prisma.utilizador.findUnique({
    where: { id },
    select: { estado: true, email: true },
  });
  if (!current) return { ok: false as const, error: "Utilizador não encontrado." };
  const next = current.estado === "ATIVO" ? "INATIVO" : "ATIVO";
  await prisma.utilizador.update({ where: { id }, data: { estado: next } });
  await logAudit({
    actorId: session.sub,
    action: next === "ATIVO" ? "user.activated" : "user.deactivated",
    entity: "Utilizador",
    entityId: id,
    meta: { email: current.email },
  });
  revalidatePath("/configuracoes/utilizadores");
  return { ok: true as const, estado: next };
}

export async function resetPasswordUtilizador(id: string) {
  const session = await requirePermission("users.manage");
  const temp = randomPassword(12);
  const passwordHash = await bcrypt.hash(temp, 10);
  const prisma = await getPrisma();
  await prisma.utilizador.update({
    where: { id },
    data: { passwordHash, mustChangePassword: true },
  });
  await logAudit({
    actorId: session.sub,
    action: "user.password_reset",
    entity: "Utilizador",
    entityId: id,
  });
  revalidatePath("/configuracoes/utilizadores");
  // A password temporária é devolvida ao admin — não é persistida em
  // claro e não é enviada por email nesta passagem. O admin mostra-a
  // ao utilizador e ele é forçado a mudar no próximo login.
  return { ok: true as const, temporaryPassword: temp };
}
