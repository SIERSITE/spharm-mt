/**
 * scripts/investigate-infomed-search-flow.ts
 *
 * INVESTIGAÇÃO técnica — captura todos os requests/responses durante uma
 * sequência completa de pesquisa no INFOMED para descobrir se o submit
 * pode ser replayado em HTTP-only sem Playwright.
 *
 * Não faz scraping, não persiste em BD. Apenas regista o fluxo.
 *
 * Sequência automatizada:
 *   1. GET index.xhtml (apanha ViewState + JSESSIONID)
 *   2. Aceita cookies se aparecer prompt
 *   3. Type "Decapeptyl" no input principal (carácter a carácter)
 *   4. Espera dropdown autocomplete renderizar e regista o seu DOM
 *   5. Click programático na primeira sugestão (data-item-value match)
 *   6. Espera AJAX/navegação completar
 *   7. Captura URL final + presença de med_guid links
 *   8. Dumps:
 *        - Todos os requests INFOMED com method/URL/post-data
 *        - Todos os responses INFOMED com status/content-type/body excerpt
 *        - Cookies finais
 *        - Estado do form pós-interacção
 *
 * Uso:
 *   npx tsx scripts/investigate-infomed-search-flow.ts
 *   npx tsx scripts/investigate-infomed-search-flow.ts --term="Brufen"
 *   npx tsx scripts/investigate-infomed-search-flow.ts --headful  (ver browser)
 *   npx tsx scripts/investigate-infomed-search-flow.ts --output=/tmp/capture.json
 */

import "dotenv/config";
import * as fs from "fs";
import { chromium, type Request, type Response } from "playwright";

const INDEX_URL = "https://extranet.infarmed.pt/INFOMED-fo/index.xhtml";
const DEFAULT_OUTPUT = "notes/infomed-search-flow-capture.json";

type Args = {
  term: string;
  headful: boolean;
  outputPath: string;
};

function parseArgs(): Args {
  const out: Args = {
    term: "Decapeptyl",
    headful: false,
    outputPath: DEFAULT_OUTPUT,
  };
  for (const a of process.argv.slice(2)) {
    if (a === "--headful") out.headful = true;
    else if (a.startsWith("--term=")) out.term = a.split("=")[1];
    else if (a.startsWith("--output=")) out.outputPath = a.split("=")[1];
  }
  return out;
}

type CapturedRequest = {
  index: number;
  timestamp: string;
  method: string;
  url: string;
  resourceType: string;
  postData: string | null;
  headers: Record<string, string>;
};

type CapturedResponse = {
  index: number;
  timestamp: string;
  url: string;
  status: number;
  contentType: string;
  bodyExcerpt: string | null;
  bodyBytes: number;
  setCookie: string | null;
};

