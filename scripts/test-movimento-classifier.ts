/**
 * scripts/test-movimento-classifier.ts
 *
 * Testes assert-based para `lib/movimento-classifier.ts`.
 * Cobre:
 *  1. FK pattern (6 colunas) → tipo macro
 *  2. Sub-classificação VENDA vs DEVOLUCAO_CLIENTE via Atendimento.TipoDoc
 *  3. Todos os 31 motivos do Segurado (rev32 audit) → ACERTO_STOCK
 *  4. Todos os 53 motivos do Silveirense (rev32 audit) → ACERTO_STOCK
 *  5. Nenhum `cab.[Tipo Documento ID]` altera o resultado
 *  6. DESCONHECIDO só quando não há FK nenhuma
 *
 * ── O que estes testes passaram a provar (rev60) ──────────────────
 *
 * A terceira coluna das duas tabelas de motivos era o tipo que o
 * classificador inferia do TEXTO. Está lá na mesma, mas mudou de papel:
 * já não é o que se espera, é o registo do que se deixou de inferir. A
 * asserção passou a ser a mesma para as 84 linhas — ACERTO_STOCK — e é
 * isso que torna o teste forte. Uma regex reintroduzida a favor de
 * "inventário" ou "quebra" volta a partir estas 84 de uma vez.
 *
 * Uso:
 *   npx tsx scripts/test-movimento-classifier.ts
 *
 * Sai com código != 0 se algum assert falhar. Imprime sumário no fim.
 */

import { strict as assert } from "node:assert";
import {
  classifyMovimento,
  type FkPattern,
  type TipoMovimentoArtigo,
} from "../lib/movimento-classifier";

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────
const EMPTY_FK: FkPattern = {
  detalheId: null,
  suspDetalheId: null,
  creditoDetalheId: null,
  recpDetalheId: null,
  devolucaoDetalheId: null,
  movStocksDetId: null,
};
function fkOnly(field: keyof FkPattern): FkPattern {
  return { ...EMPTY_FK, [field]: 1234 };
}

let pass = 0;
let fail = 0;
const failures: string[] = [];

function it(name: string, fn: () => void): void {
  try {
    fn();
    pass++;
  } catch (err) {
    fail++;
    failures.push(`${name}\n  ${err instanceof Error ? err.message : String(err)}`);
  }
}

function expectTipo(
  input: Parameters<typeof classifyMovimento>[0],
  expected: TipoMovimentoArtigo,
  label: string,
): void {
  it(label, () => {
    const r = classifyMovimento(input);
    assert.equal(
      r.tipo,
      expected,
      `expected ${expected}, got ${r.tipo} (reason=${r.reason})`,
    );
  });
}

// ─────────────────────────────────────────────────────────────────────
// 1. FK pattern — origem macro
// ─────────────────────────────────────────────────────────────────────

expectTipo(
  { fk: fkOnly("detalheId"), atendimentoTipoDocId: 7 },
  "VENDA",
  "FK [Detalhe ID] + TipoDoc=7 → VENDA",
);
expectTipo(
  { fk: fkOnly("detalheId"), atendimentoTipoDocId: 2 },
  "VENDA",
  "FK [Detalhe ID] + TipoDoc=2 → VENDA",
);
expectTipo(
  { fk: fkOnly("detalheId"), atendimentoTipoDocId: 104 },
  "DEVOLUCAO_CLIENTE",
  "FK [Detalhe ID] + TipoDoc=104 → DEVOLUCAO_CLIENTE",
);
expectTipo(
  { fk: fkOnly("detalheId"), atendimentoTipoDocId: 27 },
  "DEVOLUCAO_CLIENTE",
  "FK [Detalhe ID] + TipoDoc=27 → DEVOLUCAO_CLIENTE",
);
expectTipo(
  { fk: fkOnly("detalheId"), atendimentoTipoDocId: null },
  "VENDA",
  "FK [Detalhe ID] + TipoDoc=null → VENDA (fallback seguro)",
);
expectTipo(
  { fk: fkOnly("recpDetalheId") },
  "COMPRA",
  "FK [Detalhe  Recp ID] → COMPRA",
);
expectTipo(
  { fk: fkOnly("devolucaoDetalheId") },
  "DEVOLUCAO_FORNECEDOR",
  "FK [Devolucao Detalhe ID] → DEVOLUCAO_FORNECEDOR",
);
expectTipo(
  { fk: fkOnly("creditoDetalheId") },
  "VENDA_CREDITO",
  "FK [Atendimento Credito Detalhe ID] → VENDA_CREDITO",
);
expectTipo(
  { fk: fkOnly("suspDetalheId") },
  "RESERVA_SUSPENSA",
  "FK [Atendimento Susp Detalhe ID] → RESERVA_SUSPENSA",
);

