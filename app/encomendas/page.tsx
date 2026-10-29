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
import { lerChavesForma } from "@/lib/catalog/forma-farmaceutica-filtro";
import { carregarOpcoesFormaFarmaceutica } from "@/lib/catalog/forma-farmaceutica-sql";
import { OrderListClient } from "@/components/encomendas/order-list-client";
import type { OrderExportState, EstadoListaEncomenda } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

const VALID_ESTADOS: EstadoListaEncomenda[] = ["RASCUNHO", "FINALIZADA", "EXPORTADA", "ANULADA"];
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

  // `anuladas=1`: mostrar também as anuladas. Sem efeito com um estado
  // escolhido (a combinação seria redundante ou impossível) — a URL
  // canónica nunca leva os dois.
  const mostrarAnuladas = !estado && asString(sp.anuladas) === "1";

  return {
    farmaciaId: asString(sp.farmacia) || undefined,
    estado,
    mostrarAnuladas,
    estadoExport,
    search: asString(sp.q) || undefined,
    dateFrom: asDate(asString(sp.from)),
    dateTo: asDate(asString(sp.to), true),
    // `forma` repetido na URL (como em /stock): chaves normalizadas, re-normalizadas e limitadas por `lerChavesForma`.
    formas: lerChavesForma(sp.forma),
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
  // Opções do filtro «Forma farmacêutica»: UMA agregação, em paralelo com a lista (que já traz o filtro aplicado).
  const [data, formasOpcoes] = await Promise.all([
    loadOrderListData(prisma, filters),
    carregarOpcoesFormaFarmaceutica(prisma),
  ]);
  // Mesma gate de `cancelOutboxAction`/`deleteListaEncomendaAction`/
  // `anularListaEncomendaAction` — calculada aqui para os botões
  // "Eliminar"/"Anular" nunca aparecerem a quem a server action recusaria
  // (a mesma inconsistência que existia com ACK/NACK, visíveis a qualquer
  // GESTOR_FARMACIA mas recusados pela acção, que exigia settings.global).
  const podeEliminar = can(session, "settings.global");
  const podeAnular = podeEliminar;

  return (
    <MainShell>
      <div className="py-8">
        <h1 className="text-2xl font-semibold text-gray-900">Encomendas</h1>
        <p className="mt-1 text-sm text-gray-600">
          Lista de encomendas criadas. Finalize rascunhos e acompanhe o estado de exportação.
        </p>
        <div className="mt-6">
          <OrderListClient data={data} filters={filters} formasOpcoes={formasOpcoes} podeEliminar={podeEliminar} podeAnular={podeAnular} />
        </div>
      </div>
    </MainShell>
  );
}
