import "server-only";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { resolveCurrentTenantSlug } from "@/lib/tenant-context";

const secret = new TextEncoder().encode(
  process.env.AUTH_SECRET || "dev-secret-change-this"
);

/**
 * Sentinel usado no claim `tenant` da sessão quando o login foi feito
 * no contexto legacy (sem tenant slug no request). Mantém o claim como
 * string obrigatória — facilita a comparação exacta e evita comparar
 * null com null por acidente (uma sessão sem claim é rejeitada).
 */
export const LEGACY_TENANT = "__legacy__" as const;

export type SessionUser = {
  sub: string;
  email: string;
  nome: string;
  perfil: string;
  farmaciaId: string | null;
  /**
   * Tenant onde o login foi autenticado. "__legacy__" para logins em
   * localhost / sem subdomain / sem __tenant query param. Em cada
   * request autenticado o `getSession()` compara este claim com o
   * tenant corrente e recusa a sessão se não bater certo.
   */
  tenant: string;
};

export async function createSessionToken(user: SessionUser) {
  return await new SignJWT({ ...user })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("8h")
    .sign(secret);
}

export async function verifySessionToken(token: string) {
  try {
    const { payload } = await jwtVerify(token, secret);
    const user = payload as unknown as Partial<SessionUser>;
    if (!user || typeof user.sub !== "string" || typeof user.tenant !== "string") {
      return null;
    }
    return user as SessionUser;
  } catch {
    return null;
  }
}

/**
 * Devolve a sessão actual apenas se o tenant onde foi autenticada
 * coincidir com o tenant resolvido do request actual. Qualquer
 * mismatch (ex: cookie de login feito em legacy a ser usado em
 * grupo-demo.localhost) devolve null — o caller redirecciona para
 * /login, forçando re-autenticação no tenant correcto.
 *
 * O cookie fica no browser mas torna-se inerte: o próximo login
 * sobre-escreve-o com o claim certo. Não apagamos o cookie aqui
 * porque `getSession` é chamado em server components e nesses
 * contextos o `cookies()` é read-only (write só em actions/routes).
 */
export async function getSession() {
  const cookieStore = await cookies();
  const token = cookieStore.get("session")?.value;
  if (!token) return null;

  const session = await verifySessionToken(token);
  if (!session) return null;

  const currentTenant = (await resolveCurrentTenantSlug()) ?? LEGACY_TENANT;
  if (session.tenant !== currentTenant) {
    // Sessão válida mas ligada a outro tenant — tratar como inexistente.
    return null;
  }

  return session;
}