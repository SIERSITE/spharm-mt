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
 *
 * `canonical_name` (opcional, por grupo) é a segunda coisa que este
 * módulo sabe fazer: quando presente e diferente do `nomeNormalizado`
 * já na base, renomeia o PRÓPRIO fabricante canónico — na mesma
 * transacção dos merges desse grupo — e preserva a denominação
 * anterior como `FabricanteAlias` dele, nunca perdida. Uma colisão com
 * o `nomeNormalizado` de outro Fabricante bloqueia só a renomeação
 * (reportada em `renomeacoesBloqueadas`); os merges do grupo, se os
 * houver, continuam.
 *
 * ── Formato "achatado" (checkpoint) ──────────────────────────────────
 * `scripts/data/plano-normalizacao-garantia-achatado-checkpoint.json`
 * substitui `verified_business_changes`/`orthographic_merges` por um
 * único array `groups[]` (cada um com `origin`, `canonical_name_before`/
 * `canonical_name_after`, `canonical_rename_required` e `sources[]` —
 * `{source_id, source_name, products}` em vez de `source_ids: string[]`
 * nus) e `do_not_merge` por arrays de nomes em vez de `{names, reason}`.
 * `combinarGruposAchatado`/`normalizarDoNotMerge` traduzem os dois para
 * a MESMA forma interna (`GrupoNormalizacao`/`DoNotMergeEntry`) que
 * `planearNormalizacaoBatch` já sabia consumir — nenhuma lógica de
 * planeamento foi duplicada para o formato novo.
 *
 * ── Abortar tudo perante qualquer conflito (só em --apply) ───────────
 * `executarNormalizacaoBatch` recusa-se a abrir a transacção se houver
 * QUALQUER grupo bloqueado, source excluído ou renomeação bloqueada —
 * ao contrário do dry-run (que continua a mostrar tudo, incluindo o que
 * ficaria de fora), um `--apply` sobre um lote com conflitos não aplica
 * SÓ os itens limpos: recusa o lote inteiro. O operador corrige o plano
 * (ou os dados) e volta a correr o dry-run até sair limpo.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import {
  planearMergeFabricantes,
  type PlanoMergeFabricantes,
  type ProdutoDoLoser,
} from "./catalog-fabricante-merge";
import { normalizeFabricanteCanonico } from "./catalog-normalizers";

// ── Estrutura do ficheiro de plano ──────────────────────────────────

/** Proveniência de um grupo — rotula tanto o formato original como o achatado. */
export type GrupoKind =
  | "verified"
  | "orthographic"
  | "initial_verified"
  | "initial_orthographic"
  | "supplemental_research";

export type GrupoPlanoOrigem = {
  canonical_id: string;
  canonical_name?: string;
  source_ids: string[];
  type?: string;
  reason?: string;
};

export type DoNotMergeEntry = {
  names: string[];
  /** Opcional: o formato achatado não traz motivo por entrada (fica só no markdown de acompanhamento). */
  reason?: string;
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
  kind: GrupoKind;
};

export function combinarGrupos(plano: PlanoNormalizacaoArquivo): GrupoNormalizacao[] {
  return [
    ...plano.verified_business_changes.map((g) => ({ ...g, kind: "verified" as const })),
    ...plano.orthographic_merges.map((g) => ({ ...g, kind: "orthographic" as const })),
  ];
}

// ── Formato achatado (checkpoint) ────────────────────────────────────

export type SourcePlanoAchatado = {
  source_id: string;
  source_name?: string;
  /** Contagem de produtos ESPERADA pela investigação — comparada contra a base real em `compararDivergencias`. */
  products?: number;
};

export type GrupoPlanoAchatado = {
  origin: string;
  canonical_id: string;
  canonical_name_before?: string;
  canonical_name_after?: string;
  canonical_rename_required?: boolean;
  relation?: string;
  reason?: string;
  sources: SourcePlanoAchatado[];
  evidence?: string[];
  confidence?: string;
};

export type PlanoNormalizacaoArquivoAchatado = {
  tenant: string;
  status?: string;
  generated_at?: string;
  warnings?: string[];
  summary?: Record<string, number>;
  /** Duas formas aceites: arrays de nomes nus (achatado) ou {names,reason} (original) — `normalizarDoNotMerge` junta as duas. */
  do_not_merge: string[][] | DoNotMergeEntry[];
  groups: GrupoPlanoAchatado[];
};

/** Detecta o formato achatado sem exigir que o caller já saiba qual é. */
export function ehPlanoAchatado(
  plano: PlanoNormalizacaoArquivo | PlanoNormalizacaoArquivoAchatado,
): plano is PlanoNormalizacaoArquivoAchatado {
  return Array.isArray((plano as PlanoNormalizacaoArquivoAchatado).groups);
}

