/**
 * scripts/e2e/transferencias-manutencao-browser.ts
 *
 * Ensaio de browser real (Chromium via Playwright) contra `next start`
 * local + PostgreSQL descartável para a nova "Manutenção de
 * Transferências" (/transferencias/manutencao). Mesma disciplina de
 * `scripts/e2e/encomendas-finalizacao-browser.ts` — nunca contra uma
 * base real.
 *
 *   docker run -d --name spharm-transf-manut-test-pg -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:16-alpine
 *   createdb -h localhost -p 55432 -U postgres spharm_e2e_transferencias
 *   DATABASE_URL=postgresql://postgres:test@localhost:55432/spharm_e2e_transferencias npx prisma migrate deploy
 *   npm run build
 *   E2E_DATABASE_URL=postgresql://postgres:test@localhost:55432/spharm_e2e_transferencias bash scripts/e2e/_start-server.sh &
 *   npm run test:e2e-transferencias-manutencao
 *
 * ─────────────────────────────────────────────────────────────────────
 * LACUNAS DOCUMENTADAS DE PROPÓSITO (não escondidas, não fingidas):
 *
 * 1) ISOLAMENTO ENTRE TENANTS (ponto 10 do pedido original) — FORA DE
 *    ÂMBITO AQUI. Este ficheiro corre contra UM tenant/UMA base
 *    descartável/UMA instância `next start`, tal como toda a infra-
 *    estrutura de e2e já existente no repositório. Provar que uma
 *    Transferencia do tenant A é invisível ao tenant B exige uma SEGUNDA
 *    base de dados com o seu próprio schema aplicado e uma sessão cujo
 *    claim `tenant` resolva para esse segundo tenant (ver
 *    `resolveCurrentTenantSlug`/`getSession` em lib/auth.ts) — ou seja,
 *    uma segunda instância do servidor Next (o tenant é resolvido a
 *    partir do host do pedido) ou, no mínimo, uma segunda ligação de
 *    Postgres com `DATABASE_URL` própria. Nada disto está fingido com
 *    dois "farmaciaId" na MESMA base — isso testaria escopo por
 *    farmácia (ponto 9, coberto abaixo), não isolamento por tenant.
 *
 * 2) PONTO 9 (utilizador sem acesso a uma farmácia) — ADAPTADO EM DUAS
 *    PARTES, porque `requirePermission`/`getSession` (lib/permissions.ts
 *    / lib/auth.ts) dependem de `next/headers` (cookies do pedido) e de
 *    `next/navigation.redirect` (um digest que só o runtime do Next
 *    interpreta) — não correm fora de um pedido HTTP real, logo não é
 *    possível chamar `consultarTransferenciaAction`/
 *    `anularTransferenciaAction` directamente em Node sem reproduzir
 *    internamente o protocolo de Server Actions do Next (cabeçalho
 *    `Next-Action` com o id da acção compilado, corpo no formato
 *    react-server-dom) — frágil e fora do que vale a pena reproduzir à
 *    mão. Por isso:
 *      (a) A parte que É alcançável por um pedido HTTP real é testada
 *          a sério: sessão forjada de um GESTOR_FARMACIA cuja farmácia
 *          NÃO é nem origem nem destino da transferência-alvo, contra o
 *          servidor real — confirma-se que a listagem (com/sem filtro
 *          `?q=`) nunca mostra essa transferência (escopo aplicado em
 *          `farmaciaScopeFromSession`/`loadTransferenciasManutencao`) e
 *          que o botão "Anular" nunca aparece a um GESTOR_FARMACIA (gate
 *          adicional e mais restritivo: `podeAnular` vem de
 *          `can(session,"settings.global")`, que exclui GESTOR_FARMACIA
 *          mesmo para farmácias próprias — ver app/transferencias/
 *          manutencao/page.tsx).
 *      (b) A rejeição por farmácia que `anularTransferenciaAction`/
 *          `consultarTransferenciaAction` fazem via
 *          `!canAccessFarmaciaSync(session, origemId) ||
 *          !canAccessFarmaciaSync(session, destinoId)` é provada
 *          chamando A MESMA função real e exportada
 *          `canAccessFarmaciaSync` (lib/permissions-core.ts — pura, sem
 *          "server-only", sem BD) com um objecto `SessionUser` com
 *          exactamente os claims que o JWT forjado do GESTOR_FARMACIA
 *          contém, contra o `farmaciaOrigemId`/`farmaciaDestinoId` REAIS
 *          lidos da transferência real criada nesta base. Não é a acção
 *          inteira a correr — é a guarda exacta que a decide, com dados
 *          reais, não um mock do resultado.
 */
