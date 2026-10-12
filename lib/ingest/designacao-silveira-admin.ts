/**
 * lib/ingest/designacao-silveira-admin.ts
 *
 * Lógica do diagnóstico READ-ONLY da autoridade da designação
 * (scripts/diagnostics/designacao-silveira-diagnostico.ts) — separada do
 * script para ser testável sem control plane. Não escreve nada: o id da
 * farmácia autoritativa vive só na variável de ambiente
 * SILVEIRA_DESIGNACAO_AUTORITATIVA_FARMACIA_ID.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import {
  ENV_FARMACIA_ID_DESIGNACAO,
  normalizarFarmaciaId,
  resolverAutoridadeDesignacao,
  type EstadoAutoridadeDesignacao,
} from "@/lib/ingest/designacao-silveira";

export type LinhaFarmaciaDiagnostico = {
  id: string;
  nome: string;
  estado: string;
  produtosNaFarmacia: number;
};

export type DiagnosticoDesignacao = {
  tenant: string;
  variavelDefinida: boolean;
  idConfigurado: string;
  farmacias: LinhaFarmaciaDiagnostico[];
  resolucao: EstadoAutoridadeDesignacao;
  /** Linhas de texto com o que fazer, vazio se está tudo bem. */
  accoes: string[];
};

/** READ-ONLY: só `SELECT`. */
export async function diagnosticarDesignacao(
  prisma: PrismaClient,
  tenantSlug: string,
  env: Record<string, string | undefined> = process.env,
): Promise<DiagnosticoDesignacao> {
  const farmacias = await prisma.farmacia.findMany({
    select: { id: true, nome: true, estado: true, _count: { select: { produtosFarmacia: true } } },
    orderBy: { nome: "asc" },
  });
  const resolucao = await resolverAutoridadeDesignacao(prisma, tenantSlug, env);
  const configurado = normalizarFarmaciaId(env[ENV_FARMACIA_ID_DESIGNACAO]);

  const accoes: string[] = [];
  if (resolucao.aplica && !resolucao.valida) {
    switch (resolucao.codigo) {
      case "NAO_CONFIGURADO":
        accoes.push(
          `Definir ${ENV_FARMACIA_ID_DESIGNACAO}=<id da Silveirense, da lista acima> no ambiente da app (platform.env) e recriar web e worker.`,
        );
        break;
      case "NAO_ENCONTRADA":
        accoes.push(
          `O valor "${configurado}" de ${ENV_FARMACIA_ID_DESIGNACAO} não é o id de nenhuma farmácia deste tenant — copiar o id exacto da lista acima.`,
        );
        break;
      case "INATIVA":
        accoes.push("A farmácia identificada está inactiva — reactivá-la ou configurar outra.");
        break;
    }
  }
  return {
    tenant: tenantSlug,
    variavelDefinida: configurado !== "",
    idConfigurado: configurado,
    farmacias: farmacias.map((f) => ({ id: f.id, nome: f.nome, estado: f.estado, produtosNaFarmacia: f._count.produtosFarmacia })),
    resolucao,
    accoes,
  };
}
