/**
 * scripts/tests/test-lista-codigos.ts
 *
 * A lista de CNP importada por ficheiro tem de significar EXACTAMENTE o
 * mesmo nos Relatórios e nas Encomendas.
 *
 * ── O que isto existe para impedir ───────────────────────────────────
 *
 * Três falhas concretas, e nenhuma delas dá erro:
 *
 *   A. `[]` tratado como "sem filtro". O utilizador importa 500 códigos
 *      de que nenhum existe, e em vez de um relatório vazio recebe o
 *      catálogo inteiro — 30 000 artigos onde pediu zero. Nada na UI
 *      diz que o filtro não se aplicou.
 *
 *   B. Os dois módulos divergirem. O mesmo ficheiro a dar 437 produtos
 *      num relatório e 431 numa encomenda, porque um deles ganhou uma
 *      cópia local do parser ou da resolução. É o defeito que a
 *      Secção E vigia por INSPECÇÃO DO CÓDIGO, e não por comportamento:
 *      quando o comportamento diverge já é tarde.
 *
 *   C. O parser aceitar o que não é código. Uma linha
 *      "1234567 Paracetamol 500mg 2" que devolva quatro entradas
 *      envenena a lista com três CNP inexistentes — que depois aparecem
 *      como "não encontrados" e mandam o utilizador procurar um erro de
 *      digitação que não existe.
 *
 * Corre com:  npm run test:lista-codigos
 */
