/**
 * scripts/tests/test-manutencao-massa-silveira.ts
 *
 * Testes puros (sem BD) da lógica de decisão da manutenção em massa do
 * catálogo (Área A, exclusiva do tenant silveira):
 *   - `validarFiltro` — regras de forma do filtro (farmácia obrigatória
 *     para FORNECEDOR, filtros mutuamente exclusivos, filtros do tipo
 *     errado).
 *   - `buildFabricanteWhere` / `buildFornecedorWhere` — tradução do
 *     filtro para `Prisma.*WhereInput`, incluindo o "sinal" de
 *     `fabricanteDivergente` a virar um `id: { in: [...] }`.
 *   - `modaValorNovoId` — resumo informativo do cabeçalho de uma
 *     reversão (a fonte de verdade continua a ser cada item).
 *
 * Uso: npx tsx scripts/tests/test-manutencao-massa-silveira.ts
 */
import {
  validarFiltro,
  buildFabricanteWhere,
  buildFornecedorWhere,
  buildProdutoLevelWhere,
  modaValorNovoId,
  type ManutencaoMassaFiltro,
} from "../../lib/catalogo/manutencao-massa";

let pass = 0;
let fail = 0;

function check(cond: boolean, msg: string) {
  if (cond) {
    pass++;
    console.log(`  [OK]    ${msg}`);
  } else {
    fail++;
    console.log(`  [FALHA] ${msg}`);
  }
}

function eq<T>(label: string, actual: T, expected: T) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(ok, ok ? label : `${label}: obtido ${JSON.stringify(actual)}, esperado ${JSON.stringify(expected)}`);
}

const VAZIO: ManutencaoMassaFiltro = {};

console.log("=== validarFiltro — FORNECEDOR exige farmácia ===");
eq("sem farmaciaId é rejeitado", validarFiltro("FORNECEDOR", VAZIO) !== null, true);
eq("com farmaciaId passa", validarFiltro("FORNECEDOR", { farmaciaId: "f1" }), null);

console.log("\n=== validarFiltro — filtros do tipo errado ===");
eq(
  "fabricanteDivergente só faz sentido em FABRICANTE",
  validarFiltro("FORNECEDOR", { farmaciaId: "f1", fabricanteDivergente: true }) !== null,
  true,
);
eq(
  "fornecedorAtualId não é aplicável a FABRICANTE",
  validarFiltro("FABRICANTE", { fornecedorAtualId: "x" }) !== null,
  true,
);
eq(
  "semFornecedor não é aplicável a FABRICANTE",
  validarFiltro("FABRICANTE", { semFornecedor: true }) !== null,
  true,
);
eq("FABRICANTE sem filtros extra é válido", validarFiltro("FABRICANTE", VAZIO), null);

console.log("\n=== validarFiltro — combinações mutuamente exclusivas ===");
eq(
  "semFabricante + fabricanteAtualId é rejeitado",
  validarFiltro("FABRICANTE", { semFabricante: true, fabricanteAtualId: "f1" }) !== null,
  true,
);
eq(
  "semFornecedor + fornecedorAtualId é rejeitado",
  validarFiltro("FORNECEDOR", { farmaciaId: "f1", semFornecedor: true, fornecedorAtualId: "x" }) !== null,
  true,
);

console.log("\n=== buildProdutoLevelWhere — mapeamento directo ===");
eq("cnp exacto", buildProdutoLevelWhere({ cnp: 1234567 }), { AND: [{ cnp: 1234567 }] });
eq(
  "designação contains case-insensitive",
  buildProdutoLevelWhere({ designacao: "ben-u-ron" }),
  { AND: [{ designacao: { contains: "ben-u-ron", mode: "insensitive" } }] },
);
eq("filtro vazio devolve where vazio", buildProdutoLevelWhere(VAZIO), {});
eq(
  "pesquisaTextual numérica cobre designação OU cnp",
  buildProdutoLevelWhere({ pesquisaTextual: "5601234" }),
  { AND: [{ OR: [{ designacao: { contains: "5601234", mode: "insensitive" } }, { cnp: 5601234 }] }] },
);
eq(
  "pesquisaTextual não-numérica só cobre designação",
  buildProdutoLevelWhere({ pesquisaTextual: "ben-u-ron" }),
  { AND: [{ OR: [{ designacao: { contains: "ben-u-ron", mode: "insensitive" } }] }] },
);

console.log("\n=== buildFabricanteWhere ===");
eq(
  "semFabricante filtra fabricanteId nulo",
  buildFabricanteWhere({ semFabricante: true }),
  { AND: [{}, { fabricanteId: null }] },
);
eq(
  "fabricanteAtualId filtra por id",
  buildFabricanteWhere({ fabricanteAtualId: "fab-1" }),
  { AND: [{}, { fabricanteId: "fab-1" }] },
);
eq(
  "semFabricante tem precedência sobre fabricanteAtualId (defesa em profundidade — validarFiltro já rejeita a combinação)",
  buildFabricanteWhere({ semFabricante: true, fabricanteAtualId: "fab-1" }),
  { AND: [{}, { fabricanteId: null }] },
);
eq(
  "fabricanteDivergente sem nenhum id divergente nunca corresponde a nada (sentinela impossível)",
  buildFabricanteWhere({ fabricanteDivergente: true }, new Set()),
  { AND: [{}, { id: { in: ["__nenhum__"] } }] },
);
eq(
  "fabricanteDivergente com ids usa exactamente esses ids",
  buildFabricanteWhere({ fabricanteDivergente: true }, new Set(["p1", "p2"])),
  { AND: [{}, { id: { in: ["p1", "p2"] } }] },
);

console.log("\n=== buildFornecedorWhere ===");
eq(
  "farmaciaId é sempre incluído",
  buildFornecedorWhere({ farmaciaId: "farm-1" }),
  { AND: [{ farmaciaId: "farm-1" }] },
);
eq(
  "semFornecedor filtra fornecedorHabitualId nulo",
  buildFornecedorWhere({ farmaciaId: "farm-1", semFornecedor: true }),
  { AND: [{ farmaciaId: "farm-1" }, { fornecedorHabitualId: null }] },
);
eq(
  "filtros de Produto entram aninhados em `produto`",
  buildFornecedorWhere({ farmaciaId: "farm-1", cnp: 123 }),
  { AND: [{ farmaciaId: "farm-1" }, { produto: { AND: [{ cnp: 123 }] } }] },
);

console.log("\n=== modaValorNovoId ===");
eq(
  "valor mais frequente vence",
  modaValorNovoId([{ valorNovoId: "a" }, { valorNovoId: "b" }, { valorNovoId: "a" }]),
  "a",
);
eq("um único item devolve esse valor", modaValorNovoId([{ valorNovoId: "x" }]), "x");
eq(
  "empate devolve o primeiro encontrado com a contagem máxima",
  modaValorNovoId([{ valorNovoId: "a" }, { valorNovoId: "b" }]),
  "a",
);

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail === 0 ? 0 : 1);
