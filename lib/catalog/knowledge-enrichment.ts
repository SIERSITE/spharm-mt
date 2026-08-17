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
export const KNOWLEDGE_VERSION = "ke-1.1";

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
] as const;

/** Campos que esta fonte está proibida de escrever, por terem fonte melhor. */
export const CAMPOS_PROIBIDOS = [
  "codigoATC",
  "dci",
  "fabricanteId",
  "imagemUrl",
  "formaFarmaceutica",
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
  | "DESCONHECIDO";

export type KnowledgeResult = {
  cnp: number;
  productType: ProductType | null;
  categoria: string | null;
  subcategoria: string | null;
  /** Forma farmacêutica normalizada, quando dedutível. */
  forma: string | null;
  utilizacoes: string[];
  confidence: number;
  evidenceType: EvidenceType;
  rationale: string;
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
  | "UTILIZACOES";

/**
 * Deriva o alvo do ESTADO DO PRODUTO, não do estrato da consulta.
 *
 * É a mesma condição que o gate usa para a não-degradação (`eraFallback`).
 * Derivar do estado — e não de um rótulo passado ao lado — é o que
 * impede o alvo e o gate de discordarem: se discordassem, voltaríamos a
 * pedir o que não se pode aplicar.
 */
export function alvoParaProduto(atual: { subcategoria: string | null }): AlvoPedido {
  const especifica = !!atual.subcategoria && !/^outros\b/i.test(atual.subcategoria);
  return especifica ? "UTILIZACOES" : "CLASSIFICACAO";
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
  const evidenceType = (
    ["MARCA_CONHECIDA", "SUBSTANCIA_CONHECIDA", "CATEGORIA_PRODUTO", "DESCONHECIDO"] as const
  ).includes(r.evidenceType as EvidenceType)
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
    utilizacoes,
    confidence: Math.max(0, Math.min(1, confidence)),
    evidenceType,
    rationale: typeof r.rationale === "string" ? r.rationale.trim().slice(0, 400) : "",
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
  const evidenceType = (
    ["MARCA_CONHECIDA", "SUBSTANCIA_CONHECIDA", "CATEGORIA_PRODUTO", "DESCONHECIDO"] as const
  ).includes(r.evidenceType as EvidenceType)
    ? (r.evidenceType as EvidenceType)
    : "DESCONHECIDO";

  const productType = PRODUCT_TYPES.includes(r.productType as ProductType)
    ? (r.productType as ProductType)
    : null;

  // Categoria e subcategoria só sobrevivem em par válido. Uma categoria
  // sem subcategoria filha não serve para nada a jusante.
  let categoria: string | null = null;
  let subcategoria: string | null = null;
  const cat = typeof r.categoria === "string" ? r.categoria.trim() : "";
  const sub = typeof r.subcategoria === "string" ? r.subcategoria.trim() : "";
  if (cat && sub && isValidNivel2(cat, sub)) {
    categoria = cat;
    subcategoria = sub;
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

  return {
    cnp,
    productType,
    categoria,
    subcategoria,
    forma,
    utilizacoes,
    confidence: Math.max(0, Math.min(1, confidence)),
    evidenceType,
    rationale,
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
};

export type DecisaoEscrita = {
  decisao: Decisao;
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
  atual: { categoria: string | null; subcategoria: string | null; productType: string | null },
  verificacao: { concorda: boolean; aplicavel: boolean } = { concorda: true, aplicavel: false },
): DecisaoEscrita {
  const eraFallback = !atual.subcategoria || /^outros\b/i.test(atual.subcategoria);
  const novoEspecifico = !!r.subcategoria && !/^outros\b/i.test(r.subcategoria);
  const alvo: AlvoPedido = alvoParaProduto(atual);

  const criterios: Criterios = {
    // Para um pedido de utilizações, o vocabulário fechado que interessa
    // é o das utilizações — não há categoria a validar porque não há
    // categoria proposta.
    vocabulario: alvo === "UTILIZACOES" ? r.utilizacoes.length > 0 : !!r.categoria && !!r.subcategoria,
    evidencia: EVIDENCIA_PERMITIDA.has(r.evidenceType),
    // Num pedido de utilizações não há conflito possível: a classificação
    // não é tocada. O critério continua a existir e a ser reportado — o
    // que muda é que a pergunta feita ao modelo já não pode colidir.
    semConflito: alvo === "UTILIZACOES" ? true : eraFallback,
    confianca: r.confidence >= LIMIAR_PERSISTENCIA,
    verificado: verificacao.concorda,
  };

  const utilizacoes = criterios.evidencia && criterios.confianca && criterios.verificado
    ? r.utilizacoes
    : [];

  const base = {
    alvo,
    criterios,
    gravarCategoria: false,
    gravarProductType: false,
    utilizacoes: [] as string[],
    anomalia: null as string | null,
  };

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
