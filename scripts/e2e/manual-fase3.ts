/** Manual — fase 3: capítulos 12 (saídas), 13 (filtros), 14 (separadores) e a ficha em painel (cap. 3). */
import fs from "node:fs";
import path from "node:path";
import { iniciar, registar, gravarFacts, marcar, limparMarcas, foto, caixaDe, tentar, texto, OUT } from "./_manual-base";
import type { Page } from "playwright";

const GERAR = /^(Gerar|Atualizar|Gerar relatório)$/;
const botoes = (pg: Page) => pg.getByRole("button").allInnerTexts().then((a) => a.map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean));
const resumo = async (pg: Page) => (await pg.locator("main").innerText()).split("\n").filter((l) => /^\s*\d[\d  ]* linhas$|unidades|^\d+ de \d+ artigos/.test(l.trim())).slice(0, 3).join(" | ");

async function main() {
  const A = await iniciar("m3");
  const { abrir, ctx } = A;
  try {
    // ── ficha do artigo em painel (cap. 3) ─────────────────────────────
    let pg = await abrir("/stock");
    const campo = pg.getByPlaceholder(/Pesquisar produto/);
    await campo.fill("AMOXICILINA"); await campo.press("Enter"); await pg.waitForTimeout(2500);
    const lig = pg.locator("table tbody tr a").first();
    registar("stock_link_ficha_href", await lig.getAttribute("href").catch(() => null));
    await tentar("ficha_painel", async () => {
      await lig.click(); await pg.waitForTimeout(2200);
      registar("ficha_painel_url", pg.url());
      registar("ficha_painel_texto", (await texto(pg, "body")).slice(-3200));
      registar("ficha_painel_botoes", (await botoes(pg)).slice(-12));
      await foto(pg, "cap3-ficha-painel", { x: 640, y: 0, width: 800, height: 900 });
      await pg.getByRole("button", { name: /Manter como tarefa/ }).click(); await pg.waitForTimeout(2500);
      registar("ficha_tarefa_url", pg.url());
    });
    await pg.close();

    // ── cap. 12 · saídas (Vendas) ──────────────────────────────────────
    pg = await abrir("/vendas");
    await pg.evaluate(() => { (window as unknown as { __imp: number }).__imp = 0; window.print = () => { (window as unknown as { __imp: number }).__imp++; }; });
    await pg.getByRole("button", { name: /^Gerar$/ }).first().click(); await pg.waitForTimeout(4500);
    await tentar("imprimir", async () => {
      await pg.getByRole("button", { name: "Imprimir", exact: true }).click(); await pg.waitForTimeout(4000);
      registar("imprimir_window_print", await pg.evaluate(() => (window as unknown as { __imp: number }).__imp));
      registar("imprimir_texto", (await texto(pg, "body")).slice(0, 300));
    });
    for (const [n, re] of [["PDF", /\.pdf$/i], ["Excel", /\.xlsx?$/i]] as const) {
      await tentar(`dl_${n}`, async () => {
        const [dl] = await Promise.all([pg.waitForEvent("download", { timeout: 60000 }), pg.getByRole("button", { name: n, exact: true }).click()]);
        const f = path.join(OUT, `dl-${n}${path.extname(dl.suggestedFilename())}`);
        await dl.saveAs(f);
        registar(`dl_${n}`, { nome: dl.suggestedFilename(), bytes: fs.statSync(f).size, ext_ok: re.test(dl.suggestedFilename()) });
      });
    }
    await tentar("email", async () => {
      await pg.getByRole("button", { name: "Email", exact: true }).click(); await pg.waitForTimeout(1200);
      registar("email_dialogo", (await texto(pg, "body")).slice(-1500));
      const dlg = pg.getByText("Enviar relatório por email").first();
      const bx = await caixaDe(pg, [pg.locator("[role=dialog], div.fixed").last()], 10);
      await foto(pg, "cap12-email", bx);
      await pg.getByRole("button", { name: "Cancelar" }).first().click();
      void dlg;
    });
    registar("saidas_botoes", (await botoes(pg)).filter((b) => /Imprimir|PDF|Excel|Email|preços/i.test(b)));
    await marcar(pg, [
      { loc: pg.getByRole("button", { name: "Imprimir", exact: true }), n: 1 },
      { loc: pg.getByRole("button", { name: "PDF", exact: true }), n: 2 },
      { loc: pg.getByRole("button", { name: "Excel", exact: true }), n: 3 },
      { loc: pg.getByRole("button", { name: "Email", exact: true }), n: 4 },
      { loc: pg.getByText("Incluir preços de venda").first(), n: 5, dx: -10, dy: -14 },
    ]);
    const bx2 = await caixaDe(pg, [pg.getByRole("button", { name: "Imprimir", exact: true }), pg.getByText("Incluir preços de venda").first(), pg.getByRole("button", { name: /Criar encomenda/ })], 30);
    await foto(pg, "cap12-saidas", bx2);
    await limparMarcas(pg);

    // ── cap. 13 · filtros (Vendas) ─────────────────────────────────────
    await pg.getByRole("button", { name: /^Filtros/ }).first().click(); await pg.waitForTimeout(900);
    registar("filtros_painel", (await texto(pg)).slice(0, 2600));
    registar("filtros_base_resumo", await resumo(pg));
    const painel = pg.locator("main").first();
    await foto(pg, "cap13-filtros-painel-raw", { x: 242, y: 64, width: 1198, height: 836 });
    // Genérico
    await tentar("f_generico", async () => {
      await pg.locator('[data-testid="filtro-generico"] button[data-valor="GENERICO"]').click(); await pg.waitForTimeout(500);
      await pg.getByRole("button", { name: /^Atualizar$/ }).first().click(); await pg.waitForTimeout(4000);
      registar("f_generico_resumo", await resumo(pg));
      registar("f_chips", (await texto(pg)).match(/Genérico: [^\n]+/g));
    });
    await tentar("f_limpar", async () => {
      await pg.getByRole("button", { name: /Limpar filtros/ }).first().click(); await pg.waitForTimeout(800);
      await pg.getByRole("button", { name: /^Atualizar$/ }).first().click(); await pg.waitForTimeout(4000);
      registar("f_limpar_resumo", await resumo(pg));
    });
    // Forma farmacêutica
    await tentar("f_forma", async () => {
      await pg.getByText("Xarope", { exact: false }).first().click(); await pg.waitForTimeout(500);
      await pg.getByRole("button", { name: /^Atualizar$/ }).first().click(); await pg.waitForTimeout(4000);
      registar("f_forma_resumo", await resumo(pg));
      registar("f_forma_chips", (await texto(pg)).match(/Forma: [^\n]+/g));
    });
    await tentar("f_limpar2", async () => { await pg.getByRole("button", { name: /Limpar filtros/ }).first().click(); await pg.waitForTimeout(600); });
    // Ético / NETT
    await tentar("f_etico", async () => {
      await pg.getByText("NETT", { exact: true }).first().click(); await pg.waitForTimeout(500);
      await pg.getByRole("button", { name: /^Atualizar$/ }).first().click(); await pg.waitForTimeout(4000);
      registar("f_nett_resumo", await resumo(pg));
      registar("f_nett_chips", (await texto(pg)).match(/Ético\/NETT: [^\n]+/g));
    });
    await tentar("f_limpar3", async () => { await pg.getByRole("button", { name: /Limpar filtros/ }).first().click(); await pg.waitForTimeout(600); });
    // Fabricante
    await tentar("f_fabricante", async () => {
      const cx = pg.getByPlaceholder(/Pesquisar Fabricante|Fabricante/).first();
      await cx.fill("ALFA"); await pg.waitForTimeout(700);
      registar("f_fab_sugestoes", (await texto(pg)).slice(-500));
      await pg.getByText("LABORATORIO ALFA", { exact: false }).first().click(); await pg.waitForTimeout(600);
      await pg.getByRole("button", { name: /^Atualizar$/ }).first().click(); await pg.waitForTimeout(4000);
      registar("f_fab_resumo", await resumo(pg));
    });
    // Lista de códigos
    await tentar("f_lista", async () => {
      await pg.getByRole("button", { name: /Limpar filtros/ }).first().click(); await pg.waitForTimeout(600);
      const f = path.join(OUT, "lista-codigos.txt");
      fs.writeFileSync(f, "7100001\n7100002\n7100003\n7999999\n");
      const inp = pg.locator('input[type="file"]').first();
      await inp.setInputFiles(f); await pg.waitForTimeout(2500);
      registar("f_lista_texto", (await texto(pg)).match(/Lista importada[^\n]*[\s\S]{0,300}/)?.[0]);
      await pg.getByRole("button", { name: /^Atualizar$/ }).first().click(); await pg.waitForTimeout(4000);
      registar("f_lista_resumo", await resumo(pg));
    });
    await pg.close();

    // ── cap. 14 · espaços de trabalho e separadores ────────────────────
    pg = await abrir("/dashboard");
    registar("sep_inicial", await pg.locator('[data-testid="task-bar"], nav[aria-label*="eparador"], div:has(> button:has-text("Dashboard"))').first().innerText().catch(() => ""));
    for (const nome of ["Stock", "Vendas"]) { await pg.locator("aside nav").getByRole("link", { name: nome, exact: true }).click(); await pg.waitForTimeout(2500); }
    registar("sep_apos_navegar", (await texto(pg, "body")).slice(0, 700));
    registar("sep_url_vendas", pg.url());
    await tentar("nova_analise", async () => {
      await pg.getByText("Nova análise").first().click(); await pg.waitForTimeout(2500);
      registar("sep_nova_url", pg.url());
      registar("sep_nova_texto", (await texto(pg, "body")).slice(0, 600));
      await pg.locator("input[type=date]").first().fill("2026-03-01"); await pg.waitForTimeout(500);
      await pg.getByRole("button", { name: /^Gerar$/ }).first().click(); await pg.waitForTimeout(4000);
      registar("sep_nova_resumo", await resumo(pg));
      await foto(pg, "cap14-separadores", { x: 242, y: 64, width: 1198, height: 160 });
      // voltar ao primeiro separador de Vendas
      const abas = pg.locator("a, button").filter({ hasText: /^Vendas/ });
      registar("sep_abas_vendas", await abas.allInnerTexts());
      await abas.first().click(); await pg.waitForTimeout(1500);
      registar("sep_primeira_aba_data", await pg.locator("input[type=date]").first().inputValue());
      registar("sep_primeira_aba_resumo", await resumo(pg));
      await pg.reload({ waitUntil: "networkidle" }); await pg.waitForTimeout(1500);
      registar("sep_apos_f5_data", await pg.locator("input[type=date]").first().inputValue());
      registar("sep_apos_f5_texto", (await texto(pg)).includes("Nenhum relatório gerado ainda"));
    });
    registar("sep_fechar_botoes", await pg.locator("[aria-label^='Fechar']").evaluateAll((e) => e.map((x) => x.getAttribute("aria-label"))));
    await pg.close();
    console.log("FEITO");
  } finally {
    gravarFacts("fase3");
    await A.parar();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
