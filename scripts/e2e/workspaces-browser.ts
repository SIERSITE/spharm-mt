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
import { createHash } from "node:crypto";
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

async function testeConsolidacaoRespostaPerdida(ctx: BrowserContext) {
  console.log("\nConsolidação · resposta perdida (fluxo visível ao utilizador)");
  const db = new Client({ connectionString: DB });
  await db.connect();
  const nListas = async () => (await db.query(`SELECT count(*)::int n FROM "ListaEncomenda"`)).rows[0].n as number;
  const limpar = async () => { await db.query(`DELETE FROM "ListaEncomenda"`); };
  const page = await ctx.newPage();
  page.on("dialog", (d) => void d.accept());

  // Prepara uma consolidação de 3 farmácias no ecrã (as 3 têm stock 1 → as 3 compram).
  const prepararProposta = async () => {
    await page.goto(BASE + "/encomendas/nova", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Consolidação", exact: true }).click();
    await page.getByRole("button", { name: /Gerar (nova )?proposta/ }).click();
    await page.getByText("ARTIGO E2E 6").first().waitFor({ state: "attached", timeout: 30000 });
  };
  const chaveLS = async () => page.evaluate(() => Object.keys(localStorage).find((k) => k.startsWith("spharmmt:consolidacao-pendente:")) ?? null);
  const lerOp = async () => page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.startsWith("spharmmt:consolidacao-pendente:"));
    return k ? (JSON.parse(localStorage.getItem(k)!) as { estado: string; chave: string; farmaciaIds: string[] }) : null;
  });
  /** A 1.ª submissão chega ao servidor (commit) mas a resposta perde-se; ou nem chega (`chegar=false`). */
  const perderProximaResposta = async (chegar: boolean) => {
    let feito = false;
    await page.route("**/encomendas/nova**", async (route) => {
      const req = route.request();
      if (!feito && req.method() === "POST" && (req.postData() ?? "").includes("batchKey")) {
        feito = true;
        if (chegar) await route.fetch(); // o servidor recebe e faz commit…
        await route.abort("connectionreset"); // …e a resposta nunca chega ao browser
        return;
      }
      await route.continue();
    });
  };
  const guardar = () => page.getByRole("button", { name: "Guardar rascunho" }).click();

  // ── A · commit feito, resposta perdida, edição, novo clique ────────────
  await limpar();
  await prepararProposta();
  await perderProximaResposta(true);
  await guardar();
  await page.getByTestId("consolidacao-pendente").getByText("Resultado da consolidação desconhecido").waitFor({ timeout: 20000 });
  check(true, "A1: resposta perdida → o ecrã mostra «Resultado da consolidação desconhecido»");
  check((await nListas()) === 3, "A2: o servidor fez commit das 3 listas (a resposta é que se perdeu)");
  const opA = await lerOp();
  check(opA?.estado === "RESULTADO_DESCONHECIDO" && opA.farmaciaIds.length === 3, "A3: operação persistida no browser como RESULTADO_DESCONHECIDO, com as 3 farmácias");
  const chaveOriginal = opA?.chave;

  const qtd = page.locator('input[type="number"][value="7"]').first();
  await qtd.fill("15"); // o utilizador altera uma quantidade
  await guardar(); // e tenta prosseguir
  await page.getByTestId("consolidacao-pendente").getByText("Lote de consolidação recuperado").waitFor({ timeout: 20000 });
  check(true, "A4: ao prosseguir, reconcilia primeiro e mostra «Lote de consolidação recuperado»");
  check(await visivel(page, "Não foi criado nenhum lote novo"), "A5: o utilizador é informado de que o lote anterior foi recuperado e nada novo foi criado");
  check((await nListas()) === 3, "A6: continuam a existir apenas 3 listas — nenhum segundo lote");
  const opA2 = await lerOp();
  check(opA2?.estado === "CONCLUIDA" && opA2.chave === chaveOriginal, "A7: a operação ficou CONCLUIDA com a chave original (nenhuma chave nova)");
  const sem15 = await db.query(`SELECT count(*)::int n FROM "LinhaEncomenda" WHERE "quantidadeAjustada"=15`);
  check(sem15.rows[0].n === 0, "A8: a edição posterior não foi aplicada em silêncio ao lote recuperado");
  await guardar();
  await page.waitForTimeout(1500);
  check((await nListas()) === 3, "A9: voltar a clicar em Guardar continua a não criar outro lote");

  // decisão explícita
  await page.getByRole("button", { name: "Criar novo lote com as alterações" }).click();
  await page.waitForFunction(() => location.pathname === "/encomendas", null, { timeout: 20000 });
  check((await nListas()) === 6, "A10: só a acção explícita cria o 2.º lote");
  const com15 = await db.query(`SELECT count(*)::int n FROM "LinhaEncomenda" WHERE "quantidadeAjustada"=15`);
  check(com15.rows[0].n >= 1, "A11: o novo lote contém as alterações");

  // ── B · refresh durante RESULTADO_DESCONHECIDO ─────────────────────────
  await page.unroute("**/encomendas/nova**");
  await limpar();
  await prepararProposta();
  await perderProximaResposta(true);
  await guardar();
  await page.getByTestId("consolidacao-pendente").waitFor({ timeout: 20000 });
  const chaveB = (await lerOp())?.chave;
  await page.unroute("**/encomendas/nova**");
  await page.reload({ waitUntil: "networkidle" });
  check((await chaveLS()) !== null, "B1: o registo da operação sobreviveu ao refresh");
  await page.getByTestId("consolidacao-pendente").getByText("Lote de consolidação recuperado").waitFor({ timeout: 20000 });
  check((await nListas()) === 3 && (await lerOp())?.chave === chaveB, "B2: depois do refresh, a reconciliação recupera o lote (3 listas, mesma chave) sem criar outro");
  await page.getByRole("button", { name: "Continuar os rascunhos criados" }).click();
  await page.waitForFunction(() => location.pathname === "/encomendas", null, { timeout: 15000 });
  check((await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("spharmmt:consolidacao-pendente:")).length)) === 0,
    "B3: «Continuar os rascunhos criados» encerra a operação pendente");

  // ── C · o servidor realmente NÃO fez commit ────────────────────────────
  await limpar();
  await prepararProposta();
  await perderProximaResposta(false);
  await guardar();
  await page.getByTestId("consolidacao-pendente").getByText("Resultado da consolidação desconhecido").waitFor({ timeout: 20000 });
  check((await nListas()) === 0, "C1: o pedido não chegou ao servidor — nada criado");
  const chaveC = (await lerOp())?.chave;
  await page.unroute("**/encomendas/nova**");
  await qtd.fill("21");
  await guardar(); // reconcilia (NAO_ENCONTRADA) e repete com a MESMA chave
  await page.waitForFunction(() => location.pathname === "/encomendas", null, { timeout: 30000 });
  check((await nListas()) === 3, "C2: o retry cria apenas UM lote de 3");
  const farmaciasBd = (await db.query(`SELECT id FROM "Farmacia"`)).rows as Array<{ id: string }>;
  const chavesDerivadas = farmaciasBd.map((f) => createHash("sha256").update(`${chaveC}:${f.id}`).digest("hex"));
  const comChaveOriginal = await db.query(`SELECT count(*)::int n FROM "ListaEncomenda" WHERE "clientIdempotencyKey" = ANY($1)`, [chavesDerivadas]);
  check(comChaveOriginal.rows[0].n === 3, "C2b: o retry reutilizou a chave ORIGINAL (mesma intenção)");
  const com21 = await db.query(`SELECT count(*)::int n FROM "LinhaEncomenda" WHERE "quantidadeAjustada"=21`);
  check(com21.rows[0].n >= 1, "C3: o lote criado no retry traz a edição feita entretanto");

  await db.end();
  await page.close();
}

