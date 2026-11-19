/**
 * scripts/e2e/ultima-atualizacao.e2e.ts
 *
 * E2E em BROWSER REAL (Playwright/Chromium) do bloco «Última atualização» no fundo do
 * menu lateral. A data entra pelo MESMO caminho que a do agent em produção: POST
 * autenticado (chave de ingestão + tenant) a /api/admin/pipeline/record.
 *
 * ── Segurança ──────────────────────────────────────────────────────────
 * Só corre contra bases LOCAIS descartáveis (recusa hosts que não sejam localhost/127.0.0.1).
 * APAGA e recria dados nelas. Todos os nomes são sintéticos.
 *
 * ── Preparação ─────────────────────────────────────────────────────────
 * E2E_DB_CONTROL, E2E_DB_LEGACY, E2E_DB_SILVEIRA, E2E_DB_GARANTIA; build de produção a correr
 * em localhost:3100 (tenants em <slug>.localhost:3100); TENANT_ENCRYPTION_SECRET igual ao do
 * servidor. Capturas em E2E_EVIDENCIA (default docs/validacao-ultima-atualizacao).
 *
 * Corre com: npx tsx scripts/e2e/ultima-atualizacao.e2e.ts
 */
import bcrypt from "bcryptjs";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { PrismaClient as ControlClient } from "../../generated/prisma-control/client";
import { encryptTenantSecret } from "../../lib/tenant-crypto";
import { formatarAtualizacao, TEXTO_SEM_ATUALIZACAO } from "../../lib/ultima-atualizacao-core";

const PORT = process.env.E2E_PORT ?? "3100";
const base = (slug: string) => `http://${slug}.localhost:${PORT}`;
const PASSWORD = "E2e-Pass-123!";
const INGEST_KEY = "e2e-ingest-key-e2e-ingest-key-0001";
const EVID = path.resolve(process.env.E2E_EVIDENCIA ?? "docs/validacao-ultima-atualizacao");
mkdirSync(EVID, { recursive: true });

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) {
    ok++;
    console.log(`  [OK]    ${label}`);
  } else {
    ko++;
    console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`);
  }
};

function urlLocal(envVar: string): URL {
  const v = process.env[envVar];
  if (!v) {
    console.error(`Falta ${envVar}. Ver o cabeçalho deste ficheiro.`);
    process.exit(2);
  }
  const u = new URL(v);
  if (u.hostname !== "localhost" && u.hostname !== "127.0.0.1") {
    console.error(`[recusado] ${envVar} aponta para "${u.hostname}" — só bases locais descartáveis.`);
    process.exit(2);
  }
  return u;
}
const db = (envVar: string) => new PrismaClient({ adapter: new PrismaPg({ connectionString: urlLocal(envVar).toString() }) });
const TERMOS_TECNICOS = /\b(agent|agente|heartbeat|ingest\w*|ingest[ãa]o|fila|outbox|api|token|endpoint|integra[çc][ãa]o|sync)\b/i;

async function limpar(c: PrismaClient) {
  await c.pipelineRun.deleteMany();
  await c.syncRequest.deleteMany();
  await c.auditLog.deleteMany();
  await c.utilizadorFarmacia.deleteMany().catch(() => {});
  await c.utilizador.deleteMany();
  await c.farmacia.deleteMany();
}

async function login(browser: Browser, slug: string, email: string, viewport?: { width: number; height: number }): Promise<BrowserContext> {
  const ctx = await browser.newContext(viewport ? { viewport } : undefined);
  const page = await ctx.newPage();
  await page.goto(`${base(slug)}/login`);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  await Promise.all([page.waitForURL(/\/dashboard/, { timeout: 60_000 }), page.click('button[type="submit"]')]);
  await page.close();
  return ctx;
}

async function abrir(ctx: BrowserContext, url: string): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  return page;
}

/** Linhas do bloco como [nome, texto] — só do menu visível. */
async function linhasBloco(page: Page): Promise<Array<[string, string]>> {
  const loc = page.locator('[data-testid="ultima-atualizacao-farmacia"]:visible');
  await page.locator('[data-testid="ultima-atualizacao"]:visible').first().waitFor({ state: "visible", timeout: 30_000 });
  const n = await loc.count();
  const out: Array<[string, string]> = [];
  for (let i = 0; i < n; i++) {
    const partes = (await loc.nth(i).innerText()).split("\n").map((s) => s.trim()).filter(Boolean);
    out.push([partes[0] ?? "", partes[1] ?? ""]);
  }
  return out;
}

/** O que o agent faz: POST autenticado, a partir do browser (o Node não resolve *.localhost). */
async function receber(ctx: BrowserContext, slug: string, corpo: Record<string, unknown>): Promise<{ status: number; corpo: string }> {
  const page = await ctx.newPage();
  try {
    await page.goto(`${base(slug)}/login`, { waitUntil: "domcontentloaded" });
    return await page.evaluate(
      async ({ k, s, b }) => {
        const r = await fetch("/api/admin/pipeline/record", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${k}`, "x-tenant-slug": s },
          body: JSON.stringify(b),
        });
        return { status: r.status, corpo: await r.text() };
      },
      { k: INGEST_KEY, s: slug, b: corpo },
    );
  } finally {
    await page.close();
  }
}

