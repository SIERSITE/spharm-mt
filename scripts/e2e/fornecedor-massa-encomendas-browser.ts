/**
 * scripts/e2e/fornecedor-massa-encomendas-browser.ts
 *
 * Ensaio de browser real (Chromium via Playwright) contra `next start` local +
 * PostgreSQL descartável: SELECÇÃO e ATRIBUIÇÃO COLECTIVA de fornecedor nas
 * encomendas, nos três modos (farmácia, consolidação) e em dois tenants
 * (silveira e garantia — a funcionalidade NÃO tem gate de tenant).
 *
 *   createdb … ; prisma migrate deploy ; next build ; _start-server.sh  (ver os restantes ensaios)
 *   E2E_DATABASE_URL=postgresql://postgres:test@localhost:55494/spharm_e2e_fm npx tsx scripts/e2e/fornecedor-massa-encomendas-browser.ts
 *
 * Dados: 2 farmácias (Silveirense, Segurado) × 60 produtos com vendas. O
 * fornecedor HABITUAL é por produto E por farmácia:
 *   Silveirense: P01-P20 → Alfa   · Segurado: P01-P10 → Beta   · resto: sem habitual.
 *
 * A atribuição colectiva usa o mesmo autosave (rascunho real) — verifica-se na BD
 * `LinhaEncomenda.fornecedorSugeridoId`, e que `ProdutoFarmacia` NUNCA é alterado.
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { SignJWT } from "jose";
import Module from "node:module";

const DB = process.env.E2E_DATABASE_URL ?? "postgresql://postgres:test@localhost:55494/spharm_e2e_fm";
const PORT = process.env.E2E_PORT ?? "3100";
const SECRET = process.env.E2E_AUTH_SECRET ?? "e2e-test-secret-e2e-test-secret-0123456789";
{
  const h = new URL(DB).hostname;
  if (h !== "localhost" && h !== "127.0.0.1") { console.error(`RECUSADO: ${h} não é local.`); process.exit(2); }
}
const baseFor = (slug: string) => `http://${slug}.localhost:${PORT}`;
process.env.DATABASE_URL = DB;

const MM = Module as unknown as { _resolveFilename: (r: string, ...a: unknown[]) => string };
const resolverOriginal = MM._resolveFilename;
MM._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "server-only" ? __filename : resolverOriginal.call(this, request, ...rest);
};

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string, detalhe?: string) {
  if (cond) { passed++; console.log(`  [OK]    ${msg}`); }
  else { failed++; console.log(`  [FALHA] ${msg}${detalhe ? `\n            ${detalhe}` : ""}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function esperarPor(cond: () => Promise<boolean>, ms = 25000): Promise<boolean> {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    if (await cond().catch(() => false)) return true;
    await sleep(250);
  }
  return false;
}

const N = 60;
const cnpDe = (i: number) => 7_400_000 + i;
const nomeP = (i: number) => `FM P${String(i).padStart(2, "0")}`;
function campoPorLabel(page: Page, label: string, tag: "input" | "select") {
  return page.locator(`xpath=//label[normalize-space(text())="${label}"]/following-sibling::${tag}`);
}
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

type Seed = { adminId: string; fA: string; fB: string; nomeA: string; nomeB: string; forn: Record<"X" | "Y" | "Z" | "W", { id: string; nome: string }>; produtoIds: string[] };

async function prismaE2E() {
  const { PrismaClient } = await import("../../generated/prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: DB }) });
}

async function seed(): Promise<Seed> {
  const prisma = await prismaE2E();
  try {
    const admin = await prisma.utilizador.upsert({ where: { email: "e2e-fm-admin@spharm.test" }, update: {}, create: { email: "e2e-fm-admin@spharm.test", nome: "E2E FM Admin", perfil: "ADMINISTRADOR" } });
    const nomeA = "FM E2E Silveirense";
    const nomeB = "FM E2E Segurado";
    const fA = await prisma.farmacia.upsert({ where: { nome: nomeA }, update: {}, create: { nome: nomeA } });
    const fB = await prisma.farmacia.upsert({ where: { nome: nomeB }, update: {}, create: { nome: nomeB } });
    const mk = async (k: string, nome: string) => prisma.fornecedor.upsert({ where: { nomeNormalizado: `FM E2E ${k}` }, update: {}, create: { nomeNormalizado: `FM E2E ${k}`, nome } });
    const X = await mk("ALFA", "FM Fornecedor Alfa");
    const Y = await mk("BETA", "FM Fornecedor Beta");
    const Z = await mk("GAMA", "FM Fornecedor Gama");
    const W = await mk("DELTA", "FM Fornecedor Delta");
    const produtoIds: string[] = [];
    const agora = new Date();
    for (let i = 1; i <= N; i++) {
      const p = await prisma.produto.upsert({ where: { cnp: cnpDe(i) }, update: { designacao: nomeP(i) }, create: { cnp: cnpDe(i), designacao: nomeP(i), estado: "VALIDADO" } });
      produtoIds.push(p.id);
      for (const [f, hab] of [[fA.id, i <= 20 ? X.id : null], [fB.id, i <= 10 ? Y.id : null]] as const) {
        await prisma.produtoFarmacia.upsert({
          where: { produtoId_farmaciaId: { produtoId: p.id, farmaciaId: f } },
          update: { fornecedorHabitualId: hab, stockAtual: 2, stockMinimo: 5, stockMaximo: 40, pvp: 10, pmc: 9, puc: 5 },
          create: { produtoId: p.id, farmaciaId: f, fornecedorHabitualId: hab, stockAtual: 2, stockMinimo: 5, stockMaximo: 40, pvp: 10, pmc: 9, puc: 5, taxaIvaPercent: 23 },
        });
        for (let m = 1; m <= 3; m++) {
          const d = new Date(agora.getFullYear(), agora.getMonth() - m, 1);
          await prisma.vendaMensal.upsert({
            where: { farmaciaId_produtoId_ano_mes_naturezaVenda: { farmaciaId: f, produtoId: p.id, ano: d.getFullYear(), mes: d.getMonth() + 1, naturezaVenda: "NORMAL" } },
            update: { quantidade: 30 },
            create: { farmaciaId: f, produtoId: p.id, ano: d.getFullYear(), mes: d.getMonth() + 1, quantidade: 30, valorTotal: 300, naturezaVenda: "NORMAL" },
          });
        }
      }
    }
    return { adminId: admin.id, fA: fA.id, fB: fB.id, nomeA, nomeB, forn: { X: { id: X.id, nome: X.nome! }, Y: { id: Y.id, nome: Y.nome! }, Z: { id: Z.id, nome: Z.nome! }, W: { id: W.id, nome: W.nome! } }, produtoIds };
  } finally {
    await prisma.$disconnect();
  }
}

async function contexto(browser: Browser, tenant: string, sub: string): Promise<BrowserContext> {
  const token = await new SignJWT({ sub, email: "e2e-fm-admin@spharm.test", nome: "E2E FM Admin", perfil: "ADMINISTRADOR", farmaciaId: null, tenant })
    .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("8h").sign(new TextEncoder().encode(SECRET));
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: "session", value: token, url: baseFor(tenant) }]);
  return ctx;
}
function aceitarDialogos(p: Page) { p.on("dialog", (d) => { d.accept().catch(() => {}); }); }

async function escolherFornecedorNaBarra(page: Page, nome: string) {
  await page.getByRole("button", { name: "Fornecedor a atribuir" }).click();
  const combo = page.getByRole("combobox", { name: "Fornecedor a atribuir" });
  await combo.waitFor({ state: "visible" });
  await combo.fill(nome);
  await page.getByRole("listbox").first().getByRole("option").first().click();
  await page.waitForTimeout(250);
}
const tid = (p: string, s: string) => `${p}-${s}`;
async function contagem(page: Page, p: string): Promise<string> { return (await page.getByTestId(tid(p, "contagem")).innerText()).trim(); }

/** Atribui o fornecedor `nome` às linhas já seleccionadas, passando pelo resumo obrigatório. */
async function atribuir(page: Page, p: string, nome: string, botao = "atribuir"): Promise<string> {
  await escolherFornecedorNaBarra(page, nome);
  await page.getByTestId(tid(p, botao)).click();
  await page.getByTestId(tid(p, "resumo")).waitFor({ timeout: 10000 });
  const r = await page.getByTestId(tid(p, "resumo")).innerText();
  await page.getByTestId(tid(p, "confirmar")).click();
  await page.getByTestId(tid(p, "mensagem")).waitFor({ timeout: 10000 });
  return r.replace(/\s+/g, " ");
}

