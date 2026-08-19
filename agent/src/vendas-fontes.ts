/**
 * agent/src/vendas-fontes.ts
 *
 * As fontes físicas de uma venda no ERP, normalizadas para UM shape.
 *
 * ── O DEFEITO QUE ISTO FECHA ─────────────────────────────────────────
 *
 * O leitor de vendas lia uma tabela:
 *
 *     FROM [dbo].[Atendimento] a
 *     JOIN [dbo].[Atendimento Detalhe] d ON d.[Atendimento ID] = a.[Atendimento ID]
 *
 * O ERP tem mais do que uma. Uma factura da série VSG — venda suspensa,
 * que contabilística e fiscalmente é uma venda como qualquer outra —
 * vive em `[Atendimento Susp Detalhe]`. Nunca era lida, e portanto nunca
 * entrava em `IngestVendaLinhaRaw`, nem em `VendaMensal`, nem no
 * relatório.
 *
 * Só se via pelo lado do stock: `dbo.StocksMov` é o livro-razão
 * universal e apanha as três origens, por isso o movimento existia em
 * `MovimentoArtigo` (classificado `RESERVA_SUSPENSA`, que é o nome do
 * circuito documental e não um juízo sobre se é venda) enquanto a venda
 * não existia em lado nenhum. Silveirense, 01/08/2026: Nimed 9599258 com
 * 2 unidades e Enalapril 3626884 com 1, entre outros, invisíveis.
 *
 * ── PORQUÊ UM NORMALIZADOR E NÃO UM UNION ────────────────────────────
 *
 * Um `UNION ALL` no SQL resolveria o sintoma e deixaria duas listas de
 * colunas a divergir em silêncio. Aqui cada fonte é um *reader* que
 * devolve `LinhaVendaCanonica`; a partir daí existe um caminho só —
 * mesma classificação, mesma idempotência, mesmo payload. Acrescentar
 * uma quarta fonte é acrescentar um reader, não editar uma query.
 *
 * ── DESCOBERTA DINÂMICA, E PORQUÊ ────────────────────────────────────
 *
 * Os nomes das colunas das tabelas de suspensas não são iguais em todas
 * as instalações Softreis. É o mesmo problema que o `stocksmov` resolveu
 * na rev32/37: perguntar a `sys.columns` quais existem e emitir `NULL`
 * no SELECT para as que faltam, em vez de partir a query inteira por uma
 * coluna com outro nome. A alternativa — fixar nomes que não vimos — dá
 * um agent que funciona numa farmácia e rebenta na seguinte.
 *
 * ── IDENTIDADE ───────────────────────────────────────────────────────
 *
 * `externalLineId` é a PK DENTRO da sua tabela. IDs de tabelas
 * diferentes são sequências independentes e não podem ser comparados
 * entre si. A identidade lógica é, por isso,
 *
 *     (farmaciaId, sourceNamespace, externalLineId)
 *
 * A auditoria de produção não encontrou colisões hoje. Isso não é
 * garantia nenhuma sobre amanhã: são contadores independentes de
 * tabelas independentes. Discriminar pela origem custa uma coluna e
 * remove a classe inteira do problema.
 */

import type { SqlPool } from "./sql-client.js";

// ─────────────────────────────────────────────────────────────────────
// Vocabulário
// ─────────────────────────────────────────────────────────────────────

/**
 * A tabela ERP de onde a linha veio. Faz parte da identidade, e é por
 * isso que é um valor persistido e não uma variável local.
 */
export const NAMESPACES = {
  /// `dbo.[Atendimento Detalhe]` — a venda de balcão. Série G.
  ATENDIMENTO_DETALHE: "ATENDIMENTO_DETALHE",
  /// `dbo.[Atendimento Susp Detalhe]` — venda suspensa. Série VSG.
  ATENDIMENTO_SUSP_DETALHE: "ATENDIMENTO_SUSP_DETALHE",
} as const;

export type SourceNamespace = (typeof NAMESPACES)[keyof typeof NAMESPACES];

/**
 * A classe canónica de uma linha. DUAS, e só duas.
 *
 * `UNKNOWN` não está aqui de propósito. Era uma classe que se gravava e
 * depois se filtrava — perder com passos extra. Uma linha que não se
 * consegue classificar é um erro de ingestão e tem de ser reportada,
 * não arrumada numa gaveta.
 */
export type ClasseVenda = "VENDA" | "DEVOLUCAO_ANULACAO";

