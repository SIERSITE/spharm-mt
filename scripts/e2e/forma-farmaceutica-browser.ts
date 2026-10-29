/**
 * scripts/e2e/forma-farmaceutica-browser.ts
 *
 * Browser REAL (Chromium) contra o build de PRODUÇÃO (control plane + PostgreSQL descartáveis, dados sintéticos) do filtro
 * «Forma farmacêutica» em todos os mapas/listagens de produtos:
 *
 *   1 · Vendas ......... selecionar (multi, com pesquisa, contagem e «Sem forma farmacêutica»), «Gerar» aplica no servidor,
 *                        combinação com pesquisa, «Limpar filtros» limpa SEM gerar, PDF/Excel com a linha «Forma farmacêutica»
 *   2 · Margens ........ selecionar = 0 pedidos até «Atualizar» (1 pedido); draft ≠ aplicado; Limpar sem gerar; PDF/Excel APLICADOS
 *   3 · Inventário ..... mudar a forma = 0 pedidos; só «Gerar» aplica (comportamento do base, sem «Atualizar»)
 *   4 · Excessos ....... filtro no cliente sobre a coluna `formaChave` do servidor; chip; combinação
 *   5 · Transferências . idem
 *   6 · Stock .......... parâmetro de URL `forma` (multi, repetido); chip; «Limpar» remove-o; deep link
 *   7 · Catálogo ....... idem + paginação/total no servidor
 *   8 · Proposta ....... «Gerar proposta» com a forma (filtro no SQL)
 *  8b · Devoluções ..... filtro no cliente sobre `formaChave` (0 pedidos ao mudar), totais, Excel real, «Limpar filtros»
 *  8c · Manutenção ..... /catalogo/manutencao (silveira): filtro aditivo no servidor, «Limpar filtros»
 *   9 · Workspace ...... duas análises independentes (Vendas e Margens); mudar de separador e voltar preserva a seleção
 *  10 · Resoluções ..... 1920×1080, 1536×864 e 1366×768: o painel de filtros não gera scroll horizontal e o filtro é utilizável
 *
 * Dados (scripts/e2e/_margens-comum.ts): A=«Comprimido», B=« comprimido » (MESMA forma escrita de outra maneira), C e E =
 * «Comprimido revestido» (forma DIFERENTE), D = sem forma, 150 artigos «VOL» = «Cápsula».
 *
 * NÃO foi executado pelo autor (corre o coordenador no fim). Pré-requisito: `npx next build` com
 * SERVER_ACTIONS_ALLOWED_ORIGINS="localhost:3100,127.0.0.1:3100,*.localhost:3100".
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/e2e/forma-farmaceutica-browser.ts
 *
 * Os seletores das listagens que ainda não tinham `data-testid` (Excessos, Transferências, proposta) usam texto/placeholder;
 * se uma falhar por seletor (e não por comportamento), ajustar aqui — a lógica de negócio está provada em
 * scripts/tests/test-forma-farmaceutica-db.ts.
 */
import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { chromium, type Page } from "playwright";
import { baseFor, criarAmbiente } from "./_ambiente-silveira";
import { abrirContexto } from "./_grupo-comum";
import { CNP, semearMargens } from "./_margens-comum";
import { iniciarSmtpSink } from "./_smtp-sink";
import { INIT_CAPTURA_IMPRESSAO, emailReal, excelReal, imprimir, pdfReal, renderizarPdf } from "./_saidas-reais";

