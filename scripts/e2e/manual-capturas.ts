/** Exploratório (não commitado): capturas SINTÉTICAS do protótipo do manual + verificações das afirmações do capítulo Vendas. */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { SignJWT } from "jose";
import { baseFor, criarAmbiente, SECRET } from "./_ambiente-silveira";
import { abrirContexto } from "./_grupo-comum";
import { semearMargens } from "./_margens-comum";

const OUT = process.env.VAL_OUT!;
fs.mkdirSync(OUT, { recursive: true });
const NOMES = ["AMOXICILINA", "ATORVASTATINA", "BETAMETASONA", "CETIRIZINA", "DICLOFENAC", "ENALAPRIL", "FLUCONAZOL", "IBUPROFENO", "LORATADINA", "METFORMINA", "OMEPRAZOL", "PARACETAMOL"];
const info: Record<string, unknown> = {};

async function marcar(page: Page, alvos: Array<{ loc: ReturnType<Page["locator"]>; n: number; dx?: number; dy?: number }>) {
  for (const a of alvos) {
    const bb = await a.loc.first().boundingBox();
    if (!bb) { info[`sem_caixa_${a.n}`] = true; continue; }
    await page.evaluate(({ x, y, n }) => {
      const d = document.createElement("div");
      d.textContent = String(n);
      d.setAttribute("data-anotacao", "1");
      d.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:26px;height:26px;border-radius:50%;background:#e11d48;color:#fff;font:700 14px Inter,sans-serif;display:flex;align-items:center;justify-content:center;z-index:99999;box-shadow:0 0 0 3px #fff,0 2px 6px rgba(0,0,0,.35)`;
      document.body.appendChild(d);
    }, { x: Math.round(bb.x + (a.dx ?? -6)), y: Math.round(bb.y + (a.dy ?? -14)), n: a.n });
  }
}
const limpar = (page: Page) => page.evaluate(() => document.querySelectorAll("[data-anotacao]").forEach((e) => e.remove()));

