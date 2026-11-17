/**
 * scripts/e2e/fabricante-renomear.e2e.ts
 *
 * E2E em BROWSER REAL (Playwright/Chromium) do fluxo «Editar nome do
 * fabricante» (Stock › Artigo) na Silveirense — com contra-provas na
 * Garantia e num tenant que NÃO tem a funcionalidade.
 *
 * ── Segurança ─────────────────────────────────────────────────────────
 * Só corre contra bases LOCAIS descartáveis (recusa qualquer host que não
 * seja localhost/127.0.0.1) e contra uma app local (E2E_BASE_URL). Apaga e
 * recria os dados de teste nessas bases — por isso a recusa é dura.
 *
 * ── Preparação (ver docs/fabricante-renomear.md) ──────────────────────
 *   4 bases Postgres locais vazias com o schema aplicado:
 *     E2E_DB_CONTROL   (schema de prisma-control)
 *     E2E_DB_SILVEIRA, E2E_DB_GARANTIA, E2E_DB_SEGURADO   (schema da app)
 *   Build de produção (`npx next build`, com SERVER_ACTIONS_ALLOWED_ORIGINS
 *   a incluir `*.localhost:3100`) e o servidor standalone a correr com:
 *     CONTROL_DATABASE_URL=$E2E_DB_CONTROL   TENANT_ENCRYPTION_SECRET=<igual ao deste processo>
 *     AUTH_SECRET=<…>  SESSION_COOKIE_SECURE=false  TENANT_DB_SSLMODE=disable
 *     DATABASE_URL=$E2E_DB_SEGURADO  (cliente legacy; não usado nos testes)
 *     PORT=3100 HOSTNAME=localhost
 *   Os tenants são acedidos por `http://<slug>.localhost:3100` (subdomínio).
 *
 * Corre com: npx tsx scripts/e2e/fabricante-renomear.e2e.ts
 */
import bcrypt from "bcryptjs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { PrismaClient as ControlClient } from "../../generated/prisma-control/client";
import { encryptTenantSecret } from "../../lib/tenant-crypto";

const PORT = process.env.E2E_PORT ?? "3100";
// Cada tenant no SEU subdomínio, como em produção (o middleware resolve o tenant pelo host).
const base = (slug: string) => `http://${slug}.localhost:${PORT}`;
const PASSWORD = "E2e-Pass-123!";

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
const tenantDb = (envVar: string) =>
  new PrismaClient({ adapter: new PrismaPg({ connectionString: urlLocal(envVar).toString() }) });

const TENANTS = [
  { slug: "silveira", nome: "Grupo Silveira", env: "E2E_DB_SILVEIRA" },
  { slug: "garantia", nome: "Garantia", env: "E2E_DB_GARANTIA" },
  { slug: "segurado", nome: "Segurado", env: "E2E_DB_SEGURADO" },
] as const;

type Dados = { fabId: string; fabNome: string; cnps: number[]; outroFabCnp: number; destinoCnps: number[] };

async function semear(db: PrismaClient, slug: string, baseCnp: number): Promise<Dados> {
  await db.auditLog.deleteMany();
  await db.produtoFarmacia.deleteMany();
  await db.produto.deleteMany();
  await db.fabricanteAlias.deleteMany();
  await db.fabricante.deleteMany();
  await db.utilizador.deleteMany();
  await db.farmacia.deleteMany();

  const farm = await db.farmacia.create({ data: { nome: `Farmácia ${slug}` } });
  const hash = await bcrypt.hash(PASSWORD, 10);
  await db.utilizador.create({ data: { email: `admin@${slug}.pt`, nome: "Admin", perfil: "ADMINISTRADOR", passwordHash: hash } });
  await db.utilizador.create({ data: { email: `operador@${slug}.pt`, nome: "Operador", perfil: "OPERADOR", farmaciaId: farm.id, passwordHash: hash } });
  await db.utilizador.create({ data: { email: `gestor@${slug}.pt`, nome: "Gestor Farmácia", perfil: "GESTOR_FARMACIA", farmaciaId: farm.id, passwordHash: hash } });

  const fab = await db.fabricante.create({ data: { nomeNormalizado: "LABORATORIOS ALFA LDA" } });
  const destino = await db.fabricante.create({ data: { nomeNormalizado: "LABORATORIOS ALFA PHARMA LDA" } });
  const outra = await db.fabricante.create({ data: { nomeNormalizado: "OUTRA MARCA LDA" } });
  const mk = async (i: number, fabricanteId: string) =>
    (await db.produto.create({ data: { cnp: baseCnp + i, designacao: `Artigo ${baseCnp + i}`, fabricanteId } })).cnp;
  const cnps = [await mk(1, fab.id), await mk(2, fab.id), await mk(3, fab.id)];
  const destinoCnps = [await mk(4, destino.id), await mk(5, destino.id)];
  const outroFabCnp = await mk(6, outra.id);
  return { fabId: fab.id, fabNome: fab.nomeNormalizado, cnps, outroFabCnp, destinoCnps };
}

