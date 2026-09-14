/**
 * scripts/tests/test-fase1-economia-ordenacao.ts
 *
 * Fase 1: preço de custo, valorização dos excessos, preço das
 * transferências e ordenação por cabeçalho.
 *
 * ── O que isto existe para impedir ───────────────────────────────────
 *
 *   A. **Zero a fazer-se passar por custo.** O ERP não distingue «não
 *      sei» de «zero»: escreve 0 nas duas situações, e as colunas de
 *      preço nunca vêm a NULL. Medido no tenant garantia: 95 226 linhas
 *      de ProdutoFarmacia, TODAS com pmc/puc/pvp preenchidos, mas só
 *      73 115 com `pmc > 0`. Um predicado `!== null` daria 22 000
 *      artigos a custar zero euros, e um relatório de capital
 *      imobilizado a somá-los sem dizer nada.
 *
 *   B. **Totais curtos e silenciosos.** Uma coluna de dinheiro onde o
 *      desconhecido vale 0 produz um total que ninguém consegue
 *      auditar: a linha aparece, não soma, e o total está errado para
 *      menos sem nenhum sinal.
 *
 *   C. **Nulos a ocupar o topo.** Numa tabela ordenada por «capital
 *      imobilizado, maior primeiro», as linhas sem custo não são as
 *      maiores nem as menores — não competem. Se levassem o sinal da
 *      direcção, o primeiro ecrã de uma das duas ordens seria feito só
 *      de traços.
 *
 *   D. **Ordenação a chegar ao SQL sem passar por uma lista fechada.**
 *      A chave vem da query-string de /stock. Uma tabela server-side
 *      que cole o nome da coluna vindo do browser no `ORDER BY` é
 *      injecção, por mais inofensiva que a string pareça.
 *
 * Corre com:  npm run test:fase1
 */
import { readFileSync } from "node:fs";
import {
  custoDaFarmacia,
  custoUnitario,
  descreverFonteCusto,
  somarParcial,
  valorizar,
} from "../../lib/produtos/custo-farmacia";
import {
  calcularPrecoReferencia,
  descreverPrecoReferencia,
  desvioFaceAReferencia,
} from "../../lib/produtos/preco-referencia";
import {
  calcularPvpReferencia,
  descreverPvpReferencia,
} from "../../lib/pvp-referencia";
import {
  lerOrdenacaoDeParams,
  ordenarLinhas,
  proximaOrdenacao,
  resolverOrdenacaoSql,
  type EstadoOrdenacao,
} from "../../lib/tabela/ordenacao";

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

const src = (p: string) => readFileSync(p, "utf8");

// ═════════════════════════════════════════════════════════════════════
// A. O custo de uma farmácia
// ═════════════════════════════════════════════════════════════════════
console.log("\nA. Custo: PMC primeiro, PUC em recurso, zero nunca\n");

eq(custoDaFarmacia(3.21, 3.5), { valor: 3.21, fonte: "PMC" }, "com os dois, ganha o PMC");
eq(custoDaFarmacia(null, 3.5), { valor: 3.5, fonte: "PUC" }, "sem PMC, entra o PUC");
eq(custoDaFarmacia(null, null), { valor: null, fonte: null }, "sem nenhum, sem custo");

// A alma do módulo: o zero do ERP.
eq(custoDaFarmacia(0, 3.5), { valor: 3.5, fonte: "PUC" }, "pmc=0 NÃO é custo — cai no PUC");
eq(custoDaFarmacia(0, 0), { valor: null, fonte: null }, "os dois a zero → sem custo");
eq(custoDaFarmacia(0, null), { valor: null, fonte: null }, "pmc=0 e sem puc → sem custo");
eq(custoDaFarmacia(-1, 2), { valor: 2, fonte: "PUC" }, "negativo não é custo");
eq(custoDaFarmacia(NaN, 2), { valor: 2, fonte: "PUC" }, "NaN não é custo");
eq(custoDaFarmacia(undefined, undefined), { valor: null, fonte: null }, "undefined trata-se como null");

eq(custoUnitario(4, 9), 4, "custoUnitario devolve só o número");
eq(custoUnitario(0, 0), null, "custoUnitario devolve null e não 0");

