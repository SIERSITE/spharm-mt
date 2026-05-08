/**
 * scripts/diagnose-outros-medicamentos.ts
 *
 * Diagnóstico READ-ONLY do bucket "MEDICAMENTO + classificacaoNivel2 =
 * Outros Medicamentos". ZERO escritas em qualquer tabela. Apenas queries
 * SELECT contra `Produto`, `Classificacao` e `InfarmedSnapshot`.
 *
 * Responde:
 *   1. Cobertura INFARMED — dos N produtos do cohort:
 *        · quantos existem no InfarmedSnapshot por CNP
 *        · quantos têm `codigoATC` preenchido no snapshot
 *        · quantos têm `dci` preenchido no snapshot
 *        · quantos têm ambos null no snapshot
 *        · quantos NÃO existem no snapshot
 *
 *   2. Hipótese (separação heurística):
 *        · "provável medicamento real sem ATC/DCI" — está no snapshot
 *          E tem pelo menos um sinal estrutural (titularAim, forma
 *          farmacêutica ou dosagem) — INFARMED reconhece o produto, só
 *          ATC/DCI é que ficou em null. Re-import do snapshot pode
 *          preencher.
 *        · "provável não-medicamento mis-classificado" — ausente do
 *          snapshot OU classifier text-only (sem flag/ATC/tipoArtigo)
 *          devolve DERMOCOSMETICA/SUPLEMENTO/HIGIENE_CUIDADO/etc com
 *          confiança ≥ 0.65.
 *
 *   3. Amostras (20 cada):
 *        · presentes no snapshot mas sem ATC/DCI
 *        · ausentes do snapshot
 *        · candidatos a não-medicamento (classifier text-only diverge)
 *
 * Uso:
 *   npx tsx scripts/diagnose-outros-medicamentos.ts
 */

import "dotenv/config";
import { legacyPrisma as prisma } from "../lib/prisma";
import { classifyProductType } from "../lib/catalog-classifier";
import type { ProductType } from "../lib/catalog-types";

const NIVEL2_NOME = "Outros Medicamentos";
const SAMPLE_SIZE = 20;

type CohortRow = {
  id: string;
  cnp: number;
  designacao: string;
  codigoATC: string | null;
  dci: string | null;
  validadoManualmente: boolean;
  flagMSRM: boolean;
  flagMNSRM: boolean;
};

type SnapshotRow = {
  cnp: number;
  dci: string | null;
  codigoATC: string | null;
  titularAim: string | null;
  formaFarmaceutica: string | null;
  dosagem: string | null;
  embalagem: string | null;
  grupoTerapeutico: string | null;
  estadoAim: string | null;
};

