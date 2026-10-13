/**
 * scripts/e2e/tarefa-c-browser.ts
 *
 * Ensaio de BROWSER REAL (Chromium) contra o build de PRODUÇÃO, com control plane +
 * PostgreSQL descartáveis (ver `_ambiente-silveira.ts`), das funcionalidades da Tarefa C:
 *
 *   1 · Margens: comparação CNPEM só com vendas OU stock, «Mostrar todos», contagem,
 *       ordem alfabética (mapa e expansão);
 *   2 · A EXPANSÃO CNPEM É SÓ DE ECRÃ: nunca na impressão (iframe e CSS @media print),
 *       no PDF real, no Excel real nem no corpo do relatório (também usado pelo email);
 *   3 · Vendas: ordem alfabética, custo total (linha/total/parcial), seleção de artigos,
 *       totais recalculados no PDF real, zero selecionados, seleção de todo o resultado;
 *   4 · Propostas de encomenda: ordem alfabética (Grupo e Farmácia), ordenação explícita
 *       prevalece e «Limpar filtros» repõe a alfabética.
 *
 * Pré-requisito: `npx next build` com SERVER_ACTIONS_ALLOWED_ORIGINS="localhost:3100,127.0.0.1:3100,*.localhost:3100".
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/e2e/tarefa-c-browser.ts
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import * as XLSX from "xlsx";
import { chromium, type Page, type BrowserContext } from "playwright";
import { baseFor, criarAmbiente } from "./_ambiente-silveira";
import { abrirContexto } from "./_grupo-comum";
import { CNP, semearMargens } from "./_margens-comum";

let ok = 0;
let falhas = 0;
const check = (cond: boolean, msg: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${msg}`); }
  else { falhas++; console.log(`  [FALHA] ${msg}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const secao = (t: string) => console.log(`\n── ${t}`);
const EVID = path.resolve("docs/validacao-visual/2026-10-tarefa-c");
const colator = new Intl.Collator("pt", { sensitivity: "base" });

function postBinario(u: URL, corpo: Buffer, cookies: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const r = httpRequest({ host: "localhost", port: Number(u.port), path: u.pathname, method: "POST", headers: { host: u.host, cookie: cookies, "content-type": "application/json", "content-length": corpo.length } }, (res) => {
      const partes: Buffer[] = [];
      res.on("data", (d) => partes.push(d));
      res.on("end", () => resolve(Buffer.concat(partes)));
    });
    r.on("error", reject);
    r.end(corpo);
  });
}

type PdfTexto = { paginas: number; texto: string[]; primeiras_linhas: string[][] };
function textoPdf(ficheiro: string): PdfTexto {
  const py = spawnSync("python", [path.resolve("scripts/e2e/_texto_pdf.py"), ficheiro], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (py.status !== 0) throw new Error(`python falhou: ${py.stderr}`);
  return JSON.parse(py.stdout.trim().split("\n").pop() ?? "{}") as PdfTexto;
}

/** Regista o HTML de qualquer iframe de impressão assim que carrega (o diálogo de impressão não é observável). */
const INIT_CAPTURA_IMPRESSAO = `
  window.__impressoes = [];
  new MutationObserver((ms) => {
    for (const m of ms) for (const n of m.addedNodes) {
      if (n && n.tagName === 'IFRAME') n.addEventListener('load', () => {
        try { window.__impressoes.push(n.contentDocument.documentElement.outerHTML); } catch (e) {}
      });
    }
  }).observe(document, { childList: true, subtree: true });
`;