check(
  descreverFonteCusto("PUC").includes("última compra"),
  "a origem PUC é explicada ao utilizador",
);
check(
  descreverFonteCusto(null).includes("sem custo"),
  "a ausência é explicada, não escondida",
);

// ── A regra tem de ser a MESMA do Inventário, que já a tinha ────────
{
  // O Inventário tinha esta regra escrita inline, correcta e sozinha.
  // Agora consome o módulo. Se voltar a ter uma cópia, esta asserção
  // avisa — foi a duplicação que criou o problema que o
  // `catalog-prefilter` documenta.
  const inv = src("lib/inventario-data.ts");
  check(
    inv.includes("custoDaFarmacia") || inv.includes("custoUnitario"),
    "o Inventário usa o módulo central de custo",
  );
  check(
    !/pmc !== null && pmc > 0 \? pmc :/.test(inv),
    "…e já não tem a regra escrita à mão",
  );
}

// ═════════════════════════════════════════════════════════════════════
// B. Valorizar sem inventar
// ═════════════════════════════════════════════════════════════════════
console.log("\nB. Valorizar: null propaga-se, não vira zero\n");

eq(valorizar(10, 2.5), 25, "10 × 2,50 = 25");
eq(valorizar(3, 1.115), 3.35, "arredonda ao cêntimo");
eq(valorizar(10, null), null, "sem preço → null, NUNCA 0");
eq(valorizar(null, 2.5), null, "sem quantidade → null");
eq(valorizar(0, 2.5), 0, "zero unidades a preço conhecido VALEM zero — isso é um facto");

{
  const t = somarParcial([10, 20, null, 30, null]);
  eq(t.total, 60, "soma só o que sabe");
  eq(t.contadas, 3, "conta as linhas somadas");
  eq(t.semValor, 2, "…e as que ficaram de fora");
}
{
  const t = somarParcial([]);
  eq(t, { total: 0, contadas: 0, semValor: 0 }, "lista vazia é um total de zero legítimo");
}
{
  const t = somarParcial([null, null]);
  eq(
    { total: t.total, semValor: t.semValor },
    { total: 0, semValor: 2 },
    "tudo desconhecido: total 0 MAS com 2 assinaladas — é o par que torna o 0 legível",
  );
}

// ═════════════════════════════════════════════════════════════════════
// B2. ZERO CONHECIDO ≠ PREÇO DESCONHECIDO
// ═════════════════════════════════════════════════════════════════════
//
// A distinção que o `valorUnlocked` passou a fazer, e que já valia para
// o custo. São situações diferentes e não podem colapsar no mesmo ecrã:
//
//   · preço conhecido × quantidade zero  →  vale MESMO 0
//   · preço desconhecido                 →  não sabemos, `null`
//
// Medido na produção antes de alterar: 6 linhas em 33 125 sem PVP
// utilizável, e QUATRO delas valem legitimamente zero (duas vacinas do
// contingente SNS, uma oferta Caudalie, um contentor Valormed). O ERP
// escreve `0` nos dois casos. Não conseguimos separá-los no dado — o
// que conseguimos é parar de AFIRMAR que são zero.
console.log("\nB2. Zero conhecido não é o mesmo que preço desconhecido\n");

// ── PVP conhecido, resultado genuinamente zero ──────────────────────
eq(valorizar(0, 12.5), 0, "PVP conhecido × quantidade 0 → ZERO, e é um facto");
eq(valorizar(0, 0.01), 0, "…mesmo com um preço muito pequeno");
check(valorizar(0, 12.5) !== null, "…e NÃO é null: sabemos que vale zero");

// ── PVP ausente ─────────────────────────────────────────────────────
eq(valorizar(10, null), null, "sem PVP → null");
eq(valorizar(10, undefined), null, "sem PVP (undefined) → null");
eq(valorizar(0, null), null, "sem PVP, nem com quantidade zero se afirma zero");

// ── O zero que representa ausência ──────────────────────────────────
//
// Este é o caso que obriga a função `pvpUtilizavel` a existir. O valor
// no ERP É zero; o que não sabemos é se significa «grátis» ou «não sei».
// Quem chama tem de o converter a `null` ANTES de valorizar — é o que
// `pvpUtilizavel` e `custoDaFarmacia` fazem.
eq(custoDaFarmacia(0, 0), { valor: null, fonte: null }, "custo 0/0 → ausência, não zero");
eq(
  valorizar(10, custoDaFarmacia(0, 0).valor),
  null,
  "…e valorizar essa ausência dá null, não 0",
);
eq(
  valorizar(10, custoDaFarmacia(0, 2.5).valor),
  25,
  "…enquanto um PMC a zero com PUC válido valoriza pelo PUC",
);

