/**
 * scripts/tests/test-margens.ts
 *
 * As quatro correcções do módulo Margens.
 *
 * Puros: sem base de dados e sem rede. A pesquisa é testada pelo SQL que
 * o `Prisma.sql` gera (texto + parâmetros), e o filtro de utilização por
 * um Prisma falso que captura o `where` — é a única forma de provar que
 * a semântica é a certa sem uma base de dados por baixo.
 *
 *   A  pesquisa por CNP exacto
 *   B  pesquisa parcial por designação
 *   C  resumo/totais respeitam a pesquisa
 *   D  PVP unit. = vendasComIVA / quantidade
 *   E  Custo unit. = custoEstimado / quantidade
 *   F  quantidade 0 ⇒ os dois a null
 *   G  Utilização filtra por ProdutoUtilizacao
 *   H  utilização com categoria diferente aparece
 *   I  categoria igual sem a utilização NÃO aparece
 *   J  Categoria + Utilização combinam por AND
 *   K  relatório/PDF/Excel incluem as duas colunas
 *   L  pesquisa local nos filtros multi-select
 *   M  modo "só totalizadores" e a dimensão Fabricante
 *
 * Corre com:  npm run test:margens
 */
import { readFileSync } from "node:fs";
import { Prisma } from "../../generated/prisma/client";
import { construirCondicaoPesquisa, derivarUnitarios } from "../../lib/margens-data";
import { restringirPorCatalogo, temFiltroCatalogo } from "../../lib/reporting/catalog-prefilter";
import {
  buildMargensAggReport,
  buildMargensProdutoReport,
} from "../../lib/reporting/adapters/margens";
import { normalizarOpcao, opcoesVisiveis } from "../../components/reporting/filter-select";
import type { MargensAgg } from "../../lib/margens-data";
import type { MargemRow } from "../../lib/margens-data";

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
const eq = <T,>(a: T, b: T, label: string) =>
  check(
    JSON.stringify(a) === JSON.stringify(b),
    label,
    `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`,
  );

const dados = readFileSync("lib/margens-data.ts", "utf8");
const cliente = readFileSync("components/margens/margens-client.tsx", "utf8");
const adaptador = readFileSync("lib/reporting/adapters/margens.ts", "utf8");

// ══════════════════════════════════════════════════════════════════════
// A · PESQUISA POR CNP
// ══════════════════════════════════════════════════════════════════════
console.log("\nA · pesquisa por CNP");
{
  const c = construirCondicaoPesquisa("5880034");
  check(c.sql.includes('p."cnp"::text LIKE'), "compara o CNP em texto");
  check(c.sql.includes('p."designacao" ILIKE'), "procura também na designação");
  eq(c.values, ["%5880034%", "%5880034%"], "parâmetros = o padrão, duas vezes");

  // Parte do CNP — o caso que a igualdade numérica não cobria.
  const parcial = construirCondicaoPesquisa("58800");
  eq(parcial.values, ["%58800%", "%58800%"], "parte do CNP produz o mesmo padrão");
  check(
    !parcial.sql.includes('p."cnp" = '),
    "já não usa igualdade numérica (era o que ignorava CNP parcial)",
  );

  // Espaços à volta não contam.
  eq(
    construirCondicaoPesquisa("  5880034  ").values,
    ["%5880034%", "%5880034%"],
    "termo é aparado antes de virar padrão",
  );

  // Sem termo, sem condição.
  eq(construirCondicaoPesquisa("").sql, Prisma.empty.sql, "termo vazio ⇒ sem condição");
  eq(construirCondicaoPesquisa(undefined).sql, Prisma.empty.sql, "undefined ⇒ sem condição");
  eq(construirCondicaoPesquisa("   ").sql, Prisma.empty.sql, "só espaços ⇒ sem condição");
}

// ══════════════════════════════════════════════════════════════════════
// B · PESQUISA PARCIAL POR DESIGNAÇÃO
// ══════════════════════════════════════════════════════════════════════
console.log("\nB · pesquisa por designação");
{
  const c = construirCondicaoPesquisa("depuralina");
  check(c.sql.includes('p."designacao" ILIKE'), "ILIKE — não distingue maiúsculas");
  check(
    !c.sql.includes('p."cnp"'),
    "não procura no CNP quando o termo tem letras (seria sempre falso)",
  );
  eq(c.values, ["%depuralina%"], "um só parâmetro, com % dos dois lados");

  eq(
    construirCondicaoPesquisa("DEPURALINA").values,
    ["%DEPURALINA%"],
    "maiúsculas passam ao ILIKE tal como vieram",
  );
  // Termo misto (letras + dígitos) trata-se como designação.
  check(
    !construirCondicaoPesquisa("omega 3").sql.includes('p."cnp"'),
    "termo misto não vai ao CNP",
  );
}

