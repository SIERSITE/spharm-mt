import "server-only";
import { redirect } from "next/navigation";
import { getSession, type SessionUser } from "@/lib/auth";
import { isPlatformAdminSession } from "@/lib/admin/auth";

/**
 * lib/integracao/acesso.ts
 *
 * A permissão «integration.read»: quem pode ver QUALQUER informação técnica
 * de integração (estado/versão/heartbeat do agent, filas, erros, chaves,
 * endpoints, estado detalhado das sincronizações, operações manuais).
 *
 * ── PORQUE NÃO É UM `Permission` DA MATRIZ DE PERFIS ─────────────────
 * A matriz de `lib/permissions-core.ts` dá permissões a PERFIS DO TENANT
 * (ADMINISTRADOR, GESTOR_GRUPO…). Esses perfis pertencem ao cliente: o
 * ADMINISTRADOR de um grupo cria utilizadores à vontade, com o email que
 * quiser. Nenhuma lista de perfis — nem de emails guardados na BD do
 * tenant — serve para separar «técnico da SIER» de «utilizador do cliente».
 *
 * ── O QUE SEPARA, DE FACTO ───────────────────────────────────────────
 * O mecanismo que já existia para o /admin (`isPlatformAdminSession`):
 *   1. perfil ADMINISTRADOR;
 *   2. sessão autenticada no contexto NÃO-tenant (claim LEGACY_TENANT).
 *      O cliente nunca controla essa base, e o middleware recusa um
 *      cookie de um contexto noutro (claim `tenant` ≠ host);
 *   3. email na env `PLATFORM_ADMIN_EMAILS` (configuração do servidor,
 *      nada de emails no código).
 *
 * Consequência deliberada: a informação de integração vive no console
 * `/admin` (cross-tenant, por tenant escolhido pelo técnico), nunca dentro
 * da app do tenant. Dentro do tenant ninguém — nem o ADMINISTRADOR do
 * cliente — tem esta permissão.
 *
 * Atribuição: acrescentar o email do técnico a `PLATFORM_ADMIN_EMAILS`
 * (servidor) e criar-lhe o utilizador ADMINISTRADOR na base do contexto
 * não-tenant. Retirar = remover o email da env (efeito no próximo pedido).
 */
export function podeVerIntegracao(session: SessionUser | null): boolean {
  return isPlatformAdminSession(session);
}

/**
 * Gate de páginas e server actions. Sem permissão → /dashboard (mesmo
 * padrão do resto da app; não revela porque falhou).
 */
export async function requireIntegracao(): Promise<SessionUser> {
  const session = await getSession();
  if (!session || !podeVerIntegracao(session)) redirect("/dashboard");
  return session;
}
