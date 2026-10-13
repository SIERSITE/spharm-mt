/**
 * app/api/jobs/infarmed-regulamentar/route.ts
 *
 * Atualização mensal (dia 1, Europe/Lisbon) dos dados regulamentares do
 * INFARMED, para todos os tenants ATIVOS. Disparada pelo scheduler; também
 * invocável à mão por um administrador (mesma autenticação por CRON_SECRET).
 *
 *   ?dryRun=1        simula (não escreve nada: nem dados, nem ledger, nem emails)
 *   ?forcar=1        reaplica uma versão já processada (ex.: após rollback deliberado)
 *   ?onlySlugs=a,b   repete só para estes tenants (retry de um tenant falhado)
 *
 * O ficheiro é descarregado UMA vez (formulário público do INFARMED, ou
 * `INFARMED_ALLPACKAGES_URL` se definido) e aplicado a cada tenant. Se falhar,
 * a versão ativa fica intacta, o mês não fica concluído e é enviado UM email
 * (ver `lib/regulamentar/infarmed-atualizacao.ts`).
 */

import { NextResponse, type NextRequest } from "next/server";
import { authorizeCronRequest } from "@/lib/jobs/cron-auth";
import { executarAtualizacaoAutomatica } from "@/lib/regulamentar/infarmed-atualizacao";
import { criarDependenciasReais } from "@/lib/regulamentar/infarmed-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handle(req: NextRequest): Promise<Response> {
  const t0 = Date.now();
  const auth = authorizeCronRequest(req);
  if (!auth.ok) {
    const missing = auth.reason === "missing_env";
    return NextResponse.json(
      missing
        ? { ok: false, error: "server_misconfigured", message: "CRON_SECRET not configured" }
        : { ok: false, error: "unauthorized" },
      { status: missing ? 503 : 401 },
    );
  }
  const q = req.nextUrl.searchParams;
  const onlySlugs = q.get("onlySlugs")?.split(",").map((s) => s.trim()).filter(Boolean);
  try {
    const r = await executarAtualizacaoAutomatica(criarDependenciasReais(), {
      dryRun: q.get("dryRun") === "1",
      forcar: q.get("forcar") === "1",
      onlySlugs,
    });
    const falhou = r.estado === "FALHADA" || r.estado === "PARCIAL";
    return NextResponse.json({ ok: !falhou, durationMs: Date.now() - t0, ...r }, { status: falhou ? 502 : 200 });
  } catch (e) {
    console.error("[api/jobs/infarmed-regulamentar] erro inesperado", e);
    return NextResponse.json({ ok: false, error: "unexpected", message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
