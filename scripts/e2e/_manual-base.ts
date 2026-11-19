/** Base partilhada das capturas e validações do manual (dados SINTÉTICOS, base local descartável). */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { SignJWT } from "jose";
import { baseFor, criarAmbiente, SECRET, type Ambiente } from "./_ambiente-silveira";
import { semearMargens, type Semeado } from "./_margens-comum";

export const OUT = process.env.VAL_OUT!;
export const IMG = process.env.IMG_OUT ?? path.join(OUT, "img");
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(IMG, { recursive: true });

export const facts: Record<string, unknown> = {};
export function registar(k: string, v: unknown) { facts[k] = v; }
export function gravarFacts(nome: string) { fs.writeFileSync(path.join(OUT, `${nome}.json`), JSON.stringify(facts, null, 1), "utf8"); }
export const limpa = (t: string) => t.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();

export type Amb = {
  amb: Ambiente; browser: Browser; seed: Semeado; ids: string[]; nomes: string[];
  ctx: BrowserContext;
  novoCtx: (perfil: string, farmaciaId?: string | null, viewport?: { width: number; height: number }) => Promise<BrowserContext>;
  abrir: (rota: string, c?: BrowserContext, vp?: { width: number; height: number }) => Promise<Page>;
  url: (rota: string) => string;
  parar: () => Promise<void>;
};

const NOMES_PROD = ["AMOXICILINA", "ATORVASTATINA", "BETAMETASONA", "CETIRIZINA", "DICLOFENAC", "ENALAPRIL", "FLUCONAZOL", "IBUPROFENO", "LORATADINA", "METFORMINA", "OMEPRAZOL", "PARACETAMOL"];
const LABS = ["LABORATORIO ALFA", "LABORATORIO BETA", "LABORATORIO GAMA", "LABORATORIO DELTA", "LABORATORIO OMEGA"];
const FORMAS = ["Comprimido", "Cápsula", "Xarope", "Pomada", "Solução injetável"];

