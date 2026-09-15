/**
 * lib/permissions-core.ts
 *
 * A matriz de RBAC e as guardas PURAS (`can`, `canAccessFarmaciaSync`),
 * separadas de `lib/permissions.ts` para poderem ser importadas sem
 * arrastar `"server-only"` — mesmo padrão de `lib/utilizadores-guardas.ts`
 * (regras puras testáveis sem BD/rede, chamadas a sério pelas server
 * actions e também exercitadas directamente pelos testes).
 *
 * `lib/permissions.ts` continua a ser o ponto de entrada público
 * (`requireSession`/`requirePermission`, que precisam de `next/headers`
 * via `getSession`) e reexporta tudo daqui — nenhum import existente
 * de `@/lib/permissions` precisa de mudar.
 */
import type { SessionUser } from "@/lib/session-claims";

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
  | "catalog.read"
  | "stock.sync";            // botão "Sincronizar agora" em /stock (Bloco E)

/**
 * ── PORQUE É QUE O `GESTOR_GRUPO` SAIU DAQUI ──────────────────────────
 *
 * `users.manage` e `users.view` incluíam o GESTOR_GRUPO. A única coisa
 * que o distinguia de um ADMINISTRADOR era uma linha no
 * `updateUtilizador` a proibi-lo de ATRIBUIR o perfil ADMINISTRADOR.
 * Podia, com tudo o resto: editar qualquer conta, repor a password de
 * qualquer pessoa, desactivar contas, e DESPROMOVER um administrador —
 * o que lhe permitia tirar do caminho quem o pudesse travar.
 *
 * `users.manage` e `users.view` passam a ser exclusivos do
 * ADMINISTRADOR. O que sobra ao GESTOR_GRUPO é o trabalho do grupo:
 * relatórios, encomendas, catálogo, configuração — e a sua própria
 * password, que não passa por aqui porque não é gestão de utilizadores.
 */
const PERMISSIONS: Record<Permission, Perfil[]> = {
  "users.manage": ["ADMINISTRADOR"],
  "users.view": ["ADMINISTRADOR"],
  "settings.global": ["ADMINISTRADOR", "GESTOR_GRUPO"],
  "settings.farmacia": ["ADMINISTRADOR", "GESTOR_GRUPO", "GESTOR_FARMACIA"],
  "reports.write": ["ADMINISTRADOR", "GESTOR_GRUPO", "GESTOR_FARMACIA"],
  "reports.read": ["ADMINISTRADOR", "GESTOR_GRUPO", "GESTOR_FARMACIA", "OPERADOR"],
  "catalog.write": ["ADMINISTRADOR", "GESTOR_GRUPO"],
  "catalog.read": ["ADMINISTRADOR", "GESTOR_GRUPO", "GESTOR_FARMACIA", "OPERADOR"],
  // Dispara uma execução real no agent on-prem da farmácia (Bloco E).
  // Mesma lista que "settings.farmacia": quem já pode mexer na
  // configuração da farmácia pode também pedir-lhe uma sincronização.
  // OPERADOR fica de fora — é o único perfil estritamente só-leitura
  // (ver `lib/permissions.ts`) e "sincronizar agora" é uma acção, não
  // uma leitura.
  "stock.sync": ["ADMINISTRADOR", "GESTOR_GRUPO", "GESTOR_FARMACIA"],
};

export function can(session: SessionUser | null, perm: Permission): boolean {
  if (!session) return false;
  const allowed = PERMISSIONS[perm];
  return allowed.includes(session.perfil as Perfil);
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
