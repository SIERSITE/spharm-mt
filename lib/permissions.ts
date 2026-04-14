import "server-only";
import { redirect } from "next/navigation";
import { getSession, type SessionUser } from "@/lib/auth";

/**
 * RBAC mínimo para SPharm.MT. Perfis e o que cada um pode fazer:
 *
 *   ADMINISTRADOR    — tudo, incluindo gestão de utilizadores e config
 *                      global (SMTP, etc.). Acesso a todas as farmácias.
 *   GESTOR_GRUPO     — tudo em todas as farmácias do grupo, excepto
 *                      criar/apagar outros GESTOR_GRUPO/ADMINISTRADOR.
 *   GESTOR_FARMACIA  — tudo dentro da(s) sua(s) farmácia(s). Não pode
 *                      ver dados de outras farmácias.
 *   OPERADOR         — só leitura dentro da(s) sua(s) farmácia(s). Não
 *                      pode alterar configurações nem criar utilizadores.
 *
 * Matriz de permissões mapeada no objecto PERMISSIONS. Cada ponto de
 * controlo chama `can(session, "acao")` ou uma das helpers dedicadas.
 */

export type Perfil = "ADMINISTRADOR" | "GESTOR_GRUPO" | "GESTOR_FARMACIA" | "OPERADOR";

/** Acções nomeadas que podem ser verificadas no código. */
export type Permission =
  | "users.manage"           // criar / editar / desactivar / reset password
  | "users.view"             // ver lista
  | "settings.global"        // editar config global (SMTP, etc.)
  | "settings.farmacia"      // editar config da farmácia
  | "reports.write"          // poder gerar ordens/encomendas
  | "reports.read"           // ver relatórios
  | "catalog.write"          // editar Produto/Fabricante/etc.
  | "catalog.read";

const PERMISSIONS: Record<Permission, Perfil[]> = {
  "users.manage": ["ADMINISTRADOR", "GESTOR_GRUPO"],
  "users.view": ["ADMINISTRADOR", "GESTOR_GRUPO"],
  "settings.global": ["ADMINISTRADOR", "GESTOR_GRUPO"],
  "settings.farmacia": ["ADMINISTRADOR", "GESTOR_GRUPO", "GESTOR_FARMACIA"],
  "reports.write": ["ADMINISTRADOR", "GESTOR_GRUPO", "GESTOR_FARMACIA"],
  "reports.read": ["ADMINISTRADOR", "GESTOR_GRUPO", "GESTOR_FARMACIA", "OPERADOR"],
  "catalog.write": ["ADMINISTRADOR", "GESTOR_GRUPO"],
  "catalog.read": ["ADMINISTRADOR", "GESTOR_GRUPO", "GESTOR_FARMACIA", "OPERADOR"],
};

export function can(session: SessionUser | null, perm: Permission): boolean {
  if (!session) return false;
  const allowed = PERMISSIONS[perm];
  return allowed.includes(session.perfil as Perfil);
}

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

/**
 * Regra de visibilidade por farmácia. Devolve true se a sessão pode
 * ver dados da farmácia pedida. Regras:
 *   · ADMINISTRADOR / GESTOR_GRUPO → qualquer farmácia
 *   · GESTOR_FARMACIA / OPERADOR   → só farmácia primária ou associadas
 *     em UtilizadorFarmacia (verificação via BD — ver canAccessFarmacia)
 */
export function canAccessFarmaciaSync(
  session: SessionUser | null,
  farmaciaId: string
): boolean {
  if (!session) return false;
  if (session.perfil === "ADMINISTRADOR" || session.perfil === "GESTOR_GRUPO") return true;
  return session.farmaciaId === farmaciaId;
}
