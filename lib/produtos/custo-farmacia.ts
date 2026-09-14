/**
 * lib/produtos/custo-farmacia.ts
 *
 * A regra ÚNICA de "quanto custou este artigo a esta farmácia".
 *
 * ── Os dois custos, e o que cada um significa ─────────────────────────
 *
 * O ERP manda dois, e o agente grava os dois. Confirmado em três sítios
 * independentes do agente (`bootstrap-upload`, `daily-sync-runner`,
 * `bootstrap-dry-run`), todos com o mesmo SELECT:
 *
 *     Stocks.[Preco Medio Compra_EUR]   →  ProdutoFarmacia.pmc
 *     Stocks.[Preco Ultima Compra_EUR]  →  ProdutoFarmacia.puc
 *
 * Não são sinónimos, e o próprio SPharm trata-os como coisas diferentes:
 * a tabela `[dbo].[Encomendas Detalhe]` tem colunas separadas para os
 * dois, e o `spharm-orders-writer` preenche `[PMC_EUR]` com o médio e
 * `[PrecoCusto]` com o da última compra.
 *
 *   · PMC — preço MÉDIO de compra. É a valorização das existências: o
 *     que aquelas unidades custaram, em média, a entrar. É este que
 *     responde a «quanto capital está imobilizado neste stock».
 *
 *   · PUC — preço da ÚLTIMA compra. É o custo de reposição: o que
 *     custaria comprar mais uma unidade hoje. Responde a outra pergunta.
 *
 * Para valorizar stock — ficha, inventário, excessos, transferências —
 * a resposta é PMC. PUC entra só quando não há PMC, porque um custo
 * aproximado é melhor do que nenhum, e a origem fica registada para
 * quem quiser saber qual foi usado.
 *
 * ── Porque é que ZERO não é um custo ─────────────────────────────────
 *
 * O ERP não distingue «não sei» de «zero»: escreve 0 nos dois casos, e
 * as colunas nunca vêm a NULL. Medido no tenant garantia: das 95 226
 * linhas de ProdutoFarmacia, as três colunas de preço estão TODAS
 * preenchidas — mas só 73 115 têm `pmc > 0` e 88 087 têm `puc > 0`.
 *
 * Tratar esses zeros como custo real seria dizer que 22 000 artigos não
 * custaram nada, e um relatório de capital imobilizado passaria a somar
 * stock a custo zero sem o assinalar. Por isso o predicado é `> 0` e
 * não `!== null`.
 *
 * Restrito ao que interessa: das 33 204 linhas com stock > 0 nas cinco
 * farmácias da Garantia, apenas **34** não têm custo nenhum — 0,1 %. O
 * dado existe; é a representação da ausência que tem de estar certa.
 *
 * ── Porque é um módulo e não uma linha ───────────────────────────────
 *
 * Porque era uma linha, em `lib/inventario-data.ts`, correcta e sozinha.
 * A ficha do produto, os excessos e as transferências precisam agora da
 * mesma regra, e a forma de a terem igual nos quatro sítios não é
 * copiá-la três vezes — é esta. É o mesmo argumento que
 * `lib/reporting/catalog-prefilter.ts` faz sobre o `where` que estava
 * escrito em três loaders com a mesma condição em falta nos três.
 *
 * Módulo PURO: sem Prisma, sem `server-only`, sem React.
 */

/** Qual das duas colunas do ERP deu o valor. */
export type FonteCusto = "PMC" | "PUC";

export type CustoFarmacia = {
  /** O custo unitário, SEM IVA. `null` quando nenhuma coluna é utilizável. */
  valor: number | null;
  /** De onde veio. `null` quando não há valor. */
  fonte: FonteCusto | null;
};

/** Um valor de preço só conta se for um número finito e positivo. */
function utilizavel(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/**
 * O custo unitário de uma linha ProdutoFarmacia, com a origem.
 *
 * Aceita `Decimal` do Prisma convertido a `number` — quem chama faz a
 * conversão, porque é ela que sabe se veio de `$queryRaw` (já float) ou
 * de um `findMany` (Decimal).
 */
export function custoDaFarmacia(
  pmc: number | null | undefined,
  puc: number | null | undefined,
): CustoFarmacia {
  if (utilizavel(pmc)) return { valor: pmc, fonte: "PMC" };
  if (utilizavel(puc)) return { valor: puc, fonte: "PUC" };
  return { valor: null, fonte: null };
}

/** Só o número, para quem não precisa da origem. */
export function custoUnitario(
  pmc: number | null | undefined,
  puc: number | null | undefined,
): number | null {
  return custoDaFarmacia(pmc, puc).valor;
}

/**
 * Valoriza uma quantidade a um preço.
 *
 * `null` quando qualquer das peças falta — e é esse o ponto. Devolver 0
 * quando não se sabe o custo é a forma silenciosa de estragar um
 * relatório de capital imobilizado: a linha entra na tabela, não soma
 * nada, e ninguém repara que o total está curto. Um `null` aparece no
 * ecrã como «—» e diz a verdade.
 *
 * Quantidade zero é diferente: zero unidades a um custo conhecido valem
 * mesmo zero, e isso é um facto, não uma ausência.
 */
export function valorizar(
  quantidade: number | null | undefined,
  precoUnitario: number | null | undefined,
): number | null {
  if (typeof quantidade !== "number" || !Number.isFinite(quantidade)) return null;
  if (typeof precoUnitario !== "number" || !Number.isFinite(precoUnitario)) return null;
  return Math.round(quantidade * precoUnitario * 100) / 100;
}

/**
 * Soma uma coluna de valores que podem ser desconhecidos.
 *
 * Devolve o total E quantas linhas não puderam ser somadas. Um total sem
 * esse segundo número é uma afirmação mais forte do que os dados
 * permitem: «12 400 €» e «12 400 €, com 34 artigos por valorizar» são
 * leituras diferentes da mesma coluna, e só a segunda é honesta.
 */
export type SomaParcial = {
  total: number;
  /** Linhas com valor conhecido que entraram na soma. */
  contadas: number;
  /** Linhas cujo valor era `null` e ficaram de fora. */
  semValor: number;
};

export function somarParcial(valores: ReadonlyArray<number | null>): SomaParcial {
  let total = 0;
  let contadas = 0;
  let semValor = 0;
  for (const v of valores) {
    if (v === null || !Number.isFinite(v)) semValor++;
    else {
      total += v;
      contadas++;
    }
  }
  return { total: Math.round(total * 100) / 100, contadas, semValor };
}

/** O rótulo da origem, para tooltips. `null` → sem custo conhecido. */
export function descreverFonteCusto(fonte: FonteCusto | null): string {
  if (fonte === "PMC") return "preço médio de compra";
  if (fonte === "PUC") return "preço da última compra (sem preço médio)";
  return "sem custo registado no ERP";
}
