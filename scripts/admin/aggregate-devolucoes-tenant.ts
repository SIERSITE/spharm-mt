/**
 * scripts/admin/aggregate-devolucoes-tenant.ts
 *
 * Re-corre `aggregate-devolucoes` para TODAS as farmácias activas dum
 * tenant, num intervalo `[from, to)`. Idempotente: invoca
 * `lib/aggregate/devolucoes.ts` (set-based, ON CONFLICT em
 * `(farmaciaId, externalLineId)`). Dry-run por defeito.
 *
 *   npx tsx scripts/admin/aggregate-devolucoes-tenant.ts \
 *     --tenant grupo-silveira --from 2024-10-01 --to 2026-06-01 --dry-run
 *
 *   npx tsx scripts/admin/aggregate-devolucoes-tenant.ts \
 *     --tenant grupo-silveira --from 2024-10-01 --to 2026-06-01           # aplica
 *
 * Usado depois do agent correr `devolucoes-fornecedor-upload` para
 * propagar staging → Devolucao final. Equivalente ao
 * `aggregate-compras-tenant.ts` para o pipeline de devoluções.
 *
 * Convenção: quantidade efectiva = quantidadeRecebida (recebida>0 only),
 * valor = recebida × PVF unitário. Linhas com recebida=0 ficam fora.
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
import { aggregateDevolucoes } from "@/lib/aggregate/devolucoes";

function genBatchId(): string {
  const ts = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 10);
  return `adv-${ts}-${r}`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      tenant: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      "dry-run": { type: "boolean" },
    },
    strict: true,
  });
  if (!values.tenant || !values.from || !values.to) {
    console.error("✗ --tenant <slug> --from YYYY-MM-DD --to YYYY-MM-DD obrigatórios.");
    process.exit(1);
  }
  const dryRun = values["dry-run"] ?? false;
  const from = new Date(`${values.from}T00:00:00Z`);
  const to = new Date(`${values.to}T00:00:00Z`);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) {
    console.error("✗ --from/--to inválidos (YYYY-MM-DD).");
    process.exit(1);
  }
  if (from >= to) {
    console.error("✗ --from tem que ser anterior a --to.");
    process.exit(1);
  }

  const tenant = await getTenantBySlug(values.tenant);
  if (!tenant) {
    console.error(`✗ Tenant "${values.tenant}" não existe.`);
    process.exit(1);
  }
  if (tenant.estado !== "ACTIVE") {
    console.error(`✗ Tenant em estado ${tenant.estado}.`);
    process.exit(1);
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: buildTenantConnectionString(tenant) }),
  });

  try {
    const farmacias = await prisma.farmacia.findMany({
      where: { estado: "ATIVO", nome: { not: "Farmácia Teste" } },
      select: { id: true, nome: true },
      orderBy: { nome: "asc" },
    });

    console.log(`─ tenant=${values.tenant} (${dryRun ? "DRY-RUN" : "WRITE"})`);
    console.log(`  janela: ${values.from} → ${values.to}  (to exclusivo)`);
    console.log(`  farmácias activas: ${farmacias.length}\n`);

    const batchId = dryRun ? null : genBatchId();
    if (batchId) console.log(`  batchId: ${batchId}\n`);

    let tRead = 0;
    let tCreated = 0;
    let tUpdated = 0;
    let tOrphansProd = 0;
    let tOrphansForn = 0;
    let tExcRec = 0;

    for (const f of farmacias) {
      const t0 = Date.now();
      const r = await aggregateDevolucoes(prisma, {
        farmaciaId: f.id,
        from,
        to,
        write: !dryRun,
        batchId,
      });
      const elapsed = Date.now() - t0;
      tRead += r.rawLinesRead;
      tCreated += r.created;
      tUpdated += r.updated;
      tOrphansProd += r.orphanProducts.count;
      tOrphansForn += r.orphanFornecedores.count;
      tExcRec += r.excludedByRecebida;
      console.log(
        `  ${f.nome.padEnd(24)} ` +
          `staging=${String(r.rawLinesRead).padEnd(6)} ` +
          `excRecebida=${String(r.excludedByRecebida).padEnd(5)} ` +
          `cands=${String(r.candidateLines).padEnd(6)} ` +
          `c=${String(r.created).padEnd(5)} u=${String(r.updated).padEnd(5)} ` +
          `orphProd=${String(r.orphanProducts.count).padEnd(4)} ` +
          `orphForn=${String(r.orphanFornecedores.count).padEnd(4)} ` +
          `chunks=${r.chunks} (${elapsed}ms)`,
      );
    }
    console.log(`\n─ TOTAL  read=${tRead}  excRecebida=${tExcRec}  c=${tCreated}  u=${tUpdated}` +
      `  orphProd=${tOrphansProd}  orphForn=${tOrphansForn}`);
    if (dryRun) {
      console.log(`\nDRY-RUN — nada escrito. Re-corre sem --dry-run para aplicar.`);
    }
  } finally {
    await prisma.$disconnect();
    await controlPrisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
