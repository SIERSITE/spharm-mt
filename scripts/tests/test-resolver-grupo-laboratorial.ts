/**
 * scripts/tests/test-resolver-grupo-laboratorial.ts
 *
 * Testa lib/catalog/resolver-grupo-laboratorial.ts — os 6 níveis de
 * precedência, isoladamente e em combinação, incluindo os casos
 * explicitamente pedidos: Pfizer só entra em VIATRIS com regra por CNP
 * (nunca por associação integral do fabricante), alias ambíguo nunca
 * classifica, registo histórico nunca gera classificação automática.
 *
 * Corre com: npx tsx scripts/tests/test-resolver-grupo-laboratorial.ts
 */
import { readFileSync } from "node:fs";
import {
  resolverGrupoDoProduto,
  resolverGruposEmLote,
  ORIGEM_POR_TIPO,
  type MapasResolverGrupo,
  type ProdutoParaResolver,
  type FabricanteParaResolver,
  type RegraCnpParaResolver,
  type SnapshotParaResolver,
  type GrupoFabricanteParaResolver,
  type AliasParaResolver,
} from "../../lib/catalog/resolver-grupo-laboratorial";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const eq = <T,>(a: T, b: T, label: string) =>
  check(JSON.stringify(a) === JSON.stringify(b), label, `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);

function mapasVazios(): MapasResolverGrupo {
  return {
    fabricantesPorId: new Map(),
    fabricantesPorNomeNormalizado: new Map(),
    regrasCnpPorCnp: new Map(),
    snapshotsPorCnp: new Map(),
    gruposFabricantePorFabricanteId: new Map(),
    aliasesPorNomeNormalizado: new Map(),
  };
}

console.log("A · nível 6 (sem grupo) — mapas vazios, nunca lança excepção");
{
  const produto: ProdutoParaResolver = { id: "p1", cnp: 2000001, fabricanteId: null };
  const r = resolverGrupoDoProduto(produto, mapasVazios());
  eq(r.tipo, "sem_grupo", "A1: sem nenhum sinal, cai em sem_grupo");
}

console.log("\nB · nível 1 (manual) — vence TUDO, mesmo com sinais fortes de outros níveis");
{
  const mapas = mapasVazios();
  const fabricantesPorId = new Map<string, FabricanteParaResolver>([["fPfizer", { id: "fPfizer", nomeNormalizado: "LABORATORIOS PFIZER" }]]);
  const gruposFabricantePorFabricanteId = new Map<string, GrupoFabricanteParaResolver>([["fPfizer", { grupoLaboratorialId: "gViatris" }]]);
  const produto: ProdutoParaResolver = {
    id: "p1", cnp: 2000001, fabricanteId: "fPfizer",
    grupoExistente: { grupoLaboratorialId: "gOutroQualquer", validadoManualmente: true },
  };
  const r = resolverGrupoDoProduto(produto, { ...mapas, fabricantesPorId, gruposFabricantePorFabricanteId });
  eq(r.tipo, "mantido_manual", "B1: nível 1 vence mesmo com fabricante_inequivoco disponível");
  if (r.tipo === "mantido_manual") eq(r.grupoLaboratorialId, "gOutroQualquer", "B2: mantém o grupo manual, não o do fabricante");
}
{
  // grupo existente mas SEM validadoManualmente=true — não conta como nível 1.
  const produto: ProdutoParaResolver = { id: "p1", cnp: 2000001, fabricanteId: null, grupoExistente: { grupoLaboratorialId: "gX", validadoManualmente: false } };
  const r = resolverGrupoDoProduto(produto, mapasVazios());
  eq(r.tipo, "sem_grupo", "B3: grupo existente sem validadoManualmente=true NÃO conta como nível 1");
}

console.log("\nC · nível 2 (regra por CNP) — só se estado=ATIVO E validadoManualmente=true");
{
  const regrasCnpPorCnp = new Map<number, RegraCnpParaResolver>([[2000001, { id: "r1", grupoLaboratorialId: "gViatris", estado: "ATIVO", validadoManualmente: true }]]);
  const produto: ProdutoParaResolver = { id: "p1", cnp: 2000001, fabricanteId: null };
  const r = resolverGrupoDoProduto(produto, { ...mapasVazios(), regrasCnpPorCnp });
  eq(r.tipo, "regra_cnp", "C1: regra activa e validada classifica");
  if (r.tipo === "regra_cnp") { eq(r.grupoLaboratorialId, "gViatris", "C2: grupo correcto"); eq(r.regraCnpId, "r1", "C3: id da regra preservado"); }
}
{
  const regrasCnpPorCnp = new Map<number, RegraCnpParaResolver>([[2000001, { id: "r1", grupoLaboratorialId: "gViatris", estado: "ATIVO", validadoManualmente: false }]]);
  const produto: ProdutoParaResolver = { id: "p1", cnp: 2000001, fabricanteId: null };
  const r = resolverGrupoDoProduto(produto, { ...mapasVazios(), regrasCnpPorCnp });
  eq(r.tipo, "sem_grupo", "C4: regra NÃO validada nunca classifica (cai para níveis seguintes, que também falham aqui)");
}
{
  const regrasCnpPorCnp = new Map<number, RegraCnpParaResolver>([[2000001, { id: "r1", grupoLaboratorialId: "gViatris", estado: "INATIVO", validadoManualmente: true }]]);
  const produto: ProdutoParaResolver = { id: "p1", cnp: 2000001, fabricanteId: null };
  const r = resolverGrupoDoProduto(produto, { ...mapasVazios(), regrasCnpPorCnp });
  eq(r.tipo, "sem_grupo", "C5: regra INATIVA nunca classifica");
}

console.log("\nD · nível 3 (proposta snapshot) — só de estado ACTUAL, e nunca aplica sozinho (é só proposta)");
{
  const fabricantesPorNomeNormalizado = new Map<string, FabricanteParaResolver>([["VIATRIS HEALTHCARE LDA", { id: "fViatrisH", nomeNormalizado: "VIATRIS HEALTHCARE LDA" }]]);
  const gruposFabricantePorFabricanteId = new Map<string, GrupoFabricanteParaResolver>([["fViatrisH", { grupoLaboratorialId: "gViatris" }]]);
  const snapshotsPorCnp = new Map<number, SnapshotParaResolver>([[2000001, { cnp: 2000001, titularAim: "Viatris Healthcare, Lda.", estadoAim: "Ativo" }]]);
  const produto: ProdutoParaResolver = { id: "p1", cnp: 2000001, fabricanteId: null };
  const r = resolverGrupoDoProduto(produto, { ...mapasVazios(), fabricantesPorNomeNormalizado, gruposFabricantePorFabricanteId, snapshotsPorCnp });
  eq(r.tipo, "proposta_snapshot_cnp", "D1: snapshot actual com titular mapeado a um grupo → proposta");
  if (r.tipo === "proposta_snapshot_cnp") { eq(r.grupoLaboratorialId, "gViatris", "D2: grupo correcto"); eq(r.snapshotCnp, 2000001, "D3: cnp do snapshot preservado"); }
}
{
  // registo HISTÓRICO — nunca gera proposta.
  const fabricantesPorNomeNormalizado = new Map<string, FabricanteParaResolver>([["VIATRIS HEALTHCARE LDA", { id: "fViatrisH", nomeNormalizado: "VIATRIS HEALTHCARE LDA" }]]);
  const gruposFabricantePorFabricanteId = new Map<string, GrupoFabricanteParaResolver>([["fViatrisH", { grupoLaboratorialId: "gViatris" }]]);
  for (const estadoHistorico of ["Anulado", "Revogado", "Suspenso", "Retirado pela Entidade Reguladora", "", null]) {
    const snapshotsPorCnp = new Map<number, SnapshotParaResolver>([[2000001, { cnp: 2000001, titularAim: "Viatris Healthcare, Lda.", estadoAim: estadoHistorico }]]);
    const produto: ProdutoParaResolver = { id: "p1", cnp: 2000001, fabricanteId: null };
    const r = resolverGrupoDoProduto(produto, { ...mapasVazios(), fabricantesPorNomeNormalizado, gruposFabricantePorFabricanteId, snapshotsPorCnp });
    eq(r.tipo, "sem_grupo", `D4 (estado="${estadoHistorico}"): registo histórico NUNCA gera classificação automática`);
  }
}
{
  // titular do snapshot não corresponde a NENHUM Fabricante conhecido — sem proposta, nunca inventa.
  const snapshotsPorCnp = new Map<number, SnapshotParaResolver>([[2000001, { cnp: 2000001, titularAim: "Empresa Desconhecida Lda", estadoAim: "Ativo" }]]);
  const produto: ProdutoParaResolver = { id: "p1", cnp: 2000001, fabricanteId: null };
  const r = resolverGrupoDoProduto(produto, { ...mapasVazios(), snapshotsPorCnp });
  eq(r.tipo, "sem_grupo", "D5: titular sem Fabricante conhecido correspondente nunca inventa uma classificação");
}

console.log("\nE · nível 4 (fabricante inequívoco) — seguro para aplicar automaticamente");
{
  const gruposFabricantePorFabricanteId = new Map<string, GrupoFabricanteParaResolver>([["fMylan", { grupoLaboratorialId: "gViatris" }]]);
  const produto: ProdutoParaResolver = { id: "p1", cnp: 2000001, fabricanteId: "fMylan" };
  const r = resolverGrupoDoProduto(produto, { ...mapasVazios(), gruposFabricantePorFabricanteId });
  eq(r.tipo, "fabricante_inequivoco", "E1: fabricante integralmente no grupo classifica directamente");
  if (r.tipo === "fabricante_inequivoco") eq(r.grupoLaboratorialId, "gViatris", "E2: grupo correcto");
}

console.log("\nF · o caso Pfizer explícito — só entra em VIATRIS com regra por CNP, NUNCA por associação integral");
{
  // Pfizer não tem GrupoLaboratorialFabricante (é uma empresa grande, distinta) — só uma RegraGrupoLaboratorialPorCnp para ESTE cnp específico.
  const fabricantesPorId = new Map<string, FabricanteParaResolver>([["fPfizer", { id: "fPfizer", nomeNormalizado: "LABORATORIOS PFIZER" }]]);
  const regrasCnpPorCnp = new Map<number, RegraCnpParaResolver>([[2000042, { id: "rPfizer42", grupoLaboratorialId: "gViatris", estado: "ATIVO", validadoManualmente: true }]]);

  const produtoComRegra: ProdutoParaResolver = { id: "pComRegra", cnp: 2000042, fabricanteId: "fPfizer" };
  const rComRegra = resolverGrupoDoProduto(produtoComRegra, { ...mapasVazios(), fabricantesPorId, regrasCnpPorCnp });
  eq(rComRegra.tipo, "regra_cnp", "F1: produto Pfizer COM regra específica por CNP entra em Viatris");
  if (rComRegra.tipo === "regra_cnp") eq(rComRegra.grupoLaboratorialId, "gViatris", "F2: grupo correcto");

  const produtoSemRegra: ProdutoParaResolver = { id: "pSemRegra", cnp: 2000099, fabricanteId: "fPfizer" };
  const rSemRegra = resolverGrupoDoProduto(produtoSemRegra, { ...mapasVazios(), fabricantesPorId, regrasCnpPorCnp });
  eq(rSemRegra.tipo, "sem_grupo", "F3: OUTRO produto Pfizer, SEM regra para o seu CNP, NÃO entra em Viatris");
}

console.log("\nG · nível 5 (alias inequívoco) — só quando bate um único grupo");
{
  const fabricantesPorId = new Map<string, FabricanteParaResolver>([["fMsd", { id: "fMsd", nomeNormalizado: "MSD" }]]);
  const aliasesPorNomeNormalizado = new Map<string, AliasParaResolver[]>([["MSD", [{ grupoLaboratorialId: "gOrganon", estado: "ATIVO" }]]]);
  const produto: ProdutoParaResolver = { id: "p1", cnp: 2000001, fabricanteId: "fMsd" };
  const r = resolverGrupoDoProduto(produto, { ...mapasVazios(), fabricantesPorId, aliasesPorNomeNormalizado });
  eq(r.tipo, "alias_inequivoco", "G1: alias único classifica");
  if (r.tipo === "alias_inequivoco") eq(r.grupoLaboratorialId, "gOrganon", "G2: grupo correcto");
}
{
  // alias presente em DOIS grupos → ambíguo, nunca classifica.
  const fabricantesPorId = new Map<string, FabricanteParaResolver>([["fX", { id: "fX", nomeNormalizado: "NOME AMBIGUO" }]]);
  const aliasesPorNomeNormalizado = new Map<string, AliasParaResolver[]>([
    ["NOME AMBIGUO", [
      { grupoLaboratorialId: "gA", estado: "ATIVO" },
      { grupoLaboratorialId: "gB", estado: "ATIVO" },
    ]],
  ]);
  const produto: ProdutoParaResolver = { id: "p1", cnp: 2000001, fabricanteId: "fX" };
  const r = resolverGrupoDoProduto(produto, { ...mapasVazios(), fabricantesPorId, aliasesPorNomeNormalizado });
  eq(r.tipo, "sem_grupo", "G3: alias presente em DOIS grupos é considerado ambíguo — nunca classifica automaticamente");
}
{
  // alias INATIVO não conta para o cômputo de ambiguidade nem classifica.
  const fabricantesPorId = new Map<string, FabricanteParaResolver>([["fX", { id: "fX", nomeNormalizado: "NOME X" }]]);
  const aliasesPorNomeNormalizado = new Map<string, AliasParaResolver[]>([
    ["NOME X", [
      { grupoLaboratorialId: "gA", estado: "ATIVO" },
      { grupoLaboratorialId: "gB", estado: "INATIVO" },
    ]],
  ]);
  const produto: ProdutoParaResolver = { id: "p1", cnp: 2000001, fabricanteId: "fX" };
  const r = resolverGrupoDoProduto(produto, { ...mapasVazios(), fabricantesPorId, aliasesPorNomeNormalizado });
  eq(r.tipo, "alias_inequivoco", "G4: um alias INATIVO não conta — só 1 activo, classifica normalmente");
  if (r.tipo === "alias_inequivoco") eq(r.grupoLaboratorialId, "gA", "G5: grupo do alias activo");
}

console.log("\nH · produtos fora do universo INFARMED (cnp <= 2.000.000) — nunca são tratados de forma especial/excluídos");
{
  // Um produto com cnp baixo (fora do snapshot) continua a poder classificar por qualquer nível que NÃO dependa do snapshot.
  const gruposFabricantePorFabricanteId = new Map<string, GrupoFabricanteParaResolver>([["fMylan", { grupoLaboratorialId: "gViatris" }]]);
  const produtoForaInfarmed: ProdutoParaResolver = { id: "p1", cnp: 4, fabricanteId: "fMylan" }; // cnp interno/provisório, tipo os 5096 encontrados na análise
  const r = resolverGrupoDoProduto(produtoForaInfarmed, { ...mapasVazios(), gruposFabricantePorFabricanteId });
  eq(r.tipo, "fabricante_inequivoco", "H1: produto com cnp interno continua classificável por fabricante inequívoco — não é excluído por ser 'fora do INFARMED'");

  // Sem nenhum sinal, cai em sem_grupo — mas NUNCA lança excepção nem é omitido do relatório (não "eliminado").
  const produtoForaSemSinal: ProdutoParaResolver = { id: "p2", cnp: 12, fabricanteId: null };
  const r2 = resolverGrupoDoProduto(produtoForaSemSinal, mapasVazios());
  eq(r2.tipo, "sem_grupo", "H2: sem sinal nenhum, vai para revisão — continua presente no resultado, nunca 'desaparece'");
}

console.log("\nI · resolverGruposEmLote — totais batem com os resultados individuais, nada é perdido");
{
  const gruposFabricantePorFabricanteId = new Map<string, GrupoFabricanteParaResolver>([["fMylan", { grupoLaboratorialId: "gViatris" }]]);
  const produtos: ProdutoParaResolver[] = [
    { id: "p1", cnp: 1, fabricanteId: "fMylan" },
    { id: "p2", cnp: 2, fabricanteId: null },
    { id: "p3", cnp: 3, fabricanteId: null, grupoExistente: { grupoLaboratorialId: "gX", validadoManualmente: true } },
  ];
  const relatorio = resolverGruposEmLote(produtos, { ...mapasVazios(), gruposFabricantePorFabricanteId });
  eq(relatorio.totais.produtos, 3, "I1: total de produtos");
  eq(relatorio.totais.fabricanteInequivoco, 1, "I2: 1 fabricante_inequivoco");
  eq(relatorio.totais.mantidoManual, 1, "I3: 1 mantido_manual");
  eq(relatorio.totais.semGrupo, 1, "I4: 1 sem_grupo");
  eq(relatorio.resultados.length, 3, "I5: nenhum produto perdido — 3 resultados para 3 produtos");
}

console.log("\nJ · ORIGEM_POR_TIPO cobre os 5 níveis não-terminais, valores exactos gravados em ProdutoGrupoLaboratorial.origem");
{
  eq(ORIGEM_POR_TIPO.mantido_manual, "MANUAL", "J1");
  eq(ORIGEM_POR_TIPO.regra_cnp, "REGRA_CNP", "J2");
  eq(ORIGEM_POR_TIPO.proposta_snapshot_cnp, "SNAPSHOT_CNP", "J3");
  eq(ORIGEM_POR_TIPO.fabricante_inequivoco, "FABRICANTE_INEQUIVOCO", "J4");
  eq(ORIGEM_POR_TIPO.alias_inequivoco, "ALIAS_INEQUIVOCO", "J5");
}

console.log("\nK · este ficheiro NUNCA referencia escrita em Produto.fabricanteId (verificação estática)");
{
  const src = readFileSync(new URL("../../lib/catalog/resolver-grupo-laboratorial.ts", import.meta.url), "utf8");
  check(!/\.update\(|\.upsert\(|\.create\(|\.updateMany\(|\.createMany\(/.test(src), "K1: nenhuma escrita Prisma neste ficheiro (é 100% puro)");
  check(!/prisma\.|tx\./.test(src), "K2: nenhuma referência a um cliente Prisma — confirma que é puro, sem I/O");
}

console.log(`\n${ok} ok, ${ko} falhas`);
process.exit(ko === 0 ? 0 : 1);