// Sem FK populada → DESCONHECIDO
expectTipo(
  { fk: EMPTY_FK },
  "DESCONHECIDO",
  "Sem FK populada → DESCONHECIDO",
);

// ─────────────────────────────────────────────────────────────────────
// 2. Motivos Segurado (rev32 audit) — todos os 31 valores tblMovStocksCab_Motivo
// ─────────────────────────────────────────────────────────────────────

const MOV_INT_FK = fkOnly("movStocksDetId");

const seguradoMotivos: Array<[number, string, TipoMovimentoArtigo]> = [
  [0, "Inventário Permanente", "INVENTARIO"],
  [1, "acerto stock", "AJUSTE"],
  [2, "ValorMed", "PERDA"],
  [3, "Acerto Inventario 2010", "INVENTARIO"],
  [4, "6840769", "AJUSTE"], // numérico opaco
  [5, "Acerto Ficha Artigo", "INVENTARIO"],
  [6, "produto danificado", "QUEBRA"],
  [7, "reservas nao levantadas", "AJUSTE"],
  [8, "V", "AJUSTE"], // single-char opaco
  [9, "uso interno", "PERDA"],
  [10, "Erro Devolução Fornecdor", "AJUSTE"], // typo do operador preservado
  [11, "Erro Devolução Fornecedor", "AJUSTE"],
  [12, "BONUS", "AJUSTE"],
  [13, "Inventário.", "INVENTARIO"],
  [14, "Vac- Quebra acidental na manipulação", "QUEBRA"],
  [15, "Vac- Quebra na rede de frio", "QUEBRA"],
  [16, "Vac- Prazo de validade expirado", "QUEBRA"],
  [17, "Vac- Prazo de validade expirado após descongelação", "QUEBRA"],
  [18, "Vac- Prazo de validade expirado após frasco perfurado", "QUEBRA"],
  [19, "Vac- Defeito de qualidade/segurança", "QUEBRA"],
  [20, "Vac- Desvio de temperatura durante o transporte", "QUEBRA"], // regex "desvio.*temperatura"
  [21, "Vac- Usando a técnica recomendada, não foi possível extrair o número expectável de doses", "PERDA"], // sem match texto → cab fallback (28,qtd=-1) → PERDA. Semanticamente perda de vial.
  [22, "troca de codigos ", "AJUSTE"],
  [23, "erro na entrada da encomenda", "AJUSTE"],
  [24, "inventário 2024", "INVENTARIO"],
  [25, "oferta natal 2024", "PERDA"], // oferta = perda comercial; sem match texto → fallback Cab.28+qtd<0 → PERDA
  [26, "inventário 2025", "INVENTARIO"],
  [27, "prazo de validade", "QUEBRA"],
  [28, "acerto codigos cnp", "AJUSTE"],
  [29, "QUEBRA", "QUEBRA"],
  [30, "inventário 2026", "INVENTARIO"],
];

for (const [id, txt, tipoAntigo] of seguradoMotivos) {
  expectTipo(
    { fk: MOV_INT_FK, motivoTexto: txt, cabTipoDocId: 28, qtd: -1 },
    "ACERTO_STOCK",
    `Segurado motivo[${id}] "${txt}" → ACERTO_STOCK (era ${tipoAntigo})`,
  );
}

// ─────────────────────────────────────────────────────────────────────
// 3. Motivos Silveirense (rev32 audit) — 53 valores (incl. inactivos)
// ─────────────────────────────────────────────────────────────────────

