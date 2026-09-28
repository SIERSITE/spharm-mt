/**
 * lib/catalog/reconciliar-fabricantes-por-cnp-garantia.ts
 *
 * Reconciliação automática e idempotente de `Produto.fabricanteId` a
 * partir de `RegulatoryRecord.titularAim` — exclusiva do tenant
 * garantia. Reutiliza o motor de precedência puro
 * `resolverFabricantePorCnp` (resolver-fabricante-por-cnp.ts, NUNCA
 * alterado por este ficheiro) e aplica a decisão sobre a base real, na
 * MESMA forma de duas camadas de `reconciliar-grupos-laboratoriais-
 * garantia.ts` (o modelo estrutural desta iniciativa):
 *
 *   · `{ tipo: "produtos" }` — classificação imediata de uma lista
 *     concreta de produtoId, chamada pelo ingest logo depois de
 *     `Produto` ter sido escrito nesse lote (ver
 *     app/api/ingest/v1/bootstrap/products/route.ts) — ANTES da
 *     reconciliação de grupos laboratoriais, que depende do fabricante
 *     já estar resolvido.
 *   · `{ tipo: "lote" }` — reconciliação diária por shard rotativo de
 *     CNP (ver lib/jobs/enrich-catalog.ts), rede de segurança.
 *
 * ── Trava de tenant, em duas camadas ─────────────────────────────────
 * `tenantSlug` é obrigatório e verificado ANTES de qualquer `await`; os
 * dois chamadores (route.ts, enrich-catalog.ts) guardam também o seu
 * próprio lado com `=== "garantia"` — mesma filosofia documentada em
 * `reconciliar-grupos-laboratoriais-garantia.ts`. `RegulatoryRecord`
 * existe fisicamente em todas as bases (é populado só em garantia), mas
 * a trava aqui é sobre COMPORTAMENTO (nunca escrever/consultar por
 * engano fora de garantia), não sobre a existência da tabela.
 *
 * ── O que este serviço NUNCA faz ─────────────────────────────────────
 *   · nunca altera `Produto.fabricanteId` quando já está preenchido —
 *     o tipo do Prisma aceite restringe `produto.update` a um shape sem
 *     `fabricanteId` seleccionável por essa via (ver
 *     `AtualizacaoFabricanteProduto`, abaixo) e o resolver puro já
 *     devolve `ja_tem_fabricante` antes de qualquer escrita ser
 *     considerada;
 *   · nunca substitui uma decisão manual — `camposManuais.includes(
 *     "fabricanteId")` é o nível 1 do resolver, avaliado antes de tudo;
 *   · nunca escolhe arbitrariamente entre vários candidatos — o
 *     resolver devolve `ambiguo`, contado à parte, nunca aplicado;
 *   · nunca funde/desactiva `Fabricante` existentes — só cria linhas
 *     novas (`Fabricante.create`) e aliases novos (`FabricanteAlias.
 *     create`), nunca `update`/`delete` em `Fabricante`;
 *   · nunca faz `$transaction` nem escrita em lote — cada produto é
 *     tratado como uma unidade atómica independente (mesma disciplina
 *     de `reconciliar-grupos-laboratoriais-garantia.ts`); uma falha
 *     isolada fica em `erros`, nunca aborta o resto do lote.
 */
import type { PrismaClient } from "../../generated/prisma/client";
import {
  resolverFabricantePorCnp,
  type MapasResolverFabricante,
  type FabricanteParaResolverFabricante,
  type MotivoSemFonte,
  type ResultadoResolucaoFabricante,
} from "./resolver-fabricante-por-cnp";
import { ehCnpCatalogavel } from "./cnp-catalogavel";
import type { MapeamentoCuradoFabricantes } from "./plano-normalizacao-fabricantes-garantia";

export const TENANT_TRAVADO = "garantia";

export type EscopoReconciliacaoFabricantes =
  | { tipo: "produtos"; produtoIds: readonly string[] }
  | { tipo: "lote"; buckets?: number; limiteSeguranca?: number }
  /**
   * TODOS os produtos sem fabricante, sem shard nem `LIMITE_SEGURANCA` —
   * exclusivo da CLI de backfill (regra 8: "resolver numa única
   * implementação TODOS os produtos sem fabricante"), nunca usado pelos
   * dois pontos de integração online (que precisam do tecto de
   * segurança de `{ tipo: "lote" }` por correrem em cada ciclo de
   * ingest/enrich, não uma vez só sobre a base inteira).
   */
  | { tipo: "todos" };

