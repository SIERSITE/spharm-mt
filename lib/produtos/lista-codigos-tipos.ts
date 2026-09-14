/**
 * lib/produtos/lista-codigos-tipos.ts
 *
 * Tipos e limites da lista de CNP/códigos importada por ficheiro.
 *
 * ── Porque é que isto é um ficheiro à parte do parser ────────────────
 *
 * O parser importa `xlsx` (~900 KB). O componente de UI precisa destes
 * tipos e destes limites — para mostrar "máximo 25 000 códigos" antes de
 * sequer contactar o servidor. Se ambos vivessem no mesmo módulo, um
 * `import type` mal escrito num client component passava a arrastar a
 * biblioteca inteira para o bundle do browser, e o sintoma disso é um
 * bundle a crescer 900 KB sem ninguém perceber porquê.
 *
 * Aqui não há `xlsx`, não há Prisma, não há `server-only`. É importável
 * de qualquer lado, incluindo do browser.
 */

/** Extensões aceites no upload. */
export const EXTENSOES_ACEITES = [".txt", ".csv", ".xlsx", ".xls"] as const;

/**
 * Tamanho máximo do ficheiro.
 *
 * 4 MB dá ~200 000 linhas de texto ou uma folha Excel com dezenas de
 * milhares de linhas — muito acima do tecto de códigos abaixo. Serve
 * para travar o upload ANTES de o ler para memória.
 */
export const MAX_FICHEIRO_BYTES = 4 * 1024 * 1024;

/**
 * Tecto de códigos únicos por lista.
 *
 * Não é arbitrário: a lista resolvida viaja no payload da Server Action
 * que gera o relatório/proposta, e o limite default do Next para esse
 * payload é 1 MB. 25 000 CNP em JSON são ~200 KB — folgado, e muito
 * acima de "vários milhares". Subir isto obriga a subir
 * `serverActions.bodySizeLimit` em next.config.ts, e a decisão deve ser
 * tomada com esse custo à vista.
 */
export const MAX_CODIGOS = 25_000;

/**
 * Mínimo de dígitos para um token contar como código.
 *
 * É isto que resolve a ambiguidade do espaço como separador. Numa linha
 *
 *     1234567 Paracetamol 500mg  2
 *
 * `Paracetamol` e `500mg` caem por não serem só dígitos, mas `2` passaria
 * — e entrava na lista como CNP inexistente. Nenhum CNP nacional nem
 * código de artigo real tem menos de 4 dígitos; uma quantidade tem quase
 * sempre menos. O que for descartado por esta regra aparece ao
 * utilizador em `ignorados`, para que a decisão seja visível e não
 * silenciosa.
 */
export const MIN_DIGITOS_CODIGO = 4;

/** Tecto de dígitos — acima disto não é código, é um número colado. */
export const MAX_DIGITOS_CODIGO = 12;

/** Quantos tokens descartados guardamos para mostrar ao utilizador. */
export const MAX_IGNORADOS_REPORTADOS = 50;

export type OrigemLista = "txt" | "xlsx";

/**
 * O que o parser devolve. Ainda NÃO sabe nada sobre o catálogo — só
 * sobre o ficheiro.
 */
export type ListaCodigosParseada = {
  /** Códigos normalizados, únicos, pela ordem em que apareceram. */
  codigos: string[];
  /** Tokens aceites como código, INCLUINDO repetições. */
  totalLidos: number;
  /** `totalLidos − codigos.length`. */
  duplicados: number;
  /**
   * Amostra do que foi descartado (não numérico, curto demais, longo
   * demais). Truncada a `MAX_IGNORADOS_REPORTADOS` — serve para o
   * utilizador perceber que o ficheiro tinha lixo, não para auditar.
   */
  ignorados: string[];
  origem: OrigemLista;
  /** Nome da folha usada (Excel). */
  folha?: string;
  /** Cabeçalho da coluna usada, quando houve um reconhecido. */
  coluna?: string;
};

/**
 * A lista depois de confrontada com o catálogo. É isto que a UI guarda
 * e o que dá origem ao filtro.
 */
export type ListaCodigosResolvida = ListaCodigosParseada & {
  /** Nome do ficheiro, para o chip da UI. */
  nomeFicheiro: string;
  /**
   * Os CNP que existem no catálogo. É ESTE array que viaja no filtro.
   *
   * Só os encontrados: um código inexistente não restringe nada e só
   * engordaria o payload. O utilizador vê-os em `naoEncontrados`.
   */
  cnps: number[];
  /** Produtos distintos encontrados. `=== cnps.length` (cnp é @unique). */
  encontrados: number;
  /** Códigos lidos que não existem no catálogo, na forma original. */
  naoEncontrados: string[];
};

/** Resposta do endpoint de upload. */
export type ListaCodigosResposta =
  | { ok: true; lista: ListaCodigosResolvida }
  | { ok: false; erro: string; codigo: ListaCodigosErro };

export type ListaCodigosErro =
  | "sem_ficheiro"
  | "extensao_nao_suportada"
  | "ficheiro_grande"
  | "ficheiro_vazio"
  | "sem_codigos"
  | "coluna_ambigua"
  | "demasiados_codigos"
  | "parse_falhou"
  | "sem_sessao"
  | "sem_permissao";

/**
 * O filtro tem de significar o mesmo nos dois módulos, e este é o único
 * sítio onde essa regra está escrita.
 *
 *   · `undefined`  → SEM restrição. O utilizador não importou lista.
 *   · `[]`         → NENHUM produto. Importou uma lista e nada foi
 *                    encontrado no catálogo.
 *   · não-vazio    → EXACTAMENTE estes CNP.
 *
 * ── Porque é que `[]` não é "sem filtro" ─────────────────────────────
 *
 * É a armadilha desta funcionalidade, e é silenciosa. Se o utilizador
 * carregar 500 códigos de que nenhum existe no catálogo, o array de CNP
 * encontrados é vazio. Tratar isso como "não há filtro" devolve-lhe o
 * INVENTÁRIO INTEIRO — o oposto exacto do que pediu, sem um único aviso.
 * O relatório correcto é vazio.
 *
 * Por isso a pergunta é sobre PRESENÇA (`Array.isArray`) e não sobre
 * comprimento. Quem não tem lista manda `undefined`; quem tem manda o
 * array, mesmo vazio. `restringirPorCatalogo` já usa a mesma convenção
 * para os outros eixos: devolve `[]` para dizer "nenhum corresponde", e
 * quem chama tem de honrar isso em vez de ignorar a restrição.
 */
export function temListaCodigos(cnps: number[] | undefined | null): boolean {
  return Array.isArray(cnps);
}