// ══════════════════════════════════════════════════════════════════════
// C · O RESUMO RESPEITA A PESQUISA
//
// Não há filtragem visual depois de somar: a condição entra na QUERY, e
// os KPIs e as três agregações derivam de `porProduto`, que já vem
// filtrado. Isto verifica-se na estrutura do loader.
// ══════════════════════════════════════════════════════════════════════
console.log("\nC · totais respeitam a pesquisa");
{
  check(
    dados.includes("const pesquisaCond = construirCondicaoPesquisa(filters.pesquisa);"),
    "a condição é construída a partir do filtro recebido",
  );
  check(
    /WHERE 1 = 1[\s\S]{0,200}\$\{pesquisaCond\}/.test(dados),
    "a condição entra no WHERE da query principal",
  );
  // Os agregados partem de porProduto — logo herdam o filtro.
  for (const linha of [
    'const porCategoria = aggregate(porProduto,',
    'const porFarmacia = aggregate(porProduto,',
    'const porGrupo = aggregate(porProduto,',
    'const totals = aggregate(porProduto,',
  ]) {
    check(dados.includes(linha), `agregado derivado de porProduto: ${linha.slice(6, 26)}…`);
  }

  // E a UI reenvia os filtros quando eles mudam — antes só o botão
  // "Gerar" o fazia, e escrever um CNP não mudava nada no ecrã.
  check(
    cliente.includes("runMargensReport(JSON.parse(filtrosSerial))"),
    "a UI relança o relatório quando os filtros mudam",
  );
  check(cliente.includes("}, 400);"), "com debounce, para não disparar por tecla");
  check(
    cliente.includes("if (!hasGenerated) return;"),
    "mas nunca antes da primeira geração explícita",
  );
}

// ══════════════════════════════════════════════════════════════════════
// D · PVP UNITÁRIO   ·   E · CUSTO UNITÁRIO   ·   F · quantidade 0
// ══════════════════════════════════════════════════════════════════════
console.log("\nD/E · unitários");
{
  // O exemplo do enunciado: 22 unidades, 307,08 € c/IVA, 293,70 € custo.
  const u = derivarUnitarios(22, 307.08, 293.7);
  eq(u.pvpUnitario, 13.96, "PVP unit. = 307,08 / 22 ≈ 13,96 €");
  eq(u.custoUnitario, 13.35, "Custo unit. = 293,70 / 22 ≈ 13,35 €");

  // Duas casas, sempre.
  const r = derivarUnitarios(3, 10, 10);
  eq(r.pvpUnitario, 3.33, "arredonda a 2 casas (10/3)");
  eq(r.custoUnitario, 3.33, "idem no custo");

  // Custo desconhecido não vira 0.
  const semCusto = derivarUnitarios(10, 50, null);
  eq(semCusto.pvpUnitario, 5, "PVP unit. calcula-se sem depender do custo");
  eq(semCusto.custoUnitario, null, "custo desconhecido ⇒ custo unit. null, não 0");
}

console.log("\nF · quantidade 0");
{
  const z = derivarUnitarios(0, 307.08, 293.7);
  eq(z.pvpUnitario, null, "qtd 0 ⇒ PVP unit. null (não Infinity)");
  eq(z.custoUnitario, null, "qtd 0 ⇒ Custo unit. null");

  const neg = derivarUnitarios(-5, 100, 100);
  eq(neg.pvpUnitario, null, "quantidade negativa ⇒ null");

  const nan = derivarUnitarios(Number.NaN, 100, 100);
  eq(nan.pvpUnitario, null, "quantidade não finita ⇒ null");
}