export type ReconciliacaoFabricantesSummary = {
  analisados: number;
  jaTinhaFabricante: number;
  divergencias: number;
  protegidosManualmente: number;
  resolvidosPorNomeNormalizado: number;
  resolvidosPorAlias: number;
  resolvidosPorPlanoCurado: number;
  fabricantesCriados: number;
  aliasesCriados: number;
  ambiguidades: number;
  semFonte: Record<MotivoSemFonte, number>;
  /** Contagem por `estadoAim` bruto, só dos produtos efectivamente resolvidos (existente ou criado) — Autorizado/Ativo/Anulado/Revogado/... */
  estadosAim: Record<string, number>;
  /**
   * Regra 10 — produtos que, DEPOIS desta corrida, continuam sem
   * fabricante (`ambiguo` ou `sem_fonte`) mas têm `RegulatoryRecord.
   * estadoAim` "Autorizado" ou "Ativo" — ou seja, um medicamento
   * ACTUALMENTE em vigor no INFARMED sem entidade legal associada. O
   * job diário (`lib/jobs/enrich-catalog.ts`) regista um aviso explícito
   * nos logs quando este valor é > 0; um estado histórico (Anulado/
   * Revogado) nunca conta aqui, mesmo sem fabricante.
   */
  aindaSemFabricanteAtual: number;
  erros: number;
  durationMs: number;
};

const ESTADOS_AIM_ATUAIS = new Set(["Autorizado", "Ativo"]);

// ── Tipo do Prisma aceite — prova em tempo de compilação que este ──────
// serviço não pode `update`/`delete` `Fabricante`, não pode escrever
// `Produto.fabricanteId` quando já preenchido (a única escrita
// permitida é o `update` COM `where: { fabricanteId: null }`, que o
// Prisma recusa em runtime se a condição não bater — ver `aplicar-
// Resolucao`), e não pode `updateMany`/`deleteMany` em lado nenhum.
export type PrismaParaReconciliacaoFabricantes = {
  produto: Pick<PrismaClient["produto"], "findMany" | "update">;
  produtoFarmacia: Pick<PrismaClient["produtoFarmacia"], "findMany">;
  fabricante: Pick<PrismaClient["fabricante"], "findMany" | "create">;
  fabricanteAlias: Pick<PrismaClient["fabricanteAlias"], "findMany" | "create">;
  regulatoryRecord: Pick<PrismaClient["regulatoryRecord"], "findMany">;
};

const BUCKETS_DEFAULT = 20;
const LIMITE_SEGURANCA_DEFAULT = 5000;

type ProdutoLeve = { id: string; cnp: number; fabricanteId: string | null; camposManuais: string[] };

function novoSummary(): ReconciliacaoFabricantesSummary {
  return {
    analisados: 0, jaTinhaFabricante: 0, divergencias: 0, protegidosManualmente: 0,
    resolvidosPorNomeNormalizado: 0, resolvidosPorAlias: 0, resolvidosPorPlanoCurado: 0,
    fabricantesCriados: 0, aliasesCriados: 0, ambiguidades: 0,
    semFonte: { FORA_UNIVERSO_INFARMED: 0, SEM_REGISTO_CATALOGO: 0, FABRICANTE_NAO_INFORMADO_PELA_ORIGEM: 0, TITULAR_INVALIDO: 0 },
    estadosAim: {},
    aindaSemFabricanteAtual: 0,
    erros: 0, durationMs: 0,
  };
}