const silveirenseMotivos: Array<[number, string | null, TipoMovimentoArtigo]> = [
  [0, "Inventário Permanente", "INVENTARIO"],
  [1, "nao aceite pelo fornecedor", "PERDA"],
  [2, "erro stock", "AJUSTE"],
  [3, "acerto stock", "AJUSTE"],
  [4, "acerto de stock", "AJUSTE"],
  [5, "AcERTO DE STOCKerto de stock", "AJUSTE"],
  [6, "ENGANO DE BONUS", "AJUSTE"],
  [7, "troca de laboratorio", "AJUSTE"],
  [8, "TROCA LABORATORIO", "AJUSTE"],
  [9, null, "PERDA"], // motivo NULL + Cab.28 + qtd=-1 → PERDA (fallback regra)
  [11, "entrada unidade vendida pak", "AJUSTE"],
  [14, "encomenda antiga ñdado entrada", "AJUSTE"],
  [15, "ValorMed", "PERDA"],
  [17, "uso interno", "PERDA"],
  [18, "8684878", "AJUSTE"],
  [19, "PAGAMENTO MONTRA", "PERDA"],
  [20, "troca sr. Decafarma", "AJUSTE"],
  [23, "ENTRADA CX SAIDA UNIDADE", "AJUSTE"],
  [24, "acerto de stock novo codig", "AJUSTE"],
  [25, "ACERTO STOCK/INVENTARIO", "INVENTARIO"],
  [27, "reserva2174", "AJUSTE"],
  [28, "reserva 2215", "AJUSTE"],
  [29, "reserva2622", "AJUSTE"],
  [31, "RESERVA2861", "AJUSTE"],
  [32, "reserva 3298", "AJUSTE"],
  [33, "reserva 3473", "AJUSTE"],
  [34, "troca de codigo", "AJUSTE"],
  [35, "reserva           ", "AJUSTE"],
  [36, "Acerto Ficha Artigo", "INVENTARIO"],
  [37, "embalagem danificada", "QUEBRA"],
  [39, "VALORMED- LABORATORIO FECHOU", "PERDA"],
  [43, "lab. Nao aceitou produto", "PERDA"],
  [44, "valormed lab. Nao aceita", "PERDA"],
  [45, "6612812", "AJUSTE"],
  [47, "7301101", "AJUSTE"],
  [48, "AUTO-DESTRUICAO", "QUEBRA"],
  [49, "AUTO -CONSUMO", "PERDA"],
  [50, "VALIDADE EXPIRADA", "QUEBRA"],
  [51, "PRAZO VALIDADE (OFERTA LAB)", "QUEBRA"],
  [52, "PRAZO VALIDADE ", "QUEBRA"],
  [53, "Vac- Quebra acidental na manipulação", "QUEBRA"],
  [54, "Vac- Quebra na rede de frio", "QUEBRA"],
  [55, "Vac- Prazo de validade expirado", "QUEBRA"],
  [56, "Vac- Prazo de validade expirado após descongelação", "QUEBRA"],
  [57, "Vac- Prazo de validade expirado após frasco perfurado", "QUEBRA"],
  [58, "Vac- Defeito de qualidade/segurança", "QUEBRA"],
  [61, "Bonus errado", "AJUSTE"],
  [62, "quebra na rede de frio", "QUEBRA"],
  [63, "ERRO DE BONUS", "AJUSTE"],
  [64, "devolucao nao aceite", "PERDA"],
  [65, "PRODUTO PARA DESTRUIÇÃO", "QUEBRA"],
];

for (const [id, txt, tipoAntigo] of silveirenseMotivos) {
  expectTipo(
    { fk: MOV_INT_FK, motivoTexto: txt, cabTipoDocId: 28, qtd: -1 },
    "ACERTO_STOCK",
    `Silveirense motivo[${id}] ${txt === null ? "NULL" : `"${txt}"`} → ACERTO_STOCK (era ${tipoAntigo})`,
  );
}

// O mesmo corpus, agora sem NADA além da FK. Se o resultado é igual com
// e sem motivo, o motivo não está a decidir — que é a afirmação toda.
for (const [id, txt] of [...seguradoMotivos, ...silveirenseMotivos]) {
  expectTipo(
    { fk: MOV_INT_FK },
    "ACERTO_STOCK",
    `motivo[${id}] ${txt === null ? "NULL" : `"${txt}"`} omitido → mesmo resultado`,
  );
}

