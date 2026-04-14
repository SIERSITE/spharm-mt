/**
 * scripts/validate-pipeline.ts
 *
 * Script de validação do pipeline de enriquecimento SPharm.MT.
 *
 * Corre o pipeline ponta-a-ponta (classify → connectors → resolve) sobre uma
 * amostra real de produtos e produz um relatório detalhado.
 *
 * NUNCA grava na BD — é pura observação. Ideal para:
 *   - validar a qualidade da classificação interna
 *   - medir cobertura dos conectores por tipo de produto
 *   - detectar conflitos e casos duvidosos antes de ligar conectores reais
 *   - verificar que a resolução por campo e tier funciona como esperado
 *
 * Uso:
 *   npx tsx scripts/validate-pipeline.ts
 *   npx tsx scripts/validate-pipeline.ts --limit=50
 *   npx tsx scripts/validate-pipeline.ts --sample=random --limit=100
 *   npx tsx scripts/validate-pipeline.ts --cnp=6304774
 *   npx tsx scripts/validate-pipeline.ts --type=MEDICAMENTO --limit=30
 *   npx tsx scripts/validate-pipeline.ts --verbose
 *   npx tsx scripts/validate-pipeline.ts --json > report.json
 *
 * Opções:
 *   --limit=N       Máximo de produtos (default: 20)
 *   --sample=MODE   "first" (default) | "random"
 *   --cnp=N         Validar apenas o produto com este CNP
 *   --type=TYPE     Filtrar por productType (ex: MEDICAMENTO, DERMOCOSMETICA)
 *   --verbose       Mostrar signals da classificação e detalhes completos
 *   --json          Emitir JSON estruturado em vez de relatório humano
 */

import "dotenv/config";
import { legacyPrisma as prisma } from "../lib/prisma";
import type { Prisma } from "../generated/prisma/client";
import { classifyProductType } from "../lib/catalog-classifier";
import { runConnectors } from "../lib/catalog-connectors";
import { resolveProduct } from "../lib/catalog-resolution-engine";
import { fetchOrigemSignals } from "../lib/catalog-enrichment";
import type {
  ClassificationResult,
  ExternalLookupRequest,
  ExternalSourceData,
  ProductType,
  ResolvedField,
  ResolvedProduct,
} from "../lib/catalog-types";

// ─── Args ─────────────────────────────────────────────────────────────────────

type Args = {
  limit: number;
  sample: "first" | "random";
  cnp: number | null;
  type: ProductType | null;
  verbose: boolean;
  json: boolean;
};

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const out: Args = {
    limit: 20,
    sample: "first",
    cnp: null,
    type: null,
    verbose: false,
    json: false,
  };

  for (const arg of args) {
    if (arg.startsWith("--limit=")) {
      const n = parseInt(arg.split("=")[1], 10);
      if (!isNaN(n) && n > 0) out.limit = n;
    } else if (arg.startsWith("--sample=")) {
      const v = arg.split("=")[1];
      if (v === "first" || v === "random") out.sample = v;
    } else if (arg.startsWith("--cnp=")) {
      const n = parseInt(arg.split("=")[1], 10);
      if (!isNaN(n)) out.cnp = n;
    } else if (arg.startsWith("--type=")) {
      out.type = arg.split("=")[1] as ProductType;
    } else if (arg === "--verbose") {
      out.verbose = true;
    } else if (arg === "--json") {
      out.json = true;
    } else {
      console.warn(`[aviso] Argumento desconhecido: ${arg}`);
    }
  }

  return out;
}

// ─── Carregamento de amostra ──────────────────────────────────────────────────

async function loadSample(args: Args) {
  if (args.cnp !== null) {
    const p = await prisma.produto.findUnique({
      where: { cnp: args.cnp },
      select: selectProductFields(),
    });
    return p ? [p] : [];
  }

  const where: Prisma.ProdutoWhereInput = {
    estado: { not: "INATIVO" },
  };
  if (args.type) {
    where.productType = args.type;
  }

  if (args.sample === "random") {
    // Random sampling: fetch a larger pool and pick random subset
    const pool = await prisma.produto.findMany({
      where,
      select: selectProductFields(),
      take: args.limit * 10,
    });
    shuffle(pool);
    return pool.slice(0, args.limit);
  }

  return prisma.produto.findMany({
    where,
    select: selectProductFields(),
    take: args.limit,
    orderBy: { dataCriacao: "asc" },
  });
}

