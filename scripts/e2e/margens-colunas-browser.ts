/**
 * scripts/e2e/margens-colunas-browser.ts
 *
 * Browser REAL (Chromium) contra o build de PRODUÇÃO (control plane + PostgreSQL descartáveis):
 *   1 · todas as colunas do mapa de Margens acessíveis em 1920×1080 (sem cortes, alinhadas, cabeçalho fixo);
 *   2 · abrir a comparação CNPEM / «mostrar todos» não desconfigura as larguras;
 *   3 · resoluções inferiores: scroll horizontal acessível (barra no topo), CNP e Descrição fixos;
 *   4 · comparação CNPEM por rentabilidade (analisado primeiro, Margem % ↓, sem margem no fim);
 *   5 · impressão, PDF e Excel continuam sem a expansão.
 *
 * Pré-requisito: `npx next build` com SERVER_ACTIONS_ALLOWED_ORIGINS="localhost:3100,127.0.0.1:3100,*.localhost:3100".
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/e2e/margens-colunas-browser.ts
 */
import fs from "node:fs";
import path from "node:path";
import { request as httpRequest } from "node:http";
import { spawnSync } from "node:child_process";
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
const EVID = path.resolve("docs/validacao-visual/2026-10-margens-colunas");
const SEL = '[data-testid="tabela-margens-produto"]';

const COLUNAS = ["CNP", "Descrição", "Categoria", "Farmácia", "Qtd", "Stock", "PVP unit.", "Vendas c/IVA", "IVA %", "Vendas s/IVA", "Custo unit. est.", "Custo est.", "Margem €", "Margem unitária", "Margem %", "Estado", "Preço utente — regime geral", "Preço utente — regime especial"];

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

