/**
 * lib/encomendas/excel-url.ts
 *
 * URL do Excel de uma encomenda (client-safe: não importa a biblioteca xlsx). Com um só documento (fornecedor único) o
 * Excel é o da encomenda toda; com vários, cada documento tem o Excel do SEU fornecedor.
 */
import { SEM_FORNECEDOR_PARAM_CLIENTE } from "@/lib/encomendas/excel-constantes";

export function urlExcelEncomenda(listaEncomendaId: string, fornecedor: { id: string | null } | undefined, nDocumentos: number): string {
  const base = `/api/encomendas/${encodeURIComponent(listaEncomendaId)}/excel`;
  if (nDocumentos <= 1 || !fornecedor) return base;
  return `${base}?fornecedor=${encodeURIComponent(fornecedor.id ?? SEM_FORNECEDOR_PARAM_CLIENTE)}`;
}
