/**
 * scripts/e2e/vendas-mapa-visual-browser.ts
 *
 * Ensaio de BROWSER REAL (Chromium) contra o build de PRODUÇÃO, com control plane + PostgreSQL descartáveis
 * (ver `_ambiente-silveira.ts`; dados 100 % sintéticos), do Mapa de Vendas redesenhado:
 *
 *   1 · ecrã a 1920×1080, 1536×864 e 1366×768: hierarquia do artigo, cabeçalho fixo, colunas fixas à esquerda,
 *       barra de scroll no topo, última coluna alcançável sem ir ao fim da tabela;
 *   2 · valores monetários grandes completos (ecrã, PDF real, Excel real) e total geral;
 *   3 · seleção de artigos (todos por omissão, parcial, zero, «selecionar todos») e o seu efeito nas 4 saídas;
 *   4 · PDF real multi-página: cabeçalho repetido, artigo+total na mesma página, sem controlos, a cinzento;
 *   5 · impressão (iframe), Excel (download real) e Email (pedido interceptado, sem enviar nada): MESMO relatório;
 *   6 · 13 meses (1 tabela) e 27 meses (3 partes);
 *   7 · texto do âmbito (vendas + stock sem vendas).
 *
 * Pré-requisito: `npx next build` com SERVER_ACTIONS_ALLOWED_ORIGINS="localhost:3100,127.0.0.1:3100,*.localhost:3100".
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/e2e/vendas-mapa-visual-browser.ts
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import * as XLSX from "xlsx";
import { chromium, type Page, type BrowserContext } from "playwright";
import { baseFor, criarAmbiente, type Ambiente } from "./_ambiente-silveira";
import { abrirContexto } from "./_grupo-comum";
import { renderReportHtml } from "../../lib/reporting/report-html";
import type { Report } from "../../lib/reporting/report-types";

let ok = 0;
let falhas = 0;
const check = (cond: boolean, msg: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${msg}`); }
  else { falhas++; console.log(`  [FALHA] ${msg}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const secao = (t: string) => console.log(`\n── ${t}`);
const EVID = path.resolve("docs/validacao-visual/2026-10-vendas-mapa");
const norm = (t: string) => t.replace(/[  ]/g, " ");
const eur = (n: number) => norm(new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(n));

// ─── dados sintéticos ──────────────────────────────────────────────────────
const CNP = { C1: 8100001, C2: 8100002, C3: 8100003, C4: 8100004, NEG: 8100005, SC: 8100006, SP: 8100007, Z0: 8100008, ZN: 8100009, SV: 8100010, SVSS: 8100011, LONG: 8100012, ABC: 8100013, ARNICA: 8100014 };

type Mes = { ano: number; mes: number };
/** Os últimos `n` meses COMPLETOS (o mês corrente não entra), do mais antigo ao mais recente. */
function ultimosMeses(n: number): Mes[] {
  const hoje = new Date();
  const out: Mes[] = [];
  let ano = hoje.getFullYear();
  let mes = hoje.getMonth(); // 0-based → mês anterior em 1-based
  if (mes === 0) { ano -= 1; mes = 12; }
  for (let i = 0; i < n; i++) {
    out.unshift({ ano, mes });
    mes -= 1;
    if (mes === 0) { mes = 12; ano -= 1; }
  }
  return out;
}
function periodo(n: number) {
  const ms = ultimosMeses(n);
  const a = ms[0];
  const z = ms[ms.length - 1];
  const ultimoDia = new Date(z.ano, z.mes, 0).getDate();
  return { from: `${a.ano}-${String(a.mes).padStart(2, "0")}-01`, to: `${z.ano}-${String(z.mes).padStart(2, "0")}-${String(ultimoDia).padStart(2, "0")}`, meses: ms };
}

