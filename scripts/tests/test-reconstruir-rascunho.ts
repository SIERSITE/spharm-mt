/**
 * scripts/tests/test-reconstruir-rascunho.ts
 * Puro, sem Prisma nem React — ver lib/encomendas/reconstruir-rascunho.ts.
 */
import { enriquecerLinhasRascunho, type LinhaEnriquecivel } from "../../lib/encomendas/reconstruir-rascunho";
import type { ProposalRow } from "../../lib/encomendas/proposal";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  [OK]    ${msg}`); }
  else { failed++; console.log(`  [FALHA] ${msg}`); }
}
function eq(a: unknown, b: unknown, msg: string) {
  check(JSON.stringify(a) === JSON.stringify(b), `${msg} (esperado ${JSON.stringify(b)}, obtido ${JSON.stringify(a)})`);
}

type LinhaTeste = LinhaEnriquecivel & {
  finalQty: string;
  notas: string;
  origem: "PROPOSTA" | "MANUAL" | "SUGESTAO";
  suggestedQty: number | null;
};

function linhaBase(overrides: Partial<LinhaTeste>): LinhaTeste {
  return {
    produtoId: "p1",
    salesQty: null, avgDailySales: null, currentStock: null, coberturaAtualDias: null,
    pendingQty: null, estado: null, motivo: null, excessoFonte: [], semVendasNoPeriodo: false,
    dadosDesactualizados: true,
    finalQty: "10", notas: "", origem: "PROPOSTA", suggestedQty: 5,
    ...overrides,
  };
}

function rowFresca(overrides: Partial<ProposalRow>): ProposalRow {
  return {
    farmaciaId: "f1", farmaciaNome: "F1", produtoId: "p1", cnp: 111,
    designacao: "X", fabricante: null, fornecedor: null, categoria: "", productType: null,
    salesQty: 99, avgDailySales: 3.3, currentStock: 42, coberturaAtualDias: 12.7,
    pendingQty: 2, targetQty: 10, suggestedQty: 8, transferirQty: 0,
    estado: "COMPRAR", motivo: "novo motivo", excessoFonte: [], semVendasNoPeriodo: false,
    ...overrides,
  };
}

console.log("A · quantidade final/notas/origem NUNCA são tocadas");
{
  const persistida = linhaBase({ finalQty: "37", notas: "não mexer", origem: "PROPOSTA", suggestedQty: 5 });
  const [r] = enriquecerLinhasRascunho([persistida], [rowFresca({ suggestedQty: 999 })]);
  eq(r.finalQty, "37", "A1: quantidade final decidida sobrevive intacta, mesmo com suggestedQty fresco muito diferente");
  eq(r.notas, "não mexer", "A2: notas sobrevivem intactas");
  eq(r.origem, "PROPOSTA", "A3: origem sobrevive intacta");
  eq(r.suggestedQty, 5, "A4: o campo 'suggestedQty' (snapshot da sugestão ORIGINAL) não é tocado por este módulo — não faz parte de LinhaEnriquecivel");
}

console.log("\nB · campos informativos são actualizados a partir do recálculo fresco");
{
  const persistida = linhaBase({ currentStock: 1, coberturaAtualDias: 0.5, estado: "AGUARDAR", motivo: "velho" });
  const [r] = enriquecerLinhasRascunho([persistida], [rowFresca({ currentStock: 42, coberturaAtualDias: 12.7, estado: "COMPRAR", motivo: "novo motivo" })]);
  eq(r.currentStock, 42, "B1: stock actualizado");
  eq(r.coberturaAtualDias, 12.7, "B2: cobertura actualizada");
  eq(r.estado, "COMPRAR", "B3: estado actualizado");
  eq(r.motivo, "novo motivo", "B4: motivo actualizado");
  eq(r.dadosDesactualizados, false, "B5: encontrado no fresco → dadosDesactualizados passa a false");
}

console.log("\nC · linha manual/proposta nunca desaparece quando o produto não volta no recálculo");
{
  const manual = linhaBase({ produtoId: "p-manual", origem: "MANUAL", finalQty: "3" });
  const proposta = linhaBase({ produtoId: "p-proposta-antiga", origem: "PROPOSTA", finalQty: "9" });
  const resultado = enriquecerLinhasRascunho([manual, proposta], [/* nada fresco */]);
  eq(resultado.length, 2, "C1: nenhuma linha removida — mesmo array de entrada, mesmo tamanho");
  eq(resultado[0].dadosDesactualizados, true, "C2: linha manual marcada como desactualizada (aviso), nunca apagada");
  eq(resultado[0].finalQty, "3", "C3: quantidade da linha manual continua 3");
  eq(resultado[1].dadosDesactualizados, true, "C4: linha de proposta antiga também só marcada, nunca apagada");
}

console.log("\nD · nunca adiciona linhas que não estavam persistidas");
{
  const persistida = linhaBase({ produtoId: "p1" });
  const resultado = enriquecerLinhasRascunho(
    [persistida],
    [rowFresca({ produtoId: "p1" }), rowFresca({ produtoId: "p-extra-nao-persistido", cnp: 222 })]
  );
  eq(resultado.length, 1, "D1: array de saída do mesmo tamanho do de entrada — p-extra nunca entra");
  eq(resultado[0].produtoId, "p1", "D2: só o produto persistido aparece");
}

console.log("\nE · ordem preservada, sem side-effects nos objectos originais");
{
  const l1 = linhaBase({ produtoId: "p1" });
  const l2 = linhaBase({ produtoId: "p2" });
  const original = [l1, l2];
  const resultado = enriquecerLinhasRascunho(original, [rowFresca({ produtoId: "p1" }), rowFresca({ produtoId: "p2", cnp: 222 })]);
  eq(resultado.map((r) => r.produtoId), ["p1", "p2"], "E1: ordem preservada");
  eq(l1.dadosDesactualizados, true, "E2: o objecto ORIGINAL l1 não foi mutado (imutabilidade — enriquecerLinhasRascunho devolve objectos NOVOS)");
}

console.log(`\n${passed} ok, ${failed} falhas`);
if (failed > 0) process.exit(1);
