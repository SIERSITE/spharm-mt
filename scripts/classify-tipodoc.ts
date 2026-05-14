/**
 * scripts/classify-tipodoc.ts
 *
 * Admin CLI para inserir ou actualizar uma entrada em
 * `TipoDocumentoClassificacao`. Audita `classifiedBy` automaticamente.
 *
 * Uso:
 *   npx tsx scripts/classify-tipodoc.ts \
 *     --tenant demo-neon \
 *     --tipo 7 \
 *     --classe VENDA \
 *     --descricao "Venda OTC sem receita" \
 *     --by "operator@email.com"
 *
 * Flags opcionais:
 *   --notas "..."   notas livres
 *   --by   "..."    classificador (default "cli")
 *
 * Após edição, normalmente correr:
 *   npx tsx scripts/reclassify-ingest-vendas.ts --tenant <slug>
 * para propagar a nova regra ao staging existente.
 */

import "dotenv/config";
import { parseArgs } from "node:util";
import {
  controlPrisma,
  getTenantBySlug,
  buildTenantConnectionString,
} from "@/lib/control-plane";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const VALID_CLASSES = new Set([
  "VENDA",
  "DEVOLUCAO_ANULACAO",
  "UNKNOWN",
  "IGNORE_TECHNICAL",
]);

async function main() {
  const { values } = parseArgs({
    options: {
      tenant: { type: "string" },
      tipo: { type: "string" },
      classe: { type: "string" },
      descricao: { type: "string" },
      notas: { type: "string" },
      by: { type: "string" },
    },
    strict: true,
  });

  if (!values.tenant) {
    console.error("✗ --tenant <slug> obrigatório.");
    process.exit(1);
  }
  if (!values.tipo) {
    console.error("✗ --tipo <int> obrigatório (valor raw do ERP).");
    process.exit(1);
  }
  if (!values.classe) {
    console.error(`✗ --classe <string> obrigatório. Valores válidos: ${Array.from(VALID_CLASSES).join(", ")}`);
    process.exit(1);
  }
  if (!VALID_CLASSES.has(values.classe)) {
    console.error(`✗ classe "${values.classe}" inválida. Valores válidos: ${Array.from(VALID_CLASSES).join(", ")}`);
    process.exit(1);
  }
  const tipo = parseInt(values.tipo, 10);
  if (!Number.isFinite(tipo)) {
    console.error(`✗ --tipo "${values.tipo}" não é inteiro válido.`);
    process.exit(1);
  }

  const tenantSlug = values.tenant;
  const tenant = await getTenantBySlug(tenantSlug);
  if (!tenant) {
    console.error(`✗ Tenant "${tenantSlug}" não existe.`);
    process.exit(1);
  }
  if (tenant.estado !== "ACTIVE") {
    console.error(`✗ Tenant "${tenantSlug}" em estado ${tenant.estado}. Aborta.`);
    process.exit(1);
  }

  const url = buildTenantConnectionString(tenant);
  const adapter = new PrismaPg({ connectionString: url });
  const prisma = new PrismaClient({ adapter });

  try {
    const existing = await prisma.tipoDocumentoClassificacao.findUnique({
      where: { tipoDocumento: tipo },
    });

    const data = {
      tipoDocumento: tipo,
      classe: values.classe,
      descricao: values.descricao ?? null,
      notas: values.notas ?? null,
      classifiedBy: values.by ?? "cli",
    };

    if (existing) {
      console.log(`▶ Update tipo=${tipo}:`);
      console.log(`  ${existing.classe.padEnd(20)} → ${values.classe}`);
      if ((existing.descricao ?? "") !== (data.descricao ?? "")) {
        console.log(`  desc: "${existing.descricao ?? ""}" → "${data.descricao ?? ""}"`);
      }
    } else {
      console.log(`▶ Insert tipo=${tipo}: classe=${values.classe}`);
    }

    await prisma.tipoDocumentoClassificacao.upsert({
      where: { tipoDocumento: tipo },
      create: data,
      update: {
        classe: data.classe,
        descricao: data.descricao,
        notas: data.notas,
        classifiedBy: data.classifiedBy,
      },
    });

    console.log(`✓ TipoDocumentoClassificacao ${tipo} = ${values.classe}`);
    console.log("");
    console.log("Próximo passo: propagar a regra ao staging existente:");
    console.log(`  npx tsx scripts/reclassify-ingest-vendas.ts --tenant ${tenantSlug} --dry-run`);
    console.log(`  npx tsx scripts/reclassify-ingest-vendas.ts --tenant ${tenantSlug}`);
  } finally {
    await prisma.$disconnect();
    await controlPrisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
