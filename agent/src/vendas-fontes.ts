/**
 * agent/src/vendas-fontes.ts
 *
 * As fontes físicas de uma venda no ERP, normalizadas para UM shape.
 *
 * ── O DEFEITO QUE ISTO FECHA ─────────────────────────────────────────
 *
 * O leitor de vendas lia uma tabela:
 *
 *     FROM [dbo].[Atendimento] a
 *     JOIN [dbo].[Atendimento Detalhe] d ON d.[Atendimento ID] = a.[Atendimento ID]
 *
 * O ERP tem mais do que uma. Uma factura da série VSG — venda suspensa,
 * que contabilística e fiscalmente é uma venda como qualquer outra —
 * vive em `[Atendimento Susp Detalhe]`. Nunca era lida, e portanto nunca
 * entrava em `IngestVendaLinhaRaw`, nem em `VendaMensal`, nem no
 * relatório.
 *
 * Só se via pelo lado do stock: `dbo.StocksMov` é o livro-razão
 * universal e apanha as três origens, por isso o movimento existia em
 * `MovimentoArtigo` (classificado `RESERVA_SUSPENSA`, que é o nome do
 * circuito documental e não um juízo sobre se é venda) enquanto a venda
 * não existia em lado nenhum. Silveirense, 01/08/2026: Nimed 9599258 com
 * 2 unidades e Enalapril 3626884 com 1, entre outros, invisíveis.
 *
 * ── PORQUÊ UM NORMALIZADOR E NÃO UM UNION ────────────────────────────
 *
 * Um `UNION ALL` no SQL resolveria o sintoma e deixaria duas listas de
 * colunas a divergir em silêncio. Aqui cada fonte é um *reader* que
 * devolve `LinhaVendaCanonica`; a partir daí existe um caminho só —
 * mesma classificação, mesma idempotência, mesmo payload. Acrescentar
 * uma quarta fonte é acrescentar um reader, não editar uma query.
 *
 * ── DESCOBERTA DINÂMICA, E PORQUÊ ────────────────────────────────────
 *
 * Os nomes das colunas das tabelas de suspensas não são iguais em todas
 * as instalações Softreis. É o mesmo problema que o `stocksmov` resolveu
 * na rev32/37: perguntar a `sys.columns` quais existem e emitir `NULL`
 * no SELECT para as que faltam, em vez de partir a query inteira por uma
 * coluna com outro nome. A alternativa — fixar nomes que não vimos — dá
 * um agent que funciona numa farmácia e rebenta na seguinte.
 *
 * ── IDENTIDADE ───────────────────────────────────────────────────────
 *
 * `externalLineId` é a PK DENTRO da sua tabela. IDs de tabelas
 * diferentes são sequências independentes e não podem ser comparados
 * entre si. A identidade lógica é, por isso,
 *
 *     (farmaciaId, sourceNamespace, externalLineId)
 *
 * A auditoria de produção não encontrou colisões hoje. Isso não é
 * garantia nenhuma sobre amanhã: são contadores independentes de
 * tabelas independentes. Discriminar pela origem custa uma coluna e
 * remove a classe inteira do problema.
 */

import type { SqlPool } from "./sql-client.js";

// ─────────────────────────────────────────────────────────────────────
// Vocabulário
// ─────────────────────────────────────────────────────────────────────

/**
 * A tabela ERP de onde a linha veio. Faz parte da identidade, e é por
 * isso que é um valor persistido e não uma variável local.
 */
export const NAMESPACES = {
  /// `dbo.[Atendimento Detalhe]` — a venda de balcão. Série G.
  ATENDIMENTO_DETALHE: "ATENDIMENTO_DETALHE",
  /// `dbo.[Atendimento Susp Detalhe]` — venda suspensa. Série VSG/VSC.
  ATENDIMENTO_SUSP_DETALHE: "ATENDIMENTO_SUSP_DETALHE",
  /**
   * `dbo.[Atendimento Detalhe]`, tipo documental 4 — factura a crédito
   * emitida pelo circuito de balcão.
   *
   * A MESMA tabela que `ATENDIMENTO_DETALHE`, e um namespace à parte de
   * propósito. A natureza deriva do namespace, portanto sem ele estas
   * linhas contariam como venda normal. E reutilizar `VENDAS_CREDITO`
   * era pior: passaria a haver duas SEQUÊNCIAS de PK independentes
   * — `[Atendimento Detalhe]` e `[Atendimento Credito Detalhe]` — sob a
   * mesma chave `(farmaciaId, sourceNamespace, externalLineId)`. Uma
   * colisão aí não duplica: sobrescreve em silêncio.
   *
   * Aqui a sequência é uma só, partida em dois conjuntos disjuntos pelo
   * tipo documental. Uma linha é lida uma vez e recebe um namespace.
   */
  ATENDIMENTO_DETALHE_CREDITO: "ATENDIMENTO_DETALHE_CREDITO",
  /// Venda a crédito. Reader por construir — ver `NATUREZA_POR_NAMESPACE`.
  VENDAS_CREDITO: "VENDAS_CREDITO",
  /// Guia de transferência entre farmácias. Reader por construir.
  GUIAS_TRANSFERENCIA: "GUIAS_TRANSFERENCIA",
} as const;

export type SourceNamespace = (typeof NAMESPACES)[keyof typeof NAMESPACES];

/**
 * O tipo documental que, dentro de `[Atendimento Detalhe]`, é factura a
 * crédito. Nomeado porque aparece em dois sítios — no encaminhamento e
 * na classificação — e dois literais iguais mantidos por disciplina é
 * exactamente como o `Fim Venda = 'S'` acabou em seis ficheiros.
 */
export const TIPO_FACTURA_CREDITO_BALCAO = 4;

/**
 * A natureza operacional de uma venda.
 *
 * ── PORQUE É UMA DIMENSÃO E NÃO UMA CLASSE ───────────────────────────
 *
 * `ClasseVenda` responde "isto soma ou subtrai?". `NaturezaVenda` responde
 * "isto é o quê?". São perguntas independentes: uma devolução de uma venda
 * a crédito é `DEVOLUCAO_ANULACAO` + `CREDITO`, e misturar as duas numa só
 * coluna tornava impossível responder a qualquer uma.
 *
 * O relatório oficial do SPharm tem dois interruptores — incluir vendas a
 * crédito, incluir guias de transferência — e o SPharm.MT tem de os ter
 * também. Um total já somado não se desliga: por isso a natureza viaja com
 * a linha, sobrevive à agregação, e só se soma no fim, ao desenhar.
 */
export type NaturezaVenda = "NORMAL" | "CREDITO" | "TRANSFERENCIA";

/**
 * De que natureza é cada circuito.
 *
 * A venda suspensa é NORMAL: fiscal e contabilisticamente é uma venda
 * como outra qualquer, e é assim que o relatório oficial a conta. O que
 * a distingue é a tabela de onde vem, não a sua natureza comercial.
 */
export const NATUREZA_POR_NAMESPACE: Record<SourceNamespace, NaturezaVenda> = {
  [NAMESPACES.ATENDIMENTO_DETALHE]: "NORMAL",
  [NAMESPACES.ATENDIMENTO_SUSP_DETALHE]: "NORMAL",
  [NAMESPACES.ATENDIMENTO_DETALHE_CREDITO]: "CREDITO",
  [NAMESPACES.VENDAS_CREDITO]: "CREDITO",
  [NAMESPACES.GUIAS_TRANSFERENCIA]: "TRANSFERENCIA",
};

export function naturezaDe(ns: SourceNamespace): NaturezaVenda {
  return NATUREZA_POR_NAMESPACE[ns] ?? "NORMAL";
}

/**
 * A classe canónica de uma linha. DUAS, e só duas.
 *
 * `UNKNOWN` não está aqui de propósito. Era uma classe que se gravava e
 * depois se filtrava — perder com passos extra. Uma linha que não se
 * consegue classificar é um erro de ingestão e tem de ser reportada,
 * não arrumada numa gaveta.
 */
export type ClasseVenda = "VENDA" | "DEVOLUCAO_ANULACAO";

/** Uma linha de venda, independente da tabela de onde veio. */
export type LinhaVendaCanonica = {
  // ── proveniência ──────────────────────────────────────────────
  sourceNamespace: SourceNamespace;
  /** PK dentro do namespace. NUNCA comparada entre namespaces. */
  externalLineId: number;
  /** Cabeçalho: `[Atendimento ID]`. Null se a fonte não o expõe. */
  externalDocumentId: number | null;

  // ── documento ─────────────────────────────────────────────────
  serie: string | null;
  documento: string | null;
  /** `Atendimento.[Tipo Documento]`, cru. A classificação é a seguir. */
  tipoDocumento: number | null;

  // ── classificação ─────────────────────────────────────────────
  /** Soma ou subtrai. */
  classe: ClasseVenda;
  /** O que isto é: venda normal, a crédito, ou transferência. */
  natureza: NaturezaVenda;

  // ── medidas, ao valor histórico da linha ──────────────────────
  /** Positiva na venda, negativa na NC/anulação. */
  quantidadeAssinada: number;
  pvpUnitario: number | null;
  valorBruto: number | null;
  ivaValor: number | null;
  descontoValor: number | null;
  comparticipacao1: number | null;
  comparticipacao2: number | null;

  // ── contexto ──────────────────────────────────────────────────
  dataVenda: string | null;
  externalProductId: number;
  processaStocks: boolean | null;
  entidadeId: number | null;
  sequencia: number | null;
};

// ─────────────────────────────────────────────────────────────────────
// Classificação documental
// ─────────────────────────────────────────────────────────────────────

