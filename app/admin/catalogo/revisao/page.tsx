import {
  loadReviewListData,
  REVIEW_PAGE_SIZE,
  type ReviewListFilters,
} from "@/lib/admin/catalog-review-data";
import { CatalogReviewList } from "@/components/admin/catalog-review-list";
import type {
  EstadoFilaRevisao,
  PrioridadeRevisao,
  TipoRevisao,
} from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

const VALID_TIPOS: TipoRevisao[] = [
  "NOVO_PRODUTO",
  "ENRIQUECIMENTO_FALHOU",
  "CONFLITO",
  "CLASSIFICACAO_PENDENTE",
  "FABRICANTE_PENDENTE",
  "OUTRO",
];

const VALID_PRIORIDADES: PrioridadeRevisao[] = ["ALTA", "MEDIA", "BAIXA"];
const VALID_ESTADOS: EstadoFilaRevisao[] = ["PENDENTE", "RESOLVIDO", "IGNORADO"];

function asString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function parseFilters(
  sp: Record<string, string | string[] | undefined>
): ReviewListFilters {
  const tipoStr = asString(sp.tipo);
  const tipoRevisao =
    tipoStr && (VALID_TIPOS as string[]).includes(tipoStr)
      ? (tipoStr as TipoRevisao)
      : undefined;

  const prioStr = asString(sp.prioridade);
  const prioridade =
    prioStr && (VALID_PRIORIDADES as string[]).includes(prioStr)
      ? (prioStr as PrioridadeRevisao)
      : undefined;

  const estadoStr = asString(sp.estado);
  const estado =
    estadoStr && (VALID_ESTADOS as string[]).includes(estadoStr)
      ? (estadoStr as EstadoFilaRevisao)
      : undefined;

  const pageRaw = Number(asString(sp.page) ?? 1);
  const sizeRaw = Number(asString(sp.pageSize) ?? REVIEW_PAGE_SIZE);

  return {
    tipoRevisao,
    prioridade,
    estado,
    search: asString(sp.q) || undefined,
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1,
    pageSize: Number.isFinite(sizeRaw) && sizeRaw > 0 ? Math.floor(sizeRaw) : REVIEW_PAGE_SIZE,
  };
}

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function CatalogReviewPage({ searchParams }: Props) {
  // O layout /admin já chama requirePlatformAdmin; nada a fazer aqui.
  const sp = await searchParams;
  const filters = parseFilters(sp);
  const data = await loadReviewListData(filters);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">Revisão de catálogo</h1>
        <p className="mt-1 text-sm text-slate-600">
          Produtos com classificação automática que precisam de validação manual.
          A correcção aqui é a fonte de verdade — bloqueia overrides automáticos
          futuros via{" "}
          <code className="rounded bg-slate-100 px-1 py-0.5 text-[11px]">
            validadoManualmente
          </code>
          .
        </p>
      </header>

      <CatalogReviewList data={data} filters={filters} />
    </div>
  );
}
