/**
 * lib/encomendas/agrupar-produto.ts
 *
 * Consolidação visual de `Line[]` por produto — SÓ para o modo grupo da
 * proposta de encomenda (`order-create-client.tsx`).
 *
 * ── O problema ─────────────────────────────────────────────────────────
 *
 * Em modo grupo, `Line` é uma linha por FARMÁCIA, não por produto: o
 * mesmo `produtoId`/`cnp` pode aparecer em N `Line` distintas — uma por
 * farmácia com necessidade/decisão própria — sem tecto (o grupo pode ter
 * todas as farmácias activas do tenant). Mostrar isto como hoje (uma
 * linha de tabela por `Line`) repete designação/CNP/fabricante uma vez
 * por farmácia, o que é ruído quando o utilizador quer ver o produto UMA
 * vez e as farmácias por baixo.
 *
 * ── O que isto NÃO faz ───────────────────────────────────────────────────
 *
 * Não achata nem perde nenhum campo por-farmácia: cada `Line` original
 * sobrevive inteira dentro de `subLinhas`. Isto é agrupamento de
 * APRESENTAÇÃO — a decisão (ENCOMENDAR/TRANSFERIR/NÃO FAZER), a
 * quantidade final, as notas, o estado, tudo continua a viver e a ser
 * editado ao nível da `Line` individual. O resumo por balde
 * (`calcularResumoGrupo`) e a geração do plano (`agruparParaGeracao`,
 * ambos em `decisao-grupo.ts`) continuam a operar sobre o array plano de
 * `Line` — nunca sobre `GrupoProduto`.
 *
 * ── Porque é um módulo puro ───────────────────────────────────────────
 *
 * Mesma razão de `decisao-grupo.ts`/`origem-linha.ts`: é uma
 * transformação testável com arrays, sem montar React. Genérico sobre
 * `T extends LinhaAgrupavel` (mesmo padrão de `LinhaComDecisao` em
 * `decisao-grupo.ts`) para não obrigar este módulo a conhecer a forma
 * completa de `Line` — só os campos de que precisa para o cabeçalho do
 * grupo.
 */

/** O mínimo que uma linha precisa de ter para ser agrupada por produto. */
export type LinhaAgrupavel = {
  produtoId: string;
  cnp: number;
  designacao: string;
  fabricante: string | null;
  fornecedor: string | null;
};

/**
 * Um produto e todas as `Line` (sub-linhas, uma por farmácia) que lhe
 * pertencem nesta proposta. `cnp`/`designacao`/`fabricante`/`fornecedor`
 * vêm da PRIMEIRA sub-linha encontrada — são os mesmos em todas (o motor
 * de proposta nunca produz o mesmo `produtoId` com designação/CNP
 * diferentes), por isso não há ambiguidade em escolher a primeira.
 */
export type GrupoProduto<T extends LinhaAgrupavel> = {
  produtoId: string;
  cnp: number;
  designacao: string;
  fabricante: string | null;
  fornecedor: string | null;
  /** Uma entrada por farmácia — a `Line` original, intacta. */
  subLinhas: T[];
};

/**
 * Agrupa `linhas` por `produtoId`, preservando cada `Line` original como
 * sub-linha. A ordem dos grupos é a de PRIMEIRA APARIÇÃO do produto em
 * `linhas` — estável e previsível (não reordena por nenhum critério de
 * negócio; quem quiser outra ordem, ordena `linhas` antes de chamar
 * isto, exactamente como a tabela já faz com `ordenarLinhas`).
 *
 * `linhas` vazio devolve `[]`. Nunca lança.
 */
export function agruparPorProduto<T extends LinhaAgrupavel>(
  linhas: readonly T[],
): GrupoProduto<T>[] {
  const porProduto = new Map<string, GrupoProduto<T>>();
  const ordem: string[] = [];

  for (const l of linhas) {
    let grupo = porProduto.get(l.produtoId);
    if (!grupo) {
      grupo = {
        produtoId: l.produtoId,
        cnp: l.cnp,
        designacao: l.designacao,
        fabricante: l.fabricante,
        fornecedor: l.fornecedor,
        subLinhas: [],
      };
      porProduto.set(l.produtoId, grupo);
      ordem.push(l.produtoId);
    }
    grupo.subLinhas.push(l);
  }

  return ordem.map((id) => porProduto.get(id)!);
}