async function gerarFarmacia(page: Page, tenant: string, farmaciaId: string) {
  await page.goto(`${baseFor(tenant)}/encomendas/nova`, { waitUntil: "networkidle" });
  await campoPorLabel(page, "Farmácia", "select").selectOption(farmaciaId);
  const hoje = new Date();
  await campoPorLabel(page, "Data início", "input").fill(iso(new Date(hoje.getFullYear(), hoje.getMonth() - 6, 1)));
  await campoPorLabel(page, "Data fim", "input").fill(iso(hoje));
  await page.getByRole("button", { name: /Gerar (nova )?proposta/ }).click();
  await page.getByText(nomeP(1)).first().waitFor({ timeout: 30000 });
}

async function rascunhoDaFarmacia(farmaciaId: string, depoisDe: Date) {
  const prisma = await prismaE2E();
  try {
    return await prisma.listaEncomenda.findFirst({ where: { farmaciaId, estado: "RASCUNHO", dataCriacao: { gte: depoisDe }, loteDivididoEm: null }, orderBy: { dataCriacao: "desc" }, select: { id: true } });
  } finally {
    await prisma.$disconnect();
  }
}
async function contarPorFornecedor(listaId: string): Promise<Record<string, number>> {
  const prisma = await prismaE2E();
  try {
    const linhas = await prisma.linhaEncomenda.findMany({ where: { listaEncomendaId: listaId }, select: { fornecedorSugeridoId: true } });
    const out: Record<string, number> = {};
    for (const l of linhas) out[l.fornecedorSugeridoId ?? "_nenhum"] = (out[l.fornecedorSugeridoId ?? "_nenhum"] ?? 0) + 1;
    return out;
  } finally {
    await prisma.$disconnect();
  }
}
async function snapshotHabituais(): Promise<string> {
  const prisma = await prismaE2E();
  try {
    return JSON.stringify(await prisma.produtoFarmacia.findMany({ orderBy: [{ produtoId: "asc" }, { farmaciaId: "asc" }], select: { produtoId: true, farmaciaId: true, fornecedorHabitualId: true } }));
  } finally {
    await prisma.$disconnect();
  }
}

