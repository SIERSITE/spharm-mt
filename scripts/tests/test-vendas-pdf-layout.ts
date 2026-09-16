/**
 * scripts/tests/test-vendas-pdf-layout.ts
 *
 * Correcção (2026-09): o PDF do Relatório de Vendas ficava desformatado
 * — meses comprimidos, cabeçalhos a sobrepor-se, colunas estreitas
 * demais, descrição apertada, totais difíceis de distinguir.
 *
 * ── Causa raiz confirmada ────────────────────────────────────────────
 *
 * `buildColumns` (lib/reporting/adapters/vendas.ts) reservava 85% da
 * largura às colunas fixas e só 15% a TODOS os meses juntos — e ainda
 * impunha um mínimo de 3% por mês (`Math.max(3, ...)`) sem verificar se
 * isso cabia no orçamento. A partir de ~6 meses no mesmo relatório, a
 * SOMA das larguras ultrapassava 100%. Com `table-layout:fixed`, isso
 * não corta — reescala a tabela inteira de forma imprevisível, e é
 * exactamente o que produzia meses ilegíveis, descrição espremida e
 * (por a `<thead th>` não ter `overflow:hidden`, ao contrário de
 * `<tbody td>`) cabeçalhos a transbordar uns para cima dos outros.
 *
 * Esta suite prova, por número de meses (1 a 24), que a soma das
 * larguras nunca ultrapassa 100, e cobre as correcções de CSS/estrutura
 * (overflow no cabeçalho, distinção de subtotal/total, filtros sem
 * chip-frase-inteira).
 *
 * Corre com:  npx tsx scripts/tests/test-vendas-pdf-layout.ts
 */
import { readFileSync } from "node:fs";
import { buildVendasReport } from "../../lib/reporting/adapters/vendas";
import { renderReportHtml } from "../../lib/reporting/report-html";
import type { SalesReportRow } from "../../lib/vendas-data";

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

function linha(overrides: Partial<SalesReportRow> = {}): SalesReportRow {
  return {
    produtoId: "p1",
    codigo: "5880034",
    descricao: "Produto de teste, com uma descrição um pouco mais longa do que o normal",
    farmaciaId: "f1",
    farmacia: "Farmácia Silveirense",
    pvp: 6.66,
    custoUnitarioEstimado: 3.74,
    custoEstimado: 3.74,
    fabricante: "Fabricante X",
    fornecedor: "Distribuidor Y",
    meses: [],
    totalVendas: 10,
    existencia: 5,
    semVendasNoPeriodo: false,
    ...overrides,
  } as SalesReportRow;
}

function buckets(n: number): { ano: number; mes: number }[] {
  return Array.from({ length: n }, (_, i) => ({ ano: 2026, mes: (i % 12) + 1 }));
}

// ─────────────────────────────────────────────────────────────────────────
// A. A soma das larguras nunca ultrapassa 100, para qualquer nº de meses
// ─────────────────────────────────────────────────────────────────────────

console.log("\n=== A. buildColumns: a tabela nunca \"esmaga\" — soma ≤ 100 sempre ===");
for (const n of [0, 1, 3, 6, 9, 10, 12, 18, 24, 36]) {
  const rel = buildVendasReport({
    rows: [linha({ meses: Array.from({ length: n }, (_, i) => ({ ano: 2026, mes: (i % 12) + 1, quantidade: 1 })) })],
    buckets: buckets(n),
    filters: {},
    universe: { farmacias: [], fornecedores: [], fabricantes: [], categorias: [] },
    organization: "Grupo",
  });
  const somaLarguras = rel.columns.reduce((s, c) => s + (c.width ?? 0), 0);
  ok(
    `${n} meses: soma das larguras ≤ 100 (obtido ${somaLarguras.toFixed(1)})`,
    somaLarguras <= 100 + 0.05, // folga de arredondamento
    `colunas: ${JSON.stringify(rel.columns.map((c) => c.width))}`,
  );
}

console.log("\n=== B. Meses ficam legíveis no caso normal (até ~10 meses) ===");
{
  const MIN_LEGIVEL = 4.2; // "JAN/26" — ver MIN_WIDTH_MES no adapter
  for (const n of [1, 3, 6, 9]) {
    const rel = buildVendasReport({
      rows: [linha({ meses: [] })],
      buckets: buckets(n),
      filters: {},
      universe: { farmacias: [], fornecedores: [], fabricantes: [], categorias: [] },
      organization: "Grupo",
    });
    const mesesCols = rel.columns.filter((c) => c.key.startsWith("m_"));
    eq(`${n} meses: existem ${n} colunas de mês`, mesesCols.length, n);
    ok(
      `${n} meses: cada coluna de mês ≥ ${MIN_LEGIVEL}% (mínimo de legibilidade)`,
      mesesCols.every((c) => (c.width ?? 0) >= MIN_LEGIVEL - 0.05),
      JSON.stringify(mesesCols.map((c) => c.width)),
    );
  }
}