// ─────────────────────────────────────────────────────────────────────
// 4. `cab.[Tipo Documento ID]` deixou de decidir
// ─────────────────────────────────────────────────────────────────────
//
// Os IDs abaixo são os que a auditoria rev32 observou, e cada um deles
// produzia um tipo diferente. 43-54 eram os mais perigosos: davam
// TRANSFERENCIA_ENTRADA / SAIDA a um movimento que não tem contraparte
// nem guia. E os IDs são LOCAIS a cada tenant — o mesmo 28 não
// significa o mesmo nas duas farmácias.

for (const tipoDoc of [14, 25, 28, 29, 43, 44, 45, 46, 47, 48, 49, 52, 53, 54, 55, 999]) {
  expectTipo(
    { fk: MOV_INT_FK, motivoTexto: null, cabTipoDocId: tipoDoc },
    "ACERTO_STOCK",
    `cabTipoDoc=${tipoDoc} não altera o resultado`,
  );
}

// O sinal também não. Era ele que separava AJUSTE de PERDA no ID 28; a
// direcção do movimento vive em `quantidade`, onde sempre viveu.
for (const qtd of [-5, -1, 0, 1, 5]) {
  expectTipo(
    { fk: MOV_INT_FK, motivoTexto: null, cabTipoDocId: 28, qtd },
    "ACERTO_STOCK",
    `qtd=${qtd} não altera o resultado`,
  );
}

// ─────────────────────────────────────────────────────────────────────
// 5. DESCONHECIDO só sobrevive à ausência total de FK
// ─────────────────────────────────────────────────────────────────────

expectTipo(
  { fk: MOV_INT_FK, motivoTexto: "lorem ipsum", cabTipoDocId: 999 },
  "ACERTO_STOCK",
  "motivo ilegível continua a ser um acerto",
);
expectTipo(
  { fk: MOV_INT_FK, motivoTexto: null, cabTipoDocId: null },
  "ACERTO_STOCK",
  "sem motivo nenhum continua a ser um acerto",
);
expectTipo(
  { fk: EMPTY_FK, motivoTexto: "Inventário", cabTipoDocId: 25 },
  "DESCONHECIDO",
  "sem FK nenhuma → DESCONHECIDO, por muito claro que o motivo seja",
);

// ─────────────────────────────────────────────────────────────────────
// 6. O âmbito: precedência das FKs
// ─────────────────────────────────────────────────────────────────────
//
// É isto que impede o pipeline de acertos de contar vendas e compras.

expectTipo(
  { fk: { ...EMPTY_FK, movStocksDetId: 1, detalheId: 2 }, atendimentoTipoDocId: 7 },
  "VENDA",
  "FK interna + FK de venda → VENDA (a venda ganha)",
);
expectTipo(
  { fk: { ...EMPTY_FK, movStocksDetId: 1, recpDetalheId: 2 } },
  "COMPRA",
  "FK interna + FK de compra → COMPRA",
);
expectTipo(
  { fk: { ...EMPTY_FK, movStocksDetId: 1, devolucaoDetalheId: 2 } },
  "DEVOLUCAO_FORNECEDOR",
  "FK interna + FK de devolução → DEVOLUCAO_FORNECEDOR",
);
expectTipo(
  { fk: { ...EMPTY_FK, movStocksDetId: 1, suspDetalheId: 2 } },
  "RESERVA_SUSPENSA",
  "FK interna + FK de reserva → RESERVA_SUSPENSA",
);
expectTipo(
  { fk: { ...EMPTY_FK, movStocksDetId: 1, creditoDetalheId: 2 } },
  "VENDA_CREDITO",
  "FK interna + FK de crédito → VENDA_CREDITO",
);

// ─────────────────────────────────────────────────────────────────────
// Sumário
// ─────────────────────────────────────────────────────────────────────
console.log(
  `\nmovimento-classifier tests — ${pass} passed, ${fail} failed (${pass + fail} total)`,
);
if (fail > 0) {
  console.error("\nFalhas:");
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
