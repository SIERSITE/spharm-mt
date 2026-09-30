/**
 * scripts/e2e/fornecedor-picker-browser.ts
 *
 * Ensaio de browser real (Chromium via Playwright) contra `next start`
 * local + PostgreSQL descartável para o novo picker pesquisável de
 * fornecedor (`components/ui/searchable-select.tsx`), usado em
 * `components/encomendas/order-detail-client.tsx` (linha a linha e no
 * controlo de definição em massa). Mesma disciplina de
 * `scripts/e2e/transferencias-manutencao-browser.ts` — nunca contra uma
 * base real.
 *
 * Âmbito deste ficheiro: só o picker em si, no ecrã de detalhe de uma
 * encomenda (`/encomendas/[id]`) — um rascunho real com muitas linhas e
 * uma lista real de 65 fornecedores. NÃO é o ensaio cruzado completo
 * (picker + manutenção em massa) — esse é uma ronda posterior, cobrindo
 * as duas áreas juntas.
 *
 *   docker run -d --name spharm-picker-e2e-pg -e POSTGRES_PASSWORD=test -p 55445:5432 postgres:16-alpine
 *   createdb -h localhost -p 55445 -U postgres spharm_e2e_picker
 *   DATABASE_URL=postgresql://postgres:test@localhost:55445/spharm_e2e_picker npx prisma migrate deploy
 *   npm run build
 *   E2E_DATABASE_URL=postgresql://postgres:test@localhost:55445/spharm_e2e_picker bash scripts/e2e/_start-server.sh &
 *   npx tsx scripts/e2e/fornecedor-picker-browser.ts
 */
import { chromium } from "playwright";
import { SignJWT } from "jose";
import { Client } from "pg";
import Module from "node:module";
import { seedE2E } from "./seed-e2e";

const DB = process.env.E2E_DATABASE_URL ?? "postgresql://postgres:test@localhost:55445/spharm_e2e_picker";
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3100";
const SECRET = process.env.E2E_AUTH_SECRET ?? "e2e-test-secret-e2e-test-secret-0123456789";
for (const u of [DB, BASE]) {
  const h = new URL(u).hostname;
  if (h !== "localhost" && h !== "127.0.0.1") { console.error(`RECUSADO: ${h} não é local.`); process.exit(2); }
}

// `lib/ingest/orders.ts` importa "server-only" — só interessa fora do
// runtime Next para lançar (no-op para Node normal). Mesmo truque de
// scripts/tests/test-*-db.ts e do e2e de transferências.
const M = Module as unknown as { _resolveFilename: (r: string, ...a: unknown[]) => string };
const resolverOriginal = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "server-only" ? __filename : resolverOriginal.call(this, request, ...rest);
};

/**
 * O botão colapsado do picker (`SearchableSelect`) recebe um `aria-label`
 * por linha (ex.: "Fornecedor de <designação>") para distinguir 300
 * botões visualmente iguais para leitores de ecrã — o que faz o `role`
 * "button" com `name` (o NOME ACESSÍVEL, que o aria-label sobrepõe ao
 * texto visível) deixar de servir para localizar pelo texto que aparece
 * no ecrã. `.filter({ hasText })` procura no TEXTO VISÍVEL em vez do
 * nome acessível — é o que este ensaio precisa aqui.
 */
function botaoComTexto(row: import("playwright").Locator, pattern: RegExp | string) {
  return row.locator("button").filter({ hasText: pattern });
}

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string, detalhe?: string) {
  if (cond) { passed++; console.log(`  [OK]    ${msg}`); }
  else { failed++; console.log(`  [FALHA] ${msg}${detalhe ? `\n            ${detalhe}` : ""}`); }
}

const N_LINHAS = 300;
const N_FORNECEDORES_GENERICOS = 60;
const NOMES_DISTINTOS = [
  "Distribuidora Central Lda",
  "Quifarma Distribuição",
  "Alliance Healthcare Portugal",
  "OCP Portugal",
  "Botica Central Unipessoal",
];