async function main() {
  const args = parseArgs();

  console.log("─".repeat(74));
  console.log("INFOMED Search Flow Investigation");
  console.log("─".repeat(74));
  console.log(`  term:        "${args.term}"`);
  console.log(`  headful:     ${args.headful}`);
  console.log(`  output:      ${args.outputPath}`);

  const browser = await chromium.launch({ headless: !args.headful });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "pt-PT",
  });
  const page = await context.newPage();

  const requests: CapturedRequest[] = [];
  const responses: CapturedResponse[] = [];
  let reqIdx = 0;
  let resIdx = 0;

  page.on("request", (req: Request) => {
    if (!req.url().includes("INFOMED-fo")) return;
    requests.push({
      index: reqIdx++,
      timestamp: new Date().toISOString(),
      method: req.method(),
      url: req.url(),
      resourceType: req.resourceType(),
      postData: req.postData(),
      headers: req.headers(),
    });
  });

  page.on("response", async (res: Response) => {
    if (!res.url().includes("INFOMED-fo")) return;
    let bodyExcerpt: string | null = null;
    let bodyBytes = 0;
    try {
      const buf = await res.body();
      bodyBytes = buf.length;
      const text = buf.toString("utf-8");
      bodyExcerpt = text.slice(0, 3000);
    } catch {
      // binary or stream — skip
    }
    responses.push({
      index: resIdx++,
      timestamp: new Date().toISOString(),
      url: res.url(),
      status: res.status(),
      contentType: res.headers()["content-type"] ?? "",
      bodyExcerpt,
      bodyBytes,
      setCookie: res.headers()["set-cookie"] ?? null,
    });
  });

  // ── Step 1: GET index.xhtml ──────────────────────────────────────
  console.log(`\n[1] GET ${INDEX_URL}`);
  await page.goto(INDEX_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  console.log(`    title: "${await page.title()}"`);
  console.log(`    url:   ${page.url()}`);

  // Capturar ViewState e JSESSIONID iniciais
  const viewState = await page.$eval(
    'input[name="javax.faces.ViewState"]',
    (el) => (el as HTMLInputElement).value,
  ).catch(() => null);
  console.log(`    viewState: ${viewState ? viewState.slice(0, 40) + "..." : "NULL"}`);

  const cookies = await context.cookies();
  const jsessionid = cookies.find((c) => c.name === "JSESSIONID");
  console.log(`    JSESSIONID: ${jsessionid?.value ? jsessionid.value.slice(0, 40) + "..." : "NULL"}`);

  // ── Step 2: aceitar cookies ──────────────────────────────────────
  try {
    const cookiesBtn = page.locator('button[id="cookiesButton"]');
    if (await cookiesBtn.isVisible({ timeout: 2000 })) {
      console.log(`\n[2] Aceitar cookies prompt...`);
      await cookiesBtn.click();
      await page.waitForTimeout(500);
    }
  } catch {
    console.log(`\n[2] Sem cookies prompt`);
  }

  // ── Step 3: type "Decapeptyl" carácter a carácter ─────────────────
  console.log(`\n[3] Type "${args.term}" no input principal...`);
  const input = page.locator('input[name="mainForm:acMinLength_input"]');
  await input.waitFor({ state: "visible", timeout: 5_000 });
  await input.click();
  await input.fill("");
  for (const ch of args.term) {
    await page.keyboard.type(ch, { delay: 80 });
  }
  console.log(`    typed; aguardar 2s para autocomplete renderizar...`);
  await page.waitForTimeout(2000);

  // ── Step 4: inspeccionar dropdown ─────────────────────────────────
  console.log(`\n[4] Inspeccionar dropdown autocomplete...`);
  // PrimeFaces autocomplete gera um overlay panel. Localiza-o por id pattern
  // ou por classe `ui-autocomplete-panel` / `ui-autocomplete-items`.
  const dropdownInfo = await page.evaluate(() => {
    const panels = Array.from(document.querySelectorAll("[id*='_panel'], .ui-autocomplete-panel"));
    return panels.map((p) => ({
      id: p.id,
      cls: p.className,
      visible:
        (p as HTMLElement).offsetWidth > 0 ||
        (p as HTMLElement).offsetHeight > 0 ||
        getComputedStyle(p).display !== "none",
      itemCount: p.querySelectorAll("[data-item-value]").length,
      firstItems: Array.from(p.querySelectorAll("[data-item-value]"))
        .slice(0, 5)
        .map((el) => ({
          value: el.getAttribute("data-item-value"),
          label: el.getAttribute("data-item-label"),
        })),
    }));
  });
  console.log(`    panels encontrados: ${dropdownInfo.length}`);
  for (const p of dropdownInfo) {
    console.log(
      `      id=${p.id} visible=${p.visible} items=${p.itemCount} cls="${p.cls.slice(0, 60)}"`,
    );
    for (const it of p.firstItems) console.log(`        item: ${JSON.stringify(it)}`);
  }

  // ── Step 5: click programático na primeira sugestão ───────────────
  console.log(`\n[5] Click na primeira sugestão...`);
  const firstSuggestion = page.locator("[data-item-value]").first();
  let clickResult = "no_suggestion_found";
  try {
    const count = await firstSuggestion.count();
    if (count > 0) {
      await firstSuggestion.click({ timeout: 5_000 });
      clickResult = "clicked";
      console.log(`    ✓ click OK`);
    } else {
      console.log(`    ✗ nenhum data-item-value visível`);
    }
  } catch (err) {
    clickResult = `click_failed: ${err instanceof Error ? err.message.slice(0, 100) : err}`;
    console.log(`    ✗ ${clickResult}`);
  }

  // ── Step 6: aguardar AJAX/navegação ───────────────────────────────
  console.log(`\n[6] Aguardar 3s para qualquer AJAX/navegação...`);
  await page.waitForTimeout(3000);

  // Estado pós-clique
  const hiddenInputValue = await page
    .$eval(
      'input[name="mainForm:acMinLength_hinput"]',
      (el) => (el as HTMLInputElement).value,
    )
    .catch(() => null);
  console.log(`    hidden input pós-clique: ${JSON.stringify(hiddenInputValue)}`);
  console.log(`    URL pós-clique:          ${page.url()}`);

  // ── Step 7: submit do form principal → vai para pesquisa-avancada ─
  console.log(`\n[7] Submit principal via #mainForm:ajax...`);
  const submitBtn = page.locator('button[id="mainForm:ajax"]');
  try {
    await submitBtn.click({ timeout: 5_000 });
    console.log(`    submit clicked, aguardar 5s...`);
    await page.waitForTimeout(5000);
    console.log(`    URL pós-submit: ${page.url()}`);
  } catch (err) {
    console.log(`    ✗ submit falhou: ${err instanceof Error ? err.message.slice(0, 100) : err}`);
  }

  // ── Step 7b: agora estamos em pesquisa-avancada.xhtml — clicar Pesquisar
  if (page.url().includes("pesquisa-avancada")) {
    console.log(`\n[7b] Em pesquisa-avancada.xhtml — clicar btnPesquisar para executar...`);

    // Inspeccionar o estado da pesquisa-avancada
    const advancedFormState = await page.evaluate(() => {
      const dciInput = document.querySelector(
        'input[name="pesquisa-avancada-form:dciSubAtv_input"], input[name*="dci"]',
      ) as HTMLInputElement | null;
      const nomeInput = document.querySelector(
        'input[name="pesquisa-avancada-form:nomeMed_input"], input[name*="nomeMed"]',
      ) as HTMLInputElement | null;
      const allInputs = Array.from(document.querySelectorAll("input")).slice(0, 30).map((i) => ({
        name: i.name,
        type: i.type,
        value: i.value.slice(0, 60),
      }));
      return {
        dciInputValue: dciInput?.value ?? null,
        nomeInputValue: nomeInput?.value ?? null,
        allInputs,
      };
    });
    console.log(`    DCI input value: ${JSON.stringify(advancedFormState.dciInputValue)}`);
    console.log(`    Nome input value: ${JSON.stringify(advancedFormState.nomeInputValue)}`);
    console.log(`    Inputs com value não-empty:`);
    for (const i of advancedFormState.allInputs) {
      if (i.value && i.value.length > 0 && i.type !== "hidden") {
        console.log(`      name="${i.name}" type="${i.type}" value="${i.value}"`);
      }
    }

    // Clicar Pesquisar
    const btnPesquisar = page.locator('button[id="pesquisa-avancada-form:btnPesquisar"]').first();
    try {
      await btnPesquisar.click({ timeout: 5_000 });
      console.log(`    btnPesquisar clicked, aguardar 8s para listagem...`);
      await page.waitForTimeout(8000);
      console.log(`    URL pós-pesquisar: ${page.url()}`);
    } catch (err) {
      console.log(`    ✗ btnPesquisar falhou: ${err instanceof Error ? err.message.slice(0, 100) : err}`);
    }
  }

  // ── Step 8: capturar estado final ─────────────────────────────────
  console.log(`\n[8] Capturar estado final...`);
  const finalUrl = page.url();
  const finalHtml = await page.content();
  const medGuidMatches = finalHtml.match(/med_guid=[a-zA-Z0-9-]+/g);
  const uniqueMedGuids = medGuidMatches ? [...new Set(medGuidMatches)] : [];
  console.log(`    URL:           ${finalUrl}`);
  console.log(`    HTML bytes:    ${finalHtml.length}`);
  console.log(`    med_guid links unique: ${uniqueMedGuids.length}`);
  for (const m of uniqueMedGuids.slice(0, 10)) console.log(`      ${m}`);

  const finalCookies = await context.cookies();
  console.log(`    cookies: ${finalCookies.length}`);
  for (const c of finalCookies) {
    console.log(`      ${c.name}=${c.value.slice(0, 40)}... (domain ${c.domain})`);
  }

  // ── Salvar HTML completo da página final para inspecção ──────────
  const finalHtmlPath = args.outputPath.replace(/\.json$/, ".final-html.html");
  fs.writeFileSync(finalHtmlPath, finalHtml);
  console.log(`\n[9a] HTML final salvo em ${finalHtmlPath} (${finalHtml.length} bytes)`);

  // ── Salvar capture completo em JSON ───────────────────────────────
  console.log(`\n[9b] Salvar capture em ${args.outputPath}`);
  const capture = {
    investigatedAt: new Date().toISOString(),
    term: args.term,
    initialState: {
      viewState,
      jsessionid: jsessionid?.value ?? null,
      cookies: cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain })),
    },
    dropdownInfo,
    clickResult,
    afterClick: {
      hiddenInputValue,
      url: page.url(),
    },
    finalState: {
      url: finalUrl,
      htmlBytes: finalHtml.length,
      uniqueMedGuids,
      cookies: finalCookies.map((c) => ({ name: c.name, value: c.value.slice(0, 60), domain: c.domain })),
    },
    requests,
    responses,
  };
  fs.writeFileSync(args.outputPath, JSON.stringify(capture, null, 2));
  console.log(`    capture saved (${requests.length} requests, ${responses.length} responses)`);

  // ── Análise rápida das requests POST ──────────────────────────────
  console.log(`\n[10] Resumo das requests POST a INFOMED-fo:`);
  const postReqs = requests.filter((r) => r.method === "POST");
  for (const r of postReqs) {
    console.log(`    [${r.index}] POST ${r.url.slice(0, 100)}`);
    if (r.postData) {
      const lines = r.postData.split("&");
      console.log(`      ${lines.length} param(s):`);
      for (const ln of lines.slice(0, 8)) {
        const decoded = decodeURIComponent(ln).slice(0, 120);
        console.log(`        ${decoded}`);
      }
      if (lines.length > 8) console.log(`        ... (+${lines.length - 8} mais)`);
    }
  }

  await browser.close();
  console.log("\n" + "─".repeat(74));
  console.log("Investigação completa.");
  console.log("─".repeat(74));
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
