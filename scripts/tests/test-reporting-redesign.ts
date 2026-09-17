/**
 * scripts/tests/test-reporting-redesign.ts
 *
 * Redesenho visual do reporting (2026-09) — referência: relatório de
 * Vendas tipo "extracto", cabeçalho compacto, artigo como unidade
 * visual (farmácias em sublinhas, não colunas), densidade alta.
 *
 * Cobre os dois níveis do redesenho:
 *
 *   1. Mecanismos GENÉRICOS em report-types.ts/report-html.ts —
 *      GROUP_KEY+spanGroup (rowspan por grupo), zeroAsDash/toneWhenZero/
 *      toneWhenPositive (formatação e realce condicional declarativos,
 *      nunca funções — o Report viaja por vezes em JSON), noteKey
 *      (sublinha discreta), excelOnly (coluna só na folha de cálculo).
 *      Testados com Reports sintéticos, sem depender de Vendas.
 *
 *   2. A aplicação a Vendas — lib/reporting/adapters/vendas.ts com
 *      meta.density:"compact": estrutura de colunas (CNP, Descrição,
 *      Farmácia, PVP, Custo unit. est. — estes dois por FARMÁCIA, não
 *      por artigo, ver secção L —, meses, Total Unid., Stock, Valor
 *      Vendas), custoUnitarioEstimado e valorBruto agora realmente
 *      populados (eram bugs antigos — a coluna existia mas nunca era
 *      lida).
 *
 * Cenários obrigatórios do pedido (secção 12): 1 farmácia/3 meses,
 * 2 farmácias/12 meses, 2/15, 5/12, 5/15, descrição longa, produto só
 * numa farmácia, produto em todas as farmácias, produto com stock mas
 * sem vendas, várias páginas (via largura/estrutura — a paginação real
 * é validada visualmente com puppeteer, não aqui), subtotal por artigo,
 * total geral, sem overflow, sem cabeçalhos cortados, sem texto
 * sobreposto (herdado dos testes já existentes de report-html.ts).
 *
 * Corre com: npx tsx scripts/tests/test-reporting-redesign.ts
 */
import {
  GROUP_KEY,
  ROW_KIND_KEY,
  agruparPorGroupKey,
  type Report,
  type ReportColumn,
  type ReportRow,
} from "../../lib/reporting/report-types";
import { renderReportHtml } from "../../lib/reporting/report-html";
import { formatCurrency } from "../../lib/reporting/report-formatters";
import { buildReportWorkbook } from "../../lib/reporting/report-excel-buffer";
import * as XLSX from "xlsx";
import { buildVendasReport, type VendasAdapterRow } from "../../lib/reporting/adapters/vendas";
import { readFileSync } from "node:fs";

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

function relatorioBase(cols: ReportColumn[], rows: ReportRow[], meta?: Report["meta"]): Report {
  return {
    title: "Relatório de teste",
    generatedAt: new Date("2026-09-16T12:00:00Z"),
    columns: cols,
    rows,
    meta,
  };
}

// ═════════════════════════════════════════════════════════════════════
// A. agruparPorGroupKey — função pura
// ═════════════════════════════════════════════════════════════════════
console.log("\n=== A. agruparPorGroupKey — runs contíguos ===");
{
  const rows: ReportRow[] = [
    { [GROUP_KEY]: "x", a: 1 },
    { [GROUP_KEY]: "x", a: 2 },
    { [GROUP_KEY]: "y", a: 3 },
    { a: 4 }, // sem grupo
    { a: 5 }, // sem grupo — NÃO se junta ao anterior
    { [GROUP_KEY]: "y", a: 6 }, // mesma chave "y" que antes, mas NÃO contíguo — grupo à parte
  ];
  const grupos = agruparPorGroupKey(rows);
  eq("5 grupos (x:2, y:1, sem-grupo:1, sem-grupo:1, y:1 — não funde os dois 'y' não contíguos)", grupos.length, 5);
  eq("1º grupo: 2 linhas (x)", grupos[0].length, 2);
  eq("2º grupo: 1 linha (y)", grupos[1].length, 1);
  eq("3º e 4º grupos: tamanho 1 cada (sem GROUP_KEY nunca funde)", grupos[2].length, 1);
  eq("", grupos[3].length, 1);
  eq("5º grupo: 1 linha (y, mas não contíguo ao 2º)", grupos[4].length, 1);
}

// ═════════════════════════════════════════════════════════════════════
// B. spanGroup — rowspan só na 1ª linha, célula omitida no resto
// ═════════════════════════════════════════════════════════════════════
console.log("\n=== B. ReportColumn.spanGroup — rowspan por grupo ===");
{
  const cols: ReportColumn[] = [
    { key: "codigo", label: "Código", spanGroup: true },
    { key: "farmacia", label: "Farmácia" },
    { key: "qtd", label: "Qtd", format: "integer" },
  ];
  const rows: ReportRow[] = [
    { [GROUP_KEY]: "A1", codigo: "A1", farmacia: "F1", qtd: 10 },
    { [GROUP_KEY]: "A1", codigo: "A1", farmacia: "F2", qtd: 5 },
    { [GROUP_KEY]: "A1", codigo: "A1", farmacia: "TOTAL ARTIGO", qtd: 15, [ROW_KIND_KEY]: "subtotal" },
  ];
  const html = renderReportHtml(relatorioBase(cols, rows));
  const tbody = html.slice(html.indexOf("<tbody"), html.lastIndexOf("</tbody>"));
  const trs = tbody.split("<tr").slice(1);
  eq("3 linhas desenhadas", trs.length, 3);
  ok("1ª linha tem rowspan=\"3\" no Código", trs[0].includes('rowspan="3"'));
  ok(
    "2ª e 3ª linhas NÃO têm célula de Código (coberta pelo rowspan da 1ª)",
    !trs[1].includes(">A1<") && !trs[2].includes(">A1<"),
  );
  ok("2ª e 3ª linhas continuam a mostrar Farmácia normalmente", trs[1].includes(">F2<") && trs[2].includes("TOTAL ARTIGO"));
}
{
  // Grupo de tamanho 1 — nunca emite rowspan (é o caso da maioria dos
  // relatórios, hoje: nenhum usa GROUP_KEY, logo cada linha é o seu
  // próprio grupo de 1).
  const cols: ReportColumn[] = [{ key: "codigo", label: "Código", spanGroup: true }];
  const rows: ReportRow[] = [{ codigo: "X" }, { codigo: "Y" }];
  const html = renderReportHtml(relatorioBase(cols, rows));
  ok("sem GROUP_KEY, nenhuma célula ganha rowspan", !html.includes("rowspan"));
  const tbody = html.slice(html.indexOf("<tbody"), html.lastIndexOf("</tbody>"));
  eq("continua UM único <tbody> (estrutura de sempre, sem grupos)", (tbody.match(/<tbody/g) ?? []).length, 1);
}

