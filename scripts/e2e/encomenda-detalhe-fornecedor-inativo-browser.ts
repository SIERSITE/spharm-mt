/**
 * scripts/e2e/encomenda-detalhe-fornecedor-inativo-browser.ts
 *
 * Ensaio de browser real (Chromium via Playwright) contra `next start` local +
 * PostgreSQL descartável: o DETALHE da encomenda (`/encomendas/[id]`) perante um
 * fornecedor que entretanto ficou INATIVO.
 *
 *   E2E_DATABASE_URL=postgresql://postgres:test@localhost:55494/spharm_e2e_det npx tsx scripts/e2e/encomenda-detalhe-fornecedor-inativo-browser.ts
 *
 * Dados: um RASCUNHO com 6 linhas (4 → fornecedor «Delta», 2 → «Alfa») e uma encomenda
 * já FINALIZADA (documento antigo) com «Delta». Depois de semeado, «Delta» fica INATIVO.
 *
 *   1  o rascunho existente abre com a linha apontada ao fornecedor inativo
 *   2  nome histórico visível, com «(inativo)»
 *   3  aviso visível («Fornecedor inativo — selecione outro antes de finalizar») e linhas realçadas
 *   4  finalização bloqueada, com a lista das linhas a corrigir; nada gerado, nada trocado
 *   5  o inativo não aparece no picker da linha
 *   6  substituição de uma linha por um fornecedor ativo
 *   7  …gravada pelo autosave (BD)
 *   8  finalização bem-sucedida depois de substituídas todas
 *   9  a atribuição colectiva só oferece ativos (e nunca atribui um inativo)
 *   10 o documento antigo continua a mostrar o fornecedor original (sem alteração)
 */
import { chromium, type Browser, type Page } from "playwright";
import { SignJWT } from "jose";

