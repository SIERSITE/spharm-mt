import "server-only";
import { createHash } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";

/**
 * lib/ingest/orders.ts
 *
 * ÚNICO caminho suportado para criar uma ListaEncomenda que deva ser
 * exportada para SPharm. Cria a lista + linhas + OrderOutbox na MESMA
 * transacção Prisma, garantindo que nunca existe uma ordem órfã do
 * seu envelope de exportação.
 *
 * Regra de revisão: `prisma.listaEncomenda.create(...)` directo está
 * PROIBIDO em qualquer server action ou server component. Grep por
 * esse padrão deve vir vazio fora deste ficheiro.
 *
 * Imutabilidade do payload:
 *   - o `payloadJson` é congelado no momento da criação
 *   - a edição de uma lista depois deste ponto é conceptualmente
 *     "cancelar + recriar", não "mutate". Um helper futuro para
 *     `updateOrderBeforeExport` pode mexer na ListaEncomenda mas
 *     não deve mexer no OrderOutbox — se o payload precisa de
 *     mudar, o outbox é cancelado e recriado.
 *
 * Idempotency key:
 *   determinística — `{tenantSlug}:{listaEncomendaId}`. O tenant slug
 *   é passado como argumento (quem chama sabe o tenant corrente via
 *   resolveCurrentTenantSlug + LEGACY_TENANT fallback).
 *
 * Payload hash:
 *   sha256 do payloadJson. Servida como defesa contra mutação acidental
 *   — se o mesmo idempotencyKey chegar a SPharm com hash diferente, o
 *   agent deve abortar e marcar FALHADO para triagem humana. Não deve
 *   acontecer por construção; fica como canário.
 */

export type OrderLineInput = {
  produtoId: string;
  quantidadeSugerida?: number | null;
  quantidadeAjustada?: number | null;
  fornecedorSugeridoId?: string | null;
  notas?: string | null;
};

export type CreateOrderInput = {
  farmaciaId: string;
  criadoPorId: string;
  nome: string;
  /** Se true, a lista é criada já em FINALIZADA e o outbox fica PENDENTE. */
  finalize: boolean;
  linhas: OrderLineInput[];
};

/**
 * Shape do payload congelado que o agent vai receber em /orders/pending.
 * Aumentar este tipo quando soubermos o schema real do SPharm — o que
 * aqui está é o mínimo útil para qualquer destino SPharm imaginável.
 */
export type FrozenOrderPayload = {
  version: 1;
  tenantSlug: string;
  listaEncomendaId: string;
  farmaciaId: string;
  nome: string;
  criadoPorId: string;
  criadoEm: string; // ISO
  linhas: Array<{
    produtoId: string;
    quantidadeSugerida: string | null; // stringified Decimal
    quantidadeAjustada: string | null;
    fornecedorSugeridoId: string | null;
    notas: string | null;
  }>;
};

