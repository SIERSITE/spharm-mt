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
const ESPERADO_VSG: Array<[number, number]> = [
  [9599258, 2],
  [3626884, 1],
  [5667761, 1],
  [5002639, 1],
  [5304472, 1],
  [7888784, 1],
  [7888800, 1],
  [5674239, 1],
  [3742780, 1],
  [5736335, 1],
  [9629113, 1],
];

/** As linhas VSG, tal como a query as devolve: `cnp` NÚMERO, não string. */
const LINHAS_VSG: LinhaCnp[] = ESPERADO_VSG.map(([cnp, qtd]) => ({
  cnp,
  designacao: `PRODUTO ${cnp}`,
  sourceNamespace: VSG,
  classe: "VENDA",
  unidades: qtd,
  documentos: cnp === 9599258 ? "VSG/54684" : cnp === 3742780 ? "VSG/54685" : "VSG/54688",
}));

/**
 * As vendas de BALCÃO do mesmo dia, nos mesmos artigos.
 *
 * Documentos distintos, horas distintas — dois eventos reais, não uma
 * duplicação. É por causa destes que o gate não pode ser sobre o
 * líquido total do artigo.
 */
const LINHAS_G: LinhaCnp[] = [
  { cnp: 9599258, designacao: "PRODUTO 9599258", sourceNamespace: G, classe: "VENDA", unidades: 1, documentos: "G/816801" },
  { cnp: 3742780, designacao: "PRODUTO 3742780", sourceNamespace: G, classe: "VENDA", unidades: 1, documentos: "G/816860" },
];

const LINHAS: LinhaCnp[] = [...LINHAS_VSG, ...LINHAS_G];

console.log("=== os 11 CNP do dia: o gate é sobre VSG ===");
{
  const resumos = resumirPorCnp(LINHAS, alvosCnp([]));
  for (const [cnp, qtd] of ESPERADO_VSG) {
    const r = resumos.find((x) => x.cnp === cnp);
    check(r !== undefined, `${cnp} aparece no resumo`);
    eq(r?.vsg, qtd, `${cnp} → VSG = ${qtd}`);
    eq(r?.bate, true, `…e o gate passa`);
  }
  eq(resumos.length, ESPERADO_VSG.length, "nem um CNP a mais nem a menos");
  eq(resumos.filter((r) => r.bate === true).length, 11, "11/11 no gate VSG");
}

console.log("\n=== venda de balcão no mesmo dia NÃO é duplicação ===");
{
  // Os dois casos que mostraram que o gate anterior estava errado.
  const resumos = resumirPorCnp(LINHAS, alvosCnp([]));
  const nimed = resumos.find((r) => r.cnp === 9599258)!;
  eq(nimed.vsg, 2, "9599258: VSG = 2  (VSG/54684, 10:26:38)");
  eq(nimed.g, 1, "…mais 1 de balcão  (G, 12:48:26)");
  eq(nimed.liquido, 3, "…logo o total do dia é 3");
  eq(nimed.bate, true, "…e o gate passa na mesma, porque mede o VSG");

  const eutirox = resumos.find((r) => r.cnp === 3742780)!;
  eq(eutirox.vsg, 1, "3742780: VSG = 1  (VSG/54685, 10:39:04)");
  eq(eutirox.g, 1, "…mais 1 de balcão  (G, 18:17:16)");
  eq(eutirox.liquido, 2, "…logo o total do dia é 2");
  eq(eutirox.bate, true, "…e o gate passa na mesma");

  // O que o gate anterior fazia: media o líquido e acusava estes dois.
  eq(nimed.liquido === 2, false, "um gate sobre o líquido acusaria o 9599258");
  eq(eutirox.liquido === 1, false, "…e o 3742780");

  const outro = resumos.find((r) => r.cnp === 3626884)!;
  eq(outro.g, 0, "3626884 não teve balcão nesse dia");
  eq(outro.liquido, 1, "…logo o líquido coincide com o VSG");
  eq(nimed.nome, "PRODUTO 9599258", "a designação vem do catálogo, não do alvo");
}

