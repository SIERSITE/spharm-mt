"use server";

import bcrypt from "bcryptjs";
import { cookies, headers } from "next/headers";
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
  // ─────────────────────────────────────────────────────────────────
  // DIAGNÓSTICO TEMPORÁRIO — 2026-06-17
  //
  // Adicionado para investigar "Credenciais inválidas" em
  //   https://spharm-mt.vercel.app/login?__tenant=grupo-silveira
  // quando bcrypt local valida e middleware resolve correctamente
  // (probe headers confirmados: x-tenant-resolved=grupo-silveira).
  //
  // Loga sinais NÃO-SENSÍVEIS num único JSON estruturado por tentativa:
  //   · diagId, tenantHeader, sourceHeader  (de middleware)
  //   · connectedDb / connectedUser          (SELECT current_database()
  //                                            no PrismaClient devolvido
  //                                            por getPrisma — distingue
  //                                            tenant vs legacy)
  //   · email, pwdLength
  //   · userFound, userId, estado
  //   · hashPresent (boolean), hashAlgo (prefixo "$2b$10$" — algoritmo,
  //                                       NÃO o hash)
  //   · bcryptOk, bcryptError
  //   · mustChangePassword
  //
  // NUNCA loga: password, hash completo, connection string.
  //
  // Procurar nos Vercel logs com:  diag-login
  // REMOVER (este bloco + forward de x-tenant-source no middleware)
  // depois do diagnóstico concluído.
  // ─────────────────────────────────────────────────────────────────
  const diagId = Math.random().toString(36).slice(2, 8);
  const h = await headers();
  const tenantHeader = h.get("x-tenant-slug");
  const sourceHeader = h.get("x-tenant-source");
  const hostHeader = h.get("host");

  const email = String(formData.get("email") || "")
    .trim()
    .toLowerCase();
  const password = String(formData.get("password") || "").trim();

  if (!email || !password) {
    console.log(
      `[diag-login ${diagId}] empty email or password (emailLen=${email.length} pwdLen=${password.length})`,
    );
    return { error: "Preencha o email e a password." };
  }

  const prisma = await getPrisma();

  // SELECT current_database() — read-only, distingue legacy vs tenant
  // sem expor connection string (que tem a password).
  let connectedDb: string | null = null;
  let connectedUser: string | null = null;
  let connectErr: string | null = null;
  try {
    const rows = await prisma.$queryRaw<
      Array<{ db: string; usr: string }>
    >`SELECT current_database() AS db, current_user AS usr`;
    connectedDb = rows[0]?.db ?? null;
    connectedUser = rows[0]?.usr ?? null;
  } catch (e) {
    connectErr = e instanceof Error ? e.message.slice(0, 200) : String(e);
  }

  const utilizador = await prisma.utilizador.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      nome: true,
      perfil: true,
      farmaciaId: true,
      estado: true,
      passwordHash: true,
      mustChangePassword: true,
    },
  });

  const userFound = !!utilizador;
  const hashPresent = !!utilizador?.passwordHash;
  const hashAlgo =
    utilizador?.passwordHash?.slice(0, 7) ?? null; // "$2b$10$" — só metadata bcrypt

  let bcryptOk: boolean | null = null;
  let bcryptError: string | null = null;
  if (utilizador?.passwordHash) {
    try {
      bcryptOk = await bcrypt.compare(password, utilizador.passwordHash);
    } catch (e) {
      bcryptError = e instanceof Error ? e.message.slice(0, 200) : String(e);
    }
  }

  console.log(
    `[diag-login ${diagId}] ${JSON.stringify({
      tenantHeader,
      sourceHeader,
      hostHeader,
      connectedDb,
      connectedUser,
      connectErr,
      email,
      pwdLength: password.length,
      userFound,
      userId: utilizador?.id ?? null,
      estado: utilizador?.estado ?? null,
      hashPresent,
      hashAlgo,
      bcryptOk,
      bcryptError,
      mustChangePassword: utilizador?.mustChangePassword ?? null,
    })}`,
  );
  // ─────────────────── FIM DO DIAG TEMPORÁRIO ────────────────────

  if (
    !utilizador ||
    !utilizador.passwordHash ||
    utilizador.estado !== "ATIVO"
  ) {
    return { error: "Credenciais inválidas." };
  }

  if (bcryptOk !== true) {
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
