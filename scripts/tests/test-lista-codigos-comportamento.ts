/**
 * scripts/tests/test-lista-codigos-comportamento.ts
 *
 * Testes de COMPORTAMENTO da importação de listas.
 *
 * ── Porque este ficheiro existe além do `test-lista-codigos.ts` ──────
 *
 * O outro ficheiro tem duas metades: comportamento do parser, e
 * inspecção do código (secção G — «este cliente importa aquele tipo»,
 * «aquele loader não lê ficheiros»). A inspecção é útil para vigiar
 * duplicação, mas não prova que a funcionalidade faz o que promete: um
 * `grep` que passa não diz que uma lista de 2 000 CNP produz 2 000
 * linhas.
 *
 * Aqui não há um único `readFileSync` sobre código da aplicação. Tudo o
 * que se afirma é exercitado:
 *
 *   · o parser, com ficheiros reais construídos no teste;
 *   · a resolução contra um catálogo falso mas completo;
 *   · o pré-filtro dos relatórios, contra esse catálogo;
 *   · a contabilidade da proposta, com linhas reais;
 *   · a combinação de `cnps` com os outros eixos de filtro.
 *
 * Corre com:  npm run test:lista-comportamento
 */
import * as XLSX from "xlsx";
import {
  parseListaCodigos,
  parseListaExcel,
  parseListaTxt,
} from "../../lib/produtos/lista-codigos";
import { MAX_CODIGOS } from "../../lib/produtos/lista-codigos-tipos";
import { resolverListaCodigos } from "../../lib/produtos/resolver-lista-codigos";
import {
  restringirPorCatalogo,
  temFiltroCatalogo,
} from "../../lib/reporting/catalog-prefilter";
import { resumirListaImportada } from "../../lib/encomendas/resumo-lista";
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

// ─────────────────────────────────────────────────────────────────────
// O catálogo de teste
// ─────────────────────────────────────────────────────────────────────
//
// 1 200 produtos "reais" mais alguns casos-limite nomeados. É grande de
// propósito: uma lista de 800 CNP tem de poder ser exercitada contra um
// universo maior do que ela, senão o teste do ">500" não prova nada.

type Prod = {
  id: string;
  cnp: number;
  fabricanteId: string | null;
  classificacaoNivel1Id: string | null;
};

const CATALOGO: Prod[] = [];
for (let i = 0; i < 1200; i++) {
  CATALOGO.push({
    id: `p-${i}`,
    cnp: 3_000_000 + i,
    // Um terço com fabricante "F1", para exercitar a combinação de eixos.
    fabricanteId: i % 3 === 0 ? "F1" : "F2",
    classificacaoNivel1Id: i % 2 === 0 ? "N1-MED" : null,
  });
}
// Zeros à esquerda: o CNP existe como inteiro; o ficheiro traz-lo com zeros.
CATALOGO.push({ id: "p-zero", cnp: 571_942, fabricanteId: "F1", classificacaoNivel1Id: null });

let consultas = 0;
const prismaFake = {
  produto: {
    findMany: async (args: {
      where: {
        cnp?: { in: number[] };
        id?: { in: string[] };
        fabricanteId?: { in: string[] };
        classificacaoNivel1Id?: string | null;
      };
    }) => {
      consultas++;
      let u = CATALOGO;
      const w = args.where;
      if (w.cnp?.in) u = u.filter((p) => w.cnp!.in.includes(p.cnp));
      if (w.id?.in) u = u.filter((p) => w.id!.in.includes(p.id));
      if (w.fabricanteId?.in) u = u.filter((p) => p.fabricanteId !== null && w.fabricanteId!.in.includes(p.fabricanteId));
      return u.map((p) => ({ id: p.id, cnp: p.cnp }));
    },
  },
} as unknown as PrismaClient;

/** Constrói um .xlsx real em memória. */
function livro(folhas: Record<string, unknown[][]>): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [nome, aoa] of Object.entries(folhas)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), nome);
  }
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