console.log("\n=== a comparação é numérica, não textual ===");
{
  // O defeito exacto. Se alguém voltar a comparar com string, isto cai.
  const resumos = resumirPorCnp(LINHAS, [
    { cnp: 9599258, nome: "NIMED", esperadoVsg: 2 },
  ]);
  eq(resumos[0]?.vsg, 2, "cnp numérico casa com cnp numérico");
  check(typeof LINHAS[0]!.cnp === "number", "a linha traz o cnp como NÚMERO");
  check(typeof resumos[0]!.cnp === "number", "…e o resumo também");

  // A prova pela negativa: com o cnp em string, nada casa. É o estado
  // anterior, escrito de propósito para se ver o que estava a acontecer.
  const comoDantes = (LINHAS as unknown as Array<{ cnp: unknown }>).filter(
    (l) => (l.cnp as unknown) === ("9599258" as unknown),
  );
  eq(comoDantes.length, 0, "9599258 === \"9599258\" é falso — era isto que dava zero");
}

console.log("\n=== G, VSG, NC e líquido, todos visíveis ===");
{
  // O relatório continua a mostrar as quatro medidas. O gate decide
  // sobre uma delas; as outras três são para se ver o dia.
  const misto: LinhaCnp[] = [
    { cnp: 5667761, designacao: "X", sourceNamespace: G, classe: "VENDA", unidades: 3, documentos: "G/1" },
    { cnp: 5667761, designacao: "X", sourceNamespace: VSG, classe: "VENDA", unidades: 2, documentos: "VSG/1" },
    { cnp: 5667761, designacao: "X", sourceNamespace: G, classe: "DEVOLUCAO_ANULACAO", unidades: -1, documentos: "G/2" },
  ];
  const r = resumirPorCnp(misto, [{ cnp: 5667761, nome: "", esperadoVsg: 2 }])[0]!;
  eq(r.vsg, 2, "VSG = 2");
  eq(r.g, 3, "G = 3 (a venda, sem a reversão)");
  eq(r.reversoes, -1, "NC = −1");
  eq(r.liquido, 4, "líquido = 3 + 2 − 1 = 4");
  eq(r.bate, true, "o gate olha para o VSG, e passa");
  eq(r.linhas.length, 3, "as três linhas ficam visíveis no detalhe");
}

console.log("\n=== um CNP sem linhas não inventa nada ===");
{
  const r = resumirPorCnp(LINHAS, [{ cnp: 1234567, nome: "", esperadoVsg: Number.NaN }]);
  eq(r[0]?.vsg, 0, "CNP sem linhas → VSG 0");
  eq(r[0]?.liquido, 0, "…e líquido 0");
  eq(r[0]?.bate, null, "…e sem esperado não há veredicto");
  eq(r[0]?.linhas.length, 0, "…e nenhuma linha no detalhe");
}
{
  const r = resumirPorCnp(LINHAS, [{ cnp: 9599258, nome: "NIMED", esperadoVsg: 99 }]);
  eq(r[0]?.bate, false, "esperado errado é reportado como falha, não arredondado");
}
{
  // O caso que importa: o artigo existe e vendeu ao balcão, mas a venda
  // suspensa NÃO chegou. O líquido não é zero e o gate tem de acusar.
  const soBalcao: LinhaCnp[] = [
    { cnp: 9599258, designacao: "NIMED", sourceNamespace: G, classe: "VENDA", unidades: 1, documentos: "G/816801" },
  ];
  const r = resumirPorCnp(soBalcao, [{ cnp: 9599258, nome: "NIMED", esperadoVsg: 2 }])[0]!;
  eq(r.liquido, 1, "há líquido…");
  eq(r.vsg, 0, "…mas VSG = 0");
  eq(r.bate, false, "…e o gate acusa — é esta a falha que interessa apanhar");
}

