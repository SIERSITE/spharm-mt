/**
 * scripts/e2e/workspace-separadores-browser.ts
 *
 * Browser REAL (Chromium) contra o build de PRODUÇÃO, com control plane + PostgreSQL descartáveis (dados sintéticos).
 * Prova o mecanismo GLOBAL de separadores («documentos abertos»): mudar de separador e voltar restaura a página no
 * estado em que ficou, SEM repetir consultas, com isolamento entre instâncias, ciclo de vida correcto e «Voltar»
 * contextual. Corre a 1920×1080 e a 1366×768.
 *
 *   A · Vendas: resultado, seleção, subtab «Relatório», scroll — e nenhum pedido ao servidor ao alternar;
 *   B · Margens: resultado, linha expandida + «Mostrar todos» da comparação CNPEM, scroll;
 *   C · Encomendas (nova): critérios/campos ainda não submetidos;
 *   D · Catálogo → ficha: pesquisa, página, scroll e «Voltar a Catálogo» (origem real); Vendas → ficha → «Voltar a Vendas»;
 *   E · duas análises de Vendas isoladas; «Nova análise» não reutiliza o estado anterior;
 *   F · fechar liberta o estado, reabrir começa limpo; logout limpa tudo; separador oculto não está montado;
 *
 * Pré-requisito: `npx next build` com SERVER_ACTIONS_ALLOWED_ORIGINS="localhost:3100,127.0.0.1:3100,*.localhost:3100".
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/e2e/workspace-separadores-browser.ts
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page, type Browser } from "playwright";
import { baseFor, criarAmbiente, type Ambiente } from "./_ambiente-silveira";
import { abrirContexto } from "./_grupo-comum";
import { CNP, semearMargens } from "./_margens-comum";

let ok = 0;
let falhas = 0;
const check = (cond: boolean, msg: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${msg}`); }
  else { falhas++; console.log(`  [FALHA] ${msg}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const secao = (t: string) => console.log(`\n── ${t}`);
const EVID = path.resolve("docs/validacao-visual/2026-10-workspace-separadores");

type Pedido = { tipo: "acao" | "rsc"; url: string; acao?: string; corpo?: string };

/** Regista TODOS os pedidos de Server Actions (cabeçalho `next-action`) e de navegação RSC. */
function observar(page: Page) {
  const pedidos: Pedido[] = [];
  page.on("request", (r) => {
    const h = r.headers();
    if (h["next-action"]) pedidos.push({ tipo: "acao", url: r.url(), acao: h["next-action"], corpo: (r.postData() ?? "").slice(0, 160) });
    else if (h["rsc"] === "1" && !r.url().includes("_next/static")) pedidos.push({ tipo: "rsc", url: r.url() });
  });
  return {
    acoes: () => pedidos.filter((p) => p.tipo === "acao"),
    rsc: () => pedidos.filter((p) => p.tipo === "rsc"),
    todos: () => pedidos,
  };
}

const diag = (page: Page) => page.evaluate(() => (window as unknown as { __spharmSeparadores?: () => Array<{ separador: string; chaves: number }> }).__spharmSeparadores?.() ?? []);
const scrollY = (page: Page) => page.evaluate(() => Math.round(window.scrollY));
const tab = (page: Page, prefixo: string) => page.locator(`[data-navegacao-href^="${prefixo}"]`);
const detalheAcoes = (net: ReturnType<typeof observar>, desde: number) => JSON.stringify(net.acoes().slice(desde).map((a) => ({ url: a.url.replace(/^https?:\/\/[^/]+/, ""), id: a.acao?.slice(0, 10), corpo: a.corpo })));
const idWorkspace = (page: Page) => new URL(page.url()).searchParams.get("workspace");

