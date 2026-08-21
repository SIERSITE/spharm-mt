/**
 * lib/catalog/knowledge-enrichment-runner.ts
 *
 * A volta completa: selecciona o residual, lê a cache, propõe, verifica,
 * e escreve o que passar o gate.
 *
 * Separado de `knowledge-enrichment.ts` de propósito: aquele módulo é
 * puro (prompt, esquema, validação, gate, comparação) e testável sem base
 * de dados nem rede; este é o que toca em Postgres.
 *
 * ORDEM DAS FASES — não é negociável
 *   1. As regras determinísticas correm sempre primeiro (classify-backfill
 *      → fill-rules). Este runner assume-as feitas.
 *   2. Só entra aqui o que sobrou. A selecção é SQL (`SQL_RESIDUAL`), não
 *      é escolha do modelo.
 *
 * O QUE ESCREVE — e só isto
 *   productType (quando falta), classificacaoNivel1Id,
 *   classificacaoNivel2Id, ProdutoUtilizacao.
 *   Ver `CAMPOS_ESCRITOS` / `CAMPOS_PROIBIDOS`. Não há neste ficheiro
 *   nenhum UPDATE que toque em ATC, DCI, fabricante, imagem ou forma
 *   farmacêutica — todos têm fonte melhor.
 *
 * IDEMPOTÊNCIA
 *   Correr duas vezes seguidas gasta zero chamadas na segunda: tudo o que
 *   a primeira viu ficou em cache, incluindo os DESCONHECIDO e os que
 *   foram para revisão. As escritas são todas guardadas por `is null`,
 *   `ilike 'Outros %'` ou confiança superior.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import {
  KNOWLEDGE_MODEL,
  KNOWLEDGE_VERSION,
  LIMIAR_CLINICO,
  TAMANHO_LOTE,
  alvoParaProduto,
  avaliarGate,
  chaveCache,
  classificarLote,
  classificarUtilizacoesLote,
  compararPassagens,
  precisaVerificacao,
  verificarLote,
  verificarUtilizacoesLote,
  type AlvoPedido,
  type Criterios,
  type DecisaoEscrita,
  type Decisao,
  type KnowledgeResult,
  type ProdutoResidual,
} from "./knowledge-enrichment";
import {
  FATOR_CONFIANCA_PROPAGADA,
  LIMIAR_COBERTURA_PERCENT,
  POPULACAO_MINIMA_SUBCATEGORIA,
  agruparFamilias,
  coberturaPorSubcategoria,
  preselecionar,
  subcategoriasExcluiveis,
  type Destino,
  type ProdutoPreselecao,
} from "./preselection";
import { lerConhecimentoGlobal, promoverAoGlobal } from "./global-catalog-store";
import type { ConhecimentoCandidato, OrigemGlobal } from "./global-catalog";

/** Códigos internos da farmácia não entram no catálogo regulamentar. */
export const MIN_CNP = 2_000_000;

/**
 * Lotes tratados em paralelo.
 *
 * Quatro e não mais: o ganho de latência achata-se depressa (o tempo é
 * dominado pela geração, não pela ligação) e cada trabalhador extra
 * aproxima o tecto de custo de ser ultrapassado por mais um lote. Quatro
 * transforma dezasseis horas em cerca de quatro sem chegar perto dos
 * limites de ritmo da API — e o runner já recupera de 429 com backoff,
 * portanto o modo de falha ao subir demais é abrandar, não partir.
 */
export const CONCORRENCIA_OMISSAO = 4;

/** Marca de proveniência em ProdutoUtilizacao.fonte. */
export const FONTE = "MODELO";
/**
 * Proveniência de um valor que não é uma observação DESTE produto — é a
 * conclusão sobre um irmão da mesma família estrita, aplicada aqui.
 * Distinta na base para que um dia se possa reverter só a propagação.
 */
export const FONTE_PROPAGADA = "MODELO_PROPAGADO";

/** As três fatias do residual — o canary é estratificado por elas. */
export type Estrato = "OUTROS_MEDICAMENTOS" | "NAO_CLASSIFICADO" | "SEM_UTILIZACOES";

/**
 * O residual, definido em SQL, com o estrato calculado na própria query.
 *
 * Três formas de um produto ser residual, e são exactamente os três
 * estratos do canary:
 *   · NAO_CLASSIFICADO    — sem categoria nenhuma;
 *   · OUTROS_MEDICAMENTOS — em "Outros <X>" (o balde);
 *   · SEM_UTILIZACOES     — classificado e específico, mas sem utilização.
 *
 * E duas exclusões absolutas:
 *   · `validadoManualmente` — decisão humana; nem se lê para gastar
 *     tokens a reconfirmar;
 *   · cnp abaixo de MIN_CNP — códigos internos, não são catálogo.
 *
 * A cláusula da cache é o que torna o job diário barato: um produto já
 * visto nesta versão não volta a entrar, tenha sido escrito ou não.
 */
/**
 * Os filtros por estrato TÊM de particionar exactamente o residual, e ser
 * o espelho do `case` que atribui o estrato mais abaixo. Se um produto
 * for elegível pelo filtro combinado mas não couber em nenhum dos três
 * filtros por estrato, desaparece do canary sem deixar rasto.
 *
 * Era o que acontecia a um produto com `classificacaoNivel2Id` preenchido
 * a apontar para uma Classificacao inexistente: `c2.nome` fica NULL, e em
 * SQL `NULL not ilike 'Outros %'` não é FALSE — é NULL, que o WHERE trata
 * como "não passa". O produto caía fora de OUTROS_MEDICAMENTOS (não é
 * 'Outros %') E fora de SEM_UTILIZACOES (o `not ilike` não deu TRUE),
 * apesar de o `case` o classificar como SEM_UTILIZACOES pelo ramo `else`.
 */
export function corpoResidual(estrato?: Estrato): string {
  const semUtilizacoes = `not exists (select 1 from "ProdutoUtilizacao" pu where pu."produtoId" = p.id)`;
  const filtro =
    estrato === "NAO_CLASSIFICADO"
      ? `and p."classificacaoNivel2Id" is null`
      : estrato === "OUTROS_MEDICAMENTOS"
      ? `and p."classificacaoNivel2Id" is not null and c2.nome ilike 'Outros %'`
      : estrato === "SEM_UTILIZACOES"
      ? `and p."classificacaoNivel2Id" is not null
         and (c2.nome is null or c2.nome not ilike 'Outros %')
         and ${semUtilizacoes}`
      : `and (p."classificacaoNivel2Id" is null
             or c2.nome ilike 'Outros %'
             or ${semUtilizacoes})`;

  return `
      from "Produto" p
      left join "Classificacao" c1 on c1.id = p."classificacaoNivel1Id"
      left join "Classificacao" c2 on c2.id = p."classificacaoNivel2Id"
     where p.cnp >= $1
       and p."validadoManualmente" = false
       ${filtro}
       and not exists (
             select 1 from "KnowledgeEnrichmentCache" k
              where k.cnp = p.cnp and k.versao = $2 and k.modelo = $3
       )`;
}

