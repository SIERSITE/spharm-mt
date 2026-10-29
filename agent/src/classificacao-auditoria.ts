/**
 * agent/src/classificacao-auditoria.ts
 *
 * Núcleo (sem I/O de SQL Server) da auditoria READ-ONLY da classificação do
 * produto (Ético / NETT / Serviço / Genérico / ...). O comando
 * `commands/classification-audit.ts` liga isto a um pool real; os testes
 * ligam-no a um leitor falso.
 *
 * ── PORQUE EXISTE ───────────────────────────────────────────────────
 * Só `dbo.Stocks.[Generico]` tem coluna conhecida. Ético, NETT e Serviço NÃO
 * estão provados (nome da coluna, tabela, se são booleanos independentes ou
 * uma categoria única). Este módulo recolhe FACTOS de uma farmácia real para
 * que o modelo seja fixado depois, por pessoas, com evidência. NÃO conclui
 * significados, NÃO sugere mapeamento, NÃO escreve nada.
 *
 * ── GARANTIAS ───────────────────────────────────────────────────────
 *  · Só SELECT: `validarSomenteSelect` recusa tudo o resto (DML/DDL/EXEC/INTO/
 *    vários statements/comentários/procedimentos) ANTES de qualquer execução;
 *    além disso a query passa por `validarSelect` (agent/src/sql-validador.ts).
 *  · Nunca imprime nem grava credenciais: o relatório é sanitizado por
 *    `sanitizarRelatorio` (segredos conhecidos, e-mails, telefones, NIF).
 *  · Colunas/tabelas cujo NOME sugere dado pessoal nunca são lidas.
 *  · Amostras só com CNP/código + valores das colunas candidatas (sem nomes de
 *    clientes, sem preços).
 *  · Limites: nº de colunas inspeccionadas, valores por coluna, pares de
 *    cruzamento, amostras, CNPs pedidos e orçamento de tempo.
 */

import { validarSelect } from "./sql-validador.js";
import { redigir } from "./politica-retry.js";

// ─────────────────────────────────────────────────────────────────────
// Tipos
// ─────────────────────────────────────────────────────────────────────

export type Linha = Record<string, unknown>;
/** Executa UMA query (já validada) e devolve as linhas. */
export type LeitorSql = (sql: string) => Promise<Linha[]>;

export const FRASE_READ_ONLY = "gerado em modo read-only";
/** Rótulo de campos que o relatório nunca mostra. */
export const OMITIDO = "[omitido]";

export type OpcoesAuditoria = {
  /** Valores mais frequentes por coluna quando há muitas variantes. */
  top: number;
  /** Até este nº de distintos a lista de valores é completa. */
  limiteListaCompleta: number;
  /** Nº máximo de colunas candidatas inspeccionadas em profundidade. */
  maxColunas: number;
  /** Nº máximo de pares de colunas cruzados. */
  maxPares: number;
  /** Nº máximo de CNPs de exemplo por valor. */
  amostrasPorValor: number;
  /** Teto de queries de amostra. */
  maxQueriesAmostra: number;
  /** CNPs conhecidos a comparar (só dígitos). */
  cnps: string[];
  /** Orçamento total de tempo (ms) entre queries. */
  orcamentoMs: number;
  /** Segredos a remover do relatório (palavra-passe, utilizador, anfitrião). */
  segredos: string[];
  agentRev: string;
  agora: () => Date;
};

export const OPCOES_OMISSAO: OpcoesAuditoria = {
  top: 15,
  limiteListaCompleta: 50,
  maxColunas: 40,
  maxPares: 25,
  amostrasPorValor: 3,
  maxQueriesAmostra: 120,
  cnps: [],
  orcamentoMs: 10 * 60_000,
  segredos: [],
  agentRev: "dev",
  agora: () => new Date(),
};

// ─────────────────────────────────────────────────────────────────────
// 1. Guarda de SQL: só SELECT
// ─────────────────────────────────────────────────────────────────────

const PALAVRAS_PROIBIDAS = [
  "INSERT", "UPDATE", "DELETE", "MERGE", "DROP", "ALTER", "CREATE", "TRUNCATE",
  "EXEC", "EXECUTE", "GRANT", "REVOKE", "DENY", "INTO", "BACKUP", "RESTORE",
  "SHUTDOWN", "KILL", "DBCC", "WAITFOR", "OPENROWSET", "OPENQUERY",
  "OPENDATASOURCE", "OPENXML", "BULK", "USE", "SET", "DECLARE", "RECONFIGURE",
  "BEGIN", "COMMIT", "ROLLBACK", "TRANSACTION", "PRINT", "RAISERROR",
] as const;
const RE_PROIBIDAS = new RegExp(`\\b(?:${PALAVRAS_PROIBIDAS.join("|")})\\b`, "i");

/** Substitui literais '…' por '' e identificadores […] por []; `null` se estiverem mal fechados. */
function esqueletoSeguro(sql: string): string | null {
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
  const esq = esqueletoSeguro(sql);
  if (esq === null) return ["literal ou identificador mal fechado"];
  if (!/^\s*SELECT\b/i.test(esq)) problemas.push("não começa por SELECT");
  if (esq.includes(";")) problemas.push("contém ';' (mais de um statement)");
  if (esq.includes("--") || esq.includes("/*") || esq.includes("*/")) problemas.push("contém comentários");
  const m = esq.match(RE_PROIBIDAS);
  if (m) problemas.push(`palavra proibida: ${m[0]!.toUpperCase()}`);
  if (/\b(?:xp|sp)_\w+/i.test(esq)) problemas.push("procedimento de sistema (xp_/sp_)");
  return problemas;
}

/**
 * Validação completa de uma query da auditoria: guarda read-only + validador
 * estrutural existente. `@@VERSION` é uma variável global (não um parâmetro).
 */