function trunc(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

async function main(): Promise<void> {
  console.log("═".repeat(74));
  console.log(`Diagnóstico — MEDICAMENTO + classificacaoNivel2="${NIVEL2_NOME}"`);
  console.log("READ-ONLY — zero writes");
  console.log("═".repeat(74));

  // 1. Resolver o id do nivel2 alvo (com proteção: parent deve ser MEDICAMENTOS)
  const nivel2 = await prisma.classificacao.findFirst({
    where: {
      tipo: "NIVEL_2",
      estado: "ATIVO",
      nome: { equals: NIVEL2_NOME, mode: "insensitive" },
      classificacaoPai: { nome: { equals: "MEDICAMENTOS", mode: "insensitive" } },
    },
    select: { id: true },
  });

  if (!nivel2) {
    console.error(
      `[fatal] Classificacao NIVEL_2 "${NIVEL2_NOME}" filho de "MEDICAMENTOS" ` +
        `não encontrada. Corre 'npx tsx scripts/seed-taxonomy.ts'.`,
    );
    process.exitCode = 1;
    return;
  }

  // 2. Carregar cohort completo (sem paginar — 6k registos é seguro
  //    em memória; campos minimais para reduzir custo)
  const cohort = (await prisma.produto.findMany({
    where: {
      productType: "MEDICAMENTO",
      classificacaoNivel2Id: nivel2.id,
      estado: { not: "INATIVO" },
      cnp: { gt: 2_000_000 },
    },
    select: {
      id: true,
      cnp: true,
      designacao: true,
      codigoATC: true,
      dci: true,
      validadoManualmente: true,
      flagMSRM: true,
      flagMNSRM: true,
    },
    orderBy: { cnp: "asc" },
  })) as CohortRow[];

  console.log(`\nCohort total: ${cohort.length} produtos`);

  // 3. Cruza com InfarmedSnapshot por CNP — uma única query.
  //    findMany com `cnp: { in: ... }` aceita arrays grandes.
  const snapshots = (await prisma.infarmedSnapshot.findMany({
    where: { cnp: { in: cohort.map((p) => p.cnp) } },
    select: {
      cnp: true,
      dci: true,
      codigoATC: true,
      titularAim: true,
      formaFarmaceutica: true,
      dosagem: true,
      embalagem: true,
      grupoTerapeutico: true,
      estadoAim: true,
    },
  })) as SnapshotRow[];

  const byCnp = new Map<number, SnapshotRow>();
  for (const s of snapshots) byCnp.set(s.cnp, s);

  // 4. Bucket counts — passos isolados para clareza no output
  let presentInSnapshot = 0;
  let presentWithAtc = 0;
  let presentWithDci = 0;
  let presentWithBoth = 0;
  let presentBothNull = 0;
  let absentFromSnapshot = 0;

  // Snapshot info adicional (estado AIM)
  const presentByEstadoAim = new Map<string, number>();

  for (const p of cohort) {
    const s = byCnp.get(p.cnp);
    if (!s) {
      absentFromSnapshot++;
    } else {
      presentInSnapshot++;
      const hasAtc = !!s.codigoATC;
      const hasDci = !!s.dci;
      if (hasAtc) presentWithAtc++;
      if (hasDci) presentWithDci++;
      if (hasAtc && hasDci) presentWithBoth++;
      if (!hasAtc && !hasDci) presentBothNull++;
      const estado = s.estadoAim ?? "(null)";
      presentByEstadoAim.set(estado, (presentByEstadoAim.get(estado) ?? 0) + 1);
    }
  }

  console.log(`\n— Cobertura INFARMED —`);
  console.log(
    `  presentes no snapshot:                ${presentInSnapshot} / ${cohort.length} ` +
      `(${((presentInSnapshot / cohort.length) * 100).toFixed(1)}%)`,
  );
  console.log(`    com codigoATC preenchido:           ${presentWithAtc}`);
  console.log(`    com dci preenchido:                 ${presentWithDci}`);
  console.log(`    com AMBOS preenchidos:              ${presentWithBoth}`);
  console.log(`    com AMBOS null:                     ${presentBothNull}`);
  console.log(
    `  ausentes do snapshot:                 ${absentFromSnapshot} / ${cohort.length} ` +
      `(${((absentFromSnapshot / cohort.length) * 100).toFixed(1)}%)`,
  );
  if (presentByEstadoAim.size > 0) {
    console.log(`\n  estadoAim dos presentes:`);
    const sorted = [...presentByEstadoAim.entries()].sort((a, b) => b[1] - a[1]);
    for (const [estado, count] of sorted) {
      console.log(`    ${estado.padEnd(20)} ${count}`);
    }
  }

  // 5. Hipóteses de segregação
  //    Critério "real medicament": presente em INFARMED com pelo menos um
  //    sinal estrutural (titularAim, formaFarmaceutica ou dosagem) — INFARMED
  //    reconhece o produto, é registado, falta-lhe só ATC/DCI populado.
  //
  //    Critério "não-medicamento": ausente do snapshot OU classifier text-
  //    only devolve um tipo específico ≠ MEDICAMENTO com conf ≥ 0.65.
  //
  //    Quando ambos os critérios se aplicam, o "real medicament" vence
  //    porque INFARMED é a fonte de verdade regulatória; o text-only do
  //    classifier é ruidoso (não tem contexto regulatório).
  let hypRealMedNoSignal = 0;
  let hypNonMedicament = 0;
  let hypOther = 0;

  const samplePresentNoAtcDci: Array<{ p: CohortRow; s: SnapshotRow }> = [];
  const sampleAbsent: CohortRow[] = [];
  const sampleNonMedCandidate: Array<{
    p: CohortRow;
    inSnap: boolean;
    opinion: ProductType;
    conf: number;
  }> = [];

  // Distribuição auxiliar — opiniões text-only do cohort
  const textOnlyOpinionCounts = new Map<string, number>();

  for (const p of cohort) {
    const s = byCnp.get(p.cnp);
    const inSnap = !!s;
    const snapHasStructuralSignal =
      inSnap && (!!s!.titularAim || !!s!.formaFarmaceutica || !!s!.dosagem);
    const snapHasAtcOrDci = inSnap && (!!s!.codigoATC || !!s!.dci);

    const textOnly = classifyProductType({
      designacao: p.designacao,
      tipoArtigo: null,
      flagMSRM: false,
      flagMNSRM: false,
      codigoATC: null,
    });
    const opinionKey = `${textOnly.productType} (${(textOnly.confidence * 100).toFixed(0)}%)`;
    textOnlyOpinionCounts.set(
      textOnly.productType,
      (textOnlyOpinionCounts.get(textOnly.productType) ?? 0) + 1,
    );

    const isNonMedSuspect =
      textOnly.productType !== "MEDICAMENTO" &&
      textOnly.productType !== "OUTRO" &&
      textOnly.confidence >= 0.65;

    // Classificação heurística
    if (inSnap && snapHasStructuralSignal) {
      hypRealMedNoSignal++;
    } else if (!inSnap || isNonMedSuspect) {
      hypNonMedicament++;
    } else {
      hypOther++;
    }

    // Amostras
    if (
      inSnap &&
      !snapHasAtcOrDci &&
      samplePresentNoAtcDci.length < SAMPLE_SIZE
    ) {
      samplePresentNoAtcDci.push({ p, s: s! });
    }
    if (!inSnap && sampleAbsent.length < SAMPLE_SIZE) {
      sampleAbsent.push(p);
    }
    if (isNonMedSuspect && sampleNonMedCandidate.length < SAMPLE_SIZE) {
      sampleNonMedCandidate.push({
        p,
        inSnap,
        opinion: textOnly.productType,
        conf: textOnly.confidence,
      });
    }
    void opinionKey; // suprime unused: opinionKey é só para diagnóstico futuro
  }

  console.log(`\n— Hipóteses (heurística) —`);
  console.log(
    `  provável medicamento real sem ATC/DCI: ${hypRealMedNoSignal} / ${cohort.length} ` +
      `(${((hypRealMedNoSignal / cohort.length) * 100).toFixed(1)}%)`,
  );
  console.log(
    `  provável não-medicamento:              ${hypNonMedicament} / ${cohort.length} ` +
      `(${((hypNonMedicament / cohort.length) * 100).toFixed(1)}%)`,
  );
  console.log(
    `  outro / inconclusivo:                  ${hypOther} / ${cohort.length} ` +
      `(${((hypOther / cohort.length) * 100).toFixed(1)}%)`,
  );

  console.log(`\n  Distribuição da opinião text-only do classifier (todos os ${cohort.length}):`);
  const sorted = [...textOnlyOpinionCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [type, count] of sorted) {
    console.log(`    ${type.padEnd(20)} ${count}`);
  }

  // 6. Amostras
  console.log(`\n${"─".repeat(74)}`);
  console.log(`Amostra A (até ${SAMPLE_SIZE}) — presentes em INFARMED sem ATC/DCI`);
  console.log("─".repeat(74));
  console.log(
    `  ${"CNP".padEnd(9)} ${"Designação (≤45)".padEnd(45)} ${"Forma".padEnd(14)} ${"TitularAim (≤20)".padEnd(20)}`,
  );
  for (const { p, s } of samplePresentNoAtcDci) {
    console.log(
      `  ${String(p.cnp).padEnd(9)} ${trunc(p.designacao, 45).padEnd(45)} ${trunc(s.formaFarmaceutica ?? "—", 14).padEnd(14)} ${trunc(s.titularAim ?? "—", 20).padEnd(20)}`,
    );
  }
  if (samplePresentNoAtcDci.length === 0) {
    console.log("  (vazio — nenhum produto presente sem ATC/DCI)");
  }

  console.log(`\n${"─".repeat(74)}`);
  console.log(`Amostra B (até ${SAMPLE_SIZE}) — ausentes do InfarmedSnapshot`);
  console.log("─".repeat(74));
  console.log(
    `  ${"CNP".padEnd(9)} ${"Designação (≤55)".padEnd(55)} ${"flags"}`,
  );
  for (const p of sampleAbsent) {
    const flags = `${p.flagMSRM ? "MSRM " : ""}${p.flagMNSRM ? "MNSRM " : ""}${p.codigoATC ? `ATC=${p.codigoATC} ` : ""}${p.dci ? `DCI=${p.dci.slice(0, 20)}` : ""}`.trim();
    console.log(
      `  ${String(p.cnp).padEnd(9)} ${trunc(p.designacao, 55).padEnd(55)} ${flags || "(sem flags)"}`,
    );
  }
  if (sampleAbsent.length === 0) {
    console.log("  (vazio — todos os produtos do cohort estão no snapshot)");
  }

  console.log(`\n${"─".repeat(74)}`);
  console.log(
    `Amostra C (até ${SAMPLE_SIZE}) — candidatos a NÃO-medicamento (classifier text-only ≠ MEDICAMENTO, conf ≥ 65%)`,
  );
  console.log("─".repeat(74));
  console.log(
    `  ${"CNP".padEnd(9)} ${"Designação (≤45)".padEnd(45)} ${"opinion".padEnd(20)} ${"snap"}`,
  );
  for (const c of sampleNonMedCandidate) {
    console.log(
      `  ${String(c.p.cnp).padEnd(9)} ${trunc(c.p.designacao, 45).padEnd(45)} ${`${c.opinion} ${(c.conf * 100).toFixed(0)}%`.padEnd(20)} ${c.inSnap ? "in" : "out"}`,
    );
  }
  if (sampleNonMedCandidate.length === 0) {
    console.log("  (vazio — classifier text-only não detectou candidatos com conf ≥ 65%)");
  }

  console.log(`\n${"═".repeat(74)}`);
  console.log("Diagnóstico completo. Nenhum write efectuado.");
  console.log("═".repeat(74));
}

main()
  .catch((err) => {
    console.error("[erro fatal]", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
