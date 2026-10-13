/**
 * lib/regulamentar/infarmed-ficheiro.ts
 *
 * Leitor e validador PUROS (sem base de dados, sem rede) do ficheiro público
 * do INFARMED «allPackages» (Excel 97-2003, folha «Medicamentos»).
 *
 * Princípios:
 *   · as colunas mapeiam-se PELO NOME do cabeçalho, nunca pela posição;
 *   · faltar uma das 13 colunas recusa o ficheiro inteiro (em especial
 *     «Preço (PVP)», que não pode desaparecer em silêncio);
 *   · `Nº registo` é um IDENTIFICADOR (texto): nunca perde zeros à esquerda.
 *     Um código com zeros à esquerda não é representável no `Produto.cnp`
 *     (Int) sem mudar de identidade, por isso é rejeitado — não normalizado;
 *   · «preço livre» nunca vira 0; célula vazia nunca vira 0;
 *   · duplicados idênticos contam-se e mantém-se a 1.ª ocorrência; duplicados
 *     COM conteúdo diferente são conflitos e o CNP é excluído por inteiro.
 */

import { createHash } from "node:crypto";
import * as XLSX from "xlsx";

export const FOLHA_ESPERADA = "Medicamentos";

export const COLUNAS_OBRIGATORIAS = [
  "Nº registo",
  "Substância Ativa/DCI",
  "Nome do medicamento",
  "Forma farmacêutica",
  "Dosagem",
  "Tamanho da embalagem",
  "CNPEM",
  "Preço (PVP)",
  "PVP Notificado",
  "Preço Utente",
  "Preço Pensionistas",
  "Comerc.",
  "Genérico",
] as const;
export type ColunaInfarmed = (typeof COLUNAS_OBRIGATORIAS)[number];

/** Limites de sanidade: um ficheiro fora disto não é o ficheiro do INFARMED. */
export const LIMITE_BYTES = 60 * 1024 * 1024;
export const LIMITE_LINHAS = 100_000;

/** Assinatura do contentor OLE2 / CFB (Excel 97-2003). */
const ASSINATURA_OLE2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

export class FicheiroInfarmedInvalido extends Error {
  constructor(
    public readonly codigo:
      | "VAZIO"
      | "DEMASIADO_GRANDE"
      | "HTML"
      | "ASSINATURA"
      | "ILEGIVEL"
      | "FOLHA"
      | "COLUNAS"
      | "SEM_LINHAS"
      | "DEMASIADAS_LINHAS",
    mensagem: string,
  ) {
    super(mensagem);
    this.name = "FicheiroInfarmedInvalido";
  }
}

export type LinhaInfarmed = {
  /** Número da linha na folha (1 = cabeçalho). */
  linha: number;
  /** Nº registo como texto (identificador). */
  registo: string;
  cnp: number;
  cnpem: string | null;
  substanciaAtiva: string | null;
  nomeMedicamento: string | null;
  formaFarmaceutica: string | null;
  dosagem: string | null;
  tamanhoEmbalagem: string | null;
  pvp: number | null;
  precoLivre: boolean;
  pvpNotificado: number | null;
  precoUtenteGeral: number | null;
  precoUtenteEspecial: number | null;
  estadoComercializacao: string | null;
  generico: boolean | null;
};

export type LinhaRejeitada = { linha: number; registo: string | null; motivo: string };
export type ConflitoRegisto = { registo: string; linhas: number[] };

export type FicheiroInfarmedLido = {
  sha256: string;
  bytes: number;
  folha: string;
  /** Cabeçalhos pela ordem do ficheiro. */
  cabecalhos: string[];
  /** Linhas de dados presentes na folha (exclui o cabeçalho). */
  linhasLidas: number;
  /** Uma por CNP válido e único. */
  linhas: LinhaInfarmed[];
  rejeitadas: LinhaRejeitada[];
  duplicadosIdenticos: number;
  conflitos: ConflitoRegisto[];
  cnpDistintos: number;
};