// Este ficheiro compila para CommonJS: sem top-level await.
async function main(): Promise<void> {

// ═════════════════════════════════════════════════════════════════════
// A. TXT — cada separador que o requisito nomeia
// ═════════════════════════════════════════════════════════════════════
console.log("\nA. TXT: todos os separadores pedidos produzem a MESMA lista\n");

const ESPERADO = ["3000001", "3000002", "3000003"];
const VARIANTES: Array<[string, string]> = [
  ["Enter", "3000001\n3000002\n3000003"],
  ["Enter com CRLF", "3000001\r\n3000002\r\n3000003"],
  ["ponto e vírgula", "3000001;3000002;3000003"],
  ["vírgula", "3000001,3000002,3000003"],
  ["TAB", "3000001\t3000002\t3000003"],
  ["espaços", "3000001 3000002 3000003"],
  ["misturados", "3000001;3000002\n3000003"],
  ["com BOM", "﻿3000001\n3000002\n3000003"],
  ["com linhas vazias", "3000001\n\n\n3000002\n   \n3000003\n"],
  ["com whitespace à volta", "  3000001  \n\t3000002\t\n 3000003 "],
];
for (const [nome, texto] of VARIANTES) {
  eq(parseListaTxt(texto).codigos, ESPERADO, `separado por ${nome}`);
}

// Duplicados — contados, não silenciados.
{
  const r = parseListaTxt("3000001\n3000002\n3000001\n3000001\n3000002");
  eq(r.codigos, ["3000001", "3000002"], "duplicados removidos da lista");
  eq(r.totalLidos, 5, "…mas os 5 foram lidos");
  eq(r.duplicados, 3, "…e 3 são repetições");
}

// A ambiguidade do espaço, com o caso real de um mapa exportado.
{
  const r = parseListaTxt("3000001 Paracetamol 500mg 2\n3000002 Ibuprofeno 400mg 12");
  eq(r.codigos, ["3000001", "3000002"], "código à cabeça + designação → só o código");
  check(!r.codigos.includes("500"), "«500» não entra");
  check(!r.codigos.includes("400"), "«400» não entra");
  // 12 tem 2 dígitos — abaixo do mínimo — logo também não entra.
  check(!r.codigos.includes("12"), "a quantidade «12» não entra");
}

// ═════════════════════════════════════════════════════════════════════
// B. Excel — cabeçalho CNP, cabeçalho Código, coluna única
// ═════════════════════════════════════════════════════════════════════
console.log("\nB. Excel: as três formas que o requisito exige\n");

{
  const r = parseListaExcel(
    livro({ Folha1: [["CNP", "Designação"], [3000001, "A"], [3000002, "B"], [3000003, "C"]] }),
  );
  eq(r.codigos, ESPERADO, "cabeçalho «CNP»");
  eq(r.coluna, "CNP", "…e a coluna usada é reportada");
}
{
  const r = parseListaExcel(
    livro({ Mapa: [["Designação", "Código", "Qtd"], ["A", 3000001, 1200], ["B", 3000002, 3400], ["C", 3000003, 5600]] }),
  );
  eq(r.codigos, ESPERADO, "cabeçalho «Código», não a 1.ª coluna");
  check(!r.codigos.includes("1200"), "a coluna «Qtd» NÃO contribui códigos");
}
{
  const r = parseListaExcel(livro({ L: [[3000001], [3000002], [3000003]] }));
  eq(r.codigos, ESPERADO, "coluna única sem cabeçalho conhecido");
}
{
  // Células vazias no meio.
  const r = parseListaExcel(livro({ L: [["CNP"], [3000001], [""], [null], [3000002], ["  "]] }));
  eq(r.codigos, ["3000001", "3000002"], "células vazias ignoradas");
}
{
  // Várias folhas: a primeira ÚTIL.
  const r = parseListaExcel(livro({ Capa: [[""], [null]], Dados: [["CNP"], [3000001]] }));
  eq(r.folha, "Dados", "salta a folha vazia");
}

// ═════════════════════════════════════════════════════════════════════
// C. Zeros à esquerda — tratados como texto, resolvidos como número
// ═════════════════════════════════════════════════════════════════════
console.log("\nC. Zeros à esquerda: o ficheiro traz texto, o catálogo é inteiro\n");

{
  // Coluna de texto no Excel, como o ERP a exporta.
  const ws = XLSX.utils.aoa_to_sheet([["CNP"], ["0571942"]]);
  const buf = XLSX.write(
    (() => {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "L");
      return wb;
    })(),
    { type: "buffer", bookType: "xlsx" },
  ) as Buffer;
  const r = parseListaExcel(buf);
  eq(r.codigos, ["571942"], "«0571942» normaliza para 571942");

  const res = await resolverListaCodigos(r, "z.xlsx", prismaFake);
  eq(res.cnps, [571942], "…e resolve para o produto que existe");
  eq(res.naoEncontrados, [], "…sem falsos não-encontrados");
}
{
  // O mesmo CNP escrito das duas formas no mesmo ficheiro.
  const r = parseListaTxt("0571942\n571942\n00571942");
  eq(r.codigos, ["571942"], "as três grafias são um só código");
  eq(r.duplicados, 2, "…e as outras duas contam como duplicados");
}

