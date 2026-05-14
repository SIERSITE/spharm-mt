/**
 * scripts/tenancy/add-farmacia.ts
 *
 * Adiciona uma farmácia a um tenant existente. Único trabalho:
 *   1. Resolver tenant via control plane
 *   2. Construir Prisma client para a BD do tenant (via connection
 *      string cifrada)
 *   3. INSERT em `Farmacia` (estado=ATIVO)
 *   4. Listar todas as farmácias do tenant no fim
 *
 * Idempotência: o constraint `@@unique([nome])` na tabela Farmacia
 * recusa duplicados. Comando aborta limpo (não cria) se a farmácia já
 * existe — mas mostra a row existente para confirmar.
 *
 * Uso:
 *   npm run tenancy:add-farmacia -- \
 *     --tenant demo-neon \
 *     --nome "Farmácia Internacional" \
 *     --codigo "FI001"
 *
 *   # codigo é opcional
 *   npm run tenancy:add-farmacia -- --tenant demo-neon --nome "Farmácia Norte"
 *
 * Não cria utilizadores. Não emite ingest key. Não toca control plane
 * directamente — só lê o tenant. Toda a escrita é na BD do tenant.
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
import { requireControlEnv } from "./_shared";

type Args = {
  tenant?: string;
  nome?: string;
  codigo?: string;
  morada?: string;
  contacto?: string;
};

function parseCmdArgs(): Args {
  const { values } = parseArgs({
    options: {
      tenant: { type: "string" },
      nome: { type: "string" },
      codigo: { type: "string" },
      morada: { type: "string" },
      contacto: { type: "string" },
    },
    strict: true,
  });
  return {
    tenant: values.tenant,
    nome: values.nome,
    codigo: values.codigo,
    morada: values.morada,
    contacto: values.contacto,
  };
}

async function main() {
  requireControlEnv();

  const args = parseCmdArgs();
  if (!args.tenant) {
    console.error("✗ --tenant <slug> é obrigatório.");
    process.exit(1);
  }
  if (!args.nome || args.nome.trim() === "") {
    console.error('✗ --nome "<Designação>" é obrigatório.');
    process.exit(1);
  }
  const nome = args.nome.trim();
  if (nome.length > 200) {
    console.error("✗ --nome deve ter ≤ 200 caracteres.");
    process.exit(1);
  }
  const codigoANF = args.codigo?.trim() || null;
  if (codigoANF && codigoANF.length > 50) {
    console.error("✗ --codigo deve ter ≤ 50 caracteres.");
    process.exit(1);
  }

  const tenant = await getTenantBySlug(args.tenant);
  if (!tenant) {
    console.error(`✗ Tenant "${args.tenant}" não existe no control plane.`);
    console.error(`  Lista tenants com 'npm run tenancy:list'.`);
    process.exit(1);
  }
  if (tenant.estado !== "ACTIVE") {
    console.error(
      `✗ Tenant "${args.tenant}" está em ${tenant.estado}. Só ACTIVE aceita farmácias.`
    );
    process.exit(1);
  }

  const url = buildTenantConnectionString(tenant);
  const adapter = new PrismaPg({ connectionString: url });
  const prisma = new PrismaClient({ adapter });

  try {
    console.log("─".repeat(72));
    console.log(`add-farmacia — ${tenant.slug}`);
    console.log("─".repeat(72));
    console.log(`Tenant       : ${tenant.nome} (id=${tenant.id})`);
    console.log(`DB           : ${tenant.dbName}@${tenant.dbHost}:${tenant.dbPort}`);
    console.log("");

    // 1) Detectar duplicado por nome ANTES do INSERT — feedback mais
    //    claro do que apanhar o constraint violation depois.
    const existing = await prisma.farmacia.findFirst({
      where: { nome },
      select: { id: true, nome: true, codigoANF: true, estado: true },
    });
    if (existing) {
      console.error(
        `✗ Farmácia "${nome}" já existe (id=${existing.id}, estado=${existing.estado}).`
      );
      console.error(`  Para alterar usa SQL directo ou um futuro 'tenancy:update-farmacia'.`);
      console.error(`  Para listar, ver 'tenancy:status'.`);
      process.exit(2);
    }

    // 2) INSERT
    const created = await prisma.farmacia.create({
      data: {
        nome,
        codigoANF,
        morada: args.morada?.trim() || null,
        contacto: args.contacto?.trim() || null,
        estado: "ATIVO",
      },
      select: { id: true, nome: true, codigoANF: true, estado: true, dataCriacao: true },
    });

    console.log("✓ Farmácia criada");
    console.log(`  id           : ${created.id}`);
    console.log(`  nome         : ${created.nome}`);
    console.log(`  código ANF   : ${created.codigoANF ?? "(não definido)"}`);
    console.log(`  estado       : ${created.estado}`);
    console.log(`  dataCriacao  : ${created.dataCriacao.toISOString()}`);
    console.log("");

    // 3) Listagem completa do tenant
    const all = await prisma.farmacia.findMany({
      select: { id: true, nome: true, codigoANF: true, estado: true },
      orderBy: { nome: "asc" },
    });
    console.log(`Farmácias no tenant "${tenant.slug}" (${all.length}):`);
    for (const f of all) {
      const marker = f.id === created.id ? "✓" : " ";
      console.log(
        `  ${marker} ${f.nome.padEnd(40)} ${(f.codigoANF ?? "—").padEnd(12)} ${f.estado}`
      );
    }
    console.log("");
    console.log("Próximos passos:");
    console.log(`  · Gerar ZIP agent: npm run admin:package-agent -- --tenant ${tenant.slug} --farmacia "${nome}" --rotate`);
    console.log(`  · Ver estado: npm run tenancy:status -- --tenant ${tenant.slug}`);
  } finally {
    await prisma.$disconnect();
    await controlPrisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("[fatal]", err instanceof Error ? err.message : err);
  process.exit(1);
});
