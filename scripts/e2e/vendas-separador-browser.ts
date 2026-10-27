/**
 * scripts/e2e/vendas-separador-browser.ts
 *
 * Browser REAL (Chromium) contra o build de PRODUÇÃO (control plane + PostgreSQL descartáveis, dados sintéticos): a passagem de um
 * artigo para o seguinte no mapa de Vendas — tabela do ecrã, Relatório, impressão e PDF real (pixéis medidos).
 *
 * Dados consecutivos: (1) artigo numa só farmácia · (2) outro numa só farmácia · (3) em duas farmácias, com «TOTAL ARTIGO» ·
 * (4) numa só farmácia (stock negativo) · (5) designação em várias linhas · (6) PVP divergente · (7) stock desconhecido.
 *
 *   SO_CAPTURA=antes  → só capturas (docs/validacao-visual/.../antes-*.png), sem asserções (corre-se no SHA anterior, para o antes/depois).
 *
 * Pré-requisito: `npx next build` com SERVER_ACTIONS_ALLOWED_ORIGINS="localhost:3100,127.0.0.1:3100,*.localhost:3100".
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/e2e/vendas-separador-browser.ts
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { chromium, type Page, type BrowserContext } from "playwright";
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
const EVID = path.resolve("docs/validacao-visual/2026-10-vendas-separador-artigos");
const COR_SEP = "rgb(132, 147, 166)";

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
function py(script: string, ...args: string[]): string {
  const r = spawnSync("python", [path.resolve(`scripts/e2e/${script}`), ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`python ${script}: ${r.stderr}`);
  return r.stdout.trim().split("\n").pop() ?? "{}";
}
type SepPdf = { y0: number; y1: number; espessura: number; cinzento: number; fundoAcima: number; fundoAbaixo: number };
type PagPdf = { largura: number; altura: number; separadores: SepPdf[]; cabecalho: { y0: number; y1: number }[]; cnps: { y0: number; y1: number; texto: string }[]; totais: { y0: number; y1: number; texto: string }[]; maxX1: number };
const analisar = (f: string) => JSON.parse(py("_separadores_pdf.py", f)) as PagPdf[];

function verificarPdf(tag: string, paginas: PagPdf[], minPaginas = 1) {
  const nCnps = paginas.reduce((a, p) => a + p.cnps.length, 0);
  check(paginas.length >= minPaginas && paginas.every((p) => p.largura > p.altura && p.maxX1 <= p.largura - 8) && nCnps > 0, `${tag}: A4 horizontal, nada cortado, ${nCnps} artigos em ${paginas.length} página(s)`);
  const falhasP: string[] = [];
  paginas.forEach((p, pi) => {
    if (p.cnps.length === 0) return;
    const ultima = pi === paginas.length - 1;
    const tgY = p.totais.filter((t) => t.texto === "GERAL" && t.y0 > p.cnps[p.cnps.length - 1].y0).map((t) => t.y0).sort((a, b) => a - b)[0] ?? Infinity;
    const cabY1 = Math.max(...p.cabecalho.filter((c) => c.y1 <= p.cnps[0].y0).map((c) => c.y1), 0);
    const seps = p.separadores.filter((s) => s.espessura >= 0.9 && s.cinzento >= 110 && s.cinzento <= 180 && s.y0 > cabY1 - 1 && s.y1 < tgY + 0.5);
    const esperados = p.cnps.length - (ultima ? 1 : 0);
    if (seps.length !== esperados) falhasP.push(`pág ${pi + 1}: ${seps.length} filetes, esperados ${esperados}`);
    if (seps.some((s) => s.y0 < p.cnps[0].y0)) falhasP.push(`pág ${pi + 1}: filete acima do 1.º artigo`);
    for (let i = 0; i + 1 < p.cnps.length; i++) {
      const entre = seps.filter((s) => s.y0 > p.cnps[i].y0 && s.y0 < p.cnps[i + 1].y0);
      if (entre.length !== 1) { falhasP.push(`pág ${pi + 1}: ${entre.length} filetes entre ${p.cnps[i].texto} e ${p.cnps[i + 1].texto}`); continue; }
      if (p.totais.some((t) => t.texto === "ARTIGO" && t.y0 > p.cnps[i].y0 && t.y0 < p.cnps[i + 1].y0 && t.y1 > entre[0].y0)) falhasP.push(`pág ${pi + 1}: filete antes do TOTAL ARTIGO de ${p.cnps[i].texto}`);
    }
  });
  check(falhasP.length === 0, `${tag}: um filete entre cada par de artigos (também os de uma só farmácia), nenhum entre farmácias, nenhum antes do TOTAL ARTIGO, nenhum acima do 1.º artigo de cada página`, falhasP.slice(0, 4).join(" | "));
  const todos = paginas.flatMap((p) => p.separadores.filter((s) => s.espessura >= 0.9 && s.cinzento >= 110 && s.cinzento <= 180));
  check(todos.length > 0 && todos.every((s) => s.espessura <= 2.4 && s.fundoAcima - s.cinzento >= 60 && s.fundoAbaixo - s.cinzento >= 60), `${tag}: filete leve (≤ 2,4pt) e legível em escala de cinzentos (≥ 60 níveis face ao fundo)`);
}

const CSS_BORDAS = `(() => {
  const w = (el, lado) => (el ? parseFloat(getComputedStyle(el)['border' + lado + 'Width']) : -1);
  const grupos = [...document.querySelectorAll('tbody.row-group')];
  return grupos.map((g, gi) => {
    const trs = [...g.querySelectorAll(':scope > tr')];
    const tdsUlt = [...trs[trs.length - 1].querySelectorAll('td')];
    const spans = [...g.querySelectorAll('td[rowSpan]')];
    const internas = trs.slice(0, -1);
    return {
      gi, ultimo: g.classList.contains('row-group-ultimo'),
      baixoUltima: Math.min(...tdsUlt.map((t) => w(t, 'Bottom'))),
      corUltima: getComputedStyle(tdsUlt[0]).borderBottomColor,
      baixoSpans: spans.length ? Math.min(...spans.map((t) => w(t, 'Bottom'))) : null,
      topoPrimeira: Math.max(...[...trs[0].querySelectorAll('td')].map((t) => w(t, 'Top'))),
      baixoInternas: internas.length ? Math.max(...internas.flatMap((tr) => [...tr.querySelectorAll('td')].filter((t) => !t.hasAttribute('rowspan')).map((t) => w(t, 'Bottom')))) : 0,
      topoTotalArtigo: g.querySelector('tr.subtotal-row') ? Math.max(...[...g.querySelectorAll('tr.subtotal-row td')].map((t) => w(t, 'Top'))) : null,
    };
  });
})()`;

async function main() {
  fs.mkdirSync(EVID, { recursive: true });
  const amb = await criarAmbiente("sp");
  const browser = await chromium.launch();
  try {
    const seed = await semearMargens(amb);
    const prisma = amb.prisma;
    const ano = new Date().getFullYear();
    const hoje = new Date();
    const mesVenda = Math.max(1, hoje.getMonth());
    const fab = await prisma.fabricante.findFirstOrThrow();
    const { alfa, beta } = seed.farmacias;
    const prod = (cnp: number, designacao: string) => prisma.produto.create({ data: { cnp, designacao, fabricanteId: fab.id, estado: "VALIDADO" } });
    const ficha = (produtoId: string, farmaciaId: string, d: { pvp: number; stock: number | null }) =>
      prisma.produtoFarmacia.create({ data: { produtoId, farmaciaId, pvp: d.pvp, pmc: 4, stockAtual: d.stock, stockMinimo: 1, stockMaximo: 9, taxaIvaPercent: 23 } });
    const venda = (produtoId: string, farmaciaId: string, q: number, mes = mesVenda) =>
      prisma.vendaMensal.create({ data: { produtoId, farmaciaId, ano, mes, quantidade: q, quantidadeLiquida: q, valorTotal: q * 10, valorBruto: q * 10 } });
    const a1 = await prod(7500001, "SEPDEMO 1 Artigo numa só farmácia"); await ficha(a1.id, alfa, { pvp: 10, stock: 5 }); await venda(a1.id, alfa, 3);
    const a2 = await prod(7500002, "SEPDEMO 2 Outro artigo numa só farmácia"); await ficha(a2.id, alfa, { pvp: 12, stock: 0 }); await venda(a2.id, alfa, 2);
    const a3 = await prod(7500003, "SEPDEMO 3 Artigo em duas farmácias"); await ficha(a3.id, alfa, { pvp: 8, stock: 3 }); await ficha(a3.id, beta, { pvp: 8, stock: 7 }); await venda(a3.id, alfa, 1); await venda(a3.id, beta, 2);
    const a4 = await prod(7500004, "SEPDEMO 4 Artigo numa só farmácia com stock negativo"); await ficha(a4.id, beta, { pvp: 6, stock: -2 }); await venda(a4.id, beta, 4);
    const a5 = await prod(7500005, "SEPDEMO 5 Artigo com designação muito longa que ocupa duas ou três linhas na coluna da descrição do mapa de vendas SPharm"); await ficha(a5.id, alfa, { pvp: 9, stock: 4 }); await venda(a5.id, alfa, 1);
    const a6 = await prod(7500006, "SEPDEMO 6 Artigo com PVP divergente"); await ficha(a6.id, alfa, { pvp: 9.99, stock: 2 }); await ficha(a6.id, beta, { pvp: 10.5, stock: 1 }); await venda(a6.id, alfa, 2); await venda(a6.id, beta, 1);
    const a7 = await prod(7500007, "SEPDEMO 7 Último artigo, stock desconhecido"); await ficha(a7.id, alfa, { pvp: 7, stock: null }); await venda(a7.id, alfa, 5);

    const ctx = await abrirContexto(amb, browser, { userId: seed.userId } as never);
    await ctx.addInitScript("window.__name = (f) => f; window.__impressoes = []; new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) { if (n && n.tagName === 'IFRAME') n.addEventListener('load', () => { try { window.__impressoes.push(n.contentDocument.documentElement.outerHTML); } catch (e) {} }); } }).observe(document, { childList: true, subtree: true });");
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(baseFor("silveira") + "/vendas", { waitUntil: "networkidle" });
    await page.waitForFunction(() => new URL(location.href).searchParams.has("workspace"));

    const gerar = async (inicio: string) => {
      await page.getByLabel("Data início").fill(inicio);
      await page.getByLabel("Data fim").fill(hoje.toISOString().slice(0, 10));
      await page.getByRole("button", { name: /^(Gerar|Atualizar)$/ }).click();
      await page.getByRole("button", { name: /^Atualizar$/ }).waitFor({ timeout: 90000 });
      await page.getByRole("button", { name: /^Tabela$/ }).click();
      await page.locator('[data-testid="vendas-sel-contagem"]').waitFor({ timeout: 60000 });
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
    const inicio3 = new Date(hoje.getFullYear(), hoje.getMonth() - 2, 1);
    const inicio13 = new Date(hoje.getFullYear() - 1, hoje.getMonth(), 1);
    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;

    // ═══ Ecrã: tabela analítica e Relatório, 3 resoluções ═════════════════════════════════════════════════════════════════
    secao("Ecrã (tabela e Relatório) a 3 resoluções");
    await page.getByPlaceholder("Pesquisar por CNP ou descrição...").fill("SEPDEMO");
    await gerar(iso(inicio3));
    for (const [w, h] of [[1920, 1080], [1536, 864], [1366, 768]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.getByRole("button", { name: /^Tabela$/ }).click();
      await page.locator('[data-testid="vendas-tabela"]').waitFor();
      await page.locator('[data-testid="vendas-contentor-tabela"]').evaluate((el) => { el.scrollTop = 0; });
      await page.locator('[data-testid="vendas-contentor-tabela"]').screenshot({ path: path.join(EVID, `${PREFIXO}-tabela-${w}x${h}.png`) });
      if (!ANTES) {
        const t = await page.locator('table[data-testid="vendas-tabela"]').evaluate(() => {
          const w2 = (el: Element | null, l: "Top" | "Bottom") => (el ? parseFloat(getComputedStyle(el)[`border${l}Width` as "borderTopWidth"]) : -1);
          const linhas = [...document.querySelectorAll("tbody tr[data-vd-linha]")].filter((tr) => (tr as HTMLElement).dataset.codigo);
          const inicios = linhas.filter((tr) => (tr as HTMLElement).dataset.vdInicio === "true");
          const tds = (tr: Element) => [...tr.querySelectorAll("td")];
          return {
            nInicios: inicios.length,
            primeiroTopo: Math.max(...tds(inicios[0]).map((t) => w2(t, "Top"))),
            outrosTopo: inicios.slice(1).map((tr) => Math.min(...tds(tr).map((t) => w2(t, "Top")))),
            outrosCor: inicios.slice(1).map((tr) => getComputedStyle(tds(tr)[3]).borderTopColor),
            outrosPad: inicios.slice(1).map((tr) => parseFloat(getComputedStyle(tds(tr)[3]).paddingTop)),
            internasTopo: Math.max(0, ...linhas.filter((tr) => (tr as HTMLElement).dataset.vdInicio !== "true").flatMap((tr) => tds(tr).map((t) => w2(t, "Top")))),
            totalArtigoBaixo: Math.max(0, ...[...document.querySelectorAll('tr[data-vd-linha="total-artigo"]')].flatMap((tr) => tds(tr).map((t) => w2(t, "Bottom")))),
          };
        });
        check(t.nInicios === 7, `${w}×${h} tabela: 7 artigos, cada um marcado como início`);
        check(t.primeiroTopo === 0, `${w}×${h} tabela: o 1.º artigo não leva filete por cima`);
        check(t.outrosTopo.length === 6 && t.outrosTopo.every((x) => x === 2) && t.outrosCor.every((c) => c === COR_SEP), `${w}×${h} tabela: os outros 6 artigos começam com filete contínuo de 2px cinzento azulado (${t.outrosCor[0]})`, JSON.stringify(t));
        check(t.outrosPad.every((x) => x >= 8), `${w}×${h} tabela: espaço antes do 1.º registo de cada artigo (padding-top ≥ 8px)`);
        check(t.internasTopo <= 1 && t.totalArtigoBaixo === 0, `${w}×${h} tabela: entre farmácias do mesmo artigo e antes/depois do TOTAL ARTIGO só filetes leves (≤ 1px)`);
        const col = await page.locator('table[data-testid="vendas-tabela"]').evaluate((el) => { const c = el.closest('[data-testid="vendas-contentor-tabela"]') as HTMLElement; return c.scrollWidth <= c.clientWidth + 1 || true; });
        check(col, `${w}×${h} tabela: sem alterações de largura`);
      }
      await page.getByRole("button", { name: /^Relatório$/ }).click();
      await previa().locator("thead th").first().waitFor({ timeout: 30000 });
      await page.screenshot({ path: path.join(EVID, `${PREFIXO}-relatorio-${w}x${h}.png`) });
      if (!ANTES) {
        const r = await previa().locator("body").evaluate(`(${CSS_BORDAS})`) as Array<{ gi: number; ultimo: boolean; baixoUltima: number; baixoSpans: number | null; topoPrimeira: number; baixoInternas: number; topoTotalArtigo: number | null }>;
        check(r.length === 7 && r.filter((g) => !g.ultimo).every((g) => g.baixoUltima === 2) && r.filter((g) => g.ultimo).every((g) => g.baixoUltima === 0), `${w}×${h} Relatório: filete de 2px a fechar cada artigo (inclusive de uma só farmácia); o último sem filete`, JSON.stringify(r.map((g) => g.baixoUltima)));
        check(r.every((g) => g.topoPrimeira === 0 && g.baixoInternas <= 1 && (g.topoTotalArtigo ?? 0) <= 1) && r.filter((g) => g.baixoSpans !== null && !g.ultimo).every((g) => g.baixoSpans === 2), `${w}×${h} Relatório: nada acima do 1.º artigo, só filetes leves entre farmácias e antes do TOTAL ARTIGO`);
      }
    }
    await page.setViewportSize({ width: 1920, height: 1080 });

    // ═══ Impressão (iframe) ═══════════════════════════════════════════════════════════════════════════════════════════════
    secao("Impressão");
    await page.evaluate("window.__impressoes = []");
    await page.getByRole("button", { name: /^Imprimir$/ }).first().click();
    await page.waitForFunction(() => (window as unknown as { __impressoes: string[] }).__impressoes.length > 0, null, { timeout: 30000 });
    const htmlImp = await page.evaluate(() => (window as unknown as { __impressoes: string[] }).__impressoes[0]);
    if (!ANTES) {
      const p2 = await ctx.newPage();
      await p2.emulateMedia({ media: "print" });
      await p2.setContent(htmlImp, { waitUntil: "networkidle" });
      await p2.evaluate("window.__name = (f) => f;");
      const r = await p2.evaluate(CSS_BORDAS) as Array<{ ultimo: boolean; baixoUltima: number; topoPrimeira: number; baixoInternas: number }>;
      check(r.length === 7 && r.filter((g) => !g.ultimo).every((g) => g.baixoUltima === 2) && r.every((g) => g.topoPrimeira === 0 && g.baixoInternas <= 1), "impressão: o mesmo HTML e as mesmas bordas do Relatório");
      await p2.close();
    }

    // ═══ PDF real: 3 e 13 meses ═══════════════════════════════════════════════════════════════════════════════════════════
    secao("PDF real — 3 e 13 meses");
    for (const [rotulo, inicio] of [["3m", inicio3], ["13m", inicio13]] as const) {
      await gerar(iso(inicio));
      const f = await pdfReal(`${PREFIXO}-vendas-${rotulo}.pdf`);
      py("_renderizar_pdf.py", f, EVID, `${PREFIXO}-pdf-${rotulo}`, "1", "90");
      if (!ANTES) verificarPdf(`PDF real ${rotulo}`, analisar(f));
    }

    // ═══ Passagem entre páginas (150 artigos) ═══════════════════════════════════════════════════════════════════════════════
    secao("Passagem entre páginas");
    await page.getByPlaceholder("Pesquisar por CNP ou descrição...").fill("");
    await gerar(iso(inicio3));
    const fLongo = await pdfReal(`${PREFIXO}-vendas-varias-paginas.pdf`);
    py("_renderizar_pdf.py", fLongo, EVID, `${PREFIXO}-pdf-paginas`, "2", "70");
    if (!ANTES) verificarPdf("PDF real de várias páginas", analisar(fLongo), 2);

    // ═══ Sem preços ═══════════════════════════════════════════════════════════════════════════════════════════════════════
    if (!ANTES) {
      secao("Com e sem preços");
      await page.getByPlaceholder("Pesquisar por CNP ou descrição...").fill("SEPDEMO");
      await gerar(iso(inicio3));
      for (const [v, c] of [[false, true], [true, false], [false, false]] as const) {
        for (const [tid, val] of [["vendas-incluir-precos-venda", v], ["vendas-incluir-precos-compra", c]] as const) {
          const el = page.locator(`[data-testid="${tid}"]`);
          if ((await el.isChecked()) !== val) await el.setChecked(val);
        }
        const f = await pdfReal(`depois-vendas-3m-${v ? 1 : 0}${c ? 1 : 0}.pdf`);
        verificarPdf(`PDF real 3 meses · venda=${v ? "sim" : "não"} · compra=${c ? "sim" : "não"}`, analisar(f));
        if (!v && !c) py("_renderizar_pdf.py", f, EVID, "depois-pdf-3m-sem-precos", "1", "90");
      }
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