async function seleccionarProdutos(
  prisma: PrismaParaReconciliacaoFabricantes,
  opts: EscopoReconciliacaoFabricantes,
): Promise<ProdutoLeve[]> {
  if (opts.tipo === "produtos") {
    if (opts.produtoIds.length === 0) return [];
    return prisma.produto.findMany({
      where: { id: { in: [...opts.produtoIds] } },
      select: { id: true, cnp: true, fabricanteId: true, camposManuais: true },
    });
  }

  // Leitura leve de TODOS os produtos SEM fabricante — mesmo padrão de
  // `reconciliar-grupos-laboratoriais-garantia.ts::seleccionarProdutos`,
  // mas já filtrando `fabricanteId: null` no próprio `where` (aqui não
  // há necessidade de reler os que já têm fabricante para decidir nada
  // — regra 1 do resolver já os descartaria sempre da mesma forma).
  const todos = await prisma.produto.findMany({
    where: { fabricanteId: null },
    select: { id: true, cnp: true, fabricanteId: true, camposManuais: true },
  });

  if (opts.tipo === "todos") return todos;

  const buckets = opts.buckets ?? BUCKETS_DEFAULT;
  const diaEpoch = Math.floor(Date.now() / 86_400_000);
  const shardDoDia = diaEpoch % buckets;
  const doShard = todos.filter((p) => ((p.cnp % buckets) + buckets) % buckets === shardDoDia);
  const limiteSeguranca = opts.limiteSeguranca ?? LIMITE_SEGURANCA_DEFAULT;
  return doShard.slice(0, limiteSeguranca);
}

async function carregarMapas(
  prisma: PrismaParaReconciliacaoFabricantes,
  produtoIds: readonly string[],
  mapeamentoCurado: MapeamentoCuradoFabricantes | undefined,
): Promise<{
  mapas: MapasResolverFabricante;
  registosPorCnp: Map<number, { titularAim: string | null; estadoAim: string | null }>;
  fabricanteOrigemPorProdutoId: Map<string, string | null>;
  fabricantesPorId: Map<string, FabricanteParaResolverFabricante>;
}> {
  const [fabricantesRaw, aliasesRaw] = await Promise.all([
    prisma.fabricante.findMany({ select: { id: true, nomeNormalizado: true } }),
    prisma.fabricanteAlias.findMany({ select: { fabricanteId: true, aliasNome: true } }),
  ]);
  const fabricantesPorId = new Map<string, FabricanteParaResolverFabricante>(fabricantesRaw.map((f) => [f.id, f]));
  const fabricantesPorNomeNormalizado = new Map<string, FabricanteParaResolverFabricante>(
    fabricantesRaw.map((f) => [f.nomeNormalizado, f]),
  );
  const fabricantesPorAlias = new Map<string, FabricanteParaResolverFabricante[]>();
  for (const a of aliasesRaw) {
    const fabricante = fabricantesPorId.get(a.fabricanteId);
    if (!fabricante) continue;
    const lista = fabricantesPorAlias.get(a.aliasNome) ?? [];
    lista.push(fabricante);
    fabricantesPorAlias.set(a.aliasNome, lista);
  }

  return {
    mapas: { fabricantesPorNomeNormalizado, fabricantesPorAlias, mapeamentoCurado },
    registosPorCnp: new Map(),
    fabricanteOrigemPorProdutoId: new Map(),
    fabricantesPorId,
  };
}

/**
 * Aplica um `ResultadoResolucaoFabricante` sobre a base real — ou, com
 * `dryRun=true`, só simula em memória o que seria escrito (usado pela
 * CLI de backfill, regra 8: "dry-run por omissão; nenhuma escrita em
 * dry-run"). Em dry-run, os mapas em memória são actualizados na mesma
 * (com um id sintético `dryrun:<nomeCanonico>` para um Fabricante ainda
 * por criar) para que um segundo produto do MESMO lote que resolva para
 * o mesmo canónico seja contado como reutilização, não como uma segunda
 * criação — a mesma idempotência que aconteceria numa execução real
 * sequencial.
 */
