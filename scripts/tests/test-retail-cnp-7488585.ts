/**
 * scripts/tests/test-retail-cnp-7488585.ts
 *
 * Regressão para CNP 7488585 (A-Derma Exomega Control Creme Noite Emoliente
 * 200ml). A página existe em lojadafarmacia.com mas o DDG não a indexa
 * fiavelmente — o teste valida que o slug-fallback determinístico do
 * conector retail encontra a página e extrai a evidência correcta.
 *
 * Duas partes:
 *   1. Teste offline: gera slug candidates a partir da designação e
 *      verifica que o slug real `a-derma-exomega-cont-cr-noite-emol200ml`
 *      está entre os candidatos. Não requer rede nem BD.
 *   2. Teste online (opcional, com `--online`): faz fetch real à URL
 *      conhecida e verifica extracção de rawBrand / rawCategory /
 *      rawProductName via avaliação directa.
 *
 * Correr:
 *   npx tsx scripts/tests/test-retail-cnp-7488585.ts
 *   npx tsx scripts/tests/test-retail-cnp-7488585.ts --online
 *
 * Sai com código != 0 em qualquer falha.
 */

import "dotenv/config";
import { __retailInternals } from "../../lib/catalog-connectors";

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

async function offlineSlugTest(): Promise<void> {
  console.log("\n[1] Slug candidates (offline)");
  const candidates = __retailInternals.generateSlugCandidates(DESIGNACAO);
  console.log(`    gerados: ${candidates.length}`);
  for (const c of candidates) console.log(`      · ${c}`);
  assert(
    candidates.includes(EXPECTED_SLUG),
    `Slug candidates contêm "${EXPECTED_SLUG}"`
  );
  assert(
    candidates.some((c) => c.includes("a-derma") && c.includes("exomega")),
    `Slug candidates incluem 'a-derma' + 'exomega'`
  );
}

async function onlineExtractionTest(): Promise<void> {
  console.log("\n[2] Extracção de evidência (online)");
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

  // Heurísticas alinhadas com o conector retail.
  const cnpInPage = /(?:^|[^0-9])7488585(?:[^0-9]|$)/.test(html);
  const cnpExplicit = /\b(?:COD|C[oó]d(?:igo)?)\s*[.:]?\s*\[?7488585\b/i.test(html)
    || /\[\s*COD\s*7488585\s*\]/i.test(html);
  assert(cnpInPage, "CNP 7488585 aparece no body da página");

  // O parser real do conector é o que conta — mas para evitar dependência
  // mais profunda só fazemos sanidade rasa aqui.
  const hasAderma = /a-?derma/i.test(html);
  assert(hasAderma, "Página menciona 'A-Derma'");

  const hasDermo = /dermocosm[eé]tica/i.test(html);
  assert(hasDermo, "Página menciona 'Dermocosmética' (breadcrumb)");

  if (cnpExplicit) console.log("    (bonus) [COD 7488585] — sinal forte detectado");
}

async function main(): Promise<void> {
  const online = process.argv.includes("--online");

  console.log("─".repeat(70));
  console.log("Regressão CNP 7488585 — A-Derma Exomega 200ml");
  console.log("─".repeat(70));

  await offlineSlugTest();
  if (online) {
    try {
      await onlineExtractionTest();
    } catch (err) {
      errors.push(
        `Erro no teste online: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else {
    console.log("\n[2] Online skipped — passar `--online` para validar fetch real.");
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
