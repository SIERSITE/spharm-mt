/**
 * scripts/e2e/forma-listas-paginacao-browser.ts
 *
 * Browser REAL (Chromium) contra o build de PRODUÇÃO (control plane + PostgreSQL descartáveis, dados sintéticos): o filtro
 * «Forma farmacêutica» nas listas COM corte/paginação no servidor, com os produtos que correspondem SÓ depois do corte:
 *
 *   1 · Excessos ......... top-200 do servidor: com «Comprimido» aparecem as 3 linhas que sem filtro não chegam ao browser;
 *                          «Sem forma farmacêutica»; «Limpar filtros» + «Atualizar» repõe as 200
 *   2 · Transferências ... idem
 *   3 · Devoluções ....... dataset completo (sem corte): filtro/totais no cliente; «Sem forma»; «Limpar filtros»
 *   4 · Lista de Encomendas (/encomendas) ... paginação no servidor (25/página): as encomendas com a forma só existem na página 3;
 *                          o filtro (URL `forma` repetido) traz-as para a página 1, com total e nº de páginas correctos;
 *                          «Sem forma farmacêutica»; deep link; «Limpar filtros» repõe 59 encomendas / 3 páginas
 *
 * Dados: 230 produtos «cedo» (Xarope/Pomada/Solução oral) + 9 «tarde» (3 Comprimido em 3 grafias, 2 Comprimido revestido,
 * 2 Cápsula/CAPSULA, 2 sem forma). Janela 2026-01-01..2026-03-31. A lógica de negócio (somas exactas) está provada em
 * scripts/tests/test-forma-paginacao-server-db.ts; aqui prova-se a UI (pedido, chip, contagem, limpar).
 *
 * NÃO foi executado pelo autor (corre o coordenador no fim). Pré-requisito: `npx next build` com
 * SERVER_ACTIONS_ALLOWED_ORIGINS="localhost:3100,127.0.0.1:3100,*.localhost:3100".
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/e2e/forma-listas-paginacao-browser.ts
 *
 * Os seletores de Excessos/Transferências usam texto/placeholder/data-testid (`excessos-limpar-filtros`,
 * `transferencias-limpar-filtros`, `devolucoes-limpar-filtros`); se algum falhar por seletor (e não por comportamento),
 * ajustar aqui.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { baseFor, criarAmbiente } from "./_ambiente-silveira";
import { abrirContexto } from "./_grupo-comum";

let ok = 0;
let falhas = 0;
const check = (cond: boolean, msg: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${msg}`); }
  else { falhas++; console.log(`  [FALHA] ${msg}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const secao = (t: string) => console.log(`\n── ${t}`);
const EVID = path.resolve("docs/validacao-visual/2026-10-forma-listas-paginacao");
const PLACEHOLDER_FORMA = "Pesquisar forma farmacêutica...";
const cartaoForma = (page: Page) => page.getByPlaceholder(PLACEHOLDER_FORMA).first().locator("xpath=ancestor::div[contains(@class,'rounded-xl')][1]");
const opcao = (page: Page, rotulo: RegExp) => cartaoForma(page).getByRole("button", { name: rotulo });
const RE_COMP = /^Comprimido\s*\d/;
const RE_SEM = /^Sem forma farmacêutica/;
const chip = (page: Page, texto: string) => page.locator("span.rounded-full", { hasText: texto });
const textoPagina = (page: Page) => page.locator("main, body").first().innerText();
async function abrirFiltros(page: Page) {
  if ((await page.getByPlaceholder(PLACEHOLDER_FORMA).count()) === 0) await page.getByRole("button", { name: /^Filtros/ }).first().click();
  await page.getByPlaceholder(PLACEHOLDER_FORMA).first().waitFor({ timeout: 15000 });
}

const N_CEDO = 230;
const cnpCedo = (i: number) => 8_400_000 + i;
const cnpTarde = (k: number) => 8_450_000 + k;
const TARDE: Array<{ k: number; forma: string | null }> = [
  { k: 0, forma: "Comprimido" }, { k: 1, forma: " COMPRIMIDO " }, { k: 2, forma: "comprimido" },
  { k: 3, forma: "Comprimido revestido" }, { k: 4, forma: "COMPRIMIDO   REVESTIDO" },
  { k: 5, forma: "Cápsula" }, { k: 6, forma: "CAPSULA" }, { k: 7, forma: null }, { k: 8, forma: "   " },
];

async function main() {
  fs.mkdirSync(EVID, { recursive: true });
  const amb = await criarAmbiente("formapag");
  const browser = await chromium.launch();
  try {
    const prisma = amb.prisma;
    const user = await prisma.utilizador.create({ data: { email: "e2e-pag@spharm.test", nome: "E2E Pag", perfil: "ADMINISTRADOR" } });
    const f1 = await prisma.farmacia.create({ data: { nome: "Pag Farmacia Um" } });
    const f2 = await prisma.farmacia.create({ data: { nome: "Pag Farmacia Dois" } });
    const fab = await prisma.fabricante.create({ data: { nomeNormalizado: "PAG LAB" } });
    const forn = await prisma.fornecedor.create({ data: { nomeNormalizado: "PAG FORN", estado: "ATIVO" } });
    await prisma.produto.createMany({
      data: [
        ...Array.from({ length: N_CEDO }, (_, i) => ({ cnp: cnpCedo(i), designacao: `PAG cedo ${i}`, estado: "VALIDADO" as const, fabricanteId: fab.id, formaFarmaceutica: ["Xarope", "Pomada", "Solução oral"][i % 3] })),
        ...TARDE.map((t) => ({ cnp: cnpTarde(t.k), designacao: `PAG tarde ${t.k}`, estado: "VALIDADO" as const, fabricanteId: fab.id, formaFarmaceutica: t.forma })),
      ],
    });
    const prodId = new Map<number, string>();
    for (const p of await prisma.produto.findMany({ select: { id: true, cnp: true } })) prodId.set(Number(p.cnp), p.id);
    const pf = [];
    const vendas = [];
    for (const [cnp, produtoId] of prodId) {
      const cedo = cnp < 8_450_000;
      const idx = cedo ? cnp - 8_400_000 : cnp - 8_450_000;
      pf.push({ produtoId, farmaciaId: f1.id, pvp: 5, pmc: 4, puc: 2, stockAtual: cedo ? 500 + idx : 40 + 3 * idx, stockMinimo: 0, stockMaximo: 9999, fornecedorHabitualId: forn.id });
      pf.push({ produtoId, farmaciaId: f2.id, pvp: 5, pmc: 4, puc: 2, stockAtual: cedo ? 2 : 10, stockMinimo: 0, stockMaximo: 9999, fornecedorHabitualId: forn.id });
      vendas.push({ farmaciaId: f1.id, produtoId, ano: 2026, mes: 2, quantidade: 9, valorTotal: 45, valorBruto: 45, naturezaVenda: "NORMAL" as const });
      vendas.push({ farmaciaId: f2.id, produtoId, ano: 2026, mes: 2, quantidade: 90, valorTotal: 450, valorBruto: 450, naturezaVenda: "NORMAL" as const });
    }
    await prisma.produtoFarmacia.createMany({ data: pf });
    await prisma.vendaMensal.createMany({ data: vendas });
    // Devoluções: 291 «cedo» + 9 «tarde»
    const agora = Date.now();
    const dev = [];
    for (let i = 0; i < 291; i++) dev.push({ farmaciaId: f1.id, produtoId: prodId.get(cnpCedo(0))!, data: new Date(agora - i * 60_000), quantidade: 1, valor: 10, tipo: "FORNECEDOR" as const, motivo: "m", fornecedorDestinoId: forn.id });
    for (const t of TARDE) dev.push({ farmaciaId: f1.id, produtoId: prodId.get(cnpTarde(t.k))!, data: new Date(agora - (300 + t.k) * 60_000), quantidade: t.k + 1, valor: (t.k + 1) * 10, tipo: "FORNECEDOR" as const, motivo: "m", fornecedorDestinoId: forn.id });
    await prisma.devolucao.createMany({ data: dev });
    // Encomendas: 60 (a nº 4 ANULADA); as 9 mais antigas levam a linha «tarde»
    const base0 = Date.UTC(2026, 0, 1);
    for (let i = 0; i < 60; i++) {
      const produtos = i < 9 ? [prodId.get(cnpTarde(i))!, prodId.get(cnpCedo(i))!] : [prodId.get(cnpCedo(10 + (i % 50)))!];
      await prisma.listaEncomenda.create({
        data: {
          nome: `PAG Enc ${String(i).padStart(2, "0")}`, estado: i === 4 ? "ANULADA" : "FINALIZADA", farmaciaId: i % 2 === 0 ? f1.id : f2.id,
          criadoPorId: user.id, dataCriacao: new Date(base0 + i * 86_400_000),
          linhas: { create: produtos.map((produtoId) => ({ produtoId, quantidadeAjustada: 1 })) },
        },
      });
    }

    const ctx = await abrirContexto(amb, browser, { userId: user.id } as never);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => {
      if (/React error #418|Hydration failed|#418/.test(e.message)) console.log("  [AVISO conhecido] pageerror React #418 (hidratação do workspace; pré-existente)");
      else check(false, "pageerror inesperado", e.message);
    });
    await page.setViewportSize({ width: 1600, height: 900 });
    const base = baseFor("silveira");
    const tarde = (...ks: number[]) => ks.map((k) => String(cnpTarde(k)));
    const temAlgum = (txt: string, cnps: string[]) => cnps.some((c) => txt.includes(c));
    const temTodos = (txt: string, cnps: string[]) => cnps.every((c) => txt.includes(c));

    // ═══ 1 / 2 · Excessos e Transferências ═══
    for (const [titulo, rota, gerar, limpar] of [
      ["Excessos", "/excessos", /^(Gerar relatório|Atualizar)$/, "excessos-limpar-filtros"],
      ["Transferências", "/transferencias", /^(Gerar|Gerar relatório|Atualizar)$/, "transferencias-limpar-filtros"],
    ] as const) {
      secao(`${titulo[0] === "E" ? "1" : "2"} · ${titulo}`);
      await page.goto(base + rota, { waitUntil: "networkidle" });
      await page.getByLabel("Data início").fill("2026-01-01");
      await page.getByLabel("Data fim").fill("2026-03-31");
      await page.getByRole("button", { name: gerar }).first().click();
      await page.getByRole("button", { name: /^Atualizar$/ }).waitFor({ timeout: 90000 });
      let t = await textoPagina(page);
      check(!temAlgum(t, tarde(0, 1, 2, 3, 4, 5, 6, 7, 8)), `${titulo}: sem filtro, nenhum dos 9 artigos «tarde» chega ao browser (corte de 200 do servidor)`);

      await abrirFiltros(page);
      await opcao(page, RE_COMP).click();
      check((await chip(page, "Forma: Comprimido").count()) >= 1, `${titulo}: chip «Forma: Comprimido»`);
      await page.getByRole("button", { name: /^Atualizar$/ }).click();
      await page.getByRole("button", { name: /^Atualizar$/ }).waitFor({ timeout: 90000 });
      await page.waitForTimeout(800);
      t = await textoPagina(page);
      check(temTodos(t, tarde(0, 1, 2)) && !temAlgum(t, tarde(3, 4, 5, 6, 7, 8)), `${titulo}: com «Comprimido» aparecem as 3 linhas (3 grafias) e mais nenhuma tarde — pedido ao servidor`);
      if (titulo === "Excessos") check(/\b3\s+excessos/.test(t.replace(/\s+/g, " ")), "Excessos: o contador do cabeçalho diz «3 excessos»");
      await page.screenshot({ path: path.join(EVID, `${titulo.toLowerCase()}-comprimido.png`) });

      await opcao(page, RE_COMP).click();
      await opcao(page, RE_SEM).click();
      await page.getByRole("button", { name: /^Atualizar$/ }).click();
      await page.getByRole("button", { name: /^Atualizar$/ }).waitFor({ timeout: 90000 });
      await page.waitForTimeout(800);
      t = await textoPagina(page);
      check(temTodos(t, tarde(7, 8)) && !temAlgum(t, tarde(0, 1, 2, 3, 4, 5, 6)), `${titulo}: «Sem forma farmacêutica» devolve só as 2 linhas sem forma (nulo e espaços)`);

      await page.getByTestId(limpar).click();
      check((await chip(page, "Forma:").count()) === 0, `${titulo}: «Limpar filtros» remove o chip da forma`);
      await page.getByRole("button", { name: /^Atualizar$/ }).click();
      await page.getByRole("button", { name: /^Atualizar$/ }).waitFor({ timeout: 90000 });
      await page.waitForTimeout(800);
      t = await textoPagina(page);
      check(!temAlgum(t, tarde(0, 1, 2, 3, 4, 5, 6, 7, 8)), `${titulo}: depois de «Limpar filtros» + «Atualizar» volta ao conjunto inicial (200 linhas, sem as tardias)`);
      if (titulo === "Excessos") check(/\b200\s+excessos/.test(t.replace(/\s+/g, " ")), "Excessos: …e o contador volta a «200 excessos»");
    }

    // ═══ 3 · Devoluções ═══
    secao("3 · Devoluções");
    await page.goto(base + "/devolucoes", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /^Gerar$/ }).click();
    await page.getByRole("button", { name: /^Atualizar$/ }).waitFor({ timeout: 60000 });
    await abrirFiltros(page).catch(() => undefined);
    await opcao(page, RE_COMP).click();
    let td = await textoPagina(page);
    check(temTodos(td, tarde(0, 1, 2)) && !temAlgum(td, tarde(3, 4, 5, 6, 7, 8)), "Devoluções: «Comprimido» mostra as 3 linhas (o dataset completo está no browser)");
    check(/Linhas\s*3\b/i.test(td.replace(/\s+/g, " ")), "…e as linhas/totais reflectem o filtro (3 linhas)");
    await opcao(page, RE_COMP).click();
    await opcao(page, RE_SEM).click();
    td = await textoPagina(page);
    check(temTodos(td, tarde(7, 8)) && !temAlgum(td, tarde(0, 1, 2, 3, 4, 5, 6)), "Devoluções: «Sem forma farmacêutica» devolve só as 2 sem forma");
    await page.getByTestId("devolucoes-limpar-filtros").click();
    check((await chip(page, "Forma:").count()) === 0, "Devoluções: «Limpar filtros» limpa a forma");
    td = await textoPagina(page);
    check(/Linhas\s*300\b/i.test(td.replace(/\s+/g, " ")), "…e voltam as 300 linhas");
    await page.screenshot({ path: path.join(EVID, "devolucoes.png") });

    // ═══ 4 · Lista de Encomendas ═══
    secao("4 · Lista de Encomendas (/encomendas, paginação no servidor)");
    await page.goto(base + "/encomendas", { waitUntil: "networkidle" });
    let te = (await textoPagina(page)).replace(/\s+/g, " ");
    check(/1–25 de 59 encomendas/.test(te), "sem filtro: «1–25 de 59 encomendas»");
    check(!/PAG Enc 0[0-3]\b/.test(te) && !/PAG Enc 0[5-8]\b/.test(te), "página 1 não tem as encomendas com as formas (só existem na página 3)");
    await abrirFiltros(page).catch(() => undefined);
    await opcao(page, RE_COMP).click();
    await page.waitForURL(/forma=comprimido/);
    await page.waitForLoadState("networkidle");
    te = (await textoPagina(page)).replace(/\s+/g, " ");
    check(/1–3 de 3 encomendas/.test(te) && /PAG Enc 00/.test(te) && /PAG Enc 01/.test(te) && /PAG Enc 02/.test(te), "«Comprimido»: «1–3 de 3 encomendas» — as 3 que estavam na página 3, agora na 1");
    check((await chip(page, "Forma: Comprimido").count()) >= 1, "chip da forma");
    await page.screenshot({ path: path.join(EVID, "encomendas-lista-comprimido.png") });
    await opcao(page, RE_COMP).click();
    await opcao(page, RE_SEM).click();
    await page.waitForURL(/forma=__sem_forma__/);
    await page.waitForLoadState("networkidle");
    te = (await textoPagina(page)).replace(/\s+/g, " ");
    check(/1–2 de 2 encomendas/.test(te) && /PAG Enc 07/.test(te) && /PAG Enc 08/.test(te), "«Sem forma farmacêutica»: 2 encomendas (Enc 07 e 08)");
    await page.goto(base + "/encomendas?forma=comprimido&forma=capsula&forma=__sem_forma__", { waitUntil: "networkidle" });
    te = (await textoPagina(page)).replace(/\s+/g, " ");
    check(/1–7 de 7 encomendas/.test(te), "deep link com 3 formas (parâmetro repetido) = união: 7 encomendas");
    await page.getByRole("button", { name: "Limpar filtros" }).click();
    await page.waitForFunction(() => !location.search.includes("forma="));
    await page.waitForLoadState("networkidle");
    te = (await textoPagina(page)).replace(/\s+/g, " ");
    check(/1–25 de 59 encomendas/.test(te), "«Limpar filtros» remove `forma` do URL e repõe «1–25 de 59 encomendas»");
  } finally {
    await browser.close();
    await amb.parar();
  }
  console.log(`\n${falhas === 0 ? "PASSOU" : "FALHOU"} — ${ok} OK, ${falhas} falhas\n`);
  process.exit(falhas === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
