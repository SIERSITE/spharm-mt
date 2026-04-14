"use server";

import { revalidatePath } from "next/cache";
import { getPrisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/permissions";
import { retryOutboxRow, cancelOutboxRow } from "@/lib/integracao/outbox-admin";
import { logAudit } from "@/lib/audit";

export async function retryExportAction(outboxId: string) {
  const session = await requirePermission("settings.global");
  const prisma = await getPrisma();
  const result = await retryOutboxRow(prisma, outboxId, session.sub);
  if (!result.ok) {
    return { ok: false as const, error: result.error };
  }
  await logAudit({
    actorId: session.sub,
    action: "outbox.retry",
    entity: "OrderOutbox",
    entityId: outboxId,
  });
  revalidatePath("/configuracoes/integracao");
  return { ok: true as const };
}

export async function cancelExportAction(outboxId: string, reason: string | null) {
  const session = await requirePermission("settings.global");
  const prisma = await getPrisma();
  const result = await cancelOutboxRow(prisma, outboxId, session.sub, reason);
  if (!result.ok) {
    return { ok: false as const, error: result.error };
  }
  await logAudit({
    actorId: session.sub,
    action: "outbox.cancel",
    entity: "OrderOutbox",
    entityId: outboxId,
    meta: reason ? { reason } : undefined,
  });
  revalidatePath("/configuracoes/integracao");
  return { ok: true as const };
}
