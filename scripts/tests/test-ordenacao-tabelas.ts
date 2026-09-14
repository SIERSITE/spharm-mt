/**
 * scripts/tests/test-ordenacao-tabelas.ts
 *
 * A ordenação por cabeçalho nas tabelas da aplicação.
 *
 * ── Duas metades, e a razão de cada uma ──────────────────────────────
 *
 * **Comportamento** (secções A-C): os padrões que o rollout introduziu e
 * que o motor tem de suportar — colunas dinâmicas por índice, enums
 * ordenados por severidade e não por alfabeto, e a interacção entre
 * ordenar e agrupar.
 *
 * **Não-duplicação** (secção D): que nenhuma das seis tabelas tenha
 * voltado a ter comparador próprio. É inspecção de código de propósito
 * — o defeito que vigia não é um resultado errado, é uma SEGUNDA
 * implementação, e uma segunda implementação só se detecta olhando para
 * o código. Foi assim que a proposta de encomenda ficou com o seu
 * `sortCol`/`sortDir`/`SortableHeader` durante meses, a ser a única
 * tabela ordenável da aplicação.
 *
 * Corre com:  npm run test:ordenacao
 */
import { readFileSync } from "node:fs";
import {
  ordenarLinhas,
  proximaOrdenacao,
  type EstadoOrdenacao,
  type ValorOrdenavel,
} from "../../lib/tabela/ordenacao";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) {
    ok++;
    console.log(`  [OK]    ${label}`);
  } else {
    ko++;
    console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`);
  }
};
const eq = (a: unknown, b: unknown, label: string) =>
  check(
    JSON.stringify(a) === JSON.stringify(b),
    label,
    `esperado ${JSON.stringify(b)}, obtido ${JSON.stringify(a)}`,
  );

const src = (p: string) => readFileSync(p, "utf8");

// ═════════════════════════════════════════════════════════════════════
// A. Colunas dinâmicas — os meses do Relatório de Vendas
// ═════════════════════════════════════════════════════════════════════
//
// As colunas mensais dependem do período escolhido: um período de 14
// meses tem 14 colunas que não existem em código. A chave leva o ÍNDICE
// do bucket (`mes:0`) e não o ano-mês, porque é a posição em
// `row.meses` que o acessor precisa.
console.log("\nA. Colunas dinâmicas por índice\n");

type LinhaVendas = { codigo: string; meses: Array<{ quantidade: number }> };
const acessorMes = (r: LinhaVendas, c: string): ValorOrdenavel => {
  if (c.startsWith("mes:")) return r.meses[Number(c.slice(4))]?.quantidade;
  if (c === "codigo") return Number(r.codigo);
  return undefined;
};

const VENDAS: LinhaVendas[] = [
  { codigo: "100", meses: [{ quantidade: 5 }, { quantidade: 90 }] },
  { codigo: "200", meses: [{ quantidade: 50 }, { quantidade: 1 }] },
  { codigo: "300", meses: [{ quantidade: 20 }, { quantidade: 40 }] },
];

{
  const r = ordenarLinhas(VENDAS, { coluna: "mes:0", direcao: "desc" }, acessorMes);
  eq(r.map((x) => x.codigo), ["200", "300", "100"], "ordena pelo 1.º mês");
}
{
  const r = ordenarLinhas(VENDAS, { coluna: "mes:1", direcao: "desc" }, acessorMes);
  eq(r.map((x) => x.codigo), ["100", "300", "200"], "…e pelo 2.º dá outra ordem");
}
{
  // Uma linha curta — o loader e os buckets dessincronizados. O motor
  // trata `undefined` como ausência e manda-a para o fim, em vez de a
  // somar como zero e a pôr no meio do ranking.
  const curta: LinhaVendas[] = [
    ...VENDAS,
    { codigo: "400", meses: [{ quantidade: 7 }] },
  ];
  const r = ordenarLinhas(curta, { coluna: "mes:1", direcao: "desc" }, acessorMes);
  eq(r[r.length - 1].codigo, "400", "linha sem esse mês vai para o fim, não para o meio");
  const asc = ordenarLinhas(curta, { coluna: "mes:1", direcao: "asc" }, acessorMes);
  eq(asc[asc.length - 1].codigo, "400", "…e continua no fim em ascendente");
}
{
  // `codigo` é texto na linha mas é um número.
  const r = ordenarLinhas(
    [{ codigo: "999999", meses: [] }, { codigo: "5880075", meses: [] }],
    { coluna: "codigo", direcao: "asc" },
    acessorMes,
  );
  eq(r.map((x) => x.codigo), ["999999", "5880075"], "CNP ordena como número, não como texto");
}

// ═════════════════════════════════════════════════════════════════════
// B. Enums — severidade, não alfabeto
// ═════════════════════════════════════════════════════════════════════
//
// Ordenar `EXCESSO / NORMAL / ROTURA` por ordem alfabética é o exemplo
// perfeito de «ordenável porque é tecnicamente uma string». A ordem que
// significa alguma coisa é a da gravidade: quem clica nesta coluna quer
// as roturas no topo.
console.log("\nB. Estados ordenam por severidade\n");

const SEVERIDADE: Record<string, number> = {
  ROTURA: 6, EXCESSO: 5, SEM_MOVIMENTO: 4, NORMAL: 3, SEM_STOCK: 2, SEM_CUSTO: 1,
};
type L = { estado: string };
const acEstado = (r: L): ValorOrdenavel => SEVERIDADE[r.estado];

{
  const rows: L[] = [
    { estado: "NORMAL" }, { estado: "SEM_CUSTO" },
    { estado: "ROTURA" }, { estado: "EXCESSO" },
  ];
  const desc = ordenarLinhas(rows, { coluna: "estado", direcao: "desc" }, acEstado);
  eq(
    desc.map((x) => x.estado),
    ["ROTURA", "EXCESSO", "NORMAL", "SEM_CUSTO"],
    "descendente põe a ROTURA no topo",
  );
  // A prova de que o ranking importa: por alfabeto a ordem seria outra.
  const alfabetica = [...rows].map((x) => x.estado).sort().reverse();
  check(
    JSON.stringify(desc.map((x) => x.estado)) !== JSON.stringify(alfabetica),
    "…e NÃO é a ordem alfabética invertida",
  );
}

// ═════════════════════════════════════════════════════════════════════
// C. Ordenar antes de agrupar
// ═════════════════════════════════════════════════════════════════════
//
// O Relatório de Vendas insere uma linha «TOTAL ARTIGO» a seguir aos
// detalhes de cada código. A ordenação tem de correr ANTES do
// agrupamento: aplicada depois, arrancaria os totais dos grupos a que
// pertencem e espalhá-los-ia pela tabela como se fossem produtos.
console.log("\nC. A ordenação corre antes do agrupamento\n");

{
  type D = { codigo: string; farmacia: string; qtd: number };
  const detalhes: D[] = [
    { codigo: "A", farmacia: "f1", qtd: 1 },
    { codigo: "B", farmacia: "f1", qtd: 50 },
    { codigo: "A", farmacia: "f2", qtd: 2 },
    { codigo: "B", farmacia: "f2", qtd: 10 },
  ];
  const ordenadas = ordenarLinhas(detalhes, { coluna: "qtd", direcao: "desc" }, (r, c) => r[c as "qtd"]);

  // O agrupamento usa um Map por código: a ordem de inserção é a de
  // primeira aparição, logo a ordem que a ordenação acabou de definir.
  const porCodigo = new Map<string, D[]>();
  for (const d of ordenadas) {
    const l = porCodigo.get(d.codigo);
    if (l) l.push(d);
    else porCodigo.set(d.codigo, [d]);
  }
  eq([...porCodigo.keys()], ["B", "A"], "o grupo com mais vendas fica em primeiro");
  eq(
    porCodigo.get("B")!.map((d) => d.farmacia),
    ["f1", "f2"],
    "…e dentro do grupo a ordem também é a ordenada",
  );
  check(
    porCodigo.get("A")!.length === 2 && porCodigo.get("B")!.length === 2,
    "nenhum detalhe se perdeu nem trocou de grupo",
  );
}

// ═════════════════════════════════════════════════════════════════════
// D. Uma implementação, não seis
// ═════════════════════════════════════════════════════════════════════
console.log("\nD. Nenhuma tabela tem comparador próprio\n");

const TABELAS = [
  ["components/inventario/inventario-client.tsx", "Inventário"],
  ["components/margens/margens-client.tsx", "Margens"],
  ["components/vendas/vendas-client.tsx", "Vendas"],
  ["components/encomendas/order-create-client.tsx", "Encomendas"],
  ["components/excessos/excessos-client.tsx", "Excessos"],
  ["components/transferencias/transferencias-client.tsx", "Transferências"],
] as const;

for (const [ficheiro, nome] of TABELAS) {
  const t = src(ficheiro);
  check(t.includes("CabecalhoOrdenavel"), `${nome}: usa o cabeçalho partilhado`);
  check(t.includes("ordenarLinhas"), `${nome}: …e o motor partilhado`);
  check(t.includes("useOrdenacao"), `${nome}: …e o hook de estado partilhado`);
  // O sintoma de uma segunda implementação: um par sortCol/sortDir.
  check(
    !/const \[sortCol[,\]]/.test(t) && !/const \[sortDir[,\]]/.test(t),
    `${nome}: não tem estado de ordenação próprio`,
  );
  check(
    !/function SortableHeader/.test(t),
    `${nome}: não tem cabeçalho ordenável próprio`,
  );
}

// A proposta de encomenda ERA a única com ordenação, e com cópia
// própria de tudo. É o caso que o motor existe para eliminar.
{
  const t = src("components/encomendas/order-create-client.tsx");
  check(!t.includes("SortCol"), "Encomendas: o tipo local `SortCol` desapareceu");
  check(!t.includes("handleSort"), "…e o `handleSort` local também");
  check(
    t.includes('coluna: "salesQty"') && t.includes('direcao: "desc"'),
    "…mas o default de vendas decrescentes foi PRESERVADO",
  );
  check(
    !/coluna="finalQty"/.test(t),
    "…e a coluna editável «Qtd final» NÃO é ordenável",
  );
}

// ── As vistas de relatório seguem o ecrã ────────────────────────────
//
// Ordenar a tabela e imprimir dava duas ordens diferentes: a tabela
// usava `rowsVisiveis` e a vista de relatório ficara em `orderedRows`.
// A folha impressa é precisamente o artefacto que ninguém volta a
// conferir.
for (const f of [
  "components/excessos/excessos-client.tsx",
  "components/transferencias/transferencias-client.tsx",
]) {
  const t = src(f);
  check(
    !/\{orderedRows\.map\(\(row, index\)/.test(t),
    `${f}: a vista de relatório desenha as linhas ORDENADAS`,
  );
  // Os agregados continuam em `orderedRows` e é correcto: são somas e
  // contagens de CONJUNTOS, e `ordenarLinhas` não filtra — os dois
  // arrays têm os mesmos elementos. Mudá-los seria ruído.
  check(
    /new Set\(orderedRows\.map/.test(t),
    `${f}: …e os agregados de conjunto continuam onde estavam`,
  );
}

// ── O default do motor não mudou ────────────────────────────────────
eq(proximaOrdenacao(null, "x"), { coluna: "x", direcao: "asc" }, "1.º clique continua ascendente");
eq(
  proximaOrdenacao({ coluna: "x", direcao: "asc" } as EstadoOrdenacao<string>, "x"),
  { coluna: "x", direcao: "desc" },
  "2.º clique continua descendente",
);

// ═════════════════════════════════════════════════════════════════════
console.log(`\n${ko === 0 ? "PASSOU" : "FALHOU"} — ${ok} OK, ${ko} falhas\n`);
process.exit(ko === 0 ? 0 : 1);
