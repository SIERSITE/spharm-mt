/**
 * scripts/spike-pesquisa-avancada-v2.ts
 *
 * P9 Spike v2 — investigação corrigida do `pesquisa-avancada.xhtml`.
 *
 * Achados da v1:
 *   · O form é `mainForm` (não `pesquisa-avancada-form` como as notas
 *     antigas sugeriam)
 *   · Inputs relevantes:
 *       mainForm:classif-atc_input        (ATC — autocomplete)
 *       mainForm:taim_input               (Titular AIM — text)
 *       mainForm:medicamento_input        (Nome — text)
 *       mainForm:dci_input                (DCI — text/autocomplete)
 *       mainForm:ff_input                 (Forma farmacêutica — select)
 *       mainForm:vias-admin_input         (Vias administração — select)
 *       mainForm:grupo-produto_input      (Grupo produto — select)
 *       mainForm:dt-medicamentos_rppDD    (rows-per-page dropdown!)
 *   · Botão submit: mainForm:btnDoSearch (texto "Pesquisar")
 *
 * Esta versão:
 *   1. Submete o form mainForm com diferentes filtros
 *   2. Conta linhas da datatable + paginação
 *   3. Captura POSTs reais para análise HTTP-only-replay
 *   4. Limita-se a ~12 submissões
 */

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { chromium, type Page, type Request, type Response } from "playwright";

const BASE = "https://extranet.infarmed.pt/INFOMED-fo";
const PESQ_URL = `${BASE}/pesquisa-avancada.xhtml`;
const OUT_DIR = path.resolve("scripts/data/spike-pesquisa-avancada");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

type CapturedReq = { ts: string; method: string; url: string; postData: string | null };
type CapturedRes = { ts: string; url: string; status: number; bytes: number; excerpt: string | null };

async function ensureDir(p: string) {
  await fs.promises.mkdir(p, { recursive: true });
}

type FilterTest = {
  name: string;
  description: string;
  fillInput: { selector: string; value: string } | null;
  selectInput?: { selector: string; value: string };
};

const TESTS: FilterTest[] = [
  // ATC autocomplete
  { name: "atc-C", description: "ATC starts 'C' (cardiovascular)", fillInput: { selector: '[name="mainForm:classif-atc_input"]', value: "C" } },
  { name: "atc-N", description: "ATC starts 'N' (SNC)", fillInput: { selector: '[name="mainForm:classif-atc_input"]', value: "N" } },
  { name: "atc-J", description: "ATC starts 'J' (anti-infecciosos)", fillInput: { selector: '[name="mainForm:classif-atc_input"]', value: "J" } },
  { name: "atc-A", description: "ATC starts 'A' (digestivo)", fillInput: { selector: '[name="mainForm:classif-atc_input"]', value: "A" } },
  { name: "atc-D", description: "ATC starts 'D' (dermatológicos)", fillInput: { selector: '[name="mainForm:classif-atc_input"]', value: "D" } },
  { name: "atc-H", description: "ATC starts 'H' (hormonas)", fillInput: { selector: '[name="mainForm:classif-atc_input"]', value: "H" } },
  // Specific prefix
  { name: "atc-C09", description: "ATC C09 (IECA/ARA)", fillInput: { selector: '[name="mainForm:classif-atc_input"]', value: "C09" } },
  { name: "atc-J01", description: "ATC J01 (antibióticos)", fillInput: { selector: '[name="mainForm:classif-atc_input"]', value: "J01" } },
  // Titular
  { name: "titular-Bayer", description: "Titular Bayer", fillInput: { selector: '[name="mainForm:taim_input"]', value: "Bayer" } },
  { name: "titular-Sanofi", description: "Titular Sanofi", fillInput: { selector: '[name="mainForm:taim_input"]', value: "Sanofi" } },
  // Empty — listagem completa
  { name: "empty", description: "Pesquisa sem filtros (listagem completa)", fillInput: null },
];

function attach(page: Page, reqs: CapturedReq[], resps: CapturedRes[]): { off: () => void } {
  const onReq = (r: Request) => {
    if (!r.url().includes("INFOMED-fo")) return;
    reqs.push({ ts: new Date().toISOString(), method: r.method(), url: r.url(), postData: r.postData() });
  };
  const onRes = async (r: Response) => {
    if (!r.url().includes("INFOMED-fo")) return;
    let bytes = 0;
    let excerpt: string | null = null;
    try {
      const buf = await r.body();
      bytes = buf.length;
      excerpt = buf.toString("utf-8").slice(0, 3000);
    } catch {
      /* binary */
    }
    resps.push({ ts: new Date().toISOString(), url: r.url(), status: r.status(), bytes, excerpt });
  };
  page.on("request", onReq);
  page.on("response", onRes);
  return {
    off: () => {
      page.off("request", onReq);
      page.off("response", onRes);
    },
  };
}