function selectProductFields() {
  return {
    id: true,
    cnp: true,
    designacao: true,
    tipoArtigo: true,
    flagMSRM: true,
    flagMNSRM: true,
    codigoATC: true,
    fabricanteId: true,
    dci: true,
    formaFarmaceutica: true,
    dosagem: true,
    embalagem: true,
    imagemUrl: true,
    validadoManualmente: true,
    productType: true,
    productTypeConfidence: true,
    classificationVersion: true,
    verificationStatus: true,
  };
}

function shuffle<T>(a: T[]): void {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}

// ─── Execução do pipeline (sem persistência) ─────────────────────────────────

type ProductRow = Awaited<ReturnType<typeof loadSample>>[number];

type ProductReport = {
  cnp: number;
  designacao: string;
  validadoManualmente: boolean;
  classification: {
    productType: ProductType;
    confidence: number;
    source: string;
    version: string;
    signals: string[];
    hints: ClassificationResult["hints"];
  };
  connectors: {
    attempted: string[];
    succeeded: Array<{ source: string; tier: string; confidence: number }>;
  };
  resolvedFields: Record<string, { value: string; confidence: number; source: string; tier: string; agreementCount: number } | null>;
  verificationStatus: ResolvedProduct["verificationStatus"];
  externallyVerified: boolean;
  needsManualReview: boolean;
  manualReviewReason: string | null;
  conflicts: ResolvedProduct["conflicts"];
};

async function runPipeline(product: ProductRow): Promise<ProductReport> {
  const origem = await fetchOrigemSignals(product.id);
  const classification = classifyProductType({
    designacao: product.designacao,
    tipoArtigo: product.tipoArtigo,
    flagMSRM: product.flagMSRM,
    flagMNSRM: product.flagMNSRM,
    codigoATC: product.codigoATC,
    categoriaOrigem: origem.categoriaOrigem,
    subcategoriaOrigem: origem.subcategoriaOrigem,
  });

  const lookupReq: ExternalLookupRequest = {
    productId: product.id,
    cnp: product.cnp,
    designacao: product.designacao,
    productType: classification.productType,
    hints: classification.hints,
  };

  const sources: ExternalSourceData[] = await runConnectors(lookupReq);
  const resolved = resolveProduct(classification, sources);

  const fieldOf = (f: ResolvedField<string> | null) =>
    f ? { value: f.value, confidence: f.confidence, source: f.source, tier: f.tier, agreementCount: f.agreementCount } : null;

  return {
    cnp: product.cnp,
    designacao: product.designacao,
    validadoManualmente: product.validadoManualmente,
    classification: {
      productType: classification.productType,
      confidence: classification.confidence,
      source: classification.classificationSource,
      version: classification.classificationVersion,
      signals: classification.signals,
      hints: classification.hints,
    },
    connectors: {
      attempted: classification.hints.preferredSources,
      succeeded: sources.map(s => ({ source: s.source, tier: s.tier, confidence: s.confidence })),
    },
    resolvedFields: {
      fabricante:        fieldOf(resolved.fabricante),
      dci:               fieldOf(resolved.dci),
      codigoATC:         fieldOf(resolved.codigoATC),
      formaFarmaceutica: fieldOf(resolved.formaFarmaceutica),
      dosagem:           fieldOf(resolved.dosagem),
      embalagem:         fieldOf(resolved.embalagem),
      imagemUrl:         fieldOf(resolved.imagemUrl),
      categoria:         fieldOf(resolved.categoria),
      subcategoria:      fieldOf(resolved.subcategoria),
    },
    verificationStatus: resolved.verificationStatus,
    externallyVerified: resolved.externallyVerified,
    needsManualReview: resolved.needsManualReview,
    manualReviewReason: resolved.manualReviewReason,
    conflicts: resolved.conflicts,
  };
}

