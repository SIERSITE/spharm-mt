/**
 * scripts/tests/test-catalogo-filtro-laboratorio.ts
 *
 * Testa a lógica PURA do filtro unificado "Laboratório ou grupo" em
 * lib/catalog/laboratorio-filtro.ts — reescrito em 2026-09-24 depois da
 * correcção de UX: um fabricante integralmente associado a um grupo
 * (ex.: "Mylan") deixa de ser ESCONDIDO — aparece sempre como a sua
 * própria opção, o grupo aparece ADICIONALMENTE. `pesquisarLaboratorios`
 * também passou a ORDENAR os resultados (grupo primeiro só quando a
 * pesquisa bate exactamente com o nome do grupo; fabricantes primeiro
 * nos restantes casos).
 *
 * Corre com: npx tsx scripts/tests/test-catalogo-filtro-laboratorio.ts
 */
import { readFileSync } from "node:fs";
import {
  descricaoAlcanceLaboratorio,
  nomeDeLaboratorio,
  parseValorLaboratorio,
  pesquisarLaboratorios,
  resolverFiltroLaboratorioWhere,
  rotuloTipoLaboratorio,
  valorDeLaboratorio,
  type CatalogoFilterOptionLaboratorio,
} from "../../lib/catalog/laboratorio-filtro";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const eq = <T,>(a: T, b: T, label: string) =>
  check(JSON.stringify(a) === JSON.stringify(b), label, `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);

// Fixture realista — espelha os exemplos reais do pedido (Mylan/Upjohn/
// Viatris, Alfa Wassermann/Biosaúde/Alfasigma, Ratiopharm/Teva,
// Pentafarma/Tecnimede, JNTL/Kenvue), incluindo Janssen (NUNCA associado
// a Kenvue) e Pfizer (sem grupo nenhum).
const LABORATORIOS: CatalogoFilterOptionLaboratorio[] = [
  { tipo: "grupo", id: "gViatris", nome: "Viatris", termosBusca: ["Mylan", "Upjohn", "MYLAN LDA", "MYLAN PHARMACEUTICALS LIMITED", "UPJOHN EESV"], resumoAlcance: ["Viatris", "Mylan", "Upjohn"], produtos: 808 },
  { tipo: "fabricante", id: "fMylanLda", nomeNormalizado: "MYLAN LDA", produtos: 604 },
  { tipo: "fabricante", id: "fMylanPharma", nomeNormalizado: "MYLAN PHARMACEUTICALS LIMITED", produtos: 12 },
  { tipo: "fabricante", id: "fUpjohn", nomeNormalizado: "UPJOHN EESV", produtos: 45 },
  { tipo: "fabricante", id: "fViatrisPropria", nomeNormalizado: "VIATRIS", produtos: 3 },

  { tipo: "grupo", id: "gAlfasigma", nome: "Alfasigma", termosBusca: ["Alfa Wassermann", "Biosaúde", "ALFA WASSERMANN – PRODUTOS FARMACÊUTICOS, LDA", "BIOSAUDE - PROD FARM LDA"], resumoAlcance: ["Alfasigma", "Alfa Wassermann", "Biosaúde"], produtos: 150 },
  { tipo: "fabricante", id: "fAlfaWassermann", nomeNormalizado: "ALFA WASSERMANN – PRODUTOS FARMACÊUTICOS, LDA", produtos: 40 },
  { tipo: "fabricante", id: "fBiosaude", nomeNormalizado: "BIOSAUDE - PROD FARM LDA", produtos: 10 },
  { tipo: "fabricante", id: "fAlfasigmaPortugal", nomeNormalizado: "ALFASIGMA PORTUGAL, LDA", produtos: 60 },
  { tipo: "fabricante", id: "fAlfasigmaSpa", nomeNormalizado: "ALFASIGMA S.P.A.", produtos: 20 },

  { tipo: "grupo", id: "gTeva", nome: "Teva", termosBusca: ["Ratiopharm"], resumoAlcance: ["Teva", "Ratiopharm"], produtos: 500 },
  { tipo: "fabricante", id: "fRatiopharm", nomeNormalizado: "RATIOPHARM GMBH", produtos: 20 },

  { tipo: "grupo", id: "gTecnimede", nome: "Tecnimede", termosBusca: ["Pentafarma"], resumoAlcance: ["Tecnimede", "Pentafarma"], produtos: 476 },
  { tipo: "fabricante", id: "fPentafarma", nomeNormalizado: "PENTAFARMA - SOCIEDADE TECNICO-MEDICINAL", produtos: 100 },

  { tipo: "grupo", id: "gKenvue", nome: "Kenvue", termosBusca: ["JNTL Consumer Health", "JNTL CONSUMER HEALTH PORTUGAL LIMITADA"], resumoAlcance: ["Kenvue", "JNTL Consumer Health"], produtos: 312 },
  { tipo: "fabricante", id: "fJntl", nomeNormalizado: "JNTL CONSUMER HEALTH PORTUGAL LIMITADA", produtos: 200 },

  // Janssen — NUNCA integrado em Kenvue: nenhum termosBusca de Kenvue o refere, e só existe como fabricante próprio.
  { tipo: "fabricante", id: "fJanssenCilag", nomeNormalizado: "JANSSEN-CILAG FARMACEUTICA", produtos: 80 },
  { tipo: "fabricante", id: "fJanssenFarm", nomeNormalizado: "JANSSEN FARMACEUTICA PORTUGAL", produtos: 30 },

  // Pfizer — sem grupo nenhum, fabricante independente.
  { tipo: "fabricante", id: "fPfizer", nomeNormalizado: "LABORATORIOS PFIZER", produtos: 90 },
];

console.log("A · pesquisar 'Mylan': fabricantes Mylan reais E o grupo Viatris, tipos distintos, fabricantes PRIMEIRO");
{
  const resultado = pesquisarLaboratorios(LABORATORIOS, "Mylan");
  const fabricantesMylan = resultado.filter((o) => o.tipo === "fabricante" && o.nomeNormalizado.includes("MYLAN"));
  const grupoViatris = resultado.find((o) => o.tipo === "grupo" && o.nome === "Viatris");
  check(fabricantesMylan.length >= 2, "A1: pelo menos 2 fabricantes Mylan reais (MYLAN LDA, MYLAN PHARMACEUTICALS LIMITED)", `encontrados: ${fabricantesMylan.length}`);
  check(!!grupoViatris, "A2: o grupo Viatris está presente");
  check(new Set(resultado.map((o) => o.tipo)).size === 2, "A3: tipos distintos (grupo E fabricante) nos resultados");
  const idxPrimeiroFabricante = resultado.findIndex((o) => o.tipo === "fabricante");
  const idxGrupo = resultado.findIndex((o) => o.tipo === "grupo");
  check(idxPrimeiroFabricante < idxGrupo, "A4: fabricantes aparecem ANTES do grupo (pesquisa não bate exactamente com o nome do grupo)");
}

console.log("\nB · seleccionar fabricante Mylan LDA — resolverFiltroLaboratorioWhere aponta só para esse fabricanteId");
{
  const opcao = LABORATORIOS.find((o) => o.tipo === "fabricante" && o.nomeNormalizado === "MYLAN LDA")!;
  const where = resolverFiltroLaboratorioWhere(valorDeLaboratorio(opcao));
  eq(where, { fabricanteId: "fMylanLda" }, "B1: where filtra exclusivamente por este fabricanteId — nunca inclui Upjohn nem produtos só-Viatris");
}

console.log("\nC · seleccionar grupo Viatris — resolverFiltroLaboratorioWhere aponta para a relação do grupo (Mylan+Upjohn+Viatris+regras CNP, nunca propostas pendentes)");
{
  const where = resolverFiltroLaboratorioWhere("grupo:gViatris");
  eq(where, { grupoLaboratorial: { grupoLaboratorialId: "gViatris" } }, "C1: where filtra pela relação ProdutoGrupoLaboratorial — só produtos DEFINITIVAMENTE associados (nunca propostas pendentes, que nunca escrevem essa linha)");
}

console.log("\nD · pesquisar 'Upjohn' devolve o fabricante Upjohn E o grupo Viatris");
{
  const resultado = pesquisarLaboratorios(LABORATORIOS, "Upjohn");
  check(resultado.some((o) => o.tipo === "fabricante" && o.nomeNormalizado === "UPJOHN EESV"), "D1: fabricante UPJOHN EESV presente");
  check(resultado.some((o) => o.tipo === "grupo" && o.nome === "Viatris"), "D2: grupo Viatris presente");
}

console.log("\nE · pesquisar 'Alfa Wassermann' devolve o fabricante E o grupo Alfasigma");
{
  const resultado = pesquisarLaboratorios(LABORATORIOS, "Alfa Wassermann");
  check(resultado.some((o) => o.tipo === "fabricante" && o.nomeNormalizado.includes("ALFA WASSERMANN")), "E1: fabricante Alfa Wassermann presente");
  check(resultado.some((o) => o.tipo === "grupo" && o.nome === "Alfasigma"), "E2: grupo Alfasigma presente");
  const idxFab = resultado.findIndex((o) => o.tipo === "fabricante");
  const idxGrupo = resultado.findIndex((o) => o.tipo === "grupo");
  check(idxFab < idxGrupo, "E3: fabricante Alfa Wassermann aparece ANTES do grupo (não é o nome exacto do grupo)");
}

console.log("\nF · seleccionar fabricante Alfa Wassermann devolve APENAS esse fabricante");
{
  const where = resolverFiltroLaboratorioWhere("fabricante:fAlfaWassermann");
  eq(where, { fabricanteId: "fAlfaWassermann" }, "F1: where filtra só por este fabricanteId, nunca por Biosaúde nem Alfasigma Portugal/S.P.A.");
}

console.log("\nG · seleccionar grupo Alfasigma inclui Alfa Wassermann, Biosaúde e Alfasigma — via a MESMA relação de grupo");
{
  const opcao = LABORATORIOS.find((o) => o.tipo === "grupo" && o.nome === "Alfasigma")!;
  check(opcao.tipo === "grupo" && opcao.resumoAlcance.includes("Alfa Wassermann") && opcao.resumoAlcance.includes("Biosaúde"), "G1: resumoAlcance inclui Alfa Wassermann e Biosaúde");
  eq(resolverFiltroLaboratorioWhere(valorDeLaboratorio(opcao)), { grupoLaboratorial: { grupoLaboratorialId: "gAlfasigma" } }, "G2: where é a relação do grupo inteiro — Alfa Wassermann, Biosaúde e Alfasigma Portugal/S.P.A. (todos integrais) ficam incluídos por construção");
}

console.log("\nH · pesquisar 'Viatris' — o grupo aparece PRIMEIRO (bate exactamente com o nome do grupo), fabricantes Viatris/Mylan/Upjohn depois");
{
  const resultado = pesquisarLaboratorios(LABORATORIOS, "Viatris");
  check(resultado[0]?.tipo === "grupo" && resultado[0].nome === "Viatris", "H1: o grupo Viatris é o primeiro resultado");
  const idxGrupo = resultado.findIndex((o) => o.tipo === "grupo");
  const fabricantesDepois = resultado.slice(idxGrupo + 1).every((o) => o.tipo === "fabricante");
  check(fabricantesDepois, "H2: só fabricantes depois do grupo");
}

console.log("\nI · pesquisar 'Alfasigma' — grupo primeiro, fabricantes Alfasigma Portugal/S.P.A. depois");
{
  const resultado = pesquisarLaboratorios(LABORATORIOS, "Alfasigma");
  check(resultado[0]?.tipo === "grupo" && resultado[0].nome === "Alfasigma", "I1: grupo Alfasigma primeiro");
  check(resultado.some((o) => o.tipo === "fabricante" && o.nomeNormalizado === "ALFASIGMA PORTUGAL, LDA"), "I2: ALFASIGMA PORTUGAL, LDA presente como fabricante");
  check(resultado.some((o) => o.tipo === "fabricante" && o.nomeNormalizado === "ALFASIGMA S.P.A."), "I3: ALFASIGMA S.P.A. presente como fabricante");
}

console.log("\nJ · pesquisar 'Janssen' NUNCA apresenta Kenvue como grupo relacionado");
{
  const resultado = pesquisarLaboratorios(LABORATORIOS, "Janssen");
  check(resultado.length >= 2, "J1: encontra os fabricantes Janssen reais");
  check(resultado.every((o) => o.tipo === "fabricante"), "J2: NENHUM resultado é um grupo — Janssen nunca aparece associado a Kenvue nem a nenhum outro grupo");
  check(!resultado.some((o) => o.tipo === "grupo"), "J3: confirmação explícita — zero grupos nos resultados de 'Janssen'");
}

console.log("\nK · Ratiopharm/Teva e Pentafarma/Tecnimede seguem a mesma regra (fabricante + grupo, tipos distintos)");
{
  const r1 = pesquisarLaboratorios(LABORATORIOS, "Ratiopharm");
  check(r1.some((o) => o.tipo === "fabricante" && o.nomeNormalizado.includes("RATIOPHARM")), "K1: fabricante Ratiopharm presente");
  check(r1.some((o) => o.tipo === "grupo" && o.nome === "Teva"), "K2: grupo Teva presente");

  const r2 = pesquisarLaboratorios(LABORATORIOS, "Pentafarma");
  check(r2.some((o) => o.tipo === "fabricante" && o.nomeNormalizado.includes("PENTAFARMA")), "K3: fabricante Pentafarma presente");
  check(r2.some((o) => o.tipo === "grupo" && o.nome === "Tecnimede"), "K4: grupo Tecnimede presente");
}

console.log("\nL · resultados mistos de grupo + fabricante nunca têm duplicados (chaves valorDeLaboratorio únicas)");
{
  for (const termo of ["Mylan", "Alfa Wassermann", "Viatris", "Alfasigma", "Ratiopharm", "Pentafarma", "JNTL"]) {
    const resultado = pesquisarLaboratorios(LABORATORIOS, termo);
    const valores = resultado.map(valorDeLaboratorio);
    eq(new Set(valores).size, valores.length, `L1 (query="${termo}"): sem valores duplicados`);
  }
}

console.log("\nM · resolverFiltroLaboratorioWhere — casos base inalterados");
{
  eq(resolverFiltroLaboratorioWhere(undefined), null, "M1: undefined → null (sem filtro)");
  eq(resolverFiltroLaboratorioWhere(""), null, "M2: string vazia → null");
  eq(resolverFiltroLaboratorioWhere("grupo:g1"), { grupoLaboratorial: { grupoLaboratorialId: "g1" } }, "M3: grupo:<id>");
  eq(resolverFiltroLaboratorioWhere("fabricante:f1"), { fabricanteId: "f1" }, "M4: fabricante:<id>");
  eq(resolverFiltroLaboratorioWhere("abc123"), { fabricanteId: "abc123" }, "M5: sem prefixo (link antigo) tratado como fabricanteId directo — comportamento pré-existente preservado");
  eq(resolverFiltroLaboratorioWhere("grupo:"), null, "M6: 'grupo:' vazio → null, não um where quebrado");
}

console.log("\nN · parseValorLaboratorio — nunca infere o tipo pelo texto, só pelo prefixo explícito");
{
  eq(parseValorLaboratorio("grupo:g1"), { tipo: "grupo", id: "g1" }, "N1: grupo:<id>");
  eq(parseValorLaboratorio("fabricante:f1"), { tipo: "fabricante", id: "f1" }, "N2: fabricante:<id>");
  eq(parseValorLaboratorio("Viatris"), null, "N3: texto puro (nome de exibição) nunca é interpretado como um tipo — null");
  eq(parseValorLaboratorio("grupo:"), null, "N4: prefixo sem id → null");
  eq(parseValorLaboratorio(""), null, "N5: string vazia → null");
}

console.log("\nO · filtro activo — 'Fabricante: X' / 'Grupo: Y', nunca inferido do texto");
{
  const fab = LABORATORIOS.find((o) => o.tipo === "fabricante" && o.nomeNormalizado === "MYLAN LDA")!;
  const grp = LABORATORIOS.find((o) => o.tipo === "grupo" && o.nome === "Viatris")!;
  eq(`${rotuloTipoLaboratorio(fab)}: ${nomeDeLaboratorio(fab)}`, "Fabricante: MYLAN LDA", "O1: rótulo de fabricante");
  eq(`${rotuloTipoLaboratorio(grp)}: ${nomeDeLaboratorio(grp)}`, "Grupo: Viatris", "O2: rótulo de grupo");
}

console.log("\nP · descricaoAlcanceLaboratorio — contagens e alcance, sem uma query por opção (dados já vêm agregados)");
{
  const fab = LABORATORIOS.find((o) => o.tipo === "fabricante" && o.nomeNormalizado === "MYLAN LDA")!;
  eq(descricaoAlcanceLaboratorio(fab), "Fabricante · 604 produtos", "P1: fabricante — só o tipo e a contagem");
  const grp = LABORATORIOS.find((o) => o.tipo === "grupo" && o.nome === "Viatris")!;
  eq(descricaoAlcanceLaboratorio(grp), "Grupo · inclui Viatris, Mylan e Upjohn · 808 produtos", "P2: grupo — 'inclui X, Y e Z' com junção Oxford-like");
}

console.log("\nQ · query vazia devolve a lista inteira, ordenada alfabeticamente (estado inicial do dropdown)");
{
  const resultado = pesquisarLaboratorios(LABORATORIOS, "");
  eq(resultado.length, LABORATORIOS.length, "Q1: lista completa");
}

console.log("\nR · fallback para fabricante sem grupo (Pfizer) — continua encontrável, nunca aparece com um grupo");
{
  const resultado = pesquisarLaboratorios(LABORATORIOS, "Pfizer");
  eq(resultado.length, 1, "R1: 1 resultado — Pfizer não tem grupo");
  eq(resultado[0]?.tipo, "fabricante", "R2: é mesmo o fabricante, não um grupo");
}

console.log("\nS · isolamento: outros tenants (sem nenhum grupo na lista) mantêm o <select> nativo original — o combobox pesquisável nunca aparece para eles");
{
  const src = readFileSync(new URL("../../components/catalogo/catalogo-list-client.tsx", import.meta.url), "utf8");
  check(
    /laboratorios\.some\(\(l\) => l\.tipo === "grupo"\)/.test(src),
    "S1: a escolha entre o combobox pesquisável e o <select> nativo depende de existir pelo menos um grupo na lista — nunca é ligado incondicionalmente para todos os tenants",
  );
  const idxSome = src.indexOf('laboratorios.some((l) => l.tipo === "grupo")');
  const idxSearchSelect = src.indexOf("<LaboratorioSearchSelect", idxSome);
  const idxPlainSelect = src.indexOf("<SelectFilter", idxSome);
  check(
    idxSome !== -1 && idxSearchSelect !== -1 && idxPlainSelect !== -1 && idxSearchSelect < idxPlainSelect,
    "S2: o combobox pesquisável é o ramo 'com grupos', o <select> simples é o ramo 'sem grupos' (nenhum dos dois falta)",
  );
}

console.log(`\n${ok} ok, ${ko} falhas`);
process.exit(ko === 0 ? 0 : 1);
