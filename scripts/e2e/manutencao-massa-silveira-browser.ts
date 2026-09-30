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

      const fabricanteErpF1 = m.i === IDX_DIVERGENTE ? "MM E2E LAB ALFA" : (m.fabricante ? `MM E2E LAB ${m.fabricante}` : null);
      const fabricanteErpF2 = m.i === IDX_DIVERGENTE ? "MM E2E LAB BETA" : (m.fabricante ? `MM E2E LAB ${m.fabricante}` : null);

      await prisma.produtoFarmacia.upsert({
        where: { produtoId_farmaciaId: { produtoId: p.id, farmaciaId: f1.id } },
        update: { fornecedorHabitualId: m.f1TemFornecedor ? fornUm.id : null, fabricanteErpAtual: fabricanteErpF1 },
        create: { produtoId: p.id, farmaciaId: f1.id, fornecedorHabitualId: m.f1TemFornecedor ? fornUm.id : null, fabricanteErpAtual: fabricanteErpF1 },
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

// ─── Locators auxiliares — os campos do formulário de filtro não têm
// `htmlFor`/`id` a ligar `<label>` ao controlo (confirmado por leitura de
// `manutencao-massa-client.tsx`): label e input/select são irmãos dentro do
// mesmo <div>, nunca um `<label>` a envolver o controlo. `getByLabel` não
// serve aqui — XPath directo ao irmão seguinte é exacto e sem ambiguidade. ──
function campoPorLabel(page: Page, label: string, tag: "input" | "select") {
  return page.locator(`xpath=//label[normalize-space(text())="${label}"]/following-sibling::${tag}`);
}

async function selecionarAba(page: Page, aba: "Fabricantes" | "Fornecedores") {
  await page.getByRole("button", { name: aba, exact: true }).click();
}

// ─── Passo 1 — abrir o ecrã como silveira ────────────────────────────────────
async function passo1(ctx: BrowserContext): Promise<Page> {
  console.log("\nPasso 1 · abrir /catalogo/manutencao como silveira");
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`${baseFor("silveira")}/catalogo/manutencao`, { waitUntil: "networkidle" });
  check(await page.getByRole("heading", { name: "Manutenção em massa do catálogo" }).isVisible(), "Passo 1: cabeçalho da página visível");
  check(await page.getByRole("button", { name: "Fabricantes", exact: true }).isVisible(), "Passo 1: aba Fabricantes visível");
  check(await page.getByRole("button", { name: "Fornecedores", exact: true }).isVisible(), "Passo 1: aba Fornecedores visível");
  return page;
}

// ─── Passo 2 — filtros, várias combinações, contagens exactas ───────────────
async function passo2(page: Page, seedData: SeedResult) {
  console.log("\nPasso 2 · filtros (Fabricantes) — contagens exactas contra o que foi semeado");
  await selecionarAba(page, "Fabricantes");
  await page.waitForTimeout(300);

  async function totalVisivel(): Promise<number> {
    const txt = await page.locator("span", { hasText: "correspondem ao filtro" }).first().innerText();
    const m = txt.match(/^(\d+)/);
    return m ? Number(m[1]) : NaN;
  }

  // a) tipoArtigo = MEDICAMENTO
  await campoPorLabel(page, "Tipo de artigo", "select").selectOption("MEDICAMENTO");
  await page.waitForTimeout(400);
  const esperadoMedicamento = META.filter((m) => m.tipoArtigo === "MEDICAMENTO").length;
  check((await totalVisivel()) === esperadoMedicamento, `Passo 2a: filtro tipoArtigo=MEDICAMENTO devolve ${esperadoMedicamento}`, `obtido=${await totalVisivel()}`);
  await campoPorLabel(page, "Tipo de artigo", "select").selectOption("");
  await page.waitForTimeout(300);

  // b) designação contém
  await campoPorLabel(page, "Designação contém", "input").fill(`Produto ${String(IDX_DIVERGENTE).padStart(3, "0")}`);
  await page.waitForTimeout(400);
  check((await totalVisivel()) === 1, "Passo 2b: filtro por designação exacta devolve 1");
  await campoPorLabel(page, "Designação contém", "input").fill("");
  await page.waitForTimeout(300);

  // c) categoria (Nivel 1)
  await campoPorLabel(page, "Categoria", "select").selectOption(seedData.higieneId);
  await page.waitForTimeout(400);
  const esperadoHigiene = META.filter((m) => m.classificacaoNivel1 === "HIGIENE").length;
  check((await totalVisivel()) === esperadoHigiene, `Passo 2c: filtro Categoria=Higiene devolve ${esperadoHigiene}`);

  // d) subcategoria (Nivel 2) — só aparece com categoria seleccionada
  await campoPorLabel(page, "Subcategoria", "select").selectOption(seedData.escovasId);
  await page.waitForTimeout(400);
  const esperadoEscovas = META.filter((m) => m.temNivel2).length;
  check((await totalVisivel()) === esperadoEscovas, `Passo 2d: filtro Subcategoria=Escovas devolve ${esperadoEscovas}`);
  await campoPorLabel(page, "Categoria", "select").selectOption("");
  await page.waitForTimeout(300);

  // e/f) sem fabricante — o formulário não expõe "fabricante actual" como
  // campo próprio (é resolvido a partir da grelha noutro fluxo); as duas
  // checkboxes reais desta aba são "Sem fabricante" e "Fabricante divergente".
  console.log("  (nota: \"fabricante actual\" não é um campo do formulário desta aba — só \"Sem fabricante\"/\"Fabricante divergente\", cobertos abaixo)");
  await page.getByLabel("Sem fabricante").check();
  await page.waitForTimeout(400);
  const esperadoSemFabricante = META.filter((m) => m.fabricante === null).length;
  check((await totalVisivel()) === esperadoSemFabricante, `Passo 2f: filtro "Sem fabricante" devolve ${esperadoSemFabricante}`, `obtido=${await totalVisivel()}`);
  await page.getByLabel("Sem fabricante").uncheck();
  await page.waitForTimeout(300);

  // g) fabricante divergente
  await page.getByLabel("Fabricante divergente entre farmácias").check();
  await page.waitForTimeout(400);
  check((await totalVisivel()) === 1, "Passo 2g: filtro \"Fabricante divergente entre farmácias\" devolve exactamente 1");
  check(await page.getByText(produtoDivergente.designacao).isVisible(), "Passo 2g: a linha devolvida é a do produto semeado como divergente");
  await page.getByLabel("Fabricante divergente entre farmácias").uncheck();
  await page.waitForTimeout(300);

  // h) pesquisa textual
  await campoPorLabel(page, "Pesquisa textual (designação/CNP)", "input").fill(String(IDX_DIVERGENTE).padStart(3, "0"));
  await page.waitForTimeout(400);
  check((await totalVisivel()) === 1, "Passo 2h: pesquisa textual por \"055\" devolve exactamente 1");
  await campoPorLabel(page, "Pesquisa textual (designação/CNP)", "input").fill("");
  await page.waitForTimeout(300);

  console.log("\nPasso 2 (cont.) · filtros (Fornecedores) — farmácia obrigatória + sem fornecedor/fornecedor actual");
  await selecionarAba(page, "Fornecedores");
  await page.waitForTimeout(300);
  check(await page.getByText("Seleccione uma farmácia para pesquisar produtos.").isVisible(), "Passo 2i: sem farmácia seleccionada, a grelha pede farmácia (validação real do filtro)");
  await campoPorLabel(page, "Farmácia *", "select").selectOption(seedData.farmaciaF1Id);
  await page.waitForTimeout(400);
  const esperadoTotalF1 = META.length;
  check((await totalVisivel()) === esperadoTotalF1, `Passo 2i: com farmácia F1 seleccionada e sem mais filtros, devolve o total (${esperadoTotalF1})`);

  await page.getByLabel("Sem fornecedor").check();
  await page.waitForTimeout(400);
  const esperadoSemFornecedorF1 = META.filter((m) => !m.f1TemFornecedor).length;
  check((await totalVisivel()) === esperadoSemFornecedorF1, `Passo 2j: "Sem fornecedor" em F1 devolve ${esperadoSemFornecedorF1}`, `obtido=${await totalVisivel()}`);
  await page.getByLabel("Sem fornecedor").uncheck();
  await page.waitForTimeout(300);
}

// ─── Passo 3 — selecção individual através de várias páginas ───────────────
async function passo3(page: Page) {
  console.log("\nPasso 3 · selecção individual em mais do que uma página, persistente ao paginar");
  await selecionarAba(page, "Fabricantes");
  await page.waitForTimeout(300);

  async function contagemSeleccionada(): Promise<number> {
    const txt = await page.locator("strong").first().innerText();
    return Number(txt.trim());
  }

  // Página 1 — marca 2 linhas.
  await page.locator("tbody tr").nth(0).locator('input[type="checkbox"]').check();
  await page.locator("tbody tr").nth(1).locator('input[type="checkbox"]').check();
  check((await contagemSeleccionada()) === 2, "Passo 3: 2 seleccionadas na página 1");

  await page.getByRole("button", { name: "Seguinte →" }).click();
  await page.waitForTimeout(400);
  await page.locator("tbody tr").nth(0).locator('input[type="checkbox"]').check();
  await page.locator("tbody tr").nth(1).locator('input[type="checkbox"]').check();
  check((await contagemSeleccionada()) === 4, "Passo 3: 4 seleccionadas depois de marcar mais 2 na página 2");

  await page.getByRole("button", { name: "Seguinte →" }).click();
  await page.waitForTimeout(400);
  await page.locator("tbody tr").nth(0).locator('input[type="checkbox"]').check();
  check((await contagemSeleccionada()) === 5, "Passo 3: 5 seleccionadas depois de marcar mais 1 na página 3");

  // Volta à página 1 — as 2 marcadas lá continuam marcadas, contagem total mantém-se.
  await page.getByRole("button", { name: "← Anterior" }).click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "← Anterior" }).click();
  await page.waitForTimeout(400);
  check(await page.locator("tbody tr").nth(0).locator('input[type="checkbox"]').isChecked(), "Passo 3: ao voltar à página 1, a 1ª linha continua marcada");
  check(await page.locator("tbody tr").nth(1).locator('input[type="checkbox"]').isChecked(), "Passo 3: ao voltar à página 1, a 2ª linha continua marcada");
  check((await contagemSeleccionada()) === 5, "Passo 3: a contagem total (5) sobrevive a ir e voltar entre páginas");

  await page.getByRole("button", { name: "Limpar selecção" }).click();
  await page.waitForTimeout(300);
  check((await contagemSeleccionada()) === 0, "Passo 3: \"Limpar selecção\" repõe a contagem a 0");
}

