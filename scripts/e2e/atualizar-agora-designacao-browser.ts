/**
 * scripts/e2e/atualizar-agora-designacao-browser.ts
 *
 * Ensaio INTEGRADO do botão real «Sincronizar agora» (Atualizar agora) com a
 * autoridade da designação da Silveirense — browser real (Chromium) contra o
 * servidor de produção real (`next build` + standalone), control plane real,
 * PostgreSQL descartável e HTTP real nos endpoints do agent
 * (`/api/outbox/v1/sync-requests/*`, `/api/ingest/v1/bootstrap/products*`).
 * Ver `_ambiente-silveira.ts`.
 *
 * O único elemento simulado é o ERP SQL Server da farmácia: o "agent" deste
 * ensaio faz exactamente o que `agent/src/commands/sync-now.ts` faz (reclama
 * o pedido, envia os produtos do dia, pergunta se é autoritativa, envia o
 * catálogo inteiro ao passo leve, faz o ack com os contadores) mas lendo as
 * linhas de uma lista em vez de `dbo.Stocks`. NADA do lado do SaaS é simulado:
 * o clique no botão, o SyncRequest, a claim, a regra da designação, o ack e o
 * texto que o botão mostra são o código real.
 *
 *   docker run -d --name spharm-wt-pg -e POSTGRES_PASSWORD=test -p 55490:5432 postgres:16-alpine
 *   SERVER_ACTIONS_ALLOWED_ORIGINS="localhost:3100,127.0.0.1:3100,*.localhost:3100" npx next build
 *   npx tsx scripts/e2e/atualizar-agora-designacao-browser.ts
 */
import Module from "node:module";
import { chromium, type Page } from "playwright";
import { criarAmbiente, baseFor, CODIGO_ANF_SILVEIRENSE, type Ambiente } from "./_ambiente-silveira";

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

const CNPS = [8_600_001, 8_600_002, 8_600_003, 8_600_004];
const NOME_SEGURADO = (n: number) => `seg antigo ${n}`;
const NOME_SILV = (n: number) => `Nome Silveirense ${n}`;

type Linha = { cnp: number; designacao: string | null };
const lista = (nomes: (n: number) => string): Linha[] => CNPS.map((cnp, i) => ({ cnp, designacao: nomes(i + 1) }));

