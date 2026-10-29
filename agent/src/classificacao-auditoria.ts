/**
 * agent/src/classificacao-auditoria.ts
 *
 * Núcleo (sem I/O de SQL Server) da auditoria READ-ONLY da classificação do
 * produto (Genérico / Ético / NETT / Serviço / ...). O comando
 * `commands/classification-audit.ts` liga isto a um pool real; os testes
 * ligam-no a um leitor falso.
 *
 * ── PORQUE EXISTE ───────────────────────────────────────────────────
 * Só `dbo.Stocks.[Generico]` tem coluna conhecida. Ético, NETT e Serviço NÃO
 * estão provados: nem o nome da coluna, nem a tabela, nem sequer se existem
 * como campos independentes, como uma categoria única, como códigos de uma
 * tabela relacionada, como propriedade derivada de outra coluna ou se não
 * existem. Este módulo recolhe FACTOS de uma farmácia real para que o modelo
 * seja fixado depois, por pessoas, com evidência. NÃO conclui significados,
 * NÃO sugere mapeamento, NÃO escreve nada.
 *
 * ── GARANTIAS ───────────────────────────────────────────────────────
 *  · Só SELECT: `sql-somente-leitura.ts` recusa tudo o resto (DML/DDL/EXEC/INTO/
 *    vários statements/comentários/procedimentos/funções desconhecidas) ANTES de
 *    qualquer execução; além disso a query passa por `validarSelect`
 *    (agent/src/sql-validador.ts, intacto).
 *  · Nunca imprime nem grava credenciais: o relatório é sanitizado por
 *    `sanitizarRelatorio` (segredos conhecidos, e-mails, telefones, NIF).
 *  · Colunas/tabelas cujo NOME sugere dado pessoal ou monetário nunca são lidas.
 *  · Amostras só com CNP/código + valores das colunas candidatas (sem nomes de
 *    clientes, sem preços).
 *  · Limites: nº de colunas inspeccionadas, valores por coluna, pares de
 *    cruzamento, amostras, CNPs pedidos e orçamento de tempo.
 */

import { redigir } from "./politica-retry.js";
import {
  criarLeitorSeguro,
  mascararQuery,
  SqlRecusadoError,
  validarQueryAuditoria,
  validarSomenteSelect,
  type LeitorSql,
  type Linha,
} from "./sql-somente-leitura.js";
import { PACOTE_BASE_REV, PACOTE_ID, FRASE_PACOTE, versaoDoPacote } from "./diagnostico-pacote.js";

// A guarda de SQL vive em `sql-somente-leitura.ts`; reexportada para quem já a importava daqui.
export { criarLeitorSeguro, SqlRecusadoError, validarQueryAuditoria, validarSomenteSelect };
export type { LeitorSql, Linha };

export const FRASE_READ_ONLY = "gerado em modo read-only";
/** Rótulo de campos que o relatório nunca mostra. */
export const OMITIDO = "[omitido]";

export type PacoteInfo = { id: string; versao: string; baseRev: string; diagnostico: true; instalavel: false; commit: string | null };

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
  /** Nº máximo de tabelas pequenas cujo conteúdo (códigos/descrições) é lido. */
  maxTabelasConteudo: number;
  /** CNPs conhecidos a comparar (só dígitos). */
  cnps: string[];
  /** Orçamento total de tempo (ms) entre queries. */
  orcamentoMs: number;
  /** Segredos a remover do relatório (palavra-passe, utilizador, anfitrião). */
  segredos: string[];
  /** Identificação do pacote de diagnóstico (cabeçalho do relatório). */
  pacote: PacoteInfo;
  /** Texto (já mascarado) das queries executadas — preenchido pelo comando a partir do leitor seguro. */
  queriesExecutadasTexto?: () => string[];
  agora: () => Date;
};

export function pacoteOmissao(commit: string | null = null): PacoteInfo {
  return { id: PACOTE_ID, versao: versaoDoPacote(), baseRev: PACOTE_BASE_REV, diagnostico: true, instalavel: false, commit };
}

export const OPCOES_OMISSAO: OpcoesAuditoria = {
  top: 15,
  limiteListaCompleta: 50,
  maxColunas: 40,
  maxPares: 40,
  amostrasPorValor: 3,
  maxQueriesAmostra: 120,
  maxTabelasConteudo: 25,
  cnps: [],
  orcamentoMs: 10 * 60_000,
  segredos: [],
  pacote: pacoteOmissao(),
  agora: () => new Date(),
};

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
const SUBSTRINGS_PESSOAIS = [
  "telef", "telem", "phone", "morada", "address", "endereco", "contribuinte", "passaport", "benefici", "localidade", "postal", "e-mail",
  "client", "utent", "pacient", "doent", "funcionar", "utilizador", "password",
];
/** Tokens monetários/comerciais: o diagnóstico nunca lê preços, custos, valores de venda. */
const TOKENS_MONETARIOS = new Set(["preco", "precos", "pvp", "pvf", "pcl", "custo", "custos", "price", "cost", "margem", "desconto", "valor", "total", "venda", "vendas", "receber"]);

/** O NOME sugere dado pessoal (pessoa, NIF, morada, contacto)? Conservador de propósito. */
export function pareceDadoPessoal(nome: string): boolean {
  // CamelCase («TipoCliente», «NomeUtente») conta como várias palavras.
  const n = semAcentos(nome.replace(/([a-z0-9])([A-Z])/g, "$1 $2"));
  if (SUBSTRINGS_PESSOAIS.some((s) => n.includes(s))) return true;
  return n.split(/[^a-z0-9]+/).some((t) => t && TOKENS_PESSOAIS.has(t));
}
/** Dado pessoal OU monetário (nome). Usado para decidir o que NUNCA se lê. */
export function pareceDadoSensivel(nome: string): boolean {
  if (pareceDadoPessoal(nome)) return true;
  return semAcentos(nome.replace(/([a-z0-9])([A-Z])/g, "$1 $2")).split(/[^a-z0-9]+/).some((t) => t && TOKENS_MONETARIOS.has(t));
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
  "grupo", "receita", "prescri", "msrm", "mnsrm", "comparticip", "processa", "retirado",
] as const;
/** Padrões que, sozinhos, elevam a prioridade de inspecção. */
const PADROES_FORTES = ["etico", "nett", "servic", "generic", "processa"] as const;

/** Fragmentos de nome de TABELA que a auditoria lista (estrutura + nº de linhas). */
export const PADROES_TABELA = [
  "etico", "nett", "servic", "generic", "tipo", "natur", "categ", "famil", "classe", "receita", "prescri", "msrm", "mnsrm",
  "comparticip", "produto", "artigo", "stock",
] as const;
/** Subconjunto cujo conteúdo, se a tabela for pequena, é lido (códigos/descrições de domínio). */
const PADROES_TABELA_DOMINIO = [
  "etico", "nett", "servic", "generic", "tipo", "natur", "categ", "famil", "classe", "receita", "prescri", "msrm", "mnsrm", "comparticip",
] as const;
/** Tabelas onde se procura a versão do SPharm / parâmetros da aplicação. */
export const PADROES_TABELA_VERSAO = ["versao", "version", "release", "upgrade", "actualiz", "atualiz", "param", "licen"] as const;
const PADROES_VERSAO_CONTEUDO = ["versao", "version", "release", "upgrade"] as const;

/** Tabelas-chave do ERP (as que o agent lê): presença/ausência e nº de linhas. */
export const TABELAS_CHAVE = [
  "Stocks", "StocksMov", "ArmazensStocks", "Armazens", "Atendimento", "Atendimento Detalhe", "Fornecedores",
  "Recepcao", "Recepcao Detalhe", "Devolucao", "Devolucao Detalhe", "IVA", "Encomendas", "tblMovStocksCab", "tblMovStocksDet",
] as const;

export const TABELA_STOCKS = { esquema: "dbo", tabela: "Stocks" } as const;
const COLUNAS_STOCKS_FIXAS = { cnp: "Codigo", id: "CodigoID", processa: "Processa_Stocks", retirado: "Retirado" } as const;

/** Predicados EXACTOS do agent (bootstrap-upload.ts: catálogo ativo; daily-sync-runner.ts: Processa_Stocks obrigatório). */
export const FILTRO_DAILY_SYNC = "s.[Processa_Stocks] <> 0";
export const FILTRO_BOOTSTRAP_ATIVO = "s.[Retirado] = 0 AND s.[Processa_Stocks] <> 0";

const likesNome = (campo: string, padroes: readonly string[]) =>
  padroes.map((p) => `${campo} COLLATE Latin1_General_CI_AI LIKE N'%${p}%'`).join("\n     OR ");

