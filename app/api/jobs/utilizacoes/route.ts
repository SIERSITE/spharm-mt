/**
 * app/api/jobs/utilizacoes/route.ts
 *
 * Mantém a faceta de Utilizações em dia, sem ninguém ter de correr nada.
 *
 * Duas fases por tenant ACTIVE, ambas idempotentes:
 *
 *   1. SEED — alinha o vocabulário com `lib/catalog/utilizacoes.ts`.
 *      Corre sempre: é barato (56 upserts) e é o que garante que um
 *      tenant criado há cinco minutos já tem vocabulário sem intervenção
 *      humana.
 *
 *   2. BACKFILL — aplica as regras ao catálogo, mas SÓ se houver
 *      trabalho: quando o último `products-upload` fechou depois do
 *      último backfill. Sem isso, um tenant parado não paga nada.
 *
 * PORQUE NÃO HÁ FILA
 *
 * O estado necessário já existe: `IngestProdutoRun.finalizadaEm` e
 * `CatalogoBackfillRun.executadoEm`. Comparar os dois é mais robusto do
 * que uma tabela de pedidos — um pedido perdido não existe (a passagem
 * seguinte recupera), um duplicado não faz nada, e o `/finalize` não
 * ganha escrita nenhuma no caminho crítico do upload.
 *
 * PORQUE NÃO CORRE DENTRO DO UPLOAD
 *
 * O backfill lê o catálogo inteiro do tenant. Metê-lo no request do
 * `/finalize` faria o upload durar mais e passar a depender dele: um erro
 * de classificação abortaria uma ingestão que já estava concluída e
 * correcta. Aqui, uma falha de backfill não desfaz nada — na passagem
 * seguinte tenta outra vez.
 *
 * Auth: `authorizeCronRequest`, como os restantes /api/jobs/*.
 *
 * Manual:
 *   curl -i "http://web:3000/api/jobs/utilizacoes?secret=$CRON_SECRET"
 *   curl -i "...&onlySlugs=silveira"     — só um tenant
 *   curl -i "...&force=1"                — backfill mesmo sem upload novo
 *   curl -i "...&seedOnly=1"             — só o vocabulário
 */

import { NextResponse, type NextRequest } from "next/server";
import { authorizeCronRequest } from "@/lib/jobs/cron-auth";
import { forEachActiveTenant } from "@/lib/tenancy/for-each-tenant";
import {
  backfillUtilizacoes,
  precisaBackfill,
  seedUtilizacoes,
} from "@/lib/catalog/utilizacoes-ciclo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type ResultadoTenant = {
  slug: string;
  seed: { novas: number; actualizadas: number; desactivadas: number };
  backfill:
    | { corrido: false; motivo: string }
    | { corrido: true; coberturaPercent: number; associacoes: number; escritas: number; recusadas: number };
};

export async function GET(req: NextRequest) {
  const auth = authorizeCronRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.reason }, { status: 401 });
  }

  const url = new URL(req.url);
  const onlySlugs = url.searchParams.get("onlySlugs")?.split(",").map((s) => s.trim()).filter(Boolean);
  const force = url.searchParams.get("force") === "1";
  const seedOnly = url.searchParams.get("seedOnly") === "1";

  const t0 = Date.now();
  const resultados: ResultadoTenant[] = [];

  const summary = await forEachActiveTenant(
    async ({ tenant, prisma }) => {
      const seed = await seedUtilizacoes(prisma);

      if (seedOnly) {
        resultados.push({ slug: tenant.slug, seed, backfill: { corrido: false, motivo: "seedOnly" } });
        return;
      }

      // Instantes que decidem se há trabalho. Uma corrida ABERTA não
      // conta: o upload ainda está a decorrer e classificar a meio daria
      // um retrato falso que a passagem seguinte teria de refazer.
      const [ultimoUpload, ultimoBackfill] = await Promise.all([
        prisma.ingestProdutoRun.findFirst({
          where: { estado: "FINALIZADA" },
          orderBy: { finalizadaEm: "desc" },
          select: { finalizadaEm: true },
        }),
        prisma.catalogoBackfillRun.findFirst({
          where: { kind: "utilizacoes" },
          orderBy: { executadoEm: "desc" },
          select: { executadoEm: true },
        }),
      ]);

      const haTrabalho =
        force ||
        precisaBackfill({
          ultimoUploadFinalizadoEm: ultimoUpload?.finalizadaEm ?? null,
          ultimoBackfillEm: ultimoBackfill?.executadoEm ?? null,
        });

      if (!haTrabalho) {
        resultados.push({
          slug: tenant.slug,
          seed,
          backfill: { corrido: false, motivo: "sem uploads novos desde o último backfill" },
        });
        return;
      }

      const r = await backfillUtilizacoes(prisma, { versaoRegras: process.env.APP_REVISION ?? null });
      resultados.push({
        slug: tenant.slug,
        seed,
        backfill: {
          corrido: true,
          coberturaPercent: r.coberturaPercent,
          associacoes: r.associacoes,
          escritas: r.escritas,
          recusadas: r.recusadas,
        },
      });
    },
    { onlySlugs, parallelLimit: 1 },
  );

  return NextResponse.json({
    ok: summary.failed === 0,
    tenants: summary.total,
    succeeded: summary.succeeded,
    failed: summary.failed,
    failures: summary.failures,
    resultados,
    durationMs: Date.now() - t0,
  });
}
