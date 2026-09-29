/**
 * lib/reporting/adapters/encomenda-documento.ts
 *
 * Documento PROFISSIONAL de encomenda — "Nota de Encomenda" a enviar ao
 * FORNECEDOR (ver componentes/encomendas/order-create-client.tsx).
 * Reutiliza 100% da infra genérica de `Report`
 * (`report-html.ts`/`report-pdf-server.ts`/`report-email.ts`).
 *
 * Desde 2026-09-29: devolve SEMPRE um array — um `Report` por PAR
 * (encomenda × fornecedor). Uma encomenda com linhas de fornecedores
 * diferentes nunca produz um único documento misto: cada fornecedor
 * recebe o seu próprio documento, com o SEU nome no cabeçalho, nunca
 * repetido por linha. Uma encomenda de fornecedor único continua a
 * produzir exactamente 1 documento (array de tamanho 1) — nenhuma
 * mudança visível para o caso comum.
 *
 * Nunca mistura farmácias no mesmo documento — um documento profissional
 * é sempre emitido POR uma farmácia PARA um fornecedor; ver o cabeçalho
 * (`meta.organization*`), que vem sempre de uma única `OrderDetail`.
 *
 * Redacção obrigatória (nunca aparece neste documento): fabricante,
 * quantidade sugerida, fornecedor por linha (está no cabeçalho, nunca
 * repetido), stock, cobertura, rotação, ou qualquer critério interno de
 * cálculo. A quantidade mostrada é SEMPRE `quantidadeAjustada` (a
 * confirmada pelo utilizador) — nunca `quantidadeSugerida`.
 *
 * Nunca inventa dados: tudo o que aparece vem de `OrderDetail`
 * (`lib/encomendas/order-detail.ts`).
 */
import type { OrderDetail, OrderDetailLine } from "@/lib/encomendas/order-detail";
import type { Report, ReportColumn, ReportRow, ReportSummaryItem } from "../report-types";
import { normalizarLargura } from "../column-widths";

const SEM_FORNECEDOR_ID = "__sem_fornecedor__";
const SEM_FORNECEDOR_NOME = "Fornecedor não definido";

const BASE_WIDTHS = { cnp: 12, produto: 46, quantidade: 14 };

function columns(): ReportColumn[] {
  const w = normalizarLargura(BASE_WIDTHS);
  return [
    { key: "cnp", label: "CNP / Código", format: "text", width: w.cnp },
    { key: "produto", label: "Designação", format: "text", width: w.produto },
    { key: "quantidade", label: "Quantidade", format: "integer", align: "right", width: w.quantidade, showTotal: true },
  ];
}

function buildSummary(linhas: readonly OrderDetailLine[]): ReportSummaryItem[] {
  const totalUnidades = linhas.reduce((s, l) => s + (l.quantidadeAjustada ?? 0), 0);
  return [
    { label: "Referências", value: linhas.length, format: "integer" },
    { label: "Unidades", value: totalUnidades, format: "integer" },
  ];
}

function buildDocumentoParaFornecedor(
  detail: OrderDetail,
  fornecedorNome: string,
  linhas: readonly OrderDetailLine[]
): Report {
  const rows: ReportRow[] = linhas.map((l) => ({
    cnp: String(l.cnp),
    produto: l.designacao,
    quantidade: l.quantidadeAjustada ?? 0,
  }));

  const estaAnulada = detail.estado === "ANULADA";

  return {
    title: `Nota de Encomenda — ${fornecedorNome}`,
    subtitle: `Encomenda ${detail.numero ?? `(rascunho ${detail.id})`} · ${detail.farmaciaNome}`,
    generatedAt: new Date(),
    filtersApplied: [
      { label: "Fornecedor", value: fornecedorNome },
      { label: "Nº documento", value: detail.numero ?? "—" },
      { label: "Data", value: detail.dataCriacao.toLocaleDateString("pt-PT") },
      { label: "Estado", value: detail.estado },
    ],
    summary: buildSummary(linhas),
    columns: columns(),
    rows,
    meta: {
      slug: `nota-encomenda-${fornecedorNome}`,
      orientation: "portrait",
      organization: detail.farmaciaNome,
      organizationAddress: detail.farmaciaMorada ?? undefined,
      organizationNif: detail.farmaciaNif ?? undefined,
      organizationContact: detail.farmaciaContacto ?? undefined,
      density: "compact",
      footer: `Documento gerado a partir da encomenda ${detail.numero ?? detail.id} — para uso do fornecedor ${fornecedorNome}`,
      ...(estaAnulada
        ? { cancelledStamp: { motivo: detail.motivoAnulacao, por: detail.anuladoPorNome, em: detail.anuladoEm } }
        : {}),
    },
  };
}

/**
 * Um `Report` por PAR (encomenda × fornecedor) — ver o comentário do
 * ficheiro. Percorre `details` na ordem dada; dentro de cada `OrderDetail`
 * as linhas são agrupadas por `fornecedorSugeridoId` (nunca por
 * `fornecedor`/`fornecedorOrigem`, que é só o histórico informativo).
 * Uma linha sem fornecedor decidido cai no grupo "Fornecedor não
 * definido" — nunca é omitida silenciosamente.
 */
export function buildEncomendaDocumentoReport(details: readonly OrderDetail[]): Report[] {
  const reports: Report[] = [];
  for (const d of details) {
    const porFornecedor = new Map<string, { nome: string; linhas: OrderDetailLine[] }>();
    for (const l of d.linhas) {
      const chave = l.fornecedorSugeridoId ?? SEM_FORNECEDOR_ID;
      const nome = l.fornecedorSugeridoNome ?? SEM_FORNECEDOR_NOME;
      if (!porFornecedor.has(chave)) porFornecedor.set(chave, { nome, linhas: [] });
      porFornecedor.get(chave)!.linhas.push(l);
    }
    for (const { nome, linhas } of porFornecedor.values()) {
      reports.push(buildDocumentoParaFornecedor(d, nome, linhas));
    }
  }
  return reports;
}
