import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { podeVerIntegracao } from "@/lib/integracao/acesso";

export const dynamic = "force-dynamic";

/**
 * A informação técnica de integração deixou de existir dentro do tenant:
 * é só para técnicos internos e vive em /admin/integracao. Esta rota fica
 * apenas para que links/favoritos antigos aterrem num sítio coerente —
 * NUNCA renderiza nada (nem dados, nem componentes de integração).
 *
 *   · técnico interno → /admin/integracao
 *   · qualquer outro  → /dashboard
 */
export default async function IntegracaoRetirada() {
  const session = await getSession();
  redirect(podeVerIntegracao(session) ? "/admin/integracao" : "/dashboard");
}
