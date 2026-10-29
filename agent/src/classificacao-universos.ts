/**
 * agent/src/classificacao-universos.ts
 *
 * Os QUATRO universos do diagnóstico, sempre separados (relatório e JSON):
 *   (i)   TOTAL do ERP                 — todos os artigos de dbo.Stocks;
 *   (ii)  ATUALMENTE SINCRONIZÁVEL     — o que o agent leva hoje (predicados exatos do agent, não alterados);
 *   (iii) EFETIVAMENTE EXISTENTE NO MT — os CNPs de um ficheiro local exportado do MT (`--cnps-mt-ficheiro`), consultados
 *                                        no ERP em blocos (IN-lists de inteiros ≤ 1000, só SELECT agregado);
 *   (iv)  COBERTURA da classificação dentro do universo MT.
 * Só SELECT. Nada de nomes de produtos nem de valores: amostras só com CNP + categoria.
 * As partes de cálculo são PURAS (recebem as linhas agregadas); a leitura recebe o leitor seguro.
 */

import {
  de,
  ehTabelaAprovada,
  familiaDoTipo,
  lerColunasTabela,
  nomeCompacto,
  num,
  pareceDadoSensivel,
  q,
  sqlColunasDeTabela,
  tentar,
  valorSeguro,
  type ColunaTabela,
  type Ref,
} from "./classificacao-base.js";
import {
  CATEGORIAS_ARTIGO,
  classificarCodigo,
  construirMapeamento,
  type CategoriaArtigo,
  type EstadoMapeamento,
  type LinhaLookup,
  type MapeamentoEticoNett,
  type UsoCodigo,
} from "./classificacao-mapeamento.js";
import { dividirEmBlocos, resumirParse, type BlocoMt, type GrupoMt, type ParseMt, type ResumoFicheiroMt } from "./classificacao-mt.js";
import { MAX_ITENS_IN_LIST, type LeitorSql, type Linha } from "./sql-somente-leitura.js";

export const TABELA_STOCKS_REF: Ref = { esquema: "dbo", tabela: "Stocks" };
/** Predicados EXATOS do agent (bootstrap-upload.ts: catálogo ativo; daily-sync-runner.ts). Só descritivos aqui. */
export const PREDICADO_DAILY = "Processa_Stocks <> 0";
export const PREDICADO_BOOTSTRAP = "Retirado = 0 AND Processa_Stocks <> 0";
export const MOTIVO_SEM_FICHEIRO_MT = "não calculado: forneça --cnps-mt-ficheiro";

// ─────────────────────────────────────────────────────────────────────
// 1. Queries (todas SELECT)
// ─────────────────────────────────────────────────────────────────────

/** Colunas de dbo.Stocks que as consultas de universo usam (`null` = a coluna não existe). */
export type ColunasUniverso = {
  cnp: string | null;
  /** O CNP é numérico (IN-list sem aspas) ou texto (IN-list com dígitos entre aspas). */
  cnpNumerico: boolean;
  etico: string | null;
  generico: string | null;
  processa: string | null;
  retirado: string | null;
};

/** Lista de inteiros literais para `IN (...)`. Valida: só dígitos (≤ 12), 1..1000 itens. */
export function listaIn(cnps: string[], numerico: boolean): string {
  if (cnps.length === 0) throw new Error("IN-list vazia");
  if (cnps.length > MAX_ITENS_IN_LIST) throw new Error(`IN-list com mais de ${MAX_ITENS_IN_LIST} itens`);
  for (const c of cnps) if (!/^\d{1,12}$/.test(c)) throw new Error("CNP inválido na IN-list (só dígitos)");
  return cnps.map((c) => (numerico ? c : `'${c}'`)).join(", ");
}

const filtroIn = (c: ColunasUniverso, cnps: string[]) => `x.${q(c.cnp!)} IN (${listaIn(cnps, c.cnpNumerico)})`;

/** Expressões (SELECT e GROUP BY) das dimensões; uma coluna inexistente vira constante NULL (fora do GROUP BY). */
function dimensoes(c: ColunasUniverso): Array<{ expr: string | null; alias: string; constante: string }> {
  const caso = (col: string) =>
    `CASE WHEN x.${q(col)} IS NULL THEN N'nulo' WHEN x.${q(col)} = 0 THEN N'zero' ELSE N'dif' END`;
  return [
    { expr: c.etico ? `CAST(x.${q(c.etico)} AS NVARCHAR(50))` : null, alias: "cat", constante: "CAST(NULL AS NVARCHAR(50))" },
    { expr: c.generico ? `CAST(x.${q(c.generico)} AS NVARCHAR(10))` : null, alias: "gen", constante: "CAST(NULL AS NVARCHAR(10))" },
    { expr: c.processa ? caso(c.processa) : null, alias: "ps", constante: "CAST(NULL AS NVARCHAR(10))" },
    { expr: c.retirado ? caso(c.retirado) : null, alias: "ret", constante: "CAST(NULL AS NVARCHAR(10))" },
  ];
}

/**
 * Contagem agregada de dbo.Stocks por (categoria Etico_NETT, Generico, estado de Processa_Stocks, estado de Retirado),
 * opcionalmente restrita a um bloco de CNPs. Sem `cnps` = universo TOTAL do ERP.
 */
export function sqlDimensoes(c: ColunasUniverso, cnps?: string[]): string {
  const d = dimensoes(c);
  const itens = d.map((x) => `${x.expr ?? x.constante} AS ${x.alias}`);
  const grupo = d.filter((x) => x.expr !== null).map((x) => x.expr!);
  return [
    `SELECT TOP (2000) ${itens.join(", ")}, COUNT(*) AS n`,
    `  FROM ${de(TABELA_STOCKS_REF)}`,
    ...(cnps ? [` WHERE ${filtroIn(c, cnps)}`] : []),
    ...(grupo.length > 0 ? [` GROUP BY ${grupo.join(", ")}`] : []),
  ].join("\n");
}

