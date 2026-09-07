"use server";

import { revalidatePath } from "next/cache";
import { requirePlatformAdmin } from "@/lib/admin/auth";
import { logAudit } from "@/lib/audit";
import { resolverRevisaoGlobal } from "@/lib/catalog/revisao-global";

export type ResolverInput = { id: string; motivo: string };

export type ResolverResultado =
  | { ok: true; resolvidoPor: string }
  | { ok: false; erro: string };

/**
 * Marca uma divergência global como resolvida.
 *
 * ── O aprovador NÃO é um campo do formulário ─────────────────────────
 *
 * Vem da sessão. Um campo de texto onde a pessoa escreve o próprio nome
 * é uma declaração, não uma identificação — e numa coluna de auditoria a
 * diferença é toda. O que fica escrito é quem estava autenticado, e isso
 * o formulário não pode contradizer.
 *
 * O motivo continua a ser escrito à mão, porque esse ninguém o pode
 * derivar: é a única parte que só quem decidiu conhece.
 *
 * ── O que esta acção NÃO faz ─────────────────────────────────────────
 *
 * Não altera `Produto` nem `CatalogoGlobal`. Nesta fase o ecrã é de
 * triagem: regista que a divergência foi vista e o que se decidiu. Mudar
 * uma classificação é outro acto — `catalog:promote-global` de um lado, a
 * validação manual no tenant do outro — e cada um tem as suas guardas.
 */
export async function resolverRevisaoGlobalAction(
  input: ResolverInput,
): Promise<ResolverResultado> {
  const session = await requirePlatformAdmin();
  const aprovador = `${session.nome} <${session.email}>`;

  const r = await resolverRevisaoGlobal({
    id: input.id,
    aprovador,
    motivo: input.motivo,
  });

  if (!r.ok) return { ok: false, erro: r.erro };

  await logAudit({
    actorId: session.sub,
    action: "catalogo.revisao-global.resolver",
    entity: "CatalogoGlobalRevisao",
    entityId: r.revisao.id,
    meta: {
      cnp: r.revisao.cnp,
      tenantSlug: r.revisao.tenantSlug,
      tipo: r.revisao.tipo,
      motivo: r.revisao.resolucao,
    },
  });

  revalidatePath("/admin/catalogo/revisao-global");
  return { ok: true, resolvidoPor: aprovador };
}
