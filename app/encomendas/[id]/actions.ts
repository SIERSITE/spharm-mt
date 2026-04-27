"use server";

import { revalidatePath } from "next/cache";
import { getPrisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/permissions";
import { resolveCurrentTenantSlug } from "@/lib/tenant-context";
import { LEGACY_TENANT } from "@/lib/auth";
import { finalizeAndQueueOrder } from "@/lib/ingest/orders";
import { logAudit } from "@/lib/audit";

type ActionResult = { ok: true } | { ok: false; error: string };

async function assertDraft(prisma: Awaited<ReturnType<typeof getPrisma>>, listaId: string) {
  const lista = await prisma.listaEncomenda.findUnique({
    where: { id: listaId },
    select: { id: true, estado: true },
  });
  if (!lista) throw new Error("Encomenda não encontrada.");
  if (lista.estado !== "RASCUNHO") {
    throw new Error("Esta encomenda já não é editável (não é rascunho).");
  }
  return lista;
}

function revalidateDetail(listaId: string) {
  revalidatePath(`/encomendas/${listaId}`);
  revalidatePath("/encomendas/lista");
}

/**
 * Edita uma linha de uma lista em RASCUNHO. Aceita patch parcial —
 * só os campos passados são alterados. Bloqueia se a lista já estiver
 * finalizada (o payload do outbox é imutável).
 */
export async function updateLineAction(input: {
  listaEncomendaId: string;
  linhaId: string;
  quantidadeAjustada?: number | null;
  notas?: string | null;
}): Promise<ActionResult> {
  const session = await requirePermission("reports.write");
  const prisma = await getPrisma();

  try {
    await assertDraft(prisma, input.listaEncomendaId);

    const linha = await prisma.linhaEncomenda.findUnique({
      where: { id: input.linhaId },
      select: { id: true, listaEncomendaId: true },
    });
    if (!linha || linha.listaEncomendaId !== input.listaEncomendaId) {
      return { ok: false, error: "Linha não pertence a esta encomenda." };
    }

    const data: {
      quantidadeAjustada?: number | null;
      notas?: string | null;
    } = {};
    if (input.quantidadeAjustada !== undefined) {
      if (input.quantidadeAjustada !== null && !Number.isFinite(input.quantidadeAjustada)) {
        return { ok: false, error: "Quantidade inválida." };
      }
      data.quantidadeAjustada =
        input.quantidadeAjustada === null
          ? null
          : Math.max(0, input.quantidadeAjustada);
    }
    if (input.notas !== undefined) {
      data.notas = input.notas?.trim() ? input.notas.trim() : null;
    }

    if (Object.keys(data).length === 0) return { ok: true };

    await prisma.linhaEncomenda.update({
      where: { id: input.linhaId },
      data,
    });
    await prisma.listaEncomenda.update({
      where: { id: input.listaEncomendaId },
      data: { dataAtualizacao: new Date() },
    });

    await logAudit({
      actorId: session.sub,
      action: "order.line_updated",
      entity: "LinhaEncomenda",
      entityId: input.linhaId,
      meta: data,
    });
    revalidateDetail(input.listaEncomendaId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido" };
  }
}

export async function removeLineAction(input: {
  listaEncomendaId: string;
  linhaId: string;
}): Promise<ActionResult> {
  const session = await requirePermission("reports.write");
  const prisma = await getPrisma();

  try {
    await assertDraft(prisma, input.listaEncomendaId);

    const linha = await prisma.linhaEncomenda.findUnique({
      where: { id: input.linhaId },
      select: { id: true, listaEncomendaId: true, produtoId: true },
    });
    if (!linha || linha.listaEncomendaId !== input.listaEncomendaId) {
      return { ok: false, error: "Linha não pertence a esta encomenda." };
    }

    await prisma.linhaEncomenda.delete({ where: { id: input.linhaId } });
    await prisma.listaEncomenda.update({
      where: { id: input.listaEncomendaId },
      data: { dataAtualizacao: new Date() },
    });

    await logAudit({
      actorId: session.sub,
      action: "order.line_removed",
      entity: "LinhaEncomenda",
      entityId: input.linhaId,
      meta: { produtoId: linha.produtoId },
    });
    revalidateDetail(input.listaEncomendaId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido" };
  }
}

/**
 * Adiciona um produto manual à lista (excepção, fora da proposta).
 * Falha se já existir uma linha para o mesmo produto (regra de unique
 * (listaEncomendaId, produtoId) na BD).
 */
export async function addManualLineAction(input: {
  listaEncomendaId: string;
  produtoId: string;
  quantidadeAjustada: number;
  notas?: string | null;
}): Promise<ActionResult> {
  const session = await requirePermission("reports.write");
  const prisma = await getPrisma();

  try {
    await assertDraft(prisma, input.listaEncomendaId);

    if (!Number.isFinite(input.quantidadeAjustada) || input.quantidadeAjustada <= 0) {
      return { ok: false, error: "Quantidade tem de ser > 0." };
    }

    const exists = await prisma.linhaEncomenda.findUnique({
      where: {
        listaEncomendaId_produtoId: {
          listaEncomendaId: input.listaEncomendaId,
          produtoId: input.produtoId,
        },
      },
      select: { id: true },
    });
    if (exists) {
      return {
        ok: false,
        error: "Este produto já está na encomenda — edite a quantidade da linha existente.",
      };
    }

    await prisma.linhaEncomenda.create({
      data: {
        listaEncomendaId: input.listaEncomendaId,
        produtoId: input.produtoId,
        quantidadeSugerida: null,
        quantidadeAjustada: input.quantidadeAjustada,
        notas: input.notas?.trim() ? input.notas.trim() : null,
      },
    });
    await prisma.listaEncomenda.update({
      where: { id: input.listaEncomendaId },
      data: { dataAtualizacao: new Date() },
    });

    await logAudit({
      actorId: session.sub,
      action: "order.manual_line_added",
      entity: "ListaEncomenda",
      entityId: input.listaEncomendaId,
      meta: { produtoId: input.produtoId, quantidade: input.quantidadeAjustada },
    });
    revalidateDetail(input.listaEncomendaId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido" };
  }
}

/**
 * Finaliza um rascunho a partir do detalhe — mesmo invariante que
 * o caminho da lista: passa por `finalizeAndQueueOrder`, que cria o
 * outbox em transação na primeira chamada e é idempotente em replays.
 */
export async function finalizeFromDetailAction(
  listaEncomendaId: string
): Promise<{ ok: true; outboxId: string } | { ok: false; error: string }> {
  const session = await requirePermission("reports.write");
  const prisma = await getPrisma();
  const tenantSlug = (await resolveCurrentTenantSlug()) ?? LEGACY_TENANT;

  try {
    const result = await finalizeAndQueueOrder(prisma, tenantSlug, listaEncomendaId);
    await logAudit({
      actorId: session.sub,
      action: "order.finalized_from_detail",
      entity: "ListaEncomenda",
      entityId: listaEncomendaId,
      meta: { outboxId: result.outboxId },
    });
    revalidateDetail(listaEncomendaId);
    revalidatePath("/configuracoes/integracao");
    return { ok: true, outboxId: result.outboxId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido" };
  }
}
