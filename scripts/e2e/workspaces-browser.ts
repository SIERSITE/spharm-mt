/**
 * scripts/e2e/workspaces-browser.ts
 *
 * Ensaio de browser real (Chromium via `playwright`) contra uma instância
 * LOCAL de `next start` ligada a um PostgreSQL DESCARTÁVEL com dados
 * sintéticos. Nunca contra uma base real.
 *
 *   docker run -d --name spharm-ws-test-pg -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:16-alpine
 *   # criar base, `prisma migrate deploy`, `npm run build`, `next start -p 3100` com
 *   #   ALLOW_LEGACY_DATABASE_FALLBACK=1 AUTH_SECRET=<E2E_AUTH_SECRET> DATABASE_URL=<E2E_DATABASE_URL>
 *   npm run test:e2e-workspaces
 *
 * A sessão é um JWT forjado com o AUTH_SECRET de teste (perfil ADMINISTRADOR,
 * tenant legacy) — não passa pelo formulário de login.
 */
import { chromium, type BrowserContext, type Page } from "playwright";
import { SignJWT } from "jose";
import { Client } from "pg";
import { seedE2E, type SeedResult } from "./seed-e2e";

const DB = process.env.E2E_DATABASE_URL ?? "postgresql://postgres:test@localhost:55432/spharm_e2e";
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3100";
const SECRET = process.env.E2E_AUTH_SECRET ?? "e2e-test-secret-e2e-test-secret-0123456789";
for (const u of [DB, BASE]) {
  const h = new URL(u).hostname;
  if (h !== "localhost" && h !== "127.0.0.1") {
    console.error(`RECUSADO: ${h} não é local.`);
    process.exit(2);
  }
}

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  [OK]    ${msg}`); }
  else { failed++; console.log(`  [FALHA] ${msg}`); }
}

async function novaSessao(browser: import("playwright").Browser, seed: SeedResult): Promise<BrowserContext> {
  const token = await new SignJWT({
    sub: seed.userId, email: "e2e@spharm.test", nome: "E2E Admin", perfil: "ADMINISTRADOR", farmaciaId: null, tenant: "__legacy__",
  }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("8h").sign(new TextEncoder().encode(SECRET));
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: "session", value: token, url: BASE }]);
  return ctx;
}

const workspaceDe = (url: string) => new URL(url).searchParams.get("workspace");
async function esperaWorkspace(page: Page): Promise<string> {
  await page.waitForFunction(() => new URL(location.href).searchParams.has("workspace"), null, { timeout: 15000 });
  return workspaceDe(page.url())!;
}
const visivel = async (page: Page, texto: string) => (await page.getByText(texto, { exact: false }).count()) > 0;

type Modulo = { nome: string; path: string; pesquisa: string; gerar: string };
const MODULOS: Modulo[] = [
  { nome: "Vendas", path: "/vendas", pesquisa: 'input[placeholder^="Pesquisar por CNP"]', gerar: "Gerar" },
  { nome: "Margens", path: "/relatorios/margens", pesquisa: 'input[placeholder="Pesquisar CNP ou descrição"]', gerar: "Gerar" },
  { nome: "Inventário", path: "/relatorios/inventario", pesquisa: 'input[placeholder="Pesquisar CNP ou descrição"]', gerar: "Gerar" },
  { nome: "Transferências", path: "/transferencias", pesquisa: 'input[placeholder="Código ou descrição"]', gerar: "Gerar relatório" },
  { nome: "Excessos", path: "/excessos", pesquisa: 'input[placeholder="Código ou descrição"]', gerar: "Gerar relatório" },
];

async function testeModulo(ctx: BrowserContext, m: Modulo) {
  console.log(`\n${m.nome} · dois workspaces independentes`);
  const page = await ctx.newPage();
  await page.goto(BASE + m.path, { waitUntil: "networkidle" });
  const wsA = await esperaWorkspace(page);
  check(await page.getByRole("button", { name: /Nova análise/ }).isVisible(), `${m.nome}: barra de tarefas visível (botão «Nova análise»)`);

  // A: pesquisa artigo 1 e gera
  await page.locator(m.pesquisa).fill("5000101");
  await page.getByRole("button", { name: m.gerar, exact: true }).click();
  await page.getByText("ARTIGO E2E 1").first().waitFor({ timeout: 30000 });
  check(!(await visivel(page, "ARTIGO E2E 2")), `${m.nome}: A gerou só o artigo 1`);
  const urlA = page.url();

  // B: nova análise → vazia (nada de A) → artigo 2
  await page.getByRole("button", { name: /Nova análise/ }).click();
  await page.waitForFunction((w) => new URL(location.href).searchParams.get("workspace") !== w, wsA, { timeout: 15000 });
  const wsB = workspaceDe(page.url())!;
  await page.waitForLoadState("networkidle");
  check(wsB !== wsA, `${m.nome}: «Nova análise» abre um workspace diferente`);
  check((await page.locator(m.pesquisa).inputValue()) === "", `${m.nome}: B começa com critérios limpos (nada herdado de A)`);
  check(!(await visivel(page, "ARTIGO E2E 1")), `${m.nome}: B não mostra resultados de A`);
  await page.locator(m.pesquisa).fill("5000102");
  await page.getByRole("button", { name: m.gerar, exact: true }).click();
  await page.getByText("ARTIGO E2E 2").first().waitFor({ timeout: 30000 });
  check(!(await visivel(page, "ARTIGO E2E 1")), `${m.nome}: B gerou só o artigo 2`);

  // A → B → A: volta a A pela barra de tarefas (nome do separador = título da tarefa; usa o href)
  await page.goto(BASE + urlA.replace(BASE, ""), { waitUntil: "networkidle" });
  check(workspaceDe(page.url()) === wsA, `${m.nome}: voltar a A mantém o workspace A na URL`);
  check((await page.locator(m.pesquisa).inputValue()) === "5000101", `${m.nome}: A→B→A preserva o critério de A`);
  check(!(await visivel(page, "ARTIGO E2E 2")), `${m.nome}: resultados de B nunca aparecem em A`);

  // refresh preserva o workspace e o critério
  await page.reload({ waitUntil: "networkidle" });
  check(workspaceDe(page.url()) === wsA && (await page.locator(m.pesquisa).inputValue()) === "5000101", `${m.nome}: refresh preserva workspace e critério`);
  check(!(await visivel(page, "ARTIGO E2E 2")), `${m.nome}: após refresh continua sem dados de B`);

  // B continua intacto
  await page.goto(BASE + `${m.path}?workspace=${wsB}`, { waitUntil: "networkidle" });
  check((await page.locator(m.pesquisa).inputValue()) === "5000102", `${m.nome}: B guardou o seu próprio critério`);
  await page.close();
}

async function testeNavegacaoLivre(ctx: BrowserContext) {
  console.log("\nRegressão · sair de uma página com workspace (ciclo infinito na barra de tarefas)");
  const page = await ctx.newPage();
  for (const m of MODULOS) {
    await page.goto(BASE + m.path, { waitUntil: "networkidle" });
    await esperaWorkspace(page);
    await page.waitForTimeout(1500);
    await page.evaluate(() => (window as unknown as { next: { router: { push(u: string): void } } }).next.router.push("/dashboard"));
    const saiu = await page.waitForURL(/\/dashboard/, { timeout: 8000 }).then(() => true).catch(() => false);
    check(saiu, `${m.nome}: a navegação para fora da página funciona (não fica congelada)`);
  }
  await page.close();
}

async function testeOrdenacaoEPainel(ctx: BrowserContext) {
  console.log("\nOrdenação (Vendas) e painel da ficha do artigo (Margens)");
  const page = await ctx.newPage();
  await page.goto(BASE + "/vendas", { waitUntil: "networkidle" });
  const wsA = await esperaWorkspace(page);
  const ordem = page.locator("select").filter({ has: page.locator('option[value="totalVendas"]') });
  const valores = await ordem.locator("option").evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value));
  const alvo = valores.find((v) => v !== "totalVendas") ?? valores[valores.length - 1];
  await ordem.selectOption(alvo);
  await page.getByRole("button", { name: /Nova análise/ }).click();
  await page.waitForFunction((w) => new URL(location.href).searchParams.get("workspace") !== w, wsA, { timeout: 15000 });
  check((await page.locator("select").filter({ has: page.locator('option[value="totalVendas"]') }).inputValue()) === "totalVendas", "Vendas: B tem a ordenação por omissão");
  await page.goto(BASE + `/vendas?workspace=${wsA}`, { waitUntil: "networkidle" });
  check((await page.locator("select").filter({ has: page.locator('option[value="totalVendas"]') }).inputValue()) === alvo, "Vendas: A→B→A preserva a ordenação escolhida em A");

  await page.goto(BASE + "/relatorios/margens", { waitUntil: "networkidle" });
  const wsM = await esperaWorkspace(page);
  await page.locator('input[placeholder="Pesquisar CNP ou descrição"]').fill("5000103");
  await page.getByRole("button", { name: "Gerar", exact: true }).click();
  await page.getByText("ARTIGO E2E 3").first().waitFor({ timeout: 30000 });
  await page.locator('a[href="/stock/artigo/5000103"]').first().click();
  const dialogo = page.getByRole("dialog");
  await dialogo.waitFor({ timeout: 15000 });
  check(await dialogo.isVisible(), "Margens: a ficha do artigo abre no painel lateral");
  check(workspaceDe(page.url()) === wsM, "Margens: abrir o painel mantém o workspace na URL");
  await dialogo.getByRole("button", { name: "Fechar" }).first().click();
  await dialogo.waitFor({ state: "detached", timeout: 10000 });
  check(
    workspaceDe(page.url()) === wsM && (await page.locator('input[placeholder="Pesquisar CNP ou descrição"]').inputValue()) === "5000103",
    "Margens: fechar o painel mantém a análise (workspace e critério)"
  );
  check(await visivel(page, "ARTIGO E2E 3"), "Margens: o resultado gerado continua no ecrã depois de fechar o painel");
  await page.close();
}

async function testeEncomendas(ctx: BrowserContext) {
  console.log("\nEncomendas · rascunho eager, autosave, restauro, conflito, lista");
  const db = new Client({ connectionString: DB });
  await db.connect();
  await db.query(`DELETE FROM "ListaEncomenda"`);
  const page = await ctx.newPage();
  const dialogos: string[] = [];
  page.on("dialog", (d) => { dialogos.push(`${d.type()}: ${d.message()}`); void d.accept(); });
  // O 1.º rascunho conta como encomenda pendente e zera as sugestões da farmácia;
  // para o 2.º desliga-se «Considerar stock e pendentes» (sugestão só por vendas).
  const gerarRascunho = async (ignorarStockEPendentes = false) => {
    await page.goto(BASE + "/encomendas/nova", { waitUntil: "networkidle" });
    if (ignorarStockEPendentes) await page.locator('input[type="checkbox"]').first().uncheck();
    await page.getByRole("button", { name: "Gerar proposta" }).click();
    await page.getByText("ARTIGO E2E 6").first().waitFor({ timeout: 30000 });
    await page.waitForFunction(() => new URL(location.href).searchParams.has("rascunho"), null, { timeout: 20000 });
    return new URL(page.url()).searchParams.get("rascunho")!;
  };

  const idA = await gerarRascunho();
  check(!!idA, "gerar a proposta cria o rascunho (?rascunho=<id> na URL)");
  const nA = await db.query(`SELECT count(*)::int n FROM "LinhaEncomenda" WHERE "listaEncomendaId"=$1`, [idA]);
  check(nA.rows[0].n === 6, "o rascunho persistiu as 6 linhas de uma vez");
  const chave = await db.query(`SELECT "clientIdempotencyKey" k, "clientRequestHash" h FROM "ListaEncomenda" WHERE id=$1`, [idA]);
  check(!!chave.rows[0].k && !!chave.rows[0].h, "o rascunho foi criado com chave de idempotência e hash do pedido");

  // editar quantidade → A guardar… → Guardado
  await page.locator('input[type="number"][value="7"]').first().fill("11");
  const viuAGuardar = await page.getByText("A guardar…").first().waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
  await page.getByText(/Guardado às/).first().waitFor({ timeout: 15000 });
  check(true, `edição de quantidade mostra «Guardado às …»${viuAGuardar ? " (e «A guardar…» observado)" : " («A guardar…» rápido demais para observar)"}`);
  const q = await db.query(
    `SELECT max("quantidadeAjustada")::int m, (SELECT versao FROM "ListaEncomenda" WHERE id=$1) v FROM "LinhaEncomenda" WHERE "listaEncomendaId"=$1`,
    [idA]
  );
  check(q.rows[0].m === 11 && q.rows[0].v >= 1, "a quantidade editada e a versão avançada estão na base de dados");

  // refresh restaura as linhas
  await page.reload({ waitUntil: "networkidle" });
  check(dialogos.length === 0, `refresh sem diálogos de «alterações por guardar» (${dialogos.length ? dialogos.join(" | ") : "nenhum"})`);
  await page.getByText("Rascunho retomado").first().waitFor({ timeout: 15000 }).catch(async () => {
    console.log("  DEBUG url:", page.url());
    console.log("  DEBUG texto:", (await page.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 700));
  });
  await page.getByText("ARTIGO E2E 6").first().waitFor({ state: "attached", timeout: 30000 });
  check(new URL(page.url()).searchParams.get("rascunho") === idA, "refresh mantém o rascunho na URL");
  const vals = await page.locator('input[type="number"]').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
  check(vals.includes("11"), "refresh restaura a quantidade editada (11) — nunca a proposta original");
  check((await page.getByText("ARTIGO E2E").count()) >= 6, "refresh restaura todas as linhas");

  // segundo rascunho coexiste
  const idB = await gerarRascunho(true);
  check(idB !== idA, "um segundo rascunho independente é criado");
  const total = await db.query(`SELECT count(*)::int n FROM "ListaEncomenda" WHERE estado='RASCUNHO'`);
  check(total.rows[0].n === 2, "dois rascunhos coexistem na base de dados");

  // conflito de versão: outra sessão avança a versão do rascunho B
  await db.query(`UPDATE "ListaEncomenda" SET versao = versao + 5 WHERE id=$1`, [idB]);
  await page.locator('input[type="number"][value="7"]').first().fill("13");
  const conflito = await page.getByText("Conflito de versão").first().waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
  check(conflito, "conflito de versão é apresentado claramente («Conflito de versão»)");
  const naoGravou = await db.query(`SELECT count(*)::int n FROM "LinhaEncomenda" WHERE "listaEncomendaId"=$1 AND "quantidadeAjustada"=13`, [idB]);
  check(naoGravou.rows[0].n === 0, "o conflito não sobrescreveu os dados da outra sessão");

  // lista de encomendas
  await page.goto(BASE + "/encomendas", { waitUntil: "networkidle" });
  check((await page.getByText("Continuar").count()) >= 2, "a lista de encomendas mostra os rascunhos com «Continuar»");
  await page.getByText("Continuar").first().click();
  await page.waitForURL(/rascunho=|\/encomendas\//, { timeout: 15000 });
  check(true, "«Continuar» abre o rascunho");

  await db.end();
  await page.close();
}

async function main() {
  const seed = await seedE2E(DB);
  const browser = await chromium.launch();
  const ctx = await novaSessao(browser, seed);
  try {
    for (const m of MODULOS) await testeModulo(ctx, m);
    await testeNavegacaoLivre(ctx);
    await testeOrdenacaoEPainel(ctx);
    await testeEncomendas(ctx);
  } finally {
    await browser.close();
  }
  console.log(`\n${passed} ok, ${failed} falhas`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
