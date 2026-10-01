/**
 * scripts/tests/test-consolidacao-corrida-criacao-db.ts
 *
 * PostgreSQL REAL e DESCARTÁVEL (recusa correr fora de localhost):
 *
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:55494/postgres npx tsx scripts/tests/test-consolidacao-corrida-criacao-db.ts
 *
 * CORRIDA DURANTE A CRIAÇÃO DO RASCUNHO — parte servidor + estrutura.
 *
 * O cliente (React) não é executável aqui (sem DOM neste projecto); o
 * ensaio de BROWSER com atraso real da resposta está em
 * `scripts/e2e/consolidacao-fornecedor-linha-browser.ts` (passo 9e). Este
 * ficheiro cobre o que é verificável sem DOM:
 *
 *   S  a sequência exacta que o cliente executa — criação do rascunho com
 *      o snapshot (resposta ATRASADA deliberadamente), edições feitas
 *      entretanto acumuladas como ESTADO COMPLETO por linha (+ remoções),
 *      e um único autosave real quando o id chega — deixa na BD TODAS as
 *      operações: duas linhas diferentes, fornecedor+quantidade+notas,
 *      uma linha NÃO presente no snapshot (criada inteira pelo upsert) e
 *      uma remoção.
 *   E  estrutura do cliente (verificação estática): um só motor de
 *      autosave, autosave montado ANTES do rascunho existir e chave sem o
 *      id, gravação ao chegar o id, e a conclusão da criação descartada
 *      se a batchKey mudou.
 */
