/**
 * lib/catalog/resolver-grupo-laboratorial.ts
 *
 * Motor de precedência PURO que decide o grupo laboratorial PESQUISÁVEL
 * de um produto — nunca decide o fabricante legal (`Produto.fabricanteId`
 * nunca é lido para escrita nem alterado por nada neste ficheiro, só lido
 * para RESOLVER, nunca escrito).
 *
 * Os 6 níveis, por ordem estrita (o primeiro que produzir resultado
 * decide — os seguintes nem são avaliados):
 *
 *   1. mantido_manual         — o produto já tem um grupo com
 *                                `validadoManualmente=true`. Nunca é
 *                                substituído por nada, mesmo que uma
 *                                reimportação traga outro sinal.
 *   2. regra_cnp               — RegraGrupoLaboratorialPorCnp para este
 *                                CNP, `estado=ATIVO` E `validadoManualmente=true`.
 *   3. proposta_snapshot_cnp   — o titular ACTUAL (nunca histórico) do
 *                                catálogo nacional para este CNP resolve
 *                                a um Fabricante conhecido, mapeado a um
 *                                grupo. É SÓ uma proposta — nunca escrita
 *                                automaticamente num `ProdutoGrupoLaboratorial`
 *                                real sem validação humana (ver
 *                                `scripts/classificar-grupos-laboratoriais-garantia.ts`).
 *   4. fabricante_inequivoco   — `Produto.fabricanteId` (a identidade
 *                                LEGAL já atribuída) mapeia, via
 *                                `GrupoLaboratorialFabricante`, a um
 *                                grupo. Seguro para aplicar automaticamente
 *                                — a associação já foi curada quando foi
 *                                criada (só existe para fabricantes que
 *                                pertencem AO GRUPO INTEIRO).
 *   5. alias_inequivoco        — o nome do fabricante legal actual bate
 *                                com exactamente UM alias de grupo. Se
 *                                baterem aliases de MAIS DE UM grupo,
 *                                é ambíguo — nunca classifica, cai para
 *                                revisão (nível 6), nunca lança excepção.
 *   6. sem_grupo               — fila de revisão.
 *
 * Um registo histórico do catálogo (`Anulado`, `Revogado`, `Suspenso`,
 * `Retirado pela Entidade Reguladora`, etc. — tudo o que não seja
 * `Ativo`/`Activo`/`Autorizado`) NUNCA alimenta o nível 3 — ver
 * `ehEstadoAtual` em `catalogo-nacional-parser.ts`.
 */
import { normalizeFabricanteCanonico } from "../catalog-normalizers";
import { ehEstadoAtual } from "./catalogo-nacional-parser";

export type FabricanteParaResolver = {
  id: string;
  nomeNormalizado: string;
};

export type ProdutoParaResolver = {
  id: string;
  cnp: number;
  fabricanteId: string | null;
  /** O que já está gravado em ProdutoGrupoLaboratorial para este produto, se existir. */
  grupoExistente?: { grupoLaboratorialId: string; validadoManualmente: boolean } | null;
};

export type RegraCnpParaResolver = {
  id: string;
  grupoLaboratorialId: string;
  estado: "ATIVO" | "INATIVO";
  validadoManualmente: boolean;
};

export type SnapshotParaResolver = {
  cnp: number;
  titularAim: string | null;
  estadoAim: string | null;
};

export type GrupoFabricanteParaResolver = {
  grupoLaboratorialId: string;
};

export type AliasParaResolver = {
  grupoLaboratorialId: string;
  estado: "ATIVO" | "INATIVO";
};

export type ClassificacaoGrupoResultado =
  | { tipo: "mantido_manual"; grupoLaboratorialId: string }
  | { tipo: "regra_cnp"; grupoLaboratorialId: string; regraCnpId: string }
  | { tipo: "proposta_snapshot_cnp"; grupoLaboratorialId: string; snapshotCnp: number }
  | { tipo: "fabricante_inequivoco"; grupoLaboratorialId: string }
  | { tipo: "alias_inequivoco"; grupoLaboratorialId: string; aliasNormalizado: string }
  | { tipo: "sem_grupo"; motivo: string };

/** As 5 origens não-terminais — mesmos valores literais gravados em ProdutoGrupoLaboratorial.origem. */
export const ORIGEM_POR_TIPO: Record<Exclude<ClassificacaoGrupoResultado["tipo"], "sem_grupo">, string> = {
  mantido_manual: "MANUAL",
  regra_cnp: "REGRA_CNP",
  proposta_snapshot_cnp: "SNAPSHOT_CNP",
  fabricante_inequivoco: "FABRICANTE_INEQUIVOCO",
  alias_inequivoco: "ALIAS_INEQUIVOCO",
};

export type MapasResolverGrupo = {
  fabricantesPorId: ReadonlyMap<string, FabricanteParaResolver>;
  fabricantesPorNomeNormalizado: ReadonlyMap<string, FabricanteParaResolver>;
  regrasCnpPorCnp: ReadonlyMap<number, RegraCnpParaResolver>;
  snapshotsPorCnp: ReadonlyMap<number, SnapshotParaResolver>;
  gruposFabricantePorFabricanteId: ReadonlyMap<string, GrupoFabricanteParaResolver>;
  /** Alias normalizado -> todas as entradas de grupo que o reivindicam (pode ter >1 = ambíguo). */
  aliasesPorNomeNormalizado: ReadonlyMap<string, readonly AliasParaResolver[]>;
};

