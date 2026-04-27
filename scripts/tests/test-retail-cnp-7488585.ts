/**
 * scripts/tests/test-retail-cnp-7488585.ts
 *
 * Regressão para CNP 7488585 (A-Derma Exomega Control Creme Noite Emoliente
 * 200ml). A página existe em lojadafarmacia.com mas o DDG não a indexa
 * fiavelmente — o teste valida que (a) o slug-fallback do conector retail
 * encontra a página, (b) os parsers extraem rawBrand=A-Derma /
 * rawCategory contendo Dermocosmética, e (c) o resolver upgrade o
 * productType para DERMOCOSMETICA.
 *
 * Três níveis:
 *   1. Offline puro: slug, inferBrandFromName, inferProductType.
 *   2. HTML mockado: extractRetailMetadata sobre snippets representativos.
 *   3. Online (--online): fetch real à URL conhecida e validar a
 *      extracção end-to-end.
 *
 * Correr:
 *   npx tsx scripts/tests/test-retail-cnp-7488585.ts
 *   npx tsx scripts/tests/test-retail-cnp-7488585.ts --online
 *
 * Sai com código != 0 em qualquer falha.
 */

import "dotenv/config";
import { __retailInternals } from "../../lib/catalog-connectors";
import { __resolverInternals } from "../../lib/catalog-resolution-engine";
import type { ExternalSourceData } from "../../lib/catalog-types";

const EXPECTED_SLUG = "a-derma-exomega-cont-cr-noite-emol200ml";
const KNOWN_URL = `https://lojadafarmacia.com/pt/artigo/${EXPECTED_SLUG}`;
const DESIGNACAO = "A-Derma Exomega Control Creme Noite Emoliente 200ml";

const errors: string[] = [];

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    errors.push(msg);
    console.error(`  ✗ ${msg}`);
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

function offlineSlugTest(): void {
  console.log("\n[1] Slug candidates");
  const candidates = __retailInternals.generateSlugCandidates(DESIGNACAO);
  console.log(`    gerados: ${candidates.length}`);
  for (const c of candidates) console.log(`      · ${c}`);
  assert(
    candidates.includes(EXPECTED_SLUG),
    `Slug candidates contêm "${EXPECTED_SLUG}"`
  );
}

function offlineBrandInferenceTest(): void {
  console.log("\n[2] inferBrandFromName");
  const cases: Array<[string, string]> = [
    ["A-Derma Exomega Control Creme Noite Emoliente 200ml", "A-Derma"],
    ["AVENE CICALFATE+ creme cicatrizante 40ml", "Avène"],
    ["La Roche-Posay Toleriane Sensitive 40ml", "La Roche-Posay"],
    ["ISDIN Fotoprotector Fusion Water SPF 50", "ISDIN"],
  ];
  const normalize = (s: string): string =>
    s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, "");
  for (const [name, expected] of cases) {
    const got = __retailInternals.inferBrandFromName(name);
    assert(
      got != null && normalize(got).startsWith(normalize(expected.slice(0, 5))),
      `inferBrandFromName("${name}") → "${expected}" (got "${got}")`
    );
  }
  // Negativo
  const negative = __retailInternals.inferBrandFromName("Comprimidos genéricos sem marca clara 30 cps");
  assert(negative == null, `inferBrandFromName(genérico) === null (got "${negative}")`);
}

function offlineExtractorMockTest(): void {
  console.log("\n[3] extractRetailMetadata (HTML mock)");

  // Mock representativo de uma página de farmácia portuguesa: sem JSON-LD,
  // sem itemprop="brand", apenas breadcrumb e link de marca via /marcas/<slug>/.
  const html = `
<html><head>
  <meta property="og:title" content="A-Derma Exomega Control Creme Noite Emoliente 200ml">
</head>
<body>
  <nav class="breadcrumb">
    <a href="/">Início</a>
    <a href="/categoria/dermocosmetica">Dermocosmética</a>
    <a href="/categoria/hidratantes-corporais">Hidratantes Corporais</a>
    <a href="/categoria/cuidados-de-corpo">Cuidados de Corpo</a>
  </nav>
  <h1>A-Derma Exomega Control Creme Noite Emoliente 200ml</h1>
  <div class="product-meta">
    <span>Marca:</span>
    <a href="/marcas/a-derma">A-Derma</a>
  </div>
  <p>[COD 7488585]</p>
</body></html>`;

  const meta = __retailInternals.extractRetailMetadata(html);
  console.log("    extracted:", JSON.stringify(meta, null, 2).split("\n").map((l) => "    " + l).join("\n"));
  assert(meta.brand === "A-Derma", `brand === "A-Derma" (got "${meta.brand}")`);
  assert(
    meta.categoria != null && /dermocosm[eé]tica/i.test(meta.categoria),
    `categoria contém Dermocosmética (got "${meta.categoria}")`
  );
  assert(
    meta.nome != null && /a-derma/i.test(meta.nome),
    `nome contém A-Derma (got "${meta.nome}")`
  );
}

