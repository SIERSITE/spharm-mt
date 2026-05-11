/**
 * scripts/apply-catalog-corrections-2026-05.ts
 *
 * Aplica as 3 correcções identificadas em
 * `notes/dci-atc-divergence-audit.md` (Maio 2026):
 *
 *   1. CNP 9774109 (Psodermil)              DCI → "Ácido salicílico"
 *   2. CNP 5359567 (Momendol 100 Mg/g Gel)  ATC → "M02AA12"
 *   3. CNP 5752811 (Vibrocil Actilongprotect) ATC → "R01AB06"
 *
 * Idempotente — re-executar sobre BD já corrigida não muda nada
 * (skip se valor actual === valor proposto). Sem `--dry-run` por
 * default: SEMPRE imprime plano primeiro e exige `--apply` para
 * escrever.
 *
 * Uso:
 *   npx tsx scripts/apply-catalog-corrections-2026-05.ts            # dry-run (default)
 *   npx tsx scripts/apply-catalog-corrections-2026-05.ts --apply    # escrita real
 *   npx tsx scripts/apply-catalog-corrections-2026-05.ts --apply --tenant=demo
 *
 * Read-only sobre todas as outras tabelas. Não toca em
 * `RegulatoryRecord` nem `InfarmedSnapshot` — o fix é apenas em
 * `Produto` (camada operacional).
 */

import "dotenv/config";
import { legacyPrisma } from "../lib/prisma";
import type { PrismaClient } from "../generated/prisma/client";

type Correction = {
  cnp: number;
  designacao: string;
  field: "dci" | "codigoATC";
  newValue: string;
  reason: string;
};

const CORRECTIONS: Correction[] = [
  {
    cnp: 9774109,
    designacao: "Psodermil, 30/0,5 mg/g x 30 pomada",
    field: "dci",
    newValue: "Ácido salicílico",
    reason: "ATC D01AE12 (queratolítico para psoríase) indica monosubstance — DCI 'betametasona + ácido salicílico' foi enrichment incorrecto.",
  },
  {
    cnp: 5359567,
    designacao: "Momendol 100 Mg/g Gel",
    field: "codigoATC",
    newValue: "M02AA12",
    reason: "Forma gel → ATC tópico (M02AA12), não oral (M01AE02). Outros naproxeno gel (Reuxen 2173599) já em M02AA12.",
  },
  {
    cnp: 5752811,
    designacao: "Vibrocil Actilongprotect 1 Mg/ml + 50 Mg/ml Sol. Para Pulv.",
    field: "codigoATC",
    newValue: "R01AB06",
    reason: "Solução nasal → ATC R01AB06 (descongestionantes nasais), não D03AX03 (cicatrizantes cutâneos). Septanazal/Nasex já em R01AB06.",
  },
];

type Args = { apply: boolean; tenantSlug: string | null };

function parseArgs(): Args {
  const out: Args = { apply: false, tenantSlug: null };
  for (const a of process.argv.slice(2)) {
    if (a === "--apply") out.apply = true;
    else if (a.startsWith("--tenant=")) out.tenantSlug = a.split("=")[1] ?? null;
  }
  return out;
}

async function main(): Promise<number> {
  const args = parseArgs();
  let prisma: PrismaClient = legacyPrisma;
  if (args.tenantSlug) {
    const { getTenantPrismaOrLegacy } = await import("../lib/tenant-registry");
    prisma = await getTenantPrismaOrLegacy(args.tenantSlug);
  }

  console.log("─".repeat(78));
  console.log(`Catalog corrections — Maio 2026 (${args.apply ? "APPLY" : "DRY-RUN"})`);
  console.log(`  tenant: ${args.tenantSlug ?? "(legacy)"}`);
  console.log("─".repeat(78));

  let willUpdate = 0;
  let alreadyOk = 0;
  let missing = 0;
  let applied = 0;

  for (const c of CORRECTIONS) {
    const prod = await prisma.produto.findUnique({
      where: { cnp: c.cnp },
      select: { id: true, designacao: true, dci: true, codigoATC: true },
    });
    if (!prod) {
      console.log(`\n[skip] CNP ${c.cnp} não encontrado — "${c.designacao}"`);
      missing++;
      continue;
    }

    const current = c.field === "dci" ? prod.dci : prod.codigoATC;
    if (current === c.newValue) {
      console.log(`\n[ok]   CNP ${c.cnp} ${c.field}=${current} (já correcto)`);
      alreadyOk++;
      continue;
    }

    console.log(`\n[diff] CNP ${c.cnp} "${prod.designacao}"`);
    console.log(`       ${c.field}: ${JSON.stringify(current)} → ${JSON.stringify(c.newValue)}`);
    console.log(`       motivo: ${c.reason}`);
    willUpdate++;

    if (args.apply) {
      const data = c.field === "dci"
        ? { dci: c.newValue }
        : { codigoATC: c.newValue };
      await prisma.produto.update({
        where: { id: prod.id },
        data: { ...data, dataAtualizacao: new Date() },
      });
      console.log(`       ✓ aplicado`);
      applied++;
    }
  }

  console.log("\n" + "─".repeat(78));
  console.log(`Resumo: total=${CORRECTIONS.length} já-ok=${alreadyOk} a-aplicar=${willUpdate} aplicados=${applied} em-falta=${missing}`);
  if (!args.apply && willUpdate > 0) {
    console.log(`\nDry-run. Use --apply para escrever.`);
  }
  return missing > 0 ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((e) => {
    console.error("[fatal]", e);
    process.exitCode = 1;
  })
  .finally(() => legacyPrisma.$disconnect());