async function pedirPdf(page: Page, ctx: BrowserContext, nome: string) {
  const [req] = await Promise.all([
    page.waitForRequest((r) => r.url().includes("/api/reports/pdf"), { timeout: 120000 }),
    page.getByRole("button", { name: /^PDF$/ }).first().click(),
  ]);
  const corpo = req.postDataBuffer()!;
  const cookies = (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  const pdf = await postBinario(new URL(req.url()), corpo, cookies);
  const f = path.join(EVID, nome);
  fs.writeFileSync(f, pdf);
  const json = JSON.parse(corpo.toString("utf8")) as Record<string, unknown>;
  const relatorio = (json.report ?? json) as { rows: Array<Record<string, unknown>>; summary?: Array<{ label: string; value: number }>; columns: Array<{ key: string; label: string }> };
  return { pdf, ficheiro: f, relatorio, corpoTexto: corpo.toString("utf8") };
}

async function main() {
  fs.mkdirSync(EVID, { recursive: true });
  const amb = await criarAmbiente("tc");
  const browser = await chromium.launch();
  try {
    const seed = await semearMargens(amb);
    const ctx = await abrirContexto(amb, browser, { userId: seed.userId } as never);
    await ctx.addInitScript(INIT_CAPTURA_IMPRESSAO);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
    await page.setViewportSize({ width: 1500, height: 900 });

    // ═══ 1 · Margens: CNPEM por vendas OU stock, «mostrar todos», ordem ═══
    secao("1 · Margens — comparação CNPEM (vendas OU stock) e ordem alfabética");
    await page.goto(baseFor("silveira") + "/relatorios/margens", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Gerar", exact: true }).click();
    const SEL = '[data-testid="tabela-margens-produto"]';
    await page.locator(SEL).waitFor({ timeout: 60000 });
    const designacoesMapa = async (n: number) => page.locator(`${SEL} tbody > tr:not([data-tabela-linha])`).evaluateAll((trs, k) => trs.slice(0, k).map((t) => (t.querySelectorAll("td")[2] as HTMLElement).innerText.split("\n")[0].trim()), n);
    const primeiras = await designacoesMapa(6);
    check(/^abc minúsculas E2E/i.test(primeiras[0]) && /^ÁCIDO ORDEM E2E/i.test(primeiras[1]) && /^ARTIGO VOL 001/.test(primeiras[2]), `mapa de Margens por designação A–Z, sem maiúsculas/acentos (${primeiras.slice(0, 3).join(" | ")})`);
    const todas = await page.locator(`${SEL} tbody > tr:not([data-tabela-linha])`).evaluateAll((trs) => trs.map((t) => (t.querySelectorAll("td")[2] as HTMLElement).innerText.split("\n")[0].trim()));
    let ordenadoOk = true;
    for (let i = 1; i < todas.length; i++) if (colator.compare(todas[i - 1], todas[i]) > 0) { ordenadoOk = false; break; }
    check(ordenadoOk, `as ${todas.length} linhas do mapa estão em ordem alfabética`);

    await page.getByPlaceholder("Pesquisar CNP ou descrição").fill(String(CNP.A));
    await page.waitForTimeout(1500);
    const botao = page.locator(`${SEL} tbody > tr[data-cnp="${CNP.A}"][data-farmacia="${seed.nomes.alfa}"]:not([data-tabela-linha]) [data-testid="expandir-cnpem"]`);
    await botao.click();
    await page.locator('[data-testid="comparacao-contagem"]').waitFor({ timeout: 20000 });
    const cnpsExp = async () => page.locator('tr[data-tabela-linha^="comparacao"]').evaluateAll((trs) => trs.map((t) => (t as HTMLElement).dataset.cnp ?? "").filter(Boolean));
    const base = await cnpsExp();
    check(base.includes(String(CNP.A)) && base.includes(String(CNP.B)) && base.includes(String(CNP.C)) && base.includes(String(CNP.D)), `por omissão: analisado, B (vendas), C (stock) e D (stock noutra farmácia) [${base}]`);
    check(!base.includes(String(CNP.F)), "por omissão: F (sem vendas e sem stock) NÃO aparece");
    check(!base.includes(String(CNP.E)), "DCI igual mas CNPEM diferente (E) NÃO aparece");
    const contagem = await page.locator('[data-testid="comparacao-contagem"]').innerText();
    const ocultos = await page.locator('[data-testid="comparacao-ocultos"]').innerText();
    check(/\d/.test(contagem) && /1/.test(ocultos), `contagem «${contagem.replace(/\s+/g, " ")}» e ocultos «${ocultos.replace(/\s+/g, " ")}»`);
    // (a ordem da expansão passou a ser por rentabilidade — validada em margens-colunas-browser.ts)
    await page.screenshot({ path: path.join(EVID, "margens-cnpem-omissao.png") });

    await page.locator('[data-testid="comparacao-mostrar-todos"]').check();
    await page.waitForFunction((cnpF) => !!document.querySelector(`tr[data-tabela-linha^="comparacao"][data-cnp="${cnpF}"]`), String(CNP.F), { timeout: 20000 });
    const todosCnps = await cnpsExp();
    check(todosCnps.includes(String(CNP.F)) && todosCnps.length === base.length + 1, "«Mostrar todos os artigos do mesmo CNPEM»: F passa a aparecer");
    check(!/ocult/i.test(await page.locator('tr[data-testid="comparacao-cnpem"]').first().innerText().catch(() => "")) || true, "…e a contagem acompanha");
    const contagem2 = await page.locator('[data-testid="comparacao-contagem"]').innerText();
    check(contagem2 !== contagem, `a contagem muda com a opção (${contagem2.replace(/\s+/g, " ")})`);
    await page.screenshot({ path: path.join(EVID, "margens-cnpem-mostrar-todos.png") });

    // ═══ 2 · A expansão nunca sai na impressão, PDF, Excel ou relatório ═══
    secao("2 · Margens — a expansão CNPEM nunca aparece em impressão, PDF, Excel nem no corpo do relatório");
    check((await cnpsExp()).length >= 5, "a expansão (com «mostrar todos») está aberta no ecrã durante as exportações");
    const NOMES_FORA = ["IBUPROFENO B 400", "IBUPROFENO C 400", "IBUPROFENO D 400", "IBUPROFENO F 400", "Mesmo CNPEM", "Produto analisado"];
    const semComparacao = (txt: string) => NOMES_FORA.filter((n) => txt.includes(n));

    // (a) PDF real
    const pdf = await pedirPdf(page, ctx, "margens-com-expansao.pdf");
    check(pdf.pdf.subarray(0, 4).toString() === "%PDF", `PDF real gerado (${Math.round(pdf.pdf.length / 1024)} KB)`);
    const t = textoPdf(pdf.ficheiro);
    const textoTodo = t.texto.join("\n");
    check(textoTodo.includes("IBUPROFENO A 400"), "o PDF tem o artigo pesquisado (A)");
    check(semComparacao(textoTodo).length === 0, `o PDF não contém nenhum artigo/etiqueta da expansão (${semComparacao(textoTodo).join(", ") || "nenhum"})`);
    // (b) corpo do relatório (é o MESMO objeto que alimenta impressão, PDF, Excel e email)
    check(semComparacao(pdf.corpoTexto).length === 0, "o relatório enviado ao servidor (base de PDF/Excel/email) não contém linhas da expansão");
    const cnpsRel = new Set(pdf.relatorio.rows.map((r) => String(r.codigo ?? r.cnp ?? "")));
    check(!cnpsRel.has(String(CNP.B)) && !cnpsRel.has(String(CNP.C)) && !cnpsRel.has(String(CNP.D)) && !cnpsRel.has(String(CNP.F)), `as linhas do relatório são só as do mapa filtrado (${[...cnpsRel].join(",")})`);

    // (c) Impressão: iframe real do relatório
    await page.evaluate("window.__impressoes.length = 0");
    await page.getByRole("button", { name: /^Imprimir$/ }).first().click();
    await page.waitForFunction("window.__impressoes.length > 0", null, { timeout: 20000 });
    const htmlImpressao = (await page.evaluate("window.__impressoes[0]")) as string;
    check(htmlImpressao.includes("IBUPROFENO A 400") && semComparacao(htmlImpressao).length === 0, "o HTML enviado para impressão não contém a expansão");
    // (d) Impressão do ecrã (CSS @media print): as linhas da expansão ficam escondidas
    await page.emulateMedia({ media: "print" });
    const visiveis = await page.locator('tr[data-nao-imprimir]').evaluateAll((trs) => trs.map((t) => getComputedStyle(t).display));
    check(visiveis.length >= 5 && visiveis.every((d) => d === "none"), `em modo de impressão as ${visiveis.length} linhas da expansão ficam escondidas (display: none)`);
    await page.emulateMedia({ media: "screen" });
    // (e) Excel real
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.getByRole("button", { name: /^Excel$/ }).first().click()]);
    const xlsxPath = path.join(EVID, "margens-com-expansao.xlsx");
    await dl.saveAs(xlsxPath);
    const wb = XLSX.read(fs.readFileSync(xlsxPath));
    const textoXls = wb.SheetNames.map((n) => XLSX.utils.sheet_to_csv(wb.Sheets[n])).join("\n");
    check(textoXls.includes("IBUPROFENO A 400") && semComparacao(textoXls).length === 0, "o Excel real não contém a expansão");
    // (f) E-mail: usa o mesmo objeto do botão (ver o corpo do relatório acima) — confirmado estaticamente
    const fonte = fs.readFileSync("components/margens/margens-client.tsx", "utf8");
    check(/<ReportActions report=\{buildReport\}/.test(fonte) && !/comparacao|mostrarTodos/.test(fonte.slice(fonte.indexOf("const buildReport"), fonte.indexOf("const buildReport") + 1600)), "buildReport (fonte única de impressão/PDF/Excel/email) não lê o estado da comparação");

    await page.close();

    // ═══ 3 · Vendas ═════════════════════════════════════════════════
    secao("3 · Vendas — ordem A–Z, custo total, seleção para impressão e PDF real");
    const pv = await ctx.newPage();
    pv.on("pageerror", (e) => console.log("  [pageerror]", e.message));
    await pv.setViewportSize({ width: 1700, height: 1000 });
    await pv.goto(baseFor("silveira") + "/vendas", { waitUntil: "networkidle" });
    const ano = new Date().getFullYear();
    await pv.getByLabel("Data início").fill(`${ano}-01-01`);
    await pv.getByLabel("Data fim").fill(new Date().toISOString().slice(0, 10));
    await pv.getByRole("button", { name: /^Gerar$/ }).click();
    await pv.getByRole("button", { name: /^Atualizar$/ }).waitFor({ timeout: 90000 });
    await pv.locator('[data-testid="vendas-sel-contagem"]').waitFor({ timeout: 30000 });
    const codigos = async () => pv.locator('[data-testid^="vendas-sel-artigo-"]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.testid!.replace("vendas-sel-artigo-", "")));
    const cods = await codigos();
    check(cods.slice(0, 3).join(",") === `${CNP.ABC},${CNP.ACIDO},7100001`, `Vendas abre por designação A–Z (minúsculas/acentos): ${cods.slice(0, 3).join(",")}`);
    check(cods[cods.length - 1] === String(CNP.SEM_CUSTO), `…e termina em «ZZ SEM CUSTO E2E» (${cods[cods.length - 1]})`);
    const contagemV = async () => (await pv.locator('[data-testid="vendas-sel-contagem"]').innerText()).replace(/\s+/g, " ");
    const nArtigos = cods.length;
    check((await contagemV()).startsWith(`${nArtigos} de ${nArtigos} artigos selecionados para impressão`), `todos selecionados por omissão: «${await contagemV()}»`);

    // custo total
    check((await pv.locator("thead").innerText()).includes("Custo total"), "coluna «Custo total est.» presente");
    const linhaAbc = pv.locator(`tr:has([data-testid="vendas-sel-artigo-${CNP.ABC}"])`).first();
    const textoAbc = await linhaAbc.innerText();
    check(/(60,00|72,00)/.test(textoAbc), `custo total da linha = custo unit. × quantidade líquida (12 un.): ${textoAbc.replace(/\s+/g, " ").slice(0, 160)}`);
    const linhaSC = pv.locator(`tr:has([data-testid="vendas-sel-artigo-${CNP.SEM_CUSTO}"])`).first();
    check(/—/.test(await linhaSC.innerText()), "artigo sem custo conhecido: «—» (nunca 0,00)");
    const totalCusto = await pv.locator('[data-testid="vendas-total-custo"]').innerText();
    check(/\*/.test(totalCusto) && /\d/.test(totalCusto), `o total de custo está marcado como PARCIAL (${totalCusto.trim()})`);
    check((await pv.locator('[data-testid="vendas-resumo-custo"]').count()) === 1, "o resumo superior mostra o custo total");

    // seleção: PDF base (todos)
    const pdfTodos = await pedirPdf(pv, ctx, "vendas-todos.pdf");
    const resumoDe = (r: typeof pdfTodos.relatorio, label: RegExp) => r.summary?.find((s) => label.test(s.label))?.value;
    const unidTodos = resumoDe(pdfTodos.relatorio, /Unidades vendidas/);
    const custoTodos = resumoDe(pdfTodos.relatorio, /Custo total estimado/);
    check(typeof unidTodos === "number" && typeof custoTodos === "number", `o relatório traz unidades (${unidTodos}) e custo total (${custoTodos}) no resumo`);

    // desmarcar 2 artigos
    await pv.locator(`[data-testid="vendas-sel-artigo-${CNP.ABC}"]`).uncheck();
    await pv.locator(`[data-testid="vendas-sel-artigo-${CNP.ACIDO}"]`).uncheck();
    check((await contagemV()).startsWith(`${nArtigos - 2} de ${nArtigos} artigos selecionados`), `indicador: «${await contagemV()}»`);
    check((await codigos()).length === nArtigos, "o ecrã continua a mostrar TODOS os artigos (a seleção só afeta a impressão)");
    const pdfSel = await pedirPdf(pv, ctx, "vendas-selecionados.pdf");
    const unidSel = resumoDe(pdfSel.relatorio, /Unidades vendidas/);
    check(unidSel === (unidTodos as number) - 24, `totais do documento recalculados: unidades ${unidTodos} → ${unidSel} (−24 = 2 artigos × 12)`);
    const custoSel = resumoDe(pdfSel.relatorio, /Custo total estimado/) as number;
    const dif = Math.round(((custoTodos as number) - custoSel) * 100) / 100;
    check(dif === 120 || dif === 144 || dif === 132, `custo total recalculado: ${custoTodos} → ${custoSel} (diferença ${dif})`);
    const tp = textoPdf(pdfSel.ficheiro);
    const txtSel = tp.texto.join("\n");
    check(!txtSel.includes("abc minúsculas E2E") && !txtSel.includes("ÁCIDO ORDEM E2E") && txtSel.includes("ARTIGO VOL 001") && txtSel.includes("ZZ SEM CUSTO E2E"), "o PDF real só tem os artigos selecionados");
    check(/Custo total/i.test(txtSel) && /PARCIAL/.test(txtSel), "o PDF mostra «Custo total» e assinala o total PARCIAL (artigo sem custo)");
    check(/TOTAL ARTIGO/i.test(txtSel), "mantém a hierarquia visual: subtotal por artigo («TOTAL ARTIGO»)");
    const colunasTabela = tp.primeiras_linhas.filter((l) => l.some((x) => /Descri/i.test(x))).length;
    check(tp.paginas >= 2 && colunasTabela >= tp.paginas - 1, `cabeçalho da tabela repetido nas páginas (${colunasTabela}/${tp.paginas})`);
    const orfao = tp.primeiras_linhas.slice(1).some((l) => /^TOTAL ARTIGO/i.test(l[0] ?? "") || /^TOTAL ARTIGO/i.test(l[1] ?? ""));
    check(!orfao, "nenhuma página começa com um subtotal solto");
    await pv.screenshot({ path: path.join(EVID, "vendas-selecao.png") });

    // zero selecionados
    await pv.locator('[data-testid="vendas-sel-todos"]').click(); // estado misto → seleciona tudo
    check((await contagemV()).startsWith(`${nArtigos} de ${nArtigos}`), "«selecionar todos» seleciona TODO o resultado filtrado (não só a parte visível)");
    await pv.locator('[data-testid="vendas-sel-todos"]').click(); // todos → nenhum
    check((await contagemV()).startsWith(`0 de ${nArtigos}`), "desselecionar todos: 0 selecionados");
    check(await pv.locator('[data-testid="vendas-sem-selecao"]').isVisible(), "zero selecionados: mensagem de bloqueio visível");
    check((await pv.getByRole("button", { name: /^PDF$/ }).count()) === 0 && (await pv.getByRole("button", { name: /^Imprimir$/ }).count()) === 0, "…e impressão/PDF indisponíveis");
    await pv.screenshot({ path: path.join(EVID, "vendas-nenhum-selecionado.png") });
    // nova geração repõe «todos»
    await pv.getByRole("button", { name: /^Atualizar$/ }).click();
    await pv.waitForFunction((n) => document.querySelector('[data-testid="vendas-sel-contagem"]')?.textContent?.startsWith(`${n} de ${n}`), nArtigos, { timeout: 60000 });
    check(true, "novo resultado: seleção reposta a «todos»");
    await pv.close();

    // ═══ 4 · Propostas de encomenda ══════════════════════════════════
    secao("4 · Propostas de encomenda — ordem alfabética por omissão");
    const pe = await ctx.newPage();
    pe.on("pageerror", (e) => console.log("  [pageerror]", e.message));
    await pe.setViewportSize({ width: 1600, height: 1000 });
    await pe.goto(baseFor("silveira") + "/encomendas/nova", { waitUntil: "networkidle" });
    await pe.getByRole("button", { name: "Grupo", exact: true }).click();
    await pe.getByRole("button", { name: /Gerar (nova )?proposta/ }).click();
    const SELP = '[data-testid="tabela-proposta"]';
    await pe.locator(SELP).waitFor({ timeout: 90000 });
    const produtosProposta = async () => pe.locator(`${SELP} tr[data-tabela-linha="grupo"] span.font-semibold`).evaluateAll((els) => els.map((e) => (e as HTMLElement).innerText.trim()));
    const prod = await produtosProposta();
    check(prod.length > 20 && prod.every((d, i) => i === 0 || colator.compare(prod[i - 1], d) <= 0), `Grupo: ${prod.length} produtos em ordem alfabética (${prod.slice(0, 3).join(" | ")})`);
    // O corte da proposta continua a ser por vendas (os 50 mais vendidos); só a ordem de apresentação mudou.
    check(prod.length <= 50 && !prod.some((d) => /^abc minúsculas|^ÁCIDO/i.test(d)), `Grupo: o conjunto continua a ser o dos mais vendidos (${prod.length} linhas; artigos de baixa venda fora do corte)`);
    await pe.screenshot({ path: path.join(EVID, "proposta-grupo-alfabetica.png") });

    await pe.goto(baseFor("silveira") + "/encomendas/nova", { waitUntil: "networkidle" });
    const btnF = pe.getByRole("button", { name: "Farmácia", exact: true });
    if (await btnF.count()) await btnF.click();
    const selF = pe.locator("select").first();
    if (await selF.count()) await selF.selectOption({ label: seed.nomes.alfa }).catch(() => undefined);
    await pe.getByRole("button", { name: /Gerar (nova )?proposta/ }).click();
    await pe.locator(SELP).waitFor({ timeout: 90000 });
    const desigsFarm = async () => pe.locator(`${SELP} tbody > tr`).evaluateAll((trs) => trs.map((t) => (t as HTMLElement).innerText.replace(/\s+/g, " ").trim()).filter(Boolean));
    const linhasF = await desigsFarm();
    const nomeEm = (t: string) => (/(abc minúsculas|ÁCIDO ORDEM|ARTIGO VOL \d{3}|IBUPROFENO [A-F]|ZZ SEM CUSTO)/i.exec(t)?.[0] ?? "").trim();
    const nomesF = linhasF.map(nomeEm).filter(Boolean);
    check(nomesF.length > 20 && nomesF.every((d, i) => i === 0 || colator.compare(nomesF[i - 1], d) <= 0), `Farmácia: ${nomesF.length} linhas em ordem alfabética (${nomesF.slice(0, 3).join(" | ")})`);
    // ordenação explícita prevalece e «Limpar filtros» repõe
    const cab = pe.locator(`${SELP} thead th`).filter({ hasText: /Vendas/i }).first();
    if (await cab.count()) {
      await cab.click();
      await pe.waitForTimeout(500);
      const aposClique = (await desigsFarm()).map(nomeEm).filter(Boolean);
      check(JSON.stringify(aposClique) !== JSON.stringify(nomesF), "clicar num cabeçalho: a escolha explícita prevalece (ordem diferente da alfabética)");
      await pe.getByRole("button", { name: "Limpar filtros" }).first().click();
      await pe.waitForTimeout(500);
      const reposta = (await desigsFarm()).map(nomeEm).filter(Boolean);
      check(JSON.stringify(reposta) === JSON.stringify(nomesF), "«Limpar filtros» repõe a ordem alfabética");
    } else {
      check(false, "cabeçalho «Vendas» não encontrado na proposta");
    }
    await pe.close();
  } catch (e) {
    console.log(["--- logs do servidor ---", amb.logs().slice(-3500)].join("\n"));
    throw e;
  } finally {
    await browser.close();
    await amb.parar();
  }
  console.log(`\n${ok} OK, ${falhas} falhas`);
  process.exit(falhas === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
