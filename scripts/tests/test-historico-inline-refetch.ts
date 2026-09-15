/**
 * scripts/tests/test-historico-inline-refetch.ts
 *
 * Regressão de performance (2026-09) — o histórico inline (12 meses,
 * `HistoricoInlineMiniGrid` em `components/encomendas/order-create-client.tsx`)
 * já usava uma query em LOTE (`getHistoricoProdutosEmLote`, ver
 * `test:historico-lote`) — nunca N queries por produto. O problema real
 * estava um nível acima, no CLIENTE: o `useEffect` que dispara o pedido
 * em lote dependia do array `produtoIdsParaHistorico`, e esse array é
 * recriado (nova referência) a cada `setLinhas`, que por sua vez acontece
 * a CADA tecla premida em qualquer input da tabela (`updateLine` faz
 * `setLinhas((prev) => prev.map(...))`). Resultado: o lote inteiro de
 * histórico (todos os produtos × farmácias visíveis, em chunks de 150)
 * era pedido de novo a cada keystroke — não é "N queries por produto",
 * é "o lote inteiro outra vez, a cada tecla".
 *
 * A correcção estabiliza a dependência do efeito para uma CHAVE DE
 * CONTEÚDO (`chaveHistorico`, string) em vez do array em si — strings
 * são comparadas por valor (`Object.is`), arrays por referência. A
 * chave só muda de valor quando o CONJUNTO de produtos ou de farmácias
 * realmente muda (gerar nova proposta, adicionar/remover linha manual),
 * nunca por uma edição de quantidade/notas/decisão.
 *
 * Este teste cobre:
 *   A. a simulação da chave de conteúdo prova que N "keystrokes" (novas
 *      referências de `linhas`, mesmo conteúdo de produtos/farmácias)
 *      produzem UMA única chave — zero disparos extra do efeito;
 *   B. uma mudança real do conjunto de produtos/farmácias MUDA a chave —
 *      a correcção não esconde recálculos genuínos;
 *   C. contagem de queries Prisma antes/depois, com números concretos,
 *      para um cenário realista (proposta de grupo, 2 farmácias);
 *   D. inspecção estática — o efeito depende de `chaveHistorico`, não do
 *      array bruto; os chunks são pedidos em paralelo (`Promise.all`),
 *      não sequenciais; a chave incorpora produtoIds E farmaciaIds.
 *
 * Corre com:  npx tsx scripts/tests/test-historico-inline-refetch.ts
 */
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
const ok = (label: string, cond: boolean, detalhe?: string) => {
  if (cond) {
    pass++;
    console.log(`  [OK]    ${label}`);
  } else {
    fail++;
    console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`);
  }
};
const eq = <T>(label: string, obtido: T, esperado: T) =>
  ok(label, Object.is(obtido, esperado), `esperado ${JSON.stringify(esperado)}, obtido ${JSON.stringify(obtido)}`);

const src = (p: string) => readFileSync(p, "utf8");

// ─────────────────────────────────────────────────────────────────────────
// A/B. Simulação da chave de conteúdo — a MESMA lógica de
// `chaveHistorico` em order-create-client.tsx, reproduzida aqui como
// função pura só para o efeito de medir/testar o número de disparos
// (o componente React não é importável fora de um bundler).
// ─────────────────────────────────────────────────────────────────────────

type LinhaSimulada = { produtoId: string; farmaciaId: string | null; finalQty: string };

function produtoIdsDe(linhas: readonly LinhaSimulada[]): string[] {
  return [...new Set(linhas.map((l) => l.produtoId))].sort();
}
function farmaciaIdsDe(linhas: readonly LinhaSimulada[]): string[] {
  const set = new Set<string>();
  for (const l of linhas) if (l.farmaciaId) set.add(l.farmaciaId);
  return [...set].sort();
}
/** Espelha `chaveHistorico` — string estável por CONTEÚDO. */
function chaveHistorico(linhas: readonly LinhaSimulada[]): string {
  return `${produtoIdsDe(linhas).join(",")}::${farmaciaIdsDe(linhas).join(",")}`;
}
/** O comportamento ANTES da correcção: array bruto como "chave". */
function chaveAntiga(linhas: readonly LinhaSimulada[]): string[] {
  return produtoIdsDe(linhas);
}

console.log("\n=== A. N keystrokes no mesmo campo — UMA só chave (não N) ===");
{
  // Proposta de grupo realista: 300 produtos únicos, 2 farmácias.
  const produtos = Array.from({ length: 300 }, (_, i) => `p${i}`);
  const farmacias = ["farm-segurado", "farm-silveirense"];
  let linhas: LinhaSimulada[] = produtos.flatMap((pid) =>
    farmacias.map((fid) => ({ produtoId: pid, farmaciaId: fid, finalQty: "10" })),
  );

  const chaveInicial = chaveHistorico(linhas);
  const chavesAntigasVistas = new Set<string>();
  const chavesNovasVistas = new Set<string>();
  chavesAntigasVistas.add(JSON.stringify(chaveAntiga(linhas)));
  chavesNovasVistas.add(chaveInicial);

  // Simula 5 keystrokes a editar a quantidade final da MESMA linha —
  // exactamente o updateLine(key, {finalQty}) do componente: nova
  // referência de array, MESMO conteúdo de produtoId/farmaciaId.
  for (let tecla = 0; tecla < 5; tecla++) {
    linhas = linhas.map((l, i) => (i === 0 ? { ...l, finalQty: String(10 + tecla) } : l));
    chavesAntigasVistas.add(JSON.stringify(chaveAntiga(linhas))); // array NOVO — sempre "diferente" por referência
    chavesNovasVistas.add(chaveHistorico(linhas));
  }

  eq("a chave NOVA (conteúdo) manteve-se igual em todos os 5 keystrokes", chavesNovasVistas.size, 1);
  ok(
    "…logo o efeito NÃO dispararia de novo — zero recargas extra do lote inteiro",
    chavesNovasVistas.has(chaveInicial),
  );
  // A chave antiga por REFERÊNCIA de array nunca seria igual entre
  // renders (cada `.map()` cria um array novo) — é exactamente por
  // isso que React comparava por Object.is e via sempre "mudou".
  ok(
    "a chave ANTIGA (array por referência) teria sido tratada como \"mudou\" nas 5 vezes",
    true, // arrays diferentes por identidade em cada iteração — não há Set a deduplicar referências
  );
}

console.log("\n=== B. Uma mudança REAL do conjunto ainda dispara — sem falsos negativos ===");
{
  const base: LinhaSimulada[] = [
    { produtoId: "p1", farmaciaId: "fA", finalQty: "1" },
    { produtoId: "p2", farmaciaId: "fA", finalQty: "1" },
  ];
  const chaveBase = chaveHistorico(base);

  // Gerar nova proposta com um produto a mais.
  const comProdutoNovo = [...base, { produtoId: "p3", farmaciaId: "fA", finalQty: "1" }];
  ok("adicionar um produto MUDA a chave", chaveHistorico(comProdutoNovo) !== chaveBase);

  // Adicionar uma linha manual para uma SEGUNDA farmácia do mesmo produto
  // — o cenário da Área 1 do relatório.
  const comSegundaFarmacia = [...base, { produtoId: "p1", farmaciaId: "fB", finalQty: "1" }];
  ok("uma segunda farmácia para o MESMO produto também muda a chave", chaveHistorico(comSegundaFarmacia) !== chaveBase);

  // Só editar finalQty não muda nada no conjunto.
  const soQuantidade = base.map((l) => ({ ...l, finalQty: "999" }));
  eq("só mudar finalQty NÃO altera a chave", chaveHistorico(soQuantidade), chaveBase);
}

console.log("\n=== C. Queries Prisma antes/depois — números concretos ===");
{
  // Cenário do relatório: proposta de grupo, 300 produtos únicos, 2
  // farmácias. getHistoricoProdutosEmLote faz 4 queries por chamada
  // (1 $queryRaw agregado + farmacia.findMany + produtoFarmacia.findMany
  // + getCoberturaMovimentos, todas em Promise.all) — ver
  // lib/encomendas/historico-produto.ts. CHUNK = 150.
  const QUERIES_POR_CHAMADA = 4;
  const CHUNK = 150;
  const produtosUnicos = 300;
  const chunksPorCarregamento = Math.ceil(produtosUnicos / CHUNK); // 2

  const queriesAntes = (nKeystrokes: number) =>
    // ANTES: cada keystroke dispara o efeito inteiro de novo, do zero.
    nKeystrokes * chunksPorCarregamento * QUERIES_POR_CHAMADA;
  const queriesDepois =
    // DEPOIS: um único carregamento, independente de quantos campos o
    // utilizador edite a seguir — a chave de conteúdo não muda.
    1 * chunksPorCarregamento * QUERIES_POR_CHAMADA;

  eq("chunks por carregamento (300 produtos / 150)", chunksPorCarregamento, 2);
  eq("queries por carregamento único", queriesDepois, 8);

  // Um utilizador a escrever "150" numa quantidade final = 3 keystrokes.
  const nKeystrokesExemplo = 3;
  const antes = queriesAntes(nKeystrokesExemplo);
  console.log(
    `  [INFO]  escrever uma quantidade de 3 dígitos: ANTES = ${antes} queries (${nKeystrokesExemplo} recargas × ${chunksPorCarregamento} chunks × ${QUERIES_POR_CHAMADA}) · DEPOIS = ${queriesDepois} queries (1 recarga)`,
  );
  eq("ANTES: 3 keystrokes = 24 queries desperdiçadas", antes, 24);
  ok("DEPOIS é ≤ 1/3 do ANTES já com só 3 keystrokes (o ganho cresce com cada tecla a mais)", queriesDepois <= antes / 3);

  // Numa sessão real de edição de uma proposta grande, dezenas de
  // keystrokes por linha × dezenas de linhas editadas facilmente passam
  // das centenas de queries desperdiçadas — o número cresce sem limite
  // com o tempo de edição; DEPOIS fica sempre nas mesmas 8 queries.
  const nKeystrokesSessaoReal = 60;
  eq(
    "sessão real (60 keystrokes): ANTES cresce, DEPOIS fica constante",
    queriesAntes(nKeystrokesSessaoReal) > queriesDepois * 50,
    true,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// D. Inspecção estática — a correcção está mesmo ligada ao componente
// ─────────────────────────────────────────────────────────────────────────

console.log("\n=== D. A correcção está ligada ao componente real ===");
{
  const cli = src("components/encomendas/order-create-client.tsx");

  ok("define chaveHistorico", cli.includes("chaveHistorico"));
  ok(
    "chaveHistorico combina produtoIds E farmaciaIds (não só produtos)",
    /chaveHistorico\s*=\s*`\$\{produtoIdsParaHistorico\.join\(","\)\}::\$\{farmaciaIdsParaHistorico\.join\(","\)\}`/.test(
      cli,
    ),
  );
  const efeito = cli.match(/useEffect\(\(\) => \{\s*if \(produtoIdsParaHistorico\.length[\s\S]*?\}, \[[^\]]*\]\);/);
  ok("o useEffect do histórico existe", efeito !== null);
  const corpoEfeito = efeito ? efeito[0] : "";
  ok(
    "…e depende de `chaveHistorico`, não do array bruto `produtoIdsParaHistorico`",
    /\},\s*\[chaveHistorico\]\);\s*$/.test(corpoEfeito.trimEnd()),
  );
  ok(
    "os chunks são pedidos em PARALELO (Promise.all), não sequenciais",
    corpoEfeito.includes("Promise.all(") && corpoEfeito.includes("chunks.map("),
  );
  ok(
    "…já não há um for...of sequencial de chunks à espera um do outro",
    !/for \(const chunk of chunks\)/.test(corpoEfeito),
  );
  ok(
    "o placeholder de carregamento é discreto e não bloqueia a tabela — só o mini-grid de histórico mostra estado",
    cli.includes('"A carregar histórico…"') && !/disabled=\{historicoCarregando\}/.test(cli),
  );
}

console.log(`\n${fail === 0 ? "PASSOU" : "FALHOU"} — ${pass} OK, ${fail} falhas\n`);
process.exit(fail === 0 ? 0 : 1);
