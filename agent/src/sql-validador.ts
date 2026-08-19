/**
 * agent/src/sql-validador.ts
 *
 * Valida a query INTEIRA, não pedaços dela.
 *
 * ── PORQUE EXISTE ────────────────────────────────────────────────────
 *
 * O reader de vendas gerava uma lista de SELECT sem vírgulas:
 *
 *     SELECT TOP (@n)
 *         d.[Detalhe ID] AS externalLineId
 *         a.[Atendimento ID] AS externalDocumentId
 *         ...
 *
 * O SQL Server responde `Incorrect syntax near 'a'` e o pipeline de
 * vendas morre antes de ler uma linha — nas duas fontes. Nada disto foi
 * apanhado porque os testes verificavam `sql.includes(fragmento)`, e
 * todos os fragmentos estavam lá: a tabela certa, o JOIN certo, a janela
 * certa. Estavam todos certos e a query estava partida.
 *
 * Fragmentos correctos não fazem uma query correcta. Só a query inteira
 * é que é a query, e é isso que este módulo verifica.
 *
 * ── O QUE ISTO É E O QUE NÃO É ───────────────────────────────────────
 *
 * NÃO é um parser de T-SQL e não substitui correr contra o servidor. É
 * um verificador estrutural do que este gerador produz: as regras abaixo
 * cobrem as formas de partir a query que ESTE código consegue produzir —
 * vírgulas, alias, parêntesis, ordem das cláusulas, parâmetros.
 *
 * A prova final continua a ser o `--dry-run` contra o ERP. A diferença é
 * que agora a classe inteira de erros de sintaxe é apanhada aqui, em
 * milissegundos, e não a meio de um backfill.
 */

export type ProblemaSql = { regra: string; detalhe: string };

/** Cláusulas de topo, pela ordem em que têm de aparecer. */
const ORDEM_CLAUSULAS = ["SELECT", "FROM", "WHERE", "ORDER BY"] as const;

/** Remove o conteúdo de literais e de identificadores `[...]`. */
function esqueleto(sql: string): string {
  return sql.replace(/'[^']*'/g, "''").replace(/\[[^\]]*\]/g, "[]");
}

/**
 * A lista de itens entre `SELECT` e `FROM`, cortada pelas vírgulas de
 * topo — as que não estão dentro de parêntesis.
 */
function itensDoSelect(sql: string): string[] {
  const i = sql.search(/\bSELECT\b/i);
  const j = sql.search(/\n\s*FROM\b/i);
  if (i < 0 || j < 0 || j < i) return [];
  let lista = sql.slice(i, j).replace(/^\s*SELECT\s+/i, "");
  lista = lista.replace(/^TOP\s*\([^)]*\)\s*/i, "").replace(/^TOP\s+\d+\s*/i, "");
  const itens: string[] = [];
  let nivel = 0;
  let actual = "";
  let emString = false;
  let emBracket = false;
  for (const c of lista) {
    if (c === "'" && !emBracket) emString = !emString;
    if (!emString) {
      if (c === "[") emBracket = true;
      else if (c === "]") emBracket = false;
      else if (c === "(") nivel++;
      else if (c === ")") nivel--;
      else if (c === "," && nivel === 0 && !emBracket) {
        itens.push(actual.trim());
        actual = "";
        continue;
      }
    }
    actual += c;
  }
  if (actual.trim().length > 0) itens.push(actual.trim());
  return itens;
}

/**
 * Verifica a query completa.
 *
 * `aliasEsperados` são os campos que o normalizador vai ler. Se o SELECT
 * não os produzir todos — ou produzir outros — a query "corre" e devolve
 * `undefined` em silêncio, que é pior do que rebentar.
 */
