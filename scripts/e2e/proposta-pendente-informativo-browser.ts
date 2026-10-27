/**
 * scripts/e2e/proposta-pendente-informativo-browser.ts
 *
 * Browser REAL contra o build de PRODUÇÃO (control plane + PostgreSQL descartáveis, dados sintéticos): a proposta de encomenda NÃO
 * deduz outras encomendas; «Pendente» é só informativo.
 *   · proposta de FARMÁCIA e de GRUPO: sugestões lidas no ecrã ANTES de existirem encomendas e DEPOIS de criar encomendas
 *     (finalizadas por exportar, em exportação, uma enorme — que antes punha o artigo em «Aguardar» —, uma exportada e um rascunho)
 *     — têm de ser IGUAIS; nenhum artigo fica em «Aguardar»; o filtro de estado/cartões não têm «Aguardar»;
 *   · «Pendente» visível, em itálico, com o tooltip «Informativo: existem X unidades noutras encomendas. Este valor não interfere na
 *     sugestão atual.»; expansível, com as encomendas (soma = coluna) e ligação para as abrir;
 *   · a quantidade final continua editável; mudar de separador preserva a proposta e a edição;
 *   · finalização do grupo e Excel da encomenda com as quantidades a encomendar (sem dedução).
 *
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/e2e/proposta-pendente-informativo-browser.ts
 */
import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { chromium, type Page } from "playwright";
import { baseFor, criarAmbiente } from "./_ambiente-silveira";
import { abrirContexto, abrirModalEEscolher, semear } from "./_grupo-comum";

