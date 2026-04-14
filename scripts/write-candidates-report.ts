/**
 * scripts/write-candidates-report.ts
 *
 * Relatório de candidatos a escrita + execução controlada de persistência real.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PROPÓSITO
 *
 *  1. DRY-RUN (default) — roda o pipeline completo (classify → connectors →
 *     resolve) e, para cada produto, mostra os campos que SERIAM escritos
 *     pela persistência real, com valor actual vs. valor proposto, confiança,
 *     fonte e tier. Nada é gravado.
 *
 *  2. APPLY (--apply) — chama persistResolvedProduct() nos produtos que têm
 *     pelo menos um campo candidato a escrita. Produtos sem candidatos
 *     não são sequer tocados (metadados inclusive).
 *
 *  3. POST-WRITE (com --apply) — imprime fieldsUpdated reais, lê o histórico
 *     de verificação criado (ProdutoVerificacaoHistorico) e compara com a
 *     previsão.
 *
 * SEGURANÇA
 *   - Limiares `THRESHOLD_PARTIAL=0.75` e `THRESHOLD_AUTO=0.90` NÃO são
 *     tocados (replicados localmente apenas para previsão; a escrita real
 *     usa persistResolvedProduct que aplica as regras oficiais).
 *   - Regra `validadoManualmente` inviolável — replicada na previsão e
 *     preservada pela persistência real.
 *   - Nunca sobrescreve campos não-null.
 *   - `--apply` é opt-in explícito; default é dry-run.
 *
 * Uso:
 *   npx tsx scripts/write-candidates-report.ts
 *   npx tsx scripts/write-candidates-report.ts --limit=50 --type=MEDICAMENTO
 *   npx tsx scripts/write-candidates-report.ts --cnp=6304774
 *   npx tsx scripts/write-candidates-report.ts --limit=20 --apply
 *   npx tsx scripts/write-candidates-report.ts --sample=random --limit=30
 *
 * Opções:
 *   --limit=N          Máximo de produtos a inspeccionar (default: 20)
 *   --sample=MODE      "first" (default) | "random"
 *   --cnp=N            Inspeccionar apenas o CNP
 *   --type=TYPE        Filtrar por productType já classificado (coluna Produto.productType)
 *   --apply            Executar escrita real em produtos com candidatos
 *   --verbose          Mostrar detalhes por produto mesmo quando não há candidatos
 */

import "dotenv/config";
import { legacyPrisma as prisma } from "../lib/prisma";
import type { Prisma } from "../generated/prisma/client";
import { classifyProductType, getFieldRelevance } from "../lib/catalog-classifier";
import { runConnectors } from "../lib/catalog-connectors";
import { resolveProduct } from "../lib/catalog-resolution-engine";
import { fetchOrigemSignals } from "../lib/catalog-enrichment";
import { persistResolvedProduct } from "../lib/catalog-persistence";
import type {
  ExternalLookupRequest,
  ProductType,
  ResolvedField,
  ResolvedProduct,
  SourceTier,
} from "../lib/catalog-types";

// ─── Limiares replicados para previsão (não altera persistência real) ────────

const THRESHOLD_PARTIAL = 0.75;
const THRESHOLD_AUTO    = 0.90;
const AUTHORITATIVE_TIERS: SourceTier[] = ["REGULATORY", "MANUFACTURER"];
const AUTHORITATIVE_FIELD_NAMES = new Set(["fabricanteId", "dci", "codigoATC"]);

// ─── Args ─────────────────────────────────────────────────────────────────────

type Args = {
  limit: number;
  sample: "first" | "random";
  cnp: number | null;
  type: ProductType | null;
  apply: boolean;
  verbose: boolean;
};

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const out: Args = {
    limit: 20,
    sample: "first",
    cnp: null,
    type: null,
    apply: false,
    verbose: false,
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
    } else if (arg === "--apply") {
      out.apply = true;
    } else if (arg === "--verbose") {
      out.verbose = true;
    } else {
      console.warn(`[aviso] Argumento desconhecido: ${arg}`);
    }
  }

  return out;
}

// ─── Amostra ──────────────────────────────────────────────────────────────────

const PRODUCT_SELECT = {
  id: true,
  cnp: true,
  designacao: true,
  tipoArtigo: true,
  flagMSRM: true,
  flagMNSRM: true,
  codigoATC: true,
  validadoManualmente: true,
  fabricanteId: true,
  dci: true,
  imagemUrl: true,
  formaFarmaceutica: true,
  dosagem: true,
  embalagem: true,
  classificacaoNivel1Id: true,
  classificacaoNivel2Id: true,
  productType: true,
  verificationStatus: true,
} as const;

