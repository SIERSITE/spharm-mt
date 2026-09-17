/**
 * lib/reporting/agrupamento-artigo.ts
 *
 * Agrupamento genérico "1 bloco por artigo, sublinhas por farmácia em
 * ordem estável" — o mecanismo visual do relatório de Vendas
 * (vendas-agrupamento.ts, `agruparPorArtigo`), generalizado para
 * qualquer relatório com a mesma forma de dados: uma linha por
 * (artigo, farmácia), várias farmácias por artigo — hoje, Margens Por
 * Produto e Inventário Por Produto (ver os respectivos adapters).
 *
 * Não partilha implementação com `vendas-agrupamento.ts` de propósito:
 * aquele módulo tem semântica MUITO específica de Vendas (buckets
 * mensais, agregação de custo via `agregarCusto`) e é intensivamente
 * testado como o relatório de referência desta uniformização — mexer
 * nele para o tornar genérico arriscava regressões exactamente no
 * relatório que serve de modelo aos outros. Este módulo replica só o
 * MECANISMO (agrupar por código preservando a ordem de 1ª aparição dos
 * grupos, ordenar farmácias de forma estável dentro de cada grupo) via
 * accessors — nunca assume o shape dos dados. A soma para a linha
 * TOTAL ARTIGO (o que É somável, o que fica "—") é sempre decidida
 * pelo adapter que chama isto, nunca aqui — cada relatório tem a sua
 * própria semântica de "o que significa somar isto".
 */
import { ordenarPorFarmacia } from "./ordenacao-farmacias";

export type GrupoArtigoGenerico<T> = {
  codigo: string;
  /** Uma linha por farmácia, já na ordem ESTÁVEL — nunca a de chegada. */
  detalhes: T[];
};

/**
 * Agrupa `linhas` por código (`getCodigo`), preservando a ordem de 1ª
 * aparição dos GRUPOS — quem chama já ordenou as linhas como quis (por
 * valor, por margem, por designação, ...), e reordenar os GRUPOS aqui
 * desfaria essa escolha. A ordem das FARMÁCIAS dentro de cada grupo é
 * outra questão, sempre estável (`ordenarPorFarmacia`), independente da
 * ordem dos grupos.
 */
export function agruparLinhasPorArtigo<T>(
  linhas: readonly T[],
  opts: {
    /** Código do artigo (tipicamente o CNP) — a chave de agrupamento. */
    getCodigo: (linha: T) => string;
    /** Nome (completo) da farmácia desta linha. */
    getFarmacia: (linha: T) => string;
    /** Ordem estável — tipicamente `universe.farmacias` do relatório. */
    ordemFarmacias?: readonly string[];
  },
): GrupoArtigoGenerico<T>[] {
  const porCodigo = new Map<string, T[]>();
  const ordemGrupos: string[] = [];
  for (const linha of linhas) {
    const codigo = opts.getCodigo(linha);
    const lista = porCodigo.get(codigo);
    if (lista) lista.push(linha);
    else {
      porCodigo.set(codigo, [linha]);
      ordemGrupos.push(codigo);
    }
  }
  return ordemGrupos.map((codigo) => ({
    codigo,
    detalhes: ordenarPorFarmacia(porCodigo.get(codigo)!, opts.getFarmacia, opts.ordemFarmacias),
  }));
}

/**
 * Um grupo só "vale a pena" mostrar uma linha TOTAL ARTIGO quando tem
 * mais de uma farmácia — com uma só, seria uma cópia exacta da linha de
 * detalhe. Mesmo critério de `vendas-agrupamento.ts::grupoPrecisaDeTotal`.
 */
export function grupoArtigoPrecisaDeTotal<T>(g: GrupoArtigoGenerico<T>): boolean {
  return g.detalhes.length > 1;
}