export function sqlVersao(): string {
  return [
    "SELECT @@VERSION AS versao, DB_NAME() AS baseDados",
    "  FROM [sys].[databases] d",
    " WHERE d.database_id = DB_ID()",
  ].join("\n");
}

/** Edição/nível/compatibilidade do SQL Server e da base (metadados). */
export function sqlAmbiente(): string {
  return [
    "SELECT CAST(SERVERPROPERTY('ProductVersion') AS NVARCHAR(50)) AS produtoVersao,",
    "       CAST(SERVERPROPERTY('ProductLevel') AS NVARCHAR(50)) AS nivel,",
    "       CAST(SERVERPROPERTY('Edition') AS NVARCHAR(100)) AS edicao,",
    "       d.compatibility_level AS compat, d.collation_name AS colacao",
    "  FROM [sys].[databases] d",
    " WHERE d.database_id = DB_ID()",
  ].join("\n");
}

/** O login pode escrever em dbo.Stocks? (facto sobre permissões; HAS_PERMS_BY_NAME é só leitura). */
export function sqlPermissoes(): string {
  return [
    "SELECT HAS_PERMS_BY_NAME(N'dbo.Stocks', N'OBJECT', N'INSERT') AS podeInserir,",
    "       HAS_PERMS_BY_NAME(N'dbo.Stocks', N'OBJECT', N'UPDATE') AS podeActualizar,",
    "       HAS_PERMS_BY_NAME(N'dbo.Stocks', N'OBJECT', N'DELETE') AS podeApagar",
    "  FROM [sys].[databases] d",
    " WHERE d.database_id = DB_ID()",
  ].join("\n");
}

export function sqlColunasCandidatas(): string {
  const strong = likesNome("c.name", PADROES_FORTES.filter((p) => p !== "processa"));
  return [
    "SELECT TOP (1500) sch.name AS esquema, t.name AS tabela, c.name AS coluna, ty.name AS tipo, c.max_length AS tamanho, c.is_nullable AS anulavel",
    "  FROM [sys].[columns] c",
    "  JOIN [sys].[tables] t ON t.object_id = c.object_id",
    "  JOIN [sys].[schemas] sch ON sch.schema_id = t.schema_id",
    "  JOIN [sys].[types] ty ON ty.user_type_id = c.user_type_id",
    ` WHERE t.is_ms_shipped = 0 AND (${likesNome("c.name", PADROES_COLUNA)})`,
    // dbo.Stocks e os nomes fortes primeiro: o TOP nunca os deixa de fora.
    ` ORDER BY CASE WHEN t.name = N'Stocks' THEN 0 WHEN (${strong}) THEN 1 ELSE 2 END, sch.name, t.name, c.column_id`,
  ].join("\n");
}

/** Colunas das tabelas cujo NOME casa com os padrões (estrutura; sem dados). */
export function sqlColunasDeTabelasPorNome(padroes: readonly string[], top = 4000): string {
  return [
    `SELECT TOP (${top}) sch.name AS esquema, t.name AS tabela, c.name AS coluna, ty.name AS tipo, c.max_length AS tamanho`,
    "  FROM [sys].[columns] c",
    "  JOIN [sys].[tables] t ON t.object_id = c.object_id",
    "  JOIN [sys].[schemas] sch ON sch.schema_id = t.schema_id",
    "  JOIN [sys].[types] ty ON ty.user_type_id = c.user_type_id",
    ` WHERE t.is_ms_shipped = 0 AND (${likesNome("t.name", padroes)})`,
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
    "SELECT TOP (200) pc.name AS coluna, OBJECT_SCHEMA_NAME(fk.referenced_object_id) AS esquemaRef, OBJECT_NAME(fk.referenced_object_id) AS tabelaRef, rc.name AS colunaRef",
    "  FROM [sys].[foreign_keys] fk",
    "  JOIN [sys].[foreign_key_columns] fkc ON fkc.constraint_object_id = fk.object_id",
    "  JOIN [sys].[columns] pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id",
    "  JOIN [sys].[columns] rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id",
    " WHERE fk.parent_object_id = OBJECT_ID('dbo.Stocks')",
  ].join("\n");
}

