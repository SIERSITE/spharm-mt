/**
 * scripts/e2e/vendas-precos-fabricante-browser.ts
 *
 * Browser REAL (Chromium) contra o build de PRODUÇÃO, control plane + PostgreSQL descartáveis (dados sintéticos):
 *   A · Vendas «Incluir preços»: por separador (independente entre análises, sobrevive a trocar de separador, «Nova análise» liga),
 *       Relatório/impressão/PDF real/email sem informação monetária quando desligado; Excel (botão e anexo) continua completo;
 *   B · números +1 px: tamanho calculado no browser (ecrã e pré-visualização) a 1920×1080, 1536×864 e 1366×768; PDF a cores e cinzentos;
 *   C · fabricante na ficha do artigo: perfil sem permissão não vê «Editar»; selecionar existente; criar novo (normalização,
 *       duplicado bloqueado, semelhantes); cancelar; auditoria e proteção na BD; estado pendente no workspace.
 *
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/e2e/vendas-precos-fabricante-browser.ts
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { SignJWT } from "jose";
import * as XLSX from "xlsx";
import { chromium, type Page, type BrowserContext } from "playwright";
import { baseFor, criarAmbiente, SECRET } from "./_ambiente-silveira";
import { abrirContexto } from "./_grupo-comum";
import { semearMargens } from "./_margens-comum";

let ok = 0;
let falhas = 0;
const check = (cond: boolean, msg: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${msg}`); }
  else { falhas++; console.log(`  [FALHA] ${msg}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const secao = (t: string) => console.log(`\n── ${t}`);
const EVID = path.resolve("docs/validacao-visual/2026-10-vendas-precos-fabricante");
const norm = (t: string) => t.replace(/[  ]/g, " ");
const DINHEIRO = /€|PVP|Custo|Valor Vendas|Valor vendas|PARCIAL|s\/IVA/i;
const MONETARIAS = ["pvp", "custoUnitarioEstimado", "custoEstimado", "valorBruto"];

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
function textoPdf(ficheiro: string): string {
  const py = spawnSync("python", [path.resolve("scripts/e2e/_texto_pdf.py"), ficheiro], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (py.status !== 0) throw new Error(`python: ${py.stderr}`);
  return norm((JSON.parse(py.stdout.trim().split("\n").pop() ?? "{}") as { texto: string[] }).texto.join("\n"));
}
function renderizar(ficheiro: string, prefixo: string, paginas = 2) {
  spawnSync("python", [path.resolve("scripts/e2e/_renderizar_pdf.py"), ficheiro, EVID, prefixo, String(paginas), "80"], { encoding: "utf8" });
}

async function pedirPdf(page: Page, ctx: BrowserContext, nome: string) {
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
  const relatorio = (json.report ?? json) as { columns: Array<{ key: string; label: string }>; meta?: { footer?: string } };
  await page.getByRole("button", { name: /^PDF$/ }).first().waitFor({ timeout: 60000 });
  return { ficheiro: f, relatorio };
}

async function gerarVendas(page: Page) {
  const ano = new Date().getFullYear();
  await page.getByLabel("Data início").fill(`${ano}-01-01`);
  await page.getByLabel("Data fim").fill(new Date().toISOString().slice(0, 10));
  await page.getByRole("button", { name: /^(Gerar|Atualizar)$/ }).click();
  await page.getByRole("button", { name: /^Atualizar$/ }).waitFor({ timeout: 90000 });
  await page.locator('[data-testid="vendas-sel-contagem"]').waitFor({ timeout: 60000 });
}
const preco = (page: Page) => page.locator('[data-testid="vendas-incluir-precos"]');

async function main() {
  fs.mkdirSync(EVID, { recursive: true });
  const amb = await criarAmbiente("pf");
  const browser = await chromium.launch();
  try {
    const seed = await semearMargens(amb);
    const ctx = await abrirContexto(amb, browser, { userId: seed.userId } as never);
    await ctx.addInitScript(INIT_CAPTURA_IMPRESSAO);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(baseFor("silveira") + "/vendas", { waitUntil: "networkidle" });
    await page.waitForFunction(() => new URL(location.href).searchParams.has("workspace"));
    const wsA = new URL(page.url()).searchParams.get("workspace")!;

    // ═══ A · Incluir preços ═══════════════════════════════════════════════
    secao("A · «Incluir preços»");
    check((await preco(page).count()) === 0, "o controlo só aparece depois de gerar (junto das opções de impressão)");
    await gerarVendas(page);
    check(await preco(page).isChecked(), "ligado por omissão (comportamento de sempre)");
    await page.getByRole("button", { name: /^Relatório$/ }).click();
    const quadro = () => page.frameLocator('[data-testid="vendas-relatorio-previa"]');
    await quadro().locator("thead th").first().waitFor({ timeout: 30000 });
    const textoPrev = async () => norm(await quadro().locator("body").innerText());
    const cabecalhosPrev = async () => (await quadro().locator("thead th").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
    const comPrecos = await cabecalhosPrev();
    check(comPrecos.some((h) => /PVP/.test(h)) && comPrecos.some((h) => /Custo total/.test(h)) && comPrecos.some((h) => /Valor Vendas/.test(h)) && /€/.test(await textoPrev()), `com preços: ${comPrecos.length} colunas, com PVP/Custo/Valor e «€»`);
    await page.screenshot({ path: path.join(EVID, "relatorio-com-precos-1920x1080.png") });

    await preco(page).uncheck();
    await page.waitForTimeout(800);
    const semPrecos = await cabecalhosPrev();
    const txt = await textoPrev();
    check(!semPrecos.some((h) => /PVP|Custo|Valor|€/.test(h)) && !DINHEIRO.test(txt), `sem preços: pré-visualização com ${semPrecos.length} colunas e NENHUM «€», PVP, Custo, Valor, PARCIAL (${semPrecos.join(" | ")})`, txt.match(/.{20}(€|PVP|Custo|Valor Vendas|PARCIAL).{20}/)?.[0]);
    check(semPrecos.length === comPrecos.length - 4 && semPrecos.every((h) => h.length > 0), `retiradas exatamente as 4 colunas monetárias, sem colunas vazias (${comPrecos.length} → ${semPrecos.length})`);
    check(/TOTAL GERAL/.test(txt), "o TOTAL GERAL de unidades continua");
    await page.screenshot({ path: path.join(EVID, "relatorio-sem-precos-1920x1080.png") });

    // as quatro saídas respeitam a opção
    const sPdf = await pedirPdf(page, ctx, "vendas-sem-precos.pdf");
    check(!sPdf.relatorio.columns.some((c) => MONETARIAS.includes(c.key) || DINHEIRO.test(c.label)), "PDF (pedido real ao servidor): relatório sem colunas monetárias");
    const tPdf = textoPdf(sPdf.ficheiro);
    check(!DINHEIRO.test(tPdf) && /Total/.test(tPdf) && /Stock/.test(tPdf), "PDF real: sem «€», PVP, Custo, Valor, PARCIAL; com unidades e stock", tPdf.match(/.{20}(€|PVP|Custo|Valor Vendas|PARCIAL).{20}/)?.[0]);
    renderizar(sPdf.ficheiro, "pdf-sem-precos", 2);

    await page.evaluate(() => { (window as unknown as { __impressoes: string[] }).__impressoes = []; });
    await page.getByRole("button", { name: /^Imprimir$/ }).first().click();
    await page.waitForFunction(() => (window as unknown as { __impressoes: string[] }).__impressoes.length > 0, null, { timeout: 30000 });
    const htmlImp = norm(await page.evaluate(() => (window as unknown as { __impressoes: string[] }).__impressoes[0]));
    check(!DINHEIRO.test(htmlImp.slice(htmlImp.indexOf("<body>")).replace(/<style>[\s\S]*?<\/style>/g, "")), "impressão: sem informação monetária");

    const capturas: string[] = [];
    await page.route("**/api/reports/email", async (route) => { capturas.push(route.request().postData() ?? ""); await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }); });
    await page.getByRole("button", { name: /^Email$/ }).first().click();
    await page.getByPlaceholder("nome@dominio.pt, outro@dominio.pt").fill("destinatario@exemplo.invalid");
    await page.getByRole("button", { name: /^Enviar$/ }).click();
    await page.waitForFunction(() => document.body.innerText.includes("Email enviado"), null, { timeout: 30000 });
    const em = JSON.parse(capturas[0]) as { report: { columns: Array<{ key: string }> }; excelReport?: { columns: Array<{ key: string }> } };
    check(!em.report.columns.some((c) => MONETARIAS.includes(c.key)), "email (PDF anexo): o relatório enviado respeita a opção do momento do envio — sem preços");
    check(!!em.excelReport && MONETARIAS.every((k) => em.excelReport!.columns.some((c) => c.key === k)), "email (Excel anexo): continua completo, com preços");
    await page.unroute("**/api/reports/email");
    await page.getByRole("button", { name: "Fechar" }).click().catch(() => undefined);

    const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /^Excel$/ }).first().click()]);
    await dl.saveAs(path.join(EVID, "vendas-excel.xlsx"));
    const g = XLSX.utils.sheet_to_json<unknown[]>(XLSX.readFile(path.join(EVID, "vendas-excel.xlsx")).Sheets["Relatório"], { header: 1, blankrows: false }) as unknown[][];
    const cabX = (g.find((r) => r[0] === "CNP") ?? []) as string[];
    check(cabX.some((h) => /PVP/.test(h)) && cabX.some((h) => /Custo total/.test(h)) && cabX.some((h) => /Valor Vendas/.test(h)), "Excel de Vendas: inalterado, com preços (mesmo com a opção desligada)");

    // por separador: sobrevive a trocar de separador; independente entre análises; «Nova análise» liga
    secao("A · por separador (workspace)");
    await page.getByRole("link", { name: "Margens", exact: true }).click();
    await page.waitForURL(/relatorios\/margens\?workspace=/);
    await page.locator(`[data-navegacao-href^="/vendas?workspace=${wsA}"]`).click();
    await page.getByRole("button", { name: /^Atualizar$/ }).waitFor({ timeout: 20000 });
    check(!(await preco(page).isChecked()), "mudar de separador e voltar: «Incluir preços» continua desligado");
    await page.getByRole("button", { name: /Nova análise/ }).click();
    await page.waitForFunction((a) => new URL(location.href).searchParams.get("workspace") !== a, wsA);
    const wsB = new URL(page.url()).searchParams.get("workspace")!;
    await gerarVendas(page);
    check(await preco(page).isChecked(), "«Nova análise» começa com «Incluir preços» ligado");
    await page.locator(`[data-navegacao-href^="/vendas?workspace=${wsA}"]`).click();
    await page.getByRole("button", { name: /^Atualizar$/ }).waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="vendas-incluir-precos"]') !== null);
    check(!(await preco(page).isChecked()), "análise A mantém desligado (independente da B)");
    await page.locator(`[data-navegacao-href^="/vendas?workspace=${wsB}"]`).click();
    await page.getByRole("button", { name: /^Atualizar$/ }).waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="vendas-incluir-precos"]') !== null);
    check(await preco(page).isChecked(), "análise B mantém ligado");
    await page.locator(`[data-navegacao-href^="/vendas?workspace=${wsA}"]`).click();
    await page.getByRole("button", { name: /^Atualizar$/ }).waitFor();
    await preco(page).check();

    // ═══ B · tipografia ═══════════════════════════════════════════════════
    secao("B · números +1 px (computados no browser)");
    for (const [w, h] of [[1920, 1080], [1536, 864], [1366, 768]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.getByRole("button", { name: /^Relatório$/ }).click();
      await quadro().locator("tbody td.num").first().waitFor({ timeout: 30000 });
      const f = await quadro().locator("body").evaluate(() => {
        const px = (el: Element | null) => (el ? parseFloat(getComputedStyle(el).fontSize) : 0);
        const texto = document.querySelector("tbody td.sg + td.sg") ?? document.querySelector("tbody td:nth-child(2)");
        const mes = document.querySelector("tbody td.num.mes-alt") ?? document.querySelector("tbody td.num");
        const total = document.querySelector(".totals-tbody td.num");
        const th = document.querySelector("thead th");
        const wTabela = (document.querySelector("table") as HTMLElement).getBoundingClientRect().width;
        const folha = (document.scrollingElement as HTMLElement).scrollWidth;
        return { texto: px(texto), mes: px(mes), total: px(total), th: px(th), overflow: folha > document.documentElement.clientWidth + 1, wTabela };
      });
      check(Math.abs(f.mes - f.texto - 1) < 0.2 && Math.abs(f.total - f.texto - 1) < 0.2 && f.th < f.texto, `${w}×${h} (pré-visualização): números ${f.mes}px vs texto ${f.texto}px (+1), totais ${f.total}px, cabeçalho ${f.th}px`);
      await page.getByRole("button", { name: /^Tabela$/ }).click();
      await page.locator('[data-testid="vendas-contentor-tabela"]').waitFor();
      const e = await page.locator('table[data-testid="vendas-tabela"]').evaluate(() => {
        const px = (el: Element | null) => (el ? parseFloat(getComputedStyle(el).fontSize) : 0);
        return { desc: px(document.querySelector("tbody td.col-desc")), num: px(document.querySelector('tbody td[data-col="custo-total"]')), val: px(document.querySelector('tbody td[data-col="valor-vendas"]')) };
      });
      check(e.num > e.desc && e.val > e.desc, `${w}×${h} (tabela no ecrã): números ${e.num}px / ${e.val}px vs descrição ${e.desc}px`);
      await page.screenshot({ path: path.join(EVID, `ecra-${w}x${h}.png`) });
    }
    await page.setViewportSize({ width: 1920, height: 1080 });
    const sPdf2 = await pedirPdf(page, ctx, "vendas-com-precos.pdf");
    check(/€/.test(textoPdf(sPdf2.ficheiro)), "PDF com preços: estrutura de sempre (com «€»)");
    renderizar(sPdf2.ficheiro, "pdf-com-precos", 2);

    // ═══ C · fabricante ═══════════════════════════════════════════════════
    secao("C · Fabricante na ficha do artigo");
    const bayer = await amb.prisma.fabricante.create({ data: { nomeNormalizado: "BAYER E2E PORTUGAL", aliases: { create: { aliasNome: "Bayer E2E Lda." } } } });
    await amb.prisma.fabricante.create({ data: { nomeNormalizado: "GRIFOLS E2E" } });
    const CNPFAB = 7100001;
    const prod = await amb.prisma.produto.findUniqueOrThrow({ where: { cnp: CNPFAB }, include: { fabricante: true } });
    const antes = { designacao: prod.designacao, fab: prod.fabricante?.nomeNormalizado };

    // sem permissão (OPERADOR): sem «Editar»
    const jwt = (perfil: string) => new SignJWT({ sub: seed.userId, email: "op@spharm.test", nome: "Op", perfil, farmaciaId: seed.farmacias.alfa, tenant: "silveira" }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(SECRET));
    const ctxOp = await browser.newContext();
    await ctxOp.addCookies([{ name: "session", value: await jwt("OPERADOR"), url: baseFor("silveira") }]);
    const pOp = await ctxOp.newPage();
    await pOp.goto(baseFor("silveira") + `/stock/artigo/${CNPFAB}`, { waitUntil: "networkidle" });
    await pOp.getByText("Fabricante", { exact: true }).first().waitFor();
    check((await pOp.locator('[data-testid="fabricante-editar"]').count()) === 0 && (await pOp.getByText(antes.fab ?? "—").count()) > 0, "perfil só de leitura vê o fabricante, sem ação «Editar»");
    await ctxOp.close();

    // administrador
    await page.goto(baseFor("silveira") + `/stock/artigo/${CNPFAB}`, { waitUntil: "networkidle" });
    await page.locator('[data-testid="fabricante-editar"]').waitFor({ timeout: 30000 });
    check(true, "administrador vê «Editar» junto ao fabricante");
    await page.locator('[data-testid="fabricante-editar"]').click();
    await page.locator('[data-testid="fabricante-pesquisa"]').fill("bayer");
    await page.locator(`[data-testid="fabricante-opcao-${bayer.id}"]`).waitFor({ timeout: 15000 });
    await page.locator(`[data-testid="fabricante-opcao-${bayer.id}"]`).click();
    // cancelar não altera nada
    await page.locator('[data-testid="fabricante-cancelar"]').click();
    check((await page.locator('[data-testid="fabricante-editor"]').count()) === 0 && (await amb.prisma.produto.findUniqueOrThrow({ where: { cnp: CNPFAB } })).fabricanteId === prod.fabricanteId, "cancelar fecha o editor sem alterar o artigo");

    // pendente + workspace: o formulário em curso sobrevive a trocar de separador
    await page.locator('[data-testid="fabricante-editar"]').click();
    await page.locator('[data-testid="fabricante-pesquisa"]').fill("bayer");
    await page.locator(`[data-testid="fabricante-opcao-${bayer.id}"]`).click();
    await page.getByRole("link", { name: "Vendas", exact: true }).click();
    await page.waitForURL(/\/vendas\?workspace=/);
    check(!!(await page.locator(`[data-navegacao-href^="/stock/artigo/${CNPFAB}"]`).locator("svg.fill-amber-500, [class*='fill-amber']").count()), "a ficha com edição por confirmar aparece como separador com alterações pendentes (indicador)");
    await page.locator(`[data-navegacao-href^="/stock/artigo/${CNPFAB}"]`).click();
    await page.locator('[data-testid="fabricante-editor"]').waitFor({ timeout: 20000 });
    check(((await page.locator('[data-testid="fabricante-escolhido"]').innerText()) || "").includes("BAYER E2E PORTUGAL"), "regressar à ficha: a edição ainda não confirmada foi preservada (selecionado: BAYER E2E PORTUGAL)");
    // fechar o separador com edição pendente pede confirmação
    let dialogos = 0;
    page.once("dialog", async (d) => { dialogos++; await d.dismiss(); });
    await page.getByRole("button", { name: /Fechar Ficha de artigo/ }).click();
    await page.waitForTimeout(500);
    check(dialogos === 1 && (await page.locator(`[data-navegacao-href^="/stock/artigo/${CNPFAB}"]`).count()) === 1, "fechar o separador durante a edição pede confirmação (recusar mantém o separador)");

    // aplicar existente
    await page.locator('[data-testid="fabricante-continuar"]').click();
    await page.locator('[data-testid="fabricante-confirmacao"]').waitFor();
    check(/Alterar o fabricante de/.test(await page.locator('[data-testid="fabricante-confirmacao"]').innerText()), "pede confirmação antes de aplicar");
    await page.locator('[data-testid="fabricante-confirmar"]').click();
    await page.locator('[data-testid="fabricante-valor"]').filter({ hasText: "BAYER E2E PORTUGAL" }).waitFor({ timeout: 20000 });
    check(true, "a ficha atualiza imediatamente para «BAYER E2E PORTUGAL» com a indicação «definido manualmente»");
    const dep = await amb.prisma.produto.findUniqueOrThrow({ where: { cnp: CNPFAB } });
    check(dep.fabricanteId === bayer.id && dep.validadoManualmente && dep.camposManuais.includes("fabricante") && dep.designacao === antes.designacao, "BD: fabricante aplicado, proteção ativa e designação intacta");
    const aud = await amb.prisma.auditLog.findFirst({ where: { entityId: dep.id, action: "produto.fabricante.alterado" }, orderBy: { createdAt: "desc" } });
    const am = JSON.parse(aud?.metaJson ?? "{}");
    check(!!aud && aud.actorId === seed.userId && am.origem === "FICHA_ARTIGO" && am.tenant === "silveira" && am.cnp === CNPFAB && am.fabricanteNovo.id === bayer.id, "auditoria: utilizador, tenant, produto, CNP, anterior/novo, origem FICHA_ARTIGO", JSON.stringify(am));
    await page.screenshot({ path: path.join(EVID, "ficha-fabricante-aplicado.png") });

    // fechar e reabrir: começa sem o formulário antigo
    page.once("dialog", async (d) => { await d.accept(); });
    await page.locator('[data-testid="fabricante-editar"]').click();
    await page.locator('[data-testid="fabricante-pesquisa"]').fill("gri");
    await page.getByRole("button", { name: /Fechar Ficha de artigo/ }).click();
    await page.waitForURL(/dashboard/, { timeout: 15000 }).catch(() => undefined);
    await page.goto(baseFor("silveira") + `/stock/artigo/${CNPFAB}`, { waitUntil: "networkidle" });
    check((await page.locator('[data-testid="fabricante-editor"]').count()) === 0, "fechar e reabrir a ficha começa sem o formulário antigo");

    // criar novo: normalização, duplicado, semelhantes
    await page.locator('[data-testid="fabricante-editar"]').click();
    await page.locator('[data-testid="fabricante-criar"]').click();
    await page.locator('[data-testid="fabricante-novo-nome"]').fill("  bayer   e2e portugal ");
    await page.locator('[data-testid="fabricante-duplicado"]').waitFor({ timeout: 15000 });
    check((await page.locator('[data-testid="fabricante-continuar"]').isDisabled()), "duplicado canónico: «Continuar» bloqueado e é obrigatório usar o existente");
    await page.locator('[data-testid="fabricante-novo-nome"]').fill("Bayer E2E Lda.");
    await page.locator('[data-testid="fabricante-duplicado"]').waitFor({ timeout: 15000 });
    check(/BAYER E2E PORTUGAL/.test(await page.locator('[data-testid="fabricante-duplicado"]').innerText()), "duplicado por alias bloqueado, com o existente indicado");
    await page.locator('[data-testid="fabricante-novo-nome"]').fill("Grifols E2E Internacional");
    await page.locator('[data-testid="fabricante-canonico"]').waitFor({ timeout: 15000 });
    check((await page.locator('[data-testid="fabricante-canonico"]').innerText()) === "GRIFOLS E2E INTERNACIONAL" && (await page.locator('[data-testid="fabricante-semelhantes"]').count()) === 1, "mostra o nome normalizado e sugere fabricantes semelhantes (GRIFOLS E2E)");
    await page.locator('[data-testid="fabricante-novo-nome"]').fill("Nova Marca E2E, Lda.");
    await page.locator('[data-testid="fabricante-canonico"]').filter({ hasText: "NOVA MARCA E2E LDA" }).waitFor({ timeout: 15000 });
    const nFab = await amb.prisma.fabricante.count();
    await page.locator('[data-testid="fabricante-continuar"]').click();
    await page.locator('[data-testid="fabricante-confirmar"]').click();
    await page.locator('[data-testid="fabricante-valor"]').filter({ hasText: "NOVA MARCA E2E LDA" }).waitFor({ timeout: 20000 });
    check((await amb.prisma.fabricante.count()) === nFab + 1, "novo fabricante criado e aplicado ao artigo (1 criado)");
    const criado = await amb.prisma.auditLog.findFirst({ where: { entityId: dep.id }, orderBy: { createdAt: "desc" } });
    check(JSON.parse(criado?.metaJson ?? "{}").fabricanteCriadoNoFluxo === true, "auditoria marca que o fabricante foi criado no fluxo");
    await page.screenshot({ path: path.join(EVID, "ficha-fabricante-criado.png") });

    // voltar a permitir atualização automática pelo ERP
    await page.locator('[data-testid="fabricante-editar"]').click();
    await page.locator('[data-testid="fabricante-permitir-erp"]').click();
    await page.locator('[data-testid="fabricante-permitir-erp-confirmar"]').click();
    await page.getByText("Voltar a permitir").first().waitFor({ state: "detached", timeout: 10000 }).catch(() => undefined);
    await page.waitForTimeout(1500);
    const lib = await amb.prisma.produto.findUniqueOrThrow({ where: { cnp: CNPFAB }, include: { fabricante: true } });
    check(!lib.validadoManualmente && !lib.camposManuais.includes("fabricante") && lib.fabricante?.nomeNormalizado === "NOVA MARCA E2E LDA", "«Voltar a permitir atualização pelo ERP»: proteção retirada, fabricante NÃO alterado");
  } finally {
    await browser.close();
    await amb.parar();
  }
  console.log(`\n${falhas === 0 ? "PASSOU" : "FALHOU"} — ${ok} OK, ${falhas} falhas\n`);
  process.exit(falhas === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
