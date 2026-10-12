/**
 * scripts/e2e/pesquisa-vendas-browser.ts
 *
 * Ensaio de browser REAL (Chromium/Playwright) do defeito da pesquisa de
 * produtos no Relatório de Vendas, contra o servidor de produção real
 * (`next build` + standalone) e PostgreSQL descartável — ver
 * `_ambiente-silveira.ts`:
 *
 *   1. abrir o Relatório de Vendas;
 *   2. pesquisar `parace` → há resultados;
 *   3. pesquisar `parace ciclum` → `PARACETAMOL CICLUM 650 MG 20 COMP.`
 *      continua presente (antes: zero resultados);
 *   4. a ordem inversa, caixa/acentos/espaços e um termo a mais também se
 *      comportam como a regra manda.
 *
 *   docker run -d --name spharm-wt-pg -e POSTGRES_PASSWORD=test -p 55490:5432 postgres:16-alpine
 *   SERVER_ACTIONS_ALLOWED_ORIGINS="localhost:3100,127.0.0.1:3100,*.localhost:3100" npx next build
 *   npx tsx scripts/e2e/pesquisa-vendas-browser.ts
 */
import Module from "node:module";
import { chromium, type Page } from "playwright";
import { criarAmbiente, baseFor, CODIGO_ANF_SILVEIRENSE } from "./_ambiente-silveira";

const M = Module as unknown as { _resolveFilename: (r: string, ...a: unknown[]) => string };
const resolverOriginal = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "server-only" ? __filename : resolverOriginal.call(this, request, ...rest);
};

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string, detalhe?: string) {
  if (cond) { passed++; console.log(`  [OK]    ${msg}`); }
  else { failed++; console.log(`  [FALHA] ${msg}${detalhe ? `\n            ${detalhe}` : ""}`); }
}

const ALVO = "PARACETAMOL CICLUM 650 MG 20 COMP.";
const OUTRO = "PARACETAMOL GENERIS 500 MG 20 COMP.";
const IBU = "IBUPROFENO CICLUM 400 MG 20 COMP.";

const hoje = new Date();
const mesAtras = (k: number) => new Date(hoje.getFullYear(), hoje.getMonth() - k, 1);
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const JANELA = { from: iso(mesAtras(2)), to: iso(new Date(mesAtras(1).getFullYear(), mesAtras(1).getMonth() + 1, 0)) };

async function main() {
  const amb = await criarAmbiente("pesquisa", { SILVEIRA_DESIGNACAO_AUTORITATIVA_CODIGO_ANF: CODIGO_ANF_SILVEIRENSE });
  const browser = await chromium.launch({
    args: ["--host-resolver-rules=MAP silveira.localhost [::1]"],
  });
  try {
    // ── Dados: três artigos com vendas nos dois últimos meses ───────────
    const user = await amb.prisma.utilizador.create({ data: { email: "e2e-pesquisa@spharm.test", nome: "E2E Pesquisa", perfil: "ADMINISTRADOR" } });
    const f = await amb.prisma.farmacia.create({ data: { nome: "E2E Farmácia Silveirense", codigoANF: CODIGO_ANF_SILVEIRENSE } });
    const artigos: Array<[number, string]> = [[8_500_001, ALVO], [8_500_002, OUTRO], [8_500_003, IBU]];
    for (const [cnp, designacao] of artigos) {
      const p = await amb.prisma.produto.create({ data: { cnp, designacao, tipoArtigo: "MEDICAMENTO", estado: "VALIDADO" } });
      await amb.prisma.produtoFarmacia.create({ data: { produtoId: p.id, farmaciaId: f.id, pvp: 5, stockAtual: 4 } });
      for (const m of [mesAtras(2), mesAtras(1)]) {
        await amb.prisma.vendaMensal.create({
          data: { farmaciaId: f.id, produtoId: p.id, ano: m.getFullYear(), mes: m.getMonth() + 1, quantidade: 6, valorTotal: 30, naturezaVenda: "NORMAL" },
        });
      }
    }

    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: "session", value: await amb.tokenSessao(user.id, user.email), url: baseFor("silveira") }]);
    const page: Page = await ctx.newPage();
    await page.setViewportSize({ width: 1700, height: 1100 });

    console.log("\nPasso 1 · abrir o Relatório de Vendas");
    await page.goto(`${baseFor("silveira")}/vendas`, { waitUntil: "networkidle" });
    const campo = page.getByPlaceholder("Pesquisar por CNP ou descrição...");
    await campo.waitFor();
    check(true, "o Relatório de Vendas abriu com o campo de pesquisa de produto");
    await page.getByLabel("Data início").fill(JANELA.from);
    await page.getByLabel("Data fim").fill(JANELA.to);

    async function pesquisar(texto: string): Promise<string[]> {
      await campo.fill(texto);
      const botao = page.getByRole("button", { name: /^(Gerar|Atualizar)$/ });
      await botao.click();
      await page.getByRole("button", { name: /^Atualizar$/ }).waitFor({ timeout: 30_000 });
      await page.waitForLoadState("networkidle");
      const corpo = (await page.locator("body").innerText()).replace(/\s+/g, " ");
      return [ALVO, OUTRO, IBU].filter((d) => corpo.includes(d));
    }

    console.log("\nPasso 2 · pesquisar «parace»");
    const r1 = await pesquisar("parace");
    check(r1.includes(ALVO) && r1.includes(OUTRO) && !r1.includes(IBU), "«parace» encontra os dois paracetamóis e não o ibuprofeno", JSON.stringify(r1));

    console.log("\nPasso 3 · pesquisar «parace ciclum» — o defeito");
    const r2 = await pesquisar("parace ciclum");
    check(r2.length === 1 && r2[0] === ALVO, `«parace ciclum» continua a mostrar ${ALVO} (e só ele)`, JSON.stringify(r2));

    console.log("\nPasso 4 · variações da mesma pesquisa");
    const r3 = await pesquisar("ciclum parace");
    check(r3.length === 1 && r3[0] === ALVO, "«ciclum parace» (ordem invertida) encontra o mesmo artigo", JSON.stringify(r3));
    const r4 = await pesquisar("PARÁCE   cíclum");
    check(r4.length === 1 && r4[0] === ALVO, "«PARÁCE   cíclum» (caixa, acentos, espaços) encontra o mesmo artigo", JSON.stringify(r4));
    const r5 = await pesquisar("ciclum");
    check(r5.length === 2 && r5.includes(ALVO) && r5.includes(IBU), "«ciclum» sozinho: os dois artigos Ciclum", JSON.stringify(r5));
    const r6 = await pesquisar("parace ciclum inexistente");
    check(r6.length === 0, "todos os termos são obrigatórios: um termo inexistente ⇒ nenhum resultado", JSON.stringify(r6));
    const r7 = await pesquisar("8500001");
    check(r7.length === 1 && r7[0] === ALVO, "pesquisar pelo CNP continua a funcionar", JSON.stringify(r7));
    const r8 = await pesquisar("8500 ciclum");
    check(r8.length === 2 && r8.includes(ALVO) && r8.includes(IBU), "CNP parcial + termo de designação combinam por AND", JSON.stringify(r8));
    await ctx.close();
  } finally {
    await browser.close();
    await amb.parar();
  }
  console.log(`\n${failed === 0 ? "PASSOU" : "FALHOU"} — ${passed} OK, ${failed} falhas\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
