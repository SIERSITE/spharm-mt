/**
 * lib/catalog-fabricante-normalizacao-batch.ts
 *
 * Execução em lote de um plano de normalização de `Fabricante` já
 * aprovado externamente (ex.:
 * `scripts/data/plano-execucao-normalizacao-garantia.json`) — cada
 * grupo do plano é um merge winner/loser(s) igual ao que
 * `lib/catalog-fabricante-merge.ts` já sabe fazer; o que este módulo
 * acrescenta é o QUE FAZER com uma LISTA de centenas de grupos ao
 * mesmo tempo, dentro de UMA transacção, com verificação de existência
 * dos IDs contra a base real e respeito por `do_not_merge`.
 *
 * QUAL par unificar não é decidido aqui — vem do ficheiro do plano,
 * já validado (ver `execution_rules` desse ficheiro). Este módulo só
 * executa mecanicamente, e recusa-se a inventar merges que o plano não
 * pediu.
 *
 * Reaproveita `planearMergeFabricantes`/`executarMergeFabricantes` por
 * grupo — não duplica a lógica de "o que é um merge", só orquestra
 * muitos de uma vez com uma transacção só e um relatório agregado.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import {
  planearMergeFabricantes,
  type PlanoMergeFabricantes,
  type ProdutoDoLoser,
} from "./catalog-fabricante-merge";
import { normalizeFabricanteCanonico } from "./catalog-normalizers";

// ── Estrutura do ficheiro de plano ──────────────────────────────────

export type GrupoPlanoOrigem = {
  canonical_id: string;
  canonical_name?: string;
  source_ids: string[];
  type?: string;
  reason?: string;
};

export type DoNotMergeEntry = {
  names: string[];
  reason: string;
};

export type PlanoNormalizacaoArquivo = {
  tenant: string;
  summary?: Record<string, number>;
  execution_rules?: string[];
  verified_business_changes: GrupoPlanoOrigem[];
  orthographic_merges: GrupoPlanoOrigem[];
  do_not_merge: DoNotMergeEntry[];
};

/** Um grupo do plano, já rotulado com a secção de onde veio. */
export type GrupoNormalizacao = GrupoPlanoOrigem & {
  kind: "verified" | "orthographic";
};

export function combinarGrupos(plano: PlanoNormalizacaoArquivo): GrupoNormalizacao[] {
  return [
    ...plano.verified_business_changes.map((g) => ({ ...g, kind: "verified" as const })),
    ...plano.orthographic_merges.map((g) => ({ ...g, kind: "orthographic" as const })),
  ];
}

// ── Estado da BD necessário para planear ────────────────────────────

export type FabricanteDb = {
  id: string;
  nomeNormalizado: string;
  estado: "ATIVO" | "INATIVO";
  aliases: string[];
};

// ── Plano por grupo + relatório agregado ────────────────────────────

export type MotivoExclusaoSource =
  | "id_inexistente"
  | "ja_inativo"
  | "duplicado_noutro_grupo"
  | "self_merge"
  | "do_not_merge";

export type SourceExcluido = {
  groupIndex: number;
  kind: "verified" | "orthographic";
  canonicalId: string;
  sourceId: string;
  motivo: MotivoExclusaoSource;
  detalhe?: string;
};

export type GrupoResolvido = {
  groupIndex: number;
  kind: "verified" | "orthographic";
  canonicalId: string;
  canonicalNome: string;
  /** Sources válidos, com o plano de merge já calculado (produtos/aliases). */
  sources: Array<{ sourceId: string; nomeNormalizado: string; plano: PlanoMergeFabricantes }>;
};

export type GrupoBloqueado = {
  groupIndex: number;
  kind: "verified" | "orthographic";
  canonicalId: string;
  motivo: "canonical_inexistente" | "canonical_inativo";
  detalhe: string;
};

export type RelatorioNormalizacaoBatch = {
  grupos: GrupoResolvido[];
  gruposBloqueados: GrupoBloqueado[];
  sourcesExcluidos: SourceExcluido[];
  /** Totais agregados sobre os grupos válidos (não os bloqueados/excluídos). */
  totais: {
    grupos: number;
    fabricantesOrigemAInativar: number;
    produtosAReatribuir: number;
    produtosBloqueadosValidadoManualmente: number;
    aliasesACriar: number;
  };
};

/**
 * Planeia o lote inteiro — sem tocar em nada. Recebe o estado da BD já
 * carregado (todos os `Fabricante` referenciados pelo plano, com os
 * seus produtos) porque o caller decide como o foi buscar (uma query
 * em lote é o suposto, nunca uma por grupo).
 */
