/**
 * app/api/ingest/v1/bootstrap/products/finalize/route.ts
 *
 * POST /api/ingest/v1/bootstrap/products/finalize
 *
 * Sweep pós-`products-upload` por farmácia. Marca como `flagRetirado=true`
 * todas as linhas `ProdutoFarmacia(farmaciaId=X)` cuja `dataAtualizacao`
 * é estritamente anterior ao `runStartedAt` declarado pelo agent — i.e.,
 * produtos que existiam em corridas passadas mas que **não vieram nesta**.
 *
 * Modelo canónico fechado em 2026-06:
 *
 *   1. O agent `products-upload` lê `dbo.Stocks` com `Retirado=0 AND
 *      Processa_Stocks<>0`. Linhas que falham o filtro **não são enviadas**.
 *
 *   2. Para cada linha enviada, `/bootstrap/products` faz UPSERT em
 *      `ProdutoFarmacia` com `flagRetirado = payload.retirado` (sempre
 *      `false` enquanto o agent só envia activos) e mexe em
 *      `dataAtualizacao` (Prisma `@updatedAt`).
 *
 *   3. No fim de uma corrida bem-sucedida, o agent chama este endpoint
 *      com `{ farmaciaId, runStartedAt }`. Todas as linhas com
 *      `dataAtualizacao < <corte>` E `flagRetirado=false` viram
 *      `flagRetirado=true` — assinala "saiu do universo do ERP".
 *
 * O CORTE NÃO É O `runStartedAt` DO AGENT.
 *
 * Esse valor vem do relógio de um PC de farmácia, sem NTP garantido. Com
 * o relógio adiantado, as linhas escritas por esta mesma corrida ficam
 * com `dataAtualizacao` anterior ao corte e o sweep retira o catálogo
 * inteiro que acabou de ser carregado — respondendo `ok: true`. O corte é
 * `IngestProdutoRun.startedAtServer`, escrito pelo relógio da base no
 * primeiro batch. O `runStartedAt` do agent é aceite, devolvido na
 * resposta e registado, mas não entra em nenhum WHERE.
 *
 *   4. Quando um produto regressa ao ERP, o UPSERT do `/bootstrap/products`
 *      define `flagRetirado=false` (vindo do payload) e a linha é
 *      reactivada automaticamente.
 *
 * Idempotente:
 *   - Re-correr com o mesmo `runStartedAt` não faz nada (as linhas que
 *     iam ser marcadas já têm `flagRetirado=true` e/ou `dataAtualizacao`
 *     posterior — o WHERE elimina-as).
 *   - Re-correr com `runStartedAt` mais antigo faz menos UPDATEs (idem).
 *
 * Auth: idêntica a `/bootstrap/products` (Bearer + X-Tenant-Slug).
 * Gated por `ENABLE_AGENT_BOOTSTRAP=1`.
 *
 * Body:
 *   {
 *     farmaciaId: string,
 *     runStartedAt: string (ISO 8601)
 *   }
 *
 * Response 200:
 *   {
 *     ok: true,
 *     farmaciaId: string,
 *     runStartedAt: string,
 *     corteServidor: string,  // o corte REAL, do relógio da base
 *     produtosRecebidos: number,
 *     activosAntes: number,
 *     retiredCount: number,   // linhas que transitaram false→true
 *     durationMs: number
 *   }
 *
 * Response 409:
 *   · `sem_corrida_aberta` — não houve upload observado pelo servidor
 *   · `sweep_anormal` — o sweep apanharia uma fatia implausível do
 *     universo activo (ver avaliarSweep em lib/ingest/produto-run.ts)
 */

import { NextResponse } from "next/server";
import { withIntegrationAuth } from "@/lib/integracao/auth";
import {
  assertBootstrapEnabled,
  assertFarmaciaInTenant,
} from "@/lib/ingest/bootstrap";
import { avaliarSweep } from "@/lib/ingest/produto-run";
import { Prisma } from "@/generated/prisma/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type FinalizePayload = {
  farmaciaId?: unknown;
  runStartedAt?: unknown;
};

type SuccessPayload = {
  ok: true;
  farmaciaId: string;
  /** Ecoado do pedido. Telemetria: não decide nada. */
  runStartedAt: string;
  /** O corte real, medido pelo relógio da base. */
  corteServidor: string;
  produtosRecebidos: number;
  activosAntes: number;
  retiredCount: number;
  durationMs: number;
};

type ErrorPayload = {
  ok: false;
  error: string;
  message?: string;
};

