"use server";

import { revalidatePath } from "next/cache";
import { getPrisma } from "@/lib/prisma";
import { requirePlatformAdmin } from "@/lib/admin/auth";
import { logAudit } from "@/lib/audit";
import { normalizeManufacturerName } from "@/lib/catalog-normalizers";
import { getOrCreateFabricante } from "@/lib/catalog-persistence";
import type { ProductType } from "@/lib/catalog-types";
import type { Prisma } from "@/generated/prisma/client";

const VALID_PRODUCT_TYPES: ProductType[] = [
  "MEDICAMENTO",
  "SUPLEMENTO",
  "DERMOCOSMETICA",
  "DISPOSITIVO_MEDICO",
  "HIGIENE_CUIDADO",
  "ORTOPEDIA",
  "PUERICULTURA",
  "VETERINARIA",
  "OUTRO",
];

export type ApplyReviewInput = {
  produtoId: string;
  /** Se passado, marca esta revisão como RESOLVIDO. */
  revisaoId?: string;
  /** ID de Fabricante existente (preferido). */
  fabricanteId?: string | null;
  /** Nome de fabricante novo — cria via getOrCreateFabricante. */
  fabricanteNovo?: string | null;
  productType?: ProductType | null;
  classificacaoNivel1Id?: string | null;
  classificacaoNivel2Id?: string | null;
  /** Se true, marca produto como `validadoManualmente=true`, bloqueando overrides. */
  validar?: boolean;
};

type ActionResult =
  | { ok: true; produtoId: string; revisaoFechada: boolean }
  | { ok: false; error: string };

/**
 * Aplica uma revisão manual a um Produto:
 *   - Atribui fabricante (existente OU cria novo via nome)
 *   - Define productType
 *   - Define classificação canónica N1 / N2
 *   - Opcionalmente bloqueia (validadoManualmente=true → origemDados=VALIDADO)
 *   - Opcionalmente fecha a revisão (estado=RESOLVIDO, dataResolucao=now)
 *
 * Apenas platform admin. Tenant-scoped via getPrisma().
 *
 * Validações:
 *   - produtoId tem de existir
 *   - classificacaoNivel2Id (se passado) deve ser filho do N1
 *   - productType tem de estar no enum
 *
 * Não toca em campos não-passados (patch parcial).
 */
