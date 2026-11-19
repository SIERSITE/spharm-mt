/**
 * scripts/e2e/relatorios-cabecalho.e2e.ts
 *
 * Browser REAL (Chromium) contra o build de PRODUÇÃO, control plane + PostgreSQL descartáveis (dados sintéticos):
 *   A · «Vista relatório» de Excessos e Transferências, em DOIS tenants (silveira e garantia): cabeçalho = o das saídas
 *       (Grupo / farmácia selecionada), data = hoje, sem NIF nem nome de cliente fixos, sem rodapé fixo;
 *   B · Vendas sem o botão «Ver em ecrã», antes e depois de gerar;
 *   C · o cabeçalho mostra o título do ecrã.
 *
 * Pré-requisito: `npx next build` com SERVER_ACTIONS_ALLOWED_ORIGINS="localhost:3100,127.0.0.1:3100,*.localhost:3100".
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:55491/postgres npx tsx scripts/e2e/relatorios-cabecalho.e2e.ts
 */
import { chromium, type BrowserContext, type Page } from "playwright";
import { baseFor, criarAmbiente } from "./_ambiente-silveira";
import { semearMargens } from "./_margens-comum";
import { hojeIsoLisboa } from "../../lib/relatorio-data";

let ok = 0;
let ko = 0;
const check = (c: boolean, label: string, d?: string) => {
  if (c) { ok++; console.log(`  [OK]    ${label}`); } else { ko++; console.log(`  [FALHA] ${label}${d ? `\n            ${d}` : ""}`); }
};
const PROIBIDO = /Silveirense|507529930|SoftReis Informática|Página 1 de 1|13\/04\/2026|10\/04\/2026/;

async function abrir(ctx: BrowserContext, base: string, rota: string): Promise<Page> {
  const pg = await ctx.newPage();
  await pg.setViewportSize({ width: 1440, height: 900 });
  await pg.goto(`${base}${rota}`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await pg.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  return pg;
}

/** Texto da «Vista relatório» (cabeçalho do documento) depois de gerar e abrir a aba «Relatório». */
async function vistaRelatorio(pg: Page): Promise<string> {
  await pg.getByRole("button", { name: /^Gerar relatório$|^Atualizar$/ }).first().click();
  await pg.waitForTimeout(4500);
  await pg.getByRole("button", { name: "Relatório", exact: true }).click();
  await pg.waitForTimeout(800);
  const sec = pg.locator("section", { hasText: "Vista relatório" }).first();
  return (await sec.innerText()).replace(/[ \t]+/g, " ");
}

async function correr(slug: string) {
  console.log(`\n══ tenant ${slug}`);
  const amb = await criarAmbiente(`rc_${slug}`, { E2E_TENANT_SLUG: slug });
  const browser = await chromium.launch();
  try {
    const seed = await semearMargens(amb);
    const ids = [seed.farmacias.alfa, seed.farmacias.beta, seed.farmacias.gama];
    const nomes = ["Farmácia Central", "Farmácia do Mercado", "Farmácia Jardim"];
    for (let i = 0; i < 3; i++) await amb.prisma.farmacia.update({ where: { id: ids[i] }, data: { nome: nomes[i], codigoANF: i === 0 ? "12345" : null } });
    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: "session", value: await amb.tokenSessao(seed.userId, "e2e@spharm.test"), url: baseFor(amb.slug) }]);
    await ctx.addInitScript("window.__name = (f) => f;");
    const base = baseFor(amb.slug);
    const hoje = new Date(`${hojeIsoLisboa()}T00:00:00`).toLocaleDateString("pt-PT");

    for (const [rota, titulo] of [["/excessos", "Relatório de Excessos de Stock"], ["/transferencias", "Relatório de Transferências Sugeridas"]] as const) {
      console.log(`\n── ${rota}: todas as farmácias`);
      let pg = await abrir(ctx, base, rota);
      let vista = await vistaRelatorio(pg);
      check(vista.includes("SPharm.MT · Grupo (3 farmácias)"), "cabeçalho da vista = «SPharm.MT · Grupo (3 farmácias)»", vista.slice(0, 220));
      check(vista.includes(titulo), `título «${titulo}»`);
      check(vista.includes(hoje), `data = hoje (${hoje})`, vista.slice(0, 260));
      check(!PROIBIDO.test(vista) && !PROIBIDO.test(await pg.locator("body").innerText()), "sem NIF/nome de cliente, rodapé nem data fixos (texto visível)");
      check(!PROIBIDO.test(await pg.content()), "nem no HTML da página");
      await pg.close();
    }

    console.log("\n── uma só farmácia ativa");
    await amb.prisma.farmacia.updateMany({ where: { id: { in: [ids[1], ids[2]] } }, data: { estado: "INATIVO" } });
    for (const rota of ["/excessos", "/transferencias"]) {
      const pg = await abrir(ctx, base, rota);
      const vista = await vistaRelatorio(pg);
      check(vista.includes("Farmácia Central · ANF: 12345"), `${rota}: cabeçalho = «Farmácia Central · ANF: 12345»`, vista.slice(0, 220));
      check(!PROIBIDO.test(vista), `${rota}: sem dados fixos de cliente`);
      await pg.close();
    }
    await amb.prisma.farmacia.updateMany({ where: { id: { in: [ids[1], ids[2]] } }, data: { estado: "ATIVO" } });

    console.log("\n── Vendas sem «Ver em ecrã»");
    const pv = await abrir(ctx, base, "/vendas");
    check((await pv.getByRole("button", { name: /Ver em ecrã/ }).count()) === 0, "antes de gerar: botão ausente");
    await pv.getByRole("button", { name: /^Gerar$/ }).first().click();
    await pv.waitForTimeout(4000);
    check((await pv.getByRole("button", { name: /Ver em ecrã/ }).count()) === 0, "depois de gerar: botão ausente");
    const botoes = await pv.getByRole("button").allInnerTexts();
    check(["Atualizar", "Imprimir", "PDF", "Excel", "Email"].every((b) => botoes.some((t) => t.trim() === b)), "Atualizar, Imprimir, PDF, Excel e Email continuam presentes", botoes.join("|").slice(0, 300));
    await pv.close();

    console.log("\n── título do cabeçalho");
    const titulos: Array<[string, string]> = [
      ["/dashboard", "Dashboard"], ["/stock", "Stock"], ["/devolucoes", "Devoluções"], ["/vendas", "Vendas"],
      ["/vendas/manutencao", "Manutenção de vendas"], ["/relatorios/inventario", "Inventário"], ["/relatorios/margens", "Margens"],
      ["/encomendas", "Encomendas"], ["/transferencias", "Transferências"], ["/excessos", "Excessos"], ["/catalogo", "Catálogo"],
      ["/configuracoes/utilizadores", "Utilizadores"], ["/configuracoes/email", "Email"], ["/alterar-password", "Alterar password"],
    ];
    for (const [rota, esperado] of titulos) {
      const pg = await abrir(ctx, base, rota);
      const t = (await pg.getByTestId("titulo-cabecalho").first().innerText().catch(() => "(sem cabeçalho)")).trim();
      check(t === esperado, `${rota} → «${esperado}»`, `obtido «${t}»`);
      await pg.close();
    }
    await ctx.close();
  } finally {
    await browser.close();
    await amb.parar();
  }
}

async function main() {
  for (const slug of ["silveira", "garantia"]) await correr(slug);
  console.log(`\n${ok} OK, ${ko} falhas`);
  process.exit(ko ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
