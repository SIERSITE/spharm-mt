/**
 * scripts/tests/test-catalogo-filtro-laboratorio.ts
 *
 * Testa a lógica PURA do filtro unificado de laboratório em
 * lib/catalogo-data.ts: pesquisarLaboratorios (escrever "Mylan" devolve
 * só "Viatris", nunca as duas) e resolverFiltroLaboratorioWhere (grupo
 * vs. fabricante vs. link antigo sem prefixo).
 *
 * Corre com: npx tsx scripts/tests/test-catalogo-filtro-laboratorio.ts
 */
import { readFileSync } from "node:fs";
import { pesquisarLaboratorios, resolverFiltroLaboratorioWhere, type CatalogoFilterOptionLaboratorio } from "../../lib/catalog/laboratorio-filtro";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const eq = <T,>(a: T, b: T, label: string) =>
  check(JSON.stringify(a) === JSON.stringify(b), label, `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);

const LABORATORIOS: CatalogoFilterOptionLaboratorio[] = [
  { tipo: "grupo", id: "gViatris", nome: "Viatris", termosBusca: ["Mylan", "Upjohn"] },
  { tipo: "grupo", id: "gAlfasigma", nome: "Alfasigma", termosBusca: ["Alfa Wassermann", "Biosaúde"] },
  { tipo: "fabricante", id: "fPfizer", nomeNormalizado: "LABORATORIOS PFIZER" }, // sem grupo — fallback
  { tipo: "fabricante", id: "fBayer", nomeNormalizado: "BAYER PORTUGAL LDA" }, // sem grupo — fallback
];

console.log("A · escrever 'Mylan' devolve uma ÚNICA opção: Viatris — nunca Mylan como opção à parte");
{
  const resultado = pesquisarLaboratorios(LABORATORIOS, "Mylan");
  eq(resultado.length, 1, "A1: exactamente 1 resultado");
  eq(resultado[0]?.tipo === "grupo" ? resultado[0].nome : null, "Viatris", "A2: é o grupo Viatris");
  check(!resultado.some((o) => o.tipo === "fabricante" && o.nomeNormalizado.includes("MYLAN")), "A3: nenhuma opção 'Mylan' à parte — não existe como entrada própria");
}

console.log("\nB · escrever 'Upjohn' — mesmo grupo, mesmo resultado único");
{
  const resultado = pesquisarLaboratorios(LABORATORIOS, "Upjohn");
  eq(resultado.length, 1, "B1: 1 resultado");
  check(resultado[0]?.tipo === "grupo" && resultado[0].nome === "Viatris", "B2: Viatris");
}

console.log("\nC · escrever 'Viatris' — encontra o próprio grupo pelo nome");
{
  const resultado = pesquisarLaboratorios(LABORATORIOS, "Viatris");
  eq(resultado.length, 1, "C1: 1 resultado");
  check(resultado[0]?.tipo === "grupo" && resultado[0].nome === "Viatris", "C2: Viatris");
}

console.log("\nD · MYLAN e VIATRIS nunca aparecem SIMULTANEAMENTE como opções concorrentes, para nenhuma pesquisa");
{
  for (const termo of ["", "V", "M", "Mylan", "Viatris", "a"]) {
    const resultado = pesquisarLaboratorios(LABORATORIOS, termo);
    const temMylanComoOpcao = resultado.some((o) => o.tipo === "fabricante" && o.nomeNormalizado.includes("MYLAN"));
    const temViatris = resultado.some((o) => o.tipo === "grupo" && o.nome === "Viatris");
    check(!(temMylanComoOpcao && temViatris), `D1 (query="${termo}"): nunca as duas em simultâneo (Mylan nem sequer existe como opção)`);
  }
}

console.log("\nE · outros exemplos confirmados (Alfasigma) seguem a mesma regra");
{
  const r1 = pesquisarLaboratorios(LABORATORIOS, "Alfa Wassermann");
  eq(r1.length, 1, "E1: 1 resultado");
  check(r1[0]?.tipo === "grupo" && r1[0].nome === "Alfasigma", "E2: Alfasigma");
  const r2 = pesquisarLaboratorios(LABORATORIOS, "Biosaúde");
  check(r2[0]?.tipo === "grupo" && r2[0].nome === "Alfasigma", "E3: Biosaúde também resolve para Alfasigma");
}

console.log("\nF · query vazia devolve a lista inteira (estado inicial do dropdown)");
{
  eq(pesquisarLaboratorios(LABORATORIOS, "").length, LABORATORIOS.length, "F1: lista completa");
}

console.log("\nG · fallback para fabricante sem grupo — continua encontrável, sem duplicação");
{
  const resultado = pesquisarLaboratorios(LABORATORIOS, "Pfizer");
  eq(resultado.length, 1, "G1: 1 resultado — Pfizer não tem grupo, aparece como fabricante próprio (fallback controlado)");
  eq(resultado[0]?.tipo, "fabricante", "G2: é mesmo o fabricante, não um grupo");
}

console.log("\nH · resolverFiltroLaboratorioWhere");
{
  eq(resolverFiltroLaboratorioWhere(undefined), null, "H1: undefined → null (sem filtro)");
  eq(resolverFiltroLaboratorioWhere(""), null, "H2: string vazia → null");
  eq(resolverFiltroLaboratorioWhere("grupo:g1"), { grupoLaboratorial: { grupoLaboratorialId: "g1" } }, "H3: grupo:<id>");
  eq(resolverFiltroLaboratorioWhere("fabricante:f1"), { fabricanteId: "f1" }, "H4: fabricante:<id>");
  eq(resolverFiltroLaboratorioWhere("abc123"), { fabricanteId: "abc123" }, "H5: sem prefixo (link antigo) tratado como fabricanteId directo — comportamento pré-existente preservado");
  eq(resolverFiltroLaboratorioWhere("grupo:"), null, "H6: 'grupo:' vazio → null, não um where quebrado");
}

console.log("\nI · isolamento: outros tenants (sem nenhum grupo na lista) mantêm o <select> nativo original — o combobox pesquisável nunca aparece para eles");
{
  const src = readFileSync(new URL("../../components/catalogo/catalogo-list-client.tsx", import.meta.url), "utf8");
  check(
    /laboratorios\.some\(\(l\) => l\.tipo === "grupo"\)/.test(src),
    "I1: a escolha entre o combobox pesquisável e o <select> nativo depende de existir pelo menos um grupo na lista — nunca é ligado incondicionalmente para todos os tenants",
  );
  const idxSome = src.indexOf('laboratorios.some((l) => l.tipo === "grupo")');
  const idxSearchSelect = src.indexOf("<LaboratorioSearchSelect", idxSome);
  const idxPlainSelect = src.indexOf("<SelectFilter", idxSome);
  check(
    idxSome !== -1 && idxSearchSelect !== -1 && idxPlainSelect !== -1 && idxSearchSelect < idxPlainSelect,
    "I2: o combobox pesquisável é o ramo 'com grupos', o <select> simples é o ramo 'sem grupos' (nenhum dos dois falta)",
  );
}

console.log(`\n${ok} ok, ${ko} falhas`);
process.exit(ko === 0 ? 0 : 1);
