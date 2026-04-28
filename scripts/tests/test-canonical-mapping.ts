/**
 * scripts/tests/test-canonical-mapping.ts
 *
 * Regressão dos cinco cenários do canonical mapping que estavam a
 * devolver `null` na corrida de produção e que o utilizador pediu para
 * fixar (Abril 2026).
 *
 * Cada cenário tem:
 *  · um productType (saída do classifier interno),
 *  · um par (rawCategory, rawProductName) representativo,
 *  · um conjunto de assertivas sobre:
 *      - inferProductTypeFromExternal (resolver) — o tipo deve ser
 *        upgraded quando productType=OUTRO,
 *      - mapToCanonical (mapper) — deve devolver um par real (≠ null,
 *        sem categorias técnicas).
 *
 * Sem rede, sem BD, sem Prisma — só lógica pura.
 *
 * Correr:
 *   npx tsx scripts/tests/test-canonical-mapping.ts
 */

import "dotenv/config";
import { mapToCanonical } from "../../lib/catalog-taxonomy-map";
import { __resolverInternals } from "../../lib/catalog-resolution-engine";
import type { ExternalSourceData, ProductType } from "../../lib/catalog-types";

const errors: string[] = [];

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    errors.push(msg);
    console.error(`  ✗ ${msg}`);
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

function buildRetailSource(
  rawCategory: string | null,
  rawProductName: string | null,
  rawBrand: string | null = null
): ExternalSourceData {
  return {
    source: "retail_pharmacy",
    tier: "RETAIL",
    matchedBy: "cnp",
    confidence: 0.85,
    fabricante: null,
    principioAtivo: null,
    atc: null,
    dosagem: null,
    embalagem: null,
    formaFarmaceutica: null,
    categoria: rawCategory,
    subcategoria: null,
    imagemUrl: null,
    notes: null,
    rawBrand,
    rawCategory,
    rawProductName,
  };
}

type Case = {
  label: string;
  productType: ProductType;
  productTypeConfidence: number;
  rawCategory: string | null;
  rawProductName: string | null;
  designacao: string;
  expect: {
    /** ProductType after resolver inference; null = no upgrade expected */
    inferredType?: ProductType | null;
    /** Mapper must NOT return null */
    mapperNonNull: true;
    /** Mapper canonical nivel1 must match this regex (case-insensitive) */
    nivel1Matches: RegExp;
    /** Mapper canonical nivel2 must match this regex (case-insensitive) */
    nivel2Matches?: RegExp;
    /** Method must NOT be technical/transitória (não existe mais — sanity) */
    methodNotTechnical?: true;
  };
};

