/**
 * lib/encomendas/origem-linha.ts
 *
 * De onde veio cada linha de uma encomenda, e o que acontece quando a
 * proposta é recalculada.
 *
 * ── O problema que isto resolve ──────────────────────────────────────
 *
 * «Gerar nova proposta» substituía `linhas` por inteiro:
 *
 *     setLinhas(result.data.rows.map(buildProposalLine));
 *
 * Tudo o que o utilizador tinha posto à mão desaparecia. O aviso
 * («substitui as linhas actuais») avisava, mas avisar de uma perda não
 * é o mesmo que não a causar — e a linha manual é, por construção, a
 * que ele mais pensou. Foi escolhida uma a uma, contra a recomendação
 * do cálculo.
 *
 * ── A regra ──────────────────────────────────────────────────────────
 *
 * A linha manual GANHA à proposta automática. Sempre.
 *
 * Não é preferência de gosto: a proposta é uma sugestão derivada de
 * vendas passadas; a linha manual é uma decisão de alguém que sabe
 * alguma coisa que o histórico não sabe — uma campanha, uma ruptura de
 * mercado, um pedido de cliente. Deixar o cálculo sobrepor-se a isso
 * inverte quem manda.
 *
 * Consequência concreta em `fundirComProposta`: quando a nova proposta
 * traz um produto que já tem linha manual, a linha da proposta é
 * DESCARTADA e a manual fica como está — com a quantidade que o
 * utilizador escreveu, não com a que o cálculo sugeriu.
 *
 * ── Porque é um módulo puro ──────────────────────────────────────────
 *
 * Porque é a regra de negócio da fase, e uma regra de negócio presa
 * dentro de um componente React de 1 300 linhas não se consegue testar
 * sem montar um DOM. Aqui testa-se com dois arrays.
 *
 * Sem Prisma, sem React, sem `server-only`.
 */

/**
 * As três proveniências de uma linha.
 *
 * Os nomes são os do enum da base de dados (`OrigemLinhaEncomenda`), e
 * são os mesmos do lado do cliente. Houve a tentação de ter
 * `"proposal" | "manual" | "prefill"` na UI e `PROPOSTA | MANUAL |
 * SUGESTAO` na BD, com uma tradução no meio; a tradução é exactamente o
 * sítio onde os dois lados divergem em silêncio no dia em que alguém
 * acrescenta um quarto valor a um só deles.
 */
export type OrigemLinha = "PROPOSTA" | "MANUAL" | "SUGESTAO";

/** Todas, para validação de entrada. */
export const ORIGENS_LINHA: readonly OrigemLinha[] = ["PROPOSTA", "MANUAL", "SUGESTAO"];

export function ehOrigemLinha(v: unknown): v is OrigemLinha {
  return typeof v === "string" && (ORIGENS_LINHA as readonly string[]).includes(v);
}

/**
 * A linha sobrevive a um recálculo da proposta?
 *
 * `SUGESTAO` sobrevive tanto como `MANUAL`: veio de o utilizador ter
 * aceitado uma sugestão de excesso ou de transferência noutro ecrã, e
 * essa decisão é tão dele como escrever o CNP à mão. Só `PROPOSTA` é
 * descartável — é o resultado do cálculo que se vai voltar a fazer.
 */
export function sobreviveARecalculo(origem: OrigemLinha): boolean {
  return origem !== "PROPOSTA";
}

/** O rótulo curto para o badge da tabela. `null` = sem badge. */
export function rotuloOrigem(origem: OrigemLinha): string | null {
  if (origem === "MANUAL") return "manual";
  if (origem === "SUGESTAO") return "sugestão";
  // A proposta é o caso normal e não leva marca: marcar tudo é não
  // marcar nada.
  return null;
}

/** O mínimo que a fusão precisa de saber sobre uma linha. */
export type LinhaFundivel = {
  produtoId: string;
  origem: OrigemLinha;
};

export type ResultadoFusao<T extends LinhaFundivel> = {
  /** As linhas finais: as preservadas primeiro, depois as novas. */
  linhas: T[];
  /** Quantas linhas manuais/sugestão sobreviveram. */
  preservadas: number;
  /**
   * Quantas linhas da nova proposta foram descartadas por já existir
   * linha manual para o mesmo produto.
   *
   * Não é ruído de implementação: é o número que a UI mostra ao
   * utilizador para ele saber que o cálculo propôs algo para um artigo
   * que ele já tinha decidido. Sem isto, a única forma de perceber
   * seria contar linhas.
   */
  propostasIgnoradas: number;
};

/**
 * Funde as linhas existentes com uma nova proposta.
 *
 * Invariantes, todas verificadas por teste:
 *
 *   · nenhuma linha manual ou de sugestão se perde;
 *   · nenhum `produtoId` aparece duas vezes;
 *   · a linha manual mantém a sua quantidade — a da proposta não a
 *     sobrepõe nem se soma a ela;
 *   · as linhas de PROPOSTA anteriores desaparecem, porque é isso que
 *     «recalcular» significa;
 *   · a ordem é: preservadas primeiro, novas a seguir. Quem acabou de
 *     pôr um artigo à mão espera vê-lo, e não ter de o procurar no meio
 *     de 2 000 linhas geradas.
 */
export function fundirComProposta<T extends LinhaFundivel>(
  existentes: readonly T[],
  novaProposta: readonly T[],
): ResultadoFusao<T> {
  const preservadas = existentes.filter((l) => sobreviveARecalculo(l.origem));
  const jaTem = new Set(preservadas.map((l) => l.produtoId));

  const novas: T[] = [];
  let propostasIgnoradas = 0;
  for (const l of novaProposta) {
    if (jaTem.has(l.produtoId)) {
      propostasIgnoradas++;
      continue;
    }
    // Uma proposta com o mesmo produto duas vezes não deveria acontecer
    // — o loader agrupa por produto — mas se acontecer, a segunda não
    // entra: `@@unique([listaEncomendaId, produtoId])` recusaria a
    // gravação e o utilizador veria um erro de base de dados em vez de
    // uma tabela coerente.
    if (novas.some((n) => n.produtoId === l.produtoId)) {
      propostasIgnoradas++;
      continue;
    }
    novas.push(l);
  }

  return {
    linhas: [...preservadas, ...novas],
    preservadas: preservadas.length,
    propostasIgnoradas,
  };
}