// ═══ Parte A · modo farmácia, tenant silveira ═══════════════════════════════
async function parteA(browser: Browser, s: Seed): Promise<{ listaId: string; page: Page; ctx: BrowserContext }> {
  console.log("\nA · farmácia (silveira) — a proposta preenche o habitual; selecções de 20/30/página/filtradas/sem fornecedor/toda; limpar");
  const habitaisAntes = await snapshotHabituais();
  const inicio = new Date(Date.now() - 1000);
  const ctx = await contexto(browser, "silveira", s.adminId);
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1700, height: 1200 });
  aceitarDialogos(page);
  await gerarFarmacia(page, "silveira", s.fA);
  // Ordem determinística: por designação (P01…P60) — as selecções «primeiras N» e «página» seguem a ordem do ecrã.
  await page.locator("th", { hasText: /^Produto/ }).first().click();
  await page.waitForTimeout(300);
  if (!(await page.locator("tbody tr").first().innerText()).includes(nomeP(1))) {
    await page.locator("th", { hasText: /^Produto/ }).first().click();
    await page.waitForTimeout(300);
  }
  check((await page.locator("tbody tr").first().innerText()).includes(nomeP(1)), "A0: tabela ordenada por designação (a primeira linha é P01)");

  const textoForn = await page.locator("div", { hasText: /Fornecedores:/ }).last().innerText();
  check(/40 sem fornecedor/.test(textoForn), "A1: a proposta da Silveirense traz 20 linhas com o habitual (Alfa) e 40 «sem fornecedor» — o habitual é por produto E por farmácia", textoForn.slice(0, 200));
  check((await contagem(page, "bulk")).startsWith("0 linhas") || /0 linha/.test(await contagem(page, "bulk")), "A2: a barra mostra permanentemente a contagem (0 seleccionadas de 60)");

  // 1ª edição → cria o rascunho real
  await page.getByTestId("bulk-primeiras-20").click();
  check(/20 linhas seleccionadas de 60/.test(await contagem(page, "bulk")), "A3: «Primeiras 20» → 20 linhas seleccionadas de 60");
  const r1 = await atribuir(page, "bulk", s.forn.Z.nome);
  check(/Linhas: 20/.test(r1) && /produtos distintos: 20/.test(r1) && r1.includes(s.nomeA) && /Serão efectivamente alteradas: 20/.test(r1), "A4: o resumo mostra 20 linhas, 20 produtos distintos, a farmácia, o fornecedor e quantas mudam", r1);
  const lista = await esperarPor(async () => !!(await rascunhoDaFarmacia(s.fA, inicio)));
  check(lista, "A5: existe um rascunho REAL da Silveirense");
  const listaId = (await rascunhoDaFarmacia(s.fA, inicio))!.id;
  check(await esperarPor(async () => (await contarPorFornecedor(listaId))[s.forn.Z.id] === 20), "A6: na BD, as 20 primeiras linhas ficaram com o fornecedor Gama (mesmo autosave)");

  await page.getByTestId("bulk-primeiras-30").click();
  const r2 = await atribuir(page, "bulk", s.forn.W.nome);
  check(/Linhas: 30/.test(r2) && /Sem fornecedor hoje: 10/.test(r2) && /Serão efectivamente alteradas: 30/.test(r2), "A7: «Primeiras 30» → resumo 30 linhas, 10 sem fornecedor, 30 a alterar", r2);
  check(await esperarPor(async () => { const c = await contarPorFornecedor(listaId); return c[s.forn.W.id] === 30 && !c[s.forn.Z.id]; }), "A8: na BD, as 30 primeiras passaram a Delta (as 20 de Gama foram substituídas)");

  // página
  await page.getByLabel("Linhas por página").selectOption("20");
  await page.waitForTimeout(400);
  check(/Página 1 de 3/.test(await page.getByTestId("pagina-actual").innerText()), "A9: 60 linhas / 20 por página = 3 páginas");
  await page.getByRole("button", { name: "Página seguinte" }).click();
  await page.waitForTimeout(300);
  await page.getByTestId("bulk-pagina").click();
  check(/20 linhas seleccionadas de 60/.test(await contagem(page, "bulk")), "A10: «Página» selecciona as 20 linhas da página 2");
  await atribuir(page, "bulk", s.forn.Z.nome);
  check(await esperarPor(async () => { const c = await contarPorFornecedor(listaId); return c[s.forn.Z.id] === 20 && c[s.forn.W.id] === 20; }), "A11: página 2 (linhas 21-40) → Gama; as linhas 1-20 mantêm Delta");
  await page.getByTestId("bulk-pagina").click();
  check(/0 linhas seleccionadas de 60/.test(await contagem(page, "bulk")), "A12: «Página» alterna: volta a desseleccionar a página");
  await page.getByLabel("Linhas por página").selectOption("50");

  // filtradas + só sem fornecedor
  await page.getByLabel(/Só sem fornecedor/).check();
  await page.waitForTimeout(400);
  await page.getByTestId("bulk-filtradas").click();
  check(/20 linhas seleccionadas de 60/.test(await contagem(page, "bulk")), "A13: «Todas as filtradas» com «Só sem fornecedor» = as 20 sem fornecedor");
  const r3 = await atribuir(page, "bulk", s.forn.Y.nome);
  check(/Sem fornecedor hoje: 20/.test(r3) && /Já têm o fornecedor escolhido: 0/.test(r3), "A14: o resumo diz que as 20 estão sem fornecedor e nenhuma tem já o escolhido", r3);
  check(await esperarPor(async () => (await contarPorFornecedor(listaId))[s.forn.Y.id] === 20), "A15: na BD, as 20 sem fornecedor ficaram com Beta");
  await page.getByLabel(/Só sem fornecedor/).uncheck();
  await page.waitForTimeout(300);

  // toda a encomenda
  await escolherFornecedorNaBarra(page, s.forn.X.nome);
  await page.getByTestId("bulk-atribuir-toda").click();
  const rt = (await page.getByTestId("bulk-resumo").innerText()).replace(/\s+/g, " ");
  check(/Linhas: 60/.test(rt) && /Serão efectivamente alteradas: 60/.test(rt), "A16: «Atribuir a toda a encomenda» → resumo de 60 linhas", rt);
  await page.getByTestId("bulk-confirmar").click();
  check(await esperarPor(async () => (await contarPorFornecedor(listaId))[s.forn.X.id] === 60), "A17: na BD, TODAS as 60 linhas ficaram com Alfa");

  // limpar fornecedor das 20 primeiras (com confirmação explícita)
  await page.getByTestId("bulk-primeiras-20").click();
  await page.getByTestId("bulk-limpar-fornecedor").click();
  const rl = (await page.getByTestId("bulk-resumo").innerText()).replace(/\s+/g, " ");
  check(/Limpar o fornecedor destas linhas/.test(rl) && /Serão efectivamente alteradas: 20/.test(rl), "A18: «Limpar fornecedor» pede confirmação com resumo (20 linhas)", rl);
  check(await contarPorFornecedor(listaId).then((c) => c[s.forn.X.id] === 60), "A19: antes de confirmar nada mudou");
  await page.getByTestId("bulk-confirmar").click();
  check(await esperarPor(async () => { const c = await contarPorFornecedor(listaId); return c._nenhum === 20 && c[s.forn.X.id] === 40; }), "A20: depois de confirmar, as 20 ficaram sem fornecedor");

  // duas atribuições rápidas seguidas
  await page.getByTestId("bulk-primeiras-20").click();
  await atribuir(page, "bulk", s.forn.Y.nome);
  await page.getByTestId("bulk-primeiras-30").click();
  await atribuir(page, "bulk", s.forn.W.nome);
  check(await esperarPor(async () => { const c = await contarPorFornecedor(listaId); return c[s.forn.W.id] === 30 && c[s.forn.X.id] === 30 && !c[s.forn.Y.id] && !c._nenhum; }), "A21: duas atribuições rápidas seguidas — a última vence nas 30 primeiras; as restantes 30 ficam Alfa");

  // refresh e navegação
  await page.waitForTimeout(1800);
  await page.goto(`${baseFor("silveira")}/encomendas/nova?rascunho=${listaId}`, { waitUntil: "networkidle" });
  await page.getByText(nomeP(1)).first().waitFor({ timeout: 30000 });
  const textoApos = await page.locator("div", { hasText: /Fornecedores:/ }).last().innerText();
  check(/2 fornecedores distintos/.test(textoApos) && !/sem fornecedor/.test(textoApos), "A22: depois de refresh o rascunho mostra a atribuição (2 fornecedores, nenhuma linha sem fornecedor)", textoApos.slice(0, 200));
  await page.goto(`${baseFor("silveira")}/encomendas`, { waitUntil: "networkidle" });
  await page.goto(`${baseFor("silveira")}/encomendas/nova?rascunho=${listaId}`, { waitUntil: "networkidle" });
  await page.getByText(nomeP(1)).first().waitFor({ timeout: 30000 });
  check(/2 fornecedores distintos/.test(await page.locator("div", { hasText: /Fornecedores:/ }).last().innerText()), "A23: navegar para outra página e regressar mantém a atribuição");

  check((await snapshotHabituais()) === habitaisAntes, "A24: o fornecedor HABITUAL (ProdutoFarmacia) NUNCA foi alterado por nenhuma atribuição na encomenda");
  return { listaId, page, ctx };
}

