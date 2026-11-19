import "server-only";
import { getPrisma } from "@/lib/prisma";
import type { PrismaClient } from "@/generated/prisma/client";
import { canAccessFarmaciaSync } from "@/lib/permissions-core";
import type { SessionUser } from "@/lib/session-claims";
import {
  KINDS_ATUALIZACAO,
  STATUS_ATUALIZACAO,
  ultimasAtualizacoes,
  type UltimaAtualizacaoFarmacia,
} from "@/lib/ultima-atualizacao-core";

/**
 * Só SELECTs. Farmácias ATIVAS (sem a «Farmácia Teste», como o resto da app) a
 * que a sessão tem acesso: ADMINISTRADOR/GESTOR_GRUPO todas, os restantes a sua.
 * Não depende de nenhuma seleção feita nos mapas.
 */
export async function carregarUltimasAtualizacoes(session: SessionUser): Promise<UltimaAtualizacaoFarmacia[]> {
  return carregarUltimasAtualizacoesCom(await getPrisma(), session);
}

/** Igual, com o cliente Prisma injetado (testes contra uma base local). */
export async function carregarUltimasAtualizacoesCom(prisma: PrismaClient, session: SessionUser): Promise<UltimaAtualizacaoFarmacia[]> {
  const todas = await prisma.farmacia.findMany({
    where: { estado: "ATIVO", nome: { not: "Farmácia Teste" } },
    select: { id: true, nome: true },
    orderBy: { nome: "asc" },
  });
  const farmacias = todas.filter((f) => canAccessFarmaciaSync(session, f.id));
  if (farmacias.length === 0) return [];

  const grupos = await prisma.pipelineRun.groupBy({
    by: ["farmaciaId"],
    where: {
      farmaciaId: { in: farmacias.map((f) => f.id) },
      kind: { in: [...KINDS_ATUALIZACAO] },
      status: STATUS_ATUALIZACAO,
    },
    _max: { updatedAt: true },
  });
  return ultimasAtualizacoes(
    farmacias,
    grupos.flatMap((g) => (g._max.updatedAt ? [{ farmaciaId: g.farmaciaId, recebidaEm: g._max.updatedAt }] : [])),
  );
}
