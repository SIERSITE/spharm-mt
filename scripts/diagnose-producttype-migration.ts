/**
 * scripts/diagnose-producttype-migration.ts
 *
 * Dry-run READ-ONLY de migração de productType para o bucket
 * "MEDICAMENTO + classificacaoNivel2 = Outros Medicamentos".
 *
 * Para cada produto do cohort:
 *   · Corre `classifyProductType` em modo TEXT-ONLY (flagMSRM=false,
 *     flagMNSRM=false, codigoATC=null, tipoArtigo=null, sem origem).
 *   · Agrupa o productType proposto pelo classifier.
 *   · Mostra contadores, estatísticas de confiança e até 30 exemplos
 *     por destino (CNP, designação, ATC/DCI actuais, presença em
 *     InfarmedSnapshot, sinais que originaram a decisão).
 *
 * ZERO WRITES. Esta é APENAS uma medição — não altera Produto,
 * Classificacao, FilaRevisao, EnriquecimentoFila, ou qualquer outra
 * tabela. O objectivo é decidir, com números reais, quantos produtos
 * sairiam de MEDICAMENTO e com que confiança, antes de planear uma
 * migração efectiva.
 *
 * Uso:
 *   npx tsx scripts/diagnose-producttype-migration.ts
 *
 *   # Limitar exemplos por destino (default 30)
 *   npx tsx scripts/diagnose-producttype-migration.ts --examples=50
 */

import "dotenv/config";
import { legacyPrisma as prisma } from "../lib/prisma";
import { classifyProductType } from "../lib/catalog-classifier";
import type { ProductType } from "../lib/catalog-types";

const NIVEL2_NOME = "Outros Medicamentos";

type Args = {
  examplesPerGroup: number;
};

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const out: Args = { examplesPerGroup: 30 };
  for (const a of args) {
    if (a.startsWith("--examples=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (!isNaN(n) && n > 0 && n <= 200) out.examplesPerGroup = n;
    } else {
      console.warn(`[aviso] argumento desconhecido: ${a}`);
    }
  }
  return out;
}

type CohortRow = {
  id: string;
  cnp: number;
  designacao: string;
  codigoATC: string | null;
  dci: string | null;
  flagMSRM: boolean;
  flagMNSRM: boolean;
};

type Sample = {
  cnp: number;
  designacao: string;
  proposedType: ProductType;
  confidence: number;
  signals: string[];
  inSnapshot: boolean;
  hasAtc: boolean;
  hasDci: boolean;
};