// ═══ Parte B · prevalência do rascunho sobre o habitual ═════════════════════
async function parteB(page: Page, s: Seed, listaId: string) {
  console.log("\nB · o rascunho já alterado prevalece sobre o habitual; a ausência de habitual continua explícita");
  const prisma = await prismaE2E();
  try {
    const l1 = await prisma.linhaEncomenda.findFirst({ where: { listaEncomendaId: listaId, produto: { cnp: cnpDe(1) } } });
    check(l1?.fornecedorSugeridoId === s.forn.W.id, "B1: P01 tem Delta no rascunho (≠ habitual Alfa) — ao reabrir o rascunho a escolha prevalece");
    const habP1 = await prisma.produtoFarmacia.findFirst({ where: { farmaciaId: s.fA, produto: { cnp: cnpDe(1) } } });
    check(habP1?.fornecedorHabitualId === s.forn.X.id, "B2: …e o habitual de P01 na Silveirense continua Alfa");
  } finally {
    await prisma.$disconnect();
  }
  void page;
}

// ═══ Parte C · segundo tenant (garantia) ═════════════════════════════════════
async function parteC(browser: Browser, s: Seed) {
  console.log("\nC · tenant garantia (sem qualquer gate): proposta com habitual do Segurado + atribuição colectiva");
  const inicio = new Date(Date.now() - 1000);
  const ctx = await contexto(browser, "garantia", s.adminId);
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1700, height: 1200 });
  aceitarDialogos(page);
  await gerarFarmacia(page, "garantia", s.fB);
  const t = await page.locator("div", { hasText: /Fornecedores:/ }).last().innerText();
  check(/50 sem fornecedor/.test(t), "C1: no Segurado só P01-P10 têm habitual (Beta) → 50 sem fornecedor (diferente da Silveirense)", t.slice(0, 160));
  await page.getByTestId("bulk-sem-fornecedor").click();
  check(/50 linhas seleccionadas de 60/.test(await contagem(page, "bulk")), "C2: «Só sem fornecedor» selecciona as 50");
  await atribuir(page, "bulk", s.forn.Z.nome);
  const lista = await esperarPor(async () => !!(await rascunhoDaFarmacia(s.fB, inicio)));
  check(lista, "C3: existe o rascunho do Segurado (tenant garantia)");
  const id = (await rascunhoDaFarmacia(s.fB, inicio))!.id;
  check(await esperarPor(async () => { const c = await contarPorFornecedor(id); return c[s.forn.Z.id] === 50 && c[s.forn.Y.id] === 10; }), "C4: na BD, 50 linhas → Gama e as 10 com habitual continuam Beta");
  await ctx.close();
}

