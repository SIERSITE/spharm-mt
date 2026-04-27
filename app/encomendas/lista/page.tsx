import { MainShell } from "@/components/layout/main-shell";
import { requirePermission } from "@/lib/permissions";
import {
  clampPage,
  clampPageSize,
  DEFAULT_PAGE_SIZE,
  loadOrderListData,
  type OrderListFilters,
} from "@/lib/encomendas/orders-data";
import { OrderListClient } from "@/components/encomendas/order-list-client";
import type { OrderExportState, EstadoListaEncomenda } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

const VALID_ESTADOS: EstadoListaEncomenda[] = ["RASCUNHO", "FINALIZADA", "EXPORTADA"];
const VALID_ESTADO_EXPORT: OrderExportState[] = [
  "PENDENTE",
  "EM_EXPORTACAO",
  "EXPORTADO",
  "FALHADO",
  "CANCELADO",
];

function asString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function asDate(v: string | undefined, endOfDay = false): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return undefined;
  if (endOfDay) d.setHours(23, 59, 59, 999);
  return d;
}

function parseFilters(
  sp: Record<string, string | string[] | undefined>
): OrderListFilters {
  const estadoStr = asString(sp.estado);
  const estado =
    estadoStr && (VALID_ESTADOS as string[]).includes(estadoStr)
      ? (estadoStr as EstadoListaEncomenda)
      : undefined;

  const estadoExportStr = asString(sp.export);
  const estadoExport =
    estadoExportStr && (VALID_ESTADO_EXPORT as string[]).includes(estadoExportStr)
      ? (estadoExportStr as OrderExportState)
      : undefined;

  return {
    farmaciaId: asString(sp.farmacia) || undefined,
    estado,
    estadoExport,
    search: asString(sp.q) || undefined,
    dateFrom: asDate(asString(sp.from)),
    dateTo: asDate(asString(sp.to), true),
    page: clampPage(Number(asString(sp.page) ?? 1)),
    pageSize: clampPageSize(Number(asString(sp.pageSize) ?? DEFAULT_PAGE_SIZE)),
  };
}

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ListaEncomendasPage({ searchParams }: Props) {
  await requirePermission("reports.write");
  const sp = await searchParams;
  const filters = parseFilters(sp);
  const data = await loadOrderListData(filters);

  return (
    <MainShell>
      <div className="mx-auto max-w-7xl px-6 py-8">
        <h1 className="text-2xl font-semibold text-gray-900">Encomendas</h1>
        <p className="mt-1 text-sm text-gray-600">
          Lista de encomendas criadas. Finalize rascunhos, acompanhe o estado de exportação e
          simule respostas do agent.
        </p>
        <div className="mt-6">
          <OrderListClient data={data} filters={filters} />
        </div>
      </div>
    </MainShell>
  );
}
