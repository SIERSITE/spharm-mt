/**
 * scripts/reclassify-ingest-vendas.ts
 *
 * Aplica as regras correntes de `TipoDocumentoClassificacao` a todas as
 * linhas já existentes em `IngestVendaLinhaRaw` de um tenant. UPDATE
 * em massa, atómico per (tipoDocumento, classe destino).
 *
 * Uso:
 *   npx tsx scripts/reclassify-ingest-vendas.ts --tenant demo-neon --dry-run
 *   npx tsx scripts/reclassify-ingest-vendas.ts --tenant demo-neon
 *
 * Quando correr:
 *   1. Após editar `TipoDocumentoClassificacao` (via SQL ou script
 *      classify-tipodoc.ts) — para que rows já ingeridas reflictam
 *      a nova classe.
 *   2. Idempotente: re-correr sem editar tabela = 0 changes.
 *
 * Política de falha:
 *   Aborta no primeiro erro. UPDATE per-tipo é independente, mas se
 *   um falhar (DB constraint, lock) paramos para diagnose. Tenant
 *   state não fica inconsistente — cada UPDATE é atómico.
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

async function main() {
  const { values } = parseArgs({
    options: {
      tenant: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
    strict: true,
  });

  if (!values.tenant) {
    console.error("✗ --tenant <slug> obrigatório.");
    console.error("  Ex: npx tsx scripts/reclassify-ingest-vendas.ts --tenant demo-neon");
    process.exit(1);
  }

  const tenantSlug = values.tenant;
  const dryRun = values["dry-run"] ?? false;

  const tenant = await getTenantBySlug(tenantSlug);
  if (!tenant) {
    console.error(`✗ Tenant "${tenantSlug}" não existe no control plane.`);
    process.exit(1);
  }
  if (tenant.estado !== "ACTIVE") {
    console.error(`✗ Tenant "${tenantSlug}" está em estado ${tenant.estado}. Aborta.`);
    process.exit(1);
  }

  const url = buildTenantConnectionString(tenant);
  const adapter = new PrismaPg({ connectionString: url });
  const prisma = new PrismaClient({ adapter });

  try {
    console.log(`─ tenant: ${tenantSlug} (${dryRun ? "DRY-RUN" : "WRITE"})`);

    // 1) Ler classificações actuais
    const classifications = await prisma.tipoDocumentoClassificacao.findMany({
      orderBy: { tipoDocumento: "asc" },
    });
    if (classifications.length === 0) {
      console.log("✗ TipoDocumentoClassificacao vazio. Seed via migration ou classify-tipodoc.ts.");
      await prisma.$disconnect();
      process.exit(1);
    }
    console.log(`\n${classifications.length} classificações configuradas:`);
    for (const c of classifications) {
      console.log(
        `  ${c.tipoDocumento.toString().padStart(5)} → ${c.classe.padEnd(20)} ${c.descricao ?? ""}`
      );
    }

    // 2) Diff per-tipo, FORA do circuito suspenso.
    //
    // ── PORQUE É QUE O CIRCUITO SUSPENSO ESTÁ PROTEGIDO ───────────────
    //
    // `TipoDocumentoClassificacao` é indexada por `tipoDocumento` e mais
    // nada. No circuito suspenso o mesmo tipo serve a factura e a sua
    // anulação — Silveirense VSG 107 tem 16 168 linhas positivas e 2 078
    // negativas; Segurado VSC 107 tem 8 982 e 583; VSC 102 tem 25 e 5.
    // Quem as separa é o sinal da quantidade, que esta tabela não vê.
    //
    // Um `updateMany({ where: { tipoDocumento: 107 } })` reescreveria as
    // duas metades com a mesma classe — num comando, e sem erro nenhum.
    // As 2 078 anulações da Silveirense passariam a somar. Por isso as
    // linhas do circuito suspenso ficam de fora por construção: qualquer
    // classe que esta tabela produza para elas está errada de origem.
    //
    // Para as corrigir, re-corre o reader — é ele que conhece o sinal.
    // `sourceNamespace` é NOT NULL com default, portanto `not` exclui
    // exactamente o circuito suspenso e não engole linhas por nulidade.
    const NS_SUSPENSO = "ATENDIMENTO_SUSP_DETALHE";
    const foraDoSuspenso = { sourceNamespace: { not: NS_SUSPENSO } };

    const protegidas = await prisma.ingestVendaLinhaRaw.count({
      where: { sourceNamespace: NS_SUSPENSO },
    });
    if (protegidas > 0) {
      console.log(
        `\n${protegidas} linhas do circuito suspenso (${NS_SUSPENSO}) NÃO são tocadas:`,
      );
      console.log("  a classe delas depende do SINAL da quantidade, que esta tabela");
      console.log("  não representa. Para as reclassificar, re-corre o reader.");
    }

    console.log("\nDiff (linhas com tipoDocumentoClass ≠ regra actual):");
    let totalChanged = 0;
    const changes: Array<{ tipo: number; classe: string; n: number }> = [];
    for (const c of classifications) {
      const n = await prisma.ingestVendaLinhaRaw.count({
        where: {
          tipoDocumento: c.tipoDocumento,
          NOT: { tipoDocumentoClass: c.classe },
          ...foraDoSuspenso,
        },
      });
      if (n > 0) {
        changes.push({ tipo: c.tipoDocumento, classe: c.classe, n });
        totalChanged += n;
      }
    }

    // 3) TipoDocs em IngestVendaLinhaRaw que NÃO estão no classifier
    const known = classifications.map((c) => c.tipoDocumento);
    // Também sem o circuito suspenso: avisar que o 107 "não está no
    // classifier" empurrava o operador para o adicionar — que é
    // exactamente a acção que parte a regra do sinal.
    const unclassifiedRows = await prisma.ingestVendaLinhaRaw.groupBy({
      by: ["tipoDocumento"],
      where: { tipoDocumento: { notIn: known }, ...foraDoSuspenso },
      _count: { _all: true },
    });

    if (changes.length === 0) {
      console.log("  (sem mudanças — classifier alinhado com staging)");
    }
    for (const ch of changes) {
      console.log(`  tipo ${ch.tipo.toString().padStart(5)} → ${ch.classe.padEnd(20)} ${ch.n} linhas afectadas`);
    }
    if (unclassifiedRows.length > 0) {
      console.log("\n⚠ TipoDocs em staging SEM entrada no classifier:");
      for (const u of unclassifiedRows) {
        console.log(
          `  tipo ${(u.tipoDocumento ?? -1).toString().padStart(5)} → ${u._count._all} linhas ` +
            `(mantém classe actual; adicionar ao classifier via classify-tipodoc.ts)`
        );
      }
    }
    console.log(`\nTotal a alterar: ${totalChanged}`);

    if (dryRun) {
      console.log("\nDRY-RUN — nada escrito. Re-corre sem --dry-run para aplicar.");
      await prisma.$disconnect();
      return;
    }

    if (totalChanged === 0) {
      console.log("\n✓ Nada a fazer.");
      await prisma.$disconnect();
      return;
    }

    // 4) Apply
    console.log("\n▶ A aplicar UPDATEs:");
    for (const ch of changes) {
      const r = await prisma.ingestVendaLinhaRaw.updateMany({
        where: {
          tipoDocumento: ch.tipo,
          NOT: { tipoDocumentoClass: ch.classe },
          // O MESMO filtro do diff. Um UPDATE mais largo do que a
          // contagem que o operador aprovou é a definição de surpresa.
          ...foraDoSuspenso,
        },
        data: { tipoDocumentoClass: ch.classe },
      });
      console.log(`  ✓ tipo ${ch.tipo} → ${ch.classe}: ${r.count} rows`);
    }

    console.log(`\n✓ ${totalChanged} linhas reclassificadas em tenant ${tenantSlug}.`);
  } finally {
    await prisma.$disconnect();
    await controlPrisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
