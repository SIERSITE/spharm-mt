/**
 * agent/src/movimento-classifier.ts
 *
 * CÓPIA EXACTA de `lib/movimento-classifier.ts`. Existe para evitar o
 * cross-tree import (`agent/tsconfig.json` define `rootDir: "src"`,
 * proibindo imports a `lib/`). O esbuild bundle do agent inclui esta
 * cópia; o endpoint server-side usa a do `lib/`.
 *
 * MANTER EM SINCRONIA com `lib/movimento-classifier.ts`. Os testes
 * (`scripts/test-movimento-classifier.ts`) leem APENAS a versão `lib/`
 * — se divergirem, o agent envia tipos diferentes do que o endpoint
 * espera (que re-classifica defensivamente como safety net, mas
 * regista a discrepância nos logs).
 *
 * Classificador puro `(fkPattern, tipoDocId) → TipoMovimentoArtigo`.
 * Sem deps de Prisma, sem I/O — usado quer pelo endpoint server-side
 * (`/api/ingest/v1/movimentos`) quer pelo agent local (re-classificação
 * em dry-run sem round-trip ao SaaS).
 *
 * Especificação derivada da auditoria rev32 (Segurado 2 079 454 +
 * Silveirense 1 116 410 StocksMov rows, 24 m).
 *
 * Pipeline de decisão — só a ORIGEM decide:
 *   1. FK pattern (qual das 6 colunas StocksMov FK populadas):
 *      [Detalhe ID]                     → VENDA / DEVOLUCAO_CLIENTE
 *      [Detalhe  Recp ID]               → COMPRA
 *      [Devolucao Detalhe ID]           → DEVOLUCAO_FORNECEDOR
 *      [Atendimento Credito Detalhe ID] → VENDA_CREDITO
 *      [Atendimento Susp Detalhe ID]    → RESERVA_SUSPENSA
 *      MovStocksDetID                   → ACERTO_STOCK
 *      nenhuma                          → DESCONHECIDO
 *   2. Única sub-classificação que resta: VENDA vs DEVOLUCAO_CLIENTE,
 *      por Atendimento.[Tipo Documento ID] (104|27 → devolução).
 *
 * ── Porque é que MOV_INTERNO deixou de ter sub-tipos ──────────────
 *
 * Até rev59 esta função inferia INVENTARIO / AJUSTE / QUEBRA / PERDA /
 * TRANSFERENCIA_ENTRADA / TRANSFERENCIA_SAIDA a partir do TEXTO do
 * motivo e do `cab.[Tipo Documento ID]`. Duas coisas erradas nisso:
 *
 *   · O texto é escrito pelo operador da farmácia e o ID é LOCAL ao
 *     tenant (Segurado 1..30 ≠ Silveirense 0..65 com a mesma
 *     semântica). Uma regex sobre esse texto é uma inferência, e ficava
 *     gravada numa coluna que parecia um facto.
 *   · As transferências inferidas por `[Tipo Documento ID]` 43-54 eram
 *     o caso mais grave: transferência real é um fluxo documental
 *     próprio (Guia de Transferência), com contraparte e documento. Um
 *     movimento interno classificado como TRANSFERENCIA não tinha
 *     nenhuma das duas coisas — dizia mais do que sabia.
 *
 * Decisão funcional (rev60): todo o MOV_INTERNO é uma única operação,
 * ACERTO_STOCK. `movStocksCabMotivoId` e `movStocksCabMotivoTexto`
 * continuam gravados na linha, como METADADO de rastreabilidade — quem
 * quiser saber porque é que o acerto aconteceu lê o motivo do ERP, que
 * é a fonte, em vez de ler uma categoria que nós inventámos a partir
 * dele.
 *
 * Consequência no gate de qualidade: DESCONHECIDO passa a significar
 * exclusivamente "nenhuma FK populada" — uma anomalia de schema, não um
 * motivo que não soubemos ler. O alvo <1 % continua a valer e ficou
 * mais exigente, porque deixou de haver um cesto onde varrer motivos
 * ilegíveis.
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
  | "ACERTO_STOCK"
  | "DESCONHECIDO"
  // ── Retirados em rev60, mantidos por causa do que já está gravado ──
  // Nenhum classificador os volta a produzir. Continuam no enum Prisma
  // e neste tipo porque as linhas ingeridas antes da migração de
  // recolha ainda os têm, e um leitor que os omitisse não compilaria
  // contra os dados reais. Removê-los daqui é seguro só depois de a
  // migração `movimento_interno_acerto_stock` ter corrido em TODOS os
  // tenants.
  | "INVENTARIO"
  | "AJUSTE"
  | "QUEBRA"
  | "PERDA"
  | "TRANSFERENCIA_ENTRADA"
  | "TRANSFERENCIA_SAIDA";

/**
 * A operação única dos movimentos internos. Exportada para que os
 * leitores não repitam o literal.
 */
export const ACERTO_STOCK = "ACERTO_STOCK" as const;

/**
 * Os tipos que rev60 retirou. Um leitor que precise de tratar linhas
 * históricas — gravadas antes da recolha — usa esta lista em vez de
 * enumerar strings à mão.
 */
export const TIPOS_INTERNOS_LEGADOS: readonly TipoMovimentoArtigo[] = [
  "INVENTARIO",
  "AJUSTE",
  "QUEBRA",
  "PERDA",
  "TRANSFERENCIA_ENTRADA",
  "TRANSFERENCIA_SAIDA",
];

/** `true` para ACERTO_STOCK e para qualquer um dos tipos que ele substituiu. */
export function ehAcertoStock(tipo: string): boolean {
  return tipo === ACERTO_STOCK || (TIPOS_INTERNOS_LEGADOS as readonly string[]).includes(tipo);
}

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
  /**
   * Atendimento.[Tipo Documento ID] (7|104|27|2|null). O ÚNICO campo
   * não-FK que ainda decide alguma coisa, e só entre VENDA e
   * DEVOLUCAO_CLIENTE — que partilham a mesma FK e por isso não podem
   * ser distinguidas pela origem.
   */
  atendimentoTipoDocId?: number | null;
  /**
   * @deprecated rev60 — aceite e IGNORADO.
   *
   * `motivoTexto` e `cabTipoDocId` alimentavam a sub-classificação dos
   * movimentos internos, que foi retirada. Continuam no tipo porque os
   * chamadores os passam e porque são gravados na linha como metadado;
   * mas nenhum deles entra numa decisão. Um chamador que os omita
   * obtém exactamente o mesmo resultado — e é isso que os testes
   * verificam.
   */
  motivoTexto?: string | null;
  /** @deprecated rev60 — aceite e ignorado. Ver `motivoTexto`. */
  cabTipoDocId?: number | null;
  /** @deprecated rev60 — aceite e ignorado. Ver `motivoTexto`. */
  qtd?: number | null;
};

export type ClassifyResult = {
  tipo: TipoMovimentoArtigo;
  /** Descreve qual regra disparou — útil para debug + relatórios. */
  reason: string;
};

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

  // Movimento interno. Sem sub-classificação: a origem já é a resposta.
  // Um motivo ilegível não degrada nada — o acerto continua a ser um
  // acerto, e o motivo do ERP fica gravado na linha para quem o quiser
  // ler.
  if (fk.movStocksDetId != null) {
    return { tipo: ACERTO_STOCK, reason: "fk:movStocksDet" };
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
