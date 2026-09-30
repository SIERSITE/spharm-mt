/**
 * scripts/tests/test-finalizar-multi-fornecedor.ts
 *
 * Testes PUROS (sem Prisma, sem BD) das regras de
 * `lib/encomendas/finalizar-multi-fornecedor-regras.ts` — agrupamento por
 * fornecedor, decisão de quando usar o caminho multi-fornecedor,
 * validação de linhas sem fornecedor, formatação do resumo e derivação
 * da chave de idempotência por fornecedor.
 *
 * Uso: npx tsx scripts/tests/test-finalizar-multi-fornecedor.ts
 */
import {
  agruparLinhasPorFornecedor,
  contarFornecedoresDistintos,
  deveUsarFinalizacaoMultiFornecedor,
  deriveFornecedorIdempotencyKey,
  deriveGrupoDraftIdempotencyKey,
  deriveGrupoFinalizacaoBatchKey,
  formatarResumoFinalizacaoMultiFornecedor,
  validarLinhasParaFinalizacaoMultiFornecedor,
} from "../../lib/encomendas/finalizar-multi-fornecedor-regras";

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
  check(JSON.stringify(actual) === JSON.stringify(expected), `${label}: obtido ${JSON.stringify(actual)}, esperado ${JSON.stringify(expected)}`);
}

type Linha = { produtoId: string; fornecedorSugeridoId: string | null };

console.log("=== contarFornecedoresDistintos ===");
eq("vazio", contarFornecedoresDistintos([]), 0);
eq(
  "um único fornecedor",
  contarFornecedoresDistintos([
    { fornecedorSugeridoId: "A" },
    { fornecedorSugeridoId: "A" },
  ]),
  1
);
eq(
  "todas sem fornecedor conta como 1 (o marcador 'sem fornecedor')",
  contarFornecedoresDistintos([{ fornecedorSugeridoId: null }, { fornecedorSugeridoId: null }]),
  1
);
eq(
  "dois fornecedores distintos",
  contarFornecedoresDistintos([{ fornecedorSugeridoId: "A" }, { fornecedorSugeridoId: "B" }]),
  2
);
eq(
  "fornecedor + sem fornecedor conta como 2 distintos",
  contarFornecedoresDistintos([{ fornecedorSugeridoId: "A" }, { fornecedorSugeridoId: null }]),
  2
);

console.log("\n=== deveUsarFinalizacaoMultiFornecedor ===");
eq("lista vazia -> caminho único", deveUsarFinalizacaoMultiFornecedor([]), false);
eq(
  "um único fornecedor -> caminho único (sem mudança de comportamento)",
  deveUsarFinalizacaoMultiFornecedor([{ fornecedorSugeridoId: "A" }, { fornecedorSugeridoId: "A" }]),
  false
);
eq(
  "todas sem fornecedor (fluxo legado) -> caminho único",
  deveUsarFinalizacaoMultiFornecedor([{ fornecedorSugeridoId: null }, { fornecedorSugeridoId: null }]),
  false
);
eq(
  "dois fornecedores distintos -> caminho multi",
  deveUsarFinalizacaoMultiFornecedor([{ fornecedorSugeridoId: "A" }, { fornecedorSugeridoId: "B" }]),
  true
);
eq(
  "um fornecedor + uma linha sem fornecedor -> caminho multi (vai ser rejeitado pela validação, não silenciosamente ignorado)",
  deveUsarFinalizacaoMultiFornecedor([{ fornecedorSugeridoId: "A" }, { fornecedorSugeridoId: null }]),
  true
);

console.log("\n=== validarLinhasParaFinalizacaoMultiFornecedor ===");
{
  const semLinhas = validarLinhasParaFinalizacaoMultiFornecedor<Linha>([]);
  check(semLinhas.ok === false, "sem linhas é rejeitado");
  if (!semLinhas.ok) eq("sem linhas: produtoIdsSemFornecedor vazio", semLinhas.produtoIdsSemFornecedor, []);
}
{
  const todasComFornecedor = validarLinhasParaFinalizacaoMultiFornecedor<Linha>([
    { produtoId: "p1", fornecedorSugeridoId: "A" },
    { produtoId: "p2", fornecedorSugeridoId: "B" },
  ]);
  check(todasComFornecedor.ok === true, "todas as linhas com fornecedor: válido");
}
{
  const algumasSemFornecedor = validarLinhasParaFinalizacaoMultiFornecedor<Linha>([
    { produtoId: "p1", fornecedorSugeridoId: "A" },
    { produtoId: "p2", fornecedorSugeridoId: null },
    { produtoId: "p3", fornecedorSugeridoId: null },
  ]);
  check(algumasSemFornecedor.ok === false, "linhas sem fornecedor: rejeitado por inteiro (nunca parcialmente aceite)");
  if (!algumasSemFornecedor.ok) {
    eq("produtoIds em falta reportados exactamente", algumasSemFornecedor.produtoIdsSemFornecedor, ["p2", "p3"]);
    check(algumasSemFornecedor.error.includes("2"), "mensagem de erro refere a contagem exacta (2)");
  }
}