// ═════════════════════════════════════════════════════════════════════
// C. zeroAsDash / toneWhenZero / toneWhenPositive — declarativos
// ═════════════════════════════════════════════════════════════════════
console.log("\n=== C. zeroAsDash e tons condicionais (sem funções — dados puros) ===");
{
  const cols: ReportColumn[] = [
    { key: "mes", label: "Mês", format: "integer", zeroAsDash: true, toneWhenPositive: "info" },
    { key: "stock", label: "Stock", format: "integer", toneWhenZero: "danger", toneWhenPositive: "success" },
  ];
  const rows: ReportRow[] = [
    { mes: 0, stock: 0 },
    { mes: 3, stock: 5 },
  ];
  const html = renderReportHtml(relatorioBase(cols, rows));
  ok("mês=0 mostra \"–\" em vez de \"0\"", html.includes(">–<"));
  ok("mês=3 (positivo) ganha cell-tone-info", /cell-tone-info[^>]*>3</.test(html) || html.includes('class="cell-tone-info">3<'));
  ok("stock=0 ganha cell-tone-danger e mostra \"0\" (zeroAsDash não está activo aqui)", html.includes('class="cell-tone-danger">0<'));
  ok("stock=5 (positivo) ganha cell-tone-success", html.includes('class="cell-tone-success">5<'));
}
{
  // ReportColumn é JSON-serializável — nenhuma função escondida nos tons.
  const cols: ReportColumn[] = [{ key: "x", label: "X", toneWhenZero: "danger", toneWhenPositive: "success" }];
  const roundtrip = JSON.parse(JSON.stringify(cols));
  eq("sobrevive a JSON.stringify/parse sem perder nada", roundtrip[0].toneWhenZero, "danger");
}

// ═════════════════════════════════════════════════════════════════════
// D. noteKey — sublinha discreta, nunca no Excel
// ═════════════════════════════════════════════════════════════════════
console.log("\n=== D. noteKey — sublinha sob a célula ===");
{
  const cols: ReportColumn[] = [{ key: "descricao", label: "Descrição", noteKey: "nota" }];
  const rows: ReportRow[] = [{ descricao: "Produto X", nota: "PVP: 10,00 € | Custo: —" }];
  const html = renderReportHtml(relatorioBase(cols, rows));
  ok("texto principal em cell-main", html.includes('<div class="cell-main">Produto X</div>'));
  ok("nota em cell-note", html.includes('<div class="cell-note">PVP: 10,00 € | Custo: —</div>'));
}
{
  // Linha sem nota (string vazia) — não desenha um <div class="cell-note">
  // vazio à toa.
  const cols: ReportColumn[] = [{ key: "descricao", label: "Descrição", noteKey: "nota" }];
  const rows: ReportRow[] = [{ descricao: "Produto Y", nota: "" }];
  const html = renderReportHtml(relatorioBase(cols, rows));
  // Procurar só no <body> — a folha de estilos (CSS) tem a classe
  // ".cell-note" definida sempre, esteja ou não a ser usada nesta linha.
  const bodyHtml = html.slice(html.indexOf("<body>"));
  ok("sem nota, não desenha cell-note nenhum", !bodyHtml.includes('<div class="cell-note">'));
  ok("mas o texto principal continua lá, sem wrapper nenhum", html.includes(">Produto Y<"));
}

// ═════════════════════════════════════════════════════════════════════
// E. excelOnly — nunca no HTML/PDF, mas continua uma coluna real
// ═════════════════════════════════════════════════════════════════════
console.log("\n=== E. excelOnly — só na folha de cálculo ===");
{
  const cols: ReportColumn[] = [
    { key: "codigo", label: "Código" },
    { key: "pvp", label: "PVP", excelOnly: true },
  ];
  const rows: ReportRow[] = [{ codigo: "X", pvp: 10 }];
  const html = renderReportHtml(relatorioBase(cols, rows));
  ok("thead não tem a coluna excelOnly", !html.slice(html.indexOf("<thead>"), html.indexOf("</thead>")).includes("PVP"));
  ok("tbody não tem o valor da coluna excelOnly", !html.includes(">10<"));
}

// ═════════════════════════════════════════════════════════════════════
// F. Modo "comfortable" (default) — zero mudança visual
// ═════════════════════════════════════════════════════════════════════
console.log("\n=== F. Sem meta.density, o HTML continua o de sempre ===");
{
  const cols: ReportColumn[] = [{ key: "codigo", label: "Código" }];
  const rows: ReportRow[] = [{ codigo: "X" }];
  const html = renderReportHtml(relatorioBase(cols, rows));
  // A string exacta do atributo — nunca aparece assim numa regra CSS
  // (que escreve ".page.density-compact { ... }", não `class="..."`),
  // por isso é segura mesmo com a folha de estilos sempre presente.
  ok("página SEM a classe density-compact", !html.includes('class="page density-compact"'));
  ok("cabeçalho continua .report-header sem .compact", html.includes('class="report-header"') && !html.includes('class="report-header compact"'));
}