const CASES: Case[] = [
  {
    label: "1. MEDICAMENTO sem extCat (sem ATC) → fallback Outros Medicamentos",
    productType: "MEDICAMENTO",
    productTypeConfidence: 0.99, // flagMSRM strong
    rawCategory: null,
    rawProductName: null,
    designacao: "Algum medicamento sem nome reconhecível",
    expect: {
      mapperNonNull: true,
      nivel1Matches: /^MEDICAMENTOS$/,
      nivel2Matches: /Outros\s+Medicamentos|Outros/i,
    },
  },
  {
    label: "2. HIGIENE_CUIDADO + 'Mamã, Bebé e Criança > A-Derma Exomega Gel Banho'",
    productType: "HIGIENE_CUIDADO",
    productTypeConfidence: 0.65,
    rawCategory: "Mamã, Bebé e Criança > A-Derma Exomega Gel Banho Calmante 200ml",
    rawProductName: "A-Derma Exomega Gel Banho Calmante 200ml",
    designacao: "A-DERMA EXOMEGA GEL BANHO CALM 200ML",
    expect: {
      mapperNonNull: true,
      // Aceita PUERICULTURA E BEBÉ (preferível por extCat) ou HIGIENE CORPORAL
      nivel1Matches: /PUERICULTURA E BEB[ÉE]|HIGIENE CORPORAL/,
      // Higiene do Bebé / Banho e Duche / Pele Atópica do Bebé
      nivel2Matches: /Higiene\s+do\s+Beb[éE]|Banho\s+e\s+Duche|Pele\s+At[oóOÓ]pica\s+do\s+Beb[éE]|Outros/i,
    },
  },
  {
    label: "3. OUTRO + 'Saúde Oral > Escovas de dentes elétricas > Escova Eléctrica'",
    productType: "OUTRO",
    productTypeConfidence: 0.30,
    rawCategory: "Saúde Oral > Escovas de dentes elétricas > Escova Eléctrica E Recargas Para Adultos",
    rawProductName: "Escova Eléctrica Para Adultos",
    designacao: "ESCOVA ELECT ADULTO",
    expect: {
      inferredType: "HIGIENE_CUIDADO",
      mapperNonNull: true,
      nivel1Matches: /HIGIENE ORAL/,
      nivel2Matches: /Escovas\s+de\s+Dentes/i,
    },
  },
  {
    label: "4. OUTRO + 'Dermis > Saúde e bem-estar > Advancis Cápsulas Hepa'",
    productType: "OUTRO",
    productTypeConfidence: 0.30,
    rawCategory: "Dermis > Saúde e bem-estar > Advancis Cápsulas Hepa x 60 comprimidos",
    rawProductName: "Advancis Cápsulas Hepa x 60 comprimidos",
    designacao: "ADVANCIS HEPA CAPS X60",
    expect: {
      inferredType: "SUPLEMENTO",
      mapperNonNull: true,
      nivel1Matches: /SUPLEMENTOS\s+ALIMENTARES/,
      // Digestão e Probióticos via /hepa/ keyword, ou Outros Suplementos
      nivel2Matches: /Digest[aãAÃ]o\s+e\s+Probi[oó]ticos|Outros/i,
    },
  },
  {
    label: "5. OUTRO + 'Estimulantes e Energizantes > Advancis Agellai Vitacell'",
    productType: "OUTRO",
    productTypeConfidence: 0.30,
    rawCategory: "Estimulantes e Energizantes > Advancis Agellai Vitacell (x30 cápsulas)",
    rawProductName: "Advancis Agellai Vitacell (x30 cápsulas)",
    designacao: "ADVANCIS AGELLAI VITACELL X30",
    expect: {
      inferredType: "SUPLEMENTO",
      mapperNonNull: true,
      nivel1Matches: /SUPLEMENTOS\s+ALIMENTARES/,
      nivel2Matches: /Energia\s+e\s+Vitalidade|Outros/i,
    },
  },
  {
    label: "6. MEDICAMENTO + 'INDICE.eu > Medicamentos > AGIOLAX'",
    productType: "MEDICAMENTO",
    productTypeConfidence: 0.95,
    rawCategory: "INDICE.eu > Medicamentos > AGIOLAX",
    rawProductName: "AGIOLAX",
    designacao: "AGIOLAX GRANULADO",
    expect: {
      mapperNonNull: true,
      nivel1Matches: /^MEDICAMENTOS$/,
      // Sistema Digestivo via /agiolax|laxant/, ou Outros Medicamentos por
      // fallback (ambos aceites — user explícito).
      nivel2Matches: /Sistema\s+Digestivo|Outros\s+Medicamentos/i,
    },
  },
  {
    label: "7. OUTRO + 'Saúde > Advancis Easylax Forte Comprimidos'",
    productType: "OUTRO",
    productTypeConfidence: 0.30,
    rawCategory: "Saúde > Advancis Easylax Forte Comprimidos",
    rawProductName: "Advancis Easylax Forte Comprimidos",
    designacao: "ADVANCIS EASYLAX FORTE COMP",
    expect: {
      inferredType: "SUPLEMENTO",
      mapperNonNull: true,
      nivel1Matches: /SUPLEMENTOS\s+ALIMENTARES/,
      nivel2Matches: /Digest[aãAÃ]o\s+e\s+Probi[oó]ticos|Outros/i,
    },
  },
  {
    label: "8. OUTRO + 'Circulação e Pernas Cansadas > Advancis Hemo Duo'",
    productType: "OUTRO",
    productTypeConfidence: 0.30,
    rawCategory: "Circulação e Pernas Cansadas > Advancis Hemo Duo",
    rawProductName: "Advancis Hemo Duo",
    designacao: "ADVANCIS HEMO DUO",
    expect: {
      inferredType: "SUPLEMENTO",
      mapperNonNull: true,
      nivel1Matches: /SUPLEMENTOS\s+ALIMENTARES/,
      nivel2Matches: /Outros|Energia\s+e\s+Vitalidade/i,
    },
  },

  // ── Pattern A: Suplementos por breadcrumb categórico
  {
    label: "9. (A) OUTRO + 'Ansiedade, Stress e Distúrbios Sono > Aquilea OnBalance Relax'",
    productType: "OUTRO",
    productTypeConfidence: 0.30,
    rawCategory: "Ansiedade, Stress e Distúrbios Sono > Aquilea OnBalance Relax Gomas Frutos Bosque (x60 gomas)",
    rawProductName: "Aquilea OnBalance Relax Gomas Frutos Bosque (x60 gomas)",
    designacao: "AQUILEA ONBALANCE RELAX GOMAS FB X60",
    expect: {
      inferredType: "SUPLEMENTO",
      mapperNonNull: true,
      nivel1Matches: /SUPLEMENTOS\s+ALIMENTARES/,
      nivel2Matches: /Sono\s+e\s+Relaxamento/i,
    },
  },
  {
    label: "10. (A) OUTRO + 'Trato Digestivo e/ou Trato Intestinal > Aquilea Digest'",
    productType: "OUTRO",
    productTypeConfidence: 0.30,
    rawCategory: "Trato Digestivo e/ou Trato Intestinal > Aquilea Digest Total Camomila (x24 sticks)",
    rawProductName: "Aquilea Digest Total Camomila (x24 sticks)",
    designacao: "AQUILEA DIGEST TOTAL STICKS X24",
    expect: {
      inferredType: "SUPLEMENTO",
      mapperNonNull: true,
      nivel1Matches: /SUPLEMENTOS\s+ALIMENTARES/,
      nivel2Matches: /Digest[aãAÃ]o\s+e\s+Probi[oó]ticos/i,
    },
  },
  {
    label: "11. (A) OUTRO + 'Sistema Cardiovascular e Colesterol > Arterin'",
    productType: "OUTRO",
    productTypeConfidence: 0.30,
    rawCategory: "Sistema Cardiovascular e Colesterol > Arterin Levedura Arroz Vermelho (x180 comprimidos)",
    rawProductName: "Arterin Levedura Arroz Vermelho",
    designacao: "ARTERIN LEVEDURA ARROZ X180",
    expect: {
      inferredType: "SUPLEMENTO",
      mapperNonNull: true,
      nivel1Matches: /SUPLEMENTOS\s+ALIMENTARES/,
      nivel2Matches: /Outros|Energia/i, // sem "Cardiovascular" N2 na taxonomia
    },
  },
  {
    label: "12. (A) OUTRO + 'Saúde Feminina e Menopausa > Afax (x30 capsulas)'",
    productType: "OUTRO",
    productTypeConfidence: 0.30,
    rawCategory: "Saúde Feminina e Menopausa > Afax (x30 capsulas)",
    rawProductName: "Afax (x30 capsulas)",
    designacao: "AFAX CAPS X30",
    expect: {
      inferredType: "SUPLEMENTO",
      mapperNonNull: true,
      nivel1Matches: /SUPLEMENTOS\s+ALIMENTARES/,
      nivel2Matches: /Sa[uú]de\s+[ÍI]ntima/i,
    },
  },

  // ── Pattern D: Material clínico / Dispositivos médicos
  {
    label: "13. (D) OUTRO + 'Pensos e Material de Desinfeção > Água Destilada'",
    productType: "OUTRO",
    productTypeConfidence: 0.30,
    rawCategory: "Pensos e Material de Desinfeção > Ecotainer Agua Destilada - 1L",
    rawProductName: "Ecotainer Agua Destilada - 1L",
    designacao: "AGUA DESTILADA AG DEST 1 L",
    expect: {
      inferredType: "DISPOSITIVO_MEDICO",
      mapperNonNull: true,
      nivel1Matches: /MATERIAL\s+CL[ÍI]NICO|DISPOSITIVOS\s+M[ÉE]DICOS/i,
      nivel2Matches: /Consum[ií]veis\s+Cl[ií]nicos|Outros/i,
    },
  },
  {
    label: "14. (D) OUTRO + 'Ascencia Contour Next' (tiras glicemia)",
    productType: "OUTRO",
    productTypeConfidence: 0.30,
    rawCategory: null,
    rawProductName: "ASCENCIA/CONTOUR NEXT/REF.84191389 50 N.D.",
    designacao: "ASCENCIA CONTOUR NEXT 50",
    expect: {
      inferredType: "DISPOSITIVO_MEDICO",
      mapperNonNull: true,
      nivel1Matches: /DISPOSITIVOS\s+M[ÉE]DICOS/,
      nivel2Matches: /Glicemia\s+e\s+Diabetes/i,
    },
  },
  {
    label: "15. (D) OUTRO + 'Aposan Teste Gravidez'",
    productType: "OUTRO",
    productTypeConfidence: 0.30,
    rawCategory: "Sexualidade > Testes de Ovulação e Gravidez",
    rawProductName: "Aposan Teste Gravidez",
    designacao: "APOSAN TESTE GRAVIDEZ",
    expect: {
      inferredType: "DISPOSITIVO_MEDICO",
      mapperNonNull: true,
      nivel1Matches: /DISPOSITIVOS\s+M[ÉE]DICOS/,
      nivel2Matches: /Testes\s+e\s+Monitoriza|Outros/i,
    },
  },

  // ── Pattern E: Puericultura (Aptamil + brinquedos Chicco)
  {
    label: "16. (E) OUTRO + 'Aptamil Pronutra Leite Lactente Sem Lactose 400g'",
    productType: "OUTRO",
    productTypeConfidence: 0.30,
    rawCategory: null,
    rawProductName: "Aptamil Pronutra Leite Lactente Sem Lactose 400g",
    designacao: "APTAMIL PRONUTR LEITE LACTEN S/LACT 400",
    expect: {
      inferredType: "PUERICULTURA",
      mapperNonNull: true,
      nivel1Matches: /PUERICULTURA\s+E\s+BEB[ÉE]/,
      nivel2Matches: /Alimenta[cç][aã]o\s+do\s+Beb[éE]/i,
    },
  },
  {
    label: "17. (E) OUTRO + 'Brinquedos Chicco Cavalinho Saltitão'",
    productType: "OUTRO",
    productTypeConfidence: 0.30,
    rawCategory: "Produtos > Brinquedos > Em Movimento > Cavalgáveis > Cavalinho Saltitão",
    rawProductName: "Cavalinho Saltitão | Chicco.pt",
    designacao: "CH.BRI1185200 CAVALINHO SALTITAO",
    expect: {
      inferredType: "PUERICULTURA",
      mapperNonNull: true,
      nivel1Matches: /PUERICULTURA\s+E\s+BEB[ÉE]/,
      nivel2Matches: /Acess[oó]rios\s+de\s+Beb[éE]|Outros/i,
    },
  },

  // ── Pattern F: Homeopatia (Boiron)
  {
    label: "18. (F) OUTRO + 'Boiron > Apis Mellifica Granulo 15ch'",
    productType: "OUTRO",
    productTypeConfidence: 0.30,
    rawCategory: "Loja > Marca > Boiron > Apis Mellifica Granulo 15ch Boiron",
    rawProductName: "Apis Mellifica Granulo 15ch Boiron",
    designacao: "APIS MELLIFICA GRANULO 15CH BOIRON",
    expect: {
      inferredType: "SUPLEMENTO",
      mapperNonNull: true,
      // fromExternal hint Boiron → SAÚDE NATURAL deve vencer fromType.
      nivel1Matches: /SA[ÚU]DE\s+NATURAL/,
      nivel2Matches: /Homeopat/i,
    },
  },

  // ── Pattern G: Serviços / vacinas SNS (productType=OUTRO intencional)
  {
    label: "19. (G) OUTRO + 'Administração Vacina COVID-19 SNS' (intentional OUTRO)",
    productType: "OUTRO",
    productTypeConfidence: 0.30,
    rawCategory: null,
    rawProductName: "Administração Vacina COVID-19 SNS",
    designacao: "ADMINISTRACAO VACINA COVID-19 SNS",
    expect: {
      // NÃO esperamos upgrade para tipo concreto — productType continua
      // OUTRO mas com classificação canónica em SERVIÇOS.
      inferredType: "OUTRO",
      mapperNonNull: true,
      nivel1Matches: /SERVI[ÇC]OS\s+E\s+ARTIGOS\s+N[ÃA]O/,
      nivel2Matches: /Servi[çc]o\s+Cl[ií]nico/i,
    },
  },
];

