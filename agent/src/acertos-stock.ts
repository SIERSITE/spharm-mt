/**
 * agent/src/acertos-stock.ts
 *
 * O âmbito "acerto de stock", em duas linguagens que têm de concordar.
 *
 * Um acerto de stock é um movimento cuja origem no ERP é MOV_INTERNO:
 * `StocksMov.MovStocksDetID` populado e NENHUMA das outras cinco FKs.
 * A segunda metade dessa frase não é zelo — é o âmbito. O
 * `classifyMovimento` avalia as FKs por ORDEM: uma linha com
 * `[Detalhe ID]` E `MovStocksDetID` é VENDA, porque `[Detalhe ID]`
 * ganha. Um filtro SQL escrito como `MovStocksDetID IS NOT NULL` sozinho
 * apanharia essa linha e o pipeline de acertos passaria a contar vendas
 * — exactamente a duplicação que este âmbito exclui.
 *
 * Por isso a regra existe aqui duas vezes:
 *
 *   `ehAcertoStock(fk)`      TypeScript, aplicada às amostras
 *   `WHERE_ACERTO_STOCK`     SQL, aplicada à janela inteira
 *
 * Escrever a mesma regra duas vezes é uma dívida, e é paga por
 * `verificarAmostra()`: cada linha que o SQL devolve é re-classificada
 * pelo classificador canónico, e o dry-run falha alto se alguma não for
 * um tipo interno. Se as duas versões divergirem, vê-se na farmácia
 * antes de qualquer escrita — não meses depois num relatório.
 *
 * O que este módulo NÃO faz: taxonomia. A decisão funcional é que todos
 * os MOV_INTERNO são uma única operação — ACERTO_STOCK. O motivo do ERP
 * ("Acerto Ficha Artigo", "ValorMed", "prazo de validade") é preservado
 * como metadado de rastreabilidade e não decide nada.
 */

import { ACERTO_STOCK, classifyMovimento, type FkPattern } from "./movimento-classifier.js";

export { ACERTO_STOCK };

/**
 * O que o classificador canónico produz a partir de MOV_INTERNO.
 *
 * Desde rev60 é um único valor. Antes eram seis, inferidos do texto do
 * motivo, e esta lista tinha de incluir DESCONHECIDO para os movimentos
 * cujo motivo não era legível. Deixou de ser preciso: a origem decide
 * sozinha, e um motivo ilegível já não degrada nada.
 */
export const TIPOS_INTERNOS: ReadonlySet<string> = new Set([ACERTO_STOCK]);

/**
 * Predicado de âmbito. Verdadeiro só quando a origem é inequivocamente
 * MOV_INTERNO — a FK interna populada e as cinco transaccionais vazias.
 */
export function ehAcertoStock(fk: FkPattern): boolean {
  return (
    fk.movStocksDetId != null &&
    fk.detalheId == null &&
    fk.suspDetalheId == null &&
    fk.creditoDetalheId == null &&
    fk.recpDetalheId == null &&
    fk.devolucaoDetalheId == null
  );
}

/**
 * Nomes EXACTOS das colunas FK em `dbo.StocksMov`, confirmados na
 * auditoria rev34 e usados tal e qual em `commands/stocksmov.ts`.
 * `[Detalhe  Recp ID]` tem DOIS espaços — é um quirk do schema Softreis,
 * não um erro de escrita.
 */
export const COLUNAS_FK = {
  detalheId: "[Detalhe ID]",
  suspDetalheId: "[Atendimento Susp Detalhe ID]",
  creditoDetalheId: "[Atendimento Credito Detalhe ID]",
  recpDetalheId: "[Detalhe  Recp ID]",
  devolucaoDetalheId: "[Devolucao Detalhe ID]",
  movStocksDetId: "MovStocksDetID",
} as const;

/**
 * A mesma regra de `ehAcertoStock`, em SQL. `alias` é o alias da
 * StocksMov na query (normalmente `sm`).
 */
export function whereAcertoStock(alias = "sm"): string {
  return [
    `${alias}.${COLUNAS_FK.movStocksDetId} IS NOT NULL`,
    `AND ${alias}.${COLUNAS_FK.detalheId} IS NULL`,
    `AND ${alias}.${COLUNAS_FK.suspDetalheId} IS NULL`,
    `AND ${alias}.${COLUNAS_FK.creditoDetalheId} IS NULL`,
    `AND ${alias}.${COLUNAS_FK.recpDetalheId} IS NULL`,
    `AND ${alias}.${COLUNAS_FK.devolucaoDetalheId} IS NULL`,
  ].join("\n    ");
}

// ── Verificação SQL ↔ classificador ────────────────────────────────

/** Linha de amostra, com o que basta para re-classificar. */
export type LinhaAmostra = {
  externalMovId: number;
  fk: FkPattern;
  motivoTexto: string | null;
  cabTipoDocId: number | null;
  qtd: number;
};

