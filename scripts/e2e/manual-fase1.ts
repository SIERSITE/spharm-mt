/** Manual — fase 1: capítulos 1 a 5 (validações no browser + capturas candidatas). Exploratório. */
import path from "node:path";
import { iniciar, registar, gravarFacts, limpa, marcar, limparMarcas, foto, caixaDe, tentar, texto, IMG } from "./_manual-base";

async function main() {
  const A = await iniciar("m1");
  const { amb, ids, abrir, novoCtx, ctx, url } = A;
  const prisma = amb.prisma;
  try {
    // ── movimentos para o extrato (CNP 7100001, Farmácia Central) ───────────
    const p1 = await prisma.produto.findUniqueOrThrow({ where: { cnp: 7100001 } });
    const base = new Date();
    const mov = [
      [1, "COMPRA", 60, 460, 12 * 24], [2, "VENDA", -8, 452, 9 * 24], [3, "VENDA", -5, 447, 6 * 24], [4, "ACERTO_STOCK", -2, 445, 3 * 24],
    ] as const;
    for (const [i, tipo, q, ex, h] of mov) {
      await tentar(`mov${i}`, () => prisma.movimentoArtigo.create({ data: {
        farmaciaId: ids[0], externalMovId: 9000 + i, externalProductId: String(p1.cnp), produtoId: p1.id,
        dataMovimento: new Date(base.getTime() - h * 3_600_000), tipo, quantidade: q, existenciaApos: ex,
        custoUnitario: 6, pmcAnterior: 6, pmcNovo: 6, armazemId: 1, documentoTipo: tipo === "COMPRA" ? "Recepção" : tipo === "VENDA" ? "Factura" : "Acerto", documentoNumero: `G/${1000 + i}`,
      } }));
    }

    // ═══ CAP 1 · acesso e navegação ═══════════════════════════════════════
    const anon = await A.browser.newContext({ viewport: { width: 1440, height: 900 } });
    await anon.addInitScript("window.__name = (f) => f;");
    let pg = await anon.newPage();
    await pg.goto(url("/login"), { waitUntil: "networkidle" });
    registar("login_texto", await texto(pg, "body"));
    registar("login_url_antes", pg.url());
    await pg.fill('input[name="email"]', "utilizador@exemplo.pt");
    await pg.fill('input[name="password"]', "palavra-errada");
    await pg.click('button[type="submit"]');
    await pg.waitForTimeout(1500);
    registar("login_erro", await texto(pg, "body"));
    await pg.fill('input[name="email"]', "");
    await pg.fill('input[name="password"]', "");
    await pg.click('button[type="submit"]');
    await pg.waitForTimeout(1200);
    registar("login_vazio", await texto(pg, "body"));
    await foto(pg, "cap1-login", await caixaDe(pg, [pg.locator("form").first()], 40));
    await anon.close();

    pg = await abrir("/dashboard");
    registar("menu_admin", await texto(pg, "aside nav"));
    registar("menu_admin_bloco", await texto(pg, '[data-testid="ultima-atualizacao"]'));
    registar("titulo_dashboard", await texto(pg, '[data-testid="titulo-cabecalho"]'));
    await foto(pg, "cap1-menu", { x: 0, y: 0, width: 242, height: 900 });
    // tiles do dashboard
    registar("dashboard_links", await pg.locator("main a").evaluateAll((els) => els.map((e) => `${e.textContent?.replace(/\s+/g, " ").trim().slice(0, 50)} -> ${e.getAttribute("href")}`)));
    registar("dashboard_texto", (await texto(pg)).slice(0, 2600));
    await foto(pg, "cap2-dashboard", { x: 242, y: 64, width: 1198, height: 560 });
    const det = pg.getByText(/Detalhe por farmácia/).first();
    if (await det.count()) { await det.click(); await pg.waitForTimeout(600); registar("dashboard_detalhe", (await texto(pg)).slice(-900)); }
    await pg.close();

    // perfis: menu e acesso direto
    const rotas = ["/encomendas", "/encomendas/nova", "/transferencias", "/vendas/manutencao", "/produtos/criar", "/configuracoes/utilizadores", "/configuracoes/email", "/catalogo/manutencao", "/relatorios/margens"];
    const acesso: Record<string, Record<string, string>> = {};
    for (const [perfil, fid] of [["OPERADOR", ids[1]], ["GESTOR_FARMACIA", ids[1]], ["GESTOR_GRUPO", null]] as const) {
      const c = await novoCtx(perfil, fid);
      acesso[perfil] = {};
      for (const r of rotas) {
        const q = await c.newPage();
        await q.goto(url(r), { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
        await q.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
        acesso[perfil][r] = new URL(q.url()).pathname;
        await q.close();
      }
      const q = await c.newPage();
      await q.goto(url("/dashboard"), { waitUntil: "networkidle" });
      acesso[perfil]["__menu"] = await texto(q, "aside nav");
      acesso[perfil]["__bloco"] = await texto(q, '[data-testid="ultima-atualizacao"]');
      await q.close();
      await c.close();
    }
    registar("acesso_por_perfil", acesso);

    // alterar password
    pg = await abrir("/alterar-password");
    registar("altpass_texto", await texto(pg));
    const campos = pg.locator("main input[type=password]");
    if ((await campos.count()) >= 3) {
      await campos.nth(0).fill("Antiga-12345!"); await campos.nth(1).fill("Nova-password-1"); await campos.nth(2).fill("Nova-password-2");
      await pg.getByRole("button", { name: /Guardar nova password/ }).click(); await pg.waitForTimeout(1200);
      registar("altpass_naocoincide", await texto(pg));
      await campos.nth(1).fill("curta"); await campos.nth(2).fill("curta");
      await pg.getByRole("button", { name: /Guardar nova password/ }).click(); await pg.waitForTimeout(1200);
      registar("altpass_curta", await texto(pg));
    }
    await pg.close();

    // menu móvel
    const cm = await novoCtx("ADMINISTRADOR", null, { width: 390, height: 844 });
    pg = await abrir("/dashboard", cm, { width: 390, height: 844 });
    await pg.getByTestId("menu-movel-abrir").click();
    await pg.waitForTimeout(500);
    await foto(pg, "cap1-menu-movel", { x: 0, y: 0, width: 390, height: 844 });
    await pg.close(); await cm.close();

    // Sair
    const cs = await novoCtx("ADMINISTRADOR");
    pg = await abrir("/dashboard", cs);
    await pg.getByRole("button", { name: /Sair/ }).click(); await pg.waitForTimeout(1500);
    registar("sair_url", new URL(pg.url()).pathname);
    await pg.close(); await cs.close();

    // ═══ CAP 3 · stock e ficha ════════════════════════════════════════════
    pg = await abrir("/stock");
    registar("stock_inicial", (await texto(pg)).slice(0, 1800));
    const campo = pg.getByPlaceholder(/Pesquisar produto/);
    await campo.fill("AMOXICILINA"); await campo.press("Enter"); await pg.waitForTimeout(2500);
    registar("stock_pesquisa", (await texto(pg)).slice(0, 2600));
    registar("stock_cabecalhos", await pg.locator("table thead th").allInnerTexts());
    await pg.getByRole("button", { name: /^Filtros/ }).first().click().catch(() => {});
    await pg.waitForTimeout(600);
    registar("stock_filtros", (await texto(pg)).slice(0, 2200));
    await marcar(pg, [
      { loc: pg.getByPlaceholder(/Pesquisar produto/), n: 1 },
      { loc: pg.getByRole("button", { name: /^Filtros/ }).first(), n: 2 },
      { loc: pg.locator("table tbody tr").first(), n: 3, dx: -4, dy: -4 },
    ]);
    await foto(pg, "cap3-stock", { x: 242, y: 64, width: 1198, height: 640 });
    await limparMarcas(pg);
    await pg.keyboard.press("Escape");
    await pg.locator("table tbody tr").first().click().catch(() => {});
    await pg.waitForTimeout(1800);
    registar("ficha_painel_url", pg.url());
    registar("ficha_painel", (await texto(pg, "body")).slice(0, 3500));
    await foto(pg, "cap3-ficha-painel", { x: 700, y: 0, width: 740, height: 900 });
    await pg.close();
    pg = await abrir("/stock/artigo/7100001");
    registar("ficha_pagina", (await texto(pg)).slice(0, 4500));
    await pg.screenshot({ path: path.join(IMG, "cap3-ficha-pagina-raw.png"), fullPage: true });
    const extr = pg.getByText(/Extrato|extrato/).first();
    registar("extrato_presente", await extr.count());
    await pg.close();

    // ═══ CAP 4 · catálogo ═════════════════════════════════════════════════
    pg = await abrir("/catalogo");
    registar("catalogo_texto", (await texto(pg)).slice(0, 2600));
    await foto(pg, "cap4-catalogo", { x: 242, y: 64, width: 1198, height: 600 });
    await pg.close();
    pg = await abrir("/catalogo/artigo/7100001");
    registar("catalogo_ficha", (await texto(pg)).slice(0, 3800));
    const ed = pg.getByText("Editar designação").first();
    registar("ed_designacao_visivel_admin", await ed.count());
    if (await ed.count()) {
      await ed.click(); await pg.waitForTimeout(500);
      registar("ed_designacao_aberto", (await texto(pg)).slice(0, 1500));
      const campoD = pg.locator("main input[type=text], main input:not([type])").first();
      await campoD.fill("AMOXICILINA EXEMPLO 250 MG 20 CMP (REV)");
      await pg.getByRole("button", { name: "Continuar" }).first().click().catch(() => {}); await pg.waitForTimeout(900);
      registar("ed_designacao_confirmacao", (await texto(pg)).slice(0, 1500));
      await pg.getByRole("button", { name: /Voltar/ }).first().click().catch(() => {});
    }
    await pg.close();
    const co = await novoCtx("OPERADOR", ids[1]);
    pg = await abrir("/catalogo/artigo/7100001", co);
    registar("ed_designacao_visivel_operador", await pg.getByText("Editar designação").count());
    await pg.close(); await co.close();

    // ═══ CAP 5 · manutenção de vendas ═════════════════════════════════════
    pg = await abrir("/vendas/manutencao");
    registar("mv_lista", (await texto(pg)).slice(0, 1500));
    await pg.close();
    pg = await abrir("/vendas/manutencao/nova");
    registar("mv_nova", (await texto(pg)).slice(0, 2500));
    registar("mv_nova_inputs", await pg.locator("main input, main select").evaluateAll((els) => els.map((e) => `${e.tagName}:${(e as HTMLInputElement).type}:${(e as HTMLInputElement).placeholder}:${(e as HTMLInputElement).value}`)));
    await tentar("mv_artigo", async () => {
      const busca = pg.getByPlaceholder(/Procurar por CNP/);
      await busca.fill("7100001"); await pg.waitForTimeout(1500);
      registar("mv_sugestoes", (await texto(pg)).slice(0, 1200));
      await pg.getByText(/7100001/).first().click(); await pg.waitForTimeout(800);
      registar("mv_apos_artigo", (await texto(pg)).slice(0, 2500));
    });
    await foto(pg, "cap5-mv-nova", { x: 242, y: 64, width: 1198, height: 700 });
    await pg.close();

    gravarFacts("fase1");
    console.log("FEITO");
  } finally {
    gravarFacts("fase1");
    await A.parar();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
