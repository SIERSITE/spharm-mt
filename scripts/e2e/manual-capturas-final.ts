/** Manual — capturas DEFINITIVAS (dados sintéticos). Cada imagem num contexto limpo; recortes focados; números sobre a imagem. */
import fs from "node:fs";
import path from "node:path";
import { iniciar, registar, gravarFacts, marcar, limparMarcas, foto, caixaDe, tentar, texto, IMG, OUT } from "./_manual-base";
import type { BrowserContext, Page } from "playwright";

const GERAR = /^(Gerar|Atualizar|Gerar relatório)$/;
const VP = { width: 1120, height: 1000 };

async function main() {
  const A = await iniciar("mf");
  const { amb, ids, novoCtx, url } = A;
  const prisma = amb.prisma;
  try {
    // ── dados sintéticos adicionais ────────────────────────────────────
    await prisma.$executeRawUnsafe(`UPDATE "ListaEncomenda" SET nome = replace(replace(nome,'E2E','exemplo'),'LONGO','extenso')`);
    const f1 = await prisma.fornecedor.create({ data: { nomeNormalizado: "DISTRIBUIDORA NORTE", nome: "Distribuidora Norte" } });
    const f2 = await prisma.fornecedor.create({ data: { nomeNormalizado: "DISTRIBUIDORA SUL", nome: "Distribuidora Sul" } });
    const agora = Date.now();
    for (let i = 1; i <= 8; i++) {
      const p = await prisma.produto.findUniqueOrThrow({ where: { cnp: 7100000 + i } });
      await tentar(`dev${i}`, () => prisma.devolucao.create({ data: { farmaciaId: ids[i % 2], produtoId: p.id, data: new Date(agora - i * 5 * 86_400_000), quantidade: 2 + i, valor: (2 + i) * 6, tipo: "FORNECEDOR", motivo: i % 2 ? "Embalagem danificada" : "Fim de validade", fornecedorDestinoId: i % 3 ? f1.id : f2.id } }));
    }
    const p1 = await prisma.produto.findUniqueOrThrow({ where: { cnp: 7100001 } });
    for (const [i, tipo, q, ex, h] of [[1, "COMPRA", 60, 460, 288], [2, "VENDA", -8, 452, 216], [3, "VENDA", -5, 447, 144], [4, "ACERTO_STOCK", -2, 445, 72]] as const) {
      await tentar(`mov${i}`, () => prisma.movimentoArtigo.create({ data: { farmaciaId: ids[0], externalMovId: 9000 + i, externalProductId: String(p1.cnp), produtoId: p1.id, dataMovimento: new Date(agora - h * 3_600_000), tipo, quantidade: q, existenciaApos: ex, custoUnitario: 6, pmcAnterior: 6, pmcNovo: 6, armazemId: 1, documentoTipo: tipo === "COMPRA" ? "Recepção" : tipo === "VENDA" ? "Factura" : "Acerto", documentoNumero: `G/${1000 + i}` } }));
    }

    /** Executa `f` numa página de um contexto limpo (um só separador na barra). */
    async function fresco(rota: string, f: (pg: Page, c: BrowserContext) => Promise<void>, perfil = "ADMINISTRADOR", vp = VP, farm: string | null = null) {
      const c = await novoCtx(perfil, farm, vp);
      const pg = await c.newPage();
      await pg.setViewportSize(vp);
      await pg.goto(url(rota), { waitUntil: "domcontentloaded", timeout: 90000 });
      await pg.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
      await pg.waitForTimeout(700);
      try { await f(pg, c); } catch (e) { registar(`ERRO_${rota}`, String((e as Error).message).split("\n")[0].slice(0, 200)); }
      await pg.close(); await c.close();
    }
    const ocultar = (pg: Page, sel: string[]) => pg.evaluate((s) => { for (const q of s) document.querySelectorAll(q).forEach((e) => ((e as HTMLElement).style.display = "none")); }, sel);
    const ocultarBanner = (pg: Page, inicio: string) => pg.evaluate((t) => {
      document.querySelectorAll("div, p").forEach((e) => { if ((e.textContent ?? "").trim().startsWith(t) && e.closest("[class*=amber]") === e) (e as HTMLElement).style.display = "none"; });
      document.querySelectorAll("[class*=amber]").forEach((e) => { if ((e.textContent ?? "").includes("StagingCompraRawLine")) (e as HTMLElement).style.display = "none"; });
    }, inicio);
    const ocultarTexto = (pg: Page, re: string) => pg.evaluate((r) => {
      const rx = new RegExp(r);
      document.querySelectorAll("p, div, li, span").forEach((e) => { if (e.children.length === 0 && rx.test(e.textContent ?? "")) { let n: HTMLElement | null = e as HTMLElement; for (let i = 0; i < 2 && n?.parentElement && n.parentElement.tagName !== "MAIN"; i++) n = n.parentElement; (n as HTMLElement).style.display = "none"; } });
    }, re);
    const gerar = async (pg: Page, t = 4500) => { await pg.getByRole("button", { name: GERAR }).first().click(); await pg.waitForTimeout(t); };
    const M = { x: 242, y: 64, width: 878 };

    // 1 · login
    {
      const c = await A.browser.newContext({ viewport: { width: 1440, height: 900 } });
      await c.addInitScript("window.__name = (f) => f;");
      const pg = await c.newPage();
      await pg.goto(url("/login"), { waitUntil: "networkidle" });
      await pg.fill('input[name="email"]', "utilizador@exemplo.pt");
      await pg.fill('input[name="password"]', "exemplo-123");
      await foto(pg, "cap1-login", await caixaDe(pg, [pg.locator("form").first().locator("xpath=ancestor::div[contains(@class,'rounded')][1]")], 0));
      await c.close();
    }
    // 2 · menu
    await fresco("/dashboard", async (pg) => {
      await ocultarTexto(pg, "^Integração$|^Manutenção do catálogo$");
      await foto(pg, "cap1-menu", { x: 0, y: 0, width: 242, height: 1000 });
    }, "ADMINISTRADOR", { width: 1120, height: 1320 });
    // 3 · menu móvel
    await fresco("/dashboard", async (pg) => {
      await pg.getByTestId("menu-movel-abrir").click(); await pg.waitForTimeout(600);
      await ocultarTexto(pg, "^Integração$|^Manutenção do catálogo$");
      await foto(pg, "cap1-menu-movel", { x: 0, y: 0, width: 390, height: 844 });
    }, "ADMINISTRADOR", { width: 390, height: 844 });
    // 4 · dashboard
    await fresco("/dashboard", async (pg) => { await foto(pg, "cap2-dashboard", { ...M, y: 64, height: 640 }); });

    // 5 · stock
    await fresco("/stock", async (pg) => {
      await ocultarTexto(pg, "SINCRONIZAR AGORA|Sincronizar agora|Última sincronização|long-polling");
      const campo = pg.getByPlaceholder(/Pesquisar produto/);
      await campo.fill("AMOXICILINA EXEMPLO 250"); await campo.press("Enter"); await pg.waitForTimeout(2500);
      await ocultarTexto(pg, "long-polling|Sincronizar agora|Última sincronização");
      const alvo = pg.locator("table tbody tr").first();
      await marcar(pg, [{ loc: campo, n: 1 }, { loc: pg.getByRole("button", { name: /^Filtros/ }).first(), n: 2 }, { loc: alvo, n: 3, dx: -6, dy: -4 }]);
      const cartoes = pg.getByText("REFERÊNCIAS ANALISADAS", { exact: false }).first();
      const bb = await cartoes.boundingBox();
      const y0 = Math.max(0, (bb?.y ?? 300) - 24);
      await foto(pg, "cap3-stock", { x: 242, y: y0, width: 878, height: 640 });
    });
    // 6 · ficha em painel
    await fresco("/stock?q=AMOXICILINA+EXEMPLO+250&ficha=7100012", async (pg) => { await pg.waitForTimeout(1500); await foto(pg, "cap3-ficha", { x: 580, y: 0, width: 540, height: 1000 }); });
    // 7 · extrato (página completa; sem texto técnico)
    await fresco("/stock/artigo/7100001", async (pg) => {
      await pg.evaluate(() => document.querySelectorAll("p, span, div").forEach((e) => { if (e.children.length === 0 && /pipeline de movimentos|Espelho do relatório/.test(e.textContent ?? "")) (e as HTMLElement).style.display = "none"; }));
      const sec = pg.getByText("Extrato de movimentos").first();
      await sec.scrollIntoViewIfNeeded();
      const tab = pg.locator("table").last();
      const b = await caixaDe(pg, [sec, tab], 16);
      await foto(pg, "cap3-extrato", { ...b, x: Math.max(242, b.x), width: 878 });
    });
    // 8 · devoluções
    await fresco("/devolucoes", async (pg) => {
      await gerar(pg);
      await marcar(pg, [{ loc: pg.locator("input[type=date]").first(), n: 1 }, { loc: pg.getByRole("button", { name: GERAR }).first(), n: 2 }]);
      await foto(pg, "cap4-devolucoes", { ...M, height: 640 });
    });
    // 9 · catálogo
    await fresco("/catalogo", async (pg) => { await foto(pg, "cap5-catalogo", { ...M, height: 600 }); });
    // 10 · criar produto
    await fresco("/produtos/criar", async (pg) => {
      const ins = pg.locator("main input[type=text], main input:not([type])");
      await ins.nth(0).fill("7999001"); await ins.nth(1).fill("PRODUTO NOVO EXEMPLO 10 MG");
      await marcar(pg, [{ loc: ins.nth(0), n: 1 }, { loc: ins.nth(1), n: 2 }, { loc: pg.getByRole("button", { name: "Criar produto", exact: true }), n: 3 }]);
      await foto(pg, "cap5-criar-produto", { ...M, height: 700 });
    });

    // 11–13 · vendas
    await fresco("/vendas", async (pg, c) => {
      const sel = (t: string) => pg.locator("label", { hasText: t }).first().locator("select, input").first();
      await marcar(pg, [
        { loc: sel("Âmbito da análise"), n: 1 }, { loc: sel("Data início"), n: 2 }, { loc: sel("Agrupar por"), n: 3 },
        { loc: pg.getByRole("button", { name: /^Filtros/ }), n: 4 }, { loc: pg.getByRole("button", { name: "Gerar", exact: true }), n: 5 },
      ]);
      await foto(pg, "cap6-vendas-form", { x: 242, y: 130, width: 878, height: 560 });
      await limparMarcas(pg);
      await gerar(pg);
      await pg.evaluate(() => { const t = document.querySelector("table thead") as HTMLElement; window.scrollTo(0, t.getBoundingClientRect().top + window.scrollY - 330); const k = document.querySelector("[data-scroll-key]") as HTMLElement | null; if (k) k.scrollLeft = k.scrollWidth; });
      await pg.waitForTimeout(700);
      const th = (re: RegExp) => pg.locator("table thead th", { hasText: re }).first();
      await marcar(pg, [{ loc: th(/Total Unid/i), n: 1, dx: -12, dy: -14 }, { loc: th(/^\s*Stock/i), n: 2, dx: -12, dy: -14 }, { loc: th(/Vendas s\/IVA/i), n: 3, dx: -12, dy: -14 }]);
      await foto(pg, "cap6-vendas-tabela", { x: 242, y: 250, width: 878, height: 480 });
      await limparMarcas(pg);
      // saídas e preços
      await pg.evaluate(() => window.scrollTo(0, 0)); await pg.waitForTimeout(500);
      await marcar(pg, [
        { loc: pg.getByRole("button", { name: "Imprimir", exact: true }), n: 1 }, { loc: pg.getByRole("button", { name: "PDF", exact: true }), n: 2 },
        { loc: pg.getByRole("button", { name: "Excel", exact: true }), n: 3 }, { loc: pg.getByRole("button", { name: "Email", exact: true }), n: 4 },
        { loc: pg.getByText("Incluir preços de venda").first(), n: 5, dx: -12, dy: -12 }, { loc: pg.getByRole("button", { name: /Criar encomenda/ }), n: 6 },
      ]);
      const bx = await caixaDe(pg, [pg.getByRole("button", { name: "Imprimir", exact: true }), pg.getByText("Incluir preços de venda").first(), pg.getByRole("button", { name: /Criar encomenda/ })], 26);
      await foto(pg, "cap12-saidas", bx);
      await limparMarcas(pg);
      await pg.getByRole("button", { name: "Email", exact: true }).click(); await pg.waitForTimeout(1000);
      const dlg = pg.locator("div.fixed", { hasText: "Destinatários" }).last();
      await foto(pg, "cap12-email", await caixaDe(pg, [dlg.locator("> div").first()], 0));
      await pg.getByRole("button", { name: "Cancelar" }).first().click(); await pg.waitForTimeout(400);
      await pg.getByRole("button", { name: /Criar encomenda/ }).click(); await pg.waitForTimeout(900);
      const dlg2 = pg.locator("div.fixed", { hasText: "PRETENDO ENCOMENDAR" }).last();
      await foto(pg, "cap6-vendas-modal", await caixaDe(pg, [dlg2.locator("> div").first()], 8));
      await c.storageState();
    });
    // 14 · manutenção de vendas
    await fresco("/vendas/manutencao/nova", async (pg) => {
      await pg.getByPlaceholder(/Procurar por CNP/).fill("7100001"); await pg.waitForTimeout(1500);
      await pg.getByText(/CNP 7100001/).first().click(); await pg.waitForTimeout(800);
      const num = pg.locator("main input[type=number]");
      await num.nth(0).fill("120"); await num.nth(1).fill("3");
      await pg.getByRole("button", { name: /Calcular distribuição/ }).click(); await pg.waitForTimeout(3000);
      await marcar(pg, [{ loc: pg.getByPlaceholder(/Procurar por CNP/), n: 1 }, { loc: num.nth(0), n: 2 }, { loc: num.nth(1), n: 3 }, { loc: pg.getByRole("button", { name: /Recalcular pelo histórico/ }), n: 4 }, { loc: pg.getByRole("button", { name: /^Gravar$/ }), n: 5 }]);
      await foto(pg, "cap6-mv-form", { ...M, height: 800 });
    });

    // 15 · margens (sem o aviso técnico)
    await fresco("/relatorios/margens", async (pg) => {
      await gerar(pg);
      await ocultarBanner(pg, "");
      await marcar(pg, [{ loc: pg.locator("input[type=date]").first(), n: 1 }, { loc: pg.getByRole("button", { name: /^(Gerar|Atualizar)$/ }).first(), n: 2 }, { loc: pg.getByRole("button", { name: /Totais por categoria/ }), n: 3 }, { loc: pg.getByRole("button", { name: /^Fiável/ }).first(), n: 4 }]);
      await foto(pg, "cap7-margens", { ...M, height: 640 });
    });
    // 16 · inventário (sem o aviso técnico)
    await fresco("/relatorios/inventario", async (pg) => {
      await gerar(pg);
      await ocultarBanner(pg, "");
      await marcar(pg, [{ loc: pg.getByRole("button", { name: GERAR }).first(), n: 1 }, { loc: pg.getByRole("button", { name: "Por produto" }).first(), n: 2 }, { loc: pg.getByRole("button", { name: /^Rotura/ }).first(), n: 3 }]);
      await foto(pg, "cap8-inventario", { ...M, height: 640 });
    });
    // 17 · excessos
    await fresco("/excessos", async (pg) => {
      await gerar(pg);
      await marcar(pg, [{ loc: pg.locator("input[type=date]").first(), n: 1 }, { loc: pg.getByRole("button", { name: /^Filtros/ }).first(), n: 2 }, { loc: pg.getByRole("button", { name: GERAR }).first(), n: 3 }]);
      await foto(pg, "cap9-excessos", { ...M, height: 640 });
      await limparMarcas(pg);
      await pg.evaluate(() => { const t = document.querySelector("table thead") as HTMLElement; window.scrollTo(0, t.getBoundingClientRect().top + window.scrollY - 200); });
      await pg.waitForTimeout(600);
      await foto(pg, "cap9-excessos-tabela", { ...M, y: 90, height: 560 });
    });
    // 18 · transferências (+ criar) e 19 · manutenção
    await fresco("/transferencias", async (pg) => {
      await pg.setViewportSize({ width: 1120, height: 1150 });
      pg.on("dialog", (d) => d.accept());
      await gerar(pg);
      await marcar(pg, [{ loc: pg.getByRole("button", { name: GERAR }).first(), n: 1 }, { loc: pg.getByRole("button", { name: /^Criar$/ }).first(), n: 2 }]);
      await foto(pg, "cap10-transferencias", { ...M, height: 640 });
      await limparMarcas(pg);
      await pg.evaluate(() => { const t = document.querySelector("table thead") as HTMLElement; window.scrollTo(0, t.getBoundingClientRect().top + window.scrollY - 200); });
      await pg.waitForTimeout(600);
      await marcar(pg, [{ loc: pg.getByRole("button", { name: /^Criar$/ }).first(), n: 1 }]);
      await foto(pg, "cap10-transferencias-tabela", { ...M, y: 90, height: 560 });
      await limparMarcas(pg);
      await pg.getByRole("button", { name: /^Criar$/ }).first().click(); await pg.waitForTimeout(3500);
    });
    await fresco("/transferencias/manutencao", async (pg) => { await foto(pg, "cap10-manutencao", { ...M, height: 380 }); });

    // 20 · encomendas
    await fresco("/encomendas", async (pg) => {
      await pg.evaluate(() => { const t = document.querySelector("table thead") as HTMLElement; window.scrollTo(0, t.getBoundingClientRect().top + window.scrollY - 150); });
      await pg.waitForTimeout(600);
      await foto(pg, "cap11-lista", { ...M, y: 60, height: 620 });
    });
    await fresco("/encomendas/nova", async (pg) => {
      await pg.getByRole("button", { name: /Gerar proposta/ }).first().click(); await pg.waitForTimeout(6000);
      await marcar(pg, [{ loc: pg.locator("input[type=date]").first(), n: 1 }, { loc: pg.getByRole("button", { name: /Gerar nova proposta/ }).first(), n: 2 }, { loc: pg.getByRole("button", { name: /^Guardar rascunho/ }), n: 3 }]);
      await foto(pg, "cap11-proposta", { ...M, height: 700 });
    }, "ADMINISTRADOR", { width: 1120, height: 1100 });

    // 21 · filtros (painel de Vendas)
    await fresco("/vendas", async (pg) => {
      await gerar(pg);
      await pg.getByRole("button", { name: /^Filtros/ }).first().click(); await pg.waitForTimeout(900);
      const bloco = (t: string) => pg.locator(`main :text-is("${t}"):visible`).first();
      await marcar(pg, [
        { loc: bloco("Importar lista de CNP/Códigos"), n: 1, dx: -14, dy: -10 }, { loc: bloco("Farmácia"), n: 2, dx: -14, dy: -10 },
        { loc: bloco("Fabricante"), n: 3, dx: -14, dy: -10 }, { loc: bloco("Forma farmacêutica"), n: 4, dx: -14, dy: -10 },
        { loc: bloco("Ético / NETT"), n: 5, dx: -14, dy: -10 }, { loc: pg.locator('[data-testid="filtro-generico"]'), n: 6, dx: -14, dy: -10 },
      ]);
      await foto(pg, "cap13-filtros", { ...M, y: 118, height: 800 });
    }, "ADMINISTRADOR", { width: 1120, height: 1500 });
    // 22 · separadores
    await fresco("/dashboard", async (pg) => {
      for (const nome of ["Stock", "Vendas"]) { await pg.locator("aside nav").getByRole("link", { name: nome, exact: true }).click(); await pg.waitForTimeout(2300); }
      await pg.getByText("Nova análise").first().click(); await pg.waitForTimeout(2300);
      const barra = pg.getByText("Nova análise").first();
      await marcar(pg, [{ loc: pg.locator("[aria-label^='Fechar Stock']").first(), n: 1, dx: -10, dy: -14 }, { loc: barra, n: 2, dx: -8, dy: -14 }]);
      await foto(pg, "cap14-separadores", { x: 242, y: 64, width: 878, height: 70 });
    });
    console.log("FEITO");
  } finally {
    gravarFacts("capturas-final");
    await A.parar();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
