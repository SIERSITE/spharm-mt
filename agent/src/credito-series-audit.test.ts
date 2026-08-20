/**
 * agent/src/credito-series-audit.test.ts
 *
 * Os seis SQL da sonda `vendas-credito-series-audit`, compostos contra o
 * schema REAL e verificados sem base de dados.
 *
 * ── PORQUE ISTO EXISTE ───────────────────────────────────────────────
 *
 * A §4 da rev71 nunca chegou a correr: morreu com `Invalid column name
 * 'Serie'` nas duas farmácias e levou as secções seguintes atrás. Uma
 * sonda existe para poupar rondas; uma sonda que só falha na farmácia
 * gasta a ronda que devia poupar.
 *
 * Estas asserções não substituem a corrida real — não há dados aqui.
 * Provam o que se pode provar em frio: que o SQL sai com as colunas que
 * a base tem, que não filtra pelo que não deve, que não escreve, e que
 * uma coluna informativa em falta não parte o agrupamento.
 *
 * Uso: npx tsx agent/src/credito-series-audit.test.ts
 */
import {
  agrupavel,
  montar,
  sinalDe,
  sqlAssinatura,
  sqlContraparte,
  sqlDocumentos,
  sqlInventarioSeries,
  sqlMatriz,
  sqlPerfis,
} from "./commands/vendas-credito-series-audit.js";
import { namespaceDaSerieCredito, type SchemaFonteCredito } from "./vendas-fontes.js";