export function validarQueryAuditoria(sql: string): string[] {
  const out = validarSomenteSelect(sql);
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

/** Embrulha um executor: cada query é validada ANTES de executar e fica registada. */
export function criarLeitorSeguro(
  executar: LeitorSql,
  registo: string[] = [],
): LeitorSql {
  return async (sql: string) => {
    const motivos = validarQueryAuditoria(sql);
    if (motivos.length > 0) throw new SqlRecusadoError(motivos, sql);
    registo.push(sql);
    return executar(sql);
  };
}

// ─────────────────────────────────────────────────────────────────────
// 2. Identificadores, famílias de tipo, dados pessoais
// ─────────────────────────────────────────────────────────────────────

/** Identificador entre [ ] com `]` escapado — nomes vêm de sys.*, mas nunca se confia. */
export function q(nome: string): string {
  return `[${nome.replace(/]/g, "]]")}]`;
}
/** Literal N'…' com aspas duplicadas (valores vêm do ERP, nunca do operador). */
export function lit(v: string): string {
  return `N'${v.replace(/'/g, "''")}'`;
}

export type FamiliaTipo = "texto" | "numerico" | "outro";
const TIPOS_TEXTO = new Set(["char", "varchar", "nchar", "nvarchar"]);
const TIPOS_NUMERICOS = new Set(["bit", "tinyint", "smallint", "int", "bigint", "decimal", "numeric", "float", "real", "money", "smallmoney"]);
export function familiaDoTipo(tipo: string): FamiliaTipo {
  const t = tipo.toLowerCase();
  if (TIPOS_TEXTO.has(t)) return "texto";
  if (TIPOS_NUMERICOS.has(t)) return "numerico";
  return "outro";
}

function semAcentos(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

const TOKENS_PESSOAIS = new Set([
  "nome", "name", "nif", "nipc", "nib", "iban", "cc", "bi", "rua", "fax", "cp", "mail", "email",
  "cliente", "clientes", "utente", "utentes", "paciente", "pacientes", "doente", "doentes",
  "medico", "medicos", "funcionario", "funcionarios", "operador", "operadores", "utilizador",
  "utilizadores", "user", "users", "password", "pass",
]);
const SUBSTRINGS_PESSOAIS = ["telef", "telem", "phone", "morada", "address", "endereco", "contribuinte", "passaport", "benefici", "localidade", "postal", "e-mail"];

/** O NOME sugere dado pessoal (pessoa, NIF, morada, contacto)? Conservador de propósito. */
export function pareceDadoPessoal(nome: string): boolean {
  const n = semAcentos(nome);
  if (SUBSTRINGS_PESSOAIS.some((s) => n.includes(s))) return true;
  return n.split(/[^a-z0-9]+/).some((t) => t && TOKENS_PESSOAIS.has(t));
}

/** Remove e-mails, telefones e sequências de ≥9 dígitos (NIF/telefone/cartão) de um texto. */
export function sanitizaTexto(s: string): string {
  return s
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, OMITIDO)
    .replace(/(?:\+\s?\d{1,3}[\s.-]?)?\b\d{3}[\s.-]\d{3}[\s.-]\d{3}\b/g, OMITIDO)
    .replace(/\d{9,}/g, OMITIDO);
}

function valorSeguro(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = sanitizaTexto(String(v).trim());
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

// ─────────────────────────────────────────────────────────────────────
// 3. Queries (todas SELECT; todas passam pelo validador estrutural)
// ─────────────────────────────────────────────────────────────────────

/** Fragmentos de nome (sem acentos; a collation CI_AI trata Ético/Serviço/...). */
export const PADROES_COLUNA = [
  "etico", "nett", "servic", "generic", "tipo", "natur", "categ", "famil", "classe", "class",
  "grupo", "receita", "msrm", "mnsrm", "comparticip", "processa", "retirado",
] as const;
/** Padrões que, sozinhos, elevam a prioridade de inspecção. */
const PADROES_FORTES = ["etico", "nett", "servic", "generic", "processa"] as const;

export const TABELA_STOCKS = { esquema: "dbo", tabela: "Stocks" } as const;
const COLUNAS_STOCKS_FIXAS = { cnp: "Codigo", id: "CodigoID", processa: "Processa_Stocks", retirado: "Retirado" } as const;

export function sqlVersao(): string {
  return [
    "SELECT @@VERSION AS versao, DB_NAME() AS baseDados",
    "  FROM [sys].[databases] d",
    " WHERE d.database_id = DB_ID()",
  ].join("\n");
}

export function sqlColunasCandidatas(): string {
  const likes = PADROES_COLUNA.map((p) => `c.name COLLATE Latin1_General_CI_AI LIKE N'%${p}%'`).join("\n     OR ");
  return [
    "SELECT TOP (800) sch.name AS esquema, t.name AS tabela, c.name AS coluna, ty.name AS tipo, c.max_length AS tamanho, c.is_nullable AS anulavel",
    "  FROM [sys].[columns] c",
    "  JOIN [sys].[tables] t ON t.object_id = c.object_id",
    "  JOIN [sys].[schemas] sch ON sch.schema_id = t.schema_id",
    "  JOIN [sys].[types] ty ON ty.user_type_id = c.user_type_id",
    ` WHERE t.is_ms_shipped = 0 AND (${likes})`,
    " ORDER BY sch.name, t.name, c.column_id",
  ].join("\n");
}

export function sqlLinhasPorTabela(): string {
  return [
    "SELECT TOP (5000) sch.name AS esquema, t.name AS tabela, SUM(p.rows) AS linhas",
    "  FROM [sys].[tables] t",
    "  JOIN [sys].[schemas] sch ON sch.schema_id = t.schema_id",
    "  JOIN [sys].[partitions] p ON p.object_id = t.object_id",
    " WHERE t.is_ms_shipped = 0 AND p.index_id IN (0, 1)",
    " GROUP BY sch.name, t.name",
  ].join("\n");
}

export function sqlColunasStocks(): string {
  return [
    "SELECT c.name AS coluna, ty.name AS tipo, c.max_length AS tamanho",
    "  FROM [sys].[columns] c",
    "  JOIN [sys].[types] ty ON ty.user_type_id = c.user_type_id",
    " WHERE c.object_id = OBJECT_ID('dbo.Stocks')",
    " ORDER BY c.column_id",
  ].join("\n");
}

export function sqlFksDeStocks(): string {
  return [
    "SELECT TOP (200) pc.name AS coluna, OBJECT_NAME(fk.referenced_object_id) AS tabelaRef, rc.name AS colunaRef",
    "  FROM [sys].[foreign_keys] fk",
    "  JOIN [sys].[foreign_key_columns] fkc ON fkc.constraint_object_id = fk.object_id",
    "  JOIN [sys].[columns] pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id",
    "  JOIN [sys].[columns] rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id",
    " WHERE fk.parent_object_id = OBJECT_ID('dbo.Stocks')",
  ].join("\n");
}

type Ref = { esquema: string; tabela: string };
const de = (r: Ref) => `${q(r.esquema)}.${q(r.tabela)} x WITH (NOLOCK)`;

export function sqlPerfilColuna(r: Ref, coluna: string, familia: FamiliaTipo): string {
  const c = `x.${q(coluna)}`;
  const vazio = familia === "texto" ? `LTRIM(RTRIM(${c})) = ''` : "1 = 0";
  const zero = familia === "texto" ? `LTRIM(RTRIM(${c})) = '0'` : `${c} = 0`;
  const um = familia === "texto" ? `LTRIM(RTRIM(${c})) = '1'` : `${c} = 1`;
  return [
    "SELECT COUNT(*) AS total, COUNT(" + c + ") AS preenchidas, COUNT(DISTINCT " + c + ") AS distintos,",
    `       SUM(CASE WHEN ${vazio} THEN 1 ELSE 0 END) AS vazios,`,
    `       SUM(CASE WHEN ${zero} THEN 1 ELSE 0 END) AS zeros,`,
    `       SUM(CASE WHEN ${um} THEN 1 ELSE 0 END) AS uns`,
    `  FROM ${de(r)}`,
  ].join("\n");
}

export function sqlTopValores(r: Ref, coluna: string, top: number): string {
  const n = Math.max(1, Math.min(200, Math.trunc(top)));
  const e = `CAST(x.${q(coluna)} AS NVARCHAR(100))`;
  return [
    `SELECT TOP (${n}) ${e} AS valor, COUNT(*) AS n`,
    `  FROM ${de(r)}`,
    ` GROUP BY ${e}`,
    " ORDER BY COUNT(*) DESC",
  ].join("\n");
}

export function sqlCruzada(r: Ref, a: string, b: string): string {
  const ea = `CAST(x.${q(a)} AS NVARCHAR(100))`;
  const eb = `CAST(x.${q(b)} AS NVARCHAR(100))`;
  return [
    `SELECT TOP (400) ${ea} AS a, ${eb} AS b, COUNT(*) AS n`,
    `  FROM ${de(r)}`,
    ` GROUP BY ${ea}, ${eb}`,
    " ORDER BY COUNT(*) DESC",
  ].join("\n");
}

export function sqlAmostraPorValor(coluna: string, valor: string | null, n: number): string {
  const e = `CAST(x.${q(coluna)} AS NVARCHAR(100))`;
  const cond = valor === null ? `x.${q(coluna)} IS NULL` : `${e} = ${lit(valor)}`;
  return [
    `SELECT TOP (${Math.max(1, Math.min(10, Math.trunc(n)))}) x.${q(COLUNAS_STOCKS_FIXAS.cnp)} AS cnp, x.${q(COLUNAS_STOCKS_FIXAS.id)} AS codigoId`,
    `  FROM ${de(TABELA_STOCKS)}`,
    ` WHERE ${cond}`,
    ` ORDER BY x.${q(COLUNAS_STOCKS_FIXAS.id)}`,
  ].join("\n");
}

export function sqlProcessaStocks(): string {
  const p = `x.${q(COLUNAS_STOCKS_FIXAS.processa)}`;
  return [
    "SELECT COUNT(*) AS total,",
    `       SUM(CASE WHEN ${p} = 0 THEN 1 ELSE 0 END) AS zero,`,
    `       SUM(CASE WHEN ${p} <> 0 THEN 1 ELSE 0 END) AS diferenteDeZero,`,
    `       SUM(CASE WHEN ${p} IS NULL THEN 1 ELSE 0 END) AS nulos`,
    `  FROM ${de(TABELA_STOCKS)}`,
  ].join("\n");
}

/** Exemplos (CNP/código + colunas candidatas) de artigos com Processa_Stocks = 0 ou <> 0. */
export function sqlExemplosProcessa(zero: boolean, colunas: string[], n = 10): string {
  const extras = colunas.slice(0, 6).map((c, i) => `CAST(x.${q(c)} AS NVARCHAR(60)) AS c${i}`);
  const itens = [
    `x.${q(COLUNAS_STOCKS_FIXAS.cnp)} AS cnp`,
    `x.${q(COLUNAS_STOCKS_FIXAS.id)} AS codigoId`,
    `CAST(x.${q(COLUNAS_STOCKS_FIXAS.processa)} AS NVARCHAR(20)) AS processaStocks`,
    ...extras,
  ];
  return [
    `SELECT TOP (${n}) ${itens.join(", ")}`,
    `  FROM ${de(TABELA_STOCKS)}`,
    ` WHERE x.${q(COLUNAS_STOCKS_FIXAS.processa)} ${zero ? "= 0" : "<> 0"}`,
    ` ORDER BY x.${q(COLUNAS_STOCKS_FIXAS.id)}`,
  ].join("\n");
}

/** Classificação de CNPs conhecidos. `cnps` são só dígitos (validado antes). */
export function sqlConhecidos(cnps: string[], colunas: string[]): string {
  const lista = cnps.map((c) => `'${c.replace(/[^0-9]/g, "")}'`).join(", ");
  const extras = colunas.slice(0, 12).map((c, i) => `CAST(x.${q(c)} AS NVARCHAR(60)) AS c${i}`);
  const itens = [
    `CAST(x.${q(COLUNAS_STOCKS_FIXAS.cnp)} AS NVARCHAR(30)) AS cnp`,
    `x.${q(COLUNAS_STOCKS_FIXAS.id)} AS codigoId`,
    ...extras,
  ];
  return [
    `SELECT TOP (${Math.max(1, cnps.length * 5)}) ${itens.join(", ")}`,
    `  FROM ${de(TABELA_STOCKS)}`,
    ` WHERE CAST(x.${q(COLUNAS_STOCKS_FIXAS.cnp)} AS NVARCHAR(30)) IN (${lista})`,
    ` ORDER BY x.${q(COLUNAS_STOCKS_FIXAS.id)}`,
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────
// 4. Relatório
// ─────────────────────────────────────────────────────────────────────

export type ColunaCandidata = {
  esquema: string;
  tabela: string;
  coluna: string;
  tipo: string;
  tamanho: number | null;
  anulavel: boolean;
  casou: string[];
  linhasTabela: number | null;
  /** Estado da inspecção em profundidade. */
  inspeccao: "inspeccionada" | "omitida-dado-pessoal" | "tipo-nao-inspeccionavel" | "texto-longo" | "limite-de-colunas" | "erro";
  nota?: string;
};

export type ValorContado = { valor: string | null; n: number };
export type PerfilColuna = {
  tabela: string; // esquema.tabela
  coluna: string;
  tipo: string;
  total: number;
  preenchidas: number;
  distintos: number;
  /** Contagens por categoria de valor (factos; sem interpretação). */
  categorias: { nulo: number; vazio: number; zero: number; um: number; outros: number };
  /** true = a lista de valores é completa; false = só os N mais frequentes. */
  listaCompleta: boolean;
  valores: ValorContado[];
};

export type AmostraValor = { coluna: string; valor: string | null; exemplos: Array<{ cnp: string | null; codigoId: string | null }> };

export type CelulaCruzada = { a: string | null; b: string | null; n: number };
export type TabulacaoCruzada = {
  colunaA: string;
  colunaB: string;
  /** Nº de combinações distintas observadas. */
  combinacoes: number;
  /** Linhas em que ambas valem 1/true (só se as duas colunas só têm 0/1/NULL; senão null). */
  ambasUm: number | null;
  celulas: CelulaCruzada[];
};

export type ClassificacaoDeCnp = { cnp: string; encontrado: boolean; codigoId: string | null; valores: Record<string, string | null> };

export type ServicosProcessaStocks = {
  disponivel: boolean;
  total: number;
  zero: number;
  diferenteDeZero: number;
  nulos: number;
  /** Texto fixo: o que o agent faz hoje (facto de código, não da base). */
  filtroDoAgent: string;
  /** Por coluna candidata: valores observados só com PS=0, só com PS<>0 e nos dois. */
  distinguemPorColuna: Array<{
    coluna: string;
    soComZero: ValorContado[];
    soComDiferenteDeZero: ValorContado[];
    emAmbos: Array<{ valor: string | null; zero: number; diferenteDeZero: number }>;
  }>;
  exemplosZero: Array<Record<string, string | null>>;
  exemplosDiferenteDeZero: Array<Record<string, string | null>>;
};

export type RelatorioAuditoria = {
  cabecalho: {
    geradoEmUtc: string;
    agentRev: string;
    modo: string;
    sqlServer: string | null;
    baseDados: string | null;
    queriesExecutadas: number;
  };
  colunasCandidatas: ColunaCandidata[];
  fksDeStocks: Array<{ coluna: string; tabelaRef: string; colunaRef: string }>;
  perfis: PerfilColuna[];
  amostras: AmostraValor[];
  generico: { encontrado: boolean; coluna: string | null; perfil: PerfilColuna | null; amostras: AmostraValor[] };
  cruzadas: TabulacaoCruzada[];
  servicos: ServicosProcessaStocks;
  conhecidos: ClassificacaoDeCnp[];
  avisos: string[];
};

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const nomeTabela = (r: Ref) => `${r.esquema}.${r.tabela}`;

function padroesQueCasam(coluna: string): string[] {
  const n = semAcentos(coluna);
  return PADROES_COLUNA.filter((p) => n.includes(p));
}

/** Seleção de colunas a inspeccionar em profundidade (pura, testável). */
export function classificarCandidatas(
  brutas: Array<{ esquema: string; tabela: string; coluna: string; tipo: string; tamanho: number | null; anulavel: boolean }>,
  linhasPorTabela: Map<string, number>,
  maxColunas: number,
): ColunaCandidata[] {
  const todas: ColunaCandidata[] = brutas.map((b) => {
    const casou = padroesQueCasam(b.coluna);
    const linhasTabela = linhasPorTabela.get(`${b.esquema}.${b.tabela}`.toLowerCase()) ?? null;
    const base: ColunaCandidata = { ...b, casou, linhasTabela, inspeccao: "inspeccionada" };
    if (pareceDadoPessoal(b.coluna) || pareceDadoPessoal(b.tabela)) {
      return { ...base, inspeccao: "omitida-dado-pessoal", nota: "nome da coluna/tabela sugere dado pessoal: não lida" };
    }
    if (familiaDoTipo(b.tipo) === "outro") {
      return { ...base, inspeccao: "tipo-nao-inspeccionavel", nota: `tipo ${b.tipo} não inspeccionado` };
    }
    if (familiaDoTipo(b.tipo) === "texto" && (b.tamanho === -1 || (b.tamanho ?? 0) > 500)) {
      return { ...base, inspeccao: "texto-longo", nota: "texto longo (provável texto livre): não lido" };
    }
    return base;
  });
  const elegiveis = todas
    .filter((c) => c.inspeccao === "inspeccionada")
    .sort((x, y) => prioridade(y) - prioridade(x));
  const escolhidas = new Set(elegiveis.slice(0, maxColunas));
  for (const c of elegiveis) {
    if (!escolhidas.has(c)) {
      c.inspeccao = "limite-de-colunas";
      c.nota = `fora do limite de ${maxColunas} colunas (aumentar com --max-colunas)`;
    }
  }
  return todas;
}

function prioridade(c: ColunaCandidata): number {
  let p = 0;
  const nome = semAcentos(c.coluna);
  if (c.esquema.toLowerCase() === "dbo" && c.tabela.toLowerCase() === "stocks") p += 1000;
  if (nome === "generico") p += 500;
  if (PADROES_FORTES.some((f) => nome.includes(f))) p += 300;
  if (c.linhasTabela !== null && c.linhasTabela <= 20_000) p += 50;
  p += c.casou.length;
  return p;
}

async function tentar<T>(avisos: string[], rotulo: string, f: () => Promise<T>): Promise<T | null> {
  try {
    return await f();
  } catch (err) {
    avisos.push(`${rotulo}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300));
    return null;
  }
}

const SO_ZERO_UM = new Set(["0", "1", "true", "false"]);

/** Tabulação cruzada → factos (sem conclusões). Pura. */
export function resumirCruzada(
  colunaA: string,
  colunaB: string,
  linhas: Array<{ a: unknown; b: unknown; n: unknown }>,
): TabulacaoCruzada {
  const celulas = linhas.map((l) => ({ a: valorSeguro(l.a), b: valorSeguro(l.b), n: num(l.n) }));
  const soBinario = (sel: (c: CelulaCruzada) => string | null) =>
    celulas.every((c) => sel(c) === null || SO_ZERO_UM.has(String(sel(c)).toLowerCase()));
  const binarias = soBinario((c) => c.a) && soBinario((c) => c.b);
  const ambasUm = binarias
    ? celulas
        .filter((c) => c.a !== null && c.b !== null && ["1", "true"].includes(c.a.toLowerCase()) && ["1", "true"].includes(c.b.toLowerCase()))
        .reduce((s, c) => s + c.n, 0)
    : null;
  return { colunaA, colunaB, combinacoes: celulas.length, ambasUm, celulas };
}

/** Executa a auditoria completa através do leitor (já seguro). */
export async function executarAuditoria(ler: LeitorSql, parciais: Partial<OpcoesAuditoria> = {}): Promise<RelatorioAuditoria> {
  const o: OpcoesAuditoria = { ...OPCOES_OMISSAO, ...parciais };
  const t0 = Date.now();
  const avisos: string[] = [];
  const dentroDoOrcamento = () => Date.now() - t0 < o.orcamentoMs;
  let queries = 0;
  const lerContado: LeitorSql = async (s) => {
    queries++;
    return ler(s);
  };

  // ── servidor ─────────────────────────────────────────────
  const v = await tentar(avisos, "versão", () => lerContado(sqlVersao()));
  const sqlServer = v?.[0]?.versao ? sanitizaTexto(String(v[0].versao).split(/\r?\n/)[0]!.trim()) : null;
  const baseDados = v?.[0]?.baseDados ? String(v[0].baseDados) : null;

  // ── candidatas ───────────────────────────────────────────
  const linhasRows = (await tentar(avisos, "linhas por tabela", () => lerContado(sqlLinhasPorTabela()))) ?? [];
  const linhasPorTabela = new Map<string, number>(
    linhasRows.map((r) => [`${String(r.esquema)}.${String(r.tabela)}`.toLowerCase(), num(r.linhas)]),
  );
  const brutas = ((await tentar(avisos, "colunas candidatas", () => lerContado(sqlColunasCandidatas()))) ?? []).map((r) => ({
    esquema: String(r.esquema),
    tabela: String(r.tabela),
    coluna: String(r.coluna),
    tipo: String(r.tipo),
    tamanho: r.tamanho === null || r.tamanho === undefined ? null : num(r.tamanho),
    anulavel: Boolean(r.anulavel),
  }));
  if (brutas.length >= 800) avisos.push("lista de colunas candidatas truncada a 800");
  const candidatas = classificarCandidatas(brutas, linhasPorTabela, o.maxColunas);

  // ── Stocks: colunas existentes e FKs ─────────────────────
  const colsStocks = ((await tentar(avisos, "colunas de Stocks", () => lerContado(sqlColunasStocks()))) ?? []).map((r) => ({
    coluna: String(r.coluna),
    tipo: String(r.tipo),
  }));
  const existeStocks = (n: string) => colsStocks.some((c) => c.coluna.toLowerCase() === n.toLowerCase());
  const temCnp = existeStocks(COLUNAS_STOCKS_FIXAS.cnp) && existeStocks(COLUNAS_STOCKS_FIXAS.id);
  const temProcessa = existeStocks(COLUNAS_STOCKS_FIXAS.processa);
  const fks = ((await tentar(avisos, "FKs de Stocks", () => lerContado(sqlFksDeStocks()))) ?? [])
    .map((r) => ({ coluna: String(r.coluna), tabelaRef: String(r.tabelaRef), colunaRef: String(r.colunaRef) }))
    .filter((f) => !pareceDadoPessoal(f.coluna) && !pareceDadoPessoal(f.tabelaRef));

  // ── perfis ───────────────────────────────────────────────
  const perfis: PerfilColuna[] = [];
  /** Valores ORIGINAIS (só em memória, para os WHERE das amostras; nunca saem no relatório). */
  const brutos = new Map<PerfilColuna, Array<string | null>>();
  for (const c of candidatas) {
    if (c.inspeccao !== "inspeccionada") continue;
    if (!dentroDoOrcamento()) {
      c.inspeccao = "erro";
      c.nota = "orçamento de tempo esgotado";
      continue;
    }
    const ref: Ref = { esquema: c.esquema, tabela: c.tabela };
    const fam = familiaDoTipo(c.tipo);
    const r = await tentar(avisos, `perfil ${nomeTabela(ref)}.${c.coluna}`, async () => {
      const resumo = (await lerContado(sqlPerfilColuna(ref, c.coluna, fam)))[0] ?? {};
      const distintos = num(resumo.distintos);
      const completa = distintos <= o.limiteListaCompleta;
      const vals = await lerContado(sqlTopValores(ref, c.coluna, completa ? o.limiteListaCompleta + 1 : o.top));
      const total = num(resumo.total);
      const preenchidas = num(resumo.preenchidas);
      const vazio = num(resumo.vazios);
      const zero = num(resumo.zeros);
      const um = num(resumo.uns);
      const perfil: PerfilColuna = {
        tabela: nomeTabela(ref),
        coluna: c.coluna,
        tipo: c.tipo,
        total,
        preenchidas,
        distintos,
        categorias: { nulo: total - preenchidas, vazio, zero, um, outros: Math.max(0, preenchidas - vazio - zero - um) },
        listaCompleta: completa,
        valores: vals.map((x) => ({ valor: valorSeguro(x.valor), n: num(x.n) })),
      };
      brutos.set(perfil, vals.map((x) => (x.valor === null || x.valor === undefined ? null : String(x.valor))));
      return perfil;
    });
    if (r) {
      perfis.push(r);
    } else {
      c.inspeccao = "erro";
      c.nota = "erro ao inspeccionar (ver avisos)";
    }
  }

  const perfisStocks = perfis.filter((p) => p.tabela.toLowerCase() === "dbo.stocks");
  const baixaCardinalidade = (p: PerfilColuna, max: number) => p.distintos <= max && p.listaCompleta;

  // ── amostras CNP/código por valor (Stocks) ───────────────
  const amostras: AmostraValor[] = [];
  if (temCnp) {
    let gastas = 0;
    for (const p of perfisStocks) {
      if (!baixaCardinalidade(p, 12)) continue;
      const originais = brutos.get(p) ?? [];
      for (let i = 0; i < p.valores.length; i++) {
        if (gastas >= o.maxQueriesAmostra || !dentroDoOrcamento()) break;
        const original = originais[i] ?? null;
        // Valores que parecem dados pessoais (ou truncáveis) nunca voltam ao SQL nem ao relatório.
        if (original !== null && (sanitizaTexto(original) !== original || original.length > 60 || /[\[\];]|--|\/\*/.test(original))) continue;
        gastas++;
        const rows = await tentar(avisos, `amostra ${p.coluna}`, () => lerContado(sqlAmostraPorValor(p.coluna, original, o.amostrasPorValor)));
        if (rows) {
          amostras.push({
            coluna: p.coluna,
            valor: p.valores[i]!.valor,
            exemplos: rows.map((r) => ({ cnp: valorSeguro(r.cnp), codigoId: valorSeguro(r.codigoId) })),
          });
        }
      }
    }
  } else {
    avisos.push("amostras CNP/código não geradas: dbo.Stocks sem coluna Codigo/CodigoID");
  }

  // ── Genérico ─────────────────────────────────────────────
  const perfilGen = perfisStocks.find((p) => semAcentos(p.coluna) === "generico") ?? null;
  const generico = {
    encontrado: perfilGen !== null,
    coluna: perfilGen?.coluna ?? null,
    perfil: perfilGen,
    amostras: perfilGen ? amostras.filter((a) => a.coluna === perfilGen.coluna) : [],
  };

  // ── cruzadas (SQL agregado) ──────────────────────────────
  const cruzadas: TabulacaoCruzada[] = [];
  const cands = perfisStocks.filter((p) => baixaCardinalidade(p, 30));
  const colunasCruzaveis = [...cands.map((p) => p.coluna)];
  for (const extra of [COLUNAS_STOCKS_FIXAS.processa, COLUNAS_STOCKS_FIXAS.retirado]) {
    if (existeStocks(extra) && !colunasCruzaveis.some((c) => c.toLowerCase() === extra.toLowerCase())) colunasCruzaveis.push(extra);
  }
  const pares: Array<[string, string]> = [];
  for (let i = 0; i < colunasCruzaveis.length; i++) {
    for (let j = i + 1; j < colunasCruzaveis.length; j++) pares.push([colunasCruzaveis[i]!, colunasCruzaveis[j]!]);
  }
  if (pares.length > o.maxPares) avisos.push(`pares de colunas limitados a ${o.maxPares} (de ${pares.length})`);
  for (const [a, b] of pares.slice(0, o.maxPares)) {
    if (!dentroDoOrcamento()) {
      avisos.push("orçamento de tempo esgotado antes de terminar as tabulações cruzadas");
      break;
    }
    const rows = await tentar(avisos, `cruzada ${a} x ${b}`, () => lerContado(sqlCruzada(TABELA_STOCKS, a, b)));
    if (rows) {
      cruzadas.push(resumirCruzada(a, b, rows as Array<{ a: unknown; b: unknown; n: unknown }>));
    }
  }

  // ── Serviços / Processa_Stocks ───────────────────────────
  const servicos: ServicosProcessaStocks = {
    disponivel: temProcessa,
    total: 0,
    zero: 0,
    diferenteDeZero: 0,
    nulos: 0,
    filtroDoAgent:
      "O agent só envia produtos com Stocks.[Processa_Stocks] <> 0 (bootstrap-upload / daily-sync). " +
      "As contagens abaixo mostram quantos artigos ficam de fora desse filtro; NÃO provam que Processa_Stocks = 0 equivale a serviço.",
    distinguemPorColuna: [],
    exemplosZero: [],
    exemplosDiferenteDeZero: [],
  };
  if (temProcessa) {
    const r = await tentar(avisos, "Processa_Stocks", () => lerContado(sqlProcessaStocks()));
    if (r && r[0]) {
      servicos.total = num(r[0].total);
      servicos.zero = num(r[0].zero);
      servicos.diferenteDeZero = num(r[0].diferenteDeZero);
      servicos.nulos = num(r[0].nulos);
    }
    // colunas que "distinguem": valores observados só de um dos lados
    for (const t of cruzadas) {
      const proc = COLUNAS_STOCKS_FIXAS.processa.toLowerCase();
      const outra = t.colunaA.toLowerCase() === proc ? t.colunaB : t.colunaB.toLowerCase() === proc ? t.colunaA : null;
      if (!outra) continue;
      const procEhA = t.colunaA.toLowerCase() === proc;
      const porValor = new Map<string | null, { zero: number; nz: number }>();
      for (const c of t.celulas) {
        const val = procEhA ? c.b : c.a;
        const ps = procEhA ? c.a : c.b;
        const e = porValor.get(val) ?? { zero: 0, nz: 0 };
        if (ps !== null && /^-?0+(\.0*)?$/.test(ps)) e.zero += c.n;
        else if (ps !== null) e.nz += c.n;
        porValor.set(val, e);
      }
      servicos.distinguemPorColuna.push({
        coluna: outra,
        soComZero: [...porValor].filter(([, e]) => e.zero > 0 && e.nz === 0).map(([valor, e]) => ({ valor, n: e.zero })),
        soComDiferenteDeZero: [...porValor].filter(([, e]) => e.nz > 0 && e.zero === 0).map(([valor, e]) => ({ valor, n: e.nz })),
        emAmbos: [...porValor].filter(([, e]) => e.nz > 0 && e.zero > 0).map(([valor, e]) => ({ valor, zero: e.zero, diferenteDeZero: e.nz })),
      });
    }
    if (temCnp) {
      const extras = perfisStocks.filter((p) => baixaCardinalidade(p, 30)).map((p) => p.coluna);
      const ex = (zero: boolean) =>
        tentar(avisos, `exemplos Processa_Stocks ${zero ? "= 0" : "<> 0"}`, () => lerContado(sqlExemplosProcessa(zero, extras)));
      const mapear = (rows: Linha[] | null) =>
        (rows ?? []).map((r) => {
          const o2: Record<string, string | null> = { cnp: valorSeguro(r.cnp), codigoId: valorSeguro(r.codigoId), processaStocks: valorSeguro(r.processaStocks) };
          extras.slice(0, 6).forEach((c, i) => { o2[c] = valorSeguro(r[`c${i}`]); });
          return o2;
        });
      servicos.exemplosZero = mapear(await ex(true));
      servicos.exemplosDiferenteDeZero = mapear(await ex(false));
    }
  } else {
    avisos.push("dbo.Stocks sem coluna Processa_Stocks: secção de serviços indisponível");
  }

  // ── CNPs conhecidos ──────────────────────────────────────
  const conhecidos: ClassificacaoDeCnp[] = [];
  if (o.cnps.length > 0) {
    if (!temCnp) {
      avisos.push("CNPs conhecidos não consultados: dbo.Stocks sem coluna Codigo/CodigoID");
    } else {
      const colunasConhecidas = [
        ...perfisStocks.map((p) => p.coluna),
        ...[COLUNAS_STOCKS_FIXAS.processa, COLUNAS_STOCKS_FIXAS.retirado].filter(
          (c) => existeStocks(c) && !perfisStocks.some((p) => p.coluna.toLowerCase() === c.toLowerCase()),
        ),
      ].slice(0, 12);
      const rows = (await tentar(avisos, "CNPs conhecidos", () => lerContado(sqlConhecidos(o.cnps, colunasConhecidas)))) ?? [];
      const porCnp = new Map<string, Linha>();
      for (const r of rows) porCnp.set(String(r.cnp).trim(), r);
      for (const cnp of o.cnps) {
        const r = porCnp.get(cnp);
        const valores: Record<string, string | null> = {};
        if (r) colunasConhecidas.forEach((c, i) => { valores[c] = valorSeguro(r[`c${i}`]); });
        conhecidos.push({ cnp, encontrado: !!r, codigoId: r ? valorSeguro(r.codigoId) : null, valores });
      }
    }
  }

  const rel: RelatorioAuditoria = {
    cabecalho: {
      geradoEmUtc: o.agora().toISOString(),
      agentRev: o.agentRev,
      modo: FRASE_READ_ONLY,
      sqlServer,
      baseDados,
      queriesExecutadas: queries,
    },
    colunasCandidatas: candidatas,
    fksDeStocks: fks,
    perfis,
    amostras,
    generico,
    cruzadas,
    servicos,
    conhecidos,
    avisos,
  };
  return sanitizarRelatorio(rel, o.segredos);
}

/** Aplica sanitização a TODAS as strings do relatório (defesa em profundidade) e remove segredos. */
export function sanitizarRelatorio(rel: RelatorioAuditoria, segredos: string[]): RelatorioAuditoria {
  const limpar = (s: string) => redigir(sanitizaTexto(s), segredos);
  const visita = (x: unknown): unknown => {
    if (typeof x === "string") return limpar(x);
    if (Array.isArray(x)) return x.map(visita);
    if (x && typeof x === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(x as Record<string, unknown>)) o[k] = visita(v);
      return o;
    }
    return x;
  };
  return visita(rel) as RelatorioAuditoria;
}

// ─────────────────────────────────────────────────────────────────────
// 5. Markdown
// ─────────────────────────────────────────────────────────────────────

const cel = (v: string | null | undefined) => (v === null || v === undefined ? "NULL" : `\`${String(v).replace(/\|/g, "\\|")}\``);

export function renderMarkdown(r: RelatorioAuditoria): string {
  const L: string[] = [];
  const h = r.cabecalho;
  L.push("# classification-audit", "");
  L.push(
    `- Gerado em (UTC): **${h.geradoEmUtc}**`,
    `- Agent: **rev${h.agentRev}**`,
    `- Modo: **${h.modo}**`,
    `- SQL Server: ${h.sqlServer ?? "(não obtido)"}`,
    `- Base de dados: ${h.baseDados ?? "(não obtida)"}`,
    `- Queries executadas (todas SELECT): ${h.queriesExecutadas}`,
    "",
    "> Relatório de FACTOS. Não conclui significados nem propõe mapeamento: serve para fixar o modelo (booleanos independentes, categoria única, ...) com quem conhece o ERP.",
    "",
  );

  L.push("## 1. Colunas candidatas (todas as tabelas de utilizador)", "");
  L.push("| tabela | coluna | tipo | linhas da tabela | casou com | estado |", "|---|---|---|---|---|---|");
  for (const c of r.colunasCandidatas) {
    L.push(`| ${c.esquema}.${c.tabela} | ${c.inspeccao === "omitida-dado-pessoal" ? OMITIDO : c.coluna} | ${c.tipo}${c.tamanho && c.tamanho > 0 ? `(${c.tamanho})` : ""} | ${c.linhasTabela ?? "?"} | ${c.casou.join(", ")} | ${c.inspeccao}${c.nota ? ` — ${c.nota}` : ""} |`);
  }
  L.push("");
  if (r.fksDeStocks.length > 0) {
    L.push("FKs declaradas de dbo.Stocks:", "");
    for (const f of r.fksDeStocks) L.push(`- Stocks.[${f.coluna}] -> ${f.tabelaRef}.[${f.colunaRef}]`);
    L.push("");
  }

  L.push("## 2. Valores distintos e contagens por coluna", "");
  for (const p of r.perfis) {
    L.push(`### ${p.tabela}.[${p.coluna}] (${p.tipo})`, "");
    L.push(
      `Linhas: ${p.total} · preenchidas: ${p.preenchidas} · distintos: ${p.distintos}` +
        (p.listaCompleta ? "" : ` · lista parcial (top ${p.valores.length})`),
      "",
      `Categorias (contagens): NULL=${p.categorias.nulo}, vazio=${p.categorias.vazio}, zero=${p.categorias.zero}, um=${p.categorias.um}, outros=${p.categorias.outros}`,
      "",
      "| valor | linhas |",
      "|---|---|",
    );
    for (const v of p.valores) L.push(`| ${cel(v.valor)} | ${v.n} |`);
    L.push("");
  }

  L.push("## 3. Genérico (dbo.Stocks.[Generico])", "");
  if (!r.generico.encontrado) L.push("Coluna Generico não encontrada/inspeccionada em dbo.Stocks.", "");
  else {
    const p = r.generico.perfil!;
    L.push(`Coluna \`${p.coluna}\` (${p.tipo}): distintos ${p.distintos}.`, "", "| valor | linhas | exemplos CNP |", "|---|---|---|");
    for (const v of p.valores) {
      const ex = r.generico.amostras.find((a) => a.valor === v.valor)?.exemplos.map((e) => e.cnp ?? "?").join(", ") ?? "";
      L.push(`| ${cel(v.valor)} | ${v.n} | ${ex} |`);
    }
    L.push("");
  }

  L.push("## 4. Amostras CNP/código por valor (sem nomes, sem preços)", "");
  L.push("| coluna | valor | CNP (CodigoID) |", "|---|---|---|");
  for (const a of r.amostras) L.push(`| ${a.coluna} | ${cel(a.valor)} | ${a.exemplos.map((e) => `${e.cnp ?? "?"} (${e.codigoId ?? "?"})`).join(", ")} |`);
  L.push("");

  L.push("## 5. Relação entre colunas candidatas (tabulação cruzada, calculada em SQL)", "");
  L.push("Factos: combinações observadas. Nenhuma conclusão automática sobre exclusividade ou independência.", "");
  for (const t of r.cruzadas) {
    L.push(`### ${t.colunaA} × ${t.colunaB} — ${t.combinacoes} combinações${t.ambasUm !== null ? ` · linhas com ambas = 1: ${t.ambasUm}` : ""}`, "");
    L.push(`| ${t.colunaA} | ${t.colunaB} | linhas |`, "|---|---|---|");
    for (const c of t.celulas) L.push(`| ${cel(c.a)} | ${cel(c.b)} | ${c.n} |`);
    L.push("");
  }

  const s = r.servicos;
  L.push("## 6. Serviços e Processa_Stocks", "");
  L.push(s.filtroDoAgent, "");
  if (!s.disponivel) L.push("Coluna Processa_Stocks indisponível.", "");
  else {
    L.push(`Total de artigos: ${s.total} · Processa_Stocks = 0: **${s.zero}** · Processa_Stocks <> 0: **${s.diferenteDeZero}** · NULL: ${s.nulos}`, "");
    for (const d of s.distinguemPorColuna) {
      L.push(`### Coluna ${d.coluna} × Processa_Stocks`, "");
      L.push(`- valores só com Processa_Stocks = 0: ${d.soComZero.map((v) => `${cel(v.valor)}×${v.n}`).join(", ") || "(nenhum)"}`);
      L.push(`- valores só com Processa_Stocks <> 0: ${d.soComDiferenteDeZero.map((v) => `${cel(v.valor)}×${v.n}`).join(", ") || "(nenhum)"}`);
      L.push(`- valores nos dois grupos: ${d.emAmbos.map((v) => `${cel(v.valor)} (=0: ${v.zero}; <>0: ${v.diferenteDeZero})`).join(", ") || "(nenhum)"}`, "");
    }
    const tabelaEx = (titulo: string, ex: Array<Record<string, string | null>>) => {
      L.push(`**${titulo}**`, "");
      if (ex.length === 0) { L.push("(sem exemplos)", ""); return; }
      const cols = Object.keys(ex[0]!);
      L.push(`| ${cols.join(" | ")} |`, `|${cols.map(() => "---").join("|")}|`);
      for (const e of ex) L.push(`| ${cols.map((c) => cel(e[c])).join(" | ")} |`);
      L.push("");
    };
    tabelaEx("Exemplos com Processa_Stocks = 0", s.exemplosZero);
    tabelaEx("Exemplos com Processa_Stocks <> 0", s.exemplosDiferenteDeZero);
  }

  if (r.conhecidos.length > 0) {
    L.push("## 7. CNPs conhecidos (comparação)", "");
    const cols = [...new Set(r.conhecidos.flatMap((c) => Object.keys(c.valores)))];
    L.push(`| CNP | encontrado | CodigoID | ${cols.join(" | ")} |`, `|---|---|---|${cols.map(() => "---").join("|")}|`);
    for (const c of r.conhecidos) L.push(`| ${c.cnp} | ${c.encontrado ? "sim" : "NÃO"} | ${c.codigoId ?? ""} | ${cols.map((k) => cel(c.valores[k])).join(" | ")} |`);
    L.push("");
  }

  if (r.avisos.length > 0) {
    L.push("## Avisos", "");
    for (const a of r.avisos) L.push(`- ${a}`);
    L.push("");
  }
  return L.join("\n");
}

// ─────────────────────────────────────────────────────────────────────
// 6. CNPs de entrada
// ─────────────────────────────────────────────────────────────────────

/** Extrai CNPs (só dígitos, 1–9) de texto separado por vírgulas/espaços/linhas. Devolve também o nº de tokens inválidos. */
export function parseCnps(texto: string, max = 200): { cnps: string[]; invalidos: number } {
  const tokens = texto.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean);
  const vistos = new Set<string>();
  let invalidos = 0;
  for (const t of tokens) {
    if (/^\d{1,9}$/.test(t)) vistos.add(String(Number(t)));
    else invalidos++;
  }
  const cnps = [...vistos].slice(0, max);
  if (vistos.size > max) invalidos += vistos.size - max;
  return { cnps, invalidos };
}
