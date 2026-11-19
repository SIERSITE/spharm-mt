import "server-only";
import { getPrisma } from "@/lib/prisma";
import type { PrismaClient } from "@/generated/prisma/client";
import { canAccessFarmaciaSync } from "@/lib/permissions-core";
import type { SessionUser } from "@/lib/session-claims";
import {
  agregarDadosAtualizados,
  KINDS_DADOS,
  STATUS_DADOS,
  type DadosAtualizados,
} from "@/lib/dados-atualizados-core";

/**
 * Só SELECTs. Farmácias: ATIVAS (sem a «Farmácia Teste», como o resto da
 * app) a que a sessão tem acesso — GESTOR_GRUPO/ADMINISTRADOR veem todas,
 * os restantes perfis só a sua. Ver `lib/dados-atualizados-core.ts` para a
 * definição da fonte.
 */
export async function carregarDadosAtualizados(session: SessionUser): Promise<DadosAtualizados> {
  return carregarDadosAtualizadosCom(await getPrisma(), session);
}

/** Igual, com o cliente Prisma injetado (testes contra uma base local). */
export async function carregarDadosAtualizadosCom(
  prisma: PrismaClient,
  session: SessionUser,
): Promise<DadosAtualizados> {
  const todas = await prisma.farmacia.findMany({
    where: { estado: "ATIVO", nome: { not: "Farmácia Teste" } },
    select: { id: true, nome: true },
    orderBy: { nome: "asc" },
  });
  const farmacias = todas.filter((f) => canAccessFarmaciaSync(session, f.id));
  if (farmacias.length === 0) return { ate: null, farmacias: [] };

  const grupos = await prisma.pipelineRun.groupBy({
    by: ["farmaciaId"],
    where: {
      farmaciaId: { in: farmacias.map((f) => f.id) },
      kind: { in: [...KINDS_DADOS] },
      status: STATUS_DADOS,
    },
    _max: { updatedAt: true },
  });
  return agregarDadosAtualizados(
    farmacias,
    grupos.flatMap((g) => (g._max.updatedAt ? [{ farmaciaId: g.farmaciaId, recebidaEm: g._max.updatedAt }] : [])),
  );
}
