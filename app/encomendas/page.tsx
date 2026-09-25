import { MainShell } from "@/components/layout/main-shell";
import { can, requirePermission } from "@/lib/permissions";
import { getPrisma } from "@/lib/prisma";
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

export default async function EncomendasPage({ searchParams }: Props) {
  const session = await requirePermission("reports.write");
  const sp = await searchParams;
  const filters = parseFilters(sp);
  const prisma = await getPrisma();
  const data = await loadOrderListData(prisma, filters);
  // Mesma gate de `cancelOutboxAction`/`deleteListaEncomendaAction` —
  // calculada aqui para o botão "Eliminar" nunca aparecer a quem a
  // server action recusaria (a mesma inconsistência que existia com
  // ACK/NACK, visíveis a qualquer GESTOR_FARMACIA mas recusados pela
  // acção, que exigia settings.global).
  const podeEliminar = can(session, "settings.global");

  return (
    <MainShell>
      <div className="py-8">
        <h1 className="text-2xl font-semibold text-gray-900">Encomendas</h1>
        <p className="mt-1 text-sm text-gray-600">
          Lista de encomendas criadas. Finalize rascunhos e acompanhe o estado de exportação.
        </p>
        <div className="mt-6">
          <OrderListClient data={data} filters={filters} podeEliminar={podeEliminar} />
        </div>
      </div>
    </MainShell>
  );
}
