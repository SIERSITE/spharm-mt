/**
 * scripts/tests/test-reconciliar-dia.ts
 *
 * Fixa a secção 5 do reconciliador: os CNP conhecidos, um a um.
 *
 * ── O DEFEITO QUE ISTO IMPEDE DE VOLTAR ──────────────────────────────
 *
 * A secção 5 devolvia `liquido=0` para CNPs que existiam no raw. A query
 * estava certa e devolvia as linhas certas; o erro estava a seguir, em
 * JavaScript:
 *
 *     const linhas = detalhe.filter((d) => d.cnp === alvo.cnp);
 *
 * `Produto.cnp` é `Int @unique`, o Postgres devolve-o como número, e
 * `alvo.cnp` era uma string vinda de `--cnps`. `9599258 === "9599258"`
 * é falso, o filtro nunca casava, e todos os produtos davam zero.
 *
 * O tipo declarado na query dizia `cnp: string | null` — e o TypeScript
 * aceitou-o sem se queixar, porque o genérico de `$queryRaw` é uma
 * ASSERÇÃO, não uma verificação. Um tipo errado ali não dá erro de
 * compilação: dá um resultado errado em produção.
 *
 * Por isso o que se testa aqui é a função pura, com os números reais do
 * dia. Sem base de dados: um teste que precisasse de Postgres para isto
 * nunca teria sido escrito, e o defeito continuava lá.
 *
 * Uso: npx tsx scripts/tests/test-reconciliar-dia.ts
 */
import { readFileSync } from "node:fs";
import {
  alvosCnp,
  parseCnps,
  resumirPorCnp,
  type LinhaCnp,
} from "../vendas/reconciliar-dia";

/** O fonte do reconciliador, para as asserções estruturais. */
const FONTE = readFileSync(
  new URL("../vendas/reconciliar-dia.ts", import.meta.url),
  "utf8",
);

