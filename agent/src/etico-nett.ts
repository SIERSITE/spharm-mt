/**
 * agent/src/etico-nett.ts
 *
 * Classificação ERP «Ético / NETT» (rev99).
 *
 * ── Origem ────────────────────────────────────────────────────────────
 * `dbo.Stocks.Etico_NETT` (tinyint) é FK para `dbo.Etico_NETT(Codigo, Tipo)`. Os CÓDIGOS podem diferir entre
 * instalações, por isso o agent NUNCA assume 1 = Ético / 2 = NETT: lê o lookup DESTA farmácia (só SELECT) e decide
 * pela DESCRIÇÃO normalizada. Só `Éticos` e `NETT` (e variações inequívocas) contam; Serviço, Sacos, Outros e tudo o
 * que for desconhecido ou ambíguo NÃO é enviado como classificação.
 *
 * ── Contrato com o SaaS (campos opcionais do item de /bootstrap/products) ──
 *   eticoNett: "ETICO" | "NETT"      reconhecido sem ambiguidade (+ eticoNettCodigo, eticoNettDescricao)
 *   eticoNett: null                  o artigo TEM código mas não é Ético/NETT (Serviço, desconhecido, ambíguo, lookup
 *                                    em falta) — o servidor conta um aviso e NÃO altera nada
 *   (campos omitidos)                coluna inexistente nesta instalação, ou artigo sem código — nada observado
 *
 * ── O que NUNCA faz ───────────────────────────────────────────────────
 * Não escreve no ERP, não altera o universo de artigos (a coluna é só mais um campo do SELECT que já existia), e não
 * regista o lookup nem descrições nos logs — só contagens.
 *
 * A lógica pura (normalização/resolução) é a MESMA de `lib/classificacao/etico-nett.ts` do SaaS; a equivalência é
 * verificada por `scripts/tests/test-etico-nett-agent.ts`.
 */
import type { SqlPool } from "./sql-client.js";

export type CategoriaEticoNett = "ETICO" | "NETT";

const ETICO_FORMAS = new Set(["etico", "eticos"]);
const NETT_FORMAS = new Set(["nett", "netts"]);