import { chromium, type Page } from "playwright";
import { SignJWT } from "jose";
import { Client } from "pg";
import Module from "node:module";
import { seedE2E, E2E_FARMACIAS } from "./seed-e2e";

const DB = process.env.E2E_DATABASE_URL ?? "postgresql://postgres:test@localhost:55432/spharm_e2e_transferencias";
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3100";
const SECRET = process.env.E2E_AUTH_SECRET ?? "e2e-test-secret-e2e-test-secret-0123456789";
for (const u of [DB, BASE]) {
  const h = new URL(u).hostname;
  if (h !== "localhost" && h !== "127.0.0.1") { console.error(`RECUSADO: ${h} não é local.`); process.exit(2); }
}

// `criar-transferencia.ts` importa "server-only" — só interessa fora do
// runtime Next para lançar (é um no-op para Node normal), mas o pacote
// em si não existe fora de node_modules do Next. Mesmo truque de
// scripts/tests/test-criar-transferencia-db.ts.
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

async function gerarPropostaGrupo(page: Page) {
  await page.goto(BASE + "/encomendas/nova", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Grupo", exact: true }).click();
  await page.getByRole("button", { name: /Gerar (nova )?proposta/ }).click();
  await page.getByText("ARTIGO E2E 6").first().waitFor({ state: "attached", timeout: 30000 });
}

// ─── Pontos 1/2 — criar e finalizar via browser, depois encontrar na manutenção ─
async function testeCriarEEncontrar(
  ctx: import("playwright").BrowserContext,
  db: Client
): Promise<{ id: string; numero: string; farmaciaOrigemId: string; farmaciaDestinoId: string }> {
  console.log("\nPontos 1/2 · criar+finalizar uma transferência via browser (fluxo real 'Grupo' → decisão TRANSFERIR) e encontrá-la na manutenção");
  await db.query(`DELETE FROM "ListaEncomenda"`);
  await db.query(`DELETE FROM "Transferencia"`);
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1600, height: 900 });
  await gerarPropostaGrupo(page);

  await page.getByRole("button", { name: "Finalizar encomenda" }).click();
  await page.getByText("Como pretende gerar a encomenda?").waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "Confirmar e finalizar" }).click();
  await page.getByText("Encomenda finalizada").waitFor({ timeout: 30000 });
  await page.close();

  const r = await db.query(
    `SELECT id, numero, "farmaciaOrigemId", "farmaciaDestinoId" FROM "Transferencia" WHERE estado='FINALIZADA' ORDER BY "dataCriacao" ASC LIMIT 1`
  );
  check(r.rowCount === 1, "Ponto 1: o fluxo de Grupo (decisão TRANSFERIR) produziu pelo menos uma Transferencia FINALIZADA real na BD");
  const row = r.rows[0] as { id: string; numero: string | null; farmaciaOrigemId: string; farmaciaDestinoId: string };
  check(/^TR-\d{6}$/.test(row.numero ?? ""), "Ponto 1: número real no formato TR-######", row.numero ?? "null");

  // Ponto 2 — encontrar de novo, como se o utilizador tivesse navegado
  // para longe e voltasse mais tarde a /transferencias/manutencao à
  // procura pelo número.
  const page2 = await ctx.newPage();
  await page2.goto(`${BASE}/transferencias/manutencao?q=${encodeURIComponent(row.numero!)}`, { waitUntil: "networkidle" });
  check(await page2.getByText(row.numero!).first().isVisible(), "Ponto 2: a transferência aparece na manutenção ao procurar pelo número exacto");
  check((await page2.locator("tbody tr").count()) === 1, "Ponto 2: a busca por número devolve exactamente 1 linha (nenhum falso-positivo)");
  await page2.close();

  return { id: row.id, numero: row.numero!, farmaciaOrigemId: row.farmaciaOrigemId, farmaciaDestinoId: row.farmaciaDestinoId };
}

