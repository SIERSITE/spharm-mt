/**
 * agent/src/sql-validador.test.ts
 *
 * O teste que faltava: a query INTEIRA, não fragmentos dela.
 *
 * O reader de vendas foi para a farmácia com uma lista de SELECT sem
 * vírgulas. `Incorrect syntax near 'a'`, pipeline morto antes de ler uma
 * linha. Os testes passavam todos porque verificavam
 * `sql.includes(fragmento)` e cada fragmento estava lá.
 *
 * Aqui há três níveis:
 *   1. o validador apanha as formas conhecidas de partir a query
 *      (incluindo a exacta que aconteceu);
 *   2. as duas queries reais passam o validador;
 *   3. as duas queries reais são comparadas com o texto COMPLETO
 *      esperado — se mudar um caracter, o teste mostra qual.
 *
 * Uso: npx tsx agent/src/sql-validador.test.ts
 */
import { ALIAS_FONTE_VENDA, validarSelect } from "./sql-validador.js";
import {
  sqlAtendimentoDetalhe,
  sqlAtendimentoSuspDetalhe,
  type SchemaAtendimento,
  type SchemaCabecalhoSusp,
  type SchemaFonteSusp,
} from "./vendas-fontes.js";

let pass = 0;
let fail = 0;
const ok = (l: string) => { pass++; console.log(`  [OK]    ${l}`); };
const bad = (l: string, d?: string) => { fail++; console.log(`  [FALHA] ${l}${d ? `\n            ${d}` : ""}`); };
const check = (c: boolean, l: string, d?: string) => (c ? ok(l) : bad(l, d));

const AT: SchemaAtendimento = {
  serie: "Serie", numero: "Numero", tipoDocumento: "Tipo Documento",
  dataVenda: "Data Venda", fimVenda: "Fim Venda",
};
const CAB: SchemaCabecalhoSusp = {
  existe: true, tabela: "Atendimento Susp", pk: "Atendimento Susp ID",
  serie: "SerieFacturacao", numero: "Numero Documento",
  tipoDocumento: "Tipo Documento ID", dataVenda: "Data Venda",
  totalBruto: "Total Bruto_EUR",
};
const SUSP: SchemaFonteSusp = {
  existe: true, tabela: "Atendimento Susp Detalhe",
  pk: "Atendimento Susp Detalhe ID", cabecalhoFk: "Atendimento Susp ID",
  codigoId: "CodigoID", sequencia: "Sequencia", quantidade: "Quantidade",
  pvpUnitario: "Preco Venda Publico_EUR", valorLinha: "Valor_EUR",
  ivaValor: "Val_IVA_EUR", descontoValor: "Val_Desc_EUR",
  comparticipacao1: "PrComp_EUR", comparticipacao2: "PrComp_EUR2",
  entidadeId: "Entidade ID", dataVenda: null,
};

// ─────────────────────────────────────────────────────────────────────
console.log("=== 1. o validador apanha o defeito que foi a producao ===");
{
  // A query EXACTA que a rev67 gerou. Sem vírgulas.
  const partida = [
    "SELECT TOP (@n)",
    "    d.[Detalhe ID] AS externalLineId",
    "    a.[Atendimento ID] AS externalDocumentId",
    "  FROM [dbo].[Atendimento] a",
    "  JOIN [dbo].[Atendimento Detalhe] d ON d.[Atendimento ID] = a.[Atendimento ID]",
    " WHERE a.[Data Venda] >= @from",
  ].join("\n");
  const p = validarSelect(partida);
  check(p.length > 0, "a query sem vírgulas é RECUSADA");
  check(
    p.some((x) => x.regra === "virgula"),
    "…e o diagnóstico diz que faltam vírgulas",
    JSON.stringify(p),
  );
  const msg = p.find((x) => x.regra === "virgula")?.detalhe ?? "";
  check(/2 'AS'/.test(msg), "…identificando o item com dois AS colados");
}