export const POST = withIntegrationAuth(async (ctx, req) => {
  const gated = assertBootstrapEnabled();
  if (gated) return gated;

  const t0 = Date.now();
  let body: FinalizePayload;
  try {
    body = (await req.json()) as FinalizePayload;
  } catch {
    return NextResponse.json<ErrorPayload>(
      { ok: false, error: "invalid_json" },
      { status: 400 },
    );
  }

  const farmaciaId =
    typeof body.farmaciaId === "string" && body.farmaciaId.length > 0
      ? body.farmaciaId
      : null;
  const runStartedAtRaw =
    typeof body.runStartedAt === "string" ? body.runStartedAt : null;
  if (!farmaciaId) {
    return NextResponse.json<ErrorPayload>(
      { ok: false, error: "missing_farmaciaId" },
      { status: 400 },
    );
  }
  if (!runStartedAtRaw) {
    return NextResponse.json<ErrorPayload>(
      { ok: false, error: "missing_runStartedAt" },
      { status: 400 },
    );
  }
  const runStartedAt = new Date(runStartedAtRaw);
  if (Number.isNaN(runStartedAt.getTime())) {
    return NextResponse.json<ErrorPayload>(
      { ok: false, error: "invalid_runStartedAt" },
      { status: 400 },
    );
  }
  // Defesa básica: não aceitar `runStartedAt` futuro (clock skew agressivo).
  const now = Date.now();
  if (runStartedAt.getTime() > now + 60_000) {
    return NextResponse.json<ErrorPayload>(
      { ok: false, error: "runStartedAt_in_future" },
      { status: 400 },
    );
  }

  const denied = await assertFarmaciaInTenant(ctx.prisma, farmaciaId);
  if (denied) return denied;

  // A corrida aberta por /bootstrap/products. Sem ela não há corte
  // fiável, e sem corte fiável não se varre — recusar é o lado seguro.
  const corrida = await ctx.prisma.ingestProdutoRun.findFirst({
    where: { farmaciaId, estado: "ABERTA" },
    orderBy: { startedAtServer: "desc" },
  });
  if (!corrida) {
    return NextResponse.json<ErrorPayload>(
      {
        ok: false,
        error: "sem_corrida_aberta",
        message:
          "Não há corrida de produtos aberta para esta farmácia. O sweep só corre " +
          "no fim de uma corrida observada pelo servidor; nunca sobre um corte " +
          "enviado pelo cliente.",
      },
      { status: 409 },
    );
  }

  const corte = corrida.startedAtServer;

  // Quantas linhas seriam marcadas, e sobre que universo. Contar ANTES de
  // escrever é o que permite recusar um sweep anormal — depois do UPDATE
  // já não há decisão nenhuma a tomar.
  const [candidatos, activosAntes] = await Promise.all([
    ctx.prisma.produtoFarmacia.count({
      where: { farmaciaId, flagRetirado: false, dataAtualizacao: { lt: corte } },
    }),
    ctx.prisma.produtoFarmacia.count({ where: { farmaciaId, flagRetirado: false } }),
  ]);

  const decisao = avaliarSweep({
    candidatos,
    activosAntes,
    produtosRecebidos: corrida.produtosRecebidos,
  });
  if (!decisao.permitir) {
    console.error(
      `[bootstrap/products/finalize] sweep_recusado ${JSON.stringify({
        farmaciaId,
        candidatos,
        activosAntes,
        produtosRecebidos: corrida.produtosRecebidos,
        motivo: decisao.motivo,
      })}`,
    );
    // A corrida NÃO é fechada: fica aberta para se poder investigar e,
    // se for mesmo caso disso, repetir o upload em condições.
    return NextResponse.json<ErrorPayload>(
      { ok: false, error: "sweep_anormal", message: decisao.motivo },
      { status: 409 },
    );
  }

  // O UPDATE é a peça canónica do modelo. WHERE captura linhas que:
  //   1. pertencem à farmácia visada,
  //   2. não foram tocadas nesta corrida (dataAtualizacao < corte),
  //   3. estavam marcadas como activas.
  //
  // `flagRetirado = false` na condição garante o sentido único: isto só
  // pode marcar como retirado, nunca desmarcar. Reactivar é trabalho do
  // UPSERT de /bootstrap/products, quando o produto volta a vir do ERP.
  //
  // Não toca em `Produto` — catálogo global, partilhado entre farmácias.
  let retiredCount = 0;
  try {
    const result = await ctx.prisma.$executeRaw(Prisma.sql`
      UPDATE "ProdutoFarmacia"
      SET "flagRetirado" = true,
          "dataAtualizacao" = NOW()
      WHERE "farmaciaId" = ${farmaciaId}
        AND "flagRetirado" = false
        AND "dataAtualizacao" < ${corte}
    `);
    retiredCount = Number(result) || 0;
  } catch (err) {
    console.error("[bootstrap/products/finalize] sweep_failed", err);
    return NextResponse.json<ErrorPayload>(
      {
        ok: false,
        error: "sweep_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }

  // Fechar a corrida é o que torna isto idempotente: uma segunda chamada
  // não encontra corrida aberta e devolve 409 em vez de varrer outra vez
  // com um corte que entretanto já não descreve nada.
  await ctx.prisma.ingestProdutoRun.update({
    where: { id: corrida.id },
    data: { estado: "FINALIZADA", finalizadaEm: new Date(), retiradas: retiredCount },
  });

  const payload: SuccessPayload = {
    ok: true,
    farmaciaId,
    // Devolvido como veio, para o agent reconciliar os seus próprios logs.
    // Não participou em decisão nenhuma.
    runStartedAt: runStartedAt.toISOString(),
    corteServidor: corte.toISOString(),
    produtosRecebidos: corrida.produtosRecebidos,
    activosAntes,
    retiredCount,
    durationMs: Date.now() - t0,
  };
  console.log(`[bootstrap/products/finalize] ok ${JSON.stringify(payload)}`);
  return NextResponse.json(payload, { status: 200 });
});
