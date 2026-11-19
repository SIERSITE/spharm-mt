/** Manual — fase 2b: transferências (criar), oportunidades (criar), encomendas (finalizar, documentos, duplicar, anular). */
import { iniciar, registar, gravarFacts, marcar, limparMarcas, foto, tentar, texto } from "./_manual-base";
import type { Page } from "playwright";

const GERAR = /^(Gerar|Atualizar|Gerar relatório)$/;
const botoes = (pg: Page) => pg.getByRole("button").allInnerTexts().then((a) => a.map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean));
function aceitar(pg: Page, chave: string, resposta?: string) {
  pg.on("dialog", async (d) => { registar(`dialogo_${chave}`, `${d.type()}: ${d.message()}`); await d.accept(resposta); });
}

async function main() {
  const A = await iniciar("m2b");
  const { abrir } = A;
  try {
    // ── Transferências: criar ──────────────────────────────────────────
    let pg = await abrir("/transferencias");
    aceitar(pg, "criar_transferencia");
    await pg.getByRole("button", { name: GERAR }).first().click(); await pg.waitForTimeout(4500);
    await pg.getByRole("button", { name: /^Criar$/ }).first().click(); await pg.waitForTimeout(3500);
    registar("tr_apos_criar", (await texto(pg)).slice(0, 1500));
    await tentar("tr_registadas", async () => {
      await pg.getByText(/Transferências registadas/).first().click(); await pg.waitForTimeout(800);
      registar("tr_registadas_texto", (await texto(pg)).slice(0, 1400));
      registar("tr_registadas_botoes", (await botoes(pg)).slice(10, 60));
    });
    await foto(pg, "cap9-registadas", { x: 242, y: 64, width: 1198, height: 520 });
    await pg.close();
    pg = await abrir("/transferencias/manutencao");
    registar("trm_depois", (await texto(pg)).slice(0, 1600));
    registar("trm_botoes", (await botoes(pg)).slice(8, 50));
    await foto(pg, "cap9-manutencao2", { x: 242, y: 64, width: 1198, height: 420 });
    await pg.close();

    // ── Oportunidades: criar ───────────────────────────────────────────
    pg = await abrir("/oportunidades");
    aceitar(pg, "criar_oportunidade");
    await pg.getByRole("button", { name: /Criar transferência/ }).first().click(); await pg.waitForTimeout(3500);
    registar("opo_depois", (await texto(pg)).slice(0, 1200));
    registar("opo_url", pg.url());
    await pg.close();
    pg = await abrir("/transferencias/manutencao");
    registar("trm_depois_opo", (await texto(pg)).slice(0, 900));
    await pg.close();

    // ── Encomendas ─────────────────────────────────────────────────────
    pg = await abrir("/encomendas/nova");
    aceitar(pg, "finalizar_encomenda");
    await pg.getByRole("button", { name: /Gerar proposta/ }).first().click(); await pg.waitForTimeout(6000);
    await pg.getByPlaceholder(/Encomenda /).first().fill("Encomenda de exemplo").catch(() => {});
    await pg.getByRole("button", { name: /^Finalizar e enviar/ }).first().click(); await pg.waitForTimeout(5000);
    registar("enc_final_texto", (await texto(pg)).slice(0, 1800));
    registar("enc_final_botoes", (await botoes(pg)).slice(11, 70));
    registar("enc_final_url", pg.url());
    await foto(pg, "cap10-finalizada", { x: 242, y: 64, width: 1198, height: 640 });
    await pg.close();

    pg = await abrir("/encomendas");
    aceitar(pg, "anular_encomenda", "Motivo de exemplo");
    registar("enc_lista2", (await texto(pg)).slice(0, 1800).slice(1100));
    const linha = pg.locator("table tbody tr", { hasText: "Encomenda de exemplo" }).first();
    registar("enc_linha_botoes", await linha.getByRole("button").allInnerTexts().catch(() => []));
    registar("enc_linha_links", await linha.locator("a").allInnerTexts().catch(() => []));
    await tentar("enc_docs", async () => {
      await linha.getByRole("button", { name: /Documentos/ }).click(); await pg.waitForTimeout(1500);
      registar("enc_docs_modal", (await texto(pg, "body")).slice(-1200));
      await foto(pg, "cap10-documentos", { x: 300, y: 120, width: 840, height: 600 });
      await pg.keyboard.press("Escape");
    });
    await tentar("enc_duplicar", async () => {
      await linha.getByRole("button", { name: /Duplicar/ }).click(); await pg.waitForTimeout(3000);
      registar("enc_duplicar_url", pg.url());
    });
    await pg.close();
    pg = await abrir("/encomendas");
    aceitar(pg, "anular2", "Motivo de exemplo");
    const l2 = pg.locator("table tbody tr", { hasText: "Encomenda de exemplo" }).first();
    await tentar("enc_anular", async () => {
      await l2.getByRole("button", { name: /Anular/ }).click(); await pg.waitForTimeout(3000);
      registar("enc_apos_anular", (await texto(pg)).slice(0, 700));
      await pg.getByText("Mostrar encomendas anuladas").click(); await pg.waitForTimeout(1200);
      registar("enc_anuladas_visiveis", (await texto(pg)).includes("Anulada"));
    });
    await pg.close();
    console.log("FEITO");
  } finally {
    gravarFacts("fase2b");
    await A.parar();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