/** Quantos CNPs distintos do bloco existem em Stocks (e quantas linhas: > distintos = Codigo repetido). */
export function sqlContagemCnps(c: ColunasUniverso, cnps: string[]): string {
  return [
    `SELECT COUNT(DISTINCT x.${q(c.cnp!)}) AS cnps, COUNT(*) AS linhas`,
    `  FROM ${de(TABELA_STOCKS_REF)}`,
    ` WHERE ${filtroIn(c, cnps)}`,
  ].join("\n");
}

/** Os CNPs do bloco que existem em Stocks (só CNP; para listar os que NÃO existem). */
export function sqlCnpsEncontrados(c: ColunasUniverso, cnps: string[]): string {
  return [
    `SELECT TOP (${MAX_ITENS_IN_LIST}) CAST(x.${q(c.cnp!)} AS NVARCHAR(30)) AS cnp`,
    `  FROM ${de(TABELA_STOCKS_REF)}`,
    ` WHERE ${filtroIn(c, cnps)}`,
  ].join("\n");
}

export type TipoAmostraMt = "fora-daily" | "fora-bootstrap" | "servico";
/** Amostra (só CNP + código de categoria) de CNPs do bloco que cumprem uma condição. */
export function sqlAmostraMt(c: ColunasUniverso, cnps: string[], tipo: TipoAmostraMt, codigosServico: string[], n: number): string {
  const ps = c.processa ? `x.${q(c.processa)}` : null;
  const ret = c.retirado ? `x.${q(c.retirado)}` : null;
  let cond: string;
  if (tipo === "fora-daily") cond = `(${ps} = 0 OR ${ps} IS NULL)`;
  else if (tipo === "fora-bootstrap") cond = `(${ps} = 0 OR ${ps} IS NULL${ret ? ` OR ${ret} <> 0 OR ${ret} IS NULL` : ""})`;
  else cond = `x.${q(c.etico!)} IN (${listaIn(codigosServico, c.cnpNumerico)})`;
  return [
    `SELECT TOP (${Math.max(1, Math.min(50, Math.trunc(n)))}) CAST(x.${q(c.cnp!)} AS NVARCHAR(30)) AS cnp, CAST(x.${q(c.etico!)} AS NVARCHAR(50)) AS cat`,
    `  FROM ${de(TABELA_STOCKS_REF)}`,
    ` WHERE ${filtroIn(c, cnps)} AND ${cond}`,
    ` ORDER BY x.${q(c.cnp!)}`,
  ].join("\n");
}

/** Conteúdo do lookup (código + descrição): tabela de domínio pequena, sem mais nada. */
export function sqlLookupConteudo(r: Ref, colCodigo: string, colDescricao: string): string {
  return [
    `SELECT TOP (300) CAST(x.${q(colCodigo)} AS NVARCHAR(50)) AS codigo, CAST(x.${q(colDescricao)} AS NVARCHAR(100)) AS descricao`,
    `  FROM ${de(r)}`,
    ` ORDER BY x.${q(colCodigo)}`,
  ].join("\n");
}

/** Nº de artigos por código de Etico_NETT em Stocks (inclui NULL). */
export function sqlUsoCodigos(coluna: string): string {
  const e = `CAST(x.${q(coluna)} AS NVARCHAR(50))`;
  return [`SELECT TOP (300) ${e} AS codigo, COUNT(*) AS n`, `  FROM ${de(TABELA_STOCKS_REF)}`, ` GROUP BY ${e}`, " ORDER BY COUNT(*) DESC"].join("\n");
}

// ─────────────────────────────────────────────────────────────────────
// 2. Distribuições (PURAS)
// ─────────────────────────────────────────────────────────────────────

export type DimRow = { cat: string | null; gen: string | null; ps: string | null; ret: string | null; n: number };
export type ContGenerico = { nulo: number; zero: number; um: number; outro: number };
export type Distribuicao = {
  total: number;
  porCategoria: Record<CategoriaArtigo, number>;
  porEstado: Record<EstadoMapeamento, number>;
  porGenerico: ContGenerico;
  categoriaXGenerico: Record<CategoriaArtigo, ContGenerico>;
};

const contGen = (): ContGenerico => ({ nulo: 0, zero: 0, um: 0, outro: 0 });
export function distribuicaoVazia(): Distribuicao {
  const porCategoria = {} as Record<CategoriaArtigo, number>;
  const categoriaXGenerico = {} as Record<CategoriaArtigo, ContGenerico>;
  for (const c of CATEGORIAS_ARTIGO) {
    porCategoria[c] = 0;
    categoriaXGenerico[c] = contGen();
  }
  return {
    total: 0,
    porCategoria,
    porEstado: { mapeada: 0, desconhecida: 0, orfao: 0, nula: 0, "sem-lookup": 0 },
    porGenerico: contGen(),
    categoriaXGenerico,
  };
}

export function chaveGenerico(g: string | null): keyof ContGenerico {
  if (g === null || g === undefined) return "nulo";
  const t = String(g).trim().toLowerCase();
  if (t === "0" || t === "false") return "zero";
  if (t === "1" || t === "true") return "um";
  return "outro";
}

export function lerDimRows(rows: Linha[]): DimRow[] {
  const s = (v: unknown) => (v === null || v === undefined ? null : String(v).trim());
  return rows.map((r) => ({ cat: s(r.cat), gen: s(r.gen), ps: s(r.ps), ret: s(r.ret), n: num(r.n) }));
}

/** Acumula as linhas que cumprem `filtro` numa distribuição. */
export function distribuir(rows: DimRow[], m: MapeamentoEticoNett, filtro: (r: DimRow) => boolean = () => true): Distribuicao {
  const d = distribuicaoVazia();
  for (const r of rows) {
    if (!filtro(r)) continue;
    const { categoria, estado } = classificarCodigo(r.cat, m);
    const g = chaveGenerico(r.gen);
    d.total += r.n;
    d.porCategoria[categoria] += r.n;
    d.porEstado[estado] += r.n;
    d.porGenerico[g] += r.n;
    d.categoriaXGenerico[categoria][g] += r.n;
  }
  return d;
}