// ═══ Parte D · consolidação (duas farmácias) ═════════════════════════════════
async function atrasarCriacao(p: Page, ms: number) {
  await p.route("**/encomendas/nova**", async (route) => {
    const req = route.request();
    const corpo = req.postData() ?? "";
    if (req.method() === "POST" && req.headers()["next-action"] && corpo.includes('"batchKey"') && corpo.includes('"nome"') && corpo.includes('"linhas"')) {
      const u = new URL(req.url());
      const resposta = await route.fetch({ url: req.url().replace(u.hostname, "[::1]"), headers: { ...req.headers(), host: u.host } });
      await sleep(ms);
      await route.fulfill({ response: resposta });
    } else {
      await route.continue();
    }
  });
}
async function novaConsolidacao(page: Page, tenant: string): Promise<string> {
  await page.goto(`${baseFor(tenant)}/encomendas/nova`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Consolidação" }).click();
  await page.waitForFunction(() => new URL(location.href).searchParams.get("consolidacao") !== null);
  const key = new URL(page.url()).searchParams.get("consolidacao")!;
  const hoje = new Date();
  await campoPorLabel(page, "Data início", "input").fill(iso(new Date(hoje.getFullYear(), hoje.getMonth() - 6, 1)));
  await campoPorLabel(page, "Data fim", "input").fill(iso(hoje));
  await page.getByRole("button", { name: /Gerar (nova )?proposta/ }).click();
  await page.getByText(nomeP(1)).first().waitFor({ timeout: 30000 });
  return key;
}
async function contagemConsolidacao(key: string, s: Seed): Promise<{ A: Record<string, number>; B: Record<string, number> }> {
  const prisma = await prismaE2E();
  try {
    const { deriveFarmaciaIdempotencyKey } = await import("../../lib/ingest/orders");
    const out = { A: {} as Record<string, number>, B: {} as Record<string, number> };
    for (const [k, f] of [["A", s.fA], ["B", s.fB]] as const) {
      const l = await prisma.listaEncomenda.findFirst({ where: { clientIdempotencyKey: deriveFarmaciaIdempotencyKey(key, f) }, select: { id: true } });
      if (l) out[k] = await contarPorFornecedor(l.id);
    }
    return out;
  } finally {
    await prisma.$disconnect();
  }
}

async function parteD(browser: Browser, s: Seed) {
  console.log("\nD · consolidação: por farmácia (isolamento), ambas, conflito entre sessões e criação em voo");
  const ctx = await contexto(browser, "silveira", s.adminId);
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1700, height: 1300 });
  aceitarDialogos(page);
  const key = await novaConsolidacao(page, "silveira");
  check(await esperarPor(async () => { const c = await contagemConsolidacao(key, s); return Object.values(c.A).reduce((a, b) => a + b, 0) === 60 && Object.values(c.B).reduce((a, b) => a + b, 0) === 60; }), "D0: a consolidação tem um rascunho real por farmácia com 60 linhas cada");

  // só uma farmácia
  await page.getByTestId("bulkc-farmacia").selectOption(s.fA);
  check(/60 linhas seleccionadas de 120/.test(await contagem(page, "bulkc")), "D1: «Todas as linhas da farmácia» (Silveirense) = 60 de 120");
  const r = await atribuir(page, "bulkc", s.forn.Z.nome);
  check(r.includes(`${s.nomeA} (60)`) && !r.includes(`${s.nomeB} (`), "D2: o resumo identifica só a Silveirense (60) — a Segurado fora do âmbito", r);
  check(await esperarPor(async () => { const c = await contagemConsolidacao(key, s); return c.A[s.forn.Z.id] === 60 && c.B[s.forn.Y.id] === 10 && c.B._nenhum === 50; }), "D3: na BD, a Silveirense toda Gama e o Segurado INTACTO (10 Beta + 50 sem fornecedor)");

  // ambas explicitamente (toda a encomenda)
  await escolherFornecedorNaBarra(page, s.forn.X.nome);
  await page.getByTestId("bulkc-atribuir-toda").click();
  const rt = (await page.getByTestId("bulkc-resumo").innerText()).replace(/\s+/g, " ");
  check(rt.includes(`${s.nomeA} (60)`) && rt.includes(`${s.nomeB} (60)`) && /Produtos distintos: 60/i.test(rt.replace("produtos distintos", "Produtos distintos")), "D4: «toda a encomenda» → o resumo mostra AMBAS as farmácias (60 + 60, 60 produtos distintos)", rt);
  await page.getByTestId("bulkc-confirmar").click();
  check(await esperarPor(async () => { const c = await contagemConsolidacao(key, s); return c.A[s.forn.X.id] === 60 && c.B[s.forn.X.id] === 60; }), "D5: na BD, as duas farmácias ficaram com Alfa");

  // conflito: sessão 2 desactualizada
  const p2 = await ctx.newPage();
  await p2.setViewportSize({ width: 1700, height: 1300 });
  aceitarDialogos(p2);
  await p2.goto(`${baseFor("silveira")}/encomendas/nova?consolidacao=${key}`, { waitUntil: "networkidle" });
  await p2.getByText(nomeP(1)).first().waitFor({ timeout: 30000 });
  await page.getByTestId("bulkc-primeiras-20").click();
  await atribuir(page, "bulkc", s.forn.Y.nome);
  check(await esperarPor(async () => { const c = await contagemConsolidacao(key, s); return (c.A[s.forn.Y.id] ?? 0) + (c.B[s.forn.Y.id] ?? 0) === 20; }), "D6: a sessão 1 grava a atribuição colectiva (a versão avança)");
  await p2.getByTestId("bulkc-primeiras-20").click();
  await atribuir(p2, "bulkc", s.forn.W.nome);
  const conflito = await p2.getByTestId("consolidacao-conflito").first().waitFor({ state: "visible", timeout: 25000 }).then(() => true).catch(() => false);
  check(conflito, "D7: a atribuição colectiva da sessão desactualizada gera CONFLITO explícito (a farmácia fica identificada)");
  const c7 = await contagemConsolidacao(key, s);
  check(((c7.A[s.forn.W.id] ?? 0) + (c7.B[s.forn.W.id] ?? 0)) === 0, "D8: nada foi sobrescrito — Delta não chegou à BD");
  check(await p2.getByTestId("consolidacao-criar-encomendas").isDisabled(), "D9: a finalização fica bloqueada na sessão em conflito");
  await p2.close();

  // criação em voo: duas atribuições rápidas com a resposta de criação retida
  console.log("\nD (cont.) · criação do rascunho em voo (resposta retida 8 s) + duas atribuições colectivas rápidas");
  const pD = await ctx.newPage();
  await pD.setViewportSize({ width: 1700, height: 1300 });
  aceitarDialogos(pD);
  await atrasarCriacao(pD, 8000);
  const keyD = await novaConsolidacao(pD, "silveira");
  await pD.getByTestId("bulkc-toda").click();
  await atribuir(pD, "bulkc", s.forn.Z.nome);
  await pD.getByTestId("bulkc-toda").click();
  await atribuir(pD, "bulkc", s.forn.W.nome);
  check(await esperarPor(async () => { const c = await contagemConsolidacao(keyD, s); return c.A[s.forn.W.id] === 60 && c.B[s.forn.W.id] === 60; }, 45000), "D10: com a criação em voo, duas atribuições rápidas — na BD TODAS as 120 linhas ficaram com a ÚLTIMA (Delta); nenhuma perdida");
  await pD.close();
  await ctx.close();
}