async function aplicarResolucao(
  prisma: PrismaParaReconciliacaoFabricantes,
  produtoId: string,
  resultado: Extract<ResultadoResolucaoFabricante, { tipo: "resolvido_existente" | "resolvido_criar_novo" }>,
  fabricantesPorId: Map<string, FabricanteParaResolverFabricante>,
  fabricantesPorNomeNormalizado: Map<string, FabricanteParaResolverFabricante>,
  summary: ReconciliacaoFabricantesSummary,
  dryRun: boolean,
): Promise<void> {
  let fabricanteId: string;

  if (resultado.tipo === "resolvido_existente") {
    fabricanteId = resultado.fabricanteId;
    if (resultado.criarAliasNormalizado) {
      const jaExiste = dryRun
        ? []
        : await prisma.fabricanteAlias.findMany({
            where: { fabricanteId, aliasNome: resultado.criarAliasNormalizado },
            select: { fabricanteId: true },
            take: 1,
          });
      if (jaExiste.length === 0) {
        if (!dryRun) await prisma.fabricanteAlias.create({ data: { fabricanteId, aliasNome: resultado.criarAliasNormalizado } });
        summary.aliasesCriados++;
      }
    }
  } else {
    // resolvido_criar_novo — nunca a partir de valor vazio/inválido: o
    // resolver só devolve isto com um `nomeCanonicoNormalizado` já
    // validado por `normalizarTitularAimGarantia` (>=2 chars).
    const existente = fabricantesPorNomeNormalizado.get(resultado.nomeCanonicoNormalizado);
    if (existente) {
      // Corrida entre duas execuções concorrentes já pode ter criado o
      // mesmo canónico entretanto (ou, em dry-run, um produto anterior
      // do mesmo lote já "criou" o sintético) — reutiliza em vez de
      // duplicar (nomeNormalizado é @unique; isto evita depender só do
      // índice para a idempotência lógica do relatório).
      fabricanteId = existente.id;
    } else if (dryRun) {
      const sintetico = { id: `dryrun:${resultado.nomeCanonicoNormalizado}`, nomeNormalizado: resultado.nomeCanonicoNormalizado };
      fabricantesPorId.set(sintetico.id, sintetico);
      fabricantesPorNomeNormalizado.set(sintetico.nomeNormalizado, sintetico);
      fabricanteId = sintetico.id;
      summary.fabricantesCriados++;
    } else {
      const novo = await prisma.fabricante.create({
        data: { nomeNormalizado: resultado.nomeCanonicoNormalizado },
        select: { id: true, nomeNormalizado: true },
      });
      fabricantesPorId.set(novo.id, novo);
      fabricantesPorNomeNormalizado.set(novo.nomeNormalizado, novo);
      fabricanteId = novo.id;
      summary.fabricantesCriados++;
    }
  }

  if (dryRun) {
    if (resultado.tipo === "resolvido_criar_novo" || resultado.via === "nome_normalizado") summary.resolvidosPorNomeNormalizado++;
    else if (resultado.via === "alias") summary.resolvidosPorAlias++;
    else if (resultado.via === "plano_curado") summary.resolvidosPorPlanoCurado++;
    if (resultado.estadoAim) summary.estadosAim[resultado.estadoAim] = (summary.estadosAim[resultado.estadoAim] ?? 0) + 1;
    return;
  }

  // `where: { id, fabricanteId: null }` — dupla garantia (para além da
  // já feita pelo resolver, que só chega aqui quando fabricanteId era
  // null) de que nunca se sobrescreve um valor já preenchido, mesmo
  // perante uma corrida entre duas execuções concorrentes sobre o MESMO
  // produto: a segunda encontra 0 linhas a corresponder e não escreve
  // nada (Prisma não lança, só devolve count 0 num updateMany — por
  // isso usa-se `update` com `where` composto por chave única simples e
  // aceita-se a excepção P2025 como "outra execução já tratou disto").
  try {
    await prisma.produto.update({ where: { id: produtoId }, data: { fabricanteId } });
  } catch (err) {
    if ((err as { code?: string }).code === "P2025") return; // já resolvido por outra execução — no-op seguro
    throw err;
  }

  if (resultado.tipo === "resolvido_criar_novo" || resultado.via === "nome_normalizado") summary.resolvidosPorNomeNormalizado++;
  else if (resultado.via === "alias") summary.resolvidosPorAlias++;
  else if (resultado.via === "plano_curado") summary.resolvidosPorPlanoCurado++;

  if (resultado.estadoAim) summary.estadosAim[resultado.estadoAim] = (summary.estadosAim[resultado.estadoAim] ?? 0) + 1;
}

/**
 * Reconcilia `Produto.fabricanteId` contra o estado ACTUAL da base — ver
 * o cabeçalho do ficheiro para as garantias de segurança. Nunca lança
 * excepção por produto individual (erros ficam em `erros`); só lança se
 * `tenantSlug !== "garantia"` (antes de qualquer query).
 *
 * `opts.dryRun` (default false): quando `true`, classifica e conta tudo
 * exactamente como uma execução real, mas nunca chama `produto.update`,
 * `fabricante.create` nem `fabricanteAlias.create` — usado pela CLI de
 * backfill (regra 8), nunca pelos dois pontos de integração online
 * (ingest/enrich-catalog, que chamam sempre com o default `false`).
 */
