import { NextResponse, type NextRequest } from "next/server";
import type { OrderExportState } from "@/generated/prisma/client";
import { withIntegrationAuth } from "@/lib/integracao/auth";

/**
 * GET /api/outbox/v1/orders/list?state=FALHADO&limit=100&farmaciaId=...
 *
 * Utilitário read-only — usado pela admin UI e por scripts de
 * monitorização para inspeccionar o outbox sem ter de abrir a BD
 * directamente.
 */
const VALID_STATES = new Set<OrderExportState>([
  "PENDENTE",
  "EM_EXPORTACAO",
  "EXPORTADO",
  "FALHADO",
  "CANCELADO",
]);

export const GET = withIntegrationAuth(async (ctx, req) => {
  const url = new URL(req.url);
  const state = url.searchParams.get("state") as OrderExportState | null;
  const farmaciaId = url.searchParams.get("farmaciaId");
  const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit") ?? "100")), 500);

  const where: {
    state?: OrderExportState;
    farmaciaId?: string;
  } = {};
  if (state && VALID_STATES.has(state)) where.state = state;
  if (farmaciaId) where.farmaciaId = farmaciaId;

  const rows = await ctx.prisma.orderOutbox.findMany({
    where,
    orderBy: [{ createdAt: "desc" }],
    take: limit,
    select: {
      id: true,
      listaEncomendaId: true,
      farmaciaId: true,
      state: true,
      attemptCount: true,
      nextAttemptAt: true,
      lastError: true,
      lastAttemptAt: true,
      leasedBy: true,
      leasedUntil: true,
      spharmDocumentId: true,
      exportedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return NextResponse.json({ count: rows.length, orders: rows });
});
