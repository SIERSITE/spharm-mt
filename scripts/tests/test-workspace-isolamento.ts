/**
 * scripts/tests/test-workspace-isolamento.ts
 *
 * Isolamento das sessões de análise (workspaces) e idempotência dos reducers
 * da barra de tarefas. Sem DOM: `StorageLike` falso.
 */
import { chaveWorkspaceState, escreverEstado, lerEstado, type StorageLike } from "../../lib/workspace/use-workspace-state";
import { reduzirSujo, reduzirTitulo, type EstadoPersistido } from "../../lib/workspace/task-bar-context";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  [OK]    ${msg}`); }
  else { failed++; console.log(`  [FALHA] ${msg}`); }
}

function storageFalso(): StorageLike & { dados: Map<string, string> } {
  const dados = new Map<string, string>();
  return { dados, getItem: (k) => dados.get(k) ?? null, setItem: (k, v) => void dados.set(k, v) };
}

console.log("\nA · chaves de workspace");
{
  const base = chaveWorkspaceState("t1", "u1", "w1", "margens");
  check(base !== chaveWorkspaceState("t2", "u1", "w1", "margens"), "A1: tenants diferentes → chaves diferentes");
  check(base !== chaveWorkspaceState("t1", "u2", "w1", "margens"), "A2: utilizadores diferentes → chaves diferentes");
  check(base !== chaveWorkspaceState("t1", "u1", "w2", "margens"), "A3: workspaces diferentes → chaves diferentes");
  check(base !== chaveWorkspaceState("t1", "u1", "w1", "inventario"), "A4: módulos diferentes → chaves diferentes");
  check(base === chaveWorkspaceState("t1", "u1", "w1", "margens"), "A5: mesma identidade → mesma chave (determinística)");
}

console.log("\nB · leitura/escrita isoladas");
{
  const st = storageFalso();
  const kA = chaveWorkspaceState("t1", "u1", "A", "margens");
  const kB = chaveWorkspaceState("t1", "u1", "B", "margens");
  escreverEstado(kA, { q: "5000101", ordenacao: { coluna: "cnp", direccao: "asc" } }, st);
  escreverEstado(kB, { q: "5000102", ordenacao: null }, st);
  check(lerEstado<{ q: string }>(kA, st)?.q === "5000101", "B1: A lê os seus critérios");
  check(lerEstado<{ q: string }>(kB, st)?.q === "5000102", "B2: B lê os seus critérios");
  check(JSON.stringify(lerEstado(kA, st)).includes("cnp"), "B3: a ordenação de A fica em A");
  check(!JSON.stringify(lerEstado(kB, st)).includes("cnp"), "B4: a ordenação de A nunca aparece em B");
  check(lerEstado(chaveWorkspaceState("outro-tenant", "u1", "A", "margens"), st) === null, "B5: outro tenant não lê o workspace A");
  check(lerEstado(chaveWorkspaceState("t1", "outro-user", "A", "margens"), st) === null, "B6: outro utilizador não lê o workspace A");
  check(!JSON.stringify([...st.dados.values()]).includes("resultado"), "B7: só critérios são persistidos (nenhum campo «resultado»)");
}

console.log("\nC · robustez do armazenamento");
{
  const quebrado: StorageLike = { getItem: () => { throw new Error("bloqueado"); }, setItem: () => { throw new Error("quota"); } };
  check(lerEstado("k", quebrado) === null, "C1: getItem a lançar → null (a análise continua a funcionar)");
  let lancou = false;
  try { escreverEstado("k", { a: 1 }, quebrado); } catch { lancou = true; }
  check(!lancou, "C2: setItem a lançar (quota) não rebenta");
  const st = storageFalso();
  st.setItem("k", "{json inválido");
  check(lerEstado("k", st) === null, "C3: JSON corrompido → null");
  check(lerEstado("k", null) === null, "C4: sem storage (SSR) → null");
}

console.log("\nD · reducers da barra de tarefas idempotentes (regressão do ciclo infinito)");
{
  const estado: EstadoPersistido = {
    tarefas: [{ id: "/vendas?workspace=a", titulo: "Vendas", tipo: "vendas", href: "/vendas?workspace=a", sujo: false }],
    activaId: "/vendas?workspace=a",
  };
  check(reduzirTitulo(estado, "/vendas?workspace=a", "Vendas") === estado, "D1: mesmo título → MESMA referência (não acorda consumidores)");
  check(reduzirTitulo(estado, "inexistente", "X") === estado, "D2: tarefa inexistente → MESMA referência");
  check(reduzirSujo(estado, "/vendas?workspace=a", false) === estado, "D3: mesmo estado sujo → MESMA referência");
  check(reduzirSujo(estado, "inexistente", true) === estado, "D4: tarefa inexistente → MESMA referência");
  const novo = reduzirTitulo(estado, "/vendas?workspace=a", "Vendas — LAB");
  check(novo !== estado && novo.tarefas[0].titulo === "Vendas — LAB", "D5: título diferente → estado novo com o título");
  check(estado.tarefas[0].titulo === "Vendas", "D6: o estado anterior não é mutado");
  const sujo = reduzirSujo(estado, "/vendas?workspace=a", true);
  check(sujo !== estado && sujo.tarefas[0].sujo === true, "D7: sujo diferente → estado novo");
  check(reduzirTitulo(novo, "/vendas?workspace=a", "Vendas — LAB") === novo, "D8: aplicar duas vezes o mesmo título estabiliza (ponto fixo)");
}

console.log(`\n${passed} ok, ${failed} falhas`);
if (failed > 0) process.exit(1);
