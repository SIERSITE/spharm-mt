import "server-only";
import { getPrisma } from "@/lib/prisma";
import {
  Prisma,
  type EnrichmentSourceStatus,
  type EstadoFilaRevisao,
  type PrioridadeRevisao,
  type TipoRevisao,
  type ProdutoEstado,
  type VerificationStatus,
} from "@/generated/prisma/client";

/**
 * lib/admin/catalog-review-data.ts
 *
 * Loaders read-only para a UI de revisão de catálogo (/admin/catalogo/revisao).
 * Mutações vão por server actions em app/admin/catalogo/revisao/actions.ts.
 *
 * Fonte primária: tabela `FilaRevisao` (estado=PENDENTE), populada pelo
 * orquestrador de enriquecimento quando `resolved.needsManualReview = true`.
 */

export const REVIEW_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

export type ReviewListFilters = {
  estado?: EstadoFilaRevisao;
  tipoRevisao?: TipoRevisao;
  prioridade?: PrioridadeRevisao;
  search?: string;
  page: number;
  pageSize: number;
};

export type ReviewListRow = {
  id: string;
  produtoId: string;
  cnp: number;
  designacao: string;
  productType: string | null;
  productTypeConfidence: number | null;
  verificationStatus: VerificationStatus;
  needsManualReview: boolean;
  manualReviewReason: string | null;
  tipoRevisao: TipoRevisao;
  prioridade: PrioridadeRevisao;
  estado: EstadoFilaRevisao;
  dataCriacao: Date;
};

export type ReviewListData = {
  rows: ReviewListRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  counts: {
    pendentePorTipo: Record<TipoRevisao, number>;
    pendenteTotal: number;
  };
};

function clampPage(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.max(1, Math.floor(n));
}

function clampPageSize(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return REVIEW_PAGE_SIZE;
  return Math.min(Math.max(1, Math.floor(n)), MAX_PAGE_SIZE);
}

export async function loadReviewListData(
  filters: ReviewListFilters
): Promise<ReviewListData> {
  const prisma = await getPrisma();

  const page = clampPage(filters.page);
  const pageSize = clampPageSize(filters.pageSize);

  const where: Prisma.FilaRevisaoWhereInput = {};
  where.estado = filters.estado ?? "PENDENTE";
  if (filters.tipoRevisao) where.tipoRevisao = filters.tipoRevisao;
  if (filters.prioridade) where.prioridade = filters.prioridade;
  if (filters.search && filters.search.trim().length > 0) {
    const q = filters.search.trim();
    const numeric = /^\d+$/.test(q) ? Number(q) : null;
    where.produto = {
      OR: [
        { designacao: { contains: q, mode: "insensitive" } },
        ...(numeric != null ? [{ cnp: numeric }] : []),
      ],
    };
  }

  const skip = (page - 1) * pageSize;

  const [items, total, byType] = await Promise.all([
    prisma.filaRevisao.findMany({
      where,
      orderBy: [{ prioridade: "asc" }, { dataCriacao: "asc" }],
      skip,
      take: pageSize,
      include: {
        produto: {
          select: {
            id: true,
            cnp: true,
            designacao: true,
            productType: true,
            productTypeConfidence: true,
            verificationStatus: true,
            needsManualReview: true,
            manualReviewReason: true,
          },
        },
      },
    }),
    prisma.filaRevisao.count({ where }),
    prisma.filaRevisao.groupBy({
      by: ["tipoRevisao"],
      where: { estado: "PENDENTE" },
      _count: true,
    }),
  ]);

  const pendentePorTipo: Record<TipoRevisao, number> = {
    NOVO_PRODUTO: 0,
    ENRIQUECIMENTO_FALHOU: 0,
    CONFLITO: 0,
    CLASSIFICACAO_PENDENTE: 0,
    FABRICANTE_PENDENTE: 0,
    OUTRO: 0,
  };
  let pendenteTotal = 0;
  for (const r of byType) {
    pendentePorTipo[r.tipoRevisao] = r._count;
    pendenteTotal += r._count;
  }

  return {
    rows: items.map((it) => ({
      id: it.id,
      produtoId: it.produtoId,
      cnp: it.produto.cnp,
      designacao: it.produto.designacao,
      productType: it.produto.productType,
      productTypeConfidence: it.produto.productTypeConfidence,
      verificationStatus: it.produto.verificationStatus,
      needsManualReview: it.produto.needsManualReview,
      manualReviewReason: it.produto.manualReviewReason,
      tipoRevisao: it.tipoRevisao,
      prioridade: it.prioridade,
      estado: it.estado,
      dataCriacao: it.dataCriacao,
    })),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    counts: { pendentePorTipo, pendenteTotal },
  };
}

