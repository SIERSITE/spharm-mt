/**
 * agent/src/classificacao-auditoria.test.ts
 *
 * A auditoria READ-ONLY da classificação, SEM SQL Server real: um ERP falso
 * (dados sintéticos em memória) responde às queries que a auditoria gera.
 *
 * O que fica provado:
 *   1. só gera/executa SELECT (guarda + validador estrutural) e recusa o resto
 *      ANTES de executar;
 *   2. o relatório não contém credenciais nem dados pessoais (dados sintéticos
 *      que PARECEM pessoais: e-mail, telefone/NIF, colunas "Nome…", tabela
 *      Clientes);
 *   3. a exportação para ficheiro (--out .json / .md) funciona;
 *   4. a tabulação cruzada coincide com a verdade calculada à parte;
 *   5. serviços e Processa_Stocks são reportados (contagens, exemplos CNP,
 *      colunas que distinguem);
 *   6. NULL / vazio / 0 / outros são contados por categoria; nada é concluído.
 *
 * Uso: npx tsx agent/src/classificacao-auditoria.test.ts
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  criarLeitorSeguro,
  executarAuditoria,
  FRASE_READ_ONLY,
  OMITIDO,
  parseCnps,
  pareceDadoPessoal,
  renderMarkdown,
  resumirCruzada,
  sanitizaTexto,
  sqlAmostraPorValor,
  sqlColunasCandidatas,
  sqlConhecidos,
  sqlCruzada,
  sqlExemplosProcessa,
  sqlFksDeStocks,
  sqlLinhasPorTabela,
  sqlPerfilColuna,
  sqlProcessaStocks,
  sqlTopValores,
  sqlVersao,
  SqlRecusadoError,
  validarQueryAuditoria,
  validarSomenteSelect,
  type Linha,
  type RelatorioAuditoria,
} from "./classificacao-auditoria.js";
import { abrirPoolSoLeitura, escreverRelatorio, resolverSaidas } from "./commands/classification-audit.js";
import type { AgentConfig } from "./config.js";

let pass = 0;
let fail = 0;
const check = (c: boolean, l: string, d?: string) => {
  if (c) { pass++; console.log(`  [OK]    ${l}`); }
  else { fail++; console.log(`  [FALHA] ${l}${d ? `\n            ${d}` : ""}`); }
};

// ─────────────────────────────────────────────────────────────────────
// ERP falso (dados sintéticos)
// ─────────────────────────────────────────────────────────────────────

const SEGREDOS = { senha: "S3cr3t-Pass!", utilizador: "sa_farmacia", host: "10.20.30.40" };
type Row = { Codigo: number; CodigoID: number } & Record<string, string | number | null>;

function dataset(): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < 120; i++) {
    let tipo: string = i % 2 ? "M" : "X";
    if (i === 3) tipo = "joao.silva@example.com";
    if (i === 5) tipo = "912345678";
    if (i === 7) tipo = `pwd=${SEGREDOS.senha}`;
    rows.push({
      Codigo: 1000000 + i,
      CodigoID: i + 1,
      Servico: i % 10 === 0 ? 1 : 0,
      Etico: i % 7 === 0 ? null : i % 3 === 0 ? 1 : 0,
      NETT: i % 5 === 1 ? 1 : 0,
      Generico: i % 4 === 0 ? 1 : i % 4 === 2 ? null : 0,
      Processa_Stocks: i % 10 === 0 || i % 37 === 5 ? 0 : 1,
      Retirado: i % 9 === 0 ? 1 : 0,
      "Tipo Artigo": tipo,
      "Classe Livre": `C${i % 80}`,
    });
  }
  return rows;
}
const DADOS = dataset();
const txt = (r: Row, c: string): string | null => (r[c] === null || r[c] === undefined ? null : String(r[c]));

const COLUNAS_STOCKS: Array<[string, string, number]> = [
  ["CodigoID", "int", 4], ["Codigo", "int", 4], ["Nome Comercial", "varchar", 100], ["Servico", "bit", 1], ["Etico", "bit", 1],
  ["NETT", "bit", 1], ["Generico", "bit", 1], ["Processa_Stocks", "bit", 1], ["Retirado", "bit", 1],
  ["Tipo Artigo", "varchar", 20], ["Classe Livre", "varchar", 50], ["Observacao Tipo", "varchar", 2000],
  ["Data Classe", "datetime", 8], ["Grupo Utente", "varchar", 30], ["Nome Medico Tipo", "varchar", 60],
];

function candidatasFalsas(): Linha[] {
  const stocks = COLUNAS_STOCKS.filter(([n]) =>
    /etico|nett|servic|generic|tipo|class|grupo|processa|retirado/i.test(n),
  );
  const rows: Linha[] = stocks.map(([coluna, tipo, tamanho]) => ({ esquema: "dbo", tabela: "Stocks", coluna, tipo, tamanho, anulavel: 1 }));
  rows.push({ esquema: "dbo", tabela: "Clientes", coluna: "Tipo Cliente", tipo: "varchar", tamanho: 20, anulavel: 1 });
  rows.push({ esquema: "dbo", tabela: "TipoArtigo", coluna: "Tipo", tipo: "varchar", tamanho: 10, anulavel: 0 });
  return rows;
}

type Falso = { ler: (sql: string) => Promise<Linha[]>; executadas: string[]; tabelasLidas: Set<string> };

function erpFalso(opts: { falhaCruzada?: boolean } = {}): Falso {
  const executadas: string[] = [];
  const tabelasLidas = new Set<string>();
  const ler = async (sql: string): Promise<Linha[]> => {
    executadas.push(sql);
    for (const m of sql.matchAll(/FROM \[(\w+)\]\.\[([^\]]+)\] x/g)) tabelasLidas.add(`${m[1]}.${m[2]}`);
    if (sql.includes("@@VERSION")) {
      return [{ versao: `Microsoft SQL Server 2008 R2 (SP3) - 10.50.6000.34 (X64) \n\tAug 19 2014 12:21:34 \n\tCopyright (c) Microsoft Corporation ${SEGREDOS.host}`, baseDados: "SPharmDemo" }];
    }
    if (sql.includes("SUM(p.rows)")) {
      return [{ esquema: "dbo", tabela: "Stocks", linhas: DADOS.length }, { esquema: "dbo", tabela: "Clientes", linhas: 300 }, { esquema: "dbo", tabela: "TipoArtigo", linhas: 12 }];
    }
    if (sql.includes("COLLATE Latin1_General_CI_AI")) return candidatasFalsas();
    if (sql.includes("OBJECT_ID('dbo.Stocks')") && sql.includes("ty.name AS tipo")) {
      return COLUNAS_STOCKS.map(([coluna, tipo, tamanho]) => ({ coluna, tipo, tamanho }));
    }
    if (sql.includes("[sys].[foreign_keys]")) {
      return [{ coluna: "TipoArtigoID", tabelaRef: "TipoArtigo", colunaRef: "ID" }, { coluna: "ClienteID", tabelaRef: "Clientes", colunaRef: "ID" }];
    }
    let m = sql.match(/COUNT\(DISTINCT x\.\[([^\]]+)\]\)/);
    if (m) {
      const col = m[1]!;
      const vs = DADOS.map((r) => txt(r, col));
      const nn = vs.filter((v) => v !== null) as string[];
      return [{
        total: vs.length,
        preenchidas: nn.length,
        distintos: new Set(nn).size,
        vazios: nn.filter((v) => v.trim() === "").length,
        zeros: nn.filter((v) => v.trim() === "0").length,
        uns: nn.filter((v) => v.trim() === "1").length,
      }];
    }
    m = sql.match(/SELECT TOP \((\d+)\) CAST\(x\.\[([^\]]+)\] AS NVARCHAR\(100\)\) AS valor, COUNT\(\*\) AS n/);
    if (m) {
      const cont = new Map<string | null, number>();
      for (const r of DADOS) cont.set(txt(r, m[2]!), (cont.get(txt(r, m[2]!)) ?? 0) + 1);
      return [...cont].sort((a, b) => b[1] - a[1]).slice(0, Number(m[1])).map(([valor, n]) => ({ valor, n }));
    }
    m = sql.match(/CAST\(x\.\[([^\]]+)\] AS NVARCHAR\(100\)\) AS a, CAST\(x\.\[([^\]]+)\] AS NVARCHAR\(100\)\) AS b/);
    if (m) {
      if (opts.falhaCruzada && m[1] === "Etico") throw new Error(`timeout em ${SEGREDOS.host} password=${SEGREDOS.senha}`);
      const cont = new Map<string, { a: string | null; b: string | null; n: number }>();
      for (const r of DADOS) {
        const k = JSON.stringify([txt(r, m[1]!), txt(r, m[2]!)]);
        const e = cont.get(k) ?? { a: txt(r, m[1]!), b: txt(r, m[2]!), n: 0 };
        e.n++;
        cont.set(k, e);
      }
      return [...cont.values()].sort((x, y) => y.n - x.n);
    }
    if (sql.includes("AS diferenteDeZero")) {
      const ps = DADOS.map((r) => r.Processa_Stocks);
      return [{ total: ps.length, zero: ps.filter((v) => v === 0).length, diferenteDeZero: ps.filter((v) => v !== null && v !== 0).length, nulos: ps.filter((v) => v === null).length }];
    }
    if (sql.includes("AS processaStocks")) {
      const zero = /WHERE x\.\[Processa_Stocks\] = 0/.test(sql);
      const extras = [...sql.matchAll(/CAST\(x\.\[([^\]]+)\] AS NVARCHAR\(60\)\) AS c(\d)/g)];
      return DADOS.filter((r) => (zero ? r.Processa_Stocks === 0 : r.Processa_Stocks !== 0)).slice(0, 10).map((r) => {
        const o: Linha = { cnp: r.Codigo, codigoId: r.CodigoID, processaStocks: String(r.Processa_Stocks) };
        for (const e of extras) o[`c${e[2]}`] = txt(r, e[1]!);
        return o;
      });
    }
    if (sql.includes("AS cnp, x.[CodigoID] AS codigoId") && /WHERE x\.\[[^\]]+\] IS NULL|= N'/.test(sql)) {
      const nulo = sql.match(/WHERE x\.\[([^\]]+)\] IS NULL/);
      const val = sql.match(/WHERE CAST\(x\.\[([^\]]+)\] AS NVARCHAR\(100\)\) = N'((?:[^']|'')*)'/);
      const n = Number(sql.match(/TOP \((\d+)\)/)![1]);
      const sel = nulo ? DADOS.filter((r) => txt(r, nulo[1]!) === null) : DADOS.filter((r) => txt(r, val![1]!) === val![2]!.replace(/''/g, "'"));
      return sel.slice(0, n).map((r) => ({ cnp: r.Codigo, codigoId: r.CodigoID }));
    }
    if (sql.includes(" IN (")) {
      const lista = [...sql.matchAll(/'(\d+)'/g)].map((x) => x[1]!);
      const extras = [...sql.matchAll(/CAST\(x\.\[([^\]]+)\] AS NVARCHAR\(60\)\) AS c(\d+)/g)];
      return DADOS.filter((r) => lista.includes(String(r.Codigo))).map((r) => {
        const o: Linha = { cnp: String(r.Codigo), codigoId: r.CodigoID };
        for (const e of extras) o[`c${e[2]}`] = txt(r, e[1]!);
        return o;
      });
    }
    throw new Error(`query não prevista pelo ERP falso: ${sql.slice(0, 120)}`);
  };
  return { ler, executadas, tabelasLidas };
}

const AGORA = new Date("2026-10-29T12:34:56.000Z");
async function correr(extra: Parameters<typeof executarAuditoria>[1] = {}, falho: Parameters<typeof erpFalso>[0] = {}) {
  const erp = erpFalso(falho);
  const registo: string[] = [];
  const rel = await executarAuditoria(criarLeitorSeguro(erp.ler, registo), {
    agentRev: "99",
    agora: () => AGORA,
    segredos: [SEGREDOS.senha, SEGREDOS.utilizador, SEGREDOS.host],
    ...extra,
  });
  return { rel, erp, registo };
}

async function main() {
  // ═══ 1. Guarda read-only ══════════════════════════════════════════
  console.log("\n=== 1. Só SELECT: a guarda recusa tudo o resto ===");
  const recusadas = [
    "INSERT INTO [dbo].[Stocks] ([a]) VALUES (1)",
    "UPDATE [dbo].[Stocks] SET [a] = 1",
    "DELETE FROM [dbo].[Stocks]",
    "DROP TABLE [dbo].[Stocks]",
    "TRUNCATE TABLE [dbo].[Stocks]",
    "ALTER TABLE [dbo].[Stocks] ADD x int",
    "CREATE TABLE t (a int)",
    "EXEC sp_who",
    "EXECUTE ('SELECT 1')",
    "MERGE [dbo].[Stocks] AS t USING s ON 1=1 WHEN MATCHED THEN DELETE",
    "SELECT [a] INTO [dbo].[copia] FROM [dbo].[Stocks]",
    "SELECT 1; DROP TABLE [dbo].[Stocks]",
    "SELECT 1 -- comentario",
    "SELECT /* x */ 1",
    "SELECT * FROM OPENROWSET('SQLNCLI', 'x', 'SELECT 1')",
    "SELECT xp_cmdshell('dir')",
    "WITH t AS (SELECT 1 AS a) SELECT a FROM t",
    "SET NOCOUNT ON",
    "DECLARE @a int",
    "BEGIN TRANSACTION",
    "GRANT SELECT ON [dbo].[Stocks] TO x",
    "SELECT 'aberto",
  ];
  for (const s of recusadas) check(validarSomenteSelect(s).length > 0, `recusada: ${s.slice(0, 55)}`);
  check(validarSomenteSelect("SELECT x.[Update] AS u FROM [dbo].[T] x WHERE x.[a] = N'DELETE; --' ").length === 0, "palavras proibidas dentro de [identificador] / 'literal' não contam");

  let executou = 0;
  const leitor = criarLeitorSeguro(async () => { executou++; return []; });
  for (const s of ["UPDATE [dbo].[Stocks] SET [a] = 1", "SELECT 1; DROP TABLE x", "EXEC sp_who"]) {
    let erro: unknown = null;
    try { await leitor(s); } catch (e) { erro = e; }
    check(erro instanceof SqlRecusadoError, `leitor seguro lança SqlRecusadoError: ${s.slice(0, 30)}`);
  }
  check(executou === 0, "o executor NUNCA foi chamado com SQL recusado");

  console.log("\n=== 2. Todas as queries geradas passam guarda + sql-validador ===");
  const geradas: Record<string, string> = {
    versao: sqlVersao(),
    candidatas: sqlColunasCandidatas(),
    linhas: sqlLinhasPorTabela(),
    fks: sqlFksDeStocks(),
    perfilTexto: sqlPerfilColuna({ esquema: "dbo", tabela: "Stocks" }, "Tipo Artigo", "texto"),
    perfilNum: sqlPerfilColuna({ esquema: "dbo", tabela: "Stocks" }, "Etico", "numerico"),
    top: sqlTopValores({ esquema: "dbo", tabela: "Stocks" }, "Etico", 15),
    cruzada: sqlCruzada({ esquema: "dbo", tabela: "Stocks" }, "Etico", "Servico"),
    amostra: sqlAmostraPorValor("Etico", "1", 3),
    amostraNulo: sqlAmostraPorValor("Etico", null, 3),
    amostraAspas: sqlAmostraPorValor("Tipo Artigo", "O'Brien", 3),
    processa: sqlProcessaStocks(),
    exZero: sqlExemplosProcessa(true, ["Etico", "Servico"]),
    exNZ: sqlExemplosProcessa(false, ["Etico"]),
    conhecidos: sqlConhecidos(["1000001", "1000002"], ["Etico", "Servico"]),
  };
  for (const [k, sql] of Object.entries(geradas)) {
    const p = validarQueryAuditoria(sql);
    check(p.length === 0, `query ${k} válida e read-only`, p.join(" | "));
  }
  check(Object.values(geradas).every((s) => /^SELECT\b/.test(s)), "todas começam por SELECT");
  check(Object.values(geradas).filter((s) => /FROM \[dbo\]\.\[Stocks\] x/.test(s)).every((s) => s.includes("WITH (NOLOCK)")), "leituras a dbo.Stocks com NOLOCK (não bloqueiam o ERP)");

  // ═══ 3. Execução completa ═════════════════════════════════════════
  console.log("\n=== 3. Auditoria completa sobre o ERP falso ===");
  const { rel, erp, registo } = await correr({ cnps: ["1000001", "1000010", "9999999"] });
  const json = JSON.stringify(rel);
  const md = renderMarkdown(rel);

  check(erp.executadas.length > 30 && registo.length === erp.executadas.length, `${erp.executadas.length} queries executadas, todas registadas`);
  check(erp.executadas.every((s) => validarQueryAuditoria(s).length === 0), "TODAS as queries executadas passam guarda + validador");
  check(erp.executadas.every((s) => /^SELECT\b/.test(s) && !/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|EXEC|MERGE|TRUNCATE|INTO)\b/i.test(s.replace(/\[[^\]]*\]/g, "[]").replace(/'[^']*'/g, "''"))), "nenhuma query tem verbos de escrita");
  check(![...erp.tabelasLidas].some((t) => /clientes/i.test(t)), "tabela Clientes (dado pessoal) nunca é lida");
  check(!erp.executadas.some((s) => /Grupo Utente|Nome Medico/.test(s) && /AS valor|COUNT\(DISTINCT/.test(s)), "colunas com nome pessoal nunca são lidas");

  console.log("\n--- cabeçalho ---");
  check(rel.cabecalho.geradoEmUtc === "2026-10-29T12:34:56.000Z", "data/hora UTC no cabeçalho");
  check(rel.cabecalho.agentRev === "99" && md.includes("rev99"), "rev do agent no cabeçalho");
  check(rel.cabecalho.modo === FRASE_READ_ONLY && md.includes(FRASE_READ_ONLY), `frase "${FRASE_READ_ONLY}"`);
  check(rel.cabecalho.baseDados === "SPharmDemo" && md.includes("SPharmDemo"), "nome da base (DB_NAME)");
  check(rel.cabecalho.sqlServer === "Microsoft SQL Server 2008 R2 (SP3) - 10.50.6000.34 (X64)", "versão do SQL Server (só a 1.ª linha de @@VERSION)", String(rel.cabecalho.sqlServer));

  console.log("\n--- colunas candidatas e omissões ---");
  const cand = (t: string, c: string) => rel.colunasCandidatas.find((x) => x.tabela === t && x.coluna === c);
  check(cand("Stocks", "Etico")?.inspeccao === "inspeccionada" && cand("Stocks", "Generico")?.tipo === "bit", "Etico/Generico inspeccionadas, com tipo");
  check(cand("Clientes", "Tipo Cliente")?.inspeccao === "omitida-dado-pessoal", "Clientes.Tipo Cliente omitida (dado pessoal)");
  check(cand("Stocks", "Grupo Utente")?.inspeccao === "omitida-dado-pessoal" && cand("Stocks", "Nome Medico Tipo")?.inspeccao === "omitida-dado-pessoal", "colunas com nome pessoal omitidas");
  check(cand("Stocks", "Observacao Tipo")?.inspeccao === "texto-longo", "texto longo não é lido");
  check(cand("Stocks", "Data Classe")?.inspeccao === "tipo-nao-inspeccionavel", "tipo datetime não é inspeccionado");
  check(cand("TipoArtigo", "Tipo")?.linhasTabela === 12, "nº de linhas por tabela");
  check(!md.includes("Grupo Utente") && !md.includes("Nome Medico") && !md.includes("Tipo Cliente"), "nomes de colunas pessoais ocultados no Markdown");
  check(rel.fksDeStocks.length === 1 && rel.fksDeStocks[0]!.tabelaRef === "TipoArtigo", "FKs: a que aponta para Clientes é filtrada");

  console.log("\n--- NULL / vazio / 0 / outros e valores distintos ---");
  const pGen = rel.perfis.find((p) => p.tabela === "dbo.Stocks" && p.coluna === "Generico")!;
  const verdade = (c: string) => {
    const m = new Map<string | null, number>();
    for (const r of DADOS) m.set(txt(r, c), (m.get(txt(r, c)) ?? 0) + 1);
    return m;
  };
  const vg = verdade("Generico");
  check(pGen.valores.length === vg.size && pGen.valores.every((v) => vg.get(v.valor) === v.n), "Generico: valores distintos e contagens = verdade", JSON.stringify(pGen.valores));
  check(pGen.categorias.nulo === (vg.get(null) ?? 0) && pGen.categorias.zero === (vg.get("0") ?? 0) && pGen.categorias.um === (vg.get("1") ?? 0) && pGen.categorias.outros === 0 && pGen.categorias.vazio === 0, "Generico: categorias NULL / 0 / 1 / vazio / outros", JSON.stringify(pGen.categorias));
  check(rel.generico.encontrado && rel.generico.coluna === "Generico" && rel.generico.amostras.length === pGen.valores.length, "secção Genérico com amostras por valor");
  check(rel.generico.amostras.every((a) => a.exemplos.length > 0 && a.exemplos.every((e) => /^\d{7}$/.test(e.cnp ?? ""))), "amostras de Genérico só com CNP/código");
  const pLivre = rel.perfis.find((p) => p.coluna === "Classe Livre")!;
  check(pLivre.distintos === 80 && !pLivre.listaCompleta && pLivre.valores.length === 15, "texto livre com muitas variantes: só top-15, lista parcial");
  const pTipo = rel.perfis.find((p) => p.coluna === "Tipo Artigo")!;
  check(pTipo.valores.every((v) => v.valor === null || !/@|\d{9}/.test(v.valor)), "valores com e-mail / 9 dígitos mascarados");
  check(pTipo.valores.some((v) => v.valor === OMITIDO), "…e substituídos por [omitido]");
  check(!rel.amostras.some((a) => a.coluna === "Tipo Artigo" && a.valor === OMITIDO), "valor mascarado nunca vira WHERE nem amostra");
  check(!erp.executadas.some((s) => s.includes("joao.silva") || s.includes("912345678")), "dados pessoais nunca voltam ao SQL");

  console.log("\n--- tabulação cruzada (SQL agregado) ---");
  const cruz = rel.cruzadas.find((t) => t.colunaA === "Etico" && t.colunaB === "Servico") ?? rel.cruzadas.find((t) => t.colunaA === "Servico" && t.colunaB === "Etico");
  check(!!cruz, "par Etico × Servico presente");
  if (cruz) {
    const verdadeCruz = new Map<string, number>();
    for (const r of DADOS) {
      const k = `${txt(r, cruz.colunaA)}|${txt(r, cruz.colunaB)}`;
      verdadeCruz.set(k, (verdadeCruz.get(k) ?? 0) + 1);
    }
    check(cruz.celulas.length === verdadeCruz.size && cruz.celulas.every((c) => verdadeCruz.get(`${c.a}|${c.b}`) === c.n), "cada combinação tem a contagem correta", JSON.stringify(cruz.celulas));
    check(cruz.celulas.reduce((s, c) => s + c.n, 0) === DADOS.length, "a soma das células = nº de linhas");
    const esperadoAmbasUm = DADOS.filter((r) => r.Etico === 1 && r.Servico === 1).length;
    check(cruz.ambasUm === esperadoAmbasUm, `linhas com ambas=1 = ${esperadoAmbasUm}`, String(cruz.ambasUm));
    check(cruz.combinacoes === verdadeCruz.size, "nº de combinações distintas");
  }
  check(rel.cruzadas.length === 21 && rel.avisos.every((a) => !/limitados/.test(a)), "21 pares (7 colunas de baixa cardinalidade), sem truncagem");
  const cNum = resumirCruzada("A", "B", [{ a: "1", b: "1", n: 3 }, { a: "0", b: "1", n: 5 }, { a: null, b: "0", n: 2 }]);
  check(cNum.ambasUm === 3 && cNum.combinacoes === 3, "resumirCruzada: factos de uma matriz pequena");
  check(resumirCruzada("A", "B", [{ a: "M", b: "1", n: 3 }]).ambasUm === null, "colunas não 0/1: ambasUm = null (sem inventar)");
  check(!/mutuamente exclusiv|são independentes|conclu[ií]mos que/i.test(md.replace("Nenhuma conclusão automática sobre exclusividade ou independência.", "")), "o relatório não conclui exclusividade/independência");

  console.log("\n--- serviços e Processa_Stocks ---");
  const s = rel.servicos;
  const ps0 = DADOS.filter((r) => r.Processa_Stocks === 0).length;
  check(s.disponivel && s.total === DADOS.length && s.zero === ps0 && s.diferenteDeZero === DADOS.length - ps0 && s.nulos === 0, `Processa_Stocks = 0: ${ps0}; <> 0: ${DADOS.length - ps0}`);
  check(s.filtroDoAgent.includes("<> 0") && s.filtroDoAgent.includes("NÃO provam"), "diz que o agent filtra Processa_Stocks <> 0 e que isso não prova serviço");
  const dServ = s.distinguemPorColuna.find((d) => d.coluna === "Servico");
  check(!!dServ && dServ.soComZero.some((v) => v.valor === "1" && v.n === DADOS.filter((r) => r.Servico === 1).length), "Servico=1 só aparece com Processa_Stocks = 0 (facto observado)", JSON.stringify(dServ));
  check(!!dServ && dServ.emAmbos.some((v) => v.valor === "0" && v.zero > 0 && v.diferenteDeZero > 0), "Servico=0 aparece nos dois grupos");
  check(s.exemplosZero.length === 10 && s.exemplosZero.every((e) => /^\d{7}$/.test(e.cnp ?? "") && e.processaStocks === "0"), "exemplos CNP/código com Processa_Stocks = 0");
  check(s.exemplosDiferenteDeZero.length === 10 && s.exemplosDiferenteDeZero.every((e) => e.processaStocks === "1"), "exemplos CNP/código com Processa_Stocks <> 0");
  check(s.exemplosZero.every((e) => !("Nome Comercial" in e)) && !/Nome Comercial|Preco/i.test(md), "exemplos sem nomes nem preços");

  console.log("\n--- CNPs conhecidos ---");
  const k1 = rel.conhecidos.find((c) => c.cnp === "1000001")!;
  const r1 = DADOS.find((r) => r.Codigo === 1000001)!;
  check(k1.encontrado && k1.valores["Servico"] === txt(r1, "Servico") && k1.valores["Generico"] === txt(r1, "Generico"), "CNP existente mostra a classificação de cada coluna");
  check(rel.conhecidos.find((c) => c.cnp === "9999999")!.encontrado === false, "CNP inexistente marcado como não encontrado");
  const k10 = rel.conhecidos.find((c) => c.cnp === "1000010")!;
  check(k10.valores["Servico"] === "1" && k10.valores["Processa_Stocks"] === "0", "serviço conhecido: Servico=1, Processa_Stocks=0");
  const pc = parseCnps("1234567, 7654321\n0001234 abc 12;DROP 1234567 123456789012");
  check(pc.cnps.join(",") === "1234567,7654321,1234,12" && pc.invalidos === 3, "parseCnps: só dígitos, sem duplicados, tokens inválidos contados", JSON.stringify(pc));
  const injeccao = await correr({ cnps: parseCnps("1000001'; DROP TABLE x;--, 1000002").cnps });
  check(injeccao.rel.conhecidos.length === 1 && !injeccao.erp.executadas.some((q) => /DROP/i.test(q)), "tentativa de injecção por CNP nunca chega ao SQL");

  // ═══ 4. Sanitização ═══════════════════════════════════════════════
  console.log("\n=== 4. Sem credenciais nem dados pessoais no relatório ===");
  const falho = await correr({ cnps: ["1000001"] }, { falhaCruzada: true });
  const tudo = [json, md, JSON.stringify(falho.rel), renderMarkdown(falho.rel)].join("\n");
  check(!tudo.includes(SEGREDOS.senha), "palavra-passe ausente (incl. valor de dados e mensagem de erro)");
  check(!tudo.includes(SEGREDOS.utilizador), "utilizador ausente");
  check(!tudo.includes(SEGREDOS.host), "anfitrião/IP ausente (incl. na versão e em erros)");
  check(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/i.test(tudo), "nenhum e-mail");
  check(!/\d{9,}/.test(tudo.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z/g, "")), "nenhuma sequência de ≥9 dígitos (NIF/telefone)");
  check(!/joao\.silva|912345678/.test(tudo), "valores pessoais sintéticos ausentes");
  check(falho.rel.avisos.some((a) => /cruzada Etico/.test(a)) && falho.rel.cruzadas.length < 21, "erro numa tabulação é aviso, não aborta a auditoria");
  check(falho.rel.avisos.every((a) => !a.includes(SEGREDOS.senha) && !a.includes(SEGREDOS.host)), "avisos de erro redigidos");
  check(sanitizaTexto("a@b.pt 912 345 678 123456789 ok") === `${OMITIDO} ${OMITIDO} ${OMITIDO} ok`, "sanitizaTexto: e-mail, telefone com espaços, NIF");
  check(pareceDadoPessoal("Nome Cliente") && pareceDadoPessoal("NIF") && pareceDadoPessoal("Morada") && pareceDadoPessoal("Telemóvel") && pareceDadoPessoal("E-mail") && !pareceDadoPessoal("Etico") && !pareceDadoPessoal("Comparticipacao") && !pareceDadoPessoal("Tipo Artigo"), "pareceDadoPessoal: pessoal vs classificação");

  // ═══ 5. Limites ═══════════════════════════════════════════════════
  console.log("\n=== 5. Limites ===");
  const lim = await correr({ maxColunas: 3, maxPares: 2, top: 5 });
  check(lim.rel.colunasCandidatas.filter((c) => c.inspeccao === "inspeccionada").length === 3, "--max-colunas respeitado");
  check(lim.rel.colunasCandidatas.some((c) => c.inspeccao === "limite-de-colunas"), "colunas fora do limite marcadas");
  check(lim.rel.perfis.some((p) => p.coluna === "Generico") || lim.rel.colunasCandidatas.find((c) => c.coluna === "Generico")?.inspeccao !== "inspeccionada", "Generico tem prioridade na seleção");
  check(lim.rel.cruzadas.length <= 2, "--maxPares respeitado");
  const semTempo = await correr({ orcamentoMs: -1 });
  check(semTempo.rel.perfis.length === 0 && semTempo.rel.colunasCandidatas.some((c) => /orçamento/.test(c.nota ?? "")), "orçamento de tempo esgotado: pára de inspeccionar e diz porquê");

  // ═══ 6. Exportação e comando ══════════════════════════════════════
  console.log("\n=== 6. Exportação para ficheiro (--out) ===");
  const dir = mkdtempSync(path.join(tmpdir(), "cls-audit-"));
  try {
    const segredos = [SEGREDOS.senha, SEGREDOS.utilizador, SEGREDOS.host];
    const fj = path.join(dir, "sub", "auditoria.json");
    const fm = path.join(dir, "auditoria.md");
    const [e1] = escreverRelatorio(rel, resolverSaidas(fj, dir, "ts"), segredos);
    const [e2] = escreverRelatorio(rel, resolverSaidas(fm, dir, "ts"), segredos);
    const lido: RelatorioAuditoria = JSON.parse(readFileSync(e1!, "utf8"));
    check(lido.cabecalho.baseDados === "SPharmDemo" && lido.perfis.length === rel.perfis.length && lido.cabecalho.modo === FRASE_READ_ONLY, "--out x.json: JSON válido (cria a pasta) com o mesmo conteúdo");
    const lidoMd = readFileSync(e2!, "utf8");
    check(lidoMd.startsWith("# classification-audit") && lidoMd.includes("2026-10-29T12:34:56.000Z") && lidoMd.includes("## 5. Relação entre colunas"), "--out x.md: Markdown com cabeçalho e secções");
    check(![lidoMd, readFileSync(e1!, "utf8")].some((t) => t.includes(SEGREDOS.senha) || t.includes(SEGREDOS.host) || /@[a-z]+\.[a-z]/i.test(t)), "ficheiros exportados sem credenciais nem e-mails");
    const porOmissao = resolverSaidas(undefined, dir, "T1");
    check(porOmissao.length === 2 && porOmissao.map((x) => x.formato).sort().join() === "json,md", "sem --out: .md e .json em out-dir");
    let erroExt = false;
    try { resolverSaidas(path.join(dir, "x.txt"), dir, "t"); } catch { erroExt = true; }
    check(erroExt, "--out com extensão inválida é recusado");
    check(readdirSync(dir).length >= 2, "ficheiros criados no destino indicado");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("\n=== 7. Ligação read-only e registo do comando ===");
  const cfgFalsa = {
    sqlHost: SEGREDOS.host, sqlPort: 1433, sqlDatabase: "SPharmDemo", sqlUser: SEGREDOS.utilizador, sqlPassword: SEGREDOS.senha,
    sqlEncrypt: false, sqlTrustCert: true, sqlRequestTimeoutMs: 30_000,
  } as unknown as AgentConfig;
  const pool = abrirPoolSoLeitura(cfgFalsa, 7_000);
  const opcoes = (pool as unknown as { config: { options: Record<string, unknown> } }).config.options;
  check(opcoes.readOnlyIntent === true, "ApplicationIntent=ReadOnly (readOnlyIntent) ativo");
  check(opcoes.requestTimeout === 7_000, "timeout por pedido aplicado");
  check(opcoes.encrypt === false && opcoes.trustServerCertificate === true, "opções de segurança da instalação preservadas");
  const cli = readFileSync("agent/src/cli.ts", "utf8");
  check(/"classification-audit":\s*\{\s*run:\s*classificationAudit/.test(cli), "comando registado no cli.ts");
  const fonteCmd = readFileSync("agent/src/commands/classification-audit.ts", "utf8");
  check(!/console\.(log|error|warn)\([^)]*(sqlPassword|sqlUser|sqlHost|connectionString)/.test(fonteCmd), "o comando nunca imprime credenciais/host/connection string");
  const build = readFileSync("agent/build.mjs", "utf8");
  check(/"run-classification-audit\.bat": "classification-audit"/.test(build) && build.includes("comArgumentos.has(filename)"), "run-classification-audit.bat reencaminha %*");
  check(/AGENT_PACKAGE_REV \?\? "99"/.test(build), 'AGENT_REV de desenvolvimento = "99" (> 98)');

  console.log(`\n${pass} ok, ${fail} falhas`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