console.log("\n=== --cnps aceita CNP e CNP:esperado ===");
{
  eq(
    parseCnps("9599258,3626884"),
    [{ cnp: 9599258, esperadoVsg: NaN }, { cnp: 3626884, esperadoVsg: NaN }],
    "lista simples, sem expectativa",
  );
  eq(
    parseCnps("9599258:2,3742780:1"),
    [{ cnp: 9599258, esperadoVsg: 2 }, { cnp: 3742780, esperadoVsg: 1 }],
    "com o VSG esperado por CNP",
  );
  eq(parseCnps(""), [], "vazio → nenhum");
  eq(parseCnps(undefined), [], "ausente → nenhum");
  for (const mau of ["abc", "9599258,abc", "95992.58", "-9599258", "95 99258", "9599258:", "9599258:x"]) {
    let atirou = false;
    try { parseCnps(mau); } catch { atirou = true; }
    check(atirou, `"${mau}" é recusado`, "um CNP mal escrito não pode desaparecer em silêncio");
  }
}

console.log("\n=== alvosCnp: os 11 provados, sem duplicar ===");
{
  const a = alvosCnp([]);
  eq(a.length, 11, "os 11 CNP da população VSG em falta");
  eq(a[0]?.esperadoVsg, 2, "9599258 espera 2 unidades VSG");
  eq(a.filter((x) => x.esperadoVsg === 1).length, 10, "os outros dez esperam 1");

  const b = alvosCnp([{ cnp: 9599258, esperadoVsg: NaN }, { cnp: 1234567, esperadoVsg: NaN }]);
  eq(b.length, 12, "repetir um provado não o duplica; um novo acrescenta");
  eq(b.find((x) => x.cnp === 9599258)?.esperadoVsg, 2, "…e o provado mantém o seu esperado");

  // Dois números para a mesma coisa, com um a ganhar em silêncio, é como
  // se perde a confiança num relatório.
  let atirou = false;
  try { alvosCnp([{ cnp: 9599258, esperadoVsg: 5 }]); } catch { atirou = true; }
  check(atirou, "um esperado em conflito com o provado ATIRA, não escolhe");
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

console.log("\n=== reversões nos dois circuitos: reporta, NÃO deduplica ===");
{
  // Até à rev72 uma reversão no circuito suspenso era erro fatal — o
  // circuito não tinha reversões próprias, portanto qualquer uma era
  // dupla contagem. O ERP refutou-o: Silveirense 2 078 linhas negativas
  // em VSG 107, Segurado 583 em VSC 107 e 5 em VSC 102, em pares +N/−N.
  check(
    !/HA REVERSOES NO CIRCUITO VSG/.test(FONTE),
    "reversões no circuito suspenso deixaram de ser erro fatal",
    "são legítimas: a anulação de uma venda suspensa pode viver no próprio circuito",
  );
  // A suspeita fica, mas é suspeita. Produto+dia não é identidade
  // documental — dois clientes podem devolver o mesmo artigo no mesmo
  // dia por vias diferentes, e deduplicar por essa hipótese apagava uma
  // devolução verdadeira.
  check(
    /REVERSOES NOS DOIS CIRCUITOS NO MESMO DIA/.test(FONTE),
    "…e passaram a ser DETECTADAS e reportadas quando ocorrem nos dois",
  );
  check(
    /NAO e um erro e NAO foi deduplicado/.test(FONTE),
    "…com o relatório a dizer explicitamente que não deduplicou",
  );
  check(
    /identidade documental/.test(FONTE),
    "…e porquê: produto+dia não é identidade documental",
  );
  // O gate não pode contar isto como problema: bloquearia o backfill por
  // uma hipótese que ninguém confirmou.
  const bloco = FONTE.slice(
    FONTE.indexOf("REVERSOES NOS DOIS CIRCUITOS"),
    FONTE.indexOf("3. DOCUMENTOS POR SERIE"),
  );
  check(
    bloco.length > 0 && !/problemas\+\+/.test(bloco),
    "a suspeita NÃO incrementa o contador de problemas",
    "bloquear o reader por uma hipótese não verificada é pior do que reportá-la",
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
