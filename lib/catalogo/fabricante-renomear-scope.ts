/**
 * lib/catalogo/fabricante-renomear-scope.ts
 *
 * Quem pode corrigir o NOME de um fabricante (ficha do artigo) e em que tenants.
 *
 * Puro (sem BD nem `server-only`): a página decide se mostra o botão e a
 * server action decide se recusa — com ESTA mesma função.
 *
 * Tenants: os que já têm a manutenção do catálogo (`TENANTS_CATALOGO_MANUTENCAO`
 * em `lib/tenant-constants.ts` = `silveira` e `garantia`). Não há lista nova:
 * um tenant que entre noutra decisão de catálogo não ganha isto por arrasto,
 * e quem editar aquela lista decide as duas coisas de propósito.
 *
 * O tenant vem SEMPRE do servidor: do claim `tenant` da sessão (assinado) que
 * tem de coincidir com o tenant resolvido do pedido (`x-tenant-slug`, escrito
 * pelo middleware). Nunca de um argumento enviado pelo browser.
 *
 * Permissão: `catalog.write` (ADMINISTRADOR e GESTOR_GRUPO).
 */
import { can } from "@/lib/permissions-core";
import type { SessionUser } from "@/lib/session-claims";
import { catalogoManutencaoAtiva } from "@/lib/tenant-constants";

export function podeRenomearFabricante(
  session: SessionUser | null,
  tenantDoPedido: string | null | undefined,
): boolean {
  if (!session) return false;
  if (!catalogoManutencaoAtiva(tenantDoPedido)) return false;
  if (session.tenant !== tenantDoPedido) return false;
  return can(session, "catalog.write");
}