/** Sem acentos (NFD), minúsculas, pontuação → espaço, espaços colapsados e aparados. */
export function normalizarDescricaoEticoNett(valor: string | null | undefined): string {
  if (valor === null || valor === undefined) return "";
  return String(valor)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** ETICO | NETT se a descrição for INEQUIVOCAMENTE uma delas; `null` para tudo o resto. */
export function categoriaDaDescricao(descricao: string | null | undefined): CategoriaEticoNett | null {
  const n = normalizarDescricaoEticoNett(descricao);
  if (!n) return null;
  if (ETICO_FORMAS.has(n)) return "ETICO";
  if (NETT_FORMAS.has(n)) return "NETT";
  return null;
}

const OUTRAS_FORMAS = /^(servicos?|sacos( l)?|outros?)$/;

/** Categorias CONHECIDAS que não são Ético/NETT (Serviço, Sacos, Outros). Lista FECHADA: o resto é «desconhecido». */
export function ehOutraCategoriaConhecida(descricao: string | null | undefined): boolean {
  return OUTRAS_FORMAS.test(normalizarDescricaoEticoNett(descricao));
}

export type LinhaLookupEticoNett = { codigo: number | null | undefined; descricao: string | null | undefined };

export type ResolucaoLookupEticoNett = {
  porCodigo: Map<number, CategoriaEticoNett>;
  /** Descrição ORIGINAL (aparada) do lookup, só dos códigos resolvidos — vai no payload, nunca nos logs. */
  descricaoOriginal: Map<number, string>;
  /** codigo -> descrição ORIGINAL, só de códigos INEQUIVOCAMENTE de outra categoria conhecida (Serviço, Sacos, Outros). */
  outraCategoria: Map<number, string>;
  ignoradas: number;
  ambiguos: number[];
};

/**
 * Resolve o lookup de UMA farmácia. Ambiguidade (nunca adivinhar): o mesmo código com categorias diferentes, ou duas
 * descrições reconhecidas da MESMA categoria em códigos DIFERENTES -> todos descartados.
 */
export function resolverLookupEticoNett(linhas: readonly LinhaLookupEticoNett[]): ResolucaoLookupEticoNett {
  const candidatos = new Map<number, Set<CategoriaEticoNett>>();
  const original = new Map<number, string>();
  const outras = new Map<number, string>();
  let ignoradas = 0;
  for (const l of linhas) {
    const cod = typeof l.codigo === "number" && Number.isInteger(l.codigo) ? l.codigo : null;
    const cat = categoriaDaDescricao(l.descricao);
    if (cod === null || cat === null) {
      ignoradas++;
      if (cod !== null && ehOutraCategoriaConhecida(l.descricao)) outras.set(cod, String(l.descricao).trim().slice(0, 120));
      continue;
    }
    const s = candidatos.get(cod) ?? new Set<CategoriaEticoNett>();
    s.add(cat);
    candidatos.set(cod, s);
    original.set(cod, String(l.descricao).trim().slice(0, 120));
  }
  const ambiguos = new Set<number>();
  for (const [cod, cats] of candidatos) if (cats.size > 1) ambiguos.add(cod);
  const porCategoria = new Map<CategoriaEticoNett, number[]>();
  for (const [cod, cats] of candidatos) {
    if (cats.size !== 1) continue;
    const c = [...cats][0];
    porCategoria.set(c, [...(porCategoria.get(c) ?? []), cod]);
  }
  for (const cods of porCategoria.values()) if (cods.length > 1) for (const c of cods) ambiguos.add(c);
  const porCodigo = new Map<number, CategoriaEticoNett>();
  const descricaoOriginal = new Map<number, string>();
  for (const [cod, cats] of candidatos) {
    if (ambiguos.has(cod) || cats.size !== 1) continue;
    porCodigo.set(cod, [...cats][0]);
    descricaoOriginal.set(cod, original.get(cod) ?? "");
  }
  // Um código que aparece como Ético/NETT E como outra categoria é ambíguo: nem classifica nem retira.
  const outraCategoria = new Map<number, string>();
  for (const [cod, d] of outras) {
    if (candidatos.has(cod)) ambiguos.add(cod);
    else outraCategoria.set(cod, d);
  }
  for (const cod of ambiguos) {
    porCodigo.delete(cod);
    descricaoOriginal.delete(cod);
    outraCategoria.delete(cod);
  }
  return { porCodigo, descricaoOriginal, outraCategoria, ignoradas, ambiguos: [...ambiguos].sort((a, b) => a - b) };
}

// ─────────────────────────────────────────────────────────────────────
// Descoberta (só leitura) e plano
// ─────────────────────────────────────────────────────────────────────

/** Contagens do ciclo (nunca descrições nem o lookup). */
export type ContagensEticoNett = {
  etico: number;
  nett: number;
  /** Artigos com código que não é Ético/NETT (Serviço, Sacos, Outros, desconhecido, ambíguo, órfão, lookup em falta). */
  naoClassificados: number;
  /** Artigos de outra categoria CONHECIDA (Serviço, Sacos, Outros): o servidor retira só a classificação automática. */
  outraCategoria: number;
  /** Artigos sem código no ERP (nada observado). */
  semCodigo: number;
};

export type PlanoEticoNett = {
  /** Nome da coluna em dbo.Stocks, ou null se esta instalação não a tem. */
  stocksColuna: string | null;
  /** null quando a tabela/colunas do lookup não existem ou são ambíguas. */
  lookup: ResolucaoLookupEticoNett | null;
  /** Motivo (código curto, sem dados) quando `lookup` é null. */
  lookupAusente: "SEM_COLUNA" | "SEM_TABELA" | "COLUNAS_NAO_RECONHECIDAS" | "ERRO_LEITURA" | null;
  linhasLookup: number;
  contagens: ContagensEticoNett;
};

export const COLUNA_STOCKS_ETICO_NETT = "Etico_NETT";
const SO_IDENTIFICADOR = /^[A-Za-z0-9_]+$/;
const MAX_LINHAS_LOOKUP = 200;

export function planoEticoNettVazio(): PlanoEticoNett {
  return {
    stocksColuna: null,
    lookup: null,
    lookupAusente: "SEM_COLUNA",
    linhasLookup: 0,
    contagens: { etico: 0, nett: 0, naoClassificados: 0, outraCategoria: 0, semCodigo: 0 },
  };
}

type ColunaSys = { tabela: string; nome: string; tipo: string };

/**
 * Descobre, só com SELECT a `sys.*`/ao lookup, se esta instalação tem `Stocks.Etico_NETT` e o lookup `dbo.Etico_NETT`
 * (colunas `Codigo` inteira + uma coluna textual de descrição, preferencialmente `Tipo`). Qualquer falha de leitura
 * degrada para «sem lookup» (aviso) — nunca partir o pipeline de produtos por causa desta classificação.
 */
export async function descobrirEticoNett(pool: SqlPool): Promise<PlanoEticoNett> {
  const plano = planoEticoNettVazio();
  try {
    const r = await pool.request().query<ColunaSys>(`
      SELECT t.name AS tabela, c.name AS nome, ty.name AS tipo
      FROM sys.columns c
      JOIN sys.tables t  ON c.object_id = t.object_id
      JOIN sys.schemas s ON t.schema_id = s.schema_id
      JOIN sys.types ty  ON c.user_type_id = ty.user_type_id
      WHERE s.name = 'dbo' AND ((t.name = 'Stocks' AND c.name = '${COLUNA_STOCKS_ETICO_NETT}') OR t.name = 'Etico_NETT')
      ORDER BY t.name, c.column_id
    `);
    const cols = r.recordset;
    if (!cols.some((c) => c.tabela === "Stocks" && c.nome === COLUNA_STOCKS_ETICO_NETT)) return plano;
    plano.stocksColuna = COLUNA_STOCKS_ETICO_NETT;

    const lk = cols.filter((c) => c.tabela === "Etico_NETT");
    if (lk.length === 0) {
      plano.lookupAusente = "SEM_TABELA";
      return plano;
    }
    const colCodigo = lk.find((c) => c.nome.toLowerCase() === "codigo" && /int/i.test(c.tipo));
    const textuais = lk.filter((c) => /char|text/i.test(c.tipo));
    const colDesc = textuais.find((c) => c.nome.toLowerCase() === "tipo") ?? (textuais.length === 1 ? textuais[0] : undefined);
    if (!colCodigo || !colDesc || !SO_IDENTIFICADOR.test(colCodigo.nome) || !SO_IDENTIFICADOR.test(colDesc.nome)) {
      plano.lookupAusente = "COLUNAS_NAO_RECONHECIDAS";
      return plano;
    }
    const linhas = await pool.request().query<{ codigo: unknown; descricao: unknown }>(
      `SELECT TOP (${MAX_LINHAS_LOOKUP}) [${colCodigo.nome}] AS codigo, [${colDesc.nome}] AS descricao FROM [dbo].[Etico_NETT]`,
    );
    plano.linhasLookup = linhas.recordset.length;
    plano.lookup = resolverLookupEticoNett(
      linhas.recordset.map((l) => ({
        codigo: typeof l.codigo === "number" ? l.codigo : typeof l.codigo === "bigint" ? Number(l.codigo) : null,
        descricao: l.descricao === null || l.descricao === undefined ? null : String(l.descricao),
      })),
    );
    plano.lookupAusente = null;
    return plano;
  } catch {
    // Sem detalhes: a mensagem de erro SQL pode conter nomes/servidores. O pipeline de produtos continua sem classificar.
    plano.lookup = null;
    plano.lookupAusente = "ERRO_LEITURA";
    return plano;
  }
}

/** Fragmento do SELECT de produtos: o código cru, ou NULL se a coluna não existe (a query nunca se parte). */
export function eticoNettSelect(plano: PlanoEticoNett | undefined | null): string {
  return plano?.stocksColuna ? `s.[${plano.stocksColuna}]` : `CAST(NULL AS INT)`;
}

function codigoOuNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "bigint") return Number(v);
  return null;
}

