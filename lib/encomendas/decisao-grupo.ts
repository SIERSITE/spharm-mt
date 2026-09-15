/**
 * lib/encomendas/decisao-grupo.ts
 *
 * Bloco D — encomenda de grupo com decisão por linha.
 *
 * ── O problema ─────────────────────────────────────────────────────────
 *
 * Numa proposta de grupo, cada linha tem hoje um `estado` calculado
 * (TRANSFERÊNCIA | COMPRAR | AGUARDAR | ADEQUADO) — mas calculado não é
 * decidido. O utilizador tem de poder dizer, linha a linha, o que
 * realmente vai acontecer: ENCOMENDAR (nesta farmácia, com esta
 * quantidade), TRANSFERIR (desta origem para este destino, com esta
 * quantidade) ou NÃO FAZER. E essa decisão não pode desaparecer quando
 * a proposta é recalculada — a mesma regra que já protege `origem`
 * (`origem-linha.ts`) tem de proteger `acao`.
 *
 * ── Porque é um módulo puro ───────────────────────────────────────────
 *
 * Mesma razão de sempre: é regra de negócio, testável com arrays, sem
 * montar React nem Prisma. Sem `server-only` — é importado tanto pelo
 * cliente (para pré-preencher e fundir) como pela server action (para
 * agrupar antes de gerar os documentos).
 */

import type { ExcessoInfo, ProposalEstado } from "./proposal";

/** As três decisões possíveis para uma linha da proposta de grupo. */
export type AcaoLinhaGrupo = "ENCOMENDAR" | "TRANSFERIR" | "NAO_FAZER";

export const ACOES_LINHA_GRUPO: readonly AcaoLinhaGrupo[] = [
  "ENCOMENDAR",
  "TRANSFERIR",
  "NAO_FAZER",
];

export function ehAcaoLinhaGrupo(v: unknown): v is AcaoLinhaGrupo {
  return typeof v === "string" && (ACOES_LINHA_GRUPO as readonly string[]).includes(v);
}

/**
 * A decisão de uma linha — os campos que interessam ao resumo e à
 * geração dos documentos.
 *
 * Um único campo de quantidade cobre os dois casos accionáveis
 * (`quantidadeFinal` para ENCOMENDAR, `quantidadeTransferir` para
 * TRANSFERIR): são semanticamente distintos — um alimenta
 * `LinhaEncomenda.quantidadeAjustada`, o outro `LinhaTransferencia.quantidade`
 * — mas nunca coexistem para a mesma linha, por isso vivem em campos
 * separados em vez de um só "quantidade" ambíguo.
 */
export type DecisaoLinha = {
  produtoId: string;
  acao: AcaoLinhaGrupo;
  /**
   * `false` enquanto a decisão é só a sugestão do motor; `true` assim
   * que o utilizador a mudou à mão — por escolher outra acção OU por
   * mudar farmácia/quantidade sem mudar a acção. É o que
   * `fundirDecisoesGrupo` usa para saber o que sobrevive a um
   * recálculo, exactamente como `origem` faz para a linha inteira.
   */
  acaoTocada: boolean;
  farmaciaEncomendaId: string | null;
  quantidadeFinal: number;
  farmaciaOrigemId: string | null;
  farmaciaDestinoId: string | null;
  quantidadeTransferir: number;
};

/**
 * A sugestão inicial de decisão, derivada do `estado` que
 * `generateGroupProposal` já calcula.
 *
 *   TRANSFERÊNCIA → TRANSFERIR, com a primeira farmácia de excesso como
 *                   origem e esta farmácia (a que tem a necessidade)
 *                   como destino;
 *   COMPRAR       → ENCOMENDAR, nesta farmácia;
 *   AGUARDAR / ADEQUADO → NÃO FAZER.
 *
 * É só o ponto de partida — `acaoTocada` nasce `false`, e o utilizador
 * muda livremente por linha. Uma linha TRANSFERÊNCIA sem nenhuma
 * `excessoFonte` (não deveria acontecer — o motor só marca
 * TRANSFERÊNCIA quando encontrou excesso — mas um dado inconsistente
 * não deve rebentar) cai em NÃO FAZER em vez de TRANSFERIR sem origem.
 */
export function sugerirDecisao(input: {
  farmaciaId: string | null;
  estado: ProposalEstado | null;
  suggestedQty: number;
  transferirQty: number;
  excessoFonte: readonly ExcessoInfo[];
}): DecisaoLinha {
  const base: DecisaoLinha = {
    produtoId: "",
    acao: "NAO_FAZER",
    acaoTocada: false,
    farmaciaEncomendaId: input.farmaciaId,
    quantidadeFinal: Math.max(0, input.suggestedQty),
    farmaciaOrigemId: null,
    farmaciaDestinoId: null,
    quantidadeTransferir: 0,
  };

  if (input.estado === "TRANSFERÊNCIA" && input.excessoFonte.length > 0) {
    return {
      ...base,
      acao: "TRANSFERIR",
      farmaciaOrigemId: input.excessoFonte[0].farmaciaId,
      farmaciaDestinoId: input.farmaciaId,
      quantidadeTransferir: Math.max(
        0,
        input.transferirQty > 0 ? input.transferirQty : input.suggestedQty,
      ),
    };
  }
  if (input.estado === "COMPRAR") {
    return { ...base, acao: "ENCOMENDAR" };
  }
  return base;
}