function buildIdempotencyKey(tenantSlug: string, listaId: string): string {
  return `${tenantSlug}:${listaId}`;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Cria uma ListaEncomenda com as suas linhas e, se `finalize=true`,
 * cria também a row OrderOutbox na mesma transacção.
 *
 * Retorna a lista criada e (se finalize) o outboxId correspondente.
 * Lança se a transacção falhar — caller decide o que fazer.
 */
export async function createEncomendaWithOutbox(
  prisma: PrismaClient,
  tenantSlug: string,
  input: CreateOrderInput
): Promise<{ listaEncomendaId: string; outboxId: string | null }> {
  if (!tenantSlug || tenantSlug.length === 0) {
    throw new Error(
      "[ingest/orders] tenantSlug em falta — o outbox precisa do slug do tenant corrente para compor a idempotency key."
    );
  }
  if (input.linhas.length === 0) {
    throw new Error("[ingest/orders] lista sem linhas não é exportável.");
  }

  return prisma.$transaction(async (tx) => {
    const lista = await tx.listaEncomenda.create({
      data: {
        farmaciaId: input.farmaciaId,
        criadoPorId: input.criadoPorId,
        nome: input.nome,
        estado: input.finalize ? "FINALIZADA" : "RASCUNHO",
        estadoExport: "PENDENTE",
        linhas: {
          create: input.linhas.map((l) => ({
            produtoId: l.produtoId,
            quantidadeSugerida: l.quantidadeSugerida ?? null,
            quantidadeAjustada: l.quantidadeAjustada ?? null,
            fornecedorSugeridoId: l.fornecedorSugeridoId ?? null,
            notas: l.notas ?? null,
          })),
        },
      },
      include: { linhas: true },
    });

    if (!input.finalize) {
      return { listaEncomendaId: lista.id, outboxId: null };
    }

    const payload: FrozenOrderPayload = {
      version: 1,
      tenantSlug,
      listaEncomendaId: lista.id,
      farmaciaId: lista.farmaciaId,
      nome: lista.nome,
      criadoPorId: lista.criadoPorId,
      criadoEm: lista.dataCriacao.toISOString(),
      linhas: lista.linhas.map((l) => ({
        produtoId: l.produtoId,
        quantidadeSugerida:
          l.quantidadeSugerida !== null ? l.quantidadeSugerida.toString() : null,
        quantidadeAjustada:
          l.quantidadeAjustada !== null ? l.quantidadeAjustada.toString() : null,
        fornecedorSugeridoId: l.fornecedorSugeridoId,
        notas: l.notas,
      })),
    };
    const payloadJson = JSON.stringify(payload);
    const payloadHash = sha256Hex(payloadJson);

    const outbox = await tx.orderOutbox.create({
      data: {
        listaEncomendaId: lista.id,
        farmaciaId: lista.farmaciaId,
        payloadJson,
        idempotencyKey: buildIdempotencyKey(tenantSlug, lista.id),
        payloadHash,
        state: "PENDENTE",
        attemptCount: 0,
        // nextAttemptAt default now() — elegível para o próximo poll.
      },
    });

    return { listaEncomendaId: lista.id, outboxId: outbox.id };
  });
}

/**
 * Finaliza uma lista que já existe em RASCUNHO, criando o OrderOutbox
 * nesse momento. Usar quando o utilizador submete um rascunho
 * previamente guardado.
 *
 * Se a lista já estiver FINALIZADA (e portanto já ter outbox), esta
 * função é um no-op seguro — retorna o outboxId existente.
 */
export async function finalizeAndQueueOrder(
  prisma: PrismaClient,
  tenantSlug: string,
  listaEncomendaId: string
): Promise<{ outboxId: string }> {
  if (!tenantSlug) {
    throw new Error("[ingest/orders] tenantSlug em falta.");
  }

  return prisma.$transaction(async (tx) => {
    const lista = await tx.listaEncomenda.findUniqueOrThrow({
      where: { id: listaEncomendaId },
      include: { linhas: true, outbox: true },
    });

    if (lista.outbox) {
      // Já tem outbox. Se a lista já tinha sido finalizada antes, isto
      // é um replay idempotente; devolvemos o outbox existente.
      return { outboxId: lista.outbox.id };
    }

    if (lista.linhas.length === 0) {
      throw new Error("[ingest/orders] lista sem linhas não é exportável.");
    }

    await tx.listaEncomenda.update({
      where: { id: lista.id },
      data: { estado: "FINALIZADA", estadoExport: "PENDENTE" },
    });

    const payload: FrozenOrderPayload = {
      version: 1,
      tenantSlug,
      listaEncomendaId: lista.id,
      farmaciaId: lista.farmaciaId,
      nome: lista.nome,
      criadoPorId: lista.criadoPorId,
      criadoEm: lista.dataCriacao.toISOString(),
      linhas: lista.linhas.map((l) => ({
        produtoId: l.produtoId,
        quantidadeSugerida:
          l.quantidadeSugerida !== null ? l.quantidadeSugerida.toString() : null,
        quantidadeAjustada:
          l.quantidadeAjustada !== null ? l.quantidadeAjustada.toString() : null,
        fornecedorSugeridoId: l.fornecedorSugeridoId,
        notas: l.notas,
      })),
    };
    const payloadJson = JSON.stringify(payload);

    const outbox = await tx.orderOutbox.create({
      data: {
        listaEncomendaId: lista.id,
        farmaciaId: lista.farmaciaId,
        payloadJson,
        idempotencyKey: buildIdempotencyKey(tenantSlug, lista.id),
        payloadHash: sha256Hex(payloadJson),
        state: "PENDENTE",
        attemptCount: 0,
      },
    });

    return { outboxId: outbox.id };
  });
}
