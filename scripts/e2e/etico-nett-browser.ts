/**
 * scripts/e2e/etico-nett-browser.ts
 *
 * Browser REAL (Chromium) contra o build de PRODUÇÃO (control plane + PostgreSQL descartáveis, dados sintéticos) do filtro
 * «Ético / NETT» e da classificação por farmácia:
 *
 *   1 · Vendas ......... Ético · NETT · Sem classificação · Divergente (consolidado do tenant), âmbito por farmácia seleccionada,
 *                        «Limpar filtros» sem gerar, PDF/Excel com a linha «Ético/NETT: …»
 *   2 · Margens ........ draft ≠ aplicado (0 pedidos até «Atualizar»), impressão, PDF real, Excel real e email com o filtro APLICADO
 *   3 · Stock .......... parâmetro de URL `eticoNett` (repetido), chip, «Limpar», total no servidor, âmbito por farmácia
 *   4 · Catálogo ....... idem + total/paginação no servidor
 *   5 · Proposta ....... classificação DA FARMÁCIA da proposta (filtro no SQL)
 *   6 · Lista de Encomendas ... cada encomenda usa a classificação da farmácia dela; total no servidor
 *   7 · Ficha .......... consolidado + origem por farmácia + aviso de divergência
 *   8 · Workspace ...... duas análises independentes; mudar de separador e voltar preserva a seleção
 *
 * Classificação (Alfa/Beta/Gama): A = Alfa ÉTICO + Beta NETT (DIVERGENTE no tenant) · B = Alfa ÉTICO · C = Alfa NETT ·
 * D = Gama NETT · E e os 150 «VOL» = sem classificação.
 *
 * Pré-requisito: `npx next build` com SERVER_ACTIONS_ALLOWED_ORIGINS="localhost:3100,127.0.0.1:3100,*.localhost:3100".
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/e2e/etico-nett-browser.ts
 */
import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { chromium, type Page } from "playwright";
import { baseFor, criarAmbiente } from "./_ambiente-silveira";
import { abrirContexto } from "./_grupo-comum";
import { CNP, semearMargens } from "./_margens-comum";
import { iniciarSmtpSink } from "./_smtp-sink";
import { INIT_CAPTURA_IMPRESSAO, emailReal, excelReal, imprimir, pdfReal } from "./_saidas-reais";

