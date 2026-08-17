import "server-only";
import { getPrisma } from "@/lib/prisma";
import {
  Prisma,
  type ProdutoEstado,
  type VerificationStatus,
} from "@/generated/prisma/client";

/**
 * Data loaders read-only para as páginas /catalogo e /catalogo/artigo/[cnp].
 *
 * Único ponto de leitura de Produto pelas páginas user-facing do catálogo.
 * Server-only — mutações vão por server actions noutro lado.
 *
 * Filtros suportados na lista:
 *   search (CNP exacto, designacao/dci/codigoATC ILIKE), fabricanteId,
 *   productType, classificacaoN1Id, verificationStatus, estado.
 *
 * Paginado: page 1-based, pageSize cap 200, default 50.
 */

// ─── Tipos da listagem ───────────────────────────────────────────────────────

/**
 * Estado de retirado per-produto, agregado a partir de `flagRetirado` de
 * todas as `ProdutoFarmacia` do produto (modelo canónico 2026-06):
 *
 *   · `none`     — nenhuma `ProdutoFarmacia` tem `flagRetirado=true`.
 *   · `partial`  — pelo menos uma tem `true` mas nem todas.
 *   · `all`      — todas as `ProdutoFarmacia` do produto têm `true`.
 *
 * Catálogo continua a mostrar todos os produtos. A UI distingue:
 *   · `all`     → badge "Retirado" global.
 *   · `partial` → indicação por farmácia.
 *   · `none`    → sem badge.
 */
export type CatalogoRetiradoStatus = "none" | "partial" | "all";

export type CatalogoRow = {
  id: string;
  cnp: number;
  designacao: string;
  fabricanteNome: string | null;
  classificacaoN1Nome: string | null;
  classificacaoN2Nome: string | null;
  productType: string | null;
  verificationStatus: VerificationStatus;
  imagemUrl: string | null;
  codigoATC: string | null;
  dci: string | null;
  formaFarmaceutica: string | null;
  dosagem: string | null;
  embalagem: string | null;
  estado: ProdutoEstado;
  /** PVP mínimo entre as farmácias que comercializam o produto. null se nenhuma. */
  pvpMin: number | null;
  /** Quantidade de farmácias com o produto registado. */
  farmaciasCount: number;
  /** Estado canónico de retirado, agregado às farmácias do produto. */
  retiradoStatus: CatalogoRetiradoStatus;
};

export type CatalogoListFilters = {
  search?: string;
  fabricanteId?: string;
  productType?: string;
  classificacaoN1Id?: string;
  verificationStatus?: VerificationStatus;
  estado?: ProdutoEstado;
  page: number;
  pageSize: number;
};

export type CatalogoListData = {
  rows: CatalogoRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export type CatalogoFilterOptions = {
  fabricantes: Array<{ id: string; nomeNormalizado: string }>;
  classificacoesN1: Array<{ id: string; nome: string }>;
};

export const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export function clampPageSize(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(1, Math.floor(n)), MAX_PAGE_SIZE);
}

export function clampPage(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.max(1, Math.floor(n));
}

// ─── Filter options (dropdowns) ──────────────────────────────────────────────

export async function loadCatalogoFilterOptions(): Promise<CatalogoFilterOptions> {
  const prisma = await getPrisma();
  const [fabricantes, classificacoesN1] = await Promise.all([
    prisma.fabricante.findMany({
      where: { estado: "ATIVO" },
      select: { id: true, nomeNormalizado: true },
      orderBy: { nomeNormalizado: "asc" },
    }),
    prisma.classificacao.findMany({
      where: { tipo: "NIVEL_1", estado: "ATIVO" },
      select: { id: true, nome: true },
      orderBy: { nome: "asc" },
    }),
  ]);
  return { fabricantes, classificacoesN1 };
}

// ─── Listagem ────────────────────────────────────────────────────────────────

