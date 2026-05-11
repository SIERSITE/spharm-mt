/**
 * scripts/tests/test-ipf-freshness.ts
 *
 * Testes puros para `analyzeFreshness` de `lib/operational/ipf-freshness`.
 * Sem rede, sem BD — só lógica determinística sobre snapshot + thresholds.
 *
 * Correr:
 *   npx tsx scripts/tests/test-ipf-freshness.ts
 */

import { analyzeFreshness } from "../../lib/operational/ipf-freshness";

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

const NOW = new Date("2026-05-11T14:00:00Z");

// ─── 1. Healthy: cobertura completa, freshness OK ──────────────────────────
console.log("\n1. healthy completo:");
{
  const f = analyzeFreshness(
    {
      totalIpfRows: 22016,
      totalPfRows: 22016,
      maxDataCalculo: new Date("2026-05-11T13:00:00Z"), // 1h atrás
      minDataCalculo: new Date("2026-05-11T13:00:00Z"),
    },
    {},
    NOW,
  );
  eq(f.healthy, true, "healthy=true");
  eq(f.isStale, false, "isStale=false");
  eq(f.isLowCoverage, false, "isLowCoverage=false");
  eq(f.coverage, 1, "coverage=1 (100%)");
  eq(f.missingRows, 0, "missingRows=0");
  assert(f.ageHours !== null && Math.abs(f.ageHours - 1) < 0.01, `ageHours≈1 (got ${f.ageHours})`);
  eq(f.reasons.length, 0, "sem reasons");
}

// ─── 2. Stale: dataCalculo antiga ──────────────────────────────────────────
console.log("\n2. stale por idade:");
{
  const f = analyzeFreshness(
    {
      totalIpfRows: 22016,
      totalPfRows: 22016,
      maxDataCalculo: new Date("2026-05-10T08:00:00Z"), // 30h atrás
      minDataCalculo: new Date("2026-05-10T08:00:00Z"),
    },
    {},
    NOW,
  );
  eq(f.healthy, false, "healthy=false");
  eq(f.isStale, true, "isStale=true");
  eq(f.isLowCoverage, false, "isLowCoverage=false (cobertura está OK)");
  assert(f.ageHours !== null && f.ageHours > 26, `ageHours > 26 (got ${f.ageHours})`);
  eq(f.reasons.length, 1, "1 reason");
  assert(f.reasons[0]!.includes("stale"), `reason menciona stale (got "${f.reasons[0]}")`);
}

// ─── 3. Low coverage: muitos PFs novos sem IPF ─────────────────────────────
console.log("\n3. low coverage:");
{
  const f = analyzeFreshness(
    {
      totalIpfRows: 20000,
      totalPfRows: 22016,
      maxDataCalculo: new Date("2026-05-11T13:00:00Z"), // 1h atrás
      minDataCalculo: new Date("2026-05-11T13:00:00Z"),
    },
    {},
    NOW,
  );
  eq(f.healthy, false, "healthy=false");
  eq(f.isStale, false, "isStale=false (idade OK)");
  eq(f.isLowCoverage, true, "isLowCoverage=true");
  eq(f.missingRows, 2016, "missingRows=2016");
  assert(Math.abs(f.coverage - 20000 / 22016) < 0.0001, `coverage ≈ 90.8%`);
  eq(f.reasons.length, 1, "1 reason");
  assert(f.reasons[0]!.includes("coverage"), `reason menciona coverage`);
}

// ─── 4. Tudo mau: stale + low coverage ─────────────────────────────────────
console.log("\n4. stale + low coverage:");
{
  const f = analyzeFreshness(
    {
      totalIpfRows: 15000,
      totalPfRows: 22016,
      maxDataCalculo: new Date("2026-05-09T10:00:00Z"), // ~52h atrás
      minDataCalculo: new Date("2026-05-09T10:00:00Z"),
    },
    {},
    NOW,
  );
  eq(f.healthy, false, "healthy=false");
  eq(f.isStale, true, "isStale=true");
  eq(f.isLowCoverage, true, "isLowCoverage=true");
  eq(f.reasons.length, 2, "2 reasons");
}

