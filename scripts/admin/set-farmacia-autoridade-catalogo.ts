/**
 * scripts/admin/set-farmacia-autoridade-catalogo.ts
 *
 * Define (ou remove) a farmácia AUTORITATIVA de catálogo de um tenant —
 * ver Farmacia.autoridadeCatalogo em prisma/schema.prisma e
 * lib/farmacia-catalogo.ts. Ferramenta administrativa pontual: a
 * ingestão nunca chama isto, só LÊ a flag.
 *
 * Listar farmácias do tenant (para saber o id a usar):
 *   npx tsx scripts/admin/set-farmacia-autoridade-catalogo.ts --tenant grupo-silveira --listar
 *
 * Definir a autoridade:
 *   npx tsx scripts/admin/set-farmacia-autoridade-catalogo.ts --tenant grupo-silveira --farmacia <id>
 *
 * Remover a autoridade (volta ao comportamento histórico simétrico):
 *   npx tsx scripts/admin/set-farmacia-autoridade-catalogo.ts --tenant grupo-silveira --remover
 */
import "dotenv/config";
import { parseArgs } from "node:util";
import { getTenantBySlug, buildTenantConnectionString } from "@/lib/control-plane";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { getFarmaciaAutoridadeCatalogo, setFarmaciaAutoridadeCatalogo } from "@/lib/farmacia-catalogo";

async function main() {
  const { values } = parseArgs({
    options: {
      tenant: { type: "string" },
      farmacia: { type: "string" },
      listar: { type: "boolean" },
      remover: { type: "boolean" },
    },
    strict: true,
  });
  if (!values.tenant) {
    console.error("✗ --tenant <slug> obrigatório.");
    process.exit(1);
  }
  if (!values.listar && !values.remover && !values.farmacia) {
    console.error("✗ indica --listar, --farmacia <id>, ou --remover.");
    process.exit(1);
  }

  const tenant = await getTenantBySlug(values.tenant);
  if (!tenant) {
    console.error(`✗ Tenant "${values.tenant}" não existe.`);
    process.exit(1);
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: buildTenantConnectionString(tenant) }) });
  try {
    if (values.listar) {
      const farmacias = await prisma.farmacia.findMany({
        where: { estado: "ATIVO" },
        select: { id: true, nome: true, autoridadeCatalogo: true },
        orderBy: { nome: "asc" },
      });
      console.log(`─ tenant=${values.tenant}`);
      for (const f of farmacias) {
        console.log(`  ${f.autoridadeCatalogo ? "★" : " "} ${f.id}  ${f.nome}`);
      }
      return;
    }

    if (values.remover) {
      await setFarmaciaAutoridadeCatalogo(prisma, null);
      console.log(`✓ tenant=${values.tenant}: autoridade de catálogo removida — todas as farmácias voltam a ser simétricas.`);
      return;
    }

    const alvo = await prisma.farmacia.findUnique({ where: { id: values.farmacia! }, select: { id: true, nome: true, estado: true } });
    if (!alvo) {
      console.error(`✗ Farmácia "${values.farmacia}" não existe neste tenant.`);
      process.exit(1);
    }
    if (alvo.estado !== "ATIVO") {
      console.error(`✗ Farmácia "${alvo.nome}" está em estado ${alvo.estado} — recusado.`);
      process.exit(1);
    }

    await setFarmaciaAutoridadeCatalogo(prisma, alvo.id);
    const confirmacao = await getFarmaciaAutoridadeCatalogo(prisma);
    console.log(`✓ tenant=${values.tenant}: farmácia autoritativa de catálogo = "${confirmacao?.nome}" (${confirmacao?.id}).`);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

main().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : err);
  process.exit(1);
});