/** Uma linha de venda, independente da tabela de onde veio. */
export type LinhaVendaCanonica = {
  // ── proveniência ──────────────────────────────────────────────
  sourceNamespace: SourceNamespace;
  /** PK dentro do namespace. NUNCA comparada entre namespaces. */
  externalLineId: number;
  /** Cabeçalho: `[Atendimento ID]`. Null se a fonte não o expõe. */
  externalDocumentId: number | null;

  // ── documento ─────────────────────────────────────────────────
  serie: string | null;
  documento: string | null;
  /** `Atendimento.[Tipo Documento]`, cru. A classificação é a seguir. */
  tipoDocumento: number | null;

  // ── classificação ─────────────────────────────────────────────
  classe: ClasseVenda;

  // ── medidas, ao valor histórico da linha ──────────────────────
  /** Positiva na venda, negativa na NC/anulação. */
  quantidadeAssinada: number;
  pvpUnitario: number | null;
  valorBruto: number | null;
  ivaValor: number | null;
  descontoValor: number | null;
  comparticipacao1: number | null;
  comparticipacao2: number | null;

  // ── contexto ──────────────────────────────────────────────────
  dataVenda: string | null;
  externalProductId: number;
  processaStocks: boolean | null;
  entidadeId: number | null;
  sequencia: number | null;
};

// ─────────────────────────────────────────────────────────────────────
// Classificação documental
// ─────────────────────────────────────────────────────────────────────

/**
 * Que tipos de documento são venda e quais são reversão, POR CIRCUITO.
 *
 * ── PORQUE É POR NAMESPACE E NÃO UMA LISTA GLOBAL ────────────────────
 *
 * Os dois circuitos numeram os seus tipos de documento em colunas
 * diferentes de tabelas diferentes — `Atendimento.[Tipo Documento]` e
 * `Atendimento Susp.[Tipo Documento ID]`. Nada garante que o mesmo
 * número signifique o mesmo dos dois lados, e uma lista global assume
 * precisamente isso. Foi a suposição equivalente — "a coluna chama-se
 * `Atendimento ID`, logo aponta para o `Atendimento`" — que fez o reader
 * ler zero linhas durante uma ronda inteira.
 *
 * ── O QUE ESTÁ PROVADO NO ERP DA SILVEIRENSE ─────────────────────────
 *
 * Circuito G, `[Atendimento]`:
 *   · 77       venda de balcão
 *   · 104, 27  nota de crédito / anulação
 *
 * Circuito VSG, `[Atendimento Susp]`:
 *   · 107      factura de venda suspensa
 *
 * E o conjunto de reversões do circuito VSG está VAZIO de propósito, não
 * por esquecimento. As 107 relações de `Atendimento_SuspFT_NC_Susp`
 * resolvem 107/107 para `[Atendimento]`, com `[Tipo Documento] = 104`, e
 * as suas linhas vivem em `[Atendimento Detalhe]` — que o reader do
 * circuito G já lê. Declarar 104 aqui faria a MESMA nota de crédito ser
 * lida duas vezes e subtraída duas vezes: o erro simétrico daquele que
 * andámos a corrigir, e igualmente plausível à vista.
 */
export const CLASSIFICACAO: Record<
  SourceNamespace,
  { venda: ReadonlySet<number>; reversao: ReadonlySet<number> }
> = {
  [NAMESPACES.ATENDIMENTO_DETALHE]: {
    venda: new Set([77]),
    reversao: new Set([104, 27]),
  },
  [NAMESPACES.ATENDIMENTO_SUSP_DETALHE]: {
    venda: new Set([107]),
    // Vazio por decisão, não por omissão. Ver acima.
    reversao: new Set<number>(),
  },
};

/**
 * A classe de uma linha, dado o tipo de documento e o circuito de onde
 * veio. Fail-closed: o que não está declarado é recusado.
 *
 * ── PORQUE É QUE O DESCONHECIDO NÃO É VENDA ──────────────────────────
 *
 * A primeira versão disto devolvia `VENDA` para tudo o que não fosse
 * reversão. Parece conservador e é o contrário: se um tipo de nota de
 * crédito não estivesse na lista, cada NC passava a venda e o total
 * subia em vez de descer — um erro que soma na direcção errada e
 * continua a parecer plausível durante meses.
 *
 * Uma linha recusada é contada e o número do tipo aparece no log. É o
 * único desfecho que não se perde: uma linha mal classificada entra na
 * soma e desaparece; uma linha recusada fica a apontar para si própria.
 */