/**
 * A regra de um circuito.
 *
 * `venda` e `reversao` são tipos cuja classe é uma propriedade do TIPO:
 * um 104 é uma nota de crédito venha com que sinal vier. `peloSinal` são
 * tipos em que o mesmo número documental serve as duas operações, e é a
 * quantidade que diz qual.
 */
export type RegraCircuito = {
  venda: ReadonlySet<number>;
  reversao: ReadonlySet<number>;
  /** Positivo = venda, negativo = reversão, zero = recusado. */
  peloSinal: ReadonlySet<number>;
};

/**
 * Que tipos de documento são venda e quais são reversão, POR CIRCUITO.
 *
 * ── PORQUE É POR NAMESPACE E NÃO UMA LISTA GLOBAL ────────────────────
 *
 * Os dois circuitos numeram os seus tipos de documento em colunas
 * diferentes de tabelas diferentes — `Atendimento.[Tipo Documento]` e
 * `Atendimento Susp.[Tipo Documento ID]`. Nada garante que o mesmo
 * número signifique o mesmo dos dois lados, e uma lista global assume
 * precisamente isso. Foi a suposição equivalente — "a coluna chama-se
 * `Atendimento ID`, logo aponta para o `Atendimento`" — que fez o reader
 * ler zero linhas durante uma ronda inteira.
 *
 * ── CIRCUITO G: A CLASSE ESTÁ NO TIPO ────────────────────────────────
 *
 * Auditoria de 2024-01-01 a 2026-07-31 na Silveirense, sobre
 * `[Atendimento]` + `[Atendimento Detalhe]`:
 *
 *     tipoDoc      linhas    quantidade
 *     2                 9             9
 *     7           387 378       396 132
 *     27              418          -436
 *     104           6 138        -6 202
 *
 * Cada tipo tem um sinal só. 7 e 2 somam, 27 e 104 subtraem, e o ERP já
 * grava a reversão negativa — ver `assinarQuantidade`.
 *
 * O tipo 2 são nove linhas em dois anos e meio. É raro, e é venda: o
 * documento G/669909 (2024-01-30 09:56:17) tem cinco linhas, todas de
 * quantidade positiva, e o operador confirmou que é uma factura normal
 * da série G.
 *
 * O 77 esteve aqui durante meses e nunca foi observado em ERP nenhum. A
 * prova está no seed da própria migração, que se descreve a si mesmo:
 * `(77, 'VENDA', 'default Softreis')` contra `(7, 'UNKNOWN', 'detectado
 * 2024-01-01 sample')`. O 77 era a suposição do fornecedor; o 7 foi o
 * que se viu. A rev68 fechou a questão em produção: 282 linhas do dia,
 * 282 com tipo 7, zero com 77.
 *
 * ── CIRCUITO SUSPENSO: A CLASSE ESTÁ NO SINAL ────────────────────────
 *
 * Aqui o mesmo tipo documental serve a factura e a sua anulação. Não é
 * uma hipótese — é o que as duas farmácias responderam, no mesmo
 * período:
 *
 *     Silveirense  VSG 107   16 168 linhas +      2 078 linhas −
 *                            336 documentos negativos, em pares +N/−N
 *                            pelo mesmo |Numero Documento|
 *     Segurado     VSC 107    8 982 linhas +        583 linhas −
 *                            92 documentos negativos
 *     Segurado     VSC 102       25 linhas +          5 linhas −
 *                            +31186/−31186 e +31187/−31187 confirmados
 *                            funcionalmente como facturas VS e as suas
 *                            anulações
 *
 * Produto+instante com quantidades opostas anulam exactamente. Um `Set`
 * de tipos não consegue exprimir isto: declarar 107 como venda faria as
 * 2 078 linhas negativas somarem, e declará-lo como reversão faria as
 * 16 168 positivas subtrair. Qualquer das duas dá um total plausível e
 * errado — que é a forma de erro que este projecto já pagou duas vezes.
 *
 * Por isso a regra do circuito suspenso é por tipo E sinal. E o sinal
 * vem do ERP: não é inferido de nome, série nem de `Fim Venda`, que foi
 * refutado como classificador com 11 868 linhas e zero matches.
 *
 * ── O 104 NÃO ENTRA AQUI, E É DE PROPÓSITO ───────────────────────────
 *
 * As 107 relações de `Atendimento_SuspFT_NC_Susp` resolvem 107/107 para
 * `[Atendimento]`, com `[Tipo Documento] = 104`, e as suas linhas vivem
 * em `[Atendimento Detalhe]` — que o reader do circuito G já lê.
 * Declarar 104 aqui faria a MESMA nota de crédito ser lida duas vezes e
 * subtraída duas vezes: o erro simétrico daquele que andámos a corrigir,
 * e igualmente plausível à vista.
 */
export const CLASSIFICACAO: Record<SourceNamespace, RegraCircuito> = {
  [NAMESPACES.ATENDIMENTO_DETALHE]: {
    venda: new Set([7, 2]),
    reversao: new Set([104, 27]),
    peloSinal: new Set<number>(),
  },
  [NAMESPACES.ATENDIMENTO_SUSP_DETALHE]: {
    venda: new Set<number>(),
    // Vazio por decisão, não por omissão: o 104 das NC de VSG é lido
    // pelo circuito G. Ver acima.
    reversao: new Set<number>(),
    peloSinal: new Set([107, 102]),
  },
  // ── Crédito e transferências: DECLARADOS, sem tipos ─────────────
  //
  // Os namespaces existem para que a dimensão `naturezaVenda` esteja
  // completa de ponta a ponta — schema, agregação, filtros do mapa. Os
  // readers não existem, e os conjuntos de tipos estão vazios porque
  // NINGUÉM os mediu ainda.
  //
  // Vazio aqui significa fail-closed: uma linha destes circuitos é
  // recusada e o tipo aparece no log. É o desfecho certo — inventar um
  // tipo para "já ficar a funcionar" era repetir exactamente o erro do
  // 77, que esteve declarado durante meses sem nunca ter sido visto num
  // ERP.
  /**
   * Factura a crédito do circuito de balcão — `[Atendimento Detalhe]`,
   * tipo 4.
   *
   * Medição da Principal (SPharm_Pais_Moreira), 2024-01-04 a 2026-08-26:
   *
   *     negativas   67 docs   120 linhas   −141 unidades
   *     positivas    1 doc      3 linhas     +3 unidades  (2025-12-08)
   *     zero                     0 linhas
   *
   * PELO SINAL, e não `reversao` apesar de 120 das 123 linhas serem
   * negativas: as 3 positivas de 2025-12-08 são um documento real, e
   * declarar 4 como reversão fá-las-ia subtrair. O inverso — declarar
   * como venda — faria as 120 negativas somarem. É o mesmo raciocínio
   * do 107 e do 18, e a razão pela qual o predomínio de um sinal não é
   * argumento para o fixar.
   *
   * Sem gate por `Fim Venda`, que já foi refutado como classificador
   * duas vezes. O zero é recusado pelo próprio `classificarDocumento`.
   */
  [NAMESPACES.ATENDIMENTO_DETALHE_CREDITO]: {
    venda: new Set<number>(),
    reversao: new Set<number>(),
    peloSinal: new Set([TIPO_FACTURA_CREDITO_BALCAO]),
  },
  /**
   * Venda a crédito — `[Atendimento Credito]`, série `VCPR`.
   *
   * Tipo 18, PELO SINAL, e a medição diz porquê. Auditoria da Principal,
   * 2024-01-01 a 2026-09-01:
   *
   *     estado C   175 docs   285 linhas   +1076 unidades
   *     estado A               23 linhas   +121
   *                            23 linhas   −121   → saldo 0
   *
   * Os documentos anulados chegam em pares simétricos. Com `peloSinal`
   * as duas metades classificam-se sozinhas — a positiva VENDA, a
   * negativa DEVOLUCAO_ANULACAO — e anulam-se exactamente, sem que seja
   * preciso olhar para o estado. Declarar 18 como `venda` faria as 23
   * negativas somarem; declará-lo como `reversao` faria as 285 positivas
   * subtrair. Qualquer das duas dá um total plausível e errado.
   *
   * Não há gate sobre `Fim Venda` nem sobre o estado, e é deliberado: o
   * `Fim Venda = 'S'` já foi refutado como classificador duas vezes. O
   * sinal basta, e a quantidade zero é recusada pelo próprio
   * `classificarDocumento`.
   */
  [NAMESPACES.VENDAS_CREDITO]: {
    venda: new Set<number>(),
    reversao: new Set<number>(),
    peloSinal: new Set([18]),
  },
  /**
   * Guias de transferência — `[Atendimento Credito]`, série `VCG_1`.
   *
   * Tipo 38, classificado PELO SINAL, como o circuito suspenso. Não é
   * uma escolha estética: resolve sozinho os dois casos observados.
   *
   *   · `Fim Venda = 'A'` tem quantidade ZERO — documentos anulados. Com
   *     `peloSinal`, zero é recusado, e nenhum deles se transforma numa
   *     venda artificial. Não é preciso gate nenhum sobre `Fim Venda`,
   *     que já foi refutado como classificador duas vezes.
   *   · uma guia estornada chega negativa e sai `DEVOLUCAO_ANULACAO`,
   *     em vez de somar na direcção errada.
   */
  [NAMESPACES.GUIAS_TRANSFERENCIA]: {
    venda: new Set<number>(),
    reversao: new Set<number>(),
    peloSinal: new Set([38]),
  },
};