type ProductRow = Prisma.ProdutoGetPayload<{ select: typeof PRODUCT_SELECT }>;

async function loadSample(args: Args): Promise<ProductRow[]> {
  if (args.cnp !== null) {
    const p = await prisma.produto.findUnique({
      where: { cnp: args.cnp },
      select: PRODUCT_SELECT,
    });
    return p ? [p] : [];
  }

  const where: Prisma.ProdutoWhereInput = { estado: { not: "INATIVO" } };
  if (args.type) where.productType = args.type;

  if (args.sample === "random") {
    const pool = await prisma.produto.findMany({
      where,
      select: PRODUCT_SELECT,
      take: args.limit * 10,
    });
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, args.limit);
  }

  return prisma.produto.findMany({
    where,
    select: PRODUCT_SELECT,
    take: args.limit,
    orderBy: { dataCriacao: "asc" },
  });
}

// ─── Previsão de escrita (replicando canUpdate de catalog-persistence.ts) ────

type WriteCandidate = {
  field: string;
  currentValue: string | null;
  proposedValue: string;
  confidence: number;
  source: string;
  tier: string;
  reason: "would_write" | "below_threshold" | "already_filled" | "irrelevant" | "protected" | "imagem_needs_auto" | "tier_blocked";
};

function predictWrites(product: ProductRow, resolved: ResolvedProduct): WriteCandidate[] {
  const relevance = getFieldRelevance(resolved.productType);
  const out: WriteCandidate[] = [];

  const evaluate = (
    name: string,
    current: string | null,
    resolvedField: ResolvedField<string> | null,
    isRelevant: boolean,
    extraCheck?: (field: ResolvedField<string>) => "imagem_needs_auto" | null,
  ) => {
    if (!resolvedField) return;
    const candidate: WriteCandidate = {
      field: name,
      currentValue: current,
      proposedValue: resolvedField.value,
      confidence: resolvedField.confidence,
      source: resolvedField.source,
      tier: resolvedField.tier,
      reason: "would_write",
    };

    if (product.validadoManualmente) candidate.reason = "protected";
    else if (current !== null && current !== undefined) candidate.reason = "already_filled";
    else if (!isRelevant) candidate.reason = "irrelevant";
    else if (resolvedField.confidence < THRESHOLD_PARTIAL) candidate.reason = "below_threshold";
    else if (
      AUTHORITATIVE_FIELD_NAMES.has(name) &&
      !AUTHORITATIVE_TIERS.includes(resolvedField.tier)
    ) {
      candidate.reason = "tier_blocked";
    }
    else if (extraCheck) {
      const extra = extraCheck(resolvedField);
      if (extra) candidate.reason = extra;
    }

    out.push(candidate);
  };

  evaluate("fabricanteId",   product.fabricanteId ? "[fabId]" : null, resolved.fabricante,        relevance.fabricante);
  evaluate("dci",            product.dci,                             resolved.dci,               relevance.dci);
  evaluate("codigoATC",      product.codigoATC,                       resolved.codigoATC,         relevance.atc);
  evaluate("formaFarmaceutica", product.formaFarmaceutica,            resolved.formaFarmaceutica, relevance.formaFarmaceutica);
  evaluate("dosagem",        product.dosagem,                         resolved.dosagem,           relevance.dosagem);
  evaluate("embalagem",      product.embalagem,                       resolved.embalagem,         relevance.embalagem);
  evaluate(
    "imagemUrl",
    product.imagemUrl,
    resolved.imagemUrl,
    relevance.imagemUrl,
    (f) => (f.confidence < THRESHOLD_AUTO ? "imagem_needs_auto" : null),
  );
  evaluate("classificacaoNivel1Id", product.classificacaoNivel1Id ? "[classNivel1]" : null, resolved.categoria, relevance.categoria);

  return out;
}

// ─── Pipeline + previsão ──────────────────────────────────────────────────────

type ProductAudit = {
  cnp: number;
  designacao: string;
  validadoManualmente: boolean;
  productType: ProductType;
  classificationConfidence: number;
  verificationStatus: ResolvedProduct["verificationStatus"];
  conflicts: number;
  candidates: WriteCandidate[];
  wouldWrite: string[];
  applied: string[] | null; // null = não aplicado; [] = chamado mas sem writes
};

