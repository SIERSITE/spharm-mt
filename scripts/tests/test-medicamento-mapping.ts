/**
 * scripts/tests/test-medicamento-mapping.ts
 *
 * Regressão para o canonical mapping específico de MEDICAMENTOS — garante
 * que o pipeline NÃO cai genericamente em "Outros Medicamentos" quando o
 * ATC, o DCI ou a designação têm sinal suficiente para um nivel2 mais
 * específico (Maio 2026).
 *
 * Cenários cobertos:
 *  · ATC L2 (3-char prefix) — N02 → Analgésicos, R06 → Alergias,
 *    C07/C08/C09/C10 → Cardiovascular, A10 → Diabetes, D08 → Antisséticos,
 *    G04 → Urológicos, S02 → Otológicos.
 *  · DCI/keyword — ibuprofeno, paracetamol, cetirizina, nebivolol,
 *    apixabano (B01 → Cardiovascular).
 *  · Fallback "Outros Medicamentos" só ocorre quando nem ATC, nem DCI,
 *    nem keyword têm match.
 *
 * Sem rede, sem BD, sem Prisma — só lógica pura (mapToCanonical).
 *
 * Correr:
 *   npx tsx scripts/tests/test-medicamento-mapping.ts
 */

import "dotenv/config";
import { mapToCanonical } from "../../lib/catalog-taxonomy-map";
import { isValidNivel1, isValidNivel2 } from "../../lib/catalog-taxonomy";

const errors: string[] = [];

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    errors.push(msg);
    console.error(`  ✗ ${msg}`);
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

type Case = {
  label: string;
  designacao: string;
  atc: string | null;
  dci: string | null;
  expect: {
    nivel1: string;
    nivel2: string;
    /** Se true, este caso DEVE NOT cair em "Outros Medicamentos". */
    notOthersFallback: true;
    /** Método esperado (ou prefixo aceitável). */
    methodAnyOf?: Array<"atc" | "atc_prefix" | "dci" | "keyword" | "external_category_hint" | "product_type_only" | "others_fallback">;
  };
};