// ── O total financeiro soma só o valorizável ────────────────────────
{
  // Três linhas valorizadas, duas sem preço. O total é o das três.
  const valores = [100, 250.5, null, 49.5, null];
  const t = somarParcial(valores);
  eq(t.total, 400, "o total soma APENAS as linhas valorizáveis");
  eq(t.contadas, 3, "3 linhas entraram");
  eq(t.semValor, 2, "2 ficaram de fora, e são contadas");
}
{
  // A propriedade que torna a mudança segura: como as linhas sem preço
  // contribuíam `0` antes, o TOTAL não muda. Só passa a haver contagem.
  const comoEraAntes = [100, 250.5, 0, 49.5, 0].reduce((a, b) => a + b, 0);
  const agora = somarParcial([100, 250.5, null, 49.5, null]);
  eq(agora.total, comoEraAntes, "o total é IDÊNTICO ao que o `?? 0` dava");
  check(agora.semValor === 2, "…mas agora sabe-se que 2 linhas não foram valorizadas");
}
{
  // Zeros REAIS continuam a entrar na soma e a contar como valorizados.
  const t = somarParcial([0, 0, 10]);
  eq(t.total, 10, "zeros reais somam zero");
  eq(t.contadas, 3, "…e contam como valorizados, porque são um valor");
  eq(t.semValor, 0, "…e não como ausências");
}
{
  // Nenhuma linha valorizável: total 0 COM a contagem que o explica.
  const t = somarParcial([null, null, null]);
  eq({ total: t.total, contadas: t.contadas, semValor: t.semValor },
     { total: 0, contadas: 0, semValor: 3 },
     "tudo por valorizar: o 0 vem acompanhado das 3 que o explicam");
}

// ═════════════════════════════════════════════════════════════════════
// C. Preço de referência (a moda), agora genérica
// ═════════════════════════════════════════════════════════════════════
console.log("\nC. Referência: a moda do grupo, e não a primeira linha\n");

eq(calcularPrecoReferencia([]).valor, null, "sem valores, sem referência");
eq(calcularPrecoReferencia([null, null]).valor, null, "só nulos, sem referência");

{
  const r = calcularPrecoReferencia([4.5, 4.5, 4.5, 5.0]);
  eq(r.valor, 4.5, "a moda vence a minoria");
  eq(r.farmaciasComEsseValor, 3, "conta quantas a praticam");
  eq(r.farmaciasComPreco, 4, "…em quantas há valor");
  eq(r.unanime, false, "não é unânime");
}
{
  const r = calcularPrecoReferencia([7, 7, 7]);
  eq(r.unanime, true, "todas iguais → unânime");
  check(descreverPrecoReferencia(r).includes("igual nas 3"), "o texto diz que é igual nas três");
}
{
  // Empate resolvido pelo mais baixo — determinístico, não arbitrário.
  const r = calcularPrecoReferencia([9, 9, 3, 3]);
  eq(r.valor, 3, "empate → o mais baixo, para ser reproduzível");
}
{
  // A razão de a chave ser string com 4 casas.
  const r = calcularPrecoReferencia([4.25, 4.25, 4.2501]);
  eq(r.valor, 4.25, "4,2501 é outro preço a quatro casas");
  eq(r.farmaciasComEsseValor, 2, "…e não se funde com 4,2500");
}

eq(desvioFaceAReferencia(5, 4), 1, "mais caro → positivo");
eq(desvioFaceAReferencia(3, 4), -1, "mais barato → negativo");
eq(desvioFaceAReferencia(4, 4), null, "igual → sem desvio a mostrar");
eq(desvioFaceAReferencia(4.25, 4.25), null, "igual a quatro casas → sem desvio");
eq(desvioFaceAReferencia(null, 4), null, "sem preço → sem desvio");
eq(desvioFaceAReferencia(4, null), null, "sem referência → sem desvio");