async function login(browser: Browser, slug: string, email: string): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${base(slug)}/login`);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  await Promise.all([page.waitForURL(/\/dashboard/, { timeout: 60_000 }), page.click('button[type="submit"]')]);
  await page.close();
  return ctx;
}

const artigoUrl = (slug: string, cnp: number) => `${base(slug)}/stock/artigo/${cnp}`;


/**
 * Chama uma server action DIRETAMENTE (sem passar pela UI), a partir do próprio
 * browser — o Node não resolve `*.localhost`, o Chromium sim. Mesmos cookies da
 * sessão, mesmo endpoint e mesmo cabeçalho `Next-Action` que a UI usa.
 */
async function postarAcao(ctx: BrowserContext, slug: string, cnpDaPagina: number, actionId: string | null, payload: unknown): Promise<string> {
  const page = await ctx.newPage();
  try {
    await page.goto(`${base(slug)}/login`, { waitUntil: "domcontentloaded" });
    return await page.evaluate(
      async ({ url, id, corpo }) => {
        const r = await fetch(url, {
          method: "POST",
          credentials: "include",
          redirect: "manual",
          headers: { "next-action": id, "content-type": "text/plain;charset=UTF-8", accept: "text/x-component" },
          body: corpo,
        });
        return `${r.status}|${r.type}|${await r.text().catch(() => "")}`;
      },
      { url: artigoUrl(slug, cnpDaPagina), id: actionId ?? "", corpo: JSON.stringify(payload) },
    );
  } finally {
    await page.close();
  }
}

async function abrirArtigo(ctx: BrowserContext, slug: string, cnp: number): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(artigoUrl(slug, cnp), { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.getByText("Fabricante", { exact: true }).first().waitFor({ timeout: 60_000 });
  return page;
}

async function main() {
  // Control plane: regista os tenants apontando para as bases locais.
  const controlUrl = urlLocal("E2E_DB_CONTROL");
  const control = new ControlClient({ adapter: new PrismaPg({ connectionString: controlUrl.toString() }) });
  await control.tenantEvent.deleteMany();
  await control.tenant.deleteMany();
  const dbs: Record<string, PrismaClient> = {};
  const dados: Record<string, Dados> = {};
  for (const t of TENANTS) {
    const u = urlLocal(t.env);
    await control.tenant.create({
      data: {
        slug: t.slug, nome: t.nome, estado: "ACTIVE",
        dbHost: u.hostname, dbPort: Number(u.port || 5432), dbName: u.pathname.slice(1),
        dbUser: decodeURIComponent(u.username), dbPassEncrypted: encryptTenantSecret(decodeURIComponent(u.password)),
      },
    });
    dbs[t.slug] = tenantDb(t.env);
    // MESMOS CNPs/nomes em todos os tenants de propósito: prova o isolamento.
    dados[t.slug] = await semear(dbs[t.slug], t.slug, 7_100_000);
  }

  const browser = await chromium.launch();
  try {
    const sil = dados.silveira;
    const fabSil = () => dbs.silveira.fabricante.findUnique({ where: { id: sil.fabId } });

    // ───────────────────────── Silveirense: administrador ─────────────────────────
    console.log("\nSilveirense · administrador");
    const adminCtx = await login(browser, "silveira", "admin@silveira.pt");
    let page = await abrirArtigo(adminCtx, "silveira", sil.cnps[0]);

    // Captura o id da server action a partir do tráfego real do browser (usado mais abaixo).
    let actionId: string | null = null;
    page.on("request", (r) => {
      const id = r.headers()["next-action"];
      if (r.method() === "POST" && id && /aplicar|"modo"/.test(r.postData() ?? "")) actionId = id;
    });

    check(await page.getByTestId("fabricante-editar").isVisible(), "o editor EXISTENTE («Editar», pesquisar/criar fabricante) continua presente");
    const botao = page.getByTestId("editar-fabricante-abrir");
    check(await botao.isVisible(), "botão «Editar nome do fabricante» visível junto ao fabricante");
    check((await page.getByText("LABORATORIOS ALFA LDA").count()) > 0, "mostra o fabricante atual");

    // Nome vazio / igual.
    await botao.click();
    check(await page.getByTestId("editar-fabricante-dialogo").isVisible(), "abre o diálogo");
    check((await page.getByTestId("editar-fabricante-input").inputValue()) === "LABORATORIOS ALFA LDA", "input vem preenchido com o nome atual");
    await page.getByTestId("editar-fabricante-input").fill("   ");
    await page.getByTestId("editar-fabricante-continuar").click();
    await page.getByTestId("editar-fabricante-erro").waitFor();
    check(/vazio/i.test((await page.getByTestId("editar-fabricante-erro").textContent()) ?? ""), "mensagem de erro para nome vazio");
    await page.getByTestId("editar-fabricante-input").fill("  laboratórios ALFA, lda ");
    await page.getByTestId("editar-fabricante-continuar").click();
    await page.waitForFunction(() => /igual ao atual/i.test(document.querySelector('[data-testid="editar-fabricante-erro"]')?.textContent ?? ""));
    check(true, "mensagem de erro para nome igual (ignorando espaços/maiúsculas/acentos)");

    // Confirmação clara + Cancelar não altera nada.
    await page.getByTestId("editar-fabricante-input").fill("Laboratórios Alfa Portugal, Lda.");
    await page.getByTestId("editar-fabricante-continuar").click();
    await page.getByTestId("editar-fabricante-confirmacao").waitFor();
    const conf = (await page.getByTestId("editar-fabricante-confirmacao").textContent()) ?? "";
    check(conf.includes("LABORATORIOS ALFA LDA") && conf.includes("LABORATORIOS ALFA PORTUGAL LDA") && /Artigos afetados:\s*3/.test(conf), "confirmação mostra nome atual, novo nome e nº de artigos (3)", conf);
    check(conf.includes("Esta alteração irá mudar o nome do fabricante em 3 artigos deste tenant."), "texto exato da confirmação");
    await page.getByTestId("editar-fabricante-cancelar").click();
    check((await page.getByTestId("editar-fabricante-dialogo").count()) === 0, "cancelar fecha o diálogo");
    check((await fabSil())?.nomeNormalizado === "LABORATORIOS ALFA LDA" && (await dbs.silveira.auditLog.count()) === 0, "cancelar não alterou a BD nem escreveu AuditLog");

    // Confirmar → sucesso e atualização imediata (sem recarregar).
    await botao.click();
    await page.getByTestId("editar-fabricante-input").fill("Laboratórios Alfa Portugal, Lda.");
    await page.getByTestId("editar-fabricante-continuar").click();
    await page.getByTestId("editar-fabricante-confirmar").click();
    await page.getByTestId("editar-fabricante-sucesso").waitFor({ timeout: 30_000 });
    check(/3 artigos/.test((await page.getByTestId("editar-fabricante-sucesso").textContent()) ?? ""), "mensagem de sucesso (3 artigos)");
    await page.waitForFunction(() => document.querySelector('[data-testid="fabricante-valor"]')?.textContent === "LABORATORIOS ALFA PORTUGAL LDA", null, { timeout: 30_000 });
    check(true, "fabricante apresentado atualiza imediatamente, sem recarregar a página");
    check(!(await page.locator("text=LABORATORIOS ALFA LDA").count()), "o nome antigo deixou de aparecer na ficha");
    const f1 = await fabSil();
    check(f1?.nomeNormalizado === "LABORATORIOS ALFA PORTUGAL LDA", "BD: nome alterado");
    for (const c of sil.cnps) {
      const p = await dbs.silveira.produto.findUnique({ where: { cnp: c }, include: { fabricante: true } });
      check(p?.fabricante?.nomeNormalizado === "LABORATORIOS ALFA PORTUGAL LDA", `BD: artigo ${c} mostra o novo nome`);
    }
    const outro = await dbs.silveira.produto.findUnique({ where: { cnp: sil.outroFabCnp }, include: { fabricante: true } });
    check(outro?.fabricante?.nomeNormalizado === "OUTRA MARCA LDA", "artigo de outro fabricante intacto");
    const audit = await dbs.silveira.auditLog.findMany();
    const meta = JSON.parse(audit[0]?.metaJson ?? "{}");
    check(audit.length === 1 && audit[0].actorId !== null && meta.tenant === "silveira" && meta.fabricanteAnterior === "LABORATORIOS ALFA LDA" && meta.fabricanteNovo === "LABORATORIOS ALFA PORTUGAL LDA" && meta.artigosAfetados === 3 && meta.modo === "RENOMEACAO",
      "AuditLog: utilizador, tenant, anterior, novo, nº artigos, renomeação", audit[0]?.metaJson ?? "");
    check(!!actionId, "id da server action capturado do tráfego real");
    await page.close();

    // Consolidação num fabricante existente (sem duplicar, só com confirmação).
    console.log("\nSilveirense · consolidação");
    page = await abrirArtigo(adminCtx, "silveira", sil.cnps[1]);
    await page.getByTestId("editar-fabricante-abrir").click();
    await page.getByTestId("editar-fabricante-input").fill("laboratorios alfa pharma, lda");
    await page.getByTestId("editar-fabricante-continuar").click();
    await page.getByTestId("editar-fabricante-aviso-consolidacao").waitFor();
    const aviso = (await page.getByTestId("editar-fabricante-aviso-consolidacao").textContent()) ?? "";
    check(/Já existe/.test(aviso) && /2 artigos/.test(aviso) && /Não será criado nenhum duplicado/.test(aviso), "avisa que já existe e pergunta se quer consolidar", aviso);
    check((await dbs.silveira.fabricante.count()) === 3, "nada foi criado nem consolidado automaticamente");
    await page.getByTestId("editar-fabricante-cancelar").click();
    check((await dbs.silveira.produto.count({ where: { fabricanteId: sil.fabId } })) === 3, "cancelar a consolidação não moveu artigos");
    await page.getByTestId("editar-fabricante-abrir").click();
    await page.getByTestId("editar-fabricante-input").fill("laboratorios alfa pharma, lda");
    await page.getByTestId("editar-fabricante-continuar").click();
    await page.getByTestId("editar-fabricante-confirmar").click();
    await page.getByTestId("editar-fabricante-sucesso").waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => document.querySelector('[data-testid="fabricante-valor"]')?.textContent === "LABORATORIOS ALFA PHARMA LDA", null, { timeout: 30_000 });
    check(true, "consolidação confirmada; ficha atualiza imediatamente");
    check((await dbs.silveira.produto.count()) === 6, "nenhum artigo perdido ou duplicado (6)");
    const destino = await dbs.silveira.fabricante.findUnique({ where: { nomeNormalizado: "LABORATORIOS ALFA PHARMA LDA" } });
    check((await dbs.silveira.produto.count({ where: { fabricanteId: destino!.id } })) === 5, "destino ficou com 3 + 2 = 5 artigos");
    check((await fabSil())?.estado === "INATIVO", "fabricante de origem fica INATIVO (não apagado)");
    const consol = (await dbs.silveira.auditLog.findMany({ where: { action: "fabricante.consolidado" } }))[0];
    check(!!consol && JSON.parse(consol.metaJson ?? "{}").modo === "CONSOLIDACAO" && JSON.parse(consol.metaJson ?? "{}").artigosAfetados === 3, "AuditLog: consolidação (3 artigos)");
    await page.close();

    // ───────────────────────── Permissões no ecrã e na action ─────────────────────────
    console.log("\nPermissões");
    for (const email of ["operador@silveira.pt", "gestor@silveira.pt"]) {
      const ctx = await login(browser, "silveira", email);
      const p = await abrirArtigo(ctx, "silveira", sil.destinoCnps[0]);
      check((await p.getByTestId("editar-fabricante-abrir").count()) === 0, `${email}: botão NÃO aparece`);
      await p.close();
      // Chamada directa da action com a sessão sem permissão.
      const corpo = await postarAcao(ctx, "silveira", sil.destinoCnps[0], actionId, [{ cnp: sil.destinoCnps[0], novoNome: "Hackeado Lda", modo: "RENOMEACAO", artigosConfirmados: 5 }]);
      check(/Sem permiss/.test(corpo), `${email}: action chamada diretamente é recusada`, corpo.slice(0, 200));
      ctx.close();
    }
    check((await dbs.silveira.fabricante.findUnique({ where: { id: destino!.id } }))?.nomeNormalizado === "LABORATORIOS ALFA PHARMA LDA", "nenhuma chamada sem permissão alterou dados");

    // Sessão da Silveirense NÃO vale na Garantia — nem forjando o cookie no host da Garantia.
    {
      const cookies = await adminCtx.cookies(base("silveira"));
      const sessao = cookies.find((c) => c.name === "session");
      const ctx = await browser.newContext();
      await ctx.addCookies([{ name: "session", value: sessao!.value, url: base("garantia") }]);
      const p = await ctx.newPage();
      await p.goto(artigoUrl("garantia", dados.garantia.cnps[0]), { waitUntil: "domcontentloaded" });
      check(/\/login/.test(p.url()), "cookie da Silveirense colado no host da Garantia é recusado (vai para /login)", p.url());
      const cruzado = await postarAcao(ctx, "garantia", dados.garantia.cnps[0], actionId, [{ cnp: dados.garantia.cnps[0], novoNome: "Cruzado Lda", modo: "RENOMEACAO", artigosConfirmados: 3 }]);
      check(!/"ok":true/.test(cruzado), "action chamada com o cookie da Silveirense no host da Garantia NÃO executa", cruzado.slice(0, 160));
      await ctx.close();
    }
    check((await dbs.garantia.fabricante.findUnique({ where: { id: dados.garantia.fabId } }))?.nomeNormalizado === "LABORATORIOS ALFA LDA", "Garantia não foi alterada por sessão/action da Silveirense");

    // ───────────────────────── Garantia ─────────────────────────
    console.log("\nGarantia");
    {
      const g = dados.garantia;
      const ctx = await login(browser, "garantia", "admin@garantia.pt");
      const p = await abrirArtigo(ctx, "garantia", g.cnps[0]);
      check(await p.getByTestId("editar-fabricante-abrir").isVisible(), "botão visível na Garantia");
      await p.getByTestId("editar-fabricante-abrir").click();
      await p.getByTestId("editar-fabricante-input").fill("Alfa Garantia Lda");
      await p.getByTestId("editar-fabricante-continuar").click();
      await p.getByTestId("editar-fabricante-confirmar").click();
      await p.getByTestId("editar-fabricante-sucesso").waitFor({ timeout: 30_000 });
      await p.waitForFunction(() => document.querySelector('[data-testid="fabricante-valor"]')?.textContent === "ALFA GARANTIA LDA", null, { timeout: 30_000 });
      check((await dbs.garantia.fabricante.findUnique({ where: { id: g.fabId } }))?.nomeNormalizado === "ALFA GARANTIA LDA", "Garantia: renomeado na BD da Garantia");
      // Mesmo nome e MESMOS CNPs na Silveirense: intactos.
      check((await dbs.silveira.fabricante.findUnique({ where: { nomeNormalizado: "LABORATORIOS ALFA PHARMA LDA" } })) !== null && (await dbs.silveira.fabricante.count({ where: { nomeNormalizado: "ALFA GARANTIA LDA" } })) === 0, "Silveirense não foi tocada pela alteração da Garantia");
      check((await dbs.garantia.auditLog.count()) === 1 && (await dbs.segurado.auditLog.count()) === 0, "AuditLog só no tenant da alteração");
      await p.close();
      await ctx.close();
    }

    // ───────────────────────── Tenant sem a funcionalidade ─────────────────────────
    console.log("\nTenant sem a funcionalidade (segurado)");
    {
      const s = dados.segurado;
      const ctx = await login(browser, "segurado", "admin@segurado.pt");
      const p = await abrirArtigo(ctx, "segurado", s.cnps[0]);
      check((await p.getByTestId("editar-fabricante-abrir").count()) === 0, "ADMINISTRADOR de outro tenant NÃO vê «Editar nome do fabricante»");
      check(await p.getByTestId("fabricante-editar").isVisible(), "…mas continua a ver o editor existente (nada mudou para ele)");
      check((await p.getByText("LABORATORIOS ALFA LDA").count()) > 0, "a ficha continua a funcionar normalmente");
      const corpo = await postarAcao(ctx, "segurado", s.cnps[0], actionId, [{ cnp: s.cnps[0], novoNome: "Hackeado Lda", modo: "RENOMEACAO", artigosConfirmados: 3 }]);
      check(/Sem permiss/.test(corpo), "action chamada diretamente neste tenant é recusada", corpo.slice(0, 200));
      check((await dbs.segurado.fabricante.findUnique({ where: { id: s.fabId } }))?.nomeNormalizado === "LABORATORIOS ALFA LDA" && (await dbs.segurado.auditLog.count()) === 0, "BD do tenant sem funcionalidade intacta");
      await p.close();
      await ctx.close();
    }
    await adminCtx.close();
  } finally {
    await browser.close();
    for (const db of Object.values(dbs)) await db.$disconnect();
    await control.$disconnect();
  }

  console.log(`\n${ok} OK, ${ko} FALHA`);
  process.exit(ko === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