// ═══ Parte F · modo farmácia com a criação do rascunho em voo ═══════════════
async function parteF(browser: Browser, s: Seed) {
  console.log("\nF · farmácia: criação do rascunho em voo (resposta retida 8 s) + duas atribuições colectivas rápidas");
  const inicio = new Date(Date.now() - 1000);
  const ctx = await contexto(browser, "silveira", s.adminId);
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1700, height: 1200 });
  aceitarDialogos(page);
  await page.route("**/encomendas/nova**", async (route) => {
    const req = route.request();
    const corpo = req.postData() ?? "";
    if (req.method() === "POST" && req.headers()["next-action"] && corpo.includes('"clientIdempotencyKey"') && corpo.includes('"linhas"')) {
      const u = new URL(req.url());
      const resposta = await route.fetch({ url: req.url().replace(u.hostname, "[::1]"), headers: { ...req.headers(), host: u.host } });
      await sleep(8000);
      await route.fulfill({ response: resposta });
    } else {
      await route.continue();
    }
  });
  await gerarFarmacia(page, "silveira", s.fB);
  await page.getByTestId("bulk-primeiras-20").click();
  await atribuir(page, "bulk", s.forn.Z.nome);
  await page.getByTestId("bulk-toda").click();
  await atribuir(page, "bulk", s.forn.W.nome);
  check(await esperarPor(async () => { const r = await rascunhoDaFarmacia(s.fB, inicio); return !!r && (await contarPorFornecedor(r.id))[s.forn.W.id] === 60; }, 50000), "F1: com a criação do rascunho em voo, duas atribuições colectivas rápidas — na BD as 60 linhas ficaram com a ÚLTIMA (Delta); nenhuma perdida");
  await ctx.close();
}