export type Divergencia = {
  externalMovId: number;
  /** O que o classificador canónico diz que esta linha é. */
  tipo: string;
  reason: string;
};

/**
 * Re-classifica cada amostra e devolve as que NÃO são internas.
 *
 * Uma lista vazia é a prova de que o filtro SQL e o classificador
 * concordam sobre o âmbito. Uma lista não-vazia é motivo para parar:
 * significa que o pipeline de acertos está a ver linhas que pertencem
 * a vendas, compras ou devoluções.
 */
export function verificarAmostra(linhas: readonly LinhaAmostra[]): Divergencia[] {
  const fora: Divergencia[] = [];
  for (const l of linhas) {
    const cls = classifyMovimento({
      fk: l.fk,
      motivoTexto: l.motivoTexto,
      cabTipoDocId: l.cabTipoDocId,
      qtd: l.qtd,
    });
    if (!TIPOS_INTERNOS.has(cls.tipo) || !ehAcertoStock(l.fk)) {
      fora.push({ externalMovId: l.externalMovId, tipo: cls.tipo, reason: cls.reason });
    }
  }
  return fora;
}

// ── Veredictos sobre os totais ─────────────────────────────────────

/** Totais que a query de agregação devolve, já normalizados. */
export type Totais = {
  total: number;
  totalDistinto: number;
  positivos: number;
  negativos: number;
  zeros: number;
  /** Linhas cuja FK interna está populada mas outra FK também está. */
  ambiguas: number;
  semCodigoProduto: number;
  semFichaStocks: number;
  semCabecalho: number;
};

export type Veredicto = {
  /** `true` só quando nada bloqueia o avanço. */
  ok: boolean;
  /** Uma linha por conclusão, já formatada para o operador. */
  linhas: string[];
};

/**
 * Traduz os totais em conclusões explícitas, em vez de deixar o
 * operador interpretar números crus.
 *
 * A chave de idempotência proposta é `StocksMovID`, a PK de
 * `dbo.StocksMov`. `total > totalDistinto` seria a refutação directa
 * dessa proposta — e por isso é a única condição que sozinha reprova o
 * dry-run. Órfãos de catálogo e linhas sem cabeçalho são reportados
 * porque contam para a decisão, mas não são impedimento: o canónico já
 * guarda `produtoId` nulo para o produto que ainda não existe.
 */
export function avaliarTotais(t: Totais): Veredicto {
  const linhas: string[] = [];
  let ok = true;

  if (t.total === 0) {
    return {
      ok: false,
      linhas: ["Zero acertos na janela — nada a validar. Confirmar o intervalo."],
    };
  }

  if (t.total === t.totalDistinto) {
    linhas.push(
      `Chave StocksMovID: ${t.total} linhas, ${t.totalDistinto} valores distintos — ` +
        `sem duplicados. A chave é estável e serve para idempotência.`,
    );
  } else {
    ok = false;
    linhas.push(
      `StocksMovID REPETIDO: ${t.total} linhas para ${t.totalDistinto} valores. ` +
        `A chave proposta não identifica o movimento — parar aqui.`,
    );
  }

  if (t.ambiguas === 0) {
    linhas.push(
      `Âmbito limpo: nenhuma linha interna tem também FK de venda, compra, ` +
        `devolução ou reserva. Não há sobreposição com os pipelines existentes.`,
    );
  } else {
    linhas.push(
      `${t.ambiguas} linha(s) têm MovStocksDetID E outra FK transaccional. ` +
        `Ficam FORA deste âmbito (pertencem ao pipeline da outra FK) — ` +
        `contadas aqui só para não desaparecerem em silêncio.`,
    );
  }

  const semProduto = t.semCodigoProduto + t.semFichaStocks;
  if (semProduto > 0) {
    const pct = ((semProduto / t.total) * 100).toFixed(2);
    linhas.push(
      `${semProduto} movimento(s) (${pct}%) sem produto resolvido no ERP: ` +
        `${t.semCodigoProduto} sem CodigoID, ${t.semFichaStocks} com CodigoID ` +
        `ausente de dbo.Stocks. Entram como órfãos (produtoId nulo), não se perdem.`,
    );
  } else {
    linhas.push(`Todos os movimentos têm produto resolvido em dbo.Stocks.`);
  }

  if (t.semCabecalho > 0) {
    const pct = ((t.semCabecalho / t.total) * 100).toFixed(2);
    linhas.push(
      `${t.semCabecalho} movimento(s) (${pct}%) sem cabeçalho tblMovStocksCab. ` +
        `Ficam sem motivo ERP — o acerto conta na mesma, o metadado é que falta.`,
    );
  }

  const somaSinais = t.positivos + t.negativos + t.zeros;
  if (somaSinais !== t.total) {
    ok = false;
    linhas.push(
      `Contagem por sinal (${somaSinais}) não fecha com o total (${t.total}) — ` +
        `há Qtd NULL. Investigar antes de avançar.`,
    );
  }

  return { ok, linhas };
}
