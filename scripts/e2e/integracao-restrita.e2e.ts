/**
 * scripts/e2e/integracao-restrita.e2e.ts
 *
 * E2E em BROWSER REAL (Playwright/Chromium) da restrição da área «Integração»
 * a técnicos internos (ver lib/integracao/acesso.ts e docs/integracao-restrita.md).
 *
 * ── Segurança ─────────────────────────────────────────────────────────
 * Só corre contra bases LOCAIS descartáveis (recusa qualquer host que não seja
 * localhost/127.0.0.1) e contra uma app local. APAGA e recria dados nelas.
 *
 * ── Preparação ────────────────────────────────────────────────────────
 *   E2E_DB_CONTROL (schema prisma-control), E2E_DB_LEGACY, E2E_DB_SILVEIRA,
 *   E2E_DB_GARANTIA (schema da app). Build de produção (`next build`) e o
 *   servidor standalone a correr com:
 *     CONTROL_DATABASE_URL=$E2E_DB_CONTROL  DATABASE_URL=$E2E_DB_LEGACY
 *     TENANT_ENCRYPTION_SECRET=<igual a este processo>  AUTH_SECRET=<…>
 *     PLATFORM_ADMIN_EMAILS=tecnico@sier.test  SESSION_COOKIE_SECURE=false
 *     TENANT_DB_SSLMODE=disable  PORT=3100 HOSTNAME=localhost
 *     SERVER_ACTIONS_ALLOWED_ORIGINS=localhost:3100,*.localhost:3100
 *   Tenants por subdomínio (`http://<slug>.localhost:3100`); o contexto
 *   não-tenant (técnicos) é `http://localhost:3100`.
 *
 * Corre com: npx tsx scripts/e2e/integracao-restrita.e2e.ts
 */
import bcrypt from "bcryptjs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { PrismaClient as ControlClient } from "../../generated/prisma-control/client";
import { encryptTenantSecret } from "../../lib/tenant-crypto";

const PORT = process.env.E2E_PORT ?? "3100";
const base = (slug: string | null) => (slug ? `http://${slug}.localhost:${PORT}` : `http://localhost:${PORT}`);
const PASSWORD = "E2e-Pass-123!";
const TECNICO = "tecnico@sier.test";

// Marcadores que NUNCA podem chegar ao browser de um utilizador sem permissão.
const SEGREDOS = {
  erroOutbox: "SEGREDO_ERRO_OUTBOX_123",
  sqlSpharm: "SEGREDO_SQL_SPHARM_456",
  erroSync: "SEGREDO_ERRO_SYNC_789",
  versaoAgent: "9.9.9-versao-secreta",
  ipAgent: "203.0.113.77",
  stockAtualizado: "stockAtualizado",
};

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

const TENANTS = [
  { slug: "silveira", nome: "Grupo Silveira", env: "E2E_DB_SILVEIRA" },
  { slug: "garantia", nome: "Garantia", env: "E2E_DB_GARANTIA" },
] as const;

const PERFIS = [
  { chave: "admin", perfil: "ADMINISTRADOR" },
  { chave: "gestorgrupo", perfil: "GESTOR_GRUPO" },
  { chave: "gestorfarmacia", perfil: "GESTOR_FARMACIA" },
  { chave: "operador", perfil: "OPERADOR" },
] as const;

type Seed = { farmaciaId: string; listaFalhada: string; outboxFalhada: string; outboxRetry: string };

async function limpar(c: PrismaClient) {
  await c.orderExportAudit.deleteMany();
  await c.orderOutbox.deleteMany();
  await c.listaEncomenda.deleteMany();
  await c.syncRequest.deleteMany();
  await c.auditLog.deleteMany();
  await c.utilizadorFarmacia.deleteMany().catch(() => {});
  await c.utilizador.deleteMany();
  await c.farmacia.deleteMany();
}