/**
 * A forma mínima de uma linha do LADO DO CLIENTE que participa da
 * decisão. Deliberadamente DIFERENTE de `DecisaoLinha`: o ecrã tem UM
 * único campo de quantidade (`finalQty`, string — é a coluna "Final"
 * que a tabela já tinha, partilhada por ENCOMENDAR e TRANSFERIR),
 * enquanto `DecisaoLinha` (usada no resumo e na geração, incluindo no
 * servidor) separa `quantidadeFinal`/`quantidadeTransferir` como
 * números. Confundir as duas formas obrigaria `Line` a carregar dois
 * campos numéricos redundantes com `finalQty` só para satisfazer este
 * módulo — é o próprio módulo que se adapta à forma que já existe no
 * ecrã, e não o inverso.
 */
export type LinhaComDecisao = {
  produtoId: string;
  /**
   * Farmácia DESTA linha (a que gerou a sugestão original) — distinta de
   * `farmaciaEncomendaId`/`farmaciaOrigemId`/`farmaciaDestinoId`, que são
   * a DECISÃO. Obrigatória para a chave composta de `mapaDecisoes` — sem
   * ela, o mesmo `produtoId` em duas farmácias diferentes (proposta de
   * grupo com &gt;1 farmácia a precisar/ter excesso do mesmo produto)
   * colidia no `Map` e uma farmácia herdava, por engano, a decisão da
   * outra ao recalcular a proposta.
   */
  farmaciaId: string | null;
  acao: AcaoLinhaGrupo;
  acaoTocada: boolean;
  farmaciaEncomendaId: string | null;
  farmaciaOrigemId: string | null;
  farmaciaDestinoId: string | null;
  finalQty: string;
};

/**
 * Chave composta produto+farmácia — é a granularidade real de uma linha
 * de proposta de grupo (ver `LinhaComDecisao.farmaciaId`). Nunca usar só
 * `produtoId` como chave de um `Map`/índice de linhas de grupo.
 */
function chaveLinha(produtoId: string, farmaciaId: string | null): string {
  return `${produtoId}:${farmaciaId ?? ""}`;
}

/**
 * Preserva a decisão do utilizador entre recálculos da proposta.
 *
 * Espelha `fundirComProposta` (`origem-linha.ts`): só o que foi TOCADO
 * à mão sobrevive; uma sugestão ainda intocada é livremente substituída
 * pela nova sugestão, porque é exactamente isso que "recalcular"
 * significa para ela.
 *
 * Funciona sobre QUALQUER T com a forma de `LinhaComDecisao` — tanto
 * sobre linhas preservadas por `fundirComProposta` (MANUAL/SUGESTAO,
 * que já chegam com a decisão intacta — para essas isto é um no-op)
 * como sobre as linhas de PROPOSTA recém-geradas (para quem isto é o
 * único sítio onde a decisão sobrevive).
 */
export function fundirDecisoesGrupo<T extends LinhaComDecisao>(
  linhasFinais: readonly T[],
  decisoesAntigas: ReadonlyMap<string, LinhaComDecisao>,
): T[] {
  return linhasFinais.map((l) => {
    const antiga = decisoesAntigas.get(chaveLinha(l.produtoId, l.farmaciaId));
    if (!antiga || !antiga.acaoTocada) return l;
    return {
      ...l,
      acao: antiga.acao,
      acaoTocada: true,
      farmaciaEncomendaId: antiga.farmaciaEncomendaId,
      farmaciaOrigemId: antiga.farmaciaOrigemId,
      farmaciaDestinoId: antiga.farmaciaDestinoId,
      finalQty: antiga.finalQty,
    };
  });
}

/** Índice por produtoId+farmaciaId (`chaveLinha`), para `fundirDecisoesGrupo`. */
export function mapaDecisoes<T extends LinhaComDecisao>(
  linhas: readonly T[],
): Map<string, LinhaComDecisao> {
  return new Map(
    linhas.map((l) => [
      chaveLinha(l.produtoId, l.farmaciaId),
      {
        produtoId: l.produtoId,
        farmaciaId: l.farmaciaId,
        acao: l.acao,
        acaoTocada: l.acaoTocada,
        farmaciaEncomendaId: l.farmaciaEncomendaId,
        farmaciaOrigemId: l.farmaciaOrigemId,
        farmaciaDestinoId: l.farmaciaDestinoId,
        finalQty: l.finalQty,
      },
    ]),
  );
}

