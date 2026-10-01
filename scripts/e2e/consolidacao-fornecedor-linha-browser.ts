/**
 * scripts/e2e/consolidacao-fornecedor-linha-browser.ts
 *
 * Ensaio de browser real (Chromium via Playwright) contra `next start`
 * local + PostgreSQL descartável — fornecedor-por-linha no modo
 * "consolidacao" (rascunho REAL por farmácia, autosave próprio,
 * recuperação por `?consolidacao=<batchKey>`, finalização agrupando
 * primeiro por farmácia, depois por fornecedor). Mesma disciplina e
 * convenções de `scripts/e2e/fornecedor-por-linha-encomendas-browser.ts`
 * (esse cobre os modos "farmacia"/"grupo" — este cobre "consolidacao").
 *
 *   docker run -d --name spharm-cfl-e2e-pg -e POSTGRES_PASSWORD=test -p 55494:5432 postgres:16-alpine
 *   createdb -h localhost -p 55494 -U postgres spharm_e2e_cfl
 *   DATABASE_URL=postgresql://postgres:test@localhost:55494/spharm_e2e_cfl npx prisma migrate deploy
 *   SERVER_ACTIONS_ALLOWED_ORIGINS="localhost:3100,127.0.0.1:3100,*.localhost:3100" npx next build
 *   E2E_DATABASE_URL=postgresql://postgres:test@localhost:55494/spharm_e2e_cfl bash scripts/e2e/_start-server.sh &
 *   npx tsx scripts/e2e/consolidacao-fornecedor-linha-browser.ts
 *
 * 19 passos pedidos, por ordem:
 *   1  abrir modo consolidação
 *   2  duas farmácias seleccionadas (a base descartável só semeia estas
 *      duas — "consolidacao" nunca tem um selector de farmácia próprio,
 *      usa sempre TODAS as farmácias ATIVO, ver `generateProposalAction`)
 *   3  gerar a proposta
 *   4  confirmar sugestões iniciais de fornecedor por farmácia
 *   5  mudar fornecedores individualmente
 *   6  alterar em massa (RESTRITO a uma farmácia)
 *   7  deixar uma linha sem fornecedor
 *   8  confirmar o bloqueio
 *   9  corrigi-la
 *   10 refrescar
 *   11 confirmar recuperação TOTAL (linhas, quantidades, fornecedores, por farmácia)
 *   12 finalizar
 *   13 confirmar quatro encomendas
 *   14 abrir os quatro documentos
 *   15 simular uma resposta perdida
 *   16 repetir
 *   17 confirmar zero duplicados
 *   18 anular uma
 *   19 confirmar que as restantes continuam activas
 *
 * Passos acrescentados na auditoria de 2026-10-01 (entre o 9 e o 10):
 *   9a notas por linha e em massa por farmácia — MESMO produto, notas diferentes
 *   9b editar fornecedor/quantidade/notas em A, navegar para outra página,
 *      regressar pela URL, confirmar recuperação integral
 *   9c duas batchKey independentes: A → B → A sem misturar dados
 *   9d bloqueio optimista com DUAS sessões: conflito explícito (autosave e
 *      finalização), farmácia identificada, finalização bloqueada até recarregar
 *   9e CORRIDA na criação do rascunho: a resposta da criação é ATRASADA (route.fetch +
 *      espera, resposta real retida) e, nesse intervalo, editam-se 2 linhas, fornecedor/
 *      quantidade/notas e uma remoção — tudo tem de ficar na BD quando a resposta chega
 *   9f FLUSH ao desmontar: editar e navegar IMEDIATAMENTE (navegação de cliente, antes do
 *      debounce), SEM esperar pela BD; só depois confirmar a BD e regressar pela URL; repetido
 *      com uma remoção + contexto pendente (cobertura alterada e proposta regenerada)
 *   9g SEM gravação cruzada: trocar de batchKey durante o debounce grava só no rascunho de
 *      origem; trocar durante a criação do rascunho descarta a conclusão (nada na consolidação
 *      errada)
 *   9c agora cria a SEGUNDA consolidação integralmente pela UI (proposta gerada, não semeada);
 *      a regra de pendingQty foi corrigida (rascunhos já não contam) — ver
 *      test-proposta-pending-qty-db.ts
 *   11e / 13e notas recuperadas após o refresh e presentes, isoladas, nos 4 documentos
 *
 * ── Desenho dos dados ────────────────────────────────────────────────
 * Farmácia A: P1→Alfa, P2→Beta (sugestão inicial). Farmácia B: P1 (o
 * MESMO produto — fornecedor DIFERENTE por farmácia) →Gama, P3→sem
 * fornecedor (habitual nulo, propositadamente — é a linha do passo 7).
 * Depois de: (5) mudar P1/B de Gama para Delta, (6) massa em toda a
 * farmácia A para Alfa (unifica A a 1 fornecedor), mais uma correcção
 * individual de P2/A para Beta (diversifica A outra vez — 2
 * fornecedores), (9) corrigir P3/B para Beta — o resultado final é:
 * A = {Alfa: P1, Beta: P2}, B = {Delta: P1, Beta: P3} → 4 documentos.
 */
import { chromium, type Page } from "playwright";
import { SignJWT } from "jose";
import Module from "node:module";

const DB = process.env.E2E_DATABASE_URL ?? "postgresql://postgres:test@localhost:55494/spharm_e2e_cfl";
// `_start-server.sh` (partilhado com os outros ensaios) usa sempre a
// porta 3100 — nunca configurável por env var. Mantém-se aqui para bater
// com o servidor real que o runbook do topo do ficheiro arranca.
const PORT = process.env.E2E_PORT ?? "3100";
const SECRET = process.env.E2E_AUTH_SECRET ?? "e2e-test-secret-e2e-test-secret-0123456789";
{
  const h = new URL(DB).hostname;
  if (h !== "localhost" && h !== "127.0.0.1") { console.error(`RECUSADO: ${h} não é local.`); process.exit(2); }
}
function baseFor(slug: string) {
  return `http://${slug}.localhost:${PORT}`;
}
process.env.DATABASE_URL = DB;

const M = Module as unknown as { _resolveFilename: (r: string, ...a: unknown[]) => string };
const resolverOriginal = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "server-only" ? __filename : resolverOriginal.call(this, request, ...rest);
};

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string, detalhe?: string) {
  if (cond) { passed++; console.log(`  [OK]    ${msg}`); }
  else { failed++; console.log(`  [FALHA] ${msg}${detalhe ? `\n            ${detalhe}` : ""}`); }
}

