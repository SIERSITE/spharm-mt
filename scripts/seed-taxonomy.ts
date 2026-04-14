/**
 * scripts/seed-taxonomy.ts
 *
 * Seed idempotente da taxonomia canónica em Classificacao.
 * Lê lib/catalog-taxonomy.ts (SSoT) e garante que cada nivel1 e nivel2
 * existe na BD com estado ATIVO. Não apaga nada.
 *
 * Correr:
 *   npx tsx scripts/seed-taxonomy.ts
 *   npx tsx scripts/seed-taxonomy.ts --dry-run
 */

import "dotenv/config";
import { legacyPrisma as prisma } from "../lib/prisma";
import { CANONICAL_TAXONOMY } from "../lib/catalog-taxonomy";

const dryRun = process.argv.includes("--dry-run");

async function ensureNivel1(nome: string): Promise<string> {
  const existing = await prisma.classificacao.findFirst({
    where: { tipo: "NIVEL_1", nome },
    select: { id: true },
  });
  if (existing) return existing.id;
  if (dryRun) return "(dry-run)";
  const created = await prisma.classificacao.create({
    data: { nome, tipo: "NIVEL_1", estado: "ATIVO" },
    select: { id: true },
  });
  return created.id;
}

async function ensureNivel2(parentId: string, nome: string): Promise<boolean> {
  if (parentId === "(dry-run)") return false;
  const existing = await prisma.classificacao.findFirst({
    where: { tipo: "NIVEL_2", classificacaoPaiId: parentId, nome },
    select: { id: true },
  });
  if (existing) return false;
  if (dryRun) return true;
  await prisma.classificacao.create({
    data: { nome, tipo: "NIVEL_2", classificacaoPaiId: parentId, estado: "ATIVO" },
  });
  return true;
}

async function main(): Promise<void> {
  const sep = "─".repeat(66);
  console.log(sep);
  console.log("SPharm.MT — Seed Taxonomia Canónica");
  console.log(sep);
  if (dryRun) console.log("Modo: DRY-RUN (sem escrita)");
  console.log();

  let n1Total = 0;
  let n1New = 0;
  let n2Total = 0;
  let n2New = 0;

  for (const cat of CANONICAL_TAXONOMY) {
    const before = await prisma.classificacao.findFirst({
      where: { tipo: "NIVEL_1", nome: cat.nivel1 },
      select: { id: true },
    });
    const parentId = await ensureNivel1(cat.nivel1);
    const createdN1 = !before && !dryRun;
    if (createdN1) n1New++;
    n1Total++;

    let newSubs = 0;
    for (const sub of cat.nivel2) {
      const created = await ensureNivel2(parentId, sub);
      if (created) newSubs++;
      n2Total++;
      if (created) n2New++;
    }
    console.log(
      `  ${createdN1 ? "+" : "·"} ${cat.nivel1}  (${cat.nivel2.length} subs, ${newSubs} nova(s))`
    );
  }

  console.log();
  console.log(sep);
  console.log("RESUMO");
  console.log(sep);
  console.log(`  Nivel1: ${n1Total} (${n1New} novos)`);
  console.log(`  Nivel2: ${n2Total} (${n2New} novos)`);
  console.log(sep);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("\n[erro fatal]", err);
  await prisma.$disconnect();
  process.exit(1);
});
