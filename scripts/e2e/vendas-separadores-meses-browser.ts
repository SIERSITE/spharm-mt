/**
 * scripts/e2e/vendas-separadores-meses-browser.ts
 *
 * Browser REAL (Chromium) contra o build de PRODUÇÃO (control plane + PostgreSQL descartáveis, dados sintéticos): separadores
 * verticais finos entre as colunas dos meses do mapa de Vendas — Relatório (3 resoluções), impressão, PDF real do endpoint (com
 * fundos) e PDF da impressão SEM fundos (simula «Imprimir gráficos de fundo» desligado), 3/13/14/27 meses, quatro combinações de
 * preços e documento de várias páginas. Pixéis medidos com PyMuPDF (scripts/tests/_verticais-meses.ts).
 *
 *   SO_CAPTURA=antes  → só capturas (antes-*.png/pdf), sem asserções (corre-se no SHA anterior, para o antes/depois).
 *
 * Pré-requisito: `npx next build` com SERVER_ACTIONS_ALLOWED_ORIGINS="localhost:3100,127.0.0.1:3100,*.localhost:3100".
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/e2e/vendas-separadores-meses-browser.ts
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { chromium } from "playwright";
import { baseFor, criarAmbiente } from "./_ambiente-silveira";
import { abrirContexto } from "./_grupo-comum";
import { semearMargens } from "./_margens-comum";

const ANTES = process.env.SO_CAPTURA === "antes";
const PREFIXO = ANTES ? "antes" : "depois";
let ok = 0;
let falhas = 0;
const check = (cond: boolean, msg: string, detalhe?: string) => {
  if (ANTES) return;
  if (cond) { ok++; console.log(`  [OK]    ${msg}`); }
  else { falhas++; console.log(`  [FALHA] ${msg}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const secao = (t: string) => console.log(`\n── ${t}`);
const EVID = path.resolve("docs/validacao-visual/2026-10-vendas-separadores-meses");
const SEM_FUNDOS = "*{print-color-adjust:economy !important;-webkit-print-color-adjust:economy !important}";

function postBinario(u: URL, corpo: Buffer, cookies: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const r = httpRequest({ host: "localhost", port: Number(u.port), path: u.pathname, method: "POST", headers: { host: u.host, cookie: cookies, "content-type": "application/json", "content-length": corpo.length } }, (res) => {
      const partes: Buffer[] = [];
      res.on("data", (d) => partes.push(d));
      res.on("end", () => resolve(Buffer.concat(partes)));
    });
    r.on("error", reject);
    r.end(corpo);
  });
}
function pyRender(f: string, prefixo: string, paginas: string, dpi: string) {
  const r = spawnSync("python", [path.resolve("scripts/e2e/_renderizar_pdf.py"), f, EVID, prefixo, paginas, dpi], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`python _renderizar_pdf: ${r.stderr}`);
}

/** Bordas calculadas no Chromium (HTML do Relatório/impressão): classes de mês, larguras, alinhamento cabeçalho/corpo. */
const CSS_MESES = `(() => {
  const w = (el, lado) => parseFloat(getComputedStyle(el)['border' + lado + 'Width']);
  const ths = [...document.querySelectorAll('thead th.mes')];
  const linhas = [...document.querySelectorAll('tbody tr')].filter((tr) => !tr.classList.contains('nota-tr') && tr.querySelector('td'));
  const porLinha = linhas.map((tr) => [...tr.querySelectorAll('td.mes')]);
  const desalinhado = [];
  ths.forEach((th, i) => { const x = th.getBoundingClientRect().left; porLinha.forEach((tds, li) => { const td = tds[i]; if (td && Math.abs(td.getBoundingClientRect().left - x) > 0.6) desalinhado.push([li, i]); }); });
  const outras = [...document.querySelectorAll('thead th, tbody td')].filter((c) => !c.classList.contains('mes') && !c.classList.contains('tint-total') && !c.classList.contains('apos-mes'));
  const vertOutras = outras.filter((c) => w(c, 'Left') > 0 || w(c, 'Right') > 0).length;
  const larguras = [...document.querySelectorAll('th.mes, td.mes')].flatMap((c) => [w(c, 'Left'), w(c, 'Right')]);
  const sepArtigo = Math.max(0, ...[...document.querySelectorAll('tbody.row-group')].map((g) => { const trs = g.querySelectorAll(':scope > tr'); return Math.min(...[...trs[trs.length - 1].querySelectorAll('td')].map((t) => w(t, 'Bottom'))); }));
  return {
    nMesesTh: ths.length,
    ini: document.querySelectorAll('thead th.mes-ini').length,
    fim: document.querySelectorAll('thead th.mes-fim').length,
    linhas: linhas.length,
    linhasComTodosMeses: porLinha.filter((t) => t.length === ths.length).length,
    totalGeral: !!document.querySelector('.totals-tbody td.mes'),
    totalArtigo: document.querySelectorAll('tr.subtotal-row td.mes').length,
    desalinhado: desalinhado.length,
    vertOutras,
    maxVertical: Math.max(0, ...larguras),
    sepArtigo,
  };
})()`;
type MesesCss = { nMesesTh: number; ini: number; fim: number; linhas: number; linhasComTodosMeses: number; totalGeral: boolean; totalArtigo: number; desalinhado: number; vertOutras: number; maxVertical: number; sepArtigo: number };

