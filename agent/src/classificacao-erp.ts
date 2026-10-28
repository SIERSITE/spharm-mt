/**
 * agent/src/classificacao-erp.ts
 *
 * Leitura OPCIONAL da classificação do produto no ERP (Ético, NETT,
 * Serviço) por MAPEAMENTO EXPLÍCITO em agent.config.json. O Genérico não
 * passa por aqui: tem coluna conhecida (`dbo.Stocks.[Generico]`) e segue no
 * payload como `genericoErp` (tri-estado).
 *
 * ── PORQUE É CONFIGURÁVEL E NÃO ESCRITO EM CÓDIGO ───────────────────
 * Nenhum nome de coluna ERP para Ético / NETT / Serviço foi alguma vez
 * provado neste repositório, e o significado dos códigos varia por
 * instalação. Este módulo NÃO adivinha: só lê o que o operador declarou
 * depois de correr `classification-audit` numa farmácia real e validar os
 * valores com quem conhece o ERP.
 *
 * Sem a secção `classificacaoErp` → nenhum SQL extra, nenhum campo novo
 * no payload (para além de `genericoErp`, derivado da coluna já lida).
 *
 * ── FORMATO (agent.config.json) ─────────────────────────────────────
 *   "classificacaoErp": {
 *     "etico":   { "coluna": "<coluna em dbo.Stocks>", "valoresVerdadeiros": [1] },
 *     "nett":    { "tabela": "<tabela>", "chave": "<coluna chave na tabela>",
 *                  "chaveStocks": "CodigoID",   // opcional, default CodigoID
 *                  "coluna": "<coluna>", "valoresVerdadeiros": ["S"], "valoresFalsos": ["N"] },
 *     "servico": { ... }
 *   }
 *
 *   · `valoresVerdadeiros` obrigatório (não vazio). `valoresFalsos`
 *     opcional: se omitido, qualquer valor não-nulo que não seja
 *     verdadeiro é FALSO; se presente, um valor fora das duas listas é
 *     DESCONHECIDO (null) — nunca se adivinha.
 *   · NULL / texto vazio no ERP → desconhecido (null).
 *   · Comparação: texto aparado, sem distinguir maiúsculas; booleano
 *     true/false equivale a 1/0.
 *   · Identificadores só com letras, dígitos, "_" e espaço (sem brackets,
 *     aspas ou pontuação): só são interpolados entre [ ] depois de
 *     validados e de confirmados em sys.columns.
 */

import * as fs from "node:fs";
import { JSON_CONFIG_PATH } from "./config.js";
import type { SqlPool } from "./sql-client.js";
import { tableExists, listColumns } from "./commands/probe-helpers.js";

export const CAMPOS_CLASSIFICACAO = ["etico", "nett", "servico"] as const;
export type CampoClassificacao = (typeof CAMPOS_CLASSIFICACAO)[number];

export type ValorConfigurado = string | number | boolean;

export type MapeamentoCampo = {
  coluna: string;
  /** Tabela (schema dbo) com a coluna; omitido → a coluna está em dbo.Stocks. */
  tabela?: string;
  /** Coluna da `tabela` que liga a dbo.Stocks (obrigatória com `tabela`). */
  chave?: string;
  /** Coluna de dbo.Stocks usada na ligação (default CodigoID). */
  chaveStocks?: string;
  valoresVerdadeiros: ValorConfigurado[];
  valoresFalsos?: ValorConfigurado[];
};

export type ClassificacaoErpConfig = Partial<Record<CampoClassificacao, MapeamentoCampo>>;

const IDENT = /^[\p{L}\p{N}_ ]{1,128}$/u;
export const identificadorValido = (s: unknown): s is string =>
  typeof s === "string" && s === s.trim() && IDENT.test(s);

function listaValores(v: unknown, nome: string, erros: string[], obrigatoria: boolean): ValorConfigurado[] | undefined {
  if (v === undefined || v === null) {
    if (obrigatoria) erros.push(`${nome} em falta`);
    return undefined;
  }
  if (!Array.isArray(v) || (obrigatoria && v.length === 0)) {
    erros.push(`${nome} deve ser uma lista${obrigatoria ? " não vazia" : ""}`);
    return undefined;
  }
  const out: ValorConfigurado[] = [];
  for (const x of v) {
    if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") out.push(x);
    else erros.push(`${nome} só aceita texto, número ou booleano`);
  }
  return out;
}

/**
 * Valida a secção `classificacaoErp`. Função pura. Qualquer erro invalida o
 * campo (o campo inválido NÃO é enviado); campos válidos mantêm-se.
 */