export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Validação barata, feita ANTES de qualquer parse (e antes de tocar na base). */
export function validarAssinatura(buf: Buffer): void {
  if (!buf || buf.length === 0) {
    throw new FicheiroInfarmedInvalido("VAZIO", "O ficheiro está vazio.");
  }
  if (buf.length > LIMITE_BYTES) {
    throw new FicheiroInfarmedInvalido("DEMASIADO_GRANDE", `O ficheiro tem ${buf.length} bytes (limite ${LIMITE_BYTES}).`);
  }
  const inicio = buf.subarray(0, 512).toString("latin1").trimStart().toLowerCase();
  if (inicio.startsWith("<!doctype") || inicio.startsWith("<html") || inicio.startsWith("<?xml") || inicio.startsWith("<")) {
    throw new FicheiroInfarmedInvalido("HTML", "A resposta é HTML/XML (página de erro ou de login), não um ficheiro Excel.");
  }
  if (buf.length < ASSINATURA_OLE2.length || !buf.subarray(0, ASSINATURA_OLE2.length).equals(ASSINATURA_OLE2)) {
    throw new FicheiroInfarmedInvalido("ASSINATURA", "A assinatura não é a de um Excel 97-2003 (OLE2).");
  }
}

function texto(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, " ").trim();
  return s === "" ? null : s;
}

function semAcentos(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

type Preco = { ok: true; valor: number | null; livre: boolean } | { ok: false; motivo: string };

/** Número, texto numérico ("12,34"), vazio ou — só no PVP — «preço livre». */
function lerPreco(v: unknown, coluna: string, permiteLivre: boolean): Preco {
  if (v === null || v === undefined) return { ok: true, valor: null, livre: false };
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v < 0) return { ok: false, motivo: `${coluna}: valor inválido (${v})` };
    return { ok: true, valor: v, livre: false };
  }
  const s = String(v).trim();
  if (s === "") return { ok: true, valor: null, livre: false };
  if (permiteLivre && semAcentos(s) === "preco livre") return { ok: true, valor: null, livre: true };
  if (/^\d+([.,]\d+)?$/.test(s)) return { ok: true, valor: Number(s.replace(",", ".")), livre: false };
  return { ok: false, motivo: `${coluna}: texto não numérico "${s.slice(0, 40)}"` };
}

function lerRegisto(v: unknown): { ok: true; registo: string; cnp: number } | { ok: false; motivo: string; registo: string | null } {
  const bruto = v === null || v === undefined ? "" : String(v).trim();
  if (bruto === "") return { ok: false, motivo: "Nº registo vazio", registo: null };
  if (!/^\d+$/.test(bruto)) return { ok: false, motivo: "Nº registo não numérico", registo: bruto.slice(0, 30) };
  if (bruto.startsWith("0")) {
    return { ok: false, motivo: "Nº registo com zeros à esquerda (identidade não representável no CNP numérico)", registo: bruto };
  }
  if (bruto.length > 9) return { ok: false, motivo: "Nº registo fora do intervalo do CNP", registo: bruto };
  return { ok: true, registo: bruto, cnp: Number(bruto) };
}

