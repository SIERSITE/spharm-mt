/**
 * scripts/e2e/dados-atualizados.e2e.ts
 *
 * E2E em BROWSER REAL (Playwright/Chromium) do «Dados atualizados até …» no
 * cabeçalho. A data entra pelo MESMO caminho que a do agent em produção: um
 * POST autenticado (chave de ingestão + tenant) a /api/admin/pipeline/record
 * — não se escreve em PipelineRun por atalho, excepto para recuar `updatedAt`
 * (para ter horas distintas sem esperar).
 *
 * ── Segurança ──────────────────────────────────────────────────────────
 * Só corre contra bases LOCAIS descartáveis (recusa hosts que não sejam
 * localhost/127.0.0.1). APAGA e recria dados nelas.
 *
 * ── Preparação ─────────────────────────────────────────────────────────
 * Igual a scripts/e2e/integracao-restrita.e2e.ts: E2E_DB_CONTROL, E2E_DB_LEGACY,
 * E2E_DB_SILVEIRA, E2E_DB_GARANTIA; build de produção a correr em
 * localhost:3100 (tenants em <slug>.localhost:3100); TENANT_ENCRYPTION_SECRET
 * igual ao do servidor. Evidência (PNG) em E2E_EVIDENCIA (default
 * docs/validacao-dados-atualizados).
 *
 * Corre com: npx tsx scripts/e2e/dados-atualizados.e2e.ts
 */
import bcrypt from "bcryptjs";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { PrismaClient as ControlClient } from "../../generated/prisma-control/client";
import { encryptTenantSecret } from "../../lib/tenant-crypto";
import { formatarDataHora, TEXTO_SEM_INFO } from "../../lib/dados-atualizados-core";

const PORT = process.env.E2E_PORT ?? "3100";
const base = (slug: string | null) => (slug ? `http://${slug}.localhost:${PORT}` : `http://localhost:${PORT}`);
const PASSWORD = "E2e-Pass-123!";
const INGEST_KEY = "e2e-ingest-key-e2e-ingest-key-0001";
const EVID = path.resolve(process.env.E2E_EVIDENCIA ?? "docs/validacao-dados-atualizados");
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

const TERMOS_TECNICOS = /\b(agent|agente|heartbeat|ingest\w*|ingest[ãa]o|fila|outbox|api|token|endpoint)\b/i;

async function limpar(c: PrismaClient) {
  await c.pipelineRun.deleteMany();
  await c.syncRequest.deleteMany();
  await c.auditLog.deleteMany();
  await c.utilizadorFarmacia.deleteMany().catch(() => {});
  await c.utilizador.deleteMany();
  await c.farmacia.deleteMany();
}

async function login(browser: Browser, slug: string | null, email: string, viewport?: { width: number; height: number }): Promise<BrowserContext> {
  const ctx = await browser.newContext(viewport ? { viewport } : undefined);
  const page = await ctx.newPage();
  await page.goto(`${base(slug)}/login`);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  await Promise.all([page.waitForURL(/\/dashboard/, { timeout: 60_000 }), page.click('button[type="submit"]')]);
  await page.close();
  return ctx;
}

/** Texto visível do botão (desktop ou móvel, conforme o viewport). */
async function textoCabecalho(page: Page): Promise<string> {
  const botao = page.getByTestId("dados-atualizados-botao");
  await botao.waitFor({ state: "visible", timeout: 30_000 });
  return ((await botao.innerText()) ?? "").replace(/\s+/g, " ").trim();
}

async function abrir(ctx: BrowserContext, url: string): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  return page;
}