export function parseClassificacaoErpConfig(raw: unknown): {
  config: ClassificacaoErpConfig;
  erros: string[];
} {
  const config: ClassificacaoErpConfig = {};
  const erros: string[] = [];
  if (raw === undefined || raw === null) return { config, erros };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { config, erros: ["classificacaoErp deve ser um objecto"] };
  }
  const obj = raw as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (!(CAMPOS_CLASSIFICACAO as readonly string[]).includes(k)) {
      erros.push(`classificacaoErp.${k}: campo desconhecido (aceites: ${CAMPOS_CLASSIFICACAO.join(", ")})`);
    }
  }
  for (const campo of CAMPOS_CLASSIFICACAO) {
    const m = obj[campo];
    if (m === undefined || m === null) continue;
    const e: string[] = [];
    if (typeof m !== "object" || Array.isArray(m)) {
      erros.push(`classificacaoErp.${campo}: deve ser um objecto`);
      continue;
    }
    const o = m as Record<string, unknown>;
    if (!identificadorValido(o.coluna)) e.push("coluna inválida (letras, dígitos, _ e espaço)");
    const temTabela = o.tabela !== undefined && o.tabela !== null;
    if (temTabela) {
      if (!identificadorValido(o.tabela)) e.push("tabela inválida");
      if (!identificadorValido(o.chave)) e.push("chave obrigatória e válida quando há tabela");
    } else if (o.chave !== undefined || o.chaveStocks !== undefined) {
      e.push("chave/chaveStocks só fazem sentido com tabela");
    }
    if (o.chaveStocks !== undefined && o.chaveStocks !== null && !identificadorValido(o.chaveStocks)) {
      e.push("chaveStocks inválida");
    }
    const vv = listaValores(o.valoresVerdadeiros, "valoresVerdadeiros", e, true);
    const vf = listaValores(o.valoresFalsos, "valoresFalsos", e, false);
    if (vv && vf) {
      const set = new Set(vv.map(normalizarValor));
      if (vf.some((x) => set.has(normalizarValor(x)))) e.push("um valor não pode ser verdadeiro e falso ao mesmo tempo");
    }
    if (e.length > 0) {
      erros.push(...e.map((x) => `classificacaoErp.${campo}: ${x}`));
      continue;
    }
    config[campo] = {
      coluna: o.coluna as string,
      ...(temTabela ? { tabela: o.tabela as string, chave: o.chave as string } : {}),
      ...(temTabela && o.chaveStocks ? { chaveStocks: o.chaveStocks as string } : {}),
      valoresVerdadeiros: vv!,
      ...(vf ? { valoresFalsos: vf } : {}),
    };
  }
  return { config, erros };
}

/** Lê a secção de agent.config.json (cwd). Ausente / ilegível → sem mapeamento. */
export function loadClassificacaoErpConfig(): { config: ClassificacaoErpConfig; erros: string[] } {
  try {
    if (!fs.existsSync(JSON_CONFIG_PATH)) return { config: {}, erros: [] };
    const parsed = JSON.parse(fs.readFileSync(JSON_CONFIG_PATH, "utf8")) as Record<string, unknown>;
    return parseClassificacaoErpConfig(parsed?.classificacaoErp);
  } catch {
    // agent.config.json inválido já é reportado por loadConfig; aqui não há mapeamento.
    return { config: {}, erros: [] };
  }
}

// ── Interpretação de valores ─────────────────────────────────────────

export function normalizarValor(v: unknown): string {
  if (typeof v === "boolean") return v ? "1" : "0";
  return String(v).trim().toLowerCase();
}

/** true / false / null (desconhecido) + se o valor foi "desconhecido" por não constar. */
export function interpretarValor(
  bruto: unknown,
  m: Pick<MapeamentoCampo, "valoresVerdadeiros" | "valoresFalsos">,
): { valor: boolean | null; foraDoMapeamento: boolean } {
  if (bruto === null || bruto === undefined) return { valor: null, foraDoMapeamento: false };
  const n = normalizarValor(bruto);
  if (n === "") return { valor: null, foraDoMapeamento: false };
  if (m.valoresVerdadeiros.some((x) => normalizarValor(x) === n)) return { valor: true, foraDoMapeamento: false };
  if (!m.valoresFalsos) return { valor: false, foraDoMapeamento: false };
  if (m.valoresFalsos.some((x) => normalizarValor(x) === n)) return { valor: false, foraDoMapeamento: false };
  return { valor: null, foraDoMapeamento: true };
}

// ── Plano resolvido contra o schema real ─────────────────────────────