const CASES: Case[] = [
  // ── M01 — Anti-inflamatórios não esteróides ──────────────────────────
  {
    label: "Brufen / ibuprofeno / M01AE01 → Analgésicos e Anti-inflamatórios",
    designacao: "BRUFEN 600MG COMPRIMIDOS",
    atc: "M01AE01",
    dci: "ibuprofeno",
    expect: {
      nivel1: "MEDICAMENTOS",
      nivel2: "Analgésicos e Anti-inflamatórios",
      notOthersFallback: true,
      methodAnyOf: ["atc_prefix", "dci", "keyword"],
    },
  },
  {
    label: "Voltaren / diclofenac / M01AB05 → Analgésicos e Anti-inflamatórios",
    designacao: "VOLTAREN 50MG COMPRIMIDOS",
    atc: "M01AB05",
    dci: "diclofenac",
    expect: {
      nivel1: "MEDICAMENTOS",
      nivel2: "Analgésicos e Anti-inflamatórios",
      notOthersFallback: true,
      methodAnyOf: ["atc_prefix", "dci", "keyword"],
    },
  },

  // ── N02 — Analgésicos (paracetamol, opióides) ────────────────────────
  // Caso crítico: a letra N → "Sistema Nervoso" no fallback antigo.
  // Tem de cair em Analgésicos pelo prefixo N02.
  {
    label: "Ben-u-ron / paracetamol / N02BE01 → Analgésicos e Anti-inflamatórios (não Sistema Nervoso)",
    designacao: "BEN-U-RON 500MG COMPRIMIDOS",
    atc: "N02BE01",
    dci: "paracetamol",
    expect: {
      nivel1: "MEDICAMENTOS",
      nivel2: "Analgésicos e Anti-inflamatórios",
      notOthersFallback: true,
      methodAnyOf: ["atc_prefix", "dci", "keyword"],
    },
  },

  // ── N03/N05/N06 — Sistema Nervoso (devem manter) ─────────────────────
  {
    label: "Sertralina / N06AB06 → Sistema Nervoso (antidepressivo)",
    designacao: "SERTRALINA 50MG COMPRIMIDOS",
    atc: "N06AB06",
    dci: "sertralina",
    expect: {
      nivel1: "MEDICAMENTOS",
      nivel2: "Sistema Nervoso",
      notOthersFallback: true,
      methodAnyOf: ["atc_prefix", "keyword", "dci"],
    },
  },

  // ── C07-C10 — Cardiovascular ────────────────────────────────────────
  {
    label: "Nebilet / nebivolol / C07AB12 → Cardiovascular",
    designacao: "NEBILET 5MG COMPRIMIDOS",
    atc: "C07AB12",
    dci: "nebivolol",
    expect: {
      nivel1: "MEDICAMENTOS",
      nivel2: "Cardiovascular",
      notOthersFallback: true,
      methodAnyOf: ["atc_prefix", "dci", "keyword"],
    },
  },
  {
    label: "Atorvastatina / C10AA05 → Cardiovascular",
    designacao: "ATORVASTATINA 20MG COMPRIMIDOS",
    atc: "C10AA05",
    dci: "atorvastatina",
    expect: {
      nivel1: "MEDICAMENTOS",
      nivel2: "Cardiovascular",
      notOthersFallback: true,
      methodAnyOf: ["atc_prefix", "dci", "keyword"],
    },
  },
  {
    label: "Losartan / C09CA01 → Cardiovascular",
    designacao: "LOSARTAN 50MG COMPRIMIDOS",
    atc: "C09CA01",
    dci: "losartan",
    expect: {
      nivel1: "MEDICAMENTOS",
      nivel2: "Cardiovascular",
      notOthersFallback: true,
      methodAnyOf: ["atc_prefix", "dci", "keyword"],
    },
  },

  // ── R06 — Anti-histamínicos / Alergias ───────────────────────────────
  // Caso crítico: a letra R → "Respiratório" no fallback antigo.
  // R06 deve mapear especificamente para Alergias.
  {
    label: "Zyrtec / cetirizina / R06AE07 → Alergias (não Respiratório)",
    designacao: "ZYRTEC 10MG COMPRIMIDOS",
    atc: "R06AE07",
    dci: "cetirizina",
    expect: {
      nivel1: "MEDICAMENTOS",
      nivel2: "Alergias",
      notOthersFallback: true,
      methodAnyOf: ["atc_prefix", "dci", "keyword"],
    },
  },
  {
    label: "Loratadina / R06AX13 → Alergias",
    designacao: "LORATADINA 10MG COMPRIMIDOS",
    atc: "R06AX13",
    dci: "loratadina",
    expect: {
      nivel1: "MEDICAMENTOS",
      nivel2: "Alergias",
      notOthersFallback: true,
      methodAnyOf: ["atc_prefix", "dci", "keyword"],
    },
  },

  // ── R03 — Asma/DPOC (Respiratório) ──────────────────────────────────
  {
    label: "Salbutamol / R03AC02 → Respiratório",
    designacao: "SALBUTAMOL INALADOR",
    atc: "R03AC02",
    dci: "salbutamol",
    expect: {
      nivel1: "MEDICAMENTOS",
      nivel2: "Respiratório",
      notOthersFallback: true,
      methodAnyOf: ["atc_prefix", "keyword", "dci"],
    },
  },

  // ── J01 — Antibióticos sistémicos ────────────────────────────────────
  // Não há nivel2 "Antibióticos" na taxonomia; J01 mapeia para
  // "Outros Medicamentos" via ATC_PREFIX_TO_NIVEL2 (não fallback).
  // Verifica que o método é atc_prefix (decisão explícita), não
  // others_fallback (catch-all). Caso especial: este teste aceita
  // "Outros Medicamentos" porque a taxonomia não tem categoria melhor.
  {
    label: "Amoxicilina + clavulânico / J01CR02 → Outros Medicamentos (sem cat antibióticos na taxonomia, mas via atc_prefix explícito)",
    designacao: "AUGMENTIN 875+125MG COMPRIMIDOS",
    atc: "J01CR02",
    dci: "amoxicilina + ácido clavulânico",
    expect: {
      nivel1: "MEDICAMENTOS",
      nivel2: "Outros Medicamentos",
      notOthersFallback: true, // método deve ser atc_prefix, NÃO others_fallback
      methodAnyOf: ["atc_prefix"],
    },
  },

  // ── B01 — Antitrombóticos / anticoagulantes ──────────────────────────
  {
    label: "Eliquis / apixabano / B01AF02 → Cardiovascular (B01 mapeia explicitamente para CV)",
    designacao: "ELIQUIS 5MG COMPRIMIDOS",
    atc: "B01AF02",
    dci: "apixabano",
    expect: {
      nivel1: "MEDICAMENTOS",
      nivel2: "Cardiovascular",
      notOthersFallback: true,
      methodAnyOf: ["atc_prefix"],
    },
  },

  // ── A10 — Diabetes ──────────────────────────────────────────────────
  {
    label: "Metformina / A10BA02 → Diabetes",
    designacao: "METFORMINA 500MG COMPRIMIDOS",
    atc: "A10BA02",
    dci: "metformina",
    expect: {
      nivel1: "MEDICAMENTOS",
      nivel2: "Diabetes",
      notOthersFallback: true,
      methodAnyOf: ["atc_prefix", "dci", "keyword"],
    },
  },

  // ── A02/A06 — Sistema Digestivo ─────────────────────────────────────
  {
    label: "Omeprazol / A02BC01 → Sistema Digestivo",
    designacao: "OMEPRAZOL 20MG CAPSULAS",
    atc: "A02BC01",
    dci: "omeprazol",
    expect: {
      nivel1: "MEDICAMENTOS",
      nivel2: "Sistema Digestivo",
      notOthersFallback: true,
      methodAnyOf: ["atc_prefix", "dci", "keyword"],
    },
  },

  // ── D — Dermatológicos / D08 — Antisséticos ──────────────────────────
  {
    label: "Clorhexidina / D08AC02 → Antisséticos e Desinfetantes",
    designacao: "CLORHEXIDINA SOLUCAO 2%",
    atc: "D08AC02",
    dci: "clorhexidina",
    expect: {
      nivel1: "MEDICAMENTOS",
      nivel2: "Antisséticos e Desinfetantes",
      notOthersFallback: true,
      methodAnyOf: ["atc_prefix", "keyword"],
    },
  },
  {
    label: "Hidrocortisona tópica / D07AA02 → Dermatológicos",
    designacao: "HIDROCORTISONA CREME 1%",
    atc: "D07AA02",
    dci: "hidrocortisona",
    expect: {
      nivel1: "MEDICAMENTOS",
      nivel2: "Dermatológicos",
      notOthersFallback: true,
      methodAnyOf: ["atc_prefix", "keyword"],
    },
  },

  // ── G — Genito-urinário ──────────────────────────────────────────────
  {
    label: "Tansulosina / G04CA02 → Urológicos (G04 ≠ G01-G03)",
    designacao: "TANSULOSINA 0,4MG CAPSULAS",
    atc: "G04CA02",
    dci: "tansulosina",
    expect: {
      nivel1: "MEDICAMENTOS",
      nivel2: "Urológicos",
      notOthersFallback: true,
      methodAnyOf: ["atc_prefix", "keyword"],
    },
  },

  // ── S — Sensoriais ──────────────────────────────────────────────────
  {
    label: "S02 — Otológicos (não cair em Oftálmicos via letra S)",
    designacao: "OTOFA GOTAS AURICULARES",
    atc: "S02AA",
    dci: null,
    expect: {
      nivel1: "MEDICAMENTOS",
      nivel2: "Otológicos",
      notOthersFallback: true,
      methodAnyOf: ["atc_prefix", "keyword"],
    },
  },

  // ── DCI sem ATC — fallback via keyword ───────────────────────────────
  // Não temos ATC mas a designação contém o DCI; deve resolver via keyword.
  {
    label: "Ibuprofeno SEM ATC mas com keyword → Analgésicos via keyword/dci",
    designacao: "IBUPROFENO GENERICO 400MG",
    atc: null,
    dci: "ibuprofeno",
    expect: {
      nivel1: "MEDICAMENTOS",
      nivel2: "Analgésicos e Anti-inflamatórios",
      notOthersFallback: true,
      methodAnyOf: ["dci", "keyword"],
    },
  },

  // ── Caso de fallback legítimo — sem nenhum sinal específico ──────────
  {
    label: "Medicamento sem ATC, sem DCI, sem keyword → Outros Medicamentos legítimo",
    designacao: "MEDICAMENTO XPTO",
    atc: null,
    dci: null,
    expect: {
      nivel1: "MEDICAMENTOS",
      nivel2: "Outros Medicamentos",
      // ESTE caso é o único legítimo de others_fallback. Documenta que
      // o assert "notOthersFallback: true" não é universal — depende do
      // que o caso testa. Aqui marcamos `notOthersFallback: true` =
      // FALSE… mas para manter o type uniforme, removemos o assert e
      // só verificamos via methodAnyOf.
      notOthersFallback: true, // placeholder; a verificação real é methodAnyOf
      methodAnyOf: ["others_fallback"],
    },
  },
];

