/**
 * scripts/tests/test-encomendas-substitution.ts
 *
 * Testes para o matching same-CNP usado pelas encomendas. A lógica
 * subjacente é `findInternalSubstitutions` (já com 22 testes próprios),
 * portanto aqui foco específico:
 *   1. Thresholds adaptados a encomendas (rupture<15, excess>30)
 *      produzem matches onde a versão default de transferências (rupture<7)
 *      não produziria.
 *   2. Map por destino key `${produtoId}:${destinoFarmaciaId}` é a
 *      assinatura de lookup correcta para juntar com EncomendaBaseRow.
 *   3. Quando destino e source pertencem à mesma farmácia, nunca é
 *      candidato.
 *   4. Fallback seguro: input sem demanda mensurável não produz
 *      candidatos (avgDaily=0 elimina destino).
 *
 * Sem rede, sem BD.
 *
 * Correr: npx tsx scripts/tests/test-encomendas-substitution.ts
 */

import {
  findInternalSubstitutions,
  type SubstitutionInput,
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

function row(p: Partial<SubstitutionInput> & { farmaciaId: string }): SubstitutionInput {
  const base: SubstitutionInput = {
    produtoId: "p1",
    farmaciaId: p.farmaciaId,
    farmaciaNome: p.farmaciaNome ?? `F-${p.farmaciaId}`,
    cnp: "1234567",
    designacao: "Produto X",
    stockAtual: 0,
    puc: 2.0,
    salesQty: 0,
  };
  return { ...base, ...p };
}

// ─── 1. Threshold encomenda apanha caso que default de transferências NÃO apanha
console.log("\n1. threshold encomenda (rupture<15) vs default (rupture<7):");
{
  // Destino: stock=10, vendas 90d=90 (1/dia) → cov=10d. Rupture=10 < 15 mas > 7.
  // Origem: stock=100, vendas 90d=90 (1/dia) → cov=100d (excesso).
  const input: SubstitutionInput[] = [
    row({ farmaciaId: "destino", stockAtual: 10, salesQty: 90 }),
    row({ farmaciaId: "origem", stockAtual: 100, salesQty: 90 }),
  ];
  const withEncomendaOpts = findInternalSubstitutions(input, ENCOMENDA_OPTS);
  const withDefaultOpts = findInternalSubstitutions(input, {});
  eq(withEncomendaOpts.length, 1, "thresholds encomenda → 1 candidato");
  eq(withDefaultOpts.length, 0, "thresholds default (rupture<7) → 0 candidatos");
}

// ─── 2. Key de lookup: ${produtoId}:${destinoFarmaciaId}
console.log("\n2. key produtoId:destinoFarmaciaId compatível com EncomendaBaseRow:");
{
  const input: SubstitutionInput[] = [
    row({ produtoId: "pA", farmaciaId: "fA", stockAtual: 5, salesQty: 90 }),
    row({ produtoId: "pA", farmaciaId: "fB", stockAtual: 100, salesQty: 90 }),
    row({ produtoId: "pB", farmaciaId: "fA", stockAtual: 100, salesQty: 90 }),
    row({ produtoId: "pB", farmaciaId: "fB", stockAtual: 5, salesQty: 90 }),
  ];
  const subs = findInternalSubstitutions(input, ENCOMENDA_OPTS);
  // Esperamos 2 candidatos: (pA, fA destino), (pB, fB destino)
  eq(subs.length, 2, "2 candidatos cruzados");
  const byKey = new Map(subs.map((s) => [`${s.produtoId}:${s.destinoFarmaciaId}`, s]));
  assert(byKey.has("pA:fA"), "lookup pA:fA existe");
  assert(byKey.has("pB:fB"), "lookup pB:fB existe");
  assert(!byKey.has("pA:fB"), "pA:fB NÃO é destino (é origem)");
  assert(!byKey.has("pB:fA"), "pB:fA NÃO é destino (é origem)");
}

// ─── 3. Mesma farmácia nunca conta (encomenda usa stock próprio, não transfere)
console.log("\n3. mesma farmácia não é candidata:");
{
  const input: SubstitutionInput[] = [
    row({ farmaciaId: "fA", stockAtual: 5, salesQty: 90 }),
    // sem outra farmácia — não há para onde transferir
  ];
  const subs = findInternalSubstitutions(input, ENCOMENDA_OPTS);
  eq(subs.length, 0, "sem peer farm → 0 candidatos");
}

// ─── 4. Avgdaily=0 (sem demanda) elimina destino — não há nada a evitar
console.log("\n4. destino sem demanda não produz candidato:");
{
  const input: SubstitutionInput[] = [
    // Destino sem vendas (avgDaily=0); aplicaria sugestão zero na encomenda
    row({ farmaciaId: "destino", stockAtual: 5, salesQty: 0 }),
    row({ farmaciaId: "origem", stockAtual: 100, salesQty: 90 }),
  ];
  const subs = findInternalSubstitutions(input, ENCOMENDA_OPTS);
  eq(subs.length, 0, "destino avgDaily=0 → 0 candidatos");
}

// ─── 5. Transferable cap pelo reserve do source
console.log("\n5. reserve do source limita transferableQty:");
{
  // Source: stock=20, cov=20d. Com reserve=14d (e avgDaily=1), sourceExcess = 20 - 14 = 6.
  // Destino: stock=5, cov=5d. Com target=15 (avgDaily=1), destinoNeed = (15-5) = 10.
  // → transferableQty = min(6, 10) = 6.
  const input: SubstitutionInput[] = [
    row({ farmaciaId: "destino", stockAtual: 5, salesQty: 90 }),
    row({ farmaciaId: "origem", stockAtual: 20, salesQty: 90 }),
  ];
  // Force excess=15 para incluir a origem no scope
  const subs = findInternalSubstitutions(input, {
    ...ENCOMENDA_OPTS,
    excessThresholdDays: 15,
  });
  eq(subs.length, 1, "1 candidato");
  // exact qty depende de aritmética; aceita ±1 por arredondamento
  assert(
    subs[0]!.transferableQty >= 5 && subs[0]!.transferableQty <= 7,
    `transferableQty cap em 5-7 (got ${subs[0]!.transferableQty})`,
  );
}

// ─── 6. avoidedPurchaseEstimate calcula com puc destino
console.log("\n6. avoidedPurchaseEstimate em € usa puc destino:");
{
  const input: SubstitutionInput[] = [
    row({ farmaciaId: "destino", stockAtual: 5, salesQty: 90, puc: 3.5 }),
    row({ farmaciaId: "origem", stockAtual: 100, salesQty: 90, puc: 4.0 }),
  ];
  const subs = findInternalSubstitutions(input, ENCOMENDA_OPTS);
  eq(subs.length, 1, "1 candidato");
  const c = subs[0]!;
  eq(
    c.avoidedPurchaseEstimate,
    c.transferableQty * 3.5,
    `avoidedPurchaseEstimate = qty(${c.transferableQty}) × pucDestino(3.5)`,
  );
}

// ─── 7. Ordenação: maior poupança vem primeiro (matches o filter UI)
console.log("\n7. ordenação descendente por € poupados:");
{
  const input: SubstitutionInput[] = [
    // Par 1: poupança baixa (€ 6 × 1)
    row({ produtoId: "p1", farmaciaId: "fA", stockAtual: 5, salesQty: 90, puc: 1.0 }),
    row({ produtoId: "p1", farmaciaId: "fB", stockAtual: 100, salesQty: 90, puc: 1.0 }),
    // Par 2: poupança alta (€ 6 × 100)
    row({ produtoId: "p2", farmaciaId: "fA", stockAtual: 100, salesQty: 90, puc: 100.0 }),
    row({ produtoId: "p2", farmaciaId: "fB", stockAtual: 5, salesQty: 90, puc: 100.0 }),
  ];
  const subs = findInternalSubstitutions(input, ENCOMENDA_OPTS);
  eq(subs.length, 2, "2 candidatos");
  assert(
    subs[0]!.avoidedPurchaseEstimate >= subs[1]!.avoidedPurchaseEstimate,
    `ordenado desc — got [${subs[0]!.avoidedPurchaseEstimate}, ${subs[1]!.avoidedPurchaseEstimate}]`,
  );
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