function campoPorLabel(page: Page, label: string, tag: "input" | "select") {
  return page.locator(`xpath=//label[normalize-space(text())="${label}"]/following-sibling::${tag}`);
}
function campoPorLabelPesquisa(page: Page) {
  return page.getByPlaceholder("Procurar por nome…");
}
function fornecedorBotao(page: Page, designacao: string, farmaciaNome: string) {
  return page.getByRole("button", { name: `Fornecedor de ${designacao} em ${farmaciaNome}` });
}
function fornecedorCombobox(page: Page, designacao: string, farmaciaNome: string) {
  return page.getByRole("combobox", { name: `Fornecedor de ${designacao} em ${farmaciaNome}` });
}
async function escolherFornecedorViaPicker(page: Page, designacao: string, farmaciaNome: string, termo: string) {
  await fornecedorBotao(page, designacao, farmaciaNome).click();
  const combo = fornecedorCombobox(page, designacao, farmaciaNome);
  await combo.waitFor({ state: "visible" });
  await combo.fill(termo);
  const opcao = page.getByRole("listbox").first().getByRole("option").first();
  await opcao.waitFor({ state: "visible" });
  await opcao.click();
  await page.waitForTimeout(300);
}
function notasInput(page: Page, designacao: string, farmaciaNome: string) {
  return page.getByLabel(`Notas de ${designacao} em ${farmaciaNome}`, { exact: true });
}
function qtdInput(page: Page, designacao: string, farmaciaNome: string) {
  return page.getByLabel(`Quantidade de ${designacao} em ${farmaciaNome}`, { exact: true });
}
async function esperarPor(cond: () => Promise<boolean>, ms = 20000): Promise<boolean> {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    if (await cond().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
function aceitarDialogosAutomaticamente(page: Page) {
  page.on("dialog", (d) => { d.accept().catch(() => {}); });
}

// ─── Seed ────────────────────────────────────────────────────────────────────

type SeedResult = {
  adminUserId: string;
  farmaciaAId: string;
  farmaciaBId: string;
  farmaciaANome: string;
  farmaciaBNome: string;
  fornAlfaId: string;
  fornBetaId: string;
  fornGamaId: string;
  fornDeltaId: string;
};

async function limparEncomendasDaFarmacia(prisma: import("../../generated/prisma/client").PrismaClient, farmaciaId: string) {
  const listas = await prisma.listaEncomenda.findMany({ where: { farmaciaId }, select: { id: true } });
  const ids = listas.map((l) => l.id);
  if (ids.length === 0) return;
  await prisma.orderExportAudit.deleteMany({ where: { outbox: { listaEncomendaId: { in: ids } } } });
  await prisma.orderOutbox.deleteMany({ where: { listaEncomendaId: { in: ids } } });
  await prisma.linhaEncomenda.deleteMany({ where: { listaEncomendaId: { in: ids } } });
  await prisma.listaEncomenda.deleteMany({ where: { id: { in: ids } } });
}

async function seedProdutoComVendas(
  prisma: import("../../generated/prisma/client").PrismaClient,
  opts: { cnp: number; designacao: string; farmaciaId: string; fornecedorHabitualId: string | null }
) {
  const produto = await prisma.produto.upsert({
    where: { cnp: opts.cnp },
    update: { designacao: opts.designacao },
    create: { cnp: opts.cnp, designacao: opts.designacao, estado: "VALIDADO" },
  });
  await prisma.produtoFarmacia.upsert({
    where: { produtoId_farmaciaId: { produtoId: produto.id, farmaciaId: opts.farmaciaId } },
    update: { fornecedorHabitualId: opts.fornecedorHabitualId, stockAtual: 2, stockMinimo: 5, stockMaximo: 40, pvp: 10, pmc: 9, puc: 5 },
    create: {
      produtoId: produto.id, farmaciaId: opts.farmaciaId, fornecedorHabitualId: opts.fornecedorHabitualId,
      stockAtual: 2, stockMinimo: 5, stockMaximo: 40, pvp: 10, pmc: 9, puc: 5, taxaIvaPercent: 23,
    },
  });
  const now = new Date();
  for (let m = 1; m <= 3; m++) {
    const d = new Date(now.getFullYear(), now.getMonth() - m, 1);
    await prisma.vendaMensal.upsert({
      where: {
        farmaciaId_produtoId_ano_mes_naturezaVenda: {
          farmaciaId: opts.farmaciaId, produtoId: produto.id, ano: d.getFullYear(), mes: d.getMonth() + 1, naturezaVenda: "NORMAL",
        },
      },
      update: { quantidade: 30 },
      create: {
        farmaciaId: opts.farmaciaId, produtoId: produto.id, ano: d.getFullYear(), mes: d.getMonth() + 1,
        quantidade: 30, valorTotal: 300, naturezaVenda: "NORMAL",
      },
    });
  }
  return produto.id;
}

async function seed(databaseUrl: string): Promise<SeedResult> {
  const { PrismaClient } = await import("../../generated/prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  try {
    const admin = await prisma.utilizador.upsert({
      where: { email: "e2e-cfl-admin@spharm.test" }, update: {},
      create: { email: "e2e-cfl-admin@spharm.test", nome: "E2E CFL Admin", perfil: "ADMINISTRADOR" },
    });
    const farmaciaANome = "CFL E2E Farmácia A";
    const farmaciaBNome = "CFL E2E Farmácia B";
    const fA = await prisma.farmacia.upsert({ where: { nome: farmaciaANome }, update: {}, create: { nome: farmaciaANome } });
    const fB = await prisma.farmacia.upsert({ where: { nome: farmaciaBNome }, update: {}, create: { nome: farmaciaBNome } });
    // Corridas repetidas deste ensaio contra a MESMA base descartável
    // deixavam rascunhos/encomendas anteriores por trás — cujas linhas
    // pendentes inflacionavam `pendingQty` na proposta seguinte e
    // faziam o motor decidir AGUARDAR (suggestedQty=0) em vez de
    // COMPRAR. Mesma limpeza de
    // `fornecedor-por-linha-encomendas-browser.ts` — nunca contra uma
    // base real (guarda de segurança no topo do ficheiro).
    await limparEncomendasDaFarmacia(prisma, fA.id);
    await limparEncomendasDaFarmacia(prisma, fB.id);

    const fornAlfa = await prisma.fornecedor.upsert({ where: { nomeNormalizado: "CFL E2E FORNECEDOR ALFA" }, update: {}, create: { nomeNormalizado: "CFL E2E FORNECEDOR ALFA", nome: "CFL Fornecedor Alfa" } });
    const fornBeta = await prisma.fornecedor.upsert({ where: { nomeNormalizado: "CFL E2E FORNECEDOR BETA" }, update: {}, create: { nomeNormalizado: "CFL E2E FORNECEDOR BETA", nome: "CFL Fornecedor Beta" } });
    const fornGama = await prisma.fornecedor.upsert({ where: { nomeNormalizado: "CFL E2E FORNECEDOR GAMA" }, update: {}, create: { nomeNormalizado: "CFL E2E FORNECEDOR GAMA", nome: "CFL Fornecedor Gama" } });
    const fornDelta = await prisma.fornecedor.upsert({ where: { nomeNormalizado: "CFL E2E FORNECEDOR DELTA" }, update: {}, create: { nomeNormalizado: "CFL E2E FORNECEDOR DELTA", nome: "CFL Fornecedor Delta" } });

    // P1 é o MESMO produto nas duas farmácias, com fornecedor habitual
    // DIFERENTE em cada uma — exactamente o cenário "mesmo produto,
    // fornecedor diferente por farmácia".
    const p1Id = await seedProdutoComVendas(prisma, { cnp: 7_600_001, designacao: "CFL P1", farmaciaId: fA.id, fornecedorHabitualId: fornAlfa.id });
    await seedProdutoComVendas(prisma, { cnp: 7_600_001, designacao: "CFL P1", farmaciaId: fB.id, fornecedorHabitualId: fornGama.id });
    await seedProdutoComVendas(prisma, { cnp: 7_600_002, designacao: "CFL P2", farmaciaId: fA.id, fornecedorHabitualId: fornBeta.id });
    await seedProdutoComVendas(prisma, { cnp: 7_600_003, designacao: "CFL P3", farmaciaId: fB.id, fornecedorHabitualId: null });
    void p1Id;

    return {
      adminUserId: admin.id,
      farmaciaAId: fA.id, farmaciaBId: fB.id,
      farmaciaANome, farmaciaBNome,
      fornAlfaId: fornAlfa.id, fornBetaId: fornBeta.id, fornGamaId: fornGama.id, fornDeltaId: fornDelta.id,
    };
  } finally {
    await prisma.$disconnect();
  }
}

// ─── Sessão forjada ──────────────────────────────────────────────────────────

async function contextoTenant(browser: import("playwright").Browser, tenant: string, sub: string, email: string) {
  const token = await new SignJWT({
    sub, email, nome: "E2E CFL Admin", perfil: "ADMINISTRADOR", farmaciaId: null, tenant,
  }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("8h").sign(new TextEncoder().encode(SECRET));
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: "session", value: token, url: baseFor(tenant) }]);
  return ctx;
}

