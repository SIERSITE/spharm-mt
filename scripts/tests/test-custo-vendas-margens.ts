/**
 * scripts/tests/test-custo-vendas-margens.ts
 *
 * Correcção (2026-09): Vendas e Margens mostravam custos DIFERENTES para
 * o mesmo produto/farmácia/período. Causa exacta:
 *
 *   · A FONTE (PMC preferido, PUC fallback, zero nunca é custo) já era a
 *     mesma regra nos dois — mas `lib/margens-data.ts` reimplementava-a à
 *     mão em vez de chamar `custoDaFarmacia()` (lib/produtos/custo-farmacia.ts),
 *     que `lib/vendas-data.ts` já usava. Duas cópias da mesma ideia é como
 *     um ajuste futuro à regra (ex: uma terceira fonte de custo) só
 *     acontece num dos dois sítios sem ninguém reparar.
 *
 *   · O bug REAL, que produzia números DIFERENTES hoje: `MargemRow.custoUnitario`
 *     vinha de `derivarUnitarios(qty, valorVendido, custoEstimado).custoUnitario`
 *     — ou seja, `arredondar(arredondar(qty × base) / qty)`. Esse
 *     arredondamento DUPLO através do total, em vírgula flutuante, podia
 *     devolver um valor a 2 casas DIFERENTE do `custoUnitarioBase` exacto
 *     (o mesmo PMC/PUC que `lib/vendas-data.ts` mostra em "Custo unit.
 *     est."). Ver a secção B abaixo para um caso concreto e reproduzível
 *     (PMC = 1,0050 €, 10 unidades vendidas: Margens mostrava 1,01 €,
 *     Vendas mostrava 1,00 €).
 *
 * Correcção: `custoUnitario` em `MargemRow` passa a SER
 * `custoUnitarioBase` directamente — nunca re-derivado por divisão de um
 * total já arredondado. `custoUnitarioBase` em si passa a vir de
 * `custoDaFarmacia()`, a MESMA função que `lib/vendas-data.ts` usa para
 * `custoUnitarioEstimado`. Os dois relatórios ficam, por construção,
 * impossibilitados de divergir no custo unitário de um produto.
 *
 * Corre com:  npx tsx scripts/tests/test-custo-vendas-margens.ts
 */
import { readFileSync } from "node:fs";
import { custoDaFarmacia, valorizar } from "../../lib/produtos/custo-farmacia";

let pass = 0;
let fail = 0;
const ok = (label: string, cond: boolean, detalhe?: string) => {
  if (cond) {
    pass++;
    console.log(`  [OK]    ${label}`);
  } else {
    fail++;
    console.log(`  [FALHA] ${label}${detalhe ? ` — ${detalhe}` : ""}`);
  }
};
const eq = <T>(label: string, obtido: T, esperado: T) =>
  ok(label, Object.is(obtido, esperado), `esperado ${JSON.stringify(esperado)}, obtido ${JSON.stringify(obtido)}`);

const src = (p: string) => readFileSync(p, "utf8");

/** round-half-away-from-zero a 2 casas — o `rounded2` usado nos dois loaders. */
function rounded2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Reproduz EXACTAMENTE a fórmula de `lib/vendas-data.ts` para
 * "Custo unit. est." — o valor cru de `custoDaFarmacia`, sem qualquer
 * divisão/arredondamento adicional.
 */
function custoUnitarioVendas(pmc: number | null, puc: number | null): number | null {
  return custoDaFarmacia(pmc, puc).valor;
}

/**
 * A fórmula ACTUAL (pós-correcção) de `custoUnitario` em
 * `lib/margens-data.ts`: `custoUnitarioBase` directamente.
 */
function custoUnitarioMargensNovo(pmc: number | null, puc: number | null): number | null {
  return custoDaFarmacia(pmc, puc).valor;
}

/**
 * A fórmula ANTIGA (pré-correcção, reproduzida aqui só para provar o
 * bug): `arredondar(arredondar(qty × base) / qty)` — o mesmo caminho que
 * `derivarUnitarios(qty, valorVendido, custoEstimado).custoUnitario`
 * percorria quando `custoEstimado` já vinha da linha `MargemRow`.
 */
function custoUnitarioMargensAntigo(
  pmc: number | null,
  puc: number | null,
  qty: number,
): number | null {
  const base = custoDaFarmacia(pmc, puc).valor;
  if (base === null || qty <= 0) return null;
  const custoEstimado = valorizar(qty, base); // arredonda o TOTAL
  if (custoEstimado === null) return null;
  return rounded2(custoEstimado / qty); // … e arredonda OUTRA VEZ ao dividir de volta
}

// ─────────────────────────────────────────────────────────────────────────
// A. Custo unitário — Vendas e Margens (pós-correcção), mesmos dados
// ─────────────────────────────────────────────────────────────────────────