async function main() {
  const amb: Ambiente = await criarAmbiente("atualizar", { SILVEIRA_DESIGNACAO_AUTORITATIVA_CODIGO_ANF: CODIGO_ANF_SILVEIRENSE });
  const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP silveira.localhost [::1]"] });
  try {
    const user = await amb.prisma.utilizador.create({ data: { email: "e2e-atualizar@spharm.test", nome: "E2E Atualizar", perfil: "ADMINISTRADOR" } });
    const silv = await amb.prisma.farmacia.create({ data: { nome: "E2E Farmácia Silveirense", codigoANF: CODIGO_ANF_SILVEIRENSE } });
    const seg = await amb.prisma.farmacia.create({ data: { nome: "E2E Farmácia Segurado", codigoANF: "ANF-SEG-E2E" } });
    const desig = async (cnp: number) => (await amb.prisma.produto.findUnique({ where: { cnp }, select: { designacao: true } }))?.designacao ?? null;

    // ── "Agent" simulado: o mesmo protocolo de sync-now.ts, ERP = lista ───
    async function postProdutos(farmaciaId: string, linhas: Linha[]) {
      return amb.agente("POST", "/api/ingest/v1/bootstrap/products", { farmaciaId, items: linhas.map((l) => ({ ...l, externalProductId: null })) });
    }
    async function agenteSyncNow(farmaciaId: string, erpHoje: Linha[], erpCatalogo: Linha[]) {
      // 1. long-poll até reclamar o pedido criado pelo clique
      let reclamado: { syncRequestId: string } | null = null;
      for (let i = 0; i < 30 && !reclamado; i++) {
        const r = await amb.agente("GET", `/api/outbox/v1/sync-requests/pending?farmaciaId=${farmaciaId}&waitSeconds=2`);
        if (r.json?.count > 0) reclamado = r.json.syncRequests[0];
      }
      if (!reclamado) throw new Error("o agent nunca reclamou o pedido");
      // 2. produtos de hoje (runPipelineForDay scope products-stock)
      const p = await postProdutos(farmaciaId, erpHoje);
      let alteradas = p.json?.designacoes?.modo === "AUTORITATIVA" ? p.json.designacoes.alteradas : undefined;
      let verificadas = p.json?.designacoes?.modo === "AUTORITATIVA" ? p.json.designacoes.verificadas : undefined;
      // 3. passo de designações (só se o SaaS disser que é autoritativa)
      const est = await amb.agente("GET", `/api/ingest/v1/bootstrap/products/designacoes?farmaciaId=${farmaciaId}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- resposta JSON do endpoint
      let passoLeve: any = null;
      if (est.json?.autoritativa) {
        const r = await amb.agente("POST", "/api/ingest/v1/bootstrap/products/designacoes", { farmaciaId, items: erpCatalogo });
        passoLeve = r;
        alteradas = (alteradas ?? 0) + r.json.alteradas;
        verificadas = (verificadas ?? 0) + r.json.verificadas;
      }
      // 4. ack
      const resultado = {
        stockAtualizado: 0,
        produtosAtualizados: erpHoje.length,
        fabricantesAlterados: 0,
        ...(alteradas !== undefined ? { designacoesAlteradas: alteradas } : {}),
        ...(verificadas !== undefined ? { designacoesVerificadas: verificadas } : {}),
      };
      const ack = await amb.agente("POST", `/api/outbox/v1/sync-requests/${reclamado.syncRequestId}/ack`, { resultado });
      return { produtos: p, estado: est, passoLeve, ack, resultado };
    }

    // ── Estado inicial: a Segurado já criou os 4 produtos ────────────────
    console.log("\nPasso 0 · estado inicial — a Segurado cria os produtos (modo SO_CRIACAO)");
    const inicial = await postProdutos(seg.id, lista(NOME_SEGURADO));
    check(inicial.status === 200 && inicial.json.designacoes?.modo === "SO_CRIACAO" && inicial.json.designacoes.criadas === 4, "a Segurado criou 4 produtos com a sua designação (criadas=4)", JSON.stringify(inicial.json));
    check((await Promise.all(CNPS.map(desig))).every((d, i) => d === NOME_SEGURADO(i + 1)), "…a base tem as designações da Segurado");

    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: "session", value: await amb.tokenSessao(user.id, user.email), url: baseFor("silveira") }]);
    const page: Page = await ctx.newPage();
    await page.setViewportSize({ width: 1500, height: 1000 });

    async function escolherFarmacia(nome: string) {
      const sel = page.locator("select", { has: page.locator("option", { hasText: nome }) }).first();
      await sel.selectOption({ label: nome });
    }
    async function clicarSincronizar() {
      await page.getByRole("button", { name: /^Sincronizar agora$/ }).click();
      await page.getByText(/A solicitar actualização…|Farmácia a sincronizar…/).first().waitFor({ timeout: 15_000 });
    }

    // ═══ Silveirense: clique real → agent → designações → UI ═════════════
    console.log("\nPasso 1 · «Sincronizar agora» na Silveirense (botão real)");
    await page.goto(`${baseFor("silveira")}/stock`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /^Sincronizar agora$/ }).waitFor({ timeout: 30_000 });
    await escolherFarmacia("E2E Farmácia Silveirense");
    await clicarSincronizar();
    const pedido = await amb.prisma.syncRequest.findFirst({ where: { farmaciaId: silv.id }, orderBy: { requestedAt: "desc" } });
    check(!!pedido && pedido.estado === "PENDENTE", "o clique criou um SyncRequest PENDENTE para a Silveirense");

    // Hoje o ERP só reporta o produto 1 como movimentado; o catálogo inteiro tem os 4 + um CNP desconhecido + um vazio.
    const erpHoje: Linha[] = [{ cnp: CNPS[0], designacao: NOME_SILV(1) }];
    const erpCatalogo: Linha[] = [...lista(NOME_SILV), { cnp: 8_699_999, designacao: "NÃO EXISTE NA BASE" }, { cnp: CNPS[0], designacao: "   " }];
    const r1 = await agenteSyncNow(silv.id, erpHoje, erpCatalogo);
    check(r1.produtos.status === 200 && r1.produtos.json.designacoes?.modo === "AUTORITATIVA" && r1.produtos.json.designacoes.alteradas === 1,
      "o pipeline de produtos do dia alterou 1 designação (a do produto movimentado)", JSON.stringify(r1.produtos.json?.designacoes));
    check(r1.estado.json?.autoritativa === true && r1.estado.json?.aplica === true, "o SaaS respondeu que a Silveirense é a autoritativa");
    check(r1.passoLeve?.json?.alteradas === 3 && r1.passoLeve.json.jaIguais === 1 && r1.passoLeve.json.semProduto === 1 && r1.passoLeve.json.ignoradasVazias === 1,
      "o passo leve comparou o catálogo INTEIRO: alterou 3 (produtos que o ERP não marcou como alterados), 1 já igual, 1 sem produto, 1 vazia ignorada", JSON.stringify(r1.passoLeve?.json));
    check(r1.ack.status === 200, "ack aceite", JSON.stringify(r1.ack.json));
    check((await Promise.all(CNPS.map(desig))).every((d, i) => d === NOME_SILV(i + 1)), "as 4 designações na base são as da Silveirense");
    check((await amb.prisma.produto.findUnique({ where: { cnp: 8_699_999 } })) === null, "o passo leve não criou o CNP desconhecido");
    await page.getByText(/Designações alteradas: 4/).waitFor({ timeout: 20_000 }).then(
      () => check(true, "o botão real mostra «Designações alteradas: 4» (1 do dia + 3 do catálogo inteiro)"),
      async () => check(false, "o botão real mostra «Designações alteradas: 4»", (await page.locator("body").innerText()).slice(0, 600)),
    );
    const pr = await amb.prisma.pipelineRun.findFirst({ where: { farmaciaId: silv.id, kind: "sync-now" }, orderBy: { startedAt: "desc" } });
    check(!!pr && (pr.details as { designacoesAlteradas?: number }).designacoesAlteradas === 4, "o registo da execução (PipelineRun sync-now) guarda designacoesAlteradas=4", JSON.stringify(pr?.details));

    // ═══ Segurado não reverte ═════════════════════════════════════════════
    console.log("\nPasso 2 · a Segurado sincroniza depois — não reverte");
    const seg2 = await postProdutos(seg.id, lista(NOME_SEGURADO));
    check(seg2.json.designacoes?.modo === "SO_CRIACAO" && seg2.json.designacoes.ignoradasOrigemNaoAutoritativa === 4 && seg2.json.designacoes.alteradas === 0,
      "a Segurado: 4 designações ignoradas por origem não autoritativa, 0 alteradas", JSON.stringify(seg2.json.designacoes));
    check((await Promise.all(CNPS.map(desig))).every((d, i) => d === NOME_SILV(i + 1)), "…e as designações continuam as da Silveirense");
    const intruso = await amb.agente("POST", "/api/ingest/v1/bootstrap/products/designacoes", { farmaciaId: seg.id, items: lista(NOME_SEGURADO) });
    check(intruso.status === 409 && intruso.json.error === "designacao_nao_autoritativa", "o passo leve recusa (409) a Segurado — nada escrito");
    check((await Promise.all(CNPS.map(desig))).every((d, i) => d === NOME_SILV(i + 1)), "…as designações continuam intactas");

    // ═══ Idempotência: segundo clique na Silveirense ═════════════════════
    console.log("\nPasso 3 · segundo «Sincronizar agora» na Silveirense — idempotente");
    await page.reload({ waitUntil: "networkidle" });
    await escolherFarmacia("E2E Farmácia Silveirense");
    await clicarSincronizar();
    const r3 = await agenteSyncNow(silv.id, erpHoje, erpCatalogo);
    check(r3.resultado.designacoesAlteradas === 0 && r3.passoLeve.json.alteradas === 0 && r3.passoLeve.json.jaIguais === 4, "nada a alterar: designacoesAlteradas=0, jaIguais=4");
    await page.getByText(/Designações alteradas: 0/).waitFor({ timeout: 20_000 }).then(
      () => check(true, "o botão mostra «Designações alteradas: 0»"),
      async () => check(false, "o botão mostra «Designações alteradas: 0»", (await page.locator("body").innerText()).slice(0, 600)),
    );

    // ═══ Segurado: o botão não mostra contador de designações ═════════════
    console.log("\nPasso 4 · «Sincronizar agora» na Segurado — sem contador de designações");
    await page.reload({ waitUntil: "networkidle" });
    await escolherFarmacia("E2E Farmácia Segurado");
    await clicarSincronizar();
    const r4 = await agenteSyncNow(seg.id, lista(NOME_SEGURADO), lista(NOME_SEGURADO));
    check(r4.estado.json?.autoritativa === false && r4.passoLeve === null, "a Segurado não é autoritativa: o agent não envia o passo de designações");
    check(!("designacoesAlteradas" in r4.resultado), "o ack da Segurado não traz designacoesAlteradas");
    await page.getByText(/Atualizado agora/).first().waitFor({ timeout: 20_000 });
    const texto = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    check(/Stock actualizado: 0/.test(texto) && !/Designações alteradas/.test(texto), "o botão mostra o resultado da Segurado SEM «Designações alteradas»");
    check((await Promise.all(CNPS.map(desig))).every((d, i) => d === NOME_SILV(i + 1)), "…e a Segurado voltou a não reverter nada");

    // ═══ Configuração inválida ═══════════════════════════════════════════
    console.log("\nPasso 5 · estado reportado pelo SaaS");
    const estS = await amb.agente("GET", `/api/ingest/v1/bootstrap/products/designacoes?farmaciaId=${silv.id}`);
    check(estS.json.modo === "AUTORITATIVA" && estS.json.erroConfiguracao === undefined, "GET estado (Silveirense): AUTORITATIVA, sem erro de configuração");
    const estG = await amb.agente("GET", `/api/ingest/v1/bootstrap/products/designacoes?farmaciaId=${seg.id}`);
    check(estG.json.modo === "SO_CRIACAO" && estG.json.autoritativa === false, "GET estado (Segurado): SO_CRIACAO");
    const logs = amb.logs();
    check(!/Nome Silveirense|seg antigo/.test(logs), "os logs do servidor não contêm designações nem payloads");
    check(/\[bootstrap\/products\] designacao /.test(logs), "os logs do servidor têm as contagens da designação");
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
