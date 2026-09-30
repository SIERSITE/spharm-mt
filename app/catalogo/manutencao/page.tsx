import { notFound } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { ManutencaoMassaClient } from "@/components/catalogo/manutencao-massa-client";
import { resolveCurrentTenantSlug, TENANT_CATALOGO_MASSA } from "@/lib/tenant-context";

export const dynamic = "force-dynamic";

/**
 * Ecrã exclusivo do tenant silveira (ver `TENANT_CATALOGO_MASSA`,
 * lib/tenant-context.ts). Noutros tenants a rota nem existe — `notFound()`
 * em vez de esconder um link, para não depender de ninguém lembrar-se de
 * tirar a entrada de menu. A guarda REAL (permissão + revalidação
 * server-side de cada filtro) vive nas server actions — isto é só a
 * página a não renderizar de todo.
 */
export default async function ManutencaoMassaPage() {
  const tenantSlug = await resolveCurrentTenantSlug();
  if (tenantSlug !== TENANT_CATALOGO_MASSA) {
    notFound();
  }

  return (
    <AppShell>
      <div className="space-y-6">
        <header>
          <h1 className="text-2xl font-semibold text-slate-900">Manutenção em massa do catálogo</h1>
          <p className="mt-1 text-sm text-slate-600">
            Altere o fabricante ou o fornecedor preferencial de vários produtos de uma vez, com pré-visualização
            obrigatória e possibilidade de reverter. Fabricante é global ao catálogo; fornecedor preferencial é
            por farmácia.
          </p>
        </header>
        <ManutencaoMassaClient />
      </div>
    </AppShell>
  );
}
