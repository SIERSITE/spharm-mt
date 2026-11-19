/**
 * Manual v2 — capturas DEFINITIVAS. Janela de referência 1366×768 (largura) (disposição habitual de computador), resolução ×2
 * (deviceScaleFactor 2 ⇒ ≥ 200 dpi efetivos), recortes focados na zona explicada. Dados SINTÉTICOS.
 * Cada imagem tem no máximo 1090 px CSS de largura (página A4 horizontal) ou 720 (vertical).
 */
import { iniciar, registar, gravarFacts, marcar, limparMarcas, foto, caixaDe, tentar, IMG } from "./_manual-base";
import type { BrowserContext, Page } from "playwright";

const GERAR = /^(Gerar|Atualizar|Gerar relatório)$/;
const VP = { width: 1366, height: 1000 };
const X = 262; // margem esquerda do conteúdo (após o menu lateral)

async function main() {
  const A = await iniciar("mv2");
  const { amb, ids, novoCtx, url } = A;
  const prisma = amb.prisma;
  try {
    // dados sintéticos adicionais
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

    async function fresco(rota: string, f: (pg: Page, c: BrowserContext) => Promise<void>, vp = VP, perfil = "ADMINISTRADOR") {
      const c = await novoCtx(perfil, null, vp);
      const pg = await c.newPage();
      await pg.setViewportSize(vp);
      await pg.goto(url(rota), { waitUntil: "domcontentloaded", timeout: 90000 });
      await pg.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
      await pg.waitForTimeout(700);
      try { await f(pg, c); } catch (e) { registar(`ERRO_${rota}`, String((e as Error).message).split("\n")[0].slice(0, 220)); }
      await pg.close(); await c.close();
    }
    const gerar = async (pg: Page, t = 4500) => { await pg.getByRole("button", { name: GERAR }).first().click(); await pg.waitForTimeout(t); };
    const aDireita = (pg: Page) => pg.evaluate(() => { document.querySelectorAll("main *").forEach((e) => { const el = e as HTMLElement; const o = getComputedStyle(el).overflowX; if ((o === "auto" || o === "scroll") && el.scrollWidth > el.clientWidth + 4) el.scrollLeft = el.scrollWidth; }); });
    const descer = (pg: Page, sel: string, folga = 120) => pg.evaluate(([s, f]) => { const e = document.querySelector(s as string) as HTMLElement; window.scrollTo(0, e.getBoundingClientRect().top + window.scrollY - (f as number)); }, [sel, folga]);

    // 1 · login
    {
      const c = await A.browser.newContext({ viewport: { width: 1366, height: 900 }, deviceScaleFactor: 2 });
      await c.addInitScript("window.__name = (f) => f;");
      const pg = await c.newPage();
      await pg.goto(url("/login"), { waitUntil: "networkidle" });
      await pg.fill('input[name="email"]', "utilizador@exemplo.pt");
      await pg.fill('input[name="password"]', "exemplo-123");
      await foto(pg, "cap1-login", await caixaDe(pg, [pg.locator("form").first().locator("xpath=ancestor::div[contains(@class,'rounded')][1]")], 0));
      await c.close();
    }
    // 2/3 · menu
    await fresco("/dashboard", async (pg) => {
      await foto(pg, "cap1-menu-topo", { x: 0, y: 0, width: 242, height: 640 });
      await foto(pg, "cap1-menu-fundo", { x: 0, y: 760, width: 242, height: 240 });
    });
    await fresco("/dashboard", async (pg) => {
      await pg.getByTestId("menu-movel-abrir").click(); await pg.waitForTimeout(600);
      await foto(pg, "cap1-menu-movel", { x: 0, y: 0, width: 390, height: 600 });
    }, { width: 390, height: 844 });
    await fresco("/dashboard", async (pg) => { await foto(pg, "capa-dashboard", { x: 0, y: 0, width: 1366, height: 700 }); }, { width: 1366, height: 900 });
    // 4 · dashboard
    await fresco("/dashboard", async (pg) => { await foto(pg, "cap2-dashboard", { x: X, y: 244, width: 590, height: 350 }); });

    // 5 · stock
    await fresco("/stock", async (pg) => {
      const campo = pg.getByPlaceholder(/Pesquisar produto/);
      await campo.fill("AMOXICILINA EXEMPLO 250"); await campo.press("Enter"); await pg.waitForTimeout(2500);
      const alvo = pg.locator("table tbody tr").first();
      await marcar(pg, [{ loc: campo, n: 1, dx: -10 }, { loc: pg.getByRole("button", { name: /^Filtros/ }).first(), n: 2 }, { loc: alvo, n: 3, dx: -10, dy: -6 }]);
      const cartoes = await pg.getByText("REFERÊNCIAS ANALISADAS", { exact: false }).first().boundingBox();
      await foto(pg, "cap3-stock", { x: X, y: (cartoes?.y ?? 300) - 14, width: 1080, height: 560 });
    }, { width: 1366, height: 1200 });
    // 6 · ficha em painel
    await fresco("/stock?q=AMOXICILINA+EXEMPLO+250&ficha=7100012", async (pg) => { await pg.waitForTimeout(1500);
      const r = await pg.evaluate(() => { const b = Array.from(document.querySelectorAll("button")).find((x) => /Manter como tarefa/.test(x.textContent ?? "")); let e = b as HTMLElement | null; while (e && e.parentElement) { const q = e.getBoundingClientRect(); if (q.height >= window.innerHeight * 0.9 && q.right >= window.innerWidth - 2) return { x: q.left, w: q.width }; e = e.parentElement; } return null; });
      registar("ficha_painel_rect", r);
      const x0 = Math.max(0, r?.x ?? 820);
      await foto(pg, "cap3-ficha", { x: x0, y: 0, width: Math.min(560, 1366 - x0), height: 800 }); });
    // 7 · extrato
    await fresco("/stock/artigo/7100001", async (pg) => {
      const h = pg.getByText("Extrato de movimentos").first();
      await h.scrollIntoViewIfNeeded(); await pg.waitForTimeout(500);
      const b = await h.boundingBox();
      await foto(pg, "cap3-extrato", { x: X, y: Math.max(0, (b?.y ?? 100) - 14), width: 1080, height: 400 });
    }, { width: 1366, height: 1200 });
    // 8 · devoluções
    await fresco("/devolucoes", async (pg) => {
      await gerar(pg);
      await marcar(pg, [{ loc: pg.locator("input[type=date]").first(), n: 1 }, { loc: pg.getByRole("button", { name: GERAR }).first(), n: 2 }]);
      await foto(pg, "cap4-devolucoes", { x: X, y: 100, width: 1080, height: 640 });
    }, { width: 1366, height: 1100 });
    // 9 · catálogo
    await fresco("/catalogo", async (pg) => { await foto(pg, "cap5-catalogo", { x: X, y: 100, width: 1080, height: 520 }); });
    // 10 · criar produto
    await fresco("/produtos/criar", async (pg) => {
      const ins = pg.locator("main input[type=text], main input:not([type])");
      await ins.nth(0).fill("7999001"); await ins.nth(1).fill("PRODUTO NOVO EXEMPLO 10 MG");
      await marcar(pg, [{ loc: ins.nth(0), n: 1, dx: -10 }, { loc: ins.nth(1), n: 2, dx: -10 }, { loc: pg.getByRole("button", { name: "Criar produto", exact: true }), n: 3, dx: -10 }]);
      await foto(pg, "cap5-criar-produto", { x: X, y: 100, width: 1000, height: 620 });
    }, { width: 1366, height: 1000 });

    // 11 · vendas
    await fresco("/vendas", async (pg) => {
      const sel = (t: string) => pg.locator("label", { hasText: t }).first().locator("select, input").first();
      await marcar(pg, [{ loc: sel("Âmbito da análise"), n: 1 }, { loc: sel("Data início"), n: 2 }, { loc: sel("Agrupar por"), n: 3, dx: -12 }, { loc: pg.getByRole("button", { name: /^Filtros/ }), n: 4, dx: -10 }, { loc: pg.getByRole("button", { name: "Gerar", exact: true }), n: 5, dx: -10 }]);
      await foto(pg, "cap6-vendas-form", { x: X, y: 130, width: 1080, height: 240 });
      await limparMarcas(pg);
      await gerar(pg);
      await descer(pg, "table thead", 300);
      await pg.evaluate(() => { const k = document.querySelector("[data-scroll-key]") as HTMLElement | null; if (k) k.scrollLeft = k.scrollWidth; });
      await pg.waitForTimeout(700);
      const tU = pg.locator("table thead th", { hasText: /Total Unid/i }).first();
      const tS = pg.locator("table thead th", { hasText: /^\s*Stock/i }).first();
      const tV = pg.locator("table thead th", { hasText: /Vendas s\/IVA/i }).first();
      await marcar(pg, [{ loc: tU, n: 1, dx: -10, dy: -14 }, { loc: tS, n: 2, dx: -6, dy: -14 }, { loc: tV, n: 3, dx: -6, dy: -14 }]);
      const bu = await tU.boundingBox(); const bv = await tV.boundingBox();
      if (bu && bv) await foto(pg, "cap6-vendas-tabela", { x: Math.max(X, bu.x - 330), y: bu.y - 30, width: bv.x + bv.width - Math.max(X, bu.x - 330) + 10, height: 380 });
      await limparMarcas(pg);
      await pg.evaluate(() => window.scrollTo(0, 0)); await pg.waitForTimeout(500);
      await marcar(pg, [{ loc: pg.getByRole("button", { name: "Imprimir", exact: true }), n: 1, dx: -8 }, { loc: pg.getByRole("button", { name: "PDF", exact: true }), n: 2, dx: -8 }, { loc: pg.getByRole("button", { name: "Excel", exact: true }), n: 3, dx: -8 }, { loc: pg.getByRole("button", { name: "Email", exact: true }), n: 4, dx: -8 }]);
      await foto(pg, "cap12-botoes", await caixaDe(pg, [pg.getByRole("button", { name: "Imprimir", exact: true }), pg.getByRole("button", { name: "Email", exact: true })], 22));
      await limparMarcas(pg);
      await marcar(pg, [{ loc: pg.getByText("Incluir preços de venda").first(), n: 1, dx: -10, dy: -12 }, { loc: pg.getByText("Incluir preços de compra").first(), n: 2, dx: -10, dy: -12 }]);
      await foto(pg, "cap12-precos", await caixaDe(pg, [pg.getByText("Incluir preços de venda").first(), pg.getByText("Incluir preços de compra").first()], 22));
      await limparMarcas(pg);
      await pg.getByRole("button", { name: "Email", exact: true }).click(); await pg.waitForTimeout(1000);
      const dlg = pg.locator("div.fixed", { hasText: "Destinatários" }).last();
      await foto(pg, "cap12-email", await caixaDe(pg, [dlg.locator("> div").first()], 0));
      await pg.getByRole("button", { name: "Cancelar" }).first().click(); await pg.waitForTimeout(400);
      await pg.getByRole("button", { name: /Criar encomenda/ }).click(); await pg.waitForTimeout(900);
      const dlg2 = pg.locator("div.fixed", { hasText: "PRETENDO ENCOMENDAR" }).last();
      await foto(pg, "cap6-vendas-modal", await caixaDe(pg, [dlg2.locator("> div").first()], 0));
    }, { width: 1366, height: 1100 });
    // 12 · manutenção de vendas
    await fresco("/vendas/manutencao/nova", async (pg) => {
      await pg.getByPlaceholder(/Procurar por CNP/).fill("7100001"); await pg.waitForTimeout(1500);
      await pg.getByText(/CNP 7100001/).first().click(); await pg.waitForTimeout(800);
      const num = pg.locator("main input[type=number]");
      await num.nth(0).fill("120"); await num.nth(1).fill("3");
      await pg.getByRole("button", { name: /Calcular distribuição/ }).click(); await pg.waitForTimeout(3000);
      await marcar(pg, [{ loc: pg.getByPlaceholder(/Procurar por CNP/), n: 1 }, { loc: num.nth(0), n: 2, dx: -10 }, { loc: num.nth(1), n: 3, dx: -10 }, { loc: pg.getByRole("button", { name: /Recalcular pelo histórico/ }), n: 4, dx: -10 }]);
      await foto(pg, "cap6-mv-form", { x: X, y: 110, width: 1080, height: 700 });
    }, { width: 1366, height: 1100 });

    // 13/14 · margens e inventário
    await fresco("/relatorios/margens", async (pg) => {
      await gerar(pg);
      await marcar(pg, [{ loc: pg.locator("input[type=date]").first(), n: 1 }, { loc: pg.getByRole("button", { name: /^(Gerar|Atualizar)$/ }).first(), n: 2 }, { loc: pg.getByRole("button", { name: /Totais por categoria/ }), n: 3, dx: -8 }, { loc: pg.getByRole("button", { name: /^Fiável/ }).first(), n: 4, dx: -8 }]);
      await foto(pg, "cap7-margens", { x: X, y: 70, width: 1080, height: 700 });
    }, { width: 1366, height: 1100 });
    await fresco("/relatorios/inventario", async (pg) => {
      await gerar(pg);
      await marcar(pg, [{ loc: pg.getByRole("button", { name: GERAR }).first(), n: 1 }, { loc: pg.getByRole("button", { name: "Por produto" }).first(), n: 2, dx: -8 }, { loc: pg.getByRole("button", { name: /^Rotura/ }).first(), n: 3, dx: -8 }]);
      await foto(pg, "cap8-inventario", { x: X, y: 70, width: 1080, height: 680 });
    }, { width: 1366, height: 1100 });
    // 15 · excessos
    await fresco("/excessos", async (pg) => {
      await gerar(pg);
      await marcar(pg, [{ loc: pg.locator("input[type=date]").first(), n: 1 }, { loc: pg.getByRole("button", { name: /^Filtros/ }).first(), n: 2 }, { loc: pg.getByRole("button", { name: GERAR }).first(), n: 3 }]);
      await foto(pg, "cap9-excessos", { x: X, y: 70, width: 1080, height: 680 });
    }, { width: 1366, height: 1100 });
    // 16 · transferências
    await fresco("/transferencias", async (pg) => {
      pg.on("dialog", (d) => d.accept());
      await gerar(pg);
      await descer(pg, "table thead", 260);
      await aDireita(pg);
      await pg.waitForTimeout(600);
      await marcar(pg, [{ loc: pg.getByRole("button", { name: /^Criar$/ }).first(), n: 1, dx: -10 }]);
      const bc = await pg.getByRole("button", { name: /^Criar$/ }).first().boundingBox();
      await foto(pg, "cap10-transferencias", { x: Math.max(250, (bc ? bc.x + bc.width + 24 : 1342) - 1080), y: 80, width: 1080, height: 480 });
      await limparMarcas(pg);
      await pg.getByRole("button", { name: /^Criar$/ }).first().click(); await pg.waitForTimeout(3500);
    }, { width: 1366, height: 1100 });
    // 17 · encomendas
    await fresco("/encomendas", async (pg) => {
      await descer(pg, "table thead", 150); await aDireita(pg); await pg.waitForTimeout(500);
      await foto(pg, "cap11-lista", { x: 274, y: 60, width: 1092, height: 560 });
    }, { width: 1366, height: 1100 });
    await fresco("/encomendas/nova", async (pg) => {
      await pg.getByRole("button", { name: /Gerar proposta/ }).first().click(); await pg.waitForTimeout(6000);
      await marcar(pg, [{ loc: pg.locator("input[type=date]").first(), n: 1 }, { loc: pg.getByRole("button", { name: /Gerar nova proposta/ }).first(), n: 2, dx: -8 }]);
      await foto(pg, "cap11-proposta", { x: X, y: 70, width: 1080, height: 730 });
    }, { width: 1366, height: 1100 });

    // 18 · filtros
    await fresco("/vendas", async (pg) => {
      await gerar(pg);
      await pg.getByRole("button", { name: /^Filtros/ }).first().click(); await pg.waitForTimeout(900);
      const bloco = (t: string) => pg.locator(`main :text-is("${t}"):visible`).first();
      await marcar(pg, [{ loc: bloco("Importar lista de CNP/Códigos"), n: 1, dx: -14, dy: -10 }, { loc: bloco("Farmácia"), n: 2, dx: -14, dy: -10 }, { loc: bloco("Fabricante"), n: 3, dx: -14, dy: -10 }, { loc: bloco("Forma farmacêutica"), n: 4, dx: -14, dy: -10 }, { loc: bloco("Ético / NETT"), n: 5, dx: -14, dy: -10 }, { loc: pg.locator('[data-testid="filtro-generico"]'), n: 6, dx: -14, dy: -10 }]);
      const b = await bloco("Importar lista de CNP/Códigos").boundingBox();
      await foto(pg, "cap13-filtros", { x: X, y: Math.max(0, (b?.y ?? 300) - 30), width: 1080, height: 750 });
    }, { width: 1366, height: 1500 });
    // 19 · separadores
    await fresco("/dashboard", async (pg) => {
      for (const nome of ["Stock", "Vendas"]) { await pg.locator("aside nav").getByRole("link", { name: nome, exact: true }).click(); await pg.waitForTimeout(2300); }
      await pg.getByText("Nova análise").first().click(); await pg.waitForTimeout(2300);
      await marcar(pg, [{ loc: pg.locator("[aria-label^='Fechar Stock']").first(), n: 1, dx: -8, dy: -14 }, { loc: pg.getByText("Nova análise").first(), n: 2, dx: -8, dy: -14 }]);
      await foto(pg, "cap14-separadores", { x: 242, y: 64, width: 720, height: 50 });
    });
    console.log("FEITO");
  } finally {
    gravarFacts("capturas-v2");
    await A.parar();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
void IMG;
