/**
 * lib/catalog/catalogo-nacional-parser.ts
 *
 * Parser STREAMING do formato real do catálogo nacional (INFARMED-like)
 * fornecido em `.local-data/fabricantes-garantia/catalogo/` — nunca visto
 * neste repositório antes desta análise, por isso documentado aqui em
 * detalhe (ver também o relatório de análise da sessão que o descobriu).
 *
 * ── Formato confirmado por inspecção directa do ficheiro real ──────────
 *  · Encoding: Windows-1252/Latin-1, NÃO UTF-8 (decodificar como UTF-8
 *    produz `�` exactamente nos acentos portugueses).
 *  · Sem cabeçalho — a primeira linha já é dado.
 *  · Delimitador: a substring LITERAL `(;)` (não um simples `;`).
 *  · 14 campos por registo lógico.
 *  · Cada LINHA FÍSICA tem exactamente 200 caracteres, terminada em CRLF.
 *  · Um registo lógico que exceda 200 caracteres é cortado ao carácter
 *    200 (a meio de palavras, inclusive) e continua na(s) linha(s)
 *    física(s) seguinte(s) — sem padding a marcar a continuação. Só a
 *    ÚLTIMA linha física de um registo tem padding com espaços.
 *  · Cada registo termina SEMPRE com o marcador literal `*FIML*` como
 *    14º campo — confirmado em 100% dos ~294 mil registos reais
 *    inspeccionados nesta análise, sem uma única excepção. É o único
 *    sinal fiável de fim de registo (uma linha em branco só aparece
 *    A SEGUIR a um registo que ocupou mais do que uma linha física —
 *    registos de uma linha só não têm separador nenhum a seguir).
 *
 * Reconstrução: concatenar linhas físicas CRUAS (sem trim intermédio —
 * o corte é literal ao carácter, um trim intermédio destruiria um
 * espaço real do texto) até a string acumulada, depois de um right-trim
 * único, terminar em `*FIML*`. Uma linha inteiramente em branco vista
 * sem acumulação pendente é ruído de separador e é ignorada.
 *
 * Streaming: nunca lê o ficheiro inteiro para memória — consome um
 * `Readable` linha a linha (via `readline`) e devolve um async
 * generator, um registo de cada vez. O chamador decide o que fazer com
 * cada um (nunca coleccionado aqui num array gigante).
 */
import type { Readable } from "node:stream";
import * as readline from "node:readline";

export const MARCADOR_FIM_REGISTO = "*FIML*";
export const NUM_CAMPOS = 14;

/**
 * Um registo bruto, tal como sai do ficheiro — só os 4 campos com
 * significado confirmado (cnp, estado, designação, titular) têm nome
 * próprio; os restantes 9 ficam em `outrosCampos` (índice 1..8 e 10),
 * preservados para auditoria mas sem uso conhecido ainda.
 */
export type RegistoCatalogoNacionalBruto = {
  /** Campo 0 — Código Nacional do Produto. */
  cnp: number;
  /** Campo 9 — estado regulamentar bruto, tal como vem no ficheiro (ex.: "Ativo", "Activo", "Autorizado", "Anulado", "Revogado", "Suspenso", ...). */
  estado: string | null;
  /** Campo 11 — designação do produto. */
  designacao: string | null;
  /** Campo 12 — titular da Autorização de Introdução no Mercado (fabricante nacional). */
  titular: string | null;
  /** Campos 1,2,3,4,5,6,7,8,10 — sem uso conhecido; preservados por posição para auditoria. */
  outrosCampos: readonly string[];
  /** Nº do registo lógico reconstruído (1-based), útil para diagnóstico de erros. */
  indiceRegisto: number;
};

export type ErroReconstrucaoCatalogo = {
  indiceRegisto: number;
  motivo: "campos_invalidos" | "cnp_invalido" | "eof_sem_marcador";
  detalhe: string;
  /** Até 300 caracteres do registo reconstruído (ou do que sobrou), para diagnóstico — nunca o ficheiro inteiro. */
  amostra: string;
};

export type EventoCatalogoNacional =
  | { tipo: "registo"; registo: RegistoCatalogoNacionalBruto }
  | { tipo: "erro"; erro: ErroReconstrucaoCatalogo };

/**
 * Async generator — consome `input` linha a linha, nunca acumula o
 * ficheiro inteiro em memória. `input` pode ser um `fs.createReadStream`
 * real (com `{ encoding: "latin1" }`) ou, em teste, `Readable.from([...])`
 * com uma amostra sintética mínima.
 */
export async function* lerCatalogoNacional(input: Readable): AsyncGenerator<EventoCatalogoNacional> {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let buffer = "";
  let indiceRegisto = 0;

  for await (const linhaCrua of rl) {
    if (buffer === "" && linhaCrua.trim() === "") continue; // separador entre registos multi-linha

    buffer += linhaCrua;
    const trimmed = buffer.replace(/\s+$/, "");
    if (!trimmed.endsWith(MARCADOR_FIM_REGISTO)) continue; // ainda não fechou — acumula mais uma linha física

    indiceRegisto++;
    const campos = trimmed.split("(;)").map((c) => c.trim());
    buffer = "";

    if (campos.length !== NUM_CAMPOS) {
      yield {
        tipo: "erro",
        erro: {
          indiceRegisto,
          motivo: "campos_invalidos",
          detalhe: `esperados ${NUM_CAMPOS} campos, vieram ${campos.length}`,
          amostra: trimmed.slice(0, 300),
        },
      };
      continue;
    }

    const cnpRaw = campos[0];
    if (!/^\d+$/.test(cnpRaw)) {
      yield {
        tipo: "erro",
        erro: { indiceRegisto, motivo: "cnp_invalido", detalhe: `campo 0 não é um CNP numérico: "${cnpRaw}"`, amostra: trimmed.slice(0, 300) },
      };
      continue;
    }

    yield {
      tipo: "registo",
      registo: {
        cnp: Number(cnpRaw),
        estado: campos[9] || null,
        designacao: campos[11] || null,
        titular: campos[12] || null,
        outrosCampos: [campos[1], campos[2], campos[3], campos[4], campos[5], campos[6], campos[7], campos[8], campos[10]],
        indiceRegisto,
      },
    };
  }

  // Buffer não fechado no EOF — registo incompleto, sinaliza mas não rebenta.
  const restante = buffer.replace(/\s+$/, "");
  if (restante.length > 0) {
    indiceRegisto++;
    yield {
      tipo: "erro",
      erro: { indiceRegisto, motivo: "eof_sem_marcador", detalhe: "EOF atingido a meio de um registo (sem *FIML* a fechar)", amostra: restante.slice(0, 300) },
    };
  }
}

/**
 * Estados considerados ACTUAIS para efeitos de classificação automática
 * (fabricante ou grupo laboratorial) — os únicos três valores vistos no
 * ficheiro real que representam uma AIM em vigor. Qualquer outro valor
 * (Anulado, Revogado, Suspenso, Retirado pela Entidade Reguladora,
 * Código nacional substituído, Descontinuado, vazio, ou qualquer valor
 * futuro não previsto) é tratado como HISTÓRICO — nunca dispara
 * classificação automática, só entra em fila de revisão.
 */
export const ESTADOS_ATUAIS_CATALOGO_NACIONAL: ReadonlySet<string> = new Set(["Ativo", "Activo", "Autorizado"]);

export function ehEstadoAtual(estado: string | null | undefined): boolean {
  if (!estado) return false;
  return ESTADOS_ATUAIS_CATALOGO_NACIONAL.has(estado.trim());
}
