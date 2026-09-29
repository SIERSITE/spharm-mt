"use server";

/**
 * app/transferencias/manutencao/actions.ts
 *
 * Única acção nova desta página: "Consultar" (expandir uma linha da
 * tabela e mostrar produto a produto). Tudo o resto — eliminar, anular,
 * duplicar — já existe em `app/transferencias/actions.ts` e é chamado
 * directamente pelo cliente.
 *
 * Reaproveita `loadTransferenciaDetail` (lib/transferencias/transferencia-detail.ts),
 * a MESMA leitura que já serve o documento "Guia de Transferência" — não
 * é uma query nova, só uma forma de a mostrar em ecrã sem gerar PDF.
 */
import { requirePermission } from "@/lib/permissions";
import { canAccessFarmaciaSync } from "@/lib/permissions-core";
import { loadTransferenciaDetail, type TransferenciaDetail } from "@/lib/transferencias/transferencia-detail";

export type ConsultarTransferenciaResult =
  | { ok: true; detalhe: TransferenciaDetail }
  | { ok: false; error: string };

export async function consultarTransferenciaAction(
  transferenciaId: string
): Promise<ConsultarTransferenciaResult> {
  const session = await requirePermission("reports.write");

  const detalhe = await loadTransferenciaDetail(transferenciaId);
  if (!detalhe) return { ok: false, error: "Transferência não encontrada." };
  if (
    !canAccessFarmaciaSync(session, detalhe.farmaciaOrigemId) ||
    !canAccessFarmaciaSync(session, detalhe.farmaciaDestinoId)
  ) {
    return { ok: false, error: "Sem acesso a uma das farmácias desta transferência." };
  }

  return { ok: true, detalhe };
}
