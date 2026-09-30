/**
 * scripts/e2e/fornecedor-por-linha-encomendas-browser.ts
 *
 * Ensaio de browser real (Chromium via Playwright) contra `next start`
 * local + PostgreSQL descartável para o fornecedor-por-linha de
 * Encomendas (Área B — TODOS os tenants) e a finalização
 * multi-fornecedor (`lib/encomendas/finalizar-multi-fornecedor.ts`).
 * Mesma disciplina dos ensaios existentes — nunca contra uma base real.
 *
 * Âmbito: o ensaio cruzado que `fornecedor-picker-browser.ts` deixou
 * explicitamente para uma ronda posterior — picker + finalização
 * multi-fornecedor JUNTOS, ponta-a-ponta, incluindo reimpressão,
 * duplicação, anulação, idempotência/concorrência, e repetição sob um
 * tenant diferente (prova de que a funcionalidade não está presa ao
 * gate silveira-only da Área A).
 *
 *   docker run -d --name spharm-forn-linha-e2e-pg -e POSTGRES_PASSWORD=test -p 55481:5432 postgres:16-alpine
 *   createdb -h localhost -p 55481 -U postgres spharm_e2e_forn_linha
 *   DATABASE_URL=postgresql://postgres:test@localhost:55481/spharm_e2e_forn_linha npx prisma migrate deploy
 *   SERVER_ACTIONS_ALLOWED_ORIGINS="localhost:3100,127.0.0.1:3100,*.localhost:3100" npx next build
 *   E2E_DATABASE_URL=postgresql://postgres:test@localhost:55481/spharm_e2e_forn_linha bash scripts/e2e/_start-server.sh &
 *   npx tsx scripts/e2e/fornecedor-por-linha-encomendas-browser.ts
 *
 * ─── Tenant usado no Passo 17 ───────────────────────────────────────────
 * `garantia` (mesma resolução por subdomínio explicada em
 * `manutencao-massa-silveira-browser.ts` — sem control plane configurado
 * neste ambiente descartável, "silveira" e "garantia" resolvem, ambos,
 * para a MESMA base física via fallback legacy, mas isso é irrelevante
 * aqui: ao contrário da Área A, Encomendas/fornecedor-por-linha NÃO tem
 * nenhum gate de tenant — corre exactamente na mesma base de dados,
 * apenas sob um slug resolvido diferente, o que já é prova suficiente de
 * que a funcionalidade não está acoplada ao tenant "silveira").
 *
 * ─── PDF: extracção directa em Node, mesmo padrão de
 * `scripts/tests/test-finalizar-multi-fornecedor-db.ts` (secção F) ──────
 * Para o Passo 10 (conteúdo do PDF de cada documento), este ficheiro
 * chama `loadOrderDetail`+`buildEncomendaDocumentoReport`+
 * `buildReportPdfBuffer`+`pdf-parse` directamente em Node — a mesma
 * função que a UI usa para gerar o mesmo PDF, só sem passar pelo botão.
 * O Passo 11 (reimpressão) usa o BOTÃO REAL "PDF" no browser,
 * interceptando `/api/reports/pdf` (mesmo padrão de
 * `transferencias-manutencao-browser.ts`) para confirmar que o pedido
 * real do browser pede o MESMO título/documento.
 */
import { chromium, type Page, type BrowserContext } from "playwright";
import { SignJWT } from "jose";
import Module from "node:module";

const DB = process.env.E2E_DATABASE_URL ?? "postgresql://postgres:test@localhost:55481/spharm_e2e_forn_linha";
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

// `server-only` (import estático em várias libs) — via CJS require.
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

function botaoComTexto(row: import("playwright").Locator, pattern: RegExp | string) {
  return row.locator("button").filter({ hasText: pattern });
}
function campoPorLabel(page: Page, label: string, tag: "input" | "select") {
  return page.locator(`xpath=//label[normalize-space(text())="${label}"]/following-sibling::${tag}`);
}

// ─── Seed ────────────────────────────────────────────────────────────────────

type LinhaMeta = { i: number; designacao: string; fornecedorInicial: "ALFA" | "BETA" | null };

function metaSilveira(): LinhaMeta[] {
  const out: LinhaMeta[] = [];
  for (let i = 1; i <= 12; i++) {
    out.push({
      i,
      designacao: `FL E2E Produto ${String(i).padStart(2, "0")}`,
      fornecedorInicial: i <= 4 ? "ALFA" : i <= 8 ? "BETA" : null,
    });
  }
  return out;
}

type SeedSilveiraResult = {
  adminUserId: string;
  farmaciaId: string;
  fornAlfaId: string;
  fornBetaId: string;
  fornGamaId: string;
  produtoIdByIndex: Map<number, string>;
};

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
  // 3 meses de vendas reais e recentes (relativas ao relógio da máquina) —
  // garante um `avgDailySales` positivo e uma proposta "COMPRAR" com stock
  // baixo (2), qualquer que seja `latestDataMonth`/período por omissão do
  // cliente. Mesma ordem de grandeza de `seedE2E`, já comprovada noutros
  // ensaios (`workspaces-browser.ts`, `encomendas-finalizacao-browser.ts`).
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
        quantidade: 30, valorTotal: 300,
      },
    });
  }
  return produto.id;
}

async function limparEncomendasDaFarmacia(prisma: import("../../generated/prisma/client").PrismaClient, farmaciaId: string) {
  const listas = await prisma.listaEncomenda.findMany({ where: { farmaciaId }, select: { id: true } });
  const ids = listas.map((l) => l.id);
  if (ids.length === 0) return;
  await prisma.orderExportAudit.deleteMany({ where: { outbox: { listaEncomendaId: { in: ids } } } });
  await prisma.orderOutbox.deleteMany({ where: { listaEncomendaId: { in: ids } } });
  await prisma.linhaEncomenda.deleteMany({ where: { listaEncomendaId: { in: ids } } });
  await prisma.listaEncomenda.deleteMany({ where: { id: { in: ids } } });
}

