/**
 * scripts/tests/test-margens-stock.ts
 *
 * Coluna «Stock» no mapa de Margens (todos os tenants): stock ATUAL da farmácia da linha, contado UMA vez por
 * (produto × farmácia) — nunca multiplicado por meses, movimentos nem pela expansão CNPEM, nunca somado de novo nos
 * subtotais/total. Desconhecido (`null`) é «—», nunca 0; zero é distinguível de desconhecido; negativo mantém o sinal.
 *
 * Puro (sem base de dados): o motor `aggregate` e os adapters são funções puras. Corre com:
 *   npx tsx scripts/tests/test-margens-stock.ts
 */
import Module from "node:module";
import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";

// `lib/margens-data.ts` importa `server-only` (sem efeito em tsx fora do Next): neutraliza-se como nos testes de DB.
const M = Module as unknown as { _resolveFilename: (r: string, ...a: unknown[]) => string };
const resolverOriginal = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "server-only" ? __filename : resolverOriginal.call(this, request, ...rest);
};

const lerLF = (p: string) => readFileSync(p, "utf8").split("\r\n").join("\n");
let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const eq = <T,>(a: T, b: T, label: string) => check(JSON.stringify(a) === JSON.stringify(b), label, `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);
const secao = (t: string) => console.log(`\n── ${t}`);

async function main() {
  const { aggregate } = await import("../../lib/margens-data");
  const { buildMargensProdutoReport, buildMargensAggReport, stockTotalDasLinhas } = await import("../../lib/reporting/adapters/margens");
  const { renderReportHtml } = await import("../../lib/reporting/report-html");
  const { buildReportWorkbook } = await import("../../lib/reporting/report-excel-buffer");
  const { ROW_KIND_KEY } = await import("../../lib/reporting/report-types");
  type MargemRow = import("../../lib/margens-data").MargemRow;

  const UNI = ["Farmácia Segurado", "Farmácia Silveirense", "Farmácia Terceira"];
  const universe = { farmacias: UNI, categorias: [], fabricantes: [], distribuidores: [] };

  const linha = (over: Partial<MargemRow>): MargemRow => ({
    produtoId: "p1", cnp: 1000001, designacao: "Produto Teste", categoria: "Cat", grupo: null,
    farmaciaId: "f1", farmacia: UNI[0], fabricante: "Fab",
    qtdVendida: 10, pvpUnitario: 5, valorVendido: 50, taxaIva: 23, valorVendidoSemIva: 40.65,
    custoUnitario: 3, custoUnitarioBase: 3, custoEstimado: 30, margemEur: 10.65, margemPct: 26.2,
    coberturaCusto: 1, estado: "FIAVEL", margemUnitaria: 1.07, cnpem: null,
    precoUtenteGeral: null, precoUtenteEspecial: null, semVendasNoPeriodo: false, retirado: false,
    stockAtual: 5,
    ...over,
  });
  const rel = (rows: MargemRow[]) => buildMargensProdutoReport({ rows, filters: {}, universe, organization: "Grupo" });
  const detalhes = (r: ReturnType<typeof rel>) => r.rows.filter((x) => x[ROW_KIND_KEY] === "detalhe");
  const subtotais = (r: ReturnType<typeof rel>) => r.rows.filter((x) => x[ROW_KIND_KEY] === "subtotal");
  const resumo = (r: ReturnType<typeof rel>, label: string) => r.summary?.find((s) => s.label === label);

  // ══ A · coluna no Report ═════════════════════════════════════════════
  secao("A · coluna Stock no Report");
  {
    const r = rel([linha({})]);
    const cols = r.columns.filter((c) => !c.hidden && !c.excelOnly);
    const idx = (k: string) => cols.findIndex((c) => c.key === k);
    eq(cols.length, 18, "A1: 18 colunas visíveis (17 + Stock)");
    check(idx("stockAtual") === idx("qtdVendida") + 1, "A2: Stock logo a seguir a Qtd");
    check(idx("stockAtual") < idx("pvpUnitario") && idx("stockAtual") < idx("valorVendido"), "A3: Stock antes das métricas monetárias");
    const c = r.columns.find((x) => x.key === "stockAtual")!;
    check(c.format === "integer" && c.stockIndicator === true && c.showTotal === true && c.noClip === true, "A4: integer, stockIndicator, showTotal, noClip");
    check(c.toneWhenZero === "danger" && c.toneWhenPositive === "success", "A5: tons como Vendas (zero=danger, positivo=success)");
    const soma = cols.reduce((s, x) => s + (x.width ?? 0), 0);
    check(Math.abs(soma - 100) < 0.001, `A6: larguras visíveis somam 100 (${soma.toFixed(3)})`);
    const desc = cols.find((x) => x.key === "designacao")!.width!;
    const farm = cols.find((x) => x.key === "farmacia")!.width!;
    check(desc > 20 && farm >= 9, `A7: Descrição (${desc.toFixed(1)}%) e Farmácia (${farm.toFixed(1)}%) não foram esmagadas`);
    eq(r.meta?.tableDensity, "tight", "A8: densidade 'tight' mantida");
    eq(d(r)[0].stockAtual, 5, "A9: o valor da linha é o stock atual");
  }
  function d(r: ReturnType<typeof rel>) { return detalhes(r); }

  // ══ B · uma, duas e três farmácias; 0/positivo/negativo/desconhecido ═══
  secao("B · farmácias × valores");
  {
    const uma = rel([linha({ stockAtual: 7 })]);
    eq(subtotais(uma).length, 0, "B1: uma farmácia — sem TOTAL ARTIGO");
    eq(resumo(uma, "Stock total")?.value, 7, "B2: Stock total = 7");

    const duas = rel([
      linha({ farmaciaId: "f1", farmacia: UNI[0], stockAtual: 5 }),
      linha({ farmaciaId: "f2", farmacia: UNI[1], stockAtual: 7 }),
    ]);
    eq(subtotais(duas)[0].stockAtual, 12, "B3: duas farmácias — TOTAL ARTIGO = 5 + 7");
    eq(resumo(duas, "Stock total")?.value, 12, "B4: Stock total do relatório = 12 (o TOTAL ARTIGO não é somado de novo)");

    const tres = rel([
      linha({ farmaciaId: "f1", farmacia: UNI[0], stockAtual: 3 }),
      linha({ farmaciaId: "f2", farmacia: UNI[1], stockAtual: 0 }),
      linha({ farmaciaId: "f3", farmacia: UNI[2], stockAtual: -1 }),
    ]);
    eq(subtotais(tres)[0].stockAtual, 2, "B5: três farmácias (3, 0, −1) — TOTAL ARTIGO = 2 (negativo com sinal)");
    eq(resumo(tres, "Stock total")?.value, 2, "B6: Stock total = 2");
    eq(detalhes(tres).map((x) => x.stockAtual), [3, 0, -1], "B7: cada linha mantém o seu stock (zero é 0, negativo mantém o sinal)");

    const parcial = rel([
      linha({ farmaciaId: "f1", farmacia: UNI[0], stockAtual: 5 }),
      linha({ farmaciaId: "f2", farmacia: UNI[1], stockAtual: null }),
    ]);
    eq(subtotais(parcial)[0].stockAtual, 5, "B8: TOTAL ARTIGO soma só o stock CONHECIDO (5 + desconhecido = 5)");
    eq(detalhes(parcial)[1].stockAtual, null, "B9: a linha de stock desconhecido é null (nunca 0)");
    eq(resumo(parcial, "Stock total")?.value, 5, "B10: Stock total = 5");
    eq(resumo(parcial, "Linhas sem stock conhecido (fora do stock total)")?.value, 1, "B11: 1 linha sem stock conhecido contada à parte");

    const todasDesc = rel([
      linha({ farmaciaId: "f1", farmacia: UNI[0], stockAtual: null }),
      linha({ farmaciaId: "f2", farmacia: UNI[1], stockAtual: null }),
    ]);
    eq(subtotais(todasDesc)[0].stockAtual, null, "B12: TOTAL ARTIGO é null («—») se NENHUMA farmácia conhece o stock");
    check(!resumo(uma, "Linhas sem stock conhecido (fora do stock total)"), "B13: sem desconhecidas, o item «Linhas sem stock conhecido» não aparece");

    // Dois artigos: o total do relatório soma cada artigo/farmácia uma vez.
    const doisArtigos = rel([
      linha({ cnp: 1, farmaciaId: "f1", farmacia: UNI[0], stockAtual: 4 }),
      linha({ cnp: 1, farmaciaId: "f2", farmacia: UNI[1], stockAtual: 6 }),
      linha({ cnp: 2, farmaciaId: "f1", farmacia: UNI[0], stockAtual: 10 }),
    ]);
    eq(resumo(doisArtigos, "Stock total")?.value, 20, "B14: dois artigos (4+6, 10) — Stock total = 20, sem dupla contagem");
    eq(stockTotalDasLinhas([{ stockAtual: 4 }, { stockAtual: null }, { stockAtual: -2 }]), { total: 2, desconhecidas: 1 }, "B15: stockTotalDasLinhas (4, null, −2) = 2 + 1 desconhecida");
  }

  // ══ C · vários meses não multiplicam ═════════════════════════════════
  secao("C · vários meses");
  {
    // A linha de Margens é (produto × farmácia) SOBRE O PERÍODO: a quantidade é a soma dos meses, o stock é UM valor.
    const umMes = rel([linha({ qtdVendida: 10, stockAtual: 4 })]);
    const doze = rel([linha({ qtdVendida: 120, stockAtual: 4 })]);
    eq(resumo(umMes, "Stock total")?.value, 4, "C1: 1 mês — stock 4");
    eq(resumo(doze, "Stock total")?.value, 4, "C2: 12 meses (qtd 120) — o stock continua 4 (não é multiplicado)");
    const dados = lerLF("lib/margens-data.ts");
    check(/SUM\(vm\."quantidade"\)[\s\S]*GROUP BY 1, 2/.test(dados) && /pf\."stockAtual"::text\s+AS "stockAtual"/.test(dados),
      "C3: a consulta agrega vendas por (produto, farmácia) e lê o stock de ProdutoFarmacia (1 valor por par), sem JOIN a meses");
  }

  // ══ D · motor de agregação (aggregate) ═══════════════════════════════
  secao("D · aggregate(): categorias / farmácias / total");
  {
    const rows = [
      linha({ cnp: 1, categoria: "A", farmaciaId: "f1", farmacia: UNI[0], stockAtual: 4 }),
      linha({ cnp: 1, categoria: "A", farmaciaId: "f2", farmacia: UNI[1], stockAtual: 6 }),
      linha({ cnp: 2, categoria: "B", farmaciaId: "f1", farmacia: UNI[0], stockAtual: 0 }),
      linha({ cnp: 3, categoria: "B", farmaciaId: "f1", farmacia: UNI[0], stockAtual: -3 }),
      linha({ cnp: 4, categoria: "B", farmaciaId: "f2", farmacia: UNI[1], stockAtual: null }),
    ];
    const porCat = aggregate(rows, (r) => r.categoria ?? "?");
    const A = porCat.find((x) => x.key === "A")!;
    const B = porCat.find((x) => x.key === "B")!;
    eq([A.stockTotal, A.linhasSemStock], [10, 0], "D1: categoria A = 4 + 6, nenhuma desconhecida");
    eq([B.stockTotal, B.linhasSemStock], [-3, 1], "D2: categoria B = 0 + (−3), 1 desconhecida fora da soma");
    const porFarm = aggregate(rows, (r) => r.farmacia);
    eq(porFarm.map((x) => [x.key, x.stockTotal, x.linhasSemStock]), [[UNI[0], 1, 0], [UNI[1], 6, 1]], "D3: por farmácia (4+0−3=1; 6 e 1 desconhecida)");
    const total = aggregate(rows, () => "TOTAL")[0];
    eq([total.stockTotal, total.linhasSemStock], [7, 1], "D4: TOTAL = 4+6+0−3 = 7, 1 desconhecida");
    eq(porCat.reduce((s, x) => s + x.stockTotal, 0), total.stockTotal, "D5: a soma dos agregados = o total (cada linha contada uma vez)");
    eq(porFarm.reduce((s, x) => s + x.stockTotal, 0), total.stockTotal, "D6: idem por farmácia");
    eq(aggregate([], () => "x"), [], "D7: sem linhas, sem agregados");
  }

  // ══ E · HTML/PDF por texto ═══════════════════════════════════════════
  secao("E · HTML/PDF (por texto)");
  {
    const r = rel([
      linha({ cnp: 1, farmaciaId: "f1", farmacia: UNI[0], stockAtual: 3 }),
      linha({ cnp: 2, farmaciaId: "f1", farmacia: UNI[0], stockAtual: 0 }),
      linha({ cnp: 3, farmaciaId: "f1", farmacia: UNI[0], stockAtual: -4 }),
      linha({ cnp: 4, farmaciaId: "f1", farmacia: UNI[0], stockAtual: null }),
    ]);
    const html = renderReportHtml(r);
    check(/<th[^>]*>[\s\S]*?Stock/.test(html), "E1: o cabeçalho Stock existe");
    check(html.includes("stk-pos") && html.includes("stk-zero") && html.includes("stk-neg"), "E2: positivo/zero/negativo distinguíveis (stk-pos / stk-zero / stk-neg)");
    check(/class="stk-box">0<\/span>/.test(html), "E3: o zero leva pastilha (caixa) com «0»");
    check(/class="stk-box">-4<\/span>/.test(html) || /class="stk-box">−4<\/span>/.test(html), "E4: o negativo leva pastilha com o sinal");
    check(html.includes("Stock total PARCIAL: 1 linha(s)"), "E5: nota de total PARCIAL");
    check(html.includes("Stock atual à data de geração do relatório (não histórico)"), "E6: nota «stock atual, não histórico»");
    check(html.includes("Stock total") && html.includes("Linhas sem stock conhecido"), "E7: o resumo traz «Stock total» e «Linhas sem stock conhecido»");
    // O TOTAL GERAL do HTML soma só o detalhe: 3 + 0 − 4 = −1 (o desconhecido não entra).
    const totalGeral = html.match(/<tbody class="totals-tbody"><tr>([\s\S]*?)<\/tr>/)?.[1] ?? "";
    check(/<strong>-1<\/strong>|<strong>−1<\/strong>/.test(totalGeral), "E8: TOTAL GERAL do stock = 3 + 0 − 4 = −1", totalGeral.slice(0, 400));
    const celulaDesc = /<td[^>]*>—<\/td>/.test(html);
    check(celulaDesc, "E9: o stock desconhecido aparece «—»");

    const dois = renderReportHtml(rel([
      linha({ cnp: 1, farmaciaId: "f1", farmacia: UNI[0], stockAtual: 5 }),
      linha({ cnp: 1, farmaciaId: "f2", farmacia: UNI[1], stockAtual: 7 }),
    ]));
    const tg = dois.match(/<tbody class="totals-tbody"><tr>([\s\S]*?)<\/tr>/)?.[1] ?? "";
    check(/<strong>12<\/strong>/.test(tg), "E10: TOTAL GERAL = 12 (os TOTAL ARTIGO não entram: sem 24)");
    check(!/<strong>24<\/strong>/.test(tg), "E11: nunca 24 (dupla contagem)");
  }

  // ══ F · Excel (xlsx lido) ════════════════════════════════════════════
  secao("F · Excel");
  {
    const r = rel([
      linha({ cnp: 1, farmaciaId: "f1", farmacia: UNI[0], stockAtual: 5 }),
      linha({ cnp: 1, farmaciaId: "f2", farmacia: UNI[1], stockAtual: 7 }),
      linha({ cnp: 2, farmaciaId: "f1", farmacia: UNI[0], stockAtual: null }),
    ]);
    const wb = buildReportWorkbook(r);
    const folha = wb.Sheets[wb.SheetNames[0]];
    const g = XLSX.utils.sheet_to_json<unknown[]>(folha, { header: 1, blankrows: false }) as unknown[][];
    const cab = g.findIndex((l) => l.some((c) => c === "Stock"));
    check(cab >= 0, "F1: o Excel tem a coluna «Stock»");
    const col = g[cab].indexOf("Stock");
    const dados = g.slice(cab + 1);
    const valores = dados.map((l) => l[col]);
    check(valores.includes(5) && valores.includes(7), "F2: stock 5 e 7 nas linhas de detalhe");
    const linhaTotal = dados[dados.length - 1];
    eq(linhaTotal[col], 12, "F3: linha de total do Excel = 5 + 7 (detalhe apenas; desconhecido fora; TOTAL ARTIGO não duplica)");
    const semStock = dados.find((l) => l.includes("2") || l.includes(2));
    void semStock;
    check(!valores.some((v) => v === 0), "F4: nenhum 0 silencioso (o desconhecido não vira 0 no Excel)");
  }

  // ══ G · relatórios agregados (categoria / farmácia / grupo / fabricante) ═══
  // Mudança de decisão (era: «agregados sem Stock»): cada linha do mapa (par produto × farmácia, única por período) cai
  // em UM só agregado em cada dimensão — categoria, grupo e fabricante são atributos da própria linha, a farmácia é a
  // do par — logo os agregados particionam as linhas e a soma de pares distintos é não ambígua. Ver notes/margens-stock-modos.md.
  secao("G · relatórios agregados: um valor por modo, sem dupla contagem");
  {
    type Dim = "categoria" | "farmacia" | "grupo" | "fabricante";
    const F1 = { farmaciaId: "f1", farmacia: UNI[0] };
    const F2 = { farmaciaId: "f2", farmacia: UNI[1] };
    const F3 = { farmaciaId: "f3", farmacia: UNI[2] };
    const base = (cnp: number, categoria: string, grupo: string, fabricante: string, f: typeof F1, stock: number | null, qtd = 10) =>
      linha({ cnp, produtoId: `p${cnp}`, categoria, grupo, fabricante, ...f, stockAtual: stock, qtdVendida: qtd });
    const conjunto = (qtd = 10) => [
      base(1, "A", "G1", "F1", F1, 4, qtd), // MESMO produto (1) em duas farmácias: 4 + 6
      base(1, "A", "G1", "F1", F2, 6, qtd),
      base(2, "B", "G1", "F2", F1, 0, qtd), // zero
      base(3, "B", "G2", "F2", F1, -3, qtd), // negativo
      base(4, "B", "G2", "F1", F2, null, qtd), // desconhecido
      base(5, "A", "G2", "F2", F3, 9, qtd),
    ];
    const chaveDe: Record<Dim, (r: MargemRow) => string> = {
      categoria: (r) => r.categoria ?? "?", farmacia: (r) => r.farmacia, grupo: (r) => r.grupo ?? "?", fabricante: (r) => r.fabricante,
    };
    // esperado: [stockTotal, linhas, linhasSemStock] por chave
    const esperado: Record<Dim, Record<string, [number, number, number]>> = {
      categoria: { A: [19, 3, 0], B: [-3, 3, 1] },
      farmacia: { [UNI[0]]: [1, 3, 0], [UNI[1]]: [6, 2, 1], [UNI[2]]: [9, 1, 0] },
      grupo: { G1: [10, 3, 0], G2: [6, 3, 1] },
      fabricante: { F1: [10, 3, 1], F2: [6, 3, 0] },
    };
    const relAgg = (rows: MargemRow[], dim: Dim) =>
      buildMargensAggReport({ rows: aggregate(rows, chaveDe[dim]), filters: {}, universe, organization: "Grupo", groupBy: dim });
    const totalDoHtml = (html: string) => html.match(/<tbody class="totals-tbody"><tr>([\s\S]*?)<\/tr>/)?.[1] ?? "";

    eq(resumo(rel(conjunto()), "Stock total")?.value, 16, "G0: o mapa por produto soma 4+6+0−3+9 = 16 (o desconhecido fora)");

    for (const dim of ["categoria", "farmacia", "grupo", "fabricante"] as const) {
      const agg = aggregate(conjunto(), chaveDe[dim]);
      for (const [k, [st, nl, ns]] of Object.entries(esperado[dim])) {
        const a = agg.find((x) => x.key === k);
        eq([a?.stockTotal, a?.linhas, a?.linhasSemStock], [st, nl, ns], `G1[${dim}]: «${k}» = ${st} (${nl} linhas, ${ns} sem stock)`);
      }
      eq(agg.reduce((s, x) => s + x.stockTotal, 0), 16, `G2[${dim}]: Σ dos agregados = 16 (os agregados particionam as linhas)`);
      eq(agg.reduce((s, x) => s + x.linhas, 0), 6, `G3[${dim}]: Σ linhas = 6 pares (nenhum par em dois agregados)`);

      const r = relAgg(conjunto(), dim);
      const cols = r.columns.map((c) => c.key);
      check(cols.indexOf("stockTotal") === cols.indexOf("qtdVendida") + 1, `G4[${dim}]: coluna Stock logo a seguir a Qtd`);
      check(cols.includes("linhasSemStock"), `G5[${dim}]: com desconhecidos, existe a coluna «Sem stock conhecido»`);
      const soma = r.columns.reduce((s, c) => s + (c.width ?? 0), 0);
      check(Math.abs(soma - 100) < 0.001, `G6[${dim}]: larguras somam 100 (${soma.toFixed(3)})`);
      for (const [k, [st, , ns]] of Object.entries(esperado[dim])) {
        const linhaR = r.rows.find((x) => x.label === k)!;
        eq([linhaR.stockTotal, linhaR.linhasSemStock], [st, ns > 0 ? ns : null], `G7[${dim}]: Report «${k}» → Stock ${st}, sem stock ${ns || "—"}`);
      }
      eq(resumo(r, "Stock total")?.value, 16, `G8[${dim}]: resumo «Stock total» = 16 = o do mapa por produto`);
      eq(resumo(r, "Linhas sem stock conhecido (fora do stock total)")?.value, 1, `G9[${dim}]: 1 linha sem stock conhecido contada à parte`);
      check((r.meta?.tableNote ?? "").includes("artigos com vendas no período") && (r.meta?.tableNote ?? "").includes("Stock PARCIAL: 1 linha(s)"), `G10[${dim}]: nota «stock dos artigos com vendas no período» + PARCIAL`);

      // HTML (ecrã de impressão, PDF e email partilham este render)
      const html = renderReportHtml(r);
      check(html.includes("artigos com vendas no período"), `G11[${dim}]: a nota de stock aparece no HTML`);
      check(/<strong>16<\/strong>/.test(totalDoHtml(html)), `G12[${dim}]: TOTAL GERAL do HTML (Stock) = 16`, totalDoHtml(html).slice(0, 300));
      check(!/<strong>(32|22|38)<\/strong>/.test(totalDoHtml(html)), `G13[${dim}]: nunca o total duplicado`);

      // Excel lido
      const wb = buildReportWorkbook(r);
      const g = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, blankrows: false }) as unknown[][];
      const cab = g.findIndex((l) => l.some((c) => c === "Stock"));
      check(cab >= 0, `G14[${dim}]: o Excel tem a coluna «Stock»`);
      const col = g[cab].indexOf("Stock");
      const dados = g.slice(cab + 1);
      const porRotulo = new Map(dados.map((l) => [String(l[0]), l[col]]));
      for (const [k, [st]] of Object.entries(esperado[dim])) {
        eq(porRotulo.get(k), st, `G15[${dim}]: Excel «${k}» = ${st}`);
      }
      eq(dados[dados.length - 1][col], 16, `G16[${dim}]: linha de total do Excel = 16`);
    }

    // Vários períodos: o stock é UM valor por par; a quantidade (soma dos meses) não o multiplica.
    for (const dim of ["categoria", "farmacia", "grupo", "fabricante"] as const) {
      const um = aggregate(conjunto(10), chaveDe[dim]);
      const doze = aggregate(conjunto(120), chaveDe[dim]);
      eq(doze.map((x) => [x.key, x.stockTotal]), um.map((x) => [x.key, x.stockTotal]), `G17[${dim}]: 12 meses (qtd ×12) — o stock não muda`);
    }

    // Uma farmácia / tudo conhecido / agregado só com desconhecidos / zero / negativo.
    {
      const uma = relAgg([base(1, "A", "G1", "F1", F1, 7), base(2, "A", "G1", "F1", F1, 3)], "categoria");
      eq([uma.rows[0].stockTotal, resumo(uma, "Stock total")?.value], [10, 10], "G18: uma farmácia, tudo conhecido — 7 + 3 = 10");
      check(!uma.columns.some((c) => c.key === "linhasSemStock") && !resumo(uma, "Linhas sem stock conhecido (fora do stock total)"), "G19: sem desconhecidos — sem coluna nem item «sem stock conhecido»");
      check(Math.abs(uma.columns.reduce((s, c) => s + (c.width ?? 0), 0) - 100) < 0.001, "G20: larguras somam 100 também sem a coluna extra");
      const nenhum = relAgg([base(1, "A", "G1", "F1", F1, null), base(2, "B", "G1", "F1", F1, 4)], "categoria");
      const a = nenhum.rows.find((x) => x.label === "A")!;
      eq([a.stockTotal, a.linhasSemStock], [null, 1], "G21: agregado só com stock desconhecido → «—» (null), nunca 0");
      eq(nenhum.rows.find((x) => x.label === "B")!.stockTotal, 4, "G22: o outro agregado mantém 4");
      eq(resumo(nenhum, "Stock total")?.value, 4, "G23: total = 4 (o desconhecido não entra)");
      const zero = relAgg([base(1, "A", "G1", "F1", F1, 0)], "categoria");
      eq(zero.rows[0].stockTotal, 0, "G24: zero real é 0 (distinto de desconhecido)");
      const neg = relAgg([base(1, "A", "G1", "F1", F1, -5), base(2, "A", "G1", "F1", F1, 2)], "categoria");
      eq(neg.rows[0].stockTotal, -3, "G25: negativo desconta (−5 + 2 = −3)");
    }

    // Mesmo produto em várias farmácias: cada par conta uma vez.
    {
      const cat = aggregate([base(1, "A", "G", "F", F1, 4), base(1, "A", "G", "F", F2, 6), base(1, "A", "G", "F", F3, 10)], (r) => r.categoria ?? "?");
      eq([cat[0].stockTotal, cat[0].linhas], [20, 3], "G26: mesmo produto em 3 farmácias — 4 + 6 + 10 = 20 (3 linhas), nem ×3 nem ×nº de meses");
    }
    // Mesmo que (hipoteticamente) duas linhas do mesmo produto tivessem categorias diferentes, cada PAR cairia numa só.
    {
      const cat = aggregate([base(1, "A", "G", "F", F1, 4), base(1, "B", "G", "F", F2, 6)], (r) => r.categoria ?? "?");
      eq(cat.map((x) => [x.key, x.stockTotal]), [["A", 4], ["B", 6]], "G27: chaves diferentes para o mesmo produto — cada par só numa chave; Σ = 10");
    }

    // Estrutura: o ecrã usa as MESMAS regras; a expansão CNPEM nunca entra.
    const cliente = lerLF("components/margens/margens-client.tsx");
    const tabelaAgg = cliente.slice(cliente.indexOf("function TabelaAgg("));
    check(/stockDaLinhaAgregada\(r\)/.test(tabelaAgg) && /stockTotalDosAgregados\(rows\)/.test(tabelaAgg), "G28: a tabela do ecrã dos modos usa as MESMAS regras do Report (stockDaLinhaAgregada / stockTotalDosAgregados)");
    check(/>Stock<\/th>/.test(tabelaAgg) && /margens-agregada-nota-stock/.test(tabelaAgg), "G29: a tabela dos modos tem a coluna «Stock» e a nota «artigos com vendas no período»");
    check(/linhasAgregadas\(result, nivel\)/.test(cliente) && !/comparacoes/.test(tabelaAgg), "G30: os modos lêem result.por* (nunca a comparação CNPEM)");
  }

  // ══ H · ecrã e expansão CNPEM (estrutural) ═══════════════════════════
  secao("H · ecrã, expansão CNPEM e «Mostrar todos»");
  {
    const cliente = lerLF("components/margens/margens-client.tsx");
    const dadosFonte = lerLF("lib/margens-data.ts");
    const vendas = lerLF("components/vendas/vendas-client.tsx");
    const celula = lerLF("components/ui/stock-celula.tsx");

    const cabecalhos = (cliente.match(/<CabecalhoOrdenavel as="th"/g) ?? []).length + 1; // + coluna do botão de expandir
    const m = cliente.match(/const N_COLUNAS_PRODUTO = (\d+);/);
    eq(Number(m?.[1]), cabecalhos, `H1: N_COLUNAS_PRODUTO (${m?.[1]}) = nº de <th> da tabela (${cabecalhos})`);
    eq(Number(m?.[1]), 19, "H2: 19 colunas no ecrã (18 + Stock)");
    check(/coluna="stockAtual"[^>]*>Stock<\/CabecalhoOrdenavel>/.test(cliente) && /\| "stockAtual"/.test(cliente), "H3: coluna Stock ordenável (ColunaMargens inclui stockAtual)");
    check(/<StockCelula valor=\{r\.stockAtual\}/.test(cliente), "H4: a célula usa o StockCelula partilhado com o valor da linha (null = «—»)");
    check(/import \{ StockCelula \} from "@\/components\/ui\/stock-celula"/.test(vendas) && !/function StockCelula/.test(vendas), "H5: Vendas usa o MESMO componente partilhado (já não tem cópia local)");
    check(/data-stock="negativo"/.test(celula) && /data-stock="zero"/.test(celula) && /data-stock="desconhecido"/.test(celula), "H6: o componente distingue negativo / zero / desconhecido");
    check(/Stock total/.test(cliente) && /t\.stockTotal/.test(cliente) && /t\.linhasSemStock/.test(cliente), "H7: resumo superior com «Stock total» (e aviso parcial)");
    // Expansão CNPEM: as linhas comparáveis reutilizam LinhaMargem (mostram o stock da farmácia) mas só no ecrã…
    check(/data-nao-imprimir=\{linha \? "" : undefined\}/.test(cliente) && /className=\{linha \? "print:hidden" : undefined\}/.test(cliente), "H8: as linhas CNPEM são só de ecrã (data-nao-imprimir + print:hidden)");
    // …e nunca entram no Report nem nos totais.
    const buildReportSrc = cliente.slice(cliente.indexOf("const buildReport = () => {"), cliente.indexOf("return (\n    <AppShell>") > 0 ? cliente.indexOf("return (\n    <AppShell>") : undefined);
    check(!/comparacoes|ComparacaoCnpem|mostrarTodos/.test(buildReportSrc), "H9: o Report/PDF/Excel/email nunca leem a comparação CNPEM nem «Mostrar todos»");
    check(/aggregate\(porProduto, \(\) => "TOTAL"\)/.test(dadosFonte) && !/aggregate\([^)]*linhas/.test(dadosFonte.replace(/comparacao/g, "")), "H10: os totais vêm de aggregate(porProduto): a comparação CNPEM (getMargensComparacaoCnpem) nunca os contamina");
    const cmp = dadosFonte.slice(dadosFonte.indexOf("export async function getMargensComparacaoCnpem"));
    check(!/aggregate\(/.test(cmp), "H11: getMargensComparacaoCnpem não agrega nem soma stock");
    check(/stockTotal: row\.stockTotal|stockTotal: totalRow\.stockTotal/.test(dadosFonte) || /stockTotal: totalRow\.stockTotal/.test(dadosFonte), "H12: totals.stockTotal vem da linha TOTAL do aggregate");
    check(/tabela-margens/.test(cliente) && /BarraScrollHorizontalTopo/.test(cliente) && /col-cnp/.test(cliente) && /col-desc/.test(cliente), "H13: scroll horizontal superior e CNP/Descrição fixos preservados");
  }

  console.log(`\n${ok} ok, ${ko} falhas`);
  process.exit(ko > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
