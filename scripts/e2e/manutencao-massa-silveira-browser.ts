/**
 * scripts/e2e/manutencao-massa-silveira-browser.ts
 *
 * Ensaio de browser real (Chromium via Playwright) contra `next start`
 * local + PostgreSQL descartável para a Manutenção em Massa do catálogo
 * (Área A — `/catalogo/manutencao`, exclusiva do tenant `silveira`).
 * Mesma disciplina dos ensaios existentes (`transferencias-manutencao-browser.ts`,
 * `fornecedor-picker-browser.ts`) — nunca contra uma base real.
 *
 *   docker run -d --name spharm-manut-massa-e2e-pg -e POSTGRES_PASSWORD=test -p 55480:5432 postgres:16-alpine
 *   createdb -h localhost -p 55480 -U postgres spharm_e2e_manutencao_massa
 *   DATABASE_URL=postgresql://postgres:test@localhost:55480/spharm_e2e_manutencao_massa npx prisma migrate deploy
 *   SERVER_ACTIONS_ALLOWED_ORIGINS="localhost:3100,127.0.0.1:3100,*.localhost:3100" npx next build
 *   E2E_DATABASE_URL=postgresql://postgres:test@localhost:55480/spharm_e2e_manutencao_massa bash scripts/e2e/_start-server.sh &
 *   npx tsx scripts/e2e/manutencao-massa-silveira-browser.ts
 *
 * ─────────────────────────────────────────────────────────────────────
 * COMO O SWITCH DE TENANT (pontos 13/14) FOI RESOLVIDO — investigação
 * exaustiva do caminho real, não uma suposição:
 *
 * 1. `middleware.ts` resolve o slug do tenant PELO SUBDOMÍNIO do Host
 *    (`subdomainSlug`, prioridade máxima, sem tocar em BD nenhuma — é
 *    Edge runtime, puro parsing de string). Não exige nenhum registo em
 *    control plane: qualquer label válido e não-reservado (`silveira`,
 *    `garantia`, `sier`) resolve como slug, mesmo que nunca tenha sido
 *    provisionado. O middleware escreve esse slug no header
 *    `x-tenant-slug`, que `resolveCurrentTenantSlug()`
 *    (`lib/tenant-context.ts`) lê como fonte única de verdade.
 * 2. O middleware TAMBÉM exige que o claim `tenant` do JWT da sessão
 *    bata com o slug resolvido (`sessao.tenant !== (slug ?? LEGACY_TENANT)`
 *    → redirect para /login) — por isso as sessões forjadas abaixo usam
 *    sempre `tenant` igual ao subdomínio da navegação.
 * 3. `getTenantPrismaOrLegacy` (`lib/tenant-registry.ts`) só resolve uma
 *    BASE FÍSICA distinta por slug através do control plane
 *    (`CONTROL_DATABASE_URL`) — sem control plane configurado (como aqui:
 *    só `DATABASE_URL`), o warm-up falha em silêncio e QUALQUER slug cai
 *    no cliente legacy (`ALLOW_LEGACY_DATABASE_FALLBACK=1`, como
 *    `_start-server.sh` já define). Ou seja: neste ambiente descartável,
 *    "silveira", "garantia" e "sier" resolvem, todos, para a MESMA base
 *    física — mas isso NÃO compromete o ensaio, porque:
 * 4. A guarda (`TENANT_CATALOGO_MASSA`, comparação de STRING) em
 *    `app/catalogo/manutencao/page.tsx` e em `guardaBase()`
 *    (`app/catalogo/manutencao/actions.ts`) corre ANTES de qualquer
 *    `getPrisma()`/query — decide inteiramente pelo slug resolvido, nunca
 *    pela base física por trás dele. Por isso NÃO foi preciso provisionar
 *    bases físicas separadas por tenant (a exceção que o enunciado previa
 *    "se for mesmo inevitável") — bastou fazer o Host real resolver
 *    slugs distintos via subdomínio (`silveira.localhost:3100`,
 *    `garantia.localhost:3100`, `sier.localhost:3100` — o Chromium do
 *    Playwright resolve `*.localhost` para loopback nativamente; reforçado
 *    aqui com `--host-resolver-rules` no lançamento do browser, para não
 *    depender de comportamento implícito) e sessões forjadas com o claim
 *    `tenant` a condizer.
 * 5. Ponto 13 (renderização da página) é um teste de HTTP real, ponta-a-
 *    ponta, sem nenhum atalho: navegação real do browser a
 *    `garantia.localhost:3100/catalogo/manutencao` e a
 *    `sier.localhost:3100/catalogo/manutencao`, confirmando que a UI de
 *    manutenção NUNCA renderiza (Next `notFound()` — página 404 real).
 * 6. Ponto 14 (a MESMA guarda dentro da própria server action, não só a
 *    da página) é o caso mais difícil: reproduzir o protocolo interno de
 *    Server Actions do Next (cabeçalho `Next-Action` com o id da acção
 *    compilada, corpo em flight-format) à mão é frágil e foi
 *    explicitamente declarado fora de alcance no precedente
 *    (`transferencias-manutencao-browser.ts`, ver o cabeçalho desse
 *    ficheiro). Em vez disso, chama-se a MESMA função exportada e real
 *    (`listarProdutosManutencaoMassaAction`/`aplicarManutencaoFabricanteAction`,
 *    de `app/catalogo/manutencao/actions.ts`) directamente em Node — mas
 *    SEM simular nada do lado de negócio: o único ponto mockado é a
 *    fronteira mais externa e puramente de plataforma,
 *    `next/headers.headers()`, substituída por um loader ESM
 *    (`_next-headers-loader.mjs`/`_fake-next-headers.js`, ao lado deste
 *    ficheiro) que devolve um header `x-tenant-slug` controlado pelo
 *    teste. Confirmado empiricamente (não assumido): `Module._resolveFilename`
 *    (o truque já usado para `server-only`) NÃO intercepta o
 *    `await import("next/headers")` DINÂMICO de `resolveCurrentTenantSlug`
 *    — esse import passa pelo loader ESM de Node, não pelo require CJS.
 *    Só um hook `module.register()` (Node 20.6+) o intercepta. Isto foi
 *    testado isoladamente antes de escrever o resto deste ficheiro (ver
 *    histórico do commit) — com o hook, `resolveCurrentTenantSlug()`
 *    devolve exactamente o slug fake pedido, e a acção real, chamada a
 *    seguir, rejeita com a MESMA mensagem que a UI mostra, ANTES de tocar
 *    em `getSession()`/`getPrisma()` (confirmado por leitura do código:
 *    `guardaBase()` verifica o tenant ANTES de tudo o resto). Nenhuma
 *    lógica de negócio é mockada — só a primitiva de leitura de headers.
 */
import { chromium, type Page, type BrowserContext } from "playwright";
import { SignJWT } from "jose";
import Module from "node:module";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

const DB = process.env.E2E_DATABASE_URL ?? "postgresql://postgres:test@localhost:55480/spharm_e2e_manutencao_massa";
const PORT = process.env.E2E_PORT ?? "3100";
const SECRET = process.env.E2E_AUTH_SECRET ?? "e2e-test-secret-e2e-test-secret-0123456789";
for (const u of [DB]) {
  const h = new URL(u).hostname;
  if (h !== "localhost" && h !== "127.0.0.1") { console.error(`RECUSADO: ${h} não é local.`); process.exit(2); }
}
function baseFor(slug: string) {
  return `http://${slug}.localhost:${PORT}`;
}