function sqlResidual(estrato?: Estrato): string {
  return `
    select p.cnp,
           p.designacao,
           p."productType",
           c1.nome as "categoriaAtual",
           c2.nome as "subcategoriaAtual",
           case
             when p."classificacaoNivel2Id" is null then 'NAO_CLASSIFICADO'
             when c2.nome ilike 'Outros %'          then 'OUTROS_MEDICAMENTOS'
             else 'SEM_UTILIZACOES'
           end as estrato
    ${corpoResidual(estrato)}
     order by p.cnp
     limit $4`;
}

/**
 * Quantos produtos existem no estrato, SEM limite.
 *
 * É o que distingue "este estrato está vazio" de "a consulta partiu-se".
 * Sem esta contagem, as duas hipóteses produzem exactamente o mesmo
 * output — zero linhas — e a corrida entrega uma amostra encolhida sem
 * dizer que encolheu.
 */
function sqlContagem(estrato?: Estrato): string {
  return `select count(*)::int as n ${corpoResidual(estrato)}`;
}

/** Uma linha do relatório por produto — o que o dry-run imprime. */
export type LinhaRelatorio = {
  cnp: number;
  designacao: string;
  estrato: Estrato;
  /** O que foi pedido ao modelo para este produto. */
  alvo: AlvoPedido;
  estadoAtual: string;
  proposta: string;
  utilizacoes: string[];
  decisao: Decisao;
  /** Discordância forte num produto já classificado. Nunca escrita. */
  anomalia: string | null;
  motivo: string;
  criterios: Criterios | null;
  confidence: number;
  evidenceType: string;
  verificado: boolean;
  /** true quando a proposta e a verificação divergiram. */
  discordancia: boolean;
  /** cnp do representante, quando este valor foi propagado. */
  propagadoDe?: number | null;
};

type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };

/**
 * Métricas de um estrato. O global escondia o que interessa: os três
 * estratos têm custos por produto diferentes — pedidos diferentes,
 * verificações diferentes, taxas de aplicação diferentes — e uma média
 * sobre os três não projecta nenhum deles.
 */
export type MetricasEstrato = {
  estrato: Estrato;
  alvo: AlvoPedido;
  /** Produtos do estrato ANTES da pré-selecção. */
  universoInicial: number;
  excluidosBaixaCobertura: number;
  excluidosOpacos: number;
  representantesEnviados: number;
  enviadosAoModelo: number;
  propagados: number;
  /** Produtos com resultado do modelo (não inclui propagados). */
  produtos: number;
  apply: number;
  review: number;
  skip: number;
  anomalias: number;
  chamadasProposta: number;
  chamadasVerificacao: number;
  usage: Usage;
  custoUsd: number;
  /** `custoUsd / produtos`. Zero quando o estrato não correu. */
  custoPorProduto: number;
  /** População do estrato na base, de `sqlContagem`. Null fora do canary. */
  elegiveis: number | null;
  /** `custoPorProduto × elegiveis` — a projecção que interessa. */
  projecaoUsd: number | null;
};

/** Um produto que a pré-selecção tirou da fila, e porquê. */
export type LinhaPreselecao = {
  cnp: number;
  designacao: string;
  estrato: Estrato;
  destino: Destino;
  chaveFamilia: string | null;
  representanteCnp: number | null;
  motivo: string;
};

export type RunnerResumo = {
  residualAnalisado: number;
  /** CNPs que o catálogo global já conhecia — não foram ao modelo. */
  jaConhecidosGlobal: number;
  /** Candidatos promovidos ao catálogo global nesta corrida. */
  promovidosAoGlobal: number;
  /** Problemas não fatais (ex.: control plane inacessível). */
  avisos: string[];
  /** Não foram ao modelo: subcategoria sem utilização plausível. */
  excluidosBaixaCobertura: number;
  /** Não foram ao modelo: designação sem conteúdo reconhecível. */
  excluidosOpacos: number;
  /** Famílias com um representante e pelo menos um dependente. */
  familiasPropagaveis: number;
  representantesEnviados: number;
  /** Produtos efectivamente enviados ao modelo. */
  enviadosAoModelo: number;
  /** Produtos escritos a partir da decisão de um representante. */
  propagados: number;
  /** Famílias que não propagam por os irmãos não concordarem. */
  conflitosFamilia: number;
  preselecao: LinhaPreselecao[];
  /**
   * Quota pedida vs servida por estrato. `null` fora do modo canary.
   * É aqui que um estrato vazio se declara, em vez de a amostra encolher
   * em silêncio.
   */
  quotasCanary: QuotaEstrato[] | null;
  porEstrato: Record<string, number>;
  chamadasProposta: number;
  chamadasVerificacao: number;
  /** Resultados que sobreviveram à validação de vocabulário. */
  propostasValidas: number;
  /** Precisavam de segunda passagem. */
  verificacoesAplicaveis: number;
  /** Segunda passagem concordou. */
  verificacoesConcordantes: number;
  apply: number;
  review: number;
  skip: number;
  /** Discordâncias fortes em produtos já classificados. Nunca escritas. */
  anomalias: number;
  /** Uma entrada por estrato que correu. */
  metricasPorEstrato: MetricasEstrato[];
  categoriasEscritas: number;
  productTypesEscritos: number;
  utilizacoesEscritas: number;
  /** ke-2.0 — campos clínicos gravados, um contador por campo. */
  dciEscritas: number;
  atcEscritos: number;
  formasEscritas: number;
  dosagensEscritas: number;
  embalagensEscritas: number;
  /** Resultados em que o modelo devolveu clínica mas ficou abaixo do limiar. */
  clinicaRecusadaPorConfianca: number;
  /** Resultados em que o ATC veio malformado e foi deitado fora. */
  atcRejeitadoPorFormato: number;
  porEvidencia: Record<string, number>;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  custoEstimadoUsd: number;
  /** A corrida parou por ter atingido `tectoUsd`, não por ter acabado. */
  cortadoPorTecto: boolean;
  relatorio: LinhaRelatorio[];
};

/** Preço do claude-opus-5 por milhão de tokens (Junho 2026). */
const USD_POR_MTOK = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };

function estimarCusto(u: RunnerResumo["usage"]): number {
  return (
    (u.inputTokens * USD_POR_MTOK.input +
      u.outputTokens * USD_POR_MTOK.output +
      u.cacheReadTokens * USD_POR_MTOK.cacheRead +
      u.cacheWriteTokens * USD_POR_MTOK.cacheWrite) /
    1_000_000
  );
}

type LinhaResidual = ProdutoResidual & { estrato: Estrato };

/** Quotas por omissão do canary: 40 + 30 + 30 = 100. */
export const QUOTAS_CANARY: Readonly<Record<Estrato, number>> = {
  OUTROS_MEDICAMENTOS: 40,
  NAO_CLASSIFICADO: 30,
  SEM_UTILIZACOES: 30,
};

/** O que cada estrato deu, e o que ficou por dar. */
export type QuotaEstrato = {
  estrato: Estrato;
  /** Quota pedida. */
  pedido: number;
  /** Quantos existem no estrato, sem limite. */
  elegiveis: number;
  /** Quantos entraram na amostra, já sem duplicados. */
  obtido: number;
  /** `pedido - obtido`. Zero quando a quota foi servida por inteiro. */
  defice: number;
};

export type AmostraCanary = {
  linhas: LinhaResidual[];
  quotas: QuotaEstrato[];
};

