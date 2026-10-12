/**
 * scripts/e2e/_grupo-comum.ts
 *
 * Peças comuns dos ensaios de browser da finalização de Encomendas em modo
 * Grupo (ambiente real: control plane + servidor de produção + PostgreSQL
 * descartável — ver `_ambiente-silveira.ts`).
 */
import { request as httpRequest } from "node:http";
import type { Page, BrowserContext, Route } from "playwright";
import { baseFor, type Ambiente } from "./_ambiente-silveira";
import { seedE2E, type SeedResult } from "./seed-e2e";

export type Contagens = {
  listaEncomenda: number;
  linhaEncomenda: number;
  transferencia: number;
  linhaTransferencia: number;
  orderOutbox: number;
};

export async function contagens(amb: Ambiente): Promise<Contagens> {
  const r = await amb.prisma.$queryRaw<Array<Record<string, bigint>>>`
    SELECT (SELECT count(*) FROM "ListaEncomenda") AS le, (SELECT count(*) FROM "LinhaEncomenda") AS lne,
           (SELECT count(*) FROM "Transferencia") AS t, (SELECT count(*) FROM "LinhaTransferencia") AS lt,
           (SELECT count(*) FROM "OrderOutbox") AS ob`;
  const x = r[0];
  return {
    listaEncomenda: Number(x.le), linhaEncomenda: Number(x.lne), transferencia: Number(x.t),
    linhaTransferencia: Number(x.lt), orderOutbox: Number(x.ob),
  };
}

export async function limparFinalizacoes(amb: Ambiente): Promise<void> {
  await amb.prisma.$executeRawUnsafe(`DELETE FROM "OrderOutbox"`);
  await amb.prisma.$executeRawUnsafe(`DELETE FROM "ListaEncomenda"`);
  await amb.prisma.$executeRawUnsafe(`DELETE FROM "Transferencia"`);
}

/**
 * Semeia o catálogo sintético do E2E (3 farmácias, 6 artigos; os artigos 1 e 2
 * têm excesso na Beta ⇒ 2 transferências; os restantes pedem encomenda nas 3 ⇒
 * 3 encomendas) e, com `multiFornecedor`, atribui dois fornecedores habituais
 * alternados ⇒ cada farmácia divide-se por fornecedor (caminho do motor
 * multi-fornecedor).
 */
export async function semear(amb: Ambiente, opcoes: { multiFornecedor?: boolean } = {}): Promise<SeedResult> {
  const seed = await seedE2E(amb.tenantUrl);
  if (opcoes.multiFornecedor) {
    const fA = await amb.prisma.fornecedor.upsert({ where: { nomeNormalizado: "E2E FORN A" }, update: {}, create: { nomeNormalizado: "E2E FORN A", nome: "E2E Forn A" } });
    const fB = await amb.prisma.fornecedor.upsert({ where: { nomeNormalizado: "E2E FORN B" }, update: {}, create: { nomeNormalizado: "E2E FORN B", nome: "E2E Forn B" } });
    for (const [i, p] of seed.produtos.entries()) {
      await amb.prisma.produtoFarmacia.updateMany({ where: { produtoId: p.id }, data: { fornecedorHabitualId: i % 2 === 0 ? fA.id : fB.id } });
    }
  }
  return seed;
}

export async function abrirContexto(amb: Ambiente, browser: import("playwright").Browser, seed: SeedResult): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: "session", value: await amb.tokenSessao(seed.userId, "e2e@spharm.test"), url: baseFor("silveira") }]);
  return ctx;
}

export async function gerarPropostaGrupo(page: Page): Promise<void> {
  await page.goto(baseFor("silveira") + "/encomendas/nova", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Grupo", exact: true }).click();
  await page.getByRole("button", { name: /Gerar (nova )?proposta/ }).click();
  await page.getByText("ARTIGO E2E 6").first().waitFor({ state: "attached", timeout: 30000 });
}

/** Abre o modal de confirmação e escolhe o modo ("separada" | "consolidada"). */
export async function abrirModalEEscolher(page: Page, modo: "separada" | "consolidada"): Promise<void> {
  await page.getByRole("button", { name: "Finalizar encomenda" }).click();
  await page.getByText("Como pretende gerar a encomenda?").waitFor({ timeout: 10000 });
  if (modo === "consolidada") await page.getByLabel(/Encomenda única do Grupo/).check();
}

// ─── Injecção de falhas nas Server Actions ──────────────────────────────────

export type Comportamento =
  | "continuar"        // passa tal e qual
  | "abortar"          // o pedido nem chega ao servidor (rede cai antes)
  | "resposta-perdida" // o servidor EXECUTA e responde, mas o browser nunca recebe (rede cai depois)
  | "erro-500"         // o servidor devolve 500 (rejeição da Server Action)
  | "pendurar";        // nunca responde

export type Intercepcao = { chamadasPlano: number; chamadasDocs: number; desarmar: () => Promise<void> };

/**
 * Depois de armada, a PRIMEIRA Server Action vista é o plano (gerarPlanoGrupoAction);
 * a primeira com outro id é a de documentos. `plano(n)`/`docs(n)` decidem o
 * comportamento da n-ésima chamada (1-based) de cada uma.
 */
export async function armar(page: Page, cfg: { plano?: (n: number) => Comportamento; docs?: (n: number) => Comportamento }): Promise<Intercepcao> {
  let idPlano: string | null = null;
  let idDocs: string | null = null;
  const estado = { chamadasPlano: 0, chamadasDocs: 0 };
  const handler = async (route: Route) => {
    const req = route.request();
    const id = req.headers()["next-action"];
    if (req.method() !== "POST" || !id) return route.continue();
    if (!idPlano) idPlano = id;
    else if (!idDocs && id !== idPlano) idDocs = id;
    let comp: Comportamento = "continuar";
    if (id === idPlano) { estado.chamadasPlano++; comp = cfg.plano?.(estado.chamadasPlano) ?? "continuar"; }
    else if (id === idDocs) { estado.chamadasDocs++; comp = cfg.docs?.(estado.chamadasDocs) ?? "continuar"; }
    switch (comp) {
      case "abortar": return route.abort("failed");
      case "resposta-perdida": {
        // Executa o pedido REAL no servidor (Host original, pois o Node não resolve *.localhost)
        // e só depois derruba a ligação do browser: o servidor persistiu, o cliente nunca soube.
        const u = new URL(req.url());
        const r = await new Promise<{ status: number; corpo: string }>((resolve, reject) => {
          const pedido = httpRequest(
            { host: "localhost", port: Number(u.port), path: u.pathname + u.search, method: "POST", headers: { ...req.headers(), host: u.host } },
            (res) => { const partes: Buffer[] = []; res.on("data", (d) => partes.push(d)); res.on("end", () => resolve({ status: res.statusCode ?? 0, corpo: Buffer.concat(partes).toString("utf8") })); },
          );
          pedido.on("error", reject);
          pedido.end(req.postDataBuffer());
        });
        console.log("  [resposta-perdida] o servidor respondeu", r.status, "(resposta descartada)");
        return route.abort("failed");
      }
      case "erro-500": return route.fulfill({ status: 500, contentType: "text/plain", body: "Internal Server Error (injectado pelo ensaio)" });
      case "pendurar": return; // nunca cumpre nem aborta
      default: return route.continue();
    }
  };
  await page.route("**/encomendas/nova**", handler);
  return {
    get chamadasPlano() { return estado.chamadasPlano; },
    get chamadasDocs() { return estado.chamadasDocs; },
    desarmar: () => page.unroute("**/encomendas/nova**", handler),
  };
}

