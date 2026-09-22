/**
 * lib/catalog/propostas-fabricante-por-cnp.ts
 *
 * Classificação PURA de produtos SEM fabricante, separada da
 * classificação de grupo laboratorial (ver resolver-grupo-laboratorial.ts
 * — são dois problemas distintos, o utilizador foi explícito sobre isto).
 *
 * Nunca escreve `Produto.fabricanteId` — só classifica em 4 categorias,
 * para o dry-run reportar. A decisão de aplicar (uma fase futura, fora
 * deste ficheiro) tem de respeitar `protegido_manual` sempre, e só pode
 * aplicar `proposta_atual` automaticamente — `revisao_historico` e
 * `sem_correspondencia` vão sempre para revisão humana.
 */
import { normalizeFabricanteCanonico } from "../catalog-normalizers";
import { ehEstadoAtual } from "./catalogo-nacional-parser";

export type ProdutoSemFabricanteParaResolver = {
  id: string;
  cnp: number;
  /** Produto.camposManuais — se incluir "fabricanteId", a AUSÊNCIA de fabricante foi uma decisão humana explícita. */
  camposManuais: readonly string[];
};

export type SnapshotParaPropostaFabricante = {
  titularAim: string | null;
  estadoAim: string | null;
};

export type FabricanteParaPropostaFabricante = {
  id: string;
  nomeNormalizado: string;
};

export type PropostaFabricante =
  /** `fabricanteId` está em `camposManuais` — uma decisão manual já existe (mesmo que seja "sem fabricante"). Nunca sugerir nada. */
  | { tipo: "protegido_manual" }
  /** O catálogo tem um registo ACTUAL (Ativo/Activo/Autorizado) para este CNP, com titular reconhecido — candidato a preenchimento automático em dry-run. */
  | { tipo: "proposta_atual"; fabricanteId: string; titular: string }
  /** O catálogo só tem registo(s) HISTÓRICO(S) para este CNP — nunca preenche automaticamente, vai para revisão obrigatória. */
  | { tipo: "revisao_historico" }
  /** Sem registo no catálogo, ou titular não reconhecido como Fabricante existente — sem correspondência, fila de revisão. */
  | { tipo: "sem_correspondencia" };

export function resolverPropostaFabricante(
  produto: ProdutoSemFabricanteParaResolver,
  snapshotsPorCnp: ReadonlyMap<number, SnapshotParaPropostaFabricante>,
  fabricantesPorNomeNormalizado: ReadonlyMap<string, FabricanteParaPropostaFabricante>,
): PropostaFabricante {
  if (produto.camposManuais.includes("fabricanteId")) {
    return { tipo: "protegido_manual" };
  }

  const snapshot = snapshotsPorCnp.get(produto.cnp);
  if (!snapshot || !snapshot.titularAim) {
    return { tipo: "sem_correspondencia" };
  }

  if (!ehEstadoAtual(snapshot.estadoAim)) {
    return { tipo: "revisao_historico" };
  }

  const nomeNorm = normalizeFabricanteCanonico(snapshot.titularAim);
  if (!nomeNorm) {
    return { tipo: "sem_correspondencia" };
  }

  const fabricante = fabricantesPorNomeNormalizado.get(nomeNorm);
  if (!fabricante) {
    return { tipo: "sem_correspondencia" };
  }

  return { tipo: "proposta_atual", fabricanteId: fabricante.id, titular: snapshot.titularAim };
}

export type RelatorioPropostasFabricante = {
  totais: { total: number; protegidoManual: number; propostaAtual: number; revisaoHistorico: number; semCorrespondencia: number };
  resultados: ReadonlyArray<{ produtoId: string; cnp: number; proposta: PropostaFabricante }>;
};

export function resolverPropostasFabricanteEmLote(
  produtos: readonly ProdutoSemFabricanteParaResolver[],
  snapshotsPorCnp: ReadonlyMap<number, SnapshotParaPropostaFabricante>,
  fabricantesPorNomeNormalizado: ReadonlyMap<string, FabricanteParaPropostaFabricante>,
): RelatorioPropostasFabricante {
  const totais = { total: produtos.length, protegidoManual: 0, propostaAtual: 0, revisaoHistorico: 0, semCorrespondencia: 0 };
  const resultados: RelatorioPropostasFabricante["resultados"] = produtos.map((produto) => {
    const proposta = resolverPropostaFabricante(produto, snapshotsPorCnp, fabricantesPorNomeNormalizado);
    switch (proposta.tipo) {
      case "protegido_manual": totais.protegidoManual++; break;
      case "proposta_atual": totais.propostaAtual++; break;
      case "revisao_historico": totais.revisaoHistorico++; break;
      case "sem_correspondencia": totais.semCorrespondencia++; break;
    }
    return { produtoId: produto.id, cnp: produto.cnp, proposta };
  });
  return { totais, resultados };
}