function offlineProductTypeInferenceTest(): void {
  console.log("\n[4] inferProductTypeFromExternal");

  // Caso 1 — ideal: rawCategory + rawProductName ambos disponíveis.
  const full: ExternalSourceData = {
    source: "retail_pharmacy",
    tier: "RETAIL",
    matchedBy: "cnp",
    confidence: 0.85,
    fabricante: null, principioAtivo: null, atc: null,
    dosagem: null, embalagem: null, formaFarmaceutica: null,
    categoria: null, subcategoria: null, imagemUrl: null, notes: null,
    rawBrand: "A-Derma",
    rawCategory: "Dermocosmética > Hidratantes Corporais > Cuidados de Corpo",
    rawProductName: "A-Derma Exomega Control Creme Noite Emoliente 200ml",
  };
  const r1 = __resolverInternals.inferProductTypeFromExternal([full]);
  assert(
    r1?.type === "DERMOCOSMETICA",
    `caso completo → DERMOCOSMETICA (got "${r1?.type}")`
  );

  // Caso 2 — só rawProductName (extracção breadcrumb falhou).
  const onlyName: ExternalSourceData = {
    ...full,
    rawCategory: null,
    rawBrand: null,
  };
  const r2 = __resolverInternals.inferProductTypeFromExternal([onlyName]);
  assert(
    r2?.type === "DERMOCOSMETICA",
    `só rawProductName ("...Creme...Emoliente") → DERMOCOSMETICA (got "${r2?.type}")`
  );

  // Caso 3 — sem evidência → null.
  const empty: ExternalSourceData = {
    ...full,
    rawCategory: null,
    rawBrand: null,
    rawProductName: null,
  };
  const r3 = __resolverInternals.inferProductTypeFromExternal([empty]);
  assert(r3 == null, `sem evidência → null (got "${r3?.type}")`);
}

async function onlineExtractionTest(): Promise<void> {
  console.log("\n[5] Extracção end-to-end (online)");
  console.log(`    URL: ${KNOWN_URL}`);

  const res = await fetch(KNOWN_URL, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept-Language": "pt-PT,pt;q=0.9",
    },
  });
  assert(res.ok, `HTTP ${res.status} OK`);
  if (!res.ok) return;

  const html = await res.text();
  const meta = __retailInternals.extractRetailMetadata(html);
  console.log("    extracted:");
  console.log(`      nome      = ${JSON.stringify(meta.nome)}`);
  console.log(`      brand     = ${JSON.stringify(meta.brand)}`);
  console.log(`      categoria = ${JSON.stringify(meta.categoria)}`);

  assert(
    meta.brand != null && /a-?derma/i.test(meta.brand),
    `rawBrand contém A-Derma (got "${meta.brand}")`
  );
  assert(
    meta.categoria != null && /dermocosm[eé]tica/i.test(meta.categoria),
    `rawCategory contém Dermocosmética (got "${meta.categoria}")`
  );
  assert(
    meta.nome != null && /a-?derma.*exomega/i.test(meta.nome),
    `rawProductName contém "A-Derma Exomega" (got "${meta.nome}")`
  );

  // Inferência de productType com a evidência real.
  const synth: ExternalSourceData = {
    source: "retail_pharmacy",
    tier: "RETAIL",
    matchedBy: "cnp",
    confidence: 0.85,
    fabricante: null, principioAtivo: null, atc: null,
    dosagem: null, embalagem: null, formaFarmaceutica: null,
    categoria: meta.categoria, subcategoria: null,
    imagemUrl: null, notes: null,
    rawBrand: meta.brand,
    rawCategory: meta.categoria,
    rawProductName: meta.nome,
  };
  const inferred = __resolverInternals.inferProductTypeFromExternal([synth]);
  assert(
    inferred?.type === "DERMOCOSMETICA",
    `productType inferido → DERMOCOSMETICA (got "${inferred?.type}")`
  );
}

async function main(): Promise<void> {
  const online = process.argv.includes("--online");

  console.log("─".repeat(70));
  console.log("Regressão CNP 7488585 — A-Derma Exomega 200ml");
  console.log("─".repeat(70));

  offlineSlugTest();
  offlineBrandInferenceTest();
  offlineExtractorMockTest();
  offlineProductTypeInferenceTest();

  if (online) {
    try {
      await onlineExtractionTest();
    } catch (err) {
      errors.push(
        `Erro no teste online: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else {
    console.log("\n[5] Online skipped — passar `--online` para validar fetch real.");
  }

  console.log("\n" + "─".repeat(70));
  if (errors.length === 0) {
    console.log("OK — todos os asserts passaram.");
    process.exit(0);
  } else {
    console.error(`FAIL — ${errors.length} assert(s) falharam:`);
    for (const e of errors) console.error(`  · ${e}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[erro fatal]", err);
  process.exit(1);
});
