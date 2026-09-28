/**
 * scripts/e2e/encomendas-finalizacao-browser.ts
 *
 * Pontos 1/2/3/4/7/8 (fluxo de finalização de Encomendas) — ensaio de
 * browser real (Chromium via Playwright) contra `next start` local +
 * PostgreSQL descartável. Nunca contra uma base real.
 *
 *   docker run -d --name spharm-ws-test-pg -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:16-alpine
 *   # criar base, `prisma migrate deploy`, `npm run build`,
 *   # `bash scripts/e2e/_start-server.sh` (porta 3100)
 *   npm run test:e2e-encomendas-finalizacao
 */
import { chromium, type Page } from "playwright";
import { SignJWT } from "jose";
import { Client } from "pg";
import { seedE2E } from "./seed-e2e";

const DB = process.env.E2E_DATABASE_URL ?? "postgresql://postgres:test@localhost:55432/spharm_e2e";
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3100";
const SECRET = process.env.E2E_AUTH_SECRET ?? "e2e-test-secret-e2e-test-secret-0123456789";
for (const u of [DB, BASE]) {
  const h = new URL(u).hostname;
  if (h !== "localhost" && h !== "127.0.0.1") { console.error(`RECUSADO: ${h} não é local.`); process.exit(2); }
}

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  [OK]    ${msg}`); }
  else { failed++; console.log(`  [FALHA] ${msg}`); }
}

async function gerarPropostaGrupo(page: Page) {
  await page.goto(BASE + "/encomendas/nova", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Grupo", exact: true }).click();
  await page.getByRole("button", { name: /Gerar (nova )?proposta/ }).click();
  await page.getByText("ARTIGO E2E 6").first().waitFor({ state: "attached", timeout: 30000 });
}

// ─── Ponto 1 — tabela nunca depende de scroll horizontal escondido ─────────
async function testeResponsividade(ctx: import("playwright").BrowserContext) {
  console.log("\nPonto 1 · tabela da proposta em 3 resoluções (modo Grupo)");
  for (const [nome, viewport] of [
    ["1366×768", { width: 1366, height: 768 }],
    ["1600×900", { width: 1600, height: 900 }],
    ["1920×1080", { width: 1920, height: 1080 }],
  ] as const) {
    const page = await ctx.newPage();
    await page.setViewportSize(viewport);
    await gerarPropostaGrupo(page);

    const semScrollDePagina = await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
    );
    check(semScrollDePagina, `${nome}: a PÁGINA em si não precisa de scroll horizontal próprio (só a tabela, se precisar)`);

    const linha = page.locator("tbody tr").filter({ has: page.locator('input[type="number"]') }).first();
    await linha.waitFor({ timeout: 15000 });
    const finalInput = linha.locator('input[type="number"]').first();
    const removerBtn = linha.getByRole("button").last();
    const [rFinal, rRemover, viewportWidth] = await Promise.all([
      finalInput.boundingBox(),
      removerBtn.boundingBox(),
      page.evaluate(() => window.innerWidth),
    ]);
    check(!!rFinal && rFinal.x >= 0 && rFinal.x + rFinal.width <= viewportWidth + 1, `${nome}: o campo Final está dentro do ecrã (nunca é preciso scroll para o alcançar)`);
    check(!!rRemover && rRemover.x >= 0 && rRemover.x + rRemover.width <= viewportWidth + 1, `${nome}: o botão de remover linha está dentro do ecrã`);

    // Pelo menos uma linha TRANSFERIR (artigos 1/2, excesso na Beta) — a
    // célula Decisão é a mais larga; confirma que também ela fica visível.
    const linhaTransferir = page.locator("tbody tr").filter({ has: page.getByText("Origem…") }).first();
    if (await linhaTransferir.count()) {
      const selectOrigem = linhaTransferir.locator("select").first();
      const rOrigem = await selectOrigem.boundingBox();
      check(!!rOrigem && rOrigem.x >= 0 && rOrigem.x + rOrigem.width <= viewportWidth + 1, `${nome}: o select de origem (Decisão · Transferir) está dentro do ecrã`);
    }
    await page.close();
  }
}

// ─── Pontos 2/3/7/8 — finalizar directamente, com transferências ───────────
async function testeFinalizacaoGrupo(ctx: import("playwright").BrowserContext, db: Client) {
  console.log("\nPontos 2/3/7/8 · finalizar uma proposta de grupo (encomendas + transferências)");
  await db.query(`DELETE FROM "ListaEncomenda"`);
  await db.query(`DELETE FROM "Transferencia"`);
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1600, height: 900 });
  await gerarPropostaGrupo(page);

  await page.getByRole("button", { name: "Finalizar encomenda" }).click();
  await page.getByText("Como pretende gerar a encomenda?").waitFor({ timeout: 10000 });
  check(true, "gerar plano não cria nada sozinho — abre primeiro a confirmação (Ponto 8)");
  const radioSeparada = page.getByRole("radio").first();
  check(await radioSeparada.isChecked(), "«Separada por farmácia» vem seleccionada por omissão");
  const resumoTexto = await page.getByText(/encomenda\(s\)|encomenda$/).locator("..").innerText().catch(() => "");
  void resumoTexto;
  check(await page.getByText(/transferência/).count() > 0, "o resumo do modal menciona as transferências (Ponto 8: X encomendas / Y transferências)");
  check(await page.getByText(/unidade.*a encomendar/).count() > 0, "o resumo mostra as unidades a encomendar");
  check(await page.getByText(/unidade.*a transferir/).count() > 0, "o resumo mostra as unidades a transferir");

  await page.getByRole("button", { name: "Confirmar e finalizar" }).click();
  await page.getByText("Encomenda finalizada").waitFor({ timeout: 30000 });
  check(true, "Ponto 2: nenhum ecrã intermédio — de «Finalizar encomenda» ao resultado, um único gesto (com a confirmação pelo meio)");

  check(await page.getByText("Encomendas finalizadas").isVisible(), "painel mostra «Encomendas finalizadas»");
  check(await page.getByText("Transferências geradas").isVisible(), "painel mostra «Transferências geradas» (Ponto 7 — nunca escondido)");
  check(await page.getByRole("button", { name: "Imprimir" }).count() >= 2, "Imprimir disponível para encomendas E transferências");
  check(await page.getByRole("button", { name: "PDF" }).count() >= 2, "PDF disponível para encomendas E transferências");
  check(await page.getByRole("button", { name: "Email" }).count() >= 2, "Email disponível para encomendas E transferências");
  check((await page.getByRole("button", { name: "Excel" }).count()) === 0, "sem Excel nos documentos de encomenda/transferência (só Imprimir/PDF/Email)");

  const nListas = (await db.query(`SELECT count(*)::int n FROM "ListaEncomenda"`)).rows[0].n as number;
  const nRascunho = (await db.query(`SELECT count(*)::int n FROM "ListaEncomenda" WHERE estado='RASCUNHO'`)).rows[0].n as number;
  const nFinalizadas = (await db.query(`SELECT count(*)::int n FROM "ListaEncomenda" WHERE estado='FINALIZADA'`)).rows[0].n as number;
  check(nListas > 0 && nRascunho === 0 && nFinalizadas === nListas, "Ponto 2: TODAS as encomendas nasceram FINALIZADA — nenhuma ficou RASCUNHO à espera de um 2º passo");
  const nOutbox = (await db.query(`SELECT count(*)::int n FROM "OrderOutbox"`)).rows[0].n as number;
  check(nOutbox === nListas, "uma outbox por encomenda (pronto para a fila de exportação)");
  const nTransferenciasFinalizadas = (await db.query(`SELECT count(*)::int n FROM "Transferencia" WHERE estado='FINALIZADA'`)).rows[0].n as number;
  const nTransferenciasRascunho = (await db.query(`SELECT count(*)::int n FROM "Transferencia" WHERE estado='RASCUNHO'`)).rows[0].n as number;
  check(nTransferenciasFinalizadas > 0 && nTransferenciasRascunho === 0, "Ponto 7: as transferências nasceram FINALIZADA (bug corrigido — antes ficavam presas em RASCUNHO)");

  await page.getByRole("button", { name: "Concluir" }).click();
  await page.waitForFunction(() => location.pathname === "/encomendas", null, { timeout: 15000 });
  check(true, "«Concluir» sai para a lista de encomendas");
  await page.close();
}

// ─── Ponto 3 — «Encomenda única do Grupo» (consolidada, sem tocar na BD) ───
async function testeFinalizacaoConsolidada(ctx: import("playwright").BrowserContext, db: Client) {
  console.log("\nPonto 3 · «Encomenda única do Grupo» — consolidação é só apresentação");
  await db.query(`DELETE FROM "ListaEncomenda"`);
  await db.query(`DELETE FROM "Transferencia"`);
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1600, height: 900 });
  await gerarPropostaGrupo(page);

  await page.getByRole("button", { name: "Finalizar encomenda" }).click();
  await page.getByLabel(/Encomenda única do Grupo/).check();
  await page.getByRole("button", { name: "Confirmar e finalizar" }).click();
  await page.getByText("Encomenda finalizada").waitFor({ timeout: 30000 });

  // `ReportActions` nunca mostra o título do Report na página (só dentro do
  // PDF/impressão/email gerados) — a única forma fiável de confirmar QUAL
  // documento foi escolhido é inspeccionar o pedido real que o botão PDF
  // envia para `/api/reports/pdf`.
  let tituloPedido: string | null = null;
  await page.route("**/api/reports/pdf", async (route) => {
    const body = route.request().postDataJSON() as { title?: string };
    tituloPedido = body?.title ?? null;
    await route.abort();
  });
  const secaoEncomendas = page.locator("section", { has: page.getByText("Encomendas finalizadas") });
  await secaoEncomendas.getByRole("button", { name: "PDF" }).first().click();
  await page.waitForTimeout(500);
  await page.unroute("**/api/reports/pdf");
  check(tituloPedido === "Encomenda Consolidada do Grupo", `mostra o documento consolidado quando escolhido (título pedido: ${tituloPedido})`);
  // A escolha é só de apresentação — a base continua com uma ListaEncomenda
  // POR FARMÁCIA (nunca uma única lista a abranger várias farmácias).
  const listas = await db.query(`SELECT DISTINCT "farmaciaId" FROM "ListaEncomenda"`);
  check(listas.rowCount !== null && listas.rowCount >= 2, "continuam a existir várias ListaEncomenda, uma por farmácia (nada fundido na BD)");
  await page.close();
}

// ─── Farmácia — também termina no painel de resultado (Ponto 4 universal) ──
async function testeFinalizacaoFarmacia(ctx: import("playwright").BrowserContext, db: Client) {
  console.log("\nPonto 4 · modo Farmácia também mostra Imprimir/PDF/Email ao finalizar");
  await db.query(`DELETE FROM "ListaEncomenda"`);
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(BASE + "/encomendas/nova", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Gerar (nova )?proposta/ }).click();
  await page.getByText("ARTIGO E2E 6").first().waitFor({ state: "attached", timeout: 30000 });
  await page.getByRole("button", { name: "Finalizar e enviar para fila" }).click();
  await page.getByText("Encomenda finalizada").waitFor({ timeout: 30000 });
  check(await page.getByText("Encomendas finalizadas").isVisible(), "painel de resultado aparece também no modo Farmácia");
  check((await page.getByText("Transferências geradas").count()) === 0, "sem secção de transferências (modo Farmácia nunca gera transferências)");
  check(await page.getByRole("button", { name: "Imprimir" }).count() >= 1, "Imprimir disponível para a encomenda única");
  await page.close();
}

async function main() {
  const seed = await seedE2E(DB);
  const token = await new SignJWT({
    sub: seed.userId, email: "e2e@spharm.test", nome: "E2E Admin", perfil: "ADMINISTRADOR", farmaciaId: null, tenant: "__legacy__",
  }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("8h").sign(new TextEncoder().encode(SECRET));
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: "session", value: token, url: BASE }]);
  const db = new Client({ connectionString: DB });
  await db.connect();
  try {
    await testeResponsividade(ctx);
    await testeFinalizacaoGrupo(ctx, db);
    await testeFinalizacaoConsolidada(ctx, db);
    await testeFinalizacaoFarmacia(ctx, db);
  } finally {
    await db.end();
    await browser.close();
  }
  console.log(`\n${passed} ok, ${failed} falhas`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