function lerCnpem(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? String(Math.trunc(v)) : null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function lerGenerico(v: unknown): boolean | null {
  const s = texto(v);
  if (s === null) return null;
  const n = semAcentos(s);
  if (n === "sim") return true;
  if (n === "nao") return false;
  return null;
}

function assinaturaLinha(l: LinhaInfarmed): string {
  return JSON.stringify([
    l.cnpem, l.substanciaAtiva, l.nomeMedicamento, l.formaFarmaceutica, l.dosagem, l.tamanhoEmbalagem,
    l.pvp, l.precoLivre, l.pvpNotificado, l.precoUtenteGeral, l.precoUtenteEspecial,
    l.estadoComercializacao, l.generico,
  ]);
}

export function lerFicheiroInfarmed(buf: Buffer): FicheiroInfarmedLido {
  validarAssinatura(buf);

  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buf, { type: "buffer", cellDates: false, raw: true, sheetRows: LIMITE_LINHAS + 2 });
  } catch (e) {
    throw new FicheiroInfarmedInvalido("ILEGIVEL", `Não foi possível ler o Excel: ${e instanceof Error ? e.message : String(e)}`);
  }
  const ws = wb.Sheets[FOLHA_ESPERADA];
  if (!ws) {
    throw new FicheiroInfarmedInvalido("FOLHA", `Folha «${FOLHA_ESPERADA}» não encontrada (folhas: ${wb.SheetNames.join(", ") || "nenhuma"}).`);
  }
  const matriz = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null, blankrows: true });
  const cab = (matriz[0] ?? []).map((c) => (c === null || c === undefined ? "" : String(c).trim()));
  const indice = new Map<string, number>();
  cab.forEach((nome, i) => {
    if (nome && !indice.has(nome)) indice.set(nome, i);
  });
  const emFalta = COLUNAS_OBRIGATORIAS.filter((c) => !indice.has(c));
  if (emFalta.length > 0) {
    throw new FicheiroInfarmedInvalido("COLUNAS", `Faltam colunas obrigatórias: ${emFalta.join(", ")}.`);
  }
  const dados = matriz.slice(1);
  const vazia = (l: unknown[]) => l.every((c) => c === null || c === undefined || String(c).trim() === "");
  if (dados.every(vazia)) throw new FicheiroInfarmedInvalido("SEM_LINHAS", "O ficheiro não tem linhas de dados.");
  if (dados.length > LIMITE_LINHAS) {
    throw new FicheiroInfarmedInvalido("DEMASIADAS_LINHAS", `O ficheiro tem mais de ${LIMITE_LINHAS} linhas.`);
  }
  const col = (linha: unknown[], nome: ColunaInfarmed): unknown => linha[indice.get(nome)!];

  const rejeitadas: LinhaRejeitada[] = [];
  const vistas = new Map<string, { primeira: LinhaInfarmed; linhas: number[]; conflito: boolean }>();
  let duplicadosIdenticos = 0;

  let linhasLidas = 0;
  dados.forEach((linha, i) => {
    const nLinha = i + 2; // 1 = cabeçalho
    if (vazia(linha)) return;
    linhasLidas += 1;
    const reg = lerRegisto(col(linha, "Nº registo"));
    if (!reg.ok) {
      rejeitadas.push({ linha: nLinha, registo: reg.registo, motivo: reg.motivo });
      return;
    }
    const pvp = lerPreco(col(linha, "Preço (PVP)"), "Preço (PVP)", true);
    const notif = lerPreco(col(linha, "PVP Notificado"), "PVP Notificado", false);
    const geral = lerPreco(col(linha, "Preço Utente"), "Preço Utente", false);
    const espec = lerPreco(col(linha, "Preço Pensionistas"), "Preço Pensionistas", false);
    for (const p of [pvp, notif, geral, espec]) {
      if (!p.ok) {
        rejeitadas.push({ linha: nLinha, registo: reg.registo, motivo: p.motivo });
        return;
      }
    }
    const p1 = pvp as Extract<Preco, { ok: true }>;
    const l: LinhaInfarmed = {
      linha: nLinha,
      registo: reg.registo,
      cnp: reg.cnp,
      cnpem: lerCnpem(col(linha, "CNPEM")),
      substanciaAtiva: texto(col(linha, "Substância Ativa/DCI")),
      nomeMedicamento: texto(col(linha, "Nome do medicamento")),
      formaFarmaceutica: texto(col(linha, "Forma farmacêutica")),
      dosagem: texto(col(linha, "Dosagem")),
      tamanhoEmbalagem: texto(col(linha, "Tamanho da embalagem")),
      pvp: p1.valor,
      precoLivre: p1.livre,
      pvpNotificado: (notif as Extract<Preco, { ok: true }>).valor,
      precoUtenteGeral: (geral as Extract<Preco, { ok: true }>).valor,
      precoUtenteEspecial: (espec as Extract<Preco, { ok: true }>).valor,
      estadoComercializacao: texto(col(linha, "Comerc.")),
      generico: lerGenerico(col(linha, "Genérico")),
    };
    const anterior = vistas.get(reg.registo);
    if (!anterior) {
      vistas.set(reg.registo, { primeira: l, linhas: [nLinha], conflito: false });
      return;
    }
    anterior.linhas.push(nLinha);
    if (assinaturaLinha(anterior.primeira) === assinaturaLinha(l)) duplicadosIdenticos += 1;
    else anterior.conflito = true;
  });

  const linhas: LinhaInfarmed[] = [];
  const conflitos: ConflitoRegisto[] = [];
  for (const [registo, v] of vistas) {
    if (v.conflito) conflitos.push({ registo, linhas: v.linhas });
    else linhas.push(v.primeira);
  }

  return {
    sha256: sha256(buf),
    bytes: buf.length,
    folha: FOLHA_ESPERADA,
    cabecalhos: cab,
    linhasLidas,
    linhas,
    rejeitadas,
    duplicadosIdenticos,
    conflitos,
    cnpDistintos: vistas.size,
  };
}