import Module from "node:module";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

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

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgresql://postgres:test@localhost:55493/postgres";
const host = new URL(ADMIN_URL).hostname;
if (host !== "localhost" && host !== "127.0.0.1") {
  console.error(`RECUSADO: ${host} não é uma base local descartável.`);
  process.exit(2);
}
function urlDe(db: string) {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${db}`;
  return u.toString();
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const chaveNova = () =>
  Array.from({ length: 24 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("");

async function main() {
  const db = `spharm_corrida_${Date.now().toString(36)}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${db}`);
  try {
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(db) }, encoding: "utf8" });
    const { PrismaClient } = await import("../../generated/prisma/client");
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(db) }) });
    const { salvarAutosaveEncomenda } = await import("../../lib/encomendas/autosave");
    const { ensureRascunhoConsolidacaoFarmaciaServico, obterRascunhosConsolidacaoServico } = await import("../../lib/encomendas/consolidacao-servico");
    const { deriveFarmaciaIdempotencyKey: deriveKey } = await import("../../lib/ingest/orders");

    const farm = await prisma.farmacia.create({ data: { nome: "Farmácia A" } });
    const fX = await prisma.fornecedor.create({ data: { nomeNormalizado: "FORN X", nome: "Forn X" } });
    const fY = await prisma.fornecedor.create({ data: { nomeNormalizado: "FORN Y", nome: "Forn Y" } });
    const prods = [];
    for (let i = 1; i <= 4; i++) prods.push(await prisma.produto.create({ data: { cnp: 9300000 + i, designacao: `Prod ${i}` } }));
    const [p1, p2, p3, p4] = prods;
    const admin1 = await prisma.utilizador.create({ data: { email: "a@t.pt", nome: "A", perfil: "ADMINISTRADOR" } });
    const deps = { prisma, tenantSlug: "t", sessao: { sub: admin1.id, perfil: "ADMINISTRADOR", farmaciaId: null as string | null } };

    // ═══ S · a sequência do cliente, com a resposta da criação ATRASADA ═══
    console.log("\nS · criação atrasada + edições concorrentes → um autosave real grava tudo");
    const batchKey = chaveNova();

    // "Estado pendente do autosave": o ESTADO COMPLETO mais recente por produto + remoções
    // (é o que `marcarSujo`/`marcarRemovido` do hook acumulam enquanto o id é null).
    type Completo = { quantidadeSugerida: number | null; quantidadeAjustada: number; fornecedorSugeridoId: string | null; notas: string | null; origem: "PROPOSTA" | "MANUAL" | "SUGESTAO" };
    const pendentes = new Map<string, Completo>();
    const remocoes = new Set<string>();
    const marcarSujo = (produtoId: string, c: Completo) => { remocoes.delete(produtoId); pendentes.set(produtoId, c); };
    const marcarRemovido = (produtoId: string) => { pendentes.delete(produtoId); remocoes.add(produtoId); };

    // Snapshot no momento da criação: P1, P2, P3 (P4 ainda não estava no ecrã/lista).
    const snapshot = [
      { produtoId: p1.id, quantidadeAjustada: 10, fornecedorSugeridoId: fX.id },
      { produtoId: p2.id, quantidadeAjustada: 5, fornecedorSugeridoId: fX.id },
      { produtoId: p3.id, quantidadeAjustada: 3, fornecedorSugeridoId: fX.id },
    ];
    const t0 = Date.now();
    const criacao = (async () => {
      const r = await ensureRascunhoConsolidacaoFarmaciaServico(deps, { batchKey, farmaciaId: farm.id, nome: "Corrida", linhas: snapshot });
      await sleep(1500); // a RESPOSTA chega tarde, deliberadamente
      return r;
    })();

    // ── edições feitas ENQUANTO a criação está em voo (rápidas, linhas diferentes) ──
    await sleep(50);
    marcarSujo(p1.id, { quantidadeSugerida: null, quantidadeAjustada: 21, fornecedorSugeridoId: fY.id, notas: "nota P1 durante a criação", origem: "MANUAL" }); // fornecedor + quantidade + notas
    marcarSujo(p2.id, { quantidadeSugerida: null, quantidadeAjustada: 5, fornecedorSugeridoId: fX.id, notas: "nota P2", origem: "MANUAL" }); // outra linha
    marcarRemovido(p3.id); // remoção durante a criação
    marcarSujo(p4.id, { quantidadeSugerida: 8, quantidadeAjustada: 8, fornecedorSugeridoId: fY.id, notas: "P4 fora do snapshot", origem: "PROPOSTA" }); // linha que o snapshot NÃO tinha
    marcarSujo(p1.id, { quantidadeSugerida: null, quantidadeAjustada: 22, fornecedorSugeridoId: fY.id, notas: "nota P1 (2.ª edição)", origem: "MANUAL" }); // a última edição vence

    const respondeu = await Promise.race([criacao.then(() => true), sleep(300).then(() => false)]);
    check(!respondeu && Date.now() - t0 < 1400, "S0: as edições aconteceram com a resposta da criação ainda por chegar");
    const rascunhoNoServidor = await prisma.listaEncomenda.findFirst({ where: { farmaciaId: farm.id } });
    const antesLinha = rascunhoNoServidor ? await prisma.linhaEncomenda.findFirst({ where: { listaEncomendaId: rascunhoNoServidor.id, produtoId: p1.id } }) : null;
    check(antesLinha?.notas === null && Number(antesLinha?.quantidadeAjustada) === 10, "S0b: nesse momento a BD ainda só tem o snapshot (nada das edições)");

    const r = await criacao;
    check(r.ok, "S1: o rascunho foi criado");
    if (!r.ok) throw new Error("setup");

    // O id chegou → o MESMO motor de autosave grava o pendente (uma só chamada, versão da criação).
    const gravado = await salvarAutosaveEncomenda(prisma, {
      listaEncomendaId: r.listaEncomendaId,
      versaoEsperada: r.versao,
      linhas: [...pendentes.entries()].map(([produtoId, c]) => ({ produtoId, ...c })),
      linhasRemovidasProdutoIds: [...remocoes],
    });
    check(gravado.gravadas === 3 && gravado.removidas === 1, "S2: um único autosave gravou 3 linhas e removeu 1", JSON.stringify(gravado));

    const linhas = await prisma.linhaEncomenda.findMany({ where: { listaEncomendaId: r.listaEncomendaId } });
    const l = (id: string) => linhas.find((x) => x.produtoId === id);
    check(l(p1.id)?.fornecedorSugeridoId === fY.id && Number(l(p1.id)?.quantidadeAjustada) === 22 && l(p1.id)?.notas === "nota P1 (2.ª edição)",
      "S3: P1 — fornecedor, quantidade e notas da ÚLTIMA edição estão na BD");
    check(l(p2.id)?.notas === "nota P2" && Number(l(p2.id)?.quantidadeAjustada) === 5, "S3b: P2 (outra linha, editada logo a seguir) também");
    check(!l(p3.id), "S4: P3 foi removida durante a criação e não existe na BD");
    check(
      !!l(p4.id) && l(p4.id)?.fornecedorSugeridoId === fY.id && Number(l(p4.id)?.quantidadeAjustada) === 8 && l(p4.id)?.notas === "P4 fora do snapshot" && l(p4.id)?.origem === "PROPOSTA",
      "S5: P4 (não estava no snapshot) foi criada INTEIRA — o estado completo evita uma linha parcial"
    );
    check(linhas.length === 3, "S6: a lista final tem exactamente P1, P2 e P4");

    // Sem o estado completo: um patch parcial para uma linha fora do snapshot criaria lixo (prova de porquê).
    const parcial = await salvarAutosaveEncomenda(prisma, {
      listaEncomendaId: r.listaEncomendaId, versaoEsperada: gravado.versao,
      linhas: [{ produtoId: (await prisma.produto.create({ data: { cnp: 9399999, designacao: "Parcial" } })).id, notas: "só notas" }],
    });
    const lixo = await prisma.linhaEncomenda.findFirst({ where: { listaEncomendaId: r.listaEncomendaId, notas: "só notas" } });
    check(parcial.gravadas === 1 && lixo?.quantidadeAjustada === null && lixo?.origem === "MANUAL",
      "S7: (contraprova) um patch PARCIAL numa linha nova cria uma linha sem quantidade e origem MANUAL — por isso o cliente envia sempre a linha completa");

    // ═══ X · uma operação CAPTURADA com a batchKey A nunca escreve em B ═══
    console.log("\nX · operações em voo capturadas com batchKey A nunca escrevem na consolidação B (mesma farmácia, mesmos produtos)");
    const bkA = chaveNova();
    const bkB = chaveNova();
    const linhasIni = [{ produtoId: p1.id, quantidadeAjustada: 4, fornecedorSugeridoId: fX.id, notas: "inicial" }];
    // B já existe e tem o seu próprio conteúdo
    const rB = await ensureRascunhoConsolidacaoFarmaciaServico(deps, { batchKey: bkB, farmaciaId: farm.id, nome: "B", linhas: linhasIni });
    if (!rB.ok) throw new Error("setup B");
    const fotoB = async () => {
      const l = await prisma.listaEncomenda.findUniqueOrThrow({ where: { id: rB.listaEncomendaId }, include: { linhas: { orderBy: { produtoId: "asc" } } } });
      return JSON.stringify({ versao: l.versao, nome: l.nome, linhas: l.linhas.map((x) => [x.produtoId, String(x.quantidadeAjustada), x.fornecedorSugeridoId, x.notas]) });
    };
    const antesX = await fotoB();
    // A operação de criação é CAPTURADA (batchKey A) e a sua resposta chega tarde, depois de a UI já ter ido para B.
    const capturaA = { batchKey: bkA };
    const criacaoA = (async () => {
      const r2 = await ensureRascunhoConsolidacaoFarmaciaServico(deps, { batchKey: capturaA.batchKey, farmaciaId: farm.id, nome: "A", linhas: [{ produtoId: p1.id, quantidadeAjustada: 9, fornecedorSugeridoId: fY.id, notas: "só de A" }] });
      await sleep(800);
      return r2;
    })();
    capturaA.batchKey = bkB; // (mutar a variável de fora não afecta o valor já capturado pela chamada)
    const rA = await criacaoA;
    check(rA.ok && rB.ok && rA.listaEncomendaId !== rB.listaEncomendaId, "X1: a criação capturada com A produz um rascunho DIFERENTE do de B");
    if (!rA.ok) throw new Error("setup A");
    check((await fotoB()) === antesX, "X2: o rascunho de B ficou exactamente igual (versão, linhas, fornecedor, notas)");
    const gravadoA = await salvarAutosaveEncomenda(prisma, {
      listaEncomendaId: rA.listaEncomendaId, versaoEsperada: rA.versao,
      linhas: [{ produtoId: p1.id, quantidadeAjustada: 12, fornecedorSugeridoId: fX.id, notas: "editado em A" }, { produtoId: p2.id, quantidadeAjustada: 2, fornecedorSugeridoId: fX.id, notas: "novo em A", origem: "MANUAL" }],
      linhasRemovidasProdutoIds: [p3.id],
    });
    check(gravadoA.gravadas === 2 && (await fotoB()) === antesX, "X3: o autosave do id de A (dois patches + remoção) não toca em B — a escrita segue o id do rascunho, não a batchKey actual");
    const keysA = await prisma.listaEncomenda.count({ where: { clientIdempotencyKey: deriveKey(bkA, farm.id) } });
    const keysB = await prisma.listaEncomenda.count({ where: { clientIdempotencyKey: deriveKey(bkB, farm.id) } });
    check(keysA === 1 && keysB === 1, "X4: cada batchKey tem exactamente UM rascunho para a farmácia");
    // a recuperação por batchKey devolve sempre o rascunho da chave pedida
    const recA = await obterRascunhosConsolidacaoServico(deps, { batchKey: bkA, farmaciaIds: [farm.id] });
    const recB = await obterRascunhosConsolidacaoServico(deps, { batchKey: bkB, farmaciaIds: [farm.id] });
    check(recA.ok && recB.ok && recA.porFarmacia[0].draft?.listaEncomendaId === rA.listaEncomendaId && recB.porFarmacia[0].draft?.listaEncomendaId === rB.listaEncomendaId, "X5: obter(A) devolve o rascunho de A e obter(B) o de B — nunca trocados");
    // repetir a criação de A (resposta perdida) continua a ser A, nunca B
    const rA2 = await ensureRascunhoConsolidacaoFarmaciaServico(deps, { batchKey: bkA, farmaciaId: farm.id, nome: "A", linhas: [{ produtoId: p1.id, quantidadeAjustada: 9, fornecedorSugeridoId: fY.id, notas: "só de A" }] });
    check(rA2.ok && rA2.listaEncomendaId === rA.listaEncomendaId && (await fotoB()) === antesX, "X6: repetir a criação de A (retry) devolve o MESMO rascunho de A e continua a não tocar em B");

    await prisma.$disconnect();
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.end();
  }

  // ═══ E · estrutura do cliente (estática) ═══
  console.log("\nE · estrutura do cliente — um motor, sem buffer paralelo, sem aplicar à consolidação errada");
  const cliente = readFileSync("components/encomendas/order-create-client.tsx", "utf8").replace(/\r\n/g, "\n");
  const comp = readFileSync("components/encomendas/consolidacao-farmacia-autosave.tsx", "utf8").replace(/\r\n/g, "\n");
  check((cliente.match(/autosaveEncomendaAction/g) ?? []).length === 2 && /autosaveAction: autosaveEncomendaAction,/.test(cliente) && /autosaveAction: autosaveEncomendaAction,/.test(comp), "E1: a action de autosave só é usada como argumento do hook (import + modo farmácia no ecrã; consolidação no componente) — nunca chamada à mão");
  check(/useAutosaveEncomenda\(/.test(comp) && (comp.match(/useAutosaveEncomenda\(/g) ?? []).length === 1, "E2: o componente por farmácia chama o hook UMA vez");
  check(/if \(listaEncomendaId !== null\) void autosave\.guardarAgora\(\)/.test(comp), "E3: quando o id do rascunho chega, o mesmo hook grava o pendente");
  const chave = cliente.match(/key=\{`\$\{batchKeyConsolidacao\}:\$\{farmaciaId\}:\$\{nonceConsolidacao\[farmaciaId\] \?\? 0\}`\}/);
  check(!!chave, "E4: a key do autosave tem batchKey+farmácia+nonce e NÃO o id do rascunho (não remonta quando o id chega, não perde o pendente)");
  check(/listaEncomendaId=\{d\?\.listaEncomendaId \?\? null\}/.test(cliente), "E5: o autosave monta com id=null enquanto o rascunho é criado");
  check(/if \(batchKeyConsolidacaoRef\.current !== batchKey\) return null;/.test(cliente), "E6: a conclusão da criação é descartada se a batchKey mudou");
  check(/if \(batchKeyConsolidacaoRef\.current !== key\) return; \/\/ outra consolidação/.test(cliente), "E7: a recuperação por chave também é descartada se a batchKey mudou");
  check(/quantidadeAjustada: Number\.isFinite\(q\) \? q : 0,\s*\n\s*fornecedorSugeridoId: l\.fornecedorSugeridoId,\s*\n\s*notas: l\.notas\.trim\(\) \|\| null,/.test(cliente), "E8: cada edição regista a linha COMPLETA (quantidade, fornecedor, notas)");
  check(!/pendentesPosCriacaoConsolidacao|bufferConsolidacao/.test(cliente), "E9: não existe um buffer/fila paralelo no ecrã");

  check(/e\.preventDefault\(\);\s*\n\s*e\.stopPropagation\(\);\s*\n\s*void saida\.confirmar\(\)\.then\(\(ok\) => \{\s*\n\s*if \(ok\) router\.push\(/.test(cliente), "E10: ao clicar num link/tarefa com pendentes o clique é suspenso e só navega (router.push) depois de tudo gravado");
  check(/data-navegacao-href=\{t\.href\}/.test(readFileSync("components/layout/task-bar.tsx", "utf8")), "E10b: as tarefas da barra declaram o destino e passam pela mesma guarda");
  check(/const chaveVoo = `\$\{batchKey\}:\$\{farmaciaId\}`;/.test(cliente) && /draftPromiseRefsConsolidacao\.current\.set\(chaveVoo, promessa\)/.test(cliente), "E12: a criação em voo fica associada, de forma imutável, à batchKey E à farmácia de origem");
  check(/const origem = batchKeyConsolidacaoRef\.current;[\s\S]*?!\(await saida\.confirmar\(\)\)\) \{[\s\S]*?params\.set\("consolidacao", origem\);[\s\S]*?return;\s*\n\s*\}\s*\n\s*if \(batchKeyConsolidacaoRef\.current !== origem\) return;/.test(cliente), "E13: na troca de ?consolidacao= a origem é liquidada primeiro; em falha repõe-se o URL de origem e não se activa a nova batchKey");
  check(/if \(mode === "consolidacao" && precisaLiquidarConsolidacao\(\)\) \{\s*\n\s*void confirmarSaidaConsolidacao\(\)\.then\(\(ok\) => \{\s*\n\s*if \(ok\) handleModeChange\(next\);/.test(cliente), "E14: sair do modo consolidação também espera pela gravação");
  check(/const emVoo = draftPromiseRefsConsolidacao\.current\.get\(`\$\{batchKey\}:\$\{fId\}`\);\s*\n\s*if \(emVoo\) await emVoo;/.test(cliente), "E15: a liquidação espera pela criação do rascunho em voo antes de gravar");
  check(/useEffect\(\s*\(\) => \(\) => \{\s*void guardarAgoraRef\.current\(\);/.test(comp), "E11: o autosave de cada farmácia também grava ao desmontar (navegação programática)");

  console.log(`\n${passed} ok, ${failed} falhas`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