async function seedSilveira(databaseUrl: string): Promise<SeedSilveiraResult> {
  const { PrismaClient } = await import("../../generated/prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  try {
    const admin = await prisma.utilizador.upsert({
      where: { email: "e2e-fl-silveira-admin@spharm.test" }, update: {},
      create: { email: "e2e-fl-silveira-admin@spharm.test", nome: "E2E FL Silveira Admin", perfil: "ADMINISTRADOR" },
    });
    const farmacia = await prisma.farmacia.upsert({
      where: { nome: "FL E2E Farmácia Silveira" }, update: {}, create: { nome: "FL E2E Farmácia Silveira" },
    });
    await limparEncomendasDaFarmacia(prisma, farmacia.id);

    const fornAlfa = await prisma.fornecedor.upsert({ where: { nomeNormalizado: "FL E2E FORNECEDOR ALFA" }, update: {}, create: { nomeNormalizado: "FL E2E FORNECEDOR ALFA", nome: "FL E2E Fornecedor Alfa" } });
    const fornBeta = await prisma.fornecedor.upsert({ where: { nomeNormalizado: "FL E2E FORNECEDOR BETA" }, update: {}, create: { nomeNormalizado: "FL E2E FORNECEDOR BETA", nome: "FL E2E Fornecedor Beta" } });
    const fornGama = await prisma.fornecedor.upsert({ where: { nomeNormalizado: "FL E2E FORNECEDOR GAMA" }, update: {}, create: { nomeNormalizado: "FL E2E FORNECEDOR GAMA", nome: "FL E2E Fornecedor Gama" } });

    const produtoIdByIndex = new Map<number, string>();
    let cnp = 7_400_000;
    for (const m of metaSilveira()) {
      const fornecedorId = m.fornecedorInicial === "ALFA" ? fornAlfa.id : m.fornecedorInicial === "BETA" ? fornBeta.id : null;
      const id = await seedProdutoComVendas(prisma, { cnp: cnp++, designacao: m.designacao, farmaciaId: farmacia.id, fornecedorHabitualId: fornecedorId });
      produtoIdByIndex.set(m.i, id);
    }

    return { adminUserId: admin.id, farmaciaId: farmacia.id, fornAlfaId: fornAlfa.id, fornBetaId: fornBeta.id, fornGamaId: fornGama.id, produtoIdByIndex };
  } finally {
    await prisma.$disconnect();
  }
}

type SeedGarantiaResult = {
  adminUserId: string;
  farmaciaId: string;
  fornAlfaId: string;
  fornBetaId: string;
  fornGamaId: string;
};

async function seedGarantia(databaseUrl: string): Promise<SeedGarantiaResult> {
  const { PrismaClient } = await import("../../generated/prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  try {
    const admin = await prisma.utilizador.upsert({
      where: { email: "e2e-fl-garantia-admin@spharm.test" }, update: {},
      create: { email: "e2e-fl-garantia-admin@spharm.test", nome: "E2E FL Garantia Admin", perfil: "ADMINISTRADOR" },
    });
    const farmacia = await prisma.farmacia.upsert({
      where: { nome: "FL E2E Farmácia Garantia" }, update: {}, create: { nome: "FL E2E Farmácia Garantia" },
    });
    await limparEncomendasDaFarmacia(prisma, farmacia.id);

    const fornAlfa = await prisma.fornecedor.upsert({ where: { nomeNormalizado: "FL E2E GARANTIA FORNECEDOR ALFA" }, update: {}, create: { nomeNormalizado: "FL E2E GARANTIA FORNECEDOR ALFA", nome: "FL E2E Garantia Fornecedor Alfa" } });
    const fornBeta = await prisma.fornecedor.upsert({ where: { nomeNormalizado: "FL E2E GARANTIA FORNECEDOR BETA" }, update: {}, create: { nomeNormalizado: "FL E2E GARANTIA FORNECEDOR BETA", nome: "FL E2E Garantia Fornecedor Beta" } });
    const fornGama = await prisma.fornecedor.upsert({ where: { nomeNormalizado: "FL E2E GARANTIA FORNECEDOR GAMA" }, update: {}, create: { nomeNormalizado: "FL E2E GARANTIA FORNECEDOR GAMA", nome: "FL E2E Garantia Fornecedor Gama" } });

    let cnp = 7_500_000;
    const fornecedores = [fornAlfa.id, fornAlfa.id, fornBeta.id, fornBeta.id, fornGama.id, null];
    for (let i = 0; i < 6; i++) {
      await seedProdutoComVendas(prisma, {
        cnp: cnp++, designacao: `FL E2E Garantia Produto ${String(i + 1).padStart(2, "0")}`,
        farmaciaId: farmacia.id, fornecedorHabitualId: fornecedores[i],
      });
    }

    return { adminUserId: admin.id, farmaciaId: farmacia.id, fornAlfaId: fornAlfa.id, fornBetaId: fornBeta.id, fornGamaId: fornGama.id };
  } finally {
    await prisma.$disconnect();
  }
}

// ─── Sessões forjadas ────────────────────────────────────────────────────────

async function contextoParaTenant(browser: import("playwright").Browser, tenant: string, sub: string, email: string): Promise<BrowserContext> {
  const token = await new SignJWT({
    sub, email, nome: `E2E ${tenant}`, perfil: "ADMINISTRADOR", farmaciaId: null, tenant,
  }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("8h").sign(new TextEncoder().encode(SECRET));
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: "session", value: token, url: baseFor(tenant) }]);
  return ctx;
}

async function esperarAutosave(page: Page) {
  await page.getByText(/Guardado às/).first().waitFor({ timeout: 15000 });
}

/**
 * Aceita automaticamente QUALQUER `window.confirm` nesta página, para
 * sempre — `page.once("dialog", ...)` registado a espalhar por vários
 * pontos do ensaio já causou "Cannot accept dialog which is already
 * handled" (uma promise rejeitada fora do try/catch normal, que derruba
 * o processo inteiro) quando dois diálogos se seguem de perto. Um único
 * handler persistente, instalado uma vez por página, com `.catch` a
 * engolir uma dupla-resolução, é a forma robusta.
 */