async function semearTenant(c: PrismaClient, slug: string): Promise<Seed> {
  await limpar(c);
  const farm = await c.farmacia.create({ data: { nome: `Farmácia ${slug}` } });
  const hash = await bcrypt.hash(PASSWORD, 10);
  let adminId = "";
  for (const p of PERFIS) {
    const u = await c.utilizador.create({
      data: {
        email: `${p.chave}@${slug}.pt`, nome: p.chave, perfil: p.perfil, passwordHash: hash,
        farmaciaId: p.perfil === "GESTOR_FARMACIA" || p.perfil === "OPERADOR" ? farm.id : null,
      },
    });
    if (p.chave === "admin") adminId = u.id;
  }
  // Utilizador do CLIENTE com o MESMO email do técnico (perfil ADMINISTRADOR): o ataque
  // «o administrador do cliente cria um utilizador com o email de um técnico».
  await c.utilizador.create({ data: { email: TECNICO, nome: "Falso técnico", perfil: "ADMINISTRADOR", passwordHash: hash } });

  const mk = async (nome: string, erro: string | null, estado: "FALHADO" | "PENDENTE") => {
    const lista = await c.listaEncomenda.create({
      data: { farmaciaId: farm.id, nome, estado: "FINALIZADA", estadoExport: estado, criadoPorId: adminId },
    });
    const ob = await c.orderOutbox.create({
      data: {
        listaEncomendaId: lista.id, farmaciaId: farm.id, payloadJson: "{}", idempotencyKey: `${slug}:${lista.id}`,
        payloadHash: "h", state: estado, attemptCount: 7, lastError: erro, lastAttemptAt: new Date(),
      },
    });
    await c.orderExportAudit.create({ data: { outboxId: ob.id, attempt: 7, status: "FAILURE", message: erro, httpStatus: 500, spharmSqlError: SEGREDOS.sqlSpharm } });
    return { lista: lista.id, outbox: ob.id };
  };
  const a = await mk(`Encomenda falhada ${slug}`, SEGREDOS.erroOutbox, "FALHADO");
  const b = await mk(`Encomenda para retry ${slug}`, SEGREDOS.erroOutbox, "FALHADO");

  // Pedido de sincronização falhado, com resultado + erro técnicos.
  await c.syncRequest.create({
    data: {
      farmaciaId: farm.id, estado: "FALHOU", requestedByUserId: adminId, timeoutAt: new Date(Date.now() + 3_600_000),
      finishedAt: new Date(), erro: SEGREDOS.erroSync,
      resultado: { stockAtualizado: 11, produtosAtualizados: 22, fabricantesAlterados: 33 },
    },
  });
  return { farmaciaId: farm.id, listaFalhada: a.lista, outboxFalhada: a.outbox, outboxRetry: b.outbox };
}

/** Recolhe TUDO o que o browser recebe (HTML + respostas de actions/fetch) de uma página. */
function observar(page: Page): { corpo: () => string } {
  const partes: string[] = [];
  page.on("response", async (r) => {
    try {
      const t = r.request().resourceType();
      if (t === "document" || t === "fetch" || t === "xhr") partes.push(await r.text());
    } catch { /* redirecionamentos sem corpo */ }
  });
  return { corpo: () => partes.join("\n") };
}

