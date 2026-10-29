/**
 * agent/src/sql-somente-leitura.test.ts
 *
 * O validador de SQL do pacote de diagnóstico: só SELECT / metadados read-only. Prova que TODAS as palavras proibidas
 * são recusadas — em maiúsculas/minúsculas, com quebras de linha, escondidas em comentários, depois de `;`, com espaços
 * Unicode — e que as mesmas palavras dentro de literais '…' ou identificadores […] NÃO geram falsos positivos.
 * E que o validador estrutural existente (sql-validador.ts) não foi enfraquecido.
 *
 * Uso: npx tsx agent/src/sql-somente-leitura.test.ts
 */
import { readFileSync } from "node:fs";
import {
  criarLeitorSeguro,
  mascararQuery,
  PALAVRAS_PROIBIDAS,
  SqlRecusadoError,
  validarQueryAuditoria,
  validarSomenteSelect,
} from "./sql-somente-leitura.js";
import * as aud from "./classificacao-auditoria.js";
import { validarSelect } from "./sql-validador.js";

let pass = 0;
let fail = 0;
const check = (c: boolean, l: string, d?: string) => {
  if (c) { pass++; console.log(`  [OK]    ${l}`); }
  else { fail++; console.log(`  [FALHA] ${l}${d ? `\n            ${d}` : ""}`); }
};

const BASE = "SELECT x.[a] AS a FROM [dbo].[Stocks] x WITH (NOLOCK)";