/** O que o agent faz: POST autenticado, feito a partir do browser (o Node não resolve *.localhost). */
async function receberComoAgent(ctx: BrowserContext, slug: string, corpo: Record<string, unknown>, chave = INGEST_KEY): Promise<{ status: number; corpo: string }> {
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
      { k: chave, s: slug, b: corpo },
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
    { slug: "silveira", nome: "Grupo Silveira", env: "E2E_DB_SILVEIRA" },
    { slug: "garantia", nome: "Garantia", env: "E2E_DB_GARANTIA" },
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

  // Silveira: duas farmácias. Garantia: uma, que NUNCA recebeu nada.
  const sil = dbs.silveira;
  const fA = await sil.farmacia.create({ data: { nome: "Farmácia Alfa Silveira" } });
  const fB = await sil.farmacia.create({ data: { nome: "Farmácia Beta Silveira" } });
  const mkUser = (c: PrismaClient, email: string, perfil: "ADMINISTRADOR" | "GESTOR_GRUPO" | "OPERADOR", farmaciaId: string | null) =>
    c.utilizador.create({ data: { email, nome: email.split("@")[0], perfil, passwordHash: hash, farmaciaId } });
  await mkUser(sil, "admin@silveira.pt", "ADMINISTRADOR", null);
  await mkUser(sil, "gestor@silveira.pt", "GESTOR_GRUPO", null);
  await mkUser(sil, "operador-beta@silveira.pt", "OPERADOR", fB.id);
  const gar = dbs.garantia;
  const fG = await gar.farmacia.create({ data: { nome: "Farmácia Garantia Única" } });
  await mkUser(gar, "admin@garantia.pt", "ADMINISTRADOR", null);

  const browser = await chromium.launch();
  const ESPERADO_SEM = TEXTO_SEM_INFO;

  try {
    const ctxSil = await login(browser, "silveira", "admin@silveira.pt");

    console.log("\n1 · antes de qualquer receção");
    let p = await abrir(ctxSil, `${base("silveira")}/dashboard`);
    check((await textoCabecalho(p)) === ESPERADO_SEM, "cabeçalho: «Atualização ainda não disponível»", await textoCabecalho(p));
    await p.getByTestId("dados-atualizados-botao").click();
    let detalhe = await p.getByTestId("dados-atualizados-detalhe").innerText();
    check(detalhe.includes("Farmácia Alfa Silveira") && detalhe.includes("Farmácia Beta Silveira"), "detalhe lista as duas farmácias");
    check((detalhe.match(/Atualização ainda não disponível/g) ?? []).length >= 2, "cada farmácia sem informação diz «Atualização ainda não disponível»");
    await p.close();

    console.log("\n2 · receção real (POST como o agent) — a data é a do SERVIDOR, não a que o agent afirma");
    const antes = Date.now();
    const rA = await receberComoAgent(ctxSil, "silveira", {
      farmaciaId: fA.id, kind: "daily-pipeline", status: "OK", dateRef: "2026-11-18",
      startedAt: "2020-01-01T00:00:00Z", finishedAt: "2020-01-01T00:05:00Z", idempotencyKey: "e2e-A-1", details: { steps: [] },
    });
    check(rA.status === 200 || rA.status === 201, "o endpoint de receção aceitou a corrida de A", `${rA.status} ${rA.corpo.slice(0, 200)}`);
    const rowA = await sil.pipelineRun.findFirstOrThrow({ where: { farmaciaId: fA.id, idempotencyKey: "e2e-A-1" } });
    check(rowA.status === "OK" && Math.abs(rowA.updatedAt.getTime() - antes) < 60_000, "updatedAt gravado = relógio do servidor (agora), não o 2020 do agent");
    p = await abrir(ctxSil, `${base("silveira")}/dashboard`);
    check((await textoCabecalho(p)) === `Dados atualizados até ${formatarDataHora(rowA.updatedAt.toISOString())}`, "cabeçalho mostra a receção de A (B ainda sem informação)", await textoCabecalho(p));
    await p.close();

    console.log("\n3 · o que NÃO conta (decoys mais recentes)");
    const antes2 = Date.now();
    for (const corpo of [
      { farmaciaId: fA.id, kind: "sync-now", status: "OK", idempotencyKey: "e2e-A-syncnow", details: {} },
      { farmaciaId: fA.id, kind: "daily-pipeline", status: "PARTIAL", dateRef: "2026-11-19", idempotencyKey: "e2e-A-partial", details: {} },
      { farmaciaId: fA.id, kind: "daily-pipeline", status: "ERROR", dateRef: "2026-11-19", idempotencyKey: "e2e-A-erro", details: {} },
      { farmaciaId: fA.id, kind: "aggregate-month", status: "OK", dateRef: "2026-11", idempotencyKey: "e2e-A-agg", details: {} },
    ]) {
      const r = await receberComoAgent(ctxSil, "silveira", corpo);
      check(r.status === 200 || r.status === 201, `recebido ${String(corpo.kind)}/${String(corpo.status)}`, `${r.status} ${r.corpo.slice(0, 160)}`);
    }
    await sil.syncRequest.create({ data: { farmaciaId: fA.id, estado: "CONCLUIDO", requestedByUserId: (await sil.utilizador.findFirstOrThrow({ where: { email: "admin@silveira.pt" } })).id, timeoutAt: new Date(Date.now() + 3_600_000), finishedAt: new Date() } });
    await control.tenant.updateMany({ data: { lastAgentHeartbeatAt: new Date() } });
    p = await abrir(ctxSil, `${base("silveira")}/dashboard`);
    check((await textoCabecalho(p)) === `Dados atualizados até ${formatarDataHora(rowA.updatedAt.toISOString())}`, "pedido «Sincronizar agora», heartbeat, PARTIAL, ERROR, sync-now e agregação NÃO mexem na data", await textoCabecalho(p));
    void antes2;
    await p.close();

    console.log("\n4 · várias farmácias → a MAIS ANTIGA no cabeçalho; detalhe por farmácia");
    const rB = await receberComoAgent(ctxSil, "silveira", { farmaciaId: fB.id, kind: "daily-sync", status: "OK", idempotencyKey: "e2e-B-1", details: {} });
    check(rB.status === 200 || rB.status === 201, "receção de B (daily-sync)", `${rB.status} ${rB.corpo.slice(0, 160)}`);
    const T_A = new Date(Date.now() - 3 * 3_600_000);
    const T_B = new Date(Date.now() - 30 * 60_000);
    await sil.$executeRaw`UPDATE "PipelineRun" SET "updatedAt" = ${T_A} WHERE "idempotencyKey" = 'e2e-A-1'`;
    await sil.$executeRaw`UPDATE "PipelineRun" SET "updatedAt" = ${T_B} WHERE "idempotencyKey" = 'e2e-B-1'`;
    p = await abrir(ctxSil, `${base("silveira")}/dashboard`);
    const cab = await textoCabecalho(p);
    check(cab === `Dados atualizados até ${formatarDataHora(T_A.toISOString())}`, "cabeçalho = A (3 h atrás), a mais antiga", cab);
    check(!cab.includes(formatarDataHora(new Date().toISOString())) || formatarDataHora(T_A.toISOString()) === formatarDataHora(new Date().toISOString()), "não é a hora atual");
    await p.screenshot({ path: path.join(EVID, "desktop-cabecalho.png") });
    await p.getByTestId("dados-atualizados-botao").click();
    detalhe = await p.getByTestId("dados-atualizados-detalhe").innerText();
    check(detalhe.includes(formatarDataHora(T_A.toISOString())) && detalhe.includes(formatarDataHora(T_B.toISOString())), "detalhe mostra a hora de cada farmácia");
    check(!TERMOS_TECNICOS.test(cab + " " + detalhe), "sem termos técnicos no cabeçalho nem no detalhe", (cab + " " + detalhe).match(TERMOS_TECNICOS)?.[0]);
    await p.screenshot({ path: path.join(EVID, "desktop-detalhe.png") });
    await p.keyboard.press("Escape");
    check((await p.getByTestId("dados-atualizados-detalhe").count()) === 0, "Esc fecha o detalhe");
    await p.close();

    console.log("\n5 · refresca ao navegar (sem recarregar) e ao regressar ao separador");
    p = await abrir(ctxSil, `${base("silveira")}/dashboard`);
    const T_A2 = new Date(Date.now() - 20 * 60_000);
    await sil.$executeRaw`UPDATE "PipelineRun" SET "updatedAt" = ${T_A2} WHERE "idempotencyKey" = 'e2e-A-1'`;
    await p.getByRole("link", { name: "Stock", exact: true }).first().click().catch(() => {});
    await p.waitForURL(/\/stock/, { timeout: 30_000 }).catch(() => {});
    await p.waitForFunction((t) => document.querySelector('[data-testid="dados-atualizados-botao"]')?.textContent?.includes(t), formatarDataHora(T_B.toISOString()) === formatarDataHora(T_A2.toISOString()) ? formatarDataHora(T_A2.toISOString()) : formatarDataHora(T_B.toISOString()), { timeout: 20_000 }).catch(() => {});
    const cab2 = await textoCabecalho(p);
    const novoMin = new Date(Math.min(T_A2.getTime(), T_B.getTime()));
    check(cab2 === `Dados atualizados até ${formatarDataHora(novoMin.toISOString())}`, "após navegar para /stock o cabeçalho reflete a nova mais-antiga", cab2);
    await p.close();

    console.log("\n6 · o cabeçalho existe em todos os ecrãs da aplicação");
    const ecras = ["/dashboard", "/stock", "/vendas", "/vendas/manutencao", "/relatorios/margens", "/relatorios/inventario", "/devolucoes", "/encomendas", "/encomendas/lista", "/transferencias", "/excessos", "/catalogo", "/configuracoes/email", "/configuracoes/utilizadores"];
    for (const e of ecras) {
      const pg = await abrir(ctxSil, `${base("silveira")}${e}`);
      const url = new URL(pg.url());
      const tem = (await pg.getByTestId("dados-atualizados-botao").count()) === 1;
      check(tem && url.pathname.startsWith(e.split("/").slice(0, 2).join("/")), `${e}: cabeçalho presente`, `url=${pg.url()} tem=${tem}`);
      await pg.close();
    }

    console.log("\n7 · âmbito por perfil");
    const ctxOp = await login(browser, "silveira", "operador-beta@silveira.pt");
    p = await abrir(ctxOp, `${base("silveira")}/dashboard`);
    check((await textoCabecalho(p)) === `Dados atualizados até ${formatarDataHora(T_B.toISOString())}`, "operador da farmácia Beta vê a data de Beta", await textoCabecalho(p));
    await p.getByTestId("dados-atualizados-botao").click();
    detalhe = await p.getByTestId("dados-atualizados-detalhe").innerText();
    check(detalhe.includes("Farmácia Beta Silveira") && !detalhe.includes("Alfa"), "o detalhe só lista a sua farmácia");
    await p.close();
    await ctxOp.close();

    console.log("\n8 · dois tenants, dois separadores — sem fuga");
    const ctxGar = await login(browser, "garantia", "admin@garantia.pt");
    const pS = await abrir(ctxSil, `${base("silveira")}/dashboard`);
    const pG = await abrir(ctxGar, `${base("garantia")}/dashboard`);
    check((await textoCabecalho(pG)) === ESPERADO_SEM, "Garantia (sem receções) mostra «Atualização ainda não disponível»", await textoCabecalho(pG));
    check((await textoCabecalho(pS)).startsWith("Dados atualizados até"), "Silveira (em paralelo) mostra a sua data");
    await pG.getByTestId("dados-atualizados-botao").click();
    const detG = await pG.getByTestId("dados-atualizados-detalhe").innerText();
    check(detG.includes("Farmácia Garantia Única") && !/Silveira|Alfa|Beta/.test(detG), "o detalhe da Garantia não contém farmácias da Silveira");
    check(!/Garantia/.test(await pS.content()), "o HTML da Silveira não contém a Garantia");
    await pS.close();
    await pG.close();
    // Cookie da Silveira no host da Garantia → inerte (401).
    const cookies = await ctxSil.cookies();
    const ctxCruz = await browser.newContext();
    await ctxCruz.addCookies(cookies.map((c) => ({ name: c.name, value: c.value, url: base("garantia") })));
    const cruz = await ctxCruz.newPage();
    await cruz.goto(`${base("garantia")}/login`, { waitUntil: "domcontentloaded" });
    const st = await cruz.evaluate(async () => (await fetch("/api/dados-atualizados", { cache: "no-store" })).status);
    check(st === 401, "sessão da Silveira usada no host da Garantia → 401", String(st));
    await ctxCruz.close();
    // Sem sessão.
    const anon = await browser.newContext();
    const pa = await anon.newPage();
    await pa.goto(`${base("silveira")}/login`, { waitUntil: "domcontentloaded" });
    const rAnon = await pa.evaluate(async () => {
      const r = await fetch("/api/dados-atualizados", { cache: "no-store" });
      return { s: r.status, t: await r.text() };
    });
    check(rAnon.s === 401 && !/Alfa|Beta/.test(rAnon.t), "sem sessão → 401 sem dados", `${rAnon.s} ${rAnon.t}`);
    check((await pa.getByTestId("dados-atualizados").count()) === 0, "o ecrã de login não mostra o indicador");
    await anon.close();

    console.log("\n9 · a resposta da rota só leva datas e nomes de farmácias");
    const pj = await abrir(ctxSil, `${base("silveira")}/login`);
    const corpoApi = await pj.evaluate(async () => (await fetch("/api/dados-atualizados", { cache: "no-store" })).text());
    check(!TERMOS_TECNICOS.test(corpoApi) && !/heartbeat|version|ip|kind|status/i.test(corpoApi), "payload sem campos técnicos", corpoApi.slice(0, 300));
    await pj.close();

    console.log("\n10 · versão móvel (390×844)");
    const ctxM = await login(browser, "silveira", "admin@silveira.pt", { width: 390, height: 844 });
    p = await abrir(ctxM, `${base("silveira")}/dashboard`);
    const curto = await textoCabecalho(p);
    check(/^Até \d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}$/.test(curto), "texto curto no telemóvel", curto);
    const semScroll = await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    check(semScroll, "sem scroll horizontal no telemóvel");
    await p.screenshot({ path: path.join(EVID, "movel-cabecalho.png") });
    await p.getByTestId("dados-atualizados-botao").click();
    const caixa = await p.getByTestId("dados-atualizados-detalhe").boundingBox();
    check(!!caixa && caixa.x >= 0 && caixa.x + caixa.width <= 390 + 0.5, "o detalhe cabe no ecrã", JSON.stringify(caixa));
    await p.screenshot({ path: path.join(EVID, "movel-detalhe.png") });
    await p.close();
    await ctxM.close();

    console.log("\n11 · sem informação — desktop");
    const pg2 = await abrir(ctxGar, `${base("garantia")}/stock`);
    await pg2.screenshot({ path: path.join(EVID, "desktop-sem-informacao.png") });
    await pg2.close();
    void fG;
    await ctxGar.close();
    await ctxSil.close();
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
