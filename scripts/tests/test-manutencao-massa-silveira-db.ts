/**
 * scripts/tests/test-manutencao-massa-silveira-db.ts
 *
 * PostgreSQL REAL e DESCARTÁVEL — nunca uma base verdadeira. Modelado
 * exactamente em `scripts/tests/test-catalogo-massa-silveira-ingest-db.ts`.
 *
 *   docker run -d --name spharm-ws-test-pg-areaA -e POSTGRES_PASSWORD=test -p 55433:5432 postgres:16-alpine
 *   docker exec spharm-ws-test-pg-areaA pg_isready -U postgres   (esperar)
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:55433/postgres npx tsx scripts/tests/test-manutencao-massa-silveira-db.ts
 *   docker rm -f spharm-ws-test-pg-areaA
 *
 * Guarda de segurança: recusa correr se o host não for localhost/127.0.0.1.
 *
 * Cada secção usa Farmácia/Fabricante/Fornecedor/Produto PRÓPRIOS (nunca
 * partilhados entre secções) para que o filtro de uma secção nunca possa
 * acidentalmente apanhar produtos de outra — mais fixture, zero
 * contaminação cruzada a decifrar quando um teste falha.
 *
 * Cobre:
 *   A · previewOperacao — contagens exactas (total, agrupado por valor
 *       anterior, já-no-destino, vai-alterar) contra um catálogo real.
 *   B · aplicarManutencaoMassa (FABRICANTE) — só escreve os produtos que
 *       correspondem ao filtro; cria o cabeçalho + itens de auditoria com
 *       valores antes/depois correctos.
 *   C · aplicarManutencaoMassa (FORNECEDOR) — só toca ProdutoFarmacia da
 *       farmácia pedida, nunca de outra.
 *   D · Nenhum produto corresponde ao filtro → falha limpa, sem criar
 *       operação nenhuma (nunca uma escrita parcial).
 *   E · Mecanismo transaccional (prisma.$transaction) — uma escrita a
 *       meio de um lote que falha reverte TODO o lote, incluindo a
 *       escrita anterior já feita na mesma transacção. É o mecanismo
 *       exacto de que `aplicarManutencaoMassa` depende.
 *   F · reverterOperacao — restaura produtos elegíveis e SALTA (com
 *       motivo reportado) um produto alterado manualmente entre a
 *       aplicação e a reversão.
 *   G · Criação com confirmação de um fabricante novo — idempotente: a
 *       segunda aplicação idêntica nunca cria um duplicado.
 *   H · Falha forçada a MEIO da transacção, DEPOIS de o destino novo ter
 *       sido criado (via `Proxy` a interceptar só o `create` do cabeçalho
 *       de auditoria — depois de destino + produtos já terem sido escritos
 *       a sério no Postgres dentro da mesma transacção): zero Fabricante
 *       órfão, zero operação de auditoria, zero alteração de produto.
 *       Prova a atomicidade que faltava antes desta correcção — resolução
 *       (e criação) do destino agora corre DENTRO de `aplicarManutencaoMassa`.
 *   I · Duas aplicações CONCORRENTES (Promise.all real, não sequencial)
 *       com o MESMO nome de destino novo nunca criam duas entidades — o
 *       `@unique` em `nomeNormalizado` é a rede de segurança real.
 *   J · Destino desactivado ENTRE o preview e o apply é detectado no
 *       apply — nunca aplica a um destino que deixou de ser válido.
 *   K · Id de destino forjado (não corresponde a nenhum registo real) é
 *       rejeitado de forma limpa, sem escrita nenhuma.
 *   L · Reaplicar o MESMO pedido com sucesso duas vezes seguidas é SEGURO
 *       (nunca corrompe nem duplica a alteração do produto) mas NÃO é
 *       deduplicado — cria uma segunda operação de auditoria. Documenta o
 *       comportamento actual em vez de o assumir.
 */
import Module from "node:module";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { execSync } from "node:child_process";

