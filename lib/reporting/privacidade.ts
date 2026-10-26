/**
 * lib/reporting/privacidade.ts
 *
 * Retira de um `Report` a informação comercial sensível que o utilizador decidiu NÃO partilhar (preços de venda e/ou de compra),
 * para que um relatório possa seguir para um laboratório sem divulgar PVP, valor de vendas nem custos.
 *
 * Princípios:
 *  · Corre em TODOS os geradores de saída (`renderReportHtml`, `buildReportWorkbook`) e nas rotas de PDF/email — nunca depende só de
 *    esconder colunas no browser nem de CSS. Uma coluna retirada desaparece do relatório INTEIRO: cabeçalho, valores das linhas
 *    (inclusive `displayKey`/`noteKey`), totais e itens de resumo marcados com `sensivel`.
 *  · Falha-seguro: só uma classe estritamente `true` é mantida. Um payload adulterado ou incompleto retira o preço em vez de o
 *    divulgar.
 *  · Idempotente e sem efeitos: devolve um novo objeto, e o mesmo objeto se não houver nada a retirar.
 */
import type { Report, ReportColumn, ReportRow, ReportSummaryItem } from "./report-types";

export type Privacidade = {
  precosVenda: boolean;
  precosCompra: boolean;
  chavesVenda: string[];
  chavesCompra: string[];
};

function listaDeChaves(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Lê `meta.privacidade` de um payload não confiável: só `=== true` mantém a informação. */
export function lerPrivacidade(bruto: unknown): Privacidade | null {
  if (bruto === null || bruto === undefined || typeof bruto !== "object") return null;
  const o = bruto as Record<string, unknown>;
  return {
    precosVenda: o.precosVenda === true,
    precosCompra: o.precosCompra === true,
    chavesVenda: listaDeChaves(o.chavesVenda),
    chavesCompra: listaDeChaves(o.chavesCompra),
  };
}

function classeRetirada(sensivel: "venda" | "compra" | undefined, p: Privacidade): boolean {
  if (sensivel === "venda") return !p.precosVenda;
  if (sensivel === "compra") return !p.precosCompra;
  return false;
}

export function aplicarPrivacidade(report: Report): Report {
  const p = lerPrivacidade(report.meta?.privacidade);
  if (!p) return report;

  const retiradas = report.columns.filter((c) => classeRetirada(c.sensivel, p));
  const resumoSai = (s: ReportSummaryItem) => classeRetirada(s.sensivel, p);

  // Campos das linhas a retirar: os das colunas retiradas e os declarados da classe desligada (mesmo sem coluna).
  const chaves = new Set<string>();
  for (const c of retiradas) {
    chaves.add(c.key);
    if (c.displayKey) chaves.add(c.displayKey);
    if (c.noteKey) chaves.add(c.noteKey);
  }
  if (!p.precosVenda) for (const k of p.chavesVenda) chaves.add(k);
  if (!p.precosCompra) for (const k of p.chavesCompra) chaves.add(k);

  const linhasComChaves = chaves.size > 0 && report.rows.some((r) => Object.keys(r).some((k) => chaves.has(k)));
  const temResumoSensivel = (report.summary ?? []).some(resumoSai);
  if (retiradas.length === 0 && !temResumoSensivel && !linhasComChaves) return report;

  const retirar = new Set(retiradas);
  const columns: ReportColumn[] = report.columns.filter((c) => !retirar.has(c));
  const rows: ReportRow[] = report.rows.map((r) => {
    const nova: ReportRow = {};
    for (const k of Object.keys(r)) if (!chaves.has(k)) nova[k] = r[k];
    return nova;
  });
  const colunasRestantes = new Set(columns.map((c) => c.key));
  return {
    ...report,
    columns,
    rows,
    summary: report.summary?.filter((s) => !resumoSai(s)),
    meta: report.meta
      ? {
          ...report.meta,
          columnBlocks: report.meta.columnBlocks?.map((b) => ({ ...b, omitir: b.omitir.filter((k) => colunasRestantes.has(k)) })),
        }
      : report.meta,
  };
}

/** Texto para o diálogo de envio: que informação comercial os anexos vão incluir. */
export function descreverPrivacidade(report: Report): string[] | null {
  const p = lerPrivacidade(report.meta?.privacidade);
  if (!p) return null;
  return [`Preços de venda: ${p.precosVenda ? "incluídos" : "NÃO incluídos"}`, `Preços de compra (custos): ${p.precosCompra ? "incluídos" : "NÃO incluídos"}`];
}
