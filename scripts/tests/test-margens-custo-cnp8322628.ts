/**
 * scripts/tests/test-margens-custo-cnp8322628.ts
 *
 * Investigação do relatório: "Margens mostra Custo unit. est. = 147,42 €
 * para o CNP 8322628 (VENTILAN INALADOR R AER 100 MCG/D 200 D), quando o
 * artigo tem PMC=3,75€/PUC=5,01€ no SPharm".
 *
 * ── O que a investigação encontrou (produção, tenant Silveira, 2026-09) ──
 *
 * Consultado directamente na base de produção (só leitura):
 *
 *   SELECT pf."farmaciaId", f.nome, pf.pmc, pf.puc
 *   FROM "ProdutoFarmacia" pf JOIN "Farmacia" f ON f.id = pf."farmaciaId"
 *   WHERE pf."produtoId" = '0e8e16c8-2177-4d02-bc99-1461ceca4f50' (CNP 8322628)
 *
 *   farmaciaId                  farmacia               pmc       puc     dataAtualizacao
 *   cmsmx87dk...obow8qp7et       Farmácia Silveirense    3.7400    5.0100  2026-09-13 (fresca)
 *   cmsmx87do...ob7tzxjxei       Farmácia Segurado      147.4200    5.0300  2026-09-03 (12 dias parada)
 *
 * NÃO é um erro de JOIN, nem mistura entre produtos/farmácias, nem um
 * total agregado reaproveitado como unitário:
 *
 *   · `@@unique([produtoId, farmaciaId])` em ProdutoFarmacia (prisma/schema.prisma)
 *     torna estruturalmente impossível haver DUAS linhas para o mesmo
 *     produto+farmácia — não há fanout de JOIN possível.
 *   · O JOIN em lib/margens-data.ts casa produtoId E farmaciaId — nunca
 *     só produtoId.
 *   · `MovimentoArtigo` (o ledger canónico, alimentado directamente por
 *     `dbo.StocksMov` do ERP) mostra `pmcNovo = 147.4200` para Segurado
 *     nesse produto desde 2026-08-26 — o MESMO valor. Não é gerado pela
 *     nossa agregação; é o que o ERP da farmácia Segurado já reporta na
 *     sua própria ficha, arrastado por um histórico de compras/vendas
 *     cuja média ficou distorcida (raiz fora do nosso sistema).
 *   · Segurado não sincroniza há 12 dias (`dataAtualizacao`) — se a
 *     farmácia entretanto corrigiu o PMC no SPharm, essa correcção ainda
 *     não chegou à nossa base. Isto é uma questão operacional de
 *     frescura de sincronização, não um bug de código.
 *
 * `custoDaFarmacia()`/`valorizar()` aplicam a regra correctamente dado o
 * que recebem: PMC=147.42 é `> 0`, logo é usado — exactamente a regra
 * pedida (PMC válido>0 → usar PMC). A função não tem forma de saber que
 * um PMC "válido" (positivo, dentro do tipo) está historicamente errado
 * sem inventar uma heurística não pedida (e a política desta base é
 * "nunca inventar custo").
 *
 * O QUE ESTE TESTE PROVA (o que É código, e é testável):
 *   A. para a farmácia com dados frescos e correctos (Silveirense),
 *      Margens calcula o custo unitário certo — 3,74 € — a partir de
 *      PMC/PUC reais, sem qualquer transformação a mais;
 *   B. o mesmo produto na farmácia com dados desactualizados (Segurado)
 *      reflecte FIELMENTE o que está na base — nunca herda nem contamina
 *      o valor da outra farmácia, nas duas ordens de processamento;
 *   C. inspecção estática: a atribuição de pmc/puc/custoUnitarioBase
 *      dentro do `.map()` de `getMargensData` usa `const` e o parâmetro
 *      da própria linha (`r.pmc`/`r.puc`) — não uma variável partilhada
 *      fora do callback, o que torna a contaminação entre iterações
 *      estruturalmente impossível em JavaScript.
 *
 * Corre com:  npx tsx scripts/tests/test-margens-custo-cnp8322628.ts
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

/**
 * Reproduz FIELMENTE a fórmula de custo por linha de
 * `getMargensData` (lib/margens-data.ts, dentro do `rows.map(...)` que
 * produz `porProduto`) — só a parte de custo, não categoria/IVA/margem,
 * que não são o que está em causa aqui.
 */
type LinhaCrua = { produtoId: string; farmaciaId: string; farmacia: string; pmc: number | null; puc: number | null; qty: number };
type LinhaCusto = { produtoId: string; farmacia: string; custoUnitarioBase: number | null; custoEstimado: number | null };

function montarCusto(r: LinhaCrua): LinhaCusto {
  // Idêntico a lib/margens-data.ts: `const pmc = numOrNull(r.pmc)` etc,
  // tudo declarado DENTRO desta função (o equivalente ao corpo do
  // `.map()`) — nunca lido de fora.
  const pmc = r.pmc;
  const puc = r.puc;
  const custoUnitarioBase = custoDaFarmacia(pmc, puc).valor;
  const custoEstimado = valorizar(r.qty, custoUnitarioBase);
  return { produtoId: r.produtoId, farmacia: r.farmacia, custoUnitarioBase, custoEstimado };
}

// ─────────────────────────────────────────────────────────────────────────
// A. Farmácia com dados frescos — o valor correcto
// ─────────────────────────────────────────────────────────────────────────