// ─── Passo 4 — "seleccionar todos os N que correspondem" + deselecção ──────
async function passo4(page: Page): Promise<{ produtoAExcluirDesignacao: string }> {
  console.log("\nPasso 4 · \"Seleccionar todos os N que correspondem ao filtro\" + deselecção individual");
  await campoPorLabel(page, "Tipo de artigo", "select").selectOption("MEDICAMENTO");
  await page.waitForTimeout(400);

  const esperado = META.filter((m) => m.tipoArtigo === "MEDICAMENTO").length;
  await page.getByRole("button", { name: new RegExp(`Seleccionar todos os ${esperado} que correspondem ao filtro`) }).click();
  await page.waitForTimeout(400);

  async function contagemSeleccionada(): Promise<number> {
    const txt = await page.locator("strong").first().innerText();
    return Number(txt.trim());
  }
  check((await contagemSeleccionada()) === esperado, `Passo 4: "seleccionar todos" reporta o total REAL do servidor (${esperado})`, `obtido=${await contagemSeleccionada()}`);

  // Deselecciona 1 item individual (1ª linha da página actual).
  const primeiraLinha = page.locator("tbody tr").nth(0);
  const designacaoExcluida = (await primeiraLinha.locator("td").nth(2).innerText()).trim();
  await primeiraLinha.locator('input[type="checkbox"]').uncheck();
  await page.waitForTimeout(300);
  check((await contagemSeleccionada()) === esperado - 1, `Passo 4: deselecção individual dentro de "todos" reduz para ${esperado - 1}`);

  return { produtoAExcluirDesignacao: designacaoExcluida };
}

