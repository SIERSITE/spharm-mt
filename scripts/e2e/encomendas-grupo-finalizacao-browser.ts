/**
 * scripts/e2e/encomendas-grupo-finalizacao-browser.ts
 *
 * Finalização de Encomendas em modo GRUPO — browser real (Chromium) contra o
 * servidor de produção real (`next build` + standalone), control plane real e
 * PostgreSQL descartável (ver `_ambiente-silveira.ts`). Nunca contra uma base real.
 *
 *   docker run -d --name spharm-wt-pg -e POSTGRES_PASSWORD=test -p 55490:5432 postgres:16-alpine
 *   SERVER_ACTIONS_ALLOWED_ORIGINS="localhost:3100,127.0.0.1:3100,*.localhost:3100" npx next build
 *   npx tsx scripts/e2e/encomendas-grupo-finalizacao-browser.ts
 *
 * ── Porque o ensaio anterior (encomendas-finalizacao-browser.ts) passava ──
 *
 * Só exercia o caminho feliz: as duas Server Actions (plano e documentos)
 * respondiam sempre bem e depressa. O defeito de produção vive nos caminhos em
 * que uma delas FALHA, REJEITA ou DEMORA — rejeição de rede/5xx da acção de
 * documentos (o overlay «A preparar os documentos…» ficava para sempre por
 * cima do ecrã), erro do plano mostrado num `flash` ATRÁS do modal, resposta
 * perdida. Este ensaio injecta exactamente essas condições (interceptando o
 * pedido da Server Action no browser) e, em TODOS os casos, compara as
 * contagens da base — provar que o botão volta a funcionar não chega: é
 * preciso provar persistência, documentos e ausência de duplicados.
 */
import Module from "node:module";
import { chromium, type Page } from "playwright";
import { criarAmbiente, type Ambiente } from "./_ambiente-silveira";
import { abrirContexto, abrirModalEEscolher, armar, contagens, gerarPropostaGrupo, limparFinalizacoes, semear, type Contagens } from "./_grupo-comum";

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
const eq = (a: Contagens, b: Contagens) => JSON.stringify(a) === JSON.stringify(b);

async function esperarResultado(page: Page, ms = 20000): Promise<boolean> {
  return page.getByText("Encomenda finalizada").waitFor({ timeout: ms }).then(() => true, () => false);
}
async function modalAberto(page: Page): Promise<boolean> {
  return (await page.getByText("Como pretende gerar a encomenda?").count()) > 0 || (await page.getByRole("heading", { name: "Finalizar encomenda" }).count()) > 0;
}
async function overlayDocs(page: Page): Promise<boolean> {
  return (await page.getByText("A preparar os documentos…").count()) > 0;
}
async function confirmar(page: Page) {
  await page.getByRole("button", { name: /Confirmar e finalizar|Tentar novamente/ }).click();
}

// ─── Cenários ───────────────────────────────────────────────────────────────

