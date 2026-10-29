/**
 * agent/src/classificacao-v2.test.ts
 *
 * Extensão READ-ONLY do diagnóstico (pacote v2), SEM SQL Server real: o ERP falso (classificacao-erp-falso.ts) responde às
 * queries que a auditoria gera. Cobre: limites novos (56 colunas de Stocks, 91 pares, tabelas sem truncar a 150),
 * dbo.Parametros presentes/ausentes, histórico com transições, Generico bit anulável/não anulável, lookup Etico_NETT
 * (normal/ausente/órfão/duplicado/descrição desconhecida/código diferente), normalização de descrições, universos com e
 * sem ficheiro MT (incl. 25 000+ CNPs em blocos), parse do ficheiro MT, matriz MT×ERP, IN-lists validadas, read-only,
 * ausência de segredos/PII, relatório sem identificar o tenant.
 *
 * Uso: npx tsx agent/src/classificacao-v2.test.ts
 */
import { createHash } from "node:crypto";
import {
  criarLeitorSeguro,
  executarAuditoria,
  pacoteOmissao,
  renderMarkdown,
  OPCOES_OMISSAO,
  type RelatorioAuditoria,
} from "./classificacao-auditoria.js";
import {
  CATEGORIAS,
  calcularImpressao,
  categoriaPorDescricao,
  classificarCodigo,
  construirMapeamento,
  normalizarDescricao,
  REFERENCIA_SILVEIRENSE,
} from "./classificacao-mapeamento.js";
import { dividirEmBlocos, parseFicheiroMt, TAMANHO_BLOCO_MT } from "./classificacao-mt.js";
import { escolherColunaData, selecionarColunasParametros, sqlTransicoes } from "./classificacao-secoes.js";
import { compararGenerico, listaIn, sqlDimensoes, type ColunasUniverso, type DimRowMt } from "./classificacao-universos.js";
import { lerColunasTabela } from "./classificacao-base.js";
import { PALAVRAS_PROIBIDAS, mascararQuery, validarInLists, validarQueryAuditoria, validarSomenteSelect } from "./sql-somente-leitura.js";
import { erpFalso, type Cenario, type ColDef, type RowStocks } from "./classificacao-erp-falso.js";

let pass = 0;
let fail = 0;
const check = (c: boolean, l: string, d?: string) => {
  if (c) { pass++; console.log(`  [OK]    ${l}`); }
  else { fail++; console.log(`  [FALHA] ${l}${d ? `\n            ${d}` : ""}`); }
};

const SEGREDOS = { senha: "S3cr3t-Pass!", utilizador: "sa_farmacia", host: "10.20.30.40", tenant: "tenant-sentinela-xyz", ficheiro: "cnps-tenant-sentinela-xyz.txt" };
const SEGREDOS_LISTA = [SEGREDOS.senha, SEGREDOS.utilizador, SEGREDOS.host, SEGREDOS.tenant];
const AGORA = new Date("2026-10-29T12:34:56.000Z");

async function correr(c: Cenario, extra: Parameters<typeof executarAuditoria>[1] = {}) {
  const erp = erpFalso(c);
  const registo: string[] = [];
  const rel = await executarAuditoria(criarLeitorSeguro(erp.ler, registo), {
    agora: () => AGORA,
    segredos: SEGREDOS_LISTA,
    pacote: pacoteOmissao("abc1234"),
    queriesExecutadasTexto: () => registo.map(mascararQuery),
    ...extra,
  });
  return { rel, erp, registo, md: renderMarkdown(rel), json: JSON.stringify(rel) };
}

// ─────────────────────────────────────────────────────────────────────
// Cenário base «Silveirense-like»: 56 colunas em Stocks, lookup Etico_NETT de 5 linhas, Parametros, histórico
// ─────────────────────────────────────────────────────────────────────
const COLS_NOMEADAS: ColDef[] = [
  ["CodigoID", "int", 4], ["Codigo", "int", 4], ["Nome Generico", "varchar", 100], ["Generico", "bit", 1], ["Etico_NETT", "int", 4],
  ["Processa_Stocks", "int", 4], ["Retirado", "bit", 1], ["PVP", "money", 8], ["Tipo Familia", "int", 4], ["Tipo FamiliaP", "int", 4],
];
function colsStocks56(): ColDef[] {
  const extra: ColDef[] = [];
  for (let i = COLS_NOMEADAS.length; i < 56; i++) extra.push([`Campo${String(i).padStart(2, "0")}`, "varchar", 20]);
  return [...COLS_NOMEADAS, ...extra];
}
const LOOKUP: RowStocks[] = [
  { Codigo: 1, Descricao: "Éticos" }, { Codigo: 2, Descricao: "NETT" }, { Codigo: 3, Descricao: "Serviços" },
  { Codigo: 4, Descricao: "Sacos L." }, { Codigo: 5, Descricao: "Outros" },
];

type Grupo = { cod: number | null; n: number; ps: (i: number) => number; gen: (i: number) => number | null; ret?: (i: number) => number };
function dadosBase(grupos: Grupo[] = GRUPOS_BASE): RowStocks[] {
  const rows: RowStocks[] = [];
  let id = 0;
  for (const g of grupos) {
    for (let i = 0; i < g.n; i++) {
      id++;
      rows.push({
        CodigoID: id, Codigo: 5_000_000 + id, "Nome Generico": `NOME-PRODUTO-${id}`, Generico: g.gen(i), Etico_NETT: g.cod,
        Processa_Stocks: g.ps(i), Retirado: g.ret ? g.ret(i) : 0, PVP: 9.99,
      });
    }
  }
  return rows;
}
const GRUPOS_BASE: Grupo[] = [
  { cod: 1, n: 100, ps: () => -1, gen: (i) => (i < 20 ? 1 : 0), ret: (i) => (i < 10 ? 1 : 0) },
  { cod: 2, n: 150, ps: () => -1, gen: (i) => (i < 40 ? 1 : 0) },
  { cod: 3, n: 10, ps: (i) => (i < 7 ? 0 : -1), gen: () => 0 },
  { cod: 4, n: 5, ps: () => -1, gen: () => 0 },
  { cod: 5, n: 4, ps: (i) => (i === 0 ? 0 : -1), gen: () => 0 },
  { cod: 9, n: 2, ps: () => -1, gen: () => 0 },
  { cod: null, n: 3, ps: () => -1, gen: () => 0 },
];

const HISTORICO_ROWS: RowStocks[] = [
  // artigo 1: Etico_NETT 1 → 2 → 2 ; Generico 0 → 1
  { CodigoID: 1, DataHisto: "2025-01-01 00:00:00", Etico_NETT: 1, Generico: 0 },
  { CodigoID: 1, DataHisto: "2025-06-01 00:00:00", Etico_NETT: 2, Generico: 1 },
  { CodigoID: 1, DataHisto: "2026-01-01 00:00:00", Etico_NETT: 2, Generico: 1 },
  // artigo 2: estável
  { CodigoID: 2, DataHisto: "2025-02-01 00:00:00", Etico_NETT: 1, Generico: 0 },
  { CodigoID: 2, DataHisto: "2026-02-01 00:00:00", Etico_NETT: 1, Generico: 0 },
  // artigo 3: NULL → 3 ; Generico NULL → 0
  { CodigoID: 3, DataHisto: "2025-03-01 00:00:00", Etico_NETT: null, Generico: null },
  { CodigoID: 3, DataHisto: "2026-03-01 00:00:00", Etico_NETT: 3, Generico: 0 },
  // artigo 4: 5 → 4 → 5 (volta)
  { CodigoID: 4, DataHisto: "2025-04-01 00:00:00", Etico_NETT: 5, Generico: 0 },
  { CodigoID: 4, DataHisto: "2025-08-01 00:00:00", Etico_NETT: 4, Generico: 0 },
  { CodigoID: 4, DataHisto: "2026-04-01 00:00:00", Etico_NETT: 5, Generico: 0 },
];