// `server-only` (import estático em lib/auth.ts, lib/audit.ts, etc.) — via
// CJS require, intercepta-se com `Module._resolveFilename`.
const M = Module as unknown as { _resolveFilename: (r: string, ...a: unknown[]) => string };
const resolverOriginal = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "server-only" ? __filename : resolverOriginal.call(this, request, ...rest);
};
// `next/headers` (import DINÂMICO em lib/tenant-context.ts) — só um hook
// ESM (`module.register`) o intercepta. Ver nota grande no topo do ficheiro.
register(
  pathToFileURL(path.join(__dirname, "_next-headers-loader.mjs")).href,
  pathToFileURL(__filename).href
);

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string, detalhe?: string) {
  if (cond) { passed++; console.log(`  [OK]    ${msg}`); }
  else { failed++; console.log(`  [FALHA] ${msg}${detalhe ? `\n            ${detalhe}` : ""}`); }
}

// ─── Seed ────────────────────────────────────────────────────────────────────

const TOTAL_PRODUTOS = 111; // > 2 * pageSize(50) → garante >= 3 páginas
const IDX_DIVERGENTE = 55;
/** Produto SEM vendas mas com stock actual na farmácia 1: só entra no universo com «Incluir stock sem vendas» ligado (como em Vendas). */
const IDX_STOCK_SEM_VENDAS = 20;

type ProdutoMeta = {
  i: number;
  cnp: number;
  designacao: string;
  tipoArtigo: "MEDICAMENTO" | "PARAFARMACIA";
  classificacaoNivel1: "HIGIENE" | "DERMO";
  temNivel2: boolean;
  fabricante: "ALFA" | "BETA" | null;
  f1TemFornecedor: boolean;
  f2TemFornecedor: boolean;
};

function gerarMeta(): ProdutoMeta[] {
  const out: ProdutoMeta[] = [];
  for (let i = 1; i <= TOTAL_PRODUTOS; i++) {
    const divergente = i === IDX_DIVERGENTE;
    out.push({
      i,
      cnp: 7_300_000 + i,
      designacao: `MM E2E Produto ${String(i).padStart(3, "0")}`,
      tipoArtigo: i % 2 === 0 ? "MEDICAMENTO" : "PARAFARMACIA",
      classificacaoNivel1: i % 2 === 0 ? "HIGIENE" : "DERMO",
      temNivel2: i % 2 === 0 && i % 4 === 0,
      fabricante: divergente ? null : i % 3 === 0 ? "ALFA" : i % 3 === 1 ? "BETA" : null,
      f1TemFornecedor: i % 2 === 0,
      f2TemFornecedor: i % 2 === 0,
    });
  }
  return out;
}
const META = gerarMeta();
const produtoDivergente = META.find((m) => m.i === IDX_DIVERGENTE)!;

/** Produtos (por índice) com movimento de vendas na janela — 1..10 na Norte e 6..15 na Sul (união 1..15). */
const PRODUTOS_COM_VENDAS = Array.from({ length: 15 }, (_, k) => k + 1);
const _hoje = new Date();
const _m1 = new Date(_hoje.getFullYear(), _hoje.getMonth() - 2, 1);
const _m2 = new Date(_hoje.getFullYear(), _hoje.getMonth() - 1, 1);
const _iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const JANELA_VENDAS = { from: _iso(_m1), to: _iso(new Date(_m2.getFullYear(), _m2.getMonth() + 1, 0)) };

type SeedResult = {
  adminUserId: string;
  farmaciaF1Id: string;
  farmaciaF2Id: string;
  labAlfaId: string;
  labBetaId: string;
  labGamaId: string;
  fornecedorUmId: string;
  fornecedorDoisId: string;
  fornecedorTresId: string;
  higieneId: string;
  dermoId: string;
  escovasId: string;
  produtoIdByIndex: Map<number, string>;
};

