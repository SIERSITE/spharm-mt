/**
 * lib/devolucoes-data.ts
 * Server-side data fetching para a página Devoluções.
 *
 * Carrega o universo real de Devolucao (tipo FORNECEDOR) das farmácias
 * activas para um período, sem limites artificiais. Os filtros e
 * agrupamentos são aplicados no cliente em cima do dataset completo —
 * mesmo padrão de lib/vendas-data.ts.
 */

import { getPrisma } from "@/lib/prisma";
import { resolveCategoria } from "@/lib/categoria-resolver";

export type DevolucaoRow = {
  id: string;
  data: string; // ISO yyyy-mm-dd
  produtoId: string;
  cnp: string;
  produto: string;
  fabricante: string;
  /** Nível pai (Sexualidade). Usado pelo filtro. */
  categoria: string;
  /** Nível filho (Preservativos). Usado para exibição quando != categoria. */
  subcategoria: string;
  farmacia: string;
  fornecedor: string;
  quantidade: number;
  valor: number;
  motivo: string;
  tipo: "CLIENTE" | "FORNECEDOR" | "OUTRA";
};

function toF(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export type DevolucoesPeriod = { from: Date; to: Date };

/** Período por defeito: últimos 90 dias. */
function defaultPeriod(): DevolucoesPeriod {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 90);
  return { from, to };
}

export async function getDevolucoesData(
  period: DevolucoesPeriod = defaultPeriod()
): Promise<DevolucaoRow[]> {
  const prisma = await getPrisma();
  const farmacias = await prisma.farmacia.findMany({
    where: { estado: "ATIVO", nome: { not: "Farmácia Teste" } },
    select: { id: true },
  });
  const farmaciaIds = farmacias.map((f) => f.id);
  if (farmaciaIds.length === 0) return [];

  const records = await prisma.devolucao.findMany({
    where: {
      farmaciaId: { in: farmaciaIds },
      data: { gte: period.from, lte: period.to },
    },
    select: {
      id: true,
      data: true,
      tipo: true,
      motivo: true,
      quantidade: true,
      valor: true,
      produtoId: true,
      farmacia: { select: { nome: true } },
      fornecedorDestino: { select: { nomeNormalizado: true } },
      produto: {
        select: {
          cnp: true,
          designacao: true,
          fabricante: { select: { nomeNormalizado: true } },
          classificacaoNivel1: { select: { nome: true } },
          classificacaoNivel2: { select: { nome: true } },
        },
      },
    },
    orderBy: { data: "desc" },
  });

  // Batch lookup das origens de categoria em ProdutoFarmacia para o
  // fallback do resolveCategoria. Uma única query pelos pares observados.
  const pfKeys = Array.from(
    new Set(records.map((r) => `${r.produtoId}:${r.farmacia.nome}`))
  );
  const produtoIds = [...new Set(records.map((r) => r.produtoId))];
  const pfs =
    produtoIds.length > 0
      ? await prisma.produtoFarmacia.findMany({
          where: {
            produtoId: { in: produtoIds },
            farmaciaId: { in: farmaciaIds },
          },
          select: {
            produtoId: true,
            farmaciaId: true,
            categoriaOrigem: true,
            subcategoriaOrigem: true,
          },
        })
      : [];
  const farmaciaIdByName = new Map<string, string>();
  // Precisamos do mapping nome→id para indexar; reusa a query anterior.
  const farmaciasRaw = await prisma.farmacia.findMany({
    where: { id: { in: farmaciaIds } },
    select: { id: true, nome: true },
  });
  for (const f of farmaciasRaw) farmaciaIdByName.set(f.nome, f.id);
  const pfByKey = new Map(
    pfs.map((pf) => [`${pf.produtoId}:${pf.farmaciaId}`, pf])
  );
  void pfKeys;

  return records.map((r) => {
    const farmaciaId = farmaciaIdByName.get(r.farmacia.nome) ?? "";
    const pf = pfByKey.get(`${r.produtoId}:${farmaciaId}`);
    const { categoria, grupo } = resolveCategoria({
      classificacaoNivel1: r.produto.classificacaoNivel1,
      classificacaoNivel2: r.produto.classificacaoNivel2,
      categoriaOrigem: pf?.categoriaOrigem,
      subcategoriaOrigem: pf?.subcategoriaOrigem,
    });
    return {
      id: r.id,
      data: r.data.toISOString().slice(0, 10),
      produtoId: r.produtoId,
      cnp: String(r.produto.cnp),
      produto: r.produto.designacao,
      fabricante: r.produto.fabricante?.nomeNormalizado ?? "",
      categoria,
      subcategoria: grupo && grupo !== categoria ? grupo : "",
      farmacia: r.farmacia.nome,
      fornecedor: r.fornecedorDestino?.nomeNormalizado ?? "",
      quantidade: Math.round(toF(r.quantidade)),
      valor: Math.round(toF(r.valor) * 100) / 100,
      motivo: (r.motivo ?? "").trim(),
      tipo: r.tipo,
    };
  });
}