console.log("\n=== agruparLinhasPorFornecedor ===");
{
  const linhas: Linha[] = [
    { produtoId: "p1", fornecedorSugeridoId: "A" },
    { produtoId: "p2", fornecedorSugeridoId: "B" },
    { produtoId: "p3", fornecedorSugeridoId: "A" },
    { produtoId: "p4", fornecedorSugeridoId: "C" },
  ];
  const grupos = agruparLinhasPorFornecedor(linhas);
  eq("3 grupos distintos", grupos.length, 3);
  const porId = new Map(grupos.map((g) => [g.fornecedorId, g.linhas.map((l) => l.produtoId)]));
  eq("grupo A tem p1 e p3", porId.get("A"), ["p1", "p3"]);
  eq("grupo B tem só p2", porId.get("B"), ["p2"]);
  eq("grupo C tem só p4", porId.get("C"), ["p4"]);
  const total = grupos.reduce((s, g) => s + g.linhas.length, 0);
  eq("nenhuma linha perdida no agrupamento", total, linhas.length);
}
{
  // Uma linha `null` nunca deveria chegar aqui (validar primeiro) — mas o
  // agrupamento, por si só, ignora-a em vez de rebentar ou criar um
  // grupo "null" espúrio.
  const comNula: Linha[] = [
    { produtoId: "p1", fornecedorSugeridoId: "A" },
    { produtoId: "p2", fornecedorSugeridoId: null },
  ];
  const grupos = agruparLinhasPorFornecedor(comNula);
  eq("linha sem fornecedor é ignorada pelo agrupamento (não cria grupo próprio)", grupos.length, 1);
  eq("só o grupo A aparece", grupos[0].fornecedorId, "A");
}

console.log("\n=== formatarResumoFinalizacaoMultiFornecedor ===");
eq(
  "formato exacto pedido, 3 documentos",
  formatarResumoFinalizacaoMultiFornecedor([
    { fornecedorNome: "Fornecedor A", numero: "EN-000101", nLinhas: 120 },
    { fornecedorNome: "Fornecedor B", numero: "EN-000102", nLinhas: 95 },
    { fornecedorNome: "Fornecedor C", numero: "EN-000103", nLinhas: 85 },
  ]),
  "3 encomendas criadas\nFornecedor A — 120 linhas — EN-000101\nFornecedor B — 95 linhas — EN-000102\nFornecedor C — 85 linhas — EN-000103"
);
eq(
  "singular correcto com 1 documento e 1 linha",
  formatarResumoFinalizacaoMultiFornecedor([{ fornecedorNome: "Fornecedor Único", numero: "EN-000200", nLinhas: 1 }]),
  "1 encomenda criada\nFornecedor Único — 1 linha — EN-000200"
);
eq(
  "número ausente mostra marcador em vez de 'null'",
  formatarResumoFinalizacaoMultiFornecedor([{ fornecedorNome: "X", numero: null, nLinhas: 2 }]),
  "1 encomenda criada\nX — 2 linhas — (sem número)"
);

console.log("\n=== deriveFornecedorIdempotencyKey ===");
{
  const k1 = deriveFornecedorIdempotencyKey("batch-1", "forn-A");
  const k2 = deriveFornecedorIdempotencyKey("batch-1", "forn-A");
  const k3 = deriveFornecedorIdempotencyKey("batch-1", "forn-B");
  const k4 = deriveFornecedorIdempotencyKey("batch-2", "forn-A");
  check(k1 === k2, "determinística: mesmo batchKey+fornecedorId produz a mesma chave");
  check(k1 !== k3, "fornecedores diferentes sob o mesmo batchKey produzem chaves diferentes");
  check(k1 !== k4, "batchKeys diferentes produzem chaves diferentes para o mesmo fornecedor");
  check(/^[0-9a-f]{64}$/.test(k1), "formato SHA-256 hex (64 caracteres)");
}

console.log("\n=== deriveGrupoDraftIdempotencyKey / deriveGrupoFinalizacaoBatchKey ===");
{
  const batch = "grupo-batch-1";
  const fA = "farmacia-a";
  const fB = "farmacia-b";

  const draftA1 = deriveGrupoDraftIdempotencyKey(batch, fA);
  const draftA2 = deriveGrupoDraftIdempotencyKey(batch, fA);
  const draftB = deriveGrupoDraftIdempotencyKey(batch, fB);
  check(draftA1 === draftA2, "deriveGrupoDraftIdempotencyKey é determinística (mesmo batchKey+farmácia)");
  check(draftA1 !== draftB, "farmácias diferentes sob o mesmo batchKey produzem chaves de rascunho diferentes");
  check(/^[0-9a-f]{64}$/.test(draftA1), "deriveGrupoDraftIdempotencyKey: formato SHA-256 hex (64 caracteres)");

  const finA1 = deriveGrupoFinalizacaoBatchKey(batch, fA);
  const finA2 = deriveGrupoFinalizacaoBatchKey(batch, fA);
  const finB = deriveGrupoFinalizacaoBatchKey(batch, fB);
  check(finA1 === finA2, "deriveGrupoFinalizacaoBatchKey é determinística (mesmo batchKey+farmácia)");
  check(finA1 !== finB, "farmácias diferentes sob o mesmo batchKey produzem batchKeys de finalização diferentes");
  check(/^[0-9a-f]{64}$/.test(finA1), "deriveGrupoFinalizacaoBatchKey: formato SHA-256 hex (64 caracteres)");

  // Nunca a MESMA chave para os dois papéis (criar o rascunho vs. o
  // batchKey da sua divisão) — salts distintos, mesmo com o mesmo
  // batchKey+farmácia de entrada. Ver comentário no módulo de regras.
  check(draftA1 !== finA1, "o salt distingue os dois papéis — chave de rascunho ≠ batchKey de finalização, mesma entrada");

  // E nenhuma das duas colide com deriveFornecedorIdempotencyKey (que
  // não usa salt nenhum) para a mesma combinação de strings.
  const chaveSemSalt = deriveFornecedorIdempotencyKey(batch, fA);
  check(chaveSemSalt !== draftA1 && chaveSemSalt !== finA1, "nenhuma das chaves de grupo colide com deriveFornecedorIdempotencyKey para a mesma entrada");
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail === 0 ? 0 : 1);
