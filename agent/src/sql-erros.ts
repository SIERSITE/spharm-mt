/**
 * agent/src/sql-erros.ts
 *
 * Classificação PRUDENTE das falhas do SQL Server (biblioteca `mssql`/`tedious`): o que vale a pena repetir
 * (a ligação/ERP esteve momentaneamente indisponível) e o que nunca se repete (credenciais, base inexistente,
 * tabela/coluna inexistente, sintaxe, configuração). Puro: sem rede nem SQL.
 *
 * Formas de erro do `mssql` (v12):
 *   · `ConnectionError` — `code` ∈ { ELOGIN, ETIMEOUT, ESOCKET, ECONNCLOSED, ENOTOPEN, … };
 *     `ELOGIN` = «Login failed» (credenciais/permissões); `ETIMEOUT` = «Failed to connect to … in 15000ms»;
 *     `ESOCKET` = falha de socket (recusada, reset, DNS); `ECONNCLOSED` = «Connection is closed.»
 *   · `RequestError` — `code` ∈ { EREQUEST, ETIMEOUT, … } com `number` = número do erro do SQL Server
 *     (208 objeto inválido, 207 coluna inválida, 102/156 sintaxe, 1205 deadlock, …); `ETIMEOUT` = timeout do pedido.
 *   · em muitos casos o erro de baixo nível vem em `originalError` (e este em `.code`/`.number`).
 *
 * Regra de ouro: desconhecido ⇒ NÃO transitório (uma configuração errada nunca deve virar um ciclo de horas).
 */

import { ErroDeConfiguracao } from "./politica-retry.js";

export type ClasseSql = {
  transitoria: boolean;
  tipo:
    | "timeout_ligacao"
    | "timeout_pedido"
    | "socket"
    | "ligacao_fechada"
    | "pool_indisponivel"
    | "rede_temporaria"
    | "deadlock"
    | "servidor_a_reiniciar"
    | "credenciais"
    | "base_inexistente"
    | "objeto_inexistente"
    | "coluna_inexistente"
    | "sintaxe"
    | "permissao"
    | "configuracao"
    | "desconhecido";
  codigo?: string;
  numero?: number;
};

type Erro = { code?: unknown; number?: unknown; message?: unknown; name?: unknown; originalError?: unknown; cause?: unknown; precedingErrors?: unknown };

function cadeia(err: unknown): Erro[] {
  const out: Erro[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur && typeof cur === "object"; i++) {
    out.push(cur as Erro);
    const c = cur as Erro;
    cur = c.originalError ?? c.cause;
  }
  return out;
}

/** Números de erro do SQL Server que são PERMANENTES (a mesma query dará o mesmo erro). */
const NUMEROS_PERMANENTES: ReadonlyMap<number, ClasseSql["tipo"]> = new Map([
  [208, "objeto_inexistente"], // Invalid object name
  [207, "coluna_inexistente"], // Invalid column name
  [4060, "base_inexistente"], // Cannot open database requested by the login
  [911, "base_inexistente"], // Database does not exist
  [18456, "credenciais"], // Login failed for user
  [18452, "credenciais"], // Login failed (untrusted domain)
  [102, "sintaxe"], [105, "sintaxe"], [156, "sintaxe"], [170, "sintaxe"], [8180, "sintaxe"],
  [229, "permissao"], [230, "permissao"], [262, "permissao"], [297, "permissao"],
]);

/** Números de erro do SQL Server que são TRANSITÓRIOS (tentar de novo pode resultar). */
const NUMEROS_TRANSITORIOS: ReadonlyMap<number, ClasseSql["tipo"]> = new Map([
  [1205, "deadlock"], // vítima de deadlock
  [6005, "servidor_a_reiniciar"], [6006, "servidor_a_reiniciar"], // a desligar
  [10053, "socket"], [10054, "socket"], [10060, "socket"], [10061, "socket"], // reset / timeout / recusada (Winsock)
  [64, "socket"], // «An existing connection was forcibly closed…» durante o login
  [-2, "timeout_pedido"], // timeout do cliente (ADO/ODBC)
]);

const CODIGOS_TRANSITORIOS: ReadonlyMap<string, ClasseSql["tipo"]> = new Map([
  ["ETIMEOUT", "timeout_ligacao"],
  ["ESOCKET", "socket"],
  ["ECONNCLOSED", "ligacao_fechada"],
  ["ECONNRESET", "socket"],
  ["ETIMEDOUT", "timeout_ligacao"],
  ["ECONNREFUSED", "rede_temporaria"], // o serviço SQL Server ainda não/já não está a aceitar (reinício)
  ["EHOSTUNREACH", "rede_temporaria"],
  ["ENETUNREACH", "rede_temporaria"],
  ["ENETDOWN", "rede_temporaria"],
  ["EAI_AGAIN", "rede_temporaria"], // DNS temporário
  ["EPIPE", "socket"],
]);