async function login(browser: Browser, slug: string | null, email: string): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${base(slug)}/login`);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  await Promise.all([page.waitForURL(/\/(dashboard|admin)/, { timeout: 60_000 }), page.click('button[type="submit"]')]);
  await page.close();
  return ctx;
}

async function visitar(ctx: BrowserContext, url: string): Promise<{ page: Page; url: string; html: string; rede: () => string }> {
  const page = await ctx.newPage();
  const obs = observar(page);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  return { page, url: page.url(), html: await page.content(), rede: obs.corpo };
}

const temSegredo = (txt: string) => Object.values(SEGREDOS).filter((s) => txt.includes(s));

/** POST direto a uma server action, a partir do browser (o Node não resolve *.localhost). */
async function postarAcao(ctx: BrowserContext, slug: string | null, caminho: string, actionId: string, payload: unknown): Promise<string> {
  const page = await ctx.newPage();
  try {
    await page.goto(`${base(slug)}/login`, { waitUntil: "domcontentloaded" });
    return await page.evaluate(
      async ({ url, id, corpo }) => {
        const r = await fetch(url, {
          method: "POST", credentials: "include", redirect: "manual",
          headers: { "next-action": id, "content-type": "text/plain;charset=UTF-8", accept: "text/x-component" },
          body: corpo,
        });
        return `${r.status}|${r.type}|${await r.text().catch(() => "")}`;
      },
      { url: `${base(slug)}${caminho}`, id: actionId, corpo: JSON.stringify(payload) },
    );
  } finally {
    await page.close();
  }
}

async function main() {
  const control = new ControlClient({ adapter: new PrismaPg({ connectionString: urlLocal("E2E_DB_CONTROL").toString() }) });
  await control.tenantEvent.deleteMany();
  await control.tenant.deleteMany();
  const dbs: Record<string, PrismaClient> = {};
  const seeds: Record<string, Seed> = {};
  const tenantIds: Record<string, string> = {};
  for (const t of TENANTS) {
    const u = urlLocal(t.env);
    const rec = await control.tenant.create({
      data: {
        slug: t.slug, nome: t.nome, estado: "ACTIVE",
        dbHost: u.hostname, dbPort: Number(u.port || 5432), dbName: u.pathname.slice(1),
        dbUser: decodeURIComponent(u.username), dbPassEncrypted: encryptTenantSecret(decodeURIComponent(u.password)),
        lastAgentHeartbeatAt: new Date(), lastAgentIp: SEGREDOS.ipAgent, lastAgentVersion: SEGREDOS.versaoAgent,
      },
    });
    tenantIds[t.slug] = rec.id;
    dbs[t.slug] = db(t.env);
    seeds[t.slug] = await semearTenant(dbs[t.slug], t.slug);
  }
  // Contexto não-tenant (legacy): o técnico autorizado e um ADMINISTRADOR que NÃO está na env.
  const legacy = db("E2E_DB_LEGACY");
  await limpar(legacy);
  const hash = await bcrypt.hash(PASSWORD, 10);
  await legacy.utilizador.create({ data: { email: TECNICO, nome: "Técnico SIER", perfil: "ADMINISTRADOR", passwordHash: hash } });
  await legacy.utilizador.create({ data: { email: "outro-admin@sier.test", nome: "Outro admin", perfil: "ADMINISTRADOR", passwordHash: hash } });
  await legacy.utilizador.create({ data: { email: "operador-legacy@sier.test", nome: "Operador legacy", perfil: "OPERADOR", passwordHash: hash } });

  const browser = await chromium.launch();
  try {
    // ═════════════════ 1. Técnico interno autorizado ═════════════════
    console.log("\nTécnico interno autorizado (contexto não-tenant)");
    const tecCtx = await login(browser, null, TECNICO);
    let v = await visitar(tecCtx, `${base(null)}/admin`);
    check(/\/admin$/.test(v.url), "técnico abre o console /admin", v.url);
    check((await v.page.locator('a[href="/admin/integracao"]').count()) > 0, "o menu do técnico tem a entrada «Integração»");
    await v.page.close();
    v = await visitar(tecCtx, `${base(null)}/admin/integracao`);
    check(v.url.endsWith("/admin/integracao"), "técnico abre /admin/integracao", v.url);
    check((await v.page.getByTestId("integracao-admin").count()) === 1, "a página de integração renderiza");
    check(v.html.includes(SEGREDOS.versaoAgent), "técnico vê a versão do agent");
    check(v.html.includes("Grupo Silveira") && v.html.includes("Garantia"), "técnico vê os dois tenants");
    await v.page.close();
    v = await visitar(tecCtx, `${base(null)}/configuracoes/integracao`);
    check(v.url.endsWith("/admin/integracao"), "o URL antigo /configuracoes/integracao leva o técnico a /admin/integracao", v.url);
    await v.page.close();
    v = await visitar(tecCtx, `${base(null)}/admin/tenants/${tenantIds.silveira}`);
    check(v.url.includes("/admin/tenants/"), "técnico abre o detalhe do tenant (outbox, heartbeat)");
    await v.page.getByRole("button", { name: "Outbox", exact: true }).click();
    await v.page.waitForTimeout(500);
    check((await v.page.content()).includes(SEGREDOS.erroOutbox), "controlo positivo: o técnico VÊ o erro técnico (prova que a deteção de marcadores funciona)");
    // Captura o id REAL da server action de re-tentar (clicando no botão do técnico, numa linha de teste).
    let retryActionId: string | null = null;
    v.page.on("request", (r) => {
      const id = r.headers()["next-action"];
      if (r.method() === "POST" && id && (r.postData() ?? "").includes(seeds.silveira.outboxRetry)) retryActionId = id;
    });
    const linhaRetry = v.page.locator("tr", { hasText: `Encomenda para retry silveira` }).first();
    await linhaRetry.waitFor({ timeout: 15_000 });
    await linhaRetry.getByRole("button", { name: "Re-enviar" }).click();
    await v.page.waitForTimeout(2500);
    check(!!retryActionId, "id da server action de operação manual capturado do tráfego real do técnico");
    const rt = await dbs.silveira.orderOutbox.findUnique({ where: { id: seeds.silveira.outboxRetry } });
    check(rt?.state === "PENDENTE", "o técnico CONSEGUE executar a operação manual (re-tentar) — estado → PENDENTE", `estado=${rt?.state}`);
    await v.page.close();
    // Reposição para a prova negativa abaixo.
    await dbs.silveira.orderOutbox.update({ where: { id: seeds.silveira.outboxRetry }, data: { state: "FALHADO", lastError: SEGREDOS.erroOutbox } });

    // ═════════════════ 2. Utilizadores dos tenants (todos os perfis, 2 tenants) ═════════════════
    for (const t of TENANTS) {
      for (const p of PERFIS) {
        console.log(`\n${t.nome} · ${p.perfil}`);
        const ctx = await login(browser, t.slug, `${p.chave}@${t.slug}.pt`);
        const d = await visitar(ctx, `${base(t.slug)}/dashboard`);
        const links = await d.page.locator('a[href*="integracao"]').count();
        check(links === 0, "o menu/dashboard não tem nenhuma ligação para «Integração»", `ligações=${links}`);
        check(!/Integração/.test(await d.page.locator("nav, aside").allTextContents().then((a) => a.join(" "))), "o texto «Integração» não aparece no menu");
        check(temSegredo(d.html + d.rede()).length === 0, "dashboard sem dados técnicos no HTML/payload", temSegredo(d.html + d.rede()).join(","));
        await d.page.close();

        for (const alvo of ["/configuracoes/integracao", "/admin/integracao", "/admin"]) {
          const r = await visitar(ctx, `${base(t.slug)}${alvo}`);
          check(/\/dashboard$/.test(r.url), `URL direto ${alvo} recusado (redireciona para /dashboard)`, r.url);
          check(temSegredo(r.html + r.rede()).length === 0 && !/Integração SPharm|Fila pendente|Versão do agent/.test(r.html), `${alvo}: sem conteúdo técnico no HTML/payload`);
          await r.page.close();
        }
        await ctx.close();
      }
    }

    // ═════════════════ 3. Quem NÃO é técnico mas parece ═════════════════
    console.log("\nContra-provas de identidade");
    {
      // O falso técnico: utilizador do CLIENTE com o email do técnico (ADMINISTRADOR no tenant).
      const ctx = await login(browser, "silveira", TECNICO);
      const r = await visitar(ctx, `${base("silveira")}/admin/integracao`);
      check(/\/dashboard$/.test(r.url), "utilizador do tenant com o EMAIL do técnico é recusado (o email sozinho não chega)", r.url);
      await r.page.close();
      // Cookie do tenant levado para o contexto não-tenant e vice-versa.
      const cookies = await ctx.cookies();
      const sess = cookies.find((c) => /session|spharm|auth/i.test(c.name)) ?? cookies[0];
      const ctxLegacy = await browser.newContext();
      await ctxLegacy.addCookies([{ name: sess.name, value: sess.value, domain: "localhost", path: "/" }]);
      const r2 = await visitar(ctxLegacy, `${base(null)}/admin/integracao`);
      check(/\/login/.test(r2.url), "cookie de sessão de tenant NÃO vale no contexto não-tenant", r2.url);
      await r2.page.close();
      await ctxLegacy.close();
      const ctxTec = tecCtx;
      const ck = (await ctxTec.cookies()).find((c) => c.name === sess.name);
      const ctxGar = await browser.newContext();
      if (ck) await ctxGar.addCookies([{ name: ck.name, value: ck.value, domain: "garantia.localhost", path: "/" }]);
      const r3 = await visitar(ctxGar, `${base("garantia")}/admin/integracao`);
      check(/\/login/.test(r3.url), "cookie do técnico NÃO vale no host de um tenant", r3.url);
      await r3.page.close();
      await ctxGar.close();
      await ctx.close();

      const ctxOutro = await login(browser, null, "outro-admin@sier.test");
      const r4 = await visitar(ctxOutro, `${base(null)}/admin/integracao`);
      check(/\/dashboard$/.test(r4.url), "ADMINISTRADOR não-tenant que NÃO está em PLATFORM_ADMIN_EMAILS é recusado", r4.url);
      await r4.page.close();
      await ctxOutro.close();
      const ctxOp = await login(browser, null, "operador-legacy@sier.test");
      const r5 = await visitar(ctxOp, `${base(null)}/admin/integracao`);
      check(/\/dashboard$/.test(r5.url), "perfil não-administrador (mesmo no contexto não-tenant) é recusado", r5.url);
      await r5.page.close();
      await ctxOp.close();
    }

    // ═════════════════ 4. Chamada direta a actions ═════════════════
    console.log("\nChamada direta a actions (operações manuais)");
    {
      const ctxCli = await login(browser, "silveira", "admin@silveira.pt");
      if (retryActionId) {
        const resp = await postarAcao(ctxCli, "silveira", "/dashboard", retryActionId, [tenantIds.silveira, seeds.silveira.outboxRetry]);
        const after = await dbs.silveira.orderOutbox.findUnique({ where: { id: seeds.silveira.outboxRetry } });
        check(after?.state === "FALHADO", "ADMINISTRADOR do cliente chama diretamente a action de re-tentar: NÃO executa", `estado=${after?.state} resp=${resp.slice(0, 120)}`);
        check(temSegredo(resp).length === 0, "a resposta dessa chamada não traz dados técnicos", temSegredo(resp).join(","));
      } else {
        check(false, "sem id de action capturado — não foi possível testar a chamada direta");
      }
      // As antigas actions de /configuracoes/integracao já não existem: um id inventado é recusado.
      const inv = await postarAcao(ctxCli, "silveira", "/configuracoes/integracao", "00".repeat(20), [seeds.silveira.outboxFalhada]);
      const aindaFalhada = await dbs.silveira.orderOutbox.findUnique({ where: { id: seeds.silveira.outboxFalhada } });
      check(aindaFalhada?.state === "FALHADO", "action inexistente em /configuracoes/integracao não altera nada");
      check(temSegredo(inv).length === 0, "…nem devolve dados técnicos");
      await ctxCli.close();
    }

    // ═════════════════ 5. O cliente continua a ver o que precisa — sem o técnico ═════════════════
    console.log("\nO que o cliente continua a ver");
    for (const t of TENANTS) {
      const ctx = await login(browser, t.slug, `gestorgrupo@${t.slug}.pt`);
      // Detalhe da encomenda: estado simples (badge) sim; tentativas/erros/timeline não.
      const o = await visitar(ctx, `${base(t.slug)}/encomendas/${seeds[t.slug].listaFalhada}`);
      const txt = await o.page.locator("body").innerText();
      check(/falhado/i.test(txt), `${t.slug}: o estado da encomenda (falhado) continua visível`);
      check(!/Tentativas|Timeline de exportação|Último erro|Outbox:/.test(txt), `${t.slug}: sem tentativas/timeline/último erro/outbox na encomenda`);
      check(temSegredo(o.html + o.rede()).length === 0, `${t.slug}: encomenda sem dados técnicos no HTML/payload`, temSegredo(o.html + o.rede()).join(","));
      await o.page.close();

      // Stock: o botão de sincronização manual fica (decisão), com texto simples e payload limpo.
      const s = await visitar(ctx, `${base(t.slug)}/stock`);
      const st = await s.page.locator("body").innerText();
      check(/Última sincronização/.test(st) || t.slug === "garantia", `${t.slug}: indicação simples da última atualização dos dados mantida`);
      if (t.slug === "silveira") {
        check(/Sincronizar agora/.test(st), "silveira: botão «Sincronizar agora» mantido");
        check(/Falhou/.test(st), "silveira: o estado simples do último pedido (Falhou) chega ao cliente — a leitura do estado ocorreu");
        check(!/agente|long-polling|Stock actualizado|Produtos\s+actualizados/i.test(st), "silveira: sem texto técnico (agente/long-polling/contagens)");
      }
      check(temSegredo(s.html + s.rede()).length === 0, `${t.slug}: /stock sem dados técnicos no HTML/payload`, temSegredo(s.html + s.rede()).join(","));
      await s.page.close();

      // Relatórios: continuam a mostrar o período/data.
      const vd = await visitar(ctx, `${base(t.slug)}/vendas`);
      const vt = await vd.page.locator("body").innerText();
      check(/Per[ií]odo|Data|Ano|Mês/i.test(vt), `${t.slug}: /vendas continua a mostrar o período/data`);
      check(temSegredo(vd.html + vd.rede()).length === 0, `${t.slug}: /vendas sem dados técnicos`);
      await vd.page.close();
      await ctx.close();
    }

    // ═════════════════ 6. Dois tenants, dois separadores em simultâneo ═════════════════
    console.log("\nDois tenants / dois separadores");
    {
      const a = await login(browser, "silveira", "admin@silveira.pt");
      const b = await login(browser, "garantia", "admin@garantia.pt");
      const [p1, p2, p3] = await Promise.all([
        visitar(a, `${base("silveira")}/admin/integracao`),
        visitar(b, `${base("garantia")}/configuracoes/integracao`),
        visitar(tecCtx, `${base(null)}/admin/integracao`),
      ]);
      check(/\/dashboard$/.test(p1.url) && /\/dashboard$/.test(p2.url), "separadores simultâneos de dois tenants: ambos recusados");
      check(p3.url.endsWith("/admin/integracao") && p3.html.includes(SEGREDOS.versaoAgent), "…enquanto o técnico, em paralelo, continua autorizado");
      check(temSegredo(p1.html + p1.rede() + p2.html + p2.rede()).length === 0, "nenhum dado técnico vazou entre separadores");
      await Promise.all([p1.page.close(), p2.page.close(), p3.page.close()]);
      await a.close();
      await b.close();
    }
  } finally {
    await browser.close();
    await Promise.all(Object.values(dbs).map((c) => c.$disconnect()));
    await legacy.$disconnect();
    await control.$disconnect();
  }
  console.log(`\n${ok} OK, ${ko} falhas`);
  process.exit(ko === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
