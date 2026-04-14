/**
 * scripts/seed-enrichment-queue.ts
 *
 * Popula EnriquecimentoFila com todos os produtos que ainda não estão
 * na fila. Idempotente. Reutiliza a fila técnica que já existe no schema
 * (prisma/schema.prisma:761).
 *
 * Opções:
 *   --dry-run          Não escreve.
 *   --limit=N          Limita o número de produtos a semear (debug).
 *   --reset            Força todos os produtos para estado PENDENTE (mesmo
 *                      já existentes), EXCEPTO os em EM_PROCESSAMENTO.
 *   --retry-failed     Re-semeia apenas produtos com estado FALHOU.
 *   --only-unverified  Apenas produtos com verificationStatus=PENDING.
 *
 * Correr:
 *   npx tsx scripts/seed-enrichment-queue.ts --dry-run
 *   npx tsx scripts/seed-enrichment-queue.ts
 *   npx tsx scripts/seed-enrichment-queue.ts --retry-failed
 */

import "dotenv/config";
import { legacyPrisma as prisma } from "../lib/prisma";

type Args = {
  dryRun: boolean;
  limit: number | null;
  reset: boolean;
  retryFailed: boolean;
  onlyUnverified: boolean;
};

function parseArgs(): Args {
  const out: Args = {
    dryRun: false,
    limit: null,
    reset: false,
    retryFailed: false,
    onlyUnverified: false,
  };
  for (const a of process.argv.slice(2)) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--reset") out.reset = true;
    else if (a === "--retry-failed") out.retryFailed = true;
    else if (a === "--only-unverified") out.onlyUnverified = true;
    else if (a.startsWith("--limit=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (!isNaN(n) && n > 0) out.limit = n;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const sep = "─".repeat(66);
  console.log(sep);
  console.log("SPharm.MT — Seed Fila de Enriquecimento");
  console.log(sep);
  if (args.dryRun) console.log("Modo: DRY-RUN (sem escrita)");
  if (args.reset) console.log("Modo: RESET (força PENDENTE)");
  if (args.retryFailed) console.log("Modo: RETRY-FAILED (apenas FALHOU → PENDENTE)");
  if (args.onlyUnverified) console.log("Filtro: apenas verificationStatus=PENDING");
  if (args.limit !== null) console.log(`Limit: ${args.limit}`);
  console.log();

  // 1. Retry de falhados isoladamente
  if (args.retryFailed) {
    const result = args.dryRun
      ? { count: await prisma.enriquecimentoFila.count({ where: { estado: "FALHOU" } }) }
      : await prisma.enriquecimentoFila.updateMany({
          where: { estado: "FALHOU" },
          data: { estado: "PENDENTE", mensagemErro: null },
        });
    console.log(`${result.count} jobs FALHOU → PENDENTE`);
    await prisma.$disconnect();
    return;
  }

  // 2. Seed normal — produtos não-INATIVOS
  const where: {
    estado: { not: "INATIVO" };
    verificationStatus?: "PENDING";
  } = { estado: { not: "INATIVO" } };
  if (args.onlyUnverified) where.verificationStatus = "PENDING";

  const total = await prisma.produto.count({ where });
  console.log(`Produtos candidatos: ${total}`);
  if (total === 0) {
    await prisma.$disconnect();
    return;
  }

  const BATCH = 500;
  let processed = 0;
  let created = 0;
  let resetCount = 0;
  let skipped = 0;

  // Paginação por id ordenado (cursor) para eficiência
  let cursor: string | null = null;

  while (true) {
    if (args.limit !== null && processed >= args.limit) break;

    const take = args.limit !== null ? Math.min(BATCH, args.limit - processed) : BATCH;
    const produtos: Array<{ id: string }> = await prisma.produto.findMany({
      where,
      select: { id: true },
      orderBy: { id: "asc" },
      take,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (produtos.length === 0) break;

    const ids = produtos.map((p) => p.id);
    const existing = await prisma.enriquecimentoFila.findMany({
      where: { produtoId: { in: ids } },
      select: { produtoId: true, estado: true },
    });
    const existingMap = new Map(existing.map((e) => [e.produtoId, e.estado]));

    for (const p of produtos) {
      const est = existingMap.get(p.id);
      if (!est) {
        if (!args.dryRun) {
          await prisma.enriquecimentoFila.create({
            data: { produtoId: p.id, estado: "PENDENTE", prioridade: "MEDIA" },
          });
        }
        created++;
      } else if (args.reset && est !== "EM_PROCESSAMENTO") {
        if (!args.dryRun) {
          await prisma.enriquecimentoFila.update({
            where: { produtoId: p.id },
            data: { estado: "PENDENTE", mensagemErro: null },
          });
        }
        resetCount++;
      } else {
        skipped++;
      }
    }

    processed += produtos.length;
    cursor = produtos[produtos.length - 1].id;
    if (processed % 2000 === 0 || produtos.length < take) {
      console.log(
        `  progresso: ${processed}/${total}  criados=${created}  reset=${resetCount}  skip=${skipped}`
      );
    }
    if (produtos.length < take) break;
  }

  console.log();
  console.log(sep);
  console.log("RESUMO");
  console.log(sep);
  console.log(`  Processados : ${processed}`);
  console.log(`  Criados     : ${created}`);
  console.log(`  Reset       : ${resetCount}`);
  console.log(`  Saltados    : ${skipped}`);
  console.log(sep);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("\n[erro fatal]", err);
  await prisma.$disconnect();
  process.exit(1);
});
