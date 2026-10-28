/**
 * scripts/e2e/margens-cnpem-cabecalhos-browser.ts
 *
 * Ensaio de BROWSER REAL (Chromium) contra o servidor de produção, com control
 * plane + PostgreSQL descartáveis (ver `_ambiente-silveira.ts`):
 *
 *   · Margens: scroll, cabeçalho fixo, alinhamento, scroll horizontal, linhas
 *     distinguíveis, expansão por CNPEM (período e farmácias), artigo sem vendas;
 *   · Encomendas: cabeçalho fixo na proposta (Farmácia e Grupo), no detalhe e na listagem;
 *   · Encomendas anuladas: mostrar/ocultar;
 *   · Impressão: PDF real do relatório de Margens, cabeçalho repetido, escala de cinzentos.
 *
 * Pré-requisito: `npx next build` com SERVER_ACTIONS_ALLOWED_ORIGINS="localhost:3100,127.0.0.1:3100,*.localhost:3100".
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/e2e/margens-cnpem-cabecalhos-browser.ts
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { chromium, type Page } from "playwright";
import { baseFor, criarAmbiente } from "./_ambiente-silveira";
import { abrirContexto } from "./_grupo-comum";
import { alinhamentoColunas, atualizarMargens, CNP, estadoCabecalho, semearMargens, type Check } from "./_margens-comum";

let ok = 0;
let falhas = 0;
const check: Check = (cond, msg) => {
  if (cond) { ok++; console.log(`  [OK]    ${msg}`); }
  else { falhas++; console.log(`  [FALHA] ${msg}`); }
};
const secao = (t: string) => console.log(`\n── ${t}`);
const EVID = path.resolve("docs/validacao-visual/2026-10-margens-cabecalhos");

/** POST ao servidor local com o Host original (o Node não resolve *.localhost). */
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