async function gerarVendas(page: Page) {
  const ano = new Date().getFullYear();
  await page.getByLabel("Data início").fill(`${ano}-01-01`);
  await page.getByLabel("Data fim").fill(new Date().toISOString().slice(0, 10));
  await page.getByRole("button", { name: /^Gerar$/ }).click();
  await page.getByRole("button", { name: /^Atualizar$/ }).waitFor({ timeout: 90000 });
  await page.locator('[data-testid="vendas-sel-contagem"]').waitFor({ timeout: 30000 });
}
const contagem = async (page: Page) => (await page.locator('[data-testid="vendas-sel-contagem"]').innerText()).replace(/\s+/g, " ").trim();

async function suite(browser: Browser, amb: Ambiente, seed: { userId: string }, w: number, h: number) {
  try {
    await suiteInterna(browser, amb, seed, w, h);
  } catch (e) {
    console.log("  [ERRO] " + (e instanceof Error ? e.message.slice(0, 300) : String(e)));
    throw e;
  }
}

async function suiteInterna(browser: Browser, amb: Ambiente, seed: { userId: string }, w: number, h: number) {
  const ctx = await abrirContexto(amb, browser, { userId: seed.userId } as never);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  await page.setViewportSize({ width: w, height: h });
  const net = observar(page);
  const tag = `${w}x${h}`;
  page.on("close", () => undefined);
  process.on("unhandledRejection", () => undefined);

  // ═══ A · Vendas ═════════════════════════════════════════════════
  secao(`${tag} · A — Vendas: resultado, seleção, subtab, scroll; sem novas consultas`);
  await page.goto(baseFor("silveira") + "/vendas", { waitUntil: "networkidle" });
  await page.waitForFunction(() => new URL(location.href).searchParams.has("workspace"));
  const wsA = idWorkspace(page)!;
  const acoesAntesGerar = net.acoes().length;
  await gerarVendas(page);
  const idGerar = net.acoes().slice(acoesAntesGerar).map((a) => a.acao);
  check(idGerar.length >= 1, `«Gerar» fez ${idGerar.length} pedido(s) ao servidor (Server Action)`);
  const nArt = Number((await contagem(page)).split(" ")[2]);
  await page.locator('[data-testid^="vendas-sel-artigo-"]').nth(0).uncheck();
  await page.locator('[data-testid^="vendas-sel-artigo-"]').nth(1).uncheck();
  const contSel = await contagem(page);
  check(contSel.startsWith(`${nArt - 2} de ${nArt}`), `seleção parcial: «${contSel}»`);
  // scroll interno da tabela (contentor com data-scroll-key) e da janela, com a subtab «Tabela» ativa
  await page.locator('[data-testid="vendas-contentor-tabela"]').evaluate((el) => { el.scrollTop = 220; });
  await page.evaluate(() => window.scrollTo(0, 120));
  await page.waitForTimeout(500);
  const scrollTabela = await page.locator('[data-testid="vendas-contentor-tabela"]').evaluate((el) => Math.round(el.scrollTop));
  const scrollJanelaT = await scrollY(page);
  check(scrollTabela > 100 && scrollJanelaT > 50, `scroll em Vendas/Tabela: contentor ${scrollTabela}px, janela ${scrollJanelaT}px`);
  let scrollJanelaA = 0;

  // ═══ B · Margens (abre noutro separador a partir do menu) ══════
  secao(`${tag} · B — Margens: resultado, expansão CNPEM, «Mostrar todos», scroll`);
  await page.getByRole("link", { name: "Margens", exact: true }).click();
  await page.waitForURL(/relatorios\/margens\?workspace=/);
  await page.getByRole("button", { name: "Gerar", exact: true }).click();
  const SELM = '[data-testid="tabela-margens-produto"]';
  await page.locator(SELM).waitFor({ timeout: 60000 });
  await page.getByPlaceholder("Pesquisar CNP ou descrição").fill(String(CNP.A));
  await page.waitForTimeout(1500);
  await page.locator(`${SELM} tbody > tr[data-cnp="${CNP.A}"]:not([data-tabela-linha]) [data-testid="expandir-cnpem"]`).first().click();
  await page.locator('[data-testid="comparacao-contagem"]').waitFor({ timeout: 20000 });
  await page.locator('[data-testid="comparacao-mostrar-todos"]').check();
  await page.waitForFunction((c) => !!document.querySelector(`tr[data-tabela-linha^="comparacao"][data-cnp="${c}"]`), String(CNP.F), { timeout: 20000 });
  const contagemMargens = (await page.locator('[data-testid="comparacao-contagem"]').innerText()).replace(/\s+/g, " ");
  const linhasCmp = await page.locator('tr[data-tabela-linha^="comparacao"]').count();
  const wsM = idWorkspace(page)!;
  await page.evaluate(() => window.scrollTo(0, 120));
  await page.waitForTimeout(500);
  const scrollJanelaM = await scrollY(page);

  // — voltar a Vendas pela barra: tudo como ficou, sem nenhum pedido ao servidor
  secao(`${tag} · A/B — alternar entre separadores`);
  const baseline = net.acoes().length;
  const rscAntes = net.rsc().length;
  await tab(page, `/vendas?workspace=${wsA}`).click();
  await page.locator('[data-testid="vendas-contentor-tabela"]').waitFor({ timeout: 20000 });
  // o resultado volta no PRIMEIRO instante: nada de ecrã «por gerar» (o botão é «Atualizar», não «Gerar»)
  check((await page.getByRole("button", { name: /^Atualizar$/ }).count()) === 1 && (await page.getByRole("button", { name: /^Gerar$/ }).count()) === 0, "Vendas: o resultado gerado está lá (botão «Atualizar»), sem flash de página vazia");
  check((await contagem(page)) === contSel, `Vendas: seleção preservada: «${await contagem(page)}»`);
  await page.waitForTimeout(1300); // dá tempo à restauração do scroll
  const scrollTabelaDepois = await page.locator('[data-testid="vendas-contentor-tabela"]').evaluate((el) => Math.round(el.scrollTop));
  const scrollJanelaDepois = await scrollY(page);
  check(Math.abs(scrollTabelaDepois - scrollTabela) <= 4, `Vendas: scroll da tabela restaurado ${scrollTabela} → ${scrollTabelaDepois}`);
  check(Math.abs(scrollJanelaDepois - scrollJanelaT) <= 4, `Vendas: scroll da janela restaurado ${scrollJanelaT} → ${scrollJanelaDepois}`);
  const acoesVendas = net.acoes().length - baseline;
  check(acoesVendas === 0, `Vendas: NENHUM pedido de Server Action ao voltar (${acoesVendas}); navegações RSC (render da página): ${net.rsc().length - rscAntes}`);
  await page.screenshot({ path: path.join(EVID, `vendas-restaurada-${tag}.png`) });
  // subtab «Relatório» + scroll → outro separador → voltar
  await page.getByRole("button", { name: /^Relatório$/ }).click();
  await page.locator('[data-testid="vendas-relatorio-previa"]').waitFor();
  await page.evaluate(() => window.scrollTo(0, 380));
  await page.waitForTimeout(500);
  scrollJanelaA = await scrollY(page);
  check(scrollJanelaA > 100, `scroll da janela em Vendas/Relatório: ${scrollJanelaA}px`);
  const baselineR = net.acoes().length;
  await tab(page, `/relatorios/margens?workspace=${wsM}`).click();
  await page.locator(SELM).waitFor({ timeout: 20000 });
  await tab(page, `/vendas?workspace=${wsA}`).click();
  await page.locator('[data-testid="vendas-relatorio-previa"]').waitFor({ timeout: 20000 });
  await page.waitForTimeout(1300);
  check(Math.abs((await scrollY(page)) - scrollJanelaA) <= 4, `Vendas/Relatório: subtab e scroll restaurados (${scrollJanelaA} → ${await scrollY(page)})`, JSON.stringify(await page.evaluate(() => ({ sh: document.documentElement.scrollHeight, ih: innerHeight, y: scrollY }))));
  check(net.acoes().length - baselineR === 0, `Vendas/Relatório: nenhum pedido de Server Action (${net.acoes().length - baselineR}) — a pré-visualização não é regenerada no servidor`, detalheAcoes(net, baselineR));
  await page.screenshot({ path: path.join(EVID, `vendas-relatorio-restaurada-${tag}.png`) });
  await page.getByRole("button", { name: /^Tabela$/ }).click();

  // — voltar a Margens
  const baseline2 = net.acoes().length;
  await tab(page, `/relatorios/margens?workspace=${wsM}`).click();
  await page.locator(SELM).waitFor({ timeout: 20000 });
  check((await page.locator('[data-testid="comparacao-contagem"]').count()) === 1, "Margens: a linha continua expandida");
  check(await page.locator('[data-testid="comparacao-mostrar-todos"]').isChecked(), "Margens: «Mostrar todos» continua ligado");
  check((await page.locator('[data-testid="comparacao-contagem"]').innerText()).replace(/\s+/g, " ") === contagemMargens, `Margens: a contagem da comparação é a mesma («${contagemMargens}»)`);
  check((await page.locator('tr[data-tabela-linha^="comparacao"]').count()) === linhasCmp, `Margens: as ${linhasCmp} linhas da comparação estão lá, sem recarregar`);
  await page.waitForTimeout(1200);
  const scrollDepoisM = await scrollY(page);
  check(Math.abs(scrollDepoisM - scrollJanelaM) <= 4, `Margens: scroll restaurado: ${scrollJanelaM} → ${scrollDepoisM}`);
  await page.waitForTimeout(600);
  check(net.acoes().length - baseline2 === 0, `Margens: NENHUM pedido de Server Action ao voltar (${net.acoes().length - baseline2}) — a comparação não é repetida`, detalheAcoes(net, baseline2));
  check((await page.locator('[data-testid="vendas-tabela"]').count()) === 0 && (await page.locator('[data-testid="vendas-sel-contagem"]').count()) === 0, "o separador oculto (Vendas) não está montado: não recebe foco, não corre efeitos");
  await page.screenshot({ path: path.join(EVID, `margens-restaurada-${tag}.png`) });

  // ═══ C · Encomendas (nova) ══════════════════════════════════════
  secao(`${tag} · C — Encomendas (nova): campos ainda não submetidos`);
  await page.getByRole("link", { name: "Encomendas", exact: true }).click();
  await page.waitForURL(/\/encomendas$/);
  await page.locator('a[href="/encomendas/nova"]').first().click();
  await page.waitForURL(/\/encomendas\/nova/);
  const cob = page.locator('input[type="number"][min="1"]').filter({ has: page.locator("xpath=.") }).first();
  await page.getByText("Cobertura alvo (dias)").waitFor({ timeout: 30000 });
  const campoCob = page.getByText("Cobertura alvo (dias)").locator("xpath=following-sibling::input").first();
  await campoCob.fill("27");
  void cob;
  await page.waitForTimeout(300);
  const baseline3 = net.acoes().length;
  await tab(page, `/vendas?workspace=${wsA}`).click();
  await page.getByRole("button", { name: /^Atualizar$/ }).waitFor({ timeout: 20000 });
  await tab(page, "/encomendas/nova").click();
  await page.getByText("Cobertura alvo (dias)").waitFor({ timeout: 30000 });
  check((await page.getByText("Cobertura alvo (dias)").locator("xpath=following-sibling::input").first().inputValue()) === "27", "Nova encomenda: «Cobertura alvo» continua a 27 depois de alternar");
  check(net.acoes().length - baseline3 === 0, `Nova encomenda: nenhum pedido de Server Action ao alternar (${net.acoes().length - baseline3})`);

  // ═══ D · Navegação contextual ═══════════════════════════════════
  secao(`${tag} · D — Vendas → ficha → «Voltar a Vendas»; Catálogo → ficha → «Voltar a Catálogo»`);
  await tab(page, `/vendas?workspace=${wsA}`).click();
  await page.getByRole("button", { name: /^Tabela$/ }).waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: /^Tabela$/ }).click();
  await page.locator('[data-testid="vendas-tabela"] tbody a').first().click(); // abre o painel lateral da ficha
  await page.getByRole("button", { name: /Manter como tarefa/ }).click();
  await page.waitForURL(/\/stock\/artigo\/\d+/);
  const voltar = page.locator('[data-testid="voltar-origem"]');
  await voltar.waitFor({ timeout: 20000 });
  check(/Voltar a Vendas/.test(await voltar.innerText()), `a ficha aberta a partir de Vendas diz «${(await voltar.innerText()).trim()}» (não «Voltar a Stock»)`);
  const baseline4 = net.acoes().length;
  await voltar.click();
  await page.waitForURL(/\/vendas\?workspace=/, { timeout: 30000 });
  await page.getByRole("button", { name: /^Atualizar$/ }).waitFor({ timeout: 20000 });
  await page.locator('[data-testid="vendas-sel-contagem"]').waitFor({ timeout: 20000 });
  check(new URL(page.url()).searchParams.get("workspace") === wsA && (await contagem(page)) === contSel, `«Voltar» ativou o separador de origem e restaurou a seleção («${await contagem(page)}»)`, `url=${page.url()} wsA=${wsA} esperado=«${contSel}»`);
  check(net.acoes().length - baseline4 === 0, `Vendas/ficha: nenhum pedido de Server Action no regresso (${net.acoes().length - baseline4})`);

  await page.getByRole("link", { name: "Catálogo", exact: true }).click();
  await page.waitForURL(/\/catalogo/);
  const pesquisa = page.getByPlaceholder("CNP, designação, princípio ativo ou ATC");
  await pesquisa.fill("ARTIGO VOL 01");
  await pesquisa.press("Enter");
  await page.waitForURL(/[?&]q=/);
  await page.waitForTimeout(800);
  await page.evaluate(() => window.scrollTo(0, 140));
  await page.waitForTimeout(500);
  const scrollCat = await scrollY(page);
  const urlCat = new URL(page.url()).search;
  await page.locator('a[href^="/catalogo/artigo/"]').first().click();
  await page.waitForURL(/\/catalogo\/artigo\//);
  const voltarCat = page.locator('[data-testid="voltar-origem"]');
  await voltarCat.waitFor({ timeout: 20000 }).catch(async (e) => { await page.screenshot({ path: path.join(EVID, `erro-voltar-catalogo-${tag}.png`) }); console.log("  url:", page.url()); throw e; });
  check(/Voltar a Catálogo/.test(await voltarCat.innerText()), `a ficha do catálogo diz «${(await voltarCat.innerText()).trim()}»`);
  await voltarCat.click();
  await page.waitForURL(/\/catalogo\?q=/, { timeout: 30000 });
  check(new URL(page.url()).search === urlCat, `Catálogo: pesquisa/página/ordenação voltam pelo URL guardado (${urlCat})`, `atual=${new URL(page.url()).search}`);
  await page.waitForTimeout(1200);
  check((await page.getByPlaceholder("CNP, designação, princípio ativo ou ATC").inputValue()) === "ARTIGO VOL 01", "Catálogo: a pesquisa aplicada continua no campo");
  check(Math.abs((await scrollY(page)) - scrollCat) <= 6, `Catálogo: scroll restaurado ${scrollCat} → ${await scrollY(page)}`);
  await page.screenshot({ path: path.join(EVID, `catalogo-restaurado-${tag}.png`) });

  // ═══ E · duas instâncias da mesma rota ═══════════════════════════
  secao(`${tag} · E — duas análises de Vendas isoladas; «Nova análise» não reutiliza estado`);
  await tab(page, `/vendas?workspace=${wsA}`).click();
  await page.getByRole("button", { name: /^Atualizar$/ }).waitFor({ timeout: 20000 });
  await page.getByPlaceholder("Pesquisar por CNP ou descrição...").fill("");
  await page.getByRole("button", { name: /Nova análise/ }).click();
  await page.waitForFunction((a) => new URL(location.href).searchParams.get("workspace") !== a, wsA);
  const wsB = idWorkspace(page)!;
  check(wsB !== wsA && (await page.getByRole("button", { name: /^Gerar$/ }).count()) === 1 && (await page.locator('[data-testid="vendas-sel-contagem"]').count()) === 0, "«Nova análise» abre uma instância LIMPA (sem resultado nem seleção da anterior)");
  await page.getByPlaceholder("Pesquisar por CNP ou descrição...").fill("VOL 00");
  await gerarVendas(page);
  const contB = await contagem(page);
  const nB = Number(contB.split(" ")[2]);
  check(nB > 0 && nB < nArt, `análise B (pesquisa «VOL 00»): ${nB} artigos (A tem ${nArt})`);
  for (let i = 0; i < 2; i++) {
    await tab(page, `/vendas?workspace=${wsA}`).click();
    await page.getByRole("button", { name: /^Atualizar$/ }).waitFor();
    await page.waitForFunction((c) => document.querySelector('[data-testid="vendas-sel-contagem"]')?.textContent?.replace(/\s+/g, " ").trim() === c, contSel, { timeout: 10000 });
    check((await contagem(page)) === contSel && (await page.getByPlaceholder("Pesquisar por CNP ou descrição...").inputValue()) === "", `A (volta ${i + 1}): ${await contagem(page)}, pesquisa vazia`);
    await tab(page, `/vendas?workspace=${wsB}`).click();
    await page.waitForFunction((c) => document.querySelector('[data-testid="vendas-sel-contagem"]')?.textContent?.replace(/\s+/g, " ").trim() === c, contB, { timeout: 10000 });
    check((await contagem(page)) === contB && (await page.getByPlaceholder("Pesquisar por CNP ou descrição...").inputValue()) === "VOL 00", `B (volta ${i + 1}): ${await contagem(page)}, pesquisa «VOL 00»`);
  }

  // ═══ F · fecho, reabertura, logout ═══════════════════════════════
  secao(`${tag} · F — fechar liberta o estado; reabrir começa limpo; logout limpa tudo`);
  const antesFecho = (await diag(page)).filter((d) => d.separador.includes(`workspace=${wsB}`)).length;
  check(antesFecho === 1, "o separador B tem estado em memória antes de fechar");
  await page.getByRole("button", { name: /Fechar Vendas/ }).last().click().catch(() => undefined);
  await page.waitForTimeout(600);
  // fechar pode pedir confirmação se houver alterações pendentes: aqui não há
  const depoisFecho = (await diag(page)).filter((d) => d.separador.includes(`workspace=${wsB}`)).length;
  check(depoisFecho === 0, `fechar o separador B libertou o seu estado (chaves: ${antesFecho} → ${depoisFecho})`);
  check((await diag(page)).some((d) => d.separador.includes(`workspace=${wsA}`)), "o estado do separador A mantém-se");
  await page.getByRole("link", { name: "Vendas", exact: true }).click();
  await page.waitForFunction(([a, b]) => { const w = new URL(location.href).searchParams.get("workspace"); return !!w && w !== a && w !== b; }, [wsA, wsB]);
  check((await page.getByRole("button", { name: /^Gerar$/ }).count()) === 1 && (await page.locator('[data-testid="vendas-sel-contagem"]').count()) === 0, "reabrir Vendas cria uma instância nova, sem herdar o estado do separador fechado");

  await page.getByRole("button", { name: /Sair/ }).click();
  await page.waitForURL(/login/, { timeout: 30000 });
  await page.waitForTimeout(500);
  check((await diag(page)).length === 0, "terminar sessão limpou TODO o estado dos separadores da memória");
  await page.screenshot({ path: path.join(EVID, `logout-${tag}.png`) });
  await ctx.close();
}

async function main() {
  fs.mkdirSync(EVID, { recursive: true });
  const amb = await criarAmbiente("ws");
  const browser = await chromium.launch();
  try {
    const seed = await semearMargens(amb);
    await suite(browser, amb, seed, 1920, 1080);
    await suite(browser, amb, seed, 1366, 768);
  } finally {
    await browser.close();
    await amb.parar();
  }
  console.log(`\n${falhas === 0 ? "PASSOU" : "FALHOU"} — ${ok} OK, ${falhas} falhas\n`);
  process.exit(falhas === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
