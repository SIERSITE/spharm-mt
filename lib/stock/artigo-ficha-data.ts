import "server-only";
import { getPrisma } from "@/lib/prisma";
import { resolveCategoria, resolverPar } from "@/lib/categoria-resolver";
import { calcularPvpReferencia, descreverPvpReferencia, desvioFaceAReferencia } from "@/lib/pvp-referencia";
import { calcularPrecoReferencia, descreverPrecoReferencia } from "@/lib/produtos/preco-referencia";
import { custoDaFarmacia } from "@/lib/produtos/custo-farmacia";
import { rotuloProductType } from "@/lib/catalog/product-type-labels";

/**
 * lib/stock/artigo-ficha-data.ts
 *
 * Carregamento + preparação de dados da "ficha do artigo" (identidade,
 * PVP/custo de referência, stock por farmácia) — extraído de
 * app/stock/artigo/[cnp]/page.tsx para ser reutilizável quer pela
 * página completa (acesso directo por URL) quer pelo painel lateral
 * (Parte 4 do pedido de workspaces internos) SEM duplicar nenhuma
 * lógica. A página e o painel chamam esta MESMA função.
 */

const PLACEHOLDER = "—";

function fmt(value: string | null | undefined): string {
  const s = (value ?? "").trim();
  return s.length > 0 ? s : PLACEHOLDER;
}

export type ArtigoFichaStockRow = {
  farmaciaId: string;
  farmaciaNome: string;
  stock: number | null;
  pvp: number | null;
  custo: number | null;
  fonteCusto: string | null;
  desvioPvp: number | null;
  desvioCusto: number | null;
  ultimaVenda: string | null; // ISO — serializável através de Server Actions/JSON sem ambiguidade
  ultimaCompra: string | null;
  validadeMaisAntiga: string | null;
  stockMinimo: number | null;
};

export type ArtigoFichaData = {
  cnp: number;
  designacao: string;
  imagemUrl: string | null;
  fabricante: string;
  principioAtivo: string;
  atc: string;
  forma: string;
  dosagem: string;
  embalagem: string;
  categoria: string;
  subcategoria: string;
  grupo: string | null;
  tipoProduto: string;
  utilizacoes: string;
  flagGenerico: boolean | null;
  pvpReferencia: number | null;
  pvpReferenciaDescricao: string;
  custoReferencia: number | null;
  custoReferenciaDescricao: string;
  stockTotal: number;
  farmaciasComStock: number;
  ultimaVenda: string | null;
  stockRows: ArtigoFichaStockRow[];
};

export async function loadArtigoFicha(cnp: number): Promise<ArtigoFichaData | null> {
  if (!Number.isFinite(cnp) || cnp <= 0) return null;

  const prisma = await getPrisma();
  const produto = await prisma.produto.findUnique({
    where: { cnp },
    include: {
      fabricante: { select: { nomeNormalizado: true } },
      classificacaoNivel1: { select: { nome: true } },
      classificacaoNivel2: { select: { nome: true } },
      utilizacoes: { select: { utilizacao: { select: { nome: true, estado: true } } } },
      produtosFarmacia: {
        where: { flagRetirado: false },
        include: { farmacia: { select: { id: true, nome: true, estado: true } } },
      },
    },
  });
  if (!produto) return null;

  const resolvedCat = resolveCategoria({
    classificacaoNivel1: produto.classificacaoNivel1,
    classificacaoNivel2: produto.classificacaoNivel2,
  });
  const par = resolverPar({
    classificacaoNivel1: produto.classificacaoNivel1,
    classificacaoNivel2: produto.classificacaoNivel2,
  });

  const utilizacoes =
    produto.utilizacoes
      .filter((u) => u.utilizacao.estado === "ATIVO")
      .map((u) => u.utilizacao.nome)
      .sort((a, b) => a.localeCompare(b, "pt-PT"))
      .join(" · ") || PLACEHOLDER;

  const pfsActive = produto.produtosFarmacia.filter(
    (pf) => pf.farmacia.estado === "ATIVO" && pf.farmacia.nome !== "Farmácia Teste"
  );

  const precos = pfsActive.map((pf) => ({ pvp: pf.pvp !== null ? Number(pf.pvp) : null }));
  const referencia = calcularPvpReferencia(precos);

  const custosPorFarmacia = pfsActive.map((pf) =>
    custoDaFarmacia(pf.pmc !== null ? Number(pf.pmc) : null, pf.puc !== null ? Number(pf.puc) : null)
  );
  const custoReferencia = calcularPrecoReferencia(custosPorFarmacia.map((c) => c.valor));

  const stockRows: ArtigoFichaStockRow[] = pfsActive
    .map((pf) => {
      const c = custoDaFarmacia(pf.pmc !== null ? Number(pf.pmc) : null, pf.puc !== null ? Number(pf.puc) : null);
      const pvp = pf.pvp !== null ? Number(pf.pvp) : null;
      return {
        farmaciaId: pf.farmacia.id,
        farmaciaNome: pf.farmacia.nome,
        stock: pf.stockAtual !== null ? Number(pf.stockAtual) : null,
        pvp,
        custo: c.valor,
        fonteCusto: c.fonte,
        desvioPvp: desvioFaceAReferencia(pvp, referencia.valor),
        desvioCusto: desvioFaceAReferencia(c.valor, custoReferencia.valor),
        ultimaVenda: pf.dataUltimaVenda ? pf.dataUltimaVenda.toISOString() : null,
        ultimaCompra: pf.dataUltimaCompra ? pf.dataUltimaCompra.toISOString() : null,
        validadeMaisAntiga: pf.validadeMaisAntiga ? pf.validadeMaisAntiga.toISOString() : null,
        stockMinimo: pf.stockMinimo !== null ? Number(pf.stockMinimo) : null,
      };
    })
    .sort((a, b) => (b.stock ?? 0) - (a.stock ?? 0));

  const stockTotal = stockRows.reduce((s, r) => s + (r.stock ?? 0), 0);
  const farmaciasComStock = stockRows.filter((r) => (r.stock ?? 0) > 0).length;
  const ultimaVenda =
    stockRows
      .map((r) => r.ultimaVenda)
      .filter((d): d is string => !!d)
      .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] ?? null;

  return {
    cnp: produto.cnp,
    designacao: produto.designacao,
    imagemUrl: produto.imagemUrl,
    fabricante: fmt(produto.fabricante?.nomeNormalizado),
    principioAtivo: fmt(produto.dci),
    atc: fmt(produto.codigoATC),
    forma: fmt(produto.formaFarmaceutica),
    dosagem: fmt(produto.dosagem),
    embalagem: fmt(produto.embalagem),
    categoria: fmt(par.categoria),
    subcategoria: fmt(par.subcategoria || null),
    grupo: resolvedCat.grupo ?? null,
    tipoProduto: rotuloProductType(produto.productType, PLACEHOLDER),
    utilizacoes,
    flagGenerico: produto.flagGenerico,
    pvpReferencia: referencia.valor,
    pvpReferenciaDescricao: descreverPvpReferencia(referencia),
    custoReferencia: custoReferencia.valor,
    custoReferenciaDescricao: descreverPrecoReferencia(custoReferencia, "pago"),
    stockTotal,
    farmaciasComStock,
    ultimaVenda,
    stockRows,
  };
}