let ok = 0;
let falhas = 0;
const check = (cond: boolean, msg: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${msg}`); }
  else { falhas++; console.log(`  [FALHA] ${msg}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const secao = (t: string) => console.log(`\n── ${t}`);
const EVID = path.resolve("docs/validacao-visual/2026-10-forma-farmaceutica");
const PLACEHOLDER_FORMA = "Pesquisar forma farmacêutica...";
const A = String(CNP.A), B = String(CNP.B), C = String(CNP.C), D = String(CNP.D), E = String(CNP.E);

/** Regista as Server Actions (POST com `next-action`) — a geração de um mapa é uma delas. */
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
/** O cartão (SearchableMultiSelect) do filtro de forma. */
const cartaoForma = (page: Page) => page.getByPlaceholder(PLACEHOLDER_FORMA).first().locator("xpath=ancestor::div[contains(@class,'rounded-xl')][1]");
const opcao = (page: Page, rotulo: RegExp) => cartaoForma(page).getByRole("button", { name: rotulo });
const RE_COMP = /^Comprimido\s*\d/;
const RE_REVEST = /^Comprimido revestido\s*\d/;
const RE_SEM = /^Sem forma farmacêutica/;
const chip = (page: Page, texto: string) => page.locator("span.rounded-full", { hasText: texto });
const semScrollHorizontal = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
async function abrirFiltros(page: Page) {
  if ((await page.getByPlaceholder(PLACEHOLDER_FORMA).count()) === 0) await page.getByRole("button", { name: /^Filtros/ }).first().click();
  await page.getByPlaceholder(PLACEHOLDER_FORMA).first().waitFor({ timeout: 15000 });
}
const textoPagina = (page: Page) => page.locator("main, body").first().innerText();
const temCnp = (txt: string, cnp: string) => txt.includes(cnp);

async function main() {
  fs.mkdirSync(EVID, { recursive: true });
  const amb = await criarAmbiente("forma");
  const browser = await chromium.launch();
  const smtp = await iniciarSmtpSink();
  try {
    const seed = await semearMargens(amb);
    await amb.prisma.emailConfig.create({ data: { smtpHost: "127.0.0.1", smtpPort: smtp.port, smtpSecure: false, fromEmail: "spharm@exemplo.invalid", isActive: true } });
    const ctx = await abrirContexto(amb, browser, { userId: seed.userId } as never);
    await ctx.addInitScript(INIT_CAPTURA_IMPRESSAO); // captura da impressão (iframe) e window.__name
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
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
    check((await opcao(page, RE_COMP).count()) === 1, "«Comprimido» e « comprimido » numa só opção (com contagem)");
    check((await opcao(page, RE_REVEST).count()) === 1, "«Comprimido revestido» é outra opção");
    check((await opcao(page, RE_SEM).count()) === 1, "existe «Sem forma farmacêutica»");
    // pesquisa dentro do filtro
    await page.getByPlaceholder(PLACEHOLDER_FORMA).fill("revest");
    check((await cartaoForma(page).getByRole("button").count()) === 1, "a pesquisa dentro do filtro reduz as opções");
    await page.getByPlaceholder(PLACEHOLDER_FORMA).fill("");
    await opcao(page, RE_COMP).click();
    check((await chip(page, "Forma: Comprimido").count()) >= 1, "aparece o chip «Forma: Comprimido»");
    await page.getByRole("button", { name: /^(Gerar|Atualizar)$/ }).click();
    await page.getByRole("button", { name: /^Atualizar$/ }).waitFor({ timeout: 90000 });
    let tx = await page.locator('[data-testid="vendas-tabela"]').innerText();
    check(temCnp(tx, A) && temCnp(tx, B) && !temCnp(tx, C) && !temCnp(tx, E) && !temCnp(tx, D), "Vendas só mostra A e B (Comprimido) — não os revestidos nem o sem forma");
    // combinar com pesquisa
    await page.getByPlaceholder("Pesquisar por CNP ou descrição...").fill("A 400");
    await page.getByRole("button", { name: /^Atualizar$/ }).click();
    await page.getByRole("button", { name: /^Atualizar$/ }).waitFor({ timeout: 90000 });
    tx = await page.locator('[data-testid="vendas-tabela"]').innerText();
    check(temCnp(tx, A) && !temCnp(tx, B), "forma E pesquisa («A 400») → só A");
    await page.getByPlaceholder("Pesquisar por CNP ou descrição...").fill("IBUPROFENO");
    // Sem forma + revestido (multi)
    await opcao(page, RE_COMP).click(); // desliga
    await opcao(page, RE_SEM).click();
    await opcao(page, RE_REVEST).click();
    await page.getByRole("button", { name: /^Atualizar$/ }).click();
    await page.getByRole("button", { name: /^Atualizar$/ }).waitFor({ timeout: 90000 });
    tx = await page.locator('[data-testid="vendas-tabela"]').innerText();
    check(temCnp(tx, C) || temCnp(tx, E), "multi-seleção «Sem forma» + «revestido» devolve os revestidos");
    check(temCnp(tx, D) && !temCnp(tx, A) && !temCnp(tx, B), "…e o sem forma (D), sem A nem B");
    // PDF e Excel com a linha
    const [reqPdf] = await Promise.all([
      page.waitForRequest((r) => r.url().includes("/api/reports/pdf"), { timeout: 120000 }),
      page.getByRole("button", { name: /^PDF$/ }).first().click(),
    ]);
    const corpoPdf = reqPdf.postDataBuffer()!.toString("utf8");
    check(/Forma farmacêutica/.test(corpoPdf) && /Comprimido revestido/.test(corpoPdf) && /Sem forma farmacêutica/.test(corpoPdf), "o corpo do PDF traz «Forma farmacêutica: …» com os RÓTULOS");
    check(!/__sem_forma__/.test(corpoPdf), "…e nunca a chave interna");
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.getByRole("button", { name: /^Excel$/ }).first().click()]);
    const xp = path.join(EVID, "vendas-forma.xlsx");
    await dl.saveAs(xp);
    const wb = XLSX.read(fs.readFileSync(xp));
    const csv = wb.SheetNames.map((n) => XLSX.utils.sheet_to_csv(wb.Sheets[n])).join("\n");
    check(/Forma farmacêutica/.test(csv) && /Sem forma farmacêutica/.test(csv), "o Excel mostra «Forma farmacêutica: …Sem forma farmacêutica»");
    fs.rmSync(xp);
    // Limpar filtros: limpa a seleção sem gerar
    const n1 = net.n();
    await page.getByRole("button", { name: "Limpar filtros" }).click();
    check((await quieto(page, net, 1200)) === 0 && net.n() === n1, "«Limpar filtros» (Vendas): 0 pedidos");
    check((await chip(page, "Forma:").count()) === 0, "…as formas foram limpas");
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
    const todos = await cnpsM();
    await abrirFiltros(page);
    const m0 = net.n();
    await opcao(page, RE_COMP).click();
    check((await quieto(page, net, 1500)) === 0 && net.n() === m0, "Margens: mudar a forma = 0 pedidos até «Atualizar»");
    check((await page.getByTestId("margens-alteracoes-por-aplicar").count()) === 1, "…e aparece «alterações por aplicar» (draft ≠ aplicado)");
    check(JSON.stringify(await cnpsM()) === JSON.stringify(todos), "…com o relatório visível inalterado");
    // PDF com o draft por aplicar NÃO traz a forma
    const [reqPdf0] = await Promise.all([
      page.waitForRequest((r) => r.url().includes("/api/reports/pdf"), { timeout: 120000 }),
      page.getByRole("button", { name: /^PDF$/ }).first().click(),
    ]);
    check(!/Forma farmacêutica/.test(reqPdf0.postDataBuffer()!.toString("utf8")), "o PDF usa os filtros APLICADOS: a forma ainda não aplicada NÃO aparece");
    await page.getByTestId("margens-gerar").waitFor();
    const m1 = net.n();
    await page.getByTestId("margens-gerar").click();
    await page.locator(`${SELM} tbody > tr[data-cnp="${CNP.A}"]`).first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(800);
    check(net.n() - m1 === 1, `«Atualizar» → exatamente 1 geração (${net.n() - m1})`);
    check(JSON.stringify(await cnpsM()) === JSON.stringify([A, B].sort()), "Margens só mostra A e B");
    const [reqPdf1] = await Promise.all([
      page.waitForRequest((r) => r.url().includes("/api/reports/pdf"), { timeout: 120000 }),
      page.getByRole("button", { name: /^PDF$/ }).first().click(),
    ]);
    check(/Forma farmacêutica/.test(reqPdf1.postDataBuffer()!.toString("utf8")), "depois de aplicada, o PDF traz «Forma farmacêutica: Comprimido»");
    // ── saídas REAIS com a forma nos filtros aplicados (impressão, PDF, Excel e email) ──
    secao("2b · Margens: impressão, PDF real, Excel real e email com «Forma farmacêutica: Comprimido» nos filtros aplicados");
    const RE_FILTRO_FORMA = /Forma farmacêutica\W{0,6}Comprimido/;
    const tImp = await imprimir(page);
    check(RE_FILTRO_FORMA.test(tImp), "impressão: os filtros aplicados trazem «Forma farmacêutica: Comprimido»");
    check(tImp.includes(String(CNP.A)) && !tImp.includes(String(CNP.C)), "impressão: só os artigos da forma (A), nunca os revestidos (C)");
    const pdfR = await pdfReal(page, ctx, EVID, "margens-forma.pdf");
    check(RE_FILTRO_FORMA.test(pdfR.texto), "PDF real: os filtros aplicados trazem «Forma farmacêutica: Comprimido»");
    check(pdfR.texto.includes(String(CNP.A)) && !pdfR.texto.includes(String(CNP.C)), "PDF real: só os artigos da forma");
    renderizarPdf(pdfR.ficheiro, EVID, "margens-forma-pdf", 1);
    const xlR = await excelReal(page, EVID, "margens-forma.xlsx");
    const csvPlano = xlR.csv.split(String.fromCharCode(10)).join(" ").split(",").join(" ");
    check(RE_FILTRO_FORMA.test(csvPlano) && xlR.csv.includes(String(CNP.A)) && !xlR.csv.includes(String(CNP.C)), "Excel real: filtros com a forma e só os artigos da forma");
    const emR = await emailReal(page, smtp, EVID, "margens-forma");
    check(emR.enviado && !!emR.pdf && !!emR.xlsx, `email real recebido com PDF e Excel (${emR.anexos.join(", ")})`, emR.feedback.slice(-200));
    check(!!emR.pdf && RE_FILTRO_FORMA.test(emR.pdf) && !!emR.xlsx && /Forma farmacêutica/.test(emR.xlsx), "email: PDF e Excel RECEBIDOS trazem a forma nos filtros aplicados");
    const m2 = net.n();
    await page.getByRole("button", { name: "Limpar filtros" }).click();
    check((await quieto(page, net, 1500)) === 0 && net.n() === m2, "Margens: «Limpar filtros» = 0 pedidos");
    check((await chip(page, "Forma:").count()) === 0 && JSON.stringify(await cnpsM()) === JSON.stringify([A, B].sort()), "…a seleção limpa-se, o resultado visível mantém-se");
    check((await page.getByTestId("margens-alteracoes-por-aplicar").count()) === 1, "…e avisa «alterações por aplicar»");
    await page.screenshot({ path: path.join(EVID, "margens.png") });

    // ═══ 3 · Inventário ═══
    secao("3 · Inventário");
    await page.goto(base + "/relatorios/inventario", { waitUntil: "networkidle" });
    // O Inventário mantém o comportamento do base: o botão chama-se sempre «Gerar», sem aviso de alterações por aplicar.
    const gerarInv = async () => {
      await page.getByRole("button", { name: /^Gerar$/ }).first().click();
      await page.getByRole("button", { name: /^A gerar/ }).waitFor({ timeout: 5000 }).catch(() => {});
      await page.getByRole("button", { name: /^Gerar$/ }).waitFor({ timeout: 90000 });
    };
    await gerarInv();
    await abrirFiltros(page);
    const i0 = net.n();
    await opcao(page, RE_COMP).click();
    check((await quieto(page, net, 1500)) === 0 && net.n() === i0, "Inventário: mudar a forma = 0 pedidos");
    await gerarInv();
    await page.waitForTimeout(800);
    let ti = await textoPagina(page);
    check(temCnp(ti, A) && temCnp(ti, B) && !temCnp(ti, C) && !temCnp(ti, D), "Inventário só mostra A e B depois de «Gerar»");
    await page.screenshot({ path: path.join(EVID, "inventario.png") });
    await page.getByRole("button", { name: "Limpar filtros" }).click();
    check((await quieto(page, net, 1200)) === 0, "Inventário: «Limpar filtros» = 0 pedidos");
    ti = await textoPagina(page);
    check(!temCnp(ti, D), "…o resultado visível continua o aplicado");

    // ═══ 4 / 5 · Excessos e Transferências ═══
    for (const [titulo, rota, gerar] of [["Excessos", "/excessos", /^(Gerar relatório|Atualizar)$/], ["Transferências", "/transferencias", /^(Gerar|Gerar relatório|Atualizar)$/]] as const) {
      secao(`${titulo[0] === "E" ? "4" : "5"} · ${titulo}`);
      await page.goto(base + rota, { waitUntil: "networkidle" });
      await abrirFiltros(page);
      check((await opcao(page, RE_COMP).count()) === 1 && (await opcao(page, RE_REVEST).count()) === 1, `${titulo}: opções agrupadas (Comprimido ≠ Comprimido revestido)`);
      await opcao(page, RE_COMP).click();
      check((await chip(page, "Forma: Comprimido").count()) >= 1, `${titulo}: chip da forma`);
      await page.getByRole("button", { name: gerar }).first().click();
      await page.waitForTimeout(2500);
      const t = await textoPagina(page);
      check(!temCnp(t, C) && !temCnp(t, E) && !temCnp(t, D), `${titulo}: com «Comprimido» não aparecem revestidos nem sem forma (filtro sobre a coluna formaChave)`);
      await page.screenshot({ path: path.join(EVID, `${titulo.toLowerCase()}.png`) });
    }

    // ═══ 6 · Stock ═══
    secao("6 · Stock");
    await page.goto(base + "/stock?forma=comprimido", { waitUntil: "networkidle" });
    let ts = await textoPagina(page);
    check(temCnp(ts, A) && temCnp(ts, B) && !temCnp(ts, C), "Stock (deep link ?forma=comprimido): só A e B, tabela carregada");
    await page.screenshot({ path: path.join(EVID, "stock.png") });
    check((await chip(page, "Forma: Comprimido").count()) >= 1 || (await page.getByRole("button", { name: /Forma: Comprimido/ }).count()) >= 1, "…com o chip da forma");
    await page.goto(base + "/stock?forma=comprimido&forma=comprimido%20revestido", { waitUntil: "networkidle" });
    ts = await textoPagina(page);
    check(temCnp(ts, A) && temCnp(ts, C), "Stock: duas formas (parâmetro repetido) = união");
    await page.goto(base + "/stock?forma=" + encodeURIComponent("__sem_forma__"), { waitUntil: "networkidle" });
    ts = await textoPagina(page);
    check(temCnp(ts, D) && !temCnp(ts, A), "Stock: «Sem forma farmacêutica» (sentinela na URL)");
    await page.goto(base + "/stock?forma=" + encodeURIComponent("forma-que-nao-existe'; DROP TABLE \"Produto\"; --"), { waitUntil: "networkidle" });
    check((await page.locator("body").innerText()).length > 0 && (await page.title()) !== "", "Stock: um valor forjado na URL não parte a página (apenas não devolve nada)");
    await page.goto(base + "/stock", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /^Filtros/ }).first().click();
    await opcao(page, RE_REVEST).click();
    await page.waitForURL(/forma=comprimido(%20|\+)revestido/);
    ts = await textoPagina(page);
    check(temCnp(ts, C) && !temCnp(ts, A), "Stock: clicar na opção atualiza o URL e a lista (servidor)");
    await page.getByRole("button", { name: "Limpar", exact: true }).click();
    await page.waitForFunction(() => !location.search.includes("forma="));
    check(!page.url().includes("forma="), "Stock: «Limpar» remove o parâmetro `forma`");

    // ═══ 7 · Catálogo ═══
    secao("7 · Catálogo");
    await page.goto(base + "/catalogo?forma=comprimido", { waitUntil: "networkidle" });
    let tc = await textoPagina(page);
    check(temCnp(tc, A) && temCnp(tc, B) && !temCnp(tc, C), "Catálogo (deep link): só A e B");
    check(/\b2\b[\s\S]{0,12}produtos/.test(tc), "…o total do servidor reflete o filtro (2 produtos)");
    await page.screenshot({ path: path.join(EVID, "catalogo.png") });
    await page.goto(base + "/catalogo", { waitUntil: "networkidle" });
    await opcao(page, RE_SEM).click();
    await page.waitForURL(/forma=__sem_forma__/);
    tc = await textoPagina(page);
    check(temCnp(tc, D) && !temCnp(tc, A), "Catálogo: «Sem forma farmacêutica» pela UI");
    await page.getByRole("button", { name: /^Limpar$/ }).click();
    await page.waitForFunction(() => !location.search.includes("forma="));
    check(!page.url().includes("forma="), "Catálogo: «Limpar» remove o parâmetro `forma`");

    // ═══ 8 · Proposta de encomenda ═══
    secao("8 · Proposta de encomenda");
    await page.goto(base + "/encomendas/nova", { waitUntil: "networkidle" });
    const abrirFiltrosProposta = page.getByRole("button", { name: /Filtros/ }).first();
    if ((await abrirFiltrosProposta.count()) > 0 && (await page.getByPlaceholder(PLACEHOLDER_FORMA).count()) === 0) await abrirFiltrosProposta.click();
    check((await page.getByPlaceholder(PLACEHOLDER_FORMA).count()) >= 1, "a proposta tem o filtro «Forma farmacêutica»");
    if ((await page.getByPlaceholder(PLACEHOLDER_FORMA).count()) >= 1) {
      await opcao(page, RE_COMP).click();
      await page.getByRole("button", { name: /Gerar proposta/i }).first().click().catch(() => undefined);
      await page.waitForTimeout(3500);
      const tp = await textoPagina(page);
      check(!temCnp(tp, C) && !temCnp(tp, E) && !temCnp(tp, D), "a proposta com «Comprimido» não traz revestidos nem sem forma (filtro no SQL)");
    await page.screenshot({ path: path.join(EVID, "encomenda-nova.png") });
    }

    // ═══ 8b · Devoluções (filtro no cliente sobre `formaChave`; sem workspace persistido) ═══
    secao("8b · Devoluções");
    {
      const hoje = new Date();
      const farm = await amb.prisma.farmacia.findFirstOrThrow({ where: { nome: seed.nomes.alfa } });
      const forn = await amb.prisma.fornecedor.create({ data: { nomeNormalizado: "FORN DEVOL E2E", estado: "ATIVO" } });
      for (const [cnp, qtd] of [[CNP.A, 1], [CNP.B, 2], [CNP.C, 4], [CNP.D, 8]] as const) {
        const p = await amb.prisma.produto.findUniqueOrThrow({ where: { cnp } });
        await amb.prisma.devolucao.create({
          data: { farmaciaId: farm.id, produtoId: p.id, data: hoje, quantidade: qtd, valor: qtd * 10, tipo: "FORNECEDOR", motivo: "E2E forma", fornecedorDestinoId: forn.id },
        });
      }
      await page.goto(base + "/devolucoes", { waitUntil: "networkidle" });
      check((await page.getByPlaceholder(PLACEHOLDER_FORMA).count()) === 1, "Devoluções tem o filtro «Forma farmacêutica» (mesmo componente)");
      await page.getByRole("button", { name: /^Gerar$/ }).click();
      await page.getByRole("button", { name: /^Atualizar$/ }).waitFor({ timeout: 60000 });
      let td = await textoPagina(page);
      check(temCnp(td, A) && temCnp(td, B) && temCnp(td, C) && temCnp(td, D), "sem filtro: as 4 devoluções");
      check((await opcao(page, RE_COMP).count()) === 1 && (await opcao(page, RE_REVEST).count()) === 1, "Devoluções: «Comprimido» e «Comprimido revestido» são opções distintas (agrupa só espaços/caixa)");
      const d0 = net.n();
      await opcao(page, RE_COMP).click();
      check((await quieto(page, net, 1200)) === 0 && net.n() === d0, "Devoluções: mudar a forma = 0 pedidos (filtro no cliente)");
      td = await textoPagina(page);
      check(temCnp(td, A) && temCnp(td, B) && !temCnp(td, C) && !temCnp(td, D), "Devoluções com «Comprimido»: só A e B");
      check(/Linhas\s*2\b/.test(td.replace(/\s+/g, " ")), "…as linhas/totais refletem o filtro (2 linhas)");
      await opcao(page, RE_COMP).click();
      await opcao(page, RE_SEM).click();
      td = await textoPagina(page);
      check(temCnp(td, D) && !temCnp(td, A) && !temCnp(td, C), "Devoluções: «Sem forma farmacêutica» devolve só D");
      const xlD = await excelReal(page, EVID, "devolucoes-forma.xlsx");
      const csvD = xlD.csv.split(String.fromCharCode(10)).join(" ").split(",").join(" ");
      check(/Forma farmacêutica\W{0,6}Sem forma farmacêutica/.test(csvD) && xlD.csv.includes(D) && !xlD.csv.includes(A), "Devoluções: Excel real traz o filtro aplicado e só as linhas filtradas");
      await page.getByTestId("devolucoes-limpar-filtros").click();
      check((await chip(page, "Forma:").count()) === 0, "Devoluções: «Limpar filtros» limpa a forma");
      td = await textoPagina(page);
      check(temCnp(td, A) && temCnp(td, C) && temCnp(td, D), "…e voltam todas as linhas");
      await page.screenshot({ path: path.join(EVID, "devolucoes.png") });
    }

    // ═══ 8c · Manutenção em massa do catálogo (só silveira/garantia; o e2e corre em silveira) ═══
    secao("8c · Manutenção em massa do catálogo");
    {
      await page.goto(base + "/catalogo/manutencao", { waitUntil: "networkidle" });
      await abrirFiltros(page);
      check((await page.getByPlaceholder(PLACEHOLDER_FORMA).count()) === 1, "Manutenção: o painel de filtros tem «Forma farmacêutica» (mesmo componente)");
      await page.getByPlaceholder("Pesquisar por CNP ou descrição...").fill("IBUPROFENO");
      await opcao(page, RE_COMP).click();
      await page.waitForTimeout(2500);
      let tm = await textoPagina(page);
      check(temCnp(tm, A) && temCnp(tm, B) && !temCnp(tm, C) && !temCnp(tm, D), "Manutenção com «Comprimido»: só A e B na grelha");
      check(/Forma farmacêutica: Comprimido/.test(tm) || (await chip(page, "Forma: Comprimido").count()) >= 1, "…e o filtro aparece no resumo/chip");
      await page.getByRole("button", { name: "Limpar filtros" }).first().click();
      await page.waitForTimeout(2500);
      tm = await textoPagina(page);
      check((await chip(page, "Forma:").count()) === 0 && temCnp(tm, C), "Manutenção: «Limpar filtros» limpa a forma e voltam os restantes produtos");
      await page.screenshot({ path: path.join(EVID, "manutencao.png") });
    }

    // ═══ 9 · Workspace: duas análises independentes ═══
    secao("9 · Workspace (Vendas e Margens)");
    await page.goto(`${base}/vendas?workspace=${wsVendas}`, { waitUntil: "networkidle" });
    await abrirFiltros(page);
    await opcao(page, RE_COMP).click();
    await page.getByRole("button", { name: /Nova análise/ }).click();
    await page.waitForFunction((w) => new URL(location.href).searchParams.get("workspace") !== w, wsVendas);
    await page.waitForLoadState("networkidle");
    await abrirFiltros(page);
    check((await chip(page, "Forma:").count()) === 0, "uma nova análise de Vendas começa SEM formas");
    await opcao(page, RE_REVEST).click();
    await page.locator(`[data-navegacao-href^="/vendas?workspace=${wsVendas}"]`).click();
    await page.waitForFunction((w) => new URL(location.href).searchParams.get("workspace") === w, wsVendas);
    await abrirFiltros(page);
    check((await chip(page, "Forma: Comprimido").count()) >= 1 && (await chip(page, "Forma: Comprimido revestido").count()) === 0, "a análise A mantém «Comprimido» e não herda a forma da B");
    // mudar de separador e voltar (Margens) preserva a seleção
    await page.goto(`${base}/relatorios/margens?workspace=${wsMargens}`, { waitUntil: "networkidle" });
    await abrirFiltros(page);
    await opcao(page, RE_REVEST).click();
    await page.getByRole("link", { name: "Vendas", exact: true }).click();
    await page.waitForURL(/\/vendas/);
    await page.locator(`[data-navegacao-href^="/relatorios/margens?workspace=${wsMargens}"]`).click();
    await abrirFiltros(page);
    check((await chip(page, "Forma: Comprimido revestido").count()) >= 1, "Margens: voltar ao separador preserva a seleção da forma");

    // ═══ 10 · Resoluções ═══
    secao("10 · 1920×1080, 1536×864, 1366×768");
    for (const [w, h] of [[1920, 1080], [1536, 864], [1366, 768]] as const) {
      await page.setViewportSize({ width: w, height: h });
      for (const rota of ["/vendas", "/relatorios/margens", "/relatorios/inventario", "/stock", "/catalogo"]) {
        await page.goto(base + rota, { waitUntil: "networkidle" });
        if (rota !== "/catalogo") await abrirFiltros(page).catch(() => undefined);
        check(await semScrollHorizontal(page), `${w}×${h} ${rota}: sem scroll horizontal da página com o filtro visível`);
        const vis = await page.getByPlaceholder(PLACEHOLDER_FORMA).first().isVisible().catch(() => false);
        check(vis, `${w}×${h} ${rota}: o filtro de forma está visível e utilizável`);
      }
      await page.screenshot({ path: path.join(EVID, `resolucao-${w}x${h}.png`) });
    }
    void E;
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
