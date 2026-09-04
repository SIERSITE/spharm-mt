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
  TAMANHO_LOTE_FORMA,
  alvoParaProduto,
  avaliarGate,
  chaveCache,
  classificarLote,
  classificarUtilizacoesLote,
  compararPassagens,
  precisaVerificacao,
  classificarFormaLote,
  verificarLote,
  verificarUtilizacoesLote,
  type AlvoPedido,
  type Criterios,
  type DecisaoEscrita,
  type Decisao,
  type KnowledgeResult,
  type ProdutoResidual,
  FalhaInfraestrutura,
  classificarFalhaInfra,
  credencialConfigurada,
  VERSAO_PROVISORIA,
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
  type Familia,
  type Preselecao,
  type ProdutoPreselecao,
} from "./preselection";
import { escreverClassificacao } from "./escrita-classificacao";
import {
  enfileirarRevisaoClassificacao,
  propostaAccionavel,
} from "./fila-revisao-classificacao";
import { lerConhecimentoGlobal, promoverAoGlobal } from "./global-catalog-store";
import { globalResolveResidual, validarValorClinico } from "./global-catalog";
import type {
  CampoClinico,
  ClinicaCandidata,
  ConhecimentoCandidato,
  OrigemGlobal,
} from "./global-catalog";

/**
 * Códigos internos da farmácia não entram no catálogo regulamentar.
 *
 * RE-EXPORTAÇÃO, não uma segunda definição. Havia aqui uma constante
 * própria com o mesmo valor e o operador trocado — este ficheiro filtrava
 * `cnp >= MIN_CNP` e `lib/catalog-enrichment.ts` filtrava
 * `cnp > MIN_CATALOGUABLE_CNP`. O produto de CNP exactamente 2 000 000
 * era elegível para enriquecimento por um caminho e não-cataloguável pelo
 * outro; a divergência nunca deu erro — deu duas contagens diferentes da
 * mesma população, que é pior, porque não se anuncia.
 *
 * A regra única está em `cnp-catalogavel.ts`, com a justificação de qual
 * das duas fronteiras é a certa (a documentada: 2 000 000 é INTERNO). O
 * nome fica por compatibilidade com quem já o importa.
 */
export { MIN_CNP_CATALOGAVEL as MIN_CNP } from "./cnp-catalogavel";
import { MIN_CNP_CATALOGAVEL as MIN_CNP } from "./cnp-catalogavel";

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

/**
 * Quantas vezes uma entrada de fila em FALHOU volta a ser tentada.
 *
 * FALHOU é falha TÉCNICA — API em baixo, timeout, lote perdido por saída
 * malformada. Repetir faz sentido; repetir para sempre não. Sem tecto,
 * um produto que falha de forma determinística (uma designação que parte
 * sempre o mesmo caminho) gera chamadas de 15 em 15 minutos até alguém
 * reparar na factura.
 */
export const MAX_TENTATIVAS_FILA = 5;

/**
 * Backoff entre tentativas: 1h, 4h, 16h, 64h, 256h.
 *
 * Exponencial de base 4 e não 2: uma indisponibilidade de API que dure
 * horas não deve ser martelada de hora a hora, e o custo de esperar mais
 * é irrelevante — o produto já está classificado a zero ou vai ficar em
 * REVISAO_NECESSARIA de qualquer maneira.
 */
