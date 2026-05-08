/**
 * scripts/tests/test-infomed-detail-fetcher.ts
 *
 * Sanity test do fetcher `infarmed-detail-page`. Faz fetch de 3 med_guids
 * conhecidos e valida que o parser extrai os campos esperados.
 *
 * NÃO usa rate limit — 3 requests pontuais. Em produção, o caller (worker)
 * tem de impor o rate limit.
 *
 * Correr:
 *   npx tsx scripts/tests/test-infomed-detail-fetcher.ts
 *   npx tsx scripts/tests/test-infomed-detail-fetcher.ts --offline (apenas parse-test fixtures)
 */

import "dotenv/config";
import {
  fetchInfomedDetail,
  extractAtcCode,
  type InfomedDetailResult,
} from "../../lib/regulatory-sources/infarmed-detail-page";

const errors: string[] = [];
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    errors.push(msg);
    console.error(`  ✗ ${msg}`);
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

// 3 med_guids descobertos via search Google indexing pages (read-only).
// Combodart já validado no relatório Phase 1. Os outros 2 são produtos
// reais e a validação em vivo confirmará.
type Case = {
  label: string;
  medGuid: string;
  expect: {
    designacaoIncludes?: RegExp;
    dciIncludes?: RegExp;
    atcStartsWith?: string;
    formaIncludes?: RegExp;
    /** Se definido, exige pelo menos N CNPs na lista de embalagens. */
    minEmbalagens?: number;
    /** Se true, exige que generico seja false (Sim ou Não — não null). */
    genericoNotNull?: boolean;
    /** Se definido, exige que classificacaoDispensa seja MSRM ou MNSRM. */
    expectMsrmOrMnsrm?: boolean;
  };
};

const CASES: Case[] = [
  {
    label: "Combodart (Dutasterida + Tansulosina) — já validado em Phase 1",
    medGuid: "278995306d9c11e280efcb9ada231b5b",
    expect: {
      designacaoIncludes: /Combodart/i,
      dciIncludes: /Dutasterida.*Tansulosina|Tansulosina.*Dutasterida/i,
      atcStartsWith: "G04CA52",
      formaIncludes: /C[aá]psula/i,
      minEmbalagens: 1,
      genericoNotNull: true,
      expectMsrmOrMnsrm: true,
    },
  },
  {
    label: "Med #2 — guid 8d1009b06d6111e2bad3a03a774f6ce0 (sondagem)",
    medGuid: "8d1009b06d6111e2bad3a03a774f6ce0",
    expect: {
      // Não sabemos qual é — apenas validamos que parse não falha
      // e que extrai *algum* campo principal.
      minEmbalagens: 0, // pode ser 0 — apenas confirma que parse não throw
    },
  },
  {
    label: "Colchicine — guid af6ee5106d5e11e2bf7bcd28ba6e743b",
    medGuid: "af6ee5106d5e11e2bf7bcd28ba6e743b",
    expect: {
      // Nota: a designacaoOficial é o nome do medicamento ("Colchicine"),
      // não a DCI ("Colquicina"). Validar ambos os campos correctamente.
      designacaoIncludes: /Colchicine/i,
      dciIncludes: /Colquicina/i,
      atcStartsWith: "M04AC01",
      minEmbalagens: 1,
    },
  },
];