export function classificarDocumento(
  tipoDocumento: number | null,
  sourceNamespace: SourceNamespace,
): ClasseVenda | null {
  if (tipoDocumento === null) return null;
  const regras = CLASSIFICACAO[sourceNamespace];
  if (!regras) return null;
  if (regras.reversao.has(tipoDocumento)) return "DEVOLUCAO_ANULACAO";
  if (regras.venda.has(tipoDocumento)) return "VENDA";
  return null;
}

/**
 * O sinal da quantidade, dada a classe.
 *
 * ── APLICADO UMA VEZ, SEJA QUAL FOR O SINAL DE ORIGEM ────────────────
 *
 * `Math.abs` antes de decidir o sinal torna isto idempotente, e isso não
 * é elegância: as notas de crédito do circuito G chegam de
 * `[Atendimento Detalhe]` já NEGATIVAS. Sem o `abs`, uma NC de −2 saía
 * `−(−2) = +2` e a devolução passava a venda. Com ele, `−|−2| = −2`
 * tanto na primeira passagem como em qualquer outra.
 *
 * A agregação (`SQL_QUANTIDADE_ASSINADA`) faz o mesmo `ABS()` por
 * classe, portanto os dois lados concordam e o sinal nunca é aplicado
 * duas vezes — mesmo que a linha volte a passar aqui num re-upload.
 */
export function assinarQuantidade(qtd: number, classe: ClasseVenda): number {
  const abs = Math.abs(qtd);
  return classe === "DEVOLUCAO_ANULACAO" ? -abs : abs;
}

/** "VSG" + 54688 → "VSG/54688". Null se faltar uma das peças. */
export function comporDocumento(
  serie: string | null,
  numero: number | string | null,
): string | null {
  const s = (serie ?? "").toString().trim();
  const n = numero === null || numero === undefined ? NaN : Number(numero);
  if (!s || !Number.isFinite(n)) return null;
  return `${s}/${Math.trunc(n)}`;
}

// ─────────────────────────────────────────────────────────────────────
// Descoberta de schema
// ─────────────────────────────────────────────────────────────────────

type Coluna = { column: string };

/** Colunas reais de uma tabela, ou `null` se a tabela não existir. */
async function colunasDe(pool: SqlPool, tabela: string): Promise<Coluna[] | null> {
  const r = await pool
    .request()
    .input("t", tabela)
    .query<{ column: string }>(
      `SELECT c.name AS [column]
         FROM sys.columns c
         JOIN sys.objects o ON o.object_id = c.object_id
        WHERE o.name = @t AND o.type = 'U'`,
    );
  return r.recordset.length > 0 ? r.recordset : null;
}

/** A primeira coluna cujo nome bate num dos padrões. */
function escolher(cols: Coluna[] | null, padroes: RegExp[]): string | null {
  if (!cols) return null;
  for (const re of padroes) {
    const m = cols.find((c) => re.test(c.column));
    if (m) return m.column;
  }
  return null;
}

/** `[Nome Com Espaços]`. Null passa a null para o builder emitir NULL. */
function bk(col: string | null): string | null {
  return col ? `[${col}]` : null;
}

/**
 * A coluna de `tabela` que o ERP DECLARA apontar para `tabelaAlvo`.
 *
 * ── PORQUE É QUE ISTO NÃO PODE SER FEITO POR NOME ────────────────────
 *
 * `[Atendimento Susp Detalhe]` tem uma coluna chamada `Atendimento ID`.
 * Parece a ligação ao documento e não é: das 40 664 linhas, 11 868
 * resolviam contra `[Atendimento]` e NENHUMA passava o filtro que o
 * reader aplicava. A ligação documental verdadeira é
 * `Atendimento Susp ID -> [Atendimento Susp]`, e está DECLARADA como
 * chave estrangeira desde sempre.
 *
 * Um nome parecido é uma coincidência; uma FK é uma afirmação do
 * esquema. Perguntar a `sys.foreign_key_columns` custa uma query e é a
 * diferença entre ler o documento certo e ler zero linhas.
 */