async function inspectTable(page: Page): Promise<{
  rowCount: number;
  firstMedIds: string[];
  firstNames: string[];
  paginatorText: string | null;
  totalFromPaginator: number | null;
}> {
  return await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[id*="dt-medicamentos"] tr[data-ri]'));
    const medIds: string[] = [];
    const names: string[] = [];
    for (const r of rows.slice(0, 25)) {
      const cells = r.querySelectorAll("td");
      if (cells[0]) medIds.push(cells[0].textContent?.trim() ?? "");
      if (cells[1]) names.push((cells[1].textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40));
    }
    // Paginator: PrimeFaces normalmente tem .ui-paginator-current com algo como "1 a 25 de 1234"
    const paginatorEls = document.querySelectorAll(".ui-paginator-current");
    let paginatorText: string | null = null;
    let totalFromPaginator: number | null = null;
    for (const p of paginatorEls) {
      const text = (p as HTMLElement).innerText.replace(/\s+/g, " ").trim();
      if (text.length > 0) {
        paginatorText = text;
        const m = /de\s+(\d{1,7})/i.exec(text);
        if (m) totalFromPaginator = parseInt(m[1], 10);
        break;
      }
    }
    return { rowCount: rows.length, firstMedIds: medIds, firstNames: names, paginatorText, totalFromPaginator };
  });
}

async function main() {
  await ensureDir(OUT_DIR);
  console.log("─".repeat(74));
  console.log("Spike v2 — pesquisa-avancada (mainForm)");
  console.log("─".repeat(74));

  const browser = await chromium.launch({ headless: !process.argv.includes("--headful") });
  const ctx = await browser.newContext({ userAgent: USER_AGENT, locale: "pt-PT" });
  const page = await ctx.newPage();

  type ResultRow = {
    test: string;
    desc: string;
    rowsInTable: number;
    totalFromPaginator: number | null;
    paginatorText: string | null;
    firstMedIds: string[];
    firstNames: string[];
    postCount: number;
    notes: string[];
  };
  const results: ResultRow[] = [];

  // Carregar a página uma vez no início
  console.log(`\n[init] GET ${PESQ_URL}`);
  await page.goto(PESQ_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  // Cookies
  try {
    const btn = page.locator('button[id="cookiesButton"]');
    if (await btn.isVisible({ timeout: 1500 })) {
      await btn.click();
      await page.waitForTimeout(300);
    }
  } catch {
    /* ignore */
  }
  console.log(`    url: ${page.url()}`);
  console.log(`    title: ${await page.title()}`);

  // Verificar baseline da datatable (vazia ou pré-populada?)
  const baseline = await inspectTable(page);
  console.log(`    baseline rows: ${baseline.rowCount}  paginator: "${baseline.paginatorText ?? "(none)"}"`);

  for (const t of TESTS) {
    console.log(`\n  ─── ${t.description} ───`);
    const reqs: CapturedReq[] = [];
    const resps: CapturedRes[] = [];
    const handle = attach(page, reqs, resps);

    try {
      // Re-navegar fresh para reset
      await page.goto(PESQ_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(500);

      if (t.fillInput) {
        const el = page.locator(t.fillInput.selector).first();
        await el.waitFor({ state: "visible", timeout: 5000 }).catch(() => undefined);
        await el.fill(t.fillInput.value).catch(() => undefined);
        // Para autocomplete (ATC), esperar dropdown aparecer e ENTER
        await page.waitForTimeout(800);
      }

      // Submit
      await page.locator("#mainForm\\:btnDoSearch").click({ timeout: 8000 }).catch(() => undefined);
      // Espera AJAX renderizar a datatable
      await page.waitForTimeout(3500);

      const info = await inspectTable(page);
      const postCount = reqs.filter((r) => r.method === "POST").length;
      console.log(`    rows visíveis: ${info.rowCount}  total (paginator): ${info.totalFromPaginator ?? "?"}`);
      console.log(`    paginator text: "${info.paginatorText ?? "(none)"}"`);
      if (info.firstNames.length > 0) {
        console.log(`    primeiros nomes: ${info.firstNames.slice(0, 5).map((n) => `"${n}"`).join(", ")}`);
      }

      results.push({
        test: t.name,
        desc: t.description,
        rowsInTable: info.rowCount,
        totalFromPaginator: info.totalFromPaginator,
        paginatorText: info.paginatorText,
        firstMedIds: info.firstMedIds,
        firstNames: info.firstNames,
        postCount,
        notes: [],
      });

      // Guardar capturas para análise HTTP-only-replay
      const postReqs = reqs.filter((r) => r.method === "POST");
      const capture = {
        test: t.name,
        description: t.description,
        filter: t.fillInput,
        finalUrl: page.url(),
        postRequests: postReqs.map((r) => ({
          url: r.url,
          postData: r.postData,
        })),
        responses: resps.filter((r) => r.bytes > 1000).map((r) => ({
          url: r.url,
          status: r.status,
          bytes: r.bytes,
          excerpt: r.excerpt,
        })).slice(0, 5),
        tableInfo: info,
      };
      await fs.promises.writeFile(
        path.join(OUT_DIR, `v2-capture-${t.name}.json`),
        JSON.stringify(capture, null, 2),
        "utf-8",
      );
    } finally {
      handle.off();
    }
    // Polite delay
    await page.waitForTimeout(1500);
  }

  // Resumo
  console.log("\n[summary]");
  console.log(`${"test".padEnd(20)} ${"rows".padStart(5)} ${"total".padStart(7)} paginator`);
  console.log("─".repeat(74));
  for (const r of results) {
    console.log(
      `${r.test.padEnd(20)} ${String(r.rowsInTable).padStart(5)} ${String(r.totalFromPaginator ?? "?").padStart(7)} ${r.paginatorText ?? ""}`,
    );
  }

  await fs.promises.writeFile(
    path.join(OUT_DIR, "v2-summary.json"),
    JSON.stringify({ timestamp: new Date().toISOString(), tests: results }, null, 2),
    "utf-8",
  );

  await browser.close();
  console.log("\nSpike v2 completa.");
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
