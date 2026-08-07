/**
 * scripts/capture-pagination-post.ts
 *
 * Captura o formato exacto do POST de pagination do PrimeFaces datatable
 * em pesquisa-avancada.xhtml. Necessário antes de implementar HTTP-only
 * browse-infomed-listagem.
 *
 * Captura também o submit inicial (page 1) e response em partial-response XML.
 */

import * as fs from "fs";
import * as path from "path";
import { chromium, type Request } from "playwright";

const PESQ_URL = "https://extranet.infarmed.pt/INFOMED-fo/pesquisa-avancada.xhtml";
const OUT_DIR = path.resolve("scripts/data/spike-pesquisa-avancada-v4");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function main() {
  await fs.promises.mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ userAgent: UA, locale: "pt-PT" });
  const page = await ctx.newPage();

  const posts: Array<{ trigger: string; url: string; postData: string | null; respBodyExcerpt: string | null }> = [];
  let trigger = "init";

  page.on("request", async (r) => {
    if (r.method() !== "POST" || !r.url().endsWith("pesquisa-avancada.xhtml")) return;
    posts.push({ trigger, url: r.url(), postData: r.postData(), respBodyExcerpt: null });
  });
  page.on("response", async (r) => {
    if (r.request().method() !== "POST" || !r.url().endsWith("pesquisa-avancada.xhtml")) return;
    try {
      const body = await r.body();
      const idx = posts.length - 1;
      if (idx >= 0) {
        posts[idx].respBodyExcerpt = body.toString("utf-8").slice(0, 6000);
      }
    } catch {
      /* ignore */
    }
  });

  console.log("GET", PESQ_URL);
  await page.goto(PESQ_URL, { waitUntil: "domcontentloaded" });
  try {
    const c = page.locator('button[id="cookiesButton"]');
    if (await c.isVisible({ timeout: 1500 })) {
      await c.click();
      await page.waitForTimeout(300);
    }
  } catch {
    /* ignore */
  }

  // Submit inicial — empty (full listagem)
  trigger = "submit-empty";
  console.log("\n[1] Submit (empty) → page 1");
  await page.locator("#mainForm\\:btnDoSearch").click();
  await page.waitForTimeout(3500);

  // Avançar página
  trigger = "page-2";
  console.log("\n[2] Avançar para página 2");
  await page.locator(".ui-paginator-next").first().click();
  await page.waitForTimeout(3000);

  // Avançar mais uma página
  trigger = "page-3";
  console.log("\n[3] Avançar para página 3");
  await page.locator(".ui-paginator-next").first().click();
  await page.waitForTimeout(3000);

  // Skip para página 10 (testar paginação large jump)
  trigger = "page-10";
  console.log("\n[4] Saltar para página 10 (input page)");
  // PrimeFaces tem um input numérico para saltar
  const pageInput = page.locator(".ui-paginator-current + .ui-paginator-rpp-options").first();
  // Mais simples: clicar last
  await page.locator(".ui-paginator-last").first().click().catch(() => undefined);
  await page.waitForTimeout(3000);

  await fs.promises.writeFile(
    path.join(OUT_DIR, "pagination-posts.json"),
    JSON.stringify(posts, null, 2),
    "utf-8",
  );

  console.log(`\nCaptured ${posts.length} POSTs:`);
  for (const p of posts) {
    console.log(`  [${p.trigger}] postData length=${p.postData?.length ?? 0}`);
  }

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