console.log("\n=== outras formas de a partir ===");
{
  const casos: Array<[string, string, string]> = [
    ["vírgula antes do FROM", "SELECT a AS x,\n  FROM [dbo].[T] t", "virgula"],
    ["duas vírgulas", "SELECT a AS x,, b AS y\n  FROM [dbo].[T] t", "virgula"],
    ["alias repetido", "SELECT a AS x,\n b AS x\n  FROM [dbo].[T] t", "alias"],
    ["item sem AS", "SELECT a,\n b AS y\n  FROM [dbo].[T] t", "alias"],
    ["brackets abertos", "SELECT a AS x\n  FROM [dbo].[T t", "brackets"],
    ["parêntesis abertos", "SELECT ISNULL(a, 0 AS x\n  FROM [dbo].[T] t", "parentesis"],
    ["JOIN sem ON", "SELECT a AS x\n  FROM [dbo].[T] t\n  JOIN [dbo].[U] u", "join"],
    ["WHERE AND", "SELECT a AS x\n  FROM [dbo].[T] t\n WHERE AND a = 1", "where"],
    ["parâmetro desconhecido", "SELECT a AS x\n  FROM [dbo].[T] t\n WHERE a = @outro", "parametro"],
    [
      "keyset sem ORDER BY",
      "SELECT a AS x\n  FROM [dbo].[T] t\n WHERE t.[id] > @lastId",
      "keyset",
    ],
    [
      "ORDER BY que não acompanha o keyset",
      "SELECT a AS x\n  FROM [dbo].[T] t\n WHERE t.[id] > @lastId\n ORDER BY t.[outra]",
      "keyset",
    ],
  ];
  for (const [nome, sql, regra] of casos) {
    const p = validarSelect(sql);
    check(p.some((x) => x.regra === regra), `${nome} → regra "${regra}"`, JSON.stringify(p));
  }
}

// ─────────────────────────────────────────────────────────────────────
console.log("\n=== 2. as queries REAIS passam o validador ===");
{
  const g = sqlAtendimentoDetalhe(AT);
  const pg = validarSelect(g, ALIAS_FONTE_VENDA);
  check(pg.length === 0, "Atendimento Detalhe: query válida", JSON.stringify(pg, null, 2));

  const rv = sqlAtendimentoSuspDetalhe(SUSP, CAB);
  check(rv.estado === "PRONTA", "Atendimento Susp Detalhe: fonte pronta");
  const v = rv.estado === "PRONTA" ? rv.sql : "";
  const pv = validarSelect(v, ALIAS_FONTE_VENDA);
  check(pv.length === 0, "Atendimento Susp Detalhe: query válida", JSON.stringify(pv, null, 2));
}
{
  // Instalação a que faltam colunas: a query continua VÁLIDA, com NULL
  // no lugar do que falta. É o contrário de rebentar — mas tem de
  // continuar a produzir todos os alias, senão o normalizador lê
  // `undefined` em silêncio.
  const magra = sqlAtendimentoDetalhe({
    serie: null, numero: null, tipoDocumento: "Tipo Documento",
    dataVenda: "Data Venda", fimVenda: null,
  });
  const p = validarSelect(magra, ALIAS_FONTE_VENDA);
  check(p.length === 0, "colunas em falta → NULL, query na mesma válida", JSON.stringify(p));
  check(magra.includes("NULL AS serie"), "…e o alias continua lá");

  const rv = sqlAtendimentoSuspDetalhe(
    { ...SUSP, sequencia: null, ivaValor: null, entidadeId: null },
    { ...CAB, serie: null, numero: null },
  );
  const pv = rv.estado === "PRONTA" ? validarSelect(rv.sql, ALIAS_FONTE_VENDA) : [{ regra: "estado", detalhe: rv.estado }];
  check(pv.length === 0, "VSG com colunas em falta: query válida", JSON.stringify(pv));
}

// ─────────────────────────────────────────────────────────────────────
console.log("\n=== 3. a query completa, caracter a caracter ===");