/** Resolve o grupo de UM produto. Nunca lança excepção — o pior caso é "sem_grupo". */
export function resolverGrupoDoProduto(produto: ProdutoParaResolver, mapas: MapasResolverGrupo): ClassificacaoGrupoResultado {
  // ── 1. manual ──
  if (produto.grupoExistente?.validadoManualmente) {
    return { tipo: "mantido_manual", grupoLaboratorialId: produto.grupoExistente.grupoLaboratorialId };
  }

  // ── 2. regra validada por CNP ──
  const regra = mapas.regrasCnpPorCnp.get(produto.cnp);
  if (regra && regra.estado === "ATIVO" && regra.validadoManualmente) {
    return { tipo: "regra_cnp", grupoLaboratorialId: regra.grupoLaboratorialId, regraCnpId: regra.id };
  }

  // ── 3. proposta de snapshot actual (NUNCA aplicada sem validação humana) ──
  const snapshot = mapas.snapshotsPorCnp.get(produto.cnp);
  if (snapshot && ehEstadoAtual(snapshot.estadoAim)) {
    const nomeNorm = normalizeFabricanteCanonico(snapshot.titularAim);
    if (nomeNorm) {
      const fabricanteDoSnapshot = mapas.fabricantesPorNomeNormalizado.get(nomeNorm);
      if (fabricanteDoSnapshot) {
        const grupoFab = mapas.gruposFabricantePorFabricanteId.get(fabricanteDoSnapshot.id);
        if (grupoFab) {
          return { tipo: "proposta_snapshot_cnp", grupoLaboratorialId: grupoFab.grupoLaboratorialId, snapshotCnp: produto.cnp };
        }
      }
    }
  }

  // ── 4. fabricante inteiro inequivocamente no grupo ──
  if (produto.fabricanteId) {
    const grupoFab = mapas.gruposFabricantePorFabricanteId.get(produto.fabricanteId);
    if (grupoFab) {
      return { tipo: "fabricante_inequivoco", grupoLaboratorialId: grupoFab.grupoLaboratorialId };
    }
  }

  // ── 5. alias inequívoco (contra o nome do fabricante legal actual) ──
  if (produto.fabricanteId) {
    const fab = mapas.fabricantesPorId.get(produto.fabricanteId);
    if (fab) {
      const candidatos = mapas.aliasesPorNomeNormalizado.get(fab.nomeNormalizado) ?? [];
      const gruposDistintos = new Set(candidatos.filter((a) => a.estado === "ATIVO").map((a) => a.grupoLaboratorialId));
      if (gruposDistintos.size === 1) {
        return { tipo: "alias_inequivoco", grupoLaboratorialId: [...gruposDistintos][0]!, aliasNormalizado: fab.nomeNormalizado };
      }
      // gruposDistintos.size > 1 → ambíguo: nunca classifica, cai para revisão.
    }
  }

  // ── 6. sem grupo ──
  return { tipo: "sem_grupo", motivo: "nenhum nível da precedência produziu uma classificação segura" };
}

export type RelatorioClassificacaoGrupos = {
  totais: {
    produtos: number;
    mantidoManual: number;
    regraCnp: number;
    propostaSnapshotCnp: number;
    fabricanteInequivoco: number;
    aliasInequivoco: number;
    semGrupo: number;
  };
  resultados: ReadonlyArray<{ produtoId: string; cnp: number; resultado: ClassificacaoGrupoResultado }>;
};

/** Resolve o grupo de UMA LISTA de produtos, com os totais agregados já prontos para o relatório de dry-run. */
export function resolverGruposEmLote(produtos: readonly ProdutoParaResolver[], mapas: MapasResolverGrupo): RelatorioClassificacaoGrupos {
  const totais: RelatorioClassificacaoGrupos["totais"] = {
    produtos: produtos.length,
    mantidoManual: 0,
    regraCnp: 0,
    propostaSnapshotCnp: 0,
    fabricanteInequivoco: 0,
    aliasInequivoco: 0,
    semGrupo: 0,
  };
  const resultados: Array<{ produtoId: string; cnp: number; resultado: ClassificacaoGrupoResultado }> = [];

  for (const produto of produtos) {
    const resultado = resolverGrupoDoProduto(produto, mapas);
    resultados.push({ produtoId: produto.id, cnp: produto.cnp, resultado });
    switch (resultado.tipo) {
      case "mantido_manual": totais.mantidoManual++; break;
      case "regra_cnp": totais.regraCnp++; break;
      case "proposta_snapshot_cnp": totais.propostaSnapshotCnp++; break;
      case "fabricante_inequivoco": totais.fabricanteInequivoco++; break;
      case "alias_inequivoco": totais.aliasInequivoco++; break;
      case "sem_grupo": totais.semGrupo++; break;
    }
  }

  return { totais, resultados };
}
