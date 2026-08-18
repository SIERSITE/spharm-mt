/**
 * scripts/tests/test-vendas-periodo.ts
 *
 * Fixa a janela temporal do relatório de Vendas.
 *
 * ── O DEFEITO QUE ISTO IMPEDE DE VOLTAR ──────────────────────────────
 *
 * `getVendasData` lia `from`/`to` com `^(\d{4})-(\d{2})` e deitava o dia
 * fora. `01/08→17/08` e `01/08→31/08` davam o MESMO resultado, e o
 * período devolvido era o mês inteiro — a UI dividia 6936 unidades por
 * 31 dias e anunciava uma média diária de 223,7 quando a resposta era
 * 408.
 *
 * Nenhum teste apanhava isto porque mudar o MÊS mudava o número. Só
 * dentro do mesmo mês é que não mudava — que é o caso operacional.
 *
 * Estes testes são sobre a decomposição da janela e o SQL que dela sai:
 * puros, sem base de dados. A reconciliação com números reais está em
 * `test-vendas-reconciliacao.ts`, que precisa de uma BD.
 *
 * Uso: npx tsx scripts/tests/test-vendas-periodo.ts
 */
import { readFileSync } from "node:fs";
import {
  bucketsDaJanela,
  decomporJanela,
  diaSeguinte,
  diaValido,
  diasInclusive,
  mesAlinhada,
  normalizarJanela,
  ultimoDiaDoMes,
} from "../../lib/vendas/janela";