// ─── Resumo e agrupamento para geração ─────────────────────────────────

export type ResumoBaldeEncomenda = { farmaciaId: string; nLinhas: number };
export type ResumoBaldeTransferencia = { origemId: string; destinoId: string; nLinhas: number };

export type ResumoGrupo = {
  encomendas: ResumoBaldeEncomenda[];
  transferencias: ResumoBaldeTransferencia[];
  naoFazer: number;
  total: number;
};

/** Chave estável de uma direcção de transferência, para os dois Maps abaixo. */
export function chaveDirecao(origemId: string, destinoId: string): string {
  return `${origemId}>${destinoId}`;
}

export function parseDirecao(chave: string): { origemId: string; destinoId: string } {
  const i = chave.indexOf(">");
  return { origemId: chave.slice(0, i), destinoId: chave.slice(i + 1) };
}

/**
 * Uma linha só conta para um balde ENCOMENDAR/TRANSFERIR se tiver
 * farmácia(s) definida(s) E quantidade > 0 — uma decisão com quantidade
 * 0 não é uma linha accionável, e contá-la infla o resumo com uma
 * promessa vazia. Cai em "não fazer" nesse caso, mesmo que a acção
 * nominal seja outra.
 */
function balde(d: DecisaoLinha): "ENCOMENDAR" | "TRANSFERIR" | "NAO_FAZER" {
  if (d.acao === "ENCOMENDAR" && d.farmaciaEncomendaId && d.quantidadeFinal > 0) return "ENCOMENDAR";
  if (
    d.acao === "TRANSFERIR" &&
    d.farmaciaOrigemId &&
    d.farmaciaDestinoId &&
    d.farmaciaOrigemId !== d.farmaciaDestinoId &&
    d.quantidadeTransferir > 0
  )
    return "TRANSFERIR";
  return "NAO_FAZER";
}

/**
 * Conta linhas por balde: uma entrada por farmácia com ENCOMENDAR, uma
 * por direcção com TRANSFERIR. É o que a etapa de resumo mostra antes
 * do botão «Gerar» — nada aqui cria nada, só conta.
 */
export function calcularResumoGrupo(decisoes: readonly DecisaoLinha[]): ResumoGrupo {
  const porFarmacia = new Map<string, number>();
  const porDirecao = new Map<string, number>();
  let naoFazer = 0;

  for (const d of decisoes) {
    const b = balde(d);
    if (b === "ENCOMENDAR") {
      porFarmacia.set(d.farmaciaEncomendaId!, (porFarmacia.get(d.farmaciaEncomendaId!) ?? 0) + 1);
    } else if (b === "TRANSFERIR") {
      const k = chaveDirecao(d.farmaciaOrigemId!, d.farmaciaDestinoId!);
      porDirecao.set(k, (porDirecao.get(k) ?? 0) + 1);
    } else {
      naoFazer++;
    }
  }

  return {
    encomendas: [...porFarmacia.entries()].map(([farmaciaId, nLinhas]) => ({ farmaciaId, nLinhas })),
    transferencias: [...porDirecao.entries()].map(([k, nLinhas]) => {
      const { origemId, destinoId } = parseDirecao(k);
      return { origemId, destinoId, nLinhas };
    }),
    naoFazer,
    total: decisoes.length,
  };
}

/**
 * Agrupa as decisões accionáveis para a geração: uma entrada por
 * farmácia com linhas ENCOMENDAR, uma por direcção com linhas
 * TRANSFERIR.
 *
 * NUNCA devolve um balde vazio — uma farmácia ou direcção só aparece no
 * Map quando pelo menos uma linha lhe foi empurrada. É esta propriedade
 * que garante que `gerarPlanoGrupoAction` nunca cria uma ListaEncomenda
 * ou Transferencia sem linhas.
 */
export function agruparParaGeracao<T extends { produtoId: string } & DecisaoLinha>(
  decisoes: readonly T[],
): {
  porFarmacia: Map<string, T[]>;
  porDirecao: Map<string, T[]>;
} {
  const porFarmacia = new Map<string, T[]>();
  const porDirecao = new Map<string, T[]>();

  for (const d of decisoes) {
    const b = balde(d);
    if (b === "ENCOMENDAR") {
      const k = d.farmaciaEncomendaId!;
      if (!porFarmacia.has(k)) porFarmacia.set(k, []);
      porFarmacia.get(k)!.push(d);
    } else if (b === "TRANSFERIR") {
      const k = chaveDirecao(d.farmaciaOrigemId!, d.farmaciaDestinoId!);
      if (!porDirecao.has(k)) porDirecao.set(k, []);
      porDirecao.get(k)!.push(d);
    }
  }

  return { porFarmacia, porDirecao };
}
