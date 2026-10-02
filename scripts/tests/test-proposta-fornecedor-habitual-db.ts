/**
 * scripts/tests/test-proposta-fornecedor-habitual-db.ts
 *
 * PostgreSQL REAL e DESCARTÁVEL (recusa correr fora de localhost):
 *
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:55494/postgres npx tsx scripts/tests/test-proposta-fornecedor-habitual-db.ts
 *
 * O fornecedor HABITUAL é por produto E por farmácia: a fonte de verdade é
 * `ProdutoFarmacia.fornecedorHabitualId` — e SÓ ela. A proposta usa-o como
 * sugestão INICIAL de cada linha:
 *
 *   H  o mesmo produto tem fornecedores diferentes nas duas farmácias e cada
 *      linha recebe o da SUA farmácia (nunca copiado de uma para a outra);
 *   N  fornecedor habitual INATIVO: NÃO é usado na proposta (linha «sem
 *      fornecedor»); o nome só aparece como aviso informativo;
 *   T  CONTRAPROVA: sem `fornecedorHabitualId` o texto do ERP
 *      (`fornecedorOrigem`) NUNCA vira fornecedor — mesmo coincidindo
 *      exactamente com um nome canónico ou alias;
 *   R  tudo isto é SÓ LEITURA: `ProdutoFarmacia` nunca é escrito pela proposta;
 *   D  um rascunho já gravado prevalece sobre o habitual;
 *   G  o modo grupo (e a consolidação) devolvem o mesmo por farmácia;
 *   I  fornecedor INATIVO: o rascunho mantém o nome histórico, o autosave
 *      recusa escolhê-lo de novo (mas aceita manter o já gravado) e a
 *      finalização (única, multi-fornecedor e criação directa) recusa-o.
 */
import Module from "node:module";
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