// ═════════════════════════════════════════════════════════════════════
// G. Vendas — cenários obrigatórios (secção 12 do pedido)
// ═════════════════════════════════════════════════════════════════════

function meses(n: number, anoInicio = 2025, mesInicio = 7): { ano: number; mes: number }[] {
  const out: { ano: number; mes: number }[] = [];
  let ano = anoInicio, mes = mesInicio;
  for (let i = 0; i < n; i++) {
    out.push({ ano, mes });
    mes++;
    if (mes > 12) { mes = 1; ano++; }
  }
  return out;
}

function linhaVendas(overrides: Partial<VendasAdapterRow> & { buckets: { ano: number; mes: number }[] }): VendasAdapterRow {
  const { buckets, ...rest } = overrides;
  return {
    codigo: "1000001",
    descricao: "Produto de teste",
    farmacia: "Farmácia A",
    pvp: 10,
    custoUnitarioEstimado: 5,
    meses: buckets.map((b) => ({ ...b, quantidade: 0 })),
    totalVendas: 0,
    valorBruto: 0,
    existencia: 0,
    fornecedor: "Distribuidor",
    fabricante: "Fabricante",
    categoria: "Categoria",
    grupo: "Categoria",
    ...rest,
  } as VendasAdapterRow;
}

function comVendaEm(buckets: { ano: number; mes: number }[], idx: number, qtd: number, pvp: number) {
  const ms = buckets.map((b, i) => ({ ...b, quantidade: i === idx ? qtd : 0 }));
  return { meses: ms, totalVendas: qtd, valorBruto: qtd * pvp };
}

function gerarRelatorio(numFarmacias: number, numMeses: number, extraRows: VendasAdapterRow[] = []): Report {
  const buckets = meses(numMeses);
  const farmacias = Array.from({ length: numFarmacias }, (_, i) => `Farmácia ${String.fromCharCode(65 + i)}`);
  // Um artigo presente em TODAS as farmácias, com venda no primeiro mês.
  const rows: VendasAdapterRow[] = farmacias.map((f) =>
    linhaVendas({ buckets, codigo: "1000001", descricao: "Artigo em todas as farmácias", farmacia: f, existencia: 3, ...comVendaEm(buckets, 0, 2, 10) }),
  );
  return buildVendasReport({
    rows: [...rows, ...extraRows],
    buckets,
    filters: { agruparPor: "artigo" },
    universe: { farmacias, fornecedores: [], fabricantes: [], categorias: [] },
    organization: "Grupo Teste",
  });
}

console.log("\n=== G. Vendas — combinações farmácias × meses obrigatórias ===");
for (const [nf, nm] of [[1, 3], [2, 12], [2, 15], [5, 12], [5, 15]] as const) {
  const rel = gerarRelatorio(nf, nm);
  const html = renderReportHtml(rel);
  // Só no <body> — a folha de estilos cita "TOTAL ARTIGO"/"TOTAL GERAL"
  // em comentários CSS (a explicar as regras .subtotal-row/tfoot),
  // sempre presentes independentemente dos dados desta chamada.
  const bodyHtml = html.slice(html.indexOf("<body>"));
  const cols = rel.columns.filter((c) => !c.hidden && !c.excelOnly);
  const somaLarguras = cols.reduce((s, c) => s + (c.width ?? 0), 0);

  ok(`${nf}f/${nm}m: soma das larguras visíveis ≤ 100 (${somaLarguras.toFixed(1)})`, somaLarguras <= 100.05);
  ok(`${nf}f/${nm}m: meta.density é "compact"`, rel.meta?.density === "compact");
  const tableDensityEsperada = nm <= 6 ? "cozy" : nm <= 10 ? "tight" : "ultratight";
  eq(`${nf}f/${nm}m: tableDensity = "${tableDensityEsperada}"`, rel.meta?.tableDensity, tableDensityEsperada);

  if (nf > 1) {
    ok(`${nf}f/${nm}m: existe TOTAL ARTIGO (mais de uma farmácia)`, bodyHtml.includes("TOTAL ARTIGO"));
    // rowspan do Código/Descrição cobre farmácias + total = nf + 1 linhas.
    ok(`${nf}f/${nm}m: rowspan cobre farmácias+total (rowspan="${nf + 1}")`, bodyHtml.includes(`rowspan="${nf + 1}"`));
  }
  ok(`${nf}f/${nm}m: TOTAL GERAL presente`, bodyHtml.includes("TOTAL GERAL"));
  // Todos os meses aparecem no cabeçalho, nenhum cortado a meio.
  const thead = html.slice(html.indexOf("<thead>"), html.indexOf("</thead>"));
  const mesesCols = cols.filter((c) => c.key.startsWith("m_"));
  eq(`${nf}f/${nm}m: ${nm} colunas de mês`, mesesCols.length, nm);
  ok(
    `${nf}f/${nm}m: nenhum rótulo de mês passa de 3 caracteres por linha (nunca corta)`,
    mesesCols.every((c) => c.label.split("\n").every((l) => l.length <= 3)),
  );
  // `/<th[\s>]/` — não `/<th/`, que também batia em `<thead>` (prefixo
  // igual) e desalinhava a contagem em relação a `</th>`.
  ok(
    `${nf}f/${nm}m: <thead> sem sobreposição óbvia (tags bem fechadas)`,
    (thead.match(/<th[\s>]/g) ?? []).length === (thead.match(/<\/th>/g) ?? []).length,
  );
}

