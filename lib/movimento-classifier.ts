/**
 * lib/movimento-classifier.ts
 *
 * Classificador puro `(motivoText, tipoDocId, qtd, fkPattern) → TipoMovimentoArtigo`.
 * Sem deps de Prisma, sem I/O — usado quer pelo endpoint server-side
 * (`/api/ingest/v1/movimentos`) quer pelo agent local (re-classificação
 * em dry-run sem round-trip ao SaaS).
 *
 * Especificação derivada da auditoria rev32 (Segurado 2 079 454 +
 * Silveirense 1 116 410 StocksMov rows, 24 m). O `MovStocksCabMotivoID`
 * é LOCAL ao tenant (Segurado 1..30 ≠ Silveirense 0..65 com a MESMA
 * semântica) — por isso o mapeamento canónico é por TEXTO NORMALIZADO,
 * não por ID.
 *
 * Pipeline de decisão:
 *   1. FK pattern (qual das 6 colunas StocksMov FK populadas) → "macro" tipo
 *      VENDA_OR_DEV_CLIENTE / COMPRA / VENDA_CREDITO / RESERVA_SUSPENSA /
 *      DEVOLUCAO_FORNECEDOR / MOV_INTERNO
 *   2. Sub-classificação:
 *      a) VENDA_OR_DEV_CLIENTE: split por Atendimento.[Tipo Documento ID]
 *         7|2 → VENDA, 104|27 → DEVOLUCAO_CLIENTE, outro → VENDA
 *      b) MOV_INTERNO: regex sobre `motivoTexto` normalizado;
 *         fallback por Cab.[Tipo Documento ID];
 *         último recurso → DESCONHECIDO
 *
 * Cobertura mínima alvo: DESCONHECIDO < 1 % numa janela 24 m.
 */

/**
 * União 1:1 com o enum Prisma `TipoMovimentoArtigo`. Definido localmente
 * (sem `import type` ao Prisma) porque este módulo é partilhado com o
 * agent local — que não tem o cliente Prisma gerado disponível. O
 * endpoint server-side faz `as TipoMovimentoArtigo` (do Prisma) no
 * boundary; runtime string match garante igualdade.
 */
export type TipoMovimentoArtigo =
  | "VENDA"
  | "DEVOLUCAO_CLIENTE"
  | "VENDA_CREDITO"
  | "RESERVA_SUSPENSA"
  | "COMPRA"
  | "DEVOLUCAO_FORNECEDOR"
  | "INVENTARIO"
  | "AJUSTE"
  | "QUEBRA"
  | "PERDA"
  | "TRANSFERENCIA_ENTRADA"
  | "TRANSFERENCIA_SAIDA"
  | "DESCONHECIDO";

/** Snapshot do estado de FK columns numa linha StocksMov. */
export type FkPattern = {
  detalheId: number | null;
  suspDetalheId: number | null;
  creditoDetalheId: number | null;
  recpDetalheId: number | null;
  devolucaoDetalheId: number | null;
  movStocksDetId: number | null;
};

/**
 * Entrada do classificador. Tudo opcional excepto `fk` — funciona com
 * dados parciais (ex: linha StocksMov sem Atendimento JOIN ainda).
 */
export type ClassifyInput = {
  fk: FkPattern;
  /** Atendimento.[Tipo Documento ID] (7|104|27|2|null). */
  atendimentoTipoDocId?: number | null;
  /** dbo.tblMovStocksCab_Motivo.Motivo (texto livre operador). */
  motivoTexto?: string | null;
  /** dbo.tblMovStocksCab.[Tipo Documento ID] (14|25|28|29|...). */
  cabTipoDocId?: number | null;
  /** StocksMov.Qtd (assinado). Usado pelo fallback TipoDoc=28. */
  qtd?: number | null;
};

export type ClassifyResult = {
  tipo: TipoMovimentoArtigo;
  /** Descreve qual regra disparou — útil para debug + relatórios. */
  reason: string;
};

// ─────────────────────────────────────────────────────────────────────
// Normalização texto (lowercase + sem acentos + trim). Trabalha sobre
// o resultado para todas as comparações regex.
// ─────────────────────────────────────────────────────────────────────
function normalize(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/\s+/g, " ")
    .trim();
}

