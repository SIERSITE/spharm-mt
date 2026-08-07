/**
 * scripts/spike-pesquisa-avancada-v3.ts
 *
 * P9 Spike v3 — focado em:
 *   1. Capturar DOM da datatable POST-submit (não pre-submit)
 *   2. Procurar med_guid em row links / data attributes
 *   3. Testar max rows-per-page (mainForm:dt-medicamentos_rppDD)
 *   4. Capturar paginator clicks
 *   5. Tentar HTTP-only replay
 *
 * Cohort de teste: titular=Bayer (85 medicamentos, manejável).
 */

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { chromium, type Page } from "playwright";

const BASE = "https://extranet.infarmed.pt/INFOMED-fo";
const PESQ_URL = `${BASE}/pesquisa-avancada.xhtml`;
const OUT_DIR = path.resolve("scripts/data/spike-pesquisa-avancada");
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function snapshot(page: Page, label: string): Promise<void> {
  const html = await page.content();
  await fs.promises.writeFile(path.join(OUT_DIR, `v3-dom-${label}.html`), html, "utf-8");
  console.log(`    [snapshot] v3-dom-${label}.html (${(html.length / 1024).toFixed(0)}kb)`);
}

async function inspectTable(page: Page) {
  return await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[id*="dt-medicamentos"] tr[data-ri]'));
    const out: Array<{
      ri: string | null;
      medId: string;
      name: string;
      linkInfo: Array<{ href: string; onclick: string | null; dataAttrs: Record<string, string>; text: string }>;
    }> = [];
    for (const r of rows.slice(0, 10)) {
      const cells = r.querySelectorAll("td");
      const links = Array.from(r.querySelectorAll("a")).map((a) => {
        const dataAttrs: Record<string, string> = {};
        for (const att of (a as HTMLElement).attributes) {
          if (att.name.startsWith("data-")) dataAttrs[att.name] = att.value;
        }
        return {
          href: a.getAttribute("href") ?? "",
          onclick: a.getAttribute("onclick"),
          dataAttrs,
          text: (a.textContent ?? "").trim().slice(0, 40),
        };
      });
      out.push({
        ri: r.getAttribute("data-ri"),
        medId: cells[0]?.textContent?.trim() ?? "",
        name: (cells[1]?.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40),
        linkInfo: links.slice(0, 3),
      });
    }
    return out;
  });
}

async function inspectPaginator(page: Page) {
  return await page.evaluate(() => {
    const rppSelect = document.getElementById("mainForm:dt-medicamentos_rppDD");
    const options: string[] = [];
    if (rppSelect && rppSelect.tagName === "SELECT") {
      for (const opt of Array.from((rppSelect as HTMLSelectElement).options)) {
        options.push(opt.value);
      }
    }
    const totalText = (document.querySelector(".ui-paginator-current") as HTMLElement | null)?.innerText.trim() ?? "";
    return { rppOptions: options, totalText };
  });
}