async function main() {
  fs.mkdirSync(EVID, { recursive: true });
  const { medirMeses, mediana } = await import("../tests/_verticais-meses");
  const amb = await criarAmbiente("sm");
  const browser = await chromium.launch();
  try {
    const seed = await semearMargens(amb);
    const prisma = amb.prisma;
    const hoje = new Date();
    const fab = await prisma.fabricante.findFirstOrThrow();
    const { alfa, beta } = seed.farmacias;
    const prod = (cnp: number, designacao: string) => prisma.produto.create({ data: { cnp, designacao, fabricanteId: fab.id, estado: "VALIDADO" } });
    const ficha = (produtoId: string, farmaciaId: string, d: { pvp: number; stock: number | null }) =>
      prisma.produtoFarmacia.create({ data: { produtoId, farmaciaId, pvp: d.pvp, pmc: 4, stockAtual: d.stock, stockMinimo: 1, stockMaximo: 9, taxaIvaPercent: 23 } });
    // vendas espalhadas pelos últimos 28 meses (para os blocos de 14 e 27 meses terem valores em vários meses)
    const venda = async (produtoId: string, farmaciaId: string, q: number, atras: number) => {
      const d = new Date(hoje.getFullYear(), hoje.getMonth() - atras, 1);
      await prisma.vendaMensal.create({ data: { produtoId, farmaciaId, ano: d.getFullYear(), mes: d.getMonth() + 1, quantidade: q, quantidadeLiquida: q, valorTotal: q * 10, valorBruto: q * 10 } });
    };
    const meses = async (pid: string, fid: string, base: number) => { for (const a of [1, 2, 3, 5, 8, 12, 13, 14, 20, 26]) await venda(pid, fid, base + (a % 4), a); };
    const a1 = await prod(7500001, "SEPDEMO 1 Artigo numa só farmácia"); await ficha(a1.id, alfa, { pvp: 10, stock: 5 }); await meses(a1.id, alfa, 3);
    const a2 = await prod(7500002, "SEPDEMO 2 Outro artigo numa só farmácia"); await ficha(a2.id, alfa, { pvp: 12, stock: 0 }); await meses(a2.id, alfa, 2);
    const a3 = await prod(7500003, "SEPDEMO 3 Artigo em duas farmácias"); await ficha(a3.id, alfa, { pvp: 8, stock: 3 }); await ficha(a3.id, beta, { pvp: 8, stock: 7 }); await meses(a3.id, alfa, 1); await meses(a3.id, beta, 2);
    const a4 = await prod(7500004, "SEPDEMO 4 Artigo numa só farmácia com stock negativo"); await ficha(a4.id, beta, { pvp: 6, stock: -2 }); await meses(a4.id, beta, 4);
    const a5 = await prod(7500005, "SEPDEMO 5 Artigo com designação muito longa que ocupa duas ou três linhas na coluna da descrição do mapa de vendas SPharm"); await ficha(a5.id, alfa, { pvp: 9, stock: 4 }); await meses(a5.id, alfa, 1);
    const a6 = await prod(7500006, "SEPDEMO 6 Artigo com PVP divergente"); await ficha(a6.id, alfa, { pvp: 9.99, stock: 2 }); await ficha(a6.id, beta, { pvp: 10.5, stock: 1 }); await meses(a6.id, alfa, 2); await meses(a6.id, beta, 1);
    const a7 = await prod(7500007, "SEPDEMO 7 Último artigo, stock desconhecido"); await ficha(a7.id, alfa, { pvp: 7, stock: null }); await meses(a7.id, alfa, 5);

    const ctx = await abrirContexto(amb, browser, { userId: seed.userId } as never);
    await ctx.addInitScript("window.__name = (f) => f; window.__impressoes = []; new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) { if (n && n.tagName === 'IFRAME') n.addEventListener('load', () => { try { window.__impressoes.push(n.contentDocument.documentElement.outerHTML); } catch (e) {} }); } }).observe(document, { childList: true, subtree: true });");
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(baseFor("silveira") + "/vendas", { waitUntil: "networkidle" });
    await page.waitForFunction(() => new URL(location.href).searchParams.has("workspace"));

    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
    const inicioDe = (n: number) => iso(new Date(hoje.getFullYear(), hoje.getMonth() - (n - 1), 1));
    const gerar = async (n: number) => {
      await page.getByLabel("Data início").fill(inicioDe(n));
      await page.getByLabel("Data fim").fill(hoje.toISOString().slice(0, 10));
      await page.getByRole("button", { name: /^(Gerar|Atualizar)$/ }).click();
      await page.getByRole("button", { name: /^Atualizar$/ }).waitFor({ timeout: 90000 });
      await page.getByRole("button", { name: /^Tabela$/ }).click();
      try { await page.locator('[data-testid="vendas-sel-contagem"]').waitFor({ timeout: 60000 }); }
      catch (e) { await page.screenshot({ path: path.join(EVID, "_erro-gerar.png") }); throw e; }
    };
    const previa = () => page.frameLocator('[data-testid="vendas-relatorio-previa"]');
    const pdfReal = async (nome: string) => {
      const [req] = await Promise.all([page.waitForRequest((r) => r.url().includes("/api/reports/pdf"), { timeout: 180000 }), page.getByRole("button", { name: /^PDF$/ }).first().click()]);
      const buf = await postBinario(new URL(req.url()), req.postDataBuffer()!, (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; "));
      const f = path.join(EVID, nome);
      fs.writeFileSync(f, buf);
      await page.getByRole("button", { name: /^PDF$/ }).first().waitFor({ timeout: 60000 });
      return f;
    };
    /** HTML que a impressão do browser usa (iframe) → PDF com ou sem fundos (simula «gráficos de fundo» desligado: printBackground=false + print-color-adjust:economy, para que o relatório — que pede «exact» — também perca os fundos). */
    const impressao = async () => {
      await page.evaluate("window.__impressoes = []");
      await page.getByRole("button", { name: /^Imprimir$/ }).first().click();
      await page.waitForFunction(() => (window as unknown as { __impressoes: string[] }).__impressoes.length > 0, null, { timeout: 30000 });
      return page.evaluate(() => (window as unknown as { __impressoes: string[] }).__impressoes[0]);
    };
    const pdfDeHtml = async (html: string, nome: string, fundos: boolean) => {
      const p2 = await ctx.newPage();
      try {
        await p2.emulateMedia({ media: "print" });
        await p2.setContent(html, { waitUntil: "networkidle" });
        if (!fundos) await p2.addStyleTag({ content: SEM_FUNDOS });
        const f = path.join(EVID, nome);
        await p2.pdf({ path: f, format: "A4", landscape: true, printBackground: fundos, preferCSSPageSize: true, margin: { top: "10mm", right: "8mm", bottom: "10mm", left: "8mm" } });
        return f;
      } finally { await p2.close(); }
    };
    const verificarPdf = (tag: string, f: string, semFundos: boolean) => {
      const m = medirMeses(f, () => null);
      check(m.falhas.length === 0 && m.nLimites.length === m.nPaginas && m.nLimites.every((n) => n >= 2), `${tag}: filetes = meses + 1 por página (${m.nLimites.join("/")}), contínuos do cabeçalho ao TOTAL GERAL, nada cortado, nada fora dos meses`, m.falhas.slice(0, 3).join(" | "));
      check(m.maxLargura > 0 && m.minLargura >= 0.5 && m.maxLargura <= 0.95 && (!Number.isFinite(m.minHorizontal) || m.maxLargura < m.minHorizontal), `${tag}: espessura ${m.minLargura.toFixed(2)}–${m.maxLargura.toFixed(2)}pt, mais fina que o separador entre artigos`);
      if (semFundos) check(m.cinzLimite.length > 0 && (m.cinzMes.length === 0 || mediana(m.cinzMes) <= 215) && mediana(m.cinzLimite) <= 215, `${tag}: visível sem fundos (mediana de cinzento ${m.cinzMes.length ? mediana(m.cinzMes) : "—"}/${mediana(m.cinzLimite)} em 255)`);
      return m;
    };
    const avaliarCss = (tag: string, r: MesesCss, n: number) => {
      check(r.nMesesTh === n && r.ini === 1 && r.fim === 1, `${tag}: ${n} cabeçalhos de mês, 1.º e último marcados como limites`, JSON.stringify(r));
      check(r.linhas > 0 && r.linhasComTodosMeses === r.linhas && r.totalGeral && r.totalArtigo >= 2 * n, `${tag}: as ${r.linhas} linhas do corpo (incl. TOTAL ARTIGO e TOTAL GERAL) têm as ${n} colunas de mês com filete`, JSON.stringify(r));
      check(r.desalinhado === 0, `${tag}: filetes do cabeçalho e do corpo coincidem horizontalmente`);
      check(r.vertOutras === 0, `${tag}: nenhuma linha vertical nas colunas que não são de meses (CNP, Descrição, Farmácia, PVP, custos, Stock, Valor Vendas)`);
      check(r.maxVertical <= 1 && r.sepArtigo === 2 && r.maxVertical < r.sepArtigo, `${tag}: filetes verticais ≤ 1px; separador entre artigos continua a 2px`, JSON.stringify(r));
    };

    // ═══ Ecrã: Relatório, 3 resoluções, 3 meses ═══════════════════════════════════════════════════════════════════════════
    secao("Relatório (ecrã) a 3 resoluções");
    await page.getByPlaceholder("Pesquisar por CNP ou descrição...").fill("SEPDEMO");
    await gerar(3);
    for (const [w, h] of [[1920, 1080], [1536, 864], [1366, 768]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.getByRole("button", { name: /^Relatório$/ }).click();
      await previa().locator("thead th").first().waitFor({ timeout: 30000 });
      await page.screenshot({ path: path.join(EVID, `${PREFIXO}-relatorio-3m-${w}x${h}.png`) });
      if (!ANTES) avaliarCss(`${w}×${h} Relatório 3 meses`, await previa().locator("body").evaluate(`(${CSS_MESES})`) as MesesCss, 3);
    }
    await page.setViewportSize({ width: 1920, height: 1080 });

    // ═══ Impressão (iframe) → PDF com e sem fundos ═══════════════════════════════════════════════════════════════════════
    secao("Impressão do browser — com e sem fundos, 3/13/14/27 meses");
    for (const n of [3, 13, 14, 27]) {
      await gerar(n);
      const html = await impressao();
      if (!ANTES) {
        const p3 = await ctx.newPage();
        await p3.emulateMedia({ media: "print" });
        await p3.setContent(html, { waitUntil: "networkidle" });
        await p3.evaluate("window.__name = (f) => f;");
        const r = await p3.evaluate(CSS_MESES) as MesesCss;
        // em blocos (14 e 27 meses) o HTML tem uma tabela por bloco: cada uma com o seu 1.º/último mês (o alinhamento mede-se no PDF)
        const blocos = n > 13 ? Math.ceil(n / 13) : 1;
        check(r.nMesesTh === n && r.ini === blocos && r.fim === blocos && (blocos > 1 || r.desalinhado === 0) && r.vertOutras === 0 && r.maxVertical <= 1 && r.sepArtigo === 2, `impressão ${n} meses: HTML com os mesmos filetes (${r.nMesesTh} meses, ${blocos} bloco(s) com limites próprios), só nos meses, ≤ 1px`, JSON.stringify(r));
        await p3.close();
      }
      for (const fundos of [true, false]) {
        const f = await pdfDeHtml(html, `${PREFIXO}-impressao-${n}m-${fundos ? "com" : "sem"}-fundos.pdf`, fundos);
        pyRender(f, `${PREFIXO}-impressao-${n}m-${fundos ? "com" : "sem"}-fundos`, "1", "90");
        if (!ANTES) verificarPdf(`impressão ${n} meses ${fundos ? "COM" : "SEM"} fundos`, f, !fundos);
      }
    }

    // ═══ PDF real do endpoint ═════════════════════════════════════════════════════════════════════════════════════════════
    secao("PDF real (endpoint) — 3, 13, 14 e 27 meses");
    for (const n of [3, 13, 14, 27]) {
      await gerar(n);
      const f = await pdfReal(`${PREFIXO}-vendas-${n}m.pdf`);
      pyRender(f, `${PREFIXO}-pdf-${n}m`, "1", "90");
      if (!ANTES) verificarPdf(`PDF real ${n} meses`, f, false);
    }

    // ═══ Quatro combinações de preços ═════════════════════════════════════════════════════════════════════════════════════
    secao("Combinações de preços (13 meses)");
    await gerar(13);
    for (const [v, c] of [[true, true], [false, true], [true, false], [false, false]] as const) {
      for (const [tid, val] of [["vendas-incluir-precos-venda", v], ["vendas-incluir-precos-compra", c]] as const) {
        const el = page.locator(`[data-testid="${tid}"]`);
        if ((await el.isChecked()) !== val) await el.setChecked(val);
      }
      const f = await pdfReal(`${PREFIXO}-vendas-13m-${v ? 1 : 0}${c ? 1 : 0}.pdf`);
      pyRender(f, `${PREFIXO}-pdf-13m-${v ? 1 : 0}${c ? 1 : 0}`, "1", "90");
      if (!ANTES) verificarPdf(`PDF real 13 meses · venda=${v ? "sim" : "não"} · compra=${c ? "sim" : "não"}`, f, false);
      const sf = await pdfDeHtml(await impressao(), `${PREFIXO}-impressao-13m-${v ? 1 : 0}${c ? 1 : 0}-sem-fundos.pdf`, false);
      if (!ANTES) verificarPdf(`impressão SEM fundos 13 meses · venda=${v ? "sim" : "não"} · compra=${c ? "sim" : "não"}`, sf, true);
    }
    for (const tid of ["vendas-incluir-precos-venda", "vendas-incluir-precos-compra"]) { const el = page.locator(`[data-testid="${tid}"]`); if (!(await el.isChecked())) await el.setChecked(true); }

    // ═══ Várias páginas ═══════════════════════════════════════════════════════════════════════════════════════════════════
    secao("Documento de várias páginas");
    await page.getByPlaceholder("Pesquisar por CNP ou descrição...").fill("");
    await gerar(3);
    const fLongo = await pdfReal(`${PREFIXO}-vendas-varias-paginas.pdf`);
    pyRender(fLongo, `${PREFIXO}-pdf-paginas`, "2", "70");
    const sfLongo = await pdfDeHtml(await impressao(), `${PREFIXO}-impressao-varias-paginas-sem-fundos.pdf`, false);
    if (!ANTES) {
      const m = verificarPdf("PDF real de várias páginas", fLongo, false);
      check(m.nPaginas >= 2, `PDF real de várias páginas: ${m.nPaginas} páginas`);
      verificarPdf("impressão SEM fundos de várias páginas", sfLongo, true);
    }
  } finally {
    await browser.close();
    await amb.parar();
  }
  if (ANTES) { console.log("capturas «antes» guardadas"); process.exit(0); }
  console.log(`\n${falhas === 0 ? "PASSOU" : "FALHOU"} — ${ok} OK, ${falhas} falhas\n`);
  process.exit(falhas === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
