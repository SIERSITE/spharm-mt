"use server";

import { revalidatePath } from "next/cache";
import bcrypt from "bcryptjs";
import { getPrisma } from "@/lib/prisma";
import { requireSession } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import {
  exigirGestaoUtilizadores,
  validarAlteracaoDePerfil,
  validarAlteracaoDeEstado,
} from "@/lib/utilizadores-guardas";

/**
 * Gestão de contas do tenant.
 *
 * ─────────────────────────────────────────────────────────────────────
 * TODAS AS ACÇÕES DESTE FICHEIRO SÃO EXCLUSIVAS DO `ADMINISTRADOR`
 *
 * Cada uma começa com `requireSession()` seguido de
 * `exigirGestaoUtilizadores()`, e devolve a recusa ANTES de tocar em
 * Prisma. Não é o botão escondido que protege isto: uma server action é
 * um endpoint HTTP e pode ser chamada directamente, sem passar pela
 * página. A página esconder o menu é conveniência; a recusa aqui é a
 * defesa.
 *
 * O que um GESTOR_GRUPO pode fazer à sua conta — trocar a password —
 * não vive aqui. Vive em `app/alterar-password/`, que exige a password
 * actual e só mexe na conta da própria sessão.
 */
type Perfil = "ADMINISTRADOR" | "GESTOR_GRUPO" | "GESTOR_FARMACIA" | "OPERADOR";

/** Administradores ATIVOS, para as guardas de despromoção/desactivação. */
async function contarAdministradoresAtivos(
  prisma: Awaited<ReturnType<typeof getPrisma>>,
): Promise<number> {
  return prisma.utilizador.count({
    where: { perfil: "ADMINISTRADOR", estado: "ATIVO" },
  });
}

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
  const session = await requireSession();
  const portao = exigirGestaoUtilizadores(session.perfil);
  if (!portao.ok) return { ok: false as const, error: portao.erro };

  if (!input.email || !input.nome) {
    return { ok: false as const, error: "Email e nome são obrigatórios." };
  }
  if (!input.password || input.password.length < 8) {
    return { ok: false as const, error: "Password deve ter pelo menos 8 caracteres." };
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
  const session = await requireSession();
  const portao = exigirGestaoUtilizadores(session.perfil);
  if (!portao.ok) return { ok: false as const, error: portao.erro };

  if (!input.id) return { ok: false as const, error: "ID em falta." };

  const prisma = await getPrisma();

  // O perfil ACTUAL do alvo é preciso para decidir se esta alteração
  // deixa o tenant sem administração. Vem da base, não do formulário:
  // o que o formulário diz que o alvo era pode estar desactualizado, e
  // é justamente o campo que a guarda tem de julgar.
  const alvo = await prisma.utilizador.findUnique({
    where: { id: input.id },
    select: { id: true, perfil: true, estado: true },
  });
  if (!alvo) return { ok: false as const, error: "Utilizador não encontrado." };

  const perfilOk = validarAlteracaoDePerfil({
    actorId: session.sub,
    actorPerfil: session.perfil,
    alvoId: alvo.id,
    alvoPerfilActual: alvo.perfil,
    perfilPedido: input.perfil,
    totalAdministradoresAtivos: await contarAdministradoresAtivos(prisma),
  });
  if (!perfilOk.ok) return { ok: false as const, error: perfilOk.erro };

  const estadoOk = validarAlteracaoDeEstado({
    actorId: session.sub,
    alvoId: alvo.id,
    alvoPerfil: alvo.perfil,
    estadoPedido: input.estado,
    totalAdministradoresAtivos: await contarAdministradoresAtivos(prisma),
  });
  if (!estadoOk.ok) return { ok: false as const, error: estadoOk.erro };

  try {
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
  const session = await requireSession();
  const portao = exigirGestaoUtilizadores(session.perfil);
  if (!portao.ok) return { ok: false as const, error: portao.erro };

  const prisma = await getPrisma();
  const current = await prisma.utilizador.findUnique({
    where: { id },
    select: { estado: true, email: true, perfil: true },
  });
  if (!current) return { ok: false as const, error: "Utilizador não encontrado." };
  const next = current.estado === "ATIVO" ? "INATIVO" : "ATIVO";

  const estadoOk = validarAlteracaoDeEstado({
    actorId: session.sub,
    alvoId: id,
    alvoPerfil: current.perfil,
    estadoPedido: next,
    totalAdministradoresAtivos: await contarAdministradoresAtivos(prisma),
  });
  if (!estadoOk.ok) return { ok: false as const, error: estadoOk.erro };

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
  const session = await requireSession();
  const portao = exigirGestaoUtilizadores(session.perfil);
  if (!portao.ok) return { ok: false as const, error: portao.erro };

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
