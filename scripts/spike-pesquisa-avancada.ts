/**
 * scripts/spike-pesquisa-avancada.ts
 *
 * P9 Spike — investigação do `pesquisa-avancada-form` no INFOMED.
 *
 * Objectivo: descobrir se o form alternativo de pesquisa avançada
 * permite filtros por ATC / titular / forma / DCI e devolve N med_guids
 * por POST (em vez do 1 por search-by-CNP actual).
 *
 * Scope:
 *   · Investigação apenas. Zero escritas em BD. Zero impacto produção.
 *   · Limita-se a ~10–20 submissões para não pressionar anti-bot.
 *   · Captura DOM da form + network requests + responses.
 *   · Tenta HTTP-only replay duma submissão bem-sucedida.
 *
 * Output:
 *   · scripts/data/spike-pesquisa-avancada/<filter>.json — captura por filtro
 *   · scripts/data/spike-pesquisa-avancada/form-dom-snapshot.html
 *   · scripts/data/spike-pesquisa-avancada/index.json — sumário cross-filter
 *
 * Uso:
 *   npx tsx scripts/spike-pesquisa-avancada.ts
 *   npx tsx scripts/spike-pesquisa-avancada.ts --headful
 */

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { chromium, type Page, type Request, type Response } from "playwright";

const BASE = "https://extranet.infarmed.pt/INFOMED-fo";
const INDEX_URL = `${BASE}/index.xhtml`;
const PESQ_URL = `${BASE}/pesquisa-avancada.xhtml`;
const OUT_DIR = path.resolve("scripts/data/spike-pesquisa-avancada");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

type CapturedReq = {
  ts: string;
  method: string;
  url: string;
  postData: string | null;
  resourceType: string;
  headers: Record<string, string>;
};

type CapturedRes = {
  ts: string;
  url: string;
  status: number;
  contentType: string;
  bodyBytes: number;
  bodyExcerpt: string | null;
};

type SpikeCapture = {
  filter: string;
  filterDescription: string;
  requests: CapturedReq[];
  responses: CapturedRes[];
  rowsInTable: number;
  firstMedGuidsInTable: string[];
  finalUrl: string;
  paginationDetected: boolean;
  paginationDetails: string | null;
  bodyExcerptOfListagem: string | null;
  notes: string[];
};

function args() {
  return {
    headful: process.argv.includes("--headful"),
  };
}

function attachListeners(
  page: Page,
  reqs: CapturedReq[],
  resps: CapturedRes[],
): void {
  page.on("request", (r: Request) => {
    if (!r.url().includes("INFOMED-fo")) return;
    reqs.push({
      ts: new Date().toISOString(),
      method: r.method(),
      url: r.url(),
      postData: r.postData(),
      resourceType: r.resourceType(),
      headers: r.headers(),
    });
  });
  page.on("response", async (r: Response) => {
    if (!r.url().includes("INFOMED-fo")) return;
    let body = "";
    let bytes = 0;
    try {
      const buf = await r.body();
      bytes = buf.length;
      body = buf.toString("utf-8").slice(0, 4000);
    } catch {
      // binary
    }
    resps.push({
      ts: new Date().toISOString(),
      url: r.url(),
      status: r.status(),
      contentType: r.headers()["content-type"] ?? "",
      bodyBytes: bytes,
      bodyExcerpt: body,
    });
  });
}

async function ensureDir(p: string): Promise<void> {
  await fs.promises.mkdir(p, { recursive: true });
}