async function fkDeclaradaPara(
  pool: SqlPool,
  tabela: string,
  tabelaAlvo: string,
): Promise<string | null> {
  const r = await pool
    .request()
    .input("t", tabela)
    .input("alvo", tabelaAlvo)
    .query<{ coluna: string }>(
      `SELECT pc.name AS coluna
         FROM sys.foreign_key_columns fkc
         JOIN sys.objects o  ON o.object_id  = fkc.parent_object_id
         JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id
                            AND pc.column_id = fkc.parent_column_id
         JOIN sys.objects ro ON ro.object_id = fkc.referenced_object_id
        WHERE o.name = @t AND ro.name = @alvo`,
    );
  return r.recordset[0]?.coluna ?? null;
}

export type SchemaFonteSusp = {
  /** A tabela existe nesta instalação. */
  existe: boolean;
  tabela: string;
  pk: string | null;
  /**
   * A FK DECLARADA para `[Atendimento Susp]` — a ligação documental.
   * Vem de `sys.foreign_key_columns`, nunca do nome da coluna.
   */
  cabecalhoFk: string | null;
  codigoId: string | null;
  sequencia: string | null;
  quantidade: string | null;
  pvpUnitario: string | null;
  valorLinha: string | null;
  ivaValor: string | null;
  descontoValor: string | null;
  comparticipacao1: string | null;
  comparticipacao2: string | null;
  entidadeId: string | null;
  dataVenda: string | null;
};

const TABELA_SUSP = "Atendimento Susp Detalhe";
const TABELA_CABECALHO_SUSP = "Atendimento Susp";

/** As colunas documentais de `[Atendimento Susp]`, o cabeçalho da VSG. */
export type SchemaCabecalhoSusp = {
  existe: boolean;
  tabela: string;
  pk: string | null;
  serie: string | null;
  numero: string | null;
  tipoDocumento: string | null;
  dataVenda: string | null;
  totalBruto: string | null;
};

/**
 * Descobre `[Atendimento Susp]`.
 *
 * É este o cabeçalho da venda suspensa — não o `[Atendimento]`. Carrega
 * `SerieFacturacao`, `Numero Documento`, `Tipo Documento ID`,
 * `Data Venda` e `Total Bruto_EUR`, e é de onde vem tudo o que
 * identifica o documento.
 *
 * `Fim Venda` NÃO é lido. Existe na tabela, e não serve para classificar:
 * as duas vendas confirmadas do ERP têm `N`, e no mesmo dia há VSG tipo
 * 107 com `N` e com `S`. Filtrar por ele devolvia zero.
 */
export async function descobrirCabecalhoSusp(pool: SqlPool): Promise<SchemaCabecalhoSusp> {
  const cols = await colunasDe(pool, TABELA_CABECALHO_SUSP);
  return {
    existe: cols !== null,
    tabela: TABELA_CABECALHO_SUSP,
    pk: escolher(cols, [/^atendimento\s*susp\s*id$/i, /^susp\s*id$/i]),
    serie: escolher(cols, [/^serie\s*facturacao$/i, /^seriefacturacao$/i, /^serie$/i]),
    numero: escolher(cols, [/^numero\s*documento$/i, /^numero$/i]),
    tipoDocumento: escolher(cols, [/^tipo\s*documento\s*id$/i, /^tipo\s*documento$/i]),
    dataVenda: escolher(cols, [/^data\s*venda$/i, /^data$/i]),
    totalBruto: escolher(cols, [/^total\s*bruto_eur$/i, /^total\s*bruto$/i]),
  };
}

/**
 * Descobre as colunas de `[Atendimento Susp Detalhe]`.
 *
 * Os padrões vêm dos nomes conhecidos em `[Atendimento Detalhe]` e das
 * variações que o Softreis usa (com e sem sufixo `_EUR`, com e sem
 * espaços). Uma coluna que não apareça fica `null` e o SELECT emite
 * `NULL` — a linha entra com esse campo vazio em vez de a query rebentar.
 *
 * A EXCEPÇÃO é `cabecalhoFk`: essa não é adivinhada por nome nenhum. Vem
 * da FK declarada, porque foi exactamente aí que a versão anterior
 * escolheu a coluna errada.
 */