// ─── Detail ──────────────────────────────────────────────────────────────────

export type ReviewDetail = {
  revisao: {
    id: string;
    tipoRevisao: TipoRevisao;
    prioridade: PrioridadeRevisao;
    estado: EstadoFilaRevisao;
    dataCriacao: Date;
    dataResolucao: Date | null;
    dadosOrigem: unknown;
  } | null;
  produto: {
    id: string;
    cnp: number;
    designacao: string;
    estado: ProdutoEstado;
    fabricanteId: string | null;
    fabricanteNome: string | null;
    classificacaoNivel1Id: string | null;
    classificacaoNivel1Nome: string | null;
    classificacaoNivel2Id: string | null;
    classificacaoNivel2Nome: string | null;
    productType: string | null;
    productTypeConfidence: number | null;
    classificationSource: string | null;
    classificationVersion: string | null;
    verificationStatus: VerificationStatus;
    lastVerifiedAt: Date | null;
    externallyVerified: boolean;
    needsManualReview: boolean;
    manualReviewReason: string | null;
    validadoManualmente: boolean;
    tipoArtigo: string | null;
    codigoATC: string | null;
    dci: string | null;
    formaFarmaceutica: string | null;
    dosagem: string | null;
    embalagem: string | null;
    flagMSRM: boolean;
    flagMNSRM: boolean;
  };
  /**
   * Histórico recente de verificações. Mostrado para contexto — ajuda o
   * revisor a perceber se já houve tentativas anteriores.
   */
  historico: Array<{
    id: string;
    verificadoEm: Date;
    productType: string | null;
    productTypeConf: number | null;
    verificationStatus: string;
    fieldsUpdated: string[];
  }>;
};

/**
 * Carrega o detalhe de uma revisão. `id` pode ser:
 *   - id de FilaRevisao (mode="revisao", preferido, vindo da lista)
 *   - id de Produto (mode="produto", para abrir produto sem entrada na fila)
 *   - CNP numérico (mode="cnp", para entrar a partir de /catalogo)
 */
export async function loadReviewDetail(
  id: string,
  mode: "revisao" | "produto" | "cnp" = "revisao"
): Promise<ReviewDetail | null> {
  const prisma = await getPrisma();

  let produtoId: string;
  let revisao: ReviewDetail["revisao"] = null;

  if (mode === "revisao") {
    const r = await prisma.filaRevisao.findUnique({
      where: { id },
      select: {
        id: true,
        produtoId: true,
        tipoRevisao: true,
        prioridade: true,
        estado: true,
        dataCriacao: true,
        dataResolucao: true,
        dadosOrigem: true,
      },
    });
    if (!r) return null;
    produtoId = r.produtoId;
    revisao = {
      id: r.id,
      tipoRevisao: r.tipoRevisao,
      prioridade: r.prioridade,
      estado: r.estado,
      dataCriacao: r.dataCriacao,
      dataResolucao: r.dataResolucao,
      dadosOrigem: r.dadosOrigem,
    };
  } else if (mode === "cnp") {
    const cnp = Number(id);
    if (!Number.isFinite(cnp) || cnp <= 0) return null;
    const p = await prisma.produto.findUnique({
      where: { cnp },
      select: { id: true },
    });
    if (!p) return null;
    produtoId = p.id;
  } else {
    produtoId = id;
  }

  const p = await prisma.produto.findUnique({
    where: { id: produtoId },
    include: {
      fabricante: { select: { nomeNormalizado: true } },
      classificacaoNivel1: { select: { nome: true } },
      classificacaoNivel2: { select: { nome: true } },
    },
  });
  if (!p) return null;

  const historico = await prisma.produtoVerificacaoHistorico.findMany({
    where: { produtoId },
    orderBy: { verificadoEm: "desc" },
    take: 10,
    select: {
      id: true,
      verificadoEm: true,
      productType: true,
      productTypeConf: true,
      verificationStatus: true,
      fieldsUpdated: true,
    },
  });

  return {
    revisao,
    produto: {
      id: p.id,
      cnp: p.cnp,
      designacao: p.designacao,
      estado: p.estado,
      fabricanteId: p.fabricanteId,
      fabricanteNome: p.fabricante?.nomeNormalizado ?? null,
      classificacaoNivel1Id: p.classificacaoNivel1Id,
      classificacaoNivel1Nome: p.classificacaoNivel1?.nome ?? null,
      classificacaoNivel2Id: p.classificacaoNivel2Id,
      classificacaoNivel2Nome: p.classificacaoNivel2?.nome ?? null,
      productType: p.productType,
      productTypeConfidence: p.productTypeConfidence,
      classificationSource: p.classificationSource,
      classificationVersion: p.classificationVersion,
      verificationStatus: p.verificationStatus,
      lastVerifiedAt: p.lastVerifiedAt,
      externallyVerified: p.externallyVerified,
      needsManualReview: p.needsManualReview,
      manualReviewReason: p.manualReviewReason,
      validadoManualmente: p.validadoManualmente,
      tipoArtigo: p.tipoArtigo,
      codigoATC: p.codigoATC,
      dci: p.dci,
      formaFarmaceutica: p.formaFarmaceutica,
      dosagem: p.dosagem,
      embalagem: p.embalagem,
      flagMSRM: p.flagMSRM,
      flagMNSRM: p.flagMNSRM,
    },
    historico: historico.map((h) => ({
      id: h.id,
      verificadoEm: h.verificadoEm,
      productType: h.productType,
      productTypeConf: h.productTypeConf,
      verificationStatus: h.verificationStatus,
      fieldsUpdated: h.fieldsUpdated,
    })),
  };
}