console.log("\n=== G2. Descrição longa não parte a estrutura ===");
{
  const buckets = meses(3);
  const descricaoLonga = "Intimina Ziggy Cup 2 B — copo menstrual reutilizável, tamanho B, silicone medicinal de grau cirúrgico, embalagem individual com estojo de esterilização a vapor incluído";
  const rows = [
    linhaVendas({ buckets, codigo: "7241638", descricao: descricaoLonga, farmacia: "Farmácia A", existencia: 1, ...comVendaEm(buckets, 1, 1, 37.9) }),
    linhaVendas({ buckets, codigo: "7241638", descricao: descricaoLonga, farmacia: "Farmácia B", existencia: 0 }),
  ];
  const rel = buildVendasReport({
    rows, buckets, filters: { agruparPor: "artigo" },
    universe: { farmacias: ["Farmácia A", "Farmácia B"], fornecedores: [], fabricantes: [], categorias: [] },
    organization: "Grupo Teste",
  });
  const html = renderReportHtml(rel);
  ok("a descrição completa (sem cortar) chega ao HTML", html.includes(descricaoLonga));
  ok("continua a existir TOTAL ARTIGO para este CNP", html.slice(html.indexOf("<body>")).includes("TOTAL ARTIGO"));
}

console.log("\n=== G3. Produto só numa farmácia — sem TOTAL ARTIGO, sem rowspan>1 ===");
{
  const buckets = meses(3);
  const rows = [linhaVendas({ buckets, codigo: "2000001", descricao: "Só numa farmácia", farmacia: "Farmácia A", existencia: 2, ...comVendaEm(buckets, 0, 1, 5) })];
  const rel = buildVendasReport({
    rows, buckets, filters: { agruparPor: "artigo" },
    universe: { farmacias: ["Farmácia A"], fornecedores: [], fabricantes: [], categorias: [] },
    organization: "Grupo Teste",
  });
  const html = renderReportHtml(rel);
  // Só no <body> — a folha de estilos tem "TOTAL ARTIGO" citado num
  // comentário CSS (a explicar a regra .subtotal-row), sempre presente
  // independentemente de existir ou não uma linha de subtotal aqui.
  const bodyHtml = html.slice(html.indexOf("<body>"));
  ok("sem TOTAL ARTIGO (só uma farmácia — seria uma cópia da linha)", !bodyHtml.includes("TOTAL ARTIGO"));
  ok("sem rowspan (grupo de tamanho 1)", !bodyHtml.includes("rowspan"));
}

console.log("\n=== G4. Produto com stock mas SEM vendas — meses a \"–\", tom de stock ===");
{
  const buckets = meses(3);
  const rows = [
    linhaVendas({ buckets, codigo: "3000001", descricao: "Só stock", farmacia: "Farmácia A", existencia: 7, totalVendas: 0, valorBruto: 0 }),
  ];
  const rel = buildVendasReport({
    rows, buckets, filters: {},
    universe: { farmacias: ["Farmácia A"], fornecedores: [], fabricantes: [], categorias: [] },
    organization: "Grupo Teste",
  });
  const html = renderReportHtml(rel);
  ok("os 3 meses aparecem como \"–\", nunca vendas inventadas", (html.match(/>–</g) ?? []).length >= 3);
  ok("stock=7 (positivo) ganha cell-tone-success", html.includes('class="cell-tone-success">7<'));
}

console.log("\n=== G5. custoUnitarioEstimado e valorBruto — bug antigo corrigido ===");
{
  // Antes desta correcção, `paraReportRow` não lia estes dois campos —
  // a coluna de custo aparecia sempre "—" e não havia coluna de valor
  // de vendas nenhuma, apesar de ambos os dados já existirem no loader.
  const buckets = meses(1);
  const rows = [
    linhaVendas({ buckets, codigo: "4000001", descricao: "Com custo e valor", farmacia: "Farmácia A", custoUnitarioEstimado: 12.34, existencia: 1, ...comVendaEm(buckets, 0, 2, 20) }),
  ];
  const rel = buildVendasReport({
    rows, buckets, filters: {},
    universe: { farmacias: ["Farmácia A"], fornecedores: [], fabricantes: [], categorias: [] },
    organization: "Grupo Teste",
  });
  const linha = rel.rows[0];
  eq("custoUnitarioEstimado chega à linha do relatório", linha.custoUnitarioEstimado, 12.34);
  eq("valorBruto (Valor Vendas) chega à linha do relatório", linha.valorBruto, 40);
  // Correcção (2026-09): PVP/Custo voltaram a ser colunas VISÍVEIS no
  // HTML/PDF (não `excelOnly`) — ver a nota grande no topo do adaptador.
  const custoCol = rel.columns.find((c) => c.key === "custoUnitarioEstimado");
  ok("a coluna existe e já NÃO é excelOnly (é uma coluna por farmácia)", custoCol?.excelOnly !== true);
  const valorCol = rel.columns.find((c) => c.key === "valorBruto");
  ok("existe agora uma coluna de Valor Vendas, com total", valorCol?.showTotal === true);
  const html = renderReportHtml(rel);
  // Só no <body> — "PVP:" também aparece num comentário CSS (a explicar
  // a regra .cell-note), sempre presente independentemente dos dados.
  const bodyHtmlG5 = html.slice(html.indexOf("<body>"));
  ok("o PVP aparece como coluna (não sublinha)", bodyHtmlG5.includes(">PVP<"));
  ok("o Custo unit. est. aparece com o valor certo (12,34 €)", bodyHtmlG5.includes(`>${formatCurrency(12.34)}<`));
  ok("o Valor Vendas aparece no HTML (40,00 €)", bodyHtmlG5.includes("40,00"));
}