let pass = 0;
let fail = 0;
const ok = (l: string) => { pass++; console.log(`  [OK]    ${l}`); };
const bad = (l: string, d?: string) => { fail++; console.log(`  [FALHA] ${l}${d ? `\n            ${d}` : ""}`); };
const check = (c: boolean, l: string, d?: string) => (c ? ok(l) : bad(l, d));
const eq = (a: unknown, b: unknown, l: string) =>
  check(a === b, l, `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);

/** O schema medido na Silveirense na rev76, e confirmado na rev78. */
const SCHEMA: SchemaFonteCredito = {
  existe: true,
  cabecalhoTabela: "Atendimento Credito",
  detalheTabela: "Atendimento Credito Detalhe",
  cabecalhoPk: "Atendimento Credito ID",
  detalhePk: "Atendimento Credito Detalhe ID",
  chaveLigacao: "Atendimento Credito ID",
  data: "Data Venda",
  serie: "SerieFacturacao",
  numero: "Numero Documento",
  tipoDocumento: "Tipo Documento ID",
  estado: "Fim Venda",
  codigoId: "CodigoID",
  quantidade: "Quantidade",
  pvpUnitario: null,
  valorLinha: "Valor_EUR",
  ivaValor: null,
  entidadeId: null,
  sequencia: null,
  candidatas: ["Atendimento Credito", "Atendimento Credito Detalhe"],
};

const C = montar(SCHEMA, ["Entidade ID"]);
const TODOS = [
  ["inventario", sqlInventarioSeries(C)],
  ["matriz", sqlMatriz(C)],
  ["documentos", sqlDocumentos(C, "Nome Comercial")],
  ["assinatura", sqlAssinatura(C)],
  ["perfis", sqlPerfis(C)],
  ["contraparte", sqlContraparte(C, "Entidade ID")],
] as const;

console.log("=== o circuito monta-se com as colunas reais ===");
{
  eq(C.serie, "h.[SerieFacturacao]", "a série é a coluna real do cabeçalho");
  eq(C.data, "h.[Data Venda]", "a data também");
  eq(C.tipo, "h.[Tipo Documento ID]", "e o tipo de documento");
  eq(C.estado, "h.[Fim Venda]", "o estado entra como DADO");
  eq(C.qtd, "d.[Quantidade]", "a quantidade vem do detalhe");
  eq(C.valor, "d.[Valor_EUR]", "o valor também");
  check(
    C.fonte.includes("JOIN [dbo].[Atendimento Credito] h ON h.[Atendimento Credito ID] = d.[Atendimento Credito ID]"),
    "a ligação é a chave lógica comum às duas tabelas",
    "não é FK: esta instalação não a tem declarada",
  );
}

console.log("\n=== sem série não há relatório ===");
{
  // A série é o EIXO. Um relatório sem eixo daria uma linha só e
  // leria-se como "esta base tem uma série" — o oposto da verdade.
  let erro = "";
  try {
    montar({ ...SCHEMA, serie: null }, []);
  } catch (e) {
    erro = e instanceof Error ? e.message : String(e);
  }
  check(/falta: .*serie/.test(erro), "sem série, `montar` recusa-se a compor");
  check(/candidatas:/.test(erro), "…e diz onde procurou", "a rev77 disse o que faltava e não onde");
}

console.log("\n=== nenhum SQL escreve, e nenhum filtra pelo estado ===");
{
  for (const [nome, s] of TODOS) {
    check(/^\s*SELECT/i.test(s), `${nome}: começa em SELECT`);
    check(
      !/\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|TRUNCATE|EXEC)\b/i.test(s),
      `${nome}: não escreve nada`,
    );
    // `Fim Venda` já foi refutado duas vezes como classificador. Aqui é
    // dado — aparece no SELECT e no GROUP BY, nunca a cortar linhas.
    const where = s.split(/\bWHERE\b/i).slice(1).join(" ").split(/\bGROUP BY\b|\bORDER BY\b/i)[0] ?? "";
    check(!/\[Fim Venda\]/.test(where), `${nome}: [Fim Venda] não entra em WHERE`);
  }
}

console.log("\n=== a janela é a mesma em todos, e é meio-aberta ===");
{
  for (const [nome, s] of TODOS) {
    check(
      s.includes("h.[Data Venda] >= @from AND h.[Data Venda] < @to"),
      `${nome}: >= @from AND < @to`,
      "um `BETWEEN … 23:59:59` perde o último meio-segundo do dia",
    );
  }
}

console.log("\n=== a matriz agrupa por série, tipo, estado e SINAL ===");
{
  const m = sqlMatriz(C);
  check(m.includes(sinalDe(C)), "o sinal é uma expressão de agrupamento");
  // O GROUP BY sai numa linha só — não é preciso a flag `s`, que o
  // target do tsconfig da app não aceita.
  check(/GROUP BY .*SerieFacturacao.*Tipo Documento ID.*Fim Venda/.test(m), "os três eixos entram no GROUP BY");
  check(/ORDER BY 1, 2, 3, 4/.test(m), "ordena por ordinal — não por uma constante");
  check(/'POS'/.test(m) && /'NEG'/.test(m) && /'ZERO'/.test(m), "os três baldes de sinal existem");
  // O ZERO é um balde próprio e não se soma ao positivo: um documento
  // anulado (estado A, qtd 0) não pode ler-se como venda de zero peças.
  check(/ELSE 'ZERO'/.test(m), "quantidade zero é um balde à parte");
}

console.log("\n=== uma coluna informativa em falta não parte o agrupamento ===");
{
  // Noutra instalação `[Tipo Documento ID]` ou `[Fim Venda]` podem não
  // existir. A expressão passa a ser o literal NULL, e agrupar por uma
  // constante é erro do SQL Server — a secção inteira morreria.
  const semTipo = montar({ ...SCHEMA, tipoDocumento: null, estado: null }, []);
  eq(semTipo.tipo, "NULL", "sem tipo, a expressão é o literal NULL");
  const m = sqlMatriz(semTipo);
  check(!/GROUP BY NULL/.test(m), "o NULL não entra no GROUP BY");
  check(/GROUP BY h\.\[SerieFacturacao\], CASE/.test(m), "só a série e o sinal sobram");
  check(/NULL AS tipoDoc/.test(m), "…mas a coluna continua no SELECT, a dizer que não existe");
  eq(agrupavel("h.[a]", "NULL", "h.[b]").length, 2, "`agrupavel` deixa cair os literais");
}

console.log("\n=== os documentos reais trazem os campos pedidos ===");
{
  const d = sqlDocumentos(C, "Nome Comercial");
  check(/h\.\[Numero Documento\] AS numero/.test(d), "numeroDocumento");
  check(/d\.\[CodigoID\] AS codigo/.test(d), "produto/CodigoID");
  check(/d\.\[Quantidade\] AS qtd/.test(d), "quantidade");
  check(/d\.\[Valor_EUR\] AS valor/.test(d), "valor");
  check(/p\.\[Nome Comercial\] AS nome/.test(d), "e a designação, quando o ERP a tem");
  check(/TOP \(@n\)/.test(d), "os N documentos mais recentes, N parametrizado");
  check(/LTRIM\(RTRIM\(h\.\[SerieFacturacao\]\)\) = @serie/.test(d), "a série vai como parâmetro, não interpolada");
  // A subquery redeclara `h`: dentro dela `h` é o cabeçalho sozinho. Se
  // fosse correlacionada, o TOP aplicava-se por linha e não por
  // documento — e viriam N linhas em vez de N documentos.
  check(/FROM \[dbo\]\.\[Atendimento Credito\] h\s+WHERE/.test(d), "a subquery é auto-suficiente");
  const semNome = sqlDocumentos(C, null);
  check(/NULL AS nome/.test(semNome), "sem coluna de designação, sai NULL em vez de partir");
}

console.log("\n=== a assinatura mede forma, não natureza ===");
{
  const a = sqlAssinatura(C);
  check(/COUNT\(DISTINCT h\.\[Atendimento Credito ID\]\) AS docs/.test(a), "documentos distintos");
  check(/COUNT\(DISTINCT d\.\[CodigoID\]\) AS produtos/.test(a), "produtos distintos");
  check(/WHEN d\.\[Quantidade\] = 0 THEN 1/.test(a), "fracção de quantidade zero");
  check(/WHEN d\.\[Quantidade\] < 0 THEN 1/.test(a), "fracção negativa");
  const p = sqlPerfis(C);
  check(/SELECT DISTINCT/.test(p), "os tipos e estados saem de um DISTINCT simples");
  check(!/FOR XML/i.test(p), "sem extensões do fornecedor no caminho crítico");
}

console.log("\n=== a sonda não declara nada ===");
{
  // O ponto inteiro da rev79: medir sem decidir. Se alguma destas
  // deixar de ser null, foi por analogia — que foi como se declarou o
  // 77, o `Fim Venda='S'` e o 107 sem sinal.
  eq(namespaceDaSerieCredito("VCC_1"), null, "VCC_1 continua RECUSADA");
  eq(namespaceDaSerieCredito("VOG"), null, "VOG continua RECUSADA");
  eq(
    namespaceDaSerieCredito("VCG_1"),
    "GUIAS_TRANSFERENCIA",
    "e o VCG_1, confirmado funcionalmente, continua declarado",
  );
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail === 0 ? 0 : 1);