async function seed(databaseUrl: string): Promise<SeedResult> {
  const { PrismaClient } = await import("../../generated/prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  try {
    // Idempotência entre corridas: `Produto`/`ProdutoFarmacia`/etc. são
    // repostos por `upsert` (nunca acumulam), mas o HISTÓRICO de operações
    // não tem chave natural nenhuma — sem isto, correr este ficheiro uma
    // 2ª vez contra a MESMA base descartável deixa operações de corridas
    // anteriores por cima, e os Passos 10-12 (que pressupõem exactamente
    // 1 operação FABRICANTE/MANUTENCAO_MASSA) deixam de ser determinísticos.
    await prisma.catalogoManutencaoOperacaoItem.deleteMany({});
    await prisma.catalogoManutencaoOperacao.deleteMany({});

    const admin = await prisma.utilizador.upsert({
      where: { email: "e2e-manutencao-massa@spharm.test" },
      update: {},
      create: { email: "e2e-manutencao-massa@spharm.test", nome: "E2E Manutenção Massa Admin", perfil: "ADMINISTRADOR" },
    });
    const f1 = await prisma.farmacia.upsert({
      where: { nome: "MM E2E Farmácia Silveira Norte" }, update: {},
      create: { nome: "MM E2E Farmácia Silveira Norte" },
    });
    const f2 = await prisma.farmacia.upsert({
      where: { nome: "MM E2E Farmácia Silveira Sul" }, update: {},
      create: { nome: "MM E2E Farmácia Silveira Sul" },
    });
    const labAlfa = await prisma.fabricante.upsert({ where: { nomeNormalizado: "MM E2E LAB ALFA" }, update: {}, create: { nomeNormalizado: "MM E2E LAB ALFA" } });
    const labBeta = await prisma.fabricante.upsert({ where: { nomeNormalizado: "MM E2E LAB BETA" }, update: {}, create: { nomeNormalizado: "MM E2E LAB BETA" } });
    const labGama = await prisma.fabricante.upsert({ where: { nomeNormalizado: "MM E2E LAB GAMA" }, update: {}, create: { nomeNormalizado: "MM E2E LAB GAMA" } });
    const fornUm = await prisma.fornecedor.upsert({ where: { nomeNormalizado: "MM E2E FORNECEDOR UM" }, update: {}, create: { nomeNormalizado: "MM E2E FORNECEDOR UM", nome: "MM E2E Fornecedor Um" } });
    const fornDois = await prisma.fornecedor.upsert({ where: { nomeNormalizado: "MM E2E FORNECEDOR DOIS" }, update: {}, create: { nomeNormalizado: "MM E2E FORNECEDOR DOIS", nome: "MM E2E Fornecedor Dois" } });
    const fornTres = await prisma.fornecedor.upsert({ where: { nomeNormalizado: "MM E2E FORNECEDOR TRES" }, update: {}, create: { nomeNormalizado: "MM E2E FORNECEDOR TRES", nome: "MM E2E Fornecedor Três" } });

    // `upsert` não serve para um NIVEL_1 (classificacaoPaiId=null): o tipo
    // gerado para o índice composto `nome_tipo_classificacaoPaiId` exige
    // `classificacaoPaiId: string` (não aceita `null`) — limitação conhecida
    // do Prisma em índices compostos com campo nullable. `findFirst`+`create`
    // é idempotente o suficiente para um seed que pode correr várias vezes.
    async function classificacaoNivel1(nome: string) {
      const existente = await prisma.classificacao.findFirst({ where: { nome, tipo: "NIVEL_1", classificacaoPaiId: null } });
      return existente ?? prisma.classificacao.create({ data: { nome, tipo: "NIVEL_1" } });
    }
    const higiene = await classificacaoNivel1("MM E2E Higiene Oral");
    const dermo = await classificacaoNivel1("MM E2E Dermocosmética");
    const escovas = await prisma.classificacao.upsert({
      where: { nome_tipo_classificacaoPaiId: { nome: "MM E2E Escovas", tipo: "NIVEL_2", classificacaoPaiId: higiene.id } },
      update: {}, create: { nome: "MM E2E Escovas", tipo: "NIVEL_2", classificacaoPaiId: higiene.id },
    });

    const utilTosse = await prisma.utilizacao.upsert({ where: { slug: "mm-e2e-tosse" }, update: {}, create: { slug: "mm-e2e-tosse", nome: "MM E2E Tosse" } });
    await prisma.vendaMensal.deleteMany({ where: { farmaciaId: { in: [f1.id, f2.id] } } });
    const produtoIdByIndex = new Map<number, string>();
    for (const m of META) {
      const fabricanteId = m.fabricante === "ALFA" ? labAlfa.id : m.fabricante === "BETA" ? labBeta.id : null;
      const p = await prisma.produto.upsert({
        where: { cnp: m.cnp },
        update: {
          designacao: m.designacao,
          tipoArtigo: m.tipoArtigo,
          classificacaoNivel1Id: m.classificacaoNivel1 === "HIGIENE" ? higiene.id : dermo.id,
          classificacaoNivel2Id: m.temNivel2 ? escovas.id : null,
          fabricanteId,
        },
        create: {
          cnp: m.cnp,
          designacao: m.designacao,
          tipoArtigo: m.tipoArtigo,
          classificacaoNivel1Id: m.classificacaoNivel1 === "HIGIENE" ? higiene.id : dermo.id,
          classificacaoNivel2Id: m.temNivel2 ? escovas.id : null,
          fabricanteId,
          estado: "VALIDADO",
        },
      });
      produtoIdByIndex.set(m.i, p.id);
      if (m.i % 10 === 0) {
        await prisma.produtoUtilizacao.upsert({
          where: { produtoId_utilizacaoId: { produtoId: p.id, utilizacaoId: utilTosse.id } },
          update: {}, create: { produtoId: p.id, utilizacaoId: utilTosse.id, fonte: "E2E" },
        });
      }
      for (const [farmaciaId, ate] of [[f1.id, 10], [f2.id, 15]] as const) {
        const desde = farmaciaId === f1.id ? 1 : 6;
        if (m.i >= desde && m.i <= ate) {
          for (const mes of [_m1, _m2]) {
            await prisma.vendaMensal.create({
              data: { farmaciaId, produtoId: p.id, ano: mes.getFullYear(), mes: mes.getMonth() + 1, quantidade: 10, valorTotal: 100, naturezaVenda: "NORMAL" },
            });
          }
        }
      }

      const fabricanteErpF1 = m.i === IDX_DIVERGENTE ? "MM E2E LAB ALFA" : (m.fabricante ? `MM E2E LAB ${m.fabricante}` : null);
      const fabricanteErpF2 = m.i === IDX_DIVERGENTE ? "MM E2E LAB BETA" : (m.fabricante ? `MM E2E LAB ${m.fabricante}` : null);

      await prisma.produtoFarmacia.upsert({
        where: { produtoId_farmaciaId: { produtoId: p.id, farmaciaId: f1.id } },
        update: { fornecedorHabitualId: m.f1TemFornecedor ? fornUm.id : null, fabricanteErpAtual: fabricanteErpF1, fornecedorOrigem: m.i % 2 === 0 ? "MM E2E DIST UM" : null, stockAtual: m.i === IDX_STOCK_SEM_VENDAS ? 5 : 0 },
        create: { produtoId: p.id, farmaciaId: f1.id, fornecedorHabitualId: m.f1TemFornecedor ? fornUm.id : null, fabricanteErpAtual: fabricanteErpF1, fornecedorOrigem: m.i % 2 === 0 ? "MM E2E DIST UM" : null, stockAtual: m.i === IDX_STOCK_SEM_VENDAS ? 5 : 0 },
      });
      await prisma.produtoFarmacia.upsert({
        where: { produtoId_farmaciaId: { produtoId: p.id, farmaciaId: f2.id } },
        update: { fornecedorHabitualId: m.f2TemFornecedor ? fornDois.id : null, fabricanteErpAtual: fabricanteErpF2 },
        create: { produtoId: p.id, farmaciaId: f2.id, fornecedorHabitualId: m.f2TemFornecedor ? fornDois.id : null, fabricanteErpAtual: fabricanteErpF2 },
      });
    }

    return {
      adminUserId: admin.id,
      farmaciaF1Id: f1.id,
      farmaciaF2Id: f2.id,
      labAlfaId: labAlfa.id,
      labBetaId: labBeta.id,
      labGamaId: labGama.id,
      fornecedorUmId: fornUm.id,
      fornecedorDoisId: fornDois.id,
      fornecedorTresId: fornTres.id,
      higieneId: higiene.id,
      dermoId: dermo.id,
      escovasId: escovas.id,
      produtoIdByIndex,
    };
  } finally {
    await prisma.$disconnect();
  }
}

// ─── Sessões forjadas ────────────────────────────────────────────────────────

async function tokenPara(tenant: string, sub: string, email: string) {
  return new SignJWT({
    sub, email, nome: `E2E ${tenant}`, perfil: "ADMINISTRADOR", farmaciaId: null, tenant,
  }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("8h").sign(new TextEncoder().encode(SECRET));
}

async function contextoParaTenant(browser: import("playwright").Browser, tenant: string, sub: string, email: string): Promise<BrowserContext> {
  const token = await tokenPara(tenant, sub, email);
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: "session", value: token, url: baseFor(tenant) }]);
  return ctx;
}

// ─── Locators auxiliares ────────────────────────────────────────────────────
// Os filtros são os COMPONENTES DE VENDAS (SearchableMultiSelect, ToggleRow, …):
// cada multi-selecção tem um campo «Pesquisar <label>...» e botões-opção.
function blocoMulti(page: Page, label: string) {
  return page.locator("div[class*=\"rounded-xl\"]", { has: page.locator(`input[placeholder="Pesquisar ${label.toLowerCase()}..."]`) }).first();
}
async function escolherMulti(page: Page, label: string, opcao: string) {
  const bloco = blocoMulti(page, label);
  await bloco.locator("input").fill(opcao);
  await bloco.getByRole("button", { name: opcao, exact: true }).click();
  await bloco.locator("input").fill("");
  await page.waitForTimeout(450);
}
async function opcoesMulti(page: Page, label: string): Promise<string[]> {
  const bloco = blocoMulti(page, label);
  const textos = await bloco.locator("button").allInnerTexts();
  return textos.map((t) => t.replace(/✓/g, "").trim()).filter(Boolean).sort();
}
/** Estado do interruptor (ToggleRow) pelo seu rótulo: `role="switch"` + `aria-checked`. */
async function estadoToggle(page: Page, rotulo: string): Promise<boolean> {
  return (await page.getByRole("switch", { name: rotulo, exact: true }).getAttribute("aria-checked")) === "true";
}
async function abrirFiltros(page: Page) {
  const painel = page.locator('input[placeholder="Pesquisar farmácia..."]');
  if (!(await painel.count())) await page.getByRole("button", { name: /^Filtros/ }).click();
  await painel.first().waitFor({ state: "visible" });
}
async function limparFiltros(page: Page) {
  await page.getByRole("button", { name: /Limpar filtros/ }).click();
  await page.waitForTimeout(500);
}
async function selecionarAba(page: Page, aba: "Fabricantes" | "Fornecedores") {
  await page.getByRole("button", { name: aba, exact: true }).click();
  await page.waitForTimeout(400);
}
async function totalVisivel(page: Page): Promise<number> {
  const txt = await page.getByTestId("contagem-resultados").innerText();
  const m = txt.match(/^(\d+)/);
  return m ? Number(m[1]) : NaN;
}
async function contagemSeleccionada(page: Page): Promise<number> {
  return Number((await page.getByTestId("contagem-selecionados").innerText()).trim());
}
async function esperarTotal(page: Page, esperado: number, ms = 8000): Promise<number> {
  const fim = Date.now() + ms;
  let v = NaN;
  while (Date.now() < fim) {
    v = await totalVisivel(page).catch(() => NaN);
    if (v === esperado) return v;
    await page.waitForTimeout(200);
  }
  return v;
}
async function escolherDestino(page: Page, tipo: "FABRICANTE" | "FORNECEDOR", nome: string) {
  const campo = page.getByLabel(tipo === "FABRICANTE" ? "Destino: fabricante" : "Destino: fornecedor habitual");
  await campo.fill(nome);
  await page.getByTestId("destino-picker").getByRole("button", { name: nome, exact: true }).click();
  await page.waitForTimeout(300);
}
async function lerDd(page: Page, testid: string): Promise<string> {
  return (await page.getByTestId(testid).innerText()).trim();
}