const TABELAS_BASE = () => [
  { tabela: "Etico_NETT", cols: [["Codigo", "int", 4], ["Descricao", "varchar", 30]] as ColDef[], linhas: 5 },
  {
    tabela: "Parametros",
    cols: [
      ["ID", "int", 4], ["TipoArtigoEtico", "int", 4], ["TipoArtigoNETT", "int", 4], ["ActEtico", "bit", 1], ["ActNETT", "bit", 1],
      ["ActServ", "bit", 1], ["Encomendas_Separar_EtNett", "bit", 1], ["ActSmtpPassword", "varchar", 50], ["Nome Farmacia", "varchar", 80],
      ["ActMensagem", "varchar", 60], ["ActXml", "xml", -1],
    ] as ColDef[],
    linhas: 1,
  },
  {
    tabela: "Parametros_Histo",
    cols: [["ID", "int", 4], ["TipoArtigoEtico", "int", 4], ["ActEtico", "bit", 1], ["ActServ", "bit", 1]] as ColDef[],
    linhas: 4,
  },
];
const CONTEUDO_BASE = (): Record<string, RowStocks[]> => ({
  Etico_NETT: LOOKUP,
  Parametros: [{
    ID: 1, TipoArtigoEtico: 1, TipoArtigoNETT: 2, ActEtico: 1, ActNETT: 1, ActServ: 0, Encomendas_Separar_EtNett: 1,
    ActSmtpPassword: SEGREDOS.senha, "Nome Farmacia": "FARMACIA-SENTINELA", ActMensagem: "ola joao.silva@example.com", ActXml: "<x/>",
  }],
  Parametros_Histo: [
    { ID: 1, TipoArtigoEtico: 1, ActEtico: 1, ActServ: 0 }, { ID: 2, TipoArtigoEtico: 1, ActEtico: 1, ActServ: 0 },
    { ID: 3, TipoArtigoEtico: 2, ActEtico: 0, ActServ: 0 }, { ID: 4, TipoArtigoEtico: 1, ActEtico: 1, ActServ: null },
  ],
});
const cenarioBase = (): Cenario => ({
  stocksCols: colsStocks56(),
  dados: dadosBase(),
  tabelas: TABELAS_BASE(),
  conteudo: CONTEUDO_BASE(),
  fks: [{ coluna: "Etico_NETT", tabelaRef: "Etico_NETT", colunaRef: "Codigo" }],
  historico: {
    Stocks_Histo: { cols: [["CodigoID", "int", 4], ["DataHisto", "datetime", 8], ["Etico_NETT", "int", 4], ["Generico", "bit", 1]], rows: HISTORICO_ROWS },
  },
  anulavel: { Stocks: { Generico: true, Etico_NETT: true }, Stocks_Histo: { Generico: true, Etico_NETT: true } },
  padrao: { Stocks: { Generico: "((0))" } },
  baseDados: "SPharmSilveirense",
});

const sha = (t: string) => (createHash("sha256").update(t, "utf8").digest("hex").match(/.{1,8}/g) ?? []).join("-");

