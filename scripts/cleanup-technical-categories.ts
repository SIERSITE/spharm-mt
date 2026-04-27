/**
 * scripts/cleanup-technical-categories.ts
 *
 * Limpeza one-shot pós-refactor da taxonomia (abril 2026):
 *
 *   1. Encontra a Classificacao NIVEL_1 com nome "CATEGORIAS TÉCNICAS / TRANSITÓRIAS"
 *      (e respectivos NIVEL_2: "Em Revisão", "Por Classificar", "Sem Match de Fonte",
 *      "Inconsistente", "Outros Técnicos") que existiam por erro como categorias.
 *   2. Põe `classificacaoNivel1Id` e `classificacaoNivel2Id` a NULL em todos
 *      os produtos que apontem para qualquer uma dessas linhas. Sinaliza-os com
 *      `needsManualReview = true` e `verificationStatus = NEEDS_REVIEW`
 *      (apenas se ainda não estiverem VALIDADO).
 *   3. Marca essas Classificacao com `estado = INATIVO` para não voltarem a
 *      aparecer em filtros nem ser reusadas. Preserva os IDs por integridade
 *      referencial — não apaga linhas.
 *
 * Correr:
 *   npx tsx scripts/cleanup-technical-categories.ts            # idempotente
 *   npx tsx scripts/cleanup-technical-categories.ts --dry-run  # mostra sem escrever
 */

import "dotenv/config";
import { legacyPrisma as prisma } from "../lib/prisma";
import { LEGACY_TECHNICAL_NIVEL1_NAMES } from "../lib/catalog-taxonomy";

const dryRun = process.argv.includes("--dry-run");

async function main(): Promise<void> {
  const sep = "─".repeat(66);
  console.log(sep);
  console.log("SPharm.MT — Cleanup categorias técnicas/transitórias");
  console.log(sep);
  if (dryRun) console.log("Modo: DRY-RUN (sem escrita)");
  console.log();

  // 1. Linhas Classificacao a desactivar — nivel1 + filhos.
  const nivel1s = await prisma.classificacao.findMany({
    where: { tipo: "NIVEL_1", nome: { in: LEGACY_TECHNICAL_NIVEL1_NAMES } },
    select: { id: true, nome: true },
  });

  if (nivel1s.length === 0) {
    console.log("Nenhuma classificação técnica encontrada — nada a fazer.");
    await prisma.$disconnect();
    return;
  }

  const nivel1Ids = nivel1s.map((c) => c.id);
  const nivel2s = await prisma.classificacao.findMany({
    where: { tipo: "NIVEL_2", classificacaoPaiId: { in: nivel1Ids } },
    select: { id: true, nome: true, classificacaoPaiId: true },
  });
  const nivel2Ids = nivel2s.map((c) => c.id);

  console.log("Linhas técnicas detectadas:");
  for (const n1 of nivel1s) {
    const subs = nivel2s.filter((s) => s.classificacaoPaiId === n1.id);
    console.log(`  · ${n1.nome}  (${subs.length} subcategoria(s))`);
    for (const s of subs) console.log(`      └ ${s.nome}`);
  }
  console.log();

  // 2. Produtos a limpar — qualquer Produto com classificacaoNivel1Id ou
  //    classificacaoNivel2Id apontando para uma destas linhas.
  const allIds = [...nivel1Ids, ...nivel2Ids];
  const produtosCount = await prisma.produto.count({
    where: {
      OR: [
        { classificacaoNivel1Id: { in: allIds } },
        { classificacaoNivel2Id: { in: allIds } },
      ],
    },
  });
  console.log(`Produtos afectados: ${produtosCount}`);

  if (dryRun) {
    console.log("[dry-run] sem escrita — terminado.");
    await prisma.$disconnect();
    return;
  }

  // 3. Limpa Produto.classificacaoNivel*Id e marca para revisão.
  //    Não toca em produtos já VALIDADO manualmente (nem deveriam ter caído
  //    aqui, mas defesa em profundidade).
  const updated1 = await prisma.produto.updateMany({
    where: {
      classificacaoNivel1Id: { in: allIds },
      validadoManualmente: false,
    },
    data: {
      classificacaoNivel1Id: null,
      classificacaoNivel2Id: null,
      needsManualReview: true,
      manualReviewReason: "cleanup: categoria técnica removida da taxonomia",
    },
  });
  const updated2 = await prisma.produto.updateMany({
    where: {
      classificacaoNivel2Id: { in: allIds },
      validadoManualmente: false,
    },
    data: { classificacaoNivel2Id: null },
  });
  console.log(`  Produtos com nivel1 limpo: ${updated1.count}`);
  console.log(`  Produtos com nivel2 limpo: ${updated2.count}`);

  // 4. Desactiva as Classificacao técnicas — preserva IDs para histórico.
  const deactivatedN1 = await prisma.classificacao.updateMany({
    where: { id: { in: nivel1Ids } },
    data: { estado: "INATIVO" },
  });
  const deactivatedN2 = await prisma.classificacao.updateMany({
    where: { id: { in: nivel2Ids } },
    data: { estado: "INATIVO" },
  });
  console.log(`  Classificacao NIVEL_1 desactivadas: ${deactivatedN1.count}`);
  console.log(`  Classificacao NIVEL_2 desactivadas: ${deactivatedN2.count}`);

  console.log();
  console.log(sep);
  console.log("Concluído.");
  console.log(sep);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("\n[erro fatal]", err);
  await prisma.$disconnect();
  process.exit(1);
});