// ─── Passo 1 — abrir o ecrã como silveira ────────────────────────────────────
async function passo1(ctx: BrowserContext): Promise<Page> {
  console.log("\nPasso 1 · abrir /catalogo/manutencao como silveira");
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1700, height: 1100 });
  await page.goto(`${baseFor("silveira")}/catalogo/manutencao`, { waitUntil: "networkidle" });
  check(await page.getByRole("heading", { name: "Manutenção em massa do catálogo" }).isVisible(), "Passo 1: cabeçalho da página visível");
  check(await page.getByRole("button", { name: "Fabricantes", exact: true }).isVisible(), "Passo 1: aba Fabricantes visível");
  check(await page.getByRole("button", { name: "Fornecedores", exact: true }).isVisible(), "Passo 1: aba Fornecedores visível");
  check(await page.getByPlaceholder("Pesquisar por CNP ou descrição...").isVisible(), "Passo 1: a barra de filtros é a de Vendas (campo «Produto», datas, «Filtros», «Limpar filtros»)");
  check((await page.getByLabel("Data início").count()) === 1 && (await page.getByRole("button", { name: /^Filtros/ }).count()) === 1, "Passo 1: datas e botão «Filtros» presentes");
  return page;
}

// ─── Passo 2 — as opções são as MESMAS de Vendas ─────────────────────────────
async function passo2(ctx: BrowserContext, page: Page) {
  console.log("\nPasso 2 · opções e comportamento iguais aos de Vendas (mesmo componente, mesmas opções)");
  await abrirFiltros(page);
  const vendas = await ctx.newPage();
  await vendas.setViewportSize({ width: 1700, height: 1100 });
  await vendas.goto(`${baseFor("silveira")}/vendas`, { waitUntil: "networkidle" });
  await vendas.getByRole("button", { name: /^Filtros/ }).click();
  await vendas.locator('input[placeholder="Pesquisar farmácia..."]').waitFor();

  for (const [rotuloVendas, rotuloManut] of [["Farmácia", "Farmácia"], ["Distribuidor", "Distribuidor"], ["Categoria", "Categoria"], ["Subcategoria", "Subcategoria"], ["Utilização", "Utilização"], ["Fabricante", "Fabricante atual"]] as const) {
    const a = await opcoesMulti(vendas, rotuloVendas);
    const b = await opcoesMulti(page, rotuloManut);
    check(a.length > 0 && JSON.stringify(a) === JSON.stringify(b), `Passo 2: «${rotuloManut}» tem as MESMAS ${a.length} opções que «${rotuloVendas}» em Vendas`, `vendas=${a.slice(0, 5)} manut=${b.slice(0, 5)}`);
  }
  // Mesma pesquisa dentro de um multi-select: filtra as opções, igual nos dois.
  for (const p of [vendas, page]) await blocoMulti(p, p === vendas ? "Categoria" : "Categoria").locator("input").fill("Higiene");
  const fa = await opcoesMulti(vendas, "Categoria");
  const fb = await opcoesMulti(page, "Categoria");
  check(JSON.stringify(fa) === JSON.stringify(fb) && fa.length >= 1 && fa.every((t) => /higiene/i.test(t)), "Passo 2: a pesquisa dentro do multi-select filtra as opções da mesma forma nos dois ecrãs");
  for (const p of [vendas, page]) await blocoMulti(p, "Categoria").locator("input").fill("");
  // Subcategoria em cascata: escolher categoria restringe as subcategorias, igual nos dois.
  for (const p of [vendas, page]) {
    const b = blocoMulti(p, "Categoria");
    await b.getByRole("button", { name: "MM E2E Higiene Oral", exact: true }).click();
  }
  await vendas.waitForTimeout(300);
  await page.waitForTimeout(500);
  const sa = await opcoesMulti(vendas, "Subcategoria");
  const sb = await opcoesMulti(page, "Subcategoria");
  check(JSON.stringify(sa) === JSON.stringify(sb), "Passo 2: a cascata categoria → subcategoria dá as mesmas opções nos dois ecrãs", `vendas=${sa.slice(0, 4)} manut=${sb.slice(0, 4)}`);
  // «Limpar filtros» remove a selecção nos dois.
  await vendas.getByRole("button", { name: /Limpar filtros/ }).click();
  await limparFiltros(page);
  check((await vendas.locator("span.rounded-full", { hasText: "MM E2E Higiene Oral" }).count()) === 0 && (await page.locator("span.rounded-full", { hasText: "MM E2E Higiene Oral" }).count()) === 0, "Passo 2: «Limpar filtros» remove o valor escolhido (chips) nos dois ecrãs");

  // «Incluir stock sem vendas» (apenasComStock): MESMO estado inicial nos dois e «Limpar filtros» repõe-no ao inicial.
  const ROT = "Incluir stock sem vendas";
  // Na Manutenção o interruptor só é relevante (e visível) com um período de vendas definido.
  await page.getByLabel("Data início").fill(JANELA_VENDAS.from);
  await page.getByLabel("Data fim").fill(JANELA_VENDAS.to);
  await page.waitForTimeout(400);
  check((await estadoToggle(vendas, ROT)) === true && (await estadoToggle(page, ROT)) === true, "Passo 2: ao abrir, «Incluir stock sem vendas» está LIGADO em Vendas e na Manutenção (estado inicial único)");
  for (const p of [vendas, page]) await p.getByRole("switch", { name: ROT, exact: true }).click();
  await vendas.waitForTimeout(200);
  check((await estadoToggle(vendas, ROT)) === false && (await estadoToggle(page, ROT)) === false, "Passo 2: desligar funciona nos dois");
  await vendas.getByRole("button", { name: /Limpar filtros/ }).click();
  await limparFiltros(page);
  check((await estadoToggle(vendas, ROT)) === true && (await estadoToggle(page, ROT)) === true, "Passo 2: «Limpar filtros» repõe «Incluir stock sem vendas» ao estado inicial (LIGADO) nos dois — antes, Vendas repunha DESLIGADO");
  await page.getByLabel("Data início").fill("");
  await page.getByLabel("Data fim").fill("");
  await page.waitForTimeout(400);
  await vendas.close();
}

