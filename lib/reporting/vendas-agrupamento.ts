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
import { agregarCusto } from "@/lib/produtos/custo-farmacia";

/** Um bucket mensal — mesma shape do loader (`SalesMonthBucket`). */
export type BucketMes = { ano: number; mes: number; quantidade: number };

/** O mínimo que uma linha de vendas precisa de ter para ser agrupada. */
export type LinhaAgrupavel = {
  /** Custo unitário estimado da linha. `null` = desconhecido. */
  custoUnitarioEstimado?: number | null;
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
  /**
   * Uma linha por farmácia, em ordem ESTÁVEL (ver `compararPorOrdemFarmacia`
   * em `agruparPorArtigo`) — nunca a ordem em que as linhas de entrada
   * chegaram.
   */
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
    /** Σ dos custos dos detalhes. `null` quando nenhum tem custo. */
    custoEstimado: number | null;
    /** `custoEstimado / unidades das linhas com custo`. Nunca média simples. */
    custoUnitarioEstimado: number | null;
  };
};

/** O rótulo da linha de subtotal. Um sítio só, para os cinco outputs. */
export const ROTULO_TOTAL_ARTIGO = "TOTAL ARTIGO" as const;

/**
 * Compara duas linhas pela farmácia, para uma ordem ESTÁVEL e igual em
 * todos os artigos do relatório.
 *
 * Correcção (2026-09): sem isto, a ordem das farmácias DENTRO de cada
 * artigo dependia de qual farmácia tinha chegado primeiro nas linhas de
 * entrada — uma incidental da query SQL (`GROUP BY produtoId,
 * farmaciaId`, sem ORDER BY nenhum garantido para essa combinação), não
 * uma escolha. Um artigo mostrava "Segurado, Silveirense" e o seguinte
 * "Silveirense, Segurado", tornando a leitura caótica.
 *
 *   · `ordemFarmacias` (quando existe) é a ordem AUTORITATIVA — hoje,
 *     `input.universe.farmacias` do adapter de Vendas, que já vem
 *     alfabética (`localeCompare("pt-PT")`) e deduplicada de
 *     `vendas-client.tsx`. É "a ordem já definida/recebida pelo
 *     relatório", não inventada aqui.
 *   · Sem ela (chamador não a passou), cai em ordenação alfabética
 *     directa pelo nome da farmácia — nunca na ordem de chegada.
 *   · Uma farmácia ausente de `ordemFarmacias` (não devia acontecer,
 *     mas nunca se assume que não pode) fica ORDENADA DEPOIS das que lá
 *     estão, e entre si por ordem alfabética — nunca desaparece nem
 *     rebenta.
 */
function compararPorOrdemFarmacia(
  ordemFarmacias: readonly string[] | undefined,
): (a: { farmacia: string }, b: { farmacia: string }) => number {
  const indice = new Map((ordemFarmacias ?? []).map((nome, i) => [nome, i]));
  return (a, b) => {
    const ia = indice.get(a.farmacia);
    const ib = indice.get(b.farmacia);
    if (ia !== undefined && ib !== undefined) return ia - ib;
    if (ia !== undefined) return -1;
    if (ib !== undefined) return 1;
    return a.farmacia.localeCompare(b.farmacia, "pt-PT");
  };
}

/**
 * Agrupa por `codigo` preservando o detalhe por farmácia.
 *
 * A ordem dos grupos (que ARTIGOS aparecem primeiro) é a de primeira
 * aparição — quem chama já ordenou as linhas como o utilizador pediu
 * (por vendas, por CNP, ...), e reordenar aqui desfazia essa escolha.
 *
 * A ordem das FARMÁCIAS dentro de cada artigo é outra questão — ver
 * `compararPorOrdemFarmacia` acima. Independente da ordem dos grupos: um
 * artigo pode ter mais vendas e aparecer primeiro, mas as suas
 * sublinhas de farmácia seguem sempre a mesma ordem estável.
 *
 * `buckets` fixa a ordem e o conjunto dos meses. Sem ele, dois produtos
 * com históricos diferentes produziam somas desalinhadas: a posição `i`
 * de um não era o mesmo mês que a posição `i` do outro.
 */