let ok = 0;
let falhas = 0;
const check = (cond: boolean, msg: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${msg}`); }
  else { falhas++; console.log(`  [FALHA] ${msg}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const secao = (t: string) => console.log(`\n── ${t}`);
const EVID = path.resolve("docs/validacao-visual/2026-10-proposta-pendente-informativo");
const TOOLTIP = (n: number) => `Informativo: existem ${n} unidades noutras encomendas. Este valor não interfere na sugestão atual.`;

type Linha = { idx: number; cnp: number; farmacia: string; sugerida: string; pendente: string; final: string; motivo: string };

/** Lê a tabela da proposta por cabeçalhos. No modo Grupo cada artigo tem uma linha-cabeçalho (CNP) e uma linha por farmácia. */
async function lerTabela(page: Page): Promise<Linha[]> {
  return page.evaluate(`(() => {
    const t = document.querySelector('[data-testid="tabela-proposta"]');
    const ths = [...t.querySelectorAll('thead th')].map((x) => (x.textContent || '').trim().toLowerCase());
    const idx = (nome) => ths.findIndex((h) => h.startsWith(nome));
    const iSug = idx('sugerida'), iPend = idx('pendente'), iMot = ths.findIndex((h) => h.startsWith('notas')), iFarm = idx('farmácia'), iFinal = idx('final');
    let cnpAtual = 0;
    const out = [];
    [...t.querySelectorAll('tbody tr')].forEach((tr, i) => {
      const tds = [...tr.querySelectorAll(':scope > td')];
      const mono = tr.querySelector('.font-mono');
      if (mono) { const m = (mono.textContent || '').match(/CNP *([0-9]+)/); if (m) cnpAtual = Number(m[1]); }
      const iEst = idx('estado');
      if (tds.length < 10 || iPend < 0 || !tds[iPend] || iEst < 0 || !tds[iEst] || !/^(Comprar|Transfer|Adequad)/i.test((tds[iEst].textContent || '').trim())) return;
      const celFinal = iFinal >= 0 ? tds[iFinal] : null;
      const input = celFinal ? celFinal.querySelector('input') : null;
      out.push({
        idx: i, cnp: cnpAtual,
        farmacia: iFarm >= 0 && tds[iFarm] ? (tds[iFarm].textContent || '').trim() : '',
        sugerida: (tds[iSug].textContent || '').trim(),
        pendente: ((tds[iPend].querySelector('[data-testid="pendente-valor"]') || tds[iPend]).textContent || '').trim(),
        final: input ? input.value : '',
        motivo: iMot >= 0 && tds[iMot] ? (tds[iMot].textContent || '').trim() : '',
      });
    });
    return out;
  })()`) as Promise<Linha[]>;
}
const linhaDe = (page: Page, l: Linha) => page.locator('[data-testid="tabela-proposta"] tbody tr').nth(l.idx);

async function main() {
  fs.mkdirSync(EVID, { recursive: true });
  const amb = await criarAmbiente("pd");
  const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP silveira.localhost [::1]"] });
  try {
    const seed = await semear(amb, { multiFornecedor: true });
    const ctx = await abrirContexto(amb, browser, seed);
    const page = await ctx.newPage();
    page.on("dialog", (d) => d.accept());
    page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
    await page.setViewportSize({ width: 1700, height: 950 });
    const prisma = amb.prisma;
    const [alfa, beta, gama] = seed.farmaciaIds;
    const cnpDe = (i: number) => 5000100 + i;

    // ═══ 0 · ANTES: nenhuma encomenda ═══════════════════════════════════════════════════════════════════════════════════
    secao("0 · Sem encomendas anteriores (referência)");
    await page.goto(baseFor("silveira") + "/encomendas/nova", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Grupo", exact: true }).first().click();
    await page.getByRole("button", { name: /Gerar (nova )?proposta/ }).click();
    await page.getByText("ARTIGO E2E 6").first().waitFor({ state: "attached", timeout: 30000 });
    const grupoAntes = await lerTabela(page);
    const chave = (l: Linha) => `${l.cnp}|${l.farmacia}`;
    const sugAntes = new Map(grupoAntes.map((l) => [chave(l), l.sugerida]));
    check(grupoAntes.length >= 6 && grupoAntes.every((l) => l.pendente === "0" || l.pendente === "—"), `grupo: ${grupoAntes.length} linhas, «Pendente» a 0`);
    check(grupoAntes.some((l) => Number(l.sugerida) > 0), "há quantidades sugeridas > 0 (vendas e stock insuficiente)");

    // ═══ encomendas anteriores ══════════════════════════════════════════════════════════════════════════════════════════
    secao("Encomendas anteriores criadas na base descartável");
    const forn = await prisma.fornecedor.findFirstOrThrow({ where: { nomeNormalizado: "E2E FORN A" } });
    const fornB = await prisma.fornecedor.findFirstOrThrow({ where: { nomeNormalizado: "E2E FORN B" } });
    const prod = async (i: number) => (await prisma.produto.findUniqueOrThrow({ where: { cnp: cnpDe(i) } })).id;
    const lista = async (farmaciaId: string, nome: string, estado: "RASCUNHO" | "FINALIZADA" | "EXPORTADA", estadoExport: "PENDENTE" | "EM_EXPORTACAO" | "EXPORTADO", linhas: Array<[number, number, string]>) =>
      prisma.listaEncomenda.create({
        data: { farmaciaId, nome, estado, estadoExport, criadoPorId: seed.userId, numero: `E2E-${nome}`.slice(0, 20), linhas: { create: await Promise.all(linhas.map(async ([i, q, f]) => ({ produtoId: await prod(i), quantidadeAjustada: q, fornecedorSugeridoId: f, origem: "MANUAL" as const }))) } },
      });
    const L1 = await lista(alfa, "A-pend", "FINALIZADA", "PENDENTE", [[3, 50, forn.id], [5, 100000, forn.id]]);
    const L2 = await lista(alfa, "A-exp", "FINALIZADA", "EM_EXPORTACAO", [[3, 25, fornB.id], [4, 30, fornB.id]]);
    await lista(alfa, "A-feita", "EXPORTADA", "EXPORTADO", [[6, 40, forn.id]]);
    await lista(alfa, "A-rasc", "RASCUNHO", "PENDENTE", [[6, 777, forn.id]]);
    await lista(beta, "B-pend", "FINALIZADA", "PENDENTE", [[3, 9000, forn.id]]);
    await lista(gama, "G-pend", "FINALIZADA", "PENDENTE", [[5, 8000, forn.id]]);
    check(true, "criadas: A (finalizada 50+100000, em exportação 25+30, exportada 40, rascunho 777), B (9000), G (8000)");

    // ═══ 1 · GRUPO depois ═══════════════════════════════════════════════════════════════════════════════════════════════
    secao("1 · Proposta de GRUPO com encomendas existentes");
    await page.getByRole("button", { name: /Gerar (nova )?proposta/ }).click();
    await page.waitForTimeout(2500);
    await page.getByText("ARTIGO E2E 6").first().waitFor({ state: "attached", timeout: 30000 });
    const grupoDepois = await lerTabela(page);
    await page.screenshot({ path: path.join(EVID, "grupo-com-pendentes.png"), fullPage: true });
    const diferentes = grupoDepois.filter((l) => sugAntes.get(chave(l)) !== l.sugerida);
    check(grupoDepois.length === grupoAntes.length && diferentes.length === 0, `todas as ${grupoDepois.length} quantidades sugeridas IGUAIS às de antes das encomendas`, JSON.stringify(diferentes.slice(0, 3)));
    const l5alfa = grupoDepois.find((l) => l.cnp === cnpDe(5) && l.farmacia === "Farmacia Alfa");
    check(!!l5alfa && l5alfa.pendente === "100000" && Number(l5alfa.sugerida) > 0, `artigo com 100000 noutras encomendas (antes: Aguardar/0): «Pendente» 100000 e sugere ${l5alfa?.sugerida}`);
    check(grupoDepois.find((l) => l.cnp === cnpDe(3) && l.farmacia === "Farmacia Alfa")?.pendente === "75", "Alfa/artigo 3: Pendente = 50 + 25 = 75");
    check(grupoDepois.find((l) => l.cnp === cnpDe(6) && l.farmacia === "Farmacia Alfa")?.pendente === "0", "a exportada (40) e o rascunho (777) não aparecem no Pendente");
    const texto = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    check(!/Aguardar/i.test(texto) && !/cobre a necessidade/i.test(texto) && !/Encomenda pendente/i.test(texto), "nenhuma referência a «Aguardar», «cobre a necessidade» ou «Encomenda pendente» no ecrã");
    const cartoes = (await page.locator("button", { hasText: /A comprar|Transferência|Adequado/ }).allInnerTexts()).map((t) => t.replace(/\s+/g, " "));
    check(cartoes.length >= 3 && !cartoes.some((c) => /Aguardar/i.test(c)), `cartões de resumo sem «Aguardar» (${cartoes.join(" | ")})`);
    check(l5alfa!.motivo.includes("Informativo: 100000 unidades já constam de outras encomendas; não foram consideradas no cálculo desta proposta."), "o motivo diz, explicitamente, que o valor é informativo e não foi considerado");

    // coluna «Pendente» informativa
    secao("2 · Coluna «Pendente»: informativa, com tooltip e detalhe");
    const linha5 = linhaDe(page, l5alfa!);
    const valor = linha5.locator('[data-testid="pendente-valor"]');
    check((await valor.getAttribute("title")) === TOOLTIP(100000), "o tooltip é exatamente «Informativo: existem 100000 unidades noutras encomendas. Este valor não interfere na sugestão atual.»");
    check(/italic/.test((await valor.getAttribute("class")) ?? ""), "o valor aparece em itálico/cinzento (identificado como informação)");
    check(/Informativo/.test((await page.locator('[data-testid="tabela-proposta"] thead th', { hasText: "Pendente" }).first().getAttribute("title")) ?? ""), "o cabeçalho «Pendente» tem o tooltip informativo");
    await valor.click();
    await linha5.locator('[data-testid="pendente-detalhe"]').waitFor();
    const itens = await linha5.locator('[data-testid="pendente-encomenda"]').allInnerTexts();
    check(itens.length === 1 && /E2E-A-pend/.test(itens[0]) && /por exportar/.test(itens[0]), `o detalhe lista a encomenda (${itens.join(" | ").replace(/\s+/g, " ")})`);
    const href = await linha5.locator('[data-testid="pendente-encomenda"] a').first().getAttribute("href");
    check(href === `/encomendas/${L1.id}`, `ligação para abrir a encomenda (${href})`);
    const linha3 = linhaDe(page, grupoDepois.find((l) => l.cnp === cnpDe(3) && l.farmacia === "Farmacia Alfa")!);
    await linha3.locator('[data-testid="pendente-valor"]').click();
    const itens3 = await linha3.locator('[data-testid="pendente-encomenda"]').allInnerTexts();
    const soma3 = (await linha3.locator('[data-testid="pendente-encomenda"] span.tabular-nums').allInnerTexts()).reduce((s, t) => s + Number(t), 0);
    check(itens3.length === 2 && soma3 === 75 && /Total:\s*75/.test((await linha3.locator('[data-testid="pendente-detalhe"]').innerText()).replace(/\s+/g, " ")), "várias encomendas: aparecem todas e a soma (75) coincide com a coluna");
    await page.screenshot({ path: path.join(EVID, "pendente-detalhe.png") });
    void L2;

    // quantidade final editável + separador preservado
    secao("3 · Quantidade final editável e preservada ao mudar de separador");
    const inputFinal = linha5.locator('td input[type="number"], td input[inputmode]').first();
    const sug5 = (await linha5.locator('[data-testid="celula-pendente"] + td').innerText()).trim();
    await inputFinal.fill("7");
    await inputFinal.blur();
    check((await inputFinal.inputValue()) === "7" && (await linha5.locator('[data-testid="celula-pendente"] + td').innerText()).trim() === sug5, "a quantidade final é editável (7) e a sugerida não muda");

    // ═══ 4 · FARMÁCIA ═══════════════════════════════════════════════════════════════════════════════════════════════════════
    secao("4 · Proposta de FARMÁCIA");
    await page.getByRole("button", { name: "Farmácia", exact: true }).first().click();
    await page.getByRole("button", { name: /Gerar (nova )?proposta/ }).click();
    await page.waitForTimeout(3000);
    const farm = await lerTabela(page);
    await page.screenshot({ path: path.join(EVID, "farmacia-com-pendentes.png"), fullPage: true });
    check(farm.length >= 5, `proposta de farmácia gerada (${farm.length} linhas)`);
    const farmNome = farm[0] ? (await page.locator("select").first().inputValue().catch(() => "")) : "";
    void farmNome;
    const texto2 = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    check(!/Aguardar/i.test(texto2) && farm.every((l) => Number(l.sugerida) >= 0), "sem «Aguardar»");
    const pendFarm = farm.filter((l) => Number(l.pendente) > 0);
    // mudar de separador preserva a proposta de farmácia e a edição da quantidade final
    const alvoFarm = farm.find((l) => Number(l.pendente) > 0 && Number(l.sugerida) > 0)!;
    const inputFarm = linhaDe(page, alvoFarm).locator('td input[type="number"], td input[inputmode]').first();
    await inputFarm.fill("9");
    await inputFarm.blur();
    await page.getByRole("link", { name: "Vendas", exact: true }).click();
    await page.waitForURL(/\/vendas/);
    await page.locator('[data-navegacao-href^="/encomendas/nova"]').click();
    await page.waitForURL(/\/encomendas\/nova/);
    await page.locator('[data-testid="tabela-proposta"]').waitFor({ timeout: 30000 });
    const aposFarm = await lerTabela(page);
    check(aposFarm.length === farm.length, `mudar de separador e voltar: a proposta de farmácia continua (${aposFarm.length} linhas)`);
    check(aposFarm.find((l) => l.cnp === alvoFarm.cnp)?.final === "9", "…e a edição da quantidade final (9) foi preservada");
    check(pendFarm.length >= 1 && pendFarm.every((l) => Number(l.sugerida) > 0 || Number(l.sugerida) === 0), "«Pendente» presente na proposta de farmácia (informativo)");

    // ═══ 5 · finalizar + Excel ════════════════════════════════════════════════════════════════════════════════════════════
    secao("5 · Finalizar a proposta de grupo e Excel da encomenda");
    await page.getByRole("button", { name: "Grupo", exact: true }).first().click();
    await page.getByRole("button", { name: /Gerar (nova )?proposta/ }).click();
    await page.waitForTimeout(2500);
    await page.getByText("ARTIGO E2E 6").first().waitFor({ state: "attached", timeout: 30000 });
    const antesFin = await prisma.listaEncomenda.count();
    await abrirModalEEscolher(page, "separada");
    await page.getByRole("button", { name: /Confirmar e finalizar/ }).click();
    await page.getByText("Encomenda finalizada").waitFor({ timeout: 40000 });
    await page.screenshot({ path: path.join(EVID, "finalizacao.png"), fullPage: true });
    const novas = await prisma.listaEncomenda.findMany({ where: { nome: { not: { startsWith: "A-" } }, estado: "FINALIZADA", numero: { not: { startsWith: "E2E-" } } }, include: { linhas: { include: { produto: true } } } });
    check((await prisma.listaEncomenda.count()) > antesFin && novas.length >= 3, `${novas.length} encomenda(s) finalizada(s) criadas pela proposta`);
    const linhasNovas = novas.flatMap((l) => l.linhas.map((x) => ({ farmacia: l.farmaciaId, cnp: x.produto.cnp, q: Number(x.quantidadeAjustada ?? 0), lista: l.id })));
    const alfaNome = "Farmacia Alfa";
    const l5 = linhasNovas.find((x) => x.farmacia === alfa && x.cnp === cnpDe(5));
    check(!!l5 && (l5.q === 7 || l5.q === Number(sugAntes.get(`${cnpDe(5)}|${alfaNome}`))), `o artigo com 100000 noutras encomendas foi INCLUÍDO na nova encomenda (quantidade ${l5?.q})`);
    const outras = linhasNovas.filter((x) => !(x.farmacia === alfa && x.cnp === cnpDe(5)));
    check(outras.every((x) => { const nome = x.farmacia === alfa ? "Farmacia Alfa" : x.farmacia === beta ? "Farmacia Beta" : "Farmacia Gama"; const s = sugAntes.get(`${x.cnp}|${nome}`); return s === undefined || Number(s) === x.q; }), "todas as outras quantidades finais = quantidades sugeridas sem encomendas (nenhuma dedução)");
    const dl = page.locator('[data-testid="excel-encomenda"]').first();
    await dl.waitFor({ timeout: 20000 });
    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), dl.click()]);
    const f = path.join(EVID, "encomenda.xlsx");
    await download.saveAs(f);
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(XLSX.readFile(f).Sheets["Encomenda"], { header: 1 }) as unknown[][];
    check(aoa.length > 0 && aoa.every((r) => r.length === 3 && Number(r[2]) > 0), `Excel da encomenda: ${aoa.length} linhas (CNP, designação, quantidade), sem cabeçalho`);
    const quantidadesBd = new Map(linhasNovas.map((x) => [x.cnp, 0]));
    void quantidadesBd;
    check(aoa.every((r) => linhasNovas.some((x) => x.cnp === Number(r[0]) && x.q === Number(r[2]))), "as quantidades do Excel são as da encomenda guardada (sem deduções)");
  } finally {
    await browser.close();
    await amb.parar();
  }
  console.log(`\n${falhas === 0 ? "PASSOU" : "FALHOU"} — ${ok} OK, ${falhas} falhas\n`);
  process.exit(falhas === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