console.log("\n=== A. CNP 8322628 na Farmácia Silveirense (dados frescos, 2026-09-13) ===");
{
  // Valores REAIS lidos em produção (ProdutoFarmacia.pmc/puc), só leitura.
  const silveirense: LinhaCrua = {
    produtoId: "0e8e16c8-2177-4d02-bc99-1461ceca4f50",
    farmaciaId: "cmsmx87dk000201obow8qp7et",
    farmacia: "Farmácia Silveirense",
    pmc: 3.74,
    puc: 5.01,
    qty: 1,
  };
  const linha = montarCusto(silveirense);
  eq("Custo unit. est. = 3,74 € (PMC — válido e > 0, ganha ao PUC)", linha.custoUnitarioBase, 3.74);
  eq("Custo est. (1 unidade) = 3,74 €", linha.custoEstimado, 3.74);
  ok(
    "não é 147,42 € — o valor relatado só existe na OUTRA farmácia (Segurado), nunca aqui",
    linha.custoUnitarioBase !== 147.42,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// B. Proteção contra contaminação entre farmácias/produtos
// ─────────────────────────────────────────────────────────────────────────

console.log("\n=== B. Segurado não contamina Silveirense, nem o inverso, em qualquer ordem ===");
{
  const silveirense: LinhaCrua = {
    produtoId: "0e8e16c8-2177-4d02-bc99-1461ceca4f50",
    farmaciaId: "cmsmx87dk000201obow8qp7et",
    farmacia: "Farmácia Silveirense",
    pmc: 3.74,
    puc: 5.01,
    qty: 1,
  };
  // Valores REAIS de Segurado — PMC historicamente distorcido no próprio
  // ERP da farmácia (confirmado em MovimentoArtigo.pmcNovo, ver cabeçalho).
  // É um problema de dados a montante, não algo que este teste "corrija"
  // artificialmente — o ponto é só provar que fica CONTIDO a esta linha.
  const segurado: LinhaCrua = {
    produtoId: "0e8e16c8-2177-4d02-bc99-1461ceca4f50",
    farmaciaId: "cmsmx87do000301ob7tzxjxei",
    farmacia: "Farmácia Segurado",
    pmc: 147.42,
    puc: 5.03,
    qty: 1,
  };

  // Duas ordens diferentes de processamento — como `rows.map()` faria,
  // qualquer que seja a ordem que o ORDER BY da query devolva.
  for (const [ordem, linhas] of [
    ["Silveirense → Segurado", [silveirense, segurado]],
    ["Segurado → Silveirense", [segurado, silveirense]],
  ] as const) {
    const resultado = linhas.map(montarCusto);
    const porFarmacia = new Map(resultado.map((l) => [l.farmacia, l.custoUnitarioBase]));
    eq(`[${ordem}] Silveirense mantém 3,74 €`, porFarmacia.get("Farmácia Silveirense"), 3.74);
    eq(`[${ordem}] Segurado mantém 147,42 € (o seu próprio valor, não inventado nem escondido)`, porFarmacia.get("Farmácia Segurado"), 147.42);
  }

  // Mesmo PRODUTO (mesmo produtoId), farmácias diferentes — o cenário
  // exacto que poderia colidir num Map indexado só por produtoId.
  ok(
    "as duas linhas partilham o MESMO produtoId — é precisamente o caso de risco",
    silveirense.produtoId === segurado.produtoId,
  );
  const combinadas = [silveirense, segurado].map(montarCusto);
  eq("…e mesmo assim continuam DUAS linhas distintas", combinadas.length, 2);
  ok(
    "…cada uma com o custo da SUA farmácia — nenhuma reutiliza a do produtoId 'vizinho'",
    combinadas[0].custoUnitarioBase === 3.74 && combinadas[1].custoUnitarioBase === 147.42,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// C. Inspecção estática — a contenção é estrutural no código real
// ─────────────────────────────────────────────────────────────────────────

console.log("\n=== C. lib/margens-data.ts: sem estado partilhado entre linhas ===");
{
  const dados = src("lib/margens-data.ts");
  const mapa = dados.match(/const porProduto: MargemRow\[\] = rows\.map\(\(r\) => \{[\s\S]*?\n {2}\}\);/);
  ok("encontra o corpo do rows.map() que constrói porProduto", mapa !== null);
  const corpo = mapa ? mapa[0] : "";
  ok(
    "pmc/puc lidos do PARÂMETRO da própria linha (r.pmc/r.puc), não duma variável externa",
    /const pmc = numOrNull\(r\.pmc\)/.test(corpo) && /const puc = numOrNull\(r\.puc\)/.test(corpo),
  );
  ok(
    "custoUnitarioBase é `const` — recriado a cada chamada do callback, nunca `let`/mutável entre iterações",
    /const custoUnitarioBase = custoDaFarmacia\(pmc, puc\)\.valor;/.test(corpo),
  );
  ok(
    "nenhuma variável de custo declarada FORA do map() e reutilizada dentro (grep por 'let custoUnitarioBase' fora do corpo)",
    !/let custoUnitarioBase/.test(dados),
  );
  ok(
    "o JOIN casa produtoId E farmaciaId — nunca só produtoId (fonte de contaminação entre farmácias)",
    /pf\."produtoId" = agg\."produtoId" AND pf\."farmaciaId" = agg\."farmaciaId"/.test(dados),
  );

  const schema = src("prisma/schema.prisma");
  ok(
    "ProdutoFarmacia tem @@unique([produtoId, farmaciaId]) — impossível existir 2 linhas para o mesmo par",
    /@@unique\(\[produtoId, farmaciaId\]\)/.test(schema),
  );
}

console.log(`\n${fail === 0 ? "PASSOU" : "FALHOU"} — ${pass} OK, ${fail} falhas\n`);
process.exit(fail === 0 ? 0 : 1);
