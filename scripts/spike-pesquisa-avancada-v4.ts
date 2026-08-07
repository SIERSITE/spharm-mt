/**
 * scripts/spike-pesquisa-avancada-v4.ts
 *
 * P9 Spike v4 — duas confirmações decisivas:
 *
 *   1. `detalhes-medicamento.xhtml?<param>=<MED_ID>` funciona directamente?
 *      Testar variantes: ?med_id=, ?id=, ?med_guid=, ?guid= e sem param.
 *      Para 10 MED_IDs distintos (extraídos do search Bayer).
 *
 *   2. `rppDD` aceita mais que 10? Testar 25, 50, 100.
 *
 * Adicional:
 *   - Procurar pistas de med_guid no DOM da listagem (hidden inputs,
 *     data-* attributes, PrimeFaces selection state)
 *   - Capturar a chamada PrimeFaces.ab para extrair eventual med_guid
 *     do payload de resposta (XML partial-response)
 *
 * Scope: investigação apenas. Zero writes. Limita-se a ~20 GETs e ~5 POSTs.
 */

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { chromium, type Page, type Request, type Response } from "playwright";

const BASE = "https://extranet.infarmed.pt/INFOMED-fo";
const PESQ_URL = `${BASE}/pesquisa-avancada.xhtml`;
const DETAIL_URL = `${BASE}/detalhes-medicamento.xhtml`;
const OUT_DIR = path.resolve("scripts/data/spike-pesquisa-avancada-v4");
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

type DirectGetResult = {
  url: string;
  status: number;
  bytes: number;
  excerpt: string;
  hasDetailMarker: boolean; // page renderiza um medicamento válido?
  extractedNome: string | null;
};

async function ensureDir(p: string) {
  await fs.promises.mkdir(p, { recursive: true });
}

function parseDetailMarkers(html: string): { hasDetail: boolean; nome: string | null } {
  // Heuristics: detail page genuíno tem #detalheMedNomeMed ou markers
  const nomeMatch = /id="detalheMedNomeMed"[^>]*>([^<]+)</i.exec(html);
  const errorMarkers = /erro|n[aã]o encontrad|medicamento sem dados/i.test(html.slice(0, 5000));
  return {
    hasDetail: !!nomeMatch && !errorMarkers,
    nome: nomeMatch ? nomeMatch[1].trim() : null,
  };
}

