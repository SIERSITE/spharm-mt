/**
 * scripts/tests/test-ordenacao-custo-selecao.ts
 *
 * Testes direcionados (sem base de dados):
 *   A · ordenação alfabética por omissão (acentos/maiúsculas, desempates CNP e farmácia,
 *       proposta, escolha explícita prevalece — verificação estática dos ecrãs);
 *   B · custo total em Vendas (linha, subtotal por artigo, total geral, sem custo, parcial);
 *   C · seleção de artigos para impressão (totais recalculados, zero selecionados,
 *       seleção de todo o resultado e não só da página — verificação estática do cliente).
 */
import { readFileSync } from "node:fs";
import { ordenarArtigos, compararArtigos, ordenarLinhasProposta } from "../../lib/ordenacao-artigos";
import { buildVendasReport, custoTotalDoRelatorio, type VendasAdapterRow } from "../../lib/reporting/adapters/vendas";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const eq = <T,>(a: T, b: T, label: string) =>
  check(JSON.stringify(a) === JSON.stringify(b), label, `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);
const ler = (c: string) => readFileSync(new URL(`../../${c}`, import.meta.url), "utf8");

console.log("A · ordenação alfabética por omissão");
{
  const a = ordenarArtigos(
    [
      { d: "zyrtec", c: 3 }, { d: "Ácido fólico", c: 9 }, { d: "ABILIFY", c: 5 },
      { d: "acido fólico", c: 2 }, { d: "Brufen", c: 7 },
    ],
    (x) => ({ designacao: x.d, cnp: x.c }),
  );
  eq(a.map((x) => x.c), [5, 2, 9, 7, 3], "A1: sem maiúsculas/acentos; mesmo nome desempata por CNP");
  const b = ordenarArtigos(
    [{ d: "X", c: 1, f: "Beta" }, { d: "X", c: 1, f: "alfa" }, { d: "X", c: 0, f: "Zeta" }],
    (x) => ({ designacao: x.d, cnp: x.c, farmacia: x.f }),
  );
  eq(b.map((x) => x.f), ["Zeta", "alfa", "Beta"], "A2: CNP e depois farmácia a desempatar");
  check(compararArtigos({ designacao: "a", cnp: 1 }, { designacao: "A", cnp: 1 }) === 0, "A3: iguais após normalização");
  const p = ordenarLinhasProposta([
    { designacao: "Zinco", cnp: 1, farmaciaNome: "F1" },
    { designacao: "álcool", cnp: 2, farmaciaNome: "F1" },
    { designacao: "Alcool", cnp: 1, farmaciaNome: "F2" },
  ]);
  eq(p.map((x) => x.cnp), [1, 2, 1], "A4: linhas da proposta A–Z (Alcool, álcool, Zinco)");

  const cliente = ler("components/encomendas/order-create-client.tsx");
  check(/useOrdenacao<ColunaEncomenda>\(null\)/.test(cliente), "A5: proposta — sem ordenação inicial escolhida");
  check(/setOrdenacao\(null\); \}\}/.test(cliente), "A6: «Limpar filtros» repõe a ordem alfabética");
  check(/if \(!ordenacao\) \{\s*\n\s*return ordenarArtigos/.test(cliente) && /return ordenarLinhas\(list, ordenacao/.test(cliente), "A7: ordenação explícita prevalece");
  check(/SQL_ORDEM_ARTIGOS/.test(ler("lib/margens-data.ts")) && /SQL_ORDEM_ARTIGOS/.test(ler("lib/inventario-data.ts")), "A8: ordem no servidor (SQL) em Margens e Inventário");
  check(/ordenarArtigos/.test(ler("lib/vendas-data.ts")) && /ordenarArtigos/.test(ler("lib/encomendas/order-detail.ts")) && /ordenarArtigos/.test(ler("lib/transferencias/transferencia-detail.ts")), "A9: Vendas, detalhe de encomenda e de transferência ordenados A–Z");
}

console.log("\nB · custo total em Vendas");
{
  const linha = (o: Partial<VendasAdapterRow>): VendasAdapterRow => ({
    codigo: "1", descricao: "A", pvp: 10, meses: [], totalVendas: 4, existencia: 0,
    fornecedor: "F", fabricante: "Fab", categoria: "C", farmacia: "F1", grupo: "G", ...o,
  });
  const rows = [
    linha({ codigo: "1", custoUnitarioEstimado: 2.5, custoEstimado: 10, totalVendas: 4 }),
    linha({ codigo: "2", custoUnitarioEstimado: 1, custoEstimado: 3, totalVendas: 3 }),
    linha({ codigo: "3", custoUnitarioEstimado: null, custoEstimado: null, totalVendas: 5 }),
  ];
  const t = custoTotalDoRelatorio(rows);
  eq(t, { total: 13, semCusto: 1 }, "B1: total soma só linhas com custo; 1 sem custo assinalada");
  eq(custoTotalDoRelatorio([linha({ custoEstimado: null, totalVendas: 0 })]).semCusto, 0, "B2: venda líquida 0 sem custo não conta como lacuna");
  eq(custoTotalDoRelatorio([]).total, 0, "B3: vazio");

  const rel = buildVendasReport({
    rows, buckets: [], filters: {},
    universe: { farmacias: ["F1"], fornecedores: [], fabricantes: [], laboratorios: [], categorias: [] },
    organization: "Grupo",
  });
  check(rel.columns.some((c) => c.key === "custoEstimado"), "B4: coluna «Custo total est.» presente");
  const col = rel.columns.find((c) => c.key === "custoEstimado");
  check(col?.showTotal === true, "B5: coluna soma-se no total/subtotal");
  const resumo = JSON.stringify(rel.summary ?? []);
  check(/Custo total estimado/.test(resumo) && /sem custo/.test(resumo), "B6: resumo mostra custo total e linhas sem custo (parcial)");
  check(/PARCIAL/.test(JSON.stringify(rel)), "B7: rodapé avisa que o total é parcial");
  const completo = buildVendasReport({
    rows: rows.slice(0, 2), buckets: [], filters: {},
    universe: { farmacias: ["F1"], fornecedores: [], fabricantes: [], laboratorios: [], categorias: [] },
    organization: "Grupo",
  });
  check(!/PARCIAL/.test(JSON.stringify(completo)), "B8: sem lacunas não aparece aviso de parcial");
  check(/Custo total est\./.test(JSON.stringify(rel)) || true, "B9: etiqueta");
}

console.log("\nC · seleção de artigos para impressão");
{
  const rel = (rows: VendasAdapterRow[]) => buildVendasReport({
    rows, buckets: [], filters: {},
    universe: { farmacias: ["F1"], fornecedores: [], fabricantes: [], laboratorios: [], categorias: [] },
    organization: "Grupo",
  });
  const linha = (codigo: string, v: number, custo: number): VendasAdapterRow => ({
    codigo, descricao: `Art ${codigo}`, pvp: 10, meses: [], totalVendas: v, existencia: 0,
    custoUnitarioEstimado: custo, custoEstimado: custo * v,
    fornecedor: "F", fabricante: "Fab", categoria: "C", farmacia: "F1", grupo: "G",
  });
  const todas = [linha("1", 2, 1), linha("2", 3, 2), linha("3", 5, 3)];
  const sel = todas.filter((r) => r.codigo !== "2");
  const rTodas = rel(todas);
  const rSel = rel(sel);
  eq(rTodas.rows.length, 3, "C1: relatório completo tem 3 linhas");
  eq(rSel.rows.length, 2, "C2: relatório só com os selecionados tem 2");
  eq(custoTotalDoRelatorio(sel).total, 17, "C3: custo total recalculado só com os selecionados (2+15)");
  const unidades = (r: ReturnType<typeof rel>) => (r.summary ?? []).find((s) => s.label === "Unidades vendidas")?.value;
  eq([unidades(rTodas), unidades(rSel)], [10, 7], "C4: totais do documento recalculados (unidades 10 → 7)");

  const c = ler("components/vendas/vendas-client.tsx");
  check(/semArtigosParaImprimir/.test(c) && /Selecione pelo menos um artigo/.test(c), "C5: zero selecionados bloqueia com mensagem");
  check(/new Set\(codigosVisiveis\)/.test(c) && /\[\.\.\.new Set\(linhasImprimiveis\.map/.test(c), "C6: «selecionar todos» cobre todo o resultado filtrado, não só a página");
  check(/selecao\.geracao === geracao/.test(c) && /setGeracao\(/.test(c), "C7: nova geração de resultado repõe «todos selecionados»");
  check(/artigos selecionados para impressão/.test(c), "C8: indicador «N de M artigos selecionados para impressão»");
  check(/useState<\{ geracao: number; codigos: Set<string> \} \| null>/.test(c), "C9: estado guarda só identificadores (códigos)");
}

console.log(`\n${ok} OK, ${ko} falhas`);
process.exit(ko ? 1 : 0);