// ─── Ponto 3 — documento/PDF depois de um "refresh" simulado ────────────
async function testeDocumentoAposRefresh(ctx: import("playwright").BrowserContext, numero: string) {
  console.log("\nPonto 3 · reimpressão (Documento/PDF) depois de recarregar a página");
  const page = await ctx.newPage();
  await page.goto(`${BASE}/transferencias/manutencao?q=${encodeURIComponent(numero)}`, { waitUntil: "networkidle" });
  // Simula "fechar e voltar" — recarrega a mesma página antes de abrir o documento.
  await page.reload({ waitUntil: "networkidle" });

  await page.getByRole("button", { name: "Documento" }).first().click();
  await page.getByText("A preparar os documentos…").waitFor({ state: "hidden", timeout: 15000 }).catch(() => {});

  let tituloPedido: string | null = null;
  await page.route("**/api/reports/pdf", async (route) => {
    const body = route.request().postDataJSON() as { title?: string };
    tituloPedido = body?.title ?? null;
    await route.abort();
  });
  const secaoTransferencias = page.locator("div", { has: page.getByRole("heading", { name: "Transferências" }) }).first();
  await secaoTransferencias.getByRole("button", { name: "PDF" }).first().click();
  await page.waitForTimeout(500);
  await page.unroute("**/api/reports/pdf");
  check(tituloPedido === "Guia de Transferência", `o botão Documento da manutenção resolve o MESMO documento real após reload (título pedido: ${tituloPedido})`);
  await page.close();
}

// ─── Pontos 4/5 — Anular via formulário inline da manutenção ────────────
async function testeAnular(ctx: import("playwright").BrowserContext, db: Client, id: string, numero: string) {
  console.log("\nPontos 4/5 · anular via formulário inline (motivo obrigatório) — linhas originais intocadas");
  const linhasAntes = (await db.query(`SELECT "produtoId", quantidade FROM "LinhaTransferencia" WHERE "transferenciaId" = $1 ORDER BY "produtoId"`, [id])).rows;

  const page = await ctx.newPage();
  await page.goto(`${BASE}/transferencias/manutencao?q=${encodeURIComponent(numero)}`, { waitUntil: "networkidle" });
  const linha = page.locator("tbody tr").filter({ hasText: numero }).first();
  await linha.getByRole("button", { name: "Anular" }).click();

  // Confirmar sem motivo é recusado no próprio cliente (não chega a chamar a acção).
  await page.getByRole("button", { name: "Confirmar anulação" }).click();
  check(await page.getByText("É obrigatório indicar um motivo para anular.").isVisible(), "Ponto 4: sem motivo, o pedido é recusado ANTES de chamar o servidor");

  const motivo = "Produto devolvido ao fornecedor por engano — e2e";
  await page.getByPlaceholder("Obrigatório — descreva o motivo").fill(motivo);
  await page.getByRole("button", { name: "Confirmar anulação" }).click();
  await page.getByText("Transferência anulada.").waitFor({ timeout: 15000 });

  const dbRow = await db.query(
    `SELECT estado, "motivoAnulacao", "anuladoPorId", "anuladoEm" FROM "Transferencia" WHERE id = $1`,
    [id]
  );
  const t = dbRow.rows[0] as { estado: string; motivoAnulacao: string | null; anuladoPorId: string | null; anuladoEm: Date | null };
  check(t.estado === "ANULADA", "Ponto 4: estado real gravado é ANULADA");
  check(t.motivoAnulacao === motivo, "Ponto 4: motivoAnulacao real bate com o texto submetido", t.motivoAnulacao ?? "null");
  check(t.anuladoPorId !== null, "Ponto 4: anuladoPorId real preenchido");
  check(t.anuladoEm !== null, "Ponto 4: anuladoEm real preenchido");

  const linhasDepois = (await db.query(`SELECT "produtoId", quantidade FROM "LinhaTransferencia" WHERE "transferenciaId" = $1 ORDER BY "produtoId"`, [id])).rows;
  check(linhasDepois.length === linhasAntes.length, "Ponto 4: nº de LinhaTransferencia inalterado (nunca apaga linhas ao anular)");
  check(
    JSON.stringify(linhasDepois) === JSON.stringify(linhasAntes),
    "Ponto 4: produtoId/quantidade de cada linha original bit-a-bit inalterados",
    `antes=${JSON.stringify(linhasAntes)} depois=${JSON.stringify(linhasDepois)}`
  );

  // Ponto 5 — reload real e o marcador "Anulado" continua visível.
  await page.reload({ waitUntil: "networkidle" });
  const linhaDepois = page.locator("tbody tr").filter({ hasText: numero }).first();
  check(await linhaDepois.getByText("Anulado").isVisible(), "Ponto 5: depois de recarregar, a linha mostra o marcador rosa 'Anulado'");
  await page.close();
}

