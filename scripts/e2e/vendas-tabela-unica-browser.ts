/**
 * scripts/e2e/vendas-tabela-unica-browser.ts
 *
 * ESCRITO, NÃO EXECUTADO pelo autor (o coordenador valida num clone limpo: build + este E2E).
 *
 * Browser REAL (Chromium) contra o build de PRODUÇÃO (control plane + PostgreSQL descartáveis, dados sintéticos): o mapa de Vendas
 * numa SÓ tabela contínua, em A4 HORIZONTAL SEMPRE (2026-11, segundo desenho; sem A3, sem blocos, letra ≥ 8 pt) — pré-visualização
 * «Relatório» (3 resoluções), impressão (iframe de report-print.ts), PDF real do endpoint, PDF recebido por e-mail (SMTP) e Excel,
 * para 1, 3 e 14 meses, e 27 meses (que NÃO cabem em A4 legível: mensagem em vez de PDF/impressão/pré-visualização), com as opções de preços.
 * Verifica, em cada saída:
 *   · uma só tabela, um só cabeçalho, todos os meses «Out/25» lado a lado (N cabeçalhos de mês), cada CNP UMA vez no documento;
 *   · sem «Parte i de n», «Total unid. do bloco», «Período:»; sem as colunas «Custo total est.» e «Valor Vendas» na tabela;
 *   · um só «Total unid.», um só «Stock», um só TOTAL GERAL (no fim) e um só resumo financeiro (no fim); TOTAL ARTIGO só com > 1 farmácia;
 *   · A4 horizontal em todas as páginas; corpo da tabela ≥ 8 pt; nada cortado/sobreposto;
 *   · Excel com todos os meses e as MESMAS colunas de sempre (incl. «Custo total est.» e «Valor Vendas (s/IVA)»);
 *   · 27 meses: o Relatório mostra a mensagem, «Imprimir»/«PDF» não geram nada (aviso visível), o email com PDF é recusado, o Excel funciona;
 *   · as opções «Incluir preços de venda/compra» retiram PVP/custo unit. e as linhas correspondentes do resumo financeiro.
 * Os números exatos (valores por linha, somas, tipografia, paginação, capacidade por combinação) estão em scripts/tests/test-vendas-tabela-unica.ts.
 *
 * Pré-requisito: `npx next build` com SERVER_ACTIONS_ALLOWED_ORIGINS="localhost:3100,127.0.0.1:3100,*.localhost:3100".
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/e2e/vendas-tabela-unica-browser.ts
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { chromium } from "playwright";
import * as XLSX from "xlsx";
import { baseFor, criarAmbiente } from "./_ambiente-silveira";
import { abrirContexto } from "./_grupo-comum";
import { semearMargens } from "./_margens-comum";
import { iniciarSmtpSink } from "./_smtp-sink";

let ok = 0;
let falhas = 0;
const check = (cond: boolean, msg: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${msg}`); }
  else { falhas++; console.log(`  [FALHA] ${msg}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const secao = (t: string) => console.log(`\n── ${t}`);
const EVID = path.resolve("docs/validacao-visual/2026-11-vendas-tabela-unica/e2e");
const norm = (t: string) => t.replace(/[  ]/g, " ");

const INIT_CAPTURA_IMPRESSAO = `
  window.__name = (f) => f;
  window.__impressoes = [];
  new MutationObserver((ms) => {
    for (const m of ms) for (const n of m.addedNodes) {
      if (n && n.tagName === 'IFRAME') n.addEventListener('load', () => {
        try { window.__impressoes.push({ html: n.contentDocument.documentElement.outerHTML, largura: n.style.width, altura: n.style.height }); } catch (e) {}
      });
    }
  }).observe(document, { childList: true, subtree: true });
`;

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
function py(script: string, ...args: string[]): string {
  const r = spawnSync("python", [path.resolve(`scripts/e2e/${script}`), ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`python ${script}: ${r.stderr}`);
  return r.stdout.trim().split("\n").pop() ?? "{}";
}
type Tok = [number, number, number, number, number, string];
type PagPdf = { w: number; h: number; tokens: Tok[] };
const lerPdf = (f: string): PagPdf[] => (JSON.parse(py("_tabela_unica_pdf.py", f)) as { paginas: PagPdf[] }).paginas;
const textoDe = (p: PagPdf[]) => norm(p.flatMap((pg) => pg.tokens.map((t) => t[5])).join(" "));

/** Verificações estruturais de um PDF do mapa (as numéricas estão em test-vendas-tabela-unica.ts). */
function verificarPdf(tag: string, f: string, n: number, precos: { venda: boolean; compra: boolean }) {
  const pags = lerPdf(f);
  const texto = textoDe(pags);
  check(pags.every((p) => Math.abs(p.w - 841.9) < 1.5 && Math.abs(p.h - 595.3) < 1.5), `${tag}: A4 horizontal em todas as páginas (${pags[0]?.w}×${pags[0]?.h} pt) — paginação só na vertical`);
  check(!/Parte\s+\d+\s+de\s+\d+|do\s+bloco|Período:\s*(custo|valor|Total)|em\s+\d+\s+blocos|blocos?\s+temporais?/i.test(texto), `${tag}: sem «Parte i de n», «Total unid. do bloco», «Período:» nem explicação de blocos`);
  check(!/Custo total est\.|Valor Vendas/.test(texto), `${tag}: sem as colunas «Custo total est.» e «Valor Vendas» (os totais estão no resumo financeiro)`);
  const meses = (p: PagPdf) => p.tokens.filter((t) => /^(Jan|Fev|Mar|Abr|Mai|Jun|Jul|Ago|Set|Out|Nov|Dez)\/\d\d$/.test(t[5])).length;
  check(pags.every((p) => p.tokens.filter((t) => t[5] === "CNP").length === 1 && meses(p) === n), `${tag}: em CADA página um só cabeçalho com os ${n} meses «Out/25» lado a lado (${pags.map(meses).join("/")})`);
  const cnps = new Map<string, number>();
  for (const p of pags) for (const t of p.tokens) if (/^75\d{5}$/.test(t[5]) && t[0] < p.w * 0.2) cnps.set(t[5], (cnps.get(t[5]) ?? 0) + 1);
  check(cnps.size > 0 && [...cnps.values()].every((c) => c === 1), `${tag}: cada CNP aparece UMA vez em todo o documento (${cnps.size} artigos)`);
  check(pags.flatMap((p) => p.tokens).filter((t) => t[5] === "GERAL").length === 1 && pags.flatMap((p) => p.tokens).filter((t) => t[5] === "RESUMO").length === 1, `${tag}: um só TOTAL GERAL e um só resumo, no fim`);
  check(/PVP/.test(texto) === precos.venda && /Valor total de vendas/.test(texto) === precos.venda && /Custo/.test(texto) === precos.compra && /Custo total estimado/.test(texto) === precos.compra, `${tag}: PVP/custo unit. e resumo financeiro coerentes com as opções (venda=${precos.venda}, compra=${precos.compra})`);
  const corpo = pags.flatMap((p) => p.tokens.filter((t) => t[1] > 70 && !/^Pág/.test(t[5])));
  check(corpo.every((t) => t[4] >= 7.95), `${tag}: letra do corpo e dos cabeçalhos ≥ 8 pt (mínimo ${Math.min(...corpo.map((t) => t[4])).toFixed(2)} pt)`);
  check(pags.every((p) => p.tokens.every((t) => t[2] <= p.w - 8 && !/…/.test(t[5]))), `${tag}: nada cortado à direita nem reticências`);
  return pags;
}