console.log("\n=== C. As colunas fixas nunca desaparecem, mesmo em relatórios muito longos ===");
{
  const rel = buildVendasReport({
    rows: [linha({ meses: [] })],
    buckets: buckets(36),
    filters: {},
    universe: { farmacias: [], fornecedores: [], fabricantes: [], categorias: [] },
    organization: "Grupo",
  });
  const fixas = rel.columns.filter((c) => !c.key.startsWith("m_"));
  ok("mesmo com 36 meses, nenhuma coluna fixa fica com largura 0 ou negativa", fixas.every((c) => (c.width ?? 0) > 0));
  const somaLarguras = rel.columns.reduce((s, c) => s + (c.width ?? 0), 0);
  ok("…e a soma continua ≤ 100", somaLarguras <= 100.05, `${somaLarguras}`);
}

// ─────────────────────────────────────────────────────────────────────────
// D. CSS partilhado — cabeçalho não transborda, subtotal/total distintos
// ─────────────────────────────────────────────────────────────────────────

console.log("\n=== D. report-html.ts: cabeçalho recortado, subtotal e total distintos ===");
{
  const css = src("lib/reporting/report-html.ts");
  const theadBlock = css.slice(css.indexOf("thead th {"), css.indexOf("tbody td {"));
  ok(
    "thead th tem overflow:hidden — antes só tbody td tinha, e era ali que os cabeçalhos se sobrepunham",
    /overflow:\s*hidden/.test(theadBlock),
  );
  ok("thead th tem text-overflow:ellipsis", /text-overflow:\s*ellipsis/.test(theadBlock));

  ok("existe uma regra CSS dedicada a .subtotal-row", css.includes(".subtotal-row"));
  ok(
    "…com destaque visual próprio (fundo/moldura), não só um filete igual ao resto",
    /tr\.subtotal-row td\s*\{[^}]*background/.test(css),
  );

  ok(
    "o total final diz \"TOTAL GERAL\" — nunca se confunde com \"TOTAL ARTIGO\" (o subtotal por linha)",
    css.includes("TOTAL GERAL"),
  );
  ok("…e já não diz apenas \"Total\" sem qualificar", !/&gt;<strong>Total<\/strong>/.test(css));
}

console.log("\n=== E. Um relatório real gera HTML sem cabeçalhos partidos nem \"Total\" ambíguo ===");
{
  const rel = buildVendasReport({
    rows: [
      linha({ codigo: "1111111", descricao: "Artigo A", farmacia: "Farmácia Silveirense", totalVendas: 5 }),
      linha({ codigo: "1111111", descricao: "Artigo A", farmacia: "Farmácia Segurado", totalVendas: 7 }),
    ],
    buckets: buckets(6),
    filters: { agruparPor: "artigo" },
    universe: { farmacias: [], fornecedores: [], fabricantes: [], categorias: [] },
    organization: "Grupo",
  });
  const html = renderReportHtml(rel);
  ok("o HTML gerado inclui TOTAL GERAL no rodapé da tabela", html.includes("TOTAL GERAL"));
  ok("…e TOTAL ARTIGO no subtotal (dois artigos na mesma farmácia)", html.includes("TOTAL ARTIGO"));
  ok("…e a classe subtotal-row está aplicada a uma linha real", html.includes('class="subtotal-row"'));
  ok("orientação continua landscape", html.includes("A4 landscape"));
}

// ─────────────────────────────────────────────────────────────────────────
// F. Filtros aplicados — sem a chip-frase-inteira
// ─────────────────────────────────────────────────────────────────────────

