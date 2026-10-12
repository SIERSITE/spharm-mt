// DIAGNÓSTICO do defeito original: o que o utilizador vê quando uma das duas Server Actions falha.
import Module from "node:module";
import { chromium } from "playwright";
import { criarAmbiente } from "./_ambiente-silveira";
import { abrirContexto, abrirModalEEscolher, armar, contagens, gerarPropostaGrupo, semear } from "./_grupo-comum";
const M = Module as unknown as { _resolveFilename: (r: string, ...a: unknown[]) => string };
const o = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) { return request === "server-only" ? __filename : o.call(this, request, ...rest); };

async function main() {
  const amb = await criarAmbiente("diag");
  const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP silveira.localhost [::1]"] });
  try {
    const seed = await semear(amb);
    const ctx = await abrirContexto(amb, browser, seed);
    for (const falha of ["plano-abortado", "docs-abortado", "docs-500", "plano-pendurado"] as const) {
      await amb.prisma.$executeRawUnsafe(`DELETE FROM "OrderOutbox"`);
      await amb.prisma.$executeRawUnsafe(`DELETE FROM "ListaEncomenda"`);
      await amb.prisma.$executeRawUnsafe(`DELETE FROM "Transferencia"`);
      const page = await ctx.newPage();
      await page.setViewportSize({ width: 1600, height: 900 });
      await gerarPropostaGrupo(page);
      await abrirModalEEscolher(page, "consolidada");
      await armar(page, {
        plano: falha === "plano-abortado" ? () => "abortar" : falha === "plano-pendurado" ? () => "pendurar" : undefined,
        docs: falha === "docs-abortado" ? () => "abortar" : falha === "docs-500" ? () => "erro-500" : undefined,
      });
      await page.getByRole("button", { name: "Confirmar e finalizar" }).click();
      await page.waitForTimeout(8000);
      const modal = await page.getByText("Como pretende gerar a encomenda?").count();
      const overlay = await page.getByText("A preparar os documentos…").count();
      const resultado = await page.getByText("Encomenda finalizada").count();
      const botoes = await page.getByRole("button", { name: /A finalizar…|Confirmar e finalizar|Cancelar/ }).evaluateAll((els) => els.map((e) => `${(e as HTMLElement).innerText}${(e as HTMLButtonElement).disabled ? "(desactivado)" : ""}`));
      const alertas = await page.getByRole("alert").count();
      // o flash está no DOM mas escondido atrás do modal/overlay?
      const flashTxt = await page.getByText(/Finalizado, mas não foi possível|Erro|erro/).first().innerText().catch(() => "");
      let clicavel = "n/a";
      try { await page.getByRole("button", { name: "Grupo", exact: true }).click({ timeout: 2000 }); clicavel = "sim"; } catch { clicavel = "NÃO (coberto por overlay/modal)"; }
      console.log(`[${falha}] aos 8s: modal=${modal} overlay=${overlay} resultado=${resultado} alertas=${alertas} botões=${JSON.stringify(botoes)} flash="${flashTxt.slice(0, 60)}" página clicável=${clicavel} · BD: ${JSON.stringify(await contagens(amb))}`);
      await page.close();
    }
    await ctx.close();
  } finally {
    await browser.close();
    await amb.parar();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
