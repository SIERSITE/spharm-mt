import type { OrderExportState } from "@/generated/prisma/client";

/**
 * Badge visual para o estado de exportação de uma lista de encomenda.
 * Componente client-safe — não importa Prisma runtime, só o tipo.
 */
type Props = {
  state: OrderExportState;
  spharmDocumentId?: string | null;
  exportedAt?: Date | string | null;
};

const STYLES: Record<OrderExportState, { label: string; cls: string }> = {
  PENDENTE: {
    label: "pendente",
    cls: "bg-amber-50 text-amber-700 border-amber-200",
  },
  EM_EXPORTACAO: {
    label: "em exportação",
    cls: "bg-cyan-50 text-cyan-700 border-cyan-200",
  },
  EXPORTADO: {
    label: "exportado",
    cls: "bg-emerald-50 text-emerald-700 border-emerald-200",
  },
  FALHADO: {
    label: "falhado",
    cls: "bg-rose-50 text-rose-700 border-rose-200",
  },
  CANCELADO: {
    label: "cancelado",
    cls: "bg-slate-50 text-slate-600 border-slate-200",
  },
};

export function OrderExportBadge({ state, spharmDocumentId, exportedAt }: Props) {
  const s = STYLES[state];
  const suffix =
    state === "EXPORTADO" && spharmDocumentId
      ? ` · ${spharmDocumentId}`
      : "";
  const when =
    state === "EXPORTADO" && exportedAt
      ? new Date(exportedAt).toLocaleString("pt-PT", {
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        })
      : null;
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${s.cls}`}
      title={when ?? undefined}
    >
      {s.label}
      {suffix}
    </span>
  );
}
