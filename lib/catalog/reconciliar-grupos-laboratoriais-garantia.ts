/**
 * lib/catalog/reconciliar-grupos-laboratoriais-garantia.ts
 *
 * Manutenção automática e idempotente de `ProdutoGrupoLaboratorial`,
 * exclusiva do tenant garantia — reutiliza o motor de precedência puro
 * `resolverGrupoDoProduto` (lib/catalog/resolver-grupo-laboratorial.ts,
 * NUNCA alterado por este ficheiro) e aplica a decisão sobre a base real,
 * em duas camadas:
 *   · `{ tipo: "produtos" }` — classificação imediata de uma lista
 *     concreta de produtoId, chamada pelo ingest logo depois de
 *     `Produto`/`Produto.fabricanteId` terem sido escritos nesse lote
 *     (ver app/api/ingest/v1/bootstrap/products/route.ts);
 *   · `{ tipo: "lote" }` — reconciliação diária por shard rotativo de
 *     CNP (ver lib/jobs/enrich-catalog.ts), rede de segurança para
 *     omissões ou classificações automáticas desactualizadas fora do
 *     caminho do ingest.
 *
 * ── Trava de tenant, em duas camadas ────────────────────────────────────
 * `GrupoLaboratorial`/`GrupoLaboratorialAlias`/`GrupoLaboratorialFabricante`/
 * `RegraGrupoLaboratorialPorCnp`/`ProdutoGrupoLaboratorial` existem
 * exclusivamente na base FÍSICA do tenant garantia — sier e silveira nem
 * têm estas tabelas no schema físico, apesar do Prisma schema partilhado
 * as declarar globalmente. A única protecção real é NUNCA emitir a
 * query. Por isso `tenantSlug` é obrigatório e verificado ANTES de
 * qualquer `await`, e os dois chamadores (route.ts, enrich-catalog.ts)
 * guardam também o seu próprio lado com `=== "garantia"` — a mesma
 * filosofia de dupla camada de `resolverAlvo`+`confirmarAlvoGarantia`
 * usada nos scripts standalone desta iniciativa. Nunca verifica se as
 * tabelas existem — só recusa antes de tentar.
 *
 * ── O que este serviço NUNCA faz ────────────────────────────────────────
 *   · nunca escreve `Produto` nem `Produto.fabricanteId` — o tipo do
 *     Prisma aceite (`PrismaParaReconciliacaoGrupos`) restringe
 *     `produto` a `Pick<..., "findMany">`, erro de compilação escrever;
 *   · nunca escreve `Fabricante` — mesma restrição a `findMany`;
 *   · nunca aplica `proposta_snapshot_cnp` — só regra_cnp,
 *     fabricante_inequivoco e alias_inequivoco (os mesmos 3 níveis
 *     "seguros" de scripts/classificar-grupos-laboratoriais-garantia.ts);
 *   · nunca substitui uma classificação com `validadoManualmente=true`
 *     — o resolver já devolve "mantido_manual" antes de qualquer outro
 *     nível ser sequer avaliado, desde que `grupoExistente` seja
 *     correctamente passado (é, sempre, a partir da leitura real);
 *   · nunca faz `$transaction` nem escrita em lote — cada
 *     create/update/delete é uma chamada single-row já atómica via
 *     `produtoId @unique`, no mesmo estilo de
 *     `syncRegulatoryToProduto`/`reclassifyByCanonicalMapping` em
 *     lib/jobs/enrich-catalog.ts. Uma falha por produto fica isolada
 *     (contada em `erros`), nunca aborta o resto do lote.
 */
import type { PrismaClient } from "../../generated/prisma/client";
import {
  resolverGrupoDoProduto,
  ORIGEM_POR_TIPO,
  type ProdutoParaResolver,
  type MapasResolverGrupo,
  type FabricanteParaResolver,
  type RegraCnpParaResolver,
  type SnapshotParaResolver,
  type GrupoFabricanteParaResolver,
  type AliasParaResolver,
} from "./resolver-grupo-laboratorial";
import { normalizeFabricanteCanonico } from "../catalog-normalizers";

export const TENANT_TRAVADO = "garantia";

export type EscopoReconciliacao =
  | { tipo: "produtos"; produtoIds: readonly string[] }
  | { tipo: "lote"; buckets?: number; limiteSeguranca?: number };

export type ReconciliacaoGruposLaboratoriaisSummary = {
  analisados: number;
  criados: number;
  atualizados: number;
  removidos: number;
  manuaisPreservados: number;
  semAlteracao: number;
  propostasNaoAplicadas: number;
  semGrupo: number;
  erros: number;
  durationMs: number;
};