// ═════════════════════════════════════════════════════════════════════
// G6. Coerência PDF/Excel — mesmas colunas, mesma ordem, PVP/Custo em
//     ambos (correcção 2026-09: já não é só-Excel, ver secção L)
// ═════════════════════════════════════════════════════════════════════
console.log("\n=== G6. Excel e HTML/PDF mostram as mesmas colunas, na mesma ordem ===");
{
  const buckets = meses(3);
  const rows = [
    linhaVendas({ buckets, codigo: "6000001", descricao: "Produto para Excel", farmacia: "Farmácia A", custoUnitarioEstimado: 4.5, existencia: 3, ...comVendaEm(buckets, 0, 2, 15) }),
  ];
  const rel = buildVendasReport({
    rows, buckets, filters: {},
    universe: { farmacias: ["Farmácia A"], fornecedores: [], fabricantes: [], categorias: [] },
    organization: "Grupo Teste",
  });
  const wb = buildReportWorkbook(rel);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 });
  const headerRow = aoa.find((r) => Array.isArray(r) && r.includes("CNP")) as (string | number)[] | undefined;
  ok("a folha tem uma linha de cabeçalho com CNP", !!headerRow);
  ok("…e PVP continua lá", !!headerRow?.includes("PVP"));
  ok("…e Custo unit. est. continua lá", !!headerRow?.some((h) => typeof h === "string" && h.replace(/\s+/g, " ") === "Custo unit. est."));
  ok("…e Farmácia continua a seguir à Descrição (mesma ordem do HTML)", !!headerRow && headerRow.indexOf("Farmácia") > headerRow.indexOf("Descrição"));
  ok("…e PVP/Custo vêm a seguir à Farmácia (mesma ordem do HTML)", !!headerRow && headerRow.indexOf("PVP") > headerRow.indexOf("Farmácia"));
  ok("…e Valor Vendas (s/IVA) está na folha", !!headerRow?.some((h) => typeof h === "string" && h.includes("Valor Vendas")));

  const html = renderReportHtml(rel);
  const theadHtml = html.slice(html.indexOf("<thead>"), html.indexOf("</thead>"));
  ok("o HTML/PDF TAMBÉM desenha PVP como coluna própria", theadHtml.includes(">PVP<"));
  ok("…e Custo unit. est. também", theadHtml.includes("Custo") && theadHtml.includes("unit. est."));
}

// ═════════════════════════════════════════════════════════════════════
// I. ReportColumn.displayKey — apresentação sem tocar no dado real
// ═════════════════════════════════════════════════════════════════════
console.log("\n=== I. displayKey — HTML mostra o nome curto, Excel mantém o nome completo ===");
{
  const cols: ReportColumn[] = [{ key: "farmacia", label: "Farmácia", displayKey: "farmaciaCurta" }];
  const rows: ReportRow[] = [{ farmacia: "Farmácia Segurado", farmaciaCurta: "Segurado" }];
  const rel = relatorioBase(cols, rows);
  const html = renderReportHtml(rel);
  const bodyHtmlI = html.slice(html.indexOf("<body>"));
  ok("HTML mostra o nome curto (\"Segurado\")", bodyHtmlI.includes(">Segurado<"));
  ok("HTML NÃO mostra o prefixo \"Farmácia \"", !bodyHtmlI.includes("Farmácia Segurado"));

  const wb = buildReportWorkbook(rel);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 });
  // `.includes()` faz igualdade exacta — a célula é "Farmácia Segurado"
  // por inteiro, não "Segurado" isolado, por isso a procura tem de ser
  // por substring.
  const linhaDados = aoa.find(
    (r) => Array.isArray(r) && r.some((cel) => typeof cel === "string" && cel.includes("Farmácia Segurado")),
  );
  ok(
    "Excel continua com o nome COMPLETO (\"Farmácia Segurado\") — displayKey não o afecta",
    !!linhaDados,
    JSON.stringify(aoa),
  );
}

console.log("\n=== I2. Vendas: coluna Farmácia sem \"Farmácia \" no HTML, presente no Excel ===");
{
  const buckets3 = meses(3);
  const rows = [
    linhaVendas({ buckets: buckets3, codigo: "8000001", descricao: "Produto A", farmacia: "Farmácia Segurado", existencia: 1, ...comVendaEm(buckets3, 0, 1, 10) }),
    linhaVendas({ buckets: buckets3, codigo: "8000001", descricao: "Produto A", farmacia: "Farmácia Silveirense", existencia: 0 }),
  ];
  const rel = buildVendasReport({
    rows, buckets: buckets3, filters: { agruparPor: "artigo" },
    universe: { farmacias: ["Farmácia Segurado", "Farmácia Silveirense"], fornecedores: [], fabricantes: [], categorias: [] },
    organization: "Grupo Teste",
  });
  const html = renderReportHtml(rel);
  const bodyHtmlI2 = html.slice(html.indexOf("<body>"));
  ok("HTML mostra \"Segurado\" e \"Silveirense\", sem o prefixo", bodyHtmlI2.includes(">Segurado<") && bodyHtmlI2.includes(">Silveirense<"));
  ok("…e nunca \"Farmácia Segurado\"/\"Farmácia Silveirense\" no corpo", !bodyHtmlI2.includes("Farmácia Segurado") && !bodyHtmlI2.includes("Farmácia Silveirense"));

  const wb = buildReportWorkbook(rel);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 });
  const temNomeCompleto = aoa.some((r) => Array.isArray(r) && r.includes("Farmácia Segurado"));
  ok("Excel continua com o nome completo da farmácia", temNomeCompleto);
}

