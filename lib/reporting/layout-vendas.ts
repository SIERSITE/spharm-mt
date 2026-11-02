/**
 * lib/reporting/layout-vendas.ts
 *
 * Liga o `Report` do Mapa de Vendas à regra de largura A4 (layout-largura.ts): extrai dos DADOS do relatório (o que a tabela
 * vai mesmo desenhar) os textos de cada coluna, calcula a capacidade do A4 horizontal e aplica as larguras. É a MESMA função que
 * o adapter, o servidor (PDF, email) e a UI usam, por isso a decisão «cabe / não cabe» nunca diverge entre pré-visualização,
 * impressão, PDF e email. Puro (sem DOM, sem I/O) e seguro no browser.
 */
import type { Report, ReportColumn, ReportRow } from "./report-types";
import { ehLinhaSubtotal, linhasDeDetalhe } from "./report-types";
import { formatCell } from "./report-formatters";
import { aplicarPrivacidade } from "./privacidade";
import { capacidadeA4, type CapacidadeA4, type TextosDasColunas } from "./layout-largura";

/** Chaves das colunas do Mapa de Vendas (adapters/vendas.ts). */
export const CHAVE = {
  codigo: "codigo",
  descricao: "descricao",
  farmacia: "farmacia",
  pvp: "pvp",
  custoUnitario: "custoUnitarioEstimado",
  totalUnid: "totalVendas",
  stock: "existencia",
} as const;

/** Erro lançado pelos geradores de PDF quando o período não cabe numa página A4 legível (a API traduz em HTTP 422). */
export class RelatorioNaoCabeA4Error extends Error {
  readonly capacidade: CapacidadeA4;
  constructor(capacidade: CapacidadeA4) {
    super(capacidade.mensagem ?? "O relatório não cabe numa página A4 legível.");
    this.name = "RelatorioNaoCabeA4Error";
    this.capacidade = capacidade;
  }
}

/** As colunas desenhadas em HTML/PDF/print (as `excelOnly` e as `hidden` não contam). */
export function colunasVisiveis(report: Pick<Report, "columns">): ReportColumn[] {
  return report.columns.filter((c) => !c.hidden && !c.excelOnly);
}

function texto(row: ReportRow, c: ReportColumn): string {
  const bruto = c.displayKey ? row[c.displayKey] : row[c.key];
  return formatCell(bruto as never, c.format);
}

/** Textos (já formatados, como a tabela os desenha) de cada coluna do relatório, para medir as larguras. */
export function textosDoRelatorio(report: Pick<Report, "columns" | "rows">): { nMeses: number; textos: TextosDasColunas } {
  const cols = colunasVisiveis(report);
  const porChave = (k: string) => cols.find((c) => c.key === k);
  const meses = cols.filter((c) => c.monthAlt);
  const detalhe = linhasDeDetalhe(report.rows);
  const doCampo = (c: ReportColumn | undefined, incluirSubtotal = true): string[] => {
    if (!c) return [];
    const out: string[] = [];
    for (const r of report.rows) {
      if (!incluirSubtotal && ehLinhaSubtotal(r)) continue;
      out.push(texto(r, c));
    }
    // TOTAL GERAL (soma do detalhe) — também tem de caber
    if (c.showTotal) {
      let soma = 0;
      for (const r of detalhe) { const v = r[c.key]; if (typeof v === "number" && Number.isFinite(v)) soma += v; }
      out.push(formatCell(soma, c.format));
    }
    return out;
  };
  return {
    nMeses: meses.length,
    textos: {
      codigo: doCampo(porChave(CHAVE.codigo)),
      farmacia: doCampo(porChave(CHAVE.farmacia)),
      // PVP e custo unitário não se desenham no TOTAL ARTIGO (célula vazia)
      pvp: doCampo(porChave(CHAVE.pvp), false),
      custoUnitario: doCampo(porChave(CHAVE.custoUnitario), false),
      totalUnid: doCampo(porChave(CHAVE.totalUnid)),
      stock: doCampo(porChave(CHAVE.stock)),
      mes: meses.flatMap((c) => doCampo(c)),
      rotulosMes: meses.map((c) => c.htmlLabel ?? c.label),
    },
  };
}

/** Capacidade do A4 horizontal para ESTE relatório (já com a privacidade aplicada: sem preços de venda/compra não há essas colunas). */
export function capacidadeDoRelatorio(entrada: Report): CapacidadeA4 {
  const report = aplicarPrivacidade(entrada);
  const cols = colunasVisiveis(report);
  const { nMeses, textos } = textosDoRelatorio(report);
  return capacidadeA4(
    { nMeses, textos },
    { incluirVenda: cols.some((c) => c.key === CHAVE.pvp), incluirCompra: cols.some((c) => c.key === CHAVE.custoUnitario) },
  );
}

/** `true` = este relatório exige legibilidade A4 e as colunas NÃO cabem: não se gera PDF/impressão/pré-visualização. */
export function bloqueadoPorA4(report: Report): CapacidadeA4 | null {
  if (report.meta?.legibilidadeA4 !== true) return null;
  const cap = capacidadeDoRelatorio(report);
  return cap.cabe ? null : cap;
}

/** Aplica as larguras (% da tabela) da capacidade às colunas visíveis. Devolve novas colunas (não muta). */
export function comLarguras(columns: ReportColumn[], cap: CapacidadeA4): ReportColumn[] {
  const w = cap.pct;
  const larguraDe = (c: ReportColumn): number | undefined => {
    if (c.monthAlt) return w.mes;
    switch (c.key) {
      case CHAVE.codigo: return w.codigo;
      case CHAVE.descricao: return w.descricao;
      case CHAVE.farmacia: return w.farmacia;
      case CHAVE.pvp: return w.pvp;
      case CHAVE.custoUnitario: return w.custoUnitario;
      case CHAVE.totalUnid: return w.totalUnid;
      case CHAVE.stock: return w.stock;
      default: return c.width;
    }
  };
  return columns.map((c) => (c.excelOnly ? c : { ...c, width: larguraDe(c) }));
}