function aceitarDialogosAutomaticamente(page: Page) {
  page.on("dialog", (d) => {
    d.accept().catch(() => {});
  });
}

// ─── Passos 1/2 — abrir proposta, sugestão inicial ──────────────────────────
async function passo1e2(page: Page, tenant: string, seedData: SeedSilveiraResult): Promise<string> {
  console.log(`\nPasso 1 (${tenant}) · gerar proposta para a farmácia`);
  await page.goto(`${baseFor(tenant)}/encomendas/nova`, { waitUntil: "networkidle" });

  // Selecção EXPLÍCITA da farmácia — nunca confiar na 1ª opção por omissão:
  // como este ensaio reutiliza a MESMA base física para "silveira" e
  // "garantia" (sem control plane — ver nota no topo do ficheiro), as
  // duas farmácias semeadas coexistem na mesma tabela, e a ordenação
  // alfabética do `<select>` pode não coincidir com o tenant da vez.
  await campoPorLabel(page, "Farmácia", "select").selectOption(seedData.farmaciaId);

  // Janela larga (6 meses), independente do que `latestDataMonth` calcule
  // por omissão — garante que as vendas semeadas caem sempre dentro dela.
  const hoje = new Date();
  const seisMesesAtras = new Date(hoje.getFullYear(), hoje.getMonth() - 6, 1);
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  await campoPorLabel(page, "Data início", "input").fill(iso(seisMesesAtras));
  await campoPorLabel(page, "Data fim", "input").fill(iso(hoje));

  await page.getByRole("button", { name: /Gerar (nova )?proposta/ }).click();
  await page.getByText("FL E2E Produto 12").first().waitFor({ timeout: 30000 });
  const nLinhas = await page.locator("tbody tr").count();
  check(nLinhas >= 12, `Passo 1 (${tenant}): a proposta gerou pelo menos 12 linhas`, `obtido=${nLinhas}`);

  console.log(`\nPasso 2 (${tenant}) · sugestão inicial de fornecedor por linha`);
  // ── BUG REAL que existia aqui, ENCONTRADO nesta ronda e CORRIGIDO numa
  // ronda de correcção seguinte (ver relatório final) ─────────────────────
  //
  // `buildProposalLine` (components/encomendas/order-create-client.tsx)
  // criava cada `Line` gerada por proposta com `fornecedorSugeridoId`
  // correcto mas `fornecedorSugeridoNome: null` SEMPRE; `SearchableSelect`
  // tratava esse `null` literalmente como "mostra vazio" em vez de cair no
  // fallback `items.find(...)`, por isso toda linha recém-gerada por
  // proposta mostrava "— Sem fornecedor —" mesmo com um valor real por
  // trás. Corrigido em dois sítios (defesa em profundidade): (1)
  // `buildProposalLine` agora resolve o nome a partir de `fornecedores` no
  // momento da criação da linha; (2) `SearchableSelect` agora trata
  // `selectedLabel == null` (undefined OU null) da mesma forma — cai
  // sempre no fallback por `items`. O texto visível do botão já é a
  // asserção correcta abaixo (antes desta correcção só o botão "Limpar
  // selecção" (✕) era fiável).
  const linha1 = page.locator("tbody tr").filter({ hasText: "FL E2E Produto 01" });
  check(await botaoComTexto(linha1, /Fornecedor Alfa/).isVisible(), `Passo 2 (${tenant}): linha 1 (fornecedorHabitual=Alfa) mostra "Fornecedor Alfa" no botão (rótulo correcto, bug corrigido)`);
  const linha6 = page.locator("tbody tr").filter({ hasText: "FL E2E Produto 06" });
  check(await botaoComTexto(linha6, /Fornecedor Beta/).isVisible(), `Passo 2 (${tenant}): linha 6 (fornecedorHabitual=Beta) mostra "Fornecedor Beta" no botão (rótulo correcto, bug corrigido)`);
  const linha10 = page.locator("tbody tr").filter({ hasText: "FL E2E Produto 10" });
  check((await linha10.getByRole("button", { name: "Limpar selecção" }).count()) === 0, `Passo 2 (${tenant}): linha 10 (sem fornecedorHabitual) não tem nenhum fornecedor seleccionado (sem botão ✕)`);
  check(await botaoComTexto(linha10, /Sem fornecedor/i).isVisible(), `Passo 2 (${tenant}): linha 10 mostra "— Sem fornecedor —" (correctamente, sem sugestão)`);

  // Encontra o draftId real através do URL (?rascunho=<id>), atribuído
  // eagerly assim que a primeira alteração persistir — aqui força-se logo
  // gravando o nome, para o resto do ensaio ter sempre um id estável.
  await campoPorLabel(page, "Nome da encomenda", "input").fill(`FL E2E ${tenant}`).catch(() => {});
  return nLinhas.toString();
}

// ─── Passo 3 — pesquisar e mudar o fornecedor de UMA linha ─────────────────
//
// `getByRole("combobox")` sozinho é AMBÍGUO em `/encomendas/nova`: a
// página tem vários `<select>` nativos (Farmácia, Categoria, ...) que
// também respondem ao role "combobox" — ao contrário de `/encomendas/[id]`
// (onde `fornecedor-picker-browser.ts` usa `.first()` em segurança, essa
// página não tem nenhum `<select>` nativo). Aqui é preciso o `aria-label`
// exacto que `SearchableSelect` recebe por linha
// (`Fornecedor de ${designacao}`) para apontar ao picker certo.
async function passo3(page: Page, tenant: string) {
  console.log(`\nPasso 3 (${tenant}) · pesquisar e mudar o fornecedor de uma linha via picker`);
  const linha9 = page.locator("tbody tr").filter({ hasText: "FL E2E Produto 09" });
  await botaoComTexto(linha9, /Sem fornecedor/i).click();
  const combobox = page.getByRole("combobox", { name: "Fornecedor de FL E2E Produto 09" });
  await combobox.waitFor({ state: "visible" });
  await combobox.fill("Gama");
  const opcao = page.getByRole("listbox").first().getByRole("option").first();
  await opcao.waitFor({ state: "visible" });
  await opcao.click();
  await page.waitForTimeout(300);
  check(await botaoComTexto(linha9, /Fornecedor Gama/).isVisible(), `Passo 3 (${tenant}): a linha 9 passa a mostrar um fornecedor "Gama" depois da pesquisa`);
}

