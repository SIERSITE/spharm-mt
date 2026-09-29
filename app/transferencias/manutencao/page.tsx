import { MainShell } from "@/components/layout/main-shell";
import { can, requirePermission } from "@/lib/permissions";
import { getPrisma } from "@/lib/prisma";
import {
  clampPage,
  clampPageSize,
  DEFAULT_PAGE_SIZE,
  farmaciaScopeFromSession,
  loadTransferenciasManutencao,
  type TransferenciaManutencaoFilters,
} from "@/lib/transferencias/manutencao-data";
import { TransferenciaManutencaoClient } from "@/components/transferencias/transferencia-manutencao-client";
import type { EstadoTransferencia } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

const VALID_ESTADOS: EstadoTransferencia[] = ["RASCUNHO", "FINALIZADA", "ANULADA", "ELIMINADA"];

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

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function TransferenciasManutencaoPage({ searchParams }: Props) {
  // Mesma permissão de /transferencias e /encomendas — gerar/gerir
  // transferências é a mesma área de decisão, não uma área à parte.
  const session = await requirePermission("reports.write");
  const sp = await searchParams;

  const estadoStr = asString(sp.estado);
  const estado =
    estadoStr && (VALID_ESTADOS as string[]).includes(estadoStr)
      ? (estadoStr as EstadoTransferencia)
      : undefined;

  const filters: TransferenciaManutencaoFilters = {
    scope: farmaciaScopeFromSession(session),
    search: asString(sp.q) || undefined,
    farmaciaOrigemId: asString(sp.origem) || undefined,
    farmaciaDestinoId: asString(sp.destino) || undefined,
    estado,
    dateFrom: asDate(asString(sp.from)),
    dateTo: asDate(asString(sp.to), true),
    page: clampPage(Number(asString(sp.page) ?? 1)),
    pageSize: clampPageSize(Number(asString(sp.pageSize) ?? DEFAULT_PAGE_SIZE)),
  };

  const prisma = await getPrisma();
  const data = await loadTransferenciasManutencao(prisma, filters);

  // Mesma gate de `deleteTransferenciaAction`/`anularTransferenciaAction`
  // — os botões "Eliminar" e "Anular" só aparecem a quem a acção aceitaria.
  const podeGerir = can(session, "settings.global");

  return (
    <MainShell>
      <div className="py-8">
        <h1 className="text-2xl font-semibold text-gray-900">Transferências — Manutenção</h1>
        <p className="mt-1 text-sm text-gray-600">
          Procure, reveja e faça a manutenção de transferências entre farmácias já criadas.
        </p>
        <div className="mt-6">
          <TransferenciaManutencaoClient
            data={data}
            filters={filters}
            podeEliminar={podeGerir}
            podeAnular={podeGerir}
          />
        </div>
      </div>
    </MainShell>
  );
}