async function main() {
  const db = `spharm_fhab_${Date.now().toString(36)}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${db}`);
  try {
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(db) }, encoding: "utf8" });
    const { PrismaClient } = await import("../../generated/prisma/client");
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(db) }) });
    const { generateOrderProposal, generateGroupProposal } = await import("../../lib/encomendas/proposal");
    const { loadOrderDetailComPrisma } = await import("../../lib/encomendas/order-detail");

    const user = await prisma.utilizador.create({ data: { email: "fh@t.pt", nome: "FH", perfil: "ADMINISTRADOR" } });
    const fA = await prisma.farmacia.create({ data: { nome: "FH Silveirense" } });
    const fB = await prisma.farmacia.create({ data: { nome: "FH Segurado" } });
    const forX = await prisma.fornecedor.create({ data: { nomeNormalizado: "FH-FORN-X", nome: "Forn X", estado: "ATIVO" } });
    const forY = await prisma.fornecedor.create({ data: { nomeNormalizado: "FH-FORN-Y", nome: "Forn Y", estado: "ATIVO" } });
    const forOff = await prisma.fornecedor.create({ data: { nomeNormalizado: "FH-FORN-INATIVO", nome: "Forn Inativo", estado: "INATIVO" } });
    const forW = await prisma.fornecedor.create({ data: { nomeNormalizado: "FH-FORN-W", nome: "Forn W", estado: "ATIVO" } });
    const forAmb1 = await prisma.fornecedor.create({ data: { nomeNormalizado: "FH-AMB-1", estado: "ATIVO" } });
    const forAmb2 = await prisma.fornecedor.create({ data: { nomeNormalizado: "FH-AMB-2", estado: "ATIVO" } });
    await prisma.fornecedorAlias.create({ data: { fornecedorId: forAmb1.id, aliasNome: "FH-AMBIGUO" } });
    await prisma.fornecedorAlias.create({ data: { fornecedorId: forAmb2.id, aliasNome: "FH-AMBIGUO" } });
    await prisma.fornecedorAlias.create({ data: { fornecedorId: forW.id, aliasNome: "FH-W-ABREV" } });

    type Def = { n: number; nome: string; a: { hab: string | null; txt: string | null }; b: { hab: string | null; txt: string | null } };
    const defs: Def[] = [
      { n: 1, nome: "FH P1 Mesmo produto fornecedores diferentes", a: { hab: forX.id, txt: "FH-FORN-X" }, b: { hab: forY.id, txt: "FH-FORN-Y" } },
      { n: 2, nome: "FH P2 Habitual inativo", a: { hab: forOff.id, txt: null }, b: { hab: null, txt: null } },
      { n: 3, nome: "FH P3 So texto do ERP", a: { hab: null, txt: "FH-FORN-W" }, b: { hab: null, txt: null } },
      { n: 4, nome: "FH P4 Texto por alias unico", a: { hab: null, txt: "FH-W-ABREV" }, b: { hab: null, txt: null } },
      { n: 5, nome: "FH P5 Texto ambiguo", a: { hab: null, txt: "FH-AMBIGUO" }, b: { hab: null, txt: "FH-AMBIGUO" } },
      { n: 6, nome: "FH P6 Texto desconhecido", a: { hab: null, txt: "FH-NAO-EXISTE" }, b: { hab: null, txt: null } },
      { n: 7, nome: "FH P7 Sem nada", a: { hab: null, txt: null }, b: { hab: null, txt: null } },
      { n: 8, nome: "FH P8 Habitual so numa farmacia", a: { hab: forX.id, txt: "FH-FORN-X" }, b: { hab: null, txt: null } },
    ];
    const prod: Record<number, string> = {};
    const hoje = new Date();
    for (const d of defs) {
      const p = await prisma.produto.create({ data: { cnp: 7_200_000 + d.n, designacao: d.nome, estado: "VALIDADO" } });
      prod[d.n] = p.id;
      for (const [f, v] of [[fA, d.a], [fB, d.b]] as const) {
        await prisma.produtoFarmacia.create({
          data: { produtoId: p.id, farmaciaId: f.id, fornecedorHabitualId: v.hab, fornecedorOrigem: v.txt, stockAtual: 0, stockMinimo: 0, stockMaximo: 10 },
        });
        for (let m = 1; m <= 3; m++) {
          const dt = new Date(hoje.getFullYear(), hoje.getMonth() - m, 1);
          await prisma.vendaMensal.create({
            data: { farmaciaId: f.id, produtoId: p.id, ano: dt.getFullYear(), mes: dt.getMonth() + 1, quantidade: 300, valorTotal: 3000, naturezaVenda: "NORMAL" },
          });
        }
      }
    }
    const input = {
      startDate: new Date(hoje.getFullYear(), hoje.getMonth() - 6, 1),
      endDate: hoje,
      considerStock: true,
      baseRule: "total" as const,
      targetCoverageDays: 30,
    };
    const antes = JSON.stringify(await prisma.produtoFarmacia.findMany({ orderBy: [{ produtoId: "asc" }, { farmaciaId: "asc" }], select: { produtoId: true, farmaciaId: true, fornecedorHabitualId: true, fornecedorOrigem: true } }));

    const pa = await generateOrderProposal({ ...input, farmaciaId: fA.id, farmaciaNome: "A" }, prisma);
    const pb = await generateOrderProposal({ ...input, farmaciaId: fB.id, farmaciaNome: "B" }, prisma);
    const rowA = (n: number) => pa.rows.find((r) => r.produtoId === prod[n])!;
    const rowB = (n: number) => pb.rows.find((r) => r.produtoId === prod[n])!;

    console.log("\nH · fornecedor habitual por produto E por farmácia");
    check(rowA(1).fornecedorSugeridoId === forX.id && rowA(1).fornecedorSugeridoNome === "Forn X", "H1: P1 na Silveirense recebe o fornecedor X (da SUA farmácia)");
    check(rowB(1).fornecedorSugeridoId === forY.id && rowB(1).fornecedorSugeridoNome === "Forn Y", "H2: o MESMO P1 no Segurado recebe o fornecedor Y — nunca copiado de uma farmácia para a outra");
    check(rowA(8).fornecedorSugeridoId === forX.id && rowB(8).fornecedorSugeridoId === null, "H4: P8 tem habitual só na Silveirense — o Segurado fica EXPLICITAMENTE sem fornecedor (não herda)");
    check(rowB(7).fornecedorSugeridoId === null && rowB(7).fornecedorSugeridoNome == null, "H5: sem habitual e sem texto → sem fornecedor");

    console.log("\nN · habitual INATIVO — não é usado");
    check(rowA(2).fornecedorSugeridoId === null && rowA(2).fornecedorSugeridoNome == null, "N1: um habitual inativo NÃO é sugerido (linha sem fornecedor)");
    check(rowA(2).fornecedorHabitualInativoNome === "Forn Inativo", "N2: …mas a proposta informa «habitual inativo: Forn Inativo» (só aviso)");
    check(rowA(1).fornecedorHabitualInativoNome == null, "N3: um habitual ativo não tem aviso");

    console.log("\nT · CONTRAPROVA: o texto do ERP nunca vira fornecedor");
    check(rowA(3).fornecedorSugeridoId === null && rowA(3).fornecedorSugeridoNome == null, "T1: texto == nome canónico EXACTO de um Fornecedor ativo, sem habitual → continua «Sem fornecedor»");
    check(rowA(4).fornecedorSugeridoId === null, "T2: texto == alias único de um Fornecedor → continua «Sem fornecedor»");
    check(rowA(5).fornecedorSugeridoId === null && rowB(5).fornecedorSugeridoId === null, "T3: alias ambíguo → sem fornecedor");
    check(rowA(6).fornecedorSugeridoId === null, "T4: texto desconhecido → sem fornecedor");
    check(rowA(3).fornecedor === "FH-FORN-W", "T5: o texto do ERP continua visível como informação (coluna distribuidor), sem decidir nada");
    check(rowA(1).fornecedorSugeridoId === forX.id, "T6: o habitual (quando existe e está ativo) é a única fonte");
    console.log("\nR · só leitura");
    const depois = JSON.stringify(await prisma.produtoFarmacia.findMany({ orderBy: [{ produtoId: "asc" }, { farmaciaId: "asc" }], select: { produtoId: true, farmaciaId: true, fornecedorHabitualId: true, fornecedorOrigem: true } }));
    check(antes === depois, "R1: a proposta não escreveu NADA em ProdutoFarmacia (habitual e texto intactos)");
    check((await prisma.fornecedorAlias.count()) === 3 && (await prisma.fornecedor.count()) === 6, "R2: nenhum Fornecedor nem alias foi criado");

    console.log("\nD · o rascunho prevalece sobre o habitual");
    const lista = await prisma.listaEncomenda.create({
      data: { farmaciaId: fA.id, nome: "Rascunho FH", estado: "RASCUNHO", criadoPorId: user.id, linhas: { create: [{ produtoId: prod[1], quantidadeAjustada: 5, fornecedorSugeridoId: forY.id, origem: "PROPOSTA" }, { produtoId: prod[7], quantidadeAjustada: 5, fornecedorSugeridoId: null, origem: "PROPOSTA" }] } },
    });
    const detalhe = await loadOrderDetailComPrisma(prisma, lista.id);
    const l1 = detalhe?.linhas.find((l) => l.produtoId === prod[1]);
    check(l1?.fornecedorSugeridoId === forY.id, "D1: o rascunho guarda a ESCOLHA (Y) e devolve-a — o habitual X da Silveirense não a repõe");
    const pa2 = await generateOrderProposal({ ...input, farmaciaId: fA.id, farmaciaNome: "A" }, prisma);
    check(pa2.rows.find((r) => r.produtoId === prod[1])!.fornecedorSugeridoId === forX.id, "D2: gerar nova proposta continua a dar a sugestão X (a decisão do rascunho vive na linha, não aqui)");
    const aposRascunho = await prisma.linhaEncomenda.findFirstOrThrow({ where: { listaEncomendaId: lista.id, produtoId: prod[1] } });
    check(aposRascunho.fornecedorSugeridoId === forY.id, "D3: a linha gravada não foi alterada pela geração da proposta");

    console.log("\nG · grupo / consolidação");
    const g = await generateGroupProposal({ ...input, farmaciaIds: [fA.id, fB.id], farmaciaNames: { [fA.id]: "A", [fB.id]: "B" } }, prisma);
    const gv = (f: string, n: number) => g.rows.find((r) => r.farmaciaId === f && r.produtoId === prod[n])!;
    check(gv(fA.id, 1).fornecedorSugeridoId === forX.id && gv(fB.id, 1).fornecedorSugeridoId === forY.id, "G1: no grupo o mesmo produto mantém um fornecedor DIFERENTE por farmácia");
    check(gv(fA.id, 3).fornecedorSugeridoId === null && gv(fB.id, 3).fornecedorSugeridoId === null, "G2: …e no grupo o texto do ERP também não preenche nada");
    check(gv(fA.id, 2).fornecedorSugeridoId === null, "G3: …nem um habitual inativo");

    console.log("\nI · fornecedor INATIVO em rascunhos e na finalização");
    const { salvarAutosaveEncomenda } = await import("../../lib/encomendas/autosave");
    const { finalizeAndQueueOrder, createEncomendaWithOutbox } = await import("../../lib/ingest/orders");
    const { finalizarNaTransaccao, LinhasSemFornecedorError, FornecedorInativoError } = await import("../../lib/encomendas/finalizar-multi-fornecedor");
    // rascunho com uma linha apontada a um fornecedor que entretanto ficou inativo (nome histórico preservado)
    const forLate = await prisma.fornecedor.create({ data: { nomeNormalizado: "FH-FORN-TARDE", nome: "Forn Tarde", estado: "ATIVO" } });
    const rI = await prisma.listaEncomenda.create({
      data: { farmaciaId: fA.id, nome: "Rascunho inativo", estado: "RASCUNHO", criadoPorId: user.id, linhas: { create: [{ produtoId: prod[1], quantidadeAjustada: 5, fornecedorSugeridoId: forLate.id, origem: "PROPOSTA" }, { produtoId: prod[8], quantidadeAjustada: 5, fornecedorSugeridoId: forX.id, origem: "PROPOSTA" }] } },
    });
    await prisma.fornecedor.update({ where: { id: forLate.id }, data: { estado: "INATIVO" } });
    const dI = await loadOrderDetailComPrisma(prisma, rI.id);
    const lI = dI?.linhas.find((l) => l.produtoId === prod[1]);
    check(lI?.fornecedorSugeridoId === forLate.id && lI?.fornecedorSugeridoNome === "Forn Tarde" && lI?.fornecedorSugeridoInativo === true, "I1: o rascunho mantém o NOME histórico e assinala o fornecedor como inativo");
    check(dI?.linhas.find((l) => l.produtoId === prod[8])?.fornecedorSugeridoInativo === false, "I2: um fornecedor ativo não é assinalado");

    // autosave: escolher um inativo é recusado; manter o já gravado é aceite
    let erroEscolha: unknown = null;
    try { await salvarAutosaveEncomenda(prisma, { listaEncomendaId: rI.id, versaoEsperada: 0, linhas: [{ produtoId: prod[8], fornecedorSugeridoId: forOff.id }] }); } catch (e) { erroEscolha = e; }
    check(erroEscolha instanceof FornecedorInativoError, "I3: autosave RECUSA escolher um fornecedor inativo como novo valor", String(erroEscolha));
    check((await prisma.linhaEncomenda.findFirstOrThrow({ where: { listaEncomendaId: rI.id, produtoId: prod[8] } })).fornecedorSugeridoId === forX.id, "I4: …e a linha ficou intacta");
    const okManter = await salvarAutosaveEncomenda(prisma, { listaEncomendaId: rI.id, versaoEsperada: 0, linhas: [{ produtoId: prod[1], quantidadeAjustada: 7, fornecedorSugeridoId: forLate.id }] });
    check(okManter.gravadas === 1, "I5: manter o fornecedor inativo JÁ gravado não impede gravar outros campos (quantidade)");
    const okTrocar = await salvarAutosaveEncomenda(prisma, { listaEncomendaId: rI.id, versaoEsperada: okManter.versao, linhas: [{ produtoId: prod[1], fornecedorSugeridoId: forY.id }] });
    check(okTrocar.gravadas === 1, "I6: substituir o inativo por um ativo é aceite");
    const okLimpar = await salvarAutosaveEncomenda(prisma, { listaEncomendaId: rI.id, versaoEsperada: okTrocar.versao, linhas: [{ produtoId: prod[1], fornecedorSugeridoId: null }] });
    check(okLimpar.gravadas === 1, "I7: limpar o fornecedor (null) é sempre aceite");
    await prisma.linhaEncomenda.updateMany({ where: { listaEncomendaId: rI.id, produtoId: prod[1] }, data: { fornecedorSugeridoId: forLate.id } });

    // finalização única
    let e1: unknown = null;
    try { await finalizeAndQueueOrder(prisma, "t", rI.id); } catch (e) { e1 = e; }
    check(e1 instanceof FornecedorInativoError && e1 instanceof LinhasSemFornecedorError && (e1 as InstanceType<typeof FornecedorInativoError>).produtoIdsSemFornecedor.includes(prod[1]), "I8: finalização única recusa a linha com fornecedor inativo (e indica o produto)", String(e1));
    // finalização multi-fornecedor (as linhas têm 2 fornecedores distintos)
    let e2: unknown = null;
    try { await prisma.$transaction((tx) => finalizarNaTransaccao(tx, "t", { listaEncomendaId: rI.id, batchKey: "fh-batch-1" })); } catch (e) { e2 = e; }
    check(e2 instanceof FornecedorInativoError, "I9: finalização multi-fornecedor recusa o inativo — nenhum documento gerado", String(e2));
    check((await prisma.listaEncomenda.count({ where: { loteOrigemId: rI.id } })) === 0 && (await prisma.listaEncomenda.findUniqueOrThrow({ where: { id: rI.id } })).estado === "RASCUNHO", "I10: o rascunho continua RASCUNHO, sem lotes nem documentos");
    // criação directa já finalizada
    let e3: unknown = null;
    try { await createEncomendaWithOutbox(prisma, "t", { farmaciaId: fA.id, criadoPorId: user.id, nome: "Directa", finalize: true, linhas: [{ produtoId: prod[1], quantidadeAjustada: 3, fornecedorSugeridoId: forLate.id }] }); } catch (e) { e3 = e; }
    check(e3 instanceof FornecedorInativoError, "I11: criação directa finalizada com fornecedor inativo também é recusada", String(e3));
    // substituído por um ativo → finaliza
    await prisma.linhaEncomenda.updateMany({ where: { listaEncomendaId: rI.id, produtoId: prod[1] }, data: { fornecedorSugeridoId: forY.id } });
    const fin = await prisma.$transaction((tx) => finalizarNaTransaccao(tx, "t", { listaEncomendaId: rI.id, batchKey: "fh-batch-2" }));
    check(fin.documentos.length === 2, "I12: depois de substituído por um ativo, a finalização gera os 2 documentos", JSON.stringify(fin.documentos.map((d) => d.fornecedorNome)));
    check((await prisma.produtoFarmacia.count({ where: { fornecedorHabitualId: forLate.id } })) === 0, "I13: nada foi trocado automaticamente nem escrito em ProdutoFarmacia");

    console.log("\nX · o diagnóstico (read-only) identifica a coincidência que a proposta NÃO usa");
    const { diagnosticarCobertura } = await import("../../scripts/diagnostics/fornecedor-habitual-cobertura");
    const antesDiag = JSON.stringify(await prisma.produtoFarmacia.findMany({ orderBy: [{ produtoId: "asc" }, { farmaciaId: "asc" }], select: { produtoId: true, farmaciaId: true, fornecedorHabitualId: true, fornecedorOrigem: true } }));
    const diag = await diagnosticarCobertura(prisma);
    const dA = diag.porFarmacia.find((x) => x.farmacia === "FH Silveirense")!.contagens;
    check(dA.TEXTO_CANONICO === 1, "X1: o diagnóstico vê 1 correspondência CANÓNICA possível (P3: texto == nome de Forn W) — e a proposta deixou-a «Sem fornecedor»");
    check(dA.TEXTO_ALIAS === 1, "X2: …1 correspondência por ALIAS inequívoco (P4)");
    check(dA.TEXTO_AMBIGUO === 1, "X3: …1 correspondência AMBÍGUA (P5)");
    check(dA.TEXTO_SEM_FORNECEDOR === 1, "X4: …1 fornecedor inexistente (P6)");
    check(dA.HABITUAL_INATIVO === 1 && dA.HABITUAL_ATIVO >= 2, "X5: …o habitual inativo (P2) e os ativos são contados à parte");
    const depoisDiag = JSON.stringify(await prisma.produtoFarmacia.findMany({ orderBy: [{ produtoId: "asc" }, { farmaciaId: "asc" }], select: { produtoId: true, farmaciaId: true, fornecedorHabitualId: true, fornecedorOrigem: true } }));
    check(antesDiag === depoisDiag, "X6: o diagnóstico não escreveu nada");
    const pa3 = await generateOrderProposal({ ...input, farmaciaId: fA.id, farmaciaNome: "A" }, prisma);
    check(pa3.rows.find((r) => r.produtoId === prod[3])!.fornecedorSugeridoId === null, "X7: depois do diagnóstico a proposta continua «Sem fornecedor» (o diagnóstico não influencia a proposta)");
    const { readFileSync } = await import("node:fs");
    const fonteProposta = readFileSync("lib/encomendas/proposal.ts", "utf8");
    check(!/resolverFornecedoresPorTexto|fornecedorOrigem[^\n]*fornecedorSugeridoId|TEXTO_ERP/.test(fonteProposta), "X8: proposal.ts não contém nenhuma resolução por texto do ERP");

    await prisma.$disconnect();
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.end();
  }
  console.log(`\n${passed} ok, ${failed} falhas`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
