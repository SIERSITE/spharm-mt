/**
 * scripts/tests/test-propostas-fabricante-por-cnp.ts
 *
 * Testa lib/catalog/propostas-fabricante-por-cnp.ts — separado da
 * classificação de grupo. Confirma as duas contagens da análise (447
 * "actuais" vs. 146 "só históricos") ao nível da REGRA, não do número
 * absoluto (esse número é uma propriedade dos dados reais, testado no
 * dry-run real, não aqui).
 *
 * Corre com: npx tsx scripts/tests/test-propostas-fabricante-por-cnp.ts
 */
import {
  resolverPropostaFabricante,
  resolverPropostasFabricanteEmLote,
  type ProdutoSemFabricanteParaResolver,
  type SnapshotParaPropostaFabricante,
  type FabricanteParaPropostaFabricante,
} from "../../lib/catalog/propostas-fabricante-por-cnp";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const eq = <T,>(a: T, b: T, label: string) =>
  check(JSON.stringify(a) === JSON.stringify(b), label, `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);

console.log("A · protegido_manual vence tudo — fabricanteId em camposManuais");
{
  const produto: ProdutoSemFabricanteParaResolver = { id: "p1", cnp: 2000001, camposManuais: ["fabricanteId"] };
  const snapshotsPorCnp = new Map<number, SnapshotParaPropostaFabricante>([[2000001, { titularAim: "Qualquer Lda", estadoAim: "Ativo" }]]);
  const fabricantesPorNomeNormalizado = new Map<string, FabricanteParaPropostaFabricante>([["QUALQUER LDA", { id: "f1", nomeNormalizado: "QUALQUER LDA" }]]);
  const r = resolverPropostaFabricante(produto, snapshotsPorCnp, fabricantesPorNomeNormalizado);
  eq(r.tipo, "protegido_manual", "A1: mesmo com um match perfeito no snapshot, camposManuais bloqueia qualquer proposta");
}

console.log("\nB · proposta_atual — o padrão dos 447 (registo com estado ACTUAL e titular reconhecido)");
{
  const produto: ProdutoSemFabricanteParaResolver = { id: "p1", cnp: 2000001, camposManuais: [] };
  for (const estadoAtual of ["Ativo", "Activo", "Autorizado"]) {
    const snapshotsPorCnp = new Map<number, SnapshotParaPropostaFabricante>([[2000001, { titularAim: "Bayer Portugal, Lda.", estadoAim: estadoAtual }]]);
    const fabricantesPorNomeNormalizado = new Map<string, FabricanteParaPropostaFabricante>([["BAYER PORTUGAL LDA", { id: "fBayer", nomeNormalizado: "BAYER PORTUGAL LDA" }]]);
    const r = resolverPropostaFabricante(produto, snapshotsPorCnp, fabricantesPorNomeNormalizado);
    eq(r.tipo, "proposta_atual", `B1 (estado="${estadoAtual}"): classifica como proposta_atual`);
    if (r.tipo === "proposta_atual") eq(r.fabricanteId, "fBayer", "B2: fabricanteId correcto");
  }
}

console.log("\nC · revisao_historico — o padrão dos 146 (só registo histórico, NUNCA preenche automaticamente)");
{
  const produto: ProdutoSemFabricanteParaResolver = { id: "p1", cnp: 2000001, camposManuais: [] };
  for (const estadoHistorico of ["Anulado", "Revogado", "Suspenso", "Retirado pela Entidade Reguladora", ""]) {
    const snapshotsPorCnp = new Map<number, SnapshotParaPropostaFabricante>([[2000001, { titularAim: "Bayer Portugal, Lda.", estadoAim: estadoHistorico }]]);
    const fabricantesPorNomeNormalizado = new Map<string, FabricanteParaPropostaFabricante>([["BAYER PORTUGAL LDA", { id: "fBayer", nomeNormalizado: "BAYER PORTUGAL LDA" }]]);
    const r = resolverPropostaFabricante(produto, snapshotsPorCnp, fabricantesPorNomeNormalizado);
    eq(r.tipo, "revisao_historico", `C1 (estado="${estadoHistorico}"): vai para revisão obrigatória, nunca proposta automática`);
  }
}

console.log("\nD · sem_correspondencia — sem registo, sem titular, ou titular não reconhecido");
{
  const produto: ProdutoSemFabricanteParaResolver = { id: "p1", cnp: 2000001, camposManuais: [] };
  const semRegisto = resolverPropostaFabricante(produto, new Map(), new Map());
  eq(semRegisto.tipo, "sem_correspondencia", "D1: sem registo no catálogo");

  const snapshotsPorCnp2 = new Map<number, SnapshotParaPropostaFabricante>([[2000001, { titularAim: null, estadoAim: "Ativo" }]]);
  const semTitular = resolverPropostaFabricante(produto, snapshotsPorCnp2, new Map());
  eq(semTitular.tipo, "sem_correspondencia", "D2: registo actual mas sem titular");

  const snapshotsPorCnp3 = new Map<number, SnapshotParaPropostaFabricante>([[2000001, { titularAim: "Empresa Desconhecida Lda", estadoAim: "Ativo" }]]);
  const titularDesconhecido = resolverPropostaFabricante(produto, snapshotsPorCnp3, new Map());
  eq(titularDesconhecido.tipo, "sem_correspondencia", "D3: titular actual mas sem Fabricante correspondente conhecido — nunca inventa");
}

console.log("\nE · resolverPropostasFabricanteEmLote — as contagens agregadas batem, nenhum produto perdido");
{
  const produtos: ProdutoSemFabricanteParaResolver[] = [
    { id: "p1", cnp: 1, camposManuais: ["fabricanteId"] },
    { id: "p2", cnp: 2, camposManuais: [] },
    { id: "p3", cnp: 3, camposManuais: [] },
    { id: "p4", cnp: 4, camposManuais: [] },
  ];
  const snapshotsPorCnp = new Map<number, SnapshotParaPropostaFabricante>([
    [2, { titularAim: "Bayer Portugal, Lda.", estadoAim: "Ativo" }],
    [3, { titularAim: "Bayer Portugal, Lda.", estadoAim: "Anulado" }],
    // cnp 4 sem registo nenhum
  ]);
  const fabricantesPorNomeNormalizado = new Map<string, FabricanteParaPropostaFabricante>([["BAYER PORTUGAL LDA", { id: "fBayer", nomeNormalizado: "BAYER PORTUGAL LDA" }]]);
  const relatorio = resolverPropostasFabricanteEmLote(produtos, snapshotsPorCnp, fabricantesPorNomeNormalizado);
  eq(relatorio.totais.total, 4, "E1: total");
  eq(relatorio.totais.protegidoManual, 1, "E2: protegido manual");
  eq(relatorio.totais.propostaAtual, 1, "E3: proposta actual");
  eq(relatorio.totais.revisaoHistorico, 1, "E4: revisão histórico");
  eq(relatorio.totais.semCorrespondencia, 1, "E5: sem correspondência");
  eq(relatorio.resultados.length, 4, "E6: nenhum produto perdido — 4 resultados para 4 produtos (os 5096 fora do INFARMED continuam presentes, não são eliminados)");
}

console.log(`\n${ok} ok, ${ko} falhas`);
process.exit(ko === 0 ? 0 : 1);
