/**
 * agent/src/cruzamento-g.test.ts
 *
 * As três queries da §4 do `vendas-susp-tipos`, construídas e verificadas
 * SEM ERP nenhum.
 *
 * ── O DEFEITO QUE ISTO IMPEDE DE VOLTAR ──────────────────────────────
 *
 * A §4 correu contra as DUAS farmácias e partiu nas duas:
 *
 *     Invalid column name 'Serie'
 *
 * `[Atendimento]` não tem coluna `Serie`. Estava escrita à mão numa
 * sonda cujo resto pergunta ao `sys.columns` antes de nomear seja o que
 * for — e o erro chegou sem a query, sem o passo, e a arrastar as três
 * secções seguintes. Duas bases, uma ronda, zero informação.
 *
 * Duas coisas fecham isto. A primeira é a descoberta, que está no
 * comando. A segunda é este ficheiro: as queries são funções puras, e um
 * teste consegue construí-las contra esquemas fictícios — incluindo o
 * caso que rebentou, um circuito G SEM série — e ler o texto inteiro
 * antes de alguém o mandar para produção.
 *
 * Fragmentos correctos não fazem uma query correcta. Já custou uma ronda
 * aprender isso com as vírgulas do SELECT; não se aprende outra vez.
 *
 * Uso: npx tsx agent/src/cruzamento-g.test.ts
 */
import {
  sqlAnulacoesSuspensas,
  sqlCadeiaFtNc,
  sqlCruzProdutoDia,
  type PecasAnulacoes,
  type PecasCadeia,
  type PecasCruzDia,
} from "./commands/vendas-susp-tipos.js";
import { itensDoSelect, validarSelect } from "./sql-validador.js";

let pass = 0;
let fail = 0;
const check = (ok: boolean, label: string, porque?: string) => {
  if (ok) {
    pass++;
    console.log(`  [OK]    ${label}`);
  } else {
    fail++;
    console.log(`  [FALHA] ${label}${porque ? ` — ${porque}` : ""}`);
  }
};

// ─────────────────────────────────────────────────────────────────────
// Verificações estruturais que se aplicam a qualquer uma das três
// ─────────────────────────────────────────────────────────────────────

