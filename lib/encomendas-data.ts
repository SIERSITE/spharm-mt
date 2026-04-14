/**
 * lib/encomendas-data.ts
 * Server-side data para a página Encomendas.
 *
 * Devolve linhas (cnp, farmácia) com stock, rotação média (3 meses),
 * cobertura, fornecedor habitual, fabricante canónico e movimentos
 * dos últimos 6 meses. Mesmas garantias de Vendas/Transferências:
 * sem mocks, sem hardcoded, fabricante via Produto.fabricante.
 *
 * Os campos "ultimasCompras" e "condicoesFornecedor" do shape antigo
 * ficam vazios nesta passagem — não há ainda pipeline real para eles
 * (ver nota no fim do ficheiro).
 */
import { getPrisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { resolveCategoria } from "@/lib/categoria-resolver";

export type EncomendaMonthlyMovement = { mes: string; compras: number; vendas: number };
export type EncomendaPurchaseHistory = {
  data: string;
  fornecedor: string;
  quantidade: number;
  precoCusto: number;
};
export type EncomendaSupplierCondition = {
  fornecedor: string;
  campanha: string;
  desconto: string;
  bonus: string;
};

export type EncomendaBaseRow = {
  cnp: string;
  produto: string;
  farmacia: string;
  stockAtual: number;
  coberturaAtual: number;
  rotacaoMedia: number; // unidades por dia × 30 = unidades/mês
  fornecedor: string; // grossista habitual
  fabricante: string; // canónico
  categoria: string;
  movimentos6M: EncomendaMonthlyMovement[];
  ultimasCompras: EncomendaPurchaseHistory[];
  condicoesFornecedor: EncomendaSupplierCondition[];
};

function toF(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

const MES_ABBR = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];

export async function getEncomendasData(): Promise<EncomendaBaseRow[]> {
  const prisma = await getPrisma();
  const farmacias = await prisma.farmacia.findMany({
    where: { estado: "ATIVO", nome: { not: "Farmácia Teste" } },
    select: { id: true, nome: true },
    orderBy: { nome: "asc" },
  });
  const farmaciaIds = farmacias.map((f) => f.id);
  if (farmaciaIds.length === 0) return [];

  // 1. ProdutoFarmacia activos das farmácias seleccionadas + relações canónicas
  type PfRow = {
    produtoId: string;
    farmaciaId: string;
    farmaciaNome: string;
    cnp: string;
    designacao: string;
    stockAtual: number;
    fornecedorOrigem: string | null;
    categoriaOrigem: string | null;
    subcategoriaOrigem: string | null;
    canonN1: string | null;
    canonN2: string | null;
    fabricanteCanonico: string | null;
  };

  // Puxa as 4 fontes de categoria que o resolver precisa: canónico N1/N2
  // e os campos brutos do importer. O resolveCategoria no loop decide a
  // precedência (mesma regra em toda a app).
  const pfRows = await prisma.$queryRaw<PfRow[]>(Prisma.sql`
    SELECT
      pf."produtoId",
      pf."farmaciaId",
      f.nome                        AS "farmaciaNome",
      p.cnp::text                   AS cnp,
      p.designacao,
      pf."stockAtual"::float        AS "stockAtual",
      pf."fornecedorOrigem",
      pf."categoriaOrigem",
      pf."subcategoriaOrigem",
      c1.nome                       AS "canonN1",
      c2.nome                       AS "canonN2",
      fab."nomeNormalizado"         AS "fabricanteCanonico"
    FROM "ProdutoFarmacia" pf
    JOIN "Produto"  p   ON p.id  = pf."produtoId"
    JOIN "Farmacia" f   ON f.id  = pf."farmaciaId"
    LEFT JOIN "Fabricante"    fab ON fab.id = p."fabricanteId"
    LEFT JOIN "Classificacao" c1  ON c1.id  = p."classificacaoNivel1Id"
    LEFT JOIN "Classificacao" c2  ON c2.id  = p."classificacaoNivel2Id"
    WHERE
      pf."flagRetirado" = false
      AND f.id = ANY(${farmaciaIds})
      AND pf."stockAtual" IS NOT NULL
  `);

  if (pfRows.length === 0) return [];

  // 2. Vendas dos últimos 6 meses agrupadas por (produto, farmácia, ano, mes)
  const now = new Date();
  const periodEnd = now.getFullYear() * 12 + now.getMonth() + 1;
  const periodStart = periodEnd - 6;

  type VmRow = {
    produtoId: string;
    farmaciaId: string;
    ano: number;
    mes: number;
    qty: number;
  };

  const vmRows = await prisma.$queryRaw<VmRow[]>(Prisma.sql`
    SELECT
      vm."produtoId",
      vm."farmaciaId",
      vm.ano,
      vm.mes,
      SUM(vm.quantidade)::float AS qty
    FROM "VendaMensal" vm
    WHERE
      vm."farmaciaId" = ANY(${farmaciaIds})
      AND (vm.ano * 12 + vm.mes) >= ${periodStart}
      AND (vm.ano * 12 + vm.mes) < ${periodEnd}
    GROUP BY vm."produtoId", vm."farmaciaId", vm.ano, vm.mes
  `);

  // Index: key=produtoId:farmaciaId → array de {ano, mes, qty}
  const vmIndex = new Map<string, Array<{ ano: number; mes: number; qty: number }>>();
  for (const r of vmRows) {
    const k = `${r.produtoId}:${r.farmaciaId}`;
    if (!vmIndex.has(k)) vmIndex.set(k, []);
    vmIndex.get(k)!.push({ ano: r.ano, mes: r.mes, qty: toF(r.qty) });
  }

  // 3. Construir as linhas finais
  const result: EncomendaBaseRow[] = [];
  for (const pf of pfRows) {
    const k = `${pf.produtoId}:${pf.farmaciaId}`;
    const vendas = vmIndex.get(k) ?? [];

    // Soma dos últimos 3 meses (rotação)
    const recent3 = vendas
      .filter((v) => v.ano * 12 + v.mes >= periodEnd - 3)
      .reduce((s, v) => s + v.qty, 0);
    const avgDaily = recent3 / 90;
    const rotacaoMedia = Math.round(avgDaily * 30 * 10) / 10; // unidades/mês, 1 casa decimal
    const stockAtual = Math.round(toF(pf.stockAtual));
    const coberturaAtual =
      avgDaily > 0 ? Math.round(stockAtual / avgDaily) : stockAtual > 0 ? 999 : 0;

    // Movimentos 6M — só vendas; compras ficam a 0 enquanto não houver pipeline real
    const movimentos6M: EncomendaMonthlyMovement[] = vendas
      .sort((a, b) => a.ano * 12 + a.mes - (b.ano * 12 + b.mes))
      .map((v) => ({
        mes: `${MES_ABBR[v.mes - 1]} ${String(v.ano).slice(2)}`,
        compras: 0,
        vendas: Math.round(v.qty),
      }));

    const { grupo: categoriaResolvida } = resolveCategoria({
      classificacaoNivel1: pf.canonN1 ? { nome: pf.canonN1 } : null,
      classificacaoNivel2: pf.canonN2 ? { nome: pf.canonN2 } : null,
      categoriaOrigem: pf.categoriaOrigem,
      subcategoriaOrigem: pf.subcategoriaOrigem,
    });

    result.push({
      cnp: pf.cnp,
      produto: pf.designacao,
      farmacia: pf.farmaciaNome,
      stockAtual,
      coberturaAtual,
      rotacaoMedia,
      fornecedor: pf.fornecedorOrigem ?? "",
      fabricante: pf.fabricanteCanonico ?? "",
      categoria: categoriaResolvida,
      movimentos6M,
      ultimasCompras: [], // ver nota
      condicoesFornecedor: [], // ver nota
    });
  }

  return result;
}

/*
 * NOTAS DE LIMITAÇÃO (intencionais nesta passagem):
 *
 * - movimentos6M.compras: o campo de compras mensais não tem ainda uma
 *   tabela agregada equivalente a VendaMensal. Quando existir
 *   CompraMensal (ou snapshot), preencher aqui. Por agora == 0.
 *
 * - ultimasCompras: requer agregação por Compra (modelo já existe) com
 *   join a Fornecedor + ordenação por data desc. Não foi feito nesta
 *   passagem por não termos confirmação de que o universo de Compra
 *   esteja populado. Adicionar quando o pipeline de ingestão de compras
 *   estiver fechado.
 *
 * - condicoesFornecedor: não existe tabela de condições comerciais por
 *   fornecedor. É uma feature de produto que requer um modelo dedicado
 *   (CampanhaFornecedor / DescontoFornecedor). Fica como TODO de
 *   produto, não como dummy de UI.
 */