async function main() {
  await ensureDir(OUT_DIR);
  console.log("─".repeat(74));
  console.log("Spike v4 — direct ?med_id=X + rppDD>10");
  console.log("─".repeat(74));

  const browser = await chromium.launch({ headless: !process.argv.includes("--headful") });
  const ctx = await browser.newContext({ userAgent: USER_AGENT, locale: "pt-PT" });
  const page = await ctx.newPage();

  // ── Phase 0: bootstrap session + submit Bayer search ──────────────
  console.log(`\n[0] Bootstrap session + Bayer search`);
  await page.goto(PESQ_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  try {
    const c = page.locator('button[id="cookiesButton"]');
    if (await c.isVisible({ timeout: 1500 })) {
      await c.click();
      await page.waitForTimeout(300);
    }
  } catch {
    /* ignore */
  }
  await page.locator('[name="mainForm:taim_input"]').fill("Bayer");
  await page.waitForTimeout(400);
  await page.locator("#mainForm\\:btnDoSearch").click();
  await page.waitForTimeout(3000);

  const initialPaginator = await page.evaluate(() => {
    const el = document.querySelector(".ui-paginator-current") as HTMLElement | null;
    return el?.innerText.trim() ?? null;
  });
  console.log(`    paginator: "${initialPaginator}"`);

  // ── Phase 1: extrair 10 MED_IDs distintos da listagem + procurar guid hints ──
  console.log(`\n[1] Inspeccionar rows: MED_ID + procurar med_guid hints`);
  const rowsData = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[id*="dt-medicamentos"] tr[data-ri]'));
    return rows.slice(0, 10).map((r) => {
      const cells = r.querySelectorAll("td");
      // Procurar qualquer atributo data-* na row e descendentes
      const allAttrs: Record<string, string> = {};
      const walker = document.createTreeWalker(r, NodeFilter.SHOW_ELEMENT);
      let node: Node | null = walker.currentNode;
      while (node) {
        if (node instanceof Element) {
          for (const a of Array.from(node.attributes)) {
            if (a.name.startsWith("data-") || /guid/i.test(a.value)) {
              allAttrs[`${node.tagName.toLowerCase()}@${a.name}`] = a.value.slice(0, 80);
            }
          }
        }
        node = walker.nextNode();
      }
      return {
        ri: r.getAttribute("data-ri"),
        medId: cells[0]?.textContent?.trim() ?? "",
        nome: (cells[1]?.textContent ?? "").trim().slice(0, 40),
        dataAttrs: allAttrs,
      };
    });
  });
  console.log(`    ${rowsData.length} rows lidas:`);
  for (const r of rowsData) {
    console.log(`      ri=${r.ri} medId=${r.medId} "${r.nome}"`);
  }
  await fs.promises.writeFile(
    path.join(OUT_DIR, "rows-with-attrs.json"),
    JSON.stringify(rowsData, null, 2),
    "utf-8",
  );

  // Verificar se há med_guid algures
  const guidAttrs = rowsData.flatMap((r) =>
    Object.entries(r.dataAttrs).filter(([k, v]) => /guid|uid/i.test(k) || /guid/i.test(v)),
  );
  console.log(`    med_guid hints em data-* attrs: ${guidAttrs.length}`);
  if (guidAttrs.length > 0) {
    console.log(`    ✓ Achados:`);
    for (const [k, v] of guidAttrs.slice(0, 5)) console.log(`      ${k}: ${v}`);
  }

  const medIds = rowsData.map((r) => r.medId).filter((v) => /^\d+$/.test(v));
  console.log(`\n    MED_IDs únicos para testar: ${medIds.join(", ")}`);

  // ── Phase 2: obter cookies + ViewState para HTTP GETs directos ────
  const cookies = await ctx.cookies();
  const jsessionCookie = cookies.find((c) => c.name === "JSESSIONID");
  console.log(`\n[2] Session cookies: JSESSIONID=${jsessionCookie?.value.slice(0, 40)}...`);

  // ── Phase 3: testar variantes de query parameter no detail URL ────
  console.log(`\n[3] Testar GET ${DETAIL_URL}?<param>=<MED_ID>`);
  const queryVariants = ["med_id", "id", "med_guid", "guid", "medId", "MED_ID"];

  // Capturar todos os requests/responses do detail
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

  type VariantTestRow = {
    paramName: string;
    medId: string;
    status: number;
    bytes: number;
    hasDetail: boolean;
    extractedNome: string | null;
  };
  const variantResults: VariantTestRow[] = [];

  // Para evitar excesso de requests, testar primeira variante com 10 IDs,
  // depois para variantes que NÃO funcionem testar apenas 1 ID
  for (const param of queryVariants) {
    const idsToTest = variantResults.length === 0 ? medIds : medIds.slice(0, 1);
    for (const id of idsToTest) {
      const url = `${DETAIL_URL}?${param}=${encodeURIComponent(id)}`;
      try {
        const resp = await ctx.request.get(url, {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept-Language": "pt-PT,pt;q=0.9",
            Cookie: cookieHeader,
          },
        });
        const body = await resp.text();
        const markers = parseDetailMarkers(body);
        variantResults.push({
          paramName: param,
          medId: id,
          status: resp.status(),
          bytes: body.length,
          hasDetail: markers.hasDetail,
          extractedNome: markers.nome,
        });
        // Guardar o primeiro response de cada variante
        if (idsToTest.length === medIds.length || param === queryVariants[0]) {
          await fs.promises.writeFile(
            path.join(OUT_DIR, `detail-${param}-${id}.html`),
            body.slice(0, 60000),
            "utf-8",
          );
        }
      } catch (err) {
        variantResults.push({
          paramName: param,
          medId: id,
          status: -1,
          bytes: 0,
          hasDetail: false,
          extractedNome: `[err: ${err instanceof Error ? err.message.slice(0, 40) : "?"}]`,
        });
      }
      await page.waitForTimeout(800); // polite
    }
  }

  console.log(`\n    Resultados:`);
  console.log(`    ${"param".padEnd(10)} ${"medId".padEnd(8)} ${"status".padStart(6)} ${"bytes".padStart(8)} hasDetail nome`);
  for (const r of variantResults) {
    console.log(
      `    ${r.paramName.padEnd(10)} ${r.medId.padEnd(8)} ${String(r.status).padStart(6)} ${String(r.bytes).padStart(8)} ${r.hasDetail ? "✓" : "✗"}        ${r.extractedNome ?? ""}`,
    );
  }

  await fs.promises.writeFile(
    path.join(OUT_DIR, "direct-get-results.json"),
    JSON.stringify(variantResults, null, 2),
    "utf-8",
  );

  // ── Phase 4: capturar o POST PrimeFaces.ab quando clicar uma row ──
  console.log(`\n[4] Click row → capturar PrimeFaces.ab POST + response`);
  const abCaptures: Array<{ url: string; postData: string | null; responseExcerpt: string | null }> = [];
  const onReq = (r: Request) => {
    if (r.method() === "POST" && r.url().endsWith("pesquisa-avancada.xhtml")) {
      abCaptures.push({ url: r.url(), postData: r.postData(), responseExcerpt: null });
    }
  };
  const onRes = async (r: Response) => {
    if (r.url().endsWith("pesquisa-avancada.xhtml") && r.request().method() === "POST") {
      try {
        const body = await r.body();
        if (abCaptures.length > 0) {
          abCaptures[abCaptures.length - 1].responseExcerpt = body.toString("utf-8").slice(0, 4000);
        }
      } catch {
        /* ignore */
      }
    }
  };
  page.on("request", onReq);
  page.on("response", onRes);

  // Clicar primeira row
  await page.locator('[id="mainForm:dt-medicamentos:0:linkNome"]').click().catch(() => undefined);
  await page.waitForTimeout(3000);

  // O click pode redirecionar para detalhes-medicamento.xhtml
  console.log(`    URL após click: ${page.url()}`);
  // Capturar set-cookie / session state
  const cookiesAfterClick = await ctx.cookies();
  const jsessionAfter = cookiesAfterClick.find((c) => c.name === "JSESSIONID");
  console.log(`    JSESSIONID antes: ${jsessionCookie?.value.slice(0, 20)}...`);
  console.log(`    JSESSIONID após:  ${jsessionAfter?.value.slice(0, 20)}...`);

  page.off("request", onReq);
  page.off("response", onRes);

  // Procurar med_guid na resposta do POST de click
  let medGuidFoundInResponse: string | null = null;
  for (const cap of abCaptures) {
    const exc = cap.responseExcerpt ?? "";
    const m = /med[_-]?guid["'>=\s]+([A-Za-z0-9_-]{8,})/i.exec(exc);
    if (m) {
      medGuidFoundInResponse = m[1];
      console.log(`    ✓ med_guid hint na response: ${medGuidFoundInResponse}`);
      break;
    }
  }
  if (!medGuidFoundInResponse) {
    console.log(`    ✗ med_guid NÃO presente na response do click`);
  }

  await fs.promises.writeFile(
    path.join(OUT_DIR, "click-captures.json"),
    JSON.stringify(abCaptures, null, 2),
    "utf-8",
  );

  // ── Phase 5: testar rppDD aumentado ──────────────────────────────
  console.log(`\n[5] Testar rppDD = 25, 50, 100`);
  // Voltar à listagem
  await page.goto(PESQ_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(500);
  await page.locator('[name="mainForm:taim_input"]').fill("Bayer");
  await page.waitForTimeout(400);
  await page.locator("#mainForm\\:btnDoSearch").click();
  await page.waitForTimeout(3000);

  // Verificar se rppDD existe pós-submit
  const rppSelectInfo = await page.evaluate(() => {
    const select = document.getElementById("mainForm:dt-medicamentos_rppDD") as HTMLSelectElement | null;
    if (!select) return { exists: false, options: [], currentValue: null };
    const options = Array.from(select.options).map((o) => ({ value: o.value, text: o.textContent?.trim() ?? "" }));
    return { exists: true, options, currentValue: select.value };
  });
  console.log(`    rppDD exists: ${rppSelectInfo.exists}`);
  console.log(`    rppDD options: ${JSON.stringify(rppSelectInfo.options)}`);

  type RppTestRow = { rpp: number; rowsObserved: number; paginator: string | null };
  const rppResults: RppTestRow[] = [];

  for (const target of [25, 50, 100]) {
    console.log(`\n    -- tentar rppDD=${target} --`);
    try {
      // Se o option existe, seleccionar via UI
      const validOption = rppSelectInfo.options.find((o) => parseInt(o.value, 10) === target);
      if (validOption) {
        await page.selectOption("#mainForm\\:dt-medicamentos_rppDD", String(target));
        await page.waitForTimeout(3000);
      } else {
        // Forçar via JS — pode falhar mas vale a pena tentar
        console.log(`    option ${target} não está no dropdown — forçando via JS`);
        const wasForced = await page.evaluate((val) => {
          const sel = document.getElementById("mainForm:dt-medicamentos_rppDD") as HTMLSelectElement | null;
          if (!sel) return false;
          // Adiciona option se não existe
          let opt = Array.from(sel.options).find((o) => o.value === String(val));
          if (!opt) {
            opt = new Option(String(val), String(val));
            sel.add(opt);
          }
          sel.value = String(val);
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }, target);
        if (wasForced) await page.waitForTimeout(3000);
      }
      const rows = await page.evaluate(() => {
        const rs = Array.from(document.querySelectorAll('[id*="dt-medicamentos"] tr[data-ri]'));
        return rs.length;
      });
      const pag = await page.evaluate(() => {
        const el = document.querySelector(".ui-paginator-current") as HTMLElement | null;
        return el?.innerText.trim() ?? null;
      });
      console.log(`      rows observadas: ${rows}  paginator: "${pag}"`);
      rppResults.push({ rpp: target, rowsObserved: rows, paginator: pag });
    } catch (err) {
      console.log(`      erro: ${err instanceof Error ? err.message : "?"}`);
      rppResults.push({ rpp: target, rowsObserved: 0, paginator: null });
    }
  }

  await fs.promises.writeFile(
    path.join(OUT_DIR, "rpp-results.json"),
    JSON.stringify({ rppSelectInfo, rppResults }, null, 2),
    "utf-8",
  );

  await browser.close();
  console.log("\n" + "─".repeat(74));
  console.log("Spike v4 completa.");
  console.log("─".repeat(74));
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
