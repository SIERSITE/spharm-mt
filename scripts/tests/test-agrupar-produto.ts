/**
 * scripts/tests/test-agrupar-produto.ts
 *
 * Ponto 2 — consolidação de `Line[]` por produto em modo grupo
 * (`lib/encomendas/agrupar-produto.ts`).
 *
 *   A. 1 produto em 1 farmácia — grupo trivial
 *   B. 1 produto em N farmácias (2, 3, 5)
 *   C. preservação de TODOS os campos por sub-linha (nada achatado/perdido)
 *   D. vários produtos — ordem de PRIMEIRA APARIÇÃO, sem reordenar
 *   E. vazio não rebenta
 *   F. wiring — order-create-client.tsx usa `agruparPorProduto` em modo grupo
 *
 * Corre com:  npx tsx scripts/tests/test-agrupar-produto.ts
 */
import { readFileSync } from "node:fs";
import { agruparPorProduto, type LinhaAgrupavel } from "../../lib/encomendas/agrupar-produto";

let pass = 0;
let fail = 0;
const ok = (l: string) => { pass++; console.log(`  [OK]    ${l}`); };
const bad = (l: string, d?: string) => { fail++; console.log(`  [FALHA] ${l}${d ? `\n            ${d}` : ""}`); };
const check = (c: boolean, l: string, d?: string) => (c ? ok(l) : bad(l, d));
const eq = (a: unknown, b: unknown, l: string) =>
  check(JSON.stringify(a) === JSON.stringify(b), l, `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);

const src = (p: string) => readFileSync(p, "utf8");

/** Uma "linha do ecrã" completa, com todos os campos por-farmácia que o Ponto 2 exige preservar. */
type LinhaTeste = LinhaAgrupavel & {
  key: number;
  farmaciaId: string | null;
  farmaciaNome: string | null;
  acao: "ENCOMENDAR" | "TRANSFERIR" | "NAO_FAZER";
  acaoTocada: boolean;
  farmaciaEncomendaId: string | null;
  farmaciaOrigemId: string | null;
  farmaciaDestinoId: string | null;
  finalQty: string;
  notas: string;
  estado: string | null;
  excessoFonte: string[];
};

let keyCounter = 0;
function linha(partial: Partial<LinhaTeste> & { produtoId: string; farmaciaId: string }): LinhaTeste {
  return {
    key: ++keyCounter,
    cnp: 12345,
    designacao: "Produto X",
    fabricante: "Fabricante X",
    fornecedor: "Fornecedor X",
    farmaciaNome: `Farmácia ${partial.farmaciaId}`,
    acao: "NAO_FAZER",
    acaoTocada: false,
    farmaciaEncomendaId: null,
    farmaciaOrigemId: null,
    farmaciaDestinoId: null,
    finalQty: "0",
    notas: "",
    estado: null,
    excessoFonte: [],
    ...partial,
  };
}

// ═════════════════════════════════════════════════════════════════════
// A · 1 produto em 1 farmácia — grupo trivial
// ═════════════════════════════════════════════════════════════════════
console.log("\nA · 1 produto em 1 farmácia — grupo trivial\n");
{
  const linhas = [linha({ produtoId: "p1", farmaciaId: "fA" })];
  const grupos = agruparPorProduto(linhas);
  eq(grupos.length, 1, "um único grupo");
  eq(grupos[0].subLinhas.length, 1, "…com uma única sub-linha");
  eq(grupos[0].produtoId, "p1", "produtoId do grupo é o do produto");
  eq(grupos[0].subLinhas[0].farmaciaId, "fA", "a sub-linha preserva a farmácia");
}

// ═════════════════════════════════════════════════════════════════════
// B · 1 produto em N farmácias (2, 3, 5)
// ═════════════════════════════════════════════════════════════════════
console.log("\nB · 1 produto em N farmácias\n");
for (const n of [2, 3, 5]) {
  const farmaciaIds = Array.from({ length: n }, (_, i) => `f${i}`);
  const linhas = farmaciaIds.map((fid) => linha({ produtoId: "pN", farmaciaId: fid }));
  const grupos = agruparPorProduto(linhas);
  eq(grupos.length, 1, `n=${n}: continua a ser UM grupo (mesmo produto)`);
  eq(grupos[0].subLinhas.length, n, `n=${n}: ${n} sub-linhas, uma por farmácia`);
  eq(
    grupos[0].subLinhas.map((l) => l.farmaciaId),
    farmaciaIds,
    `n=${n}: a ordem das sub-linhas é a ordem de entrada`,
  );
}

// ═════════════════════════════════════════════════════════════════════
// C · Preservação de TODOS os campos por sub-linha — nada achatado
// ═════════════════════════════════════════════════════════════════════
console.log("\nC · nenhum campo por-farmácia é achatado ou perdido\n");
{
  const linhas = [
    linha({
      produtoId: "p1", farmaciaId: "fA", acao: "TRANSFERIR", acaoTocada: true,
      farmaciaOrigemId: "fA", farmaciaDestinoId: "fB", finalQty: "12", notas: "nota A",
      estado: "TRANSFERÊNCIA", excessoFonte: ["fB"],
    }),
    linha({
      produtoId: "p1", farmaciaId: "fB", acao: "ENCOMENDAR", acaoTocada: false,
      farmaciaEncomendaId: "fB", finalQty: "7", notas: "nota B", estado: "COMPRAR",
    }),
  ];
  const [grupo] = agruparPorProduto(linhas);
  eq(grupo.subLinhas.length, 2, "duas sub-linhas");

  const a = grupo.subLinhas.find((l) => l.farmaciaId === "fA")!;
  eq(a.acao, "TRANSFERIR", "fA: acao preservada");
  eq(a.acaoTocada, true, "fA: acaoTocada preservada");
  eq(a.farmaciaOrigemId, "fA", "fA: farmaciaOrigemId preservada");
  eq(a.farmaciaDestinoId, "fB", "fA: farmaciaDestinoId preservada");
  eq(a.finalQty, "12", "fA: finalQty preservada");
  eq(a.notas, "nota A", "fA: notas preservadas");
  eq(a.estado, "TRANSFERÊNCIA", "fA: estado preservado");
  eq(a.excessoFonte, ["fB"], "fA: excessoFonte preservada");
  eq(a.key, linhas[0].key, "fA: a MESMA instância (key idêntica) — não é uma cópia parcial");

  const b = grupo.subLinhas.find((l) => l.farmaciaId === "fB")!;
  eq(b.acao, "ENCOMENDAR", "fB: acao preservada, independente de fA");
  eq(b.farmaciaEncomendaId, "fB", "fB: farmaciaEncomendaId preservada");
  eq(b.finalQty, "7", "fB: finalQty própria, não a de fA (12)");
  eq(b.notas, "nota B", "fB: notas próprias");

  check(
    grupo.designacao === "Produto X" && grupo.cnp === 12345 && grupo.fabricante === "Fabricante X" && grupo.fornecedor === "Fornecedor X",
    "o cabeçalho do grupo herda designação/cnp/fabricante/fornecedor da 1ª sub-linha",
  );
}

// ═════════════════════════════════════════════════════════════════════
// D · Vários produtos — ordem de PRIMEIRA APARIÇÃO
// ═════════════════════════════════════════════════════════════════════
console.log("\nD · vários produtos mantêm a ordem de primeira aparição\n");
{
  const linhas = [
    linha({ produtoId: "p2", farmaciaId: "fA" }),
    linha({ produtoId: "p1", farmaciaId: "fA" }),
    linha({ produtoId: "p2", farmaciaId: "fB" }), // 2ª aparição de p2 — não move o grupo
    linha({ produtoId: "p3", farmaciaId: "fA" }),
    linha({ produtoId: "p1", farmaciaId: "fB" }),
  ];
  const grupos = agruparPorProduto(linhas);
  eq(grupos.map((g) => g.produtoId), ["p2", "p1", "p3"], "ordem = primeira aparição de cada produtoId, não ordem alfabética nem por farmácia");
  eq(grupos.find((g) => g.produtoId === "p2")!.subLinhas.length, 2, "p2 acumula as duas aparições (fA e fB) no mesmo grupo");
  eq(grupos.find((g) => g.produtoId === "p1")!.subLinhas.length, 2, "p1 acumula as duas aparições");
  eq(grupos.find((g) => g.produtoId === "p3")!.subLinhas.length, 1, "p3 fica com a única aparição");
}

// ═════════════════════════════════════════════════════════════════════
// E · Vazio não rebenta
// ═════════════════════════════════════════════════════════════════════
console.log("\nE · lista vazia devolve [] sem lançar\n");
eq(agruparPorProduto([]), [], "sem linhas, sem grupos");

// ═════════════════════════════════════════════════════════════════════
// F · Wiring — order-create-client.tsx usa isto em modo grupo
// ═════════════════════════════════════════════════════════════════════
console.log("\nF · as pontas estão ligadas\n");
{
  const cliente = src("components/encomendas/order-create-client.tsx");
  check(
    cliente.includes('from "@/lib/encomendas/agrupar-produto"'),
    "order-create-client.tsx importa de lib/encomendas/agrupar-produto",
  );
  check(
    /agruparPorProduto\(visibleLinhas\)/.test(cliente),
    "agrupa a lista JÁ FILTRADA (visibleLinhas), não `linhas` em bruto — Ponto 2.4: filtra primeiro, agrupa depois",
  );
  check(
    /mode !== "grupo"\) return \[\];\s*\n\s*return agruparPorProduto/.test(cliente),
    "a consolidação só corre em mode === \"grupo\" — farmacia/consolidação continuam sem alteração",
  );
  check(
    cliente.includes("gruposProduto.flatMap((g) => g.subLinhas)"),
    "a navegação por teclado (Ponto 3) usa a MESMA estrutura agrupada, achatada — não um índice à parte",
  );
}

console.log(`\n${fail === 0 ? "PASSOU" : "FALHOU"} — ${pass} OK, ${fail} falhas\n`);
process.exit(fail === 0 ? 0 : 1);