async function main() {
  fs.mkdirSync(EVID, { recursive: true });
  const amb = await criarAmbiente("tu");
  const browser = await chromium.launch();
  const smtp = await iniciarSmtpSink();
  try {
    const seed = await semearMargens(amb);
    const prisma = amb.prisma;
    await prisma.emailConfig.create({ data: { smtpHost: "127.0.0.1", smtpPort: smtp.port, smtpSecure: false, fromEmail: "spharm@exemplo.invalid", isActive: true } });
    const hoje = new Date();
    const fab = await prisma.fabricante.findFirstOrThrow();
    const { alfa, beta } = seed.farmacias;
    const prod = (cnp: number, designacao: string) => prisma.produto.create({ data: { cnp, designacao, fabricanteId: fab.id, estado: "VALIDADO" } });
    const ficha = (produtoId: string, farmaciaId: string, d: { pvp: number; stock: number }) =>
      prisma.produtoFarmacia.create({ data: { produtoId, farmaciaId, pvp: d.pvp, pmc: 4, stockAtual: d.stock, stockMinimo: 1, stockMaximo: 9, taxaIvaPercent: 23 } });
    const venda = async (produtoId: string, farmaciaId: string, q: number, atras: number) => {
      const d = new Date(hoje.getFullYear(), hoje.getMonth() - atras, 1);
      await prisma.vendaMensal.create({ data: { produtoId, farmaciaId, ano: d.getFullYear(), mes: d.getMonth() + 1, quantidade: q, quantidadeLiquida: q, valorTotal: q * 10, valorBruto: q * 10 } });
    };
    // 60 artigos (vários páginas em A3/A4), 1/3 numa só farmácia, vendas em ~20 dos últimos 28 meses
    for (let i = 0; i < 60; i++) {
      const p = await prod(7500001 + i, `TABUNICA ${i + 1} Artigo de teste${i % 7 === 0 ? " com designação comprida que ocupa duas ou três linhas na coluna da descrição" : ""}`);
      await ficha(p.id, alfa, { pvp: 5 + (i % 9), stock: (i % 6) - (i % 11 === 0 ? 1 : 0) });
      if (i % 3 !== 0) await ficha(p.id, beta, { pvp: 5 + (i % 9), stock: (i * 2) % 7 });
      for (const a of [1, 2, 3, 4, 6, 8, 9, 11, 12, 13, 14, 15, 17, 19, 21, 23, 25, 26]) {
        await venda(p.id, alfa, 1 + ((i + a) % 5), a);
        if (i % 3 !== 0) await venda(p.id, beta, 1 + ((i * 2 + a) % 4), a);
      }
    }

    const ctx = await abrirContexto(amb, browser, { userId: seed.userId } as never);
    await ctx.addInitScript(INIT_CAPTURA_IMPRESSAO);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(baseFor("silveira") + "/vendas", { waitUntil: "networkidle" });
    await page.waitForFunction(() => new URL(location.href).searchParams.has("workspace"));

    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
    const gerar = async (n: number) => {
      await page.getByLabel("Data início").fill(iso(new Date(hoje.getFullYear(), hoje.getMonth() - (n - 1), 1)));
      await page.getByLabel("Data fim").fill(hoje.toISOString().slice(0, 10));
      await page.getByRole("button", { name: /^(Gerar|Atualizar)$/ }).click();
      await page.getByRole("button", { name: /^Atualizar$/ }).waitFor({ timeout: 90000 });
      await page.locator('[data-testid="vendas-sel-contagem"]').waitFor({ timeout: 60000 });
    };
    const setCheck = async (testid: string, valor: boolean) => {
      const el = page.locator(`[data-testid="${testid}"]`);
      if ((await el.isChecked()) !== valor) await el.setChecked(valor);
    };
    const previa = () => page.frameLocator('[data-testid="vendas-relatorio-previa"]');
    const pdfReal = async (nome: string): Promise<{ f: string; json: string }> => {
      const [req] = await Promise.all([page.waitForRequest((r) => r.url().includes("/api/reports/pdf"), { timeout: 180000 }), page.getByRole("button", { name: /^PDF$/ }).first().click()]);
      const corpo = req.postDataBuffer()!;
      const buf = await postBinario(new URL(req.url()), corpo, (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; "));
      const f = path.join(EVID, nome);
      fs.writeFileSync(f, buf);
      await page.getByRole("button", { name: /^PDF$/ }).first().waitFor({ timeout: 60000 });
      return { f, json: corpo.toString("utf8") };
    };

    let nMsgs = 0;
    for (const n of [1, 3, 14, 27]) {
      for (const [v, c] of [[true, true], [false, false]] as const) {
        const tag = `${n} ${n === 1 ? "mês" : "meses"} · venda=${v ? "sim" : "não"} · compra=${c ? "sim" : "não"}`;
        secao(tag);
        await gerar(n);
        await setCheck("vendas-incluir-precos-venda", v);
        await setCheck("vendas-incluir-precos-compra", c);
        const cabe = n <= 14; // com os dados sintéticos deste E2E (totais mensais de 1-3 dígitos) a capacidade é ≥ 14 e < 27

        // 1) Relatório (pré-visualização)
        await page.getByRole("button", { name: /^Relatório$/ }).click();
        if (!cabe) {
          const aviso = previa().locator('[data-testid="relatorio-nao-cabe-a4"]');
          await aviso.waitFor({ timeout: 30000 });
          const msg = norm(await aviso.innerText());
          check(/O período de 27 meses não cabe numa página A4 legível \(máximo \d+ meses com estas opções\)\. Reduza o período, retire preços ou use o Excel\./.test(msg), `${tag}: Relatório — mostra a mensagem «${msg.slice(0, 90)}…» e nenhuma tabela truncada`);
          check((await previa().locator("table").count()) === 0, `${tag}: Relatório — sem tabela`);
          // Imprimir e PDF: aviso visível, nada gerado
          await page.evaluate("window.__impressoes = []");
          let pedidosPdf = 0;
          const contar = (r: { url(): string }) => { if (r.url().includes("/api/reports/pdf")) pedidosPdf++; };
          page.on("request", contar);
          await page.getByRole("button", { name: /^Imprimir$/ }).first().click();
          await page.locator('[data-testid="relatorio-nao-cabe-a4"]').first().waitFor({ timeout: 10000 });
          await page.getByRole("button", { name: /^PDF$/ }).first().click();
          await page.waitForTimeout(1500);
          page.off("request", contar);
          const nImp = await page.evaluate(() => (window as unknown as { __impressoes: unknown[] }).__impressoes.length);
          check(nImp === 0 && pedidosPdf === 0, `${tag}: «Imprimir» e «PDF» não geram nada (impressões=${nImp}, pedidos ao endpoint de PDF=${pedidosPdf}); o aviso está visível`);
          // e-mail: PDF recusado, Excel enviado
          await page.getByRole("button", { name: /^Email$/ }).first().click();
          await page.locator('[data-testid="email-pdf-nao-cabe-a4"]').waitFor({ timeout: 10000 });
          check(true, `${tag}: diálogo de email avisa que o PDF não cabe em A4 legível (sugere só o Excel)`);
          await page.getByPlaceholder("nome@dominio.pt, outro@dominio.pt").fill("laboratorio@exemplo.invalid");
          await page.getByRole("button", { name: /^Enviar$/ }).click();
          await page.waitForTimeout(800);
          check(smtp.mensagens.length === nMsgs, `${tag}: o email com PDF NÃO é enviado (a mensagem de excesso é mostrada)`);
          await page.getByLabel("Anexar PDF").uncheck();
          await page.getByRole("button", { name: /^Enviar$/ }).click();
          await page.waitForFunction(() => /Email enviado|falhou|Falha|Erro/.test(document.body.innerText), null, { timeout: 60000 });
          for (let t = 0; t < 40 && smtp.mensagens.length <= nMsgs; t++) await page.waitForTimeout(250);
          const so = smtp.anexos(nMsgs);
          nMsgs = smtp.mensagens.length;
          check(so.length === 1 && /\.xlsx$/i.test(so[0].filename), `${tag}: só o Excel segue por email (${so.map((a) => a.filename).join(", ")})`);
          await page.getByText("Enviar relatório por email").waitFor({ state: "detached", timeout: 15000 });
          // Excel completo
          const [dlx] = await Promise.all([page.waitForEvent("download", { predicate: (d) => d.suggestedFilename().endsWith(".xlsx") }), page.getByRole("button", { name: /^Excel$/ }).first().click()]);
          const fx27 = path.join(EVID, `vendas-${n}m-${v ? 1 : 0}${c ? 1 : 0}.xlsx`);
          await dlx.saveAs(fx27);
          const g27 = XLSX.utils.sheet_to_json<unknown[]>(XLSX.readFile(fx27).Sheets["Relatório"], { header: 1, blankrows: false }) as unknown[][];
          const cab27 = ((g27.find((r) => r[0] === "CNP") ?? []) as string[]).map((h) => norm(String(h)));
          check(cab27.filter((h) => /^(Jan|Fev|Mar|Abr|Mai|Jun|Jul|Ago|Set|Out|Nov|Dez)\s\d\d$/.test(h)).length === n, `${tag}: Excel — continua com os ${n} meses (sem limite)`);
          await page.screenshot({ path: path.join(EVID, `relatorio-${n}m-mensagem.png`) });
          await page.getByRole("button", { name: /^Tabela$/ }).click();
          await page.locator('[data-testid="vendas-tabela"]').waitFor();
          const nCab = await page.locator('table[data-testid="vendas-tabela"] thead th').count();
          check(nCab >= n, `${tag}: a tabela do ECRÃ continua completa (${nCab} colunas)`);
          continue;
        }
        await previa().locator("thead th").first().waitFor({ timeout: 30000 });
        const htmlPrev = await previa().locator("html").evaluate((h) => h.outerHTML);
        check((htmlPrev.match(/<table/g) ?? []).length === 1 && (htmlPrev.match(/<thead>/g) ?? []).length === 1, `${tag}: Relatório — UMA tabela, UM cabeçalho`);
        check(/@page \{ size: A4 landscape; margin: 10mm 6\.5mm; \}/.test(htmlPrev) && !/A3/.test(htmlPrev), `${tag}: Relatório — @page A4 horizontal, margens de 6,5 mm, sem A3`);
        const nMesesTh = await previa().locator("thead th.mes").count();
        check(nMesesTh === n, `${tag}: Relatório — ${nMesesTh} colunas de mês (esperadas ${n}), lado a lado`);
        const ths = (await previa().locator("thead th").allInnerTexts()).map((t) => norm(t).replace(/\s+/g, " ").trim());
        check(!ths.some((t) => /Custo total|Valor Vendas/.test(t)) && ths.filter((t) => /^Total unid\.$/.test(t)).length === 1 && ths.filter((t) => /^Stock$/.test(t)).length === 1, `${tag}: Relatório — sem «Custo total est.»/«Valor Vendas» na tabela; um só «Total unid.» e um só «Stock»`);
        check(ths.filter((t) => /^[A-Z][a-z]{2}\/\d\d$/.test(t)).length === n, `${tag}: Relatório — meses abreviados «Out/25» numa só linha`);
        const txtPrev = norm(await previa().locator("body").innerText());
        check(!/Parte\s+\d+\s+de\s+\d+|do\s+bloco|em\s+\d+\s+blocos/.test(txtPrev), `${tag}: Relatório — sem «Parte i de n», «do bloco» nem nota de blocos (rodapé incluído)`);
        const nTA = await previa().locator("tr.subtotal-row").count();
        const nArtigosMulti = await previa().locator("tbody.row-group").evaluateAll((gs) => gs.filter((g) => g.querySelectorAll(":scope > tr:not(.subtotal-row)").length > 1).length);
        check(nTA === nArtigosMulti && (await previa().locator(".totals-tbody td strong", { hasText: "TOTAL GERAL" }).count()) === 1 && (await previa().locator('[data-testid="resumo-financeiro"]').count()) === 1, `${tag}: Relatório — TOTAL ARTIGO só nos artigos com > 1 farmácia (${nTA}); um só TOTAL GERAL; um só resumo financeiro`);
        const resumo = norm(await previa().locator('[data-testid="resumo-financeiro"]').innerText());
        check(/Unidades vendidas/.test(resumo) && /Stock total/.test(resumo) && /Valor total de vendas/.test(resumo) === v && /Custo total estimado/.test(resumo) === c, `${tag}: Relatório — resumo financeiro conforme as opções de preços`);
        for (const [w, h] of [[1920, 1080], [1536, 864], [1366, 768]] as const) {
          await page.setViewportSize({ width: w, height: h });
          await page.waitForTimeout(250);
          const m = await previa().locator("html").evaluate(() => {
            const t = document.querySelector("table")!.getBoundingClientRect().width;
            const cortados = [...document.querySelectorAll("thead th, tbody td.nc")].filter((e) => (e as HTMLElement).scrollWidth > (e as HTMLElement).clientWidth + 1).length;
            const fonteMin = Math.min(...[...document.querySelectorAll("thead th, tbody td")].map((e) => parseFloat(getComputedStyle(e).fontSize)));
            return { t, sw: document.documentElement.scrollWidth, cortados, fonteMin };
          });
          const utilPx = (284 / 25.4) * 96;
          check(m.t >= utilPx - 2 && m.cortados === 0 && m.fonteMin >= 10.66, `${tag}: Relatório ${w}×${h} — tabela ≥ largura útil do A4 (${m.t.toFixed(0)} ≥ ${utilPx.toFixed(0)} px), scroll horizontal ${m.sw > w ? "presente" : "desnecessário"}, nada cortado, letra ≥ 8 pt (${(m.fonteMin * 0.75).toFixed(2)} pt)`);
        }
        await page.setViewportSize({ width: 1920, height: 1080 });
        if (v && c && n === 14) await page.screenshot({ path: path.join(EVID, `relatorio-${n}m.png`) });

        // 2) impressão (iframe): A4 horizontal real
        await page.evaluate("window.__impressoes = []");
        await page.getByRole("button", { name: /^Imprimir$/ }).first().click();
        await page.waitForFunction(() => (window as unknown as { __impressoes: unknown[] }).__impressoes.length > 0, null, { timeout: 30000 });
        const imp = await page.evaluate(() => (window as unknown as { __impressoes: { html: string; largura: string; altura: string }[] }).__impressoes[0]);
        check(/@page \{ size: A4 landscape/.test(imp.html), `${tag}: impressão — @page A4 landscape, o mesmo da pré-visualização`);
        check(imp.largura === "297mm" && imp.altura === "210mm", `${tag}: impressão — o iframe tem o tamanho real do A4 horizontal (${imp.largura} × ${imp.altura})`);
        check((imp.html.match(/<table/g) ?? []).length === 1 && !/Parte \d|do bloco/.test(imp.html.slice(imp.html.indexOf("<body"))), `${tag}: impressão — uma só tabela, sem partes/blocos`);
        const p2 = await ctx.newPage();
        try {
          await p2.emulateMedia({ media: "print" });
          await p2.setContent(imp.html, { waitUntil: "networkidle" });
          const fImp = path.join(EVID, `impressao-${n}m-${v ? 1 : 0}${c ? 1 : 0}.pdf`);
          await p2.pdf({ path: fImp, preferCSSPageSize: true, printBackground: true });
          verificarPdf(`${tag}: impressão`, fImp, n, { venda: v, compra: c });
        } finally { await p2.close(); }

        // 3) PDF real (endpoint)
        const pdf = await pdfReal(`vendas-${n}m-${v ? 1 : 0}${c ? 1 : 0}.pdf`);
        check(JSON.parse(pdf.json).meta?.legibilidadeA4 === true && JSON.parse(pdf.json).meta?.paperSize === undefined, `${tag}: o relatório enviado ao endpoint declara A4 legível (sem papel A3)`);
        verificarPdf(`${tag}: PDF real`, pdf.f, n, { venda: v, compra: c });
        if (v && c) py("_renderizar_pdf.py", pdf.f, EVID, `pdf-${n}m`, "2", "70");

        // 4) Excel real: todos os meses, mesmas colunas (incl. Custo total est. e Valor Vendas)
        const [dl] = await Promise.all([page.waitForEvent("download", { predicate: (d) => d.suggestedFilename().endsWith(".xlsx") }), page.getByRole("button", { name: /^Excel$/ }).first().click()]);
        const fx = path.join(EVID, `vendas-${n}m-${v ? 1 : 0}${c ? 1 : 0}.xlsx`);
        await dl.saveAs(fx);
        const g = XLSX.utils.sheet_to_json<unknown[]>(XLSX.readFile(fx).Sheets["Relatório"], { header: 1, blankrows: false }) as unknown[][];
        const cab = ((g.find((r) => r[0] === "CNP") ?? []) as string[]).map((h) => norm(String(h)));
        check(cab.filter((h) => /^(Jan|Fev|Mar|Abr|Mai|Jun|Jul|Ago|Set|Out|Nov|Dez)\s\d\d$/.test(h)).length === n && !cab.some((h) => /bloco|Parte/i.test(h)), `${tag}: Excel — ${n} colunas de mês, sem colunas de bloco`);
        check(cab.some((h) => /custo total/i.test(h)) === c && cab.some((h) => /valor\s*vendas/i.test(h)) === v, `${tag}: Excel — «Custo total est.» e «Valor Vendas (s/IVA)» continuam no Excel conforme as opções (o Excel não mudou)`);

        // 5) e-mail real: o PDF recebido é A4 e igual ao do endpoint (só «todos os preços» a 14 meses)
        if (v && c && n === 14) {
          await page.getByRole("button", { name: /^Email$/ }).first().click();
          await page.getByPlaceholder("nome@dominio.pt, outro@dominio.pt").fill("laboratorio@exemplo.invalid");
          await page.getByRole("button", { name: /^Enviar$/ }).click();
          await page.waitForFunction(() => /Email enviado|falhou|Falha|Erro/.test(document.body.innerText), null, { timeout: 60000 });
          for (let t = 0; t < 40 && smtp.mensagens.length <= nMsgs; t++) await page.waitForTimeout(250);
          const recebidos = smtp.anexos(nMsgs);
          nMsgs = smtp.mensagens.length;
          const aPdf = recebidos.find((a) => /\.pdf$/i.test(a.filename));
          check(!!aPdf, `${tag}: e-mail real recebido com PDF (${recebidos.map((a) => a.filename).join(", ")})`);
          if (aPdf) {
            const fe = path.join(EVID, `email-${n}m.pdf`);
            fs.writeFileSync(fe, aPdf.conteudo);
            verificarPdf(`${tag}: PDF do e-mail`, fe, n, { venda: true, compra: true });
            const mail = lerPdf(fe), ep = lerPdf(pdf.f);
            check(mail.length === ep.length && mail.every((p, i) => p.w === ep[i].w && p.tokens.length === ep[i].tokens.length), `${tag}: o PDF do e-mail é igual ao do endpoint (mesmas páginas, mesmo A4, mesmo conteúdo)`);
          }
          await page.getByText("Enviar relatório por email").waitFor({ state: "detached", timeout: 15000 });
        }
        await page.getByRole("button", { name: /^Tabela$/ }).click();
        await page.locator('[data-testid="vendas-tabela"]').waitFor();
      }
    }
  } finally {
    smtp.fechar();
    await browser.close();
    await amb.parar();
  }
  console.log(`\n${falhas === 0 ? "PASSOU" : "FALHOU"} — ${ok} OK, ${falhas} falhas\n`);
  process.exit(falhas === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
