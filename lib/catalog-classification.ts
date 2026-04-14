/**
 * lib/catalog-classification.ts
 *
 * Helpers para resolução e gestão da árvore de Classificacao a partir
 * de uma string de categoria normalizada.
 *
 * Estratégia: reutilizar sempre classificações existentes; criar apenas
 * quando não existe equivalente e a criação for explicitamente solicitada.
 */

import { legacyPrisma as prisma } from "@/lib/prisma";
import { normalizeCategoria } from "./catalog-normalizers";

export type ResolvedClassification = {
  nivel1Id: string | null;
  nivel2Id: string | null;
};

/**
 * Tenta resolver os IDs de Classificacao (nivel1 e nivel2) a partir de
 * strings de categoria/subcategoria.
 *
 * Estratégia:
 *  1. Normaliza o nome da categoria (title-case, trim).
 *  2. Pesquisa case-insensitive em NIVEL_1 pelo nome normalizado.
 *  3. Se encontrar nivel1 e houver subcategoria, tenta resolver NIVEL_2
 *     como filho directo do nivel1 encontrado.
 *
 * Devolve { nivel1Id: null, nivel2Id: null } quando nada é encontrado.
 * Nunca cria classificações — use getOrCreateClassificacaoNivel1 para isso.
 */
export async function resolveClassificationIdsFromCategory(
  category: string | null | undefined,
  subcategory?: string | null
): Promise<ResolvedClassification> {
  const normalizedCat = normalizeCategoria(category);
  if (!normalizedCat) return { nivel1Id: null, nivel2Id: null };

  const nivel1 = await prisma.classificacao.findFirst({
    where: {
      tipo: "NIVEL_1",
      estado: "ATIVO",
      nome: { equals: normalizedCat, mode: "insensitive" },
    },
    select: { id: true },
  });

  if (!nivel1) return { nivel1Id: null, nivel2Id: null };

  if (subcategory) {
    const normalizedSub = normalizeCategoria(subcategory);
    if (normalizedSub) {
      const nivel2 = await prisma.classificacao.findFirst({
        where: {
          tipo: "NIVEL_2",
          estado: "ATIVO",
          classificacaoPaiId: nivel1.id,
          nome: { equals: normalizedSub, mode: "insensitive" },
        },
        select: { id: true },
      });
      if (nivel2) {
        return { nivel1Id: nivel1.id, nivel2Id: nivel2.id };
      }
    }
  }

  return { nivel1Id: nivel1.id, nivel2Id: null };
}

/**
 * Garante a existência de uma Classificacao de NIVEL_1 com o nome dado.
 * Reutiliza se já existir (case-insensitive); cria se não existir.
 *
 * Devolve o ID da classificação encontrada/criada, ou null se o nome
 * normalizado for vazio.
 *
 * Nota: usar com moderação durante o enriquecimento automático —
 * preferir sempre reutilizar classificações existentes.
 */
export async function getOrCreateClassificacaoNivel1(
  name: string
): Promise<string | null> {
  const normalized = normalizeCategoria(name);
  if (!normalized) return null;

  const existing = await prisma.classificacao.findFirst({
    where: {
      tipo: "NIVEL_1",
      nome: { equals: normalized, mode: "insensitive" },
    },
    select: { id: true },
  });

  if (existing) return existing.id;

  const created = await prisma.classificacao.create({
    data: {
      nome: normalized,
      tipo: "NIVEL_1",
      estado: "ATIVO",
    },
  });

  return created.id;
}

/**
 * Garante a existência de uma Classificacao de NIVEL_2 filho de um
 * NIVEL_1 já existente (por ID).
 *
 * Devolve o ID da subclassificação, ou null se o nome for inválido.
 */
export async function getOrCreateClassificacaoNivel2(
  parentId: string,
  name: string
): Promise<string | null> {
  const normalized = normalizeCategoria(name);
  if (!normalized) return null;

  const existing = await prisma.classificacao.findFirst({
    where: {
      tipo: "NIVEL_2",
      classificacaoPaiId: parentId,
      nome: { equals: normalized, mode: "insensitive" },
    },
    select: { id: true },
  });

  if (existing) return existing.id;

  const created = await prisma.classificacao.create({
    data: {
      nome: normalized,
      tipo: "NIVEL_2",
      classificacaoPaiId: parentId,
      estado: "ATIVO",
    },
  });

  return created.id;
}