/**
 * Campos a juntar ao payload de UM artigo (ver o contrato no topo). Actualiza as contagens do plano.
 * Sem plano ou sem coluna -> `{}` (campos omitidos = o SaaS não toca em nada).
 */
export function eticoNettParaPayload(plano: PlanoEticoNett | undefined | null, codigoCru: unknown): Record<string, unknown> {
  if (!plano || !plano.stocksColuna) return {};
  const cod = codigoOuNull(codigoCru);
  if (cod === null) {
    plano.contagens.semCodigo++;
    return {};
  }
  const outra = plano.lookup?.outraCategoria.get(cod);
  if (outra !== undefined) {
    plano.contagens.outraCategoria++;
    return { eticoNett: null, eticoNettOutraCategoria: true, eticoNettCodigo: cod, eticoNettDescricao: outra };
  }
  const cat = plano.lookup?.porCodigo.get(cod);
  if (!cat) {
    plano.contagens.naoClassificados++;
    return { eticoNett: null };
  }
  if (cat === "ETICO") plano.contagens.etico++;
  else plano.contagens.nett++;
  return {
    eticoNett: cat,
    eticoNettCodigo: cod,
    eticoNettDescricao: plano.lookup?.descricaoOriginal.get(cod) ?? null,
  };
}

/** Linha de log SEM dados sensíveis: estrutura e contagens apenas (nunca o lookup nem descrições). */
export function descreverPlanoEticoNett(plano: PlanoEticoNett): string {
  if (!plano.stocksColuna) return "Ético/NETT: esta instalação não tem Stocks.Etico_NETT — nada será enviado.";
  if (!plano.lookup) return `Ético/NETT: coluna presente mas lookup indisponível (${plano.lookupAusente}) — aviso; nenhum artigo será classificado.`;
  return (
    `Ético/NETT: lookup com ${plano.linhasLookup} linha(s); reconhecidas ${plano.lookup.porCodigo.size}, ` +
    `ignoradas ${plano.lookup.ignoradas}, ambíguas ${plano.lookup.ambiguos.length}.`
  );
}

/** Resumo das contagens do ciclo para o fim do pipeline de produtos. */
export function descreverContagensEticoNett(plano: PlanoEticoNett): string {
  const c = plano.contagens;
  return `Ético/NETT enviados: ${c.etico} Ético, ${c.nett} NETT; ${c.outraCategoria} de outra categoria conhecida; ${c.naoClassificados} sem categoria reconhecível (aviso); ${c.semCodigo} sem código.`;
}