// ── Tipo do Prisma aceite — prova em tempo de compilação que este ──────
// serviço não pode escrever Produto nem Fabricante ("findMany" apenas em
// ambos), e só pode fazer escrita single-row (nunca upsert nem *Many) em
// ProdutoGrupoLaboratorial — mesma disciplina de
// scripts/importar-grupos-laboratoriais-garantia.ts (PrismaParaImportacaoGrupos).
export type PrismaParaReconciliacaoGrupos = {
  produto: Pick<PrismaClient["produto"], "findMany">;
  fabricante: Pick<PrismaClient["fabricante"], "findMany">;
  regraGrupoLaboratorialPorCnp: Pick<PrismaClient["regraGrupoLaboratorialPorCnp"], "findMany">;
  grupoLaboratorialFabricante: Pick<PrismaClient["grupoLaboratorialFabricante"], "findMany">;
  grupoLaboratorialAlias: Pick<PrismaClient["grupoLaboratorialAlias"], "findMany">;
  regulatoryRecord: Pick<PrismaClient["regulatoryRecord"], "findMany">;
  produtoGrupoLaboratorial: Pick<PrismaClient["produtoGrupoLaboratorial"], "findMany" | "create" | "update" | "delete">;
};

const BUCKETS_DEFAULT = 20;
const LIMITE_SEGURANCA_DEFAULT = 5000;

type ProdutoLeve = { id: string; cnp: number; fabricanteId: string | null };
type ExistenteLeve = { grupoLaboratorialId: string; origem: string; regraCnpId: string | null; validadoManualmente: boolean };

async function carregarMapas(
  prisma: PrismaParaReconciliacaoGrupos,
  cnps: readonly number[],
): Promise<MapasResolverGrupo> {
  const [fabricantesRaw, regrasCnpRaw, gruposFabricanteRaw, aliasesRaw, snapshotsRaw] = await Promise.all([
    prisma.fabricante.findMany({ select: { id: true, nomeNormalizado: true } }),
    prisma.regraGrupoLaboratorialPorCnp.findMany({ select: { id: true, cnp: true, grupoLaboratorialId: true, estado: true, validadoManualmente: true } }),
    prisma.grupoLaboratorialFabricante.findMany({ select: { fabricanteId: true, grupoLaboratorialId: true } }),
    prisma.grupoLaboratorialAlias.findMany({ select: { grupoLaboratorialId: true, aliasNormalizado: true, estado: true } }),
    cnps.length > 0
      ? prisma.regulatoryRecord.findMany({ where: { cnp: { in: [...cnps] } }, select: { cnp: true, titularAim: true, estadoAim: true } })
      : Promise.resolve([]),
  ]);

  const fabricantesPorId = new Map<string, FabricanteParaResolver>(fabricantesRaw.map((f) => [f.id, f]));
  const fabricantesPorNomeNormalizado = new Map<string, FabricanteParaResolver>();
  for (const f of fabricantesRaw) {
    const norm = normalizeFabricanteCanonico(f.nomeNormalizado);
    if (norm) fabricantesPorNomeNormalizado.set(norm, f);
  }
  const regrasCnpPorCnp = new Map<number, RegraCnpParaResolver>(regrasCnpRaw.map((r) => [r.cnp, r]));
  const snapshotsPorCnp = new Map<number, SnapshotParaResolver>(snapshotsRaw.map((s) => [s.cnp, s]));
  const gruposFabricantePorFabricanteId = new Map<string, GrupoFabricanteParaResolver>(gruposFabricanteRaw.map((g) => [g.fabricanteId, g]));
  const aliasesPorNomeNormalizado = new Map<string, AliasParaResolver[]>();
  for (const a of aliasesRaw) {
    const lista = aliasesPorNomeNormalizado.get(a.aliasNormalizado) ?? [];
    lista.push({ grupoLaboratorialId: a.grupoLaboratorialId, estado: a.estado });
    aliasesPorNomeNormalizado.set(a.aliasNormalizado, lista);
  }

  return { fabricantesPorId, fabricantesPorNomeNormalizado, regrasCnpPorCnp, snapshotsPorCnp, gruposFabricantePorFabricanteId, aliasesPorNomeNormalizado };
}

async function seleccionarProdutos(prisma: PrismaParaReconciliacaoGrupos, opts: EscopoReconciliacao): Promise<ProdutoLeve[]> {
  if (opts.tipo === "produtos") {
    if (opts.produtoIds.length === 0) return [];
    return prisma.produto.findMany({ where: { id: { in: [...opts.produtoIds] } }, select: { id: true, cnp: true, fabricanteId: true } });
  }

  // Leitura leve (3 colunas escalares) de TODOS os produtos garantia — sem
  // `where`, mesmo padrão de scripts/classificar-grupos-laboratoriais-garantia.ts.
  // A filtragem por shard é feita aqui, em JS: o filtro Prisma declarativo
  // não expressa "cnp % N" sem $queryRaw, e raw SQL foi deliberadamente
  // evitado para manter o mesmo padrão tipado (Pick<PrismaClient[...]>)
  // do resto desta iniciativa.
  const todos = await prisma.produto.findMany({ select: { id: true, cnp: true, fabricanteId: true } });
  const buckets = opts.buckets ?? BUCKETS_DEFAULT;
  const diaEpoch = Math.floor(Date.now() / 86_400_000);
  const shardDoDia = diaEpoch % buckets;
  const doShard = todos.filter((p) => ((p.cnp % buckets) + buckets) % buckets === shardDoDia);
  const limiteSeguranca = opts.limiteSeguranca ?? LIMITE_SEGURANCA_DEFAULT;
  return doShard.slice(0, limiteSeguranca);
}

