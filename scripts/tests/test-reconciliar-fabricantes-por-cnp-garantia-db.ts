/**
 * scripts/tests/test-reconciliar-fabricantes-por-cnp-garantia-db.ts
 *
 * PostgreSQL REAL e DESCARTÁVEL — nunca uma base verdadeira (mesmo
 * padrão de scripts/tests/test-encomenda-idempotencia-db.ts).
 *
 *   docker run -d --name spharm-fab-test-pg -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:16-alpine
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:55432/postgres npx tsx scripts/tests/test-reconciliar-fabricantes-por-cnp-garantia-db.ts
 *
 * Guarda de segurança: recusa correr se o host não for localhost/127.0.0.1.
 * Cria uma base temporária (spharm_fabcnp_*) e apaga-a no fim.
 *
 * Complementa scripts/tests/test-reconciliar-fabricantes-por-cnp-garantia.ts
 * (Prisma falso): aqui o alvo é Postgres REAL — migrations desde base
 * vazia, escrita/leitura reais (Fabricante.nomeNormalizado @unique,
 * FabricanteAlias @@unique), dry-run com sessão read-only, idempotência
 * numa segunda corrida real, e a trava de tenant contra um PrismaClient
 * verdadeiro (não um stub que já sabe recusar).
 */
import Module from "node:module";
import { execSync } from "node:child_process";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

// `server-only` só existe no build do Next — stub antes de carregar os módulos de domínio.
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

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgresql://postgres:test@localhost:55432/postgres";
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

const TITULAR_REAL = "Pharmakern Portugal, Produtos Farmacêuticos, Sociedade Unipessoal Lda.";