// ─────────────────────────────────────────────────────────────────────
// Regex de motivos. ORDEM IMPORTA — primeiro match ganha. Inventario
// vem antes de Ajuste porque "acerto ficha artigo" tem "acerto" mas é
// inventário; quebra vem antes de perda porque "quebra na rede de frio"
// e "validade expirada" são fisicamente quebra, não perda comercial.
// ─────────────────────────────────────────────────────────────────────

const RE_INVENTARIO = /inventari|acerto\s+ficha/;
const RE_QUEBRA =
  /prazo\s*(?:de\s+)?validade|validade\s+expirad|\bquebra\b|danific|destrui|defeito\s+de\s+qualidade|desvio\s+de\s+temperatura/;
const RE_PERDA =
  /valormed|uso\s+interno|auto\s*-?\s*consumo|pagamento\s+montra|nao\s+aceit|\blab\.?\s+(?:nao|fechou)|laboratorio\s+fechou|valormed-?\s*lab/;
const RE_AJUSTE =
  /\bacerto\b|\btroca\b|\bengano\b|\berro\b|\bbonus\b|codigo|entrada\s+(?:cx|unidade|stock)|saida\s+(?:cx|unidade|stock)|encomenda\s+antiga|encomenda(?:\s+nao)?\s+dado\s+entrada|\breserva|\bsaldo\b|passagem|estat\.?\s*ven/;

/** Motivos que são puramente numéricos (ex: "6840769") → ajuste. */
const RE_NUMERIC_ONLY = /^\d{2,}$/;
/** Motivo "V" sozinho (Segurado motivoId=8) — ajuste defensivo. */
const RE_SINGLE_CHAR = /^[a-z]$/;

// ─────────────────────────────────────────────────────────────────────
// Fallback por Cab.[Tipo Documento ID]. Valores observados nos 2
// tenants (rev32): 14 Passagem de Saldos, 25 Inventário, 28 Acréscimos,
// 29 Perdas, 43-49 Transferências Robô/Farm, 52-54 Sincr, 55 Robô.
// ─────────────────────────────────────────────────────────────────────
function fromCabTipoDoc(
  cabTipoDocId: number | null | undefined,
  qtd: number | null | undefined,
): TipoMovimentoArtigo | null {
  if (cabTipoDocId == null) return null;
  switch (cabTipoDocId) {
    case 14: // Passagem de Saldos
      return "AJUSTE";
    case 25: // Inventário
      return "INVENTARIO";
    case 28: // Acréscimos — sinal decide
      return qtd != null && qtd < 0 ? "PERDA" : "AJUSTE";
    case 29: // Perdas
      return "QUEBRA";
    case 43:
    case 45:
    case 47:
    case 49:
    case 53:
      return "TRANSFERENCIA_SAIDA";
    case 44:
    case 46:
    case 48:
    case 52:
    case 54:
      return "TRANSFERENCIA_ENTRADA";
    case 55: // Acerto pelo Robô
      return "AJUSTE";
    default:
      return null;
  }
}

/**
 * Sub-classifica um movimento interno (MovStocksDetID populado).
 * Devolve `null` se nem motivo nem TipoDoc deram match — o caller
 * promove a DESCONHECIDO.
 */
function classifyMovInterno(input: ClassifyInput): {
  tipo: TipoMovimentoArtigo;
  reason: string;
} | null {
  const norm = normalize(input.motivoTexto);

  // 1. Match por texto normalizado (ORDEM IMPORTA)
  if (norm) {
    if (RE_INVENTARIO.test(norm)) {
      return { tipo: "INVENTARIO", reason: `motivo-text:inventario("${norm}")` };
    }
    if (RE_QUEBRA.test(norm)) {
      return { tipo: "QUEBRA", reason: `motivo-text:quebra("${norm}")` };
    }
    if (RE_PERDA.test(norm)) {
      return { tipo: "PERDA", reason: `motivo-text:perda("${norm}")` };
    }
    if (RE_AJUSTE.test(norm)) {
      return { tipo: "AJUSTE", reason: `motivo-text:ajuste("${norm}")` };
    }
    if (RE_NUMERIC_ONLY.test(norm) || RE_SINGLE_CHAR.test(norm)) {
      return { tipo: "AJUSTE", reason: `motivo-text:opaque("${norm}")` };
    }
  }

  // 2. Fallback por Cab.[Tipo Documento ID]
  const byTipoDoc = fromCabTipoDoc(input.cabTipoDocId, input.qtd);
  if (byTipoDoc) {
    return {
      tipo: byTipoDoc,
      reason: `cab-tipodoc:${input.cabTipoDocId}${input.qtd != null ? `,qtd=${input.qtd}` : ""}`,
    };
  }

  // 3. Sem informação suficiente — caller promove a DESCONHECIDO.
  return null;
}