export function agruparPorArtigo<T extends LinhaAgrupavel>(
  linhas: readonly T[],
  buckets: readonly { ano: number; mes: number }[],
  ordemFarmacias?: readonly string[],
): GrupoArtigo<T>[] {
  const porCodigo = new Map<string, T[]>();
  for (const linha of linhas) {
    const lista = porCodigo.get(linha.codigo);
    if (lista) lista.push(linha);
    else porCodigo.set(linha.codigo, [linha]);
  }

  const comparar = compararPorOrdemFarmacia(ordemFarmacias);

  const grupos: GrupoArtigo<T>[] = [];
  for (const [codigo, detalhesBrutos] of porCodigo) {
    // Ordem ESTÁVEL das farmácias — nunca a ordem incidental de chegada.
    const detalhes = [...detalhesBrutos].sort(comparar);
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
        // Custo: soma dos custos dos detalhes, e o unitario derivado
        // DESSA soma. Nunca media simples dos unitarios — ver
        // `agregarCusto`.
        ...(() => {
          const c = agregarCusto(
            detalhes.map((d) => ({
              quantidade: d.unidadesVendidas ?? d.totalVendas ?? 0,
              custoUnitario: d.custoUnitarioEstimado ?? null,
            })),
          );
          return { custoEstimado: c.total, custoUnitarioEstimado: c.unitarioMedio };
        })(),
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

/**
 * Os dois "Filtros rápidos" client-side do Relatório de Vendas.
 *
 * Vive aqui — não como duas linhas soltas repetidas em `vendas-client`
 * — para que qualquer extracção do universo de produtos feita a partir
 * das linhas (hoje: "Criar encomenda com estes produtos") aplique
 * exactamente o mesmo critério que decide o que a tabela mostra.
 */
export type TogglesRapidosVendas = {
  apenasComVendas: boolean;
  apenasComStock: boolean;
};

/**
 * `true` se a linha sobrevive aos toggles rápidos activos.
 *
 * Correcção (2026-09): "Apenas com stock" ALARGA o universo do relatório
 * (`lib/vendas-data.ts` já traz produtos sem venda mas com stock, em
 * união — ver `getVendasData`) — não é mais um filtro que ESTREITA.
 * A condição é `vendasNoPeriodo > 0 OR stockAtual > 0`, nunca `AND`.
 *
 * Por isso, quando `apenasComStock` está activo, `apenasComVendas` NÃO
 * pode voltar a excluir a linha que só está aqui por causa do stock —
 * seria desfazer o alargamento que o próprio loader já fez. Os dois
 * toggles deixam de ser independentes nesse sentido: "com stock" manda
 * quando os dois estão ligados.
 */
export function passaTogglesRapidosVendas(
  linha: Pick<LinhaAgrupavel, "totalVendas" | "existencia">,
  toggles: TogglesRapidosVendas,
): boolean {
  if (toggles.apenasComStock) {
    return linha.totalVendas > 0 || linha.existencia > 0;
  }
  if (toggles.apenasComVendas && linha.totalVendas === 0) return false;
  return true;
}

/**
 * O universo de CNP EFECTIVAMENTE visível numa vista de Vendas, depois
 * de todos os toggles client-side — nunca as linhas cruas do loader.
 *
 * Usado por "Criar encomenda com estes produtos" (Bloco B): a encomenda
 * tem de nascer do que está no ecrã naquele momento, não do relatório
 * bruto que o antecedeu.
 *
 * Exclui explicitamente qualquer linha de APRESENTAÇÃO — hoje só a
 * `TOTAL ARTIGO` que `agruparPorArtigo` insere para a tabela — mesmo
 * que nunca chegue a `baseFiltered`/`groupRows` (que a não produzem):
 * é a garantia de que ninguém a reintroduz por engano ao extrair CNPs
 * de `linhasTabela` no futuro.
 */
export function codigosVisiveisVendas<T extends LinhaAgrupavel>(
  linhas: readonly T[],
  toggles: TogglesRapidosVendas,
): string[] {
  return linhas
    .filter((l) => l.farmacia !== ROTULO_TOTAL_ARTIGO)
    .filter((l) => passaTogglesRapidosVendas(l, toggles))
    .map((l) => l.codigo);
}