export async function applyReviewAction(input: ApplyReviewInput): Promise<ActionResult> {
  const session = await requirePlatformAdmin();
  const prisma = await getPrisma();

  try {
    const produto = await prisma.produto.findUnique({
      where: { id: input.produtoId },
      select: { id: true, validadoManualmente: true },
    });
    if (!produto) return { ok: false, error: "Produto não encontrado." };

    if (input.productType && !VALID_PRODUCT_TYPES.includes(input.productType)) {
      return { ok: false, error: "Tipo de produto inválido." };
    }

    if (input.classificacaoNivel1Id) {
      const n1 = await prisma.classificacao.findUnique({
        where: { id: input.classificacaoNivel1Id },
        select: { id: true, tipo: true, estado: true },
      });
      if (!n1 || n1.tipo !== "NIVEL_1" || n1.estado !== "ATIVO") {
        return { ok: false, error: "Classificação Nível 1 inválida." };
      }
    }

    if (input.classificacaoNivel2Id) {
      const n2 = await prisma.classificacao.findUnique({
        where: { id: input.classificacaoNivel2Id },
        select: { id: true, tipo: true, estado: true, classificacaoPaiId: true },
      });
      if (!n2 || n2.tipo !== "NIVEL_2" || n2.estado !== "ATIVO") {
        return { ok: false, error: "Classificação Nível 2 inválida." };
      }
      // Coerência: N2 tem de ser filho do N1 escolhido (ou do N1 já no produto).
      const expectedParent =
        input.classificacaoNivel1Id !== undefined
          ? input.classificacaoNivel1Id
          : (await prisma.produto.findUnique({
              where: { id: input.produtoId },
              select: { classificacaoNivel1Id: true },
            }))?.classificacaoNivel1Id ?? null;
      if (expectedParent !== n2.classificacaoPaiId) {
        return {
          ok: false,
          error: "Subcategoria não pertence à categoria escolhida.",
        };
      }
    }

    // Resolver fabricante: id explícito > criar novo via nome > não tocar.
    let resolvedFabricanteId: string | null | undefined = undefined;
    if (input.fabricanteId !== undefined) {
      if (input.fabricanteId === null) {
        resolvedFabricanteId = null;
      } else {
        const f = await prisma.fabricante.findUnique({
          where: { id: input.fabricanteId },
          select: { id: true, estado: true },
        });
        if (!f || f.estado !== "ATIVO") {
          return { ok: false, error: "Fabricante inválido ou inactivo." };
        }
        resolvedFabricanteId = f.id;
      }
    } else if (input.fabricanteNovo) {
      const normalized = normalizeManufacturerName(input.fabricanteNovo);
      if (!normalized) {
        return { ok: false, error: "Nome de fabricante inválido." };
      }
      resolvedFabricanteId = await getOrCreateFabricante(
        normalized,
        input.fabricanteNovo !== normalized ? input.fabricanteNovo : null
      );
    }

    const updates: Prisma.ProdutoUncheckedUpdateInput = {};

    if (resolvedFabricanteId !== undefined) updates.fabricanteId = resolvedFabricanteId;
    if (input.productType) updates.productType = input.productType;
    if (input.classificacaoNivel1Id !== undefined)
      updates.classificacaoNivel1Id = input.classificacaoNivel1Id;
    if (input.classificacaoNivel2Id !== undefined)
      updates.classificacaoNivel2Id = input.classificacaoNivel2Id;

    if (input.validar) {
      updates.validadoManualmente = true;
      // Produto.estado = VALIDADO sinaliza que está revisto e bloqueado.
      updates.estado = "VALIDADO";
      // Produto.origemDados = MANUAL — proveniência do dado actual.
      updates.origemDados = "MANUAL";
      updates.classificationSource = "MANUAL";
      updates.needsManualReview = false;
      updates.manualReviewReason = null;
    }

    if (Object.keys(updates).length === 0 && !input.revisaoId) {
      return { ok: false, error: "Nada para alterar." };
    }

    let revisaoFechada = false;
    await prisma.$transaction(async (tx) => {
      if (Object.keys(updates).length > 0) {
        await tx.produto.update({
          where: { id: input.produtoId },
          data: updates,
        });
      }
      if (input.revisaoId) {
        const r = await tx.filaRevisao.findUnique({
          where: { id: input.revisaoId },
          select: { id: true, produtoId: true, estado: true },
        });
        if (r && r.produtoId === input.produtoId && r.estado === "PENDENTE") {
          await tx.filaRevisao.update({
            where: { id: input.revisaoId },
            data: { estado: "RESOLVIDO", dataResolucao: new Date() },
          });
          revisaoFechada = true;
        }
      }
    });

    await logAudit({
      actorId: session.sub,
      action: "catalog.review_applied",
      entity: "Produto",
      entityId: input.produtoId,
      meta: {
        revisaoId: input.revisaoId ?? null,
        revisaoFechada,
        fields: Object.keys(updates),
        validar: !!input.validar,
      },
    });

    revalidatePath("/admin/catalogo/revisao");
    if (input.revisaoId) revalidatePath(`/admin/catalogo/revisao/${input.revisaoId}`);

    return { ok: true, produtoId: input.produtoId, revisaoFechada };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Erro desconhecido",
    };
  }
}

/**
 * Marca uma revisão como ignorada — sem alterar o produto. Para casos em que
 * a revisão foi criada por engano ou já não é relevante.
 */
export async function dismissReviewAction(input: {
  revisaoId: string;
  motivo?: string | null;
}): Promise<ActionResult> {
  const session = await requirePlatformAdmin();
  const prisma = await getPrisma();

  try {
    const r = await prisma.filaRevisao.findUnique({
      where: { id: input.revisaoId },
      select: { id: true, produtoId: true, estado: true },
    });
    if (!r) return { ok: false, error: "Revisão não encontrada." };
    if (r.estado !== "PENDENTE") {
      return { ok: false, error: "Revisão já não está pendente." };
    }

    await prisma.filaRevisao.update({
      where: { id: input.revisaoId },
      data: { estado: "IGNORADO", dataResolucao: new Date() },
    });

    await logAudit({
      actorId: session.sub,
      action: "catalog.review_dismissed",
      entity: "FilaRevisao",
      entityId: input.revisaoId,
      meta: { motivo: input.motivo ?? null, produtoId: r.produtoId },
    });

    revalidatePath("/admin/catalogo/revisao");
    revalidatePath(`/admin/catalogo/revisao/${input.revisaoId}`);

    return { ok: true, produtoId: r.produtoId, revisaoFechada: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Erro desconhecido",
    };
  }
}