async function main() {
  const amb: Ambiente = await criarAmbiente("grupo");
  const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP silveira.localhost [::1]"] });
  try {
    const seed = await semear(amb);
    const ctx = await abrirContexto(amb, browser, seed);
    // Referência de UMA finalização completa (3 encomendas, 2 transferências).
    let referencia: Contagens;
    {
      await limparFinalizacoes(amb);
      const page = await ctx.newPage();
      await page.setViewportSize({ width: 1600, height: 900 });
      await gerarPropostaGrupo(page);
      await abrirModalEEscolher(page, "separada");
      await confirmar(page);
      await esperarResultado(page);
      referencia = await contagens(amb);
      await page.close();
    }
    console.log("referência (uma finalização):", JSON.stringify(referencia));

    // ── 1. Encomenda única do Grupo — o cenário observado em produção ────
    console.log("\nCenário 1 · «Encomenda única do Grupo» (3 farmácias, 3 encomendas, 2 transferências)");
    {
      await limparFinalizacoes(amb);
      const page = await ctx.newPage();
      await page.setViewportSize({ width: 1600, height: 900 });
      await gerarPropostaGrupo(page);
      await abrirModalEEscolher(page, "consolidada");
      const t0 = Date.now();
      await confirmar(page);
      const ok = await esperarResultado(page, 20000);
      check(ok, `o painel de documentos aparece (em ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      check(!(await modalAberto(page)) && !(await overlayDocs(page)), "o modal desapareceu e não há overlay a bloquear o ecrã");
      const c = await contagens(amb);
      check(eq(c, referencia), `encomendas, linhas, transferências e outbox criadas UMA vez: ${JSON.stringify(c)}`);
      check((await page.getByText("Transferências geradas").count()) > 0 && (await page.getByText("Encomendas finalizadas").count()) > 0, "as transferências continuam visíveis (não escondidas)");
      // título do documento escolhido + conteúdo agregado
      let corpoPdf = null as { title?: string; rows?: Array<Record<string, unknown>> } | null;
      await page.route("**/api/reports/pdf", async (route) => {
        corpoPdf = route.request().postDataJSON();
        await route.abort();
      });
      await page.locator("section", { has: page.getByText("Encomendas finalizadas") }).getByRole("button", { name: "PDF" }).first().click();
      await page.waitForTimeout(600);
      check((corpoPdf as { title?: string } | null)?.title === "Encomenda Consolidada do Grupo", `o documento consolidado é o que foi escolhido (título: ${(corpoPdf as { title?: string } | null)?.title})`);
      const rowsPdf = ((corpoPdf as { rows?: Array<Record<string, unknown>> } | null)?.rows ?? []).filter((r) => r["__rowKind"] !== "subtotal");
      const somaPdf = rowsPdf.reduce((s, r) => s + Number(r["quantidade"] ?? 0), 0);
      const somaBd = Number((await amb.prisma.$queryRaw<Array<{ s: unknown }>>`SELECT COALESCE(SUM("quantidadeAjustada"),0) AS s FROM "LinhaEncomenda"`)[0].s);
      check(rowsPdf.length === referencia.linhaEncomenda && somaPdf === somaBd, `o consolidado traz TODAS as linhas (${rowsPdf.length}) e a soma exacta (${somaPdf} = ${somaBd})`);
      const farmaciasPdf = new Set(rowsPdf.map((r) => String(r["farmacia"])));
      check(farmaciasPdf.size === 3, `…de todas as farmácias (${[...farmaciasPdf].join(", ")})`);
      const listas = await amb.prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(DISTINCT "farmaciaId") AS n FROM "ListaEncomenda"`;
      check(Number(listas[0].n) === 3 && c.listaEncomenda === 3, "a base mantém UMA ListaEncomenda por farmácia (a consolidação é só apresentação)");
      await page.close();
    }

    // ── 1b. multi-fornecedor ─────────────────────────────────────────────
    console.log("\nCenário 1b · «Encomenda única» com vários fornecedores por farmácia");
    {
      await semear(amb, { multiFornecedor: true });
      await limparFinalizacoes(amb);
      const page = await ctx.newPage();
      await page.setViewportSize({ width: 1600, height: 900 });
      await gerarPropostaGrupo(page);
      await abrirModalEEscolher(page, "consolidada");
      await confirmar(page);
      check(await esperarResultado(page), "o painel de documentos aparece");
      const c = await contagens(amb);
      // 3 rascunhos transitórios (um por farmácia, divididos) + 6 documentos por fornecedor (os que têm outbox).
      check(c.listaEncomenda === 9 && c.orderOutbox === 6 && c.transferencia === 2 && c.linhaTransferencia === 4, `3 lotes divididos em 6 encomendas por fornecedor (cada uma com a sua outbox) + 2 transferências: ${JSON.stringify(c)}`);
      const mistura = await amb.prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*) AS n FROM (
          SELECT l."listaEncomendaId" FROM "LinhaEncomenda" l JOIN "OrderOutbox" o ON o."listaEncomendaId" = l."listaEncomendaId"
          GROUP BY l."listaEncomendaId" HAVING count(DISTINCT l."fornecedorSugeridoId") > 1) x`;
      check(Number(mistura[0].n) === 0, "cada encomenda exportável tem um único fornecedor (nada misturado)");
      const exportaveis = await amb.prisma.$queryRaw<Array<{ linhas: bigint; soma: unknown }>>`
        SELECT count(*) AS linhas, COALESCE(SUM(l."quantidadeAjustada"),0) AS soma
        FROM "LinhaEncomenda" l JOIN "OrderOutbox" o ON o."listaEncomendaId" = l."listaEncomendaId"`;
      let corpoPdf = null as { rows?: Array<Record<string, unknown>> } | null;
      await page.route("**/api/reports/pdf", async (route) => { corpoPdf = route.request().postDataJSON(); await route.abort(); });
      await page.locator("section", { has: page.getByText("Encomendas finalizadas") }).getByRole("button", { name: "PDF" }).first().click();
      await page.waitForTimeout(600);
      const rows = ((corpoPdf as { rows?: Array<Record<string, unknown>> } | null)?.rows ?? []).filter((r) => r["__rowKind"] !== "subtotal");
      const soma = rows.reduce((s2, r) => s2 + Number(r["quantidade"] ?? 0), 0);
      check(rows.length === Number(exportaveis[0].linhas) && soma === Number(exportaveis[0].soma), `o consolidado não perde nem mistura linhas de nenhum fornecedor/farmácia (${rows.length} linhas, soma ${soma} = ${Number(exportaveis[0].soma)})`);
      check(new Set(rows.map((r) => String(r["farmacia"]))).size === 3, "…e inclui as 3 farmácias");
      await page.close();
      // volta ao catálogo simples para os restantes cenários
      await amb.prisma.$executeRawUnsafe(`UPDATE "ProdutoFarmacia" SET "fornecedorHabitualId" = NULL`);
    }

    // ── 2. Separada continua igual ───────────────────────────────────────
    console.log("\nCenário 2 · «Separada por farmácia» continua a funcionar");
    {
      await limparFinalizacoes(amb);
      const page = await ctx.newPage();
      await page.setViewportSize({ width: 1600, height: 900 });
      await gerarPropostaGrupo(page);
      await abrirModalEEscolher(page, "separada");
      await confirmar(page);
      check(await esperarResultado(page), "o painel de documentos aparece");
      check(eq(await contagens(amb), referencia), "contagens idênticas à referência");
      check((await page.getByRole("button", { name: "PDF" }).count()) >= 2, "PDF/Imprimir/Email por documento");
      await page.close();
    }

    // ── 3. Falha do plano (antes de chegar ao servidor) ──────────────────
    console.log("\nCenário 3 · falha de gerarPlanoGrupoAction: erro visível, modal desbloqueado, retry");
    {
      await limparFinalizacoes(amb);
      const page = await ctx.newPage();
      await page.setViewportSize({ width: 1600, height: 900 });
      await gerarPropostaGrupo(page);
      await abrirModalEEscolher(page, "consolidada");
      const ic = await armar(page, { plano: (n) => (n === 1 ? "abortar" : "continuar") });
      await confirmar(page);
      const alerta = page.getByRole("alert").filter({ hasText: /Não foi possível confirmar a finalização/ });
      check(await alerta.waitFor({ timeout: 15000 }).then(() => true, () => false), "a mensagem de erro aparece DENTRO do modal");
      const botao = page.getByRole("button", { name: "Tentar novamente" });
      check(await botao.isEnabled() && await page.getByRole("button", { name: "Cancelar" }).isEnabled(), "o modal fica desbloqueado: «Tentar novamente» e «Cancelar» activos");
      check((await contagens(amb)).listaEncomenda === 0, "nada foi criado (o pedido nem chegou ao servidor)");
      await page.getByLabel(/Separada por farmácia/).check(); // ainda é possível escolher a outra opção
      await page.getByLabel(/Encomenda única do Grupo/).check();
      await botao.click();
      check(await esperarResultado(page), "«Tentar novamente» conclui a finalização");
      check(eq(await contagens(amb), referencia) && ic.chamadasPlano === 2, `criado UMA vez (plano chamado ${ic.chamadasPlano}×)`);
      await page.close();

      // Cancelar liberta tudo
      await limparFinalizacoes(amb);
      const p2 = await ctx.newPage();
      await p2.setViewportSize({ width: 1600, height: 900 });
      await gerarPropostaGrupo(p2);
      await abrirModalEEscolher(p2, "consolidada");
      await armar(p2, { plano: () => "abortar" });
      await confirmar(p2);
      await p2.getByRole("alert").filter({ hasText: /Não foi possível confirmar a finalização/ }).waitFor({ timeout: 15000 });
      await p2.getByRole("button", { name: "Cancelar" }).click();
      check(!(await modalAberto(p2)), "«Cancelar» fecha o modal depois do erro");
      await p2.getByRole("button", { name: "Finalizar encomenda" }).click();
      check(await p2.getByRole("button", { name: "Confirmar e finalizar" }).isEnabled(), "e o modal volta a abrir limpo (sem erro, sem bloqueio)");
      await p2.close();
    }

    // ── 4. Resposta perdida: o servidor persistiu, o browser não soube ───
    console.log("\nCenário 4 · resposta do plano perdida (o servidor persistiu): o retry não duplica");
    {
      await limparFinalizacoes(amb);
      const page = await ctx.newPage();
      await page.setViewportSize({ width: 1600, height: 900 });
      await gerarPropostaGrupo(page);
      await abrirModalEEscolher(page, "consolidada");
      const ic = await armar(page, { plano: (n) => (n === 1 ? "resposta-perdida" : "continuar") });
      await confirmar(page);
      await page.getByRole("alert").filter({ hasText: /Não foi possível confirmar a finalização/ }).waitFor({ timeout: 20000 });
      const meio = await contagens(amb);
      check(eq(meio, referencia), "o servidor JÁ tinha persistido tudo (3 encomendas, 2 transferências) apesar do erro mostrado", JSON.stringify(meio));
      await page.getByRole("button", { name: "Tentar novamente" }).click();
      check(await esperarResultado(page), "o retry conclui e mostra os documentos");
      const fim = await contagens(amb);
      check(eq(fim, referencia) && ic.chamadasPlano === 2, `o retry NÃO duplicou nada (ListaEncomenda ${fim.listaEncomenda}, Transferencia ${fim.transferencia}, OrderOutbox ${fim.orderOutbox})`);
      await page.close();
    }

    // ── 5/6. Falha dos documentos depois da persistência ─────────────────
    for (const [rotulo, comp] of [["abortada (rede)", "abortar"], ["rejeitada com 500", "erro-500"]] as const) {
      console.log(`\nCenário 5 · buildDocumentosFinalizacaoAction ${rotulo} depois da persistência`);
      await limparFinalizacoes(amb);
      const page = await ctx.newPage();
      await page.setViewportSize({ width: 1600, height: 900 });
      await gerarPropostaGrupo(page);
      await abrirModalEEscolher(page, "consolidada");
      const ic = await armar(page, { docs: (n) => (n === 1 ? comp : "continuar") });
      await confirmar(page);
      const painel = page.getByTestId("painel-erro-documentos");
      check(await painel.waitFor({ timeout: 20000 }).then(() => true, () => false), "aparece o painel «Finalização concluída — documentos por preparar» (não o overlay)");
      check(!(await overlayDocs(page)) && !(await modalAberto(page)), "nenhum overlay nem modal a bloquear o ecrã");
      check(await page.getByText(/já ficaram gravadas/).count() > 0, "informa que a finalização foi concluída");
      const antes = await contagens(amb);
      check(eq(antes, referencia), "a persistência está completa (3 encomendas, 2 transferências, 3 outbox)");
      await page.getByRole("button", { name: "Tentar preparar documentos novamente" }).click();
      check(await esperarResultado(page), "o retry prepara os documentos");
      const depois = await contagens(amb);
      check(eq(depois, antes) && ic.chamadasPlano === 1 && ic.chamadasDocs === 2, `o retry só chamou os documentos (plano ${ic.chamadasPlano}×, documentos ${ic.chamadasDocs}×) e não criou NADA novo`);
      await page.close();
    }
    {
      console.log("\nCenário 5b · documentos falham e o utilizador conclui sem os preparar");
      await limparFinalizacoes(amb);
      const page = await ctx.newPage();
      await page.setViewportSize({ width: 1600, height: 900 });
      await gerarPropostaGrupo(page);
      await abrirModalEEscolher(page, "separada");
      await armar(page, { docs: () => "abortar" });
      await confirmar(page);
      await page.getByTestId("painel-erro-documentos").waitFor({ timeout: 20000 });
      await page.getByRole("button", { name: "Concluir" }).click();
      await page.waitForFunction(() => location.pathname === "/encomendas", null, { timeout: 15000 });
      check(eq(await contagens(amb), referencia), "«Concluir» sai para /encomendas mesmo sem documentos; dados intactos");
      await page.close();
    }

    // ── 7. Duplo clique ──────────────────────────────────────────────────
    console.log("\nCenário 7 · duplo clique em «Confirmar e finalizar»");
    {
      await limparFinalizacoes(amb);
      const page = await ctx.newPage();
      await page.setViewportSize({ width: 1600, height: 900 });
      await gerarPropostaGrupo(page);
      await abrirModalEEscolher(page, "consolidada");
      const ic = await armar(page, {});
      await page.getByRole("button", { name: "Confirmar e finalizar" }).dblclick();
      check(await esperarResultado(page), "conclui");
      check(eq(await contagens(amb), referencia) && ic.chamadasPlano === 1, `uma única operação persistente (plano chamado ${ic.chamadasPlano}×)`);
      await page.close();
    }

    // ── 8. Pedido pendurado ──────────────────────────────────────────────
    console.log("\nCenário 8 · gerarPlanoGrupoAction nunca responde");
    {
      await limparFinalizacoes(amb);
      // `page.clock` é o relógio do CONTEXTO: contexto próprio, para não afectar os outros cenários.
      const ctx8 = await abrirContexto(amb, browser, seed);
      const page = await ctx8.newPage();
      await page.clock.install();
      await page.setViewportSize({ width: 1600, height: 900 });
      await gerarPropostaGrupo(page);
      await abrirModalEEscolher(page, "consolidada");
      await armar(page, { plano: () => "pendurar" });
      await confirmar(page);
      check(await page.getByRole("button", { name: "A finalizar…" }).last().isDisabled(), "enquanto espera, o botão mostra «A finalizar…» e está desactivado (sem duplicar)");
      await page.clock.fastForward(50_000);
      const aviso = page.getByRole("status").filter({ hasText: /a demorar mais do que o esperado/ });
      check(await aviso.waitFor({ timeout: 10000 }).then(() => true, () => false), "ao fim de 45 s aparece um aviso visível (nunca silêncio)");
      check((await page.getByRole("button", { name: "Encomendas", exact: true }).count()) > 0, "o aviso oferece o caminho para verificar em Encomendas");
      await ctx8.close();
    }

    // ── 9. Refresh depois de persistir e antes dos documentos ────────────
    console.log("\nCenário 9 · refresh entre a finalização e os documentos");
    {
      await limparFinalizacoes(amb);
      const page = await ctx.newPage();
      await page.setViewportSize({ width: 1600, height: 900 });
      await gerarPropostaGrupo(page);
      await abrirModalEEscolher(page, "consolidada");
      await armar(page, { docs: () => "pendurar" });
      await confirmar(page);
      await page.getByText("A preparar os documentos…").waitFor({ timeout: 15000 });
      const antes = await contagens(amb);
      check(eq(antes, referencia), "a finalização ficou persistida enquanto os documentos estavam pendentes");
      // Recarrega COM o pedido de documentos ainda pendurado (um refresh real a meio) e só depois desarma a falha.
      await page.reload({ waitUntil: "networkidle" });
      await page.unroute("**/encomendas/nova**");
      const painel = page.getByTestId("painel-erro-documentos");
      check(await painel.waitFor({ timeout: 15000 }).then(() => true, () => false), "depois do refresh aparece o painel de recuperação (com os ids guardados)");
      check(eq(await contagens(amb), antes), "o refresh não voltou a finalizar nada");
      await page.getByRole("button", { name: "Tentar preparar documentos novamente" }).click();
      check(await esperarResultado(page), "a recuperação prepara os documentos");
      check(eq(await contagens(amb), antes), "e continua sem duplicados");
      await page.reload({ waitUntil: "networkidle" });
      check((await page.getByTestId("painel-erro-documentos").count()) === 0, "depois de concluído, um novo refresh não volta a oferecer a recuperação");
      await page.close();
    }
    await ctx.close();
  } finally {
    await browser.close();
    const logs = amb.logs();
    const eventos = ["group-finalization-start", "group-finalization-persisted", "group-documents-start", "group-documents-success", "group-documents-failed"];
    console.log("\nLogs estruturados do servidor:");
    for (const e of eventos) console.log(`  ${e}: ${(logs.match(new RegExp(`"evento":"${e}"`, "g")) ?? []).length}`);
    check(eventos.slice(0, 4).every((e) => logs.includes(`"evento":"${e}"`)), "os eventos group-finalization-start/persisted e group-documents-start/success existem");
    check(!/ARTIGO E2E|Farmacia Alfa|Farmacia Beta/.test(logs.split("\n").filter((l) => l.includes('"evento":"group-')).join("\n")), "os logs estruturados não contêm produtos nem nomes");
    await amb.parar();
  }
  console.log(`\n${failed === 0 ? "PASSOU" : "FALHOU"} — ${passed} OK, ${failed} falhas\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
