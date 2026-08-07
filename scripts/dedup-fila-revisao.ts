/**
 * scripts/dedup-fila-revisao.ts
 *
 * One-shot cleanup: garante que cada produtoId tem no máximo UMA entrada
 * PENDENTE em FilaRevisao. Mantém a mais recente (dataCriacao DESC, id DESC)
 * e remove as restantes.
 *
 * O comportamento por defeito é DRY-RUN — só conta e lista. Para apagar
 * mesmo é preciso passar --apply. A remoção corre dentro de uma única
 * transação Prisma.
 *
 * Uso:
 *   npx tsx scripts/dedup-fila-revisao.ts                # dry-run completo
 *   npx tsx scripts/dedup-fila-revisao.ts --limit=20     # dry-run só dos 20 primeiros produtos
 *   npx tsx scripts/dedup-fila-revisao.ts --apply        # APAGA mesmo
 *
 * Equivalente em SQL puro (para referência / auditoria):
 *
 *   WITH ranked AS (
 *     SELECT id,
 *            ROW_NUMBER() OVER (
 *              PARTITION BY "produtoId"
 *              ORDER BY "dataCriacao" DESC, id DESC
 *            ) AS rn
 *     FROM "FilaRevisao"
 *     WHERE estado = 'PENDENTE'
 *   )
 *   DELETE FROM "FilaRevisao"
 *   WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
 */

import "dotenv/config";
import { legacyPrisma as prisma } from "../lib/prisma";

type Args = { apply: boolean; limit: number | null };

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let apply = false;
  let limit: number | null = null;
  for (const arg of args) {
    if (arg === "--apply") apply = true;
    else if (arg.startsWith("--limit=")) {
      const n = parseInt(arg.split("=")[1], 10);
      if (!isNaN(n) && n > 0) limit = n;
    } else {
      console.warn(`[aviso] Argumento desconhecido: ${arg}`);
    }
  }
  return { apply, limit };
}

async function main(): Promise<void> {
  const { apply, limit } = parseArgs();
  const sep = "─".repeat(70);

  console.log(sep);
  console.log(`Dedup FilaRevisao — ${apply ? "MODO APPLY (vai apagar)" : "DRY-RUN"}`);
  console.log(sep);

  // 1. Produtos com mais de uma entrada PENDENTE.
  const grouped = await prisma.filaRevisao.groupBy({
    by: ["produtoId"],
    where: { estado: "PENDENTE" },
    _count: { _all: true },
    having: { produtoId: { _count: { gt: 1 } } },
  });

  console.log(`Produtos com PENDENTE duplicados: ${grouped.length}`);
  if (grouped.length === 0) {
    console.log("Nada a fazer.");
    await prisma.$disconnect();
    return;
  }

  // 2. Para cada produtoId duplicado: ordenar (dataCriacao DESC, id DESC),
  //    manter o primeiro, marcar os restantes para apagar.
  const toDelete: string[] = [];
  const sample: Array<{ produtoId: string; keep: string; remove: string[] }> = [];

  const targets = limit ? grouped.slice(0, limit) : grouped;

  for (const g of targets) {
    const rows = await prisma.filaRevisao.findMany({
      where: { produtoId: g.produtoId, estado: "PENDENTE" },
      select: { id: true, dataCriacao: true },
      orderBy: [{ dataCriacao: "desc" }, { id: "desc" }],
    });
    if (rows.length <= 1) continue;
    const [keep, ...remove] = rows;
    toDelete.push(...remove.map((r) => r.id));
    if (sample.length < 5) {
      sample.push({
        produtoId: g.produtoId,
        keep: keep.id,
        remove: remove.map((r) => r.id),
      });
    }
  }

  console.log(`Linhas a remover: ${toDelete.length}`);
  console.log("\nAmostra (até 5 produtos):");
  for (const s of sample) {
    console.log(`  produtoId=${s.produtoId}`);
    console.log(`    keep   ${s.keep}`);
    for (const id of s.remove) console.log(`    remove ${id}`);
  }

  if (!apply) {
    console.log("\nDRY-RUN — nada foi alterado. Use --apply para executar.");
    await prisma.$disconnect();
    return;
  }

  // 3. Apply: uma única transação.
  console.log(`\nA aplicar — transação com deleteMany de ${toDelete.length} id(s)…`);
  const removed = await prisma.$transaction(async (tx) => {
    const r = await tx.filaRevisao.deleteMany({
      where: { id: { in: toDelete } },
    });
    return r.count;
  });
  console.log(`Removidas ${removed} linha(s).`);

  // 4. Verificação final.
  const stillDup = await prisma.filaRevisao.groupBy({
    by: ["produtoId"],
    where: { estado: "PENDENTE" },
    _count: { _all: true },
    having: { produtoId: { _count: { gt: 1 } } },
  });
  console.log(`Pós-dedup: produtos com PENDENTE duplicados = ${stillDup.length}`);
  if (stillDup.length > 0) {
    console.warn("[aviso] ainda existem duplicados — investigar antes de prosseguir.");
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("\n[erro fatal]", err);
  prisma.$disconnect().finally(() => process.exit(1));
});