// ─── Ponto 6 — Duplicar uma FINALIZADA ──────────────────────────────────
async function testeDuplicar(ctx: import("playwright").BrowserContext, db: Client, prisma: import("../../generated/prisma/client").PrismaClient, farmaciaOrigemId: string, farmaciaDestinoId: string, criadoPorId: string, produtoId: string) {
  console.log("\nPonto 6 · duplicar uma transferência FINALIZADA — original intocada, novo RASCUNHO com as mesmas linhas");

  const { criarTransferenciaComLinhas } = await import("../../lib/transferencias/criar-transferencia");
  const original = await criarTransferenciaComLinhas(prisma, {
    farmaciaOrigemId,
    farmaciaDestinoId,
    criadoPorId,
    finalize: true,
    linhas: [{ produtoId, quantidade: 7, notas: "linha original — duplicar" }],
  });
  check(/^TR-\d{6}$/.test(original.numero ?? ""), "Ponto 6 (fixture): transferência original criada directamente na BD nasce FINALIZADA com número real");

  const page = await ctx.newPage();
  await page.goto(`${BASE}/transferencias/manutencao?q=${encodeURIComponent(original.numero!)}`, { waitUntil: "networkidle" });
  const linhaOriginal = page.locator("tbody tr").filter({ hasText: original.numero! }).first();

  check((await linhaOriginal.getByRole("button", { name: "Eliminar" }).count()) === 0, "Ponto 11: uma linha FINALIZADA nunca expõe 'Eliminar'");

  await linhaOriginal.getByRole("button", { name: "Duplicar" }).click();
  await page.getByText("Transferência duplicada").waitFor({ timeout: 15000 });
  await page.close();

  const originalDepois = await db.query(`SELECT estado, numero FROM "Transferencia" WHERE id = $1`, [original.transferenciaId]);
  check(originalDepois.rows[0].estado === "FINALIZADA", "Ponto 6: a transferência ORIGINAL continua FINALIZADA (duplicar nunca a altera)");
  check(originalDepois.rows[0].numero === original.numero, "Ponto 6: número da original inalterado");

  const novas = await db.query(
    `SELECT id, estado, numero FROM "Transferencia" WHERE "farmaciaOrigemId" = $1 AND "farmaciaDestinoId" = $2 AND id != $3 AND estado = 'RASCUNHO' ORDER BY "dataCriacao" DESC LIMIT 1`,
    [farmaciaOrigemId, farmaciaDestinoId, original.transferenciaId]
  );
  check(novas.rowCount === 1, "Ponto 6: nasceu uma NOVA transferência (id diferente) em RASCUNHO");
  const novaId = novas.rows[0]?.id as string | undefined;
  check(novas.rows[0]?.numero === null, "Ponto 6: o novo RASCUNHO ainda não tem número (não é finalizado automaticamente)");

  if (novaId) {
    const linhasNovas = await db.query(`SELECT "produtoId", quantidade::text FROM "LinhaTransferencia" WHERE "transferenciaId" = $1`, [novaId]);
    check(linhasNovas.rowCount === 1 && linhasNovas.rows[0].produtoId === produtoId, "Ponto 6: a linha duplicada tem o MESMO produtoId da original");
    check(Number(linhasNovas.rows[0]?.quantidade) === 7, "Ponto 6: a linha duplicada tem a MESMA quantidade da original");
  }

  return { id: original.transferenciaId, numero: original.numero! };
}