/**
 * Como se lê uma guia de transferência.
 *
 * ── PORQUE É QUE ISTO ESTÁ VAZIO ─────────────────────────────────────
 *
 * Uma transferência tem dois lados. O relatório do SPharm é de VENDAS da
 * farmácia, e nada no nome da série diz qual dos lados ele conta: as
 * saídas, as entradas, ou as duas com sinal. As três leituras são
 * plausíveis e duas estão erradas.
 *
 * O gate mensal decide-o objectivamente — Silveirense 2026, Jan 3228,
 * Fev 2168, Mar 1760, Abr 2266, Mai 2853, Jun 2789, Jul 4617 — e
 * `vendas-extra-discover` calcula as quatro leituras contra ele com
 * tolerância zero.
 *
 * Até esse comando correr contra o ERP, isto fica por declarar e o
 * reader recusa-se a correr. Um reader que soma o lado errado produz um
 * total plausível e errado, que é a forma de erro que este projecto já
 * pagou três vezes: o 77, o `Fim Venda='S'`, e o 107 sem sinal.
 *
 * ── O QUE PREENCHER, DEPOIS DA DESCOBERTA ────────────────────────────
 *
 *   direccao : a leitura marcada com ★ no output da §2.4
 *   series   : as séries que essa leitura abrange (vazio = todas)
 *
 * E preferir uma propriedade ESTRUTURAL à série sempre que exista: se o
 * cabeçalho expuser origem/destino ou um tipo de documento que separe as
 * duas direcções, é isso que deve entrar aqui, porque um nome de série
 * muda entre instalações e uma FK não.
 */
/**
 * O que cada SÉRIE do circuito `[Atendimento Credito]` significa.
 *
 * ── PORQUE É QUE A TABELA NÃO DECIDE ─────────────────────────────────
 *
 * A tabela chama-se `Atendimento Credito`. Na Silveirense, os documentos
 * da série `VCG_1` que lá vivem NÃO são vendas a crédito — são guias de
 * transferência. Isto é conhecimento funcional do operador, confirmado, e
 * prevalece sobre o nome físico: um nome de tabela é uma escolha de quem
 * a criou, e a semântica é de quem a usa.
 *
 * Se a natureza fosse derivada da tabela, as guias entravam no mapa
 * sempre que alguém ligasse "vendas a crédito" — e a Silveirense, que não
 * emite crédito nenhum, veria 3 228 unidades aparecer em Janeiro com esse
 * interruptor. Por isso a natureza decide-se POR LINHA, pela série.
 *
 * ── PROVA QUANTITATIVA ───────────────────────────────────────────────
 *
 * A população `VCG_1` é exactamente a diferença entre os dois modos do
 * relatório oficial, nos sete meses, com desvio zero:
 *
 *     mes   NORMAL   +VCG_1    oficial COM guias
 *     Jan    13 270   3 228          16 498
 *     Fev    11 547   2 168          13 715
 *     Mar    13 397   1 760          15 157
 *     Abr    12 652   2 266          14 918
 *     Mai    13 204   2 853          16 057
 *     Jun    12 380   2 789          15 169
 *     Jul    14 120   4 617          18 737
 *
 * ── O VCC_1 (rev79) ──────────────────────────────────────────────────
 *
 * Entrou por MEDIÇÃO, não por analogia. A rev77 recusou-o precisamente
 * porque "parece-se com o VCG_1" era o mesmo argumento que declarou o
 * 77, o `Fim Venda='S'` e o 107 sem sinal. O que a auditoria da rev79
 * mediu na Segurado, e que a semelhança não dava:
 *
 *     652 documentos, 2 937 linhas, 7 741 unidades líquidas
 *     EXCLUSIVAMENTE tipo 38
 *     contraparte FIXA: ClienteID 259 / ArmazemID 1 "VSC"
 *
 * A contraparte fixa é o que fecha. Uma venda a crédito tem clientes —
 * plural, dispersos. Um destino único, sempre o mesmo armazém, é uma
 * transferência. E o espelho confirma-o: na Silveirense o `VCG_1` tem a
 * mesma forma com ClienteID 691 / ArmazemID 1 "f segurado" — cada
 * farmácia com um destino fixo que é a outra.
 *
 * ── O VOG CONTINUA DE FORA ───────────────────────────────────────────
 *
 * 2 linhas, tipo 64, um veículo automóvel +1/−1, líquido zero. Não é
 * venda nem transferência, e o tipo 64 NÃO é declarado em circuito
 * nenhum: as duas linhas continuam recusadas com a série no log. Volume
 * residual não é licença para adivinhar — uma série de 2 linhas
 * declarada por engano vale o mesmo erro que uma de 2 937, e a de 2
 * linhas ninguém a vai rever.
 */
export const SERIE_CIRCUITO_CREDITO: Readonly<Record<string, SourceNamespace>> = {
  VCG_1: NAMESPACES.GUIAS_TRANSFERENCIA,
  VCC_1: NAMESPACES.GUIAS_TRANSFERENCIA,
  /**
   * Principal (SPharm_Pais_Moreira) — factura a crédito, medida pela
   * auditoria de 2024-01-01 a 2026-09-01:
   *
   *     serie VCPR · Tipo Documento ID 18
   *     199 documentos · 331 linhas · 1076 unidades líquidas
   *
   * É venda a crédito e não guia de transferência, apesar de servir
   * saída de mercadoria para outras farmácias do grupo: o que a define é
   * o documento — uma factura, com contraparte e valor — e não o destino
   * físico. `VCG_1` e `VCC_1` não existem nesta base.
   */
  VCPR: NAMESPACES.VENDAS_CREDITO,
  /**
   * Nogueira — factura a crédito, confirmada funcionalmente. 203 linhas
   * recusadas no dry-run por a série não estar declarada.
   *
   * A série NÃO é a mesma em todas as farmácias do grupo: `VCPR` na
   * Principal, `VCF` aqui. É por isso que o mapa é por série e não uma
   * regra única — e é por isso que continua a ser fail-closed: a
   * próxima farmácia trará outra sigla, e o desfecho certo é ela
   * aparecer no log com o nome dela, não ser adivinhada.
   */
  VCF: NAMESPACES.VENDAS_CREDITO,
  /**
   * Garantia — factura a crédito, confirmada funcionalmente. 70 linhas
   * recusadas no dry-run da rev86 por a série não estar declarada.
   *
   * Terceira sigla em três farmácias do mesmo grupo, na mesma
   * instalação do ERP: `VCPR`, `VCF`, `VCGT`. O que a rev86 antecipou
   * — «a próxima farmácia trará outra sigla» — aconteceu à primeira
   * farmácia seguinte. É a confirmação de que a série é escolha local
   * de quem configurou cada balcão, e não um código do produto: não há
   * padrão a inferir, só um mapa a alimentar por medição.
   *
   * O fail-closed é o que torna isto barato: cada nova farmácia
   * anuncia a sua sigla no log, com a contagem, em vez de a fazer
   * entrar silenciosamente no balde errado.
   */
  VCGT: NAMESPACES.VENDAS_CREDITO,
};

/**
 * O namespace de uma linha do circuito `[Atendimento Credito]`, dada a
 * sua série. `null` = série por declarar, e a linha é recusada.
 */
export function namespaceDaSerieCredito(serie: string | null): SourceNamespace | null {
  const s = (serie ?? "").trim().toUpperCase();
  if (!s) return null;
  return SERIE_CIRCUITO_CREDITO[s] ?? null;
}

export type DireccaoTransferencia = "SAIDAS" | "ENTRADAS" | "AMBAS_SINAL" | "AMBAS_ABS";

export type RegraTransferencia = {
  /** `null` = por declarar. O reader recusa-se a correr. */
  direccao: DireccaoTransferencia | null;
  /** Séries abrangidas. Vazio = todas as do universo de transferências. */
  series: readonly string[];
  /** De onde veio esta declaração. Para não se perder a proveniência. */
  evidencia: string;
};

export const REGRA_TRANSFERENCIA: RegraTransferencia = {
  direccao: null,
  series: [],
  evidencia: "por declarar — correr `vendas-extra-discover` e usar a leitura marcada com ★",
};

/**
 * A classe de uma linha, dado o tipo de documento, o circuito de onde
 * veio e a quantidade. Fail-closed: o que não está declarado é recusado.
 *
 * ── PORQUE É QUE A QUANTIDADE É UM ARGUMENTO ─────────────────────────
 *
 * Porque no circuito suspenso ela é a única coisa que distingue uma
 * factura da sua anulação. Passá-la depois — classificar primeiro e
 * corrigir o sinal a seguir — seria ter duas fontes de verdade sobre a
 * mesma linha, que é como se instalam as divergências silenciosas.
 *
 * ── PORQUE É QUE O DESCONHECIDO NÃO É VENDA ──────────────────────────
 *
 * A primeira versão disto devolvia `VENDA` para tudo o que não fosse
 * reversão. Parece conservador e é o contrário: se um tipo de nota de
 * crédito não estivesse na lista, cada NC passava a venda e o total
 * subia em vez de descer — um erro que soma na direcção errada e
 * continua a parecer plausível durante meses.
 *
 * Uma linha recusada é contada e o número do tipo aparece no log. É o
 * único desfecho que não se perde: uma linha mal classificada entra na
 * soma e desaparece; uma linha recusada fica a apontar para si própria.
 */
