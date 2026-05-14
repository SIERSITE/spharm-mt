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

    revalidatePath("/encomendas");
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

// ─── Transferência interna (RC Batch 2) ───────────────────────────────
//
// Reutiliza `createEncomendaWithOutbox` em modo RASCUNHO (sem outbox /
// sem export agent). A `ListaEncomenda` resultante é o registo
// operacional da transferência sugerida; o operador revê, ajusta a
// quantidade e finaliza no flow existente em /encomendas/[id]. As
// linhas têm `notas` estruturada com a origem (source farmácia + CNP)
// e o motivo (same-cnp ou dci-equivalent). Sem novos modelos, sem
// outbox.

export type InternalTransferKind = "same-cnp" | "dci-equivalent";

export type CreateInternalTransferInput = {
  /** Farmácia destino — onde a ruptura está iminente. Esta é a
   *  `ListaEncomenda.farmaciaId`. */
  destinoFarmaciaId: string;
  /** Farmácia origem — onde existe excesso. Vai para `notas` da linha. */
  sourceFarmaciaNome: string;
  /** Produto a transferir (mesmo `produtoId` para same-CNP; produtoId
   *  do source para DCI-equivalent). */
  produtoId: string;
  /** CNP — informativo, para apresentação consistente nos logs e
   *  notas. */
  cnp: string;
  designacao: string;
  quantidade: number;
  kind: InternalTransferKind;
  /** "rotura iminente" | "excesso interno" | livre */
  motivo: string;
  /** Para DCI-equivalent: identifica o produto que existe na origem
   *  (CNP diferente do destino). */
  dciSourceProductName?: string;
  dciSourceCnp?: string;
};

export type CreateInternalTransferResult =
  | { ok: true; listaEncomendaId: string }
  | { ok: false; error: string };

function buildTransferNote(input: CreateInternalTransferInput): string {
  const lines: string[] = [];
  lines.push(`Transferência interna sugerida (${input.kind}).`);
  lines.push(`Origem: ${input.sourceFarmaciaNome}`);
  if (input.kind === "dci-equivalent" && input.dciSourceProductName) {
    lines.push(`Source product: ${input.dciSourceProductName} (CNP ${input.dciSourceCnp ?? "—"})`);
    lines.push(`Atenção: DCI-equivalente. Validar antes de transferir.`);
  }
  lines.push(`Motivo: ${input.motivo}`);
  return lines.join(" · ");
}

export async function createInternalTransferAction(
  input: CreateInternalTransferInput,
): Promise<CreateInternalTransferResult> {
  const session = await requirePermission("reports.write");
  const prisma = await getPrisma();
  const tenantSlug = (await resolveCurrentTenantSlug()) ?? LEGACY_TENANT;

  if (!input.destinoFarmaciaId) return { ok: false, error: "Farmácia destino em falta." };
  if (!input.produtoId) return { ok: false, error: "Produto em falta." };
  if (!Number.isFinite(input.quantidade) || input.quantidade <= 0) {
    return { ok: false, error: "Quantidade tem de ser > 0." };
  }
  if (input.kind === "dci-equivalent" && !input.dciSourceCnp) {
    return { ok: false, error: "DCI-equivalente requer CNP do produto source." };
  }

  const nome =
    input.kind === "same-cnp"
      ? `Transferência interna · ${input.sourceFarmaciaNome} → ${input.designacao}`
      : `Transferência DCI · ${input.sourceFarmaciaNome} → ${input.designacao}`;

  try {
    const result = await createEncomendaWithOutbox(prisma, tenantSlug, {
      farmaciaId: input.destinoFarmaciaId,
      criadoPorId: session.sub,
      nome: nome.slice(0, 180), // safety bound
      finalize: false, // RASCUNHO sempre — operador revê e finaliza no flow normal
      linhas: [
        {
          produtoId: input.produtoId,
          quantidadeSugerida: input.quantidade,
          quantidadeAjustada: null,
          fornecedorSugeridoId: null,
          notas: buildTransferNote(input),
        },
      ],
    });

    await logAudit({
      actorId: session.sub,
      action: "internal_transfer.created_draft",
      entity: "ListaEncomenda",
      entityId: result.listaEncomendaId,
      meta: {
        kind: input.kind,
        destinoFarmaciaId: input.destinoFarmaciaId,
        sourceFarmaciaNome: input.sourceFarmaciaNome,
        cnp: input.cnp,
        quantidade: input.quantidade,
        motivo: input.motivo,
      },
    });

    revalidatePath("/encomendas");
    revalidatePath("/dashboard");
    return { ok: true, listaEncomendaId: result.listaEncomendaId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido" };
  }
}