// O verbo muda conforme a coluna: uma farmácia PRATICA um PVP, mas PAGA
// um custo. Dizer que «pratica» o custo inverteria quem decide o preço.
{
  const r = calcularPrecoReferencia([2, 2, 3]);
  check(descreverPrecoReferencia(r, "pago").startsWith("pago por"), "o custo é «pago por»");
  check(descreverPrecoReferencia(r, "praticado").startsWith("praticado por"), "o PVP é «praticado por»");
}

// A fachada antiga tem de continuar a dar exactamente o mesmo.
{
  const antiga = calcularPvpReferencia([{ pvp: 4.5 }, { pvp: 4.5 }, { pvp: 5 }]);
  const nova = calcularPrecoReferencia([4.5, 4.5, 5]);
  eq(antiga, nova, "lib/pvp-referencia delega no motor genérico, sem divergir");
  eq(descreverPvpReferencia(calcularPvpReferencia([{ pvp: 4 }])), "única farmácia com preço",
     "…e preserva o texto que o teste antigo fixa");
}

// ═════════════════════════════════════════════════════════════════════
// D. Ordenação — o ciclo
// ═════════════════════════════════════════════════════════════════════
console.log("\nD. Ordenação: primeiro clique ascendente, segundo descendente\n");

eq(proximaOrdenacao(null, "valor"), { coluna: "valor", direcao: "asc" }, "1.º clique → ascendente");
eq(
  proximaOrdenacao({ coluna: "valor", direcao: "asc" }, "valor"),
  { coluna: "valor", direcao: "desc" },
  "2.º clique → descendente",
);
eq(
  proximaOrdenacao({ coluna: "valor", direcao: "desc" }, "valor"),
  { coluna: "valor", direcao: "asc" },
  "3.º clique volta a ascendente (não a «sem ordem»)",
);
eq(
  proximaOrdenacao({ coluna: "valor", direcao: "desc" }, "outra"),
  { coluna: "outra", direcao: "asc" },
  "coluna nova começa SEMPRE em ascendente, não herda a direcção",
);

// ═════════════════════════════════════════════════════════════════════
// E. Ordenação — onde vão os nulos
// ═════════════════════════════════════════════════════════════════════
console.log("\nE. A ausência não compete no ranking\n");

type L = { nome: string; valor: number | null };
const linhas: L[] = [
  { nome: "b", valor: 20 },
  { nome: "a", valor: null },
  { nome: "d", valor: 5 },
  { nome: "c", valor: null },
];
const ac = (l: L, k: "nome" | "valor") => l[k];

{
  const r = ordenarLinhas(linhas, { coluna: "valor", direcao: "desc" }, ac);
  eq(r.map((l) => l.nome), ["b", "d", "a", "c"], "desc: maior primeiro, nulos no FIM");
}
{
  const r = ordenarLinhas(linhas, { coluna: "valor", direcao: "asc" }, ac);
  eq(r.map((l) => l.nome), ["d", "b", "a", "c"], "asc: menor primeiro, nulos TAMBÉM no fim");
}
{
  // A estabilidade é o que faz os nulos manterem a ordem da fonte entre si.
  const r = ordenarLinhas(linhas, { coluna: "valor", direcao: "asc" }, ac);
  eq(r.slice(2).map((l) => l.nome), ["a", "c"], "entre nulos, a ordem da fonte é preservada");
}

// Acentos: o `localeCompare` pt-PT e não a comparação binária.
{
  type S = { n: string };
  const rows: S[] = [{ n: "Zinco" }, { n: "Ácido" }, { n: "Bromazepam" }];
  const r = ordenarLinhas(rows, { coluna: "n", direcao: "asc" }, (x: S) => x.n);
  eq(r.map((x) => x.n), ["Ácido", "Bromazepam", "Zinco"], "«Ácido» vem antes de «Zinco», não depois");
}
// Números dentro de texto.
{
  type S = { n: string };
  const rows: S[] = [{ n: "Item 10" }, { n: "Item 2" }];
  const r = ordenarLinhas(rows, { coluna: "n", direcao: "asc" }, (x: S) => x.n);
  eq(r.map((x) => x.n), ["Item 2", "Item 10"], "«Item 2» antes de «Item 10»");
}
// Não muta a fonte.
{
  const original = [...linhas];
  ordenarLinhas(linhas, { coluna: "valor", direcao: "desc" }, ac);
  eq(linhas, original, "ordenar NÃO muta o array recebido");
}
// Sem ordenação → cópia na ordem da fonte.
{
  const r = ordenarLinhas(linhas, null, ac);
  eq(r.map((l) => l.nome), ["b", "a", "d", "c"], "sem estado → ordem da fonte");
  check(r !== linhas, "…mas ainda assim uma cópia");
}

