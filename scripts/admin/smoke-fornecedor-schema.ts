/**
 * scripts/admin/smoke-fornecedor-schema.ts
 *
 * Confirma que a migration 20260515170000_add_fornecedor_erp_ref foi
 * aplicada a um tenant: contagens iniciais + presença das colunas novas.
 *
 * Uso: npx tsx scripts/admin/smoke-fornecedor-schema.ts <slug>
 */

import "dotenv/config";
import {
  controlPrisma,
  getTenantBySlug,
  buildTenantConnectionString,
} from "@/lib/control-plane";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

async function main(): Promise<void> {
  const slug = process.argv[2];
  if (!slug) {
    console.error("Uso: npx tsx scripts/admin/smoke-fornecedor-schema.ts <slug>");
    process.exit(1);
  }
  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    console.error(`tenant ${slug} não encontrado`);
    process.exit(1);
  }
  const url = buildTenantConnectionString(tenant);
  const adapter = new PrismaPg({ connectionString: url });
  const prisma = new PrismaClient({ adapter });
  try {
    const countRefs = await prisma.fornecedorErpRef.count();
    const countFornecedores = await prisma.fornecedor.count();
    const sample = await prisma.fornecedor.findFirst({
      select: { id: true, nomeNormalizado: true, nome: true, nif: true, estado: true },
    });
    console.log(`[${slug}] FornecedorErpRef count = ${countRefs}`);
    console.log(`[${slug}] Fornecedor count       = ${countFornecedores}`);
    console.log(`[${slug}] sample Fornecedor      = ${JSON.stringify(sample)}`);
  } finally {
    await prisma.$disconnect();
    await controlPrisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