export function classificarDocumento(
  tipoDocumento: number | null,
  sourceNamespace: SourceNamespace,
  quantidade: number | null,
): ClasseVenda | null {
  if (tipoDocumento === null) return null;
  const regras = CLASSIFICACAO[sourceNamespace];
  if (!regras) return null;

  // A classe que é propriedade do tipo decide-se primeiro e ignora o
  // sinal: uma NC do circuito G chega negativa e continua a ser NC.
  if (regras.reversao.has(tipoDocumento)) return "DEVOLUCAO_ANULACAO";
  if (regras.venda.has(tipoDocumento)) return "VENDA";

  if (regras.peloSinal.has(tipoDocumento)) {
    // Sem quantidade não há sinal, e sem sinal não há classe. Devolver
    // `VENDA` por defeito era transformar cada anulação por ler numa
    // venda — exactamente a direcção de erro que não se detecta.
    if (quantidade === null || !Number.isFinite(quantidade)) return null;
    if (quantidade > 0) return "VENDA";
    if (quantidade < 0) return "DEVOLUCAO_ANULACAO";
    // Zero não é venda nem anulação: é uma linha sem operação. Entra no
    // relatório de recusadas, onde se vê, em vez de somar zero em
    // silêncio numa classe que não lhe pertence.
    return null;
  }

  return null;
}

/**
 * O sinal da quantidade, dada a classe.
 *
 * ── APLICADO UMA VEZ, SEJA QUAL FOR O SINAL DE ORIGEM ────────────────
 *
 * `Math.abs` antes de decidir o sinal torna isto idempotente, e isso não
 * é elegância: as notas de crédito do circuito G chegam de
 * `[Atendimento Detalhe]` já NEGATIVAS. Sem o `abs`, uma NC de −2 saía
 * `−(−2) = +2` e a devolução passava a venda. Com ele, `−|−2| = −2`
 * tanto na primeira passagem como em qualquer outra.
 *
 * A agregação (`SQL_QUANTIDADE_ASSINADA`) faz o mesmo `ABS()` por
 * classe, portanto os dois lados concordam e o sinal nunca é aplicado
 * duas vezes — mesmo que a linha volte a passar aqui num re-upload.
 */
export function assinarQuantidade(qtd: number, classe: ClasseVenda): number {
  const abs = Math.abs(qtd);
  return classe === "DEVOLUCAO_ANULACAO" ? -abs : abs;
}

/** "VSG" + 54688 → "VSG/54688". Null se faltar uma das peças. */
export function comporDocumento(
  serie: string | null,
  numero: number | string | null,
): string | null {
  const s = (serie ?? "").toString().trim();
  const n = numero === null || numero === undefined ? NaN : Number(numero);
  if (!s || !Number.isFinite(n)) return null;
  return `${s}/${Math.trunc(n)}`;
}

// ─────────────────────────────────────────────────────────────────────
// Descoberta de schema
// ─────────────────────────────────────────────────────────────────────

type Coluna = { column: string };

/** Colunas reais de uma tabela, ou `null` se a tabela não existir. */
async function colunasDe(pool: SqlPool, tabela: string): Promise<Coluna[] | null> {
  const r = await pool
    .request()
    .input("t", tabela)
    .query<{ column: string }>(
      `SELECT c.name AS [column]
         FROM sys.columns c
         JOIN sys.objects o ON o.object_id = c.object_id
        WHERE o.name = @t AND o.type = 'U'`,
    );
  return r.recordset.length > 0 ? r.recordset : null;
}

/** A primeira coluna cujo nome bate num dos padrões. */
function escolher(cols: Coluna[] | null, padroes: RegExp[]): string | null {
  if (!cols) return null;
  for (const re of padroes) {
    const m = cols.find((c) => re.test(c.column));
    if (m) return m.column;
  }
  return null;
}

/** `[Nome Com Espaços]`. Null passa a null para o builder emitir NULL. */
function bk(col: string | null): string | null {
  return col ? `[${col}]` : null;
}

/**
 * A coluna de `tabela` que o ERP DECLARA apontar para `tabelaAlvo`.
 *
 * ── PORQUE É QUE ISTO NÃO PODE SER FEITO POR NOME ────────────────────
 *
 * `[Atendimento Susp Detalhe]` tem uma coluna chamada `Atendimento ID`.
 * Parece a ligação ao documento e não é: das 40 664 linhas, 11 868
 * resolviam contra `[Atendimento]` e NENHUMA passava o filtro que o
 * reader aplicava. A ligação documental verdadeira é
 * `Atendimento Susp ID -> [Atendimento Susp]`, e está DECLARADA como
 * chave estrangeira desde sempre.
 *
 * Um nome parecido é uma coincidência; uma FK é uma afirmação do
 * esquema. Perguntar a `sys.foreign_key_columns` custa uma query e é a
 * diferença entre ler o documento certo e ler zero linhas.
 */
async function fkDeclaradaPara(
  pool: SqlPool,
  tabela: string,
  tabelaAlvo: string,
): Promise<string | null> {
  const r = await pool
    .request()
    .input("t", tabela)
    .input("alvo", tabelaAlvo)
    .query<{ coluna: string }>(
      `SELECT pc.name AS coluna
         FROM sys.foreign_key_columns fkc
         JOIN sys.objects o  ON o.object_id  = fkc.parent_object_id
         JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id
                            AND pc.column_id = fkc.parent_column_id
         JOIN sys.objects ro ON ro.object_id = fkc.referenced_object_id
        WHERE o.name = @t AND ro.name = @alvo`,
    );
  return r.recordset[0]?.coluna ?? null;
}

export type SchemaFonteSusp = {
  /** A tabela existe nesta instalação. */
  existe: boolean;
  tabela: string;
  pk: string | null;
  /**
   * A FK DECLARADA para `[Atendimento Susp]` — a ligação documental.
   * Vem de `sys.foreign_key_columns`, nunca do nome da coluna.
   */
  cabecalhoFk: string | null;
  codigoId: string | null;
  sequencia: string | null;
  quantidade: string | null;
  pvpUnitario: string | null;
  valorLinha: string | null;
  ivaValor: string | null;
  descontoValor: string | null;
  comparticipacao1: string | null;
  comparticipacao2: string | null;
  entidadeId: string | null;
  dataVenda: string | null;
};

const TABELA_SUSP = "Atendimento Susp Detalhe";
const TABELA_CABECALHO_SUSP = "Atendimento Susp";

/** As colunas documentais de `[Atendimento Susp]`, o cabeçalho da VSG. */
export type SchemaCabecalhoSusp = {
  existe: boolean;
  tabela: string;
  pk: string | null;
  serie: string | null;
  numero: string | null;
  tipoDocumento: string | null;
  dataVenda: string | null;
  totalBruto: string | null;
};

/**
 * Descobre `[Atendimento Susp]`.
 *
 * É este o cabeçalho da venda suspensa — não o `[Atendimento]`. Carrega
 * `SerieFacturacao`, `Numero Documento`, `Tipo Documento ID`,
 * `Data Venda` e `Total Bruto_EUR`, e é de onde vem tudo o que
 * identifica o documento.
 *
 * `Fim Venda` NÃO é lido. Existe na tabela, e não serve para classificar:
 * as duas vendas confirmadas do ERP têm `N`, e no mesmo dia há VSG tipo
 * 107 com `N` e com `S`. Filtrar por ele devolvia zero.
 */
export async function descobrirCabecalhoSusp(pool: SqlPool): Promise<SchemaCabecalhoSusp> {
  const cols = await colunasDe(pool, TABELA_CABECALHO_SUSP);
  return {
    existe: cols !== null,
    tabela: TABELA_CABECALHO_SUSP,
    pk: escolher(cols, [/^atendimento\s*susp\s*id$/i, /^susp\s*id$/i]),
    serie: escolher(cols, [/^serie\s*facturacao$/i, /^seriefacturacao$/i, /^serie$/i]),
    numero: escolher(cols, [/^numero\s*documento$/i, /^numero$/i]),
    tipoDocumento: escolher(cols, [/^tipo\s*documento\s*id$/i, /^tipo\s*documento$/i]),
    dataVenda: escolher(cols, [/^data\s*venda$/i, /^data$/i]),
    totalBruto: escolher(cols, [/^total\s*bruto_eur$/i, /^total\s*bruto$/i]),
  };
}

/**
 * Descobre as colunas de `[Atendimento Susp Detalhe]`.
 *
 * Os padrões vêm dos nomes conhecidos em `[Atendimento Detalhe]` e das
 * variações que o Softreis usa (com e sem sufixo `_EUR`, com e sem
 * espaços). Uma coluna que não apareça fica `null` e o SELECT emite
 * `NULL` — a linha entra com esse campo vazio em vez de a query rebentar.
 *
 * A EXCEPÇÃO é `cabecalhoFk`: essa não é adivinhada por nome nenhum. Vem
 * da FK declarada, porque foi exactamente aí que a versão anterior
 * escolheu a coluna errada.
 */
export async function descobrirSchemaSusp(pool: SqlPool): Promise<SchemaFonteSusp> {
  const cols = await colunasDe(pool, TABELA_SUSP);
  const cabecalhoFk = cols
    ? await fkDeclaradaPara(pool, TABELA_SUSP, TABELA_CABECALHO_SUSP)
    : null;
  return {
    existe: cols !== null,
    tabela: TABELA_SUSP,
    pk: escolher(cols, [
      /^atendimento\s*susp\s*detalhe\s*id$/i,
      /^susp\s*detalhe\s*id$/i,
      /^detalhe\s*susp\s*id$/i,
      /^detalhe\s*id$/i,
    ]),
    cabecalhoFk,
    codigoId: escolher(cols, [/^codigo\s*id$/i, /^codigoid$/i]),
    sequencia: escolher(cols, [/^sequencia$/i, /^seq$/i]),
    quantidade: escolher(cols, [/^quantidade$/i, /^qtd$/i]),
    pvpUnitario: escolher(cols, [
      /^preco\s*venda\s*publico_eur$/i,
      /^preco\s*venda\s*publico$/i,
      /^pvp_eur$/i,
      /^pvp$/i,
    ]),
    valorLinha: escolher(cols, [/^valor_eur$/i, /^valor$/i]),
    ivaValor: escolher(cols, [/^val_iva_eur$/i, /^val_iva$/i, /^iva$/i]),
    descontoValor: escolher(cols, [/^val_desc_eur$/i, /^val_desc$/i, /^desconto$/i]),
    comparticipacao1: escolher(cols, [/^prcomp_eur$/i, /^prcomp$/i]),
    comparticipacao2: escolher(cols, [/^prcomp_eur2$/i, /^prcomp2$/i]),
    entidadeId: escolher(cols, [/^entidade\s*id$/i]),
    // Algumas instalações datam a própria linha; quando não, usa-se a
    // data do cabeçalho.
    dataVenda: escolher(cols, [/^data\s*venda$/i, /^data$/i]),
  };
}