export async function descobrirSchemaSusp(pool: SqlPool): Promise<SchemaFonteSusp> {
  const cols = await colunasDe(pool, TABELA_SUSP);
  const cabecalhoFk = cols
    ? await fkDeclaradaPara(pool, TABELA_SUSP, TABELA_CABECALHO_SUSP)
    : null;
  return {
    existe: cols !== null,
    tabela: TABELA_SUSP,
    pk: escolher(cols, [
      /^atendimento\s*susp\s*detalhe\s*id$/i,
      /^susp\s*detalhe\s*id$/i,
      /^detalhe\s*susp\s*id$/i,
      /^detalhe\s*id$/i,
    ]),
    cabecalhoFk,
    codigoId: escolher(cols, [/^codigo\s*id$/i, /^codigoid$/i]),
    sequencia: escolher(cols, [/^sequencia$/i, /^seq$/i]),
    quantidade: escolher(cols, [/^quantidade$/i, /^qtd$/i]),
    pvpUnitario: escolher(cols, [
      /^preco\s*venda\s*publico_eur$/i,
      /^preco\s*venda\s*publico$/i,
      /^pvp_eur$/i,
      /^pvp$/i,
    ]),
    valorLinha: escolher(cols, [/^valor_eur$/i, /^valor$/i]),
    ivaValor: escolher(cols, [/^val_iva_eur$/i, /^val_iva$/i, /^iva$/i]),
    descontoValor: escolher(cols, [/^val_desc_eur$/i, /^val_desc$/i, /^desconto$/i]),
    comparticipacao1: escolher(cols, [/^prcomp_eur$/i, /^prcomp$/i]),
    comparticipacao2: escolher(cols, [/^prcomp_eur2$/i, /^prcomp2$/i]),
    entidadeId: escolher(cols, [/^entidade\s*id$/i]),
    // Algumas instalações datam a própria linha; quando não, usa-se a
    // data do cabeçalho.
    dataVenda: escolher(cols, [/^data\s*venda$/i, /^data$/i]),
  };
}

/** Uma linha da fonte, tal como o SQL a devolve. */
export type FonteRow = {
  externalLineId: number;
  externalDocumentId: number | null;
  sequencia: number | null;
  dataVenda: Date | null;
  tipoDocumento: number | null;
  serie: string | null;
  numero: number | string | null;
  externalProductId: number;
  processaStocks: unknown;
  quantidade: unknown;
  pvpUnitario: unknown;
  valorLinha: unknown;
  ivaValor: unknown;
  descontoValor: unknown;
  comparticipacao1: unknown;
  comparticipacao2: unknown;
  entidadeId: number | null;
};

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function bool(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v;
  const n = Number(v);
  if (Number.isFinite(n)) return n !== 0;
  return null;
}