/**
 * Amostra estratificada. Os primeiros N por cnp não são uma amostra do
 * catálogo — são uma amostra dos cnp mais baixos, que é outra coisa e
 * não representa as três fatias do residual.
 *
 * Cada estrato tem a sua consulta e a sua quota. Devolve TAMBÉM o que
 * cada um deu: um estrato vazio deixa de ser indistinguível de um estrato
 * que não foi consultado, que era o furo — a amostra encolhia em silêncio
 * e o relatório saía a dizer 30 produtos como se fossem os 100 pedidos.
 *
 * Não se compensa um estrato com produtos de outro. A amostra é
 * estratificada por uma razão; enchê-la com o que sobra do estrato ao
 * lado dava um total bonito e uma amostra que já não representa nada.
 */
export async function selecionarCanary(
  prisma: PrismaClient,
  quotas: Partial<Record<Estrato, number>> = QUOTAS_CANARY,
): Promise<AmostraCanary> {
  const linhas: LinhaResidual[] = [];
  const relatorioQuotas: QuotaEstrato[] = [];
  // Os estratos são mutuamente exclusivos por construção, mas a garantia
  // de unicidade fica aqui e não na confiança de que assim seja: um cnp
  // repetido custaria uma classificação paga duas vezes e uma linha
  // duplicada no relatório.
  const vistos = new Set<number>();

  for (const [estrato, pedido] of Object.entries(quotas) as [Estrato, number][]) {
    if (!pedido) continue;

    const [{ n: elegiveis }] = await prisma.$queryRawUnsafe<{ n: number }[]>(
      sqlContagem(estrato),
      MIN_CNP,
      KNOWLEDGE_VERSION,
      KNOWLEDGE_MODEL,
    );

    const doEstrato = await prisma.$queryRawUnsafe<LinhaResidual[]>(
      sqlResidual(estrato),
      MIN_CNP,
      KNOWLEDGE_VERSION,
      KNOWLEDGE_MODEL,
      pedido,
    );

    let obtido = 0;
    for (const l of doEstrato) {
      if (vistos.has(l.cnp)) continue;
      vistos.add(l.cnp);
      // O estrato é o da consulta que o trouxe. O `case` da query e o
      // filtro dizem sempre o mesmo desde que os filtros particionam o
      // residual — mas se um dia divergirem, é a consulta que manda,
      // senão a contagem por estrato mentiria sobre a sua própria quota.
      linhas.push({ ...l, estrato });
      obtido++;
    }

    relatorioQuotas.push({
      estrato,
      pedido,
      elegiveis: Number(elegiveis) || 0,
      obtido,
      defice: Math.max(0, pedido - obtido),
    });
  }

  return { linhas, quotas: relatorioQuotas };
}

/**
 * Contexto para a pré-selecção: o catálogo INTEIRO, não só o residual.
 *
 * Tem de ser o catálogo inteiro por duas razões. As famílias precisam de
 * ver irmãos que já estão classificados — esses estão, por definição,
 * fora do residual. E a cobertura de utilizações por subcategoria só
 * significa alguma coisa medida sobre toda a subcategoria; medida só
 * sobre o residual daria sempre perto de zero, porque o residual é
 * exactamente o que não tem utilizações.
 */
async function carregarContexto(prisma: PrismaClient): Promise<ProdutoPreselecao[]> {
  const linhas = await prisma.$queryRawUnsafe<{
    cnp: number; designacao: string | null;
    nivel1: string | null; nivel2: string | null; utilizacoes: string[] | null;
  }[]>(
    `select p.cnp,
            p.designacao,
            c1.nome as nivel1,
            c2.nome as nivel2,
            coalesce(array_agg(u.slug) filter (where u.slug is not null), '{}') as utilizacoes
       from "Produto" p
       left join "Classificacao" c1 on c1.id = p."classificacaoNivel1Id"
       left join "Classificacao" c2 on c2.id = p."classificacaoNivel2Id"
       left join "ProdutoUtilizacao" pu on pu."produtoId" = p.id
       left join "Utilizacao" u on u.id = pu."utilizacaoId"
      where p.cnp >= $1
      group by p.cnp, p.designacao, c1.nome, c2.nome`,
    MIN_CNP,
  );
  return linhas.map((r) => ({
    cnp: Number(r.cnp),
    designacao: r.designacao ?? "",
    nivel1: r.nivel1,
    nivel2: r.nivel2,
    utilizacoes: (r.utilizacoes ?? []).filter(Boolean),
  }));
}

