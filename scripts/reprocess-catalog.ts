/**
 * scripts/reprocess-catalog.ts
 *
 * Reprocessamento controlado do catálogo após alterações nas regras de
 * MEDICAMENTOS (ATC L2 prefix mapping, DCI keyword, image enrichment).
 *
 * Pipeline (por ordem de prioridade — passes separados, cada um em
 * batches sequenciais com paginação por cursor):
 *
 *   PASS 1 — MEDICAMENTO classificado em "Outros Medicamentos"
 *            · tenta reclassificar via mapToCanonical (com novo prefix
 *              ATC e DCI)
 *            · só substitui se o novo método NÃO for `others_fallback`
 *            · depois corre enrichProduct (preenche ATC/DCI/imagemUrl
 *              em falta sem mexer nos campos preenchidos)
 *
 *   PASS 2 — MEDICAMENTO com codigoATC, dci OU imagemUrl em falta
 *            (excluindo os já tratados em PASS 1)
 *            · enrichProduct preenche o que está null
 *
 *   PASS 3 — Resto dos produtos ATIVO com cnp > 2.000.000 (opcional,
 *            ligado com --include-non-medicamento)
 *
 * Regras de segurança (delegadas à camada de persistência existente —
 * não duplicadas aqui):
 *   · validadoManualmente=true       → pulado (persistence bloqueia)
 *   · campo já preenchido            → não sobrescrito (persistence)
 *   · imagemUrl exige conf ≥ 0.75    → garante zero imagens placeholder
 *   · campos autoritários (fab/DCI/ATC) só de tier REGULATORY/MANUFACTURER
 *
 * Adicionalmente, neste script:
 *   · A reclassificação directa de "Outros Medicamentos" só acontece se
 *     mapToCanonical devolve um método ≠ `others_fallback` E o produto
 *     não está marcado como validadoManualmente.
 *
 * Uso:
 *   # Dry-run do primeiro batch (preview, sem escrever)
 *   npx tsx scripts/reprocess-catalog.ts --first-batch-only --dry-run
 *
 *   # Primeiro batch live (após confirmação)
 *   npx tsx scripts/reprocess-catalog.ts --first-batch-only
 *
 *   # Corrida completa (PASS 1 + PASS 2)
 *   npx tsx scripts/reprocess-catalog.ts
 *
 *   # Incluir não-medicamentos
 *   npx tsx scripts/reprocess-catalog.ts --include-non-medicamento
 *
 *   # Resume após interrupção (cursor por id)
 *   npx tsx scripts/reprocess-catalog.ts --start-from=<productId>
 *
 *   # Limitar tamanho de batch (default 150)
 *   npx tsx scripts/reprocess-catalog.ts --batch-size=100
 *
 *   # Limite total de produtos a processar
 *   npx tsx scripts/reprocess-catalog.ts --limit=500
 */

import "dotenv/config";
import { legacyPrisma as prisma } from "../lib/prisma";
import { enrichProduct, isCataloguableCnp } from "../lib/catalog-enrichment";
import { mapToCanonical } from "../lib/catalog-taxonomy-map";
import { resolveClassificationIdsFromCategory } from "../lib/catalog-classification";
import { setSkipRetailConnector } from "../lib/catalog-connectors";
import { classifyProductType } from "../lib/catalog-classifier";
import type { ProductType } from "../lib/catalog-types";

// ─── CLI ──────────────────────────────────────────────────────────────────────

type Args = {
  dryRun: boolean;
  firstBatchOnly: boolean;
  batchSize: number;
  startFrom: string | null;
  limit: number | null;
  includeNonMedicamento: boolean;
  /**
   * Diagnóstico — desliga `retailPharmacyConnector` para isolar a qualidade
   * do mapping interno (INFARMED + classifier + canonical map) sem o custo
   * dos rate-limits HTTP. As imagens não serão preenchidas neste modo.
   */
  skipRetail: boolean;
  /**
   * Filtra cada PASS para incluir APENAS produtos que têm `codigoATC`
   * ou `dci` preenchidos. Usado para validar a qualidade do mapping
   * em produtos onde o mapper TEM sinal para trabalhar (vs. produtos
   * sem ATC/DCI onde o mapper não pode fazer nada por design).
   */
  onlyWithAtcOrDci: boolean;
};

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const out: Args = {
    dryRun: false,
    firstBatchOnly: false,
    batchSize: 150,
    startFrom: null,
    limit: null,
    includeNonMedicamento: false,
    skipRetail: false,
    onlyWithAtcOrDci: false,
  };
  for (const a of args) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--first-batch-only") out.firstBatchOnly = true;
    else if (a === "--include-non-medicamento") out.includeNonMedicamento = true;
    else if (a === "--skip-retail") out.skipRetail = true;
    else if (a === "--only-with-atc-or-dci") out.onlyWithAtcOrDci = true;
    else if (a.startsWith("--batch-size=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (!isNaN(n) && n > 0 && n <= 500) out.batchSize = n;
      else console.warn(`[aviso] batch-size fora do intervalo [1,500], a usar default 150`);
    } else if (a.startsWith("--start-from=")) {
      const v = a.split("=")[1];
      if (v) out.startFrom = v;
    } else if (a.startsWith("--limit=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (!isNaN(n) && n > 0) out.limit = n;
    } else {
      console.warn(`[aviso] argumento desconhecido: ${a}`);
    }
  }
  return out;
}

// ─── Tipos ────────────────────────────────────────────────────────────────────

type ProductSnapshot = {
  id: string;
  cnp: number;
  designacao: string;
  productType: string | null;
  validadoManualmente: boolean;
  codigoATC: string | null;
  dci: string | null;
  imagemUrl: string | null;
  fabricanteId: string | null;
  classificacaoNivel1Id: string | null;
  classificacaoNivel2Id: string | null;
  nivel1Nome: string | null;
  nivel2Nome: string | null;
  externalCategoria: string | null; // do snapshot mais recente, se houver
};