// ─── Pickers ─────────────────────────────────────────────────────────────────

export type FabricanteOption = { id: string; nome: string };
export type ClassificacaoOption = { id: string; nome: string; paiId: string | null };

export async function loadFabricantes(limit = 500): Promise<FabricanteOption[]> {
  const prisma = await getPrisma();
  const rows = await prisma.fabricante.findMany({
    where: { estado: "ATIVO" },
    select: { id: true, nomeNormalizado: true },
    orderBy: { nomeNormalizado: "asc" },
    take: limit,
  });
  return rows.map((r) => ({ id: r.id, nome: r.nomeNormalizado }));
}

// ─── Evidência por produto ───────────────────────────────────────────────────

export type ProductEvidenceEntry = {
  id: string;
  source: string;
  status: EnrichmentSourceStatus;
  confidence: number | null;
  matchedBy: string | null;
  durationMs: number | null;
  fieldsReturned: string[];
  errorMessage: string | null;
  url: string | null;
  query: string | null;
  rawBrand: string | null;
  rawCategory: string | null;
  rawProductName: string | null;
  createdAt: Date;
};

/**
 * Histórico de chamadas a conectores externos para um produto, mais recente
 * primeiro. Mostrado no detalhe da revisão para o admin perceber:
 *   · que fontes foram consultadas
 *   · que URLs foram encontradas
 *   · que valores crus (marca, categoria, nome) cada fonte devolveu
 *   · onde a classificação actual veio
 *
 * Limitado a 50 entradas — chega para diagnóstico; as métricas agregadas
 * vivem em /admin/catalogo.
 */
export async function loadProductSourceEvidence(
  produtoId: string,
  limit = 50
): Promise<ProductEvidenceEntry[]> {
  const prisma = await getPrisma();
  const rows = await prisma.enrichmentSourceLog.findMany({
    where: { produtoId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    status: r.status,
    confidence: r.confidence,
    matchedBy: r.matchedBy,
    durationMs: r.durationMs,
    fieldsReturned: r.fieldsReturned,
    errorMessage: r.errorMessage,
    url: r.url,
    query: r.query,
    rawBrand: r.rawBrand,
    rawCategory: r.rawCategory,
    rawProductName: r.rawProductName,
    createdAt: r.createdAt,
  }));
}

export async function loadClassificacoes(): Promise<{
  nivel1: ClassificacaoOption[];
  nivel2: ClassificacaoOption[];
}> {
  const prisma = await getPrisma();
  const [n1, n2] = await Promise.all([
    prisma.classificacao.findMany({
      where: { tipo: "NIVEL_1", estado: "ATIVO" },
      select: { id: true, nome: true, classificacaoPaiId: true },
      orderBy: { nome: "asc" },
    }),
    prisma.classificacao.findMany({
      where: { tipo: "NIVEL_2", estado: "ATIVO" },
      select: { id: true, nome: true, classificacaoPaiId: true },
      orderBy: { nome: "asc" },
    }),
  ]);
  return {
    nivel1: n1.map((r) => ({ id: r.id, nome: r.nome, paiId: r.classificacaoPaiId })),
    nivel2: n2.map((r) => ({ id: r.id, nome: r.nome, paiId: r.classificacaoPaiId })),
  };
}
