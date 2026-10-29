"use server";

/**
 * Server action do filtro "Laboratório ou grupo" das listas operacionais (Excessos, Transferências, Devoluções,
 * Encomendas): resolve a selecção para CNP no servidor (tenant e sessão revalidados aqui). Fora de garantia os
 * valores tipados `grupo:` nunca são consultados (o resolvedor só os lê no tenant com grupos).
 */
import { getPrisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { can } from "@/lib/permissions-core";
import { gruposLaboratoriaisAtivos, resolveCurrentTenantSlug } from "@/lib/tenant-context";
import { resolverCnpsPorLaboratoriosSelecionados } from "@/lib/reporting/resolver-cnps-laboratorios";

const MAX_VALORES = 500;
const MAX_TAMANHO = 300;

export async function resolverCnpsLaboratoriosAction(valores: string[]): Promise<string[]> {
  const session = await getSession();
  if (!session || !can(session, "reports.read")) return [];
  // Só o tenant com grupos laboratoriais usa esta ação (nos restantes as listas filtram por nome, como sempre): recusa também aqui,
  // para não expor uma ação nova fora do Garantia.
  if (!gruposLaboratoriaisAtivos(await resolveCurrentTenantSlug())) return [];
  if (!Array.isArray(valores) || valores.length > MAX_VALORES) return [];
  const limpos = valores.filter((v): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_TAMANHO);
  if (limpos.length === 0) return [];
  const prisma = await getPrisma();
  return resolverCnpsPorLaboratoriosSelecionados(prisma, limpos);
}