// ─── Passo 4 — bulk "Definir fornecedor" em várias linhas ──────────────────
async function passo4(page: Page, tenant: string) {
  console.log(`\nPasso 4 (${tenant}) · alterar várias linhas em massa via "Definir fornecedor"`);
  await page.locator('input[aria-label="Seleccionar linha FL E2E Produto 10"]').check();
  await page.locator('input[aria-label="Seleccionar linha FL E2E Produto 11"]').check();
  const bulkBotao = page.getByRole("button", { name: "Fornecedor a definir nas linhas seleccionadas" });
  await bulkBotao.click();
  const bulkInput = page.getByRole("combobox", { name: "Fornecedor a definir nas linhas seleccionadas" });
  await bulkInput.waitFor({ state: "visible" });
  await bulkInput.fill("Gama");
  await page.getByRole("listbox").first().getByRole("option").first().click();
  await page.getByRole("button", { name: "Definir fornecedor" }).click();
  await page.waitForTimeout(500);
  const linha10 = page.locator("tr").filter({ has: page.locator('input[aria-label="Seleccionar linha FL E2E Produto 10"]') });
  const linha11 = page.locator("tr").filter({ has: page.locator('input[aria-label="Seleccionar linha FL E2E Produto 11"]') });
  check(await botaoComTexto(linha10, /Fornecedor Gama/).isVisible(), `Passo 4 (${tenant}): a definição em massa aplicou "Gama" à linha 10`);
  check(await botaoComTexto(linha11, /Fornecedor Gama/).isVisible(), `Passo 4 (${tenant}): a definição em massa aplicou "Gama" à linha 11`);
}

// ─── Passo 5 — pelo menos 3 fornecedores distintos entre as linhas ─────────
async function passo5(page: Page, tenant: string) {
  console.log(`\nPasso 5 (${tenant}) · confirmar pelo menos 3 fornecedores distintos entre as linhas`);
  const resumo = await page.locator("span", { hasText: "fornecedor" }).filter({ hasText: "distinto" }).first().innerText().catch(() => "");
  check(/[3-9]\d* fornecedor(es)? distint/.test(resumo) || resumo.includes("3 fornecedores distintos"), `Passo 5 (${tenant}): o resumo de fornecedores reporta pelo menos 3 distintos`, resumo);
}

// ─── Passo 6/7 — linha sem fornecedor bloqueia finalizar, corrigir desbloqueia ─
async function passo6e7(page: Page, tenant: string) {
  console.log(`\nPasso 6 (${tenant}) · uma linha sem fornecedor bloqueia a finalização, com mensagem clara`);
  const linha12 = page.locator("tbody tr").filter({ hasText: "FL E2E Produto 12" });
  check(await botaoComTexto(linha12, /Sem fornecedor/i).isVisible(), `Passo 6 (${tenant}) (fixture): a linha 12 continua sem fornecedor`);

  await esperarAutosave(page);
  await page.getByRole("button", { name: /Finalizar e enviar para fila/ }).click();
  const flashErro = page.locator("div", { hasText: /sem fornecedor definido/ }).first();
  await flashErro.waitFor({ timeout: 15000 });
  check(await flashErro.isVisible(), `Passo 6 (${tenant}): mensagem clara de bloqueio (nunca um documento sem destinatário real)`);

  console.log(`\nPasso 7 (${tenant}) · corrigir a linha em falta desbloqueia a finalização`);
  await botaoComTexto(linha12, /Sem fornecedor/i).click();
  const combobox = page.getByRole("combobox", { name: "Fornecedor de FL E2E Produto 12" });
  await combobox.waitFor({ state: "visible" });
  await combobox.fill("Beta");
  await page.getByRole("listbox").first().getByRole("option").first().click();
  await page.waitForTimeout(300);
  check(await botaoComTexto(linha12, /Fornecedor Beta/).isVisible(), `Passo 7 (${tenant}): a linha 12 já mostra um fornecedor`);
}

// ─── Passo 8 — refresh a meio da edição, recuperação do autosave ───────────
async function passo8(page: Page, tenant: string): Promise<string> {
  console.log(`\nPasso 8 (${tenant}) · refresh a meio da edição — o rascunho e as escolhas de fornecedor sobrevivem`);
  await esperarAutosave(page);
  const url = page.url();
  const draftId = new URL(url).searchParams.get("rascunho");
  check(!!draftId, `Passo 8 (${tenant}) (fixture): a URL tem ?rascunho=<id> (autosave eager já criou o rascunho)`, url);

  await page.reload({ waitUntil: "networkidle" });
  await page.locator("tbody tr").first().waitFor({ timeout: 15000 });
  const linha1 = page.locator("tbody tr").filter({ hasText: "FL E2E Produto 01" });
  const linha9 = page.locator("tbody tr").filter({ hasText: "FL E2E Produto 09" });
  const linha10 = page.locator("tr").filter({ has: page.locator('input[aria-label="Seleccionar linha FL E2E Produto 10"]') });
  const linha12 = page.locator("tbody tr").filter({ hasText: "FL E2E Produto 12" });
  check(await botaoComTexto(linha1, /Fornecedor Alfa/).isVisible(), `Passo 8 (${tenant}): depois do refresh, a linha 1 continua com Alfa`);
  check(await botaoComTexto(linha9, /Fornecedor Gama/).isVisible(), `Passo 8 (${tenant}): depois do refresh, a linha 9 continua com Gama (pesquisa individual sobreviveu)`);
  check(await botaoComTexto(linha10, /Fornecedor Gama/).isVisible(), `Passo 8 (${tenant}): depois do refresh, a linha 10 continua com Gama (definição em massa sobreviveu)`);
  check(await botaoComTexto(linha12, /Fornecedor Beta/).isVisible(), `Passo 8 (${tenant}): depois do refresh, a linha 12 (corrigida no Passo 7) continua com Beta`);

  return draftId!;
}