const M = Module as unknown as { _resolveFilename: (r: string, ...a: unknown[]) => string };
const resolverOriginal = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "server-only" ? __filename : resolverOriginal.call(this, request, ...rest);
};

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  [OK]    ${msg}`); }
  else { failed++; console.log(`  [FALHA] ${msg}`); }
}

/**
 * Envolve um PrismaClient real para forçar uma falha REAL a MEIO da
 * transacção de `aplicarManutencaoMassa` — o `Proxy` intercepta só
 * `tx.catalogoManutencaoOperacao.create` (o ÚLTIMO passo de escrita, a
 * seguir à criação do destino e aos updates de produto, todos já
 * genuinamente enviados ao Postgres dentro da mesma transacção) e força
 * um throw. Prisma reage exactamente como reagiria a uma falha de
 * infraestrutura real: emite ROLLBACK a sério no Postgres, desfazendo
 * TUDO o que a transacção já tinha escrito. Usado só na secção H.
 */
function comFalhaForcadaAoCriarAuditoria<T extends { $transaction(...args: unknown[]): unknown }>(prismaReal: T): T {
  return new Proxy(prismaReal as unknown as Record<string, unknown>, {
    get(target, prop, receiver) {
      if (prop === "$transaction") {
        const original = Reflect.get(target, prop, receiver) as (...args: unknown[]) => unknown;
        return (fn: (tx: unknown) => unknown, opts?: unknown) =>
          original.call(
            target,
            (tx: Record<string, unknown>) => {
              const txComFalha = new Proxy(tx, {
                get(txTarget, txProp, txReceiver) {
                  if (txProp === "catalogoManutencaoOperacao") {
                    const delegate = Reflect.get(txTarget, txProp, txReceiver) as Record<string, unknown>;
                    return new Proxy(delegate, {
                      get(opTarget, opProp, opReceiver) {
                        if (opProp === "create") {
                          return () => {
                            throw new Error("FALHA_FORCADA_TESTE_MID_TX");
                          };
                        }
                        return Reflect.get(opTarget, opProp, opReceiver);
                      },
                    });
                  }
                  return Reflect.get(txTarget, txProp, txReceiver);
                },
              });
              return fn(txComFalha);
            },
            opts,
          );
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as unknown as T;
}

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgresql://postgres:test@localhost:55433/postgres";
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

async function main() {
  const sufixo = Date.now().toString(36);
  const dbName = `spharm_cmm_${sufixo}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);

  try {
    execSync("npx prisma migrate deploy", {
      env: { ...process.env, DATABASE_URL: urlDe(dbName) },
      encoding: "utf8",
    });

    const { PrismaClient } = await import("../../generated/prisma/client");
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(dbName) }) });
    const {
      previewOperacao,
      aplicarManutencaoMassa,
      reverterOperacao,
      resolverAlvos,
      aplicarSelecao,
      hashSnapshot,
    } = await import("../../lib/catalogo/manutencao-massa");

    // O apply exige o snapshot do preview; aqui o hash é calculado a partir do conjunto real (o que o preview devolveria),
    // para os cenários de falha continuarem a exercitar o apply directamente.
    const aplicar = async (p: typeof prisma, pedido: Omit<Parameters<typeof aplicarManutencaoMassa>[1], "snapshotHash">) => {
      const alvos = aplicarSelecao(await resolverAlvos(prisma, pedido.tipo, pedido.filtro), pedido.selecao);
      return aplicarManutencaoMassa(p, { ...pedido, snapshotHash: hashSnapshot(pedido.tipo, pedido.filtro, alvos) });
    };

    const utilizador = await prisma.utilizador.create({
      data: { email: "teste@silveira.local", nome: "Utilizador de Teste", perfil: "ADMINISTRADOR" },
    });

    let cnpSeq = 6000000;
    const proximoCnp = () => ++cnpSeq;

    console.log("\nA · previewOperacao — contagens exactas");
    {
      const fabA = await prisma.fabricante.create({ data: { nomeNormalizado: "A-FABRICANTE-ALFA", estado: "ATIVO" } });
      const fabB = await prisma.fabricante.create({ data: { nomeNormalizado: "A-FABRICANTE-BETA", estado: "ATIVO" } });

      await prisma.produto.create({ data: { cnp: proximoCnp(), designacao: "A-Produto 1", fabricanteId: fabA.id } });
      await prisma.produto.create({ data: { cnp: proximoCnp(), designacao: "A-Produto 2", fabricanteId: fabA.id } });
      await prisma.produto.create({ data: { cnp: proximoCnp(), designacao: "A-Produto 3", fabricanteId: fabB.id } });
      await prisma.produto.create({ data: { cnp: proximoCnp(), designacao: "A-Produto 4", fabricanteId: null } });

      const preview = await previewOperacao(
        prisma,
        "FABRICANTE",
        { pesquisa: "A-Produto" },
        { modo: "existente", id: fabA.id },
      );
      check(preview.ok === true, "A1: preview devolve ok");
      if (preview.ok) {
        check(preview.totalCount === 4, `A2: total exacto (obtido ${preview.totalCount})`);
        check(preview.jaNoDestinoCount === 2, `A3: já no destino = 2 (obtido ${preview.jaNoDestinoCount})`);
        check(preview.iraAlterarCount === 2, `A4: vai alterar = 2 (obtido ${preview.iraAlterarCount})`);
        const grupoB = preview.agrupadoPorValorAnterior.find((g) => g.valorAnteriorId === fabB.id);
        check(grupoB?.count === 1, "A5: grupo do fabricante B tem 1 produto");
        const grupoNulo = preview.agrupadoPorValorAnterior.find((g) => g.valorAnteriorId === null);
        check(grupoNulo?.count === 1, "A6: grupo sem fabricante tem 1 produto");
      }
    }

    console.log("\nB · aplicarManutencaoMassa (FABRICANTE) — escreve só o que corresponde, com auditoria");
    {
      const fabOrigem = await prisma.fabricante.create({ data: { nomeNormalizado: "B-FABRICANTE-ORIGEM", estado: "ATIVO" } });
      const fabDestino = await prisma.fabricante.create({ data: { nomeNormalizado: "B-FABRICANTE-DESTINO", estado: "ATIVO" } });
      const alvo = await prisma.produto.create({ data: { cnp: proximoCnp(), designacao: "B-Alvo", fabricanteId: fabOrigem.id } });
      const foraDoFiltro = await prisma.produto.create({ data: { cnp: proximoCnp(), designacao: "B-Fora", fabricanteId: fabOrigem.id } });

      const resultado = await aplicar(prisma, {
        tipo: "FABRICANTE",
        filtro: { cnps: [alvo.cnp] },
        destino: { modo: "existente", id: fabDestino.id },
        utilizadorId: utilizador.id,
      });
      check(resultado.ok === true, "B1: aplicação bem-sucedida");
      if (resultado.ok) {
        check(resultado.quantidadeSolicitada === 1, "B2: solicitados = 1 (só o produto do filtro)");
        check(resultado.quantidadeAlterada === 1, "B3: alterados = 1");
        check(resultado.quantidadeIgnorada === 0, "B4: ignorados = 0");

        const alvoDepois = await prisma.produto.findUnique({ where: { id: alvo.id } });
        check(alvoDepois?.fabricanteId === fabDestino.id, "B5: fabricanteId do alvo foi alterado");
        const foraDepois = await prisma.produto.findUnique({ where: { id: foraDoFiltro.id } });
        check(foraDepois?.fabricanteId === fabOrigem.id, "B6: produto fora do filtro NÃO foi tocado");

        const operacao = await prisma.catalogoManutencaoOperacao.findUnique({
          where: { id: resultado.operacaoId },
          include: { itens: true },
        });
        check(operacao?.tipo === "FABRICANTE", "B7: operação regista tipo FABRICANTE");
        check(operacao?.farmaciaId === null, "B8: farmaciaId da operação é null (fabricante é tenant-wide)");
        check(operacao?.itens.length === 1, "B9: exactamente 1 item de auditoria");
        const item = operacao?.itens[0];
        check(item?.valorAnteriorId === fabOrigem.id, "B10: valorAnteriorId correcto");
        check(item?.valorNovoId === fabDestino.id, "B11: valorNovoId correcto");
      }
    }

    console.log("\nC · aplicarManutencaoMassa (FORNECEDOR) — só toca a farmácia pedida");
    {
      const farm1 = await prisma.farmacia.create({ data: { nome: "C-Farmacia-1" } });
      const farm2 = await prisma.farmacia.create({ data: { nome: "C-Farmacia-2" } });
      const forX = await prisma.fornecedor.create({ data: { nomeNormalizado: "C-FORNECEDOR-X", estado: "ATIVO" } });
      const forY = await prisma.fornecedor.create({ data: { nomeNormalizado: "C-FORNECEDOR-Y", estado: "ATIVO" } });
      const produto = await prisma.produto.create({ data: { cnp: proximoCnp(), designacao: "C-Produto" } });

      await prisma.produtoFarmacia.create({ data: { produtoId: produto.id, farmaciaId: farm1.id, fornecedorHabitualId: null } });
      await prisma.produtoFarmacia.create({ data: { produtoId: produto.id, farmaciaId: farm2.id, fornecedorHabitualId: forY.id } });

      const resultado = await aplicar(prisma, {
        tipo: "FORNECEDOR",
        filtro: { farmaciaIds: [farm1.id], semFornecedor: true },
        destino: { modo: "existente", id: forX.id },
        utilizadorId: utilizador.id,
      });
      check(resultado.ok === true, "C1: aplicação bem-sucedida");
      if (resultado.ok) check(resultado.quantidadeAlterada === 1, "C2: 1 alterado");

      const pf1 = await prisma.produtoFarmacia.findUnique({
        where: { produtoId_farmaciaId: { produtoId: produto.id, farmaciaId: farm1.id } },
      });
      check(pf1?.fornecedorHabitualId === forX.id, "C3: farmácia 1 foi actualizada");
      const pf2 = await prisma.produtoFarmacia.findUnique({
        where: { produtoId_farmaciaId: { produtoId: produto.id, farmaciaId: farm2.id } },
      });
      check(pf2?.fornecedorHabitualId === forY.id, "C4: farmácia 2 NUNCA foi tocada — continua com o fornecedor Y original");
    }

    console.log("\nD · nenhum produto corresponde ao filtro — falha limpa, zero escrita parcial");
    {
      const totalOperacoesAntes = await prisma.catalogoManutencaoOperacao.count();
      const fabDestino = await prisma.fabricante.create({ data: { nomeNormalizado: "D-FABRICANTE-DESTINO", estado: "ATIVO" } });
      const resultado = await aplicar(prisma, {
        tipo: "FABRICANTE",
        filtro: { cnps: [999999999] }, // CNP que não existe
        destino: { modo: "existente", id: fabDestino.id },
        utilizadorId: utilizador.id,
      });
      check(resultado.ok === false, "D1: aplicação sem correspondência falha (não silenciosa)");
      const totalOperacoesDepois = await prisma.catalogoManutencaoOperacao.count();
      check(totalOperacoesAntes === totalOperacoesDepois, "D2: nenhuma operação foi criada (nada parcial)");
    }

    console.log("\nE · mecanismo transaccional — falha a meio do lote reverte TUDO o que já tinha escrito");
    {
      const fabOrigem = await prisma.fabricante.create({ data: { nomeNormalizado: "E-FABRICANTE-ORIGEM", estado: "ATIVO" } });
      const fabDestino = await prisma.fabricante.create({ data: { nomeNormalizado: "E-FABRICANTE-DESTINO", estado: "ATIVO" } });
      const produto = await prisma.produto.create({ data: { cnp: proximoCnp(), designacao: "E-Produto", fabricanteId: fabOrigem.id } });

      let erroCapturado = false;
      try {
        await prisma.$transaction(async (tx) => {
          // Primeira escrita — exactamente o que `aplicarManutencaoMassa` faz por item.
          await tx.produto.update({ where: { id: produto.id }, data: { fabricanteId: fabDestino.id } });
          // Segunda escrita do MESMO lote: FK inexistente força uma falha real da
          // BD a meio da transacção — o mesmo tipo de falha que faria
          // `aplicarManutencaoMassa` abortar o lote inteiro.
          await tx.produto.update({ where: { id: produto.id }, data: { fabricanteId: "id-fabricante-inexistente" } });
        });
      } catch {
        erroCapturado = true;
      }
      check(erroCapturado, "E1: a segunda escrita do lote falhou como esperado");

      const depois = await prisma.produto.findUnique({ where: { id: produto.id } });
      check(
        depois?.fabricanteId === fabOrigem.id,
        "E2: a PRIMEIRA escrita do mesmo lote também foi revertida — a transacção é tudo-ou-nada",
      );
    }

    console.log("\nF · reverterOperacao — restaura elegíveis, salta os alterados entretanto");
    {
      const fabOrigem = await prisma.fabricante.create({ data: { nomeNormalizado: "F-FABRICANTE-ORIGEM", estado: "ATIVO" } });
      const fabDestino = await prisma.fabricante.create({ data: { nomeNormalizado: "F-FABRICANTE-DESTINO", estado: "ATIVO" } });
      const fabIntruso = await prisma.fabricante.create({ data: { nomeNormalizado: "F-FABRICANTE-INTRUSO", estado: "ATIVO" } });
      const p1 = await prisma.produto.create({ data: { cnp: proximoCnp(), designacao: "F-Elegivel", fabricanteId: fabOrigem.id } });
      const p2 = await prisma.produto.create({ data: { cnp: proximoCnp(), designacao: "F-Alterado-Depois", fabricanteId: fabOrigem.id } });

      const aplicado = await aplicar(prisma, {
        tipo: "FABRICANTE",
        filtro: { pesquisa: "F-" },
        destino: { modo: "existente", id: fabDestino.id },
        utilizadorId: utilizador.id,
      });
      check(aplicado.ok === true, "F1: operação original aplicada");
      if (!aplicado.ok) throw new Error("setup F falhou");

      // Alteração manual a p2 DEPOIS da operação original — simula outra
      // decisão humana/outro processo a mexer no produto entretanto.
      await prisma.produto.update({ where: { id: p2.id }, data: { fabricanteId: fabIntruso.id } });

      const revertido = await reverterOperacao(prisma, aplicado.operacaoId, utilizador.id, "teste de reversão");
      check(revertido.ok === true, "F2: reversão executa");
      if (revertido.ok) {
        check(revertido.revertidos === 1, "F3: exactamente 1 produto revertido (p1)");
        check(revertido.ignorados.length === 1, "F4: exactamente 1 produto saltado (p2)");
        check(revertido.ignorados[0]?.produtoId === p2.id, "F5: o saltado é mesmo p2");
      }

      const p1Depois = await prisma.produto.findUnique({ where: { id: p1.id } });
      check(p1Depois?.fabricanteId === fabOrigem.id, "F6: p1 foi restaurado ao fabricante original");
      const p2Depois = await prisma.produto.findUnique({ where: { id: p2.id } });
      check(p2Depois?.fabricanteId === fabIntruso.id, "F7: p2 NÃO foi tocado pela reversão — ficou com o valor intruso");

      const novaOperacao = await prisma.catalogoManutencaoOperacao.findUnique({
        where: { id: revertido.ok ? revertido.novaOperacaoId : "" },
        include: { itens: true },
      });
      check(novaOperacao?.origem === "REVERSAO", "F8: nova operação marcada como REVERSAO");
      check(novaOperacao?.operacaoOrigemId === aplicado.operacaoId, "F9: aponta para a operação original");
      check(novaOperacao?.itens.length === 1, "F10: só 1 item na reversão (o elegível)");

      const original = await prisma.catalogoManutencaoOperacao.findUnique({ where: { id: aplicado.operacaoId } });
      check(original !== null, "F11: a operação original NUNCA é apagada");
    }

    console.log("\nG · criação com confirmação — nunca duplica num segundo pedido idêntico");
    {
      const produto = await prisma.produto.create({ data: { cnp: proximoCnp(), designacao: "G-Produto", fabricanteId: null } });
      const nomeNovo = "G-Fabricante Completamente Novo Lda";

      const r1 = await aplicar(prisma, {
        tipo: "FABRICANTE",
        filtro: { cnps: [produto.cnp] },
        destino: { modo: "novo", nome: nomeNovo },
        utilizadorId: utilizador.id,
      });
      check(r1.ok === true, "G1: primeira aplicação com nome novo cria o fabricante");

      // Repõe a null para poder voltar a corresponder ao MESMO filtro
      // (simula reaplicar a mesma operação, ex.: engano do utilizador).
      await prisma.produto.update({ where: { id: produto.id }, data: { fabricanteId: null } });

      const r2 = await aplicar(prisma, {
        tipo: "FABRICANTE",
        filtro: { cnps: [produto.cnp] },
        destino: { modo: "novo", nome: nomeNovo },
        utilizadorId: utilizador.id,
      });
      check(r2.ok === true, "G2: segunda aplicação idêntica também é bem-sucedida");

      const canonico = "G-FABRICANTE COMPLETAMENTE NOVO LDA";
      const total = await prisma.fabricante.count({ where: { nomeNormalizado: canonico } });
      check(total === 1, `G3: exactamente 1 fabricante criado, nunca duplicado (obtido ${total})`);
    }

    console.log("\nH · falha forçada a meio da transacção DEPOIS de criar o destino — zero órfão, zero auditoria, zero alteração");
    {
      const produto = await prisma.produto.create({ data: { cnp: proximoCnp(), designacao: "H-Produto", fabricanteId: null } });
      const nomeNovo = "H-Fabricante Forcado A Falhar Lda";
      const canonico = "H-FABRICANTE FORCADO A FALHAR LDA";

      const operacoesAntes = await prisma.catalogoManutencaoOperacao.count();

      const prismaComFalha = comFalhaForcadaAoCriarAuditoria(prisma);
      const resultado = await aplicar(prismaComFalha, {
        tipo: "FABRICANTE",
        filtro: { cnps: [produto.cnp] },
        destino: { modo: "novo", nome: nomeNovo },
        utilizadorId: utilizador.id,
      });
      check(resultado.ok === false, "H1: aplicação com falha forçada devolve ok:false (não silenciosa)");

      const fabricanteOrfao = await prisma.fabricante.count({ where: { nomeNormalizado: canonico } });
      check(fabricanteOrfao === 0, `H2: nenhum Fabricante órfão ficou criado — rollback real (obtido ${fabricanteOrfao})`);

      const operacoesDepois = await prisma.catalogoManutencaoOperacao.count();
      check(operacoesAntes === operacoesDepois, "H3: nenhuma operação de auditoria foi criada");

      const produtoDepois = await prisma.produto.findUnique({ where: { id: produto.id } });
      check(produtoDepois?.fabricanteId === null, "H4: fabricanteId do produto continua null — a escrita foi revertida");
    }

    console.log("\nI · duas aplicações concorrentes com o MESMO destino novo — nunca duplicam a entidade");
    {
      const p1 = await prisma.produto.create({ data: { cnp: proximoCnp(), designacao: "I-Produto-1", fabricanteId: null } });
      const p2 = await prisma.produto.create({ data: { cnp: proximoCnp(), designacao: "I-Produto-2", fabricanteId: null } });
      const nomeNovo = "I-Fabricante Concorrente Lda";
      const canonico = "I-FABRICANTE CONCORRENTE LDA";

      const [r1, r2] = await Promise.all([
        aplicar(prisma, {
          tipo: "FABRICANTE",
          filtro: { cnps: [p1.cnp] },
          destino: { modo: "novo", nome: nomeNovo },
          utilizadorId: utilizador.id,
        }),
        aplicar(prisma, {
          tipo: "FABRICANTE",
          filtro: { cnps: [p2.cnp] },
          destino: { modo: "novo", nome: nomeNovo },
          utilizadorId: utilizador.id,
        }),
      ]);

      const sucessos = [r1, r2].filter((r) => r.ok === true).length;
      check(sucessos >= 1, `I1: pelo menos uma das duas aplicações concorrentes foi bem-sucedida (obtido ${sucessos})`);

      const total = await prisma.fabricante.count({ where: { nomeNormalizado: canonico } });
      check(total === 1, `I2: exactamente 1 Fabricante criado, nunca duplicado (obtido ${total})`);

      if (sucessos === 2) {
        const fab = await prisma.fabricante.findUnique({ where: { nomeNormalizado: canonico } });
        const p1Depois = await prisma.produto.findUnique({ where: { id: p1.id } });
        const p2Depois = await prisma.produto.findUnique({ where: { id: p2.id } });
        check(
          p1Depois?.fabricanteId === fab?.id && p2Depois?.fabricanteId === fab?.id,
          "I3: quando as duas tiveram sucesso, ambos os produtos apontam para o MESMO fabricante (nunca dois registos)",
        );
      } else {
        // A que "perdeu" a corrida falhou de forma limpa — nunca deixou o
        // seu produto a meio (nem alterado para um destino inexistente,
        // nem com uma operação de auditoria órfã).
        const falhas = [r1, r2].filter((r): r is { ok: false; error: string } => r.ok === false);
        const primeiraLinhaDoErro = falhas[0]?.error
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l.length > 0);
        check(
          falhas.length >= 1 && typeof falhas[0].error === "string" && falhas[0].error.length > 0,
          `I4: a aplicação que perdeu a corrida falhou com um erro claro ("${primeiraLinhaDoErro}")`,
        );
      }
    }

    console.log("\nJ · destino desactivado ENTRE o preview e o apply — detectado no apply, nunca aplicado às cegas");
    {
      const fabDestino = await prisma.fabricante.create({ data: { nomeNormalizado: "J-FABRICANTE-DESTINO", estado: "ATIVO" } });
      const produto = await prisma.produto.create({ data: { cnp: proximoCnp(), designacao: "J-Produto", fabricanteId: null } });

      const preview = await previewOperacao(
        prisma,
        "FABRICANTE",
        { cnps: [produto.cnp] },
        { modo: "existente", id: fabDestino.id },
      );
      check(preview.ok === true && preview.destino.status === "existente", "J1: preview resolve o destino como válido/existente");

      // "Algo aconteceu entretanto" — outro utilizador desactivou o
      // fabricante depois do preview, antes de o pedido de apply chegar.
      await prisma.fabricante.update({ where: { id: fabDestino.id }, data: { estado: "INATIVO" } });

      const resultado = await aplicar(prisma, {
        tipo: "FABRICANTE",
        filtro: { cnps: [produto.cnp] },
        destino: { modo: "existente", id: fabDestino.id },
        utilizadorId: utilizador.id,
      });
      check(resultado.ok === false, "J2: apply falha — nunca confia no destino resolvido pelo preview");

      const produtoDepois = await prisma.produto.findUnique({ where: { id: produto.id } });
      check(produtoDepois?.fabricanteId === null, "J3: produto não foi tocado");
      const operacoesComEsteFiltro = await prisma.catalogoManutencaoOperacao.count({ where: { valorNovoId: fabDestino.id } });
      check(operacoesComEsteFiltro === 0, "J4: nenhuma operação de auditoria criada para este destino inválido");
    }

    console.log("\nK · id de destino forjado (não existe) — rejeitado de forma limpa, zero escrita");
    {
      const produto = await prisma.produto.create({ data: { cnp: proximoCnp(), designacao: "K-Produto", fabricanteId: null } });
      const idForjado = "clforjadoidquenaoexisteabc12";

      const resultado = await aplicar(prisma, {
        tipo: "FABRICANTE",
        filtro: { cnps: [produto.cnp] },
        destino: { modo: "existente", id: idForjado },
        utilizadorId: utilizador.id,
      });
      check(resultado.ok === false, "K1: id forjado é rejeitado");

      const produtoDepois = await prisma.produto.findUnique({ where: { id: produto.id } });
      check(produtoDepois?.fabricanteId === null, "K2: produto não foi tocado");
      const fabricanteFantasma = await prisma.fabricante.findUnique({ where: { id: idForjado } });
      check(fabricanteFantasma === null, "K3: nenhum Fabricante foi criado com o id forjado");
    }

    console.log("\nL · reaplicar o MESMO pedido bem-sucedido duas vezes — seguro, mas NÃO deduplicado (documentado)");
    {
      const fabOrigem = await prisma.fabricante.create({ data: { nomeNormalizado: "L-FABRICANTE-ORIGEM", estado: "ATIVO" } });
      const fabDestino = await prisma.fabricante.create({ data: { nomeNormalizado: "L-FABRICANTE-DESTINO", estado: "ATIVO" } });
      const produto = await prisma.produto.create({ data: { cnp: proximoCnp(), designacao: "L-Produto", fabricanteId: fabOrigem.id } });

      const pedido = {
        tipo: "FABRICANTE" as const,
        filtro: { cnps: [produto.cnp] },
        destino: { modo: "existente" as const, id: fabDestino.id },
        utilizadorId: utilizador.id,
      };

      const r1 = await aplicar(prisma, pedido);
      check(r1.ok === true, "L1: primeira aplicação bem-sucedida");
      if (r1.ok) {
        check(r1.quantidadeAlterada === 1 && r1.quantidadeIgnorada === 0, "L2: primeira aplicação alterou o produto");
      }

      // Mesmo pedido, sem alterar nada entretanto — ex.: duplo-clique ou
      // retry de rede no mesmo formulário já submetido.
      const r2 = await aplicar(prisma, pedido);
      check(r2.ok === true, "L3: segunda aplicação idêntica também é bem-sucedida (não bloqueia o retry)");
      if (r2.ok) {
        check(
          r2.quantidadeAlterada === 0 && r2.quantidadeIgnorada === 1,
          "L4: segunda aplicação NÃO re-altera — valorAnterior já era o destino, contado como ignorado (seguro)",
        );
      }

      const produtoDepois = await prisma.produto.findUnique({ where: { id: produto.id } });
      check(produtoDepois?.fabricanteId === fabDestino.id, "L5: produto continua correctamente no destino — nada corrompido");

      const totalOperacoes = await prisma.catalogoManutencaoOperacao.count({
        where: { valorNovoId: fabDestino.id, farmaciaId: null },
      });
      check(
        totalOperacoes === 2,
        `L6: DOCUMENTADO — cada submissão cria a sua própria operação de auditoria, nunca deduplicada (obtido ${totalOperacoes} operações para 1 alteração real); comportamento seguro (nunca corrompe/duplica a escrita em Produto) mas não idempotente — não há (nem esta tarefa pede) uma chave de idempotência tipo clientIdempotencyKey aqui.`,
      );
    }

    await prisma.$disconnect();
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }

  console.log(`\n${passed} ok, ${failed} falhas`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
