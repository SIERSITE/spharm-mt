import "server-only";
import { getPrisma } from "@/lib/prisma";

/**
 * Helper mínimo para escrever em AuditLog. Chamar a partir de server
 * actions quando uma acção for relevante para rastreabilidade.
 *
 * Exemplo:
 *   await logAudit({
 *     actorId: session.sub,
 *     action: "user.created",
 *     entity: "Utilizador",
 *     entityId: newUser.id,
 *     meta: { email: newUser.email, perfil: newUser.perfil },
 *   });
 *
 * Falhar em silêncio (catch + console.error) é proposital — auditoria
 * não deve bloquear a acção de negócio.
 */
export async function logAudit(input: {
  actorId: string | null;
  action: string;
  entity?: string | null;
  entityId?: string | null;
  meta?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<void> {
  try {
    const prisma = await getPrisma();
    await prisma.auditLog.create({
      data: {
        actorId: input.actorId,
        action: input.action,
        entity: input.entity ?? null,
        entityId: input.entityId ?? null,
        metaJson: input.meta ? JSON.stringify(input.meta) : null,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      },
    });
  } catch (err) {
    console.error("[audit] falha ao registar", input.action, err);
  }
}
