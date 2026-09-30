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
    } = await import("../../lib/catalogo/manutencao-massa");

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
        { designacao: "A-Produto" },
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

      const resultado = await aplicarManutencaoMassa(prisma, {
        tipo: "FABRICANTE",
        filtro: { cnp: alvo.cnp },
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

      const resultado = await aplicarManutencaoMassa(prisma, {
        tipo: "FORNECEDOR",
        filtro: { farmaciaId: farm1.id, semFornecedor: true },
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
      const resultado = await aplicarManutencaoMassa(prisma, {
        tipo: "FABRICANTE",
        filtro: { cnp: 999999999 }, // CNP que não existe
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

      const aplicado = await aplicarManutencaoMassa(prisma, {
        tipo: "FABRICANTE",
        filtro: { designacao: "F-" },
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

      const r1 = await aplicarManutencaoMassa(prisma, {
        tipo: "FABRICANTE",
        filtro: { cnp: produto.cnp },
        destino: { modo: "novo", nome: nomeNovo },
        utilizadorId: utilizador.id,
      });
      check(r1.ok === true, "G1: primeira aplicação com nome novo cria o fabricante");

      // Repõe a null para poder voltar a corresponder ao MESMO filtro
      // (simula reaplicar a mesma operação, ex.: engano do utilizador).
      await prisma.produto.update({ where: { id: produto.id }, data: { fabricanteId: null } });

      const r2 = await aplicarManutencaoMassa(prisma, {
        tipo: "FABRICANTE",
        filtro: { cnp: produto.cnp },
        destino: { modo: "novo", nome: nomeNovo },
        utilizadorId: utilizador.id,
      });
      check(r2.ok === true, "G2: segunda aplicação idêntica também é bem-sucedida");

      const canonico = "G-FABRICANTE COMPLETAMENTE NOVO LDA";
      const total = await prisma.fabricante.count({ where: { nomeNormalizado: canonico } });
      check(total === 1, `G3: exactamente 1 fabricante criado, nunca duplicado (obtido ${total})`);
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