// ═════════════════════════════════════════════════════════════════════
// F. Ordenação server-side — a lista fechada
// ═════════════════════════════════════════════════════════════════════
console.log("\nF. A chave do browser nunca chega crua ao ORDER BY\n");

const MAPA = {
  produto: "p.designacao",
  stock: 'pf."stockAtual"',
} as const;
const FALLBACK = { coluna: "produto" as const, direcao: "asc" as const };
const DESEMPATE = 'pf."produtoId" ASC';

{
  const r = resolverOrdenacaoSql({ coluna: "stock", direcao: "desc" }, MAPA, FALLBACK, DESEMPATE);
  eq(r.sql, 'pf."stockAtual" DESC NULLS LAST, pf."produtoId" ASC', "chave válida → coluna e direcção");
}
{
  const r = resolverOrdenacaoSql(null, MAPA, FALLBACK, DESEMPATE);
  eq(r.coluna, "produto", "sem pedido → o fallback");
  eq(r.direcao, "asc", "…na direcção do fallback");
}
{
  // A asserção que interessa: uma chave hostil não passa.
  const hostil: EstadoOrdenacao<string> = {
    coluna: 'x"; DROP TABLE "Produto"; --',
    direcao: "asc",
  };
  const r = resolverOrdenacaoSql(hostil, MAPA, FALLBACK, DESEMPATE);
  check(!r.sql.includes("DROP"), "chave desconhecida NÃO chega ao SQL");
  eq(r.coluna, "produto", "…cai no fallback em silêncio, sem erro 500");
}
{
  // Um bookmark antigo com uma coluna que já não existe é o caso comum
  // desta defesa — muito mais provável que um ataque.
  const r = resolverOrdenacaoSql({ coluna: "colunaQueJaNaoExiste", direcao: "desc" }, MAPA, FALLBACK, DESEMPATE);
  eq(r.coluna, "produto", "bookmark antigo → ordem por omissão");
}
{
  const r = resolverOrdenacaoSql({ coluna: "stock", direcao: "asc" }, MAPA, FALLBACK, DESEMPATE);
  check(r.sql.includes("NULLS LAST"), "NULLS LAST também em ascendente");
  check(r.sql.endsWith(DESEMPATE), "o desempate vai SEMPRE — sem ele a paginação repete linhas");
}

eq(lerOrdenacaoDeParams({ ord: "stock", dir: "desc" }), { coluna: "stock", direcao: "desc" }, "lê da query-string");
eq(lerOrdenacaoDeParams({ ord: "stock", dir: "lixo" }), { coluna: "stock", direcao: "asc" }, "direcção inválida → ascendente");
eq(lerOrdenacaoDeParams({}), null, "sem `ord` → sem ordenação");
eq(lerOrdenacaoDeParams({ ord: "  " }), null, "`ord` em branco → sem ordenação");

// ═════════════════════════════════════════════════════════════════════
// G. Onde isto tem de estar ligado
// ═════════════════════════════════════════════════════════════════════
console.log("\nG. As quatro superfícies estão mesmo ligadas ao motor\n");