type ProductChanges = {
  reclassNivel2: {
    from: string | null;
    to: string | null;
    reason: string;
    /** Método do mapper que produziu a reclassificação — usado em métricas. */
    method: string;
  } | null;
  atcAdded: string | null;
  dciAdded: string | null;
  imageBefore: string | null;
  imageAfter: string | null;
  imageAdded: boolean;
  /** Razão emitida pela camada de persistência para o campo imagemUrl. */
  imageDecision: { status: string; reason: string; source?: string | null } | null;
  /** Razão (mapper.reason) quando reclassificação aplicada/proposta. */
  mapperReason: string | null;
  /**
   * Opinião do classifier rodado SÓ com texto (sem flagMSRM/flagMNSRM/
   * codigoATC/tipoArtigo) — diagnóstico para detectar produtos cujo
   * `productType=MEDICAMENTO` actual é provavelmente errado a montante
   * (ex.: A-Derma, Solgar, Bioderma classificados como medicamento por
   * sinal fraco e nunca corrigidos).
   */
  textOnlyOpinion: { type: ProductType; confidence: number } | null;
  /**
   * Categoria de análise pós-processamento. Atribuída em `categorize`
   * depois do `processOne` retornar — usada para agregar resultados em
   * dry-run.
   */
  category: AnalysisCategory | null;
  fieldsUpdated: string[];
  outcome: "updated" | "unchanged" | "failed";
  error?: string;
};

/**
 * Agrupamentos de análise (Step 3 do user spec). Cada produto cai numa
 * categoria primária — ordem de avaliação importa: bugs/erros vencem
 * sempre, depois imagem, depois reclassificação, depois fallback.
 */
type AnalysisCategory =
  | "improved"                 // 1. Correctly improved (nivel2 trocado para algo específico)
  | "outros_no_signal"         // 2. Still Outros — sem ATC nem DCI nem keyword
  | "outros_missing_rule"      // 3. Still Outros — ATC/DCI presente mas sem regra (gap no mapper)
  | "image_safe"               // 4. Image found and safe (escrita ou seria escrita em dry-run)
  | "image_skipped"            // 5. Image skipped (com razão)
  | "suspicious"               // 6. Suspeito / precisa revisão manual
  | "productType_suspect"      // 7. productType=MEDICAMENTO mas sinais de texto sugerem outro tipo
  | "no_change_already_ok";    // produto já estava em estado correcto — não cabe nas 6 mas é informativo

type BatchSummary = {
  batchNumber: number;
  processed: number;
  updated: number;
  unchanged: number;
  failed: number;
  classificationImprovements: number;
  atcFilled: number;
  dciFilled: number;
  imagesAdded: number;
  outrosMedicamentosRemaining: number;
  // ── Métricas de presença de sinal e método de reclassificação ───────
  hasAtc: number;             // produtos com codigoATC ≠ null
  hasDci: number;             // produtos com dci ≠ null
  hasAtcOrDci: number;        // pelo menos um dos dois preenchido
  hasNeitherAtcNorDci: number;// nenhum dos dois preenchido
  reclassByAtcPrefix: number; // método usado: "atc_prefix"
  reclassByAtcLetter: number; // método usado: "atc"
  reclassByDci: number;       // método usado: "dci"
  reclassByKeyword: number;   // método usado: "keyword"
  reclassByOther: number;     // outro método (external_category_hint, …)
  outrosWithSignalNotReclass: number; // tinham ATC/DCI mas continuam Outros
};

