import { AppShell } from "@/components/layout/app-shell";
import { CatalogoListClient } from "@/components/catalogo/catalogo-list-client";
import {
  clampPage,
  clampPageSize,
  DEFAULT_PAGE_SIZE,
  loadCatalogoFilterOptions,
  loadCatalogoListData,
  type CatalogoListFilters,
} from "@/lib/catalogo-data";
import type {
  ProdutoEstado,
  VerificationStatus,
} from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

const VALID_ESTADOS: ProdutoEstado[] = [
  "NOVO",
  "PENDENTE",
  "PARCIALMENTE_ENRIQUECIDO",
  "ENRIQUECIDO_AUTOMATICAMENTE",
  "VALIDADO",
  "INATIVO",
];

const VALID_VERIFICATION: VerificationStatus[] = [
  "PENDING",
  "IN_PROGRESS",
  "VERIFIED",
  "PARTIALLY_VERIFIED",
  "FAILED",
  "NEEDS_REVIEW",
];

const VALID_PRODUCT_TYPES = new Set([
  "MEDICAMENTO",
  "SUPLEMENTO",
  "DERMOCOSMETICA",
  "DISPOSITIVO_MEDICO",
  "HIGIENE_CUIDADO",
  "ORTOPEDIA",
  "PUERICULTURA",
  "VETERINARIA",
  "OUTRO",
]);

function asString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function parseFilters(
  sp: Record<string, string | string[] | undefined>,
): CatalogoListFilters {
  const estadoStr = asString(sp.estado);
  const estado =
    estadoStr && (VALID_ESTADOS as string[]).includes(estadoStr)
      ? (estadoStr as ProdutoEstado)
      : undefined;

  const verifStr = asString(sp.verif);
  const verificationStatus =
    verifStr && (VALID_VERIFICATION as string[]).includes(verifStr)
      ? (verifStr as VerificationStatus)
      : undefined;

  const tipoStr = asString(sp.tipo);
  const productType =
    tipoStr && VALID_PRODUCT_TYPES.has(tipoStr) ? tipoStr : undefined;

  return {
    search: asString(sp.q) || undefined,
    fabricanteId: asString(sp.fabricante) || undefined,
    classificacaoN1Id: asString(sp.n1) || undefined,
    productType,
    verificationStatus,
    estado,
    page: clampPage(Number(asString(sp.page) ?? 1)),
    pageSize: clampPageSize(Number(asString(sp.pageSize) ?? DEFAULT_PAGE_SIZE)),
  };
}

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function CatalogoPage({ searchParams }: Props) {
  const sp = await searchParams;
  const filters = parseFilters(sp);
  const [data, filterOptions] = await Promise.all([
    loadCatalogoListData(filters),
    loadCatalogoFilterOptions(),
  ]);

  return (
    <AppShell>
      <CatalogoListClient
        data={data}
        filters={filters}
        filterOptions={filterOptions}
      />
    </AppShell>
  );
}