// ═════════════════════════════════════════════════════════════════════
// J. TOTAL ARTIGO / TOTAL GERAL compactos — nunca quebram a duas linhas
// ═════════════════════════════════════════════════════════════════════
console.log("\n=== J. Totais compactos — sem quebra de linha, altura próxima do normal ===");
{
  const src = readFileSync("lib/reporting/report-html.ts", "utf8");
  const subtotalCompacto = src.slice(
    src.indexOf(".page.density-compact tbody tr.subtotal-row td {"),
    src.indexOf("}", src.indexOf(".page.density-compact tbody tr.subtotal-row td {")),
  );
  ok("regra compacta do TOTAL ARTIGO força nowrap (nunca quebra \"TOTAL\"/\"ARTIGO\")", /white-space:\s*nowrap/.test(subtotalCompacto));

  const tfootCompacto = src.slice(
    src.indexOf(".page.density-compact tfoot td {"),
    src.indexOf("}", src.indexOf(".page.density-compact tfoot td {")),
  );
  ok("regra compacta do TOTAL GERAL força nowrap", /white-space:\s*nowrap/.test(tfootCompacto));
  ok(
    "padding do TOTAL GERAL ficou próximo de uma linha normal (≤3.5px, era 5px)",
    /padding:\s*([0-3](\.\d+)?)px/.test(tfootCompacto),
    tfootCompacto,
  );
  ok(
    "font-size do TOTAL GERAL passou a herdar da tabela (não fica desproporcional em densidades apertadas)",
    /font-size:\s*inherit/.test(tfootCompacto),
  );
}
{
  // Ponta-a-ponta: com colunas estreitas (muitos meses), "TOTAL ARTIGO"
  // e "TOTAL GERAL" continuam inteiros — nunca "TOTAL" e "ARTIGO" em
  // <br/> ou em linhas separadas dentro da célula.
  const buckets15 = meses(15);
  const rows = [
    linhaVendas({ buckets: buckets15, codigo: "9000001", descricao: "Produto", farmacia: "Farmácia A", existencia: 1, ...comVendaEm(buckets15, 0, 1, 10) }),
    linhaVendas({ buckets: buckets15, codigo: "9000001", descricao: "Produto", farmacia: "Farmácia B", existencia: 0 }),
  ];
  const rel = buildVendasReport({
    rows, buckets: buckets15, filters: { agruparPor: "artigo" },
    universe: { farmacias: ["Farmácia A", "Farmácia B"], fornecedores: [], fabricantes: [], categorias: [] },
    organization: "Grupo Teste",
  });
  const html = renderReportHtml(rel);
  const bodyHtmlJ = html.slice(html.indexOf("<body>"));
  ok("\"TOTAL ARTIGO\" continua inteiro, nunca partido em <br/>", bodyHtmlJ.includes(">TOTAL ARTIGO<") || bodyHtmlJ.includes("TOTAL ARTIGO</strong>"));
  ok("\"TOTAL GERAL\" continua inteiro", bodyHtmlJ.includes("TOTAL GERAL</strong>"));
  ok("nenhum dos dois foi partido por um <br/> a meio (\"TOTAL<br/>ARTIGO\"/\"TOTAL<br/>GERAL\")", !bodyHtmlJ.includes("TOTAL<br/>ARTIGO") && !bodyHtmlJ.includes("TOTAL<br/>GERAL"));
}

