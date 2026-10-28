/**
 * scripts/e2e/margens-stock-browser.ts
 *
 * Browser REAL (Chromium) contra o build de PRODUÇÃO (dados sintéticos): coluna «Stock» no mapa de Margens.
 *   · 1920×1080, 1536×864 e 1366×768: coluna visível logo a seguir a Qtd, sem cabeçalho truncado, alinhada, cabeçalho
 *     fixo; abaixo de 1920 há scroll horizontal (barra no topo) e CNP/Descrição ficam fixos;
 *   · positivo / zero (caixa) / negativo (escuro) / desconhecido («—», nunca 0);
 *   · «Stock total» (resumo superior) = soma das linhas do mapa, uma vez por produto/farmácia;
 *   · coluna ordenável; a expansão CNPEM mostra o stock no ecrã mas não altera o total;
 *   · PDF e Excel trazem a coluna Stock e o TOTAL ARTIGO correto (sem a expansão CNPEM).
 * Grava capturas em docs/validacao-visual/2026-10-margens-stock/. NÃO foi executado pelo autor.
 *
 * Pré-requisito: `npx next build` com SERVER_ACTIONS_ALLOWED_ORIGINS="localhost:3100,127.0.0.1:3100,*.localhost:3100".
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/e2e/margens-stock-browser.ts
 */
import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { chromium, type Page } from "playwright";
import { baseFor, criarAmbiente } from "./_ambiente-silveira";
import { abrirContexto } from "./_grupo-comum";
import { alinhamentoColunas, atualizarMargens, CNP, estadoCabecalho, semearMargens } from "./_margens-comum";