export async function loadCatalogoListData(
  filters: CatalogoListFilters,
): Promise<CatalogoListData> {
  const prisma = await getPrisma();
  const page = clampPage(filters.page);
  const pageSize = clampPageSize(filters.pageSize);

  const where: Prisma.ProdutoWhereInput = {};
  if (filters.estado) where.estado = filters.estado;
  if (filters.fabricanteId) where.fabricanteId = filters.fabricanteId;
  if (filters.productType) where.productType = filters.productType;
  if (filters.classificacaoN1Id) where.classificacaoNivel1Id = filters.classificacaoN1Id;
  if (filters.verificationStatus) where.verificationStatus = filters.verificationStatus;

  if (filters.search && filters.search.trim().length > 0) {
    const q = filters.search.trim();
    const ors: Prisma.ProdutoWhereInput[] = [
      { designacao: { contains: q, mode: "insensitive" } },
      { dci: { contains: q, mode: "insensitive" } },
      { codigoATC: { contains: q, mode: "insensitive" } },
    ];
    const cnpNum = Number(q);
    if (Number.isFinite(cnpNum) && cnpNum > 0) {
      ors.push({ cnp: cnpNum });
    }
    where.OR = ors;
  }

  const [total, rows] = await Promise.all([
    prisma.produto.count({ where }),
    prisma.produto.findMany({
      where,
      select: {
        id: true,
        cnp: true,
        designacao: true,
        productType: true,
        verificationStatus: true,
        imagemUrl: true,
        codigoATC: true,
        dci: true,
        formaFarmaceutica: true,
        dosagem: true,
        embalagem: true,
        estado: true,
        fabricante: { select: { nomeNormalizado: true } },
        classificacaoNivel1: { select: { nome: true } },
        classificacaoNivel2: { select: { nome: true } },
        produtosFarmacia: {
          select: { pvp: true, farmaciaId: true, flagRetirado: true },
        },
      },
      orderBy: [{ designacao: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  const list: CatalogoRow[] = rows.map((p) => {
    const pvps = p.produtosFarmacia
      .map((pf) => (pf.pvp == null ? null : Number(pf.pvp)))
      .filter((n): n is number => n !== null && Number.isFinite(n) && n > 0);
    const pvpMin = pvps.length > 0 ? Math.min(...pvps) : null;
    const farmaciasCount = new Set(p.produtosFarmacia.map((pf) => pf.farmaciaId)).size;

    // Agregação canónica (modelo 2026-06): produto retirado quando todas
    // as farmácias o têm com flagRetirado=true; parcial quando só algumas;
    // none quando nenhuma. Sem PF, considera-se "none" (sinal de catálogo
    // global sem ligação operacional, não retirado).
    let retiradoStatus: CatalogoRetiradoStatus = "none";
    if (p.produtosFarmacia.length > 0) {
      const retiradosCount = p.produtosFarmacia.filter((pf) => pf.flagRetirado).length;
      if (retiradosCount === 0) retiradoStatus = "none";
      else if (retiradosCount === p.produtosFarmacia.length) retiradoStatus = "all";
      else retiradoStatus = "partial";
    }

    return {
      id: p.id,
      cnp: p.cnp,
      designacao: p.designacao,
      fabricanteNome: p.fabricante?.nomeNormalizado ?? null,
      classificacaoN1Nome: p.classificacaoNivel1?.nome ?? null,
      classificacaoN2Nome: p.classificacaoNivel2?.nome ?? null,
      productType: p.productType,
      verificationStatus: p.verificationStatus,
      imagemUrl: p.imagemUrl,
      codigoATC: p.codigoATC,
      dci: p.dci,
      formaFarmaceutica: p.formaFarmaceutica,
      dosagem: p.dosagem,
      embalagem: p.embalagem,
      estado: p.estado,
      pvpMin,
      farmaciasCount,
      retiradoStatus,
    };
  });

  return {
    rows: list,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

// ─── Detalhe por CNP ─────────────────────────────────────────────────────────

export type CatalogoArticlePresenca = {
  farmaciaId: string;
  farmaciaNome: string;
  designacaoLocal: string | null;
  pvp: number | null;
  pmc: number | null;
  stockAtual: number | null;
  /** Flag canónica do modelo 2026-06 — true = retirado nesta farmácia. */
  flagRetirado: boolean;
};

export type CatalogoArticle = {
  id: string;
  cnp: number;
  designacao: string;
  productType: string | null;
  productTypeConfidence: number | null;
  verificationStatus: VerificationStatus;
  imagemUrl: string | null;
  codigoATC: string | null;
  dci: string | null;
  formaFarmaceutica: string | null;
  dosagem: string | null;
  embalagem: string | null;
  flagMSRM: boolean;
  flagMNSRM: boolean;
  flagGenerico: boolean;
  validadoManualmente: boolean;
  needsManualReview: boolean;
  manualReviewReason: string | null;
  classificationSource: string | null;
  classificationVersion: string | null;
  externallyVerified: boolean;
  origemDados: string;
  estado: ProdutoEstado;
  lastVerifiedAt: Date | null;
  fabricante: { id: string; nomeNormalizado: string } | null;
  classificacaoNivel1: { id: string; nome: string } | null;
  classificacaoNivel2: { id: string; nome: string } | null;
  /**
   * Utilizações clínicas do produto, por nome. `fonte` distingue o que
   * alguém pôs à mão ("MANUAL") do que veio de regra ou modelo.
   */
  utilizacoes: Array<{
    slug: string;
    nome: string;
    fonte: string;
    confianca: number | null;
  }>;
  presencas: CatalogoArticlePresenca[];
  /** Agregação canónica de retirado sobre as presenças. */
  retiradoStatus: CatalogoRetiradoStatus;
};

export async function loadCatalogoArticle(cnp: number): Promise<CatalogoArticle | null> {
  const prisma = await getPrisma();
  const p = await prisma.produto.findUnique({
    where: { cnp },
    include: {
      fabricante: { select: { id: true, nomeNormalizado: true } },
      classificacaoNivel1: { select: { id: true, nome: true } },
      classificacaoNivel2: { select: { id: true, nome: true } },
      // Utilizações clínicas do produto. Vinham a ser escritas pelo
      // enriquecimento e não eram lidas em lado nenhum da aplicação.
      utilizacoes: {
        select: {
          fonte: true,
          confianca: true,
          utilizacao: { select: { slug: true, nome: true, estado: true } },
        },
      },
      produtosFarmacia: {
        select: {
          farmaciaId: true,
          designacaoLocal: true,
          pvp: true,
          pmc: true,
          stockAtual: true,
          flagRetirado: true,
          farmacia: { select: { nome: true } },
        },
        orderBy: { farmacia: { nome: "asc" } },
      },
    },
  });
  if (!p) return null;

  return {
    id: p.id,
    cnp: p.cnp,
    designacao: p.designacao,
    productType: p.productType,
    productTypeConfidence: p.productTypeConfidence,
    verificationStatus: p.verificationStatus,
    imagemUrl: p.imagemUrl,
    codigoATC: p.codigoATC,
    dci: p.dci,
    formaFarmaceutica: p.formaFarmaceutica,
    dosagem: p.dosagem,
    embalagem: p.embalagem,
    flagMSRM: p.flagMSRM,
    flagMNSRM: p.flagMNSRM,
    flagGenerico: p.flagGenerico,
    validadoManualmente: p.validadoManualmente,
    needsManualReview: p.needsManualReview,
    manualReviewReason: p.manualReviewReason,
    classificationSource: p.classificationSource,
    classificationVersion: p.classificationVersion,
    externallyVerified: p.externallyVerified,
    origemDados: p.origemDados,
    estado: p.estado,
    lastVerifiedAt: p.lastVerifiedAt,
    fabricante: p.fabricante,
    classificacaoNivel1: p.classificacaoNivel1,
    classificacaoNivel2: p.classificacaoNivel2,
    utilizacoes: p.utilizacoes
      .filter((u) => u.utilizacao.estado === "ATIVO")
      .map((u) => ({
        slug: u.utilizacao.slug,
        nome: u.utilizacao.nome,
        fonte: u.fonte,
        confianca: u.confianca,
      }))
      .sort((a, b) => a.nome.localeCompare(b.nome, "pt-PT")),
    presencas: p.produtosFarmacia.map((pf) => ({
      farmaciaId: pf.farmaciaId,
      farmaciaNome: pf.farmacia.nome,
      designacaoLocal: pf.designacaoLocal,
      pvp: pf.pvp == null ? null : Number(pf.pvp),
      pmc: pf.pmc == null ? null : Number(pf.pmc),
      stockAtual: pf.stockAtual == null ? null : Number(pf.stockAtual),
      flagRetirado: pf.flagRetirado,
    })),
    retiradoStatus: aggregateRetiradoStatus(p.produtosFarmacia),
  };
}

/**
 * Agrega `flagRetirado` das `ProdutoFarmacia` num único estado canónico.
 * Sem PF (catálogo global puro) → `none` por defeito.
 */
function aggregateRetiradoStatus(
  pfs: ReadonlyArray<{ flagRetirado: boolean }>,
): CatalogoRetiradoStatus {
  if (pfs.length === 0) return "none";
  const retirados = pfs.filter((pf) => pf.flagRetirado).length;
  if (retirados === 0) return "none";
  if (retirados === pfs.length) return "all";
  return "partial";
}