async function semear(amb: Ambiente): Promise<{ userId: string }> {
  const prisma = amb.prisma;
  const user = await prisma.utilizador.create({ data: { email: "e2e@spharm.test", nome: "E2E Admin", perfil: "ADMINISTRADOR" } });
  const alfa = await prisma.farmacia.create({ data: { nome: "Farmacia Alfa" } });
  const beta = await prisma.farmacia.create({ data: { nome: "Farmacia Beta" } });
  const labA = await prisma.fabricante.create({ data: { nomeNormalizado: "LAB A E2E" } });
  const labB = await prisma.fabricante.create({ data: { nomeNormalizado: "LAB B E2E" } });
  const meses27 = ultimosMeses(27);
  const ultimo = meses27[meses27.length - 1];

  type Pf = { pvp?: number | null; custo?: number | null; stock: number };
  const criar = async (cnp: number, designacao: string, fab: string, pfs: Array<[string, Pf]>, vendas: Array<[string, Mes, number]>) => {
    const p = await prisma.produto.create({ data: { cnp, designacao, fabricanteId: fab, estado: "VALIDADO" } });
    for (const [farmaciaId, o] of pfs) {
      await prisma.produtoFarmacia.create({
        data: {
          produtoId: p.id, farmaciaId, pvp: o.pvp === undefined ? 12.5 : o.pvp, pmc: o.custo ?? null, puc: o.custo ?? null,
          stockAtual: o.stock, stockMinimo: 1, stockMaximo: 50, taxaIvaPercent: 23,
        },
      });
    }
    if (vendas.length > 0) {
      await prisma.vendaMensal.createMany({
        data: vendas.map(([farmaciaId, m, q]) => ({
          farmaciaId, produtoId: p.id, ano: m.ano, mes: m.mes, quantidade: q, quantidadeLiquida: q, valorTotal: q * 20, valorBruto: q * 20,
        })),
      });
    }
  };
  const nasMeses = (f: string, q: number, ms: Mes[] = meses27): Array<[string, Mes, number]> => ms.map((m) => [f, m, q]);

  // custos grandes (um só movimento no último mês completo → custo total = custo unitário)
  await criar(CNP.C1, "CUSTO 9999,99 E2E", labA.id, [[alfa.id, { custo: 9999.99, stock: 3 }]], [[alfa.id, ultimo, 1]]);
  await criar(CNP.C2, "CUSTO 10000 E2E", labA.id, [[alfa.id, { custo: 10000, stock: 3 }], [beta.id, { custo: 10000, stock: 2 }]], [[alfa.id, ultimo, 1], [beta.id, ultimo, 1]]);
  await criar(CNP.C3, "CUSTO 99999,99 E2E", labB.id, [[alfa.id, { custo: 99999.99, stock: 1 }]], [[alfa.id, ultimo, 1]]);
  await criar(CNP.C4, "CUSTO 999999,99 E2E", labB.id, [[beta.id, { custo: 999999.99, stock: 1 }]], [[beta.id, ultimo, 1]]);
  // devolução (quantidade líquida negativa), sem custo, sem PVP, stock zero/negativo
  await criar(CNP.NEG, "DEVOLUCAO LIQUIDA NEGATIVA E2E", labA.id, [[alfa.id, { custo: 5, stock: 4 }]], [[alfa.id, meses27[meses27.length - 2], -3], [alfa.id, ultimo, 1]]);
  await criar(CNP.SC, "SEM CUSTO E2E", labA.id, [[alfa.id, { custo: null, stock: 4 }]], [[alfa.id, ultimo, 4]]);
  await criar(CNP.SP, "SEM PVP E2E", labA.id, [[alfa.id, { pvp: null, custo: 3, stock: 4 }]], [[alfa.id, ultimo, 2]]);
  await criar(CNP.Z0, "STOCK ZERO E2E", labA.id, [[alfa.id, { custo: 4, stock: 0 }]], [[alfa.id, ultimo, 3]]);
  await criar(CNP.ZN, "STOCK NEGATIVO E2E", labA.id, [[alfa.id, { custo: 4, stock: -3 }]], [[alfa.id, ultimo, 3]]);
  await criar(CNP.SV, "SEM VENDAS COM STOCK E2E", labB.id, [[alfa.id, { custo: 4, stock: 5 }]], []);
  await criar(CNP.SVSS, "SEM VENDAS SEM STOCK E2E", labB.id, [[alfa.id, { custo: 4, stock: 0 }]], []);
  await criar(CNP.LONG, "DESCRICAO MUITO LONGA PARA TESTAR A QUEBRA DE LINHA NA COLUNA DESCRICAO DO MAPA DE VENDAS E2E 500 MG COMPRIMIDOS REVESTIDOS", labA.id, [[alfa.id, { custo: 2, stock: 7 }]], nasMeses(alfa.id, 1));
  await criar(CNP.ABC, "abc minúsculas E2E", labA.id, [[alfa.id, { custo: 2, stock: 7 }]], [[alfa.id, ultimo, 2]]);
  await criar(CNP.ARNICA, "ÁRNICA ORDEM E2E", labA.id, [[alfa.id, { custo: 2, stock: 7 }]], [[alfa.id, ultimo, 2]]);
  // enchimento (várias páginas): 60 artigos, os de índice par nas duas farmácias, em todos os 27 meses
  for (let i = 1; i <= 60; i++) {
    const nome = `ARTIGO VOL ${String(i).padStart(3, "0")} E2E`;
    const duas = i % 2 === 0;
    await criar(7100000 + i, nome, i % 3 === 0 ? labB.id : labA.id,
      duas ? [[alfa.id, { custo: 3 + (i % 5), stock: i % 9 === 0 ? 0 : 6 }], [beta.id, { custo: 4 + (i % 5), stock: 5 }]] : [[alfa.id, { custo: 3 + (i % 5), stock: 6 }]],
      [...nasMeses(alfa.id, 1 + (i % 3)), ...(duas ? nasMeses(beta.id, 1 + (i % 4)) : [])]);
  }
  return { userId: user.id };
}