function runCase(c: Case): void {
  console.log(`\n${c.label}`);

  // 1. inferProductTypeFromExternal — só relevante para casos onde o
  //    user esperava upgrade (productType=OUTRO).
  const source = buildRetailSource(c.rawCategory, c.rawProductName);
  const inferred = __resolverInternals.inferProductTypeFromExternal([source]);
  if (c.expect.inferredType !== undefined) {
    if (c.expect.inferredType === null) {
      assert(inferred === null, "resolver não deve fazer upgrade");
    } else {
      assert(
        inferred?.type === c.expect.inferredType,
        `resolver upgrade → ${c.expect.inferredType} (got ${inferred?.type ?? "null"})`
      );
    }
  }

  // O productType efectivo pós-resolver: ou o original (se não houve
  // upgrade), ou o inferido. mapToCanonical recebe SEMPRE o efectivo.
  const effectiveType: ProductType =
    c.productType === "OUTRO" && inferred ? inferred.type : c.productType;
  const effectiveConf =
    c.productType === "OUTRO" && inferred
      ? Math.max(c.productTypeConfidence, 0.65)
      : c.productTypeConfidence;

  // 2. mapToCanonical
  const mapped = mapToCanonical({
    productType: effectiveType,
    productTypeConfidence: effectiveConf,
    externalCategory: c.rawCategory,
    externalSubcategory: null,
    designacao: c.designacao,
    atc: null,
  });

  console.log(`    mapped: ${mapped ? `${mapped.nivel1} / ${mapped.nivel2} (conf ${mapped.confidence.toFixed(2)}, ${mapped.method})` : "null"}`);

  if (c.expect.mapperNonNull) {
    assert(mapped !== null, "mapper deve devolver não-null");
  }
  if (mapped) {
    assert(
      c.expect.nivel1Matches.test(mapped.nivel1),
      `nivel1 ${JSON.stringify(mapped.nivel1)} casa ${c.expect.nivel1Matches}`
    );
    if (c.expect.nivel2Matches) {
      assert(
        c.expect.nivel2Matches.test(mapped.nivel2),
        `nivel2 ${JSON.stringify(mapped.nivel2)} casa ${c.expect.nivel2Matches}`
      );
    }
    // Sanidade: o nivel1 nunca deve ser uma categoria técnica
    assert(
      !/T[EÉ]CNICAS|TRANSIT[OÓ]RIAS/i.test(mapped.nivel1),
      `nivel1 não é categoria técnica`
    );
    assert(
      !/Em\s+Revis[aãAÃ]o|Por\s+Classificar|Sem\s+Match/i.test(mapped.nivel2),
      `nivel2 não é categoria técnica`
    );
  }
}

async function main(): Promise<void> {
  console.log("─".repeat(70));
  console.log(`Regressão canonical mapping — ${CASES.length} cenários`);
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
