"use server";

import { getPrisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/permissions";
import { Prisma } from "@/generated/prisma/client";

export type ProductSearchResult = {
  id: string;
  cnp: number;
  designacao: string;
  fabricante: string | null;
  stockAtual: number | null;
};

const MAX_LIMIT = 25;

function buildWhere(query: string): Prisma.ProdutoWhereInput | null {
  const q = query.trim();
  if (q.length < 2) return null;

  if (/^\d+$/.test(q)) {
    const n = Number(q);
    if (!Number.isFinite(n)) return null;
    return { cnp: n };
  }

  return {
    OR: [
      { designacao: { contains: q, mode: "insensitive" } },
      { fabricante: { is: { nomeNormalizado: { contains: q, mode: "insensitive" } } } },
    ],
  };
}

function toNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

type RawHit = {
  id: string;
  cnp: number;
  designacao: string;
  fabricante: { nomeNormalizado: string } | null;
  produtosFarmacia: { stockAtual: unknown }[];
};

function projectHit(p: RawHit, withStock: boolean): ProductSearchResult {
  return {
    id: p.id,
    cnp: p.cnp,
    designacao: p.designacao,
    fabricante: p.fabricante?.nomeNormalizado ?? null,
    stockAtual: withStock ? toNum(p.produtosFarmacia[0]?.stockAtual ?? null) : null,
  };
}

function buildSelect(farmaciaId: string) {
  return {
    id: true,
    cnp: true,
    designacao: true,
    fabricante: { select: { nomeNormalizado: true } },
    produtosFarmacia: {
      where: { farmaciaId },
      select: { stockAtual: true },
      take: 1,
    },
  } as const;
}

export async function searchProductsAction(input: {
  query: string;
  farmaciaId: string;
  limit?: number;
}): Promise<ProductSearchResult[]> {
  await requirePermission("reports.write");

  const where = buildWhere(input.query);
  if (!where) return [];
  if (!input.farmaciaId) return [];

  const prisma = await getPrisma();
  const limit = Math.min(input.limit ?? 20, MAX_LIMIT);

  const produtos = (await prisma.produto.findMany({
    where,
    take: limit,
    orderBy: [{ designacao: "asc" }],
    select: buildSelect(input.farmaciaId),
  })) as unknown as RawHit[];

  return produtos.map((p) => projectHit(p, true));
}

/**
 * Resolve uma lista de CNPs para produtos canónicos. Usado no pré-preenchimento
 * vindo do dashboard de sugestões — devolve apenas matches encontrados, em
 * ordem original dos CNPs, com o stock da farmácia escolhida.
 */
export async function resolveProductsByCnpAction(input: {
  cnps: number[];
  farmaciaId: string;
}): Promise<ProductSearchResult[]> {
  await requirePermission("reports.write");

  const valid = input.cnps.filter((c) => Number.isFinite(c) && c > 0);
  if (valid.length === 0) return [];
  if (!input.farmaciaId) return [];

  const prisma = await getPrisma();

  const produtos = (await prisma.produto.findMany({
    where: { cnp: { in: valid } },
    select: buildSelect(input.farmaciaId),
  })) as unknown as RawHit[];

  const byCnp = new Map<number, ProductSearchResult>(
    produtos.map((p) => [p.cnp, projectHit(p, true)])
  );

  const out: ProductSearchResult[] = [];
  for (const c of valid) {
    const hit = byCnp.get(c);
    if (hit) out.push(hit);
  }
  return out;
}