import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import {
  MAX_CODIGOS,
  MIN_DIGITOS_CODIGO,
  temListaCodigos,
} from "../../lib/produtos/lista-codigos-tipos";
import {
  encontrarColunaCodigo,
  ListaCodigosParseError,
  normalizarCabecalho,
  normalizarCodigo,
  parseListaCodigos,
  parseListaExcel,
  parseListaTxt,
} from "../../lib/produtos/lista-codigos";
import { resolverListaCodigos } from "../../lib/produtos/resolver-lista-codigos";
import {
  restringirPorCatalogo,
  temFiltroCatalogo,
} from "../../lib/reporting/catalog-prefilter";
import { filtroListaImportada } from "../../lib/reporting/filters-shared";
import type { PrismaClient } from "../../generated/prisma/client";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) {
    ok++;
    console.log(`  [OK]    ${label}`);
  } else {
    ko++;
    console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`);
  }
};
const eq = (a: unknown, b: unknown, label: string) =>
  check(
    JSON.stringify(a) === JSON.stringify(b),
    label,
    `esperado ${JSON.stringify(b)}, obtido ${JSON.stringify(a)}`,
  );

// Este ficheiro compila para CommonJS: sem top-level await.
async function main(): Promise<void> {

// ─────────────────────────────────────────────────────────────────────
// A. Normalização de um código
// ─────────────────────────────────────────────────────────────────────
console.log("\nA. Normalização de um código\n");

eq(normalizarCodigo("5719422"), "5719422", "CNP simples passa");
eq(normalizarCodigo("  5719422  "), "5719422", "espaços à volta são aparados");
eq(normalizarCodigo('"5719422"'), "5719422", "aspas do CSV são removidas");
eq(normalizarCodigo("'5719422"), "5719422", "prefixo de texto do Excel é removido");

// Os zeros à esquerda: o pedido pedia que não se perdesse o valor, e é
// isso que acontece — o VALOR é o mesmo produto. `Produto.cnp` é Int.
eq(normalizarCodigo("0571942"), "571942", "zeros à esquerda caem (cnp é Int)");
eq(normalizarCodigo("0000000123"), null, "«0000000123» vale 123 — 3 dígitos, cai");

// A fronteira que resolve a ambiguidade do espaço.
eq(normalizarCodigo("2"), null, "1 dígito não é código");
eq(normalizarCodigo("500"), null, `${MIN_DIGITOS_CODIGO - 1} dígitos não é código`);
eq(normalizarCodigo("1000"), "1000", `${MIN_DIGITOS_CODIGO} dígitos é código`);
eq(normalizarCodigo("1234567890123"), null, "13 dígitos é demasiado");

eq(normalizarCodigo("500mg"), null, "alfanumérico não é código");
eq(normalizarCodigo("Paracetamol"), null, "texto não é código");
eq(normalizarCodigo(""), null, "vazio não é código");
eq(normalizarCodigo(null), null, "null não é código");
eq(normalizarCodigo("57.194,22"), null, "número formatado não é código");
eq(normalizarCodigo("-5719422"), null, "negativo não é código");

// ─────────────────────────────────────────────────────────────────────
// B. Parser TXT
// ─────────────────────────────────────────────────────────────────────
console.log("\nB. Parser TXT\n");

// O caso do enunciado.
{
  const r = parseListaTxt("1234567\n7654321\n5555555");
  eq(r.codigos, ["1234567", "7654321", "5555555"], "um por linha");
  eq(r.totalLidos, 3, "totalLidos = 3");
  eq(r.duplicados, 0, "sem duplicados");
}

// Separadores.
eq(parseListaTxt("1234567;7654321;5555555").codigos, ["1234567", "7654321", "5555555"], "ponto e vírgula");
eq(parseListaTxt("1234567,7654321,5555555").codigos, ["1234567", "7654321", "5555555"], "vírgula");
eq(parseListaTxt("1234567\t7654321\t5555555").codigos, ["1234567", "7654321", "5555555"], "tabulação");
eq(parseListaTxt("1234567 7654321 5555555").codigos, ["1234567", "7654321", "5555555"], "espaços, linha só de códigos");
eq(
  parseListaTxt("1234567;7654321\n5555555,1111111\n2222222\t3333333").codigos,
  ["1234567", "7654321", "5555555", "1111111", "2222222", "3333333"],
  "separadores misturados entre linhas",
);

// Ruído estrutural.
eq(parseListaTxt("1234567\n\n\n7654321\n   \n").codigos, ["1234567", "7654321"], "linhas vazias ignoradas");
eq(parseListaTxt("1234567\r\n7654321\r\n").codigos, ["1234567", "7654321"], "CRLF do Windows");
eq(parseListaTxt("﻿1234567\n7654321").codigos, ["1234567", "7654321"], "BOM do Notepad");

// Duplicados.
{
  const r = parseListaTxt("1234567\n7654321\n1234567\n1234567");
  eq(r.codigos, ["1234567", "7654321"], "duplicados removidos");
  eq(r.totalLidos, 4, "totalLidos conta as repetições");
  eq(r.duplicados, 2, "duplicados = 2");
}

// ── A ambiguidade do espaço ──────────────────────────────────────────
//
// É aqui que a funcionalidade se estraga ou não. As três linhas seguintes
// são as que uma farmácia produz de verdade.
{
  const r = parseListaTxt("1234567 Paracetamol 500mg 2");
  eq(r.codigos, ["1234567"], "código à cabeça + designação → só o código");
  check(r.ignorados.includes("500mg"), "o resto vai para ignorados");
  check(!r.codigos.includes("500"), "«500» NÃO passa a CNP");
}
eq(
  parseListaTxt("1234567;Paracetamol 500mg;2").codigos,
  ["1234567"],
  "CSV sem cabeçalho → primeiro campo válido",
);
eq(
  parseListaTxt("Artigos em falta\n1234567\n7654321").codigos,
  ["1234567", "7654321"],
  "título na primeira linha não trava o resto",
);

// ── O caso que só o cabeçalho resolve ────────────────────────────────
//
// Sem detecção de cabeçalho, a quantidade de 4 dígitos entrava como CNP
// pela regra dos campos — e ninguém repararia.
{
  const r = parseListaTxt("CNP;Designacao;Quantidade\n1234567;Paracetamol;1200\n7654321;Ibuprofeno;3400");
  eq(r.codigos, ["1234567", "7654321"], "cabeçalho fixa a coluna; quantidades NÃO entram");
  eq(r.coluna, "CNP", "coluna reconhecida é reportada");
}
eq(
  parseListaTxt("Código Produto,Designação\n1234567,Paracetamol\n7654321,Ibuprofeno").codigos,
  ["1234567", "7654321"],
  "cabeçalho com acento e espaço",
);
eq(
  parseListaTxt("Designacao;CNP\nParacetamol;1234567\nIbuprofeno;7654321").codigos,
  ["1234567", "7654321"],
  "coluna de código não tem de ser a primeira",
);

// Ficheiro sem nada de útil.
eq(parseListaTxt("").codigos, [], "ficheiro vazio → nenhum código");
eq(parseListaTxt("sem nada de útil aqui").codigos, [], "só texto → nenhum código");

// ─────────────────────────────────────────────────────────────────────
// C. Cabeçalhos
// ─────────────────────────────────────────────────────────────────────
console.log("\nC. Cabeçalhos\n");

eq(normalizarCabecalho("Código Produto"), "codigoproduto", "acentos e espaços caem");
eq(normalizarCabecalho("CNP/Código"), "cnpcodigo", "barra cai");
eq(normalizarCabecalho("  CNP  "), "cnp", "espaços caem");

for (const h of ["CNP", "Código", "Codigo", "Código Produto", "CodigoProduto", "CNP/Código", "cod"]) {
  check(encontrarColunaCodigo([h]) === 0, `«${h}» é reconhecido como coluna de código`);
}
// O que fica DE FORA, e porquê: num mapa de compras «Referência» é a
// referência do fornecedor. Aceitá-la daria uma lista inteira de códigos
// inexistentes, plausível o bastante para ninguém desconfiar.
eq(encontrarColunaCodigo(["Referência"]), null, "«Referência» NÃO é reconhecida");
eq(encontrarColunaCodigo(["Designação", "PVP"]), null, "linha sem coluna de código");
eq(encontrarColunaCodigo(["Designação", "CNP", "PVP"]), 1, "índice correcto no meio");

// ─────────────────────────────────────────────────────────────────────
// D. Parser Excel
// ─────────────────────────────────────────────────────────────────────
console.log("\nD. Parser Excel\n");

function livro(folhas: Record<string, unknown[][]>): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [nome, aoa] of Object.entries(folhas)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), nome);
  }
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

{
  const buf = livro({ Folha1: [["CNP", "Designação"], [1234567, "Paracetamol"], [7654321, "Ibuprofeno"]] });
  const r = parseListaExcel(buf);
  eq(r.codigos, ["1234567", "7654321"], "cabeçalho CNP reconhecido");
  eq(r.folha, "Folha1", "folha reportada");
  eq(r.coluna, "CNP", "coluna reportada");
}

{
  // A coluna «Quantidade» tem valores de 4 dígitos. Sem a fixação por
  // cabeçalho seriam códigos.
  const buf = livro({
    Dados: [["Designação", "Código Produto", "Quantidade"], ["Paracetamol", 1234567, 1200], ["Ibuprofeno", 7654321, 3400]],
  });
  eq(parseListaExcel(buf).codigos, ["1234567", "7654321"], "cabeçalho fixa a coluna, quantidades ficam de fora");
}

{
  // Uma única coluna preenchida, sem cabeçalho conhecido — era requisito
  // explícito ("aceitar essa coluna mesmo sem cabeçalho conhecido").
  const buf = livro({ Lista: [["1234567"], ["7654321"], ["5555555"]] });
  eq(parseListaExcel(buf).codigos, ["1234567", "7654321", "5555555"], "coluna única sem cabeçalho");
}

{
  // Células vazias e duplicados.
  const buf = livro({ L: [["CNP"], [1234567], [""], [null], [7654321], [1234567]] });
  const r = parseListaExcel(buf);
  eq(r.codigos, ["1234567", "7654321"], "células vazias ignoradas, duplicados removidos");
  eq(r.duplicados, 1, "duplicado contabilizado");
}

{
  // Primeira folha ÚTIL, não primeira folha.
  const buf = livro({ Vazia: [[]], Real: [["CNP"], [1234567]] });
  const r = parseListaExcel(buf);
  eq(r.folha, "Real", "salta a folha vazia");
  eq(r.codigos, ["1234567"], "lê a primeira folha com dados");
}

{
  // Ambiguidade genuína: duas colunas plausíveis e nenhum cabeçalho
  // conhecido. Atirar é melhor do que adivinhar — adivinhar dava uma
  // lista errada sem uma única mensagem.
  const buf = livro({ X: [["1234567", "9998887"], ["7654321", "9998886"]] });
  let atirou: string | null = null;
  try {
    parseListaExcel(buf);
  } catch (e) {
    atirou = e instanceof ListaCodigosParseError ? e.codigo : "erro-errado";
  }
  eq(atirou, "coluna_ambigua", "duas colunas de códigos sem cabeçalho → erro explícito");
}

// Despacho por extensão.
eq(parseListaCodigos("lista.txt", Buffer.from("1234567\n7654321")).origem, "txt", ".txt → parser de texto");
eq(parseListaCodigos("lista.csv", Buffer.from("1234567;7654321")).origem, "txt", ".csv → parser de texto");
eq(parseListaCodigos("lista.xlsx", livro({ A: [["CNP"], [1234567]] })).origem, "xlsx", ".xlsx → parser Excel");

// ─────────────────────────────────────────────────────────────────────
// E. Resolução contra o catálogo
// ─────────────────────────────────────────────────────────────────────
console.log("\nE. Resolução contra o catálogo\n");

/** Catálogo de teste. Só `cnp` interessa — é a chave única. */
const CATALOGO = [
  { id: "p-1", cnp: 1234567 },
  { id: "p-2", cnp: 7654321 },
  { id: "p-3", cnp: 5555555 },
  { id: "p-4", cnp: 571942 },
];

let consultas = 0;
const prismaFake = {
  produto: {
    findMany: async (args: { where: { cnp?: { in: number[] }; id?: { in: string[] } }; select: unknown }) => {
      consultas++;
      let univ = CATALOGO;
      if (args.where.cnp?.in) univ = univ.filter((p) => args.where.cnp!.in.includes(p.cnp));
      if (args.where.id?.in) univ = univ.filter((p) => args.where.id!.in.includes(p.id));
      return univ.map((p) => ({ id: p.id, cnp: p.cnp }));
    },
  },
} as unknown as PrismaClient;

{
  consultas = 0;
  const parseada = parseListaTxt("1234567\n7654321\n0000000\n9999999\n1234567");
  const r = await resolverListaCodigos(parseada, "lista.txt", prismaFake);
  eq(r.cnps, [1234567, 7654321], "só os que existem entram no filtro");
  eq(r.encontrados, 2, "encontrados = 2");
  eq(r.naoEncontrados, ["9999999"], "não encontrados na forma original");
  eq(r.duplicados, 1, "contabilidade do parse é preservada");
  eq(r.nomeFicheiro, "lista.txt", "nome do ficheiro preservado");
  eq(consultas, 1, "uma consulta, não uma por código");
}

{
  // Zeros à esquerda resolvem para o mesmo produto que o valor nu — e a
  // lista não fica com o CNP duas vezes.
  const r = await resolverListaCodigos(parseListaTxt("0571942\n571942"), "z.txt", prismaFake);
  eq(r.cnps, [571942], "«0571942» e «571942» são o mesmo produto");
  eq(r.naoEncontrados, [], "nenhum não-encontrado");
}

{
  // Nada existe: `cnps` fica vazio, e é ESTE caso que a Secção F vigia.
  const r = await resolverListaCodigos(parseListaTxt("9999991\n9999992"), "n.txt", prismaFake);
  eq(r.cnps, [], "nenhum encontrado → array vazio");
  eq(r.naoEncontrados, ["9999991", "9999992"], "todos reportados");
}

// ─────────────────────────────────────────────────────────────────────
// F. `[]` NÃO é "sem filtro"  ← a armadilha silenciosa
// ─────────────────────────────────────────────────────────────────────
console.log("\nF. Um array vazio significa NENHUM produto\n");

check(temListaCodigos(undefined) === false, "undefined → não há lista");
check(temListaCodigos(null) === false, "null → não há lista");
check(temListaCodigos([]) === true, "[] → HÁ lista (vazia), e tem de filtrar");
check(temListaCodigos([1234567]) === true, "não-vazio → há lista");

check(temFiltroCatalogo({}) === false, "sem cnps → o pré-filtro não corre");
check(temFiltroCatalogo({ cnps: [] }) === true, "com cnps vazio → o pré-filtro CORRE");
check(temFiltroCatalogo({ cnps: [1234567] }) === true, "com cnps → o pré-filtro corre");

{
  const r = await restringirPorCatalogo(prismaFake, { cnps: [] }, null);
  eq(r, [], "lista vazia → NENHUM produto (e não o catálogo inteiro)");
}
{
  const r = await restringirPorCatalogo(prismaFake, { cnps: [1234567, 5555555] }, null);
  eq(r, ["p-1", "p-3"], "lista com códigos → só esses produtos");
}
{
  // E lógico com uma restrição anterior (categoria, fabricante, …).
  const r = await restringirPorCatalogo(prismaFake, { cnps: [1234567, 5555555] }, ["p-3", "p-4"]);
  eq(r, ["p-3"], "intersecta com a restrição que já vinha");
}
{
  const r = await restringirPorCatalogo(prismaFake, { cnps: [9999999] }, null);
  eq(r, [], "lista com códigos inexistentes → nenhum produto");
}

// O cabeçalho do relatório exportado tem de dizer que houve lista.
eq(filtroListaImportada(undefined), null, "sem lista → sem linha no cabeçalho");
eq(
  filtroListaImportada([1, 2, 3])?.label,
  "Lista importada",
  "com lista → linha «Lista importada»",
);
check(
  (filtroListaImportada([])?.value ?? "").startsWith("0 produtos"),
  "lista vazia aparece como 0 produtos, e não desaparece do cabeçalho",
);

// ─────────────────────────────────────────────────────────────────────
// G. Um só parser, um só resolvedor  ← vigia a divergência
// ─────────────────────────────────────────────────────────────────────
console.log("\nG. Relatórios e Encomendas partilham o mesmo caminho\n");

// Caminhos relativos à raiz do repo — é de lá que `npm run` corre.
const src = (p: string) => readFileSync(p, "utf8");

// O mesmo ficheiro tem de dar o mesmo conjunto de CNP nos dois módulos.
// Aqui prova-se pela origem: os dois lêem `filters.cnps`, e esse array
// só pode ter vindo de `resolverListaCodigos`.
{
  const lista = await resolverListaCodigos(
    parseListaTxt("1234567;Paracetamol;1200\n5555555;Ibuprofeno;900\n9999999;Inexistente;1"),
    "comum.txt",
    prismaFake,
  );
  const viaRelatorio = await restringirPorCatalogo(prismaFake, { cnps: lista.cnps }, null);
  // O caminho das Encomendas é SQL (`p.cnp = ANY(...)`), que não se pode
  // executar aqui sem base de dados. O que se verifica é o que lá entra:
  // o MESMO array, com a mesma semântica.
  const viaEncomenda = CATALOGO.filter((p) => lista.cnps.includes(p.cnp)).map((p) => p.id);
  eq(viaRelatorio, viaEncomenda, "o mesmo ficheiro dá os mesmos produtos nos dois módulos");
  eq(lista.cnps, [1234567, 5555555], "e são os que existem");
}

// Nenhum módulo pode ganhar uma cópia do parser. Quando o comportamento
// diverge já é tarde — por isso a verificação é sobre o código.
{
  const proibidos: Array<[string, RegExp, string]> = [
    ["lib/encomendas/proposal.ts", /from "xlsx"/, "as Encomendas não podem ler ficheiros"],
    ["lib/inventario-data.ts", /from "xlsx"/, "o Inventário não pode ler ficheiros"],
    ["lib/margens-data.ts", /from "xlsx"/, "as Margens não podem ler ficheiros"],
    ["lib/vendas-data.ts", /from "xlsx"/, "as Vendas não podem ler ficheiros"],
    [
      "components/reporting/import-lista-codigos.tsx",
      /from "@\/lib\/produtos\/lista-codigos"/,
      "o componente de UI não pode importar o parser (arrastava o xlsx para o browser)",
    ],
  ];
  for (const [ficheiro, padrao, porque] of proibidos) {
    check(!padrao.test(src(ficheiro)), `${ficheiro}: ${porque}`);
  }
}

// Os dois tipos de filtro têm de usar o MESMO nome de campo. Um
// `produtosIds` de um lado e `cnps` do outro é como a divergência começa.
check(/\bcnps\?: number\[\];/.test(src("lib/reporting/filters-shared.ts")), "SharedReportFilters.cnps existe");
check(/\bcnps\?: number\[\];/.test(src("lib/encomendas/proposal.ts")), "ProposalFilters.cnps existe, com o mesmo nome");

// A única resolução código→produto é a canónica. Ver o cabeçalho de
// `resolver-lista-codigos.ts` para o porquê de não ser por
// `externalProductId`.
//
// Sem comentários, de propósito: o cabeçalho do ficheiro FALA de
// `externalProductId` para explicar porque não o usa, e uma verificação
// ingénua sobre o texto inteiro acusava exactamente a documentação que
// queremos que exista.
const semComentarios = (p: string) =>
  src(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
check(
  !/externalProductId/.test(semComentarios("lib/produtos/resolver-lista-codigos.ts")),
  "a resolução não usa externalProductId (não é único)",
);

// Os três loaders continuam a passar pelo helper partilhado — é o que
// lhes dá a lista sem nenhum deles a conhecer.
for (const f of ["lib/inventario-data.ts", "lib/margens-data.ts", "lib/vendas-data.ts"]) {
  check(/restringirPorCatalogo\(prisma, filters, produtoIdFilter\)/.test(src(f)), `${f} usa o pré-filtro partilhado`);
}

// ─────────────────────────────────────────────────────────────────────
// H. Limites
// ─────────────────────────────────────────────────────────────────────
console.log("\nH. Limites\n");

check(MAX_CODIGOS >= 10_000, `MAX_CODIGOS (${MAX_CODIGOS}) suporta «vários milhares»`);
{
  // O tecto existe por causa do payload da Server Action (1 MB default).
  // Se alguém o subir sem subir `serverActions.bodySizeLimit`, o sintoma
  // é uma proposta que falha só com listas grandes.
  const bytes = JSON.stringify(Array.from({ length: MAX_CODIGOS }, () => 7_654_321)).length;
  check(bytes < 1_000_000, `${MAX_CODIGOS} CNP em JSON são ${(bytes / 1024).toFixed(0)} KB — cabem no payload`);
}
{
  const grande = Array.from({ length: MAX_CODIGOS + 1 }, (_, i) => String(1_000_000 + i)).join("\n");
  const parseada = parseListaTxt(grande);
  let atirou = false;
  try {
    await resolverListaCodigos(parseada, "grande.txt", prismaFake);
  } catch {
    atirou = true;
  }
  check(atirou, "acima do tecto, o resolvedor recusa em vez de tentar");
}
{
  // Milhares de códigos reais, em chunks.
  consultas = 0;
  const muitos = Array.from({ length: 12_000 }, (_, i) => String(3_000_000 + i)).join("\n");
  const r = await resolverListaCodigos(parseListaTxt(muitos), "m.txt", prismaFake);
  eq(r.codigos.length, 12_000, "12 000 códigos parseados");
  check(consultas === 3, `12 000 códigos em ${consultas} consultas (chunks de 5 000)`);
}

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${ko === 0 ? "PASSOU" : "FALHOU"} — ${ok} OK, ${ko} falhas\n`);
process.exit(ko === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
