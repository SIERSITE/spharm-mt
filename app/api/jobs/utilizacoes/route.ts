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
 *      trabalho: quando o catálogo mudou depois do último backfill e já
 *      passou o intervalo mínimo. Sem isso, um tenant parado não paga
 *      nada.
 *
 * PORQUE NÃO HÁ FILA
 *
 * O estado necessário já existe: `max(Produto.dataAtualizacao)` e
 * `CatalogoBackfillRun.executadoEm`. Comparar os dois é mais robusto do
 * que uma tabela de pedidos — um pedido perdido não existe (a passagem
 * seguinte recupera) e um duplicado não faz nada.
 *
 * Isto já foi `IngestProdutoRun.finalizadaEm` e estava errado: só o
 * `products-upload` fecha corrida, a sincronização diária é um upload
 * delta que não a fecha (nem deve — o `/finalize` dispara o sweep de
 * retirados), e o resultado era o backfill nunca correr em produção.
 * Ver `precisaBackfill` em `lib/catalog/utilizacoes-ciclo.ts`.
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
import { whereCnpCatalogavel } from "@/lib/catalog/cnp-catalogavel";

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

      // Instantes que decidem se há trabalho.
      //
      // `max(Produto.dataAtualizacao)` e não `IngestProdutoRun`: a
      // justificação completa está em `precisaBackfill`. Em resumo — a
      // sincronização diária é um upload DELTA e nunca fecha corrida,
      // portanto "corrida finalizada" nunca acontecia em produção e o
      // backfill nunca corria. Esta coluna sobe com qualquer escrita no
      // catálogo, venha ela do delta diário, do upload completo, dos
      // campos do ERP ou da projecção do catálogo global.
      //
      // Não há índice em `dataAtualizacao` e esta leitura é um seq scan:
      // medido em produção (garantia, 35 525 produtos) dá 24 ms com tudo
      // em cache. A 3 tenants de 10 em 10 minutos não justifica uma
      // migração — se um dia justificar, o sintoma será o tempo deste
      // job a subir com o tamanho do catálogo, e o índice é
      // `@@index([dataAtualizacao])` em `Produto`.
      const [ultimoProduto, ultimoBackfill] = await Promise.all([
        prisma.produto.findFirst({
          where: { cnp: whereCnpCatalogavel() },
          orderBy: { dataAtualizacao: "desc" },
          select: { dataAtualizacao: true },
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
          ultimaAlteracaoCatalogo: ultimoProduto?.dataAtualizacao ?? null,
          ultimoBackfillEm: ultimoBackfill?.executadoEm ?? null,
        });

      if (!haTrabalho) {
        resultados.push({
          slug: tenant.slug,
          seed,
          backfill: { corrido: false, motivo: "catálogo sem alterações novas, ou varrido há menos do que o intervalo mínimo" },
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
