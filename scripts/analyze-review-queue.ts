/**
 * scripts/analyze-review-queue.ts
 *
 * Analiza os itens actuais em FilaRevisao (estado=PENDENTE) e agrupa-os
 * por padrão recorrente, para informar a próxima ronda de regras de
 * mapeamento. Não escreve nada — só lê.
 *
 * Para cada produto em revisão imprime:
 *   · CNP, designação, productType actual + confiança
 *   · manualReviewReason exacto
 *   · rawCategory / rawBrand / rawProductName das últimas chamadas
 *     SUCCESS / PARTIAL_HIT em EnrichmentSourceLog
 *
 * No final, agrupa por:
 *   · manualReviewReason (chave: primeiras 60 chars)
 *   · productType actual
 *   · presença de rawCategory útil
 *
 * Correr:
 *   npx tsx scripts/analyze-review-queue.ts
 */

import "dotenv/config";
import { legacyPrisma as prisma } from "../lib/prisma";

type ReviewItem = {
  cnp: number;
  designacao: string;
  productType: string | null;
  productTypeConf: number | null;
  manualReviewReason: string | null;
  rawCategories: string[];
  rawBrands: string[];
  rawProductNames: string[];
  sources: string[];
};

async function main(): Promise<void> {
  const sep = "─".repeat(78);
  console.log(sep);
  console.log("Análise da Fila de Revisão");
  console.log(sep);

  const reviews = await prisma.filaRevisao.findMany({
    where: { estado: "PENDENTE" },
    orderBy: { dataCriacao: "asc" },
    include: {
      produto: {
        select: {
          id: true,
          cnp: true,
          designacao: true,
          productType: true,
          productTypeConfidence: true,
          manualReviewReason: true,
          flagMSRM: true,
          flagMNSRM: true,
          codigoATC: true,
          tipoArtigo: true,
        },
      },
    },
  });

  if (reviews.length === 0) {
    console.log("Nenhum item pendente.");
    await prisma.$disconnect();
    return;
  }

  console.log(`Total: ${reviews.length} produto(s) em revisão.\n`);

  const items: ReviewItem[] = [];

  for (const r of reviews) {
    const logs = await prisma.enrichmentSourceLog.findMany({
      where: {
        produtoId: r.produtoId,
        status: { in: ["SUCCESS", "PARTIAL_HIT"] },
      },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        source: true,
        rawCategory: true,
        rawBrand: true,
        rawProductName: true,
        confidence: true,
      },
    });

    const it: ReviewItem = {
      cnp: r.produto.cnp,
      designacao: r.produto.designacao,
      productType: r.produto.productType,
      productTypeConf: r.produto.productTypeConfidence,
      manualReviewReason: r.produto.manualReviewReason,
      rawCategories: dedupe(logs.map((l) => l.rawCategory)),
      rawBrands: dedupe(logs.map((l) => l.rawBrand)),
      rawProductNames: dedupe(logs.map((l) => l.rawProductName)),
      sources: dedupe(logs.map((l) => l.source)),
    };
    items.push(it);
  }

  // ─── Detalhe por item ─────────────────────────────────────────────────
  console.log("DETALHE POR ITEM");
  console.log(sep);
  for (const it of items) {
    console.log(`CNP ${it.cnp}  ${it.designacao}`);
    console.log(
      `  type=${it.productType ?? "(null)"} conf=${
        it.productTypeConf != null ? `${(it.productTypeConf * 100).toFixed(0)}%` : "—"
      }`
    );
    console.log(`  reason: ${it.manualReviewReason ?? "(sem razão)"}`);
    if (it.rawBrands.length > 0) console.log(`  rawBrand:        ${it.rawBrands.join(" | ")}`);
    if (it.rawCategories.length > 0)
      console.log(`  rawCategory:     ${it.rawCategories.join(" | ").slice(0, 200)}`);
    if (it.rawProductNames.length > 0)
      console.log(`  rawProductName:  ${it.rawProductNames.join(" | ").slice(0, 200)}`);
    if (it.sources.length > 0) console.log(`  sources:         ${it.sources.join(", ")}`);
    console.log("");
  }

  // ─── Agrupamentos ──────────────────────────────────────────────────────
  console.log(sep);
  console.log("AGRUPAMENTO POR motivo de revisão");
  console.log(sep);
  const byReason = new Map<string, ReviewItem[]>();
  for (const it of items) {
    const key = (it.manualReviewReason ?? "(sem razão)").slice(0, 80);
    (byReason.get(key) ?? byReason.set(key, []).get(key)!).push(it);
  }
  for (const [reason, list] of [...byReason.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n[${list.length}x] ${reason}`);
    for (const it of list.slice(0, 3)) {
      console.log(`    · CNP ${it.cnp}  ${it.designacao.slice(0, 60)}`);
    }
    if (list.length > 3) console.log(`    … e mais ${list.length - 3}`);
  }

  console.log("\n" + sep);
  console.log("AGRUPAMENTO POR productType actual");
  console.log(sep);
  const byType = new Map<string, ReviewItem[]>();
  for (const it of items) {
    const key = it.productType ?? "(null)";
    (byType.get(key) ?? byType.set(key, []).get(key)!).push(it);
  }
  for (const [type, list] of [...byType.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${type.padEnd(20)}  ${list.length}`);
  }

  console.log("\n" + sep);
  console.log("AGRUPAMENTO POR existência de rawCategory");
  console.log(sep);
  const withCat = items.filter((it) => it.rawCategories.length > 0).length;
  const withoutCat = items.length - withCat;
  console.log(`  com rawCategory:      ${withCat}`);
  console.log(`  sem rawCategory:      ${withoutCat}`);

  console.log("\n" + sep);
  console.log("PRIMEIRAS PALAVRAS DE rawCategory (frequência)");
  console.log(sep);
  const headFreq = new Map<string, number>();
  for (const it of items) {
    for (const cat of it.rawCategories) {
      const head = cat.split(/[>|]/)[0]?.trim().slice(0, 50);
      if (head) headFreq.set(head, (headFreq.get(head) ?? 0) + 1);
    }
  }
  for (const [head, n] of [...headFreq.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n.toString().padStart(3)}  ${head}`);
  }

  await prisma.$disconnect();
}

function dedupe(arr: Array<string | null>): string[] {
  const out = new Set<string>();
  for (const v of arr) if (v && v.trim()) out.add(v.trim());
  return Array.from(out);
}

main()
  .catch((err) => {
    console.error("[erro fatal]", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await prisma.$disconnect();
    } catch {}
  });
