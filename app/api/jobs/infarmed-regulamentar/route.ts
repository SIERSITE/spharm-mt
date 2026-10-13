/**
 * app/api/jobs/infarmed-regulamentar/route.ts
 *
 * Atualização mensal (dia 2) dos dados regulamentares do INFARMED, para todos
 * os tenants ATIVOS. Disparada pelo scheduler; também invocável à mão por um
 * administrador (mesma autenticação por CRON_SECRET).
 *
 *   ?dryRun=1        simula (não escreve)
 *   ?forcar=1        reaplica uma versão já processada (ex.: após rollback deliberado)
 *   ?onlySlugs=a,b   restringe os tenants
 *
 * Sem `INFARMED_ALLPACKAGES_URL` responde 200 com estado NAO_CONFIGURADO e não
 * toca em nenhuma base. Ver `lib/regulamentar/infarmed-job.ts`.
 */

import { NextResponse, type NextRequest } from "next/server";
import { authorizeCronRequest } from "@/lib/jobs/cron-auth";
import { getControlPrismaCli } from "@/lib/sync/control-client-cli";
import { getTenantPrismaOrLegacy } from "@/lib/tenant-registry";
import { executarAtualizacaoInfarmed, type TenantAlvo } from "@/lib/regulamentar/infarmed-job";

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
  const apply = q.get("dryRun") !== "1";
  const forcar = q.get("forcar") === "1";
  const onlySlugs = q.get("onlySlugs")?.split(",").map((s) => s.trim()).filter(Boolean);

  const url = process.env.INFARMED_ALLPACKAGES_URL?.trim() || null;
  if (!url) {
    return NextResponse.json({
      ok: true,
      estado: "NAO_CONFIGURADO",
      message: "INFARMED_ALLPACKAGES_URL não configurado; nada foi feito.",
    });
  }

  const control = getControlPrismaCli();
  const ativos = await control.tenant.findMany({
    where: { estado: "ACTIVE", ...(onlySlugs ? { slug: { in: onlySlugs } } : {}) },
    select: { slug: true },
    orderBy: { slug: "asc" },
  });
  const tenants: TenantAlvo[] = [];
  for (const t of ativos) tenants.push({ slug: t.slug, prisma: await getTenantPrismaOrLegacy(t.slug) });

  const r = await executarAtualizacaoInfarmed({
    url,
    tenants,
    apply,
    forcar,
    origem: forcar || onlySlugs ? "MANUAL" : "MENSAL",
    log: (m) => console.log(m),
  });
  const falhou = r.estado === "FALHA_DOWNLOAD" || r.estado === "FALHA_VALIDACAO" || r.tenants.some((t) => t.erro);
  return NextResponse.json({ ok: !falhou, durationMs: Date.now() - t0, ...r }, { status: falhou ? 502 : 200 });
}

export const GET = handle;
export const POST = handle;
