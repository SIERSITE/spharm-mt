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
 * Tipos de documento que o ERP usa para reverter uma venda.
 *
 * 104 e 27 são os que o classificador de movimentos já usa para as
 * notas de crédito do circuito G (`movimento-classifier.ts`). Vivem
 * aqui como conjunto explícito porque agora servem os DOIS circuitos: a
 * regra de negócio é "NC/anulação de G e de VSG reduzem a venda", e não
 * "NC do circuito G".
 */
export const TIPOS_DOC_REVERSAO = new Set<number>([104, 27]);

/**
 * Tipos de documento conhecidos como VENDA.
 *
 * 77 é o que o circuito G usa e é o único observado. A lista é explícita
 * de propósito — ver `classificarDocumento`.
 */
export const TIPOS_DOC_VENDA = new Set<number>([77]);

/**
 * A classe de uma linha, a partir do tipo de documento do ERP.
 *
 * ── PORQUE É QUE O DESCONHECIDO NÃO É VENDA ──────────────────────────
 *
 * A primeira versão disto devolvia `VENDA` para tudo o que não fosse
 * reversão. Parece conservador e é o contrário: os tipos {104, 27} vêm
 * do circuito G — foram observados em notas de crédito de facturas G — e
 * NADA prova que o circuito da venda suspensa use os mesmos. Se as NC de
 * VSG usarem outro tipo, o `else return VENDA` transformava cada nota de
 * crédito numa venda, e o total subia em vez de descer. Um erro que soma
 * na direcção errada e continua a parecer plausível.
 *
 * Por isso: só classifica o que está declarado. Tudo o resto devolve
 * `null`, a linha é recusada e o tipo aparece no log — que é o sinal de
 * que falta declará-lo, e o único que não se perde.
 *
 * Fechar esta lista para o circuito VSG exige ver que tipos de documento
 * lá aparecem: `agent -- vendas-suspensas-audit` responde a isso sem
 * escrever nada.
 */
export function classificarDocumento(tipoDocumento: number | null): ClasseVenda | null {
  if (tipoDocumento === null) return null;
  if (TIPOS_DOC_REVERSAO.has(tipoDocumento)) return "DEVOLUCAO_ANULACAO";
  if (TIPOS_DOC_VENDA.has(tipoDocumento)) return "VENDA";
  return null;
}

/**
 * O sinal da quantidade, dada a classe.
 *
 * O ERP grava quantidades positivas nas duas classes e distingue-as pelo
 * documento. Quem soma tem de ver o sinal, senão uma nota de crédito
 * aumenta as vendas — que é o erro que passa despercebido durante meses
 * porque o total continua a parecer plausível.
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

export type SchemaFonteSusp = {
  /** A tabela existe nesta instalação. */
  existe: boolean;
  tabela: string;
  pk: string | null;
  atendimentoFk: string | null;
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

/**
 * Descobre as colunas de `[Atendimento Susp Detalhe]`.
 *
 * Os padrões vêm dos nomes conhecidos em `[Atendimento Detalhe]` e das
 * variações que o Softreis usa (com e sem sufixo `_EUR`, com e sem
 * espaços). Uma coluna que não apareça fica `null` e o SELECT emite
 * `NULL` — a linha entra com esse campo vazio em vez de a query rebentar.
 */
