/**
 * lib/jobs/enqueue-regulatory.ts
 *
 * Daily enqueue do regulatory acquisition pipeline. Insere/actualiza jobs
 * em `RegulatoryAcquisitionJob` para CNPs de `Produto` MEDICAMENTO vivos
 * cuja cobertura clínica em `Produto` está incompleta E que ainda não
 * têm job DONE/BLOCKED.
 *
 * Lógica de selecção (por tenant):
 *
 *   Candidatos = Produto.{
 *     estado != INATIVO,
 *     validadoManualmente = false,
 *     productType = MEDICAMENTO,
 *     cnp > 2_000_000,                  // exclui CNP synthetics internos
 *     ANY OF:
 *       codigoATC IS NULL,
 *       dci IS NULL,
 *       formaFarmaceutica IS NULL,
 *       dosagem IS NULL,
 *       embalagem IS NULL,
 *       imagemUrl IS NULL,              // Phase C — imagem regulatória
 *   } EXCEPT existing RegulatoryAcquisitionJob.{status IN (DONE, BLOCKED)}
 *
 * Cada CNP candidato é upsert em `RegulatoryAcquisitionJob`:
 *   · NEW → status=PENDING, priority por critério (sem ATC = mais alto)
 *   · existente PENDING/PARTIAL/FAILED com nextAttemptAt no passado → no-op
 *     (worker já vai apanhá-lo)
 *   · existente DONE/BLOCKED → no-op (filtro acima já evita)
 *
 * Limite por run: `maxNewJobs` para não inundar a queue. Default 1000.
 * Em multi-tenant, isto corre uma vez por tenant.
 *
 * Idempotente: re-correr enquanto o pipeline corre não cria duplicados
 * (constraint `@unique` em cnp).
 */

import type { PrismaClient } from "@/generated/prisma/client";

export type EnqueueOptions = {
  prisma: PrismaClient;
  /** Default 1000. */
  maxNewJobs?: number;
};

export type EnqueueSummary = {
  candidatesFound: number;
  jobsCreated: number;
  jobsAlreadyOpen: number;
  durationMs: number;
};

/**
 * Heuristic de prioridade — quanto pior a cobertura, mais cedo deve
 * tratar-se:
 *   · sem ATC E sem DCI E sem imagem  → 10 (top)
 *   · sem ATC E sem DCI               → 20
 *   · sem ATC                          → 30
 *   · sem imagem (clínica completa)    → 40
 *   · default                          → 50
 */
function priorityFor(p: {
  codigoATC: string | null;
  dci: string | null;
  imagemUrl: string | null;
}): number {
  const noATC = p.codigoATC == null;
  const noDCI = p.dci == null;
  const noImg = p.imagemUrl == null;
  if (noATC && noDCI && noImg) return 10;
  if (noATC && noDCI) return 20;
  if (noATC) return 30;
  if (noImg) return 40;
  return 50;
}

export async function runEnqueueRegulatory(
  options: EnqueueOptions,
): Promise<EnqueueSummary> {
  const t0 = Date.now();
  const { prisma } = options;
  const maxNewJobs = options.maxNewJobs ?? 1000;

  // 1. Seleccionar candidatos (Produto)
  const candidates = await prisma.produto.findMany({
    where: {
      estado: { not: "INATIVO" },
      validadoManualmente: false,
      productType: "MEDICAMENTO",
      cnp: { gt: 2_000_000 },
      OR: [
        { codigoATC: null },
        { dci: null },
        { formaFarmaceutica: null },
        { dosagem: null },
        { embalagem: null },
        { imagemUrl: null },
      ],
    },
    select: {
      cnp: true,
      designacao: true,
      codigoATC: true,
      dci: true,
      imagemUrl: true,
    },
    take: maxNewJobs * 2, // overprovision — depois filtramos pelos que já têm DONE/BLOCKED
    orderBy: { cnp: "asc" },
  });

  if (candidates.length === 0) {
    return { candidatesFound: 0, jobsCreated: 0, jobsAlreadyOpen: 0, durationMs: Date.now() - t0 };
  }

  // 2. Excluir CNPs com job já DONE ou BLOCKED
  const cnps = candidates.map((c) => c.cnp);
  const existingTerminal = await prisma.regulatoryAcquisitionJob.findMany({
    where: { cnp: { in: cnps }, status: { in: ["DONE", "BLOCKED"] } },
    select: { cnp: true },
  });
  const terminalSet = new Set(existingTerminal.map((j) => j.cnp));

  const filtered = candidates.filter((c) => !terminalSet.has(c.cnp));
  const targets = filtered.slice(0, maxNewJobs);

  // 3. Identificar quais já têm job aberto (PENDING/IN_PROGRESS/PARTIAL/FAILED)
  const existingOpen = await prisma.regulatoryAcquisitionJob.findMany({
    where: { cnp: { in: targets.map((t) => t.cnp) } },
    select: { cnp: true },
  });
  const openSet = new Set(existingOpen.map((j) => j.cnp));

  // 4. Inserir apenas os que faltam
  let jobsCreated = 0;
  for (const c of targets) {
    if (openSet.has(c.cnp)) continue;
    try {
      await prisma.regulatoryAcquisitionJob.create({
        data: {
          cnp: c.cnp,
          designacao: c.designacao,
          priority: priorityFor(c),
          status: "PENDING",
          // nextAttemptAt default = now() — disponível imediatamente
        },
      });
      jobsCreated++;
    } catch {
      // Race: outro cron criou em paralelo. Idempotente. Ignora.
    }
  }

  return {
    candidatesFound: targets.length,
    jobsCreated,
    jobsAlreadyOpen: openSet.size,
    durationMs: Date.now() - t0,
  };
}