// ═══ Parte E · finalização dividida por farmácia + fornecedor ═══════════════
async function parteE(page: Page, s: Seed, listaId: string) {
  console.log("\nE · finalização do rascunho da Silveirense: um documento por fornecedor, com as suas linhas");
  await page.goto(`${baseFor("silveira")}/encomendas/nova?rascunho=${listaId}`, { waitUntil: "networkidle" });
  await page.getByText(nomeP(1)).first().waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: /Finalizar e enviar para fila/ }).click();
  await page.getByRole("heading", { name: "Encomenda finalizada" }).waitFor({ timeout: 30000 });
  const prisma = await prismaE2E();
  try {
    const docs = await prisma.listaEncomenda.findMany({ where: { loteOrigemId: listaId }, include: { linhas: true } });
    const porForn = new Map(docs.map((d) => [d.linhas[0]?.fornecedorSugeridoId, d]));
    check(docs.length === 2 && docs.every((d) => d.estado === "FINALIZADA" && d.farmaciaId === s.fA), "E1: 2 documentos FINALIZADA (Delta e Alfa), ambos da Silveirense");
    check(docs.every((d) => new Set(d.linhas.map((l) => l.fornecedorSugeridoId)).size === 1), "E2: cada documento só tem linhas de UM fornecedor");
    check(porForn.get(s.forn.W.id)?.linhas.length === 30 && porForn.get(s.forn.X.id)?.linhas.length === 30, "E3: 30 linhas em cada (a atribuição colectiva chegou ao motor de finalização)");
    check(docs.every((d) => /^EN-\d{6}$/.test(d.numero ?? "")), "E4: cada documento tem o seu número real");
    check((await snapshotHabituais()).length > 0, "E5: (o habitual continua intacto)");
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  const s = await seed();
  const browser = await chromium.launch({
    args: ["--host-resolver-rules=MAP silveira.localhost [::1],MAP garantia.localhost [::1],MAP sier.localhost [::1]"],
  });
  try {
    const { listaId, page, ctx } = await parteA(browser, s);
    await parteB(page, s, listaId);
    await parteC(browser, s);
    await parteD(browser, s);
    await parteF(browser, s);
    await parteE(page, s, listaId);
    await ctx.close();
  } finally {
    await browser.close();
  }
  console.log(`\n${passed} ok, ${failed} falhas`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