async function runCase(c: Case): Promise<InfomedDetailResult | null> {
  console.log(`\n${"─".repeat(70)}`);
  console.log(c.label);
  console.log("─".repeat(70));
  let result: InfomedDetailResult;
  try {
    result = await fetchInfomedDetail(c.medGuid);
  } catch (err) {
    errors.push(`${c.label}: fetch failed — ${err instanceof Error ? err.message : String(err)}`);
    console.error(`  ✗ fetch falhou: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  console.log(`  fetched ${result.raw.htmlBytes} bytes`);
  console.log(`  designacaoOficial:    ${result.designacaoOficial}`);
  console.log(`  dci:                  ${result.dci ?? "—"}`);
  console.log(`  codigoATC:            ${result.codigoATC ?? "—"}  (todos: [${result.codigosAtcAll.join(", ")}])`);
  console.log(`  formaFarmaceutica:    ${result.formaFarmaceutica ?? "—"}`);
  console.log(`  dosagem:              ${result.dosagem ?? "—"}`);
  console.log(`  titularAim:           ${result.titularAim ?? "—"}`);
  console.log(`  estadoAim:            ${result.estadoAim ?? "—"}`);
  console.log(`  grupoTerapeutico:     ${result.grupoTerapeutico ?? "—"}`);
  console.log(`  numeroProcesso:       ${result.numeroProcesso ?? "—"}`);
  console.log(`  generico:             ${result.generico === null ? "—" : result.generico ? "Sim" : "Não"}`);
  console.log(`  classificacaoDispensa:${result.classificacaoDispensa ?? "—"}`);
  console.log(`  viasAdministracao:    [${result.viasAdministracao.join(", ")}]`);
  console.log(`  embalagens (${result.embalagens.length}):`);
  for (const e of result.embalagens) {
    console.log(`    cnp=${e.cnp}  ${e.descricao ?? "—"}  [${e.comercializacao ?? "—"}]`);
  }

  // Asserts
  if (c.expect.designacaoIncludes) {
    assert(
      c.expect.designacaoIncludes.test(result.designacaoOficial),
      `designacao casa ${c.expect.designacaoIncludes}`,
    );
  }
  if (c.expect.dciIncludes) {
    assert(
      result.dci !== null && c.expect.dciIncludes.test(result.dci),
      `dci casa ${c.expect.dciIncludes} (got ${JSON.stringify(result.dci)})`,
    );
  }
  if (c.expect.atcStartsWith) {
    assert(
      !!result.codigoATC && result.codigoATC.startsWith(c.expect.atcStartsWith),
      `codigoATC começa por ${c.expect.atcStartsWith} (got ${JSON.stringify(result.codigoATC)})`,
    );
  }
  if (c.expect.formaIncludes) {
    assert(
      result.formaFarmaceutica !== null && c.expect.formaIncludes.test(result.formaFarmaceutica),
      `formaFarmaceutica casa ${c.expect.formaIncludes}`,
    );
  }
  if (c.expect.minEmbalagens !== undefined) {
    assert(
      result.embalagens.length >= c.expect.minEmbalagens,
      `>= ${c.expect.minEmbalagens} embalagens (got ${result.embalagens.length})`,
    );
  }
  if (c.expect.genericoNotNull) {
    assert(result.generico !== null, `generico não-null`);
  }
  if (c.expect.expectMsrmOrMnsrm) {
    assert(
      result.classificacaoDispensa === "MSRM" || result.classificacaoDispensa === "MNSRM",
      `classificacaoDispensa ∈ {MSRM, MNSRM} (got ${JSON.stringify(result.classificacaoDispensa)})`,
    );
  }
  return result;
}

// ─── Pure parser tests (sem rede) ─────────────────────────────────────────────

function runPureParserTests(): void {
  console.log(`\n${"═".repeat(70)}`);
  console.log("Pure parser tests (extractAtcCode)");
  console.log("═".repeat(70));

  const cases: Array<[string, string | null]> = [
    ["G04CA52 - tamsulosin and dutasteride", "G04CA52"],
    ["N02BE01 - paracetamol", "N02BE01"],
    ["R06AE07 - cetirizine", "R06AE07"],
    ["M01AE01", "M01AE01"],
    ["M01", "M01"],
    ["M", "M"],
    ["", null],
    ["123 - garbage", null],
    [" J01CR02 - amoxicillin and beta-lactamase inhibitor ", "J01CR02"],
    ["A10BA02 metformin", "A10BA02"],
  ];

  for (const [input, expected] of cases) {
    const got = extractAtcCode(input);
    assert(
      got === expected,
      `extractAtcCode(${JSON.stringify(input)}) = ${JSON.stringify(expected)} (got ${JSON.stringify(got)})`,
    );
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("═".repeat(70));
  console.log(`Infomed Detail Fetcher — sanity test (${CASES.length} casos)`);
  console.log("═".repeat(70));

  runPureParserTests();

  for (const c of CASES) {
    await runCase(c);
    // Rate limit defensivo entre casos (1.5s)
    await new Promise((r) => setTimeout(r, 1500));
  }

  console.log("\n" + "═".repeat(70));
  if (errors.length === 0) {
    console.log("OK — todos os asserts passaram.");
  } else {
    console.error(`FAIL — ${errors.length} assert(s) falharam:`);
    for (const e of errors) console.error(`  · ${e}`);
  }
}

main()
  .catch((err) => {
    console.error("[erro fatal]", err);
    errors.push(`erro fatal: ${err instanceof Error ? err.message : String(err)}`);
  })
  .finally(() => {
    process.exitCode = errors.length === 0 ? 0 : 1;
  });
