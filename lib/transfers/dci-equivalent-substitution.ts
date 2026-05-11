/**
 * lib/transfers/dci-equivalent-substitution.ts
 *
 * Detector de substituição interna por equivalência DCI — amplia o
 * universo de same-CNP (`internal-substitution.ts`) para incluir pares
 * de produtos com **DCI normalizada igual** mas CNPs diferentes (ex:
 * genéricos do mesmo princípio activo + dose + forma).
 *
 * Pure function — sem I/O, sem Prisma. Toma rows hidratados pelo
 * caller (probe ou loader futuro) e produz:
 *   1. candidatos aceites (transferência segura propostas)
 *   2. breakdown de rejeições por razão (forma diferente, dosagem
 *      diferente, ATC diferente, MSRM/MNSRM divergente)
 *
 * Gates de segurança clínica nesta fase:
 *   · `productType === "MEDICAMENTO"` (pré-filtro)
 *   · `dci` não vazio (pré-filtro)
 *   · `formaFarmaceutica` normalizada igual no par
 *   · `dosagem` normalizada igual no par — NÃO permitimos dosagem
 *     diferente nesta passagem (10mg ≠ 20mg em qualquer cenário sem
 *     decisão clínica)
 *   · flags `MSRM` / `MNSRM` iguais — não misturamos medicamentos
 *     sujeitos a receita com não-sujeitos
 *   · `codigoATC` igual ao nível 5 (primeiros 5 chars do código ATC,
 *     ex: "A10BB" para sulfonilureias) — protege contra
 *     mis-classificações do catálogo onde o mesmo DCI aparece em duas
 *     famílias terapêuticas diferentes
 *
 * Não devolve nada se algum gate falha. Reporta a falha em
 * `rejectionCounts` para análise de qualidade.
 */

import {
  avgDaily,
  coverageDays,
  WINDOW_90D,
} from "@/lib/operational/metrics-shared";

// ─── Normalizadores puros ──────────────────────────────────────────────

/**
 * Normalização canónica para campos de catálogo: lowercase, trim, e
 * colapso de whitespace múltiplo num único espaço. Não remove
 * acentos — assumimos que origem já está consistente nesse aspecto
 * (INFOMED entrega sempre a mesma grafia).
 */
export function normalizeCatalogString(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  const t = s.trim().toLowerCase().replace(/\s+/g, " ");
  return t.length === 0 ? null : t;
}

/**
 * Normalização específica de dosagem: lowercase + remove todos os
 * espaços (para que "10 mg" === "10mg" === "10MG"). Não normaliza
 * unidades (mg vs g vs mcg ficam distintas — propositadamente, dado
 * que diferentes ordens de grandeza não devem casar nunca).
 */
export function normalizeDosagem(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  const t = s.toLowerCase().replace(/\s+/g, "");
  return t.length === 0 ? null : t;
}

/**
 * Devolve o "ATC5" — primeiros 5 caracteres do código ATC, em
 * uppercase. Ex: "A10BB02" → "A10BB". Retorna null para inputs
 * inválidos.
 */
export function atc5(code: string | null | undefined): string | null {
  if (code === null || code === undefined) return null;
  const t = code.trim().toUpperCase();
  if (t.length < 5) return null;
  return t.slice(0, 5);
}

// ─── Types ─────────────────────────────────────────────────────────────

export type DciSubstitutionInput = {
  produtoId: string;
  farmaciaId: string;
  farmaciaNome: string;
  cnp: string;
  designacao: string;
  stockAtual: number;
  /** Custo unitário do produto (PUC ou PMC). Null = 0 €. */
  puc: number | null;
  /** Soma de vendas na janela (default 90d). */
  salesQty: number;

  // Catalog metadata — usado pelos gates clínicos
  dci: string | null;
  formaFarmaceutica: string | null;
  dosagem: string | null;
  flagMSRM: boolean;
  flagMNSRM: boolean;
  codigoATC: string | null;
  productType: string | null;
};