async function main() {
  console.log("\n=== 1. Cada palavra proibida é recusada (todas as variantes) ===");
  const exigidas = ["INSERT", "UPDATE", "DELETE", "MERGE", "EXEC", "EXECUTE", "ALTER", "CREATE", "DROP", "TRUNCATE", "GRANT", "REVOKE", "INTO", "OPENROWSET", "DENY", "BACKUP", "RESTORE", "SHUTDOWN", "KILL", "DBCC", "WAITFOR", "OPENQUERY", "OPENDATASOURCE", "BULK", "SET", "DECLARE", "OUTPUT"];
  for (const w of exigidas) check((PALAVRAS_PROIBIDAS as readonly string[]).includes(w), `a lista contém ${w}`);
  for (const w of PALAVRAS_PROIBIDAS) {
    const variantes: Array<[string, string]> = [
      ["maiúsculas", `${BASE} WHERE 1 = 1 ${w} x`],
      ["minúsculas", `${BASE} where 1 = 1 ${w.toLowerCase()} x`],
      ["misto", `${BASE} ${[...w].map((ch, i) => (i % 2 ? ch.toLowerCase() : ch)).join("")} x`],
      ["quebra de linha", `${BASE}\n${w}\nx`],
      ["tabulação", `${BASE}\t${w}\tx`],
      ["espaço Unicode", `${BASE} ${w} x`],
      ["após ponto e vírgula", `${BASE}; ${w} x`],
      ["segundo statement", `${BASE};\n${w.toLowerCase()} [dbo].[T] SET a = 1`],
    ];
    for (const [nome, sql] of variantes) {
      check(validarSomenteSelect(sql).length > 0 && validarQueryAuditoria(sql).length > 0, `${w} (${nome}) recusada`, sql.replace(/\s+/g, " "));
    }
  }

  console.log("\n=== 2. Escondidas em comentários ===");
  for (const sql of [
    `${BASE} -- DROP TABLE x`,
    `${BASE} /* DELETE FROM x */`,
    `${BASE} /* x */ ; UPDATE [dbo].[T] SET a = 1`,
    `SELECT 1 AS a FROM [dbo].[T] x --\nDROP TABLE [dbo].[T]`,
    `SELECT/**/1 AS a FROM [dbo].[T] x`,
    `SEL/**/ECT 1`,
    `${BASE}; --`,
  ]) {
    check(validarSomenteSelect(sql).length > 0, `recusada: ${sql.replace(/\s+/g, " ").slice(0, 70)}`);
  }

  console.log("\n=== 3. Não começa por SELECT / vários statements / procedimentos ===");
  for (const sql of [
    "", "   ", "WITH t AS (SELECT 1 AS a) SELECT a FROM t", "(SELECT 1)", "EXEC sp_who", "exec('select 1')", "sp_executesql N'x'",
    "SELECT 1; SELECT 2", "SELECT 1;", "SELECT xp_cmdshell('dir')", "SELECT sp_who2", "SELECT x.[a] AS a FROM [dbo].[T] x WHERE a = N'unterminated",
    'SELECT "DROP" AS a FROM [dbo].[T] x', "SELECT dbo.fn_escreve(1) AS a FROM [dbo].[T] x", "SELECT OPENJSON(x) AS a FROM [dbo].[T] x",
    "SELECT [a] INTO [dbo].[copia] FROM [dbo].[T]", "SELECT * INTO #t FROM [dbo].[T]",
  ]) {
    check(validarQueryAuditoria(sql).length > 0, `recusada: ${JSON.stringify(sql).slice(0, 70)}`);
  }

  console.log("\n=== 4. Sem falsos positivos (palavras em literais e identificadores) ===");
  for (const sql of [
    "SELECT x.[Update] AS u FROM [dbo].[T] x WITH (NOLOCK) WHERE x.[a] = N'DELETE; --'",
    "SELECT x.[Into] AS u, x.[Set] AS v FROM [dbo].[Drop] x WITH (NOLOCK)",
    "SELECT x.[a] AS a FROM [dbo].[T] x WITH (NOLOCK) WHERE x.[nome] = N'EXEC xp_cmdshell /* DROP */'",
    "SELECT x.[a] AS a FROM [dbo].[T] x WITH (NOLOCK) WHERE x.[n] = N'it''s; DROP'",
    "SELECT x.[CodigoID] AS a FROM [dbo].[Stocks] x WITH (NOLOCK) WHERE x.[Output] = 1",
  ]) {
    check(validarSomenteSelect(sql).length === 0, `aceite: ${sql.slice(0, 80)}`, validarSomenteSelect(sql).join("|"));
  }
  check(validarSomenteSelect("SELECT 1 AS reset, 2 AS asset, 3 AS outputs FROM [dbo].[T] x").length === 0, "reset / asset / outputs não contêm palavras proibidas inteiras");

  console.log("\n=== 5. O leitor seguro nunca executa SQL recusado ===");
  let executou = 0;
  const registo: string[] = [];
  const leitor = criarLeitorSeguro(async () => { executou++; return []; }, registo);
  const maus = [
    "INSERT INTO [dbo].[Stocks] ([a]) VALUES (1)", "UPDATE [dbo].[Stocks] SET [a] = 1", "DELETE FROM [dbo].[Stocks]", "DROP TABLE [dbo].[Stocks]",
    "TRUNCATE TABLE [dbo].[Stocks]", "ALTER TABLE [dbo].[Stocks] ADD x int", "CREATE TABLE t (a int)", "EXEC sp_who", "EXECUTE ('SELECT 1')",
    "MERGE [dbo].[Stocks] AS t USING s ON 1=1 WHEN MATCHED THEN DELETE", "SELECT [a] INTO [dbo].[copia] FROM [dbo].[Stocks]", "SELECT 1; DROP TABLE [dbo].[Stocks]",
    "GRANT SELECT ON [dbo].[Stocks] TO x", "SET NOCOUNT ON", "DECLARE @a int", "BEGIN TRANSACTION",
  ];
  for (const s of maus) {
    let erro: unknown = null;
    try { await leitor(s); } catch (e) { erro = e; }
    check(erro instanceof SqlRecusadoError, `SqlRecusadoError: ${s.slice(0, 40)}`);
  }
  check(executou === 0 && registo.length === 0, "o executor NUNCA foi chamado e nada ficou registado");
  await leitor(BASE);
  check(executou === 1 && registo.length === 1, "uma query válida passa e fica registada");

  console.log("\n=== 6. Todas as queries geradas pela auditoria passam (guarda + validador estrutural) ===");
  const stocks = { esquema: "dbo", tabela: "Stocks" };
  const geradas: Record<string, string> = {
    versao: aud.sqlVersao(), ambiente: aud.sqlAmbiente(), permissoes: aud.sqlPermissoes(), candidatas: aud.sqlColunasCandidatas(),
    tabelasNome: aud.sqlColunasDeTabelasPorNome(aud.PADROES_TABELA), versaoTabelas: aud.sqlColunasDeTabelasPorNome(aud.PADROES_TABELA_VERSAO, 1500),
    linhas: aud.sqlLinhasPorTabela(), colsStocks: aud.sqlColunasStocks(), fks: aud.sqlFksDeStocks(), lookupCols: aud.sqlColunasDeLookups(),
    perfilTexto: aud.sqlPerfilColuna(stocks, "Tipo Artigo", "texto"), perfilNum: aud.sqlPerfilColuna(stocks, "Etico", "numerico"),
    top: aud.sqlTopValores(stocks, "Etico", 15), cruzada: aud.sqlCruzada(stocks, "Etico", "Servico"),
    amostra: aud.sqlAmostraPorValor("Etico", "1", 3), amostraNulo: aud.sqlAmostraPorValor("Etico", null, 3), amostraAspas: aud.sqlAmostraPorValor("Tipo", "O'Brien", 3),
    processa: aud.sqlProcessaStocks(), processaRet: aud.sqlProcessaStocks(true), marcadosTexto: aud.sqlMarcadosVsFiltro("Tipo", "texto"), marcadosNum: aud.sqlMarcadosVsFiltro("Servico", "numerico"),
    exZero: aud.sqlExemplosProcessa(true, ["Etico", "Servico"]), exNZ: aud.sqlExemplosProcessa(false, ["Etico"]),
    conteudo: aud.sqlConteudoPequeno({ esquema: "dbo", tabela: "TipoProduto" }, ["ID", "Descricao"]),
    lookup: aud.sqlContagemLookup("TipoProdutoID", { esquema: "dbo", tabela: "TipoProduto" }, "ID", "Descricao"),
    conhecidos: aud.sqlConhecidos(["1000001", "1000002"], ["Etico", "Servico"]),
  };
  for (const [k, sql] of Object.entries(geradas)) {
    const p = validarQueryAuditoria(sql);
    check(p.length === 0, `query ${k}: SELECT read-only e estruturalmente válida`, p.join(" | "));
  }
  check(Object.values(geradas).every((s) => /^SELECT\b/.test(s)), "todas as queries começam por SELECT");
  check(Object.values(geradas).filter((s) => /FROM \[dbo\]\.\[Stocks\] x/.test(s)).every((s) => s.includes("WITH (NOLOCK)")), "leituras a dbo.Stocks com NOLOCK");

  console.log("\n=== 7. sql-validador.ts (estrutural) não foi enfraquecido ===");
  check(validarSelect("SELECT a.[x] AS x\n  FROM [dbo].[T] a").length === 0, "SELECT válido continua válido");
  check(validarSelect("SELECT a.[x] AS x a.[y] AS y\n  FROM [dbo].[T] a").some((p) => p.regra === "virgula"), "ainda apanha vírgulas em falta");
  check(validarSelect("SELECT a.[x] AS x\n  FROM [dbo].[T] a\n WHERE a.[x] > @naoDeclarado").some((p) => p.regra === "parametro"), "ainda apanha parâmetros não declarados");
  check(validarQueryAuditoria("SELECT @@VERSION AS versao, DB_NAME() AS baseDados\n  FROM [sys].[databases] d\n WHERE d.database_id = DB_ID()").length === 0, "@@VERSION é a única variável global aceite");
  check(validarQueryAuditoria("SELECT @@SERVERNAME AS s\n  FROM [sys].[databases] d").length > 0, "outras variáveis @@ continuam recusadas pelo validador estrutural");
  const fonteValidador = readFileSync(new URL("./sql-validador.ts", import.meta.url), "utf8");
  check(!/^import /m.test(fonteValidador), "sql-validador.ts continua sem imports");

  console.log("\n=== 8. mascararQuery: texto das queries sem dados ===");
  const comDados = aud.sqlAmostraPorValor("Tipo", "VALOR-SECRETO", 3) + "\n" + aud.sqlConhecidos(["1234567"], ["Etico"]);
  const mascarada = mascararQuery(comDados);
  check(!mascarada.includes("VALOR-SECRETO") && !mascarada.includes("1234567") && mascarada.includes("N'<valor>'"), "valores e CNPs substituídos por <valor>");
  check(mascararQuery(aud.sqlColunasCandidatas()).includes("LIKE N'%etico%'"), "padrões de pesquisa de nomes mantêm-se visíveis");
  check(mascararQuery(aud.sqlPermissoes()).includes("N'dbo.Stocks'") && mascararQuery(aud.sqlPermissoes()).includes("N'INSERT'"), "constantes da própria auditoria mantêm-se");

  console.log(`\n${pass} ok, ${fail} falhas`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