// ─── Relatório humano ────────────────────────────────────────────────────────

function printHumanReport(report: ProductReport, verbose: boolean): void {
  const c = report.classification;
  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
  const protectedFlag = report.validadoManualmente ? " [PROTEGIDO]" : "";

  console.log("─".repeat(72));
  console.log(
    `[${c.productType} ${pct(c.confidence)}] CNP:${report.cnp}${protectedFlag}`
  );
  console.log(`  "${report.designacao}"`);
  console.log(
    `  Classif: ${c.source} v${c.version}  |  Verificação: ${report.verificationStatus}` +
    (report.externallyVerified ? " [externo]" : "")
  );

  if (verbose) {
    console.log(`  Signals: ${c.signals.join(", ") || "—"}`);
    console.log(`  Hints.sources: ${c.hints.preferredSources.join(" → ")}`);
    console.log(`  Hints.keywords: ${c.hints.searchKeywords.join(", ") || "—"}`);
    if (c.hints.potentialDCI) console.log(`  Hints.potentialDCI: ${c.hints.potentialDCI}`);
  }

  const succ = report.connectors.succeeded;
  if (succ.length === 0) {
    console.log(`  Conectores: ${report.connectors.attempted.join(" → ")}  →  nenhum devolveu dados`);
  } else {
    console.log(
      `  Conectores: ` +
      succ.map(s => `${s.source}(${s.tier},${pct(s.confidence)})`).join(" + ")
    );
  }

  const anyField = Object.entries(report.resolvedFields).filter(([, v]) => v !== null);
  if (anyField.length === 0) {
    console.log(`  Campos resolvidos: nenhum`);
  } else {
    console.log(`  Campos resolvidos:`);
    for (const [name, f] of anyField) {
      if (!f) continue;
      const agree = f.agreementCount > 1 ? ` ×${f.agreementCount}` : "";
      console.log(`    ${name.padEnd(18)} ${pct(f.confidence)}  [${f.tier}/${f.source}${agree}]  ${truncate(f.value, 50)}`);
    }
  }

  if (report.conflicts.length > 0) {
    console.log(`  ⚠ Conflitos:`);
    for (const conflict of report.conflicts) {
      console.log(`    ${conflict.field}:`);
      for (const v of conflict.values) {
        console.log(`      "${truncate(v.value, 40)}" ← ${v.source} (${v.tier}, ${pct(v.confidence)})`);
      }
    }
  }

  if (report.needsManualReview) {
    console.log(`  → Revisão manual: ${report.manualReviewReason}`);
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

// ─── Agregação ────────────────────────────────────────────────────────────────

type Aggregate = {
  total: number;
  byProductType: Record<string, number>;
  byVerificationStatus: Record<string, number>;
  fieldCoverage: Record<string, number>;
  avgFieldConfidence: Record<string, number>;
  totalConflicts: number;
  needsReview: number;
  externallyVerified: number;
  manuallyProtected: number;
};

function aggregate(reports: ProductReport[]): Aggregate {
  const agg: Aggregate = {
    total: reports.length,
    byProductType: {},
    byVerificationStatus: {},
    fieldCoverage: {},
    avgFieldConfidence: {},
    totalConflicts: 0,
    needsReview: 0,
    externallyVerified: 0,
    manuallyProtected: 0,
  };

  const fieldConfSums: Record<string, number> = {};
  const fieldCounts: Record<string, number> = {};

  for (const r of reports) {
    agg.byProductType[r.classification.productType] =
      (agg.byProductType[r.classification.productType] ?? 0) + 1;
    agg.byVerificationStatus[r.verificationStatus] =
      (agg.byVerificationStatus[r.verificationStatus] ?? 0) + 1;

    if (r.conflicts.length > 0) agg.totalConflicts += r.conflicts.length;
    if (r.needsManualReview) agg.needsReview++;
    if (r.externallyVerified) agg.externallyVerified++;
    if (r.validadoManualmente) agg.manuallyProtected++;

    for (const [name, f] of Object.entries(r.resolvedFields)) {
      if (f) {
        agg.fieldCoverage[name] = (agg.fieldCoverage[name] ?? 0) + 1;
        fieldConfSums[name] = (fieldConfSums[name] ?? 0) + f.confidence;
        fieldCounts[name] = (fieldCounts[name] ?? 0) + 1;
      }
    }
  }

  for (const name of Object.keys(fieldConfSums)) {
    agg.avgFieldConfidence[name] = fieldConfSums[name] / fieldCounts[name];
  }

  return agg;
}

function printAggregate(agg: Aggregate): void {
  const sep = "═".repeat(72);
  console.log(`\n${sep}`);
  console.log(`Relatório agregado  —  ${agg.total} produto(s)`);
  console.log(sep);

  console.log(`\nPor tipo de produto:`);
  for (const [type, count] of Object.entries(agg.byProductType).sort((a, b) => b[1] - a[1])) {
    const pct = ((count / agg.total) * 100).toFixed(0);
    console.log(`  ${type.padEnd(20)} ${String(count).padStart(4)}  (${pct}%)`);
  }

  console.log(`\nPor estado de verificação:`);
  for (const [status, count] of Object.entries(agg.byVerificationStatus).sort((a, b) => b[1] - a[1])) {
    const pct = ((count / agg.total) * 100).toFixed(0);
    console.log(`  ${status.padEnd(20)} ${String(count).padStart(4)}  (${pct}%)`);
  }

  console.log(`\nCobertura por campo (fracção resolvida):`);
  const fieldOrder = ["fabricante", "dci", "codigoATC", "formaFarmaceutica", "dosagem", "embalagem", "imagemUrl", "categoria", "subcategoria"];
  for (const name of fieldOrder) {
    const count = agg.fieldCoverage[name] ?? 0;
    const avg = agg.avgFieldConfidence[name] ?? 0;
    const pct = ((count / agg.total) * 100).toFixed(0);
    const avgPct = (avg * 100).toFixed(0);
    const bar = "█".repeat(Math.round((count / agg.total) * 20));
    console.log(`  ${name.padEnd(20)} ${String(count).padStart(4)}  (${pct.padStart(3)}%)  conf ~${avgPct}%  ${bar}`);
  }

  console.log(`\nIndicadores globais:`);
  console.log(`  Conflitos detectados       : ${agg.totalConflicts}`);
  console.log(`  Precisam revisão manual    : ${agg.needsReview}`);
  console.log(`  Verificados externamente   : ${agg.externallyVerified}`);
  console.log(`  Protegidos (validadoManual): ${agg.manuallyProtected}`);
  console.log(sep);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();

  if (!args.json) {
    console.log("─".repeat(72));
    console.log("SPharm.MT — Validação do pipeline (dry-run absoluto)");
    console.log("─".repeat(72));
    console.log(`Amostra: ${args.cnp ? `CNP ${args.cnp}` : `${args.sample} ${args.limit}`}${args.type ? ` | tipo=${args.type}` : ""}`);
    console.log();
  }

  const sample = await loadSample(args);
  if (sample.length === 0) {
    console.error("Nenhum produto corresponde aos critérios.");
    await prisma.$disconnect();
    process.exit(1);
  }

  const reports: ProductReport[] = [];
  for (const product of sample) {
    try {
      const report = await runPipeline(product);
      reports.push(report);
      if (!args.json) printHumanReport(report, args.verbose);
    } catch (err) {
      console.error(`[erro] CNP:${product.cnp}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (args.json) {
    process.stdout.write(JSON.stringify({
      generatedAt: new Date().toISOString(),
      args,
      aggregate: aggregate(reports),
      reports,
    }, null, 2) + "\n");
  } else {
    printAggregate(aggregate(reports));
  }

  await prisma.$disconnect();
}

main().catch(err => {
  console.error("\n[erro fatal]", err);
  prisma.$disconnect().finally(() => process.exit(1));
});