export async function iniciar(nome: string): Promise<Amb> {
  const amb = await criarAmbiente(nome);
  const browser = await chromium.launch();
  const seed = await semearMargens(amb);
  const prisma = amb.prisma;
  const ids = [seed.farmacias.alfa, seed.farmacias.beta, seed.farmacias.gama];
  const nomes = ["Farmácia Central", "Farmácia do Mercado", "Farmácia Jardim"];
  for (let i = 0; i < 3; i++) await prisma.farmacia.update({ where: { id: ids[i] }, data: { nome: nomes[i], codigoANF: ["12345", "23456", "34567"][i] } });
  await prisma.utilizador.update({ where: { id: seed.userId }, data: { nome: "Utilizador Exemplo", email: "utilizador@exemplo.pt" } });
  // fabricantes e formas sintéticos
  const labs = [];
  for (const l of LABS) labs.push(await prisma.fabricante.upsert({ where: { nomeNormalizado: l }, update: {}, create: { nomeNormalizado: l } }).catch(async () => prisma.fabricante.create({ data: { nomeNormalizado: l } })));
  const prods = await prisma.produto.findMany({ select: { id: true, cnp: true, designacao: true }, orderBy: { cnp: "asc" } });
  let k = 0;
  for (const p of prods) {
    let d = p.designacao.replace(/E2E/g, "EXEMPLO");
    const m = /^ARTIGO VOL (\d+)/.exec(d);
    const data: Record<string, unknown> = {};
    if (m) {
      const i = Number(m[1]);
      d = `${NOMES_PROD[i % NOMES_PROD.length]} EXEMPLO ${[250, 500, 1000][i % 3]} MG ${20 + (i % 3) * 10} CMP`;
      data.fabricanteId = labs[i % labs.length].id;
      data.formaFarmaceutica = FORMAS[i % FORMAS.length];
      data.flagGenerico = i % 5 < 2;
    }
    await prisma.produto.update({ where: { id: p.id }, data: { designacao: d, ...data } });
    k++;
  }
  await prisma.$executeRawUnsafe(`UPDATE "Fabricante" SET "nomeNormalizado" = 'LABORATORIO EXEMPLO' WHERE "nomeNormalizado" ILIKE '%E2E%'`);
  // classificação (categoria / subcategoria)
  const n1 = await prisma.classificacao.create({ data: { nome: "Analgésicos", tipo: "NIVEL_1" } });
  const n1b = await prisma.classificacao.create({ data: { nome: "Antibióticos", tipo: "NIVEL_1" } });
  const n2 = await prisma.classificacao.create({ data: { nome: "Anti-inflamatórios", tipo: "NIVEL_2", classificacaoPaiId: n1.id } });
  for (let i = 1; i <= 150; i++) {
    const cat = i <= 40 ? { classificacaoNivel1Id: n1.id, ...(i <= 20 ? { classificacaoNivel2Id: n2.id } : {}) } : i <= 70 ? { classificacaoNivel1Id: n1b.id } : null;
    if (cat) await prisma.produto.update({ where: { cnp: 7100000 + i }, data: cat });
  }
  // Ético / NETT por farmácia (ERP)
  await prisma.$executeRawUnsafe(`UPDATE "ProdutoFarmacia" SET "eticoNett"='ETICO' WHERE "produtoId" IN (SELECT id FROM "Produto" WHERE cnp BETWEEN 7100001 AND 7100060)`).catch(() => {});
  await prisma.$executeRawUnsafe(`UPDATE "ProdutoFarmacia" SET "eticoNett"='NETT' WHERE "produtoId" IN (SELECT id FROM "Produto" WHERE cnp BETWEEN 7100061 AND 7100090)`).catch(() => {});
  // stocks: cenário de excesso/transferência (Central com muito, Mercado e Jardim com pouco)
  for (let i = 1; i <= 12; i++) {
    const p = await prisma.produto.findUniqueOrThrow({ where: { cnp: 7100000 + i } });
    await prisma.produtoFarmacia.updateMany({ where: { produtoId: p.id, farmaciaId: ids[0] }, data: { stockAtual: 400 + i * 10 } });
    await prisma.produtoFarmacia.updateMany({ where: { produtoId: p.id, farmaciaId: ids[1] }, data: { stockAtual: 2 } });
  }
  // atualizações para o bloco do menu
  const agora = Date.now();
  const h = [0.4, 1.2];
  for (let i = 0; i < 2; i++) await prisma.pipelineRun.create({ data: { farmaciaId: ids[i], kind: "daily-pipeline", status: "OK", startedAt: new Date(), finishedAt: new Date(), idempotencyKey: `m-${i}`, updatedAt: new Date(agora - h[i] * 3_600_000) } });

  const tok = (perfil: string, farmaciaId: string | null) =>
    new SignJWT({ sub: seed.userId, email: "utilizador@exemplo.pt", nome: "Utilizador Exemplo", perfil, farmaciaId, tenant: amb.slug })
      .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("8h").sign(new TextEncoder().encode(SECRET));
  const novoCtx = async (perfil: string, farmaciaId: string | null = null, viewport?: { width: number; height: number }) => {
    const c = await browser.newContext({ viewport: viewport ?? { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    await c.addCookies([{ name: "session", value: await tok(perfil, farmaciaId), url: baseFor(amb.slug) }]);
    await c.addInitScript("window.__name = (f) => f;");
    return c;
  };
  const ctx = await novoCtx("ADMINISTRADOR");
  const url = (rota: string) => `${baseFor(amb.slug)}${rota}`;
  const abrir = async (rota: string, c: BrowserContext = ctx, vp?: { width: number; height: number }) => {
    const pg = await c.newPage();
    await pg.setViewportSize(vp ?? { width: 1440, height: 900 });
    await pg.goto(url(rota), { waitUntil: "domcontentloaded", timeout: 90000 });
    await pg.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    await pg.waitForTimeout(700);
    return pg;
  };
  return { amb, browser, seed, ids, nomes, ctx, novoCtx, abrir, url, parar: async () => { await browser.close(); await amb.parar(); } };
}

/** Número vermelho sobre a imagem, centrado no canto superior esquerdo do alvo. */
export async function marcar(page: Page, alvos: Array<{ loc: ReturnType<Page["locator"]>; n: number; dx?: number; dy?: number }>) {
  for (const a of alvos) {
    const bb = await a.loc.first().boundingBox().catch(() => null);
    if (!bb) { registar(`sem_caixa_${a.n}`, true); continue; }
    await page.evaluate(({ x, y, n }) => {
      const d = document.createElement("div");
      d.textContent = String(n);
      d.setAttribute("data-anotacao", "1");
      d.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:28px;height:28px;border-radius:50%;background:#e11d48;color:#fff;font:700 15px Inter,sans-serif;display:flex;align-items:center;justify-content:center;z-index:99999;box-shadow:0 0 0 3px #fff,0 2px 6px rgba(0,0,0,.35)`;
      document.body.appendChild(d);
    }, { x: Math.round(bb.x + (a.dx ?? (bb.width > 60 ? bb.width - 16 : -12))), y: Math.round(bb.y + (a.dy ?? -14)), n: a.n });
  }
}
export const limparMarcas = (page: Page) => page.evaluate(() => document.querySelectorAll("[data-anotacao]").forEach((e) => e.remove()));

/** Captura uma região (relativa à página já com scroll), com marcas já aplicadas. */
export async function foto(page: Page, nome: string, clip: { x: number; y: number; width: number; height: number }) {
  await page.screenshot({ path: path.join(IMG, `${nome}.png`), clip });
}

/** Região à volta de um ou mais elementos (união das caixas, com margem). */
export async function caixaDe(page: Page, locs: Array<ReturnType<Page["locator"]>>, margem = 16) {
  let x1 = 1e9, y1 = 1e9, x2 = 0, y2 = 0;
  for (const l of locs) {
    const b = await l.first().boundingBox().catch(() => null);
    if (!b) continue;
    x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y); x2 = Math.max(x2, b.x + b.width); y2 = Math.max(y2, b.y + b.height);
  }
  const vp = page.viewportSize() ?? { width: 1440, height: 900 };
  const x = Math.max(0, x1 - margem), y = Math.max(0, y1 - margem);
  return { x, y, width: Math.min(vp.width - x, x2 - x1 + 2 * margem), height: Math.min(vp.height - y, y2 - y1 + 2 * margem) };
}

export async function tentar<T>(nome: string, f: () => Promise<T>): Promise<T | undefined> {
  try { return await f(); } catch (e) { registar(`ERRO_${nome}`, String((e as Error).message).split("\n")[0].slice(0, 220)); return undefined; }
}
export async function texto(page: Page, sel = "main") { return limpa(await page.locator(sel).first().innerText().catch(() => "")); }