const DB = process.env.E2E_DATABASE_URL ?? "postgresql://postgres:test@localhost:55494/spharm_e2e_det";
const PORT = process.env.E2E_PORT ?? "3100";
const SECRET = process.env.E2E_AUTH_SECRET ?? "e2e-test-secret-e2e-test-secret-0123456789";
{
  const h = new URL(DB).hostname;
  if (h !== "localhost" && h !== "127.0.0.1") { console.error(`RECUSADO: ${h} não é local.`); process.exit(2); }
}
process.env.DATABASE_URL = DB;
const BASE = `http://silveira.localhost:${PORT}`;

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string, detalhe?: string) {
  if (cond) { passed++; console.log(`  [OK]    ${msg}`); }
  else { failed++; console.log(`  [FALHA] ${msg}${detalhe ? `\n            ${detalhe}` : ""}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function esperarPor(cond: () => Promise<boolean>, ms = 20000): Promise<boolean> {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    if (await cond().catch(() => false)) return true;
    await sleep(250);
  }
  return false;
}

async function prismaE2E() {
  const { PrismaClient } = await import("../../generated/prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: DB }) });
}

const nomeP = (i: number) => `DET Produto ${i}`;
type Seed = { adminId: string; farmaciaId: string; alfa: string; delta: string; rascunhoId: string; antigaId: string };

async function seed(): Promise<Seed> {
  const prisma = await prismaE2E();
  try {
    const admin = await prisma.utilizador.create({ data: { email: "e2e-det@spharm.test", nome: "E2E Det", perfil: "ADMINISTRADOR" } });
    const f = await prisma.farmacia.create({ data: { nome: "DET Farmácia" } });
    const alfa = await prisma.fornecedor.create({ data: { nomeNormalizado: "DET ALFA", nome: "DET Fornecedor Alfa", estado: "ATIVO" } });
    const delta = await prisma.fornecedor.create({ data: { nomeNormalizado: "DET DELTA", nome: "DET Fornecedor Delta", estado: "ATIVO" } });
    const prods = [];
    for (let i = 1; i <= 6; i++) {
      const p = await prisma.produto.create({ data: { cnp: 7_600_000 + i, designacao: nomeP(i), estado: "VALIDADO" } });
      await prisma.produtoFarmacia.create({ data: { produtoId: p.id, farmaciaId: f.id, stockAtual: 1, stockMinimo: 5, stockMaximo: 20 } });
      prods.push(p);
    }
    const rascunho = await prisma.listaEncomenda.create({
      data: {
        farmaciaId: f.id, criadoPorId: admin.id, nome: "DET Rascunho", estado: "RASCUNHO",
        linhas: { create: prods.map((p, k) => ({ produtoId: p.id, quantidadeSugerida: 5, quantidadeAjustada: 5, origem: "PROPOSTA" as const, fornecedorSugeridoId: k < 4 ? delta.id : alfa.id })) },
      },
    });
    // documento ANTIGO (já finalizado) com o fornecedor Delta
    const antiga = await prisma.listaEncomenda.create({
      data: {
        farmaciaId: f.id, criadoPorId: admin.id, nome: "DET Documento antigo", estado: "FINALIZADA", numero: "EN-900001", estadoExport: "PENDENTE",
        linhas: { create: [{ produtoId: prods[0].id, quantidadeSugerida: 3, quantidadeAjustada: 3, origem: "PROPOSTA" as const, fornecedorSugeridoId: delta.id, designacaoSnapshot: nomeP(1) }] },
      },
    });
    // só agora o Delta fica INATIVO
    await prisma.fornecedor.update({ where: { id: delta.id }, data: { estado: "INATIVO" } });
    return { adminId: admin.id, farmaciaId: f.id, alfa: alfa.id, delta: delta.id, rascunhoId: rascunho.id, antigaId: antiga.id };
  } finally {
    await prisma.$disconnect();
  }
}

async function nova(browser: Browser, adminId: string): Promise<Page> {
  const token = await new SignJWT({ sub: adminId, email: "e2e-det@spharm.test", nome: "E2E Det", perfil: "ADMINISTRADOR", farmaciaId: null, tenant: "silveira" })
    .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("8h").sign(new TextEncoder().encode(SECRET));
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: "session", value: token, url: BASE }]);
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1700, height: 1200 });
  page.on("dialog", (d) => { d.accept().catch(() => {}); });
  return page;
}

async function fornecedoresDas(listaId: string): Promise<Record<string, string | null>> {
  const prisma = await prismaE2E();
  try {
    const ls = await prisma.linhaEncomenda.findMany({ where: { listaEncomendaId: listaId }, include: { produto: { select: { designacao: true } } } });
    return Object.fromEntries(ls.map((l) => [l.produto.designacao, l.fornecedorSugeridoId]));
  } finally {
    await prisma.$disconnect();
  }
}
const linha = (page: Page, i: number) => page.locator("tr").filter({ has: page.locator(`input[aria-label="Seleccionar linha ${nomeP(i)}"]`) });
async function abrirPicker(page: Page, i: number) {
  await page.getByRole("button", { name: `Fornecedor de ${nomeP(i)}` }).click();
  const combo = page.getByRole("combobox").first();
  await combo.waitFor({ state: "visible", timeout: 5000 });
  return combo;
}

async function main() {
  const s = await seed();
  const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP silveira.localhost [::1]"] });
  try {
    const page = await nova(browser, s.adminId);
    await page.goto(`${BASE}/encomendas/${s.rascunhoId}`, { waitUntil: "networkidle" });
    await page.getByText(nomeP(1)).first().waitFor({ timeout: 30000 });

    console.log("\n1-3 · encomenda existente com fornecedor que ficou inativo: nome histórico, «(inativo)», aviso e realce");
    const txt1 = (await linha(page, 1).innerText()).replace(/\s+/g, " ");
    check(/DET Fornecedor Delta \(inativo\)/.test(txt1), "1/2: a linha mostra o NOME histórico com «(inativo)»", txt1);
    check(/DET Fornecedor Alfa/.test((await linha(page, 5).innerText()).replace(/\s+/g, " ")) && !/inativo/i.test(await linha(page, 5).innerText()), "2: as linhas com fornecedor ativo (Alfa) não são assinaladas");
    check((await page.getByTestId("fornecedor-inativo-aviso").count()) === 4, "3: 4 linhas com o aviso «Fornecedor inativo — selecione outro antes de finalizar»");
    check((await page.getByTestId("fornecedor-inativo-aviso").first().innerText()).trim() === "Fornecedor inativo — selecione outro antes de finalizar", "3: texto exacto do aviso");
    check((await page.getByTestId("linha-fornecedor-inativo").count()) === 4, "3: as 4 linhas afectadas ficam realçadas");

    console.log("\n4 · finalização bloqueada, com a lista das linhas a corrigir");
    await page.getByRole("button", { name: /Finalizar e enviar para fila/ }).click();
    const erro = page.getByText(/fornecedor inativo/i).filter({ hasText: /Linhas a corrigir/ }).first();
    const apareceu = await erro.waitFor({ state: "visible", timeout: 20000 }).then(() => true).catch(() => false);
    check(apareceu, "4: a finalização é recusada com mensagem clara e «Linhas a corrigir: …»");
    const msg = apareceu ? (await erro.innerText()).replace(/\s+/g, " ") : "";
    check(/DET Produto [1-4]/.test(msg), "4: a mensagem identifica as linhas a corrigir (por designação)", msg);
    const prisma0 = await prismaE2E();
    try {
      const l = await prisma0.listaEncomenda.findUniqueOrThrow({ where: { id: s.rascunhoId } });
      check(l.estado === "RASCUNHO" && (await prisma0.listaEncomenda.count({ where: { loteOrigemId: s.rascunhoId } })) === 0, "4: continua RASCUNHO e nenhum documento foi gerado");
    } finally {
      await prisma0.$disconnect();
    }
    const antes = await fornecedoresDas(s.rascunhoId);
    check([1, 2, 3, 4].every((i) => antes[nomeP(i)] === s.delta), "4: nenhuma linha foi substituída automaticamente (continuam no Delta inativo)");

    console.log("\n5-7 · o inativo não é escolhível; substituição por um ativo, gravada pelo autosave");
    const combo = await abrirPicker(page, 1);
    await combo.fill("Delta");
    await sleep(300);
    check((await page.getByRole("listbox").first().getByRole("option").count()) === 0, "5: «Delta» (inativo) NÃO aparece no picker da linha");
    await combo.fill("Alfa");
    await page.getByRole("listbox").first().getByRole("option").first().click();
    await sleep(300);
    const txt1b = (await linha(page, 1).innerText()).replace(/\s+/g, " ");
    check(/DET Fornecedor Alfa/.test(txt1b) && !/inativo/i.test(txt1b), "6: a linha 1 passou a Alfa — sem «(inativo)» e sem aviso", txt1b);
    check((await page.getByTestId("fornecedor-inativo-aviso").count()) === 3, "6: restam 3 avisos");
    check(await esperarPor(async () => (await fornecedoresDas(s.rascunhoId))[nomeP(1)] === s.alfa), "7: o autosave gravou a substituição na BD");
    check((await fornecedoresDas(s.rascunhoId))[nomeP(2)] === s.delta, "7: as outras linhas continuam intactas até serem corrigidas");

    console.log("\n9 · atribuição colectiva só oferece ativos");
    for (const i of [2, 3, 4]) await page.locator(`input[aria-label="Seleccionar linha ${nomeP(i)}"]`).check();
    const bulk = page.getByRole("button", { name: "Fornecedor a definir nas linhas seleccionadas" });
    await bulk.click();
    const bulkCombo = page.getByRole("combobox").first();
    await bulkCombo.fill("Delta");
    await sleep(300);
    check((await page.getByRole("listbox").first().getByRole("option").count()) === 0, "9: o controlo colectivo NÃO oferece o fornecedor inativo");
    await bulkCombo.fill("Alfa");
    await page.getByRole("listbox").first().getByRole("option").first().click();
    await page.getByRole("button", { name: "Definir fornecedor" }).click();
    check(await esperarPor(async () => { const m = await fornecedoresDas(s.rascunhoId); return [1, 2, 3, 4, 5, 6].every((i) => m[nomeP(i)] === s.alfa); }), "9: a atribuição colectiva a Alfa (ativo) foi gravada em todas as linhas");
    check((await page.getByTestId("fornecedor-inativo-aviso").count()) === 0 && (await page.getByTestId("linha-fornecedor-inativo").count()) === 0, "9: já não há avisos nem linhas realçadas");

    console.log("\n8 · finalização bem-sucedida depois da substituição");
    await page.getByRole("button", { name: /Finalizar e enviar para fila/ }).click();
    const fim = await esperarPor(async () => {
      const p = await prismaE2E();
      try { return (await p.listaEncomenda.findUniqueOrThrow({ where: { id: s.rascunhoId } })).estado === "FINALIZADA"; } finally { await p.$disconnect(); }
    }, 30000);
    check(fim, "8: a encomenda finalizou (todas as linhas num fornecedor ativo)");

    console.log("\n10 · documento antigo: nome do fornecedor original preservado");
    await page.goto(`${BASE}/encomendas/${s.antigaId}`, { waitUntil: "networkidle" });
    await page.getByText(nomeP(1)).first().waitFor({ timeout: 30000 });
    const txtAntigo = (await page.locator("tr").filter({ hasText: nomeP(1) }).first().innerText()).replace(/\s+/g, " ");
    check(/DET Fornecedor Delta/.test(txtAntigo) && !/\(inativo\)/.test(txtAntigo), "10: o documento antigo mostra «DET Fornecedor Delta» tal como foi finalizado (sem «(inativo)», nada apagado)", txtAntigo);
    check((await page.getByTestId("fornecedor-inativo-aviso").count()) === 0, "10: um documento já finalizado não mostra avisos de substituição");
    const prisma = await prismaE2E();
    try {
      const l = await prisma.linhaEncomenda.findFirstOrThrow({ where: { listaEncomendaId: s.antigaId } });
      check(l.fornecedorSugeridoId === s.delta, "10: na BD o documento antigo continua ligado ao fornecedor original");
    } finally {
      await prisma.$disconnect();
    }
  } finally {
    await browser.close();
  }
  console.log(`\n${passed} ok, ${failed} falhas`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