async function main(): Promise<void> {
  const cli = args();
  await ensureDir(OUT_DIR);
  console.log("─".repeat(74));
  console.log("Spike — pesquisa-avancada-form");
  console.log("─".repeat(74));
  console.log(`  headful: ${cli.headful}`);
  console.log(`  out:     ${OUT_DIR}`);

  const browser = await chromium.launch({ headless: !cli.headful });
  const context = await browser.newContext({ userAgent: USER_AGENT, locale: "pt-PT" });
  const page = await context.newPage();

  const globalRequests: CapturedReq[] = [];
  const globalResponses: CapturedRes[] = [];
  attachListeners(page, globalRequests, globalResponses);

  // ── Phase 0: GET index.xhtml para bootstrapping de sessão ─────────
  console.log(`\n[0] GET ${INDEX_URL}`);
  await page.goto(INDEX_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(500);
  // Aceitar cookies se aparecer
  try {
    const btn = page.locator('button[id="cookiesButton"]');
    if (await btn.isVisible({ timeout: 1500 })) {
      await btn.click();
      await page.waitForTimeout(300);
    }
  } catch {
    /* ignore */
  }

  // ── Phase 1: navegar para pesquisa-avancada.xhtml ─────────────────
  console.log(`\n[1] Navegar para ${PESQ_URL}`);
  const navResp = await page.goto(PESQ_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  console.log(`    status: ${navResp?.status() ?? "?"}`);
  console.log(`    url:    ${page.url()}`);

  // Se foi 403/redirect para login, tentar via fluxo do form principal
  if (page.url().includes("index.xhtml") || (navResp && navResp.status() >= 400)) {
    console.log(`    [aviso] redirect ou erro — tentar bootstrap via index submit`);
    await page.goto(INDEX_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);
    // Submeter qualquer termo só para abrir sessão
    const input = page.locator('input[name="mainForm:acMinLength_input"]');
    if (await input.isVisible({ timeout: 3000 }).catch(() => false)) {
      await input.fill("Brufen");
      await page.waitForTimeout(800);
      // Submeter o form lupa
      await page.locator('#mainForm\\:ajax').click().catch(() => undefined);
      await page.waitForTimeout(2000);
    }
    // Tentar novamente
    await page.goto(PESQ_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    console.log(`    re-tentativa url: ${page.url()}`);
  }

  // ── Phase 2: capturar estrutura do form ───────────────────────────
  console.log(`\n[2] Snapshot DOM do pesquisa-avancada`);
  const dom = await page.content();
  await fs.promises.writeFile(path.join(OUT_DIR, "form-dom-snapshot.html"), dom, "utf-8");
  console.log(`    bytes HTML: ${dom.length}`);

  const formInfo = await page.evaluate(() => {
    const out: Array<{
      formId: string;
      action: string | null;
      inputs: Array<{ id: string; name: string; type: string; placeholder: string | null; tag: string }>;
      buttons: Array<{ id: string; type: string; text: string }>;
    }> = [];
    const forms = Array.from(document.querySelectorAll("form"));
    for (const f of forms) {
      const inputs = Array.from(f.querySelectorAll("input, select, textarea")).map((el) => {
        const e = el as HTMLInputElement;
        return {
          id: e.id || "",
          name: e.name || "",
          type: e.type || el.tagName.toLowerCase(),
          placeholder: e.placeholder || null,
          tag: el.tagName.toLowerCase(),
        };
      });
      const buttons = Array.from(f.querySelectorAll("button, input[type=submit], input[type=button]")).map((el) => {
        const e = el as HTMLButtonElement;
        return { id: e.id || "", type: e.type || "", text: (e.textContent ?? "").trim().slice(0, 50) };
      });
      out.push({
        formId: f.id || "",
        action: f.getAttribute("action"),
        inputs,
        buttons,
      });
    }
    return out;
  });

  await fs.promises.writeFile(
    path.join(OUT_DIR, "form-structure.json"),
    JSON.stringify(formInfo, null, 2),
    "utf-8",
  );
  console.log(`    forms detectados: ${formInfo.length}`);
  for (const f of formInfo) {
    console.log(`      · form id="${f.formId}" inputs=${f.inputs.length} buttons=${f.buttons.length}`);
  }

  // Identificar especificamente pesquisa-avancada-form
  const pesqForm = formInfo.find((f) => f.formId.includes("pesquisa-avancada"));
  if (!pesqForm) {
    console.log(`\n[fatal] pesquisa-avancada-form NÃO encontrado no DOM.`);
    console.log(`Forms presentes:`);
    formInfo.forEach((f) => console.log(`  - ${f.formId}`));
    await fs.promises.writeFile(
      path.join(OUT_DIR, "result.json"),
      JSON.stringify(
        { ok: false, reason: "pesquisa-avancada-form ausente", forms: formInfo.map((f) => f.formId) },
        null,
        2,
      ),
    );
    await browser.close();
    return;
  }
  console.log(`\n    ✓ pesquisa-avancada-form encontrado`);
  console.log(`      Inputs:`);
  for (const i of pesqForm.inputs.slice(0, 20)) {
    console.log(
      `        ${i.tag.padEnd(8)} ${i.type.padEnd(10)} name="${i.name}" id="${i.id}" ph="${i.placeholder ?? ""}"`,
    );
  }
  console.log(`      Buttons:`);
  for (const b of pesqForm.buttons) {
    console.log(`        ${b.type.padEnd(10)} id="${b.id}" text="${b.text}"`);
  }

  // ── Phase 3: identificar inputs por aproximação semântica ─────────
  // ATC: input cujo placeholder/label contém "ATC"
  // DCI: placeholder/label contém "DCI"
  // Titular: contém "titular" ou "fabricante"
  // Forma: contém "forma"
  const findInput = (matchRegex: RegExp) =>
    pesqForm.inputs.find(
      (i) =>
        (i.placeholder && matchRegex.test(i.placeholder)) ||
        (i.name && matchRegex.test(i.name)) ||
        (i.id && matchRegex.test(i.id)),
    );

  const atcInput = findInput(/atc/i);
  const dciInput = findInput(/dci|substanc/i);
  const titularInput = findInput(/titular|fabricant/i);
  const formaInput = findInput(/forma/i);
  const nomeInput = findInput(/nome|design/i);

  console.log(`\n[3] Inputs identificados:`);
  console.log(`    ATC:      ${atcInput?.name ?? "(não encontrado)"}`);
  console.log(`    DCI:      ${dciInput?.name ?? "(não encontrado)"}`);
  console.log(`    Titular:  ${titularInput?.name ?? "(não encontrado)"}`);
  console.log(`    Forma:    ${formaInput?.name ?? "(não encontrado)"}`);
  console.log(`    Nome:     ${nomeInput?.name ?? "(não encontrado)"}`);

  // ── Phase 4: testar filtros ───────────────────────────────────────
  const tests: Array<{ name: string; filter: string; description: string }> = [];
  if (atcInput) {
    for (const prefix of ["C", "N", "J", "A", "D", "H"]) {
      tests.push({ name: `atc-${prefix}`, filter: prefix, description: `ATC prefix "${prefix}"` });
    }
    // Tentar prefixos mais específicos
    tests.push({ name: "atc-C09", filter: "C09", description: "ATC C09 (IECA/ARA)" });
    tests.push({ name: "atc-J01", filter: "J01", description: "ATC J01 (antibióticos)" });
  } else {
    console.log(`\n[aviso] sem input ATC — saltar testes ATC`);
  }
  if (titularInput) {
    tests.push({ name: "titular-Bayer", filter: "Bayer", description: "Titular contém 'Bayer'" });
    tests.push({ name: "titular-Sanofi", filter: "Sanofi", description: "Titular contém 'Sanofi'" });
  }
  if (formaInput) {
    tests.push({ name: "forma-Comprimido", filter: "Comprimido", description: "Forma=Comprimido" });
  }
  tests.push({ name: "empty", filter: "", description: "(pesquisa vazia — listagem completa?)" });

  const captures: SpikeCapture[] = [];

  const submitButton =
    pesqForm.buttons.find((b) => /pesqui|btnPesquis|submit|enviar/i.test(b.id + " " + b.text))?.id ??
    pesqForm.buttons[0]?.id ??
    "";
  console.log(`\n[4] Submit button identificado: id="${submitButton}"`);

  for (const t of tests) {
    console.log(`\n  ─── teste: ${t.description} ───`);
    const localReqs: CapturedReq[] = [];
    const localResps: CapturedRes[] = [];
    const onReq = (r: Request) => {
      if (!r.url().includes("INFOMED-fo")) return;
      localReqs.push({
        ts: new Date().toISOString(),
        method: r.method(),
        url: r.url(),
        postData: r.postData(),
        resourceType: r.resourceType(),
        headers: r.headers(),
      });
    };
    const onRes = async (r: Response) => {
      if (!r.url().includes("INFOMED-fo")) return;
      let body = "";
      let bytes = 0;
      try {
        const buf = await r.body();
        bytes = buf.length;
        body = buf.toString("utf-8").slice(0, 4000);
      } catch {
        /* binary */
      }
      localResps.push({
        ts: new Date().toISOString(),
        url: r.url(),
        status: r.status(),
        contentType: r.headers()["content-type"] ?? "",
        bodyBytes: bytes,
        bodyExcerpt: body,
      });
    };
    page.on("request", onReq);
    page.on("response", onRes);

    try {
      // Re-navegar fresh para reset do form
      await page.goto(PESQ_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(600);

      // Preencher o input relevante
      let target: typeof atcInput | undefined;
      if (t.name.startsWith("atc")) target = atcInput;
      else if (t.name.startsWith("titular")) target = titularInput;
      else if (t.name.startsWith("forma")) target = formaInput;

      if (target && t.filter) {
        const locator = page.locator(`[name="${target.name}"]`).first();
        await locator.fill(t.filter).catch(() => undefined);
      }

      // Submit
      if (submitButton) {
        await page.locator(`#${CSS.escape(submitButton)}`).click({ timeout: 5000 }).catch(() => undefined);
      } else {
        await page.keyboard.press("Enter");
      }
      await page.waitForTimeout(3000);

      // Contar rows na datatable
      const tableInfo = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('[id*="dt-medicamentos"] tr[data-ri]'));
        const allRows = rows.map((r) => r.getAttribute("data-ri"));
        // Extrair MED_ID (1ª célula hidden) das primeiras rows como proxy de med_guid
        const guidsLike: string[] = [];
        for (const row of rows.slice(0, 20)) {
          const firstCell = row.querySelector("td");
          if (firstCell) guidsLike.push(firstCell.textContent?.trim() ?? "");
        }
        // Paginação
        const paginators = Array.from(document.querySelectorAll(".ui-paginator"));
        let pagInfo: string | null = null;
        if (paginators.length > 0) {
          const text = paginators.map((p) => (p as HTMLElement).innerText.replace(/\s+/g, " ").trim()).join(" | ");
          pagInfo = text.slice(0, 200);
        }
        return { rowCount: allRows.length, guidsLike, pagInfo };
      });

      console.log(`    rows na datatable: ${tableInfo.rowCount}`);
      console.log(`    primeiros MED_IDs: ${tableInfo.guidsLike.slice(0, 5).join(", ")}`);
      console.log(`    paginação: ${tableInfo.pagInfo ?? "(sem paginator)"}`);

      const cap: SpikeCapture = {
        filter: t.filter,
        filterDescription: t.description,
        requests: localReqs,
        responses: localResps,
        rowsInTable: tableInfo.rowCount,
        firstMedGuidsInTable: tableInfo.guidsLike,
        finalUrl: page.url(),
        paginationDetected: !!tableInfo.pagInfo,
        paginationDetails: tableInfo.pagInfo,
        bodyExcerptOfListagem: null,
        notes: [],
      };

      // Guardar excerpt do HTML pós-submit
      const html = await page.content();
      cap.bodyExcerptOfListagem = html.slice(0, 6000);

      captures.push(cap);
      await fs.promises.writeFile(
        path.join(OUT_DIR, `capture-${t.name}.json`),
        JSON.stringify(cap, null, 2),
        "utf-8",
      );
    } finally {
      page.off("request", onReq);
      page.off("response", onRes);
    }

    // Polite delay entre submissões
    await page.waitForTimeout(1500);
  }

  // ── Phase 5: resumo cross-filtros ──────────────────────────────────
  console.log("\n[5] Resumo cross-filtros:");
  const summary = captures.map((c) => ({
    filter: c.filterDescription,
    rows: c.rowsInTable,
    pagination: c.paginationDetected ? c.paginationDetails : null,
    postRequests: c.requests.filter((r) => r.method === "POST").length,
    sampleGuid: c.firstMedGuidsInTable[0] ?? null,
  }));
  for (const s of summary) {
    console.log(
      `  ${(s.filter ?? "").padEnd(36)} rows=${String(s.rows).padStart(4)} pag=${s.pagination ? "Y" : "N"} POSTs=${s.postRequests}`,
    );
  }
  await fs.promises.writeFile(
    path.join(OUT_DIR, "summary.json"),
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        formStructure: pesqForm,
        captures: summary,
        recommendations: [],
      },
      null,
      2,
    ),
    "utf-8",
  );

  await browser.close();
  console.log("\n" + "─".repeat(74));
  console.log(`Spike completa. Outputs em ${OUT_DIR}`);
  console.log("─".repeat(74));
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