let pass = 0;
let fail = 0;
const ok = (l: string) => { pass++; console.log(`  [OK]    ${l}`); };
const bad = (l: string, d?: string) => { fail++; console.log(`  [FALHA] ${l}${d ? `\n            ${d}` : ""}`); };
const check = (c: boolean, l: string, d?: string) => (c ? ok(l) : bad(l, d));
const eq = (a: unknown, b: unknown, l: string) =>
  check(JSON.stringify(a) === JSON.stringify(b), l, `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);

const G = "ATENDIMENTO_DETALHE";
const VSG = "ATENDIMENTO_SUSP_DETALHE";

/**
 * O dia real: Silveirense, 01/08/2026.
 *
 * Os dois primeiros vêm do circuito VSG — são os que estiveram invisíveis
 * durante meses e têm prova documental (VSG/54684 e VSG/54688). Os
 * restantes nove são do balcão.
 */
const ESPERADO: Array<[number, number, string]> = [
  [9599258, 2, VSG],
  [3626884, 1, VSG],
  [5667761, 1, G],
  [5002639, 1, G],
  [5304472, 1, G],
  [7888784, 1, G],
  [7888800, 1, G],
  [5674239, 1, G],
  [3742780, 1, G],
  [5736335, 1, G],
  [9629113, 1, G],
];

/** As linhas tal como a query as devolve: `cnp` NÚMERO, não string. */
const LINHAS: LinhaCnp[] = ESPERADO.map(([cnp, qtd, ns]) => ({
  cnp,
  designacao: `PRODUTO ${cnp}`,
  sourceNamespace: ns,
  classe: "VENDA",
  unidades: qtd,
  documentos: ns === VSG ? (cnp === 9599258 ? "VSG/54684" : "VSG/54688") : "G/816760",
}));

console.log("=== os 11 CNP do dia, um a um ===");
{
  const alvos = alvosCnp(ESPERADO.map(([cnp]) => cnp));
  const resumos = resumirPorCnp(LINHAS, alvos);
  for (const [cnp, qtd] of ESPERADO) {
    const r = resumos.find((x) => x.cnp === cnp);
    check(r !== undefined, `${cnp} aparece no resumo`);
    eq(r?.liquido, qtd, `${cnp} → ${qtd}`);
  }
  eq(resumos.length, ESPERADO.length, "nem um CNP a mais nem a menos");
}

console.log("\n=== os dois gates obrigatórios ===");
{
  // Estes dois vêm com `esperado` embutido no reconciliador, porque têm
  // prova visual no ERP. Os outros nove entram por --cnps sem esperado.
  const resumos = resumirPorCnp(LINHAS, alvosCnp([]));
  const nimed = resumos.find((r) => r.cnp === 9599258);
  const enalapril = resumos.find((r) => r.cnp === 3626884);
  eq(nimed?.liquido, 2, "9599258 NIMED = 2");
  eq(nimed?.bate, true, "…e bate com o esperado");
  eq(enalapril?.liquido, 1, "3626884 ENALAPRIL = 1");
  eq(enalapril?.bate, true, "…e bate com o esperado");
  eq(nimed?.nome, "PRODUTO 9599258", "a designação vem do catálogo, não do alvo");
}

console.log("\n=== a comparação é numérica, não textual ===");
{
  // O defeito exacto. Se alguém voltar a comparar com string, isto cai.
  const resumos = resumirPorCnp(LINHAS, [
    { cnp: 9599258, nome: "NIMED", esperado: 2 },
  ]);
  eq(resumos[0]?.liquido, 2, "cnp numérico casa com cnp numérico");
  check(typeof LINHAS[0]!.cnp === "number", "a linha traz o cnp como NÚMERO");
  check(typeof resumos[0]!.cnp === "number", "…e o resumo também");

  // A prova pela negativa: com o cnp em string, nada casa. É o estado
  // anterior, escrito de propósito para se ver o que estava a acontecer.
  const comoDantes = (LINHAS as unknown as Array<{ cnp: unknown }>).filter(
    (l) => (l.cnp as unknown) === ("9599258" as unknown),
  );
  eq(comoDantes.length, 0, "9599258 === \"9599258\" é falso — era isto que dava zero");
}

console.log("\n=== somar várias linhas do mesmo CNP ===");
{
  // Um produto vendido em G e em VSG no mesmo dia soma os dois; uma NC
  // do circuito G reduz. É o mesmo sinal que a agregação aplica.
  const misto: LinhaCnp[] = [
    { cnp: 5667761, designacao: "X", sourceNamespace: G, classe: "VENDA", unidades: 3, documentos: "G/1" },
    { cnp: 5667761, designacao: "X", sourceNamespace: VSG, classe: "VENDA", unidades: 2, documentos: "VSG/1" },
    { cnp: 5667761, designacao: "X", sourceNamespace: G, classe: "DEVOLUCAO_ANULACAO", unidades: -1, documentos: "G/2" },
  ];
  const r = resumirPorCnp(misto, [{ cnp: 5667761, nome: "", esperado: 4 }]);
  eq(r[0]?.liquido, 4, "3 + 2 − 1 = 4");
  eq(r[0]?.bate, true, "…e bate com o esperado");
  eq(r[0]?.linhas.length, 3, "as três linhas ficam visíveis no detalhe");
}

console.log("\n=== um CNP sem linhas não inventa nada ===");
{
  const r = resumirPorCnp(LINHAS, [{ cnp: 1234567, nome: "", esperado: Number.NaN }]);
  eq(r[0]?.liquido, 0, "CNP sem linhas → líquido 0");
  eq(r[0]?.bate, null, "…e sem esperado não há veredicto");
  eq(r[0]?.linhas.length, 0, "…e nenhuma linha no detalhe");
}
{
  const r = resumirPorCnp(LINHAS, [{ cnp: 9599258, nome: "NIMED", esperado: 99 }]);
  eq(r[0]?.bate, false, "esperado errado é reportado como falha, não arredondado");
}

console.log("\n=== --cnps aceita inteiros e recusa o resto ===");
{
  eq(parseCnps("9599258,3626884"), [9599258, 3626884], "lista simples");
  eq(parseCnps(" 9599258 , 3626884 "), [9599258, 3626884], "espaços à volta");
  eq(parseCnps(""), [], "vazio → nenhum");
  eq(parseCnps(undefined), [], "ausente → nenhum");
  for (const mau of ["abc", "9599258,abc", "95992.58", "-9599258", "95 99258"]) {
    let atirou = false;
    try { parseCnps(mau); } catch { atirou = true; }
    check(atirou, `"${mau}" é recusado`, "um CNP mal escrito não pode desaparecer em silêncio");
  }
}

console.log("\n=== alvosCnp não duplica os provados ===");
{
  const a = alvosCnp([9599258, 3626884, 5667761]);
  eq(a.length, 3, "os dois provados + um novo = 3, não 5");
  eq(a.filter((x) => x.cnp === 9599258).length, 1, "9599258 aparece uma vez");
  eq(a[0]?.esperado, 2, "…e mantém o esperado do provado, não o NaN do extra");
  eq(a.map((x) => x.cnp), [9599258, 3626884, 5667761], "provados primeiro, pela ordem conhecida");
}

console.log("\n=== a secção 5 usa a mesma janela das secções 1/2 ===");
{
  const src = FONTE;
  // Todas as queries do dia partilham a mesma fronteira meio-aberta.
  const janelas = src.match(/"dataVenda" >= \$\{de\} AND r?\.?"?dataVenda"? < \$\{ate\}/g) ?? [];
  check(janelas.length >= 4, `a mesma janela em ${janelas.length} queries`);
  check(
    !/JOIN "Produto" p ON p\."id" = r\."produtoId"[\s\S]{0,300}isNonStockService/.test(src),
    "a secção 5 não acrescenta filtros que as secções 1/2 não têm",
  );
  check(
    src.includes('p."cnp" = ANY(${listaCnp}::int[])'),
    "o filtro por CNP é numérico e explícito (::int[])",
  );
  check(
    src.includes('JOIN "Produto" p ON p."id" = r."produtoId"'),
    "a resolução é produtoId → Produto.id",
  );
  // Sem comentários: o cabeçalho EXPLICA que o CNP não é o
  // externalProductId, e um detector que leia prosa acusa a própria
  // documentação. Já aconteceu duas vezes nesta base de código.
  const codigo = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join("\n");
  check(
    !/externalProductId|codigoId/i.test(codigo),
    "…e não usa externalProductId nem codigoId como se fossem o CNP",
  );
  check(
    src.includes("produtoId\" IS NULL"),
    "linhas sem produtoId são contadas e reportadas, não engolidas pelo JOIN",
  );
}

console.log("\n=== importar o módulo NÃO arranca o CLI ===");
{
  // Se arrancar, o `process.exit` do CLI compete com o do teste e o
  // resultado passa a depender de qual chega primeiro. A guarda tem de
  // ancorar no separador de caminho: sem isso, `test-reconciliar-dia.ts`
  // também casa com `reconciliar-dia.ts` e o CLI arranca a meio do teste.
  const src = FONTE;
  check(
    /\[\\\\\/\]reconciliar-dia\\\.\(/.test(src) || src.includes("[\\\\/]reconciliar-dia"),
    "a guarda ancora no separador de caminho",
  );
  // A propriedade que interessa: `main()` não está no topo do módulo.
  // Ao nível zero de indentação corre sempre que alguém importa.
  check(
    !/^main\(\)/m.test(src),
    "main() não é chamado ao nível do módulo",
    "ao nível zero, corre sempre que alguém importa o ficheiro",
  );
  check(src.includes("process.argv[1]"), "…a guarda olha para o argv[1]");
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail === 0 ? 0 : 1);