function problemasGerais(sql: string): string[] {
  const p: string[] = [];
  const conta = (re: RegExp) => (sql.match(re) ?? []).length;
  if (conta(/\(/g) !== conta(/\)/g)) p.push(`parentesis: ${conta(/\(/g)} '(' vs ${conta(/\)/g)} ')'`);
  if (conta(/\[/g) !== conta(/\]/g)) p.push(`brackets: ${conta(/\[/g)} '[' vs ${conta(/\]/g)} ']'`);
  if (conta(/'/g) % 2 !== 0) p.push("número ímpar de aspas simples");
  // A assinatura da rev64: `dbo.` posto duas vezes.
  if (/\[dbo\]\.\[dbo\./.test(sql) || /\bdbo\.dbo\./.test(sql)) p.push("schema qualificado duas vezes");
  if (/,\s*,/.test(sql)) p.push("duas vírgulas seguidas");
  if (/,\s*FROM\b/i.test(sql)) p.push("vírgula imediatamente antes de FROM");
  if (/,\s*\)/.test(sql)) p.push("vírgula antes de fechar parêntesis");
  if (/\bWHERE\s+AND\b/i.test(sql)) p.push("WHERE seguido de AND");
  if (/\bAND\s+AND\b|\bOR\s+OR\b/i.test(sql)) p.push("operador booleano repetido");
  // Uma coluna que não resolveu e ficou como `undefined`/`null` no texto
  // é a forma silenciosa de partir isto.
  if (/\bundefined\b/.test(sql)) p.push("'undefined' interpolado no SQL");
  if (/\.\s*null\b/i.test(sql)) p.push("'null' interpolado como coluna");
  for (const j of sql.match(/\n\s*(?:LEFT\s+|RIGHT\s+|INNER\s+)?JOIN\s+.+/gi) ?? []) {
    if (!/\bON\b/i.test(j)) p.push(`JOIN sem ON: ${j.trim().slice(0, 50)}`);
  }
  return p;
}

/** Os alias do SELECT que começa em `inicio`. */
function aliasDoSelect(sql: string): string[] {
  return itensDoSelect(sql).map((item) => {
    const m = item.match(/\bAS\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/i);
    return m ? m[1]! : `??(${item.replace(/\s+/g, " ").slice(0, 40)})`;
  });
}

/** Só o nível de topo: `CAST(x AS FLOAT)` traz `AS` legítimos lá dentro. */
function semSubexpressoes(s: string): string {
  let fora = "";
  let nivel = 0;
  for (const c of s) {
    if (c === "(") nivel++;
    else if (c === ")") nivel--;
    else if (nivel === 0) fora += c;
  }
  return fora;
}

/** Cada item tem UM `AS`. Dois significam uma vírgula em falta. */
function itensComDoisAs(sql: string): string[] {
  return itensDoSelect(sql).filter((item) => {
    const esq = semSubexpressoes(item.replace(/'[^']*'/g, "''").replace(/\[[^\]]*\]/g, "[]"));
    return (esq.match(/\bAS\b/gi) ?? []).length !== 1;
  });
}

// ─────────────────────────────────────────────────────────────────────
// Dois ERP fictícios. O primeiro é o caso que rebentou.
// ─────────────────────────────────────────────────────────────────────

/**
 * Circuito G SEM coluna de série — o que as duas farmácias responderam.
 * O cruzamento tem de ligar por identificador e emitir `NULL` na série.
 */
const SEM_SERIE_NO_G = {
  cadeia: {
    pkCab: "h.[Atendimento Susp ID]",
    serie: "h.[SerieFacturacao]",
    numero: "h.[Numero Documento]",
    tipo: "h.[Tipo Documento ID]",
    data: "h.[Data Venda]",
    janelaSql: "h.[Data Venda] >= @from AND h.[Data Venda] < @to",
    cabTabela: "Atendimento Susp",
    qRel: "[dbo].[Atendimento_SuspFT_NC_Susp]",
    cFt: "[Atendimento Susp ID_FT]",
    cNc: "[Atendimento ID_NC]",
    qA: "[dbo].[Atendimento]",
    gPk: "[Atendimento ID]",
    gTipo: "a.[Tipo Documento]",
    gData: "a.[Data Venda]",
    gNumero: "a.[Numero]",
    // ISTO é o caso: a coluna não existe.
    gSerie: "NULL",
    linhasExpr:
      "(SELECT COUNT(*) FROM [dbo].[Atendimento Detalhe] dd WHERE dd.[Atendimento ID] = x.[Atendimento ID_NC])",
    somaExpr:
      "(SELECT SUM(CAST(dd.[Quantidade] AS FLOAT)) FROM [dbo].[Atendimento Detalhe] dd WHERE dd.[Atendimento ID] = x.[Atendimento ID_NC])",
  } satisfies PecasCadeia,
  anulacoes: {
    pkCab: "h.[Atendimento Susp ID]",
    tipo: "h.[Tipo Documento ID]",
    fonte:
      "[dbo].[Atendimento Susp Detalhe] d\n  JOIN [dbo].[Atendimento Susp] h ON h.[Atendimento Susp ID] = d.[Atendimento Susp ID]",
    janelaSql: "h.[Data Venda] >= @from AND h.[Data Venda] < @to",
    qtd: "d.[Quantidade]",
    serieSel: "h.[SerieFacturacao]",
    numSel: "ABS(h.[Numero Documento])",
    qRel: "[dbo].[Atendimento_SuspFT_NC_Susp]",
    cFt: "[Atendimento Susp ID_FT]",
    cNc: "[Atendimento ID_NC]",
    gemeaExpr:
      "(SELECT TOP 1 x2.[Atendimento ID_NC] FROM [dbo].[Atendimento_SuspFT_NC_Susp] x2" +
      " JOIN [dbo].[Atendimento Susp] h2 ON h2.[Atendimento Susp ID] = x2.[Atendimento Susp ID_FT]" +
      " WHERE h2.[SerieFacturacao] = n.serie AND ABS(h2.[Numero Documento]) = n.num" +
      " AND h2.[Atendimento Susp ID] <> n.suspId)",
    qD: "[dbo].[Atendimento Detalhe]",
    dFk: "[Atendimento ID]",
  } satisfies PecasAnulacoes,
  cruz: {
    qD: "[dbo].[Atendimento Detalhe]",
    qA: "[dbo].[Atendimento]",
    gPk: "[Atendimento ID]",
    dFk: "[Atendimento ID]",
    detCodigo: "[CodigoID]",
    detData: "[Data Venda]",
    detQtd: "[Quantidade]",
    codigo: "d.[CodigoID]",
    data: "h.[Data Venda]",
    qtd: "d.[Quantidade]",
    fonte:
      "[dbo].[Atendimento Susp Detalhe] d\n  JOIN [dbo].[Atendimento Susp] h ON h.[Atendimento Susp ID] = d.[Atendimento Susp ID]",
    janelaSql: "h.[Data Venda] >= @from AND h.[Data Venda] < @to",
  } satisfies PecasCruzDia,
};

/**
 * O caso degenerado: nem o circuito G nem o suspenso expõem série ou
 * número. Tudo o que depende deles cai para `NULL` e a query continua a
 * ser uma query — que é a diferença entre uma secção que reporta menos e
 * uma secção que morre.
 */
const SEM_NADA = {
  cadeia: {
    ...SEM_SERIE_NO_G.cadeia,
    serie: "NULL",
    numero: "NULL",
    gNumero: "NULL",
    gSerie: "NULL",
    linhasExpr: "NULL",
    somaExpr: "NULL",
  } satisfies PecasCadeia,
  anulacoes: {
    ...SEM_SERIE_NO_G.anulacoes,
    serieSel: "CAST(NULL AS NVARCHAR(50))",
    numSel: "CAST(NULL AS INT)",
    gemeaExpr: "NULL",
  } satisfies PecasAnulacoes,
};

// ─────────────────────────────────────────────────────────────────────

console.log("=== 4.2 — a cadeia FT->NC ===");
for (const [nome, pecas] of [
  ["circuito G sem serie", SEM_SERIE_NO_G.cadeia],
  ["sem serie nem numero em lado nenhum", SEM_NADA.cadeia],
] as const) {
  const sql = sqlCadeiaFtNc(pecas);
  const gerais = problemasGerais(sql);
  check(gerais.length === 0, `${nome}: estrutura sã`, gerais.join(" | "));

  // O validador completo aplica-se: é um SELECT simples com JOINs.
  const v = validarSelect(sql);
  check(v.length === 0, `${nome}: passa o validador de query inteira`,
    v.map((x) => `${x.regra}: ${x.detalhe}`).join(" | "));

  const alias = aliasDoSelect(sql);
  const esperados = [
    "suspId", "suspSerie", "suspNumero", "suspTipo", "ncId",
    "gTipo", "gData", "gNumero", "gSerie", "nLinhas", "somaQtd",
  ];
  check(
    JSON.stringify(alias) === JSON.stringify(esperados),
    `${nome}: devolve exactamente os 11 campos pedidos`,
    `obtido: ${alias.join(", ")}`,
  );
  check(itensComDoisAs(sql).length === 0, `${nome}: nenhum item com dois AS (virgula em falta)`);
  // O ponto 4 do pedido, item a item.
  check(/AS suspId\b/.test(sql), `${nome}: Atendimento Susp ID`);
  check(/AS suspSerie\b/.test(sql) && /AS suspNumero\b/.test(sql) && /AS suspTipo\b/.test(sql),
    `${nome}: serie/numero/tipo do lado suspenso`);
  check(/AS ncId\b/.test(sql), `${nome}: Atendimento ID_NC`);
  check(/AS gTipo\b/.test(sql) && /AS gData\b/.test(sql) && /AS gNumero\b/.test(sql),
    `${nome}: tipo, data e numero do lado G`);
  check(/AS nLinhas\b/.test(sql) && /AS somaQtd\b/.test(sql),
    `${nome}: nº de linhas em [Atendimento Detalhe] e soma das quantidades`);
  // Uma NC que não resolva no G TEM de aparecer, não de desaparecer.
  check(/LEFT JOIN \[dbo\]\.\[Atendimento\] a/.test(sql),
    `${nome}: o lado G entra por LEFT JOIN`,
    "com INNER, uma NC que não resolvesse no G sumia — e é esse o resultado que interessa");
  check(!/\bWHERE\b[^\n]*Fim/i.test(sql) && !/\bAND\b[^\n]*Fim\s*Venda/i.test(sql),
    `${nome}: [Fim Venda] não entra em WHERE`);
}

console.log("\n=== 4.3 — anulacoes suspensas: onde esta a reversao ===");
for (const [nome, pecas] of [
  ["com serie e numero (rota gemea activa)", SEM_SERIE_NO_G.anulacoes],
  ["sem serie nem numero (so rota directa)", SEM_NADA.anulacoes],
] as const) {
  const sql = sqlAnulacoesSuspensas(pecas);
  const gerais = problemasGerais(sql);
  check(gerais.length === 0, `${nome}: estrutura sã`, gerais.join(" | "));

  check(sql.startsWith("WITH neg AS ("), `${nome}: começa no WITH`);
  for (const cte of ["neg", "rot", "res", "fim"]) {
    check(
      new RegExp(`\\b${cte} AS \\(`).test(sql) && new RegExp(`FROM ${cte}\\b`).test(sql),
      `${nome}: CTE ${cte} declarada e consumida`,
    );
  }
  // O SELECT exterior está à coluna 0; os das CTE estão indentados.
  const exterior = sql.slice(sql.lastIndexOf("\nSELECT "));
  const alias = aliasDoSelect(exterior);
  const esperados = [
    "tipo", "docsNeg", "comLinhasG", "relSemLinhas", "semRelacao", "rotaDirecta", "rotaGemea",
  ];
  check(
    JSON.stringify(alias) === JSON.stringify(esperados),
    `${nome}: os três desfechos + as duas rotas, por tipo`,
    `obtido: ${alias.join(", ")}`,
  );
  check(itensComDoisAs(exterior).length === 0, `${nome}: nenhum item com dois AS`);
  check(/GROUP BY s\.tipo/.test(sql), `${nome}: separado por tipoDoc — 107 e 102 não se misturam`);
  check(/\bAND [^\n]*\[Quantidade\] < 0/.test(sql) || /d\.\[Quantidade\] < 0/.test(sql),
    `${nome}: o universo é definido pelo SINAL, não pelo nome do tipo`);
  check(!/\bFim\s*Venda\b/i.test(sql), `${nome}: [Fim Venda] não aparece de todo`);
}
{
  // A rota gémea existe ou não conforme o schema — nunca a meio.
  const comGemea = sqlAnulacoesSuspensas(SEM_SERIE_NO_G.anulacoes);
  const semGemea = sqlAnulacoesSuspensas(SEM_NADA.anulacoes);
  check(/h2\.\[SerieFacturacao\] = n\.serie/.test(comGemea),
    "com série+número, a NC é procurada também pelo documento gémeo");
  check(/NULL AS ncGemea/.test(semGemea),
    "sem série+número, a rota gémea desliga-se limpa (NULL), não meia-feita");
  check(/COALESCE\(r\.ncDirecto, r\.ncGemea\)/.test(semGemea),
    "…e o COALESCE continua válido — a rota directa sozinha ainda responde");
}

console.log("\n=== 4.4 — cruzamento por produto+dia, sem tabela de relacoes ===");
{
  const sql = sqlCruzProdutoDia(SEM_SERIE_NO_G.cruz);
  const gerais = problemasGerais(sql);
  check(gerais.length === 0, "estrutura sã", gerais.join(" | "));
  const alias = aliasDoSelect(sql);
  check(
    JSON.stringify(alias) === JSON.stringify(["codigo", "dia", "qtdSusp", "nG"]),
    "devolve produto, dia, quantidade suspensa e nº de linhas negativas no G",
    `obtido: ${alias.join(", ")}`,
  );
  check(itensComDoisAs(sql).length === 0, "nenhum item com dois AS");
  check(/CAST\(ga\.\[Data Venda\] AS DATE\) = s\.dia/.test(sql), "compara o dia, não o instante");
  check(!/\[Serie\]/.test(sql), "não nomeia [Serie] — foi isto que partiu nas duas bases");
}

console.log("\n=== nenhuma coluna do circuito G nomeada a mao ===");
{
  // As três queries constroem-se só com o que lhes é passado. Se alguma
  // trouxesse uma coluna escrita no corpo da função, aparecia aqui —
  // porque o fixture não a passou.
  const vazio = {
    ...SEM_NADA.cadeia,
    qA: "[dbo].[X]", gPk: "[Xid]", gTipo: "NULL", gData: "NULL",
    qRel: "[dbo].[R]", cFt: "[F]", cNc: "[N]",
    pkCab: "h.[P]", tipo: "h.[T]", data: "h.[D]",
    cabTabela: "H", janelaSql: "1=1",
  } satisfies PecasCadeia;
  const sql = sqlCadeiaFtNc(vazio);
  const nomes = (sql.match(/\[[A-Za-z][A-Za-z _]*\]/g) ?? []).filter(
    (n) => !["[dbo]", "[X]", "[Xid]", "[R]", "[F]", "[N]", "[P]", "[T]", "[D]", "[H]"].includes(n),
  );
  check(
    nomes.length === 0,
    "a cadeia não introduz nenhum identificador que não lhe tenha sido dado",
    `apareceram do nada: ${[...new Set(nomes)].join(", ")}`,
  );
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail === 0 ? 0 : 1);
