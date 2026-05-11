/**
 * scripts/tests/test-internal-substitution.ts
 *
 * Testes puros para `lib/transfers/internal-substitution.ts`. Sem rede,
 * sem BD. Cobre os cenários da Fase 1 WS-C:
 *   · ruptura no destino + excesso same-CNP noutra farmácia
 *   · sem candidatos (mesma farmácia, ou sem excesso)
 *   · múltiplas origens — escolhe a com maior cobertura
 *   · respeita reserveDaysSource (não cria nova ruptura na origem)
 *   · transferableQty < minTransferableQty é descartado
 *   · avoidedPurchaseEstimate usa puc do destino (ou source fallback)
 *
 * Correr:
 *   npx tsx scripts/tests/test-internal-substitution.ts
 */

import {
  findInternalSubstitutions,
  type SubstitutionInput,
  type SubstitutionOptions,
} from "../../lib/transfers/internal-substitution";

const errors: string[] = [];

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    errors.push(msg);
    console.error(`  ✗ ${msg}`);
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

function row(partial: Partial<SubstitutionInput> & { farmaciaId: string }): SubstitutionInput {
  const base: SubstitutionInput = {
    produtoId: "p1",
    farmaciaId: partial.farmaciaId,
    farmaciaNome: partial.farmaciaNome ?? `F-${partial.farmaciaId}`,
    cnp: "1234567",
    designacao: "Produto A",
    stockAtual: 0,
    puc: 1.0,
    salesQty: 0,
  };
  return { ...base, ...partial };
}

// ─── 1. Caso base: ruptura + excesso same-CNP ──────────────────────────────
console.log("\n1. caso base:");
{
  const candidates = findInternalSubstitutions(
    [
      // Destino: stock=5, vendas 90d = 270 (3/dia) → coverage = 5/3 ≈ 1.67d (< 7d)
      row({ farmaciaId: "fA", stockAtual: 5, salesQty: 270, puc: 4.5 }),
      // Origem: stock=100, vendas 90d = 90 (1/dia) → coverage = 100d (> 30d)
      row({ farmaciaId: "fB", stockAtual: 100, salesQty: 90, puc: 4.0 }),
    ],
    {},
  );
  assert(candidates.length === 1, `produz 1 candidato (got ${candidates.length})`);
  const c = candidates[0]!;
  assert(c.destinoFarmaciaId === "fA", "destino = fA");
  assert(c.suggestedSourceFarmaciaId === "fB", "origem = fB");
  assert(c.transferableQty > 0, `transferableQty > 0 (got ${c.transferableQty})`);
  // sourceExcess = 100 - 14*1 = 86; destinoNeed = (15-1.67)*3 = 40 → floor(40) = 39 ou 40
  assert(c.transferableQty >= 39 && c.transferableQty <= 41, `transferableQty ≈ 39-41 (got ${c.transferableQty})`);
  assert(c.avoidedPurchaseEstimate === c.transferableQty * 4.5, `avoidedPurchaseEstimate = qty × puc_destino`);
}

// ─── 2. Sem candidato quando não há excesso ────────────────────────────────
console.log("\n2. sem excesso noutra farmácia:");
{
  const candidates = findInternalSubstitutions(
    [
      row({ farmaciaId: "fA", stockAtual: 5, salesQty: 270 }),
      // Origem com cobertura baixa (sem excesso)
      row({ farmaciaId: "fB", stockAtual: 20, salesQty: 90 }), // cov=20 < 30
    ],
    {},
  );
  assert(candidates.length === 0, "sem candidato (origem não tem excesso suficiente)");
}

// ─── 3. Múltiplas origens — escolhe a com maior cobertura ──────────────────
console.log("\n3. múltiplas origens:");
{
  const candidates = findInternalSubstitutions(
    [
      row({ farmaciaId: "fA", stockAtual: 5, salesQty: 270 }),
      // fB: stock=50, cov=50d
      row({ farmaciaId: "fB", stockAtual: 50, salesQty: 90 }),
      // fC: stock=200, cov=200d (mais excesso)
      row({ farmaciaId: "fC", stockAtual: 200, salesQty: 90 }),
    ],
    {},
  );
  assert(candidates.length === 1, "1 candidato");
  assert(
    candidates[0]!.suggestedSourceFarmaciaId === "fC",
    `origem é fC (maior cobertura), got ${candidates[0]!.suggestedSourceFarmaciaId}`,
  );
}

// ─── 4. Respeita reserveDaysSource (não cria nova ruptura) ─────────────────
console.log("\n4. reserveDaysSource respeitado:");
{
  // Origem com stock=20, avg=1/dia → cov=20d (acima do excessThreshold default 30? NO — 20 < 30).
  // Vamos forçar com options custom para garantir que entra no path mas a reserve corta.
  const candidates = findInternalSubstitutions(
    [
      // Destino em ruptura
      row({ farmaciaId: "fA", stockAtual: 0, salesQty: 270 }),
      // Origem: stock=20, avg=1/dia → cov=20d. Com excessThreshold=15, entra.
      row({ farmaciaId: "fB", stockAtual: 20, salesQty: 90 }),
    ],
    {
      excessThresholdDays: 15,
      reserveDaysSource: 18, // reserva 18d × 1 = 18 unidades; sourceExcess = max(0, 20-18) = 2
    },
  );
  assert(candidates.length === 1, "1 candidato com reserve customizada");
  assert(candidates[0]!.transferableQty <= 2, `transferableQty cap pelo source reserve (got ${candidates[0]!.transferableQty})`);
}

