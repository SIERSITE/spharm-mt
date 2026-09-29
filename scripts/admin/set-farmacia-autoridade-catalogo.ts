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
 * Consultar só a autoridade actual (sem listar tudo):
 *   npx tsx scripts/admin/set-farmacia-autoridade-catalogo.ts --tenant grupo-silveira --consultar
 *
 * Definir a autoridade:
 *   npx tsx scripts/admin/set-farmacia-autoridade-catalogo.ts --tenant grupo-silveira --farmacia <id>
 *
 * Remover a autoridade (volta ao comportamento histórico simétrico):
 *   npx tsx scripts/admin/set-farmacia-autoridade-catalogo.ts --tenant grupo-silveira --remover
 *
 * Identificação SEMPRE por id (Farmacia.id), nunca por nome — corre
 * --listar primeiro para o confirmar antes de usar --farmacia.
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
      consultar: { type: "boolean" },
      remover: { type: "boolean" },
    },
    strict: true,
  });
  if (!values.tenant) {
    console.error("✗ --tenant <slug> obrigatório.");
    process.exit(1);
  }
  if (!values.listar && !values.consultar && !values.remover && !values.farmacia) {
    console.error("✗ indica --listar, --consultar, --farmacia <id>, ou --remover.");
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

    if (values.consultar) {
      const actual = await getFarmaciaAutoridadeCatalogo(prisma);
      console.log(
        actual
          ? `─ tenant=${values.tenant}: autoridade actual = "${actual.nome}" (${actual.id})`
          : `─ tenant=${values.tenant}: sem autoridade configurada — comportamento histórico simétrico.`,
      );
      return;
    }

    if (values.remover) {
      await setFarmaciaAutoridadeCatalogo(prisma, null);
      // Confirmação final — setFarmaciaAutoridadeCatalogo já validou (e
      // reverteu por completo se falhasse) dentro da transacção; isto é
      // só a prova visível ao operador, lida de novo após o commit.
      const total = await prisma.farmacia.count({ where: { autoridadeCatalogo: true } });
      console.log(`✓ tenant=${values.tenant}: autoridade de catálogo removida — todas as farmácias voltam a ser simétricas (confirmado: ${total} farmácias autoritativas).`);
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
    // Confirmação final, lida de novo depois do commit — a validação que
    // decide "falhar ou não" já correu DENTRO da transacção acima.
    const confirmacao = await getFarmaciaAutoridadeCatalogo(prisma);
    const total = await prisma.farmacia.count({ where: { autoridadeCatalogo: true } });
    console.log(`✓ tenant=${values.tenant}: farmácia autoritativa de catálogo = "${confirmacao?.nome}" (${confirmacao?.id}) — confirmado: exactamente ${total} farmácia autoritativa.`);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

main().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : err);
  process.exit(1);
});
