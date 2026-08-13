/**
 * app/api/ingest/v1/pipeline/dias-concluidos/route.ts
 *
 * GET /api/ingest/v1/pipeline/dias-concluidos
 *     ?farmaciaId=<cuid>&from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Que dias é que o pipeline diário já concluiu com sucesso nesta
 * farmácia. Read-only. É a fonte de verdade do catch-up do agent: um
 * dia só conta como feito se o registo dele chegou aqui.
 *
 * ── Porquê sob /api/ingest/v1/ e não /api/admin/pipeline/ ─────────
 *
 * Por causa do proxy. `/api/admin/*` está fechado no domínio dos
 * Agents e só três rotas exactas estão na allowlist; uma quarta
 * obrigaria a mais uma `location =` no nginx dos dois vhosts, e a
 * activação ficava dependente de um deploy de configuração. O prefixo
 * `/api/ingest/` já é `^~` allowlisted e já entrega o `X-Tenant-Slug`,
 * portanto esta rota funciona no dia em que a aplicação sobe.
 *
 * Isto também é o sítio certo em termos de contrato: quem chama é o
 * agent, com a ingest key, e não um administrador.
 *
 * Auth: withIntegrationAuth (Bearer <ingestKey> + X-Tenant-Slug).
 *
 * Response 200:
 *   { ok: true, farmaciaId, from, to, dias: ["2026-08-10", ...] }
 *
 * `dias` traz apenas `status="OK"` e `kind="daily-pipeline"`, ordenado.
 * Uma corrida ERROR ou ABORTED não aparece — é precisamente um dia a
 * repetir.
 */

import { NextResponse, type NextRequest } from "next/server";
import { withIntegrationAuth } from "@/lib/integracao/auth";
import { assertFarmaciaInTenant } from "@/lib/ingest/bootstrap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `YYYY-MM-DD` e uma data que existe (rejeita 2026-02-31). */
function diaValido(v: string | null): v is string {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/**
 * Tecto de dias por consulta. O agent pede uma janela pequena (o seu
 * limite de catch-up); este limite existe só para que um cliente
 * enganado não peça dez anos e faça um table scan.
 */
const MAX_JANELA_DIAS = 400;

export const GET = withIntegrationAuth(async (ctx, req: NextRequest) => {
  const url = new URL(req.url);
  const farmaciaId = url.searchParams.get("farmaciaId");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  if (!farmaciaId) {
    return NextResponse.json({ error: "missing_farmacia_id" }, { status: 400 });
  }
  if (!diaValido(from) || !diaValido(to)) {
    return NextResponse.json(
      { error: "invalid_range", detail: "from/to em falta ou não são YYYY-MM-DD válidos" },
      { status: 400 },
    );
  }
  if (from > to) {
    return NextResponse.json({ error: "invalid_range", detail: "from > to" }, { status: 400 });
  }
  const spanDias =
    Math.round(
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
    ) + 1;
  if (spanDias > MAX_JANELA_DIAS) {
    return NextResponse.json(
      { error: "range_too_large", detail: `máximo ${MAX_JANELA_DIAS} dias, pedidos ${spanDias}` },
      { status: 400 },
    );
  }

  // Isolamento por tenant: a farmácia tem de pertencer a quem
  // autenticou. Sem isto, uma ingest key válida podia ler o calendário
  // de corridas de outro tenant.
  await assertFarmaciaInTenant(ctx.prisma, farmaciaId);

  // `dateRef` é uma string YYYY-MM-DD para as corridas diárias, portanto
  // a comparação lexicográfica é a cronológica. As corridas de agregação
  // usam YYYY-MM no mesmo campo — ficam de fora pelo filtro do `kind`.
  const runs = await ctx.prisma.pipelineRun.findMany({
    where: {
      farmaciaId,
      kind: "daily-pipeline",
      status: "OK",
      dateRef: { gte: from, lte: to },
    },
    select: { dateRef: true },
    distinct: ["dateRef"],
    orderBy: { dateRef: "asc" },
  });

  const dias = runs
    .map((r) => r.dateRef)
    .filter((d): d is string => typeof d === "string" && d.length === 10);

  return NextResponse.json({ ok: true, farmaciaId, from, to, dias });
});
