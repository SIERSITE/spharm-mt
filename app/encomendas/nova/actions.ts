"use server";

import { revalidatePath } from "next/cache";
import { getPrisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/permissions";
import { resolveCurrentTenantSlug } from "@/lib/tenant-context";
import { LEGACY_TENANT } from "@/lib/auth";
import { createEncomendaWithOutbox, type OrderLineInput } from "@/lib/ingest/orders";
import { logAudit } from "@/lib/audit";
import {
  generateOrderProposal,
  type ProposalInput,
  type ProposalResult,
} from "@/lib/encomendas/proposal";

export type CreateOrderFormInput = {
  farmaciaId: string;
  nome: string;
  finalize: boolean;
  linhas: OrderLineInput[];
};

export type GenerateProposalInput = {
  farmaciaId: string;
  /** ISO date — yyyy-mm-dd or full ISO. */
  startDate: string;
  endDate: string;
  considerStock: boolean;
  baseRule: ProposalInput["baseRule"];
  targetCoverageDays: number;
  filters?: ProposalInput["filters"];
};

export type GenerateProposalResult =
  | { ok: true; data: ProposalResult }
  | { ok: false; error: string };

type ActionResult =
  | { ok: true; listaEncomendaId: string; outboxId: string | null }
  | { ok: false; error: string };

export async function createOrderAction(input: CreateOrderFormInput): Promise<ActionResult> {
  const session = await requirePermission("reports.write");
  const prisma = await getPrisma();
  const tenantSlug = (await resolveCurrentTenantSlug()) ?? LEGACY_TENANT;

  if (!input.farmaciaId) {
    return { ok: false, error: "Seleccione uma farmácia." };
  }
  if (!input.nome.trim()) {
    return { ok: false, error: "Nome da encomenda em falta." };
  }
  if (input.linhas.length === 0) {
    return { ok: false, error: "Adicione pelo menos um produto." };
  }

  try {
    const result = await createEncomendaWithOutbox(prisma, tenantSlug, {
      farmaciaId: input.farmaciaId,
      criadoPorId: session.sub,
      nome: input.nome,
      finalize: input.finalize,
      linhas: input.linhas,
    });

    await logAudit({
      actorId: session.sub,
      action: input.finalize ? "order.created_and_finalized" : "order.created_draft",
      entity: "ListaEncomenda",
      entityId: result.listaEncomendaId,
      meta: {
        finalize: input.finalize,
        linhasCount: input.linhas.length,
        outboxId: result.outboxId,
      },
    });

    revalidatePath("/encomendas/lista");
    revalidatePath("/configuracoes/integracao");
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido" };
  }
}

/**
 * Gera a proposta de encomenda a partir de vendas no período definido
 * pelo utilizador. Read-only — não cria nada na BD; o utilizador revê
 * e depois usa `createOrderAction` para finalizar.
 */
export async function generateProposalAction(
  input: GenerateProposalInput
): Promise<GenerateProposalResult> {
  await requirePermission("reports.write");

  try {
    if (!input.farmaciaId) {
      return { ok: false, error: "Seleccione uma farmácia." };
    }
    const start = new Date(input.startDate);
    const end = new Date(input.endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return { ok: false, error: "Datas inválidas." };
    }
    if (end < start) {
      return { ok: false, error: "A data fim é anterior à data início." };
    }
    if (input.targetCoverageDays < 1) {
      return { ok: false, error: "Cobertura alvo deve ser pelo menos 1 dia." };
    }

    // Inclusivo até ao fim do dia de end.
    end.setHours(23, 59, 59, 999);

    const data = await generateOrderProposal({
      farmaciaId: input.farmaciaId,
      startDate: start,
      endDate: end,
      considerStock: input.considerStock,
      baseRule: input.baseRule,
      targetCoverageDays: input.targetCoverageDays,
      filters: input.filters,
    });

    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Erro desconhecido",
    };
  }
}
