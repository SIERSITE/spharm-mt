"use server";

import { getPrisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/permissions";
import { Prisma } from "@/generated/prisma/client";
import { construirPredicadoPesquisa } from "@/lib/reporting/pesquisa-produto";
import { termosDePesquisa } from "@/lib/reporting/pesquisa-termos";

export type ProductSearchResult = {
  id: string;
  cnp: number;
  designacao: string;
  fabricante: string | null;
  stockAtual: number | null;
};

const MAX_LIMIT = 25;

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

  const q = input.query.trim();
  if (q.length < 2) return [];
  if (!input.farmaciaId) return [];

  // Regra única de pesquisa (lib/reporting/pesquisa-produto.ts): termos AND,
  // sem caixa nem acentos, CNP parcial. Aqui cada termo também pode casar
  // com o nome do fabricante.
  const predicado = construirPredicadoPesquisa(q, {
    colunasExtra: [Prisma.sql`f."nomeNormalizado"`],
  });
  if (!predicado) return [];

  const prisma = await getPrisma();
  const limit = Math.min(input.limit ?? 20, MAX_LIMIT);

  // Um CNP escrito por inteiro vem primeiro, mesmo que a pesquisa parcial
  // devolva mais do que o limite.
  const termos = termosDePesquisa(q);
  const cnpExacto = termos.length === 1 && /^\d+$/.test(termos[0]) ? termos[0] : null;
  const ordemCnp = cnpExacto
    ? Prisma.sql`(p."cnp"::text = ${cnpExacto}) DESC,`
    : Prisma.empty;
  const ids = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT p."id"
    FROM "Produto" p
    LEFT JOIN "Fabricante" f ON f."id" = p."fabricanteId"
    WHERE ${predicado}
    ORDER BY ${ordemCnp} p."designacao" ASC
    LIMIT ${limit}
  `);
  if (ids.length === 0) return [];

  const ordem = new Map(ids.map((r, i) => [r.id, i]));
  const produtos = (await prisma.produto.findMany({
    where: { id: { in: ids.map((r) => r.id) } },
    select: buildSelect(input.farmaciaId),
  })) as unknown as RawHit[];
  produtos.sort((x, y) => (ordem.get(x.id) ?? 0) - (ordem.get(y.id) ?? 0));

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