type RunTotals = {
  processed: number;
  updated: number;
  unchanged: number;
  failed: number;
  classificationImprovements: number;
  atcFilled: number;
  dciFilled: number;
  imagesAdded: number;
  outrosMedicamentosBefore: number;
  outrosMedicamentosRemaining: number;
  categoryCounts: Record<AnalysisCategory, number>;
  // Mesmas métricas que BatchSummary, agregadas no run inteiro
  hasAtc: number;
  hasDci: number;
  hasAtcOrDci: number;
  hasNeitherAtcNorDci: number;
  reclassByAtcPrefix: number;
  reclassByAtcLetter: number;
  reclassByDci: number;
  reclassByKeyword: number;
  reclassByOther: number;
  outrosWithSignalNotReclass: number;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function loadSnapshot(productId: string): Promise<ProductSnapshot | null> {
  const p = await prisma.produto.findUnique({
    where: { id: productId },
    select: {
      id: true,
      cnp: true,
      designacao: true,
      productType: true,
      validadoManualmente: true,
      codigoATC: true,
      dci: true,
      imagemUrl: true,
      fabricanteId: true,
      classificacaoNivel1Id: true,
      classificacaoNivel2Id: true,
      classificacaoNivel1: { select: { nome: true } },
      classificacaoNivel2: { select: { nome: true } },
    },
  });
  if (!p) return null;
  return {
    id: p.id,
    cnp: p.cnp,
    designacao: p.designacao,
    productType: p.productType,
    validadoManualmente: p.validadoManualmente,
    codigoATC: p.codigoATC,
    dci: p.dci,
    imagemUrl: p.imagemUrl,
    fabricanteId: p.fabricanteId,
    classificacaoNivel1Id: p.classificacaoNivel1Id,
    classificacaoNivel2Id: p.classificacaoNivel2Id,
    nivel1Nome: p.classificacaoNivel1?.nome ?? null,
    nivel2Nome: p.classificacaoNivel2?.nome ?? null,
    externalCategoria: null,
  };
}

/**
 * Tenta reclassificar um MEDICAMENTO actualmente em "Outros Medicamentos"
 * usando os sinais actuais do produto (ATC, DCI, designação) através do
 * mapper canónico. Só aplica a alteração se mapToCanonical devolver um
 * método mais específico que `others_fallback`. Em dryRun não escreve.
 *
 * Devolve `{ from, to, reason }` se a reclassificação foi (ou seria)
 * aplicada; `null` caso contrário.
 */
async function maybeReclassifyOutrosMedicamentos(
  s: ProductSnapshot,
  dryRun: boolean,
): Promise<{ from: string; to: string; reason: string; method: string } | null> {
  if (s.validadoManualmente) return null;
  if (s.nivel2Nome !== "Outros Medicamentos") return null;
  if (s.productType !== "MEDICAMENTO") return null;

  const canonical = mapToCanonical({
    productType: "MEDICAMENTO",
    productTypeConfidence: 0.99, // produto já é MEDICAMENTO; tipo é estável
    externalCategory: s.externalCategoria,
    externalSubcategory: null,
    designacao: s.designacao,
    atc: s.codigoATC,
    dci: s.dci,
  });

  if (!canonical) return null;
  if (canonical.method === "others_fallback") return null;
  if (canonical.nivel2 === "Outros Medicamentos") return null;
  if (canonical.nivel1 !== "MEDICAMENTOS") return null;

  if (dryRun) {
    return {
      from: "Outros Medicamentos",
      to: canonical.nivel2,
      reason: `(dry-run) ${canonical.method}: ${canonical.reason}`,
      method: canonical.method,
    };
  }

  const ids = await resolveClassificationIdsFromCategory(canonical.nivel1, canonical.nivel2);
  if (!ids.nivel2Id) {
    console.warn(
      `[reclass] nivel2 "${canonical.nivel2}" não encontrado em Classificacao para cnp=${s.cnp}`,
    );
    return null;
  }

  await prisma.produto.update({
    where: { id: s.id },
    data: {
      classificacaoNivel2Id: ids.nivel2Id,
    },
  });

  return {
    from: "Outros Medicamentos",
    to: canonical.nivel2,
    reason: `${canonical.method}: ${canonical.reason}`,
    method: canonical.method,
  };
}

/**
 * Processa um único produto: aplica reclassificação direccionada (se for o
 * caso) e depois corre o pipeline de enriquecimento padrão para preencher
 * campos em falta. Captura before/after para reportar mudanças.
 *
 * Erros num produto não interrompem o batch — ficam capturados em `error`.
 */
async function processOne(
  productId: string,
  dryRun: boolean,
): Promise<{ before: ProductSnapshot | null; changes: ProductChanges }> {
  let before: ProductSnapshot | null = null;
  const changes: ProductChanges = {
    reclassNivel2: null,
    atcAdded: null,
    dciAdded: null,
    imageBefore: null,
    imageAfter: null,
    imageAdded: false,
    imageDecision: null,
    mapperReason: null,
    textOnlyOpinion: null,
    category: null,
    fieldsUpdated: [],
    outcome: "unchanged",
  };
  try {
    before = await loadSnapshot(productId);
    if (!before) {
      changes.outcome = "failed";
      changes.error = "produto não encontrado";
      return { before, changes };
    }
    changes.imageBefore = before.imagemUrl;
    if (!isCataloguableCnp(before.cnp)) {
      changes.outcome = "unchanged";
      return { before, changes };
    }

    // 0. Opinião text-only do classifier — corre `classifyProductType`
    //    com flags/ATC/tipoArtigo zerados para ver o que a designação
    //    sugere SOZINHA. Se a opinião text-only diferir do productType
    //    armazenado (especialmente DERMOCOSMETICA/SUPLEMENTO em produtos
    //    "MEDICAMENTO + Outros Medicamentos"), é sinal forte de mis-
    //    classificação a montante. Diagnóstico apenas — não muda o
    //    productType aqui, só sinaliza para revisão.
    const textOnly = classifyProductType({
      designacao: before.designacao,
      tipoArtigo: null,
      flagMSRM: false,
      flagMNSRM: false,
      codigoATC: null,
    });
    changes.textOnlyOpinion = {
      type: textOnly.productType,
      confidence: textOnly.confidence,
    };

    // 1. Reclassificação direccionada de "Outros Medicamentos"
    const reclass = await maybeReclassifyOutrosMedicamentos(before, dryRun);
    if (reclass) {
      changes.reclassNivel2 = reclass;
      changes.mapperReason = reclass.reason;
    }

    // 2. Enriquecimento padrão (preenche ATC/DCI/imagemUrl em falta)
    const result = await enrichProduct(productId, { dryRun });
    changes.fieldsUpdated = result.fieldsUpdated;

    // Captura a decisão da camada de persistência para imagemUrl —
    // permite reportar exactamente porque a imagem foi (ou não foi)
    // escrita: confiança baixa, fonte X, URL inválida, etc.
    const imgDecision = result.fieldDecisions?.find((d) => d.field === "imagemUrl");
    if (imgDecision) {
      changes.imageDecision = {
        status: imgDecision.status,
        reason: imgDecision.reason,
        source: imgDecision.source ?? null,
      };
    }

    // 3. Snapshot pós para detectar deltas
    const after = dryRun ? null : await loadSnapshot(productId);
    if (after) {
      changes.imageAfter = after.imagemUrl;
      if (!before.codigoATC && after.codigoATC) changes.atcAdded = after.codigoATC;
      if (!before.dci && after.dci) changes.dciAdded = after.dci;
      if (!before.imagemUrl && after.imagemUrl) changes.imageAdded = true;
    } else if (dryRun) {
      // Em dry-run não temos after; usamos result.fieldsUpdated para
      // sinalizar o que o enrich teria gravado, e fieldDecisions para
      // saber a URL proposta para a imagem.
      if (!before.codigoATC && result.fieldsUpdated.includes("codigoATC")) {
        changes.atcAdded = "(would-fill)";
      }
      if (!before.dci && result.fieldsUpdated.includes("dci")) {
        changes.dciAdded = "(would-fill)";
      }
      if (!before.imagemUrl && result.fieldsUpdated.includes("imagemUrl")) {
        changes.imageAdded = true;
        const imgDec = result.fieldDecisions?.find(
          (d) => d.field === "imagemUrl" && d.status === "updated",
        );
        changes.imageAfter = imgDec?.newValue ?? "(would-fill)";
      }
    }

    const anyChange =
      !!changes.reclassNivel2 ||
      !!changes.atcAdded ||
      !!changes.dciAdded ||
      changes.imageAdded ||
      result.fieldsUpdated.length > 0;
    changes.outcome = anyChange ? "updated" : "unchanged";
    return { before, changes };
  } catch (err) {
    changes.outcome = "failed";
    changes.error = err instanceof Error ? err.message : String(err);
    return { before, changes };
  }
}

/**
 * Atribui uma categoria de análise ao produto, baseada no estado before
 * e nas mudanças propostas/aplicadas. Ordem de avaliação: erros primeiro,
 * depois imagem, depois reclassificação, depois "ainda em outros".
 */
function categorize(before: ProductSnapshot, c: ProductChanges): AnalysisCategory {
  if (c.outcome === "failed") return "suspicious";

  const wasOutros = before.nivel2Nome === "Outros Medicamentos";

  // 0. productType_suspect — productType actual é MEDICAMENTO mas a
  //    classificação text-only do classifier discorda com confiança
  //    suficiente para tomar a sério. Não bloqueia outras categorias
  //    (improved/outros_*); ganha precedência porque o reviewer precisa
  //    de saber que estes produtos podem não ser medicamentos sequer
  //    — corrigir productType é trabalho a montante, não deste script.
  //
  //    Critérios:
  //      · stored productType = MEDICAMENTO
  //      · text-only opinion ≠ MEDICAMENTO
  //      · text-only opinion ∈ {DERMOCOSMETICA, SUPLEMENTO,
  //        HIGIENE_CUIDADO, PUERICULTURA, ORTOPEDIA, DISPOSITIVO_MEDICO,
  //        VETERINARIA} (não OUTRO — OUTRO não é informativo)
  //      · text-only confidence ≥ 0.65 (acima do limiar para a opinião
  //        ser tomada a sério; abaixo de 0.50 nem grava persistência)
  if (
    before.productType === "MEDICAMENTO" &&
    c.textOnlyOpinion &&
    c.textOnlyOpinion.type !== "MEDICAMENTO" &&
    c.textOnlyOpinion.type !== "OUTRO" &&
    c.textOnlyOpinion.confidence >= 0.65
  ) {
    return "productType_suspect";
  }

  // 1. Reclassificação aplicada/proposta com sucesso
  if (c.reclassNivel2 && c.reclassNivel2.to !== "Outros Medicamentos") {
    return "improved";
  }

  // 2/3. Continua em "Outros Medicamentos" — diferenciar por causa
  if (wasOutros) {
    if (!before.codigoATC && !before.dci) {
      return "outros_no_signal";
    }
    // Tem ATC ou DCI mas o mapper não tem regra que melhore — é um gap
    // de regras que pode ser fechado por uma futura entrada em
    // ATC_PREFIX_TO_NIVEL2 ou KEYWORD_RULES.MEDICAMENTOS.
    return "outros_missing_rule";
  }

  // 4/5. Imagem
  if (c.imageAdded) return "image_safe";
  if (c.imageDecision && c.imageDecision.status === "skipped") {
    return "image_skipped";
  }

  return "no_change_already_ok";
}

function shortenUrl(u: string | null): string {
  if (!u) return "—";
  // Mostra esquema/host + último segmento do path para diagnóstico rápido,
  // sem encher a linha com tracking params.
  try {
    const url = new URL(u);
    const tail = url.pathname.split("/").filter(Boolean).pop() ?? "";
    const tailShort = tail.length > 40 ? `${tail.slice(0, 37)}...` : tail;
    return `${url.host}/…/${tailShort}`;
  } catch {
    return u.length > 60 ? `${u.slice(0, 57)}...` : u;
  }
}

function fmtSampleBlock(
  i: number,
  before: ProductSnapshot | null,
  changes: ProductChanges,
): string {
  if (!before) {
    return (
      `  ${String(i + 1).padStart(3, " ")}. (snapshot null) outcome=${changes.outcome}` +
      (changes.error ? `\n        err=${changes.error}` : "")
    );
  }

  const proposedNivel2 =
    changes.reclassNivel2?.to ?? before.nivel2Nome ?? "—";
  const reclassMark = changes.reclassNivel2 ? "→" : "==";

  const designacaoShort =
    before.designacao.length > 60
      ? `${before.designacao.slice(0, 57)}...`
      : before.designacao;

  const lines: string[] = [];
  lines.push(
    `  ${String(i + 1).padStart(3, " ")}. CNP=${before.cnp} | ${designacaoShort}`,
  );
  lines.push(
    `        nivel2: "${before.nivel2Nome ?? "(none)"}" ${reclassMark} "${proposedNivel2}"`,
  );
  lines.push(
    `        ATC=${before.codigoATC ?? "—"}${changes.atcAdded ? ` (+filling: ${changes.atcAdded})` : ""}` +
      ` | DCI=${before.dci ?? "—"}${changes.dciAdded ? ` (+filling: ${changes.dciAdded})` : ""}`,
  );
  lines.push(
    `        image: ${shortenUrl(changes.imageBefore)} → ${shortenUrl(changes.imageAfter)}` +
      `${changes.imageAdded ? " (+ADDED)" : ""}`,
  );

  // Razão do mapping: do reclass se houve, ou da decisão do mapper
  // capturada pela persistência (em result.fieldDecisions). Aqui só
  // expomos a do reclass, que é a parte que mudou — a decisão original
  // está nos logs do enrichProduct.
  if (changes.mapperReason) {
    lines.push(`        mapping reason: ${changes.mapperReason}`);
  }

  // Opinião text-only — só imprime quando discorda do productType actual,
  // para evitar ruído nos casos onde o productType está bem.
  if (
    changes.textOnlyOpinion &&
    before.productType === "MEDICAMENTO" &&
    changes.textOnlyOpinion.type !== "MEDICAMENTO"
  ) {
    lines.push(
      `        text-only opinion: ${changes.textOnlyOpinion.type} ` +
        `(conf ${(changes.textOnlyOpinion.confidence * 100).toFixed(0)}%) — ` +
        `productType actual MEDICAMENTO pode estar errado a montante`,
    );
  }

  // Razão de imagem (sempre que a persistência tomou uma decisão)
  if (changes.imageDecision) {
    lines.push(
      `        image decision: ${changes.imageDecision.status}` +
        (changes.imageDecision.source ? ` [${changes.imageDecision.source}]` : "") +
        ` — ${changes.imageDecision.reason}`,
    );
  }

  lines.push(
    `        outcome: ${changes.outcome}` +
      (changes.category ? ` (cat: ${changes.category})` : "") +
      (changes.fieldsUpdated.length > 0
        ? ` | fields=[${changes.fieldsUpdated.join(",")}]`
        : "") +
      (changes.error ? ` | ERR=${changes.error}` : ""),
  );
  return lines.join("\n");
}

// ─── Selecção de IDs por pass ────────────────────────────────────────────────

async function findOutrosMedicamentosNivel2Id(): Promise<string | null> {
  const row = await prisma.classificacao.findFirst({
    where: {
      tipo: "NIVEL_2",
      estado: "ATIVO",
      nome: { equals: "Outros Medicamentos", mode: "insensitive" },
    },
    select: { id: true },
  });
  return row?.id ?? null;
}

async function* productIdsPass1(
  outrosMedicamentosId: string,
  startFrom: string | null,
  batchSize: number,
  onlyWithAtcOrDci: boolean,
): AsyncGenerator<string[]> {
  let cursor: string | null = startFrom;
  while (true) {
    const rows = await prisma.produto.findMany({
      where: {
        productType: "MEDICAMENTO",
        validadoManualmente: false,
        classificacaoNivel2Id: outrosMedicamentosId,
        cnp: { gt: 2_000_000 },
        estado: { not: "INATIVO" },
        ...(onlyWithAtcOrDci
          ? { OR: [{ codigoATC: { not: null } }, { dci: { not: null } }] }
          : {}),
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      select: { id: true },
      orderBy: { id: "asc" },
      take: batchSize,
    });
    if (rows.length === 0) return;
    yield rows.map((r) => r.id);
    cursor = rows[rows.length - 1].id;
    if (rows.length < batchSize) return;
  }
}

async function* productIdsPass2(
  outrosMedicamentosId: string | null,
  startFrom: string | null,
  batchSize: number,
): AsyncGenerator<string[]> {
  let cursor: string | null = startFrom;
  while (true) {
    const rows = await prisma.produto.findMany({
      where: {
        productType: "MEDICAMENTO",
        validadoManualmente: false,
        cnp: { gt: 2_000_000 },
        estado: { not: "INATIVO" },
        // Pass 1 já cobriu "Outros Medicamentos" — exclui-os para não duplicar
        ...(outrosMedicamentosId ? { classificacaoNivel2Id: { not: outrosMedicamentosId } } : {}),
        OR: [
          { codigoATC: null },
          { dci: null },
          { imagemUrl: null },
          { classificacaoNivel1Id: null },
        ],
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      select: { id: true },
      orderBy: { id: "asc" },
      take: batchSize,
    });
    if (rows.length === 0) return;
    yield rows.map((r) => r.id);
    cursor = rows[rows.length - 1].id;
    if (rows.length < batchSize) return;
  }
}

async function* productIdsPass3NonMed(
  startFrom: string | null,
  batchSize: number,
): AsyncGenerator<string[]> {
  let cursor: string | null = startFrom;
  while (true) {
    const rows = await prisma.produto.findMany({
      where: {
        validadoManualmente: false,
        cnp: { gt: 2_000_000 },
        estado: { not: "INATIVO" },
        productType: { not: "MEDICAMENTO" },
        OR: [
          { classificacaoNivel1Id: null },
          { imagemUrl: null },
        ],
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      select: { id: true },
      orderBy: { id: "asc" },
      take: batchSize,
    });
    if (rows.length === 0) return;
    yield rows.map((r) => r.id);
    cursor = rows[rows.length - 1].id;
    if (rows.length < batchSize) return;
  }
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────

async function processBatch(
  batchNumber: number,
  productIds: string[],
  dryRun: boolean,
  totals: RunTotals,
): Promise<BatchSummary> {
  const summary: BatchSummary = {
    batchNumber,
    processed: 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
    classificationImprovements: 0,
    atcFilled: 0,
    dciFilled: 0,
    imagesAdded: 0,
    outrosMedicamentosRemaining: 0,
    hasAtc: 0,
    hasDci: 0,
    hasAtcOrDci: 0,
    hasNeitherAtcNorDci: 0,
    reclassByAtcPrefix: 0,
    reclassByAtcLetter: 0,
    reclassByDci: 0,
    reclassByKeyword: 0,
    reclassByOther: 0,
    outrosWithSignalNotReclass: 0,
  };
  const blocks: string[] = [];
  const categoryCounts: Record<AnalysisCategory, number> = {
    improved: 0,
    outros_no_signal: 0,
    outros_missing_rule: 0,
    image_safe: 0,
    image_skipped: 0,
    suspicious: 0,
    productType_suspect: 0,
    no_change_already_ok: 0,
  };
  // Para o relatório agrupado em dry-run, guardamos amostras por categoria
  // (até 5 cada — suficiente para o reviewer entender padrões).
  const samplesByCategory: Record<AnalysisCategory, string[]> = {
    improved: [],
    outros_no_signal: [],
    outros_missing_rule: [],
    image_safe: [],
    image_skipped: [],
    suspicious: [],
    productType_suspect: [],
    no_change_already_ok: [],
  };
  const SAMPLES_PER_CATEGORY = 5;

  // Política de saída por produto:
  //   · dry-run    → imprime cada bloco IMEDIATAMENTE (incremental — vital
  //                  quando o batch demora minutos por causa do retail HTTP
  //                  rate limit; o reviewer não fica às escuras).
  //   · live       → não imprime por produto (mantém log limpo); só o
  //                  resumo de fim de batch, com os primeiros 10.
  const sampleLimit = dryRun ? 0 : 10; // em dry-run não acumula blocks; imprime live

  for (let i = 0; i < productIds.length; i++) {
    const id = productIds[i];
    const { before, changes } = await processOne(id, dryRun);
    if (before) changes.category = categorize(before, changes);

    summary.processed++;
    if (changes.outcome === "updated") summary.updated++;
    else if (changes.outcome === "failed") summary.failed++;
    else summary.unchanged++;

    if (changes.reclassNivel2) summary.classificationImprovements++;
    if (changes.atcAdded) summary.atcFilled++;
    if (changes.dciAdded) summary.dciFilled++;
    if (changes.imageAdded) summary.imagesAdded++;

    // ── Presença de sinal (ATC / DCI) no produto ─────────────────────
    if (before) {
      const hasAtc = !!before.codigoATC;
      const hasDci = !!before.dci;
      if (hasAtc) summary.hasAtc++;
      if (hasDci) summary.hasDci++;
      if (hasAtc || hasDci) summary.hasAtcOrDci++;
      else summary.hasNeitherAtcNorDci++;
    }

    // ── Método de reclassificação (quando aplicada/proposta) ─────────
    if (changes.reclassNivel2) {
      switch (changes.reclassNivel2.method) {
        case "atc_prefix":
          summary.reclassByAtcPrefix++;
          break;
        case "atc":
          summary.reclassByAtcLetter++;
          break;
        case "dci":
          summary.reclassByDci++;
          break;
        case "keyword":
          summary.reclassByKeyword++;
          break;
        default:
          summary.reclassByOther++;
      }
    }

    // ── Continua em "Outros Medicamentos" apesar de ter sinal ────────
    if (
      before &&
      before.nivel2Nome === "Outros Medicamentos" &&
      !changes.reclassNivel2 &&
      (before.codigoATC || before.dci)
    ) {
      summary.outrosWithSignalNotReclass++;
    }

    if (
      before &&
      before.nivel2Nome === "Outros Medicamentos" &&
      !changes.reclassNivel2
    ) {
      summary.outrosMedicamentosRemaining++;
    }

    if (changes.category) {
      categoryCounts[changes.category]++;
      const sampleSlot = samplesByCategory[changes.category];
      if (sampleSlot.length < SAMPLES_PER_CATEGORY && before) {
        sampleSlot.push(fmtSampleBlock(i, before, changes));
      }
    }

    if (dryRun) {
      // Incremental: imprime imediatamente para o reviewer ver progresso.
      console.log(fmtSampleBlock(i, before, changes));
    } else if (i < sampleLimit) {
      blocks.push(fmtSampleBlock(i, before, changes));
    }
  }

  totals.processed += summary.processed;
  totals.updated += summary.updated;
  totals.unchanged += summary.unchanged;
  totals.failed += summary.failed;
  totals.classificationImprovements += summary.classificationImprovements;
  totals.atcFilled += summary.atcFilled;
  totals.dciFilled += summary.dciFilled;
  totals.imagesAdded += summary.imagesAdded;
  totals.outrosMedicamentosRemaining += summary.outrosMedicamentosRemaining;
  totals.hasAtc += summary.hasAtc;
  totals.hasDci += summary.hasDci;
  totals.hasAtcOrDci += summary.hasAtcOrDci;
  totals.hasNeitherAtcNorDci += summary.hasNeitherAtcNorDci;
  totals.reclassByAtcPrefix += summary.reclassByAtcPrefix;
  totals.reclassByAtcLetter += summary.reclassByAtcLetter;
  totals.reclassByDci += summary.reclassByDci;
  totals.reclassByKeyword += summary.reclassByKeyword;
  totals.reclassByOther += summary.reclassByOther;
  totals.outrosWithSignalNotReclass += summary.outrosWithSignalNotReclass;
  for (const k of Object.keys(categoryCounts) as AnalysisCategory[]) {
    totals.categoryCounts[k] += categoryCounts[k];
  }

  console.log(`\n— Batch ${batchNumber} —`);
  console.log(
    `  processed=${summary.processed} updated=${summary.updated} ` +
      `unchanged=${summary.unchanged} failed=${summary.failed}`,
  );
  console.log(
    `  reclassN2=${summary.classificationImprovements} ` +
      `+atc=${summary.atcFilled} +dci=${summary.dciFilled} +img=${summary.imagesAdded} ` +
      `still-outros=${summary.outrosMedicamentosRemaining}`,
  );
  console.log(
    `  signal: hasATC=${summary.hasAtc} hasDCI=${summary.hasDci} ` +
      `hasAtcOrDci=${summary.hasAtcOrDci} hasNeither=${summary.hasNeitherAtcNorDci}`,
  );
  console.log(
    `  reclass por método: atc_prefix=${summary.reclassByAtcPrefix} ` +
      `atc(letra)=${summary.reclassByAtcLetter} dci=${summary.reclassByDci} ` +
      `keyword=${summary.reclassByKeyword} outro=${summary.reclassByOther}`,
  );
  if (summary.outrosWithSignalNotReclass > 0) {
    console.log(
      `  ATENÇÃO: ${summary.outrosWithSignalNotReclass} produto(s) com ATC/DCI ` +
        `mas continuam em Outros Medicamentos — possível gap de regras no mapper.`,
    );
  }
  if (!dryRun && blocks.length > 0) {
    console.log(`\n  Amostra (primeiros ${blocks.length}):`);
    for (const b of blocks) console.log(b);
  }

  // Em dry-run, imprime o agrupamento estilo "Step 3" do user spec.
  if (dryRun) {
    console.log(`\n  Categorias do batch ${batchNumber}:`);
    console.log(`    1. Improved (n2 reclassificado):                ${categoryCounts.improved}`);
    console.log(`    2. Still Outros — sem ATC/DCI signal:           ${categoryCounts.outros_no_signal}`);
    console.log(`    3. Still Outros — falta regra para ATC/DCI:     ${categoryCounts.outros_missing_rule}`);
    console.log(`    4. Image found and safe:                        ${categoryCounts.image_safe}`);
    console.log(`    5. Image skipped (com razão):                   ${categoryCounts.image_skipped}`);
    console.log(`    6. Suspicious / needs manual review:            ${categoryCounts.suspicious}`);
    console.log(`    7. productType duvidoso (poss. não-medicamento):${categoryCounts.productType_suspect}`);
    console.log(`    -. Já estava OK / sem alteração:                ${categoryCounts.no_change_already_ok}`);

    for (const cat of [
      "productType_suspect",
      "outros_missing_rule",
      "outros_no_signal",
      "suspicious",
      "image_skipped",
    ] as const) {
      const samples = samplesByCategory[cat];
      if (samples.length === 0) continue;
      console.log(`\n  Exemplos — ${cat} (até ${SAMPLES_PER_CATEGORY}):`);
      for (const s of samples) console.log(s);
    }
  }

  return summary;
}

async function runPass(
  passLabel: string,
  ids: AsyncGenerator<string[]>,
  args: Args,
  totals: RunTotals,
  estimatedTotal: number | null,
): Promise<{ batches: number; lastCursor: string | null }> {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`${passLabel}`);
  console.log("═".repeat(70));

  let batchNumber = 0;
  let lastCursor: string | null = null;
  let processedSoFar = 0;

  for await (const productIds of ids) {
    batchNumber++;
    if (args.limit && totals.processed + productIds.length > args.limit) {
      productIds.length = Math.max(0, args.limit - totals.processed);
      if (productIds.length === 0) break;
    }
    await processBatch(batchNumber, productIds, args.dryRun, totals);
    lastCursor = productIds[productIds.length - 1];
    processedSoFar += productIds.length;
    if (estimatedTotal !== null && estimatedTotal > 0) {
      const remaining = Math.max(0, estimatedTotal - processedSoFar);
      console.log(`  progresso: ${processedSoFar}/${estimatedTotal} (~${remaining} restantes neste pass)`);
    } else {
      console.log(`  progresso: ${processedSoFar} processados neste pass`);
    }
    if (args.firstBatchOnly) {
      console.log(`\n[stop] --first-batch-only activo. Para continuar: re-corre sem essa flag.`);
      break;
    }
    if (args.limit && totals.processed >= args.limit) {
      console.log(`\n[stop] limite global ${args.limit} atingido.`);
      break;
    }
  }

  if (batchNumber === 0) {
    console.log(`  (sem produtos elegíveis neste pass)`);
  }
  return { batches: batchNumber, lastCursor };
}

// ─── Counts (para estimativas de progresso) ───────────────────────────────────

async function countPass1(
  outrosMedicamentosId: string,
  onlyWithAtcOrDci: boolean,
): Promise<number> {
  return prisma.produto.count({
    where: {
      productType: "MEDICAMENTO",
      validadoManualmente: false,
      classificacaoNivel2Id: outrosMedicamentosId,
      cnp: { gt: 2_000_000 },
      estado: { not: "INATIVO" },
      ...(onlyWithAtcOrDci
        ? { OR: [{ codigoATC: { not: null } }, { dci: { not: null } }] }
        : {}),
    },
  });
}

async function countPass2(outrosMedicamentosId: string | null): Promise<number> {
  return prisma.produto.count({
    where: {
      productType: "MEDICAMENTO",
      validadoManualmente: false,
      cnp: { gt: 2_000_000 },
      estado: { not: "INATIVO" },
      ...(outrosMedicamentosId ? { classificacaoNivel2Id: { not: outrosMedicamentosId } } : {}),
      OR: [
        { codigoATC: null },
        { dci: null },
        { imagemUrl: null },
        { classificacaoNivel1Id: null },
      ],
    },
  });
}

async function countPass3(): Promise<number> {
  return prisma.produto.count({
    where: {
      validadoManualmente: false,
      cnp: { gt: 2_000_000 },
      estado: { not: "INATIVO" },
      productType: { not: "MEDICAMENTO" },
      OR: [
        { classificacaoNivel1Id: null },
        { imagemUrl: null },
      ],
    },
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();

  console.log("─".repeat(70));
  console.log("Reprocessamento do catálogo (MEDICAMENTOS-priority)");
  console.log("─".repeat(70));
  console.log(`  dryRun:          ${args.dryRun}`);
  console.log(`  firstBatchOnly:  ${args.firstBatchOnly}`);
  console.log(`  batchSize:       ${args.batchSize}`);
  console.log(`  startFrom:       ${args.startFrom ?? "(nenhum)"}`);
  console.log(`  limit:           ${args.limit ?? "(sem limite)"}`);
  console.log(`  inclui não-med:  ${args.includeNonMedicamento}`);
  console.log(`  skipRetail:      ${args.skipRetail}`);
  console.log(`  onlyWithAtcOrDci:${args.onlyWithAtcOrDci}`);

  // Aplica o toggle de retail ANTES de qualquer chamada a enrichProduct.
  // Em --skip-retail, o connector retail devolve null imediatamente — o
  // resto do pipeline (INFARMED, classifier, mapper, persistence) corre
  // normalmente, isolando a qualidade de mapping do custo HTTP.
  setSkipRetailConnector(args.skipRetail);

  const outrosMedicamentosId = await findOutrosMedicamentosNivel2Id();
  if (!outrosMedicamentosId) {
    console.error(
      `[fatal] Classificacao "Outros Medicamentos" (NIVEL_2, ATIVO) não encontrada. ` +
        `Corre 'npx tsx scripts/seed-taxonomy.ts' primeiro.`,
    );
    process.exitCode = 1;
    return;
  }

  // Counts iniciais para progresso e baseline do sumário final
  const [pass1Count, pass2Count, pass3Count, outrosBefore] = await Promise.all([
    countPass1(outrosMedicamentosId, args.onlyWithAtcOrDci),
    countPass2(outrosMedicamentosId),
    args.includeNonMedicamento ? countPass3() : Promise.resolve(0),
    prisma.produto.count({
      where: {
        productType: "MEDICAMENTO",
        classificacaoNivel2Id: outrosMedicamentosId,
        estado: { not: "INATIVO" },
      },
    }),
  ]);
  console.log(`\n  baseline:`);
  console.log(`    PASS 1 (med + Outros Medicamentos):  ${pass1Count}`);
  console.log(`    PASS 2 (med com campos em falta):    ${pass2Count}`);
  if (args.includeNonMedicamento) {
    console.log(`    PASS 3 (não-med com campos em falta): ${pass3Count}`);
  }
  console.log(`    "Outros Medicamentos" no início:     ${outrosBefore}`);
  console.log("");

  const totals: RunTotals = {
    processed: 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
    classificationImprovements: 0,
    atcFilled: 0,
    dciFilled: 0,
    imagesAdded: 0,
    outrosMedicamentosBefore: outrosBefore,
    outrosMedicamentosRemaining: 0,
    categoryCounts: {
      improved: 0,
      outros_no_signal: 0,
      outros_missing_rule: 0,
      image_safe: 0,
      image_skipped: 0,
      suspicious: 0,
      productType_suspect: 0,
      no_change_already_ok: 0,
    },
    hasAtc: 0,
    hasDci: 0,
    hasAtcOrDci: 0,
    hasNeitherAtcNorDci: 0,
    reclassByAtcPrefix: 0,
    reclassByAtcLetter: 0,
    reclassByDci: 0,
    reclassByKeyword: 0,
    reclassByOther: 0,
    outrosWithSignalNotReclass: 0,
  };

  // PASS 1
  await runPass(
    args.onlyWithAtcOrDci
      ? "PASS 1 — MEDICAMENTO em \"Outros Medicamentos\" (com ATC ou DCI)"
      : "PASS 1 — MEDICAMENTO em \"Outros Medicamentos\"",
    productIdsPass1(outrosMedicamentosId, args.startFrom, args.batchSize, args.onlyWithAtcOrDci),
    args,
    totals,
    pass1Count,
  );

  if (args.firstBatchOnly || (args.limit !== null && totals.processed >= args.limit)) {
    printFinalSummary(totals, args, outrosMedicamentosId);
    return;
  }

  // PASS 2
  await runPass(
    "PASS 2 — MEDICAMENTO com codigoATC/dci/imagemUrl em falta",
    productIdsPass2(outrosMedicamentosId, args.startFrom, args.batchSize),
    args,
    totals,
    pass2Count,
  );

  // PASS 3 (opcional)
  if (args.includeNonMedicamento) {
    if (args.limit === null || totals.processed < args.limit) {
      await runPass(
        "PASS 3 — Não-MEDICAMENTO com campos em falta",
        productIdsPass3NonMed(args.startFrom, args.batchSize),
        args,
        totals,
        pass3Count,
      );
    }
  }

  await printFinalSummary(totals, args, outrosMedicamentosId);
}

async function printFinalSummary(
  totals: RunTotals,
  args: Args,
  outrosMedicamentosId: string,
): Promise<void> {
  // Recount actual "Outros Medicamentos" para precisão (em vez de
  // confiar no contador incremental — pode haver produtos que entraram/
  // saíram desta categoria fora deste run).
  const outrosAfter = args.dryRun
    ? totals.outrosMedicamentosBefore - totals.classificationImprovements
    : await prisma.produto.count({
        where: {
          productType: "MEDICAMENTO",
          classificacaoNivel2Id: outrosMedicamentosId,
          estado: { not: "INATIVO" },
        },
      });

  console.log("\n" + "═".repeat(70));
  console.log("SUMÁRIO FINAL");
  console.log("═".repeat(70));
  console.log(`  total processados:           ${totals.processed}`);
  console.log(`  total actualizados:          ${totals.updated}`);
  console.log(`  total sem alterações:        ${totals.unchanged}`);
  console.log(`  total falharam:              ${totals.failed}`);
  console.log(`  reclassificações de N2:      ${totals.classificationImprovements}`);
  console.log(`  ATC preenchido:              ${totals.atcFilled}`);
  console.log(`  DCI preenchido:              ${totals.dciFilled}`);
  console.log(`  imagens adicionadas:         ${totals.imagesAdded}`);
  console.log(`  "Outros Medicamentos" antes: ${totals.outrosMedicamentosBefore}`);
  console.log(`  "Outros Medicamentos" depois:${outrosAfter}${args.dryRun ? " (estimado, dry-run)" : ""}`);
  console.log(`  modo:                        ${args.dryRun ? "DRY-RUN (sem escrita em BD)" : "LIVE"}`);

  console.log("\n  Métricas de sinal (ATC/DCI):");
  console.log(`    com ATC:                       ${totals.hasAtc}`);
  console.log(`    com DCI:                       ${totals.hasDci}`);
  console.log(`    com ATC ou DCI:                ${totals.hasAtcOrDci}`);
  console.log(`    sem nenhum dos dois:           ${totals.hasNeitherAtcNorDci}`);

  console.log("\n  Reclassificações por método:");
  console.log(`    via ATC prefix (3 chars):      ${totals.reclassByAtcPrefix}`);
  console.log(`    via ATC letter (1 char):       ${totals.reclassByAtcLetter}`);
  console.log(`    via DCI (keyword no DCI):      ${totals.reclassByDci}`);
  console.log(`    via keyword (designação):      ${totals.reclassByKeyword}`);
  console.log(`    via outro:                     ${totals.reclassByOther}`);

  console.log(`\n  Continuam em "Outros Medicamentos":`);
  console.log(`    apesar de ter ATC ou DCI:      ${totals.outrosWithSignalNotReclass}`);
  console.log(`    sem qualquer sinal:            ${totals.hasNeitherAtcNorDci}`);

  console.log("\n  Distribuição por categoria de análise:");
  console.log(`    1. Improved:                  ${totals.categoryCounts.improved}`);
  console.log(`    2. Still Outros (no signal):  ${totals.categoryCounts.outros_no_signal}`);
  console.log(`    3. Still Outros (rule gap):   ${totals.categoryCounts.outros_missing_rule}`);
  console.log(`    4. Image found and safe:      ${totals.categoryCounts.image_safe}`);
  console.log(`    5. Image skipped:             ${totals.categoryCounts.image_skipped}`);
  console.log(`    6. Suspicious / review:       ${totals.categoryCounts.suspicious}`);
  console.log(`    7. productType duvidoso:      ${totals.categoryCounts.productType_suspect}`);
  console.log(`    -. Already OK:                ${totals.categoryCounts.no_change_already_ok}`);

  if (args.dryRun) {
    console.log("\n  Recomendação:");
    const c = totals.categoryCounts;
    if (totals.failed > 0) {
      console.log(
        `    · ${totals.failed} falha(s) detectadas — REVER antes de aplicar live.`,
      );
    }
    if (c.suspicious > 0) {
      console.log(
        `    · ${c.suspicious} produto(s) suspeito(s) — verificar logs antes de aplicar.`,
      );
    }
    if (c.improved > 0) {
      console.log(
        `    · ${c.improved} reclassificação(ões) propostas vão sair de "Outros Medicamentos".`,
      );
    }
    if (c.outros_missing_rule > 0) {
      console.log(
        `    · ${c.outros_missing_rule} produto(s) com ATC/DCI MAS sem regra que melhore — ` +
          `oportunidade para enriquecer ATC_PREFIX_TO_NIVEL2 / KEYWORD_RULES numa iteração futura.`,
      );
    }
    if (c.outros_no_signal > 0) {
      console.log(
        `    · ${c.outros_no_signal} produto(s) sem ATC nem DCI nem keyword — ` +
          `dependem de a INFARMED ter dados ou de revisão manual.`,
      );
    }
    if (c.productType_suspect > 0) {
      console.log(
        `    · ${c.productType_suspect} produto(s) com productType=MEDICAMENTO mas sinais de texto ` +
          `sugerem outro tipo (DERMOCOSMETICA, SUPLEMENTO, etc.) — não-bloqueante, ` +
          `mas indica tarefa upstream de re-classificar productType (não cabe a este script).`,
      );
    }
    if (c.image_skipped > 0) {
      console.log(
        `    · ${c.image_skipped} imagem(ns) saltadas — confiança baixa ou fonte não autoritária. ` +
          `É o comportamento esperado (zero falsos positivos).`,
      );
    }
    console.log(
      `    · Se os números acima parecerem razoáveis, próximo passo: ` +
        `correr o mesmo comando sem --dry-run para aplicar o primeiro batch real.`,
    );
  }
  console.log("═".repeat(70));
}

main()
  .catch((err) => {
    console.error("[erro fatal]", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