/** Colunas das tabelas referenciadas por FK a partir de dbo.Stocks (lookups declarados). */
export function sqlColunasDeLookups(): string {
  return [
    "SELECT TOP (1500) sch.name AS esquema, t.name AS tabela, c.name AS coluna, ty.name AS tipo, c.max_length AS tamanho",
    "  FROM [sys].[foreign_keys] fk",
    "  JOIN [sys].[tables] t ON t.object_id = fk.referenced_object_id",
    "  JOIN [sys].[schemas] sch ON sch.schema_id = t.schema_id",
    "  JOIN [sys].[columns] c ON c.object_id = t.object_id",
    "  JOIN [sys].[types] ty ON ty.user_type_id = c.user_type_id",
    " WHERE fk.parent_object_id = OBJECT_ID('dbo.Stocks')",
    " ORDER BY sch.name, t.name, c.column_id",
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

/**
 * Contagens do filtro do agent sobre dbo.Stocks. Reproduz EXACTAMENTE os predicados do agent
 * (`Processa_Stocks <> 0`; e `Retirado = 0 AND Processa_Stocks <> 0` do catálogo ativo do bootstrap).
 * `NULL <> 0` é desconhecido em SQL: um artigo com Processa_Stocks NULL fica EXCLUÍDO, e conta-se à parte.
 */
export function sqlProcessaStocks(comRetirado = false): string {
  const p = `x.${q(COLUNAS_STOCKS_FIXAS.processa)}`;
  const r = `x.${q(COLUNAS_STOCKS_FIXAS.retirado)}`;
  return [
    "SELECT COUNT(*) AS total,",
    `       SUM(CASE WHEN ${p} = 0 THEN 1 ELSE 0 END) AS zero,`,
    `       SUM(CASE WHEN ${p} <> 0 THEN 1 ELSE 0 END) AS diferenteDeZero,`,
    `       SUM(CASE WHEN ${p} IS NULL THEN 1 ELSE 0 END) AS nulos` + (comRetirado ? "," : ""),
    ...(comRetirado ? [`       SUM(CASE WHEN ${r} = 0 AND ${p} <> 0 THEN 1 ELSE 0 END) AS ativosBootstrap`] : []),
    `  FROM ${de(TABELA_STOCKS)}`,
  ].join("\n");
}

/** Para uma coluna candidata: quantos artigos «marcados» (não NULL, não vazio, não 0) ficam dentro/fora do filtro do agent. */
export function sqlMarcadosVsFiltro(coluna: string, familia: FamiliaTipo): string {
  const c = `x.${q(coluna)}`;
  const p = `x.${q(COLUNAS_STOCKS_FIXAS.processa)}`;
  const marcado = familia === "texto" ? `(${c} IS NOT NULL AND LTRIM(RTRIM(${c})) <> '' AND LTRIM(RTRIM(${c})) <> '0')` : `(${c} IS NOT NULL AND ${c} <> 0)`;
  return [
    `SELECT SUM(CASE WHEN ${marcado} THEN 1 ELSE 0 END) AS marcados,`,
    `       SUM(CASE WHEN ${marcado} AND ${p} <> 0 THEN 1 ELSE 0 END) AS marcadosIncluidos,`,
    `       SUM(CASE WHEN ${marcado} AND (${p} = 0 OR ${p} IS NULL) THEN 1 ELSE 0 END) AS marcadosExcluidos,`,
    `       SUM(CASE WHEN NOT ${marcado} THEN 1 ELSE 0 END) AS naoMarcados,`,
    `       SUM(CASE WHEN NOT ${marcado} AND (${p} = 0 OR ${p} IS NULL) THEN 1 ELSE 0 END) AS naoMarcadosExcluidos`,
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

/** Conteúdo de uma tabela PEQUENA (códigos/descrições de domínio; colunas já filtradas — nada pessoal/monetário). */
export function sqlConteudoPequeno(r: Ref, colunas: string[], n = 200): string {
  const itens = colunas.slice(0, 10).map((c, i) => `CAST(x.${q(c)} AS NVARCHAR(60)) AS c${i}`);
  return [
    `SELECT TOP (${Math.max(1, Math.min(300, Math.trunc(n)))}) ${itens.join(", ")}`,
    `  FROM ${de(r)}`,
    ` ORDER BY x.${q(colunas[0]!)}`,
  ].join("\n");
}

/** Códigos de uma FK de Stocks ↔ descrição na tabela referenciada, com nº de artigos (agregado). */
export function sqlContagemLookup(fkColuna: string, lookup: Ref, colunaRef: string, descricao: string): string {
  const a = `CAST(x.${q(fkColuna)} AS NVARCHAR(100))`;
  const b = `CAST(l.${q(descricao)} AS NVARCHAR(100))`;
  return [
    `SELECT TOP (300) ${a} AS a, ${b} AS b, COUNT(*) AS n`,
    `  FROM ${de(TABELA_STOCKS)}`,
    `  LEFT JOIN ${q(lookup.esquema)}.${q(lookup.tabela)} l WITH (NOLOCK) ON l.${q(colunaRef)} = x.${q(fkColuna)}`,
    ` GROUP BY ${a}, ${b}`,
    " ORDER BY COUNT(*) DESC",
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

export type TabelaEstrutura = { tabela: string; linhas: number | null; colunas: Array<{ coluna: string; tipo: string }>; colunasOmitidas: number; omitidaPorNome?: boolean };
export type ConteudoTabela = { tabela: string; linhas: number | null; colunas: string[]; amostra: Array<Record<string, string | null>> };
export type TabelaChave = { nome: string; presente: boolean; tabela: string | null; linhas: number | null };
export type LookupFk = {
  coluna: string;
  tabelaRef: string;
  colunaRef: string;
  linhasRef: number | null;
  colunasRef: Array<{ coluna: string; tipo: string }>;
  /** Códigos usados em Stocks.<coluna> ↔ descrição na tabela referenciada ↔ nº de artigos (agregado em SQL). */
  usoEmStocks: Array<{ codigo: string | null; descricao: string | null; n: number }>;
  nota?: string;
};

export type MarcadosVsFiltro = {
  coluna: string;
  marcados: number;
  marcadosIncluidos: number;
  marcadosExcluidos: number;
  naoMarcados: number;
  naoMarcadosExcluidos: number;
};

export type ServicosProcessaStocks = {
  disponivel: boolean;
  total: number;
  zero: number;
  diferenteDeZero: number;
  nulos: number;
  /** Artigos que o agent leva (daily-sync): Processa_Stocks <> 0. */
  incluidosPeloFiltro: number;
  /** Artigos que o agent NÃO leva: Processa_Stocks = 0 ou NULL. */
  excluidosPeloFiltro: number;
  /** Catálogo ativo do bootstrap (Retirado = 0 AND Processa_Stocks <> 0); null se Retirado não existe. */
  ativosBootstrap: number | null;
  predicados: { dailySync: string; bootstrapAtivo: string };
  /** Texto fixo: o que o agent faz hoje (facto de código, não da base). */
  filtroDoAgent: string;
  /** Por coluna candidata: artigos «marcados» (não NULL/vazio/0) dentro e fora do filtro. */
  marcadosVsFiltro: MarcadosVsFiltro[];
  /** Por coluna candidata: valores observados só com PS=0, só com PS<>0 e nos dois. */
  distinguemPorColuna: Array<{
    coluna: string;
    soExcluidos: ValorContado[];
    soIncluidos: ValorContado[];
    emAmbos: Array<{ valor: string | null; excluidos: number; incluidos: number }>;
  }>;
  exemplosZero: Array<Record<string, string | null>>;
  exemplosDiferenteDeZero: Array<Record<string, string | null>>;
};

export type HipoteseId = "campos-independentes" | "categoria-unica" | "tabela-relacionada" | "propriedade-derivada" | "inexistente";
export type EstadoHipotese = "suportada" | "contradita" | "sem-dados";
export type LeituraAssistida = {
  aviso: string;
  conceitos: Array<{
    conceito: "generico" | "etico" | "nett" | "servico";
    rotulo: string;
    /** Colunas cujo NOME casa com o conceito (pista por nome; não prova). */
    colunasPorNome: string[];
    hipoteses: Array<{ hipotese: HipoteseId; estado: EstadoHipotese; evidencia: string[] }>;
  }>;
  /** Sobreposições observadas entre colunas de conceitos diferentes (factos). */
  sobreposicoes: string[];
};

export type RelatorioAuditoria = {
  cabecalho: {
    geradoEmUtc: string;
    pacote: PacoteInfo;
    modo: string;
    sqlServer: string | null;
    baseDados: string | null;
    queriesExecutadas: number;
  };
  ambiente: {
    produtoVersao: string | null;
    nivel: string | null;
    edicao: string | null;
    compatibilidade: number | null;
    colacao: string | null;
    /** Permissões do login sobre dbo.Stocks (facto; deve ser tudo false/null com um login só de leitura). */
    permissoesStocks: { inserir: boolean | null; actualizar: boolean | null; apagar: boolean | null } | null;
  };
  versaoSpharm: { tabelas: TabelaEstrutura[]; conteudo: ConteudoTabela[] };
  tabelasChave: TabelaChave[];
  tabelasCandidatas: TabelaEstrutura[];
  conteudoTabelasDominio: ConteudoTabela[];
  lookups: LookupFk[];
  colunasCandidatas: ColunaCandidata[];
  fksDeStocks: Array<{ coluna: string; tabelaRef: string; colunaRef: string }>;
  perfis: PerfilColuna[];
  amostras: AmostraValor[];
  generico: {
    encontrado: boolean;
    coluna: string | null;
    tipo: string | null;
    perfil: PerfilColuna | null;
    amostras: AmostraValor[];
    cruzadas: TabulacaoCruzada[];
  };
  cruzadas: TabulacaoCruzada[];
  servicos: ServicosProcessaStocks;
  conhecidos: ClassificacaoDeCnp[];
  leituraAssistida: LeituraAssistida;
  /** Texto de TODAS as queries executadas (valores mascarados), para auditoria humana. */
  queries: string[];
  avisos: string[];
};

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const bool3 = (v: unknown): boolean | null => (v === null || v === undefined ? null : Number(v) === 1);
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
    if (pareceDadoSensivel(b.coluna) || pareceDadoSensivel(b.tabela)) {
      return { ...base, inspeccao: "omitida-dado-pessoal", nota: "nome da coluna/tabela sugere dado pessoal ou monetário: não lida" };
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
  if (c.casou.includes("fk")) p += 200;
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

export type ConceitoClassificacao = "generico" | "etico" | "nett" | "servico";
const ROTULOS: Record<ConceitoClassificacao, string> = { generico: "Genérico", etico: "Ético", nett: "NETT", servico: "Serviço" };
const FRAGMENTO_CONCEITO: Record<ConceitoClassificacao, string> = { generico: "generic", etico: "etico", nett: "nett", servico: "servic" };
const CONCEITOS = Object.keys(ROTULOS) as ConceitoClassificacao[];

/** Pista por NOME (não prova nada): a que conceito o nome se refere, se algum. */
export function conceitoDoNome(nome: string): ConceitoClassificacao | null {
  const n = semAcentos(nome);
  return CONCEITOS.find((c) => n.includes(FRAGMENTO_CONCEITO[c])) ?? null;
}

function agruparEstrutura(
  linhas: Linha[],
  linhasPorTabela: Map<string, number>,
  maxColunasPorTabela = 40,
): TabelaEstrutura[] {
  const por = new Map<string, TabelaEstrutura>();
  for (const r of linhas) {
    const nome = `${String(r.esquema)}.${String(r.tabela)}`;
    let t = por.get(nome);
    if (!t) {
      t = { tabela: nome, linhas: linhasPorTabela.get(nome.toLowerCase()) ?? null, colunas: [], colunasOmitidas: 0 };
      if (pareceDadoSensivel(String(r.tabela))) t.omitidaPorNome = true;
      por.set(nome, t);
    }
    if (t.omitidaPorNome) { t.colunasOmitidas++; continue; }
    if (pareceDadoSensivel(String(r.coluna))) { t.colunasOmitidas++; continue; }
    if (t.colunas.length >= maxColunasPorTabela) { t.colunasOmitidas++; continue; }
    t.colunas.push({ coluna: String(r.coluna), tipo: String(r.tipo) });
  }
  return [...por.values()];
}

/** Colunas legíveis de uma tabela de domínio (nada pessoal/monetário/longo/binário), por ordem. */
function colunasLegiveis(t: TabelaEstrutura, brutas: Linha[]): string[] {
  const dela = brutas.filter((r) => `${String(r.esquema)}.${String(r.tabela)}` === t.tabela);
  return dela
    .filter((r) => !pareceDadoSensivel(String(r.coluna)) && familiaDoTipo(String(r.tipo)) !== "outro")
    .filter((r) => !(familiaDoTipo(String(r.tipo)) === "texto" && (num(r.tamanho) === -1 || num(r.tamanho) > 200)))
    .map((r) => String(r.coluna))
    .slice(0, 10);
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
  const amb = (await tentar(avisos, "ambiente", () => lerContado(sqlAmbiente())))?.[0];
  const perm = (await tentar(avisos, "permissões", () => lerContado(sqlPermissoes())))?.[0];
  const ambiente: RelatorioAuditoria["ambiente"] = {
    produtoVersao: amb?.produtoVersao ? String(amb.produtoVersao) : null,
    nivel: amb?.nivel ? String(amb.nivel) : null,
    edicao: amb?.edicao ? String(amb.edicao) : null,
    compatibilidade: amb?.compat === undefined || amb?.compat === null ? null : num(amb.compat),
    colacao: amb?.colacao ? String(amb.colacao) : null,
    permissoesStocks: perm
      ? { inserir: bool3(perm.podeInserir), actualizar: bool3(perm.podeActualizar), apagar: bool3(perm.podeApagar) }
      : null,
  };
  if (ambiente.permissoesStocks && Object.values(ambiente.permissoesStocks).some((x) => x === true)) {
    avisos.push("ATENÇÃO: o login de ligação tem permissões de escrita em dbo.Stocks. A auditoria só executa SELECT (validado), mas recomenda-se um login só de leitura.");
  }

  // ── tabelas: nº de linhas, tabelas-chave ─────────────────
  const linhasRows = (await tentar(avisos, "linhas por tabela", () => lerContado(sqlLinhasPorTabela()))) ?? [];
  const linhasPorTabela = new Map<string, number>(
    linhasRows.map((r) => [`${String(r.esquema)}.${String(r.tabela)}`.toLowerCase(), num(r.linhas)]),
  );
  const tabelasChave: TabelaChave[] = TABELAS_CHAVE.map((nome) => {
    const hit = linhasRows.find((r) => String(r.tabela).toLowerCase() === nome.toLowerCase());
    return { nome, presente: !!hit, tabela: hit ? `${String(hit.esquema)}.${String(hit.tabela)}` : null, linhas: hit ? num(hit.linhas) : null };
  });

  // ── Stocks: colunas existentes e FKs ─────────────────────
  const colsStocks = ((await tentar(avisos, "colunas de Stocks", () => lerContado(sqlColunasStocks()))) ?? []).map((r) => ({
    coluna: String(r.coluna),
    tipo: String(r.tipo),
    tamanho: r.tamanho === null || r.tamanho === undefined ? null : num(r.tamanho),
  }));
  const existeStocks = (n: string) => colsStocks.some((c) => c.coluna.toLowerCase() === n.toLowerCase());
  const temCnp = existeStocks(COLUNAS_STOCKS_FIXAS.cnp) && existeStocks(COLUNAS_STOCKS_FIXAS.id);
  const temProcessa = existeStocks(COLUNAS_STOCKS_FIXAS.processa);
  const temRetirado = existeStocks(COLUNAS_STOCKS_FIXAS.retirado);
  const fksBrutas = ((await tentar(avisos, "FKs de Stocks", () => lerContado(sqlFksDeStocks()))) ?? []).map((r) => ({
    coluna: String(r.coluna),
    esquemaRef: r.esquemaRef ? String(r.esquemaRef) : "dbo",
    tabelaRef: String(r.tabelaRef),
    colunaRef: String(r.colunaRef),
  }));
  const fksSeguras = fksBrutas.filter((f) => !pareceDadoSensivel(f.coluna) && !pareceDadoSensivel(f.tabelaRef));
  const fks = fksSeguras.map((f) => ({ coluna: f.coluna, tabelaRef: f.tabelaRef, colunaRef: f.colunaRef }));

  // ── colunas candidatas (nome) + colunas FK de Stocks ─────
  const brutas = ((await tentar(avisos, "colunas candidatas", () => lerContado(sqlColunasCandidatas()))) ?? []).map((r) => ({
    esquema: String(r.esquema),
    tabela: String(r.tabela),
    coluna: String(r.coluna),
    tipo: String(r.tipo),
    tamanho: r.tamanho === null || r.tamanho === undefined ? null : num(r.tamanho),
    anulavel: Boolean(r.anulavel),
  }));
  if (brutas.length >= 1500) avisos.push("lista de colunas candidatas truncada a 1500");
  // As colunas de Stocks que são FK (possível código de uma tabela de domínio) entram sempre.
  for (const f of fksSeguras) {
    if (brutas.some((b) => b.esquema.toLowerCase() === "dbo" && b.tabela.toLowerCase() === "stocks" && b.coluna.toLowerCase() === f.coluna.toLowerCase())) continue;
    const cs = colsStocks.find((c) => c.coluna.toLowerCase() === f.coluna.toLowerCase());
    if (cs) brutas.push({ esquema: "dbo", tabela: "Stocks", coluna: cs.coluna, tipo: cs.tipo, tamanho: cs.tamanho, anulavel: true });
  }
  const candidatas = classificarCandidatas(brutas, linhasPorTabela, o.maxColunas);
  const fkCols = new Set(fksSeguras.map((f) => f.coluna.toLowerCase()));
  for (const c of candidatas) {
    if (c.tabela.toLowerCase() === "stocks" && c.esquema.toLowerCase() === "dbo" && fkCols.has(c.coluna.toLowerCase()) && !c.casou.includes("fk")) c.casou = [...c.casou, "fk"];
  }

  // ── tabelas candidatas por NOME (estrutura) + conteúdo de domínio pequeno ──
  const rowsTabCand = (await tentar(avisos, "tabelas candidatas", () => lerContado(sqlColunasDeTabelasPorNome(PADROES_TABELA)))) ?? [];
  const tabelasCandidatas = agruparEstrutura(rowsTabCand, linhasPorTabela).slice(0, 150);
  if (agruparEstrutura(rowsTabCand, linhasPorTabela).length > 150) avisos.push("lista de tabelas candidatas truncada a 150");

  const conteudoTabelasDominio: ConteudoTabela[] = [];
  const lerConteudo = async (t: TabelaEstrutura, brutasT: Linha[], rotulo: string): Promise<ConteudoTabela | null> => {
    const cols = colunasLegiveis(t, brutasT);
    if (cols.length === 0 || t.omitidaPorNome) return null;
    const [esq, ...resto] = t.tabela.split(".");
    const tab = resto.join(".");
    const rows = await tentar(avisos, `${rotulo} ${t.tabela}`, () => lerContado(sqlConteudoPequeno({ esquema: esq!, tabela: tab }, cols)));
    if (!rows) return null;
    return {
      tabela: t.tabela,
      linhas: t.linhas,
      colunas: cols,
      amostra: rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, valorSeguro(r[`c${i}`])]))),
    };
  };
  {
    const dominio = tabelasCandidatas
      .filter((t) => !t.omitidaPorNome && t.linhas !== null && t.linhas <= 200 && PADROES_TABELA_DOMINIO.some((p) => semAcentos(t.tabela).includes(p)))
      .slice(0, o.maxTabelasConteudo);
    for (const t of dominio) {
      if (!dentroDoOrcamento()) { avisos.push("orçamento de tempo esgotado antes de ler as tabelas de domínio"); break; }
      const c = await lerConteudo(t, rowsTabCand, "conteúdo");
      if (c) conteudoTabelasDominio.push(c);
    }
  }

  // ── versão / estrutura do SPharm ─────────────────────────
  const rowsVersao = (await tentar(avisos, "tabelas de versão", () => lerContado(sqlColunasDeTabelasPorNome(PADROES_TABELA_VERSAO, 1500)))) ?? [];
  const tabelasVersao = agruparEstrutura(rowsVersao, linhasPorTabela, 30);
  const conteudoVersao: ConteudoTabela[] = [];
  for (const t of tabelasVersao) {
    const nome = semAcentos(t.tabela);
    if (!PADROES_VERSAO_CONTEUDO.some((p) => nome.includes(p)) || t.linhas === null || t.linhas > 20) continue;
    if (!dentroDoOrcamento()) break;
    const c = await lerConteudo(t, rowsVersao, "versão");
    if (c) conteudoVersao.push(c);
  }

  // ── lookups declarados por FK ────────────────────────────
  const lookups: LookupFk[] = [];
  const rowsLookupCols = fksSeguras.length > 0 ? ((await tentar(avisos, "colunas dos lookups", () => lerContado(sqlColunasDeLookups()))) ?? []) : [];
  {
    let lidos = 0;
    for (const f of fksSeguras) {
      const nomeRef = `${f.esquemaRef}.${f.tabelaRef}`;
      const colsRef = rowsLookupCols.filter((r) => `${String(r.esquema)}.${String(r.tabela)}`.toLowerCase() === nomeRef.toLowerCase());
      const linhasRef = linhasPorTabela.get(nomeRef.toLowerCase()) ?? null;
      const lk: LookupFk = {
        coluna: f.coluna,
        tabelaRef: nomeRef,
        colunaRef: f.colunaRef,
        linhasRef,
        colunasRef: colsRef.filter((r) => !pareceDadoSensivel(String(r.coluna))).map((r) => ({ coluna: String(r.coluna), tipo: String(r.tipo) })).slice(0, 30),
        usoEmStocks: [],
      };
      const desc = colsRef.find(
        (r) =>
          String(r.coluna).toLowerCase() !== f.colunaRef.toLowerCase() &&
          !pareceDadoSensivel(String(r.coluna)) &&
          familiaDoTipo(String(r.tipo)) === "texto" &&
          num(r.tamanho) > 0 && num(r.tamanho) <= 200,
      );
      if (linhasRef !== null && linhasRef <= 300 && desc && lidos < 12 && dentroDoOrcamento()) {
        lidos++;
        const rows = await tentar(avisos, `lookup ${f.coluna}`, () =>
          lerContado(sqlContagemLookup(f.coluna, { esquema: f.esquemaRef, tabela: f.tabelaRef }, f.colunaRef, String(desc.coluna))),
        );
        if (rows) lk.usoEmStocks = rows.map((r) => ({ codigo: valorSeguro(r.a), descricao: valorSeguro(r.b), n: num(r.n) }));
      } else {
        lk.nota = !desc ? "sem coluna de descrição legível" : linhasRef === null || linhasRef > 300 ? "tabela referenciada grande ou de tamanho desconhecido: conteúdo não lido" : "limite de lookups lidos";
      }
      lookups.push(lk);
    }
  }

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

  // ── cruzadas (SQL agregado), com prioridade ──────────────
  const cruzadas: TabulacaoCruzada[] = [];
  const cands = perfisStocks.filter((p) => baixaCardinalidade(p, 30));
  const ordemPrio = (c: string) => (conceitoDoNome(c) ? 0 : 1);
  const colunasCand = cands.map((p) => p.coluna).sort((a, b) => ordemPrio(a) - ordemPrio(b));
  const ehFixa = (c: string, f: string) => c.toLowerCase() === f.toLowerCase();
  const fixas = [COLUNAS_STOCKS_FIXAS.processa, COLUNAS_STOCKS_FIXAS.retirado].filter((f) => existeStocks(f));
  const candidatasSemFixas = colunasCand.filter((c) => !fixas.some((f) => ehFixa(c, f)));
  const pares: Array<[string, string]> = [];
  const vistoPar = new Set<string>();
  const addPar = (a: string, b: string) => {
    if (a.toLowerCase() === b.toLowerCase()) return;
    const k = [a.toLowerCase(), b.toLowerCase()].sort().join("|");
    if (vistoPar.has(k)) return;
    vistoPar.add(k);
    pares.push([a, b]);
  };
  // 1) cada candidata × Processa_Stocks / Retirado (conceitos primeiro)
  for (const f of fixas) for (const c of candidatasSemFixas) addPar(c, f);
  // 2) Processa_Stocks × Retirado
  if (fixas.length === 2) addPar(fixas[0]!, fixas[1]!);
  // 3) candidata × candidata
  for (let i = 0; i < candidatasSemFixas.length; i++) for (let j = i + 1; j < candidatasSemFixas.length; j++) addPar(candidatasSemFixas[i]!, candidatasSemFixas[j]!);
  // Garantia: o Genérico é sempre cruzado com Processa_Stocks e Retirado, mesmo acima do limite.
  const colGen = perfisStocks.find((p) => semAcentos(p.coluna) === "generico")?.coluna ?? null;
  const obrigatorios = new Set<string>();
  if (colGen) for (const f of fixas) obrigatorios.add([colGen.toLowerCase(), f.toLowerCase()].sort().join("|"));
  const chave = (p: [string, string]) => [p[0].toLowerCase(), p[1].toLowerCase()].sort().join("|");
  const ordenados = [...pares.filter((p) => obrigatorios.has(chave(p))), ...pares.filter((p) => !obrigatorios.has(chave(p)))];
  if (ordenados.length > o.maxPares) avisos.push(`pares de colunas limitados a ${o.maxPares} (de ${ordenados.length})`);
  for (const [a, b] of ordenados.slice(0, o.maxPares)) {
    if (!dentroDoOrcamento()) {
      avisos.push("orçamento de tempo esgotado antes de terminar as tabulações cruzadas");
      break;
    }
    const rows = await tentar(avisos, `cruzada ${a} x ${b}`, () => lerContado(sqlCruzada(TABELA_STOCKS, a, b)));
    if (rows) {
      cruzadas.push(resumirCruzada(a, b, rows as Array<{ a: unknown; b: unknown; n: unknown }>));
    }
  }

  // ── Genérico ─────────────────────────────────────────────
  const perfilGen = perfisStocks.find((p) => semAcentos(p.coluna) === "generico") ?? null;
  const generico = {
    encontrado: perfilGen !== null,
    coluna: perfilGen?.coluna ?? null,
    tipo: perfilGen?.tipo ?? colsStocks.find((c) => semAcentos(c.coluna) === "generico")?.tipo ?? null,
    perfil: perfilGen,
    amostras: perfilGen ? amostras.filter((a) => a.coluna === perfilGen.coluna) : [],
    cruzadas: perfilGen ? cruzadas.filter((t) => [t.colunaA, t.colunaB].some((c) => c === perfilGen.coluna)) : [],
  };

  // ── Serviços / Processa_Stocks ───────────────────────────
  const servicos: ServicosProcessaStocks = {
    disponivel: temProcessa,
    total: 0,
    zero: 0,
    diferenteDeZero: 0,
    nulos: 0,
    incluidosPeloFiltro: 0,
    excluidosPeloFiltro: 0,
    ativosBootstrap: null,
    predicados: { dailySync: FILTRO_DAILY_SYNC, bootstrapAtivo: FILTRO_BOOTSTRAP_ATIVO },
    filtroDoAgent:
      "O agent só leva produtos com Stocks.[Processa_Stocks] <> 0 (daily-sync-runner.ts: obrigatório; bootstrap-upload.ts: catálogo ativo = " +
      "[Retirado] = 0 AND [Processa_Stocks] <> 0). Em SQL, NULL <> 0 é desconhecido, por isso Processa_Stocks NULL fica também de fora. " +
      "As contagens abaixo mostram quantos artigos ficam de fora desse filtro; NÃO provam que Processa_Stocks = 0 equivale a serviço.",
    marcadosVsFiltro: [],
    distinguemPorColuna: [],
    exemplosZero: [],
    exemplosDiferenteDeZero: [],
  };
  if (temProcessa) {
    const r = await tentar(avisos, "Processa_Stocks", () => lerContado(sqlProcessaStocks(temRetirado)));
    if (r && r[0]) {
      servicos.total = num(r[0].total);
      servicos.zero = num(r[0].zero);
      servicos.diferenteDeZero = num(r[0].diferenteDeZero);
      servicos.nulos = num(r[0].nulos);
      servicos.incluidosPeloFiltro = servicos.diferenteDeZero;
      servicos.excluidosPeloFiltro = Math.max(0, servicos.total - servicos.diferenteDeZero);
      servicos.ativosBootstrap = temRetirado && r[0].ativosBootstrap !== undefined && r[0].ativosBootstrap !== null ? num(r[0].ativosBootstrap) : null;
    }
    // «marcados» (não NULL/vazio/0) das colunas candidatas dentro/fora do filtro — conceitos conhecidos por nome primeiro
    const paraMarcar = perfisStocks
      .filter((p) => !ehFixa(p.coluna, COLUNAS_STOCKS_FIXAS.processa) && !ehFixa(p.coluna, COLUNAS_STOCKS_FIXAS.retirado) && baixaCardinalidade(p, 30))
      .sort((a, b) => ordemPrio(a.coluna) - ordemPrio(b.coluna))
      .slice(0, 12);
    for (const p of paraMarcar) {
      if (!dentroDoOrcamento()) break;
      const m = await tentar(avisos, `marcados ${p.coluna}`, () => lerContado(sqlMarcadosVsFiltro(p.coluna, familiaDoTipo(p.tipo))));
      if (m && m[0]) {
        servicos.marcadosVsFiltro.push({
          coluna: p.coluna,
          marcados: num(m[0].marcados),
          marcadosIncluidos: num(m[0].marcadosIncluidos),
          marcadosExcluidos: num(m[0].marcadosExcluidos),
          naoMarcados: num(m[0].naoMarcados),
          naoMarcadosExcluidos: num(m[0].naoMarcadosExcluidos),
        });
      }
    }
    // colunas que "distinguem": valores observados só de um dos lados do filtro (NULL de Processa_Stocks = excluído)
    for (const t of cruzadas) {
      const proc = COLUNAS_STOCKS_FIXAS.processa.toLowerCase();
      const outra = t.colunaA.toLowerCase() === proc ? t.colunaB : t.colunaB.toLowerCase() === proc ? t.colunaA : null;
      if (!outra) continue;
      const procEhA = t.colunaA.toLowerCase() === proc;
      const porValor = new Map<string | null, { exc: number; inc: number }>();
      for (const c of t.celulas) {
        const val = procEhA ? c.b : c.a;
        const ps = procEhA ? c.a : c.b;
        const e = porValor.get(val) ?? { exc: 0, inc: 0 };
        const excluido = ps === null || /^-?0+(\.0*)?$/.test(ps) || ps.toLowerCase() === "false";
        if (excluido) e.exc += c.n;
        else e.inc += c.n;
        porValor.set(val, e);
      }
      servicos.distinguemPorColuna.push({
        coluna: outra,
        soExcluidos: [...porValor].filter(([, e]) => e.exc > 0 && e.inc === 0).map(([valor, e]) => ({ valor, n: e.exc })),
        soIncluidos: [...porValor].filter(([, e]) => e.inc > 0 && e.exc === 0).map(([valor, e]) => ({ valor, n: e.inc })),
        emAmbos: [...porValor].filter(([, e]) => e.inc > 0 && e.exc > 0).map(([valor, e]) => ({ valor, excluidos: e.exc, incluidos: e.inc })),
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
      pacote: o.pacote,
      modo: FRASE_READ_ONLY,
      sqlServer,
      baseDados,
      queriesExecutadas: queries,
    },
    ambiente,
    versaoSpharm: { tabelas: tabelasVersao, conteudo: conteudoVersao },
    tabelasChave,
    tabelasCandidatas,
    conteudoTabelasDominio,
    lookups,
    colunasCandidatas: candidatas,
    fksDeStocks: fks,
    perfis,
    amostras,
    generico,
    cruzadas,
    servicos,
    conhecidos,
    leituraAssistida: { aviso: "", conceitos: [], sobreposicoes: [] },
    queries: [],
    avisos,
  };
  rel.leituraAssistida = construirLeituraAssistida(rel);
  rel.queries = (o.queriesExecutadasTexto?.() ?? []).map(mascararQuery);
  return sanitizarRelatorio(rel, o.segredos);
}

// ─────────────────────────────────────────────────────────────────────
// 4b. Leitura assistida: hipóteses ligadas aos números (NUNCA uma conclusão)
// ─────────────────────────────────────────────────────────────────────

const AVISO_LEITURA =
  "HIPÓTESES a confirmar por uma pessoa que conheça o ERP. «suportada» / «contradita» refere-se apenas ao que os números deste relatório " +
  "mostram; a ausência de uma coluna por NOME não prova que o conceito não exista (pode ter outro nome). Nenhuma delas fixa o modelo.";

const ehBinaria = (p: PerfilColuna) =>
  p.listaCompleta && p.valores.length > 0 && p.valores.every((x) => x.valor === null || SO_ZERO_UM.has(x.valor.toLowerCase()));

/** Pura: lê o relatório e devolve, por conceito, as cinco hipóteses de modelo com a evidência numérica. */
export function construirLeituraAssistida(r: RelatorioAuditoria): LeituraAssistida {
  const sobreposicoes: string[] = [];
  const conceitos: LeituraAssistida["conceitos"] = [];
  const perfisPorConceito = (c: ConceitoClassificacao) => r.perfis.filter((p) => conceitoDoNome(p.coluna) === c);
  const frag = (c: ConceitoClassificacao) => FRAGMENTO_CONCEITO[c];

  // sobreposições entre conceitos diferentes (factos das cruzadas)
  for (const t of r.cruzadas) {
    const ca = conceitoDoNome(t.colunaA);
    const cb = conceitoDoNome(t.colunaB);
    if (ca && cb && ca !== cb) {
      sobreposicoes.push(
        t.ambasUm !== null
          ? `${t.colunaA} × ${t.colunaB}: ${t.ambasUm} linhas com ambas = 1 (${t.combinacoes} combinações).`
          : `${t.colunaA} × ${t.colunaB}: ${t.combinacoes} combinações observadas (ver tabulação cruzada).`,
      );
    }
  }

  for (const conceito of CONCEITOS) {
    const perfis = perfisPorConceito(conceito);
    const colunasPorNome = [
      ...new Set([...perfis.map((p) => `${p.tabela}.${p.coluna}`), ...r.colunasCandidatas.filter((c) => conceitoDoNome(c.coluna) === conceito && !perfis.some((p) => p.coluna === c.coluna && p.tabela === `${c.esquema}.${c.tabela}`)).map((c) => `${c.esquema}.${c.tabela}.${c.coluna}`)]),
    ];
    const tabelasPorNome = r.tabelasCandidatas.filter((t) => semAcentos(t.tabela).includes(frag(conceito))).map((t) => t.tabela);
    const hipoteses: LeituraAssistida["conceitos"][number]["hipoteses"] = [];

    // campos independentes
    {
      const binarias = perfis.filter(ehBinaria);
      const ev: string[] = [];
      let estado: EstadoHipotese = "sem-dados";
      if (binarias.length > 0) {
        estado = "suportada";
        for (const p of binarias) ev.push(`${p.coluna} só tem valores 0/1/NULL (NULL=${p.categorias.nulo}, 0=${p.categorias.zero}, 1=${p.categorias.um}).`);
      } else if (perfis.length > 0) {
        estado = "contradita";
        for (const p of perfis) ev.push(`${p.coluna} tem ${p.distintos} valores distintos, não só 0/1 (ex.: ${p.valores.slice(0, 5).map((x) => x.valor ?? "NULL").join(", ")}).`);
      } else ev.push("nenhuma coluna com este nome foi inspeccionada.");
      hipoteses.push({ hipotese: "campos-independentes", estado, evidencia: ev });
    }

    // categoria única
    {
      const multi = perfis.filter((p) => !ehBinaria(p) && p.distintos > 2 && p.listaCompleta && p.distintos <= 30);
      const outrasCategorias = r.perfis.filter(
        (p) => conceitoDoNome(p.coluna) === null && /tipo|natur|categ|famil|class/.test(semAcentos(p.coluna)) && p.listaCompleta && p.distintos >= 2 && p.distintos <= 30,
      );
      const ev: string[] = [];
      let estado: EstadoHipotese = "sem-dados";
      if (multi.length > 0) {
        estado = "suportada";
        for (const p of multi) ev.push(`${p.coluna} tem ${p.distintos} valores distintos (${p.valores.slice(0, 8).map((x) => `${x.valor ?? "NULL"}×${x.n}`).join(", ")}).`);
      } else if (perfis.length > 0 && perfis.every(ehBinaria)) {
        estado = "contradita";
        ev.push("as colunas com este nome são todas 0/1/NULL (não são códigos de várias categorias).");
      }
      if (outrasCategorias.length > 0) {
        ev.push(`colunas de categoria candidatas (a interpretar por humano): ${outrasCategorias.map((p) => `${p.coluna} [${p.distintos} valores]`).join("; ")}.`);
      }
      if (ev.length === 0) ev.push("sem colunas de categoria candidatas inspeccionadas.");
      hipoteses.push({ hipotese: "categoria-unica", estado, evidencia: ev });
    }

    // tabela relacionada
    {
      const ev: string[] = [];
      let estado: EstadoHipotese = "sem-dados";
      const dominioComTexto = [...r.conteudoTabelasDominio, ...r.lookups.map((l) => ({ tabela: l.tabelaRef, amostra: l.usoEmStocks.map((u) => ({ d: u.descricao })) }))];
      const tocaConceito = (txt: string) => semAcentos(txt).includes(frag(conceito));
      if (tabelasPorNome.length > 0) {
        estado = "suportada";
        ev.push(`tabelas com o nome do conceito: ${tabelasPorNome.join(", ")}.`);
      }
      for (const d of dominioComTexto) {
        const hit = d.amostra.some((row) => Object.values(row).some((x) => typeof x === "string" && tocaConceito(x)));
        if (hit) { estado = "suportada"; ev.push(`a tabela ${d.tabela} contém descrições com «${frag(conceito)}…».`); }
      }
      if (estado === "sem-dados") {
        ev.push(r.lookups.length > 0
          ? `Stocks tem ${r.lookups.length} FK(s) para tabelas de domínio (${r.lookups.map((l) => `${l.coluna}->${l.tabelaRef}`).slice(0, 8).join("; ")}), mas nenhuma descrição lida refere o conceito.`
          : "Stocks não tem FKs declaradas para tabelas de domínio (um lookup pode existir sem FK declarada).");
      }
      hipoteses.push({ hipotese: "tabela-relacionada", estado, evidencia: ev });
    }

    // propriedade derivada
    {
      const ev: string[] = [];
      let estado: EstadoHipotese = "sem-dados";
      // colunas «marcadas» (não NULL/vazio/0): comparar com o filtro Processa_Stocks
      for (const m of r.servicos.marcadosVsFiltro.filter((x) => conceitoDoNome(x.coluna) === conceito)) {
        if (m.marcados === 0) ev.push(`${m.coluna}: nenhum artigo marcado (todos NULL/vazio/0).`);
        else if (m.marcadosIncluidos === 0 && m.naoMarcadosExcluidos === 0) {
          estado = "suportada";
          ev.push(`${m.coluna}: os ${m.marcados} artigos marcados são EXACTAMENTE os excluídos pelo filtro (Processa_Stocks = 0 ou NULL) — coincide com Processa_Stocks.`);
        } else if (m.marcadosIncluidos === 0) {
          if (estado !== "suportada") estado = "sem-dados";
          ev.push(`${m.coluna}: todos os ${m.marcados} artigos marcados estão fora do filtro, mas ${m.naoMarcadosExcluidos} artigos fora do filtro não estão marcados — não coincide por inteiro.`);
        } else {
          if (estado !== "suportada") estado = "contradita";
          ev.push(`${m.coluna}: ${m.marcadosIncluidos} artigos marcados estão DENTRO do filtro (Processa_Stocks <> 0) — não é função de Processa_Stocks.`);
        }
      }
      // colunas com vários valores: cada valor só de um lado do filtro?
      for (const d of r.servicos.distinguemPorColuna.filter((x) => conceitoDoNome(x.coluna) === conceito)) {
        const perfil = perfis.find((p) => p.coluna === d.coluna);
        if (perfil && ehBinaria(perfil)) continue; // já tratada acima
        const separa = d.emAmbos.length === 0 && d.soExcluidos.length > 0 && d.soIncluidos.length > 0;
        if (separa) {
          estado = "suportada";
          ev.push(`${d.coluna}: cada valor aparece só de um lado do filtro (excluídos: ${d.soExcluidos.map((v) => v.valor ?? "NULL").join(", ")}; incluídos: ${d.soIncluidos.map((v) => v.valor ?? "NULL").join(", ")}) — coincide com Processa_Stocks.`);
        } else if (d.emAmbos.length > 0) {
          if (estado !== "suportada") estado = "contradita";
          ev.push(`${d.coluna}: valores presentes dos dois lados do filtro (${d.emAmbos.slice(0, 5).map((v) => `${v.valor ?? "NULL"} (excluídos ${v.excluidos}/incluídos ${v.incluidos})`).join("; ")}) — não é função de Processa_Stocks.`);
        }
      }
      if (conceito === "servico" && perfis.length === 0 && r.servicos.disponivel && r.servicos.excluidosPeloFiltro > 0) {
        ev.push(`não há coluna Serviço por nome, mas ${r.servicos.excluidosPeloFiltro} artigos têm Processa_Stocks = 0/NULL: poderá ser derivado de Processa_Stocks (a confirmar por humano).`);
      }
      if (ev.length === 0) ev.push("sem números que relacionem este conceito com outra coluna.");
      hipoteses.push({ hipotese: "propriedade-derivada", estado, evidencia: ev });
    }

    // inexistente
    {
      const existe = colunasPorNome.length > 0 || tabelasPorNome.length > 0;
      hipoteses.push({
        hipotese: "inexistente",
        estado: existe ? "contradita" : "suportada",
        evidencia: existe
          ? [`encontrados por nome: ${[...colunasPorNome, ...tabelasPorNome].slice(0, 8).join(", ")}.`]
          : [`nenhuma coluna ou tabela com «${frag(conceito)}» no nome (o conceito pode existir com outro nome: confirmar com a lista de colunas candidatas e tabelas candidatas).`],
      });
    }

    conceitos.push({ conceito, rotulo: ROTULOS[conceito], colunasPorNome, hipoteses });
  }
  return { aviso: AVISO_LEITURA, conceitos, sobreposicoes };
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
const tipoComTamanho = (tipo: string, tam: number | null) => `${tipo}${tam && tam > 0 ? `(${tam})` : ""}`;

export function renderMarkdown(r: RelatorioAuditoria): string {
  const L: string[] = [];
  const h = r.cabecalho;
  const p = h.pacote;
  L.push("# classification-audit — relatório de DIAGNÓSTICO", "");
  L.push(
    `> **${FRASE_PACOTE}**`,
    "",
    `- Gerado em (UTC): **${h.geradoEmUtc}**`,
    `- Pacote: **${p.id}** · versão **${p.versao}** · base **rev${p.baseRev}**${p.commit ? ` · commit ${p.commit}` : ""} · diagnóstico: sim · instalável: não`,
    `- Modo: **${h.modo}**`,
    `- SQL Server: ${h.sqlServer ?? "(não obtido)"}`,
    `- Base de dados: ${h.baseDados ?? "(não obtida)"}`,
    `- Queries executadas (todas SELECT): ${h.queriesExecutadas} — texto completo no fim do relatório`,
    "",
    "> Relatório de FACTOS. Não conclui significados nem propõe mapeamento: serve para fixar o modelo com quem conhece o ERP. Nenhuma credencial, anfitrião, cliente, venda, receita ou preço é lido ou gravado.",
    "",
  );

  const a = r.ambiente;
  L.push("## 0. Ambiente e estrutura do SPharm", "");
  L.push(
    `- SQL Server: versão ${a.produtoVersao ?? "?"} · nível ${a.nivel ?? "?"} · edição ${a.edicao ?? "?"} · compatibilidade ${a.compatibilidade ?? "?"} · colação ${a.colacao ?? "?"}`,
  );
  if (a.permissoesStocks) {
    const f = (x: boolean | null) => (x === null ? "?" : x ? "SIM" : "não");
    L.push(`- Permissões do login em dbo.Stocks: INSERT ${f(a.permissoesStocks.inserir)} · UPDATE ${f(a.permissoesStocks.actualizar)} · DELETE ${f(a.permissoesStocks.apagar)} (a auditoria só executa SELECT)`);
  }
  L.push("", "Tabelas-chave (só número de linhas):", "", "| tabela | presente | linhas |", "|---|---|---|");
  for (const t of r.tabelasChave) L.push(`| ${t.nome} | ${t.presente ? "sim" : "NÃO"} | ${t.linhas ?? ""} |`);
  L.push("", "Tabelas de versão/parâmetros do SPharm (por nome):", "");
  if (r.versaoSpharm.tabelas.length === 0) L.push("(nenhuma tabela com nome de versão/parâmetros encontrada)", "");
  for (const t of r.versaoSpharm.tabelas) {
    L.push(`- ${t.tabela} (${t.linhas ?? "?"} linhas): ${t.omitidaPorNome ? OMITIDO : t.colunas.map((c) => c.coluna).join(", ")}`);
  }
  for (const c of r.versaoSpharm.conteudo) {
    L.push("", `Conteúdo de ${c.tabela} (${c.amostra.length} linhas):`, "", `| ${c.colunas.join(" | ")} |`, `|${c.colunas.map(() => "---").join("|")}|`);
    for (const row of c.amostra) L.push(`| ${c.colunas.map((k) => cel(row[k])).join(" | ")} |`);
  }
  L.push("");

  L.push("## 1. Colunas candidatas (todas as tabelas de utilizador)", "");
  L.push("| tabela | coluna | tipo | linhas da tabela | casou com | estado |", "|---|---|---|---|---|---|");
  for (const c of r.colunasCandidatas) {
    L.push(`| ${c.esquema}.${c.tabela} | ${c.inspeccao === "omitida-dado-pessoal" ? OMITIDO : c.coluna} | ${tipoComTamanho(c.tipo, c.tamanho)} | ${c.linhasTabela ?? "?"} | ${c.casou.join(", ")} | ${c.inspeccao}${c.nota ? ` — ${c.nota}` : ""} |`);
  }
  L.push("");
  if (r.fksDeStocks.length > 0) {
    L.push("FKs declaradas de dbo.Stocks:", "");
    for (const f of r.fksDeStocks) L.push(`- Stocks.[${f.coluna}] -> ${f.tabelaRef}.[${f.colunaRef}]`);
    L.push("");
  }
  L.push("### 1b. Tabelas candidatas (por nome) e tabelas de domínio pequenas", "");
  for (const t of r.tabelasCandidatas) {
    L.push(`- ${t.tabela} (${t.linhas ?? "?"} linhas): ${t.omitidaPorNome ? OMITIDO : t.colunas.map((c) => `${c.coluna}:${c.tipo}`).join(", ")}${t.colunasOmitidas ? ` (+${t.colunasOmitidas} colunas não listadas)` : ""}`);
  }
  L.push("");
  for (const c of r.conteudoTabelasDominio) {
    L.push(`**Conteúdo de ${c.tabela}** (${c.linhas ?? "?"} linhas)`, "", `| ${c.colunas.join(" | ")} |`, `|${c.colunas.map(() => "---").join("|")}|`);
    for (const row of c.amostra) L.push(`| ${c.colunas.map((k) => cel(row[k])).join(" | ")} |`);
    L.push("");
  }
  if (r.lookups.length > 0) {
    L.push("### 1c. Tabelas relacionadas a dbo.Stocks por FK (lookups)", "");
    for (const l of r.lookups) {
      L.push(`**Stocks.[${l.coluna}] -> ${l.tabelaRef}.[${l.colunaRef}]** (${l.linhasRef ?? "?"} linhas)${l.nota ? ` — ${l.nota}` : ""}`, "");
      if (l.usoEmStocks.length > 0) {
        L.push("| código em Stocks | descrição no lookup | artigos |", "|---|---|---|");
        for (const u of l.usoEmStocks) L.push(`| ${cel(u.codigo)} | ${cel(u.descricao)} | ${u.n} |`);
        L.push("");
      }
    }
  }

  L.push("## 2. Valores distintos e contagens por coluna", "");
  for (const pf of r.perfis) {
    L.push(`### ${pf.tabela}.[${pf.coluna}] (${pf.tipo})`, "");
    L.push(
      `Linhas: ${pf.total} · preenchidas: ${pf.preenchidas} · distintos: ${pf.distintos}` +
        (pf.listaCompleta ? "" : ` · lista parcial (top ${pf.valores.length})`),
      "",
      `Categorias (contagens): NULL=${pf.categorias.nulo}, vazio=${pf.categorias.vazio}, zero=${pf.categorias.zero}, um=${pf.categorias.um}, outros=${pf.categorias.outros}`,
      "",
      "| valor | linhas |",
      "|---|---|",
    );
    for (const v of pf.valores) L.push(`| ${cel(v.valor)} | ${v.n} |`);
    L.push("");
  }

  L.push("## 3. Genérico (dbo.Stocks.[Generico])", "");
  if (!r.generico.encontrado) L.push(`Coluna Generico não encontrada/inspeccionada em dbo.Stocks${r.generico.tipo ? ` (existe com tipo ${r.generico.tipo})` : ""}.`, "");
  else {
    const pf = r.generico.perfil!;
    L.push(
      `Coluna \`${pf.coluna}\` (tipo ${pf.tipo}): distintos ${pf.distintos} · NULL=${pf.categorias.nulo} · vazio=${pf.categorias.vazio} · 0=${pf.categorias.zero} · 1=${pf.categorias.um} · outros=${pf.categorias.outros}. Sem interpretação.`,
      "",
      "| valor | linhas | exemplos CNP |",
      "|---|---|---|",
    );
    for (const v of pf.valores) {
      const ex = r.generico.amostras.find((x) => x.valor === v.valor)?.exemplos.map((e) => e.cnp ?? "?").join(", ") ?? "";
      L.push(`| ${cel(v.valor)} | ${v.n} | ${ex} |`);
    }
    L.push("");
    for (const t of r.generico.cruzadas) {
      L.push(`Cruzamento ${t.colunaA} × ${t.colunaB}:`, "", `| ${t.colunaA} | ${t.colunaB} | linhas |`, "|---|---|---|");
      for (const c of t.celulas) L.push(`| ${cel(c.a)} | ${cel(c.b)} | ${c.n} |`);
      L.push("");
    }
  }

  L.push("## 4. Amostras CNP/código por valor (sem nomes, sem preços)", "");
  L.push("| coluna | valor | CNP (CodigoID) |", "|---|---|---|");
  for (const am of r.amostras) L.push(`| ${am.coluna} | ${cel(am.valor)} | ${am.exemplos.map((e) => `${e.cnp ?? "?"} (${e.codigoId ?? "?"})`).join(", ")} |`);
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
  L.push("## 6. Serviços e Processa_Stocks (filtro do agent)", "");
  L.push(s.filtroDoAgent, "", `Predicados reproduzidos: daily-sync \`${s.predicados.dailySync}\` · bootstrap (catálogo ativo) \`${s.predicados.bootstrapAtivo}\``, "");
  if (!s.disponivel) L.push("Coluna Processa_Stocks indisponível.", "");
  else {
    L.push(
      `Total de artigos: ${s.total} · Processa_Stocks = 0: **${s.zero}** · Processa_Stocks <> 0: **${s.diferenteDeZero}** · NULL: ${s.nulos}`,
      "",
      `- Incluídos pelo filtro do daily-sync (Processa_Stocks <> 0): **${s.incluidosPeloFiltro}**`,
      `- EXCLUÍDOS pelo filtro (Processa_Stocks = 0 ou NULL): **${s.excluidosPeloFiltro}**`,
      ...(s.ativosBootstrap !== null ? [`- Catálogo ativo do bootstrap (Retirado = 0 AND Processa_Stocks <> 0): **${s.ativosBootstrap}**`] : []),
      "",
    );
    if (s.marcadosVsFiltro.length > 0) {
      L.push("Artigos «marcados» (valor não NULL, não vazio, não 0) por coluna candidata, dentro e fora do filtro do agent:", "");
      L.push("| coluna | marcados | marcados incluídos | marcados EXCLUÍDOS | não marcados | não marcados excluídos |", "|---|---|---|---|---|---|");
      for (const m of s.marcadosVsFiltro) L.push(`| ${m.coluna} | ${m.marcados} | ${m.marcadosIncluidos} | ${m.marcadosExcluidos} | ${m.naoMarcados} | ${m.naoMarcadosExcluidos} |`);
      L.push("");
    }
    for (const d of s.distinguemPorColuna) {
      L.push(`### Coluna ${d.coluna} × Processa_Stocks`, "");
      L.push(`- valores só em artigos EXCLUÍDOS (Processa_Stocks = 0/NULL): ${d.soExcluidos.map((x) => `${cel(x.valor)}×${x.n}`).join(", ") || "(nenhum)"}`);
      L.push(`- valores só em artigos INCLUÍDOS (Processa_Stocks <> 0): ${d.soIncluidos.map((x) => `${cel(x.valor)}×${x.n}`).join(", ") || "(nenhum)"}`);
      L.push(`- valores nos dois grupos: ${d.emAmbos.map((x) => `${cel(x.valor)} (excluídos: ${x.excluidos}; incluídos: ${x.incluidos})`).join(", ") || "(nenhum)"}`, "");
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

  L.push("## 8. Leitura assistida (HIPÓTESES a confirmar por humano — não são conclusões)", "", r.leituraAssistida.aviso, "");
  for (const c of r.leituraAssistida.conceitos) {
    L.push(`### ${c.rotulo}`, "", `Colunas por nome: ${c.colunasPorNome.length ? c.colunasPorNome.join(", ") : "(nenhuma)"}`, "");
    L.push("| hipótese | estado segundo os números | evidência |", "|---|---|---|");
    for (const hp of c.hipoteses) L.push(`| ${hp.hipotese} | ${hp.estado} | ${hp.evidencia.join(" ").replace(/\|/g, "\\|")} |`);
    L.push("");
  }
  if (r.leituraAssistida.sobreposicoes.length > 0) {
    L.push("Sobreposições observadas entre conceitos:", "");
    for (const so of r.leituraAssistida.sobreposicoes) L.push(`- ${so}`);
    L.push("");
  }

  if (r.avisos.length > 0) {
    L.push("## Avisos", "");
    for (const av of r.avisos) L.push(`- ${av}`);
    L.push("");
  }

  L.push("## Anexo — queries executadas (texto, sem dados; valores substituídos por <valor>)", "");
  r.queries.forEach((qy, i) => {
    L.push(`${i + 1}.`, "```sql", qy, "```");
  });
  L.push("");
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
