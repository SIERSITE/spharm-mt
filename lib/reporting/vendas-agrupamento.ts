/**
 * lib/reporting/vendas-agrupamento.ts
 *
 * Agrupamento hierárquico por ARTIGO, partilhado pela tabela em ecrã,
 * pelo separador Relatório, pela impressão, pelo PDF e pelo Excel.
 *
 * ── O DEFEITO ────────────────────────────────────────────────────────
 *
 * Com várias farmácias seleccionadas e "Agrupar por = Artigo", o mesmo
 * CNP aparecia em linhas independentes, uma por farmácia, como se
 * fossem produtos diferentes:
 *
 *   5647904  Zolpidem Aurovitas 10 Mg 20 Comp.  Silveirense  557
 *   5647904  Zolpidem Aurovitas 10 Mg 20 Comp.  Segurado     443
 *
 * A causa está no `vendas-client`: o agrupamento existia mas só era
 * usado quando `ambito === "grupo"`
 * (`currentRows = ambito === "grupo" ? groupRows : baseFiltered`).
 * Fora desse âmbito, o "Agrupar por" não tinha efeito nenhum sobre a
 * tabela — as linhas mostradas eram as linhas cruas do loader, uma por
 * (produto, farmácia).
 *
 * ── O QUE ESTE MÓDULO FAZ, E O QUE NÃO FAZ ───────────────────────────
 *
 * Não colapsa as farmácias numa linha só: o detalhe por farmácia é
 * informação operacional e perde-se se somarmos tudo. Produz uma
 * hierarquia — detalhe por farmácia + uma linha `TOTAL ARTIGO` — e
 * marca essa linha como sendo de APRESENTAÇÃO.
 *
 *   5647904  Zolpidem…  Silveirense   JAN…SET   557   stock 51
 *   5647904  Zolpidem…  Segurado      JAN…SET   443   stock 35
 *   5647904  Zolpidem…  TOTAL ARTIGO           1000   stock 86
 *
 * A linha de total NÃO é persistida, não é uma venda, e é excluída de
 * todos os totais gerais (ver `linhasDeDetalhe` em report-types).
 */

/** Um bucket mensal — mesma shape do loader (`SalesMonthBucket`). */
export type BucketMes = { ano: number; mes: number; quantidade: number };

/** O mínimo que uma linha de vendas precisa de ter para ser agrupada. */
export type LinhaAgrupavel = {
  codigo: string;
  descricao: string;
  farmacia: string;
  meses: BucketMes[];
  totalVendas: number;
  valorBruto?: number;
  existencia: number;
  unidadesVendidas?: number;
  pvp?: number;
};

export type GrupoArtigo<T extends LinhaAgrupavel> = {
  codigo: string;
  descricao: string;
  /** Uma linha por farmácia, na ordem em que entraram. */
  detalhes: T[];
  /** A linha `TOTAL ARTIGO`. Soma dos detalhes, e nada mais. */
  total: {
    codigo: string;
    descricao: string;
    farmacia: string;
    meses: BucketMes[];
    totalVendas: number;
    valorBruto: number;
    existencia: number;
    unidadesVendidas: number;
  };
};

/** O rótulo da linha de subtotal. Um sítio só, para os cinco outputs. */
export const ROTULO_TOTAL_ARTIGO = "TOTAL ARTIGO" as const;

/**
 * Agrupa por `codigo` preservando o detalhe por farmácia.
 *
 * A ordem dos grupos é a de primeira aparição — quem chama já ordenou as
 * linhas como o utilizador pediu, e reordenar aqui desfazia essa escolha.
 *
 * `buckets` fixa a ordem e o conjunto dos meses. Sem ele, dois produtos
 * com históricos diferentes produziam somas desalinhadas: a posição `i`
 * de um não era o mesmo mês que a posição `i` do outro.
 */
export function agruparPorArtigo<T extends LinhaAgrupavel>(
  linhas: readonly T[],
  buckets: readonly { ano: number; mes: number }[],
): GrupoArtigo<T>[] {
  const porCodigo = new Map<string, T[]>();
  for (const linha of linhas) {
    const lista = porCodigo.get(linha.codigo);
    if (lista) lista.push(linha);
    else porCodigo.set(linha.codigo, [linha]);
  }

  const grupos: GrupoArtigo<T>[] = [];
  for (const [codigo, detalhes] of porCodigo) {
    const primeiro = detalhes[0];
    // Soma posição-a-posição quando os buckets vêm alinhados (é o caso
    // do loader), com fallback por (ano,mes) para não somar Janeiro com
    // Fevereiro se alguma linha vier curta.
    const meses: BucketMes[] = buckets.map((b, i) => ({
      ano: b.ano,
      mes: b.mes,
      quantidade: detalhes.reduce((soma, d) => {
        const porPosicao = d.meses[i];
        const bucket =
          porPosicao && porPosicao.ano === b.ano && porPosicao.mes === b.mes
            ? porPosicao
            : d.meses.find((m) => m.ano === b.ano && m.mes === b.mes);
        return soma + (bucket?.quantidade ?? 0);
      }, 0),
    }));

    const totalVendas = detalhes.reduce((s, d) => s + (d.totalVendas ?? 0), 0);

    grupos.push({
      codigo,
      descricao: primeiro.descricao,
      detalhes,
      total: {
        codigo,
        descricao: primeiro.descricao,
        farmacia: ROTULO_TOTAL_ARTIGO,
        meses,
        totalVendas,
        // Soma dos valores GRAVADOS, nunca `totalVendas × pvp`: o pvp é
        // o preço de hoje e reprecificaria o histórico.
        valorBruto: detalhes.reduce((s, d) => s + (d.valorBruto ?? 0), 0),
        existencia: detalhes.reduce((s, d) => s + (d.existencia ?? 0), 0),
        unidadesVendidas: detalhes.reduce(
          (s, d) => s + (d.unidadesVendidas ?? d.totalVendas ?? 0),
          0,
        ),
      },
    });
  }
  return grupos;
}

/**
 * Quando é que a hierarquia vale a pena.
 *
 * Um artigo que só existe numa farmácia não ganha nada com uma linha de
 * total igual à linha de detalhe — só ruído. O grupo continua a existir
 * (a estrutura é a mesma para todos), mas quem desenha decide se mostra
 * a linha de total, e é esta a pergunta que faz.
 */
export function grupoPrecisaDeTotal<T extends LinhaAgrupavel>(g: GrupoArtigo<T>): boolean {
  return g.detalhes.length > 1;
}

/** Referências únicas: CNPs distintos, e não linhas de detalhe. */
export function contarReferenciasUnicas(linhas: readonly { codigo: string }[]): number {
  return new Set(linhas.map((l) => l.codigo)).size;
}