/**
 * Reconcilia `ProdutoGrupoLaboratorial` contra o estado ACTUAL da base —
 * ver o cabeçalho do ficheiro para as garantias de segurança. Nunca
 * lança excepção por produto individual (erros ficam em `erros`); só
 * lança se `tenantSlug !== "garantia"` (antes de qualquer query).
 */
export async function reconciliarGruposLaboratoriaisGarantia(
  prisma: PrismaParaReconciliacaoGrupos,
  tenantSlug: string,
  opts: EscopoReconciliacao,
): Promise<ReconciliacaoGruposLaboratoriaisSummary> {
  if (tenantSlug !== TENANT_TRAVADO) {
    throw new Error(`reconciliarGruposLaboratoriaisGarantia: tenant "${tenantSlug}" recusado — exclusivo do tenant "${TENANT_TRAVADO}".`);
  }

  const t0 = Date.now();
  const summary: ReconciliacaoGruposLaboratoriaisSummary = {
    analisados: 0, criados: 0, atualizados: 0, removidos: 0,
    manuaisPreservados: 0, semAlteracao: 0, propostasNaoAplicadas: 0, semGrupo: 0,
    erros: 0, durationMs: 0,
  };

  const produtos = await seleccionarProdutos(prisma, opts);
  if (produtos.length === 0) {
    summary.durationMs = Date.now() - t0;
    return summary;
  }

  const cnps = [...new Set(produtos.map((p) => p.cnp))];
  const mapas = await carregarMapas(prisma, cnps);

  const existentesRaw = await prisma.produtoGrupoLaboratorial.findMany({
    where: { produtoId: { in: produtos.map((p) => p.id) } },
    select: { produtoId: true, grupoLaboratorialId: true, origem: true, regraCnpId: true, validadoManualmente: true },
  });
  const existentesPorProdutoId = new Map<string, ExistenteLeve>(existentesRaw.map((e) => [e.produtoId, e]));

  for (const p of produtos) {
    summary.analisados++;
    const existente = existentesPorProdutoId.get(p.id) ?? null;
    const produtoParaResolver: ProdutoParaResolver = {
      id: p.id,
      cnp: p.cnp,
      fabricanteId: p.fabricanteId,
      grupoExistente: existente ? { grupoLaboratorialId: existente.grupoLaboratorialId, validadoManualmente: existente.validadoManualmente } : null,
    };
    const resultado = resolverGrupoDoProduto(produtoParaResolver, mapas);

    try {
      if (resultado.tipo === "mantido_manual") {
        summary.manuaisPreservados++;
        continue;
      }

      if (resultado.tipo === "regra_cnp" || resultado.tipo === "fabricante_inequivoco" || resultado.tipo === "alias_inequivoco") {
        const grupoLaboratorialId = resultado.grupoLaboratorialId;
        const origem = ORIGEM_POR_TIPO[resultado.tipo];
        const regraCnpId = resultado.tipo === "regra_cnp" ? resultado.regraCnpId : null;

        if (!existente) {
          await prisma.produtoGrupoLaboratorial.create({ data: { produtoId: p.id, grupoLaboratorialId, origem, regraCnpId } });
          summary.criados++;
        } else if (existente.grupoLaboratorialId !== grupoLaboratorialId || existente.origem !== origem || existente.regraCnpId !== regraCnpId) {
          await prisma.produtoGrupoLaboratorial.update({ where: { produtoId: p.id }, data: { grupoLaboratorialId, origem, regraCnpId } });
          summary.atualizados++;
        } else {
          summary.semAlteracao++;
        }
        continue;
      }

      // resultado.tipo é "proposta_snapshot_cnp" ou "sem_grupo" — nunca
      // aplicado automaticamente. Só remove uma classificação AUTOMÁTICA
      // anterior (validadoManualmente===false — garantido pela precedência
      // do resolver, verificado aqui de novo por defesa em profundidade).
      if (existente && existente.validadoManualmente === false) {
        await prisma.produtoGrupoLaboratorial.delete({ where: { produtoId: p.id } });
        summary.removidos++;
      } else if (resultado.tipo === "proposta_snapshot_cnp") {
        summary.propostasNaoAplicadas++;
      } else {
        summary.semGrupo++;
      }
    } catch {
      summary.erros++;
    }
  }

  summary.durationMs = Date.now() - t0;
  return summary;
}
