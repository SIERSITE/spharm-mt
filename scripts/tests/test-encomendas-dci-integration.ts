/**
 * scripts/tests/test-encomendas-dci-integration.ts
 *
 * Testes para a integração do detector DCI-equivalente no pipeline de
 * encomendas. Os detectores em si têm tests próprios
 * (`test-internal-substitution.ts` 22 asserts, `test-dci-equivalent-
 * substitution.ts` 47 asserts). Aqui foco na **interacção** entre os
 * dois quando aplicados sobre o mesmo universo:
 *
 *   1. Same-CNP tem prioridade — quando ambos detectam para o mesmo
 *      destino, na camada de encomendas o DCI fica suprimido.
 *   2. Gate ATC5 do detector DCI continua activo dentro do pipeline.
 *   3. Gate forma / dosagem do detector DCI continua activo.
 *   4. Fallback seguro quando campos clínicos estão null: o par é
 *      simplesmente ignorado pelo DCI (pré-filtro), sem afectar
 *      same-CNP.
 *
 * Sem rede, sem BD — exercita os detectores directamente e simula
 * a regra de prioridade que `lib/encomendas-data.ts` aplica
 * (DCI-equivalente só aplicado a destinos sem same-CNP).
 *
 * Correr: npx tsx scripts/tests/test-encomendas-dci-integration.ts
 */

import {
  findInternalSubstitutions,
  type SubstitutionInput,
} from "../../lib/transfers/internal-substitution";
import {
  findDciEquivalentSubstitutions,
  type DciSubstitutionInput,
} from "../../lib/transfers/dci-equivalent-substitution";