/**
 * Traduz `groups[]` (achatado) para a MESMA forma interna que
 * `combinarGrupos` produz a partir do formato original — nenhuma
 * lógica de planeamento distingue os dois depois disto.
 * `canonical_name_after` torna-se `canonical_name` (o que
 * `planearNormalizacaoBatch` compara contra a base); `sources[].source_id`
 * vira `source_ids`. `origin` viaja tal-qual para `kind`.
 */
export function combinarGruposAchatado(plano: PlanoNormalizacaoArquivoAchatado): GrupoNormalizacao[] {
  return plano.groups.map((g) => ({
    kind: (g.origin as GrupoKind) || "orthographic",
    canonical_id: g.canonical_id,
    canonical_name: g.canonical_name_after,
    source_ids: g.sources.map((s) => s.source_id),
    reason: g.reason,
  }));
}

/** Junta os dois formatos de `do_not_merge` (arrays nus ou {names,reason}) numa forma só. */
export function normalizarDoNotMerge(raw: readonly (string[] | DoNotMergeEntry)[]): DoNotMergeEntry[] {
  return raw.map((entrada) => (Array.isArray(entrada) ? { names: entrada } : entrada));
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
  kind: GrupoKind;
  canonicalId: string;
  sourceId: string;
  motivo: MotivoExclusaoSource;
  detalhe?: string;
};

/**
 * Renomeação do PRÓPRIO fabricante canónico de um grupo — só existe
 * quando o plano traz `canonical_name` e esse nome (normalizado) DIFERE
 * do `nomeNormalizado` actual na base. A denominação anterior nunca se
 * perde: torna-se `FabricanteAlias` do mesmo fabricante, na MESMA
 * transacção que o renomeia (ver `executarNormalizacaoBatch`).
 */
export type RenomeacaoCanonical = {
  nomeAntes: string;
  nomeDepois: string;
  /** Nome a criar como alias (a denominação anterior) — null se já existia como alias do próprio. */
  aliasACriar: string | null;
  aliasJaExistente: boolean;
};

export type RenomeacaoBloqueada = {
  groupIndex: number;
  kind: GrupoKind;
  canonicalId: string;
  nomeAtual: string;
  nomeSolicitado: string;
  motivo: "colisao_nome";
  detalhe: string;
};

export type GrupoResolvido = {
  groupIndex: number;
  kind: GrupoKind;
  canonicalId: string;
  canonicalNome: string;
  /** Renomeação do canónico, quando o plano pede uma e ela não colide com outro Fabricante. */
  renomeacao?: RenomeacaoCanonical;
  /** Sources válidos, com o plano de merge já calculado (produtos/aliases). */
  sources: Array<{ sourceId: string; nomeNormalizado: string; plano: PlanoMergeFabricantes }>;
};

export type GrupoBloqueado = {
  groupIndex: number;
  kind: GrupoKind;
  canonicalId: string;
  motivo: "canonical_inexistente" | "canonical_inativo";
  detalhe: string;
};