// ─── Passo 3 — filtros dos Fabricantes (Fabricante actual + combinações) ─────
async function passo3(page: Page, seedData: SeedResult) {
  console.log("\nPasso 3 · filtros (Fabricantes) — contagens exactas contra o que foi semeado");
  await selecionarAba(page, "Fabricantes");
  await abrirFiltros(page);
  await limparFiltros(page);
  const todos = META.length;
  check((await esperarTotal(page, todos)) === todos, `Passo 3a: sem filtros = todo o catálogo (${todos})`);

  // Fabricante atual — um
  await escolherMulti(page, "Fabricante atual", "MM E2E LAB ALFA");
  const nAlfa = META.filter((m) => m.fabricante === "ALFA").length;
  check((await esperarTotal(page, nAlfa)) === nAlfa, `Passo 3b: Fabricante actual = ALFA devolve ${nAlfa}`);
  // vários
  await escolherMulti(page, "Fabricante atual", "MM E2E LAB BETA");
  const nAlfaBeta = META.filter((m) => m.fabricante === "ALFA" || m.fabricante === "BETA").length;
  check((await esperarTotal(page, nAlfaBeta)) === nAlfaBeta, `Passo 3c: ALFA + BETA devolve ${nAlfaBeta}`);
  // + sem fabricante (OU)
  await page.getByText("Sem fabricante", { exact: true }).click();
  await page.waitForTimeout(500);
  check((await esperarTotal(page, todos)) === todos, `Passo 3d: ALFA + BETA + «Sem fabricante» (OU) devolve ${todos}`);
  await page.getByText("Sem fabricante", { exact: true }).click();
  await page.waitForTimeout(400);

  // combinação com categoria / subcategoria / tipo / pesquisa
  await escolherMulti(page, "Categoria", "MM E2E Higiene Oral");
  const higAB = META.filter((m) => m.classificacaoNivel1 === "HIGIENE" && (m.fabricante === "ALFA" || m.fabricante === "BETA")).length;
  check((await esperarTotal(page, higAB)) === higAB, `Passo 3e: fabricantes ALFA+BETA ∧ categoria Higiene = ${higAB}`);
  await escolherMulti(page, "Subcategoria", "MM E2E Escovas");
  const escAB = META.filter((m) => m.classificacaoNivel1 === "HIGIENE" && m.temNivel2 && (m.fabricante === "ALFA" || m.fabricante === "BETA")).length;
  check((await esperarTotal(page, escAB)) === escAB, `Passo 3f: … ∧ subcategoria Escovas = ${escAB}`);
  await escolherMulti(page, "Tipo de artigo", "MEDICAMENTO");
  const medEsc = META.filter((m) => m.tipoArtigo === "MEDICAMENTO" && m.classificacaoNivel1 === "HIGIENE" && m.temNivel2 && (m.fabricante === "ALFA" || m.fabricante === "BETA")).length;
  check((await esperarTotal(page, medEsc)) === medEsc, `Passo 3g: … ∧ tipo MEDICAMENTO = ${medEsc}`);
  const tiposOpc = await opcoesMulti(page, "Tipo de artigo");
  check(JSON.stringify(tiposOpc) === JSON.stringify(["MEDICAMENTO", "PARAFARMACIA"]), "Passo 3g: «Tipo de artigo» é multi-selecção e oferece os tipos reais do catálogo", String(tiposOpc));
  await escolherMulti(page, "Tipo de artigo", "PARAFARMACIA");
  const ambosTipos = META.filter((m) => m.classificacaoNivel1 === "HIGIENE" && m.temNivel2 && (m.fabricante === "ALFA" || m.fabricante === "BETA")).length;
  check((await esperarTotal(page, ambosTipos)) === ambosTipos, `Passo 3g: MEDICAMENTO + PARAFARMACIA (OU) = ${ambosTipos}`);
  await blocoMulti(page, "Tipo de artigo").locator("button", { hasText: "PARAFARMACIA" }).first().click(); // clicar na opção marcada (✓) retira-a
  await page.waitForTimeout(300);
  check((await esperarTotal(page, medEsc)) === medEsc, `Passo 3g: retirar um dos tipos volta a ${medEsc}`);
  await page.getByPlaceholder("Pesquisar por CNP ou descrição...").fill("Produto 0");
  const pesq = META.filter((m) => m.tipoArtigo === "MEDICAMENTO" && m.classificacaoNivel1 === "HIGIENE" && m.temNivel2 && (m.fabricante === "ALFA" || m.fabricante === "BETA") && m.designacao.includes("Produto 0")).length;
  check((await esperarTotal(page, pesq)) === pesq, `Passo 3h: … ∧ pesquisa «Produto 0» = ${pesq} (todos os filtros em simultâneo)`);

  // limpar UM filtro (chip) e TODOS
  await page.locator("span.rounded-full", { hasText: "MM E2E Escovas" }).locator("button").click();
  await page.waitForTimeout(500);
  const semEsc = META.filter((m) => m.tipoArtigo === "MEDICAMENTO" && m.classificacaoNivel1 === "HIGIENE" && (m.fabricante === "ALFA" || m.fabricante === "BETA") && m.designacao.includes("Produto 0")).length;
  check((await esperarTotal(page, semEsc)) === semEsc, `Passo 3i: remover só o chip da subcategoria alarga o resultado (${semEsc})`);
  await limparFiltros(page);
  check((await esperarTotal(page, todos)) === todos, "Passo 3j: «Limpar filtros» repõe todo o catálogo");

  // período (movimento de vendas) — o mesmo universo que Vendas: só os produtos vendidos no período
  await page.getByLabel("Data início").fill(JANELA_VENDAS.from);
  await page.getByLabel("Data fim").fill(JANELA_VENDAS.to);
  await page.waitForTimeout(600);
  const nVendidos = PRODUTOS_COM_VENDAS.length;
  const nComStock = nVendidos + 1; // + o produto só com stock (IDX_STOCK_SEM_VENDAS), porque «Incluir stock sem vendas» nasce LIGADO
  check((await esperarTotal(page, nComStock)) === nComStock, `Passo 3k: com período, os ${nVendidos} com vendas + 1 só com stock = ${nComStock} (a mesma regra de Vendas, «Incluir stock sem vendas» ligado)`);
  await page.getByRole("switch", { name: "Incluir stock sem vendas", exact: true }).click();
  check((await esperarTotal(page, nVendidos)) === nVendidos, `Passo 3k: desligar «Incluir stock sem vendas» → só os ${nVendidos} com vendas (a query do servidor acompanha o interruptor)`);
  await limparFiltros(page);
  check(await estadoToggle(page, "Incluir stock sem vendas"), "Passo 3k: «Limpar filtros» volta a ligar o interruptor");
  check((await page.getByLabel("Data início").inputValue()) === JANELA_VENDAS.from && (await page.getByLabel("Data fim").inputValue()) === JANELA_VENDAS.to, "Passo 3k: …e mantém o período (como em Vendas: período é vista, não filtragem)");
  check((await esperarTotal(page, nComStock)) === nComStock, `Passo 3k: …e o servidor volta a devolver ${nComStock} (UI e query sincronizadas)`);
  await page.getByLabel("Data início").fill("");
  await page.getByLabel("Data fim").fill("");
  await page.waitForTimeout(400);

  // fabricante divergente entre farmácias (específico da aba Fabricantes)
  await page.getByText("Fabricante divergente entre farmácias", { exact: true }).click();
  check((await esperarTotal(page, 1)) === 1, "Passo 3l: «Fabricante divergente entre farmácias» devolve exactamente 1");
  check(await page.getByText(produtoDivergente.designacao).isVisible(), "Passo 3l: …o produto semeado como divergente");
  await page.getByText("Fabricante divergente entre farmácias", { exact: true }).click();
  await page.waitForTimeout(400);
  void seedData;
}