// ═════════════════════════════════════════════════════════════════════
// K. Ordem estável das farmácias — igual em TODOS os artigos
// ═════════════════════════════════════════════════════════════════════
console.log("\n=== K. Ordem das farmácias — estável e igual em todos os artigos ===");
{
  const buckets3 = meses(3);
  // Insercao DELIBERADAMENTE trocada entre artigos — é exactamente o
  // bug relatado: um artigo com Segurado primeiro, outro com
  // Silveirense primeiro.
  const rows = [
    linhaVendas({ buckets: buckets3, codigo: "A001", descricao: "Artigo A", farmacia: "Farmácia Silveirense", existencia: 1, ...comVendaEm(buckets3, 0, 1, 10) }),
    linhaVendas({ buckets: buckets3, codigo: "A001", descricao: "Artigo A", farmacia: "Farmácia Segurado", existencia: 2, ...comVendaEm(buckets3, 1, 1, 10) }),
    linhaVendas({ buckets: buckets3, codigo: "B002", descricao: "Artigo B", farmacia: "Farmácia Segurado", existencia: 3, ...comVendaEm(buckets3, 0, 2, 5) }),
    linhaVendas({ buckets: buckets3, codigo: "B002", descricao: "Artigo B", farmacia: "Farmácia Silveirense", existencia: 0, ...comVendaEm(buckets3, 2, 1, 5) }),
  ];
  const rel = buildVendasReport({
    rows, buckets: buckets3, filters: { agruparPor: "artigo" },
    // A ordem "já definida/recebida pelo relatório" — Segurado antes de
    // Silveirense, deliberadamente diferente da ordem de inserção acima
    // em ambos os artigos, para provar que é ELA que manda.
    universe: { farmacias: ["Farmácia Segurado", "Farmácia Silveirense"], fornecedores: [], fabricantes: [], categorias: [] },
    organization: "Grupo Teste",
  });
  const linhasA = rel.rows.filter((r) => r.codigo === "A001" || r[GROUP_KEY] === "A001");
  const linhasB = rel.rows.filter((r) => r.codigo === "B002" || r[GROUP_KEY] === "B002");
  const farmaciasA = linhasA.filter((r) => r.farmacia !== "TOTAL ARTIGO").map((r) => r.farmacia);
  const farmaciasB = linhasB.filter((r) => r.farmacia !== "TOTAL ARTIGO").map((r) => r.farmacia);
  eq("Artigo A: Segurado antes de Silveirense (apesar de Silveirense ter entrado primeiro)", farmaciasA.join(","), "Farmácia Segurado,Farmácia Silveirense");
  eq("Artigo B: MESMA ordem (Segurado antes de Silveirense) — igual à do Artigo A", farmaciasB.join(","), "Farmácia Segurado,Farmácia Silveirense");
}
{
  // Sem ordem explícita (universe.farmacias vazio) → cai em alfabética.
  const buckets3 = meses(3);
  const rows = [
    linhaVendas({ buckets: buckets3, codigo: "C003", descricao: "Artigo C", farmacia: "Farmácia Zulu", existencia: 1, ...comVendaEm(buckets3, 0, 1, 10) }),
    linhaVendas({ buckets: buckets3, codigo: "C003", descricao: "Artigo C", farmacia: "Farmácia Alfa", existencia: 0 }),
  ];
  const rel = buildVendasReport({
    rows, buckets: buckets3, filters: { agruparPor: "artigo" },
    universe: { farmacias: [], fornecedores: [], fabricantes: [], categorias: [] },
    organization: "Grupo Teste",
  });
  const farmaciasC = rel.rows.filter((r) => r.farmacia !== "TOTAL ARTIGO").map((r) => r.farmacia);
  eq(
    "sem ordem explícita, cai em alfabética (\"Alfa\" antes de \"Zulu\", nunca a ordem de entrada)",
    farmaciasC.join(","),
    "Farmácia Alfa,Farmácia Zulu",
  );
}
{
  // Um artigo sem dados numa farmácia não desalinha a ordem das
  // restantes — só omite a que falta.
  const buckets3 = meses(3);
  const rows = [
    linhaVendas({ buckets: buckets3, codigo: "D004", descricao: "Artigo D", farmacia: "Farmácia Segurado", existencia: 1, ...comVendaEm(buckets3, 0, 1, 10) }),
    // "Farmácia Central" nunca aparece para este artigo — só Segurado e Silveirense.
    linhaVendas({ buckets: buckets3, codigo: "D004", descricao: "Artigo D", farmacia: "Farmácia Silveirense", existencia: 0 }),
  ];
  const rel = buildVendasReport({
    rows, buckets: buckets3, filters: { agruparPor: "artigo" },
    universe: { farmacias: ["Farmácia Segurado", "Farmácia Central", "Farmácia Silveirense"], fornecedores: [], fabricantes: [], categorias: [] },
    organization: "Grupo Teste",
  });
  const farmaciasD = rel.rows.filter((r) => r.farmacia !== "TOTAL ARTIGO").map((r) => r.farmacia);
  eq(
    "Farmácia Central (sem dados neste artigo) é omitida sem alterar a ordem das restantes",
    farmaciasD.join(","),
    "Farmácia Segurado,Farmácia Silveirense",
  );
}

// ═════════════════════════════════════════════════════════════════════
// H. report-pdf-server.ts — paginação via puppeteer headerTemplate
// ═════════════════════════════════════════════════════════════════════
console.log("\n=== H. report-pdf-server.ts pede paginação ao Chromium ===");
{
  const src = readFileSync("lib/reporting/report-pdf-server.ts", "utf8");
  ok("displayHeaderFooter activo", /displayHeaderFooter:\s*true/.test(src));
  ok("headerTemplate usa pageNumber/totalPages (só o Chromium sabe o total)", /pageNumber/.test(src) && /totalPages/.test(src));
  ok("page.close()/finally continuam intactos (não regrediu o launcher)", /page\.close\(\)/.test(src) && /finally/.test(src));
}