async function main() {
  const { PrismaClient } = await import("../../generated/prisma/client");
  const { normalizarTitularAimGarantia } = await import("../../lib/catalog/fabricante-normalizacao-garantia");
  const { reconciliarFabricantesPorCnpGarantia, reconciliarFabricantesPorCnpGarantiaTransacional } = await import("../../lib/catalog/reconciliar-fabricantes-por-cnp-garantia");

  const sufixo = Date.now().toString(36);
  const dbNome = `spharm_fabcnp_${sufixo}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbNome}`);

  try {
    console.log("\nA · migrations desde base vazia");
    const out = execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(dbNome) }, encoding: "utf8" });
    check(/successfully applied|No pending migrations/i.test(out), "A1: migrations aplicadas sem erro numa base vazia");

    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(dbNome) }) });

    const normTitular = normalizarTitularAimGarantia(TITULAR_REAL)!;
    // p1: titular resolve para um Fabricante JÁ existente (nome exacto).
    const fPharmakern = await prisma.fabricante.create({ data: { nomeNormalizado: normTitular } });
    const p1 = await prisma.produto.create({ data: { cnp: 5701651, designacao: "Tadalafil Pharmakern 20 Mg 4 Comp." } });
    await prisma.regulatoryRecord.create({ data: { cnp: 5701651, titularAim: TITULAR_REAL, estadoAim: "Autorizado", source: "test" } });

    // p2: catalogável, SEM RegulatoryRecord, sem origem — deve ficar sem fonte, nunca inventado.
    const p2 = await prisma.produto.create({ data: { cnp: 8000001, designacao: "Produto Sem Registo" } });

    // p3: titular SEM Fabricante correspondente — deve criar um novo.
    const NOVO_TITULAR = "Nova Farmaceutica Real Unipessoal Lda";
    const p3 = await prisma.produto.create({ data: { cnp: 6000001, designacao: "Produto Titular Novo" } });
    await prisma.regulatoryRecord.create({ data: { cnp: 6000001, titularAim: NOVO_TITULAR, estadoAim: "Ativo", source: "test" } });

    console.log("\nB · dry-run — zero escritas reais em Postgres");
    {
      const r = await reconciliarFabricantesPorCnpGarantia(prisma, "garantia", { tipo: "todos", dryRun: true });
      // resolvidosPorNomeNormalizado conta AMBOS p1 (nome exacto já existente) e
      // p3 (resolvido_criar_novo — sem plano curado, cai na mesma categoria).
      check(r.resolvidosPorNomeNormalizado === 2, "B1: p1 + p3 resolvidos por nome normalizado (relatório)", JSON.stringify(r));
      check(r.fabricantesCriados === 1, "B2: relatório mostra 1 fabricante que SERIA criado (p3)");
      check(r.semFonte.SEM_REGISTO_CATALOGO === 1, "B3: p2 sem fonte (SEM_REGISTO_CATALOGO)");

      const [p1Db, p3Db, fabricantesDb] = await Promise.all([
        prisma.produto.findUnique({ where: { id: p1.id }, select: { fabricanteId: true } }),
        prisma.produto.findUnique({ where: { id: p3.id }, select: { fabricanteId: true } }),
        prisma.fabricante.findMany(),
      ]);
      check(p1Db?.fabricanteId === null, "B4: p1.fabricanteId continua NULL em Postgres — dry-run não escreveu");
      check(p3Db?.fabricanteId === null, "B5: p3.fabricanteId continua NULL em Postgres");
      check(fabricantesDb.length === 1, "B6: continua a existir exactamente 1 Fabricante real (fPharmakern) — nenhum criado", `${fabricantesDb.length}`);
    }

    console.log("\nC · trava de tenant contra um PrismaClient REAL — recusa antes de qualquer query");
    {
      let mensagem = "";
      try {
        await reconciliarFabricantesPorCnpGarantia(prisma, "silveira", { tipo: "todos" });
      } catch (err) {
        mensagem = err instanceof Error ? err.message : String(err);
      }
      check(mensagem.includes("garantia"), "C1: recusado com mensagem mencionando garantia", mensagem);
      const p1Db = await prisma.produto.findUnique({ where: { id: p1.id }, select: { fabricanteId: true } });
      check(p1Db?.fabricanteId === null, "C2: p1 continua intocado depois da tentativa recusada");
    }

    console.log("\nD · corrida real (apply) — resolve, cria fabricante novo quando preciso, nunca inventa sem fonte");
    {
      const r = await reconciliarFabricantesPorCnpGarantia(prisma, "garantia", { tipo: "todos" });
      eqLog(r);

      const [p1Db, p2Db, p3Db, fabricantesDb] = await Promise.all([
        prisma.produto.findUnique({ where: { id: p1.id }, select: { fabricanteId: true } }),
        prisma.produto.findUnique({ where: { id: p2.id }, select: { fabricanteId: true } }),
        prisma.produto.findUnique({ where: { id: p3.id }, select: { fabricanteId: true } }),
        prisma.fabricante.findMany(),
      ]);
      check(p1Db?.fabricanteId === fPharmakern.id, "D1: p1.fabricanteId gravado com o Fabricante Pharmakern EXISTENTE");
      check(p2Db?.fabricanteId === null, "D2: p2 continua sem fabricante — sem fonte, nunca inventado");
      check(p3Db?.fabricanteId !== null && p3Db?.fabricanteId !== fPharmakern.id, "D3: p3.fabricanteId gravado com um Fabricante NOVO, distinto do Pharmakern");
      check(fabricantesDb.length === 2, "D4: exactamente 2 Fabricante reais agora (Pharmakern + o novo) — nenhum duplicado", `${fabricantesDb.length}`);
      const novo = fabricantesDb.find((f) => f.id === p3Db?.fabricanteId);
      check(novo?.nomeNormalizado === normalizarTitularAimGarantia(NOVO_TITULAR), "D5: o nome do Fabricante novo é o titular normalizado (nunca truncado/alterado)");
    }

    console.log("\nE · segunda corrida real consecutiva — zero escritas (idempotência)");
    {
      const antes = await prisma.fabricante.findMany();
      const r2 = await reconciliarFabricantesPorCnpGarantia(prisma, "garantia", { tipo: "todos" });
      check(r2.fabricantesCriados === 0, "E1: zero fabricantes criados na segunda corrida");
      // { tipo: "todos" } só lê produtos com fabricanteId NULL — p1 e p3
      // (já resolvidos) nem entram na selecção; só p2 é reanalisado.
      check(r2.analisados === 1 && r2.jaTinhaFabricante === 0, "E2: p1/p3 nem são reanalisados (já fora do WHERE fabricanteId:null); só p2 (ainda sem fabricante)", JSON.stringify(r2));
      const depois = await prisma.fabricante.findMany();
      check(depois.length === antes.length, "E3: nenhum Fabricante novo criado — mesma contagem antes/depois");
    }

    // ── A partir daqui: modo TRANSACIONAL (CLI de backfill), sempre com
    // produtos NOVOS (p1/p2/p3 já ficaram resolvidos acima) ────────────

    console.log("\nF · modo transacional — trava de tenant contra Postgres REAL, nunca abre transacção");
    {
      const antes = await prisma.fabricante.count();
      let mensagem = "";
      try {
        await reconciliarFabricantesPorCnpGarantiaTransacional(prisma, "silveira", { tipo: "todos" });
      } catch (err) {
        mensagem = err instanceof Error ? err.message : String(err);
      }
      check(mensagem.includes("garantia"), "F1: recusado com mensagem mencionando garantia", mensagem);
      const depois = await prisma.fabricante.count();
      check(depois === antes, "F2: zero Fabricante criado — nem chegou a abrir transacção");
    }

    console.log("\nG · modo transacional — dry-run contra Postgres REAL: zero escritas");
    {
      const pDry = await prisma.produto.create({ data: { cnp: 6100001, designacao: "Produto Dry-Run Transacional" } });
      await prisma.regulatoryRecord.create({ data: { cnp: 6100001, titularAim: "Zenta Dry Run Transacional Lda", estadoAim: "Autorizado", source: "test" } });

      const antesFab = await prisma.fabricante.count();
      const r = await reconciliarFabricantesPorCnpGarantiaTransacional(prisma, "garantia", { tipo: "produtos", produtoIds: [pDry.id], dryRun: true });
      check(r.fabricantesCriados === 1, "G1: relatório do dry-run mostra 1 fabricante que SERIA criado");
      const depoisFab = await prisma.fabricante.count();
      check(depoisFab === antesFab, "G2: zero Fabricante real criado");
      const pDryDb = await prisma.produto.findUnique({ where: { id: pDry.id }, select: { fabricanteId: true } });
      check(pDryDb?.fabricanteId === null, "G3: Produto.fabricanteId continua NULL");

      // Resolve pDry PARA VALER (fora do dry-run) — sem isto, ficaria por
      // resolver e o bloco J (idempotência de { tipo: "todos" }) veria um
      // produto novo genuinamente resolúvel, o que não é o que J quer medir.
      await reconciliarFabricantesPorCnpGarantiaTransacional(prisma, "garantia", { tipo: "produtos", produtoIds: [pDry.id] });
    }

    console.log("\nH · modo transacional — apply real: cria fabricante novo + alias (plano curado) numa ÚNICA transacção");
    {
      // Marca "Zorion..." em vez de "Fabricante..." de propósito: o
      // ficheiro tem VÁRIOS blocos síncronos na MESMA base contínua e
      // "Fabricante" como primeiro token colidiria com outra fixture
      // deste ficheiro (ex.: bloco G) na regra 4-bis (correspondência
      // textual, porta do primeiro token) — descoberto por um FALHA real
      // deste próprio teste ao introduzir essa regra.
      const canonico = "Zorion Canonico Via Plano Lda";
      const origem = "Zorion Nome Antigo Via Plano Lda";
      const mapeamentoCurado = new Map([[normalizarTitularAimGarantia(origem)!, normalizarTitularAimGarantia(canonico)!]]);

      const pCanonico = await prisma.produto.create({ data: { cnp: 6200001, designacao: "Produto Canonico Plano" } });
      await prisma.regulatoryRecord.create({ data: { cnp: 6200001, titularAim: canonico, estadoAim: "Autorizado", source: "test" } });
      const pAlias = await prisma.produto.create({ data: { cnp: 6200002, designacao: "Produto Alias Plano" } });
      await prisma.regulatoryRecord.create({ data: { cnp: 6200002, titularAim: origem, estadoAim: "Ativo", source: "test" } });

      const r = await reconciliarFabricantesPorCnpGarantiaTransacional(prisma, "garantia", {
        tipo: "produtos",
        produtoIds: [pCanonico.id, pAlias.id],
        mapeamentoCurado,
      });
      check(r.fabricantesCriados === 1, "H1: 1 fabricante novo criado (o canónico, a partir de pCanonico)");
      check(r.aliasesCriados === 1, "H2: 1 alias criado (o nome antigo, a partir de pAlias)", JSON.stringify(r));

      const [pCanonicoDb, pAliasDb] = await Promise.all([
        prisma.produto.findUnique({ where: { id: pCanonico.id }, select: { fabricanteId: true } }),
        prisma.produto.findUnique({ where: { id: pAlias.id }, select: { fabricanteId: true } }),
      ]);
      check(pCanonicoDb?.fabricanteId !== null && pCanonicoDb?.fabricanteId === pAliasDb?.fabricanteId, "H3: os dois produtos apontam para o MESMO Fabricante (o canónico criado por pCanonico, reutilizado por pAlias via o alias)");

      const fabricanteCriado = await prisma.fabricante.findUnique({ where: { id: pCanonicoDb!.fabricanteId! }, include: { aliases: true } });
      check(fabricanteCriado?.nomeNormalizado === normalizarTitularAimGarantia(canonico), "H4: o Fabricante criado tem o nome canónico (nunca o nome antigo)");
      check(fabricanteCriado?.aliases.some((a) => a.aliasNome === normalizarTitularAimGarantia(origem)) ?? false, "H5: o FabricanteAlias persistido é o nome ANTIGO normalizado", JSON.stringify(fabricanteCriado?.aliases));
    }

    console.log("\nI · modo transacional — FALHA A MEIO (timeout forçado) força ROLLBACK INTEGRAL em Postgres REAL");
    {
      // 8 produtos, cada um com um titular DISTINTO (força 8 fabricante.create
      // + 8 produto.update reais — 16 round-trips sequenciais dentro da MESMA
      // transacção). Um timeoutMs absurdamente curto garante que a transacção
      // é abortada a meio — depois de pelo menos uma escrita real já ter
      // acontecido — e o Postgres reverte TUDO, nunca um subconjunto.
      const produtosRollback: { id: string; cnp: number }[] = [];
      for (let i = 0; i < 8; i++) {
        const cnp = 6300001 + i;
        const titular = `Fabricante Rollback Forcado Numero ${i} Lda`;
        const p = await prisma.produto.create({ data: { cnp, designacao: `Produto Rollback ${i}` } });
        await prisma.regulatoryRecord.create({ data: { cnp, titularAim: titular, estadoAim: "Autorizado", source: "test" } });
        produtosRollback.push({ id: p.id, cnp });
      }

      const fabricantesAntes = await prisma.fabricante.count();
      let mensagem = "";
      let falhou = false;
      try {
        await reconciliarFabricantesPorCnpGarantiaTransacional(prisma, "garantia", {
          tipo: "produtos",
          produtoIds: produtosRollback.map((p) => p.id),
          timeoutMs: 5,
          maxWaitMs: 5000,
        });
      } catch (err) {
        falhou = true;
        mensagem = err instanceof Error ? err.message : String(err);
      }
      check(falhou, "I1: a corrida com timeout absurdamente curto FALHOU (não devolveu sucesso silencioso)", mensagem);

      const fabricantesDepois = await prisma.fabricante.count();
      check(fabricantesDepois === fabricantesAntes, "I2: zero Fabricante novo persistido — mesma contagem antes/depois do rollback", `antes=${fabricantesAntes} depois=${fabricantesDepois}`);

      const produtosDb = await prisma.produto.findMany({ where: { id: { in: produtosRollback.map((p) => p.id) } }, select: { id: true, fabricanteId: true } });
      check(produtosDb.every((p) => p.fabricanteId === null), "I3: os 8 produtos continuam TODOS com fabricanteId NULL — nenhum ficou parcialmente resolvido", JSON.stringify(produtosDb));

      // Terceira confirmação, independente: reconciliar de novo (sem timeout
      // apertado) resolve os 8 do zero — prova que o estado da base é
      // exactamente o de antes da tentativa, não um estado corrompido.
      const rDepois = await reconciliarFabricantesPorCnpGarantiaTransacional(prisma, "garantia", { tipo: "produtos", produtoIds: produtosRollback.map((p) => p.id) });
      check(rDepois.fabricantesCriados === 8, "I4: uma corrida normal a seguir resolve os 8 do zero — a base não ficou num estado intermédio", JSON.stringify(rDepois));
    }

    console.log("\nJ · modo transacional — segunda corrida consecutiva é idempotente (zero escritas)");
    {
      const antes = await prisma.fabricante.count();
      const r = await reconciliarFabricantesPorCnpGarantiaTransacional(prisma, "garantia", { tipo: "todos" });
      check(r.fabricantesCriados === 0, "J1: zero fabricantes criados — tudo já resolvido pelas corridas anteriores");
      const depois = await prisma.fabricante.count();
      check(depois === antes, "J2: mesma contagem de Fabricante antes/depois");
    }

    console.log("\nK · resolução canónica GERAL contra Postgres REAL — regra 4 (prefixo), cenário sintético isolado");
    {
      // Cenário sintético (não o texto exacto do Pharmakern real — ver
      // bloco M para esse, que usa o texto exacto do crawl INFOMED e
      // resolve pela regra 5, não pela 4: o texto real tem um hífen que
      // sobrevive à normalização e quebra o prefixo armazenado
      // historicamente sem ele — achado genuíno desta bateria de
      // testes, documentado no relatório final da tarefa).
      const alvo = "Empresa Exemplo Prefixo Postgres Sociedade Unipessoal Lda";
      const curto = await prisma.fabricante.create({ data: { nomeNormalizado: "EMPRESA EXEMPLO PREFIXO" } });
      const longo = await prisma.fabricante.create({ data: { nomeNormalizado: "EMPRESA EXEMPLO PREFIXO POSTGRES" } });
      const pPrefixo = await prisma.produto.create({ data: { cnp: 5701801, designacao: "Produto Prefixo Postgres" } });
      await prisma.regulatoryRecord.create({ data: { cnp: 5701801, titularAim: alvo, estadoAim: "Autorizado", source: "test" } });

      const rPrefixo = await reconciliarFabricantesPorCnpGarantiaTransacional(prisma, "garantia", { tipo: "produtos", produtoIds: [pPrefixo.id] });
      check(rPrefixo.resolvidosPorPrefixo === 1, "K1: resolvido pela regra geral de prefixo contra Postgres REAL (fabricantesTodos + query real)", JSON.stringify(rPrefixo));
      const pPrefixoDb = await prisma.produto.findUnique({ where: { id: pPrefixo.id }, select: { fabricanteId: true } });
      check(pPrefixoDb?.fabricanteId === longo.id && pPrefixoDb.fabricanteId !== curto.id, "K2: associado ao prefixo MAIS LONGO (nunca ao curto, nunca um terceiro)");
      const totalFabricantesK = await prisma.fabricante.count({ where: { nomeNormalizado: { contains: "EMPRESA EXEMPLO PREFIXO" } } });
      check(totalFabricantesK === 2, "K3: continuam a existir só os 2 Fabricante que já existiam — nenhum a mais");
    }

    console.log("\nL · caso REAL Pharmakern com o TEXTO EXACTO do crawl INFOMED — a regra 4-bis (correspondência textual) resolve directamente, sem precisar de evidência de portefólio");
    {
      // Texto EXACTO devolvido pelo INFOMED real (scripts/data/infomed-
      // listagem-details.json, medId 603905) para CNP 5701651/5768510 —
      // note o HÍFEN depois de "Portugal", que `normalizarTitularAimGarantia`
      // preserva (é um carácter válido em denominações sociais). Esse
      // hífen sobrevive à normalização e QUEBRA o prefixo por CARACTERES
      // contra "PHARMAKERN PORTUGAL PRODUTOS FARMACEUTICOS SOCIE" (o nome
      // truncado real, sem hífen) — a regra 4 NÃO dispara aqui.
      //
      // Antes da regra 4-bis (correspondência textual aproximada por
      // TOKENS, ver bloqueador real "Ferring/Labialfarma") existir, era a
      // regra 5 (evidência de portefólio) que resolvia este caso — e só
      // porque OUTROS produtos Pharmakern já resolvidos existiam. A regra
      // 4-bis trata o hífen como um SEPARADOR de token (não como parte da
      // palavra), por isso agora resolve DIRECTAMENTE pelo nome do
      // Fabricante, mesmo sem nenhuma evidência de portefólio — mais
      // forte e mais geral. Os 2 produtos "já resolvidos" abaixo ficam
      // como prova de que a evidência CONTINUARIA a resolver isto na
      // mesma (ver a asserção L2b), não como o único caminho.
      const titularInfomedReal = "Pharmakern Portugal - Produtos Farmacêuticos, Sociedade Unipessoal, Lda.";
      const truncadoReal = await prisma.fabricante.create({ data: { nomeNormalizado: "PHARMAKERN PORTUGAL PRODUTOS FARMACEUTICOS SOCIE" } });
      const pJaResolvido1 = await prisma.produto.create({ data: { cnp: 5768510, designacao: "Tadalafil Pharmakern 20 Mg 12 Comp.", fabricanteId: truncadoReal.id } });
      const pJaResolvido2 = await prisma.produto.create({ data: { cnp: 5768511, designacao: "Tadalafil Pharmakern 20 Mg 30 Comp.", fabricanteId: truncadoReal.id } });
      for (const p of [pJaResolvido1, pJaResolvido2]) {
        await prisma.regulatoryRecord.create({ data: { cnp: p.cnp, titularAim: titularInfomedReal, estadoAim: "Autorizado", source: "test" } });
      }
      const pNovoReal = await prisma.produto.create({ data: { cnp: 5701802, designacao: "Tadalafil Pharmakern 20 Mg 4 Comp." } });
      await prisma.regulatoryRecord.create({ data: { cnp: 5701802, titularAim: titularInfomedReal, estadoAim: "Autorizado", source: "test" } });

      const r = await reconciliarFabricantesPorCnpGarantiaTransacional(prisma, "garantia", { tipo: "produtos", produtoIds: [pNovoReal.id] });
      check(r.resolvidosPorPrefixo === 0, "L1: a regra de prefixo NÃO dispara com o texto exacto real (o hífen quebra a igualdade de caracteres)", JSON.stringify(r));
      check(r.resolvidosPorCorrespondenciaTextual === 1, "L2: a regra 4-bis (correspondência textual, hífen tratado como separador de token) resolve directamente pelo nome do Fabricante — já não precisa da evidência de portefólio para este caso real", JSON.stringify(r));
      const pNovoRealDb = await prisma.produto.findUnique({ where: { id: pNovoReal.id }, select: { fabricanteId: true } });
      check(pNovoRealDb?.fabricanteId === truncadoReal.id, "L3: associado ao MESMO Fabricante truncado real — nunca um terceiro Pharmakern");
    }

    console.log("\nM · resolução canónica GERAL contra Postgres REAL — regra 5 (evidência de portefólio) isolada, sem nenhum prefixo válido");
    {
      const titularSemPrefixo = "Entidade Legal Sem Nenhum Prefixo Existente Sociedade Unipessoal Lda";
      const fA = await prisma.fabricante.create({ data: { nomeNormalizado: "CANDIDATO A NAO RELACIONADO LDA" } });
      const fB = await prisma.fabricante.create({ data: { nomeNormalizado: "CANDIDATO B NAO RELACIONADO LDA" } });

      // 2 produtos JÁ resolvidos para fA, 1 para fB — todos com o MESMO titularAim.
      const pJa1 = await prisma.produto.create({ data: { cnp: 5701701, designacao: "Produto Ja Resolvido 1", fabricanteId: fA.id } });
      const pJa2 = await prisma.produto.create({ data: { cnp: 5701702, designacao: "Produto Ja Resolvido 2", fabricanteId: fA.id } });
      const pJa3 = await prisma.produto.create({ data: { cnp: 5701703, designacao: "Produto Ja Resolvido 3", fabricanteId: fB.id } });
      const pNovo = await prisma.produto.create({ data: { cnp: 5701704, designacao: "Produto A Resolver Agora" } });
      for (const p of [pJa1, pJa2, pJa3, pNovo]) {
        await prisma.regulatoryRecord.create({ data: { cnp: p.cnp, titularAim: titularSemPrefixo, estadoAim: "Autorizado", source: "test" } });
      }

      const r = await reconciliarFabricantesPorCnpGarantiaTransacional(prisma, "garantia", { tipo: "produtos", produtoIds: [pNovo.id] });
      check(r.resolvidosPorEvidenciaPortfolio === 1, "M1: resolvido por evidência de portefólio, contra a query REAL (RegulatoryRecord + Produto agregados em Postgres)", JSON.stringify(r));
      const pNovoDb = await prisma.produto.findUnique({ where: { id: pNovo.id }, select: { fabricanteId: true } });
      check(pNovoDb?.fabricanteId === fA.id, "M2: associado ao Fabricante com MAIS produtos na evidência real (2 vs 1) — nunca ao minoritário, nunca cria um novo");
    }

    console.log("\nN · bloqueador 1 (prova real pedida) — 218 produtos Pharmakern com o MESMO alias a criar: EXACTAMENTE 1 FabricanteAlias em Postgres REAL, sem conflito de unicidade, segunda corrida com ZERO escritas");
    {
      const canonico = "Pharmakern Antigo Registo Teste Escala Sociedade Unipessoal Lda";
      const origem = "Pharmakern Antigo Registo Lda";
      const mapeamentoCurado = new Map([[normalizarTitularAimGarantia(origem)!, normalizarTitularAimGarantia(canonico)!]]);
      const N = 218;

      const produtosPharmakern: { id: string; cnp: number }[] = [];
      for (let i = 0; i < N; i++) {
        const cnp = 6400001 + i;
        const p = await prisma.produto.create({ data: { cnp, designacao: `Pharmakern Produto ${i}` } });
        await prisma.regulatoryRecord.create({ data: { cnp, titularAim: origem, estadoAim: "Autorizado", source: "test" } });
        produtosPharmakern.push({ id: p.id, cnp });
      }

      const r = await reconciliarFabricantesPorCnpGarantiaTransacional(prisma, "garantia", {
        tipo: "produtos",
        produtoIds: produtosPharmakern.map((p) => p.id),
        mapeamentoCurado,
      });
      check(r.fabricantesCriados === 1, "N1: 1 único Fabricante criado para os 218 produtos, nunca 218", JSON.stringify({ fabricantesCriados: r.fabricantesCriados }));
      check(r.aliasesCriados === 1, "N2: relatório mostra 1 alias único, nunca 218 (a contagem inflacionada do bloqueador 1)", JSON.stringify({ aliasesCriados: r.aliasesCriados }));
      check(r.aliasesCriadosDetalhe.length === 1 && r.aliasesCriadosDetalhe[0]?.produtosResolvidos === N, "N3: a entrada única de aliasesCriadosDetalhe diz que 218 produtos resolveram através dela", JSON.stringify(r.aliasesCriadosDetalhe));

      const nomeCanonicoNorm = normalizarTitularAimGarantia(canonico)!;
      const fabricanteReal = await prisma.fabricante.findUnique({ where: { nomeNormalizado: nomeCanonicoNorm }, include: { aliases: true } });
      check(!!fabricanteReal, "N4: o Fabricante canónico existe de facto em Postgres");
      check(fabricanteReal?.aliases.length === 1, "N5: EXACTAMENTE 1 FabricanteAlias real persistido — nunca 218, e o índice @unique nunca rejeitou uma segunda tentativa porque nunca houve uma segunda tentativa de escrita", JSON.stringify(fabricanteReal?.aliases));

      const todosOsProdutosDb = await prisma.produto.findMany({ where: { id: { in: produtosPharmakern.map((p) => p.id) } }, select: { fabricanteId: true } });
      check(todosOsProdutosDb.every((p) => p.fabricanteId === fabricanteReal!.id), "N6: os 218 produtos apontam TODOS para o MESMO Fabricante real", `distintos=${new Set(todosOsProdutosDb.map((p) => p.fabricanteId)).size}`);

      const rSegunda = await reconciliarFabricantesPorCnpGarantiaTransacional(prisma, "garantia", {
        tipo: "produtos",
        produtoIds: produtosPharmakern.map((p) => p.id),
        mapeamentoCurado,
      });
      // {tipo:"produtos"} sempre relê os IDs pedidos (ao contrário de
      // {tipo:"todos"}, que filtra fabricanteId:null na própria query) —
      // por isso `analisados` continua a contar os 218, mas todos caem em
      // `ja_tem_fabricante` (nível 1 do resolver) antes de qualquer
      // escrita ser considerada.
      check(rSegunda.analisados === N, "N7: segunda corrida — os 218 continuam a ser lidos (âmbito produtoIds), mas todos já têm fabricante", JSON.stringify({ analisados: rSegunda.analisados, jaTinhaFabricante: rSegunda.jaTinhaFabricante }));
      check(rSegunda.jaTinhaFabricante === N, "N7b: os 218 são intercetados no nível 1 do resolver — nenhum reprocessado");
      check(rSegunda.fabricantesCriados === 0 && rSegunda.aliasesCriados === 0, "N8: segunda corrida — zero fabricantes/aliases novos");
      const fabricanteDepois = await prisma.fabricante.findUnique({ where: { nomeNormalizado: nomeCanonicoNorm }, include: { aliases: true } });
      check(fabricanteDepois?.aliases.length === 1, "N9: continua a existir EXACTAMENTE 1 FabricanteAlias depois da segunda corrida — zero duplicados");
    }

    console.log("\nO · bloqueador 3 (padrão Labialfarma, sintético e deliberadamente SEM relação textual com a Labialfarma real de R abaixo) contra Postgres REAL — empate de evidência NUNCA bloqueia a criação do fabricante legal explícito");
    {
      // Marca "Vintera" (sintética, sem nenhuma relação com "Labialfarma")
      // de propósito — este ficheiro tem VÁRIOS blocos na MESMA base
      // contínua, e reutilizar a palavra "Labialfarma" aqui colidiria com
      // o bloco R (REGRESSÃO Labialfarma real) via a regra 4-bis (o
      // Fabricante aqui criado passaria a ser candidato forte para o
      // titular real de R) — descoberto por uma FALHA real deste próprio
      // teste ao introduzir essa regra.
      const fA = await prisma.fabricante.create({ data: { nomeNormalizado: "CANDIDATO EVIDENCIA A TESTE REAL LDA" } });
      const fB = await prisma.fabricante.create({ data: { nomeNormalizado: "CANDIDATO EVIDENCIA B TESTE REAL LDA" } });
      const titularSintetico = "Vintera Laboratorio De Produtos Farmaceuticos E Nutraceuticos S A Teste Real";

      const pJa1 = await prisma.produto.create({ data: { cnp: 6500001, designacao: "Vintera Ja 1", fabricanteId: fA.id } });
      const pJa2 = await prisma.produto.create({ data: { cnp: 6500002, designacao: "Vintera Ja 2", fabricanteId: fB.id } });
      const pNovo = await prisma.produto.create({ data: { cnp: 6500003, designacao: "Vintera Novo", tipoArtigo: "MEDICAMENTO" } });
      for (const p of [pJa1, pJa2, pNovo]) {
        await prisma.regulatoryRecord.create({ data: { cnp: p.cnp, titularAim: titularSintetico, estadoAim: "Autorizado", source: "test" } });
      }

      const r = await reconciliarFabricantesPorCnpGarantiaTransacional(prisma, "garantia", { tipo: "produtos", produtoIds: [pNovo.id] });
      check(r.ambiguidades === 0, "O1: zero ambiguidades — o empate de evidência (fA vs fB) não bloqueia contra Postgres real", JSON.stringify(r.ambiguidadesDetalhe));
      check(r.fabricantesCriados === 1, "O2: cria o fabricante legal do titular", JSON.stringify({ fabricantesCriados: r.fabricantesCriados }));
      check(r.avisosEvidenciaEmpatada.length === 1 && r.avisosEvidenciaEmpatada[0]?.cnp === 6500003, "O3: o empate fica registado como aviso com o CNP real, não como bloqueio", JSON.stringify(r.avisosEvidenciaEmpatada));

      const pNovoDb = await prisma.produto.findUnique({ where: { id: pNovo.id }, select: { fabricanteId: true } });
      const fabricanteCriado = await prisma.fabricante.findUnique({ where: { id: pNovoDb!.fabricanteId! } });
      check(fabricanteCriado?.nomeNormalizado === normalizarTitularAimGarantia(titularSintetico), "O4: o Fabricante criado é o titular do padrão, nem fA nem fB", fabricanteCriado?.nomeNormalizado);
    }

    console.log("\nP · bloqueador 6/7 contra Postgres REAL — origem/ERP divergente entre farmácias nunca é escolhida arbitrariamente, mesmo com múltiplas linhas ProdutoFarmacia reais");
    {
      const p1 = await prisma.produto.create({ data: { cnp: 1600001, designacao: "Produto CNP Interno Divergente" } });
      const farmaciaA = await prisma.farmacia.create({ data: { nome: "Farmacia Teste A" } });
      const farmaciaB = await prisma.farmacia.create({ data: { nome: "Farmacia Teste B" } });
      await prisma.produtoFarmacia.create({ data: { produtoId: p1.id, farmaciaId: farmaciaA.id, fabricanteErpAtual: "Fabricante Divergente Um Lda" } });
      await prisma.produtoFarmacia.create({ data: { produtoId: p1.id, farmaciaId: farmaciaB.id, fabricanteErpAtual: "Fabricante Divergente Dois Lda" } });

      const r = await reconciliarFabricantesPorCnpGarantiaTransacional(prisma, "garantia", { tipo: "produtos", produtoIds: [p1.id] });
      check(r.semFonte.FABRICANTE_DIVERGENTE_ENTRE_FARMACIAS === 1, "P1: motivo explícito de divergência contra Postgres real, nunca escolhe uma das duas farmácias arbitrariamente", JSON.stringify(r.semFonte));
      const p1Db = await prisma.produto.findUnique({ where: { id: p1.id }, select: { fabricanteId: true } });
      check(p1Db?.fabricanteId === null, "P2: fabricanteId continua null");
    }

    console.log("\nQ · regra 4-bis (correspondência textual) contra Postgres REAL — REGRESSÃO Ferring (6 linhas reais): nenhuma linha nova quando existe canonical compatível");
    {
      const nomes = {
        pharmA: normalizarTitularAimGarantia("FERRING PHARMACEUTICALS A S")!,
        // Nota real: "FERRING PORTUG - P F SOC UN" (0 produtos, id
        // cmu6b9xfs09as01qmz3ud4ez1) e "FERRING PORTUG. - P.F. SOC. UN"
        // (5 produtos) coexistem na Garantia como DUAS linhas Fabricante
        // DISTINTAS — só possível porque, historicamente, cada uma foi
        // gravada por um caminho de normalização diferente (ver
        // lib/catalog-normalizers.ts vs. fabricante-normalizacao-
        // garantia.ts). Aplicando `normalizarTitularAimGarantia` às DUAS
        // aqui (a única normalização que este teste tem disponível), os
        // pontos viram espaço e as duas colapsam na MESMA string — por
        // isso o teste omite deliberadamente a variante de 0 produtos
        // (sem valor informativo para a decisão) em vez de replicar uma
        // colisão @unique que não reflectiria a causa real.
        portug2: normalizarTitularAimGarantia("FERRING PORTUG. - P.F. SOC. UN")!,
        portugCompleto: normalizarTitularAimGarantia("FERRING PORTUGUESA - PRODUTOS FARMACEUTICOS SOCIE")!,
        // "FERRING S A U" (0 produtos) colapsaria na MESMA string que
        // "FERRING S.A.U." pela mesma razão — omitido pelo mesmo motivo.
        sau2: normalizarTitularAimGarantia("FERRING S.A.U.")!,
      };
      const fPharmA = await prisma.fabricante.create({ data: { nomeNormalizado: nomes.pharmA } });
      const fPortug2 = await prisma.fabricante.create({ data: { nomeNormalizado: nomes.portug2 } });
      const fPortugCompleto = await prisma.fabricante.create({ data: { nomeNormalizado: nomes.portugCompleto } });
      const fSAU2 = await prisma.fabricante.create({ data: { nomeNormalizado: nomes.sau2 } });

      // Evidência real: fPortug2 com 5 produtos, fSAU2 com 6, fPortugCompleto com 1.
      const criarProdutosPara = async (fabricanteId: string, cnpInicial: number, n: number) => {
        for (let i = 0; i < n; i++) await prisma.produto.create({ data: { cnp: cnpInicial + i, designacao: `Ferring existente ${cnpInicial + i}`, fabricanteId } });
      };
      await criarProdutosPara(fPharmA.id, 6600001, 1);
      await criarProdutosPara(fPortug2.id, 6600010, 5);
      await criarProdutosPara(fPortugCompleto.id, 6600020, 1);
      await criarProdutosPara(fSAU2.id, 6600030, 6);

      const fabricantesAntes = await prisma.fabricante.count();
      const pNovo = await prisma.produto.create({ data: { cnp: 6600099, designacao: "Ferring produto novo real" } });
      await prisma.regulatoryRecord.create({ data: { cnp: 6600099, titularAim: "Ferring Portuguesa-Prod Farm, Soc.Unipessoal L.da", estadoAim: "Ativo", source: "test" } });

      const r = await reconciliarFabricantesPorCnpGarantiaTransacional(prisma, "garantia", { tipo: "produtos", produtoIds: [pNovo.id] });
      check(r.resolvidosPorCorrespondenciaTextual === 1, "Q1: resolvido pela regra 4-bis contra Postgres real, agregando _count.produtos real", JSON.stringify({ resolvidosPorCorrespondenciaTextual: r.resolvidosPorCorrespondenciaTextual }));
      const fabricantesDepois = await prisma.fabricante.count();
      check(fabricantesDepois === fabricantesAntes, "Q2: ZERO Fabricante novo — nenhuma sétima linha Ferring criada", `antes=${fabricantesAntes} depois=${fabricantesDepois}`);
      const pNovoDb = await prisma.produto.findUnique({ where: { id: pNovo.id }, select: { fabricanteId: true } });
      check(pNovoDb?.fabricanteId === fPortug2.id, "Q3: associado à variante portuguesa com MAIS evidência REAL (5 produtos) — nunca à dinamarquesa nem à espanhola, nunca escolhido pelo primeiro resultado", pNovoDb?.fabricanteId ?? "null");

      const rSegunda = await reconciliarFabricantesPorCnpGarantiaTransacional(prisma, "garantia", { tipo: "produtos", produtoIds: [pNovo.id] });
      check(rSegunda.jaTinhaFabricante === 1 && rSegunda.fabricantesCriados === 0, "Q4: segunda execução — zero escritas, intercetado no nível 1 do resolver (idempotência real)", JSON.stringify(rSegunda));
      const fabricantesFinal = await prisma.fabricante.count();
      check(fabricantesFinal === fabricantesAntes, "Q5: contagem de Fabricante continua igual depois da segunda execução");
    }

    console.log("\nR · regra 4-bis contra Postgres REAL — REGRESSÃO Labialfarma (2 linhas reais): nenhuma duplicação sem decisão explícita");
    {
      // "LABIALFARMA-PROD FARM NUT LDA" (0 produtos, id
      // cmu6em2iv8s2201qmhtwwkmk3) e "LABIALFARMA-PROD FARM. NUT LDA" (1
      // produto) colapsariam na MESMA string ao aplicar
      // `normalizarTitularAimGarantia` (o ponto depois de "FARM" vira
      // espaço) — mesma nota da Ferring (Q, acima): coexistem na
      // Garantia por terem sido gravadas por caminhos de normalização
      // diferentes; aqui mantém-se só a variante com 1 produto real.
      const nomes = { l2: normalizarTitularAimGarantia("LABIALFARMA-PROD FARM. NUT LDA")! };
      const fLabial2 = await prisma.fabricante.create({ data: { nomeNormalizado: nomes.l2 } });
      await prisma.produto.create({ data: { cnp: 6600200, designacao: "Labialfarma existente", fabricanteId: fLabial2.id } });

      const fabricantesAntes = await prisma.fabricante.count();
      const pNovo = await prisma.produto.create({ data: { cnp: 6600299, designacao: "Labialfarma produto novo real" } });
      await prisma.regulatoryRecord.create({ data: { cnp: 6600299, titularAim: "LABIALFARMA - LABORATORIO DE PRODUTOS FARMACEUTICOS E NUTRACEUTICOS SA", estadoAim: "Ativo", source: "test" } });

      const r = await reconciliarFabricantesPorCnpGarantiaTransacional(prisma, "garantia", { tipo: "produtos", produtoIds: [pNovo.id] });
      check(r.ambiguidades === 1 && r.ambiguidadesDetalhe[0]?.motivo === "candidatos_textuais_fracos", "R1: bloqueado para revisão contra Postgres real — sinal real (Lda) mas insuficiente contra o titular (SA)", JSON.stringify(r.ambiguidadesDetalhe));
      const fabricantesDepois = await prisma.fabricante.count();
      check(fabricantesDepois === fabricantesAntes, "R2: ZERO Fabricante novo — nenhuma terceira linha Labialfarma criada silenciosamente");
      const pNovoDb = await prisma.produto.findUnique({ where: { id: pNovo.id }, select: { fabricanteId: true } });
      check(pNovoDb?.fabricanteId === null, "R3: fabricanteId continua null — decisão explícita fica pendente, nunca escolhida sozinha");
    }

    console.log("\nS · regra 4-bis contra Postgres REAL — Expomedica/Inserpor: só criados se REALMENTE ausentes, e a segunda execução não duplica");
    {
      const titularExpomedica = "EXPOMEDICA - SOCIEDADE EXPORTADORA E IMPORTADORA DE MATERIAL MEDICO LDA";
      const titularInserpor = "INSERPOR - COMERCIO DE PRODUTOS FARMACEUTICOS LDA";
      await prisma.fabricante.create({ data: { nomeNormalizado: "BAYER PORTUGAL LDA" } });
      await prisma.fabricante.create({ data: { nomeNormalizado: "SANDOZ FARMACEUTICA LDA" } });

      const pExpo = await prisma.produto.create({ data: { cnp: 6600301, designacao: "Expomedica real" } });
      await prisma.regulatoryRecord.create({ data: { cnp: 6600301, titularAim: titularExpomedica, estadoAim: "Ativo", source: "test" } });
      const pInserpor = await prisma.produto.create({ data: { cnp: 6600302, designacao: "Inserpor real" } });
      await prisma.regulatoryRecord.create({ data: { cnp: 6600302, titularAim: titularInserpor, estadoAim: "Ativo", source: "test" } });

      const r = await reconciliarFabricantesPorCnpGarantiaTransacional(prisma, "garantia", { tipo: "produtos", produtoIds: [pExpo.id, pInserpor.id] });
      check(r.fabricantesCriados === 2, "S1: sem nenhuma linha equivalente real na base, cria as DUAS — a busca textual nunca impede uma criação genuinamente nova", JSON.stringify({ fabricantesCriados: r.fabricantesCriados }));
      check(r.ambiguidades === 0, "S2: zero ambiguidades — nenhum candidato textual plausível para nenhum dos dois");

      const rSegunda = await reconciliarFabricantesPorCnpGarantiaTransacional(prisma, "garantia", { tipo: "produtos", produtoIds: [pExpo.id, pInserpor.id] });
      check(rSegunda.fabricantesCriados === 0, "S3: segunda execução — zero fabricantes novos, nenhuma duplicação de Expomedica/Inserpor");
      const totalExpomedica = await prisma.fabricante.count({ where: { nomeNormalizado: normalizarTitularAimGarantia(titularExpomedica)! } });
      const totalInserpor = await prisma.fabricante.count({ where: { nomeNormalizado: normalizarTitularAimGarantia(titularInserpor)! } });
      check(totalExpomedica === 1 && totalInserpor === 1, "S4: exactamente 1 linha para cada, nunca duplicada");
    }

    await prisma.$disconnect();
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${dbNome} WITH (FORCE)`);
    await admin.end();
  }

  console.log(`\n${passed} ok, ${failed} falhas`);
  if (failed > 0) process.exit(1);
}

function eqLog(r: unknown): void {
  console.log(`  (relatório da corrida real: ${JSON.stringify(r)})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