export async function descobrirSchemaSusp(pool: SqlPool): Promise<SchemaFonteSusp> {
  const cols = await colunasDe(pool, TABELA_SUSP);
  return {
    existe: cols !== null,
    tabela: TABELA_SUSP,
    pk: escolher(cols, [
      /^atendimento\s*susp\s*detalhe\s*id$/i,
      /^susp\s*detalhe\s*id$/i,
      /^detalhe\s*susp\s*id$/i,
      /^detalhe\s*id$/i,
    ]),
    atendimentoFk: escolher(cols, [/^atendimento\s*id$/i, /^atendimento$/i]),
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
  const classe = classificarDocumento(tipoDocumento);
  if (classe === null) {
    return { erro: `tipo de documento por classificar: ${tipoDocumento ?? "(nulo)"}` };
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

function sel(alias: string, expr: string | null): string {
  return `    ${expr ?? "NULL"} AS ${alias}`;
}

/**
 * SQL da venda de balcão. É a query que já existia, com série e número
 * acrescentados — o resto é idêntico, de propósito: esta fonte já
 * funcionava e não é para mudar de comportamento.
 */
export function sqlAtendimentoDetalhe(at: SchemaAtendimento): string {
  return [
    "SELECT TOP (@n)",
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
 * Liga-se ao MESMO cabeçalho `Atendimento` — é de lá que vêm a série
 * (VSG), o `[Tipo Documento]` que separa a factura da nota de crédito, e
 * a data. Sem esse JOIN não há forma de distinguir uma VSG facturada de
 * uma suspensão por fiscalizar, e é por isso que ele é obrigatório aqui:
 * uma linha de `Susp Detalhe` sem cabeçalho não entra.
 *
 * `INNER JOIN` e não `LEFT`: a ausência de cabeçalho é exactamente o
 * caso "ainda não é uma venda". A regra fica no JOIN, visível, em vez de
 * num `if` mais abaixo.
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
  at: SchemaAtendimento,
): ResultadoFonte {
  if (!susp.existe) return { estado: "AUSENTE" };

  // O JOIN ao cabeçalho não é opcional: sem `[Tipo Documento]` não há
  // como separar factura de nota de crédito, e sem a FK não há
  // cabeçalho. Uma fonte meio-ligada daria números errados em silêncio.
  const faltam = (
    [
      ["pk", susp.pk],
      ["FK para Atendimento", susp.atendimentoFk],
      ["CodigoID", susp.codigoId],
      ["quantidade", susp.quantidade],
      ["Atendimento.[Tipo Documento]", at.tipoDocumento],
    ] as const
  )
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (faltam.length > 0) return { estado: "POR_LIGAR", faltam };

  const pk = bk(susp.pk)!;
  const fk = bk(susp.atendimentoFk)!;
  const sql = [
    "SELECT TOP (@n)",
    sel("externalLineId", `d.${pk}`),
    sel("externalDocumentId", "a.[Atendimento ID]"),
    sel("sequencia", susp.sequencia ? `d.${bk(susp.sequencia)}` : null),
    sel("dataVenda", at.dataVenda ? `a.${bk(at.dataVenda)}` : null),
    sel("tipoDocumento", at.tipoDocumento ? `a.${bk(at.tipoDocumento)}` : null),
    sel("serie", at.serie ? `a.${bk(at.serie)}` : null),
    sel("numero", at.numero ? `a.${bk(at.numero)}` : null),
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
    `  FROM [dbo].[${susp.tabela}] d`,
    `  JOIN [dbo].[Atendimento] a ON a.[Atendimento ID] = d.${fk}`,
    `  LEFT JOIN [dbo].[Stocks] s ON s.CodigoID = d.${bk(susp.codigoId)}`,
    " WHERE a.[Fim Venda] = 'S'",
    `   AND a.[Data Venda] >= @from AND a.[Data Venda] < @to`,
    `   AND d.${pk} > @lastId`,
    ` ORDER BY d.${pk}`,
  ].join("\n");
  return { estado: "PRONTA", sql };
}

/** Resumo legível do que a descoberta encontrou, para o log da corrida. */
export function resumoSchema(susp: SchemaFonteSusp, at: SchemaAtendimento): string[] {
  const linhas: string[] = [];
  linhas.push(
    `  Atendimento: serie=${at.serie ?? "-"} numero=${at.numero ?? "-"} ` +
      `tipoDoc=${at.tipoDocumento ?? "-"} fimVenda=${at.fimVenda ?? "-"}`,
  );
  if (!susp.existe) {
    linhas.push(`  [${TABELA_SUSP}]: NAO EXISTE nesta instalacao — fonte VSG inactiva`);
    return linhas;
  }
  const faltam = (
    [
      ["pk", susp.pk],
      ["atendimentoFk", susp.atendimentoFk],
      ["codigoId", susp.codigoId],
      ["quantidade", susp.quantidade],
      ["pvpUnitario", susp.pvpUnitario],
      ["valorLinha", susp.valorLinha],
    ] as const
  )
    .filter(([, v]) => !v)
    .map(([k]) => k);
  linhas.push(
    `  [${TABELA_SUSP}]: pk=${susp.pk ?? "-"} fk=${susp.atendimentoFk ?? "-"} ` +
      `codigo=${susp.codigoId ?? "-"} qtd=${susp.quantidade ?? "-"}`,
  );
  if (faltam.length > 0) {
    linhas.push(`  ATENCAO colunas por resolver: ${faltam.join(", ")}`);
  }
  return linhas;
}
