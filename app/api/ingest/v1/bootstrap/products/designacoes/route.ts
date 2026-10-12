/**
 * app/api/ingest/v1/bootstrap/products/designacoes/route.ts
 *
 * Passo LEVE de designações da farmácia autoritativa (tenant silveira) —
 * ver `lib/ingest/designacao-silveira.ts` para a regra e o porquê.
 *
 * Existe porque "Sincronizar agora" só relê produtos com actividade do dia
 * (`buildProductsSql(scope:"date")`) e a regra exige que a designação da
 * Silveirense seja comparada com a da base em cada sincronização, MESMO
 * que o ERP não tenha marcado o produto como alterado. Reenviar o catálogo
 * inteiro pelo endpoint de produtos (lotes de 50, com enriquecimento do
 * catálogo) não cabe no tempo de um "agora"; este passo envia só
 * (cnp, designação) em lotes grandes e aplica a MESMA regra em SQL
 * set-based, escrevendo apenas onde o valor efectivo difere.
 *
 * NÃO é um segundo critério: usa `resolverAutoridadeDesignacao` e
 * `aplicarDesignacoesAutoritativas`, os mesmos blocos de que a regra do
 * endpoint de produtos depende. Nunca cria produtos (a criação é do
 * endpoint de produtos) e nunca toca em outro campo.
 *
 * GET  ?farmaciaId=…   → { aplica, autoritativa, erroConfiguracao? }
 *                        (o agent pergunta antes de enviar; nos outros
 *                        tenants/farmácias responde autoritativa:false)
 * POST { farmaciaId, items:[{ cnp, designacao }] }
 *                      → 409 se a farmácia NÃO é a autoritativa (sem
 *                        escritas); senão as contagens do lote.
 */
import { NextResponse, type NextRequest } from "next/server";
import { withIntegrationAuth } from "@/lib/integracao/auth";
import {
  assertBootstrapEnabled,
  assertFarmaciaInTenant,
  asIntOrNull,
  parseBatchBody,
  isFailure,
} from "@/lib/ingest/bootstrap";
import {
  aplicarDesignacoesAutoritativas,
  modoParaFarmacia,
  resolverAutoridadeDesignacao,
  type EstadoAutoridadeDesignacao,
} from "@/lib/ingest/designacao-silveira";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function resolver(
  prisma: Parameters<typeof resolverAutoridadeDesignacao>[0],
  slug: string,
): Promise<EstadoAutoridadeDesignacao> {
  try {
    return await resolverAutoridadeDesignacao(prisma, slug);
  } catch (err) {
    return {
      aplica: true,
      valida: false,
      codigo: "NAO_ENCONTRADA",
      mensagem: `falha a resolver a farmácia autoritativa: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
    };
  }
}

function descricaoEstado(estado: EstadoAutoridadeDesignacao, farmaciaId: string) {
  const modo = modoParaFarmacia(estado, farmaciaId);
  return {
    aplica: estado.aplica,
    autoritativa: modo === "AUTORITATIVA",
    modo,
    ...(estado.aplica && !estado.valida
      ? { erroConfiguracao: { codigo: estado.codigo, mensagem: estado.mensagem } }
      : {}),
  };
}

export const GET = withIntegrationAuth(async (ctx, req: NextRequest) => {
  const farmaciaId = new URL(req.url).searchParams.get("farmaciaId") ?? "";
  if (!farmaciaId) {
    return NextResponse.json(
      { ok: false, error: "missing_farmacia_id", message: "farmaciaId é obrigatório." },
      { status: 400 },
    );
  }
  const farmaciaErr = await assertFarmaciaInTenant(ctx.prisma, farmaciaId);
  if (farmaciaErr) return farmaciaErr;
  const estado = await resolver(ctx.prisma, ctx.tenant.slug);
  return NextResponse.json({ ok: true, ...descricaoEstado(estado, farmaciaId) });
});

export const POST = withIntegrationAuth(async (ctx, req) => {
  const t0 = Date.now();
  const disabled = assertBootstrapEnabled();
  if (disabled) return disabled;

  const parsed = await parseBatchBody<{ cnp: unknown; designacao: unknown }>(req);
  if (isFailure(parsed)) return parsed.response;
  const { farmaciaId, items } = parsed;

  const farmaciaErr = await assertFarmaciaInTenant(ctx.prisma, farmaciaId);
  if (farmaciaErr) return farmaciaErr;

  const estado = await resolver(ctx.prisma, ctx.tenant.slug);
  if (modoParaFarmacia(estado, farmaciaId) !== "AUTORITATIVA") {
    return NextResponse.json(
      {
        ok: false,
        error: "designacao_nao_autoritativa",
        message: "Esta farmácia não é a autoritativa para a designação — nada foi escrito.",
        ...descricaoEstado(estado, farmaciaId),
      },
      { status: 409 },
    );
  }

  const itens: Array<{ cnp: number; designacao: unknown }> = [];
  let semCnp = 0;
  for (const raw of items) {
    const r = (raw ?? {}) as { cnp?: unknown; designacao?: unknown };
    const cnp = asIntOrNull(r.cnp);
    if (cnp === null) {
      semCnp++;
      continue;
    }
    itens.push({ cnp, designacao: r.designacao });
  }

  const resultado = await aplicarDesignacoesAutoritativas(ctx.prisma, itens);
  const durationMs = Date.now() - t0;
  // Só contagens — nunca designações nem payloads.
  console.log(
    `[bootstrap/products/designacoes] ${JSON.stringify({ tenant: ctx.tenant.slug, farmaciaId, recebidas: items.length, semCnp, ...resultado, durationMs })}`,
  );
  return NextResponse.json({ ok: true, recebidas: items.length, semCnp, ...resultado, durationMs });
});