export type RelatorioNormalizacaoBatch = {
  grupos: GrupoResolvido[];
  gruposBloqueados: GrupoBloqueado[];
  sourcesExcluidos: SourceExcluido[];
  renomeacoesBloqueadas: RenomeacaoBloqueada[];
  /** Totais agregados sobre os grupos válidos (não os bloqueados/excluídos). */
  totais: {
    grupos: number;
    fabricantesOrigemAInativar: number;
    produtosAReatribuir: number;
    produtosBloqueadosValidadoManualmente: number;
    aliasesACriar: number;
    canonicaisRenomeados: number;
    aliasesCriadosPorRenomeacao: number;
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
  const renomeacoesBloqueadas: RenomeacaoBloqueada[] = [];

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

    // ── Renomeação opcional do próprio canónico ──────────────────────
    // Só existe quando o plano traz `canonical_name` E esse nome
    // (normalizado) difere do que já está na base — um plano que repete
    // o nome actual nunca desencadeia escrita nenhuma aqui.
    let renomeacao: RenomeacaoCanonical | undefined;
    if (grupo.canonical_name) {
      const nomeDepois = normalizeFabricanteCanonico(grupo.canonical_name);
      if (nomeDepois && nomeDepois !== canonical.nomeNormalizado) {
        const colisao = [...fabricantesPorId.values()].find(
          (f) => f.id !== canonical.id && f.nomeNormalizado === nomeDepois,
        );
        if (colisao) {
          renomeacoesBloqueadas.push({
            groupIndex,
            kind: grupo.kind,
            canonicalId: grupo.canonical_id,
            nomeAtual: canonical.nomeNormalizado,
            nomeSolicitado: nomeDepois,
            motivo: "colisao_nome",
            detalhe: `já existe outro Fabricante (${colisao.id}) com nomeNormalizado="${nomeDepois}" — renomeação recusada.`,
          });
        } else {
          const aliasJaExistente = canonical.aliases.includes(canonical.nomeNormalizado);
          renomeacao = {
            nomeAntes: canonical.nomeNormalizado,
            nomeDepois,
            aliasACriar: aliasJaExistente ? null : canonical.nomeNormalizado,
            aliasJaExistente,
          };
        }
      }
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
          detalhe: `"${source.nomeNormalizado}" → "${canonical.nomeNormalizado}" está coberto por do_not_merge: ${doNotMerge[idxCanonical].reason ?? "grupo do_not_merge (sem motivo registado neste ficheiro)"}`,
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

    // Um grupo entra no relatório se tiver sources válidos OU uma
    // renomeação a aplicar — os dois são independentes (Takeda e Haleon
    // têm sources válidos E renomeação; um grupo podia, em teoria, ter
    // só uma das duas coisas).
    if (sourcesValidos.length > 0 || renomeacao) {
      gruposResolvidos.push({
        groupIndex,
        kind: grupo.kind,
        canonicalId: grupo.canonical_id,
        canonicalNome: canonical.nomeNormalizado,
        ...(renomeacao ? { renomeacao } : {}),
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
      if (g.renomeacao) {
        acc.canonicaisRenomeados += 1;
        if (g.renomeacao.aliasACriar) acc.aliasesCriadosPorRenomeacao += 1;
      }
      return acc;
    },
    {
      grupos: gruposResolvidos.length,
      fabricantesOrigemAInativar: 0,
      produtosAReatribuir: 0,
      produtosBloqueadosValidadoManualmente: 0,
      aliasesACriar: 0,
      canonicaisRenomeados: 0,
      aliasesCriadosPorRenomeacao: 0,
    },
  );

  return { grupos: gruposResolvidos, gruposBloqueados, sourcesExcluidos, renomeacoesBloqueadas, totais };
}

// ── Aplicação — tudo numa única transacção ──────────────────────────

export type ResultadoNormalizacaoBatch = {
  produtosReatribuidos: number;
  aliasesCriados: number;
  fabricantesInativados: number;
  canonicaisRenomeados: number;
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
      aliasesCriados: relatorio.totais.aliasesACriar + relatorio.totais.aliasesCriadosPorRenomeacao,
      fabricantesInativados: relatorio.totais.fabricantesOrigemAInativar,
      canonicaisRenomeados: relatorio.totais.canonicaisRenomeados,
    };
  }

  // ── Abortar tudo perante qualquer conflito ──────────────────────────
  // Só em --apply. O dry-run já mostrou tudo isto ao operador; aplicar
  // só os itens limpos e ignorar os conflitos em silêncio é precisamente
  // o que NÃO se quer aqui — um lote com QUALQUER grupo bloqueado, source
  // excluído ou renomeação bloqueada é recusado por inteiro, antes de a
  // transacção sequer abrir. Nada é escrito.
  const totalConflitos =
    relatorio.gruposBloqueados.length + relatorio.sourcesExcluidos.length + relatorio.renomeacoesBloqueadas.length;
  if (totalConflitos > 0) {
    throw new Error(
      `--apply recusado: ${totalConflitos} conflito(s) por resolver ` +
        `(${relatorio.gruposBloqueados.length} grupo(s) bloqueado(s), ` +
        `${relatorio.sourcesExcluidos.length} source(s) excluído(s), ` +
        `${relatorio.renomeacoesBloqueadas.length} renomeação(ões) bloqueada(s)). ` +
        `Nada foi escrito. Corrige o plano ou os dados e corre o dry-run outra vez até sair limpo.`,
    );
  }

  let produtosReatribuidos = 0;
  let aliasesCriados = 0;
  let fabricantesInativados = 0;
  let canonicaisRenomeados = 0;

  await prisma.$transaction(
    async (tx) => {
      for (const grupo of relatorio.grupos) {
        // Renomear o canónico ANTES de mexer nos sources: a denominação
        // anterior tem de existir como alias antes de deixar de ser o
        // nomeNormalizado — a ordem pedida explicitamente, embora dentro
        // da mesma transacção um erro a meio desfaz tudo de qualquer forma.
        if (grupo.renomeacao) {
          if (grupo.renomeacao.aliasACriar) {
            await tx.fabricanteAlias.upsert({
              where: { fabricanteId_aliasNome: { fabricanteId: grupo.canonicalId, aliasNome: grupo.renomeacao.aliasACriar } },
              create: { fabricanteId: grupo.canonicalId, aliasNome: grupo.renomeacao.aliasACriar },
              update: {},
            });
            aliasesCriados += 1;
          }
          await tx.fabricante.update({
            where: { id: grupo.canonicalId },
            data: { nomeNormalizado: grupo.renomeacao.nomeDepois, dataAtualizacao: new Date() },
          });
          canonicaisRenomeados += 1;
        }

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

  return { produtosReatribuidos, aliasesCriados, fabricantesInativados, canonicaisRenomeados };
}

// ── Divergências: o que o plano ESPERAVA vs o que a base REAL diz ──────

export type DivergenciaProdutos = {
  groupIndex: number;
  canonicalId: string;
  sourceId: string;
  sourceNome?: string;
  produtosEsperados: number;
  produtosReais: number;
};

export type DivergenciaResumo = {
  campo: string;
  esperado: number;
  real: number;
  bate: boolean;
};

export type RelatorioDivergencias = {
  produtos: DivergenciaProdutos[];
  resumo: DivergenciaResumo[];
};

/**
 * Compara as contagens que o plano achatado DECLAROU (por source, e no
 * bloco `summary`) contra o que a base REAL diz agora — puro, sem tocar
 * em nada. Existe porque o plano é investigação (`status:
 * RESEARCH_CHECKPOINT_DO_NOT_APPLY`): um `products` errado por source ou
 * um total de `summary` que já não bate certo é sinal de que os dados
 * mudaram desde a investigação (produtos entretanto movidos, fabricante
 * entretanto inactivado) — não faz o dry-run falhar, mas tem de aparecer
 * no relatório para revisão humana antes de qualquer `--apply`.
 */
export function compararDivergencias(input: {
  planoAchatado: PlanoNormalizacaoArquivoAchatado;
  relatorio: RelatorioNormalizacaoBatch;
  produtosPorFabricanteId: ReadonlyMap<string, ProdutoDoLoser[]>;
  totalFabricantesAtivosAntes: number;
}): RelatorioDivergencias {
  const { planoAchatado, relatorio, produtosPorFabricanteId, totalFabricantesAtivosAntes } = input;

  const produtos: DivergenciaProdutos[] = [];
  let somaProdutosEsperados = 0;
  planoAchatado.groups.forEach((g, groupIndex) => {
    for (const s of g.sources) {
      if (s.products === undefined) continue;
      somaProdutosEsperados += s.products;
      const reais = (produtosPorFabricanteId.get(s.source_id) ?? []).length;
      if (reais !== s.products) {
        produtos.push({
          groupIndex,
          canonicalId: g.canonical_id,
          sourceId: s.source_id,
          sourceNome: s.source_name,
          produtosEsperados: s.products,
          produtosReais: reais,
        });
      }
    }
  });

  const resumo: DivergenciaResumo[] = [];
  const par = (campo: string, esperado: number | undefined, real: number) => {
    if (esperado === undefined) return;
    resumo.push({ campo, esperado, real, bate: esperado === real });
  };
  const summary = planoAchatado.summary ?? {};
  par("groups", summary.groups, planoAchatado.groups.length);
  par("source_manufacturers_to_deactivate", summary.source_manufacturers_to_deactivate, relatorio.totais.fabricantesOrigemAInativar);
  par("canonical_renames_required", summary.canonical_renames_required, relatorio.totais.canonicaisRenomeados);
  // Contra o que a base REAL confirma que seria reatribuído (relatorio.totais)
  // — a comparação que interessa antes de um --apply.
  par("products_to_reassign_unique", summary.products_to_reassign_unique, relatorio.totais.produtosAReatribuir);
  // E, à parte, a consistência interna DO PRÓPRIO PLANO: o total declarado em
  // summary bate com a soma dos `products` que o plano atribui a cada source?
  // Não depende da base — apanha um erro de transcrição no ficheiro mesmo que
  // a base ainda não tenha sido consultada.
  par("products_to_reassign_unique_vs_soma_por_source_no_plano", summary.products_to_reassign_unique, somaProdutosEsperados);
  par("active_before", summary.active_before, totalFabricantesAtivosAntes);
  par(
    "active_after_estimated",
    summary.active_after_estimated,
    totalFabricantesAtivosAntes - relatorio.totais.fabricantesOrigemAInativar,
  );

  return { produtos, resumo };
}