export const noFiltroDaily = (r: DimRow) => r.ps === "dif";
export const noFiltroBootstrap = (r: DimRow) => r.ps === "dif" && r.ret === "zero";

export type UniversoTotal = { disponivel: boolean; motivo: string | null; distribuicao: Distribuicao | null };
export type UniversoSincronizavel = {
  disponivel: boolean;
  motivo: string | null;
  predicados: { daily: string; bootstrapAtivo: string };
  daily: Distribuicao | null;
  bootstrapAtivo: Distribuicao | null;
  /** Serviços (categoria SERVICO) no universo total, incluídos e excluídos pelos filtros do agent. */
  servicos: { totalErp: number; incluidosDaily: number; excluidosDaily: number; incluidosBootstrap: number; excluidosBootstrap: number } | null;
  /** Artigos de Etico_NETT NULL/órfão/desconhecido incluídos pelo filtro (para medir a cobertura). */
  foraDoFiltroPorCategoria: { daily: Record<CategoriaArtigo, number>; bootstrapAtivo: Record<CategoriaArtigo, number> } | null;
};

export function universosErp(rows: DimRow[], m: MapeamentoEticoNett, colunas: ColunasUniverso): { total: UniversoTotal; sincronizavel: UniversoSincronizavel } {
  const total = distribuir(rows, m);
  const predicados = { daily: PREDICADO_DAILY, bootstrapAtivo: PREDICADO_BOOTSTRAP };
  if (!colunas.processa) {
    return {
      total: { disponivel: true, motivo: null, distribuicao: total },
      sincronizavel: {
        disponivel: false,
        motivo: "dbo.Stocks sem coluna Processa_Stocks",
        predicados,
        daily: null,
        bootstrapAtivo: null,
        servicos: null,
        foraDoFiltroPorCategoria: null,
      },
    };
  }
  const daily = distribuir(rows, m, noFiltroDaily);
  const boot = colunas.retirado ? distribuir(rows, m, noFiltroBootstrap) : null;
  const fora = (filtro: (r: DimRow) => boolean) => distribuir(rows, m, (r) => !filtro(r)).porCategoria;
  const sv = total.porCategoria.SERVICO;
  return {
    total: { disponivel: true, motivo: null, distribuicao: total },
    sincronizavel: {
      disponivel: true,
      motivo: null,
      predicados,
      daily,
      bootstrapAtivo: boot,
      servicos: {
        totalErp: sv,
        incluidosDaily: daily.porCategoria.SERVICO,
        excluidosDaily: sv - daily.porCategoria.SERVICO,
        incluidosBootstrap: boot ? boot.porCategoria.SERVICO : 0,
        excluidosBootstrap: boot ? sv - boot.porCategoria.SERVICO : sv,
      },
      foraDoFiltroPorCategoria: { daily: fora(noFiltroDaily), bootstrapAtivo: colunas.retirado ? fora(noFiltroBootstrap) : fora(noFiltroDaily) },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// 3. Universo MT (leitura em blocos) e cobertura
// ─────────────────────────────────────────────────────────────────────

export type DimRowMt = DimRow & { flag: 0 | 1 | null; manual: 0 | 1 | null };
export type AmostraMt = { cnp: string; categoria: CategoriaArtigo };

export type ResultadoLeituraMt = {
  rows: DimRowMt[];
  blocosTotal: number;
  blocosProcessados: number;
  /** CNPs do ficheiro submetidos ao ERP (soma dos blocos processados). */
  cnpsConsultados: number;
  encontrados: number;
  linhasErp: number;
  naoEncontradosAmostra: string[];
  foraDailyAmostra: AmostraMt[];
  foraBootstrapAmostra: AmostraMt[];
  servicosAmostra: AmostraMt[];
  completo: boolean;
};

export type OpcoesLeituraMt = {
  dentroDoOrcamento: () => boolean;
  avisos: string[];
  maxAmostras: number;
  /** Códigos de Etico_NETT cuja categoria proposta é SERVICO (só inteiros). */
  codigosServico: string[];
};

/** Consulta o ERP bloco a bloco (só SELECT agregado; amostras só CNP + categoria). */
export async function lerUniversoMt(
  ler: LeitorSql,
  cols: ColunasUniverso,
  parse: ParseMt,
  m: MapeamentoEticoNett,
  o: OpcoesLeituraMt,
): Promise<ResultadoLeituraMt> {
  const blocos: BlocoMt[] = dividirEmBlocos(parse.entradas);
  const r: ResultadoLeituraMt = {
    rows: [],
    blocosTotal: blocos.length,
    blocosProcessados: 0,
    cnpsConsultados: 0,
    encontrados: 0,
    linhasErp: 0,
    naoEncontradosAmostra: [],
    foraDailyAmostra: [],
    foraBootstrapAmostra: [],
    servicosAmostra: [],
    completo: false,
  };
  const categoriaDe = (cat: unknown) => classificarCodigo(cat === null || cat === undefined ? null : String(cat), m).categoria;
  const servicoNumerico = o.codigosServico.length > 0 && o.codigosServico.every((c) => /^\d{1,12}$/.test(c));
  for (const [i, b] of blocos.entries()) {
    if (!o.dentroDoOrcamento()) {
      o.avisos.push(`orçamento de tempo esgotado: ${i} de ${blocos.length} blocos de CNPs do MT consultados (universo MT incompleto)`);
      return r;
    }
    const dims = await tentar(o.avisos, `bloco MT ${i + 1}/${blocos.length}`, () => ler(sqlDimensoes(cols, b.cnps)));
    const cont = await tentar(o.avisos, `bloco MT ${i + 1}/${blocos.length} (contagem)`, () => ler(sqlContagemCnps(cols, b.cnps)));
    if (!dims || !cont) {
      // Bloco falhado: não entra nas somas (o aviso diz qual); o relatório fica marcado como incompleto.
      continue;
    }
    r.blocosProcessados++;
    r.cnpsConsultados += b.cnps.length;
    const linhasBloco = lerDimRows(dims);
    for (const d of linhasBloco) r.rows.push({ ...d, flag: b.grupo.flag, manual: b.grupo.manual });
    const encontradosBloco = num(cont[0]?.cnps);
    r.encontrados += encontradosBloco;
    r.linhasErp += num(cont[0]?.linhas);

    // amostras (só CNP + categoria), só enquanto faltam e só se o bloco tem candidatos
    if (encontradosBloco < b.cnps.length && r.naoEncontradosAmostra.length < o.maxAmostras) {
      const achados = await tentar(o.avisos, `bloco MT ${i + 1} (CNPs encontrados)`, () => ler(sqlCnpsEncontrados(cols, b.cnps)));
      if (achados) {
        const set = new Set(achados.map((a) => String(a.cnp).trim().replace(/^0+(?=\d)/, "")));
        for (const c of b.cnps) {
          if (!set.has(c) && r.naoEncontradosAmostra.length < o.maxAmostras) r.naoEncontradosAmostra.push(c);
        }
      }
    }
    const amostrar = async (tipo: TipoAmostraMt, destino: AmostraMt[], haCandidatos: boolean) => {
      if (!haCandidatos || destino.length >= o.maxAmostras || !cols.cnp || !cols.etico) return;
      if (tipo !== "servico" && !cols.processa) return;
      if (tipo === "servico" && !servicoNumerico) return;
      const rows = await tentar(o.avisos, `bloco MT ${i + 1} (amostra ${tipo})`, () =>
        ler(sqlAmostraMt(cols, b.cnps, tipo, o.codigosServico, o.maxAmostras - destino.length)),
      );
      for (const x of rows ?? []) {
        const cnp = valorSeguro(x.cnp);
        if (cnp !== null && destino.length < o.maxAmostras) destino.push({ cnp, categoria: categoriaDe(x.cat) });
      }
    };
    await amostrar("fora-daily", r.foraDailyAmostra, linhasBloco.some((d) => !noFiltroDaily(d)));
    await amostrar("fora-bootstrap", r.foraBootstrapAmostra, linhasBloco.some((d) => !noFiltroBootstrap(d)));
    await amostrar("servico", r.servicosAmostra, linhasBloco.some((d) => categoriaDe(d.cat) === "SERVICO"));
  }
  r.completo = r.blocosProcessados === r.blocosTotal;
  if (!r.completo) o.avisos.push(`universo MT incompleto: ${r.blocosProcessados} de ${r.blocosTotal} blocos consultados com sucesso`);
  return r;
}

export type CelulaGenerico = { mtFlag: 0 | 1; erpGenerico: "NULL" | "0" | "1" | "outro"; manual: 0 | 1 | null; n: number };
export type CompararGenerico = {
  disponivel: boolean;
  motivo: string | null;
  matriz: CelulaGenerico[];
  /** MT.flagGenerico == ERP.Generico efetivo (NULL conta como 0). */
  concordantes: number;
  divergentes: number;
  divergentesExplicadasPorManual: number;
  divergentesSemManual: number;
  /** Divergentes de manual=0 explícito. */
  divergentesNaoExplicadas: number;
  /** ERP NULL e MT 0 (NULL tratado como 0 hoje). */
  erpNuloMtZero: number;
  conclusao: string;
};

/** Matriz MT.flagGenerico × ERP.Generico e divergências (explicadas por `manual` ou não). PURA. */
export function compararGenerico(rows: DimRowMt[], temColunaGenerico: boolean, ficheiroTemFlag: boolean): CompararGenerico {
  const vazio = (motivo: string): CompararGenerico => ({
    disponivel: false,
    motivo,
    matriz: [],
    concordantes: 0,
    divergentes: 0,
    divergentesExplicadasPorManual: 0,
    divergentesSemManual: 0,
    divergentesNaoExplicadas: 0,
    erpNuloMtZero: 0,
    conclusao: motivo,
  });
  if (!temColunaGenerico) return vazio("dbo.Stocks sem coluna Generico");
  if (!ficheiroTemFlag) return vazio("o ficheiro MT não traz flagGenerico (formato «cnp»): matriz não calculada");
  const cel = new Map<string, CelulaGenerico>();
  let concordantes = 0;
  let divergentes = 0;
  let expl = 0;
  let semManual = 0;
  let naoExpl = 0;
  let nuloZero = 0;
  for (const r of rows) {
    if (r.flag === null) continue;
    const k = chaveGenerico(r.gen);
    const erp: CelulaGenerico["erpGenerico"] = k === "nulo" ? "NULL" : k === "zero" ? "0" : k === "um" ? "1" : "outro";
    const ef = k === "um" ? 1 : 0;
    const chave = `${r.flag}|${erp}|${r.manual ?? "-"}`;
    const c = cel.get(chave) ?? { mtFlag: r.flag, erpGenerico: erp, manual: r.manual, n: 0 };
    c.n += r.n;
    cel.set(chave, c);
    if (ef === r.flag) concordantes += r.n;
    else {
      divergentes += r.n;
      if (r.manual === 1) expl += r.n;
      else if (r.manual === null) semManual += r.n;
      else naoExpl += r.n;
    }
    if (erp === "NULL" && r.flag === 0) nuloZero += r.n;
  }
  const matriz = [...cel.values()].sort((a, b) => a.mtFlag - b.mtFlag || a.erpGenerico.localeCompare(b.erpGenerico) || (a.manual ?? 2) - (b.manual ?? 2));
  let conclusao: string;
  if (divergentes === 0) conclusao = "sem divergências MT x ERP: sem prova de lacuna em Produto.flagGenerico nesta farmácia.";
  else if (naoExpl === 0 && semManual === 0)
    conclusao = `${divergentes} divergência(s), todas explicadas por manual (camposManuais protege flagGenerico): sem prova de lacuna.`;
  else
    conclusao =
      `${naoExpl + semManual} divergência(s) NÃO explicadas por manual${semManual > 0 ? ` (${semManual} sem a coluna manual no ficheiro)` : ""}: ` +
      "investigar (desfasamento de sincronização, agent antigo, alteração no ERP) antes de concluir; pode indicar lacuna.";
  return {
    disponivel: true,
    motivo: null,
    matriz,
    concordantes,
    divergentes,
    divergentesExplicadasPorManual: expl,
    divergentesSemManual: semManual,
    divergentesNaoExplicadas: naoExpl,
    erpNuloMtZero: nuloZero,
    conclusao,
  };
}

export type UniversoMt = {
  calculado: boolean;
  motivo: string | null;
  ficheiro: ResumoFicheiroMt | null;
  /** CNPs únicos válidos do ficheiro = universo existente no MT (para esta farmácia). */
  cnpsNoMt: number;
  /** Blocos (de ≤ 1000 CNPs) consultados no ERP. */
  blocos: { total: number; processados: number; completo: boolean } | null;
  distribuicao: Distribuicao | null;
};

export type CoberturaMt = {
  calculado: boolean;
  motivo: string | null;
  encontradosNoErp: number;
  naoEncontradosNoErp: number;
  /** Linhas de Stocks para os CNPs do MT; maior que os encontrados = Stocks.Codigo repetido. */
  linhasNoErp: number;
  pctEncontrados: number | null;
  naoEncontradosAmostra: string[];
  porCategoria: Record<CategoriaArtigo, number> | null;
  /** Dos encontrados: classificados por uma descrição mapeada vs UNKNOWN/NULL/órfão. */
  classificacao: {
    mapeada: number;
    desconhecida: number;
    orfao: number;
    nula: number;
    semLookup: number;
    pctMapeada: number | null;
  } | null;
  foraDoFiltro: {
    daily: { total: number; porCategoria: Record<CategoriaArtigo, number>; amostra: AmostraMt[] };
    bootstrapAtivo: { total: number; porCategoria: Record<CategoriaArtigo, number>; amostra: AmostraMt[] };
  } | null;
  servicos: { noMt: number; noMtIncluidosDaily: number; noMtExcluidosDaily: number; erpIncluidosDaily: number | null; amostra: AmostraMt[] } | null;
  generico: CompararGenerico | null;
};

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 10000) / 100 : null);

/** Constrói os universos (iii) e (iv) a partir da leitura em blocos. PURA. */
export function universosMt(
  parse: ParseMt | null,
  leitura: ResultadoLeituraMt | null,
  m: MapeamentoEticoNett,
  colunas: ColunasUniverso,
  erpIncluidosDaily: number | null,
): { existenteNoMt: UniversoMt; cobertura: CoberturaMt } {
  const naoCalc = (motivo: string) => ({
    existenteNoMt: { calculado: false, motivo, ficheiro: parse ? resumirParse(parse) : null, cnpsNoMt: parse?.unicos ?? 0, blocos: null, distribuicao: null },
    cobertura: {
      calculado: false,
      motivo,
      encontradosNoErp: 0,
      naoEncontradosNoErp: 0,
      linhasNoErp: 0,
      pctEncontrados: null,
      naoEncontradosAmostra: [],
      porCategoria: null,
      classificacao: null,
      foraDoFiltro: null,
      servicos: null,
      generico: null,
    } satisfies CoberturaMt,
  });
  if (!parse) return naoCalc(MOTIVO_SEM_FICHEIRO_MT);
  if (!leitura) return naoCalc("ficheiro MT lido, mas o ERP não foi consultado (dbo.Stocks sem coluna Codigo ou erro: ver avisos)");
  const dist = distribuir(leitura.rows, m);
  const encontrados = leitura.encontrados;
  const consultados = leitura.cnpsConsultados;
  const c = dist.porEstado;
  const tem = colunas.processa !== null;
  const foraDaily = distribuir(leitura.rows, m, (r) => !noFiltroDaily(r));
  const foraBoot = distribuir(leitura.rows, m, (r) => !noFiltroBootstrap(r));
  const dailyMt = distribuir(leitura.rows, m, noFiltroDaily);
  const svMt = dist.porCategoria.SERVICO;
  return {
    existenteNoMt: {
      calculado: true,
      motivo: leitura.completo ? null : "incompleto: nem todos os blocos foram consultados (ver avisos)",
      ficheiro: resumirParse(parse),
      cnpsNoMt: parse.unicos,
      blocos: { total: leitura.blocosTotal, processados: leitura.blocosProcessados, completo: leitura.completo },
      distribuicao: dist,
    },
    cobertura: {
      calculado: true,
      motivo: leitura.completo ? null : "incompleto: nem todos os blocos foram consultados (ver avisos)",
      encontradosNoErp: encontrados,
      naoEncontradosNoErp: Math.max(0, consultados - encontrados),
      linhasNoErp: leitura.linhasErp,
      pctEncontrados: pct(encontrados, consultados),
      naoEncontradosAmostra: leitura.naoEncontradosAmostra,
      porCategoria: dist.porCategoria,
      classificacao: {
        mapeada: c.mapeada,
        desconhecida: c.desconhecida,
        orfao: c.orfao,
        nula: c.nula,
        semLookup: c["sem-lookup"],
        pctMapeada: pct(c.mapeada, dist.total),
      },
      foraDoFiltro: tem
        ? {
            daily: { total: foraDaily.total, porCategoria: foraDaily.porCategoria, amostra: leitura.foraDailyAmostra },
            bootstrapAtivo: { total: foraBoot.total, porCategoria: foraBoot.porCategoria, amostra: leitura.foraBootstrapAmostra },
          }
        : null,
      servicos: {
        noMt: svMt,
        noMtIncluidosDaily: tem ? dailyMt.porCategoria.SERVICO : 0,
        noMtExcluidosDaily: tem ? svMt - dailyMt.porCategoria.SERVICO : svMt,
        erpIncluidosDaily,
        amostra: leitura.servicosAmostra,
      },
      generico: compararGenerico(leitura.rows, colunas.generico !== null, parse.comFlag > 0),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// 4. Lookup (descoberta + leitura)
// ─────────────────────────────────────────────────────────────────────

export function paraLinhasLookup(rows: Linha[]): LinhaLookup[] {
  return rows.map((r) => ({ codigo: String(r.codigo ?? "").trim(), descricao: r.descricao === null || r.descricao === undefined ? null : String(r.descricao) }));
}

// ─────────────────────────────────────────────────────────────────────
// 5. Markdown
// ─────────────────────────────────────────────────────────────────────

const c1 = (v: string | number | null | undefined) => (v === null || v === undefined ? "NULL" : `\`${String(v).replace(/\|/g, "\\|")}\``);
const catsNaoVazias = (r: Record<CategoriaArtigo, number>) => CATEGORIAS_ARTIGO.filter((k) => r[k] > 0 || ["ETICO", "NETT", "SERVICO", "SACOS", "OUTROS"].includes(k));

function tabelaDistribuicao(L: string[], d: Distribuicao): void {
  L.push("| categoria | artigos | NULL | Generico=0 | Generico=1 |", "|---|---|---|---|---|");
  for (const k of catsNaoVazias(d.porCategoria)) {
    const g = d.categoriaXGenerico[k];
    L.push(`| ${k} | ${d.porCategoria[k]} | ${g.nulo} | ${g.zero} | ${g.um} |`);
  }
  L.push(
    `| **total** | **${d.total}** | ${d.porGenerico.nulo} | ${d.porGenerico.zero} | ${d.porGenerico.um} |`,
    "",
    `Estado do mapeamento por descrição: mapeada=${d.porEstado.mapeada} · descrição desconhecida=${d.porEstado.desconhecida} · código órfão=${d.porEstado.orfao} · NULL=${d.porEstado.nula} · sem lookup=${d.porEstado["sem-lookup"]}`,
    "",
  );
}

export type UniversosRelatorio = {
  erpTotal: UniversoTotal;
  sincronizavel: UniversoSincronizavel;
  existenteNoMt: UniversoMt;
  coberturaMt: CoberturaMt;
};

export function renderMapeamento(L: string[], m: MapeamentoEticoNett): void {
  L.push("## F. Mapeamento de Stocks.Etico_NETT pela DESCRIÇÃO (PROPOSTA a validar)", "", m.aviso, "");
  if (!m.lookupEncontrado) L.push("**Lookup dbo.Etico_NETT ausente**: nada é mapeado.", "");
  else {
    L.push(
      `Lookup: \`${m.tabela}\` (descoberto por ${m.origemLookup === "fk" ? "FK declarada" : "nome da tabela"}) · código \`${m.colunaCodigo}\` · descrição \`${m.colunaDescricao}\``,
      "",
      "| código | descrição crua | descrição normalizada | categoria proposta | artigos (universo total) | alertas |",
      "|---|---|---|---|---|---|",
    );
    for (const l of m.linhas) L.push(`| ${c1(l.codigo)} | ${c1(l.descricaoCrua)} | ${c1(l.descricaoNormalizada)} | ${l.categoriaProposta} | ${l.artigos} | ${l.alertas.join(" ").replace(/\|/g, "\\|") || "-"} |`);
    L.push("");
    if (m.orfaos.length > 0) L.push(`Códigos órfãos em Stocks (sem linha no lookup): ${m.orfaos.map((o) => `${c1(o.codigo)}×${o.artigos}`).join(", ")}`, "");
  }
  L.push(`Artigos com Etico_NETT NULL: ${m.nulos} · total de artigos em Stocks: ${m.totalArtigos}`, "");
  if (m.alertas.length > 0) {
    L.push("Alertas:", "");
    for (const a of m.alertas) L.push(`- ${a}`);
    L.push("");
  }
}

export function renderUniversos(L: string[], u: UniversosRelatorio): void {
  L.push("## G. Universos (quatro, sempre separados)", "");
  L.push("### G.i Universo TOTAL do ERP (todos os artigos de dbo.Stocks)", "");
  if (u.erpTotal.distribuicao) tabelaDistribuicao(L, u.erpTotal.distribuicao);
  else L.push(u.erpTotal.motivo ?? "(indisponível)", "");

  const s = u.sincronizavel;
  L.push("### G.ii Universo ATUALMENTE SINCRONIZÁVEL (o que o agent leva hoje; predicados exatos, não alterados)", "");
  if (!s.disponivel) L.push(s.motivo ?? "(indisponível)", "");
  else {
    L.push(`**daily-sync** (\`${s.predicados.daily}\`):`, "");
    tabelaDistribuicao(L, s.daily!);
    if (s.bootstrapAtivo) {
      L.push(`**bootstrap, catálogo ativo** (\`${s.predicados.bootstrapAtivo}\`):`, "");
      tabelaDistribuicao(L, s.bootstrapAtivo);
    }
    if (s.servicos) {
      L.push(
        `Serviços: total no ERP **${s.servicos.totalErp}** · incluídos pelo daily **${s.servicos.incluidosDaily}** · excluídos pelo daily **${s.servicos.excluidosDaily}**` +
          ` · incluídos pelo bootstrap ativo ${s.servicos.incluidosBootstrap} · excluídos ${s.servicos.excluidosBootstrap}`,
        "",
      );
    }
  }

  const mt = u.existenteNoMt;
  L.push("### G.iii Universo EFETIVAMENTE EXISTENTE NO MT (ficheiro local de CNPs)", "");
  if (!mt.calculado) L.push(mt.motivo ?? MOTIVO_SEM_FICHEIRO_MT, "");
  else {
    const f = mt.ficheiro!;
    L.push(
      `Ficheiro: ${f.linhasLidas} linha(s) lidas · ${f.validas} válidas · **${mt.cnpsNoMt} CNPs únicos** · ${f.invalidas} inválidas${f.linhasInvalidasExemplo.length ? ` (linhas ${f.linhasInvalidasExemplo.join(", ")})` : ""}` +
        ` · ${f.duplicadas} duplicadas · ${f.conflitos} em conflito · com flagGenerico: ${f.comFlag} · com manual: ${f.comManual}${f.ignoradasPorLimite ? ` · ${f.ignoradasPorLimite} ignoradas por limite` : ""}`,
      "",
      `Blocos consultados no ERP (≤ 1000 CNPs, só SELECT agregado): ${mt.blocos?.processados}/${mt.blocos?.total}${mt.motivo ? ` — ${mt.motivo}` : ""}`,
      "",
    );
    if (mt.distribuicao) tabelaDistribuicao(L, mt.distribuicao);
  }

  const cv = u.coberturaMt;
  L.push("### G.iv COBERTURA da classificação dentro do universo existente no MT", "");
  if (!cv.calculado) L.push(cv.motivo ?? MOTIVO_SEM_FICHEIRO_MT, "");
  else {
    L.push(
      `CNPs do MT encontrados no ERP (Stocks.Codigo = CNP): **${cv.encontradosNoErp}** (${cv.pctEncontrados ?? "?"}%) · NÃO encontrados: **${cv.naoEncontradosNoErp}**` +
        (cv.linhasNoErp > cv.encontradosNoErp ? ` · atenção: ${cv.linhasNoErp} linhas de Stocks para ${cv.encontradosNoErp} CNPs (Codigo repetido)` : ""),
      "",
    );
    if (cv.naoEncontradosAmostra.length > 0) L.push(`Amostra de CNPs do MT não encontrados no ERP: ${cv.naoEncontradosAmostra.join(", ")}`, "");
    if (cv.classificacao) {
      const k = cv.classificacao;
      L.push(
        `Classificação dos encontrados: com categoria mapeada pela descrição **${k.mapeada}** (${k.pctMapeada ?? "?"}%) · descrição desconhecida ${k.desconhecida} · código órfão ${k.orfao} · NULL ${k.nula} · sem lookup ${k.semLookup}`,
        "",
      );
    }
    if (cv.porCategoria) L.push("Por categoria: " + catsNaoVazias(cv.porCategoria).map((k) => `${k}=${cv.porCategoria![k]}`).join(" · "), "");
    if (cv.foraDoFiltro) {
      const f = cv.foraDoFiltro;
      L.push(
        `Do MT FORA do filtro atual do agent: daily (Processa_Stocks = 0 ou NULL) **${f.daily.total}** (${catsNaoVazias(f.daily.porCategoria).map((k) => `${k}=${f.daily.porCategoria[k]}`).join(", ")})` +
          ` · bootstrap ativo (Processa_Stocks = 0/NULL ou Retirado ≠ 0) **${f.bootstrapAtivo.total}** (${catsNaoVazias(f.bootstrapAtivo.porCategoria).map((k) => `${k}=${f.bootstrapAtivo.porCategoria[k]}`).join(", ")})`,
        "",
      );
      if (f.daily.amostra.length > 0) L.push(`Amostra fora do daily (CNP:categoria): ${f.daily.amostra.map((a) => `${a.cnp}:${a.categoria}`).join(", ")}`, "");
    }
    if (cv.servicos) {
      const v = cv.servicos;
      L.push(
        `Serviços no MT: **${v.noMt}** (incluídos pelo filtro daily ${v.noMtIncluidosDaily} · excluídos ${v.noMtExcluidosDaily}); Serviços incluídos pelo filtro no ERP: ${v.erpIncluidosDaily ?? "?"}` +
          (v.amostra.length ? ` · amostra: ${v.amostra.map((a) => a.cnp).join(", ")}` : ""),
        "",
      );
    }
    if (cv.generico) {
      const g = cv.generico;
      L.push("**Genérico: MT.flagGenerico × ERP.Generico**", "");
      if (!g.disponivel) L.push(g.motivo ?? "", "");
      else {
        L.push("| MT.flagGenerico | ERP.Generico | manual | CNPs |", "|---|---|---|---|");
        for (const x of g.matriz) L.push(`| ${x.mtFlag} | ${x.erpGenerico} | ${x.manual ?? "?"} | ${x.n} |`);
        L.push(
          "",
          `Concordantes ${g.concordantes} · divergentes ${g.divergentes} (explicadas por manual ${g.divergentesExplicadasPorManual} · manual=0 ${g.divergentesNaoExplicadas} · sem informação manual ${g.divergentesSemManual}) · ERP NULL com MT 0: ${g.erpNuloMtZero}`,
          "",
          `Leitura: ${g.conclusao}`,
          "",
        );
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// 6. Orquestração (lookup + universos)
// ─────────────────────────────────────────────────────────────────────

export type CtxUniversos = {
  ler: LeitorSql;
  avisos: string[];
  dentroDoOrcamento: () => boolean;
  colsStocks: Array<{ coluna: string; tipo: string }>;
  fks: Array<{ coluna: string; esquemaRef: string; tabelaRef: string; colunaRef: string }>;
  /** `esquema.tabela` (minúsculas) → nº de linhas. */
  linhasPorTabela: Map<string, number>;
  /** Nomes REAIS (capitalização de sys.tables) das tabelas do ERP. */
  nomesTabelas: Ref[];
  parseMt: ParseMt | null;
  maxAmostras: number;
};

export function resolverColunasUniverso(cols: Array<{ coluna: string; tipo: string }>): ColunasUniverso {
  const por = (nome: string) => cols.find((c) => nomeCompacto(c.coluna) === nomeCompacto(nome)) ?? null;
  const cnp = por("Codigo");
  return {
    cnp: cnp?.coluna ?? null,
    cnpNumerico: cnp ? familiaDoTipo(cnp.tipo) === "numerico" : true,
    etico: por("Etico_NETT")?.coluna ?? null,
    generico: por("Generico")?.coluna ?? null,
    processa: por("Processa_Stocks")?.coluna ?? null,
    retirado: por("Retirado")?.coluna ?? null,
  };
}

/** Escolhe a coluna do código e a da descrição de um lookup. PURA. */
export function escolherColunasLookup(cols: ColunaTabela[], colunaRef: string | null): { codigo: string | null; descricao: string | null } {
  const codigo = colunaRef ?? cols.find((c) => nomeCompacto(c.coluna) === "codigo")?.coluna ?? cols[0]?.coluna ?? null;
  const textos = cols.filter(
    (c) => c.coluna !== codigo && familiaDoTipo(c.tipo) === "texto" && (c.tamanho ?? 0) > 0 && (c.tamanho ?? 0) <= 400,
  );
  const pref = (c: ColunaTabela) => (/desc|design|nome|etico|tipo/.test(nomeCompacto(c.coluna)) ? 0 : 1);
  const descricao = [...textos].sort((a, b) => pref(a) - pref(b) || a.ordem - b.ordem)[0]?.coluna ?? null;
  return { codigo, descricao };
}

export async function executarUniversos(c: CtxUniversos): Promise<{ mapeamento: MapeamentoEticoNett; universos: UniversosRelatorio; colunas: ColunasUniverso }> {
  const colunas = resolverColunasUniverso(c.colsStocks);
  if (!colunas.etico) c.avisos.push("dbo.Stocks sem coluna Etico_NETT: nenhuma categoria pode ser atribuída");

  // ── lookup: FK declarada de Stocks.Etico_NETT, ou tabela com o nome ──
  let lookup: LinhaLookup[] | null = null;
  let meta: Parameters<typeof construirMapeamento>[2] = { origem: null, tabela: null, colunaCodigo: null, colunaDescricao: null };
  if (colunas.etico) {
    const fk = c.fks.find((f) => nomeCompacto(f.coluna) === nomeCompacto(colunas.etico!));
    let ref: Ref | null = null;
    let colRef: string | null = null;
    let origem: "fk" | "nome" | null = null;
    if (fk) {
      ref = { esquema: fk.esquemaRef, tabela: fk.tabelaRef };
      colRef = fk.colunaRef;
      origem = "fk";
    } else {
      const hit = c.nomesTabelas.find((t) => nomeCompacto(t.tabela) === "eticonett");
      if (hit) {
        ref = { esquema: hit.esquema, tabela: hit.tabela };
        origem = "nome";
      }
    }
    if (ref && !ehTabelaAprovada(ref.tabela) && pareceDadoSensivel(ref.tabela)) {
      c.avisos.push("o lookup de Etico_NETT tem nome sensível: não lido");
      ref = null;
    }
    if (ref) {
      // `ref.tabela` vem de sys.* (com a capitalização real) ou da chave em minúsculas: reaplica o nome real se existir.
      const colsRows = (await tentar(c.avisos, "colunas do lookup Etico_NETT", () => c.ler(sqlColunasDeTabela(ref!)))) ?? [];
      const cols = lerColunasTabela(colsRows);
      const esc = escolherColunasLookup(cols, colRef);
      if (cols.length > 0 && esc.codigo && esc.descricao) {
        const rows = await tentar(c.avisos, "conteúdo do lookup Etico_NETT", () => c.ler(sqlLookupConteudo(ref!, esc.codigo!, esc.descricao!)));
        if (rows) {
          lookup = paraLinhasLookup(rows);
          meta = { origem, tabela: `${ref.esquema}.${ref.tabela}`, colunaCodigo: esc.codigo, colunaDescricao: esc.descricao };
        }
      } else {
        c.avisos.push(`lookup ${ref.esquema}.${ref.tabela} sem colunas de código/descrição legíveis`);
      }
    }
  }

  // ── uso dos códigos em Stocks ──
  let uso: UsoCodigo[] = [];
  if (colunas.etico) {
    const rows = await tentar(c.avisos, "uso de Etico_NETT em Stocks", () => c.ler(sqlUsoCodigos(colunas.etico!)));
    uso = (rows ?? []).map((r) => ({ codigo: r.codigo === null || r.codigo === undefined ? null : String(r.codigo).trim(), n: num(r.n) }));
  }
  const mapeamento = construirMapeamento(lookup, uso, meta);

  // ── universos (i) e (ii) ──
  const dimRows = await tentar(c.avisos, "universo total (dimensões)", () => c.ler(sqlDimensoes(colunas)));
  let erpTotal: UniversoTotal = { disponivel: false, motivo: "consulta falhou (ver avisos)", distribuicao: null };
  let sincronizavel: UniversoSincronizavel = {
    disponivel: false,
    motivo: "consulta falhou (ver avisos)",
    predicados: { daily: PREDICADO_DAILY, bootstrapAtivo: PREDICADO_BOOTSTRAP },
    daily: null,
    bootstrapAtivo: null,
    servicos: null,
    foraDoFiltroPorCategoria: null,
  };
  if (dimRows) {
    ({ total: erpTotal, sincronizavel } = universosErp(lerDimRows(dimRows), mapeamento, colunas));
    if (dimRows.length >= 2000) c.avisos.push("universo total: combinações de dimensões truncadas a 2000");
  }

  // ── universos (iii) e (iv) ──
  let leitura: ResultadoLeituraMt | null = null;
  if (c.parseMt && colunas.cnp) {
    leitura = await lerUniversoMt(c.ler, colunas, c.parseMt, mapeamento, {
      dentroDoOrcamento: c.dentroDoOrcamento,
      avisos: c.avisos,
      maxAmostras: c.maxAmostras,
      codigosServico: mapeamento.linhas.filter((l) => l.categoriaProposta === "SERVICO").map((l) => l.codigo),
    });
  } else if (c.parseMt) {
    c.avisos.push("universo MT não consultado: dbo.Stocks sem coluna Codigo");
  }
  const { existenteNoMt, cobertura } = universosMt(c.parseMt, leitura, mapeamento, colunas, sincronizavel.servicos?.incluidosDaily ?? null);
  return { mapeamento, universos: { erpTotal, sincronizavel, existenteNoMt, coberturaMt: cobertura }, colunas };
}