let pass = 0;
let fail = 0;
const ok = (l: string) => { pass++; console.log(`  [OK]    ${l}`); };
const bad = (l: string, d?: string) => { fail++; console.log(`  [FALHA] ${l}${d ? `\n            ${d}` : ""}`); };
const check = (c: boolean, l: string, d?: string) => (c ? ok(l) : bad(l, d));
const eq = (a: unknown, b: unknown, l: string) =>
  check(JSON.stringify(a) === JSON.stringify(b), l, `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);

console.log("=== o dia deixa de ser deitado fora ===");
{
  const parcial = normalizarJanela("2026-08-01", "2026-08-17");
  const completa = normalizarJanela("2026-08-01", "2026-08-31");
  eq(parcial.to, "2026-08-17", "o `to` pedido é o `to` aplicado — não é esticado ao fim do mês");
  check(
    JSON.stringify(decomporJanela(parcial)) !== JSON.stringify(decomporJanela(completa)),
    "01/08→17/08 e 01/08→31/08 produzem DECOMPOSIÇÕES diferentes",
    "era isto que era igual: o dia perdia-se e as duas janelas colapsavam no mesmo mês",
  );
  eq(diasInclusive(parcial), 17, "17 dias, não 31 — é o divisor da média diária");
  eq(diasInclusive(completa), 31, "e o mês inteiro tem 31");
}

console.log("\n=== mesAlinhada: quando as duas fontes são equivalentes ===");
{
  check(mesAlinhada({ from: "2026-08-01", to: "2026-08-31" }), "mês inteiro é alinhado");
  check(mesAlinhada({ from: "2026-02-01", to: "2026-02-28" }), "Fevereiro de 2026 acaba a 28");
  check(mesAlinhada({ from: "2024-02-01", to: "2024-02-29" }), "…e o bissexto a 29");
  check(!mesAlinhada({ from: "2024-02-01", to: "2024-02-28" }), "…logo 28 num bissexto NÃO é alinhado");
  check(!mesAlinhada({ from: "2026-08-01", to: "2026-08-30" }), "falta um dia no fim → não alinhado");
  check(!mesAlinhada({ from: "2026-08-02", to: "2026-08-31" }), "falta um dia no início → não alinhado");
  check(mesAlinhada({ from: "2026-01-01", to: "2026-08-31" }), "vários meses inteiros também alinham");
  eq(ultimoDiaDoMes(2026, 2), 28, "último dia de Fev/2026");
  eq(ultimoDiaDoMes(2024, 2), 29, "último dia de Fev/2024");
}

console.log("\n=== decomposição: cada mês numa só fonte ===");
{
  // O caso operacional: 1 de Janeiro até meio de Agosto.
  const d = decomporJanela({ from: "2026-01-01", to: "2026-08-18" });
  eq(d.mesesInteiros, { minIdx: 2026 * 12 + 1, maxIdx: 2026 * 12 + 7 }, "Jan..Jul vêm da agregação mensal");
  eq(d.parciais, [{ from: "2026-08-01", to: "2026-08-18" }], "…e só Agosto vai às linhas");
  check(
    d.parciais.every((p) => {
      const mes = Number(p.from.slice(5, 7));
      const idx = Number(p.from.slice(0, 4)) * 12 + mes;
      return !d.mesesInteiros || idx < d.mesesInteiros.minIdx || idx > d.mesesInteiros.maxIdx;
    }),
    "nenhum mês está nas DUAS partes — somar as duas não conta nada duas vezes",
  );
}
{
  const d = decomporJanela({ from: "2026-08-01", to: "2026-08-31" });
  eq(d.parciais, [], "janela mês-alinhada não toca nas linhas");
  eq(d.mesesInteiros, { minIdx: 2026 * 12 + 8, maxIdx: 2026 * 12 + 8 }, "…e resolve-se toda na agregação");
}
{
  const d = decomporJanela({ from: "2026-08-05", to: "2026-08-17" });
  eq(d.mesesInteiros, null, "pedaço de um só mês: não há mês inteiro nenhum");
  eq(d.parciais, [{ from: "2026-08-05", to: "2026-08-17" }], "…e resolve-se todo nas linhas");
}
{
  // Duas pontas parciais + meio inteiro.
  const d = decomporJanela({ from: "2026-06-10", to: "2026-08-20" });
  eq(d.mesesInteiros, { minIdx: 2026 * 12 + 7, maxIdx: 2026 * 12 + 7 }, "só Julho é inteiro");
  eq(
    d.parciais,
    [{ from: "2026-06-10", to: "2026-06-30" }, { from: "2026-08-01", to: "2026-08-20" }],
    "cabeça e cauda vão às linhas",
  );
}
{
  // Dois meses adjacentes, ambos parciais: não sobra mês inteiro.
  const d = decomporJanela({ from: "2026-07-15", to: "2026-08-10" });
  eq(d.mesesInteiros, null, "meses adjacentes ambos parciais → nenhum inteiro");
  eq(d.parciais.length, 2, "…duas sub-janelas");
}

console.log("\n=== fronteiras e entradas defeituosas ===");
{
  eq(diaSeguinte("2026-08-31"), "2026-09-01", "o `to` exclusivo do SQL passa o fim do mês");
  eq(diaSeguinte("2024-02-28"), "2024-02-29", "…e o bissexto");
  eq(diaSeguinte("2026-12-31"), "2027-01-01", "…e o fim do ano");
}
{
  check(!diaValido("2026-02-30"), "2026-02-30 não existe");
  check(!diaValido("2026-13-01"), "não há mês 13");
  check(!diaValido("2026-08"), "yyyy-mm não é um dia");
  check(diaValido("2026-08-17"), "…e um dia real é aceite");
}
{
  const j = normalizarJanela("2026-08-17", "2026-08-01");
  eq(j, { from: "2026-08-01", to: "2026-08-17" }, "datas trocadas são endireitadas, não devolvem vazio");
}
{
  const j = normalizarJanela("lixo", undefined, new Date("2026-08-18T10:00:00Z"));
  eq(j.from, "2026-01-01", "data inválida cai no default do ano corrente");
  eq(j.to, "2026-08-18", "…e o fim é hoje, não o fim do mês");
}

console.log("\n=== buckets: as colunas do relatório ===");
{
  eq(
    bucketsDaJanela({ from: "2026-07-15", to: "2026-09-02" }).map((b) => `${b.ano}-${b.mes}`),
    ["2026-7", "2026-8", "2026-9"],
    "uma coluna por mês tocado, mesmo em pontas parciais",
  );
  eq(bucketsDaJanela({ from: "2026-08-05", to: "2026-08-06" }).length, 1, "dois dias do mesmo mês → uma coluna");
  eq(
    bucketsDaJanela({ from: "2026-12-20", to: "2027-01-05" }).map((b) => `${b.ano}-${b.mes}`),
    ["2026-12", "2027-1"],
    "a passagem de ano não parte a sequência",
  );
}

console.log("\n=== a semântica de venda vive num sítio só ===");
{
  // Se alguém voltar a escrever o CASE à mão num consumidor, os dois
  // caminhos podem divergir sem que nenhum teste de unidade dê por isso.
  const loader = readFileSync(new URL("../../lib/vendas-data.ts", import.meta.url), "utf8");
  const agg = readFileSync(new URL("../../lib/aggregate/vendamensal.ts", import.meta.url), "utf8");

  for (const frag of ["SQL_QUANTIDADE_ASSINADA", "SQL_VALOR_BRUTO_ASSINADO", "SQL_LINHAS_ELEGIVEIS"]) {
    check(agg.includes(`export const ${frag}`), `${frag} é exportado pela agregação`);
    check(loader.includes(frag), `…e o loader de Vendas usa-o em vez de o reescrever`);
  }
  check(
    !/HAVING\s+SUM\(vm\.quantidade\)\s*>\s*0/.test(loader),
    "o loader já não descarta produtos de saldo líquido negativo com `HAVING > 0`",
    "era isso que punha o total 5 unidades acima do ledger em Agosto/2026",
  );
  check(
    !/ymToIndex/.test(loader),
    "o regex que deitava o dia fora desapareceu do loader",
  );
}

console.log("\n=== o valor em euros vem do ledger, não do preço de hoje ===");
{
  const cliente = readFileSync(
    new URL("../../components/vendas/vendas-client.tsx", import.meta.url),
    "utf8",
  );
  check(
    !/row\.totalVendas\s*\*\s*row\.pvp/.test(cliente),
    "o total já não é `totalVendas × pvp` (pvp = preço de HOJE em ProdutoFarmacia)",
    "reprecificava o histórico: 98 952,93 € onde as linhas somam 98 829,51 €",
  );
  check(cliente.includes("row.valorBruto"), "…usa o `valorBruto` devolvido pelo loader");
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail === 0 ? 0 : 1);