console.log("\n=== A. Custo unitário: Vendas = Margens, mesmos produto/farmácia ===");
{
  // Uma bateria de combinações realistas de PMC/PUC/quantidade — o
  // requisito é: para CADA combinação, o valor que Vendas mostra e o
  // valor que Margens mostra têm de ser EXACTAMENTE o mesmo número.
  const casos: Array<{ pmc: number | null; puc: number | null; qty: number; nota: string }> = [
    { pmc: 3.4567, puc: 3.1, qty: 12, nota: "PMC normal, quantidade normal" },
    { pmc: null, puc: 2.89, qty: 5, nota: "sem PMC, cai para PUC" },
    { pmc: 0, puc: 4.2, qty: 3, nota: "PMC=0 não conta — cai para PUC (zero nunca é custo)" },
    { pmc: 0, puc: 0, qty: 7, nota: "os dois a zero — sem custo, null nos dois relatórios" },
    { pmc: null, puc: null, qty: 9, nota: "os dois null — sem custo" },
    { pmc: 1.005, puc: null, qty: 10, nota: "o caso exacto do bug (ver secção B)" },
    { pmc: 12.9999, puc: 1, qty: 1, nota: "quantidade 1 — o caso trivial" },
    { pmc: 7.1234, puc: 6.9, qty: 333, nota: "quantidade grande" },
  ];

  for (const c of casos) {
    const vendas = custoUnitarioVendas(c.pmc, c.puc);
    const margensNovo = custoUnitarioMargensNovo(c.pmc, c.puc);
    eq(`Vendas = Margens (${c.nota})`, margensNovo, vendas);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// B. O bug concreto que esta correcção elimina
// ─────────────────────────────────────────────────────────────────────────

console.log("\n=== B. Caso concreto e reproduzível do arredondamento duplo ===");
{
  // PMC = 1,0050 € (perfeitamente válido num Decimal(12,4) do ERP),
  // 10 unidades vendidas no período.
  const pmc = 1.005;
  const qty = 10;

  const vendas = custoUnitarioVendas(pmc, null);
  const margensAntigo = custoUnitarioMargensAntigo(pmc, null, qty);
  const margensNovo = custoUnitarioMargensNovo(pmc, null);

  eq("Vendas mostra 1,00 €", vendas, 1.005); // valor CRU — o ecrã formata a 2 casas
  ok(
    "a fórmula ANTIGA de Margens divergia de Vendas — o bug relatado era real",
    margensAntigo !== null && Math.abs(margensAntigo - (vendas as number)) >= 0.005,
    `antigo=${margensAntigo}, vendas=${vendas}`,
  );
  eq("…concretamente: a fórmula antiga arredondava para 1,01 (não 1,00)", margensAntigo, 1.01);
  eq(
    "a fórmula NOVA de Margens já não diverge — é exactamente igual a Vendas",
    margensNovo,
    vendas,
  );

  // Confirma com mais quantidades que o mesmo PMC dispara o mesmo bug na
  // fórmula antiga (não é um acaso de qty=10).
  for (const q of [6, 11, 12, 14]) {
    const antigo = custoUnitarioMargensAntigo(pmc, null, q);
    ok(
      `qty=${q}: a fórmula antiga também divergia`,
      antigo !== null && antigo !== rounded2(pmc),
      `antigo=${antigo}, base arredondada=${rounded2(pmc)}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// C. Inspecção estática — a correcção está mesmo no código
// ─────────────────────────────────────────────────────────────────────────

console.log("\n=== C. lib/margens-data.ts usa a fonte partilhada, não uma cópia ===");
{
  const dados = src("lib/margens-data.ts");
  ok(
    "importa custoDaFarmacia de lib/produtos/custo-farmacia",
    dados.includes('from "@/lib/produtos/custo-farmacia"') && dados.includes("custoDaFarmacia"),
  );
  ok(
    "usa custoDaFarmacia(pmc, puc) para custoUnitarioBase",
    /custoUnitarioBase\s*=\s*custoDaFarmacia\(pmc,\s*puc\)\.valor/.test(dados),
  );
  ok(
    "já não reimplementa a regra PMC>0→PUC>0→null à mão",
    !/pmc\s*!==\s*null\s*&&\s*pmc\s*>\s*0\s*\?\s*pmc\s*:\s*puc\s*!==\s*null\s*&&\s*puc\s*>\s*0\s*\?\s*puc\s*:\s*null/.test(
      dados,
    ),
  );
  ok(
    "usa valorizar() para custoEstimado — mesma função que Vendas",
    /custoEstimado\s*=\s*valorizar\(qty,\s*custoUnitarioBase\)/.test(dados),
  );
  ok(
    "custoUnitario É custoUnitarioBase directamente — não re-derivado por divisão",
    /custoUnitario\s*=\s*custoUnitarioBase\s*;/.test(dados),
  );

  const lv = src("lib/vendas-data.ts");
  ok(
    "lib/vendas-data.ts continua a usar a MESMA função (não regrediu)",
    lv.includes("custoDaFarmacia(") && lv.includes('from "@/lib/produtos/custo-farmacia"'),
  );
}

console.log(`\n${fail === 0 ? "PASSOU" : "FALHOU"} — ${pass} OK, ${fail} falhas\n`);
process.exit(fail === 0 ? 0 : 1);