// ═════════════════════════════════════════════════════════════════════
// D. Códigos inexistentes
// ═════════════════════════════════════════════════════════════════════
console.log("\nD. Inexistentes: reportados, e não a restringir nada\n");

{
  const r = await resolverListaCodigos(
    parseListaTxt("3000001\n9999991\n3000002\n9999992"),
    "mix.txt",
    prismaFake,
  );
  eq(r.encontrados, 2, "2 encontrados");
  eq(r.naoEncontrados, ["9999991", "9999992"], "2 reportados como inexistentes");
  eq(r.cnps, [3000001, 3000002], "só os que existem viajam no filtro");
}
{
  // Nenhum existe: o filtro é [] e TEM de dar zero produtos.
  const r = await resolverListaCodigos(parseListaTxt("9999991\n9999992"), "n.txt", prismaFake);
  eq(r.cnps, [], "nenhum encontrado → array vazio");
  check(temFiltroCatalogo({ cnps: r.cnps }), "…mas o pré-filtro CORRE na mesma");
  const ids = await restringirPorCatalogo(prismaFake, { cnps: r.cnps }, null);
  eq(ids, [], "…e devolve ZERO produtos, não o catálogo inteiro");
}

// ═════════════════════════════════════════════════════════════════════
// E. Listas com mais de 500 artigos
// ═════════════════════════════════════════════════════════════════════
console.log("\nE. Mais de 500: nada é truncado no caminho da lista\n");

{
  const n = 800;
  const texto = Array.from({ length: n }, (_, i) => String(3_000_000 + i)).join("\n");
  const parseada = parseListaTxt(texto);
  eq(parseada.codigos.length, n, `${n} códigos parseados`);

  consultas = 0;
  const r = await resolverListaCodigos(parseada, "800.txt", prismaFake);
  eq(r.encontrados, n, `${n} resolvidos — nenhum perdido acima de 500`);
  eq(r.cnps.length, n, "…e os 800 viajam no filtro");
  eq(consultas, 1, "numa única consulta (chunk de 5 000)");

  const ids = await restringirPorCatalogo(prismaFake, { cnps: r.cnps }, null);
  eq(ids?.length, n, `o relatório fica restrito aos ${n}, não a 500`);
}
{
  // Acima do chunk: prova que o chunking não perde nem duplica.
  const n = 1200;
  const texto = Array.from({ length: n }, (_, i) => String(3_000_000 + i)).join("\n");
  const r = await resolverListaCodigos(parseListaTxt(texto), "1200.txt", prismaFake);
  eq(r.encontrados, n, `${n} resolvidos`);
  eq(new Set(r.cnps).size, n, "sem duplicados introduzidos pelo chunking");
}

// ═════════════════════════════════════════════════════════════════════
// F. Combinação da lista com outros filtros
// ═════════════════════════════════════════════════════════════════════
console.log("\nF. `cnps` combina-se com os outros eixos por E lógico\n");

{
  // Lista de 6 produtos; restrição anterior (ex: fabricante) a 3 deles.
  const lista = [3000000, 3000001, 3000002, 3000003, 3000004, 3000005];
  const restricaoAnterior = ["p-0", "p-3", "p-9"];
  const ids = await restringirPorCatalogo(prismaFake, { cnps: lista }, restricaoAnterior);
  // p-0 (cnp 3000000) e p-3 (cnp 3000003) estão nos dois; p-9 não está na lista.
  eq(ids, ["p-0", "p-3"], "intersecta com a restrição que já vinha");
}
{
  // A ordem inversa dá o mesmo: a intersecção é comutativa.
  const ids = await restringirPorCatalogo(prismaFake, { cnps: [3000000] }, ["p-1", "p-2"]);
  eq(ids, [], "sem intersecção → zero produtos");
}
{
  // Sem lista, o pré-filtro não corre por causa dela.
  check(!temFiltroCatalogo({}), "sem `cnps` e sem mais nada → não há pré-filtro");
  check(temFiltroCatalogo({ subcategorias: ["X"] }), "os outros eixos continuam a activá-lo");
}