export function planearNormalizacaoBatch(input: {
  grupos: GrupoNormalizacao[];
  fabricantesPorId: ReadonlyMap<string, FabricanteDb>;
  /** produtos de CADA fabricante referenciado (canonical incluído, para aliases já existentes não interessa; produtos só interessam dos sources). */
  produtosPorFabricanteId: ReadonlyMap<string, ProdutoDoLoser[]>;
  doNotMerge: readonly DoNotMergeEntry[];
  incluirValidadosManualmente?: boolean;
}): RelatorioNormalizacaoBatch {
  const { grupos, fabricantesPorId, produtosPorFabricanteId, doNotMerge } = input;
  const incluirValidadosManualmente = input.incluirValidadosManualmente ?? false;

  // Nome normalizado -> índice da entrada do_not_merge a que pertence.
  // Duas denominações no MESMO índice nunca podem ser winner/loser uma da outra.
  const doNotMergeIndexPorNome = new Map<string, number>();
  doNotMerge.forEach((entrada, idx) => {
    for (const nome of entrada.names) {
      const canonico = normalizeFabricanteCanonico(nome);
      if (canonico) doNotMergeIndexPorNome.set(canonico, idx);
    }
  });

  const sourceOwnerGroupIndex = new Map<string, number>(); // detecta source_id repetido entre grupos

  const gruposResolvidos: GrupoResolvido[] = [];
  const gruposBloqueados: GrupoBloqueado[] = [];
  const sourcesExcluidos: SourceExcluido[] = [];

  grupos.forEach((grupo, groupIndex) => {
    const canonical = fabricantesPorId.get(grupo.canonical_id);
    if (!canonical) {
      gruposBloqueados.push({
        groupIndex,
        kind: grupo.kind,
        canonicalId: grupo.canonical_id,
        motivo: "canonical_inexistente",
        detalhe: `canonical_id ${grupo.canonical_id} não corresponde a nenhum Fabricante nesta base.`,
      });
      return;
    }
    if (canonical.estado !== "ATIVO") {
      gruposBloqueados.push({
        groupIndex,
        kind: grupo.kind,
        canonicalId: grupo.canonical_id,
        motivo: "canonical_inativo",
        detalhe: `canonical_id ${grupo.canonical_id} ("${canonical.nomeNormalizado}") já está INATIVO.`,
      });
      return;
    }

    const sourcesValidos: GrupoResolvido["sources"] = [];

    for (const sourceId of grupo.source_ids) {
      if (sourceId === grupo.canonical_id) {
        sourcesExcluidos.push({
          groupIndex,
          kind: grupo.kind,
          canonicalId: grupo.canonical_id,
          sourceId,
          motivo: "self_merge",
          detalhe: "source_id igual ao canonical_id do próprio grupo.",
        });
        continue;
      }

      const donoAnterior = sourceOwnerGroupIndex.get(sourceId);
      if (donoAnterior !== undefined) {
        sourcesExcluidos.push({
          groupIndex,
          kind: grupo.kind,
          canonicalId: grupo.canonical_id,
          sourceId,
          motivo: "duplicado_noutro_grupo",
          detalhe: `já reatribuído no grupo #${donoAnterior}.`,
        });
        continue;
      }

      const source = fabricantesPorId.get(sourceId);
      if (!source) {
        sourcesExcluidos.push({
          groupIndex,
          kind: grupo.kind,
          canonicalId: grupo.canonical_id,
          sourceId,
          motivo: "id_inexistente",
          detalhe: `source_id ${sourceId} não corresponde a nenhum Fabricante nesta base.`,
        });
        continue;
      }
      if (source.estado !== "ATIVO") {
        sourcesExcluidos.push({
          groupIndex,
          kind: grupo.kind,
          canonicalId: grupo.canonical_id,
          sourceId,
          motivo: "ja_inativo",
          detalhe: `"${source.nomeNormalizado}" já está INATIVO — presume-se já migrado.`,
        });
        continue;
      }

      const idxCanonical = doNotMergeIndexPorNome.get(canonical.nomeNormalizado);
      const idxSource = doNotMergeIndexPorNome.get(source.nomeNormalizado);
      if (idxCanonical !== undefined && idxCanonical === idxSource) {
        sourcesExcluidos.push({
          groupIndex,
          kind: grupo.kind,
          canonicalId: grupo.canonical_id,
          sourceId,
          motivo: "do_not_merge",
          detalhe: `"${source.nomeNormalizado}" → "${canonical.nomeNormalizado}" está coberto por do_not_merge: ${doNotMerge[idxCanonical].reason}`,
        });
        continue;
      }

      sourceOwnerGroupIndex.set(sourceId, groupIndex);

      const produtosDoLoser = produtosPorFabricanteId.get(sourceId) ?? [];
      const planoMerge = planearMergeFabricantes({
        winnerNomeNormalizado: canonical.nomeNormalizado,
        loserNomeNormalizado: source.nomeNormalizado,
        loserAliases: source.aliases,
        winnerAliases: canonical.aliases,
        produtosDoLoser,
        incluirValidadosManualmente,
      });

      sourcesValidos.push({ sourceId, nomeNormalizado: source.nomeNormalizado, plano: planoMerge });
    }

    if (sourcesValidos.length > 0) {
      gruposResolvidos.push({
        groupIndex,
        kind: grupo.kind,
        canonicalId: grupo.canonical_id,
        canonicalNome: canonical.nomeNormalizado,
        sources: sourcesValidos,
      });
    }
  });

  const totais = gruposResolvidos.reduce(
    (acc, g) => {
      acc.fabricantesOrigemAInativar += g.sources.length;
      for (const s of g.sources) {
        acc.produtosAReatribuir += s.plano.produtosAReatribuir.length;
        acc.produtosBloqueadosValidadoManualmente += s.plano.produtosBloqueadosValidadoManualmente.length;
        acc.aliasesACriar += s.plano.aliasesACriar.length;
      }
      return acc;
    },
    {
      grupos: gruposResolvidos.length,
      fabricantesOrigemAInativar: 0,
      produtosAReatribuir: 0,
      produtosBloqueadosValidadoManualmente: 0,
      aliasesACriar: 0,
    },
  );

  return { grupos: gruposResolvidos, gruposBloqueados, sourcesExcluidos, totais };
}

