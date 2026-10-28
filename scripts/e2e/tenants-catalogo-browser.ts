/**
 * scripts/e2e/tenants-catalogo-browser.ts
 *
 * Browser REAL contra o build de PRODUÇÃO (control plane + PostgreSQL descartáveis, dados sintéticos), UM ambiente por tenant
 * (`garantia`, `silveira`, `sier`): prova o isolamento por tenant das funcionalidades novas.
 *   · /catalogo/manutencao: garantia e silveira abrem; sier → 404 (gate no servidor);
 *   · filtro de fabricante dos mapas: garantia mostra UMA opção «ALFASIGMA (10 variantes)»; silveira e sier mostram as 10 variantes à parte;
 *   · ficha do artigo e Catálogo: classificação ERP (Ético/NETT/Serviço/Genérico) e filtro `cls`, em todos os tenants;
 *   · filtro de forma farmacêutica no Catálogo em todos os tenants.
 *
 * Pré-requisito: `npx next build` com SERVER_ACTIONS_ALLOWED_ORIGINS="localhost:3100,127.0.0.1:3100,*.localhost:3100".
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/e2e/tenants-catalogo-browser.ts
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { baseFor, criarAmbiente } from "./_ambiente-silveira";
import { abrirContexto } from "./_grupo-comum";
import { semearMargens } from "./_margens-comum";

let ok = 0, falhas = 0;
const check = (cond: boolean, msg: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${msg}`); } else { falhas++; console.log(`  [FALHA] ${msg}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const EVID = path.resolve("docs/validacao-visual/2026-10-garantia-catalogo-classificacao-margens");
const CNP_CLASS = 7900001;

async function tenant(slug: "garantia" | "silveira" | "sier") {
  console.log(`\n── tenant ${slug}`);
  const amb = await criarAmbiente(`tn${slug.slice(0, 2)}`, { E2E_TENANT_SLUG: slug });
  const browser = await chromium.launch();
  try {
    const seed = await semearMargens(amb);
    const prisma = amb.prisma;
    // 10 variantes do mesmo fabricante, com prova de grupo (só são agrupadas em garantia) + 1 fabricante SEM prova
    const grupo = await prisma.grupoLaboratorial.create({ data: { nome: "ALFASIGMA", nomeNormalizado: "ALFASIGMA" } });
    for (let i = 1; i <= 10; i++) {
      const f = await prisma.fabricante.create({ data: { nomeNormalizado: `ALFASIGMA VARIANTE ${String(i).padStart(2, "0")}` } });
      await prisma.grupoLaboratorialFabricante.create({ data: { grupoLaboratorialId: grupo.id, fabricanteId: f.id, tipoAssociacao: "INEQUIVOCA", validadoManualmente: true } });
      const p = await prisma.produto.create({ data: { cnp: 7800000 + i, designacao: `ALFA PRODUTO ${i}`, fabricanteId: f.id, estado: "VALIDADO", formaFarmaceutica: i % 2 ? "Comprimido" : " COMPRIMIDO " } });
      await prisma.produtoGrupoLaboratorial.create({ data: { produtoId: p.id, grupoLaboratorialId: grupo.id, origem: "FABRICANTE_INEQUIVOCO" } });
      await prisma.produtoFarmacia.create({ data: { produtoId: p.id, farmaciaId: seed.farmacias.alfa, pvp: 5, pmc: 2, stockAtual: 3, taxaIvaPercent: 23 } });
    }
    const fSemProva = await prisma.fabricante.create({ data: { nomeNormalizado: "ALFA WASSERMAN PARECIDO" } });
    const pSem = await prisma.produto.create({ data: { cnp: 7800099, designacao: "ALFA SEM PROVA", fabricanteId: fSemProva.id, estado: "VALIDADO" } });
    await prisma.produtoFarmacia.create({ data: { produtoId: pSem.id, farmaciaId: seed.farmacias.alfa, pvp: 5, pmc: 2, stockAtual: 1, taxaIvaPercent: 23 } });
    // classificação ERP sintética
    const fabE = await prisma.fabricante.findFirstOrThrow({ where: { nomeNormalizado: "LAB E2E" } });
    await prisma.produto.create({ data: { cnp: CNP_CLASS, designacao: "PRODUTO CLASSIFICADO ETICO GENERICO", fabricanteId: fabE.id, estado: "VALIDADO", erpEtico: true, erpNett: false, erpServico: false, genericoErp: true, classificacaoErpEm: new Date(), classificacaoErpOrigem: "e2e" } });
    await prisma.produto.create({ data: { cnp: CNP_CLASS + 1, designacao: "PRODUTO NETT NAO GENERICO", fabricanteId: fabE.id, estado: "VALIDADO", erpEtico: false, erpNett: true, erpServico: false, genericoErp: false, classificacaoErpEm: new Date(), classificacaoErpOrigem: "e2e" } });

    const ctx = await abrirContexto(amb, browser, { userId: seed.userId } as never);
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1920, height: 1080 });
    const base = baseFor(slug);

    // 1 · manutenção do catálogo
    const r = await page.goto(base + "/catalogo/manutencao", { waitUntil: "networkidle" });
    const deve = slug !== "sier";
    check(deve ? r?.status() === 200 : r?.status() === 404, `${slug}: /catalogo/manutencao → ${deve ? "200 (ativa)" : "404 (recusada no servidor)"} (obtido ${r?.status()})`);
    if (deve) check((await page.getByText(/Manutenção do catálogo/i).count()) > 0, `${slug}: a página de manutenção mostra o título`);
    await page.screenshot({ path: path.join(EVID, `${slug}-manutencao-catalogo.png`) });
    await page.goto(base + "/stock", { waitUntil: "networkidle" });
    const menu = await page.getByRole("link", { name: /Manutenção do catálogo/ }).count();
    check(deve ? menu > 0 : menu === 0, `${slug}: menu «Manutenção do catálogo» ${deve ? "visível" : "AUSENTE"}`);

    // 2 · filtro de fabricante agrupado (só garantia)
    await page.goto(base + "/relatorios/margens", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /Filtros/ }).first().click();
    if (slug === "garantia") {
      const campo = page.getByPlaceholder("Pesquisar laboratório, grupo ou variante...");
      await campo.waitFor({ timeout: 20000 });
      const cartao = campo.locator("xpath=ancestor::div[contains(@class,'rounded-xl')][1]");
      await campo.fill("alfasigma");
      const texto = await cartao.innerText();
      check(/ALFASIGMA\s*\(10 variantes\)/i.test(texto), "garantia: UMA opção «ALFASIGMA (10 variantes)»", texto.slice(0, 200));
      await campo.fill("variante 07");
      check(/ALFASIGMA/i.test(await cartao.innerText()), "garantia: pesquisar por uma variante encontra o grupo");
      await campo.fill("wasserman");
      const t3 = await cartao.innerText();
      check(/WASSERMAN PARECIDO/i.test(t3) && !/\(10 variantes\)/.test(t3), "garantia: fabricante sem prova de grupo permanece separado");
      await campo.fill("alfasigma");
      await page.screenshot({ path: path.join(EVID, "garantia-filtro-fabricante-agrupado.png") });
    } else {
      const campo = page.getByPlaceholder("Pesquisar fabricante...");
      await campo.waitFor({ timeout: 20000 });
      await campo.fill("alfasigma variante");
      const texto = await campo.locator("xpath=ancestor::div[contains(@class,'rounded-xl')][1]").innerText();
      check((texto.match(/ALFASIGMA VARIANTE \d\d/gi) ?? []).length >= 10 && !/variantes\)/.test(texto), `${slug}: as 10 variantes continuam separadas (comportamento inalterado)`);
      await page.screenshot({ path: path.join(EVID, `${slug}-filtro-fabricante-inalterado.png`) });
    }

    // 3 · classificação ERP: ficha + filtros do Catálogo (todos os tenants)
    await page.goto(base + `/catalogo/artigo/${CNP_CLASS}`, { waitUntil: "networkidle" });
    const ficha = await page.locator("body").innerText();
    check(/Ético/i.test(ficha) && /NETT/i.test(ficha) && /Serviço/i.test(ficha) && /Genérico/i.test(ficha), `${slug}: ficha mostra Ético / NETT / Serviço / Genérico`);
    await page.screenshot({ path: path.join(EVID, `${slug}-ficha-classificacao.png`) });
    await page.goto(base + "/catalogo?cls=etico&q=PRODUTO", { waitUntil: "networkidle" });
    let corpo = await page.locator("body").innerText();
    check(/PRODUTO CLASSIFICADO ETICO/.test(corpo) && !/PRODUTO NETT NAO GENERICO/.test(corpo), `${slug}: filtro Ético do Catálogo`);
    await page.screenshot({ path: path.join(EVID, `${slug}-catalogo-filtro-etico.png`) });
    await page.goto(base + "/catalogo?cls=nao_generico&q=PRODUTO", { waitUntil: "networkidle" });
    corpo = await page.locator("body").innerText();
    check(/PRODUTO NETT NAO GENERICO/.test(corpo) && !/PRODUTO CLASSIFICADO ETICO/.test(corpo), `${slug}: filtro Não genérico do Catálogo`);

    // 4 · forma farmacêutica no Catálogo: «Comprimido» e « COMPRIMIDO » são UMA opção (10 produtos)
    await page.goto(base + "/catalogo?forma=comprimido", { waitUntil: "networkidle" });
    corpo = await page.locator("body").innerText();
    check((corpo.match(/ALFA PRODUTO \d+/g) ?? []).length >= 10 && !/ALFA SEM PROVA/.test(corpo), `${slug}: filtro de forma farmacêutica no Catálogo junta Comprimido/COMPRIMIDO`);
    await page.screenshot({ path: path.join(EVID, `${slug}-catalogo-filtro-forma.png`) });
  } finally {
    await browser.close();
    await amb.parar();
  }
}

async function main() {
  fs.mkdirSync(EVID, { recursive: true });
  for (const s of ["garantia", "silveira", "sier"] as const) await tenant(s);
  console.log(`\n${falhas === 0 ? "PASSOU" : "FALHOU"} — ${ok} OK, ${falhas} falhas\n`);
  process.exit(falhas === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