export type DciSubstitutionOptions = {
  /** Cobertura abaixo da qual o destino é "em ruptura iminente". Default 7. */
  ruptureThresholdDays?: number;
  /** Cobertura acima da qual a origem é "em excesso". Default 30. */
  excessThresholdDays?: number;
  /** Cobertura-alvo após transferência. Default 15. */
  targetCoverageDays?: number;
  /** Reserva mínima na origem, em dias. Default 14. */
  reserveDaysSource?: number;
  /** Quantidade mínima para emitir candidato. Default 1. */
  minTransferableQty?: number;
  /** Janela canónica para avgDaily. Default 90. */
  windowDays?: number;
  /** Quando true, exige `productType === 'MEDICAMENTO'`. Default true. */
  requireMedicamento?: boolean;
};

export type DciSubstitutionCandidate = {
  // Destino (em ruptura)
  destinoProdutoId: string;
  destinoCnp: string;
  destinoDesignacao: string;
  destinoFarmaciaId: string;
  destinoFarmaciaNome: string;
  destinoStock: number;
  destinoCoverage: number | null;
  destinoPuc: number | null;

  // Source (em excesso, CNP diferente, mesma classe DCI)
  sourceProdutoId: string;
  sourceCnp: string;
  sourceDesignacao: string;
  sourceFarmaciaId: string;
  sourceFarmaciaNome: string;
  sourceStock: number;
  sourceCoverage: number;
  sourcePuc: number | null;

  // Equivalence class (já validada — todos campos iguais)
  dci: string;
  formaFarmaceutica: string;
  dosagem: string;
  isMSRM: boolean;
  atc5: string;

  transferableQty: number;
  /** `transferableQty × destinoPuc` (fallback sourcePuc se destino null). */
  avoidedPurchaseEstimate: number;
};

export type DciRejectionReason =
  /** Produto não tem `productType = MEDICAMENTO`. Pré-filtro a nível de row. */
  | "productType_nao_medicamento"
  /** Produto não tem DCI preenchida. Pré-filtro a nível de row. */
  | "dci_ausente"
  /** Mesmo DCI, mas formaFarmaceutica difere. Pair-level. */
  | "forma_diferente"
  /** Mesmo DCI+forma, mas dosagem difere. Pair-level. */
  | "dosagem_diferente"
  /** Mesmo DCI+forma+dosagem, mas ATC5 difere. Pair-level. */
  | "atc_diferente"
  /** Mesmo DCI+forma+dosagem+ATC, mas flags MSRM/MNSRM divergem. Pair-level. */
  | "msrm_divergente"
  /** Mesma farmácia origem/destino — não é candidato a transferência. */
  | "mesma_farmacia"
  /** Gates clínicos passaram mas qty calculada < minTransferableQty. */
  | "qty_insuficiente"
  /** Destino não tem demanda (avgDaily=0) — não é ruptura iminente. */
  | "destino_sem_demanda";

export type DciSubstitutionResult = {
  candidates: DciSubstitutionCandidate[];
  rejectionCounts: Record<DciRejectionReason, number>;
  /** Nº de rows do input filtradas no pré-filtro (productType / dci ausente). */
  rowsPrefiltered: number;
  /** Nº de rows do input considerados (após pré-filtro). */
  rowsConsidered: number;
  /** Nº de DCIs distintos no universo considerado. */
  dciDistinctCount: number;
};

// ─── Detector ──────────────────────────────────────────────────────────

/**
 * Encontra candidatos de substituição interna DCI-equivalente.
 *
 * Algoritmo:
 *   1. Pré-filtro: remove rows sem productType=MEDICAMENTO (se exigido)
 *      ou sem DCI. Conta em `rejectionCounts.productType_nao_medicamento`
 *      e `rejectionCounts.dci_ausente`.
 *   2. Calcula avgDaily/coverage para cada row.
 *   3. Agrupa por `normalizeCatalogString(dci)`.
 *   4. Dentro de cada grupo, separa em rupturas (low cov + demanda) e
 *      excessos (high cov).
 *   5. Para cada (rupture, excess) com farmacias diferentes:
 *      · Avalia gates clínicos em ordem: forma → dosagem → ATC → MSRM.
 *      · Conta cada falha em `rejectionCounts` (categorias mutuamente
 *        exclusivas — first failed gate wins).
 *      · Se todos os gates passarem, computa transferableQty (mesma
 *        fórmula que same-CNP) e adiciona candidato.
 *   6. Escolhe **um source por destino** (max cobertura entre sources
 *      que passaram todos os gates).
 *   7. Ordena candidatos por `avoidedPurchaseEstimate` desc.
 */