async function main() {
  await fs.promises.mkdir(OUT_DIR, { recursive: true });
  console.log("─".repeat(74));
  console.log("Spike v3 — POST-submit DOM + paginação + med_guid resolution");
  console.log("─".repeat(74));

  const browser = await chromium.launch({ headless: !process.argv.includes("--headful") });
  const ctx = await browser.newContext({ userAgent: USER_AGENT, locale: "pt-PT" });
  const page = await ctx.newPage();

  // Capturar todos POSTs ao pesquisa-avancada.xhtml para análise
  const posts: Array<{ url: string; postData: string | null; trigger: string }> = [];
  let currentTrigger = "init";
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("pesquisa-avancada.xhtml")) {
      posts.push({ url: r.url(), postData: r.postData(), trigger: currentTrigger });
    }
  });

  console.log(`\n[init] GET ${PESQ_URL}`);
  await page.goto(PESQ_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  try {
    const cookies = page.locator('button[id="cookiesButton"]');
    if (await cookies.isVisible({ timeout: 1500 })) {
      await cookies.click();
      await page.waitForTimeout(300);
    }
  } catch {
    /* ignore */
  }

  // Capturar opções do rppDD
  const pagInfo = await inspectPaginator(page);
  console.log(`\n[paginator]`);
  console.log(`    rppDD options: [${pagInfo.rppOptions.join(", ")}]`);
  console.log(`    paginator text inicial: "${pagInfo.totalText}"`);

  // ── Test 1: submeter com titular=Bayer ────────────────────────────
  console.log(`\n[T1] Submit com Titular="Bayer"`);
  currentTrigger = "submit-bayer";
  await page.locator('[name="mainForm:taim_input"]').fill("Bayer");
  await page.waitForTimeout(500);
  await page.locator("#mainForm\\:btnDoSearch").click();
  await page.waitForTimeout(3500);

  const tableT1 = await inspectTable(page);
  const pagT1 = await inspectPaginator(page);
  console.log(`    rows visíveis: ${tableT1.length}`);
  console.log(`    paginator: "${pagT1.totalText}"`);
  console.log(`    first row structure:`);
  if (tableT1[0]) {
    console.log(`      ri=${tableT1[0].ri} medId=${tableT1[0].medId} name="${tableT1[0].name}"`);
    console.log(`      links na row:`);
    for (const l of tableT1[0].linkInfo) {
      console.log(`        href="${l.href}" onclick="${(l.onclick ?? "").slice(0, 80)}..."`);
      console.log(`        data attrs: ${JSON.stringify(l.dataAttrs)}`);
    }
  }
  await snapshot(page, "after-bayer-submit");

  // ── Test 2: aumentar rppDD ao máximo (se >10 disponível) ──────────
  const maxRpp = pagInfo.rppOptions.map(Number).filter((n) => !isNaN(n)).reduce((a, b) => Math.max(a, b), 10);
  if (maxRpp > 10) {
    console.log(`\n[T2] Mudar rppDD para ${maxRpp}`);
    currentTrigger = "change-rpp";
    await page.selectOption("#mainForm\\:dt-medicamentos_rppDD", String(maxRpp));
    await page.waitForTimeout(3000);
    const tableT2 = await inspectTable(page);
    const pagT2 = await inspectPaginator(page);
    console.log(`    rows visíveis após rpp=${maxRpp}: ${tableT2.length}`);
    console.log(`    paginator: "${pagT2.totalText}"`);
    await snapshot(page, `after-rpp-${maxRpp}`);
  } else {
    console.log(`\n[T2] rppDD máximo é 10 — paginação obrigatória`);
  }

  // ── Test 3: avançar uma página ────────────────────────────────────
  console.log(`\n[T3] Avançar para página 2`);
  currentTrigger = "page-2";
  // PrimeFaces paginator: clicar no botão next
  const nextBtn = page.locator(".ui-paginator-next").first();
  if (await nextBtn.count() > 0) {
    await nextBtn.click();
    await page.waitForTimeout(2500);
    const tableT3 = await inspectTable(page);
    const pagT3 = await inspectPaginator(page);
    console.log(`    paginator: "${pagT3.totalText}"`);
    console.log(`    first row pag 2: medId=${tableT3[0]?.medId ?? "?"} name="${tableT3[0]?.name ?? "?"}"`);
  } else {
    console.log(`    paginator next não encontrado`);
  }

  // ── Test 4: clicar 1 row → confirmar resolução med_guid ──────────
  console.log(`\n[T4] Click row 0 → ver med_guid na navegação`);
  currentTrigger = "click-row";
  // Voltar à página 1
  const firstBtn = page.locator(".ui-paginator-first").first();
  if (await firstBtn.count() > 0) {
    await firstBtn.click().catch(() => undefined);
    await page.waitForTimeout(2000);
  }
  // Capturar URL após clicar primeira row (linkNome)
  const rowLink = page.locator('[id*="dt-medicamentos"] tr[data-ri="0"] a').first();
  const navP = page.waitForURL("**/detalhes-medicamento.xhtml*", { timeout: 8000 }).catch(() => undefined);
  await rowLink.click().catch(() => undefined);
  await navP;
  console.log(`    URL após click: ${page.url()}`);
  const guidMatch = /med_guid=([a-zA-Z0-9-]+)/i.exec(page.url());
  if (guidMatch) {
    console.log(`    ✓ med_guid extracted from URL: ${guidMatch[1]}`);
  } else {
    console.log(`    med_guid NÃO está na URL (session-resolved provavelmente)`);
  }

  // Guardar todos os posts capturados
  await fs.promises.writeFile(
    path.join(OUT_DIR, "v3-all-posts.json"),
    JSON.stringify(posts, null, 2),
    "utf-8",
  );
  console.log(`\n[posts] capturados ${posts.length} POSTs ao pesquisa-avancada.xhtml`);

  await browser.close();
  console.log("\nSpike v3 completa.");
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