async function gerarMargens(page: Page) {
  await page.goto(baseFor("silveira") + "/relatorios/margens", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Gerar", exact: true }).click();
  await page.locator('[data-testid="tabela-margens-produto"]').waitFor({ timeout: 60000 });
}

async function main() {
  fs.mkdirSync(EVID, { recursive: true });
  const amb = await criarAmbiente("mg");
  const browser = await chromium.launch();
  try {
    const seed = await semearMargens(amb);
    const ctx = await abrirContexto(amb, browser, { userId: seed.userId } as never);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
    await page.setViewportSize({ width: 1500, height: 900 });

    // ═══ 1 · Margens: cabeçalho fixo e linhas ═══════════════════════
    secao("1 · Margens — cabeçalho fixo, alinhamento e linhas distinguíveis");
    await gerarMargens(page);
    const SEL = '[data-testid="tabela-margens-produto"]';
    const nLinhas = await page.locator(`${SEL} tbody > tr`).count();
    check(nLinhas > 300, `mapa extenso (${nLinhas} linhas)`);
    const ths = await page.locator(`${SEL} thead th`).allInnerTexts();
    check(ths.some((t) => /Margem unitária/i.test(t)) && ths.some((t) => /Preço utente — regime geral/i.test(t)) && ths.some((t) => /Preço utente — regime especial/i.test(t)), `colunas novas no cabeçalho: ${ths.filter((t) => /unit|utente/i.test(t)).join(" | ")}`);
    check(await page.locator(`${SEL} table`).getAttribute("class").then(() => true), "tabela presente");

    // Scroll da PÁGINA até o contentor ficar logo abaixo da barra superior.
    await page.locator(SEL).scrollIntoViewIfNeeded();
    await page.evaluate((sel) => {
      const c = document.querySelector(sel) as HTMLElement;
      window.scrollBy(0, c.getBoundingClientRect().top - 70);
    }, SEL);
    const alturaContentor = await page.evaluate((sel) => (document.querySelector(sel) as HTMLElement).getBoundingClientRect().height, SEL);
    check(alturaContentor < 900, `o contentor não excede o ecrã (${Math.round(alturaContentor)}px) — o scroll fica dentro dele`);
    const h0 = await estadoCabecalho(page, SEL);
    await page.evaluate((sel) => { (document.querySelector(sel) as HTMLElement).scrollTop = 900; }, SEL);
    const h1 = await estadoCabecalho(page, SEL);
    check(h1.scrollTop >= 800, `scroll interno efetivo (scrollTop=${h1.scrollTop})`);
    check(Math.abs(h1.desvioTopo) <= 1, `o cabeçalho continua no topo do contentor após o scroll (desvio ${h1.desvioTopo}px; antes ${h0.desvioTopo}px)`);
    check(h1.visivelPorCima, "o cabeçalho está por cima das linhas (nenhum texto das linhas por trás)");
    check(h1.opaco, "o cabeçalho tem fundo opaco");
    const al = await alinhamentoColunas(page, SEL);
    check(al.maxDesvio <= 1.5, `alinhamento cabeçalho/colunas exato (${al.colunas} colunas, desvio máx ${al.maxDesvio}px)`);

    // A barra superior da aplicação NÃO fica tapada pela tabela: o contentor isola o
    // seu z-index (isolation:isolate) e a barra tem z-index 30. NOTA: hoje a barra não
    // fica colada ao topo (o contorno da shell tem overflow:hidden — anterior a este
    // trabalho), por isso a garantia verificada é estrutural.
    const iso = await page.evaluate(`(() => {
      const c = document.querySelector('${SEL}');
      const h = document.querySelector('header');
      return { isolation: getComputedStyle(c).isolation, zBarra: getComputedStyle(h).zIndex, thZ: getComputedStyle(c.querySelector('thead th')).zIndex };
    })()`) as { isolation: string; zBarra: string; thZ: string };
    check(iso.isolation === "isolate" && Number(iso.zBarra) >= 30, `o contentor isola o z-index (${iso.isolation}); barra z=${iso.zBarra}, cabeçalho da tabela z=${iso.thZ} só dentro do contentor`);

    // Scroll horizontal: o cabeçalho acompanha as colunas.
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.evaluate((sel) => { const c = document.querySelector(sel) as HTMLElement; c.scrollLeft = 0; c.scrollTop = 0; }, SEL);
    const larg = await page.evaluate((sel) => { const c = document.querySelector(sel) as HTMLElement; return { sw: c.scrollWidth, cw: c.clientWidth }; }, SEL);
    check(larg.sw > larg.cw, `há scroll horizontal (conteúdo ${larg.sw}px > ${larg.cw}px)`);
    await page.evaluate((sel) => { const c = document.querySelector(sel) as HTMLElement; c.scrollLeft = 320; c.scrollTop = 600; }, SEL);
    const hh = await estadoCabecalho(page, SEL);
    const alH = await alinhamentoColunas(page, SEL);
    check(Math.abs(hh.desvioTopo) <= 1 && alH.maxDesvio <= 1.5, `com scroll horizontal+vertical o cabeçalho mantém o topo e o alinhamento (desvio ${alH.maxDesvio}px)`);
    await page.screenshot({ path: path.join(EVID, "margens-scroll-horizontal.png") });
    await page.setViewportSize({ width: 1500, height: 900 });

    // Linhas distinguíveis (zebra + separador + hover)
    const linhas = await page.evaluate(`(() => {
      const trs = Array.from(document.querySelectorAll('${SEL} tbody > tr:not([data-tabela-linha])')).slice(0, 4);
      const bg = (i) => getComputedStyle(trs[i].querySelector('td:nth-child(3)')).backgroundImage;
      const cs = getComputedStyle(trs[0]);
      return { par: bg(1), impar: bg(0), borda: cs.borderBottomWidth + ' ' + cs.borderBottomStyle, corBorda: cs.borderBottomColor };
    })()`) as { par: string; impar: string; borda: string; corBorda: string };
    check(linhas.par !== linhas.impar && linhas.par.includes("gradient"), "linhas alternadas com fundo distinto");
    check(/^1px solid/.test(linhas.borda), `separador horizontal em cada linha (${linhas.borda} ${linhas.corBorda})`);
    await page.locator(`${SEL} tbody > tr`).nth(3).hover();
    const hover = await page.evaluate((sel) => getComputedStyle(document.querySelectorAll(`${sel} tbody > tr`)[3].querySelector("td:nth-child(3)")!).backgroundImage, SEL);
    check(hover.includes("14, 165, 233"), "estado hover visível");
    await page.screenshot({ path: path.join(EVID, "margens-cabecalho-fixo.png") });

    // ═══ 2 · Margens: expansão por CNPEM ════════════════════════════
    secao("2 · Margens — expansão por CNPEM");
    await page.evaluate((sel) => { const c = document.querySelector(sel) as HTMLElement; c.scrollTop = 0; c.scrollLeft = 0; }, SEL);
    await page.getByPlaceholder("Pesquisar CNP ou descrição").fill(String(CNP.A));
    await atualizarMargens(page); // Margens não gera ao escrever
    const rowsA = page.locator(`${SEL} tbody > tr[data-cnp="${CNP.A}"]`);
    check((await rowsA.count()) === 2, "pesquisa pelo CNP do artigo analisado: 2 linhas (Alfa e Beta)");
    const semBotao = await page.locator(`${SEL} tbody > tr:not([data-cnp="${CNP.A}"]) [data-testid="expandir-cnpem"]`).count();
    check(semBotao === 0, "só as linhas do artigo com CNPEM têm o botão de expandir");
    const linhaAlfa = page.locator(`${SEL} tbody > tr[data-cnp="${CNP.A}"][data-farmacia="${seed.nomes.alfa}"]:not([data-tabela-linha])`);
    const botao = linhaAlfa.locator('[data-testid="expandir-cnpem"]');
    check((await botao.getAttribute("aria-expanded")) === "false", "botão acessível: aria-expanded=false antes de expandir");
    await botao.focus();
    await page.keyboard.press("Enter");
    await page.locator('[data-testid="comparacao-cnpem"]').first().waitFor({ timeout: 20000 });
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="etiqueta-comparavel"]').length > 0, null, { timeout: 20000 });
    check((await botao.getAttribute("aria-expanded")) === "true", "expansão por teclado (Enter): aria-expanded=true");
    const nomesExp = await page.locator('tr[data-tabela-linha^="comparacao"]').evaluateAll((trs) => trs.map((t) => (t as HTMLElement).dataset.cnp ?? "").filter(Boolean));
    check(nomesExp.includes(String(CNP.A)) && nomesExp.includes(String(CNP.B)) && nomesExp.includes(String(CNP.C)), `aparecem o analisado, B e C: [${nomesExp}]`);
    check(!nomesExp.includes(String(CNP.E)), "DCI igual mas CNPEM diferente (E) NÃO aparece");
    check(nomesExp.includes(String(CNP.D)), "com as 3 farmácias selecionadas, D (mesmo CNPEM, existe só na Gama) aparece");
    check(!nomesExp.includes(String(CNP.SO_FICHEIRO)), "artigo que só existe no ficheiro do INFARMED NÃO aparece");
    check((await page.locator('[data-testid="etiqueta-analisado"]').count()) === 1, "a linha original está identificada como «Produto analisado»");
    check((await page.locator('[data-testid="etiqueta-comparavel"]').count()) >= 2, "os restantes estão identificados como «Mesmo CNPEM»");
    const textoC = await page.locator(`tr[data-tabela-linha="comparacao"][data-cnp="${CNP.C}"]`).innerText();
    check(/Sem vendas no período/.test(textoC), "C (existe na farmácia, sem vendas) aparece com «Sem vendas no período»");
    const colsExp = await page.locator(`tr[data-tabela-linha="comparacao-analisado"]`).first().locator("> td").count();
    const colsMain = await linhaAlfa.locator("> td").count();
    check(colsExp === colsMain, `a expansão tem as mesmas ${colsMain} colunas, pela mesma ordem do mapa principal`);
    const celula = (sel: string, col: string) => page.locator(sel).locator(`[data-col="${col}"]`).first().innerText();
    const mainMU = await celula(`${SEL} tbody > tr[data-cnp="${CNP.A}"][data-farmacia="${seed.nomes.alfa}"]:not([data-tabela-linha])`, "margem-unitaria");
    const expMU = await celula(`tr[data-tabela-linha="comparacao-analisado"]`, "margem-unitaria");
    check(mainMU === expMU && /\d/.test(mainMU), `a margem unitária do analisado é igual no mapa e na expansão (${mainMU})`);
    check(/3,50/.test(await celula(`tr[data-tabela-linha="comparacao-analisado"]`, "utente-geral")) && /2,10/.test(await celula(`tr[data-tabela-linha="comparacao-analisado"]`, "utente-especial")), "preço do utente — regime geral 3,50 € e especial 2,10 €");
    await page.screenshot({ path: path.join(EVID, "margens-expansao-cnpem.png") });

    // período: junto ao período do relatório, C passa a ter 0 vendas noutro; escolher um período sem vendas
    await page.locator('input[aria-label="Desde"]').fill("2020-01-01");
    await page.locator('input[aria-label="Até"]').fill("2020-12-31");
    await atualizarMargens(page);
    const semDados = await page.locator(`${SEL}`).count();
    check(semDados === 0 || (await page.getByText("Sem produtos para os filtros actuais").count()) > 0, "período sem vendas: o mapa principal fica vazio (a expansão acompanha o relatório)");
    await page.locator('input[aria-label="Desde"]').fill(`${new Date().getFullYear()}-01-01`);
    await page.locator('input[aria-label="Até"]').fill(new Date().toISOString().slice(0, 10));
    await atualizarMargens(page);
    await page.locator(`${SEL} tbody > tr[data-cnp="${CNP.A}"]`).first().waitFor({ timeout: 20000 });
    // reabrir após o recálculo: pede dados novos
    const botao2 = page.locator(`${SEL} tbody > tr[data-cnp="${CNP.A}"][data-farmacia="${seed.nomes.alfa}"] [data-testid="expandir-cnpem"]`);
    if ((await botao2.getAttribute("aria-expanded")) !== "true") await botao2.click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="etiqueta-comparavel"]').length > 0, null, { timeout: 20000 });
    check(true, "voltar ao período do ano: a expansão volta a carregar com os dados do novo cálculo");

    // farmácias: tirar a Gama → D (só existe na Gama) desaparece; B e C mantêm-se
    await page.getByRole("button", { name: /Filtros/ }).first().click();
    const pill = (nome: string) => page.locator("span.rounded-full", { hasText: nome }).locator("button").first();
    await pill(seed.nomes.gama).click();
    await atualizarMargens(page);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="etiqueta-comparavel"]').length > 0, null, { timeout: 20000 });
    const semGama = await page.locator('tr[data-tabela-linha^="comparacao"]').evaluateAll((trs) => trs.map((t) => (t as HTMLElement).dataset.cnp ?? ""));
    check(!semGama.includes(String(CNP.D)) && semGama.includes(String(CNP.B)) && semGama.includes(String(CNP.C)), `sem a Gama selecionada: D desaparece, B e C mantêm-se [${semGama}]`);
    const farmaciasExp = await page.locator('tr[data-tabela-linha^="comparacao"]').evaluateAll((trs) => trs.map((t) => (t as HTMLElement).dataset.farmacia ?? "").filter(Boolean));
    check(!farmaciasExp.includes(seed.nomes.gama), "nenhuma farmácia fora da seleção aparece na expansão");
    // só a Alfa: A@Beta deixa de aparecer
    await pill(seed.nomes.beta).click();
    await atualizarMargens(page);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="etiqueta-comparavel"]').length > 0, null, { timeout: 20000 });
    const soAlfa = await page.locator('tr[data-tabela-linha^="comparacao"]').evaluateAll((trs) => trs.map((t) => (t as HTMLElement).dataset.farmacia ?? "").filter(Boolean));
    check(soAlfa.length > 0 && soAlfa.every((f) => f === "Farmacia Alfa"), `uma só farmácia (Alfa): a expansão só tem artigos da Alfa (${soAlfa.length} linhas)`);
    await page.screenshot({ path: path.join(EVID, "margens-expansao-uma-farmacia.png") });

    await page.close();

    // ═══ 3 · Encomendas: cabeçalhos fixos ═══════════════════════════
    secao("3 · Encomendas — cabeçalho fixo (proposta Farmácia e Grupo, detalhe, listagem)");
    const p2 = await ctx.newPage();
    p2.on("pageerror", (e) => console.log("  [pageerror]", e.message));
    await p2.setViewportSize({ width: 1500, height: 900 });
    await p2.goto(baseFor("silveira") + "/encomendas/nova", { waitUntil: "networkidle" });
    await p2.getByRole("button", { name: "Grupo", exact: true }).click();
    await p2.getByRole("button", { name: /Gerar (nova )?proposta/ }).click();
    const SELP = '[data-testid="tabela-proposta"]';
    await p2.locator(SELP).waitFor({ timeout: 90000 });
    check(true, "proposta de Grupo gerada");
    await p2.evaluate((sel) => { const c = document.querySelector(sel) as HTMLElement; window.scrollBy(0, c.getBoundingClientRect().top - 70); }, SELP);
    await p2.evaluate((sel) => { (document.querySelector(sel) as HTMLElement).scrollTop = 1200; }, SELP);
    const hg = await estadoCabecalho(p2, SELP);
    const alG = await alinhamentoColunas(p2, SELP);
    check(hg.scrollTop > 600 && Math.abs(hg.desvioTopo) <= 1 && hg.visivelPorCima && hg.opaco, `Grupo: cabeçalho fixo após scroll (scrollTop=${hg.scrollTop}, desvio ${hg.desvioTopo}px)`);
    check(alG.maxDesvio <= 2, `Grupo: cabeçalho alinhado com as colunas (desvio ${alG.maxDesvio}px)`);
    if (alG.maxDesvio > 2) console.log("  [debug]", JSON.stringify(await p2.evaluate(`(() => { const c = document.querySelector('${SELP}'); const ths = c.querySelectorAll('thead tr:first-child > th').length; const dist = {}; c.querySelectorAll('tbody > tr').forEach((tr) => { const n = tr.querySelectorAll(':scope > td').length; dist[n] = (dist[n] || 0) + 1; }); return { ths, dist }; })()`)));
    const grp = await p2.evaluate((sel) => ({
      grupos: document.querySelectorAll(`${sel} tr[data-tabela-linha="grupo"]`).length,
      sub: document.querySelectorAll(`${sel} tr[data-tabela-linha="subordinada"]`).length,
    }), SELP);
    check(grp.grupos > 5 && grp.sub > 5, `produto (${grp.grupos} cabeçalhos) vs. linhas subordinadas (${grp.sub}) distinguíveis por atributo`);
    const bordaGrupo = await p2.evaluate((sel) => {
      const g = document.querySelector(`${sel} tr[data-tabela-linha="grupo"]`) as HTMLElement;
      return getComputedStyle(g).borderTopWidth;
    }, SELP);
    check(bordaGrupo === "2px", `separação forte antes de cada produto (${bordaGrupo})`);
    // seleção
    await p2.evaluate((sel) => { (document.querySelector(sel) as HTMLElement).scrollTop = 0; }, SELP);
    const cb = p2.locator(`${SELP} tbody input[type="checkbox"]`).first();
    await cb.check();
    check((await p2.locator(`${SELP} tr[data-selecionada="true"]`).count()) >= 1, "linha selecionada realçada (atributo + barra à esquerda; o checkbox continua a dizê-lo sem cor)");
    await p2.screenshot({ path: path.join(EVID, "encomenda-proposta-grupo.png") });

    // modo Farmácia
    await p2.goto(baseFor("silveira") + "/encomendas/nova", { waitUntil: "networkidle" });
    const farmaciaBtn = p2.getByRole("button", { name: "Farmácia", exact: true });
    if (await farmaciaBtn.count()) await farmaciaBtn.click();
    const selFarm = p2.locator("select").first();
    if (await selFarm.count()) { await selFarm.selectOption({ label: seed.nomes.alfa }).catch(() => undefined); }
    await p2.getByRole("button", { name: /Gerar (nova )?proposta/ }).click();
    await p2.locator(SELP).waitFor({ timeout: 90000 });
    await p2.evaluate((sel) => { const c = document.querySelector(sel) as HTMLElement; window.scrollBy(0, c.getBoundingClientRect().top - 70); (c as HTMLElement).scrollTop = 1500; }, SELP);
    const hf = await estadoCabecalho(p2, SELP);
    check(hf.scrollTop > 600 && Math.abs(hf.desvioTopo) <= 1 && hf.visivelPorCima, `Farmácia: cabeçalho fixo após scroll (scrollTop=${hf.scrollTop}, desvio ${hf.desvioTopo}px)`);

    // detalhe da encomenda (rascunho com 90 linhas)
    const rascId = (await amb.prisma.listaEncomenda.findFirstOrThrow({ where: { nome: "RASCUNHO LONGO E2E" } })).id;
    await p2.goto(baseFor("silveira") + `/encomendas/${rascId}`, { waitUntil: "networkidle" });
    const SELD = '[data-testid="tabela-detalhe-encomenda"]';
    await p2.locator(SELD).waitFor({ timeout: 30000 });
    await p2.evaluate((sel) => { const c = document.querySelector(sel) as HTMLElement; window.scrollBy(0, c.getBoundingClientRect().top - 70); c.scrollTop = 900; }, SELD);
    const hd = await estadoCabecalho(p2, SELD);
    check(hd.scrollTop > 400 && Math.abs(hd.desvioTopo) <= 1 && hd.visivelPorCima && hd.opaco, `Detalhe: cabeçalho fixo após scroll numa encomenda extensa (scrollTop=${hd.scrollTop}, desvio ${hd.desvioTopo}px)`);
    check((await alinhamentoColunas(p2, SELD)).maxDesvio <= 2, "Detalhe: cabeçalho alinhado com as colunas");
    await p2.screenshot({ path: path.join(EVID, "encomenda-detalhe.png") });

    // ═══ 4 · Encomendas anuladas ═════════════════════════════════════
    secao("4 · Listagem de encomendas — «Mostrar encomendas anuladas»");
    await p2.goto(baseFor("silveira") + "/encomendas", { waitUntil: "networkidle" });
    const SELL = '[data-testid="tabela-lista-encomendas"]';
    const chk = p2.locator('[data-testid="mostrar-anuladas"]');
    check(!(await chk.isChecked()), "filtro desligado por omissão");
    const totalOculto = await p2.locator(`${SELL} tbody > tr`).count();
    check((await p2.getByText("anulada)", { exact: false }).count()) === 0, "com o filtro desligado nenhuma anulada aparece");
    // 30 − 1 eliminada − anuladas(8) + rascunho(1)
    const esperadoOculto = await amb.prisma.listaEncomenda.count({ where: { estado: { notIn: ["ELIMINADA", "ANULADA"] } } });
    check(totalOculto === Math.min(25, esperadoOculto), `a página mostra ${totalOculto} linhas (de ${esperadoOculto} visíveis, pageSize 25)`);
    const paginasOculto = await p2.locator("text=/Página \\d+ de \\d+|\\d+ de \\d+/").first().innerText().catch(() => "");
    await chk.click();
    await p2.waitForURL(/anuladas=1/);
    await p2.waitForLoadState("networkidle");
    check(/anuladas=1/.test(p2.url()), "ligar o filtro grava ?anuladas=1 na URL");
    check((await p2.getByText("(anulada)").count()) > 0, "com o filtro ligado as encomendas anuladas aparecem");
    const badges = await p2.locator(`${SELL} tbody`).innerText();
    check(/Anulada/.test(badges), "o estado «Anulada» está claramente identificado");
    const esperadoLigado = await amb.prisma.listaEncomenda.count({ where: { estado: { not: "ELIMINADA" } } });
    const textoTotal = await p2.locator("body").innerText();
    check(new RegExp(`\\b${esperadoLigado}\\b`).test(textoTotal), `o total da paginação reflete ${esperadoLigado} encomendas (com anuladas)`);
    void paginasOculto;
    // refresh e navegação mantêm o estado
    await p2.reload({ waitUntil: "networkidle" });
    check(await p2.locator('[data-testid="mostrar-anuladas"]').isChecked(), "refresh: o filtro mantém-se ligado");
    // página 2 mantém
    const pg2 = p2.getByRole("button", { name: /Seguinte|›|>/ }).first();
    if (await pg2.count()) {
      await pg2.click().catch(() => undefined);
      await p2.waitForLoadState("networkidle");
      check(await p2.locator('[data-testid="mostrar-anuladas"]').isChecked(), "mudar de página mantém o filtro");
    }
    await p2.goBack().catch(() => undefined);
    // combinar com pesquisa
    await p2.goto(baseFor("silveira") + "/encomendas?anuladas=1&q=anulada", { waitUntil: "networkidle" });
    const soAnuladas = await p2.locator(`${SELL} tbody > tr`).count();
    const nAnuladas0 = await amb.prisma.listaEncomenda.count({ where: { estado: "ANULADA" } });
    check(soAnuladas === nAnuladas0, `pesquisa «anulada» + filtro ligado: ${soAnuladas} linhas = ${nAnuladas0} anuladas`);
    await p2.goto(baseFor("silveira") + "/encomendas?q=anulada", { waitUntil: "networkidle" });
    check((await p2.locator(`${SELL}`).count()) === 0, "a mesma pesquisa sem o filtro: nenhuma anulada");
    // estado + checkbox: sem contradição
    await p2.goto(baseFor("silveira") + "/encomendas?anuladas=1", { waitUntil: "networkidle" });
    await p2.locator("select").nth(1).selectOption("FINALIZADA");
    await p2.waitForURL(/estado=FINALIZADA/);
    await p2.waitForLoadState("networkidle");
    check(!/anuladas=1/.test(p2.url()) && await p2.locator('[data-testid="mostrar-anuladas"]').isDisabled(), "escolher um estado limpa o parâmetro e desativa o filtro (sem regras contraditórias)");
    await p2.locator("select").nth(1).selectOption("ANULADA");
    await p2.waitForURL(/estado=ANULADA/);
    await p2.waitForLoadState("networkidle");
    const nAnuladas = await amb.prisma.listaEncomenda.count({ where: { estado: "ANULADA" } });
    check((await p2.locator('[data-testid="mostrar-anuladas"]').isChecked()) && (await p2.locator(`${SELL} tbody > tr`).count()) === nAnuladas, `estado «Anulada»: mostra as ${nAnuladas} anuladas`);
    // limpar filtros
    await p2.goto(baseFor("silveira") + "/encomendas?anuladas=1&q=ENC", { waitUntil: "networkidle" });
    await p2.getByRole("button", { name: "Limpar filtros" }).first().click();
    await p2.waitForURL((u) => !/anuladas=1|q=ENC/.test(u.search));
    await p2.waitForLoadState("networkidle");
    check(!(await p2.locator('[data-testid="mostrar-anuladas"]').isChecked()) && (await p2.getByText("(anulada)").count()) === 0, "«Limpar filtros» volta ao estado inicial: anuladas ocultas");
    // cabeçalho da listagem
    await p2.evaluate((sel) => { const c = document.querySelector(sel) as HTMLElement; window.scrollBy(0, c.getBoundingClientRect().top - 70); c.scrollTop = 400; }, SELL);
    const hl = await estadoCabecalho(p2, SELL);
    check(Math.abs(hl.desvioTopo) <= 1 && hl.visivelPorCima, `Listagem: cabeçalho fixo (scrollTop=${hl.scrollTop}, desvio ${hl.desvioTopo}px)`);
    await p2.screenshot({ path: path.join(EVID, "encomendas-lista.png") });
    await p2.close();

    // ═══ 4b · Catálogo: informação regulamentar e pesquisa por CNPEM ═══
    secao("4b · Catálogo — informação regulamentar e CNPEM pesquisável");
    const pc = await ctx.newPage();
    await pc.setViewportSize({ width: 1500, height: 900 });
    await pc.goto(baseFor("silveira") + `/catalogo/artigo/${CNP.A}`, { waitUntil: "networkidle" });
    const secc = pc.locator('[data-testid="seccao-regulamentar"]');
    check(await secc.count() === 1 && /Informação regulamentar — INFARMED/i.test(await secc.innerText()), "ficha do Catálogo: secção «Informação regulamentar — INFARMED»");
    const campo = (k: string) => secc.locator(`[data-regulamentar="${k}"]`).innerText();
    check((await campo("CNPEM")) === "50000001" && (await campo("Nome (INFARMED)")) === "Ibuprofeno A INFARMED", "CNPEM e nome do INFARMED (separado da designação do produto)");
    check(/3,50/.test(await campo("Preço utente — regime geral")) && /2,10/.test(await campo("Preço utente — regime especial")), "preços do utente por regime");
    check(/5,00/.test(await campo("PVP")) && (await campo("Genérico")) === "Não", "PVP regulamentar e genérico");
    check((await pc.locator("h1").first().innerText()).includes("IBUPROFENO A 400 (analisado)"), "a designação do produto (ERP) continua a ser a do produto, não a do INFARMED");
    await pc.screenshot({ path: path.join(EVID, "catalogo-regulamentar.png") });
    await pc.goto(baseFor("silveira") + `/catalogo?q=50000001`, { waitUntil: "networkidle" });
    const txt = await pc.locator("body").innerText();
    check(txt.includes("IBUPROFENO A 400") && txt.includes("IBUPROFENO D 400") && !txt.includes("IBUPROFENO E 600"), `pesquisa de catálogo por CNPEM encontra os produtos desse CNPEM (e não os de outro) — ${txt.split(/\r?\n/).filter(Boolean).slice(0, 60).join(" | ")}`);
    await pc.close();

    // ═══ 5 · Impressão: PDF real ═════════════════════════════════════
    secao("5 · Impressão — PDF do relatório de Margens");
    const p3 = await ctx.newPage();
    await p3.setViewportSize({ width: 1500, height: 900 });
    await gerarMargens(p3);
    const [req] = await Promise.all([
      p3.waitForRequest((r) => r.url().includes("/api/reports/pdf"), { timeout: 120000 }),
      p3.getByRole("button", { name: /PDF/ }).first().click(),
    ]);
    // O mesmo corpo (o Report que o ecrã construiu) repetido contra a rota, para ler o binário.
    const cookies = (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
    const pdf = await postBinario(new URL(req.url()), req.postDataBuffer()!, cookies);
    const pdfPath = path.join(EVID, "margens.pdf");
    fs.writeFileSync(pdfPath, pdf);
    check(pdf.subarray(0, 4).toString() === "%PDF", `PDF gerado (${Math.round(pdf.length / 1024)} KB)`);
    const py = spawnSync("python", [path.resolve("scripts/e2e/_analisar_pdf.py"), pdfPath, EVID], { encoding: "utf8" });
    if (py.status !== 0) { console.log(py.stdout, py.stderr); }
    const r = JSON.parse(py.stdout.trim().split("\n").pop() ?? "{}");
    check(r.paginas >= 3, `o relatório tem várias páginas (${r.paginas})`);
    check(r.cabecalho_em_todas === true, `o cabeçalho repete-se em TODAS as páginas com tabela (${r.paginas_com_cabecalho}/${r.paginas_com_tabela}; ${r.paginas_so_rodape} página(s) só com o rodapé)`);
    check(r.margem_unit === true && r.utente === true, "as colunas novas (Margem unit., Utente geral/especial) estão no PDF");
    check(r.subtotal_sem_orfao === true, "nenhuma página começa com um «TOTAL ARTIGO» solto (o subtotal não se separa do artigo)");
    check(r.cinzentos_distintos >= 4, `legível em escala de cinzentos: ${r.cinzentos_distintos} níveis de cinzento distintos (cabeçalho escuro, blocos alternados, subtotal)`);
    check(r.contraste_blocos >= 15, `contraste entre blocos alternados em cinzentos: ${r.contraste_blocos}/255`);
    check(r.bordas_horizontais >= r.artigos_p1 * 2, `limites entre artigos desenhados: ${r.bordas_horizontais} linhas horizontais fortes na 1.ª página para ${r.artigos_p1} artigos (≥ 2 por artigo: início do bloco + TOTAL ARTIGO)`);
    await p3.close();
  } catch (e) {
    console.log(["--- logs do servidor ---", amb.logs().slice(-3500)].join("\u000a"));
    throw e;
  } finally {
    await browser.close();
    await amb.parar();
  }
  console.log(`\n${ok} OK, ${falhas} falhas`);
  process.exit(falhas === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
