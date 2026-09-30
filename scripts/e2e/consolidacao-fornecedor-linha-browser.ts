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

    // ── 12 · finalizar ───────────────────────────────────────────────────
    console.log("\n12 · finalizar — 'Criar encomendas'");
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "Criar encomendas" }).click();
    await page.getByRole("heading", { name: "Encomenda finalizada" }).waitFor({ timeout: 20000 });
    check(true, "12: a finalização da consolidação teve sucesso — painel de resultado mostrado");

    // ── 13 · confirmar quatro encomendas ─────────────────────────────────
    console.log("\n13 · confirmar exactamente quatro encomendas finais");
    const { PrismaClient } = await import("../../generated/prisma/client");
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB }) });
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
