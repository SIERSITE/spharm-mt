/**
 * lib/encomendas/excel-encomenda.ts
 *
 * Excel de UMA encomenda já gravada/finalizada — gerado no SERVIDOR a partir do detalhe PERSISTIDO (`OrderDetail`, o mesmo
 * que a página «abrir» mostra), nunca do estado temporário da proposta no browser.
 *
 * Estrutura EXACTA (sem cabeçalho, sem título, sem totais, sem formatação de relatório): uma folha «Encomenda» com 3 colunas
 *   A: CNP (número inteiro, formato «0» — todos os dígitos, nunca notação científica)
 *   B: Designação (texto, como consta na encomenda: snapshot da finalização quando existe)
 *   C: Quantidade a encomendar (número)
 * A 1.ª linha da folha é já o 1.º produto. Linhas com quantidade 0 (ou sem quantidade) não entram.
 */
import * as XLSX from "xlsx";
import type { OrderDetail } from "@/lib/encomendas/order-detail";
import { slugify } from "@/lib/reporting/report-filename";

import { SEM_FORNECEDOR_PARAM_CLIENTE } from "@/lib/encomendas/excel-constantes";

export const SEM_FORNECEDOR_PARAM = SEM_FORNECEDOR_PARAM_CLIENTE;

export type LinhaExcelEncomenda = { cnp: number; designacao: string; quantidade: number };

function pertence(l: OrderDetail["linhas"][number], fornecedor?: string): boolean {
  if (fornecedor === undefined) return true;
  if (fornecedor === SEM_FORNECEDOR_PARAM) return l.fornecedorSugeridoId === null;
  return l.fornecedorSugeridoId === fornecedor;
}

/**
 * As linhas a exportar. `fornecedor`: `undefined` = a encomenda toda; `"sem"` = linhas sem fornecedor decidido;
 * qualquer outro valor = id do fornecedor (uma encomenda com vários fornecedores gera um Excel por fornecedor,
 * como os documentos Imprimir/PDF/Email).
 */
export function linhasParaExcel(detail: OrderDetail, fornecedor?: string): LinhaExcelEncomenda[] {
  return detail.linhas
    .filter((l) => pertence(l, fornecedor))
    .map((l) => ({ cnp: l.cnp, designacao: l.designacao, quantidade: Number(l.quantidadeAjustada ?? 0) }))
    .filter((l) => Number.isFinite(l.quantidade) && l.quantidade > 0);
}

/** XLSX com uma folha «Encomenda» e SÓ os dados — nenhuma linha antes ou depois. */
export function construirXlsxEncomenda(linhas: readonly LinhaExcelEncomenda[]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(linhas.map((l) => [l.cnp, l.designacao, l.quantidade]));
  linhas.forEach((_, i) => {
    const celula = ws[XLSX.utils.encode_cell({ r: i, c: 0 })];
    if (celula) celula.z = "0"; // CNP: todos os dígitos, nunca notação científica
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Encomenda");
  return XLSX.write(wb, { bookType: "xlsx", type: "buffer" }) as Buffer;
}

/** `encomenda-<farmacia>-<fornecedor>-<numero-ou-id>.xlsx`, sanitizado. */
export function nomeFicheiroExcelEncomenda(detail: OrderDetail, fornecedor?: string): string {
  const nomes = new Set(detail.linhas.filter((l) => pertence(l, fornecedor)).map((l) => l.fornecedorSugeridoNome ?? "sem-fornecedor"));
  const forn = nomes.size === 1 ? [...nomes][0] : nomes.size === 0 ? "sem-linhas" : "varios-fornecedores";
  const partes = ["encomenda", slugify(detail.farmaciaNome), slugify(forn), slugify(detail.numero ?? detail.id)].filter(Boolean);
  return `${partes.join("-")}.xlsx`;
}