async function inspectProduct(product: ProductRow, apply: boolean): Promise<ProductAudit> {
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
  const sources = await runConnectors(lookupReq);
  const resolved = resolveProduct(classification, sources);

  const candidates = predictWrites(product, resolved);
  const wouldWrite = candidates.filter(c => c.reason === "would_write").map(c => c.field);

  let applied: string[] | null = null;
  if (apply && wouldWrite.length > 0) {
    const res = await persistResolvedProduct({ productId: product.id, resolved, dryRun: false });
    applied = res.fieldsUpdated;
  }

  return {
    cnp: product.cnp,
    designacao: product.designacao,
    validadoManualmente: product.validadoManualmente,
    productType: classification.productType,
    classificationConfidence: classification.confidence,
    verificationStatus: resolved.verificationStatus,
    conflicts: resolved.conflicts.length,
    candidates,
    wouldWrite,
    applied,
  };
}

// ─── Impressão ────────────────────────────────────────────────────────────────

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

function truncate(s: string | null, max: number): string {
  if (!s) return "(null)";
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function printProduct(a: ProductAudit, verbose: boolean): void {
  const isInteresting = a.wouldWrite.length > 0 || a.conflicts > 0 || a.validadoManualmente;
  if (!verbose && !isInteresting) return;

  const protectedFlag = a.validadoManualmente ? " [PROTEGIDO]" : "";
  const header = `[${a.productType} ${pct(a.classificationConfidence)}] CNP:${a.cnp}${protectedFlag} — ${a.verificationStatus}`;

  console.log("─".repeat(78));
  console.log(header);
  console.log(`  "${truncate(a.designacao, 72)}"`);

  if (a.candidates.length === 0) {
    console.log(`  (sem campos resolvidos relevantes)`);
    return;
  }

  console.log(`  Campos:`);
  for (const c of a.candidates) {
    const tag =
      c.reason === "would_write"       ? "✓ escreve    "
      : c.reason === "already_filled"  ? "· existente  "
      : c.reason === "below_threshold" ? "· conf baixa "
      : c.reason === "protected"       ? "✗ protegido  "
      : c.reason === "irrelevant"      ? "· irrelevante"
      : c.reason === "imagem_needs_auto" ? "· img<0.90  "
      : c.reason === "tier_blocked"    ? "✗ tier inferior"
      : "?";
    const cur = truncate(c.currentValue, 22).padEnd(22);
    const prop = truncate(c.proposedValue, 28).padEnd(28);
    console.log(
      `    ${tag}  ${c.field.padEnd(20)} ${cur} → ${prop}  ${pct(c.confidence)}  [${c.tier}]`
    );
  }

  if (a.wouldWrite.length > 0) {
    console.log(`  → DRY-RUN escreveria: ${a.wouldWrite.join(", ")}`);
  }
  if (a.applied !== null) {
    console.log(`  → APPLY gravou    : ${a.applied.length > 0 ? a.applied.join(", ") : "(nenhum)"}`);
  }
}

// ─── Agregação ────────────────────────────────────────────────────────────────

type Totals = {
  inspected: number;
  withWriteCandidates: number;
  productsProtected: number;
  productsWithConflicts: number;
  partialNoWrite: number;          // PARTIALLY_VERIFIED sem candidatos
  predictedWrites: number;         // nº total de campos que iam ser escritos
  appliedWrites: number;           // nº total de campos efectivamente escritos
  appliedProducts: number;         // nº de produtos afectados pela escrita real
  reasonBreakdown: Record<WriteCandidate["reason"], number>;
};

function emptyTotals(): Totals {
  return {
    inspected: 0,
    withWriteCandidates: 0,
    productsProtected: 0,
    productsWithConflicts: 0,
    partialNoWrite: 0,
    predictedWrites: 0,
    appliedWrites: 0,
    appliedProducts: 0,
    reasonBreakdown: {
      would_write: 0,
      below_threshold: 0,
      already_filled: 0,
      irrelevant: 0,
      protected: 0,
      imagem_needs_auto: 0,
      tier_blocked: 0,
    },
  };
}

function accumulate(totals: Totals, a: ProductAudit): void {
  totals.inspected++;
  if (a.wouldWrite.length > 0) totals.withWriteCandidates++;
  if (a.validadoManualmente) totals.productsProtected++;
  if (a.conflicts > 0) totals.productsWithConflicts++;
  if (a.verificationStatus === "PARTIALLY_VERIFIED" && a.wouldWrite.length === 0) totals.partialNoWrite++;
  totals.predictedWrites += a.wouldWrite.length;
  if (a.applied !== null) {
    totals.appliedWrites += a.applied.length;
    if (a.applied.length > 0) totals.appliedProducts++;
  }
  for (const c of a.candidates) totals.reasonBreakdown[c.reason]++;
}

function printTotals(t: Totals, args: Args): void {
  const sep = "═".repeat(78);
  console.log(`\n${sep}`);
  console.log(`Resumo — ${args.apply ? "APPLY" : "DRY-RUN"}`);
  console.log(sep);
  console.log(`  Produtos inspeccionados    : ${t.inspected}`);
  console.log(`  Com candidatos a escrita   : ${t.withWriteCandidates}`);
  console.log(`  Protegidos (manual)        : ${t.productsProtected}`);
  console.log(`  Com conflitos entre fontes : ${t.productsWithConflicts}`);
  console.log(`  PARTIALLY_VERIFIED s/ write: ${t.partialNoWrite}`);
  console.log();
  console.log(`  Previsão de escritas       : ${t.predictedWrites} campo(s)`);
  if (args.apply) {
    console.log(`  Escritas efectivas         : ${t.appliedWrites} campo(s) em ${t.appliedProducts} produto(s)`);
  }
  console.log();
  console.log(`  Decisão por campo:`);
  console.log(`    ✓ would_write       : ${t.reasonBreakdown.would_write}`);
  console.log(`    · below_threshold   : ${t.reasonBreakdown.below_threshold}`);
  console.log(`    · already_filled    : ${t.reasonBreakdown.already_filled}`);
  console.log(`    · irrelevant        : ${t.reasonBreakdown.irrelevant}`);
  console.log(`    ✗ protected         : ${t.reasonBreakdown.protected}`);
  console.log(`    ✗ tier_blocked      : ${t.reasonBreakdown.tier_blocked}`);
  console.log(`    · imagem_needs_auto : ${t.reasonBreakdown.imagem_needs_auto}`);
  console.log(sep);
}

// ─── Relatório de histórico pós-escrita ──────────────────────────────────────

async function printHistorySince(runStart: Date, writtenProductIds: string[]): Promise<void> {
  if (writtenProductIds.length === 0) return;

  const rows = await prisma.produtoVerificacaoHistorico.findMany({
    where: {
      produtoId: { in: writtenProductIds },
      verificadoEm: { gte: runStart },
    },
    include: {
      produto: { select: { cnp: true, designacao: true } },
    },
    orderBy: { verificadoEm: "asc" },
  });

  const sep = "═".repeat(78);
  console.log(`\n${sep}`);
  console.log(`Histórico de verificação criado nesta execução (${rows.length} linha(s))`);
  console.log(sep);

  for (const r of rows) {
    const fields = Array.isArray(r.fieldsUpdated) ? r.fieldsUpdated : [];
    console.log(
      `  ${r.verificadoEm.toISOString()}  CNP:${r.produto.cnp}  ${r.verificationStatus}  ` +
      `[${r.productType}] → ${fields.length > 0 ? fields.join(", ") : "(metadados apenas)"}`
    );
  }
  console.log(sep);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();
  const runStart = new Date();

  console.log("─".repeat(78));
  console.log(`SPharm.MT — Write Candidates Report  ${args.apply ? "[APPLY]" : "[DRY-RUN]"}`);
  console.log("─".repeat(78));
  console.log(`Amostra: ${args.cnp ? `CNP ${args.cnp}` : `${args.sample} ${args.limit}`}${args.type ? ` | tipo=${args.type}` : ""}`);
  if (args.apply) {
    console.log(`AVISO: modo APPLY activo — persistResolvedProduct() será chamado em produtos com candidatos.`);
  }
  console.log();

  const sample = await loadSample(args);
  if (sample.length === 0) {
    console.error("Nenhum produto corresponde aos critérios.");
    await prisma.$disconnect();
    process.exit(1);
  }

  const totals = emptyTotals();
  const writtenProductIds: string[] = [];

  for (const product of sample) {
    try {
      const audit = await inspectProduct(product, args.apply);
      accumulate(totals, audit);
      printProduct(audit, args.verbose);
      if (audit.applied !== null && audit.applied.length > 0) {
        writtenProductIds.push(product.id);
      }
    } catch (err) {
      console.error(`[erro] CNP:${product.cnp}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  printTotals(totals, args);

  if (args.apply) {
    await printHistorySince(runStart, writtenProductIds);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("\n[erro fatal]", err);
  prisma.$disconnect().finally(() => process.exit(1));
});