async function setup() {
  const seed = await seedE2E(DB);
  const { PrismaClient } = await import("../../generated/prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB }) });
  const { createEncomendaWithOutbox } = await import("../../lib/ingest/orders");

  // 65 fornecedores ATIVOS (60 genéricos + 5 distintos, para a pesquisa por nome).
  const genericos = Array.from({ length: N_FORNECEDORES_GENERICOS }, (_, i) => ({
    nomeNormalizado: `FORNECEDOR E2E ${String(i + 1).padStart(3, "0")}`,
    nome: `Fornecedor E2E ${String(i + 1).padStart(3, "0")}`,
  }));
  const distintos = NOMES_DISTINTOS.map((nome) => ({ nomeNormalizado: nome.toUpperCase(), nome }));
  await prisma.fornecedor.createMany({ data: [...genericos, ...distintos], skipDuplicates: true });
  const fornecedores = await prisma.fornecedor.findMany({ where: { estado: "ATIVO" }, select: { id: true, nome: true } });
  check(fornecedores.length >= 65, `setup: ${fornecedores.length} fornecedores ATIVOS criados (>= 65 pedido)`, String(fornecedores.length));

  const fornecedorDescontinuado = await prisma.fornecedor.upsert({
    where: { nomeNormalizado: "FORNECEDOR E2E DESCONTINUADO ZZZ" },
    update: { estado: "ATIVO" }, // repõe ATIVO — uma corrida anterior pode tê-lo deixado INATIVO
    create: { nomeNormalizado: "FORNECEDOR E2E DESCONTINUADO ZZZ", nome: "Fornecedor Descontinuado ZZZ" },
  });

  // N_LINHAS produtos próprios, só para este ensaio (nunca reutiliza os
  // 6 de seedE2E — precisamos de muitos mais para o cenário de 300 linhas).
  // Base variável (nunca fixa): este ensaio pode correr várias vezes
  // seguidas contra a MESMA base descartável sem a recriar — um `cnp`
  // fixo colidiria com a corrida anterior (Produto.cnp é único).
  const cnpBase = 6_100_000 + (Date.now() % 1_000_000);
  const dataProdutos = Array.from({ length: N_LINHAS }, (_, i) => ({ cnp: cnpBase + i, designacao: `Picker E2E Produto ${i + 1}` }));
  const produtos = await prisma.produto.createManyAndReturn({ data: dataProdutos });

  const farmaciaId = seed.farmaciaIds[0];
  const draft = await createEncomendaWithOutbox(prisma, "t", {
    farmaciaId,
    criadoPorId: seed.userId,
    nome: "E2E Fornecedor Picker",
    finalize: false,
    linhas: produtos.map((p) => ({ produtoId: p.id, quantidadeAjustada: 1, origem: "MANUAL" as const })),
  });

  // Linha #1 já nasce com um fornecedor DESCONTINUADO (INATIVO) — prova
  // que o picker mostra o nome actual mesmo quando esse fornecedor já
  // não está na lista visível (`fornecedores` da página, filtrada por
  // estado ATIVO em app/encomendas/[id]/page.tsx).
  // MESMA ordenação que `loadOrderDetail` usa para as linhas
  // (`orderBy: { id: "asc" }`, ver lib/encomendas/order-detail.ts) — para
  // "linhas[0]" aqui corresponder de facto à PRIMEIRA linha da tabela
  // visível no browser.
  const linhas = await prisma.linhaEncomenda.findMany({ where: { listaEncomendaId: draft.listaEncomendaId }, orderBy: { id: "asc" }, select: { id: true, produtoId: true } });
  await prisma.linhaEncomenda.update({ where: { id: linhas[0].id }, data: { fornecedorSugeridoId: fornecedorDescontinuado.id } });
  await prisma.fornecedor.update({ where: { id: fornecedorDescontinuado.id }, data: { estado: "INATIVO" } });

  await prisma.$disconnect();
  return { userId: seed.userId, listaEncomendaId: draft.listaEncomendaId, fornecedorDescontinuadoNome: fornecedorDescontinuado.nome! };
}

async function main() {
  const { userId, listaEncomendaId, fornecedorDescontinuadoNome } = await setup();

  const token = await new SignJWT({
    sub: userId, email: "e2e-picker@spharm.test", nome: "E2E Picker Admin", perfil: "ADMINISTRADOR", farmaciaId: null, tenant: "__legacy__",
  }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("8h").sign(new TextEncoder().encode(SECRET));

  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: "session", value: token, url: BASE }]);
  const db = new Client({ connectionString: DB });
  await db.connect();

  try {
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1600, height: 1000 });
    const tStart = Date.now();
    await page.goto(`${BASE}/encomendas/${listaEncomendaId}`, { waitUntil: "networkidle" });
    console.log(`  (carregamento inicial com ${N_LINHAS} linhas: ${Date.now() - tStart}ms)`);

    const linhas = page.locator("tbody tr");
    check((await linhas.count()) === N_LINHAS, `a tabela renderiza as ${N_LINHAS} linhas do rascunho`, String(await linhas.count()));

    // ── 1. Valor actual visível mesmo fora da lista (fornecedor INATIVO) ──
    console.log("\n1 · o picker mostra o fornecedor actual mesmo já não estando na lista (INATIVO)");
    const linha1 = linhas.nth(0);
    check(
      await botaoComTexto(linha1, new RegExp(fornecedorDescontinuadoNome)).isVisible(),
      "1: a linha 1 mostra 'Fornecedor Descontinuado ZZZ' mesmo estando INATIVO (fora da lista de opções)"
    );

    // ── 2. Pesquisa por nome estreita os resultados ──────────────────────
    console.log("\n2 · escrever filtra por nome, em memória");
    const linha2 = linhas.nth(1);
    await botaoComTexto(linha2, /Sem fornecedor/i).click();
    const combobox2 = page.getByRole("combobox").first();
    await combobox2.waitFor({ state: "visible", timeout: 5000 });
    await combobox2.fill("Distribuidora");
    const listbox2 = page.getByRole("listbox").first();
    await listbox2.waitFor({ state: "visible" });
    const opcoes2 = listbox2.getByRole("option");
    check(await opcoes2.count() === 1, "2a: pesquisar 'Distribuidora' devolve exactamente 1 opção", String(await opcoes2.count()));
    check(await opcoes2.first().innerText().then((t) => t.includes("Distribuidora Central Lda")), "2b: a única opção é 'Distribuidora Central Lda'");

    // ── 3. Enter selecciona a opção destacada ────────────────────────────
    console.log("\n3 · Enter selecciona a opção destacada");
    await page.keyboard.press("Enter");
    await listbox2.waitFor({ state: "hidden" }).catch(() => {});
    check(
      await botaoComTexto(linha2, /Distribuidora Central Lda/).isVisible(),
      "3: depois de Enter, a linha 2 mostra 'Distribuidora Central Lda' e o picker fecha"
    );

    // ── 4. Autosave — a selecção sobrevive a um refresh real ─────────────
    console.log("\n4 · a selecção é persistida via autosave e sobrevive a um refresh");
    await page.getByText(/Guardado às/).first().waitFor({ timeout: 10000 });
    await page.reload({ waitUntil: "networkidle" });
    const linha2Depois = page.locator("tbody tr").nth(1);
    check(
      await botaoComTexto(linha2Depois, /Distribuidora Central Lda/).isVisible(),
      "4: depois de recarregar a página, a linha 2 continua a mostrar 'Distribuidora Central Lda' (persistido no servidor, não só em memória)"
    );
    const dbLinha2 = await db.query(
      `SELECT f.nome FROM "LinhaEncomenda" le JOIN "Fornecedor" f ON f.id = le."fornecedorSugeridoId" WHERE le."listaEncomendaId" = $1 ORDER BY le.id ASC LIMIT 1 OFFSET 1`,
      [listaEncomendaId]
    );
    check(dbLinha2.rows[0]?.nome === "Distribuidora Central Lda", "4b: a BD real confirma fornecedorSugeridoId gravado (não é só um valor optimista no browser)", JSON.stringify(dbLinha2.rows[0]));

    // ── 5. Arrow keys + Enter numa lista não filtrada ────────────────────
    console.log("\n5 · ArrowDown/ArrowUp navegam, Enter selecciona a opção destacada");
    const linha3 = page.locator("tbody tr").nth(2);
    await botaoComTexto(linha3, /Sem fornecedor/i).click();
    const combobox3 = page.getByRole("combobox").first();
    await combobox3.waitFor({ state: "visible" });
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    const activeId = await combobox3.getAttribute("aria-activedescendant");
    check(!!activeId, "5a: aria-activedescendant aponta para uma opção depois de navegar com as setas");
    const opcaoDestacadaTexto = activeId ? await page.locator(`#${activeId}`).innerText() : null;
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    check(
      opcaoDestacadaTexto !== null && (await botaoComTexto(linha3, new RegExp(opcaoDestacadaTexto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).isVisible()),
      `5b: Enter selecciona EXACTAMENTE a opção destacada pelas setas ("${opcaoDestacadaTexto}")`
    );

    // ── 6. Limpar (✕) repõe "sem fornecedor" ─────────────────────────────
    console.log("\n6 · o botão limpar (✕) repõe a linha para 'sem fornecedor'");
    await linha3.getByRole("button", { name: "Limpar selecção" }).click();
    await page.waitForTimeout(200);
    check(await botaoComTexto(linha3, /Sem fornecedor/i).isVisible(), "6: depois de limpar, a linha 3 volta a mostrar '— Sem fornecedor —'");

    // ── 7. Escape fecha sem alterar a selecção ───────────────────────────
    console.log("\n7 · Escape fecha o dropdown SEM aplicar nenhuma selecção");
    const linha4 = page.locator("tbody tr").nth(3);
    await botaoComTexto(linha4, /Sem fornecedor/i).click();
    const combobox4 = page.getByRole("combobox").first();
    await combobox4.waitFor({ state: "visible" });
    await combobox4.fill("Quifarma");
    await page.getByRole("listbox").first().getByRole("option").first().waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    check(await page.getByRole("listbox").count() === 0, "7a: Escape fecha o dropdown (nenhum listbox aberto)");
    check(await botaoComTexto(linha4, /Sem fornecedor/i).isVisible(), "7b: a linha 4 continua '— Sem fornecedor —' — Escape não aplicou a pesquisa 'Quifarma'");

    // ── 8. Só um picker aberto de cada vez ────────────────────────────────
    console.log("\n8 · abrir um picker fecha automaticamente qualquer outro já aberto");
    const linha5 = page.locator("tbody tr").nth(4);
    // Longe o suficiente da linha 5 para NÃO estar coberta pela dropdown
    // dela (que, aberta, cobre visualmente as próximas linhas — o mesmo
    // que um `<select>` nativo faz) — o clique real do Playwright faz
    // scroll até à linha 50, o que naturalmente tira a linha 5 (e a sua
    // dropdown) do ecrã antes de clicar.
    const linhaLonge = page.locator("tbody tr").nth(49);
    await botaoComTexto(linha5, /Sem fornecedor/i).click();
    check(await page.getByRole("listbox").count() === 1, "8a: abrir a linha 5 mostra exactamente 1 listbox");
    await botaoComTexto(linhaLonge, /Sem fornecedor/i).click();
    check(await page.getByRole("listbox").count() === 1, "8b: abrir uma linha distante continua a mostrar exactamente 1 listbox — a da linha 5 fechou sozinha");
    check(await page.getByRole("combobox").count() === 1, "8c: só 1 combobox (input) activo em toda a página — as outras 298 linhas continuam colapsadas");
    await page.keyboard.press("Escape");

    // ── 9. 300 linhas colapsadas — sem lag visível a abrir uma perto do fim ──
    console.log("\n9 · picker continua responsivo com 300 linhas na tabela (colapsadas são baratas)");
    const linha250 = page.locator("tbody tr").nth(249);
    await linha250.scrollIntoViewIfNeeded();
    const tAbrir = Date.now();
    await botaoComTexto(linha250, /Sem fornecedor/i).click();
    await page.getByRole("combobox").first().waitFor({ state: "visible", timeout: 2000 });
    const dtAbrir = Date.now() - tAbrir;
    check(dtAbrir < 1500, `9a: abrir o picker da linha 250 (de 300) demorou ${dtAbrir}ms (< 1500ms — sem lag perceptível)`);
    await page.keyboard.press("Escape");

    // ── 10. ARIA básico ────────────────────────────────────────────────
    console.log("\n10 · padrão ARIA de combobox correcto");
    const linha7 = page.locator("tbody tr").nth(6);
    await botaoComTexto(linha7, /Sem fornecedor/i).click();
    const combobox7 = page.getByRole("combobox").first();
    await combobox7.waitFor({ state: "visible" });
    check((await combobox7.getAttribute("aria-expanded")) === "true", "10a: aria-expanded=true enquanto aberto");
    const ariaControls = await combobox7.getAttribute("aria-controls");
    check(!!ariaControls && (await page.locator(`#${ariaControls}`).getAttribute("role")) === "listbox", "10b: aria-controls aponta para um elemento role=listbox real");
    await page.keyboard.press("ArrowDown");
    const activeId7 = await combobox7.getAttribute("aria-activedescendant");
    check(!!activeId7 && (await page.locator(`#${activeId7}`).getAttribute("role")) === "option", "10c: aria-activedescendant aponta para um elemento role=option real, depois de ArrowDown");
    await page.keyboard.press("Escape");

    // ── 11. O controlo de definição em massa usa o MESMO componente ─────
    console.log("\n11 · 'Definir fornecedor nas linhas seleccionadas' (bulk) usa o mesmo picker pesquisável");
    await page.locator('input[aria-label="Seleccionar linha Picker E2E Produto 8"]').check();
    await page.locator('input[aria-label="Seleccionar linha Picker E2E Produto 9"]').check();
    const bulkCombo = page.getByRole("button", { name: "Fornecedor a definir nas linhas seleccionadas" });
    check(await bulkCombo.isVisible(), "11a: o controlo bulk usa o mesmo picker (mesmo aria-label do componente genérico)");
    await bulkCombo.click();
    const bulkInput = page.getByRole("combobox").first();
    await bulkInput.waitFor({ state: "visible" });
    await bulkInput.fill("OCP");
    await page.getByRole("listbox").first().getByRole("option").first().click();
    await page.getByRole("button", { name: "Definir fornecedor" }).click();
    await page.waitForTimeout(500);
    // Localizada pela checkbox EXACTA da linha (aria-label é uma
    // correspondência exacta de atributo) — nunca por texto do produto:
    // "Picker E2E Produto 8" é uma sub-string de "…80", "…81", etc.
    const linha8 = page.locator("tr").filter({ has: page.locator('input[aria-label="Seleccionar linha Picker E2E Produto 8"]') });
    check(await botaoComTexto(linha8, /OCP Portugal/).isVisible(), "11b: a definição em massa aplicou 'OCP Portugal' à linha seleccionada");

    await page.close();
  } finally {
    await db.end();
    await browser.close();
  }

  console.log(`\n${passed} ok, ${failed} falhas`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