function runCase(c: Case): void {
  console.log(`\n${c.label}`);

  const mapped = mapToCanonical({
    productType: "MEDICAMENTO",
    productTypeConfidence: 0.99, // simula flagMSRM/flagMNSRM/ATC presente
    externalCategory: null,
    externalSubcategory: null,
    designacao: c.designacao,
    atc: c.atc,
    dci: c.dci,
  });

  console.log(
    `    mapped: ${mapped ? `${mapped.nivel1} / ${mapped.nivel2} ` +
      `(conf ${mapped.confidence.toFixed(2)}, method=${mapped.method})` : "null"}`
  );
  if (mapped) console.log(`    reason: ${mapped.reason}`);

  assert(mapped !== null, "mapper deve devolver não-null");
  if (!mapped) return;

  // Sanidade taxonómica
  assert(isValidNivel1(mapped.nivel1), `nivel1 "${mapped.nivel1}" é canónico`);
  assert(
    isValidNivel2(mapped.nivel1, mapped.nivel2),
    `nivel2 "${mapped.nivel2}" é filho válido de "${mapped.nivel1}"`
  );

  // Resultado esperado
  assert(
    mapped.nivel1 === c.expect.nivel1,
    `nivel1 = "${c.expect.nivel1}" (got "${mapped.nivel1}")`
  );
  assert(
    mapped.nivel2 === c.expect.nivel2,
    `nivel2 = "${c.expect.nivel2}" (got "${mapped.nivel2}")`
  );

  // Método
  if (c.expect.methodAnyOf) {
    assert(
      c.expect.methodAnyOf.includes(mapped.method),
      `method ∈ {${c.expect.methodAnyOf.join("|")}} (got "${mapped.method}")`
    );
  }
}

async function main(): Promise<void> {
  console.log("─".repeat(70));
  console.log(`Regressão MEDICAMENTOS — ${CASES.length} cenários`);
  console.log("─".repeat(70));

  for (const c of CASES) runCase(c);

  console.log("\n" + "─".repeat(70));
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
