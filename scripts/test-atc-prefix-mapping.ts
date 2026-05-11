/**
 * scripts/test-atc-prefix-mapping.ts
 *
 * Testes assert-based para o mapper ATC → nivel2 após a adição das duas
 * novas categorias ("Anti-infecciosos", "Hormonas e Corticoides") e do
 * sub-prefixo de excepção N01BB → Dermatológicos.
 *
 * Não escreve em BD. Não toca em produção. Apenas chama `mapToCanonical`
 * com inputs sintéticos e verifica o `nivel2` resultante.
 *
 * Uso:
 *   npx tsx scripts/test-atc-prefix-mapping.ts
 *
 * Sai com código != 0 se algum assert falhar.
 */

import { strict as assert } from "node:assert";
import { mapToCanonical } from "../lib/catalog-taxonomy-map";

type Case = {
  name: string;
  atc: string;
  dci?: string | null;
  designacao?: string;
  expectedNivel2: string;
  expectedMethod?: string;
};

const cases: Case[] = [
  // ── Anti-infecciosos (J01/J02/J05) ─────────────────────────────────────
  { name: "J01CA04 Amoxicilina (Amoxicilina Labesfal)", atc: "J01CA04", dci: "Amoxicilina", designacao: "Amoxicilina Labesfal, 500 mg x 16 cáps", expectedNivel2: "Anti-infecciosos" },
  { name: "J01FA10 Azitromicina", atc: "J01FA10", dci: "Azitromicina", designacao: "Azitromicina Generis, 200 mg/5 mL x 30", expectedNivel2: "Anti-infecciosos" },
  { name: "J01CF05 Flucloxacilina (Floxapen)", atc: "J01CF05", dci: "Flucloxacilina", designacao: "Floxapen, 500 mg x 24 cáps", expectedNivel2: "Anti-infecciosos" },
  { name: "J02AC01 Fluconazol (Diflucan)", atc: "J02AC01", dci: "Fluconazol", designacao: "Diflucan 50 Mg 7 Cápsula", expectedNivel2: "Anti-infecciosos" },
  { name: "J05AB01 Aciclovir (Zovirax oral)", atc: "J05AB01", dci: "Aciclovir", designacao: "Zovirax, 200 mg x 25 comp", expectedNivel2: "Anti-infecciosos" },

  // ── Hormonas e Corticoides (H02/H03) ───────────────────────────────────
  { name: "H02AB04 Metilprednisolona (Medrol)", atc: "H02AB04", dci: "Metilprednisolona", designacao: "Medrol, 16 mg x 50 comp", expectedNivel2: "Hormonas e Corticoides" },
  { name: "H02AB06 Prednisolona (Lepicortinolo)", atc: "H02AB06", dci: "Prednisolona", designacao: "Lepicortinolo, 20 mg x 20 comp", expectedNivel2: "Hormonas e Corticoides" },
  { name: "H02AB13 Deflazacorte", atc: "H02AB13", dci: "Deflazacorte", designacao: "Calcort 30 mg x 10 comp", expectedNivel2: "Hormonas e Corticoides" },
  { name: "H03AA01 Levotiroxina (Eutirox)", atc: "H03AA01", dci: "Levotiroxina sódica", designacao: "Eutirox, 25 mcg x 20 comp", expectedNivel2: "Hormonas e Corticoides" },
  { name: "H03CA Iodeto de potássio (Yodafar)", atc: "H03CA", dci: "Iodeto de potássio", designacao: "Yodafar, 0,2 mg x 50 comp", expectedNivel2: "Hormonas e Corticoides" },

  // ── P02 reuso → Sistema Digestivo ──────────────────────────────────────
  { name: "P02CA01 Mebendazol (Pantelmin)", atc: "P02CA01", dci: "Mebendazol", designacao: "Pantelmin, 100 mg x 6 comp", expectedNivel2: "Sistema Digestivo" },
  { name: "P02CA03 Albendazol (Zentel)", atc: "P02CA03", dci: "Albendazol", designacao: "Zentel, 400 mg x 1 comp", expectedNivel2: "Sistema Digestivo" },

  // ── N01BB reuso → Dermatológicos (excepção 5-char sobre N01) ──────────
  { name: "N01BB20 Lidocaína + Prilocaína (EMLA creme)", atc: "N01BB20", dci: "Lidocaína + Prilocaína", designacao: "EMLA, 2,5/2,5 g % p/p x 5 creme bisn", expectedNivel2: "Dermatológicos" },
  { name: "N01BB02 Lidocaína (genérico tópico)", atc: "N01BB02", dci: "Lidocaína", designacao: "Lidocaína 2% creme", expectedNivel2: "Dermatológicos" },

  // ── A11 / M05 mantêm-se em "Outros Medicamentos" (decisão deliberada) ─
  { name: "A11CC03 Alfacalcidol (Etalpha)", atc: "A11CC03", dci: "Alfacalcidol", designacao: "Etalpha 0.5 µg 30 Cápsula", expectedNivel2: "Outros Medicamentos" },
  { name: "M05BB03 Ác. alendrónico + Colecalciferol (Adrovance)", atc: "M05BB03", dci: "Ácido alendrónico + Colecalciferol", designacao: "Adrovance, 70 mg + 5600 UI x 4 comp", expectedNivel2: "Outros Medicamentos" },

  // ── Regressão: N01 sistémico continua em "Outros Medicamentos" ────────
  // (N01A ou N01 sem sub-prefixo conhecido — anestésicos gerais hospitalares)
  { name: "N01AB04 Isoflurano (anestésico geral hospitalar)", atc: "N01AB04", dci: "Isoflurano", designacao: "Isoflurane Baxter 100%", expectedNivel2: "Outros Medicamentos" },

  // ── Regressões para grupos não-tocados ─────────────────────────────────
  { name: "C09AA10 Trandolapril (Gopten) — cardiovascular", atc: "C09AA10", dci: "Trandolapril", designacao: "Gopten, 2 mg x 56 cáps", expectedNivel2: "Cardiovascular" },
  { name: "N05AD01 Haloperidol (Haldol) — sistema nervoso", atc: "N05AD01", dci: "Haloperidol", designacao: "Haldol, 1 mg x 60 comp", expectedNivel2: "Sistema Nervoso" },
  { name: "M01AH01 Celecoxib (Celebrex) — AINE", atc: "M01AH01", dci: "Celecoxib", designacao: "Celebrex, 200 mg x 20 cáps", expectedNivel2: "Analgésicos e Anti-inflamatórios" },
];

