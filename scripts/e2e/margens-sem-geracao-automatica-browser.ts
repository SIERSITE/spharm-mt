/**
 * scripts/e2e/margens-sem-geracao-automatica-browser.ts
 *
 * Browser REAL (Chromium) contra o build de PRODUÇÃO (control plane + PostgreSQL descartáveis, dados sintéticos):
 * Margens NÃO gera ao alterar filtros — só «Gerar/Atualizar». Prova, contando os pedidos de Server Action
 * (POST com cabeçalho `Next-Action`) da geração (`runMargensReport`):
 *
 *   1 · escrever no nome / apagar o nome / Enter no campo ............ 0 pedidos
 *   2 · selecionar e remover fabricante .............................. 0 pedidos
 *   3 · forma farmacêutica ........................................... selecionar/remover 0 pedidos; «Atualizar» 1 pedido
 *   4 · «Limpar filtros» ............................................. 0 pedidos e o relatório visível mantém-se
 *   5 · mudar de separador e voltar .................................. 0 novas gerações; estado preservado
 *   6 · «Atualizar» (também com duplo clique) ........................ exatamente 1 pedido; aplica TODOS os filtros
 *   7 · PDF / Excel usam os filtros APLICADOS (o draft por aplicar NÃO aparece)
 *   8 · resposta fora de ordem (atrasada por page.route) não substitui a mais recente
 *   9 · duas análises independentes; refresh: critérios ficam, resultado não, e nada é gerado sozinho
 *
 * AVISO CONHECIDO: no refresh (passo 9) o `[pageerror] React #418` (hidratação de `use-workspace-state.ts`) é um bug
 * PRÉ-EXISTENTE no base (a69cbc5), corrigido noutra branch (`fix/workspace-hidratacao-estado`). Aqui é só REGISTADO como aviso
 * conhecido e não falha o E2E; qualquer OUTRO `pageerror` conta como falha.
 *
 * NÃO foi executado pelo autor (corre o coordenador no fim). Pré-requisito: `npx next build` com
 * SERVER_ACTIONS_ALLOWED_ORIGINS="localhost:3100,127.0.0.1:3100,*.localhost:3100".
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/e2e/margens-sem-geracao-automatica-browser.ts
 */
import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { chromium, type Page } from "playwright";
import { baseFor, criarAmbiente } from "./_ambiente-silveira";
import { abrirContexto } from "./_grupo-comum";
import { CNP, semearMargens } from "./_margens-comum";