/**
 * Função principal. Cada StocksMov classificada exactamente uma vez.
 */
export function classifyMovimento(input: ClassifyInput): ClassifyResult {
  const fk = input.fk;

  // ── Origem por FK populada (rev32 audit; ordem por seletividade) ─
  if (fk.detalheId != null) {
    // VENDA ou DEVOLUCAO_CLIENTE — sub-classifica por Atendimento.TipoDoc.
    const td = input.atendimentoTipoDocId;
    if (td === 104 || td === 27) {
      return { tipo: "DEVOLUCAO_CLIENTE", reason: `fk:detalhe+atTipoDoc=${td}` };
    }
    // Default = VENDA. Inclui 7, 2, null e qualquer outro inesperado:
    // ERPS legacy podem deixar Atendimento orfão em poucos casos; assumir
    // VENDA é o pressuposto seguro porque vem da FK [Detalhe ID] que é
    // exclusiva de Atendimento Detalhe.
    return { tipo: "VENDA", reason: `fk:detalhe+atTipoDoc=${td ?? "null"}` };
  }

  if (fk.recpDetalheId != null) {
    return { tipo: "COMPRA", reason: "fk:recpDetalhe" };
  }

  if (fk.devolucaoDetalheId != null) {
    return { tipo: "DEVOLUCAO_FORNECEDOR", reason: "fk:devolucaoDetalhe" };
  }

  if (fk.creditoDetalheId != null) {
    return { tipo: "VENDA_CREDITO", reason: "fk:creditoDetalhe" };
  }

  if (fk.suspDetalheId != null) {
    return { tipo: "RESERVA_SUSPENSA", reason: "fk:suspDetalhe" };
  }

  if (fk.movStocksDetId != null) {
    const r = classifyMovInterno(input);
    if (r) return r;
    return {
      tipo: "DESCONHECIDO",
      reason: `mov-interno-no-match (motivoId=?, cabTipoDoc=${input.cabTipoDocId ?? "null"})`,
    };
  }

  // Nenhuma FK populada — anomalia. Acontece em <0,01 % das linhas
  // (rev32 mostra zero em ambos os tenants nos últimos 24 m).
  return { tipo: "DESCONHECIDO", reason: "no-fk-populated" };
}

/**
 * Helper conveniente para o classificador trabalhar directamente sobre
 * um payload bruto vindo do SQL agent (snake-case quirky preservado).
 */
export type RawStocksMovLine = {
  detalheId: number | null;
  suspDetalheId: number | null;
  creditoDetalheId: number | null;
  recpDetalheId: number | null;
  devolucaoDetalheId: number | null;
  movStocksDetId: number | null;
  atendimentoTipoDocId: number | null;
  motivoTexto: string | null;
  cabTipoDocId: number | null;
  qtd: number;
};

export function classifyRaw(row: RawStocksMovLine): ClassifyResult {
  return classifyMovimento({
    fk: {
      detalheId: row.detalheId,
      suspDetalheId: row.suspDetalheId,
      creditoDetalheId: row.creditoDetalheId,
      recpDetalheId: row.recpDetalheId,
      devolucaoDetalheId: row.devolucaoDetalheId,
      movStocksDetId: row.movStocksDetId,
    },
    atendimentoTipoDocId: row.atendimentoTipoDocId,
    motivoTexto: row.motivoTexto,
    cabTipoDocId: row.cabTipoDocId,
    qtd: row.qtd,
  });
}