async function main() {
  const amb = await criarAmbiente("manual");
  const browser = await chromium.launch();
  const prisma = amb.prisma;
  try {
    const seed = await semearMargens(amb);
    // ── tudo sintético: nomes neutros ───────────────────────────────
    const nomes = ["Farmácia Central", "Farmácia do Mercado", "Farmácia Jardim"];
    const ids = [seed.farmacias.alfa, seed.farmacias.beta, seed.farmacias.gama];
    for (let i = 0; i < 3; i++) await prisma.farmacia.update({ where: { id: ids[i] }, data: { nome: nomes[i] } });
    await prisma.utilizador.update({ where: { id: seed.userId }, data: { nome: "Utilizador Exemplo", email: "utilizador@exemplo.pt" } });
    const prods = await prisma.produto.findMany({ select: { id: true, cnp: true, designacao: true } });
    for (const p of prods) {
      let d = p.designacao.replace(/E2E/g, "EXEMPLO");
      const m = /^ARTIGO VOL (\d+)/.exec(d);
      if (m) { const i = Number(m[1]); d = `${NOMES[i % NOMES.length]} EXEMPLO ${[250, 500, 1000][i % 3]} MG ${20 + (i % 3) * 10} CMP`; }
      await prisma.produto.update({ where: { id: p.id }, data: { designacao: d } });
    }
    await prisma.$executeRawUnsafe(`UPDATE "Fabricante" SET "nomeNormalizado" = 'LABORATORIO EXEMPLO' WHERE "nomeNormalizado" ILIKE '%E2E%'`);
    // ── atualizações para o bloco do menu ───────────────────────────
    const agora = Date.now();
    const horas = [0.4, 1.2, 26];
    for (let i = 0; i < 2; i++) await prisma.pipelineRun.create({ data: { farmaciaId: ids[i], kind: "daily-pipeline", status: "OK", startedAt: new Date(), finishedAt: new Date(), idempotencyKey: `m-${i}`, updatedAt: new Date(agora - horas[i] * 3_600_000) } });

    const tok = (perfil: string, nome: string, farmaciaId: string | null) =>
      new SignJWT({ sub: seed.userId, email: "utilizador@exemplo.pt", nome, perfil, farmaciaId, tenant: amb.slug })
        .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("8h").sign(new TextEncoder().encode(SECRET));
    const novoCtx = async (perfil: string, nome: string, farmaciaId: string | null) => {
      const c = await browser.newContext();
      await c.addCookies([{ name: "session", value: await tok(perfil, nome, farmaciaId), url: baseFor(amb.slug) }]);
      await c.addInitScript("window.__name = (f) => f;");
      return c;
    };
    const ctx = await novoCtx("ADMINISTRADOR", "Utilizador Exemplo", null);
    const abrir = async (rota: string) => {
      const pg = await ctx.newPage();
      await pg.setViewportSize({ width: 1440, height: 900 });
      await pg.goto(`${baseFor(amb.slug)}${rota}`, { waitUntil: "domcontentloaded", timeout: 90000 });
      await pg.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
      await pg.waitForTimeout(800);
      return pg;
    };
    const area = { x: 242, y: 0, width: 1198, height: 900 };

    // capa: Dashboard
    let pg = await abrir("/dashboard");
    await pg.screenshot({ path: path.join(OUT, "dashboard.png"), clip: { x: 0, y: 0, width: 1440, height: 900 } });
    await pg.close();

    // Vendas — formulário
    pg = await abrir("/vendas");

    const rotulos = await pg.locator("main label, main [class*=text-slate-500]").allInnerTexts();
    info.rotulosForm = rotulos.map((t) => t.trim()).filter(Boolean).slice(0, 40);
    const sel = (t: string) => pg.locator("label", { hasText: t }).first();
    const ctl = (t: string) => sel(t).locator("select, input").first();
    await marcar(pg, [
      { loc: ctl("Âmbito da análise"), n: 1, dx: -12, dy: -12 },
      { loc: ctl("Data início"), n: 2, dx: -12, dy: -12 },
      { loc: ctl("Agrupar por"), n: 3, dx: -12, dy: -12 },
      { loc: pg.getByRole("button", { name: /^Filtros/ }), n: 4, dx: -12, dy: -12 },
      { loc: pg.getByRole("button", { name: "Gerar", exact: true }), n: 5, dx: -12, dy: -12 },
    ]);
    await pg.screenshot({ path: path.join(OUT, "vendas-formulario.png"), clip: { x: 242, y: 118, width: 1198, height: 250 } });
    await limpar(pg);

    // gerar
    await pg.getByRole("button", { name: /^Gerar$/ }).first().click();
    await pg.waitForTimeout(4500);
    info.botoesDepoisDeGerar = await pg.getByRole("button").allInnerTexts().then((a) => a.map((t) => t.trim()).filter(Boolean));
    info.togglesPrecos = {
      venda: await pg.getByText("Incluir preços de venda").count(),
      compra: await pg.getByText("Incluir preços de compra").count(),
    };
    info.thsComTitle = await pg.locator("th[title]").evaluateAll((els) => els.map((e) => `${e.textContent?.trim()} => ${e.getAttribute("title")}`));
    info.tabelaCabecalhos = await pg.locator("table thead th").allInnerTexts();
    info.primeirasLinhas = (await pg.locator("table tbody tr").allInnerTexts()).slice(0, 4).map((t) => t.replace(/\s+/g, " "));
    const semCusto = pg.locator("table tbody tr", { hasText: "ZZ SEM CUSTO" }).first();
    info.linhaSemCusto = (await semCusto.count()) ? (await semCusto.innerText()).replace(/\s+/g, " ") : null;
    info.resumo = (await pg.locator("main").innerText()).split("\n").filter((l) => /linhas|unidades|stock total|custo est|média diária/i.test(l)).slice(0, 8);
    const th = (t: RegExp) => pg.locator("table thead th", { hasText: t }).first();
    await pg.evaluate(() => {
      const t = document.querySelector("table thead") as HTMLElement;
      const y = t.getBoundingClientRect().top + window.scrollY;
      window.scrollTo(0, y - 330);
      const c = document.querySelector("[data-scroll-key]") as HTMLElement | null;
      if (c) c.scrollLeft = c.scrollWidth;
    });
    await pg.waitForTimeout(700);
    await marcar(pg, [
      { loc: th(/Total Unid/i), n: 1, dx: -12, dy: -14 },
      { loc: th(/^\s*Stock/i), n: 2, dx: -12, dy: -14 },
      { loc: th(/Vendas s\/IVA/i), n: 3, dx: -12, dy: -14 },
    ]);
    await pg.screenshot({ path: path.join(OUT, "vendas-tabela.png"), clip: { x: 242, y: 250, width: 1198, height: 520 } });
    await limpar(pg);
    // Criar encomenda a partir das vendas
    const criar = pg.getByRole("button", { name: /Criar encomenda com estes produtos/ });
    info.criarEncomendaVisivel = await criar.count();
    if (await criar.count()) {
      await criar.first().click();
      await pg.waitForTimeout(800);
      info.modalEncomenda = (await pg.locator("[role=dialog], [class*=fixed]").last().innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 400);
      await pg.screenshot({ path: path.join(OUT, "vendas-modal-encomenda.png") });
      await pg.getByRole("button", { name: "Continuar" }).click();
      await pg.waitForURL(/encomendas/, { timeout: 30000 }).catch(() => {});
      await pg.waitForTimeout(1500);
      info.urlAposContinuar = pg.url();
      info.textoAposContinuar = (await pg.locator("main").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 500);
    }
    // Agrupar por (opções) e «Nova análise»
    info.agruparOpcoes = await sel("Agrupar por").locator("select option").allInnerTexts();
    info.ambitoOpcoes = await sel("Âmbito da análise").locator("select option").allInnerTexts();
    info.novaAnalise = await pg.getByText("Nova análise").count();
    await pg.close();

    // perfis em Vendas / Criar encomenda (âmbito Grupo)
    for (const [perfil, fid] of [["OPERADOR", ids[1]], ["GESTOR_FARMACIA", ids[1]], ["GESTOR_GRUPO", null], ["ADMINISTRADOR", null]] as const) {
      const c = await novoCtx(perfil, "Utilizador Exemplo", fid);
      const q = await c.newPage();
      await q.setViewportSize({ width: 1440, height: 900 });
      await q.goto(`${baseFor(amb.slug)}/vendas`, { waitUntil: "domcontentloaded", timeout: 90000 });
      await q.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
      const r: Record<string, unknown> = { url: q.url() };
      r.temFormulario = await q.locator("label", { hasText: "Âmbito da análise" }).count();
      if (r.temFormulario) {
        await q.locator("label", { hasText: "Âmbito da análise" }).locator("select").selectOption("grupo");
        await q.getByRole("button", { name: /^Gerar$/ }).first().click();
        await q.waitForTimeout(4000);
        const b = q.getByRole("button", { name: /Criar encomenda com estes produtos/ });
        r.botao = await b.count();
        if (await b.count()) { r.disabled = await b.first().isDisabled(); r.title = await b.first().getAttribute("title"); }
      }
      info[`perfil_${perfil}`] = r;
      await c.close();
    }

    // barra lateral com o bloco, para a figura do capítulo inicial (recorte do menu)
    pg = await abrir("/dashboard");
    await pg.screenshot({ path: path.join(OUT, "menu-lateral.png"), clip: { x: 0, y: 0, width: 242, height: 900 } });
    await pg.close();

    fs.writeFileSync(path.join(OUT, "verificacoes.json"), JSON.stringify(info, null, 1), "utf8");
    console.log("FEITO");
  } finally {
    await browser.close();
    await amb.parar();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
