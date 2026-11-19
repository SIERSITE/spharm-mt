/** Manual — fase 2: capítulos 5 (Manutenção de Vendas) a 11. Exploratório (validações + capturas candidatas). */
import { iniciar, registar, gravarFacts, marcar, limparMarcas, foto, caixaDe, tentar, texto } from "./_manual-base";
import type { Page } from "playwright";

const GERAR = /^(Gerar|Atualizar|Gerar relatório)$/;
async function gerar(pg: Page, espera = 4500) { await pg.getByRole("button", { name: GERAR }).first().click(); await pg.waitForTimeout(espera); }
const botoes = (pg: Page) => pg.getByRole("button").allInnerTexts().then((a) => a.map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean));

async function main() {
  const A = await iniciar("m2");
  const { amb, ids, abrir } = A;
  const prisma = amb.prisma;
  try {
    // devoluções sintéticas
    const f1 = await prisma.fornecedor.create({ data: { nomeNormalizado: "DISTRIBUIDORA NORTE", nome: "Distribuidora Norte" } });
    const f2 = await prisma.fornecedor.create({ data: { nomeNormalizado: "DISTRIBUIDORA SUL", nome: "Distribuidora Sul" } });
    const agora = Date.now();
    for (let i = 1; i <= 8; i++) {
      const p = await prisma.produto.findUniqueOrThrow({ where: { cnp: 7100000 + i } });
      await tentar(`dev${i}`, () => prisma.devolucao.create({ data: { farmaciaId: ids[i % 2], produtoId: p.id, data: new Date(agora - i * 5 * 86_400_000), quantidade: 2 + i, valor: (2 + i) * 6, tipo: "FORNECEDOR", motivo: i % 2 ? "Embalagem danificada" : "Fim de validade", fornecedorDestinoId: i % 3 ? f1.id : f2.id } }));
    }

    // ═══ 5 · Manutenção de Vendas (fluxo) ═════════════════════════════════
    let pg = await abrir("/vendas/manutencao/nova");
    await tentar("mv", async () => {
      await pg.getByPlaceholder(/Procurar por CNP/).fill("7100001"); await pg.waitForTimeout(1500);
      await pg.getByText(/CNP 7100001/).first().click(); await pg.waitForTimeout(800);
      const num = pg.locator("main input[type=number]");
      await num.nth(0).fill("120");
      await num.nth(1).fill("3");
      await pg.getByRole("button", { name: /Calcular distribuição/ }).click(); await pg.waitForTimeout(3000);
      registar("mv_calculada", (await texto(pg)).slice(0, 3000));
      registar("mv_botoes", await botoes(pg));
      await marcar(pg, [
        { loc: pg.getByPlaceholder(/Procurar por CNP/), n: 1 },
        { loc: num.nth(0), n: 2 },
        { loc: num.nth(1), n: 3 },
        { loc: pg.getByRole("button", { name: /Calcular distribuição|Recalcular/ }), n: 4 },
      ]);
      await foto(pg, "cap5-mv-form", { x: 242, y: 64, width: 1198, height: 760 });
      await limparMarcas(pg);
      await pg.getByRole("button", { name: /^Gravar$/ }).click(); await pg.waitForTimeout(2500);
      registar("mv_apos_gravar_url", pg.url());
    });
    await pg.close();
    pg = await abrir("/vendas/manutencao");
    registar("mv_lista_depois", (await texto(pg)).slice(0, 1500));
    await foto(pg, "cap5-mv-lista", { x: 242, y: 64, width: 1198, height: 420 });
    await pg.close();

    // ═══ 6 · Margens ══════════════════════════════════════════════════════
    pg = await abrir("/relatorios/margens");
    registar("margens_antes", (await texto(pg)).slice(0, 1500));
    await gerar(pg);
    registar("margens_botoes", await botoes(pg));
    registar("margens_texto", (await texto(pg)).slice(0, 2600));
    registar("margens_th", await pg.locator("table thead th").allInnerTexts());
    registar("margens_th_title", await pg.locator("th[title]").evaluateAll((e) => e.map((x) => `${x.textContent?.trim()} => ${x.getAttribute("title")}`)));
    await tentar("margens_chip", async () => {
      await pg.getByRole("button", { name: /^Sem custo/ }).first().click(); await pg.waitForTimeout(800);
      registar("margens_semcusto", (await texto(pg)).slice(0, 900));
      await pg.getByRole("button", { name: /^Todos/ }).first().click(); await pg.waitForTimeout(500);
      await pg.getByRole("button", { name: /Totais por categoria/ }).click(); await pg.waitForTimeout(900);
      registar("margens_categoria", (await texto(pg)).slice(0, 1400));
      await pg.getByRole("button", { name: /Detalhe por produto/ }).click(); await pg.waitForTimeout(500);
    });
    await tentar("margens_alteracoes", async () => {
      const di = pg.locator("input[type=date]").first();
      await di.fill("2026-03-01"); await pg.waitForTimeout(600);
      registar("margens_aviso_alteracoes", /alterações por aplicar/i.test(await texto(pg)));
      await di.fill("2026-01-01"); await gerar(pg, 2500);
    });
    await marcar(pg, [
      { loc: pg.locator("input[type=date]").first(), n: 1 },
      { loc: pg.getByRole("button", { name: /^(Gerar|Atualizar)$/ }).first(), n: 2 },
      { loc: pg.getByRole("button", { name: /Totais por categoria/ }), n: 3 },
      { loc: pg.getByRole("button", { name: /^Fiável/ }).first(), n: 4 },
    ]);
    await foto(pg, "cap6-margens", { x: 242, y: 64, width: 1198, height: 640 });
    await pg.close();

    // ═══ 7 · Inventário ═══════════════════════════════════════════════════
    pg = await abrir("/relatorios/inventario");
    registar("inv_antes", (await texto(pg)).slice(0, 1400));
    await gerar(pg);
    registar("inv_botoes", await botoes(pg));
    registar("inv_texto", (await texto(pg)).slice(0, 2400));
    registar("inv_th", await pg.locator("table thead th").allInnerTexts());
    for (const v of ["Por farmácia", "Por grupo", "Por taxa IVA"]) {
      await tentar(`inv_${v}`, async () => { await pg.getByRole("button", { name: v }).first().click(); await pg.waitForTimeout(900); registar(`inv_vista_${v}`, (await texto(pg)).slice(0, 900)); });
    }
    await pg.getByRole("button", { name: "Por produto" }).first().click().catch(() => {});
    await pg.waitForTimeout(600);
    await marcar(pg, [
      { loc: pg.getByRole("button", { name: GERAR }).first(), n: 1 },
      { loc: pg.getByRole("button", { name: "Por produto" }).first(), n: 2 },
      { loc: pg.getByRole("button", { name: /^Rotura/ }).first(), n: 3 },
    ]);
    await foto(pg, "cap7-inventario", { x: 242, y: 64, width: 1198, height: 640 });
    await pg.close();

    // ═══ 8 · Excessos ═════════════════════════════════════════════════════
    pg = await abrir("/excessos");
    await gerar(pg);
    registar("exc_botoes", await botoes(pg));
    registar("exc_th", await pg.locator("table thead th").allInnerTexts());
    registar("exc_th_title", await pg.locator("th[title], th [title]").evaluateAll((e) => e.map((x) => `${x.textContent?.trim()} => ${x.getAttribute("title")}`)));
    registar("exc_texto", (await texto(pg)).slice(0, 2600));
    await marcar(pg, [
      { loc: pg.locator("input[type=date]").first(), n: 1 },
      { loc: pg.getByRole("button", { name: /^Filtros/ }).first(), n: 2 },
      { loc: pg.getByRole("button", { name: GERAR }).first(), n: 3 },
    ]);
    await foto(pg, "cap8-excessos", { x: 242, y: 64, width: 1198, height: 700 });
    await pg.close();

    // ═══ 9 · Transferências + Oportunidades ═══════════════════════════════
    pg = await abrir("/transferencias");
    await gerar(pg);
    registar("tr_botoes", await botoes(pg));
    registar("tr_th", await pg.locator("table thead th").allInnerTexts());
    registar("tr_texto", (await texto(pg)).slice(0, 2400));
    await foto(pg, "cap9-transferencias", { x: 242, y: 64, width: 1198, height: 700 });
    await tentar("tr_criar", async () => {
      await pg.getByRole("button", { name: /^Criar$/ }).first().click(); await pg.waitForTimeout(900);
      registar("tr_criar_dialogo", (await texto(pg, "body")).slice(-900));
      await foto(pg, "cap9-criar-dialogo", { x: 380, y: 200, width: 700, height: 420 });
      await pg.getByRole("button", { name: /Confirmar|Criar transferência|Sim/ }).last().click(); await pg.waitForTimeout(3000);
      registar("tr_criar_resultado", (await texto(pg)).slice(0, 1600));
    });
    await pg.close();
    pg = await abrir("/transferencias/manutencao");
    registar("trm_texto", (await texto(pg)).slice(0, 1800));
    await foto(pg, "cap9-manutencao", { x: 242, y: 64, width: 1198, height: 420 });
    await pg.close();
    pg = await abrir("/oportunidades");
    registar("opo_antes", (await texto(pg)).slice(0, 1600));
    await tentar("opo_criar", async () => {
      await pg.getByRole("button", { name: /Criar transferência/ }).first().click(); await pg.waitForTimeout(2500);
      registar("opo_apos", (await texto(pg)).slice(0, 1600));
    });
    await pg.close();

    // ═══ 10 · Encomendas ══════════════════════════════════════════════════
    pg = await abrir("/encomendas");
    registar("enc_lista", (await texto(pg)).slice(0, 2400));
    registar("enc_lista_th", await pg.locator("table thead th").allInnerTexts());
    await foto(pg, "cap10-lista", { x: 242, y: 64, width: 1198, height: 620 });
    await pg.close();
    pg = await abrir("/encomendas/nova");
    registar("enc_nova", (await texto(pg)).slice(0, 2600));
    registar("enc_nova_botoes", await botoes(pg));
    await tentar("enc_gerar", async () => {
      await pg.getByRole("button", { name: /Gerar proposta/ }).first().click(); await pg.waitForTimeout(6000);
      registar("enc_proposta", (await texto(pg)).slice(0, 3200));
      registar("enc_proposta_botoes", await botoes(pg));
      registar("enc_proposta_th", await pg.locator("table thead th").allInnerTexts());
      await foto(pg, "cap10-proposta", { x: 242, y: 64, width: 1198, height: 800 });
      await pg.locator("input[placeholder^='Encomenda'], input[placeholder*='Nome']").first().fill("Encomenda exemplo").catch(() => {});
      await pg.getByRole("button", { name: /Guardar rascunho/ }).first().click(); await pg.waitForTimeout(3000);
      registar("enc_apos_rascunho_url", pg.url());
      registar("enc_apos_rascunho", (await texto(pg)).slice(0, 1500));
    });
    await pg.close();

    // ═══ 11 · Devoluções ══════════════════════════════════════════════════
    pg = await abrir("/devolucoes");
    registar("dev_antes", (await texto(pg)).slice(0, 1200));
    await gerar(pg);
    registar("dev_botoes", await botoes(pg));
    registar("dev_texto", (await texto(pg)).slice(0, 2600));
    await marcar(pg, [
      { loc: pg.locator("input[type=date]").first(), n: 1 },
      { loc: pg.getByRole("button", { name: /^Filtros|Farmácia/ }).first(), n: 2 },
      { loc: pg.getByRole("button", { name: GERAR }).first(), n: 3 },
    ]);
    await foto(pg, "cap11-devolucoes", { x: 242, y: 64, width: 1198, height: 700 });
    await pg.close();
    console.log("FEITO");
  } finally {
    gravarFacts("fase2");
    await A.parar();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
