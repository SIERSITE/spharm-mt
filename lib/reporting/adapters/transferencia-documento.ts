/**
 * lib/reporting/adapters/transferencia-documento.ts
 *
 * "Guia de Transferência" — documento formal de UMA (ou várias)
 * `Transferencia` já geradas (ver order-create-client.tsx, Bloco D:
 * decisão TRANSFERIR em modo grupo). Mesmo mecanismo/infra de
 * `encomenda-documento.ts` — ver esse ficheiro para a explicação do
 * padrão "1 = documento simples, N = um grupo por transferência".
 */
import type { TransferenciaDetail } from "@/lib/transferencias/transferencia-detail";
import type { Report, ReportColumn, ReportRow, ReportSummaryItem } from "../report-types";
import { ROW_KIND_KEY, GROUP_KEY } from "../report-types";
import { normalizarLargura } from "../column-widths";

const BASE_WIDTHS = { rota: 22, cnp: 12, produto: 36, fabricante: 18, quantidade: 12, notas: 20 };

function columns(multi: boolean): ReportColumn[] {
  const w = normalizarLargura(BASE_WIDTHS);
  const cols: ReportColumn[] = [];
  if (multi) cols.push({ key: "rota", label: "Origem → Destino", format: "text", width: w.rota, spanGroup: true });
  cols.push(
    { key: "cnp", label: "CNP", format: "text", width: multi ? w.cnp : w.cnp * 1.3 },
    { key: "produto", label: "Produto", format: "text", width: multi ? w.produto : w.produto * 1.3 },
    { key: "fabricante", label: "Fabricante", format: "text", width: w.fabricante },
    { key: "quantidade", label: "Quantidade", format: "integer", align: "right", width: w.quantidade, showTotal: true },
    { key: "notas", label: "Notas", format: "text", width: w.notas }
  );
  return cols;
}

function buildSummary(details: readonly TransferenciaDetail[]): ReportSummaryItem[] {
  const totalLinhas = details.reduce((s, d) => s + d.linhas.length, 0);
  const totalUnidades = details.reduce((s, d) => s + d.linhas.reduce((s2, l) => s2 + l.quantidade, 0), 0);
  return [
    { label: "Transferências", value: details.length, format: "integer" },
    { label: "Linhas", value: totalLinhas, format: "integer" },
    { label: "Unidades", value: totalUnidades, format: "integer" },
  ];
}

export function buildTransferenciaDocumentoReport(details: readonly TransferenciaDetail[]): Report {
  const multi = details.length > 1;
  const rows: ReportRow[] = [];
  for (const d of details) {
    const rota = `${d.farmaciaOrigemNome} → ${d.farmaciaDestinoNome}`;
    for (const l of d.linhas) {
      rows.push({
        [GROUP_KEY]: d.id,
        rota,
        cnp: String(l.cnp),
        produto: l.designacao,
        fabricante: l.fabricante ?? "—",
        quantidade: l.quantidade,
        notas: l.notas ?? "",
      });
    }
    if (multi && d.linhas.length > 1) {
      rows.push({
        [GROUP_KEY]: d.id,
        [ROW_KIND_KEY]: "subtotal",
        rota,
        cnp: "",
        produto: `TOTAL ${rota}`,
        fabricante: "",
        quantidade: d.linhas.reduce((s, l) => s + l.quantidade, 0),
        notas: "",
      });
    }
  }

  const primeira = details[0];
  return {
    title: multi ? "Guias de Transferência" : "Guia de Transferência",
    subtitle: multi
      ? `${details.length} transferência(s) geradas`
      : `${primeira?.farmaciaOrigemNome ?? ""} → ${primeira?.farmaciaDestinoNome ?? ""}`,
    generatedAt: new Date(),
    summary: buildSummary(details),
    columns: columns(multi),
    rows,
    meta: {
      slug: multi ? "guias-transferencia" : "guia-transferencia",
      orientation: "portrait",
      organization: "SPharm.MT",
      density: "compact",
      footer: "SPharm.MT · Documento gerado a partir da transferência — uso interno",
    },
  };
}