function run() {
  let passed = 0;
  let failed = 0;
  const failures: Array<{ name: string; expected: string; got: string | null }> = [];

  for (const c of cases) {
    const out = mapToCanonical({
      productType: "MEDICAMENTO",
      productTypeConfidence: 0.99,
      externalCategory: null,
      externalSubcategory: null,
      designacao: c.designacao ?? "(no designacao)",
      atc: c.atc,
      dci: c.dci ?? null,
    });

    const got = out?.nivel2 ?? null;
    try {
      assert.equal(got, c.expectedNivel2, `Esperava nivel2=${c.expectedNivel2}, obteve ${got}`);
      console.log(`  ✓ ${c.name}  →  ${got}`);
      passed++;
    } catch {
      console.log(`  ✗ ${c.name}  →  esperava "${c.expectedNivel2}", obteve "${got}"`);
      failed++;
      failures.push({ name: c.name, expected: c.expectedNivel2, got });
    }
  }

  console.log("\n" + "─".repeat(70));
  console.log(`Resultado: ${passed} passados, ${failed} falhados de ${cases.length}`);
  console.log("─".repeat(70));
  if (failed > 0) {
    console.error("\nFalhas:");
    for (const f of failures) {
      console.error(`  - ${f.name}: expected="${f.expected}" got="${f.got}"`);
    }
    process.exit(1);
  }
}

run();