// ═════════════════════════════════════════════════════════════════════
// G. Relatório limitado à lista importada
// ═════════════════════════════════════════════════════════════════════
console.log("\nG. O relatório vê a lista e mais nada\n");

{
  const r = await resolverListaCodigos(parseListaTxt("3000007\n3000008\n3000009"), "r.txt", prismaFake);
  const ids = await restringirPorCatalogo(prismaFake, { cnps: r.cnps }, null);
  eq(ids?.sort(), ["p-7", "p-8", "p-9"], "exactamente os três produtos da lista");
  check((ids?.length ?? 0) < CATALOGO.length, "…e não os 1 201 do catálogo");
}

// ═════════════════════════════════════════════════════════════════════
// H. Encomenda: produtos sem vendas no período
// ═════════════════════════════════════════════════════════════════════
console.log("\nH. Um artigo sem vendas fica na encomenda, com zero\n");

{
  // 1 210 na lista: 940 venderam, 270 não, e não há sem-registo.
  const cnps = Array.from({ length: 1210 }, (_, i) => 4_000_000 + i);
  const linhas = cnps.map((cnp, i) => ({ cnp, salesQty: i < 940 ? 10 : 0 }));
  const r = resumirListaImportada(cnps, linhas);

  eq(r.cnpsNaLista, 1210, "1 210 na lista");
  eq(r.comVendas, 940, "940 considerados na proposta");
  eq(r.semVendas, 270, "270 sem vendas no período");
  eq(r.semRegistoNaFarmacia, 0, "0 sem registo");
  eq(r.listaSemVendas.length, 270, "os 270 são consultáveis um a um");
  check(
    r.comVendas + r.semVendas + r.semRegistoNaFarmacia === r.cnpsNaLista,
    "os números FECHAM: comVendas + semVendas + semRegisto = lista",
  );
}
{
  // A terceira categoria: na lista, mas sem linha nenhuma.
  const cnps = [10, 20, 30, 40];
  const r = resumirListaImportada(cnps, [
    { cnp: 10, salesQty: 5 },
    { cnp: 20, salesQty: 0 },
  ]);
  eq(r.comVendas, 1, "1 com vendas");
  eq(r.semVendas, 1, "1 sem vendas");
  eq(r.semRegistoNaFarmacia, 2, "2 sem registo na farmácia");
  eq(r.listaSemRegisto, [30, 40], "…e identificados");
  check(r.comVendas + r.semVendas + r.semRegistoNaFarmacia === 4, "fecham os quatro");
}
{
  // Modo grupo: o mesmo CNP aparece uma vez por farmácia. Vender numa
  // basta — senão o artigo contaria nas duas colunas e o resumo somaria
  // mais do que a lista tem.
  const r = resumirListaImportada(
    [100, 200],
    [
      { cnp: 100, salesQty: 0 },  // Castelo: não vendeu
      { cnp: 100, salesQty: 7 },  // Principal: vendeu
      { cnp: 200, salesQty: 0 },
      { cnp: 200, salesQty: 0 },
    ],
  );
  eq(r.comVendas, 1, "vender numa farmácia basta para contar como «com vendas»");
  eq(r.semVendas, 1, "…e o que não vendeu em nenhuma fica em «sem vendas»");
  check(r.comVendas + r.semVendas + r.semRegistoNaFarmacia === 2, "não soma mais do que a lista");
}
{
  // Lista vazia e linhas vazias: sem divisões por zero nem NaN.
  const r = resumirListaImportada([], []);
  eq(r, {
    cnpsNaLista: 0, comVendas: 0, semVendas: 0, semRegistoNaFarmacia: 0,
    listaSemVendas: [], listaSemRegisto: [],
  }, "lista vazia é um resumo de zeros, sem NaN");
}
{
  // A ordem dos não-vendidos acompanha a LISTA e não a dos Sets: é
  // assim que se percorre o ecrã com o ficheiro ao lado.
  const r = resumirListaImportada([50, 40, 30], [
    { cnp: 30, salesQty: 0 },
    { cnp: 50, salesQty: 0 },
    { cnp: 40, salesQty: 1 },
  ]);
  eq(r.listaSemVendas, [50, 30], "a ordem é a do ficheiro");
}