{
  const td = src("lib/transferencias-data.ts");
  for (const campo of [
    "pvpOrigem",
    "custoOrigem",
    "fonteCustoOrigem",
    "valorCustoExcesso",
    "valorPvpExcesso",
    "valorCustoTransferencia",
  ]) {
    check(td.includes(`${campo}:`), `o loader devolve \`${campo}\``);
  }
  check(td.includes("custoDaFarmacia"), "…e calcula-o com o módulo central, não à mão");
  // O valor da transferência é a custo. Se alguém o trocar por PVP, isto
  // acusa — foi uma decisão funcional, não uma escolha de implementação.
  check(
    /valorCustoTransferencia: valorizar\(quantidadeSugerida, custo\)/.test(td),
    "o valor da transferência é quantidade × CUSTO (não × PVP)",
  );
}
{
  // A duplicação do tipo da linha era o que deixava o loader a
  // seleccionar pmc/puc em SQL e a UI a não os conhecer.
  for (const c of [
    "components/excessos/excessos-client.tsx",
    "components/transferencias/transferencias-client.tsx",
  ]) {
    const t = src(c);
    check(
      t.includes('import type { TransferSuggestionRow } from "@/lib/transferencias-data"'),
      `${c}: importa o tipo do loader`,
    );
    check(!/^type TransferSuggestionRow = \{/m.test(t), `${c}: …e não tem cópia local`);
    check(t.includes("CabecalhoOrdenavel"), `${c}: usa o cabeçalho partilhado`);
    check(t.includes("ordenarLinhas"), `${c}: …e o motor partilhado`);
  }
}
{
  const ec = src("components/excessos/excessos-client.tsx");
  for (const col of ["pvpOrigem", "custoOrigem", "valorCustoExcesso", "valorPvpExcesso"]) {
    check(ec.includes(`coluna="${col}"`), `Excessos: a coluna ${col} está na tabela e é ordenável`);
  }
  check(ec.includes("somarParcial"), "Excessos: os totais em dinheiro contam as linhas sem valor");
}
{
  const tc = src("components/transferencias/transferencias-client.tsx");
  check(tc.includes('coluna="custoOrigem"'), "Transferências: preço unitário na tabela");
  check(tc.includes('coluna="valorCustoTransferencia"'), "Transferências: valor da linha na tabela");
  check(tc.includes("totalTransferencia"), "Transferências: total global da transferência");
}
{
  // `valorUnlocked` deixou de mentir. A verificação é sobre o CÓDIGO
  // porque o caminho passa por SQL e por um agregador de dashboard que
  // não se instanciam sem base de dados; o comportamento da regra em si
  // está exercitado na secção B2.
  const td = src("lib/transferencias-data.ts");
  check(
    /valorUnlocked: number \| null;/.test(td),
    "valorUnlocked é anulável — um preço desconhecido não é zero",
  );
  check(
    td.includes("pvpUtilizavel"),
    "…e o zero do ERP é convertido a null antes de valorizar",
  );
  check(
    !/valorUnlocked:\s*\n?\s*origem\.pvp != null/.test(td),
    "…e o ternário que devolvia 0 desapareceu",
  );
  const dash = src("lib/dashboard.ts");
  check(dash.includes("somarParcial"), "o dashboard soma com `somarParcial`");
  check(dash.includes("linhasSemPvp"), "…e expõe quantas linhas ficaram sem PVP");
  check(
    !/t\.valorUnlocked \?\? 0/.test(dash),
    "…e já não há `?? 0` a somar zeros silenciosos",
  );
  const dashUi = src("components/dashboard/dashboard-sections.tsx");
  check(dashUi.includes("sem PVP"), "o cartão mostra a contagem ao utilizador");
}
{
  const ficha = src("app/stock/artigo/[cnp]/page.tsx");
  check(ficha.includes("custoDaFarmacia"), "Ficha: custo por farmácia");
  check(ficha.includes("custoReferencia"), "Ficha: custo de referência do grupo");
  check(ficha.includes("Custo de referência"), "…visível ao lado do PVP de referência");
}
{
  // /stock é a tabela paginada no servidor. É AQUI que ordenar em JS
  // seria errado, e é aqui que a ordenação tem de estar no SQL.
  const sd = src("lib/stock-data.ts");
  check(sd.includes("resolverOrdenacaoSql"), "/stock resolve a ordenação contra a lista fechada");
  check(sd.includes("ORDER BY ${Prisma.raw(ord.sql)}"), "…e usa-a no ORDER BY da página");
  check(
    !/ORDER BY p\.designacao ASC, f\.nome ASC/.test(sd),
    "…e já não tem o ORDER BY fixo",
  );
  const sp = src("app/stock/page.tsx");
  check(sp.includes("lerOrdenacaoDeParams"), "a ordenação de /stock vem da query-string");
  const sc = src("components/stock/stock-client.tsx");
  check(sc.includes('p.delete("page")'), "mudar de critério volta à página 1");
}

// ═════════════════════════════════════════════════════════════════════
console.log(`\n${ko === 0 ? "PASSOU" : "FALHOU"} — ${ok} OK, ${ko} falhas\n`);
process.exit(ko === 0 ? 0 : 1);
