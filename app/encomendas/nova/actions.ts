"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getPrisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/permissions";
import { resolveCurrentTenantSlug } from "@/lib/tenant-context";
import { LEGACY_TENANT } from "@/lib/auth";
import { createEncomendaWithOutbox, type OrderLineInput } from "@/lib/ingest/orders";
import { logAudit } from "@/lib/audit";

export type CreateOrderFormInput = {
  farmaciaId: string;
  nome: string;
  finalize: boolean;
  linhas: OrderLineInput[];
};

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