/** Uma linha da fonte, tal como o SQL a devolve. */
export type FonteRow = {
  externalLineId: number;
  externalDocumentId: number | null;
  sequencia: number | null;
  dataVenda: Date | null;
  tipoDocumento: number | null;
  serie: string | null;
  numero: number | string | null;
  externalProductId: number;
  processaStocks: unknown;
  quantidade: unknown;
  pvpUnitario: unknown;
  valorLinha: unknown;
  ivaValor: unknown;
  descontoValor: unknown;
  comparticipacao1: unknown;
  comparticipacao2: unknown;
  entidadeId: number | null;
};

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function bool(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v;
  const n = Number(v);
  if (Number.isFinite(n)) return n !== 0;
  return null;
}

function txt(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

/**
 * `FonteRow` → `LinhaVendaCanonica`.
 *
 * Devolve `null` — e a razão — quando a linha não é representável. Uma
 * linha sem produto ou sem tipo de documento classificável não deve
 * entrar em silêncio: o caller conta-a e reporta-a.
 */
export function normalizar(
  r: FonteRow,
  sourceNamespace: SourceNamespace,
): { linha: LinhaVendaCanonica } | { erro: string } {
  const externalLineId = num(r.externalLineId);
  if (externalLineId === null) return { erro: "sem externalLineId" };

  const externalProductId = num(r.externalProductId);
  if (externalProductId === null) return { erro: "sem CodigoID" };

  const tipoDocumento = num(r.tipoDocumento);
  // A quantidade é lida ANTES de classificar porque no circuito suspenso
  // é ela que decide a classe. `num` devolve `null` quando não há
  // quantidade legível — e aí o classificador recusa, em vez de a tratar
  // como zero e depois como venda.
  const quantidade = num(r.quantidade);
  const classe = classificarDocumento(tipoDocumento, sourceNamespace, quantidade);
  if (classe === null) {
    const porque =
      quantidade === 0
        ? " (quantidade zero — sem operação)"
        : quantidade === null
          ? " (sem quantidade legível)"
          : "";
    return {
      erro: `tipo de documento por classificar em ${sourceNamespace}: ${tipoDocumento ?? "(nulo)"}${porque}`,
    };
  }

  const qtd = quantidade ?? 0;
  const serie = txt(r.serie);

  return {
    linha: {
      sourceNamespace,
      externalLineId,
      externalDocumentId: num(r.externalDocumentId),
      serie,
      documento: comporDocumento(serie, r.numero),
      tipoDocumento,
      classe,
      natureza: naturezaDe(sourceNamespace),
      quantidadeAssinada: assinarQuantidade(qtd, classe),
      pvpUnitario: num(r.pvpUnitario),
      valorBruto: num(r.valorLinha),
      ivaValor: num(r.ivaValor),
      descontoValor: num(r.descontoValor),
      comparticipacao1: num(r.comparticipacao1),
      comparticipacao2: num(r.comparticipacao2),
      dataVenda:
        r.dataVenda instanceof Date && !Number.isNaN(r.dataVenda.getTime())
          ? r.dataVenda.toISOString()
          : null,
      externalProductId,
      processaStocks: bool(r.processaStocks),
      entidadeId: num(r.entidadeId),
      sequencia: num(r.sequencia),
    },
  };
}

/** O payload que segue para `/api/ingest/v1/bootstrap/sales-lines`. */
export function paraPayload(l: LinhaVendaCanonica): Record<string, unknown> {
  return {
    sourceNamespace: l.sourceNamespace,
    externalSaleLineId: l.externalLineId,
    externalSaleId: l.externalDocumentId,
    serie: l.serie,
    documento: l.documento,
    sequencia: l.sequencia,
    dataVenda: l.dataVenda,
    tipoDocumento: l.tipoDocumento,
    tipoDocumentoClass: l.classe,
    // A natureza viaja com a linha. Sem ela, o servidor teria de a
    // inferir do namespace — e uma inferência duplicada é uma
    // divergência à espera de acontecer.
    naturezaVenda: l.natureza,
    externalProductId: l.externalProductId,
    processaStocks: l.processaStocks,
    // A quantidade viaja ASSINADA. O servidor não volta a decidir o
    // sinal: a semântica documental é do lado que leu o documento.
    quantidade: l.quantidadeAssinada,
    pvpUnitario: l.pvpUnitario,
    valorLinha: l.valorBruto,
    ivaValor: l.ivaValor,
    descontoValor: l.descontoValor,
    comparticipacao1: l.comparticipacao1,
    comparticipacao2: l.comparticipacao2,
    entidadeId: l.entidadeId,
  };
}

// ─────────────────────────────────────────────────────────────────────
// SQL por fonte
// ─────────────────────────────────────────────────────────────────────

/**
 * Série e número do cabeçalho, mais o tipo de documento.
 *
 * Descobertos dinamicamente porque `Atendimento` também varia entre
 * instalações — é o mesmo conjunto que o `stocksmov` já resolve para
 * compor "G/783019".
 */
export type SchemaAtendimento = {
  serie: string | null;
  numero: string | null;
  tipoDocumento: string | null;
  dataVenda: string | null;
  fimVenda: string | null;
};

export async function descobrirSchemaAtendimento(pool: SqlPool): Promise<SchemaAtendimento> {
  const cols = await colunasDe(pool, "Atendimento");
  return {
    serie: escolher(cols, [/^serie$/i, /^serie\s*documento$/i]),
    numero: escolher(cols, [/^numero$/i, /^n\s*documento$/i, /^numero\s*documento$/i]),
    tipoDocumento: escolher(cols, [/^tipo\s*documento$/i]),
    dataVenda: escolher(cols, [/^data\s*venda$/i]),
    fimVenda: escolher(cols, [/^fim\s*venda$/i]),
  };
}

/**
 * Um item da lista do SELECT. SEM vírgula: quem sabe se é o último é
 * quem junta a lista, não quem produz o item.
 *
 * ── O DEFEITO QUE ISTO TEVE ──────────────────────────────────────────
 *
 * A primeira versão devolvia a linha e o builder juntava tudo com "\n".
 * Sem vírgula nenhuma. O SQL Server responde "Incorrect syntax near 'a'"
 * — o token a seguir a `AS externalLineId` — e o pipeline de vendas
 * morria antes de ler uma única linha, nas DUAS fontes.
 *
 * Passou nos testes porque eles verificavam `sql.includes(fragmento)`, e
 * cada fragmento estava lá. Fragmentos correctos não fazem uma query
 * correcta: só a query inteira é que é a query. É por isso que agora há
 * um teste da string completa e um validador estrutural.
 */
function sel(alias: string, expr: string | null): string {
  return `    ${expr ?? "NULL"} AS ${alias}`;
}

/** A lista do SELECT, com as vírgulas onde têm de estar. */
function listaSelect(itens: string[]): string {
  return itens.join(",\n");
}

/**
 * SQL da venda de balcão. É a query que já existia, com série e número
 * acrescentados — o resto é idêntico, de propósito: esta fonte já
 * funcionava e não é para mudar de comportamento.
 */
/**
 * Os estados de `[Fim Venda]` que correspondem a uma venda concretizada
 * no circuito G.
 *
 * ── O DEFEITO QUE ISTO CORRIGE ───────────────────────────────────────
 *
 * O reader tinha `WHERE a.[Fim Venda] = 'S'`, escrito à mão, sem nunca
 * ter sido medido. Deixava de fora todos os documentos com `U` — que são
 * vendas reais de TipoDoc 7, com produto e quantidade positiva:
 *
 *     2026-08-19  doc 819893  TipoDoc 7  Fim Venda U  qtd  2
 *     2026-08-18  doc 819565  TipoDoc 7  Fim Venda U  qtd 10
 *
 * A assinatura mensal do que faltava bate 1:1 com o que o gate excluía:
 *
 *     mes    falta no SPharm.MT    TipoDoc 7 / U
 *     Jan          408                  407
 *     Fev          358                  358
 *     Mar          326                  326
 *     Abr          303                  302
 *     Mai          323                  323
 *     Jun          384                  384
 *     Jul          345                  346
 *
 * O `U` NÃO é venda a crédito nem transferência — essas são populações
 * com circuito próprio. É um estado dentro de uma venda TipoDoc 7 normal.
 *
 * ── PORQUE É QUE O `N` CONTINUA DE FORA ──────────────────────────────
 *
 * Porque S+U reproduz o relatório oficial e S+U+N não reproduziria nada
 * medido. Um documento por fechar não é uma venda concretizada. Se um dia
 * aparecer outro estado, ele aparece no relatório de excluídos — que é a
 * diferença entre este gate e o anterior: este VÊ-SE.
 */
export const ESTADOS_VENDA_G = ["S", "U"] as const;

/**
 * O predicado do estado, ou `null` quando a coluna não existe.
 *
 * Se `[Fim Venda]` não existir nesta instalação, NÃO se filtra: ler a
 * mais e reportar é recuperável; ler a menos em silêncio foi o que
 * custou 400 unidades por mês durante meses.
 */
export function filtroEstadoG(at: SchemaAtendimento): string | null {
  if (!at.fimVenda) return null;
  const lista = ESTADOS_VENDA_G.map((e) => `'${e}'`).join(", ");
  return `a.${bk(at.fimVenda)} IN (${lista})`;
}

export function sqlAtendimentoDetalhe(at: SchemaAtendimento): string {
  const estado = filtroEstadoG(at);
  return [
    "SELECT TOP (@n)",
    listaSelect([
      sel("externalLineId", "d.[Detalhe ID]"),
      sel("externalDocumentId", "a.[Atendimento ID]"),
      sel("sequencia", "d.[Sequencia]"),
      sel("dataVenda", "a.[Data Venda]"),
      sel("tipoDocumento", bk(at.tipoDocumento) ? `a.${bk(at.tipoDocumento)}` : null),
      sel("serie", at.serie ? `a.${bk(at.serie)}` : null),
      sel("numero", at.numero ? `a.${bk(at.numero)}` : null),
      sel("externalProductId", "d.[CodigoID]"),
      sel("processaStocks", "s.[Processa_Stocks]"),
      sel("quantidade", "d.[Quantidade]"),
      sel("pvpUnitario", "d.[Preco Venda Publico_EUR]"),
      sel("valorLinha", "d.[Valor_EUR]"),
      sel("ivaValor", "d.[Val_IVA_EUR]"),
      sel("descontoValor", "d.[Val_Desc_EUR]"),
      sel("comparticipacao1", "d.[PrComp_EUR]"),
      sel("comparticipacao2", "d.[PrComp_EUR2]"),
      sel("entidadeId", "d.[Entidade ID]"),
    ]),
    "  FROM [dbo].[Atendimento] a",
    "  JOIN [dbo].[Atendimento Detalhe] d ON d.[Atendimento ID] = a.[Atendimento ID]",
    "  LEFT JOIN [dbo].[Stocks] s ON s.CodigoID = d.[CodigoID]",
    " WHERE a.[Data Venda] >= @from AND a.[Data Venda] < @to",
    ...(estado ? [`   AND ${estado}`] : []),
    "   AND d.[Detalhe ID] > @lastId",
    " ORDER BY d.[Detalhe ID]",
  ].join("\n");
}

/**
 * Quantas linhas o gate de estado deixa de fora, por estado.
 *
 * Existe porque o gate anterior era invisível: excluía ~400 unidades por
 * mês e não havia nada, em lado nenhum, que o dissesse. Um filtro que não
 * reporta o que corta é indistinguível de dados que não existem.
 */
export function sqlDistribuicaoEstadoG(at: SchemaAtendimento): string | null {
  if (!at.fimVenda) return null;
  const col = `a.${bk(at.fimVenda)}`;
  const tipo = at.tipoDocumento ? `a.${bk(at.tipoDocumento)}` : "NULL";
  return [
    "SELECT " + col + " AS estado,",
    `       ${tipo} AS tipoDocumento,`,
    "       COUNT(*) AS linhas,",
    "       SUM(CAST(d.[Quantidade] AS FLOAT)) AS unidades",
    "  FROM [dbo].[Atendimento] a",
    "  JOIN [dbo].[Atendimento Detalhe] d ON d.[Atendimento ID] = a.[Atendimento ID]",
    " WHERE a.[Data Venda] >= @from AND a.[Data Venda] < @to",
    " GROUP BY " + col + ", " + tipo,
    " ORDER BY 1, 2",
  ].join("\n");
}

/**
 * SQL da venda suspensa.
 *
 * ── O QUE MUDOU, E PORQUÊ ────────────────────────────────────────────
 *
 * A versão anterior ligava-se ao `[Atendimento]` e filtrava
 * `[Fim Venda] = 'S'`. As duas coisas estavam erradas, e o ERP real
 * mostrou-o sem ambiguidade:
 *
 *   · o cabeçalho da VSG é `[Atendimento Susp]`, ligado pela FK
 *     declarada `Atendimento Susp ID`. É lá que estão `SerieFacturacao`,
 *     `Numero Documento`, `Tipo Documento ID`, `Data Venda`;
 *   · `[Fim Venda] = 'S'` devolvia ZERO linhas — e as duas vendas
 *     confirmadas (VSG/54684 e VSG/54688) têm `N`. O campo não separa
 *     facturada de não facturada; separa outra coisa qualquer, e não é
 *     usado aqui para nada.
 *
 * `INNER JOIN` ao cabeçalho: uma linha sem documento não é uma venda.
 * A regra fica no JOIN, visível, e não num `if` mais abaixo.
 *
 * Não há reader de reversões VSG, de propósito. As notas de crédito das
 * VSG vivem em `[Atendimento]`/`[Atendimento Detalhe]` — 107/107
 * verificadas — e o reader do circuito G já as lê. Um segundo reader
 * subtrairia a mesma NC duas vezes.
 */
export type ResultadoFonte =
  /** A tabela não existe nesta instalação. Saltar é correcto. */
  | { estado: "AUSENTE" }
  /**
   * A tabela EXISTE mas não se conseguiu ligar. Isto NÃO pode ser
   * saltado em silêncio: sabemos que ali dentro há vendas, e ignorá-las
   * é exactamente o defeito que esta ronda veio corrigir. O pipeline
   * pára e diz o que falta.
   */
  | { estado: "POR_LIGAR"; faltam: string[] }
  | { estado: "PRONTA"; sql: string };

export function sqlAtendimentoSuspDetalhe(
  susp: SchemaFonteSusp,
  cab: SchemaCabecalhoSusp,
): ResultadoFonte {
  if (!susp.existe) return { estado: "AUSENTE" };

  // Sem cabeçalho não há documento, e sem `Tipo Documento ID` não há
  // classificação. Uma fonte meio-ligada daria números errados em
  // silêncio — que é precisamente o que já aconteceu uma vez.
  const faltam = (
    [
      ["pk", susp.pk],
      [`FK declarada para [${cab.tabela}]`, susp.cabecalhoFk],
      ["CodigoID", susp.codigoId],
      ["quantidade", susp.quantidade],
      [`[${cab.tabela}]`, cab.existe ? "sim" : null],
      [`[${cab.tabela}].pk`, cab.pk],
      [`[${cab.tabela}].[Tipo Documento ID]`, cab.tipoDocumento],
      [`[${cab.tabela}].[Data Venda]`, cab.dataVenda],
    ] as const
  )
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (faltam.length > 0) return { estado: "POR_LIGAR", faltam };

  const pk = bk(susp.pk)!;
  const fk = bk(susp.cabecalhoFk)!;
  const cabPk = bk(cab.pk)!;
  const sql = [
    "SELECT TOP (@n)",
    listaSelect([
      sel("externalLineId", `d.${pk}`),
      sel("externalDocumentId", `h.${cabPk}`),
      sel("sequencia", susp.sequencia ? `d.${bk(susp.sequencia)}` : null),
      sel("dataVenda", `h.${bk(cab.dataVenda)}`),
      sel("tipoDocumento", `h.${bk(cab.tipoDocumento)}`),
      sel("serie", cab.serie ? `h.${bk(cab.serie)}` : null),
      sel("numero", cab.numero ? `h.${bk(cab.numero)}` : null),
      sel("externalProductId", `d.${bk(susp.codigoId)}`),
      sel("processaStocks", "s.[Processa_Stocks]"),
      sel("quantidade", susp.quantidade ? `d.${bk(susp.quantidade)}` : null),
      sel("pvpUnitario", susp.pvpUnitario ? `d.${bk(susp.pvpUnitario)}` : null),
      sel("valorLinha", susp.valorLinha ? `d.${bk(susp.valorLinha)}` : null),
      sel("ivaValor", susp.ivaValor ? `d.${bk(susp.ivaValor)}` : null),
      sel("descontoValor", susp.descontoValor ? `d.${bk(susp.descontoValor)}` : null),
      sel("comparticipacao1", susp.comparticipacao1 ? `d.${bk(susp.comparticipacao1)}` : null),
      sel("comparticipacao2", susp.comparticipacao2 ? `d.${bk(susp.comparticipacao2)}` : null),
      sel("entidadeId", susp.entidadeId ? `d.${bk(susp.entidadeId)}` : null),
    ]),
    `  FROM [dbo].[${susp.tabela}] d`,
    `  JOIN [dbo].[${cab.tabela}] h ON h.${cabPk} = d.${fk}`,
    `  LEFT JOIN [dbo].[Stocks] s ON s.CodigoID = d.${bk(susp.codigoId)}`,
    ` WHERE h.${bk(cab.dataVenda)} >= @from AND h.${bk(cab.dataVenda)} < @to`,
    `   AND d.${pk} > @lastId`,
    ` ORDER BY d.${pk}`,
  ].join("\n");
  return { estado: "PRONTA", sql };
}

/**
 * As colunas do circuito de crédito, resolvidas por ESTRUTURA.
 *
 * A rev75 procurou este universo por FK declarada e não o encontrou —
 * e concluiu que não existia. As tabelas existem; a FK é que não. Aqui
 * a ligação é `detalhe.[Atendimento Credito ID] = cabecalho.[…]`, uma
 * coluna comum às duas tabelas, e a FK entra como confirmação quando
 * existir.
 */
export type SchemaFonteCredito = {
  existe: boolean;
  cabecalhoTabela: string | null;
  detalheTabela: string | null;
  cabecalhoPk: string | null;
  detalhePk: string | null;
  chaveLigacao: string | null;
  data: string | null;
  serie: string | null;
  numero: string | null;
  tipoDocumento: string | null;
  /** `Fim Venda`. DADO, nunca filtro — o zero trata dos anulados. */
  estado: string | null;
  codigoId: string | null;
  quantidade: string | null;
  pvpUnitario: string | null;
  valorLinha: string | null;
  ivaValor: string | null;
  entidadeId: string | null;
  sequencia: string | null;
  /**
   * Todas as tabelas com "credito" no nome. Vai para a mensagem de erro:
   * um `POR_LIGAR` que não diz onde procurou custa uma ronda.
   */
  candidatas: string[];
};

/**
 * SQL da venda a crédito.
 *
 * Mesmo contrato de alias que as outras duas fontes — é isso que faz
 * `normalizar()` funcionar sem saber de onde a linha veio.
 */
export function sqlAtendimentoCredito(c: SchemaFonteCredito): ResultadoFonte {
  if (!c.existe) return { estado: "AUSENTE" };
  const faltam = (
    [
      ["tabela de cabecalho", c.cabecalhoTabela],
      ["tabela de detalhe", c.detalheTabela],
      ["pk do cabecalho", c.cabecalhoPk],
      ["pk do detalhe", c.detalhePk],
      ["chave de ligacao detalhe->cabecalho", c.chaveLigacao],
      ["data", c.data],
      ["CodigoID", c.codigoId],
      ["quantidade", c.quantidade],
      ["tipo de documento", c.tipoDocumento],
      // A serie decide a natureza da linha. Sem ela, todas as linhas
      // deste circuito seriam recusadas em silencio — pior do que parar.
      ["serie", c.serie],
    ] as const
  )
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (faltam.length > 0) {
    // ONDE procurou, e não só o que faltou. A rev77 disse
    // "Faltam: data, tipo de documento" sobre um cabeçalho errado, e
    // sem esta linha não havia como saber que a tabela é que estava mal
    // escolhida.
    return {
      estado: "POR_LIGAR",
      faltam: [
        ...faltam,
        `(cabecalho escolhido: ${c.cabecalhoTabela ?? "-"}, detalhe: ${c.detalheTabela ?? "-"}` +
          `, candidatas: ${c.candidatas.join(" | ") || "nenhuma"})`,
      ],
    };
  }

  const pk = bk(c.detalhePk)!;
  const lig = bk(c.chaveLigacao)!;
  const sqlTexto = [
    "SELECT TOP (@n)",
    listaSelect([
      sel("externalLineId", `d.${pk}`),
      sel("externalDocumentId", `h.${bk(c.cabecalhoPk)}`),
      sel("sequencia", c.sequencia ? `d.${bk(c.sequencia)}` : null),
      sel("dataVenda", `h.${bk(c.data)}`),
      sel("tipoDocumento", `h.${bk(c.tipoDocumento)}`),
      sel("serie", c.serie ? `h.${bk(c.serie)}` : null),
      sel("numero", c.numero ? `h.${bk(c.numero)}` : null),
      sel("externalProductId", `d.${bk(c.codigoId)}`),
      sel("processaStocks", "s.[Processa_Stocks]"),
      sel("quantidade", `d.${bk(c.quantidade)}`),
      sel("pvpUnitario", c.pvpUnitario ? `d.${bk(c.pvpUnitario)}` : null),
      sel("valorLinha", c.valorLinha ? `d.${bk(c.valorLinha)}` : null),
      sel("ivaValor", c.ivaValor ? `d.${bk(c.ivaValor)}` : null),
      sel("descontoValor", null),
      sel("comparticipacao1", null),
      sel("comparticipacao2", null),
      sel("entidadeId", c.entidadeId ? `d.${bk(c.entidadeId)}` : null),
    ]),
    `  FROM [dbo].[${c.detalheTabela}] d`,
    `  JOIN [dbo].[${c.cabecalhoTabela}] h ON h.${lig} = d.${lig}`,
    `  LEFT JOIN [dbo].[Stocks] s ON s.CodigoID = d.${bk(c.codigoId)}`,
    ` WHERE h.${bk(c.data)} >= @from AND h.${bk(c.data)} < @to`,
    `   AND d.${pk} > @lastId`,
    ` ORDER BY d.${pk}`,
  ].join("\n");
  return { estado: "PRONTA", sql: sqlTexto };
}

/**
 * Uma fonte de venda, como os pipelines a consomem.
 *
 * `namespacePorLinha` existe porque uma tabela pode conter mais do que
 * uma natureza: `[Atendimento Credito]` tem guias de transferência
 * (`VCG_1`) e, noutras instalações, possivelmente crédito real. Quem
 * decide é a série de cada linha, não a tabela.
 */
export type FonteVenda = {
  namespace: SourceNamespace;
  rotulo: string;
  fonte: ResultadoFonte;
  namespacePorLinha?: (row: FonteRow) => SourceNamespace | null;
};

/** A série de uma linha, normalizada. Exportada para os dois pipelines. */
export function txtSerie(v: unknown): string | null {
  return txt(v);
}

/**
 * AS FONTES DE VENDA. Um sítio só, para o backfill e para o diário.
 *
 * ── PORQUE É UMA FUNÇÃO E NÃO DOIS LITERAIS ──────────────────────────
 *
 * Porque eram dois literais. `bootstrap-upload` e `daily-sync-runner`
 * declaravam a mesma lista, palavra por palavra, e mantinham-se iguais
 * por disciplina — que é a mesma disciplina que deixou o
 * `Fim Venda = 'S'` em seis sítios e o `if (t === 77)` em três. Quando
 * divergem, o histórico fica certo e cada noite volta a divergir: o
 * modo de falha mais caro que este projecto teve.
 *
 * A rev79 acrescentou o `VCC_1` a `SERIE_CIRCUITO_CREDITO`. Com dois
 * literais, essa declaração chegaria aos dois caminhos só porque ambos
 * chamam `namespaceDaSerieCredito` — verdade hoje, e uma coincidência
 * que ninguém verifica amanhã. Com uma função, chega por construção.
 */
export function fontesDeVenda(
  at: SchemaAtendimento,
  susp: SchemaFonteSusp,
  cab: SchemaCabecalhoSusp,
  credito: SchemaFonteCredito,
): FonteVenda[] {
  return [
    // O circuito de balcão tem DUAS naturezas na mesma tabela: a venda
    // normal e a factura a crédito (tipo 4). O tipo decide, como a série
    // decide no circuito de crédito — mesmo mecanismo, mesma razão.
    {
      namespace: NAMESPACES.ATENDIMENTO_DETALHE,
      rotulo: "Atendimento Detalhe",
      fonte: { estado: "PRONTA", sql: sqlAtendimentoDetalhe(at) },
      namespacePorLinha: (row) =>
        Number(row.tipoDocumento) === TIPO_FACTURA_CREDITO_BALCAO
          ? NAMESPACES.ATENDIMENTO_DETALHE_CREDITO
          : NAMESPACES.ATENDIMENTO_DETALHE,
    },
    {
      namespace: NAMESPACES.ATENDIMENTO_SUSP_DETALHE,
      rotulo: "Atendimento Susp Detalhe",
      fonte: sqlAtendimentoSuspDetalhe(susp, cab),
    },
    // O circuito `[Atendimento Credito]`. A natureza de cada linha vem
    // da SÉRIE, não da tabela: `VCG_1` (Silveirense) e `VCC_1`
    // (Segurado) são guias de transferência, ambas medidas com destino
    // fixo na outra farmácia. Uma série por declarar — o `VOG` — é
    // recusada com o nome dela no log.
    {
      namespace: NAMESPACES.GUIAS_TRANSFERENCIA,
      rotulo: "Atendimento Credito (serie decide a natureza)",
      fonte: sqlAtendimentoCredito(credito),
      namespacePorLinha: (row) => namespaceDaSerieCredito(txtSerie(row.serie)),
    },
  ];
}

/**
 * Descobre o circuito `[Atendimento Credito]` por ESTRUTURA.
 *
 * Não por FK: a rev75 procurou-o por `sys.foreign_key_columns`, não
 * encontrou a constraint, e concluiu que o universo não existia. As
 * tabelas existem — a FK é que não.
 */
/**
 * Uma coluna, resolvida por NOME EXACTO primeiro e por padrão depois.
 *
 * Os nomes exactos são os observados em ERP real. Não são o único
 * caminho — se faltarem, os padrões apanham as variações conhecidas do
 * Softreis — mas são o primeiro, porque um nome medido vale mais do que
 * um padrão que também casa noutra coluna qualquer.
 */
export function resolverColuna(
  cols: Coluna[] | null,
  exactos: readonly string[],
  padroes: readonly RegExp[] = [],
): string | null {
  if (!cols) return null;
  for (const nome of exactos) {
    const m = cols.find((c) => c.column.toLowerCase() === nome.toLowerCase());
    if (m) return m.column;
  }
  return escolher(cols, [...padroes]);
}

/** Um par cabeçalho/detalhe candidato, e o que nele resolveu. */
type ParCredito = {
  cabecalho: string;
  detalhe: string;
  colsCab: Coluna[];
  colsDet: Coluna[];
  chaveLigacao: string;
  pontos: number;
};

/**
 * Descobre o circuito `[Atendimento Credito]` por ESTRUTURA.
 *
 * ── O DEFEITO DA REV77 ───────────────────────────────────────────────
 *
 * A rev77 abortou o bootstrap da Silveirense com
 * `Faltam: data, tipo de documento` — numa base onde a rev76 já tinha
 * impresso `data = Data Venda` e `tipoDoc = Tipo Documento ID`.
 *
 * A causa não estava nos padrões das colunas: estava na escolha da
 * TABELA. O resolver fazia
 *
 *     comCredito.find((n) => !/detalhe/i.test(n))
 *
 * sobre um `SELECT` de `sys.tables` SEM `ORDER BY`. Qualquer outra
 * tabela com "credito" no nome — e o ERP tem várias — podia ser
 * devolvida primeiro e ser escolhida como cabeçalho. E como o padrão da
 * PK (`/credito\s*id$/i`) não estava ancorado, uma coluna qualquer
 * terminada em "Credito ID" fazia o par parecer válido. O resultado é
 * um cabeçalho errado onde `Data Venda` naturalmente não existe.
 *
 * A correcção é emparelhar por ESTRUTURA em vez de por ordem de
 * chegada: um par só é candidato se o detalhe tiver produto e
 * quantidade, o cabeçalho tiver data, e os dois partilharem a chave de
 * ligação. Entre os candidatos válidos ganha o que resolve mais campos.
 */
export async function descobrirSchemaCredito(pool: SqlPool): Promise<SchemaFonteCredito> {
  const vazio: SchemaFonteCredito = {
    existe: false, cabecalhoTabela: null, detalheTabela: null, cabecalhoPk: null,
    detalhePk: null, chaveLigacao: null, data: null, serie: null, numero: null,
    tipoDocumento: null, estado: null, codigoId: null, quantidade: null,
    pvpUnitario: null, valorLinha: null, ivaValor: null, entidadeId: null,
    sequencia: null, candidatas: [],
  };

  const r = await pool.request().query<{ nome: string }>(
    // ORDER BY para a escolha ser determinística. Sem ele, duas corridas
    // na mesma base podiam escolher tabelas diferentes.
    `SELECT t.name AS nome FROM sys.tables t WHERE t.is_ms_shipped = 0 ORDER BY t.name`,
  );
  const comCredito = r.recordset
    .map((x) => x.nome)
    .filter((n) => /credito/i.test(n) && !/validade/i.test(n));
  if (comCredito.length === 0) return vazio;

  const detalhes = comCredito.filter((n) => /detalhe/i.test(n));
  const cabecalhos = comCredito.filter((n) => !/detalhe/i.test(n));
  if (detalhes.length === 0 || cabecalhos.length === 0) {
    return { ...vazio, candidatas: comCredito };
  }

  // Colunas de todas as candidatas, uma vez só.
  const colunas = new Map<string, Coluna[]>();
  for (const t of comCredito) colunas.set(t, (await colunasDe(pool, t)) ?? []);

  const pares: ParCredito[] = [];
  for (const det of detalhes) {
    const colsDet = colunas.get(det) ?? [];
    const produto = resolverColuna(colsDet, ["CodigoID"], [/^codigo\s*id$/i]);
    const qtd = resolverColuna(colsDet, ["Quantidade"], [/^quantidade$/i, /^qtd$/i]);
    if (!produto || !qtd) continue;
    for (const cab of cabecalhos) {
      const colsCab = colunas.get(cab) ?? [];
      // A chave lógica: a coluna que existe nos DOIS lados e identifica
      // o documento. Não pode ser a PK do detalhe.
      const chave =
        colsCab.find(
          (c) =>
            /credito.*id$/i.test(c.column) &&
            !/detalhe/i.test(c.column) &&
            colsDet.some((d) => d.column.toLowerCase() === c.column.toLowerCase()),
        )?.column ?? null;
      if (!chave) continue;
      const data = resolverColuna(colsCab, ["Data Venda", "Data"], [/^data\s*venda$/i, /^data$/i]);
      if (!data) continue;
      const tipo = resolverColuna(
        colsCab,
        ["Tipo Documento ID", "Tipo Documento"],
        [/^tipo\s*documento\s*id$/i, /^tipo\s*documento$/i],
      );
      const serie = resolverColuna(
        colsCab,
        ["SerieFacturacao", "Serie Facturacao", "Serie"],
        [/^serie\s*facturacao$/i, /^serie$/i],
      );
      // Um par com data + tipo + série é o circuito documental completo;
      // os pontos servem para escolher entre candidatos, não para
      // aceitar um par incompleto.
      const pontos = (tipo ? 2 : 0) + (serie ? 2 : 0) + (/^atendimento\s+credito$/i.test(cab) ? 3 : 0);
      pares.push({ cabecalho: cab, detalhe: det, colsCab, colsDet, chaveLigacao: chave, pontos });
    }
  }
  if (pares.length === 0) return { ...vazio, candidatas: comCredito };

  pares.sort((a, b) => b.pontos - a.pontos || a.cabecalho.localeCompare(b.cabecalho));
  const p = pares[0]!;

  return {
    existe: true,
    cabecalhoTabela: p.cabecalho,
    detalheTabela: p.detalhe,
    candidatas: comCredito,
    cabecalhoPk: resolverColuna(
      p.colsCab,
      ["Atendimento Credito ID", p.chaveLigacao],
      [/^atendimento\s*credito\s*id$/i],
    ),
    detalhePk: resolverColuna(
      p.colsDet,
      ["Atendimento Credito Detalhe ID"],
      [/^atendimento\s*credito\s*detalhe\s*id$/i, /detalhe\s*id$/i],
    ),
    chaveLigacao: p.chaveLigacao,
    data: resolverColuna(p.colsCab, ["Data Venda", "Data"], [/^data\s*venda$/i, /^data$/i]),
    serie: resolverColuna(
      p.colsCab,
      ["SerieFacturacao", "Serie Facturacao", "Serie"],
      [/^serie\s*facturacao$/i, /^serie$/i],
    ),
    numero: resolverColuna(
      p.colsCab,
      ["Numero Documento", "Numero"],
      [/^numero\s*documento$/i, /^numero$/i],
    ),
    tipoDocumento: resolverColuna(
      p.colsCab,
      ["Tipo Documento ID", "Tipo Documento"],
      [/^tipo\s*documento\s*id$/i, /^tipo\s*documento$/i],
    ),
    estado: resolverColuna(p.colsCab, ["Fim Venda"], [/fim\s*venda/i, /^estado$/i, /^situacao$/i]),
    codigoId: resolverColuna(p.colsDet, ["CodigoID"], [/^codigo\s*id$/i]),
    quantidade: resolverColuna(p.colsDet, ["Quantidade"], [/^quantidade$/i, /^qtd$/i]),
    pvpUnitario: resolverColuna(
      p.colsDet,
      ["Preco Venda Publico_EUR", "PVP_EUR"],
      [/^preco\s*venda\s*publico_eur$/i, /^pvp_eur$/i],
    ),
    valorLinha: resolverColuna(p.colsDet, ["Valor_EUR", "Valor"], [/^valor_eur$/i, /^valor$/i]),
    ivaValor: resolverColuna(p.colsDet, ["Val_IVA_EUR", "IVA"], [/^val_iva_eur$/i, /^iva$/i]),
    entidadeId: resolverColuna(p.colsDet, ["Entidade ID"], [/^entidade\s*id$/i]),
    sequencia: resolverColuna(p.colsDet, ["Sequencia"], [/^sequencia$/i]),
  };
}

/** Resumo legível do que a descoberta encontrou, para o log da corrida. */
export function resumoSchema(
  susp: SchemaFonteSusp,
  at: SchemaAtendimento,
  cab?: SchemaCabecalhoSusp,
): string[] {
  const linhas: string[] = [];
  linhas.push(
    `  [Atendimento] (circuito G): serie=${at.serie ?? "-"} numero=${at.numero ?? "-"} ` +
      `tipoDoc=${at.tipoDocumento ?? "-"}`,
  );
  if (!susp.existe) {
    linhas.push(`  [${TABELA_SUSP}]: NAO EXISTE nesta instalacao — fonte VSG inactiva`);
    return linhas;
  }
  if (cab) {
    linhas.push(
      `  [${TABELA_CABECALHO_SUSP}] (circuito VSG): pk=${cab.pk ?? "-"} ` +
        `serie=${cab.serie ?? "-"} numero=${cab.numero ?? "-"} ` +
        `tipoDoc=${cab.tipoDocumento ?? "-"} data=${cab.dataVenda ?? "-"}`,
    );
  }
  linhas.push(
    `  [${TABELA_SUSP}]: pk=${susp.pk ?? "-"} ` +
      `fk->cabecalho=${susp.cabecalhoFk ?? "-"} (declarada) ` +
      `codigo=${susp.codigoId ?? "-"} qtd=${susp.quantidade ?? "-"}`,
  );
  const faltam = (
    [
      ["pk", susp.pk],
      ["cabecalhoFk", susp.cabecalhoFk],
      ["codigoId", susp.codigoId],
      ["quantidade", susp.quantidade],
      ["pvpUnitario", susp.pvpUnitario],
      ["valorLinha", susp.valorLinha],
    ] as const
  )
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (faltam.length > 0) {
    linhas.push(`  ATENCAO colunas por resolver: ${faltam.join(", ")}`);
  }
  const regraSusp = CLASSIFICACAO[NAMESPACES.ATENDIMENTO_SUSP_DETALHE];
  linhas.push(
    `  classificacao suspensa: tipos {${[...regraSusp.peloSinal].join(",")}} classificados PELO SINAL ` +
      `(qtd>0 venda, qtd<0 anulacao, qtd=0 recusada)`,
  );
  linhas.push(
    `  o 104 das NC de VSG NAO e declarado aqui — e lido pelo circuito G`,
  );
  return linhas;
}
