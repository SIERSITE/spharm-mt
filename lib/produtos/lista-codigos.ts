/**
 * lib/produtos/lista-codigos.ts
 *
 * O parser ÚNICO da lista de CNP/códigos carregada por ficheiro.
 *
 * É chamado pelos Relatórios e pelas Encomendas, e nenhum dos dois tem
 * uma segunda forma de ler um ficheiro. Se um dia o parser passar a
 * aceitar outro formato, os dois módulos ganham-no ao mesmo tempo ou
 * nenhum ganha — que é o ponto de haver só um.
 *
 * Puro: sem Prisma, sem rede, sem `server-only`. Recebe bytes ou texto e
 * devolve códigos. Quem os confronta com o catálogo é
 * `resolver-lista-codigos.ts`, que é outra responsabilidade e vive
 * noutro ficheiro.
 *
 * ── A regra do espaço como separador ─────────────────────────────────
 *
 * O pedido era "aceitar espaços quando não provoquem ambiguidade", e a
 * ambiguidade é real: numa lista exportada de um ERP tanto aparece
 *
 *     1234567 7654321 5555555          três códigos
 *
 * como
 *
 *     1234567 Paracetamol 500mg 2      um código e ruído
 *
 * Não há forma de distinguir os dois olhando para um token de cada vez.
 * A decisão é por LINHA, e está em `extrairDaLinha`:
 *
 *   · com separador explícito (; , TAB) → os campos são campos;
 *   · sem separador explícito, todos os tokens válidos → todos entram;
 *   · sem separador explícito, alguns válidos → só o PRIMEIRO entra.
 *
 * O terceiro caso é o que trata a linha com designação: o código vem
 * sempre à cabeça nos ficheiros que a farmácia exporta. E o
 * `MIN_DIGITOS_CODIGO` é o que impede o `2` do fim de linha de passar a
 * CNP. Ver `lista-codigos-tipos.ts`.
 *
 * ── Cabeçalhos ───────────────────────────────────────────────────────
 *
 * A detecção de coluna é a MESMA para Excel e para CSV/TXT com
 * cabeçalho. Um ficheiro `CNP;Designação;Quantidade` guardado como .txt
 * tem de dar o mesmo que o mesmo ficheiro guardado como .xlsx — e sem
 * isto não daria: a quantidade de 4 dígitos entrava pela regra dos
 * campos.
 */
import * as XLSX from "xlsx";
import {
  MAX_DIGITOS_CODIGO,
  MAX_IGNORADOS_REPORTADOS,
  MIN_DIGITOS_CODIGO,
  type ListaCodigosParseada,
  type OrigemLista,
} from "./lista-codigos-tipos";

// ─── Normalização ────────────────────────────────────────────────────

/**
 * Cabeçalhos reconhecidos, já normalizados (minúsculas, sem acentos,
 * sem separadores).
 *
 * Deliberadamente curta. "referência" e "ref" ficam de FORA: num mapa de
 * compras essa coluna é a referência do fornecedor, não o CNP, e
 * aceitá-la daria uma lista inteira de códigos que não existem —
 * plausível o suficiente para ninguém desconfiar do ficheiro.
 */
const CABECALHOS_CODIGO = new Set([
  "cnp",
  "codigo",
  "cod",
  "cnpcodigo",
  "codigocnp",
  "codigoproduto",
  "codproduto",
  "codigoartigo",
  "codartigo",
  "codigodoproduto",
  "codigodoartigo",
  "codigonacional",
  "cnpcod",
]);

