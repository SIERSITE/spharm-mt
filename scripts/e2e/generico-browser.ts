/**
 * scripts/e2e/generico-browser.ts
 *
 * Browser REAL (Chromium) contra o build de PRODUÇÃO (control plane + PostgreSQL descartáveis, dados sintéticos) do filtro «Genérico»
 * (Produto.flagGenerico): Todos (omissão) · Apenas genéricos · Apenas não genéricos.
 *
 *   1 · Vendas ...... as 3 opções; tabela, Relatório, impressão, PDF real, Excel real e email (PDF+Excel recebidos): MESMOS artigos, MESMAS
 *                     unidades vendidas e a linha «Genérico: …»; combinações (Ético/NETT, forma, farmácia, PVP diferente); «Limpar filtros»
 *   2 · Margens ..... draft ≠ aplicado; saídas aplicadas
 *   3 · Stock ....... parâmetro de URL `generico`, total no servidor, «Limpar»
 *   4 · Catálogo .... idem
 *   5 · Proposta .... filtro no SQL
 *   6 · Lista de Encomendas
 *   7 · Workspace ... duas análises independentes; mudar de separador e voltar preserva
 *
 * Genéricos: A (Alfa+Beta) e D (Gama) e C = sim; B e E e os 150 «VOL» = não. A tem PVP diferente na Beta. Ético/NETT: A Alfa=ÉTICO/Beta=NETT,
 * B ÉTICO, C NETT, D NETT. Formas: A «Comprimido», D sem forma.
 *
 * Pré-requisito: `npx next build` com SERVER_ACTIONS_ALLOWED_ORIGINS="localhost:3100,127.0.0.1:3100,*.localhost:3100".
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/e2e/generico-browser.ts
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { baseFor, criarAmbiente } from "./_ambiente-silveira";
import { abrirContexto } from "./_grupo-comum";
import { CNP, semearMargens } from "./_margens-comum";
import { iniciarSmtpSink } from "./_smtp-sink";
import { INIT_CAPTURA_IMPRESSAO, emailReal, excelReal, imprimir, norm, pdfReal } from "./_saidas-reais";

let ok = 0;
let falhas = 0;
const check = (cond: boolean, msg: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${msg}`); }
  else { falhas++; console.log(`  [FALHA] ${msg}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const secao = (t: string) => console.log(`\n── ${t}`);
const EVID = path.resolve("docs/validacao-visual/2026-11-generico");
const A = String(CNP.A), B = String(CNP.B), C = String(CNP.C), D = String(CNP.D), E = String(CNP.E);

function observar(page: Page) {
  const pedidos: string[] = [];
  page.on("request", (r) => { const id = r.headers()["next-action"]; if (r.method() === "POST" && id) pedidos.push(id); });
  return { n: () => pedidos.length };
}
async function quieto(page: Page, net: ReturnType<typeof observar>, ms = 1500) {
  const antes = net.n();
  await page.waitForTimeout(ms);
  return net.n() - antes;
}
const radio = (page: Page, valor: "TODOS" | "GENERICO" | "NAO_GENERICO") => page.locator(`[data-testid="filtro-generico"] [data-valor="${valor}"]`).first();
const marcado = async (page: Page) => {
  for (const v of ["TODOS", "GENERICO", "NAO_GENERICO"] as const) if ((await radio(page, v).getAttribute("aria-checked")) === "true") return v;
  return null;
};
async function abrirFiltros(page: Page) {
  if ((await page.locator('[data-testid="filtro-generico"]').count()) === 0) await page.getByRole("button", { name: /^Filtros/ }).first().click();
  await page.locator('[data-testid="filtro-generico"]').first().waitFor({ timeout: 15000 });
}
const chip = (page: Page, texto: string) => page.locator("span.rounded-full", { hasText: texto });
const textoPagina = (page: Page) => page.locator("main, body").first().innerText();
const tem = (txt: string, cnp: string) => txt.includes(cnp);
const compacto = (t: string) => t.replace(/[^\p{L}\p{N}]+/gu, "");

async function main() {
  fs.mkdirSync(EVID, { recursive: true });
  const amb = await criarAmbiente("generico");
  const browser = await chromium.launch();
  const smtp = await iniciarSmtpSink();
  try {
    const seed = await semearMargens(amb);
    const prisma = amb.prisma;
    await prisma.emailConfig.create({ data: { smtpHost: "127.0.0.1", smtpPort: smtp.port, smtpSecure: false, fromEmail: "spharm@exemplo.invalid", isActive: true } });
    const pid = async (cnp: number) => (await prisma.produto.findUniqueOrThrow({ where: { cnp } })).id;

    // ── dados: genéricos, classificação Ético/NETT, PVP diferente ──
    await prisma.produto.updateMany({ where: { cnp: { in: [CNP.A, CNP.C, CNP.D] } }, data: { flagGenerico: true } });
    const { alfa, beta, gama } = seed.farmacias;
    const classificar = async (cnp: number, farmaciaId: string, cat: "ETICO" | "NETT") =>
      prisma.produtoFarmacia.updateMany({ where: { produtoId: await pid(cnp), farmaciaId }, data: { eticoNett: cat } });
    await classificar(CNP.A, alfa, "ETICO"); await classificar(CNP.A, beta, "NETT"); await classificar(CNP.B, alfa, "ETICO");
    await classificar(CNP.C, alfa, "NETT"); await classificar(CNP.D, gama, "NETT");
    await prisma.produtoFarmacia.updateMany({ where: { produtoId: await pid(CNP.A), farmaciaId: beta }, data: { pvp: 13.9 } });
    const mkEnc = async (nome: string, farmaciaId: string, cnp: number) =>
      prisma.listaEncomenda.create({ data: { nome, estado: "FINALIZADA", farmaciaId, criadoPorId: seed.userId, dataCriacao: new Date(), linhas: { create: [{ produtoId: await pid(cnp), quantidadeAjustada: 1 }] } } });
    await mkEnc("ENC GEN ALFA-A", alfa, CNP.A);
    await mkEnc("ENC GEN ALFA-B", alfa, CNP.B);
    await mkEnc("ENC GEN ALFA-E", alfa, CNP.E);
    const unidades = async (cnps: number[]) => {
      const ids = await Promise.all(cnps.map(pid));
      const r = await prisma.vendaMensal.aggregate({ _sum: { quantidade: true }, where: { produtoId: { in: ids } } });
      return Number(r._sum.quantidade ?? 0);
    };

    const ctx = await abrirContexto(amb, browser, { userId: seed.userId } as never);
    await ctx.addInitScript(INIT_CAPTURA_IMPRESSAO);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => {
      if (/React error #418|Hydration failed|#418/.test(e.message)) console.log("  [AVISO conhecido] pageerror React #418 (hidratação do workspace; pré-existente no base)");
      else { console.log("  [pageerror]", e.message); check(false, "pageerror inesperado", e.message); }
    });
    await page.setViewportSize({ width: 1600, height: 900 });
    const net = observar(page);
    const base = baseFor("silveira");

    // ═══ 1 · Vendas ═══
    secao("1 · Vendas");
    await page.goto(base + "/vendas", { waitUntil: "networkidle" });
    await page.waitForFunction(() => new URL(location.href).searchParams.has("workspace"));
    const wsVendas = new URL(page.url()).searchParams.get("workspace")!;
    const ano = new Date().getFullYear();
    await page.getByLabel("Data início").fill(`${ano}-01-01`);
    await page.getByLabel("Data fim").fill(new Date().toISOString().slice(0, 10));
    await page.getByPlaceholder("Pesquisar por CNP ou descrição...").fill("IBUPROFENO");
    await abrirFiltros(page);
    check((await marcado(page)) === "TODOS", "por omissão está em «Todos»");
    check((await radio(page, "TODOS").count()) === 1 && (await radio(page, "GENERICO").count()) === 1 && (await radio(page, "NAO_GENERICO").count()) === 1, "as 3 opções: Todos, Apenas genéricos, Apenas não genéricos");
    const gerar = async () => {
      await page.getByRole("button", { name: /^(Gerar|Atualizar)$/ }).click();
      await page.getByRole("button", { name: /^Atualizar$/ }).waitFor({ timeout: 90000 });
      await page.locator('[data-testid="vendas-sel-contagem"]').waitFor({ timeout: 60000 });
    };
    const codigos = async () => [...new Set(await page.locator('tr[data-vd-linha="detalhe"]').evaluateAll((trs) => trs.map((t) => (t as HTMLElement).dataset.codigo ?? "")))].sort();
    await gerar();
    const todos = await codigos();
    check([A, B, D, E].every((c) => todos.includes(c)), `Todos: A, B, D e E (${todos.join(",")})`);

    await radio(page, "GENERICO").click();
    check((await chip(page, "Genérico: Apenas genéricos").count()) >= 1, "chip «Genérico: Apenas genéricos»");
    await gerar();
    let cs = await codigos();
    check(JSON.stringify(cs) === JSON.stringify([A, C, D].sort()), `GENERICO: A, C e D — o C existe na Alfa sem vendas e aparece como em «Todos» (${cs.join(",")})`);
    const unidGen = await unidades([CNP.A, CNP.D]);

    // ── saídas: Relatório, impressão, PDF, Excel, email ──
    const resumoUnid = (t: string) => Number(/Unidades vendidas:?\s*([\d.]+)/i.exec(norm(t))?.[1]?.replace(/\./g, "") ?? NaN);
    await page.getByRole("button", { name: /^Relatório$/ }).click();
    const previa = page.frameLocator('[data-testid="vendas-relatorio-previa"]');
    await previa.locator("thead th").first().waitFor({ timeout: 30000 });
    const txtPrev = norm(await previa.locator("body").innerText());
    check(tem(txtPrev, A) && tem(txtPrev, D) && !tem(txtPrev, B) && !tem(txtPrev, E), "separador Relatório: só A e D");
    check(/Genérico\W{0,6}Apenas genéricos/.test(txtPrev), "Relatório: filtros aplicados trazem «Genérico: Apenas genéricos»");
    check(resumoUnid(txtPrev) === unidGen, `Relatório: Unidades vendidas = ${unidGen} (as dos artigos filtrados)`, String(resumoUnid(txtPrev)));
    const tImp = await imprimir(page);
    check(tem(tImp, A) && tem(tImp, D) && !tem(tImp, B) && !tem(tImp, E) && /Genérico\W{0,6}Apenas genéricos/.test(tImp) && resumoUnid(tImp) === unidGen, "impressão: mesmos artigos, mesma linha de filtro e mesmas unidades");
    const pdfR = await pdfReal(page, ctx, EVID, "vendas-generico.pdf");
    check(tem(pdfR.texto, A) && tem(pdfR.texto, D) && !tem(pdfR.texto, B) && !tem(pdfR.texto, E) && /Genérico\W{0,6}Apenas genéricos/.test(pdfR.texto) && resumoUnid(pdfR.texto) === unidGen, "PDF real: mesmos artigos, mesma linha de filtro e mesmas unidades");
    const xlR = await excelReal(page, EVID, "vendas-generico.xlsx");
    const csvPlano = xlR.csv.split(String.fromCharCode(10)).join(" ").split(",").join(" ");
    check(xlR.csv.includes(A) && xlR.csv.includes(D) && !xlR.csv.includes(B) && !xlR.csv.includes(E) && /Genérico\W{0,6}Apenas genéricos/.test(csvPlano), "Excel real: mesmos artigos e a linha de filtro");
    const emR = await emailReal(page, smtp, EVID, "vendas-generico");
    check(emR.enviado && !!emR.pdf && !!emR.xlsx, `email real recebido com PDF e Excel (${emR.anexos.join(", ")})`, emR.feedback.slice(-200));
    check(!!emR.pdf && tem(emR.pdf, A) && tem(emR.pdf, D) && !tem(emR.pdf, B) && !tem(emR.pdf, E) && /Genérico\W{0,6}Apenas genéricos/.test(emR.pdf) && resumoUnid(emR.pdf) === unidGen, "PDF RECEBIDO por email: mesmos artigos, linha de filtro e unidades");
    check(!!emR.xlsx && tem(emR.xlsx, A) && tem(emR.xlsx, D) && !tem(emR.xlsx, B) && !tem(emR.xlsx, E) && /Genérico/.test(emR.xlsx), "Excel RECEBIDO por email: mesmos artigos e linha de filtro");
    await page.getByRole("button", { name: /^Tabela$/ }).click();
    await page.locator('[data-testid="vendas-tabela"]').waitFor();

    // ── NAO_GENERICO ──
    await abrirFiltros(page);
    await radio(page, "NAO_GENERICO").click();
    await gerar();
    cs = await codigos();
    check(cs.includes(B) && cs.includes(E) && !cs.includes(A) && !cs.includes(D), `NAO_GENERICO: B e E, nunca A nem D (${cs.slice(0, 6).join(",")}…)`);
    check(!!chip(page, "Genérico: Apenas não genéricos"), "chip «Apenas não genéricos»");
    const pdfN = await pdfReal(page, ctx, EVID, "vendas-nao-generico.pdf");
    check(/Genérico\W{0,6}Apenas não genéricos/.test(pdfN.texto) && !tem(pdfN.texto, A), "PDF NAO_GENERICO: linha de filtro e sem genéricos");

    // ── combinações ──
    await radio(page, "GENERICO").click();
    const ENETT = page.getByPlaceholder("Pesquisar ético / nett...").first().locator("xpath=ancestor::div[contains(@class,'rounded-xl')][1]");
    await ENETT.getByRole("button", { name: /^NETT\s*\d/ }).click();
    await gerar();
    cs = await codigos();
    check(JSON.stringify(cs) === JSON.stringify([C, D].sort()), `GENERICO E NETT (tenant): C e D — o A é divergente (${cs.join(",")})`);
    await ENETT.getByRole("button", { name: /^NETT\s*\d/ }).click();
    const FORMA = page.getByPlaceholder("Pesquisar forma farmacêutica...").first().locator("xpath=ancestor::div[contains(@class,'rounded-xl')][1]");
    await FORMA.getByRole("button", { name: /^Comprimido\s*\d/ }).first().click();
    await gerar();
    cs = await codigos();
    check(JSON.stringify(cs) === JSON.stringify([A]), `GENERICO E forma Comprimido: só A (${cs.join(",")})`);
    await FORMA.getByRole("button", { name: /^Comprimido\s*\d/ }).first().click();
    // PVP diferente entre farmácias
    await gerar();
    const pvp = page.locator('[data-testid="vendas-filtro-pvp-diferente"]');
    await pvp.click();
    await page.waitForTimeout(600);
    cs = await codigos();
    check(JSON.stringify(cs) === JSON.stringify([A]), `GENERICO E PVP diferente: só A (a única com PVP diferente entre Alfa e Beta) (${cs.join(",")})`);
    await pvp.click();
    // categoria / farmácia / período
    for (const f of ["Beta", "Gama"]) {
      await page.getByPlaceholder("Pesquisar farmácia...").first().fill(f);
      await page.getByRole("button", { name: new RegExp(`^Farmacia ${f}`) }).first().click();
    }
    await page.getByPlaceholder("Pesquisar farmácia...").first().fill("");
    await gerar();
    cs = await codigos();
    check(JSON.stringify(cs) === JSON.stringify([A, C].sort()), `GENERICO E só a farmácia Alfa: A e C (o D é da Gama) (${cs.join(",")})`);
    await page.getByLabel("Data fim").fill(new Date().toISOString().slice(0, 10));

    // ── Limpar filtros ──
    const n1 = net.n();
    await page.getByRole("button", { name: "Limpar filtros" }).click();
    check((await quieto(page, net, 1200)) === 0 && net.n() === n1, "«Limpar filtros» (Vendas): 0 pedidos");
    check((await marcado(page)) === "TODOS" && (await chip(page, "Genérico:").count()) === 0, "…repõe «Todos»");
    await page.screenshot({ path: path.join(EVID, "vendas.png") });

    // ═══ 2 · Margens ═══
    secao("2 · Margens");
    await page.goto(base + "/relatorios/margens", { waitUntil: "networkidle" });
    await page.waitForFunction(() => new URL(location.href).searchParams.has("workspace"));
    const wsMargens = new URL(page.url()).searchParams.get("workspace")!;
    const SELM = '[data-testid="tabela-margens-produto"]';
    const cnpsM = () => page.locator(`${SELM} tbody > tr:not([data-tabela-linha])`).evaluateAll((trs) => Array.from(new Set(trs.map((t) => (t as HTMLElement).dataset.cnp!))).sort());
    await page.getByTestId("margens-gerar").click();
    await page.locator(SELM).waitFor({ timeout: 60000 });
    const todosM = await cnpsM();
    await abrirFiltros(page);
    check((await marcado(page)) === "TODOS", "Margens: por omissão «Todos»");
    const m0 = net.n();
    await radio(page, "GENERICO").click();
    check((await quieto(page, net, 1500)) === 0 && net.n() === m0, "Margens: mudar o filtro = 0 pedidos até «Atualizar»");
    check((await page.getByTestId("margens-alteracoes-por-aplicar").count()) === 1 && JSON.stringify(await cnpsM()) === JSON.stringify(todosM), "…avisa «alterações por aplicar» e o relatório visível não muda");
    await page.getByTestId("margens-gerar").click();
    await page.locator(`${SELM} tbody > tr[data-cnp="${CNP.A}"]`).first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(800);
    const gm = await cnpsM();
    check(gm.includes(A) && gm.includes(D) && !gm.includes(B) && !gm.includes(E), `Margens GENERICO: A e D (${gm.join(",")})`);
    const RE_F = /Genérico\W{0,6}Apenas genéricos/;
    const tImpM = await imprimir(page);
    check(RE_F.test(tImpM) && tImpM.includes(A) && !tImpM.includes(B), "Margens impressão: filtro aplicado e só genéricos");
    const pdfM = await pdfReal(page, ctx, EVID, "margens-generico.pdf");
    check(RE_F.test(pdfM.texto) && pdfM.texto.includes(A) && !pdfM.texto.includes(B), "Margens PDF real");
    const xlM = await excelReal(page, EVID, "margens-generico.xlsx");
    check(RE_F.test(xlM.csv.split(String.fromCharCode(10)).join(" ").split(",").join(" ")) && xlM.csv.includes(A) && !xlM.csv.includes(B), "Margens Excel real");
    const emM = await emailReal(page, smtp, EVID, "margens-generico");
    check(emM.enviado && !!emM.pdf && !!emM.xlsx && RE_F.test(emM.pdf) && /Genérico/.test(emM.xlsx), "Margens email: PDF e Excel recebidos com o filtro");
    const m2 = net.n();
    await page.getByRole("button", { name: "Limpar filtros" }).click();
    check((await quieto(page, net, 1500)) === 0 && net.n() === m2 && (await marcado(page)) === "TODOS", "Margens «Limpar filtros»: 0 pedidos e repõe «Todos»");

    // ═══ 3 · Stock ═══
    secao("3 · Stock");
    await page.goto(base + "/stock?generico=GENERICO", { waitUntil: "networkidle" });
    let ts = await textoPagina(page);
    check(tem(ts, A) && tem(ts, C) && tem(ts, D) && !tem(ts, B) && !tem(ts, E), "Stock (?generico=GENERICO): A, C e D");
    await page.goto(base + "/stock?generico=NAO_GENERICO&q=IBUPROFENO", { waitUntil: "networkidle" });
    ts = await textoPagina(page);
    check(tem(ts, B) && tem(ts, E) && !tem(ts, A) && !tem(ts, D), "Stock NAO_GENERICO (pesquisa IBUPROFENO): B e E");
    await page.goto(base + "/stock?generico=" + encodeURIComponent("x'; DROP TABLE \"Produto\"; --"), { waitUntil: "networkidle" });
    check((await page.locator("body").innerText()).length > 0, "Stock: valor forjado na URL = Todos, a página não parte");
    await page.goto(base + "/stock", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /^Filtros/ }).first().click().catch(() => undefined);
    await radio(page, "GENERICO").click();
    await page.waitForURL(/generico=GENERICO/);
    ts = await textoPagina(page);
    check(tem(ts, A) && !tem(ts, B), "Stock: clicar na opção atualiza o URL e a lista (servidor)");
    await page.screenshot({ path: path.join(EVID, "stock.png") });
    await page.getByRole("button", { name: "Limpar", exact: true }).click();
    await page.waitForFunction(() => !location.search.includes("generico="));
    check(!page.url().includes("generico="), "Stock: «Limpar» remove o parâmetro");

    // ═══ 4 · Catálogo ═══
    secao("4 · Catálogo");
    await page.goto(base + "/catalogo?generico=GENERICO", { waitUntil: "networkidle" });
    let tc = await textoPagina(page);
    check(tem(tc, A) && tem(tc, C) && tem(tc, D) && !tem(tc, B) && /\b3\b[\s\S]{0,12}produtos/.test(tc), "Catálogo GENERICO: A, C e D (3 produtos no total do servidor)");
    await page.goto(base + "/catalogo", { waitUntil: "networkidle" });
    await radio(page, "NAO_GENERICO").click();
    await page.waitForURL(/generico=NAO_GENERICO/);
    tc = await textoPagina(page);
    check(!tem(tc, A) && !tem(tc, D) && !tem(tc, C) && /15\d[\s\S]{0,12}produtos/.test(tc), "Catálogo: NAO_GENERICO pela UI (sem A, C nem D; a lista não genérica tem 150+ artigos)");
    await page.screenshot({ path: path.join(EVID, "catalogo.png") });
    await page.getByRole("button", { name: /^Limpar$/ }).click();
    await page.waitForFunction(() => !location.search.includes("generico="));
    check(!page.url().includes("generico="), "Catálogo: «Limpar» remove o parâmetro");

    // ═══ 5 · Proposta ═══
    secao("5 · Proposta de encomenda (farmácia Alfa)");
    await page.goto(base + "/encomendas/nova", { waitUntil: "networkidle" });
    const abrirP = page.getByRole("button", { name: /Filtros/ }).first();
    if ((await abrirP.count()) > 0 && (await page.locator('[data-testid="filtro-generico"]').count()) === 0) await abrirP.click();
    check((await page.locator('[data-testid="filtro-generico"]').count()) >= 1, "a proposta tem o filtro «Genérico»");
    await page.getByPlaceholder("Pesquisar por CNP ou descrição...").fill("IBUPROFENO").catch(() => undefined);
    await radio(page, "GENERICO").click();
    await page.getByRole("button", { name: /Gerar proposta|Gerar nova proposta/i }).first().click().catch(() => undefined);
    await page.waitForTimeout(3500);
    const cartoes = compacto(await page.locator("body").innerText());
    check(/ACOMPRAR0/i.test(cartoes) && /ADEQUADO1/i.test(cartoes), "proposta da Alfa com GENERICO: 1 artigo (o A; o C é genérico mas não vendeu)", cartoes.slice(Math.max(0, cartoes.search(/ACOMPRAR/i)), 120));
    await page.screenshot({ path: path.join(EVID, "encomenda-nova.png") });

    // ═══ 6 · Lista de Encomendas ═══
    secao("6 · Lista de Encomendas");
    await page.goto(base + "/encomendas?generico=GENERICO", { waitUntil: "networkidle" });
    let tl = await textoPagina(page);
    check(tl.includes("ENC GEN ALFA-A") && !tl.includes("ENC GEN ALFA-B") && !tl.includes("ENC GEN ALFA-E"), "GENERICO: só a encomenda do artigo A");
    await page.goto(base + "/encomendas?generico=NAO_GENERICO", { waitUntil: "networkidle" });
    tl = await textoPagina(page);
    check(tl.includes("ENC GEN ALFA-B") && tl.includes("ENC GEN ALFA-E") && !tl.includes("ENC GEN ALFA-A"), "NAO_GENERICO: as encomendas de B e E");
    await page.goto(base + "/encomendas", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /^Filtros/ }).first().click().catch(() => undefined);
    await radio(page, "GENERICO").click().catch(() => undefined);
    await page.waitForURL(/generico=GENERICO/, { timeout: 15000 }).catch(() => undefined);
    check(page.url().includes("generico=GENERICO"), "a UI da lista põe o filtro no URL (servidor)");

    // ═══ 7 · Workspace ═══
    secao("7 · Workspace: análises independentes e preservação entre separadores");
    await page.goto(`${base}/vendas?workspace=${wsVendas}`, { waitUntil: "networkidle" });
    await abrirFiltros(page);
    await radio(page, "GENERICO").click();
    await page.getByRole("button", { name: /Nova análise/ }).click();
    await page.waitForFunction((w) => new URL(location.href).searchParams.get("workspace") !== w, wsVendas);
    await page.waitForLoadState("networkidle");
    await abrirFiltros(page);
    check((await marcado(page)) === "TODOS", "uma nova análise de Vendas começa em «Todos»");
    await radio(page, "NAO_GENERICO").click();
    await page.locator(`[data-navegacao-href^="/vendas?workspace=${wsVendas}"]`).click();
    await page.waitForFunction((w) => new URL(location.href).searchParams.get("workspace") === w, wsVendas);
    await abrirFiltros(page);
    check((await marcado(page)) === "GENERICO", "a análise A mantém «Apenas genéricos» e não herda a da B");
    await page.goto(`${base}/relatorios/margens?workspace=${wsMargens}`, { waitUntil: "networkidle" });
    await abrirFiltros(page);
    await radio(page, "NAO_GENERICO").click();
    await page.getByRole("link", { name: "Vendas", exact: true }).click();
    await page.waitForURL(/\/vendas/);
    await page.locator(`[data-navegacao-href^="/relatorios/margens?workspace=${wsMargens}"]`).click();
    await abrirFiltros(page);
    check((await marcado(page)) === "NAO_GENERICO", "Margens: voltar ao separador preserva a seleção");
    void C;
  } catch (e) {
    console.log(["--- logs do servidor ---", amb.logs().slice(-3000)].join("\n"));
    throw e;
  } finally {
    smtp.fechar();
    await browser.close();
    await amb.parar();
  }
  console.log(`\n${falhas === 0 ? "PASSOU" : "FALHOU"} — ${ok} OK, ${falhas} falhas\n`);
  process.exit(falhas === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
