/**
 * agent/src/sql-somente-leitura.ts
 *
 * Guarda de SQL do pacote de DIAGNÓSTICO: só passa SELECT (e metadados read-only: sys.* /
 * INFORMATION_SCHEMA / SERVERPROPERTY / @@VERSION / DB_NAME / HAS_PERMS_BY_NAME, sempre via SELECT).
 *
 * É um validador PRÓPRIO, independente de `sql-validador.ts` (que verifica a ESTRUTURA do SELECT — vírgulas, alias,
 * parêntesis — e não impede escritas). O validador estrutural é chamado a seguir, sem ser enfraquecido; este aqui é
 * a barreira contra escritas. Regras (TODAS têm de passar, senão a query nunca chega ao servidor):
 *
 *   1. primeira palavra = SELECT (nada de WITH/EXEC/…);
 *   2. um único statement: nenhum `;`;
 *   3. nenhum comentário (traço-traço ou barra-asterisco): é onde se escondem palavras;
 *   4. nenhuma palavra proibida (INSERT, UPDATE, DELETE, MERGE, EXEC, EXECUTE, ALTER, CREATE, DROP, TRUNCATE,
 *      GRANT, REVOKE, DENY, INTO, OPENROWSET, OUTPUT, SET, DECLARE, …) fora de literais '…' e identificadores […];
 *   5. nenhum procedimento de sistema/extendido (xp_*, sp_*);
 *   6. nenhuma aspa dupla (identificadores `"…"` esconderiam texto da análise);
 *   7. só funções da lista permitida (impede `dbo.fn_qualquer(...)`).
 *
 * Os literais e os identificadores entre parênteses retos são esvaziados ANTES da análise, por isso uma coluna chamada
 * [Update] ou um valor 'DELETE' vindo do ERP não são falsos positivos — e uma palavra proibida nunca passa por estar
 * dentro de maiúsculas/minúsculas, quebras de linha ou espaços Unicode.
 */

import { validarSelect } from "./sql-validador.js";

export const PALAVRAS_PROIBIDAS = [
  "INSERT", "UPDATE", "DELETE", "MERGE", "DROP", "ALTER", "CREATE", "TRUNCATE",
  "EXEC", "EXECUTE", "GRANT", "REVOKE", "DENY", "INTO", "BACKUP", "RESTORE",
  "SHUTDOWN", "KILL", "DBCC", "WAITFOR", "OPENROWSET", "OPENQUERY",
  "OPENDATASOURCE", "OPENXML", "BULK", "USE", "SET", "DECLARE", "RECONFIGURE",
  "BEGIN", "COMMIT", "ROLLBACK", "TRANSACTION", "PRINT", "RAISERROR",
  "OUTPUT", "UPDATETEXT", "WRITETEXT", "CHECKPOINT", "ENABLE", "DISABLE", "SAVE", "THROW", "GOTO", "GO", "IMPORT",
] as const;
const RE_PROIBIDAS = new RegExp(`(?<![\\w@#$])(?:${PALAVRAS_PROIBIDAS.join("|")})(?![\\w$])`, "i");

/** Palavras que podem preceder um `(` sem serem chamadas de função. */
const NAO_SAO_FUNCOES = new Set([
  "AND", "OR", "NOT", "ON", "WHERE", "WHEN", "THEN", "ELSE", "CASE", "FROM", "JOIN", "SELECT", "AS", "BY", "HAVING",
  "IN", "TOP", "EXISTS", "WITH", "LIKE", "IS", "NULL", "BETWEEN", "ALL", "ANY", "DISTINCT", "ASC", "DESC", "END", "OVER",
]);
/** Funções/tipos aceites (todas puras, sem efeitos laterais). */
const FUNCOES_PERMITIDAS = new Set([
  "COUNT", "SUM", "MIN", "MAX", "AVG", "CAST", "CONVERT", "LTRIM", "RTRIM", "LEN", "DATALENGTH", "ISNULL", "COALESCE", "NULLIF",
  "UPPER", "LOWER", "SUBSTRING", "LEFT", "RIGHT", "REPLACE", "ABS", "CHARINDEX",
  "OBJECT_ID", "OBJECT_NAME", "OBJECT_SCHEMA_NAME", "DB_NAME", "DB_ID", "SCHEMA_NAME", "SERVERPROPERTY", "HAS_PERMS_BY_NAME", "COLUMNPROPERTY", "OBJECTPROPERTY",
  "NVARCHAR", "VARCHAR", "NCHAR", "CHAR", "INT", "BIGINT", "SMALLINT", "TINYINT", "DECIMAL", "NUMERIC", "FLOAT",
]);