async function main() {
  const B = await correr(cenarioBase());
  const { rel, erp, md, json } = B;
  const DADOS = dadosBase();
  if (process.env.DUMP_MD) {
    // uso manual: DUMP_MD=<ficheiro> grava o Markdown de exemplo (sem e com ficheiro MT) para inspeção
    const comMt = await correr(cenarioBase(), { cnpsMt: parseFicheiroMt("5000001;1;0\n5000002;0;1\n5000150;0;0\n9999999;0;0") });
    (await import("node:fs")).writeFileSync(process.env.DUMP_MD, `${md}\n\n=====MT=====\n${comMt.md}`, "utf8");
  }

  // ═══ 1. Limites: colunas de Stocks, pares, tabelas ═════════════════
  console.log("\n=== 1. Limites e colunas de dbo.Stocks ===");
  check(rel.stocksColunas.total === 56 && rel.stocksColunas.colunas.length === 56, "todas as 56 colunas de dbo.Stocks listadas", String(rel.stocksColunas.total));
  const gen = rel.stocksColunas.colunas.find((c) => c.coluna === "Generico")!;
  check(gen.tipo === "bit" && gen.anulavel === true && gen.padrao === "((0))", "Generico: tipo bit, anulável, default ((0)) (sys.columns + sys.default_constraints)", JSON.stringify(gen));
  check(rel.stocksColunas.colunas.some((c) => c.coluna === "Nome Generico") && rel.stocksColunas.colunas.some((c) => c.coluna === "PVP"), "«Nome Generico» e «PVP» (nomes que o sanitizador v1 omitia) listados como ESTRUTURA em dbo.Stocks");
  check(md.includes("## B. Todas as colunas de dbo.Stocks") && md.includes("| 56 |") === false || md.includes("56 coluna(s)"), "secção B no Markdown com 56 coluna(s)");
  check(!erp.executadas.some((s) => /Nome Generico|PVP/.test(s) && /AS valor|COUNT\(DISTINCT|CAST\(x\./.test(s)), "dados de «Nome Generico» e «PVP» NUNCA são lidos (só a estrutura)");
  check(!json.includes("NOME-PRODUTO-") && !json.includes("9.99"), "nenhum nome de produto nem preço no relatório");
  const stocksCand = rel.tabelasCandidatas.find((t) => t.tabela === "dbo.Stocks")!;
  check(stocksCand.colunas.length === 56 && stocksCand.colunasOmitidas === 0, "tabelas candidatas: dbo.Stocks com as 56 colunas (v1 listava 40)");
  check(OPCOES_OMISSAO.maxPares >= 91 && OPCOES_OMISSAO.maxColunas >= 80 && OPCOES_OMISSAO.maxTabelas >= 1000, "defaults novos: maxPares ≥ 91, maxColunas ≥ 80, maxTabelas alto");

  // 91 pares = C(14,2): 12 colunas «Tipo X» + Processa_Stocks + Retirado
  const cols14: ColDef[] = [["CodigoID", "int", 4], ["Codigo", "int", 4], ["Processa_Stocks", "int", 4], ["Retirado", "bit", 1]];
  for (let i = 0; i < 12; i++) cols14.push([`Tipo ${String.fromCharCode(65 + i)}`, "bit", 1]);
  const dados14: RowStocks[] = Array.from({ length: 60 }, (_, i) => {
    const r: RowStocks = { CodigoID: i + 1, Codigo: 7_000_000 + i, Processa_Stocks: i % 5 === 0 ? 0 : -1, Retirado: i % 7 === 0 ? 1 : 0 };
    for (let k = 0; k < 12; k++) r[`Tipo ${String.fromCharCode(65 + k)}`] = (i + k) % 2;
    return r;
  });
  const P14 = await correr({ stocksCols: cols14, dados: dados14 });
  check(P14.rel.cruzadas.length === 91, `91 cruzamentos (todos os pares das 14 colunas): ${P14.rel.cruzadas.length}`);
  check(!P14.rel.avisos.some((a) => /pares de colunas limitados/.test(a)), "sem aviso de pares limitados com o default");
  const P14b = await correr({ stocksCols: cols14, dados: dados14 }, { maxPares: 40 });
  check(P14b.rel.cruzadas.length === 40 && P14b.rel.avisos.some((a) => /pares de colunas limitados a 40 \(de 91\)/.test(a)), "--max-pares continua a ser opção: 40 de 91 com aviso");

  // tabelas candidatas sem truncar a 150
  const muitas = Array.from({ length: 220 }, (_, i) => ({ tabela: `TipoX${i}`, cols: [["Id", "int", 4]] as ColDef[], linhas: 3000 }));
  const T220 = await correr({ ...cenarioBase(), tabelas: [...TABELAS_BASE(), ...muitas] });
  check(T220.rel.tabelasCandidatas.length >= 220 && !T220.rel.avisos.some((a) => /truncada a 150/.test(a)), `tabelas candidatas sem truncar a 150: ${T220.rel.tabelasCandidatas.length}`);
  const T50 = await correr({ ...cenarioBase(), tabelas: [...TABELAS_BASE(), ...muitas] }, { maxTabelas: 50 });
  check(T50.rel.tabelasCandidatas.length === 50 && T50.rel.avisos.some((a) => /limitada a 50 \(de \d+\)/.test(a)), "--max-tabelas: limite configurável com aviso quando atingido");

  // ═══ 2. dbo.Parametros ═══════════════════════════════════════════
  console.log("\n=== 2. Parametros e Parametros_Histo ===");
  const par = rel.parametros;
  check(par.existe && par.colunasLidas.includes("TipoArtigoEtico") && par.colunasLidas.includes("ActServ") && par.colunasLidas.includes("Encomendas_Separar_EtNett"), "colunas de configuração lidas (TipoArtigo*, Act*, Encomendas_Separar_EtNett)", par.colunasLidas.join(","));
  check(par.esperadasEmFalta.includes("TipoArtigoServ"), "TipoArtigoServ (pedida, inexistente nesta base) listada como em falta", par.esperadasEmFalta.join(","));
  check(par.valores.length === 1 && par.valores[0]!.TipoArtigoEtico === "1" && par.valores[0]!.ActServ === "0" && par.valores[0]!.Encomendas_Separar_EtNett === "1", "valores de configuração lidos (config não sensível)", JSON.stringify(par.valores));
  check(!par.colunasLidas.some((c) => /Smtp|Nome|Xml/i.test(c)), "colunas com ar de segredo/pessoais/xml nunca lidas");
  check(!json.includes(SEGREDOS.senha) && !json.includes("FARMACIA-SENTINELA") && !erp.executadas.some((s) => /ActSmtpPassword|Nome Farmacia/.test(s) && /CAST\(x\./.test(s)), "segredo e nome da farmácia de Parametros ausentes do relatório e das queries");
  check(!json.includes("joao.silva@example.com"), "e-mail em ActMensagem nunca lido");
  check(par.ignoradas.some((i) => i.coluna === "ActSmtpPassword" && /dados não são lidos/.test(i.motivo)) && par.ignoradas.some((i) => /xml/.test(i.motivo)), "colunas relevantes ignoradas explicadas (o NOME aparece como estrutura; os DADOS de segredo/xml nunca são lidos)", JSON.stringify(par.ignoradas));
  const hist = par.historico;
  const hEtico = hist.porColuna.find((c) => c.coluna === "TipoArtigoEtico")!;
  check(hist.existe && !!hEtico && hEtico.distintos === 2 && hEtico.valores.find((v) => v.valor === "1")?.n === 3 && hEtico.valores.find((v) => v.valor === "2")?.n === 1, "Parametros_Histo: valores distintos por coluna com contagem (TipoArtigoEtico: 1×3, 2×1)", JSON.stringify(hEtico));
  const hServ = hist.porColuna.find((c) => c.coluna === "ActServ")!;
  check(!!hServ && hServ.valores.some((v) => v.valor === null && v.n === 1), "Parametros_Histo: NULL contado", JSON.stringify(hServ));
  check(par.observacoes.some((o) => /não conclui o que estas colunas significam/.test(o)), "observações neutras (sem conclusões sobre Etico_NETT)");
  check(md.includes("## C. dbo.Parametros"), "secção C no Markdown");

  const semPar = await correr({ ...cenarioBase(), tabelas: [TABELAS_BASE()[0]!], conteudo: { Etico_NETT: LOOKUP } });
  check(!semPar.rel.parametros.existe && semPar.rel.parametros.esperadasEmFalta.length === 7 && semPar.rel.parametros.observacoes[0]!.includes("não existe"), "Parametros ausente: não falha, lista as 7 colunas pedidas como em falta");
  check(!semPar.rel.parametros.historico.existe, "Parametros_Histo ausente: reportado");
  const selecao = selecionarColunasParametros(lerColunasTabela([
    { ordem: 1, coluna: "ActEtico", tipo: "bit", tamanho: 1, precisao: 1, escala: 0, anulavel: 1, padrao: null },
    { ordem: 2, coluna: "ActUserLogin", tipo: "varchar", tamanho: 20, precisao: 0, escala: 0, anulavel: 1, padrao: null },
    { ordem: 3, coluna: "TipoArtigoOutro", tipo: "int", tamanho: 4, precisao: 10, escala: 0, anulavel: 1, padrao: null },
    { ordem: 4, coluna: "Preco", tipo: "money", tamanho: 8, precisao: 19, escala: 4, anulavel: 1, padrao: null },
  ]));
  check(selecao.ler.map((c) => c.coluna).join(",") === "ActEtico,TipoArtigoOutro", "outras Act*/TipoArtigo* incluídas; Act* com «user»/«login» excluída; colunas não relevantes ignoradas", selecao.ler.map((c) => c.coluna).join(","));

  // leitura assistida: parâmetros todos NULL não provam «campos independentes»
  const nulos = await correr({
    ...cenarioBase(),
    conteudo: { ...CONTEUDO_BASE(), Parametros: [{ ID: 1, TipoArtigoEtico: null, TipoArtigoNETT: null, ActEtico: null, ActNETT: null, ActServ: null, Encomendas_Separar_EtNett: null }] },
  });
  const ind = nulos.rel.leituraAssistida.conceitos.find((c) => c.conceito === "etico")!.hipoteses.find((h) => h.hipotese === "campos-independentes")!;
  check(ind.estado !== "suportada", "falso positivo corrigido: colunas todas NULL não suportam «campos independentes»", `${ind.estado}: ${ind.evidencia.join(" ")}`);

  // ═══ 3. Histórico ═══════════════════════════════════════════════
  console.log("\n=== 3. Histórico (Stocks_Histo / Stocks_HistoF) ===");
  const hs = rel.historico.find((h) => h.tabela === "dbo.Stocks_Histo")!;
  const he = hs.campos.find((c) => c.campo === "Etico_NETT")!;
  const hg = hs.campos.find((c) => c.campo === "Generico")!;
  check(hs.existe && hs.linhas === 10 && hs.artigos === 4 && hs.colunaId === "CodigoID" && hs.colunaData === "DataHisto", "histórico: 10 linhas, 4 artigos, colunas CodigoID/DataHisto descobertas por sys.columns", JSON.stringify({ l: hs.linhas, a: hs.artigos }));
  check(hs.dataMin === "2025-01-01 00:00:00" && hs.dataMax === "2026-04-01 00:00:00", "datas mínima/máxima do histórico", `${hs.dataMin} → ${hs.dataMax}`);
  check(he.artigosTotal === 4 && he.artigosComMaisDeUmValor === 3, "Etico_NETT: 3 de 4 artigos com mais de um valor distinto (NULL conta como valor)", JSON.stringify(he));
  check(hg.artigosComMaisDeUmValor === 2, "Generico: 2 de 4 artigos com mais de um valor distinto", JSON.stringify(hg));
  const tr = (campo: typeof he, de: string | null, para: string | null) => campo.transicoes!.find((t) => t.de === de && t.para === para)?.n ?? 0;
  check(tr(he, "1", "2") === 1 && tr(he, "2", "2") === 1 && tr(he, "1", "1") === 1 && tr(he, null, "3") === 1 && tr(he, "5", "4") === 1 && tr(he, "4", "5") === 1, "matriz de transições Etico_NETT (de→para) com contagens (LAG)", JSON.stringify(he.transicoes));
  check(he.transicoes!.reduce((s, t) => s + t.n, 0) === 6 && he.mudancas === 4, "6 transições consecutivas (10 linhas − 4 artigos), 4 são mudanças de valor", `${he.mudancas}`);
  check(tr(hg, "0", "1") === 1 && tr(hg, null, "0") === 1 && tr(hg, "1", "1") === 1, "matriz de transições Generico", JSON.stringify(hg.transicoes));
  check(he.linhasPorValor.find((v) => v.valor === "5")?.n === 2 && he.linhasPorValor.find((v) => v.valor === null)?.n === 1, "linhas por valor (Etico_NETT 5×2, NULL×1)");
  const hf = rel.historico.find((h) => h.tabela === "dbo.Stocks_HistoF")!;
  check(!!hf && !hf.existe, "Stocks_HistoF inexistente: reportado, sem erro");
  check(!rel.avisos.some((a) => /recusado/.test(a)), "nenhuma query de histórico recusada pela guarda read-only");
  const qTr = erp.executadas.find((s) => s.includes("LAG("))!;
  check(!!qTr && validarQueryAuditoria(qTr).length === 0 && !/\b(INSERT|UPDATE|DELETE|INTO)\b/i.test(qTr), "a query com LAG é SELECT validado");
  check(!json.includes("NOME-PRODUTO"), "histórico sem nomes nem preços");

  const grande = await correr(cenarioBase(), { maxLinhasHistorico: 5 });
  check(grande.rel.historico.find((h) => h.tabela === "dbo.Stocks_Histo")!.nota?.includes("não executadas") === true && grande.rel.avisos.some((a) => /Stocks_Histo.*não executadas/.test(a)), "tabela de histórico acima do limite: consultas pesadas não executadas, com aviso");
  const semData = await correr({ ...cenarioBase(), historico: { Stocks_Histo: { cols: [["CodigoID", "int", 4], ["Etico_NETT", "int", 4], ["Generico", "bit", 1]], rows: HISTORICO_ROWS } } });
  const hsd = semData.rel.historico.find((h) => h.tabela === "dbo.Stocks_Histo")!;
  check(hsd.colunaData === null && hsd.campos[0]!.transicoes === null && hsd.campos[0]!.artigosComMaisDeUmValor === 3, "sem coluna de data: estabilidade calculada, transições não");
  check(escolherColunaData(lerColunasTabela([
    { ordem: 1, coluna: "Alterado", tipo: "datetime", tamanho: 8, precisao: 23, escala: 3, anulavel: 1, padrao: null },
    { ordem: 2, coluna: "DataHisto", tipo: "datetime", tamanho: 8, precisao: 23, escala: 3, anulavel: 1, padrao: null },
  ])) === "DataHisto", "escolha da coluna de data: prefere «histo/data»");
  const sqlT = sqlTransicoes({ esquema: "dbo", tabela: "Stocks_Histo" }, "CodigoID", "DataHisto", "Etico_NETT");
  check(validarQueryAuditoria(sqlT).length === 0 && sqlT.includes("LAG("), "sqlTransicoes passa a guarda (derivada + janela, sem escrita)", validarQueryAuditoria(sqlT).join("; "));

  // ═══ 4. Generico: metadados SQL (bit anulável / não anulável) ══════
  console.log("\n=== 4. Generico: metadados SQL ===");
  const mGen = (r: RelatorioAuditoria, tabela: string) => r.camposMeta.find((m) => m.tabela === tabela && m.campo === "Generico")!;
  check(mGen(rel, "dbo.Stocks").tipo === "bit" && mGen(rel, "dbo.Stocks").anulavel === true && mGen(rel, "dbo.Stocks").nulos === 0 && mGen(rel, "dbo.Stocks").total === DADOS.length, "Stocks.Generico: bit anulável, 0 NULL em 274 linhas (contagem em SQL)", JSON.stringify(mGen(rel, "dbo.Stocks")));
  check(mGen(rel, "dbo.Stocks_Histo").nulos === 1 && mGen(rel, "dbo.Stocks_Histo").total === 10, "Stocks_Histo.Generico: anulável, 1 NULL em 10 linhas", JSON.stringify(mGen(rel, "dbo.Stocks_Histo")));
  check(mGen(rel, "dbo.Stocks_HistoF").tabelaExiste === false, "Stocks_HistoF: tabela inexistente reportada");
  const naoNul = await correr({ ...cenarioBase(), anulavel: { Stocks: { Generico: false } } });
  const mNN = mGen(naoNul.rel, "dbo.Stocks");
  check(mNN.anulavel === false && mNN.nulos === 0 && /NOT NULL/.test(mNN.nota), "Generico NOT NULL: sem contagem de NULL em SQL (não pode haver), nota explícita");
  check(!naoNul.erp.executadas.some((s) => /AS nulos/.test(s) && /\[Generico\]/.test(s) && /FROM \[dbo\]\.\[Stocks\] x/.test(s)), "e a query de NULL não foi executada para a coluna NOT NULL");
  const nulosReais = await correr({ ...cenarioBase(), dados: dadosBase().map((r, i) => (i < 4 ? { ...r, Generico: null } : r)) });
  check(mGen(nulosReais.rel, "dbo.Stocks").nulos === 4, "Generico com 4 NULL reais: contados");

  // ═══ 5. Normalização e mapeamento por descrição ═══════════════════
  console.log("\n=== 5. Normalização e mapeamento por descrição ===");
  check(normalizarDescricao("Éticos") === "eticos" && normalizarDescricao("Sacos L.") === "sacos l" && normalizarDescricao("Serviços") === "servicos", "«Éticos»→«eticos», «Sacos L.»→«sacos l», «Serviços»→«servicos»");
  check(normalizarDescricao("  N.E.T.T.  ") === "nett" && normalizarDescricao("Outros,   (diversos)!") === "outros diversos" && normalizarDescricao("ÀÇÃO\tÉ  Ü") === "acao e u", "pontuação removida, espaços colapsados, acentos NFD removidos");
  check(normalizarDescricao(null) === "" && normalizarDescricao("") === "" && normalizarDescricao("---") === "", "null/vazio/só pontuação → «»");
  check(categoriaPorDescricao("eticos") === "ETICO" && categoriaPorDescricao("etico") === "ETICO" && categoriaPorDescricao("nett") === "NETT" && categoriaPorDescricao("servicos") === "SERVICO" && categoriaPorDescricao("sacos l") === "SACOS" && categoriaPorDescricao("outros") === "OUTROS", "regra de prefixo: etic→ETICO, nett→NETT, servic→SERVICO, sacos→SACOS, outros→OUTROS");
  check(categoriaPorDescricao("generico") === "UNKNOWN" && categoriaPorDescricao("") === "UNKNOWN" && categoriaPorDescricao("xserviços") === "UNKNOWN", "descrição desconhecida → UNKNOWN");
  check(Object.keys(REFERENCIA_SILVEIRENSE).join(",") === "1,2,3,4,5" && CATEGORIAS.length === 6, "referência Silveirense 1..5 e 6 categorias");

  const mp = rel.mapeamentoEticoNett;
  check(mp.lookupEncontrado && mp.origemLookup === "fk" && mp.tabela === "dbo.Etico_NETT" && mp.colunaCodigo === "Codigo" && mp.colunaDescricao === "Descricao", "lookup descoberto pela FK de Stocks.Etico_NETT", JSON.stringify({ o: mp.origemLookup, t: mp.tabela }));
  const linha = (cod: string) => mp.linhas.find((l) => l.codigo === cod)!;
  check(linha("1").descricaoCrua === "Éticos" && linha("1").descricaoNormalizada === "eticos" && linha("1").categoriaProposta === "ETICO" && linha("1").artigos === 100, "código 1: crua «Éticos», normalizada «eticos», ETICO, 100 artigos");
  check(linha("2").categoriaProposta === "NETT" && linha("2").artigos === 150 && linha("3").categoriaProposta === "SERVICO" && linha("3").artigos === 10 && linha("4").descricaoNormalizada === "sacos l" && linha("4").categoriaProposta === "SACOS" && linha("5").categoriaProposta === "OUTROS", "restantes linhas do lookup com categoria proposta e nº de artigos");
  check(mp.alertas.some((a) => /órfãos.*9×2/.test(a)) && mp.orfaos[0]!.codigo === "9" && mp.orfaos[0]!.artigos === 2, "alerta: código 9 em Stocks sem linha no lookup (órfão, 2 artigos)", mp.alertas.join(" | "));
  check(mp.nulos === 3 && mp.alertas.some((a) => /3 artigo\(s\) com Stocks\.Etico_NETT NULL/.test(a)), "alerta: 3 artigos com Etico_NETT NULL");
  check(!mp.alertas.some((a) => /Silveirense/.test(a)), "lookup igual ao da Silveirense: sem alertas de diferença");
  check(md.includes("## F. Mapeamento de Stocks.Etico_NETT pela DESCRIÇÃO") && md.includes("PROPOSTA a validar") && md.includes("| `1` | `Éticos` | `eticos` | ETICO | 100 |"), "Markdown: tabela código/crua/normalizada/categoria/artigos, apresentada como PROPOSTA");

  // lookup alterado: duplicado, descrição desconhecida, código diferente, duas linhas → mesma categoria
  const alt = construirMapeamento(
    [
      { codigo: "1", descricao: "Éticos" }, { codigo: "1", descricao: "Éticos" }, { codigo: "2", descricao: "Genéricos" },
      { codigo: "3", descricao: "Serviços" }, { codigo: "6", descricao: "Serviço Farmacêutico" }, { codigo: "7", descricao: "NETT" },
    ],
    [{ codigo: "1", n: 5 }, { codigo: "2", n: 4 }, { codigo: "6", n: 2 }, { codigo: "8", n: 1 }, { codigo: null, n: 2 }],
    { origem: "nome", tabela: "dbo.Etico_NETT", colunaCodigo: "Codigo", colunaDescricao: "Descricao" },
  );
  const al = alt.alertas.join(" | ");
  check(/código 1 duplicado no lookup/.test(al), "alerta: código duplicado no lookup");
  check(/descrição «genericos» não mapeia/.test(al), "alerta: descrição que não mapeia (UNKNOWN)");
  check(/2 linhas do lookup mapeiam para SERVICO \(códigos 3, 6\)/.test(al), "alerta: duas linhas mapeiam para a mesma categoria", al);
  check(/código 2 tem descrição «genericos»; na Silveirense era «nett»/.test(al) && /código 6 não existe no lookup da Silveirense/.test(al) && /código 4 da Silveirense .* não existe neste lookup/.test(al), "alertas: código diferente do observado na Silveirense (1..5)");
  check(/órfãos.*8×1/.test(al) && /2 artigo\(s\) com Stocks\.Etico_NETT NULL/.test(al), "alertas: órfão e NULL");
  check(classificarCodigo("2", alt).estado === "desconhecida" && classificarCodigo("8", alt).estado === "orfao" && classificarCodigo(null, alt).categoria === "SEM_CLASSIFICACAO" && classificarCodigo("6", alt).categoria === "SERVICO", "classificarCodigo: por DESCRIÇÃO (o código 2 deste lookup não é NETT), órfão, NULL");
  const ausente = construirMapeamento(null, [{ codigo: "1", n: 3 }, { codigo: null, n: 1 }]);
  check(!ausente.lookupEncontrado && /lookup dbo\.Etico_NETT ausente/.test(ausente.alertas[0]!) && classificarCodigo("1", ausente).estado === "sem-lookup" && classificarCodigo("1", ausente).categoria === "UNKNOWN", "lookup ausente: alerta, nada mapeado (nunca só pelo código)");

  const SL = await correr({ ...cenarioBase(), fks: [], semTabela: ["Etico_NETT"], tabelas: TABELAS_BASE().filter((t) => t.tabela !== "Etico_NETT") });
  check(!SL.rel.mapeamentoEticoNett.lookupEncontrado && SL.rel.mapeamentoEticoNett.alertas[0]!.includes("ausente") && SL.md.includes("Lookup dbo.Etico_NETT ausente"), "ERP sem tabela Etico_NETT: relatório completo na mesma, com «lookup ausente»");
  check(SL.rel.universos.erpTotal.distribuicao!.porEstado["sem-lookup"] === DADOS.length - 3 && SL.rel.universos.erpTotal.distribuicao!.porCategoria.SEM_CLASSIFICACAO === 3, "…e os universos sem lookup: tudo UNKNOWN/sem-lookup, NULL como SEM_CLASSIFICACAO");
  const PN = await correr({ ...cenarioBase(), fks: [] });
  check(PN.rel.mapeamentoEticoNett.lookupEncontrado && PN.rel.mapeamentoEticoNett.origemLookup === "nome", "sem FK declarada: lookup descoberto pelo NOME da tabela");

  // ═══ 6. Universos sem ficheiro MT ═══════════════════════════════
  console.log("\n=== 6. Universos (sem ficheiro MT) ===");
  const u = rel.universos;
  const tot = u.erpTotal.distribuicao!;
  check(tot.total === 274 && tot.porCategoria.ETICO === 100 && tot.porCategoria.NETT === 150 && tot.porCategoria.SERVICO === 10 && tot.porCategoria.SACOS === 5 && tot.porCategoria.OUTROS === 4 && tot.porCategoria.UNKNOWN === 2 && tot.porCategoria.SEM_CLASSIFICACAO === 3, "(i) TOTAL: 274 artigos por categoria (ETICO 100, NETT 150, SERVICO 10, SACOS 5, OUTROS 4, UNKNOWN 2 órfãos, SEM_CLASSIFICACAO 3)", JSON.stringify(tot.porCategoria));
  check(tot.porGenerico.um === 60 && tot.porGenerico.zero === 214 && tot.porGenerico.nulo === 0 && tot.categoriaXGenerico.ETICO.um === 20 && tot.categoriaXGenerico.NETT.um === 40, "(i) por Generico: 1=60, 0=214, NULL=0; Éticos 20 genéricos, NETT 40", JSON.stringify(tot.porGenerico));
  const sinc = u.sincronizavel;
  const nDaily = DADOS.filter((r) => r.Processa_Stocks !== 0).length;
  const nBoot = DADOS.filter((r) => r.Processa_Stocks !== 0 && r.Retirado === 0).length;
  check(sinc.disponivel && sinc.daily!.total === nDaily && sinc.bootstrapAtivo!.total === nBoot, `(ii) SINCRONIZÁVEL: daily (Processa_Stocks <> 0) = ${nDaily}; bootstrap ativo (Retirado = 0 AND Processa_Stocks <> 0) = ${nBoot}`, `${sinc.daily?.total}/${sinc.bootstrapAtivo?.total}`);
  check(sinc.predicados.daily === "Processa_Stocks <> 0" && sinc.predicados.bootstrapAtivo === "Retirado = 0 AND Processa_Stocks <> 0", "(ii) predicados exatos do agent reproduzidos");
  check(sinc.servicos!.totalErp === 10 && sinc.servicos!.incluidosDaily === 3 && sinc.servicos!.excluidosDaily === 7 && sinc.servicos!.incluidosBootstrap === 3, "(ii) Serviços: 10 no ERP, 3 incluídos, 7 excluídos (Processa_Stocks = 0)", JSON.stringify(sinc.servicos));
  check(sinc.daily!.porCategoria.ETICO === 100 && sinc.bootstrapAtivo!.porCategoria.ETICO === 90 && sinc.daily!.porCategoria.OUTROS === 3, "(ii) distribuição por categoria dentro do sincronizável (Retirado exclui 10 Éticos do bootstrap)");
  check(!u.existenteNoMt.calculado && u.existenteNoMt.motivo === "não calculado: forneça --cnps-mt-ficheiro" && !u.coberturaMt.calculado && u.coberturaMt.motivo === "não calculado: forneça --cnps-mt-ficheiro", "(iii)/(iv) sem ficheiro: «não calculado: forneça --cnps-mt-ficheiro», sem falhar");
  check(md.includes("não calculado: forneça --cnps-mt-ficheiro") && md.includes("### G.i ") && md.includes("### G.ii ") && md.includes("### G.iii ") && md.includes("### G.iv "), "Markdown: os 4 universos em subsecções separadas");
  check(JSON.parse(json).universos.erpTotal && JSON.parse(json).universos.sincronizavel && "existenteNoMt" in JSON.parse(json).universos && "coberturaMt" in JSON.parse(json).universos, "JSON: os 4 universos em chaves separadas");

  // ═══ 7. Ficheiro MT: parse ════════════════════════════════════════
  console.log("\n=== 7. Parse do ficheiro MT ===");
  const pm = parseFicheiroMt(["5000001", "5000002;1", "5000003;0;1", "", "# comentário", "abc", "5000004;2", "5000005;1;1;9", "5000002;1", "5000003;1;1", "  5000006 ; 0 ; 0 ", "12345678901234", "00005000007"].join("\r\n"));
  check(pm.unicos === 5 && pm.validas === 7 && pm.invalidas === 4 && pm.duplicadas === 1 && pm.conflitos === 1, "linhas inválidas/duplicadas/conflito contadas", JSON.stringify({ u: pm.unicos, v: pm.validas, i: pm.invalidas, d: pm.duplicadas, c: pm.conflitos }));
  check(pm.entradas.find((e) => e.cnp === "5000001")!.flag === null && pm.entradas.find((e) => e.cnp === "5000002")!.flag === 1 && pm.entradas.find((e) => e.cnp === "5000003")!.manual === 1 && pm.entradas.find((e) => e.cnp === "5000007") !== undefined, "formatos `cnp`, `cnp;flag`, `cnp;flag;manual`, zeros à esquerda normalizados");
  check(pm.entradas.find((e) => e.cnp === "5000003")!.flag === 0, "em conflito fica a primeira ocorrência");
  check(pm.linhasInvalidasExemplo.join(",") === "6,7,8,12" && pm.comFlag === 3 && pm.comManual === 2, "linhas inválidas identificadas por número (nunca o conteúdo)", pm.linhasInvalidasExemplo.join(","));
  check(parseFicheiroMt("﻿123\n456\n").unicos === 2 && parseFicheiroMt("").unicos === 0 && parseFicheiroMt("1\n2\n3\n4", 2).ignoradasPorLimite === 2, "BOM, vazio e limite de linhas");
  check(parseFicheiroMt("1;1\n2;0\n3").comFlag === 2, "ficheiro misto (com e sem flag)");
  const blocos = dividirEmBlocos(Array.from({ length: 2500 }, (_, i) => ({ cnp: String(1000 + i), flag: (i % 2) as 0 | 1, manual: null })));
  check(blocos.length === 4 && blocos.every((b) => b.cnps.length <= TAMANHO_BLOCO_MT) && blocos.reduce((s, b) => s + b.cnps.length, 0) === 2500 && blocos.every((b) => new Set(b.cnps.map((c) => Number(c) % 2)).size === 1), "blocos ≤ 1000 sem misturar grupos (flag)");

  // ═══ 8. Universos com ficheiro MT ════════════════════════════════
  console.log("\n=== 8. Universos com ficheiro MT ===");
  const cnpDe = (r: RowStocks) => String(r.Codigo);
  const eticos = DADOS.filter((r) => r.Etico_NETT === 1);
  const netts = DADOS.filter((r) => r.Etico_NETT === 2);
  const servs = DADOS.filter((r) => r.Etico_NETT === 3);
  const outros = DADOS.filter((r) => r.Etico_NETT === 5);
  const orfaos = DADOS.filter((r) => r.Etico_NETT === 9);
  const nulosS = DADOS.filter((r) => r.Etico_NETT === null);
  // MT: 30 éticos (20 genéricos no ERP + 10 não), 20 NETT, 5 serviços (2 incluídos, 3 excluídos), 2 outros (1 excluído), 1 órfão, 1 NULL, +3 que não existem
  const sel = [...eticos.slice(0, 30), ...netts.slice(0, 20), ...servs.slice(5, 10), ...outros.slice(0, 2), ...orfaos.slice(0, 1), ...nulosS.slice(0, 1)];
  const linhasMt: string[] = [];
  sel.forEach((r, i) => {
    const eGen = Number(r.Generico);
    // MT.flag = ERP.Generico, salvo divergências plantadas: i=0 (Éticos[0], ERP 1) com flag 0 manual=1; i=1 com flag 0 manual=0; i=35 flag 1 sem manual
    let flag = eGen;
    let manual = 0;
    if (i === 0) { flag = 0; manual = 1; }
    if (i === 1) { flag = 0; manual = 0; }
    if (i === 25) { flag = 1; manual = 0; }
    linhasMt.push(`${cnpDe(r)};${flag};${manual}`);
  });
  linhasMt.push("9000001;0;0", "9000002;1;0", "9000003;0;0");
  const parse = parseFicheiroMt(linhasMt.join("\n"));
  const M = await correr(cenarioBase(), { cnpsMt: parse });
  const um = M.rel.universos.existenteNoMt;
  const cv = M.rel.universos.coberturaMt;
  check(um.calculado && um.cnpsNoMt === sel.length + 3 && um.blocos!.completo, `(iii) EXISTENTE NO MT: ${sel.length + 3} CNPs únicos, blocos consultados`, JSON.stringify(um.blocos));
  check(cv.calculado && cv.encontradosNoErp === sel.length && cv.naoEncontradosNoErp === 3 && cv.pctEncontrados === Math.round((sel.length / (sel.length + 3)) * 10000) / 100, `(iv) encontrados ${sel.length}, não encontrados 3`, `${cv.encontradosNoErp}/${cv.naoEncontradosNoErp}`);
  check(cv.naoEncontradosAmostra.sort().join(",") === "9000001,9000002,9000003", "amostra de não encontrados: só CNPs");
  check(cv.porCategoria!.ETICO === 30 && cv.porCategoria!.NETT === 20 && cv.porCategoria!.SERVICO === 5 && cv.porCategoria!.OUTROS === 2 && cv.porCategoria!.UNKNOWN === 1 && cv.porCategoria!.SEM_CLASSIFICACAO === 1, "(iv) por categoria dos encontrados", JSON.stringify(cv.porCategoria));
  check(cv.classificacao!.mapeada === 57 && cv.classificacao!.orfao === 1 && cv.classificacao!.nula === 1 && cv.classificacao!.desconhecida === 0 && cv.classificacao!.pctMapeada === Math.round((57 / 59) * 10000) / 100, "(iv) % classificados com categoria mapeada vs órfão/NULL", JSON.stringify(cv.classificacao));
  const foraDailyEsp = sel.filter((r) => r.Processa_Stocks === 0);
  const foraBootEsp = sel.filter((r) => r.Processa_Stocks === 0 || r.Retirado !== 0);
  check(cv.foraDoFiltro!.daily.total === foraDailyEsp.length && cv.foraDoFiltro!.bootstrapAtivo.total === foraBootEsp.length, `(iv) fora do filtro: daily ${foraDailyEsp.length}, bootstrap ativo ${foraBootEsp.length} (inclui Retirado)`, JSON.stringify([cv.foraDoFiltro!.daily.total, cv.foraDoFiltro!.bootstrapAtivo.total]));
  const servMtExcl = servs.slice(5, 10).filter((r) => r.Processa_Stocks === 0).length;
  check(cv.servicos!.noMt === 5 && cv.servicos!.noMtExcluidosDaily === servMtExcl && cv.servicos!.noMtIncluidosDaily === 5 - servMtExcl && cv.servicos!.erpIncluidosDaily === 3, `(iv) Serviços no MT: 5 (${5 - servMtExcl} incluídos, ${servMtExcl} excluídos); no ERP 3 incluídos`, JSON.stringify(cv.servicos));
  check(cv.foraDoFiltro!.daily.amostra.every((a) => /^\d+$/.test(a.cnp) && (CATEGORIAS as readonly string[]).concat(["SEM_CLASSIFICACAO"]).includes(a.categoria) && Object.keys(a).sort().join() === "categoria,cnp") && cv.foraDoFiltro!.daily.amostra.length > 0, "amostras só com CNP + categoria (nunca nomes)");
  check(cv.servicos!.amostra.length === 5 && cv.servicos!.amostra.every((a) => a.categoria === "SERVICO"), "amostra de Serviços no MT: CNP + SERVICO");
  const g = cv.generico!;
  check(g.disponivel, "matriz Generico calculada");
  check(g.divergentesExplicadasPorManual === 1 && g.divergentesNaoExplicadas === 2 && g.divergentes === 3 && g.concordantes === sel.length - 3, `matriz MT×ERP: ${g.concordantes} concordantes, 3 divergentes (1 explicada por manual, 2 não)`, JSON.stringify({ c: g.concordantes, d: g.divergentes, e: g.divergentesExplicadasPorManual, n: g.divergentesNaoExplicadas }));
  check(/2 divergência\(s\) NÃO explicadas por manual/.test(g.conclusao), "conclusão: divergências por explicar apontadas", g.conclusao);
  check(g.matriz.some((c) => c.mtFlag === 0 && c.erpGenerico === "1" && c.manual === 1 && c.n === 1) && g.matriz.some((c) => c.mtFlag === 1 && c.erpGenerico === "0" && c.manual === 0 && c.n === 1), "células da matriz (MT flag × ERP Generico × manual)");
  check(M.rel.cabecalho.queriesExecutadas > B.rel.cabecalho.queriesExecutadas, "o ficheiro MT acrescenta queries por bloco");
  check(M.md.includes("**Genérico: MT.flagGenerico × ERP.Generico**") && M.md.includes("Leitura:"), "Markdown: matriz MT×ERP");
  check(![...M.erp.executadas].some((s) => /NOME-PRODUTO|PVP/.test(s) && /CAST\(x\./.test(s) && /AS c\d|AS valor/.test(s)), "o universo MT nunca lê nomes nem preços");
  check(!M.json.includes(SEGREDOS.ficheiro) && !M.json.includes(".txt"), "o relatório não guarda o nome do ficheiro MT");

  // só `cnp` (sem flag)
  const MS = await correr(cenarioBase(), { cnpsMt: parseFicheiroMt(sel.map(cnpDe).join("\n")) });
  check(MS.rel.universos.coberturaMt.generico!.disponivel === false && /não traz flagGenerico/.test(MS.rel.universos.coberturaMt.generico!.motivo!), "ficheiro só com CNP: matriz Generico «não calculada» (sem falhar)");
  check(MS.rel.universos.coberturaMt.encontradosNoErp === sel.length, "ficheiro só com CNP: cobertura calculada na mesma");

  // ═══ 9. 25 000+ CNPs em blocos ═══════════════════════════════════
  console.log("\n=== 9. 25 000+ CNPs em blocos de ≤ 1000 ===");
  const N = 27_000;
  const dadosGrande: RowStocks[] = Array.from({ length: N }, (_, i) => ({
    CodigoID: i + 1, Codigo: 2_000_000 + i, Generico: i % 3 === 0 ? 1 : 0, Etico_NETT: (i % 2) + 1, Processa_Stocks: i % 50 === 0 ? 0 : -1, Retirado: 0,
  }));
  const colsG: ColDef[] = [["CodigoID", "int", 4], ["Codigo", "int", 4], ["Generico", "bit", 1], ["Etico_NETT", "int", 4], ["Processa_Stocks", "int", 4], ["Retirado", "bit", 1]];
  const mtLinhas: string[] = [];
  for (let i = 0; i < 25_500; i++) mtLinhas.push(`${2_000_000 + i};${i % 3 === 0 ? 1 : 0};${i % 100 === 0 ? 1 : 0}`);
  for (let i = 0; i < 700; i++) mtLinhas.push(`${8_000_000 + i};0;0`);
  const parseG = parseFicheiroMt(mtLinhas.join("\n"));
  const t0 = Date.now();
  const G = await correr({ stocksCols: colsG, dados: dadosGrande, tabelas: [{ tabela: "Etico_NETT", cols: [["Codigo", "int", 4], ["Descricao", "varchar", 30]], linhas: 5 }], conteudo: { Etico_NETT: LOOKUP }, fks: [{ coluna: "Etico_NETT", tabelaRef: "Etico_NETT", colunaRef: "Codigo" }] }, { cnpsMt: parseG });
  const cvG = G.rel.universos.coberturaMt;
  const qIn = G.erp.executadas.filter((s) => s.includes(" IN ("));
  const tamanhos = qIn.map((s) => (s.match(/ IN \(([^)]*)\)/)![1]!.split(",").length));
  check(parseG.unicos === 26_200 && G.rel.universos.existenteNoMt.cnpsNoMt === 26_200, `${parseG.unicos} CNPs únicos lidos (≥ 25 000)`);
  check(tamanhos.length >= 26 * 2 && tamanhos.every((t) => t <= 1000) && Math.max(...tamanhos) === 1000, `IN-lists numéricas em blocos: ${qIn.length} queries, nenhuma com mais de 1000 itens`);
  check(qIn.every((s) => !/N?'\d+'/.test(s.replace(/N'%[^']*%'/g, "")) && validarQueryAuditoria(s).length === 0), "IN-lists numéricas (Codigo é int): sem aspas, validadas pela guarda");
  check(cvG.encontradosNoErp === 25_500 && cvG.naoEncontradosNoErp === 700 && G.rel.universos.existenteNoMt.blocos!.completo, "25 500 encontrados / 700 não encontrados, todos os blocos consultados", `${cvG.encontradosNoErp}/${cvG.naoEncontradosNoErp}`);
  check(cvG.porCategoria!.ETICO + cvG.porCategoria!.NETT === 25_500, "distribuição por categoria soma os encontrados");
  check(cvG.generico!.disponivel && cvG.generico!.divergentes === 0 && cvG.generico!.concordantes === 25_500, "matriz Generico com 25 500 CNPs: 0 divergências");
  check(cvG.naoEncontradosAmostra.length === 10 && cvG.naoEncontradosAmostra.every((c) => /^8\d{6}$/.test(c)), "amostra de não encontrados limitada a 10");
  check(!G.rel.queries.join("\n").includes("2000123") && G.rel.queries.some((s) => /IN \(<lista de 1000 inteiros>\)/.test(s)), "o anexo de queries não repete os CNPs (só o tamanho da lista)");
  check(Date.now() - t0 < 90_000, `desempenho do teste com 26 200 CNPs: ${Date.now() - t0} ms`);
  // texto na coluna Codigo → IN-list com dígitos entre aspas (também validada)
  const colsTxt = colsG.map((c) => (c[0] === "Codigo" ? (["Codigo", "varchar", 20] as ColDef) : c));
  const T = await correr({ stocksCols: colsTxt, dados: dadosGrande.slice(0, 500), tabelas: [{ tabela: "Etico_NETT", cols: [["Codigo", "int", 4], ["Descricao", "varchar", 30]], linhas: 5 }], conteudo: { Etico_NETT: LOOKUP } }, { cnpsMt: parseFicheiroMt("2000001\n2000002\n2000003") });
  check(T.erp.executadas.some((s) => /IN \('2000001', '2000002', '2000003'\)/.test(s)) && T.rel.universos.coberturaMt.encontradosNoErp === 3, "Codigo textual: IN-list com dígitos entre aspas, igualmente validada");

  // ═══ 10. Validador read-only ═════════════════════════════════════
  console.log("\n=== 10. Validador read-only: IN-lists e proibições ===");
  const base = (extra: string) => `SELECT COUNT(*) AS n\n  FROM [dbo].[Stocks] x WITH (NOLOCK)\n WHERE ${extra}`;
  check(validarQueryAuditoria(base("x.[Codigo] IN (1, 2, 3)")).length === 0, "IN-list numérica aceite");
  check(validarQueryAuditoria(base("x.[Codigo] IN ('1', '22', '333')")).length === 0, "IN-list com inteiros entre aspas aceite");
  check(validarQueryAuditoria(base(`x.[Codigo] IN (${Array.from({ length: 1000 }, (_, i) => i + 1).join(", ")})`)).length === 0, "1000 itens aceites");
  check(validarQueryAuditoria(base(`x.[Codigo] IN (${Array.from({ length: 1001 }, (_, i) => i + 1).join(", ")})`)).some((p) => /1001 itens/.test(p)), "1001 itens recusados");
  const rec = (extra: string) => validarQueryAuditoria(base(extra));
  check(rec("x.[Codigo] IN ('abc')").some((p) => /não numéricos/.test(p)), "IN-list com texto recusada");
  check(rec("x.[Codigo] IN (1, 'a')").length > 0 && rec("x.[Codigo] IN (1.5)").length > 0 && rec("x.[Codigo] IN (-1)").length > 0 && rec("x.[Codigo] IN (1e3)").length > 0, "decimais, negativos e notação científica recusados");
  check(rec("x.[Codigo] IN ('1'); DROP TABLE x").length > 0, "injeção «'1'); DROP» recusada");
  check(rec("x.[Codigo] IN (1) OR 1=1; DELETE FROM [dbo].[Stocks]").some((p) => /DELETE|';'|statement/.test(p)), "DELETE encadeado recusado");
  check(rec("x.[Codigo] IN (SELECT 1)").length > 0 && rec("x.[Codigo] IN (@p)").length > 0 && rec("x.[Codigo] IN (1, (2))").length > 0 && rec("x.[Codigo] IN ()").length > 0, "subconsulta, variável, parêntesis aninhado e lista vazia recusados");
  check(rec("x.[Codigo] IN ('1'' OR ''1''=''1')").length > 0, "aspas escapadas a esconder texto recusadas");
  check(rec("x.[Codigo] IN (1) -- comentário").length > 0 && rec("x.[Codigo] IN (1) /* c */").length > 0, "comentários recusados");
  check(rec("x.[Codigo] NOT IN (1, 2)").length === 0 && validarInLists("SELECT 1 AS a FROM [dbo].[T] x WHERE x.[IN (x)] = 1").length === 0, "NOT IN numérico aceite; «IN (» dentro de identificador [..] ignorado");
  check(validarQueryAuditoria("SELECT t.n AS n\n  FROM (SELECT 1 AS n FROM [dbo].[Stocks] x WITH (NOLOCK)) t").length === 0, "tabela derivada (para o histórico) aceite");
  const mal = PALAVRAS_PROIBIDAS.filter((w) => validarSomenteSelect(`SELECT 1 AS a FROM [dbo].[X] x WHERE x.[c] IN (1, 2) ${w} 1`).length === 0);
  check(mal.length === 0, `TODAS as ${PALAVRAS_PROIBIDAS.length} palavras proibidas continuam recusadas com IN-list`, mal.join(","));
  const mal2 = PALAVRAS_PROIBIDAS.filter((w) => validarSomenteSelect(`SELECT 1 AS a FROM [dbo].[X] x WHERE x.[c] IN (1)\n${w.toLowerCase()}\n`).length === 0);
  check(mal2.length === 0, "…também em minúsculas e com quebras de linha", mal2.join(","));
  check(validarSomenteSelect("INSERT INTO [dbo].[X] VALUES (1)").length > 0 && validarSomenteSelect("WITH c AS (SELECT 1) SELECT * FROM c").length > 0 && validarSomenteSelect("SELECT dbo.fn_x(1) AS a FROM [dbo].[X] x").length > 0 && validarSomenteSelect("SELECT 1 AS a; SELECT 2 AS b").length > 0 && validarSomenteSelect("SELECT 1 AS a FROM [dbo].[X] x WHERE xp_cmdshell(1)").length > 0, "INSERT, WITH, função desconhecida, ';' e xp_ continuam recusados");
  check(listaIn(["1", "2"], true) === "1, 2" && listaIn(["1", "2"], false) === "'1', '2'", "listaIn: numérica e textual de dígitos");
  let lancou = 0;
  for (const mauCnp of ["1 OR 1=1", "'1'", "12a", "", "1;2", "9999999999999"]) { try { listaIn([mauCnp], true); } catch { lancou++; } }
  try { listaIn([], true); } catch { lancou++; }
  try { listaIn(Array.from({ length: 1001 }, (_, i) => String(i)), true); } catch { lancou++; }
  check(lancou === 8, "listaIn recusa texto, injeção, vazio e > 1000 (defesa em profundidade antes do validador)");
  const colsU: ColunasUniverso = { cnp: "Codigo", cnpNumerico: true, etico: "Etico_NETT", generico: "Generico", processa: "Processa_Stocks", retirado: "Retirado" };
  check(validarQueryAuditoria(sqlDimensoes(colsU)).length === 0 && validarQueryAuditoria(sqlDimensoes(colsU, ["1", "2"])).length === 0 && validarQueryAuditoria(sqlDimensoes({ ...colsU, etico: null, generico: null, processa: null, retirado: null })).length === 0, "sqlDimensoes (com e sem colunas/IN-list) é SELECT validado");
  check(M.erp.executadas.concat(G.erp.executadas.slice(0, 300)).every((s) => /^SELECT\b/.test(s) && validarQueryAuditoria(s).length === 0), "todas as queries do v2 (incl. blocos MT) começam por SELECT e passam a guarda");
  check(mascararQuery("SELECT 1 AS a FROM [dbo].[X] x WHERE x.[c] IN (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12)").includes("<lista de 12 inteiros>") && mascararQuery("WHERE p.index_id IN (0, 1)").includes("IN (0, 1)"), "mascararQuery: listas longas de inteiros mascaradas; constantes curtas mantidas");

  // ═══ 11. Impressão do ambiente ══════════════════════════════════
  console.log("\n=== 11. Impressão comparável entre farmácias ===");
  const imp = rel.cabecalho.impressao;
  const esperadoLookup = sha(`lookup\n${["1=eticos", "2=nett", "3=servicos", "4=sacos l", "5=outros"].sort().join("\n")}`);
  check(imp.lookup === esperadoLookup && imp.nLinhasLookup === 5 && imp.nColunasStocks === 56, "impressão do lookup = SHA-256 do conteúdo normalizado (código=descrição normalizada)");
  check(/^([0-9a-f]{8}-){7}[0-9a-f]{8}$/.test(imp.combinada) && imp.curta === (imp.combinada.replace(/-/g, "").slice(0, 12).match(/.{4}/g) ?? []).join("-") && md.includes(imp.curta), "impressão combinada (SHA-256 em grupos de 8) e forma curta no cabeçalho do Markdown");
  check(!imp.lookup.includes("[omitido]") && !imp.combinada.includes("[omitido]") && JSON.parse(json).cabecalho.impressao.combinada === imp.combinada, "o sanitizador não mutila os hashes (grupos de 8, nunca 9 dígitos seguidos)");
  const B2 = await correr(cenarioBase());
  check(B2.rel.cabecalho.impressao.combinada === imp.combinada, "determinística: a mesma farmácia dá a mesma impressão");
  const diffLookup = await correr({ ...cenarioBase(), conteudo: { ...CONTEUDO_BASE(), Etico_NETT: LOOKUP.map((l) => (l.Codigo === 5 ? { ...l, Descricao: "Outros produtos" } : l)) } });
  check(diffLookup.rel.cabecalho.impressao.lookup !== imp.lookup && diffLookup.rel.cabecalho.impressao.colunasStocks === imp.colunasStocks, "lookup diferente → impressão do lookup diferente (colunas iguais)");
  const diffCols = await correr({ ...cenarioBase(), stocksCols: [...colsStocks56(), ["NovaColuna", "int", 4]] });
  check(diffCols.rel.cabecalho.impressao.colunasStocks !== imp.colunasStocks && diffCols.rel.cabecalho.impressao.lookup === imp.lookup, "coluna a mais em Stocks → impressão das colunas diferente");
  const regra = calcularImpressao(B.rel.mapeamentoEticoNett, ["B", "a"]).colunasStocks === calcularImpressao(B.rel.mapeamentoEticoNett, ["A", "b"]).colunasStocks;
  check(regra, "impressão das colunas insensível a maiúsculas e ordem");
  const eqLookupAcentos = calcularImpressao(construirMapeamento([{ codigo: "1", descricao: "ÉTICOS" }], []), []).lookup === calcularImpressao(construirMapeamento([{ codigo: "1", descricao: " eticos. " }], []), []).lookup;
  check(eqLookupAcentos, "impressão do lookup usa a descrição NORMALIZADA (acentos/pontuação/maiúsculas irrelevantes)");
  check(calcularImpressao(null, ["a"]).nLinhasLookup === null && calcularImpressao(null, ["a"]).lookup === sha("lookup\nsem-lookup"), "sem lookup: impressão «sem-lookup»");
  check(rel.cabecalho.baseDados === "SPharmSilveirense" && rel.cabecalho.schemaRelatorio === 2, "cabeçalho: nome da base e schemaRelatorio=2");

  // ═══ 12. Segredos, PII e identificação do tenant ═════════════════
  console.log("\n=== 12. Sem segredos, PII nem tenant ===");
  const tudo = [json, md, M.json, M.md, G.json];
  check(tudo.every((t) => !t.includes(SEGREDOS.senha) && !t.includes(SEGREDOS.utilizador) && !t.includes(SEGREDOS.host)), "palavra-passe, utilizador e anfitrião ausentes de todos os relatórios (JSON e Markdown)");
  check(tudo.every((t) => !t.includes(SEGREDOS.tenant)), "sentinela do tenant ausente");
  check(tudo.every((t) => !/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(t)), "nenhum e-mail");
  check(tudo.every((t) => !/\d{9,}/.test(t)), "nenhuma sequência de ≥ 9 dígitos");
  const comTenant = await correr({ ...cenarioBase(), versaoTexto: `Microsoft SQL Server 2022 (RTM) - 16.0.1000.6 (X64) srv=${SEGREDOS.tenant}` });
  check(!comTenant.json.includes(SEGREDOS.tenant) && !comTenant.md.includes(SEGREDOS.tenant), "segredo/tenant que apareça na versão do SQL é redigido");
  check(!/rev99/i.test(json + md), "o relatório nunca diz rev99");

  // ═══ 13. compararGenerico (puro) ═══════════════════════════════
  console.log("\n=== 13. compararGenerico: casos-limite ===");
  const L = (flag: 0 | 1 | null, gen: string | null, manual: 0 | 1 | null, n: number): DimRowMt => ({ cat: "1", gen, ps: "dif", ret: "zero", n, flag, manual });
  const c1 = compararGenerico([L(0, "0", 0, 10), L(1, "1", 0, 5), L(0, null, 0, 3)], true, true);
  check(c1.disponivel && c1.divergentes === 0 && c1.concordantes === 18 && c1.erpNuloMtZero === 3 && /sem divergências/.test(c1.conclusao), "NULL no ERP conta como 0: concordante com MT 0 (e fica contado em erpNuloMtZero)");
  const c2 = compararGenerico([L(1, null, 0, 2), L(1, "0", 1, 4)], true, true);
  check(c2.divergentes === 6 && c2.divergentesNaoExplicadas === 2 && c2.divergentesExplicadasPorManual === 4, "MT 1 com ERP NULL/0: divergências, 4 explicadas por manual e 2 não");
  const c3 = compararGenerico([L(0, "1", null, 7)], true, true);
  check(c3.divergentesSemManual === 7 && c3.divergentesNaoExplicadas === 0 && /sem a coluna manual/.test(c3.conclusao), "ficheiro sem coluna manual: divergências «sem informação manual» (não se afirma que são explicadas)");
  check(!compararGenerico([], false, true).disponivel && !compararGenerico([L(null, "1", null, 1)], true, false).disponivel, "sem coluna Generico ou sem flag no ficheiro: não calculado");
  const c4 = compararGenerico([L(null, "1", null, 3), L(1, "1", 1, 2)], true, true);
  check(c4.concordantes === 2 && c4.matriz.length === 1, "linhas sem flag (formato misto) ficam fora da matriz");

  console.log(`\n${pass} ok, ${fail} falhas`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