// ─── Passo 9 — finalizar ─────────────────────────────────────────────────────
//
// ── BUG REAL que existia aqui, ENCONTRADO nesta ronda e CORRIGIDO numa
// ronda de correcção seguinte (ver relatório final) ───────────────────────
//
// `lib/encomendas/use-autosave-encomenda.ts`: `versaoRef = useRef(opts.
// versaoInicial)` só recebia `opts.versaoInicial` na PRIMEIRA renderização
// do hook — `useRef` ignora o argumento em renderizações seguintes, e não
// havia nenhum `useEffect` a ressincronizar `versaoRef.current` quando
// `opts.versaoInicial` mudava depois. Em `order-create-client.tsx`, a
// restauração de um rascunho via `?rascunho=<id>` só conhece a versão real
// DEPOIS de montar (`setDraftVersaoInicial(d.versao)` assíncrono, numa
// renderização posterior à que já criou o hook com `versaoInicial=0`).
// Resultado: depois de QUALQUER refresh real de `/encomendas/nova?
// rascunho=<id>` cujo rascunho já tivesse sido gravado mais do que 0
// vezes (exactamente o caso do Passo 8 acima), `versaoRef.current` ficava
// preso em `0` PARA SEMPRE nessa sessão — toda a finalização seguinte
// enviava `versaoEsperada: 0` contra uma BD já noutra versão, e o servidor
// rejeitava com um FALSO "conflito de versão".
//
// Corrigido em `use-autosave-encomenda.ts` com um `useEffect` que
// ressincroniza `versaoRef.current` sempre que a IDENTIDADE do rascunho
// (`listaEncomendaId`) muda — exactamente o momento em que
// `versaoInicial` chega tardiamente com o valor real. Este passo finaliza
// agora DIRECTAMENTE em `/encomendas/nova?rascunho=<id>` (a mesma página
// onde o bug se manifestava, depois do MESMO refresh do Passo 8) — já não
// precisa de rodear pelo caminho `/encomendas/{id}`.
async function passo9(page: Page, tenant: string, draftId: string) {
  console.log(`\nPasso 9 (${tenant}) · finalizar directamente em /encomendas/nova?rascunho=<id> (prova da correcção do bug de versão)`);
  await page.goto(`${baseFor(tenant)}/encomendas/nova?rascunho=${draftId}`, { waitUntil: "networkidle" });
  await page.locator("tbody tr").first().waitFor({ timeout: 15000 });
  await esperarAutosave(page).catch(() => {});
  await page.getByRole("button", { name: /Finalizar e enviar para fila/ }).click();
  const semConflito = await page
    .getByText(/alterada por outra sessão/)
    .waitFor({ timeout: 3000 })
    .then(() => false)
    .catch(() => true);
  check(semConflito, `Passo 9 (${tenant}): finalizar em /encomendas/nova?rascunho= NÃO dispara o falso "conflito de versão" (bug corrigido)`);
  // `/encomendas/nova` substitui o ecrã inteiro por `PainelResultadoFinalizacao`
  // (título "Encomenda finalizada" + "N encomenda(s)") em vez do flash de
  // texto simples que `/encomendas/{id}` usa ("N encomendas criadas\n...",
  // via `resumoTexto`) — são dois mecanismos de apresentação distintos e
  // igualmente correctos para o mesmo resultado, não um bug.
  await page.getByRole("heading", { name: "Encomenda finalizada" }).waitFor({ timeout: 20000 });
  check(true, `Passo 9 (${tenant}): a finalização multi-fornecedor devolveu o painel de resultado com sucesso`);
}