export async function runKnowledgeEnrichment(
  prisma: PrismaClient,
  opts: {
    limite?: number;
    dryRun?: boolean;
    /** Corta a corrida quando o custo estimado passa disto. */
    tectoUsd?: number;
    /**
     * Lotes em paralelo. Omitido = `CONCORRENCIA_OMISSAO`.
     * 1 restaura o comportamento sequencial anterior.
     */
    concorrencia?: number;
    /** Amostra estratificada em vez dos primeiros N. */
    canary?: Partial<Record<Estrato, number>>;
    /** Slug do tenant — registado como origem do conhecimento promovido. */
    tenantSlug?: string;
    /** Desligar o catálogo global (para medir uma corrida sem ele). */
    usarGlobal?: boolean;
    onProgress?: (feito: number, total: number) => void;
    /**
     * Substituem as chamadas ao modelo. Existem para o teste de
     * read-only poder correr a volta inteira sem rede — sem isto, provar
     * que o dry-run não escreve exigia uma credencial e dinheiro real.
     * Em produção ficam por omissão.
     */
    classificar?: typeof classificarLote;
    verificar?: typeof verificarLote;
    classificarUtilizacoes?: typeof classificarUtilizacoesLote;
    verificarUtilizacoes?: typeof verificarUtilizacoesLote;
  } = {},
): Promise<RunnerResumo> {
  const dryRun = opts.dryRun ?? false;
  const classificar = opts.classificar ?? classificarLote;
  const verificar = opts.verificar ?? verificarLote;
  // Quem injecta só `classificar` num teste continua a ter um duplo para
  // o caminho de utilizações — senão o teste tocaria a rede.
  const classificarUtil = opts.classificarUtilizacoes ?? opts.classificar ?? classificarUtilizacoesLote;
  const verificarUtil = opts.verificarUtilizacoes ?? opts.verificar ?? verificarUtilizacoesLote;

  let quotasCanary: QuotaEstrato[] | null = null;
  let residual: LinhaResidual[];
  if (opts.canary) {
    const amostra = await selecionarCanary(prisma, opts.canary);
    residual = amostra.linhas;
    quotasCanary = amostra.quotas;
  } else {
    residual = await prisma.$queryRawUnsafe<LinhaResidual[]>(
      sqlResidual(),
      MIN_CNP,
      KNOWLEDGE_VERSION,
      KNOWLEDGE_MODEL,
      opts.limite ?? 500,
    );
  }

  const resumo: RunnerResumo = {
    residualAnalisado: residual.length,
    jaConhecidosGlobal: 0,
    promovidosAoGlobal: 0,
    avisos: [],
    excluidosBaixaCobertura: 0,
    excluidosOpacos: 0,
    familiasPropagaveis: 0,
    representantesEnviados: 0,
    enviadosAoModelo: 0,
    propagados: 0,
    conflitosFamilia: 0,
    preselecao: [],
    quotasCanary,
    porEstrato: {},
    chamadasProposta: 0,
    chamadasVerificacao: 0,
    propostasValidas: 0,
    verificacoesAplicaveis: 0,
    verificacoesConcordantes: 0,
    apply: 0,
    review: 0,
    skip: 0,
    anomalias: 0,
    metricasPorEstrato: [],
    categoriasEscritas: 0,
    productTypesEscritos: 0,
    utilizacoesEscritas: 0,
    dciEscritas: 0,
    atcEscritos: 0,
    formasEscritas: 0,
    dosagensEscritas: 0,
    embalagensEscritas: 0,
    clinicaRecusadaPorConfianca: 0,
    atcRejeitadoPorFormato: 0,
    porEvidencia: {},
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    custoEstimadoUsd: 0,
    cortadoPorTecto: false,
    relatorio: [],
  };
  // Candidatos a promover ao catálogo global. Recolhidos durante a
  // corrida, escritos de uma vez no fim.
  const candidatosGlobais: ConhecimentoCandidato[] = [];

  /**
   * Junta um resultado APPLY à fila de promoção.
   *
   * Só o que ficou com classificação ESPECÍFICA: um "Outros <X>" não é
   * conhecimento e não serve nenhum outro tenant. `avaliarPromocao`
   * recusa-o de qualquer forma — não enviar poupa a viagem.
   */
  const juntarCandidato = (
    r: KnowledgeResult,
    p: ProdutoResidual,
    gate: DecisaoEscrita,
    utilizacoes: string[],
    confianca: number,
    origem: OrigemGlobal,
  ): void => {
    if (gate.decisao !== "APPLY") return;
    const temClassificacao = !!r.categoria && !!r.subcategoria && !/^outros\b/i.test(r.subcategoria);
    if (!temClassificacao && utilizacoes.length === 0) return;
    candidatosGlobais.push({
      cnp: p.cnp,
      designacaoReferencia: p.designacao,
      productType: gate.gravarProductType ? r.productType : null,
      categoria: temClassificacao ? r.categoria : null,
      subcategoria: temClassificacao ? r.subcategoria : null,
      // As utilizações que o runner produz vêm da mesma decisão que a
      // classificação — directa ou propagada — portanto herdam a origem
      // dela. É o único sítio onde isso é verdade: no bootstrap cada
      // utilização traz a sua, lida de `ProdutoUtilizacao.fonte`.
      utilizacoes: utilizacoes.map((slug) => ({
        slug,
        confidence: confianca,
        origem,
        fonteOriginal: origem === "PROPAGADO" ? FONTE_PROPAGADA : FONTE,
        motivo: "decisão do modelo nesta corrida",
      })),
      confidence: confianca,
      evidenceType: r.evidenceType,
      origem,
      motivoOrigem: "decisão do modelo nesta corrida",
      fonteOriginal: origem === "PROPAGADO" ? "MODEL_PROPAGATED" : "MODEL_INFERRED",
      versaoRegras: KNOWLEDGE_VERSION,
      verificado: gate.criterios.verificado,
      tenantOrigem: opts.tenantSlug ?? "(desconhecido)",
    });
  };

  // Métricas por estrato, criadas à medida que cada um é tocado.
  const metricas = new Map<Estrato, MetricasEstrato>();
  const elegiveisPorEstrato = new Map<Estrato, number>(
    (quotasCanary ?? []).map((q) => [q.estrato, q.elegiveis]),
  );
  const metrica = (estrato: Estrato): MetricasEstrato => {
    let m = metricas.get(estrato);
    if (!m) {
      m = {
        estrato,
        alvo: estrato === "SEM_UTILIZACOES" ? "UTILIZACOES" : "CLASSIFICACAO",
        universoInicial: 0,
        excluidosBaixaCobertura: 0,
        excluidosOpacos: 0,
        representantesEnviados: 0,
        enviadosAoModelo: 0,
        propagados: 0,
        produtos: 0,
        apply: 0,
        review: 0,
        skip: 0,
        anomalias: 0,
        chamadasProposta: 0,
        chamadasVerificacao: 0,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        custoUsd: 0,
        custoPorProduto: 0,
        elegiveis: elegiveisPorEstrato.get(estrato) ?? null,
        projecaoUsd: null,
      };
      metricas.set(estrato, m);
    }
    return m;
  };

  for (const l of residual) resumo.porEstrato[l.estrato] = (resumo.porEstrato[l.estrato] ?? 0) + 1;
  if (residual.length === 0) return resumo;

  // A proveniência vive em colunas que uma migração acrescentou. Sem
  // elas, cada gravação de cache falharia a meio de uma corrida paga.
  // Mais vale parar aqui, com a mensagem certa.
  if (!dryRun) {
    const [{ n }] = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `select count(*)::int as n from information_schema.columns
        where table_name = 'KnowledgeEnrichmentCache' and column_name in ('origem', 'propagadoDeCnp')`,
    );
    if (Number(n) < 2) {
      throw new Error(
        "KnowledgeEnrichmentCache não tem as colunas de proveniência (origem, propagadoDeCnp).\n" +
          "Correr `npx prisma migrate deploy` nesta base antes de usar --apply.",
      );
    }
  }

  // ── CATÁLOGO GLOBAL: o filtro que vem antes de todos ────────────────
  //
  // O mesmo CNP é o mesmo produto nacional. Um CNP que outro tenant já
  // pagou não volta ao modelo — é projectado a partir do global.
  //
  // Isto corre ANTES da pré-selecção de propósito: não vale a pena
  // calcular famílias e cobertura para produtos que nem sequer vão à
  // fila. Desligável (`usarGlobal: false`) para se poder medir uma
  // corrida sem esta camada.
  if (opts.usarGlobal !== false) {
    try {
      const conhecidos = await lerConhecimentoGlobal(residual.map((l) => l.cnp));
      if (conhecidos.size > 0) {
        const antes = residual.length;
        residual = residual.filter((l) => !conhecidos.has(l.cnp));
        resumo.jaConhecidosGlobal = antes - residual.length;
        for (const l of residual) void l;
      }
    } catch (err) {
      // O control plane estar em baixo não pode impedir uma corrida: o
      // pior que acontece é pagar-se por CNPs que já eram conhecidos.
      resumo.avisos.push(
        `catálogo global inacessível — corrida sem ele: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (residual.length === 0) {
    resumo.metricasPorEstrato = [...metricas.values()];
    return resumo;
  }

  // ── PRÉ-SELECÇÃO ────────────────────────────────────────────────────
  // Decide, sem gastar uma chamada, o que não precisa de ir ao modelo.
  // Tudo o que aqui se calcula vem dos dados DESTE tenant: a cobertura
  // por subcategoria e as famílias são medidas na hora, não configuradas.
  const contexto = await carregarContexto(prisma);
  const familias = agruparFamilias(contexto);
  const cobertura = coberturaPorSubcategoria(contexto);
  const subExcluidas = subcategoriasExcluiveis(
    cobertura,
    LIMIAR_COBERTURA_PERCENT,
    POPULACAO_MINIMA_SUBCATEGORIA,
  );
  const preselecao = preselecionar(residual, contexto, { familias, subcategoriasExcluidas: subExcluidas });
  const contextoPorCnp = new Map(contexto.map((p) => [p.cnp, p]));

  // Dependentes por representante: quem espera pela decisão de quem.
  const dependentes = new Map<number, LinhaResidual[]>();
  const enviar: LinhaResidual[] = [];
  for (const l of residual) {
    const pre = preselecao.get(l.cnp);
    if (!pre) continue;
    const m = metrica(l.estrato);
    m.universoInicial++;
    switch (pre.destino) {
      case "EXCLUIR_OPACO":
        resumo.excluidosOpacos++; m.excluidosOpacos++;
        break;
      case "EXCLUIR_BAIXA_COBERTURA":
        resumo.excluidosBaixaCobertura++; m.excluidosBaixaCobertura++;
        break;
      case "PROPAGAR": {
        const lista = dependentes.get(pre.representanteCnp!) ?? [];
        lista.push(l);
        dependentes.set(pre.representanteCnp!, lista);
        break;
      }
      case "REPRESENTANTE":
        resumo.representantesEnviados++; m.representantesEnviados++;
        enviar.push(l);
        break;
      default:
        enviar.push(l);
    }
    if (pre.destino !== "ENVIAR" && pre.destino !== "REPRESENTANTE") {
      resumo.preselecao.push({
        cnp: l.cnp,
        designacao: contextoPorCnp.get(l.cnp)?.designacao ?? "",
        estrato: l.estrato,
        destino: pre.destino,
        chaveFamilia: pre.chaveFamilia,
        representanteCnp: pre.representanteCnp,
        motivo: pre.motivo,
      });
    }
  }
  for (const f of familias.values()) if (f.conflito) resumo.conflitosFamilia++;
  resumo.familiasPropagaveis = dependentes.size;
  resumo.enviadosAoModelo = enviar.length;
  for (const l of enviar) metrica(l.estrato).enviadosAoModelo++;

  // A partir daqui trabalha-se só sobre o que vai mesmo ao modelo.
  residual = enviar;
  if (residual.length === 0) {
    resumo.metricasPorEstrato = [...metricas.values()];
    return resumo;
  }

  // Vocabulário → id, resolvido uma vez. Taxonomia fechada: um nome que
  // não exista em BD não é criado, o produto fica por classificar.
  const tax = await prisma.$queryRawUnsafe<{ id: string; nome: string; pai: string | null }[]>(
    `select id, nome, "classificacaoPaiId" as pai from "Classificacao" where estado = 'ATIVO'`,
  );
  const n1PorNome = new Map<string, string>();
  const n2PorChave = new Map<string, string>();
  for (const r of tax) if (!r.pai) n1PorNome.set(r.nome.toUpperCase(), r.id);
  for (const r of tax) if (r.pai) n2PorChave.set(`${r.pai}::${r.nome.toUpperCase()}`, r.id);

  const utilVocab = await prisma.$queryRawUnsafe<{ id: string; slug: string }[]>(
    `select id, slug from "Utilizacao" where estado = 'ATIVO'`,
  );
  const utilPorSlug = new Map(utilVocab.map((u) => [u.slug, u.id]));

  /**
   * A ÚNICA função que escreve em Produto e ProdutoUtilizacao.
   *
   * Partilhada pela decisão directa e pela propagação de propósito: se
   * fossem dois caminhos, as guardas SQL teriam de estar escritas duas
   * vezes, e um dia estariam escritas de duas maneiras. O que muda entre
   * os dois é só a confiança, a fonte e o tier — nunca as guardas.
   */
  /**
   * O que NÃO se propaga de um representante para os irmãos.
   *
   * A propagação por família existe porque "Ozempic 0,25 mg" e "Ozempic
   * 0,5 mg" são o mesmo produto para efeitos de ARRUMAÇÃO: mesma
   * categoria, mesma subcategoria, mesmas utilizações, mesma substância.
   * Não são o mesmo produto para efeitos de APRESENTAÇÃO — a dosagem é
   * precisamente aquilo que os distingue.
   *
   * Sem esta separação, o HALDOL 5 MG herdava a dosagem "1 mg" do irmão
   * de 1 mg. Aconteceu mesmo, na corrida de validação de 2026-08-21, e é
   * pior que não ter dosagem nenhuma: um campo vazio lê-se como "não
   * sabemos", um campo errado lê-se como facto.
   *
   * `dci` e `codigoATC` continuam a propagar: são propriedades da
   * substância, iguais em toda a família por definição — o ATC do
   * haloperidol é N05AD01 em qualquer dosagem.
   */
  const semApresentacao = (r: KnowledgeResult) => ({
    forma: null as string | null,
    dosagem: null as string | null,
    embalagem: null as string | null,
    // A confiança clínica do representante refere-se à apresentação DELE.
    // Mantém-se só o que sobrevive — se ficou sem apresentação, o que
    // resta é a substância, e essa é a mesma.
    confidenceClinica: r.dci || r.codigoATC ? r.confidenceClinica : 0,
  });

  const escrever = async (
    r: KnowledgeResult,
    p: ProdutoResidual,
    gate: DecisaoEscrita,
    utilizacoesFinais: string[],
    confianca: number,
    fonte: string,
    tier: string,
  ): Promise<void> => {
    if (gate.decisao !== "APPLY") return;

    if (gate.gravarCategoria && r.categoria && r.subcategoria) {
      const n1Id = n1PorNome.get(r.categoria.toUpperCase());
      const n2Id = n1Id ? n2PorChave.get(`${n1Id}::${r.subcategoria.toUpperCase()}`) : undefined;
      if (n1Id && n2Id) {
        // A não-degradação está escrita outra vez aqui, no WHERE: mesmo
        // que o estado tenha mudado entre o SELECT e agora, uma
        // subcategoria específica não é sobreposta.
        const n = await prisma.$executeRawUnsafe(
          `update "Produto" p
              set "classificacaoNivel1Id" = $1,
                  "classificacaoNivel2Id" = $2,
                  "dataAtualizacao"       = now()
            where p.cnp = $3
              and p."validadoManualmente" = false
              and (p."classificacaoNivel2Id" is null
                   or exists (select 1 from "Classificacao" c
                               where c.id = p."classificacaoNivel2Id"
                                 and c.nome ilike 'Outros %'))`,
          n1Id,
          n2Id,
          p.cnp,
        );
        if (Number(n) > 0) resumo.categoriasEscritas++;
      }
    }

    // productType só quando falta — `is null` no WHERE é a guarda.
    if (gate.gravarProductType && r.productType) {
      const n = await prisma.$executeRawUnsafe(
        `update "Produto" p
            set "productType"           = $1,
                "productTypeConfidence" = $2,
                "classificationSource"  = $3,
                "classificationVersion" = $4,
                "dataAtualizacao"       = now()
          where p.cnp = $5
            and p."validadoManualmente" = false
            and p."productType" is null`,
        r.productType,
        confianca,
        tier,
        KNOWLEDGE_VERSION,
        p.cnp,
      );
      if (Number(n) > 0) resumo.productTypesEscritos++;
    }

    // ── Campos clínicos (ke-2.0) ──────────────────────────────────
    //
    // Gate próprio, separado do gate de classificação: um produto pode
    // ter categoria gravada e clínica recusada, ou o contrário. É essa
    // separação que permite aproveitar "sei que é um antidiabético" sem
    // aceitar junto um ATC de que o modelo não tinha a certeza.
    //
    // Todas as escritas são `is null` — esta fase PREENCHE buracos, não
    // corrige valores. Se o INFARMED entrar amanhã, escreve primeiro e
    // isto deixa de tocar no campo. E todas carimbam
    // `classificationVersion = KNOWLEDGE_VERSION`, portanto
    //   update "Produto" set dci=null, "codigoATC"=null
    //    where "classificationVersion" = 'ke-2.0'
    // desfaz exactamente o que esta fase escreveu, e nada mais.
    const temClinica = r.dci || r.codigoATC || r.forma || r.dosagem || r.embalagem;
    if (temClinica && r.confidenceClinica < LIMIAR_CLINICO) {
      resumo.clinicaRecusadaPorConfianca++;
    }
    if (temClinica && r.confidenceClinica >= LIMIAR_CLINICO) {
      // Um par (campo, valor) de cada vez: um UPDATE só, com COALESCE,
      // gravaria os cinco ou nenhum, e perdia-se a contagem por campo
      // que a auditoria final precisa de reportar.
      const campos: Array<[string, string | null, () => void]> = [
        ["dci", r.dci, () => resumo.dciEscritas++],
        ["codigoATC", r.codigoATC, () => resumo.atcEscritos++],
        ["formaFarmaceutica", r.forma, () => resumo.formasEscritas++],
        ["dosagem", r.dosagem, () => resumo.dosagensEscritas++],
        ["embalagem", r.embalagem, () => resumo.embalagensEscritas++],
      ];
      for (const [coluna, valor, contar] of campos) {
        if (!valor) continue;
        const n = await prisma.$executeRawUnsafe(
          `update "Produto" p
              set "${coluna}"              = $1,
                  "classificationVersion"  = $2,
                  "dataAtualizacao"        = now()
            where p.cnp = $3
              and p."validadoManualmente" = false
              and p."${coluna}" is null`,
          valor,
          KNOWLEDGE_VERSION,
          p.cnp,
        );
        if (Number(n) > 0) contar();
      }
    }

    // Utilizações seguem a política do backfill de regras: MANUAL nunca
    // é tocada, automática só cede a confiança superior. É por isso que a
    // confiança propagada é estritamente menor: nunca desaloja uma
    // utilização que o modelo tenha visto de frente neste produto.
    for (const slug of utilizacoesFinais) {
      const uid = utilPorSlug.get(slug);
      if (!uid) continue;
      const n = await prisma.$executeRawUnsafe(
        `insert into "ProdutoUtilizacao" ("produtoId", "utilizacaoId", fonte, confianca)
         select p.id, $1, $2, $3 from "Produto" p
          where p.cnp = $4 and p."validadoManualmente" = false
         on conflict ("produtoId", "utilizacaoId") do update
            set fonte = excluded.fonte, confianca = excluded.confianca
          where "ProdutoUtilizacao".fonte <> 'MANUAL'
            and excluded.confianca > coalesce("ProdutoUtilizacao".confianca, 0)`,
        uid,
        fonte,
        confianca,
        p.cnp,
      );
      resumo.utilizacoesEscritas += Number(n) || 0;
    }
  };

  /**
   * Prepara a decisão de um dependente e regista-a no relatório.
   *
   * O dependente NÃO herda a decisão em bruto: o gate volta a correr
   * contra o estado DELE. Um irmão que entretanto ganhou classificação
   * específica não é sobreposto só porque o representante foi APPLY. E o
   * resultado é intersectado com o que o representante estava autorizado
   * a escrever — a propagação nunca alarga o âmbito, só o estreita.
   */
  const registarPropagado = (
    dep: LinhaResidual,
    r: KnowledgeResult,
    gateRep: DecisaoEscrita,
    utilizacoesFinais: string[],
  ): DecisaoEscrita => {
    const gateDep = avaliarGate(
      r,
      { categoria: dep.categoriaAtual, subcategoria: dep.subcategoriaAtual, productType: dep.productType },
      { concorda: true, aplicavel: false },
    );
    const efectivo: DecisaoEscrita = {
      ...gateDep,
      decisao: gateDep.decisao === "APPLY" ? "APPLY" : gateDep.decisao,
      gravarCategoria: gateRep.gravarCategoria && gateDep.gravarCategoria,
      gravarProductType: gateRep.gravarProductType && gateDep.gravarProductType,
      utilizacoes: gateDep.decisao === "APPLY" ? utilizacoesFinais : [],
      motivo: `propagado do representante ${r.cnp}`,
    };

    const m = metrica(dep.estrato);
    if (efectivo.decisao === "APPLY") {
      resumo.propagados++;
      m.propagados++;
    }
    resumo.relatorio.push({
      cnp: dep.cnp,
      designacao: dep.designacao,
      estrato: dep.estrato,
      alvo: efectivo.alvo,
      estadoAtual: dep.subcategoriaAtual
        ? `${dep.categoriaAtual} > ${dep.subcategoriaAtual}`
        : "NÃO CLASSIFICADO",
      proposta: efectivo.gravarCategoria && r.categoria ? `${r.categoria} > ${r.subcategoria}` : "(propagado)",
      utilizacoes: efectivo.utilizacoes,
      decisao: efectivo.decisao,
      anomalia: efectivo.anomalia,
      motivo: efectivo.motivo,
      criterios: efectivo.criterios,
      confidence: r.confidence * FATOR_CONFIANCA_PROPAGADA,
      evidenceType: r.evidenceType,
      verificado: false,
      discordancia: false,
      propagadoDe: r.cnp,
    });
    return efectivo;
  };

  const somaUsage = (u: RunnerResumo["usage"]) => {
    resumo.usage.inputTokens += u.inputTokens;
    resumo.usage.outputTokens += u.outputTokens;
    resumo.usage.cacheReadTokens += u.cacheReadTokens;
    resumo.usage.cacheWriteTokens += u.cacheWriteTokens;
    resumo.custoEstimadoUsd = estimarCusto(resumo.usage);
  };


  // Atingido o tecto, não sai mais nenhuma chamada — nem a verificação
  // de um lote já proposto. O custo é reavaliado a cada resposta, por
  // isso "imediatamente" quer dizer: na primeira fronteira depois de o
  // tecto ser ultrapassado, nunca um lote inteiro depois.
  const tectoAtingido = () => !!opts.tectoUsd && resumo.custoEstimadoUsd >= opts.tectoUsd;

  // ── Lotes homogéneos por estrato ────────────────────────────────────
  //
  // Duas razões, e as duas importam:
  //
  //  1. O prefixo cacheado difere entre o pedido de classificação e o de
  //     utilizações. Alternar entre eles no mesmo lote paga a escrita de
  //     cache de cada vez.
  //  2. Sem lotes homogéneos não há como atribuir tokens a um estrato: a
  //     resposta traz um `usage` por chamada, não por produto. Um lote
  //     misto só permitiria repartir por estimativa — e uma projecção de
  //     custo construída sobre uma estimativa não vale mais que um
  //     palpite.
  const porEstratoFila = new Map<Estrato, LinhaResidual[]>();
  for (const l of residual) {
    const fila = porEstratoFila.get(l.estrato) ?? [];
    fila.push(l);
    porEstratoFila.set(l.estrato, fila);
  }
  const lotes: LinhaResidual[][] = [];
  for (const fila of porEstratoFila.values()) {
    for (let i = 0; i < fila.length; i += TAMANHO_LOTE) lotes.push(fila.slice(i, i + TAMANHO_LOTE));
  }

  let processados = 0;

  /**
   * Trata um lote de ponta a ponta: propor, verificar, decidir, escrever.
   *
   * Extraído de um `for` sequencial para poder correr N em paralelo. O
   * corpo não mudou — o que mudou é quem o chama.
   */
  const processarLote = async (lote: LinhaResidual[]): Promise<void> => {
    const estratoLote = lote[0]!.estrato;
    const m = metrica(estratoLote);
    // O alvo é do produto, não do estrato — mas num lote homogéneo são a
    // mesma coisa, e é o do produto que o gate vai voltar a derivar.
    const alvo = alvoParaProduto({ subcategoria: lote[0]!.subcategoriaAtual });

    const somaLocal = (u: RunnerResumo["usage"]) => {
      somaUsage(u);
      m.usage.inputTokens += u.inputTokens;
      m.usage.outputTokens += u.outputTokens;
      m.usage.cacheReadTokens += u.cacheReadTokens;
      m.usage.cacheWriteTokens += u.cacheWriteTokens;
      m.custoUsd = estimarCusto(m.usage);
    };

    // ── Passagem 1: proposta ────────────────────────────────────────
    const p1 = alvo === "UTILIZACOES" ? await classificarUtil(lote) : await classificar(lote);
    resumo.chamadasProposta++;
    m.chamadasProposta++;
    somaLocal(p1.usage);
    resumo.propostasValidas += p1.resultados.length;

    // ── Passagem 2: verificação cega, só para o que a exige ─────────
    // Se o tecto caiu já com a proposta, esta chamada não chega a sair.
    // Sem verificação não há acordo, logo nada deste lote é escrito —
    // é o resultado certo: preferimos não escrever a escrever sem a
    // segunda passagem que o gate exige.
    const carecemVerificacao = p1.resultados.filter(precisaVerificacao);
    const verificacoes = new Map<number, KnowledgeResult>();
    if (carecemVerificacao.length > 0 && !tectoAtingido()) {
      const cnpsV = new Set(carecemVerificacao.map((r) => r.cnp));
      const paraVerificar = lote.filter((l) => cnpsV.has(l.cnp));
      const p2 = alvo === "UTILIZACOES"
        ? await verificarUtil(paraVerificar)
        : await verificar(paraVerificar);
      resumo.chamadasVerificacao++;
      m.chamadasVerificacao++;
      somaLocal(p2.usage);
      for (const v of p2.resultados) verificacoes.set(v.cnp, v);
    } else if (carecemVerificacao.length > 0) {
      resumo.cortadoPorTecto = true;
    }

    const porCnp = new Map(lote.map((p) => [p.cnp, p]));
    for (const r of p1.resultados) {
      const p = porCnp.get(r.cnp);
      if (!p) continue;

      resumo.porEvidencia[r.evidenceType] = (resumo.porEvidencia[r.evidenceType] ?? 0) + 1;

      const exigeVerificacao = precisaVerificacao(r);
      const comparacao = exigeVerificacao
        ? compararPassagens(r, verificacoes.get(r.cnp) ?? null)
        : { concorda: true, utilizacoesConfirmadas: r.utilizacoes, motivo: "não exige verificação" };
      if (exigeVerificacao) {
        resumo.verificacoesAplicaveis++;
        if (comparacao.concorda) resumo.verificacoesConcordantes++;
      }

      const gate = avaliarGate(
        r,
        { categoria: p.categoriaAtual, subcategoria: p.subcategoriaAtual, productType: p.productType },
        { concorda: comparacao.concorda, aplicavel: exigeVerificacao },
      );

      // Só se escrevem utilizações confirmadas pelas duas passagens.
      const utilizacoesFinais = gate.utilizacoes.filter((u) =>
        comparacao.utilizacoesConfirmadas.includes(u),
      );

      const chave = gate.decisao === "APPLY" ? "apply" : gate.decisao === "REVIEW" ? "review" : "skip";
      resumo[chave]++;
      m[chave]++;
      m.produtos++;
      if (gate.anomalia) {
        resumo.anomalias++;
        m.anomalias++;
      }

      const motivo = gate.decisao === "REVIEW" && exigeVerificacao && !comparacao.concorda
        ? comparacao.motivo
        : gate.motivo;

      resumo.relatorio.push({
        cnp: r.cnp,
        designacao: p.designacao,
        estrato: p.estrato,
        alvo: gate.alvo,
        estadoAtual: p.subcategoriaAtual
          ? `${p.categoriaAtual} > ${p.subcategoriaAtual}`
          : "NÃO CLASSIFICADO",
        proposta: gate.alvo === "UTILIZACOES"
          ? "(classificação não pedida)"
          : r.categoria ? `${r.categoria} > ${r.subcategoria}` : "(nenhuma)",
        utilizacoes: utilizacoesFinais,
        decisao: gate.decisao,
        anomalia: gate.anomalia,
        motivo,
        criterios: gate.criterios,
        confidence: r.confidence,
        evidenceType: r.evidenceType,
        verificado: exigeVerificacao,
        discordancia: exigeVerificacao && !comparacao.concorda,
      });

      // ── FRONTEIRA DO DRY-RUN ────────────────────────────────────────
      // Acima desta linha só se lê e se acumula relatório. Abaixo está
      // TODA a escrita desta fase: Produto, ProdutoUtilizacao e a própria
      // cache. Nada de escrita pode subir daqui — é o que
      // `test-knowledge-enrichment` verifica, com um prisma que rebenta
      // se lhe pedirem uma escrita durante um dry-run.
      if (dryRun) {
        // A propagação também tem de aparecer no dry-run, senão o
        // relatório mostrava uma amostra que não corresponde ao que o
        // `--apply` faria.
        if (gate.decisao === "APPLY") {
          for (const dep of dependentes.get(r.cnp) ?? []) {
            registarPropagado(dep, r, gate, utilizacoesFinais);
          }
        }
        continue;
      }

      await escrever(r, p, gate, utilizacoesFinais, r.confidence, FONTE, "MODEL_INFERRED");
      juntarCandidato(r, p, gate, utilizacoesFinais, r.confidence, "MODELO");
      await gravarCache(prisma, r, p, gate.decisao === "APPLY", motivo, "CLAUDE", null);

      // ── PROPAGAÇÃO ────────────────────────────────────────────────
      // Só depois de o representante ter passado o gate. Os dependentes
      // não têm decisão própria: herdam a dele, com menos confiança e
      // com proveniência distinta, e passam pelas MESMAS guardas SQL —
      // validadoManualmente, não-degradação, productType só se faltar.
      if (gate.decisao === "APPLY") {
        const confiancaProp = r.confidence * FATOR_CONFIANCA_PROPAGADA;
        for (const dep of dependentes.get(r.cnp) ?? []) {
          const gateDep = registarPropagado(dep, r, gate, utilizacoesFinais);
          await escrever(
            { ...r, ...semApresentacao(r), cnp: dep.cnp },
            dep,
            gateDep,
            utilizacoesFinais,
            confiancaProp,
            FONTE_PROPAGADA,
            "MODEL_PROPAGATED",
          );
          await gravarCache(
            prisma,
            { ...r, ...semApresentacao(r), cnp: dep.cnp, confidence: confiancaProp },
            dep,
            true,
            `propagado do representante ${r.cnp}`,
            "PROPAGADO",
            r.cnp,
          );
        }
      }
    }

    processados += lote.length;
    opts.onProgress?.(processados, residual.length);
  };

  // ── Pool de N lotes em paralelo ─────────────────────────────────────
  //
  // Era estritamente sequencial: um lote de 25 de cada vez, duas chamadas
  // por lote, uma após a outra. Numa corrida de 20 000 produtos isso dá
  // dezasseis horas em que a rede está parada à espera quase todo o tempo.
  //
  // O que torna isto seguro, e foi verificado antes de mudar:
  //
  //  · ORDEM. Os dependentes de uma família são tratados DENTRO da
  //    iteração do próprio representante e nunca entram em `lotes`. Não
  //    há um lote que precise de outro ter corrido primeiro.
  //  · ESTADO. Os contadores são `++` entre `await`s e o JS é
  //    single-threaded: não há leitura-modificação-escrita a competir.
  //  · QUALIDADE. Cada lote é um pedido independente com o seu próprio
  //    contexto. Correr quatro ao mesmo tempo não muda nenhuma resposta.
  //
  // O que muda de facto, e é aceite:
  //
  //  · O TECTO pode ser ultrapassado por até N-1 lotes — os que já
  //    estavam em voo quando o limite foi cruzado. Com lotes de 25 e N=4
  //    isso são cêntimos, e a alternativa (um semáforo antes de cada
  //    chamada) trocaria essa margem por serialização.
  //  · A CACHE DE PROMPT é falhada pelos primeiros N pedidos em vez de
  //    por um só, porque arrancam antes de o primeiro a escrever. É
  //    desperdício de arranque, uma vez por corrida.
  const nTrabalhadores = Math.max(1, Math.min(opts.concorrencia ?? CONCORRENCIA_OMISSAO, lotes.length));
  let proximo = 0;
  const trabalhador = async (): Promise<void> => {
    for (;;) {
      // Verificado por trabalhador e não no despacho: um lote que demore
      // não impede os outros de pararem assim que o tecto cai.
      if (tectoAtingido()) {
        resumo.cortadoPorTecto = true;
        return;
      }
      const i = proximo++;
      if (i >= lotes.length) return;
      await processarLote(lotes[i]!);
    }
  };
  await Promise.all(Array.from({ length: nTrabalhadores }, () => trabalhador()));

  resumo.custoEstimadoUsd = estimarCusto(resumo.usage);

  // ── PROMOÇÃO AO CATÁLOGO GLOBAL ─────────────────────────────────────
  //
  // Só o que passou o gate e ficou com classificação ESPECÍFICA. Um
  // fallback não é conhecimento e não se promove — `avaliarPromocao`
  // recusa-o de qualquer forma, mas nem se envia.
  //
  // Corre no fim e não a cada produto: uma escrita por corrida em vez de
  // uma por produto, e o control plane estar em baixo não pode perder o
  // trabalho que já foi pago e escrito no tenant.
  if (opts.usarGlobal !== false && opts.tenantSlug && candidatosGlobais.length > 0) {
    try {
      // O runner nunca produz candidatos de origem HUMANO — só MODELO e
      // PROPAGADO — portanto não passa aprovação nenhuma. A validação
      // manual de um tenant sobe pelo caminho explícito, não por aqui.
      const res = await promoverAoGlobal(candidatosGlobais, {
        dryRun,
        actor: "catalog:knowledge-enrich",
      });
      resumo.promovidosAoGlobal = res.produtosPromovidos;
    } catch (err) {
      resumo.avisos.push(
        `promoção ao catálogo global falhou — o trabalho no tenant está feito: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else if (opts.usarGlobal !== false && !opts.tenantSlug && candidatosGlobais.length > 0) {
    resumo.avisos.push(
      `${candidatosGlobais.length} candidatos não promovidos: falta \`tenantSlug\` para registar a origem`,
    );
  }

  // Projecção por estrato, com o custo OBSERVADO de cada um. Uma média
  // global multiplicada pela população total dava um número redondo e
  // errado: o estrato de utilizações custa por produto uma fracção do de
  // classificação, e são de tamanhos muito diferentes na base.
  for (const m of metricas.values()) {
    m.custoPorProduto = m.produtos > 0 ? m.custoUsd / m.produtos : 0;
    m.projecaoUsd = m.elegiveis !== null && m.produtos > 0 ? m.custoPorProduto * m.elegiveis : null;
  }
  resumo.metricasPorEstrato = [...metricas.values()];
  return resumo;
}

/**
 * Guarda o resultado — escrito ou não. O `upsert` torna a corrida
 * re-executável a meio sem duplicar linhas, e guardar os REVIEW é o que
 * impede o job de voltar a perguntar todos os dias por produtos que já
 * se sabe que não passam o gate.
 */
async function gravarCache(
  prisma: PrismaClient,
  r: KnowledgeResult,
  p: ProdutoResidual,
  persistido: boolean,
  motivo: string,
  origem: "CLAUDE" | "PROPAGADO",
  propagadoDeCnp: number | null,
): Promise<void> {
  const chave = chaveCache(r.cnp, p.designacao);
  await prisma.knowledgeEnrichmentCache.upsert({
    where: { chave },
    create: {
      chave,
      cnp: r.cnp,
      designacao: p.designacao,
      versao: KNOWLEDGE_VERSION,
      modelo: KNOWLEDGE_MODEL,
      productType: r.productType,
      categoria: r.categoria,
      subcategoria: r.subcategoria,
      // Guardado como evidência de que o modelo entendeu o produto.
      // NUNCA escrito em Produto.formaFarmaceutica — ver CAMPOS_PROIBIDOS.
      forma: r.forma,
      // ke-2.0: guardados sempre, persistidos ou não. É o que impede a
      // segunda passagem de voltar a pagar a chamada por um produto cujo
      // ATC já se sabe que veio abaixo do limiar.
      dci: r.dci,
      codigoATC: r.codigoATC,
      dosagem: r.dosagem,
      embalagem: r.embalagem,
      confidenceClinica: r.confidenceClinica,
      utilizacoes: r.utilizacoes,
      confidence: r.confidence,
      evidenceType: r.evidenceType,
      rationale: r.rationale,
      persistido,
      motivo: persistido ? null : motivo,
      // Proveniência: distingue uma decisão do modelo sobre ESTE produto
      // de um valor herdado de um irmão. Sem isto, uma auditoria futura
      // não conseguiria separar as duas coisas.
      origem,
      propagadoDeCnp,
    },
    update: { persistido, motivo: persistido ? null : motivo, origem, propagadoDeCnp },
  });
}