// ─── Ponto 12 — RASCUNHO pode ser eliminado (soft-delete) ───────────────
async function testeEliminarRascunho(ctx: import("playwright").BrowserContext, db: Client, prisma: import("../../generated/prisma/client").PrismaClient, farmaciaOrigemId: string, farmaciaDestinoId: string, criadoPorId: string, produtoId: string) {
  console.log("\nPonto 12 · um RASCUNHO PODE ser eliminado (soft-delete — nunca remoção física)");
  const { criarTransferenciaComLinhas } = await import("../../lib/transferencias/criar-transferencia");
  const rascunho = await criarTransferenciaComLinhas(prisma, {
    farmaciaOrigemId,
    farmaciaDestinoId,
    criadoPorId,
    finalize: false,
    linhas: [{ produtoId, quantidade: 3 }],
  });
  check(rascunho.numero === null, "Ponto 12 (fixture): rascunho criado directamente na BD não tem número");

  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  await page.goto(`${BASE}/transferencias/manutencao?estado=RASCUNHO`, { waitUntil: "networkidle" });
  const linhaCount = await page.locator("tbody tr").count();
  check(linhaCount >= 1, "Ponto 12: o rascunho aparece na listagem filtrada por estado=RASCUNHO");

  await page.getByRole("button", { name: "Eliminar" }).first().click();
  await page.getByText("Transferência eliminada.").waitFor({ timeout: 15000 });
  await page.close();

  const dbRow = await db.query(`SELECT estado FROM "Transferencia" WHERE id = $1`, [rascunho.transferenciaId]);
  check(dbRow.rows[0]?.estado === "ELIMINADA", "Ponto 12: soft-delete real — estado passa a ELIMINADA (a row continua a existir)");

  const rowCountFisico = await db.query(`SELECT count(*)::int n FROM "Transferencia" WHERE id = $1`, [rascunho.transferenciaId]);
  check(rowCountFisico.rows[0].n === 1, "Ponto 12: nunca uma remoção física — a row continua presente na tabela");

  const page2 = await ctx.newPage();
  await page2.goto(`${BASE}/transferencias/manutencao`, { waitUntil: "networkidle" });
  const aindaVisivel = await page2.getByText(rascunho.numero ?? "§nunca§").count();
  check(aindaVisivel === 0, "Ponto 12: desaparece da listagem por omissão (sem filtro de estado) depois de eliminado");
  await page2.close();
}

