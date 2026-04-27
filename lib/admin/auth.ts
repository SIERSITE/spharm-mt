import "server-only";
import { redirect } from "next/navigation";
import { getSession, LEGACY_TENANT, type SessionUser } from "@/lib/auth";

/**
 * lib/admin/auth.ts
 *
 * Permissão de "platform admin" — quem pode usar o /admin console.
 * Distinta da matriz de perfis dentro de um tenant; aqui é uma
 * autorização cross-tenant sobre a infraestrutura inteira.
 *
 * Modelo interim (até existir um login dedicado para GlobalAdmin):
 *   1. Sessão válida.
 *   2. session.perfil === "ADMINISTRADOR".
 *   3. session.email pertence a PLATFORM_ADMIN_EMAILS — env var
 *      com lista de emails separados por vírgula. Lower-case +
 *      trimmed antes de comparar.
 *   4. session.tenant === LEGACY_TENANT — o admin console só
 *      é acessível a partir do contexto não-tenant. Operar
 *      cross-tenant a partir de dentro de um tenant introduzia
 *      ambiguidade no resolver de getPrisma() e contradiz o
 *      próprio propósito do console.
 *
 * Falha em qualquer um dos quatro → redirect silencioso para
 * /dashboard (não vaza informação sobre por que razão falhou).
 */

export function listPlatformAdmins(): Set<string> {
  const raw = process.env.PLATFORM_ADMIN_EMAILS ?? "";
  const set = new Set<string>();
  for (const part of raw.split(",")) {
    const e = part.trim().toLowerCase();
    if (e) set.add(e);
  }
  return set;
}

export function isPlatformAdminSession(session: SessionUser | null): boolean {
  if (!session) return false;
  if (session.perfil !== "ADMINISTRADOR") return false;
  if (session.tenant !== LEGACY_TENANT) return false;
  const allowed = listPlatformAdmins();
  if (allowed.size === 0) return false;
  return allowed.has(session.email.toLowerCase());
}

export async function isPlatformAdmin(): Promise<boolean> {
  const session = await getSession();
  return isPlatformAdminSession(session);
}

/**
 * Gate para usar no topo de cada server component / server action
 * de /admin. Em sucesso devolve a sessão. Em falha redirecciona.
 */
export async function requirePlatformAdmin(): Promise<SessionUser> {
  const session = await getSession();
  if (!isPlatformAdminSession(session)) {
    redirect("/dashboard");
  }
  return session as SessionUser;
}