// ── Aplicação — tudo numa única transacção ──────────────────────────

export type ResultadoNormalizacaoBatch = {
  produtosReatribuidos: number;
  aliasesCriados: number;
  fabricantesInativados: number;
};

/**
 * Aplica o relatório inteiro (`planearNormalizacaoBatch`) numa única
 * transacção interactiva — ou tudo, ou nada. `dryRun` (default true)
 * só soma as contagens do relatório, sem abrir transacção — mesma
 * convenção de `executarMergeFabricantes`.
 */
export async function executarNormalizacaoBatch(
  prisma: PrismaClient,
  input: {
    relatorio: RelatorioNormalizacaoBatch;
    /** Tag de proveniência gravada em EnrichmentSourceLog.source. */
    source: string;
    dryRun?: boolean;
  },
): Promise<ResultadoNormalizacaoBatch> {
  const { relatorio, source } = input;
  const dryRun = input.dryRun ?? true;

  if (dryRun) {
    return {
      produtosReatribuidos: relatorio.totais.produtosAReatribuir,
      aliasesCriados: relatorio.totais.aliasesACriar,
      fabricantesInativados: relatorio.totais.fabricantesOrigemAInativar,
    };
  }

  let produtosReatribuidos = 0;
  let aliasesCriados = 0;
  let fabricantesInativados = 0;

  await prisma.$transaction(
    async (tx) => {
      for (const grupo of relatorio.grupos) {
        for (const s of grupo.sources) {
          const { plano } = s;

          if (plano.produtosAReatribuir.length > 0) {
            await tx.produto.updateMany({
              where: { id: { in: plano.produtosAReatribuir } },
              data: { fabricanteId: grupo.canonicalId, dataAtualizacao: new Date() },
            });
            produtosReatribuidos += plano.produtosAReatribuir.length;
          }

          for (const aliasNome of plano.aliasesACriar) {
            await tx.fabricanteAlias.upsert({
              where: { fabricanteId_aliasNome: { fabricanteId: grupo.canonicalId, aliasNome } },
              create: { fabricanteId: grupo.canonicalId, aliasNome },
              update: {},
            });
            aliasesCriados += 1;
          }

          await tx.fabricanteAlias.deleteMany({ where: { fabricanteId: s.sourceId } });
          await tx.fabricante.update({ where: { id: s.sourceId }, data: { estado: "INATIVO" } });
          fabricantesInativados += 1;

          if (plano.produtosAReatribuir.length > 0) {
            await tx.enrichmentSourceLog.createMany({
              data: plano.produtosAReatribuir.map((produtoId) => ({
                produtoId,
                source,
                status: "SUCCESS" as const,
                confidence: 1,
                matchedBy: "fabricante-normalizacao-batch",
                fieldsReturned: ["fabricante"],
                query: `normalizar-fabricantes-garantia: loserId=${s.sourceId} → winnerId=${grupo.canonicalId}`,
              })),
            });
          }
        }
      }
    },
    { timeout: 5 * 60 * 1000 },
  );

  return { produtosReatribuidos, aliasesCriados, fabricantesInativados };
}
