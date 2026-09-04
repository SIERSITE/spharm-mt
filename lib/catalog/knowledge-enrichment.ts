/**
 * lib/catalog/knowledge-enrichment.ts
 *
 * Segunda fase da classificação: resolve o que as regras determinísticas
 * não conseguem resolver por não estar escrito na designação.
 *
 * ─────────────────────────────────────────────────────────────────────
 * PORQUÊ ISTO EXISTE
 *
 * A fase determinística chega a 64% de classificações específicas. O que
 * fica é sempre a mesma coisa: "Ozempic 0.25 Mg Sol. Injetável",
 * "Eliquis 5 Mg", "Vibrocil Gotas". A designação não diz o que o produto
 * trata — diz a marca, a dosagem e a forma. Nenhuma regra sobre o texto
 * resolve isto, porque a informação não está no texto. Está em saber o
 * que a marca é.
 *
 * O que NÃO é: um dicionário de marcas escrito à mão. Esse dicionário
 * teria de crescer para sempre, uma marca de cada vez, e ficaria
 * desactualizado a cada lançamento.
 *
 * ─────────────────────────────────────────────────────────────────────
 * O QUE IMPEDE ISTO DE INVENTAR
 *
 * Não é o prompt. É o código, em quatro camadas — e todas elas rejeitam
 * silenciosamente, nunca corrigem:
 *
 *  1. VOCABULÁRIO FECHADO. Categoria e subcategoria são validadas contra
 *     `CANONICAL_TAXONOMY`; utilizações contra `UTILIZACOES_POR_SLUG`.
 *     Um par que não exista é descartado. O modelo não pode criar uma
 *     categoria, tal como o mapper determinístico não podia.
 *
 *  2. SÓ O RESIDUAL ENTRA. Quem selecciona os produtos é SQL, não o
 *     modelo (ver `selecionarResidual`). Um produto já classificado
 *     especificamente nunca chega aqui — a não-degradação é uma
 *     propriedade da consulta, não da bondade do resultado.
 *
 *  3. LIMIAR ALTO PARA ESCREVER. Abaixo de LIMIAR_PERSISTENCIA nada é
 *     gravado; o produto vai para revisão. "Não sei" é uma resposta
 *     aceite e registada, não um buraco a preencher.
 *
 *  4. TIER MAIS BAIXO QUE TUDO. `MODEL_INFERRED` fica abaixo de
 *     `INTERNAL_INFERRED` no `SOURCE_TIER_RANK`. Qualquer fonte — INFARMED,
 *     fabricante, distribuidor, ou a própria farmácia — ganha sempre.
 *
 * ─────────────────────────────────────────────────────────────────────
 * CUSTO
 *
 * Os produtos vão em lotes e a taxonomia inteira vai em prefixo cacheado,
 * porque é idêntica em todos os pedidos. Sem isso, cada lote pagaria a
 * taxonomia outra vez. Ver `TAMANHO_LOTE` e o `cache_control` abaixo.
 *
 * ÂMBITO: isto organiza o catálogo para quem atende encontrar o que tem
 * na loja. Não é indicação terapêutica e não substitui quem dispensa.
 */
import Anthropic from "@anthropic-ai/sdk";
import { CANONICAL_TAXONOMY, isValidNivel2 } from "../catalog-taxonomy";
import { UTILIZACOES, UTILIZACOES_POR_SLUG } from "./utilizacoes";
import type { ProductType } from "../catalog-types";

/**
 * Bump ao mudar prompt, esquema ou modelo. Entra na chave da cache: uma
 * versão nova invalida o que estava lá sem apagar nada, e permite
 * comparar duas versões lado a lado sobre o mesmo catálogo.
 */
export const KNOWLEDGE_VERSION = "ke-2.0";

/**
 * Os ÚNICOS campos que esta fonte pode escrever.
 *
 * Não é documentação — é verificado em teste, e o runner não tem código
 * para escrever mais nada. Fica de fora tudo o que tem uma fonte melhor:
 * ATC e DCI vêm do INFARMED, fabricante vem do titular da AIM, imagem vem
 * do fabricante, forma farmacêutica vem da designação por regra. Um
 * modelo acertaria em muitos deles — e seria na mesma a pior fonte
 * disponível para todos.
 *
 * `forma` continua a ser pedida e guardada em cache como evidência (ajuda
 * a perceber se o modelo entendeu o produto), mas nunca é escrita.
 */
export const CAMPOS_ESCRITOS = [
  "productType",
  "classificacaoNivel1Id",
  "classificacaoNivel2Id",
  "ProdutoUtilizacao",
  // ── ke-2.0: campos clínicos ────────────────────────────────────────
  // Decisão explícita do operador (2026-08-21), contra a política
  // original deste ficheiro. O raciocínio antigo — "o modelo seria a
  // pior fonte disponível" — continua verdadeiro; o que mudou é que
  // não existe fonte melhor: `RegulatoryRecord` está vazia e não há
  // dataset INFARMED. A escolha é entre um valor inferido, marcado
  // como inferido, e nenhum valor.
  //
  // Três guardas tornam isto reversível:
  //   · `taxaIvaSource`-style: gravamos MODEL_INFERRED em
  //     `classificationSource` e a versão em `classificationVersion`,
  //     portanto um UPDATE ... WHERE classificationVersion = 'ke-2.0'
  //     apaga tudo o que esta fase escreveu.
  //   · `is null` no WHERE: nunca sobrepõe um valor existente. Se um
  //     dia entrar o INFARMED, ele escreve primeiro e isto não toca.
  //   · LIMIAR_CLINICO > LIMIAR_PERSISTENCIA: a barra para gravar um
  //     ATC é mais alta que a barra para gravar uma categoria.
  "dci",
  "codigoATC",
  "formaFarmaceutica",
  "dosagem",
  "embalagem",
] as const;

/**
 * Campos que esta fonte continua proibida de escrever.
 *
 * `fabricanteId` e `imagemUrl` ficam de fora do alargamento ke-2.0 de
 * propósito: o fabricante já vem do ERP em 95% do catálogo (não falta),
 * e uma imagem não é inferível — um modelo não pode devolver um ficheiro
 * que não viu. Alargar a estes dois seria inventar sem sequer o ganho.
 */
export const CAMPOS_PROIBIDOS = [
  "fabricanteId",
  "imagemUrl",
] as const;

// ─── Modelo ───────────────────────────────────────────────────────────

/**
 * Modelo por omissão. Configurável por `CATALOG_KNOWLEDGE_MODEL` para o
 * operador poder fixar um snapshot datado sem tocar em código.
 */
const MODELO_OMISSAO = "claude-opus-5";

/**
 * Resolve e valida o id do modelo.
 *
 * Aliases móveis são recusados. Um alias que anda sozinho significa que o
 * mesmo cnp, na mesma versão de regras, pode ser classificado por dois
 * modelos diferentes em dias diferentes — e a cache, que tem o modelo na
 * chave, deixaria de significar o que diz. Se o modelo mudar, tem de ser
 * uma decisão escrita: nova env ou novo `MODELO_OMISSAO`, e a chave de
 * cache muda com ela.
 */
export function resolverModelo(
  bruto: string | undefined = process.env.CATALOG_KNOWLEDGE_MODEL,
): string {
  const id = (bruto ?? MODELO_OMISSAO).trim();
  if (!id) {
    throw new Error("CATALOG_KNOWLEDGE_MODEL está definida mas vazia — remove-a ou põe um id de modelo.");
  }
  if (/latest|\*/i.test(id)) {
    throw new Error(
      `Modelo "${id}" recusado: aliases móveis ("latest") tornam a cache mentirosa — ` +
        "o mesmo produto passaria a ser classificado por modelos diferentes sob a mesma chave. " +
        "Usa um id fixo (ex.: claude-opus-5).",
    );
  }
  return id;
}

/**
 * O modelo em uso. Fixo no arranque, e faz parte da chave de cache —
 * ver `chaveCache` — e da coluna `modelo` de KnowledgeEnrichmentCache.
 */
export const KNOWLEDGE_MODEL = resolverModelo();

// ─── Rede: timeout e retentativas ─────────────────────────────────────

/**
 * Timeout por pedido. Um lote de 25 com effort médio resolve-se bem
 * dentro disto; o default do SDK (10 min) deixaria uma corrida pendurada
 * quase um quarto de hora por lote antes de desistir.
 */
export const TIMEOUT_MS = 120_000;

/** Tentativas extra por pedido, para lá da primeira. Tecto duro. */
export const MAX_RETENTATIVAS = 3;

/**
 * O que se repete — e, sobretudo, o que não se repete.
 *
 * Repete-se o que é transitório: 429 (excesso de ritmo), 5xx (lado deles),
 * timeouts e falhas de ligação. A segunda tentativa tem hipótese real de
 * correr melhor.
 *
 * NÃO se repete um 4xx funcional. Um 400 por esquema inválido, um 401 por
 * credencial errada ou um 413 por lote grande demais vão dar exactamente
 * o mesmo erro à terceira vez — repetir só multiplica por três o tempo até
 * o operador ver a mensagem que interessa. E se for facturável, paga-se
 * três vezes um pedido que nunca ia servir.
 */
// ═════════════════════════════════════════════════════════════════════
// FALHA DE INFRAESTRUTURA ≠ FALHA DO PRODUTO
// ═════════════════════════════════════════════════════════════════════
//
// A distinção não é académica. A fila conta tentativas por PRODUTO, com
// tecto de cinco e backoff exponencial, e a contagem existe para impedir
// que um produto que o modelo nunca vai conseguir classificar gere
// chamadas para sempre.
//
// Quando o que falha é a conta — chave ausente, saldo esgotado, serviço
// em baixo — nada disso diz respeito ao produto. Se essas falhas
// contarem como tentativas, uma noite sem saldo queima as cinco
// tentativas de milhares de produtos de uma vez, e no dia seguinte,
// com saldo, eles já não voltam à fila. O pipeline dá-se por concluído
// tendo processado zero.
//
// Foi por um triz que isso não aconteceu: a corrida de 2026-08-21 morreu
// com «Your credit balance is too low» e a excepção derrubou o processo
// inteiro ANTES de a fila ser fechada. A fila safou-se por acidente, não
// por desenho. É esse acidente que isto substitui por uma regra.

export type CategoriaInfra =
  /** Não há credencial nenhuma. Erro de configuração, não do produto. */
  | "CREDENCIAL_AUSENTE"
  /** Há credencial e não serve: revogada, errada, sem permissões. */
  | "AUTENTICACAO"
  /** Saldo esgotado. A conta, não o catálogo. */
  | "SALDO"
  /** Estamos a bater no limite. Voltar mais tarde resolve. */
  | "RATE_LIMIT"
  /** O serviço está em baixo ou sobrecarregado. */
  | "SERVICO_INDISPONIVEL"
  /** Não chegámos lá: DNS, timeout de ligação, proxy. */
  | "REDE";