export const BACKOFF_BASE_HORAS = 1;

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
export function corpoResidual(estrato?: Estrato, apenasFila = false, comCursor = false): string {
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
     where p.cnp > $1
       ${comCursor ? "and p.cnp > $5" : ""}
       and p."validadoManualmente" = false
       ${filtro}
       and not exists (
             select 1 from "KnowledgeEnrichmentCache" k
              where k.cnp = p.cnp and k.versao = $2 and k.modelo = $3
       )
       ${apenasFila ? `and exists (
             select 1 from "EnriquecimentoFila" f
              where f."produtoId" = p.id
                and (
                      f.estado = 'PENDENTE'
                      -- FALHOU volta, mas com tecto e com espera. Sem as
                      -- duas condições, um produto que falha sempre gera
                      -- chamadas de 15 em 15 minutos para sempre.
                      or (
                           f.estado = 'FALHOU'
                       and f."numeroTentativas" < ${MAX_TENTATIVAS_FILA}
                       and (
                             f."ultimaTentativa" is null
                          or f."ultimaTentativa" < now() - (
                               interval '${BACKOFF_BASE_HORAS} hour'
                               * power(4, f."numeroTentativas")
                             )
                           )
                         )
                    )
       )` : ""}`;
}

/**
 * Uma página do residual, em ordem determinística e sem repetir.
 *
 * `comCursor` acrescenta `p.cnp > $5`: é o que torna a leitura paginável.
 * A ordem é sempre `p.cnp` e o cursor é sempre o último cnp devolvido,
 * portanto duas páginas consecutivas não podem sobrepor-se nem saltar —
 * a fronteira é o próprio valor da chave por que se ordena.
 */
function sqlResidual(estrato?: Estrato, apenasFila = false, comCursor = false): string {
  return `
    select p.cnp,
           p.designacao,
           p."productType",
           c1.nome as "categoriaAtual",
           c2.nome as "subcategoriaAtual",
           p."formaFarmaceutica" as "formaAtual",
           case
             when p."classificacaoNivel2Id" is null then 'NAO_CLASSIFICADO'
             when c2.nome ilike 'Outros %'          then 'OUTROS_MEDICAMENTOS'
             else 'SEM_UTILIZACOES'
           end as estrato
    ${corpoResidual(estrato, apenasFila, comCursor)}
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
function sqlContagem(estrato?: Estrato, apenasFila = false): string {
  return `select count(*)::int as n ${corpoResidual(estrato, apenasFila)}`;
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
  /** Adiados pela pré-selecção que o canary mandou ao modelo à mesma. */
  forcados: number;
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
  /**
   * O canary atravessou esta exclusão e mandou o produto ao modelo.
   * A linha continua aqui, com o motivo original, porque o que a
   * pré-selecção PENSAVA continua a ser informação — e é a única forma
   * de o relatório distinguir «foi excluído» de «teria sido excluído».
   */
  forcado?: boolean;
};

export type RunnerResumo = {
  /**
   * Linhas do residual que esta corrida assumiu — a janela depois do
   * corte. Não é o mesmo que `residualLido`.
   */
  residualAnalisado: number;
  /**
   * CNPs que a paginação leu da base para encher a janela, incluindo os
   * que ficaram de fora. É sobre ESTE número que a reconciliação fecha:
   * tudo o que foi lido tem de ter destino nomeado, mesmo que o destino
   * seja "ainda não chegou a vez".
   */
  residualLido: number;
  /**
   * Lidos para lá do corte da janela, devolvidos intactos. Nada foi
   * decidido sobre eles e voltam na corrida seguinte — é o
   * comportamento certo, e tem de ser contado.
   */
  foraDaJanela: number;
  /**
   * Estavam no residual e não têm linha no contexto do tenant.
   *
   * Era um `if (!pre) continue` mudo: o produto desaparecia da
   * contabilidade e da corrida sem deixar rasto. Hoje é teoricamente
   * inalcançável — o contexto é superconjunto do residual — mas nenhum
   * produto do residual pode sumir-se por um `continue` sem nome.
   */
  semContexto: number;
  /** Os CNPs de `semContexto`, para o relatório os poder mostrar. */
  cnpsSemContexto: number[];
  /** Como é que a janela foi enchida. */
  janela: {
    /** Quantos destinos processáveis foram pedidos (`--limite`). */
    alvoProcessaveis: number;
    paginasLidas: number;
    tamanhoPagina: number;
    /** O residual acabou antes de a janela encher. */
    esgotado: boolean;
  };
  /**
   * Dependentes que herdaram uma decisão que NÃO escreve — o
   * representante foi recusado, ou o gate próprio do dependente recusou.
   * Subconjunto de `propagados`; existe para a poupança da propagação
   * não parecer maior do que é.
   */
  propagadosSemEscrita: number;
  /** CNPs que o catálogo global já conhecia — não foram ao modelo. */
  /**
   * CNPs que o global conhecia e cujo conhecimento RESOLVIA o que
   * faltava — esses não vão ao modelo e são projectados.
   */
  jaConhecidosGlobal: number;
  /**
   * CNPs que o global conhecia e cujo conhecimento NÃO resolvia o que
   * faltava: vão ao modelo na mesma.
   *
   * Existe porque estes eram, antes, indistinguíveis dos de cima — e
   * eram 7 690 dos 7 692 saltados na medição que motivou a correcção.
   */
  globalInsuficiente: number;
  /**
   * Dependentes cujo representante nunca chegou a ter decisão — lote
   * perdido, ou tecto atingido antes de ele ser enviado. Nada foi
   * decidido sobre eles, voltam ao residual, e contam-se para a
   * reconciliação fechar em vez de desaparecerem da soma.
   */
  dependentesOrfaos: number;
  /** Candidatos promovidos ao catálogo global nesta corrida. */
  promovidosAoGlobal: number;
  /** Problemas não fatais (ex.: control plane inacessível). */
  avisos: string[];
  /**
   * A corrida parou por causa da INFRAESTRUTURA, não do catálogo.
   *
   * Enquanto isto estiver preenchido, a fila não é tocada: nem estados,
   * nem `numeroTentativas`. Uma noite sem saldo não pode consumir as
   * cinco tentativas de milhares de produtos que nunca chegaram a ser
   * perguntados.
   */
  falhaInfraestrutura: { categoria: string; mensagem: string } | null;
  /** Não foram ao modelo: subcategoria sem utilização plausível. */
  excluidosBaixaCobertura: number;
  /** Não foram ao modelo: designação sem conteúdo reconhecível. */
  excluidosOpacos: number;
  /** Famílias com um representante e pelo menos um dependente. */
  familiasPropagaveis: number;
  representantesEnviados: number;
  /** Produtos efectivamente enviados ao modelo. */
  enviadosAoModelo: number;
  /**
   * Dos enviados, quantos só lá chegaram porque o canary atravessou uma
   * exclusão por poupança. Zero em qualquer corrida normal.
   *
   * NÃO entra na reconciliação: estes produtos já estão contados em
   * `enviadosAoModelo`. É um recorte, não um destino.
   */
  forcadosNoCanary: number;
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
  /**
   * Subconjunto de `categoriasEscritas`: as que foram escritas por
   * deducao e ficaram marcadas PROVISORIA.
   *
   * Separado e nao somado: uma corrida que so' produza provisorias e uma
   * que so' produza canonicas nao valem o mesmo, e um numero unico
   * apagava a diferenca exactamente onde ela interessa.
   */
  categoriasProvisorias: number;
  /** Entradas criadas em `FilaRevisao` — REVIEW com proposta accionavel. */
  revisoesCriadas: number;
  /**
   * REVIEW que NAO gerou entrada humana por nao haver nada que uma pessoa
   * possa decidir (DESCONHECIDO, par invalido). Contado para que a fila
   * pequena nao se confunda com a fila esquecida.
   */
  revisoesSemProposta: number;
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
export const USD_POR_MTOK = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };

export function estimarCusto(u: RunnerResumo["usage"]): number {
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

/**
 * O que cada estrato deu, e o que ficou por dar.
 *
 * QUATRO NÚMEROS E NÃO UM. A versão antiga tinha `elegiveis` a significar
 * duas coisas ao mesmo tempo — quantos existem e quantos servem — e o
 * relatório da corrida real da Silveira mostrava «TOTAL 1200» ao lado de
 * `obtido=0`, o que se lê como «havia 1200 e mandámos 0 por opção». Não
 * era isso: havia 1200 no residual, nenhum sobrevivia à pré-selecção, e
 * o canary não mediu nada. Cada uma destas perguntas tem agora a sua
 * coluna.
 */
export type QuotaEstrato = {
  estrato: Estrato;
  /** Quota pedida. */
  pedido: number;
  /** UNIVERSO: quantos existem no estrato, sem limite nem pré-selecção. */
  universo: number;
  /** ELEGÍVEIS: dos lidos, quantos iriam ao modelo SEM forçar nada. */
  elegiveis: number;
  /** SELECCIONADOS: linhas que entraram na janela (inclui dependentes). */
  seleccionados: number;
  /** ENVIADOS: os que vão MESMO ao modelo nesta corrida. */
  enviados: number;
  /** Dos enviados, quantos só entraram porque o canary forçou. */
  forcados: number;
  /** `pedido - enviados`. Zero quando a quota foi servida por inteiro. */
  defice: number;
};


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
      where p.cnp > $1
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

// ═════════════════════════════════════════════════════════════════════
// A JANELA: N PRODUTOS PROCESSÁVEIS, NÃO N LINHAS LIDAS
// ═════════════════════════════════════════════════════════════════════
//
// ── O DEFEITO, MEDIDO ────────────────────────────────────────────────
//
// A leitura era `order by cnp limit N` e a pré-selecção corria depois.
// Os produtos que a pré-selecção exclui por CONDIÇÃO — subcategoria sem
// utilização plausível, designação opaca — não recebem cache e por isso
// não saem do residual. Voltam a ser dos N mais baixos na corrida
// seguinte, e na seguinte, para sempre.
//
// O canary de 2026-08-21 no silveira mediu a progressão:
//
//   corrida das 14:34    3 de 25 eram peso morto   (12%)
//   corrida das 14:50   10 de 25                   (40%)
//   corrida seguinte    12 de 25                   (48%)
//
// E o residual completo tinha 2 184 destes em 18 454 (11,8%). Como se
// acumulam à cabeça e nunca saem, a janela acaba inteiramente ocupada
// por produtos que não vão a lado nenhum: o lote deixa de fazer trabalho
// e ~16 000 processáveis ficam parados acima da fronteira. Não é
// lentidão — é paragem.
//
// ── A REGRA ──────────────────────────────────────────────────────────
//
// `--limite=N` passa a significar N produtos DESTINADOS ao modelo. A
// leitura pagina por cursor e continua enquanto não tiver N destinos
// processáveis ou enquanto houver páginas. Os condicionais são
// atravessados: contam-se, aparecem no relatório, e não ocupam lugar.
//
// Não é um factor fixo (`limit N * 10`). Um factor fixo volta a falhar
// assim que a concentração de condicionais passar o que o factor previa
// — que é exactamente o modo de falha que isto substitui.
//
// ── PORQUE É QUE A PRÉ-SELECÇÃO CORRE SOBRE O ACUMULADO ─────────────
//
// As famílias são procuradas entre irmãos que estejam no residual E no
// mesmo estrato. Se cada página fosse pré-seleccionada isoladamente, um
// irmão da página 2 não seria reconhecido como irmão de um da página 1:
// em vez de um representante e um dependente, dois envios pagos. Por
// isso o `preselecionar` corre sempre sobre tudo o que já foi acumulado.

/** Quantos CNPs se lêem de cada vez ao encher a janela. */
export const TAMANHO_PAGINA_RESIDUAL = 250;

export type JanelaResidual = {
  /** As linhas que esta corrida vai tratar, em ordem de cnp. */
  linhas: LinhaResidual[];
  /** Destinos, calculados sobre o acumulado e estáveis daqui para a frente. */
  preselecao: Map<number, Preselecao>;
  /** CNPs lidos da base, incluindo os que ficaram fora da janela. */
  cnpsLidos: number;
  paginasLidas: number;
  /** Resolvidos pelo catálogo global — não chegam a entrar na janela. */
  jaConhecidosGlobal: number;
  /** Conhecidos pelo global mas sem resolver o que faltava. */
  globalInsuficiente: number;
  /**
   * Lidos, para lá do corte, e devolvidos intactos ao residual. Não é
   * uma exclusão: é "ainda não chegou a vez". Existe para a
   * reconciliação poder fechar sobre `cnpsLidos`.
   */
  foraDaJanela: number;
  /**
   * Lidos e sem linha no contexto do tenant — `preselecionar` não lhes
   * soube atribuir destino. Não entram em `linhas`: seguir com eles
   * seria arrastar produtos sobre os quais nada se pode decidir. Saem
   * daqui contados e nomeados, nunca por um `continue` mudo.
   */
  semContexto: number;
  cnpsSemContexto: number[];
  /** O residual acabou antes de a janela encher. */
  esgotado: boolean;
};

/** ENVIAR e REPRESENTANTE são os dois destinos que custam uma chamada. */
function ehProcessavel(d: Destino | undefined): boolean {
  return d === "ENVIAR" || d === "REPRESENTANTE";
}

/**
 * Os destinos que a pré-selecção recusa POR POUPANÇA, e que o canary
 * pode atravessar.
 *
 * `PROPAGAR` NÃO está aqui, e a omissão é deliberada: um dependente não
 * custa chamada nenhuma porque herda a decisão do representante, que já
 * está na janela. Forçá-lo seria pagar duas vezes a mesma resposta — o
 * contrário do que o canary quer medir.
 */
function ehAdiadoPorPoupanca(d: Destino | undefined): boolean {
  return d === "EXCLUIR_OPACO" || d === "EXCLUIR_BAIXA_COBERTURA";
}

/**
 * Vai ao modelo?
 *
 * Com `forcar`, os adiados por poupança contam — é o que faz um canary
 * medir mesmo o estrato, em vez de devolver zero chamadas e a aparência
 * de eficiência. A corrida normal chama isto sem `forcar` e não muda de
 * comportamento em nada.
 */
function vaiAoModelo(d: Destino | undefined, forcar = false): boolean {
  return ehProcessavel(d) || (forcar && ehAdiadoPorPoupanca(d));
}

/**
 * Lê o residual até ter `alvoProcessaveis` destinos que vão ao modelo.
 *
 * O corte é feito no acumulado e não na leitura: guardam-se as linhas até
 * ao N-ésimo processável e, depois dele, só os DEPENDENTES de
 * representantes que ficaram dentro. Um dependente não custa chamada
 * nenhuma — deixá-lo de fora obrigaria a família a ser paga outra vez.
 */
export async function lerJanelaProcessavel(
  prisma: PrismaClient,
  opts: {
    alvoProcessaveis: number;
    estrato?: Estrato;
    apenasFila?: boolean;
    contexto: readonly ProdutoPreselecao[];
    familias: Map<string, Familia>;
    subExcluidas: ReadonlySet<string>;
    /**
     * Conta (e deixa entrar) os adiados por poupança. SÓ o canary passa
     * isto: a corrida normal continua a parar neles, que é a razão de
     * eles existirem.
     */
    forcarExcluidos?: boolean;
    /** Aplica o catálogo global a uma página. Omitido = sem filtro. */
    resolverGlobal?: (
      linhas: LinhaResidual[],
    ) => Promise<{ restantes: LinhaResidual[]; resolvidos: number; insuficientes: number }>;
    tamanhoPagina?: number;
  },
): Promise<JanelaResidual> {
  const tamanhoPagina = Math.max(1, opts.tamanhoPagina ?? TAMANHO_PAGINA_RESIDUAL);
  const acumulado: LinhaResidual[] = [];
  // Duas páginas não se podem sobrepor pela construção do cursor, mas a
  // garantia fica aqui e não na confiança de que assim seja: um cnp
  // repetido custaria uma classificação paga duas vezes.
  const vistos = new Set<number>();
  // Arranca NO limite e não abaixo dele: a fronteira passou a ser
  // exclusiva (`cnp > $1`), portanto a primeira página já não pode
  // conter o próprio valor. O `-1` funcionava por o filtro de base
  // dominar, mas escrevia uma fronteira que não é a que vigora.
  let cursor = MIN_CNP;
  let cnpsLidos = 0;
  let paginasLidas = 0;
  let jaConhecidosGlobal = 0;
  let globalInsuficiente = 0;
  let esgotado = false;
  let preselecao = new Map<number, Preselecao>();
  let processaveis = 0;

  while (processaveis < opts.alvoProcessaveis) {
    const pagina = await prisma.$queryRawUnsafe<LinhaResidual[]>(
      sqlResidual(opts.estrato, opts.apenasFila === true, true),
      MIN_CNP,
      KNOWLEDGE_VERSION,
      KNOWLEDGE_MODEL,
      tamanhoPagina,
      cursor,
    );
    paginasLidas++;
    if (pagina.length === 0) {
      esgotado = true;
      break;
    }

    const novas: LinhaResidual[] = [];
    for (const l of pagina) {
      const cnp = Number(l.cnp);
      cursor = Math.max(cursor, cnp);
      if (vistos.has(cnp)) continue;
      vistos.add(cnp);
      cnpsLidos++;
      // No modo estratificado o estrato é o da consulta que trouxe a
      // linha: se um dia o `case` e o filtro divergirem, é o filtro que
      // manda, senão a quota mentiria sobre si própria.
      novas.push(opts.estrato ? { ...l, cnp, estrato: opts.estrato } : { ...l, cnp });
    }

    if (opts.resolverGlobal && novas.length > 0) {
      const g = await opts.resolverGlobal(novas);
      jaConhecidosGlobal += g.resolvidos;
      globalInsuficiente += g.insuficientes;
      acumulado.push(...g.restantes);
    } else {
      acumulado.push(...novas);
    }

    preselecao = preselecionar(acumulado, opts.contexto, {
      familias: opts.familias,
      subcategoriasExcluidas: opts.subExcluidas,
    });
    processaveis = acumulado.reduce(
      (n, l) => n + (vaiAoModelo(preselecao.get(l.cnp)?.destino, opts.forcarExcluidos) ? 1 : 0),
      0,
    );

    if (pagina.length < tamanhoPagina) {
      esgotado = true;
      break;
    }
  }

  // ── O CORTE ────────────────────────────────────────────────────────
  const linhas: LinhaResidual[] = [];
  const dentro = new Set<number>();
  const cnpsSemContexto: number[] = [];
  let contados = 0;
  let corte = acumulado.length;
  for (let i = 0; i < acumulado.length; i++) {
    const pre = preselecao.get(acumulado[i].cnp);
    if (!pre) {
      // Sem destino possível: fica contado e fora da janela, em vez de
      // ser arrastado para uma corrida que nada lhe pode fazer.
      cnpsSemContexto.push(acumulado[i].cnp);
      continue;
    }
    if (vaiAoModelo(pre.destino, opts.forcarExcluidos) && contados >= opts.alvoProcessaveis) {
      corte = i;
      break;
    }
    if (vaiAoModelo(pre.destino, opts.forcarExcluidos)) contados++;
    linhas.push(acumulado[i]);
    dentro.add(acumulado[i].cnp);
  }
  // Depois do corte só entram DEPENDENTES de representantes que ficaram
  // dentro: não custam chamada, e deixá-los de fora obrigaria a família
  // a ser paga outra vez na corrida seguinte.
  for (let i = corte; i < acumulado.length; i++) {
    const pre = preselecao.get(acumulado[i].cnp);
    if (!pre) {
      cnpsSemContexto.push(acumulado[i].cnp);
      continue;
    }
    if (pre.destino === "PROPAGAR" && pre.representanteCnp !== null && dentro.has(pre.representanteCnp)) {
      linhas.push(acumulado[i]);
      dentro.add(acumulado[i].cnp);
    }
  }
  linhas.sort((a, b) => a.cnp - b.cnp);

  return {
    linhas,
    preselecao,
    cnpsLidos,
    paginasLidas,
    jaConhecidosGlobal,
    globalInsuficiente,
    semContexto: cnpsSemContexto.length,
    cnpsSemContexto,
    foraDaJanela: cnpsLidos - jaConhecidosGlobal - linhas.length - cnpsSemContexto.length,
    esgotado,
  };
}

/**
 * A janela do canary: uma quota de PROCESSÁVEIS por estrato.
 *
 * Substituiu o `selecionarCanary`, que lia `limit quota` por estrato e
 * sofria do mesmo entupimento do caminho normal — uma quota de 30 gasta
 * em 30 produtos que a pré-selecção ia excluir dá um canary de zero
 * chamadas e a aparência de "poupança".
 *
 * A pré-selecção restringida a um estrato dá exactamente o mesmo que a
 * global restringida a esse estrato: as famílias só procuram irmãos no
 * MESMO estrato, e cobertura e opacidade são propriedades do produto.
 * Por isso juntar os mapas dos três é legítimo, e não uma aproximação.
 */
export async function lerJanelaCanary(
  prisma: PrismaClient,
  quotas: Partial<Record<Estrato, number>>,
  base: {
    apenasFila?: boolean;
    contexto: readonly ProdutoPreselecao[];
    familias: Map<string, Familia>;
    subExcluidas: ReadonlySet<string>;
    /**
     * Atravessa as exclusões por poupança. É o que torna o canary um
     * canary: sem isto, um estrato inteiramente opaco ou de baixa
     * cobertura devolve zero chamadas e a corrida não mede nada — foi
     * exactamente o que aconteceu na Silveira, com 1 193 produtos no
     * estrato e nenhum enviado.
     */
    forcarExcluidos?: boolean;
    resolverGlobal?: (
      linhas: LinhaResidual[],
    ) => Promise<{ restantes: LinhaResidual[]; resolvidos: number; insuficientes: number }>;
    tamanhoPagina?: number;
  },
): Promise<JanelaResidual & { quotas: QuotaEstrato[] }> {
  const linhas: LinhaResidual[] = [];
  const preselecao = new Map<number, Preselecao>();
  const relatorio: QuotaEstrato[] = [];
  let cnpsLidos = 0;
  let paginasLidas = 0;
  let jaConhecidosGlobal = 0;
  let globalInsuficiente = 0;
  let foraDaJanela = 0;
  let esgotado = false;
  const cnpsSemContexto: number[] = [];

  for (const [estrato, pedido] of Object.entries(quotas) as [Estrato, number][]) {
    if (!pedido) continue;
    // A contagem SEM limite é o que distingue "este estrato está vazio"
    // de "a consulta partiu-se": sem ela, as duas hipóteses produzem o
    // mesmo output — zero linhas — e a amostra encolhe em silêncio.
    const [{ n: universo }] = await prisma.$queryRawUnsafe<{ n: number }[]>(
      sqlContagem(estrato, base.apenasFila === true),
      MIN_CNP,
      KNOWLEDGE_VERSION,
      KNOWLEDGE_MODEL,
    );
    const j = await lerJanelaProcessavel(prisma, { ...base, alvoProcessaveis: pedido, estrato });

    linhas.push(...j.linhas);
    for (const [k, v] of j.preselecao) preselecao.set(k, v);
    cnpsLidos += j.cnpsLidos;
    paginasLidas += j.paginasLidas;
    jaConhecidosGlobal += j.jaConhecidosGlobal;
    globalInsuficiente += j.globalInsuficiente;
    foraDaJanela += j.foraDaJanela;
    cnpsSemContexto.push(...j.cnpsSemContexto);
    esgotado = esgotado || j.esgotado;

    // Quatro contagens sobre a MESMA janela, e cada uma responde a uma
    // pergunta diferente. `enviados` é a que serve a quota.
    const destinoDe = (l: LinhaResidual) => j.preselecao.get(l.cnp)?.destino;
    const elegiveis = j.linhas.filter((l) => ehProcessavel(destinoDe(l))).length;
    const enviados = j.linhas.filter((l) => vaiAoModelo(destinoDe(l), base.forcarExcluidos)).length;
    const forcados = enviados - elegiveis;
    relatorio.push({
      estrato,
      pedido,
      universo: Number(universo) || 0,
      elegiveis,
      seleccionados: j.linhas.length,
      enviados,
      forcados,
      defice: Math.max(0, pedido - enviados),
    });
  }

  // Os cnp são distintos por estrato — os filtros particionam o residual
  // — mas a ordenação global é o que o resto do runner assume.
  linhas.sort((a, b) => a.cnp - b.cnp);
  return {
    linhas,
    preselecao,
    quotas: relatorio,
    cnpsLidos,
    paginasLidas,
    jaConhecidosGlobal,
    globalInsuficiente,
    foraDaJanela,
    semContexto: cnpsSemContexto.length,
    cnpsSemContexto,
    esgotado,
  };
}

export async function runKnowledgeEnrichment(
  prisma: PrismaClient,
  opts: {
    /**
     * Quantos produtos DESTINADOS ao modelo esta corrida pode tratar.
     * Deixou de significar "quantas linhas ler": os condicionais que a
     * pre-seleccao exclui sao atravessados e nao ocupam lugar.
     */
    limite?: number;
    /** Pagina da leitura do residual. So os testes mexem nisto. */
    tamanhoPagina?: number;
    dryRun?: boolean;
    /** Corta a corrida quando o custo estimado passa disto. */
    tectoUsd?: number;
    /**
     * Lotes em paralelo. Omitido = `CONCORRENCIA_OMISSAO`.
     * 1 restaura o comportamento sequencial anterior.
     */
    concorrencia?: number;
    /**
     * Restringe o residual ao que está na `EnriquecimentoFila` em
     * PENDENTE ou FALHOU.
     *
     * É o modo do ciclo curto: um produto acabado de importar entra na
     * fila e é apanhado minutos depois, em vez de esperar pela varredura
     * das 04:00. Barato quando a fila está vazia — o `exists` não
     * devolve nada e a corrida acaba sem uma única chamada.
     *
     * FALHOU entra de propósito: uma falha transitória da API não pode
     * condenar um produto a ficar de fora até alguém reparar.
     */
    apenasFila?: boolean;
    /**
     * Substitui a promoção ao catálogo global. Existe pela mesma razão
     * que `classificar` e `verificar`: sem isto, provar que os candidatos
     * levam a clínica exigia base de dados e control plane de pé — e o
     * defeito que isto guarda é de ESTRUTURA do candidato, não de
     * persistência.
     */
    promover?: typeof promoverAoGlobal;
    /** Amostra estratificada em vez dos primeiros N. */
    canary?: Partial<Record<Estrato, number>>;
    /**
     * SÓ COM `canary`. Atravessa as exclusões por poupança da
     * pré-selecção (designação opaca, subcategoria de baixa cobertura) e
     * manda esses produtos ao modelo à mesma.
     *
     * Existe porque um canary que respeita as heurísticas de poupança
     * pode não medir nada: na Silveira, 1 193 produtos no estrato
     * SEM_UTILIZACOES e ZERO enviados, com o relatório a dizer «TOTAL
     * 1200» ao lado de `obtido=0`. Uma amostra de zero não é uma amostra
     * barata — é a ausência de medição a passar por eficiência.
     *
     * O que isto NÃO faz: não desliga gate nenhum, não escreve nada que
     * o `dryRun` não deixasse escrever, e não toca em `PROPAGAR` — um
     * dependente continua a herdar do representante em vez de pagar
     * chamada própria.
     */
    forcarExcluidos?: boolean;
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
    classificarForma?: typeof classificarFormaLote;
    verificar?: typeof verificarLote;
    classificarUtilizacoes?: typeof classificarUtilizacoesLote;
    verificarUtilizacoes?: typeof verificarUtilizacoesLote;
  } = {},
): Promise<RunnerResumo> {
  // ── CREDENCIAL: antes de olhar sequer para a fila ──────────────────
  //
  // Verificada AQUI, e não à primeira chamada. A diferença é onde o erro
  // aparece: à primeira chamada, o lote já foi seleccionado e o caminho
  // de fecho da fila já está à espera com um `numeroTentativas + 1` para
  // cada produto. Uma instalação sem chave marcaria FALHOU em tudo o que
  // tocou, e ao fim de cinco passagens do scheduler o catálogo inteiro
  // estava fora da fila sem uma única pergunta ter sido feita.
  //
  // Em dry-run não se exige: uma simulação que não escreve também não
  // paga, e recusar aqui impedia medir o residual numa máquina sem
  // credencial.
  //
  // Também não se exige quando quem chama INJECTA o modelo (`classificar`
  // / `verificar`). Nesse caso o cliente do SDK nunca é instanciado — é
  // o que os testes fazem — e pedir uma credencial que ninguém vai usar
  // seria exigir um segredo para correr uma simulação.
  const usaClienteProprio = !opts.classificar && !opts.verificar;
  if (!(opts.dryRun ?? false) && usaClienteProprio && !credencialConfigurada()) {
    throw new FalhaInfraestrutura(
      "CREDENCIAL_AUSENTE",
      "sem ANTHROPIC_API_KEY nem ANTHROPIC_AUTH_TOKEN no ambiente deste processo. " +
        "A fila NÃO foi tocada — nenhum produto gastou tentativa.",
    );
  }

  const dryRun = opts.dryRun ?? false;
  const classificar = opts.classificar ?? classificarLote;
  const classificarForma = opts.classificarForma ?? classificarFormaLote;
  const verificar = opts.verificar ?? verificarLote;
  // Quem injecta só `classificar` num teste continua a ter um duplo para
  // o caminho de utilizações — senão o teste tocaria a rede.
  const classificarUtil = opts.classificarUtilizacoes ?? opts.classificar ?? classificarUtilizacoesLote;
  const verificarUtil = opts.verificarUtilizacoes ?? opts.verificar ?? verificarUtilizacoesLote;

  // A leitura do residual passou para depois da verificação de schema e
  // do carregamento do contexto: encher a janela precisa das famílias e
  // da cobertura, que se medem no tenant.
  let quotasCanary: QuotaEstrato[] | null = null;
  let residual: LinhaResidual[] = [];

  const resumo: RunnerResumo = {
    residualAnalisado: 0,
    residualLido: 0,
    foraDaJanela: 0,
    semContexto: 0,
    cnpsSemContexto: [],
    janela: {
      alvoProcessaveis: opts.limite ?? 500,
      paginasLidas: 0,
      tamanhoPagina: opts.tamanhoPagina ?? TAMANHO_PAGINA_RESIDUAL,
      esgotado: false,
    },
    propagadosSemEscrita: 0,
    jaConhecidosGlobal: 0,
    globalInsuficiente: 0,
    dependentesOrfaos: 0,
    promovidosAoGlobal: 0,
    avisos: [],
    falhaInfraestrutura: null,
    excluidosBaixaCobertura: 0,
    excluidosOpacos: 0,
    forcadosNoCanary: 0,
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
    categoriasProvisorias: 0,
    revisoesCriadas: 0,
    revisoesSemProposta: 0,
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
  /** Representantes que voltaram do modelo com resposta. */
  const comResultado = new Set<number>();

  /**
   * Junta um resultado APPLY à fila de promoção.
   *
   * Só o que ficou com classificação ESPECÍFICA: um "Outros <X>" não é
   * conhecimento e não serve nenhum outro tenant. `avaliarPromocao`
   * recusa-o de qualquer forma — não enviar poupa a viagem.
   */
  /**
   * Os campos clínicos deste resultado, prontos a promover.
   *
   * ── O QUE ISTO REPARA ────────────────────────────────────────────
   *
   * O `juntarCandidato` foi escrito antes da camada clínica e nunca
   * preenchia `ConhecimentoCandidato.clinica`. Como o campo era
   * opcional, o compilador não se queixou. O defeito só apareceu num
   * E2E, pelos autores das duas escritas no rasto de auditoria:
   *
   *   13:09:05.640  catalog:knowledge-enrich  classificação
   *   13:09:05.673  job:enrich-catalog        clínica ×5   ← outra fase
   *
   * A fase 5 do ciclo tapava o buraco. No runner isolado — o CLI
   * `catalog:knowledge-enrich`, que é como o backlog corre — não há
   * fase 5, e a clínica acabada de pagar não subia ao global.
   *
   * ── AS GUARDAS, TODAS ELAS ───────────────────────────────────────
   *
   *  · `LIMIAR_CLINICO` (0.90). A mesma barra que autoriza a ESCRITA no
   *    tenant autoriza a promoção. Promover o que não se escreveu seria
   *    dar ao catálogo nacional uma confiança que a base local recusou.
   *  · `validarValorClinico` recusa um ATC incompleto e uma DCI que seja
   *    uma frase — a MESMA função que o global usa, não uma cópia.
   *  · Um campo sem valor NÃO gera candidato. Nunca há candidato a null,
   *    logo nunca há caminho que apague.
   *  · O chamador aplica `semApresentacao()` aos dependentes ANTES de
   *    chegar aqui, portanto um irmão de família nunca traz forma,
   *    dosagem nem embalagem do representante — só a substância, que é
   *    o que a família de facto partilha.
   */
  const clinicaDoResultado = (
    r: KnowledgeResult,
    origem: OrigemGlobal,
  ): ClinicaCandidata[] => {
    if (r.confidenceClinica < LIMIAR_CLINICO) return [];
    const motivo =
      origem === "PROPAGADO"
        ? "conclusão do modelo sobre um irmão da família"
        : "decisão do modelo sobre este cnp";
    const pares: Array<[CampoClinico, string | null]> = [
      ["CODIGO_ATC", r.codigoATC],
      ["DCI", r.dci],
      ["FORMA_FARMACEUTICA", r.forma],
      ["DOSAGEM", r.dosagem],
      ["EMBALAGEM", r.embalagem],
    ];
    const out: ClinicaCandidata[] = [];
    for (const [campo, bruto] of pares) {
      const valor = validarValorClinico(campo, bruto);
      if (!valor) continue;
      out.push({
        campo,
        valor,
        origem,
        confianca: r.confidenceClinica,
        versaoRegras: KNOWLEDGE_VERSION,
        motivoOrigem: motivo,
      });
    }
    return out;
  };

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
    const clinica = clinicaDoResultado(r, origem);
    // A clínica conta para o produto valer a viagem. Um produto sem
    // classificação específica e sem utilizações pode na mesma trazer um
    // ATC e uma DCI — e antes desta linha era descartado antes de
    // alguém sequer olhar para ele.
    if (!temClassificacao && utilizacoes.length === 0 && clinica.length === 0) return;
    candidatosGlobais.push({
      clinica,
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
  // Preenchido depois de a janela do canary correr — as quotas só
  // existem a partir daí. Vazio no caminho normal.
  const elegiveisPorEstrato = new Map<Estrato, number>();
  const metrica = (estrato: Estrato): MetricasEstrato => {
    let m = metricas.get(estrato);
    if (!m) {
      m = {
        estrato,
        alvo: estrato === "SEM_UTILIZACOES" ? "UTILIZACOES" : "CLASSIFICACAO",
        universoInicial: 0,
        excluidosBaixaCobertura: 0,
        excluidosOpacos: 0,
        forcados: 0,
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

  // ── CONTEXTO DO TENANT ──────────────────────────────────────────────
  // Tudo o que aqui se calcula vem dos dados DESTE tenant: a cobertura
  // por subcategoria e as famílias são medidas na hora, não
  // configuradas. Carrega-se ANTES de ler o residual porque é disto que
  // a janela precisa para saber o que é processável.
  const contexto = await carregarContexto(prisma);
  const familias = agruparFamilias(contexto);
  const cobertura = coberturaPorSubcategoria(contexto);
  const subExcluidas = subcategoriasExcluiveis(
    cobertura,
    LIMIAR_COBERTURA_PERCENT,
    POPULACAO_MINIMA_SUBCATEGORIA,
  );
  const contextoPorCnp = new Map(contexto.map((p) => [p.cnp, p]));

  // ── CATÁLOGO GLOBAL: o filtro que vem antes de todos ────────────────
  //
  // O mesmo CNP é o mesmo produto nacional. Um CNP que outro tenant já
  // pagou não volta ao modelo — é projectado a partir do global.
  //
  // Corre por página, dentro da janela, e ANTES da pré-selecção: não
  // vale a pena calcular famílias e cobertura para produtos que nem
  // sequer vão à fila. Desligável (`usarGlobal: false`) para se poder
  // medir uma corrida sem esta camada.
  const resolverGlobal =
    opts.usarGlobal === false
      ? undefined
      : async (linhas: LinhaResidual[]) => {
          try {
            const conhecidos = await lerConhecimentoGlobal(linhas.map((l) => l.cnp));
            if (conhecidos.size === 0) return { restantes: linhas, resolvidos: 0, insuficientes: 0 };
            // POR NECESSIDADE, NÃO POR PRESENÇA.
            //
            // Era `residual.filter((l) => !conhecidos.has(l.cnp))`:
            // bastava o global ter uma linha do CNP para o produto não
            // ir ao modelo.
            //
            // O canary de 25 de 2026-08-21 mostrou o que isso valia —
            // 25 entraram, 25 saltados, 0 chamadas, custo $0 — e o que o
            // global tinha sobre eles era exactamente o contrário do que
            // lhes faltava: 19 sem utilizações foram dispensados por o
            // global saber a categoria que eles já tinham; 6 em "Outros"
            // foram dispensados por o global saber as utilizações que
            // eles já tinham.
            //
            // À escala: 7 692 dos 18 485 residuais eram saltados, e em
            // 7 690 o global não tinha nada que os ajudasse. Ficavam num
            // limbo estável — o global não os sabia classificar, o modelo
            // nunca os via — e o relatório chamava-lhe "chamadas poupadas
            // 100%".
            const restantes: LinhaResidual[] = [];
            let resolvidos = 0;
            let insuficientes = 0;
            for (const l of linhas) {
              const d = globalResolveResidual(l.estrato, conhecidos.get(l.cnp));
              if (d.resolve) {
                resolvidos++;
                continue;
              }
              // Conhecido mas insuficiente: contado à parte porque é a
              // diferença entre "o global tratou disto" e "o global tem
              // uma linha e não serve para nada aqui".
              if (conhecidos.has(l.cnp)) insuficientes++;
              restantes.push(l);
            }
            return { restantes, resolvidos, insuficientes };
          } catch (err) {
            // O control plane estar em baixo não pode impedir uma
            // corrida: o pior que acontece é pagar-se por CNPs que já
            // eram conhecidos.
            resumo.avisos.push(
              `catálogo global inacessível — corrida sem ele: ${err instanceof Error ? err.message : String(err)}`,
            );
            return { restantes: linhas, resolvidos: 0, insuficientes: 0 };
          }
        };

  // ── A JANELA ────────────────────────────────────────────────────────
  // `limite` = produtos DESTINADOS ao modelo. A leitura pagina por cursor
  // e atravessa os condicionais em vez de lhes dar lugar.
  const baseJanela = {
    apenasFila: opts.apenasFila === true,
    contexto,
    familias,
    subExcluidas,
    resolverGlobal,
    tamanhoPagina: opts.tamanhoPagina,
  };
  let preselecao: Map<number, Preselecao>;

  if (opts.canary) {
    const j = await lerJanelaCanary(prisma, opts.canary, {
      ...baseJanela,
      forcarExcluidos: opts.forcarExcluidos === true,
    });
    residual = j.linhas;
    preselecao = j.preselecao;
    quotasCanary = j.quotas;
    resumo.quotasCanary = j.quotas;
    resumo.residualLido = j.cnpsLidos;
    resumo.foraDaJanela = j.foraDaJanela;
    resumo.jaConhecidosGlobal = j.jaConhecidosGlobal;
    resumo.globalInsuficiente = j.globalInsuficiente;
    resumo.janela.paginasLidas = j.paginasLidas;
    resumo.janela.esgotado = j.esgotado;
    resumo.semContexto = j.semContexto;
    resumo.cnpsSemContexto = [...j.cnpsSemContexto];
    resumo.janela.alvoProcessaveis = j.quotas.reduce((n, q) => n + q.pedido, 0);
    // A projecção de custo multiplica pela POPULAÇÃO do estrato, não
    // pelos que sobreviveram à pré-selecção.
    for (const q of j.quotas) elegiveisPorEstrato.set(q.estrato, q.universo);
  } else {
    const j = await lerJanelaProcessavel(prisma, {
      ...baseJanela,
      alvoProcessaveis: opts.limite ?? 500,
    });
    residual = j.linhas;
    preselecao = j.preselecao;
    resumo.residualLido = j.cnpsLidos;
    resumo.foraDaJanela = j.foraDaJanela;
    resumo.jaConhecidosGlobal = j.jaConhecidosGlobal;
    resumo.globalInsuficiente = j.globalInsuficiente;
    resumo.janela.paginasLidas = j.paginasLidas;
    resumo.janela.esgotado = j.esgotado;
    resumo.semContexto = j.semContexto;
    resumo.cnpsSemContexto = [...j.cnpsSemContexto];
  }

  resumo.residualAnalisado = residual.length;
  for (const l of residual) resumo.porEstrato[l.estrato] = (resumo.porEstrato[l.estrato] ?? 0) + 1;
  if (residual.length === 0) {
    resumo.metricasPorEstrato = [...metricas.values()];
    return resumo;
  }

  // Dependentes por representante: quem espera pela decisão de quem.
  // Só com canary: sem ele a corrida normal não muda em nada.
  const forcarExcluidos = opts.canary !== undefined && opts.forcarExcluidos === true;
  const dependentes = new Map<number, LinhaResidual[]>();
  const enviar: LinhaResidual[] = [];
  for (const l of residual) {
    const pre = preselecao.get(l.cnp);
    if (!pre) {
      // NUNCA UM `continue` MUDO.
      //
      // `preselecionar` salta um cnp que não exista no contexto do
      // tenant. Hoje é inalcançável — o contexto é superconjunto do
      // residual — mas era a única porta por onde um produto do residual
      // podia sair da corrida E da contabilidade ao mesmo tempo, sem
      // cache, sem contador e sem aparecer no relatório. Um buraco que
      // ainda não abriu continua a ser um buraco.
      resumo.semContexto++;
      resumo.cnpsSemContexto.push(l.cnp);
      metrica(l.estrato).universoInicial++;
      continue;
    }
    const m = metrica(l.estrato);
    m.universoInicial++;
    // Adiado por poupança, mas o canary manda seguir: entra na fila de
    // envio e é contado como FORÇADO, nunca como excluído. Contá-lo nos
    // dois sítios partiria a reconciliação — e um produto que foi ao
    // modelo não é um produto poupado.
    if (forcarExcluidos && ehAdiadoPorPoupanca(pre.destino)) {
      resumo.forcadosNoCanary++;
      m.forcados++;
      enviar.push(l);
      resumo.preselecao.push({
        cnp: l.cnp,
        designacao: contextoPorCnp.get(l.cnp)?.designacao ?? "",
        estrato: l.estrato,
        destino: pre.destino,
        chaveFamilia: pre.chaveFamilia,
        representanteCnp: pre.representanteCnp,
        motivo: pre.motivo,
        forcado: true,
      });
      continue;
    }
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
  if (resumo.semContexto > 0) {
    resumo.avisos.push(
      `${resumo.semContexto} produto(s) do residual sem linha no contexto do tenant — ` +
        `não foram tratados: ${resumo.cnpsSemContexto.slice(0, 20).join(", ")}` +
        (resumo.cnpsSemContexto.length > 20 ? ` … (+${resumo.cnpsSemContexto.length - 20})` : ""),
    );
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
        // A não-degradação, a soberania do MANUAL e a regra de que só uma
        // CANONICA corrige uma PROVISORIA vivem todas dentro de
        // `escreverClassificacao` — um WHERE só, partilhado com o
        // reprocessamento da cache. Estavam aqui em SQL solto, e uma
        // segunda cópia dessa hierarquia divergiria em silêncio.
        const j = await escreverClassificacao(prisma, {
          cnp: p.cnp,
          n1Id,
          n2Id,
          n1Nome: r.categoria,
          n2Nome: r.subcategoria,
          estado: gate.provisorio ? "PROVISORIA" : "CANONICA",
          // A propagação tem proveniência própria: o valor não é uma
          // observação DESTE produto, é a conclusão sobre um irmão.
          origem: gate.provisorio
            ? "MODELO_PROVISORIO"
            : fonte === FONTE_PROPAGADA
            ? "MODELO_PROPAGADO"
            : "MODELO",
          confianca,
          versao: gate.provisorio ? VERSAO_PROVISORIA : KNOWLEDGE_VERSION,
        });
        if (j) {
          resumo.categoriasEscritas++;
          if (gate.provisorio) resumo.categoriasProvisorias++;
        }
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
      // O MOTIVO TEM DE DISTINGUIR AS DUAS RECUSAS.
      //
      // "propagado do representante N" dizia o mesmo quando se escrevia
      // e quando não se escrevia. Quem lesse a cache depois não
      // conseguia separar "o irmão resolveu isto" de "o irmão resolveu,
      // mas o gate deste produto recusou" — e são coisas diferentes: a
      // segunda é uma decisão sobre ESTE cnp.
      motivo:
        gateDep.decisao === "APPLY"
          ? `propagado do representante ${r.cnp}`
          : `propagado do representante ${r.cnp}, recusado pelo gate próprio (${gateDep.decisao}): ${gateDep.motivo}`,
    };

    // ── CONTA SEMPRE ────────────────────────────────────────────────
    //
    // Era `if (efectivo.decisao === "APPLY")`. Um dependente cujo gate
    // próprio recusasse — em SEM_UTILIZACOES com `utilizacoesFinais`
    // vazia, ou já classificado de forma específica e divergente —
    // recebia cache e não era contado por ninguém. A reconciliação
    // fechava a menos e nem se sabia porquê.
    //
    // O dependente TEVE destino: herdou uma decisão. Que a decisão não
    // escreva não a torna inexistente.
    const m = metrica(dep.estrato);
    resumo.propagados++;
    m.propagados++;
    if (efectivo.decisao !== "APPLY") resumo.propagadosSemEscrita++;
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
    // Agrupar por ALVO dentro do estrato, e nao so' por estrato.
    //
    // Ate' aqui estrato e alvo eram a mesma coisa e o codigo dizia-o:
    // «num lote homogeneo sao a mesma coisa». Deixaram de ser. Dentro de
    // SEM_UTILIZACOES ha' agora produtos com forma (alvo UTILIZACOES) e
    // sem forma (alvo FORMA), e um lote misto mandaria metade deles ao
    // prompt errado — e, pior, ao prefixo de cache errado, pagando a
    // escrita de cache a cada alternancia.
    const porAlvo = new Map<AlvoPedido, LinhaResidual[]>();
    for (const l of fila) {
      const alvo = alvoParaProduto({ subcategoria: l.subcategoriaAtual, forma: l.formaAtual ?? null });
      const g = porAlvo.get(alvo) ?? [];
      g.push(l);
      porAlvo.set(alvo, g);
    }
    for (const [alvo, grupo] of porAlvo) {
      const tamanho = alvo === "FORMA" ? TAMANHO_LOTE_FORMA : TAMANHO_LOTE;
      for (let i = 0; i < grupo.length; i += tamanho) lotes.push(grupo.slice(i, i + tamanho));
    }
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
    const alvo = alvoParaProduto({
      subcategoria: lote[0]!.subcategoriaAtual,
      forma: lote[0]!.formaAtual ?? null,
    });

    const somaLocal = (u: RunnerResumo["usage"]) => {
      somaUsage(u);
      m.usage.inputTokens += u.inputTokens;
      m.usage.outputTokens += u.outputTokens;
      m.usage.cacheReadTokens += u.cacheReadTokens;
      m.usage.cacheWriteTokens += u.cacheWriteTokens;
      m.custoUsd = estimarCusto(m.usage);
    };

    // ── Passagem 1: proposta ────────────────────────────────────────
    const p1 =
      alvo === "FORMA"
        ? await classificarForma(lote)
        : alvo === "UTILIZACOES"
        ? await classificarUtil(lote)
        : await classificar(lote);
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
      // Quem voltou com resposta. Serve para, no fim, saber que
      // dependentes ficaram órfãos por o representante nunca ter tido
      // decisão — um lote perdido, um tecto que cortou antes do envio.
      comResultado.add(r.cnp);

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
        {
          categoria: p.categoriaAtual,
          subcategoria: p.subcategoriaAtual,
          productType: p.productType,
          forma: p.formaAtual ?? null,
        },
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

      const motivoBase = gate.decisao === "REVIEW" && exigeVerificacao && !comparacao.concorda
        ? comparacao.motivo
        : gate.motivo;
      // "fora do vocabulário" nao diz nada a quem le' a cache seis meses
      // depois. `motivoPar` diz exactamente o par que o modelo propos e
      // porque e' que a taxonomia nao o aceitou — e e' esse texto que
      // distingue "o modelo falhou" de "a nossa taxonomia nao tem onde
      // por isto", que e' a pergunta que interessa a seguir.
      const motivo = r.motivoPar ? `${motivoBase} (${r.motivoPar})` : motivoBase;

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

      // ── O REVIEW chega agora a uma pessoa ──────────────────────────
      //
      // Ate' aqui morria na linha acima: a cache guardava-o com
      // `persistido=false` — um registo de supressao, cujo proposito
      // escrito e' impedir que se volte a perguntar — e mais nada. O
      // produto ficava por classificar E deixava de ser perguntado.
      //
      // So' entra o que uma pessoa possa decidir. Um DESCONHECIDO nao e'
      // uma pergunta, e uma fila cheia deles e' uma fila que ninguem abre
      // duas vezes.
      if (gate.decisao === "REVIEW") {
        if (propostaAccionavel(r)) {
          const res = await enfileirarRevisaoClassificacao(prisma, {
            cnp: r.cnp,
            categoria: r.categoria as string,
            subcategoria: r.subcategoria as string,
            productType: r.productType,
            confidence: r.confidence,
            evidenceType: r.evidenceType,
            rationale: r.rationale || null,
            motivo,
            chaveCache: chaveCache(r.cnp, p.designacao),
            fonte: "knowledge-enrichment",
          });
          if (res === "criada") resumo.revisoesCriadas++;
        } else {
          resumo.revisoesSemProposta++;
        }
      }

      // ── DEPENDENTES SEM DECISÃO APROVEITÁVEL ─────────────────────
      //
      // O representante não passou o gate — REVIEW por discordância, ou
      // SKIP por o modelo não ter produzido nada seguro. Os dependentes
      // dele NÃO herdam escrita nenhuma, e é correcto que não herdem.
      //
      // O que estava errado era o que lhes acontecia a seguir: NADA. Sem
      // linha de cache, sem estado, sem contagem. O canary de 25 de
      // 2026-08-21 mediu-o — 5 famílias, 5 representantes, 1 único
      // propagado, e a reconciliação a acusar 4 produtos sem destino:
      //
      //   2046787  rep 2046688  SKIP   "nenhuma utilização segura"
      //   2055283  rep 2055184  REVIEW "discordância: proposta ..."
      //   2149391  rep 2050896  SKIP   "nenhuma utilização segura"
      //   2175693  rep 2050490  SKIP   "nenhuma utilização segura"
      //
      // Os quatro ficaram exactamente como estavam antes da corrida, e
      // voltariam ao residual na corrida seguinte — onde a mesma família
      // escolheria o mesmo representante (o de cnp menor), que voltaria
      // a falhar da mesma maneira, e o dependente voltaria a ser
      // descartado. Um ciclo que paga uma chamada por volta e nunca
      // converge.
      //
      // A assimetria era esta: o representante recusado FICA com linha de
      // cache (`persistido=false` + motivo) e sai do residual; o
      // dependente não ficava com nada. A recusa propaga-se tão
      // legitimamente como a aceitação — é a mesma família e a mesma
      // designação — e é o que dá ao dependente um estado terminal
      // honesto: "não foi escrito, e eis porquê".
      if (gate.decisao !== "APPLY") {
        for (const dep of dependentes.get(r.cnp) ?? []) {
          resumo.propagados++;
          resumo.propagadosSemEscrita++;
          metrica(dep.estrato).propagados++;
          if (!dryRun) {
            await gravarCache(
              prisma,
              { ...r, ...semApresentacao(r), cnp: dep.cnp },
              dep,
              // `persistido = false`: não se escreveu nada no produto, e
              // a cache tem de dizer a verdade sobre isso.
              false,
              `representante ${r.cnp} não aplicável (${gate.decisao}): ${motivo}`,
              "PROPAGADO",
              r.cnp,
            );
          }
        }
      }

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
          // `persistido` TEM DE SER O QUE ACONTECEU.
          //
          // Estava `true` fixo. Um dependente recusado pelo gate próprio
          // ficava com uma linha a dizer "persistido, sem motivo" sem
          // nada ter sido escrito no Produto — e a fila, que decide o
          // estado a partir deste campo, fechava-o como SUCESSO. Um
          // produto por resolver saía da fila como resolvido.
          //
          // Agora: APPLY → persistido, SUCESSO. Não-APPLY → não
          // persistido, REVISAO_NECESSARIA, com o motivo a dizer que foi
          // o gate próprio que recusou. Em qualquer dos casos há linha
          // de cache, portanto o produto não volta ao residual a pedir
          // outra chamada por uma pergunta já respondida.
          await gravarCache(
            prisma,
            { ...r, ...semApresentacao(r), cnp: dep.cnp, confidence: confiancaProp },
            dep,
            gateDep.decisao === "APPLY",
            gateDep.motivo,
            "PROPAGADO",
            r.cnp,
          );
          // Os dependentes nunca chegavam a ser candidatos: o
          // `juntarCandidato` só era chamado para o representante. O
          // conhecimento propagado ficava no tenant e não subia, e o
          // bootstrap manual tinha depois de o ir buscar — foram 432
          // PROPAGADO na promoção de 2026-08-21, todos eles atrasados
          // por isto.
          //
          // `semApresentacao` aplicado aqui é o que impede o irmão de
          // herdar forma, dosagem e embalagem do representante: HALDOL
          // 5 MG não leva "1 mg" só por partilhar a família.
          juntarCandidato(
            { ...r, ...semApresentacao(r), cnp: dep.cnp },
            dep,
            gateDep,
            utilizacoesFinais,
            confiancaProp,
            "PROPAGADO",
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
      // Uma falha de infraestrutura pára TODOS os trabalhadores, e não só
      // aquele que a apanhou. Continuar seria repetir a mesma falha por
      // cada lote restante — e, pior, dar-lhe a aparência de muitas
      // falhas independentes em vez de uma só, que é a conta.
      if (resumo.falhaInfraestrutura) return;
      const i = proximo++;
      if (i >= lotes.length) return;
      try {
        await processarLote(lotes[i]!);
      } catch (err) {
        const infra = classificarFalhaInfra(err);
        if (!infra) throw err;
        resumo.falhaInfraestrutura = { categoria: infra.categoria, mensagem: infra.message };
        resumo.avisos.push(`corrida interrompida — ${infra.categoria}: ${infra.message}`);
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: nTrabalhadores }, () => trabalhador()));

  // ── DEPENDENTES ÓRFÃOS ──────────────────────────────────────────────
  //
  // O representante nunca chegou a ter decisão: o lote perdeu-se, ou o
  // tecto cortou antes de ele ser enviado. Os dependentes não receberam
  // nada — nem aceitação nem recusa — e é correcto que não recebam: não
  // há decisão para propagar.
  //
  // Mas TÊM de ser contados. Sem isto voltavam a ser o buraco silencioso
  // que a reconciliação existe para denunciar, só que por outra porta:
  // em vez de "o representante recusou" seria "o representante não
  // respondeu", e o efeito visível era o mesmo — produtos a desaparecer
  // da soma.
  //
  // Voltam ao residual na corrida seguinte, e é o comportamento certo:
  // nada foi decidido sobre eles.
  for (const [repCnp, deps] of dependentes) {
    if (comResultado.has(repCnp)) continue;
    resumo.dependentesOrfaos += deps.length;
  }

  resumo.custoEstimadoUsd = estimarCusto(resumo.usage);

  // ── Fechar a fila: três destinos, não um ────────────────────────────
  //
  // Estava tudo a sair como SUCESSO_PARCIAL, o que apagava a diferença
  // entre "classificámos" e "o modelo não soube". Um produto que o
  // modelo não reconhece não está resolvido — está à espera de uma
  // pessoa ou de uma fonte que ainda não existe — e sair da fila como se
  // estivesse tornava-o incontável. O objectivo do pipeline é que
  // nenhum produto fique esquecido, e isso exige que "não resolvido"
  // tenha nome próprio.
  //
  //   SUCESSO             a cache diz `persistido` — foi escrito.
  //   REVISAO_NECESSARIA  respondeu e não escrevemos: DESCONHECIDO,
  //                       abaixo do limiar, ou só um fallback. TERMINAL:
  //                       repetir a chamada não muda a resposta.
  //   FALHOU              foi seleccionado e não voltou com resposta
  //                       nenhuma — falha técnica. Retentável com
  //                       backoff, até MAX_TENTATIVAS_FILA.
  if (!dryRun && resumo.falhaInfraestrutura) {
    // O ponto todo desta mudança. A fila fica exactamente como estava:
    // os produtos continuam PENDENTE, com o mesmo `numeroTentativas`, e
    // a passagem seguinte do scheduler volta a apanhá-los. Não é uma
    // omissão — é a decisão.
    resumo.avisos.push(
      "fila NÃO alterada: a falha foi de infraestrutura " +
        `(${resumo.falhaInfraestrutura.categoria}) e não dos produtos. ` +
        "Nenhum produto gastou tentativa.",
    );
  } else if (!dryRun) {
    const cnpsVistos = residual.map((l) => Number(l.cnp) | 0);
    try {
      // 1+2. Quem tem linha na cache desta versão sai da fila, e o
      //      destino é decidido pelo `persistido` dessa linha.
      await prisma.$executeRawUnsafe(
        `update "EnriquecimentoFila" f
            set estado = case when k.persistido then 'SUCESSO'::"EnriquecimentoEstado"
                              else 'REVISAO_NECESSARIA'::"EnriquecimentoEstado" end,
                "ultimaTentativa"  = now(),
                "numeroTentativas" = f."numeroTentativas" + 1,
                "ultimaFonte"      = $3,
                "mensagemErro"     = case when k.persistido then null else k.motivo end,
                "dataAtualizacao"  = now()
           from "Produto" p
           join "KnowledgeEnrichmentCache" k
             on k.cnp = p.cnp and k.versao = $1 and k.modelo = $2
          where p.id = f."produtoId"
            and f.estado in ('PENDENTE', 'FALHOU')`,
        KNOWLEDGE_VERSION,
        KNOWLEDGE_MODEL,
        `knowledge:${KNOWLEDGE_VERSION}`,
      );

      // 3. Seleccionado, sem cache: o lote perdeu-se. Conta a tentativa,
      //    para o tecto e o backoff terem o que limitar. Sem este passo,
      //    "retentativas limitadas" não teria nada que contar e o
      //    produto voltava de 15 em 15 minutos indefinidamente.
      if (cnpsVistos.length > 0) {
        await prisma.$executeRawUnsafe(
          `update "EnriquecimentoFila" f
              set estado = 'FALHOU',
                  "ultimaTentativa"  = now(),
                  "numeroTentativas" = f."numeroTentativas" + 1,
                  "ultimaFonte"      = $3,
                  "mensagemErro"     = 'sem resposta do modelo nesta passagem',
                  "dataAtualizacao"  = now()
             from "Produto" p
            where p.id = f."produtoId"
              and f.estado in ('PENDENTE', 'FALHOU')
              and p.cnp = any('{${cnpsVistos.join(",")}}'::int[])
              and not exists (
                    select 1 from "KnowledgeEnrichmentCache" k
                     where k.cnp = p.cnp and k.versao = $1 and k.modelo = $2
              )`,
          KNOWLEDGE_VERSION,
          KNOWLEDGE_MODEL,
          `knowledge:${KNOWLEDGE_VERSION}`,
        );
      }
    } catch (e) {
      // A fila é contabilidade, não o trabalho. O que interessa já foi
      // escrito no Produto e na cache; falhar a fechá-la faz o ciclo
      // seguinte reprocessar, e a cache torna isso gratuito.
      console.error(
        "[knowledge] não consegui fechar as entradas de fila:",
        e instanceof Error ? e.message : e,
      );
    }
  }

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
      const promover = opts.promover ?? promoverAoGlobal;
      const res = await promover(candidatosGlobais, {
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
      // O par TAL COMO VEIO, valido ou nao. Ate' aqui um par fora da
      // taxonomia era anulado antes de chegar cá e a cache guardava
      // `null` — indistinguivel de "o modelo nao respondeu". Era
      // informacao ja' paga a desaparecer sem rasto.
      //
      // Nunca sao escritos em `Produto`: existem para auditoria e para o
      // reprocessamento saber o que ha' para reavaliar.
      categoriaBruta: r.categoriaBruta,
      subcategoriaBruta: r.subcategoriaBruta,
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
    update: {
      persistido,
      motivo: persistido ? null : motivo,
      origem,
      propagadoDeCnp,
      // Actualizados tambem no update: uma linha gravada antes destes
      // campos existirem tem-nos a `null`, e a passagem seguinte sobre o
      // mesmo produto e' a oportunidade de os preencher.
      categoriaBruta: r.categoriaBruta,
      subcategoriaBruta: r.subcategoriaBruta,
    },
  });
}
