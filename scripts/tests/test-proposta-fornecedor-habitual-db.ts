/**
 * scripts/tests/test-proposta-fornecedor-habitual-db.ts
 *
 * PostgreSQL REAL e DESCARTÁVEL (recusa correr fora de localhost):
 *
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:55494/postgres npx tsx scripts/tests/test-proposta-fornecedor-habitual-db.ts
 *
 * O fornecedor HABITUAL é por produto E por farmácia: a fonte de verdade é
 * `ProdutoFarmacia.fornecedorHabitualId`. A proposta usa-o como sugestão
 * INICIAL de cada linha:
 *
 *   H  o mesmo produto tem fornecedores diferentes nas duas farmácias e cada
 *      linha recebe o da SUA farmácia (nunca copiado de uma para a outra);
 *   N  fornecedor habitual INACTIVO: a linha mantém o id E o nome, assinalada
 *      (antes ficava com id e sem nome, invisível na UI);
 *   T  habitual por preencher mas o NOME do fornecedor habitual do ERP
 *      (`fornecedorOrigem`) corresponde sem ambiguidade a um Fornecedor
 *      existente → sugestão `TEXTO_ERP`; nome ambíguo ou desconhecido → sem
 *      fornecedor; nunca se inventa uma correspondência;
 *   R  tudo isto é SÓ LEITURA: `ProdutoFarmacia` nunca é escrito pela proposta;
 *   D  um rascunho já gravado prevalece sobre o habitual;
 *   G  o modo grupo (e a consolidação) devolvem o mesmo por farmácia.
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
    check(rowA(1).fornecedorSugeridoFonte === "HABITUAL" && rowB(1).fornecedorSugeridoFonte === "HABITUAL", "H3: a fonte é o habitual de ProdutoFarmacia");
    check(rowA(8).fornecedorSugeridoId === forX.id && rowB(8).fornecedorSugeridoId === null, "H4: P8 tem habitual só na Silveirense — o Segurado fica EXPLICITAMENTE sem fornecedor (não herda)");
    check(rowB(7).fornecedorSugeridoId === null && rowB(7).fornecedorSugeridoNome == null, "H5: sem habitual e sem texto → sem fornecedor");

    console.log("\nN · habitual INACTIVO");
    check(rowA(2).fornecedorSugeridoId === forOff.id && rowA(2).fornecedorSugeridoNome === "Forn Inativo" && rowA(2).fornecedorSugeridoEstado === "INATIVO", "N1: o habitual inactivo mantém id, NOME e estado INATIVO (antes: id sem nome)");
    check(rowA(1).fornecedorSugeridoEstado === "ATIVO", "N2: um habitual activo vem como ATIVO");

    console.log("\nT · nome do fornecedor habitual do ERP, só com evidência");
    check(rowA(3).fornecedorSugeridoId === forW.id && rowA(3).fornecedorSugeridoFonte === "TEXTO_ERP", "T1: texto == nome canónico de um Fornecedor → resolvido (TEXTO_ERP)");
    check(rowA(4).fornecedorSugeridoId === forW.id && rowA(4).fornecedorSugeridoFonte === "TEXTO_ERP", "T2: texto == alias que aponta para UM só fornecedor → resolvido");
    check(rowA(5).fornecedorSugeridoId === null && rowB(5).fornecedorSugeridoId === null, "T3: alias AMBÍGUO (aponta para dois fornecedores) → sem fornecedor, nunca adivinhado");
    check(rowA(6).fornecedorSugeridoId === null, "T4: texto desconhecido → sem fornecedor");
    check(rowB(3).fornecedorSugeridoId === null && rowB(4).fornecedorSugeridoId === null, "T5: cada farmácia resolve o SEU texto — o Segurado (sem texto) não herda o da Silveirense");
    check(rowA(1).fornecedorSugeridoFonte === "HABITUAL", "T6: o habitual (quando existe) prevalece sobre o texto");

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
    check(gv(fA.id, 3).fornecedorSugeridoFonte === "TEXTO_ERP" && gv(fB.id, 3).fornecedorSugeridoId === null, "G2: …e a resolução pelo texto também é por farmácia");

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
