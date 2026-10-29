/**
 * agent/src/classificacao-base.ts
 *
 * Primitivas partilhadas pelo diagnóstico da classificação (folha: não importa nenhum outro módulo de auditoria):
 * identificadores/literais SQL, famílias de tipo, deteção de nomes pessoais/monetários e sanitização de texto.
 */

/** Rótulo de campos que o relatório nunca mostra. */
export const OMITIDO = "[omitido]";


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

export function semAcentos(s: string): string {
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

export function valorSeguro(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = sanitizaTexto(String(v).trim());
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}


export const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
export const bool3 = (v: unknown): boolean | null => (v === null || v === undefined ? null : Number(v) === 1);

export async function tentar<T>(avisos: string[], rotulo: string, f: () => Promise<T>): Promise<T | null> {
  try {
    return await f();
  } catch (err) {
    avisos.push(`${rotulo}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300));
    return null;
  }
}


export type Ref = { esquema: string; tabela: string };
/** `[esquema].[tabela] x WITH (NOLOCK)`: leitura sem bloquear o ERP. */
export const de = (r: Ref) => `${q(r.esquema)}.${q(r.tabela)} x WITH (NOLOCK)`;

/**
 * Colunas de UMA tabela (estrutura; sem dados): nome, tipo, tamanho, precisão, escala, anulável e valor por omissão
 * (sys.columns + sys.default_constraints). `OBJECT_ID` devolve NULL se a tabela não existe → zero linhas.
 */
export function sqlColunasDeTabela(r: Ref): string {
  return [
    "SELECT c.column_id AS ordem, c.name AS coluna, ty.name AS tipo, c.max_length AS tamanho, c.precision AS precisao, c.scale AS escala, c.is_nullable AS anulavel, dc.definition AS padrao",
    "  FROM [sys].[columns] c",
    "  JOIN [sys].[types] ty ON ty.user_type_id = c.user_type_id",
    "  LEFT JOIN [sys].[default_constraints] dc ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id",
    ` WHERE c.object_id = OBJECT_ID(${lit(`${r.esquema}.${r.tabela}`)})`,
    " ORDER BY c.column_id",
  ].join("\n");
}

export type ColunaTabela = {
  ordem: number;
  coluna: string;
  tipo: string;
  tamanho: number | null;
  precisao: number | null;
  escala: number | null;
  anulavel: boolean;
  padrao: string | null;
};
/** Linhas de `sqlColunasDeTabela` → objetos tipados. */
export function lerColunasTabela(rows: Array<Record<string, unknown>>): ColunaTabela[] {
  const nn = (v: unknown) => (v === null || v === undefined ? null : num(v));
  return rows.map((r) => ({
    ordem: num(r.ordem),
    coluna: String(r.coluna),
    tipo: String(r.tipo),
    tamanho: nn(r.tamanho),
    precisao: nn(r.precisao),
    escala: nn(r.escala),
    anulavel: Number(r.anulavel) === 1 || r.anulavel === true,
    padrao: r.padrao === null || r.padrao === undefined ? null : String(r.padrao),
  }));
}

/** Nome sem espaços/underscores/pontuação, minúsculas, sem acentos: «Etico_NETT» == «Etico NETT» == «eticonett». */
export function nomeCompacto(s: string): string {
  return semAcentos(s).replace(/[^a-z0-9]/g, "");
}

/** Tabelas de CATÁLOGO cujos nomes de colunas (estrutura, nunca dados) são mostrados sem filtro de nomes. */
export const TABELAS_CATALOGO_APROVADAS = [
  "Stocks", "Etico_NETT", "Tipo de Medicamento", "Tipo Familia", "Tipo FamiliaP", "Parametros", "Parametros_Histo", "Stocks_Histo", "Stocks_HistoF",
] as const;
export const ehTabelaAprovada = (tabela: string) => TABELAS_CATALOGO_APROVADAS.some((t) => t.toLowerCase() === tabela.toLowerCase());
/** Nome com ar de segredo/credencial: nunca se lista nem lê, mesmo em tabelas aprovadas. */
export const pareceSegredo = (nome: string) =>
  /pass|pwd|secret|token|chave|senha|licen|smtp|login|utiliz|user|apikey|serial|nif|iban|mail|telef|morada/.test(semAcentos(nome).replace(/[^a-z0-9]/g, ""));