// ─── utilitários de saídas ─────────────────────────────────────────────────
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
type Palavra = [number, number, number, number, string, number];
type PdfPalavras = { paginas: { w: number; h: number; palavras: Palavra[] }[] };
function palavrasPdf(ficheiro: string): PdfPalavras {
  const py = spawnSync("python", [path.resolve("scripts/e2e/_palavras_pdf.py"), ficheiro], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (py.status !== 0) throw new Error(`python falhou: ${py.stderr}`);
  return JSON.parse(py.stdout.trim().split("\n").pop() ?? "{}") as PdfPalavras;
}
function renderizar(ficheiro: string, prefixo: string, paginas = 2): number {
  const py = spawnSync("python", [path.resolve("scripts/e2e/_renderizar_pdf.py"), ficheiro, EVID, prefixo, String(paginas), "80"], { encoding: "utf8" });
  if (py.status !== 0) throw new Error(`python falhou: ${py.stderr}`);
  return Number(py.stdout.trim());
}
const textoPag = (p: PdfPalavras["paginas"][number]) => norm(p.palavras.map((w) => w[4]).join(" "));
function linhasPag(p: PdfPalavras["paginas"][number]): string[] {
  const ord = [...p.palavras].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const out: Palavra[][] = [];
  for (const w of ord) { const l = out[out.length - 1]; if (l && Math.abs(l[0][1] - w[1]) < 2.5) l.push(w); else out.push([w]); }
  return out.map((l) => norm(l.sort((a, b) => a[0] - b[0]).map((w) => w[4]).join(" ")));
}

const INIT_CAPTURA_IMPRESSAO = `
  window.__impressoes = [];
  new MutationObserver((ms) => {
    for (const m of ms) for (const n of m.addedNodes) {
      if (n && n.tagName === 'IFRAME') n.addEventListener('load', () => {
        try { window.__impressoes.push(n.contentDocument.documentElement.outerHTML); } catch (e) {}
      });
    }
  }).observe(document, { childList: true, subtree: true });
`;

type Saida = { pdf: Buffer; ficheiro: string; relatorio: Report; corpo: string };
async function pedirPdf(page: Page, ctx: BrowserContext, nome: string): Promise<Saida> {
  const [req] = await Promise.all([
    page.waitForRequest((r) => r.url().includes("/api/reports/pdf"), { timeout: 180000 }),
    page.getByRole("button", { name: /^PDF$/ }).first().click(),
  ]);
  const corpo = req.postDataBuffer()!;
  const cookies = (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  const pdf = await postBinario(new URL(req.url()), corpo, cookies);
  const f = path.join(EVID, nome);
  fs.writeFileSync(f, pdf);
  const json = JSON.parse(corpo.toString("utf8")) as Record<string, unknown>;
  const relatorio = (json.report ?? json) as Report;
  if (typeof relatorio.generatedAt === "string") relatorio.generatedAt = new Date(relatorio.generatedAt);
  await page.getByRole("button", { name: /^PDF$/ }).first().waitFor({ timeout: 60000 });
  return { pdf, ficheiro: f, relatorio, corpo: corpo.toString("utf8") };
}

async function gerar(page: Page, from: string, to: string) {
  await page.getByLabel("Data início").fill(from);
  await page.getByLabel("Data fim").fill(to);
  await page.getByRole("button", { name: /^(Gerar|Atualizar)$/ }).click();
  await page.getByRole("button", { name: /^Atualizar$/ }).waitFor({ timeout: 120000 });
  await page.locator('[data-testid="vendas-sel-contagem"]').waitFor({ timeout: 60000 });
}
const codigosEcra = (page: Page) => page.locator('[data-testid^="vendas-sel-artigo-"]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.testid!.replace("vendas-sel-artigo-", "")));
const nDetalhe = (r: Report) => r.rows.filter((x) => x.__rowKind !== "subtotal").length;
const cnpsDoRelatorio = (r: Report) => [...new Set(r.rows.map((x) => String(x.codigo)))];

async function main() {
  fs.mkdirSync(EVID, { recursive: true });
  const amb = await criarAmbiente("vm");
  const browser = await chromium.launch();
  try {
    const seed = await semear(amb);
    const ctx = await abrirContexto(amb, browser, { userId: seed.userId } as never);
    await ctx.addInitScript(INIT_CAPTURA_IMPRESSAO);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(baseFor("silveira") + "/vendas", { waitUntil: "networkidle" });

    const p13 = periodo(13);
    await gerar(page, p13.from, p13.to);

    // ═══ 1 · Ecrã nas 3 resoluções ═════════════════════════════════
    secao("1 · Ecrã — 13 meses a 1920×1080, 1536×864 e 1366×768");
    const cods = await codigosEcra(page);
    const nArtigos = cods.length;
    const colator = new Intl.Collator("pt", { sensitivity: "base" });
    const descricoes = await page.locator('table[data-testid="vendas-tabela"] tbody tr[data-vd-inicio="true"] td.col-desc a, table[data-testid="vendas-tabela"] tbody tr[data-vd-inicio="true"] td.col-desc').evaluateAll((els) => els.map((e) => (e as HTMLElement).innerText.split("\n")[0].trim()).filter(Boolean));
    let alfa = true;
    for (let i = 1; i < descricoes.length; i++) if (colator.compare(descricoes[i - 1], descricoes[i]) > 0) { alfa = false; break; }
    check(alfa && descricoes.length >= nArtigos - 1, `ordem alfabética por omissão (sem maiúsculas/acentos): ${descricoes.slice(0, 3).join(" | ")}`);
    check(String(CNP.SV) !== "" && cods.includes(String(CNP.SV)), "«sem vendas mas com stock» aparece (Incluir stock sem vendas ligado)");
    check(!cods.includes(String(CNP.SVSS)), "«sem vendas e sem stock» não aparece");

    const cabecalhos = await page.locator('table[data-testid="vendas-tabela"] thead th').evaluateAll((ths) => ths.map((t) => (t as HTMLElement).innerText.replace(/\s+/g, " ").trim()));
    const esperados = ["CNP", "Descrição", "Farmácia", "PVP", "Custo unit. est.", "Custo total est.", "Total Unid.", "Stock", "Vendas s/IVA (€)"];
    check(esperados.every((e) => cabecalhos.includes(e)), `colunas pedidas presentes: ${cabecalhos.join(" | ")}`);
    check(cabecalhos.length === 1 + 6 + 13 + 3, `1 (seleção) + 6 fixas + 13 meses + 3 finais = ${cabecalhos.length}`);

    for (const [w, h] of [[1920, 1080], [1536, 864], [1366, 768]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(600);
      const SEL = '[data-testid="vendas-contentor-tabela"]';
      const info = await page.evaluate((sel) => {
        const c = document.querySelector(sel) as HTMLElement;
        const barra = document.querySelector('[data-testid="barra-scroll-topo"]') as HTMLElement | null;
        return { sw: c.scrollWidth, cw: c.clientWidth, barraVisivel: !!barra && !barra.classList.contains("hidden") && barra.getBoundingClientRect().height > 0 };
      }, SEL);
      const transborda = info.sw > info.cw + 1;
      check(!transborda || info.barraVisivel, `${w}×${h}: ${transborda ? `tabela mais larga (${info.sw} > ${info.cw}) → barra de scroll no TOPO visível` : "a tabela cabe sem scroll horizontal"}`);
      if (transborda) {
        // alcançar a última coluna SEM descer ao fim da tabela
        await page.evaluate((sel2) => { (document.querySelector(sel2) as HTMLElement).scrollTop = 0; const b = document.querySelector('[data-testid="barra-scroll-topo"]') as HTMLElement; b.scrollLeft = b.scrollWidth; }, SEL);
        // a barra espelho propaga o scroll para a tabela de forma assíncrona (evento scroll): espera até estabilizar
        await page.waitForFunction((sel2) => { const c = document.querySelector(sel2) as HTMLElement; return c.scrollLeft > 0 && c.scrollLeft + c.clientWidth >= c.scrollWidth - 2; }, SEL, { timeout: 10000 }).catch(() => undefined);
        await page.waitForTimeout(200);
        const r = await page.evaluate((sel) => {
          const c = document.querySelector(sel) as HTMLElement;
          const ths = Array.from(c.querySelectorAll("thead th")) as HTMLElement[];
          const ultimo = ths[ths.length - 1].getBoundingClientRect();
          const cr = c.getBoundingClientRect();
          const cnp = (c.querySelector("thead th.col-cnp") as HTMLElement).getBoundingClientRect();
          return { scrollLeft: c.scrollLeft, scrollTop: c.scrollTop, ultimoDentro: ultimo.right <= cr.right + 1 && ultimo.left >= cr.left, cnpFixo: Math.abs(cnp.left - (cr.left + 32)) < 2, texto: ths[ths.length - 1].innerText.replace(/\s+/g, " ").trim() };
        }, SEL);
        check(r.scrollLeft > 0 && r.scrollTop === 0 && r.ultimoDentro, `${w}×${h}: pela barra do topo chega-se à última coluna («${r.texto}») sem scroll vertical`);
        check(r.cnpFixo, `${w}×${h}: CNP (e Descrição) ficam fixos à esquerda durante o scroll horizontal`);
        await page.evaluate(() => { const b = document.querySelector('[data-testid="barra-scroll-topo"]') as HTMLElement; b.scrollLeft = 0; });
      }
      // cabeçalho fixo: scroll vertical dentro do contentor
      const cab = await page.evaluate((sel) => {
        const c = document.querySelector(sel) as HTMLElement;
        c.scrollTop = 600;
        const th = c.querySelector("thead th.col-desc") as HTMLElement;
        const cr = c.getBoundingClientRect();
        const tr = th.getBoundingClientRect();
        const ponto = document.elementFromPoint(tr.left + 20, tr.top + tr.height / 2);
        const r = { scrollTop: c.scrollTop, desvio: Math.round(tr.top - cr.top), noTopo: !!ponto && th.contains(ponto) };
        c.scrollTop = 0;
        return r;
      }, SEL);
      check(cab.scrollTop > 0 && Math.abs(cab.desvio) <= 1 && cab.noTopo, `${w}×${h}: cabeçalho fixo e visível por cima das linhas (scrollTop ${cab.scrollTop}, desvio ${cab.desvio})`);
      await page.screenshot({ path: path.join(EVID, `ecra-${w}x${h}.png`) });
    }
    await page.setViewportSize({ width: 1920, height: 1080 });

    // hierarquia: 1 identificação por artigo, «Total artigo» só com várias farmácias
    const hier = await page.evaluate(() => {
      const trs = Array.from(document.querySelectorAll('table[data-testid="vendas-tabela"] tbody tr[data-codigo]')) as HTMLElement[];
      const porCodigo = new Map<string, HTMLElement[]>();
      for (const t of trs) { const c = t.dataset.codigo!; porCodigo.set(c, [...(porCodigo.get(c) ?? []), t]); }
      let erros = 0;
      for (const [, ls] of porCodigo) {
        const detalhes = ls.filter((l) => l.dataset.vdLinha === "detalhe");
        const totais = ls.filter((l) => l.dataset.vdLinha === "total-artigo");
        const idents = detalhes.filter((l) => (l.querySelector("td.col-cnp") as HTMLElement).innerText.trim() !== "");
        if (idents.length !== 1) erros++;
        if (detalhes.length > 1 ? totais.length !== 1 : totais.length !== 0) erros++;
        if (totais.length === 1 && ls[ls.length - 1] !== totais[0]) erros++;
      }
      return { artigos: porCodigo.size, erros };
    });
    check(hier.erros === 0, `${hier.artigos} artigos: CNP+Descrição uma vez; «Total artigo» só com 2+ farmácias e sempre no fim do bloco`);
    const nTotaisArt = await page.locator('tr[data-vd-linha="total-artigo"]').count();
    check(nTotaisArt >= 30, `existem ${nTotaisArt} linhas «Total artigo» (artigos em Alfa+Beta)`);
    const stockZero = await page.locator('[data-stock="zero"]').count();
    const stockNeg = await page.locator('[data-stock="negativo"]').count();
    check(stockZero > 0 && stockNeg === 1, `stock com indicador: ${stockZero} a zero (caixa), ${stockNeg} negativo (escuro)`);

    // ═══ 2 · Valores grandes no ecrã ═══════════════════════════════
    secao("2 · Valores monetários completos no ecrã");
    const linha = (cnp: number) => page.locator(`tr[data-codigo="${cnp}"]`).first();
    const txt = async (cnp: number) => norm((await linha(cnp).innerText()).replace(/\s+/g, " "));
    for (const [cnp, v] of [[CNP.C1, 9999.99], [CNP.C3, 99999.99], [CNP.C4, 999999.99]] as const) {
      check((await txt(cnp)).includes(eur(v)), `ecrã: ${eur(v)} completo na linha ${cnp}`);
    }
    const c2 = page.locator(`tr[data-codigo="${CNP.C2}"][data-vd-linha="total-artigo"]`);
    check(norm(await c2.innerText()).includes(eur(20000)), `ecrã: «Total artigo» do CNP ${CNP.C2} = ${eur(20000)}`);
    check((await txt(CNP.SC)).includes("—"), "ecrã: custo desconhecido = «—» (nunca 0,00 €)");
    check(/-?10,00/.test(await txt(CNP.NEG)) && (await txt(CNP.NEG)).includes("-2"), "ecrã: devolução líquida visível (quantidade -2, custo -10,00 €)");
    const totalCustoEcra = norm(await page.locator('[data-testid="vendas-total-custo"]').innerText());
    check(/\*/.test(totalCustoEcra), `ecrã: total de custo marcado PARCIAL (${totalCustoEcra.trim()})`);
    await page.locator('[data-testid="vendas-contentor-tabela"]').evaluate((c) => { c.scrollTop = c.scrollHeight; });
    await page.screenshot({ path: path.join(EVID, "ecra-total-geral.png") });
    await page.locator('[data-testid="vendas-contentor-tabela"]').evaluate((c) => { c.scrollTop = 0; });

    // ═══ 3/4 · PDF real (todos) ════════════════════════════════════
    secao("3 · PDF real — todos os artigos (13 meses)");
    const sTodos = await pedirPdf(page, ctx, "vendas-13-meses-todos.pdf");
    const pT = palavrasPdf(sTodos.ficheiro);
    const nPag = renderizar(sTodos.ficheiro, "pdf-13-meses", 2);
    const linhasT = pT.paginas.flatMap(linhasPag);
    const todoT = linhasT.join("\n");
    check(pT.paginas.length >= 3 && pT.paginas.length === nPag, `PDF multi-página (${pT.paginas.length} páginas)`);
    check(pT.paginas[0].w > pT.paginas[0].h, "A4 horizontal");
    check(pT.paginas.every((pg) => { const t = textoPag(pg); return t.includes("CNP") && t.includes("Descrição") && t.includes("Stock") && t.includes("Valor Vendas"); }), "cabeçalho da tabela repetido em TODAS as páginas");
    check(cnpsDoRelatorio(sTodos.relatorio).length === nArtigos, `o relatório tem os ${nArtigos} artigos do ecrã`);
    const cnpsPdf = new Set([...todoT.matchAll(/\b(81000\d\d|71000\d\d)\b/g)].map((m) => m[0]));
    check(cnpsPdf.size === nArtigos, `o PDF mostra ${cnpsPdf.size} artigos (esperado ${nArtigos})`);
    for (const [cnp, v] of [[CNP.C1, 9999.99], [CNP.C2, 10000], [CNP.C3, 99999.99], [CNP.C4, 999999.99]] as const) {
      check(todoT.includes(eur(v)), `PDF: custo ${eur(v)} completo (${cnp})`);
    }
    check(todoT.includes(eur(20000)), `PDF: «Total artigo» ${eur(20000)} completo`);
    const totalGeralLinha = linhasT.find((l) => l.startsWith("TOTAL GERAL")) ?? "";
    const custoTotalPdf = (sTodos.relatorio.summary ?? []).find((s) => /Custo total estimado/.test(s.label))?.value as number;
    check(totalGeralLinha.includes(eur(custoTotalPdf)), `PDF: TOTAL GERAL do custo (${eur(custoTotalPdf)}) completo — «${totalGeralLinha.slice(0, 90)}»`);
    check((todoT.match(/TOTAL GERAL(?! está no fim)/g) ?? []).length === 1 && textoPag(pT.paginas[pT.paginas.length - 1]).includes("TOTAL GERAL"), "TOTAL GERAL uma vez, na última página");
    check(/Custo total PARCIAL: 1 linha/.test(todoT), "PDF: custo total PARCIAL assinalado (1 linha sem custo)");
    check(!/[☐□▢]/.test(todoT) && !/checkbox/i.test(todoT), "PDF: sem checkboxes/caixas vazias");
    check(pT.paginas.every((pg) => pg.palavras.every((w) => w[2] <= pg.w - 8)), "PDF: nada ultrapassa a margem direita");
    // artigo + total na mesma página
    let separados = 0;
    for (const c of cnpsDoRelatorio(sTodos.relatorio)) {
      const linhasArt = sTodos.relatorio.rows.filter((r) => String(r.codigo) === c);
      if (!linhasArt.some((r) => r.__rowKind === "subtotal")) continue;
      const pg = pT.paginas.find((x) => x.palavras.some((w) => w[4] === c))!;
      const wc = pg.palavras.find((w) => w[4] === c)!;
      if (!pg.palavras.some((w) => w[4] === "ARTIGO" && w[1] >= wc[1] - 1 && w[1] <= wc[1] + 60)) separados++;
    }
    check(separados === 0, "nenhum artigo separado do seu «Total artigo» entre páginas");
    // cinzento: stock negativo escuro, positivo claro
    const negs = pT.paginas.flatMap((pg) => pg.palavras).filter((w) => w[4] === "-3");
    check(negs.length > 0 && negs.some((w) => w[5] < 130), `PDF a cinzento: stock negativo legível por contraste (cinza médio ${negs.map((w) => w[5]).join(",")})`);
    // âmbito
    check(/Naturezas:\s*Normal; com crédito, sem transferências/.test(todoT.replace(/\n/g, " ")), "PDF: «Naturezas» listadas");
    check(/Artigos incluídos:\s*com vendas no período \+ sem vendas mas com stock atual/.test(todoT.replace(/\n/g, " ")), "PDF: explicação da união «vendas + stock sem vendas»");
    check(!/Apenas com vendas|Fabricantes:|Pesquisa:/.test(todoT), "PDF: sem filtros não aplicados");
    check(/Âmbito:\s*Farmácia/.test(todoT.replace(/\n/g, " ")) && /Agrupar por:\s*Artigo/.test(todoT.replace(/\n/g, " ")), "PDF: âmbito e agrupamento em texto legível");

    // ═══ 5 · Impressão, Excel e Email = mesmo relatório ═════════════
    secao("4 · Impressão, Excel e Email — o MESMO relatório do PDF");
    await page.evaluate(() => { (window as unknown as { __impressoes: string[] }).__impressoes = []; });
    await page.getByRole("button", { name: /^Imprimir$/ }).first().click();
    await page.waitForFunction(() => (window as unknown as { __impressoes: string[] }).__impressoes.length > 0, null, { timeout: 30000 });
    const htmlImp = await page.evaluate(() => (window as unknown as { __impressoes: string[] }).__impressoes[0]);
    const tabelaDe = (h: string) => h.slice(h.indexOf('<section class="table-wrap'), h.indexOf("</section>", h.indexOf('<section class="table-wrap')));
    // o iframe serializa o HTML (aspas, <br/>→<br>): compara-se o TEXTO da tabela célula a célula e o nº de linhas
    const textoTab = (h: string) => tabelaDe(h).replace(/<tr[^>]*>/g, "#").replace(/<[^>]+>/g, "|").replace(/&amp;/g, "&").replace(/\|+/g, "|").replace(/&#39;/g, "'").replace(/&nbsp;|&#8239;|[  ]/g, " ");
    {
      const a = textoTab(htmlImp), b = textoTab(renderReportHtml(sTodos.relatorio));
      let i = 0; while (i < a.length && a[i] === b[i]) i++;
      check(a === b, "impressão: o conteúdo da tabela é IDÊNTICO ao do HTML que gerou o PDF", `difere em ${i}: «${a.slice(i - 40, i + 60)}» vs «${b.slice(i - 40, i + 60)}»`);
    }
    check(!/<(input|button|select)\b|type="checkbox"/.test(htmlImp), "impressão: sem checkboxes, botões ou controlos");
    check(/@page \{ size: A4 landscape/.test(htmlImp) && /thead \{ display: table-header-group/.test(htmlImp), "impressão: A4 horizontal e cabeçalho repetido por página");

    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.getByRole("button", { name: /^Excel$/ }).first().click()]);
    const fx = path.join(EVID, "vendas-13-meses-todos.xlsx");
    await dl.saveAs(fx);
    const wb = XLSX.readFile(fx);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const grelha = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false }) as unknown[][];
    const iCab = grelha.findIndex((r) => r[0] === "CNP");
    const cab = grelha[iCab] as string[];
    const dados = grelha.slice(iCab + 1);
    check(cab.every((h) => typeof h === "string" && h.trim() !== ""), `Excel: nenhuma coluna vazia (${cab.length} colunas)`);
    check(!JSON.stringify(grelha).match(/☐|□|checkbox/i), "Excel: sem checkboxes");
    check(dados.length === sTodos.relatorio.rows.length + 1, `Excel: ${sTodos.relatorio.rows.length} linhas + TOTAL GERAL = ${dados.length}`);
    check(String(dados[dados.length - 1][0]) === "TOTAL GERAL", "Excel: última linha «TOTAL GERAL»");
    const iUn = cab.findIndex((h) => h.replace(/\s+/g, " ") === "Total Unid.");
    const iVal = cab.findIndex((h) => h.replace(/\s+/g, " ") === "Valor Vendas (s/IVA)");
    const iCusto = cab.findIndex((h) => h.replace(/\s+/g, " ") === "Custo total est.");
    check(dados.slice(0, -1).every((r) => typeof r[iUn] === "number" && typeof r[iVal] === "number"), "Excel: unidades e valores são NÚMEROS");
    const detalheX = dados.slice(0, -1).filter((r) => r[cab.indexOf("Tipo de linha")] === "Detalhe");
    const somaCusto = Math.round(detalheX.reduce((a, r) => a + (typeof r[iCusto] === "number" ? (r[iCusto] as number) : 0), 0) * 100) / 100;
    check(Math.abs((dados[dados.length - 1][iCusto] as number) - somaCusto) < 0.01 && Math.abs(somaCusto - custoTotalPdf) < 0.01, `Excel: custo TOTAL GERAL = soma do detalhe = PDF (${somaCusto})`);
    check(!!ws["!autofilter"], "Excel: filtro automático ativo");
    const ordemX = detalheX.map((r) => String(r[0]));
    const ordemR = sTodos.relatorio.rows.filter((r) => r.__rowKind !== "subtotal").map((r) => String(r.codigo));
    check(JSON.stringify(ordemX) === JSON.stringify(ordemR), "Excel: mesma ordem do relatório/ecrã");

    const capturas: string[] = [];
    await page.route("**/api/reports/email", async (route) => {
      capturas.push(route.request().postData() ?? "");
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, messageId: "e2e-sem-envio" }) });
    });
    await page.getByRole("button", { name: /^Email$/ }).first().click();
    await page.getByPlaceholder("nome@dominio.pt, outro@dominio.pt").fill("destinatario@exemplo.invalid");
    await page.getByRole("button", { name: /^Enviar$/ }).click();
    await page.waitForFunction(() => document.body.innerText.includes("Email enviado"), null, { timeout: 30000 });
    const emailJson = JSON.parse(capturas[0]) as { report: Report; attachFormats?: string[] };
    check(JSON.stringify(emailJson.report.rows) === JSON.stringify(sTodos.relatorio.rows) && JSON.stringify(emailJson.report.columns) === JSON.stringify(sTodos.relatorio.columns), "email: pedido com as MESMAS linhas e colunas do PDF (nada foi enviado: pedido interceptado)");
    check(JSON.stringify(emailJson.report.filtersApplied) === JSON.stringify(sTodos.relatorio.filtersApplied), "email: mesmos filtros/âmbito");
    await page.getByRole("button", { name: "Fechar" }).click().catch(() => undefined);
    await page.unroute("**/api/reports/email");

    // ═══ Separador «Relatório» = o MESMO documento ═══════════════════
    secao("4b · Separador «Relatório» — pré-visualização fiel (uma só estrutura visual)");
    await page.getByRole("button", { name: /^Relatório$/ }).click();
    const frame = page.locator('[data-testid="vendas-relatorio-previa"]');
    await frame.waitFor({ timeout: 30000 });
    await page.waitForTimeout(800);
    const fr = page.frameLocator('[data-testid="vendas-relatorio-previa"]');
    const htmlPrev = await frame.evaluate((el) => (el as HTMLIFrameElement).contentDocument!.documentElement.outerHTML);
    const normTab = (h: string) => tabelaDe(h).replace(/<tr[^>]*>/g, "#").replace(/<[^>]+>/g, "|").replace(/&amp;/g, "&").replace(/\|+/g, "|").replace(/&#39;/g, "'").replace(/&nbsp;|[\u202f\u00a0]/g, " ");
    check(normTab(htmlPrev) === normTab(renderReportHtml(sTodos.relatorio)), "«Relatório»: a tabela é IDÊNTICA à do PDF/impressão");
    check(!/<(input|button|select)\b|type="checkbox"/.test(htmlPrev), "«Relatório»: sem controlos");
    const txtPrev = norm(await fr.locator("body").innerText());
    for (const [cnp, v] of [[CNP.C1, 9999.99], [CNP.C2, 10000], [CNP.C3, 99999.99], [CNP.C4, 999999.99]] as const) {
      check(txtPrev.includes(eur(v)), `«Relatório»: custo ${eur(v)} completo (${cnp})`);
    }
    check(txtPrev.includes("TOTAL GERAL") && txtPrev.includes(eur(custoTotalPdf)), `«Relatório»: TOTAL GERAL do custo ${eur(custoTotalPdf)} completo`);
    check(!/Página 1 de 1|SoftReis Informática/.test(txtPrev), "«Relatório»: o layout antigo desapareceu");
    check((await fr.locator("thead th").count()) === 6 + 13 + 3, "«Relatório»: mesmas colunas do PDF (6 + 13 meses + 3)");
    await page.screenshot({ path: path.join(EVID, "ecra-relatorio-13-meses.png") });
    await page.getByRole("button", { name: /^Tabela$/ }).click();

    // ═══ 3b · Seleção ══════════════════════════════════════════════
    secao("5 · Seleção de artigos e saídas");
    const contagem = async () => (await page.locator('[data-testid="vendas-sel-contagem"]').innerText()).replace(/\s+/g, " ");
    check((await contagem()).startsWith(`${nArtigos} de ${nArtigos} artigos selecionados para impressão`), `todos selecionados por omissão: «${await contagem()}»`);
    await page.locator(`[data-testid="vendas-sel-artigo-${CNP.C1}"]`).uncheck();
    await page.locator(`[data-testid="vendas-sel-artigo-${CNP.C4}"]`).uncheck();
    check((await contagem()).startsWith(`${nArtigos - 2} de ${nArtigos}`), `parcial: «${await contagem()}»`);
    check((await codigosEcra(page)).length === nArtigos, "o ecrã continua a mostrar TODOS os artigos");
    const totalSel = await page.locator('[data-testid="vendas-total-custo-selecionado"]').count();
    check(totalSel === 1, "ecrã: linha «TOTAL SELECIONADO» com a seleção parcial");
    const sSel = await pedirPdf(page, ctx, "vendas-13-meses-selecionados.pdf");
    const pS = palavrasPdf(sSel.ficheiro);
    const todoS = pS.paginas.flatMap(linhasPag).join("\n");
    check(cnpsDoRelatorio(sSel.relatorio).length === nArtigos - 2 && !todoS.includes(String(CNP.C1)) && !todoS.includes(String(CNP.C4)), "PDF: só os artigos selecionados");
    check(!todoS.includes(eur(999999.99)) && todoS.includes(eur(99999.99)), "PDF: totais recalculados para a seleção");
    check(/Artigos:\s*\d+ de \d+ selecionados/.test(todoS.replace(/\n/g, " ")), "PDF: «Artigos: N de M selecionados» indica a seleção parcial");
    await page.getByRole("button", { name: /^Excel$/ }).first().waitFor();
    const [dl2] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /^Excel$/ }).first().click()]);
    await dl2.saveAs(path.join(EVID, "vendas-13-meses-selecionados.xlsx"));
    const g2 = XLSX.utils.sheet_to_json<unknown[]>(XLSX.readFile(path.join(EVID, "vendas-13-meses-selecionados.xlsx")).Sheets["Relatório"], { header: 1, blankrows: false }) as unknown[][];
    check(g2.length - (g2.findIndex((r) => r[0] === "CNP") + 1) === sSel.relatorio.rows.length + 1, "Excel da seleção: mesmas linhas do PDF");
    await page.locator('[data-testid="vendas-sel-todos"]').click();
    check((await contagem()).startsWith(`${nArtigos} de ${nArtigos}`), "«selecionar todos» seleciona TODO o resultado");
    await page.locator('[data-testid="vendas-sel-todos"]').click();
    check((await contagem()).startsWith(`0 de ${nArtigos}`) && (await page.locator('[data-testid="vendas-sem-selecao"]').isVisible()), "zero selecionados: mensagem de bloqueio");
    check((await page.getByRole("button", { name: /^PDF$/ }).count()) === 0 && (await page.getByRole("button", { name: /^Imprimir$/ }).count()) === 0 && (await page.getByRole("button", { name: /^Excel$/ }).count()) === 0 && (await page.getByRole("button", { name: /^Email$/ }).count()) === 0, "…e PDF/Impressão/Excel/Email indisponíveis");
    await page.getByRole("button", { name: /^Atualizar$/ }).click();
    await page.waitForFunction((n) => document.querySelector('[data-testid="vendas-sel-contagem"]')?.textContent?.startsWith(`${n} de ${n}`), nArtigos, { timeout: 60000 });
    check(true, "novo resultado: seleção reposta a «todos»");

    // ═══ 6 · Texto do âmbito — só com vendas ═══════════════════════
    secao("6 · Texto do âmbito — desligar «Incluir stock sem vendas»");
    await page.getByRole("switch", { name: "Incluir stock sem vendas", exact: true }).click();
    await page.getByRole("button", { name: /^Atualizar$/ }).click();
    await page.getByRole("button", { name: /^Atualizar$/ }).waitFor({ timeout: 90000 });
    await page.waitForTimeout(800);
    check(!(await codigosEcra(page)).includes(String(CNP.SV)), "sem «Incluir stock sem vendas»: o artigo só com stock sai");
    const sVendas = await pedirPdf(page, ctx, "vendas-so-com-vendas.pdf");
    const tV = palavrasPdf(sVendas.ficheiro).paginas.flatMap(linhasPag).join(" ");
    check(/Artigos incluídos:\s*apenas com vendas no período/.test(tV), "PDF: «apenas com vendas no período»");
    await page.getByRole("switch", { name: "Incluir stock sem vendas", exact: true }).click();

    // ═══ 7 · 27 meses (3 partes) ═══════════════════════════════════
    secao("7 · Período acima do limite visual: 27 meses → 3 partes de 9");
    const p27 = periodo(27);
    await gerar(page, p27.from, p27.to);
    const cab27 = await page.locator('table[data-testid="vendas-tabela"] thead th').evaluateAll((ths) => ths.length);
    check(cab27 === 1 + 6 + 27 + 3, `ecrã: as 27 colunas de mês existem (acessíveis por scroll): ${cab27} colunas`);
    const s27 = await pedirPdf(page, ctx, "vendas-27-meses.pdf");
    const p27w = palavrasPdf(s27.ficheiro);
    renderizar(s27.ficheiro, "pdf-27-meses", 3);
    const t27 = p27w.paginas.map(textoPag).join("\n");
    check(["Parte 1 de 3", "Parte 2 de 3", "Parte 3 de 3"].every((t) => t27.includes(t)), "PDF: as 3 partes identificadas");
    check(p27w.paginas.flatMap(linhasPag).filter((l) => l.startsWith("TOTAL GERAL")).length === 1, "PDF: linha TOTAL GERAL uma única vez (fim do último bloco)");
    check(s27.relatorio.meta?.columnBlocks?.length === 3 && /repartido em 3 blocos/.test(t27), "PDF: nota explicativa da divisão em partes");
    check(p27w.paginas.every((pg) => textoPag(pg).includes("CNP")), "PDF: cabeçalho em todas as páginas de todas as partes");
    const n27 = nDetalhe(s27.relatorio);
    check(n27 > 0, `relatório de 27 meses com ${n27} linhas de detalhe`);
    const [dl3] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /^Excel$/ }).first().click()]);
    await dl3.saveAs(path.join(EVID, "vendas-27-meses.xlsx"));
    const g3 = XLSX.utils.sheet_to_json<unknown[]>(XLSX.readFile(path.join(EVID, "vendas-27-meses.xlsx")).Sheets["Relatório"], { header: 1, blankrows: false }) as unknown[][];
    const cab3 = g3.find((r) => r[0] === "CNP") as string[];
    check(cab3.length === 6 + 27 + 3 + 1, `Excel de 27 meses: todos os meses numa folha só (${cab3.length} colunas, incl. «Tipo de linha»)`);
    // cada bloco com várias páginas e totais inequívocos (27 meses)
    const txt27 = p27w.paginas.map(textoPag);
    const ini27 = [1, 2, 3].map((i) => txt27.findIndex((t) => t.includes(`Parte ${i} de 3`)));
    const fim27 = [ini27[1], ini27[2], p27w.paginas.length];
    check(ini27.every((v, i) => v >= 0 && fim27[i] - v >= 2), `27 meses: cada bloco ocupa várias páginas (${ini27.map((v, i) => fim27[i] - v).join("+")})`);
    check(txt27.slice(ini27[0], fim27[0]).concat(txt27.slice(ini27[1], fim27[1])).every((t) => !/Período:\s*(Total|custo|valor)/.test(t.replace(/colunas «Período:»/g, ""))), "27 meses: colunas «Período:» só no último bloco");
    check(txt27.slice(ini27[2], fim27[2]).join(" ").includes("Período:") && txt27.every((t) => t.includes("do bloco")), "27 meses: «Total unid. do bloco» em todos os blocos; «Período:» no último");
    const dets = s27.relatorio.rows.filter((r) => r.__rowKind !== "subtotal");
    const somaB = [0, 1, 2].reduce((a, i) => a + dets.reduce((b, r) => b + Number(r[`tb_${i}`]), 0), 0);
    check(somaB === dets.reduce((a, r) => a + Number(r.totalVendas), 0), `27 meses: Σ «Total unid. do bloco» (${somaB}) = total do período`);
    renderizar(s27.ficheiro, "pdf-27-meses-blocos", 8);

    // 14 meses: 2 blocos, cada um com várias páginas
    secao("7b · 14 meses → 2 blocos de 7");
    const p14 = periodo(14);
    await gerar(page, p14.from, p14.to);
    const s14 = await pedirPdf(page, ctx, "vendas-14-meses.pdf");
    const w14 = palavrasPdf(s14.ficheiro);
    const t14 = w14.paginas.map(textoPag);
    const i14 = [1, 2].map((i) => t14.findIndex((t) => t.includes(`Parte ${i} de 2`)));
    check(i14.every((v) => v >= 0) && i14[1] - i14[0] >= 2 && w14.paginas.length - i14[1] >= 2, `14 meses: 2 blocos, cada um com várias páginas (${i14[1] - i14[0]}+${w14.paginas.length - i14[1]})`);
    check(w14.paginas.flatMap(linhasPag).filter((l) => l.startsWith("TOTAL GERAL")).length === 1 && t14.every((t) => t.includes("CNP")), "14 meses: TOTAL GERAL uma vez; cabeçalho em todas as páginas");
    renderizar(s14.ficheiro, "pdf-14-meses", 4);
    await page.screenshot({ path: path.join(EVID, "ecra-27-meses.png") });
  } finally {
    await browser.close();
    await amb.parar();
  }
  console.log(`\n${falhas === 0 ? "PASSOU" : "FALHOU"} — ${ok} OK, ${falhas} falhas\n`);
  process.exit(falhas === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