/** minúsculas, sem acentos, só alfanuméricos. */
export function normalizarCabecalho(raw: unknown): string {
  return String(raw ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * O token é um código?
 *
 * Aceita aspas e espaços à volta (o Excel guardado como CSV cita campos
 * de texto) e zeros à esquerda, que são removidos na normalização —
 * `Produto.cnp` é `Int`, e "0123456" e "123456" são o mesmo produto.
 * O ORIGINAL é preservado à parte, para que a lista de não-encontrados
 * mostre ao utilizador o que ele escreveu.
 */
export function normalizarCodigo(raw: unknown): string | null {
  const s = String(raw ?? "")
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .trim();
  if (!/^\d+$/.test(s)) return null;
  if (s.length < MIN_DIGITOS_CODIGO || s.length > MAX_DIGITOS_CODIGO) return null;
  // Zeros à esquerda caem: a identidade do catálogo é um inteiro.
  const semZeros = s.replace(/^0+(?=\d)/, "");
  if (semZeros.length < MIN_DIGITOS_CODIGO) return null;
  return semZeros;
}

/** O índice da coluna de código numa linha de cabeçalhos, ou `null`. */
export function encontrarColunaCodigo(headers: readonly unknown[]): number | null {
  for (let i = 0; i < headers.length; i++) {
    if (CABECALHOS_CODIGO.has(normalizarCabecalho(headers[i]))) return i;
  }
  return null;
}

/** A linha parece um cabeçalho? (≥1 campo não vazio e nenhum é código) */
function pareceCabecalho(campos: readonly string[]): boolean {
  const preenchidos = campos.filter((c) => c.trim().length > 0);
  if (preenchidos.length === 0) return false;
  return preenchidos.every((c) => normalizarCodigo(c) === null);
}

// ─── Acumulador ──────────────────────────────────────────────────────

/**
 * Junta códigos preservando a ordem de aparição e contando duplicados.
 *
 * A ordem importa mais do que parece: é a ordem em que o utilizador
 * escreveu a lista, e é a ordem em que os não-encontrados lhe são
 * mostrados. Um `Set` sozinho perdia-a.
 */
class Acumulador {
  private readonly vistos = new Set<string>();
  readonly codigos: string[] = [];
  readonly ignorados: string[] = [];
  totalLidos = 0;

  aceitar(token: string): boolean {
    const c = normalizarCodigo(token);
    if (c === null) {
      this.descartar(token);
      return false;
    }
    this.totalLidos++;
    if (!this.vistos.has(c)) {
      this.vistos.add(c);
      this.codigos.push(c);
    }
    return true;
  }

  descartar(token: string) {
    const t = String(token ?? "").trim();
    if (t.length === 0) return;
    if (this.ignorados.length < MAX_IGNORADOS_REPORTADOS) this.ignorados.push(t);
  }

  fechar(
    origem: OrigemLista,
    extra?: { folha?: string; coluna?: string },
  ): ListaCodigosParseada {
    return {
      codigos: this.codigos,
      totalLidos: this.totalLidos,
      duplicados: this.totalLidos - this.codigos.length,
      ignorados: this.ignorados,
      origem,
      ...(extra?.folha ? { folha: extra.folha } : {}),
      ...(extra?.coluna ? { coluna: extra.coluna } : {}),
    };
  }
}

// ─── TXT / CSV ───────────────────────────────────────────────────────

const SEPARADORES_EXPLICITOS = /[;,\t]/;

/**
 * Extrai os códigos de UMA linha. Ver a nota do cabeçalho do ficheiro
 * para o raciocínio; aqui fica só a mecânica.
 */
function extrairDaLinha(linha: string, acc: Acumulador, colunaFixa: number | null): void {
  if (linha.trim().length === 0) return;

  if (colunaFixa !== null) {
    // Há cabeçalho reconhecido: só aquela coluna conta. É isto que
    // impede a coluna "Quantidade" de contribuir códigos falsos.
    const campos = linha.split(SEPARADORES_EXPLICITOS);
    const campo = campos[colunaFixa];
    if (campo === undefined) return;
    acc.aceitar(campo);
    return;
  }

  if (SEPARADORES_EXPLICITOS.test(linha)) {
    const campos = linha
      .split(SEPARADORES_EXPLICITOS)
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    const validos = campos.filter((c) => normalizarCodigo(c) !== null);
    if (validos.length === campos.length) {
      // Linha inteiramente de códigos — "1234567;7654321;5555555".
      for (const c of campos) acc.aceitar(c);
    } else if (validos.length > 0) {
      // "1234567;Paracetamol;2" — o primeiro campo válido é o código.
      acc.aceitar(validos[0]);
      for (const c of campos) if (normalizarCodigo(c) === null) acc.descartar(c);
    } else {
      for (const c of campos) acc.descartar(c);
    }
    return;
  }

  const tokens = linha.trim().split(/\s+/);
  const validos = tokens.filter((t) => normalizarCodigo(t) !== null);
  if (validos.length === tokens.length) {
    for (const t of tokens) acc.aceitar(t);
  } else if (normalizarCodigo(tokens[0]) !== null) {
    // Código à cabeça seguido de designação — o caso do mapa exportado.
    acc.aceitar(tokens[0]);
    for (let i = 1; i < tokens.length; i++) acc.descartar(tokens[i]);
  } else {
    for (const t of tokens) acc.descartar(t);
  }
}

export function parseListaTxt(texto: string): ListaCodigosParseada {
  // BOM do Notepad e CRLF do Windows: os dois ficheiros que uma farmácia
  // produz com mais frequência.
  const limpo = texto.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const linhas = limpo.split("\n");

  // Cabeçalho? Só a PRIMEIRA linha não vazia é candidata.
  let colunaFixa: number | null = null;
  let coluna: string | undefined;
  let inicio = 0;
  for (let i = 0; i < linhas.length; i++) {
    if (linhas[i].trim().length === 0) continue;
    const campos = linhas[i].split(SEPARADORES_EXPLICITOS).map((c) => c.trim());
    if (campos.length > 1 && pareceCabecalho(campos)) {
      const idx = encontrarColunaCodigo(campos);
      if (idx !== null) {
        colunaFixa = idx;
        coluna = campos[idx];
      }
      // Cabeçalho reconhecido ou não, a linha de cabeçalho não é dado.
      inicio = i + 1;
    }
    break;
  }

  const acc = new Acumulador();
  for (let i = inicio; i < linhas.length; i++) {
    extrairDaLinha(linhas[i], acc, colunaFixa);
  }
  return acc.fechar("txt", { coluna });
}

// ─── Excel ───────────────────────────────────────────────────────────

/** Quantas linhas do topo procuramos por um cabeçalho reconhecido. */
const LINHAS_PROCURA_CABECALHO = 10;

/** Fracção mínima de valores código-like para adoptar uma coluna sem cabeçalho. */
const FRACCAO_MINIMA_COLUNA = 0.8;

export class ListaCodigosParseError extends Error {
  constructor(
    readonly codigo: "ficheiro_vazio" | "coluna_ambigua" | "parse_falhou",
    message: string,
  ) {
    super(message);
    this.name = "ListaCodigosParseError";
  }
}

type Matriz = string[][];

/** A primeira folha com pelo menos uma célula preenchida. */
function primeiraFolhaUtil(wb: XLSX.WorkBook): { nome: string; matriz: Matriz } | null {
  for (const nome of wb.SheetNames) {
    const ws = wb.Sheets[nome];
    if (!ws) continue;
    const matriz = XLSX.utils.sheet_to_json(ws, {
      header: 1,
      // `raw: false` devolve o texto FORMATADO da célula. É o que
      // preserva "0123456" numa coluna formatada como texto; com
      // `raw: true` viria o número 123456 e um código com zeros à
      // esquerda que o ERP escreve como texto deixava de bater certo
      // com o que o utilizador vê no Excel.
      raw: false,
      defval: "",
      blankrows: false,
    }) as unknown as Matriz;
    if (matriz.some((linha) => linha.some((c) => String(c ?? "").trim().length > 0))) {
      return { nome, matriz };
    }
  }
  return null;
}

/**
 * Escolhe a coluna de códigos quando NÃO há cabeçalho reconhecido.
 *
 * Duas hipóteses, por esta ordem:
 *   1. só uma coluna preenchida → é essa, mesmo sem cabeçalho (foi o que
 *      o pedido descreveu como "ficheiro evidente");
 *   2. várias colunas, mas só UMA é predominantemente código → é essa.
 *
 * Fora disso atira. Não inventamos: um mapa com "Código" e "Código de
 * Barras" preenchidos dá duas colunas plausíveis, e adivinhar qual delas
 * daria uma lista errada sem uma única mensagem.
 */
function escolherColunaSemCabecalho(matriz: Matriz): number {
  const largura = matriz.reduce((m, l) => Math.max(m, l.length), 0);
  const preenchidas: number[] = [];
  const codigoLike: number[] = [];
  for (let c = 0; c < largura; c++) {
    let naoVazias = 0;
    let codigos = 0;
    for (const linha of matriz) {
      const v = String(linha[c] ?? "").trim();
      if (v.length === 0) continue;
      naoVazias++;
      if (normalizarCodigo(v) !== null) codigos++;
    }
    preenchidas[c] = naoVazias;
    codigoLike[c] = naoVazias > 0 && codigos / naoVazias >= FRACCAO_MINIMA_COLUNA ? codigos : 0;
  }

  const comDados = preenchidas.map((n, i) => ({ i, n })).filter((x) => x.n > 0);
  if (comDados.length === 0) {
    throw new ListaCodigosParseError("ficheiro_vazio", "A folha não tem células preenchidas.");
  }
  if (comDados.length === 1) return comDados[0].i;

  const candidatas = codigoLike.map((n, i) => ({ i, n })).filter((x) => x.n > 0);
  if (candidatas.length === 1) return candidatas[0].i;

  throw new ListaCodigosParseError(
    "coluna_ambigua",
    candidatas.length === 0
      ? "Nenhuma coluna do ficheiro parece conter códigos. Dê à coluna dos códigos o cabeçalho «CNP» ou «Código»."
      : `O ficheiro tem ${candidatas.length} colunas que podem ser códigos. Dê à coluna certa o cabeçalho «CNP» ou «Código».`,
  );
}

export function parseListaExcel(buffer: Buffer | ArrayBuffer | Uint8Array): ListaCodigosParseada {
  let wb: XLSX.WorkBook;
  try {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer as ArrayBuffer);
    wb = XLSX.read(buf, { type: "buffer", cellDates: false });
  } catch (err) {
    throw new ListaCodigosParseError(
      "parse_falhou",
      `Não foi possível ler o ficheiro Excel: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const folha = primeiraFolhaUtil(wb);
  if (!folha) {
    throw new ListaCodigosParseError(
      "ficheiro_vazio",
      "O ficheiro não tem nenhuma folha com dados.",
    );
  }

  // Cabeçalho reconhecido nas primeiras linhas?
  let colunaIdx: number | null = null;
  let colunaNome: string | undefined;
  let inicio = 0;
  const limite = Math.min(LINHAS_PROCURA_CABECALHO, folha.matriz.length);
  for (let i = 0; i < limite; i++) {
    const idx = encontrarColunaCodigo(folha.matriz[i]);
    if (idx !== null) {
      colunaIdx = idx;
      colunaNome = String(folha.matriz[i][idx] ?? "").trim();
      inicio = i + 1;
      break;
    }
  }

  if (colunaIdx === null) {
    colunaIdx = escolherColunaSemCabecalho(folha.matriz);
    // Sem cabeçalho reconhecido, a primeira linha pode na mesma ser um
    // título ("Lista de artigos"): não é código, cai em `ignorados`, e o
    // utilizador vê-a lá.
    inicio = 0;
  }

  const acc = new Acumulador();
  for (let i = inicio; i < folha.matriz.length; i++) {
    const v = folha.matriz[i][colunaIdx];
    if (v === undefined || String(v).trim().length === 0) continue;
    acc.aceitar(String(v));
  }

  return acc.fechar("xlsx", { folha: folha.nome, coluna: colunaNome });
}

// ─── Despacho ────────────────────────────────────────────────────────

/** A extensão, em minúsculas e com ponto. `""` quando não há. */
export function extensaoDe(nomeFicheiro: string): string {
  const m = /\.[a-z0-9]+$/i.exec(nomeFicheiro.trim());
  return m ? m[0].toLowerCase() : "";
}

/**
 * Ponto de entrada único. O formato vem da extensão, não de sniffing:
 * um .txt que por acaso comece com bytes de ZIP é um .txt partido, e
 * tratá-lo como Excel só torna a mensagem de erro incompreensível.
 */
export function parseListaCodigos(nomeFicheiro: string, bytes: Buffer): ListaCodigosParseada {
  const ext = extensaoDe(nomeFicheiro);
  if (ext === ".xlsx" || ext === ".xls") return parseListaExcel(bytes);
  return parseListaTxt(bytes.toString("utf8"));
}