export function validarSelect(sql: string, aliasEsperados?: readonly string[]): ProblemaSql[] {
  const problemas: ProblemaSql[] = [];
  const erro = (regra: string, detalhe: string) => problemas.push({ regra, detalhe });
  const esq = esqueleto(sql);

  // ── parêntesis e brackets equilibrados ───────────────────────
  const abre = (esq.match(/\(/g) ?? []).length;
  const fecha = (esq.match(/\)/g) ?? []).length;
  if (abre !== fecha) erro("parentesis", `${abre} '(' para ${fecha} ')'`);
  const nAbre = (sql.match(/\[/g) ?? []).length;
  const nFecha = (sql.match(/\]/g) ?? []).length;
  if (nAbre !== nFecha) erro("brackets", `${nAbre} '[' para ${nFecha} ']'`);
  if ((sql.match(/'/g) ?? []).length % 2 !== 0) erro("literais", "número ímpar de aspas simples");

  // ── ordem das cláusulas ──────────────────────────────────────
  let anterior = -1;
  for (const c of ORDEM_CLAUSULAS) {
    const at = esq.search(new RegExp(`\\b${c.replace(" ", "\\s+")}\\b`, "i"));
    if (at < 0) {
      if (c === "SELECT" || c === "FROM") erro("clausula", `falta ${c}`);
      continue;
    }
    if (at < anterior) erro("ordem", `${c} aparece antes da cláusula anterior`);
    anterior = at;
  }

  // ── a lista do SELECT ────────────────────────────────────────
  const itens = itensDoSelect(sql);
  if (itens.length === 0) {
    erro("select", "lista do SELECT vazia");
    return problemas;
  }
  const alias: string[] = [];
  for (const item of itens) {
    if (item.length === 0) {
      erro("select", "item vazio — vírgula a mais");
      continue;
    }
    // ISTO é o que apanha o defeito original: sem vírgula, dois itens
    // colam-se e o item fica com dois `AS`.
    const nAs = (esqueleto(item).match(/\bAS\b/gi) ?? []).length;
    if (nAs === 0) {
      erro("alias", `item sem AS: ${item.slice(0, 60)}`);
      continue;
    }
    if (nAs > 1) {
      erro(
        "virgula",
        `item com ${nAs} 'AS' — faltam vírgulas entre colunas: ${item.replace(/\s+/g, " ").slice(0, 80)}`,
      );
      continue;
    }
    const m = item.match(/\bAS\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/i);
    if (!m) {
      erro("alias", `alias não legível em: ${item.replace(/\s+/g, " ").slice(0, 60)}`);
      continue;
    }
    alias.push(m[1]!);
  }

  const repetidos = alias.filter((a, i) => alias.indexOf(a) !== i);
  if (repetidos.length > 0) {
    erro("alias", `alias repetidos: ${[...new Set(repetidos)].join(", ")}`);
  }

  if (aliasEsperados) {
    const faltam = aliasEsperados.filter((a) => !alias.includes(a));
    const aMais = alias.filter((a) => !aliasEsperados.includes(a));
    if (faltam.length > 0) erro("contrato", `alias em falta: ${faltam.join(", ")}`);
    if (aMais.length > 0) erro("contrato", `alias a mais: ${aMais.join(", ")}`);
  }

  // ── vírgulas soltas fora do SELECT ───────────────────────────
  if (/,\s*FROM\b/i.test(esq)) erro("virgula", "vírgula imediatamente antes de FROM");
  if (/,\s*,/.test(esq)) erro("virgula", "duas vírgulas seguidas");
  if (/\bAND\s+AND\b|\bOR\s+OR\b/i.test(esq)) erro("where", "operador booleano repetido");
  if (/\bWHERE\s+AND\b/i.test(esq)) erro("where", "WHERE seguido de AND");

  // ── FROM/JOIN com nome e alias ───────────────────────────────
  const from = sql.match(/\n\s*FROM\s+(.+)/i);
  if (from && !/\[[^\]]+\]\.\[[^\]]+\]\s+\w+/.test(from[1]!)) {
    erro("from", `FROM sem tabela qualificada + alias: ${from[1]!.slice(0, 60)}`);
  }
  for (const j of sql.match(/\n\s*(?:LEFT\s+|RIGHT\s+|INNER\s+)?JOIN\s+.+/gi) ?? []) {
    if (!/\bON\b/i.test(j)) erro("join", `JOIN sem ON: ${j.trim().slice(0, 60)}`);
  }

  // ── parâmetros ───────────────────────────────────────────────
  // Um `@param` escrito com outro nome não dá erro de sintaxe: dá
  // "must declare the scalar variable", já dentro da corrida.
  const params = [...new Set((sql.match(/@[A-Za-z_][A-Za-z0-9_]*/g) ?? []))];
  const conhecidos = ["@n", "@from", "@to", "@lastId"];
  for (const p of params) {
    if (!conhecidos.includes(p)) erro("parametro", `parâmetro não declarado pelo caller: ${p}`);
  }

  // ── keyset ───────────────────────────────────────────────────
  // Sem ORDER BY pela mesma coluna do `> @lastId`, a paginação salta
  // linhas em silêncio — e um backfill incompleto parece ter corrido bem.
  // `d.[Detalhe ID]` tem um espaço lá dentro, portanto `\S+` não serve.
  const keyset = sql.match(/((?:\w+\.)?\[[^\]]+\]|\w+)\s*>\s*@lastId/i);
  const order = sql.match(/ORDER\s+BY\s+(.+?)\s*$/i);
  if (keyset && order) {
    const col = keyset[1]!.trim();
    if (!order[1]!.trim().startsWith(col)) {
      erro("keyset", `ORDER BY (${order[1]!.trim()}) não acompanha o keyset (${col})`);
    }
  } else if (keyset && !order) {
    erro("keyset", "keyset com @lastId sem ORDER BY — a paginação salta linhas");
  }

  return problemas;
}

/** Os campos que `normalizar` lê. O SELECT tem de produzir exactamente estes. */
export const ALIAS_FONTE_VENDA = [
  "externalLineId",
  "externalDocumentId",
  "sequencia",
  "dataVenda",
  "tipoDocumento",
  "serie",
  "numero",
  "externalProductId",
  "processaStocks",
  "quantidade",
  "pvpUnitario",
  "valorLinha",
  "ivaValor",
  "descontoValor",
  "comparticipacao1",
  "comparticipacao2",
  "entidadeId",
] as const;