// ─── Passo 5 — preview obrigatório ───────────────────────────────────────────
async function passo5(page: Page, seedData: SeedResult): Promise<number> {
  console.log("\nPasso 5 · pré-visualização obrigatória antes de aplicar");
  await page.getByPlaceholder("Pesquisar fabricante existente…").fill("MM E2E LAB GAMA");
  await page.getByRole("button", { name: "MM E2E LAB GAMA" }).click();
  await page.waitForTimeout(300);

  await page.getByRole("button", { name: "Pré-visualizar alteração" }).click();
  await page.getByText("Confirmação obrigatória").waitFor({ timeout: 10000 });

  const totalCorrespondentes = META.filter((m) => m.tipoArtigo === "MEDICAMENTO").length;
  const totalDd = await page.locator("dt", { hasText: "Total de produtos correspondentes" }).locator("xpath=following-sibling::dd[1]").innerText();
  check(Number(totalDd) === totalCorrespondentes, `Passo 5: preview mostra o total REAL do filtro (${totalCorrespondentes}) — não o subconjunto seleccionado`, `obtido=${totalDd}`);

  // hasText é substring, case-insensitive — "Destino" também bateria em
  // "Já no destino"; regex ancorada evita a colisão.
  const destinoDd = await page.locator("dt", { hasText: /^Destino$/ }).locator("xpath=following-sibling::dd[1]").innerText();
  check(destinoDd.includes("MM E2E LAB GAMA"), "Passo 5: preview mostra o destino escolhido", destinoDd);

  const jaNoDestinoDd = await page.locator("dt", { hasText: "Já no destino" }).locator("xpath=following-sibling::dd[1]").innerText();
  check(Number(jaNoDestinoDd) === 0, "Passo 5: nenhum produto já estava em LAB GAMA (fabricante novo neste ensaio)");

  const iraAlterarDd = await page.locator("dt", { hasText: "Vão ser alterados" }).locator("xpath=following-sibling::dd[1]").innerText();
  check(Number(iraAlterarDd) === totalCorrespondentes, "Passo 5: \"vão ser alterados\" bate com o total (nenhum já no destino)");
  check(await page.locator("li", { hasText: "MM E2E LAB ALFA" }).count() + await page.locator("li", { hasText: "MM E2E LAB BETA" }).count() + await page.locator("li", { hasText: "(sem valor)" }).count() >= 1, "Passo 5: valores anteriores agrupados aparecem listados");

  void seedData;
  return totalCorrespondentes;
}