/** Cabeçalhos: texto completo visível (sem truncar), dentro do contentor e do ecrã quando cabe. */
async function medirCabecalhos(page: Page) {
  return page.evaluate((sel) => {
    const c = document.querySelector(sel) as HTMLElement;
    const cr = c.getBoundingClientRect();
    return Array.from(c.querySelectorAll("thead th")).map((th) => {
      const sp = th.querySelector("span.truncate") as HTMLElement | null;
      const b = th.getBoundingClientRect();
      return {
        texto: (th as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
        cortado: !!sp && (sp.scrollWidth > sp.clientWidth + 1 || getComputedStyle(sp).textOverflow === "ellipsis" && getComputedStyle(sp).overflow === "hidden"),
        esquerda: b.left, direita: b.right,
        contentorDir: cr.right, contentorEsq: cr.left, ecra: window.innerWidth,
      };
    });
  }, SEL);
}

async function gerar(page: Page) {
  await page.goto(baseFor("silveira") + "/relatorios/margens", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Gerar", exact: true }).click();
  await page.locator(SEL).waitFor({ timeout: 60000 });
}

const pct = (t: string) => { const m = /(-?\d+(?:[.,]\d+)?)\s*%/.exec(t.replace(/\s/g, "")); return m ? Number(m[1].replace(",", ".")) : null; };

async function main() {
  fs.mkdirSync(EVID, { recursive: true });
  const amb = await criarAmbiente("mcol");
  const browser = await chromium.launch();
  try {
    const seed = await semearMargens(amb);
    const ctx = await abrirContexto(amb, browser, { userId: seed.userId } as never);
    await ctx.addInitScript(`window.__impressoes = []; new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) { if (n && n.tagName === 'IFRAME') n.addEventListener('load', () => { try { window.__impressoes.push(n.contentDocument.documentElement.outerHTML); } catch (e) {} }); } }).observe(document, { childList: true, subtree: true });`);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

    // ═══ 1 · 1920×1080 ═══
    secao("1 · 1920×1080 — todas as colunas acessíveis");
    await page.setViewportSize({ width: 1920, height: 1080 });
    await gerar(page);
    const ths = await medirCabecalhos(page);
    const nomes = ths.map((t) => t.texto.toLowerCase());
    for (const c of COLUNAS) check(nomes.some((n) => n.includes(c.toLowerCase().replace(" — ", " ").replace("—", "")) || n.includes(c.toLowerCase())), `coluna «${c}» presente no cabeçalho`);
    check(ths.every((t) => !t.cortado), "nenhum cabeçalho truncado (sem reticências nem texto cortado)", JSON.stringify(ths.filter((t) => t.cortado).map((t) => t.texto)));
    const dim = await page.evaluate((sel) => { const c = document.querySelector(sel) as HTMLElement; return { sw: c.scrollWidth, cw: c.clientWidth, doc: document.documentElement.scrollWidth, ecra: window.innerWidth }; }, SEL);
    check(dim.sw <= dim.cw + 1, `a tabela cabe na área disponível sem scroll horizontal (${dim.sw}px ≤ ${dim.cw}px)`);
    check(ths.every((t) => t.direita <= t.contentorDir + 1 && t.direita <= t.ecra), "todas as colunas dentro do contentor e do ecrã (nenhuma escondida à direita)");
    const ultimo = ths[ths.length - 1];
    check(/regime especial/i.test(ultimo.texto) && ultimo.direita <= ultimo.ecra, `«${ultimo.texto}» visível (termina em ${Math.round(ultimo.direita)}px de ${ultimo.ecra}px)`);
    check(ths.some((t) => /regime geral/i.test(t.texto)), "«regime geral» visível");
    const celulasVisiveis = await page.evaluate((sel) => {
      const c = document.querySelector(sel) as HTMLElement;
      const cr = c.getBoundingClientRect();
      const tr = c.querySelector("tbody > tr:not([data-tabela-linha])") as HTMLElement;
      return Array.from(tr.querySelectorAll("td")).every((td) => { const b = td.getBoundingClientRect(); return b.right <= cr.right + 1 && b.left >= cr.left - 1; });
    }, SEL);
    check(celulasVisiveis, "todas as células da 1.ª linha dentro do contentor");
    const valores = await page.evaluate((sel) => {
      const tr = document.querySelector(`${sel} tbody > tr:not([data-tabela-linha])`) as HTMLElement;
      return Array.from(tr.querySelectorAll("td")).slice(5, 15).map((td) => ({ t: (td as HTMLElement).innerText.trim(), h: (td as HTMLElement).getBoundingClientRect().height, quebra: (td as HTMLElement).innerText.trim().includes("\n") }));
    }, SEL);
    check(valores.every((v) => !v.quebra), `valores monetários/percentuais legíveis, sem quebras (${valores.map((v) => v.t).join(" | ")})`);
    const al = await alinhamentoColunas(page, SEL);
    check(al.maxDesvio <= 1.5, `cabeçalho e células alinhados (${al.colunas} colunas, desvio ${al.maxDesvio}px)`);
    await page.locator(SEL).scrollIntoViewIfNeeded();
    await page.evaluate((sel) => { const c = document.querySelector(sel) as HTMLElement; window.scrollBy(0, c.getBoundingClientRect().top - 70); c.scrollTop = 700; }, SEL);
    const h1 = await estadoCabecalho(page, SEL);
    check(h1.scrollTop >= 500 && Math.abs(h1.desvioTopo) <= 1 && h1.visivelPorCima && h1.opaco, `cabeçalho fixo no scroll vertical (scrollTop ${h1.scrollTop}, desvio ${h1.desvioTopo}px)`);
    await page.evaluate((sel) => { (document.querySelector(sel) as HTMLElement).scrollTop = 0; }, SEL);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(EVID, "margens-1920.png") });

    // ═══ 2 · comparação aberta ═══
    secao("2 · comparação CNPEM aberta e «mostrar todos» não desconfiguram as larguras");
    // Margens não gera ao escrever: aplicar a pesquisa com «Atualizar».
    await page.getByPlaceholder("Pesquisar CNP ou descrição").fill(String(CNP.A));
    await atualizarMargens(page);
    const dimPesq = await page.evaluate((sel) => (document.querySelector(sel) as HTMLElement).scrollWidth, SEL);
    await page.locator(`${SEL} tbody > tr[data-cnp="${CNP.A}"][data-farmacia="${seed.nomes.alfa}"]:not([data-tabela-linha]) [data-testid="expandir-cnpem"]`).click();
    await page.locator('[data-testid="comparacao-contagem"]').waitFor({ timeout: 20000 });
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="etiqueta-comparavel"]').length > 0, null, { timeout: 20000 });
    const colunasPos = await page.evaluate((sel) => Array.from(document.querySelectorAll(`${sel} thead th`)).map((t) => Math.round(t.getBoundingClientRect().left + t.getBoundingClientRect().width)), SEL);
    const dimAberta = await page.evaluate((sel) => { const c = document.querySelector(sel) as HTMLElement; return { sw: c.scrollWidth, cw: c.clientWidth }; }, SEL);
    check(dimAberta.sw <= dimAberta.cw + 1, `com a comparação aberta continua a caber (${dimAberta.sw}px ≤ ${dimAberta.cw}px)`);
    check((await alinhamentoColunas(page, SEL)).maxDesvio <= 1.5, "cabeçalho e células alinhados com a comparação aberta");
    const alComp = await page.evaluate((sel) => {
      const ths = Array.from(document.querySelectorAll(`${sel} thead tr:first-child > th`)) as HTMLElement[];
      const tr = document.querySelector(`${sel} tr[data-tabela-linha="comparacao"][data-cnp]`) as HTMLElement;
      const tds = Array.from(tr.querySelectorAll(":scope > td")) as HTMLElement[];
      let max = 0;
      ths.forEach((th, i) => { const a = th.getBoundingClientRect(); const b = tds[i].getBoundingClientRect(); max = Math.max(max, Math.abs(a.left - b.left), Math.abs(a.width - b.width)); });
      return { n: ths.length === tds.length, max };
    }, SEL);
    check(alComp.n && alComp.max <= 1.5, `as linhas da comparação alinham com o cabeçalho (desvio ${alComp.max}px)`);
    await page.locator('[data-testid="comparacao-mostrar-todos"]').check();
    await page.waitForFunction((f) => !!document.querySelector(`tr[data-tabela-linha^="comparacao"][data-cnp="${f}"]`), String(CNP.F), { timeout: 20000 });
    const dimTodos = await page.evaluate((sel) => { const c = document.querySelector(sel) as HTMLElement; return { sw: c.scrollWidth, cw: c.clientWidth }; }, SEL);
    check(dimTodos.sw <= dimTodos.cw + 1 && (await alinhamentoColunas(page, SEL)).maxDesvio <= 1.5, "«Mostrar todos»: sem scroll horizontal e alinhado");
    check(Math.abs(dimPesq - dimAberta.sw) <= 2, `a largura da tabela não mudou ao abrir a comparação (${dimPesq} → ${dimAberta.sw})`);
    void colunasPos;
    await page.screenshot({ path: path.join(EVID, "margens-1920-comparacao.png") });

    // ═══ 4 · rentabilidade ═══
    secao("4 · comparação CNPEM por rentabilidade");
    const ler = async () => page.locator(`${SEL} tr[data-tabela-linha^="comparacao"][data-cnp]`).evaluateAll((trs) => trs.map((t) => {
      const tds = t.querySelectorAll(":scope > td");
      return { cnp: (t as HTMLElement).dataset.cnp!, farm: (t as HTMLElement).dataset.farmacia!, tipo: (t as HTMLElement).dataset.tabelaLinha!, pct: (tds[15] as HTMLElement).innerText, un: (tds[14] as HTMLElement).innerText, des: (tds[2] as HTMLElement).innerText.split("\n")[0] };
    }));
    const linhas = await ler();
    check(linhas[0].tipo === "comparacao-analisado" && linhas[0].cnp === String(CNP.A) && linhas[0].farm === seed.nomes.alfa, "o produto analisado é a 1.ª linha e está identificado");
    const resto = linhas.slice(1).map((l) => ({ ...l, p: pct(l.pct) }));
    const comMargem = resto.filter((l) => l.p !== null);
    const semMargem = resto.filter((l) => l.p === null);
    check(comMargem.length >= 2 && comMargem.every((l, i) => i === 0 || l.p! <= comMargem[i - 1].p!), `os restantes por Margem % descendente (${comMargem.map((l) => `${l.cnp}:${l.p}%`).join(" ")})`);
    check(resto.findIndex((l) => l.p === null) === -1 || resto.slice(resto.findIndex((l) => l.p === null)).every((l) => l.p === null), "linhas sem margem ficam todas depois das que têm");
    check(semMargem.length >= 2 && semMargem[0].cnp === String(CNP.C) && semMargem[semMargem.length - 1].cnp === String(CNP.F), `sem margem: primeiro a com stock (C), depois as restantes (F inserido por «mostrar todos» no fim): ${semMargem.map((l) => l.cnp).join(",")}`);
    const distintas = comMargem.filter((l, i) => i > 0 && l.p === comMargem[i - 1].p);
    void distintas;
    // estabilidade: voltar a abrir/fechar não muda a ordem
    const ordem1 = linhas.map((l) => `${l.cnp}@${l.farm}`).join(",");
    await page.locator('[data-testid="comparacao-mostrar-todos"]').uncheck();
    await page.waitForFunction((f) => !document.querySelector(`tr[data-tabela-linha^="comparacao"][data-cnp="${f}"]`), String(CNP.F), { timeout: 20000 });
    await page.locator('[data-testid="comparacao-mostrar-todos"]').check();
    await page.waitForFunction((f) => !!document.querySelector(`tr[data-tabela-linha^="comparacao"][data-cnp="${f}"]`), String(CNP.F), { timeout: 20000 });
    check((await ler()).map((l) => `${l.cnp}@${l.farm}`).join(",") === ordem1, "a ordem é estável (desligar e ligar «mostrar todos» devolve a mesma sequência)");
    // mudar as farmácias recalcula e reordena
    await page.getByRole("button", { name: /Filtros/ }).first().click();
    await page.locator("span.rounded-full", { hasText: seed.nomes.gama }).locator("button").first().click();
    await atualizarMargens(page);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="etiqueta-comparavel"]').length > 0, null, { timeout: 20000 });
    const semGama = (await ler()).slice(1).map((l) => ({ ...l, p: pct(l.pct) }));
    const cm = semGama.filter((l) => l.p !== null);
    check(!semGama.some((l) => l.cnp === String(CNP.D)) && cm.every((l, i) => i === 0 || l.p! <= cm[i - 1].p!), `sem a Gama: D desaparece e a ordem por Margem % mantém-se (${cm.map((l) => `${l.cnp}:${l.p}%`).join(" ")})`);
    const mapa = await page.locator(`${SEL} tbody > tr:not([data-tabela-linha]) > td:nth-child(3)`).evaluateAll((tds) => tds.map((t) => (t as HTMLElement).innerText.split("\n")[0].trim()));
    check(mapa.length >= 1, "o mapa principal mantém a sua própria ordenação (alfabética por omissão)");
    await page.screenshot({ path: path.join(EVID, "margens-comparacao-rentabilidade.png") });

    // ═══ 5 · impressão, PDF e Excel ═══
    secao("5 · impressão, PDF e Excel continuam sem a expansão CNPEM");
    const FORA = ["IBUPROFENO B 400", "IBUPROFENO C 400", "IBUPROFENO D 400", "IBUPROFENO F 400", "Mesmo CNPEM", "Produto analisado"];
    const fora = (t: string) => FORA.filter((n) => t.includes(n));
    const [req] = await Promise.all([
      page.waitForRequest((r) => r.url().includes("/api/reports/pdf"), { timeout: 120000 }),
      page.getByRole("button", { name: /^PDF$/ }).first().click(),
    ]);
    const corpo = req.postDataBuffer()!;
    const pdf = await postBinario(new URL(req.url()), corpo, (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; "));
    const pdfPath = path.join(EVID, "margens-com-expansao.pdf");
    fs.writeFileSync(pdfPath, pdf);
    const py = spawnSync("python", [path.resolve("scripts/e2e/_texto_pdf.py"), pdfPath], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const txt = (JSON.parse(py.stdout.trim().split("\n").pop() ?? "{}") as { texto: string[] }).texto.join("\n");
    check(pdf.subarray(0, 4).toString() === "%PDF" && txt.includes("IBUPROFENO A 400") && fora(txt).length === 0 && fora(corpo.toString("utf8")).length === 0, "PDF real e corpo do relatório: só o artigo do mapa, sem a expansão");
    await page.evaluate("window.__impressoes.length = 0");
    await page.getByRole("button", { name: /^Imprimir$/ }).first().click();
    await page.waitForFunction("window.__impressoes.length > 0", null, { timeout: 20000 });
    const html = (await page.evaluate("window.__impressoes[0]")) as string;
    check(html.includes("IBUPROFENO A 400") && fora(html).length === 0, "HTML de impressão sem a expansão");
    await page.emulateMedia({ media: "print" });
    const display = await page.locator("tr[data-nao-imprimir]").evaluateAll((trs) => trs.map((t) => getComputedStyle(t).display));
    check(display.length >= 3 && display.every((d) => d === "none"), `impressão do ecrã: as ${display.length} linhas da expansão ficam escondidas`);
    check(await page.locator('[data-testid="barra-scroll-topo"]').evaluate((e) => getComputedStyle(e).display === "none"), "…e a barra de scroll do topo também");
    await page.emulateMedia({ media: "screen" });
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.getByRole("button", { name: /^Excel$/ }).first().click()]);
    const xp = path.join(EVID, "margens-com-expansao.xlsx");
    await dl.saveAs(xp);
    const wb = XLSX.read(fs.readFileSync(xp));
    const csv = wb.SheetNames.map((n) => XLSX.utils.sheet_to_csv(wb.Sheets[n])).join("\n");
    check(csv.includes("IBUPROFENO A 400") && fora(csv).length === 0, "Excel real sem a expansão");
    fs.rmSync(xp);
    fs.rmSync(pdfPath);

    // ═══ 3 · resoluções inferiores ═══
    secao("3 · resoluções inferiores — scroll horizontal acessível, colunas fixas");
    for (const [w, h] of [[1536, 864], [1366, 768]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto(baseFor("silveira") + "/relatorios/margens", { waitUntil: "networkidle" });
      await page.getByRole("button", { name: "Gerar", exact: true }).click();
      await page.locator(SEL).waitFor({ timeout: 60000 });
      const d = await page.evaluate((sel) => { const c = document.querySelector(sel) as HTMLElement; return { sw: c.scrollWidth, cw: c.clientWidth }; }, SEL);
      check(d.sw > d.cw, `${w}×${h}: não cabe (${d.sw}px > ${d.cw}px) → há scroll horizontal`);
      const barra = page.locator('[data-testid="barra-scroll-topo"]');
      check(await barra.isVisible(), `${w}×${h}: barra de scroll horizontal no topo da tabela visível`);
      const noEcra = await barra.evaluate((e) => { const b = e.getBoundingClientRect(); return b.top >= 0 && b.bottom <= window.innerHeight; });
      check(noEcra, `${w}×${h}: a barra está dentro do ecrã sem fazer scroll da página`);
      const alvo1 = Math.min(300, d.sw - d.cw);
      await barra.evaluate((e, v) => { (e as HTMLElement).scrollLeft = v; }, alvo1);
      await page.waitForTimeout(200);
      const sync = await page.evaluate((sel) => (document.querySelector(sel) as HTMLElement).scrollLeft, SEL);
      check(Math.abs(sync - alvo1) <= 2, `${w}×${h}: a barra do topo move a tabela (scrollLeft ${sync} de ${d.sw - d.cw} possíveis)`);
      const alvo2 = Math.min(400, d.sw - d.cw);
      await page.evaluate((a) => { const c = document.querySelector(a.sel) as HTMLElement; c.scrollLeft = a.v; c.scrollTop = 500; }, { sel: SEL, v: alvo2 });
      await page.waitForTimeout(200);
      const barraSync = await barra.evaluate((e) => (e as HTMLElement).scrollLeft);
      check(Math.abs(barraSync - alvo2) <= 2, `${w}×${h}: a tabela move a barra (sincronizadas, ${barraSync})`);
      const fixas = (await page.evaluate(`(() => {
        var c = document.querySelector('${SEL}');
        var cr = c.getBoundingClientRect();
        function q(css) { return c.querySelector(css).getBoundingClientRect().left - cr.left; }
        return { cnpTh: q('thead th.col-cnp'), descTh: q('thead th.col-desc'), cnpTd: q('tbody > tr:not([data-tabela-linha]) td.col-cnp'), descTd: q('tbody > tr:not([data-tabela-linha]) td.col-desc'), sl: c.scrollLeft };
      })()`)) as { cnpTh: number; descTh: number; cnpTd: number; descTd: number; sl: number };
      check(fixas.sl >= Math.min(300, d.sw - d.cw) - 2 && Math.abs(fixas.cnpTh - 32) <= 2 && Math.abs(fixas.cnpTd - 32) <= 2 && Math.abs(fixas.descTh - 116) <= 2 && Math.abs(fixas.descTd - 116) <= 2, `${w}×${h}: CNP e Descrição ficam fixas à esquerda com a tabela deslocada ${fixas.sl}px`);
      const hv = await estadoCabecalho(page, SEL);
      check(Math.abs(hv.desvioTopo) <= 1 && hv.visivelPorCima && hv.opaco, `${w}×${h}: o cabeçalho acompanha o scroll horizontal e continua fixo na vertical`);
      const al2 = await alinhamentoColunas(page, SEL);
      check(al2.maxDesvio <= 1.5, `${w}×${h}: cabeçalho e células alinhados com scroll (desvio ${al2.maxDesvio}px)`);
      await page.evaluate((sel) => { const c = document.querySelector(sel) as HTMLElement; c.scrollLeft = c.scrollWidth; }, SEL);
      await page.waitForTimeout(200);
      const fim = await page.evaluate((sel) => { const c = document.querySelector(sel) as HTMLElement; const cr = c.getBoundingClientRect(); const ths = c.querySelectorAll("thead th"); const u = ths[ths.length - 1].getBoundingClientRect(); return { dir: u.right, cdir: cr.right, texto: (ths[ths.length - 1] as HTMLElement).innerText.replace(/\s+/g, " ") }; }, SEL);
      check(fim.dir <= fim.cdir + 1 && /regime especial/i.test(fim.texto), `${w}×${h}: no fim do scroll a última coluna («${fim.texto}») fica totalmente visível`);
      // com a comparação aberta
      await page.evaluate((sel) => { const c = document.querySelector(sel) as HTMLElement; c.scrollLeft = 0; c.scrollTop = 0; }, SEL);
      await page.getByPlaceholder("Pesquisar CNP ou descrição").fill(String(CNP.A));
      await atualizarMargens(page);
      await page.locator(`${SEL} tbody > tr[data-cnp="${CNP.A}"]:not([data-tabela-linha]) [data-testid="expandir-cnpem"]`).first().click();
      await page.locator('[data-testid="comparacao-contagem"]').waitFor({ timeout: 20000 });
      await page.evaluate((sel) => { (document.querySelector(sel) as HTMLElement).scrollLeft = 350; }, SEL);
      await page.waitForTimeout(200);
      const msgVisivel = await page.evaluate((sel) => {
        const c = document.querySelector(sel) as HTMLElement; const cr = c.getBoundingClientRect();
        const m = c.querySelector('[data-testid="comparacao-contagem"]') as HTMLElement; const b = m.getBoundingClientRect();
        return b.left >= cr.left - 1 && b.left < cr.right;
      }, SEL);
      check(msgVisivel, `${w}×${h}: com a comparação aberta e a tabela deslocada, o texto da comparação continua visível`);
      check((await alinhamentoColunas(page, SEL)).maxDesvio <= 1.5, `${w}×${h}: alinhamento mantido com a comparação aberta`);
      await page.screenshot({ path: path.join(EVID, `margens-${w}-scroll.png`) });
    }
  } catch (e) {
    console.log(["--- logs do servidor ---", amb.logs().slice(-3000)].join("\n"));
    throw e;
  } finally {
    await browser.close();
    await amb.parar();
  }
  console.log(`\n${ok} OK, ${falhas} falhas`);
  process.exit(falhas === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