export function findDciEquivalentSubstitutions(
  input: DciSubstitutionInput[],
  options: DciSubstitutionOptions = {},
): DciSubstitutionResult {
  const ruptureThreshold = options.ruptureThresholdDays ?? 7;
  const excessThreshold = options.excessThresholdDays ?? 30;
  const targetCoverage = options.targetCoverageDays ?? 15;
  const reserveDays = options.reserveDaysSource ?? 14;
  const minQty = Math.max(1, options.minTransferableQty ?? 1);
  const windowDays = options.windowDays ?? WINDOW_90D;
  const requireMedicamento = options.requireMedicamento ?? true;

  const rejectionCounts: Record<DciRejectionReason, number> = {
    productType_nao_medicamento: 0,
    dci_ausente: 0,
    forma_diferente: 0,
    dosagem_diferente: 0,
    atc_diferente: 0,
    msrm_divergente: 0,
    mesma_farmacia: 0,
    qty_insuficiente: 0,
    destino_sem_demanda: 0,
  };

  // ── 1. Pré-filtro ────────────────────────────────────────────────────
  type Enriched = DciSubstitutionInput & {
    avgDaily: number;
    coverage: number | null;
    normDci: string;
    normForma: string | null;
    normDosagem: string | null;
    normAtc5: string | null;
  };

  const considered: Enriched[] = [];
  let rowsPrefiltered = 0;

  for (const r of input) {
    if (requireMedicamento && r.productType !== "MEDICAMENTO") {
      rejectionCounts.productType_nao_medicamento++;
      rowsPrefiltered++;
      continue;
    }
    const normDci = normalizeCatalogString(r.dci);
    if (normDci === null) {
      rejectionCounts.dci_ausente++;
      rowsPrefiltered++;
      continue;
    }
    const ad = avgDaily(r.salesQty, windowDays);
    const cov = coverageDays(r.stockAtual, ad);
    considered.push({
      ...r,
      avgDaily: ad,
      coverage: cov,
      normDci,
      normForma: normalizeCatalogString(r.formaFarmaceutica),
      normDosagem: normalizeDosagem(r.dosagem),
      normAtc5: atc5(r.codigoATC),
    });
  }

  // ── 2. Agrupar por DCI normalizado ───────────────────────────────────
  const byDci = new Map<string, Enriched[]>();
  for (const e of considered) {
    if (!byDci.has(e.normDci)) byDci.set(e.normDci, []);
    byDci.get(e.normDci)!.push(e);
  }

  // ── 3. Para cada grupo, gerar candidatos ─────────────────────────────
  // Cada destino recolhe os melhores sources após gates; escolhemos o
  // de maior cobertura. Não emitimos múltiplos candidatos por destino.
  type CandidateKey = string;
  const bestSourcePerDestino = new Map<CandidateKey, {
    destino: Enriched;
    source: Enriched;
  }>();

  for (const entries of byDci.values()) {
    if (entries.length < 2) continue;

    const ruptures = entries.filter(
      (e) => e.coverage !== null && e.coverage < ruptureThreshold && e.avgDaily > 0,
    );
    if (ruptures.length === 0) continue;

    const excesses = entries.filter(
      (e) => e.coverage !== null && e.coverage > excessThreshold,
    );
    if (excesses.length === 0) continue;

    for (const destino of ruptures) {
      // Coleta sources que passam todos os gates. Conta as falhas
      // em rejectionCounts (priority order: first failed wins).
      const validSources: Enriched[] = [];
      for (const source of excesses) {
        if (source.farmaciaId === destino.farmaciaId) {
          rejectionCounts.mesma_farmacia++;
          continue;
        }
        // Gate 1: forma
        if (destino.normForma === null || source.normForma === null || destino.normForma !== source.normForma) {
          rejectionCounts.forma_diferente++;
          continue;
        }
        // Gate 2: dosagem
        if (destino.normDosagem === null || source.normDosagem === null || destino.normDosagem !== source.normDosagem) {
          rejectionCounts.dosagem_diferente++;
          continue;
        }
        // Gate 3: ATC5
        if (destino.normAtc5 === null || source.normAtc5 === null || destino.normAtc5 !== source.normAtc5) {
          rejectionCounts.atc_diferente++;
          continue;
        }
        // Gate 4: MSRM/MNSRM
        if (destino.flagMSRM !== source.flagMSRM || destino.flagMNSRM !== source.flagMNSRM) {
          rejectionCounts.msrm_divergente++;
          continue;
        }
        validSources.push(source);
      }
      if (validSources.length === 0) continue;

      // Best source: maior cobertura
      const best = validSources.reduce((b, c) =>
        (c.coverage ?? 0) > (b.coverage ?? 0) ? c : b,
      );
      const key = `${destino.produtoId}:${destino.farmaciaId}`;
      const existing = bestSourcePerDestino.get(key);
      if (!existing || (best.coverage ?? 0) > (existing.source.coverage ?? 0)) {
        bestSourcePerDestino.set(key, { destino, source: best });
      }
    }
  }

  // ── 4. Materializar candidates + filtrar qty insuficiente ────────────
  const candidates: DciSubstitutionCandidate[] = [];
  for (const { destino, source } of bestSourcePerDestino.values()) {
    const sourceReserveStock = Math.max(0, reserveDays * source.avgDaily);
    const sourceExcess = Math.max(0, source.stockAtual - sourceReserveStock);
    const destinoNeed = Math.max(
      0,
      (targetCoverage - (destino.coverage ?? 0)) * destino.avgDaily,
    );
    const transferableQty = Math.floor(Math.min(sourceExcess, destinoNeed));

    if (transferableQty < minQty) {
      rejectionCounts.qty_insuficiente++;
      continue;
    }

    const unitCost = destino.puc ?? source.puc ?? 0;
    const avoidedPurchaseEstimate = Math.round(transferableQty * unitCost * 100) / 100;

    candidates.push({
      destinoProdutoId: destino.produtoId,
      destinoCnp: destino.cnp,
      destinoDesignacao: destino.designacao,
      destinoFarmaciaId: destino.farmaciaId,
      destinoFarmaciaNome: destino.farmaciaNome,
      destinoStock: Math.round(destino.stockAtual),
      destinoCoverage: destino.coverage,
      destinoPuc: destino.puc,

      sourceProdutoId: source.produtoId,
      sourceCnp: source.cnp,
      sourceDesignacao: source.designacao,
      sourceFarmaciaId: source.farmaciaId,
      sourceFarmaciaNome: source.farmaciaNome,
      sourceStock: Math.round(source.stockAtual),
      sourceCoverage: source.coverage ?? 0,
      sourcePuc: source.puc,

      dci: destino.normDci,
      formaFarmaceutica: destino.normForma ?? "",
      dosagem: destino.normDosagem ?? "",
      isMSRM: destino.flagMSRM,
      atc5: destino.normAtc5 ?? "",

      transferableQty,
      avoidedPurchaseEstimate,
    });
  }

  candidates.sort((a, b) => {
    if (b.avoidedPurchaseEstimate !== a.avoidedPurchaseEstimate) {
      return b.avoidedPurchaseEstimate - a.avoidedPurchaseEstimate;
    }
    const ca = a.destinoCoverage ?? 0;
    const cb = b.destinoCoverage ?? 0;
    return ca - cb;
  });

  return {
    candidates,
    rejectionCounts,
    rowsPrefiltered,
    rowsConsidered: considered.length,
    dciDistinctCount: byDci.size,
  };
}
