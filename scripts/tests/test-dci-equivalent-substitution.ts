/**
 * scripts/tests/test-dci-equivalent-substitution.ts
 *
 * Testes puros para `findDciEquivalentSubstitutions` e respectivos
 * normalizadores. Sem BD. Cobre:
 *   · Normalizadores (DCI, dosagem, ATC5)
 *   · Pré-filtros (productType, dci ausente)
 *   · Gates clínicos (forma, dosagem, ATC5, MSRM/MNSRM)
 *   · Cálculo de transferableQty + ordenação por € evitável
 *   · Comportamento com inputs degenerados
 *
 * Correr:
 *   npx tsx scripts/tests/test-dci-equivalent-substitution.ts
 */

import {
  findDciEquivalentSubstitutions,
  normalizeCatalogString,
  normalizeDosagem,
  atc5,
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

function row(partial: Partial<DciSubstitutionInput>): DciSubstitutionInput {
  return {
    produtoId: "p1",
    farmaciaId: "f1",
    farmaciaNome: "F1",
    cnp: "0001",
    designacao: "Produto X",
    stockAtual: 10,
    puc: 10,
    salesQty: 0,
    dci: "ibuprofeno",
    formaFarmaceutica: "comprimido",
    dosagem: "400mg",
    flagMSRM: true,
    flagMNSRM: false,
    codigoATC: "M01AE01",
    productType: "MEDICAMENTO",
    ...partial,
  };
}

// ─── Normalizadores ────────────────────────────────────────────────────
console.log("\n1. normalizeCatalogString:");
{
  eq(normalizeCatalogString("Ibuprofeno"), "ibuprofeno", "lowercase básico");
  eq(normalizeCatalogString("  Ibuprofeno  "), "ibuprofeno", "trim");
  eq(normalizeCatalogString("Ibu  profeno"), "ibu profeno", "colapsa whitespace múltiplo");
  eq(normalizeCatalogString(null), null, "null → null");
  eq(normalizeCatalogString(undefined), null, "undefined → null");
  eq(normalizeCatalogString(""), null, "string vazia → null");
  eq(normalizeCatalogString("   "), null, "só whitespace → null");
}

console.log("\n2. normalizeDosagem:");
{
  eq(normalizeDosagem("10 mg"), "10mg", "remove espaços");
  eq(normalizeDosagem("10mg"), "10mg", "idempotente");
  eq(normalizeDosagem("10 MG"), "10mg", "lowercase");
  eq(normalizeDosagem("10mg + 5mg"), "10mg+5mg", "expressão composta");
  eq(normalizeDosagem("100 µg/dose"), "100µg/dose", "µ preservado");
  eq(normalizeDosagem(null), null, "null → null");
  eq(normalizeDosagem(""), null, "string vazia → null");
  // Diferenças intencionais — não normalizamos unidades
  assert(normalizeDosagem("10mg") !== normalizeDosagem("10g"), "mg ≠ g (intencional)");
  assert(normalizeDosagem("10mg") !== normalizeDosagem("10mcg"), "mg ≠ mcg (intencional)");
}

console.log("\n3. atc5:");
{
  eq(atc5("M01AE01"), "M01AE", "primeiros 5 chars");
  eq(atc5("a10bb02"), "A10BB", "uppercase");
  eq(atc5("  A10BB02  "), "A10BB", "trim");
  eq(atc5("A10B"), null, "comprimento < 5 → null");
  eq(atc5(""), null, "string vazia → null");
  eq(atc5(null), null, "null → null");
  eq(atc5(undefined), null, "undefined → null");
}

// ─── Detector — happy path ─────────────────────────────────────────────
console.log("\n4. Happy path — par DCI-equivalente com CNPs diferentes:");
{
  const input: DciSubstitutionInput[] = [
    // Destino: ruptura (low cov)
    row({
      produtoId: "p_destino",
      farmaciaId: "fA",
      farmaciaNome: "Farmacia A",
      cnp: "1111111",
      designacao: "Ibuprofeno A 400mg",
      stockAtual: 5,
      salesQty: 90, // 1/dia em 90d
      puc: 2.0,
    }),
    // Source: excesso (high cov)
    row({
      produtoId: "p_source",
      farmaciaId: "fB",
      farmaciaNome: "Farmacia B",
      cnp: "2222222",
      designacao: "Ibuprofeno B 400mg",
      stockAtual: 100,
      salesQty: 90,
      puc: 1.5,
    }),
  ];
  const r = findDciEquivalentSubstitutions(input);
  eq(r.candidates.length, 1, "1 candidato");
  if (r.candidates.length === 1) {
    const c = r.candidates[0];
    eq(c.destinoCnp, "1111111", "destino CNP=1111111");
    eq(c.sourceCnp, "2222222", "source CNP=2222222");
    assert(c.transferableQty > 0, `transferableQty > 0 (got ${c.transferableQty})`);
    assert(c.avoidedPurchaseEstimate > 0, `avoidedPurchase > 0 (got ${c.avoidedPurchaseEstimate})`);
    // destino puc=2.0 deve ser usado (não 1.5 de source)
    assert(c.avoidedPurchaseEstimate === c.transferableQty * 2.0, "usa destino.puc para € evitável");
  }
  eq(r.rejectionCounts.forma_diferente, 0, "sem rejeição forma");
}

// ─── 5. Pré-filtro productType ─────────────────────────────────────────
console.log("\n5. Pré-filtro: productType !== MEDICAMENTO:");
{
  const input: DciSubstitutionInput[] = [
    row({ produtoId: "p1", farmaciaId: "fA", productType: "DERMOCOSMETICA" }),
    row({ produtoId: "p2", farmaciaId: "fB", productType: "DERMOCOSMETICA" }),
  ];
  const r = findDciEquivalentSubstitutions(input);
  eq(r.candidates.length, 0, "0 candidatos quando productType ≠ MEDICAMENTO");
  eq(r.rejectionCounts.productType_nao_medicamento, 2, "2 rows pré-filtrados");
  eq(r.rowsConsidered, 0, "0 considerados");
}

console.log("\n5b. requireMedicamento=false aceita não-MEDICAMENTO:");
{
  const input: DciSubstitutionInput[] = [
    row({ produtoId: "p1", farmaciaId: "fA", productType: "DERMOCOSMETICA", salesQty: 90, stockAtual: 5 }),
    row({ produtoId: "p2", farmaciaId: "fB", productType: "DERMOCOSMETICA", salesQty: 90, stockAtual: 100, cnp: "9999" }),
  ];
  const r = findDciEquivalentSubstitutions(input, { requireMedicamento: false });
  eq(r.candidates.length, 1, "1 candidato com requireMedicamento=false");
  eq(r.rejectionCounts.productType_nao_medicamento, 0, "0 rejeições productType");
}

// ─── 6. Pré-filtro DCI ausente ─────────────────────────────────────────
console.log("\n6. Pré-filtro: DCI ausente:");
{
  const input: DciSubstitutionInput[] = [
    row({ produtoId: "p1", farmaciaId: "fA", dci: null }),
    row({ produtoId: "p2", farmaciaId: "fB", dci: "" }),
    row({ produtoId: "p3", farmaciaId: "fC", dci: "   " }),
  ];
  const r = findDciEquivalentSubstitutions(input);
  eq(r.rejectionCounts.dci_ausente, 3, "3 rows com DCI null/vazia pré-filtrados");
  eq(r.rowsConsidered, 0, "0 considerados");
}

// ─── 7. Gate: forma diferente ──────────────────────────────────────────
console.log("\n7. Gate: formaFarmaceutica diferente:");
{
  const input: DciSubstitutionInput[] = [
    row({ produtoId: "p1", farmaciaId: "fA", stockAtual: 5, salesQty: 90, formaFarmaceutica: "comprimido" }),
    row({ produtoId: "p2", farmaciaId: "fB", stockAtual: 100, salesQty: 90, formaFarmaceutica: "xarope", cnp: "9999" }),
  ];
  const r = findDciEquivalentSubstitutions(input);
  eq(r.candidates.length, 0, "0 candidatos");
  eq(r.rejectionCounts.forma_diferente, 1, "1 rejeição por forma_diferente");
}

// ─── 8. Gate: dosagem diferente ────────────────────────────────────────
console.log("\n8. Gate: dosagem diferente:");
{
  const input: DciSubstitutionInput[] = [
    row({ produtoId: "p1", farmaciaId: "fA", stockAtual: 5, salesQty: 90, dosagem: "400mg" }),
    row({ produtoId: "p2", farmaciaId: "fB", stockAtual: 100, salesQty: 90, dosagem: "600mg", cnp: "9999" }),
  ];
  const r = findDciEquivalentSubstitutions(input);
  eq(r.candidates.length, 0, "0 candidatos");
  eq(r.rejectionCounts.dosagem_diferente, 1, "1 rejeição por dosagem_diferente");
}

console.log("\n8b. Gate dosagem: '10 mg' === '10mg' (normalizado):");
{
  const input: DciSubstitutionInput[] = [
    row({ produtoId: "p1", farmaciaId: "fA", stockAtual: 5, salesQty: 90, dosagem: "10 mg" }),
    row({ produtoId: "p2", farmaciaId: "fB", stockAtual: 100, salesQty: 90, dosagem: "10mg", cnp: "9999" }),
  ];
  const r = findDciEquivalentSubstitutions(input);
  eq(r.candidates.length, 1, "1 candidato (normalizado)");
  eq(r.rejectionCounts.dosagem_diferente, 0, "sem rejeição dosagem");
}

// ─── 9. Gate: ATC diferente ────────────────────────────────────────────
console.log("\n9. Gate: ATC5 diferente:");
{
  const input: DciSubstitutionInput[] = [
    row({ produtoId: "p1", farmaciaId: "fA", stockAtual: 5, salesQty: 90, codigoATC: "M01AE01" }),
    row({ produtoId: "p2", farmaciaId: "fB", stockAtual: 100, salesQty: 90, codigoATC: "N02BE01", cnp: "9999" }),
  ];
  const r = findDciEquivalentSubstitutions(input);
  eq(r.candidates.length, 0, "0 candidatos");
  eq(r.rejectionCounts.atc_diferente, 1, "1 rejeição por atc_diferente");
}

console.log("\n9b. Gate ATC5: 'M01AE01' === 'M01AE99' (mesmo nível 5):");
{
  const input: DciSubstitutionInput[] = [
    row({ produtoId: "p1", farmaciaId: "fA", stockAtual: 5, salesQty: 90, codigoATC: "M01AE01" }),
    row({ produtoId: "p2", farmaciaId: "fB", stockAtual: 100, salesQty: 90, codigoATC: "M01AE99", cnp: "9999" }),
  ];
  const r = findDciEquivalentSubstitutions(input);
  eq(r.candidates.length, 1, "1 candidato (mesmo ATC5)");
  eq(r.rejectionCounts.atc_diferente, 0, "sem rejeição ATC");
}

// ─── 10. Gate: MSRM/MNSRM divergente ───────────────────────────────────
console.log("\n10. Gate: MSRM/MNSRM divergente:");
{
  const input: DciSubstitutionInput[] = [
    row({ produtoId: "p1", farmaciaId: "fA", stockAtual: 5, salesQty: 90, flagMSRM: true, flagMNSRM: false }),
    row({ produtoId: "p2", farmaciaId: "fB", stockAtual: 100, salesQty: 90, flagMSRM: false, flagMNSRM: true, cnp: "9999" }),
  ];
  const r = findDciEquivalentSubstitutions(input);
  eq(r.candidates.length, 0, "0 candidatos");
  eq(r.rejectionCounts.msrm_divergente, 1, "1 rejeição por msrm_divergente");
}

// ─── 11. Mesma farmácia não é candidato ────────────────────────────────
console.log("\n11. Mesma farmácia source/destino:");
{
  const input: DciSubstitutionInput[] = [
    row({ produtoId: "p1", farmaciaId: "fA", stockAtual: 5, salesQty: 90 }),
    row({ produtoId: "p2", farmaciaId: "fA", stockAtual: 100, salesQty: 90, cnp: "9999" }),
  ];
  const r = findDciEquivalentSubstitutions(input);
  eq(r.candidates.length, 0, "0 candidatos quando mesma farmácia");
  eq(r.rejectionCounts.mesma_farmacia, 1, "1 rejeição por mesma_farmacia");
}

// ─── 12. Destino sem demanda → ignorado (não conta como ruptura) ──────
console.log("\n12. Destino sem demanda não é candidato:");
{
  const input: DciSubstitutionInput[] = [
    row({ produtoId: "p1", farmaciaId: "fA", stockAtual: 5, salesQty: 0 }),
    row({ produtoId: "p2", farmaciaId: "fB", stockAtual: 100, salesQty: 90, cnp: "9999" }),
  ];
  const r = findDciEquivalentSubstitutions(input);
  eq(r.candidates.length, 0, "0 candidatos");
  // Nesta implementação, destino sem demanda nunca é considerado ruptura
  // (filtro coverage<threshold && avgDaily>0). Não emitimos contagem
  // explícita aqui — o teste só confirma que não há candidatos.
}

// ─── 13. Ordenação desc por € evitável ─────────────────────────────────
console.log("\n13. Ordenação desc por € evitável:");
{
  const input: DciSubstitutionInput[] = [
    // Par 1: € evitável pequeno
    row({ produtoId: "p1a", farmaciaId: "fA", stockAtual: 5, salesQty: 90, puc: 1.0, dci: "ibuprofeno" }),
    row({ produtoId: "p1b", farmaciaId: "fB", stockAtual: 100, salesQty: 90, puc: 1.0, dci: "ibuprofeno", cnp: "9999" }),
    // Par 2: € evitável grande
    row({
      produtoId: "p2a", farmaciaId: "fA", stockAtual: 5, salesQty: 90, puc: 100.0,
      dci: "dapagliflozina", codigoATC: "A10BK01", cnp: "5000", designacao: "Forxiga"
    }),
    row({
      produtoId: "p2b", farmaciaId: "fB", stockAtual: 100, salesQty: 90, puc: 100.0,
      dci: "dapagliflozina", codigoATC: "A10BK01", cnp: "5001", designacao: "Edistride"
    }),
  ];
  const r = findDciEquivalentSubstitutions(input);
  eq(r.candidates.length, 2, "2 candidatos");
  if (r.candidates.length >= 2) {
    assert(
      r.candidates[0].avoidedPurchaseEstimate > r.candidates[1].avoidedPurchaseEstimate,
      "primeiro tem mais € evitável que segundo",
    );
    eq(r.candidates[0].dci, "dapagliflozina", "primeiro é dapagliflozina");
  }
}

// ─── 14. Qty insuficiente (transferableQty=0) ──────────────────────────
console.log("\n14. Qty insuficiente — minTransferableQty=10:");
{
  const input: DciSubstitutionInput[] = [
    row({ produtoId: "p1", farmaciaId: "fA", stockAtual: 5, salesQty: 90 }),
    // Source: stockAtual=50, salesQty=90 → avgDaily=1, coverage=50d (>30 excess threshold).
    // reserve = 14*1 = 14; sourceExcess = 50-14 = 36.
    // destino: stock=5, avgDaily=1, coverage=5d; destinoNeed = (15-5)*1 = 10.
    // transferableQty = floor(min(36, 10)) = 10 — passa minQty=10, falha minQty=20.
    row({ produtoId: "p2", farmaciaId: "fB", stockAtual: 50, salesQty: 90, cnp: "9999" }),
  ];
  const r10 = findDciEquivalentSubstitutions(input, { minTransferableQty: 10 });
  eq(r10.candidates.length, 1, "1 candidato com minQty=10");

  const r20 = findDciEquivalentSubstitutions(input, { minTransferableQty: 20 });
  eq(r20.candidates.length, 0, "0 candidatos com minQty=20");
  eq(r20.rejectionCounts.qty_insuficiente, 1, "rejeição qty_insuficiente=1");
}

// ─── 15. Multi-source: escolhe maior cobertura ─────────────────────────
console.log("\n15. Multi-source escolhe o de maior cobertura:");
{
  const input: DciSubstitutionInput[] = [
    row({ produtoId: "p1", farmaciaId: "fA", stockAtual: 5, salesQty: 90 }), // destino
    row({ produtoId: "p2", farmaciaId: "fB", stockAtual: 60, salesQty: 90, cnp: "B" }), // cov ~60d
    row({ produtoId: "p3", farmaciaId: "fC", stockAtual: 180, salesQty: 90, cnp: "C" }), // cov ~180d
  ];
  const r = findDciEquivalentSubstitutions(input);
  eq(r.candidates.length, 1, "1 candidato (1 destino)");
  if (r.candidates.length === 1) {
    eq(r.candidates[0].sourceFarmaciaId, "fC", "source com maior cobertura (fC)");
  }
}

// ─── 16. Pre-filter contadores não se confundem com pair-level ─────────
console.log("\n16. Contadores: pré-filtro vs pair-level são separados:");
{
  const input: DciSubstitutionInput[] = [
    // Pré-filtro: 1 row sem DCI
    row({ produtoId: "x1", farmaciaId: "fX", dci: null }),
    // Pair com forma diferente: 2 rows
    row({ produtoId: "p1", farmaciaId: "fA", stockAtual: 5, salesQty: 90, formaFarmaceutica: "comprimido", dci: "metformina" }),
    row({ produtoId: "p2", farmaciaId: "fB", stockAtual: 100, salesQty: 90, formaFarmaceutica: "xarope", dci: "metformina", cnp: "9999" }),
  ];
  const r = findDciEquivalentSubstitutions(input);
  eq(r.rejectionCounts.dci_ausente, 1, "pré-filtro dci_ausente=1");
  eq(r.rejectionCounts.forma_diferente, 1, "pair forma_diferente=1");
  eq(r.rowsConsidered, 2, "rowsConsidered=2 (excluiu o dci=null)");
}

// ─── Sumário ──────────────────────────────────────────────────────────
console.log("\n" + "─".repeat(78));
if (errors.length === 0) {
  console.log(`✅ dci-equivalent-substitution: todos os testes passaram`);
  process.exit(0);
} else {
  console.error(`❌ dci-equivalent-substitution: ${errors.length} testes falharam`);
  for (const e of errors) console.error(`  · ${e}`);
  process.exit(1);
}
