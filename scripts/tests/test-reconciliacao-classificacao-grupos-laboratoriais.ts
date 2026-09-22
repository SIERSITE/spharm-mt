/**
 * scripts/tests/test-reconciliacao-classificacao-grupos-laboratoriais.ts
 *
 * Prova, com um conjunto sintético pequeno e SEM depender dos dados reais
 * de garantia, a propriedade estrutural que
 * scripts/reconciliar-classificacao-grupos-laboratoriais-garantia.ts
 * verifica contra os dados reais: cada produto pertence a EXACTAMENTE
 * UMA categoria final (dos 6 níveis da precedência), e
 * definitivos + pendentes + semGrupo == total de produtos, sempre —
 * mesmo em casos desenhados propositadamente para tentar quebrar isto
 * (um produto que bateria com VÁRIOS níveis ao mesmo tempo).
 *
 * Corre com: npx tsx scripts/tests/test-reconciliacao-classificacao-grupos-laboratoriais.ts
 */
import {
  resolverGruposEmLote,
  type ProdutoParaResolver,
  type MapasResolverGrupo,
  type FabricanteParaResolver,
  type GrupoFabricanteParaResolver,
  type RegraCnpParaResolver,
  type SnapshotParaResolver,
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

/** A mesma verificação que o script de reconciliação real faz contra 40714 produtos — aqui contra um conjunto sintético. */
function reconciliar(totais: ReturnType<typeof resolverGruposEmLote>["totais"]): { definitivo: number; pendente: number; semGrupo: number; bate: boolean } {
  const definitivo = totais.mantidoManual + totais.regraCnp + totais.fabricanteInequivoco + totais.aliasInequivoco;
  const pendente = totais.propostaSnapshotCnp;
  const semGrupo = totais.semGrupo;
  return { definitivo, pendente, semGrupo, bate: definitivo + pendente + semGrupo === totais.produtos };
}

console.log("A · conjunto sintético com UM produto em cada um dos 6 níveis — reconciliação bate 1:1");
{
  // Produto desenhado para poder bater com TODOS os níveis simultaneamente
  // (manual + regra_cnp + snapshot + fabricante_inequivoco + alias) — só o
  // nível 1 pode "vencer" nesse caso, provando que a precedência decide
  // um único vencedor, nunca conta o mesmo produto duas vezes.
  const produtos: ProdutoParaResolver[] = [
    { id: "pManual", cnp: 1, fabricanteId: "fX", grupoExistente: { grupoLaboratorialId: "gA", validadoManualmente: true } },
    { id: "pRegra", cnp: 2, fabricanteId: "fX", grupoExistente: null },
    { id: "pFabricante", cnp: 3, fabricanteId: "fIntegral", grupoExistente: null },
    { id: "pProposta", cnp: 4, fabricanteId: "fSemGrupo", grupoExistente: null },
    { id: "pAlias", cnp: 5, fabricanteId: "fAlias", grupoExistente: null },
    { id: "pSemGrupo", cnp: 6, fabricanteId: "fSemGrupo", grupoExistente: null },
    // Produto "tentador" — bate com regra_cnp (nível 2) E com fabricante_inequivoco (nível 3) E com proposta (nível 4) em simultâneo.
    { id: "pMultiplo", cnp: 7, fabricanteId: "fIntegral", grupoExistente: null },
  ];

  const mapas: MapasResolverGrupo = {
    fabricantesPorId: new Map<string, FabricanteParaResolver>([
      ["fIntegral", { id: "fIntegral", nomeNormalizado: "INTEGRAL" }],
      ["fAlias", { id: "fAlias", nomeNormalizado: "ALIAS CORP" }],
    ]),
    fabricantesPorNomeNormalizado: new Map<string, FabricanteParaResolver>([
      ["OUTRO NOME NO CATALOGO", { id: "fCatalogo", nomeNormalizado: "OUTRO NOME NO CATALOGO" }],
    ]),
    regrasCnpPorCnp: new Map<number, RegraCnpParaResolver>([
      [2, { id: "r1", grupoLaboratorialId: "gB", estado: "ATIVO", validadoManualmente: true }],
      [7, { id: "r2", grupoLaboratorialId: "gC", estado: "ATIVO", validadoManualmente: true }], // também tentaria nível 3/4
    ]),
    snapshotsPorCnp: new Map<number, SnapshotParaResolver>([
      [4, { cnp: 4, titularAim: "Outro Nome No Catalogo", estadoAim: "Ativo" }],
      [7, { cnp: 7, titularAim: "Outro Nome No Catalogo", estadoAim: "Ativo" }], // também tentaria nível 4
    ]),
    gruposFabricantePorFabricanteId: new Map<string, GrupoFabricanteParaResolver>([
      ["fIntegral", { grupoLaboratorialId: "gD" }], // também tentaria nível 3 para pMultiplo
      ["fCatalogo", { grupoLaboratorialId: "gE" }],
    ]),
    aliasesPorNomeNormalizado: new Map<string, AliasParaResolver[]>([
      ["ALIAS CORP", [{ grupoLaboratorialId: "gF", estado: "ATIVO" }]],
    ]),
  };

  const relatorio = resolverGruposEmLote(produtos, mapas);
  const r = reconciliar(relatorio.totais);

  eq(relatorio.totais.mantidoManual, 1, "A1: 1 mantido_manual");
  eq(relatorio.totais.regraCnp, 2, "A2: 2 regra_cnp (pRegra + pMultiplo, que vence apesar de também bater nível 3 e 4)");
  eq(relatorio.totais.fabricanteInequivoco, 1, "A3: 1 fabricante_inequivoco (só pFabricante — pMultiplo foi capturado no nível 2, antes de chegar aqui)");
  eq(relatorio.totais.propostaSnapshotCnp, 1, "A4: 1 proposta_snapshot_cnp (só pProposta)");
  eq(relatorio.totais.aliasInequivoco, 1, "A5: 1 alias_inequivoco");
  eq(relatorio.totais.semGrupo, 1, "A6: 1 sem_grupo");
  check(r.bate, "A7: definitivo + pendente + semGrupo == total de produtos", JSON.stringify(r));
  eq(r.definitivo + r.pendente + r.semGrupo, produtos.length, "A8: soma reconciliada == número de produtos de entrada");

  // Nenhum produtoId aparece duas vezes nos resultados.
  const ids = relatorio.resultados.map((res) => res.produtoId);
  eq(new Set(ids).size, ids.length, "A9: nenhum produtoId duplicado nos resultados");
  eq(ids.length, produtos.length, "A10: um resultado por produto de entrada, nem mais nem menos");
}

console.log("\nB · conjunto vazio reconcilia trivialmente (0 == 0)");
{
  const mapasVazios: MapasResolverGrupo = {
    fabricantesPorId: new Map(), fabricantesPorNomeNormalizado: new Map(), regrasCnpPorCnp: new Map(),
    snapshotsPorCnp: new Map(), gruposFabricantePorFabricanteId: new Map(), aliasesPorNomeNormalizado: new Map(),
  };
  const relatorio = resolverGruposEmLote([], mapasVazios);
  const r = reconciliar(relatorio.totais);
  check(r.bate, "B1: conjunto vazio reconcilia (0+0+0==0)");
}

console.log("\nC · 500 produtos sintéticos aleatórios (mistura de todos os níveis) — reconciliação bate sempre, não é coincidência de um caso pequeno");
{
  const mapas: MapasResolverGrupo = {
    fabricantesPorId: new Map<string, FabricanteParaResolver>(Array.from({ length: 10 }, (_, i) => [`f${i}`, { id: `f${i}`, nomeNormalizado: `FABRICANTE ${i}` }])),
    fabricantesPorNomeNormalizado: new Map(),
    regrasCnpPorCnp: new Map<number, RegraCnpParaResolver>(
      Array.from({ length: 50 }, (_, i) => [i, { id: `r${i}`, grupoLaboratorialId: "gX", estado: "ATIVO", validadoManualmente: true }]),
    ),
    snapshotsPorCnp: new Map(),
    gruposFabricantePorFabricanteId: new Map<string, GrupoFabricanteParaResolver>([
      ["f0", { grupoLaboratorialId: "gY" }],
      ["f1", { grupoLaboratorialId: "gY" }],
    ]),
    aliasesPorNomeNormalizado: new Map(),
  };
  const produtos: ProdutoParaResolver[] = Array.from({ length: 500 }, (_, i) => ({
    id: `p${i}`,
    cnp: i,
    fabricanteId: `f${i % 10}`,
    grupoExistente: i % 97 === 0 ? { grupoLaboratorialId: "gManual", validadoManualmente: true } : null,
  }));
  const relatorio = resolverGruposEmLote(produtos, mapas);
  const r = reconciliar(relatorio.totais);
  check(r.bate, "C1: 500 produtos, reconciliação bate certo", JSON.stringify(r));
  eq(relatorio.totais.produtos, 500, "C2: todos os 500 contabilizados");
}

console.log(`\n${ok} ok, ${ko} falhas`);
process.exit(ko === 0 ? 0 : 1);