// ─── Passo 4 — selecção, e mudar filtros depois de seleccionar ─────────────
async function passo4(page: Page) {
  console.log("\nPasso 4 · selecção entre páginas; mudar os filtros limpa a selecção (nunca fica invisível)");
  await limparFiltros(page);
  await esperarTotal(page, META.length);
  await page.locator("tbody tr").nth(0).locator('input[type="checkbox"]').check();
  await page.locator("tbody tr").nth(1).locator('input[type="checkbox"]').check();
  check((await contagemSeleccionada(page)) === 2, "Passo 4: 2 seleccionadas na página 1");
  await page.getByRole("button", { name: "Seguinte →" }).click();
  await page.waitForTimeout(500);
  await page.locator("tbody tr").nth(0).locator('input[type="checkbox"]').check();
  check((await contagemSeleccionada(page)) === 3, "Passo 4: 3 seleccionadas (2 da página 1 + 1 da 2) — persistem ao paginar");
  await page.getByRole("button", { name: "← Anterior" }).click();
  await page.waitForTimeout(500);
  check(await page.locator("tbody tr").nth(0).locator('input[type="checkbox"]').isChecked(), "Passo 4: ao voltar à página 1 as marcadas continuam marcadas");
  check((await totalVisivel(page)) === META.length, "Passo 4: a paginação não altera a contagem total");

  // mudar um filtro com selecção activa
  await abrirFiltros(page);
  await escolherMulti(page, "Fabricante atual", "MM E2E LAB ALFA");
  await page.waitForTimeout(500);
  check((await contagemSeleccionada(page)) === 0, "Passo 4: mudar o filtro com produtos seleccionados LIMPA a selecção (nada de selecção invisível)");
  check(await page.getByTestId("aviso-selecao").isVisible(), "Passo 4: e avisa explicitamente o utilizador");
  const pv = page.getByTestId("pre-visualizar");
  check(await pv.isDisabled(), "Passo 4: sem selecção não há pré-visualização possível");
  await limparFiltros(page);
}

// ─── Passo 5 — o fluxo completo de FABRICANTES com snapshot ─────────────────
async function passo5(page: Page, seedData: SeedResult): Promise<{ excluida: string; alvoCnps: number[] }> {
  console.log("\nPasso 5 · fluxo: fabricantes actuais + filtros → todos → excluir um → destino → preview verificável");
  await abrirFiltros(page);
  await escolherMulti(page, "Fabricante atual", "MM E2E LAB ALFA");
  await escolherMulti(page, "Fabricante atual", "MM E2E LAB BETA");
  await escolherMulti(page, "Categoria", "MM E2E Higiene Oral");
  const alvo = META.filter((m) => m.classificacaoNivel1 === "HIGIENE" && (m.fabricante === "ALFA" || m.fabricante === "BETA"));
  check((await esperarTotal(page, alvo.length)) === alvo.length, `Passo 5: filtros → ${alvo.length} produtos`);
  await page.getByTestId("selecionar-todos").click();
  await page.waitForTimeout(300);
  check((await contagemSeleccionada(page)) === alvo.length, "Passo 5: «seleccionar todos os resultados» = o total REAL do filtro");
  const primeira = page.locator("tbody tr").nth(0);
  const designacaoExcluida = (await primeira.locator("td").nth(2).innerText()).trim();
  await primeira.locator('input[type="checkbox"]').uncheck();
  await page.waitForTimeout(300);
  check((await contagemSeleccionada(page)) === alvo.length - 1, `Passo 5: desmarcar um dentro de «todos» → ${alvo.length - 1}`);

  await escolherDestino(page, "FABRICANTE", "MM E2E LAB GAMA");
  await page.getByTestId("pre-visualizar").click();
  await page.getByTestId("preview-panel").waitFor({ timeout: 15000 });
  check((await lerDd(page, "preview-correspondentes")) === String(alvo.length), "Passo 5: o preview mostra quantos correspondem ao filtro");
  check((await lerDd(page, "preview-selecionados")) === String(alvo.length - 1), "Passo 5: …e quantos estão SELECCIONADOS (âmbito real da operação)");
  check((await lerDd(page, "preview-destino")).includes("MM E2E LAB GAMA"), "Passo 5: o preview mostra o fabricante de DESTINO");
  check((await lerDd(page, "preview-ja-no-destino")) === "0", "Passo 5: nenhum já tinha o destino");
  check((await lerDd(page, "preview-alterar")) === String(alvo.length - 1), "Passo 5: …vão ser alterados");
  const painel = await page.getByTestId("preview-panel").innerText();
  check(painel.includes("Filtros utilizados") && painel.includes("Fabricante actual") && painel.includes("MM E2E LAB ALFA") && painel.includes("MM E2E LAB BETA") && painel.includes("Categoria: MM E2E Higiene Oral"), "Passo 5: o preview lista os filtros utilizados e os fabricantes actuais");
  check(painel.includes("MM E2E LAB ALFA → ") && painel.includes("MM E2E LAB BETA → "), "Passo 5: …e o actual → destino por valor");
  void seedData;
  return { excluida: designacaoExcluida, alvoCnps: alvo.map((m) => m.cnp) };
}

// ─── Passo 6 — aplicar, só o snapshot, persistência e reversão ─────────────
async function passo6(page: Page, seedData: SeedResult, excluida: string, alvoCnps: number[]) {
  console.log("\nPasso 6 · aplicar exactamente o snapshot confirmado; zero alterações fora dele");
  await page.getByTestId("confirmar-aplicar").click();
  await page.getByTestId("mensagem-final").waitFor({ timeout: 20000 });
  const msg = await page.getByTestId("mensagem-final").innerText();
  check(msg.includes(`${alvoCnps.length - 1} alterado(s)`), `Passo 6: mensagem final = ${alvoCnps.length - 1} alterados`, msg);

  const { PrismaClient } = await import("../../generated/prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB }) });
  try {
    const gama = seedData.labGamaId;
    const comGama = await prisma.produto.findMany({ where: { fabricanteId: gama, cnp: { gte: 7_300_000, lt: 7_400_000 } }, select: { cnp: true, designacao: true } });
    const esperados = alvoCnps.filter((c) => !excluida.endsWith(String(c - 7_300_000).padStart(3, "0")));
    check(comGama.length === alvoCnps.length - 1 && comGama.every((p) => esperados.includes(p.cnp)), "Passo 6: na BD, EXACTAMENTE os produtos do snapshot passaram a LAB GAMA", `obtido=${comGama.length}`);
    check(!comGama.some((p) => p.designacao === excluida), "Passo 6: o produto desmarcado NÃO foi alterado");
    const fora = await prisma.produto.count({ where: { cnp: { gte: 7_300_000, lt: 7_400_000, notIn: alvoCnps }, fabricanteId: gama } });
    check(fora === 0, "Passo 6: nenhum produto FORA do filtro foi alterado");
  } finally {
    await prisma.$disconnect();
  }

  console.log("\nPasso 6b · histórico e reversão");
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Histórico de operações" }).waitFor({ timeout: 10000 });
  const linhaFabricante = page.locator("tbody tr").filter({ hasText: "FABRICANTE" }).filter({ hasText: "MANUTENCAO_MASSA" }).first();
  check((await linhaFabricante.innerText()).includes(String(alvoCnps.length - 1)), "Passo 6b: o histórico mostra a contagem real de alterados");
  await linhaFabricante.getByRole("button", { name: "Reverter" }).click();
  await page.waitForTimeout(2500);
  const prisma2 = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB }) });
  try {
    check((await prisma2.produto.count({ where: { fabricanteId: seedData.labGamaId, cnp: { gte: 7_300_000, lt: 7_400_000 } } })) === 0, "Passo 6b: a reversão restaurou todos os produtos aos fabricantes originais");
    check((await prisma2.catalogoManutencaoOperacao.count({ where: { origem: "REVERSAO" } })) >= 1, "Passo 6b: nasceu uma operação de REVERSAO (a original nunca é apagada)");
  } finally {
    await prisma2.$disconnect();
  }
}