let ok = 0;
let falhas = 0;
const check = (cond: boolean, msg: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${msg}`); }
  else { falhas++; console.log(`  [FALHA] ${msg}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const secao = (t: string) => console.log(`\n── ${t}`);
const EVID = path.resolve("docs/validacao-visual/2026-10-margens-stock");
const SEL = '[data-testid="tabela-margens-produto"]';

async function gerar(page: Page) {
  await page.goto(baseFor("silveira") + "/relatorios/margens", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Gerar", exact: true }).click();
  await page.locator(SEL).waitFor({ timeout: 60000 });
}

/** Stock por linha do mapa principal (exclui as linhas da expansão CNPEM): cnp@farmácia → texto da célula e estado. */
const stockDasLinhas = (page: Page) =>
  page.locator(`${SEL} tbody > tr:not([data-tabela-linha])`).evaluateAll((trs) =>
    trs.map((t) => {
      const td = t.querySelector('td[data-col="stock"]') as HTMLElement;
      const marca = td.querySelector("[data-stock]") as HTMLElement | null;
      return { cnp: (t as HTMLElement).dataset.cnp!, farmacia: (t as HTMLElement).dataset.farmacia!, texto: td.innerText.trim(), estado: marca?.dataset.stock ?? "" };
    }),
  );

const numero = (t: string) => Number(t.replace(/\s/g, "").replace("−", "-").replace(",", "."));

async function main() {
  fs.mkdirSync(EVID, { recursive: true });
  const amb = await criarAmbiente("mstk");
  const browser = await chromium.launch();
  try {
    const seed = await semearMargens(amb);
    // Casos de stock: zero, negativo e desconhecido (os restantes ficam positivos).
    const prisma = amb.prisma;
    const produto = async (cnp: number) => (await prisma.produto.findFirstOrThrow({ where: { cnp } })).id;
    await prisma.produtoFarmacia.updateMany({ where: { produtoId: await produto(CNP.ABC) }, data: { stockAtual: 0 } });
    await prisma.produtoFarmacia.updateMany({ where: { produtoId: await produto(CNP.ACIDO) }, data: { stockAtual: -2 } });
    await prisma.produtoFarmacia.updateMany({ where: { produtoId: await produto(CNP.SEM_CUSTO) }, data: { stockAtual: null } });

    const ctx = await abrirContexto(amb, browser, { userId: seed.userId } as never);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

    for (const [w, h] of [[1920, 1080], [1536, 864], [1366, 768]] as const) {
      secao(`${w}×${h}`);
      await page.setViewportSize({ width: w, height: h });
      await gerar(page);

      const ths = await page.locator(`${SEL} thead th`).evaluateAll((els) => els.map((t) => ({ texto: (t as HTMLElement).innerText.replace(/\s+/g, " ").trim(), cortado: !!(t.querySelector("span.truncate") && (t.querySelector("span.truncate") as HTMLElement).scrollWidth > (t.querySelector("span.truncate") as HTMLElement).clientWidth + 1) })));
      const nomes = ths.map((t) => t.texto);
      const iQtd = nomes.findIndex((n) => /^Qtd/i.test(n));
      check(iQtd >= 0 && /^Stock/i.test(nomes[iQtd + 1] ?? ""), `a coluna «Stock» vem logo a seguir a «Qtd» (${nomes.slice(iQtd, iQtd + 3).join(" | ")})`);
      check(ths.length === 19, `19 colunas no ecrã (${ths.length})`);
      check(ths.every((t) => !t.cortado), "nenhum cabeçalho truncado");
      const al = await alinhamentoColunas(page, SEL);
      check(al.maxDesvio <= 1.5, `cabeçalho e células alinhados (${al.colunas} colunas, desvio ${al.maxDesvio}px)`);
      const dim = await page.evaluate((sel) => { const c = document.querySelector(sel) as HTMLElement; return { sw: c.scrollWidth, cw: c.clientWidth }; }, SEL);
      if (w === 1920) check(dim.sw <= dim.cw + 1, `cabe sem scroll horizontal (${dim.sw}px ≤ ${dim.cw}px)`);
      else {
        check(dim.sw > dim.cw, `não cabe (${dim.sw}px > ${dim.cw}px) → scroll horizontal`);
        check(await page.locator('[data-testid="barra-scroll-topo"]').isVisible(), "barra de scroll horizontal no topo visível");
        await page.evaluate((sel) => { (document.querySelector(sel) as HTMLElement).scrollLeft = 300; }, SEL);
        const fixas = await page.evaluate((sel) => {
          const c = document.querySelector(sel) as HTMLElement; const cr = c.getBoundingClientRect();
          const q = (css: string) => (c.querySelector(css) as HTMLElement).getBoundingClientRect().left - cr.left;
          return { cnp: q("thead th.col-cnp"), desc: q("thead th.col-desc") };
        }, SEL);
        check(Math.abs(fixas.cnp - 32) <= 2 && Math.abs(fixas.desc - 116) <= 2, `CNP e Descrição ficam fixos com a tabela deslocada (${fixas.cnp.toFixed(0)}, ${fixas.desc.toFixed(0)})`);
        await page.evaluate((sel) => { (document.querySelector(sel) as HTMLElement).scrollLeft = 0; }, SEL);
      }
      await page.locator(SEL).scrollIntoViewIfNeeded();
      await page.evaluate((sel) => { const c = document.querySelector(sel) as HTMLElement; window.scrollBy(0, c.getBoundingClientRect().top - 70); c.scrollTop = 600; }, SEL);
      const hc = await estadoCabecalho(page, SEL);
      check(Math.abs(hc.desvioTopo) <= 1 && hc.visivelPorCima && hc.opaco, "cabeçalho fixo no scroll vertical");
      await page.evaluate((sel) => { (document.querySelector(sel) as HTMLElement).scrollTop = 0; window.scrollTo(0, 0); }, SEL);
      await page.screenshot({ path: path.join(EVID, `margens-stock-${w}x${h}.png`) });
    }

    // ═══ valores e total (1920) ═══
    secao("valores: positivo / zero / negativo / desconhecido e total");
    await page.setViewportSize({ width: 1920, height: 1080 });
    await gerar(page);
    const linhas = await stockDasLinhas(page);
    const de = (cnp: number) => linhas.filter((l) => l.cnp === String(cnp));
    check(de(CNP.ABC)[0]?.estado === "zero" && de(CNP.ABC)[0]?.texto === "0", "stock 0: pastilha «zero» com «0»");
    check(de(CNP.ACIDO)[0]?.estado === "negativo" && numero(de(CNP.ACIDO)[0]?.texto ?? "") === -2, "stock negativo: pastilha escura com o sinal");
    check(de(CNP.SEM_CUSTO)[0]?.estado === "desconhecido" && de(CNP.SEM_CUSTO)[0]?.texto === "—", "stock desconhecido: «—» (nunca 0)");
    check(de(CNP.A).length === 2 && de(CNP.A).every((l) => l.estado === "positivo" && numero(l.texto) === 40), "artigo em duas farmácias: 40 em cada linha (uma vez por farmácia)");
    const soma = linhas.reduce((s, l) => s + (l.estado === "desconhecido" ? 0 : numero(l.texto)), 0);
    const semStock = linhas.filter((l) => l.estado === "desconhecido").length;
    const kpi = page.locator("section.grid > div", { hasText: "Stock total" }).first();
    const textoKpi = (await kpi.innerText()).replace(/\s+/g, " ");
    check(numero(textoKpi.replace(/Stock total/i, "").trim().split(" ")[0]) === soma, `«Stock total» = soma das linhas (${soma}): «${textoKpi}»`);
    check(semStock === 0 || /Parcial/.test(textoKpi), `o resumo avisa que é parcial (${semStock} linha sem stock conhecido)`);
    await page.screenshot({ path: path.join(EVID, "margens-stock-valores.png") });

    // ═══ ordenação ═══
    secao("ordenação pela coluna Stock");
    await page.locator(`${SEL} thead th button`, { hasText: /^Stock/ }).first().click();
    const asc = (await stockDasLinhas(page)).filter((l) => l.estado !== "desconhecido").map((l) => numero(l.texto));
    check(asc.length > 1 && asc.every((v, i) => i === 0 || asc[i - 1] <= v), `ordem ascendente (${asc.slice(0, 4).join(", ")}…)`);
    await page.locator(`${SEL} thead th button`, { hasText: /^Stock/ }).first().click();
    const desc = (await stockDasLinhas(page)).filter((l) => l.estado !== "desconhecido").map((l) => numero(l.texto));
    check(desc.every((v, i) => i === 0 || desc[i - 1] >= v), `ordem descendente (${desc.slice(0, 4).join(", ")}…)`);

    // ═══ expansão CNPEM: mostra stock, não altera totais ═══
    secao("expansão CNPEM: stock visível no ecrã, totais intactos");
    await page.locator(".tabela-margens thead th button", { hasText: /^CNP/ }).first().click(); // ordena por CNP (só para sair da ordem por Stock)
    await page.getByPlaceholder("Pesquisar CNP ou descrição").fill(String(CNP.A));
    await atualizarMargens(page);
    const kpiAntes = (await page.locator("section.grid > div", { hasText: "Stock total" }).first().innerText()).replace(/\s+/g, " ");
    await page.locator(`${SEL} tbody > tr[data-cnp="${CNP.A}"][data-farmacia="${seed.nomes.alfa}"]:not([data-tabela-linha]) [data-testid="expandir-cnpem"]`).click();
    await page.locator('[data-testid="comparacao-contagem"]').waitFor({ timeout: 20000 });
    await page.locator('[data-testid="comparacao-mostrar-todos"]').check();
    await page.waitForFunction((f) => !!document.querySelector(`tr[data-tabela-linha^="comparacao"][data-cnp="${f}"]`), String(CNP.F), { timeout: 20000 });
    const cmp = await page.locator('tr[data-tabela-linha^="comparacao"][data-cnp] td[data-col="stock"]').evaluateAll((tds) => tds.map((t) => (t as HTMLElement).innerText.trim()));
    check(cmp.length >= 3 && cmp.every((t) => t !== ""), `as linhas da expansão mostram o stock da sua farmácia (${cmp.join(" | ")})`);
    const kpiDepois = (await page.locator("section.grid > div", { hasText: "Stock total" }).first().innerText()).replace(/\s+/g, " ");
    check(kpiAntes === kpiDepois, `o «Stock total» não muda com a expansão nem com «Mostrar todos» (${kpiAntes})`);
    await page.screenshot({ path: path.join(EVID, "margens-stock-expansao-cnpem.png") });

    // ═══ PDF e Excel ═══
    secao("PDF e Excel: coluna Stock e TOTAL ARTIGO, sem a expansão");
    const [reqPdf] = await Promise.all([
      page.waitForRequest((r) => r.url().includes("/api/reports/pdf"), { timeout: 120000 }),
      page.getByRole("button", { name: /^PDF$/ }).first().click(),
    ]);
    const corpo = reqPdf.postDataBuffer()!.toString("utf8");
    check(/Stock/.test(corpo) && /Stock total/.test(corpo), "o relatório do PDF tem a coluna e o resumo «Stock total»");
    check(!/IBUPROFENO B 400|Mesmo CNPEM|Produto analisado/.test(corpo), "…sem a expansão CNPEM");
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.getByRole("button", { name: /^Excel$/ }).first().click()]);
    const xp = path.join(EVID, "margens-stock.xlsx");
    await dl.saveAs(xp);
    const wb = XLSX.read(fs.readFileSync(xp));
    const grelha = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, blankrows: false }) as unknown[][];
    const cab = grelha.findIndex((l) => l.includes("Stock"));
    check(cab >= 0, "o Excel tem a coluna «Stock»");
    const col = grelha[cab].indexOf("Stock");
    const dadosA = grelha.slice(cab + 1).filter((l) => String(l[0]) === String(CNP.A) || String(l[0]) === "");
    const valoresA = dadosA.map((l) => l[col]).filter((v) => typeof v === "number");
    check(valoresA.filter((v) => v === 40).length === 2, `Excel: artigo A com 40 em cada farmácia (${valoresA.join(", ")})`);
    fs.rmSync(xp);
  } catch (e) {
    console.log(["--- logs do servidor ---", amb.logs().slice(-3000)].join("\n"));
    throw e;
  } finally {
    await browser.close();
    await amb.parar();
  }
  console.log(`\n${falhas === 0 ? "PASSOU" : "FALHOU"} — ${ok} OK, ${falhas} falhas\n`);
  process.exit(falhas === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