// ═════════════════════════════════════════════════════════════════════
// L. PVP/Custo por FARMÁCIA — nunca um valor único por artigo
//
// O bug relatado: com `agruparPor:"artigo"`, Código/Descrição usam
// `spanGroup` (rowspan cobrindo todas as sublinhas de farmácia) — se
// PVP/Custo vivessem numa coluna também `spanGroup` (ou numa sublinha
// presa a ela), só a PRIMEIRA farmácia do grupo mostraria o seu valor;
// as restantes ficariam com o MESMO valor, coberto pelo rowspan, apesar
// de cada farmácia ter o seu próprio PVP/custo em `ProdutoFarmacia`.
// ═════════════════════════════════════════════════════════════════════
console.log("\n=== L. PVP/Custo por farmácia — nunca um único valor por artigo ===");
{
  // Caso do pedido: mesmo CNP, Segurado e Silveirense com PVP/custo
  // diferentes. Ordem de entrada é a "errada" de propósito (Silveirense
  // primeiro) para também exercitar a ordem estável (secção K) ao mesmo
  // tempo — Segurado continua a aparecer primeiro (universe.farmacias).
  const buckets3 = meses(3);
  const rows2f = [
    linhaVendas({
      buckets: buckets3, codigo: "8322628", descricao: "Ventilan",
      farmacia: "Farmácia Silveirense", pvp: 6.5, custoUnitarioEstimado: 3.75,
      existencia: 4, ...comVendaEm(buckets3, 0, 1, 6.5),
    }),
    linhaVendas({
      buckets: buckets3, codigo: "8322628", descricao: "Ventilan",
      farmacia: "Farmácia Segurado", pvp: 6.66, custoUnitarioEstimado: 4.46,
      existencia: 2, ...comVendaEm(buckets3, 1, 1, 6.66),
    }),
  ];
  const rel2f = buildVendasReport({
    rows: rows2f, buckets: buckets3, filters: { agruparPor: "artigo" },
    universe: { farmacias: ["Farmácia Segurado", "Farmácia Silveirense"], fornecedores: [], fabricantes: [], categorias: [] },
    organization: "Grupo Teste",
  });
  const detalhes2f = rel2f.rows.filter((r) => r.farmacia !== "TOTAL ARTIGO");
  eq("2f: Segurado primeiro (ordem estável)", detalhes2f[0].farmacia, "Farmácia Segurado");
  eq("2f: PVP do Segurado é o SEU (6,66), não o de outra farmácia", detalhes2f[0].pvp, 6.66);
  eq("2f: Custo do Segurado é o SEU (4,46)", detalhes2f[0].custoUnitarioEstimado, 4.46);
  eq("2f: PVP do Silveirense é o SEU (6,5), diferente do Segurado", detalhes2f[1].pvp, 6.5);
  eq("2f: Custo do Silveirense é o SEU (3,75), diferente do Segurado", detalhes2f[1].custoUnitarioEstimado, 3.75);
  const totalArtigo2f = rel2f.rows.find((r) => r.farmacia === "TOTAL ARTIGO");
  eq("2f: TOTAL ARTIGO não tem PVP (não há valor único correcto)", totalArtigo2f?.pvp, null);
  eq("2f: TOTAL ARTIGO não tem Custo (idem)", totalArtigo2f?.custoUnitarioEstimado, null);

  const html2f = renderReportHtml(rel2f);
  const body2f = html2f.slice(html2f.indexOf("<body>"));
  ok("PDF/HTML mostra o PVP do Segurado (6,66 €)", body2f.includes(`>${formatCurrency(6.66)}<`));
  ok("…e o do Silveirense (6,50 €), NUNCA os dois iguais", body2f.includes(`>${formatCurrency(6.5)}<`));
  ok("PDF/HTML mostra o custo do Segurado (4,46 €)", body2f.includes(`>${formatCurrency(4.46)}<`));
  ok("…e o do Silveirense (3,75 €)", body2f.includes(`>${formatCurrency(3.75)}<`));
  // A célula da 2ª sublinha (Silveirense) tem de ser uma célula própria,
  // não coberta por rowspan — é exactamente o que o bug fazia desaparecer.
  const linhasTr2f = body2f.match(/<tr[^>]*>.*?<\/tr>/g) ?? [];
  const trSilveirense = linhasTr2f.find((tr) => tr.includes(">Silveirense<"));
  ok("a linha do Silveirense tem célula PVP própria (sem rowspan a cobri-la)", !!trSilveirense && trSilveirense.includes(`>${formatCurrency(6.5)}<`));
  // TOTAL ARTIGO mostra "—" (em dash — valor null via formatCell, não o
  // "–" en dash de zeroAsDash) para PVP/Custo — nunca uma média, nunca
  // em branco por acaso.
  const trTotal2f = linhasTr2f.find((tr) => tr.includes("TOTAL ARTIGO"));
  const numTracos = (trTotal2f?.match(/>—</g) ?? []).length;
  ok('TOTAL ARTIGO mostra pelo menos dois "—" (PVP e Custo, sem valor único)', numTracos >= 2);

  // 1 farmácia — sem grupo/rowspan, continua a mostrar o valor certo.
  const rows1f = [
    linhaVendas({ buckets: buckets3, codigo: "9000001", descricao: "Produto único", farmacia: "Farmácia Segurado", pvp: 9.99, custoUnitarioEstimado: 5.55, existencia: 1, ...comVendaEm(buckets3, 0, 1, 9.99) }),
  ];
  const rel1f = buildVendasReport({
    rows: rows1f, buckets: buckets3, filters: { agruparPor: "artigo" },
    universe: { farmacias: ["Farmácia Segurado"], fornecedores: [], fabricantes: [], categorias: [] },
    organization: "Grupo Teste",
  });
  eq("1f: PVP correcto mesmo sem grupo (uma só farmácia)", rel1f.rows[0].pvp, 9.99);
  eq("1f: Custo correcto", rel1f.rows[0].custoUnitarioEstimado, 5.55);

  // 5 farmácias — cinco PVP/custo distintos, todos têm de sobreviver.
  const nomes5 = ["Farmácia Alfa", "Farmácia Beta", "Farmácia Gama", "Farmácia Delta", "Farmácia Épsilon"];
  const rows5f = nomes5.map((f, i) =>
    linhaVendas({
      buckets: buckets3, codigo: "7000001", descricao: "Produto em 5 farmácias", farmacia: f,
      pvp: 10 + i, custoUnitarioEstimado: 5 + i, existencia: i,
      ...comVendaEm(buckets3, i % 3, 1, 10 + i),
    }),
  );
  const rel5f = buildVendasReport({
    rows: rows5f, buckets: buckets3, filters: { agruparPor: "artigo" },
    universe: { farmacias: nomes5, fornecedores: [], fabricantes: [], categorias: [] },
    organization: "Grupo Teste",
  });
  const detalhes5f = rel5f.rows.filter((r) => r.farmacia !== "TOTAL ARTIGO");
  eq("5f: cinco sublinhas de detalhe", detalhes5f.length, 5);
  eq("5f: PVPs distintos, na ordem certa (10..14)", detalhes5f.map((r) => r.pvp).join(","), "10,11,12,13,14");
  eq("5f: Custos distintos, na ordem certa (5..9)", detalhes5f.map((r) => r.custoUnitarioEstimado).join(","), "5,6,7,8,9");
  const html5f = renderReportHtml(rel5f);
  const body5f = html5f.slice(html5f.indexOf("<body>"));
  for (let i = 0; i < 5; i++) {
    ok(`5f: PVP da farmácia ${i + 1} (${formatCurrency(10 + i)}) aparece no PDF/HTML`, body5f.includes(`>${formatCurrency(10 + i)}<`));
  }
}

console.log(`\n${fail === 0 ? "PASSOU" : "FALHOU"} — ${pass} OK, ${fail} falhas\n`);
process.exit(fail === 0 ? 0 : 1);