export type CampoResolvido = {
  campo: CampoClassificacao;
  alias: string;
  /** Expressão a pôr no SELECT (já com [ ] e alias de tabela). */
  selectExpr: string;
  /** Cláusula a pôr no FROM (vazia quando a coluna está em Stocks). */
  joinClause: string;
  mapeamento: MapeamentoCampo;
  /** "Stocks.[Col]" / "Tabela.[Col]" — para logs e proveniência. */
  origem: string;
};

export type ClassificacaoPlan = { campos: CampoResolvido[]; avisos: string[] };

export const EMPTY_CLASSIFICACAO_PLAN: ClassificacaoPlan = { campos: [], avisos: [] };

const aliasDe = (c: CampoClassificacao) => `cls_${c}`;

/**
 * Constrói o plano SEM tocar no ERP — função pura; `existe` diz se uma
 * coluna/tabela existe e devolve o nome real (ou null). Campos cujo
 * mapeamento não bate com o schema ficam de fora (com aviso): nunca se
 * envia uma classificação de uma coluna que não existe.
 */
export function construirPlanoClassificacao(
  config: ClassificacaoErpConfig,
  existe: { coluna(tabela: string, coluna: string): string | null; tabela(tabela: string): boolean },
): ClassificacaoPlan {
  const campos: CampoResolvido[] = [];
  const avisos: string[] = [];
  for (const campo of CAMPOS_CLASSIFICACAO) {
    const m = config[campo];
    if (!m) continue;
    const alias = aliasDe(campo);
    if (!m.tabela) {
      const col = existe.coluna("Stocks", m.coluna);
      if (!col) {
        avisos.push(`${campo}: coluna dbo.Stocks.[${m.coluna}] não existe nesta instalação — campo NÃO enviado.`);
        continue;
      }
      campos.push({ campo, alias, selectExpr: `s.[${col}]`, joinClause: "", mapeamento: m, origem: `Stocks.[${col}]` });
      continue;
    }
    if (!existe.tabela(m.tabela)) {
      avisos.push(`${campo}: tabela dbo.[${m.tabela}] não existe — campo NÃO enviado.`);
      continue;
    }
    const col = existe.coluna(m.tabela, m.coluna);
    const chave = existe.coluna(m.tabela, m.chave!);
    const chaveStocks = existe.coluna("Stocks", m.chaveStocks ?? "CodigoID");
    if (!col || !chave || !chaveStocks) {
      avisos.push(
        `${campo}: coluna/chave em falta (${[!col && `${m.tabela}.[${m.coluna}]`, !chave && `${m.tabela}.[${m.chave}]`, !chaveStocks && `Stocks.[${m.chaveStocks ?? "CodigoID"}]`].filter(Boolean).join(", ")}) — campo NÃO enviado.`,
      );
      continue;
    }
    const tab = m.tabela;
    // OUTER APPLY TOP 1: uma ligação não-única nunca multiplica produtos
    // (quebraria a paginação por CodigoID).
    const joinClause = `OUTER APPLY (
        SELECT TOP 1 t.[${col}] AS v
        FROM [dbo].[${tab}] t
        WHERE t.[${chave}] = s.[${chaveStocks}]
      ) ${alias}`;
    campos.push({ campo, alias, selectExpr: `${alias}.v`, joinClause, mapeamento: m, origem: `${tab}.[${col}]` });
  }
  return { campos, avisos };
}

/** Resolve o plano contra o schema real (sys.columns). Read-only. */
export async function resolverPlanoClassificacao(
  pool: SqlPool,
  config: ClassificacaoErpConfig,
): Promise<ClassificacaoPlan> {
  const colunas = new Map<string, Map<string, string>>();
  const tabelas = new Map<string, boolean>();
  const tabelasPedidas = new Set<string>(["Stocks"]);
  for (const campo of CAMPOS_CLASSIFICACAO) {
    const m = config[campo];
    if (m?.tabela) tabelasPedidas.add(m.tabela);
  }
  for (const t of tabelasPedidas) {
    const ex = await tableExists(pool, { schema: "dbo", table: t });
    tabelas.set(t.toLowerCase(), ex);
    if (!ex) continue;
    const mapa = new Map<string, string>();
    for (const c of await listColumns(pool, { schema: "dbo", table: t })) mapa.set(c.name.toLowerCase(), c.name);
    colunas.set(t.toLowerCase(), mapa);
  }
  return construirPlanoClassificacao(config, {
    tabela: (t) => tabelas.get(t.toLowerCase()) === true,
    coluna: (t, c) => colunas.get(t.toLowerCase())?.get(c.toLowerCase()) ?? null,
  });
}