// ─── 5. Sem candidato quando transferableQty < minTransferableQty ──────────
console.log("\n5. minTransferableQty:");
{
  const candidates = findInternalSubstitutions(
    [
      row({ farmaciaId: "fA", stockAtual: 0, salesQty: 90 }),  // ruptura
      row({ farmaciaId: "fB", stockAtual: 20, salesQty: 90 }), // cov=20d
    ],
    {
      excessThresholdDays: 15,
      reserveDaysSource: 19, // sourceExcess = 20-19 = 1
      minTransferableQty: 5,  // mas precisa de 5
    },
  );
  assert(candidates.length === 0, "descartado quando qty < min");
}

// ─── 6. Destino sem demanda mensurável (avgDaily=0) → fora de scope ────────
console.log("\n6. destino sem demanda:");
{
  const candidates = findInternalSubstitutions(
    [
      // Destino: stock=0, salesQty=0 → coverage=0, mas avgDaily=0 → out of scope
      // (não há sinal para projectar ruptura iminente).
      row({ farmaciaId: "fA", stockAtual: 0, salesQty: 0 }),
      row({ farmaciaId: "fB", stockAtual: 100, salesQty: 90 }),
    ],
    {},
  );
  assert(candidates.length === 0, "destino sem demanda mensurável não gera candidato");
}

// ─── 7. avoidedPurchaseEstimate fallback puc da origem ────────────────────
console.log("\n7. puc fallback:");
{
  const candidates = findInternalSubstitutions(
    [
      row({ farmaciaId: "fA", stockAtual: 5, salesQty: 270, puc: null }), // destino sem puc
      row({ farmaciaId: "fB", stockAtual: 100, salesQty: 90, puc: 3.5 }),
    ],
    {},
  );
  assert(candidates.length === 1, "1 candidato");
  const c = candidates[0]!;
  assert(c.avoidedPurchaseEstimate === c.transferableQty * 3.5, "usa puc da origem quando destino é null");
}

// ─── 8. avoidedPurchaseEstimate = 0 quando puc null em ambos ──────────────
console.log("\n8. puc null em ambos:");
{
  const candidates = findInternalSubstitutions(
    [
      row({ farmaciaId: "fA", stockAtual: 5, salesQty: 270, puc: null }),
      row({ farmaciaId: "fB", stockAtual: 100, salesQty: 90, puc: null }),
    ],
    {},
  );
  assert(candidates.length === 1, "1 candidato");
  assert(candidates[0]!.avoidedPurchaseEstimate === 0, "estimativa = 0 € quando custo desconhecido");
}

// ─── 9. Ordenação por € poupados (desc) ───────────────────────────────────
console.log("\n9. ordenação:");
{
  const input: SubstitutionInput[] = [
    // Par 1: destino fA1 + origem fB1, transferableQty maior, custo mais baixo
    row({ produtoId: "p1", farmaciaId: "fA1", stockAtual: 5, salesQty: 270, cnp: "1", puc: 1.0 }),
    row({ produtoId: "p1", farmaciaId: "fB1", stockAtual: 100, salesQty: 90, cnp: "1", puc: 1.0 }),
    // Par 2: destino fA2 + origem fB2, transferableQty menor, custo muito mais alto
    row({ produtoId: "p2", farmaciaId: "fA2", stockAtual: 0, salesQty: 30, cnp: "2", puc: 50.0 }),
    row({ produtoId: "p2", farmaciaId: "fB2", stockAtual: 60, salesQty: 30, cnp: "2", puc: 50.0 }),
  ];
  const candidates = findInternalSubstitutions(input, {});
  assert(candidates.length === 2, `2 candidatos (got ${candidates.length})`);
  // O mais valioso deve vir primeiro
  assert(
    candidates[0]!.avoidedPurchaseEstimate >= candidates[1]!.avoidedPurchaseEstimate,
    `ordenado por avoidedPurchaseEstimate desc — got [${candidates[0]!.avoidedPurchaseEstimate}, ${candidates[1]!.avoidedPurchaseEstimate}]`,
  );
}

// ─── 10. Origem na mesma farmácia não conta (não há transferência) ────────
console.log("\n10. origem ≠ destino farmácia:");
{
  const candidates = findInternalSubstitutions(
    [
      // Único produto, só uma farmácia (não há para onde mover)
      row({ farmaciaId: "fA", stockAtual: 5, salesQty: 270 }),
    ],
    {},
  );
  assert(candidates.length === 0, "uma única farmácia → sem transferência possível");
}

// ─── Resultado ─────────────────────────────────────────────────────────────

console.log("\n" + "─".repeat(60));
if (errors.length === 0) {
  console.log(`✅ Todos os testes passaram.`);
  process.exit(0);
} else {
  console.error(`❌ ${errors.length} falhas:`);
  for (const e of errors) console.error("   - " + e);
  process.exit(1);
}