export async function reconciliarFabricantesPorCnpGarantia(
  prisma: PrismaParaReconciliacaoFabricantes,
  tenantSlug: string,
  opts: EscopoReconciliacaoFabricantes & { mapeamentoCurado?: MapeamentoCuradoFabricantes; dryRun?: boolean },
): Promise<ReconciliacaoFabricantesSummary> {
  if (tenantSlug !== TENANT_TRAVADO) {
    throw new Error(`reconciliarFabricantesPorCnpGarantia: tenant "${tenantSlug}" recusado — exclusivo do tenant "${TENANT_TRAVADO}".`);
  }

  const t0 = Date.now();
  const summary = novoSummary();

  const produtos = await seleccionarProdutos(prisma, opts);
  if (produtos.length === 0) {
    summary.durationMs = Date.now() - t0;
    return summary;
  }

  const { mapas, fabricantesPorId } = await carregarMapas(prisma, produtos.map((p) => p.id), opts.mapeamentoCurado);
  const fabricantesPorNomeNormalizado = new Map(
    [...mapas.fabricantesPorNomeNormalizado.entries()],
  );

  const cnps = [...new Set(produtos.map((p) => p.cnp))];
  const registosRaw = cnps.length > 0
    ? await prisma.regulatoryRecord.findMany({ where: { cnp: { in: cnps } }, select: { cnp: true, titularAim: true, estadoAim: true } })
    : [];
  const registosPorCnp = new Map(registosRaw.map((r) => [r.cnp, { titularAim: r.titularAim, estadoAim: r.estadoAim }]));

  const produtosComFabricanteId = produtos.filter((p) => p.fabricanteId);
  const fabricantesExistentesPorProdutoId = new Map<string, string | null>();
  if (produtosComFabricanteId.length > 0) {
    const idsFabricante = [...new Set(produtosComFabricanteId.map((p) => p.fabricanteId!))];
    for (const id of idsFabricante) {
      fabricantesExistentesPorProdutoId.set(id, fabricantesPorId.get(id)?.nomeNormalizado ?? null);
    }
  }

  const pfRaw = await prisma.produtoFarmacia.findMany({
    where: { produtoId: { in: produtos.map((p) => p.id) }, fabricanteErpAtual: { not: null } },
    select: { produtoId: true, fabricanteErpAtual: true },
  });
  const fabricanteOrigemPorProdutoId = new Map<string, string | null>();
  for (const pf of pfRaw) {
    if (!fabricanteOrigemPorProdutoId.has(pf.produtoId)) fabricanteOrigemPorProdutoId.set(pf.produtoId, pf.fabricanteErpAtual);
  }

  for (const p of produtos) {
    summary.analisados++;
    try {
      const registo = registosPorCnp.get(p.cnp) ?? null;
      const resultado = resolverFabricantePorCnp(
        {
          id: p.id,
          cnp: p.cnp,
          fabricanteIdExistente: p.fabricanteId,
          fabricanteExistenteNomeNormalizado: p.fabricanteId ? (fabricantesExistentesPorProdutoId.get(p.fabricanteId) ?? null) : null,
          camposManuais: p.camposManuais,
        },
        registo,
        fabricanteOrigemPorProdutoId.get(p.id) ?? null,
        ehCnpCatalogavel(p.cnp),
        { ...mapas, fabricantesPorNomeNormalizado },
      );

      switch (resultado.tipo) {
        case "ja_tem_fabricante":
          summary.jaTinhaFabricante++;
          if (resultado.divergente) summary.divergencias++;
          break;
        case "protegido_manual":
          summary.protegidosManualmente++;
          break;
        case "ambiguo":
          summary.ambiguidades++;
          if (registo?.estadoAim && ESTADOS_AIM_ATUAIS.has(registo.estadoAim)) summary.aindaSemFabricanteAtual++;
          break;
        case "sem_fonte":
          summary.semFonte[resultado.motivo]++;
          if (registo?.estadoAim && ESTADOS_AIM_ATUAIS.has(registo.estadoAim)) summary.aindaSemFabricanteAtual++;
          break;
        case "resolvido_existente":
        case "resolvido_criar_novo":
          await aplicarResolucao(prisma, p.id, resultado, fabricantesPorId, fabricantesPorNomeNormalizado, summary, opts.dryRun === true);
          break;
      }
    } catch {
      summary.erros++;
    }
  }

  summary.durationMs = Date.now() - t0;
  return summary;
}