/** Fragmentos para colar no SELECT principal. Plano vazio → strings vazias (SQL inalterado). */
export function buildClassificacaoSqlFragments(plan: ClassificacaoPlan): { select: string; join: string } {
  if (plan.campos.length === 0) return { select: "", join: "" };
  return {
    select: plan.campos.map((c) => `,\n      ${c.selectExpr} AS ${c.alias}`).join(""),
    join: plan.campos
      .map((c) => c.joinClause)
      .filter(Boolean)
      .join("\n    "),
  };
}

// ── Payload ──────────────────────────────────────────────────────────

export type EstatisticaClassificacao = {
  linhas: number;
  porCampo: Record<string, { sim: number; nao: number; desconhecido: number }>;
  /** Valores fora do mapeamento (com `valoresFalsos` definido), por campo. */
  foraDoMapeamento: Record<string, Map<string, number>>;
};

export function novaEstatisticaClassificacao(): EstatisticaClassificacao {
  return { linhas: 0, porCampo: {}, foraDoMapeamento: {} };
}

function triEstado(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  return null;
}

/**
 * Campos de classificação a juntar ao payload de UM produto.
 *
 *   · `genericoErp` → SEMPRE (coluna Stocks.[Generico] já lida; null =
 *     desconhecido). Não substitui `generico`, que continua a ir como antes.
 *   · etico/nett/servico + classificacaoErpOrigem → só os campos do plano.
 */
export function classificacaoParaPayload(
  plan: ClassificacaoPlan,
  row: Record<string, unknown>,
  stats?: EstatisticaClassificacao,
): Record<string, unknown> {
  const out: Record<string, unknown> = { genericoErp: triEstado(row.generico) };
  if (stats) stats.linhas++;
  const origens: string[] = [];
  for (const c of plan.campos) {
    const bruto = row[c.alias];
    const { valor, foraDoMapeamento } = interpretarValor(bruto, c.mapeamento);
    out[c.campo] = valor;
    origens.push(`${c.campo}=${c.origem}`);
    if (stats) {
      const s = (stats.porCampo[c.campo] ??= { sim: 0, nao: 0, desconhecido: 0 });
      if (valor === true) s.sim++;
      else if (valor === false) s.nao++;
      else s.desconhecido++;
      if (foraDoMapeamento) {
        const m = (stats.foraDoMapeamento[c.campo] ??= new Map());
        const k = String(bruto);
        m.set(k, (m.get(k) ?? 0) + 1);
      }
    }
  }
  if (origens.length > 0) out.classificacaoErpOrigem = `spharm_erp:${origens.join(";")}`;
  return out;
}

/** Linhas de resumo para o fim de uma corrida (vazio sem mapeamento). */
export function resumoEstatisticaClassificacao(plan: ClassificacaoPlan, stats: EstatisticaClassificacao): string[] {
  const out: string[] = [];
  for (const c of plan.campos) {
    const s = stats.porCampo[c.campo];
    if (!s) continue;
    out.push(`  Classificação ERP ${c.campo.padEnd(7)} (${c.origem}): sim=${s.sim} nao=${s.nao} desconhecido=${s.desconhecido}`);
    const f = stats.foraDoMapeamento[c.campo];
    if (f && f.size > 0) {
      const top = [...f.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
      out.push(`    valores FORA do mapeamento (enviados como desconhecido): ${top.map(([k, n]) => `"${k}"×${n}`).join(", ")}`);
    }
  }
  return out;
}

export function logPlanoClassificacao(plan: ClassificacaoPlan, erros: string[]): void {
  for (const e of erros) console.warn(`  [classificacaoErp] CONFIG INVÁLIDA: ${e}`);
  for (const a of plan.avisos) console.warn(`  [classificacaoErp] AVISO: ${a}`);
  if (plan.campos.length > 0) {
    console.log("  Classificação ERP (mapeamento configurado):");
    for (const c of plan.campos) {
      const vv = c.mapeamento.valoresVerdadeiros.map(String).join("|");
      console.log(`     ${c.campo.padEnd(8)} ${c.origem}  verdadeiro=[${vv}]`);
    }
  }
}

/** Linha de log com o resumo devolvido pelo servidor (null se o lote não trazia classificação). */
export function linhaRespostaClassificacao(resp: {
  classificacaoErp?: { candidatos: number; alterados: number; valoresDesconhecidos: number; conflitos: number; erro?: string };
}): string | null {
  const k = resp.classificacaoErp;
  if (!k) return null;
  return `    classificação ERP: candidatos=${k.candidatos} alterados=${k.alterados} desconhecidos=${k.valoresDesconhecidos} conflitos=${k.conflitos}${k.erro ? ` ERRO=${k.erro}` : ""}`;
}
