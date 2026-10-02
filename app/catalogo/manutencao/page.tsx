import { notFound } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { ManutencaoMassaClient } from "@/components/catalogo/manutencao-massa-client";
import { resolveCurrentTenantSlug } from "@/lib/tenant-context";
import { TENANT_CATALOGO_MASSA } from "@/lib/tenant-constants";
import { getPrisma } from "@/lib/prisma";
import { getReportingFilterOptions } from "@/lib/reporting-filter-options";

export const dynamic = "force-dynamic";

/**
 * Ecrã exclusivo do tenant silveira (ver `TENANT_CATALOGO_MASSA`,
 * lib/tenant-constants.ts). Noutros tenants a rota nem existe — `notFound()`
 * ANTES de qualquer query. A entrada de menu é só apresentação; a guarda REAL
 * (tenant + permissão + revalidação server-side de cada filtro) vive aqui e em
 * todas as server actions.
 *
 * As opções dos filtros são as MESMAS do relatório de Vendas
 * (`getReportingFilterOptions`), carregadas no servidor como em `/vendas`.
 */
export default async function ManutencaoMassaPage() {
  const tenantSlug = await resolveCurrentTenantSlug();
  if (tenantSlug !== TENANT_CATALOGO_MASSA) {
    notFound();
  }

  const prisma = await getPrisma();
  const filterOptions = await getReportingFilterOptions();
  const [farmacias, fabricantes, fornecedoresHabituais, tipos] = await Promise.all([
    prisma.farmacia.findMany({
      where: { estado: "ATIVO", nome: { not: "Farmácia Teste" } },
      select: { id: true, nome: true },
      orderBy: { nome: "asc" },
    }),
    // Os mesmos nomes de fabricante que o filtro de Vendas oferece, com o ID (o filtro trabalha por ID).
    prisma.fabricante.findMany({
      where: { nomeNormalizado: { in: filterOptions.fabricantes } },
      select: { id: true, nomeNormalizado: true },
      orderBy: { nomeNormalizado: "asc" },
    }),
    prisma.fornecedor.findMany({
      where: { estado: "ATIVO", produtosFarmacia: { some: {} } },
      select: { id: true, nome: true, nomeNormalizado: true },
      orderBy: { nomeNormalizado: "asc" },
    }),
    prisma.produto.findMany({
      where: { tipoArtigo: { not: null } },
      select: { tipoArtigo: true },
      distinct: ["tipoArtigo"],
      orderBy: { tipoArtigo: "asc" },
    }),
  ]);

  return (
    <AppShell>
      <div className="space-y-6">
        <header>
          <h1 className="text-2xl font-semibold text-slate-900">Manutenção em massa do catálogo</h1>
          <p className="mt-1 text-sm text-slate-600">
            Altere o fabricante ou o fornecedor habitual de vários produtos de uma vez, com pré-visualização obrigatória e
            possibilidade de reverter. Os filtros são os do relatório de Vendas. O fabricante pertence ao produto; o fornecedor
            habitual pertence ao produto em cada farmácia — só as farmácias seleccionadas são alteradas.
          </p>
        </header>
        <ManutencaoMassaClient
          opcoes={{
            filterOptions,
            farmacias,
            fabricantes: fabricantes.map((f) => ({ id: f.id, nome: f.nomeNormalizado })),
            fornecedoresHabituais: fornecedoresHabituais.map((f) => ({ id: f.id, nome: f.nome ?? f.nomeNormalizado })),
            tiposArtigo: tipos.map((t) => t.tipoArtigo!).filter(Boolean),
          }}
        />
      </div>
    </AppShell>
  );
}