// ─── Passo 7 — preview desactualizado ───────────────────────────────────────
async function passo7(page: Page, seedData: SeedResult) {
  console.log("\nPasso 7 · uma alteração entre o preview e a confirmação é detectada (snapshot)");
  await page.reload({ waitUntil: "networkidle" });
  await selecionarAba(page, "Fabricantes");
  await abrirFiltros(page);
  await escolherMulti(page, "Fabricante atual", "MM E2E LAB ALFA");
  const nAlfa = META.filter((m) => m.fabricante === "ALFA").length;
  await esperarTotal(page, nAlfa);
  await page.getByTestId("selecionar-todos").click();
  await escolherDestino(page, "FABRICANTE", "MM E2E LAB GAMA");
  await page.getByTestId("pre-visualizar").click();
  await page.getByTestId("preview-panel").waitFor({ timeout: 15000 });
  const { PrismaClient } = await import("../../generated/prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB }) });
  try {
    const alvoMuda = META.find((m) => m.fabricante === "ALFA")!;
    await prisma.produto.update({ where: { cnp: alvoMuda.cnp }, data: { fabricanteId: seedData.labBetaId } }); // outra pessoa alterou
    await page.getByTestId("confirmar-aplicar").click();
    await page.getByTestId("erro-manutencao").waitFor({ timeout: 15000 });
    check((await page.getByTestId("erro-manutencao").innerText()).includes("mudaram desde a pré-visualização"), "Passo 7: o apply recusa — «os produtos mudaram desde a pré-visualização»");
    check((await prisma.produto.count({ where: { fabricanteId: seedData.labGamaId, cnp: { gte: 7_300_000, lt: 7_400_000 } } })) === 0, "Passo 7: zero escritas");
    check(!(await page.getByTestId("preview-panel").count()), "Passo 7: o preview obsoleto é descartado (tem de pré-visualizar de novo)");
    await prisma.produto.update({ where: { cnp: alvoMuda.cnp }, data: { fabricanteId: seedData.labAlfaId } });
  } finally {
    await prisma.$disconnect();
  }
}

// ─── Passo 8 — Fornecedores habituais: isolamento por farmácia ─────────────
async function passo8(page: Page, seedData: SeedResult) {
  console.log("\nPasso 8 · fornecedor habitual: farmácia obrigatória, isolada, e ambas EXPLÍCITAS");
  await selecionarAba(page, "Fornecedores");
  await abrirFiltros(page);
  await limparFiltros(page);
  check(await page.getByTestId("farmacia-em-falta").isVisible(), "Passo 8a: sem farmácia seleccionada, pede-se uma farmácia");

  // Farmácia 1 isolada — fornecedor habitual actual (um) → destino
  await escolherMulti(page, "Farmácia", "MM E2E Farmácia Silveira Norte");
  check((await esperarTotal(page, META.length)) === META.length, `Passo 8b: só a farmácia Norte → ${META.length} linhas (não há linhas da Sul)`);
  await escolherMulti(page, "Fornecedor habitual atual", "MM E2E Fornecedor Um");
  const comUmF1 = META.filter((m) => m.f1TemFornecedor).length;
  check((await esperarTotal(page, comUmF1)) === comUmF1, `Passo 8c: Fornecedor habitual actual = Um na Norte → ${comUmF1}`);
  await page.getByText("Sem fornecedor habitual", { exact: true }).click();
  const semF1 = META.filter((m) => !m.f1TemFornecedor).length;
  check((await esperarTotal(page, META.length)) === META.length, "Passo 8d: «Um» OU «sem fornecedor habitual» = todas (OU)");
  await page.getByText("Sem fornecedor habitual", { exact: true }).click();
  await page.locator("span.rounded-full", { hasText: "Fornecedor habitual: MM E2E Fornecedor Um" }).locator("button").click();
  await page.getByText("Sem fornecedor habitual", { exact: true }).click();
  check((await esperarTotal(page, semF1)) === semF1, `Passo 8e: «sem fornecedor habitual» na Norte → ${semF1}`);

  // aplicar SÓ à Norte
  await page.getByTestId("selecionar-todos").click();
  await escolherDestino(page, "FORNECEDOR", "MM E2E Fornecedor Três");
  await page.getByTestId("pre-visualizar").click();
  await page.getByTestId("preview-panel").waitFor({ timeout: 15000 });
  const farmaciasPv = await page.getByTestId("preview-farmacia").count();
  check(farmaciasPv === 1 && (await page.getByTestId("preview-farmacia").first().innerText()).includes("MM E2E Farmácia Silveira Norte"), "Passo 8f: o preview mostra UMA farmácia (Norte) com actual → destino");
  await page.getByTestId("confirmar-aplicar").click();
  await page.getByTestId("mensagem-final").waitFor({ timeout: 20000 });

  const { PrismaClient } = await import("../../generated/prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB }) });
  try {
    const produtoIds = [...seedData.produtoIdByIndex.values()];
    const f1 = await prisma.produtoFarmacia.findMany({ where: { produtoId: { in: produtoIds }, farmaciaId: seedData.farmaciaF1Id }, select: { produtoId: true, fornecedorHabitualId: true } });
    const idParaMeta = new Map(META.map((m) => [seedData.produtoIdByIndex.get(m.i)!, m]));
    check(f1.every((r) => idParaMeta.get(r.produtoId)!.f1TemFornecedor ? r.fornecedorHabitualId === seedData.fornecedorUmId : r.fornecedorHabitualId === seedData.fornecedorTresId), "Passo 8g: Norte — só os «sem fornecedor» passaram a Três; os que tinham Um ficaram");
    const f2 = await prisma.produtoFarmacia.findMany({ where: { produtoId: { in: produtoIds }, farmaciaId: seedData.farmaciaF2Id }, select: { produtoId: true, fornecedorHabitualId: true } });
    check(f2.every((r) => r.fornecedorHabitualId === (idParaMeta.get(r.produtoId)!.f2TemFornecedor ? seedData.fornecedorDoisId : null)), "Passo 8h: a Sul NUNCA foi alterada pela operação da Norte (todos os 111 como estavam)");
  } finally {
    await prisma.$disconnect();
  }

  // AMBAS as farmácias, explicitamente
  console.log("\nPasso 8 (cont.) · ambas as farmácias seleccionadas EXPLICITAMENTE");
  await page.reload({ waitUntil: "networkidle" });
  await selecionarAba(page, "Fornecedores");
  await abrirFiltros(page);
  await escolherMulti(page, "Farmácia", "MM E2E Farmácia Silveira Norte");
  await escolherMulti(page, "Farmácia", "MM E2E Farmácia Silveira Sul");
  await escolherMulti(page, "Fornecedor habitual atual", "MM E2E Fornecedor Dois");
  const dois = META.filter((m) => m.f2TemFornecedor).length;
  check((await esperarTotal(page, dois)) === dois, `Passo 8i: duas farmácias + fornecedor actual «Dois» → ${dois} linhas (só a Sul tem Dois)`);
  await escolherMulti(page, "Fornecedor habitual atual", "MM E2E Fornecedor Três");
  const tresNorte = META.filter((m) => !m.f1TemFornecedor).length;
  check((await esperarTotal(page, dois + tresNorte)) === dois + tresNorte, `Passo 8j: «Dois» ou «Três» nas duas → ${dois + tresNorte} (a Norte passou a ter Três)`);
  await page.getByTestId("selecionar-todos").click();
  await escolherDestino(page, "FORNECEDOR", "MM E2E Fornecedor Um");
  await page.getByTestId("pre-visualizar").click();
  await page.getByTestId("preview-panel").waitFor({ timeout: 15000 });
  check((await page.getByTestId("preview-farmacia").count()) === 2, "Passo 8k: o preview mostra as DUAS farmácias, cada uma com o seu actual → destino");
  await page.getByTestId("confirmar-aplicar").click();
  await page.getByTestId("mensagem-final").waitFor({ timeout: 20000 });
  check((await page.getByTestId("mensagem-final").innerText()).includes("2 operações, uma por farmácia"), "Passo 8l: aplicar a duas farmácias cria duas operações (uma por farmácia)");
}

// ─── Passo 13 — bloqueio de renderização fora de silveira ──────────────────
async function passo13(browser: import("playwright").Browser, seedData: SeedResult) {
  console.log("\nPasso 13 · /catalogo/manutencao NÃO renderiza fora de silveira");
  for (const tenant of ["garantia", "sier"]) {
    const ctx = await contextoParaTenant(browser, tenant, `e2e-${tenant}-admin`, `e2e-${tenant}@spharm.test`);
    const page = await ctx.newPage();
    const resp = await page.goto(`${baseFor(tenant)}/catalogo/manutencao`, { waitUntil: "networkidle" });
    check(resp?.status() === 404, `Passo 13 (${tenant}): resposta HTTP real é 404`, `status=${resp?.status()}`);
    check(!(await page.getByRole("heading", { name: "Manutenção em massa do catálogo" }).count()), `Passo 13 (${tenant}): o cabeçalho da manutenção NUNCA aparece`);
    check(!(await page.getByRole("button", { name: "Fabricantes", exact: true }).count()), `Passo 13 (${tenant}): a aba Fabricantes NUNCA aparece`);
    await ctx.close();
  }
  void seedData;
}

// ─── Passo 14 — a MESMA guarda dentro da própria server action ─────────────
async function passo14(seedData: SeedResult) {
  console.log("\nPasso 14 · o bloqueio aplica-se à PRÓPRIA server action, antes de qualquer query/escrita (ver nota grande no topo do ficheiro)");
  const g = globalThis as unknown as { __E2E_TENANT_SLUG__?: string | null };

  const { PrismaClient } = await import("../../generated/prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB }) });

  try {
    // Sanity check do próprio mecanismo de shim — se isto falhar, o resto
    // do passo 14 não provaria nada (ver a nota do topo do ficheiro).
    g.__E2E_TENANT_SLUG__ = "garantia";
    const { resolveCurrentTenantSlug } = await import("../../lib/tenant-context");
    const slugResolvido = await resolveCurrentTenantSlug();
    check(slugResolvido === "garantia", "Passo 14 (sanity do shim): resolveCurrentTenantSlug() real devolve exactamente o slug fake pedido — o mock funciona antes de confiar nele", `obtido=${slugResolvido}`);

    const { listarProdutosManutencaoMassaAction, aplicarManutencaoFabricanteAction } = await import(
      "../../app/catalogo/manutencao/actions"
    );

    for (const tenant of ["garantia", "sier"]) {
      g.__E2E_TENANT_SLUG__ = tenant;

      const nOperacoesAntes = await prisma.catalogoManutencaoOperacao.count();
      const algumProdutoId = seedData.produtoIdByIndex.get(1)!;
      const produtoAntes = await prisma.produto.findUnique({ where: { id: algumProdutoId }, select: { fabricanteId: true } });

      const rLista = await listarProdutosManutencaoMassaAction({ tipo: "FABRICANTE", filtro: {} });
      check(!rLista.ok && rLista.error === "Funcionalidade não disponível para este tenant.", `Passo 14 (${tenant}): listarProdutosManutencaoMassaAction (leitura) rejeitada com a MESMA mensagem da página`, JSON.stringify(rLista));

      const rAplicar = await aplicarManutencaoFabricanteAction({
        filtro: {},
        destino: { modo: "existente", id: seedData.labGamaId },
        snapshotHash: "x",
      });
      check(!rAplicar.ok && rAplicar.error === "Funcionalidade não disponível para este tenant.", `Passo 14 (${tenant}): aplicarManutencaoFabricanteAction (escrita) rejeitada ANTES de tocar em Prisma`, JSON.stringify(rAplicar));

      // TODAS as outras actions recusam da mesma forma, antes de qualquer query (preview, fornecedor, histórico, reversão, pesquisas).
      const A = await import("../../app/catalogo/manutencao/actions");
      const MSG = "Funcionalidade não disponível para este tenant.";
      const recusas: Array<[string, { ok: boolean; error?: string }]> = [
        ["previewManutencaoFabricanteAction", await A.previewManutencaoFabricanteAction({ filtro: {}, destino: { modo: "existente", id: seedData.labGamaId } })],
        ["previewManutencaoFornecedorAction", await A.previewManutencaoFornecedorAction({ filtro: { farmaciaIds: [seedData.farmaciaF1Id] }, destino: { modo: "existente", id: seedData.fornecedorTresId } })],
        ["aplicarManutencaoFornecedorAction", await A.aplicarManutencaoFornecedorAction({ filtro: { farmaciaIds: [seedData.farmaciaF1Id] }, destino: { modo: "existente", id: seedData.fornecedorTresId }, snapshotHash: "x" })],
        ["listarOperacoesRecentesAction", await A.listarOperacoesRecentesAction()],
        ["reverterOperacaoAction", await A.reverterOperacaoAction({ operacaoId: "qualquer" })],
        ["pesquisarFabricantesAction", await A.pesquisarFabricantesAction("MM")],
        ["pesquisarFornecedoresAction", await A.pesquisarFornecedoresAction("MM")],
      ];
      for (const [nome, r] of recusas) {
        check(!r.ok && r.error === MSG, `Passo 14 (${tenant}): ${nome} recusada antes de qualquer query`, JSON.stringify(r).slice(0, 160));
      }

      const nOperacoesDepois = await prisma.catalogoManutencaoOperacao.count();
      check(nOperacoesDepois === nOperacoesAntes, `Passo 14 (${tenant}): nenhuma CatalogoManutencaoOperacao nova foi criada`);
      const produtoDepois = await prisma.produto.findUnique({ where: { id: algumProdutoId }, select: { fabricanteId: true } });
      check(produtoDepois?.fabricanteId === produtoAntes?.fabricanteId, `Passo 14 (${tenant}): o produto usado como alvo do pedido continua com o mesmo fabricanteId — nada foi escrito`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  const seedData = await seed(DB);
  // `_start-server.sh` arranca com `HOSTNAME=localhost`, que neste ambiente
  // resolve só para `::1` (confirmado por `netstat` — nada a escutar em
  // 127.0.0.1) — por isso os subdomínios têm de resolver para `::1`
  // também, nunca para `127.0.0.1` (esse dava sempre ERR_CONNECTION_REFUSED).
  const browser = await chromium.launch({
    args: [
      "--host-resolver-rules=MAP silveira.localhost [::1],MAP garantia.localhost [::1],MAP sier.localhost [::1]",
    ],
  });
  const ctxSilveira = await contextoParaTenant(browser, "silveira", seedData.adminUserId, "e2e-silveira-admin@spharm.test");

  try {
    const page = await passo1(ctxSilveira);
    await passo2(ctxSilveira, page);
    await passo3(page, seedData);
    await passo4(page);
    const { excluida, alvoCnps } = await passo5(page, seedData);
    await passo6(page, seedData, excluida, alvoCnps);
    await passo7(page, seedData);
    await passo8(page, seedData);
    await page.close();

    await passo13(browser, seedData);
    await passo14(seedData);
  } finally {
    await ctxSilveira.close();
    await browser.close();
  }

  console.log(`\n${passed} ok, ${failed} falhas`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