/**
 * Falha que NÃO é do produto. Quem apanhar isto não deve contar
 * tentativas nem mudar o estado de nada na fila.
 */
export class FalhaInfraestrutura extends Error {
  constructor(
    readonly categoria: CategoriaInfra,
    mensagem: string,
    readonly causa?: unknown,
  ) {
    super(mensagem);
    this.name = "FalhaInfraestrutura";
  }
}

/**
 * Há credencial configurada?
 *
 * O SDK aceita `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` ou um perfil
 * de `ant auth login`. Só as duas primeiras são verificáveis daqui sem
 * fazer uma chamada — e é por isso que esta função responde "não sei"
 * em vez de "não", devolvendo `true` quando não consegue provar a
 * ausência. Um falso positivo custa uma chamada que devolve 401 e é
 * classificada como infra na mesma; um falso negativo travava uma
 * instalação legítima.
 */
export function credencialConfigurada(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTHROPIC_AUTH_TOKEN?.trim());
}

/**
 * Este erro é da infraestrutura? Devolve a falha tipada, ou `null` se o
 * problema é mesmo do produto ou da resposta.
 *
 * A classificação é por STATUS e por tipo de erro do SDK, não por texto
 * — excepto o saldo, que a API devolve como `invalid_request_error` com
 * HTTP 400. Um 400 é normalmente culpa de quem pergunta, e este 400 em
 * particular não é: sem olhar para a mensagem, o saldo esgotado seria
 * classificado como erro do pedido e contava tentativas em todos os
 * produtos do lote.
 */
export function classificarFalhaInfra(err: unknown): FalhaInfraestrutura | null {
  if (err instanceof FalhaInfraestrutura) return err;

  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new FalhaInfraestrutura("REDE", "timeout de ligação à API", err);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new FalhaInfraestrutura("REDE", "não foi possível contactar a API", err);
  }

  const mensagem = err instanceof Error ? err.message : String(err ?? "");
  const status = (err as { status?: number } | null)?.status;

  // O SDK lança isto no construtor quando não encontra credencial
  // nenhuma. Chega antes de qualquer status HTTP.
  if (/apiKey|api_key|authentication_error|credential/i.test(mensagem) && typeof status !== "number") {
    return new FalhaInfraestrutura("CREDENCIAL_AUSENTE", `sem credencial utilizável: ${mensagem}`, err);
  }

  if (typeof status !== "number") return null;

  if (status === 401) return new FalhaInfraestrutura("AUTENTICACAO", "credencial recusada (401)", err);
  if (status === 403) return new FalhaInfraestrutura("AUTENTICACAO", "credencial sem permissões (403)", err);
  if (status === 429) return new FalhaInfraestrutura("RATE_LIMIT", "limite de pedidos atingido (429)", err);
  if (status >= 500) {
    return new FalhaInfraestrutura("SERVICO_INDISPONIVEL", `serviço indisponível (${status})`, err);
  }
  // O saldo. Único caso em que se lê a mensagem, e com razão declarada
  // acima.
  if (status === 400 && /credit balance|billing|quota|insufficient/i.test(mensagem)) {
    return new FalhaInfraestrutura("SALDO", "saldo insuficiente na conta Anthropic", err);
  }

  // 400 de esquema, 422, uma recusa, uma resposta que não valida: isso é
  // do produto ou da resposta, e conta tentativa.
  return null;
}

export function deveRepetir(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionTimeoutError) return true;
  if (err instanceof Anthropic.APIConnectionError) return true;
  const status = (err as { status?: number } | null)?.status;
  if (typeof status !== "number") return false;
  if (status === 408 || status === 429) return true;
  return status >= 500;
}

/** Espera antes da tentativa n (1-based): 1s, 2s, 4s, com jitter. */
function esperaMs(tentativa: number): number {
  return Math.round(1000 * 2 ** (tentativa - 1) * (0.75 + Math.random() * 0.5));
}

async function comRetentativa<T>(fn: () => Promise<T>): Promise<T> {
  let ultimo: unknown;
  for (let tentativa = 0; tentativa <= MAX_RETENTATIVAS; tentativa++) {
    try {
      return await fn();
    } catch (err) {
      ultimo = err;
      if (tentativa === MAX_RETENTATIVAS || !deveRepetir(err)) throw err;
      await new Promise((r) => setTimeout(r, esperaMs(tentativa + 1)));
    }
  }
  throw ultimo;
}

/**
 * Abaixo disto não se escreve nada — o produto fica para revisão.
 * Deliberadamente acima do limiar das regras determinísticas (0.80): um
 * palpite sobre uma marca vale menos que uma substância escrita na
 * designação, e o limiar tem de reflectir isso.
 */
export const LIMIAR_PERSISTENCIA = 0.85;

/**
 * Barra para gravar campos clínicos (DCI, ATC, forma, dosagem, embalagem).
 *
 * Mais alta que `LIMIAR_PERSISTENCIA` porque o custo do erro é outro. Uma
 * categoria errada põe o produto na prateleira errada e vê-se; um ATC
 * errado é sete caracteres plausíveis que ninguém confere e que passam a
 * alimentar o mapper de subcategorias — um erro que se propaga em vez de
 * ficar parado.
 */
export const LIMIAR_CLINICO = 0.9;

/**
 * Forma canónica de um código ATC completo: N02BE01.
 *
 *   1 letra   grupo anatómico (as 14 letras que a OMS usa — I, K, O, ...
 *             não existem, e aceitá-las deixaria passar erros de OCR)
 *   2 dígitos grupo terapêutico
 *   2 letras  subgrupo farmacológico e químico
 *   2 dígitos substância
 *
 * Só o código completo é aceite. Um ATC truncado ("N02", "N02BE") é
 * verdadeiro mas não identifica a substância, e guardá-lo num campo que
 * a jusante é lido como identificação faria passar por facto o que é
 * meia-resposta.
 */
// A gramática dos campos clínicos vive em `clinica-validacao.ts`:
// o catálogo global valida o MESMO ATC com a MESMA regra, e esse
// módulo é puro — importá-lo de cá arrastava o SDK do Anthropic
// para dentro do control plane.
export { ATC_COMPLETO, DCI_PLAUSIVEL } from "./clinica-validacao";
import { ATC_COMPLETO, DCI_PLAUSIVEL } from "./clinica-validacao";
import { construirVocabularioFormas, ehFormaCanonica, normalizarForma } from "./formas-farmaceuticas";
import { contradicaoForte, ehBalde } from "./classificacao-coerencia";

/**
 * Produtos por chamada. 25 mantém o pedido pequeno o suficiente para o
 * modelo não perder linhas no fim do lote, e amortiza o prefixo da
 * taxonomia por 25 em vez de por 1.
 */
export const TAMANHO_LOTE = 25;

// ─── Contrato de saída ────────────────────────────────────────────────

/** De onde veio a decisão. Serve para auditar sem reler o rationale. */
export type EvidenceType =
  /** Marca/produto reconhecido (Ozempic, Eliquis, Vibrocil). */
  | "MARCA_CONHECIDA"
  /** Substância activa reconhecida a partir do nome comercial. */
  | "SUBSTANCIA_CONHECIDA"
  /** Categoria de produto evidente (não é marca nem substância). */
  | "CATEGORIA_PRODUTO"
  /** Sem reconhecimento — não classificar. */
  | "DESCONHECIDO"
  /**
   * Forma farmacêutica lida da designação, no pedido `FORMA`.
   *
   * NÃO entra em `EVIDENCIA_PERMITIDA`, e é deliberado: este valor nunca
   * pode autorizar a escrita de uma categoria. Serve ao gate para saber
   * que o resultado veio do pedido estreito — e impede que uma proposta
   * de classificação entre no caminho da forma disfarçada de forma.
   */
  | "FORMA_DEDUZIDA";

/**
 * As evidencias que o pedido de CLASSIFICACAO pode devolver.
 *
 * `FORMA_DEDUZIDA` esta' de fora de proposito: nao e' um valor que o
 * classificador possa emitir, e um resultado que o trouxesse seria uma
 * resposta do pedido errado. Fica `DESCONHECIDO`, e o gate recusa.
 */
const EVIDENCIAS_DO_CLASSIFICADOR: readonly EvidenceType[] = [
  "MARCA_CONHECIDA",
  "SUBSTANCIA_CONHECIDA",
  "CATEGORIA_PRODUTO",
  "DESCONHECIDO",
];

export type KnowledgeResult = {
  cnp: number;
  productType: ProductType | null;
  categoria: string | null;
  subcategoria: string | null;
  /** Forma farmacêutica normalizada, quando dedutível. */
  forma: string | null;
  /** Denominação Comum Internacional da substância activa. ke-2.0. */
  dci: string | null;
  /** Código ATC completo (7 caracteres), validado por `ATC_COMPLETO`. */
  codigoATC: string | null;
  /** Dosagem tal como identificada ("500 mg", "0,25 mg/ml"). */
  dosagem: string | null;
  /** Apresentação/embalagem ("30 comprimidos", "frasco 200 ml"). */
  embalagem: string | null;
  utilizacoes: string[];
  confidence: number;
  /**
   * Confiança NOS CAMPOS CLÍNICOS, independente de `confidence`.
   *
   * Existe separada porque as duas perguntas são mesmo diferentes: o
   * modelo pode saber com certeza que o Ozempic é um antidiabético
   * (categoria segura) e não ter a certeza se o ATC é A10BJ06 ou
   * A10BJ02. Uma só confiança obrigaria a escolher entre perder a
   * categoria ou aceitar o ATC de má qualidade.
   */
  confidenceClinica: number;
  evidenceType: EvidenceType;
  rationale: string;
  /**
   * O par que o modelo REALMENTE devolveu, antes da validacao.
   *
   * `categoria`/`subcategoria` acima so' sobrevivem em par valido; um par
   * fora da taxonomia era anulado e nao deixava rasto, o que tornava
   * indistinguivel "o modelo nao respondeu" de "o modelo respondeu e a
   * nossa taxonomia nao tem onde por". Estes dois campos guardam a
   * resposta tal como veio — e NUNCA sao escritos em `Produto`.
   */
  categoriaBruta: string | null;
  subcategoriaBruta: string | null;
  /** Porque e' que o par nao sobreviveu, quando nao sobreviveu. */
  motivoPar: string | null;
  /** Que pergunta deu origem a este resultado. */
  alvo?: AlvoPedido;
  /**
   * SÓ em pedidos de utilizações: o nível 1 em que o modelo acha que o
   * produto pertence.
   *
   * NUNCA é escrito. Existe para detectar discordância forte num produto
   * já classificado — "isto é MEDICAMENTOS, não DERMOCOSMÉTICA" — e
   * levantar um candidato a auditoria. Nível 1 e não nível 2 de propósito:
   * uma divergência de nível 2 é quase sempre uma questão de arrumação da
   * nossa taxonomia; uma de nível 1 é o produto estar na secção errada da
   * loja.
   */
  sugestaoCategoria?: string | null;
};