// ─── Passo 10 — 3 documentos, numero reais, PDFs isolados por fornecedor ───
async function passo10(
  seedData: SeedSilveiraResult,
  draftId: string
): Promise<Array<{ id: string; numero: string; fornecedorNome: string }>> {
  console.log("\nPasso 10 · exactamente 3 documentos, numero reais distintos, PDF isolado por fornecedor");
  const { PrismaClient } = await import("../../generated/prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB }) });
  try {
    const filhos = await prisma.listaEncomenda.findMany({
      where: { loteOrigemId: draftId },
      include: { linhas: { include: { fornecedorSugerido: true } } },
      orderBy: { dataCriacao: "asc" },
    });
    check(filhos.length === 3, "Passo 10: exactamente 3 ListaEncomenda FINALIZADA foram geradas", `obtido=${filhos.length}`);
    check(filhos.every((f) => f.estado === "FINALIZADA"), "Passo 10: as 3 nasceram FINALIZADA");
    const numeros = filhos.map((f) => f.numero);
    check(numeros.every((n) => n !== null && /^EN-\d{6}$/.test(n)), "Passo 10: os 3 numeros são reais, formato EN-######", JSON.stringify(numeros));
    check(new Set(numeros).size === 3, "Passo 10: os 3 numeros são todos distintos entre si");

    const { loadOrderDetail } = await import("../../lib/encomendas/order-detail");
    const { buildEncomendaDocumentoReport } = await import("../../lib/reporting/adapters/encomenda-documento");
    const { buildReportPdfBuffer } = await import("../../lib/reporting/report-pdf-server");
    const { PDFParse } = await import("pdf-parse");

    async function extrairTexto(buffer: Buffer): Promise<string> {
      const parser = new PDFParse({ data: buffer });
      const result = await parser.getText();
      await parser.destroy?.();
      return result.text;
    }

    const resultado: Array<{ id: string; numero: string; fornecedorNome: string }> = [];
    // Derivado dos PRÓPRIOS documentos gerados nesta chamada — nunca uma
    // lista fixa de nomes: serve tanto para a corrida "silveira" como para
    // a corrida "garantia" (Passo 17), com nomes de fornecedor diferentes.
    const nomesOutrosFornecedores = filhos.map((f) => f.linhas[0]?.fornecedorSugerido?.nome ?? "?");

    for (const filho of filhos) {
      const detalhe = await loadOrderDetail(filho.id);
      check(!!detalhe, `Passo 10: loadOrderDetail resolve o documento ${filho.numero}`);
      const fornecedorNome = filho.linhas[0]?.fornecedorSugerido?.nome ?? "?";
      const [report] = buildEncomendaDocumentoReport([detalhe!]);
      const { buffer } = await buildReportPdfBuffer(report);
      const texto = await extrairTexto(buffer);
      check(texto.includes(fornecedorNome), `Passo 10: o PDF de ${fornecedorNome} identifica-o no cabeçalho`);
      for (const outro of nomesOutrosFornecedores) {
        if (outro === fornecedorNome) continue;
        check(!texto.includes(outro), `Passo 10: o PDF de ${fornecedorNome} NUNCA menciona ${outro}`);
      }
      const designacoesDeOutrosFornecedores = filhos
        .filter((f) => f.id !== filho.id)
        .flatMap((f) => f.linhas.map((l) => l.designacaoSnapshot ?? ""));
      const vazaAlguma = designacoesDeOutrosFornecedores.some((d) => d && texto.includes(d));
      check(!vazaAlguma, `Passo 10: o PDF de ${fornecedorNome} não contém nenhuma linha de outro fornecedor`);

      resultado.push({ id: filho.id, numero: filho.numero!, fornecedorNome });
    }

    void seedData;
    return resultado;
  } finally {
    await prisma.$disconnect();
  }
}

// ─── Passo 11 — reimprimir um dos 3 via browser (botão real) ───────────────
async function passo11(page: Page, tenant: string, documentos: Array<{ id: string; numero: string; fornecedorNome: string }>) {
  console.log(`\nPasso 11 (${tenant}) · reimprimir um dos 3 documentos pelo botão real — mesmo conteúdo, sem novo outbox`);
  const alvo = documentos[0];

  const { PrismaClient } = await import("../../generated/prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB }) });
  const nOutboxAntes = await prisma.orderOutbox.count({ where: { listaEncomendaId: alvo.id } });

  await page.goto(`${baseFor(tenant)}/encomendas/${alvo.id}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Imprimir · PDF · Email" }).click();
  await page.getByText("A preparar os documentos…").waitFor({ state: "hidden", timeout: 15000 }).catch(() => {});

  let tituloPedido: string | null = null;
  await page.route("**/api/reports/pdf", async (route) => {
    const body = route.request().postDataJSON() as { title?: string };
    tituloPedido = body?.title ?? null;
    await route.abort();
  });
  // `exact: true` — sem isso, "PDF" (substring, por omissão) também bate
  // no botão "Imprimir · PDF · Email" que abriu o modal, que fica por
  // baixo do overlay e intercepta o clique.
  await page.getByRole("button", { name: "PDF", exact: true }).first().click();
  await page.waitForTimeout(500);
  await page.unroute("**/api/reports/pdf");

  // `String(...)` em vez de `.includes` directo sobre `tituloPedido`: o TS
  // estreita `let tituloPedido: string | null` para `null` neste ponto
  // (não acompanha a reatribuição dentro do closure de `page.route` através
  // da fronteira de função) — `String(null)` é "null", que nunca contém o
  // nome de um fornecedor, por isso o teste falha correctamente sem
  // precisar de nenhum "as"/cast para contornar o TS.
  check(String(tituloPedido).includes(alvo.fornecedorNome), `Passo 11 (${tenant}): o botão PDF real pede o MESMO documento (título inclui o fornecedor)`, String(tituloPedido));

  const nOutboxDepois = await prisma.orderOutbox.count({ where: { listaEncomendaId: alvo.id } });
  check(nOutboxDepois === nOutboxAntes, `Passo 11 (${tenant}): reimprimir não cria nenhum OrderOutbox novo (leitura pura, sem re-exportar)`);
  await prisma.$disconnect();
}

// ─── Passo 12 — duplicar um dos 3 ───────────────────────────────────────────
//
// Navega SEMPRE com `?farmacia=<id>` — a lista de `/encomendas`, sem esse
// filtro, mostra TODAS as farmácias que a base física conhece; como este
// ambiente descartável parte as duas corridas ("silveira", Passo 17
// "garantia") pela MESMA base física (sem control plane — ver nota no
// topo do ficheiro), correr este ensaio repetidamente deixa documentos de
// uma corrida anterior visíveis nas seguintes, e uma pesquisa por nome de
// fornecedor sem escopo de farmácia pode devolver mais do que 1 linha.
async function passo12(page: Page, tenant: string, farmaciaId: string, documentos: Array<{ id: string; numero: string; fornecedorNome: string }>): Promise<string> {
  console.log(`\nPasso 12 (${tenant}) · duplicar um dos 3 documentos — novo rascunho editável e independente`);
  const alvo = documentos[1];
  await page.goto(`${baseFor(tenant)}/encomendas?farmacia=${encodeURIComponent(farmaciaId)}`, { waitUntil: "networkidle" });
  // A pesquisa da lista filtra por "nome" (não por número — a coluna
  // "Nome" é a única pesquisável, ver order-list-client.tsx) — cada
  // documento gerado por fornecedor chama-se
  // "<nome do lote> · <fornecedor>" (finalizar-multi-fornecedor.ts), por
  // isso o nome do fornecedor é o termo de pesquisa que funciona de facto.
  await campoPorLabelPesquisa(page).fill(alvo.fornecedorNome);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  const linha = page.locator("tbody tr").filter({ hasText: alvo.fornecedorNome });
  await linha.getByRole("button", { name: "Duplicar" }).click();
  await page.getByText("Encomenda duplicada").waitFor({ timeout: 15000 });

  const { PrismaClient } = await import("../../generated/prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB }) });
  try {
    const novo = await prisma.listaEncomenda.findFirst({
      where: { farmaciaId: (await prisma.listaEncomenda.findUniqueOrThrow({ where: { id: alvo.id } })).farmaciaId, estado: "RASCUNHO", numero: null },
      orderBy: { dataCriacao: "desc" },
      include: { linhas: true },
    });
    check(!!novo, `Passo 12 (${tenant}): nasceu um novo RASCUNHO (sem número)`);
    const original = await prisma.listaEncomenda.findUniqueOrThrow({ where: { id: alvo.id }, include: { linhas: true } });
    check(novo!.linhas.length === original.linhas.length, `Passo 12 (${tenant}): o duplicado tem o MESMO número de linhas do original`);
    check(
      novo!.linhas.every((l) => original.linhas.some((o) => o.produtoId === l.produtoId && o.fornecedorSugeridoId === l.fornecedorSugeridoId)),
      `Passo 12 (${tenant}): as linhas duplicadas têm os MESMOS produtos/fornecedores do original`
    );
    check(original.estado === "FINALIZADA", `Passo 12 (${tenant}): o original permanece FINALIZADA — duplicar nunca o altera`);
    return novo!.id;
  } finally {
    await prisma.$disconnect();
  }
}

// ─── Passo 13/14 — anular UM dos 3, os outros ficam intocados ──────────────
async function passo13e14(page: Page, tenant: string, farmaciaId: string, documentos: Array<{ id: string; numero: string; fornecedorNome: string }>) {
  console.log(`\nPasso 13 (${tenant}) · anular só UM dos 3 documentos originais`);
  const alvo = documentos[2];
  const irmaos = [documentos[0], documentos[1]];

  await page.goto(`${baseFor(tenant)}/encomendas?farmacia=${encodeURIComponent(farmaciaId)}`, { waitUntil: "networkidle" });
  await campoPorLabelPesquisa(page).fill(alvo.fornecedorNome);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  const linha = page.locator("tbody tr").filter({ hasText: alvo.fornecedorNome });
  await linha.getByRole("button", { name: "Anular" }).click();
  await page.getByPlaceholder("Obrigatório — descreva o motivo").fill("Anulado no ensaio e2e — fornecedor por linha");
  await page.getByRole("button", { name: "Confirmar anulação" }).click();
  await page.getByText("Encomenda anulada.").waitFor({ timeout: 15000 });

  console.log(`\nPasso 14 (${tenant}) · os outros dois continuam FINALIZADA, completamente intocados`);
  const { PrismaClient } = await import("../../generated/prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB }) });
  try {
    const alvoDb = await prisma.listaEncomenda.findUniqueOrThrow({ where: { id: alvo.id } });
    check(alvoDb.estado === "ANULADA", `Passo 13 (${tenant}): o documento anulado tem estado real ANULADA`);
    for (const irmao of irmaos) {
      const l = await prisma.listaEncomenda.findUniqueOrThrow({ where: { id: irmao.id }, include: { linhas: true } });
      check(l.estado === "FINALIZADA", `Passo 14 (${tenant}): ${irmao.fornecedorNome} continua FINALIZADA — não afectado pela anulação do irmão`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

// ─── Passo 15 — repetir o mesmo pedido de finalização (replay) ─────────────
async function passo15(draftId: string, tenantSlug: string) {
  console.log("\nPasso 15 · repetir o MESMO pedido de finalização — nunca duplica");
  const { PrismaClient } = await import("../../generated/prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB }) });
  try {
    const { finalizarEncomendaMultiFornecedor } = await import("../../lib/encomendas/finalizar-multi-fornecedor");
    const antes = await prisma.listaEncomenda.count({ where: { loteOrigemId: draftId } });
    const resultado = await finalizarEncomendaMultiFornecedor(prisma, tenantSlug, { listaEncomendaId: draftId, batchKey: draftId });
    check(resultado.reutilizado === true, "Passo 15: a repetição é reconhecida como replay (reutilizado=true)");
    check(resultado.documentos.length === 3, "Passo 15: o replay devolve os MESMOS 3 documentos");
    const depois = await prisma.listaEncomenda.count({ where: { loteOrigemId: draftId } });
    check(depois === antes && depois === 3, "Passo 15: continuam a existir exactamente 3 documentos filhos — nenhum novo foi criado", `antes=${antes} depois=${depois}`);
  } finally {
    await prisma.$disconnect();
  }
}

// ─── Passo 16 — resposta "perdida": chamadas concorrentes, mesma chave ─────
async function passo16(draftId: string, tenantSlug: string) {
  console.log("\nPasso 16 · simulação de resposta perdida — chamadas concorrentes com a MESMA chave reconciliam para o MESMO resultado");
  const { PrismaClient } = await import("../../generated/prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB }) });
  try {
    const { finalizarEncomendaMultiFornecedor } = await import("../../lib/encomendas/finalizar-multi-fornecedor");
    // O rascunho já está dividido (Passo 9) — isto simula exactamente o
    // cenário "o cliente nunca viu a resposta": duas chamadas em voo ao
    // mesmo tempo, mesma `batchKey` (= draftId, tal como a UI real usa —
    // ver `finalizeFromDetailAction`), sobre um lote já terminal.
    const [a, b] = await Promise.all([
      finalizarEncomendaMultiFornecedor(prisma, tenantSlug, { listaEncomendaId: draftId, batchKey: draftId }),
      finalizarEncomendaMultiFornecedor(prisma, tenantSlug, { listaEncomendaId: draftId, batchKey: draftId }),
    ]);
    const idsA = a.documentos.map((d) => d.listaEncomendaId).sort().join(",");
    const idsB = b.documentos.map((d) => d.listaEncomendaId).sort().join(",");
    check(idsA === idsB, "Passo 16: as duas chamadas concorrentes devolvem EXACTAMENTE o mesmo conjunto de documentos");
    const total = await prisma.listaEncomenda.count({ where: { loteOrigemId: draftId } });
    check(total === 3, "Passo 16: continuam a existir só 3 documentos filhos — nenhum conflito, nenhum duplicado", `total=${total}`);
  } finally {
    await prisma.$disconnect();
  }
}

function campoPorLabelPesquisa(page: Page) {
  return page.getByPlaceholder("Procurar por nome…");
}

async function main() {
  const seedData = await seedSilveira(DB);
  const browser = await chromium.launch({
    args: ["--host-resolver-rules=MAP silveira.localhost [::1],MAP garantia.localhost [::1]"],
  });

  try {
    // ── Fluxo principal — tenant silveira ─────────────────────────────────
    const ctxSilveira = await contextoParaTenant(browser, "silveira", seedData.adminUserId, "e2e-fl-silveira@spharm.test");
    const page = await ctxSilveira.newPage();
    await page.setViewportSize({ width: 1700, height: 1000 });
    aceitarDialogosAutomaticamente(page);

    await passo1e2(page, "silveira", seedData);
    await passo3(page, "silveira");
    await passo4(page, "silveira");
    await passo5(page, "silveira");
    await passo6e7(page, "silveira");
    const draftId = await passo8(page, "silveira");
    await passo9(page, "silveira", draftId);
    const documentos = await passo10(seedData, draftId);
    await passo11(page, "silveira", documentos);
    await passo12(page, "silveira", seedData.farmaciaId, documentos);
    await passo13e14(page, "silveira", seedData.farmaciaId, documentos);
    await passo15(draftId, "silveira");
    await passo16(draftId, "silveira");

    await page.close();
    await ctxSilveira.close();

    // ── Passo 17 — repetir o núcleo sob um tenant DIFERENTE ───────────────
    console.log("\nPasso 17 · repetir o núcleo (1,3,5,9,10) sob o tenant garantia — prova de que não está preso à silveira");
    const seedGarantiaData = await seedGarantia(DB);
    const ctxGarantia = await contextoParaTenant(browser, "garantia", seedGarantiaData.adminUserId, "e2e-fl-garantia@spharm.test");
    const pageG = await ctxGarantia.newPage();
    await pageG.setViewportSize({ width: 1700, height: 1000 });
    aceitarDialogosAutomaticamente(pageG);

    await pageG.goto(`${baseFor("garantia")}/encomendas/nova`, { waitUntil: "networkidle" });
    await campoPorLabel(pageG, "Farmácia", "select").selectOption(seedGarantiaData.farmaciaId);
    const hoje = new Date();
    const seisMesesAtras = new Date(hoje.getFullYear(), hoje.getMonth() - 6, 1);
    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    await campoPorLabel(pageG, "Data início", "input").fill(iso(seisMesesAtras));
    await campoPorLabel(pageG, "Data fim", "input").fill(iso(hoje));
    await pageG.getByRole("button", { name: /Gerar (nova )?proposta/ }).click();
    await pageG.locator("tbody tr").first().waitFor({ timeout: 30000 });
    check((await pageG.locator("tbody tr").count()) >= 6, "Passo 17 (garantia): a proposta gerou as linhas semeadas");

    // Passo 17.3 — muda o fornecedor de uma linha via picker.
    const linhaG6 = pageG.locator("tbody tr").filter({ hasText: "FL E2E Garantia Produto 06" });
    await botaoComTexto(linhaG6, /Sem fornecedor/i).click();
    const comboboxG = pageG.getByRole("combobox", { name: "Fornecedor de FL E2E Garantia Produto 06" });
    await comboboxG.waitFor({ state: "visible" });
    // "Gama" sozinho seria ambíguo: a esta altura já existem DOIS
    // fornecedores cujo nome contém "Gama" na mesma base física (o de
    // silveira e o de garantia — fornecedores são globais, não por
    // farmácia/tenant, e este ambiente descartável não tem control plane
    // a separá-los fisicamente). "Garantia Fornecedor Gama" é o termo que
    // resolve só o registo certo.
    await comboboxG.fill("Garantia Fornecedor Gama");
    await pageG.getByRole("listbox").first().getByRole("option").first().click();
    await pageG.waitForTimeout(300);
    check(await botaoComTexto(linhaG6, /Garantia Fornecedor Gama/).isVisible(), "Passo 17.3 (garantia): a linha alterada via picker mostra o novo fornecedor");

    // Passo 17.5 — pelo menos 3 fornecedores distintos.
    const resumoG = await pageG.locator("span", { hasText: "fornecedor" }).filter({ hasText: "distinto" }).first().innerText().catch(() => "");
    check(resumoG.includes("3 fornecedores distintos"), "Passo 17.5 (garantia): pelo menos 3 fornecedores distintos entre as linhas", resumoG);

    // Passo 17.9 — finalizar.
    await esperarAutosave(pageG);
    const urlG = pageG.url();
    const draftIdG = new URL(urlG).searchParams.get("rascunho")!;
    check(!!draftIdG, "Passo 17.9 (garantia) (fixture): rascunho eager criado");
    await pageG.getByRole("button", { name: /Finalizar e enviar para fila/ }).click();
    await pageG.getByRole("heading", { name: "Encomendas finalizadas" }).waitFor({ timeout: 20000 });
    check(true, "Passo 17.9 (garantia): finalização multi-fornecedor concluída com sucesso sob o tenant garantia");

    // Passo 17.10 — 3 documentos, numero reais, PDFs.
    const docsG = await passo10(seedGarantiaData as unknown as SeedSilveiraResult, draftIdG);
    check(docsG.length === 3, "Passo 17.10 (garantia): exactamente 3 documentos gerados, com numero/PDF reais confirmados");

    await pageG.close();
    await ctxGarantia.close();
  } finally {
    await browser.close();
  }

  console.log(`\n${passed} ok, ${failed} falhas`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