const G_ESPERADA = `SELECT TOP (@n)
    d.[Detalhe ID] AS externalLineId,
    a.[Atendimento ID] AS externalDocumentId,
    d.[Sequencia] AS sequencia,
    a.[Data Venda] AS dataVenda,
    a.[Tipo Documento] AS tipoDocumento,
    a.[Serie] AS serie,
    a.[Numero] AS numero,
    d.[CodigoID] AS externalProductId,
    s.[Processa_Stocks] AS processaStocks,
    d.[Quantidade] AS quantidade,
    d.[Preco Venda Publico_EUR] AS pvpUnitario,
    d.[Valor_EUR] AS valorLinha,
    d.[Val_IVA_EUR] AS ivaValor,
    d.[Val_Desc_EUR] AS descontoValor,
    d.[PrComp_EUR] AS comparticipacao1,
    d.[PrComp_EUR2] AS comparticipacao2,
    d.[Entidade ID] AS entidadeId
  FROM [dbo].[Atendimento] a
  JOIN [dbo].[Atendimento Detalhe] d ON d.[Atendimento ID] = a.[Atendimento ID]
  LEFT JOIN [dbo].[Stocks] s ON s.CodigoID = d.[CodigoID]
 WHERE a.[Fim Venda] = 'S'
   AND a.[Data Venda] >= @from AND a.[Data Venda] < @to
   AND d.[Detalhe ID] > @lastId
 ORDER BY d.[Detalhe ID]`;

const VSG_ESPERADA = `SELECT TOP (@n)
    d.[Atendimento Susp Detalhe ID] AS externalLineId,
    h.[Atendimento Susp ID] AS externalDocumentId,
    d.[Sequencia] AS sequencia,
    h.[Data Venda] AS dataVenda,
    h.[Tipo Documento ID] AS tipoDocumento,
    h.[SerieFacturacao] AS serie,
    h.[Numero Documento] AS numero,
    d.[CodigoID] AS externalProductId,
    s.[Processa_Stocks] AS processaStocks,
    d.[Quantidade] AS quantidade,
    d.[Preco Venda Publico_EUR] AS pvpUnitario,
    d.[Valor_EUR] AS valorLinha,
    d.[Val_IVA_EUR] AS ivaValor,
    d.[Val_Desc_EUR] AS descontoValor,
    d.[PrComp_EUR] AS comparticipacao1,
    d.[PrComp_EUR2] AS comparticipacao2,
    d.[Entidade ID] AS entidadeId
  FROM [dbo].[Atendimento Susp Detalhe] d
  JOIN [dbo].[Atendimento Susp] h ON h.[Atendimento Susp ID] = d.[Atendimento Susp ID]
  LEFT JOIN [dbo].[Stocks] s ON s.CodigoID = d.[CodigoID]
 WHERE h.[Data Venda] >= @from AND h.[Data Venda] < @to
   AND d.[Atendimento Susp Detalhe ID] > @lastId
 ORDER BY d.[Atendimento Susp Detalhe ID]`;

function compararLinhaALinha(nome: string, obtido: string, esperado: string): void {
  if (obtido === esperado) {
    ok(`${nome}: query completa idêntica à esperada`);
    return;
  }
  const a = obtido.split("\n");
  const b = esperado.split("\n");
  const detalhes: string[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      detalhes.push(`linha ${i + 1}:\n              obtido:   ${a[i] ?? "(nada)"}\n              esperado: ${b[i] ?? "(nada)"}`);
    }
  }
  bad(`${nome}: query completa diverge`, detalhes.slice(0, 6).join("\n            "));
}

compararLinhaALinha("Atendimento Detalhe", sqlAtendimentoDetalhe(AT), G_ESPERADA);
{
  const rv = sqlAtendimentoSuspDetalhe(SUSP, CAB);
  compararLinhaALinha(
    "Atendimento Susp Detalhe",
    rv.estado === "PRONTA" ? rv.sql : `(${rv.estado})`,
    VSG_ESPERADA,
  );
}

console.log("\n=== a lógica VSG provada mantém-se ===");
{
  const rv = sqlAtendimentoSuspDetalhe(SUSP, CAB);
  const v = rv.estado === "PRONTA" ? rv.sql : "";
  check(
    v.includes("JOIN [dbo].[Atendimento Susp] h ON h.[Atendimento Susp ID] = d.[Atendimento Susp ID]"),
    "JOIN pela FK declarada ao cabeçalho suspenso",
  );
  check(!/Fim Venda/.test(v), "sem filtro [Fim Venda] no VSG");
  check(!/\[dbo\]\.\[Atendimento\]/.test(v), "não toca no [Atendimento]");
  check(v.includes("h.[Tipo Documento ID] AS tipoDocumento"), "o tipo vem do cabeçalho suspenso");
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail === 0 ? 0 : 1);
