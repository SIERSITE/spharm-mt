import "server-only";
import { redirect } from "next/navigation";
import { getSession, type SessionUser } from "@/lib/auth";
import { can, type Perfil, type Permission } from "@/lib/permissions-core";

/**
 * RBAC mínimo para SPharm.MT. Perfis e o que cada um pode fazer:
 *
 *   ADMINISTRADOR    — tudo, incluindo gestão de utilizadores e config
 *                      global (SMTP, etc.). Acesso a todas as farmácias.
 *                      É o ÚNICO perfil que gere utilizadores.
 *   GESTOR_GRUPO     — tudo em todas as farmácias do grupo, MENOS a
 *                      gestão de utilizadores: não cria, não edita, não
 *                      desactiva, não repõe passwords, não atribui
 *                      perfis — nem a terceiros nem a si próprio. A
 *                      única conta em que pode mexer é a sua password,
 *                      em /alterar-password.
 *   GESTOR_FARMACIA  — tudo dentro da(s) sua(s) farmácia(s). Não pode
 *                      ver dados de outras farmácias.
 *   OPERADOR         — só leitura dentro da(s) sua(s) farmácia(s). Não
 *                      pode alterar configurações nem criar utilizadores.
 *
 * A matriz de permissões e as guardas puras (`can`, `canAccessFarmaciaSync`)
 * vivem em `lib/permissions-core.ts` — sem `"server-only"`, para serem
 * importáveis por testes (e, se algum dia precisar, por client
 * components) sem arrastar `next/headers`. Este ficheiro é o ponto de
 * entrada público de sempre: reexporta a matriz e acrescenta as guardas
 * que PRECISAM de sessão/redirect (`requireSession`, `requirePermission`).
 */

export type { Perfil, Permission };
export { can, canAccessFarmaciaSync } from "@/lib/permissions-core";

/**
 * Exige uma sessão autenticada. Redirecciona para /login se não houver.
 * Devolve a sessão não-nula para uso subsequente.
 */
export async function requireSession(): Promise<SessionUser> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

/**
 * Exige uma permissão específica. Redirecciona para /dashboard (ou /login
 * se não houver sessão). Usar no topo dos server components.
 */
export async function requirePermission(perm: Permission): Promise<SessionUser> {
  const session = await requireSession();
  if (!can(session, perm)) {
    redirect("/dashboard");
  }
  return session;
}
