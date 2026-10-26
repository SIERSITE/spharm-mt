/**
 * scripts/e2e/ficha-artigo-editores-browser.ts
 *
 * Browser REAL (Chromium) contra o build de PRODUÇÃO, control plane + PostgreSQL descartáveis (dados sintéticos):
 * edição de FABRICANTE e de DESIGNAÇÃO na ficha do artigo.
 *   F · fabricante: sem permissão não vê «Editar»; selecionar existente; cancelar; pendente no workspace; criar novo (normalização,
 *       duplicados, semelhantes); auditoria; proteção contra o sync; «Voltar a permitir» (não altera o fabricante);
 *   D · designação: sem permissão; editar/cancelar/validar (vazio, espaços, curto, longo, igual); confirmação com o aviso de grupo;
 *       atualização imediata; a mesma ação na ficha do Catálogo e em fichas abertas a partir de Vendas; reflexo em Vendas/Relatório/PDF/
 *       Excel; auditoria; proteção contra o sync (e a Silveirense); «Voltar a permitir» só da designação; pendente/preservado/limpo no
 *       workspace; independência fabricante ↔ designação.
 *
 * Pré-requisito: `npx next build` com SERVER_ACTIONS_ALLOWED_ORIGINS="localhost:3100,127.0.0.1:3100,*.localhost:3100".
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/e2e/ficha-artigo-editores-browser.ts
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
const EVID = path.resolve("docs/validacao-visual/2026-10-ficha-fabricante-designacao");
const norm = (t: string) => t.replace(/[  ]/g, " ").replace(/\s+/g, " ");

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
  const r = spawnSync("python", [path.resolve(`scripts/e2e/${script}`), ...args], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`python ${script}: ${r.stderr}`);
  return r.stdout.trim().split("\n").pop() ?? "{}";
}
const textoPdf = (f: string) => norm((JSON.parse(py("_texto_pdf.py", f)) as { texto: string[] }).texto.join("\n"));

async function main() {
  fs.mkdirSync(EVID, { recursive: true });
  const amb = await criarAmbiente("ed");
  const browser = await chromium.launch();
  try {
    const seed = await semearMargens(amb);
    const prisma = amb.prisma;
    const { bulkUpsertProdutosByCnp } = await import("../../lib/ingest/bulk");
    const { upsertProdutosComDesignacao } = await import("../../lib/ingest/designacao-silveira");
    const bayer = await prisma.fabricante.create({ data: { nomeNormalizado: "BAYER E2E PORTUGAL", aliases: { create: { aliasNome: "Bayer E2E Lda." } } } });
    await prisma.fabricante.create({ data: { nomeNormalizado: "GRIFOLS E2E" } });
    const CNPF = 7100001; // fabricante
    const CNPD = 7100002; // designação
    await prisma.produto.update({ where: { cnp: CNPD }, data: { designacao: "ARTIGO COM GRALHA DESIGANCAO E2E" } });
    const prodF = await prisma.produto.findUniqueOrThrow({ where: { cnp: CNPF }, include: { fabricante: true } });
    const prodD0 = await prisma.produto.findUniqueOrThrow({ where: { cnp: CNPD } });

    const ctx = await abrirContexto(amb, browser, { userId: seed.userId } as never);
    await ctx.addInitScript("window.__name = (f) => f;");
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
    await page.setViewportSize({ width: 1920, height: 1080 });
    const jwt = (perfil: string) => new SignJWT({ sub: seed.userId, email: "op@spharm.test", nome: "Op", perfil, farmaciaId: seed.farmacias.alfa, tenant: "silveira" }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(SECRET));
    const fechar = (p: Page, cnp = CNPD) => p.locator(`[data-navegacao-href^="/stock/artigo/${cnp}"] [aria-label^="Fechar"]`).first();

    // ═══ sem permissão ═══════════════════════════════════════════════════════════════════════════════════════════════
    secao("Sem permissão: só leitura");
    const ctxOp = await browser.newContext();
    await ctxOp.addCookies([{ name: "session", value: await jwt("OPERADOR"), url: baseFor("silveira") }]);
    const pOp = await ctxOp.newPage();
    for (const url of [`/stock/artigo/${CNPD}`, `/catalogo/artigo/${CNPD}`]) {
      await pOp.goto(baseFor("silveira") + url, { waitUntil: "networkidle" });
      await pOp.getByText("ARTIGO COM GRALHA DESIGANCAO E2E").first().waitFor();
      check((await pOp.locator('[data-testid="designacao-editar"]').count()) === 0 && (await pOp.locator('[data-testid="fabricante-editar"]').count()) === 0, `perfil só de leitura (${url.split("/")[1]}): vê a designação e o fabricante, sem «Editar»`);
    }
    // a ação do servidor também recusa (não depende de esconder o botão)
    await ctxOp.close();

    // ═══ DESIGNAÇÃO ═══════════════════════════════════════════════════════════════════════════════════════════════════
    secao("D · Editar a designação na ficha do Stock");
    await page.goto(baseFor("silveira") + `/stock/artigo/${CNPD}`, { waitUntil: "networkidle" });
    await page.locator('[data-testid="designacao-editar"]').waitFor({ timeout: 30000 });
    check(norm(await page.locator('[data-testid="designacao-valor"]').innerText()) === "ARTIGO COM GRALHA DESIGANCAO E2E" && (await page.locator('[data-testid="designacao-manual"]').count()) === 0, "administrador vê «Editar designação»; a designação não está marcada como manual");
    await page.screenshot({ path: path.join(EVID, "designacao-ficha-antes.png") });
    await page.locator('[data-testid="designacao-editar"]').click();
    check((await page.locator('[data-testid="designacao-input"]').inputValue()) === "ARTIGO COM GRALHA DESIGANCAO E2E", "o editor abre com o valor atual");
    // cancelar
    await page.locator('[data-testid="designacao-input"]').fill("Texto que vai ser cancelado");
    await page.locator('[data-testid="designacao-cancelar"]').click();
    check((await page.locator('[data-testid="designacao-editor"]').count()) === 0 && (await prisma.produto.findUniqueOrThrow({ where: { cnp: CNPD } })).designacao === prodD0.designacao, "cancelar fecha o editor sem alterar nada");
    // validação
    await page.locator('[data-testid="designacao-editar"]').click();
    await page.locator('[data-testid="designacao-input"]').fill("");
    check(await page.locator('[data-testid="designacao-continuar"]').isDisabled(), "vazia: «Continuar» desativado");
    await page.locator('[data-testid="designacao-input"]').fill("     ");
    check(await page.locator('[data-testid="designacao-continuar"]').isDisabled(), "só espaços: «Continuar» desativado");
    await page.locator('[data-testid="designacao-input"]').fill("ab");
    await page.locator('[data-testid="designacao-continuar"]').click();
    check(/pelo menos 3 caracteres/.test(await page.locator('[data-testid="designacao-mensagem"]').innerText()), "curta: mensagem de validação");
    await page.locator('[data-testid="designacao-input"]').fill("x".repeat(301));
    await page.locator('[data-testid="designacao-continuar"]').click();
    check(/mais de 300 caracteres/.test(await page.locator('[data-testid="designacao-mensagem"]').innerText()), "acima do limite (300): mensagem de validação");
    await page.locator('[data-testid="designacao-input"]').fill("  ARTIGO   COM GRALHA DESIGANCAO E2E ");
    await page.locator('[data-testid="designacao-continuar"]').click();
    check(/igual à atual/.test(await page.locator('[data-testid="designacao-mensagem"]').innerText()) && (await page.locator('[data-testid="designacao-confirmacao"]').count()) === 0, "igual à atual (depois de normalizar espaços): nada a alterar, sem confirmação");
    // pendente no workspace
    await page.locator('[data-testid="designacao-input"]').fill("Artigo Corrigido Designação E2E (á é ç)");
    await page.locator('[data-testid="designacao-continuar"]').click();
    await page.locator('[data-testid="designacao-confirmacao"]').waitFor();
    const conf = norm(await page.locator('[data-testid="designacao-confirmacao"]').innerText());
    check(conf.includes("Esta designação será utilizada no SPharm.MT para este artigo em todas as farmácias deste grupo."), "a confirmação mostra o aviso de que vale para todas as farmácias do grupo");
    await page.screenshot({ path: path.join(EVID, "designacao-confirmacao.png") });
    // preservar ao mudar de separador (edição por confirmar = pendente)
    await page.getByRole("link", { name: "Vendas", exact: true }).click();
    await page.waitForURL(/\/vendas\?workspace=/);
    check((await page.locator(`[data-navegacao-href^="/stock/artigo/${CNPD}"]`).locator("[class*='fill-amber']").count()) > 0, "a ficha com a designação por confirmar aparece com alterações pendentes (indicador no separador)");
    await page.locator(`[data-navegacao-href^="/stock/artigo/${CNPD}"]`).click();
    await page.locator('[data-testid="designacao-confirmacao"]').waitFor({ timeout: 20000 });
    check(true, "regressar à ficha: o passo de confirmação foi preservado");
    let dialogos = 0;
    await page.waitForTimeout(600);
    console.log("  [dbg] storage:", await page.evaluate(() => JSON.stringify(Object.fromEntries(Object.keys(localStorage).concat(Object.keys(sessionStorage)).map((k) => [k, (localStorage.getItem(k) ?? sessionStorage.getItem(k) ?? "").slice(0, 700)])))));
    console.log("  [dbg] indicador pendente no separador ativo:", await page.locator(`[data-navegacao-href^="/stock/artigo/${CNPD}"]`).locator("[class*='fill-amber']").count());
    page.once("dialog", async (d) => { dialogos++; await d.dismiss(); });
    await fechar(page).click({ force: true });
    await page.waitForTimeout(500);
    check(dialogos === 1 && (await page.locator(`[data-navegacao-href^="/stock/artigo/${CNPD}"]`).count()) === 1, "fechar o separador com a edição por confirmar pede confirmação (recusar mantém o separador)", `dialogos=${dialogos} abas=${await page.locator(`[data-navegacao-href^="/stock/artigo/${CNPD}"]`).count()} url=${page.url()}`);
    // aplicar
    await page.locator('[data-testid="designacao-confirmar"]').click();
    await page.locator('[data-testid="designacao-valor"]').filter({ hasText: "Artigo Corrigido Designação E2E (á é ç)" }).waitFor({ timeout: 20000 });
    check(await page.locator('[data-testid="designacao-manual"]').isVisible(), "a ficha atualiza de imediato e mostra «corrigida manualmente»");
    const dB = await prisma.produto.findUniqueOrThrow({ where: { cnp: CNPD } });
    check(dB.designacao === "Artigo Corrigido Designação E2E (á é ç)" && dB.camposManuais.includes("designacao") && dB.fabricanteId === prodD0.fabricanteId && dB.validadoManualmente === prodD0.validadoManualmente && dB.cnp === CNPD, "BD: designação com acentos/maiúsculas preservados, proteção ativa, fabricante e CNP intactos");
    const aud = await prisma.auditLog.findFirst({ where: { entityId: dB.id, action: "produto.designacao.alterada" }, orderBy: { createdAt: "desc" } });
    const am = JSON.parse(aud?.metaJson ?? "{}");
    check(!!aud && aud.actorId === seed.userId && am.origem === "FICHA_ARTIGO" && am.tenant === "silveira" && am.cnp === CNPD && am.designacaoAnterior === prodD0.designacao && am.designacaoNova === dB.designacao && am.protecaoDesignacao.antes === false && am.protecaoDesignacao.depois === true, "auditoria: utilizador, tenant, produto, CNP, anterior, nova, proteção antes/depois, origem", JSON.stringify(am));
    await page.screenshot({ path: path.join(EVID, "designacao-aplicada.png") });
    // fechar e reabrir: começa limpo
    await fechar(page).click({ force: true });
    await page.goto(baseFor("silveira") + `/stock/artigo/${CNPD}`, { waitUntil: "networkidle" });
    check((await page.locator('[data-testid="designacao-editor"]').count()) === 0, "fechar e reabrir a ficha começa sem o formulário antigo");

    secao("D · Proteção contra a sincronização (incluindo a Silveirense)");
    const NOVO = "Artigo Corrigido Designação E2E (á é ç)";
    await bulkUpsertProdutosByCnp(prisma, [{ cnp: CNPD, externalProductId: null, designacao: "NOME DO ERP QUE VOLTA", flagGenerico: false, flagMnsrmNCompart: false }]);
    await upsertProdutosComDesignacao(prisma, "AUTORITATIVA", [{ cnp: CNPD, externalProductId: null, designacao: "NOME DA SILVEIRENSE", flagGenerico: false, flagMnsrmNCompart: false }]);
    await page.reload({ waitUntil: "networkidle" });
    check(norm(await page.locator('[data-testid="designacao-valor"]').innerText()) === NOVO, "depois de sincronizações simuladas (lote e Silveirense), a ficha mostra a designação corrigida");

    secao("D · A mesma ação na ficha do Catálogo; reflexo em Vendas, Relatório, PDF e Excel");
    await page.goto(baseFor("silveira") + `/catalogo/artigo/${CNPD}`, { waitUntil: "networkidle" });
    await page.locator('[data-testid="designacao-editar"]').waitFor({ timeout: 30000 });
    check((await page.locator('h1[data-testid="designacao-valor"]').count()) === 1 && await page.locator('[data-testid="designacao-manual"]').isVisible(), "ficha do Catálogo: «Editar designação» e a indicação de correção manual");
    await page.locator('[data-testid="designacao-editar"]').click();
    await page.locator('[data-testid="designacao-input"]').fill("Artigo Designação Final E2E");
    await page.locator('[data-testid="designacao-continuar"]').click();
    await page.locator('[data-testid="designacao-confirmar"]').click();
    await page.locator('[data-testid="designacao-valor"]').filter({ hasText: "Artigo Designação Final E2E" }).waitFor({ timeout: 20000 });
    check((await prisma.produto.findUniqueOrThrow({ where: { cnp: CNPD } })).designacao === "Artigo Designação Final E2E", "alterada pela ficha do Catálogo");
    await page.screenshot({ path: path.join(EVID, "designacao-catalogo.png") });

    // Vendas: o nome novo na tabela, no Relatório, no PDF e no Excel; e a ficha aberta a partir de Vendas tem o editor
    await page.goto(baseFor("silveira") + "/vendas", { waitUntil: "networkidle" });
    await page.waitForFunction(() => new URL(location.href).searchParams.has("workspace"));
    const ano = new Date().getFullYear();
    await page.getByLabel("Data início").fill(`${ano}-01-01`);
    await page.getByLabel("Data fim").fill(new Date().toISOString().slice(0, 10));
    await page.getByPlaceholder("Pesquisar por CNP ou descrição...").fill(String(CNPD));
    await page.getByRole("button", { name: /^Gerar$/ }).click();
    await page.getByRole("button", { name: /^Atualizar$/ }).waitFor({ timeout: 90000 });
    check((await page.getByText("Artigo Designação Final E2E").count()) > 0, "Vendas: a tabela mostra o nome novo");
    await page.getByRole("button", { name: /^Relatório$/ }).click();
    await page.frameLocator('[data-testid="vendas-relatorio-previa"]').locator("thead th").first().waitFor({ timeout: 30000 });
    check(norm(await page.frameLocator('[data-testid="vendas-relatorio-previa"]').locator("body").innerText()).includes("Artigo Designação Final E2E"), "Vendas: o Relatório mostra o nome novo");
    const [req] = await Promise.all([page.waitForRequest((r) => r.url().includes("/api/reports/pdf"), { timeout: 180000 }), page.getByRole("button", { name: /^PDF$/ }).first().click()]);
    const pdf = await postBinario(new URL(req.url()), req.postDataBuffer()!, (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; "));
    fs.writeFileSync(path.join(EVID, "vendas-designacao.pdf"), pdf);
    check(textoPdf(path.join(EVID, "vendas-designacao.pdf")).includes("Artigo Designação Final E2E"), "Vendas: o PDF real mostra o nome novo");
    const [dl] = await Promise.all([page.waitForEvent("download", { predicate: (d) => d.suggestedFilename().endsWith(".xlsx") }), page.getByRole("button", { name: /^Excel$/ }).first().click()]);
    await dl.saveAs(path.join(EVID, "vendas-designacao.xlsx"));
    check(JSON.stringify(XLSX.utils.sheet_to_json(XLSX.readFile(path.join(EVID, "vendas-designacao.xlsx")).Sheets["Relatório"], { header: 1 })).includes("Artigo Designação Final E2E"), "Vendas: o Excel real mostra o nome novo");
    await page.getByRole("button", { name: /^Tabela$/ }).click();
    await page.locator('[data-testid="vendas-tabela"]').waitFor();
    await page.getByText("Artigo Designação Final E2E").first().click();
    await page.locator('[data-testid="designacao-editar"]').waitFor({ timeout: 30000 });
    check(true, "ficha aberta a partir de Vendas: «Editar designação» disponível (mesma ficha das restantes áreas)");

    secao("D · «Voltar a permitir atualização automática» (só a designação)");
    // protege também o fabricante, para provar que a remoção da designação não lhe toca
    await prisma.produto.update({ where: { cnp: CNPD }, data: { validadoManualmente: true, camposManuais: { push: "fabricante" } } });
    await page.goto(baseFor("silveira") + `/stock/artigo/${CNPD}`, { waitUntil: "networkidle" });
    await page.locator('[data-testid="designacao-editar"]').click();
    await page.locator('[data-testid="designacao-permitir"]').click();
    const pc = norm(await page.locator('[data-testid="designacao-permitir-confirmacao"]').innerText());
    check(/NÃO muda agora/.test(pc) && /a do fabricante e as dos outros campos mantêm-se/.test(pc), "o diálogo explica o efeito: o nome não muda agora; só se retira a proteção da designação");
    await page.locator('[data-testid="designacao-cancelar"]').count();
    await page.locator('[data-testid="designacao-permitir-confirmar"]').click();
    await page.locator('[data-testid="designacao-manual"]').waitFor({ state: "detached", timeout: 20000 });
    const dP = await prisma.produto.findUniqueOrThrow({ where: { cnp: CNPD } });
    check(dP.designacao === "Artigo Designação Final E2E" && !dP.camposManuais.includes("designacao") && dP.camposManuais.includes("fabricante") && dP.validadoManualmente, "BD: nome intacto, proteção da designação retirada; fabricante e validadoManualmente mantêm-se");
    const aP = await prisma.auditLog.findFirst({ where: { entityId: dP.id, action: "produto.designacao.protecao_removida" } });
    check(!!aP && JSON.parse(aP.metaJson ?? "{}").protecaoDesignacao.depois === false, "auditoria própria da remoção da proteção");
    await bulkUpsertProdutosByCnp(prisma, [{ cnp: CNPD, externalProductId: null, designacao: "NOME DO ERP DEPOIS DE PERMITIR", flagGenerico: false, flagMnsrmNCompart: false }]);
    await page.reload({ waitUntil: "networkidle" });
    check(norm(await page.locator('[data-testid="designacao-valor"]').innerText()) === "NOME DO ERP DEPOIS DE PERMITIR", "depois de permitir, a sincronização volta a poder substituir a designação");

    // ═══ FABRICANTE ═══════════════════════════════════════════════════════════════════════════════════════════════════
    secao("F · Fabricante na ficha do artigo");
    const antes = { designacao: prodF.designacao, fab: prodF.fabricante?.nomeNormalizado };
    await page.goto(baseFor("silveira") + `/stock/artigo/${CNPF}`, { waitUntil: "networkidle" });
    await page.locator('[data-testid="fabricante-editar"]').waitFor({ timeout: 30000 });
    check(true, "administrador vê «Editar» junto ao fabricante");
    await page.locator('[data-testid="fabricante-editar"]').click();
    await page.locator('[data-testid="fabricante-pesquisa"]').fill("bayer");
    await page.locator(`[data-testid="fabricante-opcao-${bayer.id}"]`).waitFor({ timeout: 15000 });
    await page.locator(`[data-testid="fabricante-opcao-${bayer.id}"]`).click();
    await page.locator('[data-testid="fabricante-cancelar"]').click();
    check((await page.locator('[data-testid="fabricante-editor"]').count()) === 0 && (await prisma.produto.findUniqueOrThrow({ where: { cnp: CNPF } })).fabricanteId === prodF.fabricanteId, "cancelar fecha o editor sem alterar o artigo");
    await page.locator('[data-testid="fabricante-editar"]').click();
    await page.locator('[data-testid="fabricante-pesquisa"]').fill("bayer");
    await page.locator(`[data-testid="fabricante-opcao-${bayer.id}"]`).click();
    await page.getByRole("link", { name: "Vendas", exact: true }).click();
    await page.waitForURL(/\/vendas\?workspace=/);
    check((await page.locator(`[data-navegacao-href^="/stock/artigo/${CNPF}"]`).locator("[class*='fill-amber']").count()) > 0, "edição do fabricante por confirmar = alterações pendentes (indicador)");
    await page.locator(`[data-navegacao-href^="/stock/artigo/${CNPF}"]`).click();
    await page.locator('[data-testid="fabricante-editor"]').waitFor({ timeout: 20000 });
    check(((await page.locator('[data-testid="fabricante-escolhido"]').innerText()) || "").includes("BAYER E2E PORTUGAL"), "regressar à ficha: a edição ainda não confirmada foi preservada");
    let dlg = 0;
    page.once("dialog", async (d) => { dlg++; await d.dismiss(); });
    await fechar(page, CNPF).click({ force: true });
    await page.waitForTimeout(500);
    check(dlg === 1, "fechar o separador durante a edição pede confirmação");
    await page.locator('[data-testid="fabricante-continuar"]').click();
    await page.locator('[data-testid="fabricante-confirmar"]').click();
    await page.locator('[data-testid="fabricante-valor"]').filter({ hasText: "BAYER E2E PORTUGAL" }).waitFor({ timeout: 20000 });
    const dep = await prisma.produto.findUniqueOrThrow({ where: { cnp: CNPF } });
    check(dep.fabricanteId === bayer.id && dep.validadoManualmente && dep.camposManuais.includes("fabricante") && dep.designacao === antes.designacao && !dep.camposManuais.includes("designacao"), "BD: fabricante aplicado e protegido; a designação e a sua proteção não são tocadas");
    const audF = await prisma.auditLog.findFirst({ where: { entityId: dep.id, action: "produto.fabricante.alterado" }, orderBy: { createdAt: "desc" } });
    const amF = JSON.parse(audF?.metaJson ?? "{}");
    check(!!audF && audF.actorId === seed.userId && amF.origem === "FICHA_ARTIGO" && amF.tenant === "silveira" && amF.cnp === CNPF && amF.fabricanteNovo.id === bayer.id, "auditoria do fabricante: utilizador, tenant, CNP, anterior/novo, origem", JSON.stringify(amF));
    await page.screenshot({ path: path.join(EVID, "fabricante-aplicado.png") });
    // criar novo
    await page.locator('[data-testid="fabricante-editar"]').click();
    await page.locator('[data-testid="fabricante-criar"]').click();
    await page.locator('[data-testid="fabricante-novo-nome"]').fill("  bayer   e2e portugal ");
    await page.locator('[data-testid="fabricante-duplicado"]').waitFor({ timeout: 15000 });
    check(await page.locator('[data-testid="fabricante-continuar"]').isDisabled(), "duplicado canónico: «Continuar» bloqueado");
    await page.locator('[data-testid="fabricante-novo-nome"]').fill("Bayer E2E Lda.");
    await page.locator('[data-testid="fabricante-duplicado"]').filter({ hasText: "BAYER E2E PORTUGAL" }).waitFor({ timeout: 15000 });
    check(true, "duplicado por alias bloqueado, com o existente indicado");
    await page.locator('[data-testid="fabricante-novo-nome"]').fill("Grifols E2E Internacional");
    await page.locator('[data-testid="fabricante-canonico"]').filter({ hasText: "GRIFOLS E2E INTERNACIONAL" }).waitFor({ timeout: 15000 });
    await page.locator('[data-testid="fabricante-semelhantes"]').waitFor({ timeout: 15000 }).catch(() => undefined);
    check((await page.locator('[data-testid="fabricante-semelhantes"]').count()) === 1, "mostra o nome normalizado e sugere fabricantes semelhantes (GRIFOLS E2E)");
    await page.locator('[data-testid="fabricante-novo-nome"]').fill("Nova Marca E2E, Lda.");
    await page.locator('[data-testid="fabricante-canonico"]').filter({ hasText: "NOVA MARCA E2E LDA" }).waitFor({ timeout: 15000 });
    const nFab = await prisma.fabricante.count();
    await page.locator('[data-testid="fabricante-continuar"]').click();
    await page.locator('[data-testid="fabricante-confirmar"]').click();
    await page.locator('[data-testid="fabricante-valor"]').filter({ hasText: "NOVA MARCA E2E LDA" }).waitFor({ timeout: 20000 });
    check((await prisma.fabricante.count()) === nFab + 1, "novo fabricante criado e aplicado ao artigo (1 criado)");
    // «Voltar a permitir» não altera o fabricante nem a designação protegida
    await prisma.produto.update({ where: { cnp: CNPF }, data: { camposManuais: { push: "designacao" } } });
    await page.reload({ waitUntil: "networkidle" });
    await page.locator('[data-testid="fabricante-editar"]').click();
    await page.locator('[data-testid="fabricante-permitir-erp"]').click();
    await page.locator('[data-testid="fabricante-permitir-erp-confirmar"]').click();
    await page.waitForTimeout(1500);
    const lib = await prisma.produto.findUniqueOrThrow({ where: { cnp: CNPF }, include: { fabricante: true } });
    check(!lib.validadoManualmente && !lib.camposManuais.includes("fabricante") && lib.camposManuais.includes("designacao") && lib.fabricante?.nomeNormalizado === "NOVA MARCA E2E LDA", "«Voltar a permitir» (fabricante): proteção do fabricante retirada, fabricante NÃO alterado, proteção da designação mantida");
  } finally {
    await browser.close();
    await amb.parar();
  }
  console.log(`\n${falhas === 0 ? "PASSOU" : "FALHOU"} — ${ok} OK, ${falhas} falhas\n`);
  process.exit(falhas === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
