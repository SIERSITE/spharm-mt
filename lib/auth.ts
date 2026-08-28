import "server-only";
import { cookies } from "next/headers";
import { SignJWT } from "jose";
import { resolveCurrentTenantSlug } from "@/lib/tenant-context";
// O tipo e a verificacao vivem em `session-claims`, que nao importa
// `server-only` nem `next/headers`: e o unico modulo que o middleware
// (runtime Edge) tambem consegue importar. Assim ha UMA verificacao,
// partilhada, em vez de duas que podem divergir.
import {
  LEGACY_TENANT,
  segredoDaSessao,
  verificarToken,
  type SessionUser,
} from "@/lib/session-claims";

export { LEGACY_TENANT };
export type { SessionUser };

const secret = segredoDaSessao();

export async function createSessionToken(user: SessionUser) {
  return await new SignJWT({ ...user })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("8h")
    .sign(secret);
}

export async function verifySessionToken(token: string) {
  return verificarToken(token, secret);
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