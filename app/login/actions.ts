"use server";

import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getPrisma } from "@/lib/prisma";
import { createSessionToken, LEGACY_TENANT } from "@/lib/auth";
import { resolveCurrentTenantSlug } from "@/lib/tenant-context";

type LoginState = {
  error: string;
};

export async function loginAction(
  _prevState: LoginState,
  formData: FormData
): Promise<LoginState> {
  const email = String(formData.get("email") || "")
    .trim()
    .toLowerCase();
  const password = String(formData.get("password") || "").trim();

  if (!email || !password) {
    return { error: "Preencha o email e a password." };
  }

  const prisma = await getPrisma();
  const utilizador = await prisma.utilizador.findUnique({
    where: { email },
  });

  if (!utilizador || !utilizador.passwordHash || utilizador.estado !== "ATIVO") {
    return { error: "Credenciais inválidas." };
  }

  const passwordOk = await bcrypt.compare(password, utilizador.passwordHash);

  if (!passwordOk) {
    return { error: "Credenciais inválidas." };
  }

  // Vincula a sessão ao tenant em que o login foi efectuado. Em cada
  // request autenticado, getSession() compara este claim com o tenant
  // resolvido do request — mismatch devolve null e força novo login.
  const tenant = (await resolveCurrentTenantSlug()) ?? LEGACY_TENANT;

  const token = await createSessionToken({
    sub: utilizador.id,
    email: utilizador.email,
    nome: utilizador.nome,
    perfil: utilizador.perfil,
    farmaciaId: utilizador.farmaciaId ?? null,
    tenant,
  });

  const cookieStore = await cookies();
  cookieStore.set("session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    path: "/",
    maxAge: 60 * 60 * 8,
  });

  redirect("/dashboard");
}