function trunc(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

async function main(): Promise<void> {
  const args = parseArgs();

  console.log("═".repeat(74));
  console.log(`Dry-run productType migration — cohort "MEDICAMENTO + ${NIVEL2_NOME}"`);
  console.log("READ-ONLY — zero writes em qualquer tabela");
  console.log("═".repeat(74));
  console.log(`  examplesPerGroup: ${args.examplesPerGroup}`);

  // 1. Resolver nivel2 alvo (filho directo de MEDICAMENTOS)
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
      `[fatal] Classificacao NIVEL_2 "${NIVEL2_NOME}" filho de MEDICAMENTOS ` +
        `não encontrada.`,
    );
    process.exitCode = 1;
    return;
  }

  // 2. Cohort
  const cohort = (await prisma.produto.findMany({
    where: {
      productType: "MEDICAMENTO",
      classificacaoNivel2Id: nivel2.id,
      validadoManualmente: false,
      estado: { not: "INATIVO" },
      cnp: { gt: 2_000_000 },
    },
    select: {
      id: true,
      cnp: true,
      designacao: true,
      codigoATC: true,
      dci: true,
      flagMSRM: true,
      flagMNSRM: true,
    },
    orderBy: { cnp: "asc" },
  })) as CohortRow[];

  console.log(`\nCohort total: ${cohort.length} produtos`);

  // 3. Cross-reference InfarmedSnapshot (apenas para sinalizar in/out)
  const snapshots = await prisma.infarmedSnapshot.findMany({
    where: { cnp: { in: cohort.map((p) => p.cnp) } },
    select: { cnp: true },
  });
  const inSnapshot = new Set<number>(snapshots.map((s) => s.cnp));

  // 4. Para cada produto, correr classifier text-only
  const samples: Sample[] = [];
  for (const p of cohort) {
    const cls = classifyProductType({
      designacao: p.designacao,
      tipoArtigo: null,
      flagMSRM: false,
      flagMNSRM: false,
      codigoATC: null,
    });
    samples.push({
      cnp: p.cnp,
      designacao: p.designacao,
      proposedType: cls.productType,
      confidence: cls.confidence,
      signals: cls.signals,
      inSnapshot: inSnapshot.has(p.cnp),
      hasAtc: !!p.codigoATC,
      hasDci: !!p.dci,
    });
  }

  // 5. Agrupar por destino. Buckets explícitos pedidos:
  //    VETERINARIA, DERMOCOSMETICA, SUPLEMENTO, OUTRO, MEDICAMENTO (manter)
  //    Outros tipos (PUERICULTURA, HIGIENE_CUIDADO, ORTOPEDIA,
  //    DISPOSITIVO_MEDICO) entram num bucket "outros tipos" para visibilidade.
  const groups = new Map<ProductType, Sample[]>();
  for (const s of samples) {
    const arr = groups.get(s.proposedType) ?? [];
    arr.push(s);
    groups.set(s.proposedType, arr);
  }

  // Ordem de impressão — destinos de migração primeiro, MEDICAMENTO no fim.
  const PRINT_ORDER: ProductType[] = [
    "VETERINARIA",
    "DERMOCOSMETICA",
    "SUPLEMENTO",
    "HIGIENE_CUIDADO",
    "PUERICULTURA",
    "ORTOPEDIA",
    "DISPOSITIVO_MEDICO",
    "OUTRO",
    "MEDICAMENTO",
  ];

  // ── Sumário no topo ──────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(74)}`);
  console.log("SUMÁRIO — migração proposta por destino");
  console.log("═".repeat(74));
  console.log(
    `  ${"Destino".padEnd(22)} ${"count".padStart(6)} ${"%".padStart(6)} ` +
      `${"avg".padStart(5)} ${"min".padStart(5)} ${"max".padStart(5)} ` +
      `${"in_snap".padStart(8)}`,
  );
  for (const type of PRINT_ORDER) {
    const arr = groups.get(type);
    if (!arr || arr.length === 0) continue;
    const confs = arr.map((s) => s.confidence);
    const avg = confs.reduce((a, b) => a + b, 0) / confs.length;
    const min = Math.min(...confs);
    const max = Math.max(...confs);
    const inSnap = arr.filter((s) => s.inSnapshot).length;
    const pct = ((arr.length / cohort.length) * 100).toFixed(1);
    const labelMig = type === "MEDICAMENTO" ? "(manter)" : "→";
    console.log(
      `  ${`${labelMig} ${type}`.padEnd(22)} ${String(arr.length).padStart(6)} ` +
        `${pct.padStart(5)}% ${fmtPct(avg).padStart(5)} ` +
        `${fmtPct(min).padStart(5)} ${fmtPct(max).padStart(5)} ` +
        `${String(inSnap).padStart(8)}`,
    );
  }

  // ── Detalhe por grupo (com exemplos) ─────────────────────────────────────
  for (const type of PRINT_ORDER) {
    const arr = groups.get(type);
    if (!arr || arr.length === 0) continue;

    console.log(`\n${"─".repeat(74)}`);
    const dirLabel = type === "MEDICAMENTO" ? "(manter MEDICAMENTO)" : `→ ${type}`;
    console.log(`Destino: MEDICAMENTO ${dirLabel}  —  ${arr.length} produtos`);
    console.log("─".repeat(74));

    // Exemplos (até N) — ordenados por confiança decrescente (top-confidence
    // primeiro, para que o reviewer veja os casos mais óbvios no topo).
    const sorted = [...arr].sort((a, b) => b.confidence - a.confidence);
    const examples = sorted.slice(0, args.examplesPerGroup);

    console.log(
      `  ${"CNP".padEnd(9)} ${"Designação (≤45)".padEnd(45)} ` +
        `${"conf".padStart(5)} ${"snap".padStart(5)} ${"ATC".padStart(4)} ${"DCI".padStart(4)} ` +
        `signals`,
    );
    for (const s of examples) {
      const sigShort = s.signals.length > 0
        ? s.signals.filter((x) => !x.startsWith("origem_")).slice(0, 4).join(",")
        : "(none)";
      console.log(
        `  ${String(s.cnp).padEnd(9)} ${trunc(s.designacao, 45).padEnd(45)} ` +
          `${fmtPct(s.confidence).padStart(5)} ${(s.inSnapshot ? "in" : "out").padStart(5)} ` +
          `${(s.hasAtc ? "yes" : "no").padStart(4)} ${(s.hasDci ? "yes" : "no").padStart(4)} ` +
          `${trunc(sigShort, 60)}`,
      );
    }
    if (arr.length > examples.length) {
      console.log(`  … (+${arr.length - examples.length} produtos omitidos)`);
    }
  }

  // ── Recomendação ─────────────────────────────────────────────────────────
  const totalMigrate =
    (groups.get("VETERINARIA")?.length ?? 0) +
    (groups.get("DERMOCOSMETICA")?.length ?? 0) +
    (groups.get("SUPLEMENTO")?.length ?? 0) +
    (groups.get("HIGIENE_CUIDADO")?.length ?? 0) +
    (groups.get("PUERICULTURA")?.length ?? 0) +
    (groups.get("ORTOPEDIA")?.length ?? 0) +
    (groups.get("DISPOSITIVO_MEDICO")?.length ?? 0);
  const totalKeep = groups.get("MEDICAMENTO")?.length ?? 0;
  const totalUnknown = groups.get("OUTRO")?.length ?? 0;

  console.log(`\n${"═".repeat(74)}`);
  console.log("AGREGADO");
  console.log("═".repeat(74));
  console.log(
    `  migrar para outro tipo: ${totalMigrate} ` +
      `(${((totalMigrate / cohort.length) * 100).toFixed(1)}%)`,
  );
  console.log(
    `  manter MEDICAMENTO:     ${totalKeep} ` +
      `(${((totalKeep / cohort.length) * 100).toFixed(1)}%)`,
  );
  console.log(
    `  inconclusivo (OUTRO):   ${totalUnknown} ` +
      `(${((totalUnknown / cohort.length) * 100).toFixed(1)}%)`,
  );

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
