/**
 * lib/reporting/etico-nett-linha.ts
 *
 * Linha «Ético/NETT: Ético, NETT…» dos filtros aplicados nos documentos exportados (PDF/impressão/Excel/email).
 * Partilhada pelos adaptadores — valores desconhecidos são ignorados (mesma leitura defensiva do filtro).
 */
import { ROTULO_ETICO_NETT, lerValoresFiltroEticoNett } from "@/lib/classificacao/etico-nett";

export function filtroEticoNettLinha(valores: readonly string[] | undefined | null): { label: string; value: string } | null {
  const lidos = lerValoresFiltroEticoNett(valores ?? []);
  return lidos.length > 0 ? { label: "Ético/NETT", value: lidos.map((v) => ROTULO_ETICO_NETT[v]).join(", ") } : null;
}