export function classificarErroSql(err: unknown): ClasseSql {
  if (err instanceof ErroDeConfiguracao) return { transitoria: false, tipo: "configuracao" };
  const cad = cadeia(err);
  if (cad.length === 0) return { transitoria: false, tipo: "desconhecido" };

  const codigos = cad.map((e) => (typeof e.code === "string" ? e.code : undefined));
  const numeros = cad.map((e) => (typeof e.number === "number" ? e.number : undefined));
  const mensagens = cad.map((e) => String(e.message ?? "")).join(" | ");
  const codigo = codigos.find((c) => !!c);
  const numero = numeros.find((n) => n !== undefined);

  // 1) PERMANENTES primeiro (mesmo que o código genérico pareça de rede).
  for (const n of numeros) {
    if (n !== undefined && NUMEROS_PERMANENTES.has(n)) return { transitoria: false, tipo: NUMEROS_PERMANENTES.get(n)!, codigo, numero: n };
  }
  if (codigos.includes("ELOGIN") || /login failed|authentication failed|cannot open database|password (?:expired|must be changed)/i.test(mensagens)) {
    // Falha de LOGIN (credenciais/permissões/base). Só se for na verdade um timeout/rede disfarçado é que se repete.
    if (!/timeout|timed out|ECONNRESET|ECONNREFUSED|ESOCKET|socket|network|getaddrinfo EAI_AGAIN/i.test(mensagens) || /login failed for user/i.test(mensagens)) {
      return { transitoria: false, tipo: /cannot open database/i.test(mensagens) ? "base_inexistente" : "credenciais", codigo, numero };
    }
  }
  if (/invalid object name/i.test(mensagens)) return { transitoria: false, tipo: "objeto_inexistente", codigo, numero };
  if (/invalid column name/i.test(mensagens)) return { transitoria: false, tipo: "coluna_inexistente", codigo, numero };
  if (/incorrect syntax/i.test(mensagens)) return { transitoria: false, tipo: "sintaxe", codigo, numero };
  if (/ENOTFOUND|getaddrinfo (?:ENOTFOUND|EAI_NONAME)/i.test(mensagens)) return { transitoria: false, tipo: "configuracao", codigo, numero }; // nome do servidor errado
  if (/certificate|self[- ]signed|SSL routines|TLS/i.test(mensagens) && !/ECONNRESET|socket hang up/i.test(mensagens)) return { transitoria: false, tipo: "configuracao", codigo, numero }; // encrypt/trustCert mal configurado

  // 2) TRANSITÓRIOS conhecidos.
  for (const n of numeros) {
    if (n !== undefined && NUMEROS_TRANSITORIOS.has(n)) return { transitoria: true, tipo: NUMEROS_TRANSITORIOS.get(n)!, codigo, numero: n };
  }
  for (const c of codigos) {
    if (c && CODIGOS_TRANSITORIOS.has(c)) {
      const tipo = c === "ETIMEOUT" && /request failed to complete|timeout: request/i.test(mensagens) ? "timeout_pedido" : CODIGOS_TRANSITORIOS.get(c)!;
      return { transitoria: true, tipo, codigo: c, numero };
    }
  }
  if (/connection is closed|connection lost|socket hang up|read ECONNRESET|write EPIPE|connection (?:was )?(?:forcibly )?closed|premature close/i.test(mensagens)) {
    return { transitoria: true, tipo: "ligacao_fechada", codigo, numero };
  }
  if (/pool (?:is )?(?:closing|closed|destroyed|draining)|connection not yet open|ENOTOPEN|failed to connect to .* in \d+ms|connection timeout|timeout: request failed/i.test(mensagens) || codigos.includes("ENOTOPEN")) {
    return { transitoria: true, tipo: "pool_indisponivel", codigo, numero };
  }

  // 3) Tudo o resto — incluindo EREQUEST genéricos — NÃO se repete.
  return { transitoria: false, tipo: "desconhecido", codigo, numero };
}

/** O erro é uma falha transitória do SQL Server? */
export function eFalhaSqlTransitoria(err: unknown): boolean {
  return classificarErroSql(err).transitoria;
}

/** Esperas (ms) antes de cada retentativa SQL. Por omissão 2 retentativas: 5 s e 20 s. Vazia desliga. */
export const ESPERAS_SQL_PADRAO: readonly number[] = Object.freeze([5_000, 20_000]);

export function esperasSqlDoAmbiente(env: Record<string, string | undefined> = process.env): number[] {
  const v = env.SPHARMMT_SQL_RETRY_ESPERAS_MS;
  if (v === undefined) return [...ESPERAS_SQL_PADRAO];
  const t = v.trim();
  if (t === "" || t === "0") return [];
  const nums = t.split(",").map((x) => Number(x.trim()));
  return nums.every((n) => Number.isFinite(n) && n >= 0) && nums.length <= 5 ? nums.map((n) => Math.floor(n)) : [...ESPERAS_SQL_PADRAO];
}
