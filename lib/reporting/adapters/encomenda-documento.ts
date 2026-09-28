/**
 * lib/reporting/adapters/encomenda-documento.ts
 *
 * Documento formal de UMA (ou várias) `ListaEncomenda` já finalizada(s) —
 * "Nota de Encomenda", para Imprimir/PDF/Email logo depois de finalizar
 * (ver componentes/encomendas/order-create-client.tsx). Reutiliza 100% da
 * infra genérica de `Report` (`report-html.ts`/`report-pdf-server.ts`/
 * `report-email.ts`) — a mesma linguagem visual dos restantes relatórios.
 *
 * Uma única `OrderDetail`: documento simples, sem agrupamento. Várias
 * (a acção "Imprimir todas"/"PDF todas" de um lote gerado em modo grupo
 * ou consolidação): um documento por lista, cada uma um GRUPO visual
 * (mesmo mecanismo `GROUP_KEY`/`spanGroup` que o Relatório de Vendas usa
 * para "um artigo, várias farmácias" — aqui invertido: "uma farmácia,
 * várias linhas") com uma linha TOTAL por farmácia e o TOTAL GERAL do
 * linha final ("TOTAL GERAL") a somar o lote inteiro.
 *
 * Nunca inventa dados: tudo o que aparece vem de `OrderDetail`
 * (`lib/encomendas/order-detail.ts`) — nenhum campo novo é calculado
 * aqui além de somas simples (linhas/unidades).
 */
import type { OrderDetail } from "@/lib/encomendas/order-detail";
import type { Report, ReportColumn, ReportRow, ReportSummaryItem } from "../report-types";
import { ROW_KIND_KEY, GROUP_KEY } from "../report-types";
import { normalizarLargura } from "../column-widths";

const BASE_WIDTHS = {
  farmacia: 16, cnp: 10, produto: 32, fabricante: 16, fornecedor: 16,
  sugerida: 10, quantidade: 10, notas: 20,
};

function columns(multi: boolean): ReportColumn[] {
  const w = normalizarLargura(BASE_WIDTHS);
  const cols: ReportColumn[] = [];
  if (multi) {
    cols.push({ key: "farmacia", label: "Farmácia", format: "text", width: w.farmacia, spanGroup: true });
  }
  cols.push(
    { key: "cnp", label: "CNP", format: "text", width: multi ? w.cnp : w.cnp * 1.2 },
    { key: "produto", label: "Produto", format: "text", width: multi ? w.produto : w.produto * 1.2 },
    { key: "fabricante", label: "Fabricante", format: "text", width: w.fabricante },
    { key: "fornecedor", label: "Fornecedor", format: "text", width: w.fornecedor },
    { key: "sugerida", label: "Qtd. sugerida", format: "integer", align: "right", width: w.sugerida },
    { key: "quantidade", label: "Quantidade", format: "integer", align: "right", width: w.quantidade, showTotal: true },
    { key: "notas", label: "Notas", format: "text", width: w.notas },
  );
  return cols;
}

function buildSummary(details: readonly OrderDetail[]): ReportSummaryItem[] {
  const totalLinhas = details.reduce((s, d) => s + d.linhas.length, 0);
  const totalUnidades = details.reduce(
    (s, d) => s + d.linhas.reduce((s2, l) => s2 + (l.quantidadeAjustada ?? 0), 0),
    0
  );
  const items: ReportSummaryItem[] = [
    { label: "Encomendas", value: details.length, format: "integer" },
    { label: "Linhas", value: totalLinhas, format: "integer" },
    { label: "Unidades", value: totalUnidades, format: "integer" },
  ];
  return items;
}

/**
 * `details.length === 1` → documento simples (uma farmácia, sem grupo).
 * `details.length > 1`   → um documento por farmácia, com TOTAL por
 * farmácia e TOTAL GERAL — para a acção "Imprimir/PDF/Email todas".
 */
export function buildEncomendaDocumentoReport(details: readonly OrderDetail[]): Report {
  const multi = details.length > 1;
  const rows: ReportRow[] = [];
  for (const d of details) {
    for (const l of d.linhas) {
      rows.push({
        [GROUP_KEY]: d.id,
        farmacia: d.farmaciaNome,
        cnp: String(l.cnp),
        produto: l.designacao,
        fabricante: l.fabricante ?? "—",
        fornecedor: l.fornecedor ?? "—",
        sugerida: l.quantidadeSugerida ?? 0,
        quantidade: l.quantidadeAjustada ?? 0,
        notas: l.notas ?? "",
      });
    }
    if (multi && d.linhas.length > 1) {
      const totalUnid = d.linhas.reduce((s, l) => s + (l.quantidadeAjustada ?? 0), 0);
      rows.push({
        [GROUP_KEY]: d.id,
        [ROW_KIND_KEY]: "subtotal",
        farmacia: d.farmaciaNome,
        cnp: "",
        produto: `TOTAL ${d.farmaciaNome}`,
        fabricante: "",
        fornecedor: "",
        sugerida: "",
        quantidade: totalUnid,
        notas: "",
      });
    }
  }

  const primeira = details[0];
  return {
    title: multi ? "Notas de Encomenda" : `Nota de Encomenda — ${primeira?.farmaciaNome ?? ""}`,
    subtitle: multi
      ? `${details.length} encomenda(s) finalizada(s)`
      : `${primeira?.nome ?? ""} · criada por ${primeira?.criadoPorNome ?? "—"}`,
    generatedAt: new Date(),
    summary: buildSummary(details),
    columns: columns(multi),
    rows,
    meta: {
      slug: multi ? "notas-encomenda" : `nota-encomenda-${primeira?.farmaciaNome ?? ""}`,
      orientation: "portrait",
      organization: "SPharm.MT",
      density: "compact",
      footer: "SPharm.MT · Documento gerado a partir da encomenda finalizada — uso interno",
    },
  };
}
