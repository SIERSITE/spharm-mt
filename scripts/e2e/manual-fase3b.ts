/** Manual — fase 3b: ficha em painel, impressão, email, filtro Fabricante, persistência após F5, regra da password. */
import { iniciar, registar, gravarFacts, marcar, limparMarcas, foto, caixaDe, tentar, texto } from "./_manual-base";
import type { Page } from "playwright";

const botoes = (pg: Page) => pg.getByRole("button").allInnerTexts().then((a) => a.map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean));
const resumo = async (pg: Page) => (await pg.locator("main").innerText()).split("\n").filter((l) => /^\s*\d[\d  ]* linhas$/.test(l.trim())).slice(0, 1).join("");

async function main() {
  const A = await iniciar("m3b");
  const { abrir, novoCtx } = A;
  try {
    // ficha em painel
    let pg = await abrir("/stock");
    const campo = pg.getByPlaceholder(/Pesquisar produto/);
    await campo.fill("AMOXICILINA EXEMPLO 250"); await campo.press("Enter"); await pg.waitForTimeout(2500);
    await tentar("ficha", async () => {
      await pg.getByText(/AMOXICILINA EXEMPLO 250 MG 20 CMP/).first().click(); await pg.waitForTimeout(2500);
      registar("ficha_url", pg.url());
      registar("ficha_painel_texto", (await texto(pg, "body")).slice(-2600));
      registar("ficha_painel_botoes", (await botoes(pg)).slice(-8));
      await foto(pg, "cap3-ficha-painel", { x: 640, y: 0, width: 800, height: 900 });
      await pg.getByRole("button", { name: /Manter como tarefa/ }).click(); await pg.waitForTimeout(2500);
      registar("ficha_tarefa_url", pg.url());
    });
    await pg.close();

    // impressão (iframe oculto) e email
    pg = await abrir("/vendas");
    await pg.addInitScript("");
    await pg.evaluate(() => {
      (window as unknown as { __imp: number }).__imp = 0;
      const d = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentWindow")!;
      Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", { get() { const w = d.get!.call(this) as Window & { __p?: number }; if (w && !w.__p) { w.__p = 1; w.print = () => { (window as unknown as { __imp: number }).__imp++; }; } return w; } });
    });
    await pg.getByRole("button", { name: /^Gerar$/ }).first().click(); await pg.waitForTimeout(4500);
    await pg.getByRole("button", { name: "Imprimir", exact: true }).click(); await pg.waitForTimeout(4000);
    registar("imprimir_chamadas", await pg.evaluate(() => (window as unknown as { __imp: number }).__imp));
    await pg.getByRole("button", { name: "Email", exact: true }).click(); await pg.waitForTimeout(1200);
    const dlg = pg.locator("div.fixed", { hasText: "Destinatários" }).last();
    registar("email_dialogo", limpaT(await dlg.innerText()));
    await foto(pg, "cap12-email", await caixaDe(pg, [dlg], 6));
    await pg.getByRole("button", { name: "Cancelar" }).first().click();
    await pg.close();

    // filtro Fabricante + persistência após F5
    pg = await abrir("/vendas");
    await pg.getByRole("button", { name: /^Gerar$/ }).first().click(); await pg.waitForTimeout(4000);
    await pg.getByRole("button", { name: /^Filtros/ }).first().click(); await pg.waitForTimeout(700);
    await tentar("fabricante", async () => {
      await pg.getByText("LABORATORIO ALFA", { exact: true }).first().click(); await pg.waitForTimeout(500);
      await pg.getByRole("button", { name: /^Atualizar$/ }).first().click(); await pg.waitForTimeout(4000);
      registar("f_fab_resumo", await resumo(pg));
      registar("f_fab_chips", (await texto(pg)).match(/Fabricante: [^\n]+/g));
    });
    await pg.locator("input[type=date]").first().fill("2026-03-01"); await pg.waitForTimeout(500);
    await pg.reload({ waitUntil: "networkidle" }); await pg.waitForTimeout(1500);
    registar("f5_data", await pg.locator("input[type=date]").first().inputValue());
    registar("f5_sem_relatorio", (await texto(pg)).includes("Nenhum relatório gerado ainda"));
    registar("f5_chip_fabricante", (await texto(pg)).match(/Fabricante: [^\n]+/g));
    await pg.close();

    // password: regra do comprimento
    pg = await abrir("/alterar-password");
    const c = pg.locator("main input[type=password]");
    await c.nth(0).fill("Antiga-12345!"); await c.nth(1).fill("curta"); await c.nth(2).fill("curta");
    await pg.getByRole("button", { name: /Guardar nova password/ }).click(); await pg.waitForTimeout(1500);
    registar("pw_curta", (await texto(pg)).slice(0, 500));
    await pg.close();

    // Operador: Stock sem «Criar produto»? (menu mantém-se)
    const co = await novoCtx("OPERADOR", A.ids[1]);
    pg = await abrir("/stock", co);
    registar("operador_stock_botoes", (await botoes(pg)).filter((b) => /Criar produto|Sincronizar/i.test(b)));
    await pg.close(); await co.close();
    console.log("FEITO");
  } finally {
    gravarFacts("fase3b");
    await A.parar();
  }
}
const limpaT = (t: string) => t.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
main().catch((e) => { console.error(e); process.exit(1); });