/** Substitui literais '…' por '' e identificadores […] por []; `null` se estiverem mal fechados. */
export function esqueletoSeguro(sql: string): string | null {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "'") {
      let j = i + 1;
      let fechou = false;
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue; }
          fechou = true;
          break;
        }
        j++;
      }
      if (!fechou) return null;
      out += "''";
      i = j + 1;
    } else if (c === "[") {
      let j = i + 1;
      let fechou = false;
      while (j < sql.length) {
        if (sql[j] === "]") {
          if (sql[j + 1] === "]") { j += 2; continue; }
          fechou = true;
          break;
        }
        j++;
      }
      if (!fechou) return null;
      out += "[]";
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Lista de razões pelas quais a query NÃO é um SELECT read-only simples (vazia = aceite). */
export function validarSomenteSelect(sql: string): string[] {
  const problemas: string[] = [];
  if (typeof sql !== "string" || sql.trim() === "") return ["query vazia"];
  const esq = esqueletoSeguro(sql);
  if (esq === null) return ["literal ou identificador mal fechado"];
  if (!/^\s*SELECT\b/i.test(esq)) problemas.push("não começa por SELECT");
  if (esq.includes(";")) problemas.push("contém ';' (mais de um statement)");
  if (esq.includes("--") || esq.includes("/*") || esq.includes("*/")) problemas.push("contém comentários");
  if (esq.includes('"')) problemas.push("contém aspas duplas");
  const m = esq.match(RE_PROIBIDAS);
  if (m) problemas.push(`palavra proibida: ${m[0]!.toUpperCase()}`);
  if (/(?<![\w@#$])(?:xp|sp)_\w*/i.test(esq)) problemas.push("procedimento de sistema (xp_/sp_)");
  for (const f of esq.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    const nome = f[1]!.toUpperCase();
    if (NAO_SAO_FUNCOES.has(nome) || FUNCOES_PERMITIDAS.has(nome)) continue;
    problemas.push(`função não permitida: ${f[1]}`);
  }
  return problemas;
}

/**
 * Validação completa de uma query do diagnóstico: guarda read-only + validador estrutural existente.
 * `@@VERSION` é uma variável global (não um parâmetro).
 */
export function validarQueryAuditoria(sql: string): string[] {
  const out = validarSomenteSelect(sql);
  if (out.length > 0) return out; // nem sequer passa ao validador estrutural
  const estruturais = validarSelect(sql).filter(
    (p) => !(p.regra === "parametro" && /@VERSION\b/i.test(p.detalhe) && /@@VERSION\b/i.test(sql)),
  );
  for (const p of estruturais) out.push(`${p.regra}: ${p.detalhe}`);
  return out;
}

export class SqlRecusadoError extends Error {
  constructor(readonly motivos: string[], sql: string) {
    super(`SQL recusado pela auditoria read-only (${motivos.join("; ")}): ${sql.replace(/\s+/g, " ").slice(0, 120)}`);
    this.name = "SqlRecusadoError";
  }
}

export type Linha = Record<string, unknown>;
/** Executa UMA query (já validada) e devolve as linhas. */
export type LeitorSql = (sql: string) => Promise<Linha[]>;

/** Embrulha um executor: cada query é validada ANTES de executar e fica registada. */
export function criarLeitorSeguro(executar: LeitorSql, registo: string[] = []): LeitorSql {
  return async (sql: string) => {
    const motivos = validarQueryAuditoria(sql);
    if (motivos.length > 0) throw new SqlRecusadoError(motivos, sql);
    registo.push(sql);
    return executar(sql);
  };
}

/** Literais que são constantes da própria auditoria (nunca dados): ficam visíveis no texto das queries. */
const LITERAIS_CONSTANTES = new Set(["OBJECT", "INSERT", "UPDATE", "DELETE", "PRODUCTVERSION", "PRODUCTLEVEL", "EDITION"]);

/**
 * Texto da query SEM dados, para o cabeçalho do relatório: os literais de valor (CNPs, valores lidos do ERP) são
 * substituídos por `N'<valor>'`; os padrões de pesquisa de nomes (`LIKE N'%etico%'`), `dbo.<tabela>` e as constantes
 * da própria auditoria mantêm-se.
 */
export function mascararQuery(sql: string): string {
  return sql
    .replace(/N?'((?:[^']|'')*)'/g, (todo: string, corpo: string) =>
      /^%.*%$/.test(corpo) || /^dbo\.\w+$/i.test(corpo) || LITERAIS_CONSTANTES.has(corpo.toUpperCase()) ? todo : "N'<valor>'",
    )
    .replace(/[ \t]+\n/g, "\n");
}
