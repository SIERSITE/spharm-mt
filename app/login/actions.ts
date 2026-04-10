"use server";

import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { createSessionToken } from "@/lib/auth";

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

  const token = await createSessionToken({
    sub: utilizador.id,
    email: utilizador.email,
    nome: utilizador.nome,
    perfil: utilizador.perfil,
    farmaciaId: utilizador.farmaciaId ?? null,
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