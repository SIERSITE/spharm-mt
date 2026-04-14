import { NextResponse, type NextRequest } from "next/server";
import { withIntegrationAuth } from "@/lib/integracao/auth";
import { retryOutboxRow } from "@/lib/integracao/outbox-admin";

type RouteCtx = { params: Promise<{ outboxId: string }> };

export const POST = withIntegrationAuth<RouteCtx>(async (ctx, req, routeCtx) => {
  const { outboxId } = await routeCtx.params;
  const result = await retryOutboxRow(ctx.prisma, outboxId, null);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.code, message: result.error },
      { status: result.code === "not_found" ? 404 : 409 }
    );
  }
  return NextResponse.json(result);
});
