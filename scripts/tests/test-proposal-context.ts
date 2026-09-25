/**
 * scripts/tests/test-proposal-context.ts
 * Serialização/parse do contexto da proposta — puro, sem Prisma.
 */
import { serializarPropostaContexto, parsearPropostaContexto, type PropostaContexto } from "../../lib/encomendas/proposal-context";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  [OK]    ${msg}`); }
  else { failed++; console.log(`  [FALHA] ${msg}`); }
}
function eq(a: unknown, b: unknown, msg: string) {
  check(JSON.stringify(a) === JSON.stringify(b), `${msg} (esperado ${JSON.stringify(b)}, obtido ${JSON.stringify(a)})`);
}

const base: PropostaContexto = {
  version: 1,
  mode: "farmacia",
  farmaciaId: "farm-1",
  startDate: "2026-06-01",
  endDate: "2026-09-01",
  considerStock: true,
  baseRule: "coverage",
  coverageDays: 15,
  filters: {
    fabricantes: ["fab-1"],
    fornecedores: [],
    categorias: ["cat-1", "cat-2"],
    subcategorias: [],
    utilizacoes: [],
    productTypes: [],
  },
  listaImportadaResumo: null,
  nome: "Rascunho de teste",
};

console.log("A · ida e volta preserva tudo");
const json = serializarPropostaContexto(base);
check(typeof json === "string", "A1: serializa para string");
const back = parsearPropostaContexto(json ?? null);
eq(back, base, "A2: parse devolve exactamente o que foi serializado");

console.log("\nB · contexto ausente/corrompido nunca lança");
eq(parsearPropostaContexto(null), null, "B1: null → null");
eq(parsearPropostaContexto(""), null, "B2: string vazia → null");
eq(parsearPropostaContexto("{not json"), null, "B3: JSON inválido → null, não lança");
eq(parsearPropostaContexto('{"version":2}'), null, "B4: versão desconhecida → null (nunca finge que percebeu)");
eq(parsearPropostaContexto('{"version":1,"mode":"invalido"}'), null, "B5: mode inválido → null");

console.log("\nC · tecto de tamanho nunca bloqueia — só deixa de gravar contexto");
const enorme: PropostaContexto = {
  ...base,
  filters: { ...base.filters, fabricantes: Array.from({ length: 5000 }, (_, i) => `fabricante-id-bem-comprido-${i}`) },
};
const jsonEnorme = serializarPropostaContexto(enorme);
check(jsonEnorme === undefined, "C1: contexto acima do tecto devolve undefined, nunca lança nem trunca a meio de um JSON inválido");

console.log("\nD · listaImportadaResumo sobrevive à ida e volta");
const comLista: PropostaContexto = {
  ...base,
  listaImportadaResumo: { nomeFicheiro: "encomenda-agosto.xlsx", encontrados: 410, naoEncontrados: 3 },
};
const backComLista = parsearPropostaContexto(serializarPropostaContexto(comLista) ?? null);
eq(backComLista?.listaImportadaResumo, comLista.listaImportadaResumo, "D1: resumo da lista importada preservado");

console.log(`\n${passed} ok, ${failed} falhas`);
if (failed > 0) process.exit(1);
