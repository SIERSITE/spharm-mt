"use server";

import { revalidatePath } from "next/cache";
import {
  getTransferenciasData,
  type OpcoesOperacionais,
} from "@/lib/transferencias-data";
import { getPrisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/permissions";
import { canAccessFarmaciaSync } from "@/lib/permissions-core";
import { logAudit } from "@/lib/audit";
import { podeAnularTransferencia } from "@/lib/transferencias/anulacao";
import {
  criarTransferenciaComLinhas,
  IdempotencyConflictError as TransferIdempotencyConflictError,
} from "@/lib/transferencias/criar-transferencia";

/**
 * As datas do ecrã passam a chegar ao cálculo.
 *
 * Antes esta acção não recebia nada: a página tinha
 * `useState("2026-04-01")` / `useState("2026-04-10")` — duas datas
 * escritas à mão que nunca saíam do browser — e o servidor calculava
 * sempre sobre os últimos 3 meses. O período no cabeçalho do relatório
 * era decorativo, e não coincidia com o dos Excessos.
 */
export async function runTransferenciasReport(options?: OpcoesOperacionais) {
  return getTransferenciasData(options);
}

type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Soft-delete de uma `Transferencia` real (Bloco D / botão "Criar
 * transferência"). Ao contrário de `ListaEncomenda`, uma `Transferencia`
 * nunca teve circuito de exportação ao ERP — ver o comentário no modelo
 * em `prisma/schema.prisma` — por isso elimina-se sempre livremente,
 * sem o aviso de dupla confirmação que `deleteListaEncomendaAction`
 * exige para encomendas já exportadas de facto.
 *
 * Exclusiva de RASCUNHO desde 2026-09-29 — uma transferência já
 * FINALIZADA usa `anularTransferenciaAction` (nunca apaga a row/linhas,
 * exige motivo). Ver o comentário em `EstadoTransferencia`.
 *
 * Mesma gate de permissão que as acções destrutivas equivalentes do
 * módulo de encomendas (`cancelOutboxAction`, `deleteListaEncomendaAction`).
 */
export async function deleteTransferenciaAction(transferenciaId: string): Promise<ActionResult> {
  const session = await requirePermission("settings.global");
  const prisma = await getPrisma();

  try {
    const transferencia = await prisma.transferencia.findUnique({
      where: { id: transferenciaId },
      select: { id: true, estado: true },
    });
    if (!transferencia) return { ok: false, error: "Transferência não encontrada." };
    if (transferencia.estado === "ELIMINADA") {
      return { ok: false, error: "Esta transferência já foi eliminada." };
    }
    if (transferencia.estado !== "RASCUNHO") {
      return { ok: false, error: "Só um rascunho pode ser eliminado — uma transferência finalizada anula-se." };
    }

    await prisma.transferencia.update({
      where: { id: transferenciaId },
      data: { estado: "ELIMINADA" },
    });

    await logAudit({
      actorId: session.sub,
      action: "transferencia.deleted",
      entity: "Transferencia",
      entityId: transferenciaId,
    });

    revalidatePath("/transferencias");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido" };
  }
}

export type AnularTransferenciaResult = { ok: true } | { ok: false; error: string };

/**
 * Anula uma `Transferencia` já FINALIZADA — transita `estado` para
 * `ANULADA`, grava motivo/autor/data. Nunca apaga a row nem as
 * `LinhaTransferencia` (ver `podeAnularTransferencia` em
 * `lib/transferencias/anulacao.ts` e o comentário no enum
 * `EstadoTransferencia`). O documento reimprimido depois mostra
 * "ANULADO" (ver `lib/reporting/adapters/transferencia-documento.ts`).
 *
 * Verifica acesso a AMBAS as farmácias (origem e destino) — não basta
 * ter acesso a uma delas para poder anular o movimento entre as duas.
 */
export async function anularTransferenciaAction(
  transferenciaId: string,
  motivo: string
): Promise<AnularTransferenciaResult> {
  const session = await requirePermission("settings.global");
  const prisma = await getPrisma();

  try {
    const transferencia = await prisma.transferencia.findUnique({
      where: { id: transferenciaId },
      select: { id: true, estado: true, farmaciaOrigemId: true, farmaciaDestinoId: true },
    });
    if (!transferencia) return { ok: false, error: "Transferência não encontrada." };
    if (
      !canAccessFarmaciaSync(session, transferencia.farmaciaOrigemId) ||
      !canAccessFarmaciaSync(session, transferencia.farmaciaDestinoId)
    ) {
      return { ok: false, error: "Sem acesso a uma das farmácias desta transferência." };
    }

    const decisao = podeAnularTransferencia(transferencia.estado, motivo);
    if (!decisao.podeAnular) return { ok: false, error: decisao.motivo };

    await prisma.transferencia.update({
      where: { id: transferenciaId },
      data: {
        estado: "ANULADA",
        motivoAnulacao: motivo.trim(),
        anuladoPorId: session.sub,
        anuladoEm: new Date(),
      },
    });

    await logAudit({
      actorId: session.sub,
      action: "transferencia.anulada",
      entity: "Transferencia",
      entityId: transferenciaId,
      meta: { motivo: motivo.trim() },
    });

    revalidatePath("/transferencias");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido" };
  }
}

export type DuplicarTransferenciaResult =
  | { ok: true; transferenciaId: string }
  | { ok: false; error: string };

/**
 * Duplica QUALQUER transferência existente (RASCUNHO, FINALIZADA ou
 * ANULADA) para um novo RASCUNHO com as mesmas linhas — nunca altera o
 * documento original. Distinta de `duplicarRascunhoComoNovoAction`
 * (essa serve só o conflito de versão do autosave e recebe as linhas do
 * cliente, não um id de documento).
 */
export async function duplicarTransferenciaAction(transferenciaId: string): Promise<DuplicarTransferenciaResult> {
  const session = await requirePermission("reports.write");
  const prisma = await getPrisma();

  try {
    const original = await prisma.transferencia.findUnique({
      where: { id: transferenciaId },
      select: {
        farmaciaOrigemId: true,
        farmaciaDestinoId: true,
        linhas: { select: { produtoId: true, quantidade: true, notas: true } },
      },
    });
    if (!original) return { ok: false, error: "Transferência não encontrada." };
    if (
      !canAccessFarmaciaSync(session, original.farmaciaOrigemId) ||
      !canAccessFarmaciaSync(session, original.farmaciaDestinoId)
    ) {
      return { ok: false, error: "Sem acesso a uma das farmácias desta transferência." };
    }

    const { transferenciaId: novaId } = await criarTransferenciaComLinhas(prisma, {
      farmaciaOrigemId: original.farmaciaOrigemId,
      farmaciaDestinoId: original.farmaciaDestinoId,
      criadoPorId: session.sub,
      finalize: false,
      linhas: original.linhas.map((l) => ({
        produtoId: l.produtoId,
        quantidade: Number(l.quantidade),
        notas: l.notas,
      })),
    });

    await logAudit({
      actorId: session.sub,
      action: "transferencia.duplicated",
      entity: "Transferencia",
      entityId: novaId,
      meta: { origemTransferenciaId: transferenciaId },
    });

    revalidatePath("/transferencias");
    return { ok: true, transferenciaId: novaId };
  } catch (err) {
    if (err instanceof TransferIdempotencyConflictError) return { ok: false, error: err.message };
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido" };
  }
}