// ═════════════════════════════════════════════════════════════════════
// I. Sem duplicados
// ═════════════════════════════════════════════════════════════════════
console.log("\nI. Duplicados não geram produtos repetidos em lado nenhum\n");

{
  const r = await resolverListaCodigos(
    parseListaTxt("3000001\n3000001\n3000001\n3000002"),
    "d.txt",
    prismaFake,
  );
  eq(r.cnps, [3000001, 3000002], "o CNP repetido aparece UMA vez no filtro");
  eq(r.duplicados, 2, "…e as repetições são contadas");

  const ids = await restringirPorCatalogo(prismaFake, { cnps: r.cnps }, null);
  eq(ids?.length, 2, "o relatório mostra 2 produtos e não 4 linhas");
}
{
  // O resumo também não duplica quando a lista traz repetições que já
  // foram colapsadas a montante.
  const r = resumirListaImportada([7, 7, 8], [{ cnp: 7, salesQty: 3 }]);
  eq(r.comVendas, 1, "um CNP repetido na lista conta uma vez em comVendas");
}

// ═════════════════════════════════════════════════════════════════════
// J. Contabilidade do ficheiro
// ═════════════════════════════════════════════════════════════════════
console.log("\nJ. O resumo do ficheiro fecha\n");

{
  const r = await resolverListaCodigos(
    parseListaTxt("3000001\n3000002\n3000001\n9999999\nlixo\n3000003"),
    "c.txt",
    prismaFake,
  );
  eq(r.totalLidos, 5, "5 tokens aceites como código");
  eq(r.duplicados, 1, "1 repetição");
  eq(r.codigos.length, 4, "4 códigos únicos");
  eq(r.encontrados, 3, "3 existem");
  eq(r.naoEncontrados.length, 1, "1 não existe");
  check(r.encontrados + r.naoEncontrados.length === r.codigos.length,
        "encontrados + não encontrados = códigos únicos");
  check(r.totalLidos - r.duplicados === r.codigos.length,
        "lidos − duplicados = únicos");
  check(r.ignorados.includes("lixo"), "o que não é código aparece em ignorados");
}

// ═════════════════════════════════════════════════════════════════════
// K. O tecto da importação
// ═════════════════════════════════════════════════════════════════════
console.log("\nK. O limite é explícito e recusa, não trunca\n");

{
  const texto = Array.from({ length: MAX_CODIGOS + 5 }, (_, i) => String(5_000_000 + i)).join("\n");
  const parseada = parseListaTxt(texto);
  eq(parseada.codigos.length, MAX_CODIGOS + 5, "o parser lê todos");
  let recusou = false;
  try {
    await resolverListaCodigos(parseada, "grande.txt", prismaFake);
  } catch {
    recusou = true;
  }
  check(recusou, "…e o resolvedor RECUSA acima do tecto — não corta em silêncio");
}

// ═════════════════════════════════════════════════════════════════════
// L. O despacho por extensão
// ═════════════════════════════════════════════════════════════════════
console.log("\nL. .txt, .csv, .xlsx e .xls pelo mesmo ponto de entrada\n");

eq(parseListaCodigos("l.txt", Buffer.from("3000001\n3000002")).codigos, ["3000001", "3000002"], ".txt");
eq(parseListaCodigos("l.csv", Buffer.from("3000001;3000002")).codigos, ["3000001", "3000002"], ".csv");
eq(parseListaCodigos("l.xlsx", livro({ A: [["CNP"], [3000001]] })).codigos, ["3000001"], ".xlsx");
eq(parseListaCodigos("L.XLSX", livro({ A: [["CNP"], [3000001]] })).codigos, ["3000001"], "extensão em maiúsculas");

// ═════════════════════════════════════════════════════════════════════
console.log(`\n${ko === 0 ? "PASSOU" : "FALHOU"} — ${ok} OK, ${ko} falhas\n`);
process.exit(ko === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
