import { NextResponse, type NextRequest } from "next/server";
import { withIntegrationAuthParams } from "@/lib/integracao/auth";
import { cancelOutboxRow } from "@/lib/integracao/outbox-admin";

type RouteCtx = { params: Promise<{ outboxId: string }> };

export const POST = withIntegrationAuthParams<RouteCtx>(async (ctx, req, routeCtx) => {
  const { outboxId } = await routeCtx.params;
  const body = (await req.json().catch(() => ({}))) as { reason?: string };
  const result = await cancelOutboxRow(
    ctx.prisma,
    outboxId,
    null,
    body.reason ?? null
  );
  if (!result.ok) {
    return NextResponse.json(
      { error: result.code, message: result.error },
      { status: result.code === "not_found" ? 404 : 409 }
    );
  }
  return NextResponse.json(result);
});
