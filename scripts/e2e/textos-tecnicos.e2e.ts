/**
 * scripts/e2e/textos-tecnicos.e2e.ts
 *
 * Browser REAL (Chromium) contra o build de PRODUÇÃO, control plane + PostgreSQL descartáveis (dados sintéticos).
 * Para os DOIS tenants (silveira e garantia) e os QUATRO perfis (ADMINISTRADOR, GESTOR_GRUPO, GESTOR_FARMACIA, OPERADOR):
 *   A · nenhum ecrã com informação técnica visível (agent, outbox, heartbeat, StagingCompra…, pipeline, read-model, SQL, BD…);
 *   B · o menu não tem «Integração»; acesso direto por URL a /configuracoes/integracao e /admin/integracao não mostra nada técnico;
 *   C · «Sincronizar agora» continua disponível a quem tinha acesso (texto simples);
 *   D · confirmações do detalhe da encomenda sem «agent».
 * (A restrição das actions/endpoints e a ausência de dados técnicos no HTML/payload estão provadas em `integracao-restrita.e2e.ts`.)
 *
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:55491/postgres npx tsx scripts/e2e/textos-tecnicos.e2e.ts
 */
import { chromium, type BrowserContext, type Page } from "playwright";
import { SignJWT } from "jose";
import { baseFor, criarAmbiente, SECRET } from "./_ambiente-silveira";
import { semearMargens } from "./_margens-comum";

let ok = 0;
let ko = 0;
const check = (c: boolean, label: string, d?: string) => {
  if (c) { ok++; console.log(`  [OK]    ${label}`); } else { ko++; console.log(`  [FALHA] ${label}${d ? `\n            ${d}` : ""}`); }
};
const TECNICO = /\b(agent|agente|heartbeat|outbox|ingest\w*|StagingCompra\w*|pipeline|read-?model|IPF|long-?polling|payload|endpoint|SQL)\b|\bBD\b|trigger/i;
const PERFIS = ["ADMINISTRADOR", "GESTOR_GRUPO", "GESTOR_FARMACIA", "OPERADOR"] as const;

async function texto(pg: Page, sel = "body"): Promise<string> {
  return (await pg.locator(sel).first().innerText().catch(() => "")).replace(/[ \t]+/g, " ");
}

async function correr(slug: string) {
  console.log(`\n══ tenant ${slug}`);
  const amb = await criarAmbiente(`tt_${slug}`, { E2E_TENANT_SLUG: slug });
  const browser = await chromium.launch();
  try {
    const seed = await semearMargens(amb);
    const farm = seed.farmacias.alfa;
    const lista = await amb.prisma.listaEncomenda.findFirst({ orderBy: { dataCriacao: "desc" } });
    const novoCtx = async (perfil: string): Promise<BrowserContext> => {
      const c = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const token = await new SignJWT({ sub: seed.userId, email: "e2e@spharm.test", nome: "Utilizador", perfil, farmaciaId: perfil === "GESTOR_FARMACIA" || perfil === "OPERADOR" ? farm : null, tenant: amb.slug })
        .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("8h").sign(new TextEncoder().encode(SECRET));
      await c.addCookies([{ name: "session", value: token, url: baseFor(amb.slug) }]);
      await c.addInitScript("window.__name = (f) => f;");
      return c;
    };
    const ir = async (c: BrowserContext, rota: string) => {
      const pg = await c.newPage();
      await pg.goto(`${baseFor(amb.slug)}${rota}`, { waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {});
      await pg.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
      return pg;
    };

    for (const perfil of PERFIS) {
      console.log(`\n── ${slug} · ${perfil}`);
      const c = await novoCtx(perfil);
      const pg0 = await ir(c, "/dashboard");
      const menu = await texto(pg0, "aside");
      check(!/Integra[çc][ãa]o/.test(menu), "menu sem «Integração»", menu.slice(0, 200));
      check(!TECNICO.test(await texto(pg0)), "Dashboard sem texto técnico");
      await pg0.close();

      for (const rota of ["/configuracoes/integracao", "/admin/integracao", "/admin"]) {
        const pg = await ir(c, rota);
        const t = await texto(pg);
        const caminho = new URL(pg.url()).pathname;
        check(!/Heartbeat|Outbox|versão do agent|última chamada/i.test(t) && !caminho.startsWith("/admin/integracao") && caminho !== "/configuracoes/integracao", `URL direto ${rota} → «${caminho}» sem conteúdo técnico`, t.slice(0, 160));
        await pg.close();
      }

      // Stock + «Sincronizar agora»
      let pg = await ir(c, "/stock");
      let t = await texto(pg);
      check(!TECNICO.test(t), "Stock sem texto técnico", t.match(TECNICO)?.[0]);
      const temBotao = (await pg.getByRole("button", { name: /Sincronizar agora/ }).count()) > 0;
      const devia = perfil !== "OPERADOR" && slug !== "garantia";
      check(temBotao === devia || (slug === "garantia" && !temBotao) , `«Sincronizar agora» ${devia ? "disponível" : "não aplicável"} (${temBotao ? "presente" : "ausente"})`);
      await pg.close();

      // Ficha com extrato vazio (farmácias sem movimentos)
      pg = await ir(c, "/stock/artigo/7100001");
      t = await texto(pg);
      check(!TECNICO.test(t), "Ficha do artigo e extrato sem texto técnico", t.match(TECNICO)?.[0]);
      check(/Ainda não há movimentos disponíveis/.test(t), "extrato vazio: mensagem em linguagem corrente");
      await pg.close();

      // Relatórios
      for (const [rota, botao] of [["/relatorios/margens", /^(Gerar|Atualizar)$/], ["/relatorios/inventario", /^(Gerar|Atualizar)$/], ["/vendas", /^Gerar$/], ["/devolucoes", /^(Gerar|Atualizar)$/], ["/excessos", /^(Gerar relatório|Atualizar)$/]] as const) {
        const q = await ir(c, rota);
        await q.getByRole("button", { name: botao }).first().click().catch(() => {});
        await q.waitForTimeout(3500);
        const tt = await texto(q);
        check(!TECNICO.test(tt), `${rota} sem texto técnico (antes e depois de gerar)`, tt.match(TECNICO)?.[0]);
        await q.close();
      }

      // Oportunidades e encomendas
      pg = await ir(c, "/oportunidades");
      t = await texto(pg);
      check(!TECNICO.test(t) && !/IPF/.test(t), "Oportunidades sem cartão técnico", t.match(TECNICO)?.[0]);
      await pg.close();
      if (perfil !== "OPERADOR") {
        pg = await ir(c, "/encomendas");
        check(!TECNICO.test(await texto(pg)), "lista de encomendas sem texto técnico");
        await pg.close();
        if (lista) {
          pg = await ir(c, `/encomendas/${lista.id}`);
          t = await texto(pg);
          check(!TECNICO.test(t), "detalhe da encomenda sem texto técnico", t.match(TECNICO)?.[0]);
          const mensagens: string[] = [];
          pg.on("dialog", async (d) => { mensagens.push(d.message()); await d.dismiss(); });
          for (const nome of [/Tentar novamente/, /Cancelar exportação/]) {
            const b = pg.getByRole("button", { name: nome });
            if (await b.count()) await b.first().click().catch(() => {});
          }
          await pg.waitForTimeout(500);
          check(mensagens.every((m) => !/agent|PENDENTE/i.test(m)), `confirmações da encomenda sem «agent» (${mensagens.length} vista(s))`, mensagens.join(" | "));
          await pg.close();
        }
      }
      await c.close();
    }
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