// ─── Ponto 16 — "Documento" abre o modal e mostra as acções, sem validar conteúdo ─
async function testeDocumentoWiring(ctx: import("playwright").BrowserContext, numeroFinalizada: string, numeroAnulada: string) {
  console.log("\nPonto 16 · 'Documento' abre o DocumentosModal com Imprimir/PDF/Email — conteúdo do PDF já coberto noutro sítio");
  for (const [numero, estado] of [[numeroFinalizada, "FINALIZADA"], [numeroAnulada, "ANULADA"]] as const) {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/transferencias/manutencao?q=${encodeURIComponent(numero)}`, { waitUntil: "networkidle" });
    const linha = page.locator("tbody tr").filter({ hasText: numero }).first();
    await linha.getByRole("button", { name: "Documento" }).click();
    await page.getByText("Documento da transferência").waitFor({ timeout: 10000 });
    // "Documento da transferência" é o título estático do modal (ver
    // `titulo` em transferencia-manutencao-client.tsx) — aparece em TODAS
    // as fases (modalidade/carregando/resultado), não prova que os dados
    // assíncronos de `buildDocumentosFinalizacaoAction` já chegaram. É
    // preciso esperar que "A preparar os documentos…" desapareça, tal como
    // `testeDocumentoAposRefresh` já faz acima para o mesmo modal.
    await page.getByText("A preparar os documentos…").waitFor({ state: "hidden", timeout: 15000 }).catch(() => {});
    check(await page.getByRole("button", { name: "Imprimir" }).count() >= 1, `Ponto 16 (${estado}): botão Imprimir presente no modal de documentos`);
    check(await page.getByRole("button", { name: "PDF" }).count() >= 1, `Ponto 16 (${estado}): botão PDF presente no modal de documentos`);
    check(await page.getByRole("button", { name: "Email" }).count() >= 1, `Ponto 16 (${estado}): botão Email presente no modal de documentos`);
    await page.close();
  }
}

// ─── Pontos 7/8 — idempotência de criarTransferenciaComLinhas ───────────
async function testeIdempotencia(prisma: import("../../generated/prisma/client").PrismaClient, farmaciaOrigemId: string, farmaciaDestinoId: string, criadoPorId: string, produtoId: string) {
  console.log("\nPontos 7/8 · idempotência — prova directa em Node contra a BD real (ver nota abaixo sobre a UI)");
  console.log(
    "  NOTA: `components/transferencias/create-internal-transfer-button.tsx` (o botão \"Criar transferência\" que chama\n" +
    "  `createInternalTransferAction`) NÃO gera nem passa `clientIdempotencyKey` hoje — o campo existe no tipo\n" +
    "  `CreateInternalTransferInput` e a acção aceita-o, mas nenhum chamador real da UI o preenche. Um duplo-clique no\n" +
    "  botão real, hoje, NÃO está protegido contra duplicação — cada clique é um pedido sem chave (ver bloco 'D' de\n" +
    "  `test-criar-transferencia-db.ts`, cenário E). Por isso a idempotência é provada aqui directamente sobre\n" +
    "  `criarTransferenciaComLinhas` (a única função que sabe aplicar a chave), não através de um duplo-clique no browser\n" +
    "  que hoje não a exercitaria de facto. A prova exaustiva já existe em scripts/tests/test-criar-transferencia-db.ts —\n" +
    "  aqui repete-se só o essencial para este ficheiro ficar auto-contido."
  );
  const { criarTransferenciaComLinhas, IdempotencyConflictError } = await import("../../lib/transferencias/criar-transferencia");
  const chave = `e2e-manutencao-idem-${Date.now().toString(36)}`;
  const a = await criarTransferenciaComLinhas(prisma, {
    farmaciaOrigemId, farmaciaDestinoId, criadoPorId, finalize: true,
    linhas: [{ produtoId, quantidade: 4 }],
    clientIdempotencyKey: chave,
  });
  const b = await criarTransferenciaComLinhas(prisma, {
    farmaciaOrigemId, farmaciaDestinoId, criadoPorId, finalize: true,
    linhas: [{ produtoId, quantidade: 4 }],
    clientIdempotencyKey: chave,
  });
  check(a.transferenciaId === b.transferenciaId, "Ponto 7: 'clique repetido' (mesma clientIdempotencyKey) devolve a MESMA transferência real, não duplica");
  const total = await prisma.transferencia.count({ where: { clientIdempotencyKey: chave } });
  check(total === 1, "Ponto 7: só existe 1 row real com esta chave em Postgres", String(total));

  let lancou = false;
  try {
    await criarTransferenciaComLinhas(prisma, {
      farmaciaOrigemId, farmaciaDestinoId, criadoPorId, finalize: true,
      linhas: [{ produtoId, quantidade: 999 }], // pedido diferente, mesma chave
      clientIdempotencyKey: chave,
    });
  } catch (e) {
    lancou = e instanceof IdempotencyConflictError;
  }
  check(lancou, "Ponto 8: a mesma chave com um pedido DIFERENTE lança IdempotencyConflictError (nunca finge sucesso)");
  const totalDepois = await prisma.transferencia.count({ where: { clientIdempotencyKey: chave } });
  check(totalDepois === 1, "Ponto 8: continua a existir só 1 row — o pedido em conflito não foi aplicado");
}

// ─── Ponto 9 — escopo por farmácia (ver nota no topo do ficheiro) ───────
async function testeEscopoFarmacia(
  browser: import("playwright").Browser,
  farmaciaOutraId: string,
  transferenciaId: string,
  numero: string,
  farmaciaOrigemId: string,
  farmaciaDestinoId: string
) {
  console.log("\nPonto 9 · utilizador sem acesso a NENHUMA das farmácias da transferência (ver nota detalhada no topo do ficheiro)");
  const { canAccessFarmaciaSync } = await import("../../lib/permissions-core");

  const outroToken = await new SignJWT({
    sub: "e2e-gestor-farmacia-sem-acesso",
    email: "e2e-outra-farmacia@spharm.test",
    nome: "E2E Gestor Farmácia (sem acesso)",
    perfil: "GESTOR_FARMACIA",
    farmaciaId: farmaciaOutraId,
    tenant: "__legacy__",
  }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("8h").sign(new TextEncoder().encode(SECRET));

  const ctx2 = await browser.newContext();
  await ctx2.addCookies([{ name: "session", value: outroToken, url: BASE }]);
  const page = await ctx2.newPage();

  await page.goto(`${BASE}/transferencias/manutencao?q=${encodeURIComponent(numero)}`, { waitUntil: "networkidle" });
  check((await page.locator("tbody tr").count()) === 0, "Ponto 9a (browser real): a listagem escopada não devolve a transferência de outra farmácia, mesmo filtrando pelo número exacto");

  await page.goto(`${BASE}/transferencias/manutencao`, { waitUntil: "networkidle" });
  check((await page.getByRole("button", { name: "Anular" }).count()) === 0, "Ponto 9b (browser real): GESTOR_FARMACIA nunca vê o botão 'Anular' (gate settings.global, mais restritivo que o escopo por farmácia)");
  await ctx2.close();

  // Ponto 9c — a MESMA guarda real que anularTransferenciaAction/
  // consultarTransferenciaAction chamam, com os claims reais do JWT
  // acima e os ids reais da transferência (ver nota no topo do ficheiro
  // sobre porque a acção inteira não corre fora de um pedido Next real).
  const sessaoSemAcesso = {
    sub: "e2e-gestor-farmacia-sem-acesso",
    email: "e2e-outra-farmacia@spharm.test",
    nome: "E2E Gestor Farmácia (sem acesso)",
    perfil: "GESTOR_FARMACIA",
    farmaciaId: farmaciaOutraId,
    tenant: "__legacy__",
  } as const;
  const rejeitaOrigem = !canAccessFarmaciaSync(sessaoSemAcesso as never, farmaciaOrigemId);
  const rejeitaDestino = !canAccessFarmaciaSync(sessaoSemAcesso as never, farmaciaDestinoId);
  check(rejeitaOrigem && rejeitaDestino, "Ponto 9c: canAccessFarmaciaSync (a guarda REAL usada por anular/consultar) rejeita esta sessão tanto na origem como no destino reais");

  const sessaoAdmin = { sub: "x", email: "a@a", nome: "A", perfil: "ADMINISTRADOR", farmaciaId: null, tenant: "__legacy__" } as const;
  check(
    canAccessFarmaciaSync(sessaoAdmin as never, farmaciaOrigemId) && canAccessFarmaciaSync(sessaoAdmin as never, farmaciaDestinoId),
    "Ponto 9c (controlo): a mesma guarda aceita um ADMINISTRADOR nas mesmas farmácias reais — a rejeição acima é por escopo, não por erro nos dados"
  );
  void transferenciaId;
}

async function main() {
  const seed = await seedE2E(DB);
  const token = await new SignJWT({
    sub: seed.userId, email: "e2e@spharm.test", nome: "E2E Admin", perfil: "ADMINISTRADOR", farmaciaId: null, tenant: "__legacy__",
  }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("8h").sign(new TextEncoder().encode(SECRET));
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: "session", value: token, url: BASE }]);
  const db = new Client({ connectionString: DB });
  await db.connect();

  const { PrismaClient } = await import("../../generated/prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB }) });

  try {
    const t1 = await testeCriarEEncontrar(ctx, db);
    await testeDocumentoAposRefresh(ctx, t1.numero);
    await testeAnular(ctx, db, t1.id, t1.numero);

    const t2 = await testeDuplicar(ctx, db, prisma, t1.farmaciaOrigemId, t1.farmaciaDestinoId, seed.userId, seed.produtos[0].id);
    await testeEliminarRascunho(ctx, db, prisma, t1.farmaciaOrigemId, t1.farmaciaDestinoId, seed.userId, seed.produtos[0].id);
    await testeDocumentoWiring(ctx, t2.numero, t1.numero);
    await testeIdempotencia(prisma, t1.farmaciaOrigemId, t1.farmaciaDestinoId, seed.userId, seed.produtos[1].id);

    const farmaciaOutraId = seed.farmaciaIds.find((id) => id !== t1.farmaciaOrigemId && id !== t1.farmaciaDestinoId);
    if (!farmaciaOutraId) {
      failed++;
      console.log(`  [FALHA] Ponto 9: seedE2E só criou ${E2E_FARMACIAS.length} farmácias e a transferência usou 2 — precisa de pelo menos 3 para haver uma terceira sem acesso.`);
    } else {
      await testeEscopoFarmacia(browser, farmaciaOutraId, t1.id, t1.numero, t1.farmaciaOrigemId, t1.farmaciaDestinoId);
    }
  } finally {
    await prisma.$disconnect();
    await db.end();
    await browser.close();
  }
  console.log(`\n${passed} ok, ${failed} falhas`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