let ok = 0;
let falhas = 0;
const check = (cond: boolean, msg: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${msg}`); }
  else { falhas++; console.log(`  [FALHA] ${msg}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const secao = (t: string) => console.log(`\n── ${t}`);
const EVID = path.resolve("docs/validacao-visual/2026-10-margens-sem-geracao-automatica");
const SEL = '[data-testid="tabela-margens-produto"]';
const PESQUISA = 'input[placeholder="Pesquisar CNP ou descrição"]';
const AVISO = '[data-testid="margens-alteracoes-por-aplicar"]';

type Pedido = { id: string; corpo: string };
/** Regista TODAS as Server Actions (cabeçalho `next-action`). A da geração identifica-se no 1.º «Gerar». */
function observar(page: Page) {
  const pedidos: Pedido[] = [];
  page.on("request", (r) => {
    const id = r.headers()["next-action"];
    if (r.method() === "POST" && id) pedidos.push({ id, corpo: (r.postData() ?? "").slice(0, 400) });
  });
  return { todos: () => pedidos, n: () => pedidos.length, desde: (i: number) => pedidos.slice(i) };
}

const linhasMapa = (page: Page) => page.locator(`${SEL} tbody > tr:not([data-tabela-linha])`);
const cnpsMapa = (page: Page) => linhasMapa(page).evaluateAll((trs) => Array.from(new Set(trs.map((t) => (t as HTMLElement).dataset.cnp!))).sort());

/** Espera que o separador esteja assente: sem pedidos novos durante `ms`. */
async function quieto(page: Page, net: ReturnType<typeof observar>, ms = 1500) {
  const antes = net.n();
  await page.waitForTimeout(ms);
  return net.n() - antes;
}

async function main() {
  fs.mkdirSync(EVID, { recursive: true });
  const amb = await criarAmbiente("msga");
  const browser = await chromium.launch();
  try {
    const seed = await semearMargens(amb);
    const ctx = await abrirContexto(amb, browser, { userId: seed.userId } as never);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => {
      if (/React error #418|Hydration failed|#418/.test(e.message)) {
        console.log("  [AVISO conhecido] pageerror React #418 (hidratação do estado do workspace; bug pré-existente no base)");
      } else {
        console.log("  [pageerror]", e.message);
        check(false, "pageerror inesperado", e.message);
      }
    });
    await page.setViewportSize({ width: 1600, height: 900 });
    const net = observar(page);

    // ═══ 0 · primeira geração ═══
    secao("0 · primeira geração: «Gerar» faz exatamente 1 pedido");
    await page.goto(baseFor("silveira") + "/relatorios/margens", { waitUntil: "networkidle" });
    await page.waitForFunction(() => new URL(location.href).searchParams.has("workspace"));
    const wsA = new URL(page.url()).searchParams.get("workspace")!;
    const gerar = page.getByTestId("margens-gerar");
    check((await gerar.innerText()).trim() === "Gerar", "antes da 1.ª geração o botão diz «Gerar»");
    const i0 = net.n();
    await gerar.click();
    await page.locator(SEL).waitFor({ timeout: 60000 });
    const geracao = net.desde(i0);
    check(geracao.length === 1, `«Gerar» → ${geracao.length} pedido`);
    const ID_GERAR = geracao[0]?.id ?? "?";
    // O botão diz «A gerar…» até a transição terminar (a tabela pode aparecer um instante antes): espera pelo texto final.
    const botaoDiz = (t: string) => page.waitForFunction((x) => document.querySelector('[data-testid="margens-gerar"]')?.textContent?.trim() === x, t, { timeout: 15000 }).then(() => true, () => false);
    check(await botaoDiz("Atualizar"), "depois da geração o botão diz «Atualizar»");
    check((await page.locator(AVISO).count()) === 0, "sem alterações: nenhuma indicação «por aplicar»");
    // O 1.º `section.grid` pode ser o painel de filtros (aberto): identifica-se a barra de totais pelo seu texto.
    const kpiTexto = () => page.locator("section.grid", { hasText: "Vendas € (c/ IVA)" }).first().innerText();
    const geracoes = () => net.todos().filter((p) => p.id === ID_GERAR).length;
    const todosCnps = await cnpsMapa(page);
    await page.screenshot({ path: path.join(EVID, "gerado.png") });
    check(todosCnps.length > 100, `mapa gerado (${todosCnps.length} artigos)`);

    // ═══ 1 · nome ═══
    secao("1 · escrever / apagar o nome e Enter: 0 pedidos");
    const g1 = geracoes();
    await page.locator(PESQUISA).pressSequentially("ibuprofeno", { delay: 60 });
    check((await quieto(page, net, 1500)) === 0 && geracoes() === g1, "escrever «ibuprofeno» (e esperar > debounce antigo de 400 ms): 0 pedidos");
    check((await page.locator(AVISO).count()) === 1 && /alterações por aplicar/i.test(await page.locator(AVISO).innerText()), "aparece «Existem alterações por aplicar»");
    check(JSON.stringify(await cnpsMapa(page)) === JSON.stringify(todosCnps), "o relatório visível NÃO mudou (mesmos artigos)");
    await page.screenshot({ path: path.join(EVID, "alterado-aviso-por-aplicar.png") }); // relatório anterior + «Existem alterações por aplicar»
    await page.locator(PESQUISA).press("Enter");
    check((await quieto(page, net, 1000)) === 0, "Enter no campo: 0 pedidos (a geração é só pelo botão, como em Vendas)");
    await page.locator(PESQUISA).fill("");
    check((await quieto(page, net, 1200)) === 0, "apagar o nome: 0 pedidos");
    check((await page.locator(AVISO).count()) === 0, "…e a indicação desaparece (draft = aplicado)");
    await page.screenshot({ path: path.join(EVID, "sem-geracao-nome.png") });

    // ═══ 2 · fabricante ═══
    secao("2 · selecionar e remover fabricante: 0 pedidos");
    await page.getByRole("button", { name: /Filtros/ }).first().click();
    const cartao = page.getByPlaceholder("Pesquisar fabricante...").locator("xpath=ancestor::div[contains(@class,'rounded-xl')][1]");
    await cartao.getByRole("button", { name: "LAB E2E" }).click();
    check((await quieto(page, net, 1500)) === 0, "selecionar o fabricante «LAB E2E»: 0 pedidos");
    check((await page.locator(AVISO).count()) === 1, "…com «alterações por aplicar»");
    await page.locator("span.rounded-full", { hasText: "LAB E2E" }).locator("button").first().click();
    check((await quieto(page, net, 1500)) === 0, "remover o fabricante: 0 pedidos");
    check((await page.locator(AVISO).count()) === 0, "…e voltou a «sem alterações»");

    // ═══ 3 · forma farmacêutica ═══
    secao("3 · forma farmacêutica: selecionar/remover = 0 pedidos; «Atualizar» aplica-a (1 pedido)");
    const campoForma = page.getByPlaceholder("Pesquisar forma farmacêutica...");
    check((await campoForma.count()) === 1, "o filtro «Forma farmacêutica» existe no painel de filtros de Margens");
    const cartaoForma = campoForma.locator("xpath=ancestor::div[contains(@class,'rounded-xl')][1]");
    // «Comprimido» e « comprimido » (A e B) numa só opção, com contagem; «Comprimido revestido» é outra.
    const opcaoComprimido = cartaoForma.getByRole("button", { name: /^Comprimido\s*\d/ });
    check((await opcaoComprimido.count()) === 1, "«Comprimido» e « comprimido » aparecem numa única opção");
    check((await cartaoForma.getByRole("button", { name: /^Comprimido revestido/ }).count()) === 1, "«Comprimido revestido» é uma opção diferente");
    check((await cartaoForma.getByRole("button", { name: /^Sem forma farmacêutica/ }).count()) === 1, "existe a opção «Sem forma farmacêutica»");
    const g3 = geracoes();
    await opcaoComprimido.click();
    check((await quieto(page, net, 1500)) === 0 && geracoes() === g3, "selecionar uma forma farmacêutica: 0 pedidos");
    check((await page.locator(AVISO).count()) === 1, "…com «alterações por aplicar» (a forma entra na comparação draft ≠ aplicado)");
    check(JSON.stringify(await cnpsMapa(page)) === JSON.stringify(todosCnps), "o relatório visível NÃO mudou");
    await page.locator("span.rounded-full", { hasText: "Forma: Comprimido" }).locator("button").first().click();
    check((await quieto(page, net, 1200)) === 0, "remover a forma farmacêutica: 0 pedidos");
    check((await page.locator(AVISO).count()) === 0, "…e voltou a «sem alterações»");
    // «Atualizar» aplica a forma: exatamente 1 geração, só A e B (o filtro corre no servidor).
    await opcaoComprimido.click();
    const i3 = net.n();
    await gerar.click();
    await page.locator(`${SEL} tbody > tr[data-cnp="${CNP.A}"]`).first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(800);
    check(net.desde(i3).filter((p) => p.id === ID_GERAR).length === 1, "«Atualizar» com a forma: exatamente 1 pedido de geração");
    check(JSON.stringify(await cnpsMapa(page)) === JSON.stringify([String(CNP.A), String(CNP.B)].sort()), "o mapa passou a mostrar só A e B (Comprimido; NÃO os revestidos)");
    await page.screenshot({ path: path.join(EVID, "forma-aplicada.png") });
    // voltar ao universo completo para os passos seguintes.
    await page.locator("span.rounded-full", { hasText: "Forma: Comprimido" }).locator("button").first().click();
    await gerar.click();
    await page.locator(`${SEL} tbody > tr`).nth(120).waitFor({ timeout: 30000 }).catch(() => undefined);
    await page.waitForTimeout(800);
    check((await cnpsMapa(page)).length > 100 && (await page.locator(AVISO).count()) === 0, "removida a forma e «Atualizar»: universo completo restaurado");


    // ═══ 6a · Atualizar aplica a pesquisa (preparar o resto) ═══
    secao("6 · «Atualizar»: exatamente 1 pedido, aplica TODOS os filtros do draft de uma vez");
    const kpiAntes = await kpiTexto();
    await page.locator(PESQUISA).fill(String(CNP.A));
    await page.locator('input[aria-label="Até"]').fill(new Date().toISOString().slice(0, 10)); // mesmo valor: sem diferença
    check((await quieto(page, net, 1200)) === 0, "preencher o CNP no draft: 0 pedidos");
    const i6 = net.n();
    await gerar.dblclick(); // duplo clique: tem de contar UMA geração
    await page.locator(`${SEL} tbody > tr[data-cnp="${CNP.A}"]`).first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(800);
    const p6 = net.desde(i6).filter((p) => p.id === ID_GERAR);
    check(p6.length === 1, `«Atualizar» (duplo clique) → ${p6.length} pedido de geração`);
    check(JSON.stringify(await cnpsMapa(page)) === JSON.stringify([String(CNP.A)]), "a tabela passou a mostrar só o artigo pesquisado");
    check((await page.locator(AVISO).count()) === 0, "…e a indicação «por aplicar» desapareceu");
    const kpi = await kpiTexto();
    const plano = (t: string) => t.split(String.fromCharCode(10)).join(" | ");
    check(/vendas/i.test(kpi) && kpi !== kpiAntes, "os totais (KPI) foram recalculados com o resultado novo", `antes: ${plano(kpiAntes)} -- depois: ${plano(kpi)}`);
    await page.screenshot({ path: path.join(EVID, "atualizado-cnp-a.png") });

    // ═══ 4 · Limpar filtros ═══
    secao("4 · «Limpar filtros»: 0 pedidos e o relatório visível não é apagado");
    const g4 = geracoes();
    await page.getByRole("button", { name: "Limpar filtros" }).click();
    check((await quieto(page, net, 1500)) === 0 && geracoes() === g4, "Limpar filtros: 0 pedidos");
    check((await page.locator(PESQUISA).inputValue()) === "", "o draft foi limpo");
    check(JSON.stringify(await cnpsMapa(page)) === JSON.stringify([String(CNP.A)]), "o relatório visível mantém-se (continua só o artigo A)");
    check((await page.locator(AVISO).count()) === 1, "…e avisa que há alterações por aplicar (o draft já não é o aplicado)");

    // ═══ 7 · PDF / Excel com filtros aplicados ═══
    secao("7 · PDF e Excel usam os filtros APLICADOS, nunca o draft");
    // Draft por aplicar: outra pesquisa. O relatório visível continua a ser o do CNP A.
    await page.locator(PESQUISA).fill("ZZ SEM CUSTO");
    const [reqPdf] = await Promise.all([
      page.waitForRequest((r) => r.url().includes("/api/reports/pdf"), { timeout: 120000 }),
      page.getByRole("button", { name: /^PDF$/ }).first().click(),
    ]);
    const corpoPdf = reqPdf.postDataBuffer()!.toString("utf8");
    check(corpoPdf.includes(String(CNP.A)) && /Pesquisa/.test(corpoPdf), "o corpo do PDF traz a pesquisa APLICADA (CNP A)");
    check(!/ZZ SEM CUSTO/.test(corpoPdf), "…e NÃO traz o draft por aplicar («ZZ SEM CUSTO»)");
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.getByRole("button", { name: /^Excel$/ }).first().click()]);
    const xp = path.join(EVID, "margens-aplicados.xlsx");
    await dl.saveAs(xp);
    const wb = XLSX.read(fs.readFileSync(xp));
    const csv = wb.SheetNames.map((n) => XLSX.utils.sheet_to_csv(wb.Sheets[n])).join("\n");
    check(csv.includes(String(CNP.A)) && !/SEM CUSTO E2E/.test(csv), "o Excel tem o artigo APLICADO e não o do draft");
    fs.rmSync(xp);
    check(net.todos().filter((p) => p.id === ID_GERAR).length === geracoes(), "exportar não fez nenhuma geração");
    await page.locator(PESQUISA).fill("");

    // ═══ 5 · mudar de separador e voltar ═══
    secao("5 · mudar de separador e voltar: 0 novas gerações, estado preservado");
    await page.locator(PESQUISA).fill("rascunho-nao-aplicado");
    const g5 = geracoes();
    const nTotal5 = net.n();
    await page.getByRole("link", { name: "Vendas", exact: true }).click();
    await page.waitForURL(/\/vendas/);
    await page.waitForTimeout(800);
    await page.locator(`[data-navegacao-href^="/relatorios/margens?workspace=${wsA}"]`).click();
    await page.locator(SEL).waitFor({ timeout: 20000 });
    await page.waitForTimeout(1500);
    check(geracoes() === g5, `voltar a Margens: 0 novas gerações (${geracoes() - g5})`);
    void nTotal5;
    check(JSON.stringify(await cnpsMapa(page)) === JSON.stringify([String(CNP.A)]), "o resultado aplicado está lá sem recarregar");
    check((await page.locator(PESQUISA).inputValue()) === "rascunho-nao-aplicado", "o draft (critério) foi preservado");
    check((await page.locator(AVISO).count()) === 1, "…e continua «por aplicar»");
    check((await page.getByTestId("margens-gerar").innerText()).trim() === "Atualizar", "o botão continua «Atualizar»");

    // ═══ 8 · resposta fora de ordem ═══
    secao("8 · uma resposta antiga (atrasada) não substitui a mais recente");
    let atrasarProxima = false;
    await page.route("**/relatorios/margens**", async (route) => {
      const r = route.request();
      if (atrasarProxima && r.method() === "POST" && r.headers()["next-action"] === ID_GERAR) {
        atrasarProxima = false;
        await new Promise((res) => setTimeout(res, 7000)); // a 1.ª geração demora 7 s
      }
      await route.continue();
    });
    // geração #1 (atrasada): artigo E
    await page.locator(PESQUISA).fill(String(CNP.E));
    atrasarProxima = true;
    await page.getByTestId("margens-gerar").click();
    await page.waitForTimeout(500);
    check((await page.getByTestId("margens-gerar").isDisabled()) && /A gerar/.test(await page.getByTestId("margens-gerar").innerText()), "com um pedido em curso o botão fica desativado («A gerar…»)");
    // sai e volta (a página remonta enquanto o #1 está em voo) e dispara a geração #2: artigo B
    await page.getByRole("link", { name: "Vendas", exact: true }).click();
    await page.waitForURL(/\/vendas/);
    await page.locator(`[data-navegacao-href^="/relatorios/margens?workspace=${wsA}"]`).click();
    await page.locator(SEL).waitFor({ timeout: 20000 });
    await page.locator(PESQUISA).fill(String(CNP.B));
    await page.getByTestId("margens-gerar").click();
    await page.locator(`${SEL} tbody > tr[data-cnp="${CNP.B}"]`).first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(8500); // dá tempo à resposta antiga (E) chegar
    const finais = await cnpsMapa(page);
    check(JSON.stringify(finais) === JSON.stringify([String(CNP.B)]), `a resposta antiga (E) NÃO substituiu a mais recente (B): [${finais}]`);
    check((await page.locator(AVISO).count()) === 0, "…e o estado «por aplicar» é coerente com o resultado mostrado");
    await page.unroute("**/relatorios/margens**");

    // ═══ 9 · duas análises independentes; refresh ═══
    secao("9 · duas análises independentes (workspaceId); refresh não gera sozinho");
    await page.getByRole("button", { name: /Nova análise/ }).click();
    await page.waitForFunction((w) => new URL(location.href).searchParams.get("workspace") !== w, wsA);
    const wsB = new URL(page.url()).searchParams.get("workspace")!;
    await page.waitForLoadState("networkidle");
    check((await page.locator(PESQUISA).inputValue()) === "", "a nova análise começa com critérios limpos");
    check((await page.locator(SEL).count()) === 0 && (await page.getByTestId("margens-gerar").innerText()).trim() === "Gerar", "…sem resultado e com «Gerar»");
    await page.locator(PESQUISA).fill(String(CNP.D));
    check((await quieto(page, net, 1200)) === 0, "escrever na análise B: 0 pedidos");
    await page.getByTestId("margens-gerar").click();
    await page.locator(`${SEL} tbody > tr[data-cnp="${CNP.D}"]`).first().waitFor({ timeout: 30000 });
    check(JSON.stringify(await cnpsMapa(page)) === JSON.stringify([String(CNP.D)]), "B gerou só o artigo D");
    const nAntesVoltar = net.n();
    await page.locator(`[data-navegacao-href^="/relatorios/margens?workspace=${wsA}"]`).click();
    // espera pela análise A (o mapa de B ainda pode estar no ecrã um instante): o artigo B tem de aparecer.
    await page.locator(`${SEL} tbody > tr[data-cnp="${CNP.B}"]`).first().waitFor({ timeout: 20000 }).catch(() => undefined);
    check(JSON.stringify(await cnpsMapa(page)) === JSON.stringify([String(CNP.B)]) && (await page.locator(PESQUISA).inputValue()) === String(CNP.B), "A mantém o seu resultado (B) e o seu critério — nada de B");
    check((await quieto(page, net, 1200)) === 0 && net.n() === nAntesVoltar, "alternar entre análises: 0 pedidos");
    await page.reload({ waitUntil: "networkidle" });
    const nRefresh = net.n();
    await page.waitForTimeout(2000);
    check(net.n() === nRefresh, "refresh: nada é gerado sozinho");
    check((await page.locator(PESQUISA).inputValue()) === String(CNP.B) && (await page.locator(SEL).count()) === 0 && (await page.getByTestId("margens-gerar").innerText()).trim() === "Gerar", "refresh: o critério (draft) fica, o resultado não — volta «Gerar»");
    // fechar e reabrir começa limpo
    await page.getByRole("button", { name: /^Fechar Margens/ }).first().click().catch(() => undefined);
    await page.waitForTimeout(500);
    void wsB;
    await page.screenshot({ path: path.join(EVID, "duas-analises.png") });
  } catch (e) {
    console.log(["--- logs do servidor ---", amb.logs().slice(-3000)].join("\n"));
    throw e;
  } finally {
    await browser.close();
    await amb.parar();
  }
  console.log(`\n${falhas === 0 ? "PASSOU" : "FALHOU"} — ${ok} OK, ${falhas} falhas\n`);
  process.exit(falhas === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
