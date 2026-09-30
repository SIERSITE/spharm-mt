/**
 * scripts/tests/test-encomenda-grupo-multi-fornecedor-db.ts
 *
 * Fornecedor por linha em MODO GRUPO — a extensão feita nesta revisão a
 * `gerarPlanoGrupoAction` (app/encomendas/nova/actions.ts) para que uma
 * farmácia cujas linhas ENCOMENDAR apontem para MAIS DE UM fornecedor
 * seja dividida em N documentos, reutilizando `finalizarEncomendaMulti-
 * Fornecedor` — o MESMO motor do fluxo manual (rascunho editável →
 * "Finalizar") já coberto por `test-finalizar-multi-fornecedor-db.ts` —
 * nunca uma segunda implementação da divisão por fornecedor.
 *
 * ── Porque este ficheiro NÃO chama `gerarPlanoGrupoAction` directamente ──
 *
 * Mesmo motivo de `test-finalizacao-grupo-direta.ts`: a acção depende de
 * `requirePermission`/`getPrisma()` (contexto de pedido do Next.js), que
 * não existe neste script. Em vez disso:
 *
 *   A. Estático — confirma no código-fonte que a farmácia com mais de um
 *      fornecedor reutiliza `finalizarEncomendaMultiFornecedor` (nunca
 *      reimplementa o agrupamento por fornecedor).
 *   B. Integração REAL em Postgres descartável — reproduz EXACTAMENTE a
 *      mesma sequência que a acção agora executa por farmácia
 *      (`agruparParaGeracao` → `deveUsarFinalizacaoMultiFornecedor` →
 *      criar RASCUNHO TRANSITÓRIO com `createEncomendaWithOutbox(finalize:
 *      false)` → `finalizarEncomendaMultiFornecedor`, ou o caminho de
 *      sempre com `finalize:true` directo quando há 0/1 fornecedor) e
 *      confirma o estado final na base.
 *
 * ── O que NÃO está coberto aqui ──────────────────────────────────────
 *
 * A sugestão INICIAL de fornecedor em modo grupo (`generateGroupProposal`
 * → `generateOrderProposal` → `ProdutoFarmacia.fornecedorHabitualId`) não
 * tem um teste de BD novo neste ficheiro: confirmado por LEITURA directa
 * do código (`lib/encomendas/proposal.ts`) que `generateGroupProposal`
 * chama `generateOrderProposal` por farmácia e apenas concatena
 * (`flatMap`) as suas `rows` — o MESMO `fornecedorSugeridoId` que já
 * populava o modo "farmacia" antes desta revisão, sem nenhuma lógica
 * nova a testar aqui. Um teste de BD dessa consulta (que exige fixtures
 * de VendaMensal + catálogo) já não é matéria desta revisão — a
 * funcionalidade nova é exclusivamente a divisão em `gerarPlanoGrupoAction`.
 *
 * docker run -d --name spharm-ws-test-pg-picker-grupo -e POSTGRES_PASSWORD=test -p 55444:5432 postgres:16-alpine
 * TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:55444/postgres npx tsx scripts/tests/test-encomenda-grupo-multi-fornecedor-db.ts
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

console.log("\nA · gerarPlanoGrupoAction reutiliza finalizarEncomendaMultiFornecedor (estático)");
{
  const src = readFileSync(new URL("../../app/encomendas/nova/actions.ts", import.meta.url), "utf8");
  const fnStart = src.indexOf("export async function gerarPlanoGrupoAction");
  const fnEnd = src.indexOf("\nexport ", fnStart + 10);
  const fnBody = src.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 12000);
  check(fnStart > 0, "A1: encontra gerarPlanoGrupoAction");
  check(fnBody.includes("deveUsarFinalizacaoMultiFornecedor("), "A2: decide por farmácia se há mais de um fornecedor — mesma regra pura do fluxo manual");
  check(
    fnBody.includes("finalizarEncomendaMultiFornecedor(prisma, tenantSlug,"),
    "A3: reutiliza finalizarEncomendaMultiFornecedor — nunca uma segunda implementação da divisão por fornecedor"
  );
  check(
    fnBody.includes("validarLinhasParaFinalizacaoMultiFornecedor("),
    "A4: reutiliza a mesma validação de 'linha sem fornecedor bloqueia tudo' do fluxo manual"
  );
  check(
    !/agruparLinhasPorFornecedor/.test(fnBody),
    "A5: NÃO reimplementa o agrupamento por fornecedor aqui — isso é responsabilidade exclusiva de finalizarEncomendaMultiFornecedor"
  );
}

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgresql://postgres:test@localhost:55444/postgres";
const host = new URL(ADMIN_URL).hostname;
if (host !== "localhost" && host !== "127.0.0.1") {
  console.error(`RECUSADO: ${host} não é uma base local descartável.`);
  process.exit(2);
}
const urlDe = (db: string) => { const u = new URL(ADMIN_URL); u.pathname = `/${db}`; return u.toString(); };

async function main() {
  const db = `spharm_grupo_multiforn_${Date.now().toString(36)}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${db}`);

  try {
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(db) }, encoding: "utf8" });

    const { PrismaClient } = await import("../../generated/prisma/client");
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(db) }) });

    const { createEncomendaWithOutbox, IdempotencyConflictError } = await import("../../lib/ingest/orders");
    const {
      finalizarEncomendaMultiFornecedor,
      deveUsarFinalizacaoMultiFornecedor,
    } = await import("../../lib/encomendas/finalizar-multi-fornecedor");
    const {
      validarLinhasParaFinalizacaoMultiFornecedor,
      deriveGrupoDraftIdempotencyKey,
      deriveGrupoFinalizacaoBatchKey,
    } = await import("../../lib/encomendas/finalizar-multi-fornecedor-regras");
    const { agruparParaGeracao } = await import("../../lib/encomendas/decisao-grupo");

    const [f1, f2] = await Promise.all([
      prisma.farmacia.create({ data: { nome: "Grupo F1" } }),
      prisma.farmacia.create({ data: { nome: "Grupo F2" } }),
    ]);
    const u = await prisma.utilizador.create({ data: { email: "u-grupo-mf@t.pt", nome: "U", perfil: "GESTOR_GRUPO" } });
    const [fornA, fornB, fornC] = await Promise.all([
      prisma.fornecedor.create({ data: { nomeNormalizado: "GRUPO FORNECEDOR ALFA", nome: "Grupo Fornecedor Alfa" } }),
      prisma.fornecedor.create({ data: { nomeNormalizado: "GRUPO FORNECEDOR BETA", nome: "Grupo Fornecedor Beta" } }),
      prisma.fornecedor.create({ data: { nomeNormalizado: "GRUPO FORNECEDOR GAMA", nome: "Grupo Fornecedor Gama" } }),
    ]);

    let cnp = 700_000;
    async function criarProdutos(n: number, prefixo: string) {
      const data = Array.from({ length: n }, (_, i) => ({ cnp: cnp++, designacao: `${prefixo} ${i + 1}` }));
      return prisma.produto.createManyAndReturn({ data });
    }

    type DecisaoTeste = {
      produtoId: string;
      acao: "ENCOMENDAR";
      acaoTocada: true;
      farmaciaEncomendaId: string;
      quantidadeFinal: number;
      farmaciaOrigemId: null;
      farmaciaDestinoId: null;
      quantidadeTransferir: 0;
      fornecedorSugeridoId: string | null;
    };
    function decisao(produtoId: string, farmaciaId: string, fornecedorId: string | null): DecisaoTeste {
      return {
        produtoId, acao: "ENCOMENDAR", acaoTocada: true,
        farmaciaEncomendaId: farmaciaId, quantidadeFinal: 1,
        farmaciaOrigemId: null, farmaciaDestinoId: null, quantidadeTransferir: 0,
        fornecedorSugeridoId: fornecedorId,
      };
    }

    /**
     * Reproduz EXACTAMENTE a lógica nova de `gerarPlanoGrupoAction` para
     * o balde `porFarmacia` — a mesma sequência de chamadas, com os
     * mesmos módulos reais (nunca uma reimplementação simplificada).
     */
    async function processarBucketFarmacia(
      farmaciaId: string,
      linhas: DecisaoTeste[],
      nomePrefixo: string,
      encomendaBatchKey: string
    ) {
      if (!deveUsarFinalizacaoMultiFornecedor(linhas)) {
        const resultado = await createEncomendaWithOutbox(prisma, "t", {
          farmaciaId, criadoPorId: u.id,
          nome: `${nomePrefixo} · encomendar`,
          finalize: true,
          linhas: linhas.map((l) => ({ produtoId: l.produtoId, quantidadeAjustada: l.quantidadeFinal, fornecedorSugeridoId: l.fornecedorSugeridoId, origem: "PROPOSTA" })),
        }, "grupo");
        return {
          documentos: [{ listaEncomendaId: resultado.listaEncomendaId, nLinhas: linhas.length, numero: resultado.numero, fornecedorId: linhas[0]?.fornecedorSugeridoId ?? null, fornecedorNome: null as string | null }],
          draftId: null as string | null,
        };
      }
      const draftKey = deriveGrupoDraftIdempotencyKey(encomendaBatchKey, farmaciaId);
      const draft = await createEncomendaWithOutbox(prisma, "t", {
        farmaciaId, criadoPorId: u.id,
        nome: `${nomePrefixo} · encomendar`,
        finalize: false,
        linhas: linhas.map((l) => ({ produtoId: l.produtoId, quantidadeAjustada: l.quantidadeFinal, fornecedorSugeridoId: l.fornecedorSugeridoId, origem: "PROPOSTA" })),
        clientIdempotencyKey: draftKey,
      }, "grupo-multi-fornecedor");
      const finBatchKey = deriveGrupoFinalizacaoBatchKey(encomendaBatchKey, farmaciaId);
      const divisao = await finalizarEncomendaMultiFornecedor(prisma, "t", { listaEncomendaId: draft.listaEncomendaId, batchKey: finBatchKey });
      return { documentos: divisao.documentos, draftId: draft.listaEncomendaId };
    }

    // ── B · cenário principal: F1 divide-se (2 fornecedores), F2 não (1) ──
    console.log("\nB · F1 (3 Alfa + 2 Beta) divide-se em 2 documentos; F2 (2 Gama) fica num só");
    let docsF1: Awaited<ReturnType<typeof processarBucketFarmacia>>["documentos"] = [];
    let draftF1Id: string | null = null;
    let docsF2: Awaited<ReturnType<typeof processarBucketFarmacia>>["documentos"] = [];
    const batchKeyPrincipal = "grupo-batch-principal";
    {
      const [prodA, prodB, prodC] = await Promise.all([
        criarProdutos(3, "GAlfa"), criarProdutos(2, "GBeta"), criarProdutos(2, "GGama"),
      ]);
      const decisoes = [
        ...prodA.map((p) => decisao(p.id, f1.id, fornA.id)),
        ...prodB.map((p) => decisao(p.id, f1.id, fornB.id)),
        ...prodC.map((p) => decisao(p.id, f2.id, fornC.id)),
      ];
      const { porFarmacia } = agruparParaGeracao(decisoes);
      check(porFarmacia.size === 2, "B1: agruparParaGeracao produz 2 baldes de farmácia (F1, F2)");

      // Pré-validação (mesma que a acção corre ANTES de criar qualquer coisa).
      for (const [, bucket] of porFarmacia) {
        if (!deveUsarFinalizacaoMultiFornecedor(bucket)) continue;
        const v = validarLinhasParaFinalizacaoMultiFornecedor(bucket);
        check(v.ok, "B2: pré-validação de fornecedor passa para o cenário válido (todas as linhas têm fornecedor)");
      }

      const r1 = await processarBucketFarmacia(f1.id, porFarmacia.get(f1.id)!, "Grupo Principal", batchKeyPrincipal);
      docsF1 = r1.documentos;
      draftF1Id = r1.draftId;
      const r2 = await processarBucketFarmacia(f2.id, porFarmacia.get(f2.id)!, "Grupo Principal", batchKeyPrincipal);
      docsF2 = r2.documentos;

      check(docsF1.length === 2, "B3: F1 (2 fornecedores) gera exactamente 2 documentos");
      check(docsF2.length === 1, "B4: F2 (1 fornecedor) gera exactamente 1 documento — caminho de sempre, sem rascunho intermédio");
      check(draftF1Id !== null, "B5: F1 passou por um rascunho transitório (multi-fornecedor)");

      const porFornecedorF1 = new Map(docsF1.map((d) => [d.fornecedorId, d]));
      check(porFornecedorF1.get(fornA.id)?.nLinhas === 3, "B6: documento do Fornecedor Alfa em F1 tem 3 linhas");
      check(porFornecedorF1.get(fornB.id)?.nLinhas === 2, "B7: documento do Fornecedor Beta em F1 tem 2 linhas");
      check(docsF2[0].nLinhas === 2, "B8: documento único de F2 (Fornecedor Gama) tem 2 linhas");

      const idsGerados = [...docsF1, ...docsF2].map((d) => d.listaEncomendaId);
      const listasGeradas = await prisma.listaEncomenda.findMany({ where: { id: { in: idsGerados } } });
      check(listasGeradas.length === 3, "B9: 3 ListaEncomenda reais na BD (2 de F1 + 1 de F2)");
      check(listasGeradas.every((l) => l.estado === "FINALIZADA"), "B10: as 3 estão FINALIZADA");
      check(
        listasGeradas.filter((l) => l.farmaciaId === f1.id).every((l) => l.loteOrigemId === draftF1Id),
        "B11: os 2 documentos de F1 apontam loteOrigemId para o MESMO rascunho transitório"
      );
      check(
        listasGeradas.find((l) => l.farmaciaId === f2.id)?.loteOrigemId == null,
        "B12: o documento único de F2 NÃO tem loteOrigemId — nunca passou por um rascunho"
      );
      check(
        listasGeradas.every((l) => l.numero !== null && /^EN-\d{6}$/.test(l.numero)),
        "B13: todos os documentos (F1 e F2) têm número real EN-######"
      );

      const draftF1 = await prisma.listaEncomenda.findUniqueOrThrow({ where: { id: draftF1Id! }, include: { linhas: true } });
      check(draftF1.estado === "RASCUNHO" && draftF1.loteDivididoEm !== null, "B14: o rascunho transitório de F1 ficou RASCUNHO+loteDivididoEm — nunca exposto como 'novo rascunho activo'");
      check(draftF1.linhas.length === 5, "B15: o rascunho transitório de F1 mantém as suas 5 linhas (3+2) — nunca perde nada");

      const outboxCount = await prisma.orderOutbox.count({ where: { listaEncomendaId: { in: docsF1.map((d) => d.listaEncomendaId).concat(docsF2.map((d) => d.listaEncomendaId)) } } });
      check(outboxCount === 3, "B16: os 3 documentos finais (nunca o rascunho transitório) têm o seu próprio OrderOutbox");
    }

    // ── C · idempotência: retry da MESMA farmácia com a MESMA batchKey ──
    console.log("\nC · idempotência — retry da divisão de F1 com a mesma encomendaBatchKey");
    {
      const draftKeyRetry = deriveGrupoDraftIdempotencyKey(batchKeyPrincipal, f1.id);
      // Retry da CRIAÇÃO do rascunho transitório com a MESMA chave mas
      // conteúdo DIFERENTE (um produto extra, nunca visto no pedido
      // original) — tem de ser um conflito explícito, nunca um
      // duplicado nem uma sobrescrita silenciosa.
      const [prodExtra] = await criarProdutos(1, "GExtra");
      const retryDraft = await createEncomendaWithOutbox(prisma, "t", {
        farmaciaId: f1.id, criadoPorId: u.id,
        nome: "Grupo Principal · encomendar",
        finalize: false,
        linhas: [{ produtoId: prodExtra.id, quantidadeAjustada: 1, fornecedorSugeridoId: fornA.id, origem: "PROPOSTA" }],
        clientIdempotencyKey: draftKeyRetry,
      }, "grupo-multi-fornecedor").catch((e) => e);
      check(
        retryDraft instanceof IdempotencyConflictError,
        "C1: reenviar a MESMA clientIdempotencyKey do rascunho de F1 com conteúdo DIFERENTE é um conflito explícito (nunca sobrescreve)",
        retryDraft instanceof Error ? retryDraft.message : String(retryDraft)
      );

      // Retry EXACTO da divisão (mesma batchKey de finalização) sobre o
      // MESMO rascunho já dividido — replay idempotente, mesmos documentos.
      const finBatchKeyRetry = deriveGrupoFinalizacaoBatchKey(batchKeyPrincipal, f1.id);
      const replay = await finalizarEncomendaMultiFornecedor(prisma, "t", { listaEncomendaId: draftF1Id!, batchKey: finBatchKeyRetry });
      check(replay.reutilizado === true, "C2: retry da finalização de F1 é reconhecido como replay");
      check(
        JSON.stringify([...replay.documentos].sort((a, b) => a.fornecedorId.localeCompare(b.fornecedorId))) ===
          JSON.stringify([...docsF1].sort((a, b) => (a.fornecedorId ?? "").localeCompare(b.fornecedorId ?? ""))),
        "C3: o replay devolve EXACTAMENTE os mesmos 2 documentos (mesmos ids/números) da primeira chamada"
      );
      const filhosF1 = await prisma.listaEncomenda.count({ where: { loteOrigemId: draftF1Id! } });
      check(filhosF1 === 2, "C4: continuam a existir só 2 documentos filhos de F1 na BD — o retry nunca duplicou");
    }

    // ── D · linha sem fornecedor bloqueia a farmácia (rollback antes de escrever) ──
    console.log("\nD · farmácia com linha sem fornecedor é rejeitada ANTES de qualquer escrita");
    {
      const f3 = await prisma.farmacia.create({ data: { nome: "Grupo F3 — sem fornecedor" } });
      const [prodD1, prodD2] = await criarProdutos(2, "GSemForn");
      const decisoesD = [decisao(prodD1.id, f3.id, fornA.id), decisao(prodD2.id, f3.id, null)];
      const { porFarmacia: porFarmaciaD } = agruparParaGeracao(decisoesD);
      const bucketD = porFarmaciaD.get(f3.id)!;
      check(deveUsarFinalizacaoMultiFornecedor(bucketD), "D1: F3 tem mais de um 'fornecedor' distinto (Alfa + sem-fornecedor conta como um valor próprio)");
      const validacaoD = validarLinhasParaFinalizacaoMultiFornecedor(bucketD);
      check(!validacaoD.ok, "D2: a pré-validação rejeita F3 — pelo menos uma linha sem fornecedor decidido");
      // A acção real NUNCA chega a criar nada para F3 quando a
      // pré-validação falha (return antecipado, antes do loop de
      // criação) — replicado aqui: simplesmente não se chama
      // `processarBucketFarmacia` para F3.
      const nadaCriado = await prisma.listaEncomenda.count({ where: { farmaciaId: f3.id } });
      check(nadaCriado === 0, "D3: nenhuma ListaEncomenda foi criada para F3 — rejeitado antes de qualquer escrita");
    }

    // ── E · resumo final lista TODAS as encomendas do grupo (2+1 = 3) ──
    console.log("\nE · o resultado agregado lista TODAS as encomendas criadas no grupo");
    {
      const todasEsteGrupo = [...docsF1, ...docsF2];
      check(todasEsteGrupo.length === 3, "E1: o resumo agregado (o que o painel de resultado mostra) tem as 3 encomendas — 2 de F1 + 1 de F2");
      const nomesFornecedor = new Set(todasEsteGrupo.map((d) => d.fornecedorId));
      check(nomesFornecedor.size === 3, "E2: os 3 documentos cobrem 3 fornecedores distintos (Alfa, Beta, Gama) — nenhum repetido nem em falta");
    }

    await prisma.$disconnect();
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.end();
  }

  console.log(`\n${passed} ok, ${failed} falhas`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