// ─── Passo 6/7 — aplicar + persistência após reload ─────────────────────────
async function passo6e7(page: Page, seedData: SeedResult, produtoExcluidoDesignacao: string, totalCorrespondentes: number) {
  console.log("\nPasso 6 · aplicar a alteração de fabricante");
  await page.getByRole("button", { name: /Confirmar e aplicar a \d+ produto\(s\)/ }).click();
  await page.getByText(/Operação aplicada:/).waitFor({ timeout: 15000 });
  const msg = await page.getByText(/Operação aplicada:/).innerText();
  check(msg.includes(`${totalCorrespondentes - 1} alterado(s)`), "Passo 6: mensagem final reporta N-1 alterados (o excluído manualmente ficou de fora)", msg);

  console.log("\nPasso 7 · persistência depois de um refresh REAL");
  await page.reload({ waitUntil: "networkidle" });
  await selecionarAba(page, "Fabricantes");
  await campoPorLabel(page, "Designação contém", "input").fill(produtoExcluidoDesignacao.replace("MM E2E ", ""));
  await page.waitForTimeout(400);
  const valorExcluido = await page.locator("tbody tr").nth(0).locator("td").nth(3).innerText();
  check(!valorExcluido.includes("MM E2E LAB GAMA"), "Passo 7 (fixture): o produto EXCLUÍDO manualmente do lote NÃO foi alterado (prova de que a exclusão foi respeitada)", valorExcluido);
  await campoPorLabel(page, "Designação contém", "input").fill("");
  await page.waitForTimeout(300);

  const { PrismaClient } = await import("../../generated/prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB }) });
  try {
    const algumAlterado = META.find((m) => m.tipoArtigo === "MEDICAMENTO" && m.designacao !== produtoExcluidoDesignacao)!;
    const produtoId = seedData.produtoIdByIndex.get(algumAlterado.i)!;
    const p = await prisma.produto.findUnique({ where: { id: produtoId }, select: { fabricanteId: true, fabricante: { select: { nomeNormalizado: true } } } });
    check(p?.fabricante?.nomeNormalizado === "MM E2E LAB GAMA", "Passo 7: a BD real confirma o novo fabricante persistido (não é só optimismo do cliente)", JSON.stringify(p));
  } finally {
    await prisma.$disconnect();
  }
}

// ─── Passo 8/9 — fornecedor preferencial escopado a UMA farmácia ───────────
async function passo8e9(page: Page, seedData: SeedResult) {
  console.log("\nPasso 8 · alterar fornecedor preferencial escopado à Farmácia F1");
  await selecionarAba(page, "Fornecedores");
  await page.waitForTimeout(300);
  await campoPorLabel(page, "Farmácia *", "select").selectOption(seedData.farmaciaF1Id);
  await page.waitForTimeout(400);

  // Escopo: TODO o catálogo de F1 (111 produtos — sem outro filtro além da
  // farmácia, que É o escopo em si). O formulário desta aba não expõe um
  // filtro directo por "fornecedor actual" (ver nota no Passo 2) — mas
  // aplicar a todo o catálogo de F1 continua a ser uma prova tão forte do
  // Passo 9 (F2 intocada): metade destes 111 já tinha Fornecedor Um e
  // passa a Fornecedor Três, a outra metade não tinha nenhum e passa a
  // tê-lo — e em F2 (Passo 9) TODOS os 111 têm de continuar exactamente
  // como estavam.
  const alvo = META; // todos os 111 produtos de F1
  await page.getByRole("button", { name: new RegExp(`Seleccionar todos os ${alvo.length} que correspondem ao filtro`) }).click();
  await page.waitForTimeout(400);

  await page.getByPlaceholder("Pesquisar fornecedor existente…").fill("MM E2E FORNECEDOR TRES");
  await page.getByRole("button", { name: "MM E2E Fornecedor Três" }).click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Pré-visualizar alteração" }).click();
  await page.getByText("Confirmação obrigatória").waitFor({ timeout: 10000 });
  const farmaciaFiltros = await page.locator("text=Filtros aplicados:").innerText();
  check(farmaciaFiltros.includes("MM E2E Farmácia Silveira Norte"), "Passo 8: o resumo do preview identifica a farmácia F1 escopada", farmaciaFiltros);

  await page.getByRole("button", { name: /Confirmar e aplicar a \d+ produto\(s\)/ }).click();
  await page.getByText(/Operação aplicada:/).waitFor({ timeout: 15000 });
  check(true, "Passo 8: operação de fornecedor aplicada com sucesso");

  console.log("\nPasso 9 · a OUTRA farmácia (F2) fica intocada — prova directa em Postgres");
  const { PrismaClient } = await import("../../generated/prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB }) });
  try {
    const produtoIds = alvo.map((m) => seedData.produtoIdByIndex.get(m.i)!);
    const f1Rows = await prisma.produtoFarmacia.findMany({
      where: { produtoId: { in: produtoIds }, farmaciaId: seedData.farmaciaF1Id },
      select: { fornecedorHabitualId: true },
    });
    check(f1Rows.every((r) => r.fornecedorHabitualId === seedData.fornecedorTresId), "Passo 9 (controlo): F1 foi mesmo alterada para Fornecedor Três em todos os produtos-alvo (mesmo os que não tinham fornecedor nenhum)");

    // F2 tem de continuar EXACTAMENTE como estava — metade com Fornecedor
    // Dois, metade sem nenhum — nunca uniformizada pela operação de F1.
    const f2RowsPorProduto = await prisma.produtoFarmacia.findMany({
      where: { produtoId: { in: produtoIds }, farmaciaId: seedData.farmaciaF2Id },
      select: { produtoId: true, fornecedorHabitualId: true },
    });
    const idParaIndex = new Map(META.map((m) => [seedData.produtoIdByIndex.get(m.i)!, m]));
    const todasIntocadas = f2RowsPorProduto.every((r) => {
      const meta = idParaIndex.get(r.produtoId)!;
      const esperado = meta.f2TemFornecedor ? seedData.fornecedorDoisId : null;
      return r.fornecedorHabitualId === esperado;
    });
    const aindaComDois = f2RowsPorProduto.filter((r) => r.fornecedorHabitualId === seedData.fornecedorDoisId).length;
    check(
      todasIntocadas,
      "Passo 9: F2 (farmácia NÃO escopada) continua EXACTAMENTE como estava em TODOS os 111 produtos — nada foi tocado fora do escopo",
      `aindaComFornecedorDois=${aindaComDois}/${f2RowsPorProduto.length}`
    );
  } finally {
    await prisma.$disconnect();
  }
}

// ─── Passo 10/11/12 — histórico, reversão, confirmação ─────────────────────
async function passo10a12(page: Page, seedData: SeedResult, produtoExcluidoDesignacao: string) {
  console.log("\nPasso 10 · histórico mostra as duas operações (fabricante + fornecedor)");
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Histórico de operações" }).waitFor({ timeout: 10000 });

  const linhaFabricante = page.locator("tbody tr").filter({ hasText: "FABRICANTE" }).first();
  const linhaFornecedor = page.locator("tbody tr").filter({ hasText: "FORNECEDOR" }).first();
  check(await linhaFabricante.isVisible(), "Passo 10: existe uma linha de histórico com tipo FABRICANTE");
  check(await linhaFornecedor.isVisible(), "Passo 10: existe uma linha de histórico com tipo FORNECEDOR");

  const totalCorrespondentes = META.filter((m) => m.tipoArtigo === "MEDICAMENTO").length;
  const textoFabricante = await linhaFabricante.innerText();
  check(textoFabricante.includes(`${totalCorrespondentes - 1}`), "Passo 10: a linha FABRICANTE mostra a contagem real de alterados", textoFabricante);

  const alvoFornecedor = META.length; // Passo 8 aplicou a TODO o catálogo de F1 (ver nota nesse passo)
  const textoFornecedor = await linhaFornecedor.innerText();
  check(textoFornecedor.includes(String(alvoFornecedor)), "Passo 10: a linha FORNECEDOR mostra a contagem real de alterados", textoFornecedor);
  check(textoFornecedor.includes("MM E2E Farmácia Silveira Norte"), "Passo 10: a linha FORNECEDOR identifica a farmácia F1");

  console.log("\nPasso 11 · reverter a operação de FABRICANTE");
  const { PrismaClient } = await import("../../generated/prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB }) });
  try {
    const opFabricante = await prisma.catalogoManutencaoOperacao.findFirst({
      where: { tipo: "FABRICANTE", origem: "MANUTENCAO_MASSA" },
      orderBy: { dataCriacao: "desc" },
      select: { id: true },
    });
    check(!!opFabricante, "Passo 11 (fixture): a operação FABRICANTE original existe na BD");
    if (!opFabricante) throw new Error("Passo 11: operação FABRICANTE original não encontrada — impossível continuar.");
    const nOperacoesAntes = await prisma.catalogoManutencaoOperacao.count();

    await linhaFabricante.getByRole("button", { name: "Reverter" }).click();
    await page.waitForTimeout(1500);

    console.log("\nPasso 12 · confirmação da reversão");
    const nOperacoesDepois = await prisma.catalogoManutencaoOperacao.count();
    check(nOperacoesDepois === nOperacoesAntes + 1, "Passo 12: nasceu exactamente UMA nova operação (a reversão) — a original nunca é apagada");

    const reversao = await prisma.catalogoManutencaoOperacao.findFirst({
      where: { origem: "REVERSAO", operacaoOrigemId: opFabricante!.id },
      select: { id: true, quantidadeAlterada: true },
    });
    check(!!reversao, "Passo 12: existe uma nova CatalogoManutencaoOperacao com origem=REVERSAO a referenciar a original");

    const original = await prisma.catalogoManutencaoOperacao.findUnique({ where: { id: opFabricante!.id } });
    check(!!original, "Passo 12: a operação ORIGINAL continua a existir (nunca apagada)");

    // Produtos revertidos: voltam ao valor ANTERIOR (LAB ALFA/BETA/null,
    // conforme a semeadura original). Tem de ser um produto que REALMENTE
    // fez parte do lote aplicado (nunca o excluído manualmente no Passo 4 —
    // esse nunca mudou, e "continua null depois de reverter" não provaria
    // nada sobre a reversão em si).
    const revertido = META.find((m) => m.tipoArtigo === "MEDICAMENTO" && m.designacao !== produtoExcluidoDesignacao)!;
    const produtoId = seedData.produtoIdByIndex.get(revertido.i)!;
    const p = await prisma.produto.findUnique({ where: { id: produtoId }, select: { fabricanteId: true } });
    const fabricanteEsperado = revertido.fabricante === "ALFA" ? seedData.labAlfaId : revertido.fabricante === "BETA" ? seedData.labBetaId : null;
    check(p?.fabricanteId === fabricanteEsperado, "Passo 12: o produto revertido voltou ao seu valor ORIGINAL de antes da manutenção em massa", JSON.stringify({ obtido: p?.fabricanteId, esperado: fabricanteEsperado }));
  } finally {
    await prisma.$disconnect();
  }

  await page.reload({ waitUntil: "networkidle" });
  const linhaFabricanteDepois = page.locator("tbody tr").filter({ hasText: "FABRICANTE" }).filter({ hasText: "MANUTENCAO_MASSA" });
  check(await linhaFabricanteDepois.getByText("Já revertida").isVisible(), "Passo 12: depois de recarregar, a operação original mostra \"Já revertida\"");
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
      });
      check(!rAplicar.ok && rAplicar.error === "Funcionalidade não disponível para este tenant.", `Passo 14 (${tenant}): aplicarManutencaoFabricanteAction (escrita) rejeitada ANTES de tocar em Prisma`, JSON.stringify(rAplicar));

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
    await passo2(page, seedData);
    await passo3(page);
    const { produtoAExcluirDesignacao } = await passo4(page);
    const totalCorrespondentes = await passo5(page, seedData);
    await passo6e7(page, seedData, produtoAExcluirDesignacao, totalCorrespondentes);
    await passo8e9(page, seedData);
    await passo10a12(page, seedData, produtoAExcluirDesignacao);
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