export type ProdutoResidual = {
  cnp: number;
  designacao: string;
  /** O que a fase determinística já tinha decidido (pode ser null). */
  productType: string | null;
  categoriaAtual: string | null;
  subcategoriaAtual: string | null;
  /**
   * `Produto.formaFarmaceutica`. Opcional para não partir os chamadores
   * antigos: ausente lê-se como «não sei», e `alvoParaProduto` só escolhe
   * FORMA quando a ausência é FACTO — o campo presente e nulo.
   */
  formaAtual?: string | null;
};

// ─── Esquema para structured outputs ──────────────────────────────────

const PRODUCT_TYPES: ProductType[] = [
  "MEDICAMENTO", "SUPLEMENTO", "DERMOCOSMETICA", "DISPOSITIVO_MEDICO",
  "HIGIENE_CUIDADO", "ORTOPEDIA", "PUERICULTURA", "VETERINARIA", "OUTRO",
];

const SCHEMA = {
  type: "object",
  properties: {
    resultados: {
      type: "array",
      items: {
        type: "object",
        properties: {
          cnp: { type: "integer", description: "O cnp exacto do produto de entrada." },
          productType: { type: "string", enum: [...PRODUCT_TYPES] },
          categoria: { type: "string", description: "Nível 1 da taxonomia, exacto. Vazio se não souber." },
          subcategoria: { type: "string", description: "Nível 2 da taxonomia, exacto e filho da categoria. Vazio se não souber." },
          forma: { type: "string", description: "Forma farmacêutica se dedutível (comprimido, xarope, colírio, ...). Vazio se não aplicável." },
          dci: { type: "string", description: "Denominação Comum Internacional da substância activa, sem dosagem nem marca (ex.: \"Paracetamol\", \"Insulina glargina\"). Vazio se não for medicamento ou não souberes." },
          codigoATC: { type: "string", description: "Código ATC COMPLETO de 7 caracteres (ex.: N02BE01). Vazio se não souberes o código completo — um ATC truncado como \"N02\" é rejeitado pelo sistema." },
          dosagem: { type: "string", description: "Dosagem tal como consta da designação (ex.: \"500 mg\", \"0,25 mg/ml\"). Vazio se não constar." },
          embalagem: { type: "string", description: "Apresentação/embalagem (ex.: \"30 comprimidos\", \"frasco 200 ml\"). Vazio se não constar." },
          confidenceClinica: { type: "number", description: "0 a 1. Confiança APENAS em dci/codigoATC/dosagem/embalagem — independente de confidence." },
          utilizacoes: {
            type: "array",
            items: { type: "string" },
            description: "Slugs do vocabulário de utilizações. Lista vazia se nenhuma for segura.",
          },
          confidence: { type: "number", description: "0 a 1. Confiança em categoria+subcategoria." },
          evidenceType: {
            type: "string",
            enum: ["MARCA_CONHECIDA", "SUBSTANCIA_CONHECIDA", "CATEGORIA_PRODUTO", "DESCONHECIDO"],
          },
          rationale: { type: "string", description: "Uma frase: o que reconheceste e porquê." },
        },
        required: [
          "cnp", "productType", "categoria", "subcategoria", "forma",
          "dci", "codigoATC", "dosagem", "embalagem", "confidenceClinica",
          "utilizacoes", "confidence", "evidenceType", "rationale",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["resultados"],
  additionalProperties: false,
} as const;

// ─── Alvo do pedido ───────────────────────────────────────────────────

/**
 * O que se pede ao modelo para um produto — e, por consequência, o que o
 * gate pode sequer aplicar.
 *
 * O canary real expôs o desperdício: dos 100 produtos, 35 saíram em SKIP,
 * e ~30 desses eram do estrato SEM_UTILIZACOES — produtos com uma
 * subcategoria ESPECÍFICA a que só faltavam utilizações. A esses pedia-se
 * uma classificação completa, pagava-se a verificação em duas passagens,
 * e no fim o gate devolvia "já tem subcategoria específica — intocável" e
 * não escrevia nada. Nem sequer as utilizações, que eram a única coisa
 * que faltava e a única que o gate teria autorizado.
 *
 * Não era um gate mal calibrado: a não-degradação está certa. Era estar a
 * fazer ao modelo a pergunta errada — uma cuja resposta nunca poderia ser
 * usada.
 */
export type AlvoPedido =
  /** Sem classificação ou em "Outros <X>": classificação + utilizações. */
  | "CLASSIFICACAO"
  /** Já tem N2 específica: só utilizações. A classificação não se toca. */
  | "UTILIZACOES"
  /**
   * Já tem N2 específica e NÃO tem forma: só a forma farmacêutica.
   *
   * O mesmo raciocínio que criou o alvo UTILIZACOES, aplicado ao campo
   * que sobrou. A auditoria de 2026-09-03 mediu-o: no backlog que cobre
   * 95% das unidades vendidas, 1 169 de 1 776 produtos têm categoria e
   * subcategoria decididas e falta-lhes só a forma. A esses pedia-se —
   * até aqui — utilizações, num esquema que nem sequer tem campo
   * `forma`: a resposta certa era impossível de dar.
   */
  | "FORMA";

/**
 * Deriva o alvo do ESTADO DO PRODUTO, não do estrato da consulta.
 *
 * É a mesma condição que o gate usa para a não-degradação (`eraFallback`).
 * Derivar do estado — e não de um rótulo passado ao lado — é o que
 * impede o alvo e o gate de discordarem: se discordassem, voltaríamos a
 * pedir o que não se pode aplicar.
 */
export function alvoParaProduto(atual: {
  subcategoria: string | null;
  /** Ausente = desconhecido, e o alvo não muda. Presente e nulo = falta. */
  forma?: string | null;
}): AlvoPedido {
  const especifica = !!atual.subcategoria && !ehBalde(atual.subcategoria);
  if (!especifica) return "CLASSIFICACAO";
  // A forma vem antes das utilizações porque é o campo que fecha a
  // definição de completo (categoria + subcategoria + forma). Um produto
  // a que faltem as duas coisas apanha a forma nesta corrida e as
  // utilizações na seguinte — assim que a forma estiver escrita, este
  // ramo deixa de disparar. Duas corridas, nenhuma pergunta desperdiçada.
  //
  // `"forma" in atual` e não `!atual.forma`: um chamador que não sabe da
  // forma não pode ser tratado como um produto que não a tem. O primeiro
  // continua a ir para UTILIZACOES, exactamente como antes.
  const faltaForma = "forma" in atual && !atual.forma;
  return faltaForma ? "FORMA" : "UTILIZACOES";
}

// ─── Prompt ───────────────────────────────────────────────────────────

/**
 * O prefixo estável: taxonomia + vocabulário de utilizações. Idêntico em
 * todos os pedidos, por isso vai atrás de um `cache_control` — é a
 * diferença entre pagar a taxonomia uma vez ou uma vez por lote.
 */
function construirVocabulario(): string {
  const taxonomia = CANONICAL_TAXONOMY.map(
    (c) => `${c.nivel1}\n${c.nivel2.map((n) => `  - ${n}`).join("\n")}`,
  ).join("\n\n");

  const utilizacoes = UTILIZACOES.filter((u) => !u.descontinuada)
    .map((u) => `  ${u.slug} — ${u.nome}: ${u.descricao}`)
    .join("\n");

  return `# TAXONOMIA CANÓNICA (categoria → subcategorias)\n\n${taxonomia}\n\n# VOCABULÁRIO DE UTILIZAÇÕES (slug — nome: descrição)\n\n${utilizacoes}`;
}

const SISTEMA = `És um farmacêutico a organizar o catálogo de uma farmácia portuguesa para quem atende ao balcão encontrar o que tem na loja.

Recebes produtos que as regras automáticas não conseguiram classificar, porque a designação traz a marca e a dosagem mas não diz o que o produto é. O teu trabalho é usar o que sabes sobre esses produtos e marcas.

REGRAS

1. Usa EXCLUSIVAMENTE a taxonomia e o vocabulário de utilizações dados. Nomes exactos, incluindo acentos. Uma subcategoria tem de ser filha da categoria que indicas. Qualquer valor fora das listas é descartado pelo sistema — não é corrigido, é deitado fora, e o produto fica por classificar.

2. Se não reconheces o produto, diz que não reconheces: evidenceType "DESCONHECIDO", categoria e subcategoria vazias, confidence baixa. Um produto sem classificação é um resultado aceitável e esperado. Uma classificação inventada é um erro que alguém ao balcão vai pagar.

3. confidence é a tua confiança em categoria+subcategoria:
   · 0.95+ — reconheces o produto e sabes exactamente o que é (Ozempic é semaglutido, antidiabético).
   · 0.85–0.94 — reconheces a marca ou a gama e a categoria é clara.
   · 0.60–0.84 — deduzes pela forma ou por parte do nome, mas podias estar errado.
   · <0.60 — palpite. Diz DESCONHECIDO.
   Abaixo de 0.85 nada é gravado. Não inflaciones para o resultado passar: um produto por classificar custa menos que um mal classificado.

4. Utilizações só quando o produto serve mesmo para isso e o operador o procuraria assim. Um antidiabético leva "diabetes". Um antipsicótico não leva nada — o vocabulário não tem termo para isso, e não há nada a forçar. Lista vazia é comum e correcta.

5. Preferir a subcategoria específica à genérica "Outros <X>". Se só sabes o nível 1, devolve "Outros <X>" — continua a ser melhor que nada. Se nem isso, deixa vazio.

6. Um medicamento veterinário é VETERINARIA, não MEDICAMENTO. Um suplemento em cápsulas é SUPLEMENTO, não MEDICAMENTO.

7. CAMPOS CLÍNICOS (dci, codigoATC, dosagem, embalagem). Só para medicamentos. Para tudo o resto deixa-os vazios — um champô não tem DCI e inventar-lhe uma é pior que deixar em branco.

   · dci: a substância activa pelo nome comum internacional, sem marca e sem dosagem. "Paracetamol", não "Ben-u-ron 500". Se o produto tem várias substâncias, lista-as separadas por " + ".
   · codigoATC: o código COMPLETO de 7 caracteres, como N02BE01. Se só tens a certeza do grupo ("é um analgésico, portanto N02"), deixa VAZIO — o sistema rejeita códigos truncados e um código parcial não identifica a substância. Não construas o código a partir da categoria: ou o sabes de cor para esta substância, ou não o sabes.
   · dosagem e embalagem: copia o que está na designação, não deduzas. Se a designação diz "500 Mg X 20", dosagem="500 mg" e embalagem="20 comprimidos" só se o "X 20" for mesmo a contagem. Na dúvida, vazio.

8. confidenceClinica é SEPARADA de confidence e mede só os campos do ponto 7:
   · 0.95+ — sabes a substância e o ATC de cor (Paracetamol N02BE01, Omeprazol A02BC01).
   · 0.90–0.94 — sabes a substância com certeza; o ATC confirmaste-o mentalmente.
   · <0.90 — não tens a certeza do ATC. Devolve dci se a souberes e deixa codigoATC vazio; põe confidenceClinica baixa.
   Abaixo de 0.90 nenhum campo clínico é gravado. Um ATC errado propaga-se: alimenta o mapper de subcategorias e passa a estar em dois sítios em vez de um.

   Preencher dci e deixar codigoATC vazio é uma resposta boa e frequente. As duas coisas não têm de vir juntas.

Devolves um resultado por produto de entrada, com o cnp exacto que recebeste.`;

// ─── Pedido só de utilizações ─────────────────────────────────────────

/**
 * Esquema reduzido. Sem productType, sem forma, sem subcategoria: nada
 * disso seria escrito para um produto já classificado, e cada campo que
 * não se pede é output que não se paga.
 */
const SCHEMA_UTILIZACOES = {
  type: "object",
  properties: {
    resultados: {
      type: "array",
      items: {
        type: "object",
        properties: {
          cnp: { type: "integer", description: "O cnp exacto do produto de entrada." },
          utilizacoes: {
            type: "array",
            items: { type: "string" },
            description: "Slugs do vocabulário. Lista vazia se nenhuma for segura.",
          },
          confidence: { type: "number", description: "0 a 1. Confiança nas utilizações." },
          evidenceType: {
            type: "string",
            enum: ["MARCA_CONHECIDA", "SUBSTANCIA_CONHECIDA", "CATEGORIA_PRODUTO", "DESCONHECIDO"],
          },
          categoriaProvavel: {
            type: "string",
            description:
              "Nível 1 onde ESTE produto pertence, na tua opinião. Repete a categoria actual se concordas. Vazio se não reconheces o produto.",
          },
          rationale: { type: "string", description: "Uma frase: o que reconheceste." },
        },
        required: ["cnp", "utilizacoes", "confidence", "evidenceType", "categoriaProvavel", "rationale"],
        additionalProperties: false,
      },
    },
  },
  required: ["resultados"],
  additionalProperties: false,
} as const;

/**
 * Vocabulário reduzido: utilizações + a lista de níveis 1 (26 nomes).
 *
 * A taxonomia completa — 26 níveis 1 com todos os filhos — não entra aqui
 * porque não há subcategoria a escolher. Fica a lista de níveis 1 só para
 * o `categoriaProvavel` poder ser comparado com o que temos.
 */
function construirVocabularioUtilizacoes(): string {
  const niveis1 = CANONICAL_TAXONOMY.map((c) => `  - ${c.nivel1}`).join("\n");
  const utilizacoes = UTILIZACOES.filter((u) => !u.descontinuada)
    .map((u) => `  ${u.slug} — ${u.nome}: ${u.descricao}`)
    .join("\n");
  return `# CATEGORIAS (nível 1)\n\n${niveis1}\n\n# VOCABULÁRIO DE UTILIZAÇÕES (slug — nome: descrição)\n\n${utilizacoes}`;
}

const SISTEMA_UTILIZACOES = `És um farmacêutico a etiquetar produtos do catálogo de uma farmácia portuguesa com AQUILO PARA QUE SERVEM, para quem atende encontrar o que precisa.

Estes produtos JÁ ESTÃO CLASSIFICADOS e a classificação NÃO se altera. Recebes a categoria e a subcategoria actuais como contexto — usa-as, não as questiones por rotina.

REGRAS

1. Devolve apenas utilizações do vocabulário dado, com o slug exacto. Um slug que não exista é descartado pelo sistema.

2. Utilizações só quando o produto serve mesmo para isso e alguém o procuraria assim. Lista vazia é comum e correcta: muitos produtos não têm no vocabulário um termo que lhes assente, e forçar um é pior que não pôr nenhum.

3. confidence é a tua confiança NAS UTILIZAÇÕES que indicas. Abaixo de 0.85 nada é gravado. Não inflaciones: uma utilização errada manda alguém à prateleira errada com um problema de saúde.

4. categoriaProvavel: o nível 1 onde ESTE produto pertence, na tua opinião. Se concordas com a categoria actual, repete-a. Só a indica diferente se tiveres a certeza de que o produto está na secção errada — isso levanta uma revisão humana, não altera nada automaticamente.

5. Se não reconheces o produto: evidenceType "DESCONHECIDO", lista de utilizações vazia. É uma resposta aceite.

Devolves um resultado por produto, com o cnp exacto que recebeste.`;

function construirLoteUtilizacoes(produtos: ProdutoResidual[]): string {
  const linhas = produtos.map((p) => {
    const partes = [`cnp=${p.cnp}`, `designacao=${JSON.stringify(p.designacao)}`];
    if (p.categoriaAtual) partes.push(`categoria=${JSON.stringify(p.categoriaAtual)}`);
    if (p.subcategoriaAtual) partes.push(`subcategoria=${JSON.stringify(p.subcategoriaAtual)}`);
    return `- ${partes.join(" ")}`;
  });
  return `Que utilizações servem estes ${produtos.length} produtos?\n\n${linhas.join("\n")}`;
}

const NIVEIS1_CANONICOS: ReadonlySet<string> = new Set(CANONICAL_TAXONOMY.map((c) => c.nivel1));

/**
 * Valida um resultado de pedido de utilizações.
 *
 * `categoria`/`subcategoria` ficam SEMPRE null: este pedido não propõe
 * classificação nenhuma, e deixá-las nulas é o que garante que nem por
 * engano o gate as poderia escrever.
 */
export function validarResultadoUtilizacoes(
  cru: unknown,
  cnpsEsperados: ReadonlySet<number>,
): KnowledgeResult | null {
  if (!cru || typeof cru !== "object") return null;
  const r = cru as Record<string, unknown>;

  const cnp = typeof r.cnp === "number" ? r.cnp : Number(r.cnp);
  if (!Number.isFinite(cnp) || !cnpsEsperados.has(cnp)) return null;

  const confidence = typeof r.confidence === "number" ? r.confidence : 0;
  const evidenceType = EVIDENCIAS_DO_CLASSIFICADOR.includes(r.evidenceType as EvidenceType)
    ? (r.evidenceType as EvidenceType)
    : "DESCONHECIDO";

  const utilizacoes = Array.isArray(r.utilizacoes)
    ? [...new Set(
        r.utilizacoes
          .filter((u): u is string => typeof u === "string")
          .map((u) => u.trim())
          .filter((u) => UTILIZACOES_POR_SLUG.has(u)),
      )]
    : [];

  const bruta = typeof r.categoriaProvavel === "string" ? r.categoriaProvavel.trim() : "";
  const sugestaoCategoria = bruta && NIVEIS1_CANONICOS.has(bruta) ? bruta : null;

  return {
    cnp,
    productType: null,
    categoria: null,
    subcategoria: null,
    forma: null,
    // O pedido de utilizações não pergunta nada de clínico e o esquema
    // reduzido nem sequer tem estes campos. Ficam null para que este
    // caminho não possa escrever um ATC por acidente.
    dci: null,
    codigoATC: null,
    dosagem: null,
    embalagem: null,
    utilizacoes,
    confidence: Math.max(0, Math.min(1, confidence)),
    confidenceClinica: 0,
    evidenceType,
    rationale: typeof r.rationale === "string" ? r.rationale.trim().slice(0, 400) : "",
    // O pedido de utilizacoes nao propoe par nenhum. `sugestaoCategoria`
    // e' outra coisa: um nivel 1 para detectar discordancia, nunca um
    // candidato a escrita.
    categoriaBruta: null,
    subcategoriaBruta: null,
    motivoPar: null,
    alvo: "UTILIZACOES",
    sugestaoCategoria,
  };
}

function construirLote(produtos: ProdutoResidual[]): string {
  const linhas = produtos.map((p) => {
    const partes = [`cnp=${p.cnp}`, `designacao=${JSON.stringify(p.designacao)}`];
    if (p.productType) partes.push(`tipoJaConhecido=${p.productType}`);
    if (p.categoriaAtual) partes.push(`categoriaAtual=${JSON.stringify(p.categoriaAtual)}`);
    if (p.subcategoriaAtual) partes.push(`subcategoriaAtual=${JSON.stringify(p.subcategoriaAtual)}`);
    return `- ${partes.join(" ")}`;
  });
  return `Classifica estes ${produtos.length} produtos:\n\n${linhas.join("\n")}`;
}

// ─── Validação — a camada que impede a invenção ───────────────────────

/**
 * Filtra um resultado cru contra os vocabulários fechados.
 *
 * Rejeita em silêncio em vez de corrigir. Se o modelo devolve
 * "MEDICAMENTOS > Antibióticos" — que não existe na taxonomia — o campo
 * fica null e o produto continua por classificar. Corrigir para o vizinho
 * mais parecido seria inventar com passos extra.
 */
export function validarResultado(
  cru: unknown,
  cnpsEsperados: ReadonlySet<number>,
): KnowledgeResult | null {
  if (!cru || typeof cru !== "object") return null;
  const r = cru as Record<string, unknown>;

  const cnp = typeof r.cnp === "number" ? r.cnp : Number(r.cnp);
  // Um cnp que não estava no lote é uma linha alucinada — não há produto
  // nenhum para lá associar.
  if (!Number.isFinite(cnp) || !cnpsEsperados.has(cnp)) return null;

  const confidence = typeof r.confidence === "number" ? r.confidence : 0;
  const evidenceType = EVIDENCIAS_DO_CLASSIFICADOR.includes(r.evidenceType as EvidenceType)
    ? (r.evidenceType as EvidenceType)
    : "DESCONHECIDO";

  const productType = PRODUCT_TYPES.includes(r.productType as ProductType)
    ? (r.productType as ProductType)
    : null;

  // Categoria e subcategoria só sobrevivem em par válido. Uma categoria
  // sem subcategoria filha não serve para nada a jusante.
  //
  // O que MUDOU: o par cru sobrevive sempre, em `categoriaBruta`/
  // `subcategoriaBruta`, e a razão da recusa fica escrita. Continua a não
  // ser corrigido nem aproximado — a disciplina de rejeitar em vez de
  // inventar mantém-se intacta. O que deixa de acontecer é a resposta
  // desaparecer: era informação já paga a virar `null` sem rasto, e sem
  // ela não se consegue distinguir um modelo que falhou de uma taxonomia
  // que não tem onde pôr o produto.
  let categoria: string | null = null;
  let subcategoria: string | null = null;
  let motivoPar: string | null = null;
  const cat = typeof r.categoria === "string" ? r.categoria.trim() : "";
  const sub = typeof r.subcategoria === "string" ? r.subcategoria.trim() : "";
  if (cat && sub && isValidNivel2(cat, sub)) {
    categoria = cat;
    subcategoria = sub;
  } else if (cat || sub) {
    motivoPar = !cat
      ? `par incompleto: subcategoria "${sub}" sem categoria`
      : !sub
      ? `par incompleto: categoria "${cat}" sem subcategoria`
      : `par fora da taxonomia: "${cat}" > "${sub}"`;
  }

  const utilizacoes = Array.isArray(r.utilizacoes)
    ? [...new Set(
        r.utilizacoes
          .filter((u): u is string => typeof u === "string")
          .map((u) => u.trim())
          .filter((u) => UTILIZACOES_POR_SLUG.has(u)),
      )]
    : [];

  const forma = typeof r.forma === "string" && r.forma.trim() ? r.forma.trim().slice(0, 120) : null;
  const rationale = typeof r.rationale === "string" ? r.rationale.trim().slice(0, 400) : "";

  // ── Campos clínicos (ke-2.0) ────────────────────────────────────────
  //
  // Mesma disciplina do resto do ficheiro: rejeitar em silêncio, nunca
  // corrigir. Um ATC com 5 caracteres não é encurtado nem completado —
  // é deitado fora. Completá-lo seria inventar dois dígitos.
  const texto = (v: unknown, max: number): string | null => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t ? t.slice(0, max) : null;
  };

  // Validar ANTES de truncar, e nao depois.
  //
  // Com o `slice(80)` a correr primeiro, uma frase de 86 caracteres
  // ("nao sei ao certo, possivelmente paracetamol ou ...") ficava com 80
  // e passava a regex — a truncagem transformava uma nao-resposta em
  // algo com forma de denominacao. E exactamente o "corrigir em vez de
  // rejeitar" que o resto deste ficheiro proibe. Uma DCI a mais de 80
  // caracteres nao e uma DCI comprida: e outra coisa qualquer.
  const dciBruta = typeof r.dci === "string" ? r.dci.trim() : "";
  const dci = dciBruta && DCI_PLAUSIVEL.test(dciBruta) ? dciBruta : null;

  const atcBruto = texto(r.codigoATC, 16)?.toUpperCase().replace(/\s+/g, "") ?? null;
  const codigoATC = atcBruto && ATC_COMPLETO.test(atcBruto) ? atcBruto : null;

  const dosagem = texto(r.dosagem, 60);
  const embalagem = texto(r.embalagem, 60);

  const confClinicaBruta =
    typeof r.confidenceClinica === "number" ? r.confidenceClinica : 0;

  return {
    cnp,
    productType,
    categoria,
    subcategoria,
    forma,
    dci,
    codigoATC,
    dosagem,
    embalagem,
    utilizacoes,
    confidence: Math.max(0, Math.min(1, confidence)),
    confidenceClinica: Math.max(0, Math.min(1, confClinicaBruta)),
    evidenceType,
    rationale,
    categoriaBruta: cat || null,
    subcategoriaBruta: sub || null,
    motivoPar,
  };
}

// ─── Chamada ──────────────────────────────────────────────────────────

export type LoteResposta = {
  resultados: KnowledgeResult[];
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
};

let clienteCache: Anthropic | null = null;
function cliente(): Anthropic {
  // A credencial vem de ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN ou de um
  // perfil `ant auth login` — não forçamos uma dessas vias.
  //
  // `maxRetries: 0` é deliberado: a política de retentativa é nossa
  // (`comRetentativa` + `deveRepetir`), para ser explícita e testável em
  // vez de herdada de um default do SDK que pode mudar por baixo de nós.
  if (!clienteCache) {
    clienteCache = new Anthropic({ timeout: TIMEOUT_MS, maxRetries: 0 });
  }
  return clienteCache;
}

/**
 * Extrai e valida os resultados de uma resposta. Partilhado pelos dois
 * tipos de pedido — a diferença entre eles é o prompt e o esquema, não a
 * forma de ler o que volta.
 */
function lerResultados(
  resposta: Anthropic.Message,
  esperados: ReadonlySet<number>,
  validar: (cru: unknown, esperados: ReadonlySet<number>) => KnowledgeResult | null,
): KnowledgeResult[] {
  // Uma recusa devolve HTTP 200 com content vazio ou parcial. Ler
  // content[0] às cegas rebentava aqui.
  if (resposta.stop_reason === "refusal") return [];

  const texto = resposta.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  if (!texto.trim()) return [];

  let cru: unknown;
  try {
    cru = JSON.parse(texto);
  } catch {
    // Truncagem por max_tokens ou saída malformada: perde-se o lote, não
    // a corrida. Quem chama volta a tentar com lote menor.
    return [];
  }

  const lista = (cru as { resultados?: unknown[] })?.resultados;
  if (!Array.isArray(lista)) return [];

  const vistos = new Set<number>();
  const out: KnowledgeResult[] = [];
  for (const item of lista) {
    const v = validar(item, esperados);
    // Uma segunda linha para o mesmo cnp é ruído; fica a primeira.
    if (v && !vistos.has(v.cnp)) {
      vistos.add(v.cnp);
      out.push(v);
    }
  }
  return out;
}

function usageDe(resposta: Anthropic.Message): LoteResposta["usage"] {
  return {
    inputTokens: resposta.usage.input_tokens ?? 0,
    outputTokens: resposta.usage.output_tokens ?? 0,
    cacheReadTokens: resposta.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: resposta.usage.cache_creation_input_tokens ?? 0,
  };
}

/**
 * Pede SÓ utilizações, para produtos que já têm classificação específica.
 *
 * Prompt mais curto, vocabulário sem a taxonomia completa e esquema com
 * 6 campos em vez de 9 — o output por produto é uma fracção do outro
 * pedido, e é o output que domina a factura.
 *
 * O prefixo cacheado é DIFERENTE do de `classificarLote`, portanto os
 * lotes têm de ir agrupados por tipo de pedido: alternar entre os dois
 * paga a escrita de cache de cada vez. O runner agrupa por estrato, que é
 * o que garante isso.
 */
export async function classificarUtilizacoesLote(
  produtos: ProdutoResidual[],
  opts: { model?: string; effort?: "low" | "medium" | "high"; sistema?: string } = {},
): Promise<LoteResposta> {
  if (produtos.length === 0) {
    return { resultados: [], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  }
  const modelo = opts.model ? resolverModelo(opts.model) : KNOWLEDGE_MODEL;

  const resposta = await comRetentativa(() => cliente().messages.create({
    model: modelo,
    // Bem menos que os 16000 do outro pedido: 6 campos por produto, sem
    // rationale longo. Um tecto folgado ainda assim, para não truncar.
    max_tokens: 8000,
    system: [
      { type: "text", text: opts.sistema ?? SISTEMA_UTILIZACOES },
      { type: "text", text: construirVocabularioUtilizacoes(), cache_control: { type: "ephemeral" } },
    ],
    output_config: {
      effort: opts.effort ?? "medium",
      format: { type: "json_schema", schema: SCHEMA_UTILIZACOES as unknown as Record<string, unknown> },
    },
    messages: [{ role: "user", content: construirLoteUtilizacoes(produtos) }],
  }));

  return {
    resultados: lerResultados(resposta, new Set(produtos.map((p) => p.cnp)), validarResultadoUtilizacoes),
    usage: usageDe(resposta),
  };
}

/**
 * Segunda passagem de um pedido de utilizações. Mesmo esquema reduzido,
 * enquadramento invertido — identificar o produto antes de etiquetar.
 */
export async function verificarUtilizacoesLote(
  produtos: ProdutoResidual[],
  opts: { model?: string; effort?: "low" | "medium" | "high" } = {},
): Promise<LoteResposta> {
  return classificarUtilizacoesLote(produtos, { ...opts, sistema: SISTEMA_VERIFICADOR_UTILIZACOES });
}

/**
 * Classifica um lote. Devolve só resultados que passaram a validação —
 * um lote pode devolver menos linhas do que entrou, e isso é normal.
 *
 * Não persiste nada e não decide nada sobre gravação: essa decisão é de
 * quem chama, com `LIMIAR_PERSISTENCIA` e as guardas de não-degradação.
 */
export async function classificarLote(
  produtos: ProdutoResidual[],
  opts: { model?: string; effort?: "low" | "medium" | "high"; sistema?: string } = {},
): Promise<LoteResposta> {
  if (produtos.length === 0) {
    return { resultados: [], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  }

  // Um `model` passado à mão passa pela mesma validação — a proibição de
  // aliases móveis não tem porta das traseiras.
  const modelo = opts.model ? resolverModelo(opts.model) : KNOWLEDGE_MODEL;

  const resposta = await comRetentativa(() => cliente().messages.create({
    model: modelo,
    max_tokens: 16000,
    // A taxonomia é o último bloco do system e é idêntica em todos os
    // pedidos: o breakpoint fica aqui, e o lote (volátil) fica depois,
    // nas messages. Trocar a ordem torna a cache inútil.
    system: [
      { type: "text", text: opts.sistema ?? SISTEMA },
      { type: "text", text: construirVocabulario(), cache_control: { type: "ephemeral" } },
    ],
    output_config: {
      effort: opts.effort ?? "medium",
      format: { type: "json_schema", schema: SCHEMA as unknown as Record<string, unknown> },
    },
    messages: [{ role: "user", content: construirLote(produtos) }],
  }));

  const esperados = new Set(produtos.map((p) => p.cnp));
  const resultados = lerResultados(resposta, esperados, validarResultado).map(
    (r): KnowledgeResult => ({ ...r, alvo: "CLASSIFICACAO" }),
  );
  return { resultados, usage: usageDe(resposta) };
}

// ─── Pedido só de FORMA ───────────────────────────────────────────────

/**
 * Produtos por chamada no pedido de forma. 50 e não 25: a resposta por
 * produto são três campos — cnp, forma, confiança — contra os catorze do
 * pedido completo, e o prefixo é uma lista de 66 linhas em vez da
 * taxonomia inteira. O lote maior amortiza melhor o que resta.
 */
export const TAMANHO_LOTE_FORMA = 50;

/**
 * O prompt mínimo.
 *
 * O que NÃO está aqui é o ponto: sem taxonomia de categorias, sem
 * vocabulário de utilizações, sem DCI, sem ATC, sem dosagem, sem
 * embalagem, sem rationale. A pergunta é uma só, e cada bloco que não se
 * envia é input que não se paga e uma resposta que não se pode inventar.
 */
const SISTEMA_FORMA = `És um farmacêutico a normalizar formas farmacêuticas no catálogo de uma farmácia portuguesa.

Para cada produto recebes o cnp e a designação como está no ERP. Devolves a forma farmacêutica, escolhida EXCLUSIVAMENTE da lista fechada que te é dada.

REGRAS

1. Copia o valor exacto da lista, com acentos. Qualquer coisa fora da lista é descartada pelo sistema — não é corrigida, é deitada fora.

2. Se a designação não permitir determinar a forma com segurança, devolve forma vazia e confidence baixa. Um produto sem forma é um resultado aceitável e esperado; uma forma errada fica gravada como facto e ninguém a volta a rever.

3. Lê a designação, não adivinhes pelo produto. "BEN-U-RON 500 MG X 20" diz comprimido? Só se a designação o disser ou se a abreviatura for inequívoca (COMP, CAPS, XPE, SUSP, POM, CR, SOL). "X 20" é a contagem da embalagem, não a forma.

4. Abreviaturas correntes no ERP português: COMP=comprimido, COMP REV=comprimido revestido, CAPS=cápsula, XPE=xarope, SUSP ORAL=suspensão oral, SOL ORAL=solução oral, SOL INJ=solução injetável, PO INAL=pó para inalação, POM=pomada, CR=creme, SUP=supositório, GTS=gotas orais, COL=colírio.

5. Não é medicamento? Um champô, um creme de rosto ou uma chupeta não têm forma farmacêutica. Devolve vazio — a lista não tem entrada para eles e forçar uma é pior do que deixar em branco.

6. confidence é a tua confiança NESTA forma:
   · 0.95+ — a designação diz a forma, ou a abreviatura é inequívoca.
   · 0.90–0.94 — deduzes da apresentação com segurança.
   · <0.90 — palpite. Devolve vazio.
   Abaixo de 0.90 nada é gravado. Não inflaciones: uma forma por preencher custa menos que uma forma errada.

Devolves um resultado por produto de entrada, com o cnp exacto que recebeste.`;

/**
 * Três campos. `forma` é string (vazia = não sei), e não nullable, porque
 * um `null` em structured output é uma decisão a menos que o modelo tem
 * de tomar — vazio é a mesma resposta com menos maneiras de a dar.
 */
const SCHEMA_FORMA = {
  type: "object",
  properties: {
    resultados: {
      type: "array",
      items: {
        type: "object",
        properties: {
          cnp: { type: "integer", description: "O cnp exacto do produto de entrada." },
          forma: {
            type: "string",
            description: "Valor EXACTO da lista fechada, ou vazio se não for determinável com segurança.",
          },
          confidence: { type: "number", description: "0 a 1. Confiança nesta forma." },
        },
        required: ["cnp", "forma", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["resultados"],
  additionalProperties: false,
} as const;

/** cnp e designação. Mais nada — a classificação actual não é pedida nem enviada. */
function construirLoteForma(produtos: ProdutoResidual[]): string {
  const linhas = produtos.map((p) => `- cnp=${p.cnp} designacao=${JSON.stringify(p.designacao)}`);
  return `Qual e a forma farmaceutica destes ${produtos.length} produtos?\n\n${linhas.join("\n")}`;
}

/**
 * Valida um resultado do pedido de forma.
 *
 * Devolve um `KnowledgeResult` com TUDO o resto a null e `utilizacoes`
 * vazio. Não é preguiça de tipos: é o que garante o requisito de escrever
 * só a forma. O caminho de escrita percorre os campos um a um e salta os
 * nulos — com nada preenchido, não há nada que ele possa gravar por
 * engano, mesmo que um dia mude.
 *
 * A confiança do modelo entra em `confidenceClinica`, que é o gate da
 * forma (0,90), e `confidence` fica a zero: é o gate da classificação, e
 * este pedido não propõe classificação nenhuma.
 */
export function validarResultadoForma(
  cru: unknown,
  cnpsEsperados: ReadonlySet<number>,
): KnowledgeResult | null {
  if (!cru || typeof cru !== "object") return null;
  const r = cru as Record<string, unknown>;

  const cnp = typeof r.cnp === "number" ? r.cnp : Number(r.cnp);
  if (!Number.isFinite(cnp) || !cnpsEsperados.has(cnp)) return null;

  // Fora do vocabulário fechado → null, e null não se escreve. É a mesma
  // política da taxonomia: rejeitar em silêncio em vez de aproximar.
  const forma = normalizarForma(typeof r.forma === "string" ? r.forma : null);
  const confidence = typeof r.confidence === "number" ? r.confidence : 0;

  return {
    cnp,
    productType: null,
    categoria: null,
    subcategoria: null,
    forma,
    dci: null,
    codigoATC: null,
    dosagem: null,
    embalagem: null,
    confidenceClinica: forma ? confidence : 0,
    utilizacoes: [],
    confidence: 0,
    evidenceType: "FORMA_DEDUZIDA",
    // Vazio e nao uma frase: o pedido de forma nao pede rationale, e
    // inventar aqui um texto seria descrever um raciocinio que ninguem fez.
    rationale: "",
    categoriaBruta: null,
    subcategoriaBruta: null,
    motivoPar: null,
    alvo: "FORMA",
  };
}

/**
 * Pede SÓ a forma farmacêutica.
 *
 * Terceiro prefixo cacheado do módulo, e a mesma regra dos outros dois: o
 * runner tem de agrupar os lotes por alvo. Alternar entre pedidos paga a
 * escrita de cache de cada vez, e o prefixo daqui é o mais barato dos
 * três — desperdiçá-lo seria irónico.
 *
 * Sem segunda passagem: quem chama isto não verifica. Uma forma errada
 * não se propaga como um ATC errado — não alimenta mapper nenhum, não
 * decide categoria, e o vocabulário fechado já rejeita o que não existe.
 * O que resta é a confiança, e o gate exige 0,90.
 */
export async function classificarFormaLote(
  produtos: ProdutoResidual[],
  opts: { model?: string; effort?: "low" | "medium" | "high" } = {},
): Promise<LoteResposta> {
  if (produtos.length === 0) {
    return { resultados: [], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  }
  const modelo = opts.model ? resolverModelo(opts.model) : KNOWLEDGE_MODEL;

  const resposta = await comRetentativa(() => cliente().messages.create({
    model: modelo,
    // Três campos por produto, 50 produtos. 4000 é folgado.
    max_tokens: 4000,
    system: [
      { type: "text", text: SISTEMA_FORMA },
      {
        type: "text",
        text: `# FORMAS FARMACEUTICAS (lista fechada)\n\n${construirVocabularioFormas()}`,
        cache_control: { type: "ephemeral" },
      },
    ],
    output_config: {
      // `low` e nao `medium`: a pergunta e' de leitura, nao de
      // raciocinio. Ler "COMP REV" e escolher da lista nao melhora com
      // mais deliberacao — so' custa mais output.
      effort: opts.effort ?? "low",
      format: { type: "json_schema", schema: SCHEMA_FORMA as unknown as Record<string, unknown> },
    },
    messages: [{ role: "user", content: construirLoteForma(produtos) }],
  }));

  const esperados = new Set(produtos.map((p) => p.cnp));
  const resultados = lerResultados(resposta, esperados, validarResultadoForma);
  return { resultados, usage: usageDe(resposta) };
}

// ─── Decisão de escrita ───────────────────────────────────────────────

/**
 * evidenceTypes que autorizam escrita automática.
 *
 * `CATEGORIA_PRODUTO` está de fora de propósito: é a evidência que o
 * modelo dá quando deduziu pela forma ou por parte do nome — exactamente
 * o tipo de raciocínio que as regras determinísticas já fazem melhor e
 * de graça. Se chegou aqui é porque as regras não conseguiram; uma
 * dedução do modelo sobre o mesmo texto não é sinal novo, é o mesmo
 * sinal com mais passos. Vai para revisão.
 */
export const EVIDENCIA_PERMITIDA: ReadonlySet<EvidenceType> = new Set<EvidenceType>([
  "MARCA_CONHECIDA",
  "SUBSTANCIA_CONHECIDA",
]);

/**
 * A SEGUNDA porta — mais estreita em tudo menos na evidência.
 *
 * O argumento acima continua de pé e `EVIDENCIA_PERMITIDA` não se toca. O
 * que a medição mostrou é que ele assenta em duas premissas que não valem
 * para esta população:
 *
 *   «as regras determinísticas já fazem melhor» — para os 1 577 produtos
 *   em causa as regras não fizeram melhor: não fizeram NADA. São produtos
 *   por classificar. A alternativa à dedução não é a resposta das regras,
 *   é a ausência de resposta.
 *
 *   «vai para revisão» — não ia. O REVIEW era gravado em
 *   `KnowledgeEnrichmentCache` com `persistido=false` e mais nada, e o
 *   propósito escrito desse registo é impedir que se volte a perguntar.
 *   Era um registo de supressão, não uma fila. (Nesta revisão passa a
 *   alimentar `FilaRevisao` — ver o runner.)
 *
 * A conclusão não é que o gate estava errado: é que faltava um terceiro
 * estado entre "escrever como facto" e "não escrever". Uma dedução com
 * par válido, subcategoria específica e sem contradição regulamentar vale
 * mais que a ausência — desde que se saiba que é uma dedução, se possa
 * filtrar por isso, e se possa desfazer.
 *
 * É isso que `PROVISORIA` é. A marca é o que torna 0,85 aceitável aqui:
 * não se está a baixar a barra da verdade, está a criar-se um sítio para
 * o que não é verdade nem é nada.
 */
export const EVIDENCIA_PROVISORIA: ReadonlySet<EvidenceType> = new Set<EvidenceType>([
  "CATEGORIA_PRODUTO",
]);

/**
 * Carimbo de `Produto.classificacaoVersao` nas escritas provisórias.
 *
 * Distinto de `KNOWLEDGE_VERSION` ("ke-2.0") de propósito: o rollback
 * primário é o journal, mas esta marca dá um segundo caminho — saber
 * exactamente que linhas nasceram desta política, sem depender de um
 * ficheiro.
 */
export const VERSAO_PROVISORIA = "ke-2.1";

/**
 * Grupos do vocabulário em que uma associação errada manda alguém à
 * prateleira errada com um problema de saúde. Só "Bem-estar e prevenção"
 * fica de fora — vitaminas, sono e energia falham mais barato.
 */
export const GRUPOS_CLINICOS: ReadonlySet<string> = new Set([
  "Respiratório",
  "Dor e febre",
  "Digestivo",
  "Pele",
  "Olhos, ouvidos e boca",
  "Mãe e bebé",
  "Apoio ao doente",
]);

export type Decisao = "APPLY" | "REVIEW" | "SKIP";

/** Cada critério em separado — é isto que torna o gate auditável. */
export type Criterios = {
  /** Categoria e subcategoria sobreviveram ao vocabulário fechado. */
  vocabulario: boolean;
  /** evidenceType autoriza escrita automática. */
  evidencia: boolean;
  /** Não colide com uma classificação específica já existente. */
  semConflito: boolean;
  /** Sinal AUXILIAR — nunca sozinho suficiente. */
  confianca: boolean;
  /** Passou a segunda passagem (ou não precisava dela). */
  verificado: boolean;
  /**
   * A subcategoria proposta é específica — não é um "Outros X".
   *
   * SÓ pesa no ramo provisório. Aplicá-lo ao canónico mudaria
   * comportamento existente: hoje um produto SEM subcategoria com uma
   * proposta "Outros X" recebe APPLY (o SKIP de "proposta também é
   * fallback" só dispara quando já existe subcategoria). Esse caminho
   * fica exactamente como está.
   */
  especifica: boolean;
  /**
   * O nível 1 proposto não troca o estatuto regulamentar do produto.
   * Também só pesa no ramo provisório, pela mesma razão.
   */
  tipoCoerente: boolean;
};

export type DecisaoEscrita = {
  decisao: Decisao;
  /**
   * APPLY por DEDUÇÃO: escreve-se, marcada `PROVISORIA`.
   *
   * Porque não um quarto valor `APPLY_PROVISORIO` em `Decisao`: há
   * dezenas de sítios a comparar `decisao !== "APPLY"` — a guarda à porta
   * de `escrever()`, o `persistido` de `gravarCache`, o fecho da
   * `EnriquecimentoFila`, a propagação. Um valor novo obriga a auditar
   * todos, e cada um que escape falha em silêncio a favor de não
   * escrever. Um campo à parte deixa todo esse código correcto sem lhe
   * tocar, e só quem precisa de saber é que pergunta.
   */
  provisorio: boolean;
  /** O que foi pedido — e portanto o que pode ser escrito. */
  alvo: AlvoPedido;
  criterios: Criterios;
  /** Grava categoria/subcategoria? Nunca true quando alvo é UTILIZACOES. */
  gravarCategoria: boolean;
  /** Grava productType? Só quando falta no produto. */
  gravarProductType: boolean;
  utilizacoes: string[];
  /**
   * Discordância forte num produto já classificado: o modelo põe-no
   * noutro nível 1. NUNCA é escrita — é um candidato a auditoria humana.
   */
  anomalia: string | null;
  motivo: string;
};

/**
 * Precisa de segunda passagem?
 *
 * Medicamento ou utilização clínica — o que o utilizador definiu como o
 * território onde uma opinião só não chega.
 */
export function precisaVerificacao(r: KnowledgeResult): boolean {
  // O pedido de forma NAO tem segunda passagem, e a guarda e' explicita
  // em vez de emergente: hoje um resultado de forma nao tem categoria
  // nem utilizacoes, portanto cairia em `false` por acaso. Um campo novo
  // amanha e o acaso desfaz-se em silencio, a pagar o dobro.
  if (r.alvo === "FORMA") return false;
  if (r.categoria === "MEDICAMENTOS") return true;
  return r.utilizacoes.some((slug) => {
    const g = UTILIZACOES_POR_SLUG.get(slug)?.grupo;
    return g ? GRUPOS_CLINICOS.has(g) : false;
  });
}

/**
 * O gate. Combina critérios independentes — a confiança auto-reportada
 * pelo modelo é apenas UM deles, e nunca o decisivo.
 *
 * Porque não basta a confiança: é um número que o próprio modelo escolhe
 * e sobre o qual não tem calibração garantida. Um modelo convencido está
 * tão convencido quando acerta como quando erra. Os outros critérios não
 * são opinião dele: o vocabulário é a nossa taxonomia, o conflito é o
 * estado da nossa base, a evidência é uma categoria declarada que
 * podemos filtrar, e a verificação é uma segunda passagem independente.
 *
 * Todos têm de passar. `confianca` sozinha não abre a porta, e a sua
 * falha sozinha fecha-a — é auxiliar no sentido de não ser suficiente,
 * não no sentido de ser ignorável.
 */
export function avaliarGate(
  r: KnowledgeResult,
  atual: {
    categoria: string | null;
    subcategoria: string | null;
    productType: string | null;
    /** Ausente = desconhecida; ver `alvoParaProduto`. */
    forma?: string | null;
  },
  verificacao: { concorda: boolean; aplicavel: boolean } = { concorda: true, aplicavel: false },
): DecisaoEscrita {
  // `ehBalde` e a definicao unica de "Outros X" — a mesma que o
  // diagnostico usa para simular esta politica. Estava aqui duas vezes
  // como regex solta, e uma simulacao com uma copia diferente produz um
  // numero que a escrita depois nao reproduz.
  const eraFallback = !atual.subcategoria || ehBalde(atual.subcategoria);
  const novoEspecifico = !!r.subcategoria && !ehBalde(r.subcategoria);
  const alvo: AlvoPedido = alvoParaProduto(atual);

  const criterios: Criterios = {
    // Para um pedido de utilizações, o vocabulário fechado que interessa
    // é o das utilizações — não há categoria a validar porque não há
    // categoria proposta.
    vocabulario:
      alvo === "FORMA"
        ? ehFormaCanonica(r.forma)
        : alvo === "UTILIZACOES"
        ? r.utilizacoes.length > 0
        : !!r.categoria && !!r.subcategoria,
    // No pedido de forma a "evidencia" e' a proveniencia: so' um
    // resultado marcado FORMA_DEDUZIDA — isto e', vindo do pedido
    // estreito — pode escrever forma por este caminho. Uma proposta de
    // classificacao que aqui chegasse traria MARCA_CONHECIDA e falharia,
    // que e' o que se quer: a forma dela ja' tem o seu proprio caminho.
    evidencia:
      alvo === "FORMA"
        ? r.evidenceType === "FORMA_DEDUZIDA"
        : EVIDENCIA_PERMITIDA.has(r.evidenceType),
    // Num pedido de utilizações não há conflito possível: a classificação
    // não é tocada. O critério continua a existir e a ser reportado — o
    // que muda é que a pergunta feita ao modelo já não pode colidir.
    // Nem no pedido de forma: a classificacao nao e' tocada, e a forma
    // so' se escreve onde nao ha' nenhuma (o `is null` do UPDATE).
    semConflito: alvo === "UTILIZACOES" || alvo === "FORMA" ? true : eraFallback,
    // A forma tem o SEU limiar, que e' o clinico (0,90) e nao o da
    // classificacao (0,85). Sao gates diferentes porque medem coisas
    // diferentes, e ja' era assim antes deste alvo existir.
    confianca:
      alvo === "FORMA"
        ? r.confidenceClinica >= LIMIAR_CLINICO
        : r.confidence >= LIMIAR_PERSISTENCIA,
    verificado: verificacao.concorda,
    // Medidos SEMPRE — são reportados no relatório e nos diagnósticos —
    // mas só CONSULTADOS pelo ramo provisório. Medir sem usar é o que
    // permite ver, no dry-run, quanto é que cada um corta antes de
    // qualquer escrita depender deles.
    especifica: novoEspecifico,
    tipoCoerente: !contradicaoForte(atual.productType ?? r.productType, r.categoria),
  };

  const utilizacoes = criterios.evidencia && criterios.confianca && criterios.verificado
    ? r.utilizacoes
    : [];

  const base = {
    alvo,
    criterios,
    provisorio: false,
    gravarCategoria: false,
    gravarProductType: false,
    utilizacoes: [] as string[],
    anomalia: null as string | null,
  };

  // ── Produto já classificado, sem forma: só a forma ──────────────────
  //
  // Devolve APPLY porque e' `escrever()` que grava, e essa funcao sai
  // logo a' porta se a decisao nao for APPLY. Um SKIP aqui — que ate'
  // descreveria bem "nao ha' classificacao a mexer" — deixava a forma
  // por escrever e a corrida sem efeito nenhum.
  //
  // O que este ramo NAO faz: gravarCategoria e gravarProductType ficam
  // false e `utilizacoes` fica vazio. A garantia de que so' a forma e'
  // escrita nao esta' so' aqui — o resultado do pedido de forma tem
  // todos os outros campos a null (ver `validarResultadoForma`), e o
  // caminho de escrita salta os nulos. Duas fechaduras.
  if (alvo === "FORMA") {
    if (!r.forma) {
      return { ...base, decisao: "SKIP", motivo: "forma nao determinavel — nada a escrever" };
    }
    if (!criterios.vocabulario) {
      return { ...base, decisao: "SKIP", motivo: `forma "${r.forma}" fora do vocabulario fechado` };
    }
    if (!criterios.evidencia) {
      return { ...base, decisao: "SKIP", motivo: "resultado nao veio do pedido de forma" };
    }
    if (!criterios.confianca) {
      return {
        ...base,
        decisao: "REVIEW",
        motivo: `confianca ${r.confidenceClinica.toFixed(2)} < ${LIMIAR_CLINICO}`,
      };
    }
    return { ...base, decisao: "APPLY", motivo: `forma "${r.forma}"` };
  }

  // ── Produto já classificado: só utilizações, e uma anomalia é revisão ──
  if (alvo === "UTILIZACOES") {
    // Discordância forte: o modelo põe o produto noutra secção da loja.
    // Não se escreve nada — nem a classificação (nunca foi pedida) nem as
    // utilizações, porque se ele acha que é outro produto, as etiquetas
    // que sugeriu são de outro produto.
    // Duas origens para o mesmo sinal: `sugestaoCategoria` (pedido de
    // utilizações) e `categoria` (resultado em forma de classificação que
    // chegue aqui por outro caminho). Qualquer uma que ponha o produto
    // noutro nível 1 conta — perder a segunda deixaria a discordância
    // passar em silêncio, que era o comportamento antigo.
    const propostaN1 = r.sugestaoCategoria ?? r.categoria;
    const anomalia =
      propostaN1 && atual.categoria && propostaN1 !== atual.categoria
        ? `modelo coloca em "${propostaN1}", base tem "${atual.categoria}"`
        : null;
    if (anomalia) {
      return { ...base, decisao: "REVIEW", anomalia, motivo: `anomalia de classificação: ${anomalia}` };
    }
    if (r.utilizacoes.length === 0) {
      return { ...base, decisao: "SKIP", motivo: "nenhuma utilização segura a acrescentar" };
    }
    const falhasU: string[] = [];
    if (!criterios.evidencia) falhasU.push(`evidência ${r.evidenceType} não autoriza escrita`);
    if (!criterios.confianca) falhasU.push(`confiança ${r.confidence.toFixed(2)} < ${LIMIAR_PERSISTENCIA}`);
    if (!criterios.verificado) falhasU.push("verificador discordou das utilizações");
    if (falhasU.length > 0) return { ...base, decisao: "REVIEW", motivo: falhasU.join("; ") };

    return {
      ...base,
      decisao: "APPLY",
      // A classificação existente é intocável — este caminho nunca a
      // escreve, e é por isso que o produto pôde entrar de todo.
      gravarCategoria: false,
      utilizacoes,
      motivo: verificacao.aplicavel ? "utilizações verificadas" : "utilizações",
    };
  }

  // SKIP: não há trabalho a fazer. Distinto de REVIEW — não há nada
  // para um humano decidir, o produto já está resolvido ou a proposta
  // não acrescentava nada.
  if (!eraFallback) {
    return { ...base, decisao: "SKIP", utilizacoes, motivo: "já tem subcategoria específica — intocável" };
  }
  if (r.categoria && !novoEspecifico && atual.subcategoria) {
    return { ...base, decisao: "SKIP", utilizacoes, motivo: "proposta também é fallback" };
  }

  const falhas: string[] = [];
  if (!criterios.vocabulario) falhas.push("fora do vocabulário");
  if (!criterios.evidencia) falhas.push(`evidência ${r.evidenceType} não autoriza escrita`);
  if (!criterios.confianca) falhas.push(`confiança ${r.confidence.toFixed(2)} < ${LIMIAR_PERSISTENCIA}`);
  if (!criterios.verificado) falhas.push("verificador discordou da proposta");

  // ── A segunda porta: escrita PROVISÓRIA ─────────────────────────────
  //
  // Chega aqui quem falhou o gate canónico. A única falha que se admite é
  // a da evidência, e só quando é exactamente `CATEGORIA_PRODUTO`: tudo o
  // resto — vocabulário, conflito, confiança, verificação — tem de ter
  // passado, e ainda se exigem os dois critérios extra.
  //
  // É por construção um ramo ADITIVO: só corre depois de `falhas` estar
  // preenchida, e só sobre casos que hoje devolvem REVIEW. Nenhum APPLY
  // canónico muda, nenhum SKIP muda. É esse o invariante que os testes
  // fecham, e é o que torna esta alteração segura de aplicar de uma vez.
  const soFalhaEvidencia = falhas.length === 1 && !criterios.evidencia;
  if (
    soFalhaEvidencia &&
    EVIDENCIA_PROVISORIA.has(r.evidenceType) &&
    criterios.especifica &&
    criterios.tipoCoerente
  ) {
    return {
      ...base,
      decisao: "APPLY",
      provisorio: true,
      gravarCategoria: true,
      // O productType NÃO é escrito por dedução.
      //
      // A classificação provisória é reversível e está marcada; o
      // productType não tem estado provisório nenhum, e uma vez escrito
      // passa a alimentar o classificador, o mapper e a própria
      // `contradicaoForte`. Uma dedução a decidir o critério que valida
      // deduções seguintes é um circuito que se fecha sobre si próprio.
      gravarProductType: false,
      // Vazio, e nao por acidente: `utilizacoes` acima exige
      // `criterios.evidencia`, que e precisamente o que falhou. Uma
      // deducao nao carimba utilizacoes clinicas.
      utilizacoes,
      motivo: `provisória (${r.evidenceType}, ${r.confidence.toFixed(2)})`,
    };
  }

  if (falhas.length > 0) {
    return { ...base, decisao: "REVIEW", motivo: falhas.join("; ") };
  }

  return {
    ...base,
    decisao: "APPLY",
    gravarCategoria: true,
    // Só quando falta. Um productType já decidido pela fase 1 não é
    // substituído — mesma doutrina da categoria.
    gravarProductType: !atual.productType && !!r.productType,
    utilizacoes,
    motivo: verificacao.aplicavel ? "gate completo (com verificação)" : "gate completo",
  };
}

// ─── Segunda passagem ─────────────────────────────────────────────────

/**
 * Enquadramento diferente do da proposta, de propósito.
 *
 * A verificação é uma RE-CLASSIFICAÇÃO CEGA: o verificador não vê a
 * proposta. Se visse, o trabalho dele passava a ser concordar — um
 * revisor a quem se mostra a resposta tende a validá-la, e teríamos
 * pago duas chamadas para obter uma opinião.
 *
 * Sem a proposta à frente, "concordar" passa a significar que dois
 * raciocínios independentes chegaram ao mesmo sítio. E a comparação é
 * feita em código (`compararPassagens`), não pelo modelo: mesmo a
 * decisão de o que conta como acordo fica fora do alcance dele.
 *
 * O enquadramento é o inverso do da proposta — primeiro identificar a
 * substância/produto, só depois mapear — para reduzir a correlação entre
 * as duas passagens.
 */
const SISTEMA_VERIFICADOR = `És um farmacêutico a confirmar a arrumação de produtos no catálogo de uma farmácia portuguesa.

Para cada produto, trabalha por esta ordem:
1. O que é este produto? Identifica a substância activa ou a gama, a partir do nome comercial.
2. Para que serve, clinicamente?
3. SÓ ENTÃO escolhe a categoria e subcategoria da taxonomia dada.

REGRAS

· Usa exclusivamente a taxonomia e o vocabulário de utilizações dados, com nomes exactos. Uma subcategoria tem de ser filha da categoria.
· Se não identificas o produto no passo 1, para: evidenceType "DESCONHECIDO", categoria e subcategoria vazias. Não deduzas pela forma farmacêutica — "solução injetável" não diz o que o produto trata.
· Utilizações só quando o produto serve mesmo para isso. Lista vazia é comum e correcta.
· confidence é a tua confiança em categoria+subcategoria (mesma escala: 0.95+ reconheces exactamente, 0.85–0.94 reconheces a gama, abaixo disso é palpite).

Devolves um resultado por produto, com o cnp exacto que recebeste.`;

/**
 * Verificador do pedido de utilizações. Mesmo princípio do outro: cego à
 * proposta, e com a ordem de raciocínio invertida — identificar a
 * substância antes de dizer para que serve.
 */
const SISTEMA_VERIFICADOR_UTILIZACOES = `És um farmacêutico a confirmar as etiquetas de utilização de produtos de uma farmácia portuguesa.

Para cada produto, por esta ordem:
1. O que é este produto? Identifica a substância activa ou a gama a partir do nome comercial.
2. Que problema resolve a quem o compra?
3. SÓ ENTÃO escolhe os slugs do vocabulário.

REGRAS

· Só slugs do vocabulário dado, exactos.
· Se não identificas o produto no passo 1, para: evidenceType "DESCONHECIDO" e lista vazia. Não deduzas pela forma farmacêutica nem pela subcategoria que te é dada — "solução oral" e "Outros" não dizem para que serve.
· A categoria e subcategoria que recebes são o que está na base HOJE. Não são a resposta certa por definição; se o produto não pertence ali, di-lo em categoriaProvavel.
· confidence é a tua confiança nas utilizações que indicas.

Devolves um resultado por produto, com o cnp exacto que recebeste.`;

export type Verificacao = {
  cnp: number;
  concorda: boolean;
  /** Utilizações confirmadas pelas duas passagens (interseção). */
  utilizacoesConfirmadas: string[];
  motivo: string;
};

/**
 * Compara duas passagens independentes. Tudo em código.
 *
 * Acordo = mesmo par (categoria, subcategoria). Não há acordo parcial na
 * categoria: "MEDICAMENTOS > Diabetes" e "MEDICAMENTOS > Cardiovascular"
 * mandam a pessoa a prateleiras diferentes, e acertar no nível 1 não
 * salva isso.
 *
 * Nas utilizações a regra é diferente e mais permissiva de propósito:
 * fica a INTERSEÇÃO. Uma utilização que só uma passagem viu não é escrita,
 * mas também não invalida a categoria — são decisões independentes.
 */
export function compararPassagens(
  proposta: KnowledgeResult,
  verificacao: KnowledgeResult | null,
): Verificacao {
  if (!verificacao) {
    return {
      cnp: proposta.cnp,
      concorda: false,
      utilizacoesConfirmadas: [],
      motivo: "verificador não devolveu resultado para este produto",
    };
  }
  if (verificacao.evidenceType === "DESCONHECIDO") {
    return {
      cnp: proposta.cnp,
      concorda: false,
      utilizacoesConfirmadas: [],
      motivo: "verificador não reconheceu o produto",
    };
  }

  const confirmadas = proposta.utilizacoes.filter((u) => verificacao.utilizacoes.includes(u));

  // Num pedido de utilizações não há par (categoria, subcategoria) a
  // comparar — os dois lados trazem null. O acordo é sobre as etiquetas:
  // se a interseção é vazia, as duas passagens não concordaram em nada, e
  // tratar isso como acordo (null === null) escreveria à mesma.
  if (proposta.alvo === "UTILIZACOES") {
    if (confirmadas.length === 0) {
      return {
        cnp: proposta.cnp,
        concorda: false,
        utilizacoesConfirmadas: [],
        motivo: "as duas passagens não coincidiram em nenhuma utilização",
      };
    }
    return {
      cnp: proposta.cnp,
      concorda: true,
      utilizacoesConfirmadas: confirmadas,
      motivo: "utilizações confirmadas pelas duas passagens",
    };
  }

  const mesmaCategoria = proposta.categoria === verificacao.categoria;
  const mesmaSubcategoria = proposta.subcategoria === verificacao.subcategoria;

  if (!mesmaCategoria || !mesmaSubcategoria) {
    return {
      cnp: proposta.cnp,
      concorda: false,
      utilizacoesConfirmadas: confirmadas,
      motivo:
        `discordância: proposta "${proposta.categoria} > ${proposta.subcategoria}" ` +
        `vs verificação "${verificacao.categoria} > ${verificacao.subcategoria}"`,
    };
  }

  return {
    cnp: proposta.cnp,
    concorda: true,
    utilizacoesConfirmadas: confirmadas,
    motivo: "duas passagens independentes concordam",
  };
}

/**
 * Segunda passagem sobre um lote. Mesma validação de vocabulário que a
 * proposta — o verificador não tem licença extra para inventar.
 */
export async function verificarLote(
  produtos: ProdutoResidual[],
  opts: { model?: string; effort?: "low" | "medium" | "high" } = {},
): Promise<LoteResposta> {
  return classificarLote(produtos, { ...opts, sistema: SISTEMA_VERIFICADOR });
}

/**
 * O pedido exacto que `classificarLote` enviaria, sem o enviar.
 *
 * Existe para se poder auditar o que sai daqui sem gastar uma chamada e
 * sem credenciais — em revisão de código, em CI, ou para responder a
 * "o que é que vocês mandam para lá?" sem ter de acreditar em ninguém.
 */
export function previewPedido(produtos: ProdutoResidual[]): {
  sistema: string;
  vocabulario: string;
  lote: string;
  esquema: unknown;
} {
  return {
    sistema: SISTEMA,
    vocabulario: construirVocabulario(),
    lote: construirLote(produtos),
    esquema: SCHEMA,
  };
}

/** Chave de cache. A designação entra porque é o input real do modelo. */
export function chaveCache(cnp: number, designacao: string): string {
  return `${KNOWLEDGE_VERSION}|${KNOWLEDGE_MODEL}|${cnp}|${designacao.trim().toLowerCase()}`;
}