async function main() {
  const control = new ControlClient({ adapter: new PrismaPg({ connectionString: urlLocal("E2E_DB_CONTROL").toString() }) });
  await control.tenant.deleteMany();
  const chaveHash = await bcrypt.hash(INGEST_KEY, 10);
  const dbs: Record<string, PrismaClient> = {};
  for (const t of [
    { slug: "silveira", nome: "Grupo Um (sintético)", env: "E2E_DB_SILVEIRA" },
    { slug: "garantia", nome: "Grupo Dois (sintético)", env: "E2E_DB_GARANTIA" },
  ]) {
    const u = urlLocal(t.env);
    await control.tenant.create({
      data: {
        slug: t.slug, nome: t.nome, estado: "ACTIVE",
        dbHost: u.hostname, dbPort: Number(u.port || 5432), dbName: u.pathname.slice(1),
        dbUser: decodeURIComponent(u.username), dbPassEncrypted: encryptTenantSecret(decodeURIComponent(u.password)),
        ingestApiKeyHash: chaveHash,
      },
    });
    dbs[t.slug] = db(t.env);
    await limpar(dbs[t.slug]);
  }
  const hash = await bcrypt.hash(PASSWORD, 10);
  const mkUser = (c: PrismaClient, email: string, nome: string, perfil: "ADMINISTRADOR" | "GESTOR_GRUPO" | "OPERADOR", farmaciaId: string | null) =>
    c.utilizador.create({ data: { email, nome, perfil, passwordHash: hash, farmaciaId } });

  // Grupo Um: 2 farmácias. Grupo Dois: 5 farmácias (a 5.ª nunca recebeu nada).
  const sil = dbs.silveira;
  const s1 = await sil.farmacia.create({ data: { nome: "Farmácia Central" } });
  const s2 = await sil.farmacia.create({ data: { nome: "Farmácia do Mercado" } });
  await mkUser(sil, "admin@um.pt", "Utilizador Exemplo", "ADMINISTRADOR", null);
  await mkUser(sil, "operador@um.pt", "Operador Exemplo", "OPERADOR", s2.id);
  const gar = dbs.garantia;
  const nomesG = ["Farmácia Norte", "Farmácia Sul", "Farmácia Oriente", "Farmácia Poente", "Farmácia Jardim"];
  const g: Array<{ id: string; nome: string }> = [];
  for (const n of nomesG) g.push(await gar.farmacia.create({ data: { nome: n } }));
  await mkUser(gar, "admin@dois.pt", "Utilizador Exemplo", "ADMINISTRADOR", null);

  const browser = await chromium.launch();
  // tsx/esbuild injeta `__name` nas funções passadas a page.evaluate; o browser não o conhece.
  const novoContexto = browser.newContext.bind(browser);
  browser.newContext = (async (...a: Parameters<typeof novoContexto>) => {
    const c = await novoContexto(...a);
    await c.addInitScript("window.__name = (f) => f;");
    return c;
  }) as typeof browser.newContext;
  try {
    const ctxS = await login(browser, "silveira", "admin@um.pt");
    const ctxG = await login(browser, "garantia", "admin@dois.pt");

    console.log("\n1 · antes de qualquer receção: «Sem atualização disponível» em todas");
    let p = await abrir(ctxS, `${base("silveira")}/dashboard`);
    let l = await linhasBloco(p);
    check(l.length === 2 && l.every(([, t]) => t === TEXTO_SEM_ATUALIZACAO), "2 farmácias, cada uma com «Sem atualização disponível»", JSON.stringify(l));
    await p.close();

    console.log("\n2 · receção real (POST como o agent): a data é a do SERVIDOR");
    const antes = Date.now();
    const r1 = await receber(ctxS, "silveira", { farmaciaId: s1.id, kind: "daily-pipeline", status: "OK", dateRef: "2026-11-18", startedAt: "2020-01-01T00:00:00Z", finishedAt: "2020-01-01T00:05:00Z", idempotencyKey: "e2e-s1", details: { steps: [] } });
    check(r1.status === 200 || r1.status === 201, "endpoint aceitou a corrida de S1", `${r1.status} ${r1.corpo.slice(0, 160)}`);
    const row1 = await sil.pipelineRun.findFirstOrThrow({ where: { idempotencyKey: "e2e-s1" } });
    check(Math.abs(row1.updatedAt.getTime() - antes) < 60_000, "updatedAt = relógio do servidor (o agent afirmava 2020)");
    p = await abrir(ctxS, `${base("silveira")}/dashboard`);
    l = await linhasBloco(p);
    check(l[0][0] === "Farmácia Central" && l[0][1] === formatarAtualizacao(row1.updatedAt.toISOString()), "S1 mostra a data real recebida", JSON.stringify(l));
    check(l[1][1] === TEXTO_SEM_ATUALIZACAO, "S2 continua «Sem atualização disponível» (não herda a de S1)");
    await p.close();

    console.log("\n3 · o que NÃO conta (mais recente que a receção real)");
    for (const corpo of [
      { farmaciaId: s1.id, kind: "sync-now", status: "OK", idempotencyKey: "e2e-d1", details: {} },
      { farmaciaId: s1.id, kind: "daily-pipeline", status: "PARTIAL", dateRef: "2026-11-19", idempotencyKey: "e2e-d2", details: {} },
      { farmaciaId: s1.id, kind: "daily-pipeline", status: "ERROR", dateRef: "2026-11-19", idempotencyKey: "e2e-d3", details: {} },
      { farmaciaId: s1.id, kind: "aggregate-month", status: "OK", dateRef: "2026-11", idempotencyKey: "e2e-d4", details: {} },
      { farmaciaId: s2.id, kind: "sync-now", status: "OK", idempotencyKey: "e2e-d5", details: {} },
    ]) {
      const r = await receber(ctxS, "silveira", corpo);
      check(r.status === 200 || r.status === 201, `recebido ${String(corpo.kind)}/${String(corpo.status)}`, `${r.status} ${r.corpo.slice(0, 120)}`);
    }
    await sil.syncRequest.create({ data: { farmaciaId: s2.id, estado: "CONCLUIDO", requestedByUserId: (await sil.utilizador.findFirstOrThrow({ where: { email: "admin@um.pt" } })).id, timeoutAt: new Date(Date.now() + 3_600_000), finishedAt: new Date() } });
    await control.tenant.updateMany({ data: { lastAgentHeartbeatAt: new Date() } });
    p = await abrir(ctxS, `${base("silveira")}/dashboard`);
    l = await linhasBloco(p);
    check(l[0][1] === formatarAtualizacao(row1.updatedAt.toISOString()), "S1 não mudou (sync-now, PARTIAL, ERROR, agregação e heartbeat ignorados)", JSON.stringify(l));
    check(l[1][1] === TEXTO_SEM_ATUALIZACAO, "S2 continua sem atualização (sync-now e pedido concluído ignorados)");
    await p.close();

    console.log("\n4 · Grupo Um com duas farmácias, cada uma com a SUA data (sem data global)");
    const rB = await receber(ctxS, "silveira", { farmaciaId: s2.id, kind: "daily-sync", status: "OK", idempotencyKey: "e2e-s2", details: {} });
    check(rB.status === 200 || rB.status === 201, "receção de S2 (daily-sync)");
    const T1 = new Date(Date.now() - 3 * 3_600_000);
    const T2 = new Date(Date.now() - 5 * 60_000);
    await sil.$executeRaw`UPDATE "PipelineRun" SET "updatedAt" = ${T1} WHERE "idempotencyKey" = 'e2e-s1'`;
    await sil.$executeRaw`UPDATE "PipelineRun" SET "updatedAt" = ${T2} WHERE "idempotencyKey" = 'e2e-s2'`;
    p = await abrir(ctxS, `${base("silveira")}/dashboard`);
    l = await linhasBloco(p);
    check(JSON.stringify(l) === JSON.stringify([["Farmácia Central", formatarAtualizacao(T1.toISOString())], ["Farmácia do Mercado", formatarAtualizacao(T2.toISOString())]]), "cada farmácia mostra a sua data", JSON.stringify(l));
    const textoBloco = await p.locator('[data-testid="ultima-atualizacao"]:visible').first().innerText();
    check(!/Dados atualizados|mais antiga/i.test(await p.locator("body").innerText()), "não existe data global do grupo");
    check(!TERMOS_TECNICOS.test(textoBloco), "sem termos técnicos", textoBloco.match(TERMOS_TECNICOS)?.[0]);
    // sem interação
    const interativos = await p.locator('[data-testid="ultima-atualizacao"]:visible').first().evaluate((el) => ({
      botoes: el.querySelectorAll("button, a, [role=button], [tabindex]").length,
      titles: el.querySelectorAll("[title]").length,
    }));
    check(interativos.botoes === 0 && interativos.titles === 0, "sem botão, ligação, tooltip ou tabindex", JSON.stringify(interativos));
    // posição: no fundo do menu, antes do utilizador
    const geo = await p.evaluate(() => {
      const aside = document.querySelector("aside") as HTMLElement;
      const bloco = document.querySelector('[data-testid="ultima-atualizacao"]') as HTMLElement;
      const nav = aside.querySelector("nav") as HTMLElement;
      const user = Array.from(aside.querySelectorAll("div")).find((d) => /Utilizador Exemplo/.test(d.textContent ?? "") && d.children.length <= 3 && d.classList.contains("border-t")) as HTMLElement | undefined;
      const r = (e?: Element | null) => (e ? e.getBoundingClientRect() : null);
      return { aside: r(aside), bloco: r(bloco), nav: r(nav), user: r(user ?? null), vh: window.innerHeight };
    });
    check(!!geo.bloco && !!geo.nav && geo.bloco.top >= geo.nav.top, "o bloco está abaixo das opções do menu");
    check(!!geo.user && !!geo.bloco && geo.bloco.bottom <= geo.user.top + 1, "o bloco está ANTES da identificação do utilizador", JSON.stringify({ bloco: geo.bloco, user: geo.user }));
    check(!!geo.aside && geo.aside.bottom <= geo.vh + 1, "o menu ocupa a altura do ecrã (o bloco fica no fundo visível)", JSON.stringify(geo.aside));
    await p.screenshot({ path: path.join(EVID, "1-grupo-um-duas-farmacias.png") });
    await p.close();

    console.log("\n5 · Grupo Dois com cinco farmácias; uma sem atualização");
    const T = [new Date(Date.now() - 20 * 60_000), new Date(Date.now() - 2 * 3_600_000), new Date(Date.now() - 26 * 3_600_000), new Date(Date.now() - 50 * 60_000)];
    for (let i = 0; i < 4; i++) {
      const r = await receber(ctxG, "garantia", { farmaciaId: g[i].id, kind: i % 2 ? "daily-sync" : "daily-pipeline", status: "OK", idempotencyKey: `e2e-g${i}`, details: {} });
      check(r.status === 200 || r.status === 201, `receção de ${g[i].nome}`);
      await gar.$executeRaw`UPDATE "PipelineRun" SET "updatedAt" = ${T[i]} WHERE "idempotencyKey" = ${`e2e-g${i}`}`;
    }
    p = await abrir(ctxG, `${base("garantia")}/dashboard`);
    l = await linhasBloco(p);
    const esperado = nomesG.map((n, i) => [n, i < 4 ? formatarAtualizacao(T[i].toISOString()) : TEXTO_SEM_ATUALIZACAO]);
    const ordenado = [...esperado].sort((a, b) => a[0].localeCompare(b[0], "pt"));
    check(l.length === 5 && JSON.stringify(l) === JSON.stringify(ordenado), "5 farmácias, 4 com a sua data e 1 «Sem atualização disponível»", JSON.stringify(l));
    check(!/Central|Mercado/.test(await p.locator("body").innerText()), "nenhuma farmácia do outro grupo");
    await p.screenshot({ path: path.join(EVID, "2-grupo-dois-cinco-farmacias.png") });
    await p.close();

    console.log("\n6 · uma farmácia sem atualização disponível (S2 do Grupo Um, depois de limpar as suas corridas)");
    await sil.pipelineRun.deleteMany({ where: { farmaciaId: s2.id } });
    p = await abrir(ctxS, `${base("silveira")}/dashboard`);
    l = await linhasBloco(p);
    check(l[1][0] === "Farmácia do Mercado" && l[1][1] === TEXTO_SEM_ATUALIZACAO && l[0][1] === formatarAtualizacao(T1.toISOString()), "«Sem atualização disponível» por baixo do nome da farmácia", JSON.stringify(l));
    await p.screenshot({ path: path.join(EVID, "3-farmacia-sem-atualizacao.png") });
    await p.close();

    console.log("\n7 · muitas farmácias: o menu tem scroll e não esconde as opções principais");
    const extra: Array<{ id: string; nome: string }> = [];
    for (let i = 1; i <= 9; i++) extra.push(await gar.farmacia.create({ data: { nome: `Farmácia Extra ${String(i).padStart(2, "0")}` } }));
    for (const f of extra.slice(0, 5)) {
      await gar.pipelineRun.create({ data: { farmaciaId: f.id, kind: "daily-pipeline", status: "OK", startedAt: new Date(), finishedAt: new Date(), idempotencyKey: `e2e-x-${f.id}`, updatedAt: new Date(Date.now() - 3 * 3_600_000) } });
    }
    const ctxPeq = await login(browser, "garantia", "admin@dois.pt", { width: 1280, height: 600 });
    p = await abrir(ctxPeq, `${base("garantia")}/dashboard`);
    l = await linhasBloco(p);
    check(l.length === 14, "14 farmácias listadas", String(l.length));
    const g2 = await p.evaluate(() => {
      const aside = document.querySelector("aside") as HTMLElement;
      const lista = document.querySelector('[data-testid="ultima-atualizacao"] ul') as HTMLElement;
      const nav = aside.querySelector("nav") as HTMLElement;
      const navScroll = nav.parentElement as HTMLElement;
      return {
        asideBottom: aside.getBoundingClientRect().bottom, vh: window.innerHeight,
        listaScroll: lista.scrollHeight > lista.clientHeight, listaH: lista.clientHeight,
        navScroll: navScroll.scrollHeight > navScroll.clientHeight, navVisivel: navScroll.clientHeight,
      };
    });
    check(g2.asideBottom <= g2.vh + 1, "o menu não ultrapassa o ecrã (600 px de altura)", JSON.stringify(g2));
    check(g2.listaScroll, "a lista de farmácias desloca-se verticalmente", JSON.stringify(g2));
    check(g2.navVisivel >= 120, "as opções principais mantêm espaço visível (e deslocam-se se faltar)", JSON.stringify(g2));
    await p.screenshot({ path: path.join(EVID, "5-muitas-farmacias-ecra-baixo.png") });
    await p.close();
    await ctxPeq.close();
    // volta às 5 farmácias do Grupo Dois para o resto do ensaio
    await gar.pipelineRun.deleteMany({ where: { farmaciaId: { in: extra.map((f) => f.id) } } });
    await gar.farmacia.deleteMany({ where: { id: { in: extra.map((f) => f.id) } } });

    console.log("\n8 · âmbito por perfil: o operador só vê a sua farmácia");
    const ctxOp = await login(browser, "silveira", "operador@um.pt");
    p = await abrir(ctxOp, `${base("silveira")}/dashboard`);
    l = await linhasBloco(p);
    check(l.length === 1 && l[0][0] === "Farmácia do Mercado", "só «Farmácia do Mercado»", JSON.stringify(l));
    await p.close();
    await ctxOp.close();

    console.log("\n9 · não depende da seleção nos mapas e aparece em todos os ecrãs");
    for (const e of ["/dashboard", "/stock", "/vendas", "/relatorios/margens", "/relatorios/inventario", "/devolucoes", "/encomendas", "/transferencias", "/excessos", "/catalogo"]) {
      const pg = await abrir(ctxS, `${base("silveira")}${e}`);
      const n = await pg.locator('[data-testid="ultima-atualizacao-farmacia"]:visible').count();
      check(n === 2, `${e}: 2 farmácias no menu`, `n=${n} url=${pg.url()}`);
      await pg.close();
    }
    // com uma farmácia selecionada no mapa de Vendas, o menu continua a mostrar as duas
    const pv = await abrir(ctxS, `${base("silveira")}/vendas`);
    const antesSel = await pv.locator('[data-testid="ultima-atualizacao-farmacia"]:visible').count();
    await pv.getByRole("button", { name: /^Filtros/ }).first().click().catch(() => {});
    check(antesSel === 2, "em Vendas (mapa com filtros) o menu mantém as duas farmácias");
    await pv.close();

    console.log("\n10 · dois tenants, dois separadores — sem fuga");
    const pS = await abrir(ctxS, `${base("silveira")}/dashboard`);
    const pG = await abrir(ctxG, `${base("garantia")}/dashboard`);
    check(!/Norte|Sul|Oriente|Poente|Jardim/.test(await pS.locator("body").innerText()), "o HTML do Grupo Um não contém farmácias do Grupo Dois");
    check(!/Central|Mercado/.test(await pG.locator("body").innerText()), "o HTML do Grupo Dois não contém farmácias do Grupo Um");
    await pS.close();
    await pG.close();
    const cookies = await ctxS.cookies();
    const ctxCruz = await browser.newContext();
    await ctxCruz.addCookies(cookies.map((c) => ({ name: c.name, value: c.value, url: base("garantia") })));
    const cruz = await ctxCruz.newPage();
    await cruz.goto(`${base("garantia")}/login`, { waitUntil: "domcontentloaded" });
    const st = await cruz.evaluate(async () => (await fetch("/api/ultima-atualizacao", { cache: "no-store" })).status);
    check(st === 401, "sessão de um grupo usada no host do outro → 401", String(st));
    await ctxCruz.close();
    const anon = await browser.newContext();
    const pa = await anon.newPage();
    await pa.goto(`${base("silveira")}/login`, { waitUntil: "domcontentloaded" });
    const rAnon = await pa.evaluate(async () => {
      const r = await fetch("/api/ultima-atualizacao", { cache: "no-store" });
      return { s: r.status, t: await r.text() };
    });
    check(rAnon.s === 401 && !/Central|Mercado/.test(rAnon.t), "sem sessão → 401 sem dados", `${rAnon.s} ${rAnon.t}`);
    check((await pa.locator('[data-testid="ultima-atualizacao"]').count()) === 0, "o ecrã de login não mostra o bloco");
    await anon.close();

    console.log("\n11 · payload da rota só com nomes e datas");
    const pj = await abrir(ctxS, `${base("silveira")}/login`);
    const corpoApi = await pj.evaluate(async () => (await fetch("/api/ultima-atualizacao", { cache: "no-store" })).text());
    const chaves = Array.from(new Set(Array.from(corpoApi.matchAll(/"([a-zA-Z]+)":/g)).map((m) => m[1]))).sort();
    check(JSON.stringify(chaves) === JSON.stringify(["ate", "farmacias", "id", "nome", "ok"]), "campos: ok, farmacias[id, nome, ate]", chaves.join(","));
    await pj.close();

    console.log("\n12 · telemóvel (390×844): menu fechado e aberto");
    const ctxM = await login(browser, "garantia", "admin@dois.pt", { width: 390, height: 844 });
    p = await abrir(ctxM, `${base("garantia")}/dashboard`);
    check((await p.locator("aside:visible").count()) === 0, "menu fechado: nada visível do menu lateral");
    check(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "sem scroll horizontal");
    await p.screenshot({ path: path.join(EVID, "4a-movel-menu-fechado.png") });
    await p.getByTestId("menu-movel-abrir").click();
    await p.getByTestId("menu-movel").waitFor({ state: "visible", timeout: 10_000 });
    l = await linhasBloco(p);
    check(l.length === 5, "menu aberto: as 5 farmácias no fundo do menu", String(l.length));
    const gm = await p.evaluate(() => {
      const m = document.querySelector('[data-testid="menu-movel"] aside') as HTMLElement;
      const b = document.querySelector('[data-testid="menu-movel"] [data-testid="ultima-atualizacao"]') as HTMLElement;
      const nav = m.querySelector("nav") as HTMLElement;
      return { m: m.getBoundingClientRect(), b: b.getBoundingClientRect(), nav: nav.getBoundingClientRect(), vh: window.innerHeight };
    });
    check(gm.m.bottom <= gm.vh + 1 && gm.b.bottom <= gm.vh + 1, "o bloco cabe no ecrã, no fundo do menu", JSON.stringify(gm));
    check(gm.b.top > gm.nav.top, "o bloco está abaixo das opções do menu");
    await p.screenshot({ path: path.join(EVID, "4-movel-menu-aberto.png") });
    await p.keyboard.press("Escape");
    check((await p.getByTestId("menu-movel").count()) === 0, "Esc fecha o menu");
    await p.getByTestId("menu-movel-abrir").click();
    await p.getByTestId("menu-movel").getByRole("link", { name: "Stock", exact: true }).click();
    await p.waitForURL(/\/stock/, { timeout: 30_000 });
    check((await p.getByTestId("menu-movel").count()) === 0, "navegar fecha o menu");
    await p.close();
    await ctxM.close();
    await ctxS.close();
    await ctxG.close();
  } finally {
    await browser.close();
    for (const c of Object.values(dbs)) await c.$disconnect();
    await control.$disconnect();
  }

  console.log(`\n${ok} OK, ${ko} falhas`);
  process.exit(ko ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