// ─── 5. IPF completamente vazia ────────────────────────────────────────────
console.log("\n5. IPF vazia (nunca populada):");
{
  const f = analyzeFreshness(
    {
      totalIpfRows: 0,
      totalPfRows: 22016,
      maxDataCalculo: null,
      minDataCalculo: null,
    },
    {},
    NOW,
  );
  eq(f.healthy, false, "healthy=false");
  eq(f.isStale, true, "isStale=true (sem dataCalculo)");
  eq(f.isLowCoverage, true, "isLowCoverage=true");
  eq(f.ageHours, null, "ageHours=null");
  eq(f.coverage, 0, "coverage=0");
  assert(f.reasons.some((r) => r.includes("vazia")), "reason menciona 'vazia'");
}

// ─── 6. Edge: sem PFs (database limpo) ─────────────────────────────────────
console.log("\n6. sem ProdutoFarmacia (caso teórico):");
{
  const f = analyzeFreshness(
    {
      totalIpfRows: 0,
      totalPfRows: 0,
      maxDataCalculo: null,
      minDataCalculo: null,
    },
    {},
    NOW,
  );
  eq(f.coverage, 1, "coverage=1 (não há nada a cobrir, trivialmente OK)");
  eq(f.isLowCoverage, false, "isLowCoverage=false");
  // Ainda stale porque maxDataCalculo é null
  eq(f.isStale, true, "isStale=true (sem dataCalculo, mesmo com PFs=0)");
  eq(f.healthy, false, "healthy=false");
}

// ─── 7. Custom thresholds ──────────────────────────────────────────────────
console.log("\n7. custom thresholds:");
{
  const f = analyzeFreshness(
    {
      totalIpfRows: 21500,
      totalPfRows: 22016,
      maxDataCalculo: new Date("2026-05-11T08:00:00Z"), // 6h atrás
      minDataCalculo: new Date("2026-05-11T08:00:00Z"),
    },
    { thresholdHours: 4, thresholdCoverage: 0.99 },
    NOW,
  );
  eq(f.thresholdHours, 4, "thresholdHours=4");
  eq(f.thresholdCoverage, 0.99, "thresholdCoverage=0.99");
  eq(f.isStale, true, "stale com threshold mais apertado");
  eq(f.isLowCoverage, true, "low-coverage com threshold mais apertado");
  eq(f.healthy, false, "healthy=false");
}

// ─── 8. Edge: ageHours exactamente no threshold ────────────────────────────
console.log("\n8. ageHours == threshold (não é stale):");
{
  const f = analyzeFreshness(
    {
      totalIpfRows: 100,
      totalPfRows: 100,
      maxDataCalculo: new Date(NOW.getTime() - 26 * 3_600_000),
      minDataCalculo: new Date(NOW.getTime() - 26 * 3_600_000),
    },
    {},
    NOW,
  );
  eq(f.isStale, false, "ageHours=26 == threshold=26 (não estritamente >) → não stale");
  eq(f.healthy, true, "healthy");
}

// ─── 9. Edge: ageHours mínimo (data futura) ────────────────────────────────
console.log("\n9. ageHours não vai negativo:");
{
  const f = analyzeFreshness(
    {
      totalIpfRows: 100,
      totalPfRows: 100,
      maxDataCalculo: new Date(NOW.getTime() + 3_600_000), // 1h no futuro
      minDataCalculo: new Date(NOW.getTime() + 3_600_000),
    },
    {},
    NOW,
  );
  eq(f.ageHours, 0, "ageHours clamped a 0 (não negativo)");
  eq(f.isStale, false, "não stale");
}

// ─── 10. Coverage cap: mais IPF rows do que PFs ────────────────────────────
console.log("\n10. coverage > 100% (rows IPF antigos vs PFs vivos):");
{
  const f = analyzeFreshness(
    {
      totalIpfRows: 25000,
      totalPfRows: 22016,
      maxDataCalculo: new Date(NOW.getTime() - 3_600_000),
      minDataCalculo: new Date(NOW.getTime() - 3_600_000),
    },
    {},
    NOW,
  );
  assert(f.coverage > 1, `coverage > 1 permitido (got ${f.coverage.toFixed(3)})`);
  eq(f.missingRows, 0, "missingRows=0 (não negativo)");
  eq(f.isLowCoverage, false, "coverage acima do threshold");
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