// ══════════════════════════════════════════════════════════════════════
// L · PESQUISA LOCAL NOS FILTROS
//
// Filtra as OPÇÕES VISÍVEIS, e nada mais. Não vai à base de dados, não
// altera o relatório e — sobretudo — não desselecciona nada.
// ══════════════════════════════════════════════════════════════════════
console.log("\nL · pesquisa local nos filtros");
{
  const FABRICANTES = [
    "BAYER",
    "MENARINI",
    "A. MENARINI PORTUGAL",
    "PFIZER",
    "LABORATÓRIOS VITÓRIA",
    "GENERIS",
  ];

  // A · pesquisa parcial, sem distinguir maiúsculas
  eq(
    opcoesVisiveis(FABRICANTES, "menarini"),
    ["MENARINI", "A. MENARINI PORTUGAL"],
    "A: 'menarini' encontra os dois, em minúsculas",
  );
  eq(opcoesVisiveis(FABRICANTES, "BAY"), ["BAYER"], "A: prefixo parcial");
  eq(opcoesVisiveis(FABRICANTES, "zer"), ["PFIZER"], "A: no meio da palavra");

  // Acentos: quem escreve sem acento tem de encontrar na mesma.
  eq(
    opcoesVisiveis(FABRICANTES, "vitoria"),
    ["LABORATÓRIOS VITÓRIA"],
    "A: 'vitoria' encontra 'VITÓRIA'",
  );
  eq(normalizarOpcao("LABORATÓRIOS VITÓRIA"), "laboratorios vitoria", "A: normalização");

  // C · limpar repõe a lista completa
  eq(opcoesVisiveis(FABRICANTES, ""), FABRICANTES, "C: termo vazio ⇒ lista completa");
  eq(opcoesVisiveis(FABRICANTES, "   "), FABRICANTES, "C: só espaços ⇒ lista completa");

  // Sem correspondências: lista vazia, e não a lista toda.
  eq(opcoesVisiveis(FABRICANTES, "xpto"), [], "sem correspondências ⇒ vazio");

  // B · a selecção não é tocada
  const cliente = readFileSync("components/reporting/filter-select.tsx", "utf8");
  check(
    !/setProcura[\s\S]{0,200}onChange\(/.test(cliente),
    "B: escrever na caixa nunca chama o onChange da selecção",
  );
  check(
    cliente.includes("const escondidasSeleccionadas = selected.filter"),
    "B: e a UI diz quantas seleccionadas a pesquisa escondeu",
  );
  check(
    cliente.includes("checked={selected.includes(opt)}"),
    "B: o estado do checkbox vem sempre de `selected`, não do que está visível",
  );
  check(
    cliente.includes("const MINIMO_PARA_PESQUISA = 8"),
    "a caixa só aparece em listas longas",
  );
  check(
    !cliente.includes("fetch(") && !cliente.includes("useEffect"),
    "sem pedidos à base de dados: o universo já veio do servidor",
  );

  // Todos os filtros da barra usam este componente — logo, todos ganham
  // a pesquisa de uma vez.
  const barra = readFileSync("components/reporting/report-filters-bar.tsx", "utf8");
  for (const f of ["Farmácia", "Categoria", "Subcategoria", "Utilização", "Fabricante", "Distribuidor"]) {
    check(
      new RegExp(`label="${f}"[\\s\\S]{0,200}<`).test(barra) || barra.includes(`label="${f}"`),
      `o filtro ${f} está na barra partilhada`,
    );
  }
  // `<FilterSelect` aparece tambem no comentario do cabecalho do
  // ficheiro; conta-se a forma JSX real (etiqueta + quebra de linha).
  eq(
    (barra.match(/<FilterSelect\n/g) ?? []).length,
    6,
    "os 6 filtros passam pelo mesmo FilterSelect",
  );
}

// ══════════════════════════════════════════════════════════════════════
// M · SÓ TOTALIZADORES · DIMENSÃO FABRICANTE
// ══════════════════════════════════════════════════════════════════════
console.log("\nM · totalizadores e fabricante");
{
  const dados = readFileSync("lib/margens-data.ts", "utf8");
  const clienteM = readFileSync("components/margens/margens-client.tsx", "utf8");
  const adaptadorM = readFileSync("lib/reporting/adapters/margens.ts", "utf8");

  // D/E · as dimensões existentes
  for (const dim of ["porCategoria", "porFarmacia", "porGrupo", "porFabricante"]) {
    check(dados.includes(`const ${dim} = aggregate(porProduto,`), `dimensão ${dim} existe`);
  }
  check(
    dados.includes("const porFabricante = aggregate(porProduto, (r) => r.fabricante);"),
    "E: Por fabricante agrega pelo fabricante canónico",
  );
  check(
    clienteM.includes('fabricante: "Totais por fabricante"'),
    "E: e aparece na UI como vista de totais",
  );
  check(
    clienteM.includes('produto: "Detalhe por produto"'),
    "D: a única vista com detalhe diz que é a única",
  );

  // D · a vista agregada não renderiza produtos
  check(
    clienteM.includes("<TabelaAgg rows={linhasAgregadas(result, nivel)}"),
    "D: fora de 'produto', a tabela é sempre a agregada",
  );
  check(
    clienteM.includes("const aggRows = linhasAgregadas(result, nivel);"),
    "I: ecrã e exportação leem a MESMA lista",
  );

  // K · fabricante em falta não parte nada
  check(
    dados.includes('fabricante: (r.fabricante ?? "").trim() || "(sem fabricante)"'),
    "K: null e vazio caem no mesmo rótulo, e não em duas chaves",
  );

  // F · a margem % agregada é ponderada, não uma média de percentagens
  check(
    dados.includes("(acc.margemEurTotal / acc.valorVendidoSemIvaTotal) * 10000"),
    "F: margem % = margem total / vendas s/IVA totais",
  );
  check(
    !/margemPct[\s\S]{0,200}\/ *(rows|linhas)\.length/.test(dados),
    "F: nunca uma média aritmética das percentagens",
  );

  // Prova numérica: duas linhas de pesos muito diferentes.
  //   A: 1000 s/IVA, 100 margem  → 10%
  //   B:   10 s/IVA,   9 margem  → 90%
  // média simples = 50% · ponderada = 109/1010 = 10,79%
  const ponderada = ((100 + 9) / (1000 + 10)) * 100;
  const mediaSimples = (10 + 90) / 2;
  eq(Math.round(ponderada * 100) / 100, 10.79, "F: a ponderada dá 10,79%");
  check(Math.abs(ponderada - mediaSimples) > 30, "F: …e a média simples daria 50%, muito longe");

  // G/H · unitários nas vistas agregadas.
  //
  // Prova-se construindo o relatório e olhando para as colunas que ele
  // devolve — não por `grep` ao adaptador, que também contém as colunas
  // da vista POR PRODUTO e daria um falso positivo.
  const agg: MargensAgg = {
    key: "MENARINI",
    label: "MENARINI",
    qtdVendida: 100,
    valorVendido: 1230,
    valorVendidoSemIva: 1000,
    custoEstimado: 700,
    margemEur: 300,
    margemPct: 30,
    coberturaCusto: 1,
    estado: "FIAVEL",
  };
  const relAgg = buildMargensAggReport({
    rows: [agg],
    filters: {},
    universe: { farmacias: [], categorias: [], fabricantes: [], distribuidores: [] },
    organization: "Grupo",
    groupBy: "fabricante",
  });
  const chavesAgg = relAgg.columns.map((c) => c.key);
  check(!chavesAgg.includes("pvpUnitario"), "G: sem PVP unit. na vista agregada");
  check(!chavesAgg.includes("custoUnitario"), "H: sem Custo unit. na vista agregada");
  check(!chavesAgg.includes("cnp"), "D: e sem CNP — não há detalhe de produto");
  check(/Fabricante/.test(relAgg.title), "E: o título diz Por Fabricante");
  eq(relAgg.rows.length, 1, "E: uma linha por fabricante");
  eq(relAgg.rows[0].label, "MENARINI", "E: com o rótulo do fabricante");

  // I · o PDF/Excel exporta a vista agregada, não o detalhe
  check(
    clienteM.includes("groupBy: nivel"),
    "I: a exportação recebe a dimensão que está no ecrã",
  );
  check(
    adaptadorM.includes('fabricante: "margens-fabricante"'),
    "I: com slug próprio para o ficheiro exportado",
  );

  // J · os filtros correm ANTES da agregação
  check(
    dados.indexOf("restringirPorCatalogo") < dados.indexOf("const porFabricante"),
    "J: o pré-filtro de catálogo corre antes de agregar",
  );
  check(
    dados.indexOf("${pesquisaCond}") < dados.indexOf("const porFabricante"),
    "J: e a pesquisa também — a agregação parte de porProduto já filtrado",
  );

  // L · Distribuidor NÃO é dimensão de agrupamento, e é deliberado
  check(
    !dados.includes("porDistribuidor"),
    "L: não existe agregação por distribuidor",
  );
  check(
    adaptadorM.includes("nao o da compra que gerou o custo do"),
    "L: e a razão está escrita no código, não só no relatório",
  );
}

// ══════════════════════════════════════════════════════════════════════
// G/H/I/J · UTILIZAÇÃO ≠ CATEGORIA
//
// Um Prisma falso que regista o `where` de cada `findMany`. Prova o que
// a query PEDE, que é onde a contaminação semântica viveria.
// ══════════════════════════════════════════════════════════════════════
type Chamada = { modelo: string; where: unknown };

function prismaFalso(resultados: Record<string, Array<{ id: string }>>) {
  const chamadas: Chamada[] = [];
  const fake = {
    classificacao: {
      findMany: async ({ where }: { where: unknown }) => {
        chamadas.push({ modelo: "classificacao", where });
        return resultados.classificacao ?? [];
      },
    },
    produto: {
      findMany: async ({ where }: { where: unknown }) => {
        chamadas.push({ modelo: "produto", where });
        return resultados.produto ?? [];
      },
    },
  };
  return { fake, chamadas };
}

async function principal() {
console.log("\nG · a utilização filtra pela relação própria");
{
  const { fake, chamadas } = prismaFalso({ produto: [{ id: "p1" }, { id: "p2" }] });
  const ids = await restringirPorCatalogo(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fake as any,
    { utilizacoes: ["controlo-de-peso"] },
    null,
  );

  eq(ids, ["p1", "p2"], "devolve os produtos da relação");
  eq(chamadas.length, 1, "uma só query — não vai à classificação");

  const where = JSON.stringify(chamadas[0].where);
  check(
    where.includes('"utilizacoes"') && where.includes('"some"'),
    "filtra por Produto.utilizacoes.some (ProdutoUtilizacao)",
  );
  check(where.includes('"slug"'), "identifica a utilização pelo SLUG");
  check(
    where.includes("controlo-de-peso"),
    "usa o slug escolhido, não o nome apresentado",
  );
  check(
    !where.includes("classificacaoNivel1Id") && !where.includes("classificacaoNivel2Id"),
    "NÃO toca em classificacaoNivel1/2 — sem inferência de categoria",
  );
  check(
    !where.includes("categoriaOrigem") && !where.includes("subcategoriaOrigem"),
    "NÃO usa a categoria do ERP como fallback",
  );
  check(
    !/"nome"\s*:\s*"Controlo/i.test(where),
    "NÃO compara o NOME da utilização com nada",
  );
}

console.log("\nH · utilização com categoria diferente aparece");
{
  // O produto "p-suplemento" tem a utilização mas a categoria é
  // SUPLEMENTOS ALIMENTARES. O filtro só olha para a relação, portanto
  // devolve-o na mesma.
  const { fake } = prismaFalso({ produto: [{ id: "p-suplemento" }] });
  const ids = await restringirPorCatalogo(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fake as any,
    { utilizacoes: ["controlo-de-peso"] },
    null,
  );
  eq(ids, ["p-suplemento"], "aparece, apesar de a categoria ser outra");
}

console.log("\nI · categoria igual, sem a utilização, NÃO aparece");
{
  // A base não devolve o produto porque ele não tem a linha em
  // ProdutoUtilizacao — mesmo tendo categoria CONTROLO DE PESO.
  const { fake, chamadas } = prismaFalso({ produto: [] });
  const ids = await restringirPorCatalogo(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fake as any,
    { utilizacoes: ["controlo-de-peso"] },
    null,
  );
  eq(ids, [], "conjunto vazio — a categoria não o resgata");
  const where = JSON.stringify(chamadas[0].where);
  check(
    !where.toLowerCase().includes("categoria"),
    "não há nenhuma condição de categoria por onde ele pudesse entrar",
  );
}

console.log("\nJ · Categoria + Utilização combinam por AND");
{
  // `actual` são os ids que o filtro de CATEGORIA já apurou. A
  // utilização tem de INTERSECTAR, não substituir.
  const { fake, chamadas } = prismaFalso({ produto: [{ id: "p2" }] });
  const ids = await restringirPorCatalogo(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fake as any,
    { utilizacoes: ["controlo-de-peso"] },
    ["p1", "p2", "p3"],
  );
  eq(ids, ["p2"], "só o produto que satisfaz os DOIS grupos");

  const where = JSON.stringify(chamadas[0].where);
  check(where.includes('"in":["p1","p2","p3"]'), "a query intersecta com o conjunto anterior");

  // Sem categoria escolhida, a utilização não é restringida por nada.
  const { chamadas: c2, fake: f2 } = prismaFalso({ produto: [{ id: "x" }] });
  await restringirPorCatalogo(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    f2 as any,
    { utilizacoes: ["controlo-de-peso"] },
    null,
  );
  check(
    !JSON.stringify(c2[0].where).includes('"id"'),
    "sem categoria seleccionada, nenhum limite de id é imposto",
  );

  // Selecção vazia não filtra.
  eq(temFiltroCatalogo({ utilizacoes: [] }), false, "utilizações vazias ⇒ não filtra");
  eq(temFiltroCatalogo({ utilizacoes: ["x"] }), true, "uma utilização ⇒ filtra");

  // E no loader das Margens, categoria e utilização são passos
  // separados que se encadeiam pelo mesmo `produtoIdFilter`.
  check(
    dados.includes("produtoIdFilter = await restringirPorCatalogo(prisma, filters, produtoIdFilter)"),
    "Margens encadeia o filtro de catálogo sobre o de categoria",
  );
  check(
    dados.includes('where: { tipo: "NIVEL_1", estado: "ATIVO", nome: { in: filters.categorias } }'),
    "Categoria filtra NIVEL_1, e só NIVEL_1",
  );
}

// ══════════════════════════════════════════════════════════════════════
// K · RELATÓRIO / PDF / EXCEL
// ══════════════════════════════════════════════════════════════════════
console.log("\nK · as duas colunas no relatório");
{
  const linha: MargemRow = {
    cnp: 5880034,
    designacao: "Depuralina Cápsulas x60",
    categoria: "SUPLEMENTOS ALIMENTARES",
    grupo: null,
    farmaciaId: "f1",
    farmacia: "Silveirense",
    fabricante: "MENARINI",
    qtdVendida: 22,
    valorVendido: 307.08,
    pvpUnitario: 13.96,
    custoUnitario: 13.35,
    valorVendidoSemIva: 289.7,
    taxaIva: 6,
    custoUnitarioBase: 13.35,
    custoEstimado: 293.7,
    margemEur: -4,
    margemPct: null,
    coberturaCusto: 1,
    estado: "FIAVEL",
  };
  const semQtd: MargemRow = { ...linha, qtdVendida: 0, pvpUnitario: null, custoUnitario: null };

  const report = buildMargensProdutoReport({
    rows: [linha, semQtd],
    filters: {},
    universe: { farmacias: [], categorias: [], fabricantes: [], distribuidores: [] },
    organization: "Grupo",
  });

  const chaves = report.columns.map((c) => c.key);
  check(chaves.includes("pvpUnitario"), "coluna PVP unit. no relatório");
  check(chaves.includes("custoUnitario"), "coluna Custo unit. no relatório");

  const rotulos = report.columns.map((c) => c.label);
  eq(
    rotulos.filter((l) =>
      ["Qtd", "PVP unit.", "Vendas c/IVA", "IVA %", "Vendas s/IVA", "Custo unit.", "Custo est.", "Margem €", "Margem %"].includes(l),
    ),
    ["Qtd", "PVP unit.", "Vendas c/IVA", "IVA %", "Vendas s/IVA", "Custo unit.", "Custo est.", "Margem €", "Margem %"],
    "ordem: preço unitário → custo unitário → margem",
  );

  eq(report.rows[0].pvpUnitario, 13.96, "o valor viaja para a linha do relatório");
  eq(report.rows[0].custoUnitario, 13.35, "idem para o custo unitário");
  eq(report.rows[1].pvpUnitario, null, "qtd 0 ⇒ null (o renderer pinta —)");

  // Somar preços unitários de artigos diferentes não significa nada.
  const pvpCol = report.columns.find((c) => c.key === "pvpUnitario");
  const custoCol = report.columns.find((c) => c.key === "custoUnitario");
  check(!pvpCol?.showTotal, "PVP unit. não é totalizado");
  check(!custoCol?.showTotal, "Custo unit. não é totalizado");

  // O mesmo `Report` alimenta ecrã, impressão, PDF e Excel — uma coluna
  // aqui aparece nos quatro.
  check(
    adaptador.includes('key: "pvpUnitario"') && adaptador.includes('key: "custoUnitario"'),
    "as colunas estão no adaptador partilhado pelos quatro outputs",
  );
  check(
    cliente.includes("{fmtCurrency(r.pvpUnitario)}") &&
      cliente.includes("{fmtCurrency(r.custoUnitario)}"),
    "e na tabela do ecrã",
  );
}

}

// ====================================================================
// `tsx` compila para CJS, onde nao ha top-level await: os testes que
// exercitam o Prisma falso vivem dentro desta funcao.
principal().then(() => {
  console.log(`\n${ok} ok, ${ko} falhas`);
  process.exit(ko === 0 ? 0 : 1);
});