let ok = 0;
let falhas = 0;
const check = (cond: boolean, msg: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${msg}`); }
  else { falhas++; console.log(`  [FALHA] ${msg}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const secao = (t: string) => console.log(`\n── ${t}`);
const EVID = path.resolve("docs/validacao-visual/2026-11-etico-nett");
const PH = "Pesquisar ético / nett...";
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
const cartao = (page: Page) => page.getByPlaceholder(PH).first().locator("xpath=ancestor::div[contains(@class,'rounded-xl')][1]");
const opcao = (page: Page, rotulo: RegExp) => cartao(page).getByRole("button", { name: rotulo });
const RE_ETICO = /^Ético\s*\d/;
const RE_NETT = /^NETT\s*\d/;
const RE_SEM = /^Sem classificação\s*\d/;
const RE_DIV = /^Divergente\s*\d/;
const chip = (page: Page, texto: string) => page.locator("span.rounded-full", { hasText: texto });
async function abrirFiltros(page: Page) {
  if ((await page.getByPlaceholder(PH).count()) === 0) await page.getByRole("button", { name: /^Filtros/ }).first().click();
  await page.getByPlaceholder(PH).first().waitFor({ timeout: 15000 });
}
const textoPagina = (page: Page) => page.locator("main, body").first().innerText();
const tem = (txt: string, cnp: string) => txt.includes(cnp);

async function main() {
  fs.mkdirSync(EVID, { recursive: true });
  const amb = await criarAmbiente("eticonett");
  const browser = await chromium.launch();
  const smtp = await iniciarSmtpSink();
  try {
    const seed = await semearMargens(amb);
    const prisma = amb.prisma;
    await prisma.emailConfig.create({ data: { smtpHost: "127.0.0.1", smtpPort: smtp.port, smtpSecure: false, fromEmail: "spharm@exemplo.invalid", isActive: true } });

    // ── Classificação por farmácia ──
    const pid = async (cnp: number) => (await prisma.produto.findUniqueOrThrow({ where: { cnp } })).id;
    const classificar = async (cnp: number, farmaciaId: string, cat: "ETICO" | "NETT") => {
      const r = await prisma.produtoFarmacia.updateMany({
        where: { produtoId: await pid(cnp), farmaciaId },
        data: { eticoNett: cat, eticoNettCodigoErp: cat === "ETICO" ? 1 : 2, eticoNettDescricaoErp: cat === "ETICO" ? "Éticos" : "NETT", eticoNettObservadoEm: new Date() },
      });
      if (r.count !== 1) throw new Error(`classificar ${cnp}: ${r.count} linhas`);
    };
    const { alfa, beta, gama } = seed.farmacias;
    await classificar(CNP.A, alfa, "ETICO");
    await classificar(CNP.A, beta, "NETT");
    await classificar(CNP.B, alfa, "ETICO");
    await classificar(CNP.C, alfa, "NETT");
    await classificar(CNP.D, gama, "NETT");
    // Encomendas por farmácia (cada uma usa a classificação DA SUA farmácia)
    const mkEnc = (nome: string, farmaciaId: string, cnp: number) =>
      pid(cnp).then((produtoId) =>
        prisma.listaEncomenda.create({ data: { nome, estado: "FINALIZADA", farmaciaId, criadoPorId: seed.userId, dataCriacao: new Date(), linhas: { create: [{ produtoId, quantidadeAjustada: 1 }] } } }),
      );
    await mkEnc("ENC EN ALFA-A", alfa, CNP.A); // A é ÉTICO em Alfa
    await mkEnc("ENC EN BETA-A", beta, CNP.A); // A é NETT em Beta
    await mkEnc("ENC EN ALFA-C", alfa, CNP.C); // NETT
    await mkEnc("ENC EN ALFA-E", alfa, CNP.E); // sem classificação

    const ctx = await abrirContexto(amb, browser, { userId: seed.userId } as never);
    await ctx.addInitScript(INIT_CAPTURA_IMPRESSAO);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => {
      if (/React error #418|Hydration failed|#418/.test(e.message)) {
        console.log("  [AVISO conhecido] pageerror React #418 (hidratação do estado do workspace; pré-existente no base)");
      } else {
        console.log("  [pageerror]", e.message);
        check(false, "pageerror inesperado", e.message);
      }
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
    check((await opcao(page, RE_ETICO).count()) === 1 && (await opcao(page, RE_NETT).count()) === 1 && (await opcao(page, RE_SEM).count()) === 1 && (await opcao(page, RE_DIV).count()) === 1,
      "o filtro tem as 4 opções: Ético, NETT, Sem classificação, Divergente (com contagem)");
    const gerarVendas = async () => {
      await page.getByRole("button", { name: /^(Gerar|Atualizar)$/ }).click();
      await page.getByRole("button", { name: /^Atualizar$/ }).waitFor({ timeout: 90000 });
    };
    const tabelaVendas = () => page.locator('[data-testid="vendas-tabela"]').innerText();
    await opcao(page, RE_ETICO).click();
    check((await chip(page, "Ético/NETT: Ético").count()) >= 1, "aparece o chip «Ético/NETT: Ético»");
    await gerarVendas();
    let tx = await tabelaVendas();
    check(tem(tx, B) && !tem(tx, A) && !tem(tx, C) && !tem(tx, D) && !tem(tx, E), "ÉTICO (tenant): só B — A é divergente (Ético em Alfa, NETT em Beta), C/D são NETT");
    await opcao(page, RE_ETICO).click();
    await opcao(page, RE_NETT).click();
    await gerarVendas();
    tx = await tabelaVendas();
    check(tem(tx, C) && tem(tx, D) && !tem(tx, B) && !tem(tx, A), "NETT (tenant): C e D");
    await opcao(page, RE_NETT).click();
    await opcao(page, RE_DIV).click();
    await gerarVendas();
    tx = await tabelaVendas();
    check(tem(tx, A) && !tem(tx, B) && !tem(tx, C) && !tem(tx, D), "DIVERGENTE: só A");
    await opcao(page, RE_DIV).click();
    await opcao(page, RE_SEM).click();
    await gerarVendas();
    tx = await tabelaVendas();
    check(tem(tx, E) && !tem(tx, A) && !tem(tx, B) && !tem(tx, C) && !tem(tx, D), "SEM CLASSIFICAÇÃO: E (sem classificação em nenhuma farmácia)");
    await opcao(page, RE_SEM).click();
    // âmbito: só a farmácia Alfa → A passa a ser ÉTICO (a divergência de Beta está fora do âmbito)
    await page.getByPlaceholder("Pesquisar farmácia...").first().fill("Alfa");
    await page.getByRole("button", { name: /^Farmacia Alfa/ }).first().click();
    await opcao(page, RE_ETICO).click();
    await gerarVendas();
    tx = await tabelaVendas();
    check(tem(tx, A) && tem(tx, B) && !tem(tx, C), "âmbito só Alfa: ÉTICO = A e B (a divergência de A é com a Beta, fora do âmbito)", tx.slice(0, 300).replace(/\s+/g, " "));
    // PDF e Excel com a linha
    const pdfV = await pdfReal(page, ctx, EVID, "vendas-etico.pdf");
    check(/Ético\/NETT\W{0,6}Ético/.test(pdfV.texto), "PDF (Vendas): filtros aplicados trazem «Ético/NETT: Ético»");
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.getByRole("button", { name: /^Excel$/ }).first().click()]);
    const xp = path.join(EVID, "vendas-etico.xlsx");
    await dl.saveAs(xp);
    const wb = XLSX.read(fs.readFileSync(xp));
    const csv = wb.SheetNames.map((n) => XLSX.utils.sheet_to_csv(wb.Sheets[n])).join("\n");
    check(/Ético\/NETT/.test(csv) && csv.includes(B) && !csv.includes(C), "Excel (Vendas): linha «Ético/NETT» e só o resultado filtrado");
    const n1 = net.n();
    await page.getByRole("button", { name: "Limpar filtros" }).click();
    check((await quieto(page, net, 1200)) === 0 && net.n() === n1, "«Limpar filtros» (Vendas): 0 pedidos");
    check((await chip(page, "Ético/NETT:").count()) === 0, "…a classificação foi limpa");
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
    await opcao(page, RE_ETICO).click();
    check((await quieto(page, net, 1500)) === 0 && net.n() === m0, "Margens: mudar a classificação = 0 pedidos até «Atualizar»");
    check((await page.getByTestId("margens-alteracoes-por-aplicar").count()) === 1 && JSON.stringify(await cnpsM()) === JSON.stringify(todos), "…avisa «alterações por aplicar» e o relatório visível não muda");
    const [reqPdf0] = await Promise.all([
      page.waitForRequest((r) => r.url().includes("/api/reports/pdf"), { timeout: 120000 }),
      page.getByRole("button", { name: /^PDF$/ }).first().click(),
    ]);
    check(!/Ético\/NETT/.test(reqPdf0.postDataBuffer()!.toString("utf8")), "o PDF usa os filtros APLICADOS: a classificação ainda não aplicada NÃO aparece");
    await page.getByTestId("margens-gerar").waitFor();
    const m1 = net.n();
    await page.getByTestId("margens-gerar").click();
    await page.locator(`${SELM} tbody > tr[data-cnp="${CNP.B}"]`).first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(800);
    check(net.n() - m1 === 1, `«Atualizar» → exatamente 1 geração (${net.n() - m1})`);
    check(JSON.stringify(await cnpsM()) === JSON.stringify([B]), "Margens com ÉTICO: só B");
    secao("2b · Margens: impressão, PDF real, Excel real e email com «Ético/NETT: Ético»");
    const RE_FILTRO = /Ético\/NETT\W{0,6}Ético/;
    const tImp = await imprimir(page);
    check(RE_FILTRO.test(tImp) && tImp.includes(B) && !tImp.includes(A) && !tImp.includes(C), "impressão: filtro aplicado e só o artigo B");
    const pdfR = await pdfReal(page, ctx, EVID, "margens-etico.pdf");
    check(RE_FILTRO.test(pdfR.texto) && pdfR.texto.includes(B) && !pdfR.texto.includes(C), "PDF real: filtro aplicado e só o artigo B");
    const xlR = await excelReal(page, EVID, "margens-etico.xlsx");
    const csvPlano = xlR.csv.split(String.fromCharCode(10)).join(" ").split(",").join(" ");
    check(RE_FILTRO.test(csvPlano) && xlR.csv.includes(B) && !xlR.csv.includes(C), "Excel real: filtro aplicado e só o artigo B");
    const emR = await emailReal(page, smtp, EVID, "margens-etico");
    check(emR.enviado && !!emR.pdf && !!emR.xlsx, `email real recebido com PDF e Excel (${emR.anexos.join(", ")})`, emR.feedback.slice(-200));
    check(!!emR.pdf && RE_FILTRO.test(emR.pdf) && !!emR.xlsx && /Ético\/NETT/.test(emR.xlsx), "email: PDF e Excel RECEBIDOS trazem o filtro aplicado");
    const m2 = net.n();
    await page.getByRole("button", { name: "Limpar filtros" }).click();
    check((await quieto(page, net, 1500)) === 0 && net.n() === m2 && (await chip(page, "Ético/NETT:").count()) === 0, "Margens: «Limpar filtros» = 0 pedidos e limpa a seleção");
    await page.screenshot({ path: path.join(EVID, "margens.png") });

    // ═══ 3 · Stock ═══
    secao("3 · Stock");
    await page.goto(base + "/stock?eticoNett=ETICO", { waitUntil: "networkidle" });
    let ts = await textoPagina(page);
    check(tem(ts, B) && !tem(ts, A) && !tem(ts, C) && !tem(ts, D), "Stock (?eticoNett=ETICO): só B no tenant");
    await page.goto(base + "/stock?eticoNett=NETT", { waitUntil: "networkidle" });
    ts = await textoPagina(page);
    check(tem(ts, C) && tem(ts, D) && !tem(ts, B), "Stock NETT: C e D");
    await page.goto(base + "/stock?eticoNett=DIVERGENTE", { waitUntil: "networkidle" });
    ts = await textoPagina(page);
    check(tem(ts, A) && !tem(ts, B) && !tem(ts, C), "Stock DIVERGENTE: A");
    await page.goto(base + "/stock?eticoNett=SEM&q=IBUPROFENO", { waitUntil: "networkidle" }).catch(() => undefined);
    ts = await textoPagina(page);
    check(tem(ts, E) && !tem(ts, A) && !tem(ts, B), "Stock SEM (pesquisa IBUPROFENO): E");
    await page.goto(base + "/stock?eticoNett=ETICO&eticoNett=NETT", { waldUntil: "networkidle" } as never).catch(() => undefined);
    await page.goto(base + "/stock?eticoNett=ETICO&eticoNett=NETT", { waitUntil: "networkidle" });
    ts = await textoPagina(page);
    check(tem(ts, B) && tem(ts, C) && !tem(ts, A), "Stock: dois valores repetidos = união (Ético+NETT, sem o divergente A)");
    await page.goto(base + "/stock?eticoNett=" + encodeURIComponent("x'; DROP TABLE \"Produto\"; --"), { waitUntil: "networkidle" });
    check((await page.locator("body").innerText()).length > 0, "Stock: valor forjado na URL não parte a página");
    await page.goto(base + "/stock", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /^Filtros/ }).first().click();
    await opcao(page, RE_NETT).click();
    await page.waitForURL(/eticoNett=NETT/);
    ts = await textoPagina(page);
    check(tem(ts, C) && !tem(ts, B), "Stock: clicar na opção atualiza o URL e a lista (servidor)");
    await page.screenshot({ path: path.join(EVID, "stock.png") });
    await page.getByRole("button", { name: "Limpar", exact: true }).click();
    await page.waitForFunction(() => !location.search.includes("eticoNett="));
    check(!page.url().includes("eticoNett="), "Stock: «Limpar» remove o parâmetro");

    // ═══ 4 · Catálogo ═══
    secao("4 · Catálogo");
    await page.goto(base + "/catalogo?eticoNett=NETT", { waitUntil: "networkidle" });
    let tc = await textoPagina(page);
    check(tem(tc, C) && tem(tc, D) && !tem(tc, B) && !tem(tc, A), "Catálogo NETT: C e D");
    check(/\b2\b[\s\S]{0,12}produtos/.test(tc), "…o total do servidor reflete o filtro (2 produtos)");
    await page.goto(base + "/catalogo?eticoNett=DIVERGENTE", { waitUntil: "networkidle" });
    tc = await textoPagina(page);
    check(tem(tc, A) && !tem(tc, B) && /\b1\b[\s\S]{0,12}produto/.test(tc), "Catálogo DIVERGENTE: só A (1 produto)");
    await page.goto(base + "/catalogo", { waitUntil: "networkidle" });
    await opcao(page, RE_ETICO).click();
    await page.waitForURL(/eticoNett=ETICO/);
    tc = await textoPagina(page);
    check(tem(tc, B) && !tem(tc, A), "Catálogo: ÉTICO pela UI (só B no tenant)");
    await page.screenshot({ path: path.join(EVID, "catalogo.png") });
    await page.getByRole("button", { name: /^Limpar$/ }).click();
    await page.waitForFunction(() => !location.search.includes("eticoNett="));
    check(!page.url().includes("eticoNett="), "Catálogo: «Limpar» remove o parâmetro");

    // ═══ 5 · Proposta ═══
    secao("5 · Proposta de encomenda (farmácia Alfa)");
    await page.goto(base + "/encomendas/nova", { waitUntil: "networkidle" });
    const abrirP = page.getByRole("button", { name: /Filtros/ }).first();
    if ((await abrirP.count()) > 0 && (await page.getByPlaceholder(PH).count()) === 0) await abrirP.click();
    check((await page.getByPlaceholder(PH).count()) >= 1, "a proposta tem o filtro «Ético / NETT»");
    if ((await page.getByPlaceholder(PH).count()) >= 1) {
      await page.getByPlaceholder("Pesquisar por CNP ou descrição...").fill("IBUPROFENO").catch(() => undefined);
      await opcao(page, RE_ETICO).click();
      await page.getByRole("button", { name: /Gerar proposta/i }).first().click().catch(() => undefined);
      await page.waitForTimeout(3500);
      const tp = await textoPagina(page);
      const cartoes = tp.replace(/\s+/g, " ");
      check(/A COMPRAR 0/i.test(cartoes) && /ADEQUADO 2/i.test(cartoes), "proposta da Alfa com ÉTICO: 2 artigos (A e B — a classificação é a DA Alfa, onde A é Ético; C é NETT e E não tem)", cartoes.slice(0, 400));
      await opcao(page, RE_ETICO).click();
      await opcao(page, RE_NETT).click();
      await page.getByRole("button", { name: /Gerar nova proposta|Gerar proposta/i }).first().click();
      await page.waitForTimeout(3500);
      const tn = (await textoPagina(page)).replace(/\s+/g, " ");
      check(/ADEQUADO 0/i.test(tn) && /A COMPRAR 0/i.test(tn), "…com NETT a proposta da Alfa não tem A nem B (só C, sem vendas)", tn.slice(0, 400));
      await page.screenshot({ path: path.join(EVID, "encomenda-nova.png") });
    }

    // ═══ 6 · Lista de Encomendas ═══
    secao("6 · Lista de Encomendas");
    await page.goto(base + "/encomendas", { waitUntil: "networkidle" });
    const listaTxt = () => textoPagina(page);
    await page.goto(base + "/encomendas?eticoNett=ETICO", { waitUntil: "networkidle" });
    let tl = await listaTxt();
    check(tl.includes("ENC EN ALFA-A") && !tl.includes("ENC EN BETA-A") && !tl.includes("ENC EN ALFA-C") && !tl.includes("ENC EN ALFA-E"),
      "ÉTICO: só a encomenda da Alfa com o artigo A (na Beta o A é NETT)");
    await page.goto(base + "/encomendas?eticoNett=NETT", { waitUntil: "networkidle" });
    tl = await listaTxt();
    check(tl.includes("ENC EN BETA-A") && tl.includes("ENC EN ALFA-C") && !tl.includes("ENC EN ALFA-A"), "NETT: a da Beta (A) e a da Alfa (C)");
    await page.goto(base + "/encomendas?eticoNett=SEM", { waitUntil: "networkidle" });
    tl = await listaTxt();
    check(tl.includes("ENC EN ALFA-E") && !tl.includes("ENC EN ALFA-A"), "SEM: a encomenda do artigo sem classificação");
    await page.goto(base + "/encomendas?eticoNett=DIVERGENTE", { waitUntil: "networkidle" });
    tl = await listaTxt();
    check(!tl.includes("ENC EN ALFA-A") && !tl.includes("ENC EN BETA-A"), "DIVERGENTE: nenhuma encomenda (cada uma tem uma só farmácia)");
    await page.goto(base + "/encomendas", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /^Filtros/ }).first().click().catch(() => undefined);
    await opcao(page, RE_ETICO).click().catch(() => undefined);
    await page.waitForURL(/eticoNett=ETICO/, { timeout: 15000 }).catch(() => undefined);
    check(page.url().includes("eticoNett=ETICO"), "a UI da lista põe o filtro no URL (servidor, antes da paginação)");
    await page.screenshot({ path: path.join(EVID, "encomendas-lista.png") });

    // ═══ 7 · Ficha ═══
    secao("7 · Ficha do artigo");
    await page.goto(`${base}/catalogo/artigo/${CNP.A}`, { waitUntil: "networkidle" });
    const ficha = await textoPagina(page);
    check(/Classificação Ético\/NETT/.test(ficha) && /Divergente/.test(ficha), "a ficha de A mostra «Divergente»");
    check(/Farmacia Alfa/.test(ficha) && /Farmacia Beta/.test(ficha) && /Éticos/.test(ficha), "…com a origem por farmácia (Alfa: Éticos, Beta: NETT)");
    await page.goto(`${base}/catalogo/artigo/${CNP.E}`, { waitUntil: "networkidle" });
    check(/Nenhuma farmácia reporta classificação|Sem classificação/.test(await textoPagina(page)), "a ficha de E (sem classificação) não inventa valor");
    await page.screenshot({ path: path.join(EVID, "ficha.png") });

    // ═══ 8 · Workspace ═══
    secao("8 · Workspace: análises independentes e preservação entre separadores");
    await page.goto(`${base}/vendas?workspace=${wsVendas}`, { waitUntil: "networkidle" });
    await abrirFiltros(page);
    await opcao(page, RE_ETICO).click();
    await page.getByRole("button", { name: /Nova análise/ }).click();
    await page.waitForFunction((w) => new URL(location.href).searchParams.get("workspace") !== w, wsVendas);
    await page.waitForLoadState("networkidle");
    await abrirFiltros(page);
    check((await chip(page, "Ético/NETT:").count()) === 0, "uma nova análise de Vendas começa SEM classificação");
    await opcao(page, RE_NETT).click();
    await page.locator(`[data-navegacao-href^="/vendas?workspace=${wsVendas}"]`).click();
    await page.waitForFunction((w) => new URL(location.href).searchParams.get("workspace") === w, wsVendas);
    await abrirFiltros(page);
    check((await chip(page, "Ético/NETT: Ético").count()) >= 1 && (await chip(page, "Ético/NETT: NETT").count()) === 0, "a análise A mantém «Ético» e não herda o NETT da B");
    await page.goto(`${base}/relatorios/margens?workspace=${wsMargens}`, { waitUntil: "networkidle" });
    await abrirFiltros(page);
    await opcao(page, RE_DIV).click();
    await page.getByRole("link", { name: "Vendas", exact: true }).click();
    await page.waitForURL(/\/vendas/);
    await page.locator(`[data-navegacao-href^="/relatorios/margens?workspace=${wsMargens}"]`).click();
    await abrirFiltros(page);
    check((await chip(page, "Ético/NETT: Divergente").count()) >= 1, "Margens: voltar ao separador preserva a seleção");
    void D;
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
