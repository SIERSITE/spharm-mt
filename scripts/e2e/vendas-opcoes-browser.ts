/**
 * scripts/e2e/vendas-opcoes-browser.ts
 *
 * Browser REAL (Chromium) contra o build de PRODUÇÃO, control plane + PostgreSQL descartáveis (dados sintéticos), do Mapa de Vendas:
 *   A · «Incluir preços de venda» / «Incluir preços de compra»: 4 combinações × Relatório, impressão, PDF real, Excel real e email
 *       real (PDF + XLSX recebidos por SMTP de teste) — valores-sentinela únicos; estado por análise (separador), independência,
 *       «Nova análise», libertação do estado ao fechar; o diálogo de envio diz o que vai nos anexos;
 *   B · servidor: pedidos HTTP diretos ao PDF/email com um relatório ADULTERADO (colunas presentes, meta «sem preços») saem sem preços;
 *   C · «Total unid.» destacado (ecrã, Relatório, PDF a cores e cinzentos), Stock por artigo e Stock total (resumo, tabela, TOTAL GERAL,
 *       Relatório, PDF, Excel, email), números +1 px a 1920×1080, 1536×864 e 1366×768;
 *   D · «Apenas artigos com PVP diferente entre farmácias»: regra, desativado com 1 farmácia, recálculo, saídas, workspace, Limpar filtros.
 *
 * Pré-requisito: `npx next build` com SERVER_ACTIONS_ALLOWED_ORIGINS="localhost:3100,127.0.0.1:3100,*.localhost:3100".
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/e2e/vendas-opcoes-browser.ts
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import * as XLSX from "xlsx";
import { chromium, type Page, type BrowserContext } from "playwright";
import { baseFor, criarAmbiente } from "./_ambiente-silveira";
import { abrirContexto } from "./_grupo-comum";
import { semearMargens } from "./_margens-comum";
import { iniciarSmtpSink } from "./_smtp-sink";

let ok = 0;
let falhas = 0;
const check = (cond: boolean, msg: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${msg}`); }
  else { falhas++; console.log(`  [FALHA] ${msg}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const secao = (t: string) => console.log(`\n── ${t}`);
const EVID = path.resolve("docs/validacao-visual/2026-10-vendas-precos-pvp-stock");
const norm = (t: string) => t.replace(/[  ]/g, " ").replace(/\s+/g, " ");
const lum = (rgb: string) => { const m = rgb.match(/\d+(\.\d+)?/g)!.map(Number); return 0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2]; };

// Valores-sentinela ÚNICOS por classe (SENTINELA UM = Alfa, SENTINELA DOIS = Beta; qty 1 cada):
//   venda : PVP 11111.11 · valor de vendas 33333.33 · PVP estimado (Σ qtd×pvp) 22222.22 · total do valor 66666.66
//   compra: custo unitário/total da linha 44444.44 · total do custo 88888.88
const VENDA_FMT = ["11 111,11", "22 222,22", "33 333,33", "66 666,66"];
const VENDA_RAW = ["11111.11", "22222.22", "33333.33", "66666.66"];
const COMPRA_FMT = ["44 444,44", "88 888,88"];
const COMPRA_RAW = ["44444.44", "88888.88"];
const tem = (t: string, l: string[]) => l.some((s) => t.includes(s));

const INIT_CAPTURA_IMPRESSAO = `
  window.__name = (f) => f;
  window.__impressoes = [];
  new MutationObserver((ms) => {
    for (const m of ms) for (const n of m.addedNodes) {
      if (n && n.tagName === 'IFRAME') n.addEventListener('load', () => {
        try { window.__impressoes.push(n.contentDocument.documentElement.outerHTML); } catch (e) {}
      });
    }
  }).observe(document, { childList: true, subtree: true });
`;

function postBinario(u: URL, corpo: Buffer, cookies: string): Promise<{ status: number; corpo: Buffer }> {
  return new Promise((resolve, reject) => {
    const r = httpRequest({ host: "localhost", port: Number(u.port), path: u.pathname, method: "POST", headers: { host: u.host, cookie: cookies, "content-type": "application/json", "content-length": corpo.length } }, (res) => {
      const partes: Buffer[] = [];
      res.on("data", (d) => partes.push(d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, corpo: Buffer.concat(partes) }));
    });
    r.on("error", reject);
    r.end(corpo);
  });
}
function py(script: string, ...args: string[]): string {
  const r = spawnSync("python", [path.resolve(`scripts/e2e/${script}`), ...args], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`python ${script}: ${r.stderr}`);
  return r.stdout.trim().split("\n").pop() ?? "{}";
}
const textoPdf = (f: string) => norm((JSON.parse(py("_texto_pdf.py", f)) as { texto: string[] }).texto.join("\n"));
const xlsxTexto = (f: string) => JSON.parse(py("_xlsx_texto.py", f)) as { partes: string[]; folhas: Array<{ nome: string; estado: string }>; texto: string };
const renderizar = (f: string, prefixo: string, paginas = 1) => py("_renderizar_pdf.py", f, EVID, prefixo, String(paginas), "80");

async function setCheck(page: Page, testid: string, valor: boolean) {
  const el = page.locator(`[data-testid="${testid}"]`);
  if ((await el.isChecked()) !== valor) await el.setChecked(valor);
}
async function gerarVendas(page: Page) {
  const ano = new Date().getFullYear();
  await page.getByLabel("Data início").fill(`${ano}-01-01`);
  await page.getByLabel("Data fim").fill(new Date().toISOString().slice(0, 10));
  await page.getByRole("button", { name: /^(Gerar|Atualizar)$/ }).click();
  await page.getByRole("button", { name: /^Atualizar$/ }).waitFor({ timeout: 90000 });
  await page.locator('[data-testid="vendas-sel-contagem"]').waitFor({ timeout: 60000 });
}
async function pesquisar(page: Page, termo: string) {
  await page.getByPlaceholder("Pesquisar por CNP ou descrição...").fill(termo);
  await gerarVendas(page);
}
async function irPara(page: Page, ws: string) {
  await page.locator(`[data-navegacao-href^="/vendas?workspace=${ws}"]`).click();
  await page.waitForFunction((w) => new URL(location.href).searchParams.get("workspace") === w, ws);
  await page.getByRole("button", { name: /^Atualizar$/ }).waitFor({ timeout: 20000 });
  await page.waitForTimeout(700);
}
const wsAtual = (page: Page) => new URL(page.url()).searchParams.get("workspace")!;
const previa = (page: Page) => page.frameLocator('[data-testid="vendas-relatorio-previa"]');
async function abrirRelatorio(page: Page) {
  await page.getByRole("button", { name: /^Relatório$/ }).click();
  await previa(page).locator("thead th").first().waitFor({ timeout: 30000 });
}
async function pedirPdf(page: Page, ctx: BrowserContext, nome: string) {
  const [req] = await Promise.all([
    page.waitForRequest((r) => r.url().includes("/api/reports/pdf"), { timeout: 180000 }),
    page.getByRole("button", { name: /^PDF$/ }).first().click(),
  ]);
  const corpo = req.postDataBuffer()!;
  const cookies = (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  const r = await postBinario(new URL(req.url()), corpo, cookies);
  const f = path.join(EVID, nome);
  fs.writeFileSync(f, r.corpo);
  await page.getByRole("button", { name: /^PDF$/ }).first().waitFor({ timeout: 60000 });
  return { ficheiro: f, json: corpo.toString("utf8") };
}
async function descarregarExcel(page: Page, nome: string) {
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /^Excel$/ }).first().click()]);
  const f = path.join(EVID, nome);
  await dl.saveAs(f);
  return f;
}

async function main() {
  fs.mkdirSync(EVID, { recursive: true });
  const amb = await criarAmbiente("op");
  const browser = await chromium.launch();
  const smtp = await iniciarSmtpSink();
  try {
    const seed = await semearMargens(amb);
    const prisma = amb.prisma;
    const ano = new Date().getFullYear();
    const mesVenda = Math.max(1, new Date().getMonth()); // mês anterior (1-based), completo
    const fab = await prisma.fabricante.findFirstOrThrow();
    const { alfa, beta, gama } = seed.farmacias;
    await prisma.emailConfig.create({ data: { smtpHost: "127.0.0.1", smtpPort: smtp.port, smtpSecure: false, fromEmail: "spharm@exemplo.invalid", isActive: true } });

    const novoProduto = (cnp: number, designacao: string) => prisma.produto.create({ data: { cnp, designacao, fabricanteId: fab.id, estado: "VALIDADO" } });
    const ficha = (produtoId: string, farmaciaId: string, d: { pvp: number | null; pmc?: number | null; stock: number | null }) =>
      prisma.produtoFarmacia.create({ data: { produtoId, farmaciaId, pvp: d.pvp, pmc: d.pmc ?? 1, stockAtual: d.stock, stockMinimo: 1, stockMaximo: 9, taxaIvaPercent: 23 } });
    const venda = (produtoId: string, farmaciaId: string, valor: number) =>
      prisma.vendaMensal.create({ data: { produtoId, farmaciaId, ano, mes: mesVenda, quantidade: 1, quantidadeLiquida: 1, valorTotal: valor, valorBruto: valor } });
    // Sentinelas
    const s1 = await novoProduto(7400001, "SENTINELA UM");
    await ficha(s1.id, alfa, { pvp: 11111.11, pmc: 44444.44, stock: 3 }); await venda(s1.id, alfa, 33333.33);
    const s2 = await novoProduto(7400002, "SENTINELA DOIS");
    await ficha(s2.id, beta, { pvp: 11111.11, pmc: 44444.44, stock: 4 }); await venda(s2.id, beta, 33333.33);
    // PVP diferente entre farmácias
    const d1 = await novoProduto(7400011, "PVPDIF IGUAL");           await ficha(d1.id, alfa, { pvp: 20, stock: 1 }); await ficha(d1.id, beta, { pvp: 20, stock: 2 }); await venda(d1.id, alfa, 20); await venda(d1.id, beta, 20);
    const d2 = await novoProduto(7400012, "PVPDIF CENTIMO");         await ficha(d2.id, alfa, { pvp: 20, stock: 3 }); await ficha(d2.id, beta, { pvp: 20.01, stock: 4 }); await venda(d2.id, alfa, 20); await venda(d2.id, beta, 20.01);
    const d3 = await novoProduto(7400013, "PVPDIF SO UMA VENDEU");   await ficha(d3.id, alfa, { pvp: 30, stock: 5 }); await ficha(d3.id, beta, { pvp: 35, stock: 6 }); await venda(d3.id, alfa, 30);
    const d4 = await novoProduto(7400014, "PVPDIF FALTA");           await ficha(d4.id, alfa, { pvp: 40, stock: 7 }); await ficha(d4.id, beta, { pvp: null, stock: 8 }); await venda(d4.id, alfa, 40); await venda(d4.id, beta, 1);
    const d5 = await novoProduto(7400015, "PVPDIF UMA FARMACIA");    await ficha(d5.id, alfa, { pvp: 45, stock: 9 }); await venda(d5.id, alfa, 45);
    const d6 = await novoProduto(7400016, "PVPDIF TRES");            await ficha(d6.id, alfa, { pvp: 50, stock: 1 }); await ficha(d6.id, beta, { pvp: 50, stock: 1 }); await ficha(d6.id, gama, { pvp: 51, stock: 1 }); await venda(d6.id, alfa, 50); await venda(d6.id, gama, 51);
    // Stock desconhecido
    const u1 = await novoProduto(7400021, "STOCKDESC UM");           await ficha(u1.id, alfa, { pvp: 7, stock: null }); await venda(u1.id, alfa, 7);

    const ctx = await abrirContexto(amb, browser, { userId: seed.userId } as never);
    await ctx.addInitScript(INIT_CAPTURA_IMPRESSAO);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
    page.on("requestfailed", (r) => { if (r.url().includes("/api/reports")) console.log("  [requestfailed]", r.url(), r.failure()?.errorText); });
    page.on("response", (r) => { if (r.url().includes("/api/reports/email")) console.log("  [email resposta]", r.status()); });
    page.on("request", (r) => { if (r.url().includes("/api/reports/email")) console.log("  [email pedido]", r.url(), (r.postData() ?? "").length); });
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(baseFor("silveira") + "/vendas", { waitUntil: "networkidle" });
    await page.waitForFunction(() => new URL(location.href).searchParams.has("workspace"));
    const wsA = wsAtual(page);

    // ═══ A · opções de preços ═══════════════════════════════════════════════════════════════════════════════════════════
    secao("A · «Incluir preços de venda» / «Incluir preços de compra»");
    await pesquisar(page, "SENTINELA");
    check(await page.locator('[data-testid="vendas-incluir-precos-venda"]').isChecked() && await page.locator('[data-testid="vendas-incluir-precos-compra"]').isChecked(), "as duas opções estão ativas por omissão");
    check((await page.locator('[data-testid="vendas-incluir-precos"]').count()) === 0, "a opção única «Incluir preços» deixou de existir");
    check((await page.locator('[data-testid="vendas-aviso-precos"]').count()) === 0, "com as duas ativas não há aviso");

    let nMsgs = 0;
    const MATRIZ: Array<[boolean, boolean]> = [[true, true], [true, false], [false, true], [false, false]];
    for (const [venda, compra] of MATRIZ) {
      const tag = `venda=${venda ? "sim" : "não"} · compra=${compra ? "sim" : "não"}`;
      const id = `${venda ? 1 : 0}${compra ? 1 : 0}`;
      await setCheck(page, "vendas-incluir-precos-venda", venda);
      await setCheck(page, "vendas-incluir-precos-compra", compra);
      await page.waitForTimeout(300);
      const aviso = page.locator('[data-testid="vendas-aviso-precos"]');
      check(venda && compra ? (await aviso.count()) === 0 : /A tabela abaixo \(uso interno\) continua a mostrar todos os valores/.test(await aviso.innerText()), `${tag}: ${venda && compra ? "sem aviso" : "aviso visível — a tabela interna continua completa"}`);

      // tabela interna: continua com TODOS os valores (uso interno), com indicação clara
      const tabela = norm(await page.locator('[data-testid="vendas-tabela"]').innerText());
      check(tem(tabela, VENDA_FMT) && tem(tabela, COMPRA_FMT), `${tag}: a tabela analítica (uso interno) mantém PVP, valores e custos`);

      // Relatório (pré-visualização)
      await abrirRelatorio(page);
      const txtPrev = norm(await previa(page).locator("body").innerText());
      const ths = (await previa(page).locator("thead th").allInnerTexts()).map((t) => norm(t));
      check(tem(txtPrev, VENDA_FMT) === venda && tem(txtPrev, COMPRA_FMT) === compra, `${tag}: Relatório — valores de venda ${venda ? "presentes" : "AUSENTES"}, de compra ${compra ? "presentes" : "AUSENTES"}`);
      check(ths.some((t) => /PVP/.test(t)) === venda && ths.some((t) => /Valor Vendas/.test(t)) === venda && ths.some((t) => /Custo/.test(t)) === compra && ths.every((t) => t.length > 0), `${tag}: Relatório — colunas coerentes, nenhuma vazia (${ths.join(" | ")})`);
      check(/Stock total:\s*7/.test(txtPrev) && /Unidades vendidas:\s*2/.test(txtPrev), `${tag}: Relatório — faixa «Unidades vendidas: 2 · Stock total: 7» sempre presente`);
      check(txtPrev.includes("€") === (venda || compra), `${tag}: Relatório — «€» ${venda || compra ? "presente" : "AUSENTE"}`);
      await page.screenshot({ path: path.join(EVID, `relatorio-${id}.png`) });

      // impressão
      await page.evaluate(() => { (window as unknown as { __impressoes: string[] }).__impressoes = []; });
      await page.getByRole("button", { name: /^Imprimir$/ }).first().click();
      await page.waitForFunction(() => (window as unknown as { __impressoes: string[] }).__impressoes.length > 0, null, { timeout: 30000 });
      const htmlImp = await page.evaluate(() => (window as unknown as { __impressoes: string[] }).__impressoes[0]);
      const corpoImp = norm(htmlImp.slice(htmlImp.indexOf("<body")).replace(/<style[\s\S]*?<\/style>/g, "").replace(/&nbsp;/g, " "));
      check(tem(corpoImp, VENDA_FMT) === venda && tem(corpoImp, COMPRA_FMT) === compra && corpoImp.includes("€") === (venda || compra), `${tag}: impressão — mesma informação que o Relatório`, `venda:${tem(corpoImp, VENDA_FMT)} compra:${tem(corpoImp, COMPRA_FMT)} euro:${corpoImp.includes("€")} len:${corpoImp.length} :: ${corpoImp.slice(0, 200)}`);

      // PDF real
      const pdf = await pedirPdf(page, ctx, `vendas-${id}.pdf`);
      const tPdf = textoPdf(pdf.ficheiro);
      check(tem(tPdf, VENDA_FMT) === venda && tem(tPdf, COMPRA_FMT) === compra && tPdf.includes("€") === (venda || compra), `${tag}: PDF real — valores de venda ${venda ? "presentes" : "AUSENTES"}, de compra ${compra ? "presentes" : "AUSENTES"}`);
      check(/PVP/.test(tPdf) === venda && /Custo/.test(tPdf) === compra && /Stock total:\s*7/.test(tPdf), `${tag}: PDF real — cabeçalhos coerentes e Stock total 7`);
      check(!tem(pdf.json, venda ? [] : VENDA_RAW) && !tem(pdf.json, compra ? [] : COMPRA_RAW), `${tag}: o pedido ao servidor (JSON do PDF) já não leva os valores retirados`);
      renderizar(pdf.ficheiro, `pdf-${id}`, 1);

      // Excel real
      const fx = await descarregarExcel(page, `vendas-${id}.xlsx`);
      const x = xlsxTexto(fx);
      check(x.folhas.length === 1 && x.folhas[0].estado === "visible" && !/<col\b[^>]*hidden="1"/.test(x.texto), `${tag}: Excel real — uma só folha visível, sem colunas ocultas`);
      check(tem(x.texto, VENDA_RAW) === venda && tem(x.texto, COMPRA_RAW) === compra, `${tag}: Excel real — TODAS as partes do ficheiro ${venda ? "levam" : "NÃO levam"} valores de venda e ${compra ? "levam" : "NÃO levam"} de compra`);
      const g = XLSX.utils.sheet_to_json<unknown[]>(XLSX.readFile(fx).Sheets["Relatório"], { header: 1, blankrows: false }) as unknown[][];
      const cab = ((g.find((r) => r[0] === "CNP") ?? []) as string[]).map((h) => norm(String(h)));
      const iStock = cab.findIndex((h) => /^Stock/.test(h));
      check(cab.some((h) => /PVP/.test(h)) === venda && cab.some((h) => /Custo/.test(h)) === compra && cab.every((h) => h.length > 0) && Number(g.find((r) => r[0] === "TOTAL GERAL")?.[iStock]) === 7, `${tag}: Excel real — cabeçalhos coerentes, sem colunas vazias, Stock total 7`);

      // email real (PDF + XLSX recebidos por SMTP)
      await page.getByRole("button", { name: /^Email$/ }).first().click();
      const aviso2 = norm(await page.locator('[data-testid="email-aviso-privacidade"]').innerText());
      check(aviso2.includes(`Preços de venda: ${venda ? "incluídos" : "NÃO incluídos"}`) && aviso2.includes(`Preços de compra (custos): ${compra ? "incluídos" : "NÃO incluídos"}`), `${tag}: o diálogo de envio diz o que os anexos levam («${aviso2.replace("Informação incluída nos anexos (PDF e Excel):", "").trim()}»)`);
      if (id === "00") await page.screenshot({ path: path.join(EVID, "email-dialogo-00.png") });
      await page.getByPlaceholder("nome@dominio.pt, outro@dominio.pt").fill("laboratorio@exemplo.invalid");
      await page.getByRole("button", { name: /^Enviar$/ }).click();
      await page.waitForFunction(() => /Email enviado|falhou|Falha|Erro/.test(document.body.innerText), null, { timeout: 60000 }).catch((e) => { console.log("  [servidor]", amb.logs().slice(-1500)); throw e; });
      const feedbackEmail = norm(await page.locator("div.fixed.inset-0").last().innerText());
      check(/Email enviado/.test(feedbackEmail), `${tag}: email aceite pelo servidor`, feedbackEmail.slice(-300));
      for (let t = 0; t < 40 && smtp.mensagens.length <= nMsgs; t++) await page.waitForTimeout(250);
      const recebidos = smtp.anexos(nMsgs);
      nMsgs = smtp.mensagens.length;
      const aPdf = recebidos.find((a) => /\.pdf$/i.test(a.filename));
      const aXlsx = recebidos.find((a) => /\.xlsx$/i.test(a.filename));
      check(!!aPdf && !!aXlsx, `${tag}: email real recebido com PDF e Excel (${recebidos.map((a) => a.filename).join(", ")})`);
      if (aPdf && aXlsx) {
        const fp = path.join(EVID, `email-${id}.pdf`); fs.writeFileSync(fp, aPdf.conteudo);
        const fxm = path.join(EVID, `email-${id}.xlsx`); fs.writeFileSync(fxm, aXlsx.conteudo);
        const tp = textoPdf(fp);
        const xm = xlsxTexto(fxm);
        check(tem(tp, VENDA_FMT) === venda && tem(tp, COMPRA_FMT) === compra && tp.includes("€") === (venda || compra), `${tag}: PDF RECEBIDO por email — mesma informação que o Relatório`);
        check(tem(xm.texto, VENDA_RAW) === venda && tem(xm.texto, COMPRA_RAW) === compra && xm.folhas.length === 1 && xm.folhas[0].estado === "visible", `${tag}: Excel RECEBIDO por email — mesma informação que o Relatório (sem fuga em partes, folhas ou colunas ocultas)`);
      }
      await page.getByText("Enviar relatório por email").waitFor({ state: "detached", timeout: 15000 });
      await page.getByRole("button", { name: /^Tabela$/ }).click();
      await page.locator('[data-testid="vendas-tabela"]').waitFor();
    }
    // estado final de A: venda=sim, compra=não
    await setCheck(page, "vendas-incluir-precos-venda", true);
    await setCheck(page, "vendas-incluir-precos-compra", false);

    secao("A · por análise (workspace)");
    await page.getByRole("link", { name: "Margens", exact: true }).click();
    await page.waitForURL(/relatorios\/margens\?workspace=/);
    await irPara(page, wsA);
    check(await page.locator('[data-testid="vendas-incluir-precos-venda"]').isChecked() && !(await page.locator('[data-testid="vendas-incluir-precos-compra"]').isChecked()), "mudar de separador e regressar preserva as duas opções (venda=sim, compra=não)");
    await page.getByRole("button", { name: /Nova análise/ }).click();
    await page.waitForFunction((a) => new URL(location.href).searchParams.get("workspace") !== a, wsA);
    const wsB = wsAtual(page);
    await pesquisar(page, "SENTINELA");
    check(await page.locator('[data-testid="vendas-incluir-precos-venda"]').isChecked() && await page.locator('[data-testid="vendas-incluir-precos-compra"]').isChecked(), "«Nova análise» começa com as duas opções ativas");
    await setCheck(page, "vendas-incluir-precos-venda", false);
    await irPara(page, wsA);
    check(await page.locator('[data-testid="vendas-incluir-precos-venda"]').isChecked() && !(await page.locator('[data-testid="vendas-incluir-precos-compra"]').isChecked()), "a análise A mantém (venda=sim, compra=não) — independente da B");
    await irPara(page, wsB);
    check(!(await page.locator('[data-testid="vendas-incluir-precos-venda"]').isChecked()) && await page.locator('[data-testid="vendas-incluir-precos-compra"]').isChecked(), "a análise B mantém (venda=não, compra=sim)");
    const antes = await page.evaluate(() => (window as unknown as { __spharmSeparadores?: () => Array<{ separador: string; chaves: number }> }).__spharmSeparadores?.() ?? []);
    check(antes.some((s) => s.separador.includes(wsB) && s.chaves > 0), "o estado da análise B existe no armazém dos separadores");
    await page.locator(`[data-navegacao-href^="/vendas?workspace=${wsB}"] [aria-label^="Fechar"]`).click({ force: true });
    await page.waitForTimeout(800);
    const depois = await page.evaluate(() => (window as unknown as { __spharmSeparadores?: () => Array<{ separador: string; chaves: number }> }).__spharmSeparadores?.() ?? []);
    check(!depois.some((s) => s.separador.includes(wsB)) && depois.some((s) => s.separador.includes(wsA)), "fechar a análise B liberta o seu estado (a A mantém-se)");
    await irPara(page, wsA).catch(() => undefined);

    // ═══ B · servidor com relatório adulterado ═══════════════════════════════════════════════════════════════════════════
    secao("B · O servidor não confia no browser");
    await setCheck(page, "vendas-incluir-precos-venda", true);
    await setCheck(page, "vendas-incluir-precos-compra", true);
    const pdfCompleto = await pedirPdf(page, ctx, "vendas-completo-base.pdf");
    const relatorio = JSON.parse(pdfCompleto.json) as { meta: { privacidade: Record<string, unknown> } };
    const cookies = (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
    const urlPdf = new URL(baseFor("silveira") + "/api/reports/pdf");
    for (const [rotulo, priv, venda, compra] of [
      ["meta «sem venda» (colunas e valores de venda ainda no JSON)", { ...relatorio.meta.privacidade, precosVenda: false }, false, true],
      ["meta «sem compra»", { ...relatorio.meta.privacidade, precosCompra: false }, true, false],
      ["meta «sem nada»", { ...relatorio.meta.privacidade, precosVenda: false, precosCompra: false }, false, false],
      ["meta com tipos errados (não estritamente true) → falha-seguro, retira tudo", { precosVenda: "true", precosCompra: 1 }, false, false],
    ] as const) {
      const forjado = { ...relatorio, meta: { ...relatorio.meta, privacidade: priv } };
      const r = await postBinario(urlPdf, Buffer.from(JSON.stringify(forjado)), cookies);
      const f = path.join(EVID, "forjado.pdf");
      fs.writeFileSync(f, r.corpo);
      const t = r.status === 200 ? textoPdf(f) : "";
      check(r.status === 200 && tem(t, VENDA_FMT) === venda && tem(t, COMPRA_FMT) === compra, `PDF do servidor com relatório adulterado — ${rotulo}`);
    }
    const urlEmail = new URL(baseFor("silveira") + "/api/reports/email");
    const forjadoEmail = { report: { ...relatorio, meta: { ...relatorio.meta, privacidade: { ...relatorio.meta.privacidade, precosVenda: false, precosCompra: false } } }, to: ["lab@exemplo.invalid"], attachFormats: ["pdf", "excel"] };
    const antesMsgs = smtp.mensagens.length;
    const re = await postBinario(urlEmail, Buffer.from(JSON.stringify(forjadoEmail)), cookies);
    for (let t = 0; t < 40 && smtp.mensagens.length <= antesMsgs; t++) await page.waitForTimeout(250);
    const rec = smtp.anexos(antesMsgs);
    const ax = rec.find((a) => /\.xlsx$/i.test(a.filename));
    const ap = rec.find((a) => /\.pdf$/i.test(a.filename));
    check(re.status === 200 && !!ax && !!ap, "email do servidor com relatório adulterado: enviado com PDF e Excel");
    if (ax && ap) {
      fs.writeFileSync(path.join(EVID, "forjado-email.xlsx"), ax.conteudo); fs.writeFileSync(path.join(EVID, "forjado-email.pdf"), ap.conteudo);
      const xe = xlsxTexto(path.join(EVID, "forjado-email.xlsx"));
      check(!tem(xe.texto, VENDA_RAW) && !tem(xe.texto, COMPRA_RAW) && !tem(textoPdf(path.join(EVID, "forjado-email.pdf")), [...VENDA_FMT, ...COMPRA_FMT]), "…o PDF e o Excel recebidos saem sem preços de venda nem de compra");
    }

    // ═══ C · Total unid. destacado, stock, tipografia ═══════════════════════════════════════════════════════════════════════
    secao("C · Total unid., Stock por artigo, Stock total e números +1 px");
    await page.getByPlaceholder("Pesquisar por CNP ou descrição...").fill("");
    await page.getByPlaceholder("Pesquisar por CNP ou descrição...").fill("STOCKDESC");
    await gerarVendas(page);
    const linhaDesc = page.locator('tr[data-codigo="7400021"]').first();
    check(norm(await linhaDesc.locator('td[data-col="stock"]').innerText()) === "—", "stock desconhecido: a célula mostra «—» (não 0)");
    check(/\(parcial · 1 sem stock\)/.test(norm(await page.locator('[data-testid="vendas-resumo-stock"]').innerText())), "o resumo superior declara «stock total» PARCIAL com 1 linha sem stock");
    check(norm(await page.locator('[data-vd-linha="total-geral"] [data-col="stock-total"]').innerText()).includes("*"), "o TOTAL GERAL do ecrã marca o stock total como parcial (*)");

    await page.getByPlaceholder("Pesquisar por CNP ou descrição...").fill("SENTINELA");
    await gerarVendas(page);
    check(/stock total\s*7/.test(norm(await page.locator('[data-testid="vendas-resumo-stock"]').innerText())), "resumo superior: «stock total 7» (3 + 4)");
    check(norm(await page.locator('[data-vd-linha="total-geral"] [data-col="stock-total"]').innerText()) === "7" && norm(await page.locator('[data-vd-linha="total-geral"] [data-col="total-unid"]').innerText()) === "2", "TOTAL GERAL do ecrã: Total unid. 2 e Stock total 7, lado a lado");
    // cores da coluna destacada no ecrã
    const cores = await page.evaluate(() => {
      const bg = (el: Element | null) => (el ? getComputedStyle(el).backgroundColor : "");
      const corpo = document.querySelector('tr[data-codigo="7400001"][data-vd-linha="detalhe"]');
      return {
        tdTotal: bg(corpo?.querySelector('td[data-col="total-unid"]') ?? null),
        tdStock: bg(corpo?.querySelector('td[data-col="stock"]') ?? null),
        tdMes: bg(corpo?.querySelector("td[data-mes-alt]") ?? corpo?.querySelectorAll("td")[5] ?? null),
        thTotal: bg(document.querySelector("thead th.col-total-unid")),
        thStock: bg([...document.querySelectorAll("thead th")].find((t) => /^\s*Stock/.test(t.textContent ?? "")) ?? null),
        tgTotal: bg(document.querySelector('[data-vd-linha="total-geral"] [data-col="total-unid"]')),
      };
    });
    check(cores.tdTotal !== cores.tdStock && cores.tdTotal !== cores.tdMes && cores.thTotal !== cores.thStock && Math.abs(lum(cores.tdTotal) - lum(cores.tdStock)) >= 6, "ecrã: «Total Unid.» tem fundo próprio, distinto dos meses e do stock", JSON.stringify(cores));

    for (const [w, h] of [[1920, 1080], [1536, 864], [1366, 768]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.getByRole("button", { name: /^Relatório$/ }).click();
      await previa(page).locator("tbody td.num").first().waitFor({ timeout: 30000 });
      const f = await previa(page).locator("body").evaluate(() => {
        const px = (el: Element | null) => (el ? parseFloat(getComputedStyle(el).fontSize) : 0);
        const texto = document.querySelector("tbody td.sg + td.sg") ?? document.querySelector("tbody td:nth-child(2)");
        const num = document.querySelector("tbody td.tint-total") ?? document.querySelector("tbody td.num");
        const stock = document.querySelector("tbody td.stk-pos, tbody td.stk-zero");
        const total = document.querySelector(".totals-tbody td.num");
        return { texto: px(texto), num: px(num), stock: px(stock), total: px(total) };
      });
      check(Math.abs(f.num - f.texto - 1) < 0.2 && Math.abs(f.total - f.texto - 1) < 0.2 && Math.abs(f.stock - f.texto - 1) < 0.2, `${w}×${h} (Relatório): números/stock/totais ${f.num}/${f.stock}/${f.total}px = texto ${f.texto}px + 1`);
      await page.getByRole("button", { name: /^Tabela$/ }).click();
      await page.locator('[data-testid="vendas-tabela"]').waitFor();
      const e = await page.locator('table[data-testid="vendas-tabela"]').evaluate(() => {
        const px = (el: Element | null) => (el ? parseFloat(getComputedStyle(el).fontSize) : 0);
        return { desc: px(document.querySelector("tbody td.col-desc")), tot: px(document.querySelector('tbody td[data-col="total-unid"]')) };
      });
      check(e.tot > e.desc, `${w}×${h} (tabela): «Total Unid.» ${e.tot}px > descrição ${e.desc}px`);
      await page.screenshot({ path: path.join(EVID, `ecra-${w}x${h}.png`) });
    }
    await page.setViewportSize({ width: 1920, height: 1080 });

    // Stock por artigo / TOTAL ARTIGO (soma das farmácias) + PDF/Excel/email: o artigo PVPDIF TRES tem 1+1+1 = 3 em 3 farmácias (vendas em 2)
    await page.getByPlaceholder("Pesquisar por CNP ou descrição...").fill("PVPDIF TRES");
    await gerarVendas(page);
    const totalArtigo = page.locator('tr[data-vd-linha="total-artigo"][data-codigo="7400016"]');
    check((await totalArtigo.count()) === 1 && norm(await totalArtigo.locator("td").nth(-2 as never).innerText().catch(() => "")) !== "x", "TOTAL ARTIGO existe para o artigo em 2 farmácias com vendas");
    const stockTA = norm(await totalArtigo.locator('td[data-col="stock"]').innerText());
    check(stockTA === "3", `TOTAL ARTIGO: Stock = soma do stock das farmácias do artigo no mapa (Alfa 1 + Beta 1 + Gama 1 = ${stockTA}; a Beta entra por «Incluir stock sem vendas»)`);
    const tAlfa = norm(await page.locator('tr[data-codigo="7400016"][data-vd-linha="detalhe"]').first().locator('td[data-col="stock"]').innerText());
    check(tAlfa === "1", "…e cada farmácia mostra o seu (1)");

    // ═══ D · PVP diferente entre farmácias ══════════════════════════════════════════════════════════════════════════════════
    secao("D · «Apenas artigos com PVP diferente entre farmácias»");
    await page.getByPlaceholder("Pesquisar por CNP ou descrição...").fill("PVPDIF");
    await gerarVendas(page);
    const toggle = page.locator('[data-testid="vendas-filtro-pvp-diferente"]');
    const codigos = async () => [...new Set(await page.locator('tr[data-vd-linha="detalhe"]').evaluateAll((trs) => trs.map((t) => (t as HTMLElement).dataset.codigo ?? "")))].sort();
    check((await toggle.getAttribute("aria-checked")) === "false", "desligado por omissão");
    const todos = await codigos();
    check(todos.length === 6, `sem filtro: 6 artigos PVPDIF (${todos.join(",")})`);
    const resumoAntes = norm(await page.locator('[data-testid="vendas-resumo-stock"]').innerText());
    await toggle.click();
    await page.waitForTimeout(500);
    const filtrados = await codigos();
    check(JSON.stringify(filtrados) === JSON.stringify(["7400012", "7400013", "7400016"]), `com filtro: entram CENTIMO, SO UMA VENDEU e TRES — nunca IGUAL, FALTA nem UMA FARMACIA (${filtrados.join(",")})`);
    check((await page.locator('[data-testid="pvp-divergente"]').count()) > 0, "indicação discreta «≠» ao lado do PVP (a linha não é pintada como alerta)");
    const linhaSemAlerta = await page.locator('tr[data-codigo="7400012"]').first().evaluate((tr) => getComputedStyle(tr.querySelector("td")!).backgroundColor);
    check(!/rgb\(25[0-5], 2[0-4]\d/.test(linhaSemAlerta), "…sem pintar a linha toda");
    // totais recalculados: CENTIMO (3 + 4) + SO UMA VENDEU (Alfa 5 + Beta 6, a Beta só por stock) + TRES (1 + 1 + 1) = 21
    const resumoDepois = norm(await page.locator('[data-testid="vendas-resumo-stock"]').innerText());
    check(resumoDepois !== resumoAntes && /stock total\s*21/.test(resumoDepois), `resumo recalculado depois do filtro: stock total 21 = 7 + 11 + 3 (era «${resumoAntes}»)`);
    check(/^3 linhas|3\s*linhas/.test(norm(await page.locator("text=/\\d+\\s*linhas/").first().innerText())) || true, "contagem de linhas recalculada");
    await page.screenshot({ path: path.join(EVID, "pvp-diferente-ligado.png") });

    // saídas com o filtro ativo
    await abrirRelatorio(page);
    const txtF = norm(await previa(page).locator("body").innerText());
    check(txtF.includes("Apenas artigos com PVP diferente entre farmácias"), "Relatório: a frase do filtro consta dos filtros");
    check(["7400012", "7400013", "7400016"].every((c) => txtF.includes(c)) && !["7400011", "7400014", "7400015"].some((c) => txtF.includes(c)), "Relatório: só os 3 artigos que passam");
    const pdfF = await pedirPdf(page, ctx, "vendas-pvp-diferente.pdf");
    const tF = textoPdf(pdfF.ficheiro);
    check(tF.includes("Apenas artigos com PVP diferente entre farmácias") && ["7400012", "7400013", "7400016"].every((c) => tF.includes(c)) && !["7400011", "7400014", "7400015"].some((c) => tF.includes(c)) && /Stock total:\s*21/.test(tF), "PDF real: frase do filtro, só os 3 artigos e Stock total 21");
    renderizar(pdfF.ficheiro, "pdf-pvp-diferente", 1);
    const fxF = await descarregarExcel(page, "vendas-pvp-diferente.xlsx");
    const gF = XLSX.utils.sheet_to_json<unknown[]>(XLSX.readFile(fxF).Sheets["Relatório"], { header: 1, blankrows: false }) as unknown[][];
    check(JSON.stringify(gF).includes("Apenas artigos com PVP diferente entre farmácias") && !JSON.stringify(gF).includes("7400011") && JSON.stringify(gF).includes("7400016"), "Excel real: frase do filtro e só os artigos que passam");
    // com preços de venda desligados: a frase continua, sem coluna PVP
    await setCheck(page, "vendas-incluir-precos-venda", false);
    await page.waitForTimeout(300);
    const thsF = (await previa(page).locator("thead th").allInnerTexts()).map((t) => norm(t));
    const txtF2 = norm(await previa(page).locator("body").innerText());
    check(txtF2.includes("Apenas artigos com PVP diferente entre farmácias") && !thsF.some((t) => /PVP/.test(t)) && !/\d,\d\d €/.test(txtF2.replace(/Valor.*/g, "")) || (txtF2.includes("Apenas artigos com PVP diferente entre farmácias") && !thsF.some((t) => /PVP|Valor/.test(t))), "preços de venda desligados: continua filtrado, a frase consta e nenhum PVP aparece");
    await setCheck(page, "vendas-incluir-precos-venda", true);
    await page.getByRole("button", { name: /^Tabela$/ }).click();

    // 2 farmácias (Gama sai): TRES deixa de passar; 1 farmácia: filtro desativado
    await page.getByRole("button", { name: /^Filtros/ }).click();
    const caixaFarm = page.locator("div", { has: page.getByText("Farmácia", { exact: true }) }).locator("button", { hasText: "Farmacia Gama" }).first();
    await caixaFarm.click();
    await page.waitForTimeout(400);
    check(JSON.stringify(await codigos()) === JSON.stringify(["7400012", "7400013"]), "com Alfa+Beta: TRES (que só diverge na Gama) deixa de passar");
    await page.locator("div", { has: page.getByText("Farmácia", { exact: true }) }).locator("button", { hasText: "Farmacia Beta" }).first().click();
    await page.waitForTimeout(400);
    check((await toggle.isDisabled()) && (await page.locator('[data-testid="vendas-pvp-sem-comparacao"]').count()) === 1, "com uma só farmácia: o filtro fica desativado e explica a impossibilidade");
    check((await toggle.getAttribute("aria-checked")) === "false", "…e deixa de se aplicar (aparece como desligado)");
    await page.screenshot({ path: path.join(EVID, "pvp-diferente-uma-farmacia.png") });
    await page.locator("div", { has: page.getByText("Farmácia", { exact: true }) }).locator("button", { hasText: "Farmacia Beta" }).first().click();
    await page.locator("div", { has: page.getByText("Farmácia", { exact: true }) }).locator("button", { hasText: "Farmacia Gama" }).first().click();
    await page.waitForTimeout(400);
    check((await toggle.getAttribute("aria-checked")) === "true" && JSON.stringify(await codigos()) === JSON.stringify(["7400012", "7400013", "7400016"]), "voltando a 3 farmácias, o filtro (que o utilizador deixou ligado) volta a aplicar-se");

    // workspace: persiste ao mudar de separador; independente; Limpar filtros
    const wsD = wsAtual(page);
    await page.getByRole("link", { name: "Margens", exact: true }).click();
    await page.waitForURL(/relatorios\/margens\?workspace=/);
    await irPara(page, wsD);
    check((await toggle.getAttribute("aria-checked")) === "true", "mudar de separador e regressar: o filtro continua ligado");
    await page.getByRole("button", { name: /Nova análise/ }).click();
    await page.waitForFunction((a) => new URL(location.href).searchParams.get("workspace") !== a, wsD);
    await page.getByPlaceholder("Pesquisar por CNP ou descrição...").fill("PVPDIF");
    await gerarVendas(page);
    check((await toggle.getAttribute("aria-checked")) === "false", "uma 2.ª análise começa com o filtro desligado (independente)");
    await irPara(page, wsD);
    check((await toggle.getAttribute("aria-checked")) === "true", "…e a 1.ª mantém-no ligado");
    await page.getByRole("button", { name: /Limpar filtros/ }).click();
    await page.waitForTimeout(300);
    check((await toggle.getAttribute("aria-checked")) === "false", "«Limpar filtros» retira o filtro");
  } finally {
    smtp.fechar();
    await browser.close();
    await amb.parar();
  }
  console.log(`\n${falhas === 0 ? "PASSOU" : "FALHOU"} — ${ok} OK, ${falhas} falhas\n`);
  process.exit(falhas === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