console.log("\n=== F. Filtros aplicados: sem chip de frase inteira (movida para o rodapé) ===");
{
  const rel = buildVendasReport({
    rows: [linha()],
    buckets: buckets(1),
    filters: {},
    universe: { farmacias: [], fornecedores: [], fabricantes: [], categorias: [] },
    organization: "Grupo",
  });
  const chipsLabels = (rel.filtersApplied ?? []).map((f) => f.label);
  ok(
    "já não existe uma chip \"Custo\" com uma frase inteira dentro de um filtro",
    !chipsLabels.includes("Custo"),
  );
  ok(
    "o aviso do custo continua a viajar com o relatório — agora no rodapé",
    (rel.meta?.footer ?? "").includes("não é o custo à data da venda"),
  );
  // Nenhuma chip deve ser uma frase longa: é o próprio "excesso de
  // informação numa só linha" que se estava a corrigir.
  const chipDemasiadoLonga = (rel.filtersApplied ?? []).find((f) => f.value.length > 60);
  ok(
    "nenhuma chip de filtro tem um valor com mais de 60 caracteres",
    !chipDemasiadoLonga,
    chipDemasiadoLonga ? `${chipDemasiadoLonga.label}: ${chipDemasiadoLonga.value}` : undefined,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// G. Cabeçalhos em duas linhas — meses/"Custo unit. est."/"Total Unid."
//    deixam de transbordar mesmo dentro da largura mínima da coluna
// ─────────────────────────────────────────────────────────────────────────
//
// A verificação de largura (secções A-C) prova que a SOMA das colunas
// nunca ultrapassa 100% — mas isso não bastava: com 12 meses, "JAN/26"
// (6 caracteres maiúsculos, com letter-spacing) transbordava mesmo
// dentro da largura mínima de legibilidade (MIN_WIDTH_MES), aparecendo
// cortado como "JAN/…" no PDF real. A correcção parte o rótulo em duas
// linhas ("JAN" + "26"), suportado por renderReportHtml() a traduzir
// "\n" em "<br/>". Confirmado a olho no PDF gerado por puppeteer.
console.log("\n=== G. Cabeçalhos em duas linhas — sem transbordo em \"JAN/26\", \"Custo unit. est.\", \"Total Unid.\" ===");
{
  const rel = buildVendasReport({
    rows: [linha({ meses: Array.from({ length: 12 }, (_, i) => ({ ano: 2026, mes: i + 1, quantidade: 1 })) })],
    buckets: buckets(12),
    filters: {},
    universe: { farmacias: [], fornecedores: [], fabricantes: [], categorias: [] },
    organization: "Grupo",
  });
  const mesesCols = rel.columns.filter((c) => c.key.startsWith("m_"));
  ok(
    "cada rótulo de mês tem exactamente duas linhas (mês + ano de 2 dígitos)",
    mesesCols.every((c) => /^[A-Za-zà-üÀ-Ü]{3}\n\d{2}$/.test(c.label)),
    JSON.stringify(mesesCols.map((c) => c.label)),
  );
  ok(
    "…e nenhuma linha do rótulo de mês passa de 3 caracteres (nunca mais \"JAN/26\" numa linha só)",
    mesesCols.every((c) => c.label.split("\n").every((linha) => linha.length <= 3)),
  );

  const custo = rel.columns.find((c) => c.key === "custoUnitarioEstimado");
  eq("\"Custo unit. est.\" partido em três linhas curtas (2 linhas ainda transbordava)", custo?.label, "Custo\nunit.\nest.");
  ok(
    "…e nenhuma das três linhas passa de 5 caracteres",
    (custo?.label ?? "").split("\n").every((linha) => linha.length <= 5),
  );

  const totalUnid = rel.columns.find((c) => c.key === "totalVendas");
  eq("\"Total Unid.\" também partido em duas linhas", totalUnid?.label, "Total\nUnid.");

  const html = renderReportHtml(rel);
  ok(
    "o HTML gerado traduz \"\\n\" do rótulo em <br/> dentro do cabeçalho",
    html.includes("Jan<br/>26") && html.includes("Custo<br/>unit.<br/>est.") && html.includes("Total<br/>Unid."),
  );
  // O rodapé continua a usar a frase "Custo unit. est." por extenso (é
  // texto livre, não um cabeçalho de coluna) — a verificação de "já não
  // existe o formato antigo" tem de olhar só para o <thead>, não para a
  // página toda.
  const theadHtml = html.slice(html.indexOf("<thead>"), html.indexOf("</thead>"));
  ok(
    "…e o <thead> já não tem o formato antigo de uma linha só \"Jan/26\"",
    !theadHtml.includes("Jan/26") && !theadHtml.includes("Custo unit. est.") && !theadHtml.includes("Total Unid."),
  );
}

console.log(`\n${fail === 0 ? "PASSOU" : "FALHOU"} — ${pass} OK, ${fail} falhas\n`);
process.exit(fail === 0 ? 0 : 1);