function txt(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

/**
 * `FonteRow` → `LinhaVendaCanonica`.
 *
 * Devolve `null` — e a razão — quando a linha não é representável. Uma
 * linha sem produto ou sem tipo de documento classificável não deve
 * entrar em silêncio: o caller conta-a e reporta-a.
 */
export function normalizar(
  r: FonteRow,
  sourceNamespace: SourceNamespace,
): { linha: LinhaVendaCanonica } | { erro: string } {
  const externalLineId = num(r.externalLineId);
  if (externalLineId === null) return { erro: "sem externalLineId" };

  const externalProductId = num(r.externalProductId);
  if (externalProductId === null) return { erro: "sem CodigoID" };

  const tipoDocumento = num(r.tipoDocumento);
  const classe = classificarDocumento(tipoDocumento, sourceNamespace);
  if (classe === null) {
    return {
      erro: `tipo de documento por classificar em ${sourceNamespace}: ${tipoDocumento ?? "(nulo)"}`,
    };
  }

  const qtd = num(r.quantidade) ?? 0;
  const serie = txt(r.serie);

  return {
    linha: {
      sourceNamespace,
      externalLineId,
      externalDocumentId: num(r.externalDocumentId),
      serie,
      documento: comporDocumento(serie, r.numero),
      tipoDocumento,
      classe,
      quantidadeAssinada: assinarQuantidade(qtd, classe),
      pvpUnitario: num(r.pvpUnitario),
      valorBruto: num(r.valorLinha),
      ivaValor: num(r.ivaValor),
      descontoValor: num(r.descontoValor),
      comparticipacao1: num(r.comparticipacao1),
      comparticipacao2: num(r.comparticipacao2),
      dataVenda:
        r.dataVenda instanceof Date && !Number.isNaN(r.dataVenda.getTime())
          ? r.dataVenda.toISOString()
          : null,
      externalProductId,
      processaStocks: bool(r.processaStocks),
      entidadeId: num(r.entidadeId),
      sequencia: num(r.sequencia),
    },
  };
}

/** O payload que segue para `/api/ingest/v1/bootstrap/sales-lines`. */
export function paraPayload(l: LinhaVendaCanonica): Record<string, unknown> {
  return {
    sourceNamespace: l.sourceNamespace,
    externalSaleLineId: l.externalLineId,
    externalSaleId: l.externalDocumentId,
    serie: l.serie,
    documento: l.documento,
    sequencia: l.sequencia,
    dataVenda: l.dataVenda,
    tipoDocumento: l.tipoDocumento,
    tipoDocumentoClass: l.classe,
    externalProductId: l.externalProductId,
    processaStocks: l.processaStocks,
    // A quantidade viaja ASSINADA. O servidor não volta a decidir o
    // sinal: a semântica documental é do lado que leu o documento.
    quantidade: l.quantidadeAssinada,
    pvpUnitario: l.pvpUnitario,
    valorLinha: l.valorBruto,
    ivaValor: l.ivaValor,
    descontoValor: l.descontoValor,
    comparticipacao1: l.comparticipacao1,
    comparticipacao2: l.comparticipacao2,
    entidadeId: l.entidadeId,
  };
}

// ─────────────────────────────────────────────────────────────────────
// SQL por fonte
// ─────────────────────────────────────────────────────────────────────

/**
 * Série e número do cabeçalho, mais o tipo de documento.
 *
 * Descobertos dinamicamente porque `Atendimento` também varia entre
 * instalações — é o mesmo conjunto que o `stocksmov` já resolve para
 * compor "G/783019".
 */
export type SchemaAtendimento = {
  serie: string | null;
  numero: string | null;
  tipoDocumento: string | null;
  dataVenda: string | null;
  fimVenda: string | null;
};

export async function descobrirSchemaAtendimento(pool: SqlPool): Promise<SchemaAtendimento> {
  const cols = await colunasDe(pool, "Atendimento");
  return {
    serie: escolher(cols, [/^serie$/i, /^serie\s*documento$/i]),
    numero: escolher(cols, [/^numero$/i, /^n\s*documento$/i, /^numero\s*documento$/i]),
    tipoDocumento: escolher(cols, [/^tipo\s*documento$/i]),
    dataVenda: escolher(cols, [/^data\s*venda$/i]),
    fimVenda: escolher(cols, [/^fim\s*venda$/i]),
  };
}

/**
 * Um item da lista do SELECT. SEM vírgula: quem sabe se é o último é
 * quem junta a lista, não quem produz o item.
 *
 * ── O DEFEITO QUE ISTO TEVE ──────────────────────────────────────────
 *
 * A primeira versão devolvia a linha e o builder juntava tudo com "\n".
 * Sem vírgula nenhuma. O SQL Server responde "Incorrect syntax near 'a'"
 * — o token a seguir a `AS externalLineId` — e o pipeline de vendas
 * morria antes de ler uma única linha, nas DUAS fontes.
 *
 * Passou nos testes porque eles verificavam `sql.includes(fragmento)`, e
 * cada fragmento estava lá. Fragmentos correctos não fazem uma query
 * correcta: só a query inteira é que é a query. É por isso que agora há
 * um teste da string completa e um validador estrutural.
 */
function sel(alias: string, expr: string | null): string {
  return `    ${expr ?? "NULL"} AS ${alias}`;
}

/** A lista do SELECT, com as vírgulas onde têm de estar. */
function listaSelect(itens: string[]): string {
  return itens.join(",\n");
}

/**
 * SQL da venda de balcão. É a query que já existia, com série e número
 * acrescentados — o resto é idêntico, de propósito: esta fonte já
 * funcionava e não é para mudar de comportamento.
 */
export function sqlAtendimentoDetalhe(at: SchemaAtendimento): string {
  return [
    "SELECT TOP (@n)",
    listaSelect([
      sel("externalLineId", "d.[Detalhe ID]"),
      sel("externalDocumentId", "a.[Atendimento ID]"),
      sel("sequencia", "d.[Sequencia]"),
      sel("dataVenda", "a.[Data Venda]"),
      sel("tipoDocumento", bk(at.tipoDocumento) ? `a.${bk(at.tipoDocumento)}` : null),
      sel("serie", at.serie ? `a.${bk(at.serie)}` : null),
      sel("numero", at.numero ? `a.${bk(at.numero)}` : null),
      sel("externalProductId", "d.[CodigoID]"),
      sel("processaStocks", "s.[Processa_Stocks]"),
      sel("quantidade", "d.[Quantidade]"),
      sel("pvpUnitario", "d.[Preco Venda Publico_EUR]"),
      sel("valorLinha", "d.[Valor_EUR]"),
      sel("ivaValor", "d.[Val_IVA_EUR]"),
      sel("descontoValor", "d.[Val_Desc_EUR]"),
      sel("comparticipacao1", "d.[PrComp_EUR]"),
      sel("comparticipacao2", "d.[PrComp_EUR2]"),
      sel("entidadeId", "d.[Entidade ID]"),
    ]),
    "  FROM [dbo].[Atendimento] a",
    "  JOIN [dbo].[Atendimento Detalhe] d ON d.[Atendimento ID] = a.[Atendimento ID]",
    "  LEFT JOIN [dbo].[Stocks] s ON s.CodigoID = d.[CodigoID]",
    " WHERE a.[Fim Venda] = 'S'",
    "   AND a.[Data Venda] >= @from AND a.[Data Venda] < @to",
    "   AND d.[Detalhe ID] > @lastId",
    " ORDER BY d.[Detalhe ID]",
  ].join("\n");
}

/**
 * SQL da venda suspensa.
 *
 * ── O QUE MUDOU, E PORQUÊ ────────────────────────────────────────────
 *
 * A versão anterior ligava-se ao `[Atendimento]` e filtrava
 * `[Fim Venda] = 'S'`. As duas coisas estavam erradas, e o ERP real
 * mostrou-o sem ambiguidade:
 *
 *   · o cabeçalho da VSG é `[Atendimento Susp]`, ligado pela FK
 *     declarada `Atendimento Susp ID`. É lá que estão `SerieFacturacao`,
 *     `Numero Documento`, `Tipo Documento ID`, `Data Venda`;
 *   · `[Fim Venda] = 'S'` devolvia ZERO linhas — e as duas vendas
 *     confirmadas (VSG/54684 e VSG/54688) têm `N`. O campo não separa
 *     facturada de não facturada; separa outra coisa qualquer, e não é
 *     usado aqui para nada.
 *
 * `INNER JOIN` ao cabeçalho: uma linha sem documento não é uma venda.
 * A regra fica no JOIN, visível, e não num `if` mais abaixo.
 *
 * Não há reader de reversões VSG, de propósito. As notas de crédito das
 * VSG vivem em `[Atendimento]`/`[Atendimento Detalhe]` — 107/107
 * verificadas — e o reader do circuito G já as lê. Um segundo reader
 * subtrairia a mesma NC duas vezes.
 */
export type ResultadoFonte =
  /** A tabela não existe nesta instalação. Saltar é correcto. */
  | { estado: "AUSENTE" }
  /**
   * A tabela EXISTE mas não se conseguiu ligar. Isto NÃO pode ser
   * saltado em silêncio: sabemos que ali dentro há vendas, e ignorá-las
   * é exactamente o defeito que esta ronda veio corrigir. O pipeline
   * pára e diz o que falta.
   */
  | { estado: "POR_LIGAR"; faltam: string[] }
  | { estado: "PRONTA"; sql: string };

export function sqlAtendimentoSuspDetalhe(
  susp: SchemaFonteSusp,
  cab: SchemaCabecalhoSusp,
): ResultadoFonte {
  if (!susp.existe) return { estado: "AUSENTE" };

  // Sem cabeçalho não há documento, e sem `Tipo Documento ID` não há
  // classificação. Uma fonte meio-ligada daria números errados em
  // silêncio — que é precisamente o que já aconteceu uma vez.
  const faltam = (
    [
      ["pk", susp.pk],
      [`FK declarada para [${cab.tabela}]`, susp.cabecalhoFk],
      ["CodigoID", susp.codigoId],
      ["quantidade", susp.quantidade],
      [`[${cab.tabela}]`, cab.existe ? "sim" : null],
      [`[${cab.tabela}].pk`, cab.pk],
      [`[${cab.tabela}].[Tipo Documento ID]`, cab.tipoDocumento],
      [`[${cab.tabela}].[Data Venda]`, cab.dataVenda],
    ] as const
  )
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (faltam.length > 0) return { estado: "POR_LIGAR", faltam };

  const pk = bk(susp.pk)!;
  const fk = bk(susp.cabecalhoFk)!;
  const cabPk = bk(cab.pk)!;
  const sql = [
    "SELECT TOP (@n)",
    listaSelect([
      sel("externalLineId", `d.${pk}`),
      sel("externalDocumentId", `h.${cabPk}`),
      sel("sequencia", susp.sequencia ? `d.${bk(susp.sequencia)}` : null),
      sel("dataVenda", `h.${bk(cab.dataVenda)}`),
      sel("tipoDocumento", `h.${bk(cab.tipoDocumento)}`),
      sel("serie", cab.serie ? `h.${bk(cab.serie)}` : null),
      sel("numero", cab.numero ? `h.${bk(cab.numero)}` : null),
      sel("externalProductId", `d.${bk(susp.codigoId)}`),
      sel("processaStocks", "s.[Processa_Stocks]"),
      sel("quantidade", susp.quantidade ? `d.${bk(susp.quantidade)}` : null),
      sel("pvpUnitario", susp.pvpUnitario ? `d.${bk(susp.pvpUnitario)}` : null),
      sel("valorLinha", susp.valorLinha ? `d.${bk(susp.valorLinha)}` : null),
      sel("ivaValor", susp.ivaValor ? `d.${bk(susp.ivaValor)}` : null),
      sel("descontoValor", susp.descontoValor ? `d.${bk(susp.descontoValor)}` : null),
      sel("comparticipacao1", susp.comparticipacao1 ? `d.${bk(susp.comparticipacao1)}` : null),
      sel("comparticipacao2", susp.comparticipacao2 ? `d.${bk(susp.comparticipacao2)}` : null),
      sel("entidadeId", susp.entidadeId ? `d.${bk(susp.entidadeId)}` : null),
    ]),
    `  FROM [dbo].[${susp.tabela}] d`,
    `  JOIN [dbo].[${cab.tabela}] h ON h.${cabPk} = d.${fk}`,
    `  LEFT JOIN [dbo].[Stocks] s ON s.CodigoID = d.${bk(susp.codigoId)}`,
    ` WHERE h.${bk(cab.dataVenda)} >= @from AND h.${bk(cab.dataVenda)} < @to`,
    `   AND d.${pk} > @lastId`,
    ` ORDER BY d.${pk}`,
  ].join("\n");
  return { estado: "PRONTA", sql };
}

/** Resumo legível do que a descoberta encontrou, para o log da corrida. */
export function resumoSchema(
  susp: SchemaFonteSusp,
  at: SchemaAtendimento,
  cab?: SchemaCabecalhoSusp,
): string[] {
  const linhas: string[] = [];
  linhas.push(
    `  [Atendimento] (circuito G): serie=${at.serie ?? "-"} numero=${at.numero ?? "-"} ` +
      `tipoDoc=${at.tipoDocumento ?? "-"}`,
  );
  if (!susp.existe) {
    linhas.push(`  [${TABELA_SUSP}]: NAO EXISTE nesta instalacao — fonte VSG inactiva`);
    return linhas;
  }
  if (cab) {
    linhas.push(
      `  [${TABELA_CABECALHO_SUSP}] (circuito VSG): pk=${cab.pk ?? "-"} ` +
        `serie=${cab.serie ?? "-"} numero=${cab.numero ?? "-"} ` +
        `tipoDoc=${cab.tipoDocumento ?? "-"} data=${cab.dataVenda ?? "-"}`,
    );
  }
  linhas.push(
    `  [${TABELA_SUSP}]: pk=${susp.pk ?? "-"} ` +
      `fk->cabecalho=${susp.cabecalhoFk ?? "-"} (declarada) ` +
      `codigo=${susp.codigoId ?? "-"} qtd=${susp.quantidade ?? "-"}`,
  );
  const faltam = (
    [
      ["pk", susp.pk],
      ["cabecalhoFk", susp.cabecalhoFk],
      ["codigoId", susp.codigoId],
      ["quantidade", susp.quantidade],
      ["pvpUnitario", susp.pvpUnitario],
      ["valorLinha", susp.valorLinha],
    ] as const
  )
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (faltam.length > 0) {
    linhas.push(`  ATENCAO colunas por resolver: ${faltam.join(", ")}`);
  }
  linhas.push(
    `  classificacao VSG: venda={${[...CLASSIFICACAO.ATENDIMENTO_SUSP_DETALHE.venda].join(",")}} ` +
      `reversao={} (as NC de VSG sao lidas pelo circuito G)`,
  );
  return linhas;
}
