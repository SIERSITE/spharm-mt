/** Manual — fase 4: últimas validações (perfis, painéis de filtros, Divergente, manutenção de vendas no mapa, dashboard, stock). */
import { iniciar, registar, gravarFacts, tentar, texto } from "./_manual-base";
import type { Page } from "playwright";

const GERAR = /^(Gerar|Atualizar|Gerar relatório)$/;
const resumo = async (pg: Page) => (await pg.locator("main").innerText()).split("\n").filter((l) => /^\s*\d[\d  ]* linhas$|^\d+ unidades$|^\d[\d  ]* unidades$/.test(l.trim())).join(" | ");

async function main() {
  const A = await iniciar("m4");
  const { abrir, novoCtx, ids, amb } = A;
  const prisma = amb.prisma;
  try {
    // a/b · perfis
    for (const [perfil, fid] of [["GESTOR_GRUPO", null], ["GESTOR_FARMACIA", ids[1]], ["OPERADOR", ids[1]]] as const) {
      const c = await novoCtx(perfil, fid);
      const r: Record<string, unknown> = {};
      let pg = await abrir("/catalogo/artigo/7100001", c);
      r.editar_designacao = await pg.getByText("Editar designação").count();
      await pg.close();
      pg = await abrir("/stock/artigo/7100001", c);
      r.stock_editar = { designacao: await pg.getByText("Editar designação").count(), fabricante: await pg.getByRole("button", { name: /^Editar$/ }).count(), nome_fab: await pg.getByText("Editar nome do fabricante").count() };
      await pg.close();
      for (const rota of ["/inventario", "/relatorios/inventario", "/excessos", "/devolucoes", "/catalogo", "/stock", "/vendas", "/relatorios/margens"]) {
        const q = await c.newPage();
        await q.goto(`${A.url(rota)}`, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
        await q.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
        r[rota] = new URL(q.url()).pathname;
        await q.close();
      }
      registar(`perfil_${perfil}`, r);
      await c.close();
    }

    // c · painéis de filtros
    const paineis: Record<string, string> = {};
    for (const [rota, gerarPrimeiro] of [["/relatorios/margens", true], ["/relatorios/inventario", true], ["/excessos", true], ["/transferencias", true], ["/devolucoes", false], ["/encomendas/nova", false]] as const) {
      const pg = await abrir(rota);
      await tentar(`painel_${rota}`, async () => {
        if (gerarPrimeiro) { await pg.getByRole("button", { name: GERAR }).first().click(); await pg.waitForTimeout(4000); }
        await pg.getByRole("button", { name: /^Filtros/ }).first().click(); await pg.waitForTimeout(900);
        const t = await texto(pg);
        paineis[rota] = t.slice(t.indexOf("Filtros"), t.indexOf("Filtros") + 1100);
      });
      await pg.close();
    }
    registar("paineis_filtros", paineis);

    // d · Divergente (Jardim = NETT em 7100001; as outras Ético)
    const p1 = await prisma.produto.findUniqueOrThrow({ where: { cnp: 7100001 } });
    await prisma.produtoFarmacia.updateMany({ where: { produtoId: p1.id, farmaciaId: ids[2] }, data: { eticoNett: "NETT" } });
    let pg = await abrir("/stock/artigo/7100001");
    const t = await texto(pg);
    registar("divergente", t.slice(t.indexOf("Classificação Ético/NETT"), t.indexOf("Classificação Ético/NETT") + 700));
    await pg.close();

    // e · manutenção de vendas no mapa
    pg = await abrir("/vendas/manutencao/nova");
    await tentar("mv", async () => {
      await pg.getByPlaceholder(/Procurar por CNP/).fill("7100001"); await pg.waitForTimeout(1500);
      await pg.getByText(/CNP 7100001/).first().click(); await pg.waitForTimeout(800);
      const num = pg.locator("main input[type=number]");
      await num.nth(0).fill("120"); await num.nth(1).fill("3");
      await pg.getByRole("button", { name: /Calcular distribuição/ }).click(); await pg.waitForTimeout(3000);
      await pg.getByRole("button", { name: /^Gravar$/ }).click(); await pg.waitForTimeout(2500);
    });
    await pg.close();
    pg = await abrir("/vendas");
    await pg.getByPlaceholder(/Pesquisar por CNP/).fill("7100001"); await pg.waitForTimeout(300);
    await pg.getByRole("button", { name: /^Gerar$/ }).first().click(); await pg.waitForTimeout(4000);
    registar("mv_mapa_sem", await resumo(pg));
    const tabSem = (await texto(pg)).match(/TOTAL ARTIGO[^\n]*/)?.[0];
    registar("mv_mapa_sem_total", tabSem);
    await pg.locator("label", { hasText: "Incluir manutenção de vendas" }).first().click().catch(async () => { await pg.getByText("Incluir manutenção de vendas").first().click(); });
    await pg.getByRole("button", { name: /^Atualizar$/ }).first().click(); await pg.waitForTimeout(4000);
    registar("mv_mapa_com", await resumo(pg));
    await pg.close();

    // f/g · dashboard e stock
    pg = await abrir("/dashboard");
    await tentar("dash", async () => {
      await pg.getByText(/Detalhe por farmácia/).first().click(); await pg.waitForTimeout(700);
      const tx = await texto(pg); registar("dash_detalhe", tx.slice(tx.indexOf("Detalhe por farmácia"), tx.indexOf("Detalhe por farmácia") + 600));
      await pg.getByRole("button", { name: /^Farmácia Central$/ }).first().click(); await pg.waitForTimeout(700);
      registar("dash_tendencia", (await texto(pg)).slice(0, 700));
    });
    await pg.close();
    pg = await abrir("/stock");
    await tentar("stock_cartao", async () => {
      await pg.getByText("BAIXA COBERTURA", { exact: false }).first().click(); await pg.waitForTimeout(2500);
      registar("stock_cartao_url", pg.url());
      registar("stock_cartao_texto", (await texto(pg)).slice(0, 700));
    });
    await pg.close();

    // h · lista de encomendas: botões do rascunho
    pg = await abrir("/encomendas");
    const linha = pg.locator("table tbody tr", { hasText: "Rascunho" }).first();
    registar("enc_rascunho_botoes", await linha.locator("button, a").allInnerTexts());
    await pg.close();
    console.log("FEITO");
  } finally {
    gravarFacts("fase4");
    await A.parar();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