const errors: string[] = [];
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    errors.push(msg);
    console.error(`  ✗ ${msg}`);
  } else {
    console.log(`  ✓ ${msg}`);
  }
}
function eq(actual: unknown, expected: unknown, msg: string): void {
  assert(
    actual === expected,
    `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

const ENCOMENDA_OPTS = {
  ruptureThresholdDays: 15,
  excessThresholdDays: 30,
  targetCoverageDays: 15,
  reserveDaysSource: 14,
  minTransferableQty: 1,
};

/** Helper para criar par de inputs (one row per detector). */
function makePair(
  base: {
    produtoId: string;
    farmaciaId: string;
    cnp: string;
    stockAtual: number;
    salesQty: number;
    puc: number | null;
    designacao?: string;
    farmaciaNome?: string;
    dci?: string | null;
    formaFarmaceutica?: string | null;
    dosagem?: string | null;
    flagMSRM?: boolean;
    flagMNSRM?: boolean;
    codigoATC?: string | null;
    productType?: string | null;
  },
): { same: SubstitutionInput; dci: DciSubstitutionInput } {
  return {
    same: {
      produtoId: base.produtoId,
      farmaciaId: base.farmaciaId,
      farmaciaNome: base.farmaciaNome ?? base.farmaciaId,
      cnp: base.cnp,
      designacao: base.designacao ?? "Produto X",
      stockAtual: base.stockAtual,
      puc: base.puc,
      salesQty: base.salesQty,
    },
    dci: {
      produtoId: base.produtoId,
      farmaciaId: base.farmaciaId,
      farmaciaNome: base.farmaciaNome ?? base.farmaciaId,
      cnp: base.cnp,
      designacao: base.designacao ?? "Produto X",
      stockAtual: base.stockAtual,
      puc: base.puc,
      salesQty: base.salesQty,
      // `??` colapsa `null` em fallback — usar `=== undefined` para
      // preservar `null` explicitamente injectado pelos testes 6.x.
      dci: base.dci === undefined ? "ibuprofeno" : base.dci,
      formaFarmaceutica: base.formaFarmaceutica === undefined ? "comprimido" : base.formaFarmaceutica,
      dosagem: base.dosagem === undefined ? "400mg" : base.dosagem,
      flagMSRM: base.flagMSRM ?? false,
      flagMNSRM: base.flagMNSRM ?? false,
      codigoATC: base.codigoATC === undefined ? "M01AE01" : base.codigoATC,
      productType: base.productType === undefined ? "MEDICAMENTO" : base.productType,
    },
  };
}

/**
 * Replica a regra do pipeline de encomendas: para cada destino
 * (`produtoId:farmaciaId`), aplica DCI APENAS se same-CNP não tiver
 * candidato.
 */
function applyPipelineRule(
  sameCnp: ReturnType<typeof findInternalSubstitutions>,
  dci: ReturnType<typeof findDciEquivalentSubstitutions>,
): Map<string, "same-cnp" | "dci-equivalent" | "none"> {
  const sameByDestino = new Map<string, true>();
  for (const s of sameCnp) {
    sameByDestino.set(`${s.produtoId}:${s.destinoFarmaciaId}`, true);
  }
  const out = new Map<string, "same-cnp" | "dci-equivalent" | "none">();
  for (const s of sameCnp) {
    out.set(`${s.produtoId}:${s.destinoFarmaciaId}`, "same-cnp");
  }
  for (const c of dci.candidates) {
    const k = `${c.destinoProdutoId}:${c.destinoFarmaciaId}`;
    if (!sameByDestino.has(k)) out.set(k, "dci-equivalent");
  }
  return out;
}

// ─── 1. Same-CNP tem prioridade ─────────────────────────────────────
console.log("\n1. Same-CNP tem prioridade quando ambos detectores propõem:");
{
  // Destino fA com Forxiga (CNP 5487228), source fB com Forxiga
  // (mesmo CNP) E source fC com Edistride (CNP diferente mas DCI igual).
  // Same-CNP escolhe fB; DCI escolheria fC. Pipeline deve devolver
  // same-CNP para fA.
  const destino = makePair({
    produtoId: "p_forxiga", farmaciaId: "fA", cnp: "5487228",
    stockAtual: 5, salesQty: 90, puc: 30,
    designacao: "Forxiga", dci: "dapagliflozina",
    formaFarmaceutica: "comprimido revestido", dosagem: "10mg", codigoATC: "A10BK01",
  });
  const sourceSame = makePair({
    produtoId: "p_forxiga", farmaciaId: "fB", cnp: "5487228",
    stockAtual: 100, salesQty: 90, puc: 30,
    designacao: "Forxiga", dci: "dapagliflozina",
    formaFarmaceutica: "comprimido revestido", dosagem: "10mg", codigoATC: "A10BK01",
  });
  const sourceDci = makePair({
    produtoId: "p_edistride", farmaciaId: "fC", cnp: "5764410",
    stockAtual: 100, salesQty: 90, puc: 30,
    designacao: "Edistride", dci: "dapagliflozina",
    formaFarmaceutica: "comprimido revestido", dosagem: "10mg", codigoATC: "A10BK01",
  });

  const sameCnp = findInternalSubstitutions(
    [destino.same, sourceSame.same, sourceDci.same],
    ENCOMENDA_OPTS,
  );
  const dci = findDciEquivalentSubstitutions(
    [destino.dci, sourceSame.dci, sourceDci.dci],
    ENCOMENDA_OPTS,
  );

  // Same-CNP encontra par destino (fA) ← source (fB), porque ambos
  // têm CNP 5487228.
  assert(sameCnp.length >= 1, `same-CNP encontrou ≥ 1 (got ${sameCnp.length})`);
  // DCI encontra também o destino (fA) — porque dapagliflozina é DCI
  // partilhada por fA, fB e fC. Mas o source escolhido pode ser fB
  // OU fC; o que importa é que existe candidato DCI para o destino.
  assert(dci.candidates.length >= 1, `DCI encontrou ≥ 1 (got ${dci.candidates.length})`);

  const merged = applyPipelineRule(sameCnp, dci);
  eq(merged.get("p_forxiga:fA"), "same-cnp", "destino fA recebe same-CNP (prioridade)");

  // E o destino fA não tem DCI-equivalent atribuído pelo pipeline.
  let dciAssignedToDestinoForxiga = false;
  for (const [k, v] of merged) {
    if (k === "p_forxiga:fA" && v === "dci-equivalent") dciAssignedToDestinoForxiga = true;
  }
  assert(!dciAssignedToDestinoForxiga, "destino fA NÃO recebe DCI-equivalente (suprimido)");
}

// ─── 2. DCI usado como fallback quando same-CNP indisponível ────────
console.log("\n2. DCI como fallback quando same-CNP indisponível:");
{
  // Destino fA com Forxiga, source fC com Edistride (DCI igual,
  // CNP diferente). Não há outra Forxiga no grupo. Same-CNP devolve
  // nada; DCI devolve fA ← fC.
  const destino = makePair({
    produtoId: "p_forxiga", farmaciaId: "fA", cnp: "5487228",
    stockAtual: 5, salesQty: 90, puc: 30,
    dci: "dapagliflozina",
    formaFarmaceutica: "comprimido revestido", dosagem: "10mg", codigoATC: "A10BK01",
  });
  const sourceDci = makePair({
    produtoId: "p_edistride", farmaciaId: "fC", cnp: "5764410",
    stockAtual: 100, salesQty: 90, puc: 30,
    dci: "dapagliflozina",
    formaFarmaceutica: "comprimido revestido", dosagem: "10mg", codigoATC: "A10BK01",
  });

  const sameCnp = findInternalSubstitutions(
    [destino.same, sourceDci.same],
    ENCOMENDA_OPTS,
  );
  const dci = findDciEquivalentSubstitutions(
    [destino.dci, sourceDci.dci],
    ENCOMENDA_OPTS,
  );

  eq(sameCnp.length, 0, "same-CNP não devolve nada (CNPs diferentes)");
  eq(dci.candidates.length, 1, "DCI devolve 1 candidato");
  const merged = applyPipelineRule(sameCnp, dci);
  eq(merged.get("p_forxiga:fA"), "dci-equivalent", "destino fA recebe DCI-equivalente (fallback)");
}

// ─── 3. Gate ATC5: pipeline rejeita produtos com ATC5 diferente ─────
console.log("\n3. Gate ATC5 do detector DCI activo no pipeline:");
{
  const destino = makePair({
    produtoId: "p1", farmaciaId: "fA", cnp: "1111",
    stockAtual: 5, salesQty: 90, puc: 5,
    dci: "dummy", formaFarmaceutica: "pomada",
    dosagem: "0.5mg/g+30mg/g", codigoATC: "D07XC01",  // ATC5 D07XC
  });
  const sourceWrongAtc = makePair({
    produtoId: "p2", farmaciaId: "fB", cnp: "2222",
    stockAtual: 100, salesQty: 90, puc: 5,
    dci: "dummy", formaFarmaceutica: "pomada",
    dosagem: "0.5mg/g+30mg/g", codigoATC: "D01AE12",  // ATC5 D01AE — DIFERENTE
  });

  const dci = findDciEquivalentSubstitutions(
    [destino.dci, sourceWrongAtc.dci],
    ENCOMENDA_OPTS,
  );
  eq(dci.candidates.length, 0, "DCI rejeita pair quando ATC5 difere");
  eq(dci.rejectionCounts.atc_diferente, 1, "rejeição atc_diferente contabilizada");
}

// ─── 4. Gate forma diferente ────────────────────────────────────────
console.log("\n4. Gate forma_diferente activo no pipeline:");
{
  const destino = makePair({
    produtoId: "p1", farmaciaId: "fA", cnp: "1111",
    stockAtual: 5, salesQty: 90, puc: 5,
    formaFarmaceutica: "comprimido",
  });
  const sourceForma = makePair({
    produtoId: "p2", farmaciaId: "fB", cnp: "2222",
    stockAtual: 100, salesQty: 90, puc: 5,
    formaFarmaceutica: "xarope", // diferente
  });
  const dci = findDciEquivalentSubstitutions(
    [destino.dci, sourceForma.dci],
    ENCOMENDA_OPTS,
  );
  eq(dci.candidates.length, 0, "DCI rejeita pair quando forma difere");
  eq(dci.rejectionCounts.forma_diferente, 1, "rejeição forma_diferente contabilizada");
}

// ─── 5. Gate dosagem diferente ──────────────────────────────────────
console.log("\n5. Gate dosagem_diferente activo no pipeline:");
{
  const destino = makePair({
    produtoId: "p1", farmaciaId: "fA", cnp: "1111",
    stockAtual: 5, salesQty: 90, puc: 5,
    dosagem: "10mg",
  });
  const sourceDose = makePair({
    produtoId: "p2", farmaciaId: "fB", cnp: "2222",
    stockAtual: 100, salesQty: 90, puc: 5,
    dosagem: "20mg",
  });
  const dci = findDciEquivalentSubstitutions(
    [destino.dci, sourceDose.dci],
    ENCOMENDA_OPTS,
  );
  eq(dci.candidates.length, 0, "DCI rejeita pair quando dosagem difere");
  eq(dci.rejectionCounts.dosagem_diferente, 1, "rejeição dosagem_diferente contabilizada");
}

// ─── 6. Fallback seguro: campo clínico null ────────────────────────
console.log("\n6. Fallback seguro quando DCI é null no destino:");
{
  const destino = makePair({
    produtoId: "p1", farmaciaId: "fA", cnp: "1111",
    stockAtual: 5, salesQty: 90, puc: 5,
    dci: null,
  });
  const sourceOk = makePair({
    produtoId: "p2", farmaciaId: "fB", cnp: "2222",
    stockAtual: 100, salesQty: 90, puc: 5,
  });
  const dci = findDciEquivalentSubstitutions(
    [destino.dci, sourceOk.dci],
    ENCOMENDA_OPTS,
  );
  eq(dci.candidates.length, 0, "DCI rejeita destino quando DCI null");
  eq(dci.rejectionCounts.dci_ausente, 1, "1 pré-filtro dci_ausente registado");
}

console.log("\n6b. Fallback seguro quando forma é null no source:");
{
  const destino = makePair({
    produtoId: "p1", farmaciaId: "fA", cnp: "1111",
    stockAtual: 5, salesQty: 90, puc: 5,
  });
  const sourceNoForma = makePair({
    produtoId: "p2", farmaciaId: "fB", cnp: "2222",
    stockAtual: 100, salesQty: 90, puc: 5,
    formaFarmaceutica: null,
  });
  const dci = findDciEquivalentSubstitutions(
    [destino.dci, sourceNoForma.dci],
    ENCOMENDA_OPTS,
  );
  eq(dci.candidates.length, 0, "DCI rejeita source com forma null");
  // O detector conta como forma_diferente porque source.normForma === null
  // != destino.normForma. Aceitável — o efeito é o mesmo: rejeição silenciosa.
  eq(dci.rejectionCounts.forma_diferente, 1, "rejeição contabilizada como forma_diferente");
}

console.log("\n6c. Fallback seguro quando ATC é null no source:");
{
  const destino = makePair({
    produtoId: "p1", farmaciaId: "fA", cnp: "1111",
    stockAtual: 5, salesQty: 90, puc: 5,
  });
  const sourceNoAtc = makePair({
    produtoId: "p2", farmaciaId: "fB", cnp: "2222",
    stockAtual: 100, salesQty: 90, puc: 5,
    codigoATC: null,
  });
  const dci = findDciEquivalentSubstitutions(
    [destino.dci, sourceNoAtc.dci],
    ENCOMENDA_OPTS,
  );
  eq(dci.candidates.length, 0, "DCI rejeita source com ATC null");
  eq(dci.rejectionCounts.atc_diferente, 1, "rejeição contabilizada como atc_diferente");
}

console.log("\n6d. Fallback seguro quando productType é null:");
{
  const destino = makePair({
    produtoId: "p1", farmaciaId: "fA", cnp: "1111",
    stockAtual: 5, salesQty: 90, puc: 5,
    productType: null,
  });
  const sourceOk = makePair({
    produtoId: "p2", farmaciaId: "fB", cnp: "2222",
    stockAtual: 100, salesQty: 90, puc: 5,
  });
  const dci = findDciEquivalentSubstitutions(
    [destino.dci, sourceOk.dci],
    ENCOMENDA_OPTS,
  );
  eq(dci.candidates.length, 0, "DCI rejeita destino com productType null");
  eq(dci.rejectionCounts.productType_nao_medicamento, 1, "pré-filtro productType registado");
}

// ─── 7. MSRM/MNSRM divergente ──────────────────────────────────────
console.log("\n7. Gate MSRM divergente activo no pipeline:");
{
  const destino = makePair({
    produtoId: "p1", farmaciaId: "fA", cnp: "1111",
    stockAtual: 5, salesQty: 90, puc: 5,
    flagMSRM: true, flagMNSRM: false,
  });
  const sourceMnsrm = makePair({
    produtoId: "p2", farmaciaId: "fB", cnp: "2222",
    stockAtual: 100, salesQty: 90, puc: 5,
    flagMSRM: false, flagMNSRM: true,
  });
  const dci = findDciEquivalentSubstitutions(
    [destino.dci, sourceMnsrm.dci],
    ENCOMENDA_OPTS,
  );
  eq(dci.candidates.length, 0, "rejeita MSRM↔MNSRM divergente");
  eq(dci.rejectionCounts.msrm_divergente, 1, "rejeição msrm_divergente contabilizada");
}

// ─── 8. Resumo ─────────────────────────────────────────────────────
console.log("\n" + "─".repeat(78));
if (errors.length === 0) {
  console.log(`✅ encomendas-dci-integration: todos os testes passaram`);
  process.exit(0);
} else {
  console.error(`❌ encomendas-dci-integration: ${errors.length} testes falharam`);
  for (const e of errors) console.error(`  · ${e}`);
  process.exit(1);
}