async function testeConsolidacaoFinalizar(ctx: BrowserContext) {
  console.log("\nConsolidação · «Criar encomendas» (finalizar e enviar para a fila) — só até à outbox");
  const db = new Client({ connectionString: DB });
  await db.connect();
  const um = async (sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows[0] as Record<string, number | string>;
  const estado = async () => ({
    listas: (await um(`SELECT count(*)::int n FROM "ListaEncomenda"`)).n as number,
    finalizadas: (await um(`SELECT count(*)::int n FROM "ListaEncomenda" WHERE estado='FINALIZADA'`)).n as number,
    outbox: (await um(`SELECT count(*)::int n FROM "OrderOutbox"`)).n as number,
    outboxPorLista: (await um(`SELECT count(DISTINCT "listaEncomendaId")::int n FROM "OrderOutbox"`)).n as number,
    pendentes: (await um(`SELECT count(*)::int n FROM "OrderOutbox" WHERE state='PENDENTE' AND "attemptCount"=0`)).n as number,
    auditoriaEnvio: (await um(`SELECT count(*)::int n FROM "OrderExportAudit"`)).n as number,
  });
  const limpar = async () => { await db.query(`DELETE FROM "ListaEncomenda"`); };
  const page = await ctx.newPage();
  page.on("dialog", (d) => void d.accept());

  const preparar = async () => {
    await page.goto(BASE + "/encomendas/nova", { waitUntil: "networkidle" });
    await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("spharmmt:consolidacao-pendente:")).forEach((k) => localStorage.removeItem(k)));
    await page.getByRole("button", { name: "Consolidação", exact: true }).click();
    await page.getByRole("button", { name: /Gerar (nova )?proposta/ }).click();
    await page.getByText("ARTIGO E2E 6").first().waitFor({ state: "attached", timeout: 30000 });
  };
  const lerOp = async () => page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.startsWith("spharmmt:consolidacao-pendente:"));
    return k ? (JSON.parse(localStorage.getItem(k)!) as { estado: string; chave: string }) : null;
  });
  // UM só handler de rede para toda a função (sem register/unregister repetidos):
  // quando armado, o próximo pedido de criação chega ao servidor (commit) e a resposta é abortada.
  let perderResposta = false;
  await page.route("**/encomendas/nova**", async (route) => {
    const req = route.request();
    if (perderResposta && req.method() === "POST" && (req.postData() ?? "").includes("batchKey") && (req.postData() ?? "").includes('"lotes"')) {
      perderResposta = false;
      await route.fetch(); // o servidor faz commit (lista + outbox)…
      await route.abort("connectionreset"); // …e a resposta perde-se
      return;
    }
    await route.continue();
  });
  const perderProximaResposta = async () => { perderResposta = true; };
  const finalizar = () => page.getByRole("button", { name: "Criar encomendas" }).click();
  const banner = () => page.getByTestId("consolidacao-pendente");

  // ── D · finalização directa ────────────────────────────────────────────
  await limpar();
  await preparar();
  await finalizar();
  await page.waitForFunction(() => location.pathname === "/encomendas", null, { timeout: 30000 });
  let e = await estado();
  check(e.listas === 3, "D1: «Criar encomendas» cria o número correto de encomendas (3 farmácias → 3)");
  check(e.finalizadas === 3, "D2: todas ficam no estado final esperado (FINALIZADA)");
  check(e.outbox === 3 && e.outboxPorLista === 3, "D3: exactamente uma outbox por encomenda (3 outbox, 3 listas distintas)");
  check(e.pendentes === 3, "D4: as 3 outbox ficam PENDENTE, 0 tentativas — nada foi processado");
  check(e.auditoriaEnvio === 0, "D5: nenhum registo de exportação/envio (o ensaio pára na criação da outbox; nenhum worker/agente corre)");
  const semOp = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("spharmmt:consolidacao-pendente:")).length);
  check(semOp === 0, "D6: sucesso directo não deixa operação pendente");

  // ── E · commit feito (lista + outbox), resposta perdida, edição, novo clique ──
  await limpar();
  await preparar();
  await perderProximaResposta();
  await finalizar();
  await banner().getByText("Resultado da consolidação desconhecido").waitFor({ timeout: 20000 });
  e = await estado();
  check(e.listas === 3 && e.finalizadas === 3 && e.outbox === 3, "E1: o servidor fez commit das 3 listas FINALIZADAS e das 3 outbox; a resposta perdeu-se");
  const opE = await lerOp();
  check(opE?.estado === "RESULTADO_DESCONHECIDO", "E2: cliente em RESULTADO_DESCONHECIDO");
  await page.locator('input[type="number"][value="7"]').first().fill("15");
  await finalizar();
  await banner().getByText("Lote de consolidação recuperado").waitFor({ timeout: 20000 });
  e = await estado();
  check(e.listas === 3 && e.outbox === 3 && e.outboxPorLista === 3, "E3: reconciliado — continuam 3 listas e 3 outbox (nenhuma duplicada)");
  check(e.pendentes === 3 && e.auditoriaEnvio === 0, "E4: as outbox continuam por processar; nenhum envio");
  check((await lerOp())?.chave === opE?.chave, "E5: a chave original manteve-se (nenhuma chave nova)");
  check((await um(`SELECT count(*)::int n FROM "LinhaEncomenda" WHERE "quantidadeAjustada"=15`)).n === 0, "E6: a edição posterior não foi aplicada em silêncio ao lote já finalizado");
  await finalizar();
  await page.waitForTimeout(1500);
  e = await estado();
  check(e.listas === 3 && e.outbox === 3, "E7: voltar a clicar em «Criar encomendas» não duplica listas nem outbox");

  // ── F · refresh recupera o lote finalizado ─────────────────────────────
  await limpar();
  await preparar();
  await perderProximaResposta();
  await finalizar();
  await banner().waitFor({ timeout: 20000 });
  await page.reload({ waitUntil: "networkidle" });
  await banner().getByText("Lote de consolidação recuperado").waitFor({ timeout: 20000 });
  e = await estado();
  check(e.listas === 3 && e.finalizadas === 3 && e.outbox === 3 && e.outboxPorLista === 3, "F1: o refresh recupera o lote finalizado (3 FINALIZADAS, 3 outbox)");
  check(e.pendentes === 3 && e.auditoriaEnvio === 0, "F2: sem qualquer envio");
  await page.getByRole("button", { name: "Continuar os rascunhos criados" }).click();
  await page.waitForFunction(() => location.pathname === "/encomendas", null, { timeout: 15000 });

  // ── G · lote alheio / conflito continua bloqueado ──────────────────────
  await limpar();
  await preparar();
  await perderProximaResposta();
  await finalizar();
  await banner().waitFor({ timeout: 20000 });
  await db.query(
    `INSERT INTO "Utilizador"(id,email,nome,perfil,"dataAtualizacao") VALUES ('outro-user-e2e','outro@spharm.test','Outro','ADMINISTRADOR',now()) ON CONFLICT (email) DO NOTHING`
  );
  const antesG = await estado();
  await db.query(`UPDATE "ListaEncomenda" SET "criadoPorId"=(SELECT id FROM "Utilizador" WHERE email='outro@spharm.test')`); // o lote passa a ser de outro utilizador
  await page.getByRole("button", { name: "Verificar estado no servidor" }).click();
  await banner().getByText("Consolidação bloqueada").waitFor({ timeout: 20000 });
  check(true, "G1: lote de outro utilizador → «Consolidação bloqueada»");
  await finalizar();
  await page.waitForTimeout(1500);
  const depoisG = await estado();
  check(depoisG.listas === antesG.listas && depoisG.outbox === antesG.outbox, "G2: continuar a clicar não cria nem altera nada (3 listas, 3 outbox)");
  check((await lerOp())?.estado === "CONFLITO", "G3: a operação fica em CONFLITO (nova criação automática bloqueada)");
  check(!(await page.getByRole("button", { name: "Criar novo lote com as alterações" }).isVisible().catch(() => false)),
    "G4: em conflito não é oferecido «Criar novo lote» — só o utilizador dono do lote decide");

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
    await testeConsolidacaoRespostaPerdida(ctx);
    await testeConsolidacaoFinalizar(ctx);
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