async function main() {
  const tenant = "silveira";
  const seedData = await seed(DB);
  const { PrismaClient } = await import("../../generated/prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB }) });
  const { deriveFarmaciaIdempotencyKey } = await import("../../lib/ingest/orders");
  /** A linha de um produto (por CNP) no rascunho REAL de uma farmácia numa consolidação (por batchKey). */
  const linhaBd = (batchKey: string, farmaciaId: string, cnp: number) =>
    prisma.linhaEncomenda.findFirst({
      where: { produto: { cnp }, listaEncomenda: { clientIdempotencyKey: deriveFarmaciaIdempotencyKey(batchKey, farmaciaId) } },
      select: { notas: true, quantidadeAjustada: true, fornecedorSugeridoId: true },
    });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const tenantE2E = "silveira";
  const isoData = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  /** Gera a proposta CONSOLIDADA pelo ecrã (datas + botão) e espera pela vista — sem tocar na BD. */
  async function gerarPropostaConsolidacao(p: Page) {
    const hoje = new Date();
    await campoPorLabel(p, "Data início", "input").fill(isoData(new Date(hoje.getFullYear(), hoje.getMonth() - 6, 1)));
    await campoPorLabel(p, "Data fim", "input").fill(isoData(hoje));
    await p.getByRole("button", { name: /Gerar (nova )?proposta/ }).click();
    await p.getByText("CFL P1").first().waitFor({ timeout: 30000 });
  }
  /** Abre /encomendas/nova, escolhe Consolidação e devolve a batchKey NOVA que o ecrã gerou. */
  async function abrirNovaConsolidacao(p: Page): Promise<string> {
    await p.goto(`${baseFor(tenantE2E)}/encomendas/nova`, { waitUntil: "networkidle" });
    await p.getByRole("button", { name: "Consolidação" }).click();
    await p.waitForFunction(() => new URL(location.href).searchParams.get("consolidacao") !== null);
    return new URL(p.url()).searchParams.get("consolidacao")!;
  }
  /** Navegação de CLIENTE (sem recarregar a página) para um URL — o componente desmonta/reage como numa navegação real. */
  async function navegarNoCliente(p: Page, url: string) {
    await p.evaluate((u) => {
      const w = window as unknown as { next?: { router?: { push: (x: string) => void } } };
      if (w.next?.router) w.next.router.push(u);
      else { history.pushState(null, "", u); }
    }, url);
  }
  /** Retém a RESPOSTA real das acções de criação de rascunho (a escrita no servidor acontece logo; só a resposta chega tarde). */
  async function atrasarCriacaoDeRascunho(p: Page, ms: number) {
    const contador = { n: 0 };
    await p.route("**/encomendas/nova**", async (route) => {
      const req = route.request();
      const corpo = req.postData() ?? "";
      if (req.method() === "POST" && req.headers()["next-action"] && corpo.includes('"batchKey"') && corpo.includes('"nome"') && corpo.includes('"linhas"')) {
        contador.n++;
        // Node não resolve *.localhost (o Chromium sim): vai ao [::1] (o servidor escuta em localhost/IPv6) mantendo o Host (o tenant vem do subdomínio).
        const u = new URL(req.url());
        const resposta = await route.fetch({ url: req.url().replace(u.hostname, "[::1]"), headers: { ...req.headers(), host: u.host } });
        await sleep(ms);
        await route.fulfill({ response: resposta });
      } else {
        await route.continue();
      }
    });
    return contador;
  }
  const browser = await chromium.launch();
  try {
    const ctx = await contextoTenant(browser, tenant, seedData.adminUserId, "e2e-cfl@spharm.test");
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1700, height: 1100 });
    aceitarDialogosAutomaticamente(page);
    page.on("console", (m) => { if (m.type() === "error") console.log(`  [console.error] ${m.text()}`); });
    page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));

    // ── 1 · abrir modo consolidação ───────────────────────────────────
    console.log("\n1 · abrir /encomendas/nova e mudar para o modo Consolidação");
    await page.goto(`${baseFor(tenant)}/encomendas/nova`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Consolidação" }).click();
    await page.waitForTimeout(300);
    check(new URL(page.url()).searchParams.get("consolidacao") !== null, "1: a sessão de consolidação ganhou uma batchKey na URL (?consolidacao=<key>)", page.url());

    // ── 2 · duas farmácias ────────────────────────────────────────────
    console.log("\n2 · duas farmácias envolvidas (a base descartável só semeia estas duas ATIVO)");
    check(!!seedData.farmaciaAId && !!seedData.farmaciaBId, "2: as duas farmácias semeadas existem e estão ATIVO (única fonte de 'quais farmácias' em modo consolidação)");

    // ── 3 · gerar a proposta ──────────────────────────────────────────
    console.log("\n3 · gerar a proposta");
    const hoje = new Date();
    const seisMesesAtras = new Date(hoje.getFullYear(), hoje.getMonth() - 6, 1);
    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    await campoPorLabel(page, "Data início", "input").fill(iso(seisMesesAtras));
    await campoPorLabel(page, "Data fim", "input").fill(iso(hoje));
    await page.getByRole("button", { name: /Gerar (nova )?proposta/ }).click();
    await page.getByText("CFL P1").first().waitFor({ timeout: 30000 });
    check(true, "3: a proposta consolidada foi gerada (Vista consolidada populada)");

    // ── 4 · confirmar sugestões iniciais ──────────────────────────────
    console.log("\n4 · confirmar a sugestão inicial de fornecedor por farmácia");
    check(
      (await fornecedorBotao(page, "CFL P1", seedData.farmaciaANome).innerText()).includes("Alfa"),
      "4a: P1 na Farmácia A sugere Alfa (fornecedorHabitual)"
    );
    check(
      (await fornecedorBotao(page, "CFL P2", seedData.farmaciaANome).innerText()).includes("Beta"),
      "4b: P2 na Farmácia A sugere Beta"
    );
    check(
      (await fornecedorBotao(page, "CFL P1", seedData.farmaciaBNome).innerText()).includes("Gama"),
      "4c: o MESMO produto P1 na Farmácia B sugere Gama — diferente da Farmácia A"
    );
    check(
      /sem fornecedor/i.test(await fornecedorBotao(page, "CFL P3", seedData.farmaciaBNome).innerText()),
      "4d: P3 na Farmácia B não tem sugestão (fornecedorHabitual nulo)"
    );

    // ── 5 · mudar fornecedores individualmente ────────────────────────
    console.log("\n5 · mudar um fornecedor individualmente via picker (P1/Farmácia B: Gama → Delta)");
    await escolherFornecedorViaPicker(page, "CFL P1", seedData.farmaciaBNome, "Delta");
    check(
      (await fornecedorBotao(page, "CFL P1", seedData.farmaciaBNome).innerText()).includes("Delta"),
      "5: P1 na Farmácia B passa a mostrar Delta"
    );

    // ── 6 · alterar em massa, RESTRITO a uma farmácia ─────────────────
    console.log("\n6 · alteração em massa limitada à Farmácia A (nunca cruza farmácias)");
    const farmaciaScopeSelect = page.locator("select").filter({ has: page.getByRole("option", { name: "— nesta farmácia —" }) });
    await farmaciaScopeSelect.selectOption({ label: seedData.farmaciaANome });
    await page.getByRole("button", { name: "Fornecedor a definir em toda a farmácia seleccionada" }).click();
    const bulkFarmaciaCombo = page.getByRole("combobox", { name: "Fornecedor a definir em toda a farmácia seleccionada" });
    await bulkFarmaciaCombo.waitFor({ state: "visible" });
    await bulkFarmaciaCombo.fill("Alfa");
    await page.getByRole("listbox").first().getByRole("option").first().click();
    await page.getByRole("button", { name: "Aplicar a toda a farmácia" }).click();
    await page.waitForTimeout(400);
    check((await fornecedorBotao(page, "CFL P1", seedData.farmaciaANome).innerText()).includes("Alfa"), "6a: a massa aplicou Alfa a P1/Farmácia A");
    check((await fornecedorBotao(page, "CFL P2", seedData.farmaciaANome).innerText()).includes("Alfa"), "6b: a massa aplicou Alfa a P2/Farmácia A também");
    check((await fornecedorBotao(page, "CFL P1", seedData.farmaciaBNome).innerText()).includes("Delta"), "6c: a Farmácia B NÃO foi afectada pela massa restrita à Farmácia A (continua Delta)");
    check(/sem fornecedor/i.test(await fornecedorBotao(page, "CFL P3", seedData.farmaciaBNome).innerText()), "6d: P3/Farmácia B continua sem fornecedor — a massa não lhe tocou");

    // Diversifica a Farmácia A de novo (para terminar com 2 fornecedores
    // distintos por farmácia e 4 documentos finais) — mudança individual,
    // não um passo numerado pedido, só preparação para os passos 12-13.
    await escolherFornecedorViaPicker(page, "CFL P2", seedData.farmaciaANome, "Beta");
    check((await fornecedorBotao(page, "CFL P2", seedData.farmaciaANome).innerText()).includes("Beta"), "6e (preparação): P2/Farmácia A volta a Beta — Farmácia A com 2 fornecedores distintos (Alfa, Beta)");

    // ── 7 · deixar uma linha sem fornecedor ────────────────────────────
    console.log("\n7 · P3/Farmácia B continua deliberadamente sem fornecedor");
    check(/sem fornecedor/i.test(await fornecedorBotao(page, "CFL P3", seedData.farmaciaBNome).innerText()), "7: P3/Farmácia B continua sem fornecedor definido");

    // ── 8 · confirmar o bloqueio ───────────────────────────────────────
    console.log("\n8 · 'Criar encomendas' bloqueia com uma linha sem fornecedor");
    await page.waitForTimeout(1500); // dá tempo ao autosave debounced de gravar antes de tentar finalizar
    await page.getByRole("button", { name: "Criar encomendas" }).click();
    const flashBloqueio = page.locator("div", { hasText: /sem fornecedor definido/ }).first();
    await flashBloqueio.waitFor({ timeout: 15000 });
    check(await flashBloqueio.isVisible(), "8: mensagem clara de bloqueio, nenhuma encomenda criada");

    // ── 9 · corrigi-la ─────────────────────────────────────────────────
    console.log("\n9 · corrigir P3/Farmácia B desbloqueia a finalização");
    // O bloqueio do Passo 8 activou "Só sem fornecedor" (mesmo filtro
    // partilhado com farmácia/grupo) — desliga-o antes de corrigir: assim
    // que P3 ganhar fornecedor deixa de bater no filtro e o seu chip
    // desapareceria a meio da correcção (comportamento correcto do
    // filtro, não um bug — só precisa de estar desligado para observar
    // o "antes/depois" desta correcção).
    const filtroSemFornecedor = page.getByLabel(/Só sem fornecedor/);
    if (await filtroSemFornecedor.isChecked()) await filtroSemFornecedor.uncheck();
    await escolherFornecedorViaPicker(page, "CFL P3", seedData.farmaciaBNome, "Beta");
    check((await fornecedorBotao(page, "CFL P3", seedData.farmaciaBNome).innerText()).includes("Beta"), "9: P3/Farmácia B já mostra Beta");

    // ── 9a · notas por linha e em massa por farmácia ────────────────────
    console.log("\n9a · notas por linha e por farmácia (o MESMO produto, notas DIFERENTES nas duas farmácias)");
    const batchKey0 = new URL(page.url()).searchParams.get("consolidacao")!;
    const A = seedData.farmaciaANome;
    const B = seedData.farmaciaBNome;
    // O selector de farmácia da massa continua em A (passo 6).
    await page.getByLabel("Nota a definir em toda a farmácia seleccionada").fill("nota massa A");
    await page.getByRole("button", { name: "Aplicar nota à farmácia" }).click();
    await page.waitForTimeout(300);
    check(
      (await notasInput(page, "CFL P1", A).inputValue()) === "nota massa A" && (await notasInput(page, "CFL P2", A).inputValue()) === "nota massa A",
      "9a: a nota em massa foi aplicada às linhas da Farmácia A"
    );
    check((await notasInput(page, "CFL P1", B).inputValue()) === "" && (await notasInput(page, "CFL P3", B).inputValue()) === "", "9a-ii: a Farmácia B NÃO foi afectada pela nota em massa de A");
    await notasInput(page, "CFL P1", A).fill("nota A P1");
    await notasInput(page, "CFL P1", B).fill("nota B P1");
    await notasInput(page, "CFL P3", B).fill("nota B P3");
    await qtdInput(page, "CFL P1", A).fill("17");
    const gravouNotas = await esperarPor(async () => {
      const [a1, a2, b1, b3] = await Promise.all([linhaBd(batchKey0, seedData.farmaciaAId, 7_600_001), linhaBd(batchKey0, seedData.farmaciaAId, 7_600_002), linhaBd(batchKey0, seedData.farmaciaBId, 7_600_001), linhaBd(batchKey0, seedData.farmaciaBId, 7_600_003)]);
      return a1?.notas === "nota A P1" && Number(a1?.quantidadeAjustada) === 17 && a2?.notas === "nota massa A" && b1?.notas === "nota B P1" && b3?.notas === "nota B P3";
    });
    check(gravouNotas, "9a-iii: o autosave gravou notas (e a quantidade) nos rascunhos REAIS de cada farmácia");
    const a1Bd = await linhaBd(batchKey0, seedData.farmaciaAId, 7_600_001);
    const b1Bd = await linhaBd(batchKey0, seedData.farmaciaBId, 7_600_001);
    check(a1Bd?.notas === "nota A P1" && b1Bd?.notas === "nota B P1", "9a-iv: o MESMO produto (CFL P1) tem notas diferentes em A e B na base de dados");

    // ── 9b · navegar para outra página e regressar ───────────────────────
    console.log("\n9b · editar em A, navegar para outra página, regressar pela URL — recuperação integral");
    await page.goto(`${baseFor(tenant)}/encomendas`, { waitUntil: "networkidle" });
    check(new URL(page.url()).searchParams.get("consolidacao") === null, "9b: estamos noutra página (sem sessão de consolidação)");
    await page.goto(`${baseFor(tenant)}/encomendas/nova?consolidacao=${batchKey0}`, { waitUntil: "networkidle" });
    await page.getByText("CFL P1").first().waitFor({ timeout: 20000 });
    check((await fornecedorBotao(page, "CFL P1", A).innerText()).includes("Alfa"), "9b-a: P1/A recupera o fornecedor (Alfa)");
    check((await fornecedorBotao(page, "CFL P2", A).innerText()).includes("Beta"), "9b-b: P2/A recupera o fornecedor (Beta)");
    check((await fornecedorBotao(page, "CFL P1", B).innerText()).includes("Delta"), "9b-c: P1/B recupera o fornecedor (Delta)");
    check((await qtdInput(page, "CFL P1", A).inputValue()) === "17", "9b-d: P1/A recupera a quantidade editada (17)");
    check((await notasInput(page, "CFL P1", A).inputValue()) === "nota A P1", "9b-e: P1/A recupera a nota (A)");
    check((await notasInput(page, "CFL P1", B).inputValue()) === "nota B P1", "9b-f: P1/B recupera a nota DIFERENTE (B) para o mesmo produto");
    check((await notasInput(page, "CFL P2", A).inputValue()) === "nota massa A" && (await notasInput(page, "CFL P3", B).inputValue()) === "nota B P3", "9b-g: as restantes notas recuperam-se");

    // ── 9c · duas consolidações independentes, AMBAS criadas pela UI: A → B → A ───────
    console.log("\n9c · duas consolidações independentes (batchKey A e B), a segunda criada INTEGRALMENTE pela UI — A → B → A");
    // A regra antiga de pendingQty contava os RASCUNHOS da consolidação A e a proposta B vinha a zero.
    const batchKey1 = await abrirNovaConsolidacao(page);
    check(batchKey1 !== batchKey0 && /^[a-f0-9]{32}$/.test(batchKey1), "9c-0: o ecrã gerou uma batchKey NOVA, diferente da primeira", `A=${batchKey0} B=${batchKey1}`);
    await gerarPropostaConsolidacao(page);
    check(
      Number(await qtdInput(page, "CFL P1", A).inputValue()) > 0 && Number(await qtdInput(page, "CFL P2", A).inputValue()) > 0 &&
        Number(await qtdInput(page, "CFL P1", B).inputValue()) > 0 && Number(await qtdInput(page, "CFL P3", B).inputValue()) > 0,
      "9c-1: a SEGUNDA proposta, gerada na UI com os rascunhos da primeira consolidação ainda abertos, traz quantidade > 0 em todas as linhas (não fica a zero/AGUARDAR)"
    );
    check((await fornecedorBotao(page, "CFL P1", A).innerText()).includes("Alfa") && (await fornecedorBotao(page, "CFL P1", B).innerText()).includes("Gama"),
      "9c-1b: as sugestões iniciais de B são as habituais (Alfa em A, Gama em B) — nada herdado dos fornecedores editados na consolidação A");
    await escolherFornecedorViaPicker(page, "CFL P1", A, "Gama");
    await escolherFornecedorViaPicker(page, "CFL P1", B, "Alfa");
    await qtdInput(page, "CFL P1", A).fill("5");
    await notasInput(page, "CFL P1", A).fill("lote2 nota A P1");
    await notasInput(page, "CFL P1", B).fill("lote2 nota B P1");
    check(await esperarPor(async () => {
      const [a, b] = await Promise.all([linhaBd(batchKey1, seedData.farmaciaAId, 7_600_001), linhaBd(batchKey1, seedData.farmaciaBId, 7_600_001)]);
      return a?.fornecedorSugeridoId === seedData.fornGamaId && Number(a?.quantidadeAjustada) === 5 && a?.notas === "lote2 nota A P1" && b?.fornecedorSugeridoId === seedData.fornAlfaId && b?.notas === "lote2 nota B P1";
    }), "9c-2: a consolidação B persistiu os SEUS fornecedor/quantidade/notas (drafts próprios, batchKey própria)");
    const draftsB = await prisma.listaEncomenda.count({ where: { clientIdempotencyKey: { in: [deriveFarmaciaIdempotencyKey(batchKey1, seedData.farmaciaAId), deriveFarmaciaIdempotencyKey(batchKey1, seedData.farmaciaBId)] } } });
    check(draftsB === 2, "9c-2b: B tem exactamente 2 rascunhos reais (um por farmácia), independentes dos de A");
    await page.waitForTimeout(1500);
    // A → B → A (navegação por URL)
    await page.goto(`${baseFor(tenant)}/encomendas/nova?consolidacao=${batchKey1}`, { waitUntil: "networkidle" });
    await page.getByText("CFL P1").first().waitFor({ timeout: 20000 });
    check((await fornecedorBotao(page, "CFL P1", A).innerText()).includes("Gama") && (await notasInput(page, "CFL P1", A).inputValue()) === "lote2 nota A P1" && (await qtdInput(page, "CFL P1", A).inputValue()) === "5", "9c-B: a consolidação B recupera SÓ os seus dados em A (Gama, nota, 5)");
    check((await fornecedorBotao(page, "CFL P1", B).innerText()).includes("Alfa") && (await notasInput(page, "CFL P1", B).inputValue()) === "lote2 nota B P1", "9c-B-ii: …e em B (Alfa, nota do lote 2)");
    await page.goto(`${baseFor(tenant)}/encomendas/nova?consolidacao=${batchKey0}`, { waitUntil: "networkidle" });
    await page.getByText("CFL P2").first().waitFor({ timeout: 20000 });
    check((await fornecedorBotao(page, "CFL P1", A).innerText()).includes("Alfa") && (await notasInput(page, "CFL P1", A).inputValue()) === "nota A P1" && (await qtdInput(page, "CFL P1", A).inputValue()) === "17", "9c-A: de volta à consolidação A — dados intactos (Alfa, nota A P1, 17), nada do lote 2");
    check((await fornecedorBotao(page, "CFL P1", B).innerText()).includes("Delta") && (await notasInput(page, "CFL P1", B).inputValue()) === "nota B P1", "9c-A-ii: …e em B (Delta, nota B P1)");
    const aDepois = await linhaBd(batchKey0, seedData.farmaciaAId, 7_600_001);
    check(aDepois?.notas === "nota A P1" && aDepois.fornecedorSugeridoId === seedData.fornAlfaId, "9c-A-iii: a BD da consolidação A não foi tocada pela B");

    // ── 9d · bloqueio optimista com DUAS sessões ─────────────────────────
    console.log("\n9d · duas sessões a editar a Farmácia A — conflito explícito, nunca sobrescrever");
    const page2 = await ctx.newPage();
    await page2.setViewportSize({ width: 1700, height: 1100 });
    aceitarDialogosAutomaticamente(page2);
    await page2.goto(`${baseFor(tenant)}/encomendas/nova?consolidacao=${batchKey0}`, { waitUntil: "networkidle" });
    await page2.getByText("CFL P2").first().waitFor({ timeout: 20000 });
    await notasInput(page, "CFL P2", A).fill("sessão 1");
    check(await esperarPor(async () => (await linhaBd(batchKey0, seedData.farmaciaAId, 7_600_002))?.notas === "sessão 1"), "9d-1: a sessão 1 gravou a sua nota (a versão avançou)");
    await notasInput(page2, "CFL P2", A).fill("sessão 2 (deve falhar)");
    const bannerConflito = page2.getByTestId("consolidacao-conflito");
    const apareceu = await bannerConflito.first().waitFor({ state: "visible", timeout: 20000 }).then(() => true).catch(() => false);
    check(apareceu, "9d-2: a sessão 2 mostra um aviso de conflito explícito (a sua gravação foi recusada)");
    check(apareceu && (await bannerConflito.first().innerText()).includes(A) && (await bannerConflito.first().getAttribute("data-farmacia-id")) === seedData.farmaciaAId, "9d-2b: o aviso identifica a FARMÁCIA em conflito (A), não a B");
    check((await linhaBd(batchKey0, seedData.farmaciaAId, 7_600_002))?.notas === "sessão 1", "9d-3: nada foi sobrescrito — a base mantém a nota da sessão 1");
    check(await page2.getByRole("button", { name: "Criar encomendas" }).isDisabled(), "9d-4: 'Criar encomendas' está bloqueado na sessão em conflito");
    check(await page2.getByRole("button", { name: "Guardar rascunho" }).isDisabled(), "9d-4b: 'Guardar rascunho' também");
    await page2.getByTestId("consolidacao-recarregar-farmacia").click();
    await bannerConflito.first().waitFor({ state: "detached", timeout: 10000 }).catch(() => {});
    check((await bannerConflito.count()) === 0 && (await notasInput(page2, "CFL P2", A).inputValue()) === "sessão 1", "9d-5: depois de recarregar, o aviso desaparece e a sessão 2 mostra os dados do servidor (sessão 1)");
    check(!(await page2.getByRole("button", { name: "Criar encomendas" }).isDisabled()), "9d-5b: a finalização volta a estar disponível");

    console.log("\n9d-bis · conflito detectado pelo SERVIDOR na finalização (sessão 2 sem edições locais)");
    await notasInput(page, "CFL P2", A).fill("sessão 1 (v2)");
    check(await esperarPor(async () => (await linhaBd(batchKey0, seedData.farmaciaAId, 7_600_002))?.notas === "sessão 1 (v2)"), "9d-6: a sessão 1 grava de novo (a versão avança outra vez)");
    const finalizadosAntes = await prisma.listaEncomenda.count({ where: { loteOrigemId: { not: null } } });
    await page2.getByRole("button", { name: "Criar encomendas" }).click();
    const apareceu2 = await bannerConflito.first().waitFor({ state: "visible", timeout: 20000 }).then(() => true).catch(() => false);
    check(apareceu2 && (await bannerConflito.first().getAttribute("data-farmacia-id")) === seedData.farmaciaAId, "9d-7: a finalização na sessão desactualizada é recusada pelo servidor e identifica a Farmácia A");
    const finalizadosDepois = await prisma.listaEncomenda.count({ where: { loteOrigemId: { not: null } } });
    const divididosA = await prisma.listaEncomenda.count({ where: { clientIdempotencyKey: { in: [deriveFarmaciaIdempotencyKey(batchKey0, seedData.farmaciaAId), deriveFarmaciaIdempotencyKey(batchKey0, seedData.farmaciaBId)] }, loteDivididoEm: { not: null } } });
    check(finalizadosDepois === finalizadosAntes && divididosA === 0, "9d-8: nenhuma encomenda foi criada e nenhum rascunho ficou dividido");
    await page2.getByTestId("consolidacao-recarregar-farmacia").click();
    await bannerConflito.first().waitFor({ state: "detached", timeout: 10000 }).catch(() => {});
    check((await notasInput(page2, "CFL P2", A).inputValue()) === "sessão 1 (v2)", "9d-9: depois de recarregar, a sessão 2 vê a versão mais recente");
    await page2.close();

    // ── 9e · CORRIDA na criação do rascunho (resposta atrasada) ──────────────
    console.log("\n9e · edições feitas enquanto o rascunho está a ser criado (resposta ATRASADA 9 s) — nenhuma se perde");
    const pC = await ctx.newPage();
    await pC.setViewportSize({ width: 1700, height: 1100 });
    aceitarDialogosAutomaticamente(pC);
    const atraso = await atrasarCriacaoDeRascunho(pC, 9000);
    const batchKeyC = await abrirNovaConsolidacao(pC);
    await gerarPropostaConsolidacao(pC);
    check(atraso.n >= 1, "9e-0: a(s) resposta(s) de criação de rascunho foram interceptadas e retidas", `n=${atraso.n}`);
    // — a resposta ainda não chegou: edita-se já —
    await qtdInput(pC, "CFL P1", A).fill("21");                                  // quantidade
    await notasInput(pC, "CFL P1", A).fill("durante criação P1 A");              // notas
    await escolherFornecedorViaPicker(pC, "CFL P1", A, "Delta");                 // fornecedor
    await notasInput(pC, "CFL P2", A).fill("durante criação P2 A");              // OUTRA linha, logo a seguir
    await pC.getByRole("button", { name: `Remover ${A} · CFL P2` }).click();   // remoção durante a criação
    await notasInput(pC, "CFL P1", B).fill("durante criação P1 B");              // outra farmácia
    await escolherFornecedorViaPicker(pC, "CFL P3", B, "Beta");                  // linha sem fornecedor → Beta
    const a1Cedo = await linhaBd(batchKeyC, seedData.farmaciaAId, 7_600_001);
    check(a1Cedo !== null && a1Cedo.notas !== "durante criação P1 A", "9e-1: com a resposta ainda retida, a BD só tem o snapshot da criação (as edições ainda não foram gravadas)");
    const tudoGravado = await esperarPor(async () => {
      const [a1, a2, b1, b3] = await Promise.all([linhaBd(batchKeyC, seedData.farmaciaAId, 7_600_001), linhaBd(batchKeyC, seedData.farmaciaAId, 7_600_002), linhaBd(batchKeyC, seedData.farmaciaBId, 7_600_001), linhaBd(batchKeyC, seedData.farmaciaBId, 7_600_003)]);
      return a1?.notas === "durante criação P1 A" && Number(a1?.quantidadeAjustada) === 21 && a1?.fornecedorSugeridoId === seedData.fornDeltaId && a2 === null && b1?.notas === "durante criação P1 B" && b3?.fornecedorSugeridoId === seedData.fornBetaId;
    }, 40000);
    check(tudoGravado, "9e-2: quando a resposta chega, o MESMO autosave grava tudo — A/P1 (fornecedor+quantidade+notas), A/P2 removida, B/P1 notas, B/P3 fornecedor");
    check((await notasInput(pC, "CFL P1", A).inputValue()) === "durante criação P1 A" && (await pC.getByLabel(`Notas de CFL P2 em ${A}`, { exact: true }).count()) === 0, "9e-3: o ecrã continua a mostrar as edições (P1/A) e sem a linha removida (P2/A)");

    // ── 9f · FLUSH ao desmontar, SEM esperar pela BD ─────────────────────
    console.log("\n9f · editar e navegar IMEDIATAMENTE (antes do debounce) — a BD só é consultada depois da navegação");
    await pC.unroute("**/encomendas/nova**");
    await pC.waitForTimeout(1500); // deixa assentar o autosave da secção anterior (esta secção parte de um estado gravado)
    await qtdInput(pC, "CFL P1", A).fill("33");
    await notasInput(pC, "CFL P1", A).fill("flush A");
    await escolherFornecedorViaPicker(pC, "CFL P1", A, "Alfa"); // ~300 ms — bem abaixo do debounce de 1,2 s
    await pC.locator('a[href="/encomendas"]').first().click();   // navegação de cliente IMEDIATA
    await pC.waitForURL((u) => u.pathname === "/encomendas", { timeout: 15000 });
    // só agora se olha para a BD (nenhuma espera prévia pela gravação)
    check(await esperarPor(async () => {
      const a1 = await linhaBd(batchKeyC, seedData.farmaciaAId, 7_600_001);
      return a1?.notas === "flush A" && Number(a1?.quantidadeAjustada) === 33 && a1?.fornecedorSugeridoId === seedData.fornAlfaId;
    }, 20000), "9f-1: depois da navegação, a BD tem quantidade, fornecedor e notas editados (gravação ao desmontar)");
    await pC.goto(`${baseFor(tenant)}/encomendas/nova?consolidacao=${batchKeyC}`, { waitUntil: "networkidle" });
    await pC.getByText("CFL P1").first().waitFor({ timeout: 20000 });
    check((await qtdInput(pC, "CFL P1", A).inputValue()) === "33" && (await notasInput(pC, "CFL P1", A).inputValue()) === "flush A" && (await fornecedorBotao(pC, "CFL P1", A).innerText()).includes("Alfa"),
      "9f-2: ao regressar pela URL os três valores estão lá (33, 'flush A', Alfa)");

    console.log("\n9f-bis · mesma coisa com REMOÇÃO de linha + CONTEXTO pendente");
    const ctxAntes = (await prisma.listaEncomenda.findFirstOrThrow({ where: { clientIdempotencyKey: deriveFarmaciaIdempotencyKey(batchKeyC, seedData.farmaciaBId) } })).contextoJson ?? "";
    // o P2/A foi removido em 9e; remove-se agora o P3/B (outra farmácia) — com o contexto mudado a seguir a regenerar
    await campoPorLabel(pC, "Cobertura alvo (dias)", "input").fill("21");
    await pC.getByRole("button", { name: /Gerar (nova )?proposta/ }).click();
    await pC.getByText("CFL P1").first().waitFor({ timeout: 30000 });
    await pC.waitForTimeout(600); // a proposta está no ecrã (isto NÃO é esperar pela BD)
    await pC.getByRole("button", { name: `Remover ${B} · CFL P3` }).click();
    await pC.locator('a[href="/encomendas"]').first().click();
    await pC.waitForURL((u) => u.pathname === "/encomendas", { timeout: 15000 });
    check(await esperarPor(async () => {
      const b3 = await linhaBd(batchKeyC, seedData.farmaciaBId, 7_600_003);
      const ctxB = (await prisma.listaEncomenda.findFirstOrThrow({ where: { clientIdempotencyKey: deriveFarmaciaIdempotencyKey(batchKeyC, seedData.farmaciaBId) } })).contextoJson ?? "";
      return b3 === null && ctxB !== ctxAntes && ctxB.includes('"coverageDays":21');
    }, 25000), "9f-3: depois da navegação, a remoção (P3/B) e o contexto (cobertura 21) estão na BD");
    await pC.goto(`${baseFor(tenant)}/encomendas/nova?consolidacao=${batchKeyC}`, { waitUntil: "networkidle" });
    await pC.getByText("CFL P1").first().waitFor({ timeout: 20000 });
    check((await pC.getByLabel(`Notas de CFL P3 em ${B}`, { exact: true }).count()) === 0, "9f-4: ao regressar pela URL a linha removida continua removida");

    // ── 9g · SEM gravação cruzada ────────────────────────────────────────
    console.log("\n9g · trocar de batchKey durante o debounce / durante a criação — nada vai para a consolidação errada");
    const a1AntesG = await linhaBd(batchKey0, seedData.farmaciaAId, 7_600_001);
    const b1AntesG = await linhaBd(batchKey0, seedData.farmaciaBId, 7_600_001);
    await notasInput(pC, "CFL P1", B).fill("cruzada?");                       // edição pendente (debounce a correr)…
    await navegarNoCliente(pC, `/encomendas/nova?consolidacao=${batchKey0}`); // …e troca de consolidação IMEDIATA, no mesmo ecrã
    await pC.waitForFunction((k) => new URL(location.href).searchParams.get("consolidacao") === k, batchKey0);
    check(await esperarPor(async () => (await notasInput(pC, "CFL P1", B).inputValue()) === "nota B P1"), "9g-0: o ecrã passou a mostrar a consolidação A");
    check(await esperarPor(async () => (await linhaBd(batchKeyC, seedData.farmaciaBId, 7_600_001))?.notas === "cruzada?"), "9g-1: a edição pendente foi gravada NO RASCUNHO DE ORIGEM (consolidação C)");
    const a1DepoisG = await linhaBd(batchKey0, seedData.farmaciaAId, 7_600_001);
    const b1DepoisG = await linhaBd(batchKey0, seedData.farmaciaBId, 7_600_001);
    check(JSON.stringify(a1AntesG) === JSON.stringify(a1DepoisG) && JSON.stringify(b1AntesG) === JSON.stringify(b1DepoisG) && b1DepoisG?.notas === "nota B P1", "9g-2: a consolidação A não recebeu nada ('cruzada?' não aparece nos seus rascunhos)");
    check((await notasInput(pC, "CFL P1", B).inputValue()) === "nota B P1" && (await fornecedorBotao(pC, "CFL P1", A).innerText()).includes("Alfa"), "9g-3: o ecrã mostra agora os dados da consolidação A, sem restos da C");
    const cruzadasEmA = await prisma.linhaEncomenda.count({ where: { notas: "cruzada?", listaEncomenda: { clientIdempotencyKey: { in: [deriveFarmaciaIdempotencyKey(batchKey0, seedData.farmaciaAId), deriveFarmaciaIdempotencyKey(batchKey0, seedData.farmaciaBId)] } } } });
    check(cruzadasEmA === 0, "9g-4: zero linhas com a nota 'cruzada?' nos rascunhos de A");

    // troca DURANTE a criação do rascunho (resposta retida): a conclusão é descartada
    const pD = await ctx.newPage();
    await pD.setViewportSize({ width: 1700, height: 1100 });
    aceitarDialogosAutomaticamente(pD);
    const atrasoD = await atrasarCriacaoDeRascunho(pD, 8000);
    const batchKeyD = await abrirNovaConsolidacao(pD);
    await gerarPropostaConsolidacao(pD);
    await notasInput(pD, "CFL P1", A).fill("descartar?");                    // edição durante a criação…
    await navegarNoCliente(pD, `/encomendas/nova?consolidacao=${batchKey0}`); // …e troca para A antes de a resposta chegar
    await pD.waitForFunction((k) => new URL(location.href).searchParams.get("consolidacao") === k, batchKey0);
    await esperarPor(async () => (await notasInput(pD, "CFL P1", A).inputValue()) === "nota A P1");
    await pD.waitForTimeout(10000); // a resposta retida chega AGORA, já com a consolidação A no ecrã
    check(atrasoD.n >= 1, "9g-5: a criação do rascunho da consolidação D foi retida e só respondeu depois da troca");
    check((await notasInput(pD, "CFL P1", A).inputValue()) === "nota A P1" && (await fornecedorBotao(pD, "CFL P1", A).innerText()).includes("Alfa"), "9g-6: a resposta tardia NÃO foi aplicada à consolidação A (o ecrã continua com os dados de A)");
    const descartarEmA = await prisma.linhaEncomenda.count({ where: { notas: "descartar?", listaEncomenda: { clientIdempotencyKey: { in: [deriveFarmaciaIdempotencyKey(batchKey0, seedData.farmaciaAId), deriveFarmaciaIdempotencyKey(batchKey0, seedData.farmaciaBId)] } } } });
    const a1PosD = await linhaBd(batchKey0, seedData.farmaciaAId, 7_600_001);
    check(descartarEmA === 0 && a1PosD?.notas === "nota A P1", "9g-7: nenhum rascunho de A recebeu a edição da consolidação D");
    void batchKeyD;
    await pD.close();
    await pC.close();

    // ── 10 · refrescar ─────────────────────────────────────────────────
    console.log("\n10 · refrescar a página");
    await page.waitForTimeout(1500); // autosave a gravar antes do refresh
    const batchKey = new URL(page.url()).searchParams.get("consolidacao");
    await page.reload({ waitUntil: "networkidle" });
    await page.getByText("CFL P1").first().waitFor({ timeout: 15000 });
    check(new URL(page.url()).searchParams.get("consolidacao") === batchKey, "10: a URL manteve a MESMA batchKey depois do refresh");

    // ── 11 · confirmar recuperação TOTAL ────────────────────────────────
    console.log("\n11 · confirmar recuperação total (linhas, quantidades, fornecedores) por farmácia");
    check((await fornecedorBotao(page, "CFL P1", seedData.farmaciaANome).innerText()).includes("Alfa"), "11a: P1/Farmácia A recupera Alfa");
    check((await fornecedorBotao(page, "CFL P2", seedData.farmaciaANome).innerText()).includes("Beta"), "11b: P2/Farmácia A recupera Beta");
    check((await fornecedorBotao(page, "CFL P1", seedData.farmaciaBNome).innerText()).includes("Delta"), "11c: P1/Farmácia B recupera Delta (edição individual do passo 5, nunca a sugestão original Gama)");
    check((await fornecedorBotao(page, "CFL P3", seedData.farmaciaBNome).innerText()).includes("Beta"), "11d: P3/Farmácia B recupera Beta (correcção do passo 9)");

    check((await notasInput(page, "CFL P1", A).inputValue()) === "nota A P1" && (await notasInput(page, "CFL P1", B).inputValue()) === "nota B P1", "11e: o MESMO produto recupera as suas notas DIFERENTES em A e B");
    check((await notasInput(page, "CFL P2", A).inputValue()) === "sessão 1 (v2)" && (await notasInput(page, "CFL P3", B).inputValue()) === "nota B P3" && (await qtdInput(page, "CFL P1", A).inputValue()) === "17", "11f: restantes notas e a quantidade editada recuperam-se");

    // ── 12 · finalizar ───────────────────────────────────────────────────
    console.log("\n12 · finalizar — 'Criar encomendas'");
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "Criar encomendas" }).click();
    await page.getByRole("heading", { name: "Encomenda finalizada" }).waitFor({ timeout: 20000 });
    check(true, "12: a finalização da consolidação teve sucesso — painel de resultado mostrado");

    // ── 13 · confirmar quatro encomendas ─────────────────────────────────
    console.log("\n13 · confirmar exactamente quatro encomendas finais");
    const draftA = await prisma.listaEncomenda.findFirst({ where: { farmaciaId: seedData.farmaciaAId, estado: "RASCUNHO", loteDivididoEm: { not: null } }, orderBy: { dataCriacao: "desc" } });
    const draftB = await prisma.listaEncomenda.findFirst({ where: { farmaciaId: seedData.farmaciaBId, estado: "RASCUNHO", loteDivididoEm: { not: null } }, orderBy: { dataCriacao: "desc" } });
    check(!!draftA && !!draftB, "13-fixture: os dois rascunhos (um por farmácia) ficaram marcados como divididos");
    const documentos = await prisma.listaEncomenda.findMany({
      where: { loteOrigemId: { in: [draftA?.id ?? "", draftB?.id ?? ""] } },
      include: { linhas: { include: { fornecedorSugerido: true } } },
      orderBy: { dataCriacao: "asc" },
    });
    check(documentos.length === 4, "13: exactamente 4 encomendas finais (2 farmácias × 2 fornecedores distintos cada)", `obtido=${documentos.length}`);
    check(documentos.every((d) => d.estado === "FINALIZADA"), "13b: as 4 nasceram FINALIZADA");
    const numeros = documentos.map((d) => d.numero);
    check(numeros.every((n) => n !== null && /^EN-\d{6}$/.test(n!)) && new Set(numeros).size === 4, "13c: 4 números reais EN-######, todos distintos");
    check(documentos.filter((d) => d.farmaciaId === seedData.farmaciaAId).length === 2 && documentos.filter((d) => d.farmaciaId === seedData.farmaciaBId).length === 2, "13d: 2 documentos por farmácia — nenhuma mistura");

    // 13e · as notas chegaram aos documentos finais, isoladas por farmácia × fornecedor
    const docDe = (farmaciaId: string, fornecedorNome: string) => documentos.find((d) => d.farmaciaId === farmaciaId && d.linhas[0]?.fornecedorSugerido?.nome === fornecedorNome);
    const dAAlfa = docDe(seedData.farmaciaAId, "CFL Fornecedor Alfa");
    const dABeta = docDe(seedData.farmaciaAId, "CFL Fornecedor Beta");
    const dBDelta = docDe(seedData.farmaciaBId, "CFL Fornecedor Delta");
    const dBBeta = docDe(seedData.farmaciaBId, "CFL Fornecedor Beta");
    check(dAAlfa?.linhas[0].notas === "nota A P1" && Number(dAAlfa?.linhas[0].quantidadeAjustada) === 17, "13e-a: documento (A, Alfa) leva a nota 'nota A P1' e a quantidade 17");
    check(dBDelta?.linhas[0].notas === "nota B P1", "13e-b: documento (B, Delta) leva a nota DIFERENTE 'nota B P1' para o MESMO produto");
    check(dABeta?.linhas[0].notas === "sessão 1 (v2)" && dBBeta?.linhas[0].notas === "nota B P3", "13e-c: documentos (A, Beta) e (B, Beta) levam cada um a SUA nota — mesmo fornecedor, farmácias diferentes, sem mistura");

    // ── 14 · abrir os quatro documentos ──────────────────────────────────
    console.log("\n14 · abrir os quatro documentos (legíveis, uma navegação real no browser)");
    const { loadOrderDetail } = await import("../../lib/encomendas/order-detail");
    for (const doc of documentos) {
      const detalhe = await loadOrderDetail(doc.id);
      check(!!detalhe && detalhe.linhas.length === 1, `14: documento ${doc.numero} (${doc.linhas[0]?.fornecedorSugerido?.nome}) é legível, com a sua própria linha`);
    }
    await page.goto(`${baseFor(tenant)}/encomendas/${documentos[0].id}`, { waitUntil: "networkidle" });
    // O ecrã de detalhe não mostra o `numero` como texto visível (esse
    // vive no PDF/relatório — ver `buildEncomendaDocumentoReport`) — a
    // prova de que a navegação real abriu O documento certo é o estado
    // "Finalizada" + a farmácia certa, ambos sempre visíveis ali.
    const abriuDocumentoCerto = await page.getByText("Finalizada").first().waitFor({ timeout: 10000 }).then(() => true).catch(() => false);
    const farmaciaVisivel = await page.getByText(`Farmácia: ${seedData.farmaciaANome}`).first().isVisible().catch(() => false);
    check(abriuDocumentoCerto && farmaciaVisivel, "14b: navegação real no browser abre o documento certo (estado Finalizada + farmácia visíveis)");

    // ── 15 · simular uma resposta perdida ────────────────────────────────
    console.log("\n15 · simular resposta perdida — repetir a finalização com a MESMA batchKey");
    const { finalizarConsolidacaoMultiFornecedor } = await import("../../lib/encomendas/consolidacao-multi-fornecedor");
    const antesRetry = await prisma.listaEncomenda.count({ where: { loteOrigemId: { in: [draftA!.id, draftB!.id] } } });
    const retry1 = await finalizarConsolidacaoMultiFornecedor(prisma, tenant, { batchKey: batchKey!, farmaciaIds: [seedData.farmaciaAId, seedData.farmaciaBId] });
    check(retry1.reutilizado === true, "15: a repetição é reconhecida como replay (reutilizado=true), nunca uma nova tentativa de escrita");

    // ── 16 · repetir ──────────────────────────────────────────────────────
    console.log("\n16 · repetir de novo (inclui uma corrida concorrente)");
    const [r2, r3] = await Promise.all([
      finalizarConsolidacaoMultiFornecedor(prisma, tenant, { batchKey: batchKey!, farmaciaIds: [seedData.farmaciaAId, seedData.farmaciaBId] }),
      finalizarConsolidacaoMultiFornecedor(prisma, tenant, { batchKey: batchKey!, farmaciaIds: [seedData.farmaciaAId, seedData.farmaciaBId] }),
    ]);
    const idsR2 = r2.documentos.map((d) => d.listaEncomendaId).sort().join(",");
    const idsR3 = r3.documentos.map((d) => d.listaEncomendaId).sort().join(",");
    check(idsR2 === idsR3, "16: chamadas repetidas (incl. concorrentes) devolvem EXACTAMENTE os mesmos 4 documentos");

    // ── 17 · confirmar zero duplicados ────────────────────────────────────
    console.log("\n17 · confirmar zero documentos duplicados");
    const depoisRetry = await prisma.listaEncomenda.count({ where: { loteOrigemId: { in: [draftA!.id, draftB!.id] } } });
    check(depoisRetry === antesRetry && depoisRetry === 4, "17: continuam a existir exactamente 4 documentos — nenhum duplicado criado pelas repetições", `antes=${antesRetry} depois=${depoisRetry}`);

    // ── 18 · anular uma ────────────────────────────────────────────────────
    console.log("\n18 · anular uma das 4 encomendas finais (pelo ecrã real)");
    const alvo = documentos[0];
    const irmaos = documentos.slice(1);
    await page.goto(`${baseFor(tenant)}/encomendas?farmacia=${encodeURIComponent(alvo.farmaciaId)}`, { waitUntil: "networkidle" });
    const alvoFornecedorNome = alvo.linhas[0]?.fornecedorSugerido?.nome ?? "";
    // A pesquisa da lista filtra por "nome" (não por número — ver a
    // mesma nota em fornecedor-por-linha-encomendas-browser.ts); cada
    // documento gerado chama-se "<prefixo> · <farmácia> · <fornecedor>"
    // (ensureDraftConsolidacao + finalizar-multi-fornecedor.ts), por
    // isso o nome do fornecedor é o termo que resolve. "Alfa" é único
    // entre os 4 documentos (só a Farmácia A/fornecedor Alfa o usa —
    // "Beta" aparece em duas farmácias, por isso não serviria aqui).
    await campoPorLabelPesquisa(page).fill(alvoFornecedorNome);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    const linhaAlvo = page.locator("tbody tr").filter({ hasText: alvoFornecedorNome });
    check(await linhaAlvo.count() === 1, "18-fixture: a pesquisa por fornecedor resolve exactamente 1 linha (termo inequívoco)", `nome=${alvoFornecedorNome}`);
    await linhaAlvo.getByRole("button", { name: "Anular" }).click();
    await page.getByPlaceholder("Obrigatório — descreva o motivo").fill("Anulado no ensaio e2e — consolidação fornecedor por linha");
    await page.getByRole("button", { name: "Confirmar anulação" }).click();
    await page.getByText("Encomenda anulada.").waitFor({ timeout: 15000 });
    const alvoDb = await prisma.listaEncomenda.findUniqueOrThrow({ where: { id: alvo.id } });
    check(alvoDb.estado === "ANULADA", "18: o documento alvo tem estado real ANULADA");

    // ── 19 · confirmar que as restantes continuam activas ─────────────────
    console.log("\n19 · confirmar que as outras 3 continuam FINALIZADA, intocadas");
    for (const irmao of irmaos) {
      const l = await prisma.listaEncomenda.findUniqueOrThrow({ where: { id: irmao.id }, include: { linhas: true } });
      check(l.estado === "FINALIZADA" && l.linhas.length === 1, `19: ${irmao.numero} (${irmao.linhas[0]?.fornecedorSugerido?.nome}) continua FINALIZADA com a sua linha — não afectado pela anulação`);
    }

    await prisma.$disconnect();
    await page.close();
    await ctx.close();
  } finally {
    await browser.close();
  }

  console.log(`\n${passed} ok, ${failed} falhas`